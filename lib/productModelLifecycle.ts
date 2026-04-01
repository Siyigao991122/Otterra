/**
 * Optional 3D model lifecycle columns on public.products.
 * See supabase/migrations/20260325_products_model_lifecycle.sql
 */
export interface ProductModelLifecycle {
  model_status?: string | null
  model_source?: string | null
  model_version?: string | null
  model_updated_at?: string | null
  model_notes?: string | null
}
