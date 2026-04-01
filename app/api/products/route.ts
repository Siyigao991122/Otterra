import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabaseAdmin"
import { supabasePublic } from "@/lib/supabasePublic"

const ALLOWED_CATEGORIES = ["sofa", "bed", "dining_table"] as const

function toNum(val: unknown): number | null {
  if (val === null || val === undefined || val === "") return null
  const n = Number(val)
  return Number.isFinite(n) ? n : null
}

export async function POST(req: NextRequest) {
  try {
    let body: Record<string, unknown>
    try {
      body = await req.json()
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 })
    }

    const title = typeof body.title === "string" ? body.title.trim() : ""
    const category = typeof body.category === "string" ? body.category.trim().toLowerCase() : ""

    if (!title) {
      return NextResponse.json({ error: "title is required." }, { status: 400 })
    }
    if (!ALLOWED_CATEGORIES.includes(category as (typeof ALLOWED_CATEGORIES)[number])) {
      return NextResponse.json(
        { error: `category must be one of: ${ALLOWED_CATEGORIES.join(", ")}` },
        { status: 400 }
      )
    }

    const row = {
      source: "manual",
      source_product_id: null,
      brand: typeof body.brand === "string" && body.brand.trim() ? body.brand.trim() : "IKEA",
      category,
      title,
      image_url: typeof body.image_url === "string" && body.image_url.trim() ? body.image_url.trim() : null,
      product_url: typeof body.product_url === "string" && body.product_url.trim() ? body.product_url.trim() : null,
      price: toNum(body.price),
      currency: "USD",
      length_m: toNum(body.length_m),
      width_m: toNum(body.width_m),
      height_m: toNum(body.height_m),
      dims_confidence: 2,
      style_tags: [],
      is_active: true,
    }

    const { data, error } = await supabaseAdmin.from("products").insert(row).select().single()

    if (error) {
      console.error("Products insert error:", error)
      return NextResponse.json({ error: "Failed to insert product." }, { status: 500 })
    }

    return NextResponse.json(data)
  } catch (err) {
    if (err instanceof Error && err.message.includes("Missing Supabase env")) {
      return NextResponse.json({ error: "Server configuration error." }, { status: 500 })
    }
    throw err
  }
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)
    const category = searchParams.get("category")?.toLowerCase()
    const brand = searchParams.get("brand")?.trim()

    let query = supabasePublic
      .from("products")
      .select("*")
      .eq("is_active", true)
      .order("updated_at", { ascending: false })
      .limit(200)

    if (category && ALLOWED_CATEGORIES.includes(category as (typeof ALLOWED_CATEGORIES)[number])) {
      query = query.eq("category", category)
    }
    if (brand) {
      query = query.eq("brand", brand)
    }

    const { data, error } = await query

    if (error) {
      console.error("Products fetch error:", error)
      return NextResponse.json({ error: "Failed to fetch products." }, { status: 500 })
    }

    return NextResponse.json({ products: data ?? [] })
  } catch (err) {
    if (err instanceof Error && err.message.includes("Missing Supabase env")) {
      return NextResponse.json({ error: "Server configuration error." }, { status: 500 })
    }
    throw err
  }
}
