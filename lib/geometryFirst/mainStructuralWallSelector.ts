/**
 * Heuristic selection of likely **main structural** wall strokes before graph construction (debug / tuning).
 * Scores length, axis alignment, parallel neighbors / overlap, local density, text proximity (lightweight).
 * Optional **hard gates** run before the score threshold.
 */

import { segmentAngleClass, segmentLengthPdfUnits } from "@/lib/geometryFirst/linePrimitiveDenoise"
import type { ExtractedLineSegment, ExtractedTextRun, PlanBoundingBox } from "@/lib/geometryFirst/types"

export interface MainStructuralWallSelectorOptions {
  minScoreToKeep?: number
  maxParallelGapPt?: number
  minOverlapRatio?: number
  neighborhoodRadiusPt?: number
  referenceLengthPt?: number
  isolatedShortLengthPt?: number
  isolatedMaxNeighbors?: number
  textPenaltyRadiusPt?: number
  maxTextPenalty?: number
  parallelAngleDeg?: number
  axisAlignmentToleranceDeg?: number
  weightLength?: number
  weightAxis?: number
  weightParallelNeighbor?: number
  weightOverlap?: number
  weightIsolatedShort?: number
  maxParallelNeighborBonus?: number
  maxOverlapBonus?: number
  /** If > 0, reject segments shorter than this (pt). */
  hardMinLengthPt?: number
  /** If true, require at least one parallel neighbor within gap (implies neighbors.length >= 1). */
  requireParallelSupport?: boolean
  /** Minimum count of parallel neighbors (after findNearbyParallelSegments). */
  minParallelNeighborCount?: number
  /** Minimum neighbors with overlapRatio >= minOverlapRatio; 0 disables. */
  minOverlapSupport?: number
  /** Minimum local midpoint density (other segments in neighborhoodRadius); 0 disables. */
  minNeighborhoodDensity?: number
}

const DEFAULTS: Required<MainStructuralWallSelectorOptions> = {
  minScoreToKeep: 0.58,
  maxParallelGapPt: 14,
  minOverlapRatio: 0.06,
  neighborhoodRadiusPt: 48,
  referenceLengthPt: 56,
  isolatedShortLengthPt: 22,
  isolatedMaxNeighbors: 1,
  textPenaltyRadiusPt: 26,
  maxTextPenalty: 0.42,
  parallelAngleDeg: 5,
  axisAlignmentToleranceDeg: 6,
  weightLength: 0.2,
  weightAxis: 0.16,
  weightParallelNeighbor: 0.32,
  weightOverlap: 0.62,
  weightIsolatedShort: 1.15,
  maxParallelNeighborBonus: 1.0,
  maxOverlapBonus: 1.25,
  hardMinLengthPt: 9,
  requireParallelSupport: true,
  minParallelNeighborCount: 1,
  minOverlapSupport: 1,
  minNeighborhoodDensity: 2,
}

export interface MainStructuralWallScoreBreakdown {
  lengthScore: number
  axisAlignmentScore: number
  parallelNeighborBonus: number
  overlapBonus: number
  isolatedShortPenalty: number
  textProximityPenalty: number
  localDensity: number
  totalScore: number
  parallelNeighborCount: number
  overlapSupportCount: number
  gatePassed: boolean
  /** First failing gate id, or null if gates passed. */
  gateFailure: string | null
  /** Failed totalScore >= minScoreToKeep after passing gates. */
  scoreRejected: boolean
  selected: boolean
}

export interface MainStructuralWallSegmentDebug {
  x1: number
  y1: number
  x2: number
  y2: number
  lengthPt: number
  breakdown: MainStructuralWallScoreBreakdown
}

export interface MainStructuralWallScoreDistribution {
  min: number
  max: number
  mean: number
  median: number
  p25: number
  p75: number
  p90: number
  selectedCount: number
  rejectedCount: number
}

export interface MainStructuralWallTermAverages {
  avgLengthScore: number
  avgAxisScore: number
  avgParallelNeighborBonus: number
  avgOverlapBonus: number
  avgIsolatedPenalty: number
  avgTextPenalty: number
}

export interface MainStructuralWallGateBreakdown {
  rejectedHardMinLength: number
  rejectedRequireParallelSupport: number
  rejectedMinParallelNeighborCount: number
  rejectedMinOverlapSupport: number
  rejectedMinNeighborhoodDensity: number
  passedGates: number
  rejectedScoreThreshold: number
  selected: number
}

export interface MainStructuralWallSelectorResult {
  selectedMainWalls: ExtractedLineSegment[]
  perSegment: MainStructuralWallSegmentDebug[]
  optionsUsed: Required<MainStructuralWallSelectorOptions>
  segmentCountIn: number
  segmentCountSelected: number
  scoreDistribution: MainStructuralWallScoreDistribution
  termAverages: MainStructuralWallTermAverages
  gateBreakdown: MainStructuralWallGateBreakdown
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

const DEG = Math.PI / 180

export function areDirectionsParallel(
  ux: number,
  uy: number,
  vx: number,
  vy: number,
  parallelAngleDeg: number
): boolean {
  const c = Math.cos(parallelAngleDeg * DEG)
  return Math.abs(ux * vx + uy * vy) >= c
}

export function parallelLineGapPt(
  ax: number,
  ay: number,
  ux: number,
  uy: number,
  bx: number,
  by: number
): number {
  const nx = -uy
  const ny = ux
  return Math.abs((bx - ax) * nx + (by - ay) * ny)
}

export function projectionInterval(s: ExtractedLineSegment, ux: number, uy: number): { lo: number; hi: number } {
  const t0 = s.x1 * ux + s.y1 * uy
  const t1 = s.x2 * ux + s.y2 * uy
  return { lo: Math.min(t0, t1), hi: Math.max(t0, t1) }
}

export function overlapRatioParallelSegments(a: ExtractedLineSegment, b: ExtractedLineSegment, ua: number, ub: number): number {
  const La = segmentLengthPdfUnits(a)
  const Lb = segmentLengthPdfUnits(b)
  const denom = Math.max(1e-9, Math.min(La, Lb))
  const ia = projectionInterval(a, ua, ub)
  const ib = projectionInterval(b, ua, ub)
  const ov = Math.max(0, Math.min(ia.hi, ib.hi) - Math.max(ia.lo, ib.lo))
  return ov / denom
}

export function pointRectDistance(px: number, py: number, minX: number, minY: number, maxX: number, maxY: number): number {
  const dx = px < minX ? minX - px : px > maxX ? px - maxX : 0
  const dy = py < minY ? minY - py : py > maxY ? py - maxY : 0
  return hypot(dx, dy)
}

function expandedTextRect(t: ExtractedTextRun, pad: number): { minX: number; maxX: number; minY: number; maxY: number } {
  const w = t.width ?? Math.max(6, t.text.length * 4.5)
  const h = t.height ?? 11
  return {
    minX: t.x - pad,
    maxX: t.x + w + pad,
    minY: t.y - h - pad,
    maxY: t.y + pad,
  }
}

export function nearestTextDistanceToSegment(
  s: ExtractedLineSegment,
  texts: ExtractedTextRun[],
  bboxPadPt: number
): number {
  if (texts.length === 0) return Number.POSITIVE_INFINITY
  const rects = texts.map((t) => expandedTextRect(t, bboxPadPt))
  let best = Number.POSITIVE_INFINITY
  const samples: Array<{ x: number; y: number }> = [
    { x: s.x1, y: s.y1 },
    { x: s.x2, y: s.y2 },
    midpoint(s),
  ]
  for (const r of rects) {
    for (const p of samples) {
      best = Math.min(best, pointRectDistance(p.x, p.y, r.minX, r.minY, r.maxX, r.maxY))
    }
  }
  return best
}

export function localNeighborhoodDensity(
  midX: number,
  midY: number,
  allMids: Array<{ x: number; y: number }>,
  selfIndex: number,
  radiusPt: number
): number {
  const r2 = radiusPt * radiusPt
  let c = 0
  for (let j = 0; j < allMids.length; j++) {
    if (j === selfIndex) continue
    const dx = allMids[j].x - midX
    const dy = allMids[j].y - midY
    if (dx * dx + dy * dy <= r2) c++
  }
  return c
}

export interface ParallelNeighborInfo {
  index: number
  lineGapPt: number
  overlapRatio: number
}

export function findNearbyParallelSegments(
  selfIndex: number,
  segments: ExtractedLineSegment[],
  allMids: Array<{ x: number; y: number }>,
  opts: {
    maxParallelGapPt: number
    neighborhoodRadiusPt: number
    parallelAngleDeg: number
  }
): ParallelNeighborInfo[] {
  const s = segments[selfIndex]!
  const { ux, uy, len } = unitDir(s)
  if (len < 1e-9) return []
  const m = allMids[selfIndex]!
  const R = opts.neighborhoodRadiusPt * 1.25
  const R2 = R * R
  const out: ParallelNeighborInfo[] = []
  for (let j = 0; j < segments.length; j++) {
    if (j === selfIndex) continue
    const t = segments[j]!
    const v = unitDir(t)
    if (v.len < 1e-9) continue
    if (!areDirectionsParallel(ux, uy, v.ux, v.uy, opts.parallelAngleDeg)) continue
    const mj = allMids[j]
    const dx = mj.x - m.x
    const dy = mj.y - m.y
    if (dx * dx + dy * dy > R2) continue
    const gap = parallelLineGapPt(s.x1, s.y1, ux, uy, t.x1, t.y1)
    if (gap > opts.maxParallelGapPt) continue
    const overlapRatio = overlapRatioParallelSegments(s, t, ux, uy)
    out.push({ index: j, lineGapPt: gap, overlapRatio })
  }
  return out
}

function axisAlignmentScoreValue(s: ExtractedLineSegment, axisDeg: number, wAxis: number): number {
  const cls = segmentAngleClass(s, axisDeg)
  if (cls === "horizontal" || cls === "vertical") return wAxis * 1
  if (cls === "diagonal") return wAxis * 0.38
  return wAxis * 0.1
}

function lengthScoreValue(len: number, refLen: number, w: number): number {
  return w * Math.min(1, len / refLen)
}

function quantileSorted(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo]!
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo)
}

function computeDistribution(scores: number[], selectedCount: number, rejectedCount: number): MainStructuralWallScoreDistribution {
  if (scores.length === 0) {
    return {
      min: 0,
      max: 0,
      mean: 0,
      median: 0,
      p25: 0,
      p75: 0,
      p90: 0,
      selectedCount,
      rejectedCount,
    }
  }
  const s = [...scores].sort((a, b) => a - b)
  const sum = scores.reduce((a, b) => a + b, 0)
  return {
    min: s[0]!,
    max: s[s.length - 1]!,
    mean: sum / scores.length,
    median: quantileSorted(s, 0.5),
    p25: quantileSorted(s, 0.25),
    p75: quantileSorted(s, 0.75),
    p90: quantileSorted(s, 0.9),
    selectedCount,
    rejectedCount,
  }
}

/**
 * Select main structural wall segments from **cleaned** candidate strokes.
 */
export function selectMainStructuralWalls(
  segments: ExtractedLineSegment[],
  texts: ExtractedTextRun[],
  _pageBounds: PlanBoundingBox,
  opts?: MainStructuralWallSelectorOptions
): MainStructuralWallSelectorResult {
  const O = { ...DEFAULTS, ...opts }
  const n = segments.length
  const allMids = segments.map(midpoint)

  const gateBreakdown: MainStructuralWallGateBreakdown = {
    rejectedHardMinLength: 0,
    rejectedRequireParallelSupport: 0,
    rejectedMinParallelNeighborCount: 0,
    rejectedMinOverlapSupport: 0,
    rejectedMinNeighborhoodDensity: 0,
    passedGates: 0,
    rejectedScoreThreshold: 0,
    selected: 0,
  }

  const perSegment: MainStructuralWallSegmentDebug[] = []
  const selectedMainWalls: ExtractedLineSegment[] = []
  const scoresForDist: number[] = []
  let sumLen = 0,
    sumAxis = 0,
    sumPar = 0,
    sumOv = 0,
    sumIso = 0,
    sumTxt = 0
  let termCount = 0

  for (let i = 0; i < n; i++) {
    const s = segments[i]!
    const len = segmentLengthPdfUnits(s)

    if (len < 1e-9) {
      perSegment.push({
        x1: s.x1,
        y1: s.y1,
        x2: s.x2,
        y2: s.y2,
        lengthPt: 0,
        breakdown: {
          lengthScore: 0,
          axisAlignmentScore: 0,
          parallelNeighborBonus: 0,
          overlapBonus: 0,
          isolatedShortPenalty: 0,
          textProximityPenalty: 0,
          localDensity: 0,
          totalScore: 0,
          parallelNeighborCount: 0,
          overlapSupportCount: 0,
          gatePassed: false,
          gateFailure: "degenerate",
          scoreRejected: true,
          selected: false,
        },
      })
      continue
    }

    const neighbors = findNearbyParallelSegments(i, segments, allMids, {
      maxParallelGapPt: O.maxParallelGapPt,
      neighborhoodRadiusPt: O.neighborhoodRadiusPt,
      parallelAngleDeg: O.parallelAngleDeg,
    })

    const overlapSupportCount = neighbors.filter((nb) => nb.overlapRatio >= O.minOverlapRatio).length
    const density = localNeighborhoodDensity(allMids[i].x, allMids[i].y, allMids, i, O.neighborhoodRadiusPt)

    let gateFailure: string | null = null
    if (O.hardMinLengthPt > 0 && len < O.hardMinLengthPt) {
      gateFailure = "hardMinLength"
      gateBreakdown.rejectedHardMinLength++
    } else if (O.requireParallelSupport && neighbors.length === 0) {
      gateFailure = "requireParallelSupport"
      gateBreakdown.rejectedRequireParallelSupport++
    } else if (neighbors.length < O.minParallelNeighborCount) {
      gateFailure = "minParallelNeighborCount"
      gateBreakdown.rejectedMinParallelNeighborCount++
    } else if (O.minOverlapSupport > 0 && overlapSupportCount < O.minOverlapSupport) {
      gateFailure = "minOverlapSupport"
      gateBreakdown.rejectedMinOverlapSupport++
    } else if (O.minNeighborhoodDensity > 0 && density < O.minNeighborhoodDensity) {
      gateFailure = "minNeighborhoodDensity"
      gateBreakdown.rejectedMinNeighborhoodDensity++
    }

    const gatePassed = gateFailure === null
    if (gatePassed) gateBreakdown.passedGates++

    const lengthScore = lengthScoreValue(len, O.referenceLengthPt, O.weightLength)
    const axisAlignmentScore = axisAlignmentScoreValue(s, O.axisAlignmentToleranceDeg, O.weightAxis)

    const parallelNeighborBonus = Math.min(
      O.maxParallelNeighborBonus,
      neighbors.length * O.weightParallelNeighbor
    )

    let overlapBonus = 0
    for (const nb of neighbors) {
      if (nb.overlapRatio >= O.minOverlapRatio) {
        overlapBonus += nb.overlapRatio * O.weightOverlap
      }
    }
    overlapBonus = Math.min(O.maxOverlapBonus, overlapBonus)

    let isolatedShortPenalty = 0
    if (len < O.isolatedShortLengthPt && neighbors.length <= O.isolatedMaxNeighbors && density <= 1) {
      isolatedShortPenalty = O.weightIsolatedShort * (1 - len / Math.max(O.isolatedShortLengthPt, 1e-9))
    }

    const textDist = nearestTextDistanceToSegment(s, texts, 2)
    let textProximityPenalty = 0
    if (Number.isFinite(textDist) && textDist < O.textPenaltyRadiusPt) {
      textProximityPenalty = O.maxTextPenalty * (1 - textDist / O.textPenaltyRadiusPt)
    }

    const totalScore =
      lengthScore +
      axisAlignmentScore +
      parallelNeighborBonus +
      overlapBonus -
      isolatedShortPenalty -
      textProximityPenalty

    scoresForDist.push(totalScore)
    sumLen += lengthScore
    sumAxis += axisAlignmentScore
    sumPar += parallelNeighborBonus
    sumOv += overlapBonus
    sumIso += isolatedShortPenalty
    sumTxt += textProximityPenalty
    termCount++

    let scoreRejected = false
    let selected = false
    if (!gatePassed) {
      scoreRejected = false
      selected = false
    } else {
      scoreRejected = totalScore < O.minScoreToKeep
      selected = !scoreRejected
      if (scoreRejected) gateBreakdown.rejectedScoreThreshold++
      else {
        gateBreakdown.selected++
        selectedMainWalls.push({ ...s })
      }
    }

    perSegment.push({
      x1: s.x1,
      y1: s.y1,
      x2: s.x2,
      y2: s.y2,
      lengthPt: len,
      breakdown: {
        lengthScore,
        axisAlignmentScore,
        parallelNeighborBonus,
        overlapBonus,
        isolatedShortPenalty,
        textProximityPenalty,
        localDensity: density,
        totalScore,
        parallelNeighborCount: neighbors.length,
        overlapSupportCount,
        gatePassed,
        gateFailure,
        scoreRejected,
        selected,
      },
    })
  }

  const segmentCountSelected = selectedMainWalls.length
  const rejectedCount = n - segmentCountSelected
  const scoreDistribution = computeDistribution(scoresForDist, segmentCountSelected, rejectedCount)

  const termAverages: MainStructuralWallTermAverages =
    termCount > 0
      ? {
          avgLengthScore: sumLen / termCount,
          avgAxisScore: sumAxis / termCount,
          avgParallelNeighborBonus: sumPar / termCount,
          avgOverlapBonus: sumOv / termCount,
          avgIsolatedPenalty: sumIso / termCount,
          avgTextPenalty: sumTxt / termCount,
        }
      : {
          avgLengthScore: 0,
          avgAxisScore: 0,
          avgParallelNeighborBonus: 0,
          avgOverlapBonus: 0,
          avgIsolatedPenalty: 0,
          avgTextPenalty: 0,
        }

  return {
    selectedMainWalls,
    perSegment,
    optionsUsed: O,
    segmentCountIn: n,
    segmentCountSelected,
    scoreDistribution,
    termAverages,
    gateBreakdown,
  }
}
