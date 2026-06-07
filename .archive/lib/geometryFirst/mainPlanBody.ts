/**
 * Debug / experimental: isolate the main apartment plan body on mixed brochure PDFs
 * (diminishes side towers, marketing copy, logos — does not run in production layout).
 */

import type { ArchitecturalWallHypothesesDebugPayload } from "@/lib/geometryFirst/architecturalWallHypotheses"
import { buildArchitecturalWallHypotheses } from "@/lib/geometryFirst/architecturalWallHypotheses"
import type { GlobalStructuralSpansDebugPayload, GlobalStructuralSpan } from "@/lib/geometryFirst/globalStructuralSpans"
import { buildGlobalStructuralSpans } from "@/lib/geometryFirst/globalStructuralSpans"
import type { ExtractedLineSegment, ExtractedTextRun, PlanBoundingBox } from "@/lib/geometryFirst/types"
import { segmentLengthPdfUnits } from "@/lib/geometryFirst/linePrimitiveDenoise"

// --- Options ----------------------------------------------------------------

export interface MainPlanBodyOptions {
  /** Grid columns over pageBounds. */
  gridCols?: number
  /** Grid rows over pageBounds. */
  gridRows?: number
  /** Weight: segment midpoint hit per cell (capped per cell). */
  segmentCellWeight?: number
  /** Max segment votes per cell (limits clutter spikes). */
  maxSegmentVotesPerCell?: number
  /** Hypothesis vote = supportScore * length × this factor (distributed along centerline). */
  hypothesisWeightScale?: number
  /** Span vote = spanLength × shellHintScore × this factor. */
  spanWeightScale?: number
  /** Inflate hypothesis centerline normal half-width (PDF pt). */
  hypothesisInflatePt?: number
  /** Pad added around selected cell union → `primaryLayoutBBox`. */
  outputPadPt?: number
  /** Fraction of peak cell score used as threshold for foreground cells. */
  scoreThresholdRatio?: number
  /**
   * Hysteresis: grow components from seeds ≥ peak×ratio into neighbors ≥ peak×ratio×this.
   * (< 1) bridges sparse grids so the apartment body does not fragment into 1-cell islands.
   */
  scoreThresholdLowFraction?: number
  /**
   * Also caps `thrLow` with `peak * this` (see hysteresis). On some sheets this is a sharp threshold:
   * slightly lower values bridge sparse interior strokes (taller bbox, more hypotheses/spans).
   */
  scoreThresholdLowAbsPeakFraction?: number
  /** Use 8-neighborhood when flooding hysteresis regions (better diagonal bridging). */
  hysteresis8Connected?: boolean
  /**
   * Outside the inflated union of wall-hypothesis centerlines, scale `net` by this factor
   * before hysteresis (keeps brochure sidebars from forming the only large 8-connected blob).
   */
  outsideHypothesisHullNetScale?: number
  /** Padding (pt) around hypothesis AABB before hull mask. */
  hypothesisHullPadPt?: number
  /** Base penalty applied to cells overlapping brochure-like text. */
  textPenaltyBrochure?: number
  /** Extra penalty for title-like blobs. */
  textPenaltyTitle?: number
  /** Corner margin (pt) for logo-ish corner text heuristic. */
  cornerMarginPt?: number
  /** Bbox area below this gets a soft shrink on component merit (apartment footprint prior). */
  minPlausibleAreaPt2?: number
  /** Minimum width (pt) of component AABB; narrower regions are down-weights unless compensated. */
  minPlausibleWidthPt?: number
  /** aspect = max(w/h,h/w); above this, exponential shrink (penalize strips). */
  maxPlausibleAspectRatio?: number
  stripAspectPenaltyLambda?: number
  /** Area ratio exponent when below minPlausibleAreaPt2. */
  softAreaGamma?: number
  /** If relative width below this AND strip-like aspect AND hugging page edge → heavy merit cut. */
  marginalStripMaxWidthFraction?: number
  /** Left/right band (fraction of page width) where a narrow strip is “marginal”. */
  marginalEdgeBandFraction?: number
  stripLikeMinAspect?: number
  /** Multiplier applied to merit for marginal narrow strips (<< 1). */
  marginalStripMeritFactor?: number
  /**
   * Brochure columns: if the **entire** component bbox sits in the left/right `depthFrac` of the page
   * and is narrower than `narrowWidthFrac` of page width, crush merit (sidebar text / key maps).
   */
  sideColumnDepthFrac?: number
  sideColumnNarrowWidthFrac?: number
  sideColumnMeritFactor?: number
  /** Gaussian horizontal center prior amplitude ([0,1]). */
  horizontalCenterPrior?: number
  /** Per cell: boost where room-program text overlaps. */
  roomLabelCellBoost?: number
  /** Per cell: weaker boost for dimension-like strings. */
  dimensionLikeCellBoost?: number
  /** Inflate text box when painting room/dimension boosts onto the grid. */
  roomProgramTextInflatePt?: number
  /** When text matches room/dimension heuristics, scale brochure penalty by this (< 1). */
  brochurePenaltyWhenRoomOrDimPresent?: number
  /**
   * When ranking viable (non–side-column) components, multiply adjusted merit by `massShare ** this`,
   * where massShare is the component’s Σ net / Σ net over the viable pool — down-weights tiny interior speckles.
   */
  componentMassShareGamma?: number
}

const OPT_DEFAULTS: Required<MainPlanBodyOptions> = {
  gridCols: 36,
  gridRows: 28,
  segmentCellWeight: 1,
  maxSegmentVotesPerCell: 6,
  hypothesisWeightScale: 2.2,
  spanWeightScale: 1.4,
  hypothesisInflatePt: 7,
  outputPadPt: 20,
  scoreThresholdRatio: 0.125,
  scoreThresholdLowFraction: 0.22,
  scoreThresholdLowAbsPeakFraction: 0.01635,
  hysteresis8Connected: true,
  outsideHypothesisHullNetScale: 0.062,
  hypothesisHullPadPt: 84,
  textPenaltyBrochure: 7,
  textPenaltyTitle: 4,
  cornerMarginPt: 64,
  minPlausibleAreaPt2: 42_000,
  minPlausibleWidthPt: 175,
  maxPlausibleAspectRatio: 2.65,
  stripAspectPenaltyLambda: 0.62,
  softAreaGamma: 1.45,
  marginalStripMaxWidthFraction: 0.27,
  marginalEdgeBandFraction: 0.22,
  stripLikeMinAspect: 1.92,
  marginalStripMeritFactor: 0.1,
  sideColumnDepthFrac: 0.3,
  sideColumnNarrowWidthFrac: 0.34,
  sideColumnMeritFactor: 0.018,
  horizontalCenterPrior: 0.42,
  roomLabelCellBoost: 4.2,
  dimensionLikeCellBoost: 1.65,
  roomProgramTextInflatePt: 32,
  brochurePenaltyWhenRoomOrDimPresent: 0.28,
  componentMassShareGamma: 0.52,
}

// --- Output types -----------------------------------------------------------

export interface MainPlanBodySummary {
  cleanedInputCount: number
  primaryLayoutSegmentCount: number
  excludedNonLayoutCount: number
  primaryLayoutTextCount: number
  excludedTextCount: number
  gridForegroundCells: number
  peakCellScore: number
  meanScoreInLayoutCells: number
  totalHypothesisMass: number
  totalSpanMass: number
  textPenaltyCells: number
}

export interface MainPlanBodyDebugPayload {
  primaryLayoutBBox: PlanBoundingBox
  confidence: number
  summary: MainPlanBodySummary
  /** Human-readable scoring narrative. */
  reasons: string[]
  /** Local indices into `cleanedSegments` input (same order as `primaryLayoutSegments`). */
  primaryLayoutCleanedIndices: number[]
}

export interface MainPlanBodyResult {
  primaryLayoutBBox: PlanBoundingBox
  primaryLayoutSegments: ExtractedLineSegment[]
  excludedNonLayoutSegments: ExtractedLineSegment[]
  primaryLayoutTextBoxes: ExtractedTextRun[]
  /** Texts whose bbox center lies outside `primaryLayoutBBox` (still on page). */
  excludedNonLayoutTexts: ExtractedTextRun[]
  confidence: number
  summary: MainPlanBodySummary
  reasons: string[]
  debugPayload: MainPlanBodyDebugPayload
}

export interface MainPlanBodyDownstreamCompare {
  wallHypothesesPlanOnly: ArchitecturalWallHypothesesDebugPayload
  globalSpansPlanOnly: GlobalStructuralSpansDebugPayload
  structuralSegmentsUsedCount: number
  notes: string[]
}

// --- Heuristics -------------------------------------------------------------

const BROCHURE_RE =
  /disclaimer|rendering|illustration|artist\s+impression|concept\s+only|approximate|not\s+to\s+scale|elevation|perspective|brochure|website|www\.|©|all\s+rights|for\s+sale|marketing|prices?\s+and|subject\s+to\s+change|floor\s*plans?\s*(shown|are)|developer|presented\s+for|informational\s+purposes/i

/** Room / program labels — positive signal for real plan interior (not brochure chrome). */
const ROOM_PROGRAM_RE =
  /\b(living|dining|family|great\s+room|bedroom|bed\b|bath(?:room)?s?|kitchen|kit\b|foyer|entry|mud|pantry|office|library|closet|laundry|balcony|terrace|den|nook|primary|master|guest|walk[\s-]*in|\bwic\b|secondary|flex(?:\s+space)?|powder|hall(?:way)?|suite|study|rec(?:\s+room)?|breakfast|powder\s+room|w\.?\s*d\.?|l\.?\s*v\.?|d\.?\s*r\.?)\b/i

/** In-unit dimensions and area callouts commonly beside walls. */
const DIMENSION_LIKE_RE =
  /\d{1,2}\s*['′'`']\s*\d{0,2}\s*["″″]?|\b\d+\s*[x×]\s*\d+\b|\d+\s*[-–]\s*\d+(?:\s*['′"])?.?\s*|\b\d{3,5}\s*(?:sq\.?\s*ft\.?|sf)\b|\b\d{1,2}\.\d\s*m\b|\b\d\s*[-–]\s*\d\s*['′]/i

function isRoomOrDimensionText(raw: string): boolean {
  const s = raw.trim()
  return s.length > 0 && (ROOM_PROGRAM_RE.test(s) || DIMENSION_LIKE_RE.test(s))
}

function expandedTextBBox(t: ExtractedTextRun, pad: number): PlanBoundingBox {
  const w = t.width ?? Math.max(6, t.text.length * 4.5)
  const h = t.height ?? 11
  return {
    minX: t.x - pad,
    maxX: t.x + w + pad,
    minY: t.y - h - pad,
    maxY: t.y + pad,
  }
}

function textCenter(t: ExtractedTextRun): { x: number; y: number } {
  const w = t.width ?? Math.max(6, t.text.length * 4.5)
  const h = t.height ?? 11
  return { x: t.x + w / 2, y: t.y - h / 2 }
}

function pointInBox(px: number, py: number, b: PlanBoundingBox): boolean {
  return px >= b.minX && px <= b.maxX && py >= b.minY && py <= b.maxY
}

function segmentMid(s: ExtractedLineSegment): { x: number; y: number } {
  return { x: (s.x1 + s.x2) / 2, y: (s.y1 + s.y2) / 2 }
}

function inflateBox(b: PlanBoundingBox, p: number): PlanBoundingBox {
  return { minX: b.minX - p, minY: b.minY - p, maxX: b.maxX + p, maxY: b.maxY + p }
}

function unionBoxes(a: PlanBoundingBox, b: PlanBoundingBox): PlanBoundingBox {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  }
}

function boxArea(b: PlanBoundingBox): number {
  return Math.max(0, b.maxX - b.minX) * Math.max(0, b.maxY - b.minY)
}

function clipBoxToPage(b: PlanBoundingBox, page: PlanBoundingBox): PlanBoundingBox {
  return {
    minX: Math.max(b.minX, page.minX),
    minY: Math.max(b.minY, page.minY),
    maxX: Math.min(b.maxX, page.maxX),
    maxY: Math.min(b.maxY, page.maxY),
  }
}

/**
 * Classify marketing / legal copy likely outside the plan interior.
 */
function textBrochurePenalty(
  t: ExtractedTextRun,
  pageBounds: PlanBoundingBox,
  O: Required<MainPlanBodyOptions>
): number {
  const raw = t.text.trim()
  if (raw.length === 0) return 0
  let pen = 0
  if (BROCHURE_RE.test(raw)) pen += O.textPenaltyBrochure
  const w = t.width ?? Math.max(6, raw.length * 4.5)
  const h = t.height ?? 11
  const area = w * h
  if (area > 950 && raw.length < 72 && raw.length > 4) pen += O.textPenaltyTitle
  const c = textCenter(t)
  const nearL = c.x - pageBounds.minX < O.cornerMarginPt
  const nearR = pageBounds.maxX - c.x < O.cornerMarginPt
  const nearT = c.y - pageBounds.minY < O.cornerMarginPt
  const nearB = pageBounds.maxY - c.y < O.cornerMarginPt
  const inCorner = (nearL || nearR) && (nearT || nearB)
  if (inCorner && area < 5200 && raw.length < 48) pen += O.textPenaltyBrochure * 0.55
  if (pen > 0 && isRoomOrDimensionText(raw)) {
    pen *= O.brochurePenaltyWhenRoomOrDimPresent
  }
  return pen
}

function applyRoomProgramTextBoostToGrid(
  texts: ExtractedTextRun[],
  pageBounds: PlanBoundingBox,
  nx: number,
  ny: number,
  score: Float64Array,
  O: Required<MainPlanBodyOptions>
): { roomHits: number; dimHits: number } {
  let roomHits = 0
  let dimHits = 0
  for (const t of texts) {
    const raw = t.text.trim()
    if (raw.length === 0) continue
    const room = ROOM_PROGRAM_RE.test(raw)
    const dim = !room && DIMENSION_LIKE_RE.test(raw)
    if (!room && !dim) continue
    const boost = room ? O.roomLabelCellBoost : O.dimensionLikeCellBoost
    if (room) roomHits++
    else dimHits++
    const tb = expandedTextBBox(t, O.roomProgramTextInflatePt)
    for (let ci = 0; ci < nx * ny; ci++) {
      const cb = cellBox(ci, pageBounds, nx, ny)
      if (boxesOverlap(cb, tb)) score[ci] += boost
    }
  }
  return { roomHits, dimHits }
}

function componentUnionBBox(
  comp: readonly number[],
  pageBounds: PlanBoundingBox,
  nx: number,
  ny: number
): PlanBoundingBox {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const idx of comp) {
    const b = cellBox(idx, pageBounds, nx, ny)
    minX = Math.min(minX, b.minX)
    minY = Math.min(minY, b.minY)
    maxX = Math.max(maxX, b.maxX)
    maxY = Math.max(maxY, b.maxY)
  }
  return { minX, minY, maxX, maxY }
}

function countRoomProgramHitsInBox(
  texts: ExtractedTextRun[],
  bbox: PlanBoundingBox,
  inflate: number,
  pageBounds: PlanBoundingBox
): { rooms: number; dims: number } {
  const bb = clipBoxToPage(inflateBox(bbox, inflate), pageBounds)
  let rooms = 0
  let dims = 0
  for (const t of texts) {
    const raw = t.text.trim()
    if (raw.length === 0) continue
    const c = textCenter(t)
    if (!pointInBox(c.x, c.y, bb)) continue
    if (ROOM_PROGRAM_RE.test(raw)) rooms++
    else if (DIMENSION_LIKE_RE.test(raw)) dims++
  }
  return { rooms, dims }
}

/**
 * Rank connected foreground components: base grid merit × geometric plausibility × gentle page position × room text.
 */
function adjustedComponentMerit(
  comp: readonly number[],
  net: Float64Array,
  pageBounds: PlanBoundingBox,
  nx: number,
  ny: number,
  pw: number,
  ph: number,
  texts: ExtractedTextRun[],
  O: Required<MainPlanBodyOptions>
): {
  merit: number
  bbox: PlanBoundingBox
  compW: number
  sumNet: number
  detail: string
  sideColNarrow: boolean
} {
  let compW = 0
  let sumNet = 0
  for (const i of comp) {
    const v = net[i]!
    compW += v
    sumNet += v
  }
  const baseMerit = compW * Math.sqrt(comp.length)
  const bbox = componentUnionBBox(comp, pageBounds, nx, ny)
  const w = Math.max(1e-6, bbox.maxX - bbox.minX)
  const h = Math.max(1e-6, bbox.maxY - bbox.minY)
  const area = w * h
  const aspect = Math.max(w / h, h / w)

  let areaFactor = 1
  if (area < O.minPlausibleAreaPt2) {
    areaFactor = Math.pow(area / O.minPlausibleAreaPt2, O.softAreaGamma)
  }
  let widthFactor = 1
  if (w < O.minPlausibleWidthPt) {
    widthFactor = Math.pow(w / O.minPlausibleWidthPt, 1.22)
  }

  let aspectFactor = 1
  if (aspect > O.maxPlausibleAspectRatio) {
    aspectFactor = Math.exp(-(aspect - O.maxPlausibleAspectRatio) * O.stripAspectPenaltyLambda)
  }

  const relW = w / pw
  const stripLike = aspect >= O.stripLikeMinAspect
  const narrow = relW < O.marginalStripMaxWidthFraction
  const leftEdgeFrac = (bbox.maxX - pageBounds.minX) / Math.max(1e-6, pw)
  const rightEdgeFrac = (pageBounds.maxX - bbox.minX) / Math.max(1e-6, pw)
  const hugLeft = leftEdgeFrac <= O.marginalEdgeBandFraction
  const hugRight = rightEdgeFrac <= O.marginalEdgeBandFraction
  let marginalMult = 1
  if (narrow && stripLike && (hugLeft || hugRight)) {
    marginalMult = O.marginalStripMeritFactor
  }

  const sideDepth = O.sideColumnDepthFrac * pw
  const inLeftSideColumn = bbox.maxX <= pageBounds.minX + sideDepth
  const inRightSideColumn = bbox.minX >= pageBounds.maxX - sideDepth
  const sideColNarrow = relW <= O.sideColumnNarrowWidthFrac && (inLeftSideColumn || inRightSideColumn)
  let sideColTag = ""
  if (sideColNarrow) {
    marginalMult *= O.sideColumnMeritFactor
    sideColTag = ` sideCol×${O.sideColumnMeritFactor.toFixed(3)}`
  }

  const cx = (bbox.minX + bbox.maxX) / 2
  const relCx = (cx - pageBounds.minX) / Math.max(1e-6, pw)
  const centerBoost = 1 + O.horizontalCenterPrior * Math.exp(-Math.pow((relCx - 0.5) / 0.42, 2))

  const { rooms, dims } = countRoomProgramHitsInBox(texts, bbox, O.roomProgramTextInflatePt * 0.55, pageBounds)
  /** Legends in brochure sidebars repeat room tokens — cap program-text lift there. */
  let textBoost = 1 + 0.1 * rooms + 0.042 * dims
  if (sideColNarrow) {
    textBoost = 1 + 0.02 * Math.min(rooms, 4) + 0.014 * Math.min(dims, 8)
  }

  const merit = baseMerit * areaFactor * widthFactor * aspectFactor * marginalMult * centerBoost * textBoost
  const detail = [
    `base≈${baseMerit.toFixed(0)}`,
    `area×${areaFactor.toFixed(2)}`,
    `wid×${widthFactor.toFixed(2)}`,
    `asp×${aspectFactor.toFixed(2)}`,
    `edge×${marginalMult.toFixed(2)}`,
    `ctr×${centerBoost.toFixed(2)}`,
    `progTxt×${textBoost.toFixed(2)}`,
    sideColTag.trimEnd(),
    `cells=${comp.length}`,
  ]
    .filter((s) => s.length > 0)
    .join(" ")
  return { merit, bbox, compW, sumNet, detail, sideColNarrow }
}

/**
 * Seeds: cells ≥ `thrHigh`. Flood into neighbors ≥ `thrLow` (4- or 8-connected).
 * Avoids single-threshold fragmentation where only brochure columns stay connected.
 */
function collectForegroundComponentsHysteresis(
  net: Float64Array,
  nx: number,
  ny: number,
  thrHigh: number,
  thrLow: number,
  eightConn: boolean
): number[][] {
  const seen = new Uint8Array(nx * ny)
  const comps: number[][] = []
  const neighOff: Array<[number, number]> = eightConn
    ? [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
        [-1, -1],
        [-1, 1],
        [1, -1],
        [1, 1],
      ]
    : [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
      ]

  for (let c = 0; c < nx * ny; c++) {
    if (seen[c] || net[c]! < thrHigh) continue
    const comp: number[] = []
    const q: number[] = [c]
    seen[c] = 1
    while (q.length) {
      const cur = q.pop()!
      comp.push(cur)
      const x = cur % nx
      const y = Math.floor(cur / nx)
      for (const [dx, dy] of neighOff) {
        const nxv = x + dx
        const nyv = y + dy
        if (nxv < 0 || nxv >= nx || nyv < 0 || nyv >= ny) continue
        const nb = nxv + nyv * nx
        if (seen[nb] || net[nb]! < thrLow) continue
        seen[nb] = 1
        q.push(nb)
      }
    }
    comps.push(comp)
  }
  return comps
}

function cellIndex(
  x: number,
  y: number,
  pageBounds: PlanBoundingBox,
  nx: number,
  ny: number
): number {
  const pw = pageBounds.maxX - pageBounds.minX
  const ph = pageBounds.maxY - pageBounds.minY
  const cx = Math.min(nx - 1, Math.max(0, Math.floor(((x - pageBounds.minX) / Math.max(1e-9, pw)) * nx)))
  const cy = Math.min(ny - 1, Math.max(0, Math.floor(((y - pageBounds.minY) / Math.max(1e-9, ph)) * ny)))
  return cx + cy * nx
}

function cellBox(idx: number, pageBounds: PlanBoundingBox, nx: number, ny: number): PlanBoundingBox {
  const cx = idx % nx
  const cy = Math.floor(idx / nx)
  const pw = pageBounds.maxX - pageBounds.minX
  const ph = pageBounds.maxY - pageBounds.minY
  const cellW = pw / nx
  const cellH = ph / ny
  return {
    minX: pageBounds.minX + cx * cellW,
    maxX: pageBounds.minX + (cx + 1) * cellW,
    minY: pageBounds.minY + cy * cellH,
    maxY: pageBounds.minY + (cy + 1) * cellH,
  }
}

function cellMidpoint(idx: number, pageBounds: PlanBoundingBox, nx: number, ny: number): { x: number; y: number } {
  const b = cellBox(idx, pageBounds, nx, ny)
  return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }
}

function boxesOverlap(a: PlanBoundingBox, b: PlanBoundingBox): boolean {
  return !(a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY)
}

function lineSamples(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  step: number
): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = []
  const dx = x2 - x1
  const dy = y2 - y1
  const L = Math.hypot(dx, dy)
  if (L < 1e-6) {
    out.push({ x: x1, y: y1 })
    return out
  }
  const n = Math.max(1, Math.ceil(L / step))
  for (let k = 0; k <= n; k++) {
    const t = k / n
    out.push({ x: x1 + dx * t, y: y1 + dy * t })
  }
  return out
}

function addHypothesisFootprint(
  hyp: { centerline: { x1: number; y1: number; x2: number; y2: number }; supportScore: number; length: number },
  nx: number,
  ny: number,
  pageBounds: PlanBoundingBox,
  grid: Float64Array,
  inflate: number,
  wScale: number,
  cellDiag: number
): void {
  const cl = hyp.centerline
  const mass = hyp.supportScore * Math.max(1, hyp.length) * wScale
  const step = Math.max(6, cellDiag * 0.45)
  const pts = lineSamples(cl.x1, cl.y1, cl.x2, cl.y2, step)
  const dx = cl.x2 - cl.x1
  const dy = cl.y2 - cl.y1
  const L = Math.hypot(dx, dy)
  const nxv = L > 1e-6 ? -dy / L : 0
  const nyv = L > 1e-6 ? dx / L : 1
  for (const p of [
    ...pts,
    ...pts.map((q) => ({ x: q.x + nxv * inflate, y: q.y + nyv * inflate })),
    ...pts.map((q) => ({ x: q.x - nxv * inflate, y: q.y - nyv * inflate })),
  ]) {
    const idx = cellIndex(p.x, p.y, pageBounds, nx, ny)
    grid[idx] += mass / (pts.length * 3)
  }
}

function addSpanFootprint(
  sp: GlobalStructuralSpan,
  nx: number,
  ny: number,
  pageBounds: PlanBoundingBox,
  grid: Float64Array,
  sScale: number,
  cellDiagPT: number
): void {
  const cl = sp.centerline
  const mass = sp.spanLength * sp.shellHintScore * sScale
  const step = Math.max(8, cellDiagPT * 0.5)
  for (const p of lineSamples(cl.x1, cl.y1, cl.x2, cl.y2, step)) {
    const idx = cellIndex(p.x, p.y, pageBounds, nx, ny)
    grid[idx] += mass / Math.max(4, Math.ceil(sp.spanLength / step))
  }
}

/**
 * Determine the primary apartment plan rectangle on a brochure page using hypotheses,
 * global spans, stroke density, and brochure-text penalties.
 */
export function deriveMainPlanBody(
  cleanedSegments: ExtractedLineSegment[],
  wallHypothesesPayload: ArchitecturalWallHypothesesDebugPayload,
  globalSpansPayload: GlobalStructuralSpansDebugPayload,
  pageBounds: PlanBoundingBox,
  texts: ExtractedTextRun[],
  opts?: MainPlanBodyOptions
): MainPlanBodyResult {
  const O = { ...OPT_DEFAULTS, ...opts }
  const nx = Math.max(8, O.gridCols)
  const ny = Math.max(8, O.gridRows)
  const pw = pageBounds.maxX - pageBounds.minX
  const ph = pageBounds.maxY - pageBounds.minY
  const cellDiag = Math.hypot(pw / nx, ph / ny)

  const score = new Float64Array(nx * ny)
  const penalty = new Float64Array(nx * ny)
  const segVotes = new Int32Array(nx * ny)

  const reasons: string[] = []

  let hypMassTotal = 0
  for (const h of wallHypothesesPayload.hypotheses) {
    const m = h.supportScore * h.length
    hypMassTotal += m
    addHypothesisFootprint(h, nx, ny, pageBounds, score, O.hypothesisInflatePt, O.hypothesisWeightScale, cellDiag)
  }
  reasons.push(
    `Wall hypotheses: ${wallHypothesesPayload.hypotheses.length} regions contribute axis-aligned mass (Σ length×support ≈ ${hypMassTotal.toFixed(0)}).`
  )

  let spanMass = 0
  for (const s of globalSpansPayload.spans) {
    spanMass += s.spanLength * s.shellHintScore
    addSpanFootprint(s, nx, ny, pageBounds, score, O.spanWeightScale, cellDiag)
  }
  reasons.push(
    `Global spans: ${globalSpansPayload.spans.length} layout axes vote on the grid (Σ len×shellHint ≈ ${spanMass.toFixed(0)}).`
  )

  for (let i = 0; i < cleanedSegments.length; i++) {
    const m = segmentMid(cleanedSegments[i]!)
    if (!pointInBox(m.x, m.y, pageBounds)) continue
    const idx = cellIndex(m.x, m.y, pageBounds, nx, ny)
    if (segVotes[idx]! >= O.maxSegmentVotesPerCell) continue
    segVotes[idx] = (segVotes[idx] ?? 0) + 1
    score[idx] += O.segmentCellWeight * Math.min(2, 1 + segmentLengthPdfUnits(cleanedSegments[i]!) / 120)
  }
  reasons.push(
    `Stroke midpoints: capped at ${O.maxSegmentVotesPerCell} votes/cell to limit brochure clutter spikes.`
  )

  const { roomHits, dimHits } = applyRoomProgramTextBoostToGrid(texts, pageBounds, nx, ny, score, O)
  if (roomHits + dimHits > 0) {
    reasons.push(
      `Room-program text boost: ${roomHits} label-like runs + ${dimHits} dimension-like runs add localized grid weight (in-plan signal).`
    )
  }

  let penCells = 0
  for (const t of texts) {
    const pen = textBrochurePenalty(t, pageBounds, O)
    if (pen <= 0) continue
    const tb = expandedTextBBox(t, 4)
    for (let ci = 0; ci < nx * ny; ci++) {
      const cb = cellBox(ci, pageBounds, nx, ny)
      if (boxesOverlap(cb, tb)) {
        penalty[ci] += pen
        penCells++
      }
    }
  }
  reasons.push(
    `Text penalties: brochure keywords / titles / corner blobs de-emphasize ${penCells} cell overlaps (heuristic).`
  )

  let peak = 0
  const net = new Float64Array(nx * ny)
  for (let i = 0; i < nx * ny; i++) {
    net[i] = Math.max(0, score[i]! - penalty[i]!)
    if (net[i]! > peak) peak = net[i]!
  }

  const hypHull = clipBoxToPage(
    inflateBox(unionSegmentBboxFromHyps(wallHypothesesPayload.hypotheses, pageBounds), O.hypothesisHullPadPt),
    pageBounds
  )
  const hullScale = O.outsideHypothesisHullNetScale
  if (hullScale < 1 - 1e-6 && hypHull.maxX > hypHull.minX && hypHull.maxY > hypHull.minY) {
    for (let i = 0; i < nx * ny; i++) {
      const p = cellMidpoint(i, pageBounds, nx, ny)
      if (!pointInBox(p.x, p.y, hypHull)) net[i]! *= hullScale
    }
    peak = 0
    for (let i = 0; i < nx * ny; i++) if (net[i]! > peak) peak = net[i]!
    reasons.push(
      `Hypothesis hull mask: net outside inflated hypothesis AABB (pad ${O.hypothesisHullPadPt}pt) ×${hullScale.toFixed(2)} before foreground extraction.`
    )
  }

  if (peak < 1e-6) {
    const fallback = clipBoxToPage(
      inflateBox(unionSegmentBboxFromHyps(wallHypothesesPayload.hypotheses, pageBounds), O.outputPadPt),
      pageBounds
    )
    reasons.push("No positive grid score — fallback to union of hypothesis centerlines + pad.")
    return buildFilterResult(
      cleanedSegments,
      texts,
      fallback,
      pageBounds,
      0.35,
      reasons,
      nx,
      ny,
      peak,
      0,
      hypMassTotal,
      spanMass,
      penCells,
      0,
      O
    )
  }

  const thrHigh = peak * O.scoreThresholdRatio
  const thrLow = Math.min(
    thrHigh,
    Math.max(
      1e-12 * peak,
      Math.min(thrHigh * O.scoreThresholdLowFraction, peak * O.scoreThresholdLowAbsPeakFraction)
    )
  )
  const comps = collectForegroundComponentsHysteresis(net, nx, ny, thrHigh, thrLow, O.hysteresis8Connected)

  const adjList = comps.map((comp) => ({
    comp,
    adj: adjustedComponentMerit(comp, net, pageBounds, nx, ny, pw, ph, texts, O),
  }))
  const viablePool = adjList.filter((x) => !x.adj.sideColNarrow)
  const rankingPool = viablePool.length > 0 ? viablePool : adjList
  const totalNetInPool = rankingPool.reduce((s, x) => s + x.adj.sumNet, 0) + 1e-9

  let bestComp: number[] | null = null
  let bestPlausibleMerit = -Infinity
  let bestPlausibleDetail = ""
  let legacyBestComp: number[] | null = null
  let legacyMerit = -Infinity

  for (const { comp } of adjList) {
    let compW = 0
    for (const i of comp) compW += net[i]!
    const rawMerit = compW * Math.sqrt(comp.length)
    if (rawMerit > legacyMerit) {
      legacyMerit = rawMerit
      legacyBestComp = comp
    }
  }

  for (const { comp, adj } of rankingPool) {
    const massShare = adj.sumNet / totalNetInPool
    const combined = adj.merit * Math.pow(massShare, O.componentMassShareGamma)
    const detail = `${adj.detail} massShr×${Math.pow(massShare, O.componentMassShareGamma).toFixed(2)}`
    if (combined > bestPlausibleMerit) {
      bestPlausibleMerit = combined
      bestComp = comp
      bestPlausibleDetail = detail
    }
  }

  if (viablePool.length > 0 && adjList.some((x) => x.adj.sideColNarrow)) {
    reasons.push("Side-column components excluded from ranking pool when at least one non–side-column candidate exists.")
  }

  if (bestComp == null || bestComp.length === 0) {
    bestComp = legacyBestComp
    if (bestComp != null) {
      reasons.push("Plausibility ranking unavailable — fell back to legacy raw grid merit component.")
    }
  } else if (legacyBestComp != null && legacyBestComp !== bestComp && bestPlausibleDetail.length > 0) {
    reasons.push(`Selected component vs. widest raw cluster: plausibility-ranked winner (${bestPlausibleDetail}).`)
  }

  if (bestComp == null || bestComp.length === 0) {
    const fallback = clipBoxToPage(
      inflateBox(unionSegmentBboxFromHyps(wallHypothesesPayload.hypotheses, pageBounds), O.outputPadPt),
      pageBounds
    )
    reasons.push("No component above threshold — fallback bbox from hypotheses.")
    return buildFilterResult(
      cleanedSegments,
      texts,
      fallback,
      pageBounds,
      0.4,
      reasons,
      nx,
      ny,
      peak,
      0,
      hypMassTotal,
      spanMass,
      penCells,
      0,
      O
    )
  }

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let sumNet = 0
  for (const idx of bestComp) {
    const b = cellBox(idx, pageBounds, nx, ny)
    minX = Math.min(minX, b.minX)
    minY = Math.min(minY, b.minY)
    maxX = Math.max(maxX, b.maxX)
    maxY = Math.max(maxY, b.maxY)
    sumNet += net[idx]!
  }
  const rawLayout: PlanBoundingBox = { minX, minY, maxX, maxY }
  const primaryLayoutBBox = clipBoxToPage(inflateBox(rawLayout, O.outputPadPt), pageBounds)
  const meanCell = sumNet / bestComp.length
  const confidence = clamp01(0.25 + 0.55 * (meanCell / (peak + 1e-6)) + 0.12 * Math.min(1, bestComp.length / 40))

  reasons.push(
    `Foreground components: ${comps.length} (hysteresis high≥${thrHigh.toFixed(2)} (${((thrHigh / peak) * 100).toFixed(
      1
    )}% peak), low≥${thrLow.toFixed(2)} (${((thrLow / peak) * 100).toFixed(1)}% peak)); winner ${
      bestComp.length
    } cells after **plausibility** (area, width, aspect, marginal strips, center prior, room/dim text).`
  )
  reasons.push(
    `Primary layout bbox (padded ${O.outputPadPt}pt): ${primaryLayoutBBox.minX.toFixed(0)},${primaryLayoutBBox.minY.toFixed(0)}–${primaryLayoutBBox.maxX.toFixed(0)},${primaryLayoutBBox.maxY.toFixed(0)}.`
  )
  reasons.push(
    `Why this is the main plan: **coherent** wall/span/stroke concentration minus brochure penalties, re-ranked so narrow edge strips and tiny footprints lose to a broad, centered apartment-shaped region with in-plan room/dimension cues.`
  )

  return buildFilterResult(
    cleanedSegments,
    texts,
    primaryLayoutBBox,
    pageBounds,
    confidence,
    reasons,
    nx,
    ny,
    peak,
    bestComp.length,
    hypMassTotal,
    spanMass,
    penCells,
    meanCell,
    O
  )
}

function unionSegmentBboxFromHyps(hyps: ArchitecturalWallHypothesesDebugPayload["hypotheses"], page: PlanBoundingBox): PlanBoundingBox {
  if (hyps.length === 0) return { ...page }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const h of hyps) {
    const c = h.centerline
    minX = Math.min(minX, c.x1, c.x2)
    maxX = Math.max(maxX, c.x1, c.x2)
    minY = Math.min(minY, c.y1, c.y2)
    maxY = Math.max(maxY, c.y1, c.y2)
  }
  if (!Number.isFinite(minX)) return { ...page }
  return { minX, minY, maxX, maxY }
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x))
}

function buildFilterResult(
  cleanedSegments: ExtractedLineSegment[],
  texts: ExtractedTextRun[],
  primaryLayoutBBox: PlanBoundingBox,
  pageBounds: PlanBoundingBox,
  confidence: number,
  reasons: string[],
  nx: number,
  ny: number,
  peak: number,
  foregroundCells: number,
  hypMass: number,
  spanMass: number,
  penCells: number,
  meanNetInForeground: number,
  O: Required<MainPlanBodyOptions>
): MainPlanBodyResult {
  const primaryLayoutSegments: ExtractedLineSegment[] = []
  const excludedNonLayoutSegments: ExtractedLineSegment[] = []
  const primaryLayoutCleanedIndices: number[] = []
  for (let i = 0; i < cleanedSegments.length; i++) {
    const s = cleanedSegments[i]!
    const m = segmentMid(s)
    if (pointInBox(m.x, m.y, primaryLayoutBBox)) {
      primaryLayoutSegments.push(s)
      primaryLayoutCleanedIndices.push(i)
    } else {
      excludedNonLayoutSegments.push(s)
    }
  }

  const primaryLayoutTextBoxes: ExtractedTextRun[] = []
  const excludedNonLayoutTexts: ExtractedTextRun[] = []
  for (const t of texts) {
    const c = textCenter(t)
    if (pointInBox(c.x, c.y, primaryLayoutBBox)) primaryLayoutTextBoxes.push(t)
    else excludedNonLayoutTexts.push(t)
  }

  const summary: MainPlanBodySummary = {
    cleanedInputCount: cleanedSegments.length,
    primaryLayoutSegmentCount: primaryLayoutSegments.length,
    excludedNonLayoutCount: excludedNonLayoutSegments.length,
    primaryLayoutTextCount: primaryLayoutTextBoxes.length,
    excludedTextCount: excludedNonLayoutTexts.length,
    gridForegroundCells: foregroundCells,
    peakCellScore: peak,
    meanScoreInLayoutCells: foregroundCells > 0 ? meanNetInForeground : 0,
    totalHypothesisMass: hypMass,
    totalSpanMass: spanMass,
    textPenaltyCells: penCells,
  }

  const debugPayload: MainPlanBodyDebugPayload = {
    primaryLayoutBBox: { ...primaryLayoutBBox },
    confidence,
    summary,
    reasons: [...reasons],
    primaryLayoutCleanedIndices,
  }

  return {
    primaryLayoutBBox,
    primaryLayoutSegments,
    excludedNonLayoutSegments,
    primaryLayoutTextBoxes,
    excludedNonLayoutTexts,
    confidence,
    summary,
    reasons,
    debugPayload,
  }
}

export interface BuildMainPlanBodySvgOptions {
  pageBounds: PlanBoundingBox
  primaryLayoutBBox: PlanBoundingBox
  cleanedSegments: ExtractedLineSegment[]
  primaryLayoutCleanedIndices: Set<number> | readonly number[]
  beforeCount: number
  afterCount: number
  /** Optional title for top of overlay. */
  title?: string
}

/** Debug SVG: dim excluded strokes, highlight plan rectangle, show counts. */
export function buildMainPlanBodySvgString(o: BuildMainPlanBodySvgOptions): string {
  const pb = o.pageBounds
  const w = pb.maxX - pb.minX
  const h = pb.maxY - pb.minY
  const kept = new Set(o.primaryLayoutCleanedIndices)
  const segLines = o.cleanedSegments
    .map((s, i) => {
      const inside = kept.has(i)
      const stroke = inside ? "rgba(30,30,30,0.92)" : "rgba(160,160,160,0.22)"
      const sw = inside ? 0.55 : 0.35
      return `<line x1="${s.x1}" y1="${s.y1}" x2="${s.x2}" y2="${s.y2}" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round"/>`
    })
    .join("\n")
  const bx = o.primaryLayoutBBox
  const title = o.title ?? "Main plan body (debug)"
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${pb.minX} ${pb.minY} ${w} ${h}" width="${Math.round(w)}" height="${Math.round(h)}">
<rect x="${pb.minX}" y="${pb.minY}" width="${w}" height="${h}" fill="white"/>
<text x="${pb.minX + 8}" y="${pb.minY + 14}" font-size="11" fill="#333" font-family="system-ui,sans-serif">${escapeXml(
    title
  )}</text>
<text x="${pb.minX + 8}" y="${pb.minY + 28}" font-size="10" fill="#666" font-family="system-ui,sans-serif">Segments ${o.afterCount} / ${o.beforeCount} inside primary layout</text>
<g>${segLines}</g>
<rect x="${bx.minX}" y="${bx.minY}" width="${bx.maxX - bx.minX}" height="${bx.maxY - bx.minY}" fill="none" stroke="rgba(0,140,80,0.85)" stroke-width="2" stroke-dasharray="10 6"/>
</svg>`
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;")
}

export interface RerunMainPlanDownstreamOpts {
  hypothesisOpts?: Parameters<typeof buildArchitecturalWallHypotheses>[4]
  spanOpts?: Parameters<typeof buildGlobalStructuralSpans>[2]
}

/**
 * Re-run wall hypotheses + global spans restricted to the plan body (debug compare).
 */
export function rerunPlanBodyDownstreamDebug(
  plan: MainPlanBodyResult,
  fullCleanedSegments: ExtractedLineSegment[],
  structuralSegments: ExtractedLineSegment[],
  pageBounds: PlanBoundingBox,
  opts?: RerunMainPlanDownstreamOpts
): MainPlanBodyDownstreamCompare {
  const notes: string[] = []
  const bbox = plan.primaryLayoutBBox
  const structuralIn = structuralSegments.filter((s) => pointInBox(segmentMid(s).x, segmentMid(s).y, bbox))
  notes.push(
    `Structural segments inside plan bbox: ${structuralIn.length} / ${structuralSegments.length} (midpoint gate).`
  )

  const hyp = buildArchitecturalWallHypotheses(
    plan.primaryLayoutSegments,
    structuralIn,
    plan.primaryLayoutTextBoxes,
    pageBounds,
    opts?.hypothesisOpts
  )

  const idxMap = plan.debugPayload.primaryLayoutCleanedIndices
  const globalSpans = buildGlobalStructuralSpans(plan.primaryLayoutSegments, bbox, {
    ...opts?.spanOpts,
    scoringEnvelope: bbox,
    originalCleanedIndices: idxMap,
  })

  notes.push(
    `Plan-only wall hypotheses: ${hyp.summary.totalHypotheses} (strict structural input reduced to planInterior).`
  )
  notes.push(`Plan-only global spans: ${globalSpans.summary.totalSpanCount}.`)

  return {
    wallHypothesesPlanOnly: hyp,
    globalSpansPlanOnly: globalSpans,
    structuralSegmentsUsedCount: structuralIn.length,
    notes,
  }
}