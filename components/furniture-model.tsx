"use client"

/**
 * FurnitureModel: renders proxy geometry or GLB.
 *
 * Axis semantics (Three.js Y-up) — explicit DB ↔ GLB mapping:
 * - Three X  ← raw GLB AABB size.x  ← target `dimensions.width`  ← DB `width_m`
 * - Three Y  ← raw GLB AABB size.y  ← target `dimensions.height` ← DB `height_m`
 * - Three Z  ← raw GLB AABB size.z  ← target `dimensions.depth`  ← DB `length_m` (front–back)
 *
 * GLB files may be authored in any local orientation; we only rescale the loaded root’s axis-aligned
 * bounding box (AABB) to match those targets. We do not rotate to “fix” Z-up models.
 *
 * Calibration:
 * - `dimensionsAuthoritative === true` (catalog sizes): per-axis scale so final AABB matches targets.
 * - Otherwise: uniform scale = min(scaleX, scaleY, scaleZ) capped (legacy “fit inside” proxy box).
 *
 * See lib/dimensionSemantics.ts for product-table semantics.
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

export type GlbCalibrationMode = "per-axis-exact" | "uniform-fit-inside" | "fallback-identity"

/** Dev-oriented sanity flag; see `evaluateGlbCalibrationSanity` rules in this file. */
export type GlbSuspiciousCalibrationReason =
  | "degenerate-bbox"
  | "extreme-axis-scale"
  | "likely-axis-mismatch"
  | "missing-authoritative-dims"

export interface GlbBboxInfo {
  /** Axis-aligned size of the GLB at root scale (1,1,1), in Three.js world units (meters). */
  raw: { x: number; y: number; z: number }
  /**
   * Uniform factor for quick display; equals scaleAxis.x in uniform-fit mode,
   * or cube root of (sx·sy·sz) in per-axis mode.
   */
  scale: number
  /** Per-axis scale applied to the GLB root: raw.{x,y,z} * scaleAxis.{x,y,z} → target extents. */
  scaleAxis: { x: number; y: number; z: number }
  /** Expected AABB after scaling (should match target when calibration succeeded). */
  scaled: { x: number; y: number; z: number }
  /** Target extents (m): X width, Y height, Z depth — same as `furniture.dimensions`. */
  target: { x: number; y: number; z: number }
  calibrationMode: GlbCalibrationMode
  /** True when a dev-only sanity rule tripped (axis/units mismatch, bad inputs, etc.). */
  suspiciousCalibration: boolean
  /** Primary reason when `suspiciousCalibration`; null when calibration looks sane. */
  suspiciousReason: GlbSuspiciousCalibrationReason | null
}

const IS_DEV = process.env.NODE_ENV === "development"

/** Verbose bbox logs (development only). */
const BBOX_REPORT_DEBUG = IS_DEV

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
  const sax = normalizeScalar(info.scaleAxis.x)
  const say = normalizeScalar(info.scaleAxis.y)
  const saz = normalizeScalar(info.scaleAxis.z)
  const sc = normalizeScalar(info.scale)
  const tx = normalizeScalar(info.target.x)
  const ty = normalizeScalar(info.target.y)
  const tz = normalizeScalar(info.target.z)
  return {
    raw: { x: rx, y: ry, z: rz },
    scale: sc,
    scaleAxis: { x: sax, y: say, z: saz },
    scaled: {
      x: normalizeScalar(rx * sax),
      y: normalizeScalar(ry * say),
      z: normalizeScalar(rz * saz),
    },
    target: { x: tx, y: ty, z: tz },
    calibrationMode: info.calibrationMode,
    suspiciousCalibration: info.suspiciousCalibration,
    suspiciousReason: info.suspiciousReason,
  }
}

export function glbBboxInfoKey(info: GlbBboxInfo): string {
  const n = normalizeGlbBboxInfo(info)
  const r = (x: number) => (Number.isFinite(x) ? x.toFixed(BBOX_ROUND_DECIMALS) : "nan")
  return [
    r(n.raw.x),
    r(n.raw.y),
    r(n.raw.z),
    r(n.scaleAxis.x),
    r(n.scaleAxis.y),
    r(n.scaleAxis.z),
    r(n.scale),
    r(n.scaled.x),
    r(n.scaled.y),
    r(n.scaled.z),
    r(n.target.x),
    r(n.target.y),
    r(n.target.z),
    n.calibrationMode,
    String(n.suspiciousCalibration),
    n.suspiciousReason ?? "",
  ].join(",")
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

const BBOX_EPS = 1e-6
/** Legacy cap: uniform “fit inside” scale for non-authoritative / proxy dimensions. */
const UNIFORM_FIT_MAX_SCALE = 10

/** Dev-only soft band: outside this suggests wrong units or huge mesh-vs-DB mismatch. */
const SANITY_SCALE_SOFT_MIN = 0.33
const SANITY_SCALE_SOFT_MAX = 3
/** Per-axis: max(scaleAxis) / min(scaleAxis) above this is suspicious (axis swap or bad asset). */
const SANITY_AXIS_SCALE_SPREAD_MAX = 8
/** “Boxy” raw + target (aspect < 2) but highly skewed per-axis scales → possible axis mismatch. */
const SANITY_BOXY_ASPECT_MAX = 2
const SANITY_MISMATCH_MIN_SCALE_SPREAD = 6

function geomMeanScale(sax: number, say: number, saz: number): number {
  if (![sax, say, saz].every((n) => Number.isFinite(n) && n > 0)) return 1
  return Math.cbrt(sax * say * saz)
}

function bboxAspectRatio3(x: number, y: number, z: number): number {
  if (![x, y, z].every((n) => Number.isFinite(n) && n > BBOX_EPS)) return Number.POSITIVE_INFINITY
  return Math.max(x, y, z) / Math.min(x, y, z)
}

interface GlbCalibrationSanityContext {
  degenerateRaw: boolean
  dimensionsAuthoritative?: boolean
  partialAuthoritativeTargets: boolean
  allAuthoritativeTargetsInvalid: boolean
  furnitureId?: string
  furnitureName?: string
}

/**
 * Dev-only sanity checks after numeric calibration. Production path: only sets flags, no console in prod.
 *
 * Priority (first match wins for `suspiciousReason`):
 * 1. degenerate-bbox — raw AABB invalid on load
 * 2. missing-authoritative-dims — authoritative mode but target(s) missing/invalid
 * 3. likely-axis-mismatch — boxy GLB + boxy DB targets but per-axis scales differ by ≥6× (see constants)
 * 4. extreme-axis-scale — any scale outside [0.33, 3] OR inter-axis scale spread > 8 (per-axis mode)
 *
 * Uniform-fit mode: only checks single uniform factor outside [0.33, 3].
 */
function attachCalibrationSanity(info: GlbBboxInfo, ctx: GlbCalibrationSanityContext): GlbBboxInfo {
  let suspiciousReason: GlbSuspiciousCalibrationReason | null = null

  if (ctx.degenerateRaw) {
    suspiciousReason = "degenerate-bbox"
  } else if (
    ctx.dimensionsAuthoritative === true &&
    (ctx.partialAuthoritativeTargets || ctx.allAuthoritativeTargetsInvalid)
  ) {
    suspiciousReason = "missing-authoritative-dims"
  } else if (info.calibrationMode === "per-axis-exact") {
    const sx = info.scaleAxis.x
    const sy = info.scaleAxis.y
    const sz = info.scaleAxis.z
    const scalesPositive = [sx, sy, sz].every((v) => Number.isFinite(v) && v > 0)
    const spread =
      scalesPositive && sx > 0 && sy > 0 && sz > 0 ? Math.max(sx, sy, sz) / Math.min(sx, sy, sz) : 1

    const rawAspect = bboxAspectRatio3(info.raw.x, info.raw.y, info.raw.z)
    const tgtAspect = bboxAspectRatio3(info.target.x, info.target.y, info.target.z)
    const likelyAxisMismatch =
      rawAspect < SANITY_BOXY_ASPECT_MAX &&
      tgtAspect < SANITY_BOXY_ASPECT_MAX &&
      spread >= SANITY_MISMATCH_MIN_SCALE_SPREAD

    const anySoftOutOfBand =
      sx < SANITY_SCALE_SOFT_MIN ||
      sx > SANITY_SCALE_SOFT_MAX ||
      sy < SANITY_SCALE_SOFT_MIN ||
      sy > SANITY_SCALE_SOFT_MAX ||
      sz < SANITY_SCALE_SOFT_MIN ||
      sz > SANITY_SCALE_SOFT_MAX
    const extremeSpread = scalesPositive && spread > SANITY_AXIS_SCALE_SPREAD_MAX

    if (likelyAxisMismatch) suspiciousReason = "likely-axis-mismatch"
    else if (anySoftOutOfBand || extremeSpread) suspiciousReason = "extreme-axis-scale"
  } else if (info.calibrationMode === "uniform-fit-inside") {
    const u = info.scaleAxis.x
    if (u < SANITY_SCALE_SOFT_MIN || u > SANITY_SCALE_SOFT_MAX) {
      suspiciousReason = "extreme-axis-scale"
    }
  }

  const suspiciousCalibration = suspiciousReason != null

  if (IS_DEV && suspiciousCalibration) {
    console.warn("[furniture-model] Suspicious GLB calibration", {
      reason: suspiciousReason,
      furnitureId: ctx.furnitureId ?? "(unknown)",
      furnitureTitle: ctx.furnitureName ?? "(unknown)",
      rawGLB: info.raw,
      targetM: info.target,
      scaleAxis: info.scaleAxis,
      calibrationMode: info.calibrationMode,
    })
  }

  return {
    ...info,
    suspiciousCalibration,
    suspiciousReason,
  }
}

/**
 * Deterministic scale from raw GLB AABB to scene targets (meters).
 * See file header for X/Y/Z ↔ DB field mapping.
 */
function computeGlbCalibration(input: {
  raw: { x: number; y: number; z: number }
  targetWidth: number
  targetHeight: number
  targetDepth: number
  dimensionsAuthoritative?: boolean
  furnitureId?: string
  furnitureName?: string
}): GlbBboxInfo {
  const {
    raw,
    targetWidth,
    targetHeight,
    targetDepth,
    dimensionsAuthoritative,
    furnitureId,
    furnitureName,
  } = input
  const { x: rx, y: ry, z: rz } = raw
  const target = { x: targetWidth, y: targetHeight, z: targetDepth }

  const rawOk = (v: number) => Number.isFinite(v) && v > BBOX_EPS
  const targetOk = (v: number) => Number.isFinite(v) && v > BBOX_EPS

  const sanityCtxBase: Omit<GlbCalibrationSanityContext, "degenerateRaw" | "partialAuthoritativeTargets" | "allAuthoritativeTargetsInvalid"> =
    {
      dimensionsAuthoritative,
      furnitureId,
      furnitureName,
    }

  if (!rawOk(rx) || !rawOk(ry) || !rawOk(rz)) {
    const base = normalizeGlbBboxInfo({
      raw: { x: rx, y: ry, z: rz },
      scaleAxis: { x: 1, y: 1, z: 1 },
      scale: 1,
      scaled: { x: rx, y: ry, z: rz },
      target,
      calibrationMode: "fallback-identity",
      suspiciousCalibration: false,
      suspiciousReason: null,
    })
    return attachCalibrationSanity(base, {
      ...sanityCtxBase,
      degenerateRaw: true,
      partialAuthoritativeTargets: false,
      allAuthoritativeTargetsInvalid: false,
    })
  }

  if (dimensionsAuthoritative) {
    const sx = targetOk(targetWidth) ? targetWidth / rx : 1
    const sy = targetOk(targetHeight) ? targetHeight / ry : 1
    const sz = targetOk(targetDepth) ? targetDepth / rz : 1

    const twOk = targetOk(targetWidth)
    const thOk = targetOk(targetHeight)
    const tdOk = targetOk(targetDepth)
    const allTargetsInvalid = !twOk && !thOk && !tdOk
    const partialAuthoritativeTargets =
      !allTargetsInvalid && (!twOk || !thOk || !tdOk)

    if (allTargetsInvalid) {
      const base = normalizeGlbBboxInfo({
        raw: { x: rx, y: ry, z: rz },
        scaleAxis: { x: 1, y: 1, z: 1 },
        scale: 1,
        scaled: { x: rx, y: ry, z: rz },
        target,
        calibrationMode: "fallback-identity",
        suspiciousCalibration: false,
        suspiciousReason: null,
      })
      return attachCalibrationSanity(base, {
        ...sanityCtxBase,
        degenerateRaw: false,
        partialAuthoritativeTargets: false,
        allAuthoritativeTargetsInvalid: true,
      })
    }

    const base = normalizeGlbBboxInfo({
      raw: { x: rx, y: ry, z: rz },
      scaleAxis: { x: sx, y: sy, z: sz },
      scale: geomMeanScale(sx, sy, sz),
      scaled: { x: rx * sx, y: ry * sy, z: rz * sz },
      target,
      calibrationMode: "per-axis-exact",
      suspiciousCalibration: false,
      suspiciousReason: null,
    })
    return attachCalibrationSanity(base, {
      ...sanityCtxBase,
      degenerateRaw: false,
      partialAuthoritativeTargets,
      allAuthoritativeTargetsInvalid: false,
    })
  }

  const scaleX = targetOk(targetWidth) ? targetWidth / rx : Number.POSITIVE_INFINITY
  const scaleY = targetOk(targetHeight) ? targetHeight / ry : Number.POSITIVE_INFINITY
  const scaleZ = targetOk(targetDepth) ? targetDepth / rz : Number.POSITIVE_INFINITY
  let u = Math.min(scaleX, scaleY, scaleZ)
  if (!Number.isFinite(u) || u <= 0) u = 1
  u = Math.min(u, UNIFORM_FIT_MAX_SCALE)

  const base = normalizeGlbBboxInfo({
    raw: { x: rx, y: ry, z: rz },
    scaleAxis: { x: u, y: u, z: u },
    scale: u,
    scaled: { x: rx * u, y: ry * u, z: rz * u },
    target,
    calibrationMode: "uniform-fit-inside",
    suspiciousCalibration: false,
    suspiciousReason: null,
  })
  return attachCalibrationSanity(base, {
    ...sanityCtxBase,
    degenerateRaw: false,
    partialAuthoritativeTargets: false,
    allAuthoritativeTargetsInvalid: false,
  })
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
  dimensionsAuthoritative,
  furnitureId,
  furnitureName,
  onBboxReady,
}: {
  modelUrl: string
  targetWidth: number
  targetHeight: number
  targetDepth: number
  dimensionsAuthoritative?: boolean
  furnitureId?: string
  furnitureName?: string
  onBboxReady?: (info: GlbBboxInfo) => void
}) {
  const gltf = useGLTF(modelUrl)

  const bboxReport = useMemo(() => {
    const size = getRawModelSizeIdentity(gltf.scene)
    const raw = { x: size.x, y: size.y, z: size.z }
    const normalized = computeGlbCalibration({
      raw,
      targetWidth,
      targetHeight,
      targetDepth,
      dimensionsAuthoritative,
      furnitureId,
      furnitureName,
    })
    return {
      rawMeasured: raw,
      normalized,
    }
  }, [
    gltf,
    modelUrl,
    targetWidth,
    targetHeight,
    targetDepth,
    dimensionsAuthoritative,
    furnitureId,
    furnitureName,
  ])

  const { x: psx, y: psy, z: psz } = bboxReport.normalized.scaleAxis

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
    const { normalized, rawMeasured } = bboxReport
    const fin = (n: number) => Number.isFinite(n)
    if (
      !fin(normalized.raw.x) ||
      !fin(normalized.raw.y) ||
      !fin(normalized.raw.z) ||
      !fin(normalized.scaleAxis.x) ||
      !fin(normalized.scaleAxis.y) ||
      !fin(normalized.scaleAxis.z)
    ) {
      return
    }

    const key = glbBboxInfoKey(normalized)
    if (lastReportedKeyRef.current === key) {
      if (BBOX_REPORT_DEBUG) {
        console.log("[furniture-model:GLBModelInner] bbox report skipped (duplicate key)", {
          rawBeforeNorm: rawMeasured,
          normalizedKey: key,
        })
      }
      return
    }
    lastReportedKeyRef.current = key
    if (BBOX_REPORT_DEBUG) {
      console.log("[furniture-model:GLBModelInner] bbox report emit", {
        rawGLB: rawMeasured,
        targetM: normalized.target,
        scaleAxis: normalized.scaleAxis,
        calibrationMode: normalized.calibrationMode,
        scaled: normalized.scaled,
        suspiciousCalibration: normalized.suspiciousCalibration,
        suspiciousReason: normalized.suspiciousReason,
        normalizedKey: key,
      })
    }
    onBboxReadyRef.current?.(normalized)
  }, [bboxReport])

  return <primitive object={gltf.scene} scale={[psx, psy, psz]} />
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
          dimensionsAuthoritative={furniture.dimensionsAuthoritative}
          furnitureId={furniture.id}
          furnitureName={furniture.name}
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
