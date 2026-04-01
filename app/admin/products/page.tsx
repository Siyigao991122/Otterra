"use client"

import { useState, useEffect } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ArrowLeft, Save, Loader2, Box, Package } from "lucide-react"
import { cn } from "@/lib/utils"
import type { ProductModelLifecycle } from "@/lib/productModelLifecycle"

const CATEGORIES = [
  { value: "", label: "All" },
  { value: "sofa", label: "Sofa" },
  { value: "bed", label: "Bed" },
  { value: "dining_table", label: "Dining Table" },
] as const

interface Product extends ProductModelLifecycle {
  id: string
  title: string
  product_url: string | null
  image_url: string | null
  model_url: string | null
  category: string
}

export default function AdminProductsPage() {
  const [category, setCategory] = useState<string>("sofa")
  const [products, setProducts] = useState<Product[]>([])
  const [loading, setLoading] = useState(true)
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [savingId, setSavingId] = useState<string | null>(null)
  const [modelUrlStatus, setModelUrlStatus] = useState<
    Record<string, { ok: boolean; status: number; finalUrl?: string }>
  >({})

  const checkModelUrl = async (productId: string, url: string | null | undefined) => {
    if (!url?.trim()) {
      setModelUrlStatus((prev) => {
        const next = { ...prev }
        delete next[productId]
        return next
      })
      return
    }
    try {
      const res = await fetch(`/api/model-url/check?url=${encodeURIComponent(url.trim())}`)
      const data = await res.json()
      setModelUrlStatus((prev) => ({
        ...prev,
        [productId]: { ok: data.ok, status: data.status ?? 0, finalUrl: data.finalUrl },
      }))
    } catch {
      setModelUrlStatus((prev) => ({
        ...prev,
        [productId]: { ok: false, status: 0 },
      }))
    }
  }

  useEffect(() => {
    setLoading(true)
    const url = category ? `/api/products?category=${category}` : "/api/products"
    fetch(url)
      .then((res) => res.json())
      .then((data) => {
        const productsList = data.products ?? []
        setProducts(productsList)
        setEdits({})
        setModelUrlStatus({})
        const withModelUrl = productsList.filter(
          (p: Product) => p.model_url != null && String(p.model_url).trim() !== ""
        )
        Promise.allSettled(withModelUrl.map((p: Product) => checkModelUrl(p.id, p.model_url)))
      })
      .catch(() => setProducts([]))
      .finally(() => setLoading(false))
  }, [category])

  const handleSave = async (id: string) => {
    const value = edits[id] ?? products.find((p) => p.id === id)?.model_url ?? ""
    const model_url = value.trim() || null
    setSavingId(id)
    try {
      const res = await fetch(`/api/products/${id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "x-admin-api-key": process.env.NEXT_PUBLIC_ADMIN_API_KEY ?? "",
        },
        body: JSON.stringify({ model_url }),
      })
      if (!res.ok) throw new Error("Failed to update")
      const { product } = await res.json()
      setProducts((prev) => prev.map((p) => (p.id === id ? { ...p, model_url: product.model_url } : p)))
      setEdits((e) => {
        const next = { ...e }
        delete next[id]
        return next
      })
      await checkModelUrl(id, product.model_url)
    } catch {
      // Could add toast
    } finally {
      setSavingId(null)
    }
  }

  return (
    <div className="min-h-screen p-6 bg-background">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <Link
            href="/admin/import"
            className="inline-flex items-center gap-2 text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to Import
          </Link>
        </div>

        <Card className="border-border">
          <CardHeader>
            <CardTitle>Edit 3D Model URLs</CardTitle>
            <CardDescription>
              Set GLB model_url for top SKUs. Products with model_url render real 3D models in the room; others use proxy boxes.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex gap-2 mb-4">
              {CATEGORIES.map((c) => (
                <Button
                  key={c.value || "all"}
                  variant={category === c.value ? "default" : "outline"}
                  size="sm"
                  onClick={() => setCategory(c.value)}
                >
                  {c.label}
                </Button>
              ))}
            </div>

            {loading && (
              <p className="text-muted-foreground">Loading...</p>
            )}

            {!loading && products.length === 0 && (
              <p className="text-muted-foreground">No products in this category.</p>
            )}

            {!loading && products.length > 0 && (
              <div className="space-y-4">
                {products.map((p) => {
                  const currentValue = edits[p.id] ?? p.model_url ?? ""
                  const isSaving = savingId === p.id
                  const status = modelUrlStatus[p.id]
                  const hasUrl = !!(currentValue?.trim())
                  const isBroken = hasUrl && status && status.ok === false
                  const isOk = hasUrl && status && status.ok === true
                  const isChecking = hasUrl && !status

                  return (
                    <div
                      key={p.id}
                      className="flex flex-col sm:flex-row gap-4 items-start sm:items-center p-4 rounded-lg border border-border bg-muted/30"
                    >
                      <div className="shrink-0 w-16 h-16 rounded overflow-hidden bg-muted">
                        {p.image_url ? (
                          <img
                            src={p.image_url}
                            alt={p.title}
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-muted-foreground">
                            <Box className="w-6 h-6" />
                          </div>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-medium truncate">{p.title}</p>
                        {p.product_url && (
                          <a
                            href={p.product_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-primary hover:underline truncate block"
                          >
                            {p.product_url}
                          </a>
                        )}
                        <div className="flex items-center gap-2 mt-1">
                          {!hasUrl ? (
                            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                              <Box className="w-3 h-3" />
                              Proxy
                            </span>
                          ) : isBroken ? (
                            <span className="inline-flex items-center gap-1 text-xs text-red-600">
                              <Box className="w-3 h-3" />
                              Broken
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-xs text-green-600">
                              <Package className="w-3 h-3" />
                              3D model
                            </span>
                          )}
                          {hasUrl && (
                            isChecking ? (
                              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                                <Loader2 className="w-3 h-3 animate-spin" />
                                Checking...
                              </span>
                            ) : isOk ? (
                              <span
                                className="inline-flex items-center gap-1 text-xs text-green-600"
                                title={status?.finalUrl}
                              >
                                <Package className="w-3 h-3" />
                                3D OK
                              </span>
                            ) : isBroken ? (
                              <span
                                className="inline-flex items-center gap-1 text-xs text-red-600"
                                title={status?.finalUrl}
                              >
                                <Box className="w-3 h-3" />
                                Broken ({status?.status ?? "?"})
                              </span>
                            ) : null
                          )}
                        </div>
                      </div>
                      <div className="flex-1 w-full sm:min-w-[200px] flex gap-2">
                        <Input
                          placeholder="https://...glb"
                          value={currentValue}
                          onChange={(e) =>
                            setEdits((prev) => ({ ...prev, [p.id]: e.target.value }))
                          }
                          className={cn(
                            "font-mono text-sm",
                            isBroken && "border-red-500 focus-visible:ring-red-500"
                          )}
                        />
                        <Button
                          size="sm"
                          onClick={() => handleSave(p.id)}
                          disabled={isSaving}
                        >
                          {isSaving ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <Save className="w-4 h-4" />
                          )}
                        </Button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
