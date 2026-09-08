import { NextResponse } from "next/server"
import { signAccessToken, ACCESS_TOKEN_MAX_AGE_SECONDS } from "@/lib/accessToken"
import { redeemInviteCode } from "@/lib/inviteCodes"

const ACCESS_COOKIE = "otterra_access"

export async function POST(req: Request) {
  const secret = process.env.ACCESS_TOKEN_SECRET
  if (!secret) {
    return NextResponse.json({ error: "Access gate not configured." }, { status: 500 })
  }

  let body: { code?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 })
  }

  const submitted = typeof body.code === "string" ? body.code.trim() : ""
  if (!submitted) {
    return NextResponse.json({ error: "Enter an invite code." }, { status: 400 })
  }

  const ownerCode = process.env.SITE_ACCESS_CODE?.trim()
  let sub: string | null = null

  if (ownerCode && submitted === ownerCode) {
    sub = "owner"
  } else {
    try {
      const result = await redeemInviteCode(submitted)
      if (result.ok) {
        sub = result.id
      } else if (result.reason === "revoked") {
        return NextResponse.json({ error: "This invite code has been revoked." }, { status: 401 })
      } else if (result.reason === "exhausted") {
        return NextResponse.json({ error: "This invite code has already been used." }, { status: 401 })
      }
    } catch (e) {
      console.error("[access] invite code lookup failed", e)
      return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 })
    }
  }

  if (!sub) {
    return NextResponse.json({ error: "Incorrect invite code." }, { status: 401 })
  }

  const token = await signAccessToken(sub, secret)
  const res = NextResponse.json({ ok: true })
  res.cookies.set(ACCESS_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: ACCESS_TOKEN_MAX_AGE_SECONDS,
  })
  return res
}
