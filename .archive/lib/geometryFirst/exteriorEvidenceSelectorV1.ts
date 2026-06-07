import type {
  ArchitecturalWallHypothesesDebugPayload,
  ArchitecturalWallHypothesis,
} from "@/lib/geometryFirst/architecturalWallHypotheses"
import type { GlobalStructuralSpan, GlobalStructuralSpansDebugPayload } from "@/lib/geometryFirst/globalStructuralSpans"
import type { ExtractedLineSegment, ExtractedTextRun, PlanBoundingBox } from "@/lib/geometryFirst/types"

type Pt = { x: number; y: number }
type Orient = "H" | "V"
type CandidateSource = "segment" | "hypothesis" | "span"

interface ShellEdge {
  index: number
  orient: Orient
  coord: number
  from: number
  to: number
  outwardSign: number
}

interface MatchResult {
  shellEdgeIndex: number
  shellProximityScore: number
  silhouetteSupportScore: number
  outwardFacingScore: number
}

interface ExteriorEvidenceCandidateBase {
  id: string
  source: CandidateSource
  x1: number
  y1: number
  x2: number
  y2: number
  length: number
  orientation: "horizontal" | "vertical" | "diagonal"
  exteriorScore: number
  shellProximityScore: number
  longRunScore: number
  silhouetteSupportScore: number
  blankSpaceScore: number
  cornerCompatibilityScore: number
  interiorPenalty: number
  selected: boolean
  matchedShellEdgeIndex: number | null
}

export interface ExteriorEvidenceSelectorSegment extends ExteriorEvidenceCandidateBase {
  source: "segment"
}

export interface ExteriorEvidenceSelectorHypothesis extends ExteriorEvidenceCandidateBase {
  source: "hypothesis"
  supportType: ArchitecturalWallHypothesis["supportType"]
  supportScore: number
  exteriorLikelihood: number
  interiorLikelihood: number
}

export interface ExteriorEvidenceSelectorSpan extends ExteriorEvidenceCandidateBase {
  source: "span"
  sourceSegmentCount: number
  structuralSupportScore: number
  shellHintScore: number
}

export interface ExteriorEvidenceSelectorRejectedEvidence extends ExteriorEvidenceCandidateBase {}

export interface ExteriorEvidenceSelectorV1Debug {
  exteriorEvidenceSelectorV1: {
    shellVertexCount: number
    selectedSegmentCount: number
    selectedHypothesisCount: number
    selectedSpanCount: number
    rejectedInteriorLikeCount: number
  }
  selectedExteriorSegments: ExteriorEvidenceSelectorSegment[]
  selectedExteriorHypotheses: ExteriorEvidenceSelectorHypothesis[]
  selectedExteriorSpans: ExteriorEvidenceSelectorSpan[]
  rejectedInteriorLikeEvidence: ExteriorEvidenceSelectorRejectedEvidence[]
  evidenceScoreSummary: string
  selectorStatement: string
  notes: string[]
  currentShellPolygon: Pt[]
}

export interface BuildExteriorEvidenceSelectorV1SvgOptions {
  pageBounds: PlanBoundingBox
  selector: ExteriorEvidenceSelectorV1Debug
}

const OPT = {
  axisTol: 6,
  minLength: 10,
  searchDist: 34,
  overlapMin: 0.12,
  outwardBand: 18,
  cornerRadius: 30,
  selectedScore: 0.58,
  selectedShellProximity: 0.65,
  selectedSilhouette: 0.35,
  selectedFallbackScore: 0.48,
  rejectedScore: 0.38,
  interiorRadius: 40,
  maxRejectedSvg: 80,
} as const

const INTERIOR_LABEL_RE = /\b(bath|closet|wc|powder|foyer|entry|hall|laundry|store|storage)\b/i

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x))
}

function distance(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function segmentLength(a: Pt, b: Pt): number {
  return Math.hypot(b.x - a.x, b.y - a.y)
}

function axisOrient(a: Pt, b: Pt): Orient | null {
  const dx = b.x - a.x
  const dy = b.y - a.y
  if (Math.abs(dy) <= OPT.axisTol && Math.abs(dx) >= OPT.minLength) return "H"
  if (Math.abs(dx) <= OPT.axisTol && Math.abs(dy) >= OPT.minLength) return "V"
  return null
}

function dedupConsecutive(poly: Pt[], tol = 1.5): Pt[] {
  const out: Pt[] = []
  for (const p of poly) {
    const prev = out[out.length - 1]
    if (prev && distance(prev, p) <= tol) continue
    out.push({ x: p.x, y: p.y })
  }
  if (out.length >= 2 && distance(out[0]!, out[out.length - 1]!) <= tol) out.pop()
  return out
}

function axisSnapPoly(poly: Pt[]): Pt[] {
  if (poly.length < 3) return poly
  const out: Pt[] = []
  for (let i = 0; i < poly.length; i++) {
    const a = poly[(i - 1 + poly.length) % poly.length]!
    const b = poly[i]!
    const c = poly[(i + 1) % poly.length]!
    let x = b.x
    let y = b.y
    if (Math.abs(a.x - b.x) <= OPT.axisTol) x = a.x
    if (Math.abs(c.x - b.x) <= OPT.axisTol) x = c.x
    if (Math.abs(a.y - b.y) <= OPT.axisTol) y = a.y
    if (Math.abs(c.y - b.y) <= OPT.axisTol) y = c.y
    out.push({ x, y })
  }
  return dedupConsecutive(out)
}

function normalizeLoop(poly: Pt[]): Pt[] {
  return axisSnapPoly(dedupConsecutive(poly))
}

function signedArea(poly: Pt[]): number {
  if (poly.length < 3) return 0
  let sum = 0
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!
    const b = poly[(i + 1) % poly.length]!
    sum += a.x * b.y - b.x * a.y
  }
  return sum / 2
}

function overlapLen(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0))
}

function overlapRatio(a0: number, a1: number, b0: number, b1: number): number {
  const ov = overlapLen(a0, a1, b0, b1)
  const denom = Math.max(1, Math.min(a1 - a0, b1 - b0))
  return ov / denom
}

function buildShellEdges(shellPolygon: Pt[]): ShellEdge[] {
  const loop = normalizeLoop(shellPolygon)
  const clockwise = signedArea(loop) > 0
  const edges: ShellEdge[] = []
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i]!
    const b = loop[(i + 1) % loop.length]!
    const orient = axisOrient(a, b)
    if (!orient) continue
    const dir = orient === "H" ? (b.x >= a.x ? 1 : -1) : b.y >= a.y ? 1 : -1
    let outwardSign = 0
    if (orient === "H") {
      const leftNormalSign = dir > 0 ? -1 : 1
      outwardSign = clockwise ? leftNormalSign : -leftNormalSign
    } else {
      const leftNormalSign = dir > 0 ? 1 : -1
      outwardSign = clockwise ? leftNormalSign : -leftNormalSign
    }
    edges.push({
      index: i,
      orient,
      coord: orient === "H" ? (a.y + b.y) / 2 : (a.x + b.x) / 2,
      from: orient === "H" ? Math.min(a.x, b.x) : Math.min(a.y, b.y),
      to: orient === "H" ? Math.max(a.x, b.x) : Math.max(a.y, b.y),
      outwardSign,
    })
  }
  return edges
}

function interiorLabelPenalty(point: Pt, texts: ExtractedTextRun[]): number {
  let penalty = 0
  const r2 = OPT.interiorRadius * OPT.interiorRadius
  for (const t of texts) {
    if (!INTERIOR_LABEL_RE.test(t.text)) continue
    const cx = t.x + (t.width ?? 0) / 2
    const cy = t.y + (t.height ?? 0) / 2
    const dx = point.x - cx
    const dy = point.y - cy
    if (dx * dx + dy * dy <= r2) penalty = Math.max(penalty, 0.55)
  }
  return penalty
}

function bestShellMatch(
  orient: Orient | null,
  coord: number,
  from: number,
  to: number,
  shellEdges: ShellEdge[]
): MatchResult | null {
  if (!orient) return null
  let best: MatchResult | null = null
  let bestScore = -1
  for (const edge of shellEdges) {
    if (edge.orient !== orient) continue
    const near = Math.abs(edge.coord - coord)
    if (near > OPT.searchDist) continue
    const ov = overlapRatio(from, to, edge.from, edge.to)
    if (ov < OPT.overlapMin) continue
    const proximity = clamp01(1 - near / OPT.searchDist)
    const delta = (coord - edge.coord) * edge.outwardSign
    const outward = clamp01(1 - Math.abs(delta) / OPT.outwardBand) * (delta >= -6 ? 1 : 0.45)
    const candidateScore = proximity * 0.55 + ov * 0.3 + outward * 0.15
    if (candidateScore > bestScore) {
      bestScore = candidateScore
      best = {
        shellEdgeIndex: edge.index,
        shellProximityScore: proximity,
        silhouetteSupportScore: proximity * ov,
        outwardFacingScore: outward,
      }
    }
  }
  return best
}

function cornerCompatibility(a: Pt, b: Pt, shellCorners: Pt[]): number {
  let best = 0
  for (const c of shellCorners) {
    const d = Math.min(distance(a, c), distance(b, c))
    best = Math.max(best, clamp01(1 - d / OPT.cornerRadius))
  }
  return best
}

function asSegmentGeometry(s: ExtractedLineSegment): { a: Pt; b: Pt; orientation: "horizontal" | "vertical" | "diagonal"; coord: number; from: number; to: number } {
  const a = { x: s.x1, y: s.y1 }
  const b = { x: s.x2, y: s.y2 }
  const orient = axisOrient(a, b)
  if (orient === "H") {
    return { a, b, orientation: "horizontal", coord: (a.y + b.y) / 2, from: Math.min(a.x, b.x), to: Math.max(a.x, b.x) }
  }
  if (orient === "V") {
    return { a, b, orientation: "vertical", coord: (a.x + b.x) / 2, from: Math.min(a.y, b.y), to: Math.max(a.y, b.y) }
  }
  return { a, b, orientation: "diagonal", coord: 0, from: 0, to: 0 }
}

function scoreCommon(input: {
  id: string
  source: CandidateSource
  x1: number
  y1: number
  x2: number
  y2: number
  priorExterior: number
  continuityBonus: number
  shellEdges: ShellEdge[]
  shellCorners: Pt[]
  texts: ExtractedTextRun[]
}): ExteriorEvidenceCandidateBase {
  const a = { x: input.x1, y: input.y1 }
  const b = { x: input.x2, y: input.y2 }
  const len = segmentLength(a, b)
  const geom = asSegmentGeometry({ x1: input.x1, y1: input.y1, x2: input.x2, y2: input.y2 })
  const orient = geom.orientation
  const match =
    orient === "horizontal"
      ? bestShellMatch("H", geom.coord, geom.from, geom.to, input.shellEdges)
      : orient === "vertical"
        ? bestShellMatch("V", geom.coord, geom.from, geom.to, input.shellEdges)
        : null
  const shellProximityScore = match?.shellProximityScore ?? 0
  const silhouetteSupportScore = match?.silhouetteSupportScore ?? 0
  const blankSpaceScore = match?.outwardFacingScore ?? 0
  const cornerCompatibilityScore = cornerCompatibility(a, b, input.shellCorners)
  const longRunScore = clamp01(len / 140) * 0.7 + clamp01(input.continuityBonus) * 0.3
  const midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  const interiorPenalty =
    interiorLabelPenalty(midpoint, input.texts) +
    (len < 40 ? clamp01((40 - len) / 28) * 0.32 : 0) +
    (shellProximityScore < 0.22 ? 0.16 : 0)
  const exteriorScore = clamp01(
    shellProximityScore * 0.24 +
      silhouetteSupportScore * 0.22 +
      blankSpaceScore * 0.15 +
      cornerCompatibilityScore * 0.1 +
      longRunScore * 0.16 +
      input.priorExterior * 0.2 -
      interiorPenalty * 0.34
  )
  const selected =
    exteriorScore >= OPT.selectedScore ||
    (exteriorScore >= OPT.selectedFallbackScore &&
      shellProximityScore >= OPT.selectedShellProximity &&
      silhouetteSupportScore >= OPT.selectedSilhouette)
  return {
    id: input.id,
    source: input.source,
    x1: input.x1,
    y1: input.y1,
    x2: input.x2,
    y2: input.y2,
    length: len,
    orientation: orient,
    exteriorScore,
    shellProximityScore,
    longRunScore,
    silhouetteSupportScore,
    blankSpaceScore,
    cornerCompatibilityScore,
    interiorPenalty,
    selected,
    matchedShellEdgeIndex: match?.shellEdgeIndex ?? null,
  }
}

function scoreSegment(
  segment: ExtractedLineSegment,
  index: number,
  shellEdges: ShellEdge[],
  shellCorners: Pt[],
  texts: ExtractedTextRun[]
): ExteriorEvidenceSelectorSegment {
  return scoreCommon({
    id: `seg:${index}`,
    source: "segment",
    x1: segment.x1,
    y1: segment.y1,
    x2: segment.x2,
    y2: segment.y2,
    priorExterior: 0.18,
    continuityBonus: clamp01(segmentLength({ x: segment.x1, y: segment.y1 }, { x: segment.x2, y: segment.y2 }) / 180),
    shellEdges,
    shellCorners,
    texts,
  }) as ExteriorEvidenceSelectorSegment
}

function scoreHypothesis(
  hypothesis: ArchitecturalWallHypothesis,
  shellEdges: ShellEdge[],
  shellCorners: Pt[],
  texts: ExtractedTextRun[]
): ExteriorEvidenceSelectorHypothesis {
  const scored = scoreCommon({
    id: hypothesis.id,
    source: "hypothesis",
    x1: hypothesis.centerline.x1,
    y1: hypothesis.centerline.y1,
    x2: hypothesis.centerline.x2,
    y2: hypothesis.centerline.y2,
    priorExterior: clamp01(hypothesis.exteriorLikelihood * 0.8 + hypothesis.supportScore * 0.35 - hypothesis.interiorLikelihood * 0.28),
    continuityBonus: clamp01(hypothesis.sourceSegmentIds.length / 5),
    shellEdges,
    shellCorners,
    texts,
  }) as ExteriorEvidenceSelectorHypothesis
  scored.supportType = hypothesis.supportType
  scored.supportScore = hypothesis.supportScore
  scored.exteriorLikelihood = hypothesis.exteriorLikelihood
  scored.interiorLikelihood = hypothesis.interiorLikelihood
  return scored
}

function scoreSpan(
  span: GlobalStructuralSpan,
  shellEdges: ShellEdge[],
  shellCorners: Pt[],
  texts: ExtractedTextRun[]
): ExteriorEvidenceSelectorSpan {
  const scored = scoreCommon({
    id: span.id,
    source: "span",
    x1: span.centerline.x1,
    y1: span.centerline.y1,
    x2: span.centerline.x2,
    y2: span.centerline.y2,
    priorExterior: clamp01(span.shellHintScore * 0.85 + span.structuralSupportScore * 0.25),
    continuityBonus: clamp01(span.sourceSegmentCount / 6),
    shellEdges,
    shellCorners,
    texts,
  }) as ExteriorEvidenceSelectorSpan
  scored.sourceSegmentCount = span.sourceSegmentCount
  scored.structuralSupportScore = span.structuralSupportScore
  scored.shellHintScore = span.shellHintScore
  return scored
}

function sortByScoreDesc<T extends { exteriorScore: number; length: number }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => b.exteriorScore - a.exteriorScore || b.length - a.length)
}

function rejectedFrom(all: ExteriorEvidenceCandidateBase[]): ExteriorEvidenceSelectorRejectedEvidence[] {
  return sortByScoreDesc(
    all.filter((row) => !row.selected && (row.exteriorScore <= OPT.rejectedScore || row.interiorPenalty >= 0.5))
  )
    .slice(0, OPT.maxRejectedSvg)
    .map((row) => ({ ...row }))
}

export function buildExteriorEvidenceSelectorV1(
  currentShellPolygon: Pt[],
  primaryLayoutSegments: ExtractedLineSegment[],
  wallHypothesesPlanOnly: ArchitecturalWallHypothesesDebugPayload,
  globalSpansPlanOnly: GlobalStructuralSpansDebugPayload,
  texts: ExtractedTextRun[]
): ExteriorEvidenceSelectorV1Debug {
  const notes: string[] = []
  const shell = normalizeLoop(currentShellPolygon)
  if (shell.length < 4) {
    return {
      exteriorEvidenceSelectorV1: {
        shellVertexCount: shell.length,
        selectedSegmentCount: 0,
        selectedHypothesisCount: 0,
        selectedSpanCount: 0,
        rejectedInteriorLikeCount: 0,
      },
      selectedExteriorSegments: [],
      selectedExteriorHypotheses: [],
      selectedExteriorSpans: [],
      rejectedInteriorLikeEvidence: [],
      evidenceScoreSummary: "Exterior selector v1 skipped because the current shell was invalid.",
      selectorStatement: "Exterior evidence selector v1 skipped.",
      notes: ["Current shell had insufficient vertices."],
      currentShellPolygon: shell,
    }
  }

  const shellEdges = buildShellEdges(shell)
  const shellCorners = shell
  const scoredSegments = primaryLayoutSegments.map((s, i) => scoreSegment(s, i, shellEdges, shellCorners, texts))
  const scoredHypotheses = wallHypothesesPlanOnly.hypotheses.map((h) => scoreHypothesis(h, shellEdges, shellCorners, texts))
  const scoredSpans = globalSpansPlanOnly.spans.map((s) => scoreSpan(s, shellEdges, shellCorners, texts))

  const selectedExteriorSegments = sortByScoreDesc(scoredSegments).filter((row) => row.selected)
  const selectedExteriorHypotheses = sortByScoreDesc(scoredHypotheses).filter((row) => row.selected)
  const selectedExteriorSpans = sortByScoreDesc(scoredSpans).filter((row) => row.selected)
  const rejectedInteriorLikeEvidence = rejectedFrom([
    ...scoredSegments,
    ...scoredHypotheses,
    ...scoredSpans,
  ])

  const evidenceScoreSummary =
    `Exterior selector v1 scored ${scoredSegments.length} primary segment(s), ` +
    `${scoredHypotheses.length} hypothesis/hypotheses, ${scoredSpans.length} span(s); selected ` +
    `${selectedExteriorSegments.length}/${selectedExteriorHypotheses.length}/${selectedExteriorSpans.length} by source.`
  const selectorStatement =
    `Exterior evidence selector v1: ${selectedExteriorSegments.length} segment(s), ` +
    `${selectedExteriorHypotheses.length} hypothesis/hypotheses, ${selectedExteriorSpans.length} span(s) selected; ` +
    `${rejectedInteriorLikeEvidence.length} rejected interior-like evidence row(s) shown in debug.`

  const avgSelectedScore = (rows: Array<{ exteriorScore: number }>): number =>
    rows.length ? rows.reduce((sum, row) => sum + row.exteriorScore, 0) / rows.length : 0

  notes.push(
    `Mean selected scores — segments ${avgSelectedScore(selectedExteriorSegments).toFixed(2)}, hypotheses ${avgSelectedScore(selectedExteriorHypotheses).toFixed(2)}, spans ${avgSelectedScore(selectedExteriorSpans).toFixed(2)}.`
  )
  notes.push(
    `Rejected interior-like evidence is dominated by rows with low shell proximity or interior-label penalties near bath/closet/foyer zones.`
  )

  return {
    exteriorEvidenceSelectorV1: {
      shellVertexCount: shell.length,
      selectedSegmentCount: selectedExteriorSegments.length,
      selectedHypothesisCount: selectedExteriorHypotheses.length,
      selectedSpanCount: selectedExteriorSpans.length,
      rejectedInteriorLikeCount: rejectedInteriorLikeEvidence.length,
    },
    selectedExteriorSegments,
    selectedExteriorHypotheses,
    selectedExteriorSpans,
    rejectedInteriorLikeEvidence,
    evidenceScoreSummary,
    selectorStatement,
    notes,
    currentShellPolygon: shell,
  }
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;")
}

function pathFromPoly(pts: Pt[], close: boolean): string {
  if (pts.length < 2) return ""
  let d = `M ${pts[0]!.x.toFixed(2)} ${pts[0]!.y.toFixed(2)}`
  for (let i = 1; i < pts.length; i++) d += ` L ${pts[i]!.x.toFixed(2)} ${pts[i]!.y.toFixed(2)}`
  if (close) d += " Z"
  return d
}

function lineSvg(row: { x1: number; y1: number; x2: number; y2: number }, color: string, width: number, dash = ""): string {
  return `<line x1="${row.x1.toFixed(1)}" y1="${row.y1.toFixed(1)}" x2="${row.x2.toFixed(1)}" y2="${row.y2.toFixed(1)}" stroke="${color}" stroke-width="${width}" ${dash ? `stroke-dasharray="${dash}"` : ""}/>`
}

export function buildExteriorEvidenceSelectorV1SvgString(
  o: BuildExteriorEvidenceSelectorV1SvgOptions
): string {
  const pb = o.pageBounds
  const w = pb.maxX - pb.minX
  const h = pb.maxY - pb.minY
  const shellPath =
    o.selector.currentShellPolygon.length >= 3
      ? `<path d="${escapeXml(pathFromPoly(o.selector.currentShellPolygon, true))}" fill="rgba(30,160,80,0.04)" stroke="rgba(30,160,80,0.42)" stroke-width="1.6" stroke-dasharray="6 4"/>`
      : ""
  const rejected = o.selector.rejectedInteriorLikeEvidence
    .map((row) => lineSvg(row, "rgba(150,150,150,0.22)", 0.9))
    .join("")
  const segments = o.selector.selectedExteriorSegments
    .map((row) => lineSvg(row, "rgba(20,140,70,0.92)", 1.6))
    .join("")
  const hypotheses = o.selector.selectedExteriorHypotheses
    .map((row) => lineSvg(row, "rgba(30,90,220,0.82)", 2.1))
    .join("")
  const spans = o.selector.selectedExteriorSpans
    .map((row) => lineSvg(row, "rgba(245,158,11,0.82)", 1.8, "6 3"))
    .join("")
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${pb.minX} ${pb.minY} ${w} ${h}" width="${Math.round(w)}" height="${Math.round(h)}">
<rect x="${pb.minX}" y="${pb.minY}" width="${w}" height="${h}" fill="white"/>
<text x="${pb.minX + 8}" y="${pb.minY + 14}" font-size="11" fill="#222" font-family="system-ui,sans-serif">${escapeXml(o.selector.selectorStatement)}</text>
<text x="${pb.minX + 8}" y="${pb.minY + 28}" font-size="7.5" fill="#444" font-family="system-ui,sans-serif">Green dashed = current v3 shell; green = selected exterior segments; blue = selected exterior hypotheses; orange dashed = selected exterior spans; faint gray = rejected interior-like evidence.</text>
<g>${rejected}</g>
<g>${segments}</g>
<g>${hypotheses}</g>
<g>${spans}</g>
<g>${shellPath}</g>
</svg>`
}
