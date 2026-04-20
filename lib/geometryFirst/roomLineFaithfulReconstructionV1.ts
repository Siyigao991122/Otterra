import type {
  ExteriorEvidenceSelectorSegment,
  ExteriorEvidenceSelectorHypothesis,
  ExteriorEvidenceSelectorSpan,
} from "@/lib/geometryFirst/exteriorEvidenceSelectorV1"
import type {
  ArchitecturalWallHypothesesDebugPayload,
  ArchitecturalWallHypothesis,
} from "@/lib/geometryFirst/architecturalWallHypotheses"
import type { GlobalStructuralSpan, GlobalStructuralSpansDebugPayload } from "@/lib/geometryFirst/globalStructuralSpans"
import type { ExtractedLineSegment, ExtractedTextRun, PlanBoundingBox } from "@/lib/geometryFirst/types"

type Pt = { x: number; y: number }
type Orient = "H" | "V"

export type RoomLineFaithfulWallClass = "exterior_wall" | "interior_wall" | "opening_or_gap" | "uncertain"

export interface RoomLineFaithfulWallRun {
  id: string
  wallClass: RoomLineFaithfulWallClass
  x1: number
  y1: number
  x2: number
  y2: number
  length: number
  sourceSegmentCount: number
  shellProximityScore: number
  exteriorSupportScore: number
  interiorSupportScore: number
  uncertaintyScore: number
}

export interface RoomLineFaithfulReconstructionV1Debug {
  roomLineFaithfulReconstructionV1: {
    sourceSegmentCount: number
    mergedWallRunCount: number
    exteriorWallRunCount: number
    interiorWallRunCount: number
    openingOrGapRunCount: number
    uncertainRunCount: number
  }
  wallRuns: RoomLineFaithfulWallRun[]
  exteriorWallRuns: RoomLineFaithfulWallRun[]
  interiorWallRuns: RoomLineFaithfulWallRun[]
  uncertainRuns: RoomLineFaithfulWallRun[]
  reconstructionStatement: string
  notes: string[]
}

export interface BuildRoomLineFaithfulReconstructionV1SvgOptions {
  pageBounds: PlanBoundingBox
  reconstruction: RoomLineFaithfulReconstructionV1Debug
}

interface GroupedInterval {
  lo: number
  hi: number
  segments: ExtractedLineSegment[]
}

interface MergedRun {
  orient: Orient
  coord: number
  lo: number
  hi: number
  segments: ExtractedLineSegment[]
}

const OPT = {
  axisTol: 6,
  minSegLen: 6,
  mergeCoordBucket: 2.5,
  mergeGap: 5,
  openingGapMin: 7,
  openingGapMax: 18,
  shellSearchDist: 26,
  shellOverlapMin: 0.1,
  interiorLabelRadius: 36,
  minInteriorWallScore: 0.42,
  minExteriorWallScore: 0.56,
} as const

const INTERIOR_TEXT_RE = /\b(bath|closet|wc|foyer|entry|laundry|store|storage|powder)\b/i

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x))
}

function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function segLen(a: Pt, b: Pt): number {
  return Math.hypot(b.x - a.x, b.y - a.y)
}

function axisOrient(a: Pt, b: Pt): Orient | null {
  const dx = b.x - a.x
  const dy = b.y - a.y
  if (Math.abs(dy) <= OPT.axisTol && Math.abs(dx) >= OPT.minSegLen) return "H"
  if (Math.abs(dx) <= OPT.axisTol && Math.abs(dy) >= OPT.minSegLen) return "V"
  return null
}

function overlapLen(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0))
}

function overlapRatio(a0: number, a1: number, b0: number, b1: number): number {
  const ov = overlapLen(a0, a1, b0, b1)
  const denom = Math.max(1, Math.min(a1 - a0, b1 - b0))
  return ov / denom
}

function dedupConsecutive(poly: Pt[], tol = 1.5): Pt[] {
  const out: Pt[] = []
  for (const p of poly) {
    const prev = out[out.length - 1]
    if (prev && dist(prev, p) <= tol) continue
    out.push({ x: p.x, y: p.y })
  }
  if (out.length >= 2 && dist(out[0]!, out[out.length - 1]!) <= tol) out.pop()
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

function buildShellEdges(poly: Pt[]): Array<{ orient: Orient; coord: number; from: number; to: number }> {
  const loop = normalizeLoop(poly)
  const out: Array<{ orient: Orient; coord: number; from: number; to: number }> = []
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i]!
    const b = loop[(i + 1) % loop.length]!
    const orient = axisOrient(a, b)
    if (!orient) continue
    out.push({
      orient,
      coord: orient === "H" ? (a.y + b.y) / 2 : (a.x + b.x) / 2,
      from: orient === "H" ? Math.min(a.x, b.x) : Math.min(a.y, b.y),
      to: orient === "H" ? Math.max(a.x, b.x) : Math.max(a.y, b.y),
    })
  }
  return out
}

function interiorLabelPenalty(point: Pt, texts: ExtractedTextRun[]): number {
  let penalty = 0
  const r2 = OPT.interiorLabelRadius * OPT.interiorLabelRadius
  for (const t of texts) {
    if (!INTERIOR_TEXT_RE.test(t.text)) continue
    const cx = t.x + (t.width ?? 0) / 2
    const cy = t.y + (t.height ?? 0) / 2
    const dx = point.x - cx
    const dy = point.y - cy
    if (dx * dx + dy * dy <= r2) penalty = Math.max(penalty, 0.42)
  }
  return penalty
}

function groupSegmentsByAxis(segments: ExtractedLineSegment[]): {
  mergedRuns: MergedRun[]
  diagonals: ExtractedLineSegment[]
  openingRuns: MergedRun[]
} {
  const buckets = new Map<string, GroupedInterval[]>()
  const diagonals: ExtractedLineSegment[] = []
  const openingRuns: MergedRun[] = []

  for (const seg of segments) {
    const a = { x: seg.x1, y: seg.y1 }
    const b = { x: seg.x2, y: seg.y2 }
    const orient = axisOrient(a, b)
    if (!orient) {
      diagonals.push(seg)
      continue
    }
    const coord = orient === "H" ? (a.y + b.y) / 2 : (a.x + b.x) / 2
    const key = `${orient}:${Math.round(coord / OPT.mergeCoordBucket) * OPT.mergeCoordBucket}`
    const lo = orient === "H" ? Math.min(a.x, b.x) : Math.min(a.y, b.y)
    const hi = orient === "H" ? Math.max(a.x, b.x) : Math.max(a.y, b.y)
    const arr = buckets.get(key) ?? []
    arr.push({ lo, hi, segments: [seg] })
    buckets.set(key, arr)
  }

  const mergedRuns: MergedRun[] = []
  for (const [key, rows] of buckets) {
    const [orientRaw, coordRaw] = key.split(":")
    const orient = orientRaw as Orient
    const coord = Number(coordRaw)
    const sorted = [...rows].sort((a, b) => a.lo - b.lo)
    let cur = { ...sorted[0]!, segments: [...sorted[0]!.segments] }
    for (let i = 1; i < sorted.length; i++) {
      const row = sorted[i]!
      const gap = row.lo - cur.hi
      if (gap <= OPT.mergeGap) {
        cur.hi = Math.max(cur.hi, row.hi)
        cur.segments.push(...row.segments)
      } else {
        mergedRuns.push({ orient, coord, lo: cur.lo, hi: cur.hi, segments: cur.segments })
        if (gap >= OPT.openingGapMin && gap <= OPT.openingGapMax) {
          openingRuns.push({ orient, coord, lo: cur.hi, hi: row.lo, segments: [] })
        }
        cur = { ...row, segments: [...row.segments] }
      }
    }
    mergedRuns.push({ orient, coord, lo: cur.lo, hi: cur.hi, segments: cur.segments })
  }

  return { mergedRuns, diagonals, openingRuns }
}

function runToPoints(run: MergedRun): { a: Pt; b: Pt } {
  return run.orient === "H"
    ? { a: { x: run.lo, y: run.coord }, b: { x: run.hi, y: run.coord } }
    : { a: { x: run.coord, y: run.lo }, b: { x: run.coord, y: run.hi } }
}

function overlapWithSelectedEvidence(
  run: MergedRun,
  selectedSegments: ExteriorEvidenceSelectorSegment[],
  selectedHypotheses: ExteriorEvidenceSelectorHypothesis[],
  selectedSpans: ExteriorEvidenceSelectorSpan[]
): number {
  const collections = [selectedSegments, selectedHypotheses, selectedSpans]
  let best = 0
  for (const rows of collections) {
    for (const row of rows) {
      const orient = axisOrient({ x: row.x1, y: row.y1 }, { x: row.x2, y: row.y2 })
      if (!orient || orient !== run.orient) continue
      const coord = orient === "H" ? (row.y1 + row.y2) / 2 : (row.x1 + row.x2) / 2
      const from = orient === "H" ? Math.min(row.x1, row.x2) : Math.min(row.y1, row.y2)
      const to = orient === "H" ? Math.max(row.x1, row.x2) : Math.max(row.y1, row.y2)
      const coordNear = clamp01(1 - Math.abs(coord - run.coord) / OPT.shellSearchDist)
      const ov = overlapRatio(run.lo, run.hi, from, to)
      best = Math.max(best, coordNear * ov * row.exteriorScore)
    }
  }
  return best
}

function shellProximity(run: MergedRun, shellEdges: Array<{ orient: Orient; coord: number; from: number; to: number }>): number {
  let best = 0
  for (const edge of shellEdges) {
    if (edge.orient !== run.orient) continue
    const near = Math.abs(edge.coord - run.coord)
    if (near > OPT.shellSearchDist) continue
    const ov = overlapRatio(run.lo, run.hi, edge.from, edge.to)
    if (ov < OPT.shellOverlapMin) continue
    best = Math.max(best, clamp01(1 - near / OPT.shellSearchDist) * ov)
  }
  return best
}

function hypothesisSupport(run: MergedRun, hypotheses: ArchitecturalWallHypothesesDebugPayload): { exterior: number; interior: number } {
  let exterior = 0
  let interior = 0
  for (const h of hypotheses.hypotheses) {
    const orient = h.orientation === "horizontal" ? "H" : h.orientation === "vertical" ? "V" : null
    if (!orient || orient !== run.orient) continue
    const coord = orient === "H" ? (h.centerline.y1 + h.centerline.y2) / 2 : (h.centerline.x1 + h.centerline.x2) / 2
    const from = orient === "H" ? Math.min(h.centerline.x1, h.centerline.x2) : Math.min(h.centerline.y1, h.centerline.y2)
    const to = orient === "H" ? Math.max(h.centerline.x1, h.centerline.x2) : Math.max(h.centerline.y1, h.centerline.y2)
    const ov = overlapRatio(run.lo, run.hi, from, to)
    if (ov <= 0) continue
    const coordNear = clamp01(1 - Math.abs(coord - run.coord) / OPT.shellSearchDist)
    exterior = Math.max(exterior, ov * coordNear * clamp01(h.exteriorLikelihood * 0.75 + h.supportScore * 0.25))
    interior = Math.max(interior, ov * coordNear * clamp01(h.interiorLikelihood * 0.75 + h.supportScore * 0.15))
  }
  return { exterior, interior }
}

function spanSupport(run: MergedRun, spans: GlobalStructuralSpansDebugPayload): number {
  let best = 0
  for (const s of spans.spans) {
    const orient = s.orientation === "horizontal" ? "H" : s.orientation === "vertical" ? "V" : null
    if (!orient || orient !== run.orient) continue
    const coord = orient === "H" ? (s.centerline.y1 + s.centerline.y2) / 2 : (s.centerline.x1 + s.centerline.x2) / 2
    const from = orient === "H" ? Math.min(s.centerline.x1, s.centerline.x2) : Math.min(s.centerline.y1, s.centerline.y2)
    const to = orient === "H" ? Math.max(s.centerline.x1, s.centerline.x2) : Math.max(s.centerline.y1, s.centerline.y2)
    const ov = overlapRatio(run.lo, run.hi, from, to)
    if (ov <= 0) continue
    const coordNear = clamp01(1 - Math.abs(coord - run.coord) / OPT.shellSearchDist)
    best = Math.max(best, ov * coordNear * clamp01(s.shellHintScore * 0.55 + s.structuralSupportScore * 0.45))
  }
  return best
}

function classifyRun(input: {
  run: MergedRun
  shellEdges: Array<{ orient: Orient; coord: number; from: number; to: number }>
  hypotheses: ArchitecturalWallHypothesesDebugPayload
  spans: GlobalStructuralSpansDebugPayload
  selectedSegments: ExteriorEvidenceSelectorSegment[]
  selectedHypotheses: ExteriorEvidenceSelectorHypothesis[]
  selectedSpans: ExteriorEvidenceSelectorSpan[]
  texts: ExtractedTextRun[]
}): RoomLineFaithfulWallRun {
  const { run } = input
  const { a, b } = runToPoints(run)
  const length = segLen(a, b)
  const shellScore = shellProximity(run, input.shellEdges)
  const selectorScore = overlapWithSelectedEvidence(run, input.selectedSegments, input.selectedHypotheses, input.selectedSpans)
  const hypo = hypothesisSupport(run, input.hypotheses)
  const span = spanSupport(run, input.spans)
  const midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  const labelPenalty = interiorLabelPenalty(midpoint, input.texts)
  const exteriorSupport = clamp01(shellScore * 0.24 + selectorScore * 0.34 + hypo.exterior * 0.24 + span * 0.18)
  const interiorSupport = clamp01((1 - shellScore) * 0.16 + hypo.interior * 0.44 + labelPenalty * 0.24 + clamp01(length / 120) * 0.16)
  const uncertaintyScore = clamp01(
    (length < 18 ? 0.35 : 0) +
      (Math.abs(exteriorSupport - interiorSupport) < 0.12 ? 0.28 : 0) +
      (selectorScore < 0.18 && hypo.exterior < 0.2 && hypo.interior < 0.2 ? 0.26 : 0)
  )
  let wallClass: RoomLineFaithfulWallClass = "uncertain"
  if (exteriorSupport >= OPT.minExteriorWallScore && exteriorSupport >= interiorSupport + 0.08) {
    wallClass = "exterior_wall"
  } else if (interiorSupport >= OPT.minInteriorWallScore && interiorSupport >= exteriorSupport) {
    wallClass = "interior_wall"
  }
  if (uncertaintyScore >= 0.52) wallClass = "uncertain"

  return {
    id: `run:${run.orient}:${run.coord.toFixed(1)}:${run.lo.toFixed(1)}-${run.hi.toFixed(1)}`,
    wallClass,
    x1: a.x,
    y1: a.y,
    x2: b.x,
    y2: b.y,
    length,
    sourceSegmentCount: run.segments.length,
    shellProximityScore: shellScore,
    exteriorSupportScore: exteriorSupport,
    interiorSupportScore: interiorSupport,
    uncertaintyScore,
  }
}

function openingRunToWallRun(run: MergedRun): RoomLineFaithfulWallRun {
  const { a, b } = runToPoints(run)
  return {
    id: `gap:${run.orient}:${run.coord.toFixed(1)}:${run.lo.toFixed(1)}-${run.hi.toFixed(1)}`,
    wallClass: "opening_or_gap",
    x1: a.x,
    y1: a.y,
    x2: b.x,
    y2: b.y,
    length: segLen(a, b),
    sourceSegmentCount: 0,
    shellProximityScore: 0,
    exteriorSupportScore: 0,
    interiorSupportScore: 0,
    uncertaintyScore: 0.25,
  }
}

function uncertainSegmentToRun(seg: ExtractedLineSegment, index: number): RoomLineFaithfulWallRun {
  return {
    id: `uncertain-seg:${index}`,
    wallClass: "uncertain",
    x1: seg.x1,
    y1: seg.y1,
    x2: seg.x2,
    y2: seg.y2,
    length: segLen({ x: seg.x1, y: seg.y1 }, { x: seg.x2, y: seg.y2 }),
    sourceSegmentCount: 1,
    shellProximityScore: 0,
    exteriorSupportScore: 0.08,
    interiorSupportScore: 0.08,
    uncertaintyScore: 0.86,
  }
}

export function buildRoomLineFaithfulReconstructionV1(
  primaryLayoutSegments: ExtractedLineSegment[],
  currentShellPolygon: Pt[],
  wallHypothesesPlanOnly: ArchitecturalWallHypothesesDebugPayload,
  globalSpansPlanOnly: GlobalStructuralSpansDebugPayload,
  selectedExteriorSegments: ExteriorEvidenceSelectorSegment[],
  selectedExteriorHypotheses: ExteriorEvidenceSelectorHypothesis[],
  selectedExteriorSpans: ExteriorEvidenceSelectorSpan[],
  texts: ExtractedTextRun[]
): RoomLineFaithfulReconstructionV1Debug {
  const notes: string[] = []
  const shellEdges = buildShellEdges(currentShellPolygon)
  const grouped = groupSegmentsByAxis(primaryLayoutSegments)
  const classifiedRuns = grouped.mergedRuns.map((run) =>
    classifyRun({
      run,
      shellEdges,
      hypotheses: wallHypothesesPlanOnly,
      spans: globalSpansPlanOnly,
      selectedSegments: selectedExteriorSegments,
      selectedHypotheses: selectedExteriorHypotheses,
      selectedSpans: selectedExteriorSpans,
      texts,
    })
  )
  const openingRuns = grouped.openingRuns.map(openingRunToWallRun)
  const diagonalUncertain = grouped.diagonals.map(uncertainSegmentToRun)
  const wallRuns = [...classifiedRuns, ...openingRuns, ...diagonalUncertain].sort((a, b) => b.length - a.length)
  const exteriorWallRuns = wallRuns.filter((run) => run.wallClass === "exterior_wall")
  const interiorWallRuns = wallRuns.filter((run) => run.wallClass === "interior_wall")
  const uncertainRuns = wallRuns.filter((run) => run.wallClass === "uncertain")
  const openingOrGapRuns = wallRuns.filter((run) => run.wallClass === "opening_or_gap")

  notes.push(
    `Merged ${primaryLayoutSegments.length} cleaned wall-like segments into ${grouped.mergedRuns.length} axis-aligned wall runs plus ${openingOrGapRuns.length} explicit opening/gap hints.`
  )
  notes.push(
    `Classified runs — exterior ${exteriorWallRuns.length}, interior ${interiorWallRuns.length}, uncertain ${uncertainRuns.length}; diagonal/non-axis residues kept faint as uncertain for faithful visual debug.`
  )

  return {
    roomLineFaithfulReconstructionV1: {
      sourceSegmentCount: primaryLayoutSegments.length,
      mergedWallRunCount: grouped.mergedRuns.length,
      exteriorWallRunCount: exteriorWallRuns.length,
      interiorWallRunCount: interiorWallRuns.length,
      openingOrGapRunCount: openingOrGapRuns.length,
      uncertainRunCount: uncertainRuns.length,
    },
    wallRuns,
    exteriorWallRuns,
    interiorWallRuns,
    uncertainRuns,
    reconstructionStatement:
      `Room-line faithful vector reconstruction v1: ${grouped.mergedRuns.length} merged wall run(s), ` +
      `${exteriorWallRuns.length} exterior, ${interiorWallRuns.length} interior, ` +
      `${openingOrGapRuns.length} opening/gap, ${uncertainRuns.length} uncertain.`,
    notes,
  }
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;")
}

function lineSvg(run: RoomLineFaithfulWallRun, color: string, width: number, dash = ""): string {
  return `<line x1="${run.x1.toFixed(1)}" y1="${run.y1.toFixed(1)}" x2="${run.x2.toFixed(1)}" y2="${run.y2.toFixed(1)}" stroke="${color}" stroke-width="${width}" stroke-linecap="round" ${dash ? `stroke-dasharray="${dash}"` : ""}/>`
}

export function buildRoomLineFaithfulReconstructionV1SvgString(
  o: BuildRoomLineFaithfulReconstructionV1SvgOptions
): string {
  const pb = o.pageBounds
  const w = pb.maxX - pb.minX
  const h = pb.maxY - pb.minY
  const uncertain = o.reconstruction.wallRuns
    .filter((run) => run.wallClass === "uncertain")
    .map((run) => lineSvg(run, "rgba(150,150,150,0.26)", 0.9))
    .join("")
  const openings = o.reconstruction.wallRuns
    .filter((run) => run.wallClass === "opening_or_gap")
    .map((run) => lineSvg(run, "rgba(245,158,11,0.75)", 1.3, "5 4"))
    .join("")
  const interior = o.reconstruction.interiorWallRuns
    .map((run) => lineSvg(run, "rgba(60,60,60,0.92)", 1.4))
    .join("")
  const exterior = o.reconstruction.exteriorWallRuns
    .map((run) => lineSvg(run, "rgba(25,110,220,0.96)", 2.2))
    .join("")
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${pb.minX} ${pb.minY} ${w} ${h}" width="${Math.round(w)}" height="${Math.round(h)}">
<rect x="${pb.minX}" y="${pb.minY}" width="${w}" height="${h}" fill="white"/>
<text x="${pb.minX + 8}" y="${pb.minY + 14}" font-size="11" fill="#222" font-family="system-ui,sans-serif">${escapeXml(o.reconstruction.reconstructionStatement)}</text>
<text x="${pb.minX + 8}" y="${pb.minY + 28}" font-size="7.5" fill="#444" font-family="system-ui,sans-serif">Blue = exterior walls; dark gray = interior room walls; amber dashed = opening/gap hints; faint gray = uncertain/non-wall residues kept for faithful visual context.</text>
<g>${uncertain}</g>
<g>${openings}</g>
<g>${interior}</g>
<g>${exterior}</g>
</svg>`
}
