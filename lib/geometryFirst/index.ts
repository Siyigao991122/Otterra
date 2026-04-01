export type {
  ExtractedLineSegment,
  ExtractedPlanPrimitives,
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
