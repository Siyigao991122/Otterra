/**
 * Geometry-first orchestrator: choose PDF vector/text path vs image placeholder.
 * Does not call OpenAI — pair with `/api/analyze-floorplan` for model-first fallback.
 */

import { cleanupWallCandidateLines } from "@/lib/geometryFirst/cleanupWallLines"
import {
  buildWallGraphFoundationFromCleaned,
  wallGraphConnectivitySnapshot,
} from "@/lib/geometryFirst/wallGraphFoundation"
import { splitWallLinesAtJunctions } from "@/lib/geometryFirst/splitWallLinesAtJunctions"
import type {
  ExtractedPlanPrimitives,
  GeometryFirstExtractionResult,
  GeometryFirstPreciseLayout,
  PlanBoundingBox,
} from "@/lib/geometryFirst/types"
import { extractPdfVectorPrimitives } from "@/lib/geometryFirst/extractPdfVectorPrimitives"
import { filterWallCandidateLines } from "@/lib/geometryFirst/linePrimitiveDenoise"

function emptyLayout(): GeometryFirstPreciseLayout {
  return {
    units: "m",
    footprintPolygon: [],
    interiorWalls: undefined,
    roomZones: undefined,
    provenance: { pipeline: "geometry-first", stage: "primitives-only" },
  }
}

function placeholderFromImages(imageCount: number): ExtractedPlanPrimitives[] {
  const placeholderBounds: PlanBoundingBox = { minX: 0, minY: 0, maxX: 1, maxY: 1 }
  return Array.from({ length: Math.max(1, imageCount) }, (_, pageIndex) => ({
    pageIndex,
    pageBounds: placeholderBounds,
    lines: [],
    texts: [],
    extractionMode: "image-placeholder" as const,
  }))
}

/**
 * @param pdfBytes - raw PDF when available (server decodes base64 before calling)
 * @param imagePageCount - number of raster pages sent (e.g. client-rendered PDF pages); used only if no PDF bytes
 */
export async function runGeometryFirstExtraction(input: {
  pdfBytes?: Uint8Array | null
  imagePageCount?: number
}): Promise<GeometryFirstExtractionResult> {
  const notes: string[] = []

  if (input.pdfBytes && input.pdfBytes.length > 0) {
    try {
      const { primitives, runtime } = await extractPdfVectorPrimitives(input.pdfBytes)
      const lineTotal = primitives.reduce((s, p) => s + p.lines.length, 0)
      const textTotal = primitives.reduce((s, p) => s + p.texts.length, 0)
      notes.push(
        `PDF primitives: ${textTotal} text runs (getTextContent), ${lineTotal} segments from stroked operator-list paths (constructPath).`
      )
      if (primitives.some((p) => p.operatorListLinesTruncated)) {
        notes.push("At least one page hit the operator-list segment cap; see _debugGeometryFirst.anyPageLinesTruncated.")
      }
      const flat = primitives.flatMap((p) => p.lines)
      const wc = filterWallCandidateLines(flat, {
        minLengthPdfUnits: 3,
        dominantAngles: "hv",
        angleToleranceDeg: 6,
      })
      const { cleaned, beforeCount, afterCount } = cleanupWallCandidateLines(wc.kept)
      const wallGraphBeforeJunctions = buildWallGraphFoundationFromCleaned(cleaned)
      const { split: cleanedForGraph, debug: wallJunctionSplit } = splitWallLinesAtJunctions(cleaned)
      wallJunctionSplit.graphStatsBefore = wallGraphConnectivitySnapshot(wallGraphBeforeJunctions)
      const wallGraph = buildWallGraphFoundationFromCleaned(cleanedForGraph)
      wallJunctionSplit.graphStatsAfter = wallGraphConnectivitySnapshot(wallGraph)
      if (beforeCount > 0) {
        notes.push(`Wall-candidate cleanup (defaults): ${beforeCount} → ${afterCount} segments for downstream graph/footprint work.`)
      }
      if (wallJunctionSplit.segmentCountBefore > 0) {
        const gb = wallJunctionSplit.graphStatsBefore
        const ga = wallJunctionSplit.graphStatsAfter
        notes.push(
          `Junction split: ${wallJunctionSplit.segmentCountBefore} → ${wallJunctionSplit.segmentCountAfter} segments (crossings=${wallJunctionSplit.crossingInteriorEvents}, T-junctions=${wallJunctionSplit.teeEndpointEvents}, axis-collinear=${wallJunctionSplit.collinearAxisEvents}) — graph nodes ${gb?.nodeCount ?? "?"}→${ga?.nodeCount ?? "?"}, components ${gb?.connectedComponentCount ?? "?"}→${ga?.connectedComponentCount ?? "?"}, dangling ${gb?.danglingEndpointCount ?? "?"}→${ga?.danglingEndpointCount ?? "?"}, largest plaus. ${gb?.largestComponentPlausibility ?? "?"}→${ga?.largestComponentPlausibility ?? "?"}.`
        )
      }
      if (wallGraph.nodeCount > 0) {
        const hv = wallGraph.outerBoundaryCandidate.hullVertexCount
        const hm = wallGraph.outerBoundaryCandidate.hullEdgesMatchedToSegments
        const hullBit = hv > 0 ? `${hm}/${hv} hull edges matched` : "hull degenerate"
        notes.push(
          `Wall graph (q=${wallGraph.nodeMergeQuantizationPt}pt): ${wallGraph.nodeCount} nodes, ${wallGraph.danglingEndpointCount} dangling, ${wallGraph.connectedComponentCount} components, ${hullBit} — see _debugGeometryFirst.wallGraph.`
        )
        const oc = wallGraph.outerCycleTrace
        if (oc.attempted) {
          const ms = oc.multiSeed
          notes.push(
            `Largest-component outer cycles (multi-seed ${ms.directedSeedsTried}/${ms.maxDirectedSeeds}, ${ms.uniqueClosedCycles} closed): selected rank ${oc.selectedCandidateRank}, scaleHint=${oc.selectedExteriorScaleHint}, closed=${oc.closed}, verts=${oc.cycleVertexCount}, perimPt=${oc.cyclePerimeterPt.toFixed(1)}, segmentSupport=${(oc.stepSupportFraction * 100).toFixed(1)}% — top candidates in wallGraph.outerCycleTrace.candidateSummariesTop.`
          )
        }
      }
      return {
        primitives,
        layout: emptyLayout(),
        notes,
        cleanedWallLines: cleanedForGraph,
        wallJunctionSplit,
        wallGraph,
        _pdfVectorExtraction: runtime,
      }
    } catch (e) {
      notes.push(
        `PDF vector path failed (${e instanceof Error ? e.message : String(e)}); use raster images + CV or model fallback.`
      )
    }
  }

  const n = input.imagePageCount ?? 1
  notes.push(
    "No usable PDF bytes: returned image-placeholder primitives only. Raster line extraction (CV) is not implemented in Phase 1."
  )
  return {
    primitives: placeholderFromImages(n),
    layout: emptyLayout(),
    notes,
  }
}
