-- =============================================================================
-- SEMANTIC FLOOR PLAN ANNOTATION SCHEMA
-- Purpose: build a training dataset for automatic floor plan segmentation.
-- A trained model takes a floor plan image and outputs a per-pixel class mask
-- (wall, stove, toilet, column, washer/dryer, etc.) — enabling fully automatic
-- 3D room reconstruction from a raw PDF.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. ANNOTATION CLASS TAXONOMY
--    Extensible list of every semantic element we want to detect.
--    Add new rows here as the dataset grows — no schema change needed.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.annotation_classes (
  id            text PRIMARY KEY,        -- slug: 'wall', 'stove', 'toilet', …
  display_name  text NOT NULL,
  category      text NOT NULL            -- 'structural' | 'fixture' | 'opening' | 'furniture'
                CHECK (category IN ('structural','fixture','opening','furniture')),
  color_hex     text NOT NULL,           -- hex for overlay visualisation, e.g. '#FF0000'
  class_index   smallint UNIQUE NOT NULL, -- integer used in segmentation mask PNGs (0=background)
  description   text,
  is_solid      boolean DEFAULT true,    -- does it block movement / have physical volume?
  has_3d_model  boolean DEFAULT false,
  model_url     text,                    -- path to GLB if we have one
  created_at    timestamptz DEFAULT now()
);

-- Seed: initial class vocabulary (extend anytime with INSERT)
INSERT INTO public.annotation_classes
  (id, display_name, category, color_hex, class_index, description, is_solid, has_3d_model)
VALUES
  ('wall',         'Wall',           'structural', '#E63946', 1,  'Load-bearing and partition walls',         true,  false),
  ('column',       'Column',         'structural', '#F4A261', 2,  'Structural columns / pillars',             true,  false),
  ('stairs',       'Stairs',         'structural', '#E9C46A', 3,  'Staircase',                               true,  false),
  ('door',         'Door',           'opening',    '#2A9D8F', 4,  'Door opening (swing arc included)',        false, false),
  ('window',       'Window',         'opening',    '#264653', 5,  'Window opening',                          false, false),
  ('stove',        'Stove / Range',  'fixture',    '#9B2226', 6,  'Kitchen stove, range, or cooktop',        true,  false),
  ('sink',         'Sink',           'fixture',    '#AE2012', 7,  'Kitchen or bathroom sink',                true,  false),
  ('toilet',       'Toilet',         'fixture',    '#BB3E03', 8,  'Toilet',                                  true,  false),
  ('bathtub',      'Bathtub',        'fixture',    '#CA6702', 9,  'Bathtub',                                 true,  false),
  ('shower',       'Shower',         'fixture',    '#EE9B00', 10, 'Shower stall',                            true,  false),
  ('washer_dryer', 'Washer / Dryer', 'fixture',    '#94D2BD', 11, 'Washing machine or dryer unit',          true,  false),
  ('refrigerator', 'Refrigerator',   'fixture',    '#0A9396', 12, 'Refrigerator / fridge',                  true,  false),
  ('counter',      'Counter',        'fixture',    '#005F73', 13, 'Kitchen or bathroom counter / cabinet',   true,  false),
  ('elevator',     'Elevator',       'structural', '#001219', 14, 'Elevator shaft',                         true,  false)
ON CONFLICT (id) DO NOTHING;


-- -----------------------------------------------------------------------------
-- 2. FLOOR PLAN SESSIONS
--    One row per uploaded floor plan.  Replaces the old floor_plan_annotations
--    table — keeps the same calibration / dimension fields, adds image storage.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.floor_plan_sessions (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_identifier           text,              -- waitlist email or anon session id

  -- Source image ---------------------------------------------------------------
  -- Prefer storage_path (Supabase Storage bucket 'floor-plans') for large files.
  -- Fallback to data_url for small / legacy records.
  source_image_storage_path text,              -- 'floor-plans/{id}/source.png'
  source_image_data_url     text,              -- base64 PNG (small images only)
  source_filename           text,
  image_width               integer NOT NULL,
  image_height              integer NOT NULL,

  -- User-defined crop box (everything outside is ignored) ----------------------
  crop_box                  jsonb,             -- {x,y,w,h} in image pixels

  -- Scale calibration ----------------------------------------------------------
  calibration               jsonb,             -- {p1,p2,metersPerUnit,realLengthMeters}
  width_meters              double precision,
  depth_meters              double precision,

  -- Outer footprint polygon (crop box corners or manual outline) ---------------
  footprint_polygon         jsonb,             -- [{x,y},…] image pixels

  -- Training split & quality ---------------------------------------------------
  split                     text DEFAULT 'train'
                            CHECK (split IN ('train','val','test','pending')),
  quality_score             smallint           -- 1 (noisy) – 5 (clean), NULL = unrated
                            CHECK (quality_score BETWEEN 1 AND 5),
  notes                     text,

  created_at                timestamptz DEFAULT now(),
  updated_at                timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS floor_plan_sessions_created_at_idx
  ON public.floor_plan_sessions (created_at DESC);
CREATE INDEX IF NOT EXISTS floor_plan_sessions_split_idx
  ON public.floor_plan_sessions (split);

ALTER TABLE public.floor_plan_sessions ENABLE ROW LEVEL SECURITY;


-- -----------------------------------------------------------------------------
-- 3. REGION ANNOTATIONS  (the core training labels)
--    Each row = one labeled region inside a session.
--    A session typically has many rows: one wall blob, one stove, one toilet, …
--
--    Storing BOTH polygon (vector) and mask (raster) gives flexibility:
--      • polygon → easy to edit, re-render, scale
--      • mask PNG → plug directly into PyTorch DataLoader
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.floor_plan_region_annotations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      uuid NOT NULL REFERENCES public.floor_plan_sessions(id) ON DELETE CASCADE,
  class_id        text NOT NULL REFERENCES public.annotation_classes(id),

  -- Labeled region — at least one of polygon or mask must be present ----------
  polygon_vertices jsonb,                  -- [{x,y},…] image pixels (closed ring)
  mask_storage_path text,                  -- 'floor-plans/{session_id}/masks/{id}.png'
  mask_data_url     text,                  -- base64 binary mask PNG (fallback)

  -- Bounding box (derived; stored for fast spatial queries) -------------------
  bbox              jsonb,                 -- {x,y,w,h}

  -- Provenance & quality -------------------------------------------------------
  source            text DEFAULT 'user_drawn'
                    CHECK (source IN ('user_drawn','auto_detected','ai_assisted')),
  confidence        real DEFAULT 1.0 CHECK (confidence BETWEEN 0 AND 1),
  is_reviewed       boolean DEFAULT false,
  reviewer_notes    text,

  created_at        timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS floor_plan_region_annotations_session_idx
  ON public.floor_plan_region_annotations (session_id);
CREATE INDEX IF NOT EXISTS floor_plan_region_annotations_class_idx
  ON public.floor_plan_region_annotations (class_id);

ALTER TABLE public.floor_plan_region_annotations ENABLE ROW LEVEL SECURITY;


-- -----------------------------------------------------------------------------
-- 4. COMBINED SEGMENTATION MASKS  (ready-to-train ground truth)
--    One PNG per session where pixel value = class_index from annotation_classes.
--    Generated programmatically by rendering all region annotations together.
--    This is what a PyTorch / TF DataLoader reads directly.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.floor_plan_segmentation_masks (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id        uuid NOT NULL REFERENCES public.floor_plan_sessions(id) ON DELETE CASCADE,

  mask_storage_path text,                  -- 'floor-plans/{session_id}/segmentation.png'
  mask_data_url     text,                  -- base64 (small images only)

  -- Which class→index mapping was used when rendering this mask ----------------
  class_index_map   jsonb NOT NULL,        -- {"wall":1,"stove":6,…}

  -- Resolution of this mask (may differ from source if downscaled for training) -
  mask_width        integer NOT NULL,
  mask_height       integer NOT NULL,

  is_reviewed       boolean DEFAULT false,
  generated_at      timestamptz DEFAULT now()
);

ALTER TABLE public.floor_plan_segmentation_masks ENABLE ROW LEVEL SECURITY;


-- -----------------------------------------------------------------------------
-- 5. MIGRATE existing floor_plan_annotations rows → floor_plan_sessions
--    (safe: only runs if old table exists and new one is empty)
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'floor_plan_annotations'
  ) AND NOT EXISTS (SELECT 1 FROM public.floor_plan_sessions LIMIT 1) THEN
    INSERT INTO public.floor_plan_sessions (
      id, user_identifier, source_image_data_url, source_filename,
      image_width, image_height, crop_box, calibration,
      width_meters, depth_meters, footprint_polygon, created_at
    )
    SELECT
      id, user_identifier, source_image, source_filename,
      source_image_width, source_image_height,
      NULL,          -- no crop_box in old table
      calibration,
      width_meters, depth_meters,
      polygon_vertices,
      created_at
    FROM public.floor_plan_annotations;

    RAISE NOTICE 'Migrated % rows from floor_plan_annotations → floor_plan_sessions',
      (SELECT count(*) FROM public.floor_plan_annotations);
  END IF;
END $$;

