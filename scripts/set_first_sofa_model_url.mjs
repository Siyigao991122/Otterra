#!/usr/bin/env node
/**
 * Point the first active sofa product (by updated_at) at the stand-in validation GLB.
 * Does not change runtime loading/scaling — only updates `products.model_url` in Supabase.
 *
 * Stand-in file: public/models/standin-glb-validation-sheenchair.glb
 * (Khronos SheenChair — pipeline validation only, not a real sofa / not GLOSTAD-specific.)
 *
 * For a real sofa-like GLB on the first sofa row, see public/models/README.md and:
 *   node scripts/print_first_sofa_model_target.mjs
 *   node scripts/set_first_sofa_model_url_to_path.mjs /models/<id>.glb
 *
 * Usage: node scripts/set_first_sofa_model_url.mjs
 * Requires: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (e.g. from .env.local)
 */

import { createClient } from "@supabase/supabase-js"
import { readFileSync, existsSync } from "fs"
import { resolve } from "path"

/** Path served from public/models/ — must match filename on disk */
const STANDIN_VALIDATION_MODEL_PATH = "/models/standin-glb-validation-sheenchair.glb"

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
  .select("id, title, model_url, width_m, length_m, height_m")
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
  console.error("No active sofa products found in Supabase.")
  process.exit(1)
}

const { error: upErr } = await supabase
  .from("products")
  .update({ model_url: STANDIN_VALIDATION_MODEL_PATH })
  .eq("id", row.id)

if (upErr) {
  console.error("Update error:", upErr)
  process.exit(1)
}

console.log("Updated product (stand-in validation GLB only — not final sofa mesh):")
console.log(`  id:         ${row.id}`)
console.log(`  title:      ${row.title}`)
console.log(`  model_url:  ${STANDIN_VALIDATION_MODEL_PATH}  (was: ${row.model_url ?? "null"})`)
console.log(`  dims (m):   w=${row.width_m} L=${row.length_m} h=${row.height_m}`)
console.log(
  "\nEnsure public/models/standin-glb-validation-sheenchair.glb exists.\n" +
    "If the DB still used the retired stand-in filename, run: node scripts/migrate_sofa_stand_in_model_url.mjs\n" +
    "Re-open /room after clearing layout or re-place from Browse Furniture."
)
