/**
 * Shrinks large data-URL images before OpenAI vision calls (analysis only).
 * Reversible: delete this module and stop calling from analyze-floorplan route.
 */

import { Buffer } from "node:buffer"

/** Longest edge cap; keeps aspect ratio (fit inside). */
export const FLOORPLAN_OPENAI_MAX_EDGE_PX = 1600

const DATA_URL_BASE64 = /^data:([^;,]+);base64,(.+)$/i

const SHARP_INPUT_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
])

export type DownscaleForOpenAIResult = {
  dataUrl: string
  originalPx: { width: number; height: number }
  outputPx: { width: number; height: number }
  originalBase64Chars: number
  outputBase64Chars: number
  didResize: boolean
}

/**
 * If the URL is a base64 image supported by sharp and max(w,h) > cap, resize (fit inside) and re-encode as JPEG.
 * Otherwise returns the input unchanged (still fills dimensions when derivable).
 */
export async function downscaleDataUrlForOpenAIIfNeeded(
  dataUrl: string
): Promise<DownscaleForOpenAIResult | null> {
  const m = DATA_URL_BASE64.exec(dataUrl.trim())
  if (!m) return null

  const mime = m[1].toLowerCase()
  if (!SHARP_INPUT_MIMES.has(mime)) return null

  let sharp: typeof import("sharp").default
  try {
    sharp = (await import("sharp")).default
  } catch {
    console.warn("[downscaleFloorplanImageForOpenAI] sharp not available; skipping downscale")
    return null
  }

  const b64 = m[2]
  const originalBase64Chars = b64.length
  const inputBuf = Buffer.from(b64, "base64")

  const meta = await sharp(inputBuf).metadata()
  const origW = meta.width ?? 0
  const origH = meta.height ?? 0
  if (!origW || !origH) return null

  const maxEdge = Math.max(origW, origH)
  if (maxEdge <= FLOORPLAN_OPENAI_MAX_EDGE_PX) {
    return {
      dataUrl,
      originalPx: { width: origW, height: origH },
      outputPx: { width: origW, height: origH },
      originalBase64Chars,
      outputBase64Chars: originalBase64Chars,
      didResize: false,
    }
  }

  const outBuf = await sharp(inputBuf)
    .resize(FLOORPLAN_OPENAI_MAX_EDGE_PX, FLOORPLAN_OPENAI_MAX_EDGE_PX, {
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: 88, mozjpeg: true })
    .toBuffer()

  const outMeta = await sharp(outBuf).metadata()
  const outW = outMeta.width ?? Math.round(origW * (FLOORPLAN_OPENAI_MAX_EDGE_PX / maxEdge))
  const outH = outMeta.height ?? Math.round(origH * (FLOORPLAN_OPENAI_MAX_EDGE_PX / maxEdge))

  const outputB64 = outBuf.toString("base64")
  const outputDataUrl = `data:image/jpeg;base64,${outputB64}`

  return {
    dataUrl: outputDataUrl,
    originalPx: { width: origW, height: origH },
    outputPx: { width: outW, height: outH },
    originalBase64Chars,
    outputBase64Chars: outputB64.length,
    didResize: true,
  }
}
