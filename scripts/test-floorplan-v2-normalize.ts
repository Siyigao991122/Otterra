import assert from "node:assert/strict"
import { normalizeFloorplanGeometryV2 } from "../lib/floorplan-v2/normalizeGeometry"

const result = normalizeFloorplanGeometryV2({
  source: "manual",
  scaleSource: "drawing",
  geometry: {
    units: "m",
    footprintPolygon: [
      { x: 0, y: 0 },
      { x: 6, y: 0 },
      { x: 6, y: 4 },
      { x: 0, y: 4 },
    ],
    interiorWalls: [
      { id: "wall-a", x1: 0, y1: 0.01, x2: 2.98, y2: 0, thickness: 0.12, wallType: "exterior" },
      { id: "wall-b", x1: 3.02, y1: 0, x2: 6, y2: -0.01, thickness: 0.12, wallType: "exterior" },
      { id: "wall-c", x1: 3.01, y1: 0.02, x2: 3, y2: 4, thickness: 0.1, wallType: "interior" },
      { id: "sink-outline", x1: 1, y1: 1, x2: 1.8, y2: 1, wallType: "fixture" },
    ],
    doorOpenings: [
      { id: "door-1", x1: 1.1, y1: 0.03, x2: 1.9, y2: 0.03, kind: "swing" },
    ],
    windowOpenings: [
      { id: "window-unresolved", x1: 1, y1: 2, x2: 2, y2: 2 },
    ],
  },
})

assert.equal(result.schema, "otterra-floorplan/v2")
assert.equal(result.stats.inputWallCount, 4)
assert.equal(result.stats.ignoredFixtureLineCount, 1)
assert.equal(result.stats.axisSnappedWallCount, 3)
assert.equal(result.stats.outputWallCount, 2)
assert.equal(result.stats.mergedWallCount, 1)
assert.equal(result.stats.hostedDoorCount, 1)
assert.equal(result.stats.unresolvedWindowCount, 1)
assert.equal(result.geometry.doorOpenings?.[0]?.hostWallId, "wall-a")
assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "unresolved_window_host"))
assert.ok(result.geometry.interiorWalls?.every((wall) => wall.wallType !== "fixture"))
assert.ok(
  result.geometry.interiorWalls?.every(
    (wall) => Math.abs(wall.x2 - wall.x1) < 1e-7 || Math.abs(wall.y2 - wall.y1) < 1e-7
  )
)

console.log("floorplan-v2 normalize: PASS", result.stats)
