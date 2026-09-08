import { NextRequest, NextResponse } from "next/server"
import { requireAdminKey } from "@/lib/adminAuth"
import { createInviteCode, listInviteCodes } from "@/lib/inviteCodes"

export async function GET(req: NextRequest) {
  const auth = requireAdminKey(req)
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
  const auth = requireAdminKey(req)
  if (auth) return auth

  let body: { label?: string; maxUses?: number }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 })
  }

  const label = typeof body.label === "string" && body.label.trim() ? body.label.trim() : null
  const maxUses = Number.isInteger(body.maxUses) && (body.maxUses as number) > 0 ? (body.maxUses as number) : 1

  try {
    const invite = await createInviteCode(label, maxUses)
    return NextResponse.json({ invite })
  } catch (err) {
    console.error("[admin/invites] create failed", err)
    return NextResponse.json({ error: "Failed to create invite code." }, { status: 500 })
  }
}
