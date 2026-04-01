/**
 * Lightweight summaries and filters for PDF vector segments (debug / wall-candidate preview).
 * Units: PDF user space (typically pt); not meters until calibration.
 */

import type { ExtractedLineSegment } from "@/lib/geometryFirst/types"

export type SegmentAngleClass = "horizontal" | "vertical" | "diagonal" | "other"

export type LengthBucketLabel =
  | "<1"
  | "1-4"
  | "4-12"
  | "12-36"
  | "36-96"
  | "96+"

export interface LengthBucketCount {
  label: LengthBucketLabel
  /** Half-open [min, max) except last bucket inclusive max */
  minPt: number
  maxPt: number | null
  count: number
}

export interface AngleBucketCount {
  horizontal: number
  vertical: number
  diagonal: number
  other: number
}

export interface LinePrimitiveSummary {
  totalSegments: number
  lengthBuckets: LengthBucketCount[]
  angleBuckets: AngleBucketCount
}

export interface WallCandidateFilterStats {
  inputCount: number
  kept: ExtractedLineSegment[]
  droppedShort: number
  droppedAngle: number
  options: {
    minLengthPdfUnits: number
    dominantAngles: WallCandidateAngleMode
    angleToleranceDeg: number
  }
}

export type WallCandidateAngleMode = "none" | "hv" | "hv45"

export function segmentLengthPdfUnits(s: ExtractedLineSegment): number {
  return Math.hypot(s.x2 - s.x1, s.y2 - s.y1)
}

function lengthBucketLabel(len: number): LengthBucketLabel {
  if (len < 1) return "<1"
  if (len < 4) return "1-4"
  if (len < 12) return "4-12"
  if (len < 36) return "12-36"
  if (len < 96) return "36-96"
  return "96+"
}

/** atan2(|dy|,|dx|) in degrees: 0 = axis-horizontal stroke, 90 = vertical, 45 = diagonal. */
export function segmentAngleClass(
  s: ExtractedLineSegment,
  toleranceDeg: number = 6
): SegmentAngleClass {
  const dx = s.x2 - s.x1
  const dy = s.y2 - s.y1
  const ang = (Math.atan2(Math.abs(dy), Math.abs(dx)) * 180) / Math.PI
  const t = toleranceDeg
  if (ang <= t) return "horizontal"
  if (90 - ang <= t) return "vertical"
  if (Math.abs(ang - 45) <= t) return "diagonal"
  return "other"
}

function emptyAngleBuckets(): AngleBucketCount {
  return { horizontal: 0, vertical: 0, diagonal: 0, other: 0 }
}

function emptyLengthBucketRows(): LengthBucketCount[] {
  return [
    { label: "<1", minPt: 0, maxPt: 1, count: 0 },
    { label: "1-4", minPt: 1, maxPt: 4, count: 0 },
    { label: "4-12", minPt: 4, maxPt: 12, count: 0 },
    { label: "12-36", minPt: 12, maxPt: 36, count: 0 },
    { label: "36-96", minPt: 36, maxPt: 96, count: 0 },
    { label: "96+", minPt: 96, maxPt: null, count: 0 },
  ]
}

/** Histogram for raw extracted segments (before wall filter). */
export function summarizeLinePrimitives(
  lines: ExtractedLineSegment[],
  angleToleranceDeg: number = 6
): LinePrimitiveSummary {
  const lengthBuckets = emptyLengthBucketRows()
  const angleBuckets = emptyAngleBuckets()
  const bucketIndex = (label: LengthBucketLabel) => lengthBuckets.findIndex((b) => b.label === label)

  for (const s of lines) {
    const len = segmentLengthPdfUnits(s)
    const li = bucketIndex(lengthBucketLabel(len))
    if (li >= 0) lengthBuckets[li].count++

    const cls = segmentAngleClass(s, angleToleranceDeg)
    angleBuckets[cls]++
  }

  return {
    totalSegments: lines.length,
    lengthBuckets,
    angleBuckets,
  }
}

/**
 * First-pass wall-candidate filter (inspection only).
 * - Always drops very short strokes (hatch, antialiasing junk).
 * - Optionally keep near-axis strokes only (typical floorplan grids).
 */
export function filterWallCandidateLines(
  lines: ExtractedLineSegment[],
  options: {
    minLengthPdfUnits: number
    dominantAngles: WallCandidateAngleMode
    angleToleranceDeg?: number
  }
): WallCandidateFilterStats {
  const angleToleranceDeg = options.angleToleranceDeg ?? 6
  let droppedShort = 0
  let droppedAngle = 0
  const kept: ExtractedLineSegment[] = []

  for (const s of lines) {
    const len = segmentLengthPdfUnits(s)
    if (len < options.minLengthPdfUnits) {
      droppedShort++
      continue
    }
    if (options.dominantAngles !== "none") {
      const cls = segmentAngleClass(s, angleToleranceDeg)
      if (options.dominantAngles === "hv") {
        if (cls !== "horizontal" && cls !== "vertical") {
          droppedAngle++
          continue
        }
      } else if (options.dominantAngles === "hv45") {
        if (cls === "other") {
          droppedAngle++
          continue
        }
      }
    }
    kept.push(s)
  }

  return {
    inputCount: lines.length,
    kept,
    droppedShort,
    droppedAngle,
    options: {
      minLengthPdfUnits: options.minLengthPdfUnits,
      dominantAngles: options.dominantAngles,
      angleToleranceDeg,
    },
  }
}
