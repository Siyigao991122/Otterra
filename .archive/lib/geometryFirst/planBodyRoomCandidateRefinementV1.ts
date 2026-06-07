/**
 * Debug-only **room candidate refinement / adjacency cleanup v1**: adjacency graph, conservative * boundary snapping to wall evidence, optional merge/split sanity, per-room quality tiers (not labels).
 */

import type { ArchitecturalWallHypothesesDebugPayload } from "@/lib/geometryFirst/architecturalWallHypotheses"
import { collectBarrierCandidates } from "@/lib/geometryFirst/planBodyRoomCandidatesCleanupV1"
import type { RoomCandidateV0, RoomCandidateSourceV0 } from "@/lib/geometryFirst/planBodyRoomCandidatesV0"
import type { ExtractedLineSegment, ExtractedTextRun, PlanBoundingBox } from "@/lib/geometryFirst/types"
import type { GlobalStructuralSpansDebugPayload } from "@/lib/geometryFirst/globalStructuralSpans"
import type { PlanBodyRoomSplitRefinementV3Debug } from "@/lib/geometryFirst/planBodyRoomSplitRefinementV3"

type Pt = { x: number; y: number }

const R1 = {
  adjGapTolPt: 14,
  strongGapPt: 3.5,
  minSharedSpanPt: 10,
  snapSearchPt: 13,
  snapMaxMovePt: 5.5,
  snapAlpha: 0.42,
  mergeMaxSharedPt: 22,
  mergeMinGapPt: 0,
  dominantFracForSplit: 0.44,
  splitSegMinLen: 52,
  maxRooms: 5,
} as const

export type RoomCandidateConfidenceTierV1 = "high" | "medium" | "coarse"

export interface RoomAdjacencyEdgeV1 {
  aId: string
  bId: string
  estimatedSharedBoundaryPt: number
  proximityGapPt: number
  strongNeighbor: boolean
}

export interface RoomAdjacencyGraphV1 {
  nodes: string[]
  edges: RoomAdjacencyEdgeV1[]
}

export interface RefinedRoomCandidateQualityV1 {
  candidateId: string
  areaPt2: number
  bbox: PlanBoundingBox
  compactnessBboxOverArea: number
  sliverScore: number
  textAnchorCount: number
  adjacencyCount: number
  confidenceTier: RoomCandidateConfidenceTierV1
}

export interface PlanBodyRoomCandidateRefinementV1Debug {
  roomCandidateCount: number
  adjacencyGraph: RoomAdjacencyGraphV1
  refinedRoomCandidates: RoomCandidateV0[]
  mergeAppliedCount: number
  splitAppliedCount: number
  roomQualitySummary: RefinedRoomCandidateQualityV1[]
  refinementStatement: string
  notes: string[]
  /** Sample of boundary nudges toward wall evidence (debug SVG). */
  snappedEdgeSample: Array<{ x1: number; y1: number; x2: number; y2: number }>
  textAnchorsSvg: Pt[]
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x))
}

function polygonSignedArea(pts: Pt[]): number {
  if (pts.length < 3) return 0
  let a = 0
  const n = pts.length
  for (let i = 0; i < n; i++) {
    const p = pts[i]!
    const q = pts[(i + 1) % n]!
    a += p.x * q.y - q.x * p.y
  }
  return a / 2
}

function polygonAbsArea(pts: Pt[]): number {
  return Math.abs(polygonSignedArea(pts))
}

function bboxOfPoly(pts: Pt[]): PlanBoundingBox {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of pts) {
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x)
    maxY = Math.max(maxY, p.y)
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 1, maxY: 1 }
  return { minX, minY, maxX, maxY }
}

function pointInPolygon(px: number, py: number, poly: Pt[]): boolean {
  let inside = false
  const n = poly.length
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i]!.x
    const yi = poly[i]!.y
    const xj = poly[j]!.x
    const yj = poly[j]!.y
    const intersect = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi + 1e-18) + xi
    if (intersect) inside = !inside
  }
  return inside
}

function pointToSegClosest(px: number, py: number, x1: number, y1: number, x2: number, y2: number): Pt & { t: number } {
  const dx = x2 - x1
  const dy = y2 - y1
  const L2 = dx * dx + dy * dy
  if (L2 < 1e-12) return { x: x1, y: y1, t: 0 }
  let t = ((px - x1) * dx + (py - y1) * dy) / L2
  t = clamp(t, 0, 1)
  return { x: x1 + t * dx, y: y1 + t * dy, t }
}

function segLen(s: ExtractedLineSegment): number {
  return Math.hypot(s.x2 - s.x1, s.y2 - s.y1)
}

function intervalOverlap1D(a0: number, a1: number, b0: number, b1: number): number {
  const lo = Math.max(Math.min(a0, a1), Math.min(b0, b1))
  const hi = Math.min(Math.max(a0, a1), Math.max(b0, b1))
  return Math.max(0, hi - lo)
}

function bboxAdjacency(
  a: PlanBoundingBox,
  b: PlanBoundingBox
): { shared: number; gap: number; strong: boolean } | null {
  const ox = intervalOverlap1D(a.minX, a.maxX, b.minX, b.maxX)
  const oy = intervalOverlap1D(a.minY, a.maxY, b.minY, b.maxY)
  const hGap = Math.max(b.minY - a.maxY, a.minY - b.maxY)
  const vGap = Math.max(b.minX - a.maxX, a.minX - b.maxX)
  if (hGap <= R1.adjGapTolPt && ox >= R1.minSharedSpanPt) {
    return {
      shared: ox,
      gap: Math.max(0, hGap),
      strong: hGap < R1.strongGapPt && ox > 28,
    }
  }
  if (vGap <= R1.adjGapTolPt && oy >= R1.minSharedSpanPt) {
    return {
      shared: oy,
      gap: Math.max(0, vGap),
      strong: vGap < R1.strongGapPt && oy > 28,
    }
  }
  return null
}

function centroid(poly: Pt[]): Pt {
  if (poly.length === 0) return { x: 0, y: 0 }
  let sx = 0
  let sy = 0
  for (const p of poly) {
    sx += p.x
    sy += p.y
  }
  return { x: sx / poly.length, y: sy / poly.length }
}

function convexHull(pts: Pt[]): Pt[] {
  if (pts.length < 3) return pts.slice()
  const sorted = [...pts].sort((a, b) => a.x - b.x || a.y - b.y)
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const lower: Pt[] = []
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop()
    lower.push(p)
  }
  const upper: Pt[] = []
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i]!
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop()
    upper.push(p)
  }
  upper.pop()
  lower.pop()
  return lower.concat(upper)
}

function segmentMidInPoly(s: ExtractedLineSegment, poly: Pt[]): boolean {
  const mx = (s.x1 + s.x2) / 2
  const my = (s.y1 + s.y2) / 2
  return pointInPolygon(mx, my, poly)
}

function wallBetweenCentroids(
  ca: Pt,
  cb: Pt,
  support: ExtractedLineSegment[],
  minLen: number
): boolean {
  const mx = (ca.x + cb.x) / 2
  const my = (ca.y + cb.y) / 2
  for (const s of support) {
    if (segLen(s) < minLen) continue
    const d = pointToSegClosest(mx, my, s.x1, s.y1, s.x2, s.y2)
    if (Math.hypot(d.x - mx, d.y - my) < 14) return true
  }
  return false
}

function buildAdjacencyGraph(candidates: RoomCandidateV0[]): RoomAdjacencyGraphV1 {
  const nodes = candidates.map((c) => c.id)
  const edges: RoomAdjacencyEdgeV1[] = []
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const ai = candidates[i]!
      const aj = candidates[j]!
      const adj = bboxAdjacency(ai.bbox, aj.bbox)
      if (!adj) continue
      edges.push({
        aId: ai.id,
        bId: aj.id,
        estimatedSharedBoundaryPt: adj.shared,
        proximityGapPt: adj.gap,
        strongNeighbor: adj.strong,
      })
    }
  }
  return { nodes, edges }
}

function snapPolygonToWalls(
  poly: Pt[],
  wallSegs: ExtractedLineSegment[],
  roomBbox: PlanBoundingBox
): { poly: Pt[]; moves: Array<{ x1: number; y1: number; x2: number; y2: number }> } {
  const pad = R1.snapSearchPt
  const out: Pt[] = []
  const moves: Array<{ x1: number; y1: number; x2: number; y2: number }> = []
  for (const p of poly) {
    let best = p
    let bestD: number = R1.snapSearchPt
    for (const s of wallSegs) {
      if (segLen(s) < 8) continue
      const q = pointToSegClosest(p.x, p.y, s.x1, s.y1, s.x2, s.y2)
      const d = Math.hypot(q.x - p.x, q.y - p.y)
      if (d < bestD) {
        bestD = d
        best = { x: q.x, y: q.y }
      }
    }
    if (bestD < R1.snapSearchPt && bestD > 0.35) {
      const move = R1.snapAlpha * R1.snapMaxMovePt / Math.max(bestD, 0.01)
      const nx = p.x + (best.x - p.x) * Math.min(move / bestD, R1.snapAlpha)
      const ny = p.y + (best.y - p.y) * Math.min(move / bestD, R1.snapAlpha)
      const np = { x: nx, y: ny }
      if (
        np.x >= roomBbox.minX - pad &&
        np.x <= roomBbox.maxX + pad &&
        np.y >= roomBbox.minY - pad &&
        np.y <= roomBbox.maxY + pad
      ) {
        if (Math.hypot(np.x - p.x, np.y - p.y) > 0.2) {
          moves.push({ x1: p.x, y1: p.y, x2: np.x, y2: np.y })
        }
        out.push(np)
        continue
      }
    }
    out.push(p)
  }
  if (out.length < 3) return { poly: poly.slice(), moves: [] }
  const h = convexHull(out)
  return { poly: h.length >= 3 ? h : out, moves }
}

function mergeTwoCandidates(a: RoomCandidateV0, b: RoomCandidateV0, idx: number): RoomCandidateV0 {
  const pts = [...a.polygon, ...b.polygon]
  const h = convexHull(pts)
  const area = polygonAbsArea(h)
  const conf = clamp(0.36 + 0.08 * (a.confidence + b.confidence), 0.3, 0.62)
  return {
    id: `refined-merge-${idx}`,
    polygon: h,
    confidence: conf,
    source: "refined_v1" as RoomCandidateSourceV0,
    areaPt2: area,
    bbox: bboxOfPoly(h),
  }
}

function lineSplitConvex(poly: Pt[], ax: number, ay: number, bx: number, by: number): [Pt[], Pt[]] | null {
  const nx = -(by - ay)
  const ny = bx - ax
  const nlen = Math.hypot(nx, ny)
  if (nlen < 1e-8) return null
  const nxp = nx / nlen
  const nyp = ny / nlen
  const cx = (ax + bx) / 2
  const cy = (ay + by) / 2

  const side = (p: Pt) => (p.x - cx) * nxp + (p.y - cy) * nyp

  const pos: Pt[] = []
  const neg: Pt[] = []
  const n = poly.length
  for (let i = 0; i < n; i++) {
    const p = poly[i]!
    const q = poly[(i + 1) % n]!
    const sp = side(p)
    const sq = side(q)
    if (sp >= -1e-9) pos.push(p)
    if (sp <= 1e-9) neg.push(p)
    if (sp * sq < -1e-12) {
      const t = sp / (sp - sq)
      const ix = p.x + t * (q.x - p.x)
      const iy = p.y + t * (q.y - p.y)
      const ip = { x: ix, y: iy }
      pos.push(ip)
      neg.push(ip)
    }
  }
  const hp = convexHull(pos)
  const hn = convexHull(neg)
  if (hp.length < 3 || hn.length < 3) return null
  const ap = polygonAbsArea(hp)
  const an = polygonAbsArea(hn)
  const tarea = ap + an
  if (tarea < 1e-6) return null
  if (ap / tarea < 0.14 || an / tarea < 0.14) return null
  return [hp, hn]
}

function filterTextAnchors(texts: ExtractedTextRun[], layoutBx: PlanBoundingBox): Pt[] {
  const out: Pt[] = []
  for (const t of texts) {
    const w = t.width ?? 12
    const h = t.height ?? 10
    if (t.x + w < layoutBx.minX || t.x > layoutBx.maxX || t.y + h < layoutBx.minY || t.y > layoutBx.maxY) continue
    out.push({ x: t.x + w * 0.5, y: t.y + h * 0.5 })
  }
  return out
}

function countAnchorsInPoly(anchors: Pt[], poly: Pt[]): number {
  let c = 0
  for (const a of anchors) {
    if (pointInPolygon(a.x, a.y, poly)) c++
  }
  return c
}

function tierFor(
  compact: number,
  adjN: number,
  textC: number,
  baseConf: number
): RoomCandidateConfidenceTierV1 {
  if (compact < 4.4 && adjN >= 2 && (textC >= 1 || baseConf >= 0.48)) return "high"
  if (compact < 6.6 && adjN >= 1) return "medium"
  return "coarse"
}

function qualityRow(
  c: RoomCandidateV0,
  adjMap: Map<string, number>,
  anchors: Pt[]
): RefinedRoomCandidateQualityV1 {
  const bb = bboxOfPoly(c.polygon)
  const bboxA = Math.max(1, bb.maxX - bb.minX) * Math.max(1, bb.maxY - bb.minY)
  const compact = bboxA / Math.max(1, c.areaPt2)
  const tc = countAnchorsInPoly(anchors, c.polygon)
  const adjN = adjMap.get(c.id) ?? 0
  return {
    candidateId: c.id,
    areaPt2: c.areaPt2,
    bbox: c.bbox,
    compactnessBboxOverArea: compact,
    sliverScore: clamp(compact / 6.5, 0, 1.2),
    textAnchorCount: tc,
    adjacencyCount: adjN,
    confidenceTier: tierFor(compact, adjN, tc, c.confidence),
  }
}

export function buildPlanBodyRoomCandidateRefinementV1(
  primaryLayoutBBox: PlanBoundingBox,
  primaryLayoutSegments: ExtractedLineSegment[],
  primaryLayoutCleanedIndices: readonly number[],
  wallHypothesesPlanOnly: ArchitecturalWallHypothesesDebugPayload,
  globalSpansPlanOnly: GlobalStructuralSpansDebugPayload,
  splitV3: PlanBodyRoomSplitRefinementV3Debug,
  unitPolygon: Pt[],
  unitBoundaryClosed: boolean,
  unitArea: number,
  textRuns?: ExtractedTextRun[]
): PlanBodyRoomCandidateRefinementV1Debug {
  const notes: string[] = []
  const snappedEdgeSample: Array<{ x1: number; y1: number; x2: number; y2: number }> = []
  const textAnchorsSvg = (textRuns ? filterTextAnchors(textRuns, primaryLayoutBBox) : splitV3.textAnchorsSvg.slice()).slice(
    0,
    220
  )

  if (!unitBoundaryClosed || unitPolygon.length < 3) {
    notes.push("Room candidate refinement v1 skipped — unit boundary not closed.")
    return {
      roomCandidateCount: splitV3.roomCandidateCount,
      adjacencyGraph: { nodes: [], edges: [] },
      refinedRoomCandidates: splitV3.roomCandidates.slice(),
      mergeAppliedCount: 0,
      splitAppliedCount: 0,
      roomQualitySummary: [],
      refinementStatement: "Refinement v1 skipped — need closed unit polygon.",
      notes,
      snappedEdgeSample: [],
      textAnchorsSvg,
    }
  }

  let rooms = splitV3.roomCandidates.map((c) => ({
    ...c,
    polygon: c.polygon.map((p) => ({ x: p.x, y: p.y })),
  }))

  if (rooms.length === 0) {
    notes.push("Refinement v1: no room candidates from v3.")
    return {
      roomCandidateCount: 0,
      adjacencyGraph: { nodes: [], edges: [] },
      refinedRoomCandidates: [],
      mergeAppliedCount: 0,
      splitAppliedCount: 0,
      roomQualitySummary: [],
      refinementStatement: "No candidates to refine.",
      notes,
      snappedEdgeSample: [],
      textAnchorsSvg,
    }
  }

  const wallRaw = collectBarrierCandidates(
    unitPolygon,
    unitPolygon,
    primaryLayoutSegments,
    primaryLayoutCleanedIndices,
    wallHypothesesPlanOnly,
    globalSpansPlanOnly,
    textAnchorsSvg
  )
  const wallSegs: ExtractedLineSegment[] = wallRaw.map((w) => ({ x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2 }))
  for (let li = 0; li < primaryLayoutSegments.length; li++) {
    if (primaryLayoutCleanedIndices[li] == null) continue
    const s = primaryLayoutSegments[li]!
    if (segLen(s) < 10) continue
    const mx = (s.x1 + s.x2) / 2
    const my = (s.y1 + s.y2) / 2
    if (pointInPolygon(mx, my, unitPolygon)) wallSegs.push(s)
  }

  let graph = buildAdjacencyGraph(rooms)
  let mergeAppliedCount = 0

  const toRemove = new Set<string>()
  const mergedInto: RoomCandidateV0[] = []

  for (const e of graph.edges) {
    if (e.estimatedSharedBoundaryPt > R1.mergeMaxSharedPt) continue
    if (e.proximityGapPt > R1.mergeMinGapPt + 0.5) continue
    if (e.strongNeighbor) continue
    if (toRemove.has(e.aId) || toRemove.has(e.bId)) continue
    const a = rooms.find((r) => r.id === e.aId)
    const b = rooms.find((r) => r.id === e.bId)
    if (!a || !b) continue
    const ca = centroid(a.polygon)
    const cb = centroid(b.polygon)
    if (wallBetweenCentroids(ca, cb, wallSegs, 22)) continue
    const u = mergeTwoCandidates(a, b, mergeAppliedCount)
    mergedInto.push(u)
    toRemove.add(e.aId)
    toRemove.add(e.bId)
    mergeAppliedCount++
  }

  if (mergeAppliedCount > 0) {
    rooms = [...rooms.filter((r) => !toRemove.has(r.id)), ...mergedInto]
    notes.push(`Refinement v1: merged ${mergeAppliedCount} weak/adjacent pair(s) lacking wall support between centroids.`)
  }

  let splitAppliedCount = 0
  if (rooms.length < R1.maxRooms && unitArea > 1e-6) {
    let bi = -1
    let bestA = 0
    for (let i = 0; i < rooms.length; i++) {
      const ar = rooms[i]!.areaPt2 / unitArea
      if (ar > bestA) {
        bestA = ar
        bi = i
      }
    }
    if (bi >= 0 && bestA > R1.dominantFracForSplit) {
      const R = rooms[bi]!
      let bestSeg: ExtractedLineSegment | null = null
      let bestLen = 0
      for (const s of wallSegs) {
        const L = segLen(s)
        if (L < R1.splitSegMinLen) continue
        if (!segmentMidInPoly(s, R.polygon)) continue
        if (L > bestLen) {
          bestLen = L
          bestSeg = s
        }
      }
      if (bestSeg) {
        const sp = lineSplitConvex(R.polygon, bestSeg.x1, bestSeg.y1, bestSeg.x2, bestSeg.y2)
        if (sp) {
          const [p0, p1] = sp
          const a0 = polygonAbsArea(p0)
          const a1 = polygonAbsArea(p1)
          const r0: RoomCandidateV0 = {
            id: `refined-split-${splitAppliedCount}-a`,
            polygon: p0,
            confidence: clamp(R.confidence * 0.96, 0.28, 0.58),
            source: "refined_v1",
            areaPt2: a0,
            bbox: bboxOfPoly(p0),
          }
          const r1: RoomCandidateV0 = {
            id: `refined-split-${splitAppliedCount}-b`,
            polygon: p1,
            confidence: clamp(R.confidence * 0.96, 0.28, 0.58),
            source: "refined_v1",
            areaPt2: a1,
            bbox: bboxOfPoly(p1),
          }
          rooms = [...rooms.slice(0, bi), ...rooms.slice(bi + 1), r0, r1]
          splitAppliedCount = 1
          notes.push(`Refinement v1: split dominant region ${R.id} using interior wall evidence (${bestLen.toFixed(0)}pt).`)
        }
      }
    }
  }

  const refinedRoomCandidates: RoomCandidateV0[] = []
  let ri = 0
  for (const c of rooms) {
    const bb = c.bbox
    const { poly: snapped, moves } = snapPolygonToWalls(c.polygon, wallSegs, bb)
    snappedEdgeSample.push(...moves.slice(0, 24))
    const area = polygonAbsArea(snapped)
    refinedRoomCandidates.push({
      id: c.id.startsWith("refined-") ? c.id : `refined-${ri}-${c.id}`,
      polygon: snapped,
      confidence: clamp(c.confidence + (moves.length > 0 ? 0.04 : 0), 0.22, 0.65),
      source: "refined_v1",
      areaPt2: area,
      bbox: bboxOfPoly(snapped),
    })
    ri++
  }

  graph = buildAdjacencyGraph(refinedRoomCandidates)
  const adjCount = new Map<string, number>()
  for (const e of graph.edges) {
    adjCount.set(e.aId, (adjCount.get(e.aId) ?? 0) + 1)
    adjCount.set(e.bId, (adjCount.get(e.bId) ?? 0) + 1)
  }

  for (const r of refinedRoomCandidates) {
    const adjIds = graph.edges.filter((e) => e.aId === r.id || e.bId === r.id).map((e) => (e.aId === r.id ? e.bId : e.aId))
    r.adjacentCandidateIds = [...new Set(adjIds)].slice(0, 14)
  }

  const roomQualitySummary = refinedRoomCandidates.map((c) => qualityRow(c, adjCount, textAnchorsSvg))

  const statement = `Room candidate refinement v1: ${refinedRoomCandidates.length} refined region(s); ${graph.edges.length} adjacency edge(s); merges ${mergeAppliedCount}; splits ${splitAppliedCount}. Conservative snaps to wall evidence; no semantic labels.`

  notes.push(
    "Ambiguity: adjacency uses bbox proximity; merges only when wall evidence does not separate centroids. Split requires dominant area fraction and a long interior stroke."
  )

  return {
    roomCandidateCount: refinedRoomCandidates.length,
    adjacencyGraph: graph,
    refinedRoomCandidates,
    mergeAppliedCount,
    splitAppliedCount,
    roomQualitySummary,
    refinementStatement: statement,
    notes,
    snappedEdgeSample: snappedEdgeSample.slice(0, 140),
    textAnchorsSvg,
  }
}

export interface BuildPlanBodyRoomCandidateRefinementV1SvgOptions {
  pageBounds: PlanBoundingBox
  primaryLayoutBBox: PlanBoundingBox
  debug: PlanBodyRoomCandidateRefinementV1Debug
  v3RoomCandidates: RoomCandidateV0[]
  unitPolygon: Pt[]
  unitBoundaryClosed: boolean
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;")
}

function pathFromPoly(pts: Pt[], close: boolean): string {
  if (pts.length < 2) return ""
  let d = `M ${pts[0]!.x.toFixed(2)} ${pts[0]!.y.toFixed(2)}`
  for (let i = 1; i < pts.length; i++) d += ` L ${pts[i]!.x.toFixed(2)} ${pts[i]!.y.toFixed(2)}`
  if (close) d += " Z"
  return d
}

function fillTier(t: RoomCandidateConfidenceTierV1, alpha: number): string {
  if (t === "high") return `rgba(25,130,75,${alpha})`
  if (t === "medium") return `rgba(210,165,45,${alpha})`
  return `rgba(115,85,195,${alpha})`
}

export function buildPlanBodyRoomCandidateRefinementV1SvgString(o: BuildPlanBodyRoomCandidateRefinementV1SvgOptions): string {
  const pb = o.pageBounds
  const w = pb.maxX - pb.minX
  const h = pb.maxY - pb.minY
  const bx = o.primaryLayoutBBox
  const d = o.debug
  const tierById = new Map(d.roomQualitySummary.map((q) => [q.candidateId, q.confidenceTier]))

  const unitPath = pathFromPoly(o.unitPolygon, o.unitBoundaryClosed)
  const unitStroke = `<path d="${escapeXml(unitPath)}" fill="none" stroke="rgba(0,80,40,0.95)" stroke-width="2.6" stroke-dasharray="8 5"/>`

  const v3faint = o.v3RoomCandidates
    .map((r) => {
      const p = pathFromPoly(r.polygon, true)
      return `<path d="${escapeXml(p)}" fill="rgba(140,140,200,0.06)" stroke="rgba(120,120,180,0.28)" stroke-width="0.75" stroke-dasharray="5 4"/>`
    })
    .join("\n")

  const refined = d.refinedRoomCandidates
    .map((r) => {
      const p = pathFromPoly(r.polygon, true)
      const tier = tierById.get(r.id) ?? "coarse"
      const fill = fillTier(tier, 0.18)
      return `<path d="${escapeXml(p)}" fill="${fill}" stroke="rgba(15,95,85,0.9)" stroke-width="1.65"/>`
    })
    .join("\n")

  const centroids = d.refinedRoomCandidates.map((r) => ({ id: r.id, c: centroid(r.polygon) }))
  const cMap = new Map(centroids.map((x) => [x.id, x.c]))
  const adjLines = d.adjacencyGraph.edges
    .map((e) => {
      const ca = cMap.get(e.aId)
      const cb = cMap.get(e.bId)
      if (!ca || !cb) return ""
      const stroke = e.strongNeighbor ? "rgba(200,60,30,0.55)" : "rgba(80,80,120,0.38)"
      const sw = e.strongNeighbor ? 1.35 : 0.85
      return `<line x1="${ca.x.toFixed(2)}" y1="${ca.y.toFixed(2)}" x2="${cb.x.toFixed(2)}" y2="${cb.y.toFixed(2)}" stroke="${stroke}" stroke-width="${sw}"/>`
    })
    .join("\n")

  const snaps = d.snappedEdgeSample
    .map(
      (s) =>
        `<line x1="${s.x1.toFixed(2)}" y1="${s.y1.toFixed(2)}" x2="${s.x2.toFixed(2)}" y2="${s.y2.toFixed(2)}" stroke="rgba(30,160,90,0.65)" stroke-width="0.9"/>`
    )
    .join("\n")

  const anchors = d.textAnchorsSvg
    .slice(0, 180)
    .map(
      (p) =>
        `<circle cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="2" fill="rgba(25,110,190,0.5)" stroke="rgba(15,70,130,0.55)" stroke-width="0.4"/>`
    )
    .join("\n")

  const title = `Room candidate refinement v1 — ${d.roomCandidateCount} regions; merges ${d.mergeAppliedCount}; splits ${d.splitAppliedCount}; edges ${d.adjacencyGraph.edges.length}`

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${pb.minX} ${pb.minY} ${w} ${h}" width="${Math.round(w)}" height="${Math.round(
    h
  )}">
<rect x="${pb.minX}" y="${pb.minY}" width="${w}" height="${h}" fill="white"/>
<text x="${pb.minX + 8}" y="${pb.minY + 14}" font-size="11" fill="#222" font-family="system-ui,sans-serif">${escapeXml(title)}</text>
<text x="${pb.minX + 8}" y="${pb.minY + 28}" font-size="8.5" fill="#444" font-family="system-ui,sans-serif">${escapeXml(
    d.refinementStatement.slice(0, 260) + (d.refinementStatement.length > 260 ? "…" : "")
  )}</text>
<text x="${pb.minX + 8}" y="${pb.minY + 42}" font-size="7.5" fill="#555" font-family="system-ui,sans-serif">Faint = v3; bold fill = refined (green/yellow/purple by tier); gray/red lines = adjacency; green ticks = snap moves; dots = text anchors.</text>
<g>${v3faint}</g>
<g>${adjLines}</g>
<g>${snaps}</g>
<g>${refined}</g>
<g>${anchors}</g>
<g>${unitStroke}</g>
<rect x="${bx.minX}" y="${bx.minY}" width="${bx.maxX - bx.minX}" height="${bx.maxY - bx.minY}" fill="none" stroke="rgba(0,60,30,0.4)" stroke-width="1.2" stroke-dasharray="5 4"/>
</svg>`
}
