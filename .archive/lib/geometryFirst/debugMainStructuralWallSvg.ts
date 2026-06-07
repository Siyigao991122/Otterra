/**
 * Debug-only SVG for geometry-first main wall selection (no product UI).
 * PDF user space inside a Y-flip group; viewBox uses the same axis-aligned bounds as PDF (post-flip y matches viewBox y).
 *
 * Display width/height are capped in pixels so browsers can rasterize; strokes use non-scaling-stroke.
 */

import * as fs from "node:fs"
import * as path from "node:path"

import type { ExtractedLineSegment, ExtractedTextRun, PlanBoundingBox } from "@/lib/geometryFirst/types"
import { segmentsNearlyEqual } from "@/lib/geometryFirst/architecturalWallHypotheses"
import type { WallGraphFoundationOptions } from "@/lib/geometryFirst/wallGraphFoundation"
import { computeWallSegmentTopComponentRanks } from "@/lib/geometryFirst/wallGraphFoundation"
import type { DrawingClusterDiagnosticsSvgOverlay } from "@/lib/geometryFirst/drawingClusterDiagnostics"

const DEBUG_DIR_NAME = "debug"
const DEFAULT_BASENAME = "last-pdf"
const CONTENT_PAD = 32
const DISPLAY_MAX_PX = 1600

const COLOR_BG = "#ffffff"
const COLOR_CLEANED = "#b8b8b8"
const COLOR_SELECTED_DIM = "#1a1a1a"
const RANK_STROKE: Record<0 | 1 | 2, string> = {
  0: "#c62828",
  1: "#1565c0",
  2: "#2e7d32",
}
const COLOR_TEXT_BOX = "#9e9e9e"
const COLOR_PAGE_BOUNDS = "#7b1fa2"
const COLOR_SELECTED_BBOX = "#ef6c00"
const COLOR_CORNER_MARKER = "#e91e63"
/** Extended structural only (rescued beyond strict) — debug */
const COLOR_EXTENDED_ONLY = "#00838f"
/** Robust extent overlay: raw union bbox vs robust envelope */
const COLOR_RAW_CLEANED_BBOX = "#e57373"
const COLOR_ROBUST_ENVELOPE = "#43a047"
/** Outlier strokes (faint) */
const COLOR_OUTLIER_STROKE = "#ffab91"

/** User-space stroke widths (non-scaling vs viewport). */
const SW_CLEANED = 2.5
const SW_EXTENDED_ONLY = 2.85
const SW_SELECTED_RANK = 4.5
const SW_SELECTED_DIM = 3.5
const SW_BOUNDS = 2.25
const SW_TEXT = 2
const SW_MARKER = 3.5
const SW_ROBUST_OVERLAY = 1.85
const SW_OUTLIER = 1.2
const COLOR_DIAG_LARGEST_CLUSTER = "#0277bd"
const COLOR_DIAG_ROBUST_CORE = "#1b5e20"
const COLOR_DIAG_ENVELOPE_GUIDE = "#7cb342"
const COLOR_DIAG_EXCLUDED_LONG = "#d50000"
const COLOR_DIAG_EXCLUDED_OTHER = "#bdbdbd"
const SW_DIAG_RECT = 1.65
const SW_DIAG_LONG = 3.85
const SW_DIAG_OTHER = 1.35

/** Debug: compare raw cleaned AABB vs robust envelope; faint outlier strokes. */
export interface RobustPlanExtentSvgOverlay {
  rawCleanedEnvelope: PlanBoundingBox
  robustEnvelope: PlanBoundingBox
  /** Indices into `cleanedSegments`. */
  outlierIndices: number[]
}

export interface MainStructuralWallSvgDebugMeta {
  pageBounds: PlanBoundingBox
  contentBounds: PlanBoundingBox
  viewBox: { x: number; y: number; width: number; height: number }
  svgWidthPx: number
  svgHeightPx: number
  degenerateContentUsedPageFallback: boolean
  /** translate(0, flipY) used on the PDF geometry group */
  flipTranslateY: number
}

export interface MainStructuralWallSvgBuildResult {
  svg: string
  debug: MainStructuralWallSvgDebugMeta
}

function escapeXmlAttr(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
}

function expandedTextRect(
  t: ExtractedTextRun,
  pad: number
): { minX: number; maxX: number; minY: number; maxY: number } {
  const w = t.width ?? Math.max(6, t.text.length * 4.5)
  const h = t.height ?? 11
  return {
    minX: t.x - pad,
    maxX: t.x + w + pad,
    minY: t.y - h - pad,
    maxY: t.y + pad,
  }
}

export function unionSegmentBbox(segments: ExtractedLineSegment[]): PlanBoundingBox | null {
  if (segments.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const s of segments) {
    minX = Math.min(minX, s.x1, s.x2)
    minY = Math.min(minY, s.y1, s.y2)
    maxX = Math.max(maxX, s.x1, s.x2)
    maxY = Math.max(maxY, s.y1, s.y2)
  }
  return { minX, minY, maxX, maxY }
}

function boundsFromTexts(texts: ExtractedTextRun[]): PlanBoundingBox | null {
  if (texts.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const t of texts) {
    const b = expandedTextRect(t, 0)
    minX = Math.min(minX, b.minX)
    minY = Math.min(minY, b.minY)
    maxX = Math.max(maxX, b.maxX)
    maxY = Math.max(maxY, b.maxY)
  }
  return { minX, minY, maxX, maxY }
}

export function isFiniteBox(b: PlanBoundingBox): boolean {
  return (
    Number.isFinite(b.minX) &&
    Number.isFinite(b.minY) &&
    Number.isFinite(b.maxX) &&
    Number.isFinite(b.maxY) &&
    b.maxX > b.minX + 1e-9 &&
    b.maxY > b.minY + 1e-9
  )
}

function unionBoxes(a: PlanBoundingBox, b: PlanBoundingBox | null | undefined): PlanBoundingBox {
  if (b == null || !isFiniteBox(b)) return { ...a }
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  }
}

function unionFiniteBoxes(a: PlanBoundingBox | null, b: PlanBoundingBox | null): PlanBoundingBox | null {
  if (a != null && isFiniteBox(a) && b != null && isFiniteBox(b)) {
    return {
      minX: Math.min(a.minX, b.minX),
      minY: Math.min(a.minY, b.minY),
      maxX: Math.max(a.maxX, b.maxX),
      maxY: Math.max(a.maxY, b.maxY),
    }
  }
  if (a != null && isFiniteBox(a)) return { ...a }
  if (b != null && isFiniteBox(b)) return { ...b }
  return null
}

/** Expand view framing when diagnostics need the largest-cluster hull as well as robust envelope. */
export function contentBoundsHintFromGeometryOverlays(
  drawingClusterDiagnosticsOverlay?: DrawingClusterDiagnosticsSvgOverlay | null,
  robustPlanExtentOverlay?: RobustPlanExtentSvgOverlay | null
): PlanBoundingBox | null {
  let u: PlanBoundingBox | null = null
  if (drawingClusterDiagnosticsOverlay != null) {
    if (isFiniteBox(drawingClusterDiagnosticsOverlay.robustEnvelope)) {
      u = { ...drawingClusterDiagnosticsOverlay.robustEnvelope }
    }
    const lc = drawingClusterDiagnosticsOverlay.largestClusterBBox
    if (lc != null && isFiniteBox(lc)) u = unionFiniteBoxes(u, lc)
  }
  if (robustPlanExtentOverlay != null) {
    if (isFiniteBox(robustPlanExtentOverlay.robustEnvelope)) {
      u = unionFiniteBoxes(u, { ...robustPlanExtentOverlay.robustEnvelope })
    }
    if (isFiniteBox(robustPlanExtentOverlay.rawCleanedEnvelope)) {
      u = unionFiniteBoxes(u, { ...robustPlanExtentOverlay.rawCleanedEnvelope })
    }
  }
  return u
}

const FALLBACK_PAGE: PlanBoundingBox = { minX: 0, minY: 0, maxX: 612, maxY: 792 }

export function computeMainStructuralWallSvgContentBounds(input: {
  pageBounds: PlanBoundingBox
  cleanedSegments: ExtractedLineSegment[]
  mainStructuralSplitSegments: ExtractedLineSegment[]
  texts: ExtractedTextRun[]
  /**
   * When set, this box is used instead of the union of all `cleanedSegments` for view framing
   * (keeps massive outlier strokes from expanding the viewBox).
   */
  cleanedBoundsOverride?: PlanBoundingBox | null
}): { bounds: PlanBoundingBox; degenerateContentUsedPageFallback: boolean } {
  const { pageBounds, cleanedSegments, mainStructuralSplitSegments, texts, cleanedBoundsOverride } = input
  let u = { ...pageBounds }
  const cleanedBbox =
    cleanedBoundsOverride != null && isFiniteBox(cleanedBoundsOverride)
      ? cleanedBoundsOverride
      : unionSegmentBbox(cleanedSegments)
  u = unionBoxes(u, cleanedBbox)
  u = unionBoxes(u, unionSegmentBbox(mainStructuralSplitSegments))
  u = unionBoxes(u, boundsFromTexts(texts))

  let degenerate = false
  if (!isFiniteBox(u)) {
    degenerate = true
    u = isFiniteBox(pageBounds) ? { ...pageBounds } : { ...FALLBACK_PAGE }
  }

  const w0 = u.maxX - u.minX
  const h0 = u.maxY - u.minY
  if (!Number.isFinite(w0) || !Number.isFinite(h0) || w0 < 1e-6 || h0 < 1e-6) {
    degenerate = true
    u = isFiniteBox(pageBounds) ? { ...pageBounds } : { ...FALLBACK_PAGE }
  }

  return {
    bounds: {
      minX: u.minX - CONTENT_PAD,
      minY: u.minY - CONTENT_PAD,
      maxX: u.maxX + CONTENT_PAD,
      maxY: u.maxY + CONTENT_PAD,
    },
    degenerateContentUsedPageFallback: degenerate,
  }
}

function computeDisplayPixels(cW: number, cH: number): { w: number; h: number } {
  if (!Number.isFinite(cW) || !Number.isFinite(cH) || cW <= 0 || cH <= 0) {
    return { w: DISPLAY_MAX_PX, h: Math.round(DISPLAY_MAX_PX * 0.75) }
  }
  if (cW >= cH) {
    const w = DISPLAY_MAX_PX
    const h = Math.max(1, (cH / cW) * DISPLAY_MAX_PX)
    return { w, h }
  }
  const h = DISPLAY_MAX_PX
  const w = Math.max(1, (cW / cH) * DISPLAY_MAX_PX)
  return { w, h }
}

function lineEl(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  stroke: string,
  strokeWidth: number,
  dash?: string,
  opacity = 1
): string {
  const dashAttr = dash != null ? ` stroke-dasharray="${dash}"` : ""
  const opAttr = opacity < 1 ? ` opacity="${opacity}"` : ""
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linecap="round" vector-effect="non-scaling-stroke"${dashAttr}${opAttr}/>`
}

function rectStrokeEl(
  minX: number,
  minY: number,
  w: number,
  h: number,
  stroke: string,
  strokeWidth: number,
  dash?: string,
  opacity = 1
): string {
  const dashAttr = dash != null ? ` stroke-dasharray="${dash}"` : ""
  const opAttr = opacity < 1 ? ` opacity="${opacity}"` : ""
  return `<rect x="${minX}" y="${minY}" width="${w}" height="${h}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth}" vector-effect="non-scaling-stroke"${dashAttr}${opAttr}/>`
}

function rectFillEl(minX: number, minY: number, w: number, h: number, fill: string): string {
  return `<rect x="${minX}" y="${minY}" width="${w}" height="${h}" fill="${fill}" stroke="none"/>`
}

function logDebugMeta(label: string, debug: MainStructuralWallSvgDebugMeta): void {
  const pb = debug.pageBounds
  const cb = debug.contentBounds
  const vb = debug.viewBox
  console.log(`[${label}] pageBounds: minX=${pb.minX} minY=${pb.minY} maxX=${pb.maxX} maxY=${pb.maxY}`)
  console.log(`[${label}] contentBounds: minX=${cb.minX} minY=${cb.minY} maxX=${cb.maxX} maxY=${cb.maxY}`)
  console.log(
    `[${label}] viewBox: x=${vb.x} y=${vb.y} width=${vb.width} height=${vb.height} | degeneratePageFallback=${debug.degenerateContentUsedPageFallback} flipTranslateY=${debug.flipTranslateY}`
  )
  console.log(`[${label}] svg width/height (px): ${debug.svgWidthPx} × ${debug.svgHeightPx}`)
}

function buildMeta(
  pageBounds: PlanBoundingBox,
  contentBounds: PlanBoundingBox,
  degenerate: boolean,
  vbW: number,
  vbH: number,
  dispW: number,
  dispH: number,
  flipY: number
): MainStructuralWallSvgDebugMeta {
  return {
    pageBounds: { ...pageBounds },
    contentBounds: { ...contentBounds },
    viewBox: { x: contentBounds.minX, y: contentBounds.minY, width: vbW, height: vbH },
    svgWidthPx: dispW,
    svgHeightPx: dispH,
    degenerateContentUsedPageFallback: degenerate,
    flipTranslateY: flipY,
  }
}

export interface MainStructuralWallSvgDebugInput {
  cleanedSegments: ExtractedLineSegment[]
  mainStructuralSplitSegments: ExtractedLineSegment[]
  texts: ExtractedTextRun[]
  pageBounds: PlanBoundingBox
  wallGraphOpts?: WallGraphFoundationOptions
  /** Shown in SVG <title> only. */
  sourceLabel?: string
  /**
   * Full extended structural set after junction split (strict ∪ rescues).
   * Strokes that are **not** geometrically matched to `mainStructuralSplitSegments` render as extended-only (teal dash).
   */
  extendedStructuralSplitSegments?: ExtractedLineSegment[]
  /** Optional overlay: raw vs robust plan extent and faint outlier strokes (debug). */
  robustPlanExtentOverlay?: RobustPlanExtentSvgOverlay
  /** Optional overlay: largest cluster vs robust core/envelope; long excluded strokes highlighted. */
  drawingClusterDiagnosticsOverlay?: DrawingClusterDiagnosticsSvgOverlay
}

export interface MainStructuralWallSvgWriteOptions extends MainStructuralWallSvgDebugInput {
  /**
   * Project root or explicit debug folder. File is `${debugDir}/geometry-first-main-walls-${basename}.svg`.
   */
  projectRoot: string
  /** Filename slug; default `last-pdf`. */
  basename?: string
}

/**
 * Full layered debug SVG (string + numeric debug metadata).
 */
export function extendedOnlySplitSegments(
  extendedSplit: ExtractedLineSegment[] | undefined,
  strictSplit: ExtractedLineSegment[],
  eps = 0.85
): ExtractedLineSegment[] {
  if (extendedSplit == null || extendedSplit.length === 0) return []
  return extendedSplit.filter((s) => !strictSplit.some((t) => segmentsNearlyEqual(s, t, eps)))
}

export function buildMainStructuralWallSelectionSvgString(input: MainStructuralWallSvgDebugInput): MainStructuralWallSvgBuildResult {
  const {
    cleanedSegments,
    mainStructuralSplitSegments,
    texts,
    pageBounds,
    wallGraphOpts,
    sourceLabel,
    extendedStructuralSplitSegments,
    robustPlanExtentOverlay,
    drawingClusterDiagnosticsOverlay,
  } = input

  const extendedOnly = extendedOnlySplitSegments(extendedStructuralSplitSegments, mainStructuralSplitSegments)

  const outlierSet = robustPlanExtentOverlay
    ? new Set<number>(robustPlanExtentOverlay.outlierIndices)
    : null

  const cleanedBoundsOverride = contentBoundsHintFromGeometryOverlays(
    drawingClusterDiagnosticsOverlay ?? null,
    robustPlanExtentOverlay ?? null
  )

  const { bounds: cb, degenerateContentUsedPageFallback } = computeMainStructuralWallSvgContentBounds({
    pageBounds,
    cleanedSegments,
    mainStructuralSplitSegments,
    texts,
    cleanedBoundsOverride,
  })

  const vbW = cb.maxX - cb.minX
  const vbH = cb.maxY - cb.minY
  const flipY = cb.minY + cb.maxY
  const { w: dispW, h: dispH } = computeDisplayPixels(vbW, vbH)

  const ranks = computeWallSegmentTopComponentRanks(mainStructuralSplitSegments, wallGraphOpts)
  const selBbox = unionSegmentBbox(mainStructuralSplitSegments)

  const markerLen = Math.max(24, Math.min(vbW, vbH) * 0.02)

  const title = sourceLabel ? escapeXmlAttr(sourceLabel) : "geometry-first main walls"

  const parts: string[] = []
  parts.push(`<?xml version="1.0" encoding="UTF-8"?>`)
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${dispW}" height="${dispH}" viewBox="${cb.minX} ${cb.minY} ${vbW} ${vbH}" preserveAspectRatio="xMidYMid meet">`
  )
  parts.push(`<title>${title}</title>`)
  parts.push(rectFillEl(cb.minX, cb.minY, vbW, vbH, COLOR_BG))

  parts.push(`<g transform="translate(0,${flipY}) scale(1,-1)">`)

  parts.push(
    rectStrokeEl(
      pageBounds.minX,
      pageBounds.minY,
      pageBounds.maxX - pageBounds.minX,
      pageBounds.maxY - pageBounds.minY,
      COLOR_PAGE_BOUNDS,
      SW_BOUNDS,
      "10 6"
    )
  )
  if (selBbox && isFiniteBox(selBbox)) {
    parts.push(
      rectStrokeEl(
        selBbox.minX,
        selBbox.minY,
        selBbox.maxX - selBbox.minX,
        selBbox.maxY - selBbox.minY,
        COLOR_SELECTED_BBOX,
        SW_BOUNDS + 0.25,
        "8 5"
      )
    )
  }

  if (robustPlanExtentOverlay) {
    const raw = robustPlanExtentOverlay.rawCleanedEnvelope
    const rb = robustPlanExtentOverlay.robustEnvelope
    if (isFiniteBox(raw)) {
      parts.push(
        rectStrokeEl(
          raw.minX,
          raw.minY,
          raw.maxX - raw.minX,
          raw.maxY - raw.minY,
          COLOR_RAW_CLEANED_BBOX,
          SW_ROBUST_OVERLAY,
          "14 6",
          0.55
        )
      )
    }
    if (isFiniteBox(rb)) {
      parts.push(
        rectStrokeEl(
          rb.minX,
          rb.minY,
          rb.maxX - rb.minX,
          rb.maxY - rb.minY,
          COLOR_ROBUST_ENVELOPE,
          SW_ROBUST_OVERLAY + 0.35,
          "6 4",
          0.85
        )
      )
    }
  }

  if (drawingClusterDiagnosticsOverlay) {
    const d = drawingClusterDiagnosticsOverlay
    const lc = d.largestClusterBBox
    if (lc != null && isFiniteBox(lc)) {
      parts.push(
        rectStrokeEl(
          lc.minX,
          lc.minY,
          lc.maxX - lc.minX,
          lc.maxY - lc.minY,
          COLOR_DIAG_LARGEST_CLUSTER,
          SW_DIAG_RECT,
          "12 5",
          0.9
        )
      )
    }
    if (isFiniteBox(d.robustCoreBBox)) {
      parts.push(
        rectStrokeEl(
          d.robustCoreBBox.minX,
          d.robustCoreBBox.minY,
          d.robustCoreBBox.maxX - d.robustCoreBBox.minX,
          d.robustCoreBBox.maxY - d.robustCoreBBox.minY,
          COLOR_DIAG_ROBUST_CORE,
          SW_DIAG_RECT - 0.2,
          "5 4",
          0.95
        )
      )
    }
    if (isFiniteBox(d.robustEnvelope)) {
      parts.push(
        rectStrokeEl(
          d.robustEnvelope.minX,
          d.robustEnvelope.minY,
          d.robustEnvelope.maxX - d.robustEnvelope.minX,
          d.robustEnvelope.maxY - d.robustEnvelope.minY,
          COLOR_DIAG_ENVELOPE_GUIDE,
          SW_DIAG_RECT + 0.15,
          "2 3",
          0.55
        )
      )
    }
  }

  if (drawingClusterDiagnosticsOverlay) {
    const d = drawingClusterDiagnosticsOverlay
    const core = new Set(d.coreSegmentIndices)
    const longEx = new Set(d.excludedLongHighlightIndices)
    for (let ci = 0; ci < cleanedSegments.length; ci++) {
      const s = cleanedSegments[ci]!
      if (core.has(ci)) {
        parts.push(lineEl(s.x1, s.y1, s.x2, s.y2, COLOR_CLEANED, SW_CLEANED))
      } else if (longEx.has(ci)) {
        parts.push(lineEl(s.x1, s.y1, s.x2, s.y2, COLOR_DIAG_EXCLUDED_LONG, SW_DIAG_LONG, undefined, 0.95))
      } else {
        parts.push(lineEl(s.x1, s.y1, s.x2, s.y2, COLOR_DIAG_EXCLUDED_OTHER, SW_DIAG_OTHER, "4 3", 0.38))
      }
    }
  } else {
    for (let ci = 0; ci < cleanedSegments.length; ci++) {
      if (outlierSet?.has(ci)) continue
      const s = cleanedSegments[ci]!
      parts.push(lineEl(s.x1, s.y1, s.x2, s.y2, COLOR_CLEANED, SW_CLEANED))
    }
    if (outlierSet) {
      for (const ci of robustPlanExtentOverlay!.outlierIndices) {
        const s = cleanedSegments[ci]
        if (!s) continue
        parts.push(lineEl(s.x1, s.y1, s.x2, s.y2, COLOR_OUTLIER_STROKE, SW_OUTLIER, "4 3", 0.42))
      }
    }
  }

  for (const s of extendedOnly) {
    parts.push(lineEl(s.x1, s.y1, s.x2, s.y2, COLOR_EXTENDED_ONLY, SW_EXTENDED_ONLY, "9 5"))
  }

  for (let i = 0; i < mainStructuralSplitSegments.length; i++) {
    const s = mainStructuralSplitSegments[i]!
    const r = ranks[i] ?? -1
    const color = r === 0 || r === 1 || r === 2 ? RANK_STROKE[r] : COLOR_SELECTED_DIM
    const sw = r === 0 || r === 1 || r === 2 ? SW_SELECTED_RANK : SW_SELECTED_DIM
    parts.push(lineEl(s.x1, s.y1, s.x2, s.y2, color, sw))
  }

  for (const t of texts) {
    const b = expandedTextRect(t, 0)
    parts.push(rectStrokeEl(b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY, COLOR_TEXT_BOX, SW_TEXT))
  }

  // PDF-space L at content min corner (maps to lower-left of plan in typical PDF convention)
  parts.push(lineEl(cb.minX, cb.minY, cb.minX + markerLen, cb.minY, COLOR_CORNER_MARKER, SW_MARKER))
  parts.push(lineEl(cb.minX, cb.minY, cb.minX, cb.minY + markerLen, COLOR_CORNER_MARKER, SW_MARKER))

  parts.push(`</g>`)
  parts.push(`</svg>`)

  return {
    svg: parts.join("\n"),
    debug: buildMeta(pageBounds, cb, degenerateContentUsedPageFallback, vbW, vbH, dispW, dispH, flipY),
  }
}

/**
 * Minimal SVG: page bounds + selected main walls only (same viewBox / transform as full debug).
 */
export function buildMinimalMainStructuralWallSvgString(input: MainStructuralWallSvgDebugInput): MainStructuralWallSvgBuildResult {
  const {
    mainStructuralSplitSegments,
    texts,
    pageBounds,
    cleanedSegments,
    sourceLabel,
    extendedStructuralSplitSegments,
    robustPlanExtentOverlay,
    drawingClusterDiagnosticsOverlay,
  } = input

  const extendedOnly = extendedOnlySplitSegments(extendedStructuralSplitSegments, mainStructuralSplitSegments)

  const cleanedBoundsOverride = contentBoundsHintFromGeometryOverlays(
    drawingClusterDiagnosticsOverlay ?? null,
    robustPlanExtentOverlay ?? null
  )

  const { bounds: cb, degenerateContentUsedPageFallback } = computeMainStructuralWallSvgContentBounds({
    pageBounds,
    cleanedSegments,
    mainStructuralSplitSegments,
    texts,
    cleanedBoundsOverride,
  })

  const vbW = cb.maxX - cb.minX
  const vbH = cb.maxY - cb.minY
  const flipY = cb.minY + cb.maxY
  const { w: dispW, h: dispH } = computeDisplayPixels(vbW, vbH)
  const markerLen = Math.max(24, Math.min(vbW, vbH) * 0.02)
  const title = (sourceLabel ? escapeXmlAttr(sourceLabel) : "geometry-first main walls") + " (minimal)"

  const parts: string[] = []
  parts.push(`<?xml version="1.0" encoding="UTF-8"?>`)
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${dispW}" height="${dispH}" viewBox="${cb.minX} ${cb.minY} ${vbW} ${vbH}" preserveAspectRatio="xMidYMid meet">`
  )
  parts.push(`<title>${title}</title>`)
  parts.push(rectFillEl(cb.minX, cb.minY, vbW, vbH, COLOR_BG))

  parts.push(`<g transform="translate(0,${flipY}) scale(1,-1)">`)
  parts.push(
    rectStrokeEl(
      pageBounds.minX,
      pageBounds.minY,
      pageBounds.maxX - pageBounds.minX,
      pageBounds.maxY - pageBounds.minY,
      COLOR_PAGE_BOUNDS,
      SW_BOUNDS,
      "10 6"
    )
  )
  if (robustPlanExtentOverlay) {
    const raw = robustPlanExtentOverlay.rawCleanedEnvelope
    const rb = robustPlanExtentOverlay.robustEnvelope
    if (isFiniteBox(raw)) {
      parts.push(
        rectStrokeEl(
          raw.minX,
          raw.minY,
          raw.maxX - raw.minX,
          raw.maxY - raw.minY,
          COLOR_RAW_CLEANED_BBOX,
          SW_ROBUST_OVERLAY,
          "14 6",
          0.55
        )
      )
    }
    if (isFiniteBox(rb)) {
      parts.push(
        rectStrokeEl(
          rb.minX,
          rb.minY,
          rb.maxX - rb.minX,
          rb.maxY - rb.minY,
          COLOR_ROBUST_ENVELOPE,
          SW_ROBUST_OVERLAY + 0.35,
          "6 4",
          0.85
        )
      )
    }
  }
  if (drawingClusterDiagnosticsOverlay) {
    const d = drawingClusterDiagnosticsOverlay
    const lc = d.largestClusterBBox
    if (lc != null && isFiniteBox(lc)) {
      parts.push(
        rectStrokeEl(
          lc.minX,
          lc.minY,
          lc.maxX - lc.minX,
          lc.maxY - lc.minY,
          COLOR_DIAG_LARGEST_CLUSTER,
          SW_DIAG_RECT,
          "12 5",
          0.9
        )
      )
    }
    if (isFiniteBox(d.robustCoreBBox)) {
      parts.push(
        rectStrokeEl(
          d.robustCoreBBox.minX,
          d.robustCoreBBox.minY,
          d.robustCoreBBox.maxX - d.robustCoreBBox.minX,
          d.robustCoreBBox.maxY - d.robustCoreBBox.minY,
          COLOR_DIAG_ROBUST_CORE,
          SW_DIAG_RECT - 0.2,
          "5 4",
          0.95
        )
      )
    }
    if (isFiniteBox(d.robustEnvelope)) {
      parts.push(
        rectStrokeEl(
          d.robustEnvelope.minX,
          d.robustEnvelope.minY,
          d.robustEnvelope.maxX - d.robustEnvelope.minX,
          d.robustEnvelope.maxY - d.robustEnvelope.minY,
          COLOR_DIAG_ENVELOPE_GUIDE,
          SW_DIAG_RECT + 0.15,
          "2 3",
          0.55
        )
      )
    }
  }
  for (const s of extendedOnly) {
    parts.push(lineEl(s.x1, s.y1, s.x2, s.y2, COLOR_EXTENDED_ONLY, SW_EXTENDED_ONLY, "9 5"))
  }
  for (const s of mainStructuralSplitSegments) {
    parts.push(lineEl(s.x1, s.y1, s.x2, s.y2, COLOR_SELECTED_DIM, SW_SELECTED_DIM + 0.5))
  }
  parts.push(lineEl(cb.minX, cb.minY, cb.minX + markerLen, cb.minY, COLOR_CORNER_MARKER, SW_MARKER))
  parts.push(lineEl(cb.minX, cb.minY, cb.minX, cb.minY + markerLen, COLOR_CORNER_MARKER, SW_MARKER))
  parts.push(`</g>`)
  parts.push(`</svg>`)

  return {
    svg: parts.join("\n"),
    debug: buildMeta(pageBounds, cb, degenerateContentUsedPageFallback, vbW, vbH, dispW, dispH, flipY),
  }
}

/**
 * Writes `debug/geometry-first-main-walls-{basename}.svg` and a minimal sibling `{basename}-minimal.svg`.
 * Logs bounds / viewBox / pixel size. Returns absolute path to the main SVG.
 */
export function writeMainStructuralWallSelectionSvg(opts: MainStructuralWallSvgWriteOptions): string {
  const basename = (opts.basename ?? DEFAULT_BASENAME).replace(/[^a-zA-Z0-9._-]+/g, "_")
  const dir = path.join(opts.projectRoot, DEBUG_DIR_NAME)
  fs.mkdirSync(dir, { recursive: true })
  const outPath = path.join(dir, `geometry-first-main-walls-${basename}.svg`)
  const minimalPath = path.join(dir, `geometry-first-main-walls-${basename}-minimal.svg`)

  const full = buildMainStructuralWallSelectionSvgString(opts)
  logDebugMeta("geometry-first-main-wall-svg full", full.debug)
  fs.writeFileSync(outPath, full.svg, "utf8")

  const minimal = buildMinimalMainStructuralWallSvgString(opts)
  logDebugMeta("geometry-first-main-wall-svg minimal", minimal.debug)
  fs.writeFileSync(minimalPath, minimal.svg, "utf8")

  console.log(`Main-wall selection debug SVG: ${outPath}`)
  console.log(`Main-wall selection minimal debug SVG: ${minimalPath}`)
  return outPath
}
