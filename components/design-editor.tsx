"use client"

import { useState, useCallback } from "react"
import { Header } from "./header"
import { FloorPlanUploader } from "./floor-plan-uploader"
import { Room3DScene } from "./room-3d-scene"
import { FurnitureSidebar } from "./furniture-sidebar"
import { AIChatPanel } from "./ai-chat-panel"
import type { Furniture, RoomDimensions } from "@/lib/types"

export function DesignEditor() {
  const [floorPlanUploaded, setFloorPlanUploaded] = useState(false)
  const [roomDimensions, setRoomDimensions] = useState<RoomDimensions>({
    width: 12,
    depth: 10,
    height: 3,
  })
  const [placedFurniture, setPlacedFurniture] = useState<Furniture[]>([])
  const [selectedFurnitureId, setSelectedFurnitureId] = useState<string | null>(null)
  const [showChat, setShowChat] = useState(false)
  const [draggedFurniture, setDraggedFurniture] = useState<Furniture | null>(null)

  const handleFloorPlanUpload = useCallback((dimensions: RoomDimensions) => {
    setRoomDimensions(dimensions)
    setFloorPlanUploaded(true)
  }, [])

  const handleDragStart = useCallback((furniture: Furniture) => {
    setDraggedFurniture(furniture)
  }, [])

  const handleDropFurniture = useCallback(
    (position: [number, number, number]) => {
      if (draggedFurniture) {
        const newFurniture: Furniture = {
          ...draggedFurniture,
          id: `${draggedFurniture.type}-${Date.now()}`,
          position,
          rotation: 0,
        }
        setPlacedFurniture((prev) => [...prev, newFurniture])
        setDraggedFurniture(null)
      }
    },
    [draggedFurniture],
  )

  const handleSelectFurniture = useCallback((id: string | null) => {
    setSelectedFurnitureId(id)
  }, [])

  const handleMoveFurniture = useCallback((id: string, position: [number, number, number]) => {
    setPlacedFurniture((prev) => prev.map((f) => (f.id === id ? { ...f, position } : f)))
  }, [])

  const handleRotateFurniture = useCallback((id: string) => {
    setPlacedFurniture((prev) => prev.map((f) => (f.id === id ? { ...f, rotation: (f.rotation + 90) % 360 } : f)))
  }, [])

  const handleDeleteFurniture = useCallback((id: string) => {
    setPlacedFurniture((prev) => prev.filter((f) => f.id !== id))
    setSelectedFurnitureId(null)
  }, [])

  const handleAddFromChat = useCallback((furniture: Furniture) => {
    const newFurniture: Furniture = {
      ...furniture,
      id: `${furniture.type}-${Date.now()}`,
      position: [0, furniture.dimensions.height / 2, 0],
      rotation: 0,
    }
    setPlacedFurniture((prev) => [...prev, newFurniture])
  }, [])

  return (
    <div className="flex flex-col h-screen bg-background">
      <Header showChat={showChat} onToggleChat={() => setShowChat(!showChat)} hasFloorPlan={floorPlanUploaded} />

      <div className="flex flex-1 overflow-hidden">
        {!floorPlanUploaded ? (
          <FloorPlanUploader onUpload={handleFloorPlanUpload} />
        ) : (
          <>
            <FurnitureSidebar
              onDragStart={handleDragStart}
              selectedId={selectedFurnitureId}
              onRotate={handleRotateFurniture}
              onDelete={handleDeleteFurniture}
            />

            <main className="flex-1 relative">
              <Room3DScene
                roomDimensions={roomDimensions}
                placedFurniture={placedFurniture}
                selectedId={selectedFurnitureId}
                onSelectFurniture={handleSelectFurniture}
                onMoveFurniture={handleMoveFurniture}
                onDropFurniture={handleDropFurniture}
                isDragging={!!draggedFurniture}
              />
            </main>

            {showChat && (
              <AIChatPanel
                onAddFurniture={handleAddFromChat}
                placedFurniture={placedFurniture}
                roomDimensions={roomDimensions}
              />
            )}
          </>
        )}
      </div>
    </div>
  )
}
