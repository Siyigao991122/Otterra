# 3D models (`public/models/`)

GLBs here are served as static files. `products.model_url` should be a path like `/models/<filename>.glb`.

## Stand-in vs SKU-specific assets

**Current asset is only a stand-in validation model** (Khronos glTF sample “SheenChair”, not a sofa). The next step is replacing it with a sofa-like or SKU-specific GLB (e.g. from TRELLIS) without changing app loading/scaling logic.

| File | Purpose |
|------|---------|
| `standin-glb-validation-sheenchair.glb` | Pipeline validation only — **not** final GLOSTAD geometry |
| `test.glb` | Tiny test asset (not sofa-like) |

## TRELLIS → first sofa GLB (GLOSTAD)

Image-to-3D workflow (collect images → run TRELLIS outside this repo → drop `model.glb`) is documented in **`pipelines/trellis/README.md`** (section *GLOSTAD — first TRELLIS sofa SKU*). This folder receives the copied asset after `pipeline.mjs prepare-assets`.

---

## First sofa SKU — real sofa-like GLB (GLOSTAD / “first configured sofa”)

The app treats **one** canonical row as the “first sofa” for helper scripts: **active** `category = sofa`, ordered by **`updated_at` desc**. That is usually GLOSTAD in dev.

**Convention:** put the real GLB at **`public/models/<product-id>.glb`** and set **`model_url`** to **`/models/<product-id>.glb`** (same UUID as Supabase `products.id`).

### Three-step swap (stand-in → real sofa-like GLB)

1. **Inspect the target row and paths** (prints `id`, title, dims, canonical `model_url`):

   `node scripts/print_first_sofa_model_target.mjs`

2. **Add your sofa-like GLB** on disk at the printed path, e.g. `public/models/<that-uuid>.glb`.

3. **Point only that row** at the URL (safe, idempotent; no other products updated):

   `node scripts/set_first_sofa_model_url_to_path.mjs /models/<that-uuid>.glb`

Then hard-refresh **`/room`** and **re-place** the sofa from Browse Furniture if the layout was cached.

---

## Swapping in other models (any filename)

1. Export or copy your GLB into this folder, e.g. `public/models/<your-supabase-product-id>.glb` or `public/models/glostad.glb`.
2. Use `set_first_sofa_model_url_to_path.mjs` with `/models/<same-filename>.glb`, or set `model_url` in Supabase / Admin.
3. Hard-refresh `/room` and re-place the item if needed.

No code changes are required if you only change the file on disk and `model_url` in the DB.

**DB still on the pre-rename stand-in URL?** Run (idempotent, first sofa row only):

`node scripts/migrate_sofa_stand_in_model_url.mjs`
