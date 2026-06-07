/**
 * When Supabase is unreachable (DNS/offline/wrong URL), serve a tiny static catalog
 * backed by files in /public/models so local dev and demos still show GLBs.
 *
 * Enable in production-like local builds with PRODUCTS_OFFLINE_FALLBACK=1.
 */

export type DevProductRow = {
  id: string
  title: string
  brand: string
  category: string
  image_url: null
  product_url: null
  price: null
  currency: string
  length_m: number
  width_m: number
  height_m: number
  dims_confidence: number
  is_active: boolean
  model_url: string
  model_status: string
  model_source: string
  style_tags: string[]
  source: string
  updated_at: string
}

const DEV_CATALOG: DevProductRow[] = []

export function devOfflineFallbackEnabled(): boolean {
  return (
    process.env.NODE_ENV === "development" || process.env.PRODUCTS_OFFLINE_FALLBACK === "1"
  )
}

export function supabaseFailureLooksLikeNetwork(err: unknown): boolean {
  const msg =
    err && typeof err === "object" && "message" in err
      ? String((err as { message: unknown }).message)
      : String(err)
  return /fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network/i.test(msg)
}

export function devProductsFallback(category: string | null | undefined): DevProductRow[] {
  if (!devOfflineFallbackEnabled()) return []
  const c = category?.toLowerCase()
  if (c && (c === "sofa" || c === "bed" || c === "dining_table")) {
    return DEV_CATALOG.filter((p) => p.category === c)
  }
  return [...DEV_CATALOG]
}
