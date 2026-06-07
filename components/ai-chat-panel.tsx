"use client"

import { useState, useRef, useEffect } from "react"
import { useChat } from "@ai-sdk/react"
import { DefaultChatTransport } from "ai"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Card } from "@/components/ui/card"
import { Send, Sparkles, Plus, Loader2 } from "lucide-react"
import type { Furniture, RoomDimensions } from "@/lib/types"
import { FURNITURE_CATALOG } from "@/lib/furniture-catalog"

interface AIChatPanelProps {
  onAddFurniture: (furniture: Furniture) => void
  onMoveFurniture?: (id: string, position: [number, number, number]) => void
  selectedFurnitureId?: string | null
  placedFurniture: Furniture[]
  roomDimensions: RoomDimensions
}

export function AIChatPanel({ onAddFurniture, onMoveFurniture, selectedFurnitureId, placedFurniture, roomDimensions }: AIChatPanelProps) {
  const [input, setInput] = useState("")
  const scrollRef = useRef<HTMLDivElement>(null)

  const { messages, sendMessage, status } = useChat({
    transport: new DefaultChatTransport({ api: "/api/chat" }),
    initialMessages: [
      {
        id: "welcome",
        role: "assistant",
        content: `Hello! I'm your AI interior design assistant. I can help you:

• **Recommend furniture** based on your room size and style preferences
• **Suggest color schemes** that complement your space
• **Optimize furniture placement** for better flow
• **Find matching pieces** for your existing furniture

Your room is ${roomDimensions.width}m × ${roomDimensions.depth}m. What style are you going for?`,
        parts: [
          {
            type: "text" as const,
            text: `Hello! I'm your AI interior design assistant. I can help you:

• **Recommend furniture** based on your room size and style preferences
• **Suggest color schemes** that complement your space
• **Optimize furniture placement** for better flow
• **Find matching pieces** for your existing furniture

Your room is ${roomDimensions.width}m × ${roomDimensions.depth}m. What style are you going for?`,
          },
        ],
        createdAt: new Date(),
      },
    ],
  })

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  const handleSend = () => {
    if (!input.trim() || status !== "ready") return

    const context = `Room: ${roomDimensions.width}m × ${roomDimensions.depth}m, ${roomDimensions.height}m ceiling. Current furniture: ${placedFurniture.map((f) => f.name).join(", ") || "none"}.`

    sendMessage({
      text: `${input}\n\n[Context: ${context}]`,
    })
    setInput("")
  }

  // Parse furniture recommendations from AI response
  const parseFurnitureRecommendations = (content: string): Furniture[] => {
    const recommendations: Furniture[] = []
    const allFurniture = Object.values(FURNITURE_CATALOG).flat()

    // Simple matching - check if any furniture names are mentioned
    allFurniture.forEach((item) => {
      if (
        content.toLowerCase().includes(item.name.toLowerCase()) ||
        content.toLowerCase().includes(item.type.toLowerCase())
      ) {
        if (!recommendations.find((r) => r.name === item.name)) {
          recommendations.push(item)
        }
      }
    })

    return recommendations.slice(0, 3)
  }

  const quickPrompts = [
    "Suggest a modern living room setup",
    "What furniture works for a small space?",
    "Recommend a cozy reading corner",
    "Help me choose a color scheme",
  ]

  return (
    <aside className="w-96 border-l border-border bg-card flex flex-col">
      <div className="p-4 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-primary/20 flex items-center justify-center">
            <Sparkles className="w-4 h-4 text-primary" />
          </div>
          <div>
            <h2 className="font-semibold text-sm">AI Design Assistant</h2>
            <p className="text-xs text-muted-foreground">Powered by AI</p>
          </div>
        </div>
      </div>

      <ScrollArea className="flex-1 p-4" ref={scrollRef}>
        <div className="space-y-4">
          {messages.map((message) => (
            <div key={message.id}>
              <div
                className={`rounded-2xl px-4 py-3 ${
                  message.role === "user" ? "bg-primary text-primary-foreground ml-8" : "bg-muted mr-8"
                }`}
              >
                <p className="text-sm whitespace-pre-wrap">
                  {message.parts?.find((p) => p.type === "text")?.text || message.content}
                </p>
              </div>

              {message.role === "assistant" && message.id !== "welcome" && (
                <div className="mt-2 mr-8">
                  {parseFurnitureRecommendations(
                    message.parts?.find((p) => p.type === "text")?.text || message.content || "",
                  ).map((furniture, idx) => (
                    <Card
                      key={idx}
                      className="p-3 mt-2 bg-muted/50 hover:bg-muted transition-colors cursor-pointer group"
                      onClick={() => {
                        // If a piece of furniture is already selected in the scene,
                        // move it to the suggested position instead of adding a new one.
                        if (selectedFurnitureId && onMoveFurniture) {
                          onMoveFurniture(selectedFurnitureId, furniture.position)
                        } else {
                          onAddFurniture(furniture)
                        }
                      }}
                    >
                      <div className="flex items-center gap-3">
                        <div
                          className="w-10 h-10 rounded-lg flex items-center justify-center"
                          style={{ backgroundColor: furniture.color + "20" }}
                        >
                          <div className="w-5 h-5 rounded" style={{ backgroundColor: furniture.color }} />
                        </div>
                        <div className="flex-1">
                          <p className="text-sm font-medium">{furniture.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {furniture.dimensions.width}m × {furniture.dimensions.depth}m
                          </p>
                        </div>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          {selectedFurnitureId ? <span className="text-xs">Move</span> : <Plus className="w-4 h-4" />}
                        </Button>
                      </div>
                    </Card>
                  ))}
                </div>
              )}
            </div>
          ))}

          {status === "streaming" && (
            <div className="flex items-center gap-2 text-muted-foreground mr-8">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span className="text-sm">Thinking...</span>
            </div>
          )}
        </div>
      </ScrollArea>

      {messages.length <= 1 && (
        <div className="p-4 border-t border-border">
          <p className="text-xs text-muted-foreground mb-2">Quick prompts</p>
          <div className="flex flex-wrap gap-2">
            {quickPrompts.map((prompt, idx) => (
              <Button
                key={idx}
                variant="outline"
                size="sm"
                className="text-xs h-8 bg-transparent"
                onClick={() => {
                  setInput(prompt)
                }}
              >
                {prompt}
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
            placeholder="Ask for design advice..."
            className="flex-1 bg-input"
            disabled={status !== "ready"}
          />
          <Button type="submit" size="icon" disabled={!input.trim() || status !== "ready"}>
            <Send className="w-4 h-4" />
          </Button>
        </form>
      </div>
    </aside>
  )
}
