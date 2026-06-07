/**
 * Debug-only **plan-only boundary recovery v2**: concave-aware exterior boundary candidates when
 * the shell subgraph has no trustworthy closed left-face loop. Follows `planBodyShellLoop`; does
 * not claim a verified production shell.
 */

import type { ArchitecturalWallHypothesesDebugPayload } from "@/lib/geometryFirst/architecturalWallHypotheses"
import { segmentsNearlyEqual } from "@/lib/geometryFirst/architecturalWallHypotheses"
import type { GlobalStructuralSpansDebugPayload } from "@/lib/geometryFirst/globalStructuralSpans"
import { buildWallGraphFoundationFromCleaned } from "@/lib/geometryFirst/wallGraphFoundation"
import { splitWallLinesAtJunctions } from "@/lib/geometryFirst/splitWallLinesAtJunctions"
import type { ExtractedLineSegment, PlanBoundingBox } from "@/lib/geometryFirst/types"
import type { PlanBodyShellLoopDebug } from "@/lib/geometryFirst/planBodyShellLoop"

export interface PlanBodyBoundaryRecoveryV2Options {
  gapBandDepthPt?: number
  maxBridgesPerSide?: number
  maxTotalBridges?: number
  ribbonSamples?: number
  snapRadiusPt?: number
  hypExteriorMin?: number
  spanShellHintMin?: number
}

const V2_OPT: Required<PlanBodyBoundaryRecoveryV2Options> = {
  gapBandDepthPt: 52,
  maxBridgesPerSide: 11,
  maxTotalBridges: 38,
  ribbonSamples: 80,
  snapRadiusPt: 46,
  hypExteriorMin: 0.36,
  spanShellHintMin: 0.3,
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x))
}

function distToPerimeterInside(px: number, py: number, b: PlanBoundingBox): number {
  return Math.min(px - b.minX, b.maxX - px, py - b.minY, b.maxY - py)
}

function perimeterProximity(px: number, py: number, b: PlanBoundingBox, bandPt: number): number {
  const d = distToPerimeterInside(px, py, b)
  return clamp01(1 - d / Math.max(1e-6, bandPt))
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

export interface SideGapZone {
  side: "top" | "bottom" | "left" | "right"
  weak: boolean
  /** Lower = higher priority (right=0, bottom=1, …) */
  priority: number
  band: PlanBoundingBox
}

export interface BoundaryCandidateSummary {
  id: string
  strategy: "graph-retry" | "ribbon-snap" | "trace-gap-close"
  closed: boolean
  closureGapPt: number
  perimeterPt: number
  sideCoverage: { top: boolean; bottom: boolean; left: boolean; right: boolean }
  /** ~1 − area/convexHullArea when ≥3 points */
  concavityPlausibility: number
  supportShell: number
  supportHypothesis: number
  supportSpan: number
  score: number
  ambiguityNotes: string[]
  boundaryPolylinePt: Array<{ x: number; y: number }>
}

export interface PlanBodyBoundaryRecoveryV2Debug {
  boundaryCandidateCount: number
  bestBoundaryCandidate: BoundaryCandidateSummary | null
  bestBoundaryClosed: boolean
  closureConfidence: number
  sideCoverageSummary: { top: boolean; bottom: boolean; left: boolean; right: boolean }
  largestGapSummary: { side: string; gapPtApprox: number; note: string }
  recoveredBridgeCount: number
  candidateSummariesTop: BoundaryCandidateSummary[]
  sideGapZones: SideGapZone[]
  regularizationBasisStatement: string
  improvedRightVsShellLoop: boolean
  improvedBottomVsShellLoop: boolean
  nearlyClosedExteriorRecoverable: boolean
  rightSideWeaknessImproved: boolean
  bottomCoverageImproved: boolean
  boundaryIsHintVsRegularizationBasis: "hint_only" | "moderate_regularization_basis" | "strong_regularization_basis"
  /** Explicit: can we recover a closed or nearly-closed exterior boundary candidate (debug heuristic)? */
  closureRecoverabilityStatement: string
  /** Explicit: right/bottom vs shell-loop baseline after recovery. */
  weakSidesImprovementStatement: string
  notes: string[]
  /** For SVG: bridge segments as geometry */
  recoveredBridgeSegments: ExtractedLineSegment[]
}

function sideBand(bbox: PlanBoundingBox, side: SideGapZone["side"], depth: number): PlanBoundingBox {
  const { minX, minY, maxX, maxY } = bbox
  switch (side) {
    case "right":
      return { minX: maxX - depth, minY, maxX, maxY }
    case "left":
      return { minX, minY, maxX: minX + depth, maxY }
    case "top":
      return { minX, minY: maxY - depth, maxX, maxY }
    case "bottom":
      return { minX, minY, maxX, maxY: minY + depth }
  }
}

function pointInBox(px: number, py: number, b: PlanBoundingBox): boolean {
  return px >= b.minX && px <= b.maxX && py >= b.minY && py <= b.maxY
}

function buildSideGapZones(
  bbox: PlanBoundingBox,
  sideCoverage: PlanBodyShellLoopDebug["sideCoverage"],
  depth: number
): SideGapZone[] {
  const order: Array<{ side: SideGapZone["side"]; pri: number }> = [
    { side: "right", pri: 0 },
    { side: "bottom", pri: 1 },
    { side: "left", pri: 2 },
    { side: "top", pri: 3 },
  ]
  const out: SideGapZone[] = []
  for (const { side, pri } of order) {
    const weak = !sideCoverage[side]
    out.push({ side, weak, priority: pri, band: sideBand(bbox, side, depth) })
  }
  return out
}

function hypSpanScoreAt(
  mx: number,
  my: number,
  hyps: ArchitecturalWallHypothesesDebugPayload,
  spans: GlobalStructuralSpansDebugPayload,
  O: Required<PlanBodyBoundaryRecoveryV2Options>
): { hyp: number; sp: number } {
  let hyp = 0
  let sp = 0
  for (const h of hyps.hypotheses) {
    if (h.exteriorLikelihood < O.hypExteriorMin) continue
    const c = h.centerline
    const d = distPointToSegment(mx, my, c.x1, c.y1, c.x2, c.y2)
    hyp = Math.max(hyp, h.exteriorLikelihood * Math.exp(-d / 10))
  }
  for (const s of spans.spans) {
    if (s.shellHintScore < O.spanShellHintMin) continue
    const c = s.centerline
    const d = distPointToSegment(mx, my, c.x1, c.y1, c.x2, c.y2)
    sp = Math.max(sp, s.shellHintScore * Math.exp(-d / 12))
  }
  return { hyp, sp }
}

function findGapBridges(
  zones: SideGapZone[],
  primaryLayoutSegments: ExtractedLineSegment[],
  primaryLayoutCleanedIndices: readonly number[],
  shellSet: Set<number>,
  bbox: PlanBoundingBox,
  hyps: ArchitecturalWallHypothesesDebugPayload,
  spans: GlobalStructuralSpansDebugPayload,
  O: Required<PlanBodyBoundaryRecoveryV2Options>
): ExtractedLineSegment[] {
  const bridges: ExtractedLineSegment[] = []
  const seen = new Set<string>()
  const key = (s: ExtractedLineSegment) =>
    `${s.x1.toFixed(2)},${s.y1.toFixed(2)},${s.x2.toFixed(2)},${s.y2.toFixed(2)}`

  const weakZones = zones.filter((z) => z.weak).sort((a, b) => a.priority - b.priority)
  const perSideCount = new Map<string, number>()

  for (const zone of weakZones.length > 0 ? weakZones : zones) {
    let nSide = perSideCount.get(zone.side) ?? 0
    if (nSide >= O.maxBridgesPerSide || bridges.length >= O.maxTotalBridges) continue
    type Scored = { seg: ExtractedLineSegment; g: number; score: number }
    const scored: Scored[] = []
    for (let li = 0; li < primaryLayoutSegments.length; li++) {
      const g = primaryLayoutCleanedIndices[li]!
      if (shellSet.has(g)) continue
      const seg = primaryLayoutSegments[li]!
      const mx = (seg.x1 + seg.x2) / 2
      const my = (seg.y1 + seg.y2) / 2
      if (!pointInBox(mx, my, zone.band)) continue
      const per = perimeterProximity(mx, my, bbox, O.gapBandDepthPt + 8)
      if (per < 0.22) continue
      const { hyp, sp } = hypSpanScoreAt(mx, my, hyps, spans, O)
      const len = Math.hypot(seg.x2 - seg.x1, seg.y2 - seg.y1)
      const score = 0.38 * hyp + 0.38 * sp + 0.18 * per + 0.06 * clamp01(len / 80)
      if (score < 0.14 && hyp < 0.08 && sp < 0.08) continue
      scored.push({ seg, g, score })
    }
    scored.sort((a, b) => b.score - a.score)
    for (const row of scored) {
      if (nSide >= O.maxBridgesPerSide || bridges.length >= O.maxTotalBridges) break
      const k = key(row.seg)
      if (seen.has(k)) continue
      seen.add(k)
      bridges.push(row.seg)
      nSide++
    }
    perSideCount.set(zone.side, nSide)
  }

  return bridges
}

/** Small collinear extensions: connect shell endpoints to nearby plan segment endpoints. */
function findContinuationBridges(
  shellSegs: ExtractedLineSegment[],
  primaryLayoutSegments: ExtractedLineSegment[],
  primaryLayoutCleanedIndices: readonly number[],
  shellSet: Set<number>,
  maxAdd: number
): ExtractedLineSegment[] {
  const out: ExtractedLineSegment[] = []
  const eps = 3.2
  const gatherPts = (s: ExtractedLineSegment) => [
    { x: s.x1, y: s.y1 },
    { x: s.x2, y: s.y2 },
  ]
  const dirs = (s: ExtractedLineSegment) => {
    const dx = s.x2 - s.x1
    const dy = s.y2 - s.y1
    const L = Math.hypot(dx, dy)
    return L < 1e-6 ? { ux: 1, uy: 0 } : { ux: dx / L, uy: dy / L }
  }

  let added = 0
  for (const sh of shellSegs) {
    if (added >= maxAdd) break
    const du = dirs(sh)
    for (const p of gatherPts(sh)) {
      for (let li = 0; li < primaryLayoutSegments.length; li++) {
        if (added >= maxAdd) break
        const g = primaryLayoutCleanedIndices[li]!
        if (shellSet.has(g)) continue
        const o = primaryLayoutSegments[li]!
        for (const q of gatherPts(o)) {
          if (Math.hypot(p.x - q.x, p.y - q.y) > eps) continue
          const dv = dirs(o)
          const dot = Math.abs(du.ux * dv.ux + du.uy * dv.uy)
          if (dot < 0.88) continue
          let dup = false
          for (const ex of out) {
            if (segmentsNearlyEqual(ex, o, 1.1)) {
              dup = true
              break
            }
          }
          if (dup) continue
          out.push(o)
          added++
        }
      }
    }
  }
  return out
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

function convexHullArea(pts: Array<{ x: number; y: number }>): number {
  if (pts.length < 3) return 0
  const sorted = [...pts].sort((a, b) => a.x - b.x || a.y - b.y)
  const cross = (o: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const lower: typeof pts = []
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop()
    lower.push(p)
  }
  const upper: typeof pts = []
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i]!
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop()
    upper.push(p)
  }
  upper.pop()
  lower.pop()
  const h = lower.concat(upper)
  if (h.length < 3) return 0
  let a = 0
  const n = h.length
  for (let i = 0; i < n; i++) {
    const p = h[i]!
    const q = h[(i + 1) % n]!
    a += p.x * q.y - q.x * p.y
  }
  return Math.abs(a / 2)
}

function polylinePerimeter(pts: Array<{ x: number; y: number }>, closed: boolean): number {
  if (pts.length < 2) return 0
  let s = 0
  if (closed) {
    const n = pts.length
    for (let i = 0; i < n; i++) {
      const a = pts[i]!
      const b = pts[(i + 1) % n]!
      s += Math.hypot(b.x - a.x, b.y - a.y)
    }
  } else {
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i]!
      const b = pts[i + 1]!
      s += Math.hypot(b.x - a.x, b.y - a.y)
    }
  }
  return s
}

function loopSideCoverage(
  loopPts: Array<{ x: number; y: number }>,
  bbox: PlanBoundingBox,
  hitBand: number,
  closed: boolean
): { top: boolean; bottom: boolean; left: boolean; right: boolean } {
  const sampleBand = Math.min(28, hitBand * 1.15)
  const touch = (side: "top" | "bottom" | "left" | "right"): boolean => {
    const w = bbox.maxX - bbox.minX
    const h = bbox.maxY - bbox.minY
    const n = 10
    for (let i = 0; i <= n; i++) {
      const t = i / n
      let px: number
      let py: number
      if (side === "bottom") {
        px = bbox.minX + t * w
        py = bbox.minY + sampleBand * 0.35
      } else if (side === "top") {
        px = bbox.minX + t * w
        py = bbox.maxY - sampleBand * 0.35
      } else if (side === "left") {
        px = bbox.minX + sampleBand * 0.35
        py = bbox.minY + t * h
      } else {
        px = bbox.maxX - sampleBand * 0.35
        py = bbox.minY + t * h
      }
      if (distPointToPolylineEdges(px, py, loopPts, closed) <= hitBand) return true
    }
    return false
  }
  return {
    bottom: touch("bottom"),
    top: touch("top"),
    left: touch("left"),
    right: touch("right"),
  }
}

function largestGapAlongPerimeter(
  bbox: PlanBoundingBox,
  pts: Array<{ x: number; y: number }>,
  weakSides: string[],
  closed: boolean
): { side: string; gapPtApprox: number; note: string } {
  if (pts.length < 2 || weakSides.length === 0) {
    return { side: weakSides[0] ?? "right", gapPtApprox: 0, note: "insufficient polyline or no weak sides flagged" }
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
    note: `max sample distance ~${worst.toFixed(1)} pt along weak side(s) vs boundary polyline`,
  }
}

function ribbonSnapBoundary(
  bbox: PlanBoundingBox,
  features: ExtractedLineSegment[],
  hyps: ArchitecturalWallHypothesesDebugPayload,
  spans: GlobalStructuralSpansDebugPayload,
  O: Required<PlanBodyBoundaryRecoveryV2Options>
): Array<{ x: number; y: number }> {
  const w = bbox.maxX - bbox.minX
  const h = bbox.maxY - bbox.minY
  const perim = 2 * (w + h)
  const n = O.ribbonSamples
  const out: Array<{ x: number; y: number }> = []

  const perimeterPoint = (u: number): { x: number; y: number } => {
    u = ((u % perim) + perim) % perim
    if (u <= w) return { x: bbox.minX + u, y: bbox.minY }
    u -= w
    if (u <= h) return { x: bbox.maxX, y: bbox.minY + u }
    u -= h
    if (u <= w) return { x: bbox.maxX - u, y: bbox.maxY }
    u -= w
    return { x: bbox.minX, y: bbox.maxY - u }
  }

  const snap = (px: number, py: number): { x: number; y: number } => {
    let bestX = px
    let bestY = py
    let bestD = O.snapRadiusPt + 1
    for (const s of features) {
      const d = distPointToSegment(px, py, s.x1, s.y1, s.x2, s.y2)
      if (d < bestD) {
        let t =
          Math.max(
            0,
            Math.min(
              1,
              ((px - s.x1) * (s.x2 - s.x1) + (py - s.y1) * (s.y2 - s.y1)) /
                (Math.pow(s.x2 - s.x1, 2) + Math.pow(s.y2 - s.y1, 2) + 1e-12)
            )
          )
        bestX = s.x1 + t * (s.x2 - s.x1)
        bestY = s.y1 + t * (s.y2 - s.y1)
        bestD = d
      }
    }
    for (const h of hyps.hypotheses) {
      if (h.exteriorLikelihood < O.hypExteriorMin * 0.92) continue
      const c = h.centerline
      const d = distPointToSegment(px, py, c.x1, c.y1, c.x2, c.y2)
      if (d < bestD) {
        let t =
          Math.max(
            0,
            Math.min(
              1,
              ((px - c.x1) * (c.x2 - c.x1) + (py - c.y1) * (c.y2 - c.y1)) /
                (Math.pow(c.x2 - c.x1, 2) + Math.pow(c.y2 - c.y1, 2) + 1e-12)
            )
          )
        bestX = c.x1 + t * (c.x2 - c.x1)
        bestY = c.y1 + t * (c.y2 - c.y1)
        bestD = d
      }
    }
    for (const sp of spans.spans) {
      if (sp.shellHintScore < O.spanShellHintMin * 0.9) continue
      const c = sp.centerline
      const d = distPointToSegment(px, py, c.x1, c.y1, c.x2, c.y2)
      if (d < bestD) {
        let t =
          Math.max(
            0,
            Math.min(
              1,
              ((px - c.x1) * (c.x2 - c.x1) + (py - c.y1) * (c.y2 - c.y1)) /
                (Math.pow(c.x2 - c.x1, 2) + Math.pow(c.y2 - c.y1, 2) + 1e-12)
            )
          )
        bestX = c.x1 + t * (c.x2 - c.x1)
        bestY = c.y1 + t * (c.y2 - c.y1)
        bestD = d
      }
    }
    if (bestD > O.snapRadiusPt) {
      return { x: px, y: py }
    }
    const pull = perimeterProximity(bestX, bestY, bbox, 56)
    if (pull < 0.12) {
      return { x: px, y: py }
    }
    return { x: bestX, y: bestY }
  }

  for (let i = 0; i < n; i++) {
    const p = perimeterPoint((i / n) * perim)
    const q = snap(p.x, p.y)
    if (out.length === 0 || Math.hypot(q.x - out[out.length - 1]!.x, q.y - out[out.length - 1]!.y) > 0.8) {
      out.push(q)
    }
  }
  if (out.length >= 3 && Math.hypot(out[0]!.x - out[out.length - 1]!.x, out[0]!.y - out[out.length - 1]!.y) < 2) {
    out.pop()
  }
  return out
}

function traceGapClose(
  trace: PlanBodyShellLoopDebug["outerCycleTrace"],
  maxGap: number
): Array<{ x: number; y: number }> | null {
  if (!trace || trace.closed) return null
  const pts =
    trace.fullVertexCycle && trace.fullVertexCycle.length >= 2
      ? trace.fullVertexCycle.map((p) => ({ x: p.x, y: p.y }))
      : trace.vertexSample.map((p) => ({ x: p.x, y: p.y }))
  if (pts.length < 2) return null
  const a = pts[0]!
  const b = pts[pts.length - 1]!
  const g = Math.hypot(a.x - b.x, a.y - b.y)
  if (g > maxGap || g < 0.5) return null
  return [...pts, { x: a.x, y: a.y }]
}

function supportScoresForPolyline(
  pts: Array<{ x: number; y: number }>,
  closed: boolean,
  shellSegs: ExtractedLineSegment[],
  hyps: ArchitecturalWallHypothesesDebugPayload,
  spans: GlobalStructuralSpansDebugPayload
): { shell: number; hyp: number; sp: number } {
  const edgeCount = closed ? pts.length : pts.length - 1
  if (pts.length < 2 || edgeCount < 1) return { shell: 0, hyp: 0, sp: 0 }
  let shell = 0
  let hyp = 0
  let sp = 0
  for (let i = 0; i < edgeCount; i++) {
    const p = pts[i]!
    const q = closed ? pts[(i + 1) % pts.length]! : pts[i + 1]!
    const mx = (p.x + q.x) / 2
    const my = (p.y + q.y) / 2
    let ds = Infinity
    for (const s of shellSegs) {
      ds = Math.min(ds, distPointToSegment(mx, my, s.x1, s.y1, s.x2, s.y2))
    }
    shell += Math.exp(-ds / 8)
    const hs = hypSpanScoreAt(mx, my, hyps, spans, V2_OPT)
    hyp += hs.hyp
    sp += hs.sp
  }
  const norm = edgeCount
  return { shell: shell / norm, hyp: hyp / norm, sp: sp / norm }
}

function summarizeCandidate(
  id: string,
  strategy: BoundaryCandidateSummary["strategy"],
  pts: Array<{ x: number; y: number }>,
  closed: boolean,
  shellSegs: ExtractedLineSegment[],
  hyps: ArchitecturalWallHypothesesDebugPayload,
  spans: GlobalStructuralSpansDebugPayload,
  bbox: PlanBoundingBox,
  ambiguityNotes: string[]
): BoundaryCandidateSummary {
  const perim = polylinePerimeter(pts, closed)
  const hullA = convexHullArea(pts)
  let conc = 0.35
  if (closed && pts.length >= 3 && hullA > 1e-6) {
    const a = polygonSignedAreaAbs(pts)
    conc = clamp01(1 - Math.min(1, a / hullA))
  } else if (!closed) {
    conc = 0.22
  }
  let gap = 0
  if (!closed && pts.length >= 2) {
    const a0 = pts[0]!
    const b0 = pts[pts.length - 1]!
    gap = Math.hypot(a0.x - b0.x, a0.y - b0.y)
  }
  const polyClosed = closed && pts.length >= 3
  const side = loopSideCoverage(pts, bbox, 22, polyClosed)
  const sup = supportScoresForPolyline(pts, polyClosed, shellSegs, hyps, spans)
  const sidesHit = ["top", "bottom", "left", "right"].filter((k) => side[k as keyof typeof side]).length
  const score =
    (closed ? 0.42 : 0.18) +
    0.22 * clamp01(1 - gap / 45) +
    0.14 * (sidesHit / 4) +
    0.1 * sup.shell +
    0.08 * sup.hyp +
    0.08 * sup.sp +
    0.06 * conc +
    0.02 * clamp01(perim / Math.max(1e-6, 2 * ((bbox.maxX - bbox.minX) + (bbox.maxY - bbox.minY))))

  return {
    id,
    strategy,
    closed,
    closureGapPt: gap,
    perimeterPt: perim,
    sideCoverage: side,
    concavityPlausibility: conc,
    supportShell: sup.shell,
    supportHypothesis: sup.hyp,
    supportSpan: sup.sp,
    score,
    ambiguityNotes,
    boundaryPolylinePt: pts.slice(0, 400),
  }
}

function polygonSignedAreaAbs(pts: Array<{ x: number; y: number }>): number {
  if (pts.length < 3) return 0
  let a = 0
  const n = pts.length
  for (let i = 0; i < n; i++) {
    const p = pts[i]!
    const q = pts[(i + 1) % n]!
    a += p.x * q.y - q.x * p.y
  }
  return Math.abs(a / 2)
}

/**
 * Shared by v2 and v3: build boundary candidates from an augmented segment set (shell + bridges).
 * Debug-only; not a production API.
 */
export function collectBoundaryRecoveryCandidatesFromMerged(
  merged: ExtractedLineSegment[],
  primaryLayoutBBox: PlanBoundingBox,
  shellSegs: ExtractedLineSegment[],
  wallHypothesesPlanOnly: ArchitecturalWallHypothesesDebugPayload,
  globalSpansPlanOnly: GlobalStructuralSpansDebugPayload,
  shellLoopDebug: PlanBodyShellLoopDebug,
  opts?: PlanBodyBoundaryRecoveryV2Options
): BoundaryCandidateSummary[] {
  const O = { ...V2_OPT, ...opts }
  const candidates: BoundaryCandidateSummary[] = []
  if (merged.length > 0) {
    const { split: split2 } = splitWallLinesAtJunctions(merged)
    const wg2 = buildWallGraphFoundationFromCleaned(split2, {
      nodeMergeQuantizationPt: 0.82,
      hullSegmentMatchTolPt: 1.8,
    })
    const tr2 = wg2.outerCycleTrace
    if (tr2.closed && tr2.fullVertexCycle && tr2.fullVertexCycle.length >= 3) {
      const pts = tr2.fullVertexCycle.map((p) => ({ x: p.x, y: p.y }))
      candidates.push(
        summarizeCandidate("c-graph-retry", "graph-retry", pts, true, shellSegs, wallHypothesesPlanOnly, globalSpansPlanOnly, primaryLayoutBBox, [
          "Left-face cycle after local bridge augmentation (debug — not verified architectural exterior).",
        ])
      )
    } else if (tr2.vertexSample.length >= 3) {
      const pts = tr2.vertexSample.map((p) => ({ x: p.x, y: p.y }))
      candidates.push(
        summarizeCandidate("c-graph-retry-open", "graph-retry", pts, false, shellSegs, wallHypothesesPlanOnly, globalSpansPlanOnly, primaryLayoutBBox, [
          "Graph retry still yielded an open trace — boundary remains ambiguous.",
        ])
      )
    }
  }

  const ribbonPts = ribbonSnapBoundary(primaryLayoutBBox, merged, wallHypothesesPlanOnly, globalSpansPlanOnly, O)
  if (ribbonPts.length >= 4) {
    candidates.push(
      summarizeCandidate("c-ribbon", "ribbon-snap", ribbonPts, true, shellSegs, wallHypothesesPlanOnly, globalSpansPlanOnly, primaryLayoutBBox, [
        "Ribbon snap: samples on primaryLayoutBBox perimeter snapped to nearby shell/hyp/span evidence — concave-leaning heuristic.",
      ])
    )
  }

  const gapClosed = traceGapClose(shellLoopDebug.outerCycleTrace, 38)
  if (gapClosed && gapClosed.length >= 4) {
    candidates.push(
      summarizeCandidate("c-trace-bridge", "trace-gap-close", gapClosed.slice(0, -1), true, shellSegs, wallHypothesesPlanOnly, globalSpansPlanOnly, primaryLayoutBBox, [
        "Closed by bridging first/last vertices of best open shell-loop trace (short gap only).",
      ])
    )
  }

  return candidates
}

export function buildPlanBodyBoundaryRecoveryV2(
  primaryLayoutBBox: PlanBoundingBox,
  primaryLayoutSegments: ExtractedLineSegment[],
  primaryLayoutCleanedIndices: readonly number[],
  shellCandidateCleanedIndices: readonly number[],
  wallHypothesesPlanOnly: ArchitecturalWallHypothesesDebugPayload,
  globalSpansPlanOnly: GlobalStructuralSpansDebugPayload,
  shellLoopDebug: PlanBodyShellLoopDebug,
  opts?: PlanBodyBoundaryRecoveryV2Options
): PlanBodyBoundaryRecoveryV2Debug {
  const O = { ...V2_OPT, ...opts }
  const notes: string[] = []
  const shellSet = new Set(shellCandidateCleanedIndices)
  const shellSegs = shellSegmentsFromIndices(primaryLayoutSegments, primaryLayoutCleanedIndices, shellSet)
  const baseline = shellLoopDebug.sideCoverage

  const zones = buildSideGapZones(primaryLayoutBBox, baseline, O.gapBandDepthPt)
  const gapBridges = findGapBridges(
    zones,
    primaryLayoutSegments,
    primaryLayoutCleanedIndices,
    shellSet,
    primaryLayoutBBox,
    wallHypothesesPlanOnly,
    globalSpansPlanOnly,
    O
  )
  const contBridges = findContinuationBridges(
    shellSegs,
    primaryLayoutSegments,
    primaryLayoutCleanedIndices,
    shellSet,
    14
  )
  const allBridges = [...gapBridges]
  for (const c of contBridges) {
    if (allBridges.length >= O.maxTotalBridges + 14) break
    if (!allBridges.some((b) => segmentsNearlyEqual(b, c, 1.05))) allBridges.push(c)
  }
  const recoveredBridgeCount = allBridges.length

  if (gapBridges.length > 0) {
    notes.push(`Gap-aware bridges: ${gapBridges.length} segment(s) from weak-side bands (prioritize right, then bottom).`)
  }
  if (contBridges.length > 0) {
    notes.push(`Collinear continuation picks: ${contBridges.length} segment(s) near shell endpoints.`)
  }

  const merged = [...shellSegs, ...allBridges]
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

  const sideSummary = best?.sideCoverage ?? { ...baseline }
  const improvedRight = best != null && best.sideCoverage.right && !baseline.right
  const improvedBottom = best != null && best.sideCoverage.bottom && !baseline.bottom
  const weakNow = ["top", "bottom", "left", "right"].filter((k) => !sideSummary[k as keyof typeof sideSummary])
  const bestPolyClosed = !!(best?.closed && best.boundaryPolylinePt.length >= 3)
  const largestGap = best
    ? largestGapAlongPerimeter(
        primaryLayoutBBox,
        best.boundaryPolylinePt,
        weakNow.length > 0 ? weakNow : ["right"],
        bestPolyClosed
      )
    : { side: "right", gapPtApprox: 0, note: "no boundary candidate" }

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

  let basis: PlanBodyBoundaryRecoveryV2Debug["boundaryIsHintVsRegularizationBasis"] = "hint_only"
  let statement =
    "Recovered boundary is a **debug hint only** — not a verified exterior loop; insufficient for production shell regularization without further evidence."

  if (best && best.closed && closureConfidence >= 0.72 && weakNow.length === 0 && largestGap.gapPtApprox < 18) {
    basis = "strong_regularization_basis"
    statement =
      "Best candidate is **closed** with full side coverage and modest residual gaps — could serve as a **strong (debug) basis** for a later shell regularization pass (still not production-verified)."
  } else if (best && (best.closed || nearlyClosed) && closureConfidence >= 0.52 && (improvedRight || improvedBottom) && weakNow.length <= 1) {
    basis = "moderate_regularization_basis"
    statement =
      "Boundary recovery **improves** weak sides vs shell-loop baseline and is **moderately** suitable as input to **shell regularization** — expect manual or algorithmic cleanup before any 3D use."
  } else if (best && (improvedRight || improvedBottom)) {
    statement =
      "Right/bottom (or other weak sides) **may be improved** vs the shell-loop step, but the result remains a **heuristic boundary candidate** — **hint-level** for regularization, not a final shell."
  }

  notes.push(statement)

  const closureRecoverabilityStatement =
    best == null
      ? "No boundary candidate was built — cannot recover a closed or nearly-closed exterior boundary from v2 inputs alone."
      : best.closed
        ? "A **closed** exterior boundary **candidate** was recovered (debug heuristic — not verified architecture)."
        : nearlyClosed
          ? "No trustworthy **closed** loop, but a **nearly closed** candidate exists (small endpoint gap or strong ribbon closure)."
          : "Candidates remain **open** with a **non-trivial closure gap** — not a verified closed exterior."

  const weakSidesImprovementStatement = `Right-side weakness vs shell loop: ${improvedRight ? "improved" : "not improved"}. Bottom coverage vs shell loop: ${improvedBottom ? "improved" : "not improved"}.`

  return {
    boundaryCandidateCount: candidates.length,
    bestBoundaryCandidate: best,
    bestBoundaryClosed: best?.closed ?? false,
    closureConfidence,
    sideCoverageSummary: sideSummary,
    largestGapSummary: largestGap,
    recoveredBridgeCount,
    candidateSummariesTop: top,
    sideGapZones: zones,
    regularizationBasisStatement: statement,
    improvedRightVsShellLoop: improvedRight,
    improvedBottomVsShellLoop: improvedBottom,
    nearlyClosedExteriorRecoverable: nearlyClosed,
    rightSideWeaknessImproved: improvedRight,
    bottomCoverageImproved: improvedBottom,
    boundaryIsHintVsRegularizationBasis: basis,
    closureRecoverabilityStatement,
    weakSidesImprovementStatement,
    notes,
    recoveredBridgeSegments: allBridges,
  }
}

export interface BuildPlanBodyBoundaryRecoveryV2SvgOptions {
  pageBounds: PlanBoundingBox
  primaryLayoutBBox: PlanBoundingBox
  shellCandidateCleanedIndices: readonly number[]
  fullCleanedSegments: ExtractedLineSegment[]
  shellLoopDebug: PlanBodyShellLoopDebug
  boundaryDebug: PlanBodyBoundaryRecoveryV2Debug
  wallHypothesesPlanOnly: ArchitecturalWallHypothesesDebugPayload
  globalSpansPlanOnly: GlobalStructuralSpansDebugPayload
}

export function buildPlanBodyBoundaryRecoveryV2SvgString(o: BuildPlanBodyBoundaryRecoveryV2SvgOptions): string {
  const pb = o.pageBounds
  const w = pb.maxX - pb.minX
  const h = pb.maxY - pb.minY
  const bx = o.primaryLayoutBBox
  const shellSet = new Set(o.shellCandidateCleanedIndices)

  const shellEdges = o.fullCleanedSegments
    .map((s, i) => {
      if (!shellSet.has(i)) return ""
      return `<line x1="${s.x1}" y1="${s.y1}" x2="${s.x2}" y2="${s.y2}" stroke="rgba(90,90,100,0.42)" stroke-width="0.85" stroke-linecap="round"/>`
    })
    .join("\n")

  const hypFaint = o.wallHypothesesPlanOnly.svgStrokes
    .map(
      (st) =>
        `<path d="${escapeXml(st.d)}" fill="none" stroke="rgba(130,165,215,0.22)" stroke-width="0.65" stroke-linecap="round"/>`
    )
    .join("\n")
  const spanFaint = o.globalSpansPlanOnly.svgStrokes
    .map(
      (st) =>
        `<path d="${escapeXml(st.d)}" fill="none" stroke="rgba(175,140,210,0.2)" stroke-width="0.62" stroke-linecap="round"/>`
    )
    .join("\n")

  let openTracePath = ""
  const tr = o.shellLoopDebug.outerCycleTrace
  if (tr) {
    const pts = tr.fullVertexCycle && tr.fullVertexCycle.length >= 2 ? tr.fullVertexCycle : tr.vertexSample
    if (pts.length >= 2) {
      const d = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" ")
      openTracePath = `<path d="${escapeXml(d)}" fill="none" stroke="rgba(80,80,90,0.55)" stroke-width="1.3" stroke-dasharray="5 4"/>`
    }
  }

  const gapRects = o.boundaryDebug.sideGapZones
    .filter((z) => z.weak)
    .map(
      (z) =>
        `<rect x="${z.band.minX}" y="${z.band.minY}" width="${z.band.maxX - z.band.minX}" height="${z.band.maxY - z.band.minY}" fill="rgba(255,80,80,0.06)" stroke="rgba(200,60,60,0.35)" stroke-width="0.9" stroke-dasharray="4 3"/>`
    )
    .join("\n")

  const bridges = o.boundaryDebug.recoveredBridgeSegments
    .map(
      (s) =>
        `<line x1="${s.x1}" y1="${s.y1}" x2="${s.x2}" y2="${s.y2}" stroke="rgba(200,120,40,0.75)" stroke-width="1.15" stroke-linecap="round"/>`
    )
    .join("\n")

  const candPaths = o.boundaryDebug.candidateSummariesTop
    .slice(1)
    .filter((c) => c.boundaryPolylinePt.length >= 2)
    .map((c) => {
      const pts = c.boundaryPolylinePt
      const d = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" ")
      const close = c.closed ? " Z" : ""
      return `<path d="${escapeXml(d + close)}" fill="none" stroke="rgba(100,140,200,0.45)" stroke-width="1" stroke-dasharray="6 4"/>`
    })
    .join("\n")

  let bestPath = ""
  const b = o.boundaryDebug.bestBoundaryCandidate
  if (b && b.boundaryPolylinePt.length >= 2) {
    const pts = b.boundaryPolylinePt
    const d = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" ")
    const close = b.closed ? " Z" : ""
    bestPath = `<path d="${escapeXml(d + close)}" fill="rgba(0,140,90,0.04)" stroke="rgba(0,120,75,0.95)" stroke-width="2.6" stroke-linejoin="round"/>`
  }

  let hullCmp = ""
  const fh = o.shellLoopDebug.fallbackHullVertices
  if (fh && fh.length >= 3) {
    const d = fh.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" ") + " Z"
    hullCmp = `<path d="${escapeXml(d)}" fill="none" stroke="rgba(160,100,30,0.4)" stroke-width="1" stroke-dasharray="3 5"/>`
  }

  const sc = o.boundaryDebug.sideCoverageSummary
  const labels: string[] = []
  const midY = (bx.minY + bx.maxY) / 2
  const midX = (bx.minX + bx.maxX) / 2
  if (!sc.right) labels.push(`<text x="${bx.maxX - 4}" y="${midY}" font-size="9.5" fill="#a22" text-anchor="end" font-family="system-ui,sans-serif">R weak</text>`)
  if (!sc.bottom)
    labels.push(`<text x="${midX}" y="${bx.minY + 12}" font-size="9.5" fill="#a22" text-anchor="middle" font-family="system-ui,sans-serif">B weak</text>`)
  if (!sc.left) labels.push(`<text x="${bx.minX + 4}" y="${midY}" font-size="9.5" fill="#822" text-anchor="start" font-family="system-ui,sans-serif">L weak</text>`)
  if (!sc.top)
    labels.push(`<text x="${midX}" y="${bx.maxY - 6}" font-size="9.5" fill="#822" text-anchor="middle" font-family="system-ui,sans-serif">T weak</text>`)

  const title = `Boundary recovery v2 — candidates=${o.boundaryDebug.boundaryCandidateCount} bridges=${o.boundaryDebug.recoveredBridgeCount} basis=${o.boundaryDebug.boundaryIsHintVsRegularizationBasis}`

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${pb.minX} ${pb.minY} ${w} ${h}" width="${Math.round(w)}" height="${Math.round(
    h
  )}">
<rect x="${pb.minX}" y="${pb.minY}" width="${w}" height="${h}" fill="white"/>
<text x="${pb.minX + 8}" y="${pb.minY + 14}" font-size="11" fill="#222" font-family="system-ui,sans-serif">${escapeXml(title)}</text>
<text x="${pb.minX + 8}" y="${pb.minY + 28}" font-size="8.5" fill="#444" font-family="system-ui,sans-serif">${escapeXml(
    o.boundaryDebug.regularizationBasisStatement.slice(0, 220) + (o.boundaryDebug.regularizationBasisStatement.length > 220 ? "…" : "")
  )}</text>
<g>${spanFaint}</g>
<g>${hypFaint}</g>
<g>${gapRects}</g>
<g>${shellEdges}</g>
<g>${openTracePath}</g>
<g>${bridges}</g>
<g>${hullCmp}</g>
<g>${candPaths}</g>
<g>${bestPath}</g>
<rect x="${bx.minX}" y="${bx.minY}" width="${bx.maxX - bx.minX}" height="${bx.maxY - bx.minY}" fill="none" stroke="rgba(0,100,50,0.78)" stroke-width="2" stroke-dasharray="10 6"/>
${labels.join("\n")}
</svg>`
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;")
}
