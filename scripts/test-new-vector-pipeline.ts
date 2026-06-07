/**
 * Test the lib/pdfVectorStructuralAnalysis.ts pipeline against a cached primitives JSON
 * (output of scripts/debug-pdf-structure.ts) and write a comparison SVG so we can eyeball
 * the recovered outline + classified walls + windows + doors without needing the original PDF.
 *
 * The cached JSON skips PDF.js extraction; we feed primitives directly into the lib's inner
 * `analyzePdfVectorPrimitivesPage` function so this script always runs the same algorithm
 * the production API does — no algorithm duplication.
 *
 * Usage:
 *   npx tsx scripts/test-new-vector-pipeline.ts [debug/<base>-primitives.json]
 */
import * as fs from "node:fs"
import * as path from "node:path"

import {
  analyzePdfVectorPrimitivesPage,
  type PdfVectorPagePrimitives,
} from "../lib/pdfVectorStructuralAnalysis"
import type { FloorplanPoint2D } from "../lib/types"
import { polygonAABB } from "../lib/floorplanGeometry"

type Line = { x1: number; y1: number; x2: number; y2: number; source?: string }
type TextRun = {
  text: string
  x: number
  y: number
  pageIndex: number
  width?: number
  height?: number
}
type BBox = { minX: number; minY: number; maxX: number; maxY: number }

interface CachedPage {
  pageIndex: number
  pageBounds: BBox
  extractionMode: string
  lines: Line[]
  texts: TextRun[]
}

interface CachedPrimitives {
  pdfPath?: string
  pages: CachedPage[]
}

function escapeXml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
}

function bboxFromLines(lines: Line[]): BBox | null {
  if (!lines.length) return null
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const l of lines) {
    minX = Math.min(minX, l.x1, l.x2)
    minY = Math.min(minY, l.y1, l.y2)
    maxX = Math.max(maxX, l.x1, l.x2)
    maxY = Math.max(maxY, l.y1, l.y2)
  }
  return { minX, minY, maxX, maxY }
}

function expand(box: BBox, p: number): BBox {
  return { minX: box.minX - p, minY: box.minY - p, maxX: box.maxX + p, maxY: box.maxY + p }
}

/** Map a metric (centered-AABB) point back to PDF pt space using the analysis's apartmentBox. */
function metricToPdf(
  p: FloorplanPoint2D,
  apartmentBox: BBox,
  targetW: number,
  targetH: number
): { x: number; y: number } {
  const aw = apartmentBox.maxX - apartmentBox.minX
  const ah = apartmentBox.maxY - apartmentBox.minY
  // Inverse of mapPoint() in the lib (which flips Y).
  return {
    x: apartmentBox.minX + ((p.x + targetW / 2) / targetW) * aw,
    y: apartmentBox.maxY - ((p.y + targetH / 2) / targetH) * ah,
  }
}

async function main() {
  const inputPath = process.argv[2] ?? "debug/tower_41_ph3w-primitives.json"
  const abs = path.resolve(process.cwd(), inputPath)
  if (!fs.existsSync(abs)) {
    console.error(`Input not found: ${abs}`)
    process.exit(1)
  }
  const data = JSON.parse(fs.readFileSync(abs, "utf-8")) as CachedPrimitives
  const page = data.pages[0]

  // Run the EXACT lib pipeline on the cached primitives.
  const aiLong = 30 // arbitrary metric scale for SVG drawing; calibration adjusts later
  const result = analyzePdfVectorPrimitivesPage(page as PdfVectorPagePrimitives, {
    targetWidth: aiLong,
    targetDepth: aiLong,
  })
  if (!result) {
    console.error("analyzePdfVectorPrimitivesPage returned null")
    process.exit(2)
  }

  const apartmentBox = result.apartmentBoxPdf
  const aw = apartmentBox.maxX - apartmentBox.minX
  const ah = apartmentBox.maxY - apartmentBox.minY
  const aspect = aw / Math.max(ah, 1e-6)
  const targetW = aspect >= 1 ? aiLong : aiLong * aspect
  const targetH = aspect >= 1 ? aiLong / aspect : aiLong
  const ptToM = targetW / aw

  // Re-project the metric outputs back to PDF pt space for the SVG (so we can overlay on raw lines).
  const polygonPdf = result.geometry.footprintPolygon.map((p) =>
    metricToPdf(p, apartmentBox, targetW, targetH)
  )
  const wallsPdf = (result.geometry.interiorWalls ?? []).map((w) => {
    const a = metricToPdf({ x: w.x1, y: w.y1 }, apartmentBox, targetW, targetH)
    const b = metricToPdf({ x: w.x2, y: w.y2 }, apartmentBox, targetW, targetH)
    return { ...w, ax: a.x, ay: a.y, bx: b.x, by: b.y }
  })
  const windowsPdf = (result.geometry.windowOpenings ?? []).map((wn) => {
    const a = metricToPdf({ x: wn.x1, y: wn.y1 }, apartmentBox, targetW, targetH)
    const b = metricToPdf({ x: wn.x2, y: wn.y2 }, apartmentBox, targetW, targetH)
    return { ...wn, ax: a.x, ay: a.y, bx: b.x, by: b.y }
  })
  const doorsPdf = (result.geometry.doorOpenings ?? []).map((d) => {
    const a = metricToPdf({ x: d.x1, y: d.y1 }, apartmentBox, targetW, targetH)
    const b = metricToPdf({ x: d.x2, y: d.y2 }, apartmentBox, targetW, targetH)
    return { ...d, ax: a.x, ay: a.y, bx: b.x, by: b.y }
  })

  // -------------- SVG output: side-by-side comparison --------------
  const planBox = expand(bboxFromLines(page.lines) ?? page.pageBounds, 14)
  const W = planBox.maxX - planBox.minX
  const H = planBox.maxY - planBox.minY
  const parts: string[] = []
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W * 2 + 60}" height="${H + 90}" viewBox="0 0 ${W * 2 + 60} ${H + 90}">`
  )
  parts.push(
    `<rect x="0" y="0" width="${W * 2 + 60}" height="${H + 90}" fill="white" />`
  )
  parts.push(
    `<text x="20" y="22" font-family="Arial" font-size="13" fill="#111">LEFT: every PDF line (raw extraction). black=long axial, green=fixture-near, blue=short connector</text>`
  )
  parts.push(
    `<text x="${W + 40}" y="22" font-family="Arial" font-size="13" fill="#111">RIGHT: RED=exterior, BLUE=interior, GRAY=rare decorative only (appliance scribbles); YELLOW=glass; CYAN=interior thin-pair; ORANGE=door</text>`
  )
  parts.push(
    `<text x="20" y="40" font-family="Arial" font-size="11" fill="#666">apartmentBox + 14pt; raw line count: ${page.lines.length}</text>`
  )

  // ---- LEFT panel: raw vector lines (everything from the PDF extractor) ----
  parts.push(
    `<g transform="translate(${20 - planBox.minX},${50 - planBox.minY})">`
  )
  parts.push(
    `<rect x="${apartmentBox.minX}" y="${apartmentBox.minY}" width="${aw}" height="${ah}" fill="#f59e0b" fill-opacity="0.05" stroke="#f59e0b" stroke-width="1" />`
  )
  for (const l of page.lines) {
    const len = Math.hypot(l.x2 - l.x1, l.y2 - l.y1)
    let stroke = "#9ca3af"
    let sw = 0.6
    if (len >= 7) {
      stroke = "#111827"
      sw = 1.0
    } else if (len >= 1.5) {
      stroke = "#2563eb"
      sw = 0.7
    }
    parts.push(
      `<line x1="${l.x1}" y1="${l.y1}" x2="${l.x2}" y2="${l.y2}" stroke="${stroke}" stroke-width="${sw}" />`
    )
  }
  parts.push(`</g>`)

  // ---- RIGHT panel: classified output ----
  const rightX = W + 40 - planBox.minX
  parts.push(`<g transform="translate(${rightX},${50 - planBox.minY})">`)
  parts.push(
    `<rect x="${apartmentBox.minX}" y="${apartmentBox.minY}" width="${aw}" height="${ah}" fill="#f59e0b" fill-opacity="0.04" stroke="#f59e0b" stroke-width="0.8" />`
  )

  // Apartment polygon (semi-transparent fill so we see classification through it)
  if (polygonPdf.length >= 3) {
    const ptsStr = polygonPdf.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ")
    parts.push(
      `<polygon points="${ptsStr}" fill="#fde68a" fill-opacity="0.18" stroke="#92400e" stroke-width="0.6" stroke-dasharray="3 2" stroke-linejoin="round" />`
    )
  }

  // Draw classified walls under windows/doors so highlights sit on top.
  const fixturesOut = wallsPdf.filter((w) => w.wallType === "fixture")
  const interiorOut = wallsPdf.filter((w) => w.wallType === "interior")
  const exteriorOut = wallsPdf.filter((w) => w.wallType === "exterior")
  for (const l of fixturesOut) {
    parts.push(
      `<line x1="${l.ax}" y1="${l.ay}" x2="${l.bx}" y2="${l.by}" stroke="#9ca3af" stroke-width="0.7" stroke-opacity="0.7" />`
    )
  }
  for (const l of interiorOut) {
    parts.push(
      `<line x1="${l.ax}" y1="${l.ay}" x2="${l.bx}" y2="${l.by}" stroke="#1d4ed8" stroke-width="1.4" />`
    )
  }
  for (const l of exteriorOut) {
    parts.push(
      `<line x1="${l.ax}" y1="${l.ay}" x2="${l.bx}" y2="${l.by}" stroke="#dc2626" stroke-width="1.8" />`
    )
  }

  // Window highlights — bright yellow for exterior glass (≤50 pt from apartmentBox edge),
  // light cyan for interior thin-pair candidates (likely glass partitions / cabinet faces).
  const isExteriorWin = (
    ax: number,
    ay: number,
    bx: number,
    by: number
  ): boolean => {
    const horizontal = Math.abs(bx - ax) >= Math.abs(by - ay)
    const perp = horizontal ? (ay + by) / 2 : (ax + bx) / 2
    const dEdge = horizontal
      ? Math.min(
          Math.abs(perp - apartmentBox.minY),
          Math.abs(perp - apartmentBox.maxY)
        )
      : Math.min(
          Math.abs(perp - apartmentBox.minX),
          Math.abs(perp - apartmentBox.maxX)
        )
    return dEdge <= 50
  }
  for (const wn of windowsPdf) {
    const horizontal = Math.abs(wn.bx - wn.ax) >= Math.abs(wn.by - wn.ay)
    const exterior = isExteriorWin(wn.ax, wn.ay, wn.bx, wn.by)
    const fill = exterior ? "#f59e0b" : "#22d3ee"
    const cap = exterior ? "#b45309" : "#0e7490"
    parts.push(
      `<line x1="${wn.ax}" y1="${wn.ay}" x2="${wn.bx}" y2="${wn.by}" stroke="${fill}" stroke-width="6" stroke-opacity="${exterior ? 0.55 : 0.4}" stroke-linecap="butt" />`
    )
    parts.push(
      `<line x1="${wn.ax}" y1="${wn.ay}" x2="${wn.bx}" y2="${wn.by}" stroke="${cap}" stroke-width="1.2" />`
    )
    const tw = 4
    if (horizontal) {
      parts.push(
        `<line x1="${wn.ax}" y1="${wn.ay - tw}" x2="${wn.ax}" y2="${wn.ay + tw}" stroke="${cap}" stroke-width="1.2" />`
      )
      parts.push(
        `<line x1="${wn.bx}" y1="${wn.by - tw}" x2="${wn.bx}" y2="${wn.by + tw}" stroke="${cap}" stroke-width="1.2" />`
      )
    } else {
      parts.push(
        `<line x1="${wn.ax - tw}" y1="${wn.ay}" x2="${wn.ax + tw}" y2="${wn.ay}" stroke="${cap}" stroke-width="1.2" />`
      )
      parts.push(
        `<line x1="${wn.bx - tw}" y1="${wn.by}" x2="${wn.bx + tw}" y2="${wn.by}" stroke="${cap}" stroke-width="1.2" />`
      )
    }
  }

  // Door highlights — orange band + small arc
  for (const d of doorsPdf) {
    const horizontal = Math.abs(d.bx - d.ax) >= Math.abs(d.by - d.ay)
    const stroke = d.kind === "swing" ? "#ea580c" : "#fb923c"
    parts.push(
      `<line x1="${d.ax}" y1="${d.ay}" x2="${d.bx}" y2="${d.by}" stroke="${stroke}" stroke-width="6" stroke-opacity="0.65" stroke-linecap="butt" />`
    )
    parts.push(
      `<line x1="${d.ax}" y1="${d.ay}" x2="${d.bx}" y2="${d.by}" stroke="#7c2d12" stroke-width="1.2" />`
    )
    const tw = 4
    if (horizontal) {
      parts.push(
        `<line x1="${d.ax}" y1="${d.ay - tw}" x2="${d.ax}" y2="${d.ay + tw}" stroke="#7c2d12" stroke-width="1.4" />`
      )
      parts.push(
        `<line x1="${d.bx}" y1="${d.by - tw}" x2="${d.bx}" y2="${d.by + tw}" stroke="#7c2d12" stroke-width="1.4" />`
      )
    } else {
      parts.push(
        `<line x1="${d.ax - tw}" y1="${d.ay}" x2="${d.ax + tw}" y2="${d.ay}" stroke="#7c2d12" stroke-width="1.4" />`
      )
      parts.push(
        `<line x1="${d.bx - tw}" y1="${d.by}" x2="${d.bx + tw}" y2="${d.by}" stroke="#7c2d12" stroke-width="1.4" />`
      )
    }
  }

  // Room labels for context
  const roomRe =
    /\b(PRIMARY BEDROOM|BEDROOM\s*\d*|PRIMARY BATH|BATH(ROOM)?(?:\s*\d+)?|KITCHEN|LIVING|DINING|FOYER|WIC|LIBRARY|OFFICE|FAMILY(?:\s+ROOM)?|GREAT(?:\s+ROOM)?|MEDIA(?:\s+ROOM)?|GAME(?:\s+ROOM)?|PLAY(?:\s+ROOM)?|STUDY|DEN|HALL(?:WAY)?|PANTRY|LAUNDRY|MUDROOM|MUD\s+ROOM|POWDER|PWDR|STORAGE|GYM|NOOK|BREAKFAST)\b/i
  for (const t of page.texts.filter(
    (t) =>
      roomRe.test(t.text) &&
      t.x >= apartmentBox.minX &&
      t.x <= apartmentBox.maxX &&
      t.y >= apartmentBox.minY &&
      t.y <= apartmentBox.maxY
  )) {
    parts.push(
      `<text x="${t.x + 3}" y="${t.y - 3}" font-family="Arial" font-size="6.5" fill="#374151">${escapeXml(t.text)}</text>`
    )
  }

  parts.push(`</g>`)
  parts.push(`</svg>`)

  const outPath = path.resolve(
    process.cwd(),
    `debug/${path.basename(abs, "-primitives.json")}-NEW-pipeline.svg`
  )
  fs.writeFileSync(outPath, parts.join("\n"))

  // -------- Stats --------
  const polyAabb = polygonAABB(result.geometry.footprintPolygon)
  console.log(
    JSON.stringify(
      {
        inputJson: abs,
        outputSvg: outPath,
        apartmentBox,
        apartmentBoxAspectRatio: aspect.toFixed(3),
        targetMetricBox: { width: targetW.toFixed(2), depth: targetH.toFixed(2), aiLong },
        ptToMetersAt30mLongSide: ptToM.toFixed(5),
        counts: {
          rawLines: page.lines.length,
          structuralLines: result.structuralLineCount,
          strongWalls: result.strongWallCount,
          exteriorWalls: result.exteriorWallCount,
          interiorWalls: result.interiorWallCount,
          fixtureLines: result.fixtureLineCount,
          doubleLineWallPairs: result.doubleLineWallCount,
          singletonWalls: result.singletonWallCount,
          windows: result.windowCount,
          doors: result.doorCount,
        },
        outerContour: {
          fromVector: result.outerContourFromVector,
          vertices: result.outerContourVertexCount,
          metricAABB: polyAabb,
        },
        windowsSample: windowsPdf.slice(0, 12).map((w) => ({
          x1: +w.ax.toFixed(1),
          y1: +w.ay.toFixed(1),
          x2: +w.bx.toFixed(1),
          y2: +w.by.toFixed(1),
          widthM: +(Math.hypot(w.bx - w.ax, w.by - w.ay) * ptToM).toFixed(2),
        })),
        doorsSample: doorsPdf.slice(0, 12).map((d) => ({
          x1: +d.ax.toFixed(1),
          y1: +d.ay.toFixed(1),
          x2: +d.bx.toFixed(1),
          y2: +d.by.toFixed(1),
          widthM: +(Math.hypot(d.bx - d.ax, d.by - d.ay) * ptToM).toFixed(2),
          kind: d.kind ?? "unknown",
        })),
        notes: result.notes,
      },
      null,
      2
    )
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
