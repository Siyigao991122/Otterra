/**
 * Debug-only **proposal-to-wall topology cleanup v1**: grid re-assignment with wall-crossing penalties
 * inside soft semantic proposals, reducing overlap and cross-bleed — does not use coarse quadrants structurally.
 */

import { collectBarrierCandidates } from "@/lib/geometryFirst/planBodyRoomCandidatesCleanupV1"
import type { MajorRoomAnchorV1, SemanticGuidedRoomPartitionV1Debug, SemanticRoomProposalV1 } from "@/lib/geometryFirst/planBodySemanticGuidedRoomPartitionV1"
import type { RoomTextGroupingV1Debug } from "@/lib/geometryFirst/planBodyRoomTextGroupingV1"
import type { ArchitecturalWallHypothesesDebugPayload } from "@/lib/geometryFirst/architecturalWallHypotheses"
import type { GlobalStructuralSpansDebugPayload } from "@/lib/geometryFirst/globalStructuralSpans"
import type { ExtractedLineSegment, PlanBoundingBox } from "@/lib/geometryFirst/types"

type Pt = { x: number; y: number }

const T1 = {
  gridDiv: 320,
  wallPenaltyPt: 86,
  wallMinLen: 28,
  barrierStrengthMin: 0.46,
  layoutSegMin: 16,
  pairIouNoteThreshold: 0.07,
  ambiguousIou: 0.24,
  ambiguousMinAreaFrac: 0.018,
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
  const cell = Math.max(1.05, Math.max(w, h) / T1.gridDiv)
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

function collectStrongWalls(
  unitPolygon: Pt[],
  primaryLayoutSegments: ExtractedLineSegment[],
  primaryLayoutCleanedIndices: readonly number[],
  hyps: ArchitecturalWallHypothesesDebugPayload,
  spans: GlobalStructuralSpansDebugPayload,
  anchorPts: Pt[]
): Array<{ x1: number; y1: number; x2: number; y2: number; len: number; strength: number }> {
  const raw = collectBarrierCandidates(
    unitPolygon,
    unitPolygon,
    primaryLayoutSegments,
    primaryLayoutCleanedIndices,
    hyps,
    spans,
    anchorPts
  )
  const out: Array<{ x1: number; y1: number; x2: number; y2: number; len: number; strength: number }> = []
  for (const b of raw) {
    if (b.strength < T1.barrierStrengthMin) continue
    const len = Math.hypot(b.x2 - b.x1, b.y2 - b.y1)
    if (len < T1.wallMinLen * 0.88) continue
    out.push({ x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2, len, strength: b.strength })
  }
  for (let li = 0; li < primaryLayoutSegments.length; li++) {
    if (primaryLayoutCleanedIndices[li] == null) continue
    const s = primaryLayoutSegments[li]!
    const L = segLen(s)
    if (L < T1.layoutSegMin) continue
    const mx = (s.x1 + s.x2) / 2
    const my = (s.y1 + s.y2) / 2
    if (pointInPolygon(mx, my, unitPolygon)) {
      out.push({ x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2, len: L, strength: 0.5 })
    }
  }
  return out
}

function wallCrossings(ax: number, ay: number, bx: number, by: number, walls: ReturnType<typeof collectStrongWalls>): number {
  let c = 0
  for (const w of walls) {
    if (w.len < T1.wallMinLen) continue
    if (segmentsCrossInterior(ax, ay, bx, by, w.x1, w.y1, w.x2, w.y2)) c++
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

function anchorForProposal(p: SemanticRoomProposalV1, anchors: MajorRoomAnchorV1[], grouping: RoomTextGroupingV1Debug): Pt {
  const a = anchors.find((x) => x.anchorId === p.anchorId)
  if (a) return { x: a.x, y: a.y }
  const g = grouping.labelGroups.find(
    (l) => l.labelKind === "major_room" && l.normalizedLabel === p.anchorNormalizedLabel
  )
  if (g) return { x: g.centerX, y: g.centerY }
  return centroidPoly(p.polygon)
}

export interface OverlapPairReductionV1 {
  proposalIdA: string
  proposalIdB: string
  iouBefore: number
  iouAfter: number
}

export interface WallSnapSummaryV1 {
  strongWallSegmentCount: number
  wallCrossingPenaltyPt: number
  gridCellsAssigned: number
  cellsWithMultiCandidateRaw: number
}

export interface CleanedRoomProposalV1 extends SemanticRoomProposalV1 {
  /** Same as `proposalId` for traceability. */
  sourceProposalId: string
}

export interface ProposalTopologyCleanupV1Debug {
  cleanedProposalCount: number
  cleanedRoomProposals: CleanedRoomProposalV1[]
  overlapReductionSummary: OverlapPairReductionV1[]
  wallSnapSummary: WallSnapSummaryV1
  stillAmbiguousProposalIds: string[]
  cleanupStatement: string
  notes: string[]
  /** Walls used for crossing penalty / SVG. */
  wallsUsedForCleanup: Array<{ x1: number; y1: number; x2: number; y2: number; strength: number }>
  /** Union bbox of cells where multiple raw proposals competed (debug / SVG). */
  conflictZoneBboxes: PlanBoundingBox[]
}

export function buildPlanBodyProposalTopologyCleanupV1(
  partition: SemanticGuidedRoomPartitionV1Debug,
  majorAnchors: MajorRoomAnchorV1[],
  grouping: RoomTextGroupingV1Debug,
  primaryLayoutSegments: ExtractedLineSegment[],
  primaryLayoutCleanedIndices: readonly number[],
  hyps: ArchitecturalWallHypothesesDebugPayload,
  spans: GlobalStructuralSpansDebugPayload,
  unitPolygon: Pt[],
  unitBoundaryClosed: boolean,
  unitArea: number
): ProposalTopologyCleanupV1Debug {
  const notes: string[] = []
  const empty = (): ProposalTopologyCleanupV1Debug => ({
    cleanedProposalCount: 0,
    cleanedRoomProposals: [],
    overlapReductionSummary: [],
    wallSnapSummary: {
      strongWallSegmentCount: 0,
      wallCrossingPenaltyPt: T1.wallPenaltyPt,
      gridCellsAssigned: 0,
      cellsWithMultiCandidateRaw: 0,
    },
    stillAmbiguousProposalIds: [],
    cleanupStatement: "Proposal topology cleanup v1 skipped.",
    notes,
    wallsUsedForCleanup: [],
    conflictZoneBboxes: [],
  })

  if (!unitBoundaryClosed || unitPolygon.length < 3) {
    notes.push("Topology cleanup v1 skipped — unit not closed.")
    return empty()
  }

  const rawProps = partition.roomProposals.filter((p) => p.polygon.length >= 3)
  if (rawProps.length === 0) {
    notes.push("Topology cleanup v1: no room proposals to clean.")
    return empty()
  }

  const anchorPts = majorAnchors.map((a) => ({ x: a.x, y: a.y }))
  const walls = collectStrongWalls(
    unitPolygon,
    primaryLayoutSegments,
    primaryLayoutCleanedIndices,
    hyps,
    spans,
    anchorPts.length > 0 ? anchorPts : rawProps.map((p) => centroidPoly(p.polygon))
  )

  const proposalAnchors = rawProps.map((p) => anchorForProposal(p, majorAnchors, grouping))

  const ub = bboxOfPoly(unitPolygon)
  const g = makeGrid(ub, 8)
  const owner = new Int32Array(g.gw * g.gh).fill(-1)
  let assigned = 0
  let multiRaw = 0
  const conflictCells: Pt[] = []

  for (let j = 0; j < g.gh; j++) {
    for (let i = 0; i < g.gw; i++) {
      const c = cellCenterWorld(i, j, g)
      if (!pointInPolygon(c.x, c.y, unitPolygon)) continue

      const eligible: number[] = []
      for (let k = 0; k < rawProps.length; k++) {
        if (pointInPolygon(c.x, c.y, rawProps[k]!.polygon)) eligible.push(k)
      }
      if (eligible.length === 0) continue
      if (eligible.length > 1) {
        multiRaw++
        conflictCells.push({ x: c.x, y: c.y })
      }

      let bestK = eligible[0]!
      let bestS = Infinity
      for (const k of eligible) {
        const ac = proposalAnchors[k]!
        const e = Math.hypot(c.x - ac.x, c.y - ac.y)
        const cross = wallCrossings(ac.x, ac.y, c.x, c.y, walls)
        const s = e + cross * T1.wallPenaltyPt
        if (s < bestS) {
          bestS = s
          bestK = k
        }
      }
      owner[cellIdx(i, j, g.gw)] = bestK
      assigned++
    }
  }

  const cellsByK: Pt[][] = rawProps.map(() => [])
  for (let j = 0; j < g.gh; j++) {
    for (let i = 0; i < g.gw; i++) {
      const id = cellIdx(i, j, g.gw)
      const k = owner[id]
      if (k < 0) continue
      cellsByK[k]!.push(cellCenterWorld(i, j, g))
    }
  }

  const cleanedRoomProposals: CleanedRoomProposalV1[] = []
  for (let k = 0; k < rawProps.length; k++) {
    const src = rawProps[k]!
    const pts = cellsByK[k]!
    let poly: Pt[] = []
    if (pts.length >= 3) {
      poly = convexHull(pts)
    } else {
      poly = src.polygon.map((p) => ({ x: p.x, y: p.y }))
      notes.push(`Cleanup: thin cell set for ${src.proposalId} — kept soft polygon.`)
    }
    if (poly.length < 3) continue
    const area = polygonAbsArea(poly)
    cleanedRoomProposals.push({
      ...src,
      sourceProposalId: src.proposalId,
      polygon: poly,
      areaPt2: area,
      bbox: bboxOfPoly(poly),
    })
  }

  const overlapReductionSummary: OverlapPairReductionV1[] = []
  for (let i = 0; i < rawProps.length; i++) {
    for (let j = i + 1; j < rawProps.length; j++) {
      const iouB = approxIoU(rawProps[i]!.polygon, rawProps[j]!.polygon, 140)
      if (iouB < T1.pairIouNoteThreshold) continue
      const ci = cleanedRoomProposals.find((x) => x.proposalId === rawProps[i]!.proposalId)
      const cj = cleanedRoomProposals.find((x) => x.proposalId === rawProps[j]!.proposalId)
      if (!ci || !cj) continue
      const iouA = approxIoU(ci.polygon, cj.polygon, 140)
      overlapReductionSummary.push({
        proposalIdA: rawProps[i]!.proposalId,
        proposalIdB: rawProps[j]!.proposalId,
        iouBefore: iouB,
        iouAfter: iouA,
      })
    }
  }

  const stillAmbiguousProposalIds: string[] = []
  const ua = Math.max(unitArea, 1)
  for (const c of cleanedRoomProposals) {
    if (c.areaPt2 < T1.ambiguousMinAreaFrac * ua) stillAmbiguousProposalIds.push(c.proposalId)
  }
  for (const c of cleanedRoomProposals) {
    let maxPair = 0
    for (const d of cleanedRoomProposals) {
      if (d.proposalId === c.proposalId) continue
      maxPair = Math.max(maxPair, approxIoU(c.polygon, d.polygon, 120))
    }
    if (maxPair > T1.ambiguousIou && !stillAmbiguousProposalIds.includes(c.proposalId)) {
      stillAmbiguousProposalIds.push(c.proposalId)
    }
  }

  const conflictZoneBboxes: PlanBoundingBox[] = []
  if (conflictCells.length > 0) {
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity
    for (const p of conflictCells) {
      minX = Math.min(minX, p.x)
      minY = Math.min(minY, p.y)
      maxX = Math.max(maxX, p.x)
      maxY = Math.max(maxY, p.y)
    }
    const pad = g.cell * 2
    conflictZoneBboxes.push({
      minX: minX - pad,
      minY: minY - pad,
      maxX: maxX + pad,
      maxY: maxY + pad,
    })
  }

  const wallSnapSummary: WallSnapSummaryV1 = {
    strongWallSegmentCount: walls.length,
    wallCrossingPenaltyPt: T1.wallPenaltyPt,
    gridCellsAssigned: assigned,
    cellsWithMultiCandidateRaw: multiRaw,
  }

  notes.push(
    `Grid ${g.gw}×${g.gh} cell ${g.cell.toFixed(2)}pt; ${walls.length} wall segment(s); ${multiRaw} multi-proposal cell(s) resolved with anchor distance + wall penalty.`
  )
  notes.push("Coarse refined quadrants are not used for cleanup — only soft semantic proposal masks + unit + walls.")

  const cleanupStatement = `Topology cleanup v1: ${cleanedRoomProposals.length} cleaned proposal(s); ${overlapReductionSummary.length} overlapping pair(s) tracked; ${stillAmbiguousProposalIds.length} still ambiguous by area/IoU.`

  return {
    cleanedProposalCount: cleanedRoomProposals.length,
    cleanedRoomProposals,
    overlapReductionSummary,
    wallSnapSummary,
    stillAmbiguousProposalIds,
    cleanupStatement,
    notes,
    wallsUsedForCleanup: walls.map((w) => ({
      x1: w.x1,
      y1: w.y1,
      x2: w.x2,
      y2: w.y2,
      strength: w.strength,
    })),
    conflictZoneBboxes,
  }
}

export interface BuildPlanBodyProposalTopologyCleanupV1SvgOptions {
  pageBounds: PlanBoundingBox
  primaryLayoutBBox: PlanBoundingBox
  cleanup: ProposalTopologyCleanupV1Debug
  /** Faint comparison only — not structural input. */
  refinedRoomCandidates: import("@/lib/geometryFirst/planBodyRoomCandidatesV0").RoomCandidateV0[]
  rawSemanticProposals: SemanticRoomProposalV1[]
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

export function buildPlanBodyProposalTopologyCleanupV1SvgString(o: BuildPlanBodyProposalTopologyCleanupV1SvgOptions): string {
  const pb = o.pageBounds
  const w = pb.maxX - pb.minX
  const h = pb.maxY - pb.minY
  const bx = o.primaryLayoutBBox

  const unitPath = pathFromPoly(o.unitPolygon, o.unitBoundaryClosed)
  const unitStroke = `<path d="${escapeXml(unitPath)}" fill="none" stroke="rgba(0,80,40,0.95)" stroke-width="2.2" stroke-dasharray="8 5"/>`

  const faintQuad = o.refinedRoomCandidates
    .map((r) => {
      const p = pathFromPoly(r.polygon, true)
      return `<path d="${escapeXml(p)}" fill="rgba(150,150,190,0.03)" stroke="rgba(120,120,160,0.2)" stroke-width="0.55" stroke-dasharray="7 6"/>`
    })
    .join("\n")

  const rawDash = o.rawSemanticProposals
    .map((r) => {
      const p = pathFromPoly(r.polygon, true)
      return `<path d="${escapeXml(p)}" fill="rgba(80,120,200,0.04)" stroke="rgba(60,90,170,0.55)" stroke-width="1.15" stroke-dasharray="5 4"/>`
    })
    .join("\n")

  const colors = [
    "rgba(25,120,95,0.88)",
    "rgba(35,85,165,0.88)",
    "rgba(175,95,30,0.88)",
    "rgba(115,45,140,0.85)",
    "rgba(20,140,120,0.88)",
    "rgba(160,50,75,0.85)",
  ]
  const solid = o.cleanup.cleanedRoomProposals
    .map((r, i) => {
      const p = pathFromPoly(r.polygon, true)
      const stroke = colors[i % colors.length]!
      return `<path d="${escapeXml(p)}" fill="${stroke.replace("0.88", "0.2").replace("0.85", "0.18")}" stroke="${stroke}" stroke-width="2"/>`
    })
    .join("\n")

  const walls = o.cleanup.wallsUsedForCleanup
    .map((s) => {
      const sw = 0.35 + s.strength * 0.85
      return `<line x1="${s.x1.toFixed(2)}" y1="${s.y1.toFixed(2)}" x2="${s.x2.toFixed(2)}" y2="${s.y2.toFixed(2)}" stroke="rgba(40,40,55,${0.25 + s.strength * 0.45})" stroke-width="${sw.toFixed(2)}"/>`
    })
    .join("\n")

  const conflicts = o.cleanup.conflictZoneBboxes
    .map(
      (b) =>
        `<rect x="${b.minX.toFixed(2)}" y="${b.minY.toFixed(2)}" width="${(b.maxX - b.minX).toFixed(2)}" height="${(b.maxY - b.minY).toFixed(
          2
        )}" fill="rgba(255,120,40,0.08)" stroke="rgba(220,80,20,0.65)" stroke-width="1.2" stroke-dasharray="3 2"/>`
    )
    .join("\n")

  const title = `Proposal topology cleanup v1 — ${o.cleanup.cleanedProposalCount} cleaned; walls ${o.cleanup.wallSnapSummary.strongWallSegmentCount}; multi-candidate cells ${o.cleanup.wallSnapSummary.cellsWithMultiCandidateRaw}; ambiguous ${o.cleanup.stillAmbiguousProposalIds.length}`

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${pb.minX} ${pb.minY} ${w} ${h}" width="${Math.round(w)}" height="${Math.round(
    h
  )}">
<rect x="${pb.minX}" y="${pb.minY}" width="${w}" height="${h}" fill="white"/>
<text x="${pb.minX + 8}" y="${pb.minY + 14}" font-size="11" fill="#222" font-family="system-ui,sans-serif">${escapeXml(title)}</text>
<text x="${pb.minX + 8}" y="${pb.minY + 28}" font-size="7" fill="#444" font-family="system-ui,sans-serif">Faint = old quadrants (non-structural); dashed blue = semantic proposals before; solid = wall-penalty grid cleanup; dark strokes = walls; orange = overlap-conflict zone sample.</text>
<g>${faintQuad}</g>
<g>${walls}</g>
<g>${rawDash}</g>
<g>${conflicts}</g>
<g>${solid}</g>
<g>${unitStroke}</g>
<rect x="${bx.minX}" y="${bx.minY}" width="${bx.maxX - bx.minX}" height="${bx.maxY - bx.minY}" fill="none" stroke="rgba(0,60,30,0.28)" stroke-width="1" stroke-dasharray="5 4"/>
</svg>`
}
