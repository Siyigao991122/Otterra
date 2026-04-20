/**
 * Floor plan preflight / readiness — diagnostic layer before deep geometry reconstruction.
 * Does not change user-facing flows; call from APIs or scripts when needed.
 */

import type { GeometryFirstExtractionResult, ExtractedPlanPrimitives } from "@/lib/geometryFirst/types"

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/** How the file behaves under PDF.js vector extraction. */
export type FloorplanInputKind = "vector-pdf" | "raster-pdf" | "image" | "unknown"

export type ReadinessTier = "high" | "medium" | "low"

export type FloorplanRecommendedMode =
  | "geometry-first"
  | "AI-assisted"
  | "preview-only"
  | "cleanup-recommended"

export type MultiFloorLikelihood = "single" | "possible-multi" | "likely-multi"

/** Quantitative + categorical signals used for scoring (auditable). */
export interface FloorplanPreflightSignals {
  inputType: FloorplanInputKind
  /** Full PDF page count when `pdfBytes` were parsed; else undefined. */
  pageCountTotal?: number
  /** Pages actually walked for vector stats (PDF: min(3, total) today; image: placeholder pages). */
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
  /** 0..1 heuristic from dimension-like text tokens. */
  dimensionEvidenceScore: number
  multiFloorLikelihood: MultiFloorLikelihood
  /** Rough buckets for logging (runs per analyzed page). */
  textRunsPerAnalyzedPage: number
  rawLinesPerAnalyzedPage: number
  cleanedWallsPerAnalyzedPage: number
}

export interface FloorplanPreflightResult {
  /** 0–100 composite suitability for running pipelines on this upload. */
  readinessScore: number
  readinessTier: ReadinessTier
  geometryFirstSuitability: ReadinessTier
  precisionSuitability: ReadinessTier
  risks: string[]
  recommendedMode: FloorplanRecommendedMode
  signals: FloorplanPreflightSignals
  /** Short paragraph for humans. */
  summary: string
  /** One line for structured logs. */
  logLine: string
}

export interface FloorplanPreflightOptions {
  /** When true, logs a JSON summary to `console` (safe for server scripts). Default false. */
  log?: boolean
  logLabel?: string
}

/** Optional post-merge hints from `/api/analyze-floorplan` (AI path). */
export interface PreflightAugmentFromAnalyze {
  usedFallbackRectangle: boolean
  floorplanConfidence?: number
  modelRawFootprintVertexCount?: number
}

// ---------------------------------------------------------------------------
// PDF helpers
// ---------------------------------------------------------------------------

async function getPdfTotalPageCount(pdfBytes: Uint8Array): Promise<number | undefined> {
  if (typeof window !== "undefined") return undefined
  const { ensurePdfJsCanvasGlobals } = await import("@/lib/geometryFirst/pdfJsNodePolyfills")
  const globals = ensurePdfJsCanvasGlobals()
  if (!globals.ok) return undefined
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs")
    const { getDocument } = pdfjs
    const loadingTask = getDocument({
      data: pdfBytes,
      disableWorker: true,
      useSystemFonts: true,
      isEvalSupported: false,
    })
    const pdf = await loadingTask.promise
    return pdf.numPages
  } catch {
    return undefined
  }
}

function placeholderExtractionFromImagePages(imagePageCount: number): GeometryFirstExtractionResult {
  const placeholderBounds = { minX: 0, minY: 0, maxX: 1, maxY: 1 }
  const primitives: ExtractedPlanPrimitives[] = Array.from(
    { length: Math.max(1, imagePageCount) },
    (_, pageIndex) => ({
      pageIndex,
      pageBounds: placeholderBounds,
      lines: [],
      texts: [],
      extractionMode: "image-placeholder" as const,
    })
  )
  return {
    primitives,
    layout: {
      units: "m",
      footprintPolygon: [],
      provenance: { pipeline: "geometry-first", stage: "primitives-only" },
    },
    notes: ["Preflight placeholder extraction used (browser-safe image path)."],
  }
}

// ---------------------------------------------------------------------------
// Heuristics
// ---------------------------------------------------------------------------

const DIM_PATTERNS: RegExp[] = [
  /\bscale\b/i,
  /\b1\s*:\s*\d{1,4}\b/i,
  /\bA\d\b/i,
  /\d{1,3}\s*[×x]\s*\d{1,3}\s*m\b/i,
  /\d{1,4}\s*mm\b/i,
  /\d{1,2}\s*['\u2019]\s*\d{0,2}\s*["\u201d]/,
  /\b\d+(\.\d+)?\s*m\b/i,
]

const MULTI_FLOOR_PATTERNS =
  /\b(floor|fl\.?|level|lvl|storey|story|penthouse|basement|mezzanine|upper|lower|ground)\b|\b(l|g|p|b)\d\b|\blevel\s*\d+/i

function scoreDimensionEvidence(allText: string): number {
  if (!allText.trim()) return 0
  let hits = 0
  for (const re of DIM_PATTERNS) {
    if (re.test(allText)) hits++
  }
  return Math.min(1, hits / 4)
}

function inferMultiFloor(
  pageCountTotal: number | undefined,
  pageCountAnalyzed: number,
  textRunCount: number,
  allTextLower: string
): MultiFloorLikelihood {
  const t = pageCountTotal ?? pageCountAnalyzed
  if (t <= 1) return "single"
  const keywordHits = MULTI_FLOOR_PATTERNS.test(allTextLower) ? 1 : 0
  if (t >= 3 && keywordHits) return "likely-multi"
  if (t >= 2 && (keywordHits || textRunCount > 400)) return "possible-multi"
  if (t >= 2) return "possible-multi"
  return "single"
}

function classifyInputKind(
  source: "pdf" | "image",
  operatorListPagesOk: number,
  lineSegmentCount: number,
  textRunCount: number,
  extractionModes: string[]
): FloorplanInputKind {
  if (source === "image") return "image"
  const anyVectorStubOnly = extractionModes.every((m) => m === "pdf-vector-stub")
  const anyStrokes = extractionModes.some((m) => m === "pdf-strokes-only" || m === "pdf-text-and-strokes")
  const opOk = operatorListPagesOk > 0

  if (opOk && lineSegmentCount >= 40 && anyStrokes) return "vector-pdf"
  if (opOk && lineSegmentCount >= 15 && anyStrokes) return "vector-pdf"
  if (!opOk && textRunCount > 30) return "raster-pdf"
  if (anyVectorStubOnly && textRunCount > 20) return "raster-pdf"
  if (lineSegmentCount < 8 && textRunCount > 50) return "raster-pdf"
  if (lineSegmentCount >= 8) return "vector-pdf"
  return "unknown"
}

function tierFromScore(s: number): ReadinessTier {
  if (s >= 0.66) return "high"
  if (s >= 0.35) return "medium"
  return "low"
}

function aggregatePrimitives(extraction: GeometryFirstExtractionResult) {
  const { primitives } = extraction
  const pageCountAnalyzed = primitives.length
  const textRunCount = primitives.reduce((s, p) => s + p.texts.length, 0)
  const lineSegmentCountRaw = primitives.reduce((s, p) => s + p.lines.length, 0)
  const anyPageLinesTruncated = primitives.some((p) => !!p.operatorListLinesTruncated)
  const extractionModesPerPage = primitives.map((p) => p.extractionMode)
  const allText = primitives.flatMap((p) => p.texts.map((t) => t.text)).join("\n")
  return {
    pageCountAnalyzed,
    textRunCount,
    lineSegmentCountRaw,
    anyPageLinesTruncated,
    extractionModesPerPage,
    allText,
  }
}

function buildSignals(
  extraction: GeometryFirstExtractionResult,
  pageCountTotal: number | undefined,
  source: "pdf" | "image",
  rt: PdfVectorExtractionRuntimeLite
): FloorplanPreflightSignals {
  const agg = aggregatePrimitives(extraction)
  const wg = extraction.wallGraph
  const oc = wg?.outerCycleTrace

  const dimensionEvidenceScore = scoreDimensionEvidence(agg.allText)
  const multiFloorLikelihood = inferMultiFloor(
    pageCountTotal,
    agg.pageCountAnalyzed,
    agg.textRunCount,
    agg.allText.toLowerCase()
  )

  const cleanedWallSegmentCount = extraction.cleanedWallLines?.length ?? 0

  const operatorListPagesOk = rt.operatorListPagesOk
  const textContentPagesOk = rt.textContentPagesOk

  const inputType = classifyInputKind(
    source,
    operatorListPagesOk,
    agg.lineSegmentCountRaw,
    agg.textRunCount,
    agg.extractionModesPerPage
  )

  const pp = Math.max(1, agg.pageCountAnalyzed)

  return {
    inputType,
    pageCountTotal,
    pageCountAnalyzed: agg.pageCountAnalyzed,
    extractionModesPerPage: agg.extractionModesPerPage,
    textRunCount: agg.textRunCount,
    lineSegmentCountRaw: agg.lineSegmentCountRaw,
    operatorListPagesOk,
    textContentPagesOk,
    anyPageLinesTruncated: agg.anyPageLinesTruncated,
    cleanedWallSegmentCount,
    wallGraphNodeCount: wg?.nodeCount ?? 0,
    wallGraphConnectedComponents: wg?.connectedComponentCount ?? 0,
    wallGraphDanglingEndpoints: wg?.danglingEndpointCount ?? 0,
    largestComponentPlausibility: wg?.largestComponent.plausibility,
    outerCycleUniqueClosed: oc?.multiSeed.uniqueClosedCycles,
    outerCycleClosed: oc?.closed,
    outerCycleSupportFraction: oc?.stepSupportFraction,
    dimensionEvidenceScore,
    multiFloorLikelihood,
    textRunsPerAnalyzedPage: agg.textRunCount / pp,
    rawLinesPerAnalyzedPage: agg.lineSegmentCountRaw / pp,
    cleanedWallsPerAnalyzedPage: cleanedWallSegmentCount / pp,
  }
}

type PdfVectorExtractionRuntimeLite = {
  operatorListPagesOk: number
  textContentPagesOk: number
}

function defaultRuntimeLite(): PdfVectorExtractionRuntimeLite {
  return { operatorListPagesOk: 0, textContentPagesOk: 0 }
}

function scoreGeometryFirst(s: FloorplanPreflightSignals): number {
  let score = 0.4

  if (s.inputType === "vector-pdf") score += 0.25
  else if (s.inputType === "raster-pdf") score -= 0.15
  else if (s.inputType === "image") score -= 0.25

  if (s.cleanedWallSegmentCount > 120) score += 0.15
  else if (s.cleanedWallSegmentCount > 40) score += 0.08
  else if (s.cleanedWallSegmentCount < 15) score -= 0.2

  const pl = s.largestComponentPlausibility
  if (pl === "high") score += 0.15
  else if (pl === "medium") score += 0.05
  else if (pl === "low") score -= 0.15

  const comps = s.wallGraphConnectedComponents
  if (comps <= 2) score += 0.08
  else if (comps <= 6) score += 0
  else if (comps <= 12) score -= 0.08
  else score -= 0.18

  if (s.anyPageLinesTruncated) score -= 0.1
  if (s.wallGraphDanglingEndpoints > 40) score -= 0.05

  const cyc = s.outerCycleUniqueClosed ?? 0
  if (s.outerCycleClosed && (s.outerCycleSupportFraction ?? 0) > 0.35) score += 0.06
  else if (cyc >= 1) score += 0.02

  if (s.multiFloorLikelihood === "likely-multi") score -= 0.12
  else if (s.multiFloorLikelihood === "possible-multi") score -= 0.05

  return Math.max(0, Math.min(1, score))
}

function scorePrecision(s: FloorplanPreflightSignals): number {
  let score = 0.35
  score += s.dimensionEvidenceScore * 0.45

  if (s.textRunsPerAnalyzedPage > 25) score += 0.1
  else if (s.textRunsPerAnalyzedPage > 8) score += 0.04

  if (s.inputType === "vector-pdf") score += 0.08
  if (s.inputType === "raster-pdf") score -= 0.08
  if (s.inputType === "image") score -= 0.05

  return Math.max(0, Math.min(1, score))
}

function collectRisks(s: FloorplanPreflightSignals): string[] {
  const risks: string[] = []
  if (s.inputType === "raster-pdf") risks.push("Vector strokes weak or absent — likely scanned PDF; geometry-first has little line structure.")
  if (s.inputType === "image") risks.push("Raster/image upload — no PDF operator-list lines in this pipeline.")
  if (s.inputType === "unknown") risks.push("Could not classify PDF vector richness.")
  if (s.anyPageLinesTruncated) risks.push("Stroke extraction hit segment cap on at least one page — graph may be incomplete.")
  if (s.wallGraphConnectedComponents > 8)
    risks.push("Many wall-graph components — noisy merge or disconnected geometry.")
  if (s.largestComponentPlausibility === "low")
    risks.push("Largest wall component plausibility low — hull/cycle heuristics uncertain.")
  if (s.cleanedWallSegmentCount < 25 && s.inputType === "vector-pdf")
    risks.push("Few walls after cleanup — drawing may be detail-light or non-architectural.")
  if (s.multiFloorLikelihood !== "single") risks.push("Possible multi-floor document — single-floor reconstruction may be wrong scope.")
  if (s.dimensionEvidenceScore < 0.15) risks.push("Little dimension/scale-like text — metric trust is weak without AI or manual scale.")
  if (s.operatorListPagesOk === 0 && s.pageCountAnalyzed > 0 && s.inputType !== "image")
    risks.push("Operator list failed on all analyzed pages — treat as non-vector PDF for strokes.")
  return risks
}

function recommendMode(gf: number, prec: number, s: FloorplanPreflightSignals): FloorplanRecommendedMode {
  if (s.inputType === "image" || s.inputType === "raster-pdf") {
    if (prec > 0.45) return "AI-assisted"
    return "preview-only"
  }

  const messy =
    s.anyPageLinesTruncated ||
    s.wallGraphConnectedComponents > 10 ||
    s.largestComponentPlausibility === "low" ||
    (s.cleanedWallSegmentCount > 80 && s.wallGraphConnectedComponents > 6)

  if (messy && gf > 0.4) return "cleanup-recommended"

  if (gf >= 0.62 && s.inputType === "vector-pdf") return "geometry-first"
  if (gf >= 0.4) return "AI-assisted"
  return "preview-only"
}

function readinessScoreComposite(gf: number, prec: number, s: FloorplanPreflightSignals): number {
  let base = 0.55 * gf + 0.35 * prec
  if (s.multiFloorLikelihood === "likely-multi") base -= 0.08
  base = Math.max(0, Math.min(1, base))
  return Math.round(base * 100)
}

/** Internal assembly after extraction runs. */
function buildPreflightResult(
  extraction: GeometryFirstExtractionResult,
  pageCountTotal: number | undefined,
  source: "pdf" | "image",
  rt: PdfVectorExtractionRuntimeLite,
  options?: FloorplanPreflightOptions
): FloorplanPreflightResult {
  const signals = buildSignals(extraction, pageCountTotal, source, rt)
  const gf = scoreGeometryFirst(signals)
  const prec = scorePrecision(signals)
  const risks = collectRisks(signals)
  const recommendedMode = recommendMode(gf, prec, signals)
  const readinessScore = readinessScoreComposite(gf, prec, signals)
  const geometryFirstSuitability = tierFromScore(gf)
  const precisionSuitability = tierFromScore(prec)
  const readinessTier = tierFromScore(readinessScore / 100)

  const summary = [
    `Input ${signals.inputType}; analyzed ${signals.pageCountAnalyzed} page(s)${
      signals.pageCountTotal != null ? ` of ${signals.pageCountTotal}` : ""
    }.`,
    `Walls after cleanup: ${signals.cleanedWallSegmentCount}; graph nodes ${signals.wallGraphNodeCount}, components ${signals.wallGraphConnectedComponents}.`,
    `Geometry-first: ${geometryFirstSuitability}; precision: ${precisionSuitability}; recommend ${recommendedMode}.`,
  ].join(" ")

  const logLine = `preflight score=${readinessScore} tier=${readinessTier} mode=${recommendedMode} input=${signals.inputType} gf=${geometryFirstSuitability} prec=${precisionSuitability}`

  const result: FloorplanPreflightResult = {
    readinessScore,
    readinessTier,
    geometryFirstSuitability,
    precisionSuitability,
    risks,
    recommendedMode,
    signals,
    summary,
    logLine,
  }

  if (options?.log) {
    preflightLogSummary(result, options.logLabel)
  } else if (process.env.NODE_ENV === "development" && process.env.FLOORPLAN_PREFLIGHT_LOG === "1") {
    preflightLogSummary(result, options?.logLabel)
  }

  return result
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run preflight on raw PDF bytes (vector path + wall graph inside `runGeometryFirstExtraction`).
 */
export async function runFloorplanPreflightFromPdf(
  pdfBytes: Uint8Array,
  options?: FloorplanPreflightOptions
): Promise<FloorplanPreflightResult> {
  if (typeof window !== "undefined") {
    return buildPreflightResult(
      placeholderExtractionFromImagePages(1),
      undefined,
      "image",
      defaultRuntimeLite(),
      options
    )
  }
  const { runGeometryFirstExtraction } = await import("@/lib/geometryFirst/extractPlanPrimitives")
  const [pageCountTotal, extraction] = await Promise.all([
    getPdfTotalPageCount(pdfBytes),
    runGeometryFirstExtraction({ pdfBytes }),
  ])
  const rt = extraction._pdfVectorExtraction ?? defaultRuntimeLite()
  return buildPreflightResult(extraction, pageCountTotal, "pdf", rt, options)
}

/**
 * Preflight when only raster page images exist (e.g. client-rendered PDF pages as PNG).
 */
export async function runFloorplanPreflightFromImagePages(
  imagePageCount: number,
  options?: FloorplanPreflightOptions
): Promise<FloorplanPreflightResult> {
  const extraction = placeholderExtractionFromImagePages(imagePageCount)
  return buildPreflightResult(extraction, imagePageCount, "image", defaultRuntimeLite(), options)
}

/**
 * Merge AI floorplan analysis hints (e.g. after `mergeAnalysis`) into an existing preflight result.
 * Returns a shallow copy; does not re-run extraction.
 */
export function augmentPreflightWithAnalyzeHints(
  base: FloorplanPreflightResult,
  hints: PreflightAugmentFromAnalyze
): FloorplanPreflightResult {
  const risks = [...base.risks]
  if (hints.usedFallbackRectangle) {
    risks.push("AI footprint used rectangle fallback — polygon outline was missing or invalid after sanitize.")
  }
  let readinessScore = base.readinessScore
  let precision = base.precisionSuitability
  let recommendedMode = base.recommendedMode

  if (hints.usedFallbackRectangle) {
    readinessScore = Math.max(0, readinessScore - 8)
    if (precision === "high") precision = "medium"
  }
  if (
    hints.floorplanConfidence != null &&
    hints.floorplanConfidence < 0.35 &&
    !risks.some((r) => r.includes("model confidence"))
  ) {
    risks.push("Low stated floorplan geometry confidence from analysis payload.")
    readinessScore = Math.max(0, readinessScore - 5)
  }

  if (readinessScore < 40 && recommendedMode === "geometry-first") {
    recommendedMode = "AI-assisted"
  }

  return {
    ...base,
    readinessScore,
    readinessTier: tierFromScore(readinessScore / 100),
    precisionSuitability: precision,
    risks,
    recommendedMode,
    summary: `${base.summary} (augmented: AI fallbackRect=${hints.usedFallbackRectangle}).`,
    logLine: `${base.logLine} aug:fallbackRect=${hints.usedFallbackRectangle}`,
  }
}

/**
 * Lightweight structured log for diagnostics (explicit `log: true` or env in development).
 */
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

/**
 * Example-shaped outputs for tests or docs (no PDF parse).
 * - `exampleCleanVector`: strong lines, medium plausibility, good text.
 * - `exampleMessyRaster`: no operator list, scanned PDF pattern.
 */
export function examplePreflightOutputs(): {
  cleanVector: FloorplanPreflightResult
  messyRaster: FloorplanPreflightResult
} {
  const cleanSignals: FloorplanPreflightSignals = {
    inputType: "vector-pdf",
    pageCountTotal: 1,
    pageCountAnalyzed: 1,
    extractionModesPerPage: ["pdf-text-and-strokes"],
    textRunCount: 180,
    lineSegmentCountRaw: 6500,
    operatorListPagesOk: 1,
    textContentPagesOk: 1,
    anyPageLinesTruncated: false,
    cleanedWallSegmentCount: 220,
    wallGraphNodeCount: 140,
    wallGraphConnectedComponents: 2,
    wallGraphDanglingEndpoints: 8,
    largestComponentPlausibility: "high",
    outerCycleUniqueClosed: 2,
    outerCycleClosed: true,
    outerCycleSupportFraction: 0.52,
    dimensionEvidenceScore: 0.55,
    multiFloorLikelihood: "single",
    textRunsPerAnalyzedPage: 180,
    rawLinesPerAnalyzedPage: 6500,
    cleanedWallsPerAnalyzedPage: 220,
  }
  const messySignals: FloorplanPreflightSignals = {
    inputType: "raster-pdf",
    pageCountTotal: 4,
    pageCountAnalyzed: 3,
    extractionModesPerPage: ["pdf-text-only", "pdf-text-only", "pdf-text-only"],
    textRunCount: 40,
    lineSegmentCountRaw: 0,
    operatorListPagesOk: 0,
    textContentPagesOk: 3,
    anyPageLinesTruncated: false,
    cleanedWallSegmentCount: 0,
    wallGraphNodeCount: 0,
    wallGraphConnectedComponents: 0,
    wallGraphDanglingEndpoints: 0,
    dimensionEvidenceScore: 0.05,
    multiFloorLikelihood: "possible-multi",
    textRunsPerAnalyzedPage: 40 / 3,
    rawLinesPerAnalyzedPage: 0,
    cleanedWallsPerAnalyzedPage: 0,
  }

  const gfC = scoreGeometryFirst(cleanSignals)
  const prC = scorePrecision(cleanSignals)
  const clean: FloorplanPreflightResult = {
    readinessScore: readinessScoreComposite(gfC, prC, cleanSignals),
    readinessTier: tierFromScore(readinessScoreComposite(gfC, prC, cleanSignals) / 100),
    geometryFirstSuitability: tierFromScore(gfC),
    precisionSuitability: tierFromScore(prC),
    risks: collectRisks(cleanSignals),
    recommendedMode: recommendMode(gfC, prC, cleanSignals),
    signals: cleanSignals,
    summary: "Synthetic clean vector PDF example.",
    logLine: "preflight (example) clean-vector",
  }

  const gfM = scoreGeometryFirst(messySignals)
  const prM = scorePrecision(messySignals)
  const messy: FloorplanPreflightResult = {
    readinessScore: readinessScoreComposite(gfM, prM, messySignals),
    readinessTier: tierFromScore(readinessScoreComposite(gfM, prM, messySignals) / 100),
    geometryFirstSuitability: tierFromScore(gfM),
    precisionSuitability: tierFromScore(prM),
    risks: collectRisks(messySignals),
    recommendedMode: recommendMode(gfM, prM, messySignals),
    signals: messySignals,
    summary: "Synthetic messy / scanned PDF example.",
    logLine: "preflight (example) messy-raster",
  }

  return { cleanVector: clean, messyRaster: messy }
}
