/**
 * Debug-only **plan-only shell regularization**: simplify and stabilize the v3 best exterior boundary candidate into a cleaner polygon for later debug evaluation (not production, not 3D).
 */

import type { ArchitecturalWallHypothesesDebugPayload } from "@/lib/geometryFirst/architecturalWallHypotheses"
import type { GlobalStructuralSpansDebugPayload } from "@/lib/geometryFirst/globalStructuralSpans"
import type { LocalizedSideGapV3, PlanBodyBoundaryRecoveryV3Debug } from "@/lib/geometryFirst/planBodyBoundaryRecoveryV3"
import type { ExtractedLineSegment, PlanBoundingBox } from "@/lib/geometryFirst/types"

type Pt = { x: number; y: number }

const REG = {
  collinearCosMin: 0.994,
  collinearCosMinSupported: 0.9985,
  shortEdgePt: 2.4,
  spikeEdgeMaxPt: 9,
  spikeTurnDegMax: 52,
  notchAreaMax: 22,
  rdpEpsilonPt: 1.35,
  axisTolDeg: 3.1,
  axisSupportMin: 0.48,
  syntheticShellDistPt: 14,
  syntheticHypMax: 0.12,
  syntheticSpanMax: 0.12,
  ambiguousMarginPt: 10,
} as const

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x))
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
  t = clamp(t, 0, 1)
  const qx = x1 + t * dx
  const qy = y1 + t * dy
  return Math.hypot(px - qx, py - qy)
}

function nearestShellDist(mx: number, my: number, shellSegs: ExtractedLineSegment[]): number {
  let d = Infinity
  for (const s of shellSegs) {
    d = Math.min(d, distPointToSegment(mx, my, s.x1, s.y1, s.x2, s.y2))
  }
  return d
}

function hypSpanAt(
  mx: number,
  my: number,
  hyps: ArchitecturalWallHypothesesDebugPayload,
  spans: GlobalStructuralSpansDebugPayload
): { hyp: number; sp: number } {
  let hyp = 0
  let sp = 0
  for (const h of hyps.hypotheses) {
    if (h.exteriorLikelihood < 0.28) continue
    const c = h.centerline
    const d = distPointToSegment(mx, my, c.x1, c.y1, c.x2, c.y2)
    hyp = Math.max(hyp, h.exteriorLikelihood * Math.exp(-d / 10))
  }
  for (const s of spans.spans) {
    if (s.shellHintScore < 0.22) continue
    const c = s.centerline
    const d = distPointToSegment(mx, my, c.x1, c.y1, c.x2, c.y2)
    sp = Math.max(sp, s.shellHintScore * Math.exp(-d / 12))
  }
  return { hyp, sp }
}

function supportAt(mx: number, my: number, shellSegs: ExtractedLineSegment[], hyps: ArchitecturalWallHypothesesDebugPayload, spans: GlobalStructuralSpansDebugPayload): number {
  const ds = nearestShellDist(mx, my, shellSegs)
  const shell = Math.exp(-ds / 8)
  const { hyp, sp } = hypSpanAt(mx, my, hyps, spans)
  return clamp(0.52 * shell + 0.28 * hyp + 0.2 * sp, 0, 1)
}

function uniqueClosedRing(pts: Pt[], closed: boolean): Pt[] {
  if (!closed || pts.length < 2) return pts.map((p) => ({ ...p }))
  const p = pts.map((q) => ({ ...q }))
  if (p.length >= 2 && Math.hypot(p[0]!.x - p[p.length - 1]!.x, p[0]!.y - p[p.length - 1]!.y) < 0.75) p.pop()
  return p
}

function ringToOpenWithClosure(pts: Pt[]): Pt[] {
  if (pts.length < 2) return pts.map((p) => ({ ...p }))
  return [...pts.map((p) => ({ ...p })), { ...pts[0]! }]
}

function rdpOpen(points: Pt[], epsilon: number): Pt[] {
  if (points.length < 3) return points.map((p) => ({ ...p }))
  let dmax = 0
  let index = 0
  const last = points.length - 1
  for (let i = 1; i < last; i++) {
    const d = distPointToSegment(
      points[i]!.x,
      points[i]!.y,
      points[0]!.x,
      points[0]!.y,
      points[last]!.x,
      points[last]!.y
    )
    if (d > dmax) {
      index = i
      dmax = d
    }
  }
  if (dmax > epsilon) {
    const rec1 = rdpOpen(points.slice(0, index + 1), epsilon)
    const rec2 = rdpOpen(points.slice(index), epsilon)
    return [...rec1.slice(0, -1), ...rec2]
  }
  return [{ ...points[0]! }, { ...points[last]! }]
}

function rdpClosedRing(ring: Pt[], epsilon: number): Pt[] {
  if (ring.length < 4) return ring.map((p) => ({ ...p }))
  const open = ringToOpenWithClosure(ring)
  const simp = rdpOpen(open, epsilon)
  if (simp.length >= 2 && Math.hypot(simp[0]!.x - simp[simp.length - 1]!.x, simp[0]!.y - simp[simp.length - 1]!.y) < 0.5) {
    simp.pop()
  }
  return simp.length >= 3 ? simp : ring.map((p) => ({ ...p }))
}

function cross2(ax: number, ay: number, bx: number, by: number): number {
  return ax * by - ay * bx
}

function triangleArea(a: Pt, b: Pt, c: Pt): number {
  return Math.abs(cross2(b.x - a.x, b.y - a.y, c.x - a.x, c.y - a.y)) / 2
}

function mergeCollinear(ring: Pt[], closed: boolean, cosMin: number, removed: Pt[]): Pt[] {
  let r = ring.map((p) => ({ ...p }))
  let changed = true
  const minVerts = closed ? 3 : 2
  while (changed && r.length > minVerts) {
    changed = false
    const n = r.length
    const iStart = closed ? 0 : 1
    const iEnd = closed ? n : n - 1
    for (let i = iStart; i < iEnd; i++) {
      const a = closed ? r[(i - 1 + n) % n]! : r[i - 1]!
      const b = r[i]!
      const c = closed ? r[(i + 1) % n]! : r[i + 1]!
      const vx = b.x - a.x
      const vy = b.y - a.y
      const wx = c.x - b.x
      const wy = c.y - b.y
      const lenV = Math.hypot(vx, vy)
      const lenW = Math.hypot(wx, wy)
      if (lenV < 0.35 || lenW < 0.35) {
        removed.push({ ...b })
        r.splice(i, 1)
        changed = true
        break
      }
      const dot = (vx * wx + vy * wy) / (lenV * lenW)
      if (dot > cosMin) {
        removed.push({ ...b })
        r.splice(i, 1)
        changed = true
        break
      }
    }
  }
  return r
}

function removeSpikesAndTinyNotches(ring: Pt[], closed: boolean, removed: Pt[]): Pt[] {
  let r = ring.map((p) => ({ ...p }))
  let changed = true
  const minVerts = closed ? 3 : 2
  while (changed && r.length > minVerts) {
    changed = false
    const n = r.length
    const iStart = closed ? 0 : 1
    const iEndExclusive = closed ? n : n - 1
    for (let ii = iStart; ii < iEndExclusive; ii++) {
      const i = ii
      const a = closed ? r[(i - 1 + n) % n]! : r[i - 1]!
      const b = r[i]!
      const c = closed ? r[(i + 1) % n]! : r[i + 1]!
      const ab = Math.hypot(b.x - a.x, b.y - a.y)
      const bc = Math.hypot(c.x - b.x, c.y - b.y)
      const vx = b.x - a.x
      const vy = b.y - a.y
      const wx = c.x - b.x
      const wy = c.y - b.y
      const lv = Math.hypot(vx, vy)
      const lw = Math.hypot(wx, wy)
      if (lv < 1e-6 || lw < 1e-6) continue
      const dot = clamp((vx * wx + vy * wy) / (lv * lw), -1, 1)
      const turn = (Math.acos(dot) * 180) / Math.PI
      if (ab < REG.spikeEdgeMaxPt && bc < REG.spikeEdgeMaxPt && turn < REG.spikeTurnDegMax) {
        removed.push({ ...b })
        r.splice(i, 1)
        changed = true
        break
      }
      const ar = triangleArea(a, b, c)
      if (ab < REG.shortEdgePt * 2 && bc < REG.shortEdgePt * 2 && ar < REG.notchAreaMax && turn < 70) {
        removed.push({ ...b })
        r.splice(i, 1)
        changed = true
        break
      }
    }
  }
  return r
}

function edgeSupport(
  ring: Pt[],
  closed: boolean,
  shellSegs: ExtractedLineSegment[],
  hyps: ArchitecturalWallHypothesesDebugPayload,
  spans: GlobalStructuralSpansDebugPayload
): number[] {
  const n = ring.length
  const m = closed ? n : n - 1
  const sup: number[] = []
  for (let i = 0; i < m; i++) {
    const a = ring[i]!
    const b = closed ? ring[(i + 1) % n]! : ring[i + 1]!
    const mx = (a.x + b.x) / 2
    const my = (a.y + b.y) / 2
    sup.push(supportAt(mx, my, shellSegs, hyps, spans))
  }
  return sup
}

function axisStabilizeRing(ring: Pt[], edgeSupport: number[]): Pt[] {
  if (ring.length < 3) return ring.map((p) => ({ ...p }))
  const n = ring.length
  const out = ring.map((p) => ({ ...p }))
  for (let i = 0; i < n; i++) {
    if (edgeSupport[i]! < REG.axisSupportMin) continue
    const p0 = out[i]!
    const p1 = out[(i + 1) % n]!
    const dx = p1.x - p0.x
    const dy = p1.y - p0.y
    const len = Math.hypot(dx, dy)
    if (len < 4) continue
    const ang = (Math.atan2(dy, dx) * 180) / Math.PI
    const a = ((ang % 360) + 360) % 360
    const distH = Math.min(a, 180 - a, Math.abs(a - 180), 360 - a)
    const distV = Math.min(Math.abs(a - 90), Math.abs(a - 270))
    const tol = REG.axisTolDeg
    if (distH <= tol) {
      const y = (p0.y + p1.y) / 2
      out[(i + 1) % n] = { x: p1.x, y }
    } else if (distV <= tol) {
      const x = (p0.x + p1.x) / 2
      out[(i + 1) % n] = { x, y: p1.y }
    }
  }
  return out
}

function polylinePerimeter(ring: Pt[], closed: boolean): number {
  if (ring.length < 2) return 0
  let s = 0
  const m = closed ? ring.length : ring.length - 1
  for (let i = 0; i < m; i++) {
    const a = ring[i]!
    const b = closed ? ring[(i + 1) % ring.length]! : ring[i + 1]!
    s += Math.hypot(b.x - a.x, b.y - a.y)
  }
  return s
}

function midpointInExpandedBox(mx: number, my: number, b: PlanBoundingBox, margin: number): boolean {
  return mx >= b.minX - margin && mx <= b.maxX + margin && my >= b.minY - margin && my <= b.maxY + margin
}

export interface RegularizedEdgeDebug {
  edgeIndex: number
  x1: number
  y1: number
  x2: number
  y2: number
  support: number
  nearestShellDistPt: number
  ambiguousFromGapZone: boolean
  syntheticLowConfidence: boolean
}

export interface PlanBodyShellRegularizationDebug {
  regularizedBoundaryClosed: boolean
  regularizedVertexCountBefore: number
  regularizedVertexCountAfter: number
  regularizedPerimeterPt: number
  supportScoreSummary: {
    meanEdgeSupport: number
    meanNearestShellDistPt: number
    syntheticEdgeCount: number
    ambiguousEdgeCount: number
  }
  ambiguousRegionCount: number
  remainingWeakZones: LocalizedSideGapV3[]
  regularizationQualityStatement: string
  extrusionReadinessStatement: string
  regularizedPolygonPt: Pt[]
  removedOrSimplifiedVertices: Pt[]
  /** Short segments representing collapsed/simplified runs (for SVG). */
  microFeatureSegments: ExtractedLineSegment[]
  edgeAnnotations: RegularizedEdgeDebug[]
  notes: string[]
}

function shellSegmentsFromCleaned(full: ExtractedLineSegment[], shellSet: Set<number>): ExtractedLineSegment[] {
  const out: ExtractedLineSegment[] = []
  for (let i = 0; i < full.length; i++) {
    if (shellSet.has(i)) out.push(full[i]!)
  }
  return out
}

export function buildPlanBodyShellRegularization(
  primaryLayoutBBox: PlanBoundingBox,
  boundaryRecoveryV3: PlanBodyBoundaryRecoveryV3Debug,
  shellCandidateCleanedIndices: readonly number[],
  fullCleanedSegments: ExtractedLineSegment[],
  wallHypothesesPlanOnly: ArchitecturalWallHypothesesDebugPayload,
  globalSpansPlanOnly: GlobalStructuralSpansDebugPayload
): PlanBodyShellRegularizationDebug {
  const notes: string[] = []
  const best = boundaryRecoveryV3.bestBoundaryCandidate
  const removedOrSimplified: Pt[] = []
  const microFeatureSegments: ExtractedLineSegment[] = []

  if (!best || best.boundaryPolylinePt.length < 3) {
    notes.push("No v3 best boundary — skipping shell regularization.")
    return {
      regularizedBoundaryClosed: false,
      regularizedVertexCountBefore: best?.boundaryPolylinePt.length ?? 0,
      regularizedVertexCountAfter: 0,
      regularizedPerimeterPt: 0,
      supportScoreSummary: {
        meanEdgeSupport: 0,
        meanNearestShellDistPt: Infinity,
        syntheticEdgeCount: 0,
        ambiguousEdgeCount: 0,
      },
      ambiguousRegionCount: boundaryRecoveryV3.remainingGapZones.length,
      remainingWeakZones: boundaryRecoveryV3.remainingGapZones.slice(0, 20),
      regularizationQualityStatement: "Regularization skipped — insufficient boundary candidate.",
      extrusionReadinessStatement: "Not ready for extrusion; establish a recoverable closed boundary first.",
      regularizedPolygonPt: [],
      removedOrSimplifiedVertices: [],
      microFeatureSegments: [],
      edgeAnnotations: [],
      notes,
    }
  }

  const closed = !!(best.closed && best.boundaryPolylinePt.length >= 3)
  let ring = uniqueClosedRing(best.boundaryPolylinePt, closed)
  const beforeCount = ring.length

  if (closed && ring.length >= 4) {
    ring = rdpClosedRing(ring, REG.rdpEpsilonPt)
  } else if (!closed && ring.length >= 3) {
    ring = rdpOpen(ring.map((p) => ({ ...p })), REG.rdpEpsilonPt)
  }

  ring = mergeCollinear(ring, closed, REG.collinearCosMin, removedOrSimplified)
  ring = removeSpikesAndTinyNotches(ring, closed, removedOrSimplified)

  const removedSup: Pt[] = []
  ring = mergeCollinear(ring, closed, REG.collinearCosMinSupported, removedSup)
  removedOrSimplified.push(...removedSup)

  if (closed && ring.length >= 3) {
    const sup = edgeSupport(
      ring,
      true,
      shellSegmentsFromCleaned(fullCleanedSegments, new Set(shellCandidateCleanedIndices)),
      wallHypothesesPlanOnly,
      globalSpansPlanOnly
    )
    ring = axisStabilizeRing(ring, sup)
    ring = mergeCollinear(ring, true, REG.collinearCosMin, removedOrSimplified)
  }

  const afterCount = ring.length
  const perim = polylinePerimeter(ring, closed)

  const shellSegs = shellSegmentsFromCleaned(fullCleanedSegments, new Set(shellCandidateCleanedIndices))
  const edgeAnnotations: RegularizedEdgeDebug[] = []
  const m = closed ? ring.length : Math.max(0, ring.length - 1)
  let sumSup = 0
  let sumShellD = 0
  let syntheticEdgeCount = 0
  let ambiguousEdgeCount = 0

  for (let i = 0; i < m; i++) {
    const a = ring[i]!
    const b = closed ? ring[(i + 1) % ring.length]! : ring[i + 1]!
    const mx = (a.x + b.x) / 2
    const my = (a.y + b.y) / 2
    const supE = supportAt(mx, my, shellSegs, wallHypothesesPlanOnly, globalSpansPlanOnly)
    const ds = nearestShellDist(mx, my, shellSegs)
    const { hyp, sp } = hypSpanAt(mx, my, wallHypothesesPlanOnly, globalSpansPlanOnly)
    const ambiguous = boundaryRecoveryV3.remainingGapZones.some((z) => midpointInExpandedBox(mx, my, z.band, REG.ambiguousMarginPt))
    const synthetic =
      ds > REG.syntheticShellDistPt && hyp < REG.syntheticHypMax && sp < REG.syntheticSpanMax && supE < 0.42
    if (synthetic) syntheticEdgeCount++
    if (ambiguous) ambiguousEdgeCount++
    sumSup += supE
    sumShellD += ds
    edgeAnnotations.push({
      edgeIndex: i,
      x1: a.x,
      y1: a.y,
      x2: b.x,
      y2: b.y,
      support: supE,
      nearestShellDistPt: ds,
      ambiguousFromGapZone: ambiguous,
      syntheticLowConfidence: synthetic,
    })
  }

  for (const p of removedOrSimplified.slice(0, 400)) {
    microFeatureSegments.push({
      x1: p.x - 0.6,
      y1: p.y - 0.6,
      x2: p.x + 0.6,
      y2: p.y + 0.6,
    })
  }

  const meanEdgeSupport = m > 0 ? sumSup / m : 0
  const meanNearestShellD = m > 0 ? sumShellD / m : Infinity

  const weakRemaining = boundaryRecoveryV3.remainingGapZones.filter((z) => {
    return edgeAnnotations.some((e) => {
      const mx = (e.x1 + e.x2) / 2
      const my = (e.y1 + e.y2) / 2
      return midpointInExpandedBox(mx, my, z.band, REG.ambiguousMarginPt)
    })
  })

  const ambiguousRegionCount = boundaryRecoveryV3.remainingGapZones.filter((z) =>
    edgeAnnotations.some((e) => {
      const mx = (e.x1 + e.x2) / 2
      const my = (e.y1 + e.y2) / 2
      return midpointInExpandedBox(mx, my, z.band, REG.ambiguousMarginPt)
    })
  ).length

  let quality = `Regularized ${beforeCount}→${afterCount} vertices (${removedOrSimplified.length} removals/merges); perimeter ${perim.toFixed(1)}pt; mean edge support ${meanEdgeSupport.toFixed(2)}.`
  let extrusion =
    "Debug-only polygon is **more stable** for inspection — **not** cleared for production 3D extrusion; treat as evaluation geometry with heuristic provenance."

  if (syntheticEdgeCount > m * 0.35) {
    quality += " Many low-confidence (synthetic) edges — shape is still weakly anchored to measured walls."
    extrusion =
      "High fraction of synthetic edges — **do not** use for extrusion until wall evidence improves or manual review."
  } else if (ambiguousRegionCount > 0) {
    quality += ` ${ambiguousRegionCount} remaining gap zone(s) overlap regularized edges — those spans are **not** verified walls.`
  }

  if (afterCount < 4 && closed) {
    extrusion = "Degenerate regularized polygon — not suitable for extrusion."
  }

  notes.push(quality)
  notes.push(extrusion)

  return {
    regularizedBoundaryClosed: closed && afterCount >= 3,
    regularizedVertexCountBefore: beforeCount,
    regularizedVertexCountAfter: afterCount,
    regularizedPerimeterPt: perim,
    supportScoreSummary: {
      meanEdgeSupport: meanEdgeSupport,
      meanNearestShellDistPt: meanNearestShellD,
      syntheticEdgeCount,
      ambiguousEdgeCount,
    },
    ambiguousRegionCount,
    remainingWeakZones: weakRemaining.slice(0, 20),
    regularizationQualityStatement: quality,
    extrusionReadinessStatement: extrusion,
    regularizedPolygonPt: ring.map((p) => ({ ...p })),
    removedOrSimplifiedVertices: removedOrSimplified.slice(0, 500),
    microFeatureSegments,
    edgeAnnotations: edgeAnnotations.slice(0, 200),
    notes,
  }
}

export interface BuildPlanBodyShellRegularizationSvgOptions {
  pageBounds: PlanBoundingBox
  primaryLayoutBBox: PlanBoundingBox
  shellCandidateCleanedIndices: readonly number[]
  fullCleanedSegments: ExtractedLineSegment[]
  boundaryRecoveryV3: PlanBodyBoundaryRecoveryV3Debug
  regularization: PlanBodyShellRegularizationDebug
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;")
}

export function buildPlanBodyShellRegularizationSvgString(o: BuildPlanBodyShellRegularizationSvgOptions): string {
  const pb = o.pageBounds
  const w = pb.maxX - pb.minX
  const h = pb.maxY - pb.minY
  const bx = o.primaryLayoutBBox
  const shellSet = new Set(o.shellCandidateCleanedIndices)

  const shellEdges = o.fullCleanedSegments
    .map((s, i) => {
      if (!shellSet.has(i)) return ""
      return `<line x1="${s.x1}" y1="${s.y1}" x2="${s.x2}" y2="${s.y2}" stroke="rgba(100,100,115,0.28)" stroke-width="0.65" stroke-linecap="round"/>`
    })
    .join("\n")

  let candidatePath = ""
  const bc = o.boundaryRecoveryV3.bestBoundaryCandidate
  if (bc && bc.boundaryPolylinePt.length >= 2) {
    const pts = bc.boundaryPolylinePt
    const d = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" ")
    const close = bc.closed ? " Z" : ""
    candidatePath = `<path d="${escapeXml(d + close)}" fill="none" stroke="rgba(120,150,190,0.35)" stroke-width="1.2" stroke-dasharray="5 4"/>`
  }

  const reg = o.regularization
  let regPath = ""
  if (reg.regularizedPolygonPt.length >= 2) {
    const pts = reg.regularizedPolygonPt
    const d = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" ")
    const close = reg.regularizedBoundaryClosed ? " Z" : ""
    regPath = `<path d="${escapeXml(d + close)}" fill="rgba(0,110,70,0.07)" stroke="rgba(0,95,60,0.98)" stroke-width="2.8" stroke-linejoin="round"/>`
  }

  const micro = reg.microFeatureSegments
    .slice(0, 600)
    .map(
      (s) =>
        `<line x1="${s.x1}" y1="${s.y1}" x2="${s.x2}" y2="${s.y2}" stroke="rgba(220,60,60,0.55)" stroke-width="0.9" stroke-linecap="round"/>`
    )
    .join("\n")

  const gapAnnot = o.boundaryRecoveryV3.remainingGapZones
    .map(
      (z) =>
        `<rect x="${z.band.minX}" y="${z.band.minY}" width="${z.band.maxX - z.band.minX}" height="${z.band.maxY - z.band.minY}" fill="rgba(255,100,0,0.05)" stroke="rgba(200,80,0,0.5)" stroke-width="0.9" stroke-dasharray="4 3"/>`
    )
    .join("\n")

  const syntheticEdges = reg.edgeAnnotations
    .filter((e) => e.syntheticLowConfidence)
    .map(
      (e) =>
        `<line x1="${e.x1}" y1="${e.y1}" x2="${e.x2}" y2="${e.y2}" stroke="rgba(160,60,200,0.85)" stroke-width="1.6" stroke-dasharray="2 3"/>`
    )
    .join("\n")

  const ambiguousEdges = reg.edgeAnnotations
    .filter((e) => e.ambiguousFromGapZone && !e.syntheticLowConfidence)
    .map(
      (e) =>
        `<line x1="${e.x1}" y1="${e.y1}" x2="${e.x2}" y2="${e.y2}" stroke="rgba(230,150,30,0.75)" stroke-width="1.3"/>`
    )
    .join("\n")

  const title = `Shell regularization (debug) — ${reg.regularizedVertexCountBefore}→${reg.regularizedVertexCountAfter} verts, closed=${reg.regularizedBoundaryClosed}`

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${pb.minX} ${pb.minY} ${w} ${h}" width="${Math.round(w)}" height="${Math.round(
    h
  )}">
<rect x="${pb.minX}" y="${pb.minY}" width="${w}" height="${h}" fill="white"/>
<text x="${pb.minX + 8}" y="${pb.minY + 14}" font-size="11" fill="#222" font-family="system-ui,sans-serif">${escapeXml(title)}</text>
<text x="${pb.minX + 8}" y="${pb.minY + 28}" font-size="8.5" fill="#444" font-family="system-ui,sans-serif">${escapeXml(
    reg.regularizationQualityStatement.slice(0, 210) + (reg.regularizationQualityStatement.length > 210 ? "…" : "")
  )}</text>
<text x="${pb.minX + 8}" y="${pb.minY + 42}" font-size="8.5" fill="#622" font-family="system-ui,sans-serif">${escapeXml(
    reg.extrusionReadinessStatement.slice(0, 210) + (reg.extrusionReadinessStatement.length > 210 ? "…" : "")
  )}</text>
<text x="${pb.minX + 8}" y="${pb.minY + 56}" font-size="7.5" fill="#555" font-family="system-ui,sans-serif">Legend: faint blue=v3 candidate; green=regularized; red ticks=removed/simplified; orange fill=R/B gap zones; purple dash=synthetic edges; orange stroke=ambiguous overlap.</text>
<g>${shellEdges}</g>
<g>${gapAnnot}</g>
<g>${candidatePath}</g>
<g>${micro}</g>
<g>${ambiguousEdges}</g>
<g>${syntheticEdges}</g>
<g>${regPath}</g>
<rect x="${bx.minX}" y="${bx.minY}" width="${bx.maxX - bx.minX}" height="${bx.maxY - bx.minY}" fill="none" stroke="rgba(0,80,40,0.55)" stroke-width="1.4" stroke-dasharray="7 5"/>
</svg>`
}
