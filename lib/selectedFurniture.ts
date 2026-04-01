export type SelectedFurnitureItem = {
  id: string
  title: string
  brand?: string | null
  category?: string | null
  image_url?: string | null
  product_url?: string | null
  price?: number | null
  currency?: string | null
  length_m?: number | null
  width_m?: number | null
  height_m?: number | null
  dims_confidence?: number | null
  quantity: number
}

const KEY = "selected_furniture"

function safeParse(): SelectedFurnitureItem[] {
  if (typeof window === "undefined") return []
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function getSelected(): SelectedFurnitureItem[] {
  if (typeof window === "undefined") return []
  return safeParse()
}

export function saveSelected(items: SelectedFurnitureItem[]): void {
  if (typeof window === "undefined") return
  try {
    localStorage.setItem(KEY, JSON.stringify(items))
  } catch {
    // ignore
  }
}

export function addToSelected(
  item: Omit<SelectedFurnitureItem, "quantity">
): SelectedFurnitureItem[] {
  return addToSelectedWithQty(item, 1)
}

export function addToSelectedWithQty(
  item: Omit<SelectedFurnitureItem, "quantity">,
  qty: number
): SelectedFurnitureItem[] {
  if (typeof window === "undefined") return []
  const items = safeParse()
  const existing = items.find((i) => i.id === item.id)
  if (existing) {
    existing.quantity += qty
  } else {
    items.push({ ...item, quantity: qty })
  }
  saveSelected(items)
  return items
}

export function removeSelected(id: string): SelectedFurnitureItem[] {
  if (typeof window === "undefined") return []
  const items = safeParse().filter((i) => i.id !== id)
  saveSelected(items)
  return items
}

export function clearSelected(): void {
  if (typeof window === "undefined") return
  localStorage.removeItem(KEY)
}
