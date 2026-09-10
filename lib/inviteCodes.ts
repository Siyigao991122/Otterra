import { supabaseAdmin } from "@/lib/supabaseAdmin"

export interface InviteCode {
  id: string
  code: string
  label: string | null
  email: string | null
  max_uses: number
  use_count: number
  revoked: boolean
  created_at: string
  redeemed_at: string | null
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" // no 0/O/1/I

function generateCode(length = 8): string {
  let out = ""
  for (let i = 0; i < length; i++) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]
  }
  return out
}

/** Creates a new invite code, retrying on the rare random collision. */
export async function createInviteCode(
  label: string | null,
  maxUses: number,
  email: string | null = null
): Promise<InviteCode> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateCode()
    const { data, error } = await supabaseAdmin
      .from("invite_codes")
      .insert({ code, label, max_uses: maxUses, email })
      .select()
      .single()

    if (!error) return data as InviteCode
    if (error.code !== "23505") throw new Error(error.message) // not a unique-violation retry
  }
  throw new Error("Could not generate a unique invite code after several attempts.")
}

export async function listInviteCodes(): Promise<InviteCode[]> {
  const { data, error } = await supabaseAdmin
    .from("invite_codes")
    .select()
    .order("created_at", { ascending: false })
  if (error) throw new Error(error.message)
  return (data ?? []) as InviteCode[]
}

export async function getInviteCode(id: string): Promise<InviteCode | null> {
  const { data, error } = await supabaseAdmin.from("invite_codes").select().eq("id", id).maybeSingle()
  if (error) throw new Error(error.message)
  return (data as InviteCode | null) ?? null
}

export async function revokeInviteCode(id: string): Promise<void> {
  const { error } = await supabaseAdmin.from("invite_codes").update({ revoked: true }).eq("id", id)
  if (error) throw new Error(error.message)
}

export type RedeemResult =
  | { ok: true; id: string }
  | { ok: false; reason: "not_found" | "revoked" | "exhausted" }

/** Atomically consumes one use of a code via the increment_invite_code_use RPC (avoids a race on use_count). */
export async function redeemInviteCode(rawCode: string): Promise<RedeemResult> {
  const code = rawCode.trim().toUpperCase()
  if (!code) return { ok: false, reason: "not_found" }

  const { data, error } = await supabaseAdmin.rpc("redeem_invite_code", { p_code: code })
  if (error) throw new Error(error.message)

  const row = Array.isArray(data) ? data[0] : data
  if (!row) return { ok: false, reason: "not_found" }
  if (row.result === "revoked") return { ok: false, reason: "revoked" }
  if (row.result === "exhausted") return { ok: false, reason: "exhausted" }
  if (row.result === "ok") return { ok: true, id: row.invite_id as string }
  return { ok: false, reason: "not_found" }
}
