#!/usr/bin/env node
/**
 * Minimal fal-ai/trellis (single image) → GLB using only global fetch (Node 18+).
 * Does NOT add npm dependencies. Does NOT update Supabase.
 *
 * API (REST): https://docs.fal.ai/model-endpoints/queue
 * Model: https://fal.ai/models/fal-ai/trellis/api
 *
 * Prerequisites:
 *   - Node 18+ (fetch available)
 *   - FAL_KEY in env (see below)
 *
 * Usage:
 *   export FAL_KEY="your_fal_api_key"
 *   node scripts/fal_trellis_generate_glb.mjs "https://example.com/sofa.jpg"
 *
 * Optional: merge .env.local (same pattern as other scripts) if FAL_KEY is there.
 *
 * Output:
 *   pipelines/trellis/generated/<product_id>/model.glb
 *   (<product_id> defaults to GLOSTAD UUID; pass as 2nd CLI arg for another SKU)
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs"
import { resolve, dirname } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, "..")

const DEFAULT_PRODUCT_ID = "325e9836-68f9-469c-8ed1-c7e9ce9e7555"
const MODEL_ID = "fal-ai/trellis"
const QUEUE_BASE = "https://queue.fal.run"

const POLL_MS = 2000
const MAX_WAIT_MS = 20 * 60 * 1000

function loadEnvLocal() {
  const envPath = resolve(PROJECT_ROOT, ".env.local")
  if (!existsSync(envPath)) return
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([^#=]+)=(.*)$/)
    if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "")
  }
}

function authHeaders(key) {
  return {
    Authorization: `Key ${key}`,
    "Content-Type": "application/json",
  }
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms))
}

loadEnvLocal()

if (process.argv.includes("-h") || process.argv.includes("--help")) {
  console.log(`Usage: node scripts/fal_trellis_generate_glb.mjs <image_url> [product_id]

  product_id: Supabase products.id (UUID). Default: ${DEFAULT_PRODUCT_ID} (GLOSTAD)

Environment:
  export FAL_KEY="your_fal_api_key"
  # or add FAL_KEY=... to .env.local (this script loads it automatically)

Examples:
  node scripts/fal_trellis_generate_glb.mjs "https://example.com/sofa.jpg"
  node scripts/fal_trellis_generate_glb.mjs "https://example.com/sofa.jpg" <your-product-uuid>

Output:
  pipelines/trellis/generated/<product_id>/model.glb
`)
  process.exit(0)
}

const imageUrl = process.argv[2]
if (!imageUrl || imageUrl.startsWith("-")) {
  console.error("Missing <image_url>. Run with --help for usage.")
  process.exit(1)
}

const productId = (process.argv[3]?.trim() || DEFAULT_PRODUCT_ID)
const OUTPUT_PATH = resolve(PROJECT_ROOT, "pipelines/trellis/generated", productId, "model.glb")

const falKey = process.env.FAL_KEY?.trim()
if (!falKey) {
  console.error("Missing FAL_KEY. Export it or set in .env.local")
  process.exit(1)
}

const submitUrl = `${QUEUE_BASE}/${MODEL_ID}`
const body = JSON.stringify({ image_url: imageUrl.trim() })

console.log("Submitting to fal queue:", submitUrl)
console.log("product_id (output folder):", productId)
console.log("Request body:", body)

const submitRes = await fetch(submitUrl, {
  method: "POST",
  headers: authHeaders(falKey),
  body,
})

const submitText = await submitRes.text()
let submitJson
try {
  submitJson = JSON.parse(submitText)
} catch {
  console.error("Submit non-JSON response:", submitRes.status, submitText.slice(0, 500))
  process.exit(1)
}

console.log("\n--- Raw submit response ---")
console.log(JSON.stringify(submitJson, null, 2))

if (!submitRes.ok) {
  console.error("Submit failed HTTP", submitRes.status)
  process.exit(1)
}

const requestId = submitJson.request_id
if (!requestId) {
  console.error("No request_id in submit response")
  process.exit(1)
}

const statusUrl =
  submitJson.status_url ?? `${QUEUE_BASE}/${MODEL_ID}/requests/${requestId}/status`
const resultUrl =
  submitJson.response_url ?? `${QUEUE_BASE}/${MODEL_ID}/requests/${requestId}`

const started = Date.now()
let lastStatus = null

while (Date.now() - started < MAX_WAIT_MS) {
  const stRes = await fetch(`${statusUrl}?logs=1`, { headers: authHeaders(falKey) })
  const stText = await stRes.text()
  let st
  try {
    st = JSON.parse(stText)
  } catch {
    console.error("Status non-JSON:", stRes.status, stText.slice(0, 300))
    process.exit(1)
  }

  lastStatus = st
  console.log("\n--- Poll status ---", st.status, new Date().toISOString())
  if (st.logs?.length) {
    for (const log of st.logs) {
      console.log("  log:", log.message ?? log)
    }
  }

  if (st.status === "COMPLETED") {
    if (st.error) {
      console.error("Queue completed with error:", st.error, st.error_type)
      process.exit(1)
    }
    break
  }

  if (st.status !== "IN_QUEUE" && st.status !== "IN_PROGRESS") {
    console.error("Unexpected status:", st.status, stText)
    process.exit(1)
  }

  await sleep(POLL_MS)
}

if (Date.now() - started >= MAX_WAIT_MS) {
  console.error("Timed out waiting for COMPLETED. Last status:", JSON.stringify(lastStatus, null, 2))
  process.exit(1)
}

const resultRes = await fetch(resultUrl, { headers: authHeaders(falKey) })
const resultText = await resultRes.text()
let resultJson
try {
  resultJson = JSON.parse(resultText)
} catch {
  console.error("Result non-JSON:", resultRes.status, resultText.slice(0, 500))
  process.exit(1)
}

console.log("\n--- Raw result response ---")
console.log(JSON.stringify(resultJson, null, 2))

if (!resultRes.ok) {
  console.error("Result fetch failed HTTP", resultRes.status)
  process.exit(1)
}

const payload = resultJson.data ?? resultJson
const meshUrl = payload.model_mesh?.url
if (!meshUrl) {
  console.error("No model_mesh.url in result. Keys:", Object.keys(resultJson))
  process.exit(1)
}

console.log("\nDownloading mesh from:", meshUrl)
const binRes = await fetch(meshUrl)
if (!binRes.ok) {
  console.error("Download failed HTTP", binRes.status)
  process.exit(1)
}

const buf = Buffer.from(await binRes.arrayBuffer())
mkdirSync(dirname(OUTPUT_PATH), { recursive: true })
writeFileSync(OUTPUT_PATH, buf)

console.log(`\nWrote ${buf.length} bytes → ${OUTPUT_PATH}`)
console.log("Next (optional): node pipelines/trellis/pipeline.mjs prepare-assets")
console.log("Supabase model_url: update only when you are ready to ship this asset.")
