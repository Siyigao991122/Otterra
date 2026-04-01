-- 3D model lifecycle tracking on public.products (nullable; additive only)

ALTER TABLE public.products ADD COLUMN IF NOT EXISTS model_status text;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS model_source text;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS model_version text;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS model_updated_at timestamptz;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS model_notes text;

-- Allow NULL model_status; when set, restrict to known workflow values
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.contype = 'c'
      AND c.conname = 'products_model_status_check'
      AND n.nspname = 'public'
      AND t.relname = 'products'
  ) THEN
    ALTER TABLE public.products
      ADD CONSTRAINT products_model_status_check
      CHECK (
        model_status IS NULL
        OR model_status IN (
          'no_model',
          'stand_in',
          'generated_first_pass',
          'approved'
        )
      );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Example: promote one product after a generated GLB is published
-- (run manually in SQL editor or app migration seed — not executed here)
-- ---------------------------------------------------------------------------
-- UPDATE public.products
-- SET
--   model_status = 'generated_first_pass',
--   model_source = 'fal_trellis',
--   model_version = 'v1',
--   model_updated_at = now(),
--   model_notes = 'geometry acceptable, material too dark',
--   model_url = '/models/325e9836-68f9-469c-8ed1-c7e9ce9e7555.glb'
-- WHERE id = '325e9836-68f9-469c-8ed1-c7e9ce9e7555'::uuid;
