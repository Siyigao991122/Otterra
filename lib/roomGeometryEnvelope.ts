import { isValidFootprintPolygon, polygonAABB } from "@/lib/floorplanGeometry"
import type { RoomDimensions, RoomGeometryEnvelopeSource } from "@/lib/types"

/**
 * Resolves `geometryEnvelopeSource` for display when older sessions omitted it.
 */
export function resolveRoomGeometryEnvelopeSource(dimensions: RoomDimensions): RoomGeometryEnvelopeSource {
  if (dimensions.geometryEnvelopeSource) return dimensions.geometryEnvelopeSource
  const fp = dimensions.geometry?.footprintPolygon
  if (fp && isValidFootprintPolygon(fp)) return "ai-derived"
  return "fallback-rectangle"
}

/** Short tag for in-scene labels (matches user-facing wording). */
export function roomGeometrySourceDisplayTag(source: RoomGeometryEnvelopeSource): string {
  switch (source) {
    case "geometry-first":
      return "geometry-first"
    case "ai-derived":
      return "AI-derived"
    case "fallback-rectangle":
      return "fallback rectangle"
    case "manual-url":
      return "manual / URL"
    default:
      return "unknown"
  }
}

export function roomFootprintHorizontalExtentsM(dimensions: RoomDimensions): { widthM: number; depthM: number } {
  const fp = dimensions.geometry?.footprintPolygon
  if (fp && isValidFootprintPolygon(fp)) {
    const { width, depth } = polygonAABB(fp)
    return { widthM: width, depthM: depth }
  }
  return { widthM: dimensions.width, depthM: dimensions.depth }
}

export function roomLabelWorldPosition(dimensions: RoomDimensions, yLift = 0.22): [number, number, number] {
  const fp = dimensions.geometry?.footprintPolygon
  if (fp && isValidFootprintPolygon(fp)) {
    const aabb = polygonAABB(fp)
    const cx = (aabb.minX + aabb.maxX) / 2
    const cy = (aabb.minY + aabb.maxY) / 2
    return [cx, yLift, -cy]
  }
  return [0, yLift, 0]
}
