#!/usr/bin/env node
/**
 * Set model_url ONLY for the first active sofa row (same row as other first-sofa scripts).
 * Safe: updates by exact product id from that query; no other products touched.
 * Idempotent: if model_url already equals the given path (after trim), no DB write.
 *
 * Usage: node scripts/set_first_sofa_model_url_to_path.mjs /models/<product-id>.glb
 * Requires: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
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

loadEnvLocal()

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!url || !serviceRoleKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY")
  process.exit(1)
}

const rawArg = process.argv[2]
if (!rawArg || process.argv.includes("-h") || process.argv.includes("--help")) {
  console.error(
    "Usage: node scripts/set_first_sofa_model_url_to_path.mjs /models/<filename>.glb\n" +
      "Example: node scripts/set_first_sofa_model_url_to_path.mjs /models/325e9836-68f9-469c-8ed1-c7e9ce9e7555.glb\n" +
      "Path must start with /models/ and end with .glb"
  )
  process.exit(1)
}

const newPath = rawArg.trim()
if (!isAllowedModelPath(newPath)) {
  console.error("Invalid path: must be like /models/name.glb (no ..)")
  process.exit(1)
}

const supabase = createClient(url, serviceRoleKey, { auth: { persistSession: false } })

const { data: rows, error } = await supabase
  .from("products")
  .select("id, title, model_url")
  .eq("is_active", true)
  .eq("category", "sofa")
  .order("updated_at", { ascending: false })
  .limit(1)

if (error) {
  console.error("Query error:", error)
  process.exit(1)
}

const row = rows?.[0]
if (!row) {
  console.error("No active sofa products found. Nothing to update.")
  process.exit(1)
}

const before = row.model_url?.trim() ?? "(null)"
console.log("Target row (only row this script can update):")
console.log(`  id:    ${row.id}`)
console.log(`  title: ${row.title}`)
console.log(`  before model_url: ${before}`)

if (before === newPath) {
  console.log(`after model_url:  ${newPath} (unchanged — already set; idempotent)`)
  process.exit(0)
}

const { error: upErr } = await supabase.from("products").update({ model_url: newPath }).eq("id", row.id)

if (upErr) {
  console.error("Update error:", upErr)
  process.exit(1)
}

console.log(`after model_url:  ${newPath}`)
console.log("Done. Place the file under public" + newPath + " if not already, then reload /room.")
