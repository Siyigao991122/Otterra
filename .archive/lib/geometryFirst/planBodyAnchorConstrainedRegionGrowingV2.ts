/**
 * Debug-only **anchor-to-wall constrained region growing v2**: multi-source Dijkstra on a unit grid
 * with barrier-weighted edges and opening-aware soft barriers — replaces distance-only shaping for analysis.
 */

import { collectBarrierCandidates } from "@/lib/geometryFirst/planBodyRoomCandidatesCleanupV1"
import type { RoomBarrierDebugV1 } from "@/lib/geometryFirst/planBodyRoomCandidatesCleanupV1"
import type { CleanedRoomProposalV1, ProposalTopologyCleanupV1Debug } from "@/lib/geometryFirst/planBodyProposalTopologyCleanupV1"
import type { MajorRoomAnchorV1 } from "@/lib/geometryFirst/planBodySemanticGuidedRoomPartitionV1"
import type { RoomTextGroupingV1Debug } from "@/lib/geometryFirst/planBodyRoomTextGroupingV1"
import type { AnchorSeedLocalizationV1Debug } from "@/lib/geometryFirst/planBodyAnchorSeedLocalizationV1"
import { localizedSeedPointByAnchorId } from "@/lib/geometryFirst/planBodyAnchorSeedLocalizationV1"
import type { ArchitecturalWallHypothesesDebugPayload } from "@/lib/geometryFirst/architecturalWallHypotheses"
import type { GlobalStructuralSpansDebugPayload } from "@/lib/geometryFirst/globalStructuralSpans"
import type { ExtractedLineSegment, PlanBoundingBox } from "@/lib/geometryFirst/types"

type Pt = { x: number; y: number }

const G2 = {
  gridDiv: 430,
  barrierStrengthFloor: 0.3,
  hardStrength: 0.55,
  hardLen: 24,
  baseMove: 1,
  penCap: 125,
  hardPen: 108,
  softPenScale: 62,
  openingStrengthHi: 0.5,
  openingLenHi: 22,
  maxRelax: 0.78,
  layoutSegMin: 14,
  maxRegionFrac: 0.46,
  conflictCostDelta: 5,
  ambiguousIou: 0.24,
  ambiguousMinAreaFrac: 0.018,
  secondPassStrongCrossWeight: 38,
} as const

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

function centroidPoly(poly: Pt[]): Pt {
  let sx = 0
  let sy = 0
  for (const p of poly) {
    sx += p.x
    sy += p.y
  }
  const n = Math.max(1, poly.length)
  return { x: sx / n, y: sy / n }
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

function orient(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (by - ay) * (cx - bx) - (bx - ax) * (cy - by)
}

function segmentsCrossInterior(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number
): boolean {
  const o1 = orient(ax, ay, bx, by, cx, cy)
  const o2 = orient(ax, ay, bx, by, dx, dy)
  const o3 = orient(cx, cy, dx, dy, ax, ay)
  const o4 = orient(cx, cy, dx, dy, bx, by)
  const eps = 1e-9
  if (o1 * o2 < -eps && o3 * o4 < -eps) return true
  return false
}

function segLen(s: ExtractedLineSegment): number {
  return Math.hypot(s.x2 - s.x1, s.y2 - s.y1)
}

interface GridSpec {
  minX: number
  minY: number
  cell: number
  gw: number
  gh: number
}

function makeGrid(bbox: PlanBoundingBox, pad: number): GridSpec {
  const minX = bbox.minX - pad
  const minY = bbox.minY - pad
  const w = bbox.maxX - bbox.minX + 2 * pad
  const h = bbox.maxY - bbox.minY + 2 * pad
  const cell = Math.max(1.05, Math.max(w, h) / G2.gridDiv)
  const gw = Math.max(10, Math.ceil(w / cell))
  const gh = Math.max(10, Math.ceil(h / cell))
  return { minX, minY, cell, gw, gh }
}

function cellIdx(i: number, j: number, gw: number): number {
  return j * gw + i
}

function cellCenterWorld(i: number, j: number, g: GridSpec): Pt {
  return { x: g.minX + (i + 0.5) * g.cell, y: g.minY + (j + 0.5) * g.cell }
}

function snapToCell(ax: number, ay: number, g: GridSpec): { i: number; j: number } {
  const i = clamp(Math.floor((ax - g.minX) / g.cell), 0, g.gw - 1)
  const j = clamp(Math.floor((ay - g.minY) / g.cell), 0, g.gh - 1)
  return { i, j }
}

type ClassifiedBarrier = RoomBarrierDebugV1 & { len: number }

function collectClassifiedBarriers(
  unitPolygon: Pt[],
  primaryLayoutSegments: ExtractedLineSegment[],
  primaryLayoutCleanedIndices: readonly number[],
  hyps: ArchitecturalWallHypothesesDebugPayload,
  spans: GlobalStructuralSpansDebugPayload,
  anchorPts: Pt[]
): ClassifiedBarrier[] {
  const raw = collectBarrierCandidates(
    unitPolygon,
    unitPolygon,
    primaryLayoutSegments,
    primaryLayoutCleanedIndices,
    hyps,
    spans,
    anchorPts
  )
  const out: ClassifiedBarrier[] = []
  for (const b of raw) {
    if (b.strength < G2.barrierStrengthFloor) continue
    const len = Math.hypot(b.x2 - b.x1, b.y2 - b.y1)
    out.push({ ...b, len })
  }
  for (let li = 0; li < primaryLayoutSegments.length; li++) {
    if (primaryLayoutCleanedIndices[li] == null) continue
    const s = primaryLayoutSegments[li]!
    const L = segLen(s)
    if (L < G2.layoutSegMin) continue
    const mx = (s.x1 + s.x2) / 2
    const my = (s.y1 + s.y2) / 2
    if (pointInPolygon(mx, my, unitPolygon)) {
      out.push({ x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2, strength: 0.48, kind: "plan", len: L })
    }
  }
  return out
}

function openingRelaxationFactor(b: ClassifiedBarrier): number {
  let r = 0
  if (b.strength <= G2.openingStrengthHi) r += 0.42
  if (b.len <= G2.openingLenHi) r += 0.28
  if (b.kind === "hypothesis" && b.strength < 0.52) r += 0.12
  if (b.kind === "thinStroke") r += 0.18
  return clamp(r, 0, G2.maxRelax)
}

function isHardBarrier(b: ClassifiedBarrier): boolean {
  return b.strength >= G2.hardStrength && b.len >= G2.hardLen
}

function edgeCostAcrossBarriers(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  barriers: ClassifiedBarrier[],
  stats: { relaxedCrossings: number; rawCrossings: number; relaxSum: number; relaxCount: number }
): number {
  let pen = 0
  for (const b of barriers) {
    if (!segmentsCrossInterior(ax, ay, bx, by, b.x1, b.y1, b.x2, b.y2)) continue
    stats.rawCrossings++
    const relax = openingRelaxationFactor(b)
    const hard = isHardBarrier(b)
    let add = hard ? G2.hardPen : G2.softPenScale * b.strength
    const before = add
    add *= 1 - relax * G2.maxRelax
    if (before >1e-6 && add < before * 0.55) stats.relaxedCrossings++
    stats.relaxSum += relax
    stats.relaxCount++
    pen += add
  }
  return Math.min(pen, G2.penCap)
}

function strongCrossings(ax: number, ay: number, bx: number, by: number, barriers: ClassifiedBarrier[]): number {
  let c = 0
  for (const b of barriers) {
    if (!isHardBarrier(b)) continue
    if (segmentsCrossInterior(ax, ay, bx, by, b.x1, b.y1, b.x2, b.y2)) c++
  }
  return c
}

function approxIoU(a: Pt[], b: Pt[], samples: number): number {
  const bbA = bboxOfPoly(a)
  const bbB = bboxOfPoly(b)
  const minX = Math.min(bbA.minX, bbB.minX)
  const minY = Math.min(bbA.minY, bbB.minY)
  const maxX = Math.max(bbA.maxX, bbB.maxX)
  const maxY = Math.max(bbA.maxY, bbB.maxY)
  let both = 0
  let ua = 0
  let ub = 0
  for (let s = 0; s < samples; s++) {
    const t1 = ((s * 7919) % samples) / samples
    const t2 = ((s * 6151) % samples) / samples
    const x = minX + t1 * (maxX - minX)
    const y = minY + t2 * (maxY - minY)
    const inA = pointInPolygon(x, y, a)
    const inB = pointInPolygon(x, y, b)
    if (inA && inB) both++
    if (inA) ua++
    if (inB) ub++
  }
  const u = ua + ub - both
  return u > 0 ? both / u : 0
}

function anchorForCleaned(
  c: CleanedRoomProposalV1,
  anchors: MajorRoomAnchorV1[],
  grouping: RoomTextGroupingV1Debug
): Pt {
  const a = anchors.find((x) => x.anchorId === c.anchorId)
  if (a) return { x: a.x, y: a.y }
  const g = grouping.labelGroups.find(
    (l) => l.labelKind === "major_room" && l.normalizedLabel === c.anchorNormalizedLabel
  )
  if (g) return { x: g.centerX, y: g.centerY }
  return centroidPoly(c.polygon)
}

export interface BarrierUseSummaryGrowingV2 {
  totalBarrierCandidates: number
  strongBarrierCount: number
  softBarrierCount: number
  layoutStrokeBarrierCount: number
  hypothesisBarrierCount: number
  spanBarrierCount: number
  neckOrThinCount: number
}

export interface OpeningRelaxationSummaryGrowingV2 {
  openingLikeBarrierCount: number
  relaxedEdgeCrossings: number
  barrierCrossingsSampled: number
  meanEffectiveRelaxation: number
}

export interface GrownRoomProposalV2 extends CleanedRoomProposalV1 {
  /** Same as sourceProposalId; grown from topology-cleaned polygon. */
  grownFromCleanedProposalId: string
}

export interface AnchorConstrainedRegionGrowingV2Debug {
  grownProposalCount: number
  grownRoomProposals: GrownRoomProposalV2[]
  conflictZoneCount: number
  reducedAmbiguityCount: number
  barrierUseSummary: BarrierUseSummaryGrowingV2
  openingRelaxationSummary: OpeningRelaxationSummaryGrowingV2
  growthStatement: string
  notes: string[]
  /** Strong barriers (for SVG). */
  strongBarriersSvg: Array<{ x1: number; y1: number; x2: number; y2: number; strength: number }>
  /** Softer / opening-weighted barriers (dashed SVG). */
  openingSkewBarriersSvg: Array<{ x1: number; y1: number; x2: number; y2: number; strength: number }>
  conflictZoneBboxes: PlanBoundingBox[]
}

type HeapNode = { d: number; k: number; id: number }

function heapPush(heap: HeapNode[], node: HeapNode): void {
  heap.push(node)
  let i = heap.length - 1
  while (i > 0) {
    const p = (i - 1) >> 1
    if (heap[p]!.d < heap[i]!.d || (heap[p]!.d === heap[i]!.d && heap[p]!.k <= heap[i]!.k)) break
    const t = heap[p]!
    heap[p] = heap[i]!
    heap[i] = t
    i = p
  }
}

function heapPop(heap: HeapNode[]): HeapNode | undefined {
  if (heap.length === 0) return undefined
  const out = heap[0]!
  const last = heap.pop()!
  if (heap.length > 0) {
    heap[0] = last
    let i = 0
    for (;;) {
      let m = i
      const l = i * 2 + 1
      const r = l + 1
      if (l < heap.length && (heap[l]!.d < heap[m]!.d || (heap[l]!.d === heap[m]!.d && heap[l]!.k < heap[m]!.k))) m = l
      if (r < heap.length && (heap[r]!.d < heap[m]!.d || (heap[r]!.d === heap[m]!.d && heap[r]!.k < heap[m]!.k))) m = r
      if (m === i) break
      const t = heap[m]!
      heap[m] = heap[i]!
      heap[i] = t
      i = m
    }
  }
  return out
}

export function buildPlanBodyAnchorConstrainedRegionGrowingV2(
  topologyCleanup: ProposalTopologyCleanupV1Debug,
  majorAnchors: MajorRoomAnchorV1[],
  grouping: RoomTextGroupingV1Debug,
  primaryLayoutSegments: ExtractedLineSegment[],
  primaryLayoutCleanedIndices: readonly number[],
  hyps: ArchitecturalWallHypothesesDebugPayload,
  spans: GlobalStructuralSpansDebugPayload,
  unitPolygon: Pt[],
  unitBoundaryClosed: boolean,
  unitArea: number,
  seedLocalization?: AnchorSeedLocalizationV1Debug
): AnchorConstrainedRegionGrowingV2Debug {
  const notes: string[] = []
  const empty = (): AnchorConstrainedRegionGrowingV2Debug => ({
    grownProposalCount: 0,
    grownRoomProposals: [],
    conflictZoneCount: 0,
    reducedAmbiguityCount: 0,
    barrierUseSummary: {
      totalBarrierCandidates: 0,
      strongBarrierCount: 0,
      softBarrierCount: 0,
      layoutStrokeBarrierCount: 0,
      hypothesisBarrierCount: 0,
      spanBarrierCount: 0,
      neckOrThinCount: 0,
    },
    openingRelaxationSummary: {
      openingLikeBarrierCount: 0,
      relaxedEdgeCrossings: 0,
      barrierCrossingsSampled: 0,
      meanEffectiveRelaxation: 0,
    },
    growthStatement: "Anchor constrained region growing v2 skipped.",
    notes,
    strongBarriersSvg: [],
    openingSkewBarriersSvg: [],
    conflictZoneBboxes: [],
  })

  if (!unitBoundaryClosed || unitPolygon.length < 3) {
    notes.push("Region growing v2 skipped — unit not closed.")
    return empty()
  }

  const cleaned = topologyCleanup.cleanedRoomProposals.filter((p) => p.polygon.length >= 3)
  if (cleaned.length === 0) {
    notes.push("Region growing v2: no cleaned proposals.")
    return empty()
  }

  const seedByAnchor = localizedSeedPointByAnchorId(seedLocalization)
  const anchorPts = majorAnchors.map((a) => {
    const p = seedByAnchor.get(a.anchorId)
    return p ?? { x: a.x, y: a.y }
  })
  const barriers = collectClassifiedBarriers(
    unitPolygon,
    primaryLayoutSegments,
    primaryLayoutCleanedIndices,
    hyps,
    spans,
    anchorPts.length > 0 ? anchorPts : cleaned.map((c) => centroidPoly(c.polygon))
  )

  let strongN = 0
  let softN = 0
  let layoutN = 0
  let hypN = 0
  let spanN = 0
  let neckN = 0
  let openingLike = 0
  for (const b of barriers) {
    if (isHardBarrier(b)) strongN++
    else softN++
    if (b.kind === "plan") layoutN++
    else if (b.kind === "hypothesis") hypN++
    else if (b.kind === "span") spanN++
    else if (b.kind === "neck" || b.kind === "thinStroke") neckN++
    if (openingRelaxationFactor(b) >= 0.35) openingLike++
  }

  const barrierUseSummary: BarrierUseSummaryGrowingV2 = {
    totalBarrierCandidates: barriers.length,
    strongBarrierCount: strongN,
    softBarrierCount: softN,
    layoutStrokeBarrierCount: layoutN,
    hypothesisBarrierCount: hypN,
    spanBarrierCount: spanN,
    neckOrThinCount: neckN,
  }

  const strongBarriersSvg = barriers
    .filter((b) => isHardBarrier(b))
    .map((b) => ({ x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2, strength: b.strength }))
  const openingSkewBarriersSvg = barriers
    .filter((b) => !isHardBarrier(b) && openingRelaxationFactor(b) >= 0.25)
    .map((b) => ({ x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2, strength: b.strength }))

  const ub = bboxOfPoly(unitPolygon)
  const g = makeGrid(ub, 8)
  const N = g.gw * g.gh
  const INF = 1e30
  const dist = new Float64Array(N).fill(INF)
  const owner = new Int32Array(N).fill(-1)

  const proposalAnchors = cleaned.map((c) => {
    const p = seedByAnchor.get(c.anchorId)
    if (p) return p
    return anchorForCleaned(c, majorAnchors, grouping)
  })
  let validSeedCount = 0
  const heap: HeapNode[] = []
  for (let k = 0; k < cleaned.length; k++) {
    const ap = proposalAnchors[k]!
    let { i, j } = snapToCell(ap.x, ap.y, g)
    const c0 = cellCenterWorld(i, j, g)
    if (!pointInPolygon(c0.x, c0.y, unitPolygon)) {
      let found = false
      for (let r = 1; r < 9 && !found; r++) {
        for (let dj = -r; dj <= r && !found; dj++) {
          for (let di = -r; di <= r && !found; di++) {
            const ii = clamp(i + di, 0, g.gw - 1)
            const jj = clamp(j + dj, 0, g.gh - 1)
            const cc = cellCenterWorld(ii, jj, g)
            if (pointInPolygon(cc.x, cc.y, unitPolygon)) {
              i = ii
              j = jj
              found = true
            }
          }
        }
      }
    }
    const sid = cellIdx(i, j, g.gw)
    const cc = cellCenterWorld(i, j, g)
    if (!pointInPolygon(cc.x, cc.y, unitPolygon)) {
      notes.push(`Region growing v2: could not place seed for ${cleaned[k]!.proposalId} inside unit.`)
      continue
    }
    validSeedCount++
    heapPush(heap, { d: 0, k, id: sid })
    if (dist[sid] > 1e-9 || owner[sid] < 0) {
      dist[sid] = 0
      owner[sid] = k
    }
  }

  if (validSeedCount === 0) {
    notes.push("Region growing v2: no valid seeds.")
    return empty()
  }

  const edgeStats = { relaxedCrossings: 0, rawCrossings: 0, relaxSum: 0, relaxCount: 0 }

  const neigh: Array<[number, number]> = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ]

  while (heap.length > 0) {
    const cur = heapPop(heap)
    if (!cur) break
    const { d: d0, k: ok, id: id0 } = cur
    if (d0 > dist[id0] + 1e-9) continue
    const i0 = id0 % g.gw
    const j0 = (id0 / g.gw) | 0
    const ax = g.minX + (i0 + 0.5) * g.cell
    const ay = g.minY + (j0 + 0.5) * g.cell
    for (const [di, dj] of neigh) {
      const i1 = i0 + di
      const j1 = j0 + dj
      if (i1 < 0 || j1 < 0 || i1 >= g.gw || j1 >= g.gh) continue
      const id1 = cellIdx(i1, j1, g.gw)
      const bx = g.minX + (i1 + 0.5) * g.cell
      const by = g.minY + (j1 + 0.5) * g.cell
      if (!pointInPolygon(bx, by, unitPolygon)) continue

      const step = G2.baseMove + edgeCostAcrossBarriers(ax, ay, bx, by, barriers, edgeStats)
      const nd = d0 + step
      const better = nd < dist[id1] - 1e-9 || (Math.abs(nd - dist[id1]) <= 1e-9 && ok < owner[id1])
      if (better) {
        dist[id1] = nd
        owner[id1] = ok
        heapPush(heap, { d: nd, k: ok, id: id1 })
      }
    }
  }

  const ua = Math.max(unitArea, 1)
  const unitCellIds: number[] = []
  for (let j = 0; j < g.gh; j++) {
    for (let i = 0; i < g.gw; i++) {
      const id = cellIdx(i, j, g.gw)
      const c = cellCenterWorld(i, j, g)
      if (!pointInPolygon(c.x, c.y, unitPolygon)) continue
      unitCellIds.push(id)
    }
  }
  const totalUnit = unitCellIds.length
  const maxCells = Math.max(12, Math.floor(G2.maxRegionFrac * totalUnit))
  const counts = new Int32Array(cleaned.length).fill(0)
  for (const id of unitCellIds) {
    const o = owner[id]
    if (o >= 0) counts[o]++
  }

  for (let k = 0; k < cleaned.length; k++) {
    if (counts[k]! <= maxCells) continue
    const cells: number[] = []
    for (const id of unitCellIds) {
      if (owner[id] === k) cells.push(id)
    }
    const ac = proposalAnchors[k]!
    cells.sort((a, b) => {
      const ia = a % g.gw
      const ja = (a / g.gw) | 0
      const ib = b % g.gw
      const jb = (b / g.gw) | 0
      const ca = cellCenterWorld(ia, ja, g)
      const cb = cellCenterWorld(ib, jb, g)
      return Math.hypot(cb.x - ac.x, cb.y - ac.y) - Math.hypot(ca.x - ac.x, ca.y - ac.y)
    })
    for (const id of cells) {
      if (counts[k]! <= maxCells) break
      const i0 = id % g.gw
      const j0 = (id / g.gw) | 0
      const votes = new Map<number, number>()
      for (const [di, dj] of neigh) {
        const i1 = i0 + di
        const j1 = j0 + dj
        if (i1 < 0 || j1 < 0 || i1 >= g.gw || j1 >= g.gh) continue
        const o = owner[cellIdx(i1, j1, g.gw)]
        if (o >= 0 && o !== k) votes.set(o, (votes.get(o) ?? 0) + 1)
      }
      let bestO = -1
      let bestV = 0
      for (const [o, v] of votes) {
        if (v > bestV) {
          bestV = v
          bestO = o
        }
      }
      if (bestO >= 0 && bestV >= 2) {
        counts[k]--
        counts[bestO]++
        owner[id] = bestO
      }
    }
  }

  const wallConsistentScore = (ax: number, ay: number, cx: number, cy: number): number => {
    const sc = strongCrossings(ax, ay, cx, cy, barriers)
    const dgeo = Math.hypot(cx - ax, cy - ay)
    return dgeo + sc * G2.secondPassStrongCrossWeight
  }

  const conflictCells: Pt[] = []
  for (const id of unitCellIds) {
    if (owner[id]! < 0) continue
    const i0 = id % g.gw
    const j0 = (id / g.gw) | 0
    const c = cellCenterWorld(i0, j0, g)
    let s1 = Infinity
    let s2 = Infinity
    let bestK = -1
    for (let k = 0; k < cleaned.length; k++) {
      const ak = proposalAnchors[k]!
      const s = wallConsistentScore(ak.x, ak.y, c.x, c.y)
      if (s < s1) {
        s2 = s1
        s1 = s
        bestK = k
      } else if (s < s2) s2 = s
    }
    if (bestK >= 0 && bestK !== owner[id] && s2 - s1 < G2.conflictCostDelta) {
      owner[id] = bestK
    }
  }

  const conflictIds: number[] = []
  const conflictIdSet = new Set<number>()
  for (const id of unitCellIds) {
    if (owner[id]! < 0) continue
    const i0 = id % g.gw
    const j0 = (id / g.gw) | 0
    const c = cellCenterWorld(i0, j0, g)
    const scores: number[] = []
    for (let k = 0; k < cleaned.length; k++) {
      const ak = proposalAnchors[k]!
      scores.push(wallConsistentScore(ak.x, ak.y, c.x, c.y))
    }
    scores.sort((a, b) => a - b)
    if (scores.length >= 2 && scores[1]! - scores[0]! < G2.conflictCostDelta * 0.9) {
      conflictIds.push(id)
      conflictIdSet.add(id)
      conflictCells.push({ x: c.x, y: c.y })
    }
  }

  const conflictZoneBboxes: PlanBoundingBox[] = []
  const seenConflict = new Uint8Array(N).fill(0)
  const q: number[] = []
  for (const start of conflictIds) {
    if (seenConflict[start]!) continue
    seenConflict[start] = 1
    q.length = 0
    q.push(start)
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity
    while (q.length > 0) {
      const id = q.pop()!
      const i0 = id % g.gw
      const j0 = (id / g.gw) | 0
      const cc = cellCenterWorld(i0, j0, g)
      minX = Math.min(minX, cc.x)
      minY = Math.min(minY, cc.y)
      maxX = Math.max(maxX, cc.x)
      maxY = Math.max(maxY, cc.y)
      for (const [di, dj] of neigh) {
        const i1 = i0 + di
        const j1 = j0 + dj
        if (i1 < 0 || j1 < 0 || i1 >= g.gw || j1 >= g.gh) continue
        const id1 = cellIdx(i1, j1, g.gw)
        if (seenConflict[id1]!) continue
        if (!conflictIdSet.has(id1)) continue
        seenConflict[id1] = 1
        q.push(id1)
      }
    }
    const pad = g.cell * 2.2
    conflictZoneBboxes.push({ minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad })
  }

  const cellsByK: Pt[][] = cleaned.map(() => [])
  for (const id of unitCellIds) {
    const k = owner[id]
    if (k < 0) continue
    const i0 = id % g.gw
    const j0 = (id / g.gw) | 0
    cellsByK[k]!.push(cellCenterWorld(i0, j0, g))
  }

  const grownRoomProposals: GrownRoomProposalV2[] = []
  for (let k = 0; k < cleaned.length; k++) {
    const src = cleaned[k]!
    const pts = cellsByK[k]!
    let poly: Pt[] = []
    if (pts.length >= 3) poly = convexHull(pts)
    else poly = src.polygon.map((p) => ({ x: p.x, y: p.y }))
    if (poly.length < 3) continue
    const area = polygonAbsArea(poly)
    grownRoomProposals.push({
      ...src,
      sourceProposalId: src.sourceProposalId,
      grownFromCleanedProposalId: src.proposalId,
      polygon: poly,
      areaPt2: area,
      bbox: bboxOfPoly(poly),
    })
  }

  const ambiguousBefore = new Set(topologyCleanup.stillAmbiguousProposalIds)
  let reducedAmbiguityCount = 0
  const stillAmbiguousAfter = new Set<string>()
  for (const gr of grownRoomProposals) {
    if (gr.areaPt2 < G2.ambiguousMinAreaFrac * ua) stillAmbiguousAfter.add(gr.proposalId)
  }
  for (const gr of grownRoomProposals) {
    let maxPair = 0
    for (const d of grownRoomProposals) {
      if (d.proposalId === gr.proposalId) continue
      maxPair = Math.max(maxPair, approxIoU(gr.polygon, d.polygon, 120))
    }
    if (maxPair > G2.ambiguousIou) stillAmbiguousAfter.add(gr.proposalId)
  }
  for (const id of ambiguousBefore) {
    if (!stillAmbiguousAfter.has(id)) reducedAmbiguityCount++
  }

  const conflictZoneCount = conflictZoneBboxes.length

  const openingRelaxationSummary: OpeningRelaxationSummaryGrowingV2 = {
    openingLikeBarrierCount: openingLike,
    relaxedEdgeCrossings: edgeStats.relaxedCrossings,
    barrierCrossingsSampled: edgeStats.rawCrossings,
    meanEffectiveRelaxation: edgeStats.relaxCount > 0 ? edgeStats.relaxSum / edgeStats.relaxCount : 0,
  }

  notes.push(
    `Grid ${g.gw}×${g.gh} cell ${g.cell.toFixed(2)}pt; ${barriers.length} barrier(s); multi-source grow + domination cap ${(G2.maxRegionFrac * 100).toFixed(0)}%; conflict margin cells ${conflictCells.length}.`
  )
  notes.push("Growth uses plan walls / hypotheses / spans as weighted edge costs; openings soften weak or short barriers.")

  const growthStatement = `Region growing v2: ${grownRoomProposals.length} grown proposal(s); ${conflictZoneCount} conflict zone bbox(es); ambiguity reduced for ${reducedAmbiguityCount} id(s) vs topology cleanup.`

  return {
    grownProposalCount: grownRoomProposals.length,
    grownRoomProposals,
    conflictZoneCount,
    reducedAmbiguityCount,
    barrierUseSummary,
    openingRelaxationSummary,
    growthStatement,
    notes,
    strongBarriersSvg,
    openingSkewBarriersSvg,
    conflictZoneBboxes,
  }
}

export interface BuildPlanBodyAnchorConstrainedRegionGrowingV2SvgOptions {
  pageBounds: PlanBoundingBox
  primaryLayoutBBox: PlanBoundingBox
  growing: AnchorConstrainedRegionGrowingV2Debug
  /** Faint — prior topology cleanup. */
  cleanedProposals: CleanedRoomProposalV1[]
  majorAnchors: MajorRoomAnchorV1[]
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

export function buildPlanBodyAnchorConstrainedRegionGrowingV2SvgString(o: BuildPlanBodyAnchorConstrainedRegionGrowingV2SvgOptions): string {
  const pb = o.pageBounds
  const w = pb.maxX - pb.minX
  const h = pb.maxY - pb.minY
  const bx = o.primaryLayoutBBox

  const unitPath = pathFromPoly(o.unitPolygon, o.unitBoundaryClosed)
  const unitStroke = `<path d="${escapeXml(unitPath)}" fill="none" stroke="rgba(0,80,40,0.95)" stroke-width="2.2" stroke-dasharray="8 5"/>`

  const faintCleaned = o.cleanedProposals
    .map((r) => {
      const p = pathFromPoly(r.polygon, true)
      return `<path d="${escapeXml(p)}" fill="rgba(100,100,160,0.04)" stroke="rgba(90,90,130,0.35)" stroke-width="0.85" stroke-dasharray="6 5"/>`
    })
    .join("\n")

  const colors = [
    "rgba(20,130,100,0.88)",
    "rgba(40,90,175,0.88)",
    "rgba(180,100,35,0.88)",
    "rgba(120,50,145,0.88)",
    "rgba(25,145,125,0.88)",
    "rgba(165,55,80,0.84)",
  ]
  const grownSvg = o.growing.grownRoomProposals
    .map((r, i) => {
      const p = pathFromPoly(r.polygon, true)
      const stroke = colors[i % colors.length]!
      return `<path d="${escapeXml(p)}" fill="${stroke.replace("0.88", "0.18").replace("0.84", "0.15")}" stroke="${stroke}" stroke-width="2"/>`
    })
    .join("\n")

  const anchorsSvg = o.majorAnchors
    .map((a) => {
      return `<g>
  <circle cx="${a.x.toFixed(2)}" cy="${a.y.toFixed(2)}" r="5" fill="rgba(255,215,50,0.95)" stroke="rgba(110,75,0,0.9)" stroke-width="1.2"/>
  <text x="${(a.x + 7).toFixed(2)}" y="${(a.y - 7).toFixed(2)}" font-size="8" fill="rgba(20,20,20,0.95)" font-family="system-ui,sans-serif" font-weight="700">${escapeXml(
    a.displayLabel.length > 22 ? a.displayLabel.slice(0, 20) + "…" : a.displayLabel
  )}</text>
</g>`
    })
    .join("\n")

  const strongWallSvg = o.growing.strongBarriersSvg
    .map((b) => {
      return `<line x1="${b.x1.toFixed(2)}" y1="${b.y1.toFixed(2)}" x2="${b.x2.toFixed(2)}" y2="${b.y2.toFixed(2)}" stroke="rgba(35,35,45,0.88)" stroke-width="2.4" stroke-linecap="round"/>`
    })
    .join("\n")

  const openingSvg = o.growing.openingSkewBarriersSvg
    .map((b) => {
      return `<line x1="${b.x1.toFixed(2)}" y1="${b.y1.toFixed(2)}" x2="${b.x2.toFixed(2)}" y2="${b.y2.toFixed(2)}" stroke="rgba(90,140,200,0.55)" stroke-width="1.15" stroke-dasharray="4 3" stroke-linecap="round"/>`
    })
    .join("\n")

  const conflictSvg = o.growing.conflictZoneBboxes
    .map((bb) => {
      return `<rect x="${bb.minX.toFixed(2)}" y="${bb.minY.toFixed(2)}" width="${(bb.maxX - bb.minX).toFixed(2)}" height="${(bb.maxY - bb.minY).toFixed(
        2
      )}" fill="rgba(255,80,80,0.07)" stroke="rgba(200,40,40,0.65)" stroke-width="1.3" stroke-dasharray="5 3"/>`
    })
    .join("\n")

  const title = `Anchor-to-wall constrained region growing v2 — ${o.growing.grownProposalCount} grown; ${o.growing.conflictZoneCount} conflict bbox; ambiguity −${o.growing.reducedAmbiguityCount} vs topology cleanup`

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${pb.minX} ${pb.minY} ${w} ${h}" width="${Math.round(w)}" height="${Math.round(
    h
  )}">
<rect x="${pb.minX}" y="${pb.minY}" width="${w}" height="${h}" fill="white"/>
<text x="${pb.minX + 8}" y="${pb.minY + 14}" font-size="11" fill="#222" font-family="system-ui,sans-serif">${escapeXml(title)}</text>
<text x="${pb.minX + 8}" y="${pb.minY + 28}" font-size="7.5" fill="#444" font-family="system-ui,sans-serif">Faint dashed = topology-cleaned proposals; solid = grown; black = strong barriers; blue dash = opening-soft barriers; red = conflict zones; yellow = anchors.</text>
<g>${faintCleaned}</g>
<g>${strongWallSvg}</g>
<g>${openingSvg}</g>
<g>${grownSvg}</g>
<g>${conflictSvg}</g>
<g>${anchorsSvg}</g>
<g>${unitStroke}</g>
<rect x="${bx.minX}" y="${bx.minY}" width="${bx.maxX - bx.minX}" height="${bx.maxY - bx.minY}" fill="none" stroke="rgba(0,60,30,0.32)" stroke-width="1.05" stroke-dasharray="5 4"/>
</svg>`
}
