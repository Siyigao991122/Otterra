import * as fs from "node:fs"
import * as path from "node:path"
import { runGeometryFirstExtraction } from "../lib/geometryFirst/extractPlanPrimitives"
import { buildGeometryFirstDebugPayload } from "../lib/geometryFirst/debugPayload"

void (async () => {
  const pdfPath = path.join(process.cwd(), "tower_6_B.pdf")
  const sourcePdfBytes = new Uint8Array(fs.readFileSync(pdfPath))
  const result = await runGeometryFirstExtraction({
    pdfBytes: new Uint8Array(sourcePdfBytes),
  })

  const dbg = await buildGeometryFirstDebugPayload(result.primitives, {
    includeMainPlanBody: true,
    pdfBytes: new Uint8Array(sourcePdfBytes),
  })

  const base = "tower_6_B"
  const d = path.join(process.cwd(), "debug")
  fs.mkdirSync(d, { recursive: true })

  if (dbg.roomTextAttributionV0Svg) {
    fs.writeFileSync(
      path.join(d, `geometry-first-main-plan-room-text-attribution-v0-${base}.svg`),
      dbg.roomTextAttributionV0Svg
    )
  }

  fs.writeFileSync(
    path.join(d, `geometry-first-main-plan-debug-${base}.json`),
    JSON.stringify(
      {
        mainPlanBodyRoomCandidateRefinementV1: dbg.mainPlanBodyRoomCandidateRefinementV1,
        roomTextAttributionV0: dbg.roomTextAttributionV0,
      },
      null,
      2
    )
  )

  console.log("wrote room text attribution v0 SVG and JSON under debug/")
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
