"use client"

/**
 * FurnitureModel: renders proxy geometry or GLB.
 *
 * Axis semantics (Three.js Y-up):
 * - X = width  (left-right)
 * - Y = height (up)
 * - Z = depth  (front-back)
 *
 * furniture.dimensions: { width, height, depth } map to X, Y, Z.
 * See lib/dimensionSemantics.ts for DB mapping.
 */

import {
  useRef,
  Suspense,
  Component,
  useEffect,
  useLayoutEffect,
  useMemo,
  type ReactNode,
} from "react"
import { useGLTF, Html } from "@react-three/drei"
import * as THREE from "three"
import type { Furniture } from "@/lib/types"

interface FurnitureModelProps {
  furniture: Furniture
  isSelected: boolean
  /** Optional: show "3D model" vs "Proxy" label when selected */
  showModelLabel?: boolean
  /** Internal: report GLB bbox when loaded (for debug overlay) */
  onBboxReady?: (info: GlbBboxInfo) => void
}

function ProxyBox({ furniture }: { furniture: Furniture }) {
  const { width, height, depth } = furniture.dimensions
  return (
    <mesh castShadow>
      {/* BoxGeometry [X,Y,Z] = [width, height, depth] */}
      <boxGeometry args={[width, height, depth]} />
      <meshStandardMaterial color={furniture.color} />
    </mesh>
  )
}

export interface GlbBboxInfo {
  raw: { x: number; y: number; z: number }
  scale: number
  scaled: { x: number; y: number; z: number }
}

/** Set false to silence bbox report diagnostics. */
const BBOX_REPORT_DEBUG = true

/** When true, all GLB meshes use a flat gray material (local debug; turn off for real PBR). */
const DEBUG_OVERRIDE_MODEL_MATERIAL = false

const BBOX_ROUND_DECIMALS = 6
const BBOX_ROUND_MULT = 10 ** BBOX_ROUND_DECIMALS

function normalizeScalar(n: number): number {
  if (!Number.isFinite(n)) return n
  return Math.round(n * BBOX_ROUND_MULT) / BBOX_ROUND_MULT
}

/**
 * Rounds all bbox/scale fields so float jitter and identity-vs-scaled measurement
 * differences do not produce new keys every frame.
 */
export function normalizeGlbBboxInfo(info: GlbBboxInfo): GlbBboxInfo {
  const rx = normalizeScalar(info.raw.x)
  const ry = normalizeScalar(info.raw.y)
  const rz = normalizeScalar(info.raw.z)
  const sc = normalizeScalar(info.scale)
  return {
    raw: { x: rx, y: ry, z: rz },
    scale: sc,
    scaled: {
      x: normalizeScalar(rx * sc),
      y: normalizeScalar(ry * sc),
      z: normalizeScalar(rz * sc),
    },
  }
}

export function glbBboxInfoKey(info: GlbBboxInfo): string {
  const n = normalizeGlbBboxInfo(info)
  const r = (x: number) => (Number.isFinite(x) ? x.toFixed(BBOX_ROUND_DECIMALS) : "nan")
  return `${r(n.raw.x)},${r(n.raw.y)},${r(n.raw.z)},${r(n.scale)},${r(n.scaled.x)},${r(n.scaled.y)},${r(n.scaled.z)}`
}

export function glbBboxInfoEqual(a: GlbBboxInfo | null, b: GlbBboxInfo | null): boolean {
  if (a === b) return true
  if (a == null || b == null) return false
  return glbBboxInfoKey(a) === glbBboxInfoKey(b)
}

/**
 * Measure AABB in model space as if the root had scale (1,1,1). Required because
 * <primitive scale={…}> mutates gltf.scene.scale; measuring the live scene each
 * pass feeds scaled sizes back into scale math and retriggers reporting → parent
 * setState → infinite loop when a selection wires onBboxReady.
 */
function getRawModelSizeIdentity(scene: THREE.Object3D): THREE.Vector3 {
  const backup = scene.scale.clone()
  scene.scale.set(1, 1, 1)
  scene.updateMatrixWorld(true)
  const box = new THREE.Box3().setFromObject(scene)
  const v = new THREE.Vector3()
  box.getSize(v)
  scene.scale.copy(backup)
  scene.updateMatrixWorld(true)
  return v
}

function applyDebugGrayMaterial(scene: THREE.Object3D) {
  const mat = new THREE.MeshStandardMaterial({
    color: "#9a9a9a",
    roughness: 0.95,
    metalness: 0,
  })
  scene.traverse((obj: THREE.Object3D) => {
    if (!(obj instanceof THREE.Mesh)) return
    obj.castShadow = true
    obj.receiveShadow = true
    const prev = obj.material
    if (Array.isArray(prev)) {
      prev.forEach((m) => m.dispose())
    } else if (prev) {
      prev.dispose()
    }
    obj.material = mat
  })
}

function GLBModelInner({
  modelUrl,
  targetWidth,
  targetHeight,
  targetDepth,
  onBboxReady,
}: {
  modelUrl: string
  targetWidth: number
  targetHeight: number
  targetDepth: number
  onBboxReady?: (info: GlbBboxInfo) => void
}) {
  const gltf = useGLTF(modelUrl)

  const bboxReport = useMemo(() => {
    const size = getRawModelSizeIdentity(gltf.scene)
    const sx = size.x
    const sy = size.y
    const sz = size.z
    const eps = 1e-6
    const scaleX = sx > eps ? targetWidth / sx : 1
    const scaleY = sy > eps ? targetHeight / sy : 1
    const scaleZ = sz > eps ? targetDepth / sz : 1
    const scaleUncached = Math.min(scaleX, scaleY, scaleZ, 10) || 1

    const preNorm: GlbBboxInfo = {
      raw: { x: sx, y: sy, z: sz },
      scale: scaleUncached,
      scaled: { x: sx * scaleUncached, y: sy * scaleUncached, z: sz * scaleUncached },
    }
    const normalized = normalizeGlbBboxInfo(preNorm)
    return {
      rawMeasured: { x: sx, y: sy, z: sz },
      scaleUncached,
      normalized,
    }
  }, [gltf, modelUrl, targetWidth, targetHeight, targetDepth])

  const renderScale = bboxReport.normalized.scale

  /** Dedupes Strict Mode double layout + same gltf.scene uuid within this mount. */
  const debugMaterialAppliedForSceneUuidRef = useRef<string | null>(null)
  const onBboxReadyRef = useRef(onBboxReady)
  onBboxReadyRef.current = onBboxReady
  const lastReportedKeyRef = useRef<string | null>(null)

  useLayoutEffect(() => {
    if (!DEBUG_OVERRIDE_MODEL_MATERIAL) return
    const scene = gltf.scene
    if (debugMaterialAppliedForSceneUuidRef.current === scene.uuid) return
    debugMaterialAppliedForSceneUuidRef.current = scene.uuid
    applyDebugGrayMaterial(scene)
  }, [gltf, modelUrl])

  useEffect(() => {
    lastReportedKeyRef.current = null
  }, [modelUrl])

  useEffect(() => {
    const { normalized, rawMeasured, scaleUncached } = bboxReport
    const sx = normalized.raw.x
    const sy = normalized.raw.y
    const sz = normalized.raw.z
    if (![sx, sy, sz, normalized.scale].every((n) => Number.isFinite(n))) return

    const key = glbBboxInfoKey(normalized)
    if (lastReportedKeyRef.current === key) {
      if (BBOX_REPORT_DEBUG) {
        console.log("[furniture-model:GLBModelInner] bbox report skipped (duplicate key)", {
          rawBeforeNorm: rawMeasured,
          scaleUncached,
          normalizedKey: key,
        })
      }
      return
    }
    lastReportedKeyRef.current = key
    if (BBOX_REPORT_DEBUG) {
      console.log("[furniture-model:GLBModelInner] bbox report emit", {
        rawBeforeNorm: rawMeasured,
        scaleUncached,
        normalized,
        normalizedKey: key,
      })
    }
    onBboxReadyRef.current?.(normalized)
  }, [bboxReport])

  return <primitive object={gltf.scene} scale={renderScale} />
}

class GLBErrorBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false }
  static getDerivedStateFromError = () => ({ hasError: true })
  render() {
    if (this.state.hasError) return this.props.fallback
    return this.props.children
  }
}

function GLBModel({
  furniture,
  modelUrl,
  onBboxReady,
}: {
  furniture: Furniture
  modelUrl: string
  onBboxReady?: (info: GlbBboxInfo) => void
}) {
  const { width = 1, height = 1, depth = 1 } = furniture.dimensions ?? {}
  useEffect(() => {
    try {
      useGLTF.preload(modelUrl)
    } catch {
      // ignore preload errors
    }
  }, [modelUrl])
  const proxyFallback = <ProxyBox furniture={furniture} />
  return (
    <GLBErrorBoundary fallback={proxyFallback}>
      <Suspense fallback={proxyFallback}>
        <GLBModelInner
          modelUrl={modelUrl}
          targetWidth={width}
          targetHeight={height}
          targetDepth={depth}
          onBboxReady={onBboxReady}
        />
      </Suspense>
    </GLBErrorBoundary>
  )
}

export function FurnitureModel({ furniture, isSelected, showModelLabel = true, onBboxReady }: FurnitureModelProps) {
  const meshRef = useRef<THREE.Mesh>(null)
  const { width, height, depth } = furniture.dimensions
  const modelUrl = furniture.model_url?.trim()
  const useGLB = !!modelUrl

  const renderModel = () => {
    if (useGLB) {
      return <GLBModel furniture={furniture} modelUrl={modelUrl!} onBboxReady={onBboxReady} />
    }
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
        <>
          <mesh position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
            <ringGeometry args={[Math.max(width, depth) / 2 + 0.1, Math.max(width, depth) / 2 + 0.2, 32]} />
            <meshBasicMaterial color="#d4a853" transparent opacity={0.8} />
          </mesh>
          {showModelLabel && (
            <Html position={[0, height / 2 + 0.3, 0]} center>
              <span className="text-xs bg-card/90 border border-border rounded px-2 py-0.5 shadow-sm whitespace-nowrap">
                {useGLB ? "3D model" : "Proxy"}
              </span>
            </Html>
          )}
        </>
      )}
    </group>
  )
}
