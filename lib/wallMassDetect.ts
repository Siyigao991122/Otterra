/**
 * Client-side wall mass detection from rendered floor plan images.
 * Uses gray pixel detection + shape-based filtering to identify walls and remove furniture.
 *
 * Pipeline:
 * 1. Extract gray pixels (mid-luma, low-saturation) — walls are gray fill, not white or black
 * 2. Label connected components
 * 3. Filter by long-axis length + aspect ratio — walls are elongated, furniture is compact
 */

export interface WallMassResult {
  /** Boolean mask: 1 = wall pixel. Flat array, row-major, same dimensions as input image. */
  mask: Uint8Array
  width: number
  height: number
}

function labelComponents(
  mask: Uint8Array,
  w: number,
  h: number
): { labels: Int32Array; bboxes: Map<number, { minX: number; minY: number; maxX: number; maxY: number }> } {
  const labels = new Int32Array(w * h)
  const bboxes = new Map<number, { minX: number; minY: number; maxX: number; maxY: number }>()
  let nextLabel = 1

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x
      if (!mask[idx] || labels[idx]) continue

      const label = nextLabel++
      const queue = [idx]
      labels[idx] = label
      const bb = { minX: x, minY: y, maxX: x, maxY: y }
      bboxes.set(label, bb)

      while (queue.length > 0) {
        const ci = queue.pop()!
        const cx = ci % w
        const cy = (ci - cx) / w
        for (const [dx, dy] of [
          [1, 0], [-1, 0], [0, 1], [0, -1],
        ] as const) {
          const nx = cx + dx, ny = cy + dy
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue
          const ni = ny * w + nx
          if (mask[ni] && !labels[ni]) {
            labels[ni] = label
            queue.push(ni)
            if (nx < bb.minX) bb.minX = nx
            if (nx > bb.maxX) bb.maxX = nx
            if (ny < bb.minY) bb.minY = ny
            if (ny > bb.maxY) bb.maxY = ny
          }
        }
      }
    }
  }

  return { labels, bboxes }
}

export function detectWallMass(canvas: HTMLCanvasElement): WallMassResult {
  const ctx = canvas.getContext("2d")!
  const w = canvas.width
  const h = canvas.height
  const { data: px } = ctx.getImageData(0, 0, w, h)

  // Step 1: Gray pixel mask — walls are mid-gray (not white background, not black lines)
  const grayMask = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) {
    const r = px[i * 4]!, g = px[i * 4 + 1]!, b = px[i * 4 + 2]!
    const luma = Math.round(0.299 * r + 0.587 * g + 0.114 * b)
    const sat = Math.max(r, g, b) - Math.min(r, g, b)
    if (luma >= 100 && luma <= 225 && sat <= 25) grayMask[i] = 1
  }

  // Step 2: Label connected components + bounding boxes
  const { labels, bboxes } = labelComponents(grayMask, w, h)

  // Step 3: Keep components that are wall-shaped
  // Walls: long axis >= 4% of short side AND (aspect ratio >= 2.5 OR very long)
  const shortSide = Math.min(w, h)
  const minWallSpan = Math.round(shortSide * 0.04)

  const edgeMargin = Math.round(shortSide * 0.015) + 2  // ~1.5% of image short side

  const wallLabels = new Set<number>()
  for (const [label, bb] of bboxes) {
    const bw = bb.maxX - bb.minX + 1
    const bh = bb.maxY - bb.minY + 1
    const longAxis = Math.max(bw, bh)
    const shortAxis = Math.min(bw, bh)
    const aspectRatio = longAxis / Math.max(shortAxis, 1)

    // Skip PDF / image border frames: large components that touch the image edge
    const touchesEdge =
      bb.minX <= edgeMargin || bb.maxX >= w - 1 - edgeMargin ||
      bb.minY <= edgeMargin || bb.maxY >= h - 1 - edgeMargin
    if (touchesEdge && longAxis > shortSide * 0.6) continue

    if (longAxis >= minWallSpan && (aspectRatio >= 2.5 || longAxis >= shortSide * 0.15)) {
      wallLabels.add(label)
    }
  }

  const mask = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) {
    if (wallLabels.has(labels[i]!)) mask[i] = 1
  }

  return { mask, width: w, height: h }
}

export async function detectWallMassFromDataUrl(dataUrl: string): Promise<WallMassResult> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement("canvas")
      canvas.width = img.width
      canvas.height = img.height
      const ctx = canvas.getContext("2d")!
      ctx.drawImage(img, 0, 0)
      resolve(detectWallMass(canvas))
    }
    img.onerror = reject
    img.src = dataUrl
  })
}

function pointInPolygon(px: number, py: number, polygon: { x: number; y: number }[]): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i]!.x, yi = polygon[i]!.y
    const xj = polygon[j]!.x, yj = polygon[j]!.y
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}

export function clipWallMassToPolygon(
  wallMass: WallMassResult,
  polygon: { x: number; y: number }[]
): WallMassResult {
  const clipped = new Uint8Array(wallMass.mask.length)
  for (let y = 0; y < wallMass.height; y++) {
    for (let x = 0; x < wallMass.width; x++) {
      const idx = y * wallMass.width + x
      if (wallMass.mask[idx] && pointInPolygon(x, y, polygon)) {
        clipped[idx] = 1
      }
    }
  }
  return { mask: clipped, width: wallMass.width, height: wallMass.height }
}
