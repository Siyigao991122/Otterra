/**
 * Debug-only **hierarchical space typing v1**: split majors into enclosed vs open-plan subzones vs auxiliary,
 * build enclosed room polygons and one shared open-plan envelope (not separate top-level polygons per kitchen/living).
 */

import type { MajorRoomAnchorV1 } from "@/lib/geometryFirst/planBodySemanticGuidedRoomPartitionV1"
import type { RoomTextGroupingV1Debug } from "@/lib/geometryFirst/planBodyRoomTextGroupingV1"
import type { PlanBodyTextCoverageRecoveryV2Debug } from "@/lib/geometryFirst/planBodyTextCoverageRecoveryV2"
import type { AnchorSeedLocalizationV1Debug, LocalizedAnchorSeedV1 } from "@/lib/geometryFirst/planBodyAnchorSeedLocalizationV1"
import type { PlanBoundingBox } from "@/lib/geometryFirst/types"

type Pt = { x: number; y: number }

const H1 = {
  gridDiv: 110,
  dilateEnclosedPasses: 3,
  maxEnclosedFracUnit: 0.34,
  seedFallbackRadius: 22,
  octagonR: 18,
} as const

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x))
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

/** Majors only: enclosed vs open-plan subzone (auxiliary uses grouping labelKind). */
export function structuralMajorSubtypeV1(normalizedLabel: string): "enclosed_room" | "open_plan_subzone" {
  const u = normalizedLabel.toUpperCase().replace(/\s+/g, " ").trim()

  if (/\bKITCHEN\b/.test(u)) return "open_plan_subzone"
  if (/\bLIVING\b/.test(u)) return "open_plan_subzone"
  if (/\bDINING\b/.test(u)) return "open_plan_subzone"
  if (/\bGREAT\s+ROOM\b/.test(u)) return "open_plan_subzone"
  if (/\bBREAKFAST\b/.test(u) && /\b(NOOK|AREA)\b/.test(u)) return "open_plan_subzone"

  if (/\bBEDROOM\b/.test(u) || /\bPRIMARY\s+BED\b/.test(u) || /^BR\s*\d+$/i.test(u.trim())) return "enclosed_room"
  if (/\bSTUDY\b/.test(u)) return "enclosed_room"
  if (/\bFAMILY\s+ROOM\b/.test(u)) return "enclosed_room"
  if (/\bDEN\b/.test(u) || /\bOFFICE\b/.test(u)) return "enclosed_room"
  if (/\bMEDIA\b/.test(u) || /\bGAME\s+ROOM\b/.test(u) || /\bREC(?:REATION)?\s+ROOM\b/.test(u)) return "enclosed_room"
  if (/\bSUNROOM\b/.test(u) || /\bLOFT\b/.test(u)) return "enclosed_room"

  return "enclosed_room"
}

function regularNGon(cx: number, cy: number, r: number, n: number): Pt[] {
  const out: Pt[] = []
  for (let k = 0; k < n; k++) {
    const t = (k / n) * Math.PI * 2 - Math.PI / 2
    out.push({ x: cx + r * Math.cos(t), y: cy + r * Math.sin(t) })
  }
  return out
}

function dilateMask(mask: Uint8Array, gw: number, gh: number, passes: number): void {
  const tmp = new Uint8Array(mask.length)
  const idx = (i: number, j: number) => j * gw + i
  for (let p = 0; p < passes; p++) {
    tmp.set(mask)
    for (let j = 0; j < gh; j++) {
      for (let i = 0; i < gw; i++) {
        if (tmp[idx(i, j)] === 0) continue
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const ii = i + di
            const jj = j + dj
            if (ii >= 0 && jj >= 0 && ii < gw && jj < gh) mask[idx(ii, jj)] = 1
          }
        }
      }
    }
  }
}

interface GridG {
  minX: number
  minY: number
  cell: number
  gw: number
  gh: number
}

function makeGrid(unitPoly: Pt[], pad: number): GridG {
  const bb = bboxOfPoly(unitPoly)
  const minX = bb.minX - pad
  const minY = bb.minY - pad
  const w = bb.maxX - bb.minX + 2 * pad
  const h = bb.maxY - bb.minY + 2 * pad
  const cell = Math.max(2.2, Math.max(w, h) / H1.gridDiv)
  const gw = Math.max(24, Math.ceil(w / cell))
  const gh = Math.max(24, Math.ceil(h / cell))
  return { minX, minY, cell, gw, gh }
}

function cellCenter(i: number, j: number, g: GridG): Pt {
  return { x: g.minX + (i + 0.5) * g.cell, y: g.minY + (j + 0.5) * g.cell }
}

function cellIdx(i: number, j: number, gw: number): number {
  return j * gw + i
}

export interface AuxiliaryAnchorRefV1 {
  groupId: string
  normalizedLabel: string
  displayLabel: string
  centerX: number
  centerY: number
}

export type EnclosedRoomCandidateSourceV1 = "localization_core" | "seed_patch" | "seed_fallback"

export interface EnclosedRoomCandidateV1 {
  candidateId: string
  anchorId: string
  normalizedLabel: string
  polygon: Pt[]
  bbox: PlanBoundingBox
  areaPt2: number
  source: EnclosedRoomCandidateSourceV1
}

export interface OpenPlanEnvelopeCandidateV1 {
  envelopeId: string
  polygon: Pt[]
  bbox: PlanBoundingBox
  areaPt2: number
}

export interface OpenPlanSubzoneAssignmentV1 {
  anchorId: string
  normalizedLabel: string
  displayLabel: string
  seedX: number
  seedY: number
  envelopeId: string
}

export interface HierarchicalSpaceTypingV1Debug {
  enclosedRoomAnchors: MajorRoomAnchorV1[]
  openPlanSubzoneAnchors: MajorRoomAnchorV1[]
  auxiliaryAnchors: AuxiliaryAnchorRefV1[]
  enclosedRoomCandidates: EnclosedRoomCandidateV1[]
  openPlanEnvelopeCandidates: OpenPlanEnvelopeCandidateV1[]
  subzoneAssignments: OpenPlanSubzoneAssignmentV1[]
  typingStatement: string
  notes: string[]
}

function seedByAnchorId(loc: AnchorSeedLocalizationV1Debug): Map<string, LocalizedAnchorSeedV1> {
  const m = new Map<string, LocalizedAnchorSeedV1>()
  for (const s of loc.localizedSeeds) m.set(s.anchorId, s)
  return m
}

function polygonForEnclosedFromLocalization(s: LocalizedAnchorSeedV1, unitArea: number): {
  poly: Pt[]
  source: EnclosedRoomCandidateSourceV1
} {
  if (s.localCorePolygon.length >= 3) {
    let poly = s.localCorePolygon.map((p) => ({ x: p.x, y: p.y }))
    const cap = H1.maxEnclosedFracUnit * Math.max(unitArea, 1)
    if (polygonAbsArea(poly) > cap) {
      const c = { x: s.localizedSeedX, y: s.localizedSeedY }
      const scale = Math.sqrt(cap / polygonAbsArea(poly)) * 0.92
      const bb = bboxOfPoly(poly)
      const mx = (bb.minX + bb.maxX) / 2
      const my = (bb.minY + bb.maxY) / 2
      poly = poly.map((p) => ({
        x: mx + (p.x - mx) * scale,
        y: my + (p.y - my) * scale,
      }))
    }
    return { poly, source: "localization_core" }
  }
  if (s.seedPatchPolygon.length >= 3) {
    return { poly: s.seedPatchPolygon.map((p) => ({ x: p.x, y: p.y })), source: "seed_patch" }
  }
  return {
    poly: regularNGon(s.localizedSeedX, s.localizedSeedY, H1.seedFallbackRadius, 8),
    source: "seed_fallback",
  }
}

export function buildPlanBodyHierarchicalSpaceTypingV1(
  majorAnchors: MajorRoomAnchorV1[],
  grouping: RoomTextGroupingV1Debug,
  textRecovery: PlanBodyTextCoverageRecoveryV2Debug,
  seedLocalization: AnchorSeedLocalizationV1Debug,
  unitPolygon: Pt[],
  unitBoundaryClosed: boolean,
  unitArea: number
): HierarchicalSpaceTypingV1Debug {
  const notes: string[] = []
  const empty = (): HierarchicalSpaceTypingV1Debug => ({
    enclosedRoomAnchors: [],
    openPlanSubzoneAnchors: [],
    auxiliaryAnchors: [],
    enclosedRoomCandidates: [],
    openPlanEnvelopeCandidates: [],
    subzoneAssignments: [],
    typingStatement: "Hierarchical space typing v1 skipped.",
    notes,
  })

  if (!unitBoundaryClosed || unitPolygon.length < 3) {
    notes.push("Hierarchical typing v1 skipped — unit not closed.")
    return empty()
  }

  const auxiliaryAnchors: AuxiliaryAnchorRefV1[] = []
  for (const g of grouping.labelGroups) {
    if (g.labelKind !== "auxiliary_space") continue
    auxiliaryAnchors.push({
      groupId: g.groupId,
      normalizedLabel: g.normalizedLabel,
      displayLabel: g.joinedLabel,
      centerX: g.centerX,
      centerY: g.centerY,
    })
  }

  const enclosedRoomAnchors: MajorRoomAnchorV1[] = []
  const openPlanSubzoneAnchors: MajorRoomAnchorV1[] = []
  for (const a of majorAnchors) {
    if (structuralMajorSubtypeV1(a.normalizedLabel) === "open_plan_subzone") openPlanSubzoneAnchors.push(a)
    else enclosedRoomAnchors.push(a)
  }

  const locMap = seedByAnchorId(seedLocalization)
  const enclosedRoomCandidates: EnclosedRoomCandidateV1[] = []
  for (const a of enclosedRoomAnchors) {
    const s = locMap.get(a.anchorId)
    if (!s) {
      notes.push(`Enclosed candidate missing localization for ${a.anchorId} (${a.displayLabel}).`)
      const poly = regularNGon(a.x, a.y, H1.octagonR, 8)
      enclosedRoomCandidates.push({
        candidateId: `enc-${a.anchorId}`,
        anchorId: a.anchorId,
        normalizedLabel: a.normalizedLabel,
        polygon: poly,
        bbox: bboxOfPoly(poly),
        areaPt2: polygonAbsArea(poly),
        source: "seed_fallback",
      })
      continue
    }
    const { poly, source } = polygonForEnclosedFromLocalization(s, unitArea)
    enclosedRoomCandidates.push({
      candidateId: `enc-${a.anchorId}`,
      anchorId: a.anchorId,
      normalizedLabel: a.normalizedLabel,
      polygon: poly,
      bbox: bboxOfPoly(poly),
      areaPt2: polygonAbsArea(poly),
      source,
    })
  }

  const g = makeGrid(unitPolygon, 10)
  const N = g.gw * g.gh
  const enclosedOcc = new Uint8Array(N).fill(0)
  for (let j = 0; j < g.gh; j++) {
    for (let i = 0; i < g.gw; i++) {
      const c = cellCenter(i, j, g)
      if (!pointInPolygon(c.x, c.y, unitPolygon)) continue
      for (const cand of enclosedRoomCandidates) {
        if (pointInPolygon(c.x, c.y, cand.polygon)) {
          enclosedOcc[cellIdx(i, j, g.gw)] = 1
          break
        }
      }
    }
  }
  dilateMask(enclosedOcc, g.gw, g.gh, H1.dilateEnclosedPasses)

    const openPlanEnvelopeCandidates: OpenPlanEnvelopeCandidateV1[] = []
  const subzoneAssignments: OpenPlanSubzoneAssignmentV1[] = []
  const envelopeId = "ope-0"

  for (const a of openPlanSubzoneAnchors) {
    const s = locMap.get(a.anchorId)
    const sx = s?.localizedSeedX ?? a.x
    const sy = s?.localizedSeedY ?? a.y
    subzoneAssignments.push({
      anchorId: a.anchorId,
      normalizedLabel: a.normalizedLabel,
      displayLabel: a.displayLabel,
      seedX: sx,
      seedY: sy,
      envelopeId,
    })
  }

  if (openPlanSubzoneAnchors.length > 0) {
    const free = new Uint8Array(N).fill(0)
    for (let j = 0; j < g.gh; j++) {
      for (let i = 0; i < g.gw; i++) {
        const id = cellIdx(i, j, g.gw)
        const c = cellCenter(i, j, g)
        if (!pointInPolygon(c.x, c.y, unitPolygon)) continue
        if (enclosedOcc[id]) continue
        free[id] = 1
      }
    }

    const nearestFreeCell = (ix: number, jy: number): number | null => {
      let best: number | null = null
      let bestD = Infinity
      for (let j = 0; j < g.gh; j++) {
        for (let i = 0; i < g.gw; i++) {
          const id = cellIdx(i, j, g.gw)
          if (!free[id]) continue
          const d = (i - ix) * (i - ix) + (j - jy) * (j - jy)
          if (d < bestD) {
            bestD = d
            best = id
          }
        }
      }
      return best
    }

    const startCells: number[] = []
    for (const a of openPlanSubzoneAnchors) {
      const s = locMap.get(a.anchorId)
      const ax = s?.localizedSeedX ?? a.x
      const ay = s?.localizedSeedY ?? a.y
      const ii = clamp(Math.floor((ax - g.minX) / g.cell), 0, g.gw - 1)
      const jj = clamp(Math.floor((ay - g.minY) / g.cell), 0, g.gh - 1)
      let sid = cellIdx(ii, jj, g.gw)
      if (!free[sid]) {
        const nf = nearestFreeCell(ii, jj)
        if (nf != null) sid = nf
      }
      startCells.push(sid)
    }

    const visited = new Uint8Array(N).fill(0)
    for (const sid0 of startCells) {
      if (!free[sid0] || visited[sid0]) continue
      const q: number[] = [sid0]
      visited[sid0] = 1
      let qi = 0
      while (qi < q.length) {
        const cur = q[qi++]!
        const i0 = cur % g.gw
        const j0 = (cur / g.gw) | 0
        for (const [di, dj] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const i1 = i0 + di
          const j1 = j0 + dj
          if (i1 < 0 || j1 < 0 || i1 >= g.gw || j1 >= g.gh) continue
          const id1 = cellIdx(i1, j1, g.gw)
          if (!free[id1] || visited[id1]) continue
          visited[id1] = 1
          q.push(id1)
        }
      }
    }

    const pocketPts: Pt[] = []
    for (let j = 0; j < g.gh; j++) {
      for (let i = 0; i < g.gw; i++) {
        const id = cellIdx(i, j, g.gw)
        if (!visited[id]) continue
        pocketPts.push(cellCenter(i, j, g))
      }
    }

    if (pocketPts.length >= 3) {
      const poly = convexHull(pocketPts)
      openPlanEnvelopeCandidates.push({
        envelopeId,
        polygon: poly,
        bbox: bboxOfPoly(poly),
        areaPt2: polygonAbsArea(poly),
      })
    } else {
      notes.push("Open-plan envelope: flood region too small — falling back to unit convex hull.")
      const uh = convexHull(unitPolygon)
      openPlanEnvelopeCandidates.push({
        envelopeId,
        polygon: uh,
        bbox: bboxOfPoly(uh),
        areaPt2: polygonAbsArea(uh),
      })
    }
  }

  const typingStatement = `Hierarchical typing v1: ${enclosedRoomAnchors.length} enclosed major(s), ${openPlanSubzoneAnchors.length} open-plan subzone(s), ${auxiliaryAnchors.length} auxiliary label(s); ${enclosedRoomCandidates.length} enclosed candidate(s), ${openPlanEnvelopeCandidates.length} open envelope(s).`

  notes.push(
    "Open-plan majors share one envelope (unit minus dilated enclosed candidates); subzones are label placements only, not separate top-level polygons."
  )
  notes.push("Enclosed majors use localization cores / patches with optional area cap vs unit.")
  if (textRecovery.addedTextRunCount > 0) {
    notes.push(`Text recovery v2 added ${textRecovery.addedTextRunCount} run(s) feeding grouping used for label bboxes.`)
  }

  return {
    enclosedRoomAnchors,
    openPlanSubzoneAnchors,
    auxiliaryAnchors,
    enclosedRoomCandidates,
    openPlanEnvelopeCandidates,
    subzoneAssignments,
    typingStatement,
    notes,
  }
}

export interface BuildPlanBodyHierarchicalSpaceTypingV1SvgOptions {
  pageBounds: PlanBoundingBox
  primaryLayoutBBox: PlanBoundingBox
  typing: HierarchicalSpaceTypingV1Debug
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

export function buildPlanBodyHierarchicalSpaceTypingV1SvgString(o: BuildPlanBodyHierarchicalSpaceTypingV1SvgOptions): string {
  const pb = o.pageBounds
  const w = pb.maxX - pb.minX
  const h = pb.maxY - pb.minY
  const bx = o.primaryLayoutBBox
  const t = o.typing

  const unitPath = pathFromPoly(o.unitPolygon, o.unitBoundaryClosed)
  const unitStroke = `<path d="${escapeXml(unitPath)}" fill="none" stroke="rgba(0,80,40,0.9)" stroke-width="2" stroke-dasharray="8 5"/>`

  const encAnchors = t.enclosedRoomAnchors
    .map((a) => {
      return `<circle cx="${a.x.toFixed(2)}" cy="${a.y.toFixed(2)}" r="5" fill="rgba(30,90,200,0.92)" stroke="rgba(15,45,120,0.95)" stroke-width="1.1"/>
<text x="${(a.x + 7).toFixed(2)}" y="${(a.y - 7).toFixed(2)}" font-size="7.5" font-weight="700" fill="#0a1a44" font-family="system-ui,sans-serif">${escapeXml(
        a.displayLabel.length > 20 ? a.displayLabel.slice(0, 18) + "…" : a.displayLabel
      )}</text>`
    })
    .join("\n")

  const openAnchors = t.openPlanSubzoneAnchors
    .map((a) => {
      return `<circle cx="${a.x.toFixed(2)}" cy="${a.y.toFixed(2)}" r="5" fill="rgba(220,120,30,0.92)" stroke="rgba(130,60,10,0.95)" stroke-width="1.1"/>
<text x="${(a.x + 7).toFixed(2)}" y="${(a.y - 7).toFixed(2)}" font-size="7.5" font-weight="700" fill="#4a2200" font-family="system-ui,sans-serif">${escapeXml(
        a.displayLabel.length > 20 ? a.displayLabel.slice(0, 18) + "…" : a.displayLabel
      )}</text>`
    })
    .join("\n")

  const auxAnchors = t.auxiliaryAnchors
    .map((a) => {
      return `<circle cx="${a.centerX.toFixed(2)}" cy="${a.centerY.toFixed(2)}" r="3.5" fill="rgba(140,50,180,0.88)" stroke="rgba(70,25,95,0.9)" stroke-width="0.85"/>
<text x="${(a.centerX + 5).toFixed(2)}" y="${(a.centerY - 5).toFixed(2)}" font-size="6.5" fill="#301040" font-family="system-ui,sans-serif">${escapeXml(
        a.displayLabel.length > 16 ? a.displayLabel.slice(0, 14) + "…" : a.displayLabel
      )}</text>`
    })
    .join("\n")

  const encPolys = t.enclosedRoomCandidates
    .map((c) => {
      const p = pathFromPoly(c.polygon, true)
      return `<path d="${escapeXml(p)}" fill="rgba(40,130,200,0.12)" stroke="rgba(25,85,160,0.85)" stroke-width="1.35"/>`
    })
    .join("\n")

  const envPolys = t.openPlanEnvelopeCandidates
    .map((e) => {
      const p = pathFromPoly(e.polygon, true)
      return `<path d="${escapeXml(p)}" fill="rgba(255,180,60,0.11)" stroke="rgba(200,110,20,0.9)" stroke-width="2.2" stroke-dasharray="10 6"/>`
    })
    .join("\n")

  const subLabels = t.subzoneAssignments
    .map((s) => {
      return `<text x="${s.seedX.toFixed(2)}" y="${(s.seedY + 14).toFixed(2)}" font-size="8" font-weight="700" fill="rgba(160,70,0,0.95)" font-family="system-ui,sans-serif" text-anchor="middle">${escapeXml(
        s.displayLabel.length > 22 ? s.displayLabel.slice(0, 20) + "…" : s.displayLabel
      )}</text>`
    })
    .join("\n")

  const title = `Hierarchical space typing v1 — ${t.enclosedRoomAnchors.length} enclosed / ${t.openPlanSubzoneAnchors.length} open-plan / ${t.auxiliaryAnchors.length} auxiliary`

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${pb.minX} ${pb.minY} ${w} ${h}" width="${Math.round(w)}" height="${Math.round(
    h
  )}">
<rect x="${pb.minX}" y="${pb.minY}" width="${w}" height="${h}" fill="white"/>
<text x="${pb.minX + 8}" y="${pb.minY + 14}" font-size="11" fill="#222" font-family="system-ui,sans-serif">${escapeXml(title)}</text>
<text x="${pb.minX + 8}" y="${pb.minY + 28}" font-size="7.5" fill="#444" font-family="system-ui,sans-serif">Blue = enclosed majors + candidates; orange dashed = shared open-plan envelope; orange dots = open subzone anchors; purple = auxiliary; subzone labels under seeds.</text>
<g>${envPolys}</g>
<g>${encPolys}</g>
<g>${encAnchors}</g>
<g>${openAnchors}</g>
<g>${subLabels}</g>
<g>${auxAnchors}</g>
<g>${unitStroke}</g>
<rect x="${bx.minX}" y="${bx.minY}" width="${bx.maxX - bx.minX}" height="${bx.maxY - bx.minY}" fill="none" stroke="rgba(0,60,30,0.3)" stroke-width="1.05" stroke-dasharray="5 4"/>
</svg>`
}
