/**
 * Helpers for floorplan → 3D footprint (2D plan x → scene X, plan y → scene Z, Y-up).
 */

import type {
  FloorplanGeometry,
  FloorplanOpening,
  FloorplanPoint2D,
  FloorplanRoomZone,
  FloorplanWallSegment,
  InteriorWallSanitizeStats,
} from "@/lib/types"

/** Minimum polygon vertices for extruded room shell */
export const MIN_FOOTPRINT_VERTICES = 3

export function polygonSignedAreaMeters2(pts: FloorplanPoint2D[]): number {
  if (pts.length < 3) return 0
  let sum = 0
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length
    sum += pts[i].x * pts[j].y - pts[j].x * pts[i].y
  }
  return sum / 2
}

export function polygonAABB(pts: FloorplanPoint2D[]): {
  minX: number
  maxX: number
  minY: number
  maxY: number
  width: number
  depth: number
} {
  const xs = pts.map((p) => p.x)
  const ys = pts.map((p) => p.y)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  return {
    minX,
    maxX,
    minY,
    maxY,
    width: maxX - minX,
    depth: maxY - minY,
  }
}

export function centerPolygonAtOrigin(pts: FloorplanPoint2D[]): FloorplanPoint2D[] {
  if (pts.length === 0) return pts
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length
  return pts.map((p) => ({ x: p.x - cx, y: p.y - cy }))
}

export function rectangleFootprintFromAABB(width: number, depth: number): FloorplanPoint2D[] {
  const hw = width / 2
  const hd = depth / 2
  return [
    { x: -hw, y: -hd },
    { x: hw, y: -hd },
    { x: hw, y: hd },
    { x: -hw, y: hd },
  ]
}

export function isValidFootprintPolygon(pts: FloorplanPoint2D[] | undefined): boolean {
  if (!pts || pts.length < MIN_FOOTPRINT_VERTICES) return false
  if (!pts.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) return false
  return Math.abs(polygonSignedAreaMeters2(pts)) > 1e-6
}

/** Drop duplicate closing point if first===last */
export function dedupeClosedPolygon(pts: FloorplanPoint2D[]): FloorplanPoint2D[] {
  if (pts.length < 2) return pts
  const first = pts[0]
  const last = pts[pts.length - 1]
  if (first.x === last.x && first.y === last.y) return pts.slice(0, -1)
  return pts
}

const INTERIOR_WALL_MIN_LENGTH_M = 0.08
const INTERIOR_WALL_DEFAULT_THICKNESS_M = 0.12
const INTERIOR_WALL_MIN_THICKNESS_M = 0.06
const INTERIOR_WALL_MAX_THICKNESS_M = 0.45

function emptyInteriorWallStats(): InteriorWallSanitizeStats {
  return {
    modelRawArrayCount: 0,
    parsedFiniteSegmentCount: 0,
    normalizedCount: 0,
    droppedInvalid: 0,
    droppedDegenerate: 0,
    droppedOutlier: 0,
  }
}

/**
 * Parse interior wall segments: same meter/plan frame as footprint (before centering).
 * Drops degenerate shorts, absurd lengths; default/clamp thickness when missing or invalid.
 */
function processInteriorWalls(
  raw: unknown,
  cx: number,
  cy: number,
  footprintSpan: number
): { walls: FloorplanWallSegment[]; stats: InteriorWallSanitizeStats } {
  const stats = emptyInteriorWallStats()
  if (!Array.isArray(raw)) {
    return { walls: [], stats }
  }
  stats.modelRawArrayCount = raw.length
  const maxLen = Math.min(Math.max(footprintSpan * 2.2, 30), 120)

  const out: FloorplanWallSegment[] = []
  for (let i = 0; i < raw.length; i++) {
    const w = raw[i]
    if (!w || typeof w !== "object") {
      stats.droppedInvalid++
      continue
    }
    const o = w as Record<string, unknown>
    const x1 = Number(o.x1)
    const y1 = Number(o.y1)
    const x2 = Number(o.x2)
    const y2 = Number(o.y2)
    if (![x1, y1, x2, y2].every(Number.isFinite)) {
      stats.droppedInvalid++
      continue
    }
    stats.parsedFiniteSegmentCount++
    const len = Math.hypot(x2 - x1, y2 - y1)
    if (len < INTERIOR_WALL_MIN_LENGTH_M) {
      stats.droppedDegenerate++
      continue
    }
    if (len > maxLen) {
      stats.droppedOutlier++
      continue
    }
    let thickness =
      o.thickness != null && Number.isFinite(Number(o.thickness))
        ? Number(o.thickness)
        : INTERIOR_WALL_DEFAULT_THICKNESS_M
    thickness = Math.min(
      INTERIOR_WALL_MAX_THICKNESS_M,
      Math.max(INTERIOR_WALL_MIN_THICKNESS_M, thickness)
    )
    out.push({
      id: typeof o.id === "string" ? o.id : `wall-${i}`,
      x1: x1 - cx,
      y1: y1 - cy,
      x2: x2 - cx,
      y2: y2 - cy,
      thickness,
    })
  }
  stats.normalizedCount = out.length
  return { walls: out, stats }
}

/** When footprint sanitize fails: still count what the model sent for walls (debug only). */
function interiorWallRawOnlyStats(raw: unknown): InteriorWallSanitizeStats {
  const stats = emptyInteriorWallStats()
  if (!Array.isArray(raw)) return stats
  stats.modelRawArrayCount = raw.length
  for (const w of raw) {
    if (!w || typeof w !== "object") {
      stats.droppedInvalid++
      continue
    }
    const o = w as Record<string, unknown>
    if (![Number(o.x1), Number(o.y1), Number(o.x2), Number(o.y2)].every(Number.isFinite)) {
      stats.droppedInvalid++
      continue
    }
    stats.parsedFiniteSegmentCount++
  }
  return stats
}

export function sanitizeFloorplanGeometryWithStats(raw: unknown): {
  geometry: FloorplanGeometry | undefined
  interiorWallStats: InteriorWallSanitizeStats
} {
  const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null
  const wallsField = obj?.interiorWallsMeters ?? obj?.interiorWalls

  if (!obj) {
    return { geometry: undefined, interiorWallStats: emptyInteriorWallStats() }
  }

  const candidates = obj.footprintPolygonMeters ?? obj.footprintPolygon
  if (!Array.isArray(candidates)) {
    return { geometry: undefined, interiorWallStats: interiorWallRawOnlyStats(wallsField) }
  }

  const pts: FloorplanPoint2D[] = []
  for (const item of candidates) {
    if (!item || typeof item !== "object") continue
    const o = item as Record<string, unknown>
    const x = Number(o.x)
    const y = Number(o.y)
    if (Number.isFinite(x) && Number.isFinite(y)) pts.push({ x, y })
  }
  const open = dedupeClosedPolygon(pts)
  if (!isValidFootprintPolygon(open)) {
    return { geometry: undefined, interiorWallStats: interiorWallRawOnlyStats(wallsField) }
  }

  const { minX, maxX, minY, maxY } = polygonAABB(open)
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  const footprintPolygon = open.map((p) => ({ x: p.x - cx, y: p.y - cy }))
  const span = Math.max(maxX - minX, maxY - minY, 1)

  const { walls: interiorWalls, stats: interiorWallStats } = processInteriorWalls(wallsField, cx, cy, span)

  const openings = processOpenings(obj.openingsMeters ?? obj.openings, cx, cy)
  const rooms = processRoomZones(obj.roomZonesMeters ?? obj.roomZones, cx, cy)

  const geometry: FloorplanGeometry = {
    units: "m",
    footprintPolygon,
    interiorWalls: interiorWalls.length ? interiorWalls : undefined,
    openings: openings.length ? openings : undefined,
    rooms: rooms.length ? rooms : undefined,
    confidence: typeof obj.confidence === "number" ? obj.confidence : undefined,
  }

  return { geometry, interiorWallStats }
}

function processOpenings(raw: unknown, cx: number, cy: number): FloorplanOpening[] {
  if (!Array.isArray(raw)) return []
  const out: FloorplanOpening[] = []
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i]
    if (!item || typeof item !== "object") continue
    const o = item as Record<string, unknown>
    const x = Number(o.x)
    const y = Number(o.y)
    const width = Number(o.width)
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || width <= 0) continue
    const type: FloorplanOpening["type"] = o.type === "window" ? "window" : "door"
    const opening: FloorplanOpening = {
      id: typeof o.id === "string" ? o.id : `opening-${i}`,
      type,
      x: x - cx,
      y: y - cy,
      width: Math.min(Math.max(width, 0.4), 3.5),
    }
    if (Number.isFinite(Number(o.height)) && Number(o.height) > 0) opening.height = Number(o.height)
    if (Number.isFinite(Number(o.sillHeight))) opening.sillHeight = Number(o.sillHeight)
    out.push(opening)
  }
  return out
}

function polygonCentroid(polygon: FloorplanPoint2D[]): FloorplanPoint2D {
  const cx = polygon.reduce((s, p) => s + p.x, 0) / polygon.length
  const cy = polygon.reduce((s, p) => s + p.y, 0) / polygon.length
  return { x: cx, y: cy }
}

function processRoomZones(raw: unknown, cx: number, cy: number): FloorplanRoomZone[] {
  if (!Array.isArray(raw)) return []
  const out: FloorplanRoomZone[] = []
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i]
    if (!item || typeof item !== "object") continue
    const zone = item as Record<string, unknown>
    const polyRaw = zone.polygon
    if (!Array.isArray(polyRaw)) continue
    const polygon: FloorplanPoint2D[] = []
    for (const pt of polyRaw) {
      if (!pt || typeof pt !== "object") continue
      const p = pt as Record<string, unknown>
      const px = Number(p.x)
      const py = Number(p.y)
      if (Number.isFinite(px) && Number.isFinite(py)) polygon.push({ x: px - cx, y: py - cy })
    }
    if (polygon.length < 3) continue

    let centroid: FloorplanPoint2D | undefined
    if (zone.centroid && typeof zone.centroid === "object") {
      const cr = zone.centroid as Record<string, unknown>
      const crx = Number(cr.x)
      const cry = Number(cr.y)
      if (Number.isFinite(crx) && Number.isFinite(cry)) centroid = { x: crx - cx, y: cry - cy }
    }
    if (!centroid) centroid = polygonCentroid(polygon)

    out.push({
      id: typeof zone.id === "string" ? zone.id : `room-zone-${i}`,
      label: typeof zone.label === "string" ? zone.label : undefined,
      type: typeof zone.type === "string" ? zone.type : undefined,
      polygon,
      centroid,
    })
  }
  return out
}

export function sanitizeFloorplanGeometry(raw: unknown): FloorplanGeometry | undefined {
  return sanitizeFloorplanGeometryWithStats(raw).geometry
}

