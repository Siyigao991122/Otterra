"use client"

interface FurnitureProxyProps {
  width: number
  height: number
  depth: number
  color?: string
}

/**
 * Simple box mesh placeholder for when model_url is missing or GLB load fails.
 */
export function FurnitureProxy({ width, height, depth, color = "#8b7355" }: FurnitureProxyProps) {
  return (
    <mesh castShadow>
      <boxGeometry args={[width, height, depth]} />
      <meshStandardMaterial color={color} />
    </mesh>
  )
}