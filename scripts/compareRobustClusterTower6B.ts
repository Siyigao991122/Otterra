/**
 * Before/after robust largest-cluster defaults for one PDF (default: tower_6_B.pdf).
 * Does not change production routes — run locally: `pnpm exec tsx scripts/compareRobustClusterTower6B.ts`
 *
 * Usage:
 *   pnpm exec tsx scripts/compareRobustClusterTower6B.ts [path/to.pdf]
 */

import * as fs from "node:fs"
import * as path from "node:path"

import { buildArchitecturalWallHypotheses } from "../lib/geometryFirst/architecturalWallHypotheses"
import { cleanupWallCandidateLines } from "../lib/geometryFirst/cleanupWallLines"
import { computeDrawingClusterDiagnostics } from "../lib/geometryFirst/drawingClusterDiagnostics"
import { extractPdfVectorPrimitives } from "../lib/geometryFirst/extractPdfVectorPrimitives"
import { buildGlobalStructuralSpans } from "../lib/geometryFirst/globalStructuralSpans"
import { filterWallCandidateLines, segmentAngleClass, segmentLengthPdfUnits } from "../lib/geometryFirst/linePrimitiveDenoise"
import type { ExtractedLineSegment, ExtractedPlanPrimitives, PlanBoundingBox } from "../lib/geometryFirst/types"
import type { RobustPlanExtentResult } from "../lib/geometryFirst/robustPlanExtent"
import { ROBUST_PLAN_EXTENT_LEGACY_CLUSTER } from "../lib/geometryFirst/robustPlanExtent"
import { selectMainStructuralWalls } from "../lib/geometryFirst/mainStructuralWallSelector"

const ANGLE_TOL = 6
const WALL_MIN_LEN = 3
const PLAUSIBLE_LONG_PT = 36

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

function boxArea(b: PlanBoundingBox): number {
  return Math.max(0, b.maxX - b.minX) * Math.max(0, b.maxY - b.minY)
}

/** Long H/V outliers excluded exclusively for secondary-cluster assignment. */
function countPlausibleLongClusterExclusive(
  r: RobustPlanExtentResult,
  cleaned: ExtractedLineSegment[]
): number {
  let c = 0
  for (const d of r.outlierDetails) {
    if (d.reasons.length !== 1 || d.reasons[0] !== "isolated-from-largest-cluster") continue
    const s = cleaned[d.segmentIndex]!
    const len = segmentLengthPdfUnits(s)
    const o = segmentAngleClass(s, ANGLE_TOL)
    if (len >= PLAUSIBLE_LONG_PT && (o === "horizontal" || o === "vertical")) c++
  }
  return c
}

async function main(): Promise<void> {
  const pdfPath =
    process.argv[2] != null && process.argv[2]!.length > 0
      ? path.resolve(process.cwd(), process.argv[2]!)
      : path.join(process.cwd(), "tower_6_B.pdf")
  if (!fs.existsSync(pdfPath)) {
    console.error(`PDF not found: ${pdfPath}`)
    process.exit(1)
  }

  const bytes = new Uint8Array(fs.readFileSync(pdfPath))
  const { primitives } = await extractPdfVectorPrimitives(bytes)
  const flat = primitives.flatMap((p) => p.lines)
  const wc = filterWallCandidateLines(flat, {
    minLengthPdfUnits: WALL_MIN_LEN,
    dominantAngles: "hv",
    angleToleranceDeg: ANGLE_TOL,
  })
  const { cleaned } = cleanupWallCandidateLines(wc.kept)
  const pageBounds = unionPageBounds(primitives)
  const texts = primitives.flatMap((p) => p.texts)

  const legacyDiag = computeDrawingClusterDiagnostics(cleaned, pageBounds, {
    robustPlanExtent: ROBUST_PLAN_EXTENT_LEGACY_CLUSTER,
  })
  const balancedDiag = computeDrawingClusterDiagnostics(cleaned, pageBounds, {})

  const mainPick = selectMainStructuralWalls(cleaned, texts, pageBounds)
  const hypOpts = { maxHypothesesInPayload: 10_000, maxSvgStrokesInPayload: 10_000 } as const

  function snapshot(label: string, diag: typeof legacyDiag) {
    const r = diag.robustPlan
    const s = r.summary
    const dsum = diag.summary
    const spans = buildGlobalStructuralSpans(r.inlierSegments, pageBounds, {
      scoringEnvelope: r.robustEnvelope,
      originalCleanedIndices: r.inlierIndices,
    })
    const hyp = buildArchitecturalWallHypotheses(
      r.inlierSegments,
      mainPick.selectedMainWalls,
      texts,
      pageBounds,
      hypOpts
    )
    return {
      label,
      inlierCount: s.inlierCount,
      outlierCount: s.outlierCount,
      plausibleLongExcluded: dsum.countPlausibleLongExcluded,
      plausibleLongClusterExclusive: countPlausibleLongClusterExclusive(r, cleaned),
      largestClusterMids: s.largestClusterMidpointCount,
      largestClusterCells: s.largestClusterCellCount,
      rescued: s.rescuedFromSecondaryClusterCount,
      tightenPad: s.clusterTightenPadAppliedPt,
      robustCoreArea: boxArea(s.robustCoreBBox),
      globalSpanCount: spans.summary.totalSpanCount,
      hypothesisCount: hyp.summary.totalHypotheses,
      options: r.optionsUsed,
    }
  }

  const A = snapshot("legacy (ROBUST_PLAN_EXTENT_LEGACY_CLUSTER)", legacyDiag)
  const B = snapshot("balanced (new defaults)", balancedDiag)

  console.log(JSON.stringify({ pdf: pdfPath, cleanedSegmentCount: cleaned.length, compare: { A, B } }, null, 2))

  console.log("\n--- Summary (robust core / downstream) ---")
  for (const row of [A, B]) {
    console.log(
      `${row.label}: inliers ${row.inlierCount} / ${cleaned.length}, outliers ${row.outlierCount}, ` +
        `plausible-long excluded ${row.plausibleLongExcluded}, long-H/V cluster-only ${row.plausibleLongClusterExclusive}, ` +
        `rescued ${row.rescued}, tightenPad ${row.tightenPad.toFixed(1)} pt, core area ${row.robustCoreArea.toFixed(0)} pt², ` +
        `global spans ${row.globalSpanCount}, wall hypotheses (from inliers) ${row.hypothesisCount}`
    )
  }
  console.log(
    `\nCluster params: legacy grid=${A.options.clusterGridDivisions} 8conn=${A.options.clusterConnectivity8} ` +
      `tightenScale=${A.options.clusterTightenPadScale} rescuePad=${A.options.nearPrimaryClusterRescuePadPt} | ` +
      `balanced grid=${B.options.clusterGridDivisions} 8conn=${B.options.clusterConnectivity8} ` +
      `tightenScale=${B.options.clusterTightenPadScale} rescuePad=${B.options.nearPrimaryClusterRescuePadPt}`
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
