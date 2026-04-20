/**
 * Debug-only **anchor seed localization v1**: local window search + barrier-constrained flood fill
 * to place seeds inside plausible room cores before region growing.
 */

import { collectBarrierCandidates } from "@/lib/geometryFirst/planBodyRoomCandidatesCleanupV1"
import type { RoomBarrierDebugV1 } from "@/lib/geometryFirst/planBodyRoomCandidatesCleanupV1"
import type { MajorRoomAnchorV1 } from "@/lib/geometryFirst/planBodySemanticGuidedRoomPartitionV1"
import type { GroupedPlanTextLabelV1, RoomTextGroupingV1Debug } from "@/lib/geometryFirst/planBodyRoomTextGroupingV1"
import type { PlanBodyTextCoverageRecoveryV2Debug } from "@/lib/geometryFirst/planBodyTextCoverageRecoveryV2"
import type { ArchitecturalWallHypothesesDebugPayload } from "@/lib/geometryFirst/architecturalWallHypotheses"
import type { GlobalStructuralSpansDebugPayload } from "@/lib/geometryFirst/globalStructuralSpans"
import type { ExtractedLineSegment, ExtractedTextRun, PlanBoundingBox } from "@/lib/geometryFirst/types"

type Pt = { x: number; y: number }

const S1 = {
  windowPadFrac: 0.17,
  windowPadMin: 68,
  windowPadMax: 240,
  gridDiv: 96,
  hardStrength: 0.52,
  hardLen: 22,
  hardStrengthStrict: 0.62,
  layoutSegMin: 14,
  maxPocketCells: 12000,
  minPocketCore: 14,
  minPocketRelaxed: 7,
  wallRasterThick: 1,
  seedPatchRadiusCells: 1,
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

function expandBBox(bb: PlanBoundingBox, pad: number): PlanBoundingBox {
  return {
    minX: bb.minX - pad,
    minY: bb.minY - pad,
    maxX: bb.maxX + pad,
    maxY: bb.maxY + pad,
  }
}

function intersectBBox(a: PlanBoundingBox, b: PlanBoundingBox): PlanBoundingBox {
  return {
    minX: Math.max(a.minX, b.minX),
    minY: Math.max(a.minY, b.minY),
    maxX: Math.min(a.maxX, b.maxX),
    maxY: Math.min(a.maxY, b.maxY),
  }
}

function bboxValid(bb: PlanBoundingBox): boolean {
  return bb.maxX > bb.minX + 2 && bb.maxY > bb.minY + 2
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

function centroidPoly(pts: Pt[]): Pt {
  let sx = 0
  let sy = 0
  for (const p of pts) {
    sx += p.x
    sy += p.y
  }
  const n = Math.max(1, pts.length)
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

function textRunBbox(t: ExtractedTextRun): { minX: number; maxX: number; minY: number; maxY: number } {
  const w = t.width ?? 12
  const h = t.height ?? 10
  return { minX: t.x, maxX: t.x + w, minY: t.y, maxY: t.y + h }
}

function groupUnionRect(g: GroupedPlanTextLabelV1, runs: ExtractedTextRun[]): PlanBoundingBox | null {
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

function snapAnchorInsideUnit(px: number, py: number, unit: Pt[]): Pt {
  if (pointInPolygon(px, py, unit)) return { x: px, y: py }
  const c = centroidPoly(unit)
  for (let t = 0; t <= 1.001; t += 0.03) {
    const x = px + t * (c.x - px)
    const y = py + t * (c.y - py)
    if (pointInPolygon(x, y, unit)) return { x, y }
  }
  return { x: c.x, y: c.y }
}

interface LocalGrid {
  minX: number
  minY: number
  cell: number
  gw: number
  gh: number
}

function makeLocalGrid(win: PlanBoundingBox): LocalGrid {
  const w = win.maxX - win.minX
  const h = win.maxY - win.minY
  const cell = Math.max(2.2, Math.max(w, h) / S1.gridDiv)
  const gw = Math.max(S1.gridDiv / 3, Math.ceil(w / cell))
  const gh = Math.max(S1.gridDiv / 3, Math.ceil(h / cell))
  return { minX: win.minX, minY: win.minY, cell, gw, gh }
}

function idx(i: number, j: number, gw: number): number {
  return j * gw + i
}

function cellCenter(i: number, j: number, g: LocalGrid): Pt {
  return { x: g.minX + (i + 0.5) * g.cell, y: g.minY + (j + 0.5) * g.cell }
}

function drawSegOnMask(mask: Uint8Array, g: LocalGrid, x1: number, y1: number, x2: number, y2: number, thick: number): void {
  const steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / Math.max(0.35, g.cell * 0.4)))
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
        if (ii >= 0 && jj >= 0 && ii < g.gw && jj < g.gh) mask[idx(ii, jj, g.gw)] = 1
      }
    }
  }
}

type BarrierExt = RoomBarrierDebugV1 & { len: number }

function collectLocalBarriers(
  unitPolygon: Pt[],
  primaryLayoutSegments: ExtractedLineSegment[],
  primaryLayoutCleanedIndices: readonly number[],
  hyps: ArchitecturalWallHypothesesDebugPayload,
  spans: GlobalStructuralSpansDebugPayload,
  anchorPts: Pt[]
): BarrierExt[] {
  const raw = collectBarrierCandidates(
    unitPolygon,
    unitPolygon,
    primaryLayoutSegments,
    primaryLayoutCleanedIndices,
    hyps,
    spans,
    anchorPts
  )
  const out: BarrierExt[] = []
  for (const b of raw) {
    const len = Math.hypot(b.x2 - b.x1, b.y2 - b.y1)
    out.push({ ...b, len })
  }
  for (let li = 0; li < primaryLayoutSegments.length; li++) {
    if (primaryLayoutCleanedIndices[li] == null) continue
    const s = primaryLayoutSegments[li]!
    const L = Math.hypot(s.x2 - s.x1, s.y2 - s.y1)
    if (L < S1.layoutSegMin) continue
    const mx = (s.x1 + s.x2) / 2
    const my = (s.y1 + s.y2) / 2
    if (pointInPolygon(mx, my, unitPolygon)) {
      out.push({ x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2, strength: 0.47, kind: "plan", len: L })
    }
  }
  return out
}

function isHard(b: BarrierExt, strengthMin: number): boolean {
  return b.strength >= strengthMin && b.len >= S1.hardLen
}

function rasterWalls(mask: Uint8Array, g: LocalGrid, barriers: BarrierExt[], strengthMin: number): void {
  mask.fill(0)
  for (const b of barriers) {
    if (!isHard(b, strengthMin)) continue
    drawSegOnMask(mask, g, b.x1, b.y1, b.x2, b.y2, S1.wallRasterThick)
  }
}

export type LocalizedSeedModeV1 = "local_core" | "fallback_point" | "failed"

export interface LocalizedAnchorSeedV1 {
  anchorId: string
  normalizedLabel: string
  displayLabel: string
  originalAnchorX: number
  originalAnchorY: number
  localizedSeedX: number
  localizedSeedY: number
  searchWindow: PlanBoundingBox
  /** Convex hull of barrier-bounded pocket (may be empty for failed). */
  localCorePolygon: Pt[]
  /** Small patch around the chosen seed (cell neighborhood hull), if any. */
  seedPatchPolygon: Pt[]
  mode: LocalizedSeedModeV1
  pocketCellCount: number
  originalWasInsideUnit: boolean
}

export interface AnchorSeedLocalizationV1Debug {
  seedCount: number
  localizedSeeds: LocalizedAnchorSeedV1[]
  failedSeedIds: string[]
  fallbackSeedIds: string[]
  localCoreSummary: string
  seedLocalizationStatement: string
  notes: string[]
}

export function buildPlanBodyAnchorSeedLocalizationV1(
  majorAnchors: MajorRoomAnchorV1[],
  grouping: RoomTextGroupingV1Debug,
  textRecovery: PlanBodyTextCoverageRecoveryV2Debug,
  primaryLayoutSegments: ExtractedLineSegment[],
  primaryLayoutCleanedIndices: readonly number[],
  hyps: ArchitecturalWallHypothesesDebugPayload,
  spans: GlobalStructuralSpansDebugPayload,
  unitPolygon: Pt[],
  unitBoundaryClosed: boolean
): AnchorSeedLocalizationV1Debug {
  const notes: string[] = []
  const runs = textRecovery.expandedPlanBodyTextRuns
  const groupById = new Map(grouping.labelGroups.map((g) => [g.groupId, g]))

  const empty = (): AnchorSeedLocalizationV1Debug => ({
    seedCount: 0,
    localizedSeeds: [],
    failedSeedIds: [],
    fallbackSeedIds: [],
    localCoreSummary: "Anchor seed localization v1 skipped.",
    seedLocalizationStatement: "Anchor seed localization v1 skipped.",
    notes,
  })

  if (!unitBoundaryClosed || unitPolygon.length < 3) {
    notes.push("Seed localization v1 skipped — unit not closed.")
    return empty()
  }

  if (majorAnchors.length === 0) {
    notes.push("Seed localization v1: no major anchors.")
    return empty()
  }

  const anchorPts = majorAnchors.map((a) => ({ x: a.x, y: a.y }))
  const barriers = collectLocalBarriers(
    unitPolygon,
    primaryLayoutSegments,
    primaryLayoutCleanedIndices,
    hyps,
    spans,
    anchorPts
  )

  const ub = bboxOfPoly(unitPolygon)
  const unitSpan = Math.max(ub.maxX - ub.minX, ub.maxY - ub.minY)
  const padWin = clamp(unitSpan * S1.windowPadFrac, S1.windowPadMin, S1.windowPadMax)

  const localizedSeeds: LocalizedAnchorSeedV1[] = []
  const failedSeedIds: string[] = []
  const fallbackSeedIds: string[] = []
  let coreHits = 0

  for (const anchor of majorAnchors) {
    const origX = anchor.x
    const origY = anchor.y
    const origInside = pointInPolygon(origX, origY, unitPolygon)

    let labelBbox: PlanBoundingBox | null = null
    for (const gid of anchor.groupIds) {
      const g = groupById.get(gid)
      if (!g) continue
      const r = groupUnionRect(g, runs)
      if (!r) continue
      labelBbox = labelBbox
        ? {
            minX: Math.min(labelBbox.minX, r.minX),
            minY: Math.min(labelBbox.minY, r.minY),
            maxX: Math.max(labelBbox.maxX, r.maxX),
            maxY: Math.max(labelBbox.maxY, r.maxY),
          }
        : r
    }
    if (!labelBbox) {
      labelBbox = { minX: origX - 24, minY: origY - 12, maxX: origX + 24, maxY: origY + 12 }
    }

    let searchWindow = expandBBox(labelBbox, padWin)
    searchWindow = intersectBBox(searchWindow, expandBBox(ub, 20))
    if (!bboxValid(searchWindow)) {
      searchWindow = expandBBox({ minX: origX, minY: origY, maxX: origX + 1, maxY: origY + 1 }, padWin * 0.6)
      searchWindow = intersectBBox(searchWindow, expandBBox(ub, 20))
    }

    const g = makeLocalGrid(searchWindow)
    const N = g.gw * g.gh
    const wallMask = new Uint8Array(N)
    const pocketMask = new Uint8Array(N)

    const tryFill = (strengthCut: number): { count: number; cells: number[]; pocket: Uint8Array } => {
      rasterWalls(wallMask, g, barriers, strengthCut)
      pocketMask.fill(0)
      const free = new Uint8Array(N)
      for (let j = 0; j < g.gh; j++) {
        for (let i = 0; i < g.gw; i++) {
          const id = idx(i, j, g.gw)
          const c = cellCenter(i, j, g)
          if (!pointInPolygon(c.x, c.y, unitPolygon)) continue
          if (wallMask[id]) continue
          free[id] = 1
        }
      }

      let si = clamp(Math.floor((origX - g.minX) / g.cell), 0, g.gw - 1)
      let sj = clamp(Math.floor((origY - g.minY) / g.cell), 0, g.gh - 1)
      let startId = idx(si, sj, g.gw)
      if (!free[startId]) {
        let bestD = Infinity
        let bestId = -1
        for (let j = 0; j < g.gh; j++) {
          for (let i = 0; i < g.gw; i++) {
            const id = idx(i, j, g.gw)
            if (!free[id]) continue
            const c = cellCenter(i, j, g)
            const d = Math.hypot(c.x - origX, c.y - origY)
            if (d < bestD) {
              bestD = d
              bestId = id
            }
          }
        }
        if (bestId < 0) return { count: 0, cells: [], pocket: pocketMask }
        startId = bestId
        si = bestId % g.gw
        sj = (bestId / g.gw) | 0
      }

      const q: number[] = [startId]
      pocketMask[startId] = 1
      const cells: number[] = [startId]
      let head = 0
      while (head < q.length && cells.length < S1.maxPocketCells) {
        const cur = q[head++]!
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
          const id1 = idx(i1, j1, g.gw)
          if (!free[id1] || pocketMask[id1]) continue
          pocketMask[id1] = 1
          cells.push(id1)
          q.push(id1)
        }
      }
      return { count: cells.length, cells, pocket: pocketMask }
    }

    let { count: pocketCount, cells: pocketCells } = tryFill(S1.hardStrength)
    let usedLooserWalls = false
    if (pocketCount < S1.minPocketRelaxed) {
      const looser = tryFill(S1.hardStrengthStrict)
      if (looser.count > pocketCount) {
        pocketCount = looser.count
        pocketCells = looser.cells
        usedLooserWalls = true
      }
    }

    const pocketSet = new Set(pocketCells)
    const pocketCenters = pocketCells.map((id) => {
      const i = id % g.gw
      const j = (id / g.gw) | 0
      return cellCenter(i, j, g)
    })

    let localCorePolygon: Pt[] = []
    let seedPatchPolygon: Pt[] = []
    let sx = origX
    let sy = origY
    let mode: LocalizedSeedModeV1 = "fallback_point"

    if (pocketCount >= S1.minPocketCore && pocketCenters.length >= 3) {
      localCorePolygon = convexHull(pocketCenters)
      const boundaryIds: number[] = []
      for (const id of pocketCells) {
        const i0 = id % g.gw
        const j0 = (id / g.gw) | 0
        let isB = false
        for (const [di, dj] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const i1 = i0 + di
          const j1 = j0 + dj
          if (i1 < 0 || j1 < 0 || i1 >= g.gw || j1 >= g.gh) {
            isB = true
            break
          }
          const id1 = idx(i1, j1, g.gw)
          if (!pocketSet.has(id1)) {
            isB = true
            break
          }
        }
        if (isB) boundaryIds.push(id)
      }

      const depthMap = new Map<number, number>()
      const qDepth: number[] = []
      for (const id of boundaryIds) {
        depthMap.set(id, 0)
        qDepth.push(id)
      }
      if (qDepth.length === 0) {
        for (const id of pocketCells) {
          depthMap.set(id, 0)
          qDepth.push(id)
        }
      }
      let qi = 0
      let bestId = pocketCells[0]!
      let bestDepth = -1
      while (qi < qDepth.length) {
        const id = qDepth[qi++]!
        const d0 = depthMap.get(id) ?? 0
        if (d0 > bestDepth) {
          bestDepth = d0
          bestId = id
        }
        const i0 = id % g.gw
        const j0 = (id / g.gw) | 0
        for (const [di, dj] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const i1 = i0 + di
          const j1 = j0 + dj
          if (i1 < 0 || j1 < 0 || i1 >= g.gw || j1 >= g.gh) continue
          const id1 = idx(i1, j1, g.gw)
          if (!pocketSet.has(id1) || depthMap.has(id1)) continue
          depthMap.set(id1, d0 + 1)
          qDepth.push(id1)
        }
      }

      const bi = bestId % g.gw
      const bj = (bestId / g.gw) | 0
      const patchPts: Pt[] = []
      for (let dj = -S1.seedPatchRadiusCells; dj <= S1.seedPatchRadiusCells; dj++) {
        for (let di = -S1.seedPatchRadiusCells; di <= S1.seedPatchRadiusCells; di++) {
          const ii = bi + di
          const jj = bj + dj
          if (ii < 0 || jj < 0 || ii >= g.gw || jj >= g.gh) continue
          const idp = idx(ii, jj, g.gw)
          if (!pocketSet.has(idp)) continue
          patchPts.push(cellCenter(ii, jj, g))
        }
      }
      seedPatchPolygon = patchPts.length >= 3 ? convexHull(patchPts) : patchPts.slice()
      const deepC = cellCenter(bi, bj, g)
      sx = deepC.x
      sy = deepC.y
      mode = "local_core"
      coreHits++
      if (usedLooserWalls) notes.push(`Seed ${anchor.anchorId}: pocket expanded with looser wall mask (strength≥${S1.hardStrengthStrict}).`)
    } else {
      const snapped = snapAnchorInsideUnit(origX, origY, unitPolygon)
      sx = snapped.x
      sy = snapped.y
      localCorePolygon = []
      seedPatchPolygon = []
      if (pocketCount === 0) {
        mode = "failed"
        failedSeedIds.push(anchor.anchorId)
      } else {
        mode = "fallback_point"
        fallbackSeedIds.push(anchor.anchorId)
      }
    }

    if (mode === "local_core" && !pointInPolygon(sx, sy, unitPolygon)) {
      const snapped = snapAnchorInsideUnit(sx, sy, unitPolygon)
      sx = snapped.x
      sy = snapped.y
      if (!fallbackSeedIds.includes(anchor.anchorId)) fallbackSeedIds.push(anchor.anchorId)
      mode = "fallback_point"
      notes.push(`Seed ${anchor.anchorId}: core centroid outside unit — snapped fallback.`)
    }

    localizedSeeds.push({
      anchorId: anchor.anchorId,
      normalizedLabel: anchor.normalizedLabel,
      displayLabel: anchor.displayLabel,
      originalAnchorX: origX,
      originalAnchorY: origY,
      localizedSeedX: sx,
      localizedSeedY: sy,
      searchWindow,
      localCorePolygon,
      seedPatchPolygon,
      mode,
      pocketCellCount: pocketCount,
      originalWasInsideUnit: origInside,
    })
  }

  const localCoreSummary = `${coreHits}/${majorAnchors.length} anchor(s) with local-core pockets; ${fallbackSeedIds.length} fallback; ${failedSeedIds.length} failed.`
  const seedLocalizationStatement = `Seed localization v1: ${localizedSeeds.length} seed(s); ${coreHits} local-core; ${fallbackSeedIds.length} fallback; ${failedSeedIds.length} failed.`

  notes.push(
    `Barriers ${barriers.length} rasterized in local windows (hard≥${S1.hardStrength}, len≥${S1.hardLen}); flood-fill pockets capped at ${S1.maxPocketCells} cells.`
  )

  return {
    seedCount: localizedSeeds.length,
    localizedSeeds,
    failedSeedIds,
    fallbackSeedIds,
    localCoreSummary,
    seedLocalizationStatement,
    notes,
  }
}

export interface BuildPlanBodyAnchorSeedLocalizationV1SvgOptions {
  pageBounds: PlanBoundingBox
  primaryLayoutBBox: PlanBoundingBox
  localization: AnchorSeedLocalizationV1Debug
  majorAnchors: MajorRoomAnchorV1[]
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

export function buildPlanBodyAnchorSeedLocalizationV1SvgString(o: BuildPlanBodyAnchorSeedLocalizationV1SvgOptions): string {
  const pb = o.pageBounds
  const w = pb.maxX - pb.minX
  const h = pb.maxY - pb.minY
  const bx = o.primaryLayoutBBox

  const unitPath = pathFromPoly(o.unitPolygon, o.unitBoundaryClosed)
  const unitStroke = `<path d="${escapeXml(unitPath)}" fill="none" stroke="rgba(0,80,40,0.95)" stroke-width="2.2" stroke-dasharray="8 5"/>`

  const windowSvg = o.localization.localizedSeeds
    .map((s) => {
      const bb = s.searchWindow
      return `<rect x="${bb.minX.toFixed(2)}" y="${bb.minY.toFixed(2)}" width="${(bb.maxX - bb.minX).toFixed(2)}" height="${(bb.maxY - bb.minY).toFixed(
        2
      )}" fill="rgba(100,140,220,0.04)" stroke="rgba(60,100,200,0.45)" stroke-width="0.9" stroke-dasharray="6 4"/>`
    })
    .join("\n")

  const coreSvg = o.localization.localizedSeeds
    .map((s) => {
      if (s.localCorePolygon.length < 3) return ""
      const p = pathFromPoly(s.localCorePolygon, true)
      return `<path d="${escapeXml(p)}" fill="rgba(50,160,120,0.1)" stroke="rgba(30,120,90,0.65)" stroke-width="1.1"/>`
    })
    .join("\n")

  const patchSvg = o.localization.localizedSeeds
    .map((s) => {
      if (s.seedPatchPolygon.length < 2) return ""
      const p = pathFromPoly(s.seedPatchPolygon, true)
      return `<path d="${escapeXml(p)}" fill="rgba(255,200,80,0.2)" stroke="rgba(180,130,20,0.75)" stroke-width="0.95"/>`
    })
    .join("\n")

  const origAnchors = o.majorAnchors
    .map((a) => {
      return `<circle cx="${a.x.toFixed(2)}" cy="${a.y.toFixed(2)}" r="4" fill="rgba(200,200,210,0.85)" stroke="rgba(80,80,90,0.8)" stroke-width="0.9"/>`
    })
    .join("\n")

  const seedMarkers = o.localization.localizedSeeds
    .map((s) => {
      const isFail = s.mode === "failed"
      const isFb = s.mode === "fallback_point"
      const fill = isFail ? "rgba(255,60,60,0.95)" : isFb ? "rgba(255,165,40,0.92)" : "rgba(40,200,95,0.92)"
      const stroke = isFail ? "rgba(120,0,0,0.9)" : isFb ? "rgba(120,70,0,0.9)" : "rgba(0,80,40,0.9)"
      const tag = isFail ? " ✕" : isFb ? " ○" : " ●"
      return `<g>
  <line x1="${s.originalAnchorX.toFixed(2)}" y1="${s.originalAnchorY.toFixed(2)}" x2="${s.localizedSeedX.toFixed(2)}" y2="${s.localizedSeedY.toFixed(
    2
  )}" stroke="rgba(100,100,120,0.35)" stroke-width="0.55" stroke-dasharray="3 2"/>
  <circle cx="${s.localizedSeedX.toFixed(2)}" cy="${s.localizedSeedY.toFixed(2)}" r="5.5" fill="${fill}" stroke="${stroke}" stroke-width="1.2"/>
  <text x="${(s.localizedSeedX + 8).toFixed(2)}" y="${(s.localizedSeedY - 8).toFixed(2)}" font-size="7" fill="#222" font-family="system-ui,sans-serif">${escapeXml(
    (s.displayLabel.length > 18 ? s.displayLabel.slice(0, 16) + "…" : s.displayLabel) + tag
  )}</text>
</g>`
    })
    .join("\n")

  const title = `Anchor seed localization v1 — ${o.localization.seedCount} seed(s); ${o.localization.localCoreSummary}`

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${pb.minX} ${pb.minY} ${w} ${h}" width="${Math.round(w)}" height="${Math.round(
    h
  )}">
<rect x="${pb.minX}" y="${pb.minY}" width="${w}" height="${h}" fill="white"/>
<text x="${pb.minX + 8}" y="${pb.minY + 14}" font-size="11" fill="#222" font-family="system-ui,sans-serif">${escapeXml(title)}</text>
<text x="${pb.minX + 8}" y="${pb.minY + 28}" font-size="7.5" fill="#444" font-family="system-ui,sans-serif">Gray = raw anchor; green ● = local core; orange ○ = fallback; red ✕ = failed; blue box = search window; green fill = pocket hull; yellow = seed patch.</text>
<g>${windowSvg}</g>
<g>${coreSvg}</g>
<g>${patchSvg}</g>
<g>${origAnchors}</g>
<g>${seedMarkers}</g>
<g>${unitStroke}</g>
<rect x="${bx.minX}" y="${bx.minY}" width="${bx.maxX - bx.minX}" height="${bx.maxY - bx.minY}" fill="none" stroke="rgba(0,60,30,0.32)" stroke-width="1.05" stroke-dasharray="5 4"/>
</svg>`
}

/** Map anchor id → localized seed point for region growing (includes failed → snapped-in-unit fallback). */
export function localizedSeedPointByAnchorId(loc: AnchorSeedLocalizationV1Debug | undefined): Map<string, Pt> {
  const m = new Map<string, Pt>()
  if (!loc) return m
  for (const s of loc.localizedSeeds) {
    m.set(s.anchorId, { x: s.localizedSeedX, y: s.localizedSeedY })
  }
  return m
}
