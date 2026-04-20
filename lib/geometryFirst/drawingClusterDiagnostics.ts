/**
 * Debug-only: why the robust plan core/envelope shrank vs raw cleaned strokes,
 * and whether plausible long walls sit outside the main drawing cluster.
 */

import type { ExtractedLineSegment, PlanBoundingBox } from "@/lib/geometryFirst/types"
import { segmentAngleClass, segmentLengthPdfUnits } from "@/lib/geometryFirst/linePrimitiveDenoise"
import type { SegmentAngleClass } from "@/lib/geometryFirst/linePrimitiveDenoise"
import {
  computeRobustPlanExtent,
  type RobustOutlierReason,
  type RobustPlanExtentOptions,
  type RobustPlanExtentResult,
} from "@/lib/geometryFirst/robustPlanExtent"

export interface DrawingClusterDiagnosticsOptions {
  /** Passed through to `computeRobustPlanExtent`. */
  robustPlanExtent?: Partial<RobustPlanExtentOptions>
  /** Min length (PDF pt) for “long” excluded list + SVG highlight. */
  excludedLongMinLengthPt?: number
  topExcludedLongCount?: number
  /** Midpoint within this band of **page** edge counts as `nearPageBounds`. */
  pageNearBandPt?: number
  /** Midpoint within this distance of **pre-cluster** robust core counts as structurally “near” core. */
  nearCoreBandPt?: number
  parallelAngleDeg?: number
  /** Max highlighted long strokes in SVG overlay. */
  maxSvgExcludedLongIndices?: number
}

const DIAG_DEFAULTS: Required<
  Pick<
    DrawingClusterDiagnosticsOptions,
    | "excludedLongMinLengthPt"
    | "topExcludedLongCount"
    | "pageNearBandPt"
    | "nearCoreBandPt"
    | "parallelAngleDeg"
    | "maxSvgExcludedLongIndices"
  >
> = {
  excludedLongMinLengthPt: 36,
  topExcludedLongCount: 32,
  pageNearBandPt: 28,
  nearCoreBandPt: 48,
  parallelAngleDeg: 6,
  maxSvgExcludedLongIndices: 72,
}

/** SVG overlay: core vs long excluded, cluster / core / envelope boxes. */
export interface DrawingClusterDiagnosticsSvgOverlay {
  robustCoreBBox: PlanBoundingBox
  robustEnvelope: PlanBoundingBox
  largestClusterBBox: PlanBoundingBox | null
  /** Final inliers (primary cluster, pass strict gates). */
  coreSegmentIndices: number[]
  excludedLongHighlightIndices: number[]
}

export type DrawingClusterPrimaryClass =
  | "inlier-kept"
  | "excluded-percentile-slack"
  | "excluded-page-margin"
  | "excluded-secondary-cluster"
  | "excluded-multi-reason"

export interface DrawingClusterDiagnosticsSummary {
  totalCleaned: number
  /** Midpoint inside final `robustCoreBBox` (geometry). */
  countMidInsideFinalRobustCore: number
  countMidOutsideFinalRobustCore: number
  /** `midClusterId === 1` when trace exists. */
  countInLargestClusterPrimary: number
  /** Midpoints not in primary grid component (includes outside grid, secondary cells, or trace off). */
  countOutsideLargestClusterPrimary: number
  countMidInsidePreClusterCore: number
  countMidInsideQuantileMidSlab: number
  /** Hits per reason (overlap allowed — same segment can increment multiple). */
  excludedHitsPercentile: number
  excludedHitsPage: number
  excludedHitsSecondaryCluster: number
  /** Secondary-only: isolated cluster reason without percentile/page on that segment. */
  countExclusiveSecondaryClusterOnly: number
  /** Near pre-cluster core bbox but not primary cluster (subset of exclusions). */
  countNearPreCoreButExcluded: number
  /** Long (≥ min pt) and plausible H/V. */
  countPlausibleLongExcluded: number
  totalLengthKeptPt: number
  totalLengthExcludedPt: number
  areaRawCleanedPt2: number
  areaPreClusterCorePt2: number
  areaFinalRobustCorePt2: number
  areaPercentileIntersectPagePt2: number
  /** `finalCore / preClusterCore` when both > 0. */
  areaShrinkClusterTightenRatio: number | null
  /** `preClusterCore / raw`. */
  areaPreClusterVsRawRatio: number | null
}

export interface DrawingClusterExcludedLongRow {
  segmentIndex: number
  lengthPt: number
  orientation: SegmentAngleClass
  midpoint: { x: number; y: number }
  reasons: RobustOutlierReason[]
  nearPageBounds: boolean
  nearPreClusterCore: boolean
  /** Long H/V segment — likely wall-like even if excluded. */
  structurallyPlausible: boolean
  primaryClass: DrawingClusterPrimaryClass
}

export interface DrawingClusterDiagnosticsDebugPayload {
  summary: DrawingClusterDiagnosticsSummary
  topExcludedLong: DrawingClusterExcludedLongRow[]
  interpretationNotes: string[]
  likelyAggressiveParams: string[]
  optionsUsed: {
    excludedLongMinLengthPt: number
    topExcludedLongCount: number
    pageNearBandPt: number
    nearCoreBandPt: number
    parallelAngleDeg: number
    maxSvgExcludedLongIndices: number
    robustPlanExtentOptions: Required<RobustPlanExtentOptions>
  }
}

export interface DrawingClusterDiagnosticsResult {
  robustPlan: RobustPlanExtentResult
  summary: DrawingClusterDiagnosticsSummary
  topExcludedLong: DrawingClusterExcludedLongRow[]
  interpretationNotes: string[]
  likelyAggressiveParams: string[]
  svgOverlay: DrawingClusterDiagnosticsSvgOverlay
  debugPayload: DrawingClusterDiagnosticsDebugPayload
}

function midpoint(s: ExtractedLineSegment): { x: number; y: number } {
  return { x: (s.x1 + s.x2) / 2, y: (s.y1 + s.y2) / 2 }
}

function boxArea(b: PlanBoundingBox): number {
  return Math.max(0, b.maxX - b.minX) * Math.max(0, b.maxY - b.minY)
}

function pointInBox(px: number, py: number, b: PlanBoundingBox): boolean {
  return px >= b.minX && px <= b.maxX && py >= b.minY && py <= b.maxY
}

/** Signed clearance to axis-aligned rectangle: negative inside, 0 on edge, positive outside distance. */
function clearanceToRect(px: number, py: number, b: PlanBoundingBox): number {
  const dx = px < b.minX ? b.minX - px : px > b.maxX ? px - b.maxX : 0
  const dy = py < b.minY ? b.minY - py : py > b.maxY ? py - b.maxY : 0
  if (dx === 0 && dy === 0) {
    return Math.min(px - b.minX, b.maxX - px, py - b.minY, b.maxY - py)
  }
  return Math.hypot(dx, dy)
}

function primaryClassFor(
  percentile: boolean,
  page: boolean,
  secondary: boolean
): DrawingClusterPrimaryClass {
  const n = (percentile ? 1 : 0) + (page ? 1 : 0) + (secondary ? 1 : 0)
  if (n === 0) return "inlier-kept"
  if (n > 1) return "excluded-multi-reason"
  if (percentile) return "excluded-percentile-slack"
  if (page) return "excluded-page-margin"
  return "excluded-secondary-cluster"
}

/**
 * Single `computeRobustPlanExtent` pass with diagnostics trace, then aggregate cluster / coverage stats.
 */
export function computeDrawingClusterDiagnostics(
  cleanedSegments: ExtractedLineSegment[],
  pageBounds: PlanBoundingBox,
  opts?: DrawingClusterDiagnosticsOptions
): DrawingClusterDiagnosticsResult {
  const ODiag: Required<
    Pick<
      DrawingClusterDiagnosticsOptions,
      | "excludedLongMinLengthPt"
      | "topExcludedLongCount"
      | "pageNearBandPt"
      | "nearCoreBandPt"
      | "parallelAngleDeg"
      | "maxSvgExcludedLongIndices"
    >
  > = {
    excludedLongMinLengthPt: opts?.excludedLongMinLengthPt ?? DIAG_DEFAULTS.excludedLongMinLengthPt,
    topExcludedLongCount: opts?.topExcludedLongCount ?? DIAG_DEFAULTS.topExcludedLongCount,
    pageNearBandPt: opts?.pageNearBandPt ?? DIAG_DEFAULTS.pageNearBandPt,
    nearCoreBandPt: opts?.nearCoreBandPt ?? DIAG_DEFAULTS.nearCoreBandPt,
    parallelAngleDeg: opts?.parallelAngleDeg ?? DIAG_DEFAULTS.parallelAngleDeg,
    maxSvgExcludedLongIndices:
      opts?.maxSvgExcludedLongIndices ?? DIAG_DEFAULTS.maxSvgExcludedLongIndices,
  }

  const robust = computeRobustPlanExtent(cleanedSegments, pageBounds, {
    ...opts?.robustPlanExtent,
    includeDiagnosticsTrace: true,
  })

  const trace = robust.diagnosticsTrace
  const n = cleanedSegments.length
  const s = robust.summary

  let countMidInsideFinalRobustCore = 0
  let countMidInsidePreClusterCore = 0
  let countMidInsideQuantileMidSlab = 0
  let countInLargestClusterPrimary = 0
  let excludedHitsPercentile = 0
  let excludedHitsPage = 0
  let excludedHitsSecondaryCluster = 0
  let countExclusiveSecondaryClusterOnly = 0
  let countNearPreCoreButExcluded = 0
  let countPlausibleLongExcluded = 0
  let totalLengthKeptPt = 0
  let totalLengthExcludedPt = 0

  const outlierReasonByIndex = new Map<number, RobustOutlierReason[]>()
  for (const d of robust.outlierDetails) {
    outlierReasonByIndex.set(d.segmentIndex, d.reasons)
  }

  const preCore = trace?.preClusterRobustCoreBBox ?? s.robustCoreBBox
  const qSlab = trace?.quantileMidSlab

  for (let i = 0; i < n; i++) {
    const seg = cleanedSegments[i]!
    const m = midpoint(seg)
    const len = segmentLengthPdfUnits(seg)

    if (pointInBox(m.x, m.y, s.robustCoreBBox)) countMidInsideFinalRobustCore++
    if (pointInBox(m.x, m.y, preCore)) countMidInsidePreClusterCore++
    if (qSlab != null && pointInBox(m.x, m.y, qSlab)) countMidInsideQuantileMidSlab++
    if (trace?.midClusterId[i] === 1 || trace?.clusterRescued?.[i]) countInLargestClusterPrimary++

    const reasons = outlierReasonByIndex.get(i)
    if (reasons == null || reasons.length === 0) {
      totalLengthKeptPt += len
      continue
    }

    totalLengthExcludedPt += len
    let p = false
    let pg = false
    let sec = false
    for (const r of reasons) {
      if (r === "outside-percentile-slack") {
        p = true
        excludedHitsPercentile++
      }
      if (r === "outside-page-margin") {
        pg = true
        excludedHitsPage++
      }
      if (r === "isolated-from-largest-cluster") {
        sec = true
        excludedHitsSecondaryCluster++
      }
    }
    if (sec && !p && !pg) countExclusiveSecondaryClusterOnly++

    const distPre = clearanceToRect(m.x, m.y, preCore)
    const nearPreCore = distPre >= -ODiag.nearCoreBandPt
    if (nearPreCore && trace?.midClusterId[i] !== 1) {
      countNearPreCoreButExcluded++
    }

    const o = segmentAngleClass(seg, ODiag.parallelAngleDeg)
    const plausibleLong = len >= ODiag.excludedLongMinLengthPt && (o === "horizontal" || o === "vertical")
    if (plausibleLong) countPlausibleLongExcluded++
  }

  const areaRaw = boxArea(s.rawCleanedBBox)
  const areaPre = boxArea(preCore)
  const areaFinal = boxArea(s.robustCoreBBox)

  const areaShrinkClusterTightenRatio =
    areaPre > 1e-6 && areaFinal > 1e-6 ? areaFinal / areaPre : null
  const areaPreClusterVsRawRatio = areaRaw > 1e-6 ? areaPre / areaRaw : null

  const summary: DrawingClusterDiagnosticsSummary = {
    totalCleaned: n,
    countMidInsideFinalRobustCore,
    countMidOutsideFinalRobustCore: n - countMidInsideFinalRobustCore,
    countInLargestClusterPrimary,
    countOutsideLargestClusterPrimary: n - countInLargestClusterPrimary,
    countMidInsidePreClusterCore,
    countMidInsideQuantileMidSlab,
    excludedHitsPercentile,
    excludedHitsPage,
    excludedHitsSecondaryCluster,
    countExclusiveSecondaryClusterOnly,
    countNearPreCoreButExcluded,
    countPlausibleLongExcluded,
    totalLengthKeptPt,
    totalLengthExcludedPt,
    areaRawCleanedPt2: areaRaw,
    areaPreClusterCorePt2: areaPre,
    areaFinalRobustCorePt2: areaFinal,
    /** Same region as `preClusterRobustCoreBBox` (percentile ∩ page before cluster tighten). */
    areaPercentileIntersectPagePt2: areaPre,
    areaShrinkClusterTightenRatio,
    areaPreClusterVsRawRatio,
  }

  const topExcludedLong: DrawingClusterExcludedLongRow[] = []
  for (const i of robust.outlierIndices) {
    const seg = cleanedSegments[i]!
    const len = segmentLengthPdfUnits(seg)
    if (len < ODiag.excludedLongMinLengthPt) continue
    const m = midpoint(seg)
    const reasons = outlierReasonByIndex.get(i) ?? []
    const o = segmentAngleClass(seg, ODiag.parallelAngleDeg)
    const nearPage = clearanceToRect(m.x, m.y, pageBounds) <= ODiag.pageNearBandPt
    const distPre = clearanceToRect(m.x, m.y, preCore)
    const nearPreClusterCore = distPre >= -ODiag.nearCoreBandPt
    const structurallyPlausible = o === "horizontal" || o === "vertical"
    const p = reasons.includes("outside-percentile-slack")
    const pg = reasons.includes("outside-page-margin")
    const sec = reasons.includes("isolated-from-largest-cluster")
    topExcludedLong.push({
      segmentIndex: i,
      lengthPt: len,
      orientation: o,
      midpoint: { ...m },
      reasons: [...reasons],
      nearPageBounds: nearPage,
      nearPreClusterCore,
      structurallyPlausible,
      primaryClass: primaryClassFor(p, pg, sec),
    })
  }
  topExcludedLong.sort((a, b) => b.lengthPt - a.lengthPt)
  const topSlice = topExcludedLong.slice(0, ODiag.topExcludedLongCount)

  const reasonTotals = [
    { key: "outside-percentile-slack" as const, n: excludedHitsPercentile },
    { key: "outside-page-margin" as const, n: excludedHitsPage },
    { key: "isolated-from-largest-cluster" as const, n: excludedHitsSecondaryCluster },
  ].sort((a, b) => b.n - a.n)

  const interpretationNotes: string[] = []
  interpretationNotes.push(
    `Raw cleaned AABB area ≈ ${areaRaw.toFixed(0)} pt²; pre-cluster core (percentile ∩ page) ≈ ${areaPre.toFixed(0)} pt²; after cluster tighten final core ≈ ${areaFinal.toFixed(0)} pt².`
  )
  if (areaShrinkClusterTightenRatio != null) {
    interpretationNotes.push(
      `Cluster tighten shrank core to ~${(areaShrinkClusterTightenRatio * 100).toFixed(1)}% of the pre-cluster core area.`
    )
  }
  interpretationNotes.push(
    `Largest-component grid: ${s.largestClusterMidpointCount} midpoints in primary cells (${s.largestClusterCellCount} cells). Inlier strokes kept: ${s.inlierCount} / ${n}. Proximity-rescued from secondary cells: ${s.rescuedFromSecondaryClusterCount}.`
  )
  interpretationNotes.push(
    `Exclusion reason hit counts (overlap): percentile=${excludedHitsPercentile}, page=${excludedHitsPage}, secondary-cluster=${excludedHitsSecondaryCluster} — largest driver: ${reasonTotals[0]?.key ?? "—"}.`
  )
  interpretationNotes.push(
    `Exclusive secondary-cluster-only (no percentile/page on same stroke): ${countExclusiveSecondaryClusterOnly}. Near pre-cluster core but excluded: ${countNearPreCoreButExcluded}. Long plausible H/V excluded: ${countPlausibleLongExcluded}.`
  )

  const likelyAggressiveParams: string[] = []
  const dom = reasonTotals[0]?.key
  if (dom === "isolated-from-largest-cluster" && excludedHitsSecondaryCluster >= excludedHitsPercentile) {
    likelyAggressiveParams.push(
      "Largest-cluster stage: coarse clusterGridDivisions + 8-connectivity + larger clusterTighten pad + nearPrimaryClusterRescuePadPt / long-HV rescue pads (defaults updated). For legacy A/B use ROBUST_PLAN_EXTENT_LEGACY_CLUSTER."
    )
  }
  if (dom === "outside-percentile-slack" || areaPreClusterVsRawRatio != null && areaPreClusterVsRawRatio < 0.35) {
    likelyAggressiveParams.push(
      "Percentile slab: try percentileLow/high closer to 0–1, raise quantileSlackRatio / quantileSlackMinPt."
    )
  }
  if (dom === "outside-page-margin") {
    likelyAggressiveParams.push("Page margin test: raise pageMarginPt / pageMarginRatio if legitimate strokes sit just outside inflated page box.")
  }
  if (
    areaShrinkClusterTightenRatio != null &&
    areaShrinkClusterTightenRatio < 0.45 &&
    trace?.clusterTightenPadPt != null
  ) {
    likelyAggressiveParams.push(
      `Cluster tighten inflation applied: ${trace.clusterTightenPadPt.toFixed(1)} pt (raise clusterTightenPadScale / clusterTightenMinPt or set clusterTightenPadPt for a wider core).`
    )
  }

  const svgOverlay: DrawingClusterDiagnosticsSvgOverlay = {
    robustCoreBBox: { ...s.robustCoreBBox },
    robustEnvelope: { ...robust.robustEnvelope },
    largestClusterBBox: s.largestClusterBBox == null ? null : { ...s.largestClusterBBox },
    coreSegmentIndices: [...robust.inlierIndices],
    excludedLongHighlightIndices: topSlice
      .filter((r) => r.lengthPt >= ODiag.excludedLongMinLengthPt)
      .map((r) => r.segmentIndex)
      .slice(0, ODiag.maxSvgExcludedLongIndices),
  }

  const debugPayload: DrawingClusterDiagnosticsDebugPayload = {
    summary,
    topExcludedLong: topSlice,
    interpretationNotes,
    likelyAggressiveParams,
    optionsUsed: {
      excludedLongMinLengthPt: ODiag.excludedLongMinLengthPt,
      topExcludedLongCount: ODiag.topExcludedLongCount,
      pageNearBandPt: ODiag.pageNearBandPt,
      nearCoreBandPt: ODiag.nearCoreBandPt,
      parallelAngleDeg: ODiag.parallelAngleDeg,
      maxSvgExcludedLongIndices: ODiag.maxSvgExcludedLongIndices,
      robustPlanExtentOptions: robust.optionsUsed,
    },
  }

  return {
    robustPlan: robust,
    summary,
    topExcludedLong: topSlice,
    interpretationNotes,
    likelyAggressiveParams,
    svgOverlay,
    debugPayload,
  }
}
