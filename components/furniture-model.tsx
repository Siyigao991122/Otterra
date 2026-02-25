"use client"

import { useRef } from "react"
import * as THREE from "three"
import type { Furniture } from "@/lib/types"

interface FurnitureModelProps {
  furniture: Furniture
  isSelected: boolean
}

export function FurnitureModel({ furniture, isSelected }: FurnitureModelProps) {
  const meshRef = useRef<THREE.Mesh>(null)
  const { width, height, depth } = furniture.dimensions

  const renderModel = () => {
    switch (furniture.type) {
      case "sofa":
        return (
          <group>
            {/* Seat */}
            <mesh position={[0, 0.2, 0]} castShadow>
              <boxGeometry args={[width, 0.4, depth]} />
              <meshStandardMaterial color={furniture.color} roughness={0.8} />
            </mesh>
            {/* Back */}
            <mesh position={[0, 0.5, -depth / 2 + 0.1]} castShadow>
              <boxGeometry args={[width, 0.6, 0.2]} />
              <meshStandardMaterial color={furniture.color} roughness={0.8} />
            </mesh>
            {/* Arms */}
            <mesh position={[-width / 2 + 0.1, 0.35, 0]} castShadow>
              <boxGeometry args={[0.2, 0.3, depth]} />
              <meshStandardMaterial color={furniture.color} roughness={0.8} />
            </mesh>
            <mesh position={[width / 2 - 0.1, 0.35, 0]} castShadow>
              <boxGeometry args={[0.2, 0.3, depth]} />
              <meshStandardMaterial color={furniture.color} roughness={0.8} />
            </mesh>
          </group>
        )

      case "chair":
        return (
          <group>
            {/* Seat */}
            <mesh position={[0, 0.45, 0]} castShadow>
              <boxGeometry args={[width, 0.08, depth]} />
              <meshStandardMaterial color={furniture.color} roughness={0.6} />
            </mesh>
            {/* Back */}
            <mesh position={[0, 0.8, -depth / 2 + 0.04]} castShadow>
              <boxGeometry args={[width * 0.9, 0.6, 0.08]} />
              <meshStandardMaterial color={furniture.color} roughness={0.6} />
            </mesh>
            {/* Legs */}
            {[
              [-1, -1],
              [1, -1],
              [-1, 1],
              [1, 1],
            ].map(([x, z], i) => (
              <mesh key={i} position={[x * (width / 2 - 0.05), 0.2, z * (depth / 2 - 0.05)]} castShadow>
                <cylinderGeometry args={[0.03, 0.03, 0.4]} />
                <meshStandardMaterial color="#2a2a30" metalness={0.8} />
              </mesh>
            ))}
          </group>
        )

      case "table":
        return (
          <group>
            {/* Top */}
            <mesh position={[0, height - 0.04, 0]} castShadow>
              <boxGeometry args={[width, 0.08, depth]} />
              <meshStandardMaterial color={furniture.color} roughness={0.4} />
            </mesh>
            {/* Legs */}
            {[
              [-1, -1],
              [1, -1],
              [-1, 1],
              [1, 1],
            ].map(([x, z], i) => (
              <mesh key={i} position={[x * (width / 2 - 0.08), (height - 0.08) / 2, z * (depth / 2 - 0.08)]} castShadow>
                <boxGeometry args={[0.08, height - 0.08, 0.08]} />
                <meshStandardMaterial color={furniture.color} roughness={0.4} />
              </mesh>
            ))}
          </group>
        )

      case "bed":
        return (
          <group>
            {/* Mattress */}
            <mesh position={[0, 0.35, 0]} castShadow>
              <boxGeometry args={[width, 0.3, depth]} />
              <meshStandardMaterial color="#f5f5f5" roughness={0.9} />
            </mesh>
            {/* Frame */}
            <mesh position={[0, 0.15, 0]} castShadow>
              <boxGeometry args={[width + 0.1, 0.3, depth + 0.1]} />
              <meshStandardMaterial color={furniture.color} roughness={0.6} />
            </mesh>
            {/* Headboard */}
            <mesh position={[0, 0.7, -depth / 2]} castShadow>
              <boxGeometry args={[width + 0.1, 0.8, 0.1]} />
              <meshStandardMaterial color={furniture.color} roughness={0.6} />
            </mesh>
            {/* Pillows */}
            <mesh position={[-0.4, 0.55, -depth / 2 + 0.4]} castShadow>
              <boxGeometry args={[0.5, 0.15, 0.4]} />
              <meshStandardMaterial color="#e8e8e8" roughness={0.9} />
            </mesh>
            <mesh position={[0.4, 0.55, -depth / 2 + 0.4]} castShadow>
              <boxGeometry args={[0.5, 0.15, 0.4]} />
              <meshStandardMaterial color="#e8e8e8" roughness={0.9} />
            </mesh>
          </group>
        )

      case "lamp":
        return (
          <group>
            {/* Base */}
            <mesh position={[0, 0.02, 0]} castShadow>
              <cylinderGeometry args={[0.15, 0.2, 0.04]} />
              <meshStandardMaterial color="#2a2a30" metalness={0.9} />
            </mesh>
            {/* Stem */}
            <mesh position={[0, height / 2, 0]} castShadow>
              <cylinderGeometry args={[0.02, 0.02, height - 0.3]} />
              <meshStandardMaterial color="#2a2a30" metalness={0.9} />
            </mesh>
            {/* Shade */}
            <mesh position={[0, height - 0.15, 0]} castShadow>
              <coneGeometry args={[0.2, 0.3, 32, 1, true]} />
              <meshStandardMaterial color={furniture.color} side={THREE.DoubleSide} />
            </mesh>
            {/* Light bulb glow */}
            <pointLight position={[0, height - 0.1, 0]} intensity={0.5} color="#fff5e0" distance={3} />
          </group>
        )

      case "plant":
        return (
          <group>
            {/* Pot */}
            <mesh position={[0, 0.15, 0]} castShadow>
              <cylinderGeometry args={[0.15, 0.12, 0.3]} />
              <meshStandardMaterial color="#8b5a2b" roughness={0.8} />
            </mesh>
            {/* Soil */}
            <mesh position={[0, 0.28, 0]}>
              <cylinderGeometry args={[0.13, 0.13, 0.05]} />
              <meshStandardMaterial color="#3d2817" roughness={1} />
            </mesh>
            {/* Foliage */}
            <mesh position={[0, 0.55, 0]} castShadow>
              <sphereGeometry args={[0.25, 16, 16]} />
              <meshStandardMaterial color="#2d5a27" roughness={0.9} />
            </mesh>
            <mesh position={[0.1, 0.7, 0.05]} castShadow>
              <sphereGeometry args={[0.18, 16, 16]} />
              <meshStandardMaterial color="#3d7a37" roughness={0.9} />
            </mesh>
            <mesh position={[-0.08, 0.65, -0.05]} castShadow>
              <sphereGeometry args={[0.15, 16, 16]} />
              <meshStandardMaterial color="#4a8a44" roughness={0.9} />
            </mesh>
          </group>
        )

      case "bookshelf":
        return (
          <group>
            {/* Main frame */}
            <mesh position={[0, height / 2, 0]} castShadow>
              <boxGeometry args={[width, height, depth]} />
              <meshStandardMaterial color={furniture.color} roughness={0.6} />
            </mesh>
            {/* Shelves (cutouts simulated with darker sections) */}
            {[0.3, 0.7, 1.1, 1.5].map((y, i) => (
              <mesh key={i} position={[0, y, 0.02]} castShadow>
                <boxGeometry args={[width - 0.1, 0.35, depth - 0.04]} />
                <meshStandardMaterial color="#1a1a20" roughness={0.8} />
              </mesh>
            ))}
          </group>
        )

      case "rug":
        return (
          <mesh position={[0, 0.01, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
            <planeGeometry args={[width, depth]} />
            <meshStandardMaterial color={furniture.color} roughness={1} />
          </mesh>
        )

      case "tv":
        return (
          <group>
            {/* Screen */}
            <mesh position={[0, height / 2 + 0.4, 0]} castShadow>
              <boxGeometry args={[width, height, 0.05]} />
              <meshStandardMaterial color="#0a0a0a" roughness={0.1} />
            </mesh>
            {/* Stand */}
            <mesh position={[0, 0.15, 0]} castShadow>
              <boxGeometry args={[0.6, 0.3, 0.3]} />
              <meshStandardMaterial color="#1a1a20" roughness={0.5} />
            </mesh>
            {/* Screen reflection */}
            <mesh position={[0, height / 2 + 0.4, 0.03]}>
              <planeGeometry args={[width - 0.1, height - 0.1]} />
              <meshStandardMaterial color="#111115" roughness={0} metalness={0.9} />
            </mesh>
          </group>
        )

      default:
        return (
          <mesh ref={meshRef} castShadow>
            <boxGeometry args={[width, height, depth]} />
            <meshStandardMaterial color={furniture.color} />
          </mesh>
        )
    }
  }

  return (
    <group>
      {renderModel()}
      {isSelected && (
        <mesh position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[Math.max(width, depth) / 2 + 0.1, Math.max(width, depth) / 2 + 0.2, 32]} />
          <meshBasicMaterial color="#d4a853" transparent opacity={0.8} />
        </mesh>
      )}
    </group>
  )
}
