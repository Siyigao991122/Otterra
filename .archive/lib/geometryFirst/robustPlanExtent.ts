/**
 * Robust plan extent / geometry hygiene for vector floor plans.
 * Down-weights extreme coordinates so debug scoring (envelope bands, shell hints) uses a plausible drawing box.
 * Debug-only — not wired into production layout.
 */

import type { ExtractedLineSegment, PlanBoundingBox } from "@/lib/geometryFirst/types"
import { unionSegmentBbox } from "@/lib/geometryFirst/debugMainStructuralWallSvg"
import { segmentAngleClass, segmentLengthPdfUnits } from "@/lib/geometryFirst/linePrimitiveDenoise"

export type RobustOutlierReason =
  | "outside-percentile-slack"
  | "outside-page-margin"
  | "isolated-from-largest-cluster"

export interface RobustPlanExtentOptions {
  /** Lower percentile on pooled x/y (endpoints + midpoints). */
  percentileLow?: number
  /** Upper percentile. */
  percentileHigh?: number
  /** Slab outside [qLo,qHi] treated as quantile outlier; scales with IQR of mids. */
  quantileSlackRatio?: number
  quantileSlackMinPt?: number
  /** Pad `robustEnvelope` after page ∩ percentile. */
  robustPadPt?: number
  /** Inflate page bounds for intersection / outside-page test. */
  pageMarginPt?: number
  pageMarginRatio?: number
  /** Enable grid largest-component filter for "main cluster". */
  useLargestClusterFilter?: boolean
  /** Grid divisions (per axis) over percentile∩page region. */
  clusterGridDivisions?: number
  /**
   * When set to a finite value, `inflate(largestClusterBBox, this)` for the tighten step instead of
   * `max(clusterTightenMinPt, margin * clusterTightenPadScale)`.
   */
  clusterTightenPadPt?: number | null
  /** Inflate largest-cluster bbox by `max(clusterTightenMinPt, margin * this)` before ∩ gridBounds (tighten step). */
  clusterTightenPadScale?: number
  /** Floor (pt) for tighten inflation — keeps small pages from an overly tiny core. */
  clusterTightenMinPt?: number
  /**
   * Segments that pass page + quantile but lie in secondary grid cells are kept if their midpoint falls in
   * `inflate(largestClusterBBox, pad)` where `pad` is this value plus optional structural extras.
   * Set to `0` to disable (legacy aggressive behavior).
   */
  nearPrimaryClusterRescuePadPt?: number
  /** Added to `nearPrimaryClusterRescuePadPt` for long, near-axis segments (wall-like). */
  structuralLongClusterRescueExtraPadPt?: number
  structuralLongClusterRescueMinLengthPt?: number
  structuralLongClusterRescueAngleDeg?: number
  /**
   * If true, grid components use 8-neighbor connectivity (diagonals). Reduces spurious fragmentation
   * when midpoints form sparse strips.
   */
  clusterConnectivity8?: boolean
  /**
   * When true, `RobustPlanExtentResult.diagnosticsTrace` is populated (pre-cluster core, cluster labels, slabs).
   * Debug-only — use from `drawingClusterDiagnostics` / tuning.
   */
  includeDiagnosticsTrace?: boolean
}

const DEFAULTS: Required<RobustPlanExtentOptions> = {
  percentileLow: 0.02,
  percentileHigh: 0.98,
  quantileSlackRatio: 0.02,
  quantileSlackMinPt: 28,
  robustPadPt: 14,
  pageMarginPt: 48,
  pageMarginRatio: 0.08,
  useLargestClusterFilter: true,
  /** Coarser than 40 → fewer spurious secondary components on sparse grids. */
  clusterGridDivisions: 26,
  clusterTightenPadPt: null,
  /** Formerly hard-coded `margin * 0.25`, which over-shrank the core vs the percentile slab. */
  clusterTightenPadScale: 0.58,
  clusterTightenMinPt: 36,
  /** Salvage strokes still inside the drawing slab but assigned to non-primary grid cells. */
  nearPrimaryClusterRescuePadPt: 88,
  structuralLongClusterRescueExtraPadPt: 56,
  structuralLongClusterRescueMinLengthPt: 36,
  structuralLongClusterRescueAngleDeg: 6,
  clusterConnectivity8: true,
  includeDiagnosticsTrace: false,
}

/**
 * Previous cluster defaults (fine grid, tight tighten, no rescue, 4-connectivity) for A/B diagnostics.
 * Pass as `robustPlanExtent: ROBUST_PLAN_EXTENT_LEGACY_CLUSTER` in debug scripts.
 */
export const ROBUST_PLAN_EXTENT_LEGACY_CLUSTER: Partial<RobustPlanExtentOptions> = {
  clusterGridDivisions: 40,
  clusterTightenPadScale: 0.25,
  clusterTightenMinPt: 0,
  clusterTightenPadPt: null,
  nearPrimaryClusterRescuePadPt: 0,
  structuralLongClusterRescueExtraPadPt: 0,
  structuralLongClusterRescueMinLengthPt: 36,
  clusterConnectivity8: false,
}

function isFiniteBox(b: PlanBoundingBox): boolean {
  return (
    Number.isFinite(b.minX) &&
    Number.isFinite(b.minY) &&
    Number.isFinite(b.maxX) &&
    Number.isFinite(b.maxY) &&
    b.maxX > b.minX + 1e-9 &&
    b.maxY > b.minY + 1e-9
  )
}

function inflateBox(b: PlanBoundingBox, pad: number): PlanBoundingBox {
  return {
    minX: b.minX - pad,
    minY: b.minY - pad,
    maxX: b.maxX + pad,
    maxY: b.maxY + pad,
  }
}

function intersectBoxes(a: PlanBoundingBox, b: PlanBoundingBox): PlanBoundingBox | null {
  const minX = Math.max(a.minX, b.minX)
  const minY = Math.max(a.minY, b.minY)
  const maxX = Math.min(a.maxX, b.maxX)
  const maxY = Math.min(a.maxY, b.maxY)
  if (!(maxX > minX + 1e-9 && maxY > minY + 1e-9)) return null
  return { minX, minY, maxX, maxY }
}

function quantileSorted(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo]!
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo)
}

function midpoint(s: ExtractedLineSegment): { x: number; y: number } {
  return { x: (s.x1 + s.x2) / 2, y: (s.y1 + s.y2) / 2 }
}

export interface RobustPlanExtentOutlierDetail {
  /** Index into original `cleanedSegments` array. */
  segmentIndex: number
  reasons: RobustOutlierReason[]
}

export interface RobustPlanExtentSummary {
  cleanedCount: number
  inlierCount: number
  outlierCount: number
  reasonBreakdown: Record<RobustOutlierReason, number>
  rawCleanedBBox: PlanBoundingBox
  percentileBBox: PlanBoundingBox
  pageInflatedBBox: PlanBoundingBox
  /** After ∩ page and optional cluster tighten, before final pad. */
  robustCoreBBox: PlanBoundingBox
  robustEnvelope: PlanBoundingBox
  largestClusterCellCount: number
  largestClusterMidpointCount: number
  largestClusterBBox: PlanBoundingBox | null
  /** Inflation applied around largest-cluster bbox before intersecting with the pre-cluster core. */
  clusterTightenPadAppliedPt: number
  /** Inliers promoted from secondary grid cells via proximity rescue (still pass page + quantile). */
  rescuedFromSecondaryClusterCount: number
}

export interface RobustPlanExtentResult {
  robustEnvelope: PlanBoundingBox
  rawCleanedEnvelope: PlanBoundingBox
  /** Same order as `cleanedSegments` indices listed in `inlierIndices`. */
  inlierSegments: ExtractedLineSegment[]
  /** Original indices into `cleanedSegments`. */
  inlierIndices: number[]
  outlierSegments: ExtractedLineSegment[]
  outlierIndices: number[]
  outlierDetails: RobustPlanExtentOutlierDetail[]
  summary: RobustPlanExtentSummary
  optionsUsed: Required<RobustPlanExtentOptions>
  diagnosticsTrace?: RobustPlanExtentDiagnosticsTrace
}

/** Serializable slice for `GeometryFirstDebugPayload`. */
export interface RobustPlanExtentDebugPayload {
  summary: RobustPlanExtentSummary
  optionsUsed: Required<RobustPlanExtentOptions>
  outlierDetailsSample: RobustPlanExtentOutlierDetail[]
}

/** Extra geometry state when `includeDiagnosticsTrace` is set. */
export interface RobustPlanExtentDiagnosticsTrace {
  /** `percentileBBox ∩ pageInflated` before largest-cluster tighten. */
  preClusterRobustCoreBBox: PlanBoundingBox
  /** Same as grid bounds used for BFS (copy of pre-cluster core). */
  gridBounds: PlanBoundingBox
  /** Midpoint slab used for percentile slack test: [mxLo−sx, mxHi+sx] × [myLo−sy, myHi+sy]. */
  quantileMidSlab: PlanBoundingBox
  midClusterId: number[]
  clusterTightenPadPt: number
  /** True when segment was kept despite `midClusterId[i]===0` due to proximity rescue. */
  clusterRescued: boolean[]
}

function gridNeighborIndices(cur: number, nx: number, ny: number, use8: boolean): number[] {
  const x = cur % nx
  const y = Math.floor(cur / nx)
  const out: number[] = []
  const add = (cx: number, cy: number) => {
    if (cx >= 0 && cy >= 0 && cx < nx && cy < ny) out.push(cx + cy * nx)
  }
  add(x - 1, y)
  add(x + 1, y)
  add(x, y - 1)
  add(x, y + 1)
  if (use8) {
    add(x - 1, y - 1)
    add(x + 1, y - 1)
    add(x - 1, y + 1)
    add(x + 1, y + 1)
  }
  return out
}

function pointInBox(px: number, py: number, b: PlanBoundingBox): boolean {
  return px >= b.minX && px <= b.maxX && py >= b.minY && py <= b.maxY
}

/**
 * Compute robust envelope and split cleaned strokes into inliers vs outliers (debug).
 */
export function computeRobustPlanExtent(
  cleanedSegments: ExtractedLineSegment[],
  pageBounds: PlanBoundingBox,
  opts?: RobustPlanExtentOptions
): RobustPlanExtentResult {
  const O = { ...DEFAULTS, ...opts }
  const n = cleanedSegments.length
  const rawCleanedEnvelope = unionSegmentBbox(cleanedSegments) ?? { ...pageBounds }

  const xs: number[] = []
  const ys: number[] = []
  const mids: Array<{ x: number; y: number }> = []
  for (let i = 0; i < n; i++) {
    const s = cleanedSegments[i]!
    xs.push(s.x1, s.x2, (s.x1 + s.x2) / 2)
    ys.push(s.y1, s.y2, (s.y1 + s.y2) / 2)
    mids.push(midpoint(s))
  }
  const sx = [...xs].sort((a, b) => a - b)
  const sy = [...ys].sort((a, b) => a - b)
  const qxLo = quantileSorted(sx, O.percentileLow)
  const qxHi = quantileSorted(sx, O.percentileHigh)
  const qyLo = quantileSorted(sy, O.percentileLow)
  const qyHi = quantileSorted(sy, O.percentileHigh)

  const midXs = mids.map((m) => m.x).sort((a, b) => a - b)
  const midYs = mids.map((m) => m.y).sort((a, b) => a - b)
  const mxLo = quantileSorted(midXs, O.percentileLow)
  const mxHi = quantileSorted(midXs, O.percentileHigh)
  const myLo = quantileSorted(midYs, O.percentileLow)
  const myHi = quantileSorted(midYs, O.percentileHigh)
  const slackX = Math.max(O.quantileSlackMinPt, O.quantileSlackRatio * Math.max(1e-6, mxHi - mxLo))
  const slackY = Math.max(O.quantileSlackMinPt, O.quantileSlackRatio * Math.max(1e-6, myHi - myLo))

  const percentileBBox: PlanBoundingBox = {
    minX: qxLo,
    minY: qyLo,
    maxX: qxHi,
    maxY: qyHi,
  }

  const pw = pageBounds.maxX - pageBounds.minX
  const ph = pageBounds.maxY - pageBounds.minY
  const margin = Math.max(O.pageMarginPt, O.pageMarginRatio * Math.max(pw, ph))
  const pageInflatedBBox = inflateBox(pageBounds, margin)

  let robustCore = intersectBoxes(percentileBBox, pageInflatedBBox)
  if (robustCore == null || !isFiniteBox(robustCore)) {
    robustCore = isFiniteBox(percentileBBox) ? { ...percentileBBox } : { ...pageBounds }
  }

  /** Grid / BFS use this box; it stays fixed while `robustCore` may tighten to the largest cluster. */
  const gridBounds = { ...robustCore }
  const preClusterRobustCoreBBox = { ...gridBounds }
  const quantileMidSlab: PlanBoundingBox = {
    minX: mxLo - slackX,
    maxX: mxHi + slackX,
    minY: myLo - slackY,
    maxY: myHi + slackY,
  }
  let clusterTightenPadPt = 0

  let largestClusterCellCount = 0
  let largestClusterMidpointCount = 0
  let largestClusterBBox: PlanBoundingBox | null = null
  const midClusterId = new Int32Array(n).fill(-1)

  if (O.useLargestClusterFilter && n > 0 && isFiniteBox(gridBounds)) {
    const gw = gridBounds.maxX - gridBounds.minX
    const gh = gridBounds.maxY - gridBounds.minY
    const nx = Math.max(4, O.clusterGridDivisions)
    const ny = Math.max(4, O.clusterGridDivisions)
    const cellW = gw / nx
    const cellH = gh / ny
    const grid: number[][] = Array.from({ length: nx * ny }, () => [])

    for (let i = 0; i < n; i++) {
      const m = mids[i]!
      if (!pointInBox(m.x, m.y, gridBounds)) continue
      const cx = Math.min(nx - 1, Math.max(0, Math.floor((m.x - gridBounds.minX) / (cellW + 1e-12))))
      const cy = Math.min(ny - 1, Math.max(0, Math.floor((m.y - gridBounds.minY) / (cellH + 1e-12))))
      grid[cx + cy * nx]!.push(i)
    }

    const seen = new Uint8Array(nx * ny)
    let bestCells = 0
    let bestMids = 0
    let bestMask: Uint8Array | null = null

    for (let c = 0; c < nx * ny; c++) {
      if (grid[c]!.length === 0 || seen[c]) continue
      const q: number[] = [c]
      seen[c] = 1
      const comp: number[] = []
      let midsInComp = 0
      while (q.length) {
        const cur = q.pop()!
        comp.push(cur)
        midsInComp += grid[cur]!.length
        for (const nb of gridNeighborIndices(cur, nx, ny, O.clusterConnectivity8)) {
          if (seen[nb] || grid[nb]!.length === 0) continue
          seen[nb] = 1
          q.push(nb)
        }
      }
      if (midsInComp > bestMids) {
        bestMids = midsInComp
        bestCells = comp.length
        bestMask = new Uint8Array(nx * ny)
        for (const cc of comp) bestMask[cc] = 1
      }
    }

    if (bestMask != null && bestMids > 0) {
      largestClusterCellCount = bestCells
      largestClusterMidpointCount = bestMids
      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity
      for (let i = 0; i < n; i++) {
        const m = mids[i]!
        const s = cleanedSegments[i]!
        midClusterId[i] = -1
        if (!pointInBox(m.x, m.y, gridBounds)) continue
        const cx = Math.min(nx - 1, Math.max(0, Math.floor((m.x - gridBounds.minX) / (cellW + 1e-12))))
        const cy = Math.min(ny - 1, Math.max(0, Math.floor((m.y - gridBounds.minY) / (cellH + 1e-12))))
        const cid = cx + cy * nx
        if (grid[cid]!.length === 0) continue
        if (bestMask[cid]) {
          midClusterId[i] = 1
          minX = Math.min(minX, m.x, s.x1, s.x2)
          maxX = Math.max(maxX, m.x, s.x1, s.x2)
          minY = Math.min(minY, m.y, s.y1, s.y2)
          maxY = Math.max(maxY, m.y, s.y1, s.y2)
        } else {
          midClusterId[i] = 0
        }
      }
      if (Number.isFinite(minX)) {
        largestClusterBBox = { minX, minY, maxX, maxY }
        clusterTightenPadPt =
          O.clusterTightenPadPt != null && Number.isFinite(O.clusterTightenPadPt)
            ? O.clusterTightenPadPt
            : Math.max(O.clusterTightenMinPt, margin * O.clusterTightenPadScale)
        const tight = intersectBoxes(gridBounds, inflateBox(largestClusterBBox, clusterTightenPadPt))
        if (tight != null && isFiniteBox(tight)) robustCore = tight
      }
    }
  }

  const robustEnvelope = inflateBox(robustCore, O.robustPadPt)

  const breakdown: Record<RobustOutlierReason, number> = {
    "outside-percentile-slack": 0,
    "outside-page-margin": 0,
    "isolated-from-largest-cluster": 0,
  }
  const details: RobustPlanExtentOutlierDetail[] = []
  const inlierIndices: number[] = []
  const outlierIndices: number[] = []
  const inlierSegments: ExtractedLineSegment[] = []
  const outlierSegments: ExtractedLineSegment[] = []
  const clusterRescued: boolean[] = new Array(n).fill(false)
  let rescuedFromSecondaryClusterCount = 0

  for (let i = 0; i < n; i++) {
    const s = cleanedSegments[i]!
    const m = mids[i]!
    const reasons: RobustOutlierReason[] = []

    const outsidePage = !pointInBox(m.x, m.y, pageInflatedBBox)
    if (outsidePage) {
      reasons.push("outside-page-margin")
    }

    const outsideQuant =
      m.x < mxLo - slackX ||
      m.x > mxHi + slackX ||
      m.y < myLo - slackY ||
      m.y > myHi + slackY
    if (outsideQuant) {
      reasons.push("outside-percentile-slack")
    }

    let clusterIsolated = O.useLargestClusterFilter && midClusterId[i] === 0
    if (
      clusterIsolated &&
      largestClusterBBox != null &&
      (O.nearPrimaryClusterRescuePadPt > 0 || O.structuralLongClusterRescueExtraPadPt > 0)
    ) {
      let pad = Math.max(0, O.nearPrimaryClusterRescuePadPt)
      if (
        O.structuralLongClusterRescueExtraPadPt > 0 &&
        segmentLengthPdfUnits(s) >= O.structuralLongClusterRescueMinLengthPt
      ) {
        const cls = segmentAngleClass(s, O.structuralLongClusterRescueAngleDeg)
        if (cls === "horizontal" || cls === "vertical") {
          pad += O.structuralLongClusterRescueExtraPadPt
        }
      }
      if (pad > 0 && pointInBox(m.x, m.y, inflateBox(largestClusterBBox, pad))) {
        clusterIsolated = false
        clusterRescued[i] = true
        rescuedFromSecondaryClusterCount++
      }
    }
    if (clusterIsolated) {
      reasons.push("isolated-from-largest-cluster")
    }

    if (reasons.length > 0) {
      outlierIndices.push(i)
      outlierSegments.push(s)
      for (const r of reasons) breakdown[r]++
      details.push({ segmentIndex: i, reasons })
    } else {
      inlierIndices.push(i)
      inlierSegments.push(s)
    }
  }

  const summary: RobustPlanExtentSummary = {
    cleanedCount: n,
    inlierCount: inlierIndices.length,
    outlierCount: outlierIndices.length,
    reasonBreakdown: breakdown,
    rawCleanedBBox: { ...rawCleanedEnvelope },
    percentileBBox: { ...percentileBBox },
    pageInflatedBBox: { ...pageInflatedBBox },
    robustCoreBBox: { ...robustCore },
    robustEnvelope: { ...robustEnvelope },
    largestClusterCellCount,
    largestClusterMidpointCount,
    largestClusterBBox,
    clusterTightenPadAppliedPt: clusterTightenPadPt,
    rescuedFromSecondaryClusterCount,
  }

  const diagnosticsTrace: RobustPlanExtentDiagnosticsTrace | undefined = O.includeDiagnosticsTrace
    ? {
        preClusterRobustCoreBBox,
        gridBounds: { ...gridBounds },
        quantileMidSlab: { ...quantileMidSlab },
        midClusterId: Array.from(midClusterId),
        clusterTightenPadPt,
        clusterRescued,
      }
    : undefined

  return {
    robustEnvelope,
    rawCleanedEnvelope,
    inlierSegments,
    inlierIndices,
    outlierSegments,
    outlierIndices,
    outlierDetails: details,
    summary,
    optionsUsed: O,
    diagnosticsTrace,
  }
}
