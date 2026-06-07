/**
 * Debug-only **plan-only shell evidence strengthening / confidence gating**:
 * classifies each regularized shell edge by measured evidence vs heuristic, aggregates runs and perimeter
 * fractions, and emits a conservative extrusion gating verdict. Does not extrude; production unchanged.
 */

import type { ArchitecturalWallHypothesesDebugPayload } from "@/lib/geometryFirst/architecturalWallHypotheses"
import type { GlobalStructuralSpansDebugPayload } from "@/lib/geometryFirst/globalStructuralSpans"
import type { LocalizedSideGapV3, PlanBodyBoundaryRecoveryV3Debug } from "@/lib/geometryFirst/planBodyBoundaryRecoveryV3"
import type { RegularizedEdgeDebug } from "@/lib/geometryFirst/planBodyShellRegularization"
import type { ExtractedLineSegment, PlanBoundingBox } from "@/lib/geometryFirst/types"

export type ShellEdgeConfidenceClass =
  | "strongly_supported"
  | "moderately_supported"
  | "weak_but_usable"
  | "synthetic_low_confidence"

export type ShellEdgeRunKind = "trusted" | "ambiguous" | "synthetic"

export type ExtrusionGatingVerdict =
  | "not_usable_for_extrusion"
  | "usable_only_with_manual_review"
  | "usable_debug_only_extrusion_with_low_confidence_overlays"
  | "strong_enough_for_later_automated_extrusion"

export interface ShellEdgeEvidenceRow {
  edgeIndex: number
  x1: number
  y1: number
  x2: number
  y2: number
  lengthPt: number
  nearestShellDistPt: number
  supportCombined: number
  hypothesisScore: number
  spanScore: number
  planSegmentDistPt: number
  planAngleAlignment: number
  inWeakZone: boolean
  confidenceClass: ShellEdgeConfidenceClass
  runKind: ShellEdgeRunKind
}

export interface ShellEdgeRunSummary {
  kind: ShellEdgeRunKind
  startEdgeIndex: number
  endEdgeIndex: number
  edgeCount: number
  lengthPt: number
}

/** Alias for docs / consumers who prefer “strengthening” wording. */
export type ShellEvidenceStrengtheningDebug = PlanBodyShellEvidenceGatingDebug

export interface PlanBodyShellEvidenceGatingDebug {
  edgeRows: ShellEdgeEvidenceRow[]
  runs: ShellEdgeRunSummary[]
  supportedPerimeterFraction: number
  syntheticPerimeterFraction: number
  ambiguousPerimeterFraction: number
  trustedRunCount: number
  largestTrustedRunPt: number
  largestSyntheticRunPt: number
  rightSideTrustedFraction: number
  bottomSideTrustedFraction: number
  extrusionGatingVerdict: ExtrusionGatingVerdict
  extrusionGatingStatement: string
  notes: string[]
}

const GATE = {
  strongShellDist: 7.2,
  strongSupport: 0.62,
  strongPlanDist: 9,
  modShellDist: 12,
  modSupport: 0.44,
  synShellDist: 14,
  synHyp: 0.12,
  synSpan: 0.12,
  synSupport: 0.4,
  weakZoneMargin: 11,
  sideBandFrac: 0.08,
  sideBandMinPt: 40,
  angleTolDeg: 16,
} as const

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x))
}

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
  t = clamp(t, 0, 1)
  const qx = x1 + t * dx
  const qy = y1 + t * dy
  return Math.hypot(px - qx, py - qy)
}

function nearestShellDist(mx: number, my: number, shellSegs: ExtractedLineSegment[]): number {
  let d = Infinity
  for (const s of shellSegs) {
    d = Math.min(d, distPointToSegment(mx, my, s.x1, s.y1, s.x2, s.y2))
  }
  return d
}

function hypSpanScores(
  mx: number,
  my: number,
  hyps: ArchitecturalWallHypothesesDebugPayload,
  spans: GlobalStructuralSpansDebugPayload
): { hyp: number; sp: number } {
  let hyp = 0
  let sp = 0
  for (const h of hyps.hypotheses) {
    if (h.exteriorLikelihood < 0.26) continue
    const c = h.centerline
    const d = distPointToSegment(mx, my, c.x1, c.y1, c.x2, c.y2)
    hyp = Math.max(hyp, h.exteriorLikelihood * Math.exp(-d / 10))
  }
  for (const s of spans.spans) {
    if (s.shellHintScore < 0.2) continue
    const c = s.centerline
    const d = distPointToSegment(mx, my, c.x1, c.y1, c.x2, c.y2)
    sp = Math.max(sp, s.shellHintScore * Math.exp(-d / 12))
  }
  return { hyp, sp }
}

function supportCombined(ds: number, hyp: number, sp: number): number {
  const shell = Math.exp(-ds / 8)
  return clamp(0.5 * shell + 0.28 * hyp + 0.22 * sp, 0, 1)
}

function minDistToPlanSamples(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  planSegs: ExtractedLineSegment[]
): number {
  let best = Infinity
  const samples = 3
  for (let k = 0; k < samples; k++) {
    const t = k / Math.max(1, samples - 1)
    const px = ax + t * (bx - ax)
    const py = ay + t * (by - ay)
    for (const s of planSegs) {
      best = Math.min(best, distPointToSegment(px, py, s.x1, s.y1, s.x2, s.y2))
    }
  }
  return best
}

function edgeDirection(ax: number, ay: number, bx: number, by: number): { ux: number; uy: number; len: number } {
  const dx = bx - ax
  const dy = by - ay
  const len = Math.hypot(dx, dy)
  if (len < 1e-9) return { ux: 1, uy: 0, len: 0 }
  return { ux: dx / len, uy: dy / len, len }
}

function angleAlignmentToSegment(
  ux: number,
  uy: number,
  s: ExtractedLineSegment
): number {
  const dx = s.x2 - s.x1
  const dy = s.y2 - s.y1
  const L = Math.hypot(dx, dy)
  if (L < 1e-9) return 0
  const vx = dx / L
  const vy = dy / L
  const dot = Math.abs(ux * vx + uy * vy)
  return clamp(dot, 0, 1)
}

function planAngleAlignmentScore(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  planSegs: ExtractedLineSegment[],
  maxProbeDist: number
): number {
  const { ux, uy, len } = edgeDirection(ax, ay, bx, by)
  if (len < 1e-6) return 0
  const mx = (ax + bx) / 2
  const my = (ay + by) / 2
  let best = 0
  for (const s of planSegs) {
    const d = distPointToSegment(mx, my, s.x1, s.y1, s.x2, s.y2)
    if (d > maxProbeDist) continue
    const al = angleAlignmentToSegment(ux, uy, s)
    const w = Math.exp(-d / 14)
    best = Math.max(best, al * w)
  }
  return best
}

function midpointInExpandedBox(mx: number, my: number, b: PlanBoundingBox, margin: number): boolean {
  return mx >= b.minX - margin && mx <= b.maxX + margin && my >= b.minY - margin && my <= b.maxY + margin
}

function edgeInWeakZone(ax: number, ay: number, bx: number, by: number, zones: LocalizedSideGapV3[]): boolean {
  const mx = (ax + bx) / 2
  const my = (ay + by) / 2
  return zones.some((z: LocalizedSideGapV3) => midpointInExpandedBox(mx, my, z.band, GATE.weakZoneMargin))
}

function classifyEdge(
  ds: number,
  sup: number,
  hyp: number,
  sp: number,
  planDist: number,
  planAlign: number,
  inWeak: boolean,
  ann?: RegularizedEdgeDebug
): ShellEdgeConfidenceClass {
  const synAnn = ann?.syntheticLowConfidence === true
  const ambAnn = ann?.ambiguousFromGapZone === true

  if (
    ds > GATE.synShellDist &&
    hyp < GATE.synHyp &&
    sp < GATE.synSpan &&
    sup < GATE.synSupport + (inWeak ? 0.08 : 0)
  ) {
    return "synthetic_low_confidence"
  }
  if (synAnn && ds > 9 && sup < 0.48) return "synthetic_low_confidence"

  if (inWeak && (ds > 11 || sup < 0.48) && planDist > 14) {
    return "weak_but_usable"
  }

  if (
    ds <= GATE.strongShellDist &&
    sup >= GATE.strongSupport &&
    planDist <= GATE.strongPlanDist + 4 &&
    (planAlign >= 0.72 || planDist <= 6)
  ) {
    return ambAnn && sup < 0.55 ? "moderately_supported" : "strongly_supported"
  }

  if (ds <= GATE.modShellDist && sup >= GATE.modSupport) {
    if (inWeak && sup < 0.52) return "weak_but_usable"
    return "moderately_supported"
  }

  if (sup >= 0.36 && (planDist <= 22 || planAlign >= 0.45)) {
    return inWeak || ambAnn ? "weak_but_usable" : "moderately_supported"
  }

  if (ambAnn || inWeak) return "weak_but_usable"

  return "weak_but_usable"
}

function runKindForClass(c: ShellEdgeConfidenceClass, inWeak: boolean, sup: number): ShellEdgeRunKind {
  if (c === "synthetic_low_confidence") return "synthetic"
  if (c === "weak_but_usable") return "ambiguous"
  if (c === "moderately_supported") return inWeak && sup < 0.5 ? "ambiguous" : "trusted"
  if (c === "strongly_supported") return inWeak && sup < 0.58 ? "ambiguous" : "trusted"
  return "ambiguous"
}

function sideBandDepth(bbox: PlanBoundingBox): number {
  const w = bbox.maxX - bbox.minX
  const h = bbox.maxY - bbox.minY
  return Math.max(GATE.sideBandMinPt, GATE.sideBandFrac * Math.min(w, h))
}

function midpointNearRightSide(mx: number, my: number, bbox: PlanBoundingBox): boolean {
  const d = sideBandDepth(bbox)
  return mx >= bbox.maxX - d
}

function midpointNearBottom(mx: number, my: number, bbox: PlanBoundingBox): boolean {
  const d = sideBandDepth(bbox)
  return my <= bbox.minY + d
}

function computeVerdict(
  trustedFrac: number,
  syntheticFrac: number,
  ambiguousFrac: number,
  rightTrusted: number,
  bottomTrusted: number,
  totalPerim: number
): { verdict: ExtrusionGatingVerdict; statement: string } {
  if (totalPerim < 1e-3) {
    return {
      verdict: "not_usable_for_extrusion",
      statement: "No measurable perimeter — **not usable** for extrusion.",
    }
  }

  let verdict: ExtrusionGatingVerdict = "not_usable_for_extrusion"
  let statement =
    "Evidence gating: **not usable for extrusion** — too much heuristic or unsupported perimeter remains."

  if (syntheticFrac > 0.38 || trustedFrac < 0.28) {
    verdict = "not_usable_for_extrusion"
    statement =
      "Gating verdict: **not usable for extrusion** — synthetic or weak evidence dominates the shell perimeter (conservative threshold)."
  } else if (syntheticFrac > 0.22 || trustedFrac < 0.48) {
    verdict = "usable_only_with_manual_review"
    statement =
      "Gating verdict: **usable only with manual review** — a substantial share of edges lack strong wall evidence; do not automate extrusion."
  } else if (syntheticFrac > 0.12 || trustedFrac < 0.58 || rightTrusted < 0.35 || bottomTrusted < 0.35) {
    verdict = "usable_debug_only_extrusion_with_low_confidence_overlays"
    statement =
      "Gating verdict: **debug-only extrusion** is plausible **only** with explicit low-confidence / ambiguous overlays; not production geometry."
  } else if (
    syntheticFrac <= 0.1 &&
    trustedFrac >= 0.68 &&
    ambiguousFrac <= 0.28 &&
    rightTrusted >= 0.45 &&
    bottomTrusted >= 0.45
  ) {
    verdict = "strong_enough_for_later_automated_extrusion"
    statement =
      "Gating verdict: perimeter is **predominantly trusted** under conservative rules — candidate for **later automated extrusion** after independent QA (still not a final architectural shell)."
  } else {
    verdict = "usable_debug_only_extrusion_with_low_confidence_overlays"
    statement =
      "Gating verdict: mixed trusted vs ambiguous bands — treat as **debug-only extrusion** with overlays unless QA raises trust further."
  }

  return { verdict, statement }
}

function shellSegmentsFromCleaned(full: ExtractedLineSegment[], shellSet: Set<number>): ExtractedLineSegment[] {
  const out: ExtractedLineSegment[] = []
  for (let i = 0; i < full.length; i++) {
    if (shellSet.has(i)) out.push(full[i]!)
  }
  return out
}

function planSegmentsForLayout(
  primaryLayoutSegments: ExtractedLineSegment[],
  primaryLayoutCleanedIndices: readonly number[]
): ExtractedLineSegment[] {
  const out: ExtractedLineSegment[] = []
  for (let li = 0; li < primaryLayoutSegments.length; li++) {
    if (primaryLayoutCleanedIndices[li] != null) out.push(primaryLayoutSegments[li]!)
  }
  return out
}

export function buildPlanBodyShellEvidenceGating(
  primaryLayoutBBox: PlanBoundingBox,
  primaryLayoutSegments: ExtractedLineSegment[],
  primaryLayoutCleanedIndices: readonly number[],
  shellCandidateCleanedIndices: readonly number[],
  fullCleanedSegments: ExtractedLineSegment[],
  wallHypothesesPlanOnly: ArchitecturalWallHypothesesDebugPayload,
  globalSpansPlanOnly: GlobalStructuralSpansDebugPayload,
  boundaryRecoveryV3: PlanBodyBoundaryRecoveryV3Debug,
  regularizedPolygonPt: Array<{ x: number; y: number }>,
  regularizedBoundaryClosed: boolean,
  edgeAnnotations: RegularizedEdgeDebug[],
  /** From v3 `remainingGapZones` (right/bottom weak bands). */
  remainingGapZones: LocalizedSideGapV3[]
): PlanBodyShellEvidenceGatingDebug {
  const notes: string[] = []
  const shellSet = new Set(shellCandidateCleanedIndices)
  const shellSegs = shellSegmentsFromCleaned(fullCleanedSegments, shellSet)
  const planSegs = planSegmentsForLayout(primaryLayoutSegments, primaryLayoutCleanedIndices)

  const closed = regularizedBoundaryClosed && regularizedPolygonPt.length >= 3
  const n = regularizedPolygonPt.length
  const m = closed ? n : Math.max(0, n - 1)

  if (m < 1) {
    notes.push("Evidence gating skipped — no regularized edges.")
    return {
      edgeRows: [],
      runs: [],
      supportedPerimeterFraction: 0,
      syntheticPerimeterFraction: 0,
      ambiguousPerimeterFraction: 0,
      trustedRunCount: 0,
      largestTrustedRunPt: 0,
      largestSyntheticRunPt: 0,
      rightSideTrustedFraction: 0,
      bottomSideTrustedFraction: 0,
      extrusionGatingVerdict: "not_usable_for_extrusion",
      extrusionGatingStatement: "No regularized polygon — not usable for extrusion.",
      notes,
    }
  }

  const annByIdx = new Map<number, RegularizedEdgeDebug>()
  for (const a of edgeAnnotations) annByIdx.set(a.edgeIndex, a)

  const edgeRows: ShellEdgeEvidenceRow[] = []
  let totalPerim = 0
  let trustedLen = 0
  let syntheticLen = 0
  let ambiguousLen = 0
  let rightTotal = 0
  let rightTrusted = 0
  let bottomTotal = 0
  let bottomTrusted = 0

  for (let i = 0; i < m; i++) {
    const a = regularizedPolygonPt[i]!
    const b = closed ? regularizedPolygonPt[(i + 1) % n]! : regularizedPolygonPt[i + 1]!
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    totalPerim += len
    const mx = (a.x + b.x) / 2
    const my = (a.y + b.y) / 2
    const ds = nearestShellDist(mx, my, shellSegs)
    const { hyp, sp } = hypSpanScores(mx, my, wallHypothesesPlanOnly, globalSpansPlanOnly)
    const sup = supportCombined(ds, hyp, sp)
    const planDist = minDistToPlanSamples(a.x, a.y, b.x, b.y, planSegs)
    const planAlign = planAngleAlignmentScore(a.x, a.y, b.x, b.y, planSegs, 38)
    const inWeak = edgeInWeakZone(a.x, a.y, b.x, b.y, remainingGapZones)
    const ann = annByIdx.get(i)
    const conf = classifyEdge(ds, sup, hyp, sp, planDist, planAlign, inWeak, ann)
    const rk = runKindForClass(conf, inWeak, sup)

    edgeRows.push({
      edgeIndex: i,
      x1: a.x,
      y1: a.y,
      x2: b.x,
      y2: b.y,
      lengthPt: len,
      nearestShellDistPt: ds,
      supportCombined: sup,
      hypothesisScore: hyp,
      spanScore: sp,
      planSegmentDistPt: planDist,
      planAngleAlignment: planAlign,
      inWeakZone: inWeak,
      confidenceClass: conf,
      runKind: rk,
    })

    if (rk === "trusted") trustedLen += len
    else if (rk === "synthetic") syntheticLen += len
    else ambiguousLen += len

    if (midpointNearRightSide(mx, my, primaryLayoutBBox)) {
      rightTotal += len
      if (rk === "trusted") rightTrusted += len
    }
    if (midpointNearBottom(mx, my, primaryLayoutBBox)) {
      bottomTotal += len
      if (rk === "trusted") bottomTrusted += len
    }
  }

  const supportedPerimeterFraction = totalPerim > 0 ? trustedLen / totalPerim : 0
  const syntheticPerimeterFraction = totalPerim > 0 ? syntheticLen / totalPerim : 0
  const ambiguousPerimeterFraction = totalPerim > 0 ? ambiguousLen / totalPerim : 0

  const runs: ShellEdgeRunSummary[] = []
  if (edgeRows.length > 0) {
    let k0 = 0
    for (let k = 1; k <= edgeRows.length; k++) {
      if (k === edgeRows.length || edgeRows[k]!.runKind !== edgeRows[k0]!.runKind) {
        let runLen = 0
        for (let j = k0; j < k; j++) runLen += edgeRows[j]!.lengthPt
        runs.push({
          kind: edgeRows[k0]!.runKind,
          startEdgeIndex: edgeRows[k0]!.edgeIndex,
          endEdgeIndex: edgeRows[k - 1]!.edgeIndex,
          edgeCount: k - k0,
          lengthPt: runLen,
        })
        k0 = k
      }
    }
  }

  const trustedRuns = runs.filter((r) => r.kind === "trusted")
  const syntheticRuns = runs.filter((r) => r.kind === "synthetic")
  const trustedRunCount = trustedRuns.length
  const largestTrustedRunPt = trustedRuns.length ? Math.max(...trustedRuns.map((r) => r.lengthPt)) : 0
  const largestSyntheticRunPt = syntheticRuns.length ? Math.max(...syntheticRuns.map((r) => r.lengthPt)) : 0

  const rightSideTrustedFraction = rightTotal > 1e-6 ? rightTrusted / rightTotal : 0
  const bottomSideTrustedFraction = bottomTotal > 1e-6 ? bottomTrusted / bottomTotal : 0

  const { verdict, statement } = computeVerdict(
    supportedPerimeterFraction,
    syntheticPerimeterFraction,
    ambiguousPerimeterFraction,
    rightSideTrustedFraction,
    bottomSideTrustedFraction,
    totalPerim
  )

  notes.push(
    `Boundary recovery v3 basis (context): ${boundaryRecoveryV3.boundaryIsHintVsRegularizationBasis}; remaining gap zones=${remainingGapZones.length}.`
  )
  notes.push(
    `Perimeter fractions — trusted: ${(supportedPerimeterFraction * 100).toFixed(1)}%, ambiguous: ${(ambiguousPerimeterFraction * 100).toFixed(1)}%, synthetic: ${(syntheticPerimeterFraction * 100).toFixed(1)}%.`
  )
  notes.push(
    `Side bands — right trusted: ${(rightSideTrustedFraction * 100).toFixed(1)}%, bottom trusted: ${(bottomSideTrustedFraction * 100).toFixed(1)}%.`
  )
  notes.push(statement)

  return {
    edgeRows,
    runs,
    supportedPerimeterFraction,
    syntheticPerimeterFraction,
    ambiguousPerimeterFraction,
    trustedRunCount,
    largestTrustedRunPt,
    largestSyntheticRunPt,
    rightSideTrustedFraction,
    bottomSideTrustedFraction,
    extrusionGatingVerdict: verdict,
    extrusionGatingStatement: statement,
    notes,
  }
}

export interface BuildPlanBodyShellEvidenceGatingSvgOptions {
  pageBounds: PlanBoundingBox
  primaryLayoutBBox: PlanBoundingBox
  evidence: PlanBodyShellEvidenceGatingDebug
  remainingGapZones: LocalizedSideGapV3[]
  /** When true, faint closed path underlay matches the regularized ring. */
  regularizedBoundaryClosed: boolean
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;")
}

function strokeForRunKind(k: ShellEdgeRunKind): { stroke: string; width: number } {
  switch (k) {
    case "trusted":
      return { stroke: "rgba(20,140,55,0.92)", width: 2.85 }
    case "ambiguous":
      return { stroke: "rgba(220,150,30,0.9)", width: 2.35 }
    case "synthetic":
      return { stroke: "rgba(140,40,180,0.92)", width: 2.5 }
    default:
      return { stroke: "#888", width: 2 }
  }
}

export function buildPlanBodyShellEvidenceGatingSvgString(o: BuildPlanBodyShellEvidenceGatingSvgOptions): string {
  const pb = o.pageBounds
  const w = pb.maxX - pb.minX
  const h = pb.maxY - pb.minY
  const bx = o.primaryLayoutBBox
  const ev = o.evidence

  const weakZones = o.remainingGapZones
    .map(
      (z: LocalizedSideGapV3) =>
        `<rect x="${z.band.minX}" y="${z.band.minY}" width="${z.band.maxX - z.band.minX}" height="${z.band.maxY - z.band.minY}" fill="rgba(255,80,80,0.06)" stroke="rgba(200,50,50,0.45)" stroke-width="0.9" stroke-dasharray="4 3"/>`
    )
    .join("\n")

  const edges = ev.edgeRows
    .map((e) => {
      const { stroke, width } = strokeForRunKind(e.runKind)
      return `<line x1="${e.x1}" y1="${e.y1}" x2="${e.x2}" y2="${e.y2}" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round"/>`
    })
    .join("\n")

  let outline = ""
  if (ev.edgeRows.length > 0) {
    const rows = ev.edgeRows
    let d = `M ${rows[0]!.x1.toFixed(2)} ${rows[0]!.y1.toFixed(2)}`
    for (const e of rows) d += ` L ${e.x2.toFixed(2)} ${e.y2.toFixed(2)}`
    if (o.regularizedBoundaryClosed) d += " Z"
    outline = `<path d="${escapeXml(d)}" fill="none" stroke="rgba(40,40,50,0.18)" stroke-width="0.85"/>`
  }

  const title = `Shell evidence gating — trusted ${(ev.supportedPerimeterFraction * 100).toFixed(0)}% | synthetic ${(ev.syntheticPerimeterFraction * 100).toFixed(0)}% | verdict=${ev.extrusionGatingVerdict}`

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${pb.minX} ${pb.minY} ${w} ${h}" width="${Math.round(w)}" height="${Math.round(
    h
  )}">
<rect x="${pb.minX}" y="${pb.minY}" width="${w}" height="${h}" fill="white"/>
<text x="${pb.minX + 8}" y="${pb.minY + 14}" font-size="11" fill="#222" font-family="system-ui,sans-serif">${escapeXml(title)}</text>
<text x="${pb.minX + 8}" y="${pb.minY + 28}" font-size="8.5" fill="#333" font-family="system-ui,sans-serif">${escapeXml(
    ev.extrusionGatingStatement.slice(0, 220) + (ev.extrusionGatingStatement.length > 220 ? "…" : "")
  )}</text>
<text x="${pb.minX + 8}" y="${pb.minY + 42}" font-size="7.5" fill="#555" font-family="system-ui,sans-serif">Green=trusted runs, orange=ambiguous, purple=synthetic; red dashed=R/B weak zones.</text>
<g>${weakZones}</g>
<g>${outline}</g>
<g>${edges}</g>
<rect x="${bx.minX}" y="${bx.minY}" width="${bx.maxX - bx.minX}" height="${bx.maxY - bx.minY}" fill="none" stroke="rgba(0,70,35,0.5)" stroke-width="1.3" stroke-dasharray="6 5"/>
</svg>`
}
