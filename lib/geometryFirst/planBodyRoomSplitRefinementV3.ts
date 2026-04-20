/**
 * Debug-only **room split refinement v3**: family-guided **direct cut bands** on the blob mask plus
 * looser area gates and stronger region-quality / text-spread acceptance (after v2; not production).
 */

import {
  roomCleanupV1IsOversized,
  tryRasterSplitOnBlob,
} from "@/lib/geometryFirst/planBodyRoomCandidatesCleanupV1"
import type { ExtractedTextRun, PlanBoundingBox } from "@/lib/geometryFirst/types"
import type { RoomCandidateV0, RoomCandidateSourceV0 } from "@/lib/geometryFirst/planBodyRoomCandidatesV0"
import {
  familiesBboxOverlapBlob,
  familyHeuristicScore,
  familyPassesEvidenceGate,
  mergeBarriersFromFamilies,
  type PlanBodyRoomSplitRefinementV2Debug,
  type RoomBarrierFamilyV2,
  type RoomSplitProposalDebugV2,
} from "@/lib/geometryFirst/planBodyRoomSplitRefinementV2"

type Pt = { x: number; y: number }

const V3 = {
  gridTarget: 420,
  maxProposals: 12,
  maxHCand: 5,
  maxVCand: 5,
  hvSlice: 4,
  dustAreaFrac: 0.028,
  maxTinyTotalFracOfBlob: 0.16,
  maxLargestFracOfBlob: 0.89,
  minRegions: 2,
  maxRegions: 4,
  maxBboxToAreaRatio: 7.35,
  minInsideUnitSampleFrac: 0.68,
  minSignificantFrac: 0.017,
  idealRegions: 2.5,
} as const

export interface CutBandDebugV3 {
  orientation: "horizontal" | "vertical"
  xMin: number
  xMax: number
  yMin: number
  yMax: number
}

export interface RegionQualitySummaryV3 {
  regionCount: number
  largestRegionFracOfBlob: number
  tinyFragmentFracOfBlob: number
  worstBboxToAreaRatio: number
  minRegionInsideUnitSampleFrac: number
}

export interface TextSpreadSummaryV3 {
  anchorsUsed: number
  regionsWithAnchors: number
  dominantRegionAnchorFrac: number
  spreadScore: number
}

export interface RejectedProposalOverlayV3 {
  proposalId: string
  kind: "horizontal" | "vertical" | "hv"
  cutBands: CutBandDebugV3[]
}

export interface PlanBodyRoomSplitRefinementV3Debug {
  roomCandidateCount: number
  acceptedSplitCount: number
  splitExecutionModeSummary: string
  acceptedBarrierFamilies: RoomBarrierFamilyV2[]
  roomCandidates: RoomCandidateV0[]
  regionQualitySummary?: RegionQualitySummaryV3
  textSpreadSummary?: TextSpreadSummaryV3
  acceptedCutBands: CutBandDebugV3[]
  topRejectedProposals: RejectedProposalOverlayV3[]
  oversizedBlobPolygons: Array<{ parentId: string; polygon: Pt[] }>
  /** Text anchors used for spread scoring (split support only). */
  textAnchorsSvg: Pt[]
  /** v2 barrier families for oversized blob(s), for faint SVG overlay. */
  barrierFamilyOverlays: RoomBarrierFamilyV2[]
  roomSplitRefinementStatement: string
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
  const cell = Math.max(1.05, Math.max(w, h) / V3.gridTarget)
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

function regionInsideUnitFraction(poly: Pt[], unitPoly: Pt[]): number {
  const bb = bboxOfPoly(poly)
  const samples = 7
  let inU = 0
  let tot = 0
  for (let a = 0; a < samples; a++) {
    for (let b = 0; b < samples; b++) {
      const t1 = (a + 0.5) / samples
      const t2 = (b + 0.5) / samples
      const x = bb.minX + t1 * (bb.maxX - bb.minX)
      const y = bb.minY + t2 * (bb.maxY - bb.minY)
      if (!pointInPolygon(x, y, poly)) continue
      tot++
      if (pointInPolygon(x, y, unitPoly)) inU++
    }
  }
  if (tot === 0) return 0
  return inU / tot
}

function textAnchor(t: ExtractedTextRun): Pt {
  const w = t.width ?? 10
  const h = t.height ?? 8
  return { x: t.x + w * 0.5, y: t.y + h * 0.5 }
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

function computeTextSpread(subs: RoomCandidateV0[], textAnchors: Pt[]): TextSpreadSummaryV3 {
  if (textAnchors.length === 0) {
    return {
      anchorsUsed: 0,
      regionsWithAnchors: 0,
      dominantRegionAnchorFrac: 1,
      spreadScore: 0,
    }
  }
  const counts = new Map<number, number>()
  let used = 0
  for (const t of textAnchors) {
    let hit = -1
    for (let i = 0; i < subs.length; i++) {
      if (pointInPolygon(t.x, t.y, subs[i]!.polygon)) {
        hit = i
        break
      }
    }
    if (hit < 0) continue
    used++
    counts.set(hit, (counts.get(hit) ?? 0) + 1)
  }
  if (used === 0) {
    return {
      anchorsUsed: 0,
      regionsWithAnchors: 0,
      dominantRegionAnchorFrac: 1,
      spreadScore: 0,
    }
  }
  let maxC = 0
  let nonZero = 0
  for (const c of counts.values()) {
    if (c > 0) nonZero++
    maxC = Math.max(maxC, c)
  }
  const dom = maxC / used
  let spreadScore = 0
  if (nonZero >= 3) spreadScore += 0.42
  else if (nonZero >= 2) spreadScore += 0.24
  spreadScore += 0.38 * (1 - dom)
  if (dom > 0.74) spreadScore -= 0.55
  if (nonZero < 2 && textAnchors.length >= 3) spreadScore -= 0.2
  return {
    anchorsUsed: used,
    regionsWithAnchors: nonZero,
    dominantRegionAnchorFrac: dom,
    spreadScore: clamp(spreadScore, -0.8, 1.1),
  }
}

function buildCutBandsForFamilies(
  fams: RoomBarrierFamilyV2[],
  propKind: "horizontal" | "vertical" | "hv",
  g: GridSpec,
  blobBb: PlanBoundingBox
): CutBandDebugV3[] {
  const bands: CutBandDebugV3[] = []
  const padX = Math.max(24, (blobBb.maxX - blobBb.minX) * 0.02)
  const padY = Math.max(24, (blobBb.maxY - blobBb.minY) * 0.02)
  for (const f of fams) {
    if (propKind === "horizontal" && f.orientation !== "horizontal") continue
    if (propKind === "vertical" && f.orientation !== "vertical") continue
    if (f.orientation === "horizontal") {
      const yC = (f.yMin + f.yMax) / 2
      const halfThick = Math.max(11, (f.yMax - f.yMin) / 2 + g.cell * 2)
      bands.push({
        orientation: "horizontal",
        xMin: blobBb.minX - padX,
        xMax: blobBb.maxX + padX,
        yMin: yC - halfThick,
        yMax: yC + halfThick,
      })
    } else {
      const xC = (f.xMin + f.xMax) / 2
      const halfThick = Math.max(11, (f.xMax - f.xMin) / 2 + g.cell * 2)
      bands.push({
        orientation: "vertical",
        xMin: xC - halfThick,
        xMax: xC + halfThick,
        yMin: blobBb.minY - padY,
        yMax: blobBb.maxY + padY,
      })
    }
  }
  return bands
}

function applyCutBandsToWall(
  wall: Uint8Array,
  blobMask: Uint8Array,
  g: GridSpec,
  bands: CutBandDebugV3[]
): void {
  for (const band of bands) {
    if (band.orientation === "horizontal") {
      for (let j = 0; j < g.gh; j++) {
        const cy = g.minY + (j + 0.5) * g.cell
        if (cy < band.yMin || cy > band.yMax) continue
        for (let i = 0; i < g.gw; i++) {
          const id = idx(i, j, g.gw)
          if (blobMask[id]) wall[id] = 1
        }
      }
    } else {
      for (let i = 0; i < g.gw; i++) {
        const cx = g.minX + (i + 0.5) * g.cell
        if (cx < band.xMin || cx > band.xMax) continue
        for (let j = 0; j < g.gh; j++) {
          const id = idx(i, j, g.gw)
          if (blobMask[id]) wall[id] = 1
        }
      }
    }
  }
}

interface QualityResult {
  ok: boolean
  quality: RegionQualitySummaryV3
  reason?: string
}

function assessRegionQuality(subs: RoomCandidateV0[], blobArea: number, unitPoly: Pt[]): QualityResult {
  const fracs = subs.map((s) => s.areaPt2 / Math.max(blobArea, 1e-6))
  const tinyFrac = fracs.filter((f) => f < V3.dustAreaFrac * 1.15).reduce((a, b) => a + b, 0)

  const areas = subs.map((s) => s.areaPt2).sort((a, b) => b - a)
  const largestFrac = areas[0]! / blobArea
  let worstRatio = 0
  let minIn = 1
  for (const s of subs) {
    const bb = bboxOfPoly(s.polygon)
    const bboxA = Math.max(1, bb.maxX - bb.minX) * Math.max(1, bb.maxY - bb.minY)
    worstRatio = Math.max(worstRatio, bboxA / Math.max(1, s.areaPt2))
    minIn = Math.min(minIn, regionInsideUnitFraction(s.polygon, unitPoly))
  }

  const q: RegionQualitySummaryV3 = {
    regionCount: subs.length,
    largestRegionFracOfBlob: largestFrac,
    tinyFragmentFracOfBlob: tinyFrac,
    worstBboxToAreaRatio: worstRatio,
    minRegionInsideUnitSampleFrac: minIn,
  }

  if (subs.length < V3.minRegions || subs.length > V3.maxRegions) {
    return { ok: false, quality: q, reason: "region count" }
  }
  if (largestFrac > V3.maxLargestFracOfBlob) {
    return { ok: false, quality: q, reason: "largest region still dominates blob" }
  }
  if (tinyFrac > V3.maxTinyTotalFracOfBlob) {
    return { ok: false, quality: q, reason: "too much area in tiny fragments" }
  }
  if (worstRatio > V3.maxBboxToAreaRatio) {
    return { ok: false, quality: q, reason: "region too sliver-like (bbox/area)" }
  }
  if (minIn < V3.minInsideUnitSampleFrac) {
    return { ok: false, quality: q, reason: "subregion mostly outside unit" }
  }
  return { ok: true, quality: q }
}

function directCutToRooms(
  blob: RoomCandidateV0,
  blobPoly: Pt[],
  blobArea: number,
  unitPoly: Pt[],
  fams: RoomBarrierFamilyV2[],
  propKind: "horizontal" | "vertical" | "hv",
  blobBb: PlanBoundingBox
): {
  subs: RoomCandidateV0[] | null
  cutBands: CutBandDebugV3[]
  quality: RegionQualitySummaryV3 | null
} {
  const pad = Math.max(20, Math.min(blobBb.maxX - blobBb.minX, blobBb.maxY - blobBb.minY) * 0.03)
  const g = makeGrid(blobBb, pad)
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
  if (blobCells < 10) return { subs: null, cutBands: [], quality: null }

  const cutBands = buildCutBandsForFamilies(fams, propKind, g, blobBb)
  const wall = new Uint8Array(g.gw * g.gh)
  applyCutBandsToWall(wall, blobMask, g, cutBands)

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

  const comps: Array<{ lab: number; area: number }> = []
  for (let lab = 0; lab < count; lab++) {
    const ar = sizes[lab]!
    if (ar > 1e-6) comps.push({ lab, area: ar })
  }
  comps.sort((a, b) => b.area - a.area)
  const sigTh = blobArea * V3.minSignificantFrac
  const significant = comps.filter((c) => c.area >= sigTh)
  if (significant.length < V3.minRegions) return { subs: null, cutBands, quality: null }

  const take = significant.slice(0, V3.maxRegions)
  const takenLabs = new Set(take.map((t) => t.lab))
  let restArea = 0
  for (const c of comps) {
    if (!takenLabs.has(c.lab)) restArea += c.area
  }
  if (restArea > V3.maxTinyTotalFracOfBlob * blobArea * 1.05) {
    return { subs: null, cutBands, quality: null }
  }

  const subs: RoomCandidateV0[] = []
  let idxSub = 0
  for (const t of take) {
    const poly = componentToHullPolygon(labels, t.lab, g.gw, g.gh, g, blobPoly)
    if (!poly || poly.length < 3) continue
    const area = polygonAbsArea(poly)
    const conf = clamp(0.32 + 0.1 * (take.length / 4) + 0.06 * (t.area / blobArea), 0.26, 0.6)
    subs.push({
      id: `cv-split3-${blob.id}-${idxSub}`,
      polygon: poly,
      confidence: conf,
      source: "cv_split_v3" as RoomCandidateSourceV0,
      areaPt2: area,
      bbox: bboxOfPoly(poly),
    })
    idxSub++
  }

  if (subs.length < V3.minRegions) return { subs: null, cutBands, quality: null }

  const assess = assessRegionQuality(subs, blobArea, unitPoly)
  if (!assess.ok) return { subs: null, cutBands, quality: assess.quality }

  return { subs, cutBands, quality: assess.quality }
}

function proposalScore(subs: RoomCandidateV0[], blobArea: number, textAnchors: Pt[], prior: number): number {
  const ts = computeTextSpread(subs, textAnchors)
  const k = subs.length
  let s = prior * 0.28 + ts.spreadScore * 1.45
  s += 1.05 * k - Math.abs(k - V3.idealRegions) * 0.28
  const areas = subs.map((r) => r.areaPt2 / blobArea).sort((a, b) => b - a)
  s -= Math.max(0, areas[0]! - 0.72) * 1.2
  return s
}

function buildProposalsForBlob(
  blobId: string,
  allFamilies: RoomBarrierFamilyV2[],
  blobBb: PlanBoundingBox
): RoomSplitProposalDebugV2[] {
  const prefix = `${blobId}-`
  const local = allFamilies.filter((f) => f.id.startsWith(prefix))
  const hFams = local.filter((f) => f.orientation === "horizontal")
  const vFams = local.filter((f) => f.orientation === "vertical")
  const hCand = hFams
    .filter((f) => familyPassesEvidenceGate(f))
    .sort((a, b) => familyHeuristicScore(b) - familyHeuristicScore(a))
    .slice(0, V3.maxHCand)
  const vCand = vFams
    .filter((f) => familyPassesEvidenceGate(f))
    .sort((a, b) => familyHeuristicScore(b) - familyHeuristicScore(a))
    .slice(0, V3.maxVCand)

  const proposals: RoomSplitProposalDebugV2[] = []
  let pid = 0
  const pfx = `${blobId}-`
  for (const hf of hCand) {
    proposals.push({
      id: `${pfx}v3p-${pid++}`,
      kind: "horizontal",
      familyIds: [hf.id],
      priorScore: familyHeuristicScore(hf),
    })
  }
  for (const vf of vCand) {
    proposals.push({
      id: `${pfx}v3p-${pid++}`,
      kind: "vertical",
      familyIds: [vf.id],
      priorScore: familyHeuristicScore(vf),
    })
  }
  for (const hf of hCand.slice(0, V3.hvSlice)) {
    for (const vf of vCand.slice(0, V3.hvSlice)) {
      if (!familiesBboxOverlapBlob([hf, vf], blobBb)) continue
      proposals.push({
        id: `${pfx}v3p-${pid++}`,
        kind: "hv",
        familyIds: [hf.id, vf.id],
        priorScore: familyHeuristicScore(hf) + familyHeuristicScore(vf) + 0.12,
      })
    }
  }
  proposals.sort((a, b) => b.priorScore - a.priorScore)
  return proposals
}

function mergeV2PriorityProposals(
  blobId: string,
  splitV2: PlanBodyRoomSplitRefinementV2Debug,
  built: RoomSplitProposalDebugV2[]
): RoomSplitProposalDebugV2[] {
  const pfx = `${blobId}-`
  const fromV2 = splitV2.rejectedSplitProposals
    .filter((p) => p.id.startsWith(pfx))
    .filter(
      (p) =>
        p.reason.includes("raster split failed") ||
        p.reason.includes("area gates") ||
        p.reason.includes("outside unit")
    )
    .sort((a, b) => b.priorScore - a.priorScore)
    .slice(0, 5)

  const seen = new Set<string>()
  const out: RoomSplitProposalDebugV2[] = []
  for (const p of fromV2) {
    const key = `${p.kind}|${p.familyIds.slice().sort().join(",")}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      id: `${p.id}-v3prio`,
      kind: p.kind,
      familyIds: p.familyIds.slice(),
      priorScore: p.priorScore + 0.05,
    })
  }
  for (const p of built) {
    if (out.length >= V3.maxProposals) break
    const key = `${p.kind}|${p.familyIds.slice().sort().join(",")}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(p)
  }
  out.sort((a, b) => b.priorScore - a.priorScore)
  return out.slice(0, V3.maxProposals)
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

export function buildPlanBodyRoomSplitRefinementV3(
  primaryLayoutBBox: PlanBoundingBox,
  splitV2: PlanBodyRoomSplitRefinementV2Debug,
  unitPolygon: Pt[],
  unitBoundaryClosed: boolean,
  unitArea: number,
  textRunsForSplitHints?: ExtractedTextRun[]
): PlanBodyRoomSplitRefinementV3Debug {
  const notes: string[] = []
  const topRejected: RejectedProposalOverlayV3[] = []
  let modeParts: string[] = []

  if (!unitBoundaryClosed || unitPolygon.length < 3) {
    notes.push("Room split refinement v3 skipped — unit boundary is not closed.")
    return {
      roomCandidateCount: splitV2.roomCandidateCount,
      acceptedSplitCount: 0,
      splitExecutionModeSummary: "skipped (open or missing unit boundary)",
      acceptedBarrierFamilies: [],
      roomCandidates: splitV2.roomCandidates.slice(),
      acceptedCutBands: [],
      topRejectedProposals: [],
      oversizedBlobPolygons: splitV2.oversizedBlobPolygons.slice(),
      textAnchorsSvg: [],
      barrierFamilyOverlays: [],
      roomSplitRefinementStatement: "Room split refinement v3 skipped — need closed unit boundary.",
      notes,
    }
  }

  const textAnchors = filterTextHints(textRunsForSplitHints ?? [], primaryLayoutBBox)
  const barrierFamilyOverlays: RoomBarrierFamilyV2[] = []
  const oversized = splitV2.roomCandidates.filter((c) => roomCleanupV1IsOversized(c, unitArea))

  if (oversized.length === 0) {
    notes.push("Split refinement v3: no oversized blobs — pass-through from v2.")
    return {
      roomCandidateCount: splitV2.roomCandidateCount,
      acceptedSplitCount: 0,
      splitExecutionModeSummary: "no oversized blob vs unit; pass-through v2",
      acceptedBarrierFamilies: [],
      roomCandidates: splitV2.roomCandidates.slice(),
      acceptedCutBands: [],
      topRejectedProposals: [],
      oversizedBlobPolygons: splitV2.oversizedBlobPolygons.slice(),
      textAnchorsSvg: textAnchors.slice(0, 200),
      barrierFamilyOverlays: [],
      roomSplitRefinementStatement: "Room split refinement v3: no oversized region to refine; output matches v2.",
      notes,
    }
  }

  let outRooms = splitV2.roomCandidates.slice()
  let acceptedSplitCount = 0
  let acceptedFamilies: RoomBarrierFamilyV2[] = []
  let acceptedCutBands: CutBandDebugV3[] = []
  let regionQualitySummary: RegionQualitySummaryV3 | undefined
  let textSpreadSummary: TextSpreadSummaryV3 | undefined
  let directTries = 0
  let directOk = 0
  let rasterFallback = 0

  const famByIdGlobal = new Map<string, RoomBarrierFamilyV2>()
  for (const f of splitV2.allBarrierFamilies) famByIdGlobal.set(f.id, f)

  for (const blob of oversized) {
    const blobPoly = blob.polygon.map((p) => ({ x: p.x, y: p.y }))
    const blobArea = polygonAbsArea(blobPoly)
    const blobBb = bboxOfPoly(blobPoly)
    const prefix = `${blob.id}-`
    for (const f of splitV2.allBarrierFamilies) {
      if (f.id.startsWith(prefix)) barrierFamilyOverlays.push(f)
    }
    const tryList = mergeV2PriorityProposals(blob.id, splitV2, buildProposalsForBlob(blob.id, splitV2.allBarrierFamilies, blobBb))

    let bestSubs: RoomCandidateV0[] | null = null
    let bestScore = -1e9
    let bestFams: RoomBarrierFamilyV2[] = []
    let bestBands: CutBandDebugV3[] = []
    let bestQuality: RegionQualitySummaryV3 | null = null
    let usedRasterForBlob = false

    for (const prop of tryList) {
      const fams = prop.familyIds.map((id) => famByIdGlobal.get(id)).filter(Boolean) as RoomBarrierFamilyV2[]
      if (fams.length !== prop.familyIds.length) continue
      if (!familiesBboxOverlapBlob(fams, blobBb)) continue
      if (prop.kind === "hv" && mergeBarriersFromFamilies(fams).length < 1) continue

      directTries++
      const { subs, cutBands, quality } = directCutToRooms(blob, blobPoly, blobArea, unitPolygon, fams, prop.kind, blobBb)
      if (!subs || !quality) {
        if (topRejected.length < 4) {
          topRejected.push({
            proposalId: prop.id,
            kind: prop.kind,
            cutBands: buildCutBandsForFamilies(fams, prop.kind, makeGrid(blobBb, 20), blobBb),
          })
        }
        continue
      }
      directOk++
      const sc = proposalScore(subs, blobArea, textAnchors, prop.priorScore)
      if (sc > bestScore) {
        bestScore = sc
        bestSubs = subs
        bestFams = fams
        bestBands = cutBands
        bestQuality = quality
      }
    }

    if (!bestSubs || !bestQuality) {
      const top = tryList[0]
      if (top) {
        const fams = top.familyIds.map((id) => famByIdGlobal.get(id)).filter(Boolean) as RoomBarrierFamilyV2[]
        if (fams.length === top.familyIds.length) {
          const barriers = mergeBarriersFromFamilies(fams)
          const subsRb = tryRasterSplitOnBlob(blob, blobPoly, blobArea, unitPolygon, unitArea, barriers, {
            dilatePasses: 2,
            minSubFracUnitFactor: 0.52,
            minSubFracBlobFactor: 0.52,
            source: "cv_split_v3",
            idPrefix: `cv-split3-${blob.id}`,
          })
          if (subsRb && subsRb.length >= V3.minRegions && subsRb.length <= V3.maxRegions) {
            const aq = assessRegionQuality(subsRb, blobArea, unitPolygon)
            if (aq.ok) {
              bestSubs = subsRb
              bestFams = fams
              bestBands = buildCutBandsForFamilies(fams, top.kind, makeGrid(blobBb, 20), blobBb)
              bestQuality = aq.quality
              bestScore = proposalScore(subsRb, blobArea, textAnchors, top.priorScore)
              rasterFallback++
              usedRasterForBlob = true
            }
          }
        }
      }
    }

    if (bestSubs && bestQuality) {
      outRooms = outRooms.filter((c) => c.id !== blob.id)
      outRooms.push(...bestSubs)
      acceptedSplitCount++
      acceptedFamilies = [...acceptedFamilies, ...bestFams]
      acceptedCutBands = [...acceptedCutBands, ...bestBands]
      regionQualitySummary = bestQuality
      textSpreadSummary = computeTextSpread(bestSubs, textAnchors)
      notes.push(
        `Split refinement v3: accepted ${bestSubs.length} region(s) on ${blob.id} (score ${bestScore.toFixed(2)}); direct tries ${directTries}${usedRasterForBlob ? "; raster-fallback" : ""}.`
      )
    } else {
      notes.push(`Split refinement v3: no acceptable direct-cut or raster-fallback split for ${blob.id}.`)
      modeParts.push(`blob:${blob.id}:fail`)
    }
  }

  adjacencyHints(outRooms, 14)

  modeParts = [
    `direct-cut attempts=${directTries}`,
    `direct-ok-samples=${directOk}`,
    `raster-fallback=${rasterFallback}`,
    ...modeParts,
  ]
  const splitExecutionModeSummary = modeParts.join("; ")

  const statement = `Room split refinement v3: ${outRooms.length} candidate region(s); ${acceptedSplitCount} split(s) accepted. ${splitExecutionModeSummary}.`

  notes.push(
    "Ambiguity: direct bands are axis-aligned sweeps through the blob mask; diagonal rooms may remain merged. Text spread is a soft signal only."
  )

  return {
    roomCandidateCount: outRooms.length,
    acceptedSplitCount,
    splitExecutionModeSummary,
    acceptedBarrierFamilies: acceptedFamilies,
    roomCandidates: outRooms,
    regionQualitySummary,
    textSpreadSummary,
    acceptedCutBands,
    topRejectedProposals: topRejected.slice(0, 6),
    oversizedBlobPolygons: splitV2.oversizedBlobPolygons.slice(),
    textAnchorsSvg: textAnchors.slice(0, 200),
    barrierFamilyOverlays,
    roomSplitRefinementStatement: statement,
    notes,
  }
}

export interface BuildPlanBodyRoomSplitRefinementV3SvgOptions {
  pageBounds: PlanBoundingBox
  primaryLayoutBBox: PlanBoundingBox
  debug: PlanBodyRoomSplitRefinementV3Debug
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

export function buildPlanBodyRoomSplitRefinementV3SvgString(o: BuildPlanBodyRoomSplitRefinementV3SvgOptions): string {
  const pb = o.pageBounds
  const w = pb.maxX - pb.minX
  const h = pb.maxY - pb.minY
  const bx = o.primaryLayoutBBox
  const d = o.debug

  const unitPath = pathFromPoly(o.unitPolygon, o.unitBoundaryClosed)
  const unitStroke = `<path d="${escapeXml(unitPath)}" fill="none" stroke="rgba(0,80,40,0.95)" stroke-width="2.6" stroke-dasharray="8 5"/>`

  const faintBlob = d.oversizedBlobPolygons
    .map((ob) => {
      const p = pathFromPoly(ob.polygon, true)
      return `<path d="${escapeXml(p)}" fill="rgba(95,95,200,0.06)" stroke="rgba(110,110,190,0.2)" stroke-width="0.85" stroke-dasharray="7 5"/>`
    })
    .join("\n")

  const acceptedBands = d.acceptedCutBands
    .map((b) => {
      const rw = b.xMax - b.xMin
      const rh = b.yMax - b.yMin
      const fill =
        b.orientation === "horizontal" ? "rgba(255,120,40,0.14)" : "rgba(255,40,160,0.12)"
      const stroke = b.orientation === "horizontal" ? "rgba(220,80,20,0.92)" : "rgba(200,30,140,0.88)"
      return `<rect x="${b.xMin.toFixed(2)}" y="${b.yMin.toFixed(2)}" width="${Math.max(0.5, rw).toFixed(2)}" height="${Math.max(0.5, rh).toFixed(2)}" fill="${fill}" stroke="${stroke}" stroke-width="2.2"/>`
    })
    .join("\n")

  const faintRejected = d.topRejectedProposals
    .flatMap((r) => r.cutBands)
    .map((b) => {
      const rw = b.xMax - b.xMin
      const rh = b.yMax - b.yMin
      return `<rect x="${b.xMin.toFixed(2)}" y="${b.yMin.toFixed(2)}" width="${Math.max(0.5, rw).toFixed(2)}" height="${Math.max(0.5, rh).toFixed(2)}" fill="rgba(160,160,175,0.05)" stroke="rgba(140,140,155,0.32)" stroke-width="0.75" stroke-dasharray="3 4"/>`
    })
    .join("\n")

  const familyOverlayAll = d.barrierFamilyOverlays
    .slice(0, 40)
    .map((f) => {
      const rw = f.xMax - f.xMin
      const rh = f.yMax - f.yMin
      return `<rect x="${f.xMin.toFixed(2)}" y="${f.yMin.toFixed(2)}" width="${Math.max(0.5, rw).toFixed(2)}" height="${Math.max(0.5, rh).toFixed(2)}" fill="none" stroke="rgba(30,110,200,0.38)" stroke-width="0.85" stroke-dasharray="4 4"/>`
    })
    .join("\n")

  const familyAccepted = d.acceptedBarrierFamilies
    .map((f) => {
      const rw = f.xMax - f.xMin
      const rh = f.yMax - f.yMin
      return `<rect x="${f.xMin.toFixed(2)}" y="${f.yMin.toFixed(2)}" width="${Math.max(0.5, rw).toFixed(2)}" height="${Math.max(0.5, rh).toFixed(2)}" fill="none" stroke="rgba(20,80,180,0.72)" stroke-width="1.2" stroke-dasharray="6 3"/>`
    })
    .join("\n")

  const anchorDots = d.textAnchorsSvg
    .slice(0, 180)
    .map(
      (p) =>
        `<circle cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="2.2" fill="rgba(20,120,200,0.55)" stroke="rgba(10,70,140,0.65)" stroke-width="0.45"/>`
    )
    .join("\n")

  const rooms = d.roomCandidates
    .map((r) => {
      const p = pathFromPoly(r.polygon, true)
      const fill = fillForConfidence(r.confidence, 0.15)
      const stroke =
        r.source === "cv_split_v3" ? "rgba(8,110,95,0.92)" : r.source === "cv_split_v2" ? "rgba(15,130,115,0.75)" : "rgba(70,70,90,0.45)"
      const dash = r.source === "cv_split_v3" || r.source === "cv_split_v2" ? "0" : "4 3"
      return `<path d="${escapeXml(p)}" fill="${fill}" stroke="${stroke}" stroke-width="1.35" stroke-dasharray="${dash}"/>`
    })
    .join("\n")

  const title = `Room split refinement v3 — ${d.roomCandidateCount} regions; accepted ${d.acceptedSplitCount}`

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${pb.minX} ${pb.minY} ${w} ${h}" width="${Math.round(w)}" height="${Math.round(
    h
  )}">
<rect x="${pb.minX}" y="${pb.minY}" width="${w}" height="${h}" fill="white"/>
<text x="${pb.minX + 8}" y="${pb.minY + 14}" font-size="11" fill="#222" font-family="system-ui,sans-serif">${escapeXml(title)}</text>
<text x="${pb.minX + 8}" y="${pb.minY + 28}" font-size="8.5" fill="#444" font-family="system-ui,sans-serif">${escapeXml(
    d.roomSplitRefinementStatement.slice(0, 260) + (d.roomSplitRefinementStatement.length > 260 ? "…" : "")
  )}</text>
<text x="${pb.minX + 8}" y="${pb.minY + 42}" font-size="7.5" fill="#555" font-family="system-ui,sans-serif">${escapeXml(
    d.splitExecutionModeSummary.slice(0, 220) + (d.splitExecutionModeSummary.length > 220 ? "…" : "")
  )}</text>
<g>${faintBlob}</g>
<g>${faintRejected}</g>
<g>${familyOverlayAll}</g>
<g>${familyAccepted}</g>
<g>${anchorDots}</g>
<g>${acceptedBands}</g>
<g>${rooms}</g>
<g>${unitStroke}</g>
<rect x="${bx.minX}" y="${bx.minY}" width="${bx.maxX - bx.minX}" height="${bx.maxY - bx.minY}" fill="none" stroke="rgba(0,60,30,0.4)" stroke-width="1.2" stroke-dasharray="5 4"/>
</svg>`
}
