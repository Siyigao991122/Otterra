"use client"

import type React from "react"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Sofa, Lamp, Table2, Bed, Flower2, BookOpen, Tv, RotateCw, Trash2, GripVertical } from "lucide-react"
import type { Furniture } from "@/lib/types"
import { FURNITURE_CATALOG } from "@/lib/furniture-catalog"

interface FurnitureSidebarProps {
  onDragStart: (furniture: Furniture) => void
  selectedId: string | null
  onRotate: (id: string) => void
  onDelete: (id: string) => void
}

const categoryIcons: Record<string, React.ReactNode> = {
  seating: <Sofa className="w-4 h-4" />,
  tables: <Table2 className="w-4 h-4" />,
  lighting: <Lamp className="w-4 h-4" />,
  bedroom: <Bed className="w-4 h-4" />,
  decor: <Flower2 className="w-4 h-4" />,
  storage: <BookOpen className="w-4 h-4" />,
  electronics: <Tv className="w-4 h-4" />,
}

export function FurnitureSidebar({ onDragStart, selectedId, onRotate, onDelete }: FurnitureSidebarProps) {
  const [activeCategory, setActiveCategory] = useState("seating")

  const categories = Object.keys(FURNITURE_CATALOG)

  return (
    <aside className="w-72 border-r border-border bg-card flex flex-col">
      <div className="p-4 border-b border-border">
        <h2 className="font-semibold text-sm text-muted-foreground uppercase tracking-wider">Furniture Library</h2>
      </div>

      {selectedId && (
        <div className="p-4 border-b border-border bg-muted/30">
          <p className="text-sm text-muted-foreground mb-2">Selected Item</p>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              className="flex-1 gap-2 bg-transparent"
              onClick={() => onRotate(selectedId)}
            >
              <RotateCw className="w-4 h-4" />
              Rotate
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="flex-1 gap-2 text-destructive hover:text-destructive bg-transparent"
              onClick={() => onDelete(selectedId)}
            >
              <Trash2 className="w-4 h-4" />
              Delete
            </Button>
          </div>
        </div>
      )}

      <Tabs value={activeCategory} onValueChange={setActiveCategory} className="flex-1 flex flex-col">
        <TabsList className="grid grid-cols-4 mx-4 mt-4 bg-muted">
          {categories.slice(0, 4).map((category) => (
            <TabsTrigger
              key={category}
              value={category}
              className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
            >
              {categoryIcons[category]}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsList className="grid grid-cols-3 mx-4 mt-2 bg-muted">
          {categories.slice(4).map((category) => (
            <TabsTrigger
              key={category}
              value={category}
              className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
            >
              {categoryIcons[category]}
            </TabsTrigger>
          ))}
        </TabsList>

        <ScrollArea className="flex-1 px-4 py-4">
          {categories.map((category) => (
            <TabsContent key={category} value={category} className="mt-0 space-y-3">
              {FURNITURE_CATALOG[category].map((item, index) => (
                <FurnitureCard key={index} furniture={item} onDragStart={onDragStart} />
              ))}
            </TabsContent>
          ))}
        </ScrollArea>
      </Tabs>
    </aside>
  )
}

function FurnitureCard({
  furniture,
  onDragStart,
}: {
  furniture: Furniture
  onDragStart: (f: Furniture) => void
}) {
  return (
    <div
      className="group relative bg-muted/50 rounded-lg p-3 cursor-grab active:cursor-grabbing hover:bg-muted transition-colors border border-transparent hover:border-primary/30"
      onClick={() => onDragStart(furniture)}
    >
      <div className="flex items-center gap-3">
        <div
          className="w-12 h-12 rounded-lg flex items-center justify-center"
          style={{ backgroundColor: furniture.color + "20" }}
        >
          <div className="w-6 h-6 rounded" style={{ backgroundColor: furniture.color }} />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="font-medium text-sm truncate">{furniture.name}</h3>
          <p className="text-xs text-muted-foreground">
            {furniture.dimensions.width}m × {furniture.dimensions.depth}m
          </p>
        </div>
        <GripVertical className="w-4 h-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
      </div>
    </div>
  )
}
