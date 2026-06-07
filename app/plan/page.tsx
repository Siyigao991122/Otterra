"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { ArrowLeft, ExternalLink, Trash2, X, ShoppingBag } from "lucide-react"
import {
  getSelected,
  clearSelected,
  removeSelected,
  type SelectedFurnitureItem,
} from "@/lib/selectedFurniture"

const TAX_RATE = 0.0875 // 8.75%

export default function PlanPage() {
  const router = useRouter()
  const [items, setItems] = useState<SelectedFurnitureItem[]>([])

  useEffect(() => { setItems(getSelected()) }, [])

  const handleRemove = (id: string) => setItems(removeSelected(id))
  const handleClear = () => { clearSelected(); setItems([]) }

  const subtotal = items.reduce((sum, i) => sum + (i.price ?? 0) * i.quantity, 0)
  const tax = subtotal * TAX_RATE
  const total = subtotal + tax
  const hasPrice = items.some(i => i.price != null)

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="border-b border-border bg-card">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <button
            onClick={() => router.back()}
            className="inline-flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to room
          </button>
          <h1 className="text-lg font-semibold">Order Summary</h1>
          <div className="w-28" />
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-6 py-8">
        {items.length === 0 ? (
          <div className="text-center py-24">
            <ShoppingBag className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
            <p className="text-lg font-medium mb-2">No items yet</p>
            <p className="text-muted-foreground mb-6">Add furniture to your room and click Checkout.</p>
            <Button onClick={() => router.back()}>Go back to room</Button>
          </div>
        ) : (
          <div className="grid lg:grid-cols-3 gap-8">
            {/* Item list */}
            <div className="lg:col-span-2 space-y-4">
              <div className="flex items-center justify-between mb-2">
                <h2 className="font-semibold">{items.length} {items.length === 1 ? "item" : "items"}</h2>
                <button
                  onClick={handleClear}
                  className="text-xs text-muted-foreground hover:text-destructive transition-colors flex items-center gap-1"
                >
                  <Trash2 className="w-3 h-3" />
                  Clear all
                </button>
              </div>

              {items.map((item) => (
                <div key={item.id} className="flex gap-4 bg-card border border-border rounded-xl p-4">
                  {/* Product image */}
                  <div className="shrink-0 w-24 h-24 rounded-lg bg-muted overflow-hidden">
                    {item.image_url ? (
                      <img
                        src={item.image_url}
                        alt={item.title}
                        className="w-full h-full object-cover"
                        onError={(e) => { (e.target as HTMLImageElement).style.display = "none" }}
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-muted-foreground text-xs text-center p-2">
                        {item.title}
                      </div>
                    )}
                  </div>

                  {/* Product info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="font-medium leading-tight">{item.title}</p>
                        {item.brand && (
                          <p className="text-sm text-muted-foreground">{item.brand}</p>
                        )}
                      </div>
                      <button
                        onClick={() => handleRemove(item.id)}
                        className="text-muted-foreground hover:text-destructive transition-colors shrink-0 mt-0.5"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>

                    {item.length_m != null && item.width_m != null && (
                      <p className="text-xs text-muted-foreground mt-1">
                        {item.width_m}m × {item.length_m}m × {item.height_m}m
                      </p>
                    )}

                    <div className="flex items-center justify-between mt-3">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">Qty: {item.quantity}</span>
                      </div>
                      <div className="flex items-center gap-3">
                        {item.product_url && (
                          <a
                            href={item.product_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-primary hover:underline flex items-center gap-1"
                          >
                            View on IKEA
                            <ExternalLink className="w-3 h-3" />
                          </a>
                        )}
                        {item.price != null && (
                          <span className="font-semibold">
                            ${(item.price * item.quantity).toFixed(2)}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* Order summary panel */}
            <div className="lg:col-span-1">
              <div className="bg-card border border-border rounded-xl p-6 sticky top-6">
                <h2 className="font-semibold mb-4">Price Summary</h2>

                <div className="space-y-3 text-sm">
                  {items.map((item) => item.price != null && (
                    <div key={item.id} className="flex justify-between text-muted-foreground">
                      <span className="truncate mr-2">{item.title} ×{item.quantity}</span>
                      <span className="shrink-0">${(item.price * item.quantity).toFixed(2)}</span>
                    </div>
                  ))}

                  {hasPrice && (
                    <>
                      <div className="border-t border-border pt-3 flex justify-between">
                        <span className="text-muted-foreground">Subtotal</span>
                        <span>${subtotal.toFixed(2)}</span>
                      </div>
                      <div className="flex justify-between text-muted-foreground">
                        <span>Estimated tax (8.75%)</span>
                        <span>${tax.toFixed(2)}</span>
                      </div>
                      <div className="border-t border-border pt-3 flex justify-between font-semibold text-base">
                        <span>Total</span>
                        <span>${total.toFixed(2)}</span>
                      </div>
                    </>
                  )}
                </div>

                <p className="text-xs text-muted-foreground mt-4 mb-6">
                  Items are purchased directly on IKEA's website. Click "View on IKEA" for each item to complete your purchase.
                </p>

                <div className="space-y-2">
                  {items.filter(i => i.product_url).map((item) => (
                    <a
                      key={item.id}
                      href={item.product_url!}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <Button variant="outline" className="w-full gap-2 text-sm justify-between" size="sm">
                        <span className="truncate">{item.title}</span>
                        <ExternalLink className="w-3 h-3 shrink-0" />
                      </Button>
                    </a>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
