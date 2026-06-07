import * as fs from "node:fs"
import * as path from "node:path"

import { extractPdfVectorPrimitives } from "../lib/geometryFirst/extractPdfVectorPrimitives"

type Line = {
  x1: number
  y1: number
  x2: number
  y2: number
  source?: string
}

type TextRun = {
  text: string
  x: number
  y: number
  pageIndex: number
  width?: number
  height?: number
}

type BBox = {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

const PLAN_PAD = 14
const WALL_MIN_LEN = 7
const WEAK_MIN_LEN = 1.5
const AXIS_TOL_DEG = 8
const WEAK_CONNECTOR_NEAR_WALL_PT = 8
const FIXTURE_KEEP_RADIUS = 34
const TEXT_FONT_SIZE = 6.5
const FIXTURE_TEXT_RE = /\b(WC|DW|DC|REF|OV|MW|W\/D)\b/i
const PLAN_TEXT_RE =
  /\b(BED(?:ROOM)?|BATH(?:ROOM)?|KITCHEN|LIVING|DINING|FOYER|PANTRY|CL|WIC|WC|DW|REF|OV|MW|ENTRY|LAUNDRY|HALL)\b/i
const APARTMENT_ROOM_TEXT_RE =
  /\b(PRIMARY BEDROOM|BEDROOM\s*\d*|PRIMARY BATH(?:\s*\d+)?|BATH(?:ROOM)?(?:\s*\d+)?|KITCHEN|LIVING|DINING|FOYER|WIC)\b/i
const APARTMENT_TEXT_PAD = 88
const MAIN_PLAN_TEXT_PAD = 52
const MAIN_PLAN_LINE_REACH = 28
const MAIN_PLAN_GRID_CELL = 42
const OUTER_CONTOUR_CELL_SIZE = 3
const OUTER_CONTOUR_PAD_CELLS = 4
const OUTER_CONTOUR_DILATE_RADIUS = 5
const OUTER_CONTOUR_MERGE_TOL = 0.4
const OUTER_CONTOUR_FENCE_BAND_CELLS = 4

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}

function escapeXml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
}

function svgHeader(width: number, height: number): string[] {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect x="0" y="0" width="${width}" height="${height}" fill="white" />`,
  ]
}

function svgFooter(): string {
  return `</svg>`
}

function segmentLength(line: Line): number {
  return Math.hypot(line.x2 - line.x1, line.y2 - line.y1)
}

function midpoint(line: Line): { x: number; y: number } {
  return { x: (line.x1 + line.x2) / 2, y: (line.y1 + line.y2) / 2 }
}

function angleDegrees(line: Line): number {
  return (Math.atan2(Math.abs(line.y2 - line.y1), Math.abs(line.x2 - line.x1)) * 180) / Math.PI
}

function isNearAxis(line: Line, tolDeg = AXIS_TOL_DEG): boolean {
  const ang = angleDegrees(line)
  return ang <= tolDeg || 90 - ang <= tolDeg
}

function bboxFromLines(lines: Line[]): BBox | null {
  if (!lines.length) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const line of lines) {
    minX = Math.min(minX, line.x1, line.x2)
    minY = Math.min(minY, line.y1, line.y2)
    maxX = Math.max(maxX, line.x1, line.x2)
    maxY = Math.max(maxY, line.y1, line.y2)
  }
  return { minX, minY, maxX, maxY }
}

function expandBox(box: BBox, pad: number): BBox {
  return {
    minX: box.minX - pad,
    minY: box.minY - pad,
    maxX: box.maxX + pad,
    maxY: box.maxY + pad,
  }
}

function boxWidth(box: BBox): number {
  return box.maxX - box.minX
}

function boxHeight(box: BBox): number {
  return box.maxY - box.minY
}

function pointInBox(x: number, y: number, box: BBox): boolean {
  return x >= box.minX && x <= box.maxX && y >= box.minY && y <= box.maxY
}

function lineTouchesBox(line: Line, box: BBox): boolean {
  if (pointInBox(line.x1, line.y1, box) || pointInBox(line.x2, line.y2, box)) return true
  const m = midpoint(line)
  return pointInBox(m.x, m.y, box)
}

function textBox(text: TextRun, pad = 0): BBox {
  const width = text.width ?? Math.max(6, text.text.length * 4.5)
  const height = text.height ?? 8
  return {
    minX: text.x - pad,
    minY: text.y - height - pad,
    maxX: text.x + width + pad,
    maxY: text.y + pad,
  }
}

function bboxFromBoxes(boxes: BBox[]): BBox | null {
  if (!boxes.length) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const box of boxes) {
    minX = Math.min(minX, box.minX)
    minY = Math.min(minY, box.minY)
    maxX = Math.max(maxX, box.maxX)
    maxY = Math.max(maxY, box.maxY)
  }
  return { minX, minY, maxX, maxY }
}

function unionBox(a: BBox | null, b: BBox): BBox {
  if (!a) return { ...b }
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  }
}

function lineBox(line: Line): BBox {
  return {
    minX: Math.min(line.x1, line.x2),
    minY: Math.min(line.y1, line.y2),
    maxX: Math.max(line.x1, line.x2),
    maxY: Math.max(line.y1, line.y2),
  }
}

function boxIntersects(a: BBox, b: BBox): boolean {
  return !(a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY)
}

function computeDensestLineClusterBox(page: { pageBounds: BBox; lines: Line[] }): BBox | null {
  const candidateLines = page.lines.filter((line) => {
    const len = segmentLength(line)
    return len >= Math.max(4, WEAK_MIN_LEN) && (isNearAxis(line) || len >= WALL_MIN_LEN)
  })
  if (!candidateLines.length) return null

  const buckets = new Map<string, { score: number; lines: Line[]; cx: number; cy: number }>()
  for (const line of candidateLines) {
    const m = midpoint(line)
    const cx = Math.floor((m.x - page.pageBounds.minX) / MAIN_PLAN_GRID_CELL)
    const cy = Math.floor((m.y - page.pageBounds.minY) / MAIN_PLAN_GRID_CELL)
    const key = `${cx},${cy}`
    const entry = buckets.get(key) ?? { score: 0, lines: [], cx, cy }
    entry.score += Math.min(segmentLength(line), 80)
    entry.lines.push(line)
    buckets.set(key, entry)
  }
  if (!buckets.size) return null

  let best: { score: number; lines: Line[]; cx: number; cy: number } | null = null
  for (const entry of buckets.values()) {
    if (!best || entry.score > best.score) best = entry
  }
  if (!best) return null

  const keepThreshold = Math.max(best.score * 0.32, 16)
  const queue: Array<[number, number]> = [[best.cx, best.cy]]
  const visited = new Set<string>()
  const clusterLines: Line[] = []

  while (queue.length) {
    const [cx, cy] = queue.shift()!
    const key = `${cx},${cy}`
    if (visited.has(key)) continue
    visited.add(key)
    const entry = buckets.get(key)
    if (!entry || entry.score < keepThreshold) continue
    clusterLines.push(...entry.lines)
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        if (ox === 0 && oy === 0) continue
        queue.push([cx + ox, cy + oy])
      }
    }
  }

  const clusterBox = bboxFromLines(clusterLines)
  return clusterBox ? expandBox(clusterBox, 18) : null
}

function deriveMainPlanArea(page: { pageBounds: BBox; lines: Line[]; texts: TextRun[] }): BBox {
  const rawLineBox = bboxFromLines(page.lines)
  const baseBox =
    rawLineBox ??
    ({
      minX: page.pageBounds.minX,
      minY: page.pageBounds.minY,
      maxX: page.pageBounds.maxX,
      maxY: page.pageBounds.maxY,
    } satisfies BBox)

  const mainPlanTextBoxes = page.texts
    .filter((text) => PLAN_TEXT_RE.test(text.text) && pointInBox(text.x, text.y, expandBox(baseBox, PLAN_PAD)))
    .map((text) => textBox(text, MAIN_PLAN_TEXT_PAD))

  let seededBox = bboxFromBoxes(mainPlanTextBoxes)
  if (!seededBox) {
    seededBox = computeDensestLineClusterBox(page)
  }
  if (!seededBox) return expandBox(baseBox, PLAN_PAD)

  let current = { ...seededBox }
  for (let iter = 0; iter < 4; iter++) {
    const searchBox = expandBox(current, MAIN_PLAN_LINE_REACH)
    let next: BBox | null = null
    for (const line of page.lines) {
      const len = segmentLength(line)
      if (len < Math.max(4, WEAK_MIN_LEN)) continue
      const candidate =
        lineTouchesBox(line, searchBox) ||
        boxIntersects(lineBox(line), searchBox) ||
        (isNearAxis(line) && len >= WALL_MIN_LEN * 0.9 && pointInBox(midpoint(line).x, midpoint(line).y, searchBox))
      if (!candidate) continue
      next = unionBox(next, lineBox(line))
    }
    for (const tb of mainPlanTextBoxes) {
      if (boxIntersects(tb, searchBox)) next = unionBox(next, tb)
    }
    if (!next) break
    const expanded = expandBox(next, 14)
    const growth =
      Math.abs(expanded.minX - current.minX) +
      Math.abs(expanded.minY - current.minY) +
      Math.abs(expanded.maxX - current.maxX) +
      Math.abs(expanded.maxY - current.maxY)
    current = expanded
    if (growth < 6) break
  }

  return {
    minX: clamp(current.minX, page.pageBounds.minX, page.pageBounds.maxX),
    minY: clamp(current.minY, page.pageBounds.minY, page.pageBounds.maxY),
    maxX: clamp(current.maxX, page.pageBounds.minX, page.pageBounds.maxX),
    maxY: clamp(current.maxY, page.pageBounds.minY, page.pageBounds.maxY),
  }
}

function pointToSegmentDistance(
  px: number,
  py: number,
  line: Line
): { distance: number; x: number; y: number } {
  const vx = line.x2 - line.x1
  const vy = line.y2 - line.y1
  const len2 = vx * vx + vy * vy
  if (len2 <= 1e-9) {
    return { distance: Math.hypot(px - line.x1, py - line.y1), x: line.x1, y: line.y1 }
  }
  const t = Math.max(0, Math.min(1, ((px - line.x1) * vx + (py - line.y1) * vy) / len2))
  const x = line.x1 + vx * t
  const y = line.y1 + vy * t
  return { distance: Math.hypot(px - x, py - y), x, y }
}

function nearestWallProjection(
  px: number,
  py: number,
  walls: Line[],
  maxDist: number
): { x: number; y: number } | null {
  let best: { distance: number; x: number; y: number } | null = null
  for (const wall of walls) {
    const hit = pointToSegmentDistance(px, py, wall)
    if (hit.distance > maxDist) continue
    if (!best || hit.distance < best.distance) best = hit
  }
  return best ? { x: best.x, y: best.y } : null
}

function snapLineToWalls(line: Line, walls: Line[], maxDist: number): Line {
  const p1 = nearestWallProjection(line.x1, line.y1, walls, maxDist)
  const p2 = nearestWallProjection(line.x2, line.y2, walls, maxDist)
  return {
    ...line,
    x1: p1?.x ?? line.x1,
    y1: p1?.y ?? line.y1,
    x2: p2?.x ?? line.x2,
    y2: p2?.y ?? line.y2,
  }
}

function dedupeLines(lines: Line[]): Line[] {
  const out: Line[] = []
  const seen = new Set<string>()
  for (const line of lines) {
    const r = (n: number) => (Math.round(n * 10) / 10).toFixed(1)
    const a = `${r(line.x1)},${r(line.y1)},${r(line.x2)},${r(line.y2)}`
    const b = `${r(line.x2)},${r(line.y2)},${r(line.x1)},${r(line.y1)}`
    const key = a < b ? a : b
    if (seen.has(key)) continue
    seen.add(key)
    out.push(line)
  }
  return out
}

function deriveApartmentArea(page: { pageBounds: BBox; lines: Line[]; texts: TextRun[] }, mainPlanBox?: BBox): BBox {
  const sourceLines = mainPlanBox ? page.lines.filter((line) => lineTouchesBox(line, mainPlanBox)) : page.lines
  const rawLineBox = bboxFromLines(sourceLines)
  const planBox = expandBox(
    rawLineBox ?? {
      minX: page.pageBounds.minX,
      minY: page.pageBounds.minY,
      maxX: page.pageBounds.maxX,
      maxY: page.pageBounds.maxY,
    },
    PLAN_PAD
  )

  const roomTextBoxes = page.texts
    .filter(
      (text) =>
        APARTMENT_ROOM_TEXT_RE.test(text.text) &&
        pointInBox(text.x, text.y, planBox) &&
        (!mainPlanBox || pointInBox(text.x, text.y, mainPlanBox))
    )
    .map((text) => textBox(text, APARTMENT_TEXT_PAD))

  if (!roomTextBoxes.length) return expandBox(planBox, -Math.min(PLAN_PAD - 2, 10))

  const anchorBox = bboxFromBoxes(roomTextBoxes) ?? planBox
  const anchoredLines = page.lines.filter((line) => lineTouchesBox(line, anchorBox))
  const anchoredLineBox = bboxFromLines(anchoredLines)

  return expandBox(anchoredLineBox ?? anchorBox, 12)
}

function rasterizeLinesToGrid(
  lines: Line[],
  box: BBox,
  cellSize: number,
  padCells: number
): {
  grid: Uint8Array
  gw: number
  gh: number
  ox: number
  oy: number
} {
  const gw = Math.max(8, Math.ceil(boxWidth(box) / cellSize) + padCells * 2)
  const gh = Math.max(8, Math.ceil(boxHeight(box) / cellSize) + padCells * 2)
  const ox = box.minX - padCells * cellSize
  const oy = box.minY - padCells * cellSize
  const grid = new Uint8Array(gw * gh)
  for (const line of lines) {
    const len = segmentLength(line)
    const steps = Math.max(1, Math.ceil(len / (cellSize * 0.5)))
    for (let s = 0; s <= steps; s++) {
      const t = s / steps
      const x = line.x1 + (line.x2 - line.x1) * t
      const y = line.y1 + (line.y2 - line.y1) * t
      const cx = Math.floor((x - ox) / cellSize)
      const cy = Math.floor((y - oy) / cellSize)
      if (cx >= 0 && cx < gw && cy >= 0 && cy < gh) {
        grid[cy * gw + cx] = 1
      }
    }
  }
  return { grid, gw, gh, ox, oy }
}

function dilateGrid(grid: Uint8Array, gw: number, gh: number, radius: number): Uint8Array {
  if (radius <= 0) return new Uint8Array(grid)
  const r2 = radius * radius
  const out = new Uint8Array(gw * gh)
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      if (!grid[y * gw + x]) continue
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          if (dx * dx + dy * dy > r2) continue
          const nx = x + dx
          const ny = y + dy
          if (nx >= 0 && nx < gw && ny >= 0 && ny < gh) {
            out[ny * gw + nx] = 1
          }
        }
      }
    }
  }
  return out
}

function floodFillExterior(grid: Uint8Array, gw: number, gh: number): Uint8Array {
  const exterior = new Uint8Array(gw * gh)
  const stack: number[] = []
  const seed = (x: number, y: number) => {
    if (x < 0 || x >= gw || y < 0 || y >= gh) return
    const i = y * gw + x
    if (grid[i] || exterior[i]) return
    exterior[i] = 1
    stack.push(i)
  }
  for (let x = 0; x < gw; x++) {
    seed(x, 0)
    seed(x, gh - 1)
  }
  for (let y = 0; y < gh; y++) {
    seed(0, y)
    seed(gw - 1, y)
  }
  while (stack.length) {
    const i = stack.pop()!
    const x = i % gw
    const y = Math.floor(i / gw)
    seed(x - 1, y)
    seed(x + 1, y)
    seed(x, y - 1)
    seed(x, y + 1)
  }
  return exterior
}

function mergeAxisAlignedEdges(
  items: Array<{ coord: number; from: number; to: number }>,
  coordTol: number
): Array<{ coord: number; from: number; to: number }> {
  if (!items.length) return []
  const groups = new Map<number, Array<{ from: number; to: number }>>()
  for (const item of items) {
    const key = Math.round(item.coord / Math.max(coordTol, 0.001)) * coordTol
    const arr = groups.get(key) ?? []
    arr.push({ from: item.from, to: item.to })
    groups.set(key, arr)
  }
  const out: Array<{ coord: number; from: number; to: number }> = []
  for (const [coord, group] of groups) {
    group.sort((a, b) => a.from - b.from)
    let cur: { from: number; to: number } | null = null
    for (const item of group) {
      if (!cur) {
        cur = { ...item }
        continue
      }
      if (item.from <= cur.to + coordTol) {
        cur.to = Math.max(cur.to, item.to)
      } else {
        out.push({ coord, ...cur })
        cur = { ...item }
      }
    }
    if (cur) out.push({ coord, ...cur })
  }
  return out
}

function mergeRanges(items: Array<{ from: number; to: number }>): Array<{ from: number; to: number }> {
  if (!items.length) return []
  const sorted = [...items].sort((a, b) => a.from - b.from)
  const out: Array<{ from: number; to: number }> = [{ ...sorted[0]! }]
  for (let i = 1; i < sorted.length; i++) {
    const cur = out[out.length - 1]!
    const next = sorted[i]!
    if (next.from <= cur.to + 0.001) {
      cur.to = Math.max(cur.to, next.to)
    } else {
      out.push({ ...next })
    }
  }
  return out
}

function deriveApartmentOuterContour(
  walls: Line[],
  apartmentBox: BBox,
  roomAnchors: Array<{ x: number; y: number }>
): { contour: Line[]; fenceSegments: Line[]; interiorCellCount: number } {
  const inBox = walls.filter((line) => lineTouchesBox(line, apartmentBox))
  if (!inBox.length) return { contour: [], fenceSegments: [], interiorCellCount: 0 }

  const cs = OUTER_CONTOUR_CELL_SIZE
  const { grid, gw, gh, ox, oy } = rasterizeLinesToGrid(
    inBox,
    apartmentBox,
    cs,
    OUTER_CONTOUR_PAD_CELLS
  )
  const dilated = dilateGrid(grid, gw, gh, OUTER_CONTOUR_DILATE_RADIUS)

  const interior = new Uint8Array(gw * gh)
  const istack: number[] = []
  const seedInterior = (x: number, y: number): boolean => {
    if (x < 0 || x >= gw || y < 0 || y >= gh) return false
    const i = y * gw + x
    if (dilated[i] || interior[i]) return false
    interior[i] = 1
    istack.push(i)
    return true
  }
  for (const anchor of roomAnchors) {
    const cx = Math.floor((anchor.x - ox) / cs)
    const cy = Math.floor((anchor.y - oy) / cs)
    let seeded = seedInterior(cx, cy)
    for (let r = 1; r <= 4 && !seeded; r++) {
      seeded =
        seedInterior(cx - r, cy) ||
        seedInterior(cx + r, cy) ||
        seedInterior(cx, cy - r) ||
        seedInterior(cx, cy + r)
    }
  }
  while (istack.length) {
    const i = istack.pop()!
    const x = i % gw
    const y = Math.floor(i / gw)
    seedInterior(x - 1, y)
    seedInterior(x + 1, y)
    seedInterior(x, y - 1)
    seedInterior(x, y + 1)
  }

  let interiorCellCount = 0
  for (let i = 0; i < interior.length; i++) if (interior[i]) interiorCellCount++

  const fenced = new Uint8Array(dilated)
  const py1 = OUTER_CONTOUR_PAD_CELLS
  const py2 = gh - OUTER_CONTOUR_PAD_CELLS - 1
  const px1 = OUTER_CONTOUR_PAD_CELLS
  const px2 = gw - OUTER_CONTOUR_PAD_CELLS - 1

  const checkInteriorBand = (x: number, y: number, dx: number, dy: number): boolean => {
    for (let k = 0; k <= OUTER_CONTOUR_FENCE_BAND_CELLS; k++) {
      const nx = x + dx * k
      const ny = y + dy * k
      if (nx < 0 || nx >= gw || ny < 0 || ny >= gh) continue
      if (interior[ny * gw + nx]) return true
    }
    return false
  }

  const fenceTop: Array<{ from: number; to: number }> = []
  const fenceBot: Array<{ from: number; to: number }> = []
  const fenceLeft: Array<{ from: number; to: number }> = []
  const fenceRight: Array<{ from: number; to: number }> = []

  for (let x = px1; x <= px2; x++) {
    if (checkInteriorBand(x, py1, 0, 1) && !fenced[py1 * gw + x]) {
      fenced[py1 * gw + x] = 1
      fenceTop.push({ from: ox + x * cs, to: ox + (x + 1) * cs })
    }
    if (checkInteriorBand(x, py2, 0, -1) && !fenced[py2 * gw + x]) {
      fenced[py2 * gw + x] = 1
      fenceBot.push({ from: ox + x * cs, to: ox + (x + 1) * cs })
    }
  }
  for (let y = py1; y <= py2; y++) {
    if (checkInteriorBand(px1, y, 1, 0) && !fenced[y * gw + px1]) {
      fenced[y * gw + px1] = 1
      fenceLeft.push({ from: oy + y * cs, to: oy + (y + 1) * cs })
    }
    if (checkInteriorBand(px2, y, -1, 0) && !fenced[y * gw + px2]) {
      fenced[y * gw + px2] = 1
      fenceRight.push({ from: oy + y * cs, to: oy + (y + 1) * cs })
    }
  }

  const fenceY1 = oy + py1 * cs
  const fenceY2 = oy + py2 * cs
  const fenceX1 = ox + px1 * cs
  const fenceX2 = ox + px2 * cs

  const fenceSegments: Line[] = []
  for (const r of mergeRanges(fenceTop)) {
    fenceSegments.push({ x1: r.from, y1: fenceY1, x2: r.to, y2: fenceY1, source: "fence-top" })
  }
  for (const r of mergeRanges(fenceBot)) {
    fenceSegments.push({ x1: r.from, y1: fenceY2, x2: r.to, y2: fenceY2, source: "fence-bottom" })
  }
  for (const r of mergeRanges(fenceLeft)) {
    fenceSegments.push({ x1: fenceX1, y1: r.from, x2: fenceX1, y2: r.to, source: "fence-left" })
  }
  for (const r of mergeRanges(fenceRight)) {
    fenceSegments.push({ x1: fenceX2, y1: r.from, x2: fenceX2, y2: r.to, source: "fence-right" })
  }

  const exterior = floodFillExterior(fenced, gw, gh)

  const horiz: Array<{ coord: number; from: number; to: number }> = []
  const vert: Array<{ coord: number; from: number; to: number }> = []
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      if (exterior[y * gw + x]) continue
      const above = y > 0 ? !exterior[(y - 1) * gw + x] : false
      if (!above) {
        horiz.push({
          coord: oy + y * cs,
          from: ox + x * cs,
          to: ox + (x + 1) * cs,
        })
      }
      const below = y < gh - 1 ? !exterior[(y + 1) * gw + x] : false
      if (!below) {
        horiz.push({
          coord: oy + (y + 1) * cs,
          from: ox + x * cs,
          to: ox + (x + 1) * cs,
        })
      }
      const left = x > 0 ? !exterior[y * gw + (x - 1)] : false
      if (!left) {
        vert.push({
          coord: ox + x * cs,
          from: oy + y * cs,
          to: oy + (y + 1) * cs,
        })
      }
      const right = x < gw - 1 ? !exterior[y * gw + (x + 1)] : false
      if (!right) {
        vert.push({
          coord: ox + (x + 1) * cs,
          from: oy + y * cs,
          to: oy + (y + 1) * cs,
        })
      }
    }
  }

  const mergedH = mergeAxisAlignedEdges(horiz, OUTER_CONTOUR_MERGE_TOL)
  const mergedV = mergeAxisAlignedEdges(vert, OUTER_CONTOUR_MERGE_TOL)

  const contour: Line[] = []
  for (const h of mergedH) {
    contour.push({
      x1: h.from,
      y1: h.coord,
      x2: h.to,
      y2: h.coord,
      source: "exterior-contour",
    })
  }
  for (const v of mergedV) {
    contour.push({
      x1: v.coord,
      y1: v.from,
      x2: v.coord,
      y2: v.to,
      source: "exterior-contour",
    })
  }
  return { contour, fenceSegments, interiorCellCount }
}

type PrimitivesPage = {
  pageIndex: number
  pageBounds: BBox
  extractionMode: string
  lines: Line[]
  texts: TextRun[]
  operatorListLinesTruncated?: boolean
  coordinateNormalizationDebug?: unknown
}

async function loadPrimitives(
  inputPath: string
): Promise<{ primitives: PrimitivesPage[]; runtime: unknown; sourcePath: string }> {
  if (inputPath.toLowerCase().endsWith(".json")) {
    const raw = JSON.parse(fs.readFileSync(inputPath, "utf-8")) as {
      pdfPath?: string
      runtime?: unknown
      pages: PrimitivesPage[]
    }
    return {
      primitives: raw.pages,
      runtime: raw.runtime ?? null,
      sourcePath: raw.pdfPath ?? inputPath,
    }
  }
  const pdfBytes = new Uint8Array(fs.readFileSync(inputPath))
  const { primitives, runtime } = await extractPdfVectorPrimitives(pdfBytes)
  return { primitives: primitives as PrimitivesPage[], runtime, sourcePath: inputPath }
}

async function main(): Promise<void> {
  const inputPath =
    process.argv[2] != null && process.argv[2]!.length > 0
      ? path.resolve(process.cwd(), process.argv[2]!)
      : path.resolve(process.cwd(), "tower_41_ph3w.pdf")

  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input not found: ${inputPath}`)
  }

  const { primitives, runtime, sourcePath } = await loadPrimitives(inputPath)
  const isReplay = inputPath.toLowerCase().endsWith(".json")

  const outDir = path.join(process.cwd(), "debug")
  fs.mkdirSync(outDir, { recursive: true })

  const baseName = path.basename(sourcePath, path.extname(sourcePath))
  const base = baseName.endsWith("-primitives") ? baseName.slice(0, -"-primitives".length) : baseName

  if (!isReplay) {
    fs.writeFileSync(
      path.join(outDir, `${base}-primitives.json`),
      JSON.stringify(
        {
          pdfPath: sourcePath,
          runtime,
          pages: primitives.map((page) => ({
            pageIndex: page.pageIndex,
            pageBounds: page.pageBounds,
            extractionMode: page.extractionMode,
            operatorListLinesTruncated: !!page.operatorListLinesTruncated,
            coordinateNormalizationDebug: page.coordinateNormalizationDebug ?? null,
            lineCount: page.lines.length,
            textCount: page.texts.length,
            lines: page.lines,
            texts: page.texts,
          })),
        },
        null,
        2
      )
    )
  }

  const pageStats: Array<{
    pageIndex: number
    lineCount: number
    textCount: number
    extractionMode: string
    mainPlanArea: BBox
    apartmentArea: BBox
    structuralLineCount: number
    strongWallCount: number
    apartmentOuterContourSegments: number
    apartmentRoomAnchors: number
    apartmentInteriorCellCount: number
    apartmentFenceSegments: number
  }> = []

  for (const page of primitives) {
    const rawLineBox = bboxFromLines(page.lines)
    const planBox = expandBox(
      rawLineBox ?? {
        minX: page.pageBounds.minX,
        minY: page.pageBounds.minY,
        maxX: page.pageBounds.maxX,
        maxY: page.pageBounds.maxY,
      },
      PLAN_PAD
    )
    const mainPlanBox = deriveMainPlanArea(page)
    const apartmentBox = deriveApartmentArea(page, mainPlanBox)
    const width = planBox.maxX - planBox.minX
    const height = planBox.maxY - planBox.minY
    const parts: string[] = []
    const croppedLines = page.lines.filter((line) => lineTouchesBox(line, apartmentBox))
    const strongWalls = croppedLines.filter(
      (line) => segmentLength(line) >= WALL_MIN_LEN && isNearAxis(line)
    )
    const fixtureTexts = page.texts.filter((text) => FIXTURE_TEXT_RE.test(text.text) && pointInBox(text.x, text.y, planBox))
    const fixtureSupportLines = croppedLines.filter((line) => {
      const m = midpoint(line)
      return fixtureTexts.some((text) => Math.hypot(m.x - text.x, m.y - text.y) <= FIXTURE_KEEP_RADIUS)
    })
    const weakConnectorsRaw = croppedLines.filter((line) => {
      const len = segmentLength(line)
      if (len < WEAK_MIN_LEN || len >= WALL_MIN_LEN) return false
      const nearWall =
        nearestWallProjection(line.x1, line.y1, strongWalls, WEAK_CONNECTOR_NEAR_WALL_PT) != null ||
        nearestWallProjection(line.x2, line.y2, strongWalls, WEAK_CONNECTOR_NEAR_WALL_PT) != null
      const nearFixture = fixtureSupportLines.some((base) => {
        const m = midpoint(line)
        const mb = midpoint(base)
        return Math.hypot(m.x - mb.x, m.y - mb.y) <= FIXTURE_KEEP_RADIUS
      })
      return nearWall || nearFixture || !isNearAxis(line)
    })
    const weakConnectors = weakConnectorsRaw.map((line) =>
      snapLineToWalls(line, strongWalls, WEAK_CONNECTOR_NEAR_WALL_PT)
    )
    const structuralLines = dedupeLines([...strongWalls, ...fixtureSupportLines, ...weakConnectors])
    const roomAnchors = page.texts
      .filter(
        (text) => APARTMENT_ROOM_TEXT_RE.test(text.text) && pointInBox(text.x, text.y, apartmentBox)
      )
      .map((text) => {
        const w = text.width ?? Math.max(6, text.text.length * 4.5)
        const h = text.height ?? 8
        return { x: text.x + w / 2, y: text.y - h / 2 }
      })
    const {
      contour: apartmentOuterContour,
      fenceSegments: apartmentFenceSegments,
      interiorCellCount: apartmentInteriorCellCount,
    } = deriveApartmentOuterContour(structuralLines, apartmentBox, roomAnchors)
    const keptTexts = page.texts.filter((text) => {
      if (FIXTURE_TEXT_RE.test(text.text)) return pointInBox(text.x, text.y, apartmentBox)
      if (PLAN_TEXT_RE.test(text.text)) return pointInBox(text.x, text.y, apartmentBox)
      const tb = textBox(text, 1)
      return (
        tb.minX >= apartmentBox.minX &&
        tb.maxX <= apartmentBox.maxX &&
        tb.minY >= apartmentBox.minY &&
        tb.maxY <= apartmentBox.maxY
      )
    })

    parts.push(...svgHeader(width, height))
    parts.push(`<g transform="translate(${-planBox.minX} ${-planBox.minY})">`)

    parts.push(
      `<rect x="${mainPlanBox.minX}" y="${mainPlanBox.minY}" width="${boxWidth(mainPlanBox)}" height="${boxHeight(mainPlanBox)}" fill="#8b5cf6" opacity="0.06" />`
    )
    parts.push(
      `<rect x="${mainPlanBox.minX}" y="${mainPlanBox.minY}" width="${boxWidth(mainPlanBox)}" height="${boxHeight(mainPlanBox)}" fill="none" stroke="#8b5cf6" stroke-width="2.2" />`
    )
    parts.push(
      `<text x="${mainPlanBox.minX + 6}" y="${Math.max(mainPlanBox.minY - 6, planBox.minY + 10)}" font-size="8" font-family="Arial, sans-serif" fill="#6d28d9">Main plan area</text>`
    )
    parts.push(
      `<rect x="${apartmentBox.minX}" y="${apartmentBox.minY}" width="${boxWidth(apartmentBox)}" height="${boxHeight(apartmentBox)}" fill="#f59e0b" opacity="0.08" />`
    )
    parts.push(
      `<rect x="${apartmentBox.minX}" y="${apartmentBox.minY}" width="${boxWidth(apartmentBox)}" height="${boxHeight(apartmentBox)}" fill="none" stroke="#f59e0b" stroke-width="2" />`
    )
    parts.push(
      `<text x="${apartmentBox.minX + 6}" y="${apartmentBox.minY + 14}" font-size="8" font-family="Arial, sans-serif" fill="#b45309">Apartment area</text>`
    )

    for (const line of structuralLines) {
      const isFixtureLine = fixtureSupportLines.includes(line)
      const isStrongWall = strongWalls.includes(line)
      parts.push(
        `<line x1="${line.x1}" y1="${line.y1}" x2="${line.x2}" y2="${line.y2}" stroke="${isFixtureLine ? "#047857" : isStrongWall ? "#111827" : "#2563eb"}" stroke-width="${isFixtureLine ? "1.6" : isStrongWall ? "1.2" : "1.0"}" stroke-linecap="round" />`
      )
    }

    for (const line of apartmentFenceSegments) {
      parts.push(
        `<line x1="${line.x1}" y1="${line.y1}" x2="${line.x2}" y2="${line.y2}" stroke="#06b6d4" stroke-width="2.0" stroke-dasharray="4 2" stroke-linecap="round" />`
      )
    }
    for (const line of apartmentOuterContour) {
      parts.push(
        `<line x1="${line.x1}" y1="${line.y1}" x2="${line.x2}" y2="${line.y2}" stroke="#dc2626" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" />`
      )
    }
    if (apartmentOuterContour.length) {
      parts.push(
        `<text x="${apartmentBox.minX + 6}" y="${apartmentBox.minY + 26}" font-size="8" font-family="Arial, sans-serif" fill="#b91c1c">Apartment outer contour</text>`
      )
    }
    if (apartmentFenceSegments.length) {
      parts.push(
        `<text x="${apartmentBox.minX + 6}" y="${apartmentBox.minY + 38}" font-size="8" font-family="Arial, sans-serif" fill="#0891b2">Synthesized perimeter closure (window run)</text>`
      )
    }

    for (const text of keptTexts) {
      const isFixture = FIXTURE_TEXT_RE.test(text.text)
      parts.push(`<circle cx="${text.x}" cy="${text.y}" r="${isFixture ? "1.8" : "1.2"}" fill="${isFixture ? "#b45309" : "#dc2626"}" />`)
      parts.push(
        `<text x="${text.x + 3}" y="${text.y - 3}" font-size="${TEXT_FONT_SIZE}" font-family="Arial, sans-serif" fill="${isFixture ? "#92400e" : "#374151"}">${escapeXml(text.text)}</text>`
      )
    }

    parts.push(
      `<rect x="${planBox.minX}" y="${planBox.minY}" width="${width}" height="${height}" fill="none" stroke="#d1d5db" stroke-width="0.8" />`
    )
    parts.push(`</g>`)
    parts.push(svgFooter())

    fs.writeFileSync(path.join(outDir, `${base}-page-${page.pageIndex}.svg`), parts.join("\n"))

    pageStats.push({
      pageIndex: page.pageIndex,
      lineCount: page.lines.length,
      textCount: page.texts.length,
      extractionMode: page.extractionMode,
      mainPlanArea: mainPlanBox,
      apartmentArea: apartmentBox,
      structuralLineCount: structuralLines.length,
      strongWallCount: strongWalls.length,
      apartmentOuterContourSegments: apartmentOuterContour.length,
      apartmentRoomAnchors: roomAnchors.length,
      apartmentInteriorCellCount: apartmentInteriorCellCount,
      apartmentFenceSegments: apartmentFenceSegments.length,
    })
  }

  console.log(
    JSON.stringify(
      {
        inputPath,
        sourcePath,
        outputDir: outDir,
        pageCount: primitives.length,
        pages: pageStats,
      },
      null,
      2
    )
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
