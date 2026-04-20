/**
 * Experimental **global structural spans** — layout-scale axis evidence from cleaned candidates.
 * Complements local strict/extended rescue; does **not** select an exterior shell.
 * Debug / tuning only — not used for production routing.
 */

import type { ExtractedLineSegment, PlanBoundingBox } from "@/lib/geometryFirst/types"
import { unionSegmentBbox } from "@/lib/geometryFirst/debugMainStructuralWallSvg"
import type { SegmentAngleClass } from "@/lib/geometryFirst/linePrimitiveDenoise"
import { segmentAngleClass, segmentLengthPdfUnits } from "@/lib/geometryFirst/linePrimitiveDenoise"

export type GlobalSpanOrientation = "horizontal" | "vertical" | "diagonal"

export interface GlobalStructuralSpanCenterline {
  x1: number
  y1: number
  x2: number
  y2: number
}

/** One aggregated layout-scale span (mostly collinear H/V runs — optional long diagonals). */
export interface GlobalStructuralSpan {
  id: string
  orientation: GlobalSpanOrientation
  centerline: GlobalStructuralSpanCenterline
  spanLength: number
  sourceSegmentCount: number
  /** [0,1] — mean centerline samples close to cleaned-candidate envelope boundary. */
  nearEnvelopeScore: number
  /** [0,1] — length, multiplicity, local mass under neighborhood. */
  structuralSupportScore: number
  /** [0,1] — combined hint this span could belong to a perimeter / shell band (not a selector). */
  shellHintScore: number
  sourceSegmentIds: string[]
}

export interface GlobalStructuralSpanOrientationDistribution {
  horizontal: number
  vertical: number
  diagonal: number
}

export interface GlobalStructuralSpansDebugSummary {
  totalSpanCount: number
  topBySpanLength: Array<{ id: string; spanLength: number; orientation: GlobalSpanOrientation; shellHintScore: number }>
  topByShellHintScore: Array<{ id: string; shellHintScore: number; spanLength: number; orientation: GlobalSpanOrientation }>
  orientationDistribution: GlobalStructuralSpanOrientationDistribution
}

export interface GlobalStructuralSpansDebugPayload {
  summary: GlobalStructuralSpansDebugSummary
  spans: GlobalStructuralSpan[]
  /** SVG path `d` per span (same centerline as `spans`, PDF user space). */
  svgStrokes: GlobalStructuralSpanSvgStroke[]
}

export interface GlobalStructuralSpanSvgStroke {
  id: string
  d: string
  strokeWidthSuggested: number
  shellHintScore?: number
}

export interface BuildGlobalStructuralSpansOptions {
  angleToleranceDeg?: number
  collinearBucketPt?: number
  mergeGapAlongAxisPt?: number
  minSpanLengthPt?: number
  envelopeScoreBandRefPt?: number
  referenceLengthPt?: number
  localGroupRadiusPt?: number
  localGroupSpanRefPt?: number
  /** Min length for standalone diagonal spans (no cross-bucket merge). */
  minDiagonalSpanLengthPt?: number
  maxSpansInPayload?: number
  /**
   * Debug: envelope for `nearEnvelopeScore`, `perimeterBandHint`, and `maxDim` normalization.
   * Defaults to axis-aligned union of `cleanedSegments`.
   */
  scoringEnvelope?: PlanBoundingBox
  /**
   * Debug: when `cleanedSegments` is a subset (e.g. robust inliers), maps local index → original cleaned index for `sourceSegmentIds`.
   */
  originalCleanedIndices?: number[]
}

type BuildGlobalStructuralSpansNumericOptions = Omit<
  BuildGlobalStructuralSpansOptions,
  "scoringEnvelope" | "originalCleanedIndices"
>

const OPT: Required<BuildGlobalStructuralSpansNumericOptions> = {
  angleToleranceDeg: 6,
  collinearBucketPt: 2.5,
  mergeGapAlongAxisPt: 5,
  minSpanLengthPt: 36,
  envelopeScoreBandRefPt: 72,
  referenceLengthPt: 96,
  localGroupRadiusPt: 80,
  localGroupSpanRefPt: 140,
  minDiagonalSpanLengthPt: 52,
  maxSpansInPayload: 420,
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x))
}

function cleanedId(i: number): string {
  return `c:${i}`
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

function clearanceToEnvelope(px: number, py: number, env: PlanBoundingBox): number {
  if (px >= env.minX && px <= env.maxX && py >= env.minY && py <= env.maxY) {
    return Math.min(px - env.minX, env.maxX - px, py - env.minY, env.maxY - py)
  }
  const dx = px < env.minX ? env.minX - px : px > env.maxX ? px - env.maxX : 0
  const dy = py < env.minY ? env.minY - py : py > env.maxY ? py - env.maxY : 0
  return Math.hypot(dx, dy)
}

function sampleCenterline(
  cl: GlobalStructuralSpanCenterline,
  n: number
): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = []
  for (let k = 0; k < n; k++) {
    const t = n === 1 ? 0.5 : k / (n - 1)
    out.push({
      x: cl.x1 + t * (cl.x2 - cl.x1),
      y: cl.y1 + t * (cl.y2 - cl.y1),
    })
  }
  return out
}

function meanNearEnvelopeScore(
  cl: GlobalStructuralSpanCenterline,
  env: PlanBoundingBox,
  bandRef: number
): number {
  const samples = sampleCenterline(cl, 5)
  let acc = 0
  for (const p of samples) {
    const d = clearanceToEnvelope(p.x, p.y, env)
    acc += clamp01(1 - d / bandRef)
  }
  return acc / samples.length
}

function perimeterBandHint(
  cl: GlobalStructuralSpanCenterline,
  orientation: GlobalSpanOrientation,
  env: PlanBoundingBox,
  band: number
): number {
  const mx = (cl.x1 + cl.x2) / 2
  const my = (cl.y1 + cl.y2) / 2
  if (orientation === "horizontal") {
    const dLo = my - env.minY
    const dHi = env.maxY - my
    const edge = Math.min(dLo, dHi)
    return clamp01(1 - edge / band)
  }
  if (orientation === "vertical") {
    const dLo = mx - env.minX
    const dHi = env.maxX - mx
    const edge = Math.min(dLo, dHi)
    return clamp01(1 - edge / band)
  }
  const c = Math.min(clearanceToEnvelope(mx, my, env), clearanceToEnvelope(cl.x1, cl.y1, env), clearanceToEnvelope(cl.x2, cl.y2, env))
  return clamp01(1 - c / band)
}

function sumLengthInDisk(
  cx: number,
  cy: number,
  segments: ExtractedLineSegment[],
  mids: Array<{ x: number; y: number }>,
  radiusPt: number
): number {
  const r2 = radiusPt * radiusPt
  let sum = 0
  for (let j = 0; j < segments.length; j++) {
    const m = mids[j]!
    const dx = m.x - cx
    const dy = m.y - cy
    if (dx * dx + dy * dy <= r2) {
      sum += segmentLengthPdfUnits(segments[j]!)
    }
  }
  return sum
}

function midpoint(s: ExtractedLineSegment): { x: number; y: number } {
  return { x: (s.x1 + s.x2) / 2, y: (s.y1 + s.y2) / 2 }
}

let _gspanSerial = 0

/**
 * Build global structural spans from cleaned wall candidates (PDF pt).
 */
export function buildGlobalStructuralSpans(
  cleanedSegments: ExtractedLineSegment[],
  /** Page / sheet bounds (fallback if cleaned envelope is degenerate). */
  pageBounds: PlanBoundingBox,
  opts?: BuildGlobalStructuralSpansOptions
): GlobalStructuralSpansDebugPayload {
  const O = { ...OPT, ...opts }
  const angleTol = O.angleToleranceDeg
  const envelope = opts?.scoringEnvelope ?? unionSegmentBbox(cleanedSegments) ?? pageBounds
  const originalCleanedIndices = opts?.originalCleanedIndices
  const envW = envelope.maxX - envelope.minX
  const envH = envelope.maxY - envelope.minY
  const maxDim = Math.max(1e-6, envW, envH)

  const n = cleanedSegments.length
  const mids = cleanedSegments.map(midpoint)

  type Tagged = { idx: number; seg: ExtractedLineSegment; ac: SegmentAngleClass }
  const tagged: Tagged[] = []
  for (let i = 0; i < n; i++) {
    const seg = cleanedSegments[i]!
    if (segmentLengthPdfUnits(seg) < 2) continue
    tagged.push({ idx: i, seg, ac: segmentAngleClass(seg, angleTol) })
  }

  const spans: GlobalStructuralSpan[] = []

  const horiz = tagged.filter((t) => t.ac === "horizontal")
  const bucketsH = new Map<number, Tagged[]>()
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
    const ivals = intervals.map((it) => [it.lo, it.hi] as [number, number])
    const merged = mergeIntervals1D(ivals, O.mergeGapAlongAxisPt)
    for (const [a, b] of merged) {
      if (b - a < O.minSpanLengthPt) continue
      const contributors = intervals.filter((it) => it.hi >= a - 1 && it.lo <= b + 1)
      const idxs = [...new Set(contributors.map((c) => c.idx))].sort((i, j) => i - j)
      const y =
        idxs.reduce((s, id) => {
          const s0 = cleanedSegments[id]!
          return s + (s0.y1 + s0.y2) / 2
        }, 0) / idxs.length
      const cl: GlobalStructuralSpanCenterline = { x1: a, y1: y, x2: b, y2: y }
      const spanLength = b - a
      spans.push(
        finalizeSpan(
          `gspan:h:${_gspanSerial++}`,
          "horizontal",
          cl,
          spanLength,
          idxs,
          envelope,
          cleanedSegments,
          mids,
          O,
          maxDim,
          originalCleanedIndices
        )
      )
    }
  }

  const vert = tagged.filter((t) => t.ac === "vertical")
  const bucketsV = new Map<number, Tagged[]>()
  for (const u of vert) {
    const mx = (u.seg.x1 + u.seg.x2) / 2
    const key = Math.round(mx / O.collinearBucketPt) * O.collinearBucketPt
    const arr = bucketsV.get(key) ?? []
    arr.push(u)
    bucketsV.set(key, arr)
  }
  for (const [, group] of bucketsV) {
    const intervals: Array<{ idx: number; lo: number; hi: number }> = []
    for (const u of group) {
      const lo = Math.min(u.seg.y1, u.seg.y2)
      const hi = Math.max(u.seg.y1, u.seg.y2)
      intervals.push({ idx: u.idx, lo, hi })
    }
    const ivals = intervals.map((it) => [it.lo, it.hi] as [number, number])
    const merged = mergeIntervals1D(ivals, O.mergeGapAlongAxisPt)
    for (const [a, b] of merged) {
      if (b - a < O.minSpanLengthPt) continue
      const contributors = intervals.filter((it) => it.hi >= a - 1 && it.lo <= b + 1)
      const idxs = [...new Set(contributors.map((c) => c.idx))].sort((i, j) => i - j)
      const x =
        idxs.reduce((s, id) => {
          const s0 = cleanedSegments[id]!
          return s + (s0.x1 + s0.x2) / 2
        }, 0) / idxs.length
      const cl: GlobalStructuralSpanCenterline = { x1: x, y1: a, x2: x, y2: b }
      const spanLength = b - a
      spans.push(
        finalizeSpan(
          `gspan:v:${_gspanSerial++}`,
          "vertical",
          cl,
          spanLength,
          idxs,
          envelope,
          cleanedSegments,
          mids,
          O,
          maxDim,
          originalCleanedIndices
        )
      )
    }
  }

  const diag = tagged.filter((t) => t.ac === "diagonal")
  for (const u of diag) {
    const lenUV = segmentLengthPdfUnits(u.seg)
    if (lenUV < O.minDiagonalSpanLengthPt) continue
    const cl: GlobalStructuralSpanCenterline = {
      x1: u.seg.x1,
      y1: u.seg.y1,
      x2: u.seg.x2,
      y2: u.seg.y2,
    }
    spans.push(
      finalizeSpan(
        `gspan:d:${_gspanSerial++}`,
        "diagonal",
        cl,
        lenUV,
        [u.idx],
        envelope,
        cleanedSegments,
        mids,
        O,
        maxDim,
        originalCleanedIndices
      )
    )
  }

  const dist: GlobalStructuralSpanOrientationDistribution = {
    horizontal: spans.filter((s) => s.orientation === "horizontal").length,
    vertical: spans.filter((s) => s.orientation === "vertical").length,
    diagonal: spans.filter((s) => s.orientation === "diagonal").length,
  }

  const topBySpanLength = [...spans]
    .sort((a, b) => b.spanLength - a.spanLength)
    .slice(0, 16)
    .map((s) => ({
      id: s.id,
      spanLength: s.spanLength,
      orientation: s.orientation,
      shellHintScore: s.shellHintScore,
    }))

  const topByShellHintScore = [...spans]
    .sort((a, b) => b.shellHintScore - a.shellHintScore)
    .slice(0, 16)
    .map((s) => ({
      id: s.id,
      shellHintScore: s.shellHintScore,
      spanLength: s.spanLength,
      orientation: s.orientation,
    }))

  const summary: GlobalStructuralSpansDebugSummary = {
    totalSpanCount: spans.length,
    topBySpanLength,
    topByShellHintScore,
    orientationDistribution: dist,
  }

  spans.sort((a, b) => b.shellHintScore - a.shellHintScore)
  const cap = O.maxSpansInPayload
  const spansOut = spans.slice(0, cap)
  const svgStrokes = globalStructuralSpansToSvgStrokes(spansOut)

  return { summary, spans: spansOut, svgStrokes }
}

function finalizeSpan(
  id: string,
  orientation: GlobalSpanOrientation,
  cl: GlobalStructuralSpanCenterline,
  spanLength: number,
  idxs: number[],
  envelope: PlanBoundingBox,
  cleanedSegments: ExtractedLineSegment[],
  mids: Array<{ x: number; y: number }>,
  O: Required<BuildGlobalStructuralSpansNumericOptions>,
  maxDim: number,
  originalCleanedIndices: number[] | undefined
): GlobalStructuralSpan {
  const nearEnvelopeScore = meanNearEnvelopeScore(cl, envelope, O.envelopeScoreBandRefPt)
  const cx = (cl.x1 + cl.x2) / 2
  const cy = (cl.y1 + cl.y2) / 2
  const localSum = sumLengthInDisk(cx, cy, cleanedSegments, mids, O.localGroupRadiusPt)
  const localFactor = clamp01(localSum / O.localGroupSpanRefPt)
  const lenFactor = clamp01(spanLength / O.referenceLengthPt)
  const multFactor = clamp01(idxs.length / 8)
  const structuralSupportScore = clamp01(0.38 * lenFactor + 0.34 * multFactor + 0.28 * localFactor)

  const band = Math.max(24, O.envelopeScoreBandRefPt * 0.85)
  const perimHint = perimeterBandHint(cl, orientation, envelope, band)
  const shellHintScore = clamp01(
    0.4 * nearEnvelopeScore +
      0.28 * lenFactor +
      0.18 * structuralSupportScore +
      0.14 * perimHint +
      0.08 * clamp01(spanLength / maxDim)
  )

  return {
    id,
    orientation,
    centerline: cl,
    spanLength,
    sourceSegmentCount: idxs.length,
    nearEnvelopeScore,
    structuralSupportScore,
    shellHintScore,
    sourceSegmentIds: idxs.map((j) => {
      const orig = originalCleanedIndices?.[j]
      return cleanedId(orig !== undefined ? orig : j)
    }),
  }
}

export function globalStructuralSpansToSvgStrokes(spans: GlobalStructuralSpan[]): GlobalStructuralSpanSvgStroke[] {
  return spans.map((s) => {
    const { x1, y1, x2, y2 } = s.centerline
    const d = `M ${x1.toFixed(2)} ${y1.toFixed(2)} L ${x2.toFixed(2)} ${y2.toFixed(2)}`
    const w = 4 + 5 * s.shellHintScore + Math.min(3, s.sourceSegmentCount * 0.35)
    return { id: s.id, d, strokeWidthSuggested: w, shellHintScore: s.shellHintScore }
  })
}
