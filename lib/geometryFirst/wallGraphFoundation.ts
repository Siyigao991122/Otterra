/**
 * Graph-ready view of cleaned wall segments + first-pass outer-boundary heuristics.
 * Reversible: callers keep `cleanedWallLines`; this only derives inspectable stats.
 */

import type {
  ExtractedLineSegment,
  OuterCycleTraceDebug,
  WallGraphDebugPayload,
  WallJunctionSplitGraphStats,
} from "@/lib/geometryFirst/types"
import { traceOuterCycleLargestComponent } from "@/lib/geometryFirst/wallGraphOuterCycle"

export interface WallGraphFoundationOptions {
  /**
   * Endpoints whose quantized grid cell matches merge into one node (PDF pt).
   * Larger = fewer nodes / more aggressive merging.
   */
  nodeMergeQuantizationPt?: number
  /** Max distance to treat a hull edge as matching a cleaned segment (PDF pt). */
  hullSegmentMatchTolPt?: number
}

const DEFAULTS = {
  nodeMergeQuantizationPt: 0.75,
  hullSegmentMatchTolPt: 1.5,
}

/** Compact stats for comparing graph health before vs after junction splitting. */
export function wallGraphConnectivitySnapshot(w: WallGraphDebugPayload): WallJunctionSplitGraphStats {
  return {
    nodeCount: w.nodeCount,
    averageDegree: w.averageDegree,
    danglingEndpointCount: w.danglingEndpointCount,
    connectedComponentCount: w.connectedComponentCount,
    largestComponentPlausibility: w.largestComponent.plausibility,
    largestComponentNodeCount: w.largestComponent.nodeCount,
  }
}

const EMPTY_OUTER_CYCLE_TRACE: OuterCycleTraceDebug = {
  strategy: "left-face-ccw-multi-seed-largest-component",
  attempted: false,
  found: false,
  closed: false,
  hitStepLimit: false,
  maxSteps: 100_000,
  stepCount: 0,
  cycleVertexCount: 0,
  cyclePerimeterPt: 0,
  cycleSignedAreaPt2: 0,
  stepsMatchedToCleanedSegments: 0,
  stepSupportFraction: 0,
  startNodeIndex: -1,
  startDirectedTo: -1,
  vertexSample: [],
  notes: [],
  multiSeed: {
    maxDirectedSeeds: 0,
    directedSeedsTried: 0,
    uniqueCycleKeys: 0,
    uniqueClosedCycles: 0,
  },
  candidateSummariesTop: [],
  selectedCandidateRank: 0,
  selectedExteriorScaleHint: "uncertain",
}

function nodeKey(x: number, y: number, q: number): string {
  const ix = Math.round(x / q)
  const iy = Math.round(y / q)
  return `${ix},${iy}`
}

function dist2(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx
  const dy = ay - by
  return dx * dx + dy * dy
}

/** Andrew monotone chain; returns CCW hull without repeating first point at end. */
function convexHull(points: Array<{ x: number; y: number }>): Array<{ x: number; y: number }> {
  if (points.length < 3) return points.slice()
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y)
  const cross = (
    o: { x: number; y: number },
    a: { x: number; y: number },
    b: { x: number; y: number }
  ) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const lower: typeof pts = []
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop()
    }
    lower.push(p)
  }
  const upper: typeof pts = []
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop()
    }
    upper.push(p)
  }
  upper.pop()
  lower.pop()
  return lower.concat(upper)
}

function polygonPerimeter(pts: Array<{ x: number; y: number }>): number {
  if (pts.length < 2) return 0
  if (pts.length === 2) {
    return 2 * Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y)
  }
  let s = 0
  const n = pts.length
  for (let i = 0; i < n; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % n]
    s += Math.hypot(b.x - a.x, b.y - a.y)
  }
  return s
}

function polygonAreaAbs(pts: Array<{ x: number; y: number }>): number {
  if (pts.length < 3) return 0
  let a = 0
  const n = pts.length
  for (let i = 0; i < n; i++) {
    const p = pts[i]
    const q = pts[(i + 1) % n]
    a += p.x * q.y - q.x * p.y
  }
  return Math.abs(a / 2)
}

function bboxOfPoints(pts: Array<{ x: number; y: number }>): {
  minX: number
  maxX: number
  minY: number
  maxY: number
  width: number
  height: number
  area: number
} {
  if (pts.length === 0) {
    return { minX: 0, maxX: 0, minY: 0, maxY: 0, width: 0, height: 0, area: 0 }
  }
  let minX = pts[0].x
  let maxX = pts[0].x
  let minY = pts[0].y
  let maxY = pts[0].y
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i]
    minX = Math.min(minX, p.x)
    maxX = Math.max(maxX, p.x)
    minY = Math.min(minY, p.y)
    maxY = Math.max(maxY, p.y)
  }
  const width = maxX - minX
  const height = maxY - minY
  return { minX, maxX, minY, maxY, width, height, area: width * height }
}

function segmentMatchesHullEdge(
  s: ExtractedLineSegment,
  hx0: number,
  hy0: number,
  hx1: number,
  hy1: number,
  tol2: number
): boolean {
  const okFwd = dist2(s.x1, s.y1, hx0, hy0) <= tol2 && dist2(s.x2, s.y2, hx1, hy1) <= tol2
  const okRev = dist2(s.x1, s.y1, hx1, hy1) <= tol2 && dist2(s.x2, s.y2, hx0, hy0) <= tol2
  return okFwd || okRev
}

function plausibilityScore(input: {
  nodeFraction: number
  edgeFraction: number
  bboxAreaFraction: number
  largestAvgDegree: number
}): "high" | "medium" | "low" {
  const { nodeFraction, edgeFraction, bboxAreaFraction, largestAvgDegree } = input
  if (nodeFraction >= 0.45 && edgeFraction >= 0.35 && bboxAreaFraction >= 0.45 && largestAvgDegree >= 2) return "high"
  if (nodeFraction >= 0.25 && edgeFraction >= 0.2 && bboxAreaFraction >= 0.25) return "medium"
  return "low"
}

/**
 * Build wall graph stats + largest-component convex-hull heuristic + left-face outer-cycle trace (debug).
 */
export function buildWallGraphFoundationFromCleaned(
  cleanedWallLines: ExtractedLineSegment[],
  opts?: WallGraphFoundationOptions
): WallGraphDebugPayload {
  const q = opts?.nodeMergeQuantizationPt ?? DEFAULTS.nodeMergeQuantizationPt
  const matchTol = opts?.hullSegmentMatchTolPt ?? DEFAULTS.hullSegmentMatchTolPt
  const matchTol2 = matchTol * matchTol

  if (cleanedWallLines.length === 0) {
    return {
      nodeMergeQuantizationPt: q,
      hullSegmentMatchTolPt: matchTol,
      nodeCount: 0,
      segmentEdgeCount: 0,
      graphUniqueEdgeCount: 0,
      averageDegree: 0,
      danglingEndpointCount: 0,
      connectedComponentCount: 0,
      components: [],
      largestComponent: {
        id: -1,
        nodeCount: 0,
        segmentCount: 0,
        graphUniqueEdgeCount: 0,
        averageDegree: 0,
        plausibility: "low",
        nodeFraction: 0,
        segmentFraction: 0,
        bboxAreaFraction: 0,
        bbox: { minX: 0, maxX: 0, minY: 0, maxY: 0, widthPt: 0, heightPt: 0, areaPt2: 0 },
      },
      outerBoundaryCandidate: {
        strategy: "convex-hull-largest-component",
        hullVertexCount: 0,
        hullPerimeterPt: 0,
        hullAreaPt2: 0,
        hullEdgesMatchedToSegments: 0,
        hullVerticesSample: [],
        notes: ["No cleaned segments — run PDF extraction and cleanup first."],
      },
      outerCycleTrace: {
        ...EMPTY_OUTER_CYCLE_TRACE,
        notes: ["No cleaned segments — outer cycle not traced."],
      },
    }
  }

  /** key -> centroid */
  const accum = new Map<string, { sx: number; sy: number; c: number }>()
  function ingest(x: number, y: number): void {
    const k = nodeKey(x, y, q)
    const z = accum.get(k) ?? { sx: 0, sy: 0, c: 0 }
    z.sx += x
    z.sy += y
    z.c++
    accum.set(k, z)
  }
  for (const s of cleanedWallLines) {
    ingest(s.x1, s.y1)
    ingest(s.x2, s.y2)
  }

  const keys = [...accum.keys()]
  const keyToIdx = new Map<string, number>()
  const idxToPos: Array<{ x: number; y: number }> = []
  for (let i = 0; i < keys.length; i++) {
    keyToIdx.set(keys[i], i)
    const z = accum.get(keys[i])!
    idxToPos.push({ x: z.sx / z.c, y: z.sy / z.c })
  }

  const nNodes = idxToPos.length
  const adj: number[][] = Array.from({ length: nNodes }, () => [])
  const edgePairSet = new Set<string>()
  let duplicateParallelSegments = 0

  for (const s of cleanedWallLines) {
    const k0 = nodeKey(s.x1, s.y1, q)
    const k1 = nodeKey(s.x2, s.y2, q)
    if (k0 === k1) continue
    const i0 = keyToIdx.get(k0)!
    const i1 = keyToIdx.get(k1)!
    const a = Math.min(i0, i1)
    const b = Math.max(i0, i1)
    const pairKey = `${a}-${b}`
    if (edgePairSet.has(pairKey)) duplicateParallelSegments++
    edgePairSet.add(pairKey)
    adj[i0].push(i1)
    adj[i1].push(i0)
  }

  const uniqueEdgeCount = edgePairSet.size
  const segmentEdgeCount = cleanedWallLines.filter((s) => {
    const k0 = nodeKey(s.x1, s.y1, q)
    const k1 = nodeKey(s.x2, s.y2, q)
    return k0 !== k1
  }).length

  const degree = adj.map((nei) => nei.length)
  const sumDeg = degree.reduce((s, d) => s + d, 0)
  const avgDeg = nNodes > 0 ? sumDeg / nNodes : 0
  const dangling = degree.filter((d) => d === 1).length

  const visited = new Uint8Array(nNodes)
  const components: Array<{ id: number; nodes: number[]; edges: number }> = []
  let compId = 0

  for (let s = 0; s < nNodes; s++) {
    if (visited[s]) continue
    const stack = [s]
    visited[s] = 1
    const nodes: number[] = []
    let edgeTouch = 0
    while (stack.length) {
      const u = stack.pop()!
      nodes.push(u)
      edgeTouch += adj[u].length
      for (const v of adj[u]) {
        if (!visited[v]) {
          visited[v] = 1
          stack.push(v)
        }
      }
    }
    /** each undirected edge counted twice in edgeTouch */
    const edgeCountUndir = edgeTouch / 2
    components.push({ id: compId++, nodes, edges: edgeCountUndir })
  }

  components.sort((a, b) => b.nodes.length - a.nodes.length || b.edges - a.edges)

  const globalBbox = bboxOfPoints(idxToPos)

  let largest = components[0] ?? { id: -1, nodes: [] as number[], edges: 0 }
  const lNodes = largest.nodes
  const lSet = new Set(lNodes)
  const lcPoints = lNodes.map((i) => idxToPos[i])
  const lcBbox = bboxOfPoints(lcPoints)

  const segmentCountInLargest = cleanedWallLines.filter((s) => {
    const k0 = nodeKey(s.x1, s.y1, q)
    const k1 = nodeKey(s.x2, s.y2, q)
    if (k0 === k1) return false
    return lSet.has(keyToIdx.get(k0)!) && lSet.has(keyToIdx.get(k1)!)
  }).length

  const subAdj = lNodes.map(() => [] as number[])
  const lIndex = new Map<number, number>()
  lNodes.forEach((g, j) => lIndex.set(g, j))
  const lEdgeSet = new Set<string>()
  for (const s of cleanedWallLines) {
    const k0 = nodeKey(s.x1, s.y1, q)
    const k1 = nodeKey(s.x2, s.y2, q)
    if (k0 === k1) continue
    const i0 = keyToIdx.get(k0)!
    const i1 = keyToIdx.get(k1)!
    if (!lSet.has(i0) || !lSet.has(i1)) continue
    const a = Math.min(i0, i1)
    const b = Math.max(i0, i1)
    lEdgeSet.add(`${a}-${b}`)
    const j0 = lIndex.get(i0)!
    const j1 = lIndex.get(i1)!
    subAdj[j0].push(j1)
    subAdj[j1].push(j0)
  }
  const lcUniqueEdges = lEdgeSet.size
  const lcSumDeg = subAdj.reduce((s, a) => s + a.length, 0)
  const lcAvgDeg = lNodes.length > 0 ? lcSumDeg / lNodes.length : 0

  const nodeFraction = nNodes > 0 ? lNodes.length / nNodes : 0
  const segmentFraction = segmentEdgeCount > 0 ? segmentCountInLargest / segmentEdgeCount : 0
  const bboxAreaFraction =
    globalBbox.area > 1e-9 ? Math.min(1, lcBbox.area / globalBbox.area) : lcBbox.area > 0 ? 1 : 0

  const plaus = plausibilityScore({
    nodeFraction,
    edgeFraction: segmentFraction,
    bboxAreaFraction,
    largestAvgDegree: lcAvgDeg,
  })

  const hull = convexHull(lcPoints)
  const hullPerim = polygonPerimeter(hull)
  const hullArea = polygonAreaAbs(hull)

  const lcSegs = cleanedWallLines.filter((s) => {
    const k0 = nodeKey(s.x1, s.y1, q)
    const k1 = nodeKey(s.x2, s.y2, q)
    if (k0 === k1) return false
    return lSet.has(keyToIdx.get(k0)!) && lSet.has(keyToIdx.get(k1)!)
  })

  const lcAdjFull: number[][] = adj.map((nei, v) =>
    lSet.has(v) ? nei.filter((u) => lSet.has(u)) : []
  )

  const bboxPerim = 2 * (lcBbox.width + lcBbox.height)
  const outerCycleTrace = traceOuterCycleLargestComponent({
    lNodes,
    lcAdj: lcAdjFull,
    idxToPos,
    cleanedWallLinesInLargest: lcSegs,
    matchTolPt: matchTol,
    comparison: {
      hullAreaPt2: hullArea,
      hullPerimeterPt: hullPerim,
      bboxAreaPt2: lcBbox.area,
      bboxPerimeterPt: bboxPerim,
    },
  })

  let hullMatched = 0
  if (hull.length >= 2) {
    for (let i = 0; i < hull.length; i++) {
      const a = hull[i]
      const b = hull[(i + 1) % hull.length]
      for (const s of lcSegs) {
        if (segmentMatchesHullEdge(s, a.x, a.y, b.x, b.y, matchTol2)) {
          hullMatched++
          break
        }
      }
    }
  }

  const hullVertSample = hull.slice(0, Math.min(24, hull.length)).map((p) => ({ x: p.x, y: p.y }))
  const notes: string[] = [
    `Largest component: ${lNodes.length} nodes, ${segmentCountInLargest} incident segments (${lcUniqueEdges} unique node pairs), avg degree ${lcAvgDeg.toFixed(2)}.`,
    `Convex hull is a loose outer envelope — concave unit outlines need cycle tracing / alpha shapes, not hull alone.`,
    `Hull edges overlapping real segments: ${hullMatched}/${hull.length} (tolerance ${matchTol} pt).`,
  ]
  if (components.length > 1) {
    notes.push(
      `${components.length} connected components — interior partitions / furniture islands may be split from shell; tune node merge q=${q} or cleanup before relying on hull.`
    )
  }
  if (duplicateParallelSegments > 0) {
    notes.push(`${duplicateParallelSegments} extra parallel segments map onto already-connected node pairs (multigraph-like); unique topology edges: ${uniqueEdgeCount}.`)
  }

  return {
    nodeMergeQuantizationPt: q,
    hullSegmentMatchTolPt: matchTol,
    nodeCount: nNodes,
    segmentEdgeCount,
    graphUniqueEdgeCount: uniqueEdgeCount,
    averageDegree: avgDeg,
    danglingEndpointCount: dangling,
    connectedComponentCount: components.length,
    components: components.map((c) => ({
      id: c.id,
      nodeCount: c.nodes.length,
      segmentCount: cleanedWallLines.filter((s) => {
        const k0 = nodeKey(s.x1, s.y1, q)
        const k1 = nodeKey(s.x2, s.y2, q)
        if (k0 === k1) return false
        const cset = new Set(c.nodes)
        return cset.has(keyToIdx.get(k0)!) && cset.has(keyToIdx.get(k1)!)
      }).length,
      graphUniqueEdgeCount: c.edges,
    })),
    largestComponent: {
      id: largest.id,
      nodeCount: lNodes.length,
      segmentCount: segmentCountInLargest,
      graphUniqueEdgeCount: lcUniqueEdges,
      averageDegree: lcAvgDeg,
      plausibility: plaus,
      nodeFraction,
      segmentFraction,
      bboxAreaFraction,
      bbox: {
        minX: lcBbox.minX,
        maxX: lcBbox.maxX,
        minY: lcBbox.minY,
        maxY: lcBbox.maxY,
        widthPt: lcBbox.width,
        heightPt: lcBbox.height,
        areaPt2: lcBbox.area,
      },
    },
    outerBoundaryCandidate: {
      strategy: "convex-hull-largest-component",
      hullVertexCount: hull.length,
      hullPerimeterPt: hullPerim,
      hullAreaPt2: hullArea,
      hullEdgesMatchedToSegments: hullMatched,
      hullVerticesSample: hullVertSample,
      notes,
    },
    outerCycleTrace,
  }
}

/** Rank 0/1/2 = largest / second / third connected component by node count; -1 = other or degenerate edge. */
export type WallSegmentTopComponentRank = -1 | 0 | 1 | 2

/**
 * Parallel to `cleanedWallLines`: each segment's component rank after graph build + size sort
 * (same quantization/adjacency as `buildWallGraphFoundationFromCleaned`).
 */
export function computeWallSegmentTopComponentRanks(
  cleanedWallLines: ExtractedLineSegment[],
  opts?: WallGraphFoundationOptions
): WallSegmentTopComponentRank[] {
  const q = opts?.nodeMergeQuantizationPt ?? DEFAULTS.nodeMergeQuantizationPt
  if (cleanedWallLines.length === 0) return []

  const accum = new Map<string, { sx: number; sy: number; c: number }>()
  function ingest(x: number, y: number): void {
    const k = nodeKey(x, y, q)
    const z = accum.get(k) ?? { sx: 0, sy: 0, c: 0 }
    z.sx += x
    z.sy += y
    z.c++
    accum.set(k, z)
  }
  for (const s of cleanedWallLines) {
    ingest(s.x1, s.y1)
    ingest(s.x2, s.y2)
  }

  const keys = [...accum.keys()]
  const keyToIdx = new Map<string, number>()
  for (let i = 0; i < keys.length; i++) keyToIdx.set(keys[i], i)

  const nNodes = keyToIdx.size
  const adj: number[][] = Array.from({ length: nNodes }, () => [])

  for (const s of cleanedWallLines) {
    const k0 = nodeKey(s.x1, s.y1, q)
    const k1 = nodeKey(s.x2, s.y2, q)
    if (k0 === k1) continue
    const i0 = keyToIdx.get(k0)!
    const i1 = keyToIdx.get(k1)!
    adj[i0].push(i1)
    adj[i1].push(i0)
  }

  const visited = new Uint8Array(nNodes)
  const components: Array<{ nodes: number[]; edges: number }> = []

  for (let s = 0; s < nNodes; s++) {
    if (visited[s]) continue
    const stack = [s]
    visited[s] = 1
    const nodes: number[] = []
    let edgeTouch = 0
    while (stack.length) {
      const u = stack.pop()!
      nodes.push(u)
      edgeTouch += adj[u].length
      for (const v of adj[u]) {
        if (!visited[v]) {
          visited[v] = 1
          stack.push(v)
        }
      }
    }
    const edgeCountUndir = edgeTouch / 2
    components.push({ nodes, edges: edgeCountUndir })
  }

  components.sort((a, b) => b.nodes.length - a.nodes.length || b.edges - a.edges)

  const nodeSortedCompIdx = new Array(nNodes).fill(-1)
  for (let ci = 0; ci < components.length; ci++) {
    for (const ni of components[ci].nodes) nodeSortedCompIdx[ni] = ci
  }

  const ranks: WallSegmentTopComponentRank[] = []
  for (const s of cleanedWallLines) {
    const k0 = nodeKey(s.x1, s.y1, q)
    const k1 = nodeKey(s.x2, s.y2, q)
    if (k0 === k1) {
      ranks.push(-1)
      continue
    }
    const i0 = keyToIdx.get(k0)
    const i1 = keyToIdx.get(k1)
    if (i0 == null || i1 == null) {
      ranks.push(-1)
      continue
    }
    const c0 = nodeSortedCompIdx[i0]!
    const c1 = nodeSortedCompIdx[i1]!
    const c = c0 === c1 ? c0 : -1
    ranks.push(c >= 0 && c < 3 ? (c as 0 | 1 | 2) : -1)
  }
  return ranks
}
