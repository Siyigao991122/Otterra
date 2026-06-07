/**
 * Extract polylines from pdf.js display operator lists (Phase 2).
 * Uses `OPS.constructPath` path buffers + current transform stack — same data the canvas renderer consumes.
 *
 * ## Operator CTM vs page stream (`q` / `cm` / `Q`)
 * Path buffer operands are in the **current PDF user space** at stroke time. pdf.js applies the same
 * `StateManager` CTM while parsing, but the **operator list** also inserts wrapper ops that change the
 * canvas CTM without emitting `OPS.save` / `OPS.transform`:
 *
 * - **`paintFormXObjectBegin` / `paintFormXObjectEnd`** — `CanvasGraphics.paintFormXObjectBegin` does
 *   `save → ctx.transform(formMatrix)` before inline form content. Path coordinates inside the form are in
 *   **form space**; omitting this matrix produced segment coordinates off by **`parentCTM × formMatrix`**
 *   (often huge scale + offset vs `getTextContent`, which is already in page user space).
 * - **`beginAnnotation` / `endAnnotation`** — `CanvasGraphics.beginAnnotation` first calls
 *   `#restoreInitialState()` (pops **all** saves / wipes transform stack), then `setTransform(baseTransform)`,
 *   then `transform` × `matrix` from op args. Appearance strokes must **not** be left-multiplied by the
 *   running page CTM from earlier content — that stack is discarded before the annotation is painted.
 *   We compose annotation local CTM as **identity × T × M** (then continue with `cm` ops inside the stream).
 *
 * `beginGroup` / `endGroup` are **not** applied here: the worker still emits path operands in the same
 * PDF user space; the offscreen group is a renderer implementation detail.
 *
 * ## `OPS.save` / `OPS.restore` args
 * pdf.js `OperatorList` stores **`null`** (not `[]`) for **`save`** / **`restore`** argument slots. Skipping
 * ops when `args == null` would ignore every **`q`/`Q`** pair and leave the CTM stuck with monotonically
 * growing translations — the exact failure mode seen when strokes land near `tx≈1e3` while text stays
 * near the MediaBox.
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

/** Build `fn` → name for logs (invert pdf.js `OPS`). */
export function pdfJsOpsFnNameLookup(OPS: Record<string, number>): Map<number, string> {
  const m = new Map<number, string>()
  for (const [name, id] of Object.entries(OPS)) {
    if (typeof id === "number") m.set(id, name)
  }
  return m
}

/** One CTM-changing step in operator-list order (debug). */
export type PdfCtmMutationEntry = {
  fnIndex: number
  fnName: string
  /** High-level cause: save stack / stream cm / form / annotation / group marker. */
  kind: "save" | "restore" | "transform" | "formBegin" | "formEnd" | "annotBegin" | "annotEnd" | "groupBegin" | "groupEnd"
  /** Short arg summary for transform-like ops (6 numbers or “null matrix”). */
  argsSummary: string | null
  prevCtm: readonly number[]
  nextCtm: readonly number[]
}

/** Debug-only: first-N stroke samples with raw buffer + CTM (see `extractPdfVectorPrimitives` env gate). */
export type PdfOperatorLineSegmentSample = {
  fnIndex: number
  fnName: string
  paintOp: number
  paintOpName: string
  nesting: {
    saveDepth: number
    formDepth: number
    annotationDepth: number
    inForm: boolean
    inAnnotation: boolean
  }
  /** CTM at the start of this `constructPath` op (before parsing the path buffer). */
  ctmBeforeConstructPath: readonly number[]
  /** CTM while applying `tf` to this segment (unchanged for the whole op). */
  ctmUsedForSegment: readonly number[]
  /** For `constructPath`, CTM is unchanged; included to satisfy “before / after” tracing. */
  ctmAfterConstructPath: readonly number[]
  /** 1-based index among emitted stroked segments on this page. */
  segmentOrdinal: number
  stackEntries: number
  groupDepth: number
  /** Rough uniform scale from linear part of CTM (|det|^0.25 style proxy). */
  ctmApproxScale: number
  /** Last few `cm` (OPS.transform) matrices before this segment (PDF stream order). */
  recentPdfCmOps: PdfRecentCmOp[]
  /** When nested in annotation, args[2]×args[3] composition (before inner `cm` ops). */
  annotationComposeTM?: { T: readonly number[] | null; M: readonly number[] | null }
  pathHead: number[]
  rawPathLocal: { ax: number; ay: number; bx: number; by: number }
  pdfUserSpace: { x1: number; y1: number; x2: number; y2: number }
  /** Present when trace passes `convertToViewportPoint` from `page.getViewport`. */
  viewportSpace?: { x1: number; y1: number; x2: number; y2: number }
  /** Every tracked CTM mutation strictly before this `constructPath` op (`fnIndex`). */
  ctmMutationHistory: PdfCtmMutationEntry[] | { truncated: true; total: number; head: PdfCtmMutationEntry[]; tail: PdfCtmMutationEntry[] }
  /** Single mutation whose |(Δe,Δf)| is largest (localizes spurious translation buildup). */
  ctmLargestTranslationStep: {
    fnIndex: number
    fnName: string
    kind: PdfCtmMutationEntry["kind"]
    deltaE: number
    deltaF: number
    magnitude: number
  } | null
  /** pdf.js getOperatorList uses OPLIST → NullOptimizer: operands stay raw stream space; one `cm` should compose once. */
  constructPathSpaceNote: string
  /** Confirms our stroke math is self-consistent; inverse check proves a single `cm` application matches endpoints. */
  pathTransformSelfCheck: {
    segmentMidPdf: { x: number; y: number }
    segmentMidFromRawTimesCtm: { x: number; y: number }
    maxAbsErr: number
    inverseCtmTimesPdfMid: { x: number; y: number }
    rawMid: { x: number; y: number }
    invMaxAbsErr: number
    /** True if operands look like final page coords (would imply double-transform if we also multiply by CTM). */
    operandsLikelyAlreadyPageUserSpaceHeuristic: boolean
  }
  /** Filled by `extractPdfVectorPrimitives` when text is available: nearest `getTextContent` item in PDF user space. */
  nearestTextPdfUser?: {
    text: string
    x: number
    y: number
    distToSegmentMidPdf: number
    viewport?: { x: number; y: number; distToSegmentMidViewport: number }
  }
}

export type PdfOperatorLineExtractorTrace = {
  maxSegmentSamples: number
  fnNameFor: (fn: number) => string
  /** Optional: map segment endpoints through viewport like `normalizeSegmentsToViewport`. */
  convertToViewportPoint?: (x: number, y: number) => number[]
  onSegmentSample: (info: PdfOperatorLineSegmentSample) => void
  onComplete?: (stats: PdfOperatorLineExtractorTraceStats) => void
}

export type PdfOperatorLineExtractorTraceStats = {
  paintFormXObjectBeginCount: number
  paintFormXObjectEndCount: number
  beginAnnotationCount: number
  endAnnotationCount: number
  beginGroupCount: number
  endGroupCount: number
  /** If non-zero, save/form/annotation pushes and pops may be mismatched (drift CTM). */
  balance: {
    stackEntries: number
    saveDepth: number
    formDepth: number
    annotationDepth: number
    groupDepth: number
  }
}

export type PdfRecentCmOp = { fnIndex: number; matrix: readonly number[] }

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
  paintFormXObjectBegin: number
  paintFormXObjectEnd: number
  beginAnnotation: number
  endAnnotation: number
  beginGroup: number
  endGroup: number
}

function normalizeTransformArgs(args: unknown): number[] | null {
  if (args == null) return null
  // Some call sites wrap the 6-tuple once (e.g. nested arrays).
  if (Array.isArray(args) && args.length === 1) {
    return normalizeTransformArgs(args[0])
  }
  if (Array.isArray(args) && args.length >= 6) {
    const m = args.slice(0, 6).map((v) => Number(v))
    return m.every(Number.isFinite) ? m : null
  }
  if (ArrayBuffer.isView(args) && !(args instanceof BigInt64Array || args instanceof BigUint64Array)) {
    const v = args as unknown as ArrayLike<number> & { length: number }
    if (v.length < 6) return null
    const m = [0, 1, 2, 3, 4, 5].map((i) => Number(v[i]))
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

function strokePaintOpName(op: number, OPS: PdfJsOps): string {
  if (op === OPS.stroke) return "stroke"
  if (op === OPS.closeStroke) return "closeStroke"
  if (op === OPS.fillStroke) return "fillStroke"
  if (op === OPS.eoFillStroke) return "eoFillStroke"
  if (op === OPS.closeFillStroke) return "closeFillStroke"
  if (op === OPS.closeEOFillStroke) return "closeEOFillStroke"
  return `paintOp(${op})`
}

function ctmDeterminant(m: readonly number[]): number {
  return m[0]! * m[3]! - m[1]! * m[2]!
}

function approxCtmScale(m: readonly number[]): number {
  const det = Math.abs(ctmDeterminant(m))
  return det > 0 ? Math.sqrt(det) : Math.hypot(m[0]!, m[1]!, m[2]!, m[3]!)
}

function applyAffine6(x: number, y: number, m: readonly number[]): [number, number] {
  return [x * m[0]! + y * m[2]! + m[4]!, x * m[1]! + y * m[3]! + m[5]!]
}

function invertAffine6(m: readonly number[]): number[] | null {
  const a = m[0]!
  const b = m[1]!
  const c = m[2]!
  const d = m[3]!
  const det = a * d - b * c
  if (!Number.isFinite(det) || Math.abs(det) < 1e-14) return null
  const invA = d / det
  const invB = -b / det
  const invC = -c / det
  const invD = a / det
  const e = m[4]!
  const f = m[5]!
  const invE = -(invA * e + invC * f)
  const invF = -(invB * e + invD * f)
  return [invA, invB, invC, invD, invE, invF]
}

function fmtTransformSummary(m: number[] | null): string | null {
  if (!m) return null
  return m.map((v) => (Number.isInteger(v) ? String(v) : v.toFixed(5))).join(",")
}

function sliceCtmHistory(
  all: PdfCtmMutationEntry[],
  beforeFnIndex: number,
  maxInline: number
): PdfOperatorLineSegmentSample["ctmMutationHistory"] {
  const relevant = all.filter((e) => e.fnIndex < beforeFnIndex)
  if (relevant.length <= maxInline) return relevant
  const n = 70
  return {
    truncated: true,
    total: relevant.length,
    head: relevant.slice(0, n),
    tail: relevant.slice(-n),
  }
}

function largestTranslationStep(
  relevant: PdfCtmMutationEntry[]
): PdfOperatorLineSegmentSample["ctmLargestTranslationStep"] {
  let best: NonNullable<PdfOperatorLineSegmentSample["ctmLargestTranslationStep"]> | null = null
  for (const m of relevant) {
    const de = m.nextCtm[4]! - m.prevCtm[4]!
    const df = m.nextCtm[5]! - m.prevCtm[5]!
    const magnitude = Math.hypot(de, df)
    if (!best || magnitude > best.magnitude) {
      best = { fnIndex: m.fnIndex, fnName: m.fnName, kind: m.kind, deltaE: de, deltaF: df, magnitude }
    }
  }
  return best
}

/**
 * Walk `getOperatorList()` output: track `save`/`restore`/`transform`, expand stroked `constructPath` buffers into segments.
 * Coordinates match pdf.js rendering: path operands in the **current** PDF user space, then multiplied by
 * the reconstructed canvas CTM (including form / annotation brackets).
 */
export function extractStrokedLineSegmentsFromOperatorList(
  fnArray: number[],
  argsArray: unknown[][],
  OPS: PdfJsOps,
  transformMultiply: (m1: number[], m2: number[]) => number[],
  trace?: PdfOperatorLineExtractorTrace
): { segments: ExtractedLineSegment[]; truncated: boolean } {
  let ctm = IDENTITY.slice()
  const stack: number[][] = []
  const segments: ExtractedLineSegment[] = []
  let truncated = false
  let traceSamplesLeft = trace?.maxSegmentSamples ?? 0
  let qDepth = 0
  let formDepth = 0
  let annDepth = 0
  let groupDepth = 0
  const recentPdfCm: PdfRecentCmOp[] = []
  const annotTmStack: { T: number[] | null; M: number[] | null }[] = []
  const ctmMutLog: PdfCtmMutationEntry[] | null = trace ? [] : null
  const ctmHistoryMax =
    typeof process !== "undefined"
      ? Math.max(48, Number(process.env.GEOMETRY_FIRST_PDF_OPERATOR_TRACE_CTM_HISTORY_MAX ?? "") || 220)
      : 220
  const verboseLimit =
    typeof process !== "undefined"
      ? Number(process.env.GEOMETRY_FIRST_PDF_OPERATOR_TRACE_VERBOSE_OPS ?? "") || 0
      : 0

  const pushMutation = (
    fnIndex: number,
    kind: PdfCtmMutationEntry["kind"],
    fnName: string,
    argsSummary: string | null,
    prev: number[],
    next: number[]
  ) => {
    if (!ctmMutLog) return
    ctmMutLog.push({
      fnIndex,
      fnName,
      kind,
      argsSummary,
      prevCtm: prev.slice(),
      nextCtm: next.slice(),
    })
  }

  const stats: PdfOperatorLineExtractorTraceStats = {
    paintFormXObjectBeginCount: 0,
    paintFormXObjectEndCount: 0,
    beginAnnotationCount: 0,
    endAnnotationCount: 0,
    beginGroupCount: 0,
    endGroupCount: 0,
    balance: { stackEntries: 0, saveDepth: 0, formDepth: 0, annotationDepth: 0, groupDepth: 0 },
  }

  const tf = (x: number, y: number): [number, number] => [
    x * ctm[0] + y * ctm[2] + ctm[4],
    x * ctm[1] + y * ctm[3] + ctm[5],
  ]

  const pushSeg = (
    ax: number,
    ay: number,
    bx: number,
    by: number,
    paintOp: number,
    fnIndex: number,
    pathHead: number[],
    ctmBeforeConstructPath: number[]
  ) => {
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
    if (trace && traceSamplesLeft > 0) {
      traceSamplesLeft--
      const ctmUsed = ctm.slice()
      const tip = annotTmStack.length > 0 ? annotTmStack[annotTmStack.length - 1]! : null
      const midRaw = { x: (ax + bx) / 2, y: (ay + by) / 2 }
      const midPdf = { x: (x1 + x2) / 2, y: (y1 + y2) / 2 }
      const [rx, ry] = applyAffine6(midRaw.x, midRaw.y, ctmUsed)
      const inv = invertAffine6(ctmUsed)
      let inverseCtmTimesPdfMid = { x: NaN, y: NaN }
      let invMaxAbsErr = Number.NaN
      if (inv) {
        const [ix, iy] = applyAffine6(midPdf.x, midPdf.y, inv)
        inverseCtmTimesPdfMid = { x: ix, y: iy }
        invMaxAbsErr = Math.max(Math.abs(ix - midRaw.x), Math.abs(iy - midRaw.y))
      }
      const maxAbsErr = Math.max(Math.abs(rx - midPdf.x), Math.abs(ry - midPdf.y))
      const rawMatchesPdfEndpoints =
        Math.abs(ax - x1) < 1e-2 &&
        Math.abs(ay - y1) < 1e-2 &&
        Math.abs(bx - x2) < 1e-2 &&
        Math.abs(by - y2) < 1e-2
      const ctmNotIdentity =
        Math.abs(ctmUsed[0]! - 1) > 1e-4 ||
        Math.abs(ctmUsed[3]! - 1) > 1e-4 ||
        Math.abs(ctmUsed[1]!) > 1e-4 ||
        Math.abs(ctmUsed[2]!) > 1e-4 ||
        Math.abs(ctmUsed[4]!) > 1e-3 ||
        Math.abs(ctmUsed[5]!) > 1e-3
      const relevantMut = (ctmMutLog ?? []).filter((e) => e.fnIndex < fnIndex)
      const sample: PdfOperatorLineSegmentSample = {
        fnIndex,
        fnName: trace.fnNameFor(OPS.constructPath),
        paintOp,
        paintOpName: strokePaintOpName(paintOp, OPS),
        nesting: {
          saveDepth: qDepth,
          formDepth,
          annotationDepth: annDepth,
          inForm: formDepth > 0,
          inAnnotation: annDepth > 0,
        },
        ctmBeforeConstructPath,
        ctmUsedForSegment: ctmUsed,
        ctmAfterConstructPath: ctmUsed,
        segmentOrdinal: segments.length,
        stackEntries: stack.length,
        groupDepth,
        ctmApproxScale: approxCtmScale(ctmUsed),
        recentPdfCmOps: recentPdfCm.slice(-6).map((e) => ({
          fnIndex: e.fnIndex,
          matrix: e.matrix.slice(),
        })),
        annotationComposeTM:
          annDepth > 0 && tip != null
            ? { T: tip.T, M: tip.M }
            : undefined,
        pathHead,
        rawPathLocal: { ax, ay, bx, by },
        pdfUserSpace: { x1, y1, x2, y2 },
        ctmMutationHistory: sliceCtmHistory(ctmMutLog ?? [], fnIndex, ctmHistoryMax),
        ctmLargestTranslationStep: largestTranslationStep(relevantMut),
        constructPathSpaceNote:
          "Worker getOperatorList sets OPLIST → NullOptimizer: path operands are not merged away; each stream point is one `cm` away from PDF user space given a correct replayed canvas CTM.",
        pathTransformSelfCheck: {
          segmentMidPdf: midPdf,
          segmentMidFromRawTimesCtm: { x: rx, y: ry },
          maxAbsErr,
          inverseCtmTimesPdfMid,
          rawMid: midRaw,
          invMaxAbsErr,
          operandsLikelyAlreadyPageUserSpaceHeuristic: rawMatchesPdfEndpoints && ctmNotIdentity,
        },
      }
      if (trace.convertToViewportPoint) {
        const [vx1, vy1] = trace.convertToViewportPoint(x1, y1)
        const [vx2, vy2] = trace.convertToViewportPoint(x2, y2)
        sample.viewportSpace = { x1: vx1, y1: vy1, x2: vx2, y2: vy2 }
      }
      trace.onSegmentSample(sample)
    }
  }

  const parsePathBuffer = (
    data: Float32Array,
    paintOp: number,
    fnIndex: number,
    ctmBeforeConstructPath: number[]
  ) => {
    const pathHeadLen = Math.min(32, data.length)
    const pathHead = pathHeadLen > 0 ? Array.from(data.subarray(0, pathHeadLen)) : []
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
        pushSeg(cx, cy, nx, ny, paintOp, fnIndex, pathHead, ctmBeforeConstructPath)
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
        pushSeg(cx, cy, nx, ny, paintOp, fnIndex, pathHead, ctmBeforeConstructPath)
        cx = nx
        cy = ny
      } else if (cmd === PathDraw.quadraticCurveTo) {
        const qx = data[j++]
        const qy = data[j++]
        const nx = data[j++]
        const ny = data[j++]
        void qx
        void qy
        pushSeg(cx, cy, nx, ny, paintOp, fnIndex, pathHead, ctmBeforeConstructPath)
        cx = nx
        cy = ny
      } else if (cmd === PathDraw.closePath) {
        pushSeg(cx, cy, sx, sy, paintOp, fnIndex, pathHead, ctmBeforeConstructPath)
        cx = sx
        cy = sy
      } else {
        break
      }
    }
  }

  for (let i = 0; i < fnArray.length && !truncated; i++) {
    const fn = fnArray[i]
    const args = argsArray[i] as unknown[] | null | undefined
    // save/restore use args === null in pdf.js IR; must still run q/Q stack discipline.
    if (args == null && fn !== OPS.save && fn !== OPS.restore) continue

    if (trace && verboseLimit > 0 && i < verboseLimit) {
      const name = trace.fnNameFor(fn)
      if (fn === OPS.transform) {
        const mm = normalizeTransformArgs(args as unknown[] | undefined)
        console.log(
          `[pdf-operator-trace:verbose] #${i} ${name}`,
          mm ? mm.join(",") : String(args),
          "ctmDet",
          ctmDeterminant(ctm).toExponential(3)
        )
      } else {
        console.log(`[pdf-operator-trace:verbose] #${i} ${name}`)
      }
    }

    if (fn === OPS.save) {
      const prev = ctm.slice()
      qDepth++
      stack.push(ctm.slice())
      pushMutation(i, "save", trace ? trace.fnNameFor(fn) : "save", null, prev, ctm.slice())
    } else if (fn === OPS.restore) {
      const prev = ctm.slice()
      qDepth = Math.max(0, qDepth - 1)
      const popped = stack.pop()
      ctm = popped ?? IDENTITY.slice()
      pushMutation(i, "restore", trace ? trace.fnNameFor(fn) : "restore", null, prev, ctm.slice())
    } else if (fn === OPS.transform) {
      const prev = ctm.slice()
      const m = normalizeTransformArgs(args as unknown)
      const summary = m ? fmtTransformSummary(m) : args == null ? "args-null" : "invalid-args"
      if (m) {
        ctm = transformMultiply(ctm, m)
        if (trace) {
          recentPdfCm.push({ fnIndex: i, matrix: m })
          if (recentPdfCm.length > 32) recentPdfCm.shift()
        }
      }
      pushMutation(i, "transform", trace ? trace.fnNameFor(fn) : "transform", summary, prev, ctm.slice())
    } else if (fn === OPS.paintFormXObjectBegin) {
      stats.paintFormXObjectBeginCount++
      const prev = ctm.slice()
      formDepth++
      stack.push(ctm.slice())
      const matrix = (args as unknown[])[0] as Float32Array | null | undefined
      const m = normalizeTransformArgs(matrix ?? null)
      if (m) ctm = transformMultiply(ctm, m)
      pushMutation(
        i,
        "formBegin",
        trace ? trace.fnNameFor(fn) : "paintFormXObjectBegin",
        m ? fmtTransformSummary(m) : "null-matrix",
        prev,
        ctm.slice()
      )
    } else if (fn === OPS.paintFormXObjectEnd) {
      stats.paintFormXObjectEndCount++
      const prev = ctm.slice()
      formDepth = Math.max(0, formDepth - 1)
      const popped = stack.pop()
      ctm = popped ?? IDENTITY.slice()
      pushMutation(i, "formEnd", trace ? trace.fnNameFor(fn) : "paintFormXObjectEnd", null, prev, ctm.slice())
    } else if (fn === OPS.beginAnnotation) {
      stats.beginAnnotationCount++
      const prev = ctm.slice()
      annDepth++
      stack.push(ctm.slice())
      // beginAnnotation: CanvasGraphics.#restoreInitialState() drops the graphics stack before
      // painting; do not multiply the appearance transform by the running page CTM.
      let nx = IDENTITY.slice()
      let tLog: number[] | null = null
      let mLog: number[] | null = null
      if ((args as unknown[]).length >= 4) {
        const t = normalizeTransformArgs((args as unknown[])[2] ?? null)
        const m = normalizeTransformArgs((args as unknown[])[3] ?? null)
        if (t) {
          nx = transformMultiply(nx, t)
          tLog = t.slice()
        }
        if (m) {
          nx = transformMultiply(nx, m)
          mLog = m.slice()
        }
      }
      annotTmStack.push({ T: tLog, M: mLog })
      ctm = nx
      pushMutation(
        i,
        "annotBegin",
        trace ? trace.fnNameFor(fn) : "beginAnnotation",
        [tLog, mLog].every((x) => x == null) ? "T/M missing" : `T=${fmtTransformSummary(tLog)} M=${fmtTransformSummary(mLog)}`,
        prev,
        ctm.slice()
      )
    } else if (fn === OPS.endAnnotation) {
      stats.endAnnotationCount++
      const prev = ctm.slice()
      annDepth = Math.max(0, annDepth - 1)
      annotTmStack.pop()
      const popped = stack.pop()
      ctm = popped ?? IDENTITY.slice()
      pushMutation(i, "annotEnd", trace ? trace.fnNameFor(fn) : "endAnnotation", null, prev, ctm.slice())
    } else if (fn === OPS.constructPath) {
      const a = args as unknown[]
      const paintOp = a[0] as number
      if (!isStrokePaint(paintOp, OPS)) continue
      const packed = a[1] as [Float32Array | null] | undefined
      const buf = packed?.[0]
      if (!buf || buf.length === 0) continue
      const ctmBeforeConstructPath = ctm.slice()
      parsePathBuffer(buf, paintOp, i, ctmBeforeConstructPath)
    } else if (fn === OPS.beginGroup) {
      stats.beginGroupCount++
      const prev = ctm.slice()
      groupDepth++
      pushMutation(
        i,
        "groupBegin",
        trace ? trace.fnNameFor(fn) : "beginGroup",
        "extractor: CTM unchanged — CanvasGraphics uses offscreen ctx; form placement still comes from paintFormXObjectBegin matrix",
        prev,
        ctm.slice()
      )
    } else if (fn === OPS.endGroup) {
      stats.endGroupCount++
      const prev = ctm.slice()
      groupDepth = Math.max(0, groupDepth - 1)
      pushMutation(
        i,
        "groupEnd",
        trace ? trace.fnNameFor(fn) : "endGroup",
        "extractor: CTM unchanged — endGroup composites in renderer",
        prev,
        ctm.slice()
      )
    }
  }

  stats.balance = {
    stackEntries: stack.length,
    saveDepth: qDepth,
    formDepth,
    annotationDepth: annDepth,
    groupDepth,
  }

  trace?.onComplete?.(stats)
  return { segments, truncated }
}
