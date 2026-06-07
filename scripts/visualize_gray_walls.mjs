/**
 * Color gray wall regions red, filtering out furniture.
 * Strategy: gray pixels connected to the wall network (border-touching component after dilation)
 * are walls; isolated interior gray blobs are furniture.
 * Usage: node scripts/visualize_gray_walls.mjs <pdf_path>
 */
import fs from "node:fs"
import path from "node:path"
import { createCanvas } from "@napi-rs/canvas"

function dilate(mask, w, h, r) {
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let f = false
    for (let dy = -r; dy <= r && !f; dy++) {
      const ny = y + dy; if (ny < 0 || ny >= h) continue
      for (let dx = -r; dx <= r && !f; dx++) {
        const nx = x + dx; if (nx < 0 || nx >= w) continue
        if (mask[ny * w + nx]) f = true
      }
    }
    if (f) out[y * w + x] = 1
  }
  return out
}

function labelComponents(mask, w, h) {
  const labels = new Int32Array(w * h)
  const sizes = new Map()
  let nextLabel = 1
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const idx = y * w + x
    if (!mask[idx] || labels[idx]) continue
    const label = nextLabel++; let size = 0
    const queue = [idx]; labels[idx] = label
    while (queue.length > 0) {
      const ci = queue.pop(); size++
      const cx = ci % w, cy = (ci - cx) / w
      for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nx = cx+dx, ny = cy+dy
        if (nx<0||nx>=w||ny<0||ny>=h) continue
        const ni = ny*w+nx
        if (mask[ni] && !labels[ni]) { labels[ni] = label; queue.push(ni) }
      }
    }
    sizes.set(label, size)
  }
  return { labels, sizes }
}

async function main() {
  const pdfPath = process.argv[2]
  if (!pdfPath) { console.error("Usage: node scripts/visualize_gray_walls.mjs <pdf_path>"); process.exit(1) }

  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs")
  const data = fs.readFileSync(pdfPath)
  const doc = await pdfjs.getDocument({ data: new Uint8Array(data.buffer) }).promise
  const page = await doc.getPage(1)

  const scale = 2
  const vp = page.getViewport({ scale })
  const w = Math.round(vp.width), h = Math.round(vp.height)

  const rc = createCanvas(w, h)
  const rctx = rc.getContext("2d")
  rctx.fillStyle = "white"; rctx.fillRect(0, 0, w, h)
  await page.render({ canvasContext: rctx, viewport: vp }).promise

  const id = rctx.getImageData(0, 0, w, h)
  const px = id.data

  // Step 1: Build gray mask [100-225, low saturation]
  const grayMask = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) {
    const r = px[i*4], g = px[i*4+1], b = px[i*4+2]
    const luma = Math.round(0.299*r + 0.587*g + 0.114*b)
    const sat = Math.max(r, g, b) - Math.min(r, g, b)
    if (luma >= 100 && luma <= 225 && sat <= 25) grayMask[i] = 1
  }
  console.log(`Gray pixels: ${grayMask.reduce((a,v)=>a+v,0)} (${(grayMask.reduce((a,v)=>a+v,0)/(w*h)*100).toFixed(1)}%)`)

  // Step 2: Label raw gray components (no dilation — preserves real separations)
  const { labels: rawLabels, sizes: rawSizes } = labelComponents(grayMask, w, h)

  // Step 3: Compute bounding boxes for each component
  const bboxes = new Map()
  for (const [label] of rawSizes) bboxes.set(label, { minX: w, minY: h, maxX: 0, maxY: 0 })
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const lbl = rawLabels[y * w + x]; if (!lbl) continue
    const bb = bboxes.get(lbl)
    if (x < bb.minX) bb.minX = x; if (x > bb.maxX) bb.maxX = x
    if (y < bb.minY) bb.minY = y; if (y > bb.maxY) bb.maxY = y
  }

  // Step 4: Filter by long-axis length AND aspect ratio
  // Walls: long axis >= minWallSpan AND aspect ratio >= 2 (elongated)
  // Furniture: small AND/OR roughly square
  const shortSide = Math.min(w, h)
  const minWallSpan = Math.round(shortSide * 0.04)  // at least 4% of short side

  const wallLabels = new Set()
  for (const [label, bb] of bboxes) {
    const bw = bb.maxX - bb.minX + 1
    const bh = bb.maxY - bb.minY + 1
    const longAxis = Math.max(bw, bh)
    const shortAxis = Math.min(bw, bh)
    const aspectRatio = longAxis / Math.max(shortAxis, 1)
    // Keep if: long enough AND (elongated OR large enough to be a wall section)
    if (longAxis >= minWallSpan && (aspectRatio >= 2.5 || longAxis >= shortSide * 0.15)) {
      wallLabels.add(label)
    }
  }
  console.log(`Shape filter (minSpan=${minWallSpan}, AR>=2.5): ${wallLabels.size}/${rawSizes.size} components kept`)

  const wallMask = new Uint8Array(w * h)
  let wallCount = 0
  for (let i = 0; i < w * h; i++) {
    if (rawLabels[i] > 0 && wallLabels.has(rawLabels[i])) { wallMask[i] = 1; wallCount++ }
  }
  console.log(`Wall gray pixels: ${wallCount} (${(wallCount/(w*h)*100).toFixed(1)}%)`)

  // Step 6: Render — original image with red overlay on wall gray pixels
  const oc = createCanvas(w, h)
  const octx = oc.getContext("2d")
  octx.drawImage(rc, 0, 0)

  const od = octx.getImageData(0, 0, w, h)
  const op = od.data
  for (let i = 0; i < w * h; i++) {
    if (wallMask[i]) {
      op[i*4] = 220; op[i*4+1] = 40; op[i*4+2] = 40; op[i*4+3] = 255
    }
  }
  octx.putImageData(od, 0, 0)

  // Legend
  octx.fillStyle = "rgba(0,0,0,0.85)"; octx.fillRect(10, 10, 460, 40)
  octx.font = "18px sans-serif"
  octx.fillStyle = "rgb(220,40,40)"; octx.fillRect(20, 20, 40, 20)
  octx.fillStyle = "white"
  octx.fillText(`Gray walls (connectivity filter, ${wallCount} px)`, 70, 38)

  const bn = path.basename(pdfPath, path.extname(pdfPath))
  const out = path.join(path.dirname(pdfPath), `${bn}_gray_walls.png`)
  fs.writeFileSync(out, oc.toBuffer("image/png"))
  console.log(`Saved: ${out}`)
}

main().catch(console.error)
