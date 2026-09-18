import { NextResponse } from "next/server"
import { normalizeFloorplanGeometryV2 } from "@/lib/floorplan-v2/normalizeGeometry"
import type { FloorplanV2NormalizeInput } from "@/lib/floorplan-v2/types"

export const runtime = "nodejs"

export async function POST(request: Request) {
  let input: FloorplanV2NormalizeInput
  try {
    input = (await request.json()) as FloorplanV2NormalizeInput
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 })
  }

  if (!input?.geometry || typeof input.geometry !== "object") {
    return NextResponse.json({ error: "Expected a floorplan geometry object." }, { status: 400 })
  }

  try {
    return NextResponse.json(normalizeFloorplanGeometryV2(input))
  } catch (error) {
    console.error("[floorplan-v2/normalize]", error)
    return NextResponse.json(
      { error: "Could not normalize floorplan geometry." },
      { status: 422 }
    )
  }
}
