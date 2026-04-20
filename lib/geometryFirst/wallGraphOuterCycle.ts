/**
 * Exterior **face** candidates via CCW **left-face** walks on the largest component
 * (planar-ish heuristic; not the convex hull). Multi-seed selection improves outer-face odds.
 */

import type {
  ExtractedLineSegment,
  OuterCycleCandidateSummary,
  OuterCycleTraceDebug,
} from "@/lib/geometryFirst/types"

function dist2(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx
  const dy = ay - by
  return dx * dx + dy * dy
}

function segmentSupportsEdge(
  s: ExtractedLineSegment,
  px: number,
  py: number,
  qx: number,
  qy: number,
  tol2: number
): boolean {
  const okFwd = dist2(s.x1, s.y1, px, py) <= tol2 && dist2(s.x2, s.y2, qx, qy) <= tol2
  const okRev = dist2(s.x1, s.y1, qx, qy) <= tol2 && dist2(s.x2, s.y2, px, py) <= tol2
  return okFwd || okRev
}

/** Neighbors CCW by geometric angle around v (from +x axis). */
function sortedNeighborsCCW(v: number, adjRow: number[], pos: Array<{ x: number; y: number }>): number[] {
  const uniq = [...new Set(adjRow)]
  return uniq.sort((a, b) => {
    const ta = Math.atan2(pos[a].y - pos[v].y, pos[a].x - pos[v].x)
    const tb = Math.atan2(pos[b].y - pos[v].y, pos[b].x - pos[v].x)
    return ta - tb
  })
}

function leftFaceNext(
  u: number,
  v: number,
  lcAdj: number[][],
  pos: Array<{ x: number; y: number }>
): number | null {
  const ring = sortedNeighborsCCW(v, lcAdj[v], pos)
  if (ring.length < 2) return null
  const iu = ring.indexOf(u)
  if (iu < 0) return null
  return ring[(iu + 1) % ring.length]
}

function signedAreaPolygon(verts: Array<{ x: number; y: number }>): number {
  if (verts.length < 3) return 0
  let a = 0
  const n = verts.length
  for (let i = 0; i < n; i++) {
    const p = verts[i]
    const q = verts[(i + 1) % n]
    a += p.x * q.y - q.x * p.y
  }
  return a / 2
}

function perimeterClosed(verts: Array<{ x: number; y: number }>): number {
  if (verts.length < 2) return 0
  let s = 0
  const n = verts.length
  for (let i = 0; i < n; i++) {
    const a = verts[i]
    const b = verts[(i + 1) % n]
    s += Math.hypot(b.x - a.x, b.y - a.y)
  }
  return s
}

function trimCycleNodes(closed: boolean, verts: number[]): number[] {
  if (!closed || verts.length < 2) return verts
  if (verts[0] === verts[verts.length - 1]) return verts.slice(0, -1)
  return verts
}

function compressDups(arr: number[]): number[] {
  const out: number[] = []
  for (const x of arr) {
    if (out.length === 0 || out[out.length - 1] !== x) out.push(x)
  }
  return out
}

/** Normalize cycle for dedup: smallest lexicographic string over rotations and reversal. */
function canonicalCycleKey(cycleNodes: number[]): string {
  if (cycleNodes.length < 2) return cycleNodes.join(",")
  const n = cycleNodes.length
  const variants: string[] = []
  for (let i = 0; i < n; i++) {
    const fwd = [...cycleNodes.slice(i), ...cycleNodes.slice(0, i)].join(",")
    const rev = [...cycleNodes].reverse()
    const revRot = [...rev.slice(i), ...rev.slice(0, i)].join(",")
    variants.push(fwd, revRot)
  }
  variants.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return variants[0]!
}

type ComparisonContext = {
  hullAreaPt2: number
  hullPerimeterPt: number
  bboxAreaPt2: number
  bboxPerimeterPt: number
}

function exteriorScaleHint(input: {
  closed: boolean
  absArea: number
  hullArea: number
  bboxArea: number
}): OuterCycleCandidateSummary["exteriorScaleHint"] {
  if (!input.closed) return "uncertain"
  const { absArea, hullArea, bboxArea } = input
  const rHull = hullArea > 1e-9 ? absArea / hullArea : null
  const rBox = bboxArea > 1e-9 ? absArea / bboxArea : null
  if (rHull !== null && rHull < 0.08) return "interior-scale"
  if (rHull !== null && rHull > 0.28) return "exterior-scale"
  if (rBox !== null && rBox > 0.5) return "exterior-scale"
  if (rHull !== null && rHull >= 0.08 && rHull <= 0.28) return "uncertain"
  return "uncertain"
}

function buildSummary(
  input: {
    rank: number
    startU: number
    startV: number
    closed: boolean
    hitStepLimit: boolean
    steps: number
    matched: number
    cycleNodes: number[]
    cycleSignedAreaPt2: number
    cyclePerimeterPt: number
    pos: Array<{ x: number; y: number }>
  },
  cmp: ComparisonContext | undefined
): OuterCycleCandidateSummary {
  const absA = Math.abs(input.cycleSignedAreaPt2)
  const hullA = cmp?.hullAreaPt2 ?? 0
  const hullP = cmp?.hullPerimeterPt ?? 0
  const boxA = cmp?.bboxAreaPt2 ?? 0
  const boxP = cmp?.bboxPerimeterPt ?? 0
  const perim = input.cyclePerimeterPt
  const sup = input.steps > 0 ? input.matched / input.steps : 0

  return {
    rank: input.rank,
    startNodeIndex: input.startU,
    startDirectedTo: input.startV,
    closed: input.closed,
    hitStepLimit: input.hitStepLimit,
    stepCount: input.steps,
    cycleVertexCount: input.cycleNodes.length,
    cyclePerimeterPt: perim,
    cycleSignedAreaPt2: input.cycleSignedAreaPt2,
    cycleAbsAreaPt2: absA,
    stepsMatchedToCleanedSegments: input.matched,
    stepSupportFraction: sup,
    areaRatioVsConvexHull: hullA > 1e-9 ? absA / hullA : null,
    areaRatioVsLargestBbox: boxA > 1e-9 ? absA / boxA : null,
    perimeterRatioVsHull: hullP > 1e-9 ? perim / hullP : null,
    perimeterRatioVsBbox: boxP > 1e-9 ? perim / boxP : null,
    exteriorScaleHint: exteriorScaleHint({
      closed: input.closed,
      absArea: absA,
      hullArea: hullA,
      bboxArea: boxA,
    }),
    vertexSample: input.cycleNodes
      .slice(0, 12)
      .map((i) => ({ x: input.pos[i].x, y: input.pos[i].y })),
  }
}

type SingleTrace = {
  startU: number
  startV: number
  closed: boolean
  hitStepLimit: boolean
  steps: number
  matched: number
  cycleNodes: number[]
  cycleSignedAreaPt2: number
  cyclePerimeterPt: number
  stoppedAtJunction: boolean
}

function traceLeftFaceOnce(
  startU: number,
  startV: number,
  lcAdj: number[][],
  pos: Array<{ x: number; y: number }>,
  cleanedWallLinesInLargest: ExtractedLineSegment[],
  tol2: number,
  maxSteps: number
): SingleTrace {
  let u = startU
  let v = startV
  const verts: number[] = [startU]
  let steps = 0
  let matched = 0
  let closed = false

  while (steps < maxSteps) {
    const px = pos[u].x
    const py = pos[u].y
    const qx = pos[v].x
    const qy = pos[v].y
    for (const s of cleanedWallLinesInLargest) {
      if (segmentSupportsEdge(s, px, py, qx, qy, tol2)) {
        matched++
        break
      }
    }

    const w = leftFaceNext(u, v, lcAdj, pos)
    if (w === null) {
      const cycleNodes = compressDups(trimCycleNodes(false, verts))
      return {
        startU,
        startV,
        closed: false,
        hitStepLimit: false,
        steps,
        matched,
        cycleNodes,
        cycleSignedAreaPt2: 0,
        cyclePerimeterPt: 0,
        stoppedAtJunction: true,
      }
    }
    verts.push(v)
    u = v
    v = w
    steps++
    if (u === startU && v === startV) {
      closed = true
      break
    }
  }

  const hitStepLimit = steps >= maxSteps && !closed
  const trim = compressDups(trimCycleNodes(closed, verts))
  const cyclePts = trim.map((i) => pos[i])
  const perim = closed && cyclePts.length >= 2 ? perimeterClosed(cyclePts) : 0
  const area = closed ? signedAreaPolygon(cyclePts) : 0

  return {
    startU,
    startV,
    closed,
    hitStepLimit,
    steps,
    matched,
    cycleNodes: trim,
    cycleSignedAreaPt2: area,
    cyclePerimeterPt: perim,
    stoppedAtJunction: false,
  }
}

function isBetterTrace(a: SingleTrace, b: SingleTrace): boolean {
  if (a.closed !== b.closed) return a.closed
  const sa = a.steps > 0 ? a.matched / a.steps : 0
  const sb = b.steps > 0 ? b.matched / b.steps : 0
  if (Math.abs(sa - sb) > 1e-9) return sa > sb
  return Math.abs(a.cycleSignedAreaPt2) > Math.abs(b.cycleSignedAreaPt2)
}

function directedSeeds(
  lNodes: number[],
  lcAdj: number[][],
  pos: Array<{ x: number; y: number }>,
  maxSeeds: number
): Array<[number, number]> {
  const out: Array<[number, number]> = []
  const nodes = [...lNodes].sort((a, b) => a - b)
  outer: for (const u of nodes) {
    const ring = sortedNeighborsCCW(u, lcAdj[u], pos)
    for (const v of ring) {
      out.push([u, v])
      if (out.length >= maxSeeds) break outer
    }
  }
  return out
}

function sortKeyForDisplay(t: SingleTrace): [number, number, number, number] {
  const sup = t.steps > 0 ? t.matched / t.steps : 0
  return [t.closed ? 1 : 0, sup, Math.abs(t.cycleSignedAreaPt2), -t.startU]
}

export function traceOuterCycleLargestComponent(input: {
  lNodes: number[]
  lcAdj: number[][]
  idxToPos: Array<{ x: number; y: number }>
  cleanedWallLinesInLargest: ExtractedLineSegment[]
  matchTolPt: number
  maxSteps?: number
  /** Try up to this many directed edges (u→v) as left-face seeds; default 400 */
  maxDirectedSeeds?: number
  /** Hull + bbox of largest component for plausibility ratios (optional but recommended) */
  comparison?: ComparisonContext
}): OuterCycleTraceDebug {
  const maxSteps = input.maxSteps ?? 100_000
  const maxDirectedSeeds = input.maxDirectedSeeds ?? 400
  const tol2 = input.matchTolPt * input.matchTolPt
  const pos = input.idxToPos
  const lcAdj = input.lcAdj
  const cmp = input.comparison

  const emptyMulti = {
    maxDirectedSeeds,
    directedSeedsTried: 0,
    uniqueCycleKeys: 0,
    uniqueClosedCycles: 0,
  }

  if (input.lNodes.length < 2) {
    return {
      strategy: "left-face-ccw-multi-seed-largest-component",
      attempted: false,
      found: false,
      closed: false,
      hitStepLimit: false,
      maxSteps,
      stepCount: 0,
      cycleVertexCount: 0,
      cyclePerimeterPt: 0,
      cycleSignedAreaPt2: 0,
      stepsMatchedToCleanedSegments: 0,
      stepSupportFraction: 0,
      startNodeIndex: -1,
      startDirectedTo: -1,
      vertexSample: [],
      fullVertexCycle: undefined,
      notes: ["Largest component has fewer than 2 nodes — cannot trace a cycle."],
      multiSeed: emptyMulti,
      candidateSummariesTop: [],
      selectedCandidateRank: 0,
      selectedExteriorScaleHint: "uncertain",
    }
  }

  const seeds = directedSeeds(input.lNodes, lcAdj, pos, maxDirectedSeeds)

  /** canonical key → best trace for that geometry */
  const bestByKey = new Map<string, SingleTrace>()
  const openTraces: SingleTrace[] = []

  for (const [su, sv] of seeds) {
    const tr = traceLeftFaceOnce(su, sv, lcAdj, pos, input.cleanedWallLinesInLargest, tol2, maxSteps)
    if (tr.closed && tr.cycleNodes.length >= 3) {
      const key = canonicalCycleKey(tr.cycleNodes)
      const prev = bestByKey.get(key)
      if (!prev || isBetterTrace(tr, prev)) bestByKey.set(key, tr)
    } else if (!tr.stoppedAtJunction && tr.hitStepLimit) {
      openTraces.push(tr)
    } else if (tr.stoppedAtJunction && tr.steps > 0) {
      openTraces.push(tr)
    }
  }

  const closedList = [...bestByKey.values()]
  const uniqueClosed = closedList.length

  closedList.sort((a, b) => {
    const ka = sortKeyForDisplay(a)
    const kb = sortKeyForDisplay(b)
    for (let i = 0; i < ka.length; i++) {
      if (ka[i] !== kb[i]) return kb[i] - ka[i]
    }
    return 0
  })

  openTraces.sort((a, b) => {
    const sa = a.steps > 0 ? a.matched / a.steps : 0
    const sb = b.steps > 0 ? b.matched / b.steps : 0
    if (Math.abs(sa - sb) > 1e-9) return sb - sa
    return b.steps - a.steps
  })

  const topOpen = openTraces.slice(0, Math.max(0, 8 - closedList.length))
  const mergedForSummaries: SingleTrace[] = [...closedList, ...topOpen].slice(0, 8)

  const candidateSummariesTop: OuterCycleCandidateSummary[] = mergedForSummaries.map((t, i) =>
    buildSummary(
      {
        rank: i + 1,
        startU: t.startU,
        startV: t.startV,
        closed: t.closed,
        hitStepLimit: t.hitStepLimit,
        steps: t.steps,
        matched: t.matched,
        cycleNodes: t.cycleNodes,
        cycleSignedAreaPt2: t.cycleSignedAreaPt2,
        cyclePerimeterPt: t.cyclePerimeterPt,
        pos,
      },
      cmp
    )
  )

  const winner = closedList[0] ?? openTraces[0] ?? null

  if (!winner) {
    const tried = seeds.length
    return {
      strategy: "left-face-ccw-multi-seed-largest-component",
      attempted: true,
      found: false,
      closed: false,
      hitStepLimit: false,
      maxSteps,
      stepCount: 0,
      cycleVertexCount: 0,
      cyclePerimeterPt: 0,
      cycleSignedAreaPt2: 0,
      stepsMatchedToCleanedSegments: 0,
      stepSupportFraction: 0,
      startNodeIndex: seeds[0]?.[0] ?? -1,
      startDirectedTo: seeds[0]?.[1] ?? -1,
      vertexSample: [],
      fullVertexCycle: undefined,
      notes: [
        `Multi-seed left-face: tried ${tried} directed starts, no usable cycle (unique closed geometries: ${uniqueClosed}).`,
      ],
      multiSeed: {
        maxDirectedSeeds,
        directedSeedsTried: tried,
        uniqueCycleKeys: bestByKey.size,
        uniqueClosedCycles: uniqueClosed,
      },
      candidateSummariesTop,
      selectedCandidateRank: 0,
      selectedExteriorScaleHint: "uncertain",
    }
  }

  const wSup = winner.steps > 0 ? winner.matched / winner.steps : 0
  const wPts = winner.cycleNodes.map((i) => pos[i])
  const fullVertexCycle =
    winner.closed && winner.cycleNodes.length >= 3
      ? winner.cycleNodes.slice(0, 512).map((i) => ({ x: pos[i].x, y: pos[i].y }))
      : undefined
  const rankOfWinner =
    candidateSummariesTop.findIndex(
      (s) =>
        s.startNodeIndex === winner.startU &&
        s.startDirectedTo === winner.startV &&
        s.closed === winner.closed
    ) + 1

  const selectedHint = buildSummary(
    {
      rank: 1,
      startU: winner.startU,
      startV: winner.startV,
      closed: winner.closed,
      hitStepLimit: winner.hitStepLimit,
      steps: winner.steps,
      matched: winner.matched,
      cycleNodes: winner.cycleNodes,
      cycleSignedAreaPt2: winner.cycleSignedAreaPt2,
      cyclePerimeterPt: winner.cyclePerimeterPt,
      pos,
    },
    cmp
  ).exteriorScaleHint

  const notes: string[] = [
    `Multi-seed: ${seeds.length} directed starts (cap ${maxDirectedSeeds}), ${uniqueClosed} unique closed cycle(s), ${bestByKey.size} canonical key(s). Selected walk: closed=${winner.closed}, support ${(wSup * 100).toFixed(1)}%, |area| ${Math.abs(winner.cycleSignedAreaPt2).toFixed(0)} pt², perimeter ${winner.cyclePerimeterPt.toFixed(1)} pt.`,
    `Exterior-scale hint (heuristic): ${selectedHint} — compare areaRatioVsConvexHull / areaRatioVsLargestBbox in candidateSummariesTop.`,
  ]

  if (winner.closed) {
    notes.push(
      `Closed left-face: ${winner.steps} edge steps, ${winner.cycleNodes.length} vertices; signed area ${winner.cycleSignedAreaPt2.toFixed(0)} pt².`
    )
    if (winner.cycleSignedAreaPt2 <= 0) {
      notes.push("Signed area ≤0 — clockwise or self-crossing polygon in embedding; use |area| only as a loose hint.")
    }
  } else if (winner.hitStepLimit) {
    notes.push(`Best seed did not close within ${maxSteps} steps — try more graph cleanup or raise maxSteps.`)
  } else if (winner.stoppedAtJunction) {
    notes.push("Best seed stopped at a degenerate junction (see open traces in candidateSummariesTop).")
  }

  notes.push(
    `Cleaned-segment support (selected): ${winner.matched}/${winner.steps} (${(wSup * 100).toFixed(1)}%) within ${input.matchTolPt} pt.`
  )
  notes.push(
    "Faces are from the embedded wall graph only — not guaranteed to be the architectural exterior."
  )

  return {
    strategy: "left-face-ccw-multi-seed-largest-component",
    attempted: true,
    found: winner.closed && winner.cycleNodes.length >= 3,
    closed: winner.closed,
    hitStepLimit: winner.hitStepLimit,
    maxSteps,
    stepCount: winner.steps,
    cycleVertexCount: winner.cycleNodes.length,
    cyclePerimeterPt: winner.cyclePerimeterPt,
    cycleSignedAreaPt2: winner.cycleSignedAreaPt2,
    stepsMatchedToCleanedSegments: winner.matched,
    stepSupportFraction: wSup,
    startNodeIndex: winner.startU,
    startDirectedTo: winner.startV,
    vertexSample: wPts.slice(0, 32).map((p) => ({ x: p.x, y: p.y })),
    fullVertexCycle,
    notes,
    multiSeed: {
      maxDirectedSeeds,
      directedSeedsTried: seeds.length,
      uniqueCycleKeys: bestByKey.size,
      uniqueClosedCycles: uniqueClosed,
    },
    candidateSummariesTop,
    selectedCandidateRank: rankOfWinner > 0 ? rankOfWinner : closedList.length > 0 ? 1 : 0,
    selectedExteriorScaleHint: selectedHint,
  }
}
