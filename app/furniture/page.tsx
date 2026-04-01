"use client"

import { useState, useEffect } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { ArrowLeft, ListPlus, Plus } from "lucide-react"
import { addToSelected } from "@/lib/selectedFurniture"
import { upsertPlacement } from "@/lib/roomLayout"
import type { ProductModelLifecycle } from "@/lib/productModelLifecycle"

const CATEGORIES = [
  { value: "sofa", label: "Sofa" },
  { value: "bed", label: "Bed" },
  { value: "dining_table", label: "Dining Table" },
] as const

interface Product extends ProductModelLifecycle {
  id: string
  title: string
  brand: string
  category: string
  image_url: string | null
  product_url: string | null
  price: number | null
  length_m: number | null
  width_m: number | null
  height_m: number | null
  dims_confidence?: number | null
  currency?: string | null
  model_url?: string | null
}

export default function FurniturePage() {
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]["value"]>("sofa")
  const [products, setProducts] = useState<Product[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    fetch(`/api/products?category=${category}`)
      .then((res) => {
        if (!res.ok) throw new Error("Failed to fetch")
        return res.json()
      })
      .then((data) => {
        setProducts(data.products ?? [])
      })
      .catch(() => setError("Failed to load products."))
      .finally(() => setLoading(false))
  }, [category])

  const [addedIds, setAddedIds] = useState<Set<string>>(new Set())

  const handleAddToList = (p: Product) => {
    addToSelected({
      id: p.id,
      title: p.title,
      brand: p.brand,
      category: p.category,
      image_url: p.image_url,
      product_url: p.product_url,
      price: p.price,
      currency: p.currency,
      length_m: p.length_m,
      width_m: p.width_m,
      height_m: p.height_m,
      dims_confidence: p.dims_confidence,
    })
    setAddedIds((prev) => new Set(prev).add(p.id))
    setTimeout(() => setAddedIds((prev) => {
      const next = new Set(prev)
      next.delete(p.id)
      return next
    }), 2000)
  }

  const handlePlaceInRoom = (p: Product) => {
    const hasDims =
      p.length_m != null && p.width_m != null && p.height_m != null &&
      p.length_m > 0 && p.width_m > 0 && p.height_m > 0

    if (!hasDims) return

    upsertPlacement({
      product_id: p.id,
      x: 0,
      z: 0,
      rotation_y_deg: 0,
    })

    const payload = {
      id: p.id,
      title: p.title,
      dims: { length_m: p.length_m, width_m: p.width_m, height_m: p.height_m },
      image_url: p.image_url,
      product_url: p.product_url,
      price: p.price,
    }
    console.log("Add payload:", payload)
    alert("Added to room! Visit /room to see it.")
  }

  return (
    <div className="min-h-screen p-6 bg-background">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="w-4 h-4" />
            Back
          </Link>
          <div className="flex gap-4">
            <Link href="/room" className="text-sm text-primary hover:underline">
              Room
            </Link>
            <Link href="/plan" className="text-sm text-primary hover:underline">
              Shopping list
            </Link>
          </div>
        </div>

        <h1 className="text-2xl font-bold mb-4">Furniture Library</h1>

        <div className="flex gap-2 mb-6">
          {CATEGORIES.map((c) => (
            <Button
              key={c.value}
              variant={category === c.value ? "default" : "outline"}
              size="sm"
              onClick={() => setCategory(c.value)}
            >
              {c.label}
            </Button>
          ))}
        </div>

        {loading && <p className="text-muted-foreground">Loading...</p>}
        {error && <p className="text-destructive">{error}</p>}

        {!loading && !error && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {products.map((p) => {
              const hasDims =
                p.length_m != null && p.width_m != null && p.height_m != null &&
                p.length_m > 0 && p.width_m > 0 && p.height_m > 0

              const hasUrl = !!p.product_url?.trim()
              const hasModel3d = !!p.model_url?.trim()

              return (
                <Card key={p.id} className="border-border overflow-hidden">
                  {p.image_url ? (
                    <div className="aspect-video bg-muted">
                      {hasUrl ? (
                        <a
                          href={p.product_url!}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="block w-full h-full cursor-pointer hover:opacity-90 transition-opacity"
                        >
                          <img
                            src={p.image_url}
                            alt={p.title}
                            className="w-full h-full object-cover"
                          />
                        </a>
                      ) : (
                        <img
                          src={p.image_url}
                          alt={p.title}
                          className="w-full h-full object-cover"
                        />
                      )}
                    </div>
                  ) : (
                    <div className="aspect-video bg-muted flex items-center justify-center text-muted-foreground text-sm">
                      No image
                    </div>
                  )}
                  <CardContent className="p-4">
                    {hasUrl ? (
                      <a
                        href={p.product_url!}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-medium truncate block cursor-pointer hover:text-primary hover:underline"
                      >
                        {p.title}
                      </a>
                    ) : (
                      <p className="font-medium truncate">{p.title}</p>
                    )}
                    <p className="text-sm text-muted-foreground">{p.brand}</p>
                    <div className="mt-2">
                      {hasModel3d ? (
                        <Badge variant="secondary" className="font-normal">
                          3D model available
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="font-normal text-muted-foreground">
                          No 3D model yet
                        </Badge>
                      )}
                    </div>
                    {p.price != null && (
                      <p className="text-sm mt-1">${p.price.toFixed(2)}</p>
                    )}
                    {hasDims && (
                      <p className="text-xs text-muted-foreground mt-1">
                        {p.length_m}m × {p.width_m}m × {p.height_m}m
                      </p>
                    )}
                    {!hasDims && (
                      <p className="text-xs text-amber-600 mt-1">No dimensions (list only)</p>
                    )}
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        className="gap-1"
                        onClick={() => handleAddToList(p)}
                      >
                        <ListPlus className="w-4 h-4" />
                        {addedIds.has(p.id) ? "Added ✓" : "Add to list"}
                      </Button>
                      <Button
                        size="sm"
                        className="gap-1"
                        disabled={!hasDims}
                        onClick={() => handlePlaceInRoom(p)}
                      >
                        <Plus className="w-4 h-4" />
                        Place in room
                      </Button>
                      {hasUrl && (
                        <a
                          href={p.product_url!}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center justify-center rounded-md text-sm font-medium text-primary hover:underline cursor-pointer px-3 py-2"
                        >
                          View on IKEA
                        </a>
                      )}
                    </div>
                  </CardContent>
                </Card>
              )
            })}
          </div>
        )}

        {!loading && !error && products.length === 0 && (
          <p className="text-muted-foreground">No products in this category.</p>
        )}
      </div>
    </div>
  )
}
