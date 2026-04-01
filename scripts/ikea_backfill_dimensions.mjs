#!/usr/bin/env node
/**
 * Backfill product dimensions from IKEA product URLs.
 * Reads products from Supabase where product_url is set and dimensions are missing,
 * fetches the IKEA page, extracts JSON from hydrate scripts or __NEXT_DATA__,
 * parses width/depth/height (cm), converts to meters, and updates Supabase.
 *
 * Usage: node scripts/ikea_backfill_dimensions.mjs
 * Requires: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY in env (e.g. from .env.local)
 *
 * Set DEBUG_ONE=true to process only the first product, save debug files, and exit without updating DB.
 * Set DEBUG_URL=<url> to skip Supabase and run extraction on that URL (synthetic product, no DB update).
 * Set CHAISE_RECHECK=true to re-backfill only chaise/sectional sofas (fixes old mapping).
 */

import { createClient } from "@supabase/supabase-js"
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs"
import { resolve } from "path"

const DEBUG_ONE = process.env.DEBUG_ONE === "true" || process.env.DEBUG_ONE === "1"
const CHAISE_RECHECK = process.env.CHAISE_RECHECK === "true" || process.env.CHAISE_RECHECK === "1"

// Load .env.local if present
const envPath = resolve(process.cwd(), ".env.local")
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([^#=]+)=(.*)$/)
    if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "")
  }
}

const LIMIT = 10

// Realistic furniture dimension ranges in cm
const WIDTH_DEPTH_MIN = 20
const WIDTH_DEPTH_MAX = 400
const HEIGHT_MIN = 20
const HEIGHT_MAX = 250

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!url || !serviceRoleKey) {
  console.error("Missing env: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY")
  process.exit(1)
}

const supabase = createClient(url, serviceRoleKey, { auth: { persistSession: false } })

// --- Helpers ---

function toNumber(v) {
  if (typeof v === "number" && !Number.isNaN(v)) return v
  if (typeof v === "string") {
    const n = parseFloat(v.replace(/[^\d.-]/g, ""))
    return Number.isNaN(n) ? null : n
  }
  return null
}

function inRange(v, min, max) {
  const n = toNumber(v)
  return n != null && n >= min && n <= max ? n : null
}

/** Round meters to 3 decimal places for logging and DB. */
function roundM(v) {
  if (v == null) return null
  return Math.round(v * 1000) / 1000
}

// --- Bundle/set detection ---

const BUNDLE_TITLE_PHRASES = [
  "and 2 chairs",
  "and chairs",
  " and chair",
  " set",
  " set ",
  "table and",
  "desk and",
  "bench and",
]

const BUNDLE_OBJECT_PREFIXES = ["table", "chair", "chairs", "desk", "bench", "stool", "shelf"]

/** Returns true if title suggests a bundle/set product. */
function isBundleTitle(title) {
  if (!title || typeof title !== "string") return false
  const t = title.toLowerCase()
  return BUNDLE_TITLE_PHRASES.some((phrase) => t.includes(phrase))
}

/** Returns true if measurement labels suggest multiple different furniture pieces (e.g. Table + Chair). */
function hasMixedObjectLabels(entries) {
  if (!entries || !Array.isArray(entries)) return false
  const objects = new Set()
  for (const e of entries) {
    const label = String(e.name ?? e.label ?? e.key ?? "").trim()
    const firstWord = label.split(/\s+/)[0]?.toLowerCase()
    if (firstWord && BUNDLE_OBJECT_PREFIXES.includes(firstWord)) {
      objects.add(firstWord)
    }
  }
  return objects.size >= 2
}

/** Returns true if product appears to be a bundle/set with mixed measurements. */
function isBundleOrSet(productTitle, rawMeasurementEntries) {
  if (isBundleTitle(productTitle)) return true
  if (hasMixedObjectLabels(rawMeasurementEntries)) return true
  return false
}

/**
 * Normalize raw width/depth/height to valid cm values. Out-of-range becomes null.
 */
function normalizeCmDims(raw) {
  const width = inRange(raw?.width ?? raw?.widthCm ?? raw?.Width, WIDTH_DEPTH_MIN, WIDTH_DEPTH_MAX)
  const depth = inRange(
    raw?.depth ?? raw?.depthCm ?? raw?.Depth ?? raw?.length ?? raw?.lengthCm ?? raw?.Length,
    WIDTH_DEPTH_MIN,
    WIDTH_DEPTH_MAX
  )
  const height = inRange(raw?.height ?? raw?.heightCm ?? raw?.Height, HEIGHT_MIN, HEIGHT_MAX)
  return { width: width ?? null, depth: depth ?? null, height: height ?? null }
}

// --- Dimension extraction ---

/**
 * Try to extract dimensions from an object with width/depth/height-like keys.
 * Returns { dims, score, path } or null. Only valid if >= 2 dimensions after normalization.
 */
function dimsFromObject(obj, path = "") {
  if (!obj || typeof obj !== "object") return null
  const raw = {
    width: obj.width ?? obj.widthCm ?? obj.Width,
    depth: obj.depth ?? obj.depthCm ?? obj.Depth ?? obj.length ?? obj.lengthCm ?? obj.Length,
    height: obj.height ?? obj.heightCm ?? obj.Height,
  }
  const dims = normalizeCmDims(raw)
  const validCount = [dims.width, dims.depth, dims.height].filter((x) => x != null).length
  if (validCount < 2) return null

  let score = 0
  const pathLower = path.toLowerCase()
  if (pathLower.includes("dimension") || pathLower.includes("measurement")) score += 10
  if (pathLower.includes("cm") || JSON.stringify(obj).toLowerCase().includes('"cm"')) score += 5
  if (validCount === 3) score += 5
  return { dims, score, path, rawEntries: null }
}

/**
 * Label priority for width: prefer overall "Width", exclude seat/armrest.
 * Returns 0 = ignore, higher = prefer.
 */
function getWidthPriority(label) {
  const L = label.toLowerCase().trim()
  if (L.includes("armrest") && L.includes("width")) return 0
  if (L.includes("seat") && L.includes("width")) return 0
  if (L === "width") return 10
  if (L.includes("width")) return 5
  return 0
}

/**
 * Label priority for depth: prefer overall "Depth"/"Length", exclude seat.
 */
function getDepthPriority(label) {
  const L = label.toLowerCase().trim()
  if (L.includes("seat") && (L.includes("depth") || L.includes("length"))) return 0
  if (L.includes("package")) return 0
  if (L === "depth" || L === "length") return 10
  if (L.includes("depth") || L.includes("length")) return 5
  return 0
}

/**
 * Label priority for height: prefer overall/outer, penalize seat/backrest/armrest/under.
 * Priority: "Height including back cushions" > "Overall height" > "Height" > "Backrest height" > "Seat height"
 */
function getHeightPriority(label) {
  const L = label.toLowerCase().trim()
  if (L.includes("height under") || L.includes("under furniture")) return 0
  if (L.includes("armrest") && L.includes("height")) return 0
  if (L.includes("height including back cushions") || L.includes("height incl")) return 100
  if (L.includes("overall height")) return 90
  if (L === "height") return 80
  if (L.includes("backrest") && L.includes("height")) return 20
  if (L.includes("seat") && L.includes("height")) return 10
  if (L.includes("height")) return 5
  return 0
}

/** True if label is seat-related (internal/subcomponent), even with chaise/lounge. */
function isSeatRelatedLabel(label) {
  const L = (label ?? "").toLowerCase()
  return (
    L.includes("seat width") ||
    L.includes("seat depth") ||
    L.includes("seat height") ||
    (L.includes("seat") && (L.includes("chaise") || L.includes("lounge")))
  )
}

/** True if label is overall chaise footprint (not seat-internal). */
function isOverallChaiseDepthLabel(label) {
  const L = (label ?? "").toLowerCase()
  if (isSeatRelatedLabel(label)) return false
  if (!L.includes("chaise") && !L.includes("sectional")) return false
  return L.includes("depth") || L.includes("length")
}

/** True if label is overall dimension (not seat/armrest/under). */
function isOverallDimension(label, dimType) {
  const L = (label ?? "").toLowerCase()
  if (L.includes("seat") || L.includes("armrest") || L.includes("under furniture")) return false
  if (dimType === "height" && (L.includes("backrest") || L.includes("seat"))) return false
  return true
}

/**
 * Semantic dimension reselection: re-pick width/depth/height from measurement entries
 * using product-type-aware label priority. Returns { dims, chosenLabels, labelTypes }.
 */
function semanticReselectDimensions(productTitle, rawEntries, fallbackDims) {
  if (!rawEntries || !Array.isArray(rawEntries) || rawEntries.length < 2) {
    return { dims: fallbackDims, chosenLabels: null, labelTypes: null }
  }

  const titleLower = (productTitle ?? "").toLowerCase()
  const labels = rawEntries.map((e) => {
    const label = String(e.name ?? e.label ?? e.key ?? "").trim()
    let value = parseMeasureToCm(e.measure ?? e.text ?? "")
    if (value == null) {
      const v = toNumber(e.value)
      if (v != null && (e.text?.includes('"') || e.text?.includes("\u2033"))) value = v * 2.54
      else if (v != null) value = v
    }
    return { label, value }
  })
  const hasLabel = (s) => labels.some((l) => l.label.toLowerCase().includes(s))

  let productType = "normal_sofa"
  if (hasLabel("diameter")) productType = "round_table"
  else if (
    titleLower.includes("chaise") ||
    titleLower.includes("sectional") ||
    hasLabel("chaise") ||
    hasLabel("depth chaise")
  )
    productType = "chaise"
  else if (titleLower.includes("table") || titleLower.includes("desk"))
    productType = "table"

  const best = {
    width: { value: null, priority: 0, label: null },
    depth: { value: null, priority: 0, label: null },
    height: { value: null, priority: 0, label: null },
  }

  for (const { label, value } of labels) {
    if (value == null) continue
    const L = label.toLowerCase()

    let wP = getWidthPriority(L)
    if (isSeatRelatedLabel(label)) wP = 0
    if (productType === "round_table" && L.includes("diameter")) wP = 50
    if (wP > best.width.priority) best.width = { value, priority: wP, label }

    let hP = getHeightPriority(L)
    if (hP > best.height.priority) best.height = { value, priority: hP, label }

    let dP = 0
    if (productType === "round_table") {
      if (L.includes("diameter")) dP = 50
    } else if (productType === "chaise") {
      if (isSeatRelatedLabel(label) && (L.includes("depth") || L.includes("length"))) {
        dP = 1
      } else if (isOverallChaiseDepthLabel(label)) {
        dP = 100
      } else if (L === "depth" || (L.includes("depth") && !L.includes("seat"))) {
        dP = 20
      } else if (L === "length" || (L.includes("length") && !L.includes("seat"))) {
        dP = 10
      }
    } else if (productType === "table") {
      if (L === "length" || (L.includes("length") && !L.includes("seat"))) dP = 15
      if (L === "depth" || (L.includes("depth") && !L.includes("seat"))) dP = Math.max(dP, 10)
    } else {
      dP = getDepthPriority(L)
    }
    if (dP > best.depth.priority) best.depth = { value, priority: dP, label }
  }

  let width = best.width.value
  let depth = best.depth.value
  const height = best.height.value

  if (productType === "round_table" && best.width.value != null) {
    depth = best.width.value
  }

  const raw = { width, depth, height }
  const dims = normalizeCmDims(raw)
  const chosenLabels = {
    width: best.width.label,
    depth: best.depth.label,
    height: best.height.label,
  }
  const labelTypes = {
    width: best.width.label ? (isOverallDimension(best.width.label, "width") ? "overall" : "internal/seat") : null,
    depth: best.depth.label
      ? isSeatRelatedLabel(best.depth.label)
        ? "internal/seat"
        : isOverallChaiseDepthLabel(best.depth.label)
          ? "overall"
          : isOverallDimension(best.depth.label, "depth")
            ? "overall"
            : "internal/seat"
      : null,
    height: best.height.label ? (isOverallDimension(best.height.label, "height") ? "overall" : "internal/seat") : null,
  }
  return { dims, chosenLabels, labelTypes }
}

/**
 * Parse measure string like "67 3/8 \"" or "30 3/4 \"" (inches) to cm.
 */
function parseMeasureToCm(measureStr) {
  if (typeof measureStr !== "string") return null
  const m = measureStr.match(/^([\d\s]+)(?:\s+(\d+)\/(\d+))?\s*[""]?\s*$/i)
  if (!m) return null
  let whole = parseFloat(m[1].replace(/\s/g, "")) || 0
  if (m[2] && m[3]) whole += Number(m[2]) / Number(m[3])
  return whole * 2.54 // inches to cm
}

/**
 * Try to extract dimensions from a labeled array using semantic label priority.
 */
function dimsFromLabeledArray(arr, path = "") {
  if (!Array.isArray(arr) || arr.length < 2) return null
  const best = { width: { value: null, priority: 0 }, depth: { value: null, priority: 0 }, height: { value: null, priority: 0 } }
  let hasCm = false

  for (const item of arr) {
    if (!item || typeof item !== "object") continue
    const label = String(item.label ?? item.name ?? item.key ?? "")
    const labelLower = label.toLowerCase()
    let value = toNumber(item.value ?? item.amount ?? item.size)
    const unit = String(item.unit ?? item.Unit ?? item.text ?? "").toLowerCase()
    if (unit.includes("cm")) hasCm = true
    if (value == null && item.measure) value = parseMeasureToCm(String(item.measure))
    if (value == null) continue

    if (unit.includes('"') || unit.includes("in") || (item.text && /["\u2033]/.test(item.text))) {
      value = value * 2.54
    }

    const wP = getWidthPriority(labelLower)
    if (wP > best.width.priority) best.width = { value, priority: wP }
    const dP = getDepthPriority(labelLower)
    if (dP > best.depth.priority) best.depth = { value, priority: dP }
    const hP = getHeightPriority(labelLower)
    if (hP > best.height.priority) best.height = { value, priority: hP }
  }

  const raw = {
    width: best.width.value,
    depth: best.depth.value,
    height: best.height.value,
  }
  const dims = normalizeCmDims(raw)
  const validCount = [dims.width, dims.depth, dims.height].filter((x) => x != null).length
  if (validCount < 2) return null

  let score = 0
  const pathLower = path.toLowerCase()
  if (pathLower.includes("dimension") || pathLower.includes("measurement")) score += 10
  if (hasCm) score += 5
  if (validCount === 3) score += 5
  return { dims, score, path, rawEntries: arr }
}

/**
 * Extract from IKEA measurementsProps.measurements format:
 * [{ name: "Width", measure: "67 3/8 \"" }, { name: "Depth", measure: "30 3/4 \"" }, ...]
 * Uses semantic label priority to prefer overall/outer dimensions over seat/backrest/armrest.
 */
function dimsFromMeasuredArray(arr, path = "") {
  if (!Array.isArray(arr) || arr.length < 2) return null
  const best = { width: { value: null, priority: 0 }, depth: { value: null, priority: 0 }, height: { value: null, priority: 0 } }

  for (const item of arr) {
    if (!item || typeof item !== "object") continue
    const name = String(item.name ?? item.label ?? "")
    const nameLower = name.toLowerCase()
    const measureStr = item.measure ?? item.text ?? ""
    const value = parseMeasureToCm(measureStr) ?? toNumber(item.value)
    if (value == null) continue

    const wP = getWidthPriority(nameLower)
    if (wP > best.width.priority) best.width = { value, priority: wP }
    const dP = getDepthPriority(nameLower)
    if (dP > best.depth.priority) best.depth = { value, priority: dP }
    const hP = getHeightPriority(nameLower)
    if (hP > best.height.priority) best.height = { value, priority: hP }
  }

  const raw = {
    width: best.width.value,
    depth: best.depth.value,
    height: best.height.value,
  }
  const dims = normalizeCmDims(raw)
  const validCount = [dims.width, dims.depth, dims.height].filter((x) => x != null).length
  if (validCount < 2) return null

  let score = 15
  const pathLower = path.toLowerCase()
  if (pathLower.includes("measurementsprops") || pathLower.includes("measurements")) score += 10
  if (pathLower.includes("productinformationsection")) score += 5
  if (validCount === 3) score += 5
  return { dims, score, path, rawEntries: arr }
}

/**
 * Recursively collect ALL dimension candidates from parsed JSON.
 * Returns array of { dims, score, path }.
 */
function findDimensionCandidates(data, path = "", depth = 0) {
  if (depth > 15) return []
  if (!data || typeof data !== "object") return []

  const candidates = []

  if (typeof data === "object" && !Array.isArray(data)) {
    const objResult = dimsFromObject(data, path)
    if (objResult) candidates.push(objResult)
  }

  if (Array.isArray(data)) {
    const labeled = dimsFromLabeledArray(data, path)
    if (labeled) candidates.push(labeled)
    const measured = dimsFromMeasuredArray(data, path)
    if (measured) candidates.push(measured)
  }

  const prefix = path ? `${path}.` : ""
  for (const [key, val] of Object.entries(data)) {
    candidates.push(
      ...findDimensionCandidates(val, `${prefix}${key}`, depth + 1)
    )
  }

  return candidates
}

/**
 * Block-level context scorer: rewards product data, penalizes rewards/loyalty/marketing.
 */
function scoreBlockContext(obj, rawStr) {
  const str = (rawStr ?? JSON.stringify(obj)).toLowerCase()
  let score = 0

  if (str.includes("product")) score += 5
  if (str.includes("article")) score += 5
  if (str.includes("price")) score += 3
  if (str.includes("dimensions")) score += 5
  if (str.includes("measurements")) score += 5

  if (str.includes("rewards")) score -= 8
  if (str.includes("earnedkeys")) score -= 8
  if (str.includes("voucher")) score -= 5
  if (str.includes("loyalty")) score -= 8
  if (str.includes("ikea family")) score -= 5
  if (str.includes("offers")) score -= 5

  return score
}

/**
 * From a single parsed block, find the best dimension candidate and combine with block context.
 */
function extractBestDimensionsFromBlock(parsed, rawStr) {
  const blockScore = scoreBlockContext(parsed, rawStr)
  let candidates = findDimensionCandidates(parsed)

  // Deduplicate by path + width + depth + height (stable, keep first)
  const seen = new Set()
  candidates = candidates.filter((c) => {
    const key = `${c.path}|${c.dims?.width ?? "n"}|${c.dims?.depth ?? "n"}|${c.dims?.height ?? "n"}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  if (candidates.length === 0) return null

  // Prefer: 3 dims > 2 dims; avoid packaging; prefer dimension/measurement path
  const isPackagingPath = (path) => {
    const p = (path ?? "").toLowerCase()
    return p.includes("packaging") || p.includes("packages") || p.includes(".package")
  }
  const pathPenalty = (path) => (isPackagingPath(path) ? 100 : 0)
  candidates.sort((a, b) => {
    const aDims = [a.dims.width, a.dims.depth, a.dims.height].filter((x) => x != null).length
    const bDims = [b.dims.width, b.dims.depth, b.dims.height].filter((x) => x != null).length
    if (bDims !== aDims) return bDims - aDims
    const aPack = isPackagingPath(a.path)
    const bPack = isPackagingPath(b.path)
    if (aPack !== bPack) return aPack ? 1 : -1 // non-packaging first
    const aPenalty = pathPenalty(a.path)
    const bPenalty = pathPenalty(b.path)
    if (aPenalty !== bPenalty) return aPenalty - bPenalty
    const aPath = a.path.toLowerCase()
    const bPath = b.path.toLowerCase()
    const aPathBonus = aPath.includes("dimension") || aPath.includes("measurement") ? 1 : 0
    const bPathBonus = bPath.includes("dimension") || bPath.includes("measurement") ? 1 : 0
    if (bPathBonus !== aPathBonus) return bPathBonus - aPathBonus
    return b.score - a.score
  })

  const best = candidates[0]
  const totalScore = best.score + blockScore
  const PACKAGING_SCORE_PENALTY = 200
  const topCandidates = candidates.slice(0, 3).map((c) => ({
    path: c.path,
    dims: c.dims,
    score: isPackagingPath(c.path) ? c.score - PACKAGING_SCORE_PENALTY : c.score,
  }))
  return {
    dims: best.dims,
    candidatePath: best.path,
    candidateScore: best.score,
    blockScore,
    totalScore,
    topCandidates,
    rawMeasurementEntries: best.rawEntries ?? null,
  }
}

/**
 * Parse all hydrate blocks and __NEXT_DATA__, pick the best dimension candidate across all blocks.
 */
function pickProductJson(html) {
  const blocks = []

  const hydrateMatches = [
    ...html.matchAll(/<script[^>]*type="text\/hydrate"[^>]*>([\s\S]*?)<\/script>/g),
  ]
  for (const m of hydrateMatches) {
    try {
      const raw = m[1]
      const parsed = JSON.parse(raw)
      blocks.push({ parsed, raw, source: "hydrate" })
    } catch {
      // ignore
    }
  }

  const nextMatch = html.match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/
  )
  if (nextMatch) {
    try {
      const raw = nextMatch[1]
      const parsed = JSON.parse(raw)
      blocks.push({ parsed, raw, source: "__NEXT_DATA__" })
    } catch {
      // ignore
    }
  }

  if (blocks.length === 0) return null

  let best = null

  for (const { parsed, raw, source } of blocks) {
    const result = extractBestDimensionsFromBlock(parsed, raw)
    if (!result) continue
    if (!best || result.totalScore > best.totalScore) {
      best = {
        json: parsed,
        dims: result.dims,
        source,
        score: result.totalScore,
        candidatePath: result.candidatePath,
        candidateScore: result.candidateScore,
        blockScore: result.blockScore,
        topCandidates: result.topCandidates,
        rawMeasurementEntries: result.rawMeasurementEntries,
      }
    }
  }

  if (!best) return null

  return {
    json: best.json,
    dims: best.dims,
    source: best.source,
    score: best.score,
    candidatePath: best.candidatePath,
    topCandidates: best.topCandidates ?? [],
    rawMeasurementEntries: best.rawMeasurementEntries ?? null,
  }
}

// --- Main ---

function isChaiseOrSectional(p) {
  const t = (p.title ?? "").toLowerCase()
  const u = (p.product_url ?? "").toLowerCase()
  return (
    t.includes("chaise") ||
    t.includes("sectional") ||
    u.includes("chaise") ||
    u.includes("sectional")
  )
}

async function main() {
  let products
  if (process.env.DEBUG_URL) {
    const debugUrl = process.env.DEBUG_URL.trim()
    products = [{ id: "debug-url", title: "DEBUG_URL product", product_url: debugUrl }]
    console.log(`DEBUG_URL: using ${debugUrl} (skipping Supabase)\n`)
  } else if (CHAISE_RECHECK) {
    const { data: all, error: fetchError } = await supabase
      .from("products")
      .select("id, title, product_url, width_m, length_m, height_m")
      .not("product_url", "is", null)

    if (fetchError) {
      console.error("Supabase fetch error:", fetchError)
      process.exit(1)
    }
    products = (all ?? []).filter(isChaiseOrSectional)
    console.log(`CHAISE_RECHECK: found ${products.length} chaise/sectional products to re-backfill\n`)
  } else {
    const { data, error: fetchError } = await supabase
      .from("products")
      .select("id, title, product_url")
      .not("product_url", "is", null)
      .or("width_m.is.null,length_m.is.null,height_m.is.null")
      .limit(LIMIT)

    if (fetchError) {
      console.error("Supabase fetch error:", fetchError)
      process.exit(1)
    }
    products = data
  }

  console.log(
    `Found ${products.length} products to backfill${CHAISE_RECHECK ? " [CHAISE_RECHECK]" : ""}${!CHAISE_RECHECK && !process.env.DEBUG_URL ? ` (limit=${LIMIT})` : ""}${DEBUG_ONE ? " [DEBUG_ONE]" : ""}${process.env.DEBUG_URL ? " [DEBUG_URL]" : ""}\n`
  )

  const successes = []
  const failures = []

  for (const p of products) {
    const u = p.product_url?.trim()
    if (!u) continue

    try {
      const res = await fetch(u, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept: "text/html",
        },
        signal: AbortSignal.timeout(15000),
      })

      console.log("final url:", res.url)
      console.log("status:", res.status)

      if (!res.ok) {
        failures.push({ id: p.id, title: p.title, reason: `HTTP ${res.status}` })
        continue
      }

      const finalUrl = res.url
      const isProductPage = finalUrl.includes("/p/")
      if (!isProductPage) {
        const reason = `Redirected to non-product page: ${finalUrl}`
        failures.push({ id: p.id, title: p.title, reason })
        console.log("  ", reason)
        if (DEBUG_ONE) {
          const html = await res.text()
          mkdirSync(resolve(process.cwd(), "tmp"), { recursive: true })
          writeFileSync(resolve(process.cwd(), "tmp", `ikea_page_${p.id}.html`), html, "utf8")
          console.log(`Saved tmp/ikea_page_${p.id}.html for inspection`)
          break
        }
        continue
      }

      const html = await res.text()
      const result = pickProductJson(html)

      if (!result) {
        failures.push({ id: p.id, title: p.title, reason: "No product JSON found" })
        mkdirSync(resolve(process.cwd(), "tmp"), { recursive: true })
        writeFileSync(resolve(process.cwd(), "tmp", `ikea_page_${p.id}.html`), html, "utf8")
        console.log(`Saved tmp/ikea_page_${p.id}.html (no JSON found)`)
        if (DEBUG_ONE) break
        continue
      }

      const { json, dims, source, score, candidatePath, topCandidates = [], rawMeasurementEntries } = result

      const semantic = semanticReselectDimensions(p.title, rawMeasurementEntries, dims)
      const finalDims = semantic.dims
      const chosenLabels = semantic.chosenLabels
      const labelTypes = semantic.labelTypes

      const width_m = roundM(finalDims?.width != null ? finalDims.width / 100 : null)
      const length_m = roundM(finalDims?.depth != null ? finalDims.depth / 100 : null)
      const height_m = roundM(finalDims?.height != null ? finalDims.height / 100 : null)

      const dimCount = [width_m, length_m, height_m].filter((x) => x != null).length

      // Only update if at least 2 dimensions are valid
      const shouldUpdate = dimCount >= 2

      const pathLower = (candidatePath ?? "").toLowerCase()
      const pathContainsPackaging =
        pathLower.includes("packaging") || pathLower.includes("package") || pathLower.includes("packages")

      console.log("  path contains packaging/package/packages:", pathContainsPackaging)
      console.log("  dimCount:", dimCount)
      console.log(
        "  shouldUpdate:",
        shouldUpdate,
        shouldUpdate ? "(dimCount >= 2)" : `(dimCount ${dimCount} < 2)`
      )

      const bundleDetected = isBundleOrSet(p.title, rawMeasurementEntries)
      if (bundleDetected) {
        const reason = "Bundle/set product page with mixed measurements"
        failures.push({ id: p.id, title: p.title, reason })
        console.log("  bundle/set detection: triggered")
        if (DEBUG_ONE) {
          mkdirSync(resolve(process.cwd(), "tmp"), { recursive: true })
          writeFileSync(
            resolve(process.cwd(), "tmp", `ikea_page_${p.id}.html`),
            html,
            "utf8"
          )
          writeFileSync(
            resolve(process.cwd(), "tmp", `ikea_json_${p.id}.json`),
            JSON.stringify(json, null, 2),
            "utf8"
          )
          console.log(`Saved tmp/ikea_page_${p.id}.html and tmp/ikea_json_${p.id}.json`)
          if (rawMeasurementEntries && Array.isArray(rawMeasurementEntries)) {
            console.log("  raw measurement entries considered:")
            for (const e of rawMeasurementEntries) {
              const name = e.name ?? e.label ?? e.key ?? "(unnamed)"
              const measure = e.measure ?? e.text ?? e.value ?? "-"
              console.log(`    - "${name}": ${measure}`)
            }
          }
          console.log("  bundle/set detection was triggered - skipping DB update")
          break
        }
        continue
      }

      if (DEBUG_ONE) {
        mkdirSync(resolve(process.cwd(), "tmp"), { recursive: true })
        writeFileSync(
          resolve(process.cwd(), "tmp", `ikea_page_${p.id}.html`),
          html,
          "utf8"
        )
        writeFileSync(
          resolve(process.cwd(), "tmp", `ikea_json_${p.id}.json`),
          JSON.stringify(json, null, 2),
          "utf8"
        )
        console.log(`Saved tmp/ikea_page_${p.id}.html and tmp/ikea_json_${p.id}.json`)
        console.log("  chosen source:", source)
        console.log("  chosen score:", score)
        console.log("  chosen candidate path:", candidatePath || "(root)")
        console.log(
          "  chosen raw dims (cm):",
          `width=${finalDims?.width ?? "null"}, depth=${finalDims?.depth ?? "null"}, height=${finalDims?.height ?? "null"}`
        )
        console.log(
          "  converted dims (m):",
          `width_m=${width_m}, length_m=${length_m}, height_m=${height_m}`
        )
        if (chosenLabels) {
          console.log("  semantic mapping:")
          const fmt = (lbl, typ) => `"${lbl ?? "—"}" (${typ ?? "—"})`
          console.log(`    width_m <- ${fmt(chosenLabels.width, labelTypes?.width)}`)
          console.log(`    length_m <- ${fmt(chosenLabels.depth, labelTypes?.depth)}`)
          console.log(`    height_m <- ${fmt(chosenLabels.height, labelTypes?.height)}`)
        }
        if (rawMeasurementEntries && Array.isArray(rawMeasurementEntries)) {
          console.log("  raw measurement entries considered:")
          for (const e of rawMeasurementEntries) {
            const name = e.name ?? e.label ?? e.key ?? "(unnamed)"
            const measure = e.measure ?? e.text ?? e.value ?? "-"
            console.log(`    - "${name}": ${measure}`)
          }
        }
        console.log("  top 3 ranked candidates (raw, before semantic remapping):")
        for (let i = 0; i < Math.min(3, topCandidates.length); i++) {
          const c = topCandidates[i]
          const cd = c.dims
          console.log(
            `    #${i + 1} path=${c.path || "(root)"} dims(w=${cd?.width ?? "null"},d=${cd?.depth ?? "null"},h=${cd?.height ?? "null"}) score=${c.score}`
          )
        }
        console.log("DEBUG_ONE: exiting without DB update")
        break
      }

      if (!shouldUpdate) {
        failures.push({
          id: p.id,
          title: p.title,
          reason:
            dimCount === 0
              ? "No valid dimension candidates found"
              : dimCount === 1
                ? "Insufficient valid dimensions (need >= 2)"
                : "Dimensions out of realistic range",
        })
        continue
      }

      if (process.env.DEBUG_URL) {
        console.log("DEBUG_URL: skipping DB update")
        break
      }

      const { error: updateError } = await supabase
        .from("products")
        .update({ width_m, length_m, height_m })
        .eq("id", p.id)

      if (updateError) {
        failures.push({ id: p.id, title: p.title, reason: updateError.message })
        continue
      }

      successes.push({
        id: p.id,
        title: p.title,
        width_m,
        length_m,
        height_m,
      })

      if (CHAISE_RECHECK && (p.width_m != null || p.length_m != null || p.height_m != null)) {
        console.log(`  ${p.title} (${p.id}):`)
        console.log(`    BEFORE: width_m=${p.width_m ?? "null"}, length_m=${p.length_m ?? "null"}, height_m=${p.height_m ?? "null"}`)
        console.log(`    AFTER:  width_m=${width_m}, length_m=${length_m}, height_m=${height_m}`)
      } else {
        console.log(
          `  ${p.title}: width_m=${width_m}, length_m=${length_m}, height_m=${height_m}`
        )
      }
    } catch (err) {
      failures.push({
        id: p.id,
        title: p.title,
        reason: err?.message ?? String(err),
      })
    }
  }

  console.log("\n--- Successes ---")
  for (const s of successes) {
    console.log(`  ${s.title} (${s.id})`)
    console.log(`    width_m=${s.width_m}, length_m=${s.length_m}, height_m=${s.height_m}`)
  }

  console.log("\n--- Failures ---")
  for (const f of failures) {
    console.log(`  ${f.title} (${f.id}): ${f.reason}`)
  }

  console.log(`\nDone: ${successes.length} updated, ${failures.length} failed`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
