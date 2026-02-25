"use client"

import { Suspense, useRef, useState, useEffect } from "react"
import { Canvas, useThree, useFrame } from "@react-three/fiber"
import { OrbitControls, Grid, Environment, Html, PerspectiveCamera } from "@react-three/drei"
import * as THREE from "three"
import type { Furniture, RoomDimensions } from "@/lib/types"
import { FurnitureModel } from "./furniture-model"
import { Button } from "./ui/button"
import { RotateCw, Trash2, Move } from "lucide-react"

interface Room3DSceneProps {
  roomDimensions: RoomDimensions
  placedFurniture: Furniture[]
  selectedId: string | null
  onSelectFurniture: (id: string | null) => void
  onMoveFurniture: (id: string, position: [number, number, number]) => void
  onDropFurniture: (position: [number, number, number]) => void
  isDragging: boolean
}

function Room({ dimensions }: { dimensions: RoomDimensions }) {
  const { width, depth, height } = dimensions

  return (
    <group>
      {/* Floor */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
        <planeGeometry args={[width, depth]} />
        <meshStandardMaterial color="#e8e8ec" roughness={0.6} metalness={0.05} />
      </mesh>

      {/* Walls */}
      {/* Back wall */}
      <mesh position={[0, height / 2, -depth / 2]} receiveShadow>
        <planeGeometry args={[width, height]} />
        <meshStandardMaterial color="#f5f5f7" roughness={0.5} metalness={0} side={THREE.DoubleSide} />
      </mesh>

      {/* Left wall */}
      <mesh position={[-width / 2, height / 2, 0]} rotation={[0, Math.PI / 2, 0]} receiveShadow>
        <planeGeometry args={[depth, height]} />
        <meshStandardMaterial color="#f0f0f2" roughness={0.5} metalness={0} side={THREE.DoubleSide} />
      </mesh>

      {/* Right wall */}
      <mesh position={[width / 2, height / 2, 0]} rotation={[0, -Math.PI / 2, 0]} receiveShadow>
        <planeGeometry args={[depth, height]} />
        <meshStandardMaterial color="#f0f0f2" roughness={0.5} metalness={0} side={THREE.DoubleSide} />
      </mesh>
    </group>
  )
}

function DropPlane({
  onDrop,
  dimensions,
  isDragging,
}: {
  onDrop: (pos: [number, number, number]) => void
  dimensions: RoomDimensions
  isDragging: boolean
}) {
  const meshRef = useRef<THREE.Mesh>(null)
  const [hoverPos, setHoverPos] = useState<[number, number, number] | null>(null)

  if (!isDragging) return null

  return (
    <>
      <mesh
        ref={meshRef}
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.01, 0]}
        onPointerMove={(e) => {
          e.stopPropagation()
          const pos: [number, number, number] = [Math.round(e.point.x * 2) / 2, 0.5, Math.round(e.point.z * 2) / 2]
          setHoverPos(pos)
        }}
        onPointerLeave={() => setHoverPos(null)}
        onClick={(e) => {
          e.stopPropagation()
          if (hoverPos) {
            onDrop(hoverPos)
          }
        }}
      >
        <planeGeometry args={[dimensions.width, dimensions.depth]} />
        <meshBasicMaterial transparent opacity={0.1} color="#d4a853" />
      </mesh>

      {hoverPos && (
        <mesh position={[hoverPos[0], 0.02, hoverPos[2]]}>
          <ringGeometry args={[0.3, 0.5, 32]} />
          <meshBasicMaterial color="#d4a853" transparent opacity={0.5} side={THREE.DoubleSide} />
        </mesh>
      )}
    </>
  )
}

function SelectionControls({
  furniture,
  onRotate,
  onDelete,
}: {
  furniture: Furniture
  onRotate: () => void
  onDelete: () => void
}) {
  return (
    <Html position={[0, furniture.dimensions.height + 0.5, 0]} center>
      <div className="flex gap-1 bg-card border border-border rounded-lg p-1 shadow-xl">
        <Button size="icon" variant="ghost" className="h-8 w-8" onClick={onRotate}>
          <RotateCw className="h-4 w-4" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-8 w-8 text-destructive hover:text-destructive"
          onClick={onDelete}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
    </Html>
  )
}

function DraggableFurniture({
  furniture,
  isSelected,
  onSelect,
  onMove,
  onRotate,
  onDelete,
  roomBounds,
}: {
  furniture: Furniture
  isSelected: boolean
  onSelect: () => void
  onMove: (pos: [number, number, number]) => void
  onRotate: () => void
  onDelete: () => void
  roomBounds: { minX: number; maxX: number; minZ: number; maxZ: number }
}) {
  const groupRef = useRef<THREE.Group>(null)
  const [isDragging, setIsDragging] = useState(false)
  const { camera, gl } = useThree()

  const handlePointerDown = (e: THREE.Event) => {
    e.stopPropagation()
    onSelect()
    setIsDragging(true)
    gl.domElement.style.cursor = "grabbing"
  }

  const handlePointerUp = () => {
    setIsDragging(false)
    gl.domElement.style.cursor = "auto"
  }

  useFrame(() => {
    if (!isDragging || !groupRef.current) return

    const raycaster = new THREE.Raycaster()
    const mouse = new THREE.Vector2()

    const rect = gl.domElement.getBoundingClientRect()
    const event = (gl.domElement as any).__lastPointerEvent
    if (!event) return

    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1

    raycaster.setFromCamera(mouse, camera)
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
    const intersection = new THREE.Vector3()
    raycaster.ray.intersectPlane(plane, intersection)

    if (intersection) {
      const x = Math.max(roomBounds.minX, Math.min(roomBounds.maxX, Math.round(intersection.x * 2) / 2))
      const z = Math.max(roomBounds.minZ, Math.min(roomBounds.maxZ, Math.round(intersection.z * 2) / 2))
      onMove([x, furniture.dimensions.height / 2, z])
    }
  })

  return (
    <group
      ref={groupRef}
      position={furniture.position}
      rotation={[0, (furniture.rotation * Math.PI) / 180, 0]}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerUp}
      onPointerMove={(e: any) => {
        ;(gl.domElement as any).__lastPointerEvent = e
      }}
    >
      <FurnitureModel furniture={furniture} isSelected={isSelected} />
      {isSelected && <SelectionControls furniture={furniture} onRotate={onRotate} onDelete={onDelete} />}
    </group>
  )
}

function Scene({
  roomDimensions,
  placedFurniture,
  selectedId,
  onSelectFurniture,
  onMoveFurniture,
  onDropFurniture,
  isDragging,
}: Room3DSceneProps) {
  const roomBounds = {
    minX: -roomDimensions.width / 2 + 1,
    maxX: roomDimensions.width / 2 - 1,
    minZ: -roomDimensions.depth / 2 + 1,
    maxZ: roomDimensions.depth / 2 - 1,
  }

  return (
    <>
      <PerspectiveCamera makeDefault position={[8, 8, 8]} fov={50} />
      <OrbitControls
        makeDefault
        maxPolarAngle={Math.PI / 2 - 0.1}
        minDistance={3}
        maxDistance={20}
        target={[0, 0, 0]}
      />

      <Environment preset="apartment" />
      <ambientLight intensity={1.0} />
      <hemisphereLight args={["#ffffff", "#e0e4e8", 0.6]} />
      <directionalLight position={[5, 10, 5]} intensity={2} castShadow shadow-mapSize={[2048, 2048]} />
      <directionalLight position={[-4, 8, -4]} intensity={1.2} />

      <Room dimensions={roomDimensions} />

      <Grid
        args={[roomDimensions.width, roomDimensions.depth]}
        position={[0, 0.01, 0]}
        cellSize={1}
        cellThickness={0.5}
        cellColor="#c0c4c8"
        sectionSize={5}
        sectionThickness={1}
        sectionColor="#a0a4a8"
        fadeDistance={50}
        infiniteGrid={false}
      />

      <DropPlane onDrop={onDropFurniture} dimensions={roomDimensions} isDragging={isDragging} />

      {placedFurniture.map((furniture) => (
        <DraggableFurniture
          key={furniture.id}
          furniture={furniture}
          isSelected={selectedId === furniture.id}
          onSelect={() => onSelectFurniture(furniture.id)}
          onMove={(pos) => onMoveFurniture(furniture.id, pos)}
          onRotate={() => {}}
          onDelete={() => {}}
          roomBounds={roomBounds}
        />
      ))}

      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]} onClick={() => onSelectFurniture(null)}>
        <planeGeometry args={[100, 100]} />
        <meshBasicMaterial visible={false} />
      </mesh>
    </>
  )
}

function SetSceneBackground() {
  const { scene } = useThree()
  useEffect(() => {
    scene.background = new THREE.Color(0xf5f5f7)
  }, [scene])
  return null
}

export function Room3DScene(props: Room3DSceneProps) {
  return (
    <div className="w-full h-full">
      <Canvas shadows gl={{ alpha: false }}>
        <Suspense
          fallback={
            <Html center>
              <div className="text-foreground">Loading 3D Scene...</div>
            </Html>
          }
        >
          <SetSceneBackground />
          <Scene {...props} />
        </Suspense>
      </Canvas>

      {props.isDragging && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-card border border-primary/50 rounded-full px-4 py-2 flex items-center gap-2">
          <Move className="w-4 h-4 text-primary" />
          <span className="text-sm">Click on the floor to place furniture</span>
        </div>
      )}
    </div>
  )
}
