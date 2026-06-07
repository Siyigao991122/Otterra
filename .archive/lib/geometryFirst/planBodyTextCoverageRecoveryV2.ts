/**
 * Debug-only **plan-body text coverage recovery v2**: broaden which PDF text runs participate in grouping
 * so major room labels on the brochure are not dropped when their center falls outside `primaryLayoutBBox`.
 */

import { buildPlanBodyTextLabelGroupsFromRunsV1 } from "@/lib/geometryFirst/planBodyRoomTextGroupingV1"
import type { GroupedPlanTextLabelV1 } from "@/lib/geometryFirst/planBodyRoomTextGroupingV1"
import type { MainPlanBodyResult } from "@/lib/geometryFirst/mainPlanBody"
import type { ExtractedTextRun, PlanBoundingBox } from "@/lib/geometryFirst/types"

type Pt = { x: number; y: number }

const R2 = {
  primaryPadPt: 40,
  unitBboxPadPt: 72,
  nearUnitDistPt: 56,
  headerAbovePlanPt: 105,
  headerBelowPlanPt: 165,
} as const

export interface RecoveredMajorLabelV2 {
  normalizedLabel: string
  displayLabel: string
}

export interface PlanBodyTextCoverageRecoveryV2Debug {
  visibleTextRunCount: number
  groupedLabelCountBefore: number
  groupedLabelCountAfter: number
  recoveredMajorLabels: RecoveredMajorLabelV2[]
  stillMissingExpectedMajorLabels: string[]
  textCoverageStatement: string
  notes: string[]
  /** Runs passed to grouping / attribution after recovery (superset of primary layout boxes). */
  expandedPlanBodyTextRuns: ExtractedTextRun[]
  addedTextRunCount: number
}

function textRunBbox(t: ExtractedTextRun): { minX: number; maxX: number; minY: number; maxY: number } {
  const w = t.width ?? 12
  const h = t.height ?? 10
  return { minX: t.x, maxX: t.x + w, minY: t.y, maxY: t.y + h }
}

function expandBBox(bb: PlanBoundingBox, pad: number): PlanBoundingBox {
  return {
    minX: bb.minX - pad,
    minY: bb.minY - pad,
    maxX: bb.maxX + pad,
    maxY: bb.maxY + pad,
  }
}

function bboxIntersects(a: { minX: number; maxX: number; minY: number; maxY: number }, b: PlanBoundingBox): boolean {
  return !(a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY)
}

function bboxOfPoly(poly: Pt[]): PlanBoundingBox {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of poly) {
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

function pointToPolyBoundaryDist(px: number, py: number, poly: Pt[]): number {
  let d = Infinity
  const n = poly.length
  for (let i = 0; i < n; i++) {
    const p = poly[i]!
    const q = poly[(i + 1) % n]!
    const dx = q.x - p.x
    const dy = q.y - p.y
    const L2 = dx * dx + dy * dy
    if (L2 < 1e-12) {
      d = Math.min(d, Math.hypot(px - p.x, py - p.y))
      continue
    }
    let t = ((px - p.x) * dx + (py - p.y) * dy) / L2
    t = Math.max(0, Math.min(1, t))
    const zx = p.x + t * dx
    const zy = p.y + t * dy
    d = Math.min(d, Math.hypot(px - zx, py - zy))
  }
  return d
}

function pointToUnitDist(px: number, py: number, unitPoly: Pt[]): { inside: boolean; dist: number } {
  const inside = pointInPolygon(px, py, unitPoly)
  if (inside) return { inside: true, dist: 0 }
  return { inside: false, dist: pointToPolyBoundaryDist(px, py, unitPoly) }
}

function runKey(t: ExtractedTextRun): string {
  const raw = (t.text ?? "").trim().slice(0, 72)
  return `${t.pageIndex}|${t.x.toFixed(2)}|${t.y.toFixed(2)}|${raw}`
}

function likelyBrochureHeader(t: ExtractedTextRun, primaryBx: PlanBoundingBox): boolean {
  const raw = (t.text ?? "").trim()
  if (!raw) return true
  const u = raw.toUpperCase()
  if (raw.length > 52 && !/\b(ROOM|BED|BATH|KITCHEN|LIVING|DINING|STUDY|SUITE|CLOSET|WIC|POWDER)\b/i.test(raw)) return true
  if (/\b(CONDOMINIUM|DEVELOPER|RENDERING|ARCHITECT|DISCLAIMER|COPYRIGHT|©|ALL RIGHTS|E\.&O\.E|PRICES?\s|SUBJECT\s+TO)\b/i.test(u))
    return true
  if (/^(THE\s+)?[A-Z0-9][A-Z0-9\s&]{2,45}(COLLECTION|TOWERS?|RESIDENCES|HOMES)\b/i.test(raw)) return true
  const b = textRunBbox(t)
  if (b.maxY < primaryBx.minY - R2.headerAbovePlanPt) return true
  if (b.minY > primaryBx.maxY + R2.headerBelowPlanPt) return true
  return false
}

function runIsFloorPlanVisible(t: ExtractedTextRun, primaryBx: PlanBoundingBox, unitPoly: Pt[]): boolean {
  if (likelyBrochureHeader(t, primaryBx)) return false
  const b = textRunBbox(t)
  const pb = expandBBox(primaryBx, R2.primaryPadPt)
  if (bboxIntersects(b, pb)) return true
  const ub = expandBBox(bboxOfPoly(unitPoly), R2.unitBboxPadPt)
  if (bboxIntersects(b, ub)) return true
  const corners: Pt[] = [
    { x: b.minX, y: b.minY },
    { x: b.maxX, y: b.minY },
    { x: b.maxX, y: b.maxY },
    { x: b.minX, y: b.maxY },
  ]
  for (const c of corners) {
    if (pointInPolygon(c.x, c.y, unitPoly)) return true
  }
  const cx = (b.minX + b.maxX) / 2
  const cy = (b.minY + b.maxY) / 2
  const du = pointToUnitDist(cx, cy, unitPoly)
  if (du.inside) return true
  if (du.dist < R2.nearUnitDistPt) return true
  return false
}

function majorNormalizedSet(groups: GroupedPlanTextLabelV1[]): Set<string> {
  const s = new Set<string>()
  for (const g of groups) {
    if (g.labelKind === "major_room" && g.normalizedLabel.length > 0) s.add(g.normalizedLabel)
  }
  return s
}

const EXPECTED_MAJOR_CHECKS: Array<{ label: string; satisfiedBy: (g: GroupedPlanTextLabelV1) => boolean }> = [
  {
    label: "LIVING / DINING",
    satisfiedBy: (g) =>
      g.labelKind === "major_room" && /\bLIVING\b/i.test(g.normalizedLabel) && /\bDINING\b/i.test(g.normalizedLabel),
  },
  { label: "KITCHEN", satisfiedBy: (g) => g.labelKind === "major_room" && /\bKITCHEN\b/i.test(g.normalizedLabel) },
  { label: "STUDY", satisfiedBy: (g) => g.labelKind === "major_room" && /\bSTUDY\b/i.test(g.normalizedLabel) },
  {
    label: "FAMILY ROOM",
    satisfiedBy: (g) =>
      g.labelKind === "major_room" && (/\bFAMILY\s+ROOM\b/i.test(g.normalizedLabel) || /\bFAMILYROOM\b/i.test(g.joinedLabel.replace(/\s+/g, ""))),
  },
  {
    label: "BEDROOM 2",
    satisfiedBy: (g) =>
      g.labelKind === "major_room" &&
      (/\bBEDROOM\s*2\b/i.test(g.normalizedLabel) || /\bBR\s*2\b/i.test(g.normalizedLabel)),
  },
  {
    label: "PRIMARY BEDROOM",
    satisfiedBy: (g) =>
      g.labelKind === "major_room" &&
      (/\bPRIMARY\s+BED\b/i.test(g.normalizedLabel) || /\bMASTER\s+BED\b/i.test(g.normalizedLabel)),
  },
]

function computeStillMissing(groups: GroupedPlanTextLabelV1[]): string[] {
  const miss: string[] = []
  for (const row of EXPECTED_MAJOR_CHECKS) {
    let ok = false
    for (const g of groups) {
      if (row.satisfiedBy(g)) {
        ok = true
        break
      }
    }
    if (!ok) miss.push(row.label)
  }
  return miss
}

export function buildPlanBodyTextCoverageRecoveryV2(
  planResult: MainPlanBodyResult,
  allTexts: ExtractedTextRun[],
  unitPolygon: Pt[],
  unitBoundaryClosed: boolean
): PlanBodyTextCoverageRecoveryV2Debug {
  const notes: string[] = []
  const primaryBx = planResult.primaryLayoutBBox
  const primaryRuns = planResult.primaryLayoutTextBoxes.filter((t) => (t.text ?? "").trim().length > 0)

  if (!unitBoundaryClosed || unitPolygon.length < 3) {
    notes.push("Text coverage recovery v2: unit not closed — using primary layout texts only.")
    const groups = buildPlanBodyTextLabelGroupsFromRunsV1(primaryRuns)
    return {
      visibleTextRunCount: primaryRuns.length,
      groupedLabelCountBefore: groups.length,
      groupedLabelCountAfter: groups.length,
      recoveredMajorLabels: [],
      stillMissingExpectedMajorLabels: computeStillMissing(groups),
      textCoverageStatement: "Coverage recovery v2 skipped (open unit).",
      notes,
      expandedPlanBodyTextRuns: primaryRuns.slice(),
      addedTextRunCount: 0,
    }
  }

  const visible: ExtractedTextRun[] = []
  for (const t of allTexts) {
    if (!((t.text ?? "").trim())) continue
    if (!runIsFloorPlanVisible(t, primaryBx, unitPolygon)) continue
    visible.push(t)
  }

  const primaryKeys = new Set(primaryRuns.map(runKey))
  const expanded: ExtractedTextRun[] = [...primaryRuns]
  for (const t of visible) {
    if (primaryKeys.has(runKey(t))) continue
    expanded.push(t)
    primaryKeys.add(runKey(t))
  }

  const addedTextRunCount = expanded.length - primaryRuns.length

  const groupsBefore = buildPlanBodyTextLabelGroupsFromRunsV1(primaryRuns)
  const groupsAfter = buildPlanBodyTextLabelGroupsFromRunsV1(expanded)

  const majBefore = majorNormalizedSet(groupsBefore)
  const recoveredMajorLabels: RecoveredMajorLabelV2[] = []
  const recSeen = new Set<string>()
  for (const g of groupsAfter) {
    if (g.labelKind !== "major_room" || !g.normalizedLabel) continue
    if (majBefore.has(g.normalizedLabel)) continue
    if (recSeen.has(g.normalizedLabel)) continue
    recSeen.add(g.normalizedLabel)
    recoveredMajorLabels.push({ normalizedLabel: g.normalizedLabel, displayLabel: g.joinedLabel })
  }

  const stillMissingExpectedMajorLabels = computeStillMissing(groupsAfter)

  notes.push(
    `Primary layout text runs: ${primaryRuns.length}; floor-plan–visible runs: ${visible.length}; expanded (+${addedTextRunCount}) for grouping.`
  )
  notes.push(
    "Inclusion uses padded primary bbox, padded unit bbox, corners inside unit, and near-unit centers — excludes likely brochure headers."
  )

  const textCoverageStatement = `Text coverage recovery v2: ${groupsBefore.length}→${groupsAfter.length} label group(s); ${recoveredMajorLabels.length} new major group(s); still missing checklist: ${stillMissingExpectedMajorLabels.length}.`

  return {
    visibleTextRunCount: visible.length,
    groupedLabelCountBefore: groupsBefore.length,
    groupedLabelCountAfter: groupsAfter.length,
    recoveredMajorLabels,
    stillMissingExpectedMajorLabels,
    textCoverageStatement,
    notes,
    expandedPlanBodyTextRuns: expanded,
    addedTextRunCount,
  }
}

export interface BuildPlanBodyTextCoverageRecoveryV2SvgOptions {
  pageBounds: PlanBoundingBox
  primaryLayoutBBox: PlanBoundingBox
  recovery: PlanBodyTextCoverageRecoveryV2Debug
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

export function buildPlanBodyTextCoverageRecoveryV2SvgString(o: BuildPlanBodyTextCoverageRecoveryV2SvgOptions): string {
  const pb = o.pageBounds
  const w = pb.maxX - pb.minX
  const h = pb.maxY - pb.minY
  const bx = o.primaryLayoutBBox
  const exp = o.recovery.expandedPlanBodyTextRuns
  const groupsAfter = buildPlanBodyTextLabelGroupsFromRunsV1(exp)
  const primaryCount = Math.max(0, exp.length - o.recovery.addedTextRunCount)
  const primaryKeys = new Set(exp.slice(0, primaryCount).map((t) => runKey(t)))

  const recNorm = new Set(o.recovery.recoveredMajorLabels.map((r) => r.normalizedLabel))

  const unitPath = pathFromPoly(o.unitPolygon, o.unitBoundaryClosed)
  const unitStroke = `<path d="${escapeXml(unitPath)}" fill="none" stroke="rgba(0,70,35,0.9)" stroke-width="2" stroke-dasharray="7 5"/>`

  const runEls: string[] = []
  for (const t of exp) {
    const b = textRunBbox(t)
    const isAdded = !primaryKeys.has(runKey(t))
    const stroke = isAdded ? "rgba(220,120,30,0.75)" : "rgba(90,90,120,0.35)"
    const fill = isAdded ? "rgba(255,200,120,0.12)" : "rgba(200,200,230,0.06)"
    runEls.push(
      `<rect x="${b.minX.toFixed(2)}" y="${b.minY.toFixed(2)}" width="${(b.maxX - b.minX).toFixed(2)}" height="${(b.maxY - b.minY).toFixed(
        2
      )}" fill="${fill}" stroke="${stroke}" stroke-width="0.55"/>`
    )
    const raw = (t.text ?? "").trim()
    const short = raw.length > 16 ? raw.slice(0, 14) + "…" : raw
    runEls.push(
      `<text x="${b.minX.toFixed(2)}" y="${(b.minY - 2).toFixed(2)}" font-size="5.5" fill="${isAdded ? "rgba(160,70,15,0.9)" : "rgba(70,70,90,0.75)"}" font-family="system-ui,sans-serif">${escapeXml(short)}</text>`
    )
  }

  const groupEls: string[] = []
  for (const g of groupsAfter) {
    const isRec = g.labelKind === "major_room" && recNorm.has(g.normalizedLabel)
    const fill = isRec ? "rgba(40,180,70,0.5)" : g.labelKind === "major_room" ? "rgba(40,120,180,0.35)" : "rgba(100,100,120,0.22)"
    groupEls.push(
      `<circle cx="${g.centerX.toFixed(2)}" cy="${g.centerY.toFixed(2)}" r="${isRec ? 5.5 : 4}" fill="${fill}" stroke="rgba(20,40,60,0.5)" stroke-width="0.6"/>`
    )
    const lab = g.joinedLabel.length > 20 ? g.joinedLabel.slice(0, 18) + "…" : g.joinedLabel
    groupEls.push(
      `<text x="${(g.centerX + 8).toFixed(2)}" y="${(g.centerY + 3).toFixed(2)}" font-size="6.5" fill="${isRec ? "rgba(10,90,30,0.95)" : "#333"}" font-family="system-ui,sans-serif" font-weight="${isRec ? "700" : "500"}">${escapeXml(lab)}</text>`
    )
  }

  const missY = bx.minY - 28
  const miss = o.recovery.stillMissingExpectedMajorLabels
  const missText =
    miss.length === 0
      ? "Checklist: all expected majors present (heuristic)."
      : `Still missing (checklist): ${escapeXml(miss.join(", "))}`

  const title = `Plan-body text coverage recovery v2 — visible runs ${o.recovery.visibleTextRunCount}, groups ${o.recovery.groupedLabelCountBefore}→${o.recovery.groupedLabelCountAfter}, +${o.recovery.addedTextRunCount} runs, ${o.recovery.recoveredMajorLabels.length} recovered major(s)`

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${pb.minX} ${pb.minY} ${w} ${h}" width="${Math.round(w)}" height="${Math.round(
    h
  )}">
<rect x="${pb.minX}" y="${pb.minY}" width="${w}" height="${h}" fill="white"/>
<text x="${pb.minX + 8}" y="${pb.minY + 14}" font-size="11" fill="#222" font-family="system-ui,sans-serif">${escapeXml(title)}</text>
<text x="${pb.minX + 8}" y="${pb.minY + 28}" font-size="7" fill="#444" font-family="system-ui,sans-serif">Orange boxes = added vs primary-only; green ring = recovered major group; blue = other grouped majors.</text>
<text x="${bx.minX}" y="${missY.toFixed(0)}" font-size="7.5" fill="rgba(180,40,40,0.92)" font-family="system-ui,sans-serif" font-weight="600">${missText}</text>
<g>${runEls.join("\n")}</g>
<g>${groupEls.join("\n")}</g>
<g>${unitStroke}</g>
<rect x="${bx.minX}" y="${bx.minY}" width="${bx.maxX - bx.minX}" height="${bx.maxY - bx.minY}" fill="none" stroke="rgba(0,60,30,0.3)" stroke-width="1" stroke-dasharray="5 4"/>
</svg>`
}
