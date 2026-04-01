/**
 * Geometry-first floorplan pipeline (PDF/CV primitives → precise layout).
 * Parallel to model-first `FloorPlanAnalysis` / `sanitizeFloorplanGeometry`.
 */

import type {
  FloorplanPoint2D,
  FloorplanRoomZone,
  FloorplanWallSegment,
} from "@/lib/types"

/** Page/plan bounds in source coordinates (PDF user space: pt, origin bottom-left). */
export interface PlanBoundingBox {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** One line segment from vector or future CV (not yet merged into walls/footprint). */
export interface ExtractedLineSegment {
  x1: number
  y1: number
  x2: number
  y2: number
  source?: "pdf-operator-list" | "pdf-stroke" | "raster-cv" | "unknown"
}

/** Text positioned on the plan (dimension labels, room names, etc.). */
export interface ExtractedTextRun {
  text: string
  x: number
  y: number
  pageIndex: number
  /** PDF text metrics when available */
  width?: number
  height?: number
}

/**
 * Raw primitives for one plan page before reconstruction.
 * Coordinates stay in source space until a calibration step sets metersPerPdfUnit.
 */
export interface ExtractedPlanPrimitives {
  pageIndex: number
  pageBounds: PlanBoundingBox
  lines: ExtractedLineSegment[]
  texts: ExtractedTextRun[]
  /**
   * True if this page hit the per-page segment cap while walking operator lists.
   */
  operatorListLinesTruncated?: boolean
  /**
   * What we actually extracted in this pass.
   */
  extractionMode:
    | "pdf-text-only"
    | "pdf-strokes-only"
    | "pdf-text-and-strokes"
    | "pdf-vector-stub"
    | "image-placeholder"
}

/**
 * Target output for the precise layout pipeline (meters, centered footprint, etc.).
 * Phase 1: usually empty polygons; reconstruction steps fill this to match `FloorplanGeometry` consumers.
 */
export interface GeometryFirstPreciseLayout {
  units: "m"
  footprintPolygon: FloorplanPoint2D[]
  interiorWalls?: FloorplanWallSegment[]
  roomZones?: FloorplanRoomZone[]
  /** When scale is recovered from dimension strings + line lengths */
  metersPerPdfUnit?: number
  provenance?: {
    pipeline: "geometry-first"
    stage: "primitives-only" | "partial-reconstruction"
  }
}

/** Aggregated histograms (PDF points, not meters). */
export interface LinePrimitiveSummaryPayload {
  totalSegments: number
  lengthBuckets: Array<{
    label: string
    minPt: number
    maxPt: number | null
    count: number
  }>
  angleBuckets: {
    horizontal: number
    vertical: number
    diagonal: number
    other: number
  }
}

/** One ranked left-face cycle after multi-seed search (deduped by canonical vertex cycle). */
export interface OuterCycleCandidateSummary {
  rank: number
  startNodeIndex: number
  startDirectedTo: number
  closed: boolean
  hitStepLimit: boolean
  stepCount: number
  cycleVertexCount: number
  cyclePerimeterPt: number
  cycleSignedAreaPt2: number
  cycleAbsAreaPt2: number
  stepsMatchedToCleanedSegments: number
  stepSupportFraction: number
  /** |area| / convex hull area of largest component; null if hull degenerate */
  areaRatioVsConvexHull: number | null
  /** |area| / axis-aligned bbox area of largest component */
  areaRatioVsLargestBbox: number | null
  /** perimeter / convex hull perimeter */
  perimeterRatioVsHull: number | null
  /** perimeter / bbox rectangle perimeter (2·(w+h)) */
  perimeterRatioVsBbox: number | null
  /**
   * Heuristic scale cue — not ground truth. Small |area| vs hull often indicates an interior room/courtyard loop.
   */
  exteriorScaleHint: "exterior-scale" | "interior-scale" | "uncertain"
  vertexSample: Array<{ x: number; y: number }>
}

/** Left-face walk on largest component — best candidate after multi-seed selection + top alternatives (debug). */
export interface OuterCycleTraceDebug {
  strategy: "left-face-ccw-multi-seed-largest-component"
  attempted: boolean
  found: boolean
  closed: boolean
  hitStepLimit: boolean
  maxSteps: number
  stepCount: number
  cycleVertexCount: number
  cyclePerimeterPt: number
  cycleSignedAreaPt2: number
  stepsMatchedToCleanedSegments: number
  stepSupportFraction: number
  startNodeIndex: number
  startDirectedTo: number
  vertexSample: Array<{ x: number; y: number }>
  notes: string[]
  multiSeed: {
    maxDirectedSeeds: number
    directedSeedsTried: number
    uniqueCycleKeys: number
    /** Deduped closed cycles (canonical rotation) considered for ranking */
    uniqueClosedCycles: number
  }
  /** Best-ranked deduped candidates (closure preferred, then support, then |area|), up to 8 */
  candidateSummariesTop: OuterCycleCandidateSummary[]
  /** 1-based rank of the selected `outerCycleTrace` walk inside `candidateSummariesTop`, or 0 if unranked */
  selectedCandidateRank: number
  /** Short read on whether the selected cycle looks exterior-sized vs interior-sized (heuristic) */
  selectedExteriorScaleHint: OuterCycleCandidateSummary["exteriorScaleHint"]
}

/** Graph foundation from `cleanedWallLines` (quantized nodes, segment edges, components, hull heuristic). */
export interface WallGraphDebugPayload {
  nodeMergeQuantizationPt: number
  hullSegmentMatchTolPt: number
  nodeCount: number
  /** Cleaned segments with distinct endpoint keys (non-loop). */
  segmentEdgeCount: number
  /** Distinct undirected node pairs (topology). */
  graphUniqueEdgeCount: number
  averageDegree: number
  danglingEndpointCount: number
  connectedComponentCount: number
  components: Array<{
    id: number
    nodeCount: number
    segmentCount: number
    graphUniqueEdgeCount: number
  }>
  largestComponent: {
    id: number
    nodeCount: number
    segmentCount: number
    graphUniqueEdgeCount: number
    averageDegree: number
    plausibility: "high" | "medium" | "low"
    nodeFraction: number
    segmentFraction: number
    bboxAreaFraction: number
    bbox: {
      minX: number
      maxX: number
      minY: number
      maxY: number
      widthPt: number
      heightPt: number
      areaPt2: number
    }
  }
  outerBoundaryCandidate: {
    strategy: "convex-hull-largest-component"
    hullVertexCount: number
    hullPerimeterPt: number
    hullAreaPt2: number
    hullEdgesMatchedToSegments: number
    hullVerticesSample: Array<{ x: number; y: number }>
    notes: string[]
  }
  /** Directed left-face cycle on largest component (adjacency sorted CCW by departure angle). */
  outerCycleTrace: OuterCycleTraceDebug
}

/** Connectivity snapshot for before/after junction splitting (same yardstick as `wallGraph`). */
export interface WallJunctionSplitGraphStats {
  nodeCount: number
  averageDegree: number
  danglingEndpointCount: number
  connectedComponentCount: number
  largestComponentPlausibility: "high" | "medium" | "low"
  largestComponentNodeCount: number
}

/** Debug for `splitWallLinesAtJunctions` + optional wall-graph comparison on those segments. */
export interface WallJunctionSplitDebug {
  junctionEpsPt: number
  segmentCountBefore: number
  segmentCountAfter: number
  crossingInteriorEvents: number
  teeEndpointEvents: number
  collinearAxisEvents: number
  /** crossingInterior + tee + collinear (counters may overlap geometrically). */
  eventCounterSum: number
  degenerateDropped: number
  splitSample: Array<{
    x1: number
    y1: number
    x2: number
    y2: number
    lengthPt: number
  }>
  notes: string[]
  /** Filled by orchestrator after building `buildWallGraphFoundationFromCleaned` on pre/post segments */
  graphStatsBefore?: WallJunctionSplitGraphStats
  graphStatsAfter?: WallJunctionSplitGraphStats
}

/** First-pass wall segment cleanup (axis snap, endpoint snap, merge, dedupe). */
export interface WallCandidateCleanupDebug {
  beforeCount: number
  afterCount: number
  thresholds: {
    snapEndpointPt: number
    mergeGapPt: number
    alignHVAngleDeg: number
    lineBucketPt: number
    dedupeDecimals: number
    minLengthPt: number
  }
  /** Example segments after cleanup (same shape as line samples). */
  cleanedLineSample: Array<{
    pageIndex: number
    x1: number
    y1: number
    x2: number
    y2: number
    lengthPt: number
    angleClass: string
    source?: string
  }>
}

/** Score breakdown for one cleaned segment in main-structural selection (debug). */
export interface MainStructuralWallScoreBreakdownPayload {
  lengthScore: number
  axisAlignmentScore: number
  parallelNeighborBonus: number
  overlapBonus: number
  isolatedShortPenalty: number
  textProximityPenalty: number
  localDensity: number
  totalScore: number
  parallelNeighborCount: number
  overlapSupportCount: number
  gatePassed: boolean
  gateFailure: string | null
  scoreRejected: boolean
  selected: boolean
}

export interface MainStructuralWallScoreDistributionPayload {
  min: number
  max: number
  mean: number
  median: number
  p25: number
  p75: number
  p90: number
  selectedCount: number
  rejectedCount: number
}

export interface MainStructuralWallTermAveragesPayload {
  avgLengthScore: number
  avgAxisScore: number
  avgParallelNeighborBonus: number
  avgOverlapBonus: number
  avgIsolatedPenalty: number
  avgTextPenalty: number
}

export interface MainStructuralWallGateBreakdownPayload {
  rejectedHardMinLength: number
  rejectedRequireParallelSupport: number
  rejectedMinParallelNeighborCount: number
  rejectedMinOverlapSupport: number
  rejectedMinNeighborhoodDensity: number
  passedGates: number
  rejectedScoreThreshold: number
  selected: number
}

export interface MainStructuralWallSegmentDebugPayload {
  x1: number
  y1: number
  x2: number
  y2: number
  lengthPt: number
  breakdown: MainStructuralWallScoreBreakdownPayload
}

/** Tuning knobs + sample rows from `selectMainStructuralWalls` (debug only). */
export interface MainStructuralWallSelectorDebugPayload {
  minScoreToKeep: number
  maxParallelGapPt: number
  minOverlapRatio: number
  neighborhoodRadiusPt: number
  referenceLengthPt: number
  isolatedShortLengthPt: number
  isolatedMaxNeighbors: number
  textPenaltyRadiusPt: number
  maxTextPenalty: number
  parallelAngleDeg: number
  axisAlignmentToleranceDeg: number
  weightLength: number
  weightAxis: number
  weightParallelNeighbor: number
  weightOverlap: number
  weightIsolatedShort: number
  maxParallelNeighborBonus: number
  maxOverlapBonus: number
  hardMinLengthPt: number
  requireParallelSupport: boolean
  minParallelNeighborCount: number
  minOverlapSupport: number
  minNeighborhoodDensity: number
  segmentCountIn: number
  segmentCountSelected: number
  perSegmentTotal: number
  scoreDistribution: MainStructuralWallScoreDistributionPayload
  termAverages: MainStructuralWallTermAveragesPayload
  gateBreakdown: MainStructuralWallGateBreakdownPayload
  perSegmentSample: MainStructuralWallSegmentDebugPayload[]
}

/** TEMPORARY: route inspectability (remove when UI consumes primitives directly). */
export interface GeometryFirstDebugPayload {
  /** Pages may differ (e.g. cover vs plan sheet). */
  extractionModesByPage: Array<{
    pageIndex: number
    extractionMode: ExtractedPlanPrimitives["extractionMode"]
  }>
  pageCount: number
  textCount: number
  lineCount: number
  anyPageLinesTruncated: boolean
  /** All pages combined — raw operator-list segments. */
  aggregatedLineSummary: LinePrimitiveSummaryPayload
  /** First-pass wall preview (min length + optional H/V / 45° gate). */
  wallCandidateFilter: {
    minLengthPdfUnits: number
    dominantAngles: "none" | "hv" | "hv45"
    angleToleranceDeg: number
    inputCount: number
    keptCount: number
    droppedShort: number
    droppedAngle: number
  }
  /** Wall-candidate lines → snap / merge / dedupe (no graph yet). */
  wallCandidateCleanup: WallCandidateCleanupDebug
  /** Split cleaned segments at crossings / T-junctions / axis collinear overlaps (connectivity prep). */
  wallJunctionSplit: WallJunctionSplitDebug
  /** Quantized junction graph from cleaned candidates → junction split (same as historical `wallGraph` content). */
  wallGraph: WallGraphDebugPayload
  /** Main structural wall selection on cleaned candidates (scores, sample rows). */
  mainStructuralWallSelection: MainStructuralWallSelectorDebugPayload
  /** Graph from selected main walls → junction split (compare to `wallGraph`). */
  wallGraphMainStructural: WallGraphDebugPayload
  /** Per-page breakdown. */
  pages: Array<{
    pageIndex: number
    extractionMode: ExtractedPlanPrimitives["extractionMode"]
    textCount: number
    lineCount: number
    operatorListLinesTruncated: boolean
    lineSummary: LinePrimitiveSummaryPayload
    wallCandidateFilter: {
      keptCount: number
      droppedShort: number
      droppedAngle: number
    }
  }>
  /** Raw segments (first N across pages, in order). */
  lineSampleRaw: Array<{
    pageIndex: number
    x1: number
    y1: number
    x2: number
    y2: number
    lengthPt: number
    angleClass: string
    source?: string
  }>
  /** After wall-candidate filter (same limit). */
  wallCandidateLineSample: Array<{
    pageIndex: number
    x1: number
    y1: number
    x2: number
    y2: number
    lengthPt: number
    angleClass: string
    source?: string
  }>
  /** Lightweight read on vector vs noisy PDFs (heuristic). */
  interpretationNotes: string[]
}

/** TEMPORARY — confirms server PDF pipeline ran (not image-placeholder fallback). */
export interface PdfVectorExtractionRuntime {
  /** `DOMMatrix` / `Path2D` / `ImageData` from `@napi-rs/canvas` (or already on `globalThis`). */
  globals:
    | { ok: true; source: string }
    | { ok: false; source: string; detail: string }
  /** Pages where `getOperatorList` completed without throwing */
  operatorListPagesOk: number
  /** Pages where `getTextContent` completed without throwing */
  textContentPagesOk: number
}

/** Bundle returned by the geometry-first entry point (API + orchestrator). */
export interface GeometryFirstExtractionResult {
  primitives: ExtractedPlanPrimitives[]
  /** Empty layout until wall/footprint reconstruction exists */
  layout: GeometryFirstPreciseLayout | null
  notes: string[]
  /** Geometry-first wall segments after snap/merge/dedupe + junction split (PDF units); optional until PDF path. */
  cleanedWallLines?: ExtractedLineSegment[]
  /** Junction split + graph before/after stats when PDF path runs. */
  wallJunctionSplit?: WallJunctionSplitDebug
  /** Same as `_debugGeometryFirst.wallGraph` when PDF path runs (optional convenience). */
  wallGraph?: WallGraphDebugPayload
  /** TEMPORARY — server / browser devtools only */
  _pdfVectorExtraction?: PdfVectorExtractionRuntime
  /** TEMPORARY — server / browser devtools only */
  _debugGeometryFirst?: GeometryFirstDebugPayload
}
