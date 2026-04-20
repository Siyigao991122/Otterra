/**
 * Debug-only **semantic-guided room partition v1**: major-label–anchored Voronoi-style regions inside the
 * unit, wall-crossing penalties, auxiliary attachments — replaces quadrant inheritance for debug analysis only.
 */

import { collectBarrierCandidates } from "@/lib/geometryFirst/planBodyRoomCandidatesCleanupV1"
import type { PlanBodyRoomCandidateRefinementV1Debug } from "@/lib/geometryFirst/planBodyRoomCandidateRefinementV1"
import type { GroupedPlanTextLabelV1, RoomTextGroupingV1Debug } from "@/lib/geometryFirst/planBodyRoomTextGroupingV1"
import type { ArchitecturalWallHypothesesDebugPayload } from "@/lib/geometryFirst/architecturalWallHypotheses"
import type { GlobalStructuralSpansDebugPayload } from "@/lib/geometryFirst/globalStructuralSpans"
import type { ExtractedLineSegment, PlanBoundingBox } from "@/lib/geometryFirst/types"

type Pt = { x: number; y: number }

const P1 = {
  gridTarget: 400,
  dedupeSameLabelPt: 22,
  wallCrossingPenaltyPt: 95,
  wallMinLen: 26,
  barrierStrengthMin: 0.4,
  iouRetainThreshold: 0.36,
  layoutSegMin: 14,
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

function pointToSegDist(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
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

function rdpOpen(pts: Pt[], eps: number): Pt[] {
  if (pts.length < 3) return pts.slice()
  let dmax = 0
  let id = 0
  const last = pts.length - 1
  for (let i = 1; i < last; i++) {
    const p = pts[i]!
    const a = pts[0]!
    const b = pts[last]!
    const d = pointToSegDist(p.x, p.y, a.x, a.y, b.x, b.y)
    if (d > dmax) {
      dmax = d
      id = i
    }
  }
  if (dmax > eps) {
    const l = rdpOpen(pts.slice(0, id + 1), eps)
    const r = rdpOpen(pts.slice(id), eps)
    return [...l.slice(0, -1), ...r]
  }
  return [pts[0]!, pts[last]!]
}

function simplifyPolygon(pts: Pt[], eps: number, closed: boolean): Pt[] {
  if (pts.length < 4) return pts.slice()
  if (closed) {
    const open = [...pts, pts[0]!]
    const s = rdpOpen(open, eps)
    if (s.length >= 2 && Math.hypot(s[0]!.x - s[s.length - 1]!.x, s[0]!.y - s[s.length - 1]!.y) < eps * 0.5) {
      s.pop()
    }
    return s.length >= 3 ? s : pts.slice()
  }
  return rdpOpen(pts, eps)
}

function orient(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (by - ay) * (cx - bx) - (bx - ax) * (cy - by)
}

/** Proper intersection (excluding shared endpoints as hits) for crossing count. */
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

function snapAnchorInsideUnit(px: number, py: number, unit: Pt[]): Pt {
  if (pointInPolygon(px, py, unit)) return { x: px, y: py }
  const c = centroidPoly(unit)
  for (let t = 0; t <= 1.001; t += 0.04) {
    const x = px + t * (c.x - px)
    const y = py + t * (c.y - py)
    if (pointInPolygon(x, y, unit)) return { x, y }
  }
  return { x: c.x, y: c.y }
}

export interface MajorRoomAnchorV1 {
  anchorId: string
  groupIds: string[]
  normalizedLabel: string
  displayLabel: string
  x: number
  y: number
}

export interface SemanticRoomProposalV1 {
  proposalId: string
  anchorId: string
  anchorNormalizedLabel: string
  displayLabel: string
  polygon: Pt[]
  areaPt2: number
  bbox: PlanBoundingBox
  /** Old refined region ids with IoU above a loose threshold (overlap hint). */
  overlappingRefinedRegionIds: string[]
}

export interface AuxiliarySubspaceAttachmentV1 {
  groupId: string
  joinedLabel: string
  normalizedLabel: string
  centerX: number
  centerY: number
  attachedProposalId: string | null
  distanceToAttachedAnchorPt: number
}

export interface SemanticGuidedRoomPartitionV1Debug {
  roomProposalCount: number
  majorAnchorCount: number
  roomProposals: SemanticRoomProposalV1[]
  auxiliarySubspaces: AuxiliarySubspaceAttachmentV1[]
  replacedQuadrantRegionCount: number
  retainedQuadrantRegionCount: number
  partitionStatement: string
  notes: string[]
  /** Refined region ids judged consistent with a proposal (IoU). */
  retainedRefinedRegionIds: string[]
  /** Refined region ids not matched — superseded by anchor partition. */
  replacedRefinedRegionIds: string[]
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
  const cell = Math.max(1.05, Math.max(w, h) / P1.gridTarget)
  const gw = Math.max(8, Math.ceil(w / cell))
  const gh = Math.max(8, Math.ceil(h / cell))
  return { minX, minY, cell, gw, gh }
}

function cellIdx(i: number, j: number, gw: number): number {
  return j * gw + i
}

function cellCenterWorld(i: number, j: number, g: GridSpec): Pt {
  return { x: g.minX + (i + 0.5) * g.cell, y: g.minY + (j + 0.5) * g.cell }
}

function buildMajorAnchors(groups: GroupedPlanTextLabelV1[]): MajorRoomAnchorV1[] {
  const majors = groups.filter((g) => g.labelKind === "major_room" && g.normalizedLabel.length > 0)
  const byNorm = new Map<string, GroupedPlanTextLabelV1[]>()
  for (const g of majors) {
    const list = byNorm.get(g.normalizedLabel)
    if (list) list.push(g)
    else byNorm.set(g.normalizedLabel, [g])
  }

  const anchors: MajorRoomAnchorV1[] = []
  let aid = 0
  for (const [norm, list] of byNorm) {
    const used = new Set<number>()
    for (let i = 0; i < list.length; i++) {
      if (used.has(i)) continue
      const cluster: GroupedPlanTextLabelV1[] = [list[i]!]
      used.add(i)
      for (let j = i + 1; j < list.length; j++) {
        if (used.has(j)) continue
        const d = Math.hypot(list[i]!.centerX - list[j]!.centerX, list[i]!.centerY - list[j]!.centerY)
        if (d <= P1.dedupeSameLabelPt) {
          cluster.push(list[j]!)
          used.add(j)
        }
      }
      let sx = 0
      let sy = 0
      const gids: string[] = []
      let disp = cluster[0]!.joinedLabel
      for (const c of cluster) {
        sx += c.centerX
        sy += c.centerY
        gids.push(c.groupId)
        if (c.joinedLabel.length > disp.length) disp = c.joinedLabel
      }
      const n = cluster.length
      anchors.push({
        anchorId: `maj-${aid++}`,
        groupIds: gids,
        normalizedLabel: norm,
        displayLabel: disp,
        x: sx / n,
        y: sy / n,
      })
    }
  }
  return anchors
}

function collectWallSegmentsForCrossing(
  unitPolygon: Pt[],
  primaryLayoutSegments: ExtractedLineSegment[],
  primaryLayoutCleanedIndices: readonly number[],
  hyps: ArchitecturalWallHypothesesDebugPayload,
  spans: GlobalStructuralSpansDebugPayload,
  majorAnchorPts: Pt[]
): Array<{ x1: number; y1: number; x2: number; y2: number; len: number }> {
  const raw = collectBarrierCandidates(
    unitPolygon,
    unitPolygon,
    primaryLayoutSegments,
    primaryLayoutCleanedIndices,
    hyps,
    spans,
    majorAnchorPts
  )
  const out: Array<{ x1: number; y1: number; x2: number; y2: number; len: number }> = []
  for (const b of raw) {
    if (b.strength < P1.barrierStrengthMin) continue
    const len = Math.hypot(b.x2 - b.x1, b.y2 - b.y1)
    if (len < P1.wallMinLen * 0.85) continue
    out.push({ x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2, len })
  }
  for (let li = 0; li < primaryLayoutSegments.length; li++) {
    if (primaryLayoutCleanedIndices[li] == null) continue
    const s = primaryLayoutSegments[li]!
    const L = segLen(s)
    if (L < P1.layoutSegMin) continue
    const mx = (s.x1 + s.x2) / 2
    const my = (s.y1 + s.y2) / 2
    if (pointInPolygon(mx, my, unitPolygon)) {
      out.push({ x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2, len: L })
    }
  }
  return out
}

function wallCrossings(ax: number, ay: number, bx: number, by: number, walls: ReturnType<typeof collectWallSegmentsForCrossing>): number {
  let c = 0
  for (const w of walls) {
    if (w.len < P1.wallMinLen) continue
    if (segmentsCrossInterior(ax, ay, bx, by, w.x1, w.y1, w.x2, w.y2)) c++
  }
  return c
}

function voronoiCellsToHulls(
  ownerGrid: Int32Array,
  anchorCount: number,
  gw: number,
  gh: number,
  g: GridSpec,
  unitPolygon: Pt[]
): Pt[][] {
  const polys: Pt[][] = []
  for (let k = 0; k < anchorCount; k++) {
    const pts: Pt[] = []
    for (let j = 0; j < gh; j++) {
      for (let i = 0; i < gw; i++) {
        if (ownerGrid[cellIdx(i, j, gw)] !== k) continue
        const c = cellCenterWorld(i, j, g)
        if (pointInPolygon(c.x, c.y, unitPolygon)) pts.push(c)
      }
    }
    if (pts.length < 3) {
      polys.push([])
      continue
    }
    const h = convexHull(pts)
    const simp = simplifyPolygon(h, g.cell * 1.08, true)
    polys.push(simp.length >= 3 ? simp : h)
  }
  return polys
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

export function buildPlanBodySemanticGuidedRoomPartitionV1(
  refinement: PlanBodyRoomCandidateRefinementV1Debug,
  grouping: RoomTextGroupingV1Debug,
  primaryLayoutSegments: ExtractedLineSegment[],
  primaryLayoutCleanedIndices: readonly number[],
  hyps: ArchitecturalWallHypothesesDebugPayload,
  spans: GlobalStructuralSpansDebugPayload,
  unitPolygon: Pt[],
  unitBoundaryClosed: boolean,
  unitArea: number
): SemanticGuidedRoomPartitionV1Debug {
  const notes: string[] = []
  const refined = refinement.refinedRoomCandidates
  const empty = (): SemanticGuidedRoomPartitionV1Debug => ({
    roomProposalCount: 0,
    majorAnchorCount: 0,
    roomProposals: [],
    auxiliarySubspaces: [],
    replacedQuadrantRegionCount: refined.length,
    retainedQuadrantRegionCount: 0,
    partitionStatement: "Semantic-guided partition v1 skipped or empty.",
    notes,
    retainedRefinedRegionIds: [],
    replacedRefinedRegionIds: refined.map((r) => r.id),
  })

  if (!unitBoundaryClosed || unitPolygon.length < 3) {
    notes.push("Semantic partition v1 skipped — unit boundary not closed.")
    return empty()
  }

  const anchors = buildMajorAnchors(grouping.labelGroups)
  const majorAnchorPts = anchors.map((a) => ({ x: a.x, y: a.y }))

  if (anchors.length === 0) {
    notes.push("No major room anchors from grouping v1 — cannot build anchor-guided partition.")
    const proposals: SemanticRoomProposalV1[] = refined.map((r, i) => ({
      proposalId: `fallback-${r.id}`,
      anchorId: "none",
      anchorNormalizedLabel: "",
      displayLabel: `(fallback ${i + 1})`,
      polygon: r.polygon.map((p) => ({ x: p.x, y: p.y })),
      areaPt2: r.areaPt2,
      bbox: r.bbox,
      overlappingRefinedRegionIds: [r.id],
    }))
    notes.push(`Emitted ${proposals.length} fallback proposal(s) from refined regions only.`)
    return {
      roomProposalCount: proposals.length,
      majorAnchorCount: 0,
      roomProposals: proposals,
      auxiliarySubspaces: attachAuxiliaries(grouping, proposals),
      replacedQuadrantRegionCount: 0,
      retainedQuadrantRegionCount: refined.length,
      partitionStatement: "Fallback: refined regions only (no major anchors).",
      notes,
      retainedRefinedRegionIds: refined.map((r) => r.id),
      replacedRefinedRegionIds: [],
    }
  }

  const snappedSites = anchors.map((a) => snapAnchorInsideUnit(a.x, a.y, unitPolygon))
  const walls = collectWallSegmentsForCrossing(
    unitPolygon,
    primaryLayoutSegments,
    primaryLayoutCleanedIndices,
    hyps,
    spans,
    majorAnchorPts
  )

  const ub = bboxOfPoly(unitPolygon)
  const g = makeGrid(ub, 6)
  const owner = new Int32Array(g.gw * g.gh).fill(-1)

  for (let j = 0; j < g.gh; j++) {
    for (let i = 0; i < g.gw; i++) {
      const c = cellCenterWorld(i, j, g)
      if (!pointInPolygon(c.x, c.y, unitPolygon)) continue
      let bestK = 0
      let bestD = Infinity
      for (let k = 0; k < snappedSites.length; k++) {
        const s = snappedSites[k]!
        const e = Math.hypot(c.x - s.x, c.y - s.y)
        const cross = wallCrossings(c.x, c.y, s.x, s.y, walls)
        const d = e + cross * P1.wallCrossingPenaltyPt
        if (d < bestD) {
          bestD = d
          bestK = k
        }
      }
      owner[cellIdx(i, j, g.gw)] = bestK
    }
  }

  const hulls = voronoiCellsToHulls(owner, anchors.length, g.gw, g.gh, g, unitPolygon)
  const roomProposals: SemanticRoomProposalV1[] = []
  for (let k = 0; k < anchors.length; k++) {
    const a = anchors[k]!
    let poly = hulls[k] ?? []
    if (poly.length < 3) {
      notes.push(`Thin hull for anchor ${a.anchorId} (${a.normalizedLabel}) — using anchor neighborhood fallback.`)
      const s = snappedSites[k]!
      const r = Math.max(28, Math.sqrt(Math.max(unitArea, 1) / (Math.PI * anchors.length)) * 0.35)
      poly = [
        { x: s.x - r, y: s.y - r },
        { x: s.x + r, y: s.y - r },
        { x: s.x + r, y: s.y + r },
        { x: s.x - r, y: s.y + r },
      ]
    }
    const area = polygonAbsArea(poly)
    const overlappingRefinedRegionIds: string[] = []
    for (const r of refined) {
      const iou = approxIoU(poly, r.polygon, 110)
      if (iou >= 0.12) overlappingRefinedRegionIds.push(r.id)
    }
    roomProposals.push({
      proposalId: `prop-${a.anchorId}`,
      anchorId: a.anchorId,
      anchorNormalizedLabel: a.normalizedLabel,
      displayLabel: a.displayLabel,
      polygon: poly,
      areaPt2: area,
      bbox: bboxOfPoly(poly),
      overlappingRefinedRegionIds,
    })
  }

  const retainedRefinedRegionIds: string[] = []
  const replacedRefinedRegionIds: string[] = []
  for (const r of refined) {
    let best = 0
    for (const p of roomProposals) {
      best = Math.max(best, approxIoU(r.polygon, p.polygon, 110))
    }
    if (best >= P1.iouRetainThreshold) retainedRefinedRegionIds.push(r.id)
    else replacedRefinedRegionIds.push(r.id)
  }

  const auxiliarySubspaces = attachAuxiliaries(grouping, roomProposals)

  const partitionStatement = `Semantic-guided partition v1: ${anchors.length} major anchor(s) → ${roomProposals.length} proposal(s); retained ${retainedRefinedRegionIds.length}/${refined.length} coarse region(s); ${walls.length} wall segment(s) for crossing penalty.`

  notes.push(
    `Grid ${g.gw}×${g.gh}, cell ${g.cell.toFixed(2)}pt; wall-crossing penalty ${P1.wallCrossingPenaltyPt}pt per crossing. Auxiliary labels attach to nearest proposal centroid, not partition drivers.`
  )
  notes.push("Proposals are geometric heuristics — not final room semantics or extrusion.")

  return {
    roomProposalCount: roomProposals.length,
    majorAnchorCount: anchors.length,
    roomProposals,
    auxiliarySubspaces,
    replacedQuadrantRegionCount: replacedRefinedRegionIds.length,
    retainedQuadrantRegionCount: retainedRefinedRegionIds.length,
    partitionStatement,
    notes,
    retainedRefinedRegionIds,
    replacedRefinedRegionIds,
  }
}

function attachAuxiliaries(
  grouping: RoomTextGroupingV1Debug,
  proposals: SemanticRoomProposalV1[]
): AuxiliarySubspaceAttachmentV1[] {
  const auxGroups = grouping.labelGroups.filter((g) => g.labelKind === "auxiliary_space")
  const out: AuxiliarySubspaceAttachmentV1[] = []
  if (proposals.length === 0) {
    return auxGroups.map((g) => ({
      groupId: g.groupId,
      joinedLabel: g.joinedLabel,
      normalizedLabel: g.normalizedLabel,
      centerX: g.centerX,
      centerY: g.centerY,
      attachedProposalId: null,
      distanceToAttachedAnchorPt: 0,
    }))
  }
  for (const g of auxGroups) {
    let bestId: string | null = null
    let bestD = Infinity
    for (const p of proposals) {
      const c = centroidPoly(p.polygon)
      const d = Math.hypot(g.centerX - c.x, g.centerY - c.y)
      if (d < bestD) {
        bestD = d
        bestId = p.proposalId
      }
    }
    out.push({
      groupId: g.groupId,
      joinedLabel: g.joinedLabel,
      normalizedLabel: g.normalizedLabel,
      centerX: g.centerX,
      centerY: g.centerY,
      attachedProposalId: bestId,
      distanceToAttachedAnchorPt: bestId ? bestD : 0,
    })
  }
  return out
}

export interface BuildPlanBodySemanticGuidedRoomPartitionV1SvgOptions {
  pageBounds: PlanBoundingBox
  primaryLayoutBBox: PlanBoundingBox
  partition: SemanticGuidedRoomPartitionV1Debug
  refinedRoomCandidates: import("@/lib/geometryFirst/planBodyRoomCandidatesV0").RoomCandidateV0[]
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

export function buildPlanBodySemanticGuidedRoomPartitionV1SvgString(o: BuildPlanBodySemanticGuidedRoomPartitionV1SvgOptions): string {
  const pb = o.pageBounds
  const w = pb.maxX - pb.minX
  const h = pb.maxY - pb.minY
  const bx = o.primaryLayoutBBox
  const replaced = new Set(o.partition.replacedRefinedRegionIds)

  const unitPath = pathFromPoly(o.unitPolygon, o.unitBoundaryClosed)
  const unitStroke = `<path d="${escapeXml(unitPath)}" fill="none" stroke="rgba(0,80,40,0.95)" stroke-width="2.3" stroke-dasharray="8 5"/>`

  const faintOld = o.refinedRoomCandidates
    .map((r) => {
      const p = pathFromPoly(r.polygon, true)
      const isRep = replaced.has(r.id)
      const stroke = isRep ? "rgba(200,40,40,0.45)" : "rgba(100,100,140,0.22)"
      const sw = isRep ? 1.25 : 0.65
      const dash = isRep ? ` stroke-dasharray="5 3"` : ` stroke-dasharray="6 5"`
      return `<path d="${escapeXml(p)}" fill="rgba(160,160,200,0.04)" stroke="${stroke}" stroke-width="${sw}"${dash}/>`
    })
    .join("\n")

  const colors = [
    "rgba(25,120,95,0.82)",
    "rgba(35,85,165,0.82)",
    "rgba(175,95,30,0.82)",
    "rgba(115,45,140,0.82)",
    "rgba(20,140,120,0.82)",
    "rgba(160,50,75,0.78)",
  ]
  const newProps = o.partition.roomProposals
    .map((r, i) => {
      const p = pathFromPoly(r.polygon, true)
      const stroke = colors[i % colors.length]!
      return `<path d="${escapeXml(p)}" fill="${stroke.replace("0.82", "0.16").replace("0.78", "0.14")}" stroke="${stroke}" stroke-width="2.1"/>`
    })
    .join("\n")

  const anchorsSvg = o.majorAnchors
    .map((a) => {
      return `<g>
  <circle cx="${a.x.toFixed(2)}" cy="${a.y.toFixed(2)}" r="5" fill="rgba(255,220,60,0.95)" stroke="rgba(120,80,0,0.9)" stroke-width="1.2"/>
  <text x="${(a.x + 7).toFixed(2)}" y="${(a.y - 7).toFixed(2)}" font-size="8" fill="rgba(20,20,20,0.95)" font-family="system-ui,sans-serif" font-weight="700">${escapeXml(
    a.displayLabel.length > 22 ? a.displayLabel.slice(0, 20) + "…" : a.displayLabel
  )}</text>
</g>`
    })
    .join("\n")

  const auxSvg: string[] = []
  for (const aux of o.partition.auxiliarySubspaces) {
    auxSvg.push(
      `<circle cx="${aux.centerX.toFixed(2)}" cy="${aux.centerY.toFixed(2)}" r="2.8" fill="rgba(120,50,160,0.75)" stroke="rgba(80,30,110,0.85)" stroke-width="0.65"/>`
    )
    if (aux.attachedProposalId) {
      const prop = o.partition.roomProposals.find((p) => p.proposalId === aux.attachedProposalId)
      if (prop) {
        const c = centroidPoly(prop.polygon)
        auxSvg.push(
          `<line x1="${aux.centerX.toFixed(2)}" y1="${aux.centerY.toFixed(2)}" x2="${c.x.toFixed(2)}" y2="${c.y.toFixed(2)}" stroke="rgba(120,50,160,0.35)" stroke-width="0.7"/>`
        )
      }
    }
  }

  const title = `Semantic-guided room partition v1 — ${o.partition.majorAnchorCount} anchor(s), ${o.partition.roomProposalCount} proposal(s); retained ${o.partition.retainedQuadrantRegionCount} / replaced ${o.partition.replacedQuadrantRegionCount} coarse region(s)`

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${pb.minX} ${pb.minY} ${w} ${h}" width="${Math.round(w)}" height="${Math.round(
    h
  )}">
<rect x="${pb.minX}" y="${pb.minY}" width="${w}" height="${h}" fill="white"/>
<text x="${pb.minX + 8}" y="${pb.minY + 14}" font-size="11" fill="#222" font-family="system-ui,sans-serif">${escapeXml(title)}</text>
<text x="${pb.minX + 8}" y="${pb.minY + 28}" font-size="7.5" fill="#444" font-family="system-ui,sans-serif">Faint = old refined (red dash = replaced); bold fills = new proposals; yellow = major anchors; purple = auxiliary + weak link to nearest proposal.</text>
<g>${faintOld}</g>
<g>${newProps}</g>
<g>${anchorsSvg}</g>
<g>${auxSvg.join("\n")}</g>
<g>${unitStroke}</g>
<rect x="${bx.minX}" y="${bx.minY}" width="${bx.maxX - bx.minX}" height="${bx.maxY - bx.minY}" fill="none" stroke="rgba(0,60,30,0.32)" stroke-width="1.05" stroke-dasharray="5 4"/>
</svg>`
}

/** Expose anchors used for SVG (same as internal build). */
export function extractMajorRoomAnchorsForPartitionV1(grouping: RoomTextGroupingV1Debug): MajorRoomAnchorV1[] {
  return buildMajorAnchors(grouping.labelGroups)
}
