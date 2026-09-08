import { NextRequest, NextResponse } from "next/server"
import { requireAdminKey } from "@/lib/adminAuth"
import { revokeInviteCode } from "@/lib/inviteCodes"

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = requireAdminKey(req)
  if (auth) return auth

  const { id } = await params
  if (!id) {
    return NextResponse.json({ error: "Invite id is required." }, { status: 400 })
  }

  let body: { revoked?: boolean }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 })
  }

  if (body.revoked !== true) {
    return NextResponse.json({ error: "Only { revoked: true } is supported." }, { status: 400 })
  }

  try {
    await revokeInviteCode(id)
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error("[admin/invites] revoke failed", err)
    return NextResponse.json({ error: "Failed to revoke invite code." }, { status: 500 })
  }
}
