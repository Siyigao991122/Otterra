"use client"

import { useState } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ArrowLeft } from "lucide-react"

const CATEGORIES = [
  { value: "sofa", label: "Sofa" },
  { value: "bed", label: "Bed" },
  { value: "dining_table", label: "Dining Table" },
]

const BULK_MAX = 200

const initial = {
  category: "sofa",
  brand: "IKEA",
  title: "",
  image_url: "",
  product_url: "",
  price: "",
  length_m: "",
  width_m: "",
  height_m: "",
}

const MAPPING_PRESETS = {
  default: {
    label: "Default (generic Apify)",
    mapping: {
      title: ["title", "name"],
      image_url: ["image", "imageUrl", "images.0"],
      product_url: ["url", "productUrl"],
      price: ["price", "priceValue"],
      currency: "currency",
      length_m: "length_m",
      width_m: "width_m",
      height_m: "height_m",
      source_product_id: ["sku", "id", "productId"],
    },
  },
  ikea: {
    label: "IKEA Bycategory (this JSON schema)",
    mapping: {
      source_product_id: ["id"],
      title: ["title", "name"],
      product_url: ["url", "URL", "productUrl"],
      image_url: ["images.main", "images.all.0.url", "image", "imageUrl", "images.0"],
      price: ["price.currentPrice", "priceValue", "price"],
      currency: ["price.currency", "currency"],
      length_m: "length_m",
      width_m: "width_m",
      height_m: "height_m",
    },
  },
} as const

interface BulkResult {
  insertedCount: number
  skippedCount: number
  errors: { index: number; reason: string }[]
  inserted: { id: string; title: string; category: string }[]
}

export default function AdminImportPage() {
  const [form, setForm] = useState(initial)
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle")
  const [message, setMessage] = useState("")

  const [bulkJson, setBulkJson] = useState("")
  const [bulkPreset, setBulkPreset] = useState<keyof typeof MAPPING_PRESETS>("ikea")
  const [bulkCategory, setBulkCategory] = useState("sofa")
  const [bulkBrand, setBulkBrand] = useState("IKEA")
  const [bulkOnlyWithDims, setBulkOnlyWithDims] = useState(false)
  const [bulkStatus, setBulkStatus] = useState<"idle" | "loading" | "success" | "error">("idle")
  const [bulkMessage, setBulkMessage] = useState("")
  const [bulkResult, setBulkResult] = useState<BulkResult | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setStatus("loading")
    setMessage("")

    try {
      const res = await fetch("/api/products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category: form.category,
          brand: form.brand || "IKEA",
          title: form.title.trim(),
          image_url: form.image_url.trim() || undefined,
          product_url: form.product_url.trim() || undefined,
          price: form.price ? Number(form.price) : null,
          length_m: form.length_m ? Number(form.length_m) : null,
          width_m: form.width_m ? Number(form.width_m) : null,
          height_m: form.height_m ? Number(form.height_m) : null,
        }),
      })

      const data = await res.json()

      if (!res.ok) {
        setStatus("error")
        setMessage(data.error || "Failed to add product.")
        return
      }

      setStatus("success")
      setMessage("Product added successfully.")
      setForm(initial)
    } catch {
      setStatus("error")
      setMessage("Network error. Please try again.")
    }
  }

  const handleBulkImport = async () => {
    setBulkStatus("loading")
    setBulkMessage("")
    setBulkResult(null)

    let items: unknown[]
    try {
      const parsed = JSON.parse(bulkJson.trim())
      if (Array.isArray(parsed)) {
        items = parsed
      } else if (parsed && typeof parsed === "object" && Array.isArray(parsed.items)) {
        items = parsed.items
      } else {
        setBulkStatus("error")
        setBulkMessage("JSON must be an array or an object with an 'items' array.")
        return
      }
    } catch {
      setBulkStatus("error")
      setBulkMessage("Invalid JSON. Check your paste.")
      return
    }

    if (items.length === 0) {
      setBulkStatus("error")
      setBulkMessage("No items to import.")
      return
    }
    if (items.length > BULK_MAX) {
      setBulkStatus("error")
      setBulkMessage(`Too many items (${items.length}). Maximum ${BULK_MAX}. Split your import.`)
      return
    }

    try {
      const res = await fetch("/api/products/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items,
          defaults: { source: "apify", brand: bulkBrand, category: bulkCategory },
          mapping: MAPPING_PRESETS[bulkPreset].mapping,
          onlyWithDimensions: bulkOnlyWithDims,
        }),
      })

      const data = await res.json()

      if (!res.ok) {
        setBulkStatus("error")
        setBulkMessage(data.error || "Bulk import failed.")
        return
      }

      setBulkStatus("success")
      setBulkResult(data)
      setBulkMessage(
        `Imported ${data.insertedCount} products. ${data.skippedCount} skipped.`
      )
    } catch {
      setBulkStatus("error")
      setBulkMessage("Network error. Please try again.")
    }
  }

  return (
    <div className="min-h-screen p-6 bg-background">
      <div className="max-w-xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="w-4 h-4" />
            Back
          </Link>
          <Link
            href="/admin/products"
            className="text-sm text-primary hover:underline"
          >
            Edit 3D model URLs
          </Link>
        </div>

        <Card className="border-border">
          <CardHeader>
            <CardTitle>Import Product</CardTitle>
            <CardDescription>Add a furniture item to the internal library.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <Label htmlFor="category">Category</Label>
                <select
                  id="category"
                  value={form.category}
                  onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
                  disabled={status === "loading"}
                  className="mt-1.5 w-full h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {CATEGORIES.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <Label htmlFor="brand">Brand</Label>
                <Input
                  id="brand"
                  value={form.brand}
                  onChange={(e) => setForm((f) => ({ ...f, brand: e.target.value }))}
                  placeholder="IKEA"
                  disabled={status === "loading"}
                  className="mt-1.5"
                />
              </div>
              <div>
                <Label htmlFor="title">Title *</Label>
                <Input
                  id="title"
                  value={form.title}
                  onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                  placeholder="Product name"
                  required
                  disabled={status === "loading"}
                  className="mt-1.5"
                />
              </div>
              <div>
                <Label htmlFor="image_url">Image URL</Label>
                <Input
                  id="image_url"
                  type="url"
                  value={form.image_url}
                  onChange={(e) => setForm((f) => ({ ...f, image_url: e.target.value }))}
                  placeholder="https://..."
                  disabled={status === "loading"}
                  className="mt-1.5"
                />
              </div>
              <div>
                <Label htmlFor="product_url">Product URL</Label>
                <Input
                  id="product_url"
                  type="url"
                  value={form.product_url}
                  onChange={(e) => setForm((f) => ({ ...f, product_url: e.target.value }))}
                  placeholder="https://..."
                  disabled={status === "loading"}
                  className="mt-1.5"
                />
              </div>
              <div>
                <Label htmlFor="price">Price</Label>
                <Input
                  id="price"
                  type="number"
                  step="0.01"
                  value={form.price}
                  onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))}
                  placeholder="99.99"
                  disabled={status === "loading"}
                  className="mt-1.5"
                />
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <Label htmlFor="length_m">Length (m)</Label>
                  <Input
                    id="length_m"
                    type="number"
                    step="0.01"
                    value={form.length_m}
                    onChange={(e) => setForm((f) => ({ ...f, length_m: e.target.value }))}
                    placeholder="2.0"
                    disabled={status === "loading"}
                    className="mt-1.5"
                  />
                </div>
                <div>
                  <Label htmlFor="width_m">Width (m)</Label>
                  <Input
                    id="width_m"
                    type="number"
                    step="0.01"
                    value={form.width_m}
                    onChange={(e) => setForm((f) => ({ ...f, width_m: e.target.value }))}
                    placeholder="0.9"
                    disabled={status === "loading"}
                    className="mt-1.5"
                  />
                </div>
                <div>
                  <Label htmlFor="height_m">Height (m)</Label>
                  <Input
                    id="height_m"
                    type="number"
                    step="0.01"
                    value={form.height_m}
                    onChange={(e) => setForm((f) => ({ ...f, height_m: e.target.value }))}
                    placeholder="0.8"
                    disabled={status === "loading"}
                    className="mt-1.5"
                  />
                </div>
              </div>
              {message && (
                <p
                  className={`text-sm ${status === "error" ? "text-destructive" : "text-primary"}`}
                >
                  {message}
                </p>
              )}
              <Button type="submit" disabled={status === "loading"}>
                {status === "loading" ? "Adding..." : "Add Product"}
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card className="border-border mt-8">
          <CardHeader>
            <CardTitle>Bulk Import (Paste JSON)</CardTitle>
            <CardDescription>
              Paste Apify output or any array of items. Max {BULK_MAX} per import.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="bulk-preset" className="text-xs">Mapping preset</Label>
              <select
                id="bulk-preset"
                value={bulkPreset}
                onChange={(e) => {
                  const val = e.target.value as keyof typeof MAPPING_PRESETS
                  setBulkPreset(val)
                  if (val === "ikea") setBulkOnlyWithDims(false)
                }}
                disabled={bulkStatus === "loading"}
                className="mt-1 w-full h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm"
              >
                <option value="default">{MAPPING_PRESETS.default.label}</option>
                <option value="ikea">{MAPPING_PRESETS.ikea.label}</option>
              </select>
            </div>
            <div>
              <Label htmlFor="bulk-json">JSON (array or {"{ items: [...] }"})</Label>
              <textarea
                id="bulk-json"
                value={bulkJson}
                onChange={(e) => setBulkJson(e.target.value)}
                placeholder='[{"title":"Sofa","image":"https://..."}, ...]'
                rows={8}
                disabled={bulkStatus === "loading"}
                className="mt-1.5 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
            <div className="flex flex-wrap gap-4">
              <div>
                <Label htmlFor="bulk-category" className="text-xs">Category default</Label>
                <select
                  id="bulk-category"
                  value={bulkCategory}
                  onChange={(e) => setBulkCategory(e.target.value)}
                  disabled={bulkStatus === "loading"}
                  className="mt-1 w-full h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm"
                >
                  {CATEGORIES.map((c) => (
                    <option key={c.value} value={c.value}>{c.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <Label htmlFor="bulk-brand" className="text-xs">Brand default</Label>
                <Input
                  id="bulk-brand"
                  value={bulkBrand}
                  onChange={(e) => setBulkBrand(e.target.value)}
                  placeholder="IKEA"
                  disabled={bulkStatus === "loading"}
                  className="mt-1 w-32"
                />
              </div>
              <div className="flex items-end gap-2">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={bulkOnlyWithDims}
                    onChange={(e) => setBulkOnlyWithDims(e.target.checked)}
                    disabled={bulkStatus === "loading"}
                    className="rounded border-input"
                  />
                  <span className="text-sm">Only import items WITH dimensions</span>
                </label>
              </div>
            </div>
            <Button
              onClick={handleBulkImport}
              disabled={bulkStatus === "loading"}
            >
              {bulkStatus === "loading" ? "Importing..." : "Import"}
            </Button>
            {bulkMessage && (
              <p className={`text-sm ${bulkStatus === "error" ? "text-destructive" : "text-primary"}`}>
                {bulkMessage}
              </p>
            )}
            {bulkResult && (
              <div className="space-y-2 text-sm border-t pt-4">
                <p><strong>Inserted:</strong> {bulkResult.insertedCount}</p>
                <p><strong>Skipped:</strong> {bulkResult.skippedCount}</p>
                {bulkResult.errors.length > 0 && (
                  <div>
                    <p className="font-medium mt-2">Errors (first 10):</p>
                    <ul className="list-disc pl-4 text-muted-foreground">
                      {bulkResult.errors.slice(0, 10).map((e, i) => (
                        <li key={i}>#{e.index}: {e.reason}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {bulkResult.inserted.length > 0 && (
                  <div>
                    <p className="font-medium mt-2">Inserted (first 10):</p>
                    <ul className="list-disc pl-4 text-muted-foreground">
                      {bulkResult.inserted.slice(0, 10).map((p) => (
                        <li key={p.id}>{p.title} ({p.category})</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
