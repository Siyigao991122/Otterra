import type {
  ExteriorEvidenceSelectorHypothesis,
  ExteriorEvidenceSelectorSegment,
  ExteriorEvidenceSelectorSpan,
  ExteriorEvidenceSelectorV1Debug,
} from "@/lib/geometryFirst/exteriorEvidenceSelectorV1"
import type { ArchitecturalWallHypothesesDebugPayload } from "@/lib/geometryFirst/architecturalWallHypotheses"
import type { GlobalStructuralSpansDebugPayload } from "@/lib/geometryFirst/globalStructuralSpans"
import type { ExtractedLineSegment, ExtractedTextRun, PlanBoundingBox } from "@/lib/geometryFirst/types"

type Pt = { x: number; y: number }
type Orient = "H" | "V"

interface MergedRun {
  orient: Orient
  coord: number
  lo: number
  hi: number
  segments: ExtractedLineSegment[]
}

interface StructuralCandidateScore {
  id: string
  x1: number
  y1: number
  x2: number
  y2: number
  length: number
  orientation: "horizontal" | "vertical" | "diagonal"
  shellScore: number
  exteriorEvidenceScore: number
  structuralSupportScore: number
  interiorPenalty: number
  connectivityHint: number
  furniturePenalty: number
  structuralScore: number
  keptInitial: boolean
}

export interface StructuralRecoveredRunV1 {
  id: string
  x1: number
  y1: number
  x2: number
  y2: number
  length: number
  sourceSegmentCount: number
  supportScore: number
  shellConnected: boolean
  componentId: number
}

export interface StructuralClosedLoopV1 {
  loopId: string
  polygon: Pt[]
  supportScore: number
  sourceRunIds: string[]
}

export interface StructuralMissingLineCandidateV1 {
  id: string
  x1: number
  y1: number
  x2: number
  y2: number
  length: number
  bridgeScore: number
  structuralSupportScore: number
  accepted: boolean
}

export interface StructuralLineRecoveryV1Debug {
  structuralLineRecoveryV1: {
    sourceSegmentCount: number
    retainedStructuralSegmentCount: number
    filteredFurnitureLikeSegmentCount: number
    connectedStructuralRunCount: number
    closedStructuralLoopCount: number
    missingLineCandidateCount: number
    acceptedBackfilledSegmentCount: number
    repairedSegmentCount: number
  }
  filteredFurnitureLikeSegments: ExtractedLineSegment[]
  retainedStructuralSegments: ExtractedLineSegment[]
  connectedStructuralRuns: StructuralRecoveredRunV1[]
  closedStructuralLoops: StructuralClosedLoopV1[]
  missingLineCandidates: StructuralMissingLineCandidateV1[]
  acceptedBackfilledSegments: ExtractedLineSegment[]
  repairedStructuralSegments: ExtractedLineSegment[]
  recoveryStatement: string
  notes: string[]
}

export interface BuildStructuralLineRecoveryV1SvgOptions {
  pageBounds: PlanBoundingBox
  recovery: StructuralLineRecoveryV1Debug
  originalSegments: ExtractedLineSegment[]
}

const OPT = {
  axisTol: 6,
  minSegLen: 8,
  mergeCoordBucket: 2.5,
  mergeGap: 5,
  shellSearchDist: 30,
  evidenceSearchDist: 24,
  interiorLabelRadius: 40,
  retainScore: 0.32,
  retainFallbackLength: 48,
  bridgeScoreKeep: 0.46,
  runConnectTol: 10,
  loopPad: 4,
  maxLoops: 24,
} as const

const INTERIOR_LABEL_RE = /\b(bath|closet|wc|powder|foyer|entry|hall|laundry|store|storage|wic|cl)\b/i

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

function normalizeLoop(poly: Pt[]): Pt[] {
  const out: Pt[] = []
  for (const p of poly) {
    const prev = out[out.length - 1]
    if (prev && dist(prev, p) <= 1.5) continue
    out.push({ x: p.x, y: p.y })
  }
  if (out.length >= 2 && dist(out[0]!, out[out.length - 1]!) <= 1.5) out.pop()
  return out
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

function buildShellSupportSegments(poly: Pt[]): ExtractedLineSegment[] {
  const loop = normalizeLoop(poly)
  const out: ExtractedLineSegment[] = []
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i]!
    const b = loop[(i + 1) % loop.length]!
    if (!axisOrient(a, b)) continue
    if (segLen(a, b) < OPT.minSegLen) continue
    out.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y })
  }
  return dedupSegments(out)
}

function shellProximity(segment: ExtractedLineSegment, shellEdges: Array<{ orient: Orient; coord: number; from: number; to: number }>): number {
  const orient = axisOrient({ x: segment.x1, y: segment.y1 }, { x: segment.x2, y: segment.y2 })
  if (!orient) return 0
  const coord = orient === "H" ? (segment.y1 + segment.y2) / 2 : (segment.x1 + segment.x2) / 2
  const from = orient === "H" ? Math.min(segment.x1, segment.x2) : Math.min(segment.y1, segment.y2)
  const to = orient === "H" ? Math.max(segment.x1, segment.x2) : Math.max(segment.y1, segment.y2)
  let best = 0
  for (const edge of shellEdges) {
    if (edge.orient !== orient) continue
    const near = Math.abs(edge.coord - coord)
    if (near > OPT.shellSearchDist) continue
    const ov = overlapRatio(from, to, edge.from, edge.to)
    best = Math.max(best, clamp01(1 - near / OPT.shellSearchDist) * ov)
  }
  return best
}

function evidenceOverlapScore(
  segment: ExtractedLineSegment,
  selectedSegments: ExteriorEvidenceSelectorSegment[],
  selectedHypotheses: ExteriorEvidenceSelectorHypothesis[],
  selectedSpans: ExteriorEvidenceSelectorSpan[]
): number {
  const orient = axisOrient({ x: segment.x1, y: segment.y1 }, { x: segment.x2, y: segment.y2 })
  if (!orient) return 0
  const coord = orient === "H" ? (segment.y1 + segment.y2) / 2 : (segment.x1 + segment.x2) / 2
  const from = orient === "H" ? Math.min(segment.x1, segment.x2) : Math.min(segment.y1, segment.y2)
  const to = orient === "H" ? Math.max(segment.x1, segment.x2) : Math.max(segment.y1, segment.y2)
  const groups = [selectedSegments, selectedHypotheses, selectedSpans]
  let best = 0
  for (const rows of groups) {
    for (const row of rows) {
      const rowOrient = axisOrient({ x: row.x1, y: row.y1 }, { x: row.x2, y: row.y2 })
      if (!rowOrient || rowOrient !== orient) continue
      const rowCoord = rowOrient === "H" ? (row.y1 + row.y2) / 2 : (row.x1 + row.x2) / 2
      const rowFrom = rowOrient === "H" ? Math.min(row.x1, row.x2) : Math.min(row.y1, row.y2)
      const rowTo = rowOrient === "H" ? Math.max(row.x1, row.x2) : Math.max(row.y1, row.y2)
      const coordNear = clamp01(1 - Math.abs(rowCoord - coord) / OPT.evidenceSearchDist)
      const ov = overlapRatio(from, to, rowFrom, rowTo)
      best = Math.max(best, coordNear * ov * ("exteriorScore" in row ? row.exteriorScore : 1))
    }
  }
  return best
}

function hypothesisSupport(segment: ExtractedLineSegment, hypotheses: ArchitecturalWallHypothesesDebugPayload): number {
  const orient = axisOrient({ x: segment.x1, y: segment.y1 }, { x: segment.x2, y: segment.y2 })
  if (!orient) return 0
  const coord = orient === "H" ? (segment.y1 + segment.y2) / 2 : (segment.x1 + segment.x2) / 2
  const from = orient === "H" ? Math.min(segment.x1, segment.x2) : Math.min(segment.y1, segment.y2)
  const to = orient === "H" ? Math.max(segment.x1, segment.x2) : Math.max(segment.y1, segment.y2)
  let best = 0
  for (const h of hypotheses.hypotheses) {
    const hOrient = h.orientation === "horizontal" ? "H" : h.orientation === "vertical" ? "V" : null
    if (!hOrient || hOrient !== orient) continue
    const hCoord = hOrient === "H" ? (h.centerline.y1 + h.centerline.y2) / 2 : (h.centerline.x1 + h.centerline.x2) / 2
    const hFrom = hOrient === "H" ? Math.min(h.centerline.x1, h.centerline.x2) : Math.min(h.centerline.y1, h.centerline.y2)
    const hTo = hOrient === "H" ? Math.max(h.centerline.x1, h.centerline.x2) : Math.max(h.centerline.y1, h.centerline.y2)
    const near = clamp01(1 - Math.abs(hCoord - coord) / OPT.evidenceSearchDist)
    const ov = overlapRatio(from, to, hFrom, hTo)
    best = Math.max(best, near * ov * clamp01(h.supportScore * 0.4 + h.exteriorLikelihood * 0.3 + h.interiorLikelihood * 0.3))
  }
  return best
}

function spanSupport(segment: ExtractedLineSegment, spans: GlobalStructuralSpansDebugPayload): number {
  const orient = axisOrient({ x: segment.x1, y: segment.y1 }, { x: segment.x2, y: segment.y2 })
  if (!orient) return 0
  const coord = orient === "H" ? (segment.y1 + segment.y2) / 2 : (segment.x1 + segment.x2) / 2
  const from = orient === "H" ? Math.min(segment.x1, segment.x2) : Math.min(segment.y1, segment.y2)
  const to = orient === "H" ? Math.max(segment.x1, segment.x2) : Math.max(segment.y1, segment.y2)
  let best = 0
  for (const s of spans.spans) {
    const sOrient = s.orientation === "horizontal" ? "H" : s.orientation === "vertical" ? "V" : null
    if (!sOrient || sOrient !== orient) continue
    const sCoord = sOrient === "H" ? (s.centerline.y1 + s.centerline.y2) / 2 : (s.centerline.x1 + s.centerline.x2) / 2
    const sFrom = sOrient === "H" ? Math.min(s.centerline.x1, s.centerline.x2) : Math.min(s.centerline.y1, s.centerline.y2)
    const sTo = sOrient === "H" ? Math.max(s.centerline.x1, s.centerline.x2) : Math.max(s.centerline.y1, s.centerline.y2)
    const near = clamp01(1 - Math.abs(sCoord - coord) / OPT.evidenceSearchDist)
    const ov = overlapRatio(from, to, sFrom, sTo)
    best = Math.max(best, near * ov * clamp01(s.structuralSupportScore * 0.55 + s.shellHintScore * 0.45))
  }
  return best
}

function interiorLabelPenalty(point: Pt, texts: ExtractedTextRun[]): number {
  let penalty = 0
  const r2 = OPT.interiorLabelRadius * OPT.interiorLabelRadius
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

function connectivityHints(segments: ExtractedLineSegment[], index: number): number {
  const s = segments[index]!
  const a1 = { x: s.x1, y: s.y1 }
  const a2 = { x: s.x2, y: s.y2 }
  let hits = 0
  for (let i = 0; i < segments.length; i++) {
    if (i === index) continue
    const t = segments[i]!
    const b1 = { x: t.x1, y: t.y1 }
    const b2 = { x: t.x2, y: t.y2 }
    if (
      dist(a1, b1) <= OPT.runConnectTol ||
      dist(a1, b2) <= OPT.runConnectTol ||
      dist(a2, b1) <= OPT.runConnectTol ||
      dist(a2, b2) <= OPT.runConnectTol
    ) {
      hits++
    }
  }
  return clamp01(hits / 4)
}

function scoreSegments(
  segments: ExtractedLineSegment[],
  currentShellPolygon: Pt[],
  selector: ExteriorEvidenceSelectorV1Debug,
  hypotheses: ArchitecturalWallHypothesesDebugPayload,
  spans: GlobalStructuralSpansDebugPayload,
  texts: ExtractedTextRun[]
): StructuralCandidateScore[] {
  const shellEdges = buildShellEdges(currentShellPolygon)
  return segments.map((segment, index) => {
    const a = { x: segment.x1, y: segment.y1 }
    const b = { x: segment.x2, y: segment.y2 }
    const length = segLen(a, b)
    const orient = axisOrient(a, b)
    const shellScore = shellProximity(segment, shellEdges)
    const exteriorEvidenceScore = evidenceOverlapScore(
      segment,
      selector.selectedExteriorSegments,
      selector.selectedExteriorHypotheses,
      selector.selectedExteriorSpans
    )
    const structuralSupportScore = Math.max(hypothesisSupport(segment, hypotheses), spanSupport(segment, spans))
    const midpoint = { x: (segment.x1 + segment.x2) / 2, y: (segment.y1 + segment.y2) / 2 }
    const interiorPenalty = interiorLabelPenalty(midpoint, texts)
    const connectivityHint = connectivityHints(segments, index)
    const furniturePenalty =
      (length < 20 ? 0.22 : length < 32 ? 0.12 : 0) +
      (shellScore < 0.08 && structuralSupportScore < 0.1 && connectivityHint < 0.16 ? 0.2 : 0) +
      (orient == null ? 0.1 : 0)
    const structuralScore = clamp01(
      shellScore * 0.17 +
        exteriorEvidenceScore * 0.22 +
        structuralSupportScore * 0.24 +
        connectivityHint * 0.2 +
        clamp01(length / 140) * 0.17 -
        interiorPenalty * 0.12 -
        furniturePenalty * 0.18
    )
    const keptInitial =
      structuralScore >= OPT.retainScore ||
      (length >= OPT.retainFallbackLength && (shellScore >= 0.08 || structuralSupportScore >= 0.1 || connectivityHint >= 0.18))
    return {
      id: `seg:${index}`,
      x1: segment.x1,
      y1: segment.y1,
      x2: segment.x2,
      y2: segment.y2,
      length,
      orientation: orient === "H" ? "horizontal" : orient === "V" ? "vertical" : "diagonal",
      shellScore,
      exteriorEvidenceScore,
      structuralSupportScore,
      interiorPenalty,
      connectivityHint,
      furniturePenalty,
      structuralScore,
      keptInitial,
    }
  })
}

function groupSegmentsByAxis(segments: ExtractedLineSegment[]): MergedRun[] {
  const buckets = new Map<string, MergedRun[]>()
  for (const seg of segments) {
    const orient = axisOrient({ x: seg.x1, y: seg.y1 }, { x: seg.x2, y: seg.y2 })
    if (!orient) continue
    const coord = orient === "H" ? (seg.y1 + seg.y2) / 2 : (seg.x1 + seg.x2) / 2
    const key = `${orient}:${Math.round(coord / OPT.mergeCoordBucket) * OPT.mergeCoordBucket}`
    const lo = orient === "H" ? Math.min(seg.x1, seg.x2) : Math.min(seg.y1, seg.y2)
    const hi = orient === "H" ? Math.max(seg.x1, seg.x2) : Math.max(seg.y1, seg.y2)
    const arr = buckets.get(key) ?? []
    arr.push({ orient, coord, lo, hi, segments: [seg] })
    buckets.set(key, arr)
  }
  const out: MergedRun[] = []
  for (const rows of buckets.values()) {
    const sorted = [...rows].sort((a, b) => a.lo - b.lo)
    let cur = { ...sorted[0]!, segments: [...sorted[0]!.segments] }
    for (let i = 1; i < sorted.length; i++) {
      const row = sorted[i]!
      if (row.lo - cur.hi <= OPT.mergeGap) {
        cur.hi = Math.max(cur.hi, row.hi)
        cur.segments.push(...row.segments)
      } else {
        out.push({ orient: cur.orient, coord: cur.coord, lo: cur.lo, hi: cur.hi, segments: cur.segments })
        cur = { ...row, segments: [...row.segments] }
      }
    }
    out.push({ orient: cur.orient, coord: cur.coord, lo: cur.lo, hi: cur.hi, segments: cur.segments })
  }
  return out
}

function runToSegment(run: MergedRun): ExtractedLineSegment {
  return run.orient === "H"
    ? { x1: run.lo, y1: run.coord, x2: run.hi, y2: run.coord }
    : { x1: run.coord, y1: run.lo, x2: run.coord, y2: run.hi }
}

function runEndpointDistance(a: MergedRun, b: MergedRun): number {
  const ptsA =
    a.orient === "H"
      ? [{ x: a.lo, y: a.coord }, { x: a.hi, y: a.coord }]
      : [{ x: a.coord, y: a.lo }, { x: a.coord, y: a.hi }]
  const ptsB =
    b.orient === "H"
      ? [{ x: b.lo, y: b.coord }, { x: b.hi, y: b.coord }]
      : [{ x: b.coord, y: b.lo }, { x: b.coord, y: b.hi }]
  let best = Infinity
  for (const pa of ptsA) {
    for (const pb of ptsB) best = Math.min(best, dist(pa, pb))
  }
  if (a.orient !== b.orient) {
    const ax = a.orient === "H" ? [a.lo, a.hi] : [a.coord, a.coord]
    const ay = a.orient === "H" ? [a.coord, a.coord] : [a.lo, a.hi]
    const bx = b.orient === "H" ? [b.lo, b.hi] : [b.coord, b.coord]
    const by = b.orient === "H" ? [b.coord, b.coord] : [b.lo, b.hi]
    const crossX = b.orient === "V" ? b.coord : a.coord
    const crossY = a.orient === "V" ? a.coord : b.coord
    if (
      crossX >= Math.min(ax[0]!, ax[1]!) - OPT.runConnectTol &&
      crossX <= Math.max(ax[0]!, ax[1]!) + OPT.runConnectTol &&
      crossY >= Math.min(by[0]!, by[1]!) - OPT.runConnectTol &&
      crossY <= Math.max(by[0]!, by[1]!) + OPT.runConnectTol &&
      crossX >= Math.min(bx[0]!, bx[1]!) - OPT.runConnectTol &&
      crossX <= Math.max(bx[0]!, bx[1]!) + OPT.runConnectTol &&
      crossY >= Math.min(ay[0]!, ay[1]!) - OPT.runConnectTol &&
      crossY <= Math.max(ay[0]!, ay[1]!) + OPT.runConnectTol
    ) {
      best = 0
    }
  }
  return best
}

function runSupportScore(
  run: MergedRun,
  shellPolygon: Pt[],
  selector: ExteriorEvidenceSelectorV1Debug,
  hypotheses: ArchitecturalWallHypothesesDebugPayload,
  spans: GlobalStructuralSpansDebugPayload
): number {
  const seg = runToSegment(run)
  return clamp01(
    shellProximity(seg, buildShellEdges(shellPolygon)) * 0.18 +
      evidenceOverlapScore(seg, selector.selectedExteriorSegments, selector.selectedExteriorHypotheses, selector.selectedExteriorSpans) * 0.3 +
      hypothesisSupport(seg, hypotheses) * 0.28 +
      spanSupport(seg, spans) * 0.24
  )
}

function keepConnectedRuns(
  runs: MergedRun[],
  shellPolygon: Pt[],
  selector: ExteriorEvidenceSelectorV1Debug,
  hypotheses: ArchitecturalWallHypothesesDebugPayload,
  spans: GlobalStructuralSpansDebugPayload
): { keptRuns: StructuralRecoveredRunV1[]; keptSegments: ExtractedLineSegment[] } {
  if (!runs.length) return { keptRuns: [], keptSegments: [] }
  const adj = new Map<number, Set<number>>()
  for (let i = 0; i < runs.length; i++) adj.set(i, new Set())
  for (let i = 0; i < runs.length; i++) {
    for (let j = i + 1; j < runs.length; j++) {
      if (runEndpointDistance(runs[i]!, runs[j]!) <= OPT.runConnectTol) {
        adj.get(i)!.add(j)
        adj.get(j)!.add(i)
      }
    }
  }
  const shellEdges = buildShellEdges(shellPolygon)
  const seen = new Set<number>()
  const keptRuns: StructuralRecoveredRunV1[] = []
  const keptSegments: ExtractedLineSegment[] = []
  let componentId = 0
  for (let i = 0; i < runs.length; i++) {
    if (seen.has(i)) continue
    componentId++
    const stack = [i]
    const component: number[] = []
    seen.add(i)
    while (stack.length) {
      const cur = stack.pop()!
      component.push(cur)
      for (const nxt of adj.get(cur) ?? []) {
        if (seen.has(nxt)) continue
        seen.add(nxt)
        stack.push(nxt)
      }
    }
    const shellConnected = component.some((idx) => shellProximity(runToSegment(runs[idx]!), shellEdges) >= 0.16)
    const totalLength = component.reduce((sum, idx) => sum + segLen({ x: runToSegment(runs[idx]!).x1, y: runToSegment(runs[idx]!).y1 }, { x: runToSegment(runs[idx]!).x2, y: runToSegment(runs[idx]!).y2 }), 0)
    const keepComponent = shellConnected || totalLength >= 70 || component.length >= 2
    if (!keepComponent) continue
    for (const idx of component) {
      const run = runs[idx]!
      const seg = runToSegment(run)
      const supportScore = runSupportScore(run, shellPolygon, selector, hypotheses, spans)
      if (!shellConnected && supportScore < 0.08 && run.segments.length <= 1 && segLen({ x: seg.x1, y: seg.y1 }, { x: seg.x2, y: seg.y2 }) < 18) continue
      keptRuns.push({
        id: `recovered-run:${componentId}:${keptRuns.length}`,
        x1: seg.x1,
        y1: seg.y1,
        x2: seg.x2,
        y2: seg.y2,
        length: segLen({ x: seg.x1, y: seg.y1 }, { x: seg.x2, y: seg.y2 }),
        sourceSegmentCount: run.segments.length,
        supportScore,
        shellConnected,
        componentId,
      })
      keptSegments.push(...run.segments)
    }
  }
  return { keptRuns: keptRuns.sort((a, b) => b.length - a.length), keptSegments }
}

function dedupSegments(segments: ExtractedLineSegment[]): ExtractedLineSegment[] {
  const seen = new Map<string, ExtractedLineSegment>()
  for (const s of segments) {
    const a = `${s.x1.toFixed(1)},${s.y1.toFixed(1)}`
    const b = `${s.x2.toFixed(1)},${s.y2.toFixed(1)}`
    const key = a < b ? `${a}|${b}` : `${b}|${a}`
    if (!seen.has(key)) seen.set(key, s)
  }
  return [...seen.values()]
}

function runCoverage(seg: ExtractedLineSegment, runs: StructuralRecoveredRunV1[]): number {
  const orient = axisOrient({ x: seg.x1, y: seg.y1 }, { x: seg.x2, y: seg.y2 })
  if (!orient) return 0
  const coord = orient === "H" ? (seg.y1 + seg.y2) / 2 : (seg.x1 + seg.x2) / 2
  const from = orient === "H" ? Math.min(seg.x1, seg.x2) : Math.min(seg.y1, seg.y2)
  const to = orient === "H" ? Math.max(seg.x1, seg.x2) : Math.max(seg.y1, seg.y2)
  let best = 0
  for (const run of runs) {
    const runOrient = axisOrient({ x: run.x1, y: run.y1 }, { x: run.x2, y: run.y2 })
    if (!runOrient || runOrient !== orient) continue
    const runCoord = orient === "H" ? (run.y1 + run.y2) / 2 : (run.x1 + run.x2) / 2
    const runFrom = orient === "H" ? Math.min(run.x1, run.x2) : Math.min(run.y1, run.y2)
    const runTo = orient === "H" ? Math.max(run.x1, run.x2) : Math.max(run.y1, run.y2)
    const coordNear = clamp01(1 - Math.abs(runCoord - coord) / OPT.evidenceSearchDist)
    best = Math.max(best, coordNear * overlapRatio(from, to, runFrom, runTo))
  }
  return best
}

function bridgeScore(
  seg: ExtractedLineSegment,
  runs: StructuralRecoveredRunV1[],
  selector: ExteriorEvidenceSelectorV1Debug,
  hypotheses: ArchitecturalWallHypothesesDebugPayload,
  spans: GlobalStructuralSpansDebugPayload
): number {
  const orient = axisOrient({ x: seg.x1, y: seg.y1 }, { x: seg.x2, y: seg.y2 })
  if (!orient) return 0
  const sameOrientRuns = runs.filter((r) => axisOrient({ x: r.x1, y: r.y1 }, { x: r.x2, y: r.y2 }) === orient)
  const crossRuns = runs.filter((r) => axisOrient({ x: r.x1, y: r.y1 }, { x: r.x2, y: r.y2 }) !== orient)
  let endpointConnect = 0
  for (const run of sameOrientRuns) {
    const d1 = Math.min(dist({ x: seg.x1, y: seg.y1 }, { x: run.x1, y: run.y1 }), dist({ x: seg.x2, y: seg.y2 }, { x: run.x2, y: run.y2 }))
    endpointConnect = Math.max(endpointConnect, clamp01(1 - d1 / 18))
  }
  let crossConnect = 0
  for (const run of crossRuns) {
    const d1 = Math.min(dist({ x: seg.x1, y: seg.y1 }, { x: run.x1, y: run.y1 }), dist({ x: seg.x2, y: seg.y2 }, { x: run.x2, y: run.y2 }))
    const d2 = Math.min(dist({ x: seg.x1, y: seg.y1 }, { x: run.x2, y: run.y2 }), dist({ x: seg.x2, y: seg.y2 }, { x: run.x1, y: run.y1 }))
    crossConnect = Math.max(crossConnect, clamp01(1 - Math.min(d1, d2) / 14))
  }
  const support = Math.max(
    evidenceOverlapScore(seg, selector.selectedExteriorSegments, selector.selectedExteriorHypotheses, selector.selectedExteriorSpans),
    hypothesisSupport(seg, hypotheses),
    spanSupport(seg, spans)
  )
  return clamp01(endpointConnect * 0.42 + crossConnect * 0.26 + support * 0.32)
}

function recoverMissingLines(
  originalSegments: ExtractedLineSegment[],
  retainedIds: Set<string>,
  runs: StructuralRecoveredRunV1[],
  selector: ExteriorEvidenceSelectorV1Debug,
  hypotheses: ArchitecturalWallHypothesesDebugPayload,
  spans: GlobalStructuralSpansDebugPayload
): { candidates: StructuralMissingLineCandidateV1[]; acceptedSegments: ExtractedLineSegment[] } {
  const candidates: StructuralMissingLineCandidateV1[] = []
  const acceptedSegments: ExtractedLineSegment[] = []
  for (let i = 0; i < originalSegments.length; i++) {
    const seg = originalSegments[i]!
    const id = `seg:${i}`
    if (retainedIds.has(id)) continue
    const orient = axisOrient({ x: seg.x1, y: seg.y1 }, { x: seg.x2, y: seg.y2 })
    if (!orient) continue
    if (runCoverage(seg, runs) >= 0.72) continue
    const bridge = bridgeScore(seg, runs, selector, hypotheses, spans)
    const structuralSupport = Math.max(
      evidenceOverlapScore(seg, selector.selectedExteriorSegments, selector.selectedExteriorHypotheses, selector.selectedExteriorSpans),
      hypothesisSupport(seg, hypotheses),
      spanSupport(seg, spans)
    )
    const accepted = bridge >= OPT.bridgeScoreKeep && structuralSupport >= 0.16
    candidates.push({
      id: `missing:${i}`,
      x1: seg.x1,
      y1: seg.y1,
      x2: seg.x2,
      y2: seg.y2,
      length: segLen({ x: seg.x1, y: seg.y1 }, { x: seg.x2, y: seg.y2 }),
      bridgeScore: bridge,
      structuralSupportScore: structuralSupport,
      accepted,
    })
    if (accepted) acceptedSegments.push(seg)
  }
  return {
    candidates: candidates.sort((a, b) => b.bridgeScore - a.bridgeScore || b.length - a.length),
    acceptedSegments: dedupSegments(acceptedSegments),
  }
}

function deriveClosedLoops(runs: StructuralRecoveredRunV1[]): StructuralClosedLoopV1[] {
  const verticals = runs.filter((r) => axisOrient({ x: r.x1, y: r.y1 }, { x: r.x2, y: r.y2 }) === "V")
  const horizontals = runs.filter((r) => axisOrient({ x: r.x1, y: r.y1 }, { x: r.x2, y: r.y2 }) === "H")
  const loops: StructuralClosedLoopV1[] = []
  for (let i = 0; i < verticals.length; i++) {
    for (let j = i + 1; j < verticals.length; j++) {
      const left = verticals[i]!
      const right = verticals[j]!
      const x0 = (left.x1 + left.x2) / 2
      const x1 = (right.x1 + right.x2) / 2
      if (x1 - x0 < 18) continue
      const topY = Math.max(Math.min(left.y1, left.y2), Math.min(right.y1, right.y2))
      const botY = Math.min(Math.max(left.y1, left.y2), Math.max(right.y1, right.y2))
      if (botY - topY < 18) continue
      const top = horizontals.find((h) => {
        const y = (h.y1 + h.y2) / 2
        return Math.abs(y - topY) <= OPT.runConnectTol && Math.min(h.x1, h.x2) <= x0 + OPT.runConnectTol && Math.max(h.x1, h.x2) >= x1 - OPT.runConnectTol
      })
      const bottom = horizontals.find((h) => {
        const y = (h.y1 + h.y2) / 2
        return Math.abs(y - botY) <= OPT.runConnectTol && Math.min(h.x1, h.x2) <= x0 + OPT.runConnectTol && Math.max(h.x1, h.x2) >= x1 - OPT.runConnectTol
      })
      if (!top || !bottom) continue
      const polygon = [
        { x: x0 - OPT.loopPad, y: topY - OPT.loopPad },
        { x: x1 + OPT.loopPad, y: topY - OPT.loopPad },
        { x: x1 + OPT.loopPad, y: botY + OPT.loopPad },
        { x: x0 - OPT.loopPad, y: botY + OPT.loopPad },
      ]
      const supportScore = clamp01((left.supportScore + right.supportScore + top.supportScore + bottom.supportScore) / 4)
      loops.push({
        loopId: `loop:${loops.length}`,
        polygon,
        supportScore,
        sourceRunIds: [left.id, right.id, top.id, bottom.id],
      })
      if (loops.length >= OPT.maxLoops) return loops
    }
  }
  return loops
}

export function buildStructuralLineRecoveryV1(
  primaryLayoutSegments: ExtractedLineSegment[],
  currentShellPolygon: Pt[],
  selector: ExteriorEvidenceSelectorV1Debug,
  hypotheses: ArchitecturalWallHypothesesDebugPayload,
  spans: GlobalStructuralSpansDebugPayload,
  texts: ExtractedTextRun[]
): StructuralLineRecoveryV1Debug {
  const notes: string[] = []
  const scored = scoreSegments(primaryLayoutSegments, currentShellPolygon, selector, hypotheses, spans, texts)
  const shellSupportSegments = buildShellSupportSegments(currentShellPolygon)
  const filteredCandidateIds = new Set(
    scored
      .filter(
        (row) =>
          !row.keptInitial &&
          row.length < 26 &&
          row.connectivityHint < 0.18 &&
          row.structuralSupportScore < 0.12 &&
          row.exteriorEvidenceScore < 0.12 &&
          row.shellScore < 0.08
      )
      .map((row) => row.id)
  )
  const retainedInitial = primaryLayoutSegments.filter((_, i) => !filteredCandidateIds.has(`seg:${i}`))
  const retainedIds = new Set(
    primaryLayoutSegments
      .map((_, i) => (!filteredCandidateIds.has(`seg:${i}`) ? `seg:${i}` : null))
      .filter((id): id is string => id != null)
  )
  const retainedRuns = groupSegmentsByAxis(dedupSegments([...retainedInitial, ...shellSupportSegments]))
  const connected = keepConnectedRuns(retainedRuns, currentShellPolygon, selector, hypotheses, spans)
  const missing = recoverMissingLines(primaryLayoutSegments, retainedIds, connected.keptRuns, selector, hypotheses, spans)
  const repairedStructuralSegments = dedupSegments([...retainedInitial, ...shellSupportSegments, ...missing.acceptedSegments])
  const repairedRunsRaw = groupSegmentsByAxis(repairedStructuralSegments)
  const repaired = keepConnectedRuns(repairedRunsRaw, currentShellPolygon, selector, hypotheses, spans)
  const loops = deriveClosedLoops(repaired.keptRuns)
  const acceptedSet = new Set(
    missing.acceptedSegments.map((s) => {
      const a = `${s.x1.toFixed(1)},${s.y1.toFixed(1)}`
      const b = `${s.x2.toFixed(1)},${s.y2.toFixed(1)}`
      return a < b ? `${a}|${b}` : `${b}|${a}`
    })
  )
  const filteredFurnitureLikeSegments = primaryLayoutSegments.filter((seg, i) => {
    if (!filteredCandidateIds.has(`seg:${i}`)) return false
    const a = `${seg.x1.toFixed(1)},${seg.y1.toFixed(1)}`
    const b = `${seg.x2.toFixed(1)},${seg.y2.toFixed(1)}`
    const key = a < b ? `${a}|${b}` : `${b}|${a}`
    return !acceptedSet.has(key)
  })

  const avgStructural = scored.length ? scored.reduce((sum, row) => sum + row.structuralScore, 0) / scored.length : 0
  notes.push(
    `Structural recovery scored ${primaryLayoutSegments.length} plan-body segment(s); retained ${retainedInitial.length} initial structural segment(s) with mean score ${avgStructural.toFixed(2)}.`
  )
  notes.push(
    `Injected ${shellSupportSegments.length} shell-supported edge segment(s) so the authoritative apartment shell participates in the connected structural network.`
  )
  notes.push(
    `Connected structural network kept ${repaired.keptRuns.length} run(s) after component pruning; ${missing.acceptedSegments.length} missing line(s) were backfilled from the original PDF line set.`
  )
  notes.push(
    `Furniture-like suppression is dominated by short interior segments with weak shell/evidence support near bath/closet/foyer labels.`
  )

  return {
    structuralLineRecoveryV1: {
      sourceSegmentCount: primaryLayoutSegments.length,
      retainedStructuralSegmentCount: connected.keptSegments.length,
      filteredFurnitureLikeSegmentCount: filteredFurnitureLikeSegments.length,
      connectedStructuralRunCount: repaired.keptRuns.length,
      closedStructuralLoopCount: loops.length,
      missingLineCandidateCount: missing.candidates.length,
      acceptedBackfilledSegmentCount: missing.acceptedSegments.length,
      repairedSegmentCount: repairedStructuralSegments.length,
    },
    filteredFurnitureLikeSegments,
    retainedStructuralSegments: connected.keptSegments,
    connectedStructuralRuns: repaired.keptRuns,
    closedStructuralLoops: loops,
    missingLineCandidates: missing.candidates,
    acceptedBackfilledSegments: missing.acceptedSegments,
    repairedStructuralSegments,
    recoveryStatement:
      `Structural line recovery v1: ${repaired.keptRuns.length} connected structural run(s), ` +
      `${loops.length} closed loop(s), ${missing.acceptedSegments.length} accepted backfilled line(s), ` +
      `${filteredFurnitureLikeSegments.length} furniture-like segment(s) filtered.`,
    notes,
  }
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;")
}

function pathFromPoly(pts: Pt[]): string {
  if (pts.length < 2) return ""
  let d = `M ${pts[0]!.x.toFixed(2)} ${pts[0]!.y.toFixed(2)}`
  for (let i = 1; i < pts.length; i++) d += ` L ${pts[i]!.x.toFixed(2)} ${pts[i]!.y.toFixed(2)}`
  return `${d} Z`
}

function lineSvg(row: { x1: number; y1: number; x2: number; y2: number }, color: string, width: number, dash = ""): string {
  return `<line x1="${row.x1.toFixed(1)}" y1="${row.y1.toFixed(1)}" x2="${row.x2.toFixed(1)}" y2="${row.y2.toFixed(1)}" stroke="${color}" stroke-width="${width}" stroke-linecap="round" ${dash ? `stroke-dasharray="${dash}"` : ""}/>`
}

export function buildStructuralLineRecoveryV1SvgString(
  o: BuildStructuralLineRecoveryV1SvgOptions
): string {
  const pb = o.pageBounds
  const w = pb.maxX - pb.minX
  const h = pb.maxY - pb.minY
  const original = o.originalSegments.map((s) => lineSvg(s, "rgba(180,180,180,0.18)", 0.8)).join("")
  const filtered = o.recovery.filteredFurnitureLikeSegments.map((s) => lineSvg(s, "rgba(220,38,38,0.28)", 0.9)).join("")
  const recovered = o.recovery.connectedStructuralRuns.map((r) => lineSvg(r, "rgba(35,35,35,0.94)", 1.8)).join("")
  const backfilled = o.recovery.acceptedBackfilledSegments.map((s) => lineSvg(s, "rgba(245,158,11,0.92)", 1.9, "6 4")).join("")
  const loops = o.recovery.closedStructuralLoops
    .map((loop) => `<path d="${escapeXml(pathFromPoly(loop.polygon))}" fill="rgba(34,197,94,0.05)" stroke="rgba(34,197,94,0.5)" stroke-width="1.0" stroke-dasharray="5 4"/>`)
    .join("")
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${pb.minX} ${pb.minY} ${w} ${h}" width="${Math.round(w)}" height="${Math.round(h)}">
<rect x="${pb.minX}" y="${pb.minY}" width="${w}" height="${h}" fill="white"/>
<text x="${pb.minX + 8}" y="${pb.minY + 14}" font-size="11" fill="#222" font-family="system-ui,sans-serif">${escapeXml(o.recovery.recoveryStatement)}</text>
<text x="${pb.minX + 8}" y="${pb.minY + 28}" font-size="7.5" fill="#444" font-family="system-ui,sans-serif">Faint gray = original plan lines; faint red = filtered furniture-like lines; dark = recovered structural network; amber dashed = accepted missing-line backfills; green dashed = closed loop candidates.</text>
<g>${original}</g>
<g>${filtered}</g>
<g>${loops}</g>
<g>${backfilled}</g>
<g>${recovered}</g>
</svg>`
}
