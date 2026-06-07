/**
 * High-recall **extended structural** wall set for geometry-first debugging.
 * Always includes strict `selectMainStructuralWalls` picks, then rescues additional cleaned segments by rule.
 * Not used for production routing.
 */

import type { ExtractedLineSegment, PlanBoundingBox } from "@/lib/geometryFirst/types"
import { segmentsNearlyEqual } from "@/lib/geometryFirst/architecturalWallHypotheses"
import { findNearbyParallelSegments } from "@/lib/geometryFirst/mainStructuralWallSelector"
import { segmentAngleClass, segmentLengthPdfUnits } from "@/lib/geometryFirst/linePrimitiveDenoise"

export interface ExtendedStructuralRescueOptions {
  rescueLongSingletons: boolean
  rescueMinLengthPt: number
  rescueEnvelopeProximityPt: number
  rescueIfTouchesOuterBand: boolean
  rescueIfInLargeSpanLocalGroup: boolean
  rescueLocalGroupRadiusPt: number
  rescueLocalGroupMinSpanPt: number
  /** Max perpendicular gap (pt) when counting parallel neighbors for singleton rescue. */
  rescueSingletonMaxParallelGapPt: number
  minOverlapForNeighbor: number
  parallelAngleDeg: number
}

const RESCUE_DEFAULTS: ExtendedStructuralRescueOptions = {
  rescueLongSingletons: true,
  rescueMinLengthPt: 28,
  rescueEnvelopeProximityPt: 40,
  rescueIfTouchesOuterBand: true,
  rescueIfInLargeSpanLocalGroup: true,
  rescueLocalGroupRadiusPt: 70,
  rescueLocalGroupMinSpanPt: 110,
  rescueSingletonMaxParallelGapPt: 16,
  minOverlapForNeighbor: 0.05,
  parallelAngleDeg: 6,
}

function midpoint(s: ExtractedLineSegment): { x: number; y: number } {
  return { x: (s.x1 + s.x2) / 2, y: (s.y1 + s.y2) / 2 }
}

/** Inside envelope: distance to nearest edge; outside: distance to rect. */
function clearanceToEnvelope(px: number, py: number, env: PlanBoundingBox): number {
  if (px >= env.minX && px <= env.maxX && py >= env.minY && py <= env.maxY) {
    return Math.min(px - env.minX, env.maxX - px, py - env.minY, env.maxY - py)
  }
  const dx = px < env.minX ? env.minX - px : px > env.maxX ? px - env.maxX : 0
  const dy = py < env.minY ? env.minY - py : py > env.maxY ? py - env.maxY : 0
  return Math.hypot(dx, dy)
}

function touchesOuterBand(s: ExtractedLineSegment, env: PlanBoundingBox, bandPt: number): boolean {
  const pts = [midpoint(s), { x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 }]
  return pts.some((p) => clearanceToEnvelope(p.x, p.y, env) <= bandPt)
}

function countStrongParallelNeighbors(
  selfIndex: number,
  segments: ExtractedLineSegment[],
  allMids: Array<{ x: number; y: number }>,
  O: ExtendedStructuralRescueOptions
): number {
  const nb = findNearbyParallelSegments(selfIndex, segments, allMids, {
    maxParallelGapPt: O.rescueSingletonMaxParallelGapPt,
    neighborhoodRadiusPt: O.rescueLocalGroupRadiusPt,
    parallelAngleDeg: O.parallelAngleDeg,
  })
  return nb.filter((n) => n.overlapRatio >= O.minOverlapForNeighbor).length
}

function sumSpanInDisk(
  selfIndex: number,
  segments: ExtractedLineSegment[],
  allMids: Array<{ x: number; y: number }>,
  radiusPt: number
): number {
  const m = allMids[selfIndex]!
  const r2 = radiusPt * radiusPt
  let sum = 0
  for (let j = 0; j < segments.length; j++) {
    const mj = allMids[j]!
    const dx = mj.x - m.x
    const dy = mj.y - m.y
    if (dx * dx + dy * dy <= r2) {
      sum += segmentLengthPdfUnits(segments[j]!)
    }
  }
  return sum
}

export interface ExtendedStructuralWallBuildResult {
  extendedStructuralWalls: ExtractedLineSegment[]
  /** Cleaned indices in strict set (from geometric match). */
  strictIndices: number[]
  /** Cleaned indices in extended ∪ strict. */
  extendedIndices: number[]
  optionsUsed: ExtendedStructuralRescueOptions
  rescueStats: {
    strictCount: number
    extendedOnlyCount: number
    extendedTotalCount: number
    /** Segment added contribution counts (a segment may match multiple rules). */
    ruleHitsLongHVSingleton: number
    ruleHitsOuterBand: number
    ruleHitsLargeSpanGroup: number
  }
}

/**
 * Build extended structural segment list: all strict matches on `cleanedSegments`, plus rescues.
 */
export function buildExtendedStructuralWalls(
  cleanedSegments: ExtractedLineSegment[],
  strictMainWalls: ExtractedLineSegment[],
  candidateEnvelope: PlanBoundingBox,
  opts?: Partial<ExtendedStructuralRescueOptions>
): ExtendedStructuralWallBuildResult {
  const O: ExtendedStructuralRescueOptions = { ...RESCUE_DEFAULTS, ...opts }
  const n = cleanedSegments.length
  const strictIdx = new Set<number>()
  for (let i = 0; i < n; i++) {
    const s = cleanedSegments[i]!
    if (strictMainWalls.some((t) => segmentsNearlyEqual(s, t, 0.9))) {
      strictIdx.add(i)
    }
  }

  const allMids = cleanedSegments.map(midpoint)
  const extendedIdx = new Set<number>(strictIdx)
  let ruleHitsLong = 0
  let ruleHitsBand = 0
  let ruleHitsGroup = 0

  for (let i = 0; i < n; i++) {
    if (strictIdx.has(i)) continue
    const s = cleanedSegments[i]!
    const len = segmentLengthPdfUnits(s)
    if (len < 1e-6) continue

    let hitLong = false
    let hitBand = false
    let hitGroup = false

    if (O.rescueLongSingletons) {
      const cls = segmentAngleClass(s, O.parallelAngleDeg)
      if ((cls === "horizontal" || cls === "vertical") && len >= O.rescueMinLengthPt) {
        const pc = countStrongParallelNeighbors(i, cleanedSegments, allMids, O)
        if (pc <= 1) {
          hitLong = true
        }
      }
    }

    if (O.rescueIfTouchesOuterBand && O.rescueEnvelopeProximityPt > 0) {
      if (touchesOuterBand(s, candidateEnvelope, O.rescueEnvelopeProximityPt)) {
        hitBand = true
      }
    }

    if (O.rescueIfInLargeSpanLocalGroup && O.rescueLocalGroupMinSpanPt > 0) {
      const spanSum = sumSpanInDisk(i, cleanedSegments, allMids, O.rescueLocalGroupRadiusPt)
      if (spanSum >= O.rescueLocalGroupMinSpanPt) {
        hitGroup = true
      }
    }

    if (hitLong || hitBand || hitGroup) {
      extendedIdx.add(i)
      if (hitLong) ruleHitsLong++
      if (hitBand) ruleHitsBand++
      if (hitGroup) ruleHitsGroup++
    }
  }

  const sortedIdx = [...extendedIdx].sort((a, b) => a - b)
  const extendedStructuralWalls = sortedIdx.map((i) => cleanedSegments[i]!)

  return {
    extendedStructuralWalls,
    strictIndices: [...strictIdx].sort((a, b) => a - b),
    extendedIndices: sortedIdx,
    optionsUsed: O,
    rescueStats: {
      strictCount: strictIdx.size,
      extendedOnlyCount: sortedIdx.length - strictIdx.size,
      extendedTotalCount: sortedIdx.length,
      ruleHitsLongHVSingleton: ruleHitsLong,
      ruleHitsOuterBand: ruleHitsBand,
      ruleHitsLargeSpanGroup: ruleHitsGroup,
    },
  }
}
