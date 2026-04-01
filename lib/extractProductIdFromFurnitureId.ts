/**
 * Furniture ids are `layout-{product_id}-{index}` or `design-{product_id}-{index}`.
 * product_id may be a UUID (contains hyphens) or a slug; index is numeric at the end.
 */
const PREFIX = /^(?:design|layout)-/

export function extractProductIdFromFurnitureId(furnitureId: string): string | null {
  if (!PREFIX.test(furnitureId)) return null
  const rest = furnitureId.replace(PREFIX, "")
  const m = rest.match(/^(.*)-(\d+)$/)
  return m ? m[1] : null
}
