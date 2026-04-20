/**
 * Geometry-first floorplan pipeline (PDF/CV primitives → precise layout).
 * Parallel to model-first `FloorPlanAnalysis` / `sanitizeFloorplanGeometry`.
 */

import type {
  FloorplanPoint2D,
  FloorplanRoomZone,
  FloorplanWallSegment,
} from "@/lib/types"

/**
 * Axis-aligned box in **pdf.js viewport / page space** (same as `getViewport({ scale: 1 })`:
 * origin top-left, Y increasing downward), in PDF points × scale.
 */
export interface PlanBoundingBox {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** One-page debug: raw vs normalized bboxes and viewport transform (pdf.js coordinate fix). */
export interface PdfPageCoordinateNormalizationDebug {
  /** `PageViewport.transform` — maps PDF user-space points to viewport/page space. */
  viewportTransform: [number, number, number, number, number, number]
  pageBounds: PlanBoundingBox
  linesBBoxPdfUserSpace: PlanBoundingBox | null
  linesBBoxViewport: PlanBoundingBox | null
  textsBBoxPdfUserSpace: PlanBoundingBox | null
  textsBBoxViewport: PlanBoundingBox | null
  lineSegmentCount: number
  /** Fraction of segments whose midpoint lies in `pageBounds` expanded by ±48 pt. */
  segmentMidInsidePageExpandedFraction: number
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
  /**
   * When PDF vector extraction ran: compares line/text bboxes before vs after viewport normalization.
   */
  coordinateNormalizationDebug?: PdfPageCoordinateNormalizationDebug
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
  /**
   * When `closed`, full walk vertices in embedding order (debug / SVG). Omitted or truncated when very long.
   */
  fullVertexCycle?: Array<{ x: number; y: number }>
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

/** Debug stats for `buildExtendedStructuralWalls` (high-recall structural set). */
export interface ExtendedStructuralRescueDebugPayload {
  optionsUsed: {
    rescueLongSingletons: boolean
    rescueMinLengthPt: number
    rescueEnvelopeProximityPt: number
    rescueIfTouchesOuterBand: boolean
    rescueIfInLargeSpanLocalGroup: boolean
    rescueLocalGroupRadiusPt: number
    rescueLocalGroupMinSpanPt: number
    rescueSingletonMaxParallelGapPt: number
    minOverlapForNeighbor: number
    parallelAngleDeg: number
  }
  strictSegmentCount: number
  extendedSegmentCount: number
  extendedOnlySegmentCount: number
  /** Rule hit counts — one segment may increment multiple buckets if it satisfies several rules. */
  ruleHitCounts: {
    longHVSingleton: number
    outerBand: number
    largeSpanLocalGroup: number
  }
}

/** Side-by-side summary of wall hypotheses built from strict vs extended structural picks. */
export interface ArchitecturalWallHypothesesComparePayload {
  strict: {
    totalHypotheses: number
    pairedCount: number
    mergedRunCount: number
    singletonCount: number
    averageThicknessEstimate: number | null
  }
  extended: {
    totalHypotheses: number
    pairedCount: number
    mergedRunCount: number
    singletonCount: number
    averageThicknessEstimate: number | null
  }
  delta: {
    totalHypotheses: number
    pairedCount: number
    mergedRunCount: number
    singletonCount: number
  }
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

export interface FloorplanAiSemanticHintsDebug {
  pageType: string
  unitOutlineHint: {
    renderedImageVertices: Array<{ x: number; y: number }>
    pdfPageVertices: Array<{ x: number; y: number }>
    confidence: number
    notes?: string
  }
  majorSpaces: Array<{
    label: string
    spaceType: "enclosed_room" | "open_plan_subzone"
    renderedImagePolygon: Array<{ x: number; y: number }>
    pdfPagePolygon: Array<{ x: number; y: number }>
    confidence: number
  }>
  sharedOpenPlanEnvelopes: Array<{
    memberLabels: string[]
    renderedImagePolygon: Array<{ x: number; y: number }>
    pdfPagePolygon: Array<{ x: number; y: number }>
    confidence: number
  }>
  auxiliarySpaces: Array<{
    label: string
    renderedImagePolygon: Array<{ x: number; y: number }>
    pdfPagePolygon: Array<{ x: number; y: number }>
    confidence: number
  }>
  notes: string[]
  modelUsed: string
  renderPx: { width: number; height: number }
  cropRectPx?: { x: number; y: number; width: number; height: number }
  latencyMs: number
  passAResponse?: string
  passBResponse?: string
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
  /** Graph from extended structural set (strict + rescued) → junction split — debug / recall. */
  wallGraphExtendedMainStructural?: WallGraphDebugPayload
  /** How extended structural walls were assembled from strict + rescue rules. */
  extendedStructuralWallRescue?: ExtendedStructuralRescueDebugPayload
  /**
   * Experimental: architectural wall hypotheses from **strict** main walls only (high precision).
   */
  architecturalWallHypotheses?: import("@/lib/geometryFirst/architecturalWallHypotheses").ArchitecturalWallHypothesesDebugPayload
  /**
   * Same hypothesis builder fed **extended** structural walls (strict ∪ rescues) — higher recall input.
   */
  architecturalWallHypothesesExtended?: import("@/lib/geometryFirst/architecturalWallHypotheses").ArchitecturalWallHypothesesDebugPayload
  /** Quick strict vs extended hypothesis counts (paired / merged / singleton / thickness). */
  architecturalWallHypothesesCompare?: ArchitecturalWallHypothesesComparePayload
  /**
   * Experimental: layout-scale axis spans from cleaned candidates (collinear merge + envelope / shell hints).
   * Does not select an exterior shell — debug signal only.
   */
  globalStructuralSpans?: import("@/lib/geometryFirst/globalStructuralSpans").GlobalStructuralSpansDebugPayload
  /**
   * Robust plan extent / stroke hygiene (debug): percentile + page ∩ + optional main-cluster tighten;
   * inlier vs outlier splits for span scoring and SVG overlays.
   */
  robustPlanExtent?: import("@/lib/geometryFirst/robustPlanExtent").RobustPlanExtentDebugPayload
  /**
   * Drawing-cluster / core coverage diagnostics: why robust core shrank, exclusion rule hits,
   * long excluded strokes — see `interpretationNotes` and SVG overlay fields.
   */
  drawingClusterDiagnostics?: import("@/lib/geometryFirst/drawingClusterDiagnostics").DrawingClusterDiagnosticsDebugPayload
  /**
   * Experimental: brochure vs plan separation — largest coherent plan body bbox from hypotheses + spans + strokes.
   * Populated only when `debug.includeMainPlanBody` is true on the API / builder.
   */
  mainPlanBody?: import("@/lib/geometryFirst/mainPlanBody").MainPlanBodyDebugPayload
  /** SVG overlay: dim non-plan segments, stroke primary bbox (same coordinates as page). */
  mainPlanBodySvg?: string
  /** Wall hypotheses + global spans recomputed inside `mainPlanBody.primaryLayoutBBox` only. */
  mainPlanBodyDownstream?: import("@/lib/geometryFirst/mainPlanBody").MainPlanBodyDownstreamCompare
  /**
   * Debug: coarse exterior-shell candidate from plan-only hypotheses/spans (not production).
   * Present when `includeMainPlanBody` is true.
   */
  mainPlanBodyShellCandidate?: import("@/lib/geometryFirst/planBodyShellCandidate").PlanBodyShellCandidateDebug
  /** Debug SVG: primary bbox, plan-only hyps/spans, shell highlight. */
  mainPlanBodyShellCandidateSvg?: string
  /** Debug: left-face outer loop recovery on plan-only shell graph (+ optional span/hyp augmentation). */
  mainPlanBodyShellLoop?: import("@/lib/geometryFirst/planBodyShellLoop").PlanBodyShellLoopDebug
  /** Debug SVG: primary bbox, faint plan hyps/spans, shell edges, recovered loops, weak-side labels. */
  mainPlanBodyShellLoopSvg?: string
  /**
   * Debug-only: plan-only **boundary recovery v2** — concave-aware exterior boundary candidates after
   * shell loop (does not replace shell loop; not production).
   */
  mainPlanBodyBoundaryRecoveryV2?: import("@/lib/geometryFirst/planBodyBoundaryRecoveryV2").PlanBodyBoundaryRecoveryV2Debug
  /** Debug SVG: bbox, shell edges, open trace, gap zones, bridges, boundary candidates, hull compare. */
  mainPlanBodyBoundaryRecoveryV2Svg?: string
  /**
   * Debug-only: **targeted right/bottom gap recovery v3** after v2 (local bridges only; not production).
   */
  mainPlanBodyBoundaryRecoveryV3?: import("@/lib/geometryFirst/planBodyBoundaryRecoveryV3").PlanBodyBoundaryRecoveryV3Debug
  /** Debug SVG: localized R/B gap zones, v3 bridges, v3 best boundary, remaining gaps, v2 reference. */
  mainPlanBodyBoundaryRecoveryV3Svg?: string
  /**
   * Debug-only: **shell regularization** of the v3 best boundary (simplified/stabilized polygon; not production extrusion).
   */
  mainPlanBodyShellRegularization?: import("@/lib/geometryFirst/planBodyShellRegularization").PlanBodyShellRegularizationDebug
  /** Debug SVG: candidate vs regularized polygon, micro cleanups, gap/synthetic/ambiguous edge highlights. */
  mainPlanBodyShellRegularizationSvg?: string
  /**
   * Debug-only: **shell evidence strengthening / confidence gating** (edge classification, trusted runs,
   * perimeter fractions, conservative extrusion verdict). Also callable `shellEvidenceStrengthening` in docs.
   */
  mainPlanBodyShellEvidenceGating?: import("@/lib/geometryFirst/planBodyShellEvidenceGating").PlanBodyShellEvidenceGatingDebug
  /** Debug SVG: regularized shell edges colored by trusted / ambiguous / synthetic; weak zones. */
  mainPlanBodyShellEvidenceGatingSvg?: string
  /**
   * Debug-only: **room candidate extraction v0** (raster CV + geometry cycles + fusion inside unit boundary).
   */
  mainPlanBodyRoomCandidatesV0?: import("@/lib/geometryFirst/planBodyRoomCandidatesV0").PlanBodyRoomCandidatesV0Debug
  /** Debug SVG: unit boundary, CV/geo/fused room regions, confidence fills. */
  mainPlanBodyRoomCandidatesV0Svg?: string
  /**
   * Debug-only: **room candidate cleanup / splitting v1** — barrier-aware splitting of oversized
   * CV-scale blobs into conservative sub-regions (no semantic labels; not production).
   */
  mainPlanBodyRoomCandidatesCleanupV1?: import("@/lib/geometryFirst/planBodyRoomCandidatesCleanupV1").PlanBodyRoomCandidatesCleanupV1Debug
  /** Debug SVG: faint v0 oversized blob, split barriers, sub-room candidates, weak rejects. */
  mainPlanBodyRoomCandidatesCleanupV1Svg?: string
  /**
   * Debug-only: **room split refinement v2** — grouped barrier families + multi-cue raster splits
   * for oversized blobs (after cleanup v1; not production).
   */
  mainPlanBodyRoomSplitRefinementV2?: import("@/lib/geometryFirst/planBodyRoomSplitRefinementV2").PlanBodyRoomSplitRefinementV2Debug
  /** Debug SVG: barrier families, accepted splits, v2 sub-regions, rejected proposals. */
  mainPlanBodyRoomSplitRefinementV2Svg?: string
  /**
   * Debug-only: **room split refinement v3** — direct cut bands + relaxed area gates + text-spread
   * acceptance (consumes v2 families; not production).
   */
  mainPlanBodyRoomSplitRefinementV3?: import("@/lib/geometryFirst/planBodyRoomSplitRefinementV3").PlanBodyRoomSplitRefinementV3Debug
  /** Debug SVG: cut bands, anchors, family overlays, v3 regions. */
  mainPlanBodyRoomSplitRefinementV3Svg?: string
  /**
   * Debug-only: **room candidate refinement / adjacency cleanup v1** after split v3 (adjacency, snaps,
   * conservative merge/split; not semantic labels; not production).
   */
  mainPlanBodyRoomCandidateRefinementV1?: import("@/lib/geometryFirst/planBodyRoomCandidateRefinementV1").PlanBodyRoomCandidateRefinementV1Debug
  /** Debug SVG: faint v3 regions, refined fills, adjacency links, snap segments, text anchors. */
  mainPlanBodyRoomCandidateRefinementV1Svg?: string
  /**
   * Debug-only: **room text attribution / hierarchical room typing v0** — map `primaryLayoutTextBoxes`
   * to refined candidates (major vs auxiliary vs mixed; not final labels).
   */
  roomTextAttributionV0?: import("@/lib/geometryFirst/planBodyRoomTextAttributionV0").RoomTextAttributionV0Debug
  /** Debug SVG: refined regions, text with region ids, mixed/aux styling. */
  roomTextAttributionV0Svg?: string
  /**
   * Debug-only: **major-label coverage recovery / text grouping v1** — cluster nearby brochure strings,
   * re-assign to refined regions, refresh interpretation (after attribution v0).
   */
  roomTextGroupingV1?: import("@/lib/geometryFirst/planBodyRoomTextGroupingV1").RoomTextGroupingV1Debug
  /** Debug SVG: grouped multi-run boxes, merged labels vs v0 major counts. */
  roomTextGroupingV1Svg?: string
  /**
   * Debug-only: **semantic-guided room partition v1** — major-anchor Voronoi + wall penalties inside unit;
   * auxiliary attachments secondary (after text grouping v1).
   */
  semanticGuidedRoomPartitionV1?: import("@/lib/geometryFirst/planBodySemanticGuidedRoomPartitionV1").SemanticGuidedRoomPartitionV1Debug
  /** Debug SVG: faint coarse regions, new proposals, major anchors, auxiliary links. */
  semanticGuidedRoomPartitionV1Svg?: string
  /**
   * Debug-only: **plan-body text coverage recovery v2** — broaden floor-plan text inclusion + grouping
   * counts vs primary bbox; feeds attribution/grouping (not production `deriveMainPlanBody`).
   */
  planBodyTextCoverageRecoveryV2?: import("@/lib/geometryFirst/planBodyTextCoverageRecoveryV2").PlanBodyTextCoverageRecoveryV2Debug
  /** Debug SVG: all expanded runs, grouped majors, recovered / missing checklist. */
  planBodyTextCoverageRecoveryV2Svg?: string
  /**
   * Debug-only: **proposal-to-wall topology cleanup v1** — wall-constrained semantic room/zone proposals
   * (grid + barrier penalties; not coarse-quadrant structurally; not production).
   */
  proposalTopologyCleanupV1?: import("@/lib/geometryFirst/planBodyProposalTopologyCleanupV1").ProposalTopologyCleanupV1Debug
  /** Debug SVG: faint coarse regions, wall evidence, dashed raw vs solid cleaned proposals, overlap conflicts. */
  proposalTopologyCleanupV1Svg?: string
  /**
   * Debug-only: **anchor-to-wall constrained region growing v2** — seeded multi-source growth with
   * barrier-weighted edges and opening relaxation (not production).
   */
  anchorConstrainedRegionGrowingV2?: import("@/lib/geometryFirst/planBodyAnchorConstrainedRegionGrowingV2").AnchorConstrainedRegionGrowingV2Debug
  /** Debug SVG: faint cleaned proposals, strong vs opening-soft barriers, grown regions, conflict zones, anchors. */
  anchorConstrainedRegionGrowingV2Svg?: string
  /**
   * Debug-only: **anchor seed localization v1** — local windows, barrier-bounded pockets, seed patches
   * before region growing (not production).
   */
  anchorSeedLocalizationV1?: import("@/lib/geometryFirst/planBodyAnchorSeedLocalizationV1").AnchorSeedLocalizationV1Debug
  /** Debug SVG: search windows, cores, seed patches, original vs localized seeds (fallback/failed styling). */
  anchorSeedLocalizationV1Svg?: string
  /**
   * Debug-only: **hierarchical space typing v1** — enclosed vs open-plan subzones vs auxiliary;
   * enclosed candidates + shared open-plan envelope (not production).
   */
  hierarchicalSpaceTypingV1?: import("@/lib/geometryFirst/planBodyHierarchicalSpaceTypingV1").HierarchicalSpaceTypingV1Debug
  /** Debug SVG: enclosed polygons, open-plan envelope, typed anchors, auxiliary labels. */
  hierarchicalSpaceTypingV1Svg?: string
  /**
   * Debug-only: hierarchical space typing v2 — refines v1 by recovering missing majors (e.g. BEDROOM 2),
   * tightening the open-plan envelope via barrier-aware trimming, and expanding enclosed candidates (not production).
   */
  hierarchicalSpaceTypingV2?: import("@/lib/geometryFirst/planBodyHierarchicalSpaceTypingV2").HierarchicalSpaceTypingV2Debug
  /** Debug SVG: v2 enclosed polygons, trimmed envelope, recovered anchors, v1 envelope ghost. */
  hierarchicalSpaceTypingV2Svg?: string
  /**
   * Debug-only: unit outer boundary recovery v1 — recovers the true apartment shell by
   * rasterizing all segments, seeding from room labels, and flood-filling interior space (not production).
   */
  unitOuterBoundaryRecoveryV1?: import("@/lib/geometryFirst/unitOuterBoundaryRecoveryV1").UnitOuterBoundaryRecoveryV1Debug
  /** Debug SVG: recovered apartment boundary, previous oversized unit ghost, excluded blank areas, wall segments. */
  unitOuterBoundaryRecoveryV1Svg?: string
  /**
   * Debug-only: unit outer boundary refinement v2 — evidence-guided shell refinement after v1 using
   * plan-only walls / spans and optional AI shape prior (not production).
   */
  unitOuterBoundaryRefinementV2?: import("@/lib/geometryFirst/unitOuterBoundaryRefinementV2").UnitOuterBoundaryRefinementV2Debug
  /** Debug SVG: v1 shell ghost, refined shell, exterior wall evidence, AI hint, add/trim bands. */
  unitOuterBoundaryRefinementV2Svg?: string
  /**
   * Debug-only: unit outer boundary refinement v3 — exterior-only shell cleanup / simplification after v2
   * to produce a cleaner architectural outer wall container (not production).
   */
  unitOuterBoundaryRefinementV3?: import("@/lib/geometryFirst/unitOuterBoundaryRefinementV3").UnitOuterBoundaryRefinementV3Debug
  /** Debug SVG: v1/v2 shells ghosted, v3 shell highlighted, exterior evidence and noisy trimmed bands. */
  unitOuterBoundaryRefinementV3Svg?: string
  /**
   * Debug-only: exterior evidence selector v1 — scores plan segments / hypotheses / spans for likelihood
   * of belonging to the true apartment outer boundary (not production).
   */
  exteriorEvidenceSelectorV1?: import("@/lib/geometryFirst/exteriorEvidenceSelectorV1").ExteriorEvidenceSelectorV1Debug
  /** Debug SVG: current shell ghost, selected exterior evidence highlighted, rejected interior-like evidence faintly. */
  exteriorEvidenceSelectorV1Svg?: string
  /**
   * Debug-only: gray wall mass reconstruction v1 — rasterizes the rendered brochure page, isolates darker
   * wall fill regions, and converts them back into mask-derived wall geometry / room voids (not production).
   */
  grayWallMassReconstructionV1?: import("@/lib/geometryFirst/grayWallMassReconstructionV1").GrayWallMassReconstructionV1Debug
  /** Debug SVG: darker wall-mass components, mask-derived wall segments, and interior void regions. */
  grayWallMassReconstructionV1Svg?: string
  /**
   * Debug-only: structural line recovery v1 — suppresses likely furniture strokes, reconnects structural
   * wall lines, and selectively backfills missing PDF-derived structural segments (not production).
   */
  structuralLineRecoveryV1?: import("@/lib/geometryFirst/structuralLineRecoveryV1").StructuralLineRecoveryV1Debug
  /** Debug SVG: original lines, filtered furniture-like strokes, recovered structural network, and backfills. */
  structuralLineRecoveryV1Svg?: string
  /**
   * Debug-only: room-line faithful vector reconstruction v1 — merges cleaned PDF wall-like segments into
   * longer wall runs and classifies exterior/interior/opening/uncertain line structure (not production).
   */
  roomLineFaithfulReconstructionV1?: import("@/lib/geometryFirst/roomLineFaithfulReconstructionV1").RoomLineFaithfulReconstructionV1Debug
  /** Debug SVG: faithful wall-line reconstruction with exterior/interior/opening/uncertain styling. */
  roomLineFaithfulReconstructionV1Svg?: string
  /**
   * Debug-only: apartment layout partition v1 — partitions the authoritative unit shell into wall-driven
   * room/subzone regions before final room-topology binding (not production).
   */
  apartmentLayoutPartitionV1?: import("@/lib/geometryFirst/apartmentLayoutPartitionV1").ApartmentLayoutPartitionV1Debug
  /** Debug SVG: wall-driven layout regions before room topology binding. */
  apartmentLayoutPartitionV1Svg?: string
  /**
   * Debug-only: room-bounded wall topology v1 — groups faithful wall runs into room-level wall structure
   * with openings/shared walls/uncertain edges using room labels and open-plan hints (not production).
   */
  roomBoundedWallTopologyV1?: import("@/lib/geometryFirst/roomBoundedWallTopologyV1").RoomBoundedWallTopologyV1Debug
  /** Debug SVG: walls grouped by room, openings highlighted, shared walls marked, uncertain edges faint. */
  roomBoundedWallTopologyV1Svg?: string
  /** Debug-only: AI semantic hints from brochure-style floorplan vision analysis. */
  aiSemanticHints?: FloorplanAiSemanticHintsDebug
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
