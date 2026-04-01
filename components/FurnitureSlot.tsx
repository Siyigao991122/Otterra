"use client"

import { Suspense } from "react"
import { Html } from "@react-three/drei"
import { FurnitureModel, type GlbBboxInfo } from "@/components/furniture-model"
import { FurnitureProxy } from "@/components/FurnitureProxy"
import { ModelErrorBoundary } from "@/components/ModelErrorBoundary"
import type { Furniture } from "@/lib/types"
import type { ProductModelLifecycle } from "@/lib/productModelLifecycle"

interface Product extends ProductModelLifecycle {
  id: string
  title?: string | null
  model_url?: string | null
  [key: string]: unknown
}

interface FurnitureSlotProps {
  furniture: Furniture
  product?: Product | null
  isSelected: boolean
  showModelLabel?: boolean
  /** Internal: report GLB bbox when loaded (for debug overlay) */
  onBboxReady?: (info: GlbBboxInfo) => void
}

function ProxyWithSelection({
  furniture,
  isSelected,
  showModelLabel = true,
}: FurnitureSlotProps) {
  const { width, height, depth } = furniture.dimensions
  return (
    <group>
      <FurnitureProxy
        width={width}
        height={height}
        depth={depth}
        color={furniture.color}
      />
      {isSelected && (
        <>
          <mesh position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
            <ringGeometry args={[Math.max(width, depth) / 2 + 0.1, Math.max(width, depth) / 2 + 0.2, 32]} />
            <meshBasicMaterial color="#d4a853" transparent opacity={0.8} />
          </mesh>
          {showModelLabel && (
            <Html position={[0, height / 2 + 0.3, 0]} center>
              <span className="text-xs bg-card/90 border border-border rounded px-2 py-0.5 shadow-sm whitespace-nowrap">
                Proxy
              </span>
            </Html>
          )}
        </>
      )}
    </group>
  )
}

export function FurnitureSlot({ furniture, product, isSelected, showModelLabel = true, onBboxReady }: FurnitureSlotProps) {
  const modelUrl = (product?.model_url ?? furniture.model_url)?.trim()
  const proxyFallback = (
    <ProxyWithSelection
      furniture={furniture}
      isSelected={isSelected}
      showModelLabel={showModelLabel}
    />
  )

  if (!modelUrl) {
    return proxyFallback
  }

  const furnitureWithModel = { ...furniture, model_url: modelUrl }
  return (
    <ModelErrorBoundary
      fallback={proxyFallback}
      onError={(error) => {
        console.warn(
          "[FurnitureSlot] GLB load failed, using proxy fallback:",
          { productId: product?.id, productTitle: product?.title ?? furniture.name, model_url: modelUrl },
          error
        )
      }}
    >
      <Suspense fallback={proxyFallback}>
        <FurnitureModel
          furniture={furnitureWithModel}
          isSelected={isSelected}
          showModelLabel={showModelLabel}
          onBboxReady={onBboxReady}
        />
      </Suspense>
    </ModelErrorBoundary>
  )
}
