"use client"

import { useState, useRef, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Send, Sparkles, Plus, Loader2 } from "lucide-react"
import type { Furniture, RoomDimensions } from "@/lib/types"

interface ChatMessage {
  id: string
  role: "user" | "assistant"
  text: string
  placements?: { title: string; qty: number }[]
}

interface AIChatPanelProps {
  onAddFurniture: (furniture: Furniture) => void
  onMoveFurniture?: (id: string, position: [number, number, number]) => void
  selectedFurnitureId?: string | null
  placedFurniture: Furniture[]
  roomDimensions: RoomDimensions
}

function detectCategory(prompt: string): string {
  const p = prompt.toLowerCase()
  if (p.includes("bed") || p.includes("bedroom") || p.includes("mattress")) return "bed"
  if (p.includes("dining") || p.includes("dinner") || p.includes("eating")) return "dining_table"
  return "sofa"
}

const QUICK_PROMPTS = [
  "IKEA sofa for living room",
  "Dining table under $400",
  "Scandinavian bedroom setup",
  "Modern living room layout",
]

export function AIChatPanel({
  onAddFurniture,
  placedFurniture,
  roomDimensions,
}: AIChatPanelProps) {
  const [input, setInput] = useState("")
  const [loading, setLoading] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "welcome",
      role: "assistant",
      text: `Hi! Tell me what you want and I'll place real furniture in your room.\n\nTry: "IKEA sofa under $500" or "Scandinavian dining table"`,
    },
  ])
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  const handleSend = async () => {
    const userText = input.trim()
    if (!userText || loading) return

    setInput("")
    setMessages((prev) => [
      ...prev,
      { id: `u-${Date.now()}`, role: "user", text: userText },
    ])
    setLoading(true)

    try {
      const category = detectCategory(userText)

      const currentPlacements = placedFurniture.map((f) => {
        const match = f.id.match(/^(?:design|layout)-(.+)-(\d+)$/)
        const productId = match ? match[1] : null
        return productId
          ? { product_id: productId, title: f.name, position: { x: f.position[0], z: f.position[2] }, rotation_y_deg: f.rotation }
          : null
      }).filter(Boolean)

      const res = await fetch("/api/design", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: userText,
          room: {
            width_m: roomDimensions.width,
            depth_m: roomDimensions.depth,
            height_m: roomDimensions.height,
          },
          category,
          currentPlacements: currentPlacements.length > 0 ? currentPlacements : undefined,
        }),
      })

      const data = await res.json()
      const plan = data.plan
      const catalog: Record<string, unknown>[] = data.catalog ?? []

      if (plan?.placements?.length > 0) {
        const placedItems: { title: string; qty: number }[] = []

        for (const placement of plan.placements) {
          const product = catalog.find((p) => p.id === placement.product_id) as Record<string, unknown> | undefined
          if (!product) continue

          const w = Number(product.width_m) || 2
          const h = Number(product.height_m) || 0.85
          const d = Number(product.length_m) || 0.9

          const furniture: Furniture = {
            id: `design-${placement.product_id}-${Date.now()}`,
            type: String(product.category ?? "sofa"),
            name: placement.title,
            color: "#8B7355",
            dimensions: { width: w, height: h, depth: d },
            position: [placement.position.x, h / 2, placement.position.z],
            rotation: placement.rotation_y_deg ?? 0,
            model_url: product.model_url ? String(product.model_url) : null,
            dimensionsAuthoritative: true,
          }
          onAddFurniture(furniture)
          placedItems.push({ title: placement.title, qty: placement.qty ?? 1 })
        }

        const totalCost = (plan.shopping_list ?? []).reduce((sum: number, item: Record<string, unknown>) => {
          const p = catalog.find((c) => c.id === item.product_id) as Record<string, unknown> | undefined
          return sum + (Number(p?.price) || 0) * (Number(item.qty) || 1)
        }, 0)

        setMessages((prev) => [
          ...prev,
          {
            id: `a-${Date.now()}`,
            role: "assistant",
            text: `**${plan.title}**\n\n${placedItems.length} piece(s) placed${totalCost > 0 ? ` — ~$${totalCost.toFixed(0)} total` : ""}.${plan.notes?.length ? "\n" + plan.notes.join(" ") : ""}`,
            placements: placedItems,
          },
        ])
      } else {
        setMessages((prev) => [
          ...prev,
          {
            id: `a-${Date.now()}`,
            role: "assistant",
            text: "No matching furniture found. Try specifying sofa, bed, or dining table — or adjust your budget.",
          },
        ])
      }
    } catch {
      setMessages((prev) => [
        ...prev,
        { id: `a-${Date.now()}`, role: "assistant", text: "Something went wrong. Please try again." },
      ])
    } finally {
      setLoading(false)
    }
  }

  return (
    <aside className="w-96 border-l border-border bg-card flex flex-col">
      <div className="p-4 border-b border-border">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-primary/20 flex items-center justify-center">
            <Sparkles className="w-4 h-4 text-primary" />
          </div>
          <div>
            <h2 className="font-semibold text-sm">AI Design Assistant</h2>
            <p className="text-xs text-muted-foreground">Places real furniture instantly</p>
          </div>
        </div>
      </div>

      <ScrollArea className="flex-1 p-4" ref={scrollRef}>
        <div className="space-y-4">
          {messages.map((msg) => (
            <div key={msg.id}>
              <div
                className={`rounded-2xl px-4 py-3 ${
                  msg.role === "user"
                    ? "bg-primary text-primary-foreground ml-8"
                    : "bg-muted mr-8"
                }`}
              >
                <p className="text-sm whitespace-pre-wrap">{msg.text}</p>
              </div>
              {msg.placements && msg.placements.length > 0 && (
                <div className="mt-2 mr-8 space-y-1">
                  {msg.placements.map((item, i) => (
                    <div key={i} className="text-xs text-muted-foreground flex items-center gap-1 px-1">
                      <Plus className="w-3 h-3" />
                      {item.qty > 1 ? `${item.qty}× ` : ""}{item.title}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}

          {loading && (
            <div className="flex items-center gap-2 text-muted-foreground mr-8">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span className="text-sm">Finding furniture...</span>
            </div>
          )}
        </div>
      </ScrollArea>

      {messages.length <= 1 && (
        <div className="p-4 border-t border-border">
          <p className="text-xs text-muted-foreground mb-2">Quick prompts</p>
          <div className="flex flex-wrap gap-2">
            {QUICK_PROMPTS.map((p, i) => (
              <Button
                key={i}
                variant="outline"
                size="sm"
                className="text-xs h-8 bg-transparent"
                onClick={() => setInput(p)}
              >
                {p}
              </Button>
            ))}
          </div>
        </div>
      )}

      <div className="p-4 border-t border-border">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            handleSend()
          }}
          className="flex gap-2"
        >
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="e.g. IKEA sofa under $500..."
            className="flex-1 bg-input"
            disabled={loading}
          />
          <Button type="submit" size="icon" disabled={!input.trim() || loading}>
            <Send className="w-4 h-4" />
          </Button>
        </form>
      </div>
    </aside>
  )
}
