/**
 * Lightweight floor plan preflight retained for the active frontend upload flow.
 * This version is intentionally decoupled from the archived geometry-first stack.
 */

export type FloorplanInputKind = "pdf" | "image" | "unknown"
export type ReadinessTier = "high" | "medium" | "low"
export type FloorplanRecommendedMode = "AI-assisted" | "preview-only"
export type MultiFloorLikelihood = "single" | "possible-multi" | "likely-multi"

export interface FloorplanPreflightSignals {
  inputType: FloorplanInputKind
  pageCountTotal?: number
  pageCountAnalyzed: number
  extractionModesPerPage: string[]
  textRunCount: number
  lineSegmentCountRaw: number
  operatorListPagesOk: number
  textContentPagesOk: number
  anyPageLinesTruncated: boolean
  cleanedWallSegmentCount: number
  wallGraphNodeCount: number
  wallGraphConnectedComponents: number
  wallGraphDanglingEndpoints: number
  largestComponentPlausibility?: "high" | "medium" | "low"
  outerCycleUniqueClosed?: number
  outerCycleClosed?: boolean
  outerCycleSupportFraction?: number
  dimensionEvidenceScore: number
  multiFloorLikelihood: MultiFloorLikelihood
  textRunsPerAnalyzedPage: number
  rawLinesPerAnalyzedPage: number
  cleanedWallsPerAnalyzedPage: number
}

export interface FloorplanPreflightResult {
  readinessScore: number
  readinessTier: ReadinessTier
  geometryFirstSuitability: ReadinessTier
  precisionSuitability: ReadinessTier
  risks: string[]
  recommendedMode: FloorplanRecommendedMode
  signals: FloorplanPreflightSignals
  summary: string
  logLine: string
}

export interface FloorplanPreflightOptions {
  log?: boolean
  logLabel?: string
}

export interface PreflightAugmentFromAnalyze {
  usedFallbackRectangle: boolean
  floorplanConfidence?: number
  modelRawFootprintVertexCount?: number
}

const MULTI_FLOOR_PATTERNS =
  /\b(floor|fl\.?|level|lvl|storey|story|penthouse|basement|mezzanine|upper|lower|ground)\b|\b(l|g|p|b)\d\b|\blevel\s*\d+/i

function tierFromScore(s: number): ReadinessTier {
  if (s >= 0.66) return "high"
  if (s >= 0.35) return "medium"
  return "low"
}

function inferMultiFloor(pageCountTotal: number | undefined): MultiFloorLikelihood {
  const t = pageCountTotal ?? 1
  if (t >= 3) return "likely-multi"
  if (t >= 2) return "possible-multi"
  return "single"
}

async function getPdfTotalPageCount(pdfBytes: Uint8Array): Promise<number | undefined> {
  if (typeof window !== "undefined" || !pdfBytes.length) return undefined
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs")
    const { getDocument } = pdfjs
    const loadingTask = getDocument({
      data: new Uint8Array(pdfBytes),
      useSystemFonts: true,
      isEvalSupported: false,
    })
    const pdf = await loadingTask.promise
    return pdf.numPages
  } catch {
    return undefined
  }
}

function buildPlaceholderSignals(inputType: FloorplanInputKind, pageCount: number): FloorplanPreflightSignals {
  const safePages = Math.max(1, pageCount)
  const multiFloorLikelihood =
    inputType === "pdf" ? inferMultiFloor(pageCount) : MULTI_FLOOR_PATTERNS.test("") ? "possible-multi" : "single"
  return {
    inputType,
    pageCountTotal: inputType === "pdf" ? safePages : undefined,
    pageCountAnalyzed: safePages,
    extractionModesPerPage: Array.from({ length: safePages }, () =>
      inputType === "pdf" ? "pdf-browser-preview" : "image-placeholder"
    ),
    textRunCount: 0,
    lineSegmentCountRaw: 0,
    operatorListPagesOk: 0,
    textContentPagesOk: 0,
    anyPageLinesTruncated: false,
    cleanedWallSegmentCount: 0,
    wallGraphNodeCount: 0,
    wallGraphConnectedComponents: 0,
    wallGraphDanglingEndpoints: 0,
    dimensionEvidenceScore: 0,
    multiFloorLikelihood,
    textRunsPerAnalyzedPage: 0,
    rawLinesPerAnalyzedPage: 0,
    cleanedWallsPerAnalyzedPage: 0,
  }
}

function buildPreflightResult(
  inputType: FloorplanInputKind,
  pageCount: number,
  options?: FloorplanPreflightOptions
): FloorplanPreflightResult {
  const signals = buildPlaceholderSignals(inputType, pageCount)
  const risks: string[] = []
  if (inputType === "image") {
    risks.push("Raster/image upload — preflight uses a lightweight placeholder path only.")
  } else if (inputType === "pdf") {
    risks.push("Vector-heavy geometry-first diagnostics are disabled in this simplified app build.")
  }
  if (signals.multiFloorLikelihood !== "single") {
    risks.push("Possible multi-floor document — browser preview path cannot disambiguate floors.")
  }
  const readinessScore = inputType === "pdf" ? 58 : 52
  const geometryFirstSuitability = "low"
  const precisionSuitability = "medium"
  const recommendedMode: FloorplanRecommendedMode = "AI-assisted"
  const readinessTier = tierFromScore(readinessScore / 100)
  const summary =
    inputType === "pdf"
      ? `Input pdf; analyzed ${signals.pageCountAnalyzed} page(s). Lightweight preflight retained; geometry-first diagnostics disabled.`
      : `Input image; analyzed ${signals.pageCountAnalyzed} page(s). Lightweight preflight retained for frontend upload diagnostics.`
  const result: FloorplanPreflightResult = {
    readinessScore,
    readinessTier,
    geometryFirstSuitability,
    precisionSuitability,
    risks,
    recommendedMode,
    signals,
    summary,
    logLine: `preflight score=${readinessScore} tier=${readinessTier} mode=${recommendedMode} input=${inputType}`,
  }
  if (options?.log) {
    preflightLogSummary(result, options.logLabel)
  } else if (process.env.NODE_ENV === "development" && process.env.FLOORPLAN_PREFLIGHT_LOG === "1") {
    preflightLogSummary(result, options?.logLabel)
  }
  return result
}

export async function runFloorplanPreflightFromPdf(
  pdfBytes: Uint8Array,
  options?: FloorplanPreflightOptions
): Promise<FloorplanPreflightResult> {
  const pageCount = (await getPdfTotalPageCount(pdfBytes)) ?? 1
  return buildPreflightResult("pdf", pageCount, options)
}

export async function runFloorplanPreflightFromImagePages(
  imagePageCount: number,
  options?: FloorplanPreflightOptions
): Promise<FloorplanPreflightResult> {
  return buildPreflightResult("image", imagePageCount, options)
}

export function augmentPreflightWithAnalyzeHints(
  base: FloorplanPreflightResult,
  hints: PreflightAugmentFromAnalyze
): FloorplanPreflightResult {
  const risks = [...base.risks]
  let readinessScore = base.readinessScore
  let precisionSuitability = base.precisionSuitability
  if (hints.usedFallbackRectangle) {
    risks.push("AI footprint used rectangle fallback — polygon outline was missing or invalid after sanitize.")
    readinessScore = Math.max(0, readinessScore - 8)
    if (precisionSuitability === "high") precisionSuitability = "medium"
  }
  if (
    hints.floorplanConfidence != null &&
    hints.floorplanConfidence < 0.35 &&
    !risks.some((r) => r.includes("model confidence"))
  ) {
    risks.push("Low stated floorplan geometry confidence from analysis payload.")
    readinessScore = Math.max(0, readinessScore - 5)
  }
  return {
    ...base,
    readinessScore,
    readinessTier: tierFromScore(readinessScore / 100),
    precisionSuitability,
    risks,
    summary: `${base.summary} (augmented: AI fallbackRect=${hints.usedFallbackRectangle}).`,
    logLine: `${base.logLine} aug:fallbackRect=${hints.usedFallbackRectangle}`,
  }
}

export function preflightLogSummary(result: FloorplanPreflightResult, label?: string): void {
  const tag = label ? `[floorplanPreflight:${label}]` : "[floorplanPreflight]"
  console.log(tag, {
    readinessScore: result.readinessScore,
    readinessTier: result.readinessTier,
    recommendedMode: result.recommendedMode,
    geometryFirstSuitability: result.geometryFirstSuitability,
    precisionSuitability: result.precisionSuitability,
    risks: result.risks,
    signals: result.signals,
    summary: result.summary,
  })
}

export function examplePreflightOutputs(): {
  cleanVector: FloorplanPreflightResult
  messyRaster: FloorplanPreflightResult
} {
  return {
    cleanVector: buildPreflightResult("pdf", 1),
    messyRaster: buildPreflightResult("image", 3),
  }
}
