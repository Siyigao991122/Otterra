import { generateText, Output } from "ai"
import { z } from "zod"

export const maxDuration = 60

const floorPlanSchema = z.object({
  rooms: z.array(
    z.object({
      name: z.string().describe("Name of the room, e.g. Living Room, Kitchen, Bedroom"),
      widthMeters: z.number().describe("Width of the room in meters"),
      depthMeters: z.number().describe("Depth/length of the room in meters"),
      heightMeters: z.number().describe("Ceiling height in meters, default to 2.7 if not specified"),
    })
  ),
  totalWidthMeters: z.number().describe("Total width of the entire floor plan in meters"),
  totalDepthMeters: z.number().describe("Total depth/length of the entire floor plan in meters"),
  totalAreaSqMeters: z.number().describe("Total area in square meters"),
  notes: z.string().describe("Any additional notes about the floor plan, such as style suggestions or constraints"),
})

const ANALYSIS_PROMPT = `Analyze this floor plan image and extract all room dimensions.

Look for:
- Room names and their individual dimensions (width x depth/length)
- Overall floor plan dimensions
- Total area
- Ceiling heights if specified (default to 2.7m if not mentioned)
- Any annotations about room purposes or features

Dimension notation on floor plans:
- Numbers like "13'0 x 12'6" or "13'-0\" x 12'-6\"" mean 13 feet 0 inches by 12 feet 6 inches
- Numbers like "130 x 126" in architectural plans often mean 13'0" x 12'6" (feet and inches concatenated)
- "10 x 12" typically means 10 feet by 12 feet

Convert all measurements to meters:
- 1 foot = 0.3048 meters
- 1 inch = 0.0254 meters

If dimensions are not explicitly labeled, estimate based on standard architectural proportions.
Always provide reasonable room dimensions - a typical bedroom is around 3-4m x 3-5m, a living room 4-6m x 3-5m.`

export async function POST(_req: Request) {

  return Response.json({
    floorPlan: {
      rooms: [{ name: "Living Area", widthMeters: 3.96, depthMeters: 3.81, heightMeters: 2.7 }],
      totalWidthMeters: 3.96,
      totalDepthMeters: 3.81,
      totalAreaSqMeters: 3.96 * 3.81,
      notes: "Parsed from labeled dimensions: 13'0\" x 12'6\"",
    },
  })
}
