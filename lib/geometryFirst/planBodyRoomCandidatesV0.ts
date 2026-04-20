/**
 * Debug-only **room candidate extraction v0**: unlabeled room-like regions inside the current unit boundary
 * via raster CV + light geometry cycles + fusion. Not semantic labels; not extrusion; production unchanged.
 */

import type { ArchitecturalWallHypothesesDebugPayload } from "@/lib/geometryFirst/architecturalWallHypotheses"
import { buildWallGraphFoundationFromCleaned } from "@/lib/geometryFirst/wallGraphFoundation"
import { splitWallLinesAtJunctions } from "@/lib/geometryFirst/splitWallLinesAtJunctions"
import type { ExtractedLineSegment, PlanBoundingBox } from "@/lib/geometryFirst/types"
import type { PlanBodyBoundaryRecoveryV3Debug } from "@/lib/geometryFirst/planBodyBoundaryRecoveryV3"
import type { PlanBodyShellRegularizationDebug } from "@/lib/geometryFirst/planBodyShellRegularization"
import type { GlobalStructuralSpansDebugPayload } from "@/lib/geometryFirst/globalStructuralSpans"

export type RoomCandidateSourceV0 =
  | "cv"
  | "geometry"
  | "fused"
  | "cv_split"
  | "cv_split_v2"
  | "cv_split_v3"
  | "refined_v1"

export interface RoomCandidateV0 {
  id: string
  polygon: Array<{ x: number; y: number }>
  confidence: number
  source: RoomCandidateSourceV0
  areaPt2: number
  bbox: PlanBoundingBox
  adjacentCandidateIds?: string[]
}

export interface PlanBodyRoomCandidatesV0Debug {
  roomCandidateCount: number
  cvRoomCandidateCount: number
  geometryRoomCandidateCount: number
  fusedRoomCandidateCount: number
  roomCandidates: RoomCandidateV0[]
  cvRoomCandidates: RoomCandidateV0[]
  geometryRoomCandidates: RoomCandidateV0[]
  roomExtractionStatement: string
  notes: string[]
  /** Tiny CV blobs dropped (for faint SVG). */
  rejectedCvRegions: Array<{ bbox: PlanBoundingBox; areaPt2Approx: number }>
}

type Pt = { x: number; y: number }

const V0 = {
  gridTarget: 420,
  wallDilatePasses: 2,
  minRoomAreaPt2: 2800,
  maxRoomFracOfUnit: 0.88,
  minGeomAreaPt2: 3200,
  maxGeomFracOfUnit: 0.45,
  partitionLenMin: 5,
  partitionLenMax: 520,
  fusionIouMin: 0.34,
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

/** Ray-cast; closed polygon. */
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

function segmentLen(s: ExtractedLineSegment): number {
  return Math.hypot(s.x2 - s.x1, s.y2 - s.y1)
}

function midpointInPoly(s: ExtractedLineSegment, poly: Pt[]): boolean {
  const mx = (s.x1 + s.x2) / 2
  const my = (s.y1 + s.y2) / 2
  return pointInPolygon(mx, my, poly)
}

function polygonToSegments(poly: Pt[], closed: boolean): ExtractedLineSegment[] {
  if (poly.length < 2) return []
  const out: ExtractedLineSegment[] = []
  const n = closed ? poly.length : poly.length - 1
  for (let i = 0; i < n; i++) {
    const a = poly[i]!
    const b = closed ? poly[(i + 1) % poly.length]! : poly[i + 1]!
    out.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y })
  }
  return out
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

function rdpOpen(pts: Pt[], eps: number): Pt[] {
  if (pts.length < 3) return pts.slice()
  let dmax = 0
  let idx = 0
  const last = pts.length - 1
  for (let i = 1; i < last; i++) {
    const p = pts[i]!
    const a = pts[0]!
    const b = pts[last]!
    const d = pointToSegDist(p.x, p.y, a.x, a.y, b.x, b.y)
    if (d > dmax) {
      dmax = d
      idx = i
    }
  }
  if (dmax > eps) {
    const l = rdpOpen(pts.slice(0, idx + 1), eps)
    const r = rdpOpen(pts.slice(idx), eps)
    return [...l.slice(0, -1), ...r]
  }
  return [pts[0]!, pts[last]!]
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
  const cell = Math.max(1.2, Math.max(w, h) / V0.gridTarget)
  const gw = Math.max(8, Math.ceil(w / cell))
  const gh = Math.max(8, Math.ceil(h / cell))
  return { minX, minY, cell, gw, gh }
}

function idx(i: number, j: number, gw: number): number {
  return j * gw + i
}

function cellCenterWorld(i: number, j: number, g: GridSpec): { x: number; y: number } {
  return { x: g.minX + (i + 0.5) * g.cell, y: g.minY + (j + 0.5) * g.cell }
}

function drawSegOnGrid(wall: Uint8Array, g: GridSpec, x1: number, y1: number, x2: number, y2: number, thick: number): void {
  const steps = Math.max(
    1,
    Math.ceil(Math.hypot(x2 - x1, y2 - y1) / Math.max(0.35, g.cell * 0.35))
  )
  for (let t = 0; t <= steps; t++) {
    const u = t / steps
    const x = x1 + u * (x2 - x1)
    const y = y1 + u * (y2 - y1)
    const i = Math.floor((x - g.minX) / g.cell)
    const j = Math.floor((y - g.minY) / g.cell)
    for (let di = -thick; di <= thick; di++) {
      for (let dj = -thick; dj <= thick; dj++) {
        const ii = i + di
        const jj = j + dj
        if (ii >= 0 && jj >= 0 && ii < g.gw && jj < g.gh) wall[idx(ii, jj, g.gw)] = 1
      }
    }
  }
}

function dilate(wall: Uint8Array, gw: number, gh: number, passes: number): void {
  const tmp = new Uint8Array(wall.length)
  for (let p = 0; p < passes; p++) {
    tmp.set(wall)
    for (let j = 0; j < gh; j++) {
      for (let i = 0; i < gw; i++) {
        if (tmp[idx(i, j, gw)] === 0) continue
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const ii = i + di
            const jj = j + dj
            if (ii >= 0 && jj >= 0 && ii < gw && jj < gh) wall[idx(ii, jj, gw)] = 1
          }
        }
      }
    }
  }
}

function labelComponents(mask: Uint8Array, gw: number, gh: number): { labels: Int32Array; count: number } {
  const labels = new Int32Array(gw * gh).fill(-1)
  let cur = 0
  const qx: number[] = []
  const qy: number[] = []
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      const id = idx(i, j, gw)
      if (mask[id] === 0 || labels[id] >= 0) continue
      labels[id] = cur
      qx.length = 0
      qy.length = 0
      qx.push(i)
      qy.push(j)
      while (qx.length) {
        const x = qx.pop()!
        const y = qy.pop()!
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue
          const nid = idx(nx, ny, gw)
          if (mask[nid] === 0 || labels[nid] >= 0) continue
          labels[nid] = cur
          qx.push(nx)
          qy.push(ny)
        }
      }
      cur++
    }
  }
  return { labels, count: cur }
}

function componentBbox(labels: Int32Array, lab: number, gw: number, gh: number, g: GridSpec): PlanBoundingBox {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      if (labels[idx(i, j, gw)] !== lab) continue
      const c = cellCenterWorld(i, j, g)
      minX = Math.min(minX, c.x)
      minY = Math.min(minY, c.y)
      maxX = Math.max(maxX, c.x)
      maxY = Math.max(maxY, c.y)
    }
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 1, maxY: 1 }
  return { minX, minY, maxX, maxY }
}

function componentToHullPolygon(
  labels: Int32Array,
  lab: number,
  gw: number,
  gh: number,
  g: GridSpec,
  unitPoly: Pt[]
): Pt[] | null {
  const pts: Pt[] = []
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      if (labels[idx(i, j, gw)] !== lab) continue
      const c = cellCenterWorld(i, j, g)
      if (pointInPolygon(c.x, c.y, unitPoly)) pts.push(c)
    }
  }
  if (pts.length < 3) return null
  const h = convexHull(pts)
  if (h.length < 3) return null
  const closed = true
  return simplifyPolygon(h, g.cell * 1.1, closed)
}

function polygonIou(a: Pt[], b: Pt[]): number {
  const ab = bboxOfPoly(a)
  const bb = bboxOfPoly(b)
  const ix = Math.max(0, Math.min(ab.maxX, bb.maxX) - Math.max(ab.minX, bb.minX))
  const iy = Math.max(0, Math.min(ab.maxY, bb.maxY) - Math.max(ab.minY, bb.minY))
  const inter = ix * iy
  const aa = polygonAbsArea(a)
  const ba = polygonAbsArea(b)
  if (aa < 1e-6 || ba < 1e-6) return 0
  return inter / (aa + ba - inter + 1e-6)
}

function extractCvRooms(
  unitPoly: Pt[],
  unitArea: number,
  primaryLayoutSegments: ExtractedLineSegment[],
  primaryLayoutCleanedIndices: readonly number[],
  hyps: ArchitecturalWallHypothesesDebugPayload,
  bbox: PlanBoundingBox
): { kept: RoomCandidateV0[]; rejected: Array<{ bbox: PlanBoundingBox; areaPt2Approx: number }> } {
  const pad = Math.max(24, Math.min(bbox.maxX - bbox.minX, bbox.maxY - bbox.minY) * 0.02)
  const g = makeGrid(bbox, pad)
  const wall = new Uint8Array(g.gw * g.gh)
  const thick = 1

  for (let li = 0; li < primaryLayoutSegments.length; li++) {
    if (primaryLayoutCleanedIndices[li] == null) continue
    const s = primaryLayoutSegments[li]!
    if (!midpointInPoly(s, unitPoly) && !segmentCrossesPoly(s, unitPoly)) continue
    if (segmentLen(s) < 2) continue
    drawSegOnGrid(wall, g, s.x1, s.y1, s.x2, s.y2, thick)
  }
  for (const h of hyps.hypotheses) {
    if (h.exteriorLikelihood < 0.22) continue
    const c = h.centerline
    const mx = (c.x1 + c.x2) / 2
    const my = (c.y1 + c.y2) / 2
    if (!pointInPolygon(mx, my, unitPoly)) continue
    drawSegOnGrid(wall, g, c.x1, c.y1, c.x2, c.y2, 0)
  }

  dilate(wall, g.gw, g.gh, V0.wallDilatePasses)

  const free = new Uint8Array(g.gw * g.gh)
  for (let j = 0; j < g.gh; j++) {
    for (let i = 0; i < g.gw; i++) {
      const c = cellCenterWorld(i, j, g)
      if (!pointInPolygon(c.x, c.y, unitPoly)) continue
      if (wall[idx(i, j, g.gw)] === 0) free[idx(i, j, g.gw)] = 1
    }
  }

  const { labels, count } = labelComponents(free, g.gw, g.gh)
  const sizes = new Float64Array(count)
  for (let j = 0; j < g.gh; j++) {
    for (let i = 0; i < g.gw; i++) {
      const lab = labels[idx(i, j, g.gw)]
      if (lab < 0) continue
      sizes[lab] += g.cell * g.cell
    }
  }

  const kept: RoomCandidateV0[] = []
  const rejected: Array<{ bbox: PlanBoundingBox; areaPt2Approx: number }> = []

  for (let lab = 0; lab < count; lab++) {
    const ar = sizes[lab]!
    if (ar < V0.minRoomAreaPt2 * 0.35) {
      if (ar > 80) {
        const bb = componentBbox(labels, lab, g.gw, g.gh, g)
        rejected.push({ bbox: bb, areaPt2Approx: ar })
      }
      continue
    }
    if (ar > unitArea * V0.maxRoomFracOfUnit) continue
    const poly = componentToHullPolygon(labels, lab, g.gw, g.gh, g, unitPoly)
    if (!poly || poly.length < 3) continue
    const area = polygonAbsArea(poly)
    if (area < V0.minRoomAreaPt2) {
      rejected.push({ bbox: bboxOfPoly(poly), areaPt2Approx: area })
      continue
    }
    kept.push({
      id: `cv-${kept.length}`,
      polygon: poly,
      confidence: clamp(0.26 + 0.22 * Math.min(1, area / (unitArea * 0.12)), 0.18, 0.48),
      source: "cv",
      areaPt2: area,
      bbox: bboxOfPoly(poly),
    })
  }

  return { kept, rejected }
}

function segmentCrossesPoly(s: ExtractedLineSegment, poly: Pt[]): boolean {
  const samples = 5
  for (let k = 0; k <= samples; k++) {
    const t = k / samples
    const x = s.x1 + t * (s.x2 - s.x1)
    const y = s.y1 + t * (s.y2 - s.y1)
    if (pointInPolygon(x, y, poly)) return true
  }
  return false
}

function extractGeometryRooms(
  unitPoly: Pt[],
  unitArea: number,
  primaryLayoutSegments: ExtractedLineSegment[],
  primaryLayoutCleanedIndices: readonly number[],
  _spans: GlobalStructuralSpansDebugPayload
): RoomCandidateV0[] {
  void _spans
  const boundarySegs = polygonToSegments(unitPoly, true)
  const interior: ExtractedLineSegment[] = []
  for (let li = 0; li < primaryLayoutSegments.length; li++) {
    if (primaryLayoutCleanedIndices[li] == null) continue
    const s = primaryLayoutSegments[li]!
    const L = segmentLen(s)
    if (L < V0.partitionLenMin || L > V0.partitionLenMax) continue
    if (!midpointInPoly(s, unitPoly)) continue
    interior.push(s)
  }
  const merged = [...boundarySegs, ...interior]
  if (merged.length < 3) return []
  const { split } = splitWallLinesAtJunctions(merged)
  const wg = buildWallGraphFoundationFromCleaned(split, {
    nodeMergeQuantizationPt: 0.85,
    hullSegmentMatchTolPt: 2.2,
  })
  const top = wg.outerCycleTrace?.candidateSummariesTop ?? []
  const out: RoomCandidateV0[] = []
  const seen = new Set<string>()

  for (let rank = 0; rank < top.length; rank++) {
    const c = top[rank]!
    if (!c.vertexSample || c.vertexSample.length < 3) continue
    if (c.cycleAbsAreaPt2 < V0.minGeomAreaPt2) continue
    if (c.cycleAbsAreaPt2 > unitArea * V0.maxGeomFracOfUnit) continue
    const poly = simplifyPolygon(
      c.vertexSample.map((p) => ({ x: p.x, y: p.y })),
      2.4,
      true
    )
    if (poly.length < 3) continue
    const cx = poly.reduce((s, p) => s + p.x, 0) / poly.length
    const cy = poly.reduce((s, p) => s + p.y, 0) / poly.length
    if (!pointInPolygon(cx, cy, unitPoly)) continue
    const area = polygonAbsArea(poly)
    if (area < V0.minGeomAreaPt2 || area > unitArea * (V0.maxGeomFracOfUnit + 0.08)) continue
    if (Math.abs(area - unitArea) < 0.055 * unitArea) continue
    const key = poly
      .map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`)
      .sort()
      .join("|")
    if (seen.has(key)) continue
    seen.add(key)
    const conf =
      c.exteriorScaleHint === "interior-scale"
        ? 0.52
        : c.exteriorScaleHint === "uncertain"
          ? 0.44
          : 0.38
    out.push({
      id: `geo-${out.length}`,
      polygon: poly,
      confidence: clamp(conf + 0.06 * (c.stepSupportFraction ?? 0), 0.34, 0.62),
      source: "geometry",
      areaPt2: area,
      bbox: bboxOfPoly(poly),
    })
  }

  return out
}

function fuseRooms(cv: RoomCandidateV0[], geo: RoomCandidateV0[]): { fused: RoomCandidateV0[]; fusedCount: number } {
  const usedCv = new Set<number>()
  const usedGeo = new Set<number>()
  const fused: RoomCandidateV0[] = []
  let fusedCount = 0

  for (let i = 0; i < geo.length; i++) {
    if (usedGeo.has(i)) continue
    let bestJ = -1
    let bestIou = 0
    for (let j = 0; j < cv.length; j++) {
      if (usedCv.has(j)) continue
      const iou = polygonIou(geo[i]!.polygon, cv[j]!.polygon)
      if (iou > bestIou) {
        bestIou = iou
        bestJ = j
      }
    }
    if (bestJ >= 0 && bestIou >= V0.fusionIouMin) {
      usedGeo.add(i)
      usedCv.add(bestJ)
      const g = geo[i]!
      const c = cv[bestJ]!
      const mergedPoly = polygonAbsArea(g.polygon) >= polygonAbsArea(c.polygon) ? g.polygon : c.polygon
      fused.push({
        id: `fused-${fusedCount}`,
        polygon: mergedPoly,
        confidence: clamp(0.55 + 0.2 * bestIou + 0.08 * (g.confidence + c.confidence), 0.48, 0.82),
        source: "fused",
        areaPt2: polygonAbsArea(mergedPoly),
        bbox: bboxOfPoly(mergedPoly),
      })
      fusedCount++
    }
  }

  const restGeo = geo.filter((_, i) => !usedGeo.has(i))
  const restCv = cv.filter((_, j) => !usedCv.has(j))
  return { fused: [...fused, ...restGeo, ...restCv], fusedCount }
}

function adjacencyHints(rooms: RoomCandidateV0[], gapPt: number): void {
  for (let i = 0; i < rooms.length; i++) {
    const adj: string[] = []
    const bi = rooms[i]!.bbox
    for (let j = 0; j < rooms.length; j++) {
      if (i === j) continue
      const bj = rooms[j]!.bbox
      const near =
        !(bi.maxX + gapPt < bj.minX || bj.maxX + gapPt < bi.minX || bi.maxY + gapPt < bj.minY || bj.maxY + gapPt < bi.minY)
      if (near) adj.push(rooms[j]!.id)
    }
    if (adj.length) rooms[i]!.adjacentCandidateIds = adj.slice(0, 12)
  }
}

function pickUnitPolygon(
  boundaryV3: PlanBodyBoundaryRecoveryV3Debug,
  regularization: PlanBodyShellRegularizationDebug
): { poly: Pt[]; closed: boolean; source: string } | null {
  if (regularization.regularizedPolygonPt.length >= 3 && regularization.regularizedBoundaryClosed) {
    return {
      poly: regularization.regularizedPolygonPt.map((p) => ({ x: p.x, y: p.y })),
      closed: true,
      source: "shellRegularization",
    }
  }
  const b = boundaryV3.bestBoundaryCandidate
  if (b && b.closed && b.boundaryPolylinePt.length >= 3) {
    return {
      poly: b.boundaryPolylinePt.map((p) => ({ x: p.x, y: p.y })),
      closed: true,
      source: "boundaryRecoveryV3",
    }
  }
  if (regularization.regularizedPolygonPt.length >= 2) {
    return {
      poly: regularization.regularizedPolygonPt.map((p) => ({ x: p.x, y: p.y })),
      closed: !!regularization.regularizedBoundaryClosed,
      source: "shellRegularizationOpen",
    }
  }
  return null
}

export function buildPlanBodyRoomCandidatesV0(
  primaryLayoutBBox: PlanBoundingBox,
  primaryLayoutSegments: ExtractedLineSegment[],
  primaryLayoutCleanedIndices: readonly number[],
  wallHypothesesPlanOnly: ArchitecturalWallHypothesesDebugPayload,
  globalSpansPlanOnly: GlobalStructuralSpansDebugPayload,
  boundaryRecoveryV3: PlanBodyBoundaryRecoveryV3Debug,
  regularization: PlanBodyShellRegularizationDebug
): PlanBodyRoomCandidatesV0Debug {
  const notes: string[] = []
  const unit = pickUnitPolygon(boundaryRecoveryV3, regularization)
  if (!unit || unit.poly.length < 3 || !unit.closed) {
    notes.push(
      unit && !unit.closed
        ? "Room extraction v0 skipped — unit boundary is open; need a closed polygon."
        : "Room extraction v0 skipped — no closed unit boundary polygon available."
    )
    return {
      roomCandidateCount: 0,
      cvRoomCandidateCount: 0,
      geometryRoomCandidateCount: 0,
      fusedRoomCandidateCount: 0,
      roomCandidates: [],
      cvRoomCandidates: [],
      geometryRoomCandidates: [],
      roomExtractionStatement: "No unit boundary — cannot extract room candidates inside the shell.",
      notes,
      rejectedCvRegions: [],
    }
  }

  const unitPoly = unit.poly
  const unitArea = polygonAbsArea(unitPoly)
  if (unitArea < V0.minRoomAreaPt2 * 3) {
    notes.push("Unit polygon area too small for reliable room v0.")
  }

  notes.push(`Unit boundary source: ${unit.source}; area=${unitArea.toFixed(0)} pt².`)

  const { kept: cvRooms, rejected: rejectedCv } = extractCvRooms(
    unitPoly,
    unitArea,
    primaryLayoutSegments,
    primaryLayoutCleanedIndices,
    wallHypothesesPlanOnly,
    primaryLayoutBBox
  )
  const geoRooms = extractGeometryRooms(
    unitPoly,
    unitArea,
    primaryLayoutSegments,
    primaryLayoutCleanedIndices,
    globalSpansPlanOnly
  )

  const { fused: roomCandidates, fusedCount } = fuseRooms(cvRooms, geoRooms)
  adjacencyHints(roomCandidates, 14)

  let statement = `Room candidates v0: ${roomCandidates.length} region(s) (${fusedCount} fused, ${cvRooms.length} CV, ${geoRooms.length} geometry). Unlabeled; heuristic only.`
  if (cvRooms.length === 0 && geoRooms.length === 0) {
    statement = "No room-like cells recovered — walls may be too sparse or grid resolution too coarse for v0."
  }
  notes.push(
    `Ambiguity: CV uses rasterized walls + convex hulls of free cells; geometry uses left-face cycle summaries — both are approximate.`
  )

  return {
    roomCandidateCount: roomCandidates.length,
    cvRoomCandidateCount: cvRooms.length,
    geometryRoomCandidateCount: geoRooms.length,
    fusedRoomCandidateCount: fusedCount,
    roomCandidates,
    cvRoomCandidates: cvRooms,
    geometryRoomCandidates: geoRooms,
    roomExtractionStatement: statement,
    notes,
    rejectedCvRegions: rejectedCv.slice(0, 80),
  }
}

export interface BuildPlanBodyRoomCandidatesV0SvgOptions {
  pageBounds: PlanBoundingBox
  primaryLayoutBBox: PlanBoundingBox
  debug: PlanBodyRoomCandidatesV0Debug
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

function fillForConfidence(conf: number, alpha: number): string {
  if (conf >= 0.58) return `rgba(30,140,80,${alpha})`
  if (conf >= 0.42) return `rgba(220,170,40,${alpha})`
  return `rgba(120,90,200,${alpha})`
}

export function buildPlanBodyRoomCandidatesV0SvgString(o: BuildPlanBodyRoomCandidatesV0SvgOptions): string {
  const pb = o.pageBounds
  const w = pb.maxX - pb.minX
  const h = pb.maxY - pb.minY
  const bx = o.primaryLayoutBBox
  const d = o.debug

  const unitPath = pathFromPoly(o.unitPolygon, o.unitBoundaryClosed)
  const unitStroke = `<path d="${escapeXml(unitPath)}" fill="none" stroke="rgba(0,80,40,0.95)" stroke-width="2.6" stroke-dasharray="8 5"/>`

  const rejected = d.rejectedCvRegions
    .slice(0, 120)
    .map(
      (r) =>
        `<rect x="${r.bbox.minX}" y="${r.bbox.minY}" width="${Math.max(0.5, r.bbox.maxX - r.bbox.minX)}" height="${Math.max(0.5, r.bbox.maxY - r.bbox.minY)}" fill="rgba(180,180,190,0.12)" stroke="rgba(150,150,160,0.35)" stroke-width="0.6"/>`
    )
    .join("\n")

  const drawRooms = (rooms: RoomCandidateV0[], strokeDash: string, strokeTint: string) =>
    rooms
      .map((r) => {
        const p = pathFromPoly(r.polygon, true)
        const fill = fillForConfidence(r.confidence, 0.14)
        const stroke = strokeTint
        return `<path d="${escapeXml(p)}" fill="${fill}" stroke="${stroke}" stroke-width="1.35" stroke-dasharray="${strokeDash}"/>`
      })
      .join("\n")

  const cvPaths = drawRooms(d.cvRoomCandidates, "4 3", "rgba(60,100,200,0.55)")
  const geoPaths = drawRooms(d.geometryRoomCandidates, "6 4", "rgba(200,100,40,0.55)")
  const fusedOnly = d.roomCandidates.filter((r) => r.source === "fused")
  const other = d.roomCandidates.filter((r) => r.source !== "fused")
  const fusedPaths = drawRooms(fusedOnly, "0", "rgba(20,120,60,0.85)")
  const restPaths = drawRooms(other, "3 2", "rgba(90,90,110,0.45)")

  const title = `Room candidates v0 — total ${d.roomCandidateCount} (CV ${d.cvRoomCandidateCount}, geo ${d.geometryRoomCandidateCount}, fused ${d.fusedRoomCandidateCount})`

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${pb.minX} ${pb.minY} ${w} ${h}" width="${Math.round(w)}" height="${Math.round(
    h
  )}">
<rect x="${pb.minX}" y="${pb.minY}" width="${w}" height="${h}" fill="white"/>
<text x="${pb.minX + 8}" y="${pb.minY + 14}" font-size="11" fill="#222" font-family="system-ui,sans-serif">${escapeXml(title)}</text>
<text x="${pb.minX + 8}" y="${pb.minY + 28}" font-size="8.5" fill="#444" font-family="system-ui,sans-serif">${escapeXml(
    d.roomExtractionStatement.slice(0, 240) + (d.roomExtractionStatement.length > 240 ? "…" : "")
  )}</text>
<text x="${pb.minX + 8}" y="${pb.minY + 42}" font-size="7.5" fill="#555" font-family="system-ui,sans-serif">Blue dash=CV, orange dash=geometry, solid green=fused; fills by confidence; gray=rejected specks.</text>
<g>${rejected}</g>
<g>${cvPaths}</g>
<g>${geoPaths}</g>
<g>${restPaths}</g>
<g>${fusedPaths}</g>
<g>${unitStroke}</g>
<rect x="${bx.minX}" y="${bx.minY}" width="${bx.maxX - bx.minX}" height="${bx.maxY - bx.minY}" fill="none" stroke="rgba(0,60,30,0.4)" stroke-width="1.2" stroke-dasharray="5 4"/>
</svg>`
}

export function getRoomCandidatesV0UnitPolygonForSvg(
  boundaryRecoveryV3: PlanBodyBoundaryRecoveryV3Debug,
  regularization: PlanBodyShellRegularizationDebug
): { unitPolygon: Pt[]; unitBoundaryClosed: boolean } | null {
  const u = pickUnitPolygon(boundaryRecoveryV3, regularization)
  if (!u || u.poly.length < 2) return null
  return { unitPolygon: u.poly, unitBoundaryClosed: u.closed }
}
