/**
 * Name → slug, matching the server's
 * `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$` (the `organizations_slug_format`
 * CHECK, and the same pattern `createOrganizationBodySchema` enforces).
 *
 * A SUGGESTION ONLY — the field stays editable and the server validates
 * regardless. Deriving it saves the common case without hiding the value,
 * which matters here more than it would for an ordinary slug: this one
 * becomes a permanent Keycloak REALM NAME, it appears in the issuer URL
 * every person in the tenant authenticates against, and there is no rename.
 * An admin who wants `acme` rather than `acme-corporation-ltd` must be able
 * to see and change it before it is fixed forever.
 *
 * The trailing-hyphen strip runs TWICE, and both are load-bearing: the first
 * removes hyphens the collapse pass left at either end, the second removes
 * one that the 63-character truncation itself may have exposed (e.g. a name
 * whose 64th character is where a word boundary fell). Without the second, a
 * long name could produce a slug ending in `-`, which the server's pattern
 * rejects — turning a helpful suggestion into a 400 the admin did not cause.
 */
export function slugFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/, '')
}
