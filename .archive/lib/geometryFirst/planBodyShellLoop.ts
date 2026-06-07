/**
 * Debug-only: recover explicit **outer loop** candidate(s) from plan-only shell evidence
 * (junction-split wall graph + left-face cycle trace on shell segments, optionally augmented
 * by perimeter-aligned hypotheses/spans). Not production / not 3D extrusion.
 */

import type { ArchitecturalWallHypothesesDebugPayload } from "@/lib/geometryFirst/architecturalWallHypotheses"
import { segmentsNearlyEqual } from "@/lib/geometryFirst/architecturalWallHypotheses"
import type { GlobalStructuralSpansDebugPayload } from "@/lib/geometryFirst/globalStructuralSpans"
import { buildWallGraphFoundationFromCleaned } from "@/lib/geometryFirst/wallGraphFoundation"
import { splitWallLinesAtJunctions } from "@/lib/geometryFirst/splitWallLinesAtJunctions"
import type { ExtractedLineSegment, OuterCycleCandidateSummary, PlanBoundingBox } from "@/lib/geometryFirst/types"

export interface PlanBodyShellLoopOptions {
  /** Include extra plan segments near bbox perimeter that align with high exterior / shellHint axes. */
  augmentWithHypothesisSpanHints?: boolean
  maxAugmentSegments?: number
  perimeterBandPt?: number
  augmentExteriorLikelihoodMin?: number
  augmentShellHintMin?: number
}

const LOOP_OPT: Required<PlanBodyShellLoopOptions> = {
  augmentWithHypothesisSpanHints: true,
  maxAugmentSegments: 72,
  perimeterBandPt: 44,
  augmentExteriorLikelihoodMin: 0.4,
  augmentShellHintMin: 0.34,
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x))
}

function distToPerimeterInside(px: number, py: number, b: PlanBoundingBox): number {
  return Math.min(px - b.minX, b.maxX - px, py - b.minY, b.maxY - py)
}

function perimeterProximity(px: number, py: number, b: PlanBoundingBox, bandPt: number): number {
  const d = distToPerimeterInside(px, py, b)
  return clamp01(1 - d / Math.max(1e-6, bandPt))
}

/** Distance from P to segment AB (PDF space). */
function distPointToSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): number {
  const dx = x2 - x1
  const dy = y2 - y1
  const L2 = dx * dx + dy * dy
  if (L2 < 1e-12) return Math.hypot(px - x1, py - y1)
  let t = ((px - x1) * dx + (py - y1) * dy) / L2
  t = Math.max(0, Math.min(1, t))
  const qx = x1 + t * dx
  const qy = y1 + t * dy
  return Math.hypot(px - qx, py - qy)
}

function distPointToPolylineEdges(px: number, py: number, pts: Array<{ x: number; y: number }>): number {
  if (pts.length < 2) return Infinity
  let d = Infinity
  const n = pts.length
  for (let i = 0; i < n; i++) {
    const a = pts[i]!
    const b = pts[(i + 1) % n]!
    d = Math.min(d, distPointToSegment(px, py, a.x, a.y, b.x, b.y))
  }
  return d
}

function loopTouchesBboxSide(
  loopPts: Array<{ x: number; y: number }>,
  bbox: PlanBoundingBox,
  side: "top" | "bottom" | "left" | "right",
  sampleBand: number,
  hitBand: number
): boolean {
  const w = bbox.maxX - bbox.minX
  const h = bbox.maxY - bbox.minY
  const n = 10
  for (let i = 0; i <= n; i++) {
    const t = i / n
    let px: number
    let py: number
    if (side === "bottom") {
      px = bbox.minX + t * w
      py = bbox.minY + sampleBand * 0.35
    } else if (side === "top") {
      px = bbox.minX + t * w
      py = bbox.maxY - sampleBand * 0.35
    } else if (side === "left") {
      px = bbox.minX + sampleBand * 0.35
      py = bbox.minY + t * h
    } else {
      px = bbox.maxX - sampleBand * 0.35
      py = bbox.minY + t * h
    }
    if (distPointToPolylineEdges(px, py, loopPts) <= hitBand) return true
  }
  return false
}

function sideCoverageFromLoop(
  loopPts: Array<{ x: number; y: number }> | undefined,
  bbox: PlanBoundingBox,
  hitBand: number
): { top: boolean; bottom: boolean; left: boolean; right: boolean } {
  if (!loopPts || loopPts.length < 3) {
    return { top: false, bottom: false, left: false, right: false }
  }
  const sampleBand = Math.min(28, hitBand * 1.2)
  return {
    bottom: loopTouchesBboxSide(loopPts, bbox, "bottom", sampleBand, hitBand),
    top: loopTouchesBboxSide(loopPts, bbox, "top", sampleBand, hitBand),
    left: loopTouchesBboxSide(loopPts, bbox, "left", sampleBand, hitBand),
    right: loopTouchesBboxSide(loopPts, bbox, "right", sampleBand, hitBand),
  }
}

function augmentShellSegments(
  shellSegs: ExtractedLineSegment[],
  primaryLayoutSegments: ExtractedLineSegment[],
  primaryLayoutCleanedIndices: readonly number[],
  shellCandidateSet: Set<number>,
  bbox: PlanBoundingBox,
  hyps: ArchitecturalWallHypothesesDebugPayload,
  spans: GlobalStructuralSpansDebugPayload,
  O: Required<PlanBodyShellLoopOptions>
): { segments: ExtractedLineSegment[]; notes: string[] } {
  const notes: string[] = []
  if (!O.augmentWithHypothesisSpanHints) {
    return { segments: shellSegs, notes }
  }
  const out = shellSegs.slice()
  const seen = new Set<string>()
  for (const s of shellSegs) {
    seen.add(segKey(s))
  }
  let added = 0
  for (let li = 0; li < primaryLayoutSegments.length; li++) {
    if (added >= O.maxAugmentSegments) break
    const g = primaryLayoutCleanedIndices[li]
    if (g == null || shellCandidateSet.has(g)) continue
    const seg = primaryLayoutSegments[li]!
    const mx = (seg.x1 + seg.x2) / 2
    const my = (seg.y1 + seg.y2) / 2
    if (perimeterProximity(mx, my, bbox, O.perimeterBandPt) < 0.36) continue
    let align = false
    for (const h of hyps.hypotheses) {
      if (h.exteriorLikelihood < O.augmentExteriorLikelihoodMin) continue
      const c = h.centerline
      if (distPointToSegment(mx, my, c.x1, c.y1, c.x2, c.y2) < 9) {
        align = true
        break
      }
    }
    if (!align) {
      for (const sp of spans.spans) {
        if (sp.shellHintScore < O.augmentShellHintMin) continue
        const c = sp.centerline
        if (distPointToSegment(mx, my, c.x1, c.y1, c.x2, c.y2) < 11) {
          align = true
          break
        }
      }
    }
    if (!align) continue
    const k = segKey(seg)
    if (seen.has(k)) continue
    let dup = false
    for (const ex of out) {
      if (segmentsNearlyEqual(ex, seg, 0.9)) {
        dup = true
        break
      }
    }
    if (dup) continue
    seen.add(k)
    out.push(seg)
    added++
  }
  if (added > 0) {
    notes.push(`Augmented shell graph with ${added} perimeter-aligned plan segments (hypothesis/span hints).`)
  }
  return { segments: out, notes }
}

function segKey(s: ExtractedLineSegment): string {
  return `${s.x1.toFixed(2)},${s.y1.toFixed(2)},${s.x2.toFixed(2)},${s.y2.toFixed(2)}`
}

export interface PlanBodyShellLoopDebug {
  loopCandidateCount: number
  /** 1-based rank into `outerCycleTrace.candidateSummariesTop`, or 0 */
  bestLoopCandidateRank: number
  bestLoopClosed: boolean
  bestLoopPerimeterPt: number
  bestLoopStepSupportFraction: number
  bestLoopExteriorScaleHint: OuterCycleCandidateSummary["exteriorScaleHint"]
  closureConfidence: number
  sideCoverage: { top: boolean; bottom: boolean; left: boolean; right: boolean }
  /** Graph + trace notes */
  notes: string[]
  /** Subset of `outerCycleTrace` for payload size */
  candidateSummariesTop: OuterCycleCandidateSummary[]
  outerCycleTraceNotes: string[]
  graphNodeCount: number
  graphLargestComponentNodes: number
  segmentCountInput: number
  segmentCountAfterJunctionSplit: number
  augmentedSegmentAddCount: number
  /** Graph trace used for `fullVertexCycle` / SVG (omitted when graph not built). */
  outerCycleTrace?: import("@/lib/geometryFirst/types").OuterCycleTraceDebug
  /**
   * When the left-face walk does not close, convex hull of the largest component (debug envelope only).
   */
  fallbackHullVertices?: Array<{ x: number; y: number }>
}

export function buildPlanBodyShellLoop(
  primaryLayoutBBox: PlanBoundingBox,
  primaryLayoutSegments: ExtractedLineSegment[],
  primaryLayoutCleanedIndices: readonly number[],
  shellCandidateCleanedIndices: readonly number[],
  wallHypothesesPlanOnly: ArchitecturalWallHypothesesDebugPayload,
  globalSpansPlanOnly: GlobalStructuralSpansDebugPayload,
  opts?: PlanBodyShellLoopOptions
): PlanBodyShellLoopDebug {
  const O = { ...LOOP_OPT, ...opts }
  const shellSet = new Set(shellCandidateCleanedIndices)
  const shellSegs: ExtractedLineSegment[] = []
  for (let li = 0; li < primaryLayoutSegments.length; li++) {
    const g = primaryLayoutCleanedIndices[li]
    if (g != null && shellSet.has(g)) shellSegs.push(primaryLayoutSegments[li]!)
  }

  const aug = augmentShellSegments(
    shellSegs,
    primaryLayoutSegments,
    primaryLayoutCleanedIndices,
    shellSet,
    primaryLayoutBBox,
    wallHypothesesPlanOnly,
    globalSpansPlanOnly,
    O
  )
  const augmentedAdd = aug.segments.length - shellSegs.length

  const notes = [...aug.notes]
  if (shellSegs.length === 0) {
    notes.push("No shell-candidate segments inside plan crop — cannot build loop graph.")
    return emptyLoopDebug("empty shell segment set")
  }

  const { split: splitSegs } = splitWallLinesAtJunctions(aug.segments)
  const wallGraph = buildWallGraphFoundationFromCleaned(splitSegs, {
    nodeMergeQuantizationPt: 0.85,
    hullSegmentMatchTolPt: 1.75,
  })
  const trace = wallGraph.outerCycleTrace
  const summaries = trace.candidateSummariesTop
  const closedOnes = summaries.filter((s) => s.closed && s.cycleVertexCount >= 3)
  const bestClosed = closedOnes[0]
  const bestAny = summaries[0]
  const best = bestClosed ?? bestAny
  const bestRank = best ? summaries.indexOf(best) + 1 : 0

  const hullVerts = wallGraph.outerBoundaryCandidate.hullVerticesSample
  const fallbackHull =
    hullVerts.length >= 3 && !trace.closed ? hullVerts.map((p) => ({ x: p.x, y: p.y })) : undefined

  const fullLoop =
    trace.closed && trace.fullVertexCycle && trace.fullVertexCycle.length >= 3
      ? trace.fullVertexCycle
      : best?.vertexSample && best.vertexSample.length >= 3
        ? best.vertexSample
        : trace.vertexSample.length >= 3
          ? trace.vertexSample
          : fallbackHull

  const hitBand = 22
  let sideCoverage = sideCoverageFromLoop(fullLoop, primaryLayoutBBox, hitBand)
  if (!trace.closed && fallbackHull) {
    notes.push(
      "Left-face cycle did not close on shell subgraph — using convex-hull fallback for perimeter hints (not a true wall loop)."
    )
  }
  if (!trace.closed && fullLoop && fullLoop.length < 8) {
    notes.push("Best trace is open or sparse — side coverage may be unreliable.")
  }

  if (!sideCoverage.right) {
    notes.push("Right side of primaryLayoutBBox still weak relative to recovered loop — expect gap or interior offset.")
  }
  if (!sideCoverage.left || !sideCoverage.top || !sideCoverage.bottom) {
    const miss = ["left", "right", "top", "bottom"].filter(
      (k) => !sideCoverage[k as keyof typeof sideCoverage]
    )
    notes.push(`Perimeter touch weak on: ${miss.join(", ")} (heuristic sample vs loop polyline).`)
  }

  let closureConfidence = 0.12
  if (trace.found && trace.closed) {
    closureConfidence +=
      0.38 * trace.stepSupportFraction +
      0.18 * (closedOnes.length > 0 ? 1 : 0.4) +
      0.12 *
        (["top", "bottom", "left", "right"].filter((k) => sideCoverage[k as keyof typeof sideCoverage]).length / 4)
    if (trace.selectedExteriorScaleHint === "exterior-scale") closureConfidence += 0.12
    else if (trace.selectedExteriorScaleHint === "interior-scale") closureConfidence -= 0.08
  } else if (trace.attempted) {
    closureConfidence += 0.22 * trace.stepSupportFraction + 0.06
    notes.push("No closed left-face loop — best candidate may be an open chain or interior room loop.")
  }
  closureConfidence = clamp01(closureConfidence)

  notes.push(...trace.notes.slice(0, 3))

  return {
    loopCandidateCount: summaries.length,
    bestLoopCandidateRank: bestRank,
    bestLoopClosed: best?.closed ?? false,
    bestLoopPerimeterPt: best?.cyclePerimeterPt ?? trace.cyclePerimeterPt,
    bestLoopStepSupportFraction: clamp01(best?.stepSupportFraction ?? trace.stepSupportFraction),
    bestLoopExteriorScaleHint: trace.selectedExteriorScaleHint,
    closureConfidence,
    sideCoverage,
    notes,
    candidateSummariesTop: summaries.slice(0, 14),
    outerCycleTraceNotes: trace.notes,
    graphNodeCount: wallGraph.nodeCount,
    graphLargestComponentNodes: wallGraph.largestComponent.nodeCount,
    segmentCountInput: aug.segments.length,
    segmentCountAfterJunctionSplit: splitSegs.length,
    augmentedSegmentAddCount: augmentedAdd,
    outerCycleTrace: trace,
    fallbackHullVertices: fallbackHull,
  }
}

function emptyLoopDebug(reason: string): PlanBodyShellLoopDebug {
  return {
    loopCandidateCount: 0,
    bestLoopCandidateRank: 0,
    bestLoopClosed: false,
    bestLoopPerimeterPt: 0,
    bestLoopStepSupportFraction: 0,
    bestLoopExteriorScaleHint: "uncertain",
    closureConfidence: 0,
    sideCoverage: { top: false, bottom: false, left: false, right: false },
    notes: [reason],
    candidateSummariesTop: [],
    outerCycleTraceNotes: [],
    graphNodeCount: 0,
    graphLargestComponentNodes: 0,
    segmentCountInput: 0,
    segmentCountAfterJunctionSplit: 0,
    augmentedSegmentAddCount: 0,
    outerCycleTrace: undefined,
    fallbackHullVertices: undefined,
  }
}

export interface BuildPlanBodyShellLoopSvgOptions {
  pageBounds: PlanBoundingBox
  primaryLayoutBBox: PlanBoundingBox
  shellCandidateCleanedIndices: readonly number[]
  fullCleanedSegments: ExtractedLineSegment[]
  loopDebug: PlanBodyShellLoopDebug
  wallHypothesesPlanOnly: ArchitecturalWallHypothesesDebugPayload
  globalSpansPlanOnly: GlobalStructuralSpansDebugPayload
}

export function buildPlanBodyShellLoopSvgString(o: BuildPlanBodyShellLoopSvgOptions): string {
  const pb = o.pageBounds
  const w = pb.maxX - pb.minX
  const h = pb.maxY - pb.minY
  const bx = o.primaryLayoutBBox
  const shellSet = new Set(o.shellCandidateCleanedIndices)

  const hypFaint = o.wallHypothesesPlanOnly.svgStrokes
    .map(
      (st) =>
        `<path d="${escapeXml(st.d)}" fill="none" stroke="rgba(130,165,215,0.28)" stroke-width="0.75" stroke-linecap="round"/>`
    )
    .join("\n")
  const spanFaint = o.globalSpansPlanOnly.svgStrokes
    .map(
      (st) =>
        `<path d="${escapeXml(st.d)}" fill="none" stroke="rgba(175,140,210,0.26)" stroke-width="0.72" stroke-linecap="round"/>`
    )
    .join("\n")

  const shellEdges = o.fullCleanedSegments
    .map((s, i) => {
      if (!shellSet.has(i)) return ""
      return `<line x1="${s.x1}" y1="${s.y1}" x2="${s.x2}" y2="${s.y2}" stroke="rgba(100,100,110,0.45)" stroke-width="0.9" stroke-linecap="round"/>`
    })
    .join("\n")

  const tr = o.loopDebug.outerCycleTrace
  let loopPath = ""
  if (tr) {
    const pts = tr.fullVertexCycle && tr.fullVertexCycle.length >= 2 ? tr.fullVertexCycle : tr.vertexSample
    if (pts.length >= 2) {
      const d = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" ")
      const close = tr.closed && pts.length >= 3 ? " Z" : ""
      loopPath = `<path d="${escapeXml(d + close)}" fill="none" stroke="rgba(0,110,70,0.92)" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>`
    }
  }
  let hullPath = ""
  const fh = o.loopDebug.fallbackHullVertices
  if (fh && fh.length >= 3) {
    const d = fh.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" ") + " Z"
    hullPath = `<path d="${escapeXml(d)}" fill="rgba(255,200,120,0.06)" stroke="rgba(200,100,30,0.65)" stroke-width="1.3" stroke-dasharray="8 5"/>`
  }

  const altLoops = o.loopDebug.candidateSummariesTop
    .slice(1, 4)
    .filter((c) => c.vertexSample.length >= 2)
    .map((c) => {
      const d = c.vertexSample.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" ")
      const close = c.closed ? " Z" : ""
      const op = c.closed ? 0.55 : 0.35
      return `<path d="${escapeXml(d + close)}" fill="none" stroke="rgba(30,120,180,${op})" stroke-width="1.1" stroke-dasharray="6 5"/>`
    })
    .join("\n")

  const sc = o.loopDebug.sideCoverage
  const labels: string[] = []
  const midY = (bx.minY + bx.maxY) / 2
  const midX = (bx.minX + bx.maxX) / 2
  if (!sc.right) {
    labels.push(
      `<text x="${bx.maxX - 6}" y="${midY}" font-size="10" fill="#b33" text-anchor="end" font-family="system-ui,sans-serif">weak / missing →</text>`
    )
  }
  if (!sc.left) {
    labels.push(
      `<text x="${bx.minX + 6}" y="${midY}" font-size="10" fill="#b33" text-anchor="start" font-family="system-ui,sans-serif">← weak</text>`
    )
  }
  if (!sc.top) {
    labels.push(
      `<text x="${midX}" y="${bx.maxY - 8}" font-size="10" fill="#a62" text-anchor="middle" font-family="system-ui,sans-serif">weak top</text>`
    )
  }
  if (!sc.bottom) {
    labels.push(
      `<text x="${midX}" y="${bx.minY + 14}" font-size="10" fill="#a62" text-anchor="middle" font-family="system-ui,sans-serif">weak bottom</text>`
    )
  }

  const tr0 = o.loopDebug.outerCycleTrace
  const title = `Plan shell loop recovery — closed=${tr0?.closed ?? false} conf=${o.loopDebug.closureConfidence.toFixed(2)} extHint=${o.loopDebug.bestLoopExteriorScaleHint}`

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${pb.minX} ${pb.minY} ${w} ${h}" width="${Math.round(w)}" height="${Math.round(
    h
  )}">
<rect x="${pb.minX}" y="${pb.minY}" width="${w}" height="${h}" fill="white"/>
<text x="${pb.minX + 8}" y="${pb.minY + 14}" font-size="11" fill="#222" font-family="system-ui,sans-serif">${escapeXml(title)}</text>
<text x="${pb.minX + 8}" y="${pb.minY + 28}" font-size="9" fill="#555" font-family="system-ui,sans-serif">${escapeXml(
    `candidates=${o.loopDebug.loopCandidateCount} graph nodes=${o.loopDebug.graphNodeCount} splitSegs=${o.loopDebug.segmentCountAfterJunctionSplit}`
  )}</text>
<g>${spanFaint}</g>
<g>${hypFaint}</g>
<g>${shellEdges}</g>
<g>${altLoops}</g>
<g>${hullPath}</g>
<g>${loopPath}</g>
<rect x="${bx.minX}" y="${bx.minY}" width="${bx.maxX - bx.minX}" height="${bx.maxY - bx.minY}" fill="none" stroke="rgba(0,120,60,0.75)" stroke-width="2" stroke-dasharray="11 6"/>
${labels.join("\n")}
</svg>`
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;")
}
