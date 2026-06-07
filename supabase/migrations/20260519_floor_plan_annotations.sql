-- Stores user-confirmed outer-wall outlines paired with the source floor plan.
-- Future use: training data for automatic outline detection.

CREATE TABLE IF NOT EXISTS public.floor_plan_annotations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Optional identity of submitter (waitlist email or session id; nullable for anon).
  user_identifier text,

  -- Source image (data URL or future Storage path) and original pixel dimensions.
  source_image text NOT NULL,
  source_image_width integer NOT NULL,
  source_image_height integer NOT NULL,
  source_filename text,

  -- Polygon as JSON array of {x,y} in image-pixel coordinates.
  polygon_vertices jsonb NOT NULL,

  -- Calibration that maps pixels → meters (jsonb so schema can evolve).
  calibration jsonb,

  -- Resulting dimensions in meters (convenience for queries).
  width_meters double precision,
  depth_meters double precision,

  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS floor_plan_annotations_created_at_idx
  ON public.floor_plan_annotations (created_at DESC);

-- Lock down direct anon/authenticated access; writes only happen via service-role
-- key (lib/supabaseAdmin) in /api/save-annotation. No policies = no access for
-- non-service roles.
ALTER TABLE public.floor_plan_annotations ENABLE ROW LEVEL SECURITY;
