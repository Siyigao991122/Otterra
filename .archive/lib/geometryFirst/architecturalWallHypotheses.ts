/**
 * Experimental layer: group PDF line evidence into coarse **architectural wall hypotheses**
 * (paired double lines, collinear merges, long structural singletons).
 *
 * Runs **after** wall-candidate cleanup + main structural selection (debug / future reconstruction).
 * Not used for routing or production layout yet.
 */

import type { ExtractedLineSegment, ExtractedTextRun, PlanBoundingBox } from "@/lib/geometryFirst/types"
import { segmentAngleClass, segmentLengthPdfUnits } from "@/lib/geometryFirst/linePrimitiveDenoise"
import type { SegmentAngleClass } from "@/lib/geometryFirst/linePrimitiveDenoise"
import {
  areDirectionsParallel,
  overlapRatioParallelSegments,
  parallelLineGapPt,
  projectionInterval,
} from "@/lib/geometryFirst/mainStructuralWallSelector"

export type WallHypothesisSupportType = "paired" | "singleton" | "merged-run"

export type WallHypothesisOrientation = "horizontal" | "vertical" | "diagonal"

export interface WallHypothesisCenterline {
  x1: number
  y1: number
  x2: number
  y2: number
}

/** One architectural wall object hypothesis derived from vector segments. */
export interface ArchitecturalWallHypothesis {
  id: string
  centerline: WallHypothesisCenterline
  /** Perpendicular gap between paired strokes (PDF pt) when paired; else null. */
  thicknessEstimate: number | null
  supportType: WallHypothesisSupportType
  length: number
  orientation: WallHypothesisOrientation
  /** Combined evidence strength in [0, 1] (length, pairing, multiplicity, structural hits). */
  supportScore: number
  /** Heuristic: stroke likely part of shell / perimeter wall. */
  exteriorLikelihood: number
  /** Heuristic: stroke likely interior partition (mid-plan or room-labeled). */
  interiorLikelihood: number
  /** Stable refs into the cleaned-candidate list, e.g. `c:12`. */
  sourceSegmentIds: string[]
}

export interface ArchitecturalWallHypothesesDebugSummary {
  totalHypotheses: number
  pairedCount: number
  singletonCount: number
  mergedRunCount: number
  /** Mean thickness over hypotheses with non-null thickness; null if none paired. */
  averageThicknessEstimate: number | null
  topBySupportScore: Array<{
    id: string
    supportScore: number
    supportType: WallHypothesisSupportType
    length: number
  }>
}

/** One SVG polyline suitable for debug overlays (PDF user space, y-up as in source). */
export interface WallHypothesisSvgStroke {
  id: string
  d: string
  /** Suggested stroke width in PDF units (thickness or fallback). */
  strokeWidthSuggested: number
  /** Optional: classify strokes when layering debug SVG. */
  supportType?: WallHypothesisSupportType
  supportScore?: number
}

export interface ArchitecturalWallHypothesesDebugPayload {
  summary: ArchitecturalWallHypothesesDebugSummary
  hypotheses: ArchitecturalWallHypothesis[]
  svgStrokes: WallHypothesisSvgStroke[]
}

export interface BuildArchitecturalWallHypothesesOptions {
  angleToleranceDeg?: number
  /** Min length (pt) for segments considered in pairing. */
  minPairLengthPt?: number
  minPairOverlapRatio?: number
  minPairGapPt?: number
  maxPairGapPt?: number
  /** Reference length for score normalization (pt). */
  referenceLengthPt?: number
  /** Max gap along axis to merge 1D intervals in a collinear run (pt). */
  mergeGapAlongLinePt?: number
  /** Bucket size for grouping parallel strokes (pt). */
  collinearBucketPt?: number
  /** Structural singletons must be at least this long (pt). */
  minStructuralSingletonLengthPt?: number
  maxHypothesesInPayload?: number
  maxSvgStrokesInPayload?: number
}

const OPT_DEFAULTS: Required<
  Pick<
    BuildArchitecturalWallHypothesesOptions,
    | "angleToleranceDeg"
    | "minPairLengthPt"
    | "minPairOverlapRatio"
    | "minPairGapPt"
    | "maxPairGapPt"
    | "referenceLengthPt"
    | "mergeGapAlongLinePt"
    | "collinearBucketPt"
    | "minStructuralSingletonLengthPt"
    | "maxHypothesesInPayload"
    | "maxSvgStrokesInPayload"
  >
> = {
  angleToleranceDeg: 6,
  minPairLengthPt: 6,
  minPairOverlapRatio: 0.12,
  minPairGapPt: 0.8,
  maxPairGapPt: 26,
  referenceLengthPt: 72,
  mergeGapAlongLinePt: 4,
  collinearBucketPt: 2,
  minStructuralSingletonLengthPt: 20,
  maxHypothesesInPayload: 220,
  maxSvgStrokesInPayload: 96,
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x))
}

function hypot(dx: number, dy: number): number {
  return Math.hypot(dx, dy)
}

function unitDir(s: ExtractedLineSegment): { ux: number; uy: number; len: number } {
  const dx = s.x2 - s.x1
  const dy = s.y2 - s.y1
  const len = hypot(dx, dy)
  if (len < 1e-12) return { ux: 1, uy: 0, len: 0 }
  return { ux: dx / len, uy: dy / len, len }
}

function midpoint(s: ExtractedLineSegment): { x: number; y: number } {
  return { x: (s.x1 + s.x2) / 2, y: (s.y1 + s.y2) / 2 }
}

function cleanedId(i: number): string {
  return `c:${i}`
}

export function segmentsNearlyEqual(a: ExtractedLineSegment, b: ExtractedLineSegment, eps = 0.75): boolean {
  return (
    (Math.abs(a.x1 - b.x1) < eps &&
      Math.abs(a.y1 - b.y1) < eps &&
      Math.abs(a.x2 - b.x2) < eps &&
      Math.abs(a.y2 - b.y2) < eps) ||
    (Math.abs(a.x1 - b.x2) < eps &&
      Math.abs(a.y1 - b.y2) < eps &&
      Math.abs(a.x2 - b.x1) < eps &&
      Math.abs(a.y2 - b.y1) < eps)
  )
}

function buildStructuralIndexSet(
  cleaned: ExtractedLineSegment[],
  structural: ExtractedLineSegment[],
  eps: number
): Set<number> {
  const out = new Set<number>()
  for (const st of structural) {
    for (let i = 0; i < cleaned.length; i++) {
      if (segmentsNearlyEqual(st, cleaned[i]!, eps)) {
        out.add(i)
        break
      }
    }
  }
  return out
}

function orientationFromClass(ac: SegmentAngleClass): WallHypothesisOrientation {
  if (ac === "horizontal" || ac === "vertical") return ac
  return "diagonal"
}

/** Shortest distance from an **interior** point of the bbox to its boundary (PDF pt). */
function clearanceToPageBounds(px: number, py: number, b: PlanBoundingBox): number {
  if (px < b.minX || px > b.maxX || py < b.minY || py > b.maxY) return 0
  return Math.min(px - b.minX, b.maxX - px, py - b.minY, b.maxY - py)
}

const ROOM_LABEL_RE = /\b(bed|bath|kit|kitchen|liv|living|din|dining|room|closet|wc|balc|balcony|foyer|entry|study|office)\b/i

function interiorTextBoost(px: number, py: number, texts: ExtractedTextRun[], radiusPt: number): number {
  const r2 = radiusPt * radiusPt
  for (const t of texts) {
    if (!ROOM_LABEL_RE.test(t.text)) continue
    const cx = t.x + (t.width ?? 0) / 2
    const cy = t.y + (t.height ?? 0) / 2
    const dx = px - cx
    const dy = py - cy
    if (dx * dx + dy * dy <= r2) return 0.28
  }
  return 0
}

function likelihoodFromContext(
  mid: { x: number; y: number },
  pageBounds: PlanBoundingBox,
  texts: ExtractedTextRun[]
): { exteriorLikelihood: number; interiorLikelihood: number } {
  const d = clearanceToPageBounds(mid.x, mid.y, pageBounds)
  const edgeSoft = 55
  const exteriorLikelihood = clamp01(1 - d / edgeSoft)
  const interiorLikelihood = clamp01(d / 95) * 0.72 + interiorTextBoost(mid.x, mid.y, texts, 32)
  return { exteriorLikelihood, interiorLikelihood: clamp01(interiorLikelihood) }
}

function centerlineFromParallelPair(a: ExtractedLineSegment, b: ExtractedLineSegment): WallHypothesisCenterline | null {
  const { ux, uy, len: la } = unitDir(a)
  if (la < 1e-9) return null
  const midA = midpoint(a)
  const midB = midpoint(b)
  const nx = -uy
  const ny = ux
  const signed = (midB.x - midA.x) * nx + (midB.y - midA.y) * ny
  /** Midline between the two strokes along the shared normal (≈ gap/2 when lines are parallel). */
  const half = signed / 2

  const ia = projectionInterval(a, ux, uy)
  const ib = projectionInterval(b, ux, uy)
  const L = Math.max(ia.lo, ib.lo)
  const R = Math.min(ia.hi, ib.hi)
  if (R - L < 0.5) return null

  const dotA1 = a.x1 * ux + a.y1 * uy
  const x1 = a.x1 + (L - dotA1) * ux + nx * half
  const y1 = a.y1 + (L - dotA1) * uy + ny * half
  const x2 = a.x1 + (R - dotA1) * ux + nx * half
  const y2 = a.y1 + (R - dotA1) * uy + ny * half
  return { x1, y1, x2, y2 }
}

interface PairCand {
  i: number
  j: number
  gap: number
  overlap: number
  score: number
}

function mergeIntervals1D(intervals: Array<[number, number]>, mergeGap: number): Array<[number, number]> {
  if (intervals.length === 0) return []
  const s = [...intervals].sort((a, b) => a[0] - b[0])
  const out: Array<[number, number]> = []
  let cs = s[0]![0]
  let ce = s[0]![1]
  for (let k = 1; k < s.length; k++) {
    const [a, b] = s[k]!
    if (a <= ce + mergeGap) ce = Math.max(ce, b)
    else {
      out.push([cs, ce])
      cs = a
      ce = b
    }
  }
  out.push([cs, ce])
  return out
}

let _hypothesisSerial = 0

/**
 * Build wall hypotheses from cleaned segments + strictly-selected structural subset.
 */
export function buildArchitecturalWallHypotheses(
  cleanedSegments: ExtractedLineSegment[],
  structuralSegments: ExtractedLineSegment[],
  texts: ExtractedTextRun[],
  pageBounds: PlanBoundingBox,
  opts?: BuildArchitecturalWallHypothesesOptions
): ArchitecturalWallHypothesesDebugPayload {
  const O = { ...OPT_DEFAULTS, ...opts }
  const angleTol = O.angleToleranceDeg
  const refLen = O.referenceLengthPt
  const parallelDeg = 6

  const structuralIdx = buildStructuralIndexSet(cleanedSegments, structuralSegments, 0.85)
  const n = cleanedSegments.length
  const used = new Set<number>()
  const hypotheses: ArchitecturalWallHypothesis[] = []

  const pairCands: PairCand[] = []
  for (let i = 0; i < n; i++) {
    const si = cleanedSegments[i]!
    const Li = segmentLengthPdfUnits(si)
    if (Li < O.minPairLengthPt) continue
    const { ux: uxi, uy: uyi } = unitDir(si)
    const mi = midpoint(si)
    for (let j = i + 1; j < n; j++) {
      const sj = cleanedSegments[j]!
      const Lj = segmentLengthPdfUnits(sj)
      if (Lj < O.minPairLengthPt) continue
      const { ux: uxj, uy: uyj } = unitDir(sj)
      if (!areDirectionsParallel(uxi, uyi, uxj, uyj, parallelDeg)) continue
      const gap = parallelLineGapPt(mi.x, mi.y, uxi, uyi, midpoint(sj).x, midpoint(sj).y)
      if (gap < O.minPairGapPt || gap > O.maxPairGapPt) continue
      const overlap = overlapRatioParallelSegments(si, sj, uxi, uyi)
      if (overlap < O.minPairOverlapRatio) continue
      const score = overlap * Math.min(Li, Lj) / refLen
      pairCands.push({ i, j, gap, overlap, score })
    }
  }
  pairCands.sort((a, b) => b.score - a.score)

  for (const p of pairCands) {
    if (used.has(p.i) || used.has(p.j)) continue
    const sa = cleanedSegments[p.i]!
    const sb = cleanedSegments[p.j]!
    const cl = centerlineFromParallelPair(sa, sb)
    if (!cl) continue
    const len = hypot(cl.x2 - cl.x1, cl.y2 - cl.y1)
    if (len < 2) continue
    used.add(p.i)
    used.add(p.j)
    const mid = { x: (cl.x1 + cl.x2) / 2, y: (cl.y1 + cl.y2) / 2 }
    const { exteriorLikelihood, interiorLikelihood } = likelihoodFromContext(mid, pageBounds, texts)
    const stHit = (structuralIdx.has(p.i) ? 1 : 0) + (structuralIdx.has(p.j) ? 1 : 0)
    const lenNorm = Math.min(1, len / refLen)
    const supportScore = clamp01(
      0.34 + lenNorm * 0.34 + p.overlap * 0.42 + stHit * 0.12
    )
    hypotheses.push({
      id: `wall:hyp:paired:${_hypothesisSerial++}`,
      centerline: cl,
      thicknessEstimate: p.gap,
      supportType: "paired",
      length: len,
      orientation: orientationFromClass(segmentAngleClass(sa, angleTol)),
      supportScore,
      exteriorLikelihood,
      interiorLikelihood,
      sourceSegmentIds: [cleanedId(p.i), cleanedId(p.j)],
    })
  }

  type Unpaired = { idx: number; seg: ExtractedLineSegment; ac: SegmentAngleClass }
  const unpaired: Unpaired[] = []
  for (let i = 0; i < n; i++) {
    if (used.has(i)) continue
    const seg = cleanedSegments[i]!
    if (segmentLengthPdfUnits(seg) < 3) continue
    unpaired.push({ idx: i, seg, ac: segmentAngleClass(seg, angleTol) })
  }

  const horiz = unpaired.filter((u) => u.ac === "horizontal")
  const bucketsH = new Map<number, Unpaired[]>()
  for (const u of horiz) {
    const my = (u.seg.y1 + u.seg.y2) / 2
    const key = Math.round(my / O.collinearBucketPt) * O.collinearBucketPt
    const arr = bucketsH.get(key) ?? []
    arr.push(u)
    bucketsH.set(key, arr)
  }
  for (const [, group] of bucketsH) {
    const intervals: Array<{ idx: number; lo: number; hi: number }> = []
    for (const u of group) {
      const lo = Math.min(u.seg.x1, u.seg.x2)
      const hi = Math.max(u.seg.x1, u.seg.x2)
      intervals.push({ idx: u.idx, lo, hi })
    }
    const ivals: Array<[number, number]> = intervals.map((it) => [it.lo, it.hi])
    const merged = mergeIntervals1D(ivals, O.mergeGapAlongLinePt)
    for (const [a, b] of merged) {
      const contributors = intervals.filter((it) => it.hi >= a - 0.5 && it.lo <= b + 0.5)
      const idxs = [...new Set(contributors.map((c) => c.idx))]
      if (idxs.length < 2) continue
      const y =
        idxs.reduce((s, id) => {
          const s0 = cleanedSegments[id]!
          return s + (s0.y1 + s0.y2) / 2
        }, 0) / idxs.length
      idxs.forEach((id) => {
        used.add(id)
      })
      const cl: WallHypothesisCenterline = { x1: a, y1: y, x2: b, y2: y }
      const len = b - a
      const mid = { x: (a + b) / 2, y }
      const { exteriorLikelihood, interiorLikelihood } = likelihoodFromContext(mid, pageBounds, texts)
      const stHit = idxs.some((id) => structuralIdx.has(id)) ? 1 : 0
      const lenNorm = Math.min(1, len / refLen)
      const supportScore = clamp01(0.3 + lenNorm * 0.36 + Math.min(0.28, idxs.length * 0.07) + stHit * 0.1)
      hypotheses.push({
        id: `wall:hyp:merged:${_hypothesisSerial++}`,
        centerline: cl,
        thicknessEstimate: null,
        supportType: "merged-run",
        length: len,
        orientation: "horizontal",
        supportScore,
        exteriorLikelihood,
        interiorLikelihood,
        sourceSegmentIds: idxs.map(cleanedId),
      })
    }
  }

  const vert = unpaired.filter((u) => u.ac === "vertical" && !used.has(u.idx))
  const bucketsV = new Map<number, Unpaired[]>()
  for (const u of vert) {
    if (used.has(u.idx)) continue
    const mx = (u.seg.x1 + u.seg.x2) / 2
    const key = Math.round(mx / O.collinearBucketPt) * O.collinearBucketPt
    const arr = bucketsV.get(key) ?? []
    arr.push(u)
    bucketsV.set(key, arr)
  }
  for (const [, group] of bucketsV) {
    const intervals: Array<{ idx: number; lo: number; hi: number }> = []
    for (const u of group) {
      if (used.has(u.idx)) continue
      const lo = Math.min(u.seg.y1, u.seg.y2)
      const hi = Math.max(u.seg.y1, u.seg.y2)
      intervals.push({ idx: u.idx, lo, hi })
    }
    const ivals: Array<[number, number]> = intervals.map((it) => [it.lo, it.hi])
    const merged = mergeIntervals1D(ivals, O.mergeGapAlongLinePt)
    for (const [a, b] of merged) {
      const contributors = intervals.filter((it) => it.hi >= a - 0.5 && it.lo <= b + 0.5)
      const idxs = [...new Set(contributors.map((c) => c.idx))].filter((id) => !used.has(id))
      if (idxs.length < 2) continue
      const x =
        idxs.reduce((s, id) => {
          const s0 = cleanedSegments[id]!
          return s + (s0.x1 + s0.x2) / 2
        }, 0) / idxs.length
      idxs.forEach((id) => used.add(id))
      const cl: WallHypothesisCenterline = { x1: x, y1: a, x2: x, y2: b }
      const len = b - a
      const mid = { x, y: (a + b) / 2 }
      const { exteriorLikelihood, interiorLikelihood } = likelihoodFromContext(mid, pageBounds, texts)
      const stHit = idxs.some((id) => structuralIdx.has(id)) ? 1 : 0
      const lenNorm = Math.min(1, len / refLen)
      const supportScore = clamp01(0.3 + lenNorm * 0.36 + Math.min(0.28, idxs.length * 0.07) + stHit * 0.1)
      hypotheses.push({
        id: `wall:hyp:merged:${_hypothesisSerial++}`,
        centerline: cl,
        thicknessEstimate: null,
        supportType: "merged-run",
        length: len,
        orientation: "vertical",
        supportScore,
        exteriorLikelihood,
        interiorLikelihood,
        sourceSegmentIds: idxs.map(cleanedId),
      })
    }
  }

  for (let i = 0; i < n; i++) {
    if (used.has(i)) continue
    if (!structuralIdx.has(i)) continue
    const seg = cleanedSegments[i]!
    const len = segmentLengthPdfUnits(seg)
    if (len < O.minStructuralSingletonLengthPt) continue
    const cl: WallHypothesisCenterline = { x1: seg.x1, y1: seg.y1, x2: seg.x2, y2: seg.y2 }
    const mid = midpoint(seg)
    const { exteriorLikelihood, interiorLikelihood } = likelihoodFromContext(mid, pageBounds, texts)
    const lenNorm = Math.min(1, len / refLen)
    const supportScore = clamp01(0.26 + lenNorm * 0.52 + 0.2)
    used.add(i)
    hypotheses.push({
      id: `wall:hyp:singleton:${_hypothesisSerial++}`,
      centerline: cl,
      thicknessEstimate: null,
      supportType: "singleton",
      length: len,
      orientation: orientationFromClass(segmentAngleClass(seg, angleTol)),
      supportScore,
      exteriorLikelihood,
      interiorLikelihood,
      sourceSegmentIds: [cleanedId(i)],
    })
  }

  const pairedCount = hypotheses.filter((h) => h.supportType === "paired").length
  const singletonCount = hypotheses.filter((h) => h.supportType === "singleton").length
  const mergedRunCount = hypotheses.filter((h) => h.supportType === "merged-run").length
  const thickVals = hypotheses.map((h) => h.thicknessEstimate).filter((t): t is number => t != null && t > 0)
  const averageThicknessEstimate =
    thickVals.length > 0 ? thickVals.reduce((a, b) => a + b, 0) / thickVals.length : null

  const topBySupportScore = [...hypotheses]
    .sort((a, b) => b.supportScore - a.supportScore)
    .slice(0, 14)
    .map((h) => ({
      id: h.id,
      supportScore: h.supportScore,
      supportType: h.supportType,
      length: h.length,
    }))

  const summary: ArchitecturalWallHypothesesDebugSummary = {
    totalHypotheses: hypotheses.length,
    pairedCount,
    singletonCount,
    mergedRunCount,
    averageThicknessEstimate,
    topBySupportScore,
  }

  hypotheses.sort((a, b) => b.supportScore - a.supportScore)

  const capH = O.maxHypothesesInPayload
  const capSvg = O.maxSvgStrokesInPayload
  const hypOut = hypotheses.slice(0, capH)
  const svgStrokes = wallHypothesesToSvgStrokes(hypOut.slice(0, capSvg))

  return { summary, hypotheses: hypOut, svgStrokes }
}

export function wallHypothesesToSvgStrokes(hypotheses: ArchitecturalWallHypothesis[]): WallHypothesisSvgStroke[] {
  return hypotheses.map((h) => {
    const { x1, y1, x2, y2 } = h.centerline
    const d = `M ${x1.toFixed(2)} ${y1.toFixed(2)} L ${x2.toFixed(2)} ${y2.toFixed(2)}`
    const strokeWidthSuggested = h.thicknessEstimate != null ? Math.max(0.75, h.thicknessEstimate * 0.35) : 2
    return {
      id: h.id,
      d,
      strokeWidthSuggested,
      supportType: h.supportType,
      supportScore: h.supportScore,
    }
  })
}
