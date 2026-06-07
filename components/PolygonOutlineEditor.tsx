"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import type { FloorplanPoint2D } from "@/lib/types"

interface PolygonOutlineEditorProps {
  /** Image src to display under the polygon (PDF preview / floor plan image). */
  imageSrc: string
  /** Initial vertices in image-pixel coordinates. If omitted, auto-init to image bbox. */
  initialVertices?: FloorplanPoint2D[]
  /** Called whenever the polygon changes. Coordinates are in image-pixel space. */
  onChange?: (vertices: FloorplanPoint2D[]) => void
  /** Called when user clicks Confirm. */
  onConfirm?: (vertices: FloorplanPoint2D[]) => void
  /** Called when user clicks Cancel/Back. */
  onCancel?: () => void
  /** Optional wall mass overlay image (data URL). Rendered as a semi-transparent layer over the floor plan. */
  wallMassOverlayUrl?: string | null
}

/**
 * Polygon outline editor.
 * - Auto-initializes as a rectangle covering the image (if no initialVertices).
 * - Drag vertex handles to reposition.
 * - Click an edge midpoint (small "+") to insert a new vertex.
 * - Double-click a vertex to delete it (minimum 3 vertices kept).
 */
export function PolygonOutlineEditor({
  imageSrc,
  initialVertices,
  onChange,
  onConfirm,
  onCancel,
  wallMassOverlayUrl,
}: PolygonOutlineEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const imageRef = useRef<HTMLImageElement>(null)

  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null)
  const [vertices, setVertices] = useState<FloorplanPoint2D[]>(initialVertices ?? [])
  const [dragIdx, setDragIdx] = useState<number | null>(null)

  // Auto-init to inset rectangle once we know image size
  useEffect(() => {
    if (!imgSize || initialVertices && initialVertices.length >= 3) return
    if (vertices.length > 0) return
    const inset = 0.08
    const x0 = imgSize.w * inset
    const y0 = imgSize.h * inset
    const x1 = imgSize.w * (1 - inset)
    const y1 = imgSize.h * (1 - inset)
    setVertices([
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 },
    ])
  }, [imgSize, initialVertices, vertices.length])

  useEffect(() => {
    onChange?.(vertices)
  }, [vertices, onChange])

  const handleImageLoad = useCallback(() => {
    const img = imageRef.current
    if (img) setImgSize({ w: img.naturalWidth, h: img.naturalHeight })
  }, [])

  // Convert pointer event → image-pixel coordinates
  const pointerToImageCoords = useCallback((event: { clientX: number; clientY: number }) => {
    const img = imageRef.current
    if (!img) return null
    const rect = img.getBoundingClientRect()
    const x = ((event.clientX - rect.left) / rect.width) * img.naturalWidth
    const y = ((event.clientY - rect.top) / rect.height) * img.naturalHeight
    return { x, y }
  }, [])

  // Convert image-pixel → on-screen position (for handles overlay)
  const imageToScreen = useCallback((p: FloorplanPoint2D) => {
    const img = imageRef.current
    if (!img || !img.naturalWidth || !img.naturalHeight) return { left: 0, top: 0 }
    return {
      left: (p.x / img.naturalWidth) * img.clientWidth,
      top: (p.y / img.naturalHeight) * img.clientHeight,
    }
  }, [])

  const handleVertexPointerDown = useCallback((idx: number, e: React.PointerEvent) => {
    e.stopPropagation()
    e.preventDefault()
    setDragIdx(idx)
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
  }, [])

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (dragIdx == null) return
      const p = pointerToImageCoords(e.nativeEvent)
      if (!p) return
      setVertices((prev) => {
        const next = [...prev]
        next[dragIdx] = p
        return next
      })
    },
    [dragIdx, pointerToImageCoords]
  )

  const handlePointerUp = useCallback(() => {
    setDragIdx(null)
  }, [])

  const handleEdgeClick = useCallback(
    (edgeIdx: number) => {
      setVertices((prev) => {
        const next = [...prev]
        const a = prev[edgeIdx]!
        const b = prev[(edgeIdx + 1) % prev.length]!
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
        next.splice(edgeIdx + 1, 0, mid)
        return next
      })
    },
    []
  )

  const handleVertexDoubleClick = useCallback((idx: number) => {
    setVertices((prev) => {
      if (prev.length <= 3) return prev
      return prev.filter((_, i) => i !== idx)
    })
  }, [])

  const polygonPointsStr = vertices
    .map((v) => {
      const s = imageToScreen(v)
      return `${s.left.toFixed(1)},${s.top.toFixed(1)}`
    })
    .join(" ")

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-muted/30 p-4 text-sm">
        <p className="font-medium mb-1">Trace the outer walls</p>
        <ul className="list-disc list-inside text-muted-foreground space-y-0.5 text-xs">
          <li>Drag the corner dots to position them on the actual wall corners.</li>
          <li>Click the small <span className="font-bold text-blue-600">+</span> on any edge to add a new corner.</li>
          <li>Double-click a corner to remove it.</li>
        </ul>
      </div>

      <div
        ref={containerRef}
        className="relative inline-block border border-border rounded-md overflow-hidden bg-background select-none"
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        <img
          ref={imageRef}
          src={imageSrc}
          alt="Floor plan"
          onLoad={handleImageLoad}
          className="block max-w-full h-auto pointer-events-none"
          draggable={false}
        />

        {imgSize && wallMassOverlayUrl && (
          <img
            src={wallMassOverlayUrl}
            alt=""
            className="absolute inset-0 w-full h-full pointer-events-none"
            style={{ opacity: 0.45 }}
            draggable={false}
          />
        )}

        {imgSize && vertices.length >= 3 && (
          <svg
            className="absolute inset-0 pointer-events-none"
            width={imageRef.current?.clientWidth ?? imgSize.w}
            height={imageRef.current?.clientHeight ?? imgSize.h}
          >
            <polygon
              points={polygonPointsStr}
              fill="rgba(59, 130, 246, 0.15)"
              stroke="rgb(59, 130, 246)"
              strokeWidth={2}
            />
          </svg>
        )}

        {/* Edge midpoint "+" handles for adding vertices */}
        {imgSize && vertices.length >= 2 && vertices.map((v, i) => {
          const next = vertices[(i + 1) % vertices.length]!
          const mid = { x: (v.x + next.x) / 2, y: (v.y + next.y) / 2 }
          const screen = imageToScreen(mid)
          return (
            <button
              key={`edge-${i}`}
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                handleEdgeClick(i)
              }}
              className="absolute w-5 h-5 rounded-full bg-white border-2 border-blue-500 text-blue-600 text-xs font-bold flex items-center justify-center hover:bg-blue-50 cursor-pointer shadow-sm"
              style={{
                left: `${screen.left}px`,
                top: `${screen.top}px`,
                transform: "translate(-50%, -50%)",
              }}
              title="Add corner here"
            >
              +
            </button>
          )
        })}

        {/* Vertex handles (drawn last so they sit on top) */}
        {imgSize && vertices.map((v, i) => {
          const screen = imageToScreen(v)
          return (
            <div
              key={`v-${i}`}
              onPointerDown={(e) => handleVertexPointerDown(i, e)}
              onDoubleClick={() => handleVertexDoubleClick(i)}
              className={`absolute w-4 h-4 rounded-full bg-blue-500 border-2 border-white shadow cursor-grab active:cursor-grabbing ${
                dragIdx === i ? "ring-2 ring-blue-300" : ""
              }`}
              style={{
                left: `${screen.left}px`,
                top: `${screen.top}px`,
                transform: "translate(-50%, -50%)",
                touchAction: "none",
              }}
              title="Drag to move, double-click to delete"
            />
          )
        })}
      </div>

      <div className="flex items-center justify-between gap-3">
        <div className="text-xs text-muted-foreground">
          {vertices.length} corners
        </div>
        <div className="flex gap-2">
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-2 text-sm rounded-md border border-border hover:bg-muted"
            >
              Back
            </button>
          )}
          {onConfirm && (
            <button
              type="button"
              onClick={() => onConfirm(vertices)}
              disabled={vertices.length < 3}
              className="px-4 py-2 text-sm rounded-md bg-foreground text-background hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Confirm outline
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
