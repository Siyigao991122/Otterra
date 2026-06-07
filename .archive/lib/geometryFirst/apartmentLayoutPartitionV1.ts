import type { RoomLineFaithfulReconstructionV1Debug, RoomLineFaithfulWallRun } from "@/lib/geometryFirst/roomLineFaithfulReconstructionV1"
import type { RoomTextGroupingV1Debug } from "@/lib/geometryFirst/planBodyRoomTextGroupingV1"
import type { HierarchicalSpaceTypingV2Debug } from "@/lib/geometryFirst/planBodyHierarchicalSpaceTypingV2"
import type { GrayWallMassReconstructionV1Debug } from "@/lib/geometryFirst/grayWallMassReconstructionV1"
import type { PlanBoundingBox } from "@/lib/geometryFirst/types"

type Pt = { x: number; y: number }
type RoomType = "enclosed_room" | "open_plan_subzone" | "auxiliary_space"

interface LayoutCell {
  id: string
  ix: number
  iy: number
  minX: number
  minY: number
  maxX: number
  maxY: number
  center: Pt
}

interface RegionSeed {
  regionId: string
  label: string
  roomType: RoomType
  center: Pt
  allowedPolygon: Pt[]
  envelopeId?: string
}

export interface ApartmentLayoutRegionV1 {
  regionId: string
  label: string
  roomType: RoomType
  polygon: Pt[]
  labelCenter: Pt
  cellIds: string[]
  confidence: number
}

export interface ApartmentOpenPlanMacroRegionV1 {
  envelopeId: string
  memberRegionIds: string[]
  memberLabels: string[]
  polygon: Pt[]
  cellIds: string[]
  confidence: number
}

export interface ApartmentLayoutPartitionV1Debug {
  apartmentLayoutPartitionV1: {
    gridCellCount: number
    assignedCellCount: number
    regionCount: number
    enclosedRegionCount: number
    openPlanRegionCount: number
    auxiliaryRegionCount: number
    openPlanMacroRegionCount: number
  }
  layoutRegions: ApartmentLayoutRegionV1[]
  openPlanMacroRegions: ApartmentOpenPlanMacroRegionV1[]
  reconstructionStatement: string
  notes: string[]
}

export interface BuildApartmentLayoutPartitionV1SvgOptions {
  pageBounds: PlanBoundingBox
  partition: ApartmentLayoutPartitionV1Debug
}

const OPT = {
  coordMergeTol: 2,
  wallTol: 5,
  minOverlapRatio: 0.2,
  enclosedSeedRadius: 180,
  auxiliarySeedRadius: 56,
  envelopePad: 6,
  localWallRadius: 150,
} as const

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x))
}

function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
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

function expandBox(b: PlanBoundingBox, pad: number): PlanBoundingBox {
  return { minX: b.minX - pad, minY: b.minY - pad, maxX: b.maxX + pad, maxY: b.maxY + pad }
}

function unionBoxes(a: PlanBoundingBox, b: PlanBoundingBox): PlanBoundingBox {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  }
}

function boxToPoly(b: PlanBoundingBox): Pt[] {
  return [
    { x: b.minX, y: b.minY },
    { x: b.maxX, y: b.minY },
    { x: b.maxX, y: b.maxY },
    { x: b.minX, y: b.maxY },
  ]
}

function cleanRoomLabel(label: string): string {
  const tokens = label.replace(/\s+/g, " ").trim().split(" ")
  const firstDimIdx = tokens.findIndex((token, idx) => {
    const t = token.trim()
    if (!/\d/.test(t)) return false
    if (/[’'′"″-]/.test(t)) return true
    const next = tokens[idx + 1]?.trim().toLowerCase()
    return next === "x"
  })
  return (firstDimIdx > 0 ? tokens.slice(0, firstDimIdx) : tokens).join(" ").trim()
}

function centerOfPoly(poly: Pt[]): Pt {
  if (!poly.length) return { x: 0, y: 0 }
  let sx = 0
  let sy = 0
  for (const p of poly) {
    sx += p.x
    sy += p.y
  }
  return { x: sx / poly.length, y: sy / poly.length }
}

function selectMaskVoidPolygon(
  center: Pt,
  grayWallMass: GrayWallMassReconstructionV1Debug | undefined,
  fallback: Pt[],
  roomType: RoomType
): Pt[] {
  const candidates = (grayWallMass?.recoveredRoomVoids ?? []).filter((v) =>
    roomType === "open_plan_subzone" ? true : v.roomLike
  )
  if (!candidates.length) return fallback
  const containing = candidates.find((v) => pointInPoly(center, v.polygon))
  if (containing) return containing.polygon
  let best = candidates[0]!
  let bestScore = dist(best.center, center)
  for (const v of candidates) {
    const score = dist(v.center, center)
    if (score < bestScore) {
      bestScore = score
      best = v
    }
  }
  return bestScore <= (roomType === "auxiliary_space" ? 64 : 92) ? best.polygon : fallback
}

function pointInPoly(pt: Pt, poly: Pt[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!
    const b = poly[j]!
    const hit = a.y > pt.y !== b.y > pt.y && pt.x < ((b.x - a.x) * (pt.y - a.y)) / Math.max(1e-6, b.y - a.y) + a.x
    if (hit) inside = !inside
  }
  return inside
}

function uniqueSorted(values: number[]): number[] {
  const s = [...values].sort((a, b) => a - b)
  const out: number[] = []
  for (const v of s) {
    if (!out.length || Math.abs(v - out[out.length - 1]!) > OPT.coordMergeTol) out.push(v)
  }
  return out
}

function overlapLen(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0))
}

function overlapRatio(a0: number, a1: number, b0: number, b1: number): number {
  const ov = overlapLen(a0, a1, b0, b1)
  const denom = Math.max(1, Math.min(a1 - a0, b1 - b0))
  return ov / denom
}

function isVertical(run: RoomLineFaithfulWallRun): boolean {
  return Math.abs(run.x1 - run.x2) <= Math.abs(run.y1 - run.y2)
}

function buildGridCells(faithful: RoomLineFaithfulReconstructionV1Debug, unitPolygon: Pt[]): { xs: number[]; ys: number[]; cells: LayoutCell[] } {
  const unitBox = bboxOfPoly(unitPolygon)
  const solidRuns = faithful.wallRuns.filter((run) => run.wallClass === "exterior_wall" || run.wallClass === "interior_wall")
  const xVals = [unitBox.minX, unitBox.maxX]
  const yVals = [unitBox.minY, unitBox.maxY]
  for (const run of solidRuns) {
    if (isVertical(run)) {
      xVals.push((run.x1 + run.x2) / 2)
      yVals.push(run.y1, run.y2)
    } else {
      yVals.push((run.y1 + run.y2) / 2)
      xVals.push(run.x1, run.x2)
    }
  }
  const xs = uniqueSorted(xVals)
  const ys = uniqueSorted(yVals)
  const cells: LayoutCell[] = []
  for (let ix = 0; ix < xs.length - 1; ix++) {
    for (let iy = 0; iy < ys.length - 1; iy++) {
      const minX = xs[ix]!
      const maxX = xs[ix + 1]!
      const minY = ys[iy]!
      const maxY = ys[iy + 1]!
      if (maxX - minX < 4 || maxY - minY < 4) continue
      const center = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 }
      if (!pointInPoly(center, unitPolygon)) continue
      cells.push({ id: `c:${ix}:${iy}`, ix, iy, minX, minY, maxX, maxY, center })
    }
  }
  return { xs, ys, cells }
}

function buildBlockedBoundaries(
  faithful: RoomLineFaithfulReconstructionV1Debug,
  xs: number[],
  ys: number[],
  cells: LayoutCell[]
): { blockedV: Set<string>; blockedH: Set<string>; cellMap: Map<string, LayoutCell> } {
  const blockedV = new Set<string>()
  const blockedH = new Set<string>()
  const cellMap = new Map(cells.map((c) => [c.id, c]))
  const solidRuns = faithful.wallRuns.filter((run) => run.wallClass === "exterior_wall" || run.wallClass === "interior_wall")
  for (const run of solidRuns) {
    if (isVertical(run)) {
      const x = (run.x1 + run.x2) / 2
      const xi = xs.findIndex((v) => Math.abs(v - x) <= OPT.wallTol)
      if (xi <= 0) continue
      for (let iy = 0; iy < ys.length - 1; iy++) {
        const ov = overlapRatio(ys[iy]!, ys[iy + 1]!, Math.min(run.y1, run.y2), Math.max(run.y1, run.y2))
        if (ov >= OPT.minOverlapRatio) blockedV.add(`${xi}:${iy}`)
      }
    } else {
      const y = (run.y1 + run.y2) / 2
      const yi = ys.findIndex((v) => Math.abs(v - y) <= OPT.wallTol)
      if (yi <= 0) continue
      for (let ix = 0; ix < xs.length - 1; ix++) {
        const ov = overlapRatio(xs[ix]!, xs[ix + 1]!, Math.min(run.x1, run.x2), Math.max(run.x1, run.x2))
        if (ov >= OPT.minOverlapRatio) blockedH.add(`${ix}:${yi}`)
      }
    }
  }
  return { blockedV, blockedH, cellMap }
}

function buildSeeds(
  grouping: RoomTextGroupingV1Debug,
  typing: HierarchicalSpaceTypingV2Debug,
  faithful: RoomLineFaithfulReconstructionV1Debug,
  effectiveUnitPolygon: Pt[],
  grayWallMass?: GrayWallMassReconstructionV1Debug
): RegionSeed[] {
  const seeds: RegionSeed[] = []
  const unitBox = bboxOfPoly(effectiveUnitPolygon)
  const unitArea = polygonArea(effectiveUnitPolygon)
  const solidRuns = faithful.wallRuns.filter((run) => run.wallClass === "exterior_wall" || run.wallClass === "interior_wall")
  const localWallPolygon = (center: Pt, fallback: Pt[]): Pt[] => {
    const near = solidRuns.filter((run) => {
      const mx = (run.x1 + run.x2) / 2
      const my = (run.y1 + run.y2) / 2
      return dist(center, { x: mx, y: my }) <= OPT.localWallRadius
    })
    if (!near.length) return fallback
    const nearBox = expandBox(
      bboxOfPoly(
        near.flatMap((run) => [
          { x: run.x1, y: run.y1 },
          { x: run.x2, y: run.y2 },
        ])
      ),
      10
    )
    const fallbackBox = expandBox(bboxOfPoly(fallback), 16)
    const box = unionBoxes(nearBox, fallbackBox)
    return boxToPoly({
      minX: Math.max(unitBox.minX, box.minX),
      minY: Math.max(unitBox.minY, box.minY),
      maxX: Math.min(unitBox.maxX, box.maxX),
      maxY: Math.min(unitBox.maxY, box.maxY),
    })
  }

  for (const cand of typing.enclosedRoomCandidates) {
    const anchor = typing.enclosedRoomAnchors.find((a) => a.anchorId === cand.anchorId)
    const center = anchor ? { x: anchor.x, y: anchor.y } : { x: (cand.bbox.minX + cand.bbox.maxX) / 2, y: (cand.bbox.minY + cand.bbox.maxY) / 2 }
    const localPoly = localWallPolygon(center, cand.polygon)
    seeds.push({
      regionId: cand.anchorId,
      label: cleanRoomLabel(anchor?.displayLabel ?? cand.normalizedLabel),
      roomType: "enclosed_room",
      center,
      allowedPolygon: selectMaskVoidPolygon(center, grayWallMass, localPoly, "enclosed_room"),
    })
  }
  for (const sub of typing.openPlanSubzoneAnchors) {
    const assign = typing.subzoneAssignments.find((a) => a.anchorId === sub.anchorId)
    const env = typing.openPlanEnvelopeCandidates.find((e) => e.envelopeId === assign?.envelopeId) ?? typing.openPlanEnvelopeCandidates[0]
    if (!env) continue
    const envPoly = polygonArea(env.polygon) >= unitArea * 0.12 ? env.polygon : effectiveUnitPolygon
    seeds.push({
      regionId: sub.anchorId,
      label: cleanRoomLabel(sub.displayLabel),
      roomType: "open_plan_subzone",
      center: { x: sub.x, y: sub.y },
      allowedPolygon: envPoly,
      envelopeId: assign?.envelopeId ?? env.envelopeId,
    })
  }
  for (const aux of typing.auxiliaryAnchors) {
    const grp = grouping.labelGroups.find((g) => g.groupId === aux.groupId)
    const near = faithful.wallRuns.filter((run) => dist({ x: (run.x1 + run.x2) / 2, y: (run.y1 + run.y2) / 2 }, { x: aux.centerX, y: aux.centerY }) <= 56)
    let allowedPolygon: Pt[]
    if (near.length) {
      const pts = near.flatMap((run) => [{ x: run.x1, y: run.y1 }, { x: run.x2, y: run.y2 }])
      const b = expandBox(bboxOfPoly(pts), 6)
      allowedPolygon = [
        { x: b.minX, y: b.minY },
        { x: b.maxX, y: b.minY },
        { x: b.maxX, y: b.maxY },
        { x: b.minX, y: b.maxY },
      ]
    } else {
      const b = { minX: aux.centerX - 20, minY: aux.centerY - 20, maxX: aux.centerX + 20, maxY: aux.centerY + 20 }
      allowedPolygon = [
        { x: b.minX, y: b.minY },
        { x: b.maxX, y: b.minY },
        { x: b.maxX, y: b.maxY },
        { x: b.minX, y: b.maxY },
      ]
    }
    seeds.push({
      regionId: aux.groupId,
      label: cleanRoomLabel(grp?.joinedLabel ?? aux.displayLabel),
      roomType: "auxiliary_space",
      center: { x: aux.centerX, y: aux.centerY },
      allowedPolygon: selectMaskVoidPolygon({ x: aux.centerX, y: aux.centerY }, grayWallMass, allowedPolygon, "auxiliary_space"),
    })
  }
  return seeds
}

function nearestSeedCell(seed: RegionSeed, cells: LayoutCell[], claimed: Set<string>): LayoutCell | null {
  let best: LayoutCell | null = null
  let bestScore = Infinity
  for (const cell of cells) {
    if (claimed.has(cell.id)) continue
    if (!pointInPoly(cell.center, seed.allowedPolygon)) continue
    const d = dist(cell.center, seed.center)
    if (d < bestScore) {
      bestScore = d
      best = cell
    }
  }
  return best
}

function nearestSeedCellInSet(seed: RegionSeed, cells: LayoutCell[]): LayoutCell | null {
  let best: LayoutCell | null = null
  let bestScore = Infinity
  for (const cell of cells) {
    const d = dist(cell.center, seed.center)
    if (d < bestScore) {
      bestScore = d
      best = cell
    }
  }
  return best
}

function neighbors(cell: LayoutCell, cellMap: Map<string, LayoutCell>, blockedV: Set<string>, blockedH: Set<string>): LayoutCell[] {
  const out: LayoutCell[] = []
  const leftKey = `c:${cell.ix - 1}:${cell.iy}`
  const rightKey = `c:${cell.ix + 1}:${cell.iy}`
  const upKey = `c:${cell.ix}:${cell.iy - 1}`
  const downKey = `c:${cell.ix}:${cell.iy + 1}`
  if (cell.ix > 0 && !blockedV.has(`${cell.ix}:${cell.iy}`)) {
    const c = cellMap.get(leftKey)
    if (c) out.push(c)
  }
  if (!blockedV.has(`${cell.ix + 1}:${cell.iy}`)) {
    const c = cellMap.get(rightKey)
    if (c) out.push(c)
  }
  if (cell.iy > 0 && !blockedH.has(`${cell.ix}:${cell.iy}`)) {
    const c = cellMap.get(upKey)
    if (c) out.push(c)
  }
  if (!blockedH.has(`${cell.ix}:${cell.iy + 1}`)) {
    const c = cellMap.get(downKey)
    if (c) out.push(c)
  }
  return out
}

function growRegionCells(
  seed: RegionSeed,
  start: LayoutCell,
  cells: LayoutCell[],
  cellMap: Map<string, LayoutCell>,
  blockedV: Set<string>,
  blockedH: Set<string>,
  claimed: Set<string>
): LayoutCell[] {
  const out: LayoutCell[] = []
  const q: LayoutCell[] = [start]
  const seen = new Set<string>([start.id])
  while (q.length) {
    const cur = q.shift()!
    if (claimed.has(cur.id)) continue
    if (!pointInPoly(cur.center, seed.allowedPolygon) && seed.roomType !== "open_plan_subzone") continue
    const d = dist(cur.center, seed.center)
    const maxDist = seed.roomType === "enclosed_room" ? OPT.enclosedSeedRadius : seed.roomType === "auxiliary_space" ? OPT.auxiliarySeedRadius : Infinity
    if (d > maxDist && seed.roomType !== "open_plan_subzone") continue
    out.push(cur)
    for (const nxt of neighbors(cur, cellMap, blockedV, blockedH)) {
      if (seen.has(nxt.id) || claimed.has(nxt.id)) continue
      if (seed.roomType !== "open_plan_subzone" && !pointInPoly(nxt.center, seed.allowedPolygon)) continue
      seen.add(nxt.id)
      q.push(nxt)
    }
  }
  return out
}

function buildOpenPlanMacroRegions(
  seeds: RegionSeed[],
  cells: LayoutCell[],
  claimed: Set<string>,
  cellMap: Map<string, LayoutCell>,
  blockedV: Set<string>,
  blockedH: Set<string>
): {
  macroRegions: ApartmentOpenPlanMacroRegionV1[]
  cellsByEnvelope: Map<string, LayoutCell[]>
  startsByEnvelope: Map<string, Map<string, LayoutCell>>
} {
  const byEnvelope = new Map<string, RegionSeed[]>()
  for (const seed of seeds) {
    if (!seed.envelopeId) continue
    const arr = byEnvelope.get(seed.envelopeId) ?? []
    arr.push(seed)
    byEnvelope.set(seed.envelopeId, arr)
  }

  const macroRegions: ApartmentOpenPlanMacroRegionV1[] = []
  const cellsByEnvelope = new Map<string, LayoutCell[]>()
  const startsByEnvelope = new Map<string, Map<string, LayoutCell>>()
  for (const [envelopeId, group] of byEnvelope) {
    const envelope = group[0]!.allowedPolygon
    const candidates = cells.filter((cell) => !claimed.has(cell.id) && pointInPoly(cell.center, envelope))
    const startMap = new Map<string, LayoutCell>()
    for (const seed of group) {
      const start = nearestSeedCellInSet(seed, candidates)
      if (start) startMap.set(seed.regionId, start)
    }
    const macroCells = candidates
    if (!macroCells.length) continue
    cellsByEnvelope.set(envelopeId, macroCells)
    startsByEnvelope.set(envelopeId, startMap)
    macroRegions.push({
      envelopeId,
      memberRegionIds: group.map((seed) => seed.regionId),
      memberLabels: group.map((seed) => seed.label),
      polygon: cellsToPolygon(macroCells, "bbox-if-multi"),
      cellIds: macroCells.map((cell) => cell.id),
      confidence: clamp01(macroCells.length / 18),
    })
    for (const cell of macroCells) {
      claimed.add(cell.id)
    }
  }
  return { macroRegions, cellsByEnvelope, startsByEnvelope }
}

function assignOpenPlanCells(
  seeds: RegionSeed[],
  macroCellsByEnvelope: Map<string, LayoutCell[]>,
  startsByEnvelope: Map<string, Map<string, LayoutCell>>,
  cellMap: Map<string, LayoutCell>,
  blockedV: Set<string>,
  blockedH: Set<string>
): Map<string, LayoutCell[]> {
  const byEnvelope = new Map<string, RegionSeed[]>()
  for (const seed of seeds) {
    if (!seed.envelopeId) continue
    const arr = byEnvelope.get(seed.envelopeId) ?? []
    arr.push(seed)
    byEnvelope.set(seed.envelopeId, arr)
  }

  const out = new Map<string, LayoutCell[]>()
  for (const [envelopeId, group] of byEnvelope) {
    const macroCells = macroCellsByEnvelope.get(envelopeId) ?? []
    const startMap = startsByEnvelope.get(envelopeId) ?? new Map<string, LayoutCell>()
    if (!macroCells.length || !startMap.size) continue
    const macroIds = new Set(macroCells.map((cell) => cell.id))
    const owner = new Map<string, string>()
    const q: Array<{ cell: LayoutCell; regionId: string }> = []
    for (const seed of group) {
      const start = startMap.get(seed.regionId)
      if (!start) continue
      if (!owner.has(start.id)) {
        owner.set(start.id, seed.regionId)
        q.push({ cell: start, regionId: seed.regionId })
      }
    }
    while (q.length) {
      const { cell, regionId } = q.shift()!
      for (const nxt of neighbors(cell, cellMap, blockedV, blockedH)) {
        if (!macroIds.has(nxt.id) || owner.has(nxt.id)) continue
        owner.set(nxt.id, regionId)
        q.push({ cell: nxt, regionId })
      }
    }
    for (const cell of macroCells) {
      if (owner.has(cell.id)) continue
      let best = group[0]!
      let bestDist = dist(cell.center, best.center)
      for (let i = 1; i < group.length; i++) {
        const d = dist(cell.center, group[i]!.center)
        if (d < bestDist) {
          bestDist = d
          best = group[i]!
        }
      }
      owner.set(cell.id, best.regionId)
    }
    for (const cell of macroCells) {
      const regionId = owner.get(cell.id)
      if (!regionId) continue
      const arr = out.get(regionId) ?? []
      arr.push(cell)
      out.set(regionId, arr)
    }
  }
  return out
}

function polygonArea(poly: Pt[]): number {
  if (poly.length < 3) return 0
  let sum = 0
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!
    const b = poly[(i + 1) % poly.length]!
    sum += a.x * b.y - b.x * a.y
  }
  return Math.abs(sum / 2)
}

function cellsToLoops(cells: LayoutCell[]): Pt[][] {
  if (!cells.length) return []
  const ids = new Set(cells.map((c) => c.id))
  const edges = new Map<string, { start: Pt; end: Pt }>()
  const key = (p: Pt) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`
  const add = (a: Pt, b: Pt) => edges.set(`${key(a)}>${key(b)}`, { start: a, end: b })
  const delIfReverse = (a: Pt, b: Pt): boolean => {
    const rk = `${key(b)}>${key(a)}`
    if (edges.has(rk)) {
      edges.delete(rk)
      return true
    }
    return false
  }
  for (const c of cells) {
    const left = ids.has(`c:${c.ix - 1}:${c.iy}`)
    const right = ids.has(`c:${c.ix + 1}:${c.iy}`)
    const up = ids.has(`c:${c.ix}:${c.iy - 1}`)
    const down = ids.has(`c:${c.ix}:${c.iy + 1}`)
    if (!up && !delIfReverse({ x: c.minX, y: c.minY }, { x: c.maxX, y: c.minY })) add({ x: c.minX, y: c.minY }, { x: c.maxX, y: c.minY })
    if (!right && !delIfReverse({ x: c.maxX, y: c.minY }, { x: c.maxX, y: c.maxY })) add({ x: c.maxX, y: c.minY }, { x: c.maxX, y: c.maxY })
    if (!down && !delIfReverse({ x: c.maxX, y: c.maxY }, { x: c.minX, y: c.maxY })) add({ x: c.maxX, y: c.maxY }, { x: c.minX, y: c.maxY })
    if (!left && !delIfReverse({ x: c.minX, y: c.maxY }, { x: c.minX, y: c.minY })) add({ x: c.minX, y: c.maxY }, { x: c.minX, y: c.minY })
  }
  const byStart = new Map<string, { start: Pt; end: Pt }[]>()
  for (const edge of edges.values()) {
    const arr = byStart.get(key(edge.start)) ?? []
    arr.push(edge)
    byStart.set(key(edge.start), arr)
  }
  const visited = new Set<string>()
  const loops: Pt[][] = []
  for (const [ek, edge] of edges) {
    if (visited.has(ek)) continue
    const loop: Pt[] = [edge.start]
    let cur = edge
    visited.add(ek)
    let guard = 0
    while (guard++ < 2000) {
      loop.push(cur.end)
      const nextList = byStart.get(key(cur.end)) ?? []
      const next = nextList.find((e) => !visited.has(`${key(e.start)}>${key(e.end)}`))
      if (!next) break
      visited.add(`${key(next.start)}>${key(next.end)}`)
      cur = next
      if (key(cur.end) === key(loop[0]!)) {
        loop.push(loop[0]!)
        break
      }
    }
    if (loop.length >= 4) loops.push(loop.slice(0, -1))
  }
  loops.sort((a, b) => polygonArea(b) - polygonArea(a))
  return loops
}

function cellsToPolygon(cells: LayoutCell[], mode: "largest" | "bbox-if-multi" = "largest"): Pt[] {
  if (!cells.length) return []
  const loops = cellsToLoops(cells)
  if (loops.length === 1) return loops[0]!
  if (loops.length > 1 && mode === "bbox-if-multi") {
    const b = bboxOfPoly(cells.flatMap((c) => [{ x: c.minX, y: c.minY }, { x: c.maxX, y: c.maxY }]))
    return boxToPoly(b)
  }
  if (loops.length) return loops[0]!
  const b = bboxOfPoly(cells.flatMap((c) => [{ x: c.minX, y: c.minY }, { x: c.maxX, y: c.maxY }]))
  return [
    { x: b.minX, y: b.minY },
    { x: b.maxX, y: b.minY },
    { x: b.maxX, y: b.maxY },
    { x: b.minX, y: b.maxY },
  ]
}

export function buildApartmentLayoutPartitionV1(
  faithful: RoomLineFaithfulReconstructionV1Debug,
  grouping: RoomTextGroupingV1Debug,
  typing: HierarchicalSpaceTypingV2Debug,
  effectiveUnitPolygon: Pt[],
  grayWallMass?: GrayWallMassReconstructionV1Debug
): ApartmentLayoutPartitionV1Debug {
  const notes: string[] = []
  const { xs, ys, cells } = buildGridCells(faithful, effectiveUnitPolygon)
  const { blockedV, blockedH, cellMap } = buildBlockedBoundaries(faithful, xs, ys, cells)
  const seeds = buildSeeds(grouping, typing, faithful, effectiveUnitPolygon, grayWallMass)
  const claimed = new Set<string>()
  const regions: ApartmentLayoutRegionV1[] = []
  const openPlanMacroRegions: ApartmentOpenPlanMacroRegionV1[] = []

  for (const seed of seeds.filter((s) => s.roomType === "enclosed_room")) {
    const start = nearestSeedCell(seed, cells, claimed)
    if (!start) continue
    const regionCells = growRegionCells(seed, start, cells, cellMap, blockedV, blockedH, claimed)
    for (const c of regionCells) claimed.add(c.id)
    if (!regionCells.length) continue
    const polygon = cellsToPolygon(regionCells)
    regions.push({
      regionId: seed.regionId,
      label: seed.label,
      roomType: seed.roomType,
      polygon,
      labelCenter: pointInPoly(seed.center, polygon) ? seed.center : centerOfPoly(polygon),
      cellIds: regionCells.map((c) => c.id),
      confidence: clamp01(regionCells.length / 6),
    })
  }

  const openPlanSeeds = seeds.filter((s) => s.roomType === "open_plan_subzone")
  const openPlanMacro = buildOpenPlanMacroRegions(openPlanSeeds, cells, claimed, cellMap, blockedV, blockedH)
  openPlanMacroRegions.push(...openPlanMacro.macroRegions)
  const openAssignments = assignOpenPlanCells(
    openPlanSeeds,
    openPlanMacro.cellsByEnvelope,
    openPlanMacro.startsByEnvelope,
    cellMap,
    blockedV,
    blockedH
  )
  for (const seed of openPlanSeeds) {
    const regionCells = openAssignments.get(seed.regionId) ?? []
    if (!regionCells.length) continue
    const polygon = cellsToPolygon(regionCells, "bbox-if-multi")
    regions.push({
      regionId: seed.regionId,
      label: seed.label,
      roomType: seed.roomType,
      polygon,
      labelCenter: pointInPoly(seed.center, polygon) ? seed.center : centerOfPoly(polygon),
      cellIds: regionCells.map((c) => c.id),
      confidence: clamp01(regionCells.length / 10),
    })
  }

  for (const seed of seeds.filter((s) => s.roomType === "auxiliary_space")) {
    const start = nearestSeedCell(seed, cells, claimed)
    if (!start) continue
    const regionCells = growRegionCells(seed, start, cells, cellMap, blockedV, blockedH, claimed)
    for (const c of regionCells) claimed.add(c.id)
    if (!regionCells.length) continue
    const polygon = cellsToPolygon(regionCells)
    regions.push({
      regionId: seed.regionId,
      label: seed.label,
      roomType: seed.roomType,
      polygon,
      labelCenter: pointInPoly(seed.center, polygon) ? seed.center : centerOfPoly(polygon),
      cellIds: regionCells.map((c) => c.id),
      confidence: clamp01(regionCells.length / 6),
    })
  }

  notes.push(`Layout partition grid: ${xs.length - 1}×${ys.length - 1} candidate bins, ${cells.length} in-unit cells.`)
  if (openPlanMacroRegions.length) {
    notes.push(`Open-plan macro regions: ${openPlanMacroRegions.length} connected envelope region(s) built before subzone splitting.`)
  }
  if (grayWallMass?.recoveredRoomVoids.length) {
    notes.push(`Gray wall mass priors constrained enclosed/auxiliary seed ranges with ${grayWallMass.recoveredRoomVoids.length} recovered void region(s).`)
  }
  notes.push(`Assigned ${claimed.size}/${cells.length} cells to ${regions.length} room region(s) before wall-topology binding.`)

  return {
    apartmentLayoutPartitionV1: {
      gridCellCount: cells.length,
      assignedCellCount: claimed.size,
      regionCount: regions.length,
      enclosedRegionCount: regions.filter((r) => r.roomType === "enclosed_room").length,
      openPlanRegionCount: regions.filter((r) => r.roomType === "open_plan_subzone").length,
      auxiliaryRegionCount: regions.filter((r) => r.roomType === "auxiliary_space").length,
      openPlanMacroRegionCount: openPlanMacroRegions.length,
    },
    layoutRegions: regions,
    openPlanMacroRegions,
    reconstructionStatement:
      `Apartment layout partition v1: ${regions.length} region(s) from ${cells.length} in-unit grid cells, ${claimed.size} assigned; ` +
      `${regions.filter((r) => r.roomType === "enclosed_room").length} enclosed / ${regions.filter((r) => r.roomType === "open_plan_subzone").length} open-plan / ${regions.filter((r) => r.roomType === "auxiliary_space").length} auxiliary; ` +
      `${openPlanMacroRegions.length} open-plan macro region(s).`,
    notes,
  }
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

function palette(idx: number): { stroke: string; fill: string } {
  const colors = [
    ["#2563eb", "rgba(37,99,235,0.10)"],
    ["#16a34a", "rgba(22,163,74,0.10)"],
    ["#7c3aed", "rgba(124,58,237,0.10)"],
    ["#d97706", "rgba(217,119,6,0.10)"],
    ["#dc2626", "rgba(220,38,38,0.10)"],
    ["#0f766e", "rgba(15,118,110,0.10)"],
  ] as const
  const e = colors[idx % colors.length]!
  return { stroke: e[0], fill: e[1] }
}

export function buildApartmentLayoutPartitionV1SvgString(
  o: BuildApartmentLayoutPartitionV1SvgOptions
): string {
  const pb = o.pageBounds
  const w = pb.maxX - pb.minX
  const h = pb.maxY - pb.minY
  const macros = o.partition.openPlanMacroRegions
    .map(
      (macro) =>
        `<path d="${escapeXml(pathFromPoly(macro.polygon, true))}" fill="rgba(59,130,246,0.04)" stroke="rgba(59,130,246,0.35)" stroke-width="1.0" stroke-dasharray="6 4"/>`
    )
    .join("")
  const polys = o.partition.layoutRegions
    .map((r, idx) => {
      const c = palette(idx)
      return `<g><path d="${escapeXml(pathFromPoly(r.polygon, true))}" fill="${c.fill}" stroke="${c.stroke}" stroke-width="1.2"/><text x="${r.labelCenter.x.toFixed(1)}" y="${r.labelCenter.y.toFixed(1)}" font-size="7.5" fill="${c.stroke}" font-family="system-ui,sans-serif">${escapeXml(r.label)}</text></g>`
    })
    .join("")
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${pb.minX} ${pb.minY} ${w} ${h}" width="${Math.round(w)}" height="${Math.round(h)}">
<rect x="${pb.minX}" y="${pb.minY}" width="${w}" height="${h}" fill="white"/>
<text x="${pb.minX + 8}" y="${pb.minY + 14}" font-size="11" fill="#222" font-family="system-ui,sans-serif">${escapeXml(o.partition.reconstructionStatement)}</text>
<text x="${pb.minX + 8}" y="${pb.minY + 28}" font-size="7.5" fill="#444" font-family="system-ui,sans-serif">Blue dashed = connected open-plan macro region; colored polygons = wall-driven apartment layout regions before room topology binding.</text>
<g>${macros}</g>
<g>${polys}</g>
</svg>`
}
