/**
 * PDF-side extraction: page bounds, text runs (`getTextContent`), stroked paths (`getOperatorList` → `OPS.constructPath`).
 */

import { extractStrokedLineSegmentsFromOperatorList } from "@/lib/geometryFirst/pdfOperatorLineExtractor"
import { ensurePdfJsCanvasGlobals } from "@/lib/geometryFirst/pdfJsNodePolyfills"
import type {
  ExtractedLineSegment,
  ExtractedPlanPrimitives,
  ExtractedTextRun,
  PlanBoundingBox,
  PdfVectorExtractionRuntime,
} from "@/lib/geometryFirst/types"

const MAX_PAGES = 3

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
  })
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

    try {
      const opList = await page.getOperatorList({
        annotationMode: AnnotationMode.ENABLE,
      })
      const { segments, truncated } = extractStrokedLineSegmentsFromOperatorList(
        opList.fnArray,
        opList.argsArray,
        OPS,
        Util.transform.bind(Util) as (m1: number[], m2: number[]) => number[]
      )
      lines = segments
      operatorListLinesTruncated = truncated
      operatorListPagesOk++
    } catch {
      /* scanned / malformed / subset fonts — keep text path */
    }

    const texts: ExtractedTextRun[] = []

    try {
      const textContent = await page.getTextContent()
      for (const item of textContent.items) {
        const s = item.str
        if (typeof s !== "string" || !s.trim()) continue
        const m = item.transform
        if (!Array.isArray(m) || m.length < 6) continue
        const x = m[4]
        const y = m[5]
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue
        texts.push({
          text: s,
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

    let extractionMode: ExtractedPlanPrimitives["extractionMode"]
    if (texts.length > 0 && lines.length > 0) extractionMode = "pdf-text-and-strokes"
    else if (texts.length > 0) extractionMode = "pdf-text-only"
    else if (lines.length > 0) extractionMode = "pdf-strokes-only"
    else extractionMode = "pdf-vector-stub"

    out.push({
      pageIndex: i - 1,
      pageBounds,
      lines,
      texts,
      operatorListLinesTruncated: operatorListLinesTruncated || undefined,
      extractionMode,
    })
  }

  const runtime: PdfVectorExtractionRuntime = {
    globals: globals.ok
      ? { ok: true, source: globals.source }
      : { ok: false, source: globals.source, detail: globals.detail },
    operatorListPagesOk,
    textContentPagesOk,
  }

  return { primitives: out, runtime }
}
