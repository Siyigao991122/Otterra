/**
 * Debug SVG: cleaned candidates + strict structural strokes + architectural wall hypotheses (centerlines).
 * Matches main-wall debug axis convention (Y flip). Not used by production UI.
 */

import * as fs from "node:fs"
import * as path from "node:path"

import type { ArchitecturalWallHypothesis } from "@/lib/geometryFirst/architecturalWallHypotheses"
import type { GlobalStructuralSpan } from "@/lib/geometryFirst/globalStructuralSpans"
import {
  computeMainStructuralWallSvgContentBounds,
  contentBoundsHintFromGeometryOverlays,
  extendedOnlySplitSegments,
  isFiniteBox,
  unionSegmentBbox,
} from "@/lib/geometryFirst/debugMainStructuralWallSvg"
import type {
  MainStructuralWallSvgBuildResult,
  MainStructuralWallSvgDebugInput,
  MainStructuralWallSvgDebugMeta,
} from "@/lib/geometryFirst/debugMainStructuralWallSvg"

const DEBUG_DIR_NAME = "debug"
const DEFAULT_BASENAME = "last-pdf"
const DISPLAY_MAX_PX = 1600

const COLOR_BG = "#ffffff"
/** Cleaned candidates — light gray */
const COLOR_CLEANED_LIGHT = "#d0d0d0"
/** Strict structural (junction-split) strokes — dark */
const COLOR_STRUCTURAL_STRICT = "#1a237e"
const COLOR_EXTENDED_ONLY = "#00838f"
const COLOR_PAGE_BOUNDS = "#7b1fa2"
const COLOR_TEXT_BOX = "#9e9e9e"
const COLOR_CORNER_MARKER = "#e91e63"
/** Hypothesis centerlines by supportType */
const COLOR_HYP_PAIRED = "#6a1b9a"
const COLOR_HYP_MERGED = "#00695c"
const COLOR_HYP_SINGLETON = "#e65100"
/** Underlay for top hypotheses */
const COLOR_TOP_GLOW = "#ffc107"
const COLOR_LEGEND_TEXT = "#263238"
/** Layout-scale global structural spans (experimental overlay) */
const COLOR_GLOBAL_STRUCTURAL_SPAN = "#c2185b"
const COLOR_RAW_CLEANED_BBOX = "#e57373"
const COLOR_ROBUST_ENVELOPE = "#43a047"
const COLOR_OUTLIER_STROKE = "#ffab91"
const COLOR_DIAG_LARGEST_CLUSTER = "#0277bd"
const COLOR_DIAG_ROBUST_CORE = "#1b5e20"
const COLOR_DIAG_ENVELOPE_GUIDE = "#7cb342"
const COLOR_DIAG_EXCLUDED_LONG = "#d50000"
const COLOR_DIAG_EXCLUDED_OTHER = "#bdbdbd"

const SW_CLEANED = 1.75
const SW_STRUCTURAL = 3.25
const SW_EXTENDED_ONLY = 2.65
const SW_PAGE = 2.25
const SW_TEXT = 2
const SW_MARKER = 3.5
const SW_HYP_BASE = { paired: 5.2, "merged-run": 4.25, singleton: 3.85 } as const
const SW_TOP_GLOW_EXTRA = 5.5
const SW_GLOBAL_SPAN_BASE = 6.2
const SW_ROBUST_OVERLAY = 1.85
const SW_OUTLIER = 1.15
const SW_DIAG_RECT = 1.65
const SW_DIAG_LONG = 3.85
const SW_DIAG_OTHER = 1.35
const LABEL_MAX = 18
const TOP_HIGHLIGHT_COUNT = 7

function escapeXmlAttr(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
}

function expandedTextRect(
  t: import("@/lib/geometryFirst/types").ExtractedTextRun,
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
  opacity = 1,
  dash?: string
): string {
  const op = opacity < 1 ? ` opacity="${opacity}"` : ""
  const dashAttr = dash != null ? ` stroke-dasharray="${dash}"` : ""
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linecap="round" vector-effect="non-scaling-stroke"${dashAttr}${op}/>`
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

function scoreBucket(s: number): "lo" | "mid" | "hi" {
  if (s < 0.4) return "lo"
  if (s < 0.68) return "mid"
  return "hi"
}

function exteriorBucket(e: number): "lo" | "mid" | "hi" {
  if (e < 0.35) return "lo"
  if (e < 0.65) return "mid"
  return "hi"
}

function supportTypeLetter(t: ArchitecturalWallHypothesis["supportType"]): string {
  if (t === "paired") return "P"
  if (t === "merged-run") return "M"
  return "S"
}

function hypothesisColor(h: ArchitecturalWallHypothesis): string {
  if (h.supportType === "paired") return COLOR_HYP_PAIRED
  if (h.supportType === "merged-run") return COLOR_HYP_MERGED
  return COLOR_HYP_SINGLETON
}

function hypothesisStrokeWidth(h: ArchitecturalWallHypothesis, isTop: boolean): number {
  const base = SW_HYP_BASE[h.supportType]
  const thick =
    h.thicknessEstimate != null && h.thicknessEstimate > 0
      ? Math.min(4.2, h.thicknessEstimate * 0.25)
      : 0
  return base + thick + (isTop ? 0.9 : 0)
}

function centerlineMid(h: ArchitecturalWallHypothesis): { x: number; y: number } {
  const { x1, y1, x2, y2 } = h.centerline
  return { x: (x1 + x2) / 2, y: (y1 + y2) / 2 }
}

function labelOffsetPerp(h: ArchitecturalWallHypothesis, dist: number): { x: number; y: number } {
  const { x1, y1, x2, y2 } = h.centerline
  const dx = x2 - x1
  const dy = y2 - y1
  const len = Math.hypot(dx, dy)
  if (len < 1e-9) return { x: 0, y: dist }
  const nx = (-dy / len) * dist
  const ny = (dx / len) * dist
  return { x: nx, y: ny }
}

/** Counter-flip text so labels read upright in the browser. */
function flippedTextEl(
  x: number,
  y: number,
  text: string,
  fontSize: number,
  fill: string,
  anchor: "start" | "middle" = "middle"
): string {
  const ta = anchor === "middle" ? ` text-anchor="middle"` : ' text-anchor="start"'
  return `<g transform="translate(${x},${y}) scale(1,-1)"><text x="0" y="0" font-family="ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace" font-size="${fontSize}" fill="${fill}"${ta}>${escapeXmlAttr(
    text
  )}</text></g>`
}

function expandBoundsForCenterlines(
  bounds: import("@/lib/geometryFirst/types").PlanBoundingBox,
  hypotheses: ArchitecturalWallHypothesis[]
): import("@/lib/geometryFirst/types").PlanBoundingBox {
  if (hypotheses.length === 0) return bounds
  const segs = hypotheses.map((h) => ({
    x1: h.centerline.x1,
    y1: h.centerline.y1,
    x2: h.centerline.x2,
    y2: h.centerline.y2,
  }))
  const hb = unionSegmentBbox(segs)
  if (!hb || !isFiniteBox(hb)) return bounds
  return {
    minX: Math.min(bounds.minX, hb.minX),
    minY: Math.min(bounds.minY, hb.minY),
    maxX: Math.max(bounds.maxX, hb.maxX),
    maxY: Math.max(bounds.maxY, hb.maxY),
  }
}

function expandBoundsForGlobalSpans(
  bounds: import("@/lib/geometryFirst/types").PlanBoundingBox,
  spans: GlobalStructuralSpan[]
): import("@/lib/geometryFirst/types").PlanBoundingBox {
  if (spans.length === 0) return bounds
  const segs = spans.map((g) => ({
    x1: g.centerline.x1,
    y1: g.centerline.y1,
    x2: g.centerline.x2,
    y2: g.centerline.y2,
  }))
  const gb = unionSegmentBbox(segs)
  if (!gb || !isFiniteBox(gb)) return bounds
  return {
    minX: Math.min(bounds.minX, gb.minX),
    minY: Math.min(bounds.minY, gb.minY),
    maxX: Math.max(bounds.maxX, gb.maxX),
    maxY: Math.max(bounds.maxY, gb.maxY),
  }
}

function buildMeta(
  pageBounds: import("@/lib/geometryFirst/types").PlanBoundingBox,
  contentBounds: import("@/lib/geometryFirst/types").PlanBoundingBox,
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

export interface ArchitecturalWallHypothesesSvgDebugInput extends MainStructuralWallSvgDebugInput {
  hypotheses: ArchitecturalWallHypothesis[]
  /** Optional layout-scale span overlay (magenta), under local hypotheses. */
  globalStructuralSpans?: GlobalStructuralSpan[]
}

export interface ArchitecturalWallHypothesesSvgWriteOptions extends ArchitecturalWallHypothesesSvgDebugInput {
  projectRoot: string
  basename?: string
  /** Appended before `.svg`, e.g. `"-extended"` → `...-tower_6_B-extended.svg`. */
  filenameSuffix?: string
}

/**
 * Full-layer debug SVG: hypotheses as centerlines; cleaned + structural underlay.
 */
export function buildArchitecturalWallHypothesesSvgString(
  input: ArchitecturalWallHypothesesSvgDebugInput
): MainStructuralWallSvgBuildResult {
  const {
    cleanedSegments,
    mainStructuralSplitSegments,
    texts,
    pageBounds,
    hypotheses,
    sourceLabel,
    extendedStructuralSplitSegments,
    globalStructuralSpans: globalSpansInput,
    robustPlanExtentOverlay,
    drawingClusterDiagnosticsOverlay,
  } = input

  const extendedOnly = extendedOnlySplitSegments(extendedStructuralSplitSegments, mainStructuralSplitSegments)
  const globalSpans = globalSpansInput ?? []

  const outlierSet = robustPlanExtentOverlay
    ? new Set<number>(robustPlanExtentOverlay.outlierIndices)
    : null

  const cleanedBoundsHint = contentBoundsHintFromGeometryOverlays(
    drawingClusterDiagnosticsOverlay ?? null,
    robustPlanExtentOverlay ?? null
  )

  const { bounds: cb0, degenerateContentUsedPageFallback } = computeMainStructuralWallSvgContentBounds({
    pageBounds,
    cleanedSegments,
    mainStructuralSplitSegments,
    texts,
    cleanedBoundsOverride: cleanedBoundsHint,
  })
  let cb = expandBoundsForGlobalSpans(cb0, globalSpans)
  cb = expandBoundsForCenterlines(cb, hypotheses)

  const vbW = cb.maxX - cb.minX
  const vbH = cb.maxY - cb.minY
  const flipY = cb.minY + cb.maxY
  const { w: dispW, h: dispH } = computeDisplayPixels(vbW, vbH)

  const markerLen = Math.max(24, Math.min(vbW, vbH) * 0.02)
  const title = sourceLabel
    ? `${escapeXmlAttr(sourceLabel)} — wall hypotheses`
    : "geometry-first wall hypotheses"

  const sorted = [...hypotheses].sort((a, b) => b.supportScore - a.supportScore)
  const topIds = new Set(sorted.slice(0, TOP_HIGHLIGHT_COUNT).map((h) => h.id))

  const drawOrder = [...hypotheses].sort((a, b) => {
    const ord = (t: ArchitecturalWallHypothesis["supportType"]) =>
      t === "merged-run" ? 0 : t === "singleton" ? 1 : 2
    return ord(a.supportType) - ord(b.supportType) || a.id.localeCompare(b.id)
  })

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
      SW_PAGE,
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

  if (drawingClusterDiagnosticsOverlay) {
    const d = drawingClusterDiagnosticsOverlay
    const core = new Set(d.coreSegmentIndices)
    const longEx = new Set(d.excludedLongHighlightIndices)
    for (let ci = 0; ci < cleanedSegments.length; ci++) {
      const s = cleanedSegments[ci]!
      if (core.has(ci)) {
        parts.push(lineEl(s.x1, s.y1, s.x2, s.y2, COLOR_CLEANED_LIGHT, SW_CLEANED))
      } else if (longEx.has(ci)) {
        parts.push(lineEl(s.x1, s.y1, s.x2, s.y2, COLOR_DIAG_EXCLUDED_LONG, SW_DIAG_LONG, 0.95))
      } else {
        parts.push(lineEl(s.x1, s.y1, s.x2, s.y2, COLOR_DIAG_EXCLUDED_OTHER, SW_DIAG_OTHER, 0.38, "4 3"))
      }
    }
  } else {
    for (let ci = 0; ci < cleanedSegments.length; ci++) {
      if (outlierSet?.has(ci)) continue
      const s = cleanedSegments[ci]!
      parts.push(lineEl(s.x1, s.y1, s.x2, s.y2, COLOR_CLEANED_LIGHT, SW_CLEANED))
    }
    if (outlierSet && robustPlanExtentOverlay) {
      for (const ci of robustPlanExtentOverlay.outlierIndices) {
        const s = cleanedSegments[ci]
        if (!s) continue
        parts.push(lineEl(s.x1, s.y1, s.x2, s.y2, COLOR_OUTLIER_STROKE, SW_OUTLIER, 0.42, "4 3"))
      }
    }
  }

  for (const g of globalSpans) {
    const { x1, y1, x2, y2 } = g.centerline
    const sw = SW_GLOBAL_SPAN_BASE + 4 * g.shellHintScore + Math.min(2.5, g.sourceSegmentCount * 0.25)
    parts.push(lineEl(x1, y1, x2, y2, COLOR_GLOBAL_STRUCTURAL_SPAN, sw, 0.92, "2 6"))
  }

  for (const s of extendedOnly) {
    parts.push(lineEl(s.x1, s.y1, s.x2, s.y2, COLOR_EXTENDED_ONLY, SW_EXTENDED_ONLY, 1, "8 4"))
  }

  for (const s of mainStructuralSplitSegments) {
    parts.push(lineEl(s.x1, s.y1, s.x2, s.y2, COLOR_STRUCTURAL_STRICT, SW_STRUCTURAL))
  }

  for (const h of drawOrder) {
    const { x1, y1, x2, y2 } = h.centerline
    const isTop = topIds.has(h.id)
    const col = hypothesisColor(h)
    const sw = hypothesisStrokeWidth(h, isTop)
    if (isTop) {
      parts.push(lineEl(x1, y1, x2, y2, COLOR_TOP_GLOW, sw + SW_TOP_GLOW_EXTRA, 0.55))
    }
    parts.push(lineEl(x1, y1, x2, y2, col, sw))
  }

  const labelCandidates = sorted.slice(0, LABEL_MAX)
  for (const h of labelCandidates) {
    const mid = centerlineMid(h)
    const off = labelOffsetPerp(h, 11)
    const lx = mid.x + off.x
    const ly = mid.y + off.y
    const lbl = `${supportTypeLetter(h.supportType)}|${h.supportScore.toFixed(2)}|S:${scoreBucket(h.supportScore)}|E:${exteriorBucket(h.exteriorLikelihood)}${
      topIds.has(h.id) ? " ★" : ""
    }`
    parts.push(flippedTextEl(lx, ly, lbl, 7.2, topIds.has(h.id) ? COLOR_TOP_GLOW : COLOR_LEGEND_TEXT, "middle"))
  }

  for (const t of texts) {
    const b = expandedTextRect(t, 0)
    parts.push(rectStrokeEl(b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY, COLOR_TEXT_BOX, SW_TEXT))
  }

  parts.push(lineEl(cb.minX, cb.minY, cb.minX + markerLen, cb.minY, COLOR_CORNER_MARKER, SW_MARKER))
  parts.push(lineEl(cb.minX, cb.minY, cb.minX, cb.minY + markerLen, COLOR_CORNER_MARKER, SW_MARKER))

  const legX = cb.minX + 10
  let legY = cb.maxY - 12
  const legDy = 13
  const legFs = 9.5
  parts.push(flippedTextEl(legX, legY, "Legend: P=paired M=merged-run S=singleton | S:=supportScore lo/mid/hi | E:=exteriorLikelihood ★ top by score", legFs, COLOR_LEGEND_TEXT, "start"))
  legY -= legDy
  parts.push(
    flippedTextEl(
      legX,
      legY,
      `Colors — global spans ${COLOR_GLOBAL_STRUCTURAL_SPAN} (dot-dash) | paired ${COLOR_HYP_PAIRED} | merged ${COLOR_HYP_MERGED} | singleton ${COLOR_HYP_SINGLETON} | strict ${COLOR_STRUCTURAL_STRICT} | extended-only ${COLOR_EXTENDED_ONLY} | cleaned ${COLOR_CLEANED_LIGHT}`,
      legFs,
      COLOR_LEGEND_TEXT,
      "start"
    )
  )
  legY -= legDy
  parts.push(
    flippedTextEl(
      legX,
      legY,
      "Stroke widths: thicker paired lines add thicknessEstimate (PDF pt); gold underlay = top hypotheses.",
      8.5,
      COLOR_LEGEND_TEXT,
      "start"
    )
  )

  parts.push(`</g>`)
  parts.push(`</svg>`)

  return {
    svg: parts.join("\n"),
    debug: buildMeta(pageBounds, cb, degenerateContentUsedPageFallback, vbW, vbH, dispW, dispH, flipY),
  }
}

/**
 * Writes `debug/geometry-first-wall-hypotheses-{basename}.svg`.
 */
export function writeArchitecturalWallHypothesesSvg(opts: ArchitecturalWallHypothesesSvgWriteOptions): string {
  const basename = (opts.basename ?? DEFAULT_BASENAME).replace(/[^a-zA-Z0-9._-]+/g, "_")
  const suffix = opts.filenameSuffix ?? ""
  const dir = path.join(opts.projectRoot, DEBUG_DIR_NAME)
  fs.mkdirSync(dir, { recursive: true })
  const outPath = path.join(dir, `geometry-first-wall-hypotheses-${basename}${suffix}.svg`)

  const full = buildArchitecturalWallHypothesesSvgString(opts)
  logDebugMeta("geometry-first-wall-hypotheses-svg", full.debug)
  fs.writeFileSync(outPath, full.svg, "utf8")

  console.log(`Wall hypotheses debug SVG: ${outPath}`)
  return outPath
}
