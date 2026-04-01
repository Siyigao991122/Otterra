"use client"

import { useState, useEffect } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { ArrowLeft, Copy, Trash2, X } from "lucide-react"
import {
  getSelected,
  clearSelected,
  removeSelected,
  type SelectedFurnitureItem,
} from "@/lib/selectedFurniture"

export default function PlanPage() {
  const [items, setItems] = useState<SelectedFurnitureItem[]>([])
  const [copied, setCopied] = useState(false)

  const loadItems = () => setItems(getSelected())

  useEffect(() => {
    loadItems()
  }, [])

  const handleExportJson = () => {
    const json = JSON.stringify(items, null, 2)
    navigator.clipboard.writeText(json).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  const handleClear = () => {
    clearSelected()
    loadItems()
  }

  const handleRemove = (id: string) => {
    setItems(removeSelected(id))
  }

  return (
    <div className="min-h-screen p-6 bg-background">
      <div className="max-w-2xl mx-auto">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-muted-foreground hover:text-foreground mb-6"
        >
          <ArrowLeft className="w-4 h-4" />
          Back
        </Link>

        <h1 className="text-2xl font-bold mb-4">Shopping List</h1>

        {items.length === 0 ? (
          <Card className="border-border">
            <CardContent className="p-8 text-center text-muted-foreground">
              <p>Your list is empty.</p>
              <Link href="/furniture" className="text-primary hover:underline mt-2 inline-block">
                Browse furniture
              </Link>
            </CardContent>
          </Card>
        ) : (
          <>
            <div className="flex gap-2 mb-4">
              <Button size="sm" variant="outline" onClick={handleExportJson} className="gap-1">
                <Copy className="w-4 h-4" />
                {copied ? "Copied!" : "Export JSON"}
              </Button>
              <Button size="sm" variant="outline" onClick={handleClear} className="gap-1 text-destructive hover:text-destructive">
                <Trash2 className="w-4 h-4" />
                Clear
              </Button>
            </div>

            <div className="space-y-3">
              {items.map((item) => (
                <Card key={item.id} className="border-border">
                  <CardContent className="p-4 flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="font-medium truncate">{item.title}</p>
                        <span className="text-xs text-muted-foreground shrink-0">
                          ×{item.quantity}
                        </span>
                      </div>
                      {item.brand && (
                        <p className="text-sm text-muted-foreground">{item.brand}</p>
                      )}
                      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1 text-sm text-muted-foreground">
                        {item.price != null && (
                          <span>${item.price.toFixed(2)}</span>
                        )}
                        {item.length_m != null && item.width_m != null && item.height_m != null && (
                          <span>
                            {item.length_m}m × {item.width_m}m × {item.height_m}m
                          </span>
                        )}
                      </div>
                      {item.product_url && (
                        <a
                          href={item.product_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-sm text-primary hover:underline mt-1 inline-block"
                        >
                          View product
                        </a>
                      )}
                    </div>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="shrink-0 h-8 w-8 text-muted-foreground hover:text-destructive"
                      onClick={() => handleRemove(item.id)}
                      aria-label="Remove"
                    >
                      <X className="w-4 h-4" />
                    </Button>
                  </CardContent>
                </Card>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
