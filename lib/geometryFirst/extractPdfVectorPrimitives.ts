/**
 * PDF-side extraction: page bounds, text runs (`getTextContent`), stroked paths (`getOperatorList` → `OPS.constructPath`).
 *
 * Operator-list segment coordinates are in **PDF user space** (same space pdf.js uses before applying the page viewport).
 * `pageBounds` come from `getViewport({ scale: 1 })` — **viewport / display space**. We normalize lines and text into
 * viewport space with `convertToViewportPoint` so geometry matches `pageBounds` (fixes huge outside-page-margin outliers).
 */

import {
  extractStrokedLineSegmentsFromOperatorList,
  pdfJsOpsFnNameLookup,
  type PdfOperatorLineExtractorTrace,
  type PdfOperatorLineSegmentSample,
} from "@/lib/geometryFirst/pdfOperatorLineExtractor"
import { ensurePdfJsCanvasGlobals, type PdfJsGlobalsStatus } from "@/lib/geometryFirst/pdfJsNodePolyfills"
import type {
  ExtractedLineSegment,
  ExtractedPlanPrimitives,
  ExtractedTextRun,
  PdfPageCoordinateNormalizationDebug,
  PlanBoundingBox,
  PdfVectorExtractionRuntime,
} from "@/lib/geometryFirst/types"

const MAX_PAGES = 3

/** Margin (pt) for “inside page” sanity check logging. */
const INSIDE_PAGE_MARGIN_PT = 48

function unionBoxes2(a: PlanBoundingBox | null, b: PlanBoundingBox): PlanBoundingBox | null {
  if (a == null) return { ...b }
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  }
}

function bboxFromSegments(segments: ExtractedLineSegment[]): PlanBoundingBox | null {
  if (segments.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const s of segments) {
    minX = Math.min(minX, s.x1, s.x2)
    minY = Math.min(minY, s.y1, s.y2)
    maxX = Math.max(maxX, s.x1, s.x2)
    maxY = Math.max(maxY, s.y1, s.y2)
  }
  if (!Number.isFinite(minX)) return null
  return { minX, minY, maxX, maxY }
}

/** Baseline-oriented text rect in the same convention as `expandedTextRect` (y = baseline). */
function bboxFromTextRuns(texts: ExtractedTextRun[]): PlanBoundingBox | null {
  if (texts.length === 0) return null
  let u: PlanBoundingBox | null = null
  for (const t of texts) {
    const w = t.width ?? Math.max(6, t.text.length * 4.5)
    const h = t.height ?? 11
    const b: PlanBoundingBox = {
      minX: t.x,
      minY: t.y - h,
      maxX: t.x + w,
      maxY: t.y,
    }
    u = unionBoxes2(u, b)
  }
  return u
}

function normalizeSegmentsToViewport(
  segments: ExtractedLineSegment[],
  viewport: { convertToViewportPoint: (x: number, y: number) => number[] }
): ExtractedLineSegment[] {
  return segments.map((s) => {
    const [x1, y1] = viewport.convertToViewportPoint(s.x1, s.y1)
    const [x2, y2] = viewport.convertToViewportPoint(s.x2, s.y2)
    return { ...s, x1, y1, x2, y2 }
  })
}

function normalizeTextRunsToViewport(
  texts: ExtractedTextRun[],
  viewport: { convertToViewportPoint: (x: number, y: number) => number[]; transform: number[] }
): ExtractedTextRun[] {
  const sx = Math.hypot(viewport.transform[0], viewport.transform[1])
  const sy = Math.hypot(viewport.transform[2], viewport.transform[3])
  return texts.map((t) => {
    const [nx, ny] = viewport.convertToViewportPoint(t.x, t.y)
    return {
      ...t,
      x: nx,
      y: ny,
      width: t.width !== undefined ? Math.abs(t.width * sx) : undefined,
      height: t.height !== undefined ? Math.abs(t.height * sy) : undefined,
    }
  })
}

function fractionSegmentsMidInsideExpandedPage(
  segments: ExtractedLineSegment[],
  pageBounds: PlanBoundingBox,
  margin: number
): number {
  if (segments.length === 0) return 1
  const minX = pageBounds.minX - margin
  const maxX = pageBounds.maxX + margin
  const minY = pageBounds.minY - margin
  const maxY = pageBounds.maxY + margin
  let inside = 0
  for (const s of segments) {
    const mx = (s.x1 + s.x2) / 2
    const my = (s.y1 + s.y2) / 2
    if (mx >= minX && mx <= maxX && my >= minY && my <= maxY) inside++
  }
  return inside / segments.length
}

function fmtBbox(b: PlanBoundingBox | null): string {
  if (b == null) return "—"
  return `${b.minX.toFixed(1)},${b.minY.toFixed(1)}–${b.maxX.toFixed(1)},${b.maxY.toFixed(1)}`
}

/** Nearest text run in PDF user space for operator-trace line vs text comparison. */
function nearestTextRunToPdfPoint(
  texts: ExtractedTextRun[],
  mx: number,
  my: number,
  toVp: (x: number, y: number) => number[]
): PdfOperatorLineSegmentSample["nearestTextPdfUser"] {
  let best: { t: ExtractedTextRun; dist: number } | null = null
  for (const t of texts) {
    const d = Math.hypot(t.x - mx, t.y - my)
    if (!best || d < best.dist) best = { t, dist: d }
  }
  if (!best) return undefined
  const [sx, sy] = toVp(mx, my)
  const [tx, ty] = toVp(best.t.x, best.t.y)
  return {
    text: best.t.text,
    x: best.t.x,
    y: best.t.y,
    distToSegmentMidPdf: best.dist,
    viewport: { x: tx, y: ty, distToSegmentMidViewport: Math.hypot(tx - sx, ty - sy) },
  }
}

export async function extractPdfVectorPrimitives(pdfBytes: Uint8Array): Promise<{
  primitives: ExtractedPlanPrimitives[]
  runtime: PdfVectorExtractionRuntime
}> {
  const globals = ensurePdfJsCanvasGlobals()
  if (!globals.ok) {
    throw new Error(
      `PDF server globals: DOMMatrix/Path2D not available (${globals.detail}). Install: pnpm add @napi-rs/canvas`
    )
  }

  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs")
  const { getDocument, OPS, Util, AnnotationMode } = pdfjs

  const loadingTask = getDocument({
    data: pdfBytes,
    disableWorker: true,
    useSystemFonts: true,
    isEvalSupported: false,
  } as Parameters<typeof getDocument>[0])
  const pdf = await loadingTask.promise
  const pageCount = Math.min(pdf.numPages, MAX_PAGES)
  const out: ExtractedPlanPrimitives[] = []
  let operatorListPagesOk = 0
  let textContentPagesOk = 0

  for (let i = 1; i <= pageCount; i++) {
    const page = await pdf.getPage(i)
    const viewport = page.getViewport({ scale: 1 })
    const pageBounds: PlanBoundingBox = {
      minX: 0,
      minY: 0,
      maxX: viewport.width,
      maxY: viewport.height,
    }

    let lines: ExtractedLineSegment[] = []
    let operatorListLinesTruncated = false
    const tracePageIndex = Number(process.env.GEOMETRY_FIRST_PDF_OPERATOR_TRACE_PAGE ?? "0")

    const textsRaw: ExtractedTextRun[] = []
    try {
      const textContent = await page.getTextContent()
      for (const item of textContent.items) {
        if (!("str" in item) || typeof item.str !== "string" || !item.str.trim()) continue
        const m = item.transform
        if (!Array.isArray(m) || m.length < 6) continue
        const x = m[4]!
        const y = m[5]!
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue
        textsRaw.push({
          text: item.str,
          x,
          y,
          pageIndex: i - 1,
          width: typeof item.width === "number" ? item.width : undefined,
          height: typeof item.height === "number" ? item.height : undefined,
        })
      }
      textContentPagesOk++
    } catch {
      /* scanned or malformed text streams — still emit page shell */
    }

    try {
      const opList = await page.getOperatorList({
        annotationMode: AnnotationMode.ENABLE,
      })
      const opsFnName = pdfJsOpsFnNameLookup(OPS as Record<string, number>)
      const operatorTrace: PdfOperatorLineExtractorTrace | undefined =
        process.env.GEOMETRY_FIRST_PDF_OPERATOR_TRACE === "1" && i - 1 === tracePageIndex
          ? {
              maxSegmentSamples: Math.min(
                50,
                Math.max(1, Number(process.env.GEOMETRY_FIRST_PDF_OPERATOR_TRACE_SAMPLES ?? "5") || 5)
              ),
              fnNameFor: (fn) => opsFnName.get(fn) ?? `fn_${fn}`,
              convertToViewportPoint: (x, y) => viewport.convertToViewportPoint(x, y),
              onSegmentSample: (sample) => {
                const mx = (sample.pdfUserSpace.x1 + sample.pdfUserSpace.x2) / 2
                const my = (sample.pdfUserSpace.y1 + sample.pdfUserSpace.y2) / 2
                if (textsRaw.length > 0) {
                  sample.nearestTextPdfUser = nearestTextRunToPdfPoint(
                    textsRaw,
                    mx,
                    my,
                    viewport.convertToViewportPoint.bind(viewport)
                  )
                }
                console.log(`[pdf-operator-trace] page ${i - 1} segment`, JSON.stringify(sample, null, 2))
              },
              onComplete: (stats) => {
                console.log(
                  `[pdf-operator-trace] page ${i - 1} diagnostics`,
                  JSON.stringify(
                    {
                      stats,
                      nestingLegend: {
                        saveDepth: "PDF q / Q only",
                        formDepth: "paintFormXObjectBegin / End",
                        annotationDepth: "beginAnnotation / endAnnotation",
                      },
                      lineSpaceNote:
                        "compare pdfUserSpace vs texts’ raw PDF coords; viewportSpace should land near pageBounds when CTM matches text.",
                      annotationCtmNote:
                        "beginAnnotation clears the graphics stack in pdf.js (#restoreInitialState) before transform×matrix — appearance CTM is identity×T×M, not (running page CTM)×T×M.",
                      formCtmNote:
                        "Form strokes use parent CTM × Form Matrix × form-local operands (paintFormXObjectBegin).",
                      balanceNote:
                        "If stats.balance.stackEntries !== 0 or depths ≠ 0 at EOF, save/form/annotation pops are out of sync with pdf.js (CTM drift).",
                      recentPdfCmVsFullCtmNote:
                        "recentPdfCmOps only lists the last few OPS.transform (cm) ops. Full ctmUsedForSegment also includes paintFormXObjectBegin and beginAnnotation composition, and q/Q stacks around them.",
                      compareAnnotEnv:
                        "Set GEOMETRY_FIRST_PDF_COMPARE_ANNOT_MODE=1 to log pdfUser line bboxes for DISABLE & ENABLE_FORMS vs this run’s ENABLE.",
                    },
                    null,
                    2
                  )
                )
              },
            }
          : undefined

      const { segments, truncated } = extractStrokedLineSegmentsFromOperatorList(
        opList.fnArray,
        opList.argsArray,
        OPS,
        Util.transform.bind(Util) as (m1: number[], m2: number[]) => number[],
        operatorTrace
      )
      lines = segments
      operatorListLinesTruncated = truncated
      operatorListPagesOk++

      if (process.env.GEOMETRY_FIRST_PDF_COMPARE_ANNOT_MODE === "1" && i - 1 === tracePageIndex) {
        const tf = Util.transform.bind(Util) as (m1: number[], m2: number[]) => number[]
        for (const { label, mode } of [
          { label: "DISABLE", mode: AnnotationMode.DISABLE },
          { label: "ENABLE_FORMS", mode: AnnotationMode.ENABLE_FORMS },
        ] as const) {
          const ol = await page.getOperatorList({ annotationMode: mode })
          const { segments: segs } = extractStrokedLineSegmentsFromOperatorList(
            ol.fnArray,
            ol.argsArray,
            OPS,
            tf
          )
          console.log(
            `[pdf-operator-trace] annotMode=${label} page ${i - 1} pdfUserBBox=${fmtBbox(
              bboxFromSegments(segs)
            )} segments=${segs.length}`
          )
        }
      }
    } catch {
      /* scanned / malformed / subset fonts — keep text path */
    }

    const linesBBoxPdfUserSpace = bboxFromSegments(lines)

    const textsBBoxPdfUserSpace = bboxFromTextRuns(textsRaw)

    const linesViewport = normalizeSegmentsToViewport(lines, viewport)
    const textsViewport = normalizeTextRunsToViewport(textsRaw, viewport)

    const linesBBoxViewport = bboxFromSegments(linesViewport)
    const textsBBoxViewport = bboxFromTextRuns(textsViewport)

    const insideFrac = fractionSegmentsMidInsideExpandedPage(
      linesViewport,
      pageBounds,
      INSIDE_PAGE_MARGIN_PT
    )

    const vt = viewport.transform
    const coordinateNormalizationDebug: PdfPageCoordinateNormalizationDebug = {
      viewportTransform: [vt[0]!, vt[1]!, vt[2]!, vt[3]!, vt[4]!, vt[5]!],
      pageBounds: { ...pageBounds },
      linesBBoxPdfUserSpace: linesBBoxPdfUserSpace == null ? null : { ...linesBBoxPdfUserSpace },
      linesBBoxViewport: linesBBoxViewport == null ? null : { ...linesBBoxViewport },
      textsBBoxPdfUserSpace: textsBBoxPdfUserSpace == null ? null : { ...textsBBoxPdfUserSpace },
      textsBBoxViewport: textsBBoxViewport == null ? null : { ...textsBBoxViewport },
      lineSegmentCount: linesViewport.length,
      segmentMidInsidePageExpandedFraction: insideFrac,
    }

    console.log(
      `[pdf-vector] page ${i - 1} pageBounds=${fmtBbox(pageBounds)} linesViewport=${fmtBbox(
        linesBBoxViewport
      )} textsViewport=${fmtBbox(
        textsBBoxViewport
      )} midInsidePage±${INSIDE_PAGE_MARGIN_PT}pt=${(insideFrac * 100).toFixed(1)}% (n=${linesViewport.length}) | pdfUser lines=${fmtBbox(linesBBoxPdfUserSpace)} texts=${fmtBbox(textsBBoxPdfUserSpace)}`
    )

    lines = linesViewport

    let extractionMode: ExtractedPlanPrimitives["extractionMode"]
    if (textsViewport.length > 0 && lines.length > 0) extractionMode = "pdf-text-and-strokes"
    else if (textsViewport.length > 0) extractionMode = "pdf-text-only"
    else if (lines.length > 0) extractionMode = "pdf-strokes-only"
    else extractionMode = "pdf-vector-stub"

    out.push({
      pageIndex: i - 1,
      pageBounds,
      lines,
      texts: textsViewport,
      operatorListLinesTruncated: operatorListLinesTruncated || undefined,
      extractionMode,
      coordinateNormalizationDebug,
    })
  }

  let runtimeGlobals: PdfVectorExtractionRuntime["globals"]
  if (globals.ok) {
    runtimeGlobals = { ok: true, source: globals.source }
  } else {
    const failed = globals as Extract<PdfJsGlobalsStatus, { ok: false }>
    runtimeGlobals = { ok: false, source: failed.source, detail: failed.detail }
  }

  const runtime: PdfVectorExtractionRuntime = {
    globals: runtimeGlobals,
    operatorListPagesOk,
    textContentPagesOk,
  }

  return { primitives: out, runtime }
}
