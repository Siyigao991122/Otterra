"use client"

import {
  Suspense,
  Component,
  useRef,
  useState,
  useEffect,
  useLayoutEffect,
  useCallback,
  useMemo,
  createContext,
  useContext,
  type Dispatch,
  type ErrorInfo,
  type ComponentRef,
  type ReactNode,
  type SetStateAction,
} from "react"
import { Canvas, useThree, useFrame } from "@react-three/fiber"
import { OrbitControls, Grid, Environment, Html, PerspectiveCamera, Billboard } from "@react-three/drei"
import * as THREE from "three"
import type { FloorplanPoint2D, FloorplanWallSegment, Furniture, RoomDimensions } from "@/lib/types"
import { isValidFootprintPolygon, polygonAABB } from "@/lib/floorplanGeometry"
import { extractProductIdFromFurnitureId } from "@/lib/extractProductIdFromFurnitureId"
import type { ProductModelLifecycle } from "@/lib/productModelLifecycle"
import { FurnitureSlot } from "./FurnitureSlot"
import {
  glbBboxInfoEqual,
  glbBboxInfoKey,
  normalizeGlbBboxInfo,
  type GlbBboxInfo,
} from "@/components/furniture-model"
import {
  resolveRoomGeometryEnvelopeSource,
  roomGeometrySourceDisplayTag,
  roomFootprintHorizontalExtentsM,
  roomLabelWorldPosition,
} from "@/lib/roomGeometryEnvelope"
import { Button } from "./ui/button"
import { RotateCw, Trash2, Move } from "lucide-react"

interface Product extends ProductModelLifecycle {
  id: string
  title?: string | null
  model_url?: string | null
  length_m?: number | null
  width_m?: number | null
  height_m?: number | null
}

interface DebugOverlayData {
  furniture: Furniture
  product?: Product | null
  bbox: GlbBboxInfo | null
}

/** Catches HDRI load failures so the room still renders with scene lights. */
class HdriEnvironmentErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  componentDidCatch(error: Error, _info: ErrorInfo) {
    console.warn("[room-3d-scene] HDRI failed to load; using lights only.", error)
  }

  render() {
    if (this.state.hasError) return null
    return this.props.children
  }
}

/** Set false to silence temporary state-loop diagnostics. */
const ROOM_SCENE_DEBUG_STATE = true

function logRoomSceneState(name: string, reason: string, keptPrev: boolean) {
  if (!ROOM_SCENE_DEBUG_STATE) return
  console.log(`[room-3d-scene:state] ${name}`, { reason, keptPrev })
}

function debugOverlayDataEqual(a: DebugOverlayData | null, b: DebugOverlayData | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  if (a.furniture.id !== b.furniture.id) return false
  if ((a.product?.id ?? "") !== (b.product?.id ?? "")) return false
  const ad = a.furniture.dimensions
  const bd = b.furniture.dimensions
  if (ad.width !== bd.width || ad.height !== bd.height || ad.depth !== bd.depth) return false
  return glbBboxInfoEqual(a.bbox, b.bbox)
}

const DebugOverlayContext = createContext<{
  data: DebugOverlayData | null
  setData: Dispatch<SetStateAction<DebugOverlayData | null>>
}>({ data: null, setData: () => {} })

/** "plan" = top-down apartment layout style; "orbit" = oblique staging (legacy). */
export type RoomSceneView = "orbit" | "plan"

interface Room3DSceneProps {
  roomDimensions: RoomDimensions
  placedFurniture: Furniture[]
  products?: Product[]
  debug?: boolean
  selectedId: string | null
  onSelectFurniture: (id: string | null) => void
  onMoveFurniture: (id: string, position: [number, number, number]) => void
  onDropFurniture: (position: [number, number, number]) => void
  isDragging: boolean
  snapshotTrigger?: number
  onSnapshotReady?: (dataUrl: string) => void
  /**
   * When omitted, uses "plan" if a valid unit footprint exists, otherwise "orbit".
   * TODO Phase B+: UI toggle to switch modes without leaving the page.
   */
  sceneView?: RoomSceneView
}

/** Longest horizontal span of the unit in meters (for framing). */
function footprintSpanMeters(dimensions: RoomDimensions): number {
  const fp = dimensions.geometry?.footprintPolygon
  if (fp && isValidFootprintPolygon(fp)) {
    const { width, depth } = polygonAABB(fp)
    return Math.max(width, depth, 1)
  }
  return Math.max(dimensions.width, dimensions.depth, 1)
}

function resolveSceneView(dimensions: RoomDimensions, explicit?: RoomSceneView): RoomSceneView {
  if (explicit) return explicit
  const fp = dimensions.geometry?.footprintPolygon
  return fp && isValidFootprintPolygon(fp) ? "plan" : "orbit"
}

type OrbitControlsHandle = ComponentRef<typeof OrbitControls>

/**
 * Plan mode: camera above unit center, nearly top-down; polar angle locked shallow for layout feel.
 * Orbit mode: existing oblique staging.
 */
function ApartmentSceneControls({
  sceneView,
  roomDimensions,
  enabled,
}: {
  sceneView: RoomSceneView
  roomDimensions: RoomDimensions
  enabled: boolean
}) {
  const { camera } = useThree()
  const controlsRef = useRef<OrbitControlsHandle | null>(null)
  const isPlan = sceneView === "plan"

  useLayoutEffect(() => {
    const cam = camera as THREE.PerspectiveCamera
    const span = footprintSpanMeters(roomDimensions)
    const fovRad = THREE.MathUtils.degToRad(cam.fov)
    const margin = 1.22

    if (isPlan) {
      const H = Math.max(8, (span * 0.5 * margin) / Math.tan(fovRad / 2))
      cam.position.set(0, H, 0)
      cam.near = Math.max(0.05, H / 2000)
      cam.far = Math.max(400, H * 10)
    } else {
      cam.position.set(8, 8, 8)
      cam.near = 0.1
      cam.far = 200
    }
    cam.up.set(0, 1, 0)
    cam.lookAt(0, 0, 0)
    cam.updateProjectionMatrix()

    const syncControls = () => {
      const oc = controlsRef.current
      if (!oc) return false
      oc.target.set(0, 0, 0)
      if (isPlan) {
        const H = Math.max(8, (span * 0.5 * margin) / Math.tan(fovRad / 2))
        oc.minPolarAngle = 0
        oc.maxPolarAngle = 0.12
        oc.minAzimuthAngle = -Infinity
        oc.maxAzimuthAngle = Infinity
        oc.minDistance = Math.max(2.5, H * 0.18)
        oc.maxDistance = Math.max(60, H * 9)
      } else {
        oc.minPolarAngle = 0
        oc.maxPolarAngle = Math.PI / 2 - 0.1
        oc.minAzimuthAngle = -Infinity
        oc.maxAzimuthAngle = Infinity
        oc.minDistance = 3
        oc.maxDistance = 20
      }
      oc.update()
      return true
    }
    if (!syncControls()) {
      requestAnimationFrame(syncControls)
    }
  }, [camera, isPlan, roomDimensions])

  return (
    <OrbitControls
      ref={controlsRef}
      makeDefault
      enabled={enabled}
      enableDamping
      dampingFactor={0.08}
      rotateSpeed={isPlan ? 0.42 : 0.6}
      zoomSpeed={0.85}
      panSpeed={isPlan ? 1 : 0.8}
      screenSpacePanning
      keyPanSpeed={20}
      minPolarAngle={isPlan ? 0 : 0}
      maxPolarAngle={isPlan ? 0.12 : Math.PI / 2 - 0.1}
      minDistance={isPlan ? 2.5 : 3}
      maxDistance={isPlan ? 800 : 20}
    />
  )
}

const POLYGON_WALL_THICKNESS_EXTERIOR = 0.1
const POLYGON_WALL_THICKNESS_INTERIOR_DEFAULT = 0.07

/**
 * Extruded shell from 2D footprint (plan x → world X, plan y → world Z).
 * TODO: clip wall segments at door/window openings; align thickness to CAD when available.
 */
function PolygonRoomShell({
  footprint,
  wallHeight,
  interiorWalls,
}: {
  footprint: FloorplanPoint2D[]
  wallHeight: number
  interiorWalls?: FloorplanWallSegment[]
}) {
  const exteriorMat = useMemo(
    () => ({ color: "#cfd6df", roughness: 0.48, metalness: 0.04 } as const),
    []
  )
  const interiorMat = useMemo(
    () => ({ color: "#b8c0cc", roughness: 0.5, metalness: 0.05 } as const),
    []
  )
  const floorMat = useMemo(
    () => ({ color: "#dce0e6", roughness: 0.62, metalness: 0.04 } as const),
    []
  )
  const floorGeo = useMemo(() => {
    const shape = new THREE.Shape()
    shape.moveTo(footprint[0].x, -footprint[0].y)
    for (let i = 1; i < footprint.length; i++) {
      shape.lineTo(footprint[i].x, -footprint[i].y)
    }
    shape.closePath()
    return new THREE.ShapeGeometry(shape)
  }, [footprint])

  const wallElements = useMemo(() => {
    const out: ReactNode[] = []
    const n = footprint.length
    for (let i = 0; i < n; i++) {
      const a = footprint[i]
      const b = footprint[(i + 1) % n]
      const ax = a.x
      const az = a.y
      const bx = b.x
      const bz = b.y
      const dx = bx - ax
      const dz = bz - az
      const len = Math.hypot(dx, dz)
      if (len < 1e-6) continue
      const midx = (ax + bx) / 2
      const midz = (az + bz) / 2
      const dir = new THREE.Vector3(dx / len, 0, dz / len)
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir)
      out.push(
        <group key={`perim-${i}`} position={[midx, wallHeight / 2, midz]} quaternion={q}>
          <mesh receiveShadow castShadow>
            <boxGeometry args={[len, wallHeight, POLYGON_WALL_THICKNESS_EXTERIOR]} />
            <meshStandardMaterial {...exteriorMat} />
          </mesh>
        </group>
      )
    }
    let iw = 0
    for (const w of interiorWalls ?? []) {
      const ax = w.x1
      const az = w.y1
      const bx = w.x2
      const bz = w.y2
      const dx = bx - ax
      const dz = bz - az
      const len = Math.hypot(dx, dz)
      if (len < 1e-6) continue
      const midx = (ax + bx) / 2
      const midz = (az + bz) / 2
      const dir = new THREE.Vector3(dx / len, 0, dz / len)
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir)
      const t = Math.max(w.thickness ?? POLYGON_WALL_THICKNESS_INTERIOR_DEFAULT, 0.04)
      out.push(
        <group key={`int-${w.id}-${iw++}`} position={[midx, wallHeight / 2, midz]} quaternion={q}>
          <mesh receiveShadow castShadow>
            <boxGeometry args={[len, wallHeight, t]} />
            <meshStandardMaterial {...interiorMat} />
          </mesh>
        </group>
      )
    }
    return out
  }, [footprint, wallHeight, interiorWalls, exteriorMat, interiorMat])

  return (
    <group>
      <mesh geometry={floorGeo} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <meshStandardMaterial {...floorMat} side={THREE.DoubleSide} />
      </mesh>
      {wallElements}
    </group>
  )
}

function RectangularRoom({ dimensions }: { dimensions: RoomDimensions }) {
  const { width, depth, height } = dimensions

  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
        <planeGeometry args={[width, depth]} />
        <meshStandardMaterial color="#e8e8ec" roughness={0.6} metalness={0.05} />
      </mesh>

      <mesh position={[0, height / 2, -depth / 2]} receiveShadow>
        <planeGeometry args={[width, height]} />
        <meshStandardMaterial color="#f5f5f7" roughness={0.5} metalness={0} side={THREE.DoubleSide} />
      </mesh>

      <mesh position={[-width / 2, height / 2, 0]} rotation={[0, Math.PI / 2, 0]} receiveShadow>
        <planeGeometry args={[depth, height]} />
        <meshStandardMaterial color="#f0f0f2" roughness={0.5} metalness={0} side={THREE.DoubleSide} />
      </mesh>

      <mesh position={[width / 2, height / 2, 0]} rotation={[0, -Math.PI / 2, 0]} receiveShadow>
        <planeGeometry args={[depth, height]} />
        <meshStandardMaterial color="#f0f0f2" roughness={0.5} metalness={0} side={THREE.DoubleSide} />
      </mesh>
    </group>
  )
}

function Room({ dimensions }: { dimensions: RoomDimensions }) {
  const fp = dimensions.geometry?.footprintPolygon
  if (fp && isValidFootprintPolygon(fp)) {
    return (
      <PolygonRoomShell
        footprint={fp}
        wallHeight={dimensions.height}
        interiorWalls={dimensions.geometry?.interiorWalls}
      />
    )
  }
  return <RectangularRoom dimensions={dimensions} />
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
          setHoverPos((prev) => {
            const keptPrev =
              prev != null &&
              prev[0] === pos[0] &&
              prev[1] === pos[1] &&
              prev[2] === pos[2]
            if (keptPrev) return prev
            logRoomSceneState("setHoverPos", "pointer move (new cell)", false)
            return pos
          })
        }}
        onPointerLeave={() =>
          setHoverPos((prev) => {
            if (prev === null) {
              logRoomSceneState("setHoverPos", "pointer leave (already null)", true)
              return prev
            }
            logRoomSceneState("setHoverPos", "pointer leave", false)
            return null
          })
        }
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

/** In-scene size trust label (billboarded for orbit + plan readability). */
function FurnitureInSceneDimensionLabel({
  furniture,
  glbBbox,
  debug,
}: {
  furniture: Furniture
  glbBbox: GlbBboxInfo | null | undefined
  debug?: boolean
}) {
  const fmt = (n: number) => (Number.isFinite(n) ? n.toFixed(2) : "—")
  const { depth: L, width: W, height: H } = furniture.dimensions
  const dimsTrust =
    furniture.dimensionsAuthoritative === true
      ? "Dims: catalog (authoritative)"
      : "Dims: fallback / proxy box"

  return (
    <Billboard position={[0, furniture.dimensions.height + 0.34, 0]}>
      <Html center transform className="pointer-events-none select-none">
        <div className="rounded-md bg-black/80 text-white text-[11px] leading-snug px-2 py-1.5 shadow-lg max-w-[240px] font-mono border border-white/12 [text-shadow:0_1px_2px_rgba(0,0,0,0.85)]">
          <div className="text-[10px] text-white/75 truncate" title={furniture.name}>
            {furniture.name}
          </div>
          <div className="font-semibold text-amber-100/95 tracking-tight mt-0.5">
            {fmt(L)} × {fmt(W)} × {fmt(H)} m
          </div>
          <div className="text-[10px] text-white/70 mt-0.5">
            length × width × height (meters)
          </div>
          <div className="text-[10px] text-emerald-200/90 mt-1">{dimsTrust}</div>
          {debug && glbBbox ? (
            <div className="text-[10px] text-cyan-200/90 mt-1 pt-1 border-t border-white/15">
              GLB calibration: {glbBbox.calibrationMode}
              {glbBbox.suspiciousCalibration
                ? ` · suspicious: ${glbBbox.suspiciousReason ?? "?"}`
                : ""}
            </div>
          ) : null}
        </div>
      </Html>
    </Billboard>
  )
}

/** Shown when no furniture is selected: room envelope + geometry source. */
function RoomEnvelopeInSceneLabel({
  roomDimensions,
  debug,
}: {
  roomDimensions: RoomDimensions
  debug?: boolean
}) {
  const pos = roomLabelWorldPosition(roomDimensions, 0.24)
  const { widthM, depthM } = roomFootprintHorizontalExtentsM(roomDimensions)
  const h = roomDimensions.height
  const src = resolveRoomGeometryEnvelopeSource(roomDimensions)
  const tag = roomGeometrySourceDisplayTag(src)
  const fmt = (n: number) => n.toFixed(2)
  const fp = roomDimensions.geometry?.footprintPolygon
  const polyShell = fp != null && isValidFootprintPolygon(fp)

  return (
    <Billboard position={pos}>
      <Html center transform className="pointer-events-none select-none">
        <div className="rounded-md bg-black/80 text-white text-[11px] leading-snug px-2.5 py-1.5 shadow-lg max-w-[260px] font-mono border border-violet-400/25 [text-shadow:0_1px_2px_rgba(0,0,0,0.85)]">
          <div className="font-semibold text-violet-100/95">Room envelope</div>
          <div className="text-amber-100/95 mt-0.5">
            {fmt(widthM)} × {fmt(depthM)} × {fmt(h)} m
          </div>
          <div className="text-[10px] text-white/70 mt-0.5">width × depth × height</div>
          {polyShell ? (
            <div className="text-[10px] text-white/65 mt-1">
              Footprint: polygon shell (overall AABB above)
            </div>
          ) : (
            <div className="text-[10px] text-white/65 mt-1">Footprint: axis-aligned rectangle</div>
          )}
          <div className="text-[10px] text-sky-200/90 mt-1 pt-1 border-t border-white/12">
            Source: <span className="font-semibold">{tag}</span>
          </div>
          {debug ? (
            <div className="text-[10px] text-white/55 mt-0.5">raw key: {src}</div>
          ) : null}
        </div>
      </Html>
    </Billboard>
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
  product,
  isSelected,
  debug,
  glbBbox,
  onSelect,
  onMove,
  onRotate,
  onDelete,
  onDragStart,
  onDragEnd,
  onBboxReady,
  roomBounds,
}: {
  furniture: Furniture
  product?: Product | null
  isSelected: boolean
  debug?: boolean
  glbBbox?: GlbBboxInfo | null
  onSelect: () => void
  onMove: (pos: [number, number, number]) => void
  onRotate: () => void
  onDelete: () => void
  onDragStart?: () => void
  onDragEnd?: () => void
  onBboxReady?: (info: GlbBboxInfo) => void
  roomBounds: { minX: number; maxX: number; minZ: number; maxZ: number }
}) {
  const groupRef = useRef<THREE.Group>(null)
  const [isDragging, setIsDragging] = useState(false)
  const { camera, gl } = useThree()

  const handlePointerDown = (e: THREE.Event) => {
    e.stopPropagation()
    onSelect()
    // Capture pointer so pointer-up goes to us, not floor – keeps selection after release
    const canvas = gl.domElement as HTMLCanvasElement
    if (canvas?.setPointerCapture && e.pointerId != null) {
      canvas.setPointerCapture(e.pointerId)
    }
    setIsDragging((prev) => {
      if (prev) {
        logRoomSceneState("setIsDragging(furniture)", "pointer down (already dragging)", true)
        return prev
      }
      logRoomSceneState("setIsDragging(furniture)", "pointer down", false)
      return true
    })
    onDragStart?.()
    gl.domElement.style.cursor = "grabbing"
  }

  const handlePointerUp = (e: THREE.Event) => {
    const canvas = gl.domElement as HTMLCanvasElement
    if (canvas?.releasePointerCapture && e.pointerId != null) {
      canvas.releasePointerCapture(e.pointerId)
    }
    setIsDragging((prev) => {
      if (!prev) {
        logRoomSceneState("setIsDragging(furniture)", "pointer up (already idle)", true)
        return prev
      }
      logRoomSceneState("setIsDragging(furniture)", "pointer up", false)
      return false
    })
    onDragEnd?.()
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
      <FurnitureSlot
        furniture={furniture}
        product={product}
        isSelected={isSelected}
        onBboxReady={isSelected ? onBboxReady : undefined}
      />
      {isSelected && (
        <FurnitureInSceneDimensionLabel furniture={furniture} glbBbox={glbBbox} debug={debug} />
      )}
      {isSelected && <SelectionControls furniture={furniture} onRotate={onRotate} onDelete={onDelete} />}
      {isSelected && debug && (
        <Html position={[0, furniture.dimensions.height + 0.2, 0]} center>
          <div className="text-xs bg-black/80 text-white rounded px-2 py-1 font-mono whitespace-nowrap max-w-[200px] truncate">
            <div>{(product?.title ?? furniture.name) || "—"}</div>
            <div>{(product?.model_url ?? furniture.model_url) || "—"}</div>
            <div>{((product?.model_url ?? furniture.model_url)?.trim() ? "GLB" : "Proxy")}</div>
          </div>
        </Html>
      )}
    </group>
  )
}

function SnapshotCapturer({
  roomDimensions,
  snapshotTrigger,
  onSnapshotReady,
}: {
  roomDimensions: RoomDimensions
  snapshotTrigger: number
  onSnapshdy?: (dataUrl: string) => void
}) {
  const { gl, scene, camera } = useThree()
  const onSnapshotReadyRef = useRef(onSnapshotReady)
  onSnapshotReadyRef.current = onSnapshotReady
  const { width: snapW, depth: snapD } = roomDimensions

  useEffect(() => {
    if (snapshotTrigger <= 0) return
    const onSnapshotReadyCb = onSnapshotReadyRef.current
    if (!onSnapshotReadyCb) return

    const cam = camera as THREE.PerspectiveCamera
    const savedPos = cam.position.clone()
    const savedQuat = cam.quaternion.clone()
    const savedUp = cam.up.clone()
    const savedFov = cam.fov

    /** Room footprint only (height does not affect top-down framing). */
    const topHeight = Math.max(snapW, snapD) * 1.2 + 2
    cam.position.set(0, topHeight, 0)
    cam.up.set(0, 0, 1)
    cam.lookAt(0, 0, 0)
    cam.updateProjectionMatrix()

    gl.render(scene, camera)
    const dataUrl = gl.domElement.toDataURL("image/png")

    cam.position.copy(savedPos)
    cam.quaternion.copy(savedQuat)
    cam.up.copy(savedUp)
    cam.fov = savedFov
    cam.updateProjectionMatrix()

    logRoomSceneState("onSnapshotReady", `snapshotTrigger=${snapshotTrigger}`, false)
    onSnapshotReadyCb(dataUrl)
  }, [snapshotTrigger, snapW, snapD, gl, scene, camera])

  return null
}

function Scene({
  roomDimensions,
  sceneView,
  placedFurniture,
  products = [],
  debug = false,
  selectedId,
  onSelectFurniture,
  onMoveFurniture,
  onDropFurniture,
  isDragging,
  snapshotTrigger = 0,
  onSnapshotReady,
}: Room3DSceneProps & { sceneView: RoomSceneView }) {
  const { setData: setDebugOverlay } = useContext(DebugOverlayContext)
  const [isFurnitureDragging, setIsFurnitureDraggingState] = useState(false)
  /** Bbox is only valid for overlay when `id` matches current `selectedId` (avoids stale bbox after switching selection). */
  const [bboxForSelection, setBboxForSelection] = useState<{ id: string; bbox: GlbBboxInfo } | null>(null)
  const selectedIdRef = useRef<string | null>(selectedId)
  selectedIdRef.current = selectedId

  const setFurnitureDragActive = useCallback((active: boolean) => {
    setIsFurnitureDraggingState((prev) => {
      if (prev === active) {
        logRoomSceneState(
          "setIsFurnitureDragging(scene)",
          active ? "drag start (already active)" : "drag end (already idle)",
          true
        )
        return prev
      }
      logRoomSceneState(
        "setIsFurnitureDragging(scene)",
        active ? "drag start" : "drag end",
        false
      )
      return active
    })
  }, [])

  const controlsEnabled = !isDragging && !isFurnitureDragging

  const handleSelectedBboxReady = useCallback((info: GlbBboxInfo) => {
    const id = selectedIdRef.current
    if (!id) return
    const normalized = normalizeGlbBboxInfo(info)
    const normalizedKey = glbBboxInfoKey(normalized)
    setBboxForSelection((prev) => {
      const equivalent = prev?.id === id && glbBboxInfoEqual(prev.bbox, normalized)
      if (equivalent) {
        if (ROOM_SCENE_DEBUG_STATE) {
          console.log("[room-3d-scene:state] setBboxForSelection", {
            reason: "equivalent normalized bbox — kept prev",
            normalizedKey,
            keptPrev: true,
          })
        }
        logRoomSceneState("setBboxForSelection", "unchanged (deduped)", true)
        return prev
      }
      if (ROOM_SCENE_DEBUG_STATE) {
        console.log("[room-3d-scene:state] setBboxForSelection", {
          reason: `store bbox for ${id}`,
          normalizedKey,
          keptPrev: false,
        })
      }
      logRoomSceneState("setBboxForSelection", `new bbox for ${id}`, false)
      return { id, bbox: normalized }
    })
  }, [])

  useEffect(() => {
    if (!selectedId) {
      setBboxForSelection((prev) => {
        if (prev === null) {
          logRoomSceneState("setBboxForSelection", "deselect (bbox already null)", true)
          return prev
        }
        logRoomSceneState("setBboxForSelection", "deselect — clear bbox", false)
        return null
      })
    }
  }, [selectedId])

  const bboxKeyForOverlay =
    selectedId != null &&
    bboxForSelection != null &&
    bboxForSelection.id === selectedId &&
    bboxForSelection.bbox != null
      ? glbBboxInfoKey(bboxForSelection.bbox)
      : ""

  useEffect(() => {
    if (!selectedId) {
      setDebugOverlay((prev) => {
        const keptPrev = prev === null
        logRoomSceneState("setDebugOverlay(sync effect)", "no selection — overlay off", keptPrev)
        return keptPrev ? prev : null
      })
      return
    }
    const furniture = placedFurniture.find((f) => f.id === selectedId)
    if (!furniture) return
    const productId = extractProductIdFromFurnitureId(furniture.id)
    const product = productId ? products.find((p) => p.id === productId) : undefined
    const effectiveBbox = bboxForSelection?.id === selectedId ? bboxForSelection.bbox : null
    const overlayNext: DebugOverlayData = { furniture, product, bbox: effectiveBbox }
    setDebugOverlay((prev) => {
      const next = debugOverlayDataEqual(prev, overlayNext) ? prev : overlayNext
      logRoomSceneState(
        "setDebugOverlay(sync effect)",
        `id=${selectedId} bboxKey=${bboxKeyForOverlay || "none"}`,
        Object.is(prev, next)
      )
      return next
    })
  }, [selectedId, bboxKeyForOverlay, placedFurniture, products, setDebugOverlay])

  const roomBounds = useMemo(() => {
    const fp = roomDimensions.geometry?.footprintPolygon
    const inset = 1
    if (fp && isValidFootprintPolygon(fp)) {
      const aabb = polygonAABB(fp)
      return {
        minX: aabb.minX + inset,
        maxX: aabb.maxX - inset,
        minZ: aabb.minY + inset,
        maxZ: aabb.maxY - inset,
      }
    }
    const { width: rbW, depth: rbD } = roomDimensions
    return {
      minX: -rbW / 2 + inset,
      maxX: rbW / 2 - inset,
      minZ: -rbD / 2 + inset,
      maxZ: rbD / 2 - inset,
    }
  }, [roomDimensions])

  return (
    <>
      <PerspectiveCamera makeDefault position={[8, 8, 8]} fov={50} />
      <ApartmentSceneControls
        sceneView={sceneView}
        roomDimensions={roomDimensions}
        enabled={controlsEnabled}
      />

      <HdriEnvironmentErrorBoundary>
        <Suspense fallback={null}>
          <Environment files="lebombo_1k.hdr" path="/hdri/" environmentIntensity={2.5} />
        </Suspense>
      </HdriEnvironmentErrorBoundary>
      <ambientLight intensity={2.0} />
      <hemisphereLight args={["#ffffff", "#e0e4e8", 1.2]} />
      <directionalLight position={[5, 10, 5]} intensity={4} castShadow shadow-mapSize={[2048, 2048]} />
      <directionalLight position={[-4, 8, -4]} intensity={2.5} />

      <Room dimensions={roomDimensions} />

      {selectedId == null && !isDragging && (
        <RoomEnvelopeInSceneLabel roomDimensions={roomDimensions} debug={debug} />
      )}

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

      {placedFurniture.map((furniture) => {
        const productId = extractProductIdFromFurnitureId(furniture.id)
        const product = productId ? products.find((p) => p.id === productId) : undefined
        return (
        <DraggableFurniture
          key={furniture.id}
          furniture={furniture}
          product={product}
          isSelected={selectedId === furniture.id}
          debug={debug}
          glbBbox={
            selectedId === furniture.id && bboxForSelection?.id === selectedId
              ? bboxForSelection.bbox
              : null
          }
          onSelect={() => onSelectFurniture(furniture.id)}
          onMove={(pos) => onMoveFurniture(furniture.id, pos)}
          onRotate={() => {}}
          onDelete={() => {}}
          onDragStart={() => setFurnitureDragActive(true)}
          onDragEnd={() => setFurnitureDragActive(false)}
          onBboxReady={selectedId === furniture.id ? handleSelectedBboxReady : undefined}
          roomBounds={roomBounds}
        />
        )
      })}

      {/* Clear selection only on pointer-down (click) on empty floor, not on pointer-up (release) after clicking furniture */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, -0.01, 0]}
        onPointerDown={(e) => {
          e.stopPropagation()
          onSelectFurniture(null)
        }}
      >
        <planeGeometry args={[100, 100]} />
        <meshBasicMaterial visible={false} />
      </mesh>

      {onSnapshotReady && (
        <SnapshotCapturer
          roomDimensions={roomDimensions}
          snapshotTrigger={snapshotTrigger}
          onSnapshotReady={onSnapshotReady}
        />
      )}
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

function DebugDimensionOverlay({ data }: { data: DebugOverlayData }) {
  const { furniture, product, bbox } = data
  const w = product?.width_m
  const l = product?.length_m
  const h = product?.height_m
  const { width, height, depth } = furniture.dimensions
  const fmt = (v: number | null | undefined) => (v != null ? v.toFixed(3) : "—")
  return (
    <div className="absolute bottom-3 left-3 z-10 bg-black/85 text-white text-xs font-mono rounded px-3 py-2 max-w-[280px] space-y-1">
      <div className="font-semibold text-amber-300 mb-1">Dimension debug</div>
      <div>DB: width_m={fmt(w)} length_m={fmt(l)} height_m={fmt(h)}</div>
      <div>Scene X/Y/Z: {fmt(width)} / {fmt(height)} / {fmt(depth)}</div>
      {bbox ? (
        <>
          <div>
            Target (m) X/Y/Z: {bbox.target.x.toFixed(3)} / {bbox.target.y.toFixed(3)} / {bbox.target.z.toFixed(3)}
          </div>
          <div>Mode: {bbox.calibrationMode}</div>
          <div>
            GLB raw: x={bbox.raw.x.toFixed(3)} y={bbox.raw.y.toFixed(3)} z={bbox.raw.z.toFixed(3)}
          </div>
          <div>
            Scale axis: sx={bbox.scaleAxis.x.toFixed(4)} sy={bbox.scaleAxis.y.toFixed(4)} sz={bbox.scaleAxis.z.toFixed(4)}
          </div>
          <div>Scale (geom. mean): {bbox.scale.toFixed(4)}</div>
          <div>
            GLB scaled: x={bbox.scaled.x.toFixed(3)} y={bbox.scaled.y.toFixed(3)} z={bbox.scaled.z.toFixed(3)}
          </div>
          <div className={bbox.suspiciousCalibration ? "text-amber-300 font-semibold" : ""}>
            Sanity: suspiciousCalibration={String(bbox.suspiciousCalibration)}
            {bbox.suspiciousReason != null ? ` reason=${bbox.suspiciousReason}` : ""}
          </div>
        </>
      ) : (
        <div className="text-muted-foreground">GLB bbox: — (proxy or loading)</div>
      )}
    </div>
  )
}

export function Room3DScene(props: Room3DSceneProps) {
  const effectiveSceneView = useMemo(
    () => resolveSceneView(props.roomDimensions, props.sceneView),
    [props.roomDimensions, props.sceneView]
  )

  const [debugOverlayData, setDebugOverlayData] = useState<DebugOverlayData | null>(null)

  const setDebugOverlayDataLogged = useCallback((action: SetStateAction<DebugOverlayData | null>) => {
    setDebugOverlayData((prev) => {
      const next =
        typeof action === "function"
          ? (action as (p: DebugOverlayData | null) => DebugOverlayData | null)(prev)
          : action
      const keptPrev = Object.is(prev, next)
      logRoomSceneState(
        "setDebugOverlayData",
        typeof action === "function" ? "functional update" : "direct assignment",
        keptPrev
      )
      return next
    })
  }, [])

  const debugOverlayContextValue = useMemo(
    () => ({ data: debugOverlayData, setData: setDebugOverlayDataLogged }),
    [debugOverlayData, setDebugOverlayDataLogged]
  )

  return (
    <DebugOverlayContext.Provider value={debugOverlayContextValue}>
      <div className="w-full h-full relative">
        <Canvas shadows gl={{ alpha: false, preserveDrawingBuffer: true }}>
          <Suspense
            fallback={
              <Html center>
                <div className="text-foreground">Loading 3D Scene...</div>
              </Html>
            }
          >
            <SetSceneBackground />
            <Scene {...props} sceneView={effectiveSceneView} />
          </Suspense>
        </Canvas>
        {props.debug && debugOverlayData && <DebugDimensionOverlay data={debugOverlayData} />}
        {props.isDragging && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-card border border-primary/50 rounded-full px-4 py-2 flex items-center gap-2">
            <Move className="w-4 h-4 text-primary" />
            <span className="text-sm">Click on the floor to place furniture</span>
          </div>
        )}
      </div>
    </DebugOverlayContext.Provider>
  )
}
