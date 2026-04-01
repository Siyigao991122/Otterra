import { Buffer } from "node:buffer"
import { NextResponse } from "next/server"
import {
  downscaleDataUrlForOpenAIIfNeeded,
  FLOORPLAN_OPENAI_MAX_EDGE_PX,
} from "@/lib/downscaleFloorplanImageForOpenAI"
import { sanitizeFloorplanGeometryWithStats } from "@/lib/floorplanGeometry"
import type {
  FloorPlanAnalysis,
  FloorplanFootprintDebugInfo,
  FloorplanGeometry,
  InteriorWallSanitizeStats,
} from "@/lib/types"
import { rectangleFootprintFromAABB } from "@/lib/floorplanGeometry"

export const maxDuration = 90

/** Chat Completions vision model (logged for debugging). */
const OPENAI_VISION_MODEL = "gpt-4o"

type ImageInputMeta = {
  sourceType: "base64" | "http_url" | "other"
  mime?: string
  base64PayloadCharLength?: number
  renderedPx?: { width: number; height: number }
}

function describeImageInput(firstImage: string): ImageInputMeta {
  if (firstImage.startsWith("data:")) {
    const mimeMatch = /^data:([^;,]+)[;,]/.exec(firstImage)
    const mime = mimeMatch?.[1]
    const comma = firstImage.indexOf(",")
    const payload = comma >= 0 ? firstImage.slice(comma + 1) : ""
    const meta: ImageInputMeta = {
      sourceType: "base64",
      mime,
      base64PayloadCharLength: payload.length,
    }
    // PNG IHDR width/height when payload is standard data URL (e.g. pdf.js canvas).
    if (mime === "image/png" && payload.length > 32) {
      try {
        const buf = Buffer.from(payload, "base64")
        if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(12) === 0x49484452) {
          meta.renderedPx = {
            width: buf.readUInt32BE(16),
            height: buf.readUInt32BE(20),
          }
        }
      } catch {
        /* ignore */
      }
    }
    return meta
  }
  if (/^https?:\/\//i.test(firstImage)) {
    return { sourceType: "http_url" }
  }
  return { sourceType: "other" }
}

/** Build legacy rectangular analysis + optional centered rectangle geometry (always valid). */
function fallbackFloorPlan(
  rooms: FloorPlanAnalysis["rooms"],
  totals: Pick<FloorPlanAnalysis, "totalWidthMeters" | "totalDepthMeters" | "totalAreaSqMeters" | "notes">,
  includeRectGeometry: boolean
): { floorPlan: FloorPlanAnalysis } {
  const width = rooms[0]?.widthMeters ?? totals.totalWidthMeters
  const depth = rooms[0]?.depthMeters ?? totals.totalDepthMeters
  const geometry: FloorplanGeometry | undefined = includeRectGeometry
    ? {
        units: "m",
        footprintPolygon: rectangleFootprintFromAABB(width, depth),
        confidence: 0.25,
      }
    : undefined

  return {
    floorPlan: {
      rooms,
      ...totals,
      notes: totals.notes,
      geometry,
    },
  }
}

/**
 * Heuristic merge: use AI footprint when valid; else rectangular footprint from first room / totals.
 */
function mergeAnalysis(
  parsed: Record<string, unknown>,
  fallbackNotes: string
): {
  floorPlan: FloorPlanAnalysis
  interiorWallStats: InteriorWallSanitizeStats
  usedFallbackRectangle: boolean
} {
  const roomsRaw = parsed.rooms
  const rooms: FloorPlanAnalysis["rooms"] = Array.isArray(roomsRaw)
    ? roomsRaw.map((r, i) => {
        const o = r && typeof r === "object" ? (r as Record<string, unknown>) : {}
        return {
          name: typeof o.name === "string" ? o.name : `Room ${i + 1}`,
          widthMeters: Number(o.widthMeters) || 4,
          depthMeters: Number(o.depthMeters) || 4,
          heightMeters: Number(o.heightMeters) || 2.7,
        }
      })
    : [{ name: "Living Area", widthMeters: 4, depthMeters: 4, heightMeters: 2.7 }]

  const totalWidthMeters = Number(parsed.totalWidthMeters) || rooms[0]?.widthMeters || 4
  const totalDepthMeters = Number(parsed.totalDepthMeters) || rooms[0]?.depthMeters || 4
  const totalAreaSqMeters =
    Number(parsed.totalAreaSqMeters) || totalWidthMeters * totalDepthMeters
  const notes = typeof parsed.notes === "string" ? parsed.notes : fallbackNotes

  const { geometry: geoFromModel, interiorWallStats } = sanitizeFloorplanGeometryWithStats(parsed)
  let geometry = geoFromModel
  const usedFallbackRectangle = !geometry?.footprintPolygon?.length

  if (!geometry?.footprintPolygon?.length) {
    const w = rooms[0]?.widthMeters ?? totalWidthMeters
    const d = rooms[0]?.depthMeters ?? totalDepthMeters
    geometry = {
      units: "m",
      footprintPolygon: rectangleFootprintFromAABB(w, d),
      confidence: 0.3,
    }
  }

  return {
    floorPlan: {
      rooms,
      totalWidthMeters,
      totalDepthMeters,
      totalAreaSqMeters,
      notes,
      geometry,
    },
    interiorWallStats,
    usedFallbackRectangle,
  }
}

/** Count footprint vertices in raw model output (before sanitize/centering). */
function countRawModelFootprintVertices(parsed: Record<string, unknown>): number {
  const candidates = parsed.footprintPolygonMeters ?? parsed.footprintPolygon
  if (!Array.isArray(candidates)) return 0
  let n = 0
  for (const item of candidates) {
    if (!item || typeof item !== "object") continue
    const o = item as Record<string, unknown>
    const x = Number(o.x)
    const y = Number(o.y)
    if (Number.isFinite(x) && Number.isFinite(y)) n++
  }
  return n
}

/** TEMPORARY — debug only. */
function footprintDebugAfterMerge(
  floorPlan: FloorPlanAnalysis,
  modelRawFootprintVertexCount: number,
  interiorWallStats: InteriorWallSanitizeStats,
  usedFallbackRectangle: boolean
): FloorplanFootprintDebugInfo {
  const n = floorPlan.geometry?.footprintPolygon?.length ?? 0
  const geometryType: FloorplanFootprintDebugInfo["geometryType"] =
    n < 3 ? "none" : n === 4 ? "quad" : "polygon"
  return {
    footprintPointCount: n,
    geometryType,
    usedFallbackRectangle,
    modelRawFootprintVertexCount,
    modelReturnedExactlyFourFootprintPoints: modelRawFootprintVertexCount === 4,
    interiorWalls: interiorWallStats,
  }
}

const VISION_SYSTEM = `You are an architectural assistant analyzing a floor plan image (possibly rasterized from PDF).

Return a single JSON object with:
- rooms: array of { name, widthMeters, depthMeters, heightMeters } for major spaces (meters).
- totalWidthMeters, totalDepthMeters, totalAreaSqMeters for the whole drawn unit or primary wing.
- notes: short summary including measurement assumptions.
- footprintPolygonMeters: array of {x, y} vertices tracing the OUTER EXTERIOR boundary of the full residential unit (or the drawn suite), in METERS, in a single consistent plan coordinate system BEFORE centering (we will center in code). This must follow the real outside shell of the unit — not the interior room partition lines, and not an axis-aligned bounding box around the unit.
  CRITICAL — do not oversimplify: unless the true exterior is genuinely a perfect rectangle, do NOT approximate the outline as only four corners. Preserve every significant exterior corner, notch, recess, bay, jog, and protrusion you can see (even if it means a few more points). Prefer about 6–12 vertices for typical condo / apartment footprints with jogs or cut-outs; use fewer only when the exterior is visibly a simple rectangle. Simplify mildly if needed (omit tiny decorative bumps) but keep the overall silhouette faithful.
  Order vertices counter-clockwise around the closed loop. x = horizontal on page, y = vertical on page (these map to 3D X and Z with Y up). Do not duplicate the first point at the end. Use plausible metric coordinates consistent with labeled dimensions on the sheet; convert feet/inches to meters (1 ft = 0.3048 m).
  Only output exactly four corners if the visible exterior boundary is actually a simple quadrilateral with no meaningful recesses or extra corners along the outer wall.
- interiorWallsMeters (strongly recommended): array of segments { id?, x1, y1, x2, y2, thickness? } for MAJOR interior PARTITION walls that separate rooms (not exterior, not furniture, not cabinets/islands, not thin fixture lines). Use the EXACT same plan coordinate system and METERS scale as footprintPolygonMeters (same origin and axis directions: x = horizontal on sheet, y = vertical on sheet before we center in code). Each segment is a straight wall centerline from (x1,y1) to (x2,y2); omit thickness or set ~0.10–0.20 m if unsure (we default ~0.12 m). Trace every load-bearing or clear drywall partition that defines room boundaries; ignore rugs, sofas, tables, and tiny decorative edges. If a wall steps, use one segment per straight run. Prefer completeness of major dividers over omitting lines — this powers a 3D layout view.
- confidence: 0-1 how sure you are in the geometry.

Convert feet/inches to meters (1 ft = 0.3048 m). If labels are illegible, estimate from proportions and state that in notes.`

export async function POST(req: Request) {
  let body: { images?: string[] }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 })
  }

  const images = body.images
  if (!Array.isArray(images) || images.length === 0) {
    return NextResponse.json({ error: "Expected { images: string[] } with at least one data URL." }, { status: 400 })
  }

  const apiKey = process.env.OPENAI_API_KEY?.trim()
  const firstImage = images[0]
  if (!firstImage || typeof firstImage !== "string") {
    return NextResponse.json({ error: "Invalid image entry." }, { status: 400 })
  }

  if (!apiKey) {
    console.warn("[analyze-floorplan] OPENAI_API_KEY missing — using deterministic fallback + rectangle geometry")
    return NextResponse.json(
      fallbackFloorPlan(
        [{ name: "Living Area", widthMeters: 3.96, depthMeters: 3.81, heightMeters: 2.7 }],
        {
          totalWidthMeters: 3.96,
          totalDepthMeters: 3.81,
          totalAreaSqMeters: 3.96 * 3.81,
          notes:
            "Configure OPENAI_API_KEY for real floorplan vision. Using placeholder dimensions and rectangular footprint.",
        },
        true
      )
    )
  }

  const userVisionText =
    VISION_SYSTEM +
    "\n\nAnalyze this floor plan image and output JSON only matching the schema described."

  const buildOpenAiPayloadJson = (imageUrl: string) =>
    JSON.stringify({
      model: OPENAI_VISION_MODEL,
      messages: [
        {
          role: "user" as const,
          content: [
            { type: "text", text: userVisionText },
            { type: "image_url", image_url: { url: imageUrl } },
          ],
        },
      ],
      response_format: { type: "json_object" as const },
      max_tokens: 4096,
      temperature: 0.2,
    })

  let imageUrlForOpenAI = firstImage
  const payloadBytesOriginal = Buffer.byteLength(buildOpenAiPayloadJson(firstImage), "utf8")

  if (describeImageInput(firstImage).sourceType === "base64") {
    try {
      const down = await downscaleDataUrlForOpenAIIfNeeded(firstImage)
      if (down) {
        imageUrlForOpenAI = down.dataUrl
        const payloadBytesResized = Buffer.byteLength(buildOpenAiPayloadJson(imageUrlForOpenAI), "utf8")
        console.log("[analyze-floorplan] OpenAI image downscale (analysis payload only)", {
          maxEdgePx: FLOORPLAN_OPENAI_MAX_EDGE_PX,
          originalPx: down.originalPx,
          resizedPx: down.outputPx,
          originalBase64Chars: down.originalBase64Chars,
          resizedBase64Chars: down.outputBase64Chars,
          originalPayloadBytes: payloadBytesOriginal,
          resizedPayloadBytes: payloadBytesResized,
          didResize: down.didResize,
        })
      }
    } catch (e) {
      console.warn("[analyze-floorplan] downscale failed, using original image", e)
    }
  }

  const contentParts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
    { type: "text", text: userVisionText },
    { type: "image_url", image_url: { url: imageUrlForOpenAI } },
  ]

  const imageMeta = describeImageInput(imageUrlForOpenAI)
  const payloadJson = buildOpenAiPayloadJson(imageUrlForOpenAI)
  const payloadBytes = Buffer.byteLength(payloadJson, "utf8")

  console.log("[analyze-floorplan] using real OpenAI analysis", {
    model: OPENAI_VISION_MODEL,
    payloadBytes,
    hasImage: contentParts.some((p) => p.type === "image_url"),
    imageSourceType: imageMeta.sourceType,
    imageMime: imageMeta.mime ?? null,
    renderedImagePx: imageMeta.renderedPx ?? null,
  })
  if (imageMeta.sourceType === "base64") {
    console.log("[analyze-floorplan] debug image payload size", {
      base64CharLength: imageMeta.base64PayloadCharLength ?? 0,
      requestJsonUtf8Bytes: payloadBytes,
    })
  }

  try {
    let res: Response
    try {
      res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: payloadJson,
      })
    } catch (fetchErr: unknown) {
      const err = fetchErr instanceof Error ? fetchErr : new Error(String(fetchErr))
      const cause = err.cause
      const causeObj =
        cause && typeof cause === "object"
          ? (cause as { code?: string; message?: string; name?: string })
          : null
      console.error("[analyze-floorplan] OpenAI fetch failed (network/socket)", {
        errorName: err.name,
        errorMessage: err.message,
        causeCode: causeObj?.code ?? null,
        causeMessage: causeObj?.message ?? (cause != null ? String(cause) : null),
      })
      return NextResponse.json(
        fallbackFloorPlan(
          [{ name: "Living Area", widthMeters: 4, depthMeters: 4, heightMeters: 2.7 }],
          {
            totalWidthMeters: 4,
            totalDepthMeters: 4,
            totalAreaSqMeters: 16,
            notes: "Could not reach analysis API (network). Using defaults; edit dimensions before generating.",
          },
          true
        )
      )
    }

    const responseText = await res.text()

    if (!res.ok) {
      console.error("[analyze-floorplan] OpenAI HTTP error", {
        status: res.status,
        statusText: res.statusText,
        bodyPrefix: responseText.slice(0, 500),
      })
      return NextResponse.json(
        fallbackFloorPlan(
          [{ name: "Living Area", widthMeters: 4, depthMeters: 4, heightMeters: 2.7 }],
          {
            totalWidthMeters: 4,
            totalDepthMeters: 4,
            totalAreaSqMeters: 16,
            notes: `Analysis API error (${res.status}). Using defaults; edit dimensions before generating.`,
          },
          true
        )
      )
    }

    let data: { choices?: Array<{ message?: { content?: string } }> }
    try {
      data = JSON.parse(responseText) as { choices?: Array<{ message?: { content?: string } }> }
    } catch {
      console.error("[analyze-floorplan] OpenAI response JSON parse failed", {
        textPrefix: responseText.slice(0, 500),
      })
      return NextResponse.json(
        fallbackFloorPlan(
          [{ name: "Living Area", widthMeters: 4, depthMeters: 4, heightMeters: 2.7 }],
          {
            totalWidthMeters: 4,
            totalDepthMeters: 4,
            totalAreaSqMeters: 16,
            notes: "Invalid response from analysis API. Using defaults.",
          },
          true
        )
      )
    }

    const raw = data.choices?.[0]?.message?.content
    if (!raw) {
      return NextResponse.json(
        fallbackFloorPlan(
          [{ name: "Living Area", widthMeters: 4, depthMeters: 4, heightMeters: 2.7 }],
          {
            totalWidthMeters: 4,
            totalDepthMeters: 4,
            totalAreaSqMeters: 16,
            notes: "Empty model response. Using defaults.",
          },
          true
        )
      )
    }

    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>
    } catch {
      console.error("[analyze-floorplan] Invalid JSON:", raw.slice(0, 300))
      return NextResponse.json(
        fallbackFloorPlan(
          [{ name: "Living Area", widthMeters: 4, depthMeters: 4, heightMeters: 2.7 }],
          {
            totalWidthMeters: 4,
            totalDepthMeters: 4,
            totalAreaSqMeters: 16,
            notes: "Could not parse AI JSON. Using defaults.",
          },
          true
        )
      )
    }

    const modelRawVertices = countRawModelFootprintVertices(parsed)
    const { floorPlan, interiorWallStats, usedFallbackRectangle } = mergeAnalysis(
      parsed,
      "Analyzed from uploaded floor plan."
    )
    const footprintDbg = footprintDebugAfterMerge(
      floorPlan,
      modelRawVertices,
      interiorWallStats,
      usedFallbackRectangle
    )
    floorPlan._debugFloorplanGeometry = footprintDbg

    // TEMPORARY: if we detect many rooms but the model only returned a quad footprint, footprint may be a loose bbox.
    const COMPLEX_UNIT_ROOM_THRESHOLD = 4
    if (
      floorPlan.geometry &&
      !footprintDbg.usedFallbackRectangle &&
      modelRawVertices === 4 &&
      floorPlan.rooms.length >= COMPLEX_UNIT_ROOM_THRESHOLD
    ) {
      const prev = floorPlan.geometry.confidence ?? 0.75
      floorPlan.geometry.confidence = Math.min(prev, 0.42)
      console.warn("[analyze-floorplan] footprint sanity: many rooms but model footprint is only 4 vertices — capped confidence", {
        roomCount: floorPlan.rooms.length,
        modelRawFootprintVertexCount: modelRawVertices,
        confidence: floorPlan.geometry.confidence,
      })
    }

    console.log("[analyze-floorplan] footprint geometry (debug)", {
      footprintPointCount: footprintDbg.footprintPointCount,
      geometryType: footprintDbg.geometryType,
      usedFallbackRectangle: footprintDbg.usedFallbackRectangle,
      modelRawFootprintVertexCount: footprintDbg.modelRawFootprintVertexCount,
      modelReturnedExactlyFourFootprintPoints: footprintDbg.modelReturnedExactlyFourFootprintPoints,
      interiorWalls: footprintDbg.interiorWalls,
    })

    // Do not copy footprint AABB width/depth onto any `rooms[i]`: the outer polygon often
    // spans the whole unit, while each room has its own model-extracted dimensions. Overwriting
    // rooms[0] made the first card show entire-floor size (e.g. ~3000 sq ft “Primary Bedroom”).
    // Unit-level totals stay as returned by mergeAnalysis from the model (totalWidthMeters, etc.).

    return NextResponse.json({ floorPlan })
  } catch (e) {
    console.error("[analyze-floorplan]", e)
    return NextResponse.json(
      fallbackFloorPlan(
        [{ name: "Living Area", widthMeters: 4, depthMeters: 4, heightMeters: 2.7 }],
        {
          totalWidthMeters: 4,
          totalDepthMeters: 4,
          totalAreaSqMeters: 16,
          notes: "Unexpected error during analysis. Using defaults.",
        },
        true
      )
    )
  }
}
