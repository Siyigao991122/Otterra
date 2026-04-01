/**
 * Extract polylines from pdf.js display operator lists (Phase 2).
 * Uses `OPS.constructPath` path buffers + current transform stack — same data the canvas renderer consumes.
 */

import type { ExtractedLineSegment } from "@/lib/geometryFirst/types"

/** Matches pdf.js internal DrawOPS / path buffer encoding. */
const PathDraw = {
  moveTo: 0,
  lineTo: 1,
  curveTo: 2,
  quadraticCurveTo: 3,
  closePath: 4,
} as const

const IDENTITY = [1, 0, 0, 1, 0, 0]

/** Degenerate segments (PDF units). */
const MIN_LEN = 1e-5

/** Avoid OOM on noisy PDFs; drop remaining stroked paths on this page. */
const MAX_SEGMENTS_PER_PAGE = 45_000

export type PdfJsOps = {
  save: number
  restore: number
  transform: number
  constructPath: number
  stroke: number
  closeStroke: number
  fillStroke: number
  eoFillStroke: number
  closeFillStroke: number
  closeEOFillStroke: number
}

function normalizeTransformArgs(args: unknown): number[] | null {
  if (Array.isArray(args) && args.length >= 6) {
    const m = args.slice(0, 6).map((v) => Number(v))
    return m.every(Number.isFinite) ? m : null
  }
  if (args instanceof Float32Array && args.length >= 6) {
    const m = Array.from(args.slice(0, 6))
    return m.every(Number.isFinite) ? m : null
  }
  return null
}

function isStrokePaint(op: number, OPS: PdfJsOps): boolean {
  return (
    op === OPS.stroke ||
    op === OPS.closeStroke ||
    op === OPS.fillStroke ||
    op === OPS.eoFillStroke ||
    op === OPS.closeFillStroke ||
    op === OPS.closeEOFillStroke
  )
}

/**
 * Walk `getOperatorList()` output: track `save`/`restore`/`transform`, expand stroked `constructPath` buffers into segments.
 * Coordinates match pdf.js rendering: path points in PDF user space × current CTM.
 */
export function extractStrokedLineSegmentsFromOperatorList(
  fnArray: number[],
  argsArray: unknown[][],
  OPS: PdfJsOps,
  transformMultiply: (m1: number[], m2: number[]) => number[]
): { segments: ExtractedLineSegment[]; truncated: boolean } {
  let ctm = IDENTITY.slice()
  const stack: number[][] = []
  const segments: ExtractedLineSegment[] = []
  let truncated = false

  const tf = (x: number, y: number): [number, number] => [
    x * ctm[0] + y * ctm[2] + ctm[4],
    x * ctm[1] + y * ctm[3] + ctm[5],
  ]

  const pushSeg = (ax: number, ay: number, bx: number, by: number) => {
    if (segments.length >= MAX_SEGMENTS_PER_PAGE) {
      truncated = true
      return
    }
    const [x1, y1] = tf(ax, ay)
    const [x2, y2] = tf(bx, by)
    const len = Math.hypot(x2 - x1, y2 - y1)
    if (len < MIN_LEN) return
    segments.push({
      x1,
      y1,
      x2,
      y2,
      source: "pdf-operator-list",
    })
  }

  const parsePathBuffer = (data: Float32Array) => {
    let cx = 0
    let cy = 0
    let sx = 0
    let sy = 0

    for (let j = 0; j < data.length && !truncated; ) {
      const cmd = data[j++]
      if (cmd === PathDraw.moveTo) {
        cx = data[j++]
        cy = data[j++]
        sx = cx
        sy = cy
      } else if (cmd === PathDraw.lineTo) {
        const nx = data[j++]
        const ny = data[j++]
        pushSeg(cx, cy, nx, ny)
        cx = nx
        cy = ny
      } else if (cmd === PathDraw.curveTo) {
        const x1 = data[j++]
        const y1 = data[j++]
        const x2 = data[j++]
        const y2 = data[j++]
        const nx = data[j++]
        const ny = data[j++]
        void x1
        void y1
        void x2
        void y2
        pushSeg(cx, cy, nx, ny)
        cx = nx
        cy = ny
      } else if (cmd === PathDraw.quadraticCurveTo) {
        const qx = data[j++]
        const qy = data[j++]
        const nx = data[j++]
        const ny = data[j++]
        void qx
        void qy
        pushSeg(cx, cy, nx, ny)
        cx = nx
        cy = ny
      } else if (cmd === PathDraw.closePath) {
        pushSeg(cx, cy, sx, sy)
        cx = sx
        cy = sy
      } else {
        break
      }
    }
  }

  for (let i = 0; i < fnArray.length && !truncated; i++) {
    const fn = fnArray[i]
    const args = argsArray[i] as unknown[] | undefined
    if (!args) continue

    if (fn === OPS.save) {
      stack.push(ctm.slice())
    } else if (fn === OPS.restore) {
      const prev = stack.pop()
      ctm = prev ?? IDENTITY.slice()
    } else if (fn === OPS.transform) {
      const m = normalizeTransformArgs(args)
      if (m) ctm = transformMultiply(ctm, m)
    } else if (fn === OPS.constructPath) {
      const paintOp = args[0] as number
      if (!isStrokePaint(paintOp, OPS)) continue
      const packed = args[1] as [Float32Array | null] | undefined
      const buf = packed?.[0]
      if (!buf || buf.length === 0) continue
      parsePathBuffer(buf)
    }
  }

  return { segments, truncated }
}
