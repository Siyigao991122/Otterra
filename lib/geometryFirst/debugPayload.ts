/**
 * Builds `_debugGeometryFirst` for POST /api/floorplan-geometry-first (TEMPORARY).
 */

import { cleanupWallCandidateLines, segmentLengthPt } from "@/lib/geometryFirst/cleanupWallLines"
import type {
  ExtractedPlanPrimitives,
  GeometryFirstDebugPayload,
  MainStructuralWallSegmentDebugPayload,
  MainStructuralWallSelectorDebugPayload,
  PlanBoundingBox,
} from "@/lib/geometryFirst/types"
import {
  buildWallGraphFoundationFromCleaned,
  wallGraphConnectivitySnapshot,
} from "@/lib/geometryFirst/wallGraphFoundation"
import { selectMainStructuralWalls } from "@/lib/geometryFirst/mainStructuralWallSelector"
import type { MainStructuralWallSelectorOptions } from "@/lib/geometryFirst/mainStructuralWallSelector"
import { splitWallLinesAtJunctions } from "@/lib/geometryFirst/splitWallLinesAtJunctions"
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

export function buildGeometryFirstDebugPayload(
  primitives: ExtractedPlanPrimitives[],
  opts?: {
    angleToleranceDeg?: number
    rawLineSampleLimit?: number
    wallCandidateSampleLimit?: number
    wallCandidateMinLengthPdfUnits?: number
    wallCandidateAngleMode?: WallCandidateAngleMode
    mainStructuralWallSelector?: MainStructuralWallSelectorOptions
    mainStructuralPerSegmentSampleCap?: number
  }
): GeometryFirstDebugPayload {
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
    pages,
    lineSampleRaw,
    wallCandidateLineSample,
    interpretationNotes,
  }
}
