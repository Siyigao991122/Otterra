/**
 * Signs/verifies the site-access cookie with HMAC-SHA256 via Web Crypto, so
 * middleware (Edge runtime) can verify a session without a DB round trip per
 * request. Only the initial redemption (POST /api/access) touches Supabase.
 *
 * Trade-off: revoking or exhausting a code in the DB stops NEW logins but
 * does not invalidate a cookie already issued — there's no per-request
 * revocation check. Acceptable for a small closed beta; documented so it's
 * not mistaken for instant revocation.
 */

const TOKEN_MAX_AGE_SECONDS = 60 * 60 * 24 * 30 // 30 days

export interface AccessTokenPayload {
  /** "owner" for the master code, or the invite_codes.id that was redeemed. */
  sub: string
  /** Issued-at, unix seconds. */
  iat: number
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ""
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function base64UrlDecode(input: string): Uint8Array {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(input.length / 4) * 4, "=")
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  )
}

export async function signAccessToken(sub: string, secret: string): Promise<string> {
  const payload: AccessTokenPayload = { sub, iat: Math.floor(Date.now() / 1000) }
  const payloadB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)))
  const key = await hmacKey(secret)
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadB64))
  const sigB64 = base64UrlEncode(new Uint8Array(sig))
  return `${payloadB64}.${sigB64}`
}

export async function verifyAccessToken(token: string, secret: string): Promise<AccessTokenPayload | null> {
  const parts = token.split(".")
  if (parts.length !== 2) return null
  const [payloadB64, sigB64] = parts as [string, string]

  try {
    const key = await hmacKey(secret)
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      base64UrlDecode(sigB64),
      new TextEncoder().encode(payloadB64)
    )
    if (!valid) return null

    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadB64))) as AccessTokenPayload
    if (typeof payload.sub !== "string" || typeof payload.iat !== "number") return null
    if (Math.floor(Date.now() / 1000) - payload.iat > TOKEN_MAX_AGE_SECONDS) return null
    return payload
  } catch {
    return null
  }
}

export const ACCESS_TOKEN_MAX_AGE_SECONDS = TOKEN_MAX_AGE_SECONDS
