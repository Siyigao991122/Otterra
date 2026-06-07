/**
 * Debug-only **hierarchical space typing v2**: refine v1 by recovering missing major labels
 * (e.g. BEDROOM 2 outside plan body extent), tightening the open-plan envelope via barrier-aware
 * flood fill, and expanding enclosed-room candidates toward more complete room polygons.
 */

import { collectBarrierCandidates } from "@/lib/geometryFirst/planBodyRoomCandidatesCleanupV1"
import type { RoomBarrierDebugV1 } from "@/lib/geometryFirst/planBodyRoomCandidatesCleanupV1"
import type { MajorRoomAnchorV1 } from "@/lib/geometryFirst/planBodySemanticGuidedRoomPartitionV1"
import type { RoomTextGroupingV1Debug } from "@/lib/geometryFirst/planBodyRoomTextGroupingV1"
import type { PlanBodyTextCoverageRecoveryV2Debug } from "@/lib/geometryFirst/planBodyTextCoverageRecoveryV2"
import type { AnchorSeedLocalizationV1Debug, LocalizedAnchorSeedV1 } from "@/lib/geometryFirst/planBodyAnchorSeedLocalizationV1"
import type {
  HierarchicalSpaceTypingV1Debug,
  EnclosedRoomCandidateV1,
  OpenPlanEnvelopeCandidateV1,
  OpenPlanSubzoneAssignmentV1,
  AuxiliaryAnchorRefV1,
  EnclosedRoomCandidateSourceV1,
} from "@/lib/geometryFirst/planBodyHierarchicalSpaceTypingV1"
import { structuralMajorSubtypeV1 } from "@/lib/geometryFirst/planBodyHierarchicalSpaceTypingV1"
import {
  normalizePlanBodyRoomLabelV0,
  classifyPlanTextAnchorKindV0,
} from "@/lib/geometryFirst/planBodyRoomTextAttributionV0"
import type { ArchitecturalWallHypothesesDebugPayload } from "@/lib/geometryFirst/architecturalWallHypotheses"
import type { GlobalStructuralSpansDebugPayload } from "@/lib/geometryFirst/globalStructuralSpans"
import type { ExtractedLineSegment, ExtractedTextRun, PlanBoundingBox } from "@/lib/geometryFirst/types"

type Pt = { x: number; y: number }

const H2 = {
  gridDiv: 130,
  dilateEnclosedPasses: 2,
  maxEnclosedFracUnit: 0.34,
  seedFallbackRadius: 22,
  octagonR: 18,
  recoverSearchRadiusFrac: 0.6,
  barrierStrengthHard: 0.50,
  barrierLenHard: 20,
  wallRasterThick: 1,
  enclosedExpandMaxIter: 18,
  enclosedExpandStrength: 0.44,
  enclosedExpandLen: 16,
  envelopeTrimStrength: 0.52,
  envelopeTrimLen: 22,
} as const

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x))
}

function bboxOfPoly(pts: Pt[]): PlanBoundingBox {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of pts) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y)
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
    const xi = poly[i]!.x, yi = poly[i]!.y
    const xj = poly[j]!.x, yj = poly[j]!.y
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
  upper.pop(); lower.pop()
  return lower.concat(upper)
}

function regularNGon(cx: number, cy: number, r: number, n: number): Pt[] {
  const out: Pt[] = []
  for (let k = 0; k < n; k++) {
    const t = (k / n) * Math.PI * 2 - Math.PI / 2
    out.push({ x: cx + r * Math.cos(t), y: cy + r * Math.sin(t) })
  }
  return out
}

function centroidPoly(pts: Pt[]): Pt {
  let sx = 0, sy = 0
  for (const p of pts) { sx += p.x; sy += p.y }
  const n = Math.max(1, pts.length)
  return { x: sx / n, y: sy / n }
}

function snapInsideUnit(px: number, py: number, unit: Pt[]): Pt {
  if (pointInPolygon(px, py, unit)) return { x: px, y: py }
  const c = centroidPoly(unit)
  for (let t = 0; t <= 1.001; t += 0.02) {
    const x = px + t * (c.x - px)
    const y = py + t * (c.y - py)
    if (pointInPolygon(x, y, unit)) return { x, y }
  }
  return c
}

interface GridG {
  minX: number; minY: number; cell: number; gw: number; gh: number
}

function makeGrid(unitPoly: Pt[], pad: number): GridG {
  const bb = bboxOfPoly(unitPoly)
  const minX = bb.minX - pad
  const minY = bb.minY - pad
  const w = bb.maxX - bb.minX + 2 * pad
  const h = bb.maxY - bb.minY + 2 * pad
  const cell = Math.max(2.2, Math.max(w, h) / H2.gridDiv)
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

function dilateMask(mask: Uint8Array, gw: number, gh: number, passes: number): void {
  const tmp = new Uint8Array(mask.length)
  const ix = (i: number, j: number) => j * gw + i
  for (let p = 0; p < passes; p++) {
    tmp.set(mask)
    for (let j = 0; j < gh; j++) {
      for (let i = 0; i < gw; i++) {
        if (tmp[ix(i, j)] === 0) continue
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const ii = i + di, jj = j + dj
            if (ii >= 0 && jj >= 0 && ii < gw && jj < gh) mask[ix(ii, jj)] = 1
          }
        }
      }
    }
  }
}

function drawSegOnGrid(mask: Uint8Array, g: GridG, x1: number, y1: number, x2: number, y2: number, thick: number): void {
  const steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / Math.max(0.35, g.cell * 0.4)))
  for (let t = 0; t <= steps; t++) {
    const u = t / steps
    const x = x1 + u * (x2 - x1)
    const y = y1 + u * (y2 - y1)
    const i = Math.floor((x - g.minX) / g.cell)
    const j = Math.floor((y - g.minY) / g.cell)
    for (let di = -thick; di <= thick; di++) {
      for (let dj = -thick; dj <= thick; dj++) {
        const ii = i + di, jj = j + dj
        if (ii >= 0 && jj >= 0 && ii < g.gw && jj < g.gh) mask[cellIdx(ii, jj, g.gw)] = 1
      }
    }
  }
}

type BarrierExt = RoomBarrierDebugV1 & { len: number }

function collectAllBarriers(
  unitPolygon: Pt[],
  primaryLayoutSegments: ExtractedLineSegment[],
  primaryLayoutCleanedIndices: readonly number[],
  hyps: ArchitecturalWallHypothesesDebugPayload,
  spans: GlobalStructuralSpansDebugPayload,
  anchorPts: Pt[]
): BarrierExt[] {
  const raw = collectBarrierCandidates(
    unitPolygon, unitPolygon, primaryLayoutSegments,
    primaryLayoutCleanedIndices, hyps, spans, anchorPts
  )
  const out: BarrierExt[] = []
  for (const b of raw) {
    out.push({ ...b, len: Math.hypot(b.x2 - b.x1, b.y2 - b.y1) })
  }
  for (let li = 0; li < primaryLayoutSegments.length; li++) {
    if (primaryLayoutCleanedIndices[li] == null) continue
    const s = primaryLayoutSegments[li]!
    const L = Math.hypot(s.x2 - s.x1, s.y2 - s.y1)
    if (L < 14) continue
    const mx = (s.x1 + s.x2) / 2, my = (s.y1 + s.y2) / 2
    if (pointInPolygon(mx, my, unitPolygon)) {
      out.push({ x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2, strength: 0.47, kind: "plan", len: L })
    }
  }
  return out
}

/* ──── recovered anchor from raw page text ──── */

interface RecoveredMajorAnchor {
  anchorId: string
  normalizedLabel: string
  displayLabel: string
  rawTextX: number
  rawTextY: number
  snappedX: number
  snappedY: number
  outsideUnit: boolean
}

/**
 * Strip dimension suffixes like `14'-5" X 11'-10"` or `14-5 X 11-10` (after quote removal)
 * from a normalized label, leaving only the room name.
 */
function stripDimSuffix(norm: string): string {
  return norm
    .replace(/\s*\d+['''′]?[-–]?\d*["""″]?\s*[Xx×]\s*\d+['''′]?[-–]?\d*["""″]?\s*$/, "")
    .trim()
}

function recoverMissingMajors(
  existingMajors: MajorRoomAnchorV1[],
  rawPageTexts: ExtractedTextRun[],
  unitPolygon: Pt[],
  unitBoundaryClosed: boolean,
  notes: string[]
): RecoveredMajorAnchor[] {
  if (!unitBoundaryClosed || unitPolygon.length < 3 || rawPageTexts.length === 0) return []

  const existingBaseNames = new Set(
    existingMajors.map((a) => stripDimSuffix(a.normalizedLabel))
  )

  const candidates: RecoveredMajorAnchor[] = []
  let nextId = existingMajors.length

  for (const tr of rawPageTexts) {
    const raw = tr.text.trim()
    if (raw.length < 3) continue
    const norm = normalizePlanBodyRoomLabelV0(raw)
    const kind = classifyPlanTextAnchorKindV0(norm)
    if (kind !== "major_room") continue

    const baseName = stripDimSuffix(norm)
    if (existingBaseNames.has(baseName)) continue
    const isSubstringOfExisting = [...existingBaseNames].some(
      (eb) => eb.includes(baseName) || baseName.includes(eb)
    )
    if (isSubstringOfExisting) continue

    const alreadyRecovered = candidates.some(
      (c) => stripDimSuffix(c.normalizedLabel) === baseName
    )
    if (alreadyRecovered) continue

    const outsideUnit = !pointInPolygon(tr.x, tr.y, unitPolygon)
    const snapped = snapInsideUnit(tr.x, tr.y, unitPolygon)

    const anchorId = `rec-${nextId++}`
    notes.push(`Recovered missing major: "${raw}" at (${tr.x.toFixed(1)}, ${tr.y.toFixed(1)})${outsideUnit ? " [outside unit → snapped]" : ""}.`)
    candidates.push({
      anchorId,
      normalizedLabel: norm,
      displayLabel: raw,
      rawTextX: tr.x,
      rawTextY: tr.y,
      snappedX: snapped.x,
      snappedY: snapped.y,
      outsideUnit,
    })
  }

  return candidates
}

/* ──── enclosed-room expansion via barrier-constrained flood fill ──── */

function expandEnclosedCandidate(
  cand: EnclosedRoomCandidateV1,
  unitPolygon: Pt[],
  barriers: BarrierExt[],
  enclosedMask: Uint8Array,
  g: GridG,
  unitArea: number
): EnclosedRoomCandidateV1 {
  const wallMask = new Uint8Array(g.gw * g.gh)
  for (const b of barriers) {
    if (b.strength < H2.enclosedExpandStrength || b.len < H2.enclosedExpandLen) continue
    drawSegOnGrid(wallMask, g, b.x1, b.y1, b.x2, b.y2, H2.wallRasterThick)
  }

  const owned = new Uint8Array(g.gw * g.gh)
  for (let j = 0; j < g.gh; j++) {
    for (let i = 0; i < g.gw; i++) {
      const c = cellCenter(i, j, g)
      if (pointInPolygon(c.x, c.y, cand.polygon)) {
        owned[cellIdx(i, j, g.gw)] = 1
      }
    }
  }

  const cap = H2.maxEnclosedFracUnit * Math.max(unitArea, 1)
  let count = 0
  for (let k = 0; k < owned.length; k++) if (owned[k]) count++

  const frontier: number[] = []
  for (let j = 0; j < g.gh; j++) {
    for (let i = 0; i < g.gw; i++) {
      if (!owned[cellIdx(i, j, g.gw)]) continue
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const ni = i + di, nj = j + dj
        if (ni < 0 || nj < 0 || ni >= g.gw || nj >= g.gh) continue
        const nid = cellIdx(ni, nj, g.gw)
        if (!owned[nid] && !wallMask[nid]) {
          frontier.push(cellIdx(i, j, g.gw))
          break
        }
      }
    }
  }

  const q = frontier.slice()
  let qi = 0
  let iterations = 0
  while (qi < q.length && iterations < H2.enclosedExpandMaxIter * frontier.length) {
    const cur = q[qi++]!
    const i0 = cur % g.gw, j0 = (cur / g.gw) | 0
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const ni = i0 + di, nj = j0 + dj
      if (ni < 0 || nj < 0 || ni >= g.gw || nj >= g.gh) continue
      const nid = cellIdx(ni, nj, g.gw)
      if (owned[nid] || wallMask[nid]) continue
      const c = cellCenter(ni, nj, g)
      if (!pointInPolygon(c.x, c.y, unitPolygon)) continue
      if (enclosedMask[nid]) continue
      const cellArea = g.cell * g.cell
      if ((count + 1) * cellArea > cap) continue
      owned[nid] = 1
      count++
      q.push(nid)
    }
    iterations++
  }

  const pts: Pt[] = []
  for (let j = 0; j < g.gh; j++) {
    for (let i = 0; i < g.gw; i++) {
      if (owned[cellIdx(i, j, g.gw)]) pts.push(cellCenter(i, j, g))
    }
  }
  if (pts.length < 3) return cand

  const poly = convexHull(pts)
  return {
    ...cand,
    polygon: poly,
    bbox: bboxOfPoly(poly),
    areaPt2: polygonAbsArea(poly),
  }
}

/* ──── barrier-aware open-plan envelope flood fill ──── */

function buildBarrierAwareEnvelope(
  g: GridG,
  unitPolygon: Pt[],
  enclosedOcc: Uint8Array,
  openSeeds: Pt[],
  barriers: BarrierExt[],
): Pt[] {
  const N = g.gw * g.gh
  const wallMask = new Uint8Array(N)
  for (const b of barriers) {
    if (b.strength < H2.envelopeTrimStrength || b.len < H2.envelopeTrimLen) continue
    drawSegOnGrid(wallMask, g, b.x1, b.y1, b.x2, b.y2, H2.wallRasterThick)
  }

  const free = new Uint8Array(N)
  for (let j = 0; j < g.gh; j++) {
    for (let i = 0; i < g.gw; i++) {
      const id = cellIdx(i, j, g.gw)
      const c = cellCenter(i, j, g)
      if (!pointInPolygon(c.x, c.y, unitPolygon)) continue
      if (enclosedOcc[id]) continue
      if (wallMask[id]) continue
      free[id] = 1
    }
  }

  const nearestFreeCell = (wx: number, wy: number): number | null => {
    let best: number | null = null, bestD = Infinity
    for (let j = 0; j < g.gh; j++) {
      for (let i = 0; i < g.gw; i++) {
        const id = cellIdx(i, j, g.gw)
        if (!free[id]) continue
        const d = (i - wx) * (i - wx) + (j - wy) * (j - wy)
        if (d < bestD) { bestD = d; best = id }
      }
    }
    return best
  }

  const startCells: number[] = []
  for (const s of openSeeds) {
    const ii = clamp(Math.floor((s.x - g.minX) / g.cell), 0, g.gw - 1)
    const jj = clamp(Math.floor((s.y - g.minY) / g.cell), 0, g.gh - 1)
    let sid = cellIdx(ii, jj, g.gw)
    if (!free[sid]) {
      const nf = nearestFreeCell(ii, jj)
      if (nf != null) sid = nf
    }
    startCells.push(sid)
  }

  const visited = new Uint8Array(N)
  for (const sid0 of startCells) {
    if (!free[sid0] || visited[sid0]) continue
    const q: number[] = [sid0]
    visited[sid0] = 1
    let qi = 0
    while (qi < q.length) {
      const cur = q[qi++]!
      const i0 = cur % g.gw, j0 = (cur / g.gw) | 0
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const i1 = i0 + di, j1 = j0 + dj
        if (i1 < 0 || j1 < 0 || i1 >= g.gw || j1 >= g.gh) continue
        const id1 = cellIdx(i1, j1, g.gw)
        if (!free[id1] || visited[id1]) continue
        visited[id1] = 1
        q.push(id1)
      }
    }
  }

  const pts: Pt[] = []
  for (let j = 0; j < g.gh; j++) {
    for (let i = 0; i < g.gw; i++) {
      if (visited[cellIdx(i, j, g.gw)]) pts.push(cellCenter(i, j, g))
    }
  }
  return pts.length >= 3 ? convexHull(pts) : []
}

/* ──── build a local enclosure for a recovered anchor ──── */

function buildRecoveredEnclosure(
  anc: RecoveredMajorAnchor,
  unitPolygon: Pt[],
  barriers: BarrierExt[],
  g: GridG,
  unitArea: number,
  enclosedOtherMask: Uint8Array
): EnclosedRoomCandidateV1 {
  const wallMask = new Uint8Array(g.gw * g.gh)
  for (const b of barriers) {
    if (b.strength < H2.barrierStrengthHard || b.len < H2.barrierLenHard) continue
    drawSegOnGrid(wallMask, g, b.x1, b.y1, b.x2, b.y2, H2.wallRasterThick)
  }

  const sx = anc.snappedX, sy = anc.snappedY
  const si = clamp(Math.floor((sx - g.minX) / g.cell), 0, g.gw - 1)
  const sj = clamp(Math.floor((sy - g.minY) / g.cell), 0, g.gh - 1)

  let seedId = cellIdx(si, sj, g.gw)
  if (wallMask[seedId] || enclosedOtherMask[seedId] || !pointInPolygon(sx, sy, unitPolygon)) {
    let bestD = Infinity; let bestId = seedId
    for (let j = 0; j < g.gh; j++) {
      for (let i = 0; i < g.gw; i++) {
        const id = cellIdx(i, j, g.gw)
        if (wallMask[id] || enclosedOtherMask[id]) continue
        const c = cellCenter(i, j, g)
        if (!pointInPolygon(c.x, c.y, unitPolygon)) continue
        const d = (i - si) * (i - si) + (j - sj) * (j - sj)
        if (d < bestD) { bestD = d; bestId = id }
      }
    }
    seedId = bestId
  }

  const visited = new Uint8Array(g.gw * g.gh)
  const q: number[] = [seedId]
  visited[seedId] = 1
  let qi = 0
  const cap = H2.maxEnclosedFracUnit * Math.max(unitArea, 1)
  let count = 1

  while (qi < q.length) {
    const cur = q[qi++]!
    const i0 = cur % g.gw, j0 = (cur / g.gw) | 0
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const ni = i0 + di, nj = j0 + dj
      if (ni < 0 || nj < 0 || ni >= g.gw || nj >= g.gh) continue
      const nid = cellIdx(ni, nj, g.gw)
      if (visited[nid] || wallMask[nid] || enclosedOtherMask[nid]) continue
      const c = cellCenter(ni, nj, g)
      if (!pointInPolygon(c.x, c.y, unitPolygon)) continue
      if (count * g.cell * g.cell > cap) break
      visited[nid] = 1
      count++
      q.push(nid)
    }
  }

  const pts: Pt[] = []
  for (let j = 0; j < g.gh; j++) {
    for (let i = 0; i < g.gw; i++) {
      if (visited[cellIdx(i, j, g.gw)]) pts.push(cellCenter(i, j, g))
    }
  }

  const poly = pts.length >= 3 ? convexHull(pts) : regularNGon(sx, sy, H2.octagonR, 8)
  const source: EnclosedRoomCandidateSourceV1 = pts.length >= 3 ? "localization_core" : "seed_fallback"

  return {
    candidateId: `enc-${anc.anchorId}`,
    anchorId: anc.anchorId,
    normalizedLabel: anc.normalizedLabel,
    polygon: poly,
    bbox: bboxOfPoly(poly),
    areaPt2: polygonAbsArea(poly),
    source,
  }
}

/* ──── v2 output ──── */

export interface RecoveredMajorInfo {
  anchorId: string
  normalizedLabel: string
  displayLabel: string
  rawTextX: number
  rawTextY: number
  snappedX: number
  snappedY: number
  outsideUnit: boolean
}

export interface HierarchicalSpaceTypingV2Debug {
  enclosedRoomAnchors: MajorRoomAnchorV1[]
  openPlanSubzoneAnchors: MajorRoomAnchorV1[]
  auxiliaryAnchors: AuxiliaryAnchorRefV1[]
  enclosedRoomCandidates: EnclosedRoomCandidateV1[]
  openPlanEnvelopeCandidates: OpenPlanEnvelopeCandidateV1[]
  subzoneAssignments: OpenPlanSubzoneAssignmentV1[]
  recoveredMajors: RecoveredMajorInfo[]
  v1EnvelopeAreaPt2: number
  v2EnvelopeAreaPt2: number
  envelopeTrimmedFrac: number
  expandedEnclosedCount: number
  typingStatement: string
  notes: string[]
}

/* ──── main builder ──── */

export function buildPlanBodyHierarchicalSpaceTypingV2(
  v1: HierarchicalSpaceTypingV1Debug,
  majorAnchors: MajorRoomAnchorV1[],
  grouping: RoomTextGroupingV1Debug,
  textRecovery: PlanBodyTextCoverageRecoveryV2Debug,
  seedLocalization: AnchorSeedLocalizationV1Debug,
  rawPageTexts: ExtractedTextRun[],
  primaryLayoutSegments: ExtractedLineSegment[],
  primaryLayoutCleanedIndices: readonly number[],
  wallHypotheses: ArchitecturalWallHypothesesDebugPayload,
  globalSpans: GlobalStructuralSpansDebugPayload,
  unitPolygon: Pt[],
  unitBoundaryClosed: boolean,
  unitArea: number
): HierarchicalSpaceTypingV2Debug {
  const notes: string[] = []
  const empty = (): HierarchicalSpaceTypingV2Debug => ({
    enclosedRoomAnchors: [],
    openPlanSubzoneAnchors: [],
    auxiliaryAnchors: [],
    enclosedRoomCandidates: [],
    openPlanEnvelopeCandidates: [],
    subzoneAssignments: [],
    recoveredMajors: [],
    v1EnvelopeAreaPt2: 0,
    v2EnvelopeAreaPt2: 0,
    envelopeTrimmedFrac: 0,
    expandedEnclosedCount: 0,
    typingStatement: "Hierarchical space typing v2 skipped.",
    notes,
  })

  if (!unitBoundaryClosed || unitPolygon.length < 3) {
    notes.push("Typing v2 skipped — unit not closed.")
    return empty()
  }

  /* --- Step 1: Recover missing majors from raw page text --- */
  const recovered = recoverMissingMajors(majorAnchors, rawPageTexts, unitPolygon, unitBoundaryClosed, notes)

  /* --- Step 2: Build combined anchor lists --- */
  const enclosedRoomAnchors: MajorRoomAnchorV1[] = [...v1.enclosedRoomAnchors]
  const openPlanSubzoneAnchors: MajorRoomAnchorV1[] = [...v1.openPlanSubzoneAnchors]
  const auxiliaryAnchors: AuxiliaryAnchorRefV1[] = [...v1.auxiliaryAnchors]

  for (const rec of recovered) {
    const majAnchor: MajorRoomAnchorV1 = {
      anchorId: rec.anchorId,
      groupIds: [],
      normalizedLabel: rec.normalizedLabel,
      displayLabel: rec.displayLabel,
      x: rec.snappedX,
      y: rec.snappedY,
    }
    const subtype = structuralMajorSubtypeV1(rec.normalizedLabel)
    if (subtype === "open_plan_subzone") {
      openPlanSubzoneAnchors.push(majAnchor)
    } else {
      enclosedRoomAnchors.push(majAnchor)
    }
  }

  /* --- Step 3: Collect barriers --- */
  const allAnchorPts = [...enclosedRoomAnchors, ...openPlanSubzoneAnchors].map((a) => ({ x: a.x, y: a.y }))
  const barriers = collectAllBarriers(
    unitPolygon, primaryLayoutSegments, primaryLayoutCleanedIndices,
    wallHypotheses, globalSpans, allAnchorPts
  )
  notes.push(`Barrier count: ${barriers.length} (hard≥${H2.barrierStrengthHard}, len≥${H2.barrierLenHard}).`)

  /* --- Step 4: Prepare grid and seed map --- */
  const g = makeGrid(unitPolygon, 10)
  const N = g.gw * g.gh

  const locMap = new Map<string, LocalizedAnchorSeedV1>()
  for (const s of seedLocalization.localizedSeeds) locMap.set(s.anchorId, s)

  /* --- Step 5: Build/expand enclosed-room candidates --- */
  const enclosedOtherMask = new Uint8Array(N)

  let enclosedRoomCandidates: EnclosedRoomCandidateV1[] = []

  for (const a of v1.enclosedRoomAnchors) {
    const existing = v1.enclosedRoomCandidates.find((c) => c.anchorId === a.anchorId)
    if (existing) enclosedRoomCandidates.push({ ...existing })
    else {
      const poly = regularNGon(a.x, a.y, H2.octagonR, 8)
      enclosedRoomCandidates.push({
        candidateId: `enc-${a.anchorId}`,
        anchorId: a.anchorId,
        normalizedLabel: a.normalizedLabel,
        polygon: poly,
        bbox: bboxOfPoly(poly),
        areaPt2: polygonAbsArea(poly),
        source: "seed_fallback",
      })
    }
  }

  for (let j = 0; j < g.gh; j++) {
    for (let i = 0; i < g.gw; i++) {
      const c = cellCenter(i, j, g)
      if (!pointInPolygon(c.x, c.y, unitPolygon)) continue
      for (const cand of enclosedRoomCandidates) {
        if (pointInPolygon(c.x, c.y, cand.polygon)) {
          enclosedOtherMask[cellIdx(i, j, g.gw)] = 1
          break
        }
      }
    }
  }

  for (const rec of recovered) {
    const sub = structuralMajorSubtypeV1(rec.normalizedLabel)
    if (sub !== "enclosed_room") continue
    const recEnc = buildRecoveredEnclosure(rec, unitPolygon, barriers, g, unitArea, enclosedOtherMask)
    enclosedRoomCandidates.push(recEnc)
    for (let j = 0; j < g.gh; j++) {
      for (let i = 0; i < g.gw; i++) {
        const c = cellCenter(i, j, g)
        if (pointInPolygon(c.x, c.y, recEnc.polygon)) {
          enclosedOtherMask[cellIdx(i, j, g.gw)] = 1
        }
      }
    }
  }

  let expandedEnclosedCount = 0
  const enclosedMaskForExpand = new Uint8Array(N)
  const expandedCandidates: EnclosedRoomCandidateV1[] = []
  for (const cand of enclosedRoomCandidates) {
    enclosedMaskForExpand.fill(0)
    for (const other of enclosedRoomCandidates) {
      if (other.anchorId === cand.anchorId) continue
      for (let j = 0; j < g.gh; j++) {
        for (let i = 0; i < g.gw; i++) {
          const c = cellCenter(i, j, g)
          if (pointInPolygon(c.x, c.y, other.polygon)) {
            enclosedMaskForExpand[cellIdx(i, j, g.gw)] = 1
          }
        }
      }
    }
    const expanded = expandEnclosedCandidate(cand, unitPolygon, barriers, enclosedMaskForExpand, g, unitArea)
    if (expanded.areaPt2 > cand.areaPt2 * 1.05) expandedEnclosedCount++
    expandedCandidates.push(expanded)
  }
  enclosedRoomCandidates = expandedCandidates

  /* --- Step 6: Build dilated enclosed mask for envelope --- */
  const enclosedOccFinal = new Uint8Array(N)
  for (let j = 0; j < g.gh; j++) {
    for (let i = 0; i < g.gw; i++) {
      const c = cellCenter(i, j, g)
      if (!pointInPolygon(c.x, c.y, unitPolygon)) continue
      for (const cand of enclosedRoomCandidates) {
        if (pointInPolygon(c.x, c.y, cand.polygon)) {
          enclosedOccFinal[cellIdx(i, j, g.gw)] = 1
          break
        }
      }
    }
  }
  dilateMask(enclosedOccFinal, g.gw, g.gh, H2.dilateEnclosedPasses)

  /* --- Step 7: Barrier-aware open-plan envelope --- */
  const v1EnvelopeArea = v1.openPlanEnvelopeCandidates[0]?.areaPt2 ?? 0

  const openPlanEnvelopeCandidates: OpenPlanEnvelopeCandidateV1[] = []
  const subzoneAssignments: OpenPlanSubzoneAssignmentV1[] = []
  const envelopeId = "ope-0"

  const openSeeds: Pt[] = []
  for (const a of openPlanSubzoneAnchors) {
    const s = locMap.get(a.anchorId)
    const sx = s?.localizedSeedX ?? a.x
    const sy = s?.localizedSeedY ?? a.y
    openSeeds.push({ x: sx, y: sy })
    subzoneAssignments.push({
      anchorId: a.anchorId,
      normalizedLabel: a.normalizedLabel,
      displayLabel: a.displayLabel,
      seedX: sx, seedY: sy,
      envelopeId,
    })
  }

  if (openPlanSubzoneAnchors.length > 0) {
    const envPoly = buildBarrierAwareEnvelope(g, unitPolygon, enclosedOccFinal, openSeeds, barriers)
    if (envPoly.length >= 3) {
      openPlanEnvelopeCandidates.push({
        envelopeId,
        polygon: envPoly,
        bbox: bboxOfPoly(envPoly),
        areaPt2: polygonAbsArea(envPoly),
      })
    } else {
      notes.push("Open-plan envelope: barrier-aware flood too small — falling back to unit hull.")
      const uh = convexHull(unitPolygon)
      openPlanEnvelopeCandidates.push({
        envelopeId,
        polygon: uh,
        bbox: bboxOfPoly(uh),
        areaPt2: polygonAbsArea(uh),
      })
    }
  }

  const v2EnvelopeArea = openPlanEnvelopeCandidates[0]?.areaPt2 ?? 0
  const envelopeTrimmedFrac = v1EnvelopeArea > 0 ? Math.max(0, 1 - v2EnvelopeArea / v1EnvelopeArea) : 0

  const typingStatement = `Hierarchical typing v2: ${enclosedRoomAnchors.length} enclosed (${recovered.filter((r) => structuralMajorSubtypeV1(r.normalizedLabel) === "enclosed_room").length} recovered), ${openPlanSubzoneAnchors.length} open-plan, ${auxiliaryAnchors.length} auxiliary; envelope trimmed ${(envelopeTrimmedFrac * 100).toFixed(0)}%; ${expandedEnclosedCount} enclosed expanded.`

  notes.push(
    `Open-plan envelope area: v1=${v1EnvelopeArea.toFixed(0)} → v2=${v2EnvelopeArea.toFixed(0)} (${(envelopeTrimmedFrac * 100).toFixed(1)}% trimmed).`
  )
  notes.push(
    `Enclosed candidate expansion: ${expandedEnclosedCount}/${enclosedRoomCandidates.length} candidates grew beyond their v1 core.`
  )

  return {
    enclosedRoomAnchors,
    openPlanSubzoneAnchors,
    auxiliaryAnchors,
    enclosedRoomCandidates,
    openPlanEnvelopeCandidates,
    subzoneAssignments,
    recoveredMajors: recovered,
    v1EnvelopeAreaPt2: v1EnvelopeArea,
    v2EnvelopeAreaPt2: v2EnvelopeArea,
    envelopeTrimmedFrac,
    expandedEnclosedCount,
    typingStatement,
    notes,
  }
}

/* ──── SVG ──── */

export interface BuildPlanBodyHierarchicalSpaceTypingV2SvgOptions {
  pageBounds: PlanBoundingBox
  primaryLayoutBBox: PlanBoundingBox
  typing: HierarchicalSpaceTypingV2Debug
  v1Envelope?: OpenPlanEnvelopeCandidateV1
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

export function buildPlanBodyHierarchicalSpaceTypingV2SvgString(o: BuildPlanBodyHierarchicalSpaceTypingV2SvgOptions): string {
  const pb = o.pageBounds
  const w = pb.maxX - pb.minX
  const h = pb.maxY - pb.minY
  const bx = o.primaryLayoutBBox
  const t = o.typing

  const unitPath = pathFromPoly(o.unitPolygon, o.unitBoundaryClosed)
  const unitStroke = `<path d="${escapeXml(unitPath)}" fill="none" stroke="rgba(0,80,40,0.9)" stroke-width="2" stroke-dasharray="8 5"/>`

  const v1EnvGhost = o.v1Envelope
    ? `<path d="${escapeXml(pathFromPoly(o.v1Envelope.polygon, true))}" fill="none" stroke="rgba(200,110,20,0.25)" stroke-width="1.4" stroke-dasharray="6 4"/>`
    : ""

  const encPolys = t.enclosedRoomCandidates
    .map((c) => {
      const p = pathFromPoly(c.polygon, true)
      const isRecovered = t.recoveredMajors.some((r) => r.anchorId === c.anchorId)
      const fill = isRecovered ? "rgba(30,180,80,0.14)" : "rgba(40,130,200,0.12)"
      const stroke = isRecovered ? "rgba(15,110,40,0.88)" : "rgba(25,85,160,0.85)"
      return `<path d="${escapeXml(p)}" fill="${fill}" stroke="${stroke}" stroke-width="1.35"/>`
    })
    .join("\n")

  const envPolys = t.openPlanEnvelopeCandidates
    .map((e) => {
      const p = pathFromPoly(e.polygon, true)
      return `<path d="${escapeXml(p)}" fill="rgba(255,180,60,0.11)" stroke="rgba(200,110,20,0.9)" stroke-width="2.2" stroke-dasharray="10 6"/>`
    })
    .join("\n")

  const encAnchors = t.enclosedRoomAnchors
    .map((a) => {
      const isRec = t.recoveredMajors.some((r) => r.anchorId === a.anchorId)
      const fill = isRec ? "rgba(30,170,60,0.92)" : "rgba(30,90,200,0.92)"
      const stroke = isRec ? "rgba(15,95,30,0.95)" : "rgba(15,45,120,0.95)"
      const txtFill = isRec ? "#0a3a12" : "#0a1a44"
      const label = a.displayLabel.length > 20 ? a.displayLabel.slice(0, 18) + "\u2026" : a.displayLabel
      return `<circle cx="${a.x.toFixed(2)}" cy="${a.y.toFixed(2)}" r="5" fill="${fill}" stroke="${stroke}" stroke-width="1.1"/>
<text x="${(a.x + 7).toFixed(2)}" y="${(a.y - 7).toFixed(2)}" font-size="7.5" font-weight="700" fill="${txtFill}" font-family="system-ui,sans-serif">${escapeXml(label)}</text>`
    })
    .join("\n")

  const openAnchors = t.openPlanSubzoneAnchors
    .map((a) => {
      return `<circle cx="${a.x.toFixed(2)}" cy="${a.y.toFixed(2)}" r="5" fill="rgba(220,120,30,0.92)" stroke="rgba(130,60,10,0.95)" stroke-width="1.1"/>
<text x="${(a.x + 7).toFixed(2)}" y="${(a.y - 7).toFixed(2)}" font-size="7.5" font-weight="700" fill="#4a2200" font-family="system-ui,sans-serif">${escapeXml(
        a.displayLabel.length > 20 ? a.displayLabel.slice(0, 18) + "\u2026" : a.displayLabel
      )}</text>`
    })
    .join("\n")

  const auxAnchors = t.auxiliaryAnchors
    .map((a) => {
      return `<circle cx="${a.centerX.toFixed(2)}" cy="${a.centerY.toFixed(2)}" r="3.5" fill="rgba(140,50,180,0.88)" stroke="rgba(70,25,95,0.9)" stroke-width="0.85"/>
<text x="${(a.centerX + 5).toFixed(2)}" y="${(a.centerY - 5).toFixed(2)}" font-size="6.5" fill="#301040" font-family="system-ui,sans-serif">${escapeXml(
        a.displayLabel.length > 16 ? a.displayLabel.slice(0, 14) + "\u2026" : a.displayLabel
      )}</text>`
    })
    .join("\n")

  const subLabels = t.subzoneAssignments
    .map((s) => {
      return `<text x="${s.seedX.toFixed(2)}" y="${(s.seedY + 14).toFixed(2)}" font-size="8" font-weight="700" fill="rgba(160,70,0,0.95)" font-family="system-ui,sans-serif" text-anchor="middle">${escapeXml(
        s.displayLabel.length > 22 ? s.displayLabel.slice(0, 20) + "\u2026" : s.displayLabel
      )}</text>`
    })
    .join("\n")

  const recMarkers = t.recoveredMajors
    .map((r) => {
      return `<line x1="${r.rawTextX.toFixed(2)}" y1="${r.rawTextY.toFixed(2)}" x2="${r.snappedX.toFixed(2)}" y2="${r.snappedY.toFixed(2)}" stroke="rgba(30,160,50,0.6)" stroke-width="1" stroke-dasharray="4 3"/>
<circle cx="${r.rawTextX.toFixed(2)}" cy="${r.rawTextY.toFixed(2)}" r="3" fill="none" stroke="rgba(30,160,50,0.5)" stroke-width="0.8"/>
<text x="${(r.rawTextX + 4).toFixed(2)}" y="${(r.rawTextY - 4).toFixed(2)}" font-size="6" fill="rgba(30,130,50,0.85)" font-family="system-ui,sans-serif">${escapeXml(r.displayLabel)} [recovered]</text>`
    })
    .join("\n")

  const title = `Hierarchical space typing v2 — ${t.enclosedRoomAnchors.length} enclosed (${t.recoveredMajors.length} recovered) / ${t.openPlanSubzoneAnchors.length} open-plan / ${t.auxiliaryAnchors.length} auxiliary / env trimmed ${(t.envelopeTrimmedFrac * 100).toFixed(0)}%`

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${pb.minX} ${pb.minY} ${w} ${h}" width="${Math.round(w)}" height="${Math.round(h)}">
<rect x="${pb.minX}" y="${pb.minY}" width="${w}" height="${h}" fill="white"/>
<text x="${pb.minX + 8}" y="${pb.minY + 14}" font-size="11" fill="#222" font-family="system-ui,sans-serif">${escapeXml(title)}</text>
<text x="${pb.minX + 8}" y="${pb.minY + 28}" font-size="7.5" fill="#444" font-family="system-ui,sans-serif">Blue = enclosed; green = recovered enclosed; orange dashed = trimmed open-plan envelope; faint orange = v1 envelope; purple = auxiliary.</text>
<g>${v1EnvGhost}</g>
<g>${envPolys}</g>
<g>${encPolys}</g>
<g>${encAnchors}</g>
<g>${openAnchors}</g>
<g>${subLabels}</g>
<g>${auxAnchors}</g>
<g>${recMarkers}</g>
<g>${unitStroke}</g>
<rect x="${bx.minX}" y="${bx.minY}" width="${bx.maxX - bx.minX}" height="${bx.maxY - bx.minY}" fill="none" stroke="rgba(0,60,30,0.3)" stroke-width="1.05" stroke-dasharray="5 4"/>
</svg>`
}
