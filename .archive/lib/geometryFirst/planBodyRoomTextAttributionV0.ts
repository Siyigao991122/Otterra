/**
 * Debug-only **room text attribution / hierarchical room typing v0**: map brochure text to refined
 * room candidates (major vs auxiliary vs unknown). Not final semantic labeling; production unchanged.
 */

import type { PlanBodyRoomCandidateRefinementV1Debug } from "@/lib/geometryFirst/planBodyRoomCandidateRefinementV1"
import type { PlanBodyRoomSplitRefinementV3Debug } from "@/lib/geometryFirst/planBodyRoomSplitRefinementV3"
import type { RoomCandidateV0 } from "@/lib/geometryFirst/planBodyRoomCandidatesV0"
import type { ExtractedTextRun, PlanBoundingBox } from "@/lib/geometryFirst/types"

type Pt = { x: number; y: number }

export type TextAnchorKindV0 = "major_room" | "auxiliary_space" | "unknown"

export interface TextToRegionAssignmentV0 {
  text: string
  normalizedLabel: string
  labelKind: TextAnchorKindV0
  centerX: number
  centerY: number
  pageIndex: number
  assignedRegionId: string | null
  containedInPolygon: boolean
  /** Distance to assigned region boundary (0 when inside). */
  distanceToAssignedRegionPt: number
}

export interface RegionTextAssignmentRowV0 {
  regionId: string
  assignments: TextToRegionAssignmentV0[]
}

export interface UnassignedTextAnchorV0 {
  text: string
  normalizedLabel: string
  labelKind: TextAnchorKindV0
  centerX: number
  centerY: number
  pageIndex: number
  reason: string
}

export interface RegionInterpretationRowV0 {
  regionId: string
  likelySingleRoom: boolean
  likelyMixedRegion: boolean
  auxiliaryOnly: boolean
  unknown: boolean
  assignedMajorCount: number
  assignedAuxiliaryCount: number
  assignedUnknownCount: number
  majorLabelExamples: string[]
  auxiliaryLabelExamples: string[]
 /** Short rationale for debug. */
  note: string
}

export interface RoomTextAttributionV0Debug {
  regionTextAssignments: RegionTextAssignmentRowV0[]
  unassignedTextAnchors: UnassignedTextAnchorV0[]
  regionInterpretationSummary: RegionInterpretationRowV0[]
  likelyMajorRoomCount: number
  likelyMixedRegionCount: number
  likelyAuxiliarySpaceCount: number
  notes: string[]
}

const T0 = {
  maxOrphanAssignPt: 48,
  minNormLen: 1,
} as const

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x))
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

function pointToPolygonDist(px: number, py: number, poly: Pt[]): { inside: boolean; dist: number } {
  if (poly.length < 2) return { inside: false, dist: 1e9 }
  const inside = pointInPolygon(px, py, poly)
  if (inside) return { inside: true, dist: 0 }
  let d = Infinity
  const n = poly.length
  for (let i = 0; i < n; i++) {
    const p = poly[i]!
    const q = poly[(i + 1) % n]!
    d = Math.min(d, pointToSegDist(px, py, p.x, p.y, q.x, q.y))
  }
  return { inside: false, dist: d }
}

function textCenter(t: ExtractedTextRun): Pt {
  const w = t.width ?? 12
  const h = t.height ?? 10
  return { x: t.x + w * 0.5, y: t.y + h * 0.5 }
}

/** Normalized brochure string for keyword typing (shared with text grouping v1). */
export function normalizePlanBodyRoomLabelV0(s: string): string {
  return s
    .toUpperCase()
    .replace(/[/\\|]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[.,;:'"]/g, "")
    .trim()
}

/**
 * Heuristic typing: auxiliary patterns win over broad "ROOM" / bedroom when bath/closet context.
 */
export function classifyPlanTextAnchorKindV0(normalized: string): TextAnchorKindV0 {
  const u = normalized
  if (u.length < T0.minNormLen) return "unknown"

  if (
    /\bPRIMARY\s+BATH\b|\bMASTER\s+BATH\b|\bPRIM(?:ARY)?\.?\s*BATH\b|\bFULL\s+BATH\b|\bHALF\s+BATH\b|\bENSUITE\b|\bEN[\s-]?SUITE\b/i.test(
      u
    )
  ) {
    return "auxiliary_space"
  }
  if (
    /\bBATH(?:ROOM)?\b|\bPOWDER\b|\bPWDR\b|\bW\.?\s*I\.?\s*C\.?\b|\bWIC\b|\bWALK[\s-]?IN\b|\bCLOSET\b|\bCL\b|\bPANTRY\b|\bLAUNDRY\b|\bLDRY\b|\bMUD(?:ROOM)?\b|\bFOYER\b|\bVESTIBULE\b|\bHALL(?:WAY)?\b|\bLINEN\b|\bSTORAGE\b|\bUTILITY\b|\bW\/C\b|\bWC\b/i.test(
      u
    )
  ) {
    return "auxiliary_space"
  }

  if (
    /\bBEDROOM\b|\bMASTER\b|\bPRIMARY\s+BED\b|\bPRIMARY\s+BEDROOM\b|\bBR\s*\d+\b|\bLIVING\b|\bDINING\b|\bGREAT\s+ROOM\b|\bFAMILY\s+ROOM\b|\bKITCHEN\b|\bSTUDY\b|\bDEN\b|\bOFFICE\b|\bLOFT\b|\bSUNROOM\b|\bBREAKFAST\b|\bNOOK\b|\bREC(?:REATION)?\s+ROOM\b|\bMEDIA\b|\bGAME\s+ROOM\b/i.test(
      u
    )
  ) {
    return "major_room"
  }

  if (/\bROOM\b|\bAREA\b|\bZONE\b/i.test(u) && u.length <= 14) return "unknown"

  return "unknown"
}

function pickContainingRegion(cx: number, cy: number, regions: RoomCandidateV0[]): RoomCandidateV0 | null {
  const hits: RoomCandidateV0[] = []
  for (const r of regions) {
    if (pointInPolygon(cx, cy, r.polygon)) hits.push(r)
  }
  if (hits.length === 0) return null
  if (hits.length === 1) return hits[0]!
  hits.sort((a, b) => a.areaPt2 - b.areaPt2)
  return hits[0]!
}

function pickNearestRegion(cx: number, cy: number, regions: RoomCandidateV0[]): { r: RoomCandidateV0; dist: number } | null {
  let best: { r: RoomCandidateV0; dist: number } | null = null
  for (const r of regions) {
    const { dist } = pointToPolygonDist(cx, cy, r.polygon)
    if (!best || dist < best.dist) best = { r, dist }
  }
  return best
}

export function interpretPlanBodyRoomRegionFlagsV0(
  majors: string[],
  aux: string[],
  unks: string[]
): Omit<RegionInterpretationRowV0, "regionId" | "majorLabelExamples" | "auxiliaryLabelExamples" | "note"> {
  const m = majors.length
  const a = aux.length
  const u = unks.length
  const total = m + a + u

  let likelySingleRoom = false
  let likelyMixedRegion = false
  let auxiliaryOnly = false
  let unknown = false

  if (total === 0) {
    unknown = true
  } else if (m >= 2) {
    likelyMixedRegion = true
  } else if (m === 1) {
    likelySingleRoom = true
  } else if (m === 0 && a > 0) {
    auxiliaryOnly = true
  } else {
    unknown = true
  }

  return {
    likelySingleRoom,
    likelyMixedRegion,
    auxiliaryOnly,
    unknown,
    assignedMajorCount: m,
    assignedAuxiliaryCount: a,
    assignedUnknownCount: u,
  }
}

export interface PlanBodyTextAssignmentForInterpretationV0 {
  assignedRegionId: string | null
  labelKind: TextAnchorKindV0
  normalizedLabel: string
}

/** Resolve a layout-space point to a refined room (same rules as attribution v0). */
export function assignPlanBodyLayoutCenterToRefinedRoomV0(
  cx: number,
  cy: number,
  unitPolygon: Pt[],
  regions: RoomCandidateV0[],
  maxOrphanPt: number,
  unitOutsideRejectPt: number
): { region: RoomCandidateV0 | null; contained: boolean; distToRegion: number; unitRejected: boolean } {
  const insideUnit = pointInPolygon(cx, cy, unitPolygon)
  if (!insideUnit) {
    const nearU = pointToPolygonDist(cx, cy, unitPolygon)
    if (nearU.dist > unitOutsideRejectPt) {
      return { region: null, contained: false, distToRegion: 0, unitRejected: true }
    }
  }

  let region = pickContainingRegion(cx, cy, regions)
  let contained = region != null
  let distToR = 0

  if (!region) {
    const near = pickNearestRegion(cx, cy, regions)
    if (near && near.dist <= maxOrphanPt) {
      region = near.r
      contained = false
      distToR = near.dist
    }
  }

  if (region && contained) {
    const d = pointToPolygonDist(cx, cy, region.polygon)
    distToR = d.dist
  }

  return { region, contained, distToRegion: distToR, unitRejected: false }
}

export function buildRegionInterpretationSummaryFromAssignmentsV0(
  regions: RoomCandidateV0[],
  flat: PlanBodyTextAssignmentForInterpretationV0[]
): RegionInterpretationRowV0[] {
  const byRegion = new Map<string, PlanBodyTextAssignmentForInterpretationV0[]>()
  for (const r of regions) byRegion.set(r.id, [])
  for (const a of flat) {
    if (a.assignedRegionId) {
      const list = byRegion.get(a.assignedRegionId)
      if (list) list.push(a)
    }
  }

  return regions.map((r) => {
    const list = byRegion.get(r.id) ?? []
    const majors = list.filter((x) => x.labelKind === "major_room").map((x) => x.normalizedLabel)
    const aux = list.filter((x) => x.labelKind === "auxiliary_space").map((x) => x.normalizedLabel)
    const unks = list.filter((x) => x.labelKind === "unknown").map((x) => x.normalizedLabel)
    const base = interpretPlanBodyRoomRegionFlagsV0(majors, aux, unks)
    let note = ""
    if (base.likelyMixedRegion) note = `${base.assignedMajorCount} major labels — coarse region likely spans multiple named spaces.`
    else if (base.likelySingleRoom) note = "Single major label (plus optional auxiliary) — may match one brochure room."
    else if (base.auxiliaryOnly) note = "Only bath/closet/hall-type labels — not a full room polygon by name."
    else if (base.unknown) note = list.length === 0 ? "No text assigned." : "Labels unclear or non-room wording."

    return {
      regionId: r.id,
      ...base,
      majorLabelExamples: [...new Set(majors)].slice(0, 8),
      auxiliaryLabelExamples: [...new Set(aux)].slice(0, 8),
      note,
    }
  })
}

export function countRegionInterpretationFlagsV0(rows: RegionInterpretationRowV0[]): {
  likelyMajorRoomCount: number
  likelyMixedRegionCount: number
  likelyAuxiliarySpaceCount: number
} {
  let likelyMajorRoomCount = 0
  let likelyMixedRegionCount = 0
  let likelyAuxiliarySpaceCount = 0
  for (const row of rows) {
    if (row.likelySingleRoom) likelyMajorRoomCount++
    if (row.likelyMixedRegion) likelyMixedRegionCount++
    if (row.auxiliaryOnly) likelyAuxiliarySpaceCount++
  }
  return { likelyMajorRoomCount, likelyMixedRegionCount, likelyAuxiliarySpaceCount }
}

/**
 * @param planBodyTextRuns — e.g. `deriveMainPlanBody` `primaryLayoutTextBoxes` (centers inside primary layout).
 */
export function buildPlanBodyRoomTextAttributionV0(
  refinement: PlanBodyRoomCandidateRefinementV1Debug,
  splitV3: PlanBodyRoomSplitRefinementV3Debug,
  unitPolygon: Pt[],
  unitBoundaryClosed: boolean,
  planBodyTextRuns: ExtractedTextRun[]
): RoomTextAttributionV0Debug {
  const notes: string[] = []
  const regions = refinement.refinedRoomCandidates

  if (!unitBoundaryClosed || unitPolygon.length < 3) {
    notes.push("Room text attribution v0 skipped — unit boundary not closed.")
    return {
      regionTextAssignments: [],
      unassignedTextAnchors: [],
      regionInterpretationSummary: [],
      likelyMajorRoomCount: 0,
      likelyMixedRegionCount: 0,
      likelyAuxiliarySpaceCount: 0,
      notes,
    }
  }

  if (regions.length === 0) {
    notes.push("Room text attribution v0: no refined room candidates.")
    return {
      regionTextAssignments: [],
      unassignedTextAnchors: [],
      regionInterpretationSummary: [],
      likelyMajorRoomCount: 0,
      likelyMixedRegionCount: 0,
      likelyAuxiliarySpaceCount: 0,
      notes,
    }
  }

  const layoutTexts = planBodyTextRuns
  const assignments: TextToRegionAssignmentV0[] = []
  const unassigned: UnassignedTextAnchorV0[] = []

  for (const t of layoutTexts) {
    const raw = (t.text ?? "").trim()
    if (!raw) continue
    const norm = normalizePlanBodyRoomLabelV0(raw)
    if (norm.length < T0.minNormLen) continue
    const kind = classifyPlanTextAnchorKindV0(norm)
    const c = textCenter(t)

    const resolved = assignPlanBodyLayoutCenterToRefinedRoomV0(
      c.x,
      c.y,
      unitPolygon,
      regions,
      T0.maxOrphanAssignPt,
      22
    )
    if (resolved.unitRejected) {
      unassigned.push({
        text: raw,
        normalizedLabel: norm,
        labelKind: kind,
        centerX: c.x,
        centerY: c.y,
        pageIndex: t.pageIndex,
        reason: "anchor outside unit boundary (brochure clutter)",
      })
      continue
    }
    if (!resolved.region) {
      unassigned.push({
        text: raw,
        normalizedLabel: norm,
        labelKind: kind,
        centerX: c.x,
        centerY: c.y,
        pageIndex: t.pageIndex,
        reason: `no region within ${T0.maxOrphanAssignPt}pt`,
      })
      continue
    }

    const region = resolved.region
    const contained = resolved.contained
    const distToR = resolved.distToRegion

    assignments.push({
      text: raw,
      normalizedLabel: norm,
      labelKind: kind,
      centerX: c.x,
      centerY: c.y,
      pageIndex: t.pageIndex,
      assignedRegionId: region.id,
      containedInPolygon: contained,
      distanceToAssignedRegionPt: distToR,
    })
  }

  const byRegion = new Map<string, TextToRegionAssignmentV0[]>()
  for (const r of regions) byRegion.set(r.id, [])
  for (const a of assignments) {
    if (a.assignedRegionId) {
      const list = byRegion.get(a.assignedRegionId)
      if (list) list.push(a)
    }
  }

  const regionTextAssignments: RegionTextAssignmentRowV0[] = regions.map((r) => ({
    regionId: r.id,
    assignments: byRegion.get(r.id) ?? [],
  }))

  const regionInterpretationSummary = buildRegionInterpretationSummaryFromAssignmentsV0(
    regions,
    assignments.map((a) => ({
      assignedRegionId: a.assignedRegionId,
      labelKind: a.labelKind,
      normalizedLabel: a.normalizedLabel,
    }))
  )
  const { likelyMajorRoomCount, likelyMixedRegionCount, likelyAuxiliarySpaceCount } =
    countRegionInterpretationFlagsV0(regionInterpretationSummary)

  notes.push(
    `Refined regions: ${regions.length} (v3 had ${splitV3.roomCandidateCount}); layout texts considered: ${layoutTexts.length}; assigned: ${assignments.length}; unassigned: ${unassigned.length}.`
  )
  if (splitV3.textSpreadSummary) {
    const ts = splitV3.textSpreadSummary
    notes.push(
      `v3 text spread (context): anchorsUsed=${ts.anchorsUsed}, regionsWithAnchors=${ts.regionsWithAnchors}, dominantFrac=${ts.dominantRegionAnchorFrac.toFixed(2)}.`
    )
  }
  notes.push(
    "Typing is keyword-heuristic on brochure strings; coarse regions are not final room polygons. PRIMARY BATH / WIC / PWDR are auxiliary, not main room zones."
  )

  return {
    regionTextAssignments,
    unassignedTextAnchors: unassigned,
    regionInterpretationSummary,
    likelyMajorRoomCount,
    likelyMixedRegionCount,
    likelyAuxiliarySpaceCount,
    notes,
  }
}

export interface BuildPlanBodyRoomTextAttributionV0SvgOptions {
  pageBounds: PlanBoundingBox
  primaryLayoutBBox: PlanBoundingBox
  attribution: RoomTextAttributionV0Debug
  refinedRoomCandidates: RoomCandidateV0[]
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

function centroid(poly: Pt[]): Pt {
  let sx = 0
  let sy = 0
  for (const p of poly) {
    sx += p.x
    sy += p.y
  }
  const n = Math.max(1, poly.length)
  return { x: sx / n, y: sy / n }
}

export function buildPlanBodyRoomTextAttributionV0SvgString(o: BuildPlanBodyRoomTextAttributionV0SvgOptions): string {
  const pb = o.pageBounds
  const w = pb.maxX - pb.minX
  const h = pb.maxY - pb.minY
  const bx = o.primaryLayoutBBox
  const interp = new Map(o.attribution.regionInterpretationSummary.map((r) => [r.regionId, r]))

  const unitPath = pathFromPoly(o.unitPolygon, o.unitBoundaryClosed)
  const unitStroke = `<path d="${escapeXml(unitPath)}" fill="none" stroke="rgba(0,80,40,0.95)" stroke-width="2.4" stroke-dasharray="8 5"/>`

  const regionsSvg = o.refinedRoomCandidates
    .map((r) => {
      const p = pathFromPoly(r.polygon, true)
      const row = interp.get(r.id)
      const mixed = row?.likelyMixedRegion
      const auxOnly = row?.auxiliaryOnly
      let stroke = "rgba(20,90,75,0.92)"
      let sw = 1.5
      let dash = ""
      if (mixed) {
        stroke = "rgba(200,85,20,0.95)"
        sw = 2.8
        dash = ` stroke-dasharray="6 3"`
      } else if (auxOnly) {
        stroke = "rgba(120,60,160,0.88)"
        sw = 2.1
      }
      const fill = mixed ? "rgba(255,200,120,0.12)" : auxOnly ? "rgba(180,140,220,0.1)" : "rgba(40,130,100,0.1)"
      return `<path d="${escapeXml(p)}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${dash}/>`
    })
    .join("\n")

  const allAssigned = o.attribution.regionTextAssignments.flatMap((x) => x.assignments)
  const labelEls: string[] = []
  for (const a of allAssigned) {
    const isMaj = a.labelKind === "major_room"
    const isAux = a.labelKind === "auxiliary_space"
    const fill = isMaj ? "rgba(15,110,45,0.92)" : isAux ? "rgba(95,40,150,0.9)" : "rgba(70,70,80,0.85)"
    const rid = a.assignedRegionId ?? "?"
    const short = a.text.length > 22 ? `${a.text.slice(0, 20)}…` : a.text
    const label = `[${rid}] ${short}`
    const yOff = isMaj ? -4 : isAux ? 10 : 3
    labelEls.push(
      `<text x="${a.centerX.toFixed(2)}" y="${(a.centerY + yOff).toFixed(2)}" font-size="7" fill="${fill}" font-family="system-ui,sans-serif" font-weight="600">${escapeXml(label)}</text>`
    )
    labelEls.push(
      `<circle cx="${a.centerX.toFixed(2)}" cy="${a.centerY.toFixed(2)}" r="${isMaj ? 2.4 : isAux ? 2 : 1.6}" fill="${fill}" opacity="0.35"/>`
    )
  }

  for (const u of o.attribution.unassignedTextAnchors) {
    labelEls.push(
      `<text x="${u.centerX.toFixed(2)}" y="${(u.centerY - 6).toFixed(2)}" font-size="6.5" fill="rgba(160,50,50,0.9)" font-family="system-ui,sans-serif">(${escapeXml(u.text.length > 18 ? u.text.slice(0, 16) + "…" : u.text)})</text>`
    )
    labelEls.push(
      `<circle cx="${u.centerX.toFixed(2)}" cy="${u.centerY.toFixed(2)}" r="1.8" fill="none" stroke="rgba(180,50,50,0.75)" stroke-width="0.9"/>`
    )
  }

  const annot: string[] = []
  for (const r of o.refinedRoomCandidates) {
    const row = interp.get(r.id)
    if (!row?.likelyMixedRegion) continue
    const c = centroid(r.polygon)
    annot.push(
      `<text x="${c.x.toFixed(2)}" y="${c.y.toFixed(2)}" font-size="9" fill="rgba(200,70,15,0.95)" font-family="system-ui,sans-serif" font-weight="700">MIXED</text>`
    )
  }

  const title = `Room text attribution v0 — majors ${o.attribution.likelyMajorRoomCount}, mixed ${o.attribution.likelyMixedRegionCount}, aux-only regions ${o.attribution.likelyAuxiliarySpaceCount}`

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${pb.minX} ${pb.minY} ${w} ${h}" width="${Math.round(w)}" height="${Math.round(
    h
  )}">
<rect x="${pb.minX}" y="${pb.minY}" width="${w}" height="${h}" fill="white"/>
<text x="${pb.minX + 8}" y="${pb.minY + 14}" font-size="11" fill="#222" font-family="system-ui,sans-serif">${escapeXml(title)}</text>
<text x="${pb.minX + 8}" y="${pb.minY + 28}" font-size="7.5" fill="#444" font-family="system-ui,sans-serif">Green labels = major room; purple = auxiliary (bath/WIC/PWDR); gray = unknown; orange outline = likely mixed region; red ring = unassigned.</text>
<g>${regionsSvg}</g>
<g>${annot.join("\n")}</g>
<g>${labelEls.join("\n")}</g>
<g>${unitStroke}</g>
<rect x="${bx.minX}" y="${bx.minY}" width="${bx.maxX - bx.minX}" height="${bx.maxY - bx.minY}" fill="none" stroke="rgba(0,60,30,0.35)" stroke-width="1.1" stroke-dasharray="5 4"/>
</svg>`
}
