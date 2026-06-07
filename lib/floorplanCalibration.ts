import type { FloorplanPoint2D, ManualScaleCalibration } from "./types"

export interface PlanContentBounds {
  minX: number
  maxX: number
  minY: number
  maxY: number
  width: number
  height: number
}

export function distance2d(a: FloorplanPoint2D, b: FloorplanPoint2D): number {
  return Math.hypot(b.x - a.x, b.y - a.y)
}

export function buildManualScaleCalibration(
  p1: FloorplanPoint2D,
  p2: FloorplanPoint2D,
  realLengthMeters: number
): ManualScaleCalibration {
  const drawingDistance = distance2d(p1, p2)

  if (!Number.isFinite(realLengthMeters) || realLengthMeters <= 0) {
    throw new Error("realLengthMeters must be a positive number")
  }

  if (!Number.isFinite(drawingDistance) || drawingDistance <= 0) {
    throw new Error("Selected calibration points must be different")
  }

  return {
    p1,
    p2,
    realLengthMeters,
    metersPerUnit: realLengthMeters / drawingDistance,
  }
}

export function derivePlanScaleFactorFromCalibration(
  calibration: ManualScaleCalibration,
  contentBounds: PlanContentBounds,
  currentWidthMeters: number,
  currentDepthMeters: number
): number {
  if (!(contentBounds.width > 0) || !(contentBounds.height > 0)) {
    throw new Error("Could not measure floor plan bounds from the preview image")
  }
  if (!(currentWidthMeters > 0) || !(currentDepthMeters > 0)) {
    throw new Error("Current analyzed unit size is invalid")
  }

  const dx = Math.abs(calibration.p2.x - calibration.p1.x)
  const dy = Math.abs(calibration.p2.y - calibration.p1.y)
  const total = dx + dy

  const horizontalWeight = total > 0 ? dx / total : 0.5
  const verticalWeight = total > 0 ? dy / total : 0.5

  const analyzedMetersPerUnitX = currentWidthMeters / contentBounds.width
  const analyzedMetersPerUnitY = currentDepthMeters / contentBounds.height
  const analyzedMetersPerUnit =
    analyzedMetersPerUnitX * horizontalWeight + analyzedMetersPerUnitY * verticalWeight

  if (!Number.isFinite(analyzedMetersPerUnit) || analyzedMetersPerUnit <= 0) {
    throw new Error("Could not derive an analyzed scale from the current floor plan")
  }

  const scaleFactor = calibration.metersPerUnit / analyzedMetersPerUnit
  if (!Number.isFinite(scaleFactor) || scaleFactor <= 0) {
    throw new Error("Manual calibration produced an invalid scale factor")
  }

  return scaleFactor
}