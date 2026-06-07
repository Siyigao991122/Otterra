"use client"

import { useState, useEffect, useCallback, Suspense } from "react"
import { useSearchParams, useRouter } from "next/navigation"
import Link from "next/link"
import { Header } from "@/components/header"
import { Room3DScene } from "@/components/room-3d-scene"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Card } from "@/components/ui/card"
import { ChevronDown, ChevronUp, Sparkles, ShoppingCart, Loader2, ExternalLink, Trash2, Camera, Download, Library } from "lucide-react"
import type { Furniture, RoomDimensions } from "@/lib/types"
import { readRoomDimensionsFromSession } from "@/lib/roomDimensionsSession"
import { addToSelectedWithQty, clearSelected } from "@/lib/selectedFurniture"
import {
  getLayout,
  saveLayout,
  clearLayout,
  removePlacement,
  type Placement as LayoutPlacement,
} from "@/lib/roomLayout"
import { extractProductIdFromFurnitureId } from "@/lib/extractProductIdFromFurnitureId"
import type { ProductModelLifecycle } from "@/lib/productModelLifecycle"


const DEFAULT_DIMS: RoomDimensions = { width: 5, depth: 4, height: 2.7 }
const PROXY_SIZE = { width: 2.0, height: 0.9, depth: 0.8 }

interface Placement {
  product_id: string
  title: string
  position: { x: number; z: number }
  rotation_y_deg: number
  qty: number
}

interface ShoppingItem {
  product_id: string
  title: string
  qty: number
}

interface CatalogProduct extends ProductModelLifecycle {
  id: string
  title: string
  price: number | null
  currency: string | null
  image_url: string | null
  product_url: string | null
  length_m: number | null
  width_m: number | null
  height_m: number | null
  brand?: string | null
  category?: string | null
  model_url?: string | null
}

interface DesignPlan {
  title: string
  placements: Placement[]
  shopping_list: ShoppingItem[]
  notes: string[]
}

function designPlacementToFurniture(
  p: Placement,
  catalog: CatalogProduct[],
  index: number
): Furniture {
  const prod = catalog.find((c) => c.id === p.product_id)
  const hasDims =
    prod &&
    prod.length_m != null &&
    prod.width_m != null &&
    prod.height_m != null &&
    prod.length_m > 0 &&
    prod.width_m > 0 &&
    prod.height_m > 0

  // DB → scene: width_m→X, length_m→Z, height_m→Y (see lib/dimensionSemantics.ts)
  const dims = hasDims
    ? {
        width: prod!.width_m!,
        height: prod!.height_m!,
        depth: prod!.length_m!,
      }
    : PROXY_SIZE

  return {
    id: `design-${p.product_id}-${index}`,
    type: "proxy",
    name: p.title,
    color: "#8b7355",
    dimensions: dims,
    position: [p.position.x, dims.height / 2, p.position.z],
    rotation: p.rotation_y_deg,
    model_url: prod?.model_url ?? undefined,
    dimensionsAuthoritative: !!hasDims,
  }
}

function layoutPlacementToFurniture(
  p: LayoutPlacement,
  catalog: CatalogProduct[],
  index: number
): Furniture {
  const prod = catalog.find((c) => c.id === p.product_id)
  const hasDims =
    prod &&
    prod.length_m != null &&
    prod.width_m != null &&
    prod.height_m != null &&
    prod.length_m > 0 &&
    prod.width_m > 0 &&
    prod.height_m > 0

  // DB → scene: width_m→X, length_m→Z, height_m→Y (see lib/dimensionSemantics.ts)
  const dims = hasDims
    ? {
        width: prod!.width_m!,
        height: prod!.height_m!,
        depth: prod!.length_m!,
      }
    : PROXY_SIZE

  return {
    id: `layout-${p.product_id}-${index}`,
    type: "proxy",
    name: prod?.title ?? "Furniture",
    color: "#8b7355",
    dimensions: dims,
    position: [p.x, dims.height / 2, p.z],
    rotation: p.rotation_y_deg,
    model_url: prod?.model_url ?? undefined,
    dimensionsAuthoritative: !!hasDims,
  }
}

function furnitureToLayoutPlacements(furniture: Furniture[]): LayoutPlacement[] {
  return furniture
    .map((f) => {
      const product_id = extractProductIdFromFurnitureId(f.id)
      if (!product_id) return null
      return {
        product_id,
        x: f.position[0],
        z: f.position[2],
        rotation_y_deg: f.rotation,
        qty: 1,
      }
    })
    .filter((p): p is LayoutPlacement => p !== null)
}

function RoomPageContent() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const [roomDimensions, setRoomDimensions] = useState<RoomDimensions>(DEFAULT_DIMS)
  const [prompt, setPrompt] = useState("")
  const [selectedCategory, setSelectedCategory] = useState<"sofa" | "bed" | "dining_table" | "chair">("sofa")
  const [loading, setLoading] = useState(false)
  const [plan, setPlan] = useState<DesignPlan | null>(null)
  const [catalog, setCatalog] = useState<CatalogProduct[]>([])
  const [lastResponse, setLastResponse] = useState<string>("")
  const [jsonExpanded, setJsonExpanded] = useState(false)
  const [placedFurniture, setPlacedFurniture] = useState<Furniture[]>([])
  const [selectedFurnitureId, setSelectedFurnitureId] = useState<string | null>(null)
  const [addedToCart, setAddedToCart] = useState(false)
  const [snapshotTrigger, setSnapshotTrigger] = useState(0)
  const [snapshotUrl, setSnapshotUrl] = useState<string | null>(null)

  // `useSearchParams()` may return a new object every render; depend only on a stable
  // string key so this effect does not loop on `setRoomDimensions`.
  const roomQueryKey = searchParams.toString()
  useEffect(() => {
    const sp = new URLSearchParams(roomQueryKey)
    const w = Number(sp.get("width")) || DEFAULT_DIMS.width
    const d = Number(sp.get("depth")) || DEFAULT_DIMS.depth
    const h = Number(sp.get("height")) || DEFAULT_DIMS.height
    const stored = readRoomDimensionsFromSession()
    const dimsMatchStored =
      stored != null &&
      Math.abs(stored.width - w) < 0.001 &&
      Math.abs(stored.depth - d) < 0.001 &&
      Math.abs(stored.height - h) < 0.001
    const next: RoomDimensions = {
      width: w,
      depth: d,
      height: h,
      ...(dimsMatchStored && stored.geometry ? { geometry: stored.geometry } : {}),
      ...(dimsMatchStored && stored.geometryEnvelopeSource
        ? { geometryEnvelopeSource: stored.geometryEnvelopeSource }
        : !dimsMatchStored
          ? { geometryEnvelopeSource: "manual-url" as const }
          : {}),
    }
    setRoomDimensions((prev) =>
      prev.width === next.width &&
      prev.depth === next.depth &&
      prev.height === next.height &&
      JSON.stringify(prev.geometry) === JSON.stringify(next.geometry)
        ? prev
        : next
    )
  }, [roomQueryKey])

  const handleGenerate = useCallback(async () => {
    setLoading(true)
    setPlan(null)
    setLastResponse("")
    try {
      // Pass currently placed furniture so AI can move them in-place rather than
      // replacing them with different products that may not have 3D models.
      const currentPlacements = placedFurniture
        .map((f) => {
          const productId = extractProductIdFromFurnitureId(f.id)
          if (!productId) return null
          return { product_id: productId, title: f.name, position: { x: f.position[0], z: f.position[2] }, rotation_y_deg: f.rotation }
        })
        .filter(Boolean)

      // Room zones: geometry.rooms stores centroid as a single-point polygon in scene metres
      const roomZones = (roomDimensions.geometry?.rooms ?? [])
        .filter(r => r.polygon?.length > 0)
        .map(r => ({
          name: r.label ?? "Room",
          x: r.polygon[0]!.x,
          z: -r.polygon[0]!.y,  // plan y → world -Z
        }))
      const res = await fetch("/api/design", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: prompt || "Design my living room + office",
          room: {
            width_m: roomDimensions.width,
            depth_m: roomDimensions.depth,
            height_m: roomDimensions.height,
          },
          category: selectedCategory,
          currentPlacements: currentPlacements.length > 0 ? currentPlacements : undefined,
          roomZones: roomZones.length > 0 ? roomZones : undefined,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Failed to generate design")

      const fetchedPlan: DesignPlan = data.plan
      const fetchedCatalog = data.catalog ?? []
      setPlan(fetchedPlan)
      setCatalog(fetchedCatalog)
      setLastResponse(JSON.stringify(data, null, 2))

      // Auto-apply the layout immediately — no need for a separate "Apply layout" click.
      const furniture = fetchedPlan.placements.map((p, i) => {
        const newItem = designPlacementToFurniture(p, fetchedCatalog, i)
        const existing = placedFurniture.find((f) => {
          const existingProductId = extractProductIdFromFurnitureId(f.id)
          return existingProductId === p.product_id
        })
        if (existing?.model_url && !newItem.model_url) {
          return { ...newItem, model_url: existing.model_url }
        }
        return newItem
      })
      setPlacedFurniture(furniture)
      const layout: LayoutPlacement[] = fetchedPlan.placements.map((p) => ({
        product_id: p.product_id,
        x: p.position.x,
        z: p.position.z,
        rotation_y_deg: p.rotation_y_deg,
        qty: p.qty,
      }))
      saveLayout(layout)
    } catch (err) {
      setLastResponse(err instanceof Error ? err.message : "Something went wrong")
    } finally {
      setLoading(false)
    }
  }, [prompt, roomDimensions, placedFurniture, selectedCategory])

  const handleAddAllToShoppingList = useCallback(() => {
    if (!plan || !catalog.length) return
    for (const item of plan.shopping_list) {
      const prod = catalog.find((c) => c.id === item.product_id)
      if (prod) {
        addToSelectedWithQty(
          {
            id: prod.id,
            title: prod.title,
            brand: prod.brand,
            category: prod.category,
            image_url: prod.image_url,
            product_url: prod.product_url,
            price: prod.price,
            currency: prod.currency,
            length_m: prod.length_m,
            width_m: prod.width_m,
            height_m: prod.height_m,
          },
          item.qty
        )
      }
    }
    setAddedToCart(true)
  }, [plan, catalog])

  /** Save all currently placed furniture to the shopping list and go to checkout. */
  const handleCheckout = useCallback(() => {
    if (!placedFurniture.length) return
    // Clear previous selection and add all placed items
    clearSelected()
    for (const f of placedFurniture) {
      const productId = extractProductIdFromFurnitureId(f.id)
      const prod = catalog.find((c) => c.id === productId)
      if (prod) {
        addToSelectedWithQty(
          {
            id: prod.id,
            title: prod.title,
            brand: prod.brand,
            category: prod.category,
            image_url: prod.image_url,
            product_url: prod.product_url,
            price: prod.price,
            currency: prod.currency,
            length_m: prod.length_m,
            width_m: prod.width_m,
            height_m: prod.height_m,
          },
          1
        )
      }
    }
    router.push("/plan")
  }, [placedFurniture, catalog, router])

  const handleSelectFurniture = useCallback((id: string | null) => {
    setSelectedFurnitureId(id)
  }, [])

  const handleMoveFurniture = useCallback((id: string, position: [number, number, number]) => {
    setPlacedFurniture((prev) => {
      const next = prev.map((f) => (f.id === id ? { ...f, position } : f))
      saveLayout(furnitureToLayoutPlacements(next))
      return next
    })
  }, [])

  const handleDeleteFurniture = useCallback((id: string) => {
    setPlacedFurniture((prev) => {
      const next = prev.filter((f) => f.id !== id)
  
      const productId = extractProductIdFromFurnitureId(id)
      if (productId) {
        removePlacement(productId)
      } else {
        saveLayout(furnitureToLayoutPlacements(next))
      }
  
      return next
    })
  
    setSelectedFurnitureId((prev) => (prev === id ? null : prev))
  }, [])

  const handleClearRoom = useCallback(() => {
    clearLayout()
    setPlacedFurniture([])
  }, [])

  useEffect(() => {
    let cancelled = false
    fetch("/api/products", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return
        const products: CatalogProduct[] = data.products ?? []
        setCatalog(products)
        const layout = getLayout()
        if (layout.length > 0) {
          const furniture = layout.map((p, i) => layoutPlacementToFurniture(p, products, i))
          setPlacedFurniture(furniture)
        }
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  return (
    <div className="flex flex-col h-screen bg-background">
      <Header showChat={true} onToggleChat={() => {}} hasFloorPlan={true} />

      <div className="flex flex-1 overflow-hidden">
        <main className="flex-1 relative">
          <Room3DScene
            roomDimensions={roomDimensions}
            placedFurniture={placedFurniture}
            products={catalog}
            debug={searchParams.get("debug") === "1"}
            sceneView="orbit"
            selectedId={selectedFurnitureId}
            onSelectFurniture={handleSelectFurniture}
            onMoveFurniture={handleMoveFurniture}
            onDeleteFurniture={handleDeleteFurniture}
            onDropFurniture={() => {}}
            isDragging={false}
            snapshotTrigger={snapshotTrigger}
            onSnapshotReady={setSnapshotUrl}
          />
        </main>

        <aside className="w-96 border-l border-border bg-card flex flex-col shrink-0">
          <div className="p-4 border-b border-border">
            <h2 className="font-semibold text-sm flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-primary" />
              AI Design Chat
            </h2>
            <p className="text-xs text-muted-foreground mt-1">
              Describe your ideal layout, then generate and apply.
            </p>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            <Link href="/furniture">
              <Button variant="outline" className="w-full gap-2">
                <Library className="w-4 h-4" />
                Browse Furniture
              </Button>
            </Link>

            <div>
              <label className="text-xs text-muted-foreground block mb-1.5">
                Prompt
              </label>
              <Textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Design my living room + office..."
                className="min-h-[80px] bg-input border-border resize-none"
                rows={3}
              />
            </div>

            <Button
              className="w-full gap-2"
              onClick={handleGenerate}
              disabled={loading}
            >
              {loading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Sparkles className="w-4 h-4" />
              )}
              Generate design
            </Button>

            {lastResponse && (
              <Card className="p-3 bg-muted/50 border-border">
                <p className="text-xs text-muted-foreground mb-2">
                  Last response
                </p>
                <p className="text-sm whitespace-pre-wrap break-words line-clamp-4">
                  {plan ? plan.title : lastResponse}
                </p>
                <button
                  type="button"
                  className="flex items-center gap-1 text-xs text-primary mt-2 hover:underline"
                  onClick={() => setJsonExpanded(!jsonExpanded)}
                >
                  {jsonExpanded ? (
                    <ChevronUp className="w-3 h-3" />
                  ) : (
                    <ChevronDown className="w-3 h-3" />
                  )}
                  {jsonExpanded ? "Collapse" : "Show"} JSON
                </button>
                {jsonExpanded && (
                  <pre className="mt-2 p-2 rounded bg-background text-xs overflow-auto max-h-48">
                    {lastResponse}
                  </pre>
                )}
              </Card>
            )}


            <Button
              variant="outline"
              className="w-full gap-2"
              onClick={() => setSnapshotTrigger((t) => t + 1)}
            >
              <Camera className="w-4 h-4" />
              Top-Down Snapshot
            </Button>

            {snapshotUrl && (
              <Card className="p-3 bg-muted/50 border-border">
                <p className="text-xs text-muted-foreground mb-2">
                  Top-down view for layout review
                </p>
                <img
                  src={snapshotUrl}
                  alt="Top-down room snapshot"
                  className="w-full rounded border border-border mb-2"
                />
                <a
                  href={snapshotUrl}
                  download="room-layout.png"
                  className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
                >
                  <Download className="w-4 h-4" />
                  Download
                </a>
              </Card>
            )}

            {placedFurniture.length > 0 && (
              <Button
                variant="outline"
                className="w-full gap-2 text-destructive hover:text-destructive"
                onClick={handleClearRoom}
              >
                <Trash2 className="w-4 h-4" />
                Clear room
              </Button>
            )}
          </div>

          {/* Checkout button — bottom of sidebar */}
          <div className="p-4 border-t border-border">
            <Button
              className="w-full gap-2"
              size="lg"
              onClick={handleCheckout}
              disabled={placedFurniture.length === 0}
            >
              <ShoppingCart className="w-4 h-4" />
              Checkout
              {placedFurniture.length > 0 && (
                <span className="ml-2 bg-primary-foreground/20 text-primary-foreground text-xs px-2 py-0.5 rounded-full">
                  {placedFurniture.length} items
                </span>
              )}
            </Button>
          </div>
        </aside>
      </div>
    </div>
  )
}

export default function RoomPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-screen">Loading...</div>}>
      <RoomPageContent />
    </Suspense>
  )
}
