import type { ArchitecturalWallHypothesesDebugPayload } from "@/lib/geometryFirst/architecturalWallHypotheses"
import type { FloorplanAiSemanticHintsDebug, PlanBoundingBox } from "@/lib/geometryFirst/types"
import type { GlobalStructuralSpansDebugPayload } from "@/lib/geometryFirst/globalStructuralSpans"

type Pt = { x: number; y: number }
type Orient = "H" | "V"
type EvidenceSource = "hypothesis" | "span" | "ai"

interface AxisEvidence {
  orient: Orient
  coord: number
  from: number
  to: number
  weight: number
  source: EvidenceSource
}

interface ShellEdge {
  orient: Orient
  coord: number
  from: number
  to: number
}

interface NoisyBandV3 {
  bbox: PlanBoundingBox
}

export interface UnitOuterBoundaryRefinementV3Debug {
  refinedUnitPolygon: Pt[]
  refinedBoundaryClosed: boolean
  refinedUnitVertexCount: number
  simplificationSummary: string
  exteriorEvidenceSummary: string
  boundaryRefinementStatement: string
  notes: string[]
  previousRecoveredPolygon: Pt[]
  previousRefinedV2Polygon: Pt[]
  trimmedNoisyBands: NoisyBandV3[]
}

export interface BuildUnitOuterBoundaryRefinementV3SvgOptions {
  pageBounds: PlanBoundingBox
  refinement: UnitOuterBoundaryRefinementV3Debug
  wallHypothesesPlanOnly: ArchitecturalWallHypothesesDebugPayload
  globalSpansPlanOnly: GlobalStructuralSpansDebugPayload
  aiUnitOutlineHint?: Pt[] | null
}

const OPT = {
  axisTol: 6,
  minEdgeLen: 10,
  searchDist: 30,
  maxMove: 18,
  minOverlapRatio: 0.22,
  minEvidenceWeight: 0.72,
  aiBlendMinWeight: 0.35,
  shortJogMax: 14,
  shortEdgeCull: 16,
  bandGapTol: 3,
  minBandArea: 24,
} as const

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

function axisOrient(a: Pt, b: Pt): Orient | null {
  const dx = b.x - a.x
  const dy = b.y - a.y
  if (Math.abs(dy) <= OPT.axisTol && Math.abs(dx) >= OPT.minEdgeLen) return "H"
  if (Math.abs(dx) <= OPT.axisTol && Math.abs(dy) >= OPT.minEdgeLen) return "V"
  return null
}

function segmentLen(a: Pt, b: Pt): number {
  return Math.hypot(b.x - a.x, b.y - a.y)
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

function polygonArea(poly: Pt[]): number {
  return Math.abs(signedArea(poly))
}

function bboxOfPoly(poly: Pt[]): PlanBoundingBox {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of poly) {
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x)
    maxY = Math.max(maxY, p.y)
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 1, maxY: 1 }
  return { minX, minY, maxX, maxY }
}

function rectArea(b: PlanBoundingBox): number {
  return Math.max(0, b.maxX - b.minX) * Math.max(0, b.maxY - b.minY)
}

function dedupConsecutive(poly: Pt[], tol = 1.5): Pt[] {
  const out: Pt[] = []
  for (const p of poly) {
    const prev = out[out.length - 1]
    if (prev && Math.hypot(prev.x - p.x, prev.y - p.y) <= tol) continue
    out.push({ x: p.x, y: p.y })
  }
  if (out.length >= 2) {
    const first = out[0]!
    const last = out[out.length - 1]!
    if (Math.hypot(first.x - last.x, first.y - last.y) <= tol) out.pop()
  }
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
  return dedupConsecutive(out, 1.5)
}

function removeCollinear(poly: Pt[]): Pt[] {
  if (poly.length < 4) return poly
  const out: Pt[] = []
  for (let i = 0; i < poly.length; i++) {
    const a = poly[(i - 1 + poly.length) % poly.length]!
    const b = poly[i]!
    const c = poly[(i + 1) % poly.length]!
    if ((Math.abs(a.x - b.x) <= OPT.axisTol && Math.abs(b.x - c.x) <= OPT.axisTol) ||
        (Math.abs(a.y - b.y) <= OPT.axisTol && Math.abs(b.y - c.y) <= OPT.axisTol)) {
      continue
    }
    out.push(b)
  }
  return dedupConsecutive(out, 1.5)
}

function normalizeLoop(poly: Pt[]): Pt[] {
  return removeCollinear(axisSnapPoly(dedupConsecutive(poly, 1.5)))
}

function overlapLen(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0))
}

function overlapRatio(a0: number, a1: number, b0: number, b1: number): number {
  const ov = overlapLen(a0, a1, b0, b1)
  const denom = Math.max(1, Math.min(a1 - a0, b1 - b0))
  return ov / denom
}

function evidenceFromHypotheses(payload: ArchitecturalWallHypothesesDebugPayload): AxisEvidence[] {
  const out: AxisEvidence[] = []
  for (const h of payload.hypotheses) {
    if (h.orientation !== "horizontal" && h.orientation !== "vertical") continue
    if (h.exteriorLikelihood < 0.34) continue
    if (h.length < 18) continue
    const orient: Orient = h.orientation === "horizontal" ? "H" : "V"
    out.push({
      orient,
      coord: orient === "H" ? (h.centerline.y1 + h.centerline.y2) / 2 : (h.centerline.x1 + h.centerline.x2) / 2,
      from: orient === "H" ? Math.min(h.centerline.x1, h.centerline.x2) : Math.min(h.centerline.y1, h.centerline.y2),
      to: orient === "H" ? Math.max(h.centerline.x1, h.centerline.x2) : Math.max(h.centerline.y1, h.centerline.y2),
      weight: 0.85 + h.exteriorLikelihood * 1.3 + h.supportScore * 0.45,
      source: "hypothesis",
    })
  }
  return out
}

function evidenceFromSpans(payload: GlobalStructuralSpansDebugPayload): AxisEvidence[] {
  const out: AxisEvidence[] = []
  for (const s of payload.spans) {
    if (s.orientation !== "horizontal" && s.orientation !== "vertical") continue
    if (s.shellHintScore < 0.52) continue
    if (s.spanLength < 24) continue
    const orient: Orient = s.orientation === "horizontal" ? "H" : "V"
    out.push({
      orient,
      coord: orient === "H" ? (s.centerline.y1 + s.centerline.y2) / 2 : (s.centerline.x1 + s.centerline.x2) / 2,
      from: orient === "H" ? Math.min(s.centerline.x1, s.centerline.x2) : Math.min(s.centerline.y1, s.centerline.y2),
      to: orient === "H" ? Math.max(s.centerline.x1, s.centerline.x2) : Math.max(s.centerline.y1, s.centerline.y2),
      weight: 0.55 + s.shellHintScore * 1.0 + s.structuralSupportScore * 0.25,
      source: "span",
    })
  }
  return out
}

function evidenceFromAi(poly: Pt[] | null | undefined): AxisEvidence[] {
  const out: AxisEvidence[] = []
  if (!poly || poly.length < 2) return out
  const loop = normalizeLoop(poly)
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
      weight: 0.24,
      source: "ai",
    })
  }
  return out
}

function buildShellEdges(poly: Pt[]): ShellEdge[] {
  const loop = normalizeLoop(poly)
  const out: ShellEdge[] = []
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

function weightedCoord(edge: ShellEdge, evidence: AxisEvidence[]): { coord: number; usedAi: boolean; usedDeterministic: boolean } {
  let sum = 0
  let wsum = 0
  let aiSum = 0
  let aiW = 0
  let detSum = 0
  let detW = 0
  for (const ev of evidence) {
    if (ev.orient !== edge.orient) continue
    const near = Math.abs(ev.coord - edge.coord)
    if (near > OPT.searchDist) continue
    const ov = overlapRatio(edge.from, edge.to, ev.from, ev.to)
    if (ov < OPT.minOverlapRatio) continue
    const w = ev.weight * (1 - near / OPT.searchDist) * ov
    if (w <= 0) continue
    sum += ev.coord * w
    wsum += w
    if (ev.source === "ai") {
      aiSum += ev.coord * w
      aiW += w
    } else {
      detSum += ev.coord * w
      detW += w
    }
  }
  if (detW >= OPT.minEvidenceWeight) {
    return {
      coord: clamp(detSum / detW, edge.coord - OPT.maxMove, edge.coord + OPT.maxMove),
      usedAi: false,
      usedDeterministic: true,
    }
  }
  if (wsum >= OPT.aiBlendMinWeight) {
    return {
      coord: clamp(sum / wsum, edge.coord - OPT.maxMove, edge.coord + OPT.maxMove),
      usedAi: aiW > 0,
      usedDeterministic: detW > 0,
    }
  }
  return { coord: edge.coord, usedAi: false, usedDeterministic: false }
}

function buildLoopFromEdges(edges: ShellEdge[]): Pt[] {
  const pts: Pt[] = []
  for (let i = 0; i < edges.length; i++) {
    const prev = edges[(i - 1 + edges.length) % edges.length]!
    const cur = edges[i]!
    if (prev.orient === "V" && cur.orient === "H") pts.push({ x: prev.coord, y: cur.coord })
    else if (prev.orient === "H" && cur.orient === "V") pts.push({ x: cur.coord, y: prev.coord })
  }
  return normalizeLoop(pts)
}

function removeShortAxisVertex(poly: Pt[]): Pt[] {
  if (poly.length < 4) return poly
  const out: Pt[] = []
  for (let i = 0; i < poly.length; i++) {
    const a = poly[(i - 1 + poly.length) % poly.length]!
    const b = poly[i]!
    const c = poly[(i + 1) % poly.length]!
    const ab = segmentLen(a, b)
    const bc = segmentLen(b, c)
    if ((ab < OPT.shortEdgeCull || bc < OPT.shortEdgeCull) && axisOrient(a, c)) continue
    out.push(b)
  }
  return dedupConsecutive(out, 1.5)
}

function collapseShortJogs(poly: Pt[]): Pt[] {
  if (poly.length < 5) return poly
  const next: Pt[] = []
  let i = 0
  while (i < poly.length) {
    const a = poly[(i - 1 + poly.length) % poly.length]!
    const b = poly[i]!
    const c = poly[(i + 1) % poly.length]!
    const d = poly[(i + 2) % poly.length]!
    const ab = axisOrient(a, b)
    const bc = axisOrient(b, c)
    const cd = axisOrient(c, d)
    if (ab && bc && cd && ab === cd && ab !== bc) {
      const lenAB = segmentLen(a, b)
      const lenCD = segmentLen(c, d)
      if (lenAB <= OPT.shortJogMax) {
        next.push(ab === "H" ? { x: a.x, y: d.y } : { x: d.x, y: a.y })
        i += 2
        continue
      }
      if (lenCD <= OPT.shortJogMax) {
        next.push(b)
        next.push(ab === "H" ? { x: d.x, y: a.y } : { x: a.x, y: d.y })
        i += 2
        continue
      }
    }
    next.push(b)
    i++
  }
  return dedupConsecutive(next, 1.5)
}

function regularizeLoop(poly: Pt[]): { poly: Pt[]; removedVertices: number; summary: string } {
  let current = normalizeLoop(poly)
  const initial = current.length
  let changed = true
  let pass = 0
  while (changed && pass < 8) {
    pass++
    const before = current.length
    current = removeCollinear(current)
    current = removeShortAxisVertex(current)
    if (current.length > 10) current = collapseShortJogs(current)
    current = removeCollinear(current)
    current = axisSnapPoly(current)
    changed = current.length !== before
  }
  return {
    poly: current,
    removedVertices: Math.max(0, initial - current.length),
    summary: `Regularization passes=${pass}, vertices ${initial} -> ${current.length}.`,
  }
}

function mildRegularizeLoop(poly: Pt[]): { poly: Pt[]; removedVertices: number; summary: string } {
  let current = normalizeLoop(poly)
  const initial = current.length
  let changed = true
  let pass = 0
  while (changed && pass < 6) {
    pass++
    const before = current.length
    current = removeCollinear(current)
    current = removeShortAxisVertex(current)
    current = removeCollinear(current)
    current = axisSnapPoly(current)
    changed = current.length !== before
  }
  return {
    poly: current,
    removedVertices: Math.max(0, initial - current.length),
    summary: `Mild regularization passes=${pass}, vertices ${initial} -> ${current.length}.`,
  }
}

function noisyBandsFromV2(v2: Pt[], v3: Pt[]): NoisyBandV3[] {
  const v3Box = bboxOfPoly(v3)
  const loop = normalizeLoop(v2)
  const bands: NoisyBandV3[] = []
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i]!
    const b = loop[(i + 1) % loop.length]!
    if (segmentLen(a, b) > OPT.shortJogMax) continue
    const box = {
      minX: Math.min(a.x, b.x) - OPT.bandGapTol,
      minY: Math.min(a.y, b.y) - OPT.bandGapTol,
      maxX: Math.max(a.x, b.x) + OPT.bandGapTol,
      maxY: Math.max(a.y, b.y) + OPT.bandGapTol,
    }
    const overlapsMain =
      box.maxX >= v3Box.minX &&
      box.minX <= v3Box.maxX &&
      box.maxY >= v3Box.minY &&
      box.minY <= v3Box.maxY
    if (!overlapsMain || rectArea(box) < OPT.minBandArea) continue
    bands.push({ bbox: box })
  }
  return bands
}

function candidateMetrics(poly: Pt[], baseLoop: Pt[]): { widthRatio: number; areaRatio: number; valid: boolean; score: number } {
  const baseBox = bboxOfPoly(baseLoop)
  const polyBox = bboxOfPoly(poly)
  const widthRatio = (polyBox.maxX - polyBox.minX) / Math.max(1, baseBox.maxX - baseBox.minX)
  const areaRatio = polygonArea(poly) / Math.max(1, polygonArea(baseLoop))
  const valid = poly.length >= 8 && widthRatio >= 0.9 && areaRatio >= 0.78 && areaRatio <= 1.08
  const score =
    Math.abs(1 - widthRatio) * 3 +
    Math.abs(0.96 - areaRatio) * 4 +
    Math.max(0, 16 - poly.length) * 0.03
  return { widthRatio, areaRatio, valid, score }
}

export function buildUnitOuterBoundaryRefinementV3(
  recoveredUnitPolygon: Pt[],
  refinedUnitPolygonV2: Pt[],
  wallHypothesesPlanOnly: ArchitecturalWallHypothesesDebugPayload,
  globalSpansPlanOnly: GlobalStructuralSpansDebugPayload,
  aiSemanticHints?: FloorplanAiSemanticHintsDebug
): UnitOuterBoundaryRefinementV3Debug {
  const notes: string[] = []
  const baseLoop = normalizeLoop(recoveredUnitPolygon)
  const prevV2 = normalizeLoop(refinedUnitPolygonV2)
  const workingLoop = prevV2.length >= 8 ? prevV2 : baseLoop
  if (baseLoop.length < 4) {
    return {
      refinedUnitPolygon: baseLoop,
      refinedBoundaryClosed: baseLoop.length >= 3,
      refinedUnitVertexCount: baseLoop.length,
      simplificationSummary: "Refinement v3 skipped because recovered shell was invalid.",
      exteriorEvidenceSummary: "No exterior evidence used.",
      boundaryRefinementStatement: "Unit outer boundary refinement v3 skipped.",
      notes: ["Recovered shell had insufficient vertices."],
      previousRecoveredPolygon: baseLoop,
      previousRefinedV2Polygon: prevV2,
      trimmedNoisyBands: [],
    }
  }

  const evidence = [
    ...evidenceFromHypotheses(wallHypothesesPlanOnly),
    ...evidenceFromSpans(globalSpansPlanOnly),
    ...evidenceFromAi(aiSemanticHints?.unitOutlineHint?.pdfPageVertices ?? null),
  ]
  const baseEdges = buildShellEdges(workingLoop)
  let usedAi = 0
  let usedDeterministic = 0
  const adjustedEdges = baseEdges.map((edge) => {
    const weighted = weightedCoord(edge, evidence)
    if (weighted.usedAi) usedAi++
    if (weighted.usedDeterministic) usedDeterministic++
    return { ...edge, coord: weighted.coord }
  })
  const adjustedLoop = buildLoopFromEdges(adjustedEdges)
  const aggressive = regularizeLoop(adjustedLoop)
  const mild = mildRegularizeLoop(adjustedLoop)
  const directMild = mildRegularizeLoop(prevV2.length >= 8 ? prevV2 : baseLoop)
  const candidates = [
    { kind: "aggressive-adjusted", result: aggressive, metrics: candidateMetrics(aggressive.poly, baseLoop) },
    { kind: "mild-adjusted", result: mild, metrics: candidateMetrics(mild.poly, baseLoop) },
    { kind: "mild-direct-v2", result: directMild, metrics: candidateMetrics(directMild.poly, baseLoop) },
  ]
  const validCandidates = candidates.filter((c) => c.metrics.valid)
  const chosen = (validCandidates.length ? validCandidates : candidates).sort((a, b) => a.metrics.score - b.metrics.score)[0]!
  const reg = chosen.result
  const refinedLoop = reg.poly

  const baseBox = bboxOfPoly(baseLoop)
  const refinedBox = bboxOfPoly(refinedLoop)
  const widthRatio = (refinedBox.maxX - refinedBox.minX) / Math.max(1, baseBox.maxX - baseBox.minX)
  const areaRatio = polygonArea(refinedLoop) / Math.max(1, polygonArea(baseLoop))
  if (refinedLoop.length < 8 || widthRatio < 0.92 || areaRatio < 0.8 || areaRatio > 1.08) {
    notes.push("Refinement v3 safety checks failed, falling back to recovered v1 shell.")
    return {
      refinedUnitPolygon: baseLoop,
      refinedBoundaryClosed: true,
      refinedUnitVertexCount: baseLoop.length,
      simplificationSummary: `Regularization rejected candidate (areaRatio=${areaRatio.toFixed(2)}, widthRatio=${widthRatio.toFixed(2)}, verts=${refinedLoop.length}).`,
      exteriorEvidenceSummary: `Exterior-only evidence rows: hypotheses=${evidence.filter((e) => e.source === "hypothesis").length}, spans=${evidence.filter((e) => e.source === "span").length}, ai=${evidence.filter((e) => e.source === "ai").length}.`,
      boundaryRefinementStatement: "Unit outer boundary refinement v3 fell back to the recovered v1 shell.",
      notes,
      previousRecoveredPolygon: baseLoop,
      previousRefinedV2Polygon: prevV2,
      trimmedNoisyBands: noisyBandsFromV2(prevV2, baseLoop),
    }
  }

  const noisyBands = noisyBandsFromV2(prevV2, refinedLoop)
  const simplificationSummary =
    `Regularization removed ${reg.removedVertices} vertex/vertices; ` +
    `${reg.summary} candidate=${chosen.kind}; v2=${prevV2.length} vs v3=${refinedLoop.length}.`
  const exteriorEvidenceSummary =
    `Exterior-only evidence: hypotheses=${evidence.filter((e) => e.source === "hypothesis").length}, ` +
    `spans=${evidence.filter((e) => e.source === "span").length}, ai=${evidence.filter((e) => e.source === "ai").length}; ` +
    `deterministic-guided edges=${usedDeterministic}, ai-guided edges=${usedAi}.`
  const boundaryRefinementStatement =
    `Unit outer boundary refinement v3: ${refinedLoop.length} vertices, closed=true, ` +
    `bbox ${(refinedBox.maxX - refinedBox.minX).toFixed(0)}×${(refinedBox.maxY - refinedBox.minY).toFixed(0)}, ` +
    `${noisyBands.length} noisy band(s) trimmed.`
  notes.push(
    `Base bbox ${(baseBox.maxX - baseBox.minX).toFixed(0)}×${(baseBox.maxY - baseBox.minY).toFixed(0)} -> refined ${(refinedBox.maxX - refinedBox.minX).toFixed(0)}×${(refinedBox.maxY - refinedBox.minY).toFixed(0)}.`
  )
  if (usedAi === 0 && aiSemanticHints?.unitOutlineHint?.pdfPageVertices?.length) {
    notes.push("AI prior remained soft and did not override stronger exterior evidence.")
  }

  return {
    refinedUnitPolygon: refinedLoop,
    refinedBoundaryClosed: true,
    refinedUnitVertexCount: refinedLoop.length,
    simplificationSummary,
    exteriorEvidenceSummary,
    boundaryRefinementStatement,
    notes,
    previousRecoveredPolygon: baseLoop,
    previousRefinedV2Polygon: prevV2,
    trimmedNoisyBands: noisyBands,
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

function segmentSvg(s: { x1: number; y1: number; x2: number; y2: number }, color: string, width: number, dash = ""): string {
  return `<line x1="${s.x1.toFixed(1)}" y1="${s.y1.toFixed(1)}" x2="${s.x2.toFixed(1)}" y2="${s.y2.toFixed(1)}" stroke="${color}" stroke-width="${width}" ${dash ? `stroke-dasharray="${dash}"` : ""}/>`
}

export function buildUnitOuterBoundaryRefinementV3SvgString(
  o: BuildUnitOuterBoundaryRefinementV3SvgOptions
): string {
  const pb = o.pageBounds
  const w = pb.maxX - pb.minX
  const h = pb.maxY - pb.minY
  const v1Shell =
    o.refinement.previousRecoveredPolygon.length >= 3
      ? `<path d="${escapeXml(pathFromPoly(o.refinement.previousRecoveredPolygon, true))}" fill="rgba(180,50,50,0.03)" stroke="rgba(180,50,50,0.35)" stroke-width="1.3" stroke-dasharray="6 4"/>`
      : ""
  const v2Shell =
    o.refinement.previousRefinedV2Polygon.length >= 3
      ? `<path d="${escapeXml(pathFromPoly(o.refinement.previousRefinedV2Polygon, true))}" fill="none" stroke="rgba(120,120,120,0.28)" stroke-width="1.1" stroke-dasharray="3 3"/>`
      : ""
  const v3Shell =
    o.refinement.refinedUnitPolygon.length >= 3
      ? `<path d="${escapeXml(pathFromPoly(o.refinement.refinedUnitPolygon, o.refinement.refinedBoundaryClosed))}" fill="rgba(30,160,80,0.07)" stroke="rgba(20,120,50,0.96)" stroke-width="2.5"/>`
      : ""
  const hypLines = o.wallHypothesesPlanOnly.hypotheses
    .filter((h) => h.exteriorLikelihood >= 0.45 && (h.orientation === "horizontal" || h.orientation === "vertical"))
    .map((h) => segmentSvg(h.centerline, "rgba(30,90,220,0.48)", 1.2))
    .join("")
  const spanLines = o.globalSpansPlanOnly.spans
    .filter((s) => s.shellHintScore >= 0.52 && (s.orientation === "horizontal" || s.orientation === "vertical"))
    .map((s) => segmentSvg(s.centerline, "rgba(255,140,0,0.45)", 1.1, "6 3"))
    .join("")
  const aiOverlay =
    o.aiUnitOutlineHint && o.aiUnitOutlineHint.length >= 3
      ? `<path d="${escapeXml(pathFromPoly(o.aiUnitOutlineHint, true))}" fill="none" stroke="rgba(140,70,220,0.72)" stroke-width="1.4" stroke-dasharray="7 5"/>`
      : ""
  const noisyBands = o.refinement.trimmedNoisyBands
    .map(
      (band) =>
        `<rect x="${band.bbox.minX.toFixed(1)}" y="${band.bbox.minY.toFixed(1)}" width="${(band.bbox.maxX - band.bbox.minX).toFixed(1)}" height="${(band.bbox.maxY - band.bbox.minY).toFixed(1)}" fill="rgba(245,158,11,0.20)" stroke="rgba(217,119,6,0.7)" stroke-width="0.9" stroke-dasharray="4 3"/>`
    )
    .join("")
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${pb.minX} ${pb.minY} ${w} ${h}" width="${Math.round(w)}" height="${Math.round(h)}">
<rect x="${pb.minX}" y="${pb.minY}" width="${w}" height="${h}" fill="white"/>
<text x="${pb.minX + 8}" y="${pb.minY + 14}" font-size="11" fill="#222" font-family="system-ui,sans-serif">${escapeXml(o.refinement.boundaryRefinementStatement)}</text>
<text x="${pb.minX + 8}" y="${pb.minY + 28}" font-size="7.5" fill="#444" font-family="system-ui,sans-serif">Green = v3 shell; faint red dashed = v1 shell; faint gray dashed = v2 shell; blue = exterior wall evidence; orange dashed = exterior spans; purple dashed = AI shell hint; orange bands = noisy regions trimmed.</text>
<g>${hypLines}</g>
<g>${spanLines}</g>
<g>${noisyBands}</g>
<g>${v1Shell}</g>
<g>${v2Shell}</g>
<g>${aiOverlay}</g>
<g>${v3Shell}</g>
</svg>`
}
