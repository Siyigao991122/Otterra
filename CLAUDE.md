# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Otterra — AI Interior Design Studio. Next.js (App Router) + React 19 + Three.js. Users upload a floor plan (PDF/image), the app derives a room footprint, then renders a 3D scene where furniture (loaded as GLB models from Supabase product rows) can be placed. Waitlist + product catalog are backed by Supabase.

## Commands

```bash
# Install — peer-deps conflict, --legacy-peer-deps is required (see README)
npm install --legacy-peer-deps

npm run dev      # next dev (port 3000, falls back to 3001+ if busy)
npm run build    # next build  (NB: typescript.ignoreBuildErrors=true — TS errors do NOT fail the build)
npm run lint     # eslint .
npm run start

# TRELLIS image-to-3D asset pipeline (TRELLIS itself runs outside this repo)
node pipelines/trellis/pipeline.mjs check
node pipelines/trellis/pipeline.mjs prepare-assets   # copies generated/<id>/model.glb → public/models/<id>.glb

# Generate a GLB via fal.ai (needs FAL_KEY in .env.local)
node scripts/fal_trellis_generate_glb.mjs "https://…/sofa.jpg"

# "First sofa" SKU swap (canonical helpers — operate on category=sofa, active, latest)
node scripts/print_first_sofa_model_target.mjs
node scripts/set_first_sofa_model_url_to_path.mjs /models/<uuid>.glb
```

There is no test suite. Don't claim a TS change "passes the build" — `next build` ignores TS errors; run `npx tsc --noEmit` if you need a real typecheck.

## Environment

Secrets go in `.env.local` at the project root — **not** as shell exports — and require a dev-server restart to take effect. See `.env.local.example`. Required keys: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`, plus `FAL_KEY` for the TRELLIS script.

`PRODUCTS_OFFLINE_FALLBACK=1` forces `/api/products` to serve `lib/devProductsFallback.ts` (local GLBs in `public/models/`) when Supabase is unreachable in a non-dev build; dev mode auto-falls back on network errors.

## Architecture

### Two entry surfaces

- **`/` (DesignEditor)** — `app/page.tsx` → `components/design-editor.tsx`. In-page flow: upload floor plan → 3D scene → furniture sidebar → AI chat panel. Uses transient component state.
- **`/room`** — `app/room/page.tsx`. Standalone 3D room driven by **sessionStorage** (`roomDimensionsSession`) for dimensions and **localStorage** (`roomLayout`, key `room_layout_v2`) for furniture placements. Layout persists across reloads but is wiped on a new upload.

### Floor plan pipeline

1. **`components/floor-plan-uploader.tsx`** rasterizes PDF pages with `pdfjs-dist` (worker at `public/pdf.worker.min.mjs`) and runs a client-side **preflight** (`lib/floorplanPreflight.ts`) that scores readiness.
2. The image is POSTed to **`/api/analyze-floorplan`** (`app/api/analyze-floorplan/route.ts`), which downscales (`lib/downscaleFloorplanImageForOpenAI.ts`) and calls **OpenAI `gpt-4o` vision** to extract rooms + footprint polygon. Falls back to a centered rectangle when the model doesn't return a valid polygon (`lib/floorplanGeometry.ts` `isValidFootprintPolygon`).
3. **Manual scale calibration** (`lib/floorplanCalibration.ts`) lets the user click two points and enter a real length; the derived `metersPerUnit` rescales the entire `FloorplanGeometry` before it goes to the room scene.
4. **`/api/floorplan-geometry-first` returns HTTP 410.** The geometry-first reconstruction stack (`lib/geometryFirst/*`, debug SVGs) has been mostly deleted; a handful of low-level PDF extractors remain in `lib/geometryFirst/` but are not wired into the active flow. Do not add code that assumes it's running.

### 3D scene

`components/room-3d-scene.tsx` (React Three Fiber) renders the floor footprint (polygon or rectangle), interior walls/doors/windows from `FloorplanGeometry`, and a `FurnitureSlot` per placement. `FurnitureSlot` decides between `FurnitureProxy` (colored box) and `FurnitureModel` (GLB loaded from `product.model_url`). `FurnitureModel` computes the GLB's bounding box at runtime and applies a uniform scale to match `furniture.dimensions` — **GLBs are not pre-scaled.**

### Dimension axis mapping — critical invariant

`lib/dimensionSemantics.ts` defines DB ↔ scene mapping. Anywhere you convert between product rows and Three.js geometry:

- `width_m`  → X (left-right) → `dimensions.width`
- `length_m` → Z (front-back) → `dimensions.depth`
- `height_m` → Y (up)          → `dimensions.height`

Mixing these up silently produces sideways/oversized furniture. The same convention applies to `pipelines/trellis/manifest.json` and `public/models/`.

### Products + Supabase

- `lib/supabasePublic.ts` (anon, read) and `lib/supabaseAdmin.ts` (service role, write). Admin import requires the service role key.
- Categories are restricted to `sofa | bed | dining_table` (enforced in `/api/products` POST and `/api/design`).
- `products.model_url` is a path like `/models/<id>.glb` served statically from `public/models/`. The "first sofa" UUID `325e9836-68f9-469c-8ed1-c7e9ce9e7555` is the canonical GLOSTAD SKU referenced by `pipelines/trellis/` and the swap scripts.
- Schema migrations live in `supabase/migrations/`; the `model_status` lifecycle column is constrained to `no_model | stand_in | generated_first_pass | approved`.

### AI APIs in use

- `/api/analyze-floorplan` — OpenAI `gpt-4o` vision (direct REST, not SDK).
- `/api/chat` — Anthropic `anthropic/claude-sonnet-4-20250514` via the Vercel `ai` SDK (`streamText`).
- `/api/design` — Layout planner that picks products + positions from the Supabase catalog.

## Conventions and gotchas

- **Path alias:** `@/*` resolves to repo root (so `@/lib/foo`, `@/components/bar`).
- **`next.config.mjs`** keeps `@napi-rs/canvas` and `pdfjs-dist` in `serverExternalPackages` — they must run as Node, not be bundled. Don't import them from client components.
- **`typescript.ignoreBuildErrors: true`** and `images.unoptimized: true` are intentional. Don't "fix" them.
- **Tailwind v4** with `@tailwindcss/postcss`; shadcn-style primitives live in `components/ui/`.
- **Archived code:** `.archive/` and `lib/geometryFirst/<deleted-files>` are excluded via tsconfig / git. Don't resurrect them when adding features.
