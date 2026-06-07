import type { RoomDimensions } from "@/lib/types"

/** Session key for restoring `geometry` on `/room` after client navigation (URL only carries w/d/h). */
export const ROOM_DIMENSIONS_SESSION_KEY = "otterra:roomDimensions"

/** Phase 1: unit envelope + optional review focus. `/room` still reads only `RoomDimensions` fields. */
export type SessionUnitPayload = RoomDimensions & {
  selectedZoneIndex?: number
}

export function persistRoomDimensionsToSession(d: SessionUnitPayload): void {
  if (typeof window === "undefined") return
  try {
    sessionStorage.setItem(ROOM_DIMENSIONS_SESSION_KEY, JSON.stringify(d))
  } catch {
    // quota / private mode
  }
}

export function readRoomDimensionsFromSession(): RoomDimensions | null {
  if (typeof window === "undefined") return null
  try {
    const raw = sessionStorage.getItem(ROOM_DIMENSIONS_SESSION_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<RoomDimensions>
    if (
      typeof parsed.width !== "number" ||
      typeof parsed.depth !== "number" ||
      typeof parsed.height !== "number"
    ) {
      return null
    }
    return {
      width: parsed.width,
      depth: parsed.depth,
      height: parsed.height,
      ...(parsed.manualCalibration ? { manualCalibration: parsed.manualCalibration } : {}),
      ...(parsed.geometry ? { geometry: parsed.geometry } : {}),
      ...(parsed.geometryEnvelopeSource ? { geometryEnvelopeSource: parsed.geometryEnvelopeSource } : {}),
    }
  } catch {
    return null
  }
}

export function clearRoomDimensionsSession(): void {
  if (typeof window === "undefined") return
  try {
    sessionStorage.removeItem(ROOM_DIMENSIONS_SESSION_KEY)
  } catch {
    /* ignore */
  }
}
