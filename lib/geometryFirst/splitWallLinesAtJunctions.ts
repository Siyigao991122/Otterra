/**
 * Split cleaned wall segments at crossings, T-junctions, and axis-aligned collinear overlaps
 * so the quantized wall graph shares real junction nodes (PDF pt).
 */

import type { ExtractedLineSegment, WallJunctionSplitDebug } from "@/lib/geometryFirst/types"
import { segmentLengthPt } from "@/lib/geometryFirst/cleanupWallLines"

export interface SplitWallLinesAtJunctionsOptions {
  /** Perpendicular distance (pt) for T-junctions and collinear axis alignment. */
  junctionEpsPt?: number
  /** Drop split edges shorter than this (pt). */
  minSplitEdgeLengthPt?: number
  /** Merge adjacent split parameters along a segment within this fraction of length or absolute (pt). */
  splitMergeTolPt?: number
  /** Dedup duplicate split segments (decimal places on coordinates). */
  dedupeDecimals?: number
}

const DEFAULTS: Required<SplitWallLinesAtJunctionsOptions> = {
  junctionEpsPt: 1.25,
  minSplitEdgeLengthPt: 2,
  splitMergeTolPt: 0.4,
  dedupeDecimals: 1,
}

function roundKey(n: number, decimals: number): number {
  const f = 10 ** decimals
  return Math.round(n * f) / f
}

function clampT(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t
}

/** Minimum parameter margin (for stiffly interior crossing detection). */
function interiorMargin(len: number, junctionEps: number): number {
  return Math.max(1e-7, Math.min(0.49, junctionEps / Math.max(len, junctionEps * 2)))
}

/** Split only if point is at least `junctionEps` away from both endpoints along the segment. */
function pushTAlongSeg(splitTs: number[][], i: number, t: number, segLen: number, junctionEps: number): void {
  if (segLen < 1e-9) return
  const d0 = t * segLen
  const d1 = (1 - t) * segLen
  if (d0 >= junctionEps && d1 >= junctionEps) splitTs[i]!.push(t)
}

/** Distance from P to segment AB; `t` is closest-point parameter in [0,1]. */
function pointSegmentProximity(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): { dist: number; t: number } {
  const abx = bx - ax
  const aby = by - ay
  const ab2 = abx * abx + aby * aby
  if (ab2 < 1e-18) {
    const dx = px - ax
    const dy = py - ay
    return { dist: Math.hypot(dx, dy), t: 0 }
  }
  let t = ((px - ax) * abx + (py - ay) * aby) / ab2
  t = clampT(t)
  const qx = ax + t * abx
  const qy = ay + t * aby
  return { dist: Math.hypot(px - qx, py - qy), t }
}

function lineIntersectionParams(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number
): { t: number; u: number } | null {
  const r1x = bx - ax
  const r1y = by - ay
  const r2x = dx - cx
  const r2y = dy - cy
  const cross = r1x * r2y - r1y * r2x
  if (Math.abs(cross) < 1e-14) return null
  const opx = cx - ax
  const opy = cy - ay
  const t = (opx * r2y - opy * r2x) / cross
  const u = (opx * r1y - opy * r1x) / cross
  return { t, u }
}

function mergeSortedTs(ts: number[], mergeTol: number): number[] {
  if (ts.length === 0) return []
  const s = [...ts].sort((a, b) => a - b)
  const out: number[] = [s[0]!]
  for (let i = 1; i < s.length; i++) {
    const x = s[i]!
    if (x - out[out.length - 1]! > mergeTol) out.push(x)
  }
  return out
}

function dedupeSegments(segments: ExtractedLineSegment[], decimals: number): ExtractedLineSegment[] {
  const seen = new Set<string>()
  const out: ExtractedLineSegment[] = []
  const r = (n: number) => roundKey(n, decimals)
  for (const s of segments) {
    const A = `${r(s.x1)},${r(s.y1)},${r(s.x2)},${r(s.y2)}`
    const B = `${r(s.x2)},${r(s.y2)},${r(s.x1)},${r(s.y1)}`
    const k = A < B ? A : B
    if (seen.has(k)) continue
    seen.add(k)
    out.push(s)
  }
  return out
}

function isNearlyHorizontal(s: ExtractedLineSegment, epsRatio: number): boolean {
  const dx = s.x2 - s.x1
  const dy = s.y2 - s.y1
  const len = Math.hypot(dx, dy)
  if (len < 1e-9) return false
  return Math.abs(dy) <= epsRatio * len
}

function isNearlyVertical(s: ExtractedLineSegment, epsRatio: number): boolean {
  const dx = s.x2 - s.x1
  const dy = s.y2 - s.y1
  const len = Math.hypot(dx, dy)
  if (len < 1e-9) return false
  return Math.abs(dx) <= epsRatio * len
}

/**
 * Collect split parameters t in (0,1) for each segment index.
 */
export function splitWallLinesAtJunctions(
  segments: ExtractedLineSegment[],
  opts?: SplitWallLinesAtJunctionsOptions
): { split: ExtractedLineSegment[]; debug: WallJunctionSplitDebug } {
  const T = { ...DEFAULTS, ...opts }
  const n = segments.length
  const junctionEps = T.junctionEpsPt
  const epsRatio = junctionEps / 20

  const splitTs: number[][] = Array.from({ length: n }, () => [])
  let crossingInteriorEvents = 0
  let teeEndpointEvents = 0
  let collinearAxisEvents = 0
  const crossingSeen = new Set<string>()

  const segLen = (i: number) => {
    const s = segments[i]!
    return Math.hypot(s.x2 - s.x1, s.y2 - s.y1)
  }

  const pushT = (i: number, t: number, L: number) => {
    pushTAlongSeg(splitTs, i, t, L, junctionEps)
  }

  for (let i = 0; i < n; i++) {
    const si = segments[i]!

    // Endpoints of i on interior of j
    for (let j = 0; j < n; j++) {
      if (i === j) continue
      const sj = segments[j]!
      const Lj = segLen(j)
      for (const [px, py] of [
        [si.x1, si.y1],
        [si.x2, si.y2],
      ] as const) {
        const { dist, t } = pointSegmentProximity(px, py, sj.x1, sj.y1, sj.x2, sj.y2)
        if (dist <= junctionEps) {
          const before = splitTs[j]!.length
          pushTAlongSeg(splitTs, j, t, Lj, junctionEps)
          if (splitTs[j]!.length > before) teeEndpointEvents++
        }
      }
    }
  }

  for (let i = 0; i < n; i++) {
    const si = segments[i]!
    const Li = segLen(i)
    const mi = interiorMargin(Li, junctionEps)

    for (let j = i + 1; j < n; j++) {
      const sj = segments[j]!
      const Lj = segLen(j)
      const mj = interiorMargin(Lj, junctionEps)

      const ix = lineIntersectionParams(si.x1, si.y1, si.x2, si.y2, sj.x1, sj.y1, sj.x2, sj.y2)
      if (ix) {
        const { t, u } = ix
        const onI = t >= -1e-9 && t <= 1 + 1e-9 && u >= -1e-9 && u <= 1 + 1e-9
        /** Snap near-boundary into [0,1] for near-miss */
        const tt = clampT(t)
        const uu = clampT(u)
        if (!onI) continue

        const crossInterior = tt > mi && tt < 1 - mi && uu > mj && uu < 1 - mj
        if (crossInterior) {
          const key = `${i}-${j}`
          if (!crossingSeen.has(key)) {
            crossingSeen.add(key)
            crossingInteriorEvents++
          }
          pushT(i, tt, Li)
          pushT(j, uu, Lj)
          continue
        }

        // Near intersection: one interior, one endpoint → reinforce T split
        if (tt > mi && tt < 1 - mi && (uu <= mj || uu >= 1 - mj)) pushT(i, tt, Li)
        if (uu > mj && uu < 1 - mj && (tt <= mi || tt >= 1 - mi)) pushT(j, uu, Lj)
        continue
      }

      // Axis-aligned collinear overlap (H–H or V–V)
      const hI = isNearlyHorizontal(si, epsRatio)
      const hJ = isNearlyHorizontal(sj, epsRatio)
      const vI = isNearlyVertical(si, epsRatio)
      const vJ = isNearlyVertical(sj, epsRatio)

      if (hI && hJ) {
        const yi = (si.y1 + si.y2) / 2
        const yj = (sj.y1 + sj.y2) / 2
        if (Math.abs(yi - yj) > junctionEps) continue
        const xiLo = Math.min(si.x1, si.x2)
        const xiHi = Math.max(si.x1, si.x2)
        const xjLo = Math.min(sj.x1, sj.x2)
        const xjHi = Math.max(sj.x1, sj.x2)
        if (Math.max(xiLo, xjLo) >= Math.min(xiHi, xjHi) - junctionEps) continue

        const dxi = si.x2 - si.x1
        const dxj = sj.x2 - sj.x1
        for (const x of [xjLo, xjHi]) {
          if (x <= xiLo || x >= xiHi) continue
          if (Math.abs(dxi) < 1e-9) continue
          const before = splitTs[i]!.length
          pushT(i, (x - si.x1) / dxi, Li)
          if (splitTs[i]!.length > before) collinearAxisEvents++
        }
        for (const x of [xiLo, xiHi]) {
          if (x <= xjLo || x >= xjHi) continue
          if (Math.abs(dxj) < 1e-9) continue
          const before = splitTs[j]!.length
          pushT(j, (x - sj.x1) / dxj, Lj)
          if (splitTs[j]!.length > before) collinearAxisEvents++
        }
        continue
      }

      if (vI && vJ) {
        const xi = (si.x1 + si.x2) / 2
        const xj = (sj.x1 + sj.x2) / 2
        if (Math.abs(xi - xj) > junctionEps) continue
        const yiLo = Math.min(si.y1, si.y2)
        const yiHi = Math.max(si.y1, si.y2)
        const yjLo = Math.min(sj.y1, sj.y2)
        const yjHi = Math.max(sj.y1, sj.y2)
        if (Math.max(yiLo, yjLo) >= Math.min(yiHi, yjHi) - junctionEps) continue

        const dyi = si.y2 - si.y1
        const dyj = sj.y2 - sj.y1
        for (const y of [yjLo, yjHi]) {
          if (y <= yiLo || y >= yiHi) continue
          if (Math.abs(dyi) < 1e-9) continue
          const before = splitTs[i]!.length
          pushT(i, (y - si.y1) / dyi, Li)
          if (splitTs[i]!.length > before) collinearAxisEvents++
        }
        for (const y of [yiLo, yiHi]) {
          if (y <= yjLo || y >= yjHi) continue
          if (Math.abs(dyj) < 1e-9) continue
          const before = splitTs[j]!.length
          pushT(j, (y - sj.y1) / dyj, Lj)
          if (splitTs[j]!.length > before) collinearAxisEvents++
        }
      }
    }
  }

  // Emit split segments
  const out: ExtractedLineSegment[] = []
  let degenerateDropped = 0

  for (let i = 0; i < n; i++) {
    const s = segments[i]!
    const L = segLen(i)
    const mergeTol = Math.max(T.splitMergeTolPt / Math.max(L, 1), 1e-8)
    const raw = mergeSortedTs(splitTs[i]!, mergeTol)
    const pts: number[] = [0, ...raw, 1]

    const dx = s.x2 - s.x1
    const dy = s.y2 - s.y1
    for (let k = 0; k < pts.length - 1; k++) {
      const ta = pts[k]!
      const tb = pts[k + 1]!
      if (tb - ta <= mergeTol * 2) continue
      const ns: ExtractedLineSegment = {
        x1: s.x1 + ta * dx,
        y1: s.y1 + ta * dy,
        x2: s.x1 + tb * dx,
        y2: s.y1 + tb * dy,
        source: s.source,
      }
      const len = segmentLengthPt(ns)
      if (len < T.minSplitEdgeLengthPt) {
        degenerateDropped++
        continue
      }
      out.push(ns)
    }
  }

  const split = dedupeSegments(out, T.dedupeDecimals)
  const SPLIT_SAMPLE = 14
  const splitSample: WallJunctionSplitDebug["splitSample"] = []
  for (let i = 0; i < split.length && splitSample.length < SPLIT_SAMPLE; i++) {
    const s = split[i]!
    splitSample.push({
      x1: s.x1,
      y1: s.y1,
      x2: s.x2,
      y2: s.y2,
      lengthPt: segmentLengthPt(s),
    })
  }

  const notes: string[] = [
    `Junction split: ${n} → ${split.length} segments (eps=${junctionEps}pt); crossings interior=${crossingInteriorEvents}, T endpoint hits=${teeEndpointEvents}, axis-collinear=${collinearAxisEvents}, dropped short=${degenerateDropped}.`,
  ]
  if (n > 0 && split.length > n * 3) notes.push("High split multiplier — check for over-fragmentation or loosen junctionEpsPt.")

  const debug: WallJunctionSplitDebug = {
    junctionEpsPt: junctionEps,
    segmentCountBefore: n,
    segmentCountAfter: split.length,
    crossingInteriorEvents,
    teeEndpointEvents,
    collinearAxisEvents,
    eventCounterSum: crossingInteriorEvents + teeEndpointEvents + collinearAxisEvents,
    degenerateDropped,
    splitSample,
    notes,
  }

  return { split, debug }
}
