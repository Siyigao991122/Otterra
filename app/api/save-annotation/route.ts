import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabaseAdmin"

export const runtime = "nodejs"
export const maxDuration = 30

interface SaveAnnotationBody {
  sourceImage: string
  sourceImageWidth: number
  sourceImageHeight: number
  sourceFilename?: string
  polygonVertices: Array<{ x: number; y: number }>
  calibration?: unknown
  widthMeters?: number
  depthMeters?: number
  userIdentifier?: string
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as SaveAnnotationBody

    if (!body.sourceImage || !Array.isArray(body.polygonVertices) || body.polygonVertices.length < 3) {
      return NextResponse.json({ error: "Missing source image or polygon" }, { status: 400 })
    }

    const { data, error } = await supabaseAdmin
      .from("floor_plan_annotations")
      .insert({
        user_identifier: body.userIdentifier ?? null,
        source_image: body.sourceImage,
        source_image_width: body.sourceImageWidth,
        source_image_height: body.sourceImageHeight,
        source_filename: body.sourceFilename ?? null,
        polygon_vertices: body.polygonVertices,
        calibration: body.calibration ?? null,
        width_meters: body.widthMeters ?? null,
        depth_meters: body.depthMeters ?? null,
      })
      .select("id")
      .single()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ id: data?.id })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
