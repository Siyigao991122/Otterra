/**
 * Debug-only: infer a coarse **exterior shell candidate** from the main-plan-body crop
 * (plan-only wall hypotheses + global spans + primaryLayoutBBox). Not used in production routing.
 */

import type { ArchitecturalWallHypothesesDebugPayload } from "@/lib/geometryFirst/architecturalWallHypotheses"
import type { GlobalStructuralSpansDebugPayload } from "@/lib/geometryFirst/globalStructuralSpans"
import type { ExtractedLineSegment, PlanBoundingBox } from "@/lib/geometryFirst/types"

export interface PlanBodyShellCandidateOptions {
  /** Band (pt) from `primaryLayoutBBox` inside which a stroke counts as “on the perimeter”. */
  perimeterBandPt?: number
  maxHypotheses?: number
  maxSpans?: number
  /** Min product (exterior × support × perimeterFactor) to keep a hypothesis when slots remain. */
  hypothesisScoreFloor?: number
  /** Min product (shellHint × perimeterFactor) for spans. */
  spanScoreFloor?: number
}

const OPT: Required<PlanBodyShellCandidateOptions> = {
  perimeterBandPt: 38,
  maxHypotheses: 22,
  maxSpans: 16,
  hypothesisScoreFloor: 0.07,
  spanScoreFloor: 0.11,
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x))
}

export function parseCleanedSegmentIndex(id: string): number | null {
  const m = /^c:(\d+)$/.exec(id.trim())
  return m ? parseInt(m[1]!, 10) : null
}

/** Distance from an interior point to the nearest side of the axis-aligned box (inside the box). */
function distToPerimeterInside(px: number, py: number, b: PlanBoundingBox): number {
  return Math.min(px - b.minX, b.maxX - px, py - b.minY, b.maxY - py)
}

function perimeterProximity(px: number, py: number, b: PlanBoundingBox, bandPt: number): number {
  const d = distToPerimeterInside(px, py, b)
  return clamp01(1 - d / Math.max(1e-6, bandPt))
}

function midCenterline(x1: number, y1: number, x2: number, y2: number): { x: number; y: number } {
  return { x: (x1 + x2) / 2, y: (y1 + y2) / 2 }
}

function unionSegBbox(s: ExtractedLineSegment): PlanBoundingBox {
  return {
    minX: Math.min(s.x1, s.x2),
    minY: Math.min(s.y1, s.y2),
    maxX: Math.max(s.x1, s.x2),
    maxY: Math.max(s.y1, s.y2),
  }
}

function unionBoxes(a: PlanBoundingBox, b: PlanBoundingBox): PlanBoundingBox {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  }
}

function edgePresence(
  selectedHyps: ArchitecturalWallHypothesesDebugPayload["hypotheses"],
  selectedSpans: GlobalStructuralSpansDebugPayload["spans"],
  bbox: PlanBoundingBox,
  band: number
): { top: boolean; bottom: boolean; left: boolean; right: boolean } {
  const out = { top: false, bottom: false, left: false, right: false }
  const touch = (px: number, py: number) => {
    if (py <= bbox.minY + band) out.bottom = true
    if (py >= bbox.maxY - band) out.top = true
    if (px <= bbox.minX + band) out.left = true
    if (px >= bbox.maxX - band) out.right = true
  }
  for (const h of selectedHyps) {
    const m = midCenterline(h.centerline.x1, h.centerline.y1, h.centerline.x2, h.centerline.y2)
    touch(m.x, m.y)
  }
  for (const s of selectedSpans) {
    const m = midCenterline(s.centerline.x1, s.centerline.y1, s.centerline.x2, s.centerline.y2)
    touch(m.x, m.y)
  }
  return out
}

export interface PlanBodyShellCandidateDebug {
  shellCandidateCleanedIndices: number[]
  shellCandidateBbox: PlanBoundingBox
  confidence: number
  selectedHypothesisIds: string[]
  selectedSpanIds: string[]
  notes: string[]
  edgePresence: { top: boolean; bottom: boolean; left: boolean; right: boolean }
  /** Hypotheses whose interior score exceeds exterior (possible partitions picked up). */
  ambiguousInteriorLikelihoodIds: string[]
}

/**
 * Pick shell-likely evidence from plan-only hypotheses/spans; map to **global** cleaned indices.
 */
export function buildPlanBodyShellCandidate(
  fullCleanedSegments: ExtractedLineSegment[],
  primaryLayoutBBox: PlanBoundingBox,
  primaryLayoutCleanedIndices: readonly number[],
  wallHypothesesPlanOnly: ArchitecturalWallHypothesesDebugPayload,
  globalSpansPlanOnly: GlobalStructuralSpansDebugPayload,
  opts?: PlanBodyShellCandidateOptions
): PlanBodyShellCandidateDebug {
  const O = { ...OPT, ...opts }
  const notes: string[] = []
  const band = O.perimeterBandPt

  type HScored = { h: (typeof wallHypothesesPlanOnly.hypotheses)[0]; score: number; perim: number }
  const hypRanked: HScored[] = wallHypothesesPlanOnly.hypotheses.map((h) => {
    const m = midCenterline(h.centerline.x1, h.centerline.y1, h.centerline.x2, h.centerline.y2)
    const perim = perimeterProximity(m.x, m.y, primaryLayoutBBox, band)
    const score = h.exteriorLikelihood * h.supportScore * (0.32 + 0.68 * perim)
    return { h, score, perim }
  })
  hypRanked.sort((a, b) => b.score - a.score)

  const pickedHyps: (typeof wallHypothesesPlanOnly.hypotheses)[0][] = []
  for (const row of hypRanked) {
    if (pickedHyps.length >= O.maxHypotheses) break
    if (row.score < O.hypothesisScoreFloor && pickedHyps.length >= 6) break
    if (row.h.exteriorLikelihood < 0.14 && row.perim < 0.2) continue
    if (
      row.h.exteriorLikelihood < 0.3 &&
      row.h.interiorLikelihood > row.h.exteriorLikelihood + 0.1 &&
      row.perim < 0.28
    ) {
      continue
    }
    pickedHyps.push(row.h)
  }

  type SScored = { s: (typeof globalSpansPlanOnly.spans)[0]; score: number; perim: number }
  const spanRanked: SScored[] = globalSpansPlanOnly.spans.map((s) => {
    const m = midCenterline(s.centerline.x1, s.centerline.y1, s.centerline.x2, s.centerline.y2)
    const perim = perimeterProximity(m.x, m.y, primaryLayoutBBox, band)
    const score = s.shellHintScore * (0.25 + 0.75 * perim)
    return { s, score, perim }
  })
  spanRanked.sort((a, b) => b.score - a.score)

  const pickedSpans: (typeof globalSpansPlanOnly.spans)[0][] = []
  for (const row of spanRanked) {
    if (pickedSpans.length >= O.maxSpans) break
    if (row.score < O.spanScoreFloor && pickedSpans.length >= 4) break
    if (row.s.shellHintScore < 0.12 && row.perim < 0.22) continue
    pickedSpans.push(row.s)
  }

  const idxSet = new Set<number>()
  const addGlobal = (g: number | undefined) => {
    if (g != null && g >= 0 && g < fullCleanedSegments.length) idxSet.add(g)
  }

  for (const h of pickedHyps) {
    for (const sid of h.sourceSegmentIds) {
      const local = parseCleanedSegmentIndex(sid)
      if (local == null) continue
      const g = primaryLayoutCleanedIndices[local]
      addGlobal(g)
    }
  }
  for (const s of pickedSpans) {
    for (const sid of s.sourceSegmentIds) {
      const g = parseCleanedSegmentIndex(sid)
      if (g != null) addGlobal(g)
    }
  }

  const shellCandidateCleanedIndices = [...idxSet].sort((a, b) => a - b)

  let shellBbox: PlanBoundingBox | null = null
  for (const i of shellCandidateCleanedIndices) {
    const seg = fullCleanedSegments[i]
    if (!seg) continue
    const bb = unionSegBbox(seg)
    shellBbox = shellBbox ? unionBoxes(shellBbox, bb) : bb
  }
  if (!shellBbox || shellCandidateCleanedIndices.length === 0) {
    shellBbox = { ...primaryLayoutBBox }
    notes.push("No shell segments resolved — bbox falls back to primaryLayoutBBox.")
  }

  const ambiguousInteriorLikelihoodIds = pickedHyps
    .filter((h) => h.interiorLikelihood > h.exteriorLikelihood + 0.12)
    .map((h) => h.id)

  if (ambiguousInteriorLikelihoodIds.length > 0) {
    notes.push(
      `${ambiguousInteriorLikelihoodIds.length} selected hypotheses tilt interior-over-exterior — may be partitions, not shell.`
    )
  }

  const edges = edgePresence(pickedHyps, pickedSpans, primaryLayoutBBox, band)
  const sidesCovered = [edges.top, edges.bottom, edges.left, edges.right].filter(Boolean).length
  if (sidesCovered < 3) {
    notes.push(
      `Weak perimeter coverage: only ${sidesCovered}/4 sides have shell-likely centers within ${band.toFixed(0)}pt of primary bbox — outline likely incomplete or oblique.`
    )
  }

  let confidence =
    0.18 +
    0.22 * clamp01(pickedHyps.length / 10) +
    0.2 * clamp01(pickedSpans.length / 8) +
    0.18 * clamp01(sidesCovered / 4)
  if (pickedHyps.length > 0) {
    confidence += 0.12 * clamp01(pickedHyps.reduce((s, h) => s + h.exteriorLikelihood, 0) / pickedHyps.length)
  }
  if (pickedSpans.length > 0) {
    confidence += 0.1 * clamp01(pickedSpans.reduce((s, sp) => s + sp.shellHintScore, 0) / pickedSpans.length)
  }
  confidence = clamp01(confidence)
  if (shellCandidateCleanedIndices.length < 12) {
    notes.push("Few cleaned segments in shell candidate — crop may be tight or vector gaps large.")
    confidence *= 0.88
  }

  notes.push(
    `Shell candidate: ${pickedHyps.length} hypotheses + ${pickedSpans.length} spans → ${shellCandidateCleanedIndices.length} unique cleaned segments (plan crop).`
  )

  return {
    shellCandidateCleanedIndices,
    shellCandidateBbox: shellBbox,
    confidence: clamp01(confidence),
    selectedHypothesisIds: pickedHyps.map((h) => h.id),
    selectedSpanIds: pickedSpans.map((s) => s.id),
    notes,
    edgePresence: edges,
    ambiguousInteriorLikelihoodIds,
  }
}

export interface BuildPlanBodyShellCandidateSvgOptions {
  pageBounds: PlanBoundingBox
  primaryLayoutBBox: PlanBoundingBox
  wallHypothesesPlanOnly: ArchitecturalWallHypothesesDebugPayload
  globalSpansPlanOnly: GlobalStructuralSpansDebugPayload
  shell: PlanBodyShellCandidateDebug
  fullCleanedSegments: ExtractedLineSegment[]
}

export function buildPlanBodyShellCandidateSvgString(o: BuildPlanBodyShellCandidateSvgOptions): string {
  const pb = o.pageBounds
  const w = pb.maxX - pb.minX
  const h = pb.maxY - pb.minY
  const bx = o.primaryLayoutBBox
  const selH = new Set(o.shell.selectedHypothesisIds)
  const selS = new Set(o.shell.selectedSpanIds)
  const shellIdx = new Set(o.shell.shellCandidateCleanedIndices)

  const hypLines = o.wallHypothesesPlanOnly.svgStrokes
    .map((st) => {
      const on = selH.has(st.id)
      const stroke = on ? "rgba(220,90,20,0.95)" : "rgba(120,160,210,0.35)"
      const sw = on ? 2.4 : 0.9
      return `<path d="${escapeXml(st.d)}" fill="none" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round"/>`
    })
    .join("\n")

  const spanLines = o.globalSpansPlanOnly.svgStrokes
    .map((st) => {
      const on = selS.has(st.id)
      const stroke = on ? "rgba(20,150,120,0.95)" : "rgba(160,130,200,0.32)"
      const sw = on ? 2.2 : 0.85
      return `<path d="${escapeXml(st.d)}" fill="none" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round"/>`
    })
    .join("\n")

  const shellSegs = o.fullCleanedSegments
    .map((s, i) => {
      if (!shellIdx.has(i)) return ""
      return `<line x1="${s.x1}" y1="${s.y1}" x2="${s.x2}" y2="${s.y2}" stroke="rgba(40,40,40,0.88)" stroke-width="1.35" stroke-linecap="round"/>`
    })
    .join("\n")

  const sh = o.shell.shellCandidateBbox
  const edge = o.shell.edgePresence
  const edgeTxt = `Edges T:${edge.top ? "✓" : "·"} B:${edge.bottom ? "✓" : "·"} L:${edge.left ? "✓" : "·"} R:${edge.right ? "✓" : "·"}`

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${pb.minX} ${pb.minY} ${w} ${h}" width="${Math.round(w)}" height="${Math.round(
    h
  )}">
<rect x="${pb.minX}" y="${pb.minY}" width="${w}" height="${h}" fill="white"/>
<text x="${pb.minX + 8}" y="${pb.minY + 14}" font-size="11" fill="#222" font-family="system-ui,sans-serif">${escapeXml(
    `Plan-body shell candidate (debug) — conf ${o.shell.confidence.toFixed(2)}`
  )}</text>
<text x="${pb.minX + 8}" y="${pb.minY + 28}" font-size="9.5" fill="#555" font-family="system-ui,sans-serif">${escapeXml(
    `${edgeTxt} — blue faint: all plan hyps; purple: plan spans; orange/teal: selected; dark strokes: cleaned shell segments`
  )}</text>
<g opacity="1">${spanLines}</g>
<g opacity="1">${hypLines}</g>
<g>${shellSegs}</g>
<rect x="${bx.minX}" y="${bx.minY}" width="${bx.maxX - bx.minX}" height="${bx.maxY - bx.minY}" fill="none" stroke="rgba(0,120,60,0.85)" stroke-width="2" stroke-dasharray="12 7"/>
<rect x="${sh.minX}" y="${sh.minY}" width="${sh.maxX - sh.minX}" height="${sh.maxY - sh.minY}" fill="none" stroke="rgba(180,60,20,0.55)" stroke-width="1.2" stroke-dasharray="4 4"/>
</svg>`
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;")
}
