import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// Simple in-memory rate limit: IP -> { count, resetAt }
const rateLimitMap = new Map<string, { count: number; resetAt: number }>()
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX = 5

function getClientIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown"
  )
}

function checkRateLimit(ip: string): boolean {
  const now = Date.now()
  const entry = rateLimitMap.get(ip)

  if (!entry) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
    return true
  }

  if (now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
    return true
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    return false
  }

  entry.count++
  return true
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req)
  if (!checkRateLimit(ip)) {
    return NextResponse.json({ error: "Too many requests. Please try again later." }, { status: 429 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url) {
    return NextResponse.json(
      { error: "Server configuration error: NEXT_PUBLIC_SUPABASE_URL is not set." },
      { status: 500 }
    )
  }
  if (!serviceRoleKey) {
    return NextResponse.json(
      { error: "Server configuration error: SUPABASE_SERVICE_ROLE_KEY is not set. Add it to .env.local (never commit it)." },
      { status: 500 }
    )
  }

  let body: { email?: string; name?: string; role?: string; ref?: string; company?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 })
  }

  // Honeypot: company must be empty (bots often fill hidden fields)
  if (body.company && String(body.company).trim() !== "") {
    return NextResponse.json({ ok: true })
  }

  const email = typeof body.email === "string" ? body.email.trim() : ""
  if (!email) {
    return NextResponse.json({ error: "Email is required." }, { status: 400 })
  }

  if (!EMAIL_REGEX.test(email)) {
    return NextResponse.json({ error: "Invalid email format." }, { status: 400 })
  }

  const name = typeof body.name === "string" ? body.name.trim() || null : null
  const role = typeof body.role === "string" ? body.role.trim() || null : null
  const ref = typeof body.ref === "string" ? body.ref.trim() || null : null

  const supabase = createClient(url, serviceRoleKey)

  const { error } = await supabase.from("waitlist").insert({ email, name, role, ref })

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json({ ok: true, alreadyExists: true })
    }
    console.error("Waitlist insert error:", error)
    return NextResponse.json({ error: "Failed to join waitlist." }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
