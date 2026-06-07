import type { ExtractedLineSegment, PlanBoundingBox } from "@/lib/geometryFirst/types"
import { renderPdfPageForAiSemanticHints } from "@/lib/geometryFirst/floorplanAiSemanticHints"

type Pt = { x: number; y: number }

interface Grid {
  minX: number
  minY: number
  cell: number
  gw: number
  gh: number
}

interface PixelRect {
  x: number
  y: number
  width: number
  height: number
}

interface ComponentStats {
  id: number
  cells: number[]
  cellCount: number
  bbox: PlanBoundingBox
  insideUnitCellCount: number
  shellTouchCount: number
}

export interface GrayWallMassComponentV1 {
  componentId: string
  polygon: Pt[]
  areaPt2: number
  cellCount: number
  insideUnitFraction: number
  shellTouchFraction: number
}

export interface GrayWallBandV1 {
  bandId: string
  polygon: Pt[]
  areaPt2: number
  sourceComponentIds: string[]
}

export interface GrayWallRoomVoidV1 {
  voidId: string
  polygon: Pt[]
  center: Pt
  areaPt2: number
  cellCount: number
  roomLike: boolean
}

export interface GrayWallMassReconstructionV1Debug {
  grayWallMassReconstructionV1: {
    renderWidthPx: number
    renderHeightPx: number
    cropWidthPx: number
    cropHeightPx: number
    darkThreshold: number
    gridCellSizePt: number
    darkComponentCount: number
    recoveredWallBandCount: number
    recoveredRoomVoidCount: number
    maskDerivedSegmentCount: number
  }
  pageIndex: number
  renderPx: { width: number; height: number }
  cropRectPx: PixelRect
  wallMaskBounds: PlanBoundingBox
  darkWallComponents: GrayWallMassComponentV1[]
  recoveredWallBands: GrayWallBandV1[]
  recoveredRoomVoids: GrayWallRoomVoidV1[]
  maskDerivedSegments: ExtractedLineSegment[]
  structureStatement: string
  notes: string[]
}

export interface BuildGrayWallMassReconstructionV1Options {
  pdfBytes: Uint8Array
  pageIndex?: number
  mainPlanBodyBBox?: PlanBoundingBox | null
  effectiveUnitPolygon?: Pt[] | null
  renderScale?: number
  maxEdgePx?: number
}

export interface BuildGrayWallMassReconstructionV1SvgOptions {
  pageBounds: PlanBoundingBox
  reconstruction: GrayWallMassReconstructionV1Debug
  unitPolygon?: Pt[] | null
  originalSegments?: ExtractedLineSegment[]
}

const OPT = {
  cropPadPt: 24,
  gridCellPt: 2.5,
  shellTouchDistPt: 9,
  minComponentCells: 10,
  minLargeComponentCells: 26,
  minVoidCells: 18,
  wallCloseRadius: 1,
  wallDilateForVoids: 1,
  minSegmentLenPt: 7,
  darkPreviewMin: 96,
  darkPreviewMax: 236,
} as const

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x))
}

function cellIdx(i: number, j: number, gw: number): number {
  return j * gw + i
}

function pointInPoly(pt: Pt, poly: Pt[]): boolean {
  if (poly.length < 3) return false
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!
    const b = poly[j]!
    const intersect =
      a.y > pt.y !== b.y > pt.y &&
      pt.x < ((b.x - a.x) * (pt.y - a.y)) / Math.max(1e-6, b.y - a.y) + a.x
    if (intersect) inside = !inside
  }
  return inside
}

function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function distancePointToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const denom = dx * dx + dy * dy
  if (denom < 1e-6) return dist(p, a)
  const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / denom, 0, 1)
  return dist(p, { x: a.x + t * dx, y: a.y + t * dy })
}

function distanceToPolyBoundary(p: Pt, poly: Pt[]): number {
  if (poly.length < 2) return Infinity
  let best = Infinity
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!
    const b = poly[(i + 1) % poly.length]!
    best = Math.min(best, distancePointToSegment(p, a, b))
  }
  return best
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

function unionBoxes(a: PlanBoundingBox, b: PlanBoundingBox): PlanBoundingBox {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  }
}

function expandBox(b: PlanBoundingBox, pad: number, pageBounds: PlanBoundingBox): PlanBoundingBox {
  return {
    minX: clamp(b.minX - pad, pageBounds.minX, pageBounds.maxX),
    minY: clamp(b.minY - pad, pageBounds.minY, pageBounds.maxY),
    maxX: clamp(b.maxX + pad, pageBounds.minX, pageBounds.maxX),
    maxY: clamp(b.maxY + pad, pageBounds.minY, pageBounds.maxY),
  }
}

function polygonArea(poly: Pt[]): number {
  if (poly.length < 3) return 0
  let acc = 0
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!
    const b = poly[(i + 1) % poly.length]!
    acc += a.x * b.y - b.x * a.y
  }
  return Math.abs(acc / 2)
}

function centerOfBox(b: PlanBoundingBox): Pt {
  return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }
}

function boxToPoly(b: PlanBoundingBox): Pt[] {
  return [
    { x: b.minX, y: b.minY },
    { x: b.maxX, y: b.minY },
    { x: b.maxX, y: b.maxY },
    { x: b.minX, y: b.maxY },
  ]
}

function makeGrid(bounds: PlanBoundingBox): Grid {
  const cell = OPT.gridCellPt
  return {
    minX: bounds.minX,
    minY: bounds.minY,
    cell,
    gw: Math.max(8, Math.ceil((bounds.maxX - bounds.minX) / cell)),
    gh: Math.max(8, Math.ceil((bounds.maxY - bounds.minY) / cell)),
  }
}

function cellCenter(i: number, j: number, g: Grid): Pt {
  return {
    x: g.minX + (i + 0.5) * g.cell,
    y: g.minY + (j + 0.5) * g.cell,
  }
}

function componentBounds(cells: number[], g: Grid): PlanBoundingBox {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const idx of cells) {
    const i = idx % g.gw
    const j = Math.floor(idx / g.gw)
    const x0 = g.minX + i * g.cell
    const y0 = g.minY + j * g.cell
    const x1 = x0 + g.cell
    const y1 = y0 + g.cell
    minX = Math.min(minX, x0)
    minY = Math.min(minY, y0)
    maxX = Math.max(maxX, x1)
    maxY = Math.max(maxY, y1)
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 1, maxY: 1 }
  return { minX, minY, maxX, maxY }
}

function pdfPointToRender(pt: Pt, pageBounds: PlanBoundingBox, renderPx: { width: number; height: number }): Pt {
  const pdfWidth = Math.max(1, pageBounds.maxX - pageBounds.minX)
  const pdfHeight = Math.max(1, pageBounds.maxY - pageBounds.minY)
  return {
    x: ((pt.x - pageBounds.minX) / pdfWidth) * renderPx.width,
    y: ((pt.y - pageBounds.minY) / pdfHeight) * renderPx.height,
  }
}

function pdfBoxToRenderRect(b: PlanBoundingBox, pageBounds: PlanBoundingBox, renderPx: { width: number; height: number }): PixelRect {
  const a = pdfPointToRender({ x: b.minX, y: b.minY }, pageBounds, renderPx)
  const c = pdfPointToRender({ x: b.maxX, y: b.maxY }, pageBounds, renderPx)
  const x = clamp(Math.floor(Math.min(a.x, c.x)), 0, renderPx.width - 1)
  const y = clamp(Math.floor(Math.min(a.y, c.y)), 0, renderPx.height - 1)
  const right = clamp(Math.ceil(Math.max(a.x, c.x)), x + 1, renderPx.width)
  const bottom = clamp(Math.ceil(Math.max(a.y, c.y)), y + 1, renderPx.height)
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) }
}

function pdfPointToCropPixel(pt: Pt, cropBoxPdf: PlanBoundingBox, cropPx: PixelRect): Pt {
  return {
    x: ((pt.x - cropBoxPdf.minX) / Math.max(1e-6, cropBoxPdf.maxX - cropBoxPdf.minX)) * cropPx.width,
    y: ((pt.y - cropBoxPdf.minY) / Math.max(1e-6, cropBoxPdf.maxY - cropBoxPdf.minY)) * cropPx.height,
  }
}

function lumaAt(raw: Uint8Array, width: number, height: number, channels: number, x: number, y: number): number {
  const xi = clamp(Math.round(x), 0, width - 1)
  const yi = clamp(Math.round(y), 0, height - 1)
  const idx = (yi * width + xi) * channels
  const r = raw[idx] ?? 255
  const g = raw[idx + 1] ?? r
  const b = raw[idx + 2] ?? r
  return Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b)
}

function otsuThreshold(values: Uint8Array): number {
  const hist = new Uint32Array(256)
  for (const v of values) hist[v]++
  const total = values.length
  let sum = 0
  for (let i = 0; i < 256; i++) sum += i * hist[i]!
  let sumB = 0
  let weightB = 0
  let bestVar = -1
  let threshold = 185
  for (let t = 0; t < 256; t++) {
    weightB += hist[t]!
    if (weightB === 0) continue
    const weightF = total - weightB
    if (weightF === 0) break
    sumB += t * hist[t]!
    const meanB = sumB / weightB
    const meanF = (sum - sumB) / weightF
    const between = weightB * weightF * (meanB - meanF) * (meanB - meanF)
    if (between > bestVar) {
      bestVar = between
      threshold = t
    }
  }
  return clamp(threshold, OPT.darkPreviewMin, OPT.darkPreviewMax)
}

function morphDilate(mask: Uint8Array, g: Grid, radius: number): Uint8Array {
  if (radius <= 0) return mask.slice()
  const out = new Uint8Array(mask.length)
  const r2 = radius * radius
  for (let j = 0; j < g.gh; j++) {
    for (let i = 0; i < g.gw; i++) {
      let hit = 0
      for (let dj = -radius; dj <= radius && !hit; dj++) {
        for (let di = -radius; di <= radius; di++) {
          if (di * di + dj * dj > r2) continue
          const ii = i + di
          const jj = j + dj
          if (ii < 0 || jj < 0 || ii >= g.gw || jj >= g.gh) continue
          if (mask[cellIdx(ii, jj, g.gw)]) {
            hit = 1
            break
          }
        }
      }
      if (hit) out[cellIdx(i, j, g.gw)] = 1
    }
  }
  return out
}

function morphErode(mask: Uint8Array, g: Grid, radius: number): Uint8Array {
  if (radius <= 0) return mask.slice()
  const out = new Uint8Array(mask.length)
  const r2 = radius * radius
  for (let j = 0; j < g.gh; j++) {
    for (let i = 0; i < g.gw; i++) {
      let keep = 1
      for (let dj = -radius; dj <= radius && keep; dj++) {
        for (let di = -radius; di <= radius; di++) {
          if (di * di + dj * dj > r2) continue
          const ii = i + di
          const jj = j + dj
          if (ii < 0 || jj < 0 || ii >= g.gw || jj >= g.gh || !mask[cellIdx(ii, jj, g.gw)]) {
            keep = 0
            break
          }
        }
      }
      if (keep) out[cellIdx(i, j, g.gw)] = 1
    }
  }
  return out
}

function morphClose(mask: Uint8Array, g: Grid, radius: number): Uint8Array {
  return morphErode(morphDilate(mask, g, radius), g, radius)
}

function labelComponents(mask: Uint8Array, g: Grid, allowed?: Uint8Array): ComponentStats[] {
  const seen = new Uint8Array(mask.length)
  const out: ComponentStats[] = []
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const
  let nextId = 1
  for (let j = 0; j < g.gh; j++) {
    for (let i = 0; i < g.gw; i++) {
      const start = cellIdx(i, j, g.gw)
      if (!mask[start] || seen[start] || (allowed && !allowed[start])) continue
      const q = [start]
      const cells: number[] = []
      seen[start] = 1
      while (q.length) {
        const cur = q.pop()!
        cells.push(cur)
        const ci = cur % g.gw
        const cj = Math.floor(cur / g.gw)
        for (const [di, dj] of dirs) {
          const ii = ci + di
          const jj = cj + dj
          if (ii < 0 || jj < 0 || ii >= g.gw || jj >= g.gh) continue
          const nxt = cellIdx(ii, jj, g.gw)
          if (!mask[nxt] || seen[nxt] || (allowed && !allowed[nxt])) continue
          seen[nxt] = 1
          q.push(nxt)
        }
      }
      out.push({
        id: nextId++,
        cells,
        cellCount: cells.length,
        bbox: componentBounds(cells, g),
        insideUnitCellCount: 0,
        shellTouchCount: 0,
      })
    }
  }
  return out
}

function mergeSegments(segments: ExtractedLineSegment[]): ExtractedLineSegment[] {
  const horizontal = new Map<string, Array<{ from: number; to: number }>>()
  const vertical = new Map<string, Array<{ from: number; to: number }>>()
  for (const s of segments) {
    if (Math.abs(s.y1 - s.y2) <= 1e-3) {
      const y = s.y1.toFixed(3)
      const arr = horizontal.get(y) ?? []
      arr.push({ from: Math.min(s.x1, s.x2), to: Math.max(s.x1, s.x2) })
      horizontal.set(y, arr)
    } else if (Math.abs(s.x1 - s.x2) <= 1e-3) {
      const x = s.x1.toFixed(3)
      const arr = vertical.get(x) ?? []
      arr.push({ from: Math.min(s.y1, s.y2), to: Math.max(s.y1, s.y2) })
      vertical.set(x, arr)
    }
  }
  const out: ExtractedLineSegment[] = []
  for (const [yKey, rows] of horizontal) {
    rows.sort((a, b) => a.from - b.from)
    let cur = rows[0]
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i]!
      if (row.from <= cur.to + 0.75) cur.to = Math.max(cur.to, row.to)
      else {
        if (cur.to - cur.from >= OPT.minSegmentLenPt) {
          out.push({ x1: cur.from, y1: Number(yKey), x2: cur.to, y2: Number(yKey), source: "raster-cv" })
        }
        cur = row
      }
    }
    if (cur && cur.to - cur.from >= OPT.minSegmentLenPt) {
      out.push({ x1: cur.from, y1: Number(yKey), x2: cur.to, y2: Number(yKey), source: "raster-cv" })
    }
  }
  for (const [xKey, cols] of vertical) {
    cols.sort((a, b) => a.from - b.from)
    let cur = cols[0]
    for (let i = 1; i < cols.length; i++) {
      const col = cols[i]!
      if (col.from <= cur.to + 0.75) cur.to = Math.max(cur.to, col.to)
      else {
        if (cur.to - cur.from >= OPT.minSegmentLenPt) {
          out.push({ x1: Number(xKey), y1: cur.from, x2: Number(xKey), y2: cur.to, source: "raster-cv" })
        }
        cur = col
      }
    }
    if (cur && cur.to - cur.from >= OPT.minSegmentLenPt) {
      out.push({ x1: Number(xKey), y1: cur.from, x2: Number(xKey), y2: cur.to, source: "raster-cv" })
    }
  }
  const dedup = new Map<string, ExtractedLineSegment>()
  for (const s of out) {
    const key = `${s.x1.toFixed(2)}:${s.y1.toFixed(2)}:${s.x2.toFixed(2)}:${s.y2.toFixed(2)}`
    dedup.set(key, s)
  }
  return [...dedup.values()]
}

function boundarySegmentsFromMask(mask: Uint8Array, g: Grid): ExtractedLineSegment[] {
  const raw: ExtractedLineSegment[] = []
  for (let j = 0; j < g.gh; j++) {
    for (let i = 0; i < g.gw; i++) {
      if (!mask[cellIdx(i, j, g.gw)]) continue
      const x0 = g.minX + i * g.cell
      const x1 = x0 + g.cell
      const y0 = g.minY + j * g.cell
      const y1 = y0 + g.cell
      const left = i === 0 ? 0 : mask[cellIdx(i - 1, j, g.gw)]
      const right = i === g.gw - 1 ? 0 : mask[cellIdx(i + 1, j, g.gw)]
      const up = j === 0 ? 0 : mask[cellIdx(i, j - 1, g.gw)]
      const down = j === g.gh - 1 ? 0 : mask[cellIdx(i, j + 1, g.gw)]
      if (!left) raw.push({ x1: x0, y1: y0, x2: x0, y2: y1, source: "raster-cv" })
      if (!right) raw.push({ x1, y1: y0, x2: x1, y2: y1, source: "raster-cv" })
      if (!up) raw.push({ x1: x0, y1: y0, x2: x1, y2: y0, source: "raster-cv" })
      if (!down) raw.push({ x1: x0, y1, x2: x1, y2: y1, source: "raster-cv" })
    }
  }
  return mergeSegments(raw)
}

function chooseCropBounds(
  pageBounds: PlanBoundingBox,
  unitPolygon: Pt[],
  mainPlanBodyBBox?: PlanBoundingBox | null
): PlanBoundingBox {
  let box = mainPlanBodyBBox ?? pageBounds
  if (unitPolygon.length >= 3) box = unionBoxes(box, bboxOfPoly(unitPolygon))
  return expandBox(box, OPT.cropPadPt, pageBounds)
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;")
}

function pathFromPoly(poly: Pt[], close: boolean): string {
  if (poly.length < 2) return ""
  let d = `M ${poly[0]!.x.toFixed(2)} ${poly[0]!.y.toFixed(2)}`
  for (let i = 1; i < poly.length; i++) d += ` L ${poly[i]!.x.toFixed(2)} ${poly[i]!.y.toFixed(2)}`
  if (close) d += " Z"
  return d
}

export async function buildGrayWallMassReconstructionV1(
  opts: BuildGrayWallMassReconstructionV1Options
): Promise<GrayWallMassReconstructionV1Debug> {
  const rendered = await renderPdfPageForAiSemanticHints(opts.pdfBytes, {
    pageIndex: opts.pageIndex ?? 0,
    renderScale: opts.renderScale ?? 2,
    maxEdgePx: opts.maxEdgePx ?? 2200,
  })
  const unitPolygon = opts.effectiveUnitPolygon?.length ? opts.effectiveUnitPolygon.map((p) => ({ x: p.x, y: p.y })) : []
  const cropBoxPdf = chooseCropBounds(rendered.pageBounds, unitPolygon, opts.mainPlanBodyBBox)
  const cropRectPx = pdfBoxToRenderRect(cropBoxPdf, rendered.pageBounds, rendered.renderPx)
  const sharp = (await import("sharp")).default
  const cropRaw = await sharp(rendered.imageBuffer)
    .extract({
      left: cropRectPx.x,
      top: cropRectPx.y,
      width: cropRectPx.width,
      height: cropRectPx.height,
    })
    .raw()
    .toBuffer({ resolveWithObject: true })

  const raw = new Uint8Array(cropRaw.data)
  const luma = new Uint8Array(cropRectPx.width * cropRectPx.height)
  for (let y = 0; y < cropRectPx.height; y++) {
    for (let x = 0; x < cropRectPx.width; x++) {
      luma[y * cropRectPx.width + x] = lumaAt(raw, cropRectPx.width, cropRectPx.height, cropRaw.info.channels, x, y)
    }
  }
  const darkThreshold = otsuThreshold(luma)
  const g = makeGrid(cropBoxPdf)
  const darkMask = new Uint8Array(g.gw * g.gh)
  const insideUnitMask = new Uint8Array(g.gw * g.gh)

  for (let j = 0; j < g.gh; j++) {
    for (let i = 0; i < g.gw; i++) {
      const center = cellCenter(i, j, g)
      const cropPt = pdfPointToCropPixel(center, cropBoxPdf, cropRectPx)
      const sample =
        (lumaAt(raw, cropRectPx.width, cropRectPx.height, cropRaw.info.channels, cropPt.x, cropPt.y) +
          lumaAt(raw, cropRectPx.width, cropRectPx.height, cropRaw.info.channels, cropPt.x - 1, cropPt.y) +
          lumaAt(raw, cropRectPx.width, cropRectPx.height, cropRaw.info.channels, cropPt.x + 1, cropPt.y) +
          lumaAt(raw, cropRectPx.width, cropRectPx.height, cropRaw.info.channels, cropPt.x, cropPt.y - 1) +
          lumaAt(raw, cropRectPx.width, cropRectPx.height, cropRaw.info.channels, cropPt.x, cropPt.y + 1)) / 5
      const idx = cellIdx(i, j, g.gw)
      if (sample <= darkThreshold) darkMask[idx] = 1
      if (!unitPolygon.length || pointInPoly(center, unitPolygon)) insideUnitMask[idx] = 1
    }
  }

  const darkClosed = morphClose(darkMask, g, OPT.wallCloseRadius)
  const darkComponents = labelComponents(darkClosed, g)
  const selectedMask = new Uint8Array(darkClosed.length)
  const keptComponents: GrayWallMassComponentV1[] = []

  for (const comp of darkComponents) {
    let insideCount = 0
    let shellTouchCount = 0
    for (const idx of comp.cells) {
      const i = idx % g.gw
      const j = Math.floor(idx / g.gw)
      const center = cellCenter(i, j, g)
      if (!unitPolygon.length || pointInPoly(center, unitPolygon)) insideCount++
      if (unitPolygon.length >= 3 && distanceToPolyBoundary(center, unitPolygon) <= OPT.shellTouchDistPt) shellTouchCount++
    }
    comp.insideUnitCellCount = insideCount
    comp.shellTouchCount = shellTouchCount
    const insideFrac = insideCount / Math.max(1, comp.cellCount)
    const shellFrac = shellTouchCount / Math.max(1, comp.cellCount)
    const keep =
      comp.cellCount >= OPT.minComponentCells &&
      (shellTouchCount > 0 || insideCount >= OPT.minLargeComponentCells || insideFrac >= 0.45)
    if (!keep) continue
    for (const idx of comp.cells) selectedMask[idx] = 1
    keptComponents.push({
      componentId: `wall-comp-${comp.id}`,
      polygon: boxToPoly(comp.bbox),
      areaPt2: comp.cellCount * g.cell * g.cell,
      cellCount: comp.cellCount,
      insideUnitFraction: insideFrac,
      shellTouchFraction: shellFrac,
    })
  }

  const wallMaskBounds = keptComponents.length
    ? keptComponents.reduce((acc, c) => unionBoxes(acc, bboxOfPoly(c.polygon)), bboxOfPoly(keptComponents[0]!.polygon))
    : cropBoxPdf
  const maskDerivedSegments = boundarySegmentsFromMask(selectedMask, g)
  const dilatedWalls = morphDilate(selectedMask, g, OPT.wallDilateForVoids)
  const voidSeedMask = new Uint8Array(dilatedWalls.length)
  for (let idx = 0; idx < voidSeedMask.length; idx++) {
    if (insideUnitMask[idx] && !dilatedWalls[idx]) voidSeedMask[idx] = 1
  }
  const voidComponentsRaw = labelComponents(voidSeedMask, g, insideUnitMask)
  const recoveredRoomVoids: GrayWallRoomVoidV1[] = []
  for (const comp of voidComponentsRaw) {
    if (comp.cellCount < OPT.minVoidCells) continue
    const box = comp.bbox
    const w = box.maxX - box.minX
    const h = box.maxY - box.minY
    const roomLike = w >= 14 && h >= 14 && Math.min(w, h) >= 8
    recoveredRoomVoids.push({
      voidId: `void-${comp.id}`,
      polygon: boxToPoly(box),
      center: centerOfBox(box),
      areaPt2: comp.cellCount * g.cell * g.cell,
      cellCount: comp.cellCount,
      roomLike,
    })
  }
  recoveredRoomVoids.sort((a, b) => b.areaPt2 - a.areaPt2)

  const recoveredWallBands: GrayWallBandV1[] = keptComponents.map((comp, idx) => ({
    bandId: `band-${idx + 1}`,
    polygon: comp.polygon.map((p) => ({ x: p.x, y: p.y })),
    areaPt2: comp.areaPt2,
    sourceComponentIds: [comp.componentId],
  }))

  const notes: string[] = []
  notes.push(`Gray wall threshold used Otsu luminance split at ${darkThreshold}/255 on a ${cropRectPx.width}×${cropRectPx.height} crop.`)
  if (unitPolygon.length >= 3) {
    notes.push(`Wall-mask crop was seeded by the current authoritative unit shell and main-plan body bbox.`)
  }
  notes.push(`Recovered ${maskDerivedSegments.length} raster-derived wall-edge segment(s) and ${recoveredRoomVoids.length} interior void region(s).`)

  return {
    grayWallMassReconstructionV1: {
      renderWidthPx: rendered.renderPx.width,
      renderHeightPx: rendered.renderPx.height,
      cropWidthPx: cropRectPx.width,
      cropHeightPx: cropRectPx.height,
      darkThreshold,
      gridCellSizePt: g.cell,
      darkComponentCount: keptComponents.length,
      recoveredWallBandCount: recoveredWallBands.length,
      recoveredRoomVoidCount: recoveredRoomVoids.length,
      maskDerivedSegmentCount: maskDerivedSegments.length,
    },
    pageIndex: rendered.pageIndex,
    renderPx: rendered.renderPx,
    cropRectPx,
    wallMaskBounds,
    darkWallComponents: keptComponents,
    recoveredWallBands,
    recoveredRoomVoids,
    maskDerivedSegments,
    structureStatement:
      `Gray wall mass reconstruction v1: ${keptComponents.length} dark wall component(s), ` +
      `${maskDerivedSegments.length} mask-derived wall segment(s), ${recoveredRoomVoids.length} interior void region(s).`,
    notes,
  }
}

export async function buildGrayWallMassThresholdPreviewPng(
  pdfBytes: Uint8Array,
  reconstruction: GrayWallMassReconstructionV1Debug
): Promise<Buffer> {
  const rendered = await renderPdfPageForAiSemanticHints(pdfBytes, {
    pageIndex: reconstruction.pageIndex,
    renderScale: 2,
    maxEdgePx: Math.max(reconstruction.renderPx.width, reconstruction.renderPx.height),
  })
  const crop = reconstruction.cropRectPx
  const sharp = (await import("sharp")).default
  const raw = await sharp(rendered.imageBuffer)
    .extract({
      left: crop.x,
      top: crop.y,
      width: crop.width,
      height: crop.height,
    })
    .raw()
    .toBuffer({ resolveWithObject: true })
  const out = Buffer.alloc(crop.width * crop.height * 4)
  for (let y = 0; y < crop.height; y++) {
    for (let x = 0; x < crop.width; x++) {
      const idx = (y * crop.width + x) * raw.info.channels
      const rgba = (y * crop.width + x) * 4
      const r = raw.data[idx] ?? 255
      const g = raw.data[idx + 1] ?? r
      const b = raw.data[idx + 2] ?? r
      const lum = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b)
      const wall = lum <= reconstruction.grayWallMassReconstructionV1.darkThreshold
      out[rgba] = wall ? 48 : lum
      out[rgba + 1] = wall ? 48 : lum
      out[rgba + 2] = wall ? 48 : lum
      out[rgba + 3] = 255
    }
  }
  return await sharp(out, {
    raw: {
      width: crop.width,
      height: crop.height,
      channels: 4,
    },
  })
    .png()
    .toBuffer()
}

export function buildGrayWallMassReconstructionV1SvgString(
  opts: BuildGrayWallMassReconstructionV1SvgOptions
): string {
  const { pageBounds, reconstruction, unitPolygon, originalSegments } = opts
  const width = Math.max(1, pageBounds.maxX - pageBounds.minX)
  const height = Math.max(1, pageBounds.maxY - pageBounds.minY)
  const segs = reconstruction.maskDerivedSegments
    .map(
      (s) =>
        `<line x1="${s.x1.toFixed(2)}" y1="${s.y1.toFixed(2)}" x2="${s.x2.toFixed(2)}" y2="${s.y2.toFixed(2)}" stroke="#3f3f46" stroke-width="1.6" />`
    )
    .join("\n")
  const originals = (originalSegments ?? [])
    .map(
      (s) =>
        `<line x1="${s.x1.toFixed(2)}" y1="${s.y1.toFixed(2)}" x2="${s.x2.toFixed(2)}" y2="${s.y2.toFixed(2)}" stroke="rgba(148,163,184,0.26)" stroke-width="0.8" />`
    )
    .join("\n")
  const components = reconstruction.recoveredWallBands
    .map(
      (band) =>
        `<path d="${pathFromPoly(band.polygon, true)}" fill="rgba(63,63,70,0.14)" stroke="rgba(63,63,70,0.55)" stroke-dasharray="5 4" stroke-width="1.2" />`
    )
    .join("\n")
  const voids = reconstruction.recoveredRoomVoids
    .map(
      (v) =>
        `<g><path d="${pathFromPoly(v.polygon, true)}" fill="${v.roomLike ? "rgba(59,130,246,0.08)" : "rgba(14,165,233,0.04)"}" stroke="${v.roomLike ? "#2563eb" : "#0891b2"}" stroke-width="1.0" stroke-dasharray="4 3" />` +
        `<circle cx="${v.center.x.toFixed(2)}" cy="${v.center.y.toFixed(2)}" r="2.2" fill="${v.roomLike ? "#2563eb" : "#0891b2"}" /></g>`
    )
    .join("\n")
  const unit = unitPolygon?.length
    ? `<path d="${pathFromPoly(unitPolygon, true)}" fill="none" stroke="rgba(34,197,94,0.75)" stroke-width="1.4" />`
    : ""
  const label = escapeXml(reconstruction.structureStatement)
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="${pageBounds.minX} ${pageBounds.minY} ${width.toFixed(2)} ${height.toFixed(2)}">
  <rect x="${pageBounds.minX}" y="${pageBounds.minY}" width="${width.toFixed(2)}" height="${height.toFixed(2)}" fill="#ffffff" />
  ${originals}
  ${components}
  ${unit}
  ${segs}
  ${voids}
  <text x="${(pageBounds.minX + 12).toFixed(2)}" y="${(pageBounds.minY + 18).toFixed(2)}" font-size="12" fill="#111827">${label}</text>
</svg>`
}
