#!/usr/bin/env node
/**
 * Print the first active sofa row (same selection as set_first_sofa_model_url / migrate scripts)
 * and the canonical model_url path for a SKU-specific GLB: /models/<product-id>.glb
 *
 * Usage: node scripts/print_first_sofa_model_target.mjs
 * Requires: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (e.g. from .env.local)
 */

import { createClient } from "@supabase/supabase-js"
import { readFileSync, existsSync } from "fs"
import { resolve } from "path"

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
  console.log("No active sofa products found.")
  process.exit(0)
}

const canonicalUrl = `/models/${row.id}.glb`

console.log("First active sofa (category=sofa, is_active=true, order by updated_at desc):")
console.log(`  id:          ${row.id}`)
console.log(`  title:       ${row.title}`)
console.log(`  model_url:   ${row.model_url ?? "(null)"}`)
console.log(
  `  dimensions:  width_m=${row.width_m ?? "—"}  length_m=${row.length_m ?? "—"}  height_m=${row.height_m ?? "—"}`
)
console.log("")
console.log("Canonical first-sofa GLB convention (recommended for this SKU):")
console.log(`  On disk:     public/models/${row.id}.glb`)
console.log(`  model_url:   ${canonicalUrl}`)
console.log("")
console.log("After placing the file, point this row at it (idempotent):")
console.log(`  node scripts/set_first_sofa_model_url_to_path.mjs ${canonicalUrl}`)
console.log("")
console.log("Other /models/*.glb paths are allowed if you use a different filename;")
console.log("the setter only ever updates this one product id above.")
