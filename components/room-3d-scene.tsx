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
import type {
  FloorplanDoorOpening,
  FloorplanPoint2D,
  FloorplanWallSegment,
  Furniture,
  RoomDimensions,
} from "@/lib/types"
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
const ROOM_SCENE_DEBUG_STATE = false

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
  onRotateFurniture: (id: string) => void
  onDeleteFurniture: (id: string) => void
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

function orient2d(ax: number, az: number, bx: number, bz: number, cx: number, cz: number): number {
  return (bx - ax) * (cz - az) - (bz - az) * (cx - ax)
}

function onSegment2d(ax: number, az: number, bx: number, bz: number, px: number, pz: number): boolean {
  return (
    px >= Math.min(ax, bx) - 1e-6 &&
    px <= Math.max(ax, bx) + 1e-6 &&
    pz >= Math.min(az, bz) - 1e-6 &&
    pz <= Math.max(az, bz) + 1e-6
  )
}

function segmentsIntersect2d(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  cx: number,
  cz: number,
  dx: number,
  dz: number
): boolean {
  const o1 = orient2d(ax, az, bx, bz, cx, cz)
  const o2 = orient2d(ax, az, bx, bz, dx, dz)
  const o3 = orient2d(cx, cz, dx, dz, ax, az)
  const o4 = orient2d(cx, cz, dx, dz, bx, bz)

  if ((o1 > 0) !== (o2 > 0) && (o3 > 0) !== (o4 > 0)) return true
  if (Math.abs(o1) <= 1e-6 && onSegment2d(ax, az, bx, bz, cx, cz)) return true
  if (Math.abs(o2) <= 1e-6 && onSegment2d(ax, az, bx, bz, dx, dz)) return true
  if (Math.abs(o3) <= 1e-6 && onSegment2d(cx, cz, dx, dz, ax, az)) return true
  if (Math.abs(o4) <= 1e-6 && onSegment2d(cx, cz, dx, dz, bx, bz)) return true
  return false
}

function pathCrossesInteriorWall(
  fromX: number,
  fromZ: number,
  toX: number,
  toZ: number,
  walls: FloorplanWallSegment[] | undefined
): boolean {
  if (!walls?.length) return false
  // Walls live in plan (x,y); world z corresponds to -plan y (see planYToWorldZ).
  return walls.some((w) =>
    segmentsIntersect2d(fromX, -fromZ, toX, -toZ, w.x1, w.y1, w.x2, w.y2)
  )
}

function constrainPointAgainstInteriorWalls(
  fromX: number,
  fromZ: number,
  toX: number,
  toZ: number,
  walls: FloorplanWallSegment[] | undefined
): { x: number; z: number } {
  if (!pathCrossesInteriorWall(fromX, fromZ, toX, toZ, walls)) {
    return { x: toX, z: toZ }
  }

  let bestX = fromX
  let bestZ = fromZ
  const steps = 24
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    const x = fromX + (toX - fromX) * t
    const z = fromZ + (toZ - fromZ) * t
    if (pathCrossesInteriorWall(fromX, fromZ, x, z, walls)) break
    bestX = x
    bestZ = z
  }
  return { x: bestX, z: bestZ }
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
      const orbitDistance = Math.max(8, span * 1.35)
      cam.position.set(orbitDistance * 0.9, orbitDistance * 0.72, orbitDistance * 0.9)
      cam.near = 0.1
      cam.far = Math.max(300, span * 18)
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
        const orbitMinDistance = Math.max(3, span * 0.2)
        const orbitMaxDistance = Math.max(40, span * 8)
        oc.minPolarAngle = 0
        oc.maxPolarAngle = Math.PI / 2 - 0.1
        oc.minAzimuthAngle = -Infinity
        oc.maxAzimuthAngle = Infinity
        oc.minDistance = orbitMinDistance
        oc.maxDistance = orbitMaxDistance
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
      minDistance={isPlan ? 2.5 : Math.max(3, footprintSpanMeters(roomDimensions) * 0.2)}
      maxDistance={isPlan ? 800 : Math.max(40, footprintSpanMeters(roomDimensions) * 8)}
    />
  )
}

const POLYGON_WALL_THICKNESS_EXTERIOR = 0.1
const POLYGON_WALL_THICKNESS_INTERIOR_DEFAULT = 0.07
const ROOM_WALL_EXTRA_HEIGHT_M = 0.28
const DOOR_FRAME_BAR_THICKNESS_M = 0.04
const DOOR_FRAME_DEPTH_M = 0.014
const DOOR_FRAME_SURFACE_OFFSET_M = 0.01

/** Map plan depth (y, “up” on the 2D footprint preview) to world Z under the Y-up overhead camera (+Z reads screen-down). */
function planYToWorldZ(planY: number): number {
  return -planY
}


function polygonCentroidXZ(footprint: FloorplanPoint2D[]): [number, number] {
  let a = 0
  let cx = 0
  let cz = 0
  const n = footprint.length
  for (let i = 0; i < n; i++) {
    const p0 = footprint[i]
    const p1 = footprint[(i + 1) % n]
    const cross = p0.x * p1.y - p1.x * p0.y
    a += cross
    cx += (p0.x + p1.x) * cross
    cz += (p0.y + p1.y) * cross
  }
  if (Math.abs(a) < 1e-8) {
    let sx = 0
    let sz = 0
    for (const p of footprint) {
      sx += p.x
      sz += p.y
    }
    return [sx / n, sz / n]
  }
  a *= 0.5
  return [cx / (6 * a), cz / (6 * a)]
}

/**
// ─────────────────────────────────────────────────────────────────────────────
// Fixture appearance config
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Extruded shell from 2D footprint (plan x → world X, plan y maps to −world Z for consistent plan vs preview).
 */
function PolygonRoomShell({
  footprint,
  wallHeight,
  wallPolygons,
  doorOpenings,
  exteriorWallOpacity,
  interiorWallOpacity,
}: {
  footprint: FloorplanPoint2D[]
  wallHeight: number
  wallPolygons?: FloorplanPoint2D[][]
  doorOpenings?: FloorplanDoorOpening[]
  exteriorWallOpacity: number
  interiorWallOpacity: number
}) {
  const exteriorMat = useMemo(
    () => ({ color: "#f8f9fb", roughness: 0.52, metalness: 0.03 } as const),
    []
  )
  const interiorMat = useMemo(
    () => ({ color: "#fafbfc", roughness: 0.54, metalness: 0.02 } as const),
    []
  )
  const floorMat = useMemo(
    () => ({ color: "#2a3038", roughness: 0.78, metalness: 0.04 } as const),
    []
  )
  const floorGeo = useMemo(() => {
    const shape = new THREE.Shape()
    shape.moveTo(footprint[0].x, footprint[0].y)
    for (let i = 1; i < footprint.length; i++) {
      shape.lineTo(footprint[i].x, footprint[i].y)
    }
    shape.closePath()
    return new THREE.ShapeGeometry(shape)
  }, [footprint])

  const doorFrameMat = useMemo(
    () => ({ color: "#6f5d4e", roughness: 0.58, metalness: 0.04 } as const),
    []
  )

  // Build extruded geometries from wall-region polygons (pixel-accurate shapes)
  const wallPolyGeos = useMemo(() => {
    if (!wallPolygons || wallPolygons.length === 0) return []
    return wallPolygons.flatMap(poly => {
      if (poly.length < 3) return []
      const shape = new THREE.Shape()
      shape.moveTo(poly[0].x, poly[0].y)
      for (let i = 1; i < poly.length; i++) shape.lineTo(poly[i].x, poly[i].y)
      shape.closePath()
      return [new THREE.ExtrudeGeometry(shape, { depth: wallHeight, bevelEnabled: false })]
    })
  }, [wallPolygons, wallHeight])


  const doorElements = useMemo(() => {
    const out: ReactNode[] = []
    for (const door of doorOpenings ?? []) {
      const dx = door.x2 - door.x1
      const dzPlan = door.y2 - door.y1
      const width = Math.hypot(dx, dzPlan)
      if (width < 0.2) continue

      const doorHeight = Math.min(Math.max(door.height ?? 2.05, 1.8), Math.max(1.85, wallHeight - 0.08))
      const midx = (door.x1 + door.x2) / 2
      const midz = planYToWorldZ((door.y1 + door.y2) / 2)
      const dzWorld = planYToWorldZ(door.y2) - planYToWorldZ(door.y1)
      const dir = new THREE.Vector3(dx / width, 0, dzWorld / width)
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir)
      const outlineOpacity = Math.max(0.3, interiorWallOpacity)

      out.push(
        <group
          key={`door-${door.id}`}
          position={[midx, doorHeight / 2, midz]}
          quaternion={q}
        >
          <mesh position={[-width / 2, 0, DOOR_FRAME_SURFACE_OFFSET_M]} castShadow>
            <boxGeometry args={[DOOR_FRAME_BAR_THICKNESS_M, doorHeight, DOOR_FRAME_DEPTH_M]} />
            <meshStandardMaterial
              {...doorFrameMat}
              transparent
              opacity={outlineOpacity}
              depthWrite={outlineOpacity > 0.45}
            />
          </mesh>
          <mesh position={[width / 2, 0, DOOR_FRAME_SURFACE_OFFSET_M]} castShadow>
            <boxGeometry args={[DOOR_FRAME_BAR_THICKNESS_M, doorHeight, DOOR_FRAME_DEPTH_M]} />
            <meshStandardMaterial
              {...doorFrameMat}
              transparent
              opacity={outlineOpacity}
              depthWrite={outlineOpacity > 0.45}
            />
          </mesh>
          <mesh position={[0, doorHeight / 2, DOOR_FRAME_SURFACE_OFFSET_M]} castShadow>
            <boxGeometry args={[width + DOOR_FRAME_BAR_THICKNESS_M, DOOR_FRAME_BAR_THICKNESS_M, DOOR_FRAME_DEPTH_M]} />
            <meshStandardMaterial
              {...doorFrameMat}
              transparent
              opacity={outlineOpacity}
              depthWrite={outlineOpacity > 0.45}
            />
          </mesh>
        </group>
      )
    }
    return out
  }, [doorFrameMat, doorOpenings, interiorWallOpacity, wallHeight])

  return (
    <group>
      <mesh geometry={floorGeo} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <meshStandardMaterial {...floorMat} side={THREE.DoubleSide} />
      </mesh>
      {wallPolyGeos.map((geo, i) => (
        <mesh key={i} geometry={geo} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.001, 0]} castShadow receiveShadow>
          <meshStandardMaterial
            {...interiorMat}
            transparent
            opacity={interiorWallOpacity}
            depthWrite={interiorWallOpacity > 0.35}
            side={THREE.FrontSide}
            polygonOffset
            polygonOffsetFactor={-1}
            polygonOffsetUnits={-1}
          />
        </mesh>
      ))}
      {doorElements}
    </group>
  )
}

function RectangularRoom({ dimensions, wallOpacity }: { dimensions: RoomDimensions, wallOpacity: number }) {
  const { width, depth } = dimensions
  const height = dimensions.height + ROOM_WALL_EXTRA_HEIGHT_M

  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
        <planeGeometry args={[width, depth]} />
        <meshStandardMaterial color="#2a3038" roughness={0.78} metalness={0.04} />
      </mesh>

      <mesh position={[0, height / 2, -depth / 2]} receiveShadow>
        <planeGeometry args={[width, height]} />
        <meshStandardMaterial color="#f8f9fb" roughness={0.52} metalness={0.02} side={THREE.DoubleSide} transparent opacity={wallOpacity} depthWrite={wallOpacity > 0.35} />
      </mesh>

      <mesh position={[-width / 2, height / 2, 0]} rotation={[0, Math.PI / 2, 0]} receiveShadow>
        <planeGeometry args={[depth, height]} />
        <meshStandardMaterial color="#f6f7f9" roughness={0.52} metalness={0.02} side={THREE.DoubleSide} transparent opacity={wallOpacity} depthWrite={wallOpacity > 0.35} />
      </mesh>

      <mesh position={[width / 2, height / 2, 0]} rotation={[0, -Math.PI / 2, 0]} receiveShadow>
        <planeGeometry args={[depth, height]} />
        <meshStandardMaterial color="#f6f7f9" roughness={0.52} metalness={0.02} side={THREE.DoubleSide} transparent opacity={wallOpacity} depthWrite={wallOpacity > 0.35} />
      </mesh>
    </group>
  )
}

function Room({ dimensions }: { dimensions: RoomDimensions }) {
  const fp = dimensions.geometry?.footprintPolygon
  const { camera } = useThree()
  const wallHeight = dimensions.height + ROOM_WALL_EXTRA_HEIGHT_M

  const [exteriorWallOpacity, setExteriorWallOpacity] = useState(1)
  const opacityRef = useRef(1)
  const dirRef = useRef(new THREE.Vector3())

  useFrame(() => {
    camera.getWorldDirection(dirRef.current)

    // 1 = top-down, 0 = horizontal view
    const topDownness = Math.abs(dirRef.current.y)

    // Fade exterior walls as the camera becomes more horizontal.
    const targetExteriorOpacity = THREE.MathUtils.clamp(
      THREE.MathUtils.mapLinear(topDownness, 0.12, 0.88, 0.05, 1),
      0.05,
      1
    )

    // Smooth interpolation for the dollhouse effect.
    const next = THREE.MathUtils.lerp(opacityRef.current, targetExteriorOpacity, 0.12)

    if (Math.abs(next - opacityRef.current) > 0.002) {
      opacityRef.current = next
      setExteriorWallOpacity(next)
    }
  })

  const interiorWallOpacity = Math.min(0.92, exteriorWallOpacity * 0.72 + 0.12)

  if (fp && isValidFootprintPolygon(fp)) {
    return (
      <>
        <PolygonRoomShell
          footprint={fp}
          wallHeight={wallHeight}
          wallPolygons={dimensions.geometry?.wallPolygons}
          doorOpenings={dimensions.geometry?.doorOpenings}
          exteriorWallOpacity={exteriorWallOpacity}
          interiorWallOpacity={interiorWallOpacity}
        />
      </>
    )
  }

  return (
    <>
      <RectangularRoom dimensions={dimensions} wallOpacity={exteriorWallOpacity} />
    </>
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

/** Live distance-to-wall + furniture dimension labels shown when a piece is selected. */
function FurnitureMeasurements({
  furniture,
  parentGroupRef,
  roomBounds,
}: {
  furniture: Furniture
  parentGroupRef: React.RefObject<THREE.Group>
  roomBounds: { minX: number; maxX: number; minZ: number; maxZ: number }
}) {
  const posRef = useRef({ x: furniture.position[0], z: furniture.position[2] })
  const [, tick] = useState(0)

  useFrame(() => {
    if (!parentGroupRef.current) return
    const nx = parentGroupRef.current.position.x
    const nz = parentGroupRef.current.position.z
    if (Math.abs(nx - posRef.current.x) > 0.005 || Math.abs(nz - posRef.current.z) > 0.005) {
      posRef.current = { x: nx, z: nz }
      tick(t => t + 1)
    }
  })

  const { x, z } = posRef.current
  const hw = furniture.dimensions.width / 2
  const hd = furniture.dimensions.depth / 2
  const y = furniture.dimensions.height + 0.05

  const dLeft  = Math.max(0, x - hw - roomBounds.minX)
  const dRight = Math.max(0, roomBounds.maxX - (x + hw))
  const dFront = Math.max(0, z - hd - roomBounds.minZ)
  const dBack  = Math.max(0, roomBounds.maxZ - (z + hd))

  // All positions are in LOCAL space (group origin = furniture centre)
  const localLeft  = roomBounds.minX - x   // world left wall in local coords
  const localRight = roomBounds.maxX - x
  const localFront = roomBounds.minZ - z
  const localBack  = roomBounds.maxZ - z

  const tag = (text: string) => (
    <div style={{
      background: "rgba(0,0,0,0.72)",
      color: "#fff",
      fontSize: 11,
      fontWeight: 600,
      padding: "2px 6px",
      borderRadius: 4,
      whiteSpace: "nowrap",
      pointerEvents: "none",
      fontFamily: "system-ui, sans-serif",
      letterSpacing: "0.01em",
    }}>{text}</div>
  )

  return (
    <group>
      {/* Furniture dimensions — centred above */}
      <Html position={[0, y + 0.18, 0]} center>
        {tag(`${furniture.dimensions.width.toFixed(2)}m × ${furniture.dimensions.depth.toFixed(2)}m`)}
      </Html>

      {/* Distance labels: midpoint between furniture edge and wall, in local coords */}
      <Html position={[(-hw + localLeft) / 2, y, 0]} center>
        {tag(`← ${dLeft.toFixed(2)}m`)}
      </Html>
      <Html position={[(hw + localRight) / 2, y, 0]} center>
        {tag(`${dRight.toFixed(2)}m →`)}
      </Html>
      <Html position={[0, y, (-hd + localFront) / 2]} center>
        {tag(`↑ ${dFront.toFixed(2)}m`)}
      </Html>
      <Html position={[0, y, (hd + localBack) / 2]} center>
        {tag(`${dBack.toFixed(2)}m ↓`)}
      </Html>
    </group>
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
  roomBounds: {
    minX: number
    maxX: number
    minZ: number
    maxZ: number
    interiorWalls?: FloorplanWallSegment[]
  }
}) {
  const groupRef = useRef<THREE.Group>(null)
  const isDraggingRef = useRef(false)
  const { camera, gl } = useThree()

  // Pre-allocate — never recreated during drag
  const raycaster = useRef(new THREE.Raycaster())
  const mouse = useRef(new THREE.Vector2())
  const dragPlane = useRef(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0))
  const intersection = useRef(new THREE.Vector3())
  // Raw client coords updated by native pointermove — never stale even when
  // the cursor leaves the mesh bounding box during a fast drag
  const clientPos = useRef({ x: 0, y: 0 })

  useEffect(() => {
    const canvas = gl.domElement
    const onMove = (e: PointerEvent) => {
      clientPos.current = { x: e.clientX, y: e.clientY }
    }
    canvas.addEventListener("pointermove", onMove)
    return () => canvas.removeEventListener("pointermove", onMove)
  }, [gl])

  const handlePointerDown = (e: THREE.Event) => {
    e.stopPropagation()
    onSelect()
    const canvas = gl.domElement as HTMLCanvasElement
    if (canvas?.setPointerCapture && e.pointerId != null) {
      canvas.setPointerCapture(e.pointerId)
    }
    isDraggingRef.current = true
    onDragStart?.()
    gl.domElement.style.cursor = "grabbing"
  }

  const commitPosition = () => {
    if (!groupRef.current) return
    const p = groupRef.current.position
    const x = Math.max(roomBounds.minX, Math.min(roomBounds.maxX, Math.round(p.x * 2) / 2))
    const z = Math.max(roomBounds.minZ, Math.min(roomBounds.maxZ, Math.round(p.z * 2) / 2))
    const constrained = constrainPointAgainstInteriorWalls(
      furniture.position[0], furniture.position[2], x, z, roomBounds.interiorWalls
    )
    onMove([constrained.x, furniture.dimensions.height / 2, constrained.z])
  }

  const handlePointerUp = (e: THREE.Event) => {
    const canvas = gl.domElement as HTMLCanvasElement
    if (canvas?.releasePointerCapture && e.pointerId != null) {
      canvas.releasePointerCapture(e.pointerId)
    }
    if (isDraggingRef.current) commitPosition()
    isDraggingRef.current = false
    onDragEnd?.()
    gl.domElement.style.cursor = "auto"
  }

  useFrame(() => {
    if (!isDraggingRef.current || !groupRef.current) return

    const rect = gl.domElement.getBoundingClientRect()
    mouse.current.x = ((clientPos.current.x - rect.left) / rect.width) * 2 - 1
    mouse.current.y = -((clientPos.current.y - rect.top) / rect.height) * 2 + 1

    raycaster.current.setFromCamera(mouse.current, camera)
    raycaster.current.ray.intersectPlane(dragPlane.current, intersection.current)

    const ix = intersection.current.x
    const iz = intersection.current.z
    if (Number.isFinite(ix) && Number.isFinite(iz)) {
      const x = Math.max(roomBounds.minX, Math.min(roomBounds.maxX, ix))
      const z = Math.max(roomBounds.minZ, Math.min(roomBounds.maxZ, iz))
      groupRef.current.position.set(x, furniture.dimensions.height / 2, z)
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
    >
      <FurnitureSlot
        furniture={furniture}
        product={product}
        isSelected={isSelected}
        onBboxReady={isSelected ? onBboxReady : undefined}
      />
      {/*isSelected && (
        <FurnitureInSceneDimensionLabel furniture={furniture} glbBbox={glbBbox} debug={debug} />
      )*/}
      {isSelected && (
        <FurnitureMeasurements
          furniture={furniture}
          parentGroupRef={groupRef}
          roomBounds={roomBounds}
        />
      )}
      {/*isSelected && debug && (
        <Html position={[0, furniture.dimensions.height + 0.2, 0]} center>
          <div className="text-xs bg-black/80 text-white rounded px-2 py-1 font-mono whitespace-nowrap max-w-[200px] truncate">
            <div>{(product?.title ?? furniture.name) || "—"}</div>
            <div>{(product?.model_url ?? furniture.model_url) || "—"}</div>
            <div>{((product?.model_url ?? furniture.model_url)?.trim() ? "GLB" : "Proxy")}</div>
          </div>
        </Html>
      )}*/}
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
  onSnapshotReady?: (dataUrl: string) => void
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
    cam.up.set(0, 1, 0)
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
  onDeleteFurniture,
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
        minZ: -aabb.maxY + inset,
        maxZ: -aabb.minY - inset,
        interiorWalls: roomDimensions.geometry?.interiorWalls,
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

      {/* Indoor apartment HDRI — provides soft, realistic global illumination.
          background=false keeps the scene background colour, only affects lighting. */}
      <HdriEnvironmentErrorBoundary>
        <Suspense fallback={null}>
          <Environment preset="apartment" background={false} environmentIntensity={1.2} />
        </Suspense>
      </HdriEnvironmentErrorBoundary>
      {/* Subtle fill lights to prevent pitch-black shadows */}
      <ambientLight intensity={0.4} />
      <directionalLight
        position={[6, 10, 6]}
        intensity={1.5}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0005}
      />
      <directionalLight position={[-5, 8, -5]} intensity={0.6} />

      <Room dimensions={roomDimensions} />

      {/*{selectedId == null && !isDragging && (
        <RoomEnvelopeInSceneLabel roomDimensions={roomDimensions} debug={debug} />
      )}*/}

      {!isValidFootprintPolygon(roomDimensions.geometry?.footprintPolygon ?? []) && (
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
      )}

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
          onDelete={() => onDeleteFurniture(furniture.id)}
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
    scene.background = new THREE.Color(0xe6eaef)
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
  const selectedFurniture = useMemo(
    () =>
      props.selectedId != null
        ? props.placedFurniture.find((f) => f.id === props.selectedId) ?? null
        : null,
    [props.selectedId, props.placedFurniture]
  )
  
  const selectedProductForLabel = useMemo(() => {
    if (!selectedFurniture || !props.products?.length) return null
    const productId = extractProductIdFromFurnitureId(selectedFurniture.id)
    return productId
      ? props.products.find((p) => p.id === productId) ?? null
      : null
  }, [selectedFurniture, props.products])

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

        {selectedFurniture && (
        <div className="absolute left-4 top-4 z-20 rounded-xl bg-black/80 text-white px-4 py-3 shadow-lg backdrop-blur-sm max-w-[280px]">
          <div className="text-sm font-semibold">
            {selectedProductForLabel?.title ?? selectedFurniture.name}
          </div>

          <div className="mt-2 text-sm text-amber-100">
            {selectedFurniture.dimensions.depth.toFixed(2)} ×{" "}
            {selectedFurniture.dimensions.width.toFixed(2)} ×{" "}
            {selectedFurniture.dimensions.height.toFixed(2)} m
          </div>

          <div className="text-xs text-white/65 mt-1">
            length × width × height
          </div>
        </div>
      )}

        {props.debug && debugOverlayData && <DebugDimensionOverlay data={debugOverlayData} />}

        {/* Furniture action toolbar — pure DOM, no Three.js event conflicts */}
        {selectedFurniture && (
          <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-card/90 backdrop-blur border border-border rounded-full px-3 py-2 shadow-lg pointer-events-auto">
            <button
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium hover:bg-muted transition-colors"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); props.onRotateFurniture(selectedFurniture.id) }}
            >
              <RotateCw className="w-4 h-4" />
              Rotate 90°
            </button>
            <div className="w-px h-5 bg-border" />
            <button
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium text-destructive hover:bg-destructive/10 transition-colors"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); props.onDeleteFurniture(selectedFurniture.id) }}
            >
              <Trash2 className="w-4 h-4" />
              Delete
            </button>
          </div>
        )}

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
