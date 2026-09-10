import { NextRequest, NextResponse } from "next/server"
import { requireAdmin } from "@/lib/adminAuth"
import { createInviteCode, listInviteCodes } from "@/lib/inviteCodes"
import { sendInviteEmail } from "@/lib/sendInviteEmail"

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req)
  if (auth) return auth

  try {
    const invites = await listInviteCodes()
    return NextResponse.json({ invites })
  } catch (err) {
    console.error("[admin/invites] list failed", err)
    return NextResponse.json({ error: "Failed to list invite codes." }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req)
  if (auth) return auth

  let body: { label?: string; maxUses?: number; email?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 })
  }

  const label = typeof body.label === "string" && body.label.trim() ? body.label.trim() : null
  const maxUses = Number.isInteger(body.maxUses) && (body.maxUses as number) > 0 ? (body.maxUses as number) : 1

  const email = typeof body.email === "string" ? body.email.trim() : ""
  if (email && !EMAIL_REGEX.test(email)) {
    return NextResponse.json({ error: "Invalid email format." }, { status: 400 })
  }

  try {
    const invite = await createInviteCode(label, maxUses, email || null)

    if (!email) {
      return NextResponse.json({ invite })
    }

    const emailResult = await sendInviteEmail(email, invite.code)
    if (!emailResult.ok) {
      console.error("[admin/invites] email send failed", emailResult.error)
      return NextResponse.json({ invite, emailError: emailResult.error })
    }
    return NextResponse.json({ invite })
  } catch (err) {
    console.error("[admin/invites] create failed", err)
    return NextResponse.json({ error: "Failed to create invite code." }, { status: 500 })
  }
}
