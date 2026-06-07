/**
 * Experiment: sweep wall-candidate presets on one PDF and compare graph health.
 * Does not touch production API routes.
 *
 * Usage:
 *   pnpm run geometry-first:sweep
 *   pnpm run geometry-first:sweep -- path/to/plan.pdf
 *   pnpm run geometry-first:sweep -- --no-main-wall-compare   (skip cleaned vs main-structural block + SVG)
 *
 * When the main-wall compare block runs, writes:
 *   debug/geometry-first-main-walls-<pdfBasename>.svg
 *   debug/geometry-first-main-walls-<pdfBasename>-minimal.svg
 *   debug/geometry-first-wall-hypotheses-<pdfBasename>.svg (strict input)
 *   debug/geometry-first-wall-hypotheses-<pdfBasename>-extended.svg (extended structural input)
 */

import * as fs from "node:fs"
import * as path from "node:path"

import { cleanupWallCandidateLines } from "../lib/geometryFirst/cleanupWallLines"
import { extractPdfVectorPrimitives } from "../lib/geometryFirst/extractPdfVectorPrimitives"
import { filterWallCandidateLines } from "../lib/geometryFirst/linePrimitiveDenoise"
import type {
  ExtractedLineSegment,
  ExtractedPlanPrimitives,
  ExtractedTextRun,
  PlanBoundingBox,
  WallGraphDebugPayload,
} from "../lib/geometryFirst/types"
import { buildWallGraphFoundationFromCleaned } from "../lib/geometryFirst/wallGraphFoundation"
import { buildArchitecturalWallHypotheses } from "../lib/geometryFirst/architecturalWallHypotheses"
import { writeArchitecturalWallHypothesesSvg } from "../lib/geometryFirst/debugArchitecturalWallHypothesesSvg"
import { writeMainStructuralWallSelectionSvg } from "../lib/geometryFirst/debugMainStructuralWallSvg"
import { buildExtendedStructuralWalls } from "../lib/geometryFirst/extendedStructuralWalls"
import { buildGlobalStructuralSpans } from "../lib/geometryFirst/globalStructuralSpans"
import { computeDrawingClusterDiagnostics } from "../lib/geometryFirst/drawingClusterDiagnostics"
import type { MainStructuralWallSelectorResult } from "../lib/geometryFirst/mainStructuralWallSelector"
import { selectMainStructuralWalls } from "../lib/geometryFirst/mainStructuralWallSelector"
import { splitWallLinesAtJunctions } from "../lib/geometryFirst/splitWallLinesAtJunctions"

const MIN_LENGTHS = [4, 6, 8, 10, 12] as const
type OrientationPreset = "hv-strict" | "hv-tolerant"
const ORIENTATION_MODES: OrientationPreset[] = ["hv-strict", "hv-tolerant"]

const ANGLE_TOL_DEG: Record<OrientationPreset, number> = {
  "hv-strict": 4,
  "hv-tolerant": 10,
}

/** Padding (pt) around inferred text AABBs when dropping stroke midpoints. */
const TEXT_EXCLUSION_PAD_PT = 3

function expandedTextBBox(t: ExtractedTextRun, pad: number): { minX: number; maxX: number; minY: number; maxY: number } {
  const w = t.width ?? Math.max(6, t.text.length * 4.5)
  const h = t.height ?? 11
  return {
    minX: t.x - pad,
    maxX: t.x + w + pad,
    minY: t.y - h - pad,
    maxY: t.y + pad,
  }
}

function midpointInAnyTextBox(s: ExtractedLineSegment, texts: ExtractedTextRun[], pad: number): boolean {
  if (texts.length === 0) return false
  const mx = (s.x1 + s.x2) / 2
  const my = (s.y1 + s.y2) / 2
  for (const t of texts) {
    const b = expandedTextBBox(t, pad)
    if (mx >= b.minX && mx <= b.maxX && my >= b.minY && my <= b.maxY) return true
  }
  return false
}

/** Drop segments whose midpoint lies inside an expanded text run bbox (experiment-only heuristic). */
function applyTextExclusion(primitives: ExtractedPlanPrimitives[], exclude: boolean): ExtractedLineSegment[] {
  const out: ExtractedLineSegment[] = []
  for (const p of primitives) {
    for (const s of p.lines) {
      if (exclude && midpointInAnyTextBox(s, p.texts, TEXT_EXCLUSION_PAD_PT)) continue
      out.push(s)
    }
  }
  return out
}

interface SweepRow {
  minLengthPt: number
  orientation: OrientationPreset
  textExclusion: boolean
  rawLineCount: number
  candidateCount: number
  cleanedCount: number
  nodeCount: number
  edgeCount: number
  avgDegree: number
  danglingEndpointCount: number
  componentCount: number
  largestComponentNodeCount: number
  largestComponentEdgeCount: number
  largestComponentPlausibility: string
  uniqueClosedCyclesCount: number
}

function sortRows(rows: SweepRow[]): SweepRow[] {
  return [...rows].sort((a, b) => {
    if (a.danglingEndpointCount !== b.danglingEndpointCount) return a.danglingEndpointCount - b.danglingEndpointCount
    if (a.componentCount !== b.componentCount) return a.componentCount - b.componentCount
    if (b.largestComponentNodeCount !== a.largestComponentNodeCount) return b.largestComponentNodeCount - a.largestComponentNodeCount
    if (b.uniqueClosedCyclesCount !== a.uniqueClosedCyclesCount) return b.uniqueClosedCyclesCount - a.uniqueClosedCyclesCount
    if (a.minLengthPt !== b.minLengthPt) return a.minLengthPt - b.minLengthPt
    return a.orientation.localeCompare(b.orientation)
  })
}

function pad(s: string, w: number): string {
  const t = s.length > w ? s.slice(0, w - 1) + "…" : s
  return t.padEnd(w)
}

function unionPageBounds(primitives: ExtractedPlanPrimitives[]): PlanBoundingBox {
  if (primitives.length === 0) return { minX: 0, minY: 0, maxX: 1, maxY: 1 }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of primitives) {
    const b = p.pageBounds
    minX = Math.min(minX, b.minX)
    minY = Math.min(minY, b.minY)
    maxX = Math.max(maxX, b.maxX)
    maxY = Math.max(maxY, b.maxY)
  }
  return { minX, minY, maxX, maxY }
}

function graphHealthLine(label: string, wg: WallGraphDebugPayload, extra: string): void {
  console.log(
    `${pad(label, 22)} nodes=${pad(String(wg.nodeCount), 5)} edges=${pad(String(wg.graphUniqueEdgeCount), 5)} avgDeg=${pad(wg.averageDegree.toFixed(2), 6)} dangl=${pad(String(wg.danglingEndpointCount), 6)} comps=${pad(String(wg.connectedComponentCount), 5)} LG(n/e)=${wg.largestComponent.nodeCount}/${wg.largestComponent.graphUniqueEdgeCount} ${wg.largestComponent.plausibility} cycles=${wg.outerCycleTrace.multiSeed.uniqueClosedCycles} ${extra}`
  )
}

function printMainStructuralDiagnostics(
  mainPick: MainStructuralWallSelectorResult,
  cleanedCount: number
): void {
  const O = mainPick.optionsUsed
  const gb = mainPick.gateBreakdown
  const sd = mainPick.scoreDistribution
  const ta = mainPick.termAverages
  console.log("\n--- mainStructuralWallSelector (defaults) ---")
  console.log(
    `selectedMainWalls: ${mainPick.segmentCountSelected} / ${mainPick.segmentCountIn} cleaned (rejected: ${sd.rejectedCount})`
  )
  console.log(
    `gates: hardMinLength=${O.hardMinLengthPt}pt requireParallel=${O.requireParallelSupport} minParNei=${O.minParallelNeighborCount} minOverlap=${O.minOverlapSupport} minDensity=${O.minNeighborhoodDensity} minScore=${O.minScoreToKeep}`
  )
  console.log(
    `gate rejections: hardLen=${gb.rejectedHardMinLength} noParallel=${gb.rejectedRequireParallelSupport} minParNei=${gb.rejectedMinParallelNeighborCount} minOverlap=${gb.rejectedMinOverlapSupport} minDensity=${gb.rejectedMinNeighborhoodDensity}`
  )
  console.log(`post-gate: passedGates=${gb.passedGates} scoreRejected=${gb.rejectedScoreThreshold} selected=${gb.selected}`)
  console.log(
    `totalScore: min=${sd.min.toFixed(3)} p25=${sd.p25.toFixed(3)} med=${sd.median.toFixed(3)} mean=${sd.mean.toFixed(3)} p75=${sd.p75.toFixed(3)} p90=${sd.p90.toFixed(3)} max=${sd.max.toFixed(3)}`
  )
  console.log(
    `term averages: len=${ta.avgLengthScore.toFixed(3)} axis=${ta.avgAxisScore.toFixed(3)} par=${ta.avgParallelNeighborBonus.toFixed(3)} ov=${ta.avgOverlapBonus.toFixed(3)} isoPen=${ta.avgIsolatedPenalty.toFixed(3)} txtPen=${ta.avgTextPenalty.toFixed(3)}`
  )
  console.log(`cleaned segments (reference): ${cleanedCount}`)
}

function printTable(rows: SweepRow[]): void {
  const cols = [
    ["Lmin", 4],
    ["orient", 12],
    ["noTxt", 5],
    ["raw", 6],
    ["cand", 6],
    ["clean", 6],
    ["nodes", 7],
    ["edges", 7],
    ["avgDeg", 7],
    ["dangl", 6],
    ["comps", 6],
    ["LGn", 6],
    ["LGe", 6],
    ["plaus", 7],
    ["cycles", 7],
  ] as const

  const header = cols.map(([h, w]) => pad(h, w)).join(" ")
  console.log(header)
  console.log("-".repeat(header.length))
  for (const r of rows) {
    const line = [
      pad(String(r.minLengthPt), cols[0][1]),
      pad(r.orientation, cols[1][1]),
      pad(r.textExclusion ? "Y" : "N", cols[2][1]),
      pad(String(r.rawLineCount), cols[3][1]),
      pad(String(r.candidateCount), cols[4][1]),
      pad(String(r.cleanedCount), cols[5][1]),
      pad(String(r.nodeCount), cols[6][1]),
      pad(String(r.edgeCount), cols[7][1]),
      pad(r.avgDegree.toFixed(2), cols[8][1]),
      pad(String(r.danglingEndpointCount), cols[9][1]),
      pad(String(r.componentCount), cols[10][1]),
      pad(String(r.largestComponentNodeCount), cols[11][1]),
      pad(String(r.largestComponentEdgeCount), cols[12][1]),
      pad(r.largestComponentPlausibility, cols[13][1]),
      pad(String(r.uniqueClosedCyclesCount), cols[14][1]),
    ].join(" ")
    console.log(line)
  }
}

async function main(): Promise<void> {
  const skipMainWallCompare = process.argv.includes("--no-main-wall-compare")
  const positional = process.argv.slice(2).filter((a) => !a.startsWith("-"))
  /** Last path wins so `pnpm run geometry-first:sweep -- ./other.pdf` overrides the default bundled in the npm script. */
  const pdfPath = path.resolve(process.cwd(), positional.length ? positional[positional.length - 1]! : "tower_6_B.pdf")

  if (!fs.existsSync(pdfPath)) {
    console.error(`PDF not found: ${pdfPath}`)
    console.error("Pass a path: pnpm run geometry-first:sweep -- ./your.pdf")
    process.exit(1)
  }

  const pdfBytes = new Uint8Array(fs.readFileSync(pdfPath))
  const { primitives } = await extractPdfVectorPrimitives(pdfBytes)
  const rawLineCountAllPages = primitives.reduce((s, p) => s + p.lines.length, 0)

  console.log(`PDF: ${pdfPath}`)
  console.log(`Pages (extract cap): ${primitives.length}, raw strokes: ${rawLineCountAllPages}`)
  console.log(
    `Sweep: minLengthPt=${[...MIN_LENGTHS].join(",")}, orient=${ORIENTATION_MODES.join("|")}, textExclusion=true|false`
  )
  console.log("Graph built on junction-split segments (matches extraction pipeline order).\n")

  const rows: SweepRow[] = []

  for (const minLengthPt of MIN_LENGTHS) {
    for (const orientation of ORIENTATION_MODES) {
      for (const textExclusion of [true, false]) {
        const strokeLines = applyTextExclusion(primitives, textExclusion)
        const rawLineCount = strokeLines.length

        const wc = filterWallCandidateLines(strokeLines, {
          minLengthPdfUnits: minLengthPt,
          dominantAngles: "hv",
          angleToleranceDeg: ANGLE_TOL_DEG[orientation],
        })

        const { cleaned, afterCount } = cleanupWallCandidateLines(wc.kept)
        const cleanedCount = afterCount

        const { split: forGraph } = splitWallLinesAtJunctions(cleaned)
        const wg = buildWallGraphFoundationFromCleaned(forGraph)

        rows.push({
          minLengthPt,
          orientation,
          textExclusion,
          rawLineCount,
          candidateCount: wc.kept.length,
          cleanedCount,
          nodeCount: wg.nodeCount,
          edgeCount: wg.graphUniqueEdgeCount,
          avgDegree: wg.averageDegree,
          danglingEndpointCount: wg.danglingEndpointCount,
          componentCount: wg.connectedComponentCount,
          largestComponentNodeCount: wg.largestComponent.nodeCount,
          largestComponentEdgeCount: wg.largestComponent.graphUniqueEdgeCount,
          largestComponentPlausibility: wg.largestComponent.plausibility,
          uniqueClosedCyclesCount: wg.outerCycleTrace.multiSeed.uniqueClosedCycles,
        })
      }
    }
  }

  const sorted = sortRows(rows)
  printTable(sorted)

  console.log(
    "\nSort (best rows first): fewer dangling endpoints, fewer components, larger largest component, more unique closed cycles; then min L, orient."
  )
  console.log(`Text exclusion Y: drop strokes whose midpoint falls in an expanded text bbox (pad=${TEXT_EXCLUSION_PAD_PT}pt).`)
  console.log(`hv-strict: angleTol=${ANGLE_TOL_DEG["hv-strict"]}°; hv-tolerant: ${ANGLE_TOL_DEG["hv-tolerant"]}°`)

  if (!skipMainWallCompare) {
    const REF_MIN = 8
    const flat = primitives.flatMap((p) => p.lines)
    const allTexts = primitives.flatMap((p) => p.texts)
    const bounds = unionPageBounds(primitives)
    const wcRef = filterWallCandidateLines(flat, {
      minLengthPdfUnits: REF_MIN,
      dominantAngles: "hv",
      angleToleranceDeg: ANGLE_TOL_DEG["hv-tolerant"],
    })
    const { cleaned: cleanedRef, afterCount: cleanedRefCount } = cleanupWallCandidateLines(wcRef.kept)
    const candSplit = splitWallLinesAtJunctions(cleanedRef).split
    const wallCandidate = buildWallGraphFoundationFromCleaned(candSplit)
    const mainPick = selectMainStructuralWalls(cleanedRef, allTexts, bounds)
    const mainSplit = splitWallLinesAtJunctions(mainPick.selectedMainWalls).split
    const wallMain = buildWallGraphFoundationFromCleaned(mainSplit)

    const clusterDiag = computeDrawingClusterDiagnostics(cleanedRef, bounds)
    const robustPlan = clusterDiag.robustPlan
    const extendedPick = buildExtendedStructuralWalls(cleanedRef, mainPick.selectedMainWalls, robustPlan.robustEnvelope)
    const extendedSplit = splitWallLinesAtJunctions(extendedPick.extendedStructuralWalls).split
    const wallExtended = buildWallGraphFoundationFromCleaned(extendedSplit)

    console.log(
      `\n=== Cleaned vs main-structural (reference: raw strokes, minLen=${REF_MIN}pt hv-tolerant, no sweep text exclusion; mainStructuralWallSelector defaults) ===`
    )
    printMainStructuralDiagnostics(mainPick, cleanedRefCount)
    console.log(
      `\n--- extended structural (debug recall): ${extendedPick.rescueStats.extendedTotalCount} segments (${extendedPick.rescueStats.extendedOnlyCount} beyond strict); rule hits longHVS=${extendedPick.rescueStats.ruleHitsLongHVSingleton} band=${extendedPick.rescueStats.ruleHitsOuterBand} group=${extendedPick.rescueStats.ruleHitsLargeSpanGroup} ---`
    )
    console.log("\n--- graph health (after junction split) ---")
    graphHealthLine("candidateGraph", wallCandidate, "(cleaned→split)")
    graphHealthLine("strictMainWallGraph", wallMain, "(strict→split)")
    graphHealthLine("extendedMainWallGraph", wallExtended, "(extended→split)")

    const hypOpts = { maxHypothesesInPayload: 5000, maxSvgStrokesInPayload: 5000 }
    const wallHypothesesStrict = buildArchitecturalWallHypotheses(
      cleanedRef,
      mainPick.selectedMainWalls,
      allTexts,
      bounds,
      hypOpts
    )
    const wallHypothesesExtended = buildArchitecturalWallHypotheses(
      cleanedRef,
      extendedPick.extendedStructuralWalls,
      allTexts,
      bounds,
      hypOpts
    )
    console.log(
      `\n--- wall hypotheses (strict vs extended structural input): strict total=${wallHypothesesStrict.summary.totalHypotheses} (P${wallHypothesesStrict.summary.pairedCount}/M${wallHypothesesStrict.summary.mergedRunCount}/S${wallHypothesesStrict.summary.singletonCount}) | extended total=${wallHypothesesExtended.summary.totalHypotheses} (P${wallHypothesesExtended.summary.pairedCount}/M${wallHypothesesExtended.summary.mergedRunCount}/S${wallHypothesesExtended.summary.singletonCount}) | Δtotal=${wallHypothesesExtended.summary.totalHypotheses - wallHypothesesStrict.summary.totalHypotheses} ---`
    )

    const globalSpansPayload = buildGlobalStructuralSpans(robustPlan.inlierSegments, bounds, {
      scoringEnvelope: robustPlan.robustEnvelope,
      originalCleanedIndices: robustPlan.inlierIndices,
    })
    const gs = globalSpansPayload.summary
    console.log(
      `\n--- global structural spans: ${gs.totalSpanCount} (H${gs.orientationDistribution.horizontal}/V${gs.orientationDistribution.vertical}/D${gs.orientationDistribution.diagonal}) topLen=${gs.topBySpanLength[0]?.id ?? "—"} topShell=${gs.topByShellHintScore[0]?.id ?? "—"} ---`
    )

    const svgBasename = path.basename(pdfPath, path.extname(pdfPath)) || "plan"
    const robustSvgOverlay = {
      rawCleanedEnvelope: robustPlan.rawCleanedEnvelope,
      robustEnvelope: robustPlan.robustEnvelope,
      outlierIndices: robustPlan.outlierIndices,
    }
    console.log("")
    if (robustPlan.summary.outlierCount > 0) {
      const s = robustPlan.summary
      console.log(
        `[robust plan extent] inliers=${s.inlierCount} outliers=${s.outlierCount} | raw ${s.rawCleanedBBox.minX.toFixed(0)},${s.rawCleanedBBox.minY.toFixed(0)}–${s.rawCleanedBBox.maxX.toFixed(0)},${s.rawCleanedBBox.maxY.toFixed(0)} → robust ${s.robustEnvelope.minX.toFixed(0)},${s.robustEnvelope.minY.toFixed(0)}–${s.robustEnvelope.maxX.toFixed(0)},${s.robustEnvelope.maxY.toFixed(0)}`
      )
    }
    for (const line of clusterDiag.interpretationNotes) {
      console.log(`[drawing-cluster] ${line}`)
    }
    writeMainStructuralWallSelectionSvg({
      projectRoot: path.resolve(process.cwd()),
      basename: svgBasename,
      cleanedSegments: cleanedRef,
      mainStructuralSplitSegments: mainSplit,
      extendedStructuralSplitSegments: extendedSplit,
      texts: allTexts,
      pageBounds: bounds,
      sourceLabel: pdfPath,
      robustPlanExtentOverlay: robustSvgOverlay,
      drawingClusterDiagnosticsOverlay: clusterDiag.svgOverlay,
    })

    writeArchitecturalWallHypothesesSvg({
      projectRoot: path.resolve(process.cwd()),
      basename: svgBasename,
      cleanedSegments: cleanedRef,
      mainStructuralSplitSegments: mainSplit,
      extendedStructuralSplitSegments: extendedSplit,
      texts: allTexts,
      pageBounds: bounds,
      sourceLabel: `${pdfPath} (hypotheses from strict structural)`,
      hypotheses: wallHypothesesStrict.hypotheses,
      globalStructuralSpans: globalSpansPayload.spans,
      robustPlanExtentOverlay: robustSvgOverlay,
      drawingClusterDiagnosticsOverlay: clusterDiag.svgOverlay,
    })
    writeArchitecturalWallHypothesesSvg({
      projectRoot: path.resolve(process.cwd()),
      basename: svgBasename,
      filenameSuffix: "-extended",
      cleanedSegments: cleanedRef,
      mainStructuralSplitSegments: mainSplit,
      extendedStructuralSplitSegments: extendedSplit,
      texts: allTexts,
      pageBounds: bounds,
      sourceLabel: `${pdfPath} (hypotheses from extended structural)`,
      hypotheses: wallHypothesesExtended.hypotheses,
      globalStructuralSpans: globalSpansPayload.spans,
      robustPlanExtentOverlay: robustSvgOverlay,
      drawingClusterDiagnosticsOverlay: clusterDiag.svgOverlay,
    })
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
