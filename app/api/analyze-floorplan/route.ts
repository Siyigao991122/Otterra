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
import { isValidFootprintPolygon, polygonAABB, rectangleFootprintFromAABB } from "@/lib/floorplanGeometry"

export const maxDuration = 90

/** Chat Completions vision model (logged for debugging). */
const OPENAI_VISION_MODEL = "gpt-5.5"

export type ScaleDetectionMethod = "dimension_line" | "ratio" | "scale_bar" | "failed"

export interface ScaleDetectionResult {
  method: ScaleDetectionMethod
  totalWidthMeters: number
  totalDepthMeters: number
  confidence: number
  notes: string
}

const SCALE_DETECTION_PROMPT = `You are analyzing a floor plan image to extract its real-world scale.

Look carefully for ANY of these:
1. Dimension lines with numbers (e.g. "3800", "12'-6\"", "3.8m", "15 ft")
2. Scale ratios printed on the plan (e.g. "1:100", "1/4\" = 1'-0\"", "Scale 1:50")
3. Scale bars (a graphic bar labeled with a length)

From whatever you find, estimate the TOTAL real-world width and height of the entire drawn floor plan area in meters.

Return ONLY a JSON object:
{
  "method": "dimension_line" | "ratio" | "scale_bar" | "failed",
  "totalWidthMeters": <number>,
  "totalDepthMeters": <number>,
  "confidence": <0.0 to 1.0>,
  "notes": "<brief description of what you found>"
}

Unit conversion rules:
- millimeters: divide by 1000
- centimeters: divide by 100
- feet: multiply by 0.3048
- inches: multiply by 0.0254
- "1:100" scale means 1 drawing unit = 100 real units (so 1mm on paper = 100mm real)

Use "failed" only if there are absolutely no scale references visible anywhere on the image.`

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
        const dimensionText = typeof o.dimensionText === "string" && o.dimensionText.trim()
          ? o.dimensionText.trim()
          : undefined
        const dimensionsFromOCR = o.dimensionsFromOCR === true
        const cx = Number.isFinite(Number(o.cx)) ? Number(o.cx) : undefined
        const cy = Number.isFinite(Number(o.cy)) ? Number(o.cy) : undefined
        const x1 = Number.isFinite(Number(o.x1)) ? Number(o.x1) : undefined
        const y1 = Number.isFinite(Number(o.y1)) ? Number(o.y1) : undefined
        const x2 = Number.isFinite(Number(o.x2)) ? Number(o.x2) : undefined
        const y2 = Number.isFinite(Number(o.y2)) ? Number(o.y2) : undefined
        return {
          name: typeof o.name === "string" ? o.name : `Room ${i + 1}`,
          widthMeters: Number(o.widthMeters) || 4,
          depthMeters: Number(o.depthMeters) || 4,
          heightMeters: Number(o.heightMeters) || 2.7,
          ...(cx != null ? { cx } : {}),
          ...(cy != null ? { cy } : {}),
          ...(x1 != null ? { x1 } : {}),
          ...(y1 != null ? { y1 } : {}),
          ...(x2 != null ? { x2 } : {}),
          ...(y2 != null ? { y2 } : {}),
          ...(dimensionText ? { dimensionText } : {}),
          ...(dimensionsFromOCR ? { dimensionsFromOCR } : {}),
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

const VISION_SYSTEM = `You are an architectural assistant extracting the geometry of a floor plan image.

Use NORMALIZED coordinates: x=0.0 is the LEFT edge of the image, x=1.0 is the RIGHT edge, y=0.0 is the TOP edge, y=1.0 is the BOTTOM edge. All polygon and wall coordinates must be in this 0.0–1.0 range.

Return a single JSON object with:
- rooms: array of { name, widthMeters, depthMeters, heightMeters, cx, cy, x1, y1, x2, y2, dimensionText?, dimensionsFromOCR? }
  * name: READ the text label printed inside each room on the floor plan (e.g. "BEDROOM", "BATH", "LIVING ROOM", "KITCHEN", "DINING ROOM", "DEN", "CLOSET", "LAUNDRY"). Use that exact label as the name. NEVER merge all rooms into a single entry.
  * CRITICAL: List EVERY separately enclosed room space — a 2-bedroom apartment must have entries for Bedroom 1, Bedroom 2, Bathroom, Living Room, Kitchen, etc. A typical apartment has 5–9 rooms.
  * widthMeters, depthMeters, heightMeters: real dimensions in meters
  * cx, cy: NORMALIZED 0–1 centre of this room on the image
  * x1, y1: NORMALIZED 0–1 top-left corner of this room's bounding box
  * x2, y2: NORMALIZED 0–1 bottom-right corner of this room's bounding box
  * dimensionText: the EXACT dimension text printed on the plan for this room, e.g. "14'6\" × 20'5\"" or "4.2m × 3.8m". Leave out if no text found.
  * dimensionsFromOCR: true if dimensionText was read from the plan, false if you estimated visually.
  * PRIORITY: If you can read dimension text on the plan (e.g. "12'-2\" × 12'-2\""), use those values — they are more accurate than visual estimates. Convert feet/inches to meters (1ft = 0.3048m).
- totalWidthMeters, totalDepthMeters, totalAreaSqMeters — your best estimate of the whole unit in meters.
- notes: short summary.
- footprintPolygon: array of {x, y} vertices (normalized 0–1) tracing the OUTER EXTERIOR boundary of the full unit. Rules:
  * Follow the true outer wall shell — not interior partitions, not a bounding box.
  * NEVER output just 4 corners unless the floor plan is literally a perfect rectangle with zero notches.
  * Capture every L-shape, bay, recess, jog, setback along the exterior (aim for 6–20 vertices for a typical apartment).
  * Order counter-clockwise. Do not repeat the first point at the end.
- interiorWalls: array of { id?, x1, y1, x2, y2, thickness? } — MAJOR partition walls only (not furniture, not cabinets). All coordinates normalized 0–1. thickness in meters (default ~0.12 if unknown).
- confidence: 0–1 how confident you are in the geometry.`

async function detectFloorplanScale(imageUrl: string, apiKey: string): Promise<ScaleDetectionResult> {
  const fallback: ScaleDetectionResult = {
    method: "failed",
    totalWidthMeters: 0,
    totalDepthMeters: 0,
    confidence: 0,
    notes: "Scale detection failed or not attempted",
  }
  try {
    const payload = JSON.stringify({
      model: OPENAI_VISION_MODEL,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: SCALE_DETECTION_PROMPT },
            { type: "image_url", image_url: { url: imageUrl } },
          ],
        },
      ],
      response_format: { type: "json_object" },
      max_completion_tokens: 512,
    })
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: payload,
    })
    if (!res.ok) return fallback
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
    const raw = data.choices?.[0]?.message?.content
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as Partial<ScaleDetectionResult>
    const method = parsed.method ?? "failed"
    const w = Number(parsed.totalWidthMeters)
    const d = Number(parsed.totalDepthMeters)
    if (method === "failed" || !Number.isFinite(w) || w <= 0 || !Number.isFinite(d) || d <= 0) {
      return { ...fallback, method: "failed", notes: parsed.notes ?? fallback.notes }
    }
    return {
      method,
      totalWidthMeters: w,
      totalDepthMeters: d,
      confidence: Number.isFinite(Number(parsed.confidence)) ? Number(parsed.confidence) : 0.5,
      notes: parsed.notes ?? "",
    }
  } catch {
    return fallback
  }
}

/** Detect whether GPT-4o returned normalized 0–1 coords or metric coords directly. */
function isNormalizedPolygon(points: unknown[]): boolean {
  let maxVal = 0
  for (const p of points) {
    if (!p || typeof p !== "object") continue
    const o = p as Record<string, unknown>
    maxVal = Math.max(maxVal, Math.abs(Number(o.x) || 0), Math.abs(Number(o.y) || 0))
  }
  return maxVal <= 1.5
}

/** Multiply normalized 0–1 coords by real-world dimensions to get metres; pass through if model already returned metric coords. */
function applyScaleToNormalizedGeometry(
  parsed: Record<string, unknown>,
  totalWidthMeters: number,
  totalDepthMeters: number
): Record<string, unknown> {
  const polygon = Array.isArray(parsed.footprintPolygon) ? parsed.footprintPolygon : null
  const walls = Array.isArray(parsed.interiorWalls) ? parsed.interiorWalls : null

  if (!polygon || !isNormalizedPolygon(polygon)) {
    console.log("[analyze-floorplan] model returned metric coords — skipping normalization multiply")
    return {
      ...parsed,
      footprintPolygonMeters: polygon ?? parsed.footprintPolygonMeters,
      interiorWallsMeters: walls ?? parsed.interiorWallsMeters,
    }
  }

  const scalePoint = (p: unknown): unknown => {
    if (!p || typeof p !== "object") return p
    const o = p as Record<string, unknown>
    return { ...o, x: Number(o.x) * totalWidthMeters, y: Number(o.y) * totalDepthMeters }
  }
  const scaleSegment = (s: unknown): unknown => {
    if (!s || typeof s !== "object") return s
    const o = s as Record<string, unknown>
    return {
      ...o,
      x1: Number(o.x1) * totalWidthMeters,
      y1: Number(o.y1) * totalDepthMeters,
      x2: Number(o.x2) * totalWidthMeters,
      y2: Number(o.y2) * totalDepthMeters,
    }
  }
  return {
    ...parsed,
    footprintPolygonMeters: polygon.map(scalePoint),
    interiorWallsMeters: walls ? walls.map(scaleSegment) : parsed.interiorWallsMeters,
  }
}

export async function POST(req: Request) {
  let body: { images?: string[]; pdfBase64?: string; sourceFileName?: string }
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
  const pdfBase64 = typeof body.pdfBase64 === "string" && body.pdfBase64.trim() ? body.pdfBase64.trim() : null
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
      max_completion_tokens: 4096,
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

  const imageMeta = describeImageInput(imageUrlForOpenAI)
  const payloadJson = buildOpenAiPayloadJson(imageUrlForOpenAI)

  // Run scale detection in parallel with geometry extraction
  const scaleDetectionPromise = detectFloorplanScale(imageUrlForOpenAI, apiKey)

  console.log("[analyze-floorplan] starting parallel scale detection + geometry extraction", {
    model: OPENAI_VISION_MODEL,
    imageSourceType: imageMeta.sourceType,
  })

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

    // Wait for scale detection result (runs in parallel with the above fetch)
    const scaleResult = await scaleDetectionPromise

    // Convert normalized 0–1 polygon coords → real meters using detected scale.
    // Fall back to GPT-4o's own totalWidth/Depth estimate when scale detection failed.
    const effectiveWidth =
      scaleResult.method !== "failed" && scaleResult.confidence >= 0.5
        ? scaleResult.totalWidthMeters
        : Number(parsed.totalWidthMeters) || 6
    const effectiveDepth =
      scaleResult.method !== "failed" && scaleResult.confidence >= 0.5
        ? scaleResult.totalDepthMeters
        : Number(parsed.totalDepthMeters) || 6

    const scaledParsed = applyScaleToNormalizedGeometry(parsed, effectiveWidth, effectiveDepth)

    const modelRawVertices = countRawModelFootprintVertices(scaledParsed)
    const { floorPlan, interiorWallStats, usedFallbackRectangle } = mergeAnalysis(
      scaledParsed,
      "Analyzed from uploaded floor plan."
    )

    // Override totals with scale detection when available
    if (scaleResult.method !== "failed" && scaleResult.confidence >= 0.5) {
      floorPlan.totalWidthMeters = effectiveWidth
      floorPlan.totalDepthMeters = effectiveDepth
      floorPlan.totalAreaSqMeters = effectiveWidth * effectiveDepth
    }

    const footprintDbg = footprintDebugAfterMerge(
      floorPlan,
      modelRawVertices,
      interiorWallStats,
      usedFallbackRectangle
    )
    floorPlan._debugFloorplanGeometry = footprintDbg

    console.log("[analyze-floorplan] scale detection + geometry result", {
      scaleMethod: scaleResult.method,
      scaleConfidence: scaleResult.confidence,
      scaleNotes: scaleResult.notes,
      effectiveWidth,
      effectiveDepth,
      footprintPointCount: footprintDbg.footprintPointCount,
      geometryType: footprintDbg.geometryType,
      usedFallbackRectangle: footprintDbg.usedFallbackRectangle,
      footprintSample: floorPlan.geometry?.footprintPolygon?.slice(0, 4),
    })

    return NextResponse.json({
      floorPlan,
      scaleDetection: scaleResult,
    })
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
