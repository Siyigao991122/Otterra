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
  /**
   * Semantic role of this wall line:
   *  - `exterior`: part of the apartment outer shell (close to footprintPolygon boundary)
   *  - `interior`: a partition wall fully inside the unit
   *  - `fixture`: an appliance/cabinet/vanity outline (kitchen, bath fixtures, etc.)
   */
  wallType?: "exterior" | "interior" | "fixture"
}

export interface FloorplanDoorOpening {
  id: string
  x1: number
  y1: number
  x2: number
  y2: number
  /** Door opening height in meters. */
  height?: number
  /** Optional source hint for rendering/UX. */
  kind?: "swing" | "sliding" | "opening" | "unknown"
}

/**
 * A window cut in an exterior wall. Coordinates describe the window mouth in plan space
 * (same units as the surrounding `FloorplanGeometry`); height is the head height in meters.
 */
export interface FloorplanWindowOpening {
  id: string
  x1: number
  y1: number
  x2: number
  y2: number
  /** Window head height (top of glass) in meters. */
  height?: number
  /** Sill height above floor in meters. */
  sillHeight?: number
}

export interface FloorplanRoomZone {
  id: string
  label?: string
  polygon: FloorplanPoint2D[]
}

export interface FloorplanDimensionAnnotation {
  value: number
  unit?: string
  p1: FloorplanPoint2D
  p2: FloorplanPoint2D
}

/**
 * Structured geometry from floorplan analysis (MVP: footprint + optional interior walls).
 */
export interface FloorplanGeometry {
  units?: "m" | "ft"
  scale?: number
  footprintPolygon: FloorplanPoint2D[]
  interiorWalls?: FloorplanWallSegment[]
  /** Closed wall-region polygons in floor-plan metre coordinates (x = scene X, y = scene Z). */
  wallPolygons?: FloorplanPoint2D[][]
  doorOpenings?: FloorplanDoorOpening[]
  windowOpenings?: FloorplanWindowOpening[]
  rooms?: FloorplanRoomZone[]
  dimensions?: FloorplanDimensionAnnotation[]
  rawText?: string[]
  confidence?: number
}

/** Provenance for the static room envelope (optional; session + labels). */
export type RoomGeometryEnvelopeSource =
  | "geometry-first"
  | "ai-derived"
  | "fallback-rectangle"
  | "manual-url"
  | "unknown"

export interface RoomDimensions {
  width: number
  depth: number
  height: number
  /** Optional manual scale calibration captured during upload/review flow. */
  manualCalibration?: ManualScaleCalibration
  /**
   * When present with a valid `footprintPolygon` (≥3 finite points), the 3D room shell
   * extrudes this polygon instead of an axis-aligned box. `width`/`depth` remain the AABB
   * / authoring hints for grids, AI layout, and URL params.
   */
  geometry?: FloorplanGeometry
  /**
   * How the unit envelope was produced (floor-plan uploader, URL defaults, future geometry-first, etc.).
   * When omitted, the scene may infer a display tag for legacy sessions.
   */
  geometryEnvelopeSource?: RoomGeometryEnvelopeSource
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
  /**
   * When true, GLB root is scaled per-axis so AABB matches `dimensions` exactly.
   * Set for catalog-backed sizes (width_m / height_m / length_m → scene X/Y/Z).
   * When false/omitted, GLB uses uniform “fit inside” scaling (legacy proxy sizing).
   */
  dimensionsAuthoritative?: boolean
}

export interface DetectedRoom {
  name: string
  widthMeters: number
  depthMeters: number
  heightMeters: number
  /** Normalised 0–1 centre of this room on the floor plan image (from GPT). */
  cx?: number
  cy?: number
  /** Raw dimension text found on the floor plan, e.g. "14'6\" × 20'5\"" */
  dimensionText?: string
  /** Whether dimensions came from OCR text on the plan (true) or GPT visual estimate (false) */
  dimensionsFromOCR?: boolean
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

/** Client-side floorplan preflight (vector PDF vs image path); attached after analyze for internal QA. */
export interface FloorplanPreflightDiagnosticAttachment {
  preflightSource: "pdf-vector-analysis" | "pdf-browser-preview-analysis" | "image-fallback-analysis"
  result: import("@/lib/floorplanPreflight").FloorplanPreflightResult
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
  /** Preflight diagnostic from `lib/floorplanPreflight` (upload flow); not used for layout logic. */
  _preflightDiagnostic?: FloorplanPreflightDiagnosticAttachment
}

export interface ManualScaleCalibration {
  p1: FloorplanPoint2D
  p2: FloorplanPoint2D
  realLengthMeters: number
  metersPerUnit: number
  /** Uniform multiplier applied to AI-derived plan metrics after manual calibration. */
  analysisScaleFactor?: number
}
 