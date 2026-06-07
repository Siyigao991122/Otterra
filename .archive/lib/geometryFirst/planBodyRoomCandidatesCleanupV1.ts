/**
 * Debug-only **room candidate cleanup / splitting v1**: conservative barrier-aware splitting of
 * oversized unit-scale blobs from room v0 into a few unlabeled sub-regions. Production unchanged.
 */

import type { ArchitecturalWallHypothesesDebugPayload } from "@/lib/geometryFirst/architecturalWallHypotheses"
import { segmentAngleClass } from "@/lib/geometryFirst/linePrimitiveDenoise"
import type { ExtractedLineSegment, ExtractedTextRun, PlanBoundingBox } from "@/lib/geometryFirst/types"
import type { GlobalStructuralSpansDebugPayload } from "@/lib/geometryFirst/globalStructuralSpans"
import type {
  PlanBodyRoomCandidatesV0Debug,
  RoomCandidateSourceV0,
  RoomCandidateV0,
} from "@/lib/geometryFirst/planBodyRoomCandidatesV0"

type Pt = { x: number; y: number }

const C1 = {
  gridTarget: 400,
  oversizedFracCv: 0.38,
  oversizedFracGeo: 0.48,
  barrierMinLen: 12,
  barrierWeakBelow: 0.47,
  interiorMargin: 9,
  minSubFracUnit: 0.055,
  maxSubFracUnit: 0.8,
  minSubFracBlob: 0.065,
  maxSubFracBlob: 0.93,
  maxNeckBarriers: 4,
  barrierDilatePasses: 1,
  partitionLenMin: 5,
  partitionLenMax: 520,
  textNearPt: 17,
} as const

export type RoomBarrierKindV1 = "plan" | "hypothesis" | "span" | "thinStroke" | "neck"

export interface RoomBarrierDebugV1 {
  x1: number
  y1: number
  x2: number
  y2: number
  strength: number
  kind: RoomBarrierKindV1
}

export interface PlanBodyRoomCandidatesCleanupV1Debug {
  roomCandidateCount: number
  oversizedBlobCount: number
  splitAppliedCount: number
  splitBarrierCount: number
  roomCandidates: RoomCandidateV0[]
  appliedBarriers: RoomBarrierDebugV1[]
  rejectedWeakBarriers: RoomBarrierDebugV1[]
  oversizedBlobPolygons: Array<{ parentId: string; polygon: Pt[] }>
  roomCleanupStatement: string
  notes: string[]
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

function distToPolyBoundary(px: number, py: number, poly: Pt[]): number {
  let d = Infinity
  const n = poly.length
  for (let i = 0; i < n; i++) {
    const a = poly[i]!
    const b = poly[(i + 1) % n]!
    d = Math.min(d, pointToSegDist(px, py, a.x, a.y, b.x, b.y))
  }
  return d
}

function segmentLen(s: ExtractedLineSegment): number {
  return Math.hypot(s.x2 - s.x1, s.y2 - s.y1)
}

function midpointInPoly(s: ExtractedLineSegment, poly: Pt[]): boolean {
  const mx = (s.x1 + s.x2) / 2
  const my = (s.y1 + s.y2) / 2
  return pointInPolygon(mx, my, poly)
}

function bothEndpointsInPoly(s: ExtractedLineSegment, poly: Pt[]): boolean {
  return pointInPolygon(s.x1, s.y1, poly) && pointInPolygon(s.x2, s.y2, poly)
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

function segmentUsefulForBlob(s: ExtractedLineSegment, blobPoly: Pt[]): boolean {
  return midpointInPoly(s, blobPoly) || segmentCrossesPoly(s, blobPoly)
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
  const cell = Math.max(1.1, Math.max(w, h) / C1.gridTarget)
  const gw = Math.max(8, Math.ceil(w / cell))
  const gh = Math.max(8, Math.ceil(h / cell))
  return { minX, minY, cell, gw, gh }
}

function idx(i: number, j: number, gw: number): number {
  return j * gw + i
}

function cellCenterWorld(i: number, j: number, g: GridSpec): Pt {
  return { x: g.minX + (i + 0.5) * g.cell, y: g.minY + (j + 0.5) * g.cell }
}

function drawSegOnGrid(wall: Uint8Array, g: GridSpec, x1: number, y1: number, x2: number, y2: number, thick: number): void {
  const steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / Math.max(0.35, g.cell * 0.35)))
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

function componentToHullPolygon(
  labels: Int32Array,
  lab: number,
  gw: number,
  gh: number,
  g: GridSpec,
  clipPoly: Pt[]
): Pt[] | null {
  const pts: Pt[] = []
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      if (labels[idx(i, j, gw)] !== lab) continue
      const c = cellCenterWorld(i, j, g)
      if (pointInPolygon(c.x, c.y, clipPoly)) pts.push(c)
    }
  }
  if (pts.length < 3) return null
  const h = convexHull(pts)
  if (h.length < 3) return null
  return simplifyPolygon(h, g.cell * 1.05, true)
}

function textAnchor(t: ExtractedTextRun): Pt {
  const w = t.width ?? 10
  const h = t.height ?? 8
  return { x: t.x + w * 0.5, y: t.y + h * 0.5 }
}

function nearAnyText(px: number, py: number, texts: Pt[]): boolean {
  for (const q of texts) {
    if (Math.hypot(px - q.x, py - q.y) <= C1.textNearPt) return true
  }
  return false
}

function interiorBarrierOk(s: ExtractedLineSegment, unitPoly: Pt[], blobPoly: Pt[]): boolean {
  const mx = (s.x1 + s.x2) / 2
  const my = (s.y1 + s.y2) / 2
  if (!pointInPolygon(mx, my, blobPoly)) return false
  if (distToPolyBoundary(mx, my, unitPoly) < C1.interiorMargin) return false
  if (distToPolyBoundary(mx, my, blobPoly) < C1.interiorMargin * 0.65) return false
  return true
}

export function collectBarrierCandidates(
  blobPoly: Pt[],
  unitPoly: Pt[],
  primaryLayoutSegments: ExtractedLineSegment[],
  primaryLayoutCleanedIndices: readonly number[],
  hyps: ArchitecturalWallHypothesesDebugPayload,
  spans: GlobalStructuralSpansDebugPayload,
  textAnchors: Pt[]
): RoomBarrierDebugV1[] {
  const out: RoomBarrierDebugV1[] = []

  for (let li = 0; li < primaryLayoutSegments.length; li++) {
    if (primaryLayoutCleanedIndices[li] == null) continue
    const s = primaryLayoutSegments[li]!
    const L = segmentLen(s)
    if (L < C1.barrierMinLen) continue
    if (!segmentUsefulForBlob(s, blobPoly)) continue
    if (!interiorBarrierOk(s, unitPoly, blobPoly)) continue

    const ang = segmentAngleClass(s, 6)
    let strength = 0.41
    if (L > 38) strength += 0.08
    if (L > 72) strength += 0.05
    if (bothEndpointsInPoly(s, blobPoly) && L >= C1.partitionLenMin && L <= C1.partitionLenMax) strength += 0.1
    if (ang === "horizontal" || ang === "vertical") {
      strength += 0.04
      if (L > 52 && midpointInPoly(s, blobPoly)) {
        const mx = (s.x1 + s.x2) / 2
        const my = (s.y1 + s.y2) / 2
        if (distToPolyBoundary(mx, my, blobPoly) > 14) {
          strength += 0.06
          out.push({ x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2, strength: clamp(strength + 0.02, 0, 1), kind: "thinStroke" })
          continue
        }
      }
    }
    if (nearAnyText((s.x1 + s.x2) / 2, (s.y1 + s.y2) / 2, textAnchors)) strength += 0.11
    out.push({ x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2, strength: clamp(strength, 0, 1), kind: "plan" })
  }

  for (const h of hyps.hypotheses) {
    const c = h.centerline
    const L = Math.hypot(c.x2 - c.x1, c.y2 - c.y1)
    if (L < C1.barrierMinLen * 0.85) continue
    const mx = (c.x1 + c.x2) / 2
    const my = (c.y1 + c.y2) / 2
    if (!pointInPolygon(mx, my, blobPoly)) continue
    if (!interiorBarrierOk({ x1: c.x1, y1: c.y1, x2: c.x2, y2: c.y2 }, unitPoly, blobPoly)) continue

    let strength =
      0.34 + 0.28 * h.supportScore + 0.14 * h.interiorLikelihood - 0.12 * Math.max(0, h.exteriorLikelihood - 0.35)
    if (h.exteriorLikelihood > 0.78 && h.interiorLikelihood < 0.12) strength -= 0.08
    if (nearAnyText(mx, my, textAnchors)) strength += 0.09
    out.push({ x1: c.x1, y1: c.y1, x2: c.x2, y2: c.y2, strength: clamp(strength, 0, 1), kind: "hypothesis" })
  }

  for (const sp of spans.spans) {
    const c = sp.centerline
    const L = sp.spanLength
    if (L < 32) continue
    const mx = (c.x1 + c.x2) / 2
    const my = (c.y1 + c.y2) / 2
    if (!pointInPolygon(mx, my, blobPoly)) continue
    if (!interiorBarrierOk({ x1: c.x1, y1: c.y1, x2: c.x2, y2: c.y2 }, unitPoly, blobPoly)) continue

    let strength = 0.37 + 0.26 * sp.structuralSupportScore
    if (sp.shellHintScore > 0.74) strength *= 0.88
    if (nearAnyText(mx, my, textAnchors)) strength += 0.08
    out.push({ x1: c.x1, y1: c.y1, x2: c.x2, y2: c.y2, strength: clamp(strength, 0, 1), kind: "span" })
  }

  return out
}

export function neckBarriersFromBlobMask(
  blobMask: Uint8Array,
  g: GridSpec,
  blobPoly: Pt[],
  unitPoly: Pt[]
): RoomBarrierDebugV1[] {
  const { gw, gh } = g
  const colCount = new Int32Array(gw)
  const rowCount = new Int32Array(gh)
  for (let i = 0; i < gw; i++) {
    for (let j = 0; j < gh; j++) {
      if (blobMask[idx(i, j, gw)]) colCount[i]++
    }
  }
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      if (blobMask[idx(i, j, gw)]) rowCount[j]++
    }
  }
  const maxC = Math.max(1, ...colCount)
  const maxR = Math.max(1, ...rowCount)
  const cands: RoomBarrierDebugV1[] = []

  for (let i = 1; i < gw - 1; i++) {
    const c = colCount[i]!
    if (c < 2) continue
    if (c > maxC * 0.39) continue
    if (!(c < colCount[i - 1]! && c < colCount[i + 1]!)) continue
    let j0 = gh
    let j1 = -1
    for (let j = 0; j < gh; j++) {
      if (blobMask[idx(i, j, gw)]) {
        j0 = Math.min(j0, j)
        j1 = Math.max(j1, j)
      }
    }
    if (j1 <= j0) continue
    const cx = g.minX + (i + 0.5) * g.cell
    const yA = g.minY + (j0 + 0.5) * g.cell
    const yB = g.minY + (j1 + 0.5) * g.cell
    const mx = cx
    const my = (yA + yB) / 2
    if (!pointInPolygon(mx, my, blobPoly)) continue
    if (distToPolyBoundary(mx, my, unitPoly) < C1.interiorMargin) continue
    const narrow = (maxC - c) / maxC
    cands.push({ x1: cx, y1: yA, x2: cx, y2: yB, strength: clamp(0.44 + 0.22 * narrow, 0, 1), kind: "neck" })
  }

  for (let j = 1; j < gh - 1; j++) {
    const r = rowCount[j]!
    if (r < 2) continue
    if (r > maxR * 0.39) continue
    if (!(r < rowCount[j - 1]! && r < rowCount[j + 1]!)) continue
    let i0 = gw
    let i1 = -1
    for (let i = 0; i < gw; i++) {
      if (blobMask[idx(i, j, gw)]) {
        i0 = Math.min(i0, i)
        i1 = Math.max(i1, i)
      }
    }
    if (i1 <= i0) continue
    const cy = g.minY + (j + 0.5) * g.cell
    const xA = g.minX + (i0 + 0.5) * g.cell
    const xB = g.minX + (i1 + 0.5) * g.cell
    const mx = (xA + xB) / 2
    const my = cy
    if (!pointInPolygon(mx, my, blobPoly)) continue
    if (distToPolyBoundary(mx, my, unitPoly) < C1.interiorMargin) continue
    const narrow = (maxR - r) / maxR
    cands.push({ x1: xA, y1: cy, x2: xB, y2: cy, strength: clamp(0.44 + 0.22 * narrow, 0, 1), kind: "neck" })
  }

  cands.sort((a, b) => b.strength - a.strength)
  return cands.slice(0, C1.maxNeckBarriers)
}

/**
 * Debug-only: raster-split one blob using an explicit barrier list (shared by cleanup v1 and split refinement v2).
 */
export function tryRasterSplitOnBlob(
  blob: RoomCandidateV0,
  blobPoly: Pt[],
  blobArea: number,
  unitPoly: Pt[],
  unitArea: number,
  barriers: RoomBarrierDebugV1[],
  opts: {
    dilatePasses: number
    minSubFracUnitFactor: number
    minSubFracBlobFactor: number
    maxSubFracUnitOverride?: number
    source: RoomCandidateSourceV0
    idPrefix: string
  }
): RoomCandidateV0[] | null {
  if (barriers.length === 0) return null
  const bb = bboxOfPoly(blobPoly)
  const pad = Math.max(20, Math.min(bb.maxX - bb.minX, bb.maxY - bb.minY) * 0.03)
  const g = makeGrid(bb, pad)

  const blobMask = new Uint8Array(g.gw * g.gh)
  let blobCells = 0
  for (let j = 0; j < g.gh; j++) {
    for (let i = 0; i < g.gw; i++) {
      const c = cellCenterWorld(i, j, g)
      if (pointInPolygon(c.x, c.y, blobPoly)) {
        blobMask[idx(i, j, g.gw)] = 1
        blobCells++
      }
    }
  }
  if (blobCells < 12) return null

  const wall = new Uint8Array(g.gw * g.gh)
  const thick = 1
  for (const b of barriers) {
    drawSegOnGrid(wall, g, b.x1, b.y1, b.x2, b.y2, thick)
  }
  if (opts.dilatePasses > 0) dilate(wall, g.gw, g.gh, opts.dilatePasses)

  const splitMask = new Uint8Array(g.gw * g.gh)
  for (let j = 0; j < g.gh; j++) {
    for (let i = 0; i < g.gw; i++) {
      const id = idx(i, j, g.gw)
      if (blobMask[id] === 1 && wall[id] === 0) splitMask[id] = 1
    }
  }

  const { labels, count } = labelComponents(splitMask, g.gw, g.gh)
  const sizes = new Float64Array(count)
  for (let j = 0; j < g.gh; j++) {
    for (let i = 0; i < g.gw; i++) {
      const lab = labels[idx(i, j, g.gw)]
      if (lab < 0) continue
      sizes[lab] += g.cell * g.cell
    }
  }

  const minSubArea = Math.max(
    unitArea * C1.minSubFracUnit * opts.minSubFracUnitFactor,
    blobArea * C1.minSubFracBlob * opts.minSubFracBlobFactor
  )
  const maxSubArea = Math.min(
    unitArea * (opts.maxSubFracUnitOverride ?? C1.maxSubFracUnit),
    blobArea * C1.maxSubFracBlob
  )

  const validLabs: number[] = []
  for (let lab = 0; lab < count; lab++) {
    const ar = sizes[lab]!
    if (ar >= minSubArea && ar <= maxSubArea) validLabs.push(lab)
  }

  if (validLabs.length < 2) return null

  validLabs.sort((a, b) => sizes[b]! - sizes[a]!)

  const subs: RoomCandidateV0[] = []
  let idxSub = 0
  for (const lab of validLabs) {
    const poly = componentToHullPolygon(labels, lab, g.gw, g.gh, g, blobPoly)
    if (!poly || poly.length < 3) continue
    const area = polygonAbsArea(poly)
    if (area < minSubArea * 0.92 || area > maxSubArea * 1.05) continue
    const conf = clamp(
      0.3 + 0.14 * Math.min(1, barriers.length / 5) + 0.08 * (sizes[lab]! / blobArea),
      0.24,
      0.58
    )
    subs.push({
      id: `${opts.idPrefix}-${idxSub}`,
      polygon: poly,
      confidence: conf,
      source: opts.source,
      areaPt2: area,
      bbox: bboxOfPoly(poly),
    })
    idxSub++
  }

  if (subs.length < 2) return null
  return subs
}

function splitOneOversizedBlob(
  blob: RoomCandidateV0,
  blobPoly: Pt[],
  blobArea: number,
  unitPoly: Pt[],
  unitArea: number,
  primaryLayoutSegments: ExtractedLineSegment[],
  primaryLayoutCleanedIndices: readonly number[],
  hyps: ArchitecturalWallHypothesesDebugPayload,
  spans: GlobalStructuralSpansDebugPayload,
  textAnchors: Pt[]
): {
  subs: RoomCandidateV0[] | null
  applied: RoomBarrierDebugV1[]
  rejectedWeak: RoomBarrierDebugV1[]
} {
  const bb = bboxOfPoly(blobPoly)
  const pad = Math.max(20, Math.min(bb.maxX - bb.minX, bb.maxY - bb.minY) * 0.03)
  const g = makeGrid(bb, pad)

  const blobMask = new Uint8Array(g.gw * g.gh)
  let blobCells = 0
  for (let j = 0; j < g.gh; j++) {
    for (let i = 0; i < g.gw; i++) {
      const c = cellCenterWorld(i, j, g)
      if (pointInPolygon(c.x, c.y, blobPoly)) {
        blobMask[idx(i, j, g.gw)] = 1
        blobCells++
      }
    }
  }
  if (blobCells < 12) {
    return { subs: null, applied: [], rejectedWeak: [] }
  }

  const raw = collectBarrierCandidates(blobPoly, unitPoly, primaryLayoutSegments, primaryLayoutCleanedIndices, hyps, spans, textAnchors)
  raw.push(...neckBarriersFromBlobMask(blobMask, g, blobPoly, unitPoly))

  const rejectedWeak: RoomBarrierDebugV1[] = []
  const strong: RoomBarrierDebugV1[] = []
  for (const b of raw) {
    if (b.strength < C1.barrierWeakBelow) rejectedWeak.push(b)
    else strong.push(b)
  }

  if (strong.length === 0) {
    return { subs: null, applied: [], rejectedWeak }
  }

  const subs = tryRasterSplitOnBlob(blob, blobPoly, blobArea, unitPoly, unitArea, strong, {
    dilatePasses: C1.barrierDilatePasses,
    minSubFracUnitFactor: 0.85,
    minSubFracBlobFactor: 1,
    source: "cv_split",
    idPrefix: `cv-split-${blob.id}`,
  })

  if (!subs || subs.length < 2) {
    return { subs: null, applied: [], rejectedWeak: [...rejectedWeak, ...strong] }
  }

  return { subs, applied: strong, rejectedWeak }
}

export function roomCleanupV1IsOversized(c: RoomCandidateV0, unitArea: number): boolean {
  if (unitArea < 1e-6) return false
  const r = c.areaPt2 / unitArea
  if (c.source === "geometry") return r >= C1.oversizedFracGeo
  return r >= C1.oversizedFracCv
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

function filterTextHints(texts: ExtractedTextRun[], layoutBx: PlanBoundingBox): Pt[] {
  const out: Pt[] = []
  for (const t of texts) {
    const w = t.width ?? 12
    const h = t.height ?? 10
    const ax = t.x
    const ay = t.y
    const bx = t.x + w
    const by = t.y + h
    if (bx < layoutBx.minX || ax > layoutBx.maxX || by < layoutBx.minY || ay > layoutBx.maxY) continue
    out.push(textAnchor(t))
  }
  return out
}

export function buildPlanBodyRoomCandidatesCleanupV1(
  primaryLayoutBBox: PlanBoundingBox,
  primaryLayoutSegments: ExtractedLineSegment[],
  primaryLayoutCleanedIndices: readonly number[],
  wallHypothesesPlanOnly: ArchitecturalWallHypothesesDebugPayload,
  globalSpansPlanOnly: GlobalStructuralSpansDebugPayload,
  roomV0: PlanBodyRoomCandidatesV0Debug,
  unitPolygon: Pt[],
  unitBoundaryClosed: boolean,
  unitArea: number,
  textRunsForSplitHints?: ExtractedTextRun[]
): PlanBodyRoomCandidatesCleanupV1Debug {
  const notes: string[] = []
  const appliedBarriers: RoomBarrierDebugV1[] = []
  const rejectedWeakBarriers: RoomBarrierDebugV1[] = []
  const oversizedBlobPolygons: Array<{ parentId: string; polygon: Pt[] }> = []

  if (!unitBoundaryClosed || unitPolygon.length < 3) {
    notes.push("Room cleanup v1 skipped — unit boundary is not a closed polygon.")
    return {
      roomCandidateCount: roomV0.roomCandidateCount,
      oversizedBlobCount: 0,
      splitAppliedCount: 0,
      splitBarrierCount: 0,
      roomCandidates: roomV0.roomCandidates.slice(),
      appliedBarriers: [],
      rejectedWeakBarriers: [],
      oversizedBlobPolygons: [],
      roomCleanupStatement: "Room cleanup v1 skipped — need closed unit boundary.",
      notes,
    }
  }

  const textAnchors = filterTextHints(textRunsForSplitHints ?? [], primaryLayoutBBox)
  if (textAnchors.length) {
    notes.push(`Split hints: ${textAnchors.length} text anchor(s) in primary layout (position only; not labels).`)
  }

  const oversized = roomV0.roomCandidates.filter((c) => roomCleanupV1IsOversized(c, unitArea))
  const oversizedIds = new Set(oversized.map((c) => c.id))

  let splitAppliedCount = 0
  let splitBarrierCount = 0
  const outRooms: RoomCandidateV0[] = []

  for (const c of roomV0.roomCandidates) {
    if (!oversizedIds.has(c.id)) {
      outRooms.push(c)
      continue
    }

    oversizedBlobPolygons.push({ parentId: c.id, polygon: c.polygon.map((p) => ({ x: p.x, y: p.y })) })
    const blobPoly = c.polygon.map((p) => ({ x: p.x, y: p.y }))
    const blobArea = polygonAbsArea(blobPoly)
    const { subs, applied, rejectedWeak } = splitOneOversizedBlob(
      c,
      blobPoly,
      blobArea,
      unitPolygon,
      unitArea,
      primaryLayoutSegments,
      primaryLayoutCleanedIndices,
      wallHypothesesPlanOnly,
      globalSpansPlanOnly,
      textAnchors
    )
    rejectedWeakBarriers.push(...rejectedWeak)
    if (subs && subs.length >= 2) {
      outRooms.push(...subs)
      splitAppliedCount++
      splitBarrierCount += applied.length
      appliedBarriers.push(...applied)
      notes.push(
        `Split blob ${c.id} (${c.source}, ${((blobArea / unitArea) * 100).toFixed(1)}% of unit) → ${subs.length} sub-candidate(s); ${applied.length} barrier stroke(s).`
      )
    } else {
      outRooms.push(c)
      notes.push(
        `Oversized blob ${c.id} kept unsplit — insufficient strong barriers or components failed area gates (conservative).`
      )
    }
  }

  adjacencyHints(outRooms, 14)

  let statement = `Room cleanup v1: ${outRooms.length} candidate region(s); ${oversized.length} oversized blob(s) detected; ${splitAppliedCount} split(s) applied; ${splitBarrierCount} barrier stroke(s) used. Unlabeled; debug only.`
  if (oversized.length === 0) {
    statement = `Room cleanup v1: no oversized blobs vs unit (thresholds cv/fused ≥${(C1.oversizedFracCv * 100).toFixed(0)}% area, geometry ≥${(C1.oversizedFracGeo * 100).toFixed(0)}%). Candidates unchanged from v0.`
  }
  notes.push(
    "Ambiguity: barriers are heuristics; weak splits are rejected in favor of fewer, larger regions. Neck detection is grid-based and may miss diagonal partitions."
  )

  return {
    roomCandidateCount: outRooms.length,
    oversizedBlobCount: oversized.length,
    splitAppliedCount,
    splitBarrierCount,
    roomCandidates: outRooms,
    appliedBarriers,
    rejectedWeakBarriers,
    oversizedBlobPolygons,
    roomCleanupStatement: statement,
    notes,
  }
}

export interface BuildPlanBodyRoomCandidatesCleanupV1SvgOptions {
  pageBounds: PlanBoundingBox
  primaryLayoutBBox: PlanBoundingBox
  debug: PlanBodyRoomCandidatesCleanupV1Debug
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

export function buildPlanBodyRoomCandidatesCleanupV1SvgString(o: BuildPlanBodyRoomCandidatesCleanupV1SvgOptions): string {
  const pb = o.pageBounds
  const w = pb.maxX - pb.minX
  const h = pb.maxY - pb.minY
  const bx = o.primaryLayoutBBox
  const d = o.debug

  const unitPath = pathFromPoly(o.unitPolygon, o.unitBoundaryClosed)
  const unitStroke = `<path d="${escapeXml(unitPath)}" fill="none" stroke="rgba(0,80,40,0.95)" stroke-width="2.6" stroke-dasharray="8 5"/>`

  const faintBlobs = d.oversizedBlobPolygons
    .map((ob) => {
      const p = pathFromPoly(ob.polygon, true)
      return `<path d="${escapeXml(p)}" fill="rgba(80,80,200,0.07)" stroke="rgba(100,100,180,0.22)" stroke-width="0.9" stroke-dasharray="6 5"/>`
    })
    .join("\n")

  const weak = d.rejectedWeakBarriers
    .slice(0, 200)
    .map(
      (b) =>
        `<line x1="${b.x1.toFixed(2)}" y1="${b.y1.toFixed(2)}" x2="${b.x2.toFixed(2)}" y2="${b.y2.toFixed(2)}" stroke="rgba(160,160,170,0.35)" stroke-width="0.55" stroke-dasharray="2 3"/>`
    )
    .join("\n")

  const barriers = d.appliedBarriers
    .slice(0, 260)
    .map((b) => {
      const t = clamp(b.strength, 0, 1)
      const stroke = `rgba(${Math.round(200 + 40 * (1 - t))},${Math.round(60 + 80 * t)},40,0.88)`
      return `<line x1="${b.x1.toFixed(2)}" y1="${b.y1.toFixed(2)}" x2="${b.x2.toFixed(2)}" y2="${b.y2.toFixed(2)}" stroke="${stroke}" stroke-width="1.25"/>`
    })
    .join("\n")

  const rooms = d.roomCandidates
    .map((r) => {
      const p = pathFromPoly(r.polygon, true)
      const fill = fillForConfidence(r.confidence, 0.16)
      const dash = r.source === "cv_split" ? "0" : "4 3"
      const stroke =
        r.source === "cv_split" ? "rgba(20,130,120,0.82)" : r.source === "cv" ? "rgba(60,100,200,0.5)" : "rgba(90,90,110,0.45)"
      return `<path d="${escapeXml(p)}" fill="${fill}" stroke="${stroke}" stroke-width="1.35" stroke-dasharray="${dash}"/>`
    })
    .join("\n")

  const title = `Room candidates cleanup v1 — ${d.roomCandidateCount} region(s); oversized ${d.oversizedBlobCount}; splits ${d.splitAppliedCount}; barriers ${d.splitBarrierCount}`

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${pb.minX} ${pb.minY} ${w} ${h}" width="${Math.round(w)}" height="${Math.round(
    h
  )}">
<rect x="${pb.minX}" y="${pb.minY}" width="${w}" height="${h}" fill="white"/>
<text x="${pb.minX + 8}" y="${pb.minY + 14}" font-size="11" fill="#222" font-family="system-ui,sans-serif">${escapeXml(title)}</text>
<text x="${pb.minX + 8}" y="${pb.minY + 28}" font-size="8.5" fill="#444" font-family="system-ui,sans-serif">${escapeXml(
    d.roomCleanupStatement.slice(0, 260) + (d.roomCleanupStatement.length > 260 ? "…" : "")
  )}</text>
<text x="${pb.minX + 8}" y="${pb.minY + 42}" font-size="7.5" fill="#555" font-family="system-ui,sans-serif">Faint purple = oversized v0 blob; orange/red = applied split barriers; gray dash = weak/unused barrier candidates; teal solid = cv_split; fills by confidence.</text>
<g>${faintBlobs}</g>
<g>${weak}</g>
<g>${barriers}</g>
<g>${rooms}</g>
<g>${unitStroke}</g>
<rect x="${bx.minX}" y="${bx.minY}" width="${bx.maxX - bx.minX}" height="${bx.maxY - bx.minY}" fill="none" stroke="rgba(0,60,30,0.4)" stroke-width="1.2" stroke-dasharray="5 4"/>
</svg>`
}
