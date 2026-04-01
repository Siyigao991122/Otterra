-- Add model_url column for GLB 3D model URLs (top SKUs)
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS model_url text;
