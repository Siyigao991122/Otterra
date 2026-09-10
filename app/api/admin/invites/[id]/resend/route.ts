import { NextRequest, NextResponse } from "next/server"
import { requireAdmin } from "@/lib/adminAuth"
import { getInviteCode } from "@/lib/inviteCodes"
import { sendInviteEmail } from "@/lib/sendInviteEmail"

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdmin(req)
  if (auth) return auth

  const { id } = await params
  if (!id) {
    return NextResponse.json({ error: "Invite id is required." }, { status: 400 })
  }

  try {
    const invite = await getInviteCode(id)
    if (!invite) {
      return NextResponse.json({ error: "Invite code not found." }, { status: 404 })
    }
    if (!invite.email) {
      return NextResponse.json({ error: "This code has no email on file to resend to." }, { status: 400 })
    }

    const result = await sendInviteEmail(invite.email, invite.code)
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 502 })
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error("[admin/invites] resend failed", err)
    return NextResponse.json({ error: "Failed to resend invite email." }, { status: 500 })
  }
}
