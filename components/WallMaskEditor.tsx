"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import type { WallMassResult } from "@/lib/wallMassDetect"
import { Button } from "@/components/ui/button"
import { Eraser, Paintbrush, Undo2 } from "lucide-react"

interface WallMaskEditorProps {
  imageSrc: string
  initialMask: WallMassResult
  onConfirm: (mask: WallMassResult) => void
  onCancel: () => void
}

export function WallMaskEditor({ imageSrc, initialMask, onConfirm, onCancel }: WallMaskEditorProps) {
  const bgCanvasRef = useRef<HTMLCanvasElement>(null)
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const maskRef = useRef(new Uint8Array(initialMask.mask))
  const historyRef = useRef<Uint8Array[]>([])
  const isDrawingRef = useRef(false)

  const [tool, setTool] = useState<"erase" | "paint">("erase")
  const [brushSize, setBrushSize] = useState(8)
  const [historyCount, setHistoryCount] = useState(0)
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null)

  const maskW = initialMask.width
  const maskH = initialMask.height

  const redrawOverlay = useCallback(() => {
    const canvas = overlayCanvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")!
    const mask = maskRef.current
    const imgData = new ImageData(maskW, maskH)
    const d = imgData.data
    for (let i = 0; i < maskW * maskH; i++) {
      if (mask[i]) {
        d[i * 4] = 220
        d[i * 4 + 1] = 30
        d[i * 4 + 2] = 30
        d[i * 4 + 3] = 170
      }
    }
    ctx.clearRect(0, 0, maskW, maskH)
    ctx.putImageData(imgData, 0, 0)
  }, [maskW, maskH])

  // Draw background image once
  useEffect(() => {
    const img = new Image()
    img.onload = () => {
      const canvas = bgCanvasRef.current
      if (!canvas) return
      canvas.getContext("2d")!.drawImage(img, 0, 0, maskW, maskH)
    }
    img.src = imageSrc
  }, [imageSrc, maskW, maskH])

  // Draw initial overlay
  useEffect(() => {
    redrawOverlay()
  }, [redrawOverlay])

  const getMaskCoords = useCallback((e: React.PointerEvent) => {
    const canvas = overlayCanvasRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    return {
      x: ((e.clientX - rect.left) / rect.width) * maskW,
      y: ((e.clientY - rect.top) / rect.height) * maskH,
    }
  }, [maskW, maskH])

  const applyBrush = useCallback((mx: number, my: number) => {
    const mask = maskRef.current
    const val = tool === "erase" ? 0 : 1
    const r = brushSize
    const x0 = Math.max(0, Math.floor(mx - r))
    const x1 = Math.min(maskW - 1, Math.ceil(mx + r))
    const y0 = Math.max(0, Math.floor(my - r))
    const y1 = Math.min(maskH - 1, Math.ceil(my + r))
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        mask[y * maskW + x] = val
      }
    }
    redrawOverlay()
  }, [tool, brushSize, maskW, maskH, redrawOverlay])

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    historyRef.current.push(new Uint8Array(maskRef.current))
    if (historyRef.current.length > 30) historyRef.current.shift()
    setHistoryCount(historyRef.current.length)
    isDrawingRef.current = true
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    const c = getMaskCoords(e)
    if (c) applyBrush(c.x, c.y)
  }, [applyBrush, getMaskCoords])

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    const c = getMaskCoords(e)
    if (c) setCursor({ x: e.clientX, y: e.clientY })
    if (!isDrawingRef.current || !c) return
    applyBrush(c.x, c.y)
  }, [applyBrush, getMaskCoords])

  const handlePointerUp = useCallback(() => {
    isDrawingRef.current = false
  }, [])

  const handleUndo = useCallback(() => {
    const prev = historyRef.current.pop()
    if (!prev) return
    maskRef.current = prev as Uint8Array<ArrayBuffer>
    setHistoryCount(historyRef.current.length)
    redrawOverlay()
  }, [redrawOverlay])

  const handleConfirm = useCallback(() => {
    onConfirm({ mask: maskRef.current, width: maskW, height: maskH })
  }, [onConfirm, maskW, maskH])

  // Cursor size in screen pixels
  const screenBrushRadius = (() => {
    const canvas = overlayCanvasRef.current
    if (!canvas) return brushSize
    return (brushSize / maskW) * canvas.clientWidth
  })()

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-muted/30 p-4 text-sm">
        <p className="font-medium mb-1">Edit detected walls</p>
        <ul className="list-disc list-inside text-muted-foreground space-y-0.5 text-xs">
          <li>
            Red areas = detected walls. Use <span className="font-semibold text-foreground">Erase</span> to remove incorrect areas.
          </li>
          <li>
            Use <span className="font-semibold text-foreground">Paint</span> to add back any walls that were missed.
          </li>
          <li>Adjust brush size with the slider.</li>
        </ul>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex gap-1 border border-border rounded-md p-1">
          <Button
            type="button"
            variant={tool === "erase" ? "default" : "ghost"}
            size="sm"
            onClick={() => setTool("erase")}
            className="gap-1.5 h-8"
          >
            <Eraser className="w-3.5 h-3.5" />
            Erase
          </Button>
          <Button
            type="button"
            variant={tool === "paint" ? "default" : "ghost"}
            size="sm"
            onClick={() => setTool("paint")}
            className="gap-1.5 h-8"
          >
            <Paintbrush className="w-3.5 h-3.5" />
            Paint
          </Button>
        </div>

        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground text-xs">Brush</span>
          <input
            type="range"
            min={4}
            max={100}
            value={brushSize}
            onChange={(e) => setBrushSize(Number(e.target.value))}
            className="w-28 accent-primary"
          />
          <span className="text-muted-foreground text-xs w-8">{brushSize}px</span>
        </div>

        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleUndo}
          disabled={historyCount === 0}
          className="gap-1.5 h-8"
        >
          <Undo2 className="w-3.5 h-3.5" />
          Undo
        </Button>
      </div>

      {/* Canvas stack */}
      <div
        ref={containerRef}
        className="relative inline-block border border-border rounded-md overflow-hidden select-none"
        onPointerLeave={() => setCursor(null)}
      >
        {/* Background: floor plan image */}
        <canvas
          ref={bgCanvasRef}
          width={maskW}
          height={maskH}
          className="block max-w-full h-auto pointer-events-none"
        />
        {/* Overlay: wall mask */}
        <canvas
          ref={overlayCanvasRef}
          width={maskW}
          height={maskH}
          className="absolute inset-0 w-full h-full"
          style={{ cursor: "none", touchAction: "none" }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        />
        {/* Custom brush cursor — square */}
        {cursor && (
          <div
            className="pointer-events-none absolute border-2 border-white mix-blend-difference"
            style={{
              width: screenBrushRadius * 2,
              height: screenBrushRadius * 2,
              left: cursor.x - (containerRef.current?.getBoundingClientRect().left ?? 0) - screenBrushRadius,
              top: cursor.y - (containerRef.current?.getBoundingClientRect().top ?? 0) - screenBrushRadius,
              background: tool === "erase" ? "rgba(255,255,255,0.15)" : "rgba(220,30,30,0.25)",
            }}
          />
        )}
      </div>

      <div className="flex items-center justify-between">
        <Button type="button" variant="outline" onClick={onCancel}>
          Back
        </Button>
        <Button type="button" onClick={handleConfirm}>
          Confirm walls
        </Button>
      </div>
    </div>
  )
}
