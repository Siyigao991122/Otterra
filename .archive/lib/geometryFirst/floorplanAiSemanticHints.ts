import { Buffer } from "node:buffer"
import { createRequire } from "node:module"

import { ensurePdfJsCanvasGlobals } from "@/lib/geometryFirst/pdfJsNodePolyfills"
import type { FloorplanAiSemanticHintsDebug, PlanBoundingBox } from "@/lib/geometryFirst/types"

type Pt = { x: number; y: number }
type PixelRect = { x: number; y: number; width: number; height: number }

type PageType = "residential_brochure_floorplan" | "architectural_drawing" | "site_plan" | "other"
type MajorSpaceType = "enclosed_room" | "open_plan_subzone"

interface PassAResponse {
  page_type: PageType
  crop_rect: PixelRect & { confidence: number }
  notes: string[]
}

interface PassBSpace {
  label: string
  space_type?: MajorSpaceType
  polygon: Pt[]
  confidence: number
}

interface PassBEnvelope {
  member_labels: string[]
  polygon: Pt[]
  confidence: number
}

interface PassBResponse {
  unit_outline_hint: {
    vertices: Pt[]
    confidence: number
    notes?: string
  }
  major_spaces: PassBSpace[]
  shared_open_plan_envelopes: PassBEnvelope[]
  auxiliary_spaces: Array<{
    label: string
    polygon: Pt[]
    confidence: number
  }>
  notes: string[]
}

export interface BuildFloorplanAiSemanticHintsOptions {
  pageIndex?: number
  renderScale?: number
  maxEdgePx?: number
  openAiApiKey?: string
  model?: string
  mainPlanBodyBBox?: PlanBoundingBox | null
  recoveredUnitPolygon?: Pt[] | null
}

export interface RenderedPdfPageForAi {
  imageBuffer: Buffer
  pageBounds: PlanBoundingBox
  renderPx: { width: number; height: number }
  pageIndex: number
}

export interface FloorplanAiSemanticHintsArtifacts {
  fullPagePng: Buffer
  croppedPlanPng: Buffer
  passAJson: PassAResponse
  passBJson: PassBResponse
  overlaySvg?: string
}

export interface FloorplanAiSemanticHintsBuildResult {
  hints: FloorplanAiSemanticHintsDebug
  artifacts: FloorplanAiSemanticHintsArtifacts
}

const DEFAULT_RENDER_SCALE = 2
const DEFAULT_MAX_EDGE_PX = 1800
const DEFAULT_MODEL = "gpt-4o"
const PASS_A_SCHEMA_NAME = "floorplan_semantic_pass_a"
const PASS_B_SCHEMA_NAME = "floorplan_semantic_pass_b"

const PASS_A_JSON_SCHEMA = {
  name: PASS_A_SCHEMA_NAME,
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["page_type", "crop_rect", "notes"],
    properties: {
      page_type: {
        type: "string",
        enum: ["residential_brochure_floorplan", "architectural_drawing", "site_plan", "other"],
      },
      crop_rect: {
        type: "object",
        additionalProperties: false,
        required: ["x", "y", "width", "height", "confidence"],
        properties: {
          x: { type: "number" },
          y: { type: "number" },
          width: { type: "number" },
          height: { type: "number" },
          confidence: { type: "number" },
        },
      },
      notes: {
        type: "array",
        items: { type: "string" },
      },
    },
  },
} as const

const POINT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["x", "y"],
  properties: {
    x: { type: "number" },
    y: { type: "number" },
  },
} as const

const PASS_B_JSON_SCHEMA = {
  name: PASS_B_SCHEMA_NAME,
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: [
      "unit_outline_hint",
      "major_spaces",
      "shared_open_plan_envelopes",
      "auxiliary_spaces",
      "notes",
    ],
    properties: {
      unit_outline_hint: {
        type: "object",
        additionalProperties: false,
        required: ["vertices", "confidence", "notes"],
        properties: {
          vertices: {
            type: "array",
            items: POINT_SCHEMA,
          },
          confidence: { type: "number" },
          notes: { type: "string" },
        },
      },
      major_spaces: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["label", "space_type", "polygon", "confidence"],
          properties: {
            label: { type: "string" },
            space_type: {
              type: "string",
              enum: ["enclosed_room", "open_plan_subzone"],
            },
            polygon: {
              type: "array",
              items: POINT_SCHEMA,
            },
            confidence: { type: "number" },
          },
        },
      },
      shared_open_plan_envelopes: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["member_labels", "polygon", "confidence"],
          properties: {
            member_labels: {
              type: "array",
              items: { type: "string" },
            },
            polygon: {
              type: "array",
              items: POINT_SCHEMA,
            },
            confidence: { type: "number" },
          },
        },
      },
      auxiliary_spaces: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["label", "polygon", "confidence"],
          properties: {
            label: { type: "string" },
            polygon: {
              type: "array",
              items: POINT_SCHEMA,
            },
            confidence: { type: "number" },
          },
        },
      },
      notes: {
        type: "array",
        items: { type: "string" },
      },
    },
  },
} as const

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

function finiteNumber(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : Number(v)
  return Number.isFinite(n) ? n : fallback
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

function asObject(v: unknown): Record<string, unknown> | null {
  return v != null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.map((item) => asString(item).trim()).filter(Boolean)
}

function normalizePoint(v: unknown): Pt | null {
  const o = asObject(v)
  if (!o) return null
  const x = finiteNumber(o.x, NaN)
  const y = finiteNumber(o.y, NaN)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return { x, y }
}

function normalizePolygon(v: unknown): Pt[] {
  if (!Array.isArray(v)) return []
  const out: Pt[] = []
  for (const item of v) {
    const pt = normalizePoint(item)
    if (pt) out.push(pt)
  }
  return out
}

function bboxOfPoly(poly: Pt[]): PlanBoundingBox | null {
  if (poly.length === 0) return null
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
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return null
  }
  return { minX, minY, maxX, maxY }
}

function polygonArea(poly: Pt[]): number {
  if (poly.length < 3) return 0
  let sum = 0
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!
    const b = poly[(i + 1) % poly.length]!
    sum += a.x * b.y - b.x * a.y
  }
  return Math.abs(sum) / 2
}

function boxArea(b: PlanBoundingBox | null): number {
  if (!b) return 0
  return Math.max(0, b.maxX - b.minX) * Math.max(0, b.maxY - b.minY)
}

function polygonSupportArea(poly: Pt[]): number {
  return Math.max(polygonArea(poly), boxArea(bboxOfPoly(poly)))
}

function boxIntersectionArea(a: PlanBoundingBox | null, b: PlanBoundingBox | null): number {
  if (!a || !b) return 0
  const w = Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX))
  const h = Math.max(0, Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY))
  return w * h
}

function isNearlyRectangular(poly: Pt[]): boolean {
  const box = bboxOfPoly(poly)
  const area = polygonArea(poly)
  const bboxArea = boxArea(box)
  if (!box || bboxArea <= 0 || area <= 0 || poly.length < 4) return false
  const fill = area / bboxArea
  return fill >= 0.9 && poly.length <= 8
}

function rectFromBox(b: PlanBoundingBox): PixelRect {
  return { x: b.minX, y: b.minY, width: b.maxX - b.minX, height: b.maxY - b.minY }
}

function boxFromRect(r: PixelRect): PlanBoundingBox {
  return { minX: r.x, minY: r.y, maxX: r.x + r.width, maxY: r.y + r.height }
}

function padRectPx(r: PixelRect, padFrac: number, bounds: { width: number; height: number }): PixelRect {
  const padX = r.width * padFrac
  const padY = r.height * padFrac
  const x1 = clamp(r.x - padX, 0, bounds.width)
  const y1 = clamp(r.y - padY, 0, bounds.height)
  const x2 = clamp(r.x + r.width + padX, 0, bounds.width)
  const y2 = clamp(r.y + r.height + padY, 0, bounds.height)
  return { x: x1, y: y1, width: Math.max(1, x2 - x1), height: Math.max(1, y2 - y1) }
}

function intersectRects(a: PixelRect, b: PixelRect): PixelRect | null {
  const x1 = Math.max(a.x, b.x)
  const y1 = Math.max(a.y, b.y)
  const x2 = Math.min(a.x + a.width, b.x + b.width)
  const y2 = Math.min(a.y + a.height, b.y + b.height)
  if (x2 <= x1 || y2 <= y1) return null
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 }
}

function rectArea(r: PixelRect): number {
  return Math.max(0, r.width) * Math.max(0, r.height)
}

function uniqueNotes(...groups: string[][]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const group of groups) {
    for (const note of group) {
      const s = note.trim()
      if (!s || seen.has(s)) continue
      seen.add(s)
      out.push(s)
    }
  }
  return out
}

function getCanvasModule(): { createCanvas: (width: number, height: number) => any } {
  const require = createRequire(import.meta.url)
  return require("@napi-rs/canvas") as { createCanvas: (width: number, height: number) => any }
}

function createPdfJsCanvasFactory() {
  const { createCanvas } = getCanvasModule()
  return {
    create(width: number, height: number) {
      const canvas = createCanvas(Math.max(1, Math.ceil(width)), Math.max(1, Math.ceil(height)))
      return {
        canvas,
        context: canvas.getContext("2d"),
      }
    },
    reset(target: { canvas: any; context: any }, width: number, height: number) {
      target.canvas.width = Math.max(1, Math.ceil(width))
      target.canvas.height = Math.max(1, Math.ceil(height))
    },
    destroy(target: { canvas: any; context: any }) {
      target.canvas.width = 0
      target.canvas.height = 0
      target.canvas = null
      target.context = null
    },
  }
}

async function maybeResizePng(
  pngBuffer: Buffer,
  maxEdgePx: number
): Promise<{ buffer: Buffer; width: number; height: number }> {
  const sharp = (await import("sharp")).default
  const meta = await sharp(pngBuffer).metadata()
  const width = meta.width ?? 0
  const height = meta.height ?? 0
  if (!width || !height) {
    throw new Error("Could not read rendered PNG metadata.")
  }
  const maxEdge = Math.max(width, height)
  if (maxEdge <= maxEdgePx) {
    return { buffer: pngBuffer, width, height }
  }
  const resizedBuffer = await sharp(pngBuffer)
    .resize(maxEdgePx, maxEdgePx, {
      fit: "inside",
      withoutEnlargement: true,
    })
    .png()
    .toBuffer()
  const resizedMeta = await sharp(resizedBuffer).metadata()
  return {
    buffer: resizedBuffer,
    width: resizedMeta.width ?? width,
    height: resizedMeta.height ?? height,
  }
}

function toDataUrlPng(buffer: Buffer): string {
  return `data:image/png;base64,${buffer.toString("base64")}`
}

function pdfBoxToRenderRect(
  bbox: PlanBoundingBox,
  pageBounds: PlanBoundingBox,
  renderPx: { width: number; height: number }
): PixelRect {
  const pdfWidth = Math.max(1, pageBounds.maxX - pageBounds.minX)
  const pdfHeight = Math.max(1, pageBounds.maxY - pageBounds.minY)
  return {
    x: ((bbox.minX - pageBounds.minX) / pdfWidth) * renderPx.width,
    y: ((bbox.minY - pageBounds.minY) / pdfHeight) * renderPx.height,
    width: ((bbox.maxX - bbox.minX) / pdfWidth) * renderPx.width,
    height: ((bbox.maxY - bbox.minY) / pdfHeight) * renderPx.height,
  }
}

function renderPointToPdf(
  pt: Pt,
  pageBounds: PlanBoundingBox,
  renderPx: { width: number; height: number }
): Pt {
  const pdfWidth = Math.max(1, pageBounds.maxX - pageBounds.minX)
  const pdfHeight = Math.max(1, pageBounds.maxY - pageBounds.minY)
  return {
    x: round3(pageBounds.minX + (pt.x / renderPx.width) * pdfWidth),
    y: round3(pageBounds.minY + (pt.y / renderPx.height) * pdfHeight),
  }
}

function renderPolygonToPdf(
  poly: Pt[],
  pageBounds: PlanBoundingBox,
  renderPx: { width: number; height: number }
): Pt[] {
  return poly.map((p) => renderPointToPdf(p, pageBounds, renderPx))
}

function cropPolygonToFullRender(poly: Pt[], crop: PixelRect): Pt[] {
  return poly.map((p) => ({
    x: round3(crop.x + p.x),
    y: round3(crop.y + p.y),
  }))
}

function normalizePassA(parsed: unknown, renderPx: { width: number; height: number }): PassAResponse {
  const root = asObject(parsed) ?? {}
  const crop = asObject(root.crop_rect) ?? {}
  const width = clamp(finiteNumber(crop.width, renderPx.width * 0.8), 1, renderPx.width)
  const height = clamp(finiteNumber(crop.height, renderPx.height * 0.8), 1, renderPx.height)
  const x = clamp(finiteNumber(crop.x, renderPx.width * 0.1), 0, Math.max(0, renderPx.width - width))
  const y = clamp(finiteNumber(crop.y, renderPx.height * 0.1), 0, Math.max(0, renderPx.height - height))
  const pageType = asString(root.page_type, "other") as PageType
  return {
    page_type: pageType,
    crop_rect: {
      x: round3(x),
      y: round3(y),
      width: round3(width),
      height: round3(height),
      confidence: clamp(finiteNumber(crop.confidence, 0.5), 0, 1),
    },
    notes: asStringArray(root.notes),
  }
}

function normalizePassB(parsed: unknown): PassBResponse {
  const root = asObject(parsed) ?? {}
  const unit = asObject(root.unit_outline_hint) ?? {}
  const majorRaw = Array.isArray(root.major_spaces) ? root.major_spaces : []
  const openRaw = Array.isArray(root.shared_open_plan_envelopes) ? root.shared_open_plan_envelopes : []
  const auxRaw = Array.isArray(root.auxiliary_spaces) ? root.auxiliary_spaces : []

  return {
    unit_outline_hint: {
      vertices: normalizePolygon(unit.vertices),
      confidence: clamp(finiteNumber(unit.confidence, 0.4), 0, 1),
      notes: asString(unit.notes, ""),
    },
    major_spaces: majorRaw
      .map((item) => {
        const o = asObject(item) ?? {}
        const spaceType = asString(o.space_type, "enclosed_room") as MajorSpaceType
        return {
          label: asString(o.label, "Unnamed Space"),
          space_type: spaceType === "open_plan_subzone" ? "open_plan_subzone" : "enclosed_room",
          polygon: normalizePolygon(o.polygon),
          confidence: clamp(finiteNumber(o.confidence, 0.4), 0, 1),
        }
      })
      .filter((item) => item.polygon.length >= 3),
    shared_open_plan_envelopes: openRaw
      .map((item) => {
        const o = asObject(item) ?? {}
        return {
          member_labels: asStringArray(o.member_labels),
          polygon: normalizePolygon(o.polygon),
          confidence: clamp(finiteNumber(o.confidence, 0.4), 0, 1),
        }
      })
      .filter((item) => item.member_labels.length > 0 && item.polygon.length >= 3),
    auxiliary_spaces: auxRaw
      .map((item) => {
        const o = asObject(item) ?? {}
        return {
          label: asString(o.label, "Auxiliary Space"),
          polygon: normalizePolygon(o.polygon),
          confidence: clamp(finiteNumber(o.confidence, 0.4), 0, 1),
        }
      })
      .filter((item) => item.polygon.length >= 3),
    notes: asStringArray(root.notes),
  }
}

function buildDeterministicSeedCrop(
  pageBounds: PlanBoundingBox,
  renderPx: { width: number; height: number },
  opts: BuildFloorplanAiSemanticHintsOptions
): PixelRect | null {
  const unitBox = bboxOfPoly(opts.recoveredUnitPolygon ?? [])
  const sourceBox = unitBox ?? opts.mainPlanBodyBBox ?? null
  if (!sourceBox) return null
  return padRectPx(pdfBoxToRenderRect(sourceBox, pageBounds, renderPx), unitBox ? 0.06 : 0.12, renderPx)
}

function stabilizeCropRect(
  modelCrop: PixelRect,
  seedCrop: PixelRect | null,
  renderPx: { width: number; height: number }
): { cropRect: PixelRect; notes: string[] } {
  const normalized = padRectPx(modelCrop, 0, renderPx)
  if (!seedCrop) {
    return {
      cropRect: normalized,
      notes: ["AI crop used without deterministic seed crop."],
    }
  }
  const paddedSeed = padRectPx(seedCrop, 0.05, renderPx)
  const overlap = intersectRects(normalized, paddedSeed)
  const overlapShare = overlap ? rectArea(overlap) / Math.max(1, rectArea(normalized)) : 0
  if (overlap && overlapShare >= 0.2) {
    return {
      cropRect: overlap,
      notes: ["AI crop intersected with deterministic geometry crop."],
    }
  }
  return {
    cropRect: paddedSeed,
    notes: ["Deterministic geometry crop overrode weak/non-overlapping AI crop."],
  }
}

function cropPolygonToRenderBounds(poly: Pt[], crop: PixelRect): Pt[] {
  return poly
    .map((p) => ({
      x: round3(clamp(p.x, 0, crop.width)),
      y: round3(clamp(p.y, 0, crop.height)),
    }))
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
}

async function callOpenAiVisionJsonSchema(
  apiKey: string,
  model: string,
  imageUrl: string,
  prompt: string,
  jsonSchema: { name: string; strict: true; schema: Record<string, unknown> }
): Promise<{ raw: string; parsed: unknown }> {
  const payloadJson = JSON.stringify({
    model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: imageUrl } },
        ],
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: jsonSchema,
    },
    max_tokens: 4096,
    temperature: 0.15,
  })

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: payloadJson,
  })

  const responseText = await res.text()
  if (!res.ok) {
    throw new Error(
      `OpenAI HTTP ${res.status}: ${responseText.slice(0, 500)}`
    )
  }
  const outer = JSON.parse(responseText) as {
    choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>
  }
  const content = outer.choices?.[0]?.message?.content
  const raw =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((part) => (part?.type === "text" ? part.text ?? "" : "")).join("")
        : ""
  if (!raw.trim()) {
    throw new Error("OpenAI returned empty structured content.")
  }
  return {
    raw,
    parsed: JSON.parse(raw),
  }
}

function buildPassAPrompt(
  renderPx: { width: number; height: number },
  seedCrop: PixelRect | null
): string {
  const seedText = seedCrop
    ? `A deterministic geometry pass suggests the main apartment plan is roughly inside x=${seedCrop.x.toFixed(0)}, y=${seedCrop.y.toFixed(0)}, width=${seedCrop.width.toFixed(0)}, height=${seedCrop.height.toFixed(0)} in this rendered image. Use it only as a hint, not a requirement.`
    : "No deterministic crop hint is available."

  return [
    "You are analyzing a rendered brochure-style apartment floorplan page.",
    "Task: understand the page globally before polygon extraction.",
    `The image coordinate system is rendered-image pixels with origin at the top-left. Image size: ${renderPx.width}x${renderPx.height}.`,
    "Return only the schema fields.",
    "Choose page_type based on the full page, not just the unit region.",
    "crop_rect must isolate the main plan-body / apartment unit drawing region and exclude brochure chrome as much as possible: legends, logos, disclaimers, title blocks, marketing copy, surrounding margins, and unrelated tower context.",
    "Exclude obvious brochure blank space and non-unit page regions from crop_rect whenever possible.",
    "If there is one main residential brochure floorplan on the page, crop_rect should tightly contain that plan drawing.",
    seedText,
  ].join("\n")
}

function buildPassBPrompt(cropPx: { width: number; height: number }): string {
  return [
    "You are analyzing a cropped apartment floorplan region from a brochure page.",
    `All coordinates you return must be in THIS CROPPED IMAGE pixel space only, with origin at the crop top-left and size ${cropPx.width}x${cropPx.height}.`,
    "Do not return PDF coordinates, meters, or normalized values.",
    "Return semantic hints only, not precise geometry.",
    "unit_outline_hint should trace the outer apartment shell approximately, preserving major notches, recesses, bay windows, jogs, and non-rectangular silhouette changes when visible.",
    "Do NOT return a simple rectangle unless the visible apartment shell is actually rectangular.",
    "Do NOT use the crop rectangle as the unit outline unless the visible apartment shell truly fills the crop as a rectangle, which is rare.",
    "Allow concavities, protrusions, and cut-ins when they are visible in the outer silhouette.",
    "Exclude brochure blank space, crop padding, and non-unit page regions from the unit outline.",
    "The unit outline should usually have more than 4 vertices if the visible shell is not a simple rectangle.",
    "major_spaces must use space_type enclosed_room or open_plan_subzone.",
    "PRIMARY BEDROOM, BEDROOM 2, STUDY, and FAMILY ROOM should usually be enclosed_room when they appear visually bounded by local walls.",
    "KITCHEN and LIVING / DINING may share one open-plan envelope and should be represented in shared_open_plan_envelopes when appropriate.",
    "Do not force KITCHEN into a separate enclosed_room polygon unless it is clearly walled off from the neighboring living/dining area.",
    "enclosed_room polygons should stay close to visible local wall-bounded structure and should avoid spilling into adjacent open-plan zones, corridors, or neighboring rooms.",
    "Be conservative with enclosed_room extent: smaller wall-bounded hints are better than oversized spillover polygons.",
    "auxiliary_spaces should include spaces like foyer, hall, bath, laundry, storage, balcony, utility, or closet when visible.",
    "Use polygons with enough vertices to describe the visible shape, but keep them approximate. Prefer fidelity to broad layout over perfect precision.",
    "Do not snap every polygon to a coarse box. Follow the actual visible walls and labels as much as possible.",
    "If a space is clearly visible and labeled, include it rather than omitting it.",
    "Return only the schema fields.",
  ].join("\n")
}

function buildSemanticQualityWarnings(
  opts: BuildFloorplanAiSemanticHintsOptions | undefined,
  unitRendered: Pt[],
  majorSpaces: Array<{ label: string; renderedImagePolygon: Pt[] }>,
  sharedOpenPlanEnvelopes: Array<{ memberLabels: string[]; renderedImagePolygon: Pt[] }>
): string[] {
  const warnings: string[] = []

  const recoveredPoly = opts?.recoveredUnitPolygon ?? []
  if (recoveredPoly.length >= 4 && !isNearlyRectangular(recoveredPoly) && isNearlyRectangular(unitRendered)) {
    warnings.push("[validation] unit_outline_hint is nearly rectangular while deterministic unit shell evidence appears non-rectangular.")
  }

  for (let i = 0; i < majorSpaces.length; i++) {
    for (let j = i + 1; j < majorSpaces.length; j++) {
      const a = majorSpaces[i]!
      const b = majorSpaces[j]!
      const overlap = boxIntersectionArea(bboxOfPoly(a.renderedImagePolygon), bboxOfPoly(b.renderedImagePolygon))
      const minArea = Math.min(polygonSupportArea(a.renderedImagePolygon), polygonSupportArea(b.renderedImagePolygon))
      if (minArea > 0 && overlap / minArea > 0.22) {
        warnings.push(`[validation] enclosed room overlap looks high between "${a.label}" and "${b.label}".`)
      }
    }
  }

  const unitArea = polygonSupportArea(unitRendered)
  for (const env of sharedOpenPlanEnvelopes) {
    const envArea = polygonSupportArea(env.renderedImagePolygon)
    if (unitArea <= 0 || envArea <= 0) continue
    const share = envArea / unitArea
    if (share < 0.04) {
      warnings.push(`[validation] shared open-plan envelope for ${env.memberLabels.join(" + ")} looks implausibly tiny.`)
    } else if (share > 0.88) {
      warnings.push(`[validation] shared open-plan envelope for ${env.memberLabels.join(" + ")} looks implausibly large.`)
    }
  }

  return warnings
}

export async function renderPdfPageForAiSemanticHints(
  pdfBytes: Uint8Array,
  opts?: Pick<BuildFloorplanAiSemanticHintsOptions, "pageIndex" | "renderScale" | "maxEdgePx">
): Promise<RenderedPdfPageForAi> {
  const globals = ensurePdfJsCanvasGlobals()
  if (!globals.ok) {
    throw new Error(`PDF canvas globals unavailable: ${globals.detail}`)
  }

  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs")
  const { getDocument } = pdfjs
  const safePdfBytes = new Uint8Array(pdfBytes)
  const loadingTask = getDocument({
    data: safePdfBytes,
    disableWorker: true,
    useSystemFonts: true,
    isEvalSupported: false,
  } as Parameters<typeof getDocument>[0])
  const pdf = await loadingTask.promise
  const pageNumber = clamp((opts?.pageIndex ?? 0) + 1, 1, pdf.numPages)
  const page = await pdf.getPage(pageNumber)
  const pageViewport = page.getViewport({ scale: 1 })
  const renderViewport = page.getViewport({ scale: opts?.renderScale ?? DEFAULT_RENDER_SCALE })
  const { createCanvas } = getCanvasModule()
  const canvas = createCanvas(Math.ceil(renderViewport.width), Math.ceil(renderViewport.height))
  const ctx = canvas.getContext("2d")
  const canvasFactory = createPdfJsCanvasFactory()
  ctx.fillStyle = "#ffffff"
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  await page.render({
    canvas,
    canvasContext: ctx,
    viewport: renderViewport,
    canvasFactory,
  }).promise

  const rawBuffer = canvas.toBuffer("image/png")
  const resized = await maybeResizePng(rawBuffer, opts?.maxEdgePx ?? DEFAULT_MAX_EDGE_PX)
  return {
    imageBuffer: resized.buffer,
    pageBounds: {
      minX: 0,
      minY: 0,
      maxX: pageViewport.width,
      maxY: pageViewport.height,
    },
    renderPx: {
      width: resized.width,
      height: resized.height,
    },
    pageIndex: pageNumber - 1,
  }
}

export async function buildFloorplanAiSemanticHintsResult(
  pdfBytes: Uint8Array,
  opts?: BuildFloorplanAiSemanticHintsOptions
): Promise<FloorplanAiSemanticHintsBuildResult | null> {
  const apiKey = opts?.openAiApiKey?.trim() || process.env.OPENAI_API_KEY?.trim()
  if (!apiKey) return null

  const model = opts?.model ?? DEFAULT_MODEL
  const startMs = Date.now()
  const rendered = await renderPdfPageForAiSemanticHints(pdfBytes, opts)
  const seedCrop = buildDeterministicSeedCrop(rendered.pageBounds, rendered.renderPx, opts ?? {})

  const fullPageDataUrl = toDataUrlPng(rendered.imageBuffer)
  const passA = await callOpenAiVisionJsonSchema(
    apiKey,
    model,
    fullPageDataUrl,
    buildPassAPrompt(rendered.renderPx, seedCrop),
    PASS_A_JSON_SCHEMA
  )
  const passAJson = normalizePassA(passA.parsed, rendered.renderPx)
  const cropStabilization = stabilizeCropRect(passAJson.crop_rect, seedCrop, rendered.renderPx)

  const sharp = (await import("sharp")).default
  const cropRect = cropStabilization.cropRect
  const croppedPlanPng = await sharp(rendered.imageBuffer)
    .extract({
      left: Math.max(0, Math.floor(cropRect.x)),
      top: Math.max(0, Math.floor(cropRect.y)),
      width: Math.max(1, Math.min(rendered.renderPx.width - Math.floor(cropRect.x), Math.ceil(cropRect.width))),
      height: Math.max(1, Math.min(rendered.renderPx.height - Math.floor(cropRect.y), Math.ceil(cropRect.height))),
    })
    .png()
    .toBuffer()

  const croppedPlanDataUrl = toDataUrlPng(croppedPlanPng)
  const passB = await callOpenAiVisionJsonSchema(
    apiKey,
    model,
    croppedPlanDataUrl,
    buildPassBPrompt({ width: Math.round(cropRect.width), height: Math.round(cropRect.height) }),
    PASS_B_JSON_SCHEMA
  )
  const passBJson = normalizePassB(passB.parsed)

  const unitRendered = cropPolygonToFullRender(cropPolygonToRenderBounds(passBJson.unit_outline_hint.vertices, cropRect), cropRect)
  const unitPdf = renderPolygonToPdf(unitRendered, rendered.pageBounds, rendered.renderPx)

  const majorSpaces = passBJson.major_spaces.map((space) => {
    const renderedImagePolygon = cropPolygonToFullRender(cropPolygonToRenderBounds(space.polygon, cropRect), cropRect)
    return {
      label: space.label,
      spaceType: space.space_type === "open_plan_subzone" ? "open_plan_subzone" : "enclosed_room",
      renderedImagePolygon,
      pdfPagePolygon: renderPolygonToPdf(renderedImagePolygon, rendered.pageBounds, rendered.renderPx),
      confidence: space.confidence,
    }
  })
  const sharedOpenPlanEnvelopes = passBJson.shared_open_plan_envelopes.map((env) => {
    const renderedImagePolygon = cropPolygonToFullRender(cropPolygonToRenderBounds(env.polygon, cropRect), cropRect)
    return {
      memberLabels: env.member_labels,
      renderedImagePolygon,
      pdfPagePolygon: renderPolygonToPdf(renderedImagePolygon, rendered.pageBounds, rendered.renderPx),
      confidence: env.confidence,
    }
  })
  const auxiliarySpaces = passBJson.auxiliary_spaces.map((space) => {
    const renderedImagePolygon = cropPolygonToFullRender(cropPolygonToRenderBounds(space.polygon, cropRect), cropRect)
    return {
      label: space.label,
      renderedImagePolygon,
      pdfPagePolygon: renderPolygonToPdf(renderedImagePolygon, rendered.pageBounds, rendered.renderPx),
      confidence: space.confidence,
    }
  })
  const qualityWarnings = buildSemanticQualityWarnings(
    opts,
    unitRendered,
    majorSpaces
      .filter((space) => space.spaceType === "enclosed_room")
      .map((space) => ({ label: space.label, renderedImagePolygon: space.renderedImagePolygon })),
    sharedOpenPlanEnvelopes.map((env) => ({ memberLabels: env.memberLabels, renderedImagePolygon: env.renderedImagePolygon }))
  )

  const hints: FloorplanAiSemanticHintsDebug = {
    pageType: passAJson.page_type,
    unitOutlineHint: {
      renderedImageVertices: unitRendered,
      pdfPageVertices: unitPdf,
      confidence: passBJson.unit_outline_hint.confidence,
      notes: passBJson.unit_outline_hint.notes || undefined,
    },
    majorSpaces,
    sharedOpenPlanEnvelopes,
    auxiliarySpaces,
    notes: uniqueNotes(
      passAJson.notes,
      cropStabilization.notes,
      passBJson.notes,
      qualityWarnings,
      [
        `Rendered full page at ${rendered.renderPx.width}x${rendered.renderPx.height} px.`,
        `Mapped rendered-image pixels back to PDF page coordinates using page bounds ${rendered.pageBounds.maxX.toFixed(1)}x${rendered.pageBounds.maxY.toFixed(1)}.`,
      ]
    ),
    modelUsed: model,
    renderPx: rendered.renderPx,
    cropRectPx: {
      x: round3(cropRect.x),
      y: round3(cropRect.y),
      width: round3(cropRect.width),
      height: round3(cropRect.height),
    },
    latencyMs: Date.now() - startMs,
    passAResponse: passA.raw,
    passBResponse: passB.raw,
  }

  return {
    hints,
    artifacts: {
      fullPagePng: rendered.imageBuffer,
      croppedPlanPng,
      passAJson,
      passBJson,
    },
  }
}

export async function buildFloorplanAiSemanticHints(
  pdfBytes: Uint8Array,
  opts?: BuildFloorplanAiSemanticHintsOptions
): Promise<FloorplanAiSemanticHintsDebug | null> {
  const result = await buildFloorplanAiSemanticHintsResult(pdfBytes, opts)
  return result?.hints ?? null
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;")
}

function polyPath(points: Pt[]): string {
  if (points.length < 2) return ""
  let d = `M ${points[0]!.x.toFixed(2)} ${points[0]!.y.toFixed(2)}`
  for (let i = 1; i < points.length; i++) d += ` L ${points[i]!.x.toFixed(2)} ${points[i]!.y.toFixed(2)}`
  return d + " Z"
}

export function buildFloorplanAiSemanticHintsOverlaySvgString(opts: {
  pageBounds: PlanBoundingBox
  hints: FloorplanAiSemanticHintsDebug
  mainPlanBodyBBox?: PlanBoundingBox | null
}): string {
  const { pageBounds, hints, mainPlanBodyBBox } = opts
  const width = pageBounds.maxX - pageBounds.minX
  const height = pageBounds.maxY - pageBounds.minY

  const bboxRect = mainPlanBodyBBox
    ? `<rect x="${mainPlanBodyBBox.minX.toFixed(2)}" y="${mainPlanBodyBBox.minY.toFixed(2)}" width="${(mainPlanBodyBBox.maxX - mainPlanBodyBBox.minX).toFixed(2)}" height="${(mainPlanBodyBBox.maxY - mainPlanBodyBBox.minY).toFixed(2)}" fill="none" stroke="#64748b" stroke-width="2" stroke-dasharray="6 4" />`
    : ""

  const cropRect = hints.cropRectPx
    ? `<rect x="${(pageBounds.minX + (hints.cropRectPx.x / hints.renderPx.width) * width).toFixed(2)}" y="${(pageBounds.minY + (hints.cropRectPx.y / hints.renderPx.height) * height).toFixed(2)}" width="${((hints.cropRectPx.width / hints.renderPx.width) * width).toFixed(2)}" height="${((hints.cropRectPx.height / hints.renderPx.height) * height).toFixed(2)}" fill="none" stroke="#f59e0b" stroke-width="2" stroke-dasharray="8 5" />`
    : ""

  const unitPath = polyPath(hints.unitOutlineHint.pdfPageVertices)
  const major = hints.majorSpaces
    .map(
      (space) =>
        `<path d="${polyPath(space.pdfPagePolygon)}" fill="${space.spaceType === "open_plan_subzone" ? "rgba(59,130,246,0.14)" : "rgba(34,197,94,0.14)"}" stroke="${space.spaceType === "open_plan_subzone" ? "#2563eb" : "#16a34a"}" stroke-width="2" />`
    )
    .join("")
  const auxiliary = hints.auxiliarySpaces
    .map((space) => `<path d="${polyPath(space.pdfPagePolygon)}" fill="rgba(168,85,247,0.12)" stroke="#9333ea" stroke-width="1.5" />`)
    .join("")
  const envelopes = hints.sharedOpenPlanEnvelopes
    .map((env) => `<path d="${polyPath(env.pdfPagePolygon)}" fill="none" stroke="#ef4444" stroke-width="2" stroke-dasharray="7 4" />`)
    .join("")

  const notes = hints.notes
    .slice(0, 4)
    .map((note, i) => `<text x="14" y="${24 + i * 18}" font-size="13" fill="#111827">${escapeXml(note)}</text>`)
    .join("")

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="${pageBounds.minX} ${pageBounds.minY} ${width} ${height}" width="${width}" height="${height}">
  <rect x="${pageBounds.minX}" y="${pageBounds.minY}" width="${width}" height="${height}" fill="#ffffff" />
  ${bboxRect}
  ${cropRect}
  ${unitPath ? `<path d="${unitPath}" fill="none" stroke="#111827" stroke-width="3" />` : ""}
  ${major}
  ${auxiliary}
  ${envelopes}
  <g>${notes}</g>
</svg>`
}
