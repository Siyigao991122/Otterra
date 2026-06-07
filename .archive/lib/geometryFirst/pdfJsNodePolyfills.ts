/**
 * pdf.js expects `DOMMatrix` / `Path2D` / `ImageData` on `globalThis` in Node (worker shading + display helpers).
 * **Package:** `@napi-rs/canvas` — same dependency pdf.js tries to load internally (see pdf.mjs `isNodeJS` block).
 * We assign globals from our app dependency *before* importing `pdfjs-dist` so Next’s bundle resolution is reliable.
 */

import { createRequire } from "node:module"

export type PdfJsGlobalsStatus =
  | { ok: true; source: "global-pre-existing" | "@napi-rs/canvas" }
  | { ok: false; source: "failed"; detail: string }

export function ensurePdfJsCanvasGlobals(): PdfJsGlobalsStatus {
  const processWithBuiltin = process as typeof process & {
    getBuiltinModule?: (id: string) => unknown
  }
  if (typeof processWithBuiltin.getBuiltinModule !== "function") {
    const require = createRequire(import.meta.url)
    processWithBuiltin.getBuiltinModule = (id: string) => {
      try {
        return require(id)
      } catch {
        return undefined
      }
    }
  }

  if (
    typeof globalThis.DOMMatrix === "function" &&
    typeof globalThis.Path2D === "function" &&
    typeof globalThis.ImageData === "function"
  ) {
    return { ok: true, source: "global-pre-existing" }
  }

  try {
    const require = createRequire(import.meta.url)
    const canvas = require("@napi-rs/canvas") as {
      DOMMatrix?: new (...args: unknown[]) => unknown
      Path2D?: new (...args: unknown[]) => unknown
      ImageData?: new (...args: unknown[]) => unknown
    }

    const g = globalThis as unknown as {
      DOMMatrix?: unknown
      Path2D?: unknown
      ImageData?: unknown
    }

    if (typeof canvas.DOMMatrix === "function") {
      g.DOMMatrix = canvas.DOMMatrix as typeof g.DOMMatrix
    }
    if (typeof canvas.Path2D === "function" && typeof g.Path2D !== "function") {
      g.Path2D = canvas.Path2D
    }
    if (typeof canvas.ImageData === "function" && typeof g.ImageData !== "function") {
      g.ImageData = canvas.ImageData
    }

    if (typeof g.DOMMatrix !== "function") {
      return {
        ok: false,
        source: "failed",
        detail: "@napi-rs/canvas loaded but DOMMatrix is missing",
      }
    }
    return { ok: true, source: "@napi-rs/canvas" }
  } catch (e) {
    return {
      ok: false,
      source: "failed",
      detail: e instanceof Error ? e.message : String(e),
    }
  }
}
