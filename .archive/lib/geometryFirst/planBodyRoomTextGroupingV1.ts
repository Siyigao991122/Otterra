/**
 * Debug-only **major-label coverage recovery / text grouping v1**: cluster nearby PDF text runs into
 * multi-line / multi-token labels, then re-attribute to refined room candidates. Not semantic labeling.
 */

import type { PlanBodyRoomCandidateRefinementV1Debug } from "@/lib/geometryFirst/planBodyRoomCandidateRefinementV1"
import type { PlanBodyRoomSplitRefinementV3Debug } from "@/lib/geometryFirst/planBodyRoomSplitRefinementV3"
import type { RoomCandidateV0 } from "@/lib/geometryFirst/planBodyRoomCandidatesV0"
import type { ExtractedTextRun, PlanBoundingBox } from "@/lib/geometryFirst/types"
import {
  assignPlanBodyLayoutCenterToRefinedRoomV0,
  buildRegionInterpretationSummaryFromAssignmentsV0,
  classifyPlanTextAnchorKindV0,
  countRegionInterpretationFlagsV0,
  normalizePlanBodyRoomLabelV0,
  type RegionInterpretationRowV0,
  type RoomTextAttributionV0Debug,
  type TextAnchorKindV0,
} from "@/lib/geometryFirst/planBodyRoomTextAttributionV0"

type Pt = { x: number; y: number }

const G1 = {
  maxVerticalGapPt: 17,
  maxHorizontalGapPt: 36,
  /** Vertical stack: min horizontal overlap as fraction of narrower box width. */
  minXOverlapRatioStack: 0.11,
  /** Same text row: |Δcy| vs min height. */
  sameRowCyFrac: 0.52,
  maxOrphanAssignPt: 48,
  unitOutsideRejectPt: 22,
  maxJoinedChars: 96,
} as const

function textRunBbox(t: ExtractedTextRun): {
  minX: number
  maxX: number
  minY: number
  maxY: number
  w: number
  h: number
} {
  const w = t.width ?? 12
  const h = t.height ?? 10
  return { minX: t.x, maxX: t.x + w, minY: t.y, maxY: t.y + h, w, h }
}

function textCenter(t: ExtractedTextRun): Pt {
  const w = t.width ?? 12
  const h = t.height ?? 10
  return { x: t.x + w * 0.5, y: t.y + h * 0.5 }
}

function xOverlapRatio(
  ba: { minX: number; maxX: number; w: number },
  bb: { minX: number; maxX: number; w: number }
): number {
  const o = Math.max(0, Math.min(ba.maxX, bb.maxX) - Math.max(ba.minX, bb.minX))
  const denom = Math.max(1e-6, Math.min(ba.w, bb.w))
  return o / denom
}

/** Avoid gluing SQ FT / dimensions to room titles. */
function isLikelyNonRoomNumericFragment(s: string): boolean {
  const u = s.trim()
  if (u.length === 0) return true
  if (/^\d{1,2}$/.test(u)) {
    const n = parseInt(u, 10)
    if (n >= 1 && n <= 9) return false
    return true
  }
  if (/^[\d\s'"′″.-]+$/.test(u)) return true
  if (/^(SQ|SF|S\.?F\.?|FT|FEET)\b/i.test(u)) return true
  return false
}

function isRoomConnectorToken(s: string): boolean {
  const u = s.trim()
  if (u.length === 0 || u.length > 3) return false
  return /^[/\\|•·+&-]+$/.test(u)
}

function hasRoomNameStem(s: string): boolean {
  return /\b(BEDROOM|BED|LIVING|DINING|KITCHEN|FAMILY|STUDY|PRIMARY|MASTER|GREAT|SUN|LOFT|NOOK|DEN|OFFICE|REC|MEDIA|GAME|POWDER|BATH)\b/i.test(
    s
  )
}

function horizontalGapMergeOk(
  ba: ReturnType<typeof textRunBbox>,
  bb: ReturnType<typeof textRunBbox>,
  maxGap: number
): boolean {
  const cyA = (ba.minY + ba.maxY) / 2
  const cyB = (bb.minY + bb.maxY) / 2
  const hmin = Math.min(ba.maxY - ba.minY, bb.maxY - bb.minY)
  if (Math.abs(cyA - cyB) > G1.sameRowCyFrac * Math.max(hmin, 7)) return false
  if (ba.maxX <= bb.minX || bb.maxX <= ba.minX) {
    const [left, right] = ba.maxX <= bb.minX ? [ba, bb] : [bb, ba]
    const gap = right.minX - left.maxX
    return gap >= -5 && gap <= maxGap
  }
  const overlapX = Math.max(0, Math.min(ba.maxX, bb.maxX) - Math.max(ba.minX, bb.minX))
  return overlapX > 0.1 * Math.min(ba.w, bb.w)
}

function canMergePair(runs: ExtractedTextRun[], boxes: ReturnType<typeof textRunBbox>[], i: number, j: number): boolean {
  if (runs[i]!.pageIndex !== runs[j]!.pageIndex) return false
  const ti = (runs[i]!.text ?? "").trim()
  const tj = (runs[j]!.text ?? "").trim()
  const ba = boxes[i]!
  const bb = boxes[j]!

  const connI = isRoomConnectorToken(ti)
  const connJ = isRoomConnectorToken(tj)
  if (connI !== connJ) {
    const otherText = connI ? tj : ti
    if (hasRoomNameStem(otherText) && horizontalGapMergeOk(ba, bb, 28)) return true
  }

  const dimI = isLikelyNonRoomNumericFragment(ti)
  const dimJ = isLikelyNonRoomNumericFragment(tj)
  if (dimI !== dimJ) return false
  if (dimI && dimJ) {
    // keep dimension-only clusters separate from room stacks
    return false
  }

  const [upper, lower] = ba.minY <= bb.minY ? [ba, bb] : [bb, ba]
  const vgap = lower.minY - upper.maxY
  const stackOk =
    vgap >= -3 &&
    vgap <= G1.maxVerticalGapPt &&
    xOverlapRatio(upper, lower) >= G1.minXOverlapRatioStack

  const cyA = (ba.minY + ba.maxY) / 2
  const cyB = (bb.minY + bb.maxY) / 2
  const hmin = Math.min(ba.maxY - ba.minY, bb.maxY - bb.minY)
  const rowDy = Math.abs(cyA - cyB)
  const sameRow = rowDy <= G1.sameRowCyFrac * Math.max(hmin, 7)

  let horizOk = false
  if (ba.maxX <= bb.minX || bb.maxX <= ba.minX) {
    const [left, right] = ba.maxX <= bb.minX ? [ba, bb] : [bb, ba]
    const gap = right.minX - left.maxX
    horizOk = sameRow && gap >= -5 && gap <= G1.maxHorizontalGapPt
  } else if (sameRow) {
    const overlapX = Math.max(0, Math.min(ba.maxX, bb.maxX) - Math.max(ba.minX, bb.minX))
    horizOk = overlapX > 0.12 * Math.min(ba.w, bb.w)
  }

  return stackOk || horizOk
}

class UnionFind {
  readonly parent: number[]
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i)
  }
  find(i: number): number {
    if (this.parent[i] !== i) this.parent[i] = this.find(this.parent[i]!)
    return this.parent[i]!
  }
  union(a: number, b: number): void {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra !== rb) this.parent[rb] = ra
  }
}

export interface GroupedPlanTextLabelV1 {
  groupId: string
  /** Indices into the filtered `planBodyTextRuns` array used to build groups. */
  sourceRunIndices: number[]
  memberTexts: string[]
  joinedLabel: string
  normalizedLabel: string
  labelKind: TextAnchorKindV0
  centerX: number
  centerY: number
  pageIndex: number
  memberCount: number
}

export interface GroupedLabelToRegionAssignmentV1 {
  groupId: string
  memberTexts: string[]
  memberCount: number
  joinedLabel: string
  normalizedLabel: string
  labelKind: TextAnchorKindV0
  centerX: number
  centerY: number
  pageIndex: number
  assignedRegionId: string | null
  containedInPolygon: boolean
  distanceToAssignedRegionPt: number
}

export interface UnassignedGroupedLabelV1 {
  groupId: string
  memberTexts: string[]
  joinedLabel: string
  normalizedLabel: string
  labelKind: TextAnchorKindV0
  centerX: number
  centerY: number
  pageIndex: number
  reason: string
}

export interface RoomTextGroupingV1Debug {
  labelGroups: GroupedPlanTextLabelV1[]
  regionTextAssignmentsGrouped: Array<{ regionId: string; assignments: GroupedLabelToRegionAssignmentV1[] }>
  unassignedGroupedLabels: UnassignedGroupedLabelV1[]
  regionInterpretationSummary: RegionInterpretationRowV0[]
  likelyMajorRoomCount: number
  likelyMixedRegionCount: number
  likelyAuxiliarySpaceCount: number
  majorAssignmentCountVsV0: { v0: number; v1: number; delta: number }
  recoveredMajorGroupsCount: number
  groupedLabelTotal: number
  multiRunGroupCount: number
  groupingCoverageStatement: string
  notes: string[]
  /** Non-empty trimmed runs; `labelGroups[].sourceRunIndices` index into this array. */
  groupingSourceRuns: ExtractedTextRun[]
}

function buildLabelGroups(runs: ExtractedTextRun[]): GroupedPlanTextLabelV1[] {
  if (runs.length === 0) return []
  const boxes = runs.map(textRunBbox)
  const uf = new UnionFind(runs.length)
  for (let i = 0; i < runs.length; i++) {
    for (let j = i + 1; j < runs.length; j++) {
      if (canMergePair(runs, boxes, i, j)) uf.union(i, j)
    }
  }

  const roots = new Map<number, number[]>()
  for (let i = 0; i < runs.length; i++) {
    const r = uf.find(i)
    let arr = roots.get(r)
    if (!arr) {
      arr = []
      roots.set(r, arr)
    }
    arr.push(i)
  }

  const groups: GroupedPlanTextLabelV1[] = []
  for (const [root, idxs] of roots) {
    idxs.sort((a, b) => {
      const ba = boxes[a]!
      const bb = boxes[b]!
      if (Math.abs(ba.minY - bb.minY) > 2) return ba.minY - bb.minY
      return ba.minX - bb.minX
    })
    const memberTexts = idxs.map((k) => (runs[k]!.text ?? "").trim()).filter(Boolean)
    let joinedLabel = memberTexts.join(" ").replace(/\s+/g, " ").trim()
    if (joinedLabel.length > G1.maxJoinedChars) joinedLabel = joinedLabel.slice(0, G1.maxJoinedChars) + "…"
    const normalizedLabel = normalizePlanBodyRoomLabelV0(joinedLabel)
    const labelKind =
      normalizedLabel.length < 1 ? "unknown" : classifyPlanTextAnchorKindV0(normalizedLabel)

    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity
    let sx = 0,
      sy = 0
    for (const k of idxs) {
      const b = boxes[k]!
      minX = Math.min(minX, b.minX)
      minY = Math.min(minY, b.minY)
      maxX = Math.max(maxX, b.maxX)
      maxY = Math.max(maxY, b.maxY)
      const c = textCenter(runs[k]!)
      sx += c.x
      sy += c.y
    }
    const n = idxs.length
    const pageIndex = runs[idxs[0]!]!.pageIndex
    groups.push({
      groupId: `grp-${root}`,
      sourceRunIndices: idxs.slice(),
      memberTexts,
      joinedLabel,
      normalizedLabel,
      labelKind,
      centerX: sx / n,
      centerY: sy / n,
      pageIndex,
      memberCount: n,
    })
  }

  return groups
}

/** Debug / coverage recovery: run grouping union-find on an arbitrary run list (non-empty text only). */
export function buildPlanBodyTextLabelGroupsFromRunsV1(planBodyTextRuns: ExtractedTextRun[]): GroupedPlanTextLabelV1[] {
  const runs = planBodyTextRuns.filter((t) => (t.text ?? "").trim().length > 0)
  return buildLabelGroups(runs)
}

export function buildPlanBodyRoomTextGroupingV1(
  refinement: PlanBodyRoomCandidateRefinementV1Debug,
  splitV3: PlanBodyRoomSplitRefinementV3Debug,
  unitPolygon: Pt[],
  unitBoundaryClosed: boolean,
  planBodyTextRuns: ExtractedTextRun[],
  attributionV0?: RoomTextAttributionV0Debug
): RoomTextGroupingV1Debug {
  const notes: string[] = []
  const regions = refinement.refinedRoomCandidates

  const empty = (): RoomTextGroupingV1Debug => ({
    labelGroups: [],
    regionTextAssignmentsGrouped: [],
    unassignedGroupedLabels: [],
    regionInterpretationSummary: [],
    likelyMajorRoomCount: 0,
    likelyMixedRegionCount: 0,
    likelyAuxiliarySpaceCount: 0,
    majorAssignmentCountVsV0: { v0: 0, v1: 0, delta: 0 },
    recoveredMajorGroupsCount: 0,
    groupedLabelTotal: 0,
    multiRunGroupCount: 0,
    groupingCoverageStatement: "Text grouping v1 skipped.",
    notes,
    groupingSourceRuns: [],
  })

  if (!unitBoundaryClosed || unitPolygon.length < 3) {
    notes.push("Text grouping v1 skipped — unit boundary not closed.")
    return empty()
  }
  if (regions.length === 0) {
    notes.push("Text grouping v1: no refined room candidates.")
    return empty()
  }

  const runs = planBodyTextRuns.filter((t) => (t.text ?? "").trim().length > 0)
  const labelGroups = buildLabelGroups(runs)
  const multiRunGroupCount = labelGroups.filter((g) => g.memberCount > 1).length

  const assignments: GroupedLabelToRegionAssignmentV1[] = []
  const unassigned: UnassignedGroupedLabelV1[] = []

  for (const g of labelGroups) {
    if (g.normalizedLabel.length < 1) continue
    const resolved = assignPlanBodyLayoutCenterToRefinedRoomV0(
      g.centerX,
      g.centerY,
      unitPolygon,
      regions,
      G1.maxOrphanAssignPt,
      G1.unitOutsideRejectPt
    )
    if (resolved.unitRejected) {
      unassigned.push({
        groupId: g.groupId,
        memberTexts: g.memberTexts,
        joinedLabel: g.joinedLabel,
        normalizedLabel: g.normalizedLabel,
        labelKind: g.labelKind,
        centerX: g.centerX,
        centerY: g.centerY,
        pageIndex: g.pageIndex,
        reason: "group anchor outside unit boundary (brochure clutter)",
      })
      continue
    }
    if (!resolved.region) {
      unassigned.push({
        groupId: g.groupId,
        memberTexts: g.memberTexts,
        joinedLabel: g.joinedLabel,
        normalizedLabel: g.normalizedLabel,
        labelKind: g.labelKind,
        centerX: g.centerX,
        centerY: g.centerY,
        pageIndex: g.pageIndex,
        reason: `no region within ${G1.maxOrphanAssignPt}pt`,
      })
      continue
    }

    assignments.push({
      groupId: g.groupId,
      memberTexts: g.memberTexts,
      memberCount: g.memberCount,
      joinedLabel: g.joinedLabel,
      normalizedLabel: g.normalizedLabel,
      labelKind: g.labelKind,
      centerX: g.centerX,
      centerY: g.centerY,
      pageIndex: g.pageIndex,
      assignedRegionId: resolved.region.id,
      containedInPolygon: resolved.contained,
      distanceToAssignedRegionPt: resolved.distToRegion,
    })
  }

  const byRegion = new Map<string, GroupedLabelToRegionAssignmentV1[]>()
  for (const r of regions) byRegion.set(r.id, [])
  for (const a of assignments) {
    if (a.assignedRegionId) {
      const list = byRegion.get(a.assignedRegionId)
      if (list) list.push(a)
    }
  }

  const regionTextAssignmentsGrouped = regions.map((r) => ({
    regionId: r.id,
    assignments: byRegion.get(r.id) ?? [],
  }))

  const flatForInterp = assignments.map((a) => ({
    assignedRegionId: a.assignedRegionId,
    labelKind: a.labelKind,
    normalizedLabel: a.normalizedLabel,
  }))
  const regionInterpretationSummary = buildRegionInterpretationSummaryFromAssignmentsV0(regions, flatForInterp)
  const { likelyMajorRoomCount, likelyMixedRegionCount, likelyAuxiliarySpaceCount } =
    countRegionInterpretationFlagsV0(regionInterpretationSummary)

  let v0Major = 0
  if (attributionV0) {
    for (const row of attributionV0.regionTextAssignments) {
      v0Major += row.assignments.filter((x) => x.labelKind === "major_room").length
    }
  }
  const v1Major = assignments.filter((x) => x.labelKind === "major_room").length

  let recoveredMajorGroupsCount = 0
  for (const g of labelGroups) {
    if (g.memberCount < 2) continue
    if (g.labelKind !== "major_room") continue
    const soloAllNonMajor = g.memberTexts.every((m) => classifyPlanTextAnchorKindV0(normalizePlanBodyRoomLabelV0(m)) !== "major_room")
    if (soloAllNonMajor) recoveredMajorGroupsCount++
  }

  notes.push(
    `Runs ${runs.length} → ${labelGroups.length} group(s) (${multiRunGroupCount} multi-run); assigned ${assignments.length}; unassigned ${unassigned.length}. Major assignments v0=${v0Major} → v1=${v1Major} (Δ ${v1Major - v0Major}).`
  )
  notes.push(
    `Recovered major groups (multi-run where no single line was major): ${recoveredMajorGroupsCount}. Refined regions ${regions.length}; v3 region count ${splitV3.roomCandidateCount}.`
  )
  notes.push("Grouping uses proximity/overlap only; not OCR or final room names.")

  const groupingCoverageStatement = `Text grouping v1: ${labelGroups.length} label group(s), ${v1Major} major assignment(s) vs ${v0Major} in v0; ${recoveredMajorGroupsCount} multi-run major recovery(ies).`

  return {
    labelGroups,
    regionTextAssignmentsGrouped,
    unassignedGroupedLabels: unassigned,
    regionInterpretationSummary,
    likelyMajorRoomCount,
    likelyMixedRegionCount,
    likelyAuxiliarySpaceCount,
    majorAssignmentCountVsV0: { v0: v0Major, v1: v1Major, delta: v1Major - v0Major },
    recoveredMajorGroupsCount,
    groupedLabelTotal: labelGroups.length,
    multiRunGroupCount,
    groupingCoverageStatement,
    notes,
    groupingSourceRuns: runs,
  }
}

export interface BuildPlanBodyRoomTextGroupingV1SvgOptions {
  pageBounds: PlanBoundingBox
  primaryLayoutBBox: PlanBoundingBox
  grouping: RoomTextGroupingV1Debug
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

function groupUnionRect(g: GroupedPlanTextLabelV1, runs: ExtractedTextRun[]): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity
  let found = false
  for (const k of g.sourceRunIndices) {
    const t = runs[k]
    if (!t) continue
    const b = textRunBbox(t)
    minX = Math.min(minX, b.minX)
    minY = Math.min(minY, b.minY)
    maxX = Math.max(maxX, b.maxX)
    maxY = Math.max(maxY, b.maxY)
    found = true
  }
  if (!found) return null
  return { minX, minY, maxX, maxY }
}

export function buildPlanBodyRoomTextGroupingV1SvgString(o: BuildPlanBodyRoomTextGroupingV1SvgOptions): string {
  const pb = o.pageBounds
  const w = pb.maxX - pb.minX
  const h = pb.maxY - pb.minY
  const bx = o.primaryLayoutBBox
  const interp = new Map(o.grouping.regionInterpretationSummary.map((r) => [r.regionId, r]))

  const unitPath = pathFromPoly(o.unitPolygon, o.unitBoundaryClosed)
  const unitStroke = `<path d="${escapeXml(unitPath)}" fill="none" stroke="rgba(0,80,40,0.95)" stroke-width="2.4" stroke-dasharray="8 5"/>`

  const regionsSvg = o.refinedRoomCandidates
    .map((r) => {
      const p = pathFromPoly(r.polygon, true)
      const row = interp.get(r.id)
      const mixed = row?.likelyMixedRegion
      const auxOnly = row?.auxiliaryOnly
      let stroke = "rgba(20,90,75,0.92)"
      let sw = 1.45
      let dash = ""
      if (mixed) {
        stroke = "rgba(200,85,20,0.95)"
        sw = 2.7
        dash = ` stroke-dasharray="6 3"`
      } else if (auxOnly) {
        stroke = "rgba(120,60,160,0.88)"
        sw = 2.05
      }
      const fill = mixed ? "rgba(255,200,120,0.1)" : auxOnly ? "rgba(180,140,220,0.09)" : "rgba(40,130,100,0.09)"
      return `<path d="${escapeXml(p)}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${dash}/>`
    })
    .join("\n")

  const groupFrames: string[] = []
  for (const g of o.grouping.labelGroups) {
    if (g.memberCount < 2) continue
    const rect = groupUnionRect(g, o.grouping.groupingSourceRuns)
    if (!rect) continue
    groupFrames.push(
      `<rect x="${rect.minX.toFixed(2)}" y="${rect.minY.toFixed(2)}" width="${(rect.maxX - rect.minX).toFixed(2)}" height="${(rect.maxY - rect.minY).toFixed(
        2
      )}" fill="none" stroke="rgba(30,100,180,0.55)" stroke-width="0.9" stroke-dasharray="4 3"/>`
    )
  }

  const allAssigned = o.grouping.regionTextAssignmentsGrouped.flatMap((x) => x.assignments)
  const labelEls: string[] = []
  for (const a of allAssigned) {
    const isMaj = a.labelKind === "major_room"
    const isAux = a.labelKind === "auxiliary_space"
    const fill = isMaj ? "rgba(15,110,45,0.92)" : isAux ? "rgba(95,40,150,0.9)" : "rgba(70,70,80,0.85)"
    const rid = a.assignedRegionId ?? "?"
    const short = a.joinedLabel.length > 26 ? `${a.joinedLabel.slice(0, 24)}…` : a.joinedLabel
    const suffix = a.memberCount > 1 ? " ●" : ""
    const label = `[${rid}] ${short}${suffix}`
    labelEls.push(
      `<text x="${a.centerX.toFixed(2)}" y="${(a.centerY - 5).toFixed(2)}" font-size="7" fill="${fill}" font-family="system-ui,sans-serif" font-weight="600">${escapeXml(label)}</text>`
    )
    labelEls.push(
      `<circle cx="${a.centerX.toFixed(2)}" cy="${a.centerY.toFixed(2)}" r="${isMaj ? 2.5 : isAux ? 2 : 1.6}" fill="${fill}" opacity="0.32"/>`
    )
  }

  for (const u of o.grouping.unassignedGroupedLabels) {
    labelEls.push(
      `<text x="${u.centerX.toFixed(2)}" y="${(u.centerY - 8).toFixed(2)}" font-size="6.5" fill="rgba(160,50,50,0.9)" font-family="system-ui,sans-serif">${escapeXml(
        u.joinedLabel.length > 16 ? u.joinedLabel.slice(0, 14) + "…" : u.joinedLabel
      )}</text>`
    )
    labelEls.push(
      `<circle cx="${u.centerX.toFixed(2)}" cy="${u.centerY.toFixed(2)}" r="2" fill="none" stroke="rgba(180,50,50,0.75)" stroke-width="0.9"/>`
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

  const t = o.grouping
  const title = `Room text grouping v1 — groups ${t.groupedLabelTotal} (multi-run ${t.multiRunGroupCount}); majors ${t.majorAssignmentCountVsV0.v0}→${t.majorAssignmentCountVsV0.v1} (Δ${t.majorAssignmentCountVsV0.delta >= 0 ? "+" : ""}${t.majorAssignmentCountVsV0.delta}); recovered ${t.recoveredMajorGroupsCount}`

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${pb.minX} ${pb.minY} ${w} ${h}" width="${Math.round(w)}" height="${Math.round(
    h
  )}">
<rect x="${pb.minX}" y="${pb.minY}" width="${w}" height="${h}" fill="white"/>
<text x="${pb.minX + 8}" y="${pb.minY + 14}" font-size="11" fill="#222" font-family="system-ui,sans-serif">${escapeXml(title)}</text>
<text x="${pb.minX + 8}" y="${pb.minY + 28}" font-size="7.5" fill="#444" font-family="system-ui,sans-serif">Blue dashed boxes = multi-run groups; ● = merged label; green/purple/gray = major/aux/unknown; orange = mixed region.</text>
<g>${regionsSvg}</g>
<g>${groupFrames.join("\n")}</g>
<g>${annot.join("\n")}</g>
<g>${labelEls.join("\n")}</g>
<g>${unitStroke}</g>
<rect x="${bx.minX}" y="${bx.minY}" width="${bx.maxX - bx.minX}" height="${bx.maxY - bx.minY}" fill="none" stroke="rgba(0,60,30,0.35)" stroke-width="1.1" stroke-dasharray="5 4"/>
</svg>`
}
