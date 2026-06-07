import { NextResponse } from "next/server"

export async function POST(req: Request) {
  void req
  return NextResponse.json(
    {
      error: "The geometry-first floorplan route has been disabled while experimental reconstruction code is isolated from the active app.",
    },
    { status: 410 }
  )
}
