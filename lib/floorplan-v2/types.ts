import type {
  FloorplanDoorOpening,
  FloorplanGeometry,
  FloorplanWallSegment,
  FloorplanWindowOpening,
} from "@/lib/types"

export type FloorplanV2DiagnosticSeverity = "error" | "warning" | "info"

export interface FloorplanV2Diagnostic {
  code: string
  severity: FloorplanV2DiagnosticSeverity
  message: string
  featureId?: string
}

export interface HostedDoorOpening extends FloorplanDoorOpening {
  hostWallId?: string
}

export interface HostedWindowOpening extends FloorplanWindowOpening {
  hostWallId?: string
}

export interface NormalizedFloorplanGeometry
  extends Omit<FloorplanGeometry, "doorOpenings" | "windowOpenings"> {
  doorOpenings?: HostedDoorOpening[]
  windowOpenings?: HostedWindowOpening[]
}

export interface FloorplanV2Stats {
  inputWallCount: number
  outputWallCount: number
  droppedWallCount: number
  ignoredFixtureLineCount: number
  axisSnappedWallCount: number
  endpointSnapCount: number
  mergedWallCount: number
  hostedDoorCount: number
  unresolvedDoorCount: number
  hostedWindowCount: number
  unresolvedWindowCount: number
}

export interface FloorplanV2Package {
  schema: "otterra-floorplan/v2"
  units: "m"
  frame: {
    orientation: "y_up"
    scaleSource: "drawing" | "manual" | "estimated" | "unknown"
  }
  geometry: NormalizedFloorplanGeometry
  diagnostics: FloorplanV2Diagnostic[]
  stats: FloorplanV2Stats
  provenance: {
    source: "vector-pdf" | "raster" | "legacy-analysis" | "manual" | "unknown"
    generatedAt: string
  }
}

export interface FloorplanV2NormalizeOptions {
  endpointSnapToleranceM?: number
  axisSnapAngleDeg?: number
  collinearToleranceM?: number
  openingHostToleranceM?: number
  minWallLengthM?: number
}

export interface FloorplanV2NormalizeInput {
  geometry: FloorplanGeometry
  scaleSource?: FloorplanV2Package["frame"]["scaleSource"]
  source?: FloorplanV2Package["provenance"]["source"]
  options?: FloorplanV2NormalizeOptions
}

export type ArchitecturalWall = FloorplanWallSegment & {
  wallType?: "exterior" | "interior"
}
