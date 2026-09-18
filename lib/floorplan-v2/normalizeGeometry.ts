import { isValidFootprintPolygon } from "@/lib/floorplanGeometry"
import type {
  FloorplanDoorOpening,
  FloorplanPoint2D,
  FloorplanWallSegment,
  FloorplanWindowOpening,
} from "@/lib/types"
import type {
  ArchitecturalWall,
  FloorplanV2Diagnostic,
  FloorplanV2NormalizeInput,
  FloorplanV2Package,
  FloorplanV2Stats,
  HostedDoorOpening,
  HostedWindowOpening,
} from "@/lib/floorplan-v2/types"

const DEFAULTS = {
  endpointSnapToleranceM: 0.08,
  axisSnapAngleDeg: 4,
  collinearToleranceM: 0.035,
  openingHostToleranceM: 0.2,
  minWallLengthM: 0.08,
} as const

type Point = { x: number; y: number }

function finite(value: number): boolean {
  return Number.isFinite(value)
}

function wallLength(wall: FloorplanWallSegment): number {
  return Math.hypot(wall.x2 - wall.x1, wall.y2 - wall.y1)
}

function openingLength(opening: FloorplanDoorOpening | FloorplanWindowOpening): number {
  return Math.hypot(opening.x2 - opening.x1, opening.y2 - opening.y1)
}

function orientation(wall: FloorplanWallSegment): "horizontal" | "vertical" | "angled" {
  const dx = Math.abs(wall.x2 - wall.x1)
  const dy = Math.abs(wall.y2 - wall.y1)
  if (dy <= 1e-7) return "horizontal"
  if (dx <= 1e-7) return "vertical"
  return "angled"
}

function snapWallToAxis(
  wall: ArchitecturalWall,
  thresholdDeg: number
): { wall: ArchitecturalWall; snapped: boolean } {
  const dx = wall.x2 - wall.x1
  const dy = wall.y2 - wall.y1
  const angle = Math.abs((Math.atan2(dy, dx) * 180) / Math.PI)
  const horizontalError = Math.min(angle, Math.abs(180 - angle))
  const verticalError = Math.abs(90 - angle)

  if (horizontalError <= thresholdDeg) {
    const y = (wall.y1 + wall.y2) / 2
    return { wall: { ...wall, y1: y, y2: y }, snapped: Math.abs(dy) > 1e-7 }
  }
  if (verticalError <= thresholdDeg) {
    const x = (wall.x1 + wall.x2) / 2
    return { wall: { ...wall, x1: x, x2: x }, snapped: Math.abs(dx) > 1e-7 }
  }
  return { wall, snapped: false }
}

function snapEndpoints(
  walls: ArchitecturalWall[],
  tolerance: number
): { walls: ArchitecturalWall[]; snapCount: number } {
  const next = walls.map((wall) => ({ ...wall }))
  const endpoints: Array<{ wallIndex: number; key: "start" | "end"; point: Point }> = []
  next.forEach((wall, wallIndex) => {
    endpoints.push({ wallIndex, key: "start", point: { x: wall.x1, y: wall.y1 } })
    endpoints.push({ wallIndex, key: "end", point: { x: wall.x2, y: wall.y2 } })
  })

  const used = new Set<number>()
  let snapCount = 0
  for (let i = 0; i < endpoints.length; i++) {
    if (used.has(i)) continue
    const cluster = [i]
    for (let j = i + 1; j < endpoints.length; j++) {
      if (used.has(j)) continue
      const a = endpoints[i].point
      const b = endpoints[j].point
      if (Math.hypot(a.x - b.x, a.y - b.y) <= tolerance) cluster.push(j)
    }
    if (cluster.length < 2) continue

    const x = cluster.reduce((sum, index) => sum + endpoints[index].point.x, 0) / cluster.length
    const y = cluster.reduce((sum, index) => sum + endpoints[index].point.y, 0) / cluster.length
    for (const index of cluster) {
      used.add(index)
      const endpoint = endpoints[index]
      const wall = next[endpoint.wallIndex]
      if (endpoint.key === "start") {
        if (Math.hypot(wall.x1 - x, wall.y1 - y) > 1e-7) snapCount++
        wall.x1 = x
        wall.y1 = y
      } else {
        if (Math.hypot(wall.x2 - x, wall.y2 - y) > 1e-7) snapCount++
        wall.x2 = x
        wall.y2 = y
      }
    }
  }
  return { walls: next, snapCount }
}

function intervalFor(wall: ArchitecturalWall): [number, number] {
  return orientation(wall) === "vertical"
    ? [Math.min(wall.y1, wall.y2), Math.max(wall.y1, wall.y2)]
    : [Math.min(wall.x1, wall.x2), Math.max(wall.x1, wall.x2)]
}

function perpendicularCoordinate(wall: ArchitecturalWall): number {
  return orientation(wall) === "vertical" ? (wall.x1 + wall.x2) / 2 : (wall.y1 + wall.y2) / 2
}

function mergeCollinearWalls(
  walls: ArchitecturalWall[],
  tolerance: number
): { walls: ArchitecturalWall[]; mergedCount: number } {
  const remaining = walls.map((wall) => ({ ...wall }))
  let mergedCount = 0
  let changed = true

  while (changed) {
    changed = false
    outer: for (let i = 0; i < remaining.length; i++) {
      for (let j = i + 1; j < remaining.length; j++) {
        const a = remaining[i]
        const b = remaining[j]
        const aOrientation = orientation(a)
        if (aOrientation === "angled" || aOrientation !== orientation(b)) continue
        if (a.wallType !== b.wallType) continue
        if (Math.abs(perpendicularCoordinate(a) - perpendicularCoordinate(b)) > tolerance) continue

        const [aMin, aMax] = intervalFor(a)
        const [bMin, bMax] = intervalFor(b)
        // Merge only overlaps or already-snapped touching endpoints. Never bridge a
        // visible gap here: it may be a door/window opening that must be preserved.
        if (Math.max(aMin, bMin) - Math.min(aMax, bMax) > 1e-6) continue

        const min = Math.min(aMin, bMin)
        const max = Math.max(aMax, bMax)
        const perp = (perpendicularCoordinate(a) + perpendicularCoordinate(b)) / 2
        const merged: ArchitecturalWall =
          aOrientation === "vertical"
            ? { ...a, id: a.id, x1: perp, x2: perp, y1: min, y2: max }
            : { ...a, id: a.id, x1: min, x2: max, y1: perp, y2: perp }
        merged.thickness = Math.max(a.thickness ?? 0.12, b.thickness ?? 0.12)
        remaining.splice(j, 1)
        remaining[i] = merged
        mergedCount++
        changed = true
        break outer
      }
    }
  }
  return { walls: remaining, mergedCount }
}

function distancePointToSegment(point: Point, wall: ArchitecturalWall): number {
  const dx = wall.x2 - wall.x1
  const dy = wall.y2 - wall.y1
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared <= 1e-12) return Math.hypot(point.x - wall.x1, point.y - wall.y1)
  const t = Math.max(
    0,
    Math.min(1, ((point.x - wall.x1) * dx + (point.y - wall.y1) * dy) / lengthSquared)
  )
  return Math.hypot(point.x - (wall.x1 + t * dx), point.y - (wall.y1 + t * dy))
}

function parallelAngleErrorDeg(
  opening: FloorplanDoorOpening | FloorplanWindowOpening,
  wall: ArchitecturalWall
): number {
  const a = Math.atan2(opening.y2 - opening.y1, opening.x2 - opening.x1)
  const b = Math.atan2(wall.y2 - wall.y1, wall.x2 - wall.x1)
  let diff = Math.abs(((a - b) * 180) / Math.PI) % 180
  if (diff > 90) diff = 180 - diff
  return diff
}

function findHostWall(
  opening: FloorplanDoorOpening | FloorplanWindowOpening,
  walls: ArchitecturalWall[],
  tolerance: number
): ArchitecturalWall | undefined {
  const midpoint = { x: (opening.x1 + opening.x2) / 2, y: (opening.y1 + opening.y2) / 2 }
  return walls
    .map((wall) => ({
      wall,
      distance: distancePointToSegment(midpoint, wall),
      angleError: parallelAngleErrorDeg(opening, wall),
    }))
    .filter((candidate) => candidate.distance <= tolerance && candidate.angleError <= 12)
    .sort((a, b) => a.distance - b.distance)[0]?.wall
}

function hostOpenings<T extends FloorplanDoorOpening | FloorplanWindowOpening>(
  openings: T[] | undefined,
  walls: ArchitecturalWall[],
  tolerance: number,
  kind: "door" | "window",
  diagnostics: FloorplanV2Diagnostic[]
): Array<T & { hostWallId?: string }> {
  const output: Array<T & { hostWallId?: string }> = []
  for (const opening of openings ?? []) {
    if (![opening.x1, opening.y1, opening.x2, opening.y2].every(finite) || openingLength(opening) < 0.1) {
      diagnostics.push({
        code: `invalid_${kind}`,
        severity: "warning",
        featureId: opening.id,
        message: `${kind} was dropped because its geometry is invalid or too short.`,
      })
      continue
    }
    const host = findHostWall(opening, walls, tolerance)
    if (!host) {
      diagnostics.push({
        code: `unresolved_${kind}_host`,
        severity: "error",
        featureId: opening.id,
        message: `${kind} is not aligned with a nearby architectural wall.`,
      })
      output.push({ ...opening })
      continue
    }
    output.push({ ...opening, hostWallId: host.id })
  }
  return output
}

export function normalizeFloorplanGeometryV2(input: FloorplanV2NormalizeInput): FloorplanV2Package {
  const options = { ...DEFAULTS, ...(input.options ?? {}) }
  const diagnostics: FloorplanV2Diagnostic[] = []
  const rawWalls = input.geometry.interiorWalls ?? []
  let droppedWallCount = 0
  let ignoredFixtureLineCount = 0
  let axisSnappedWallCount = 0

  const architecturalWalls: ArchitecturalWall[] = []
  for (const wall of rawWalls) {
    if (wall.wallType === "fixture") {
      ignoredFixtureLineCount++
      diagnostics.push({
        code: "fixture_excluded_from_architecture",
        severity: "info",
        featureId: wall.id,
        message: "Fixture/casework line was excluded from architectural walls.",
      })
      continue
    }
    if (![wall.x1, wall.y1, wall.x2, wall.y2].every(finite) || wallLength(wall) < options.minWallLengthM) {
      droppedWallCount++
      diagnostics.push({
        code: "invalid_wall",
        severity: "warning",
        featureId: wall.id,
        message: "Wall was dropped because its geometry is invalid or too short.",
      })
      continue
    }
    const normalizedType = wall.wallType === "exterior" ? "exterior" : "interior"
    const snapped = snapWallToAxis({ ...wall, wallType: normalizedType }, options.axisSnapAngleDeg)
    if (snapped.snapped) axisSnappedWallCount++
    architecturalWalls.push(snapped.wall)
  }

  const endpointResult = snapEndpoints(architecturalWalls, options.endpointSnapToleranceM)
  // Endpoint clustering can introduce a tiny slope when a junction contains several
  // near-axis walls. Re-apply the axis constraint before overlap merging so topology
  // repair never turns a validated horizontal/vertical wall back into an angled wall.
  const postSnapWalls = endpointResult.walls.map(
    (wall) => snapWallToAxis(wall, options.axisSnapAngleDeg).wall
  )
  const mergeResult = mergeCollinearWalls(postSnapWalls, options.collinearToleranceM)

  const doorOpenings = hostOpenings(
    input.geometry.doorOpenings,
    mergeResult.walls,
    options.openingHostToleranceM,
    "door",
    diagnostics
  ) as HostedDoorOpening[]
  const windowOpenings = hostOpenings(
    input.geometry.windowOpenings,
    mergeResult.walls,
    options.openingHostToleranceM,
    "window",
    diagnostics
  ) as HostedWindowOpening[]

  if (!isValidFootprintPolygon(input.geometry.footprintPolygon)) {
    diagnostics.push({
      code: "invalid_footprint",
      severity: "error",
      message: "The apartment footprint is missing, degenerate, or not finite.",
    })
  }
  if (mergeResult.walls.length === 0) {
    diagnostics.push({
      code: "missing_architectural_walls",
      severity: "error",
      message: "No architectural walls remain after validation.",
    })
  }

  const hostedDoorCount = doorOpenings.filter((opening) => opening.hostWallId).length
  const hostedWindowCount = windowOpenings.filter((opening) => opening.hostWallId).length
  const stats: FloorplanV2Stats = {
    inputWallCount: rawWalls.length,
    outputWallCount: mergeResult.walls.length,
    droppedWallCount,
    ignoredFixtureLineCount,
    axisSnappedWallCount,
    endpointSnapCount: endpointResult.snapCount,
    mergedWallCount: mergeResult.mergedCount,
    hostedDoorCount,
    unresolvedDoorCount: doorOpenings.length - hostedDoorCount,
    hostedWindowCount,
    unresolvedWindowCount: windowOpenings.length - hostedWindowCount,
  }

  return {
    schema: "otterra-floorplan/v2",
    units: "m",
    frame: {
      orientation: "y_up",
      scaleSource: input.scaleSource ?? "unknown",
    },
    geometry: {
      ...input.geometry,
      units: "m",
      interiorWalls: mergeResult.walls,
      doorOpenings: doorOpenings.length ? doorOpenings : undefined,
      windowOpenings: windowOpenings.length ? windowOpenings : undefined,
    },
    diagnostics,
    stats,
    provenance: {
      source: input.source ?? "unknown",
      generatedAt: new Date().toISOString(),
    },
  }
}

export function floorplanV2HasBlockingErrors(result: FloorplanV2Package): boolean {
  return result.diagnostics.some((diagnostic) => diagnostic.severity === "error")
}

export function wallEndpoints(wall: FloorplanWallSegment): [FloorplanPoint2D, FloorplanPoint2D] {
  return [
    { x: wall.x1, y: wall.y1 },
    { x: wall.x2, y: wall.y2 },
  ]
}
