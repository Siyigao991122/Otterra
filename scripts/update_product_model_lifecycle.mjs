#!/usr/bin/env node
/**
 * Update model_url + 3D lifecycle fields for one product row (by id).
 *
 * Usage:
 *   node scripts/update_product_model_lifecycle.mjs \
 *     <product_uuid> \
 *     <model_url> \
 *     <model_status> \
 *     <model_source> \
 *     <model_version> \
 *     <model_notes>
 *
 * Also sets model_updated_at = now() (ISO timestamp from this machine).
 *
 * Requires: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (from .env.local or env)
 */

import { createClient } from "@supabase/supabase-js"
import { readFileSync, existsSync } from "fs"
import { resolve } from "path"

function loadEnvLocal() {
  const envPath = resolve(process.cwd(), ".env.local")
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^([^#=]+)=(.*)$/)
      if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "")
    }
  }
}

function isAllowedModelPath(p) {
  if (typeof p !== "string") return false
  const t = p.trim()
  if (!t.startsWith("/models/")) return false
  if (!t.toLowerCase().endsWith(".glb")) return false
  if (t.includes("..")) return false
  return true
}

const ALLOWED_MODEL_STATUS = new Set([
  "no_model",
  "stand_in",
  "generated_first_pass",
  "approved",
])

loadEnvLocal()

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!url || !serviceRoleKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY")
  process.exit(1)
}

const argv = process.argv.slice(2)
if (argv.includes("-h") || argv.includes("--help")) {
  const allowed = [...ALLOWED_MODEL_STATUS].join(", ")
  console.log(`Usage: node scripts/update_product_model_lifecycle.mjs
  <product_id> <model_url> <model_status> <model_source> <model_version> <model_notes>

model_url must look like /models/... ending in .glb (no path traversal)
model_status must be one of: ${allowed}
model_notes: quote if it contains spaces (exactly 6 arguments total)

Example (one line):
  node scripts/update_product_model_lifecycle.mjs 325e9836-68f9-469c-8ed1-c7e9ce9e7555 /models/325e9836-68f9-469c-8ed1-c7e9ce9e7555.glb generated_first_pass fal_trellis v1 "geometry acceptable, material too dark"`)
  process.exit(0)
}
if (argv.length !== 6) {
  console.error("Expected exactly 6 arguments. Run with --help for usage.")
  process.exit(1)
}

const [productId, modelUrlRaw, modelStatus, modelSource, modelVersion, modelNotes] = argv

const model_url = modelUrlRaw.trim()
if (!isAllowedModelPath(model_url)) {
  console.error("Invalid model_url: must be like /models/name.glb (no ..)")
  process.exit(1)
}

const statusTrim = modelStatus.trim()
if (!ALLOWED_MODEL_STATUS.has(statusTrim)) {
  console.error(
    `Invalid model_status "${statusTrim}". Allowed: ${[...ALLOWED_MODEL_STATUS].join(", ")}`
  )
  process.exit(1)
}

const model_source = modelSource.trim() || null
const model_version = modelVersion.trim() || null
const model_notes = modelNotes.trim() || null

const supabase = createClient(url, serviceRoleKey, { auth: { persistSession: false } })

const { data: row, error: qErr } = await supabase
  .from("products")
  .select("id, title, model_url, model_status, model_source, model_version, model_notes, model_updated_at")
  .eq("id", productId)
  .maybeSingle()

if (qErr) {
  console.error("Query error:", qErr)
  process.exit(1)
}

if (!row) {
  console.error(`No product found with id: ${productId}`)
  process.exit(1)
}

const fmt = (v) => (v == null || v === "" ? "(null)" : String(v))

console.log(`Product: ${row.title} (${row.id})\n`)
console.log("Before:")
console.log(`  model_url:      ${fmt(row.model_url)}`)
console.log(`  model_status:   ${fmt(row.model_status)}`)
console.log(`  model_source:   ${fmt(row.model_source)}`)
console.log(`  model_version:  ${fmt(row.model_version)}`)
console.log(`  model_notes:    ${fmt(row.model_notes)}`)

const model_updated_at = new Date().toISOString()

const { data: updated, error: upErr } = await supabase
  .from("products")
  .update({
    model_url,
    model_status: statusTrim,
    model_source,
    model_version,
    model_notes,
    model_updated_at,
  })
  .eq("id", productId)
  .select("model_url, model_status, model_source, model_version, model_notes, model_updated_at")
  .single()

if (upErr) {
  console.error("Update error:", upErr)
  process.exit(1)
}

console.log("\nAfter:")
console.log(`  model_url:      ${fmt(updated.model_url)}`)
console.log(`  model_status:   ${fmt(updated.model_status)}`)
console.log(`  model_source:   ${fmt(updated.model_source)}`)
console.log(`  model_version:  ${fmt(updated.model_version)}`)
console.log(`  model_notes:    ${fmt(updated.model_notes)}`)
console.log(`  model_updated_at: ${updated.model_updated_at ?? "(null)"}`)
console.log("\nDone.")
