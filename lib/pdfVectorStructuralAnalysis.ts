import { rectangleFootprintFromAABB } from "@/lib/floorplanGeometry"
import type {
  FloorplanDoorOpening,
  FloorplanGeometry,
  FloorplanPoint2D,
  FloorplanWallSegment,
  FloorplanWindowOpening,
} from "@/lib/types"
import { extractPdfVectorPrimitives } from "@/lib/geometryFirst/extractPdfVectorPrimitives"

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
/** Minimum stroke length for a PDF line to qualify as structural "wall" evidence.
 * Architectural walls are often fragmented into ≤6 pt segments — 7 pt was silently dropping pieces. */
const WALL_MIN_LEN = 5
const WEAK_MIN_LEN = 1.5
const AXIS_TOL_DEG = 8
const WEAK_CONNECTOR_NEAR_WALL_PT = 8
const FIXTURE_KEEP_RADIUS = 34
const APARTMENT_TEXT_PAD = 88

// Step 1 — outer contour rasterization
const OUTER_CONTOUR_CELL_SIZE = 3
/**
 * Cells of padding around the strong-wall bbox in the rasterization grid. Kept tight (1 cell ≈ 3 pt)
 * so flood-fill can't leak through window/door openings into a large empty halo and dilute the
 * recovered outline into the apartmentBox rectangle.
 */
const OUTER_CONTOUR_PAD_CELLS = 1
/**
 * Dilation radius (cells, each = `OUTER_CONTOUR_CELL_SIZE` PDF pt). Tight to keep door openings
 * passable; we rely on interior morphological closing to bridge any remaining gaps.
 */
const OUTER_CONTOUR_DILATE_RADIUS = 2
/**
 * Interior morphological closing radius (cells). Bridges narrow disconnects between rooms whose
 * doorway was over-blocked by wall dilation, and connects rooms whose anchors live in different
 * wings of the unit. Large enough to cross typical interior partitions (~12 pt thick).
 */
const INTERIOR_CLOSING_RADIUS = 4
const OUTER_CONTOUR_FENCE_BAND_CELLS = 2
/** Drop polygon corners closer than this many PDF points (post-stitch simplification). */
const CONTOUR_MIN_EDGE_PT = 1.5

// Step 2 — double-line wall pairing thresholds (PDF points)
const WALL_PAIR_MIN_GAP_PT = 2.4 // ~ 0.05 m at typical scales
const WALL_PAIR_MAX_GAP_PT = 18 // ~ 0.40 m
const WALL_PAIR_PARALLEL_TOL_DEG = 1.5
const WALL_PAIR_MIN_OVERLAP_RATIO = 0.55
const WALL_SINGLETON_THICKNESS_PT = 4 // ~ 0.10 m fallback

// Step 3a — interior/exterior wall classification (PDF points)
/** Wall is "exterior" when its midpoint is within this many pt of the recovered polygon edge. */
const WALL_EXTERIOR_DISTANCE_PT = 9
/** Lookup tolerance when projecting a wall onto a polygon edge. */
const WALL_EXTERIOR_PROJECTION_OVERLAP_PT = 4
/**
 * Appliance-symbol scribbles this short remain `fixture`; longer strokes beside WC/DW/REF/etc.
 * are treated as enclosing walls (partition classification).
 */
const FIXTURE_MICRO_LEN_PT = 2.5

// Step 3b — window detection
/** Short axis-aligned line candidates for window glass / hatch. */
const WINDOW_GLASS_MAX_LEN_PT = 22
/** Perpendicular search radius around the host wall when collecting window candidates. */
const WINDOW_BAND_PT = 18
/** Minimum count of parallel short lines to call something a window (relaxed from 3 to 2). */
const WINDOW_MIN_PARALLEL_LINES = 2
/** Minimum window mouth width in PDF pt (~0.30 m). */
const WINDOW_MIN_WIDTH_PT = 12
/** Maximum gap between consecutive glass lines that we still treat as the same window. */
const WINDOW_GROUP_GAP_PT = 14
/** Maximum window mouth width — refuse runs that span an entire wall (likely whole-room hatch). */
const WINDOW_MAX_WIDTH_PT = 220 // ~ 6 m

// Step 3c — door detection
/**
 * Door opening width range (PDF pt). Typical residential interior doors are 24–36" (~12–20 pt
 * at 1:96 / floor-plan scales we see); double doors / patio sliders go up to 72" (~36 pt).
 * Anything wider is an open passage and we report it but not as a "door".
 */
const DOOR_MIN_WIDTH_PT = 10
const DOOR_MAX_WIDTH_PT = 60
/** A wall break is a "gap" only if both jamb endpoints land within this many pt of the same line. */
const DOOR_JAMB_ALIGN_PT = 4
/** Search radius to find perpendicular jamb lines around a wall break. */
const DOOR_JAMB_RADIUS_PT = 10
/** Jamb / swing-arc-chord candidate length range. */
const DOOR_JAMB_MIN_LEN_PT = 2
const DOOR_JAMB_MAX_LEN_PT = 20
/**
 * Minimum jamb evidence to call a wall break a door. Doors in plans almost always have
 * door-leaf or arc geometry; raising this from 1 to 2 kills the noisy "any wall break = door"
 * matches that the looser threshold produced.
 */
const DOOR_MIN_TOTAL_JAMB_HITS = 2
/** Buffer added around a detected window's mouth when excluding door candidates. */
const DOOR_WINDOW_EXCLUDE_PAD_PT = 4

// Step 3d — glass / window detection from drawing-convention signatures
/**
 * In this set of floor-plan PDFs glass is always rendered with one of two conventions:
 *   (A) **Thin double-line pair** — two parallel axis-aligned line segments separated by a tiny
 *       perpendicular gap (≈ 0.5–1.5 pt; an order of magnitude thinner than a solid wall pair).
 *       These represent the inner / outer face of the glass pane.
 *   (B) **Mullion-tick ribbon** — a long row of short axial ticks at periodic spacing along the
 *       outer shell, with NO continuous backing line. Used for full-wall / floor-to-ceiling
 *       windows where the outer wall is replaced by a glass curtain.
 * (A) catches every regular window the floor-plan draws (curtain walls between pillars, balcony
 * doors, side windows, etc.); (B) catches the wide ribbon windows that (A) misses because no
 * continuous strokes exist there. We run both and dedupe by overlapping mouth.
 */

// (A) Thin double-line glass pair — strict gap window distinguishes glass from solid walls.
const GLASS_PAIR_MIN_GAP_PT = 0.4
const GLASS_PAIR_MAX_GAP_PT = 1.5
/** Each line in a glass pair must be at least this long (filters tick / decoration noise). */
const GLASS_SEG_MIN_LEN_PT = 4
/** Two pair-evidence segments belong to the same glass band when their perp coords are within this many pt. */
const GLASS_BAND_PT = 2.2
/** Adjacent pair-evidence segments closer than this many pt along the axis count as one strip. */
const GLASS_ALONG_GAP_MAX_PT = 5
/** Reject thin-pair "windows" shorter than this many pt — typical small windows are ≥ 18 pt. */
const GLASS_MIN_STRIP_LEN_PT = 12
/**
 * Threshold for tagging a glass strip as "exterior" (close to the apartment's outer boundary).
 * Generous enough to catch setback / bay windows and balcony glass that sit a bit inside the
 * apartmentBox edge. We still emit interior strips — the renderer can pick which to use.
 */
const GLASS_EXTERIOR_PROXIMITY_PT = 50

// (B) Mullion-tick ribbon — fallback for full-wall windows where (A) finds no double-line.
const MULLION_TICK_MIN_LEN_PT = 0.4
const MULLION_TICK_MAX_LEN_PT = 3.0
/** Two ticks belong to the same band when their perpendicular coords differ by ≤ this many pt. */
const MULLION_BAND_PT = 4
/** Maximum along-axis gap between adjacent ticks in the same cluster. */
const MULLION_TICK_MAX_GAP_PT = 22
/** Minimum tick count + minimum along-axis span to call a cluster a mullion ribbon. */
const MULLION_MIN_TICKS = 5
const MULLION_MIN_SPAN_PT = 30
/** A ribbon is reported as an exterior window when its perpendicular coord is within this many pt of the apartmentBox edge. */
const MULLION_EXTERIOR_PROXIMITY_PT = 35

const FIXTURE_TEXT_RE = /\b(WC|DW|DC|REF|OV|MW|W\/D)\b/i
const APARTMENT_ROOM_TEXT_RE =
  /\b(PRIMARY BEDROOM|BEDROOM\s*\d*|PRIMARY BATH(?:\s*\d+)?|BATH(?:ROOM)?(?:\s*\d+)?|KITCHEN|LIVING|DINING|FOYER|WIC|LIBRARY|OFFICE|FAMILY(?:\s+ROOM)?|GREAT(?:\s+ROOM)?|MEDIA(?:\s+ROOM)?|GAME(?:\s+ROOM)?|PLAY(?:\s+ROOM)?|STUDY|DEN|HALL(?:WAY)?|PANTRY|LAUNDRY|MUDROOM|MUD\s+ROOM|POWDER|PWDR|STORAGE|GYM|NOOK|BREAKFAST)\b/i

export interface PdfVectorStructuralAnalysisResult {
  geometry: FloorplanGeometry
  apartmentBoxPdf: BBox
  /** True when Step 1 successfully recovered an outer contour polygon from vector evidence. */
  outerContourFromVector: boolean
  /** Vertices in the recovered polygon (rect fallback = 4). */
  outerContourVertexCount: number
  /** How many double-line wall pairs Step 2 produced. */
  doubleLineWallCount: number
  /** How many singleton (unpaired) walls were emitted with default thickness. */
  singletonWallCount: number
  /** How many strong walls were classified as exterior (along the polygon shell). */
  exteriorWallCount: number
  /** How many strong walls were classified as interior partitions. */
  interiorWallCount: number
  /** How many fixture-support lines were preserved. */
  fixtureLineCount: number
  /** Detected window openings along the exterior shell. */
  windowCount: number
  /** Detected door openings (wall breaks with jamb evidence). */
  doorCount: number
  structuralLineCount: number
  strongWallCount: number
  notes: string[]
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

/** Density-based 2D cluster of points; returns indices of the densest cluster (eps in PDF pt). */
function densestCluster(points: Array<{ x: number; y: number }>, eps: number): number[] {
  if (!points.length) return []
  const n = points.length
  const visited = new Uint8Array(n)
  let bestCluster: number[] = []
  for (let i = 0; i < n; i++) {
    if (visited[i]) continue
    const stack = [i]
    const cluster: number[] = []
    while (stack.length) {
      const cur = stack.pop()!
      if (visited[cur]) continue
      visited[cur] = 1
      cluster.push(cur)
      const a = points[cur]
      for (let j = 0; j < n; j++) {
        if (visited[j]) continue
        const b = points[j]
        if (Math.hypot(a.x - b.x, a.y - b.y) <= eps) stack.push(j)
      }
    }
    if (cluster.length > bestCluster.length) bestCluster = cluster
  }
  return bestCluster
}

/**
 * Filter room-name anchor texts down to the densest cluster — drops out-of-band labels like
 * page-edge legends ("LIBRARY / OFFICE / FAMILY ROOM" stacked at x≈37) that would otherwise
 * pull the apartment area outward.
 */
function filterApartmentAnchors(texts: TextRun[]): TextRun[] {
  const matches = texts.filter((t) => APARTMENT_ROOM_TEXT_RE.test(t.text))
  if (matches.length <= 2) return matches
  const points = matches.map((t) => ({ x: t.x, y: t.y }))
  // 150 PDF pt ≈ 4 m at typical floorplan scales — generous enough that two adjacent rooms in
  // the same unit always cluster together, tight enough that off-page legends don't merge in.
  const idx = densestCluster(points, 150)
  if (!idx.length) return matches
  return idx.map((i) => matches[i])
}

function deriveApartmentArea(page: { pageBounds: BBox; lines: Line[]; texts: TextRun[] }): BBox {
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

  const apartmentTexts = filterApartmentAnchors(
    page.texts.filter((text) => pointInBox(text.x, text.y, planBox))
  )
  const roomTextBoxes = apartmentTexts.map((text) => textBox(text, APARTMENT_TEXT_PAD))

  if (!roomTextBoxes.length) return expandBox(planBox, -Math.min(PLAN_PAD - 2, 10))

  const anchorBox = bboxFromBoxes(roomTextBoxes) ?? planBox
  const anchoredLines = page.lines.filter((line) => lineTouchesBox(line, anchorBox))
  const anchoredLineBox = bboxFromLines(anchoredLines)

  return expandBox(anchoredLineBox ?? anchorBox, 12)
}

function mapPoint(p: FloorplanPoint2D, source: BBox, target: BBox): FloorplanPoint2D {
  const sourceW = Math.max(1e-6, source.maxX - source.minX)
  const sourceH = Math.max(1e-6, source.maxY - source.minY)
  const targetW = target.maxX - target.minX
  const targetH = target.maxY - target.minY
  return {
    x: target.minX + ((p.x - source.minX) / sourceW) * targetW,
    // PDF Y axis points the same as viewport (top-left origin); flip to plan Y so larger PDF y → smaller plan y.
    y: target.minY + ((source.maxY - p.y) / sourceH) * targetH,
  }
}

// ============================================================================
// Step 1 — outer contour polygon recovery (raster + dilate + flood-fill + stitch)
// ============================================================================

function rasterizeLinesToGrid(
  lines: Line[],
  box: BBox,
  cellSize: number,
  padCells: number
): { grid: Uint8Array; gw: number; gh: number; ox: number; oy: number } {
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

/** Morphological erosion (mirror of dilation). */
function erodeGrid(grid: Uint8Array, gw: number, gh: number, radius: number): Uint8Array {
  if (radius <= 0) return new Uint8Array(grid)
  const r2 = radius * radius
  const out = new Uint8Array(gw * gh)
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      let keep = !!grid[y * gw + x]
      if (!keep) continue
      for (let dy = -radius; dy <= radius && keep; dy++) {
        for (let dx = -radius; dx <= radius && keep; dx++) {
          if (dx * dx + dy * dy > r2) continue
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || nx >= gw || ny < 0 || ny >= gh) {
            keep = false
            break
          }
          if (!grid[ny * gw + nx]) keep = false
        }
      }
      if (keep) out[y * gw + x] = 1
    }
  }
  return out
}

function floodFillFromSeeds(
  walls: Uint8Array,
  gw: number,
  gh: number,
  seeds: Array<{ cx: number; cy: number }>
): Uint8Array {
  const interior = new Uint8Array(gw * gh)
  const stack: number[] = []
  const seed = (x: number, y: number): boolean => {
    if (x < 0 || x >= gw || y < 0 || y >= gh) return false
    const i = y * gw + x
    if (walls[i] || interior[i]) return false
    interior[i] = 1
    stack.push(i)
    return true
  }
  for (const s of seeds) {
    let seeded = seed(s.cx, s.cy)
    for (let r = 1; r <= 6 && !seeded; r++) {
      seeded =
        seed(s.cx - r, s.cy) ||
        seed(s.cx + r, s.cy) ||
        seed(s.cx, s.cy - r) ||
        seed(s.cx, s.cy + r)
    }
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
  return interior
}

function floodFillFromBoundary(walls: Uint8Array, gw: number, gh: number): Uint8Array {
  const exterior = new Uint8Array(gw * gh)
  const stack: number[] = []
  const seed = (x: number, y: number) => {
    if (x < 0 || x >= gw || y < 0 || y >= gh) return
    const i = y * gw + x
    if (walls[i] || exterior[i]) return
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

/** Largest 4-connected component label within `mask`. Returns labelled mask + chosen label. */
function largestComponent(
  mask: Uint8Array,
  gw: number,
  gh: number
): { labels: Int32Array; bestLabel: number; bestSize: number } {
  const labels = new Int32Array(gw * gh)
  let nextLabel = 0
  let bestLabel = 0
  let bestSize = 0
  const stack: number[] = []
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || labels[i]) continue
    nextLabel++
    labels[i] = nextLabel
    stack.push(i)
    let size = 0
    while (stack.length) {
      const idx = stack.pop()!
      size++
      const x = idx % gw
      const y = (idx / gw) | 0
      const tryNeighbour = (nx: number, ny: number) => {
        if (nx < 0 || nx >= gw || ny < 0 || ny >= gh) return
        const ni = ny * gw + nx
        if (!mask[ni] || labels[ni]) return
        labels[ni] = nextLabel
        stack.push(ni)
      }
      tryNeighbour(x - 1, y)
      tryNeighbour(x + 1, y)
      tryNeighbour(x, y - 1)
      tryNeighbour(x, y + 1)
    }
    if (size > bestSize) {
      bestSize = size
      bestLabel = nextLabel
    }
  }
  return { labels, bestLabel, bestSize }
}

/**
 * Trace the outer contour of a binary region (`region` cells = 1) on a grid using
 * Moore-neighbourhood edge walking. Returns axis-aligned polygon vertices in PDF point space
 * (matching `cellSize`/`ox`/`oy`). Vertices are ordered CCW in PDF coordinates.
 *
 * Algorithm: enumerate every horizontal/vertical edge that separates a region cell from a
 * non-region cell, then stitch them into a closed loop by chaining shared endpoints.
 */
function traceOuterContourPolygon(
  region: Uint8Array,
  gw: number,
  gh: number,
  ox: number,
  oy: number,
  cellSize: number
): FloorplanPoint2D[] | null {
  type Edge = { ax: number; ay: number; bx: number; by: number; horizontal: boolean }
  const edges: Edge[] = []

  // Horizontal edges (between row y-1 and row y, x in [0, gw))
  for (let y = 0; y <= gh; y++) {
    for (let x = 0; x < gw; x++) {
      const above = y > 0 ? region[(y - 1) * gw + x] : 0
      const below = y < gh ? region[y * gw + x] : 0
      if (!!above === !!below) continue
      // Edge along (x → x+1) at y
      const ax = ox + x * cellSize
      const ay = oy + y * cellSize
      const bx = ox + (x + 1) * cellSize
      const by = ay
      // CCW orientation: region on left of walk direction.
      // PDF y grows downward; we'll just collect both directions and stitch by endpoint.
      if (above && !below) {
        edges.push({ ax: bx, ay: by, bx: ax, by: ay, horizontal: true })
      } else {
        edges.push({ ax, ay, bx, by, horizontal: true })
      }
    }
  }
  // Vertical edges
  for (let x = 0; x <= gw; x++) {
    for (let y = 0; y < gh; y++) {
      const left = x > 0 ? region[y * gw + (x - 1)] : 0
      const right = x < gw ? region[y * gw + x] : 0
      if (!!left === !!right) continue
      const ax = ox + x * cellSize
      const ay = oy + y * cellSize
      const bx = ax
      const by = oy + (y + 1) * cellSize
      if (left && !right) {
        edges.push({ ax, ay, bx, by, horizontal: false })
      } else {
        edges.push({ ax: bx, ay: by, bx: ax, by: ay, horizontal: false })
      }
    }
  }

  if (!edges.length) return null

  // Stitch edges: each edge starts at (ax,ay), ends at (bx,by); find next edge whose start ≈ this end.
  const keyOf = (x: number, y: number) => `${Math.round(x * 100)},${Math.round(y * 100)}`
  const startMap = new Map<string, number[]>()
  for (let i = 0; i < edges.length; i++) {
    const k = keyOf(edges[i].ax, edges[i].ay)
    const arr = startMap.get(k) ?? []
    arr.push(i)
    startMap.set(k, arr)
  }

  // Collect all closed loops, pick the one with largest |signed area|.
  const used = new Uint8Array(edges.length)
  let bestLoop: FloorplanPoint2D[] | null = null
  let bestArea = 0
  for (let i = 0; i < edges.length; i++) {
    if (used[i]) continue
    const loop: FloorplanPoint2D[] = []
    let cur = i
    let safety = edges.length + 4
    while (safety-- > 0) {
      if (used[cur]) break
      used[cur] = 1
      const e = edges[cur]
      loop.push({ x: e.ax, y: e.ay })
      const k = keyOf(e.bx, e.by)
      const candidates = startMap.get(k)
      if (!candidates || !candidates.length) break
      let next = -1
      for (const c of candidates) {
        if (!used[c]) {
          next = c
          break
        }
      }
      if (next < 0) {
        // closed back to start?
        const startK = keyOf(edges[i].ax, edges[i].ay)
        if (startK === k) {
          // closed loop
          break
        }
        break
      }
      cur = next
    }
    if (loop.length < 4) continue
    // Simplify collinear runs
    const simplified: FloorplanPoint2D[] = []
    for (let j = 0; j < loop.length; j++) {
      const prev = simplified[simplified.length - 1]
      const cand = loop[j]
      if (prev && Math.hypot(cand.x - prev.x, cand.y - prev.y) < CONTOUR_MIN_EDGE_PT) continue
      // remove collinear middle vertex
      if (simplified.length >= 2) {
        const a = simplified[simplified.length - 2]
        const b = simplified[simplified.length - 1]
        const cross = (b.x - a.x) * (cand.y - a.y) - (b.y - a.y) * (cand.x - a.x)
        if (Math.abs(cross) < 1e-3) {
          simplified[simplified.length - 1] = cand
          continue
        }
      }
      simplified.push(cand)
    }
    if (simplified.length < 3) continue
    let area = 0
    for (let j = 0; j < simplified.length; j++) {
      const a = simplified[j]
      const b = simplified[(j + 1) % simplified.length]
      area += a.x * b.y - b.x * a.y
    }
    const abs = Math.abs(area / 2)
    if (abs > bestArea) {
      bestArea = abs
      bestLoop = simplified
    }
  }
  return bestLoop
}

function buildOuterContourPolygonPdf(
  walls: Line[],
  apartmentBox: BBox,
  roomAnchors: Array<{ x: number; y: number }>
): {
  polygon: FloorplanPoint2D[]
  interiorCellCount: number
  anchorsCovered: number
} | null {
  if (!walls.length) return null
  const cs = OUTER_CONTOUR_CELL_SIZE
  // Tight box around actual wall geometry (not the room-anchor apartmentBox, which is padded
  // ~12 pt beyond walls and would let flood-fill leak through window openings into a halo).
  const wallBbox = bboxFromLines(walls)
  if (!wallBbox) return null
  void apartmentBox
  const { grid, gw, gh, ox, oy } = rasterizeLinesToGrid(
    walls,
    wallBbox,
    cs,
    OUTER_CONTOUR_PAD_CELLS
  )
  const dilated = dilateGrid(grid, gw, gh, OUTER_CONTOUR_DILATE_RADIUS)

  // Seed interior flood-fill from room anchors (so we don't accidentally fill alcoves outside the unit).
  const seeds = roomAnchors.map((a) => ({
    cx: Math.floor((a.x - ox) / cs),
    cy: Math.floor((a.y - oy) / cs),
  }))
  let interior = floodFillFromSeeds(dilated, gw, gh, seeds)

  // Fence the outer band along apartmentBox edges if interior already touches an interior band
  // (handles open spans like full-height window walls where dilation alone leaves leaks).
  const fenced = new Uint8Array(dilated)
  const py1 = OUTER_CONTOUR_PAD_CELLS
  const py2 = gh - OUTER_CONTOUR_PAD_CELLS - 1
  const px1 = OUTER_CONTOUR_PAD_CELLS
  const px2 = gw - OUTER_CONTOUR_PAD_CELLS - 1
  const checkBand = (x: number, y: number, dx: number, dy: number): boolean => {
    for (let k = 0; k <= OUTER_CONTOUR_FENCE_BAND_CELLS; k++) {
      const nx = x + dx * k
      const ny = y + dy * k
      if (nx < 0 || nx >= gw || ny < 0 || ny >= gh) continue
      if (interior[ny * gw + nx]) return true
    }
    return false
  }
  for (let x = px1; x <= px2; x++) {
    if (checkBand(x, py1, 0, 1) && !fenced[py1 * gw + x]) fenced[py1 * gw + x] = 1
    if (checkBand(x, py2, 0, -1) && !fenced[py2 * gw + x]) fenced[py2 * gw + x] = 1
  }
  for (let y = py1; y <= py2; y++) {
    if (checkBand(px1, y, 1, 0) && !fenced[y * gw + px1]) fenced[y * gw + px1] = 1
    if (checkBand(px2, y, -1, 0) && !fenced[y * gw + px2]) fenced[y * gw + px2] = 1
  }
  // Re-flood with fences in place to tighten interior to within fence band.
  if (seeds.length) {
    interior = floodFillFromSeeds(fenced, gw, gh, seeds)
  } else {
    // No room anchors: invert exterior flood to get interior of largest non-wall void.
    const exterior = floodFillFromBoundary(fenced, gw, gh)
    for (let i = 0; i < interior.length; i++) {
      interior[i] = !fenced[i] && !exterior[i] ? 1 : 0
    }
  }

  let interiorCellCount = 0
  for (let i = 0; i < interior.length; i++) if (interior[i]) interiorCellCount++
  if (!interiorCellCount) return null

  // ---- NEW: keep every connected interior component that contains at least one room anchor.
  // This replaces the old "largest component only" filter which dropped whole rooms when
  // flood-fill couldn't bridge a tightly-blocked doorway. We also drop tiny stray pockets
  // (< MIN_COMPONENT_CELLS) that flooded through wall gaps but contain no anchor.
  const ANCHOR_KEEP_MIN_CELLS = 25 // ~ 0.06 m² at 3 pt cell
  const { labels: compLabels } = labelComponents(interior, gw, gh)
  const compStats = new Map<number, { size: number; hasAnchor: boolean }>()
  for (let i = 0; i < compLabels.length; i++) {
    const lab = compLabels[i]
    if (!lab) continue
    const cur = compStats.get(lab) ?? { size: 0, hasAnchor: false }
    cur.size++
    compStats.set(lab, cur)
  }
  for (const s of seeds) {
    if (s.cx < 0 || s.cx >= gw || s.cy < 0 || s.cy >= gh) continue
    // Anchor may have been seeded with an offset; sweep a small radius for the cell's true label.
    for (let r = 0; r <= 6; r++) {
      let found = false
      for (let dy = -r; dy <= r && !found; dy++) {
        for (let dx = -r; dx <= r && !found; dx++) {
          if (Math.abs(dx) !== r && Math.abs(dy) !== r && r > 0) continue
          const nx = s.cx + dx, ny = s.cy + dy
          if (nx < 0 || nx >= gw || ny < 0 || ny >= gh) continue
          const lab = compLabels[ny * gw + nx]
          if (lab) {
            const cur = compStats.get(lab) ?? { size: 0, hasAnchor: false }
            cur.hasAnchor = true
            compStats.set(lab, cur)
            found = true
          }
        }
      }
      if (found) break
    }
  }
  const keepLabels = new Set<number>()
  let anchorsCovered = 0
  for (const [lab, st] of compStats) {
    if (st.hasAnchor) {
      keepLabels.add(lab)
      anchorsCovered++
      continue
    }
    // No anchor → only keep if it's a sizeable pocket (likely a hallway/closet missed by anchor regex)
    // AND it's connected to an anchored component via ≤ INTERIOR_CLOSING_RADIUS gap.
    if (st.size >= ANCHOR_KEEP_MIN_CELLS) keepLabels.add(lab)
  }
  const anchored = new Uint8Array(gw * gh)
  for (let i = 0; i < anchored.length; i++) {
    if (compLabels[i] && keepLabels.has(compLabels[i])) anchored[i] = 1
  }

  // Morphological closing on the kept interior mask — bridges room disconnects.
  const closingRadius = INTERIOR_CLOSING_RADIUS
  const dilatedInterior = dilateGrid(anchored, gw, gh, closingRadius)
  const closed = erodeGrid(dilatedInterior, gw, gh, closingRadius)
  for (let i = 0; i < closed.length; i++) if (anchored[i]) closed[i] = 1

  // ---- NEW: union with the wall mask itself.
  // The "apartment shape" is interior cells + the walls bounding them. Without this, the contour
  // hugs the inside face of walls and can leave the outermost wall geometry outside the polygon.
  const apartmentMask = new Uint8Array(gw * gh)
  for (let i = 0; i < apartmentMask.length; i++) {
    apartmentMask[i] = closed[i] || dilated[i] ? 1 : 0
  }

  // Pick the largest connected component AFTER union — typically a single shape now.
  const { labels, bestLabel } = largestComponent(apartmentMask, gw, gh)
  const region = new Uint8Array(gw * gh)
  for (let i = 0; i < region.length; i++) region[i] = labels[i] === bestLabel ? 1 : 0

  const polygon = traceOuterContourPolygon(region, gw, gh, ox, oy, cs)
  if (!polygon || polygon.length < 4) return null
  return { polygon, interiorCellCount, anchorsCovered }
}

/**
 * Label all connected components in a binary mask (4-neighbour). Returns one label per cell;
 * 0 means background. Lighter than `largestComponent`: doesn't pick a winner.
 */
function labelComponents(
  mask: Uint8Array,
  gw: number,
  gh: number
): { labels: Int32Array } {
  const labels = new Int32Array(gw * gh)
  let nextLabel = 0
  const stack: number[] = []
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || labels[i]) continue
    nextLabel++
    labels[i] = nextLabel
    stack.push(i)
    while (stack.length) {
      const idx = stack.pop()!
      const x = idx % gw
      const y = (idx / gw) | 0
      const try_ = (nx: number, ny: number) => {
        if (nx < 0 || nx >= gw || ny < 0 || ny >= gh) return
        const ni = ny * gw + nx
        if (!mask[ni] || labels[ni]) return
        labels[ni] = nextLabel
        stack.push(ni)
      }
      try_(x - 1, y)
      try_(x + 1, y)
      try_(x, y - 1)
      try_(x, y + 1)
    }
  }
  return { labels }
}

// ============================================================================
// Step 2 — double-line wall pairing → centerline + thickness
// ============================================================================

type WallSeg = Line & { axis: "h" | "v" | "d" }

function classifyAxis(line: Line): "h" | "v" | "d" {
  const ang = angleDegrees(line)
  if (ang <= WALL_PAIR_PARALLEL_TOL_DEG * 2) return "h"
  if (90 - ang <= WALL_PAIR_PARALLEL_TOL_DEG * 2) return "v"
  return "d"
}

interface WallPair {
  /** Centerline (midpoint between the two parallel walls). */
  x1: number
  y1: number
  x2: number
  y2: number
  /** Perpendicular distance between the paired walls, in PDF points. */
  thicknessPt: number
}

/**
 * Pair axis-aligned wall segments into double-line walls. Returns centerlines + thickness, plus
 * any segments that didn't pair (caller can emit those as singletons with default thickness).
 */
function pairDoubleLineWalls(walls: Line[]): {
  pairs: WallPair[]
  unpaired: Line[]
} {
  const segs: WallSeg[] = walls.map((w) => ({ ...w, axis: classifyAxis(w) }))
  const pairs: WallPair[] = []
  const used = new Uint8Array(segs.length)

  // Group by axis class.
  const horizontals = segs
    .map((s, i) => ({ s, i }))
    .filter((e) => e.s.axis === "h")
  const verticals = segs
    .map((s, i) => ({ s, i }))
    .filter((e) => e.s.axis === "v")

  const tryPairAxis = (group: Array<{ s: WallSeg; i: number }>, axis: "h" | "v") => {
    // For each segment, find the closest parallel partner with valid overlap.
    for (let a = 0; a < group.length; a++) {
      const ea = group[a]
      if (used[ea.i]) continue
      const sa = ea.s
      // Coordinate: for h walls the "perpendicular" is y; for v walls it's x.
      // Range coord: the running coordinate along the wall.
      const aPerp = axis === "h" ? (sa.y1 + sa.y2) / 2 : (sa.x1 + sa.x2) / 2
      const aRangeMin = axis === "h" ? Math.min(sa.x1, sa.x2) : Math.min(sa.y1, sa.y2)
      const aRangeMax = axis === "h" ? Math.max(sa.x1, sa.x2) : Math.max(sa.y1, sa.y2)
      const aLen = aRangeMax - aRangeMin
      if (aLen < WALL_MIN_LEN) continue

      let bestB = -1
      let bestGap = Infinity
      let bestOverlap = 0
      for (let b = a + 1; b < group.length; b++) {
        const eb = group[b]
        if (used[eb.i]) continue
        const sb = eb.s
        const bPerp = axis === "h" ? (sb.y1 + sb.y2) / 2 : (sb.x1 + sb.x2) / 2
        const gap = Math.abs(aPerp - bPerp)
        if (gap < WALL_PAIR_MIN_GAP_PT || gap > WALL_PAIR_MAX_GAP_PT) continue
        const bRangeMin = axis === "h" ? Math.min(sb.x1, sb.x2) : Math.min(sb.y1, sb.y2)
        const bRangeMax = axis === "h" ? Math.max(sb.x1, sb.x2) : Math.max(sb.y1, sb.y2)
        const overlap = Math.max(0, Math.min(aRangeMax, bRangeMax) - Math.max(aRangeMin, bRangeMin))
        const minLen = Math.min(aLen, bRangeMax - bRangeMin)
        if (minLen <= 0) continue
        const ratio = overlap / minLen
        if (ratio < WALL_PAIR_MIN_OVERLAP_RATIO) continue
        // Prefer smallest gap (tightest pair) ties broken by larger overlap.
        if (gap < bestGap || (Math.abs(gap - bestGap) < 0.5 && overlap > bestOverlap)) {
          bestGap = gap
          bestOverlap = overlap
          bestB = b
        }
      }
      if (bestB < 0) continue
      const eb = group[bestB]
      used[ea.i] = 1
      used[eb.i] = 1
      const sa2 = ea.s
      const sb2 = eb.s
      const aPerpCoord = axis === "h" ? (sa2.y1 + sa2.y2) / 2 : (sa2.x1 + sa2.x2) / 2
      const bPerpCoord = axis === "h" ? (sb2.y1 + sb2.y2) / 2 : (sb2.x1 + sb2.x2) / 2
      const centerPerp = (aPerpCoord + bPerpCoord) / 2
      const aRangeMinB = axis === "h" ? Math.min(sa2.x1, sa2.x2) : Math.min(sa2.y1, sa2.y2)
      const aRangeMaxB = axis === "h" ? Math.max(sa2.x1, sa2.x2) : Math.max(sa2.y1, sa2.y2)
      const bRangeMinB = axis === "h" ? Math.min(sb2.x1, sb2.x2) : Math.min(sb2.y1, sb2.y2)
      const bRangeMaxB = axis === "h" ? Math.max(sb2.x1, sb2.x2) : Math.max(sb2.y1, sb2.y2)
      const r1 = Math.max(aRangeMinB, bRangeMinB)
      const r2 = Math.min(aRangeMaxB, bRangeMaxB)
      pairs.push(
        axis === "h"
          ? { x1: r1, y1: centerPerp, x2: r2, y2: centerPerp, thicknessPt: bestGap }
          : { x1: centerPerp, y1: r1, x2: centerPerp, y2: r2, thicknessPt: bestGap }
      )
    }
  }

  tryPairAxis(horizontals, "h")
  tryPairAxis(verticals, "v")

  const unpaired: Line[] = []
  for (let i = 0; i < segs.length; i++) {
    if (!used[i]) unpaired.push(walls[i])
  }
  return { pairs, unpaired }
}

// ============================================================================
// Step 3a — exterior / interior wall classification
// ============================================================================

/**
 * For a wall (in PDF point space), return the minimum perpendicular distance from the wall's
 * midpoint to any edge of the polygon. Used to classify walls as exterior vs interior.
 */
function midpointDistanceToPolygon(line: Line, polygonPdf: FloorplanPoint2D[]): number {
  const m = midpoint(line)
  let best = Infinity
  for (let i = 0; i < polygonPdf.length; i++) {
    const a = polygonPdf[i]
    const b = polygonPdf[(i + 1) % polygonPdf.length]
    const edge: Line = { x1: a.x, y1: a.y, x2: b.x, y2: b.y }
    const d = pointToSegmentDistance(m.x, m.y, edge).distance
    if (d < best) best = d
  }
  return best
}

/**
 * Returns true when the wall lies "along" a polygon edge — both endpoints close to the same
 * edge AND the wall direction parallel to it. We use this to confirm a wall is exterior vs just
 * happening to be near a corner.
 */
function wallAlignsWithAnyPolygonEdge(line: Line, polygonPdf: FloorplanPoint2D[]): boolean {
  const wallAng = angleDegrees(line)
  for (let i = 0; i < polygonPdf.length; i++) {
    const a = polygonPdf[i]
    const b = polygonPdf[(i + 1) % polygonPdf.length]
    const edge: Line = { x1: a.x, y1: a.y, x2: b.x, y2: b.y }
    if (segmentLength(edge) < 2) continue
    const edgeAng = angleDegrees(edge)
    const angDiff = Math.abs(wallAng - edgeAng)
    if (angDiff > 6 && Math.abs(angDiff - 90) < 84) continue // not parallel
    const d1 = pointToSegmentDistance(line.x1, line.y1, edge).distance
    const d2 = pointToSegmentDistance(line.x2, line.y2, edge).distance
    if (
      d1 <= WALL_EXTERIOR_DISTANCE_PT + WALL_EXTERIOR_PROJECTION_OVERLAP_PT &&
      d2 <= WALL_EXTERIOR_DISTANCE_PT + WALL_EXTERIOR_PROJECTION_OVERLAP_PT
    ) {
      return true
    }
  }
  return false
}

type WallType = "exterior" | "interior" | "fixture"

interface ClassifiedWall {
  line: Line
  type: WallType
  /** Distance (PDF pt) of the wall midpoint to the nearest polygon edge. */
  distanceToBoundaryPt: number
}

/** Exterior / interior from contour only — no fixture downgrade. */
function classifyPartitionAgainstPolygon(
  line: Line,
  polygonPdf: FloorplanPoint2D[] | null
): ClassifiedWall {
  if (!polygonPdf) {
    return { line, type: "interior" as WallType, distanceToBoundaryPt: Infinity }
  }
  const d = midpointDistanceToPolygon(line, polygonPdf)
  if (d <= WALL_EXTERIOR_DISTANCE_PT && wallAlignsWithAnyPolygonEdge(line, polygonPdf)) {
    return { line, type: "exterior" as WallType, distanceToBoundaryPt: d }
  }
  return { line, type: "interior" as WallType, distanceToBoundaryPt: d }
}

/**
 * Classify each strong wall against the recovered polygon outline:
 *  - close to polygon boundary AND parallel to nearest edge → exterior shell
 *  - otherwise → interior partition
 *
 * Fixture-tagged strokes shorter than `FIXTURE_MICRO_LEN_PT` stay decorative; kitchen/bath
 * partition strokes are promoted to polygon classification like other walls (user: gray ↦ blue/red).
 */
function classifyWallsAgainstPolygon(
  walls: Line[],
  polygonPdf: FloorplanPoint2D[] | null,
  fixtureLineSet: Set<Line>
): ClassifiedWall[] {
  return walls.map((line) => {
    if (fixtureLineSet.has(line) && segmentLength(line) < FIXTURE_MICRO_LEN_PT) {
      return { line, type: "fixture" as WallType, distanceToBoundaryPt: 0 }
    }
    return classifyPartitionAgainstPolygon(line, polygonPdf)
  })
}

// ============================================================================
// Step 3b — window detection
// ============================================================================

interface WindowOpeningPdf {
  /** Mouth start in PDF coords (along the host wall). */
  x1: number
  y1: number
  x2: number
  y2: number
  /** Width along the wall, in PDF points. */
  widthPt: number
  /** Whether the host wall was classified as exterior (higher confidence). */
  onExterior: boolean
}

// ---- Step 3b² — windows-as-shell-gaps -----------------------------------------------------
// User instruction: every gap on the unit's exterior shell IS a window. Skip glass-signature
// heuristics entirely. Walk the recovered outer-contour polygon, find every uncovered run, emit it.

/** Wall must lie within ±this perpendicular distance of a polygon edge to "cover" that edge. */
const SHELL_WALL_PERP_TOL_PT = 12
/** Skip stair-step polygon edges shorter than this — they're rasterization corner stubs, not real shell. */
const SHELL_MIN_EDGE_LEN_PT = 6
/** A run of uncovered shell shorter than this is corner-snapping noise, not a real opening. */
const SHELL_MIN_GAP_LEN_PT = 10
/** A wall has to overlap the edge along-axis by at least this much to "cover" it. */
const SHELL_WALL_COV_MIN_LEN_PT = 4
/** Two adjacent covered sub-intervals are merged if their gap is ≤ this (closes axis-snap noise). */
const SHELL_COV_MERGE_GAP_PT = 2
/** Adjacent stair-step gaps on collinear edges are stitched if perp-shift ≤ this and along-gap ≤ STITCH_ALONG_GAP_PT. */
const SHELL_STITCH_PERP_TOL_PT = 4
const SHELL_STITCH_ALONG_GAP_PT = 8
/** Half-width of the perp band used for the polygon-edge "shell support" sanity check. */
const SHELL_SUPPORT_BAND_PT = 18
/** Number of sub-buckets a gap is split into for the "line spread" check. */
const SHELL_SUPPORT_BUCKETS = 5
/** Minimum number of sub-buckets that must contain ≥1 line for the gap to be a real shell. */
const SHELL_SUPPORT_MIN_BUCKETS = 2

function detectExteriorShellWindows(
  polygonPdf: FloorplanPoint2D[],
  strongWalls: Line[],
  allLines: Line[]
): WindowOpeningPdf[] {
  if (!polygonPdf || polygonPdf.length < 4) return []

  type Cand = { horizontal: boolean; perp: number; lo: number; hi: number }
  const raw: Cand[] = []

  for (let i = 0; i < polygonPdf.length; i++) {
    const a = polygonPdf[i]
    const b = polygonPdf[(i + 1) % polygonPdf.length]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const horizontal = Math.abs(dx) >= Math.abs(dy)
    const len = horizontal ? Math.abs(dx) : Math.abs(dy)
    if (len < SHELL_MIN_EDGE_LEN_PT) continue
    const edgePerp = horizontal ? a.y : a.x
    const aMin = horizontal ? Math.min(a.x, b.x) : Math.min(a.y, b.y)
    const aMax = horizontal ? Math.max(a.x, b.x) : Math.max(a.y, b.y)

    // Walls covering this edge — same orientation, perp within tolerance, along-axis overlap ≥ min.
    const cov: Array<[number, number]> = []
    for (const w of strongWalls) {
      const wDx = w.x2 - w.x1
      const wDy = w.y2 - w.y1
      const wHoriz = Math.abs(wDx) > Math.abs(wDy)
      if (wHoriz !== horizontal) continue
      const wPerp = horizontal ? (w.y1 + w.y2) / 2 : (w.x1 + w.x2) / 2
      if (Math.abs(wPerp - edgePerp) > SHELL_WALL_PERP_TOL_PT) continue
      const wAlong1 = horizontal ? w.x1 : w.y1
      const wAlong2 = horizontal ? w.x2 : w.y2
      const wMin = Math.min(wAlong1, wAlong2)
      const wMax = Math.max(wAlong1, wAlong2)
      const lo = Math.max(wMin, aMin)
      const hi = Math.min(wMax, aMax)
      if (hi - lo >= SHELL_WALL_COV_MIN_LEN_PT) cov.push([lo, hi])
    }
    cov.sort((p, q) => p[0] - q[0])
    const cm: Array<[number, number]> = []
    for (const c of cov) {
      const last = cm[cm.length - 1]
      if (last && c[0] <= last[1] + SHELL_COV_MERGE_GAP_PT)
        last[1] = Math.max(last[1], c[1])
      else cm.push([c[0], c[1]])
    }
    let cursor = aMin
    for (const [lo, hi] of cm) {
      if (lo - cursor >= SHELL_MIN_GAP_LEN_PT)
        raw.push({ horizontal, perp: edgePerp, lo: cursor, hi: lo })
      cursor = Math.max(cursor, hi)
    }
    if (aMax - cursor >= SHELL_MIN_GAP_LEN_PT)
      raw.push({ horizontal, perp: edgePerp, lo: cursor, hi: aMax })
  }

  // Stitch adjacent collinear gaps (rasterized polygon edges may zig-zag at 3pt cell boundaries).
  raw.sort((p, q) => {
    if (p.horizontal !== q.horizontal) return p.horizontal ? -1 : 1
    if (Math.abs(p.perp - q.perp) > SHELL_STITCH_PERP_TOL_PT) return p.perp - q.perp
    return p.lo - q.lo
  })
  const stitched: Cand[] = []
  for (const c of raw) {
    const last = stitched[stitched.length - 1]
    if (
      last &&
      last.horizontal === c.horizontal &&
      Math.abs(last.perp - c.perp) <= SHELL_STITCH_PERP_TOL_PT &&
      c.lo <= last.hi + SHELL_STITCH_ALONG_GAP_PT
    ) {
      last.hi = Math.max(last.hi, c.hi)
      last.perp = (last.perp + c.perp) / 2
    } else {
      stitched.push({ ...c })
    }
  }

  // Shell-support sanity check — drop overshoot gaps. After contour rasterization+dilation, the
  // polygon may extend 10-30 pt into empty space when the flood-fill leaks through an opening
  // (no exterior wall to block it). Real shell openings — both hard-wall windows and full-wall
  // glass — show line activity SPREAD along the gap: jambs at both ends, mullion ticks at
  // intervals, frame faces, etc. Overshoot, by contrast, has at most one isolated cluster of
  // adjacent fixture trim. Bucket-based spread check distinguishes the two.
  const out: WindowOpeningPdf[] = []
  for (const c of stitched) {
    const w = c.hi - c.lo
    if (w < SHELL_MIN_GAP_LEN_PT) continue
    const buckets = new Uint8Array(SHELL_SUPPORT_BUCKETS)
    const bw = w / SHELL_SUPPORT_BUCKETS
    for (const ln of allLines) {
      const lcx = (ln.x1 + ln.x2) / 2
      const lcy = (ln.y1 + ln.y2) / 2
      const along = c.horizontal ? lcx : lcy
      if (along < c.lo || along > c.hi) continue
      const perp = c.horizontal ? lcy : lcx
      if (Math.abs(perp - c.perp) > SHELL_SUPPORT_BAND_PT) continue
      const idx = Math.min(SHELL_SUPPORT_BUCKETS - 1, Math.floor((along - c.lo) / bw))
      buckets[idx] = 1
    }
    let filled = 0
    for (let i = 0; i < buckets.length; i++) if (buckets[i]) filled++
    if (filled < SHELL_SUPPORT_MIN_BUCKETS) continue
    out.push({
      x1: c.horizontal ? c.lo : c.perp,
      y1: c.horizontal ? c.perp : c.lo,
      x2: c.horizontal ? c.hi : c.perp,
      y2: c.horizontal ? c.perp : c.hi,
      widthPt: w,
      onExterior: true,
    })
  }
  return out
}

function isHorizontalWall(line: Line): boolean {
  return Math.abs(line.x2 - line.x1) >= Math.abs(line.y2 - line.y1)
}

/**
 * Detect window openings as runs of short parallel "glass / hatch" lines along a wall. We scan
 * BOTH exterior and interior strong walls (with the latter only kept if their host-wall
 * candidate cluster is dense enough), so windows aren't missed when the polygon misclassifies
 * a wall. Output is deduplicated by overlapping mouth.
 *
 * Algorithm per wall:
 *   1. Collect short axis-parallel lines whose perpendicular distance to the wall is ≤ band.
 *   2. Sort by along-wall coord, group by gap ≤ WINDOW_GROUP_GAP_PT.
 *   3. A group with ≥ WINDOW_MIN_PARALLEL_LINES lines and span in [MIN, MAX] = window.
 */
function detectWindows(
  hostWalls: Line[],
  hostExteriorFlags: boolean[],
  allCroppedLines: Line[]
): WindowOpeningPdf[] {
  const raw: WindowOpeningPdf[] = []
  for (let wi = 0; wi < hostWalls.length; wi++) {
    const wall = hostWalls[wi]
    if (segmentLength(wall) < WINDOW_MIN_WIDTH_PT) continue
    const horizontal = isHorizontalWall(wall)
    const wallPerp = horizontal ? (wall.y1 + wall.y2) / 2 : (wall.x1 + wall.x2) / 2
    const wallAxisMin = horizontal ? Math.min(wall.x1, wall.x2) : Math.min(wall.y1, wall.y2)
    const wallAxisMax = horizontal ? Math.max(wall.x1, wall.x2) : Math.max(wall.y1, wall.y2)

    const candidates: Array<{ along: number; line: Line }> = []
    for (const cand of allCroppedLines) {
      if (cand === wall) continue
      const len = segmentLength(cand)
      if (len <= 0.5 || len > WINDOW_GLASS_MAX_LEN_PT) continue
      if (horizontal) {
        if (Math.abs(cand.y1 - cand.y2) > 0.6) continue
        const candPerp = (cand.y1 + cand.y2) / 2
        if (Math.abs(candPerp - wallPerp) > WINDOW_BAND_PT) continue
        const candMid = (cand.x1 + cand.x2) / 2
        if (candMid < wallAxisMin - 4 || candMid > wallAxisMax + 4) continue
        candidates.push({ along: candMid, line: cand })
      } else {
        if (Math.abs(cand.x1 - cand.x2) > 0.6) continue
        const candPerp = (cand.x1 + cand.x2) / 2
        if (Math.abs(candPerp - wallPerp) > WINDOW_BAND_PT) continue
        const candMid = (cand.y1 + cand.y2) / 2
        if (candMid < wallAxisMin - 4 || candMid > wallAxisMax + 4) continue
        candidates.push({ along: candMid, line: cand })
      }
    }
    if (candidates.length < WINDOW_MIN_PARALLEL_LINES) continue
    candidates.sort((a, b) => a.along - b.along)

    let groupStart = 0
    for (let i = 1; i <= candidates.length; i++) {
      const isLast = i === candidates.length
      const gap = isLast ? Infinity : candidates[i].along - candidates[i - 1].along
      if (gap > WINDOW_GROUP_GAP_PT || isLast) {
        const groupSize = i - groupStart
        if (groupSize >= WINDOW_MIN_PARALLEL_LINES) {
          const a0 = candidates[groupStart].along
          const a1 = candidates[i - 1].along
          const span = a1 - a0
          if (span >= WINDOW_MIN_WIDTH_PT && span <= WINDOW_MAX_WIDTH_PT) {
            // Pad the window mouth slightly so the painted band sits on the wall (each glass line
            // is itself ~0.5–1 pt thick so the cluster's first/last "along" coord underestimates
            // the actual mouth by ~3 pt at each end).
            const pad = 3
            const along0 = Math.max(wallAxisMin, a0 - pad)
            const along1 = Math.min(wallAxisMax, a1 + pad)
            raw.push(
              horizontal
                ? {
                    x1: along0,
                    y1: wallPerp,
                    x2: along1,
                    y2: wallPerp,
                    widthPt: along1 - along0,
                    onExterior: hostExteriorFlags[wi],
                  }
                : {
                    x1: wallPerp,
                    y1: along0,
                    x2: wallPerp,
                    y2: along1,
                    widthPt: along1 - along0,
                    onExterior: hostExteriorFlags[wi],
                  }
            )
          }
        }
        groupStart = i
      }
    }
  }
  // Dedupe: when the same window cluster shows up on a paired exterior + interior face of a
  // double-line wall, keep the exterior face's hit (or the wider one if neither is exterior).
  raw.sort((a, b) => Math.min(a.x1, a.x2) - Math.min(b.x1, b.x2))
  const kept: WindowOpeningPdf[] = []
  for (const w of raw) {
    const horizontal = Math.abs(w.x2 - w.x1) >= Math.abs(w.y2 - w.y1)
    const dup = kept.find((k) => {
      const kHoriz = Math.abs(k.x2 - k.x1) >= Math.abs(k.y2 - k.y1)
      if (kHoriz !== horizontal) return false
      const aMin = horizontal ? Math.min(w.x1, w.x2) : Math.min(w.y1, w.y2)
      const aMax = horizontal ? Math.max(w.x1, w.x2) : Math.max(w.y1, w.y2)
      const bMin = horizontal ? Math.min(k.x1, k.x2) : Math.min(k.y1, k.y2)
      const bMax = horizontal ? Math.max(k.x1, k.x2) : Math.max(k.y1, k.y2)
      const overlap = Math.max(0, Math.min(aMax, bMax) - Math.max(aMin, bMin))
      const minLen = Math.min(aMax - aMin, bMax - bMin)
      if (overlap < 0.5 * minLen) return false
      // Same axis & overlap → same window if the perpendicular coord is within wall-pair gap.
      const aPerp = horizontal ? (w.y1 + w.y2) / 2 : (w.x1 + w.x2) / 2
      const bPerp = horizontal ? (k.y1 + k.y2) / 2 : (k.x1 + k.x2) / 2
      return Math.abs(aPerp - bPerp) <= WALL_PAIR_MAX_GAP_PT
    })
    if (!dup) {
      kept.push(w)
    } else if (!dup.onExterior && w.onExterior) {
      Object.assign(dup, w)
    } else if (w.widthPt > dup.widthPt) {
      Object.assign(dup, w)
    }
  }
  return kept
}

// ============================================================================
// Step 3b¹ — thin double-line glass detection
// (catches every regular window drawn as paired ~0.7-pt-spaced face lines)
// ============================================================================

interface GlassStripPdf {
  x1: number
  y1: number
  x2: number
  y2: number
  widthPt: number
  /** True when the strip's perpendicular coord is close to the apartmentBox edge. */
  onExterior: boolean
}

/**
 * Find every thin double-line pair that looks like glass. A pair = two parallel axis-aligned
 * segments with perpendicular gap in `[GLASS_PAIR_MIN_GAP_PT, GLASS_PAIR_MAX_GAP_PT]` and ≥50%
 * along-axis overlap. We then collect ALL segments belonging to such pairs (a glass face often
 * has 2 or 3 parallel lines, not just 2), bucket them by perpendicular band, and merge runs
 * along the axis whose gap is ≤ `GLASS_ALONG_GAP_MAX_PT`. Each merged run with span ≥
 * `GLASS_MIN_STRIP_LEN_PT` becomes a glass strip.
 *
 * To suppress the rare interior false positive (cabinet trim hatching that happens to be a thin
 * pair), strips whose perpendicular coord is more than `GLASS_EXTERIOR_PROXIMITY_PT` from the
 * nearest apartmentBox edge are tagged `onExterior=false` and filtered later.
 */
function detectThinGlassStrips(
  croppedLines: Line[],
  apartmentBox: BBox
): GlassStripPdf[] {
  const result: GlassStripPdf[] = []

  const run = (horizontal: boolean) => {
    const axials = croppedLines.filter((l) => {
      const dx = Math.abs(l.x2 - l.x1)
      const dy = Math.abs(l.y2 - l.y1)
      if (horizontal) {
        if (dy > 0.4) return false
        if (dx < GLASS_SEG_MIN_LEN_PT) return false
      } else {
        if (dx > 0.4) return false
        if (dy < GLASS_SEG_MIN_LEN_PT) return false
      }
      return true
    })
    const perp = (l: Line) =>
      horizontal ? (l.y1 + l.y2) / 2 : (l.x1 + l.x2) / 2
    const aMin = (l: Line) =>
      horizontal ? Math.min(l.x1, l.x2) : Math.min(l.y1, l.y2)
    const aMax = (l: Line) =>
      horizontal ? Math.max(l.x1, l.x2) : Math.max(l.y1, l.y2)

    // Sort by perp so we can sweep window thin-pair candidates.
    axials.sort((a, b) => perp(a) - perp(b))

    // Mark every segment that has at least one parallel partner within (MIN, MAX) perp gap and
    // ≥50% along overlap. The mark = "this segment is part of a glass face".
    const isGlassEvidence = new Uint8Array(axials.length)
    for (let i = 0; i < axials.length; i++) {
      const a = axials[i]
      const aP = perp(a)
      const aLo = aMin(a)
      const aHi = aMax(a)
      const aLen = aHi - aLo
      for (let j = i + 1; j < axials.length; j++) {
        const b = axials[j]
        const gap = perp(b) - aP
        if (gap > GLASS_PAIR_MAX_GAP_PT) break
        if (gap < GLASS_PAIR_MIN_GAP_PT) continue
        const bLo = aMin(b)
        const bHi = aMax(b)
        const ovl = Math.min(aHi, bHi) - Math.max(aLo, bLo)
        const minLen = Math.min(aLen, bHi - bLo)
        if (ovl < 0.5 * minLen) continue
        isGlassEvidence[i] = 1
        isGlassEvidence[j] = 1
      }
    }

    // Bucket evidence segs by perp band (within GLASS_BAND_PT) and merge runs along the axis.
    const evidence: Line[] = []
    for (let i = 0; i < axials.length; i++) if (isGlassEvidence[i]) evidence.push(axials[i])
    if (!evidence.length) return
    evidence.sort((a, b) => perp(a) - perp(b))
    const bands: Line[][] = []
    let currentBand: Line[] = []
    let currentBandPerp = -Infinity
    for (const e of evidence) {
      const p = perp(e)
      if (currentBand.length === 0 || p - currentBandPerp <= GLASS_BAND_PT) {
        currentBand.push(e)
        currentBandPerp = p
      } else {
        bands.push(currentBand)
        currentBand = [e]
        currentBandPerp = p
      }
    }
    if (currentBand.length) bands.push(currentBand)

    for (const band of bands) {
      band.sort((a, b) => aMin(a) - aMin(b))
      const perpAvg = band.reduce((s, l) => s + perp(l), 0) / band.length
      let runLo = aMin(band[0])
      let runHi = aMax(band[0])
      const finalize = () => {
        const span = runHi - runLo
        if (span < GLASS_MIN_STRIP_LEN_PT) return
        const distToEdge = horizontal
          ? Math.min(
              Math.abs(perpAvg - apartmentBox.minY),
              Math.abs(perpAvg - apartmentBox.maxY)
            )
          : Math.min(
              Math.abs(perpAvg - apartmentBox.minX),
              Math.abs(perpAvg - apartmentBox.maxX)
            )
        const onExterior = distToEdge <= GLASS_EXTERIOR_PROXIMITY_PT
        if (horizontal) {
          result.push({
            x1: runLo,
            y1: perpAvg,
            x2: runHi,
            y2: perpAvg,
            widthPt: span,
            onExterior,
          })
        } else {
          result.push({
            x1: perpAvg,
            y1: runLo,
            x2: perpAvg,
            y2: runHi,
            widthPt: span,
            onExterior,
          })
        }
      }
      for (let i = 1; i < band.length; i++) {
        const lo = aMin(band[i])
        const hi = aMax(band[i])
        if (lo - runHi <= GLASS_ALONG_GAP_MAX_PT) {
          runHi = Math.max(runHi, hi)
        } else {
          finalize()
          runLo = lo
          runHi = hi
        }
      }
      finalize()
    }
  }

  run(true)
  run(false)
  return result
}

/** Convert a glass strip into the WindowOpeningPdf shape used by detectWindows output. */
function glassStripToWindow(g: GlassStripPdf): WindowOpeningPdf {
    return {
    x1: g.x1,
    y1: g.y1,
    x2: g.x2,
    y2: g.y2,
    widthPt: g.widthPt,
    onExterior: g.onExterior,
  }
}

// ============================================================================
// Step 3b² — mullion-ribbon detection (catches full-wall / floor-to-ceiling windows
// that have no host strong wall, only periodic short tick marks)
// ============================================================================

interface MullionRibbonPdf {
  /** Centerline of the cluster (axial). */
  x1: number
  y1: number
  x2: number
  y2: number
  /** Span along the axis (= width of the window in PDF pt). */
  widthPt: number
  /** Number of short ticks that voted for this ribbon. */
  tickCount: number
  /** True when the ribbon's perpendicular coord is close to the apartmentBox edge. */
  onExterior: boolean
}

/**
 * Find mullion ribbons by clustering short axial ticks. Each cluster becomes:
 *   - a phantom wall line (used by Step 1 contour rasterisation so the polygon hugs the real
 *     apartment shell — without this, full-wall windows leave the polygon stopping short of
 *     the actual outer edge);
 *   - optionally a window opening when it sits within `MULLION_EXTERIOR_PROXIMITY_PT` of the
 *     apartmentBox edge.
 */
function detectAxialMullionRibbons(
  croppedLines: Line[],
  apartmentBox: BBox
): MullionRibbonPdf[] {
  const horizTicks = croppedLines.filter((l) => {
    const dx = Math.abs(l.x2 - l.x1)
    const dy = Math.abs(l.y2 - l.y1)
    if (dy > 0.5) return false
    return dx >= MULLION_TICK_MIN_LEN_PT && dx <= MULLION_TICK_MAX_LEN_PT
  })
  const vertTicks = croppedLines.filter((l) => {
    const dx = Math.abs(l.x2 - l.x1)
    const dy = Math.abs(l.y2 - l.y1)
    if (dx > 0.5) return false
    return dy >= MULLION_TICK_MIN_LEN_PT && dy <= MULLION_TICK_MAX_LEN_PT
  })

  const ribbons: MullionRibbonPdf[] = []

  const cluster = (ticks: Line[], horizontal: boolean) => {
    if (ticks.length < MULLION_MIN_TICKS) return
    const perp = (l: Line) =>
      horizontal ? (l.y1 + l.y2) / 2 : (l.x1 + l.x2) / 2
    const along = (l: Line) =>
      horizontal ? (l.x1 + l.x2) / 2 : (l.y1 + l.y2) / 2
    const aMin = (l: Line) =>
      horizontal ? Math.min(l.x1, l.x2) : Math.min(l.y1, l.y2)
    const aMax = (l: Line) =>
      horizontal ? Math.max(l.x1, l.x2) : Math.max(l.y1, l.y2)

    const sorted = [...ticks].sort((a, b) => perp(a) - perp(b))
    const bands: Line[][] = []
    let band: Line[] = []
    let bandRefPerp = -Infinity
    for (const t of sorted) {
      const p = perp(t)
      if (band.length === 0 || p - bandRefPerp <= MULLION_BAND_PT) {
        band.push(t)
        bandRefPerp = p
      } else {
        bands.push(band)
        band = [t]
        bandRefPerp = p
      }
    }
    if (band.length) bands.push(band)

    for (const b of bands) {
      if (b.length < MULLION_MIN_TICKS) continue
      const sb = [...b].sort((a, b2) => along(a) - along(b2))
      let g0 = 0
      for (let i = 1; i <= sb.length; i++) {
        const last = i === sb.length
        const gap = last ? Infinity : along(sb[i]) - along(sb[i - 1])
        if (gap > MULLION_TICK_MAX_GAP_PT || last) {
          const grp = sb.slice(g0, i)
          if (grp.length >= MULLION_MIN_TICKS) {
            const aMn = Math.min(...grp.map(aMin))
            const aMx = Math.max(...grp.map(aMax))
            const span = aMx - aMn
            if (span >= MULLION_MIN_SPAN_PT) {
              const pAvg =
                grp.reduce((s, l) => s + perp(l), 0) / grp.length
              const distToEdge = horizontal
                ? Math.min(
                    Math.abs(pAvg - apartmentBox.minY),
                    Math.abs(pAvg - apartmentBox.maxY)
                  )
                : Math.min(
                    Math.abs(pAvg - apartmentBox.minX),
                    Math.abs(pAvg - apartmentBox.maxX)
                  )
              const onExterior = distToEdge <= MULLION_EXTERIOR_PROXIMITY_PT
              if (horizontal) {
                ribbons.push({
                  x1: aMn,
                  y1: pAvg,
                  x2: aMx,
                  y2: pAvg,
                  widthPt: span,
                  tickCount: grp.length,
                  onExterior,
                })
              } else {
                ribbons.push({
                  x1: pAvg,
                  y1: aMn,
                  x2: pAvg,
                  y2: aMx,
                  widthPt: span,
                  tickCount: grp.length,
                  onExterior,
                })
              }
            }
          }
          g0 = i
        }
      }
    }
  }

  cluster(horizTicks, true)
  cluster(vertTicks, false)

  return ribbons
}

/** Convert a mullion ribbon into the WindowOpeningPdf shape used by detectWindows output. */
function ribbonToWindow(r: MullionRibbonPdf): WindowOpeningPdf {
  return {
    x1: r.x1,
    y1: r.y1,
    x2: r.x2,
    y2: r.y2,
    widthPt: r.widthPt,
    onExterior: r.onExterior,
  }
}

/** Convert a mullion ribbon into a phantom wall line for contour rasterisation. */
function ribbonToPhantomWall(r: MullionRibbonPdf): Line {
  return { x1: r.x1, y1: r.y1, x2: r.x2, y2: r.y2 }
}

// ============================================================================
// Step 3c — door detection
// ============================================================================

interface DoorOpeningPdf {
  x1: number
  y1: number
  x2: number
  y2: number
  widthPt: number
  /** "swing" if perpendicular curve-chord segments were found; "opening" otherwise. */
  kind: "swing" | "opening"
}

/**
 * Door detection by **wall-break + jamb-pattern** matching:
 *  1. For every pair of co-linear strong walls (same axis class, same perpendicular coord ±2 pt),
 *     compute the gap between their nearest endpoints.
 *  2. If the gap is in [DOOR_MIN_WIDTH_PT, DOOR_MAX_WIDTH_PT] AND doesn't fall on top of a
 *     previously-detected window, it's a door candidate.
 *  3. Require ≥ DOOR_MIN_TOTAL_JAMB_HITS short perpendicular lines (jamb stubs) or short
 *     diagonal lines (swing-arc chord) within DOOR_JAMB_RADIUS_PT of each gap edge.
 *  4. Output the gap as the door mouth, marking `swing` when arc geometry is present.
 *
 * Works for swing doors, sliders, openings, double doors. Doesn't require curve preservation.
 */
function detectDoors(
  strongWalls: Line[],
  allCroppedLines: Line[],
  windowsPdf: WindowOpeningPdf[]
): DoorOpeningPdf[] {
  // Bucket walls into perpendicular-coord rows so we can find co-linear pairs cheaply.
  const horizontals: Array<{ idx: number; perp: number; aMin: number; aMax: number; line: Line }> = []
  const verticals: typeof horizontals = []
  for (let i = 0; i < strongWalls.length; i++) {
    const w = strongWalls[i]
    const ang = angleDegrees(w)
    if (ang <= WALL_PAIR_PARALLEL_TOL_DEG * 2) {
      horizontals.push({
        idx: i,
        perp: (w.y1 + w.y2) / 2,
        aMin: Math.min(w.x1, w.x2),
        aMax: Math.max(w.x1, w.x2),
        line: w,
      })
    } else if (90 - ang <= WALL_PAIR_PARALLEL_TOL_DEG * 2) {
      verticals.push({
        idx: i,
        perp: (w.x1 + w.x2) / 2,
        aMin: Math.min(w.y1, w.y2),
        aMax: Math.max(w.y1, w.y2),
        line: w,
      })
    }
  }

  const doors: DoorOpeningPdf[] = []
  // Build window-exclusion ranges per axis so we don't call window mouths "doors".
  const windowsHorizontal = windowsPdf
    .filter((w) => Math.abs(w.x2 - w.x1) >= Math.abs(w.y2 - w.y1))
    .map((w) => ({
      perp: (w.y1 + w.y2) / 2,
      aMin: Math.min(w.x1, w.x2) - DOOR_WINDOW_EXCLUDE_PAD_PT,
      aMax: Math.max(w.x1, w.x2) + DOOR_WINDOW_EXCLUDE_PAD_PT,
    }))
  const windowsVertical = windowsPdf
    .filter((w) => Math.abs(w.x2 - w.x1) < Math.abs(w.y2 - w.y1))
    .map((w) => ({
      perp: (w.x1 + w.x2) / 2,
      aMin: Math.min(w.y1, w.y2) - DOOR_WINDOW_EXCLUDE_PAD_PT,
      aMax: Math.max(w.y1, w.y2) + DOOR_WINDOW_EXCLUDE_PAD_PT,
    }))
  const overlapsWindow = (
    horizontal: boolean,
    perp: number,
    gapStart: number,
    gapEnd: number
  ): boolean => {
    const list = horizontal ? windowsHorizontal : windowsVertical
    for (const w of list) {
      if (Math.abs(w.perp - perp) > WALL_PAIR_MAX_GAP_PT) continue
      // Any overlap of the gap range with the window range = exclude.
      if (w.aMin <= gapEnd && w.aMax >= gapStart) return true
    }
    return false
  }

  const search = (
    group: Array<{ idx: number; perp: number; aMin: number; aMax: number; line: Line }>,
    horizontal: boolean
  ) => {
    // Sort by perpendicular coord then by along-coord.
    const sorted = [...group].sort((a, b) => a.perp - b.perp || a.aMin - b.aMin)
    for (let i = 0; i < sorted.length; i++) {
      const a = sorted[i]
      for (let j = i + 1; j < sorted.length; j++) {
        const b = sorted[j]
        if (Math.abs(a.perp - b.perp) > DOOR_JAMB_ALIGN_PT) break
        // Same-axis, near-coplanar → check gap between segment endpoints.
        const gap = b.aMin - a.aMax
        if (gap < DOOR_MIN_WIDTH_PT || gap > DOOR_MAX_WIDTH_PT) continue
        const gapPerp = (a.perp + b.perp) / 2
        const gapStart = a.aMax
        const gapEnd = b.aMin
        // Skip if the gap overlaps a known window mouth.
        if (overlapsWindow(horizontal, gapPerp, gapStart, gapEnd)) continue
        // Look for perpendicular short lines (jamb stubs / arc chord) near each gap edge.
        let leftJambHits = 0
        let rightJambHits = 0
        let arcHits = 0
        for (const cand of allCroppedLines) {
          if (cand === a.line || cand === b.line) continue
          const len = segmentLength(cand)
          if (len < DOOR_JAMB_MIN_LEN_PT || len > DOOR_JAMB_MAX_LEN_PT) continue
          const candAng = angleDegrees(cand)
          const isPerp =
            (horizontal && 90 - candAng <= 12) || (!horizontal && candAng <= 12)
          const cm = midpoint(cand)
          const candAlong = horizontal ? cm.x : cm.y
          const candPerp = horizontal ? cm.y : cm.x
          const perpDist = Math.abs(candPerp - gapPerp)
          if (perpDist > DOOR_JAMB_RADIUS_PT + len) continue
          const distFromLeft = Math.abs(candAlong - gapStart)
          const distFromRight = Math.abs(candAlong - gapEnd)
          if (isPerp) {
            if (distFromLeft <= DOOR_JAMB_RADIUS_PT) leftJambHits++
            if (distFromRight <= DOOR_JAMB_RADIUS_PT) rightJambHits++
          } else if (candAng > 8 && 90 - candAng > 8) {
            // Diagonal short line in the gap zone → likely swing-arc chord.
            if (candAlong >= gapStart - DOOR_JAMB_RADIUS_PT && candAlong <= gapEnd + DOOR_JAMB_RADIUS_PT) {
              arcHits++
            }
          }
        }
        const totalJambHits = leftJambHits + rightJambHits + arcHits
        if (totalJambHits < DOOR_MIN_TOTAL_JAMB_HITS) continue
        const kind: DoorOpeningPdf["kind"] = arcHits >= 1 ? "swing" : "opening"
        if (horizontal) {
          doors.push({
            x1: gapStart,
            y1: gapPerp,
            x2: gapEnd,
            y2: gapPerp,
            widthPt: gap,
            kind,
          })
        } else {
          doors.push({
            x1: gapPerp,
            y1: gapStart,
            x2: gapPerp,
            y2: gapEnd,
            widthPt: gap,
            kind,
          })
        }
      }
    }
  }
  search(horizontals, true)
  search(verticals, false)

  // Dedupe overlapping mouths from double-line walls (each face produces a candidate).
  doors.sort((a, b) => Math.min(a.x1, a.x2) - Math.min(b.x1, b.x2))
  const kept: DoorOpeningPdf[] = []
  for (const d of doors) {
    const horiz = Math.abs(d.x2 - d.x1) >= Math.abs(d.y2 - d.y1)
    const dup = kept.find((k) => {
      const kHoriz = Math.abs(k.x2 - k.x1) >= Math.abs(k.y2 - k.y1)
      if (kHoriz !== horiz) return false
      const aMin = horiz ? Math.min(d.x1, d.x2) : Math.min(d.y1, d.y2)
      const aMax = horiz ? Math.max(d.x1, d.x2) : Math.max(d.y1, d.y2)
      const bMin = horiz ? Math.min(k.x1, k.x2) : Math.min(k.y1, k.y2)
      const bMax = horiz ? Math.max(k.x1, k.x2) : Math.max(k.y1, k.y2)
      const overlap = Math.max(0, Math.min(aMax, bMax) - Math.max(aMin, bMin))
      if (overlap < 0.6 * Math.min(aMax - aMin, bMax - bMin)) return false
      const aPerp = horiz ? (d.y1 + d.y2) / 2 : (d.x1 + d.x2) / 2
      const bPerp = horiz ? (k.y1 + k.y2) / 2 : (k.x1 + k.x2) / 2
      return Math.abs(aPerp - bPerp) <= WALL_PAIR_MAX_GAP_PT
    })
    if (!dup) kept.push(d)
    else if (d.kind === "swing" && dup.kind !== "swing") Object.assign(dup, d)
  }
  return kept
}

// ============================================================================
// Public entry point
// ============================================================================

/**
 * Page primitives shape consumed by `analyzePdfVectorPrimitivesPage`. Matches the runtime
 * output of `extractPdfVectorPrimitives` page entries (see `lib/geometryFirst/types.ts`).
 * Exported so test harnesses / debug scripts can call the inner pipeline with cached primitives.
 */
export interface PdfVectorPagePrimitives {
  pageBounds: BBox
  lines: Line[]
  texts: TextRun[]
}

/**
 * Inner pipeline that runs against an already-extracted page. Useful for unit-testing the
 * algorithm against cached `*-primitives.json` without re-running `pdf.js` extraction.
 */
export function analyzePdfVectorPrimitivesPage(
  page: PdfVectorPagePrimitives,
  opts: { targetWidth: number; targetDepth: number }
): PdfVectorStructuralAnalysisResult | null {
  const apartmentBox = deriveApartmentArea({
    pageBounds: page.pageBounds,
    lines: page.lines,
    texts: page.texts,
  })

  const croppedLines = page.lines.filter((line) => lineTouchesBox(line, apartmentBox))
  const strongWalls = croppedLines.filter(
    (line) => segmentLength(line) >= WALL_MIN_LEN && isNearAxis(line)
  )
  const fixtureTexts = page.texts.filter(
    (text) => FIXTURE_TEXT_RE.test(text.text) && pointInBox(text.x, text.y, apartmentBox)
  )
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

  if (!structuralLines.length) return null

  // ---- Step 1: outer contour polygon in PDF space ----
  // Use only the strong (≥ WALL_MIN_LEN, axis-aligned) walls so fixture / cabinet boxes don't
  // fragment the interior into many pockets. Strong walls are what define rooms and exterior shell.
  const apartmentAnchors = filterApartmentAnchors(
    page.texts.filter((t) => pointInBox(t.x, t.y, apartmentBox))
  )
  const roomAnchors = apartmentAnchors.map((t) => {
    const w = t.width ?? Math.max(6, t.text.length * 4.5)
    const h = t.height ?? 8
    return { x: t.x + w / 2, y: t.y - h / 2 }
  })
  // ---- Step 3b²: mullion-ribbon detection — find full-wall / floor-to-ceiling windows
  //      drawn as periodic short ticks (no continuous outer wall line). Used both as phantom
  //      walls for the contour rasterisation and as windows in the final geometry output.
  const mullionRibbons = detectAxialMullionRibbons(croppedLines, apartmentBox)
  const mullionPhantomWalls = mullionRibbons.map(ribbonToPhantomWall)
  const contour = buildOuterContourPolygonPdf(
    [...strongWalls, ...mullionPhantomWalls],
    apartmentBox,
    roomAnchors
  )

  // ---- Step 2: double-line wall pairing in PDF space ----
  const pairing = pairDoubleLineWalls(strongWalls)

  // ---- Decide target metric box (preserve apartmentBox aspect ratio) ----
  const apartmentW = boxWidth(apartmentBox)
  const apartmentH = boxHeight(apartmentBox)
  const apartmentAspect = apartmentW / Math.max(apartmentH, 1e-6)
  const aiLong = Math.max(opts.targetWidth, opts.targetDepth, 1)
  let targetW: number
  let targetH: number
  if (apartmentAspect >= 1) {
    targetW = aiLong
    targetH = aiLong / apartmentAspect
  } else {
    targetH = aiLong
    targetW = aiLong * apartmentAspect
  }
  const targetBox: BBox = {
    minX: -targetW / 2,
    minY: -targetH / 2,
    maxX: targetW / 2,
    maxY: targetH / 2,
  }
  const ptToM = targetW / Math.max(apartmentW, 1e-6) // uniform — apartmentAspect preserved

  // ---- Map outer contour to metric (and keep PDF-space copy for classification) ----
  let footprintPolygon: FloorplanPoint2D[]
  let outerContourFromVector = false
  let outerContourVertexCount = 4
  let polygonPdfForClassification: FloorplanPoint2D[] | null = null
  if (contour && contour.polygon.length >= 4) {
    polygonPdfForClassification = contour.polygon
    footprintPolygon = contour.polygon.map((p) => mapPoint(p, apartmentBox, targetBox))
    outerContourFromVector = true
    outerContourVertexCount = footprintPolygon.length
    // Ensure CCW orientation in plan space.
    let signedArea = 0
    for (let i = 0; i < footprintPolygon.length; i++) {
      const a = footprintPolygon[i]
      const b = footprintPolygon[(i + 1) % footprintPolygon.length]
      signedArea += a.x * b.y - b.x * a.y
    }
    if (signedArea < 0) footprintPolygon.reverse()
  } else {
    footprintPolygon = rectangleFootprintFromAABB(targetW, targetH)
  }

  // ---- Step 3a: classify every original wall line (no centerlining; geometry stays exact) ----
  // We keep all 3 raw classes the upstream filtering produced — strong walls, fixture-support
  // lines, weak connectors — and tag each with its semantic role. Coordinates flow through
  // mapPoint untouched (uniform scaling), preserving the PDF-line accuracy the user trusts.
  const fixtureSet = new Set<Line>(fixtureSupportLines)
  // Treat weak connectors as fixture-class (they're cabinet/vanity edges); not exterior nor partition.
  for (const w of weakConnectors) fixtureSet.add(w)
  const classifiedStrong = classifyWallsAgainstPolygon(
    strongWalls,
    polygonPdfForClassification,
    fixtureSet
  )
  const strongRef = new Set(strongWalls)
  const supplementaryRaw = dedupeLines([
    ...fixtureSupportLines.filter((l) => !strongRef.has(l)),
    ...weakConnectors.filter((l) => !strongRef.has(l)),
  ])
  const classifiedSupplementary: ClassifiedWall[] = supplementaryRaw.map((l) =>
    classifyPartitionAgainstPolygon(l, polygonPdfForClassification)
  )

  const allClassified: ClassifiedWall[] = [...classifiedStrong, ...classifiedSupplementary]
  const exteriorPdf = allClassified.filter((c) => c.type === "exterior").map((c) => c.line)
  const interiorPdfStrong = allClassified.filter((c) => c.type === "interior").map((c) => c.line)

  const interiorWalls: FloorplanWallSegment[] = []
  for (let i = 0; i < allClassified.length; i++) {
    const c = allClassified[i]
    const p1 = mapPoint({ x: c.line.x1, y: c.line.y1 }, apartmentBox, targetBox)
    const p2 = mapPoint({ x: c.line.x2, y: c.line.y2 }, apartmentBox, targetBox)
    interiorWalls.push({
      id: `wall-${c.type}-${i}`,
      x1: p1.x,
      y1: p1.y,
      x2: p2.x,
      y2: p2.y,
      // Default thickness (overridden when we have a paired width).
      thickness: 0.12,
      wallType: c.type,
    })
  }

  // ---- Pair-wise wall thickness lookup: write the measured paired thickness onto the
  //      matching strong walls so renderers can extrude with realistic wall depth. ----
  for (const pair of pairing.pairs) {
    const thicknessM = Math.max(0.04, pair.thicknessPt * ptToM)
    // Find the two strong-wall outputs whose midpoints sit on this pair's centerline (within tolerance).
    const cx = (pair.x1 + pair.x2) / 2
    const cy = (pair.y1 + pair.y2) / 2
    const horizontal = Math.abs(pair.x2 - pair.x1) > Math.abs(pair.y2 - pair.y1)
    let assigned = 0
    for (let i = 0; i < classifiedStrong.length && assigned < 2; i++) {
      const c = classifiedStrong[i]
      const wm = midpoint(c.line)
      const along = horizontal
        ? wm.x >= Math.min(pair.x1, pair.x2) - 2 && wm.x <= Math.max(pair.x1, pair.x2) + 2
        : wm.y >= Math.min(pair.y1, pair.y2) - 2 && wm.y <= Math.max(pair.y1, pair.y2) + 2
      const perp = horizontal ? Math.abs(wm.y - cy) : Math.abs(wm.x - cx)
      if (along && perp <= pair.thicknessPt / 2 + 1.5) {
        const out = interiorWalls[i]
        if (out) out.thickness = thicknessM
        assigned++
      }
    }
  }

  // ---- Step 3b: windows = uncovered runs on the recovered exterior shell. -----------------
  // Per user direction: skip glass-signature heuristics entirely. Walk every polygon edge,
  // intersect with the strong-wall set, and report each uncovered sub-run as a window. This
  // captures west-wall pillar bays, primary-bedroom west wall, study-room south wall, the
  // living-room NW notch, and every north / east wall opening in one pass.
  const windowsPdf = polygonPdfForClassification
    ? detectExteriorShellWindows(polygonPdfForClassification, strongWalls, croppedLines)
    : []
  const windowOpenings: FloorplanWindowOpening[] = windowsPdf.map((w, i) => {
    const p1 = mapPoint({ x: w.x1, y: w.y1 }, apartmentBox, targetBox)
    const p2 = mapPoint({ x: w.x2, y: w.y2 }, apartmentBox, targetBox)
    return {
      id: `window-${i}`,
      x1: p1.x,
      y1: p1.y,
      x2: p2.x,
      y2: p2.y,
    }
  })

  // ---- Step 3c: door detection from wall-break + jamb pattern (excludes window ranges). ----
  // Same exterior-only proximity filter as windows: wall breaks on interior partitions in this
  // PDF set are almost always furniture / fixture cutlines mis-classified as doors. The user
  // explicitly asked us to drop them and only keep doors on the unit's outer shell.
  const doorsPdfRaw = detectDoors(strongWalls, croppedLines, windowsPdf)
  const doorsPdf = doorsPdfRaw.filter((d) => {
    const horizontal = Math.abs(d.x2 - d.x1) >= Math.abs(d.y2 - d.y1)
    const perp = horizontal ? (d.y1 + d.y2) / 2 : (d.x1 + d.x2) / 2
    const distToEdge = horizontal
      ? Math.min(
          Math.abs(perp - apartmentBox.minY),
          Math.abs(perp - apartmentBox.maxY)
        )
      : Math.min(
          Math.abs(perp - apartmentBox.minX),
          Math.abs(perp - apartmentBox.maxX)
        )
    return distToEdge <= GLASS_EXTERIOR_PROXIMITY_PT
  })
  const doorOpenings: FloorplanDoorOpening[] = doorsPdf.map((d, i) => {
    const p1 = mapPoint({ x: d.x1, y: d.y1 }, apartmentBox, targetBox)
    const p2 = mapPoint({ x: d.x2, y: d.y2 }, apartmentBox, targetBox)
    return {
      id: `door-${i}`,
      x1: p1.x,
      y1: p1.y,
      x2: p2.x,
      y2: p2.y,
      kind: d.kind,
    }
  })

  const exteriorWallCount = exteriorPdf.length
  const interiorWallCount = interiorPdfStrong.length
  const fixtureLineCount = allClassified.filter((c) => c.type === "fixture").length
  const windowCount = windowOpenings.length
  const doorCount = doorOpenings.length

  const notes: string[] = [
    outerContourFromVector
      ? `Vector outer contour recovered (${outerContourVertexCount} vertices, ${contour?.anchorsCovered ?? 0} room anchors covered). ` +
        `Walls: ${exteriorWallCount} exterior, ${interiorWallCount} interior partitions` +
        (fixtureLineCount > 0
          ? `, ${fixtureLineCount} micro-fixture scribbles`
          : " (former gray fixture strokes merged into wall classification)") +
        `. ` +
        `${pairing.pairs.length} double-line wall pairs supplied thickness. ${windowCount} windows + ${doorCount} doors detected.`
      : `Vector wall structure applied (${strongWalls.length} strong walls kept verbatim; outer contour fell back to rectangle, no exterior/interior split). ${pairing.pairs.length} double-line wall pairs supplied thickness. ${windowCount} windows + ${doorCount} doors detected.`,
  ]

  return {
    geometry: {
      units: "m",
      footprintPolygon,
      interiorWalls,
      doorOpenings: doorOpenings.length ? doorOpenings : undefined,
      windowOpenings: windowOpenings.length ? windowOpenings : undefined,
      confidence: outerContourFromVector ? 0.85 : 0.7,
      rawText: page.texts
        .filter((text) => pointInBox(text.x, text.y, apartmentBox))
        .map((text) => text.text),
    },
    apartmentBoxPdf: apartmentBox,
    outerContourFromVector,
    outerContourVertexCount,
    doubleLineWallCount: pairing.pairs.length,
    singletonWallCount: pairing.unpaired.length,
    exteriorWallCount,
    interiorWallCount,
    fixtureLineCount,
    windowCount,
    doorCount,
    structuralLineCount: structuralLines.length,
    strongWallCount: strongWalls.length,
    notes,
  }
}

/**
 * Production entry: extract PDF primitives via `pdf.js`, then run the same analysis pipeline
 * as `analyzePdfVectorPrimitivesPage`. The split lets tests bypass extraction.
 */
export async function analyzePdfVectorStructure(
  pdfBytes: Uint8Array,
  opts: { targetWidth: number; targetDepth: number }
): Promise<PdfVectorStructuralAnalysisResult | null> {
  const { primitives } = await extractPdfVectorPrimitives(pdfBytes)
  const page = primitives[0]
  if (!page) return null
  return analyzePdfVectorPrimitivesPage(page as PdfVectorPagePrimitives, opts)
}
