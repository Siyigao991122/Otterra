/**
 * Wall-candidate line cleanup before graph reconstruction:
 * axis snap → endpoint snap (union-find) → collinear merge on H/V buckets → dedupe → min length.
 * Coordinates in PDF user units (pt).
 */

import type { ExtractedLineSegment } from "@/lib/geometryFirst/types"

export interface CleanupWallLinesOptions {
  /** Merge stroke endpoints within this distance (centroid per cluster). */
  snapEndpointPt?: number
  /** Max gap along one axis-aligned line to join collinear intervals after snap. */
  mergeGapPt?: number
  /** Segments within this angle of H or V are snapped to exact horizontal/vertical. */
  alignHVAngleDeg?: number
  /** Quantize row (y) / column (x) before merging parallel runs. */
  lineBucketPt?: number
  /** Dedup: endpoints rounded to this many decimals must match (see dedupeDecimals). */
  dedupeDecimals?: number
  /** Drop segments shorter than this after cleanup. */
  minLengthPt?: number
}

const DEFAULTS: Required<CleanupWallLinesOptions> = {
  snapEndpointPt: 1.5,
  mergeGapPt: 1.25,
  alignHVAngleDeg: 2,
  lineBucketPt: 1.0,
  dedupeDecimals: 1,
  minLengthPt: 3,
}

function roundKey(n: number, decimals: number): number {
  const f = 10 ** decimals
  return Math.round(n * f) / f
}

/** Snap near-horizontal / near-vertical strokes to exact axis through midpoint. */
function alignNearHV(s: ExtractedLineSegment, alignDeg: number): ExtractedLineSegment {
  const rad = (alignDeg * Math.PI) / 180
  const dx = s.x2 - s.x1
  const dy = s.y2 - s.y1
  const len = Math.hypot(dx, dy)
  if (len < 1e-9) return { ...s }
  const ang = Math.atan2(Math.abs(dy), Math.abs(dx))
  if (ang <= rad) {
    const y = (s.y1 + s.y2) / 2
    return { ...s, y1: y, y2: y }
  }
  if (Math.PI / 2 - ang <= rad) {
    const x = (s.x1 + s.x2) / 2
    return { ...s, x1: x, x2: x }
  }
  return { ...s }
}

function snapEndpoints(segments: ExtractedLineSegment[], eps: number): ExtractedLineSegment[] {
  const nSeg = segments.length
  if (nSeg === 0) return []
  const nPt = nSeg * 2
  const xs: number[] = new Array(nPt)
  const ys: number[] = new Array(nPt)
  for (let i = 0; i < nSeg; i++) {
    const s = segments[i]
    xs[2 * i] = s.x1
    ys[2 * i] = s.y1
    xs[2 * i + 1] = s.x2
    ys[2 * i + 1] = s.y2
  }
  const parent = new Uint32Array(nPt)
  for (let i = 0; i < nPt; i++) parent[i] = i
  function find(a: number): number {
    let x = a
    while (parent[x] !== x) x = parent[x]
    let b = a
    while (parent[b] !== b) {
      const n = parent[b]
      parent[b] = x
      b = n
    }
    return x
  }
  function union(a: number, b: number): void {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[rb] = ra
  }
  const eps2 = eps * eps
  for (let i = 0; i < nPt; i++) {
    for (let j = i + 1; j < nPt; j++) {
      const ddx = xs[i] - xs[j]
      const ddy = ys[i] - ys[j]
      if (ddx * ddx + ddy * ddy <= eps2) union(i, j)
    }
  }
  const sumX = new Float64Array(nPt)
  const sumY = new Float64Array(nPt)
  const count = new Uint32Array(nPt)
  for (let i = 0; i < nPt; i++) {
    const r = find(i)
    sumX[r] += xs[i]
    sumY[r] += ys[i]
    count[r]++
  }
  const outXs = new Float64Array(nPt)
  const outYs = new Float64Array(nPt)
  for (let i = 0; i < nPt; i++) {
    const r = find(i)
    const c = count[r]
    outXs[i] = sumX[r] / c
    outYs[i] = sumY[r] / c
  }
  return segments.map((s, si) => ({
    ...s,
    x1: outXs[2 * si],
    y1: outYs[2 * si],
    x2: outXs[2 * si + 1],
    y2: outYs[2 * si + 1],
  }))
}

type Interval1D = { a0: number; a1: number; p: number; src?: string }

function classifyHV(
  s: ExtractedLineSegment,
  alignDeg: number
): { kind: "h"; y: number; x0: number; x1: number; src?: string } | { kind: "v"; x: number; y0: number; y1: number; src?: string } | null {
  const rad = (alignDeg * Math.PI) / 180
  const ang = Math.atan2(Math.abs(s.y2 - s.y1), Math.abs(s.x2 - s.x1))
  if (ang <= rad) {
    const y = (s.y1 + s.y2) / 2
    const x0 = Math.min(s.x1, s.x2)
    const x1 = Math.max(s.x1, s.x2)
    return { kind: "h", y, x0, x1, src: s.source }
  }
  if (Math.PI / 2 - ang <= rad) {
    const x = (s.x1 + s.x2) / 2
    const y0 = Math.min(s.y1, s.y2)
    const y1 = Math.max(s.y1, s.y2)
    return { kind: "v", x, y0, y1, src: s.source }
  }
  return null
}

function mergeIntervals1D(items: Interval1D[], mergeGap: number): Interval1D[] {
  if (items.length === 0) return []
  const sorted = [...items].sort((u, v) => u.p - v.p || u.a0 - v.a0)
  const out: Interval1D[] = []
  let cur = { ...sorted[0] }
  for (let i = 1; i < sorted.length; i++) {
    const n = sorted[i]
    if (Math.abs(n.p - cur.p) > 1e-9) {
      out.push(cur)
      cur = { ...n }
      continue
    }
    if (n.a0 <= cur.a1 + mergeGap) {
      cur.a1 = Math.max(cur.a1, n.a1)
      cur.p = (cur.p + n.p) / 2
    } else {
      out.push(cur)
      cur = { ...n }
    }
  }
  out.push(cur)
  return out
}

function mergeCollinearHV(
  segments: ExtractedLineSegment[],
  mergeGap: number,
  bucket: number,
  alignDeg: number
): ExtractedLineSegment[] {
  const horiz: Interval1D[] = []
  const vert: Interval1D[] = []
  const other: ExtractedLineSegment[] = []

  for (const s of segments) {
    const hv = classifyHV(s, alignDeg)
    if (!hv) {
      other.push(s)
      continue
    }
    if (hv.kind === "h") {
      const yb = Math.round(hv.y / bucket) * bucket
      horiz.push({ a0: hv.x0, a1: hv.x1, p: yb, src: hv.src })
    } else {
      const xb = Math.round(hv.x / bucket) * bucket
      vert.push({ a0: hv.y0, a1: hv.y1, p: xb, src: hv.src })
    }
  }

  const mergedH = mergeIntervals1D(horiz, mergeGap)
  const mergedV = mergeIntervals1D(vert, mergeGap)
  const out: ExtractedLineSegment[] = []

  for (const h of mergedH) {
    const y = h.p
    out.push({
      x1: h.a0,
      y1: y,
      x2: h.a1,
      y2: y,
      source: "pdf-operator-list",
    })
  }
  for (const v of mergedV) {
    const x = v.p
    out.push({
      x1: x,
      y1: v.a0,
      x2: x,
      y2: v.a1,
      source: "pdf-operator-list",
    })
  }
  for (const s of other) {
    out.push({ ...s })
  }
  return out
}

function dedupeSegments(segments: ExtractedLineSegment[], decimals: number): ExtractedLineSegment[] {
  const seen = new Set<string>()
  const out: ExtractedLineSegment[] = []
  for (const s of segments) {
    const r = (n: number) => roundKey(n, decimals)
    const A = `${r(s.x1)},${r(s.y1)},${r(s.x2)},${r(s.y2)}`
    const B = `${r(s.x2)},${r(s.y2)},${r(s.x1)},${r(s.y1)}`
    const k = A < B ? A : B
    if (seen.has(k)) continue
    seen.add(k)
    out.push(s)
  }
  return out
}

export function segmentLengthPt(s: ExtractedLineSegment): number {
  return Math.hypot(s.x2 - s.x1, s.y2 - s.y1)
}

export function cleanupWallCandidateLines(
  segments: ExtractedLineSegment[],
  opts?: CleanupWallLinesOptions
): {
  cleaned: ExtractedLineSegment[]
  beforeCount: number
  afterCount: number
  thresholds: {
    snapEndpointPt: number
    mergeGapPt: number
    alignHVAngleDeg: number
    lineBucketPt: number
    dedupeDecimals: number
    minLengthPt: number
  }
} {
  const T = { ...DEFAULTS, ...opts }
  const beforeCount = segments.length
  let s = segments.map((seg) => alignNearHV(seg, T.alignHVAngleDeg))
  s = snapEndpoints(s, T.snapEndpointPt)
  s = mergeCollinearHV(s, T.mergeGapPt, T.lineBucketPt, T.alignHVAngleDeg)
  s = dedupeSegments(s, T.dedupeDecimals)
  s = s.filter((seg) => segmentLengthPt(seg) >= T.minLengthPt)
  return {
    cleaned: s,
    beforeCount,
    afterCount: s.length,
    thresholds: {
      snapEndpointPt: T.snapEndpointPt,
      mergeGapPt: T.mergeGapPt,
      alignHVAngleDeg: T.alignHVAngleDeg,
      lineBucketPt: T.lineBucketPt,
      dedupeDecimals: T.dedupeDecimals,
      minLengthPt: T.minLengthPt,
    },
  }
}
