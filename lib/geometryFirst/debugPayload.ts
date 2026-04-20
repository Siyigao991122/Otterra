/**
 * Builds `_debugGeometryFirst` for POST /api/floorplan-geometry-first (TEMPORARY).
 */

import { cleanupWallCandidateLines, segmentLengthPt } from "@/lib/geometryFirst/cleanupWallLines"
import type {
  ArchitecturalWallHypothesesComparePayload,
  ExtractedPlanPrimitives,
  ExtendedStructuralRescueDebugPayload,
  FloorplanAiSemanticHintsDebug,
  GeometryFirstDebugPayload,
  MainStructuralWallSegmentDebugPayload,
  MainStructuralWallSelectorDebugPayload,
  PlanBoundingBox,
} from "@/lib/geometryFirst/types"
import { buildExtendedStructuralWalls } from "@/lib/geometryFirst/extendedStructuralWalls"
import type { ExtendedStructuralRescueOptions } from "@/lib/geometryFirst/extendedStructuralWalls"
import {
  buildWallGraphFoundationFromCleaned,
  wallGraphConnectivitySnapshot,
} from "@/lib/geometryFirst/wallGraphFoundation"
import { selectMainStructuralWalls } from "@/lib/geometryFirst/mainStructuralWallSelector"
import type { MainStructuralWallSelectorOptions } from "@/lib/geometryFirst/mainStructuralWallSelector"
import { splitWallLinesAtJunctions } from "@/lib/geometryFirst/splitWallLinesAtJunctions"
import { buildArchitecturalWallHypotheses } from "@/lib/geometryFirst/architecturalWallHypotheses"
import { buildGlobalStructuralSpans } from "@/lib/geometryFirst/globalStructuralSpans"
import type { BuildGlobalStructuralSpansOptions } from "@/lib/geometryFirst/globalStructuralSpans"
import type { RobustPlanExtentOptions } from "@/lib/geometryFirst/robustPlanExtent"
import { computeDrawingClusterDiagnostics } from "@/lib/geometryFirst/drawingClusterDiagnostics"
import type { DrawingClusterDiagnosticsOptions } from "@/lib/geometryFirst/drawingClusterDiagnostics"
import {
  buildMainPlanBodySvgString,
  deriveMainPlanBody,
  rerunPlanBodyDownstreamDebug,
  type MainPlanBodyDownstreamCompare,
  type MainPlanBodyOptions,
} from "@/lib/geometryFirst/mainPlanBody"
import {
  buildPlanBodyShellCandidate,
  buildPlanBodyShellCandidateSvgString,
  type PlanBodyShellCandidateDebug,
} from "@/lib/geometryFirst/planBodyShellCandidate"
import {
  buildPlanBodyShellLoop,
  buildPlanBodyShellLoopSvgString,
  type PlanBodyShellLoopDebug,
} from "@/lib/geometryFirst/planBodyShellLoop"
import {
  buildPlanBodyBoundaryRecoveryV2,
  buildPlanBodyBoundaryRecoveryV2SvgString,
  type PlanBodyBoundaryRecoveryV2Debug,
} from "@/lib/geometryFirst/planBodyBoundaryRecoveryV2"
import {
  buildPlanBodyBoundaryRecoveryV3,
  buildPlanBodyBoundaryRecoveryV3SvgString,
  type PlanBodyBoundaryRecoveryV3Debug,
} from "@/lib/geometryFirst/planBodyBoundaryRecoveryV3"
import {
  buildPlanBodyShellRegularization,
  buildPlanBodyShellRegularizationSvgString,
  type PlanBodyShellRegularizationDebug,
} from "@/lib/geometryFirst/planBodyShellRegularization"
import {
  buildPlanBodyShellEvidenceGating,
  buildPlanBodyShellEvidenceGatingSvgString,
  type PlanBodyShellEvidenceGatingDebug,
} from "@/lib/geometryFirst/planBodyShellEvidenceGating"
import {
  buildPlanBodyRoomCandidatesV0,
  buildPlanBodyRoomCandidatesV0SvgString,
  getRoomCandidatesV0UnitPolygonForSvg,
  type PlanBodyRoomCandidatesV0Debug,
} from "@/lib/geometryFirst/planBodyRoomCandidatesV0"
import {
  buildPlanBodyRoomCandidatesCleanupV1,
  buildPlanBodyRoomCandidatesCleanupV1SvgString,
  type PlanBodyRoomCandidatesCleanupV1Debug,
} from "@/lib/geometryFirst/planBodyRoomCandidatesCleanupV1"
import {
  buildPlanBodyRoomSplitRefinementV2,
  buildPlanBodyRoomSplitRefinementV2SvgString,
  type PlanBodyRoomSplitRefinementV2Debug,
} from "@/lib/geometryFirst/planBodyRoomSplitRefinementV2"
import {
  buildPlanBodyRoomSplitRefinementV3,
  buildPlanBodyRoomSplitRefinementV3SvgString,
  type PlanBodyRoomSplitRefinementV3Debug,
} from "@/lib/geometryFirst/planBodyRoomSplitRefinementV3"
import {
  buildPlanBodyRoomCandidateRefinementV1,
  buildPlanBodyRoomCandidateRefinementV1SvgString,
  type PlanBodyRoomCandidateRefinementV1Debug,
} from "@/lib/geometryFirst/planBodyRoomCandidateRefinementV1"
import {
  buildPlanBodyRoomTextAttributionV0,
  buildPlanBodyRoomTextAttributionV0SvgString,
  type RoomTextAttributionV0Debug,
} from "@/lib/geometryFirst/planBodyRoomTextAttributionV0"
import {
  buildPlanBodyRoomTextGroupingV1,
  buildPlanBodyRoomTextGroupingV1SvgString,
  type RoomTextGroupingV1Debug,
} from "@/lib/geometryFirst/planBodyRoomTextGroupingV1"
import {
  buildPlanBodySemanticGuidedRoomPartitionV1,
  buildPlanBodySemanticGuidedRoomPartitionV1SvgString,
  extractMajorRoomAnchorsForPartitionV1,
  type SemanticGuidedRoomPartitionV1Debug,
} from "@/lib/geometryFirst/planBodySemanticGuidedRoomPartitionV1"
import {
  buildPlanBodyTextCoverageRecoveryV2,
  buildPlanBodyTextCoverageRecoveryV2SvgString,
  type PlanBodyTextCoverageRecoveryV2Debug,
} from "@/lib/geometryFirst/planBodyTextCoverageRecoveryV2"
import {
  buildPlanBodyProposalTopologyCleanupV1,
  buildPlanBodyProposalTopologyCleanupV1SvgString,
  type ProposalTopologyCleanupV1Debug,
} from "@/lib/geometryFirst/planBodyProposalTopologyCleanupV1"
import {
  buildPlanBodyAnchorConstrainedRegionGrowingV2,
  buildPlanBodyAnchorConstrainedRegionGrowingV2SvgString,
  type AnchorConstrainedRegionGrowingV2Debug,
} from "@/lib/geometryFirst/planBodyAnchorConstrainedRegionGrowingV2"
import {
  buildPlanBodyAnchorSeedLocalizationV1,
  buildPlanBodyAnchorSeedLocalizationV1SvgString,
  type AnchorSeedLocalizationV1Debug,
} from "@/lib/geometryFirst/planBodyAnchorSeedLocalizationV1"
import {
  buildPlanBodyHierarchicalSpaceTypingV1,
  buildPlanBodyHierarchicalSpaceTypingV1SvgString,
  type HierarchicalSpaceTypingV1Debug,
} from "@/lib/geometryFirst/planBodyHierarchicalSpaceTypingV1"
import {
  buildPlanBodyHierarchicalSpaceTypingV2,
  buildPlanBodyHierarchicalSpaceTypingV2SvgString,
  type HierarchicalSpaceTypingV2Debug,
} from "@/lib/geometryFirst/planBodyHierarchicalSpaceTypingV2"
import {
  buildUnitOuterBoundaryRecoveryV1,
  buildUnitOuterBoundaryRecoveryV1SvgString,
  type UnitOuterBoundaryRecoveryV1Debug,
} from "@/lib/geometryFirst/unitOuterBoundaryRecoveryV1"
import {
  buildUnitOuterBoundaryRefinementV2,
  buildUnitOuterBoundaryRefinementV2SvgString,
  type UnitOuterBoundaryRefinementV2Debug,
} from "@/lib/geometryFirst/unitOuterBoundaryRefinementV2"
import {
  buildUnitOuterBoundaryRefinementV3,
  buildUnitOuterBoundaryRefinementV3SvgString,
  type UnitOuterBoundaryRefinementV3Debug,
} from "@/lib/geometryFirst/unitOuterBoundaryRefinementV3"
import {
  buildExteriorEvidenceSelectorV1,
  buildExteriorEvidenceSelectorV1SvgString,
  type ExteriorEvidenceSelectorV1Debug,
} from "@/lib/geometryFirst/exteriorEvidenceSelectorV1"
import {
  buildGrayWallMassReconstructionV1,
  buildGrayWallMassReconstructionV1SvgString,
  type GrayWallMassReconstructionV1Debug,
} from "@/lib/geometryFirst/grayWallMassReconstructionV1"
import {
  buildStructuralLineRecoveryV1,
  buildStructuralLineRecoveryV1SvgString,
  type StructuralLineRecoveryV1Debug,
} from "@/lib/geometryFirst/structuralLineRecoveryV1"
import {
  buildRoomLineFaithfulReconstructionV1,
  buildRoomLineFaithfulReconstructionV1SvgString,
  type RoomLineFaithfulReconstructionV1Debug,
} from "@/lib/geometryFirst/roomLineFaithfulReconstructionV1"
import {
  buildApartmentLayoutPartitionV1,
  buildApartmentLayoutPartitionV1SvgString,
  type ApartmentLayoutPartitionV1Debug,
} from "@/lib/geometryFirst/apartmentLayoutPartitionV1"
import {
  buildRoomBoundedWallTopologyV1,
  buildRoomBoundedWallTopologyV1SvgString,
  type RoomBoundedWallTopologyV1Debug,
} from "@/lib/geometryFirst/roomBoundedWallTopologyV1"
import {
  filterWallCandidateLines,
  segmentAngleClass,
  segmentLengthPdfUnits,
  summarizeLinePrimitives,
} from "@/lib/geometryFirst/linePrimitiveDenoise"
import type { WallCandidateAngleMode } from "@/lib/geometryFirst/linePrimitiveDenoise"

function unionPageBounds(primitives: ExtractedPlanPrimitives[]): PlanBoundingBox {
  if (primitives.length === 0) return { minX: 0, minY: 0, maxX: 1, maxY: 1 }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of primitives) {
    const b = p.pageBounds
    minX = Math.min(minX, b.minX)
    minY = Math.min(minY, b.minY)
    maxX = Math.max(maxX, b.maxX)
    maxY = Math.max(maxY, b.maxY)
  }
  return { minX, minY, maxX, maxY }
}

function mergeDebugSegments(
  base: Array<{ x1: number; y1: number; x2: number; y2: number; source?: "pdf-operator-list" | "pdf-stroke" | "raster-cv" | "unknown" }>,
  extra: Array<{ x1: number; y1: number; x2: number; y2: number; source?: "pdf-operator-list" | "pdf-stroke" | "raster-cv" | "unknown" }>
) {
  const byKey = new Map<string, (typeof base)[number]>()
  for (const seg of [...base, ...extra]) {
    const key = `${seg.x1.toFixed(2)}:${seg.y1.toFixed(2)}:${seg.x2.toFixed(2)}:${seg.y2.toFixed(2)}:${seg.source ?? "unknown"}`
    byKey.set(key, seg)
  }
  return [...byKey.values()]
}

function toMainStructuralDebugPayload(
  result: ReturnType<typeof selectMainStructuralWalls>,
  sampleCap: number
): MainStructuralWallSelectorDebugPayload {
  const O = result.optionsUsed
  const rows = result.perSegment
  let sample: MainStructuralWallSegmentDebugPayload[]
  if (rows.length <= sampleCap) {
    sample = rows.map((r) => ({
      x1: r.x1,
      y1: r.y1,
      x2: r.x2,
      y2: r.y2,
      lengthPt: r.lengthPt,
      breakdown: { ...r.breakdown },
    }))
  } else {
    const half = Math.floor(sampleCap / 2)
    const head = rows.slice(0, half)
    const tail = rows.slice(-half)
    sample = [...head, ...tail].map((r) => ({
      x1: r.x1,
      y1: r.y1,
      x2: r.x2,
      y2: r.y2,
      lengthPt: r.lengthPt,
      breakdown: { ...r.breakdown },
    }))
  }
  return {
    minScoreToKeep: O.minScoreToKeep,
    maxParallelGapPt: O.maxParallelGapPt,
    minOverlapRatio: O.minOverlapRatio,
    neighborhoodRadiusPt: O.neighborhoodRadiusPt,
    referenceLengthPt: O.referenceLengthPt,
    isolatedShortLengthPt: O.isolatedShortLengthPt,
    isolatedMaxNeighbors: O.isolatedMaxNeighbors,
    textPenaltyRadiusPt: O.textPenaltyRadiusPt,
    maxTextPenalty: O.maxTextPenalty,
    parallelAngleDeg: O.parallelAngleDeg,
    axisAlignmentToleranceDeg: O.axisAlignmentToleranceDeg,
    weightLength: O.weightLength,
    weightAxis: O.weightAxis,
    weightParallelNeighbor: O.weightParallelNeighbor,
    weightOverlap: O.weightOverlap,
    weightIsolatedShort: O.weightIsolatedShort,
    maxParallelNeighborBonus: O.maxParallelNeighborBonus,
    maxOverlapBonus: O.maxOverlapBonus,
    hardMinLengthPt: O.hardMinLengthPt,
    requireParallelSupport: O.requireParallelSupport,
    minParallelNeighborCount: O.minParallelNeighborCount,
    minOverlapSupport: O.minOverlapSupport,
    minNeighborhoodDensity: O.minNeighborhoodDensity,
    segmentCountIn: result.segmentCountIn,
    segmentCountSelected: result.segmentCountSelected,
    perSegmentTotal: rows.length,
    scoreDistribution: { ...result.scoreDistribution },
    termAverages: { ...result.termAverages },
    gateBreakdown: { ...result.gateBreakdown },
    perSegmentSample: sample,
  }
}

function summaryToPayload(s: ReturnType<typeof summarizeLinePrimitives>): GeometryFirstDebugPayload["aggregatedLineSummary"] {
  return {
    totalSegments: s.totalSegments,
    lengthBuckets: s.lengthBuckets.map((b) => ({
      label: b.label,
      minPt: b.minPt,
      maxPt: b.maxPt,
      count: b.count,
    })),
    angleBuckets: { ...s.angleBuckets },
  }
}

function compareArchitecturalWallHypothesisSummaries(
  strict: import("@/lib/geometryFirst/architecturalWallHypotheses").ArchitecturalWallHypothesesDebugPayload,
  extended: import("@/lib/geometryFirst/architecturalWallHypotheses").ArchitecturalWallHypothesesDebugPayload
): ArchitecturalWallHypothesesComparePayload {
  const st = strict.summary
  const ex = extended.summary
  return {
    strict: {
      totalHypotheses: st.totalHypotheses,
      pairedCount: st.pairedCount,
      mergedRunCount: st.mergedRunCount,
      singletonCount: st.singletonCount,
      averageThicknessEstimate: st.averageThicknessEstimate,
    },
    extended: {
      totalHypotheses: ex.totalHypotheses,
      pairedCount: ex.pairedCount,
      mergedRunCount: ex.mergedRunCount,
      singletonCount: ex.singletonCount,
      averageThicknessEstimate: ex.averageThicknessEstimate,
    },
    delta: {
      totalHypotheses: ex.totalHypotheses - st.totalHypotheses,
      pairedCount: ex.pairedCount - st.pairedCount,
      mergedRunCount: ex.mergedRunCount - st.mergedRunCount,
      singletonCount: ex.singletonCount - st.singletonCount,
    },
  }
}

function interpretLinePrimitiveDebug(input: {
  aggregated: ReturnType<typeof summarizeLinePrimitives>
  wallKept: number
  textCount: number
  lineCount: number
  anyTruncated: boolean
}): string[] {
  const notes: string[] = []
  const { aggregated, wallKept, textCount, lineCount, anyTruncated } = input
  const n = aggregated.totalSegments
  if (n === 0) {
    notes.push(
      "No stroked path segments — likely scanned/flattened plan, text-only PDF, or vector data outside stroke operators. Not a clean vector floorplan for this extractor."
    )
    if (textCount > 0) notes.push("Text is present — dimension OCR / raster CV may still be viable.")
    return notes
  }

  const tiny = aggregated.lengthBuckets.find((b) => b.label === "<1")?.count ?? 0
  if (tiny / n > 0.35) {
    notes.push(
      "High share of sub–1 pt strokes — often hatch, hairlines, or exporter noise. Wall reconstruction should down-weight or drop this bucket first."
    )
  }

  const hv = aggregated.angleBuckets.horizontal + aggregated.angleBuckets.vertical
  if (hv / n > 0.5) {
    notes.push(
      "Many segments are near-horizontal or near-vertical — typical of gridded architectural plans. H/V wall-candidate filter is a reasonable inspection mode."
    )
  } else if (aggregated.angleBuckets.other / n > 0.35) {
    notes.push(
      "Large ‘other’ angle bucket — skewed grids, curves-as-polygons, furniture, or non-plan geometry. Expect noisier wall inference without merging/snapping."
    )
  }

  const medLong =
    (aggregated.lengthBuckets.find((b) => b.label === "12-36")?.count ?? 0) +
    (aggregated.lengthBuckets.find((b) => b.label === "36-96")?.count ?? 0) +
    (aggregated.lengthBuckets.find((b) => b.label === "96+")?.count ?? 0)
  if (medLong / n > 0.15) {
    notes.push(
      "Meaningful mass in ≥12 pt length buckets — long edges are plausible wall / partition strokes (scale depends on drawing units)."
    )
  }

  if (wallKept > 0 && wallKept < n * 0.08) {
    notes.push(
      "Wall-candidate count is small vs raw strokes — strict filter may be trimming aggressively; try dominantAngles:'none' or lower minLength in debug body."
    )
  }

  if (anyTruncated) {
    notes.push("At least one page hit the operator-list segment cap — counts are a lower bound; consider raising cap or splitting PDFs.")
  }

  if (lineCount > 5000 && textCount > 50) {
    notes.push(
      "Heavy vector + text — mixed detail sheet or multi-layer vector export. Vector floorplan likely, but denoise before graph reconstruction."
    )
  }

  return notes
}

export async function buildGeometryFirstDebugPayload(
  primitives: ExtractedPlanPrimitives[],
  opts?: {
    angleToleranceDeg?: number
    rawLineSampleLimit?: number
    wallCandidateSampleLimit?: number
    wallCandidateMinLengthPdfUnits?: number
    wallCandidateAngleMode?: WallCandidateAngleMode
    mainStructuralWallSelector?: MainStructuralWallSelectorOptions
    mainStructuralPerSegmentSampleCap?: number
    /** Partial override of defaults in `buildExtendedStructuralWalls` (debug). */
    extendedStructuralRescue?: Partial<ExtendedStructuralRescueOptions>
    /** Partial override of defaults in `buildGlobalStructuralSpans` (debug). */
    globalStructuralSpans?: Partial<BuildGlobalStructuralSpansOptions>
    /** Partial override of defaults in `computeRobustPlanExtent` (debug envelope / outliers). */
    robustPlanExtent?: Partial<RobustPlanExtentOptions>
    /** Drawing-cluster / core coverage diagnostics (same robust pass with trace). */
    drawingClusterDiagnostics?: Partial<DrawingClusterDiagnosticsOptions>
    /** When true, compute main plan body bbox, SVG, and plan-only hypothesis/span reruns. */
    includeMainPlanBody?: boolean
    /** Options passed to `deriveMainPlanBody`. */
    mainPlanBody?: Partial<MainPlanBodyOptions>
    /** Optional AI semantic hints used as a soft prior in later debug-only stages. */
    aiSemanticHints?: FloorplanAiSemanticHintsDebug
    /** Optional source PDF bytes for render-backed debug passes. */
    pdfBytes?: Uint8Array
  }
): Promise<GeometryFirstDebugPayload> {
  const angleToleranceDeg = opts?.angleToleranceDeg ?? 6
  const rawLineSampleLimit = opts?.rawLineSampleLimit ?? 48
  const wallCandidateSampleLimit = opts?.wallCandidateSampleLimit ?? 40
  const wallCandidateMinLengthPdfUnits = opts?.wallCandidateMinLengthPdfUnits ?? 3
  const wallCandidateAngleMode: WallCandidateAngleMode = opts?.wallCandidateAngleMode ?? "hv"

  const textCount = primitives.reduce((s, p) => s + p.texts.length, 0)
  const lineCount = primitives.reduce((s, p) => s + p.lines.length, 0)
  const anyPageLinesTruncated = primitives.some((p) => !!p.operatorListLinesTruncated)

  const flatLines = primitives.flatMap((p) => p.lines)
  const aggregated = summarizeLinePrimitives(flatLines, angleToleranceDeg)
  const wcStats = filterWallCandidateLines(flatLines, {
    minLengthPdfUnits: wallCandidateMinLengthPdfUnits,
    dominantAngles: wallCandidateAngleMode,
    angleToleranceDeg,
  })

  const cleanupStats = cleanupWallCandidateLines(wcStats.kept)
  const wallGraphBeforeJunctions = buildWallGraphFoundationFromCleaned(cleanupStats.cleaned)
  const { split: cleanedSplitSegments, debug: wallJunctionSplit } = splitWallLinesAtJunctions(cleanupStats.cleaned)
  wallJunctionSplit.graphStatsBefore = wallGraphConnectivitySnapshot(wallGraphBeforeJunctions)
  const wallGraph = buildWallGraphFoundationFromCleaned(cleanedSplitSegments)
  wallJunctionSplit.graphStatsAfter = wallGraphConnectivitySnapshot(wallGraph)

  const allTexts = primitives.flatMap((p) => p.texts)
  const pageBoundsUnion = unionPageBounds(primitives)
  const mainPick = selectMainStructuralWalls(
    cleanupStats.cleaned,
    allTexts,
    pageBoundsUnion,
    opts?.mainStructuralWallSelector
  )
  const mainStructuralWallSelection = toMainStructuralDebugPayload(
    mainPick,
    opts?.mainStructuralPerSegmentSampleCap ?? 160
  )
  const { split: mainStructuralSplit } = splitWallLinesAtJunctions(mainPick.selectedMainWalls)
  const wallGraphMainStructural = buildWallGraphFoundationFromCleaned(mainStructuralSplit)

  const clusterDiag = computeDrawingClusterDiagnostics(cleanupStats.cleaned, pageBoundsUnion, {
    robustPlanExtent: opts?.robustPlanExtent,
    ...opts?.drawingClusterDiagnostics,
  })
  const robustExtent = clusterDiag.robustPlan
  const extendedPick = buildExtendedStructuralWalls(
    cleanupStats.cleaned,
    mainPick.selectedMainWalls,
    robustExtent.robustEnvelope,
    opts?.extendedStructuralRescue
  )
  const extendedStructuralWallRescue: ExtendedStructuralRescueDebugPayload = {
    optionsUsed: { ...extendedPick.optionsUsed },
    strictSegmentCount: extendedPick.rescueStats.strictCount,
    extendedSegmentCount: extendedPick.rescueStats.extendedTotalCount,
    extendedOnlySegmentCount: extendedPick.rescueStats.extendedOnlyCount,
    ruleHitCounts: {
      longHVSingleton: extendedPick.rescueStats.ruleHitsLongHVSingleton,
      outerBand: extendedPick.rescueStats.ruleHitsOuterBand,
      largeSpanLocalGroup: extendedPick.rescueStats.ruleHitsLargeSpanGroup,
    },
  }
  const { split: extendedStructuralSplit } = splitWallLinesAtJunctions(extendedPick.extendedStructuralWalls)
  const wallGraphExtendedMainStructural = buildWallGraphFoundationFromCleaned(extendedStructuralSplit)

  const hypOpts = { maxHypothesesInPayload: 5000, maxSvgStrokesInPayload: 5000 }
  const architecturalWallHypotheses = buildArchitecturalWallHypotheses(
    cleanupStats.cleaned,
    mainPick.selectedMainWalls,
    allTexts,
    pageBoundsUnion,
    hypOpts
  )
  const architecturalWallHypothesesExtended = buildArchitecturalWallHypotheses(
    cleanupStats.cleaned,
    extendedPick.extendedStructuralWalls,
    allTexts,
    pageBoundsUnion,
    hypOpts
  )
  const architecturalWallHypothesesCompare = compareArchitecturalWallHypothesisSummaries(
    architecturalWallHypotheses,
    architecturalWallHypothesesExtended
  )

  const globalStructuralSpansPayload = buildGlobalStructuralSpans(
    robustExtent.inlierSegments,
    pageBoundsUnion,
    {
      ...opts?.globalStructuralSpans,
      scoringEnvelope: robustExtent.robustEnvelope,
      originalCleanedIndices: robustExtent.inlierIndices,
    }
  )

  const cleanedLineSampleLimit = opts?.wallCandidateSampleLimit ?? 40
  const cleanedLineSample: GeometryFirstDebugPayload["wallCandidateCleanup"]["cleanedLineSample"] = []
  for (const ln of cleanupStats.cleaned) {
    if (cleanedLineSample.length >= cleanedLineSampleLimit) break
    cleanedLineSample.push({
      pageIndex: 0,
      x1: ln.x1,
      y1: ln.y1,
      x2: ln.x2,
      y2: ln.y2,
      lengthPt: segmentLengthPt(ln),
      angleClass: segmentAngleClass(ln, angleToleranceDeg),
      source: ln.source,
    })
  }

  const extractionModesByPage = primitives.map((p) => ({
    pageIndex: p.pageIndex,
    extractionMode: p.extractionMode,
  }))

  const pages = primitives.map((p) => {
    const lineSummary = summarizeLinePrimitives(p.lines, angleToleranceDeg)
    const fc = filterWallCandidateLines(p.lines, {
      minLengthPdfUnits: wallCandidateMinLengthPdfUnits,
      dominantAngles: wallCandidateAngleMode,
      angleToleranceDeg,
    })
    return {
      pageIndex: p.pageIndex,
      extractionMode: p.extractionMode,
      textCount: p.texts.length,
      lineCount: p.lines.length,
      operatorListLinesTruncated: !!p.operatorListLinesTruncated,
      lineSummary: summaryToPayload(lineSummary),
      wallCandidateFilter: {
        keptCount: fc.kept.length,
        droppedShort: fc.droppedShort,
        droppedAngle: fc.droppedAngle,
      },
    }
  })

  const lineSampleRaw: GeometryFirstDebugPayload["lineSampleRaw"] = []
  outer: for (const p of primitives) {
    for (const ln of p.lines) {
      if (lineSampleRaw.length >= rawLineSampleLimit) break outer
      lineSampleRaw.push({
        pageIndex: p.pageIndex,
        x1: ln.x1,
        y1: ln.y1,
        x2: ln.x2,
        y2: ln.y2,
        lengthPt: segmentLengthPdfUnits(ln),
        angleClass: segmentAngleClass(ln, angleToleranceDeg),
        source: ln.source,
      })
    }
  }

  const wallCandidateLineSample: GeometryFirstDebugPayload["wallCandidateLineSample"] = []
  outer2: for (const p of primitives) {
    const fc = filterWallCandidateLines(p.lines, {
      minLengthPdfUnits: wallCandidateMinLengthPdfUnits,
      dominantAngles: wallCandidateAngleMode,
      angleToleranceDeg,
    })
    for (const ln of fc.kept) {
      if (wallCandidateLineSample.length >= wallCandidateSampleLimit) break outer2
      wallCandidateLineSample.push({
        pageIndex: p.pageIndex,
        x1: ln.x1,
        y1: ln.y1,
        x2: ln.x2,
        y2: ln.y2,
        lengthPt: segmentLengthPdfUnits(ln),
        angleClass: segmentAngleClass(ln, angleToleranceDeg),
        source: ln.source,
      })
    }
  }

  const interpretationNotes = interpretLinePrimitiveDebug({
    aggregated,
    wallKept: wcStats.kept.length,
    textCount,
    lineCount,
    anyTruncated: anyPageLinesTruncated,
  })

  if (cleanupStats.beforeCount > 0) {
    const pct = ((cleanupStats.afterCount / cleanupStats.beforeCount) * 100).toFixed(1)
    interpretationNotes.push(
      `Wall-candidate cleanup (snap ${cleanupStats.thresholds.snapEndpointPt}pt, merge gap ${cleanupStats.thresholds.mergeGapPt}pt, H/V align ±${cleanupStats.thresholds.alignHVAngleDeg}°): ${cleanupStats.beforeCount} → ${cleanupStats.afterCount} segments (${pct}% kept). Aggregated samples use pageIndex 0.`
    )
  }

  if (wallJunctionSplit.segmentCountBefore > 0) {
    const gb = wallJunctionSplit.graphStatsBefore
    const ga = wallJunctionSplit.graphStatsAfter
    interpretationNotes.push(
      `Junction split (${wallJunctionSplit.junctionEpsPt}pt): ${wallJunctionSplit.segmentCountBefore} → ${wallJunctionSplit.segmentCountAfter} segments; events crossing/T/collinear=${wallJunctionSplit.crossingInteriorEvents}/${wallJunctionSplit.teeEndpointEvents}/${wallJunctionSplit.collinearAxisEvents}. Graph: nodes ${gb?.nodeCount ?? "?"}→${ga?.nodeCount ?? "?"}, avgDeg ${gb != null ? gb.averageDegree.toFixed(2) : "?"}→${ga != null ? ga.averageDegree.toFixed(2) : "?"}, dangling ${gb?.danglingEndpointCount ?? "?"}→${ga?.danglingEndpointCount ?? "?"}, components ${gb?.connectedComponentCount ?? "?"}→${ga?.connectedComponentCount ?? "?"}, largest ${gb?.largestComponentNodeCount ?? "?"}→${ga?.largestComponentNodeCount ?? "?"} nodes (${gb?.largestComponentPlausibility ?? "?"}→${ga?.largestComponentPlausibility ?? "?"}). See wallJunctionSplit.splitSample.`
    )
  }

  if (wallGraph.nodeCount > 0) {
    interpretationNotes.push(
      `Wall graph (cleaned candidates): ${wallGraph.nodeCount} nodes, ${wallGraph.segmentEdgeCount} segment-edges, ${wallGraph.graphUniqueEdgeCount} unique pairs, avg degree ${wallGraph.averageDegree.toFixed(2)}, ${wallGraph.danglingEndpointCount} dangling, ${wallGraph.connectedComponentCount} components; largest plausibility=${wallGraph.largestComponent.plausibility}.`
    )
    const oc = wallGraph.outerCycleTrace
    if (oc.attempted) {
      const ms = oc.multiSeed
      interpretationNotes.push(
        `Outer-face candidates (cleaned, multi-seed ${ms.directedSeedsTried} starts, ${ms.uniqueClosedCycles} unique closed): best rank ${oc.selectedCandidateRank}, exteriorScaleHint=${oc.selectedExteriorScaleHint}.`
      )
    }
  }

  if (mainStructuralWallSelection.segmentCountIn > 0) {
    const gb = mainStructuralWallSelection.gateBreakdown
    const sd = mainStructuralWallSelection.scoreDistribution
    interpretationNotes.push(
      `Main structural walls: ${mainStructuralWallSelection.segmentCountSelected}/${mainStructuralWallSelection.segmentCountIn} kept (minScore=${mainStructuralWallSelection.minScoreToKeep}; gates hardLen≥${mainStructuralWallSelection.hardMinLengthPt}pt par=${mainStructuralWallSelection.requireParallelSupport} minParNei=${mainStructuralWallSelection.minParallelNeighborCount} minOv=${mainStructuralWallSelection.minOverlapSupport} minDen=${mainStructuralWallSelection.minNeighborhoodDensity}). Gate drops: hardLen=${gb.rejectedHardMinLength} noPar=${gb.rejectedRequireParallelSupport} minNei=${gb.rejectedMinParallelNeighborCount} minOv=${gb.rejectedMinOverlapSupport} minDen=${gb.rejectedMinNeighborhoodDensity}; passedGates=${gb.passedGates} scoreRej=${gb.rejectedScoreThreshold}. Score p50≈${sd.median.toFixed(3)} p90≈${sd.p90.toFixed(3)}. Graph: ${wallGraphMainStructural.nodeCount} nodes, uniq ${wallGraphMainStructural.graphUniqueEdgeCount} edges — vs wallGraph (cleaned) in payload.`
    )
  }

  interpretationNotes.push(
    `Junction-split graph trio — candidateGraph: ${wallGraph.nodeCount} nodes, ${wallGraph.graphUniqueEdgeCount} uniq edges; strictMainWallGraph: ${wallGraphMainStructural.nodeCount} nodes, ${wallGraphMainStructural.graphUniqueEdgeCount} uniq edges; extendedMainWallGraph: ${wallGraphExtendedMainStructural.nodeCount} nodes, ${wallGraphExtendedMainStructural.graphUniqueEdgeCount} uniq edges. Extended structural (recall): ${extendedStructuralWallRescue.extendedSegmentCount} strokes (${extendedStructuralWallRescue.extendedOnlySegmentCount} beyond strict). Rescue rule hits (non-exclusive): longHVS=${extendedStructuralWallRescue.ruleHitCounts.longHVSingleton} outerBand=${extendedStructuralWallRescue.ruleHitCounts.outerBand} largeGroup=${extendedStructuralWallRescue.ruleHitCounts.largeSpanLocalGroup}. Tuning: payload.extendedStructuralWallRescue.optionsUsed.`
  )

  if (globalStructuralSpansPayload.summary.totalSpanCount > 0) {
    const gs = globalStructuralSpansPayload.summary
    const od = gs.orientationDistribution
    interpretationNotes.push(
      `Global structural spans (experimental, not shell selection): ${gs.totalSpanCount} spans — H ${od.horizontal} / V ${od.vertical} / diag ${od.diagonal}. Top shellHint ids: ${gs.topByShellHintScore
        .slice(0, 4)
        .map((r) => r.id)
        .join(", ")}. Uses robust envelope + inlier-only strokes — see payload.robustPlanExtent and payload.globalStructuralSpans.`
    )
  }

  interpretationNotes.push(...clusterDiag.interpretationNotes)
  for (const p of clusterDiag.likelyAggressiveParams) {
    interpretationNotes.push(`Likely aggressive (drawing cluster): ${p}`)
  }

  if (architecturalWallHypotheses.summary.totalHypotheses > 0 || architecturalWallHypothesesExtended.summary.totalHypotheses > 0) {
    const s = architecturalWallHypotheses.summary
    const e = architecturalWallHypothesesExtended.summary
    const avgT =
      s.averageThicknessEstimate != null ? `${s.averageThicknessEstimate.toFixed(2)}pt` : "—"
    const avgTE =
      e.averageThicknessEstimate != null ? `${e.averageThicknessEstimate.toFixed(2)}pt` : "—"
    const c = architecturalWallHypothesesCompare
    interpretationNotes.push(
      `Wall hypotheses strict: ${s.totalHypotheses} (P ${s.pairedCount} / M ${s.mergedRunCount} / S ${s.singletonCount}), mean paired thickness ${avgT}. Extended-input: ${e.totalHypotheses} (P ${e.pairedCount} / M ${e.mergedRunCount} / S ${e.singletonCount}), mean paired thickness ${avgTE}. Delta totals: ${c.delta.totalHypotheses >= 0 ? "+" : ""}${c.delta.totalHypotheses}. See architecturalWallHypotheses, architecturalWallHypothesesExtended, architecturalWallHypothesesCompare.`
    )
  }

  let mainPlanBody: import("@/lib/geometryFirst/mainPlanBody").MainPlanBodyDebugPayload | undefined
  let mainPlanBodySvg: string | undefined
  let mainPlanBodyDownstream: MainPlanBodyDownstreamCompare | undefined
  let mainPlanBodyShellCandidate: PlanBodyShellCandidateDebug | undefined
  let mainPlanBodyShellCandidateSvg: string | undefined
  let mainPlanBodyShellLoop: PlanBodyShellLoopDebug | undefined
  let mainPlanBodyShellLoopSvg: string | undefined
  let mainPlanBodyBoundaryRecoveryV2: PlanBodyBoundaryRecoveryV2Debug | undefined
  let mainPlanBodyBoundaryRecoveryV2Svg: string | undefined
  let mainPlanBodyBoundaryRecoveryV3: PlanBodyBoundaryRecoveryV3Debug | undefined
  let mainPlanBodyBoundaryRecoveryV3Svg: string | undefined
  let mainPlanBodyShellRegularization: PlanBodyShellRegularizationDebug | undefined
  let mainPlanBodyShellRegularizationSvg: string | undefined
  let mainPlanBodyShellEvidenceGating: PlanBodyShellEvidenceGatingDebug | undefined
  let mainPlanBodyShellEvidenceGatingSvg: string | undefined
  let mainPlanBodyRoomCandidatesV0: PlanBodyRoomCandidatesV0Debug | undefined
  let mainPlanBodyRoomCandidatesV0Svg: string | undefined
  let mainPlanBodyRoomCandidatesCleanupV1: PlanBodyRoomCandidatesCleanupV1Debug | undefined
  let mainPlanBodyRoomCandidatesCleanupV1Svg: string | undefined
  let mainPlanBodyRoomSplitRefinementV2: PlanBodyRoomSplitRefinementV2Debug | undefined
  let mainPlanBodyRoomSplitRefinementV2Svg: string | undefined
  let mainPlanBodyRoomSplitRefinementV3: PlanBodyRoomSplitRefinementV3Debug | undefined
  let mainPlanBodyRoomSplitRefinementV3Svg: string | undefined
  let mainPlanBodyRoomCandidateRefinementV1: PlanBodyRoomCandidateRefinementV1Debug | undefined
  let mainPlanBodyRoomCandidateRefinementV1Svg: string | undefined
  let roomTextAttributionV0: RoomTextAttributionV0Debug | undefined
  let roomTextAttributionV0Svg: string | undefined
  let roomTextGroupingV1: RoomTextGroupingV1Debug | undefined
  let roomTextGroupingV1Svg: string | undefined
  let semanticGuidedRoomPartitionV1: SemanticGuidedRoomPartitionV1Debug | undefined
  let semanticGuidedRoomPartitionV1Svg: string | undefined
  let planBodyTextCoverageRecoveryV2: PlanBodyTextCoverageRecoveryV2Debug | undefined
  let planBodyTextCoverageRecoveryV2Svg: string | undefined
  let proposalTopologyCleanupV1: ProposalTopologyCleanupV1Debug | undefined
  let proposalTopologyCleanupV1Svg: string | undefined
  let anchorConstrainedRegionGrowingV2: AnchorConstrainedRegionGrowingV2Debug | undefined
  let anchorConstrainedRegionGrowingV2Svg: string | undefined
  let anchorSeedLocalizationV1: AnchorSeedLocalizationV1Debug | undefined
  let anchorSeedLocalizationV1Svg: string | undefined
  let hierarchicalSpaceTypingV1: HierarchicalSpaceTypingV1Debug | undefined
  let hierarchicalSpaceTypingV1Svg: string | undefined
  let hierarchicalSpaceTypingV2: HierarchicalSpaceTypingV2Debug | undefined
  let hierarchicalSpaceTypingV2Svg: string | undefined
  let unitOuterBoundaryRecoveryV1: UnitOuterBoundaryRecoveryV1Debug | undefined
  let unitOuterBoundaryRecoveryV1Svg: string | undefined
  let unitOuterBoundaryRefinementV2: UnitOuterBoundaryRefinementV2Debug | undefined
  let unitOuterBoundaryRefinementV2Svg: string | undefined
  let unitOuterBoundaryRefinementV3: UnitOuterBoundaryRefinementV3Debug | undefined
  let unitOuterBoundaryRefinementV3Svg: string | undefined
  let exteriorEvidenceSelectorV1: ExteriorEvidenceSelectorV1Debug | undefined
  let exteriorEvidenceSelectorV1Svg: string | undefined
  let grayWallMassReconstructionV1: GrayWallMassReconstructionV1Debug | undefined
  let grayWallMassReconstructionV1Svg: string | undefined
  let structuralLineRecoveryV1: StructuralLineRecoveryV1Debug | undefined
  let structuralLineRecoveryV1Svg: string | undefined
  let roomLineFaithfulReconstructionV1: RoomLineFaithfulReconstructionV1Debug | undefined
  let roomLineFaithfulReconstructionV1Svg: string | undefined
  let apartmentLayoutPartitionV1: ApartmentLayoutPartitionV1Debug | undefined
  let apartmentLayoutPartitionV1Svg: string | undefined
  let roomBoundedWallTopologyV1: RoomBoundedWallTopologyV1Debug | undefined
  let roomBoundedWallTopologyV1Svg: string | undefined
  if (opts?.includeMainPlanBody) {
    const planResult = deriveMainPlanBody(
      cleanupStats.cleaned,
      architecturalWallHypotheses,
      globalStructuralSpansPayload,
      pageBoundsUnion,
      allTexts,
      opts?.mainPlanBody
    )
    mainPlanBody = planResult.debugPayload
    mainPlanBodySvg = buildMainPlanBodySvgString({
      pageBounds: pageBoundsUnion,
      primaryLayoutBBox: planResult.primaryLayoutBBox,
      cleanedSegments: cleanupStats.cleaned,
      primaryLayoutCleanedIndices: planResult.debugPayload.primaryLayoutCleanedIndices,
      beforeCount: cleanupStats.cleaned.length,
      afterCount: planResult.primaryLayoutSegments.length,
      title: `Main plan body — confidence ${planResult.confidence.toFixed(2)}`,
    })
    const planDownstream = rerunPlanBodyDownstreamDebug(planResult, cleanupStats.cleaned, mainPick.selectedMainWalls, pageBoundsUnion, {
      hypothesisOpts: hypOpts,
      spanOpts: opts?.globalStructuralSpans,
    })
    mainPlanBodyDownstream = planDownstream
    interpretationNotes.push(
      `Main plan body (brochure separation): ${planResult.primaryLayoutSegments.length}/${cleanupStats.cleaned.length} segments inside primary bbox; confidence ${planResult.confidence.toFixed(2)}.`
    )
    interpretationNotes.push(...planResult.reasons.slice(0, 4))
    interpretationNotes.push(
      `Plan-only downstream: hypotheses ${planDownstream.wallHypothesesPlanOnly.summary.totalHypotheses} (vs whole-page strict ${architecturalWallHypotheses.summary.totalHypotheses}); global spans ${planDownstream.globalSpansPlanOnly.summary.totalSpanCount} (vs ${globalStructuralSpansPayload.summary.totalSpanCount}).`
    )

    mainPlanBodyShellCandidate = buildPlanBodyShellCandidate(
      cleanupStats.cleaned,
      planResult.primaryLayoutBBox,
      planResult.debugPayload.primaryLayoutCleanedIndices,
      planDownstream.wallHypothesesPlanOnly,
      planDownstream.globalSpansPlanOnly
    )
    mainPlanBodyShellCandidateSvg = buildPlanBodyShellCandidateSvgString({
      pageBounds: pageBoundsUnion,
      primaryLayoutBBox: planResult.primaryLayoutBBox,
      wallHypothesesPlanOnly: planDownstream.wallHypothesesPlanOnly,
      globalSpansPlanOnly: planDownstream.globalSpansPlanOnly,
      shell: mainPlanBodyShellCandidate,
      fullCleanedSegments: cleanupStats.cleaned,
    })
    interpretationNotes.push(
      `Plan-body shell candidate (debug): ${mainPlanBodyShellCandidate.shellCandidateCleanedIndices.length} cleaned segments, confidence ${mainPlanBodyShellCandidate.confidence.toFixed(2)}; see mainPlanBodyShellCandidate + mainPlanBodyShellCandidateSvg.`
    )
    interpretationNotes.push(...mainPlanBodyShellCandidate.notes.slice(0, 6))

    mainPlanBodyShellLoop = buildPlanBodyShellLoop(
      planResult.primaryLayoutBBox,
      planResult.primaryLayoutSegments,
      planResult.debugPayload.primaryLayoutCleanedIndices,
      mainPlanBodyShellCandidate.shellCandidateCleanedIndices,
      planDownstream.wallHypothesesPlanOnly,
      planDownstream.globalSpansPlanOnly
    )
    mainPlanBodyShellLoopSvg = buildPlanBodyShellLoopSvgString({
      pageBounds: pageBoundsUnion,
      primaryLayoutBBox: planResult.primaryLayoutBBox,
      shellCandidateCleanedIndices: mainPlanBodyShellCandidate.shellCandidateCleanedIndices,
      fullCleanedSegments: cleanupStats.cleaned,
      loopDebug: mainPlanBodyShellLoop,
      wallHypothesesPlanOnly: planDownstream.wallHypothesesPlanOnly,
      globalSpansPlanOnly: planDownstream.globalSpansPlanOnly,
    })
    interpretationNotes.push(
      `Plan-body shell loop (debug): ${mainPlanBodyShellLoop.loopCandidateCount} candidate(s), best rank ${mainPlanBodyShellLoop.bestLoopCandidateRank}, closed=${mainPlanBodyShellLoop.bestLoopClosed}, closure confidence ${mainPlanBodyShellLoop.closureConfidence.toFixed(2)}.`
    )
    interpretationNotes.push(...mainPlanBodyShellLoop.notes.slice(0, 5))

    mainPlanBodyBoundaryRecoveryV2 = buildPlanBodyBoundaryRecoveryV2(
      planResult.primaryLayoutBBox,
      planResult.primaryLayoutSegments,
      planResult.debugPayload.primaryLayoutCleanedIndices,
      mainPlanBodyShellCandidate.shellCandidateCleanedIndices,
      planDownstream.wallHypothesesPlanOnly,
      planDownstream.globalSpansPlanOnly,
      mainPlanBodyShellLoop
    )
    mainPlanBodyBoundaryRecoveryV2Svg = buildPlanBodyBoundaryRecoveryV2SvgString({
      pageBounds: pageBoundsUnion,
      primaryLayoutBBox: planResult.primaryLayoutBBox,
      shellCandidateCleanedIndices: mainPlanBodyShellCandidate.shellCandidateCleanedIndices,
      fullCleanedSegments: cleanupStats.cleaned,
      shellLoopDebug: mainPlanBodyShellLoop,
      boundaryDebug: mainPlanBodyBoundaryRecoveryV2,
      wallHypothesesPlanOnly: planDownstream.wallHypothesesPlanOnly,
      globalSpansPlanOnly: planDownstream.globalSpansPlanOnly,
    })
    const br = mainPlanBodyBoundaryRecoveryV2
    interpretationNotes.push(
      `Plan-body boundary recovery v2 (debug): ${br.boundaryCandidateCount} candidate(s), bridges=${br.recoveredBridgeCount}, best closed=${br.bestBoundaryClosed}, closure conf ${br.closureConfidence.toFixed(2)}; right improved vs shell loop=${br.improvedRightVsShellLoop}, bottom improved=${br.improvedBottomVsShellLoop}; nearly-closed recoverable=${br.nearlyClosedExteriorRecoverable}.`
    )
    interpretationNotes.push(br.regularizationBasisStatement)
    interpretationNotes.push(br.closureRecoverabilityStatement)
    interpretationNotes.push(br.weakSidesImprovementStatement)
    interpretationNotes.push(...br.notes.slice(0, 4))

    mainPlanBodyBoundaryRecoveryV3 = buildPlanBodyBoundaryRecoveryV3(
      planResult.primaryLayoutBBox,
      planResult.primaryLayoutSegments,
      planResult.debugPayload.primaryLayoutCleanedIndices,
      mainPlanBodyShellCandidate.shellCandidateCleanedIndices,
      planDownstream.wallHypothesesPlanOnly,
      planDownstream.globalSpansPlanOnly,
      mainPlanBodyShellLoop,
      mainPlanBodyBoundaryRecoveryV2
    )
    mainPlanBodyBoundaryRecoveryV3Svg = buildPlanBodyBoundaryRecoveryV3SvgString({
      pageBounds: pageBoundsUnion,
      primaryLayoutBBox: planResult.primaryLayoutBBox,
      shellCandidateCleanedIndices: mainPlanBodyShellCandidate.shellCandidateCleanedIndices,
      fullCleanedSegments: cleanupStats.cleaned,
      shellLoopDebug: mainPlanBodyShellLoop,
      boundaryV2: mainPlanBodyBoundaryRecoveryV2,
      boundaryV3: mainPlanBodyBoundaryRecoveryV3,
    })
    const b3 = mainPlanBodyBoundaryRecoveryV3
    interpretationNotes.push(
      `Plan-body boundary recovery v3 (debug, targeted R/B): unresolved zones=${b3.unresolvedGapCount}, v3 bridges=${b3.recoveredBridgeCount}, right improved=${b3.rightSideImproved}, bottom improved=${b3.bottomSideImproved}, best closed=${b3.bestBoundaryClosed}, closure conf ${b3.closureConfidence.toFixed(2)}, basis=${b3.boundaryIsHintVsRegularizationBasis}.`
    )
    interpretationNotes.push(b3.regularizationBasisStatement)
    interpretationNotes.push(...b3.notes.slice(0, 3))

    mainPlanBodyShellRegularization = buildPlanBodyShellRegularization(
      planResult.primaryLayoutBBox,
      mainPlanBodyBoundaryRecoveryV3,
      mainPlanBodyShellCandidate.shellCandidateCleanedIndices,
      cleanupStats.cleaned,
      planDownstream.wallHypothesesPlanOnly,
      planDownstream.globalSpansPlanOnly
    )
    mainPlanBodyShellRegularizationSvg = buildPlanBodyShellRegularizationSvgString({
      pageBounds: pageBoundsUnion,
      primaryLayoutBBox: planResult.primaryLayoutBBox,
      shellCandidateCleanedIndices: mainPlanBodyShellCandidate.shellCandidateCleanedIndices,
      fullCleanedSegments: cleanupStats.cleaned,
      boundaryRecoveryV3: mainPlanBodyBoundaryRecoveryV3,
      regularization: mainPlanBodyShellRegularization,
    })
    const reg = mainPlanBodyShellRegularization
    interpretationNotes.push(
      `Plan-body shell regularization (debug): ${reg.regularizedVertexCountBefore}→${reg.regularizedVertexCountAfter} vertices, closed=${reg.regularizedBoundaryClosed}, perimeter ${reg.regularizedPerimeterPt.toFixed(1)}pt; synthetic edges=${reg.supportScoreSummary.syntheticEdgeCount}, ambiguous edges=${reg.supportScoreSummary.ambiguousEdgeCount}.`
    )
    interpretationNotes.push(reg.regularizationQualityStatement)
    interpretationNotes.push(reg.extrusionReadinessStatement)

    mainPlanBodyShellEvidenceGating = buildPlanBodyShellEvidenceGating(
      planResult.primaryLayoutBBox,
      planResult.primaryLayoutSegments,
      planResult.debugPayload.primaryLayoutCleanedIndices,
      mainPlanBodyShellCandidate.shellCandidateCleanedIndices,
      cleanupStats.cleaned,
      planDownstream.wallHypothesesPlanOnly,
      planDownstream.globalSpansPlanOnly,
      mainPlanBodyBoundaryRecoveryV3,
      reg.regularizedPolygonPt,
      reg.regularizedBoundaryClosed,
      reg.edgeAnnotations,
      mainPlanBodyBoundaryRecoveryV3.remainingGapZones
    )
    mainPlanBodyShellEvidenceGatingSvg = buildPlanBodyShellEvidenceGatingSvgString({
      pageBounds: pageBoundsUnion,
      primaryLayoutBBox: planResult.primaryLayoutBBox,
      evidence: mainPlanBodyShellEvidenceGating,
      remainingGapZones: mainPlanBodyBoundaryRecoveryV3.remainingGapZones,
      regularizedBoundaryClosed: reg.regularizedBoundaryClosed,
    })
    const gate = mainPlanBodyShellEvidenceGating
    interpretationNotes.push(
      `Shell evidence gating (debug): trusted perimeter ${(gate.supportedPerimeterFraction * 100).toFixed(1)}%, synthetic ${(gate.syntheticPerimeterFraction * 100).toFixed(1)}%, ambiguous ${(gate.ambiguousPerimeterFraction * 100).toFixed(1)}%; trusted runs=${gate.trustedRunCount}, largest trusted ${gate.largestTrustedRunPt.toFixed(1)}pt; R/B trusted ${(gate.rightSideTrustedFraction * 100).toFixed(0)}% / ${(gate.bottomSideTrustedFraction * 100).toFixed(0)}%; verdict=${gate.extrusionGatingVerdict}.`
    )
    interpretationNotes.push(gate.extrusionGatingStatement)
    interpretationNotes.push(...gate.notes.slice(0, 2))

    mainPlanBodyRoomCandidatesV0 = buildPlanBodyRoomCandidatesV0(
      planResult.primaryLayoutBBox,
      planResult.primaryLayoutSegments,
      planResult.debugPayload.primaryLayoutCleanedIndices,
      planDownstream.wallHypothesesPlanOnly,
      planDownstream.globalSpansPlanOnly,
      mainPlanBodyBoundaryRecoveryV3,
      mainPlanBodyShellRegularization
    )
    const unitSvg = getRoomCandidatesV0UnitPolygonForSvg(mainPlanBodyBoundaryRecoveryV3, mainPlanBodyShellRegularization)

    unitOuterBoundaryRecoveryV1 = buildUnitOuterBoundaryRecoveryV1(
      primitives.flatMap((p) => p.lines),
      allTexts,
      pageBoundsUnion,
      planResult.primaryLayoutBBox,
      unitSvg?.unitPolygon ?? null,
      unitSvg?.unitBoundaryClosed ?? null
    )
    unitOuterBoundaryRecoveryV1Svg = buildUnitOuterBoundaryRecoveryV1SvgString({
      pageBounds: pageBoundsUnion,
      recovery: unitOuterBoundaryRecoveryV1,
      previousUnitPolygon: unitSvg?.unitPolygon ?? null,
      previousUnitBoundaryClosed: unitSvg?.unitBoundaryClosed ?? null,
      allSegments: primitives.flatMap((p) => p.lines),
    })

    unitOuterBoundaryRefinementV2 = buildUnitOuterBoundaryRefinementV2(
      unitOuterBoundaryRecoveryV1.recoveredUnitPolygon,
      planResult.primaryLayoutSegments,
      planResult.debugPayload.primaryLayoutCleanedIndices,
      planDownstream.wallHypothesesPlanOnly,
      planDownstream.globalSpansPlanOnly,
      opts?.aiSemanticHints
    )
    unitOuterBoundaryRefinementV2Svg = buildUnitOuterBoundaryRefinementV2SvgString({
      pageBounds: pageBoundsUnion,
      refinement: unitOuterBoundaryRefinementV2,
      primaryLayoutSegments: planResult.primaryLayoutSegments,
      wallHypothesesPlanOnly: planDownstream.wallHypothesesPlanOnly,
      globalSpansPlanOnly: planDownstream.globalSpansPlanOnly,
      aiUnitOutlineHint: opts?.aiSemanticHints?.unitOutlineHint?.pdfPageVertices ?? null,
    })
    interpretationNotes.push(unitOuterBoundaryRefinementV2.refinementSupportSummary)
    interpretationNotes.push(unitOuterBoundaryRefinementV2.aiPriorUsageSummary)
    interpretationNotes.push(unitOuterBoundaryRefinementV2.boundaryRefinementStatement)
    interpretationNotes.push(...unitOuterBoundaryRefinementV2.notes.slice(0, 2))

    unitOuterBoundaryRefinementV3 = buildUnitOuterBoundaryRefinementV3(
      unitOuterBoundaryRecoveryV1.recoveredUnitPolygon,
      unitOuterBoundaryRefinementV2.refinedUnitPolygon,
      planDownstream.wallHypothesesPlanOnly,
      planDownstream.globalSpansPlanOnly,
      opts?.aiSemanticHints
    )
    unitOuterBoundaryRefinementV3Svg = buildUnitOuterBoundaryRefinementV3SvgString({
      pageBounds: pageBoundsUnion,
      refinement: unitOuterBoundaryRefinementV3,
      wallHypothesesPlanOnly: planDownstream.wallHypothesesPlanOnly,
      globalSpansPlanOnly: planDownstream.globalSpansPlanOnly,
      aiUnitOutlineHint: opts?.aiSemanticHints?.unitOutlineHint?.pdfPageVertices ?? null,
    })
    interpretationNotes.push(unitOuterBoundaryRefinementV3.exteriorEvidenceSummary)
    interpretationNotes.push(unitOuterBoundaryRefinementV3.simplificationSummary)
    interpretationNotes.push(unitOuterBoundaryRefinementV3.boundaryRefinementStatement)
    interpretationNotes.push(...unitOuterBoundaryRefinementV3.notes.slice(0, 2))

    exteriorEvidenceSelectorV1 = buildExteriorEvidenceSelectorV1(
      unitOuterBoundaryRefinementV3.refinedUnitPolygon,
      planResult.primaryLayoutSegments,
      planDownstream.wallHypothesesPlanOnly,
      planDownstream.globalSpansPlanOnly,
      allTexts
    )
    exteriorEvidenceSelectorV1Svg = buildExteriorEvidenceSelectorV1SvgString({
      pageBounds: pageBoundsUnion,
      selector: exteriorEvidenceSelectorV1,
    })
    interpretationNotes.push(exteriorEvidenceSelectorV1.evidenceScoreSummary)
    interpretationNotes.push(exteriorEvidenceSelectorV1.selectorStatement)
    interpretationNotes.push(...exteriorEvidenceSelectorV1.notes.slice(0, 2))

    let structuralInputSegments = planResult.primaryLayoutSegments
    if (opts?.pdfBytes?.length) {
      grayWallMassReconstructionV1 = await buildGrayWallMassReconstructionV1({
        pdfBytes: new Uint8Array(opts.pdfBytes),
        pageIndex: 0,
        mainPlanBodyBBox: planResult.primaryLayoutBBox,
        effectiveUnitPolygon: unitOuterBoundaryRefinementV3.refinedUnitPolygon,
      })
      grayWallMassReconstructionV1Svg = buildGrayWallMassReconstructionV1SvgString({
        pageBounds: pageBoundsUnion,
        reconstruction: grayWallMassReconstructionV1,
        unitPolygon: unitOuterBoundaryRefinementV3.refinedUnitPolygon,
        originalSegments: planResult.primaryLayoutSegments,
      })
      structuralInputSegments = mergeDebugSegments(
        planResult.primaryLayoutSegments,
        grayWallMassReconstructionV1.maskDerivedSegments
      )
      interpretationNotes.push(grayWallMassReconstructionV1.structureStatement)
      interpretationNotes.push(...grayWallMassReconstructionV1.notes.slice(0, 2))
    }

    structuralLineRecoveryV1 = buildStructuralLineRecoveryV1(
      structuralInputSegments,
      unitOuterBoundaryRefinementV3.refinedUnitPolygon,
      exteriorEvidenceSelectorV1,
      planDownstream.wallHypothesesPlanOnly,
      planDownstream.globalSpansPlanOnly,
      allTexts
    )
    structuralLineRecoveryV1Svg = buildStructuralLineRecoveryV1SvgString({
      pageBounds: pageBoundsUnion,
      recovery: structuralLineRecoveryV1,
      originalSegments: structuralInputSegments,
    })
    interpretationNotes.push(structuralLineRecoveryV1.recoveryStatement)
    interpretationNotes.push(...structuralLineRecoveryV1.notes.slice(0, 2))

    roomLineFaithfulReconstructionV1 = buildRoomLineFaithfulReconstructionV1(
      structuralLineRecoveryV1.repairedStructuralSegments,
      unitOuterBoundaryRefinementV3.refinedUnitPolygon,
      planDownstream.wallHypothesesPlanOnly,
      planDownstream.globalSpansPlanOnly,
      exteriorEvidenceSelectorV1.selectedExteriorSegments,
      exteriorEvidenceSelectorV1.selectedExteriorHypotheses,
      exteriorEvidenceSelectorV1.selectedExteriorSpans,
      allTexts
    )
    roomLineFaithfulReconstructionV1Svg = buildRoomLineFaithfulReconstructionV1SvgString({
      pageBounds: pageBoundsUnion,
      reconstruction: roomLineFaithfulReconstructionV1,
    })
    interpretationNotes.push(roomLineFaithfulReconstructionV1.reconstructionStatement)
    interpretationNotes.push(...roomLineFaithfulReconstructionV1.notes.slice(0, 2))

    // ── authoritative unit shell ──
    // If refinement v3 produced a valid closed polygon, use it; else fall back to v2 then v1.
    // as the primary container for ALL downstream room / open-plan reconstruction.
    // This prevents rooms from being reconstructed inside the old too-narrow bbox.
    const refinedV3Ok =
      unitOuterBoundaryRefinementV3.refinedBoundaryClosed &&
      unitOuterBoundaryRefinementV3.refinedUnitPolygon.length >= 3
    const refinedOk =
      unitOuterBoundaryRefinementV2.refinedBoundaryClosed &&
      unitOuterBoundaryRefinementV2.refinedUnitPolygon.length >= 3
    const recoveredOk =
      unitOuterBoundaryRecoveryV1.boundaryClosed &&
      unitOuterBoundaryRecoveryV1.recoveredUnitPolygon.length >= 3
    const effectiveUnitPolygon = refinedV3Ok
      ? unitOuterBoundaryRefinementV3.refinedUnitPolygon
      : refinedOk
      ? unitOuterBoundaryRefinementV2.refinedUnitPolygon
      : recoveredOk
      ? unitOuterBoundaryRecoveryV1.recoveredUnitPolygon
      : unitSvg?.unitPolygon ?? []
    const effectiveUnitBoundaryClosed = refinedV3Ok
      ? true
      : refinedOk
      ? true
      : recoveredOk
      ? true
      : unitSvg?.unitBoundaryClosed ?? false

    // Re-bind unitSvg so every downstream consumer uses the recovered shell
    const effectiveUnit = effectiveUnitPolygon.length >= 3
      ? { unitPolygon: effectiveUnitPolygon, unitBoundaryClosed: effectiveUnitBoundaryClosed }
      : unitSvg

    if (effectiveUnit) {
      mainPlanBodyRoomCandidatesV0Svg = buildPlanBodyRoomCandidatesV0SvgString({
        pageBounds: pageBoundsUnion,
        primaryLayoutBBox: planResult.primaryLayoutBBox,
        debug: mainPlanBodyRoomCandidatesV0,
        unitPolygon: effectiveUnit.unitPolygon,
        unitBoundaryClosed: effectiveUnit.unitBoundaryClosed,
      })
      const unitArea =
        Math.abs(
          effectiveUnit.unitPolygon.reduce((s, p, i, arr) => {
            const q = arr[(i + 1) % arr.length]!
            return s + p.x * q.y - q.x * p.y
          }, 0) / 2
        )
      mainPlanBodyRoomCandidatesCleanupV1 = buildPlanBodyRoomCandidatesCleanupV1(
        planResult.primaryLayoutBBox,
        planResult.primaryLayoutSegments,
        planResult.debugPayload.primaryLayoutCleanedIndices,
        planDownstream.wallHypothesesPlanOnly,
        planDownstream.globalSpansPlanOnly,
        mainPlanBodyRoomCandidatesV0,
        effectiveUnit.unitPolygon,
        effectiveUnit.unitBoundaryClosed,
        unitArea,
        allTexts
      )
      mainPlanBodyRoomCandidatesCleanupV1Svg = buildPlanBodyRoomCandidatesCleanupV1SvgString({
        pageBounds: pageBoundsUnion,
        primaryLayoutBBox: planResult.primaryLayoutBBox,
        debug: mainPlanBodyRoomCandidatesCleanupV1,
        unitPolygon: effectiveUnit.unitPolygon,
        unitBoundaryClosed: effectiveUnit.unitBoundaryClosed,
      })
      mainPlanBodyRoomSplitRefinementV2 = buildPlanBodyRoomSplitRefinementV2(
        planResult.primaryLayoutBBox,
        planResult.primaryLayoutSegments,
        planResult.debugPayload.primaryLayoutCleanedIndices,
        planDownstream.wallHypothesesPlanOnly,
        planDownstream.globalSpansPlanOnly,
        mainPlanBodyRoomCandidatesV0,
        mainPlanBodyRoomCandidatesCleanupV1,
        effectiveUnit.unitPolygon,
        effectiveUnit.unitBoundaryClosed,
        unitArea,
        allTexts
      )
      mainPlanBodyRoomSplitRefinementV2Svg = buildPlanBodyRoomSplitRefinementV2SvgString({
        pageBounds: pageBoundsUnion,
        primaryLayoutBBox: planResult.primaryLayoutBBox,
        debug: mainPlanBodyRoomSplitRefinementV2,
        unitPolygon: effectiveUnit.unitPolygon,
        unitBoundaryClosed: effectiveUnit.unitBoundaryClosed,
      })
      mainPlanBodyRoomSplitRefinementV3 = buildPlanBodyRoomSplitRefinementV3(
        planResult.primaryLayoutBBox,
        mainPlanBodyRoomSplitRefinementV2,
        effectiveUnit.unitPolygon,
        effectiveUnit.unitBoundaryClosed,
        unitArea,
        allTexts
      )
      mainPlanBodyRoomSplitRefinementV3Svg = buildPlanBodyRoomSplitRefinementV3SvgString({
        pageBounds: pageBoundsUnion,
        primaryLayoutBBox: planResult.primaryLayoutBBox,
        debug: mainPlanBodyRoomSplitRefinementV3,
        unitPolygon: effectiveUnit.unitPolygon,
        unitBoundaryClosed: effectiveUnit.unitBoundaryClosed,
      })
      mainPlanBodyRoomCandidateRefinementV1 = buildPlanBodyRoomCandidateRefinementV1(
        planResult.primaryLayoutBBox,
        planResult.primaryLayoutSegments,
        planResult.debugPayload.primaryLayoutCleanedIndices,
        planDownstream.wallHypothesesPlanOnly,
        planDownstream.globalSpansPlanOnly,
        mainPlanBodyRoomSplitRefinementV3,
        effectiveUnit.unitPolygon,
        effectiveUnit.unitBoundaryClosed,
        unitArea,
        allTexts
      )
      mainPlanBodyRoomCandidateRefinementV1Svg = buildPlanBodyRoomCandidateRefinementV1SvgString({
        pageBounds: pageBoundsUnion,
        primaryLayoutBBox: planResult.primaryLayoutBBox,
        debug: mainPlanBodyRoomCandidateRefinementV1,
        v3RoomCandidates: mainPlanBodyRoomSplitRefinementV3.roomCandidates,
        unitPolygon: effectiveUnit.unitPolygon,
        unitBoundaryClosed: effectiveUnit.unitBoundaryClosed,
      })
      planBodyTextCoverageRecoveryV2 = buildPlanBodyTextCoverageRecoveryV2(
        planResult,
        allTexts,
        effectiveUnit.unitPolygon,
        effectiveUnit.unitBoundaryClosed
      )
      const expandedPlanBodyTextRuns = planBodyTextCoverageRecoveryV2.expandedPlanBodyTextRuns
      planBodyTextCoverageRecoveryV2Svg = buildPlanBodyTextCoverageRecoveryV2SvgString({
        pageBounds: pageBoundsUnion,
        primaryLayoutBBox: planResult.primaryLayoutBBox,
        recovery: planBodyTextCoverageRecoveryV2,
        unitPolygon: effectiveUnit.unitPolygon,
        unitBoundaryClosed: effectiveUnit.unitBoundaryClosed,
      })
      roomTextAttributionV0 = buildPlanBodyRoomTextAttributionV0(
        mainPlanBodyRoomCandidateRefinementV1,
        mainPlanBodyRoomSplitRefinementV3,
        effectiveUnit.unitPolygon,
        effectiveUnit.unitBoundaryClosed,
        expandedPlanBodyTextRuns
      )
      roomTextAttributionV0Svg = buildPlanBodyRoomTextAttributionV0SvgString({
        pageBounds: pageBoundsUnion,
        primaryLayoutBBox: planResult.primaryLayoutBBox,
        attribution: roomTextAttributionV0,
        refinedRoomCandidates: mainPlanBodyRoomCandidateRefinementV1.refinedRoomCandidates,
        unitPolygon: effectiveUnit.unitPolygon,
        unitBoundaryClosed: effectiveUnit.unitBoundaryClosed,
      })
      roomTextGroupingV1 = buildPlanBodyRoomTextGroupingV1(
        mainPlanBodyRoomCandidateRefinementV1,
        mainPlanBodyRoomSplitRefinementV3,
        effectiveUnit.unitPolygon,
        effectiveUnit.unitBoundaryClosed,
        expandedPlanBodyTextRuns,
        roomTextAttributionV0
      )
      roomTextGroupingV1Svg = buildPlanBodyRoomTextGroupingV1SvgString({
        pageBounds: pageBoundsUnion,
        primaryLayoutBBox: planResult.primaryLayoutBBox,
        grouping: roomTextGroupingV1,
        refinedRoomCandidates: mainPlanBodyRoomCandidateRefinementV1.refinedRoomCandidates,
        unitPolygon: effectiveUnit.unitPolygon,
        unitBoundaryClosed: effectiveUnit.unitBoundaryClosed,
      })
      semanticGuidedRoomPartitionV1 = buildPlanBodySemanticGuidedRoomPartitionV1(
        mainPlanBodyRoomCandidateRefinementV1,
        roomTextGroupingV1,
        planResult.primaryLayoutSegments,
        planResult.debugPayload.primaryLayoutCleanedIndices,
        planDownstream.wallHypothesesPlanOnly,
        planDownstream.globalSpansPlanOnly,
        effectiveUnit.unitPolygon,
        effectiveUnit.unitBoundaryClosed,
        unitArea
      )
      const majorAnchorsPartition = extractMajorRoomAnchorsForPartitionV1(roomTextGroupingV1)
      semanticGuidedRoomPartitionV1Svg = buildPlanBodySemanticGuidedRoomPartitionV1SvgString({
        pageBounds: pageBoundsUnion,
        primaryLayoutBBox: planResult.primaryLayoutBBox,
        partition: semanticGuidedRoomPartitionV1,
        refinedRoomCandidates: mainPlanBodyRoomCandidateRefinementV1.refinedRoomCandidates,
        majorAnchors: majorAnchorsPartition,
        unitPolygon: effectiveUnit.unitPolygon,
        unitBoundaryClosed: effectiveUnit.unitBoundaryClosed,
      })
      proposalTopologyCleanupV1 = buildPlanBodyProposalTopologyCleanupV1(
        semanticGuidedRoomPartitionV1,
        majorAnchorsPartition,
        roomTextGroupingV1,
        planResult.primaryLayoutSegments,
        planResult.debugPayload.primaryLayoutCleanedIndices,
        planDownstream.wallHypothesesPlanOnly,
        planDownstream.globalSpansPlanOnly,
        effectiveUnit.unitPolygon,
        effectiveUnit.unitBoundaryClosed,
        unitArea
      )
      proposalTopologyCleanupV1Svg = buildPlanBodyProposalTopologyCleanupV1SvgString({
        pageBounds: pageBoundsUnion,
        primaryLayoutBBox: planResult.primaryLayoutBBox,
        cleanup: proposalTopologyCleanupV1,
        refinedRoomCandidates: mainPlanBodyRoomCandidateRefinementV1.refinedRoomCandidates,
        rawSemanticProposals: semanticGuidedRoomPartitionV1.roomProposals,
        unitPolygon: effectiveUnit.unitPolygon,
        unitBoundaryClosed: effectiveUnit.unitBoundaryClosed,
      })
      anchorSeedLocalizationV1 = buildPlanBodyAnchorSeedLocalizationV1(
        majorAnchorsPartition,
        roomTextGroupingV1,
        planBodyTextCoverageRecoveryV2,
        planResult.primaryLayoutSegments,
        planResult.debugPayload.primaryLayoutCleanedIndices,
        planDownstream.wallHypothesesPlanOnly,
        planDownstream.globalSpansPlanOnly,
        effectiveUnit.unitPolygon,
        effectiveUnit.unitBoundaryClosed
      )
      anchorSeedLocalizationV1Svg = buildPlanBodyAnchorSeedLocalizationV1SvgString({
        pageBounds: pageBoundsUnion,
        primaryLayoutBBox: planResult.primaryLayoutBBox,
        localization: anchorSeedLocalizationV1,
        majorAnchors: majorAnchorsPartition,
        unitPolygon: effectiveUnit.unitPolygon,
        unitBoundaryClosed: effectiveUnit.unitBoundaryClosed,
      })
      hierarchicalSpaceTypingV1 = buildPlanBodyHierarchicalSpaceTypingV1(
        majorAnchorsPartition,
        roomTextGroupingV1,
        planBodyTextCoverageRecoveryV2,
        anchorSeedLocalizationV1,
        effectiveUnit.unitPolygon,
        effectiveUnit.unitBoundaryClosed,
        unitArea
      )
      hierarchicalSpaceTypingV1Svg = buildPlanBodyHierarchicalSpaceTypingV1SvgString({
        pageBounds: pageBoundsUnion,
        primaryLayoutBBox: planResult.primaryLayoutBBox,
        typing: hierarchicalSpaceTypingV1,
        unitPolygon: effectiveUnit.unitPolygon,
        unitBoundaryClosed: effectiveUnit.unitBoundaryClosed,
      })
      hierarchicalSpaceTypingV2 = buildPlanBodyHierarchicalSpaceTypingV2(
        hierarchicalSpaceTypingV1,
        majorAnchorsPartition,
        roomTextGroupingV1,
        planBodyTextCoverageRecoveryV2,
        anchorSeedLocalizationV1,
        allTexts,
        planResult.primaryLayoutSegments,
        planResult.debugPayload.primaryLayoutCleanedIndices,
        planDownstream.wallHypothesesPlanOnly,
        planDownstream.globalSpansPlanOnly,
        effectiveUnit.unitPolygon,
        effectiveUnit.unitBoundaryClosed,
        unitArea
      )
      hierarchicalSpaceTypingV2Svg = buildPlanBodyHierarchicalSpaceTypingV2SvgString({
        pageBounds: pageBoundsUnion,
        primaryLayoutBBox: planResult.primaryLayoutBBox,
        typing: hierarchicalSpaceTypingV2,
        v1Envelope: hierarchicalSpaceTypingV1.openPlanEnvelopeCandidates[0],
        unitPolygon: effectiveUnit.unitPolygon,
        unitBoundaryClosed: effectiveUnit.unitBoundaryClosed,
      })
      if (roomLineFaithfulReconstructionV1) {
        apartmentLayoutPartitionV1 = buildApartmentLayoutPartitionV1(
          roomLineFaithfulReconstructionV1,
          roomTextGroupingV1,
          hierarchicalSpaceTypingV2,
          effectiveUnit.unitPolygon,
          grayWallMassReconstructionV1
        )
        apartmentLayoutPartitionV1Svg = buildApartmentLayoutPartitionV1SvgString({
          pageBounds: pageBoundsUnion,
          partition: apartmentLayoutPartitionV1,
        })
        roomBoundedWallTopologyV1 = buildRoomBoundedWallTopologyV1(
          roomLineFaithfulReconstructionV1,
          roomTextGroupingV1,
          hierarchicalSpaceTypingV2,
          effectiveUnit.unitPolygon,
          effectiveUnit.unitBoundaryClosed,
          apartmentLayoutPartitionV1,
          opts?.aiSemanticHints,
          grayWallMassReconstructionV1
        )
        roomBoundedWallTopologyV1Svg = buildRoomBoundedWallTopologyV1SvgString({
          pageBounds: pageBoundsUnion,
          topology: roomBoundedWallTopologyV1,
        })
      }
      anchorConstrainedRegionGrowingV2 = buildPlanBodyAnchorConstrainedRegionGrowingV2(
        proposalTopologyCleanupV1,
        majorAnchorsPartition,
        roomTextGroupingV1,
        planResult.primaryLayoutSegments,
        planResult.debugPayload.primaryLayoutCleanedIndices,
        planDownstream.wallHypothesesPlanOnly,
        planDownstream.globalSpansPlanOnly,
        effectiveUnit.unitPolygon,
        effectiveUnit.unitBoundaryClosed,
        unitArea,
        anchorSeedLocalizationV1
      )
      anchorConstrainedRegionGrowingV2Svg = buildPlanBodyAnchorConstrainedRegionGrowingV2SvgString({
        pageBounds: pageBoundsUnion,
        primaryLayoutBBox: planResult.primaryLayoutBBox,
        growing: anchorConstrainedRegionGrowingV2,
        cleanedProposals: proposalTopologyCleanupV1.cleanedRoomProposals,
        majorAnchors: majorAnchorsPartition,
        unitPolygon: effectiveUnit.unitPolygon,
        unitBoundaryClosed: effectiveUnit.unitBoundaryClosed,
      })
    }
    const rm = mainPlanBodyRoomCandidatesV0
    interpretationNotes.push(
      `Room candidates v0 (debug): ${rm.roomCandidateCount} total (${rm.cvRoomCandidateCount} CV, ${rm.geometryRoomCandidateCount} geometry, ${rm.fusedRoomCandidateCount} fused). ${rm.roomExtractionStatement.slice(0, 160)}${rm.roomExtractionStatement.length > 160 ? "…" : ""}`
    )
    interpretationNotes.push(...rm.notes.slice(0, 2))
    if (effectiveUnit && mainPlanBodyRoomCandidatesCleanupV1) {
      const c1 = mainPlanBodyRoomCandidatesCleanupV1
      interpretationNotes.push(
        `Room candidates cleanup v1 (debug): ${c1.roomCandidateCount} region(s), oversized ${c1.oversizedBlobCount}, splits applied ${c1.splitAppliedCount}, barriers ${c1.splitBarrierCount}. ${c1.roomCleanupStatement.slice(0, 140)}${c1.roomCleanupStatement.length > 140 ? "…" : ""}`
      )
      interpretationNotes.push(...c1.notes.slice(0, 2))
    }
    if (effectiveUnit && mainPlanBodyRoomSplitRefinementV2) {
      const c2 = mainPlanBodyRoomSplitRefinementV2
      interpretationNotes.push(
        `Room split refinement v2 (debug): ${c2.roomCandidateCount} region(s), families ${c2.barrierFamilyCount}, proposals ${c2.splitProposalCount}, accepted ${c2.acceptedSplitCount}. ${c2.roomSplitRefinementStatement.slice(0, 130)}${c2.roomSplitRefinementStatement.length > 130 ? "…" : ""}`
      )
      interpretationNotes.push(...c2.notes.slice(0, 2))
    }
    if (effectiveUnit && mainPlanBodyRoomSplitRefinementV3) {
      const c3 = mainPlanBodyRoomSplitRefinementV3
      interpretationNotes.push(
        `Room split refinement v3 (debug): ${c3.roomCandidateCount} region(s), accepted ${c3.acceptedSplitCount}. ${c3.splitExecutionModeSummary.slice(0, 140)}${c3.splitExecutionModeSummary.length > 140 ? "…" : ""}`
      )
      interpretationNotes.push(...c3.notes.slice(0, 2))
    }
    if (effectiveUnit && mainPlanBodyRoomCandidateRefinementV1) {
      const r1 = mainPlanBodyRoomCandidateRefinementV1
      interpretationNotes.push(
        `Room candidate refinement v1 (debug): ${r1.roomCandidateCount} refined region(s), adjacency edges ${r1.adjacencyGraph.edges.length}, merges ${r1.mergeAppliedCount}, splits ${r1.splitAppliedCount}. ${r1.refinementStatement.slice(0, 130)}${r1.refinementStatement.length > 130 ? "…" : ""}`
      )
      interpretationNotes.push(...r1.notes.slice(0, 2))
    }
    if (effectiveUnit && planBodyTextCoverageRecoveryV2) {
      const tc = planBodyTextCoverageRecoveryV2
      interpretationNotes.push(
        `Plan-body text coverage recovery v2 (debug): visible runs ${tc.visibleTextRunCount}, groups ${tc.groupedLabelCountBefore}→${tc.groupedLabelCountAfter}, +${tc.addedTextRunCount} runs, ${tc.recoveredMajorLabels.length} recovered major label(s). Missing checklist: ${tc.stillMissingExpectedMajorLabels.length}. See planBodyTextCoverageRecoveryV2 + planBodyTextCoverageRecoveryV2Svg.`
      )
      interpretationNotes.push(tc.textCoverageStatement)
    }
    if (effectiveUnit && roomTextAttributionV0) {
      const t0 = roomTextAttributionV0
      interpretationNotes.push(
        `Room text attribution v0 (debug): likely major-like regions ${t0.likelyMajorRoomCount}, mixed ${t0.likelyMixedRegionCount}, auxiliary-only ${t0.likelyAuxiliarySpaceCount}; unassigned labels ${t0.unassignedTextAnchors.length}. See roomTextAttributionV0 + roomTextAttributionV0Svg.`
      )
      interpretationNotes.push(...t0.notes.slice(0, 2))
    }
    if (effectiveUnit && roomTextGroupingV1) {
      const g1 = roomTextGroupingV1
      interpretationNotes.push(
        `Room text grouping v1 (debug): ${g1.groupedLabelTotal} group(s), multi-run ${g1.multiRunGroupCount}; major assignments ${g1.majorAssignmentCountVsV0.v0}→${g1.majorAssignmentCountVsV0.v1} (Δ${g1.majorAssignmentCountVsV0.delta >= 0 ? "+" : ""}${g1.majorAssignmentCountVsV0.delta}); recovered multi-run majors ${g1.recoveredMajorGroupsCount}. See roomTextGroupingV1 + roomTextGroupingV1Svg.`
      )
      interpretationNotes.push(g1.groupingCoverageStatement)
      interpretationNotes.push(...g1.notes.slice(0, 1))
    }
    if (effectiveUnit && semanticGuidedRoomPartitionV1) {
      const sg = semanticGuidedRoomPartitionV1
      interpretationNotes.push(
        `Semantic-guided room partition v1 (debug): ${sg.majorAnchorCount} major anchor(s), ${sg.roomProposalCount} proposal(s); coarse retained ${sg.retainedQuadrantRegionCount}, replaced ${sg.replacedQuadrantRegionCount}. ${sg.partitionStatement.slice(0, 160)}${sg.partitionStatement.length > 160 ? "…" : ""}`
      )
      interpretationNotes.push(...sg.notes.slice(0, 2))
    }
    if (effectiveUnit && proposalTopologyCleanupV1) {
      const tc = proposalTopologyCleanupV1
      interpretationNotes.push(
        `Proposal topology cleanup v1 (debug): ${tc.cleanedProposalCount} cleaned proposal(s); ${tc.overlapReductionSummary.length} overlap pair(s) summarized; ${tc.stillAmbiguousProposalIds.length} ambiguous id(s). ${tc.cleanupStatement.slice(0, 150)}${tc.cleanupStatement.length > 150 ? "…" : ""}`
      )
      interpretationNotes.push(...tc.notes.slice(0, 1))
    }
    if (effectiveUnit && anchorSeedLocalizationV1) {
      const sl = anchorSeedLocalizationV1
      interpretationNotes.push(
        `Anchor seed localization v1 (debug): ${sl.seedCount} seed(s); ${sl.failedSeedIds.length} failed id(s); ${sl.fallbackSeedIds.length} fallback id(s). ${sl.seedLocalizationStatement.slice(0, 130)}${sl.seedLocalizationStatement.length > 130 ? "…" : ""}`
      )
      interpretationNotes.push(sl.localCoreSummary)
    }
    if (effectiveUnit && hierarchicalSpaceTypingV1) {
      const ht = hierarchicalSpaceTypingV1
      interpretationNotes.push(ht.typingStatement)
      interpretationNotes.push(...ht.notes.slice(0, 1))
    }
    if (effectiveUnit && hierarchicalSpaceTypingV2) {
      const ht2 = hierarchicalSpaceTypingV2
      interpretationNotes.push(ht2.typingStatement)
      interpretationNotes.push(...ht2.notes.slice(0, 2))
    }
    if (effectiveUnit && apartmentLayoutPartitionV1) {
      interpretationNotes.push(apartmentLayoutPartitionV1.reconstructionStatement)
      interpretationNotes.push(...apartmentLayoutPartitionV1.notes.slice(0, 2))
    }
    if (effectiveUnit && roomBoundedWallTopologyV1) {
      interpretationNotes.push(roomBoundedWallTopologyV1.reconstructionStatement)
      interpretationNotes.push(...roomBoundedWallTopologyV1.notes.slice(0, 2))
    }
    if (unitOuterBoundaryRecoveryV1) {
      const ur = unitOuterBoundaryRecoveryV1
      interpretationNotes.push(ur.boundaryRecoveryStatement)
      interpretationNotes.push(...ur.notes.slice(0, 3))
      if (recoveredOk) {
        interpretationNotes.push(
          `[authoritative] Recovered unit polygon is now the primary container for all downstream room reconstruction (${ur.vertexCount} vertices, area=${ur.recoveredAreaPt2.toFixed(0)} pt²).`
        )
      }
    }
    if (effectiveUnit && anchorConstrainedRegionGrowingV2) {
      const gr = anchorConstrainedRegionGrowingV2
      interpretationNotes.push(
        `Anchor constrained region growing v2 (debug): ${gr.grownProposalCount} grown proposal(s); ${gr.conflictZoneCount} conflict zone(s); ambiguity reduced for ${gr.reducedAmbiguityCount} id(s) vs topology cleanup. ${gr.growthStatement.slice(0, 140)}${gr.growthStatement.length > 140 ? "…" : ""}`
      )
      interpretationNotes.push(...gr.notes.slice(0, 1))
    }
  }

  return {
    extractionModesByPage,
    pageCount: primitives.length,
    textCount,
    lineCount,
    anyPageLinesTruncated,
    aggregatedLineSummary: summaryToPayload(aggregated),
    wallCandidateFilter: {
      minLengthPdfUnits: wallCandidateMinLengthPdfUnits,
      dominantAngles: wallCandidateAngleMode,
      angleToleranceDeg,
      inputCount: wcStats.inputCount,
      keptCount: wcStats.kept.length,
      droppedShort: wcStats.droppedShort,
      droppedAngle: wcStats.droppedAngle,
    },
    wallCandidateCleanup: {
      beforeCount: cleanupStats.beforeCount,
      afterCount: cleanupStats.afterCount,
      thresholds: cleanupStats.thresholds,
      cleanedLineSample,
    },
    wallJunctionSplit,
    wallGraph,
    mainStructuralWallSelection,
    wallGraphMainStructural,
    wallGraphExtendedMainStructural,
    extendedStructuralWallRescue,
    architecturalWallHypotheses,
    architecturalWallHypothesesExtended,
    architecturalWallHypothesesCompare,
    globalStructuralSpans: globalStructuralSpansPayload,
    robustPlanExtent: {
      summary: robustExtent.summary,
      optionsUsed: robustExtent.optionsUsed,
      outlierDetailsSample: robustExtent.outlierDetails.slice(0, 80),
    },
    drawingClusterDiagnostics: clusterDiag.debugPayload,
    mainPlanBody,
    mainPlanBodySvg,
    mainPlanBodyDownstream,
    mainPlanBodyShellCandidate,
    mainPlanBodyShellCandidateSvg,
    mainPlanBodyShellLoop,
    mainPlanBodyShellLoopSvg,
    mainPlanBodyBoundaryRecoveryV2,
    mainPlanBodyBoundaryRecoveryV2Svg,
    mainPlanBodyBoundaryRecoveryV3,
    mainPlanBodyBoundaryRecoveryV3Svg,
    mainPlanBodyShellRegularization,
    mainPlanBodyShellRegularizationSvg,
    mainPlanBodyShellEvidenceGating,
    mainPlanBodyShellEvidenceGatingSvg,
    mainPlanBodyRoomCandidatesV0,
    mainPlanBodyRoomCandidatesV0Svg,
    mainPlanBodyRoomCandidatesCleanupV1,
    mainPlanBodyRoomCandidatesCleanupV1Svg,
    mainPlanBodyRoomSplitRefinementV2,
    mainPlanBodyRoomSplitRefinementV2Svg,
    mainPlanBodyRoomSplitRefinementV3,
    mainPlanBodyRoomSplitRefinementV3Svg,
    mainPlanBodyRoomCandidateRefinementV1,
    mainPlanBodyRoomCandidateRefinementV1Svg,
    roomTextAttributionV0,
    roomTextAttributionV0Svg,
    roomTextGroupingV1,
    roomTextGroupingV1Svg,
    semanticGuidedRoomPartitionV1,
    semanticGuidedRoomPartitionV1Svg,
    planBodyTextCoverageRecoveryV2,
    planBodyTextCoverageRecoveryV2Svg,
    proposalTopologyCleanupV1,
    proposalTopologyCleanupV1Svg,
    anchorConstrainedRegionGrowingV2,
    anchorConstrainedRegionGrowingV2Svg,
    anchorSeedLocalizationV1,
    anchorSeedLocalizationV1Svg,
    hierarchicalSpaceTypingV1,
    hierarchicalSpaceTypingV1Svg,
    hierarchicalSpaceTypingV2,
    hierarchicalSpaceTypingV2Svg,
    unitOuterBoundaryRecoveryV1,
    unitOuterBoundaryRecoveryV1Svg,
    unitOuterBoundaryRefinementV2,
    unitOuterBoundaryRefinementV2Svg,
    unitOuterBoundaryRefinementV3,
    unitOuterBoundaryRefinementV3Svg,
    exteriorEvidenceSelectorV1,
    exteriorEvidenceSelectorV1Svg,
    grayWallMassReconstructionV1,
    grayWallMassReconstructionV1Svg,
    structuralLineRecoveryV1,
    structuralLineRecoveryV1Svg,
    roomLineFaithfulReconstructionV1,
    roomLineFaithfulReconstructionV1Svg,
    apartmentLayoutPartitionV1,
    apartmentLayoutPartitionV1Svg,
    roomBoundedWallTopologyV1,
    roomBoundedWallTopologyV1Svg,
    aiSemanticHints: opts?.aiSemanticHints,
    pages,
    lineSampleRaw,
    wallCandidateLineSample,
    interpretationNotes,
  }
}
