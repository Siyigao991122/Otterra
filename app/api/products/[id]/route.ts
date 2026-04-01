import { NextRequest, NextResponse } from "next/server"
import { requireAdminKey } from "@/lib/adminAuth"
import { supabaseAdmin } from "@/lib/supabaseAdmin"

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = requireAdminKey(req)
  if (auth) return auth

  try {
    const { id } = await params
    if (!id) {
      return NextResponse.json({ error: "Product id is required." }, { status: 400 })
    }

    let body: Record<string, unknown>
    try {
      body = await req.json()
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 })
    }

    const model_url =
      body.model_url === null || body.model_url === undefined
        ? null
        : typeof body.model_url === "string" && body.model_url.trim()
          ? body.model_url.trim()
          : null

    const updatePayload: Record<string, unknown> = { model_url }

    const nullableTextFields = [
      "model_status",
      "model_source",
      "model_version",
      "model_notes",
    ] as const
    for (const key of nullableTextFields) {
      if (!(key in body)) continue
      const v = body[key]
      if (v === null) {
        updatePayload[key] = null
        continue
      }
      if (typeof v !== "string") {
        return NextResponse.json({ error: `${key} must be a string or null.` }, { status: 400 })
      }
      updatePayload[key] = v.trim() || null
    }

    if ("model_updated_at" in body) {
      const v = body.model_updated_at
      if (v === null) {
        updatePayload.model_updated_at = null
      } else if (typeof v === "string") {
        const t = v.trim()
        updatePayload.model_updated_at = t || null
      } else {
        return NextResponse.json({ error: "model_updated_at must be a string or null." }, { status: 400 })
      }
    }

    const { data, error } = await supabaseAdmin
      .from("products")
      .update(updatePayload)
      .eq("id", id)
      .select()
      .single()

    if (error) {
      console.error("Products update error:", error)
      return NextResponse.json({ error: "Failed to update product." }, { status: 500 })
    }

    return NextResponse.json({ product: data })
  } catch (err) {
    if (err instanceof Error && err.message.includes("Missing Supabase env")) {
      return NextResponse.json({ error: "Server configuration error." }, { status: 500 })
    }
    throw err
  }
}
