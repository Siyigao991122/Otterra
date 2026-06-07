import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabaseAdmin"

interface SaveSessionRequest {
  // Source image
  source_image_data_url: string      // base64 PNG of the floor plan
  source_filename?: string
  image_width: number
  image_height: number
  // Crop box
  crop_box?: { x: number; y: number; w: number; h: number }
  // Calibration
  calibration?: {
    p1: { x: number; y: number }
    p2: { x: number; y: number }
    metersPerUnit: number
    realLengthMeters: number
  }
  width_meters?: number
  depth_meters?: number
  // Outer footprint polygon
  footprint_polygon?: { x: number; y: number }[]
  // Wall mask as base64 PNG
  wall_mask_data_url?: string
  // Optional user identity
  user_identifier?: string
}

export async function POST(req: NextRequest) {
  try {
    const body: SaveSessionRequest = await req.json()

    const {
      source_image_data_url,
      source_filename,
      image_width,
      image_height,
      crop_box,
      calibration,
      width_meters,
      depth_meters,
      footprint_polygon,
      wall_mask_data_url,
      user_identifier,
    } = body

    if (!source_image_data_url || !image_width || !image_height) {
      return NextResponse.json(
        { error: "source_image_data_url, image_width, image_height are required" },
        { status: 400 }
      )
    }

    // 1. Insert floor_plan_sessions row
    const { data: session, error: sessionError } = await supabaseAdmin
      .from("floor_plan_sessions")
      .insert({
        user_identifier: user_identifier ?? null,
        source_image_data_url,
        source_filename: source_filename ?? null,
        image_width,
        image_height,
        crop_box: crop_box ?? null,
        calibration: calibration ?? null,
        width_meters: width_meters ?? null,
        depth_meters: depth_meters ?? null,
        footprint_polygon: footprint_polygon ?? null,
        split: "train",
      })
      .select("id")
      .single()

    if (sessionError || !session) {
      console.error("[save-floor-plan-session] Session insert error:", sessionError)
      return NextResponse.json({ error: "Failed to save session" }, { status: 500 })
    }

    const sessionId = session.id

    // 2. If we have a wall mask, save it as a region annotation
    if (wall_mask_data_url) {
      const { error: annotError } = await supabaseAdmin
        .from("floor_plan_region_annotations")
        .insert({
          session_id: sessionId,
          class_id: "wall",
          mask_data_url: wall_mask_data_url,
          bbox: crop_box
            ? { x: crop_box.x, y: crop_box.y, w: crop_box.w, h: crop_box.h }
            : null,
          source: "user_drawn",
          confidence: 1.0,
        })

      if (annotError) {
        console.error("[save-floor-plan-session] Annotation insert error:", annotError)
        // Non-fatal — session was saved, just log the error
      }
    }

    console.log(`[save-floor-plan-session] Saved session ${sessionId} (wall_mask: ${!!wall_mask_data_url})`)
    return NextResponse.json({ session_id: sessionId })
  } catch (err) {
    console.error("[save-floor-plan-session] Unexpected error:", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
