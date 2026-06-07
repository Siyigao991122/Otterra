export type {
  ExtractedLineSegment,
  ExtractedPlanPrimitives,
  FloorplanAiSemanticHintsDebug,
  ExtractedTextRun,
  GeometryFirstDebugPayload,
  MainStructuralWallGateBreakdownPayload,
  MainStructuralWallSelectorDebugPayload,
  MainStructuralWallSegmentDebugPayload,
  MainStructuralWallScoreBreakdownPayload,
  MainStructuralWallScoreDistributionPayload,
  MainStructuralWallTermAveragesPayload,
  GeometryFirstExtractionResult,
  GeometryFirstPreciseLayout,
  LinePrimitiveSummaryPayload,
  PdfVectorExtractionRuntime,
  PlanBoundingBox,
  WallCandidateCleanupDebug,
  WallGraphDebugPayload,
  WallJunctionSplitDebug,
  WallJunctionSplitGraphStats,
  OuterCycleCandidateSummary,
  OuterCycleTraceDebug,
  ExtendedStructuralRescueDebugPayload,
  ArchitecturalWallHypothesesComparePayload,
} from "@/lib/geometryFirst/types"
export { cleanupWallCandidateLines, segmentLengthPt } from "@/lib/geometryFirst/cleanupWallLines"
export {
  buildWallGraphFoundationFromCleaned,
  computeWallSegmentTopComponentRanks,
  wallGraphConnectivitySnapshot,
} from "@/lib/geometryFirst/wallGraphFoundation"
export type { WallSegmentTopComponentRank } from "@/lib/geometryFirst/wallGraphFoundation"
export { splitWallLinesAtJunctions } from "@/lib/geometryFirst/splitWallLinesAtJunctions"
export type { SplitWallLinesAtJunctionsOptions } from "@/lib/geometryFirst/splitWallLinesAtJunctions"
export { traceOuterCycleLargestComponent } from "@/lib/geometryFirst/wallGraphOuterCycle"
export type { WallGraphFoundationOptions } from "@/lib/geometryFirst/wallGraphFoundation"
export type { CleanupWallLinesOptions } from "@/lib/geometryFirst/cleanupWallLines"
export { buildGeometryFirstDebugPayload } from "@/lib/geometryFirst/debugPayload"
export {
  buildExtendedStructuralWalls,
  type ExtendedStructuralRescueOptions,
  type ExtendedStructuralWallBuildResult,
} from "@/lib/geometryFirst/extendedStructuralWalls"
export {
  extendedOnlySplitSegments,
  type RobustPlanExtentSvgOverlay,
} from "@/lib/geometryFirst/debugMainStructuralWallSvg"
export {
  buildArchitecturalWallHypothesesSvgString,
  writeArchitecturalWallHypothesesSvg,
} from "@/lib/geometryFirst/debugArchitecturalWallHypothesesSvg"
export {
  buildGlobalStructuralSpans,
  globalStructuralSpansToSvgStrokes,
} from "@/lib/geometryFirst/globalStructuralSpans"
export {
  computeRobustPlanExtent,
  ROBUST_PLAN_EXTENT_LEGACY_CLUSTER,
} from "@/lib/geometryFirst/robustPlanExtent"
export {
  deriveMainPlanBody,
  buildMainPlanBodySvgString,
  rerunPlanBodyDownstreamDebug,
} from "@/lib/geometryFirst/mainPlanBody"
export type {
  MainPlanBodyResult,
  MainPlanBodyDebugPayload,
  MainPlanBodySummary,
  MainPlanBodyOptions,
  MainPlanBodyDownstreamCompare,
  RerunMainPlanDownstreamOpts,
} from "@/lib/geometryFirst/mainPlanBody"
export {
  buildPlanBodyShellCandidate,
  buildPlanBodyShellCandidateSvgString,
  parseCleanedSegmentIndex,
} from "@/lib/geometryFirst/planBodyShellCandidate"
export type {
  PlanBodyShellCandidateDebug,
  PlanBodyShellCandidateOptions,
} from "@/lib/geometryFirst/planBodyShellCandidate"
export {
  buildPlanBodyShellLoop,
  buildPlanBodyShellLoopSvgString,
} from "@/lib/geometryFirst/planBodyShellLoop"
export type { PlanBodyShellLoopDebug, PlanBodyShellLoopOptions } from "@/lib/geometryFirst/planBodyShellLoop"
export {
  buildPlanBodyBoundaryRecoveryV2,
  buildPlanBodyBoundaryRecoveryV2SvgString,
} from "@/lib/geometryFirst/planBodyBoundaryRecoveryV2"
export type {
  BoundaryCandidateSummary,
  PlanBodyBoundaryRecoveryV2Debug,
  PlanBodyBoundaryRecoveryV2Options,
} from "@/lib/geometryFirst/planBodyBoundaryRecoveryV2"
export {
  buildPlanBodyBoundaryRecoveryV3,
  buildPlanBodyBoundaryRecoveryV3SvgString,
} from "@/lib/geometryFirst/planBodyBoundaryRecoveryV3"
export type {
  LocalizedSideGapV3,
  PlanBodyBoundaryRecoveryV3Debug,
} from "@/lib/geometryFirst/planBodyBoundaryRecoveryV3"
export {
  buildPlanBodyShellRegularization,
  buildPlanBodyShellRegularizationSvgString,
} from "@/lib/geometryFirst/planBodyShellRegularization"
export type {
  PlanBodyShellRegularizationDebug,
  RegularizedEdgeDebug,
} from "@/lib/geometryFirst/planBodyShellRegularization"
export {
  buildPlanBodyShellEvidenceGating,
  buildPlanBodyShellEvidenceGatingSvgString,
} from "@/lib/geometryFirst/planBodyShellEvidenceGating"
export type {
  ExtrusionGatingVerdict,
  PlanBodyShellEvidenceGatingDebug,
  ShellEdgeConfidenceClass,
  ShellEdgeEvidenceRow,
  ShellEdgeRunKind,
  ShellEdgeRunSummary,
  ShellEvidenceStrengtheningDebug,
} from "@/lib/geometryFirst/planBodyShellEvidenceGating"
export {
  buildPlanBodyRoomCandidatesV0,
  buildPlanBodyRoomCandidatesV0SvgString,
  getRoomCandidatesV0UnitPolygonForSvg,
} from "@/lib/geometryFirst/planBodyRoomCandidatesV0"
export type {
  PlanBodyRoomCandidatesV0Debug,
  RoomCandidateSourceV0,
  RoomCandidateV0,
} from "@/lib/geometryFirst/planBodyRoomCandidatesV0"
export {
  buildPlanBodyRoomCandidatesCleanupV1,
  buildPlanBodyRoomCandidatesCleanupV1SvgString,
} from "@/lib/geometryFirst/planBodyRoomCandidatesCleanupV1"
export type {
  PlanBodyRoomCandidatesCleanupV1Debug,
  RoomBarrierDebugV1,
  RoomBarrierKindV1,
} from "@/lib/geometryFirst/planBodyRoomCandidatesCleanupV1"
export {
  buildPlanBodyRoomSplitRefinementV2,
  buildPlanBodyRoomSplitRefinementV2SvgString,
} from "@/lib/geometryFirst/planBodyRoomSplitRefinementV2"
export type {
  PlanBodyRoomSplitRefinementV2Debug,
  RejectedSplitProposalV2,
  RoomBarrierFamilyV2,
  RoomSplitProposalDebugV2,
} from "@/lib/geometryFirst/planBodyRoomSplitRefinementV2"
export {
  buildPlanBodyRoomSplitRefinementV3,
  buildPlanBodyRoomSplitRefinementV3SvgString,
} from "@/lib/geometryFirst/planBodyRoomSplitRefinementV3"
export type {
  CutBandDebugV3,
  PlanBodyRoomSplitRefinementV3Debug,
  RegionQualitySummaryV3,
  RejectedProposalOverlayV3,
  TextSpreadSummaryV3,
} from "@/lib/geometryFirst/planBodyRoomSplitRefinementV3"
export {
  buildPlanBodyRoomCandidateRefinementV1,
  buildPlanBodyRoomCandidateRefinementV1SvgString,
} from "@/lib/geometryFirst/planBodyRoomCandidateRefinementV1"
export type {
  PlanBodyRoomCandidateRefinementV1Debug,
  RefinedRoomCandidateQualityV1,
  RoomAdjacencyEdgeV1,
  RoomAdjacencyGraphV1,
  RoomCandidateConfidenceTierV1,
} from "@/lib/geometryFirst/planBodyRoomCandidateRefinementV1"
export {
  buildPlanBodyRoomTextAttributionV0,
  buildPlanBodyRoomTextAttributionV0SvgString,
  classifyPlanTextAnchorKindV0,
} from "@/lib/geometryFirst/planBodyRoomTextAttributionV0"
export type {
  RegionInterpretationRowV0,
  RegionTextAssignmentRowV0,
  RoomTextAttributionV0Debug,
  TextAnchorKindV0,
  TextToRegionAssignmentV0,
  UnassignedTextAnchorV0,
} from "@/lib/geometryFirst/planBodyRoomTextAttributionV0"
export {
  buildPlanBodyRoomTextGroupingV1,
  buildPlanBodyRoomTextGroupingV1SvgString,
  buildPlanBodyTextLabelGroupsFromRunsV1,
} from "@/lib/geometryFirst/planBodyRoomTextGroupingV1"
export type {
  GroupedLabelToRegionAssignmentV1,
  GroupedPlanTextLabelV1,
  RoomTextGroupingV1Debug,
  UnassignedGroupedLabelV1,
} from "@/lib/geometryFirst/planBodyRoomTextGroupingV1"
export {
  buildPlanBodySemanticGuidedRoomPartitionV1,
  buildPlanBodySemanticGuidedRoomPartitionV1SvgString,
  extractMajorRoomAnchorsForPartitionV1,
} from "@/lib/geometryFirst/planBodySemanticGuidedRoomPartitionV1"
export type {
  AuxiliarySubspaceAttachmentV1,
  MajorRoomAnchorV1,
  SemanticGuidedRoomPartitionV1Debug,
  SemanticRoomProposalV1,
} from "@/lib/geometryFirst/planBodySemanticGuidedRoomPartitionV1"
export {
  buildPlanBodyTextCoverageRecoveryV2,
  buildPlanBodyTextCoverageRecoveryV2SvgString,
} from "@/lib/geometryFirst/planBodyTextCoverageRecoveryV2"
export type {
  PlanBodyTextCoverageRecoveryV2Debug,
  RecoveredMajorLabelV2,
} from "@/lib/geometryFirst/planBodyTextCoverageRecoveryV2"
export {
  buildPlanBodyProposalTopologyCleanupV1,
  buildPlanBodyProposalTopologyCleanupV1SvgString,
} from "@/lib/geometryFirst/planBodyProposalTopologyCleanupV1"
export type {
  CleanedRoomProposalV1,
  OverlapPairReductionV1,
  ProposalTopologyCleanupV1Debug,
  WallSnapSummaryV1,
} from "@/lib/geometryFirst/planBodyProposalTopologyCleanupV1"
export {
  buildPlanBodyAnchorConstrainedRegionGrowingV2,
  buildPlanBodyAnchorConstrainedRegionGrowingV2SvgString,
} from "@/lib/geometryFirst/planBodyAnchorConstrainedRegionGrowingV2"
export type {
  AnchorConstrainedRegionGrowingV2Debug,
  BarrierUseSummaryGrowingV2,
  GrownRoomProposalV2,
  OpeningRelaxationSummaryGrowingV2,
} from "@/lib/geometryFirst/planBodyAnchorConstrainedRegionGrowingV2"
export {
  buildPlanBodyAnchorSeedLocalizationV1,
  buildPlanBodyAnchorSeedLocalizationV1SvgString,
  localizedSeedPointByAnchorId,
} from "@/lib/geometryFirst/planBodyAnchorSeedLocalizationV1"
export type {
  AnchorSeedLocalizationV1Debug,
  LocalizedAnchorSeedV1,
  LocalizedSeedModeV1,
} from "@/lib/geometryFirst/planBodyAnchorSeedLocalizationV1"
export {
  buildPlanBodyHierarchicalSpaceTypingV1,
  buildPlanBodyHierarchicalSpaceTypingV1SvgString,
  structuralMajorSubtypeV1,
} from "@/lib/geometryFirst/planBodyHierarchicalSpaceTypingV1"
export type {
  HierarchicalSpaceTypingV2Debug,
  RecoveredMajorInfo,
  BuildPlanBodyHierarchicalSpaceTypingV2SvgOptions,
} from "@/lib/geometryFirst/planBodyHierarchicalSpaceTypingV2"
export {
  buildPlanBodyHierarchicalSpaceTypingV2,
  buildPlanBodyHierarchicalSpaceTypingV2SvgString,
} from "@/lib/geometryFirst/planBodyHierarchicalSpaceTypingV2"
export type {
  UnitOuterBoundaryRecoveryV1Debug,
  ExcludedBlankRegionV1,
  BuildUnitOuterBoundaryRecoveryV1SvgOptions,
} from "@/lib/geometryFirst/unitOuterBoundaryRecoveryV1"
export {
  buildUnitOuterBoundaryRecoveryV1,
  buildUnitOuterBoundaryRecoveryV1SvgString,
} from "@/lib/geometryFirst/unitOuterBoundaryRecoveryV1"
export type {
  UnitOuterBoundaryRefinementV2Debug,
  BuildUnitOuterBoundaryRefinementV2SvgOptions,
} from "@/lib/geometryFirst/unitOuterBoundaryRefinementV2"
export {
  buildUnitOuterBoundaryRefinementV2,
  buildUnitOuterBoundaryRefinementV2SvgString,
} from "@/lib/geometryFirst/unitOuterBoundaryRefinementV2"
export type {
  UnitOuterBoundaryRefinementV3Debug,
  BuildUnitOuterBoundaryRefinementV3SvgOptions,
} from "@/lib/geometryFirst/unitOuterBoundaryRefinementV3"
export {
  buildUnitOuterBoundaryRefinementV3,
  buildUnitOuterBoundaryRefinementV3SvgString,
} from "@/lib/geometryFirst/unitOuterBoundaryRefinementV3"
export type {
  ExteriorEvidenceSelectorV1Debug,
  ExteriorEvidenceSelectorSegment,
  ExteriorEvidenceSelectorHypothesis,
  ExteriorEvidenceSelectorSpan,
  BuildExteriorEvidenceSelectorV1SvgOptions,
} from "@/lib/geometryFirst/exteriorEvidenceSelectorV1"
export {
  buildExteriorEvidenceSelectorV1,
  buildExteriorEvidenceSelectorV1SvgString,
} from "@/lib/geometryFirst/exteriorEvidenceSelectorV1"
export type {
  GrayWallMassReconstructionV1Debug,
  GrayWallMassComponentV1,
  GrayWallBandV1,
  GrayWallRoomVoidV1,
  BuildGrayWallMassReconstructionV1Options,
  BuildGrayWallMassReconstructionV1SvgOptions,
} from "@/lib/geometryFirst/grayWallMassReconstructionV1"
export {
  buildGrayWallMassReconstructionV1,
  buildGrayWallMassReconstructionV1SvgString,
  buildGrayWallMassThresholdPreviewPng,
} from "@/lib/geometryFirst/grayWallMassReconstructionV1"
export type {
  StructuralLineRecoveryV1Debug,
  StructuralRecoveredRunV1,
  StructuralClosedLoopV1,
  StructuralMissingLineCandidateV1,
  BuildStructuralLineRecoveryV1SvgOptions,
} from "@/lib/geometryFirst/structuralLineRecoveryV1"
export {
  buildStructuralLineRecoveryV1,
  buildStructuralLineRecoveryV1SvgString,
} from "@/lib/geometryFirst/structuralLineRecoveryV1"
export type {
  RoomLineFaithfulReconstructionV1Debug,
  RoomLineFaithfulWallRun,
  RoomLineFaithfulWallClass,
  BuildRoomLineFaithfulReconstructionV1SvgOptions,
} from "@/lib/geometryFirst/roomLineFaithfulReconstructionV1"
export {
  buildRoomLineFaithfulReconstructionV1,
  buildRoomLineFaithfulReconstructionV1SvgString,
} from "@/lib/geometryFirst/roomLineFaithfulReconstructionV1"
export type {
  ApartmentLayoutPartitionV1Debug,
  ApartmentLayoutRegionV1,
  BuildApartmentLayoutPartitionV1SvgOptions,
} from "@/lib/geometryFirst/apartmentLayoutPartitionV1"
export {
  buildApartmentLayoutPartitionV1,
  buildApartmentLayoutPartitionV1SvgString,
} from "@/lib/geometryFirst/apartmentLayoutPartitionV1"
export type {
  RoomBoundedWallTopologyV1Debug,
  RoomTopologyV1,
  RoomTopologyBoundaryEdgeV1,
  BuildRoomBoundedWallTopologyV1SvgOptions,
} from "@/lib/geometryFirst/roomBoundedWallTopologyV1"
export {
  buildRoomBoundedWallTopologyV1,
  buildRoomBoundedWallTopologyV1SvgString,
} from "@/lib/geometryFirst/roomBoundedWallTopologyV1"
export type {
  AuxiliaryAnchorRefV1,
  EnclosedRoomCandidateV1,
  EnclosedRoomCandidateSourceV1,
  HierarchicalSpaceTypingV1Debug,
  OpenPlanEnvelopeCandidateV1,
  OpenPlanSubzoneAssignmentV1,
} from "@/lib/geometryFirst/planBodyHierarchicalSpaceTypingV1"
export { computeDrawingClusterDiagnostics } from "@/lib/geometryFirst/drawingClusterDiagnostics"
export type {
  DrawingClusterDiagnosticsDebugPayload,
  DrawingClusterDiagnosticsOptions,
  DrawingClusterDiagnosticsResult,
  DrawingClusterDiagnosticsSummary,
  DrawingClusterExcludedLongRow,
  DrawingClusterDiagnosticsSvgOverlay,
} from "@/lib/geometryFirst/drawingClusterDiagnostics"
export type {
  RobustPlanExtentDebugPayload,
  RobustPlanExtentOptions,
  RobustPlanExtentOutlierDetail,
  RobustPlanExtentResult,
  RobustPlanExtentSummary,
  RobustOutlierReason,
} from "@/lib/geometryFirst/robustPlanExtent"
export type {
  BuildGlobalStructuralSpansOptions,
  GlobalStructuralSpan,
  GlobalStructuralSpanOrientation,
  GlobalStructuralSpansDebugPayload,
  GlobalStructuralSpansDebugSummary,
  GlobalStructuralSpanSvgStroke,
} from "@/lib/geometryFirst/globalStructuralSpans"
export type {
  ArchitecturalWallHypothesesSvgDebugInput,
  ArchitecturalWallHypothesesSvgWriteOptions,
} from "@/lib/geometryFirst/debugArchitecturalWallHypothesesSvg"
export {
  buildArchitecturalWallHypotheses,
  wallHypothesesToSvgStrokes,
  segmentsNearlyEqual,
} from "@/lib/geometryFirst/architecturalWallHypotheses"
export type {
  ArchitecturalWallHypothesis,
  ArchitecturalWallHypothesesDebugPayload,
  ArchitecturalWallHypothesesDebugSummary,
  BuildArchitecturalWallHypothesesOptions,
  WallHypothesisCenterline,
  WallHypothesisOrientation,
  WallHypothesisSupportType,
  WallHypothesisSvgStroke,
} from "@/lib/geometryFirst/architecturalWallHypotheses"
export {
  selectMainStructuralWalls,
  type MainStructuralWallGateBreakdown,
  type MainStructuralWallSelectorOptions,
  type MainStructuralWallSelectorResult,
  type MainStructuralWallSegmentDebug,
  type MainStructuralWallScoreBreakdown,
  type MainStructuralWallScoreDistribution,
  type MainStructuralWallTermAverages,
} from "@/lib/geometryFirst/mainStructuralWallSelector"
export { extractPdfVectorPrimitives } from "@/lib/geometryFirst/extractPdfVectorPrimitives"
export {
  filterWallCandidateLines,
  segmentAngleClass,
  segmentLengthPdfUnits,
  summarizeLinePrimitives,
} from "@/lib/geometryFirst/linePrimitiveDenoise"
export type {
  LinePrimitiveSummary,
  WallCandidateAngleMode,
  WallCandidateFilterStats,
} from "@/lib/geometryFirst/linePrimitiveDenoise"
export { runGeometryFirstExtraction } from "@/lib/geometryFirst/extractPlanPrimitives"
export {
  buildFloorplanAiSemanticHints,
  buildFloorplanAiSemanticHintsOverlaySvgString,
  buildFloorplanAiSemanticHintsResult,
  renderPdfPageForAiSemanticHints,
} from "@/lib/geometryFirst/floorplanAiSemanticHints"