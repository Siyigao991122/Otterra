/** One vertex in 2D plan space; maps to Three.js X and Z (Y is up). */
export interface FloorplanPoint2D {
  x: number
  y: number
}

export interface FloorplanWallSegment {
  id: string
  x1: number
  y1: number
  x2: number
  y2: number
  /** Wall thickness in meters (optional; default in renderer). */
  thickness?: number
}

export type FloorplanOpeningType = "door" | "window"

/** A door or window opening in a wall. Position is the center of the opening in plan space. */
export interface FloorplanOpening {
  id: string
  type: FloorplanOpeningType
  /** Center of opening in plan space (same coordinate system as footprint). */
  x: number
  y: number
  /** Opening width in meters. */
  width: number
  /** Opening height in meters (default: 2.1 for door, 1.2 for window). */
  height?: number
  /** Sill height from floor in meters (windows only; default 0.9). */
  sillHeight?: number
}

/** Room type used for floor color coding and labeling. */
export type FloorplanRoomType =
  | "living_room"
  | "bedroom"
  | "bathroom"
  | "kitchen"
  | "dining"
  | "hallway"
  | "office"
  | "balcony"
  | "storage"
  | "garage"
  | "other"

export interface FloorplanRoomZone {
  id: string
  label?: string
  type?: FloorplanRoomType | string
  polygon: FloorplanPoint2D[]
  centroid?: FloorplanPoint2D
}

export interface FloorplanDimensionAnnotation {
  value: number
  unit?: string
  p1: FloorplanPoint2D
  p2: FloorplanPoint2D
}

/**
 * Structured geometry from floorplan analysis.
 */
export interface FloorplanGeometry {
  units?: "m" | "ft"
  scale?: number
  footprintPolygon: FloorplanPoint2D[]
  interiorWalls?: FloorplanWallSegment[]
  openings?: FloorplanOpening[]
  rooms?: FloorplanRoomZone[]
  dimensions?: FloorplanDimensionAnnotation[]
  rawText?: string[]
  confidence?: number
}

export interface RoomDimensions {
  width: number
  depth: number
  height: number
  /**
   * When present with a valid `footprintPolygon` (≥3 finite points), the 3D room shell
   * extrudes this polygon instead of an axis-aligned box. `width`/`depth` remain the AABB
   * / authoring hints for grids, AI layout, and URL params.
   */
  geometry?: FloorplanGeometry
}

/**
 * Scene dimensions; maps to Three.js axes:
 * width→X, height→Y, depth→Z. See lib/dimensionSemantics.ts.
 */
export interface FurnitureDimensions {
  width: number
  height: number
  depth: number
}

export interface Furniture {
  id: string
  type: string
  name: string
  color: string
  dimensions: FurnitureDimensions
  position: [number, number, number]
  rotation: number
  /** GLB URL for real 3D model; if absent, proxy box is used */
  model_url?: string | null
}

export interface DetectedRoom {
  name: string
  widthMeters: number
  depthMeters: number
  heightMeters: number
}

/** Stats from parsing interiorWallsMeters (TEMPORARY debug). */
export interface InteriorWallSanitizeStats {
  /** Length of interiorWallsMeters / interiorWalls array in model JSON. */
  modelRawArrayCount: number
  /** Items with four finite endpoint coordinates (before length / outlier filters). */
  parsedFiniteSegmentCount: number
  /** Segments kept after filters and written to `geometry.interiorWalls`. */
  normalizedCount: number
  droppedInvalid: number
  droppedDegenerate: number
  droppedOutlier: number
}

/** TEMPORARY: footprint geometry visibility for debugging; remove when stable. */
export interface FloorplanFootprintDebugInfo {
  footprintPointCount: number
  geometryType: "none" | "quad" | "polygon"
  /** True when the model did not yield a sanitized polygon and mergeAnalysis used rectangleFootprintFromAABB. */
  usedFallbackRectangle: boolean
  /** Vertices in model JSON (footprintPolygonMeters / footprintPolygon) before server sanitize. */
  modelRawFootprintVertexCount: number
  /** True when the model supplied exactly four finite footprint vertices (often an oversimplified quad). */
  modelReturnedExactlyFourFootprintPoints: boolean
  /** Interior wall pipeline (raw vs sanitized); TODO remove when stable. */
  interiorWalls?: InteriorWallSanitizeStats
}

export interface FloorPlanAnalysis {
  rooms: DetectedRoom[]
  totalWidthMeters: number
  totalDepthMeters: number
  totalAreaSqMeters: number
  notes: string
  /** Populated when analysis extracts a usable footprint; otherwise omit (legacy rectangle room). */
  geometry?: FloorplanGeometry
  /** TEMPORARY */
  _debugFloorplanGeometry?: FloorplanFootprintDebugInfo
}
