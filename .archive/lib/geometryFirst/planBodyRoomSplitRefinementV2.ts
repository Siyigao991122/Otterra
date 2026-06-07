/**
 * Debug-only **room split refinement v2**: group weak/nearby barriers into families and try
 * family-level raster splits (incl. H+V) so oversized blobs can separate without per-segment strength gates.
 */

import type { ArchitecturalWallHypothesesDebugPayload } from "@/lib/geometryFirst/architecturalWallHypotheses"
import {
  collectBarrierCandidates,
  neckBarriersFromBlobMask,
  roomCleanupV1IsOversized,
  tryRasterSplitOnBlob,
  type RoomBarrierDebugV1,
  type RoomBarrierKindV1,
} from "@/lib/geometryFirst/planBodyRoomCandidatesCleanupV1"
import type { ExtractedLineSegment, ExtractedTextRun, PlanBoundingBox } from "@/lib/geometryFirst/types"
import type { GlobalStructuralSpansDebugPayload } from "@/lib/geometryFirst/globalStructuralSpans"
import type { PlanBodyRoomCandidatesCleanupV1Debug } from "@/lib/geometryFirst/planBodyRoomCandidatesCleanupV1"
import type { PlanBodyRoomCandidatesV0Debug, RoomCandidateV0 } from "@/lib/geometryFirst/planBodyRoomCandidatesV0"

type Pt = { x: number; y: number }

const V2 = {
  yBandPt: 13,
  xBandPt: 13,
  overlapPadPt: 8,
  maxFamiliesPerAxis: 10,
  maxProposals: 36,
  dilatePasses: 1,
  minSubFracUnitFactor: 0.72,
  minSubFracBlobFactor: 0.78,
  minRegions: 2,
  maxRegions: 5,
  /** Prefer2–4 regions in scoring. */
  idealRegions: 3,
  minInsideUnitFrac: 0.82,
  familyMinMembers: 2,
  familyMinStrengthSum: 0.92,
  minDistinctKinds: 2,
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

function barrierAxis(b: RoomBarrierDebugV1): "horizontal" | "vertical" | null {
  const dx = Math.abs(b.x2 - b.x1)
  const dy = Math.abs(b.y2 - b.y1)
  if (dx < 1e-6 && dy < 1e-6) return null
  if (dy <= dx * 0.22) return "horizontal"
  if (dx <= dy * 0.22) return "vertical"
  return null
}

function xOverlap(a0: number, a1: number, b0: number, b1: number, pad: number): boolean {
  const loA = Math.min(a0, a1) - pad
  const hiA = Math.max(a0, a1) + pad
  const loB = Math.min(b0, b1) - pad
  const hiB = Math.max(b0, b1) + pad
  return !(hiA < loB || hiB < loA)
}

function yOverlap(a0: number, a1: number, b0: number, b1: number, pad: number): boolean {
  return xOverlap(a0, a1, b0, b1, pad)
}

export interface RoomBarrierFamilyV2 {
  id: string
  orientation: "horizontal" | "vertical"
  xMin: number
  xMax: number
  yMin: number
  yMax: number
  memberCount: number
  combinedStrength: number
  distinctKindCount: number
  kinds: RoomBarrierKindV1[]
  members: RoomBarrierDebugV1[]
}

export interface RoomSplitProposalDebugV2 {
  id: string
  kind: "horizontal" | "vertical" | "hv"
  familyIds: string[]
  /** Pre-raster heuristic score (for debug ordering). */
  priorScore: number
}

export interface RejectedSplitProposalV2 extends RoomSplitProposalDebugV2 {
  reason: string
}

export interface PlanBodyRoomSplitRefinementV2Debug {
  roomCandidateCount: number
  splitProposalCount: number
  acceptedSplitCount: number
  barrierFamilyCount: number
  roomCandidates: RoomCandidateV0[]
  acceptedBarrierFamilies: RoomBarrierFamilyV2[]
  rejectedSplitProposals: RejectedSplitProposalV2[]
  allBarrierFamilies: RoomBarrierFamilyV2[]
  oversizedBlobParentIds: string[]
  /** Original oversized regions before v2 split (faint SVG underlay). */
  oversizedBlobPolygons: Array<{ parentId: string; polygon: Pt[] }>
  roomSplitRefinementStatement: string
  notes: string[]
}

function unionBbox(members: RoomBarrierDebugV1[]): { xMin: number; xMax: number; yMin: number; yMax: number } {
  let xMin = Infinity
  let xMax = -Infinity
  let yMin = Infinity
  let yMax = -Infinity
  for (const m of members) {
    xMin = Math.min(xMin, m.x1, m.x2)
    xMax = Math.max(xMax, m.x1, m.x2)
    yMin = Math.min(yMin, m.y1, m.y2)
    yMax = Math.max(yMax, m.y1, m.y2)
  }
  if (!Number.isFinite(xMin)) return { xMin: 0, xMax: 1, yMin: 0, yMax: 1 }
  return { xMin, xMax, yMin, yMax }
}

function buildFamilies(
  orientation: "horizontal" | "vertical",
  barriers: RoomBarrierDebugV1[],
  idPrefix: string
): RoomBarrierFamilyV2[] {
  const items = barriers.filter((b) => barrierAxis(b) === orientation)
  if (items.length === 0) return []

  const n = items.length
  const parent = Array.from({ length: n }, (_, i) => i)

  function find(i: number): number {
    if (parent[i] !== i) parent[i] = find(parent[i]!)
    return parent[i]!
  }

  function unite(a: number, b: number): void {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[ra] = rb
  }

  for (let i = 0; i < n; i++) {
    const bi = items[i]!
    const yMi = (bi.y1 + bi.y2) / 2
    const xMi = (bi.x1 + bi.x2) / 2
    const xi0 = Math.min(bi.x1, bi.x2)
    const xi1 = Math.max(bi.x1, bi.x2)
    const yi0 = Math.min(bi.y1, bi.y2)
    const yi1 = Math.max(bi.y1, bi.y2)
    for (let j = i + 1; j < n; j++) {
      const bj = items[j]!
      const yMj = (bj.y1 + bj.y2) / 2
      const xMj = (bj.x1 + bj.x2) / 2
      const xj0 = Math.min(bj.x1, bj.x2)
      const xj1 = Math.max(bj.x1, bj.x2)
      const yj0 = Math.min(bj.y1, bj.y2)
      const yj1 = Math.max(bj.y1, bj.y2)
      if (orientation === "horizontal") {
        if (Math.abs(yMi - yMj) <= V2.yBandPt && xOverlap(xi0, xi1, xj0, xj1, V2.overlapPadPt)) unite(i, j)
      } else {
        if (Math.abs(xMi - xMj) <= V2.xBandPt && yOverlap(yi0, yi1, yj0, yj1, V2.overlapPadPt)) unite(i, j)
      }
    }
  }

  const groups = new Map<number, RoomBarrierDebugV1[]>()
  for (let i = 0; i < n; i++) {
    const r = find(i)
    const arr = groups.get(r) ?? []
    arr.push(items[i]!)
    groups.set(r, arr)
  }

  const families: RoomBarrierFamilyV2[] = []
  let fid = 0
  for (const members of groups.values()) {
    const bb = unionBbox(members)
    const combinedStrength = members.reduce((s, m) => s + m.strength, 0)
    const kinds = [...new Set(members.map((m) => m.kind))]
    families.push({
      id: `${idPrefix}${orientation[0]}-fam-${fid++}`,
      orientation,
      xMin: bb.xMin,
      xMax: bb.xMax,
      yMin: bb.yMin,
      yMax: bb.yMax,
      memberCount: members.length,
      combinedStrength,
      distinctKindCount: kinds.length,
      kinds,
      members: members.slice(0, 48),
    })
  }

  families.sort((a, b) => familyHeuristicScore(b) - familyHeuristicScore(a))
  return families.slice(0, V2.maxFamiliesPerAxis * 2)
}

export function familyHeuristicScore(f: RoomBarrierFamilyV2): number {
  return (
    Math.min(2.8, f.combinedStrength) * 0.42 +
    f.memberCount * 0.09 +
    f.distinctKindCount * 0.11 +
    Math.min(1, (f.xMax - f.xMin + f.yMax - f.yMin) / 400) * 0.08
  )
}

export function familyPassesEvidenceGate(f: RoomBarrierFamilyV2): boolean {
  return (
    f.memberCount >= V2.familyMinMembers ||
    f.combinedStrength >= V2.familyMinStrengthSum ||
    f.distinctKindCount >= V2.minDistinctKinds
  )
}

export function mergeBarriersFromFamilies(families: RoomBarrierFamilyV2[]): RoomBarrierDebugV1[] {
  const out: RoomBarrierDebugV1[] = []
  const seen = new Set<string>()
  for (const f of families) {
    for (const m of f.members) {
      const key = `${m.x1.toFixed(2)},${m.y1.toFixed(2)},${m.x2.toFixed(2)},${m.y2.toFixed(2)},${m.kind}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(m)
    }
  }
  return out
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

function textSeparationScore(subs: RoomCandidateV0[], textAnchors: Pt[]): number {
  if (textAnchors.length < 2) return 0
  const counts = new Map<number, number>()
  for (const t of textAnchors) {
    let hit = -1
    for (let i = 0; i < subs.length; i++) {
      if (pointInPolygon(t.x, t.y, subs[i]!.polygon)) {
        hit = i
        break
      }
    }
    if (hit < 0) continue
    counts.set(hit, (counts.get(hit) ?? 0) + 1)
  }
  if (counts.size < 2) return 0
  let occupied = 0
  for (const v of counts.values()) {
    if (v > 0) occupied++
  }
  return clamp(0.12 * (occupied - 1) + 0.04 * Math.min(textAnchors.length, 12), 0, 0.38)
}

function scoreSubs(
  subs: RoomCandidateV0[],
  blobArea: number,
  unitPoly: Pt[],
  textAnchors: Pt[],
  barrierCount: number,
  priorScore: number
): number {
  const k = subs.length
  let s = priorScore * 0.35
  s += 1.15 * k
  s -= Math.abs(k - V2.idealRegions) * 0.22
  const fracBlob = subs.map((r) => r.areaPt2 / blobArea)
  const tiny = fracBlob.filter((f) => f < 0.06).length
  s -= tiny * 0.55
  let minIn = 1
  for (const r of subs) {
    const fr = regionInsideUnitFraction(r.polygon, unitPoly)
    minIn = Math.min(minIn, fr)
    if (fr < V2.minInsideUnitFrac) s -= (V2.minInsideUnitFrac - fr) * 2.1
  }
  s += textSeparationScore(subs, textAnchors)
  s += Math.min(0.45, barrierCount * 0.018)
  if (minIn < 0.55) s -= 2
  return s
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

export function familiesBboxOverlapBlob(fams: RoomBarrierFamilyV2[], blobBb: PlanBoundingBox): boolean {
  return fams.every(
    (f) => !(f.xMax < blobBb.minX || f.xMin > blobBb.maxX || f.yMax < blobBb.minY || f.yMin > blobBb.maxY)
  )
}

export function buildPlanBodyRoomSplitRefinementV2(
  primaryLayoutBBox: PlanBoundingBox,
  primaryLayoutSegments: ExtractedLineSegment[],
  primaryLayoutCleanedIndices: readonly number[],
  wallHypothesesPlanOnly: ArchitecturalWallHypothesesDebugPayload,
  globalSpansPlanOnly: GlobalStructuralSpansDebugPayload,
  _roomV0: PlanBodyRoomCandidatesV0Debug,
  cleanupV1: PlanBodyRoomCandidatesCleanupV1Debug,
  unitPolygon: Pt[],
  unitBoundaryClosed: boolean,
  unitArea: number,
  textRunsForSplitHints?: ExtractedTextRun[]
): PlanBodyRoomSplitRefinementV2Debug {
  void _roomV0
  const notes: string[] = []
  const rejectedSplitProposals: RejectedSplitProposalV2[] = []

  if (!unitBoundaryClosed || unitPolygon.length < 3) {
    notes.push("Room split refinement v2 skipped — unit boundary is not closed.")
    return {
      roomCandidateCount: cleanupV1.roomCandidateCount,
      splitProposalCount: 0,
      acceptedSplitCount: 0,
      barrierFamilyCount: 0,
      roomCandidates: cleanupV1.roomCandidates.slice(),
      acceptedBarrierFamilies: [],
      rejectedSplitProposals: [],
      allBarrierFamilies: [],
      oversizedBlobParentIds: [],
      oversizedBlobPolygons: [],
      roomSplitRefinementStatement: "Room split refinement v2 skipped — need closed unit boundary.",
      notes,
    }
  }

  const textAnchors = filterTextHints(textRunsForSplitHints ?? [], primaryLayoutBBox)
  const oversizedFromCleanup = cleanupV1.roomCandidates.filter((c) => roomCleanupV1IsOversized(c, unitArea))

  if (oversizedFromCleanup.length === 0) {
    notes.push("Split refinement v2: no oversized blobs in cleanup v1 list — output equals cleanup v1.")
    return {
      roomCandidateCount: cleanupV1.roomCandidateCount,
      splitProposalCount: 0,
      acceptedSplitCount: 0,
      barrierFamilyCount: 0,
      roomCandidates: cleanupV1.roomCandidates.slice(),
      acceptedBarrierFamilies: [],
      rejectedSplitProposals: [],
      allBarrierFamilies: [],
      oversizedBlobParentIds: [],
      oversizedBlobPolygons: [],
      roomSplitRefinementStatement:
        "Room split refinement v2: no oversized blobs vs unit; candidates unchanged from cleanup v1.",
      notes,
    }
  }

  let outRooms: RoomCandidateV0[] = cleanupV1.roomCandidates.slice()
  let acceptedSplitCount = 0
  let acceptedBarrierFamilies: RoomBarrierFamilyV2[] = []
  let totalProposals = 0
  let allFamiliesMerged: RoomBarrierFamilyV2[] = []
  const oversizedBlobPolygons: Array<{ parentId: string; polygon: Pt[] }> = []

  for (const blob of oversizedFromCleanup) {
    const blobPoly = blob.polygon.map((p) => ({ x: p.x, y: p.y }))
    const blobArea = polygonAbsArea(blobPoly)
    const blobBb = bboxOfPoly(blobPoly)
    oversizedBlobPolygons.push({ parentId: blob.id, polygon: blobPoly.slice() })

    const raw = collectBarrierCandidates(
      blobPoly,
      unitPolygon,
      primaryLayoutSegments,
      primaryLayoutCleanedIndices,
      wallHypothesesPlanOnly,
      globalSpansPlanOnly,
      textAnchors
    )

    const bb = blobBb
    const pad = Math.max(20, Math.min(bb.maxX - bb.minX, bb.maxY - bb.minY) * 0.03)
    const w = bb.maxX - bb.minX + 2 * pad
    const h = bb.maxY - bb.minY + 2 * pad
    const cell = Math.max(1.1, Math.max(w, h) / 400)
    const gw = Math.max(8, Math.ceil(w / cell))
    const gh = Math.max(8, Math.ceil(h / cell))
    const minX = bb.minX - pad
    const minY = bb.minY - pad
    const blobMask = new Uint8Array(gw * gh)
    for (let j = 0; j < gh; j++) {
      for (let i = 0; i < gw; i++) {
        const cx = minX + (i + 0.5) * cell
        const cy = minY + (j + 0.5) * cell
        if (pointInPolygon(cx, cy, blobPoly)) blobMask[j * gw + i] = 1
      }
    }
    const gSpec = { minX, minY, cell, gw, gh }
    raw.push(...neckBarriersFromBlobMask(blobMask, gSpec, blobPoly, unitPolygon))

    const famIdPfx = `${blob.id}-`
    const hFams = buildFamilies("horizontal", raw, famIdPfx)
    const vFams = buildFamilies("vertical", raw, famIdPfx)
    allFamiliesMerged = [...allFamiliesMerged, ...hFams, ...vFams]

    const hCand = hFams.filter((f) => familyPassesEvidenceGate(f)).slice(0, V2.maxFamiliesPerAxis)
    const vCand = vFams.filter((f) => familyPassesEvidenceGate(f)).slice(0, V2.maxFamiliesPerAxis)

    const proposals: RoomSplitProposalDebugV2[] = []
    let pid = 0
    const pfx = `${blob.id}-`
    for (const hf of hCand) {
      const prior = familyHeuristicScore(hf)
      proposals.push({ id: `${pfx}p-${pid++}`, kind: "horizontal", familyIds: [hf.id], priorScore: prior })
    }
    for (const vf of vCand) {
      const prior = familyHeuristicScore(vf)
      proposals.push({ id: `${pfx}p-${pid++}`, kind: "vertical", familyIds: [vf.id], priorScore: prior })
    }
    for (const hf of hCand.slice(0, 5)) {
      for (const vf of vCand.slice(0, 5)) {
        if (!familiesBboxOverlapBlob([hf, vf], blobBb)) continue
        const prior = familyHeuristicScore(hf) + familyHeuristicScore(vf) + 0.15
        proposals.push({ id: `${pfx}p-${pid++}`, kind: "hv", familyIds: [hf.id, vf.id], priorScore: prior })
      }
    }

    proposals.sort((a, b) => b.priorScore - a.priorScore)
    const tryList = proposals.slice(0, V2.maxProposals)
    totalProposals += tryList.length

    const famById = new Map<string, RoomBarrierFamilyV2>()
    for (const f of [...hFams, ...vFams]) famById.set(f.id, f)

    let bestSubs: RoomCandidateV0[] | null = null
    let bestScore = -1e9
    let bestFams: RoomBarrierFamilyV2[] = []
    let bestProp: RoomSplitProposalDebugV2 | null = null
    const viable: Array<{ prop: RoomSplitProposalDebugV2; score: number }> = []

    for (const prop of tryList) {
      const fams = prop.familyIds.map((id) => famById.get(id)).filter(Boolean) as RoomBarrierFamilyV2[]
      if (fams.length !== prop.familyIds.length) {
        rejectedSplitProposals.push({ ...prop, reason: "missing family id" })
        continue
      }
      if (!familiesBboxOverlapBlob(fams, blobBb)) {
        rejectedSplitProposals.push({ ...prop, reason: "family bbox does not overlap blob" })
        continue
      }
      const barriers = mergeBarriersFromFamilies(fams)
      if (barriers.length < 2 && prop.kind === "hv") {
        rejectedSplitProposals.push({ ...prop, reason: "too few merged barriers for hv" })
        continue
      }

      const subs = tryRasterSplitOnBlob(blob, blobPoly, blobArea, unitPolygon, unitArea, barriers, {
        dilatePasses: V2.dilatePasses,
        minSubFracUnitFactor: V2.minSubFracUnitFactor,
        minSubFracBlobFactor: V2.minSubFracBlobFactor,
        source: "cv_split_v2",
        idPrefix: `cv-split2-${blob.id}`,
      })

      if (!subs) {
        rejectedSplitProposals.push({ ...prop, reason: "raster split failed (components or area gates)" })
        continue
      }
      if (subs.length < V2.minRegions || subs.length > V2.maxRegions) {
        rejectedSplitProposals.push({
          ...prop,
          reason: `region count ${subs.length} outside [${V2.minRegions},${V2.maxRegions}]`,
        })
        continue
      }

      let rejectUnit = false
      for (const r of subs) {
        if (regionInsideUnitFraction(r.polygon, unitPolygon) < V2.minInsideUnitFrac - 1e-6) {
          rejectedSplitProposals.push({ ...prop, reason: "subregion mostly outside unit" })
          rejectUnit = true
          break
        }
      }
      if (rejectUnit) continue

      const sc = scoreSubs(subs, blobArea, unitPolygon, textAnchors, barriers.length, prop.priorScore)
      viable.push({ prop, score: sc })
      if (sc > bestScore) {
        bestScore = sc
        bestSubs = subs
        bestFams = fams
        bestProp = prop
      }
    }

    for (const v of viable) {
      if (bestProp && v.prop.id === bestProp.id) continue
      rejectedSplitProposals.push({
        ...v.prop,
        reason: `not selected (score ${v.score.toFixed(2)} < best ${bestScore.toFixed(2)})`,
      })
    }

    if (bestSubs && bestSubs.length >= V2.minRegions && bestProp) {
      outRooms = outRooms.filter((c) => c.id !== blob.id)
      outRooms.push(...bestSubs)
      acceptedSplitCount++
      acceptedBarrierFamilies = [...acceptedBarrierFamilies, ...bestFams]
      notes.push(
        `Split refinement v2 accepted proposal ${bestProp.id} (${bestProp.kind}) on ${blob.id} → ${bestSubs.length} sub-region(s); score ${bestScore.toFixed(2)}.`
      )
    } else {
      notes.push(`Split refinement v2: no acceptable family-level split for ${blob.id} — keeping single blob.`)
    }
  }

  adjacencyHints(outRooms, 14)

  const statement = `Room split refinement v2: ${outRooms.length} candidate region(s); ${allFamiliesMerged.length} barrier families; ${totalProposals} proposal(s) tried; ${acceptedSplitCount} accepted. Grouped-barrier raster splits; debug only.`

  notes.push(
    "Ambiguity: families merge collinear evidence heuristically; HV proposals can over-cut — max region count and inside-unit checks limit damage."
  )

  return {
    roomCandidateCount: outRooms.length,
    splitProposalCount: totalProposals,
    acceptedSplitCount,
    barrierFamilyCount: allFamiliesMerged.length,
    roomCandidates: outRooms,
    acceptedBarrierFamilies,
    rejectedSplitProposals: rejectedSplitProposals.slice(-120),
    allBarrierFamilies: allFamiliesMerged,
    oversizedBlobParentIds: oversizedFromCleanup.map((b) => b.id),
    oversizedBlobPolygons,
    roomSplitRefinementStatement: statement,
    notes,
  }
}

export interface BuildPlanBodyRoomSplitRefinementV2SvgOptions {
  pageBounds: PlanBoundingBox
  primaryLayoutBBox: PlanBoundingBox
  debug: PlanBodyRoomSplitRefinementV2Debug
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

export function buildPlanBodyRoomSplitRefinementV2SvgString(o: BuildPlanBodyRoomSplitRefinementV2SvgOptions): string {
  const pb = o.pageBounds
  const w = pb.maxX - pb.minX
  const h = pb.maxY - pb.minY
  const bx = o.primaryLayoutBBox
  const d = o.debug

  const acceptedIds = new Set(d.acceptedBarrierFamilies.map((f) => f.id))

  const unitPath = pathFromPoly(o.unitPolygon, o.unitBoundaryClosed)
  const unitStroke = `<path d="${escapeXml(unitPath)}" fill="none" stroke="rgba(0,80,40,0.95)" stroke-width="2.6" stroke-dasharray="8 5"/>`

  const faintPaths = d.oversizedBlobPolygons
    .map((ob) => {
      const p = pathFromPoly(ob.polygon, true)
      return `<path d="${escapeXml(p)}" fill="rgba(100,100,210,0.06)" stroke="rgba(120,120,200,0.2)" stroke-width="0.85" stroke-dasharray="7 5"/>`
    })
    .join("\n")

  const familyBoxes = d.allBarrierFamilies
    .map((f) => {
      const accepted = acceptedIds.has(f.id)
      const stroke = accepted ? "rgba(200,50,20,0.95)" : f.orientation === "horizontal" ? "rgba(40,90,200,0.45)" : "rgba(160,40,160,0.48)"
      const sw = accepted ? 2.1 : 1.05
      const dash = accepted ? "0" : "4 3"
      const rw = f.xMax - f.xMin
      const rh = f.yMax - f.yMin
      return `<rect x="${f.xMin.toFixed(2)}" y="${f.yMin.toFixed(2)}" width="${Math.max(0.5, rw).toFixed(2)}" height="${Math.max(0.5, rh).toFixed(2)}" fill="none" stroke="${stroke}" stroke-width="${sw}" stroke-dasharray="${dash}"/>`
    })
    .join("\n")

  const familyMembers = d.allBarrierFamilies
    .flatMap((f) => f.members.slice(0, 24))
    .map((b) => {
      const stroke = "rgba(70,130,200,0.35)"
      return `<line x1="${b.x1.toFixed(2)}" y1="${b.y1.toFixed(2)}" x2="${b.x2.toFixed(2)}" y2="${b.y2.toFixed(2)}" stroke="${stroke}" stroke-width="0.65"/>`
    })
    .join("\n")

  const rejectedFamIds = new Set<string>()
  for (const r of d.rejectedSplitProposals.slice(0, 48)) {
    for (const fid of r.familyIds) {
      if (acceptedIds.has(fid)) continue
      rejectedFamIds.add(fid)
    }
  }
  const rejected = [...rejectedFamIds]
    .map((fid) => d.allBarrierFamilies.find((f) => f.id === fid))
    .filter(Boolean) as RoomBarrierFamilyV2[]

  const rejectedRects = rejected
    .map((f) => {
      const rw = f.xMax - f.xMin
      const rh = f.yMax - f.yMin
      return `<rect x="${f.xMin.toFixed(2)}" y="${f.yMin.toFixed(2)}" width="${Math.max(0.5, rw).toFixed(2)}" height="${Math.max(0.5, rh).toFixed(2)}" fill="rgba(180,180,190,0.04)" stroke="rgba(150,150,160,0.28)" stroke-width="0.6" stroke-dasharray="2 4"/>`
    })
    .join("\n")

  const rooms = d.roomCandidates
    .map((r) => {
      const p = pathFromPoly(r.polygon, true)
      const fill = fillForConfidence(r.confidence, 0.15)
      const dash = r.source === "cv_split_v2" ? "0" : r.source === "cv_split" ? "5 3" : "4 3"
      const stroke =
        r.source === "cv_split_v2"
          ? "rgba(10,120,100,0.9)"
          : r.source === "cv_split"
            ? "rgba(20,100,140,0.75)"
            : "rgba(70,70,90,0.5)"
      return `<path d="${escapeXml(p)}" fill="${fill}" stroke="${stroke}" stroke-width="1.35" stroke-dasharray="${dash}"/>`
    })
    .join("\n")

  const title = `Room split refinement v2 — ${d.roomCandidateCount} regions; families ${d.barrierFamilyCount}; proposals ${d.splitProposalCount}; accepted ${d.acceptedSplitCount}`

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${pb.minX} ${pb.minY} ${w} ${h}" width="${Math.round(w)}" height="${Math.round(
    h
  )}">
<rect x="${pb.minX}" y="${pb.minY}" width="${w}" height="${h}" fill="white"/>
<text x="${pb.minX + 8}" y="${pb.minY + 14}" font-size="11" fill="#222" font-family="system-ui,sans-serif">${escapeXml(title)}</text>
<text x="${pb.minX + 8}" y="${pb.minY + 28}" font-size="8.5" fill="#444" font-family="system-ui,sans-serif">${escapeXml(
    d.roomSplitRefinementStatement.slice(0, 260) + (d.roomSplitRefinementStatement.length > 260 ? "…" : "")
  )}</text>
<text x="${pb.minX + 8}" y="${pb.minY + 42}" font-size="7.5" fill="#555" font-family="system-ui,sans-serif">Blue/magenta boxes = barrier families (bold red = accepted); faint gray = rejected proposal families sample; green solid = cv_split_v2.</text>
<g>${faintPaths}</g>
<g>${rejectedRects}</g>
<g>${familyMembers}</g>
<g>${familyBoxes}</g>
<g>${rooms}</g>
<g>${unitStroke}</g>
<rect x="${bx.minX}" y="${bx.minY}" width="${bx.maxX - bx.minX}" height="${bx.maxY - bx.minY}" fill="none" stroke="rgba(0,60,30,0.4)" stroke-width="1.2" stroke-dasharray="5 4"/>
</svg>`
}
