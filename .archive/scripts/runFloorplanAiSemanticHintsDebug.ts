import * as fs from "node:fs"
import * as path from "node:path"

import {
  buildFloorplanAiSemanticHintsOverlaySvgString,
  buildFloorplanAiSemanticHintsResult,
} from "../lib/geometryFirst/floorplanAiSemanticHints"
import { buildGeometryFirstDebugPayload } from "../lib/geometryFirst/debugPayload"
import { buildGrayWallMassThresholdPreviewPng } from "../lib/geometryFirst/grayWallMassReconstructionV1"
import { runGeometryFirstExtraction } from "../lib/geometryFirst/extractPlanPrimitives"
import type { PlanBoundingBox } from "../lib/geometryFirst/types"

function slugBaseName(filePath: string): string {
  return path.basename(filePath).replace(/\.[^.]+$/, "")
}

function loadOpenAiApiKeyFromDotEnvLocal(): string | undefined {
  const existing = process.env.OPENAI_API_KEY?.trim()
  if (existing) return existing
  const envPath = path.join(process.cwd(), ".env.local")
  if (!fs.existsSync(envPath)) return undefined
  const text = fs.readFileSync(envPath, "utf8")
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue
    const m = /^OPENAI_API_KEY\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    const value = m[1]!.trim().replace(/^['"]/, "").replace(/['"]$/, "")
    if (value) return value
  }
  return undefined
}

function pageBoundsForIndex(pages: Array<{ pageIndex: number; pageBounds: PlanBoundingBox }>, pageIndex: number): PlanBoundingBox {
  return pages.find((p) => p.pageIndex === pageIndex)?.pageBounds ?? pages[0]?.pageBounds ?? { minX: 0, minY: 0, maxX: 1, maxY: 1 }
}

async function main(): Promise<void> {
  const pdfPath =
    process.argv[2] != null && process.argv[2]!.length > 0
      ? path.resolve(process.cwd(), process.argv[2]!)
      : path.join(process.cwd(), "tower_6_B.pdf")
  if (!fs.existsSync(pdfPath)) {
    throw new Error(`PDF not found: ${pdfPath}`)
  }

  const openAiApiKey = loadOpenAiApiKeyFromDotEnvLocal()
  if (!openAiApiKey) {
    throw new Error("OPENAI_API_KEY not found in environment or .env.local")
  }

  const pdfFile = fs.readFileSync(pdfPath)
  const sourcePdfBytes = new Uint8Array(pdfFile)
  const extractionPdfBytes = new Uint8Array(pdfFile)
  const aiPdfBytes = new Uint8Array(pdfFile)
  const extraction = await runGeometryFirstExtraction({ pdfBytes: extractionPdfBytes })
  const initialDebug = await buildGeometryFirstDebugPayload(extraction.primitives, {
    includeMainPlanBody: true,
    pdfBytes: new Uint8Array(sourcePdfBytes),
  })

  const ai = await buildFloorplanAiSemanticHintsResult(aiPdfBytes, {
    openAiApiKey,
    pageIndex: 0,
    renderScale: 2,
    maxEdgePx: 1800,
    mainPlanBodyBBox: initialDebug.mainPlanBody?.primaryLayoutBBox ?? null,
    recoveredUnitPolygon: initialDebug.unitOuterBoundaryRecoveryV1?.recoveredUnitPolygon ?? null,
  })

  if (!ai) {
    throw new Error("AI semantic hints returned null.")
  }

  const base = slugBaseName(pdfPath)
  const outDir = path.join(process.cwd(), "debug")
  fs.mkdirSync(outDir, { recursive: true })

  const prefix = `geometry-first-ai-semantic-hints-${base}`
  fs.writeFileSync(path.join(outDir, `${prefix}-full-page.png`), ai.artifacts.fullPagePng)
  fs.writeFileSync(path.join(outDir, `${prefix}-cropped-plan.png`), ai.artifacts.croppedPlanPng)
  fs.writeFileSync(path.join(outDir, `${prefix}-passA.json`), JSON.stringify(ai.artifacts.passAJson, null, 2))
  fs.writeFileSync(path.join(outDir, `${prefix}-passB.json`), JSON.stringify(ai.artifacts.passBJson, null, 2))
  fs.writeFileSync(path.join(outDir, `${prefix}.json`), JSON.stringify(ai.hints, null, 2))

  const finalDebug = await buildGeometryFirstDebugPayload(extraction.primitives, {
    includeMainPlanBody: true,
    aiSemanticHints: ai.hints,
    pdfBytes: new Uint8Array(sourcePdfBytes),
  })

  const pageBounds = pageBoundsForIndex(extraction.primitives, 0)
  const overlaySvg = buildFloorplanAiSemanticHintsOverlaySvgString({
    pageBounds,
    hints: ai.hints,
    mainPlanBodyBBox: initialDebug.mainPlanBody?.primaryLayoutBBox ?? null,
  })
  fs.writeFileSync(path.join(outDir, `${prefix}-overlay.svg`), overlaySvg)
  if (finalDebug.unitOuterBoundaryRefinementV2Svg) {
    fs.writeFileSync(
      path.join(outDir, `geometry-first-main-plan-unit-outer-boundary-refinement-v2-${base}.svg`),
      finalDebug.unitOuterBoundaryRefinementV2Svg
    )
  }
  if (finalDebug.unitOuterBoundaryRefinementV3Svg) {
    fs.writeFileSync(
      path.join(outDir, `geometry-first-main-plan-unit-outer-boundary-refinement-v3-${base}.svg`),
      finalDebug.unitOuterBoundaryRefinementV3Svg
    )
  }
  if (finalDebug.exteriorEvidenceSelectorV1Svg) {
    fs.writeFileSync(
      path.join(outDir, `geometry-first-main-plan-exterior-evidence-selector-v1-${base}.svg`),
      finalDebug.exteriorEvidenceSelectorV1Svg
    )
  }
  if (finalDebug.grayWallMassReconstructionV1Svg) {
    fs.writeFileSync(
      path.join(outDir, `geometry-first-main-plan-gray-wall-mass-reconstruction-v1-${base}.svg`),
      finalDebug.grayWallMassReconstructionV1Svg
    )
  }
  if (finalDebug.grayWallMassReconstructionV1) {
    const previewPng = await buildGrayWallMassThresholdPreviewPng(
      new Uint8Array(sourcePdfBytes),
      finalDebug.grayWallMassReconstructionV1
    )
    fs.writeFileSync(
      path.join(outDir, `geometry-first-main-plan-gray-wall-mass-threshold-v1-${base}.png`),
      previewPng
    )
  }
  if (finalDebug.structuralLineRecoveryV1Svg) {
    fs.writeFileSync(
      path.join(outDir, `geometry-first-main-plan-structural-line-recovery-v1-${base}.svg`),
      finalDebug.structuralLineRecoveryV1Svg
    )
  }
  if (finalDebug.roomLineFaithfulReconstructionV1Svg) {
    fs.writeFileSync(
      path.join(outDir, `geometry-first-main-plan-room-line-faithful-reconstruction-v1-${base}.svg`),
      finalDebug.roomLineFaithfulReconstructionV1Svg
    )
  }
  if (finalDebug.apartmentLayoutPartitionV1Svg) {
    fs.writeFileSync(
      path.join(outDir, `geometry-first-main-plan-apartment-layout-partition-v1-${base}.svg`),
      finalDebug.apartmentLayoutPartitionV1Svg
    )
  }
  if (finalDebug.roomBoundedWallTopologyV1Svg) {
    fs.writeFileSync(
      path.join(outDir, `geometry-first-main-plan-room-bounded-wall-topology-v1-${base}.svg`),
      finalDebug.roomBoundedWallTopologyV1Svg
    )
  }
  fs.writeFileSync(
    path.join(outDir, `geometry-first-main-plan-debug-${base}.json`),
    JSON.stringify(
      {
        aiSemanticHints: ai.hints,
        unitOuterBoundaryRecoveryV1: finalDebug.unitOuterBoundaryRecoveryV1,
        unitOuterBoundaryRefinementV2: finalDebug.unitOuterBoundaryRefinementV2,
        unitOuterBoundaryRefinementV3: finalDebug.unitOuterBoundaryRefinementV3,
        exteriorEvidenceSelectorV1: finalDebug.exteriorEvidenceSelectorV1,
        grayWallMassReconstructionV1: finalDebug.grayWallMassReconstructionV1,
        structuralLineRecoveryV1: finalDebug.structuralLineRecoveryV1,
        roomLineFaithfulReconstructionV1: finalDebug.roomLineFaithfulReconstructionV1,
        apartmentLayoutPartitionV1: finalDebug.apartmentLayoutPartitionV1,
        roomBoundedWallTopologyV1: finalDebug.roomBoundedWallTopologyV1,
      },
      null,
      2
    )
  )

  console.log(JSON.stringify({
    pdf: pdfPath,
    outputPrefix: path.join(outDir, prefix),
    cropRectPx: ai.hints.cropRectPx ?? null,
    majorSpaceCount: ai.hints.majorSpaces.length,
    sharedOpenPlanEnvelopeCount: ai.hints.sharedOpenPlanEnvelopes.length,
    auxiliarySpaceCount: ai.hints.auxiliarySpaces.length,
    refinedUnitVertexCount: finalDebug.unitOuterBoundaryRefinementV2?.refinedUnitPolygon.length ?? 0,
    refinedUnitVertexCountV3: finalDebug.unitOuterBoundaryRefinementV3?.refinedUnitVertexCount ?? 0,
    selectedExteriorSegmentCount: finalDebug.exteriorEvidenceSelectorV1?.selectedExteriorSegments.length ?? 0,
    selectedExteriorHypothesisCount: finalDebug.exteriorEvidenceSelectorV1?.selectedExteriorHypotheses.length ?? 0,
    selectedExteriorSpanCount: finalDebug.exteriorEvidenceSelectorV1?.selectedExteriorSpans.length ?? 0,
    grayWallComponentCount: finalDebug.grayWallMassReconstructionV1?.darkWallComponents.length ?? 0,
    grayWallVoidCount: finalDebug.grayWallMassReconstructionV1?.recoveredRoomVoids.length ?? 0,
    grayWallMaskSegmentCount: finalDebug.grayWallMassReconstructionV1?.maskDerivedSegments.length ?? 0,
    structuralRecoveredRunCount: finalDebug.structuralLineRecoveryV1?.connectedStructuralRuns.length ?? 0,
    structuralClosedLoopCount: finalDebug.structuralLineRecoveryV1?.closedStructuralLoops.length ?? 0,
    structuralBackfilledCount: finalDebug.structuralLineRecoveryV1?.acceptedBackfilledSegments.length ?? 0,
    faithfulWallRunCount: finalDebug.roomLineFaithfulReconstructionV1?.wallRuns.length ?? 0,
    faithfulExteriorRunCount: finalDebug.roomLineFaithfulReconstructionV1?.exteriorWallRuns.length ?? 0,
    faithfulInteriorRunCount: finalDebug.roomLineFaithfulReconstructionV1?.interiorWallRuns.length ?? 0,
    layoutPartitionRegionCount: finalDebug.apartmentLayoutPartitionV1?.layoutRegions.length ?? 0,
    layoutPartitionAssignedCellCount: finalDebug.apartmentLayoutPartitionV1?.apartmentLayoutPartitionV1.assignedCellCount ?? 0,
    layoutOpenPlanMacroRegionCount: finalDebug.apartmentLayoutPartitionV1?.openPlanMacroRegions.length ?? 0,
    roomTopologyCount: finalDebug.roomBoundedWallTopologyV1?.roomTopologies.length ?? 0,
    closedRoomTopologyCount: finalDebug.roomBoundedWallTopologyV1?.roomTopologies.filter((t) => t.closedOrNearClosed).length ?? 0,
    modelUsed: ai.hints.modelUsed,
    latencyMs: ai.hints.latencyMs,
  }, null, 2))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
