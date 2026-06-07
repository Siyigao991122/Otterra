#!/usr/bin/env node
/**
 * TRELLIS Asset Pipeline (MVP)
 *
 * Steps:
 * 1. Place source images in source/{product_id}/
 * 2. Run TRELLIS (manual): input=source/{id}/*.jpg → output=generated/{id}/model.glb
 * 3. prepare-assets: copy GLBs to public/models/, write metadata
 *
 * Usage:
 *   node pipelines/trellis/pipeline.mjs check          # verify manifest + source images
 *   node pipelines/trellis/pipeline.mjs prepare-assets  # copy to public/models/, write metadata
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from "fs"
import { resolve, dirname } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const PIPELINE_ROOT = resolve(__dirname)
const PROJECT_ROOT = resolve(PIPELINE_ROOT, "../..")

function loadManifest() {
  const p = resolve(PIPELINE_ROOT, "manifest.json")
  if (!existsSync(p)) throw new Error("manifest.json not found")
  return JSON.parse(readFileSync(p, "utf8"))
}

/** Resolve image paths relative to source/{product_id}/ */
function getImagePaths(product) {
  const base = resolve(PIPELINE_ROOT, "source", product.id)
  return (product.images || []).map((name) => resolve(base, name))
}

function check() {
  const manifest = loadManifest()
  console.log(`Manifest: ${manifest.products?.length ?? 0} products\n`)
  for (const p of manifest.products ?? []) {
    const images = getImagePaths(p)
    const present = images.filter((path) => existsSync(path))
    const missing = images.filter((path) => !existsSync(path))
    const genGlb = resolve(PIPELINE_ROOT, "generated", p.id, "model.glb")
    const hasGlb = existsSync(genGlb)
    console.log(`  ${p.id}`)
    console.log(`    title: ${p.title}`)
    console.log(`    dims (L×W×H m): ${p.length_m} × ${p.width_m} × ${p.height_m}`)
    console.log(`    images: ${present.length}/${images.length} (${missing.length} missing)`)
    console.log(`    generated/model.glb: ${hasGlb ? "YES" : "NO"}`)
    if (missing.length) console.log(`    missing: ${missing.map((x) => x.split("/").pop()).join(", ")}`)
    console.log("")
  }
}

function prepareAssets() {
  const manifest = loadManifest()
  const outDir = resolve(PROJECT_ROOT, "public", "models")
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
  const metaDir = resolve(PIPELINE_ROOT, "metadata")
  if (!existsSync(metaDir)) mkdirSync(metaDir, { recursive: true })

  for (const p of manifest.products ?? []) {
    const srcGlb = resolve(PIPELINE_ROOT, "generated", p.id, "model.glb")
    const dstGlb = resolve(outDir, `${p.id}.glb`)

    if (!existsSync(srcGlb)) {
      console.warn(`  [skip] ${p.id}: no model.glb at ${srcGlb}`)
      continue
    }

    copyFileSync(srcGlb, dstGlb)
    console.log(`  copied ${p.id}.glb → public/models/`)

    const meta = {
      product_id: p.id,
      title: p.title,
      product_url: p.product_url,
      target_dims_m: {
        width: p.width_m,
        height: p.height_m,
        depth: p.length_m,
      },
      model_url: `/models/${p.id}.glb`,
      scaling_note:
        "Runtime: FurnitureModel scales GLB by bounding box to fit (width, height, depth). " +
        "DB mapping: width_m→X, length_m→Z, height_m→Y. See lib/dimensionSemantics.ts.",
    }
    const metaPath = resolve(metaDir, `${p.id}.json`)
    writeFileSync(metaPath, JSON.stringify(meta, null, 2))
    console.log(`  metadata → metadata/${p.id}.json`)
  }
  console.log("\nDone. Update Supabase product.model_url = /models/{id}.glb for each product.")
}

const cmd = process.argv[2] || "check"
if (cmd === "check") check()
else if (cmd === "prepare-assets") prepareAssets()
else {
  console.error("Usage: node pipeline.mjs [check|prepare-assets]")
  process.exit(1)
}
