export interface RoomDimensions {
  width: number
  depth: number
  height: number
}

export interface FurnitureDimensions {
  width: number
  height: number
  depth: number
}

export interface Furniture {
  id: string
  type: string
  name: string
  color: string
  dimensions: FurnitureDimensions
  position: [number, number, number]
  rotation: number
}

export interface DetectedRoom {
  name: string
  widthMeters: number
  depthMeters: number
  heightMeters: number
}

export interface FloorPlanAnalysis {
  rooms: DetectedRoom[]
  totalWidthMeters: number
  totalDepthMeters: number
  totalAreaSqMeters: number
  notes: string
}
