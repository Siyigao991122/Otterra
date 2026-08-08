import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabaseAdmin"
import type { ProductModelLifecycle } from "@/lib/productModelLifecycle"

const DESIGN_TIMEOUT_MS = 50_000

export const maxDuration = 60

interface CurrentPlacement {
  product_id: string
  title: string
  position: { x: number; z: number }
  rotation_y_deg: number
}

interface RoomZone {
  name: string
  /** Scene-space centre in metres (X right, Z into screen). */
  x: number
  z: number
  /** Scene-space bounds in metres — present when bounding box was detected. */
  minX?: number
  maxX?: number
  minZ?: number
  maxZ?: number
}

interface DesignRequest {
  prompt: string
  room: { width_m: number; depth_m: number; height_m: number }
  category?: string
  currentPlacements?: CurrentPlacement[]
  /** Detected room zones with their scene-space positions. */
  roomZones?: RoomZone[]
}

interface CatalogProduct extends ProductModelLifecycle {
  id: string
  title: string
  price: number | null
  currency: string | null
  image_url: string | null
  product_url: string | null
  length_m: number | null
  width_m: number | null
  height_m: number | null
  dims_confidence: number | null
  brand?: string | null
  category?: string | null
  model_url?: string | null
}

interface DesignPlacement {
  product_id: string
  title: string
  position: { x: number; z: number }
  rotation_y_deg: number
  qty: number
}

interface DesignPlan {
  title: string
  placements: DesignPlacement[]
  shopping_list: Array<{ product_id: string; title: string; qty: number }>
  notes: string[]
}

const KNOWN_BRANDS = [
  "ikea", "cb2", "west elm", "pottery barn", "crate and barrel",
  "scandinavian designs", "article", "wayfair", "restoration hardware", "rh",
]

function parseBrandFromPrompt(prompt: string): string | null {
  const lower = prompt.toLowerCase()
  for (const brand of KNOWN_BRANDS) {
    if (lower.includes(brand)) return brand
  }
  return null
}

function parseBudgetFromPrompt(prompt: string): number | null {
  const lower = prompt.toLowerCase()
  const patterns = [
    /\$(\d+(?:,\d{3})*(?:\.\d{2})?)/,
    /(\d+(?:,\d{3})*)\s*(?:dollars?|usd?|€|eur)/i,
    /(?:under|below|max|budget)\s*(?:of\s*)?\$?(\d+(?:,\d{3})*)/i,
    /budget[:\s]*\$?(\d+(?:,\d{3})*)/i,
  ]
  for (const p of patterns) {
    const m = lower.match(p)
    if (m) {
      const num = Number(m[1].replace(/,/g, ""))
      if (Number.isFinite(num) && num > 0) return num
    }
  }
  return null
}

function clampPosition(
  x: number,
  z: number,
  room: { width_m: number; depth_m: number }
): { x: number; z: number } {
  const margin = 0.5
  const halfW = room.width_m / 2 - margin
  const halfD = room.depth_m / 2 - margin
  return {
    x: Math.max(-halfW, Math.min(halfW, x)),
    z: Math.max(-halfD, Math.min(halfD, z)),
  }
}

function buildMockPlan(
  catalog: CatalogProduct[],
  room: { width_m: number; depth_m: number; height_m: number },
  prompt: string
): { plan: DesignPlan; catalog: CatalogProduct[] } {
  const withDims = catalog.filter(
    (p) =>
      p.dims_confidence === 2 &&
      p.length_m != null &&
      p.width_m != null &&
      p.height_m != null &&
      p.length_m > 0 &&
      p.width_m > 0 &&
      p.height_m > 0
  )
  const picked = (withDims.length >= 3 ? withDims : catalog).slice(0, 3)

  const halfW = room.width_m / 2
  const halfD = room.depth_m / 2

  const placements: DesignPlacement[] = picked.map((p, i) => {
    const positions = [
      { x: -halfW / 2, z: -halfD / 2 },
      { x: 0, z: halfD / 3 },
      { x: halfW / 3, z: -halfD / 3 },
    ]
    const pos = positions[i % positions.length]
    const clamped = clampPosition(pos.x, pos.z, room)
    return {
      product_id: p.id,
      title: p.title,
      position: clamped,
      rotation_y_deg: [0, 90, 180][i % 3],
      qty: 1,
    }
  })

  const shopping_list = placements.map((p) => ({
    product_id: p.product_id,
    title: p.title,
    qty: p.qty,
  }))

  const plan: DesignPlan = {
    title: prompt || "Living room + office layout",
    placements,
    shopping_list,
    notes: [
      "Mock layout generated from catalog.",
      `Room: ${room.width_m}m × ${room.depth_m}m × ${room.height_m}m`,
    ],
  }

  return { plan, catalog }
}

function buildCatalogForPrompt(catalog: CatalogProduct[]): string {
  return catalog
    .map((p) => {
      const dims =
        p.length_m != null && p.width_m != null && p.height_m != null
          ? `length_m:${p.length_m},width_m:${p.width_m},height_m:${p.height_m}`
          : "no_dims"
      return `- id:"${p.id}" title:"${p.title}" price:${p.price ?? "null"} currency:${p.currency ?? "null"} dims_confidence:${p.dims_confidence ?? "null"} dims:${dims}`
    })
    .join("\n")
}

function validateAndSanitizePlan(
  raw: unknown,
  catalog: CatalogProduct[],
  room: { width_m: number; depth_m: number; height_m: number }
): DesignPlan | null {
  if (!raw || typeof raw !== "object") return null
  const p = raw as Record<string, unknown>
  const title = typeof p.title === "string" ? p.title : "Layout"
  const placementsRaw = Array.isArray(p.placements) ? p.placements : []
  const shoppingListRaw = Array.isArray(p.shopping_list) ? p.shopping_list : []
  const notesRaw = Array.isArray(p.notes) ? p.notes : []

  const validIds = new Set(catalog.map((c) => c.id))
  const placements: DesignPlacement[] = []
  for (const item of placementsRaw) {
    if (!item || typeof item !== "object") continue
    const it = item as Record<string, unknown>
    const product_id = typeof it.product_id === "string" ? it.product_id : ""
    if (!validIds.has(product_id)) continue
    const prod = catalog.find((c) => c.id === product_id)
    const titleVal = typeof it.title === "string" ? it.title : prod?.title ?? "Furniture"
    const pos = it.position && typeof it.position === "object" ? (it.position as Record<string, unknown>) : {}
    let x = typeof pos.x === "number" ? pos.x : 0
    let z = typeof pos.z === "number" ? pos.z : 0
    const clamped = clampPosition(x, z, room)
    const rotation_y_deg = typeof it.rotation_y_deg === "number" ? it.rotation_y_deg : 0
    const qty = typeof it.qty === "number" && it.qty >= 1 ? it.qty : 1
    placements.push({
      product_id,
      title: titleVal,
      position: clamped,
      rotation_y_deg,
      qty,
    })
  }

  const shopping_list: Array<{ product_id: string; title: string; qty: number }> = []
  for (const item of shoppingListRaw) {
    if (!item || typeof item !== "object") continue
    const it = item as Record<string, unknown>
    const product_id = typeof it.product_id === "string" ? it.product_id : ""
    if (!validIds.has(product_id)) continue
    const prod = catalog.find((c) => c.id === product_id)
    const titleVal = typeof it.title === "string" ? it.title : prod?.title ?? "Furniture"
    const qty = typeof it.qty === "number" && it.qty >= 1 ? it.qty : 1
    shopping_list.push({ product_id, title: titleVal, qty })
  }

  const notes = notesRaw.filter((n): n is string => typeof n === "string")

  return {
    title,
    placements: placements.length > 0 ? placements : [],
    shopping_list: shopping_list.length > 0 ? shopping_list : [],
    notes: notes.length > 0 ? notes : ["Layout generated by AI."],
  }
}

export async function POST(req: NextRequest) {
  const startTime = Date.now()
  console.log("[design] POST /api/design started")

  try {
    let body: DesignRequest
    try {
      body = await req.json()
    } catch {
      console.log("[design] Invalid JSON body")
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 })
    }

    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : ""
    const room = body.room
    const category = body.category ?? "sofa"
    const roomZones: RoomZone[] = Array.isArray(body.roomZones) ? body.roomZones : []
    const currentPlacements: CurrentPlacement[] = Array.isArray(body.currentPlacements) ? body.currentPlacements : []

    if (
      !room ||
      typeof room.width_m !== "number" ||
      typeof room.depth_m !== "number" ||
      typeof room.height_m !== "number"
    ) {
      console.log("[design] Invalid room dimensions")
      return NextResponse.json(
        { error: "room must have width_m, depth_m, height_m as numbers." },
        { status: 400 }
      )
    }

    const budget = parseBudgetFromPrompt(prompt)
    if (budget != null) {
      console.log("[design] Parsed budget from prompt:", budget)
    }

    const brand = parseBrandFromPrompt(prompt)
    if (brand != null) {
      console.log("[design] Parsed brand from prompt:", brand)
    }

    console.log("[design] Fetching catalog", { category, room })

    let query = supabaseAdmin
      .from("products")
      .select(
        "id, title, price, currency, image_url, product_url, length_m, width_m, height_m, dims_confidence, brand, category, model_url, model_status, model_source, model_version, model_updated_at, model_notes"
      )
      .eq("category", category)
      .eq("is_active", true)
      .order("updated_at", { ascending: false })
      .limit(30)

    if (brand) {
      query = query.ilike("brand", `%${brand}%`)
    }

    if (budget != null) {
      query = query.lte("price", budget)
    }

    const { data: products, error } = await query

    if (error) {
      console.error("[design] Products fetch error:", error)
      return NextResponse.json({ error: "Failed to fetch catalog." }, { status: 500 })
    }

    const catalog: CatalogProduct[] = (products ?? []) as CatalogProduct[]
    console.log("[design] Catalog size:", catalog.length)

    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey || apiKey.length < 10) {
      console.log("[design] No OPENAI_API_KEY, using mock plan")
      const { plan, catalog: c } = buildMockPlan(catalog, room, prompt)
      return NextResponse.json({ plan, catalog: c })
    }

    const catalogText = buildCatalogForPrompt(catalog)
    const systemPrompt = `You are an interior design assistant. Return ONLY valid JSON, no prose or markdown.

Rules:
- Use ONLY product ids from the catalog. Do not invent ids.
- Prefer items with dims_confidence=2 for placements (they have reliable dimensions).
- Placements stay within room bounds: x in [-${(room.width_m / 2 - 0.5).toFixed(1)}, ${(room.width_m / 2 - 0.5).toFixed(1)}], z in [-${(room.depth_m / 2 - 0.5).toFixed(1)}, ${(room.depth_m / 2 - 0.5).toFixed(1)}].
- ZONE PLACEMENT RULES — strictly follow the room zones provided:
  * Sofas, coffee tables, armchairs → Living Room or Den only
  * Beds, nightstands, dressers → Bedroom only
  * Dining tables, dining chairs → Dining Room or Kitchen/Dining area only
  * NEVER place sofas or beds in Bathroom, Kitchen, Laundry, or Closet zones
  * When a zone has bounds (minX/maxX/minZ/maxZ), place furniture INSIDE those bounds
${budget != null ? `- Total cost must stay under $${budget}. Sum (price * qty) for all shopping_list items.` : ""}

Return JSON exactly matching this schema:
{
  "title": "string - short layout title",
  "placements": [
    {
      "product_id": "string - must be from catalog",
      "title": "string - product title",
      "position": { "x": number, "z": number },
      "rotation_y_deg": number,
      "qty": number
    }
  ],
  "shopping_list": [
    { "product_id": "string", "title": "string", "qty": number }
  ],
  "notes": ["string"]
}`

    const currentPlacementsText = currentPlacements.length > 0
      ? `\nCurrently placed furniture (prefer to KEEP these product_ids, just update positions):\n` +
        currentPlacements.map(p => `- ${p.title} (id: ${p.product_id}) at x=${p.position.x.toFixed(1)}, z=${p.position.z.toFixed(1)}, rot=${p.rotation_y_deg}°`).join("\n") + "\n"
      : ""

    const roomZonesText = roomZones.length > 0
      ? `\nRoom zones (scene coordinates, X right / Z into screen, origin = room centre):\n` +
        roomZones.map(z => {
          const hasBounds = z.minX != null && z.maxX != null && z.minZ != null && z.maxZ != null
          const boundsStr = hasBounds
            ? `, bounds x:[${z.minX!.toFixed(1)},${z.maxX!.toFixed(1)}] z:[${z.minZ!.toFixed(1)},${z.maxZ!.toFixed(1)}]`
            : ""
          return `- ${z.name}: center x=${z.x.toFixed(1)}, z=${z.z.toFixed(1)}${boundsStr}`
        }).join("\n") + "\n"
      : ""

    const userPrompt = `Room: ${room.width_m}m × ${room.depth_m}m × ${room.height_m}m ceiling.
${roomZonesText}${currentPlacementsText}
Catalog (use only these ids):
${catalogText}

User request: ${prompt || "Design a living room layout"}

Place furniture in the correct functional zone based on the room zones above.
Return JSON only.`

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), DESIGN_TIMEOUT_MS)

    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "gpt-5.5",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          response_format: { type: "json_object" },
          // Reasoning tokens count against this budget on gpt-5.5.
          max_completion_tokens: 16000,
          reasoning_effort: "low",
        }),
        signal: controller.signal,
      })

      clearTimeout(timeoutId)

      if (!res.ok) {
        const errText = await res.text()
        console.error("[design] OpenAI API error:", res.status, errText)
        throw new Error(`OpenAI API error: ${res.status}`)
      }

      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>
      }
      const content = data.choices?.[0]?.message?.content
      if (!content) {
        console.error("[design] No content in OpenAI response")
        throw new Error("No content in response")
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(content)
      } catch {
        console.error("[design] Invalid JSON from model:", content.slice(0, 200))
        throw new Error("Invalid JSON from model")
      }

      const plan = validateAndSanitizePlan(parsed, catalog, room)
      if (!plan || plan.placements.length === 0) {
        console.log("[design] No valid placements, using mock")
        const { plan: mockPlan, catalog: c } = buildMockPlan(catalog, room, prompt)
        return NextResponse.json({ plan: mockPlan, catalog: c })
      }

      // Post-process: snap any placement that falls outside all zone bounds back to
      // the most appropriate zone centre based on product category.
      const zonesWithBounds = roomZones.filter(
        z => z.minX != null && z.maxX != null && z.minZ != null && z.maxZ != null
      )
      if (zonesWithBounds.length > 0) {
        const LIVING_KEYWORDS = /living|lounge|den|great/i
        const BED_KEYWORDS = /bed|master|guest/i
        const DINING_KEYWORDS = /dining|kitchen/i
        const BAD_ZONES = /bath|toilet|laundry|closet|wc/i
        for (const placement of plan.placements) {
          const prod = catalog.find(c => c.id === placement.product_id)
          const cat = prod?.category ?? ""
          // Determine target zone type from category
          let targetKeyword: RegExp | null = null
          if (cat === "sofa") targetKeyword = LIVING_KEYWORDS
          else if (cat === "bed") targetKeyword = BED_KEYWORDS
          else if (cat === "dining_table" || cat === "chair") targetKeyword = DINING_KEYWORDS

          // Check if placement is inside a "bad" zone (bathroom, laundry, etc.)
          const { x, z } = placement.position
          const inBadZone = zonesWithBounds.some(zone =>
            BAD_ZONES.test(zone.name) &&
            x >= zone.minX! && x <= zone.maxX! &&
            z >= zone.minZ! && z <= zone.maxZ!
          )

          if (inBadZone && targetKeyword) {
            const targetZone = zonesWithBounds.find(zone => targetKeyword!.test(zone.name))
            if (targetZone) {
              placement.position = clampPosition(targetZone.x, targetZone.z, room)
              console.log(`[design] snapped ${placement.title} from bad zone to ${targetZone.name}`)
            }
          }
        }
      }

      const elapsed = Date.now() - startTime
      console.log("[design] Success, placements:", plan.placements.length, "elapsed:", elapsed, "ms")

      return NextResponse.json({ plan, catalog })
    } catch (fetchErr) {
      clearTimeout(timeoutId)
      const msg = fetchErr instanceof Error ? fetchErr.message : ""
      const isTimeout = msg.includes("abort") || msg.includes("timeout")
      console.error("[design] OpenAI request failed:", isTimeout ? "timeout" : msg)
      const { plan, catalog: c } = buildMockPlan(catalog, room, prompt)
      return NextResponse.json({ plan, catalog: c })
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("Missing Supabase env")) {
      return NextResponse.json({ error: "Server configuration error." }, { status: 500 })
    }
    console.error("[design] Unexpected error:", err)
    throw err
  }
}
