#!/usr/bin/env node
/**
 * One-time / idempotent migration: first active sofa (by updated_at) only.
 * If products.model_url still points at the retired stand-in filename, updates it
 * to the current stand-in path. Otherwise no-op with a clear log.
 *
 * Does not modify other products or other model_url values.
 *
 * Usage: node scripts/migrate_sofa_stand_in_model_url.mjs
 * Requires: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (e.g. from .env.local)
 */

import { createClient } from "@supabase/supabase-js"
import { readFileSync, existsSync } from "fs"
import { resolve } from "path"

const LEGACY_STAND_IN_PATH = "/models/sofa-pipeline-test.glb"
const CURRENT_STAND_IN_PATH = "/models/standin-glb-validation-sheenchair.glb"

const envPath = resolve(process.cwd(), ".env.local")
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([^#=]+)=(.*)$/)
    if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "")
  }
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!url || !serviceRoleKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY")
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
  console.log("No active sofa products found. Nothing to do.")
  process.exit(0)
}

const current = row.model_url?.trim() ?? ""

console.log(`Target row (first sofa by updated_at): id=${row.id} title="${row.title}"`)
console.log(`  model_url: ${current || "(null)"}`)

if (current === LEGACY_STAND_IN_PATH) {
  const { error: upErr } = await supabase
    .from("products")
    .update({ model_url: CURRENT_STAND_IN_PATH })
    .eq("id", row.id)

  if (upErr) {
    console.error("Update error:", upErr)
    process.exit(1)
  }
  console.log(`Updated: ${LEGACY_STAND_IN_PATH} → ${CURRENT_STAND_IN_PATH}`)
  process.exit(0)
}

if (current === CURRENT_STAND_IN_PATH) {
  console.log("Already using current stand-in path. No update needed (idempotent).")
  process.exit(0)
}

console.log("model_url is not the legacy stand-in path; leaving unchanged (only legacy path is migrated).")
process.exit(0)
