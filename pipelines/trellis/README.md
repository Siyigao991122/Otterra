# TRELLIS Asset Generation Pipeline (MVP)

Image-to-3D pipeline using Microsoft TRELLIS for Otterra furniture assets.

**This repo does not install or invoke TRELLIS.** It defines folders, `manifest.json`, and `pipeline.mjs` (`check` / `prepare-assets`). You run image-to-3D with your own TRELLIS setup, then drop `model.glb` where this pipeline expects it.

## GLOSTAD — first TRELLIS sofa SKU (canonical)

| Item | Value |
|------|--------|
| **Supabase `products.id`** | `325e9836-68f9-469c-8ed1-c7e9ce9e7555` |
| **Manifest `id`** | Same UUID (so `prepare-assets` → `public/models/<id>.glb` matches `print_first_sofa_model_target.mjs`) |
| **IKEA URL** | See `manifest.json` → `product_url` |

### 1. Collect source images (before any generation)

Use **2–4** clear views of the **same** sofa (GLOSTAD), consistent lighting, minimal clutter:

- **`front.jpg`** — facing the sofa straight-on  
- **`side.jpg`** — left or right profile  
- **`angle.jpg`** — ~45° three-quarter view (helps depth)

Sources: IKEA product gallery (save highest resolution you may use under their terms), or your own photos. Convert/export to **JPEG** if needed; filenames must match `manifest.json` (`images` array).

### 2. Where to put them

```
pipelines/trellis/source/325e9836-68f9-469c-8ed1-c7e9ce9e7555/
  front.jpg
  side.jpg
  angle.jpg
```

Verify:

```bash
node pipelines/trellis/pipeline.mjs check
```

### 3a. Generate via fal `fal-ai/trellis` (single image URL, no extra npm deps)

Uses **Node 18+ `fetch` only** — does not add packages to this repo.

```bash
export FAL_KEY="your_fal_api_key"   # or put FAL_KEY in .env.local
node scripts/fal_trellis_generate_glb.mjs "https://…/your-sofa-image.jpg"
```

- Logs raw submit / poll / result JSON to the console.
- Writes **`pipelines/trellis/generated/325e9836-68f9-469c-8ed1-c7e9ce9e7555/model.glb`**.
- Does **not** update Supabase.

See script header in `scripts/fal_trellis_generate_glb.mjs` for details. API: [fal queue](https://docs.fal.ai/model-endpoints/queue), model [`fal-ai/trellis`](https://fal.ai/models/fal-ai/trellis/api).

### 3b. Generate the GLB (self-hosted TRELLIS, outside this repo)

Use **your** TRELLIS install (Docker / Python / ComfyUI — see [Microsoft TRELLIS](https://github.com/microsoft/TRELLIS)). Point it at images under `source/325e9836-68f9-469c-8ed1-c7e9ce9e7555/`.

**Required output path for this pipeline:**

```
pipelines/trellis/generated/325e9836-68f9-469c-8ed1-c7e9ce9e7555/model.glb
```

Save/export as **`model.glb`** exactly (the repo scripts look for that name).

### 4. After `model.glb` exists (still optional: do not touch Supabase until you want)

```bash
node pipelines/trellis/pipeline.mjs check
node pipelines/trellis/pipeline.mjs prepare-assets
```

That copies to `public/models/325e9836-68f9-469c-8ed1-c7e9ce9e7555.glb` and writes `metadata/<id>.json`.

**Do not set `products.model_url` until you are happy with the mesh** (see `public/models/README.md` and `scripts/set_first_sofa_model_url_to_path.mjs` when ready).

### Prerequisites checklist

- [ ] TRELLIS (or compatible image-to-3D) runnable on your machine  
- [ ] Images in `source/325e9836-68f9-469c-8ed1-c7e9ce9e7555/` per manifest  
- [ ] Export GLB to `generated/325e9836-68f9-469c-8ed1-c7e9ce9e7555/model.glb`  
- [ ] (Later) `prepare-assets` + Supabase `model_url` when you choose to go live  

---

## Folder Structure

```
pipelines/trellis/
├── README.md                 # This file
├── pipeline.mjs              # Pipeline runner (check, prepare-assets)
├── manifest.json             # Product definitions (GLOSTAD first = Supabase UUID)
├── source/                   # Input images per product
│   └── {product_id}/         # e.g. source/325e9836-68f9-469c-8ed1-c7e9ce9e7555/
│       ├── front.jpg
│       ├── side.jpg
│       └── angle.jpg
├── generated/                # YOU place TRELLIS output here (raw, unscaled)
│   └── {product_id}/
│       └── model.glb
├── metadata/                 # Written by prepare-assets
│   └── {product_id}.json
└── (prepare-assets copies GLB → ../../public/models/{product_id}.glb)
```

## Product Schema (manifest.json)

Each product has:

- `id` – For GLOSTAD: **Supabase `products.id`** (UUID) so filenames align with the app
- `title` – Product name
- `product_url` – IKEA URL
- `width_m`, `length_m`, `height_m` – Real dimensions (meters). DB semantics: `width_m`=left-right, `length_m`=front-back, `height_m`=max height
- `images` – Local paths relative to `source/{product_id}/`

## Pipeline Steps (summary)

1. **Prepare source images** — Place in `source/{product_id}/` (2–4 views recommended).

2. **Run TRELLIS** (your environment) — Input: those images; output: **`generated/{product_id}/model.glb`**.

3. **Metadata** — `prepare-assets` writes `metadata/{product_id}.json` with target dims and `model_url` hint.

4. **Scale to target dimensions** — At runtime the room uses bbox scaling; see "Scaling" below.

5. **Export for app** — `prepare-assets` copies `generated/{product_id}/model.glb` → `public/models/{product_id}.glb`. Update Supabase `model_url` only when you intend to ship that asset.

## Scaling Logic

**Runtime scaling (current app behavior):**
- `FurnitureModel` loads GLB, computes bounding box, applies uniform scale so bbox fits `(width, height, depth)`
- Target dims: `width_m`→X, `length_m`→Z, `height_m`→Y (see lib/dimensionSemantics.ts)
- No pre-baking needed; GLB can be any scale

**Pre-baking (optional, for Unity):**
- Compute scale from metadata `source_dims_m` vs target
- Use gltf-transform or Blender to bake scale into mesh
- Export scaled GLB for consistent sizing

## Unity / Room Scene Integration

**Where the room scene loads GLBs from:**
- `model_url` in products table (e.g. `/models/325e9836-68f9-469c-8ed1-c7e9ce9e7555.glb` for GLOSTAD)
- Served from `public/models/` (Next.js static assets)
- Path: `https://your-domain.com/models/{product_id}.glb`

**Dimension mapping (DB → Three.js):**
- `width_m` (left-right) → scene X / dimensions.width
- `length_m` (front-back) → scene Z / dimensions.depth
- `height_m` (up) → scene Y / dimensions.height

**Flow:**
1. Room page fetches products (with `model_url`, `length_m`, `width_m`, `height_m`)
2. Furniture placed with dimensions from DB
3. `FurnitureSlot` → `FurnitureModel` loads GLB from `model_url`
4. GLB scaled at runtime to match `dimensions` (width, height, depth)

## Room scene stand-in (validation only)

**Current asset in the repo is only a stand-in validation model** (`public/models/standin-glb-validation-sheenchair.glb`, Khronos SheenChair sample). It proves the GLB → room pipeline; it is **not** the final GLOSTAD or SKU-specific sofa mesh. **Next step:** replace that file (or add a new path) with a sofa-like or TRELLIS-generated GLB and point `products.model_url` at `/models/<your-file>.glb` — no loading/scaling code changes needed.

See `public/models/README.md` for file naming, the **first sofa SKU** swap flow (`print_first_sofa_model_target`, `set_first_sofa_model_url_to_path`), and stand-in migration. If a dev DB still has the retired stand-in `model_url`, run `node scripts/migrate_sofa_stand_in_model_url.mjs` (idempotent, first sofa row only).

## Other SKUs in manifest

`manifest.json` may list additional products (e.g. MALM, EKEDALEN) with slug `id`s for future TRELLIS runs; the same folder rules apply: `source/{id}/`, `generated/{id}/model.glb`.

## Quick commands (this repo)

```bash
# After images exist under source/<id>/:
node pipelines/trellis/pipeline.mjs check

# After generated/<id>/model.glb exists:
node pipelines/trellis/pipeline.mjs prepare-assets

# Supabase model_url: only when you are ready (see public/models/README.md)
```
