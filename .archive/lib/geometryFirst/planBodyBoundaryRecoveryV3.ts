/**
 * Debug-only **plan-only targeted side-gap recovery v3**: narrow right/bottom gap zones from v2 output,
 * add conservative local bridges only inside those zones, rebuild boundary candidates. Does not change production.
 */

import type { ArchitecturalWallHypothesesDebugPayload } from "@/lib/geometryFirst/architecturalWallHypotheses"
import { segmentsNearlyEqual } from "@/lib/geometryFirst/architecturalWallHypotheses"
import type { GlobalStructuralSpansDebugPayload } from "@/lib/geometryFirst/globalStructuralSpans"
import type { PlanBodyShellLoopDebug } from "@/lib/geometryFirst/planBodyShellLoop"
import {
  collectBoundaryRecoveryCandidatesFromMerged,
  type BoundaryCandidateSummary,
  type PlanBodyBoundaryRecoveryV2Debug,
  type PlanBodyBoundaryRecoveryV2Options,
} from "@/lib/geometryFirst/planBodyBoundaryRecoveryV2"
import type { ExtractedLineSegment, PlanBoundingBox } from "@/lib/geometryFirst/types"

const V3_OPT = {
  gapSampleCount: 28,
  gapMinPt: 16,
  zoneDepthRightPt: 56,
  zoneDepthBottomPt: 56,
  maxBridgesPerZone: 4,
  maxTotalV3Bridges: 14,
  maxEndpointLinkPt: 26,
  hypExteriorMin: 0.34,
  spanShellHintMin: 0.28,
  maxLongBridgePt: 118,
} as const

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x))
}

function distToPerimeterInside(px: number, py: number, b: PlanBoundingBox): number {
  return Math.min(px - b.minX, b.maxX - px, py - b.minY, b.maxY - py)
}

function distPointToSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): number {
  const dx = x2 - x1
  const dy = y2 - y1
  const L2 = dx * dx + dy * dy
  if (L2 < 1e-12) return Math.hypot(px - x1, py - y1)
  let t = ((px - x1) * dx + (py - y1) * dy) / L2
  t = Math.max(0, Math.min(1, t))
  const qx = x1 + t * dx
  const qy = y1 + t * dy
  return Math.hypot(px - qx, py - qy)
}

function distPointToPolylineEdges(
  px: number,
  py: number,
  pts: Array<{ x: number; y: number }>,
  closed: boolean
): number {
  if (pts.length < 2) return Infinity
  let d = Infinity
  if (closed) {
    const n = pts.length
    for (let i = 0; i < n; i++) {
      const a = pts[i]!
      const b = pts[(i + 1) % n]!
      d = Math.min(d, distPointToSegment(px, py, a.x, a.y, b.x, b.y))
    }
  } else {
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i]!
      const b = pts[i + 1]!
      d = Math.min(d, distPointToSegment(px, py, a.x, a.y, b.x, b.y))
    }
  }
  return d
}

function pointInBox(px: number, py: number, b: PlanBoundingBox): boolean {
  return px >= b.minX && px <= b.maxX && py >= b.minY && py <= b.maxY
}

function perimeterProximity(px: number, py: number, b: PlanBoundingBox, bandPt: number): number {
  const d = distToPerimeterInside(px, py, b)
  return clamp01(1 - d / Math.max(1e-6, bandPt))
}

function hypSpanScoreAt(
  mx: number,
  my: number,
  hyps: ArchitecturalWallHypothesesDebugPayload,
  spans: GlobalStructuralSpansDebugPayload
): { hyp: number; sp: number } {
  let hyp = 0
  let sp = 0
  for (const h of hyps.hypotheses) {
    if (h.exteriorLikelihood < V3_OPT.hypExteriorMin) continue
    const c = h.centerline
    const d = distPointToSegment(mx, my, c.x1, c.y1, c.x2, c.y2)
    hyp = Math.max(hyp, h.exteriorLikelihood * Math.exp(-d / 10))
  }
  for (const s of spans.spans) {
    if (s.shellHintScore < V3_OPT.spanShellHintMin) continue
    const c = s.centerline
    const d = distPointToSegment(mx, my, c.x1, c.y1, c.x2, c.y2)
    sp = Math.max(sp, s.shellHintScore * Math.exp(-d / 12))
  }
  return { hyp, sp }
}

export interface LocalizedSideGapV3 {
  side: "right" | "bottom"
  band: PlanBoundingBox
  /** Higher = more important to close (gap × extent heuristic). */
  closureImportance: number
  averageGapPt: number
  note: string
}

export interface PlanBodyBoundaryRecoveryV3Debug {
  unresolvedGapCount: number
  recoveredBridgeCount: number
  rightSideImproved: boolean
  bottomSideImproved: boolean
  bestBoundaryClosed: boolean
  closureConfidence: number
  sideCoverageSummary: { top: boolean; bottom: boolean; left: boolean; right: boolean }
  largestGapSummary: { side: string; gapPtApprox: number; note: string }
  boundaryIsHintVsRegularizationBasis: "hint_only" | "moderate_regularization_basis" | "strong_regularization_basis"
  regularizationBasisStatement: string
  improvedVsBoundaryRecoveryV2: { right: boolean; bottom: boolean }
  localizedGapZones: LocalizedSideGapV3[]
  remainingGapZones: LocalizedSideGapV3[]
  notes: string[]
  v3BridgeSegments: ExtractedLineSegment[]
  bestBoundaryCandidate: BoundaryCandidateSummary | null
  candidateSummariesTop: BoundaryCandidateSummary[]
}

function referencePolylineFromV2(v2: PlanBodyBoundaryRecoveryV2Debug): {
  pts: Array<{ x: number; y: number }>
  closed: boolean
} | null {
  const b = v2.bestBoundaryCandidate
  if (!b || b.boundaryPolylinePt.length < 2) return null
  const closed = !!(b.closed && b.boundaryPolylinePt.length >= 3)
  return { pts: b.boundaryPolylinePt, closed }
}

function scanEdgeGaps(
  bbox: PlanBoundingBox,
  side: "right" | "bottom",
  refPts: Array<{ x: number; y: number }>,
  closed: boolean,
  sampleN: number,
  gapMin: number
): { t0: number; t1: number; avgGap: number; importance: number }[] {
  const w = bbox.maxX - bbox.minX
  const h = bbox.maxY - bbox.minY
  const gaps: number[] = []
  for (let i = 0; i <= sampleN; i++) {
    const t = i / sampleN
    let px: number
    let py: number
    if (side === "right") {
      px = bbox.maxX
      py = bbox.minY + t * h
    } else {
      px = bbox.minX + t * w
      py = bbox.minY
    }
    gaps.push(distPointToPolylineEdges(px, py, refPts, closed))
  }
  const runs: { t0: number; t1: number; avgGap: number; importance: number }[] = []
  let runStart: number | null = null
  let runSum = 0
  let runLen = 0
  for (let i = 0; i <= sampleN; i++) {
    const g = gaps[i]!
    const bad = g >= gapMin
    if (bad) {
      if (runStart === null) {
        runStart = i
        runSum = g
        runLen = 1
      } else {
        runSum += g
        runLen++
      }
    } else if (runStart !== null) {
      const t0 = runStart / sampleN
      const t1 = (i - 1) / sampleN
      const avgGap = runSum / runLen
      const extent = Math.max(0.02, t1 - t0)
      runs.push({
        t0,
        t1,
        avgGap,
        importance: avgGap * Math.sqrt(extent) * (side === "right" ? 1.05 : 1),
      })
      runStart = null
      runSum = 0
      runLen = 0
    }
  }
  if (runStart !== null) {
    const t0 = runStart / sampleN
    const t1 = 1
    const avgGap = runSum / runLen
    const extent = Math.max(0.02, t1 - t0)
    runs.push({ t0, t1, avgGap, importance: avgGap * Math.sqrt(extent) })
  }
  return runs
}

function runToZone(bbox: PlanBoundingBox, side: "right" | "bottom", run: { t0: number; t1: number; avgGap: number; importance: number }): LocalizedSideGapV3 {
  const w = bbox.maxX - bbox.minX
  const h = bbox.maxY - bbox.minY
  const pad = Math.max(4, Math.min(w, h) * 0.02)
  if (side === "right") {
    const y0 = bbox.minY + run.t0 * h - pad
    const y1 = bbox.minY + run.t1 * h + pad
    const band: PlanBoundingBox = {
      minX: bbox.maxX - V3_OPT.zoneDepthRightPt,
      maxX: bbox.maxX,
      minY: Math.max(bbox.minY, y0),
      maxY: Math.min(bbox.maxY, y1),
    }
    return {
      side,
      band,
      closureImportance: run.importance,
      averageGapPt: run.avgGap,
      note: `right edge y=${band.minY.toFixed(0)}–${band.maxY.toFixed(0)} mean gap ${run.avgGap.toFixed(1)}pt`,
    }
  }
  const x0 = bbox.minX + run.t0 * w - pad
  const x1 = bbox.minX + run.t1 * w + pad
  const band: PlanBoundingBox = {
    minX: Math.max(bbox.minX, x0),
    maxX: Math.min(bbox.maxX, x1),
    minY: bbox.minY,
    maxY: bbox.minY + V3_OPT.zoneDepthBottomPt,
  }
  return {
    side,
    band,
    closureImportance: run.importance,
    averageGapPt: run.avgGap,
    note: `bottom edge x=${band.minX.toFixed(0)}–${band.maxX.toFixed(0)} mean gap ${run.avgGap.toFixed(1)}pt`,
  }
}

function localizeGapsFromV2(
  bbox: PlanBoundingBox,
  v2: PlanBodyBoundaryRecoveryV2Debug
): LocalizedSideGapV3[] {
  const ref = referencePolylineFromV2(v2)
  if (!ref) return []
  const { pts, closed } = ref
  const zones: LocalizedSideGapV3[] = []
  const rightRuns = scanEdgeGaps(bbox, "right", pts, closed, V3_OPT.gapSampleCount, V3_OPT.gapMinPt)
  for (const r of rightRuns) zones.push(runToZone(bbox, "right", r))
  const bottomRuns = scanEdgeGaps(bbox, "bottom", pts, closed, V3_OPT.gapSampleCount, V3_OPT.gapMinPt)
  for (const r of bottomRuns) zones.push(runToZone(bbox, "bottom", r))
  zones.sort((a, b) => {
    if (a.side !== b.side) return a.side === "right" ? -1 : 1
    return b.closureImportance - a.closureImportance
  })
  return zones
}

function segmentInBandMidpoint(seg: ExtractedLineSegment, band: PlanBoundingBox): boolean {
  const mx = (seg.x1 + seg.x2) / 2
  const my = (seg.y1 + seg.y2) / 2
  return pointInBox(mx, my, band)
}

function segmentTouchesSideIntent(seg: ExtractedLineSegment, side: "right" | "bottom", bbox: PlanBoundingBox): number {
  const mx = (seg.x1 + seg.x2) / 2
  const my = (seg.y1 + seg.y2) / 2
  if (side === "right") {
    const near = Math.abs(mx - bbox.maxX) < V3_OPT.zoneDepthRightPt + 12
    return near ? 1 : 0.25
  }
  const near = Math.abs(my - bbox.minY) < V3_OPT.zoneDepthBottomPt + 12
  return near ? 1 : 0.25
}

function interiorShortcutPenalty(mx: number, my: number, bbox: PlanBoundingBox): number {
  const d = distToPerimeterInside(mx, my, bbox)
  const scale = 0.32 * Math.min(bbox.maxX - bbox.minX, bbox.maxY - bbox.minY)
  return clamp01(d / Math.max(12, scale))
}

function shellSegmentsFromIndices(
  primaryLayoutSegments: ExtractedLineSegment[],
  primaryLayoutCleanedIndices: readonly number[],
  shellSet: Set<number>
): ExtractedLineSegment[] {
  const out: ExtractedLineSegment[] = []
  for (let li = 0; li < primaryLayoutSegments.length; li++) {
    const g = primaryLayoutCleanedIndices[li]
    if (g != null && shellSet.has(g)) out.push(primaryLayoutSegments[li]!)
  }
  return out
}

function segKey(s: ExtractedLineSegment): string {
  return `${s.x1.toFixed(2)},${s.y1.toFixed(2)},${s.x2.toFixed(2)},${s.y2.toFixed(2)}`
}

function pushUniqueBridge(
  out: ExtractedLineSegment[],
  seen: Set<string>,
  seg: ExtractedLineSegment,
  existing: ExtractedLineSegment[]
): void {
  const k = segKey(seg)
  if (seen.has(k)) return
  if (existing.some((e) => segmentsNearlyEqual(e, seg, 1.05))) return
  if (out.some((e) => segmentsNearlyEqual(e, seg, 1.05))) return
  seen.add(k)
  out.push(seg)
}

function findV3BridgesForZones(
  zones: LocalizedSideGapV3[],
  primaryLayoutBBox: PlanBoundingBox,
  primaryLayoutSegments: ExtractedLineSegment[],
  primaryLayoutCleanedIndices: readonly number[],
  shellSet: Set<number>,
  hyps: ArchitecturalWallHypothesesDebugPayload,
  spans: GlobalStructuralSpansDebugPayload,
  v2Bridges: ExtractedLineSegment[],
  shellSegs: ExtractedLineSegment[]
): ExtractedLineSegment[] {
  const out: ExtractedLineSegment[] = []
  const seen = new Set<string>()
  const existing = [...shellSegs, ...v2Bridges]

  const gatherEndpoints = (segs: ExtractedLineSegment[]) => {
    const pts: { x: number; y: number }[] = []
    for (const s of segs) {
      pts.push({ x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 })
    }
    return pts
  }

  const zoneEndpoints = (band: PlanBoundingBox, pad: number) => {
    const near: { x: number; y: number }[] = []
    for (let li = 0; li < primaryLayoutSegments.length; li++) {
      const s = primaryLayoutSegments[li]!
      const g = primaryLayoutCleanedIndices[li]!
      if (shellSet.has(g)) continue
      for (const p of [
        { x: s.x1, y: s.y1 },
        { x: s.x2, y: s.y2 },
      ]) {
        if (pointInBox(p.x, p.y, band) || distToPerimeterInside(p.x, p.y, band) < pad) near.push(p)
      }
    }
    for (const sh of shellSegs) {
      for (const p of [
        { x: sh.x1, y: sh.y1 },
        { x: sh.x2, y: sh.y2 },
      ]) {
        if (pointInBox(p.x, p.y, band)) near.push(p)
      }
    }
    return near
  }

  for (const zone of zones) {
    let nHere = 0
    type Scored = { seg: ExtractedLineSegment; score: number }
    const scored: Scored[] = []
    const band = zone.band

    for (let li = 0; li < primaryLayoutSegments.length; li++) {
      const g = primaryLayoutCleanedIndices[li]!
      if (shellSet.has(g)) continue
      const seg = primaryLayoutSegments[li]!
      if (!segmentInBandMidpoint(seg, band)) continue
      const mx = (seg.x1 + seg.x2) / 2
      const my = (seg.y1 + seg.y2) / 2
      const per = perimeterProximity(mx, my, primaryLayoutBBox, 62)
      const { hyp, sp } = hypSpanScoreAt(mx, my, hyps, spans)
      const len = Math.hypot(seg.x2 - seg.x1, seg.y2 - seg.y1)
      if (len > V3_OPT.maxLongBridgePt) continue
      const helpsR = zone.side === "right" ? segmentTouchesSideIntent(seg, "right", primaryLayoutBBox) : 0.15
      const helpsB = zone.side === "bottom" ? segmentTouchesSideIntent(seg, "bottom", primaryLayoutBBox) : 0.15
      const sideBoost = zone.side === "right" ? 0.42 * helpsR + 0.2 * helpsB : 0.42 * helpsB + 0.2 * helpsR
      const intPen = interiorShortcutPenalty(mx, my, primaryLayoutBBox)
      const score =
        sideBoost +
        0.22 * hyp +
        0.2 * sp +
        0.14 * per -
        0.38 * intPen -
        0.06 * clamp01(len / V3_OPT.maxLongBridgePt)
      if (score < 0.08 && hyp < 0.06 && sp < 0.06) continue
      scored.push({ seg, score })
    }

    for (const h of hyps.hypotheses) {
      if (h.exteriorLikelihood < V3_OPT.hypExteriorMin) continue
      const c = h.centerline
      const seg: ExtractedLineSegment = { x1: c.x1, y1: c.y1, x2: c.x2, y2: c.y2 }
      if (!segmentInBandMidpoint(seg, band)) continue
      const mx = (seg.x1 + seg.x2) / 2
      const my = (seg.y1 + seg.y2) / 2
      const len = Math.hypot(seg.x2 - seg.x1, seg.y2 - seg.y1)
      if (len > V3_OPT.maxLongBridgePt * 1.15) continue
      const per = perimeterProximity(mx, my, primaryLayoutBBox, 62)
      const intPen = interiorShortcutPenalty(mx, my, primaryLayoutBBox)
      const helpsR = zone.side === "right" ? segmentTouchesSideIntent(seg, "right", primaryLayoutBBox) : 0.12
      const helpsB = zone.side === "bottom" ? segmentTouchesSideIntent(seg, "bottom", primaryLayoutBBox) : 0.12
      const sideBoost = zone.side === "right" ? 0.45 * helpsR : 0.45 * helpsB
      const score = sideBoost + 0.28 * h.exteriorLikelihood + 0.18 * per - 0.4 * intPen
      scored.push({ seg, score })
    }

    for (const sp of spans.spans) {
      if (sp.shellHintScore < V3_OPT.spanShellHintMin) continue
      const c = sp.centerline
      const seg: ExtractedLineSegment = { x1: c.x1, y1: c.y1, x2: c.x2, y2: c.y2 }
      if (!segmentInBandMidpoint(seg, band)) continue
      const mx = (seg.x1 + seg.x2) / 2
      const my = (seg.y1 + seg.y2) / 2
      const len = Math.hypot(seg.x2 - seg.x1, seg.y2 - seg.y1)
      if (len > V3_OPT.maxLongBridgePt * 1.15) continue
      const per = perimeterProximity(mx, my, primaryLayoutBBox, 62)
      const intPen = interiorShortcutPenalty(mx, my, primaryLayoutBBox)
      const helpsR = zone.side === "right" ? segmentTouchesSideIntent(seg, "right", primaryLayoutBBox) : 0.12
      const helpsB = zone.side === "bottom" ? segmentTouchesSideIntent(seg, "bottom", primaryLayoutBBox) : 0.12
      const sideBoost = zone.side === "right" ? 0.42 * helpsR : 0.42 * helpsB
      const score = sideBoost + 0.3 * sp.shellHintScore + 0.16 * per - 0.38 * intPen
      scored.push({ seg, score })
    }

    scored.sort((a, b) => b.score - a.score)
    for (const row of scored) {
      if (nHere >= V3_OPT.maxBridgesPerZone || out.length >= V3_OPT.maxTotalV3Bridges) break
      const before = out.length
      pushUniqueBridge(out, seen, row.seg, existing)
      if (out.length > before) nHere++
    }

    const ep = zoneEndpoints(band, 8)
    const shellEps = gatherEndpoints(shellSegs)
    for (let i = 0; i < ep.length && out.length < V3_OPT.maxTotalV3Bridges; i++) {
      for (let j = 0; j < shellEps.length && out.length < V3_OPT.maxTotalV3Bridges; j++) {
        if (nHere >= V3_OPT.maxBridgesPerZone + 2) break
        const a = ep[i]!
        const b = shellEps[j]!
        const d = Math.hypot(a.x - b.x, a.y - b.y)
        if (d < 0.8 || d > V3_OPT.maxEndpointLinkPt) continue
        const seg: ExtractedLineSegment = { x1: a.x, y1: a.y, x2: b.x, y2: b.y }
        const mx = (a.x + b.x) / 2
        const my = (a.y + b.y) / 2
        if (!pointInBox(mx, my, band) && distToPerimeterInside(mx, my, band) > 14) continue
        const per = perimeterProximity(mx, my, primaryLayoutBBox, 58)
        const intPen = interiorShortcutPenalty(mx, my, primaryLayoutBBox)
        const score = 0.35 * per - 0.45 * intPen + (zone.side === "right" ? 0.12 : 0.12)
        if (score < -0.05) continue
        const before = out.length
        pushUniqueBridge(out, seen, seg, existing)
        if (out.length > before) nHere++
      }
    }
  }

  return out
}

function largestGapAlongWeakSides(
  bbox: PlanBoundingBox,
  pts: Array<{ x: number; y: number }>,
  weakSides: string[],
  closed: boolean
): { side: string; gapPtApprox: number; note: string } {
  if (pts.length < 2 || weakSides.length === 0) {
    return { side: weakSides[0] ?? "right", gapPtApprox: 0, note: "insufficient polyline or no weak sides" }
  }
  let worst = 0
  let worstSide = weakSides[0]!
  for (const side of weakSides) {
    const w = bbox.maxX - bbox.minX
    const h = bbox.maxY - bbox.minY
    let maxD = 0
    const n = 14
    for (let i = 0; i <= n; i++) {
      const t = i / n
      let px: number
      let py: number
      if (side === "bottom") {
        px = bbox.minX + t * w
        py = bbox.minY
      } else if (side === "top") {
        px = bbox.minX + t * w
        py = bbox.maxY
      } else if (side === "left") {
        px = bbox.minX
        py = bbox.minY + t * h
      } else {
        px = bbox.maxX
        py = bbox.minY + t * h
      }
      maxD = Math.max(maxD, distPointToPolylineEdges(px, py, pts, closed))
    }
    if (maxD > worst) {
      worst = maxD
      worstSide = side
    }
  }
  return {
    side: worstSide,
    gapPtApprox: worst,
    note: `max sample distance ~${worst.toFixed(1)} pt along weak side(s) vs boundary`,
  }
}

function edgeMaxGap(
  bbox: PlanBoundingBox,
  side: "right" | "bottom",
  pts: Array<{ x: number; y: number }>,
  closed: boolean
): number {
  const w = bbox.maxX - bbox.minX
  const h = bbox.maxY - bbox.minY
  let maxD = 0
  const n = 14
  for (let i = 0; i <= n; i++) {
    const t = i / n
    let px: number
    let py: number
    if (side === "right") {
      px = bbox.maxX
      py = bbox.minY + t * h
    } else {
      px = bbox.minX + t * w
      py = bbox.minY
    }
    maxD = Math.max(maxD, distPointToPolylineEdges(px, py, pts, closed))
  }
  return maxD
}

function finalizeV3Diagnostics(
  best: BoundaryCandidateSummary | null,
  baseline: PlanBodyShellLoopDebug["sideCoverage"],
  primaryLayoutBBox: PlanBoundingBox,
  improvedRightVsV2: boolean,
  improvedBottomVsV2: boolean
): {
  closureConfidence: number
  largestGapSummary: { side: string; gapPtApprox: number; note: string }
  boundaryIsHintVsRegularizationBasis: PlanBodyBoundaryRecoveryV3Debug["boundaryIsHintVsRegularizationBasis"]
  regularizationBasisStatement: string
} {
  const sideSummary = best?.sideCoverage ?? { ...baseline }
  const weakNow = ["top", "bottom", "left", "right"].filter((k) => !sideSummary[k as keyof typeof sideSummary])
  const bestPolyClosed = !!(best?.closed && best.boundaryPolylinePt.length >= 3)
  const largestGap = best
    ? largestGapAlongWeakSides(primaryLayoutBBox, best.boundaryPolylinePt, weakNow.length > 0 ? weakNow : ["right"], bestPolyClosed)
    : { side: "right", gapPtApprox: 0, note: "no candidate" }

  let closureConfidence = 0.1
  if (best) {
    closureConfidence +=
      0.35 * (best.closed ? 1 : 0.35) +
      0.2 * clamp01(1 - best.closureGapPt / 40) +
      0.18 * (["top", "bottom", "left", "right"].filter((k) => best.sideCoverage[k as keyof typeof best.sideCoverage]).length / 4) +
      0.12 * best.supportShell +
      0.1 * (best.supportHypothesis + best.supportSpan) * 0.5 +
      0.05 * best.concavityPlausibility
  }
  closureConfidence = clamp01(closureConfidence)

  const nearlyClosed =
    best != null && (best.closed || (best.closureGapPt > 0 && best.closureGapPt <= 22 && best.perimeterPt > 80))

  let basis: PlanBodyBoundaryRecoveryV3Debug["boundaryIsHintVsRegularizationBasis"] = "hint_only"
  let statement =
    "V3 targeted recovery remains a **debug exterior hint** — not a verified shell; conservative local bridges avoid forced closure."

  const improvedWeak =
    (best?.sideCoverage.right && !baseline.right) ||
    (best?.sideCoverage.bottom && !baseline.bottom) ||
    improvedRightVsV2 ||
    improvedBottomVsV2

  if (best && best.closed && closureConfidence >= 0.74 && weakNow.length === 0 && largestGap.gapPtApprox < 16) {
    basis = "strong_regularization_basis"
    statement =
      "V3 best boundary is **closed** with full side coverage and small residual gaps — **strong debug basis** for a later regularization pass (still not production-verified)."
  } else if (best && (best.closed || nearlyClosed) && closureConfidence >= 0.55 && improvedWeak && weakNow.length <= 1) {
    basis = "moderate_regularization_basis"
    statement =
      "V3 **improves** right/bottom locality vs v2 while staying conservative — **moderate** regularization input; expect further cleanup before 3D."
  } else if (improvedRightVsV2 || improvedBottomVsV2) {
    statement =
      "V3 shows **local** right/bottom improvement over v2, but the boundary is still largely **hint-level** — not a trustworthy production shell."
  }

  return {
    closureConfidence,
    largestGapSummary: largestGap,
    boundaryIsHintVsRegularizationBasis: basis,
    regularizationBasisStatement: statement,
  }
}

export function buildPlanBodyBoundaryRecoveryV3(
  primaryLayoutBBox: PlanBoundingBox,
  primaryLayoutSegments: ExtractedLineSegment[],
  primaryLayoutCleanedIndices: readonly number[],
  shellCandidateCleanedIndices: readonly number[],
  wallHypothesesPlanOnly: ArchitecturalWallHypothesesDebugPayload,
  globalSpansPlanOnly: GlobalStructuralSpansDebugPayload,
  shellLoopDebug: PlanBodyShellLoopDebug,
  boundaryRecoveryV2: PlanBodyBoundaryRecoveryV2Debug,
  opts?: PlanBodyBoundaryRecoveryV2Options
): PlanBodyBoundaryRecoveryV3Debug {
  const notes: string[] = []
  const shellSet = new Set(shellCandidateCleanedIndices)
  const shellSegs = shellSegmentsFromIndices(primaryLayoutSegments, primaryLayoutCleanedIndices, shellSet)
  const baseline = shellLoopDebug.sideCoverage

  const localizedGapZones = localizeGapsFromV2(primaryLayoutBBox, boundaryRecoveryV2)
  const unresolvedGapCount = localizedGapZones.length

  const v3BridgeSegments = findV3BridgesForZones(
    localizedGapZones,
    primaryLayoutBBox,
    primaryLayoutSegments,
    primaryLayoutCleanedIndices,
    shellSet,
    wallHypothesesPlanOnly,
    globalSpansPlanOnly,
    boundaryRecoveryV2.recoveredBridgeSegments,
    shellSegs
  )

  const merged = [...shellSegs, ...boundaryRecoveryV2.recoveredBridgeSegments, ...v3BridgeSegments]
  const candidates = collectBoundaryRecoveryCandidatesFromMerged(
    merged,
    primaryLayoutBBox,
    shellSegs,
    wallHypothesesPlanOnly,
    globalSpansPlanOnly,
    shellLoopDebug,
    opts
  )
  candidates.sort((a, b) => b.score - a.score)
  const best = candidates[0] ?? null
  const top = candidates.slice(0, 8)
  const v2Best = boundaryRecoveryV2.bestBoundaryCandidate

  const v2c = !!(v2Best?.closed && v2Best.boundaryPolylinePt.length >= 3)
  const bestPolyClosed = !!(best?.closed && best.boundaryPolylinePt.length >= 3)
  const improvedVsBoundaryRecoveryV2 = {
    right: !!(
      best &&
      v2Best &&
      ((!v2Best.sideCoverage.right && best.sideCoverage.right) ||
        edgeMaxGap(primaryLayoutBBox, "right", best.boundaryPolylinePt, bestPolyClosed) + 2 <
          edgeMaxGap(primaryLayoutBBox, "right", v2Best.boundaryPolylinePt, v2c))
    ),
    bottom: !!(
      best &&
      v2Best &&
      ((!v2Best.sideCoverage.bottom && best.sideCoverage.bottom) ||
        edgeMaxGap(primaryLayoutBBox, "bottom", best.boundaryPolylinePt, bestPolyClosed) + 2 <
          edgeMaxGap(primaryLayoutBBox, "bottom", v2Best.boundaryPolylinePt, v2c))
    ),
  }

  const fin = finalizeV3Diagnostics(best, baseline, primaryLayoutBBox, improvedVsBoundaryRecoveryV2.right, improvedVsBoundaryRecoveryV2.bottom)
  const sideSummary = best?.sideCoverage ?? { ...baseline }

  const rightSideImproved = (best?.sideCoverage.right && !baseline.right) || improvedVsBoundaryRecoveryV2.right
  const bottomSideImproved = (best?.sideCoverage.bottom && !baseline.bottom) || improvedVsBoundaryRecoveryV2.bottom

  let remainingGapZones: LocalizedSideGapV3[] = []
  if (best && best.boundaryPolylinePt.length >= 2) {
    const syntheticV2: PlanBodyBoundaryRecoveryV2Debug = {
      ...boundaryRecoveryV2,
      bestBoundaryCandidate: best,
    }
    remainingGapZones = localizeGapsFromV2(primaryLayoutBBox, syntheticV2)
  }

  notes.push(
    `V3: ${unresolvedGapCount} localized right/bottom gap zone(s); added ${v3BridgeSegments.length} conservative bridge segment(s) on top of v2.`
  )
  notes.push(fin.regularizationBasisStatement)
  if (remainingGapZones.length > 0) {
    notes.push(`${remainingGapZones.length} zone(s) still exceed gap threshold vs v3 best boundary along right/bottom edges.`)
  }

  return {
    unresolvedGapCount,
    recoveredBridgeCount: v3BridgeSegments.length,
    rightSideImproved,
    bottomSideImproved,
    bestBoundaryClosed: best?.closed ?? false,
    closureConfidence: fin.closureConfidence,
    sideCoverageSummary: sideSummary,
    largestGapSummary: fin.largestGapSummary,
    boundaryIsHintVsRegularizationBasis: fin.boundaryIsHintVsRegularizationBasis,
    regularizationBasisStatement: fin.regularizationBasisStatement,
    improvedVsBoundaryRecoveryV2,
    localizedGapZones,
    remainingGapZones,
    notes,
    v3BridgeSegments,
    bestBoundaryCandidate: best,
    candidateSummariesTop: top,
  }
}

export interface BuildPlanBodyBoundaryRecoveryV3SvgOptions {
  pageBounds: PlanBoundingBox
  primaryLayoutBBox: PlanBoundingBox
  shellCandidateCleanedIndices: readonly number[]
  fullCleanedSegments: ExtractedLineSegment[]
  shellLoopDebug: PlanBodyShellLoopDebug
  boundaryV2: PlanBodyBoundaryRecoveryV2Debug
  boundaryV3: PlanBodyBoundaryRecoveryV3Debug
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;")
}

export function buildPlanBodyBoundaryRecoveryV3SvgString(o: BuildPlanBodyBoundaryRecoveryV3SvgOptions): string {
  const pb = o.pageBounds
  const w = pb.maxX - pb.minX
  const h = pb.maxY - pb.minY
  const bx = o.primaryLayoutBBox
  const shellSet = new Set(o.shellCandidateCleanedIndices)

  const shellEdges = o.fullCleanedSegments
    .map((s, i) => {
      if (!shellSet.has(i)) return ""
      return `<line x1="${s.x1}" y1="${s.y1}" x2="${s.x2}" y2="${s.y2}" stroke="rgba(90,90,100,0.35)" stroke-width="0.75" stroke-linecap="round"/>`
    })
    .join("\n")

  let v2Path = ""
  const v2b = o.boundaryV2.bestBoundaryCandidate
  if (v2b && v2b.boundaryPolylinePt.length >= 2) {
    const pts = v2b.boundaryPolylinePt
    const d = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" ")
    const close = v2b.closed ? " Z" : ""
    v2Path = `<path d="${escapeXml(d + close)}" fill="none" stroke="rgba(100,140,190,0.35)" stroke-width="1.2" stroke-dasharray="5 5"/>`
  }

  const rightZones = o.boundaryV3.localizedGapZones
    .filter((z) => z.side === "right")
    .map(
      (z) =>
        `<rect x="${z.band.minX}" y="${z.band.minY}" width="${z.band.maxX - z.band.minX}" height="${z.band.maxY - z.band.minY}" fill="rgba(255,60,60,0.07)" stroke="rgba(200,40,40,0.55)" stroke-width="1" stroke-dasharray="3 2"/>`
    )
    .join("\n")
  const bottomZones = o.boundaryV3.localizedGapZones
    .filter((z) => z.side === "bottom")
    .map(
      (z) =>
        `<rect x="${z.band.minX}" y="${z.band.minY}" width="${z.band.maxX - z.band.minX}" height="${z.band.maxY - z.band.minY}" fill="rgba(255,140,40,0.08)" stroke="rgba(200,90,20,0.55)" stroke-width="1" stroke-dasharray="3 2"/>`
    )
    .join("\n")

  const remainRight = o.boundaryV3.remainingGapZones
    .filter((z) => z.side === "right")
    .map(
      (z) =>
        `<rect x="${z.band.minX}" y="${z.band.minY}" width="${z.band.maxX - z.band.minX}" height="${z.band.maxY - z.band.minY}" fill="rgba(180,40,180,0.06)" stroke="rgba(120,30,120,0.45)" stroke-width="0.85" stroke-dasharray="2 3"/>`
    )
    .join("\n")
  const remainBottom = o.boundaryV3.remainingGapZones
    .filter((z) => z.side === "bottom")
    .map(
      (z) =>
        `<rect x="${z.band.minX}" y="${z.band.minY}" width="${z.band.maxX - z.band.minX}" height="${z.band.maxY - z.band.minY}" fill="rgba(180,40,180,0.06)" stroke="rgba(120,30,120,0.45)" stroke-width="0.85" stroke-dasharray="2 3"/>`
    )
    .join("\n")

  const bridges = o.boundaryV3.v3BridgeSegments
    .map(
      (s) =>
        `<line x1="${s.x1}" y1="${s.y1}" x2="${s.x2}" y2="${s.y2}" stroke="rgba(0,110,160,0.9)" stroke-width="1.35" stroke-linecap="round"/>`
    )
    .join("\n")

  let bestPath = ""
  const b = o.boundaryV3.bestBoundaryCandidate
  if (b && b.boundaryPolylinePt.length >= 2) {
    const pts = b.boundaryPolylinePt
    const d = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" ")
    const close = b.closed ? " Z" : ""
    bestPath = `<path d="${escapeXml(d + close)}" fill="rgba(0,120,70,0.05)" stroke="rgba(0,100,55,0.95)" stroke-width="2.5" stroke-linejoin="round"/>`
  }

  const tr = o.shellLoopDebug.outerCycleTrace
  let openTrace = ""
  if (tr) {
    const pts = tr.fullVertexCycle && tr.fullVertexCycle.length >= 2 ? tr.fullVertexCycle : tr.vertexSample
    if (pts.length >= 2) {
      const d = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" ")
      openTrace = `<path d="${escapeXml(d)}" fill="none" stroke="rgba(70,70,80,0.45)" stroke-width="1" stroke-dasharray="4 4"/>`
    }
  }

  const basis = o.boundaryV3.boundaryIsHintVsRegularizationBasis
  const hintLabel =
    basis === "hint_only"
      ? "Result: still a HINT — not strong enough for shell regularization without more evidence."
      : basis === "moderate_regularization_basis"
        ? "Result: MODERATE basis — possible regularization input (debug only)."
        : "Result: STRONG debug basis — still verify before production."

  const title = `Boundary recovery v3 (targeted R/B) — v3 bridges=${o.boundaryV3.recoveredBridgeCount} zones=${o.boundaryV3.unresolvedGapCount} basis=${basis}`

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${pb.minX} ${pb.minY} ${w} ${h}" width="${Math.round(w)}" height="${Math.round(
    h
  )}">
<rect x="${pb.minX}" y="${pb.minY}" width="${w}" height="${h}" fill="white"/>
<text x="${pb.minX + 8}" y="${pb.minY + 14}" font-size="11" fill="#222" font-family="system-ui,sans-serif">${escapeXml(title)}</text>
<text x="${pb.minX + 8}" y="${pb.minY + 28}" font-size="9" fill="#333" font-family="system-ui,sans-serif">${escapeXml(hintLabel)}</text>
<text x="${pb.minX + 8}" y="${pb.minY + 42}" font-size="8" fill="#555" font-family="system-ui,sans-serif">${escapeXml(
    o.boundaryV3.regularizationBasisStatement.slice(0, 200) + (o.boundaryV3.regularizationBasisStatement.length > 200 ? "…" : "")
  )}</text>
<text x="${pb.minX + 8}" y="${pb.minY + 55}" font-size="7.5" fill="#666" font-family="system-ui,sans-serif">Legend: red=right gap zones, orange=bottom gap zones, purple=remaining gaps after v3; cyan=v3 bridges; green=v3 best boundary; faint blue=v2 best.</text>
<g>${rightZones}</g>
<g>${bottomZones}</g>
<g>${remainRight}</g>
<g>${remainBottom}</g>
<g>${shellEdges}</g>
<g>${openTrace}</g>
<g>${v2Path}</g>
<g>${bridges}</g>
<g>${bestPath}</g>
<rect x="${bx.minX}" y="${bx.minY}" width="${bx.maxX - bx.minX}" height="${bx.maxY - bx.minY}" fill="none" stroke="rgba(0,90,45,0.65)" stroke-width="1.6" stroke-dasharray="8 5"/>
</svg>`
}
