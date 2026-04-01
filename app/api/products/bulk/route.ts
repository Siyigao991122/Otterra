import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabaseAdmin"

const ALLOWED_CATEGORIES = ["sofa", "bed", "dining_table"] as const
const MAX_ITEMS = 200

function toNum(val: unknown): number | null {
  if (val === null || val === undefined || val === "") return null
  const n = Number(val)
  return Number.isFinite(n) ? n : null
}

function getByPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".")
  let cur: unknown = obj
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined
    cur = (cur as Record<string, unknown>)[p]
  }
  return cur
}

function getValue(
  item: Record<string, unknown>,
  keys: string | string[]
): string | null {
  const arr = Array.isArray(keys) ? keys : [keys]
  for (const k of arr) {
    const v = getByPath(item, k)
    if (v != null && v !== "") {
      const s = typeof v === "string" ? v.trim() : String(v)
      if (s) return s
    }
  }
  return null
}

function getValueNum(item: Record<string, unknown>, keys: string | string[]): number | null {
  const arr = Array.isArray(keys) ? keys : [keys]
  for (const k of arr) {
    const v = getByPath(item, k)
    const n = toNum(v)
    if (n != null) return n
  }
  return null
}

interface BulkBody {
  items?: unknown[]
  defaults?: { source?: string; brand?: string; category?: string }
  mapping?: Record<string, string | string[]>
  onlyWithDimensions?: boolean
}

export async function POST(req: NextRequest) {
  try {
    let body: BulkBody
    try {
      body = await req.json()
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 })
    }

    const rawItems = Array.isArray(body.items) ? body.items : []
    if (rawItems.length === 0) {
      return NextResponse.json({ error: "items array is required and must not be empty." }, { status: 400 })
    }
    if (rawItems.length > MAX_ITEMS) {
      return NextResponse.json(
        { error: `Too many items. Maximum ${MAX_ITEMS}. Split your import.` },
        { status: 400 }
      )
    }

    const defaults = body.defaults ?? {}
    const mapping = body.mapping ?? {}
    const onlyWithDimensions = Boolean(body.onlyWithDimensions)

    const defaultCategory =
      typeof defaults.category === "string" && defaults.category.trim()
        ? defaults.category.trim().toLowerCase()
        : "sofa"
    const defaultBrand =
      typeof defaults.brand === "string" && defaults.brand.trim()
        ? defaults.brand.trim()
        : "IKEA"
    const defaultSource =
      typeof defaults.source === "string" && defaults.source.trim()
        ? defaults.source.trim()
        : "apify"

    const errors: { index: number; reason: string }[] = []
    const inserted: { id: string; title: string; category: string }[] = []
    const rows: Record<string, unknown>[] = []

    const map = (ourKey: string, fallbacks: string[]): string | string[] =>
      mapping[ourKey] ?? fallbacks

    for (let i = 0; i < rawItems.length; i++) {
      const raw = rawItems[i]
      if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
        errors.push({ index: i, reason: "Invalid item: must be an object" })
        continue
      }
      const item = raw as Record<string, unknown>

      let title = getValue(item, map("title", ["title", "name"]))?.trim()
      if (!title) {
        const nameVal = getValue(item, ["name"])
        const typeNameVal = getValue(item, ["typeName", "type"])
        if (nameVal || typeNameVal) {
          title = [nameVal, typeNameVal].filter(Boolean).join(" ").trim()
        }
      }
      if (!title) {
        errors.push({ index: i, reason: "Missing title (and no name/typeName fallback)" })
        continue
      }

      let category =
        getValue(item, map("category", ["category"]))?.toLowerCase() ??
        defaultCategory
      if (!ALLOWED_CATEGORIES.includes(category as (typeof ALLOWED_CATEGORIES)[number])) {
        category = defaultCategory
      }
      if (!ALLOWED_CATEGORIES.includes(category as (typeof ALLOWED_CATEGORIES)[number])) {
        errors.push({ index: i, reason: `Invalid category: ${category}` })
        continue
      }

      const brand =
        getValue(item, map("brand", ["brand"]))?.trim() ?? defaultBrand
      const imageUrl = getValue(item, map("image_url", ["image", "imageUrl", "images.0"]))
      const productUrl = getValue(item, map("product_url", ["url", "productUrl"]))
      const price = getValueNum(item, map("price", ["price", "priceValue"]))
      const sourceProductId = getValue(item, map("source_product_id", ["sku", "id", "productId"]))
      const lengthM = getValueNum(item, map("length_m", ["length_m"]))
      const widthM = getValueNum(item, map("width_m", ["width_m"]))
      const heightM = getValueNum(item, map("height_m", ["height_m"]))

      if (onlyWithDimensions) {
        const hasDims =
          lengthM != null && widthM != null && heightM != null &&
          lengthM > 0 && widthM > 0 && heightM > 0
        if (!hasDims) {
          errors.push({ index: i, reason: "Skipped: no dimensions" })
          continue
        }
      }

      const hasAllDims =
        lengthM != null && widthM != null && heightM != null &&
        lengthM > 0 && widthM > 0 && heightM > 0
      const dimsConfidence = hasAllDims ? 2 : 0

      rows.push({
        source: defaultSource,
        source_product_id: sourceProductId || null,
        brand: brand || "IKEA",
        category,
        title,
        image_url: imageUrl || null,
        product_url: productUrl || null,
        price,
        currency: "USD",
        length_m: lengthM,
        width_m: widthM,
        height_m: heightM,
        dims_confidence: dimsConfidence,
        style_tags: [],
        is_active: true,
      })
    }

    const skippedCount = errors.length
    let insertedCount = 0

    if (rows.length > 0) {
      const { data, error } = await supabaseAdmin.from("products").insert(rows).select("id, title, category")

      if (error) {
        console.error("Products bulk insert error:", error)
        return NextResponse.json(
          { error: "Failed to insert products.", insertedCount: 0, skippedCount, errors, inserted: [] },
          { status: 500 }
        )
      }

      const result = Array.isArray(data) ? data : data ? [data] : []
      insertedCount = result.length
      for (const r of result) {
        if (r && typeof r === "object" && "id" in r && "title" in r && "category" in r) {
          inserted.push({
            id: String(r.id),
            title: String(r.title),
            category: String(r.category),
          })
        }
      }
    }

    return NextResponse.json({
      insertedCount,
      skippedCount,
      errors,
      inserted,
    })
  } catch (err) {
    if (err instanceof Error && err.message.includes("Missing Supabase env")) {
      return NextResponse.json({ error: "Server configuration error." }, { status: 500 })
    }
    throw err
  }
}
