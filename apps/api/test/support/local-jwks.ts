import { createServer, type Server } from 'node:http'
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload, type KeyLike } from 'jose'

export interface LocalJwks {
  issuer: string
  signToken: (claims: JWTPayload, options?: { omitExpiry?: boolean }) => Promise<string>
  stop: () => Promise<void>
}

const KID = 'test-key-1'

/**
 * A real RS256 key pair served over a real local HTTP JWKS endpoint —
 * standing in for Keycloak so JwtGuard's own claim handling can be exercised
 * with token shapes Keycloak itself would never actually issue (e.g.
 * missing `sub`/`preferred_username`). The guard under test still performs
 * real signature, issuer, and audience verification against this server via
 * its normal `createRemoteJWKSet` path; only the token issuer is fake, not
 * the verification.
 */
export async function startLocalJwks(): Promise<LocalJwks> {
  const { publicKey, privateKey } = await generateKeyPair('RS256')
  const jwk = await exportJWK(publicKey)

  const server: Server = createServer((req, res) => {
    if (req.url === '/protocol/openid-connect/certs') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ keys: [{ ...jwk, kid: KID, use: 'sig', alg: 'RS256' }] }))
      return
    }
    res.writeHead(404)
    res.end()
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('local JWKS server failed to bind to a port')
  }

  const issuer = `http://127.0.0.1:${address.port}`

  return {
    issuer,

    /**
     * `omitExpiry` exists for one test: JwtGuard passes
     * `requiredClaims: ['exp']` to `jwtVerify`, and jose only enforces `exp`
     * when the claim is PRESENT — so proving a token without one is rejected
     * needs a token this helper would otherwise always give an `exp`
     * (finding SEC-L4). Default is unchanged for every other caller.
     */
    async signToken(claims: JWTPayload, options?: { omitExpiry?: boolean }): Promise<string> {
      const base = new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: KID })
        .setIssuedAt()
        .setIssuer(issuer)
      const signer = options?.omitExpiry === true ? base : base.setExpirationTime('5m')
      return signer.sign(privateKey as KeyLike)
    },

    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      }),
  }
}
