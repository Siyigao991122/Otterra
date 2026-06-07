"use client"

import { useCallback, useRef, useState } from "react"
import { Button } from "@/components/ui/button"

interface Box { x: number; y: number; w: number; h: number }
type Handle = "tl" | "tr" | "bl" | "br" | "move"

interface CropBoxEditorProps {
  imageSrc: string
  wallMassOverlayUrl?: string | null
  /** Natural dimensions of the floor plan image */
  imageDims: { w: number; h: number }
  onConfirm: (box: Box) => void
  onCancel: () => void
}

export function CropBoxEditor({
  imageSrc,
  wallMassOverlayUrl,
  imageDims,
  onConfirm,
  onCancel,
}: CropBoxEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ handle: Handle; startX: number; startY: number; startBox: Box } | null>(null)

  const inset = 0.07
  const [box, setBox] = useState<Box>({
    x: imageDims.w * inset,
    y: imageDims.h * inset,
    w: imageDims.w * (1 - 2 * inset),
    h: imageDims.h * (1 - 2 * inset),
  })

  // Convert client coords → image-pixel coords
  const toImg = useCallback((clientX: number, clientY: number) => {
    const el = containerRef.current
    if (!el) return { x: 0, y: 0 }
    const r = el.getBoundingClientRect()
    return {
      x: ((clientX - r.left) / r.width) * imageDims.w,
      y: ((clientY - r.top) / r.height) * imageDims.h,
    }
  }, [imageDims])

  // Convert image-pixel coords → CSS percentage strings
  const pct = (v: number, total: number) => `${(v / total) * 100}%`

  const handlePointerDown = useCallback((handle: Handle, e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const p = toImg(e.clientX, e.clientY)
    dragRef.current = { handle, startX: p.x, startY: p.y, startBox: { ...box } }
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
  }, [box, toImg])

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return
    const { handle, startX, startY, startBox: b } = dragRef.current
    const p = toImg(e.clientX, e.clientY)
    const dx = p.x - startX
    const dy = p.y - startY
    const MIN = 40

    setBox(() => {
      let { x, y, w, h } = b
      if (handle === "move") {
        x = Math.max(0, Math.min(imageDims.w - w, b.x + dx))
        y = Math.max(0, Math.min(imageDims.h - h, b.y + dy))
      } else {
        if (handle === "tl" || handle === "bl") {
          const nx = Math.min(b.x + dx, b.x + b.w - MIN)
          w = b.w - (nx - b.x); x = nx
        }
        if (handle === "tr" || handle === "br") {
          w = Math.max(MIN, b.w + dx)
        }
        if (handle === "tl" || handle === "tr") {
          const ny = Math.min(b.y + dy, b.y + b.h - MIN)
          h = b.h - (ny - b.y); y = ny
        }
        if (handle === "bl" || handle === "br") {
          h = Math.max(MIN, b.h + dy)
        }
        x = Math.max(0, x); y = Math.max(0, y)
        w = Math.min(w, imageDims.w - x); h = Math.min(h, imageDims.h - y)
      }
      return { x, y, w, h }
    })
  }, [toImg, imageDims])

  const handlePointerUp = useCallback(() => { dragRef.current = null }, [])

  const { x, y, w, h } = box
  const x2 = x + w
  const y2 = y + h

  // Percentage values for CSS positioning
  const left   = pct(x,  imageDims.w)
  const top    = pct(y,  imageDims.h)
  const right  = pct(imageDims.w - x2, imageDims.w)
  const bottom = pct(imageDims.h - y2, imageDims.h)
  const bWidth  = pct(w, imageDims.w)
  const bHeight = pct(h, imageDims.h)

  const HANDLE_CLS = "absolute w-4 h-4 bg-white border-2 border-blue-500 rounded-sm shadow-md cursor-pointer z-10"

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-muted/30 p-4 text-sm">
        <p className="font-medium mb-1">Define the apartment boundary</p>
        <ul className="list-disc list-inside text-muted-foreground space-y-0.5 text-xs">
          <li>Drag the <span className="font-semibold text-foreground">corner handles</span> to include only the apartment area.</li>
          <li>Drag <span className="font-semibold text-foreground">inside the box</span> to move it.</li>
          <li>Everything outside the box will be discarded — the box itself is not a wall.</li>
        </ul>
      </div>

      {/* Canvas */}
      <div
        ref={containerRef}
        className="relative inline-block border border-border rounded-md overflow-hidden select-none"
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        {/* Floor plan image */}
        <img
          src={imageSrc}
          alt="Floor plan"
          className="block max-w-full h-auto pointer-events-none"
          draggable={false}
        />

        {/* Wall mass overlay */}
        {wallMassOverlayUrl && (
          <img
            src={wallMassOverlayUrl}
            alt=""
            className="absolute inset-0 w-full h-full pointer-events-none"
            style={{ opacity: 0.5 }}
            draggable={false}
          />
        )}

        {/* Dark overlay outside the crop box (4 panels) */}
        {/* Top */}
        <div className="absolute pointer-events-none bg-black/50"
          style={{ left: 0, top: 0, right: 0, height: top }} />
        {/* Bottom */}
        <div className="absolute pointer-events-none bg-black/50"
          style={{ left: 0, bottom: 0, right: 0, height: bottom }} />
        {/* Left */}
        <div className="absolute pointer-events-none bg-black/50"
          style={{ left: 0, top, width: left, height: bHeight }} />
        {/* Right */}
        <div className="absolute pointer-events-none bg-black/50"
          style={{ right: 0, top, width: right, height: bHeight }} />

        {/* Crop box border + move handle */}
        <div
          className="absolute border-2 border-white cursor-move"
          style={{
            left, top,
            width: bWidth,
            height: bHeight,
            boxShadow: "0 0 0 1px rgba(0,0,0,0.4)",
          }}
          onPointerDown={(e) => handlePointerDown("move", e)}
        />

        {/* Corner handles */}
        <div className={HANDLE_CLS}
          style={{ left, top, transform: "translate(-50%,-50%)", touchAction: "none" }}
          onPointerDown={(e) => handlePointerDown("tl", e)} />
        <div className={HANDLE_CLS}
          style={{ left: pct(x2, imageDims.w), top, transform: "translate(-50%,-50%)", touchAction: "none" }}
          onPointerDown={(e) => handlePointerDown("tr", e)} />
        <div className={HANDLE_CLS}
          style={{ left, top: pct(y2, imageDims.h), transform: "translate(-50%,-50%)", touchAction: "none" }}
          onPointerDown={(e) => handlePointerDown("bl", e)} />
        <div className={HANDLE_CLS}
          style={{ left: pct(x2, imageDims.w), top: pct(y2, imageDims.h), transform: "translate(-50%,-50%)", touchAction: "none" }}
          onPointerDown={(e) => handlePointerDown("br", e)} />
      </div>

      <div className="flex items-center justify-between">
        <Button type="button" variant="outline" onClick={onCancel}>
          Back
        </Button>
        <Button type="button" onClick={() => onConfirm(box)}>
          Confirm area
        </Button>
      </div>
    </div>
  )
}
