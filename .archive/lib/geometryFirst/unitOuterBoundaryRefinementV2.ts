import type { ArchitecturalWallHypothesesDebugPayload } from "@/lib/geometryFirst/architecturalWallHypotheses"
import type { FloorplanAiSemanticHintsDebug, ExtractedLineSegment, PlanBoundingBox } from "@/lib/geometryFirst/types"
import type { GlobalStructuralSpansDebugPayload } from "@/lib/geometryFirst/globalStructuralSpans"

type Pt = { x: number; y: number }
type Orient = "H" | "V"
type EvidenceSource = "segment" | "hypothesis" | "span" | "ai"
type BandMode = "added" | "trimmed"

interface AxisEvidence {
  orient: Orient
  coord: number
  from: number
  to: number
  weight: number
  source: EvidenceSource
}

interface BaseEdge {
  index: number
  orient: Orient
  start: Pt
  end: Pt
  origCoord: number
  from: number
  to: number
  dir: 1 | -1
}

interface RefinedSubedge {
  orient: Orient
  from: number
  to: number
  coord: number
  origCoord: number
  evidenceSource: EvidenceSource | "base"
}

interface ChangeBandV2 {
  bbox: PlanBoundingBox
  mode: BandMode
}

export interface UnitOuterBoundaryRefinementV2Debug {
  refinedUnitPolygon: Pt[]
  refinedBoundaryClosed: boolean
  refinementSupportSummary: string
  aiPriorUsageSummary: string
  boundaryRefinementStatement: string
  notes: string[]
  previousRecoveredPolygon: Pt[]
  changeBands: ChangeBandV2[]
}

export interface BuildUnitOuterBoundaryRefinementV2SvgOptions {
  pageBounds: PlanBoundingBox
  refinement: UnitOuterBoundaryRefinementV2Debug
  primaryLayoutSegments: ExtractedLineSegment[]
  wallHypothesesPlanOnly: ArchitecturalWallHypothesesDebugPayload
  globalSpansPlanOnly: GlobalStructuralSpansDebugPayload
  aiUnitOutlineHint?: Pt[] | null
}

const OPT = {
  axisTol: 6,
  minSegLen: 10,
  maxSearchDist: 56,
  maxMoveDist: 42,
  minOverlapRatio: 0.14,
  minEvidenceWeight: 0.55,
  aiOnlyMinWeight: 0.22,
  mergeCoordTol: 4,
  breakSnapTol: 4,
  minSubedgeLen: 14,
  minBandShift: 4,
} as const

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

function segmentLength(a: Pt, b: Pt): number {
  return Math.hypot(b.x - a.x, b.y - a.y)
}

function axisOrient(a: Pt, b: Pt): Orient | null {
  const dx = b.x - a.x
  const dy = b.y - a.y
  if (Math.abs(dy) <= OPT.axisTol && Math.abs(dx) >= OPT.minSegLen) return "H"
  if (Math.abs(dx) <= OPT.axisTol && Math.abs(dy) >= OPT.minSegLen) return "V"
  return null
}

function signedAreaPage(poly: Pt[]): number {
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
  return Math.abs(signedAreaPage(poly))
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

function normalizeLoop(poly: Pt[]): Pt[] {
  return axisSnapPoly(dedupConsecutive(poly, 1.5))
}

function overlapLen(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0))
}

function overlapRatio(a0: number, a1: number, b0: number, b1: number): number {
  const ov = overlapLen(a0, a1, b0, b1)
  const denom = Math.max(1, Math.min(a1 - a0, b1 - b0))
  return ov / denom
}

function uniqueSorted(values: number[]): number[] {
  const s = [...values].sort((a, b) => a - b)
  const out: number[] = []
  for (const v of s) {
    if (!out.length || Math.abs(out[out.length - 1]! - v) > OPT.breakSnapTol) out.push(v)
  }
  return out
}

function asAxisEvidenceFromSegment(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  weight: number,
  source: EvidenceSource
): AxisEvidence | null {
  const a = { x: x1, y: y1 }
  const b = { x: x2, y: y2 }
  const orient = axisOrient(a, b)
  if (!orient) return null
  if (orient === "H") {
    return {
      orient,
      coord: (y1 + y2) / 2,
      from: Math.min(x1, x2),
      to: Math.max(x1, x2),
      weight,
      source,
    }
  }
  return {
    orient,
    coord: (x1 + x2) / 2,
    from: Math.min(y1, y2),
    to: Math.max(y1, y2),
    weight,
    source,
  }
}

function evidenceFromPrimarySegments(segments: ExtractedLineSegment[]): AxisEvidence[] {
  const out: AxisEvidence[] = []
  for (const s of segments) {
    const len = Math.hypot(s.x2 - s.x1, s.y2 - s.y1)
    if (len < OPT.minSegLen) continue
    const ev = asAxisEvidenceFromSegment(
      s.x1,
      s.y1,
      s.x2,
      s.y2,
      0.35 + Math.min(0.55, len / 160),
      "segment"
    )
    if (ev) out.push(ev)
  }
  return out
}

function evidenceFromHypotheses(payload: ArchitecturalWallHypothesesDebugPayload): AxisEvidence[] {
  const out: AxisEvidence[] = []
  for (const h of payload.hypotheses) {
    if (h.orientation !== "horizontal" && h.orientation !== "vertical") continue
    if (h.length < OPT.minSegLen) continue
    const ev = asAxisEvidenceFromSegment(
      h.centerline.x1,
      h.centerline.y1,
      h.centerline.x2,
      h.centerline.y2,
      0.65 + h.exteriorLikelihood * 1.05 + h.supportScore * 0.55,
      "hypothesis"
    )
    if (ev) out.push(ev)
  }
  return out
}

function evidenceFromSpans(payload: GlobalStructuralSpansDebugPayload): AxisEvidence[] {
  const out: AxisEvidence[] = []
  for (const s of payload.spans) {
    if (s.orientation !== "horizontal" && s.orientation !== "vertical") continue
    if (s.spanLength < OPT.minSegLen) continue
    const ev = asAxisEvidenceFromSegment(
      s.centerline.x1,
      s.centerline.y1,
      s.centerline.x2,
      s.centerline.y2,
      0.45 + s.shellHintScore * 0.95 + s.structuralSupportScore * 0.4,
      "span"
    )
    if (ev) out.push(ev)
  }
  return out
}

function evidenceFromAiHint(poly: Pt[] | null | undefined): AxisEvidence[] {
  const out: AxisEvidence[] = []
  if (!poly || poly.length < 2) return out
  const loop = normalizeLoop(poly)
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i]!
    const b = loop[(i + 1) % loop.length]!
    const ev = asAxisEvidenceFromSegment(a.x, a.y, b.x, b.y, 0.28, "ai")
    if (ev) out.push(ev)
  }
  return out
}

function buildBaseEdges(poly: Pt[]): BaseEdge[] {
  const loop = normalizeLoop(poly)
  const out: BaseEdge[] = []
  for (let i = 0; i < loop.length; i++) {
    const start = loop[i]!
    const end = loop[(i + 1) % loop.length]!
    const orient = axisOrient(start, end)
    if (!orient) continue
    if (orient === "H") {
      out.push({
        index: i,
        orient,
        start,
        end,
        origCoord: (start.y + end.y) / 2,
        from: Math.min(start.x, end.x),
        to: Math.max(start.x, end.x),
        dir: end.x >= start.x ? 1 : -1,
      })
    } else {
      out.push({
        index: i,
        orient,
        start,
        end,
        origCoord: (start.x + end.x) / 2,
        from: Math.min(start.y, end.y),
        to: Math.max(start.y, end.y),
        dir: end.y >= start.y ? 1 : -1,
      })
    }
  }
  return out
}

function weightedCoord(
  edge: BaseEdge,
  a: number,
  b: number,
  evidence: AxisEvidence[]
): { coord: number; source: EvidenceSource | "base"; score: number } {
  let sumWeight = 0
  let sumCoord = 0
  let bestScore = 0
  let bestSource: EvidenceSource | "base" = "base"
  let nonAiWeight = 0
  let nonAiCoord = 0
  for (const ev of evidence) {
    if (ev.orient !== edge.orient) continue
    const near = Math.abs(ev.coord - edge.origCoord)
    if (near > OPT.maxSearchDist) continue
    const ovRatio = overlapRatio(a, b, ev.from, ev.to)
    if (ovRatio < OPT.minOverlapRatio) continue
    const proximity = 1 - near / OPT.maxSearchDist
    const w = ev.weight * ovRatio * proximity
    if (w <= 0) continue
    sumWeight += w
    sumCoord += ev.coord * w
    if (ev.source !== "ai") {
      nonAiWeight += w
      nonAiCoord += ev.coord * w
    }
    if (w > bestScore) {
      bestScore = w
      bestSource = ev.source
    }
  }
  if (nonAiWeight >= OPT.minEvidenceWeight) {
    const c = nonAiCoord / nonAiWeight
    return {
      coord: clamp(c, edge.origCoord - OPT.maxMoveDist, edge.origCoord + OPT.maxMoveDist),
      source: bestSource === "ai" ? "segment" : bestSource,
      score: nonAiWeight,
    }
  }
  if (sumWeight >= OPT.aiOnlyMinWeight) {
    return {
      coord: clamp(sumCoord / sumWeight, edge.origCoord - OPT.maxMoveDist, edge.origCoord + OPT.maxMoveDist),
      source: bestSource,
      score: sumWeight,
    }
  }
  return { coord: edge.origCoord, source: "base", score: 0 }
}

function refineEdge(edge: BaseEdge, evidence: AxisEvidence[]): RefinedSubedge[] {
  const cuts = [edge.from, edge.to]
  for (const ev of evidence) {
    if (ev.orient !== edge.orient) continue
    if (Math.abs(ev.coord - edge.origCoord) > OPT.maxSearchDist) continue
    if (overlapRatio(edge.from, edge.to, ev.from, ev.to) < OPT.minOverlapRatio) continue
    cuts.push(clamp(ev.from, edge.from, edge.to))
    cuts.push(clamp(ev.to, edge.from, edge.to))
  }
  const ordered = uniqueSorted(cuts)
  const parts: RefinedSubedge[] = []
  for (let i = 0; i < ordered.length - 1; i++) {
    const a = ordered[i]!
    const b = ordered[i + 1]!
    if (b - a < OPT.minSubedgeLen) continue
    const best = weightedCoord(edge, a, b, evidence)
    parts.push({
      orient: edge.orient,
      from: a,
      to: b,
      coord: best.coord,
      origCoord: edge.origCoord,
      evidenceSource: best.source,
    })
  }
  if (!parts.length) {
    parts.push({
      orient: edge.orient,
      from: edge.from,
      to: edge.to,
      coord: edge.origCoord,
      origCoord: edge.origCoord,
      evidenceSource: "base",
    })
  }
  const merged: RefinedSubedge[] = []
  for (const part of parts) {
    const prev = merged[merged.length - 1]
    if (
      prev &&
      prev.orient === part.orient &&
      Math.abs(prev.coord - part.coord) <= OPT.mergeCoordTol &&
      Math.abs(prev.to - part.from) <= OPT.breakSnapTol &&
      prev.evidenceSource === part.evidenceSource
    ) {
      prev.to = part.to
    } else {
      merged.push({ ...part })
    }
  }
  return merged
}

function pointOfSubedgeStart(edge: RefinedSubedge): Pt {
  return edge.orient === "H"
    ? { x: edge.from, y: edge.coord }
    : { x: edge.coord, y: edge.from }
}

function pointOfSubedgeEnd(edge: RefinedSubedge): Pt {
  return edge.orient === "H"
    ? { x: edge.to, y: edge.coord }
    : { x: edge.coord, y: edge.to }
}

function buildRefinedLoop(baseEdges: BaseEdge[], refinedEdges: RefinedSubedge[][]): Pt[] {
  const pts: Pt[] = []
  for (let i = 0; i < refinedEdges.length; i++) {
    const cur = refinedEdges[i]!
    const next = refinedEdges[(i + 1) % refinedEdges.length]!
    if (!cur.length || !next.length) continue
    if (pts.length === 0) pts.push(pointOfSubedgeStart(cur[0]!))
    for (const sub of cur) {
      pts.push(pointOfSubedgeEnd(sub))
    }
    const curEnd = pointOfSubedgeEnd(cur[cur.length - 1]!)
    const nextStart = pointOfSubedgeStart(next[0]!)
    const curOrient = baseEdges[i]!.orient
    const nextOrient = baseEdges[(i + 1) % baseEdges.length]!.orient
    if (Math.hypot(curEnd.x - nextStart.x, curEnd.y - nextStart.y) > 1.5) {
      const bridge =
        curOrient === "H" && nextOrient === "V"
          ? { x: nextStart.x, y: curEnd.y }
          : curOrient === "V" && nextOrient === "H"
            ? { x: curEnd.x, y: nextStart.y }
            : nextStart
      pts.push(bridge)
      pts.push(nextStart)
    }
  }
  return normalizeLoop(pts)
}

function edgeOutwardBandMode(edge: BaseEdge, newCoord: number, clockwisePage: boolean): BandMode {
  const delta = newCoord - edge.origCoord
  let outwardSign = 0
  if (edge.orient === "H") {
    const leftNormalSign = edge.dir > 0 ? -1 : 1
    outwardSign = clockwisePage ? leftNormalSign : -leftNormalSign
  } else {
    const leftNormalSign = edge.dir > 0 ? 1 : -1
    outwardSign = clockwisePage ? leftNormalSign : -leftNormalSign
  }
  return delta * outwardSign > 0 ? "added" : "trimmed"
}

function bandBBoxFromSubedge(sub: RefinedSubedge): PlanBoundingBox | null {
  if (Math.abs(sub.coord - sub.origCoord) < OPT.minBandShift) return null
  if (sub.orient === "H") {
    return {
      minX: sub.from,
      maxX: sub.to,
      minY: Math.min(sub.coord, sub.origCoord),
      maxY: Math.max(sub.coord, sub.origCoord),
    }
  }
  return {
    minX: Math.min(sub.coord, sub.origCoord),
    maxX: Math.max(sub.coord, sub.origCoord),
    minY: sub.from,
    maxY: sub.to,
  }
}

export function buildUnitOuterBoundaryRefinementV2(
  recoveredUnitPolygon: Pt[],
  primaryLayoutSegments: ExtractedLineSegment[],
  _primaryLayoutCleanedIndices: number[],
  wallHypothesesPlanOnly: ArchitecturalWallHypothesesDebugPayload,
  globalSpansPlanOnly: GlobalStructuralSpansDebugPayload,
  aiSemanticHints?: FloorplanAiSemanticHintsDebug
): UnitOuterBoundaryRefinementV2Debug {
  const notes: string[] = []
  const baseLoop = normalizeLoop(recoveredUnitPolygon)
  if (baseLoop.length < 4) {
    return {
      refinedUnitPolygon: baseLoop,
      refinedBoundaryClosed: baseLoop.length >= 3,
      refinementSupportSummary: "Refinement skipped: recovered shell was too small to refine.",
      aiPriorUsageSummary: aiSemanticHints?.unitOutlineHint?.pdfPageVertices?.length
        ? "AI prior available but unused because recovered shell was invalid."
        : "AI prior unavailable.",
      boundaryRefinementStatement: "Unit outer boundary refinement v2 skipped.",
      notes: ["Recovered v1 polygon had insufficient vertices."],
      previousRecoveredPolygon: baseLoop,
      changeBands: [],
    }
  }

  const aiHint = aiSemanticHints?.unitOutlineHint?.pdfPageVertices ?? null
  const evidence = [
    ...evidenceFromPrimarySegments(primaryLayoutSegments),
    ...evidenceFromHypotheses(wallHypothesesPlanOnly),
    ...evidenceFromSpans(globalSpansPlanOnly),
    ...evidenceFromAiHint(aiHint),
  ]
  notes.push(
    `Evidence rows: ${primaryLayoutSegments.length} primary segments, ${wallHypothesesPlanOnly.hypotheses.length} hypotheses, ${globalSpansPlanOnly.spans.length} spans, ${aiHint?.length ?? 0} AI vertices.`
  )

  const baseEdges = buildBaseEdges(baseLoop)
  const refinedEdges = baseEdges.map((edge) => refineEdge(edge, evidence))
  const refinedLoop = buildRefinedLoop(baseEdges, refinedEdges)
  const baseBox = bboxOfPoly(baseLoop)
  const refinedBox = bboxOfPoly(refinedLoop)
  const baseArea = polygonArea(baseLoop)
  const refinedArea = polygonArea(refinedLoop)

  const widthRatio = (refinedBox.maxX - refinedBox.minX) / Math.max(1, baseBox.maxX - baseBox.minX)
  if (refinedLoop.length < 4 || refinedArea < baseArea * 0.55 || widthRatio < 0.9) {
    notes.push("Refined shell failed safety checks, falling back to recovered v1 polygon.")
    return {
      refinedUnitPolygon: baseLoop,
      refinedBoundaryClosed: true,
      refinementSupportSummary: `Refinement evidence gathered but rejected by safety checks (verts=${refinedLoop.length}, areaRatio=${(refinedArea / Math.max(1, baseArea)).toFixed(2)}, widthRatio=${widthRatio.toFixed(2)}).`,
      aiPriorUsageSummary: aiHint?.length
        ? "AI prior supplied as a soft prior but final refinement fell back to v1."
        : "No AI prior was available; final refinement fell back to v1.",
      boundaryRefinementStatement: "Unit outer boundary refinement v2 fell back to the v1 shell.",
      notes,
      previousRecoveredPolygon: baseLoop,
      changeBands: [],
    }
  }

  const clockwisePage = signedAreaPage(baseLoop) > 0
  const changeBands: ChangeBandV2[] = []
  let shiftedSubedgeCount = 0
  let aiDrivenCount = 0
  let nonAiDrivenCount = 0
  for (let i = 0; i < refinedEdges.length; i++) {
    const edge = baseEdges[i]!
    for (const sub of refinedEdges[i]!) {
      if (Math.abs(sub.coord - sub.origCoord) >= OPT.minBandShift) {
        shiftedSubedgeCount++
        if (sub.evidenceSource === "ai") aiDrivenCount++
        else if (sub.evidenceSource !== "base") nonAiDrivenCount++
        const bbox = bandBBoxFromSubedge(sub)
        if (bbox) {
          changeBands.push({
            bbox,
            mode: edgeOutwardBandMode(edge, sub.coord, clockwisePage),
          })
        }
      }
    }
  }

  const refinedBoundaryClosed = refinedLoop.length >= 3
  const refinementSupportSummary =
    `Boundary refinement v2: ${baseEdges.length} base edges, ${shiftedSubedgeCount} adjusted subedge(s), ` +
    `${nonAiDrivenCount} evidence-led adjustments, ${aiDrivenCount} AI-led adjustments, ` +
    `area ${baseArea.toFixed(0)} -> ${refinedArea.toFixed(0)} pt².`
  const aiPriorUsageSummary = aiHint?.length
    ? aiDrivenCount > 0
      ? `AI unit outline prior was used softly on ${aiDrivenCount} refined subedge(s); deterministic wall evidence remained authoritative elsewhere.`
      : "AI unit outline prior was available but deterministic wall evidence dominated every refined edge."
    : "No AI unit outline prior was available."
  const boundaryRefinementStatement =
    `Unit outer boundary refinement v2: ${refinedLoop.length} vertices, closed=${refinedBoundaryClosed}, ` +
    `bbox ${(refinedBox.maxX - refinedBox.minX).toFixed(0)}×${(refinedBox.maxY - refinedBox.minY).toFixed(0)}, ` +
    `${changeBands.filter((b) => b.mode === "trimmed").length} trim band(s), ${changeBands.filter((b) => b.mode === "added").length} add band(s).`

  notes.push(
    `Base bbox ${(baseBox.maxX - baseBox.minX).toFixed(0)}×${(baseBox.maxY - baseBox.minY).toFixed(0)} -> refined ${(refinedBox.maxX - refinedBox.minX).toFixed(0)}×${(refinedBox.maxY - refinedBox.minY).toFixed(0)}.`
  )

  return {
    refinedUnitPolygon: refinedLoop,
    refinedBoundaryClosed,
    refinementSupportSummary,
    aiPriorUsageSummary,
    boundaryRefinementStatement,
    notes,
    previousRecoveredPolygon: baseLoop,
    changeBands,
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

export function buildUnitOuterBoundaryRefinementV2SvgString(
  o: BuildUnitOuterBoundaryRefinementV2SvgOptions
): string {
  const pb = o.pageBounds
  const w = pb.maxX - pb.minX
  const h = pb.maxY - pb.minY

  const baseShell =
    o.refinement.previousRecoveredPolygon.length >= 3
      ? `<path d="${escapeXml(pathFromPoly(o.refinement.previousRecoveredPolygon, true))}" fill="rgba(180,50,50,0.04)" stroke="rgba(180,50,50,0.45)" stroke-width="1.5" stroke-dasharray="6 4"/>`
      : ""
  const refinedShell =
    o.refinement.refinedUnitPolygon.length >= 3
      ? `<path d="${escapeXml(pathFromPoly(o.refinement.refinedUnitPolygon, o.refinement.refinedBoundaryClosed))}" fill="rgba(30,160,80,0.08)" stroke="rgba(20,120,50,0.96)" stroke-width="2.4"/>`
      : ""

  const segLines = o.primaryLayoutSegments
    .map((s) => segmentSvg(s, "rgba(110,110,110,0.35)", 0.8))
    .join("")
  const hypLines = o.wallHypothesesPlanOnly.hypotheses
    .filter((h) => h.exteriorLikelihood >= 0.38 && (h.orientation === "horizontal" || h.orientation === "vertical"))
    .map((h) => segmentSvg(h.centerline, "rgba(30,90,220,0.45)", 1.2))
    .join("")
  const spanLines = o.globalSpansPlanOnly.spans
    .filter((s) => s.shellHintScore >= 0.42 && (s.orientation === "horizontal" || s.orientation === "vertical"))
    .map((s) => segmentSvg(s.centerline, "rgba(255,140,0,0.45)", 1.1, "6 3"))
    .join("")
  const aiOverlay =
    o.aiUnitOutlineHint && o.aiUnitOutlineHint.length >= 3
      ? `<path d="${escapeXml(pathFromPoly(o.aiUnitOutlineHint, true))}" fill="none" stroke="rgba(140,70,220,0.78)" stroke-width="1.5" stroke-dasharray="7 5"/>`
      : ""
  const changeBands = o.refinement.changeBands
    .map((band) => {
      const fill = band.mode === "added" ? "rgba(59,130,246,0.16)" : "rgba(245,158,11,0.18)"
      const stroke = band.mode === "added" ? "rgba(37,99,235,0.55)" : "rgba(217,119,6,0.6)"
      return `<rect x="${band.bbox.minX.toFixed(1)}" y="${band.bbox.minY.toFixed(1)}" width="${(band.bbox.maxX - band.bbox.minX).toFixed(1)}" height="${(band.bbox.maxY - band.bbox.minY).toFixed(1)}" fill="${fill}" stroke="${stroke}" stroke-width="0.8" stroke-dasharray="4 3"/>`
    })
    .join("")

  const title = `${o.refinement.boundaryRefinementStatement}`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${pb.minX} ${pb.minY} ${w} ${h}" width="${Math.round(w)}" height="${Math.round(h)}">
<rect x="${pb.minX}" y="${pb.minY}" width="${w}" height="${h}" fill="white"/>
<text x="${pb.minX + 8}" y="${pb.minY + 14}" font-size="11" fill="#222" font-family="system-ui,sans-serif">${escapeXml(title)}</text>
<text x="${pb.minX + 8}" y="${pb.minY + 28}" font-size="7.5" fill="#444" font-family="system-ui,sans-serif">Green = refined shell; faint red dashed = recovered v1 shell; gray = primary layout segments; blue = exterior wall hypotheses; orange dashed = shell spans; purple dashed = AI shell hint; blue/orange bands = added/trimmed regions.</text>
<g>${segLines}</g>
<g>${hypLines}</g>
<g>${spanLines}</g>
<g>${changeBands}</g>
<g>${baseShell}</g>
<g>${aiOverlay}</g>
<g>${refinedShell}</g>
</svg>`
}
