/**
 * Converts a wall-mass pixel mask into closed 2D polygons suitable for
 * Three.js ExtrudeGeometry.  Output coordinates are in metres, centred on the
 * outline-polygon centroid, with Y matching the Three.js scene's Z axis.
 */

import type { WallMassResult } from "./wallMassDetect"
import type { FloorplanPoint2D } from "./types"

// ---------------------------------------------------------------------------
// Connected-component labelling (4-connectivity BFS)
// ---------------------------------------------------------------------------

function labelComponents(
  mask: Uint8Array, w: number, h: number
): { labels: Int32Array; bboxes: Map<number, { minX: number; minY: number; maxX: number; maxY: number }> } {
  const labels = new Int32Array(w * h)
  const bboxes = new Map<number, { minX: number; minY: number; maxX: number; maxY: number }>()
  let next = 1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x
      if (!mask[idx] || labels[idx]) continue
      const label = next++
      const stack = [idx]
      labels[idx] = label
      const bb = { minX: x, minY: y, maxX: x, maxY: y }
      bboxes.set(label, bb)
      while (stack.length) {
        const ci = stack.pop()!
        const cx = ci % w, cy = (ci - cx) / w
        for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]] as const) {
          const nx = cx+dx, ny = cy+dy
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue
          const ni = ny*w+nx
          if (mask[ni] && !labels[ni]) {
            labels[ni] = label; stack.push(ni)
            if (nx < bb.minX) bb.minX = nx; if (nx > bb.maxX) bb.maxX = nx
            if (ny < bb.minY) bb.minY = ny; if (ny > bb.maxY) bb.maxY = ny
          }
        }
      }
    }
  }
  return { labels, bboxes }
}

// ---------------------------------------------------------------------------
// Pixel-boundary edge tracing (produces exact pixel-corner polygons)
// ---------------------------------------------------------------------------

function traceContours(
  w: number, h: number,
  labels: Int32Array, label: number,
  bb: { minX: number; minY: number; maxX: number; maxY: number }
): Array<[number, number][]> {
  const W1 = w + 1
  const adj = new Map<number, number>()

  const isLbl = (px: number, py: number) =>
    px >= 0 && px < w && py >= 0 && py < h && labels[py * w + px] === label

  const trySet = (from: number, to: number) => { if (!adj.has(from)) adj.set(from, to) }

  for (let py = bb.minY; py <= bb.maxY; py++) {
    for (let px = bb.minX; px <= bb.maxX; px++) {
      if (labels[py * w + px] !== label) continue
      if (!isLbl(px, py-1)) trySet(py*W1+px,        py*W1+(px+1))      // top
      if (!isLbl(px+1, py)) trySet(py*W1+(px+1),    (py+1)*W1+(px+1))  // right
      if (!isLbl(px, py+1)) trySet((py+1)*W1+(px+1), (py+1)*W1+px)     // bottom
      if (!isLbl(px-1, py)) trySet((py+1)*W1+px,     py*W1+px)         // left
    }
  }

  const visited = new Set<number>()
  const paths: Array<[number, number][]> = []

  for (const start of adj.keys()) {
    if (visited.has(start)) continue
    const path: [number, number][] = []
    let idx = start
    for (let guard = 0; guard < 2_000_000; guard++) {
      if (visited.has(idx)) break
      visited.add(idx)
      path.push([idx % W1, (idx - (idx % W1)) / W1])
      const next = adj.get(idx)
      if (next === undefined) break
      idx = next
    }
    if (path.length >= 4) paths.push(path)
  }
  return paths
}

// Remove intermediate collinear vertices from a pixel-grid polygon
function simplify(pts: [number, number][]): [number, number][] {
  if (pts.length <= 3) return pts
  const out: [number, number][] = [pts[0]!]
  for (let i = 1; i < pts.length - 1; i++) {
    const [ax, ay] = out[out.length - 1]!
    const [bx, by] = pts[i]!
    const [cx, cy] = pts[i + 1]!
    if ((bx-ax)*(cy-ay) !== (by-ay)*(cx-ax)) out.push(pts[i]!)
  }
  out.push(pts[pts.length - 1]!)
  return out
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

interface ContourOptions {
  wallMass: WallMassResult
  /** Outline polygon in image-pixel coordinates (auto-derived bounding box is fine). */
  outlineVertices: FloorplanPoint2D[]
  metersPerUnit: number
  imageDims: { w: number; h: number }
}

function pointInPolygon(px: number, py: number, poly: FloorplanPoint2D[]) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const { x: xi, y: yi } = poly[i]!, { x: xj, y: yj } = poly[j]!
    if ((yi > py) !== (yj > py) && px < ((xj-xi)*(py-yi))/(yj-yi)+xi) inside = !inside
  }
  return inside
}

/**
 * Returns wall polygons in scene coordinates:
 *   p.x → Three.js scene X
 *   p.y → Three.js scene Z  (image Y already negated and centred)
 */
export function wallMaskToPolygons(opts: ContourOptions): FloorplanPoint2D[][] {
  const { wallMass, outlineVertices, metersPerUnit: mpu, imageDims } = opts

  const scaleX = wallMass.width / imageDims.w
  const scaleY = wallMass.height / imageDims.h

  // Clip mask to outline polygon
  const maskPoly = outlineVertices.map(v => ({ x: v.x * scaleX, y: v.y * scaleY }))
  const clipped = new Uint8Array(wallMass.mask.length)
  for (let my = 0; my < wallMass.height; my++) {
    for (let mx = 0; mx < wallMass.width; mx++) {
      const i = my * wallMass.width + mx
      if (wallMass.mask[i] && pointInPolygon(mx, my, maskPoly)) clipped[i] = 1
    }
  }

  // Compute centroid of outline polygon in metre space (Y negated = scene Z)
  const polyM = outlineVertices.map(v => ({ x: v.x * mpu, y: -v.y * mpu }))
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const p of polyM) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y
  }
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2

  // Coordinate converters: mask corner pixel → centred scene metres
  const toX = (px: number) => (px / scaleX) * mpu - cx
  const toZ = (py: number) => -((py / scaleY) * mpu) - cy

  // Label components and filter noise
  const { labels, bboxes } = labelComponents(clipped, wallMass.width, wallMass.height)
  const shortSide = Math.min(wallMass.width, wallMass.height)
  const minAxis = Math.round(shortSide * 0.03)

  const result: FloorplanPoint2D[][] = []

  for (const [label, bb] of bboxes) {
    const longAxis = Math.max(bb.maxX - bb.minX + 1, bb.maxY - bb.minY + 1)
    if (longAxis < minAxis) continue

    const contours = traceContours(wallMass.width, wallMass.height, labels, label, bb)
    for (const raw of contours) {
      const simplified = simplify(raw)
      if (simplified.length < 4) continue
      result.push(simplified.map(([px, py]) => ({ x: toX(px), y: toZ(py) })))
    }
  }

  return result
}
