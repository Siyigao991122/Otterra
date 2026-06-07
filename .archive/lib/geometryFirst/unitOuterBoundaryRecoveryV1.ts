/**
 * Debug-only **unit outer boundary recovery v1**: recover the true non-rectangular
 * outer shell of the apartment by:
 *  1. Filtering raw PDF segments to wall-like axis-aligned strokes
 *  2. Computing the floor-plan extent anchored on primaryLayoutBBox
 *  3. Building a scan-line silhouette: for each row, find leftmost/rightmost
 *     wall evidence; for each column, topmost/bottommost — then intersect
 *  4. Extracting and simplifying the boundary polygon
 *
 * This bypasses the existing shell-loop / bridge / regularization chain which
 * relies on a potentially-too-narrow `primaryLayoutBBox`.
 */

import type { ExtractedLineSegment, ExtractedTextRun, PlanBoundingBox } from "@/lib/geometryFirst/types"
import {
  normalizePlanBodyRoomLabelV0,
  classifyPlanTextAnchorKindV0,
} from "@/lib/geometryFirst/planBodyRoomTextAttributionV0"

type Pt = { x: number; y: number }

const U1 = {
  gridRes: 2.0,
  pagePad: 10,
  minWallLen: 12,
  axisAngleTol: 0.12,
  wallRasterThick: 1,
  rdpEpsilon: 3.0,
  axisSnapThreshold: 4.0,
  blankMinCells: 60,
  /** Min segment length to include in the extent expansion. */
  extentMinSegLen: 20,
  /** How far (pt) beyond the primaryLayoutBBox to look for connected segments. */
  extentExpandReach: 30,
  /** Morphological close radius (cells) for sealing small wall gaps. */
  morphCloseRadius: 3,
  /** Minimum occupancy in a row/column to count as "has wall evidence". */
  scanMinWallCells: 2,
} as const

/* ──── geometry helpers ──── */

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

function polygonAbsArea(pts: Pt[]): number {
  if (pts.length < 3) return 0
  let a = 0
  const n = pts.length
  for (let i = 0; i < n; i++) {
    const p = pts[i]!, q = pts[(i + 1) % n]!
    a += p.x * q.y - q.x * p.y
  }
  return Math.abs(a / 2)
}

/* ──── grid ──── */

interface Grid {
  minX: number; minY: number; cell: number; gw: number; gh: number
}

function makeGrid(extent: PlanBoundingBox, pad: number): Grid {
  const minX = extent.minX - pad
  const minY = extent.minY - pad
  const w = extent.maxX - extent.minX + 2 * pad
  const h = extent.maxY - extent.minY + 2 * pad
  const cell = U1.gridRes
  const gw = Math.max(24, Math.ceil(w / cell))
  const gh = Math.max(24, Math.ceil(h / cell))
  return { minX, minY, cell, gw, gh }
}

function cellCenter(i: number, j: number, g: Grid): Pt {
  return { x: g.minX + (i + 0.5) * g.cell, y: g.minY + (j + 0.5) * g.cell }
}

function cellIdx(i: number, j: number, gw: number): number {
  return j * gw + i
}

/* ──── wall-like segment filtering ──── */

interface WallSeg {
  x1: number; y1: number; x2: number; y2: number
  orient: "H" | "V"
  len: number
  perpCoord: number
  axisMin: number; axisMax: number
  mx: number; my: number
}

function filterWallSegments(allSegments: ExtractedLineSegment[]): WallSeg[] {
  const out: WallSeg[] = []
  for (const s of allSegments) {
    const dx = s.x2 - s.x1, dy = s.y2 - s.y1
    const L = Math.hypot(dx, dy)
    if (L < U1.minWallLen) continue
    const angle = Math.atan2(Math.abs(dy), Math.abs(dx))
    if (angle < U1.axisAngleTol) {
      out.push({
        x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2,
        orient: "H", len: L,
        perpCoord: (s.y1 + s.y2) / 2,
        axisMin: Math.min(s.x1, s.x2), axisMax: Math.max(s.x1, s.x2),
        mx: (s.x1 + s.x2) / 2, my: (s.y1 + s.y2) / 2,
      })
    } else if (angle > Math.PI / 2 - U1.axisAngleTol) {
      out.push({
        x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2,
        orient: "V", len: L,
        perpCoord: (s.x1 + s.x2) / 2,
        axisMin: Math.min(s.y1, s.y2), axisMax: Math.max(s.y1, s.y2),
        mx: (s.x1 + s.x2) / 2, my: (s.y1 + s.y2) / 2,
      })
    }
  }
  return out
}

/**
 * Compute the true floor-plan extent by starting from `primaryLayoutBBox`
 * and iteratively expanding to include long wall segments and major room labels
 * that touch the current extent.
 */
function computeFloorPlanExtent(
  wallSegs: WallSeg[],
  pageBounds: PlanBoundingBox,
  primaryLayoutBBox: PlanBoundingBox,
  majorRoomLabels: Pt[],
): PlanBoundingBox {
  let { minX, minY, maxX, maxY } = { ...primaryLayoutBBox }
  const reach = U1.extentExpandReach

  let changed = true
  let iter = 0
  while (changed && iter < 12) {
    changed = false
    iter++
    for (const w of wallSegs) {
      if (w.len < U1.extentMinSegLen) continue
      const touchesX = w.mx >= minX - reach && w.mx <= maxX + reach
      const touchesY = w.my >= minY - reach && w.my <= maxY + reach
      if (!touchesX || !touchesY) continue

      const pts = [
        { x: w.x1, y: w.y1 }, { x: w.x2, y: w.y2 },
      ]
      for (const p of pts) {
        if (p.x >= minX - reach && p.x <= maxX + reach && p.y >= minY - reach && p.y <= maxY + reach) {
          if (p.x < minX) { minX = Math.max(pageBounds.minX, p.x - 5); changed = true }
          if (p.x > maxX) { maxX = Math.min(pageBounds.maxX, p.x + 5); changed = true }
          if (p.y < minY) { minY = Math.max(pageBounds.minY, p.y - 5); changed = true }
          if (p.y > maxY) { maxY = Math.min(pageBounds.maxY, p.y + 5); changed = true }
        }
      }
    }
    for (const lbl of majorRoomLabels) {
      if (lbl.x >= minX - reach && lbl.x <= maxX + reach && lbl.y >= minY - reach && lbl.y <= maxY + reach) {
        if (lbl.x < minX) { minX = Math.max(pageBounds.minX, lbl.x - 20); changed = true }
        if (lbl.x > maxX) { maxX = Math.min(pageBounds.maxX, lbl.x + 20); changed = true }
        if (lbl.y < minY) { minY = Math.max(pageBounds.minY, lbl.y - 20); changed = true }
        if (lbl.y > maxY) { maxY = Math.min(pageBounds.maxY, lbl.y + 20); changed = true }
      }
    }
  }

  return { minX, minY, maxX, maxY }
}

/* ──── rasterize wall segments onto grid ──── */

function rasterizeWalls(wallSegs: WallSeg[], g: Grid, extent: PlanBoundingBox): Uint8Array {
  const N = g.gw * g.gh
  const mask = new Uint8Array(N)
  const thick = U1.wallRasterThick

  for (const w of wallSegs) {
    if (w.mx < extent.minX - 15 || w.mx > extent.maxX + 15) continue
    if (w.my < extent.minY - 15 || w.my > extent.maxY + 15) continue
    const L = Math.hypot(w.x2 - w.x1, w.y2 - w.y1)
    const steps = Math.max(1, Math.ceil(L / (g.cell * 0.35)))
    for (let t = 0; t <= steps; t++) {
      const u = t / steps
      const x = w.x1 + u * (w.x2 - w.x1)
      const y = w.y1 + u * (w.y2 - w.y1)
      const ci = Math.floor((x - g.minX) / g.cell)
      const cj = Math.floor((y - g.minY) / g.cell)
      for (let di = -thick; di <= thick; di++) {
        for (let dj = -thick; dj <= thick; dj++) {
          const ii = ci + di, jj = cj + dj
          if (ii >= 0 && jj >= 0 && ii < g.gw && jj < g.gh) mask[cellIdx(ii, jj, g.gw)] = 1
        }
      }
    }
  }
  return mask
}

/* ──── morphological close (dilate then erode) ──── */

function morphClose(mask: Uint8Array, g: Grid, radius: number): Uint8Array {
  const N = g.gw * g.gh
  const dilated = new Uint8Array(N)
  const r2 = radius * radius

  for (let j = 0; j < g.gh; j++) {
    for (let i = 0; i < g.gw; i++) {
      if (!mask[cellIdx(i, j, g.gw)]) continue
      for (let dj = -radius; dj <= radius; dj++) {
        for (let di = -radius; di <= radius; di++) {
          if (di * di + dj * dj > r2) continue
          const ni = i + di, nj = j + dj
          if (ni >= 0 && nj >= 0 && ni < g.gw && nj < g.gh) {
            dilated[cellIdx(ni, nj, g.gw)] = 1
          }
        }
      }
    }
  }

  const closed = new Uint8Array(N)
  for (let j = 0; j < g.gh; j++) {
    for (let i = 0; i < g.gw; i++) {
      if (!dilated[cellIdx(i, j, g.gw)]) continue
      let allInDilated = true
      outer: for (let dj = -radius; dj <= radius && allInDilated; dj++) {
        for (let di = -radius; di <= radius && allInDilated; di++) {
          if (di * di + dj * dj > r2) continue
          const ni = i + di, nj = j + dj
          if (ni < 0 || nj < 0 || ni >= g.gw || nj >= g.gh) { allInDilated = false; break outer }
          if (!dilated[cellIdx(ni, nj, g.gw)]) allInDilated = false
        }
      }
      if (allInDilated) closed[cellIdx(i, j, g.gw)] = 1
    }
  }
  return closed
}

/* ──── scan-line silhouette ──── */

/**
 * Build a silhouette mask: for each row j, find leftmost & rightmost wall cells
 * and fill between them. Do same for columns. Intersect to get the interior.
 */
function buildSilhouetteMask(wallMask: Uint8Array, g: Grid): Uint8Array {
  const N = g.gw * g.gh
  const hFill = new Uint8Array(N)
  const vFill = new Uint8Array(N)

  for (let j = 0; j < g.gh; j++) {
    let leftmost = -1, rightmost = -1
    for (let i = 0; i < g.gw; i++) {
      if (wallMask[cellIdx(i, j, g.gw)]) {
        if (leftmost < 0) leftmost = i
        rightmost = i
      }
    }
    if (leftmost >= 0 && rightmost > leftmost) {
      for (let i = leftmost; i <= rightmost; i++) {
        hFill[cellIdx(i, j, g.gw)] = 1
      }
    }
  }

  for (let i = 0; i < g.gw; i++) {
    let topmost = -1, bottommost = -1
    for (let j = 0; j < g.gh; j++) {
      if (wallMask[cellIdx(i, j, g.gw)]) {
        if (topmost < 0) topmost = j
        bottommost = j
      }
    }
    if (topmost >= 0 && bottommost > topmost) {
      for (let j = topmost; j <= bottommost; j++) {
        vFill[cellIdx(i, j, g.gw)] = 1
      }
    }
  }

  const interior = new Uint8Array(N)
  for (let k = 0; k < N; k++) {
    if (hFill[k] && vFill[k]) interior[k] = 1
  }
  return interior
}

/**
 * From a binary interior mask, keep all connected components that
 * contain at least one major room label or the largest component
 * (whichever yields more coverage). This ensures both halves of
 * split floor plans are included.
 */
function keepRelevantComponents(
  mask: Uint8Array,
  g: Grid,
  majorLabels: Pt[],
  notes: string[],
): Uint8Array {
  const N = g.gw * g.gh
  const labels = new Int32Array(N).fill(-1)
  const sizes: number[] = []
  let label = 0

  for (let j = 0; j < g.gh; j++) {
    for (let i = 0; i < g.gw; i++) {
      const id0 = cellIdx(i, j, g.gw)
      if (!mask[id0] || labels[id0] >= 0) continue
      labels[id0] = label
      const q: number[] = [id0]
      let qi = 0, count = 0
      while (qi < q.length) {
        const cur = q[qi++]!
        count++
        const ci2 = cur % g.gw, cj2 = (cur / g.gw) | 0
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const ni = ci2 + di, nj = cj2 + dj
          if (ni < 0 || nj < 0 || ni >= g.gw || nj >= g.gh) continue
          const nid = cellIdx(ni, nj, g.gw)
          if (!mask[nid] || labels[nid] >= 0) continue
          labels[nid] = label
          q.push(nid)
        }
      }
      sizes.push(count)
      label++
    }
  }

  if (sizes.length === 0) return mask

  const keepLabels = new Set<number>()

  let bestLabel = 0, bestSize = 0
  for (let l = 0; l < sizes.length; l++) {
    if (sizes[l]! > bestSize) { bestSize = sizes[l]!; bestLabel = l }
  }
  keepLabels.add(bestLabel)

  for (const lbl of majorLabels) {
    const ci = clamp(Math.floor((lbl.x - g.minX) / g.cell), 0, g.gw - 1)
    const cj = clamp(Math.floor((lbl.y - g.minY) / g.cell), 0, g.gh - 1)
    const id = cellIdx(ci, cj, g.gw)
    if (labels[id] >= 0) keepLabels.add(labels[id])
    for (let r = 1; r <= 5; r++) {
      for (const [di, dj] of [[r, 0], [-r, 0], [0, r], [0, -r]] as const) {
        const ni = ci + di, nj = cj + dj
        if (ni >= 0 && nj >= 0 && ni < g.gw && nj < g.gh) {
          const nid = cellIdx(ni, nj, g.gw)
          if (labels[nid] >= 0) keepLabels.add(labels[nid])
        }
      }
    }
  }

  notes.push(`Components: ${sizes.length} total, keeping ${keepLabels.size} (labels: ${[...keepLabels].join(", ")}).`)

  const out = new Uint8Array(N)
  for (let k = 0; k < N; k++) {
    if (labels[k] >= 0 && keepLabels.has(labels[k])) out[k] = 1
  }

  if (keepLabels.size > 1) {
    fillGapsBetweenComponents(out, g)
    notes.push("Filled gaps between merged components.")
  }

  return out
}

/**
 * After merging multiple components, fill the horizontal gaps between them
 * row by row (the "re-silhouette" step to make the merged shape contiguous).
 */
function fillGapsBetweenComponents(mask: Uint8Array, g: Grid): void {
  for (let j = 0; j < g.gh; j++) {
    let leftmost = -1, rightmost = -1
    for (let i = 0; i < g.gw; i++) {
      if (mask[cellIdx(i, j, g.gw)]) {
        if (leftmost < 0) leftmost = i
        rightmost = i
      }
    }
    if (leftmost >= 0 && rightmost > leftmost) {
      for (let i = leftmost; i <= rightmost; i++) {
        mask[cellIdx(i, j, g.gw)] = 1
      }
    }
  }
}

/* ──── boundary extraction (marching) ──── */

function marchBoundary(visited: Uint8Array, g: Grid): Pt[] {
  let startI = -1, startJ = -1
  outer: for (let j = 0; j < g.gh; j++) {
    for (let i = 0; i < g.gw; i++) {
      if (visited[cellIdx(i, j, g.gw)]) {
        startI = i; startJ = j
        break outer
      }
    }
  }
  if (startI < 0) return []

  const dirs: [number, number][] = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]]
  const isVis = (i: number, j: number) =>
    i >= 0 && j >= 0 && i < g.gw && j < g.gh && visited[cellIdx(i, j, g.gw)] === 1

  const boundary: Pt[] = []
  let ci = startI, cj = startJ
  let dir = 7

  const maxSteps = g.gw * g.gh * 2
  for (let step = 0; step < maxSteps; step++) {
    boundary.push(cellCenter(ci, cj, g))
    let searchDir = (dir + 6) % 8
    let found = false
    for (let k = 0; k < 8; k++) {
      const d = (searchDir + k) % 8
      const ni = ci + dirs[d]![0], nj = cj + dirs[d]![1]
      if (isVis(ni, nj)) {
        ci = ni; cj = nj; dir = d; found = true; break
      }
    }
    if (!found) break
    if (ci === startI && cj === startJ) break
  }

  return boundary
}

/* ──── simplification ──── */

function rdpSimplify(pts: Pt[], eps: number): Pt[] {
  if (pts.length <= 2) return pts.slice()
  let maxD = 0, maxI = 0
  const first = pts[0]!, last = pts[pts.length - 1]!
  const dx = last.x - first.x, dy = last.y - first.y
  const len = Math.hypot(dx, dy)
  for (let i = 1; i < pts.length - 1; i++) {
    const d = len > 0
      ? Math.abs(dy * pts[i]!.x - dx * pts[i]!.y + last.x * first.y - last.y * first.x) / len
      : Math.hypot(pts[i]!.x - first.x, pts[i]!.y - first.y)
    if (d > maxD) { maxD = d; maxI = i }
  }
  if (maxD > eps) {
    const left = rdpSimplify(pts.slice(0, maxI + 1), eps)
    const right = rdpSimplify(pts.slice(maxI), eps)
    return left.slice(0, -1).concat(right)
  }
  return [first, last]
}

function axisSnap(pts: Pt[], threshold: number): Pt[] {
  const out: Pt[] = []
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!
    const prev = pts[(i - 1 + pts.length) % pts.length]!
    const next = pts[(i + 1) % pts.length]!
    let x = p.x, y = p.y
    if (Math.abs(p.x - prev.x) < threshold) x = prev.x
    else if (Math.abs(p.x - next.x) < threshold) x = next.x
    if (Math.abs(p.y - prev.y) < threshold) y = prev.y
    else if (Math.abs(p.y - next.y) < threshold) y = next.y
    out.push({ x, y })
  }
  return out
}

function dedup(pts: Pt[], minDist: number): Pt[] {
  if (pts.length < 2) return pts
  const out: Pt[] = [pts[0]!]
  for (let i = 1; i < pts.length; i++) {
    const prev = out[out.length - 1]!
    if (Math.hypot(pts[i]!.x - prev.x, pts[i]!.y - prev.y) > minDist) {
      out.push(pts[i]!)
    }
  }
  return out
}

/* ──── blank regions ──── */

function findBlankRegions(interior: Uint8Array, wallMask: Uint8Array, g: Grid, unitBBox: PlanBoundingBox): PlanBoundingBox[] {
  const N = g.gw * g.gh
  const labeled = new Int32Array(N).fill(-1)
  const regions: PlanBoundingBox[] = []
  let label = 0

  for (let j = 1; j < g.gh - 1; j++) {
    for (let i = 1; i < g.gw - 1; i++) {
      const id0 = cellIdx(i, j, g.gw)
      if (interior[id0] || wallMask[id0] || labeled[id0] >= 0) continue
      const c = cellCenter(i, j, g)
      if (c.x < unitBBox.minX || c.x > unitBBox.maxX || c.y < unitBBox.minY || c.y > unitBBox.maxY) continue
      const q: number[] = [id0]
      labeled[id0] = label
      let qi = 0, count = 0
      let minI = i, maxI = i, minJ = j, maxJ = j
      while (qi < q.length) {
        const cur = q[qi++]!
        count++
        const ci2 = cur % g.gw, cj2 = (cur / g.gw) | 0
        minI = Math.min(minI, ci2); maxI = Math.max(maxI, ci2)
        minJ = Math.min(minJ, cj2); maxJ = Math.max(maxJ, cj2)
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const ni = ci2 + di, nj = cj2 + dj
          if (ni < 0 || nj < 0 || ni >= g.gw || nj >= g.gh) continue
          const nid = cellIdx(ni, nj, g.gw)
          if (interior[nid] || wallMask[nid] || labeled[nid] >= 0) continue
          labeled[nid] = label
          q.push(nid)
        }
      }
      if (count >= U1.blankMinCells) {
        regions.push({
          minX: g.minX + minI * g.cell,
          minY: g.minY + minJ * g.cell,
          maxX: g.minX + (maxI + 1) * g.cell,
          maxY: g.minY + (maxJ + 1) * g.cell,
        })
      }
      label++
    }
  }
  return regions
}

/* ──── output types ──── */

export interface ExcludedBlankRegionV1 {
  bbox: PlanBoundingBox
}

export interface UnitOuterBoundaryRecoveryV1Debug {
  recoveredUnitPolygon: Pt[]
  boundaryClosed: boolean
  planExtent: PlanBoundingBox
  recoveredBBox: PlanBoundingBox
  recoveredAreaPt2: number
  previousUnitBBox: PlanBoundingBox | null
  seedCount: number
  floodedCellCount: number
  wallSegmentCount: number
  vertexCount: number
  supportSummary: string
  excludedBlankSpaceRegions: ExcludedBlankRegionV1[]
  boundaryRecoveryStatement: string
  notes: string[]
}

/* ──── main builder ──── */

export function buildUnitOuterBoundaryRecoveryV1(
  allSegments: ExtractedLineSegment[],
  rawPageTexts: ExtractedTextRun[],
  pageBounds: PlanBoundingBox,
  primaryLayoutBBox: PlanBoundingBox,
  previousUnitPolygon: Pt[] | null,
  _previousUnitBoundaryClosed: boolean | null,
): UnitOuterBoundaryRecoveryV1Debug {
  const notes: string[] = []

  const wallSegs = filterWallSegments(allSegments)
  notes.push(`Filtered ${wallSegs.length} wall-like segments (minLen=${U1.minWallLen}) from ${allSegments.length} raw.`)

  const majorLabels: Pt[] = []
  for (const t of rawPageTexts) {
    const norm = normalizePlanBodyRoomLabelV0(t.text)
    const kind = classifyPlanTextAnchorKindV0(norm)
    if (kind === "major_room") majorLabels.push({ x: t.x, y: t.y })
  }

  const planExtent = computeFloorPlanExtent(wallSegs, pageBounds, primaryLayoutBBox, majorLabels)
  notes.push(`Plan extent: (${planExtent.minX.toFixed(0)}, ${planExtent.minY.toFixed(0)}) – (${planExtent.maxX.toFixed(0)}, ${planExtent.maxY.toFixed(0)}).`)

  const g = makeGrid(planExtent, U1.pagePad)
  const N = g.gw * g.gh
  notes.push(`Grid: ${g.gw}×${g.gh} = ${N} cells, cell=${g.cell.toFixed(1)} pt.`)

  const rawWallMask = rasterizeWalls(wallSegs, g, planExtent)
  let wallCellCount = 0
  for (let k = 0; k < N; k++) if (rawWallMask[k]) wallCellCount++
  notes.push(`Rasterized wall mask: ${wallCellCount} cells.`)

  const closedWallMask = morphClose(rawWallMask, g, U1.morphCloseRadius)
  let closedCellCount = 0
  for (let k = 0; k < N; k++) if (closedWallMask[k]) closedCellCount++
  notes.push(`After morphological close (r=${U1.morphCloseRadius}): ${closedCellCount} wall cells.`)

  let silhouette = buildSilhouetteMask(closedWallMask, g)
  let silCount = 0
  for (let k = 0; k < N; k++) if (silhouette[k]) silCount++
  notes.push(`Silhouette interior: ${silCount} cells.`)

  silhouette = keepRelevantComponents(silhouette, g, majorLabels, notes)
  let largestCount = 0
  for (let k = 0; k < N; k++) if (silhouette[k]) largestCount++
  notes.push(`Merged relevant components: ${largestCount} cells.`)

  let rawBoundary = marchBoundary(silhouette, g)
  notes.push(`Raw boundary trace: ${rawBoundary.length} points.`)

  let simplified = rdpSimplify(rawBoundary, U1.rdpEpsilon)
  simplified = axisSnap(simplified, U1.axisSnapThreshold)
  simplified = dedup(simplified, 2)

  const boundaryClosed = simplified.length >= 3
  const recoveredBBox = bboxOfPoly(simplified)
  const recoveredArea = polygonAbsArea(simplified)

  const excludedBlank = findBlankRegions(silhouette, closedWallMask, g, recoveredBBox)
    .map((bb) => ({ bbox: bb }))

  const previousBBox = previousUnitPolygon && previousUnitPolygon.length >= 3
    ? bboxOfPoly(previousUnitPolygon)
    : null

  const prevWidth = previousBBox ? (previousBBox.maxX - previousBBox.minX).toFixed(0) : "?"
  const prevHeight = previousBBox ? (previousBBox.maxY - previousBBox.minY).toFixed(0) : "?"
  const newWidth = (recoveredBBox.maxX - recoveredBBox.minX).toFixed(0)
  const newHeight = (recoveredBBox.maxY - recoveredBBox.minY).toFixed(0)

  const supportSummary = `Wall evidence: ${wallCellCount} raw → ${closedCellCount} closed wall cells; silhouette ${silCount} → largest ${largestCount} cells; ${simplified.length} boundary vertices; ${excludedBlank.length} blank region(s).`

  const boundaryRecoveryStatement = `Unit boundary recovery v1: ${simplified.length} vertices, closed=${boundaryClosed}, area=${recoveredArea.toFixed(0)} pt², bbox ${newWidth}×${newHeight} (prev ${prevWidth}×${prevHeight}). ${excludedBlank.length} blank region(s) excluded.`

  if (previousBBox) {
    const newW = recoveredBBox.maxX - recoveredBBox.minX
    const oldW = previousBBox.maxX - previousBBox.minX
    if (newW > oldW * 1.1) {
      notes.push(`Recovered boundary is ${((newW / oldW - 1) * 100).toFixed(0)}% wider than previous unit (${newW.toFixed(0)} vs ${oldW.toFixed(0)} pt).`)
    }
    if (newW < oldW * 0.9) {
      notes.push(`Recovered boundary is ${((1 - newW / oldW) * 100).toFixed(0)}% narrower than previous unit.`)
    }
  }

  return {
    recoveredUnitPolygon: simplified,
    boundaryClosed,
    planExtent,
    recoveredBBox,
    recoveredAreaPt2: recoveredArea,
    previousUnitBBox: previousBBox,
    seedCount: majorLabels.length,
    floodedCellCount: largestCount,
    wallSegmentCount: wallCellCount,
    vertexCount: simplified.length,
    supportSummary,
    excludedBlankSpaceRegions: excludedBlank,
    boundaryRecoveryStatement,
    notes,
  }
}

/* ──── SVG ──── */

export interface BuildUnitOuterBoundaryRecoveryV1SvgOptions {
  pageBounds: PlanBoundingBox
  recovery: UnitOuterBoundaryRecoveryV1Debug
  previousUnitPolygon: Pt[] | null
  previousUnitBoundaryClosed: boolean | null
  allSegments: ExtractedLineSegment[]
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

export function buildUnitOuterBoundaryRecoveryV1SvgString(o: BuildUnitOuterBoundaryRecoveryV1SvgOptions): string {
  const pb = o.pageBounds
  const w = pb.maxX - pb.minX
  const h = pb.maxY - pb.minY
  const r = o.recovery

  const wallSegs = filterWallSegments(o.allSegments)
  const ext = r.planExtent
  const segLines = wallSegs
    .filter((s) => s.mx >= ext.minX - 20 && s.mx <= ext.maxX + 20 &&
                   s.my >= ext.minY - 20 && s.my <= ext.maxY + 20)
    .map(
      (s) =>
        `<line x1="${s.x1.toFixed(1)}" y1="${s.y1.toFixed(1)}" x2="${s.x2.toFixed(1)}" y2="${s.y2.toFixed(1)}" stroke="rgba(100,100,100,0.3)" stroke-width="0.7"/>`
    )
    .join("\n")

  const prevGhost =
    o.previousUnitPolygon && o.previousUnitPolygon.length >= 3
      ? `<path d="${escapeXml(pathFromPoly(o.previousUnitPolygon, o.previousUnitBoundaryClosed ?? false))}" fill="rgba(180,60,60,0.06)" stroke="rgba(180,60,60,0.4)" stroke-width="1.4" stroke-dasharray="6 4"/>`
      : ""

  const newPoly =
    r.recoveredUnitPolygon.length >= 3
      ? `<path d="${escapeXml(pathFromPoly(r.recoveredUnitPolygon, r.boundaryClosed))}" fill="rgba(30,160,80,0.08)" stroke="rgba(20,120,50,0.92)" stroke-width="2.2"/>`
      : ""

  const blankRects = r.excludedBlankSpaceRegions
    .map(
      (b) =>
        `<rect x="${b.bbox.minX.toFixed(1)}" y="${b.bbox.minY.toFixed(1)}" width="${(b.bbox.maxX - b.bbox.minX).toFixed(1)}" height="${(b.bbox.maxY - b.bbox.minY).toFixed(1)}" fill="rgba(220,60,40,0.12)" stroke="rgba(200,50,30,0.5)" stroke-width="0.8" stroke-dasharray="4 3"/>`
    )
    .join("\n")

  const extRect = `<rect x="${ext.minX.toFixed(1)}" y="${ext.minY.toFixed(1)}" width="${(ext.maxX - ext.minX).toFixed(1)}" height="${(ext.maxY - ext.minY).toFixed(1)}" fill="none" stroke="rgba(0,0,180,0.25)" stroke-width="0.8" stroke-dasharray="5 4"/>`

  const title = `Unit outer boundary recovery v1 — ${r.vertexCount} verts, area=${r.recoveredAreaPt2.toFixed(0)} pt², ${r.excludedBlankSpaceRegions.length} blank`

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${pb.minX} ${pb.minY} ${w} ${h}" width="${Math.round(w)}" height="${Math.round(h)}">
<rect x="${pb.minX}" y="${pb.minY}" width="${w}" height="${h}" fill="white"/>
<text x="${pb.minX + 8}" y="${pb.minY + 14}" font-size="11" fill="#222" font-family="system-ui,sans-serif">${escapeXml(title)}</text>
<text x="${pb.minX + 8}" y="${pb.minY + 28}" font-size="7.5" fill="#444" font-family="system-ui,sans-serif">Green = recovered boundary; faint red dashed = previous unit; gray = wall segments; red dashed rects = excluded blank; blue dashed = plan extent.</text>
<g>${segLines}</g>
<g>${prevGhost}</g>
<g>${blankRects}</g>
<g>${extRect}</g>
<g>${newPoly}</g>
</svg>`
}
