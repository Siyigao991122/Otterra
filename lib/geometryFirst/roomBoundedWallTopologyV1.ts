import type { RoomLineFaithfulReconstructionV1Debug, RoomLineFaithfulWallRun } from "@/lib/geometryFirst/roomLineFaithfulReconstructionV1"
import type { RoomTextGroupingV1Debug } from "@/lib/geometryFirst/planBodyRoomTextGroupingV1"
import type { HierarchicalSpaceTypingV2Debug } from "@/lib/geometryFirst/planBodyHierarchicalSpaceTypingV2"
import type { ApartmentLayoutPartitionV1Debug } from "@/lib/geometryFirst/apartmentLayoutPartitionV1"
import type { GrayWallMassReconstructionV1Debug } from "@/lib/geometryFirst/grayWallMassReconstructionV1"
import type { FloorplanAiSemanticHintsDebug, PlanBoundingBox } from "@/lib/geometryFirst/types"

type Pt = { x: number; y: number }
type RoomTopologyType = "enclosed_room" | "open_plan_subzone" | "auxiliary_space"
type BoundaryEdgeKind = "solid_wall" | "opening_or_gap" | "shared_wall" | "uncertain_boundary"

interface RoomRangeSpec {
  roomId: string
  label: string
  roomType: RoomTopologyType
  center: Pt
  boundaryPolygon: Pt[]
}

export interface RoomTopologyBoundaryEdgeV1 {
  runId: string
  kind: BoundaryEdgeKind
  x1: number
  y1: number
  x2: number
  y2: number
}

export interface RoomTopologyV1 {
  roomId: string
  label: string
  roomType: RoomTopologyType
  boundaryPolygon: Pt[]
  labelCenter: Pt
  wallRunIds: string[]
  solidWallEdges: RoomTopologyBoundaryEdgeV1[]
  openingEdges: RoomTopologyBoundaryEdgeV1[]
  sharedWallEdges: RoomTopologyBoundaryEdgeV1[]
  uncertainBoundaryEdges: RoomTopologyBoundaryEdgeV1[]
  closedOrNearClosed: boolean
  confidence: number
}

export interface RoomBoundedWallTopologyV1Debug {
  roomBoundedWallTopologyV1: {
    roomCount: number
    enclosedRoomCount: number
    openPlanCount: number
    auxiliaryCount: number
    closedOrNearClosedCount: number
  }
  roomTopologies: RoomTopologyV1[]
  reconstructionStatement: string
  notes: string[]
}

export interface BuildRoomBoundedWallTopologyV1SvgOptions {
  pageBounds: PlanBoundingBox
  topology: RoomBoundedWallTopologyV1Debug
}

const OPT = {
  selectNearBoundary: 18,
  selectNearCenter: 84,
  auxiliaryRadius: 64,
  bboxExpand: 8,
  sideTol: 14,
} as const

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x))
}

function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function bboxOfPoly(poly: Pt[]): PlanBoundingBox {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of poly) {
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x)
    maxY = Math.max(maxY, p.y)
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 1, maxY: 1 }
  return { minX, minY, maxX, maxY }
}

function centerOfPoly(poly: Pt[]): Pt {
  if (!poly.length) return { x: 0, y: 0 }
  let sx = 0
  let sy = 0
  for (const p of poly) {
    sx += p.x
    sy += p.y
  }
  return { x: sx / poly.length, y: sy / poly.length }
}

function boxDiagonal(b: PlanBoundingBox): number {
  return Math.hypot(b.maxX - b.minX, b.maxY - b.minY)
}

function expandBox(b: PlanBoundingBox, pad: number): PlanBoundingBox {
  return { minX: b.minX - pad, minY: b.minY - pad, maxX: b.maxX + pad, maxY: b.maxY + pad }
}

function boxToPoly(b: PlanBoundingBox): Pt[] {
  return [
    { x: b.minX, y: b.minY },
    { x: b.maxX, y: b.minY },
    { x: b.maxX, y: b.maxY },
    { x: b.minX, y: b.maxY },
  ]
}

function cleanRoomLabel(label: string): string {
  const tokens = label.replace(/\s+/g, " ").trim().split(" ")
  const firstDimIdx = tokens.findIndex((token, idx) => {
    const t = token.trim()
    if (!/\d/.test(t)) return false
    if (/[’'′"″-]/.test(t)) return true
    const next = tokens[idx + 1]?.trim().toLowerCase()
    return next === "x"
  })
  return (firstDimIdx > 0 ? tokens.slice(0, firstDimIdx) : tokens).join(" ").trim()
}

function pointInPoly(pt: Pt, poly: Pt[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!
    const b = poly[j]!
    const intersect =
      a.y > pt.y !== b.y > pt.y &&
      pt.x < ((b.x - a.x) * (pt.y - a.y)) / Math.max(1e-6, b.y - a.y) + a.x
    if (intersect) inside = !inside
  }
  return inside
}

function distancePointToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const denom = dx * dx + dy * dy
  if (denom < 1e-6) return dist(p, a)
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / denom))
  return dist(p, { x: a.x + t * dx, y: a.y + t * dy })
}

function distanceSegmentToPolyBoundary(run: RoomLineFaithfulWallRun, poly: Pt[]): number {
  const pts = [
    { x: run.x1, y: run.y1 },
    { x: run.x2, y: run.y2 },
    { x: (run.x1 + run.x2) / 2, y: (run.y1 + run.y2) / 2 },
  ]
  let best = Infinity
  for (const p of pts) {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!
      const b = poly[(i + 1) % poly.length]!
      best = Math.min(best, distancePointToSegment(p, a, b))
    }
  }
  return best
}

function buildAuxiliaryPolygon(center: Pt, wallRuns: RoomLineFaithfulWallRun[], unitBox: PlanBoundingBox): Pt[] {
  const near = wallRuns.filter((run) => {
    const mx = (run.x1 + run.x2) / 2
    const my = (run.y1 + run.y2) / 2
    return dist(center, { x: mx, y: my }) <= OPT.auxiliaryRadius
  })
  if (!near.length) {
    const box = expandBox(
      {
        minX: center.x - 18,
        minY: center.y - 18,
        maxX: center.x + 18,
        maxY: center.y + 18,
      },
      0
    )
    return boxToPoly({
      minX: Math.max(unitBox.minX, box.minX),
      minY: Math.max(unitBox.minY, box.minY),
      maxX: Math.min(unitBox.maxX, box.maxX),
      maxY: Math.min(unitBox.maxY, box.maxY),
    })
  }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const run of near) {
    minX = Math.min(minX, run.x1, run.x2)
    minY = Math.min(minY, run.y1, run.y2)
    maxX = Math.max(maxX, run.x1, run.x2)
    maxY = Math.max(maxY, run.y1, run.y2)
  }
  return boxToPoly({
    minX: Math.max(unitBox.minX, minX - OPT.bboxExpand),
    minY: Math.max(unitBox.minY, minY - OPT.bboxExpand),
    maxX: Math.min(unitBox.maxX, maxX + OPT.bboxExpand),
    maxY: Math.min(unitBox.maxY, maxY + OPT.bboxExpand),
  })
}

function pickMaskVoidPolygon(
  center: Pt,
  grayWallMass: GrayWallMassReconstructionV1Debug | undefined,
  fallback: Pt[],
  roomType: RoomTopologyType
): Pt[] {
  const candidates = (grayWallMass?.recoveredRoomVoids ?? []).filter((v) =>
    roomType === "open_plan_subzone" ? true : v.roomLike
  )
  if (!candidates.length) return fallback
  const containing = candidates.find((v) => pointInPoly(center, v.polygon))
  if (containing) return containing.polygon
  let best = candidates[0]!
  let bestScore = dist(best.center, center)
  for (const candidate of candidates) {
    const score = dist(candidate.center, center)
    if (score < bestScore) {
      bestScore = score
      best = candidate
    }
  }
  return bestScore <= (roomType === "auxiliary_space" ? 64 : 92) ? best.polygon : fallback
}

function deriveRoomBoundaryFromRuns(spec: RoomRangeSpec, selectedRuns: RoomLineFaithfulWallRun[]): Pt[] {
  if (spec.roomType === "open_plan_subzone") return spec.boundaryPolygon
  const strong = selectedRuns.filter(
    (run) => run.wallClass === "exterior_wall" || run.wallClass === "interior_wall"
  )
  if (strong.length < 3) return spec.boundaryPolygon

  const verticals = strong.filter((run) => Math.abs(run.x1 - run.x2) <= Math.abs(run.y1 - run.y2))
  const horizontals = strong.filter((run) => Math.abs(run.y1 - run.y2) < Math.abs(run.x1 - run.x2))
  const cx = spec.center.x
  const cy = spec.center.y

  let left = -Infinity
  let right = Infinity
  let top = -Infinity
  let bottom = Infinity

  for (const run of verticals) {
    const x = (run.x1 + run.x2) / 2
    const midY = (run.y1 + run.y2) / 2
    if (Math.abs(midY - cy) > 120) continue
    if (x <= cx && x > left) left = x
    if (x >= cx && x < right) right = x
  }
  for (const run of horizontals) {
    const y = (run.y1 + run.y2) / 2
    const midX = (run.x1 + run.x2) / 2
    if (Math.abs(midX - cx) > 140) continue
    if (y <= cy && y > top) top = y
    if (y >= cy && y < bottom) bottom = y
  }

  if (!Number.isFinite(left) || !Number.isFinite(right) || !Number.isFinite(top) || !Number.isFinite(bottom) || right - left < 16 || bottom - top < 16) {
    const b = bboxOfPoly(
      strong.flatMap((run) => [
        { x: run.x1, y: run.y1 },
        { x: run.x2, y: run.y2 },
      ])
    )
    return boxToPoly(expandBox(b, 4))
  }

  return boxToPoly({
    minX: left,
    minY: top,
    maxX: right,
    maxY: bottom,
  })
}

function buildRoomSpecs(
  faithful: RoomLineFaithfulReconstructionV1Debug,
  grouping: RoomTextGroupingV1Debug,
  typing: HierarchicalSpaceTypingV2Debug,
  effectiveUnitPolygon: Pt[],
  layoutPartition?: ApartmentLayoutPartitionV1Debug,
  _aiHints?: FloorplanAiSemanticHintsDebug,
  grayWallMass?: GrayWallMassReconstructionV1Debug
): RoomRangeSpec[] {
  const specs: RoomRangeSpec[] = []
  const unitBox = bboxOfPoly(effectiveUnitPolygon)
  const layoutById = new Map((layoutPartition?.layoutRegions ?? []).map((r) => [r.regionId, r]))

  for (const cand of typing.enclosedRoomCandidates) {
    const anchor = typing.enclosedRoomAnchors.find((a) => a.anchorId === cand.anchorId)
    const layout = layoutById.get(cand.anchorId)
    const fallbackPoly = (layout?.polygon ?? cand.polygon).map((p) => ({ x: p.x, y: p.y }))
    const center = anchor ? { x: anchor.x, y: anchor.y } : centerOfPoly(fallbackPoly)
    specs.push({
      roomId: cand.anchorId,
      label: cleanRoomLabel(layout?.label ?? anchor?.displayLabel ?? cand.normalizedLabel),
      roomType: "enclosed_room",
      center,
      boundaryPolygon: pickMaskVoidPolygon(center, grayWallMass, fallbackPoly, "enclosed_room"),
    })
  }

  for (const sub of typing.openPlanSubzoneAnchors) {
    const assignment = typing.subzoneAssignments.find((a) => a.anchorId === sub.anchorId)
    const env = typing.openPlanEnvelopeCandidates.find((e) => e.envelopeId === assignment?.envelopeId) ?? typing.openPlanEnvelopeCandidates[0]
    if (!env) continue
    const layout = layoutById.get(sub.anchorId)
    const fallbackPoly = (layout?.polygon ?? env.polygon).map((p) => ({ x: p.x, y: p.y }))
    specs.push({
      roomId: sub.anchorId,
      label: cleanRoomLabel(layout?.label ?? sub.displayLabel),
      roomType: "open_plan_subzone",
      center: { x: sub.x, y: sub.y },
      boundaryPolygon: pickMaskVoidPolygon({ x: sub.x, y: sub.y }, grayWallMass, fallbackPoly, "open_plan_subzone"),
    })
  }

  for (const aux of typing.auxiliaryAnchors) {
    const group = grouping.labelGroups.find((g) => g.groupId === aux.groupId)
    const label = cleanRoomLabel(group?.joinedLabel ?? aux.displayLabel ?? aux.normalizedLabel)
    const layout = layoutById.get(aux.groupId)
    const fallbackPoly = (layout?.polygon ?? buildAuxiliaryPolygon({ x: aux.centerX, y: aux.centerY }, faithful.wallRuns, unitBox)).map((p) => ({ x: p.x, y: p.y }))
    specs.push({
      roomId: aux.groupId,
      label: layout?.label ?? label,
      roomType: "auxiliary_space",
      center: { x: aux.centerX, y: aux.centerY },
      boundaryPolygon: pickMaskVoidPolygon({ x: aux.centerX, y: aux.centerY }, grayWallMass, fallbackPoly, "auxiliary_space"),
    })
  }

  return specs
}

function selectWallRunsForRoom(spec: RoomRangeSpec, runs: RoomLineFaithfulWallRun[]): RoomLineFaithfulWallRun[] {
  const rawBox = bboxOfPoly(spec.boundaryPolygon)
  const box = expandBox(rawBox, OPT.bboxExpand)
  const centerLimit =
    spec.roomType === "open_plan_subzone"
      ? OPT.selectNearCenter
      : Math.max(34, Math.min(96, boxDiagonal(rawBox) * 0.45))
  return runs.filter((run) => {
    const a = { x: run.x1, y: run.y1 }
    const b = { x: run.x2, y: run.y2 }
    const mid = { x: (run.x1 + run.x2) / 2, y: (run.y1 + run.y2) / 2 }
    const inBox =
      Math.max(run.x1, run.x2) >= box.minX &&
      Math.min(run.x1, run.x2) <= box.maxX &&
      Math.max(run.y1, run.y2) >= box.minY &&
      Math.min(run.y1, run.y2) <= box.maxY
    if (!inBox) return false
    const centerNear = dist(mid, spec.center) <= centerLimit
    if (pointInPoly(mid, spec.boundaryPolygon)) return true
    if ((pointInPoly(a, spec.boundaryPolygon) || pointInPoly(b, spec.boundaryPolygon)) && centerNear) return true
    const boundaryDist = distanceSegmentToPolyBoundary(run, spec.boundaryPolygon)
    if (boundaryDist <= OPT.selectNearBoundary && centerNear) return true
    if (
      boundaryDist <= OPT.selectNearBoundary &&
      (run.wallClass === "exterior_wall" || run.wallClass === "interior_wall") &&
      (spec.roomType !== "open_plan_subzone" || run.length >= 18)
    ) {
      return true
    }
    return spec.roomType === "open_plan_subzone" && centerNear
  })
}

function buildBoundaryEdge(run: RoomLineFaithfulWallRun, kind: BoundaryEdgeKind): RoomTopologyBoundaryEdgeV1 {
  return { runId: run.id, kind, x1: run.x1, y1: run.y1, x2: run.x2, y2: run.y2 }
}

function closureScore(spec: RoomRangeSpec, selected: RoomLineFaithfulWallRun[]): { closedOrNearClosed: boolean; sideCoverage: number } {
  const box = bboxOfPoly(spec.boundaryPolygon)
  let left = 0
  let right = 0
  let top = 0
  let bottom = 0
  for (const run of selected) {
    const mx = (run.x1 + run.x2) / 2
    const my = (run.y1 + run.y2) / 2
    const horizontal = Math.abs(run.y1 - run.y2) <= Math.abs(run.x1 - run.x2)
    if (!horizontal) {
      if (Math.abs(mx - box.minX) <= OPT.sideTol) left = 1
      if (Math.abs(mx - box.maxX) <= OPT.sideTol) right = 1
    } else {
      if (Math.abs(my - box.minY) <= OPT.sideTol) top = 1
      if (Math.abs(my - box.maxY) <= OPT.sideTol) bottom = 1
    }
  }
  const coverage = left + right + top + bottom
  const closedOrNearClosed =
    spec.roomType === "open_plan_subzone" ? coverage >= 2 : coverage >= 3
  return { closedOrNearClosed, sideCoverage: coverage / 4 }
}

function palette(index: number): { stroke: string; fill: string } {
  const colors = [
    ["#2563eb", "rgba(37,99,235,0.08)"],
    ["#16a34a", "rgba(22,163,74,0.08)"],
    ["#7c3aed", "rgba(124,58,237,0.08)"],
    ["#d97706", "rgba(217,119,6,0.08)"],
    ["#dc2626", "rgba(220,38,38,0.08)"],
    ["#0f766e", "rgba(15,118,110,0.08)"],
  ] as const
  const entry = colors[index % colors.length]!
  return { stroke: entry[0], fill: entry[1] }
}

export function buildRoomBoundedWallTopologyV1(
  faithful: RoomLineFaithfulReconstructionV1Debug,
  grouping: RoomTextGroupingV1Debug,
  typing: HierarchicalSpaceTypingV2Debug,
  effectiveUnitPolygon: Pt[],
  _unitBoundaryClosed: boolean,
  layoutPartition?: ApartmentLayoutPartitionV1Debug,
  aiHints?: FloorplanAiSemanticHintsDebug,
  grayWallMass?: GrayWallMassReconstructionV1Debug
): RoomBoundedWallTopologyV1Debug {
  const notes: string[] = []
  const specs = buildRoomSpecs(faithful, grouping, typing, effectiveUnitPolygon, layoutPartition, aiHints, grayWallMass)
  const roomTopologies: RoomTopologyV1[] = []

  for (const spec of specs) {
    const selectedRuns = selectWallRunsForRoom(spec, faithful.wallRuns)
    const refinedBoundaryPolygon = deriveRoomBoundaryFromRuns(spec, selectedRuns)
    const wallRunIds = selectedRuns
      .filter((run) => run.wallClass !== "opening_or_gap")
      .map((run) => run.id)
    const solidWallEdges = selectedRuns
      .filter((run) => run.wallClass === "exterior_wall" || run.wallClass === "interior_wall")
      .map((run) => buildBoundaryEdge(run, "solid_wall"))
    const openingEdges = selectedRuns
      .filter((run) => run.wallClass === "opening_or_gap")
      .map((run) => buildBoundaryEdge(run, "opening_or_gap"))
    const uncertainBoundaryEdges = selectedRuns
      .filter((run) => run.wallClass === "uncertain")
      .map((run) => buildBoundaryEdge(run, "uncertain_boundary"))
    const close = closureScore(spec, selectedRuns)
    const confidence = clamp01(
      close.sideCoverage * 0.35 +
        Math.min(1, wallRunIds.length / (spec.roomType === "open_plan_subzone" ? 6 : 4)) * 0.25 +
        (spec.roomType === "open_plan_subzone" ? 0.15 : close.closedOrNearClosed ? 0.25 : 0.1) +
        (1 - Math.min(1, uncertainBoundaryEdges.length / Math.max(1, selectedRuns.length || 1))) * 0.15 +
        Math.min(1, openingEdges.length * 0.08)
    )
    roomTopologies.push({
      roomId: spec.roomId,
      label: spec.label,
      roomType: spec.roomType,
      boundaryPolygon: refinedBoundaryPolygon,
      labelCenter: pointInPoly(spec.center, refinedBoundaryPolygon) ? spec.center : centerOfPoly(refinedBoundaryPolygon),
      wallRunIds,
      solidWallEdges,
      openingEdges,
      sharedWallEdges: [],
      uncertainBoundaryEdges,
      closedOrNearClosed: close.closedOrNearClosed,
      confidence,
    })
  }

  const useMap = new Map<string, string[]>()
  for (const topo of roomTopologies) {
    for (const id of topo.wallRunIds) {
      const arr = useMap.get(id) ?? []
      arr.push(topo.roomId)
      useMap.set(id, arr)
    }
  }
  const runLookup = new Map(faithful.wallRuns.map((run) => [run.id, run]))
  for (const topo of roomTopologies) {
    topo.sharedWallEdges = topo.wallRunIds
      .filter((id) => (useMap.get(id)?.length ?? 0) === 2)
      .map((id) => runLookup.get(id))
      .filter((run): run is RoomLineFaithfulWallRun => !!run)
      .map((run) => buildBoundaryEdge(run, "shared_wall"))
    topo.solidWallEdges = topo.solidWallEdges.filter(
      (edge) => !topo.sharedWallEdges.some((shared) => shared.runId === edge.runId)
    )
  }

  notes.push(
    `Built ${roomTopologies.length} room topologies from faithful wall runs, grouped labels, and hierarchical space hints.`
  )
  if (layoutPartition) {
    notes.push(
      `Topology seed polygons were sourced from apartment layout partition v1 for ${layoutPartition.layoutRegions.length} wall-driven region(s) before local wall-edge attachment.`
    )
  }
  if (grayWallMass?.recoveredRoomVoids.length) {
    notes.push(`Gray wall mass priors supplied ${grayWallMass.recoveredRoomVoids.length} recovered void region(s) for label-to-room boundary placement.`)
  }
  notes.push(
    `Closed/near-closed topologies: ${roomTopologies.filter((t) => t.closedOrNearClosed).length}/${roomTopologies.length}; open-plan spaces are allowed to remain partially bounded.`
  )

  return {
    roomBoundedWallTopologyV1: {
      roomCount: roomTopologies.length,
      enclosedRoomCount: roomTopologies.filter((t) => t.roomType === "enclosed_room").length,
      openPlanCount: roomTopologies.filter((t) => t.roomType === "open_plan_subzone").length,
      auxiliaryCount: roomTopologies.filter((t) => t.roomType === "auxiliary_space").length,
      closedOrNearClosedCount: roomTopologies.filter((t) => t.closedOrNearClosed).length,
    },
    roomTopologies,
    reconstructionStatement:
      `Room-bounded wall topology v1: ${roomTopologies.length} room topology/topologies, ` +
      `${roomTopologies.filter((t) => t.closedOrNearClosed).length} closed-or-near-closed, ` +
      `${roomTopologies.reduce((sum, t) => sum + t.sharedWallEdges.length, 0)} shared wall edge refs.`,
    notes,
  }
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;")
}

function pathFromPoly(pts: Pt[], close: boolean): string {
  if (pts.length < 2) return ""
  let d = `M ${pts[0]!.x.toFixed(2)} ${pts[0]!.y.toFixed(2)}`
  for (let i = 1; i < pts.length; i++) d += ` L ${pts[i]!.x.toFixed(2)} ${pts[i]!.y.toFixed(2)}`
  if (close) d += " Z"
  return d
}

function lineSvg(edge: RoomTopologyBoundaryEdgeV1, color: string, width: number, dash = ""): string {
  return `<line x1="${edge.x1.toFixed(1)}" y1="${edge.y1.toFixed(1)}" x2="${edge.x2.toFixed(1)}" y2="${edge.y2.toFixed(1)}" stroke="${color}" stroke-width="${width}" stroke-linecap="round" ${dash ? `stroke-dasharray="${dash}"` : ""}/>`
}

export function buildRoomBoundedWallTopologyV1SvgString(
  o: BuildRoomBoundedWallTopologyV1SvgOptions
): string {
  const pb = o.pageBounds
  const w = pb.maxX - pb.minX
  const h = pb.maxY - pb.minY
  const rooms = o.topology.roomTopologies
    .map((topo, idx) => {
      const color = palette(idx)
      const poly =
        topo.boundaryPolygon.length >= 3
          ? `<path d="${escapeXml(pathFromPoly(topo.boundaryPolygon, true))}" fill="${color.fill}" stroke="${color.stroke}" stroke-width="1.1" stroke-dasharray="${topo.closedOrNearClosed ? "none" : "5 4"}"/>`
          : ""
      const shared = topo.sharedWallEdges.map((edge) => lineSvg(edge, "rgba(124,58,237,0.9)", 2.0, "6 3")).join("")
      const openings = topo.openingEdges.map((edge) => lineSvg(edge, "rgba(245,158,11,0.9)", 1.8, "5 4")).join("")
      const uncertain = topo.uncertainBoundaryEdges.map((edge) => lineSvg(edge, "rgba(140,140,140,0.28)", 1.0)).join("")
      const solids = topo.solidWallEdges.map((edge) => lineSvg(edge, color.stroke, 1.7)).join("")
      const label = topo.boundaryPolygon.length
        ? `<text x="${topo.labelCenter.x.toFixed(1)}" y="${topo.labelCenter.y.toFixed(1)}" font-size="7.5" fill="${color.stroke}" font-family="system-ui,sans-serif">${escapeXml(topo.label)}</text>`
        : ""
      return `<g>${poly}${uncertain}${solids}${openings}${shared}${label}</g>`
    })
    .join("")

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${pb.minX} ${pb.minY} ${w} ${h}" width="${Math.round(w)}" height="${Math.round(h)}">
<rect x="${pb.minX}" y="${pb.minY}" width="${w}" height="${h}" fill="white"/>
<text x="${pb.minX + 8}" y="${pb.minY + 14}" font-size="11" fill="#222" font-family="system-ui,sans-serif">${escapeXml(o.topology.reconstructionStatement)}</text>
<text x="${pb.minX + 8}" y="${pb.minY + 28}" font-size="7.5" fill="#444" font-family="system-ui,sans-serif">Room polygons are lightly grouped by room; amber dashed = openings; purple dashed = shared walls; faint gray = uncertain edges.</text>
<g>${rooms}</g>
</svg>`
}
