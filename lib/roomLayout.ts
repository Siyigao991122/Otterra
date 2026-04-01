export type Placement = {
  product_id: string
  x: number
  z: number
  rotation_y_deg: number
  qty?: number
}

const KEY = "room_layout_v1"

function safeParse(): Placement[] {
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

export function getLayout(): Placement[] {
  if (typeof window === "undefined") return []
  return safeParse()
}

export function saveLayout(layout: Placement[]): void {
  if (typeof window === "undefined") return
  try {
    localStorage.setItem(KEY, JSON.stringify(layout))
  } catch {
    // ignore
  }
}

export function upsertPlacement(p: Placement): Placement[] {
  if (typeof window === "undefined") return []
  const items = safeParse()
  const idx = items.findIndex((i) => i.product_id === p.product_id)
  if (idx >= 0) {
    items[idx] = { ...items[idx], ...p }
  } else {
    items.push(p)
  }
  saveLayout(items)
  return items
}

export function removePlacement(product_id: string): Placement[] {
  if (typeof window === "undefined") return []
  const items = safeParse().filter((i) => i.product_id !== product_id)
  saveLayout(items)
  return items
}

export function clearLayout(): void {
  if (typeof window === "undefined") return
  localStorage.removeItem(KEY)
}
