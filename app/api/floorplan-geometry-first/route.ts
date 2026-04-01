import { Buffer } from "node:buffer"
import { NextResponse } from "next/server"
import { buildGeometryFirstDebugPayload } from "@/lib/geometryFirst/debugPayload"
import { runGeometryFirstExtraction } from "@/lib/geometryFirst/extractPlanPrimitives"
import type { WallCandidateAngleMode } from "@/lib/geometryFirst/linePrimitiveDenoise"

export const maxDuration = 60

function decodePdfBase64(dataUrlOrB64: string): Uint8Array | null {
  const s = dataUrlOrB64.trim()
  const comma = s.indexOf(",")
  const payload = comma >= 0 && s.startsWith("data:") ? s.slice(comma + 1) : s
  try {
    const buf = Buffer.from(payload, "base64")
    if (buf.length === 0) return null
    return new Uint8Array(buf)
  } catch {
    return null
  }
}

/**
 * Geometry-first extraction (PDF text + page bounds; vector strokes later).
 * Parallel to POST /api/analyze-floorplan (model-first). Clients can call both and merge.
 *
 * Body: {
 *   pdfBase64?: string (data URL or raw base64),
 *   imagePageCount?: number,
 *   debug?: {
 *     angleToleranceDeg?: number,
 *     rawLineSampleLimit?: number,
 *     wallCandidateSampleLimit?: number,
 *     wallCandidateMinLengthPdfUnits?: number (PDF units, default 3),
 *     wallCandidateAngleMode?: "none" | "hv" | "hv45" (default "hv")
 *   }
 * }
 */
export async function POST(req: Request) {
  let body: {
    pdfBase64?: string
    imagePageCount?: number
    debug?: {
      angleToleranceDeg?: number
      rawLineSampleLimit?: number
      wallCandidateSampleLimit?: number
      wallCandidateMinLengthPdfUnits?: number
      wallCandidateAngleMode?: WallCandidateAngleMode
    }
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 })
  }

  let pdfBytes: Uint8Array | null = null
  if (typeof body.pdfBase64 === "string" && body.pdfBase64.length > 0) {
    const decoded = decodePdfBase64(body.pdfBase64)
    if (!decoded?.length) {
      return NextResponse.json({ error: "Invalid pdfBase64 payload." }, { status: 400 })
    }
    pdfBytes = decoded
  }

  const imagePageCount = typeof body.imagePageCount === "number" ? body.imagePageCount : undefined

  const result = await runGeometryFirstExtraction({ pdfBytes, imagePageCount })
  result._debugGeometryFirst = buildGeometryFirstDebugPayload(result.primitives, body.debug)
  return NextResponse.json(result)
}
