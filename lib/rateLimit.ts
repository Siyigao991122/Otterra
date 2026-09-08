/**
 * In-memory per-key fixed-window limiter. Best-effort only — Vercel serverless
 * functions don't share memory across instances/cold starts, so this doesn't
 * enforce a hard global cap. It's a cheap second layer behind the invite-code
 * gate (SITE_ACCESS_CODE) to blunt a single client hammering one warm instance.
 */

type Bucket = { count: number; resetAt: number }

const buckets = new Map<string, Bucket>()

export interface RateLimitResult {
  allowed: boolean
  remaining: number
  resetAt: number
}

export function checkRateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now()
  const existing = buckets.get(key)

  if (!existing || existing.resetAt <= now) {
    const resetAt = now + windowMs
    buckets.set(key, { count: 1, resetAt })
    return { allowed: true, remaining: limit - 1, resetAt }
  }

  if (existing.count >= limit) {
    return { allowed: false, remaining: 0, resetAt: existing.resetAt }
  }

  existing.count += 1
  return { allowed: true, remaining: limit - existing.count, resetAt: existing.resetAt }
}

export function clientIpFromRequest(req: Request): string {
  const forwardedFor = req.headers.get("x-forwarded-for")
  if (forwardedFor) return forwardedFor.split(",")[0]!.trim()
  return req.headers.get("x-real-ip") ?? "unknown"
}
