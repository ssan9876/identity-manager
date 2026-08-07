/**
 * Milestone 11, Task 5 — pure helpers for Active Directory's `objectGUID`
 * (the immutable correlation key — see `ActiveDirectoryConnector`'s own doc
 * comment for why DN/sAMAccountName/mail are all explicitly disqualified)
 * and for safely embedding a dynamic value into an LDAP DN. No I/O, no
 * `ldapts` dependency — unit-tested standalone (test/ad-guid.spec.ts), the
 * same "pure logic gets its own small module" convention
 * `connectors/attribute-mapping.ts` already established.
 */

/**
 * RFC 4514 §2.4 minimal DN-value escaping: a leading space or `#`, a
 * trailing space, and `"+,;<>\` anywhere are escaped with a backslash; a NUL
 * byte is escaped as `\00`. Applied to every dynamic value this connector
 * ever places inside a DN component (a username, an org-unit label) —
 * defence in depth even though org-unit labels are already `[a-z0-9_]+`-only
 * by construction (`OrgUnitsRepository.toLabel`) and usernames are not
 * currently format-restricted at the schema layer.
 */
export function escapeDnValue(value: string): string {
  let result = ''
  for (let i = 0; i < value.length; i++) {
    const ch = value[i] as string
    if (ch === '\0') {
      result += '\\00'
      continue
    }
    if (ch === '"' || ch === '+' || ch === ',' || ch === ';' || ch === '<' || ch === '>' || ch === '\\') {
      result += `\\${ch}`
      continue
    }
    if ((ch === ' ' && (i === 0 || i === value.length - 1)) || (ch === '#' && i === 0)) {
      result += `\\${ch}`
      continue
    }
    result += ch
  }
  return result
}

/**
 * RFC 4515 §3 filter-value escaping: `*`, `(`, `)`, `\` and NUL are escaped
 * as `\XX` (the character's own single-byte ASCII code, hex). Every OTHER
 * character — including non-ASCII text — passes through unescaped; LDAP
 * filters are UTF-8 on the wire like any other string value, so hex-escaping
 * would corrupt a multi-byte character rather than protect it. Used
 * anywhere a dynamic value (a username) is spliced into a filter string,
 * e.g. `(sAMAccountName=${escapeFilterValue(username)})`.
 */
export function escapeFilterValue(value: string): string {
  let result = ''
  for (let i = 0; i < value.length; i++) {
    const ch = value[i] as string
    if (ch === '\0') {
      result += '\\00'
      continue
    }
    if (ch === '*' || ch === '(' || ch === ')' || ch === '\\') {
      result += `\\${ch.charCodeAt(0).toString(16).padStart(2, '0')}`
      continue
    }
    result += ch
  }
  return result
}

/**
 * Raw bytes -> the `\xx\xx...` hex-escaped form an LDAP filter needs for a
 * binary attribute value (RFC 4515 §3) — e.g.
 * `(objectGUID=\aa\bb\cc\dd...)`. Operates on the RAW byte order exactly as
 * stored/transmitted by AD; filter matching is a byte-for-byte comparison,
 * so — unlike `guidBufferToString` below — there is no display-format
 * reinterpretation here.
 *
 * CAVEAT, confirmed empirically against `ldapts` 7.4.0 (reproduced against
 * the real Samba AD container before this comment was written — see
 * ActiveDirectoryConnector's own `objectGuidFilter` doc comment): do NOT
 * feed this function's output into a PLAIN STRING filter
 * (`client.search({ filter: "(objectGUID=" + hex + ")" })`) for a binary
 * attribute like `objectGUID`. `ldapts`'s own string-filter PARSER correctly
 * unescapes `\xx` into a JS string of raw byte values, but
 * `EqualityFilter.writeFilter` only special-cases an ACTUAL `Buffer`-typed
 * `value` — a STRING value (even one holding byte-range char codes) is
 * written via `writer.writeString`, which UTF-8-ENCODES it, silently
 * corrupting any byte `>= 0x80` (a 16-byte GUID is virtually guaranteed to
 * contain one). Reproduced directly: a search for a just-created entry's own
 * `objectGUID`, built this way, returned ZERO results every time, while the
 * IDENTICAL bytes passed as a real `Buffer` via `new EqualityFilter({
 * attribute: 'objectGUID', value: <Buffer> })` found it every time. This
 * function remains correct for the RFC 4515 wire-format escaping itself
 * (unit-tested for exactly that) and is still useful for
 * logging/debugging a filter value — just never as `ldapts` SEARCH input
 * for a binary attribute; `ActiveDirectoryConnector` never uses it for that.
 */
export function guidBufferToFilterHex(buf: Uint8Array): string {
  return Array.from(buf, (byte) => `\\${byte.toString(16).padStart(2, '0')}`).join('')
}

const GUID_STRING_PATTERN =
  /^([0-9a-fA-F]{8})-([0-9a-fA-F]{4})-([0-9a-fA-F]{4})-([0-9a-fA-F]{4})-([0-9a-fA-F]{12})$/

function hexPairsToBytes(hex: string): number[] {
  const bytes: number[] = []
  for (let i = 0; i < hex.length; i += 2) {
    bytes.push(Number.parseInt(hex.slice(i, i + 2), 16))
  }
  return bytes
}

/**
 * The raw 16-byte `objectGUID` AD hands back from a search -> the standard
 * dashed GUID string form every AD-facing tool displays (ADUC, PowerShell's
 * `Get-ADUser`, `samba-tool`, .NET's `Guid`, Python's `ldap3`...). This is
 * NOT a plain hex dump: Microsoft's `GUID`/`UUID` struct stores its first
 * three fields (`Data1` a 4-byte int, `Data2`/`Data3` 2-byte ints) in
 * LITTLE-ENDIAN byte order (native x86 struct layout, carried unchanged onto
 * the wire), while the last field (`Data4`, an 8-byte array) has no
 * endianness — it is already just bytes. Getting this backwards would not
 * break OUR OWN round-tripping (this module's own inverse function would
 * still agree with itself), but it WOULD mean the value this system stores
 * in `external_identities.external_id` looks nothing like what an admin
 * sees when they inspect the same object directly in AD — chosen to match
 * the real, external convention deliberately, not left as an internal-only
 * accident.
 *
 * The chosen `externalId` STRING representation for this connector — what
 * `apply()` returns, `disable()`/`DesiredUser.existingExternalId` receive,
 * and what ends up in `external_identities.external_id`.
 */
export function guidBufferToString(buf: Uint8Array): string {
  if (buf.length !== 16) {
    throw new Error(`objectGUID must be exactly 16 bytes, got ${buf.length}`)
  }
  const hex = (i: number): string => (buf[i] as number).toString(16).padStart(2, '0')
  const data1 = [3, 2, 1, 0].map(hex).join('')
  const data2 = [5, 4].map(hex).join('')
  const data3 = [7, 6].map(hex).join('')
  const data4a = [8, 9].map(hex).join('')
  const data4b = [10, 11, 12, 13, 14, 15].map(hex).join('')
  return `${data1}-${data2}-${data3}-${data4a}-${data4b}`
}

/** Inverse of `guidBufferToString` — the dashed string this connector stored/returned -> the raw 16 bytes needed to build an `(objectGUID=...)` filter (via `guidBufferToFilterHex`) for re-finding the same AD object. */
export function guidStringToBuffer(guid: string): Buffer {
  const match = GUID_STRING_PATTERN.exec(guid)
  if (match === null) {
    throw new Error(`"${guid}" is not a valid objectGUID string (expected dashed hex, e.g. 8-4-4-4-12)`)
  }
  const [, data1, data2, data3, data4a, data4b] = match as unknown as [string, string, string, string, string, string]
  const d1 = hexPairsToBytes(data1).reverse()
  const d2 = hexPairsToBytes(data2).reverse()
  const d3 = hexPairsToBytes(data3).reverse()
  const d4a = hexPairsToBytes(data4a)
  const d4b = hexPairsToBytes(data4b)
  return Buffer.from([...d1, ...d2, ...d3, ...d4a, ...d4b])
}

/** `guidBufferToFilterHex(guidStringToBuffer(guid))` in one call — the common case: "I have a stored `externalId`, I need an LDAP filter to re-find it." */
export function guidStringToFilterHex(guid: string): string {
  return guidBufferToFilterHex(guidStringToBuffer(guid))
}
