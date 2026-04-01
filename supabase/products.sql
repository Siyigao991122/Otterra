-- Run this in Supabase SQL Editor to create the products table

CREATE TABLE public.products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text DEFAULT 'manual',
  source_product_id text,
  brand text DEFAULT 'IKEA',
  category text NOT NULL CHECK (category IN ('sofa', 'bed', 'dining_table')),
  title text NOT NULL,
  image_url text,
  product_url text,
  price numeric,
  currency text DEFAULT 'USD',
  length_m numeric,
  width_m numeric,
  height_m numeric,
  dims_confidence int DEFAULT 2,
  style_tags text[] DEFAULT '{}',
  is_active boolean DEFAULT true,
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX idx_products_category ON public.products (category);
CREATE INDEX idx_products_brand ON public.products (brand);
CREATE INDEX idx_products_is_active ON public.products (is_active);
CREATE INDEX idx_products_price ON public.products (price);
