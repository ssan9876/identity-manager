import { Client } from 'ldapts'
import { GenericContainer, type StartedTestContainer } from 'testcontainers'

/**
 * Real Samba Active Directory domain controller — Milestone 11, Task 5's
 * binding requirement ("a real Samba AD domain controller container. Real
 * LDAP, real schema, real bind. No mocking"). `nowsci/samba-domain`
 * (https://nowsci.com/samba-domain/) self-provisions a brand-new AD forest
 * on first boot via the real `samba-tool domain provision`, using ordinary
 * bridge networking (no `network_mode: host` — confirmed against the
 * image's own documented `docker run -p host:port:port ...` examples,
 * important because Testcontainers' port publishing/`getMappedPort` model
 * depends on bridge networking; `network_mode: host` containers have no
 * publishable ports for Testcontainers to discover at all).
 *
 * TWO THINGS THIS MODULE DOES THAT ARE EASY TO GET WRONG:
 *
 * 1. CAPABILITIES. A fresh, unprivileged container's `samba-tool domain
 *    provision` fails part-way through with `NT_STATUS_ACCESS_DENIED`
 *    setting the sysvol/netlogon NT ACLs (`set_nt_acl_no_snum`) — verified
 *    empirically against this exact image before writing this file. Samba
 *    stores those ACLs as filesystem extended attributes, which needs
 *    `CAP_SYS_ADMIN`; `CAP_DAC_READ_SEARCH` avoids a second, narrower
 *    permission failure reading them back. Neither is Docker's full
 *    `--privileged` (which also disables seccomp/AppArmor confinement and
 *    grants device access this container needs none of) — two named
 *    capabilities, nothing more.
 *
 * 2. TLS. `samba-tool domain provision` auto-generates a self-signed LDAPS
 *    certificate — but it has NO Subject Alternative Name (confirmed via
 *    `openssl x509 -noout -text` against a running container), and modern
 *    Node.js (>=17) ignores the legacy CN-fallback and REJECTS any
 *    certificate with no SAN outright, regardless of `ca`/`servername`.
 *    Rather than relax verification for this reason (forbidden by this
 *    task's own contract: "certificate verification on by default... never
 *    a silent fallback"), this module mints a PROPER CA + leaf certificate
 *    (SAN = `DNS:localhost, IP:127.0.0.1` — where Testcontainers actually
 *    publishes the port) using the container's OWN `openssl` (already
 *    present in the image) via `container.exec`, installs it over the
 *    auto-generated one at the exact path `smb.conf`'s default `tls
 *    keyfile/certfile/cafile` already point to
 *    (`/var/lib/samba/private/tls/{key,cert,ca}.pem`), and restarts just the
 *    `samba` supervisor program (`supervisorctl restart samba` — cheap;
 *    provisioning itself runs exactly once, at first boot, and is
 *    untouched by this). The result: `ActiveDirectoryConnector`'s DEFAULT,
 *    unmodified certificate verification (`ca` + `rejectUnauthorized: true`,
 *    no override) genuinely passes against this container — proving the
 *    real code path, not a relaxed stand-in for it.
 *
 * READINESS is a real authenticated LDAPS bind + search against the domain
 * root, retried with backoff, NOT "the port accepted a TCP connection" —
 * this task's own explicit instruction. `waitForAuthenticatedSearch` below
 * is called twice: once right after `samba-tool domain provision` (using
 * the auto-generated, not-yet-trusted cert, `rejectUnauthorized: false` —
 * this ONE relaxation is internal test-harness bootstrapping to confirm the
 * domain itself is alive before we touch its certificate, never the
 * connector's own behaviour or default) to confirm the domain answers
 * authenticated searches at all, and again after the cert swap, this time
 * with FULL verification (the connector's own real posture) to confirm
 * LDAPS is genuinely trustworthy end to end before any test starts.
 */

export interface TestSambaAd {
  /** `ldaps://127.0.0.1:<mapped port>` — Testcontainers-published, changes every run. */
  url: string
  /** e.g. `DC=test,DC=idm,DC=local`. */
  baseDN: string
  /** The domain's built-in administrator, e.g. `CN=Administrator,CN=Users,DC=test,DC=idm,DC=local`. */
  adminDN: string
  adminPassword: string
  /** e.g. `test.idm.local` — the lowercase DNS domain, for building expected `userPrincipalName` values in tests. */
  dnsDomain: string
  /** PEM text of the CA this container's LDAPS certificate is actually signed by — feed this to `ActiveDirectoryConnector`'s `config.caCertificate` for full, unmodified certificate verification. */
  caCertificatePem: string
  /** The name the leaf certificate is issued for (`localhost`) — feed this to `config.tlsServerName` so Node validates the cert's identity correctly despite connecting via `127.0.0.1`. Not a relaxation: full chain AND hostname verification both still run: see this module's own doc comment. */
  tlsServerName: string
  /**
   * Fault injection for the "a connection failure mid-batch leaves no
   * partially-applied user" proof — stops the REAL `samba` process inside
   * the container (`supervisorctl stop samba`), so an in-flight or
   * subsequent LDAP operation genuinely fails the way a network blip or a
   * restarting DC would, not a simulated/mocked error.
   */
  interruptLdap: () => Promise<void>
  /** Restarts `samba` (`supervisorctl start samba`) and waits for a real authenticated LDAPS search to succeed again before resolving — so a test calling this can immediately trust the service is back. */
  restoreLdap: () => Promise<void>
  stop: () => Promise<void>
}

const DOMAIN = 'TEST.IDM.LOCAL'
const DOMAIN_PASSWORD = 'TestAdmin_Passw0rd!23'
const BASE_DN = 'DC=test,DC=idm,DC=local'
const ADMIN_DN = `CN=Administrator,CN=Users,${BASE_DN}`
const DNS_DOMAIN = 'test.idm.local'
const TLS_SERVER_NAME = 'localhost'

const PROVISION_READY_TIMEOUT_MS = 300_000
const RESTART_READY_TIMEOUT_MS = 60_000
const POLL_INTERVAL_MS = 1_000

// The container's own `openssl` (already present — the base image ships
// Samba's own TLS tooling) mints a proper CA + SAN leaf cert and installs it
// over the auto-generated, SAN-less one `samba-tool domain provision`
// creates at first boot, then restarts just the `samba` supervisor program
// so the LDAP service picks the new files up. `set -e`: any failure here
// must surface as a non-zero exit code, not be silently swallowed.
const INSTALL_TRUSTED_CERT_SCRIPT = `
set -e
TLS_DIR=/var/lib/samba/private/tls
WORK=/tmp/ad-test-certgen
mkdir -p "$WORK"
cd "$WORK"

openssl genrsa -out ca.key 4096 >/dev/null 2>&1
openssl req -x509 -new -nodes -key ca.key -sha256 -days 3650 \\
  -out ca.pem -subj "/O=identity-manager-test/CN=identity-manager-test-ca"

openssl genrsa -out server.key 2048 >/dev/null 2>&1
cat > san.cnf <<'CNF'
[req]
distinguished_name = req_distinguished_name
req_extensions = v3_req
prompt = no
[req_distinguished_name]
CN = localhost
[v3_req]
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names
[alt_names]
DNS.1 = localhost
IP.1 = 127.0.0.1
CNF
openssl req -new -key server.key -out server.csr -config san.cnf
openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial \\
  -out server.pem -days 825 -sha256 -extensions v3_req -extfile san.cnf

cp ca.pem "$TLS_DIR/ca.pem"
cp server.pem "$TLS_DIR/cert.pem"
cp server.key "$TLS_DIR/key.pem"
chmod 0600 "$TLS_DIR/key.pem"

supervisorctl restart samba
cat "$TLS_DIR/ca.pem"
`

/**
 * Authenticated-search readiness (this task's own explicit requirement —
 * not "the port is open"). Retries a full bind + search against `baseDN`
 * until it succeeds or `timeoutMs` elapses, backing off `POLL_INTERVAL_MS`
 * between attempts; throws with the LAST underlying error on timeout so a
 * genuine failure is diagnosable rather than a bare "timed out."
 */
async function waitForAuthenticatedSearch(options: {
  url: string
  adminDN: string
  adminPassword: string
  baseDN: string
  tlsOptions: { ca?: string; servername?: string; rejectUnauthorized?: boolean }
  timeoutMs: number
}): Promise<void> {
  const deadline = Date.now() + options.timeoutMs
  let lastError: unknown = new Error('waitForAuthenticatedSearch: never attempted')

  while (Date.now() < deadline) {
    const client = new Client({
      url: options.url,
      connectTimeout: 5_000,
      timeout: 10_000,
      tlsOptions: options.tlsOptions,
    })
    try {
      await client.bind(options.adminDN, options.adminPassword)
      await client.search(options.baseDN, { scope: 'base', filter: '(objectClass=*)', attributes: ['dc'] })
      await client.unbind()
      return
    } catch (error) {
      lastError = error
      try {
        await client.unbind()
      } catch {
        /* the bind/search above is what failed; nothing to clean up */
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError)
  throw new Error(
    `waitForAuthenticatedSearch: no authenticated search against ${options.url} succeeded within ${options.timeoutMs}ms — last error: ${message}`,
  )
}

/**
 * Starts a fresh Samba AD domain controller, installs a properly-verifiable
 * LDAPS certificate, and confirms readiness via a real authenticated search
 * — see this module's own doc comment for why each of those three steps
 * exists and what specifically was verified empirically before writing it.
 */
export async function startSambaAd(): Promise<TestSambaAd> {
  const container: StartedTestContainer = await new GenericContainer('nowsci/samba-domain')
    .withEnvironment({
      DOMAIN,
      DOMAINPASS: DOMAIN_PASSWORD,
      NOCOMPLEXITY: 'false',
      INSECURELDAP: 'false',
    })
    .withAddedCapabilities('SYS_ADMIN', 'DAC_READ_SEARCH')
    .withExposedPorts(389, 636)
    .start()

  const host = container.getHost()
  const port = container.getMappedPort(636)
  const url = `ldaps://${host}:${port}`

  try {
    // Phase 1: the domain itself is alive and answering authenticated
    // searches — using the auto-generated, not-yet-trusted cert
    // (`rejectUnauthorized: false` is internal bootstrapping ONLY, see this
    // module's own doc comment; never the connector's default).
    await waitForAuthenticatedSearch({
      url,
      adminDN: ADMIN_DN,
      adminPassword: DOMAIN_PASSWORD,
      baseDN: BASE_DN,
      tlsOptions: { rejectUnauthorized: false },
      timeoutMs: PROVISION_READY_TIMEOUT_MS,
    })

    // Phase 2: install a properly SAN-bearing, CA-verifiable certificate.
    const execResult = await container.exec(['sh', '-c', INSTALL_TRUSTED_CERT_SCRIPT])
    if (execResult.exitCode !== 0) {
      throw new Error(
        `installing a trusted LDAPS certificate failed (exit ${execResult.exitCode}): ${execResult.output}`,
      )
    }
    const caCertificatePem = extractPem(execResult.stdout)

    // Phase 3: readiness AGAIN, this time with FULL verification (chain +
    // hostname via `servername`) — the connector's own real, unmodified
    // default posture, confirmed working end to end before any test runs.
    await waitForAuthenticatedSearch({
      url,
      adminDN: ADMIN_DN,
      adminPassword: DOMAIN_PASSWORD,
      baseDN: BASE_DN,
      tlsOptions: { ca: caCertificatePem, servername: TLS_SERVER_NAME },
      timeoutMs: RESTART_READY_TIMEOUT_MS,
    })

    return {
      url,
      baseDN: BASE_DN,
      adminDN: ADMIN_DN,
      adminPassword: DOMAIN_PASSWORD,
      dnsDomain: DNS_DOMAIN,
      caCertificatePem,
      tlsServerName: TLS_SERVER_NAME,

      async interruptLdap(): Promise<void> {
        const result = await container.exec(['supervisorctl', 'stop', 'samba'])
        if (result.exitCode !== 0) {
          throw new Error(`interruptLdap: 'supervisorctl stop samba' failed: ${result.output}`)
        }
      },

      async restoreLdap(): Promise<void> {
        const result = await container.exec(['supervisorctl', 'start', 'samba'])
        if (result.exitCode !== 0) {
          throw new Error(`restoreLdap: 'supervisorctl start samba' failed: ${result.output}`)
        }
        await waitForAuthenticatedSearch({
          url,
          adminDN: ADMIN_DN,
          adminPassword: DOMAIN_PASSWORD,
          baseDN: BASE_DN,
          tlsOptions: { ca: caCertificatePem, servername: TLS_SERVER_NAME },
          timeoutMs: RESTART_READY_TIMEOUT_MS,
        })
      },

      async stop(): Promise<void> {
        await container.stop()
      },
    }
  } catch (error) {
    // Never leak a half-ready container if setup itself failed — nothing
    // left running for a later test file, or a later run, to trip over.
    await container.stop()
    throw error
  }
}

/** The cert-install script's last stdout line-block is the PEM (see `INSTALL_TRUSTED_CERT_SCRIPT`'s trailing `cat`); this pulls just the `-----BEGIN CERTIFICATE----- ... -----END CERTIFICATE-----` block out of whatever else `exec` captured. */
function extractPem(output: string): string {
  const match = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(output)
  if (match === null) {
    throw new Error(`extractPem: no PEM certificate block found in exec output: ${output}`)
  }
  return match[0]
}
