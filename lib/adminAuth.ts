import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabaseAdmin"

function allowedAdminEmails(): Set<string> {
  const configured = process.env.ADMIN_EMAILS ?? process.env.ADMIN_EMAIL ?? ""
  return new Set(configured.split(",").map((email) => email.trim().toLowerCase()).filter(Boolean))
}

/** Verifies a Supabase Google session and checks the server-only email allowlist. */
export async function requireAdmin(request: NextRequest): Promise<NextResponse | null> {
  const allowed = allowedAdminEmails()
  if (allowed.size === 0) {
    return NextResponse.json({ error: "Admin email allowlist is not configured." }, { status: 500 })
  }

  const authorization = request.headers.get("authorization")
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : ""
  if (!token) return NextResponse.json({ error: "Please sign in as an administrator." }, { status: 401 })

  const { data, error } = await supabaseAdmin.auth.getUser(token)
  const email = data.user?.email?.toLowerCase()
  if (error || !email || !allowed.has(email)) {
    return NextResponse.json({ error: "This Google account is not authorized for admin access." }, { status: 403 })
  }
  return null
}
