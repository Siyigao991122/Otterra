import { Buffer } from "node:buffer"
import { NextResponse } from "next/server"
import { buildFloorplanAiSemanticHints } from "@/lib/geometryFirst/floorplanAiSemanticHints"
import { buildGeometryFirstDebugPayload } from "@/lib/geometryFirst/debugPayload"
import { runGeometryFirstExtraction } from "@/lib/geometryFirst/extractPlanPrimitives"
import type { WallCandidateAngleMode } from "@/lib/geometryFirst/linePrimitiveDenoise"

export const maxDuration = 120

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
 *     includeMainPlanBody?: boolean (experimental: primary plan bbox + SVG + plan-only reruns + shell candidate + shell loop + boundary v2/v3 + shell regularization + evidence gating + room candidates v0 + room cleanup v1 + room split refinement v2/v3 + room candidate refinement v1 + plan-body text coverage recovery v2 + room text attribution v0 + room text grouping v1 + semantic-guided room partition v1 + proposal topology cleanup v1 + anchor seed localization v1 + hierarchical space typing v1/v2 + unit outer boundary recovery v1 + anchor constrained region growing v2 in _debugGeometryFirst)
 *     includeAiSemanticHints?: boolean (experimental: full-page render + crop-first GPT-4o semantic hints in _debugGeometryFirst.aiSemanticHints)
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
      includeMainPlanBody?: boolean
      includeAiSemanticHints?: boolean
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

  const extractionPdfBytes = pdfBytes ? new Uint8Array(pdfBytes) : null
  const aiPdfBytes = pdfBytes ? new Uint8Array(pdfBytes) : null

  const result = await runGeometryFirstExtraction({ pdfBytes: extractionPdfBytes, imagePageCount })
  let debugPayload = await buildGeometryFirstDebugPayload(result.primitives, {
    ...body.debug,
    pdfBytes: pdfBytes ? new Uint8Array(pdfBytes) : undefined,
  })

  if (body.debug?.includeAiSemanticHints && aiPdfBytes) {
    try {
      const aiSemanticHints = await buildFloorplanAiSemanticHints(aiPdfBytes, {
        pageIndex: 0,
        renderScale: 2,
        maxEdgePx: 1800,
        mainPlanBodyBBox: debugPayload.mainPlanBody?.primaryLayoutBBox ?? null,
        recoveredUnitPolygon: debugPayload.unitOuterBoundaryRecoveryV1?.recoveredUnitPolygon ?? null,
      }) ?? undefined
      if (aiSemanticHints) {
        debugPayload = await buildGeometryFirstDebugPayload(result.primitives, {
          ...body.debug,
          aiSemanticHints,
          pdfBytes: pdfBytes ? new Uint8Array(pdfBytes) : undefined,
        })
        debugPayload.aiSemanticHints = aiSemanticHints
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      debugPayload.interpretationNotes.push(
        `[ai-semantic-hints] failed: ${message}`
      )
    }
  }
  result._debugGeometryFirst = debugPayload
  return NextResponse.json(result)
}
