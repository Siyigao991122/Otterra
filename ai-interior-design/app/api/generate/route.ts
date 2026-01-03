import { NextRequest, NextResponse } from "next/server";
import Replicate from "replicate";
import { sql } from "@vercel/postgres";
import { v4 as uuidv4 } from "uuid";

const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN!,
});

async function convertImageToBase64(file: File): Promise<string> {
  const bytes = await file.arrayBuffer();
  const buffer = Buffer.from(bytes);
  const base64 = buffer.toString("base64");
  return `data:${file.type};base64,${base64}`;
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const image = formData.get("image") as File;
    const style = formData.get("style") as string;
    const email = formData.get("email") as string | null;

    if (!image || !style) {
      return NextResponse.json(
        { error: "Image and style are required" },
        { status: 400 }
      );
    }

    // Convert image to base64 for Replicate
    const imageBase64 = await convertImageToBase64(image);

    // Generate 3 variations using Replicate Flux
    const prompt = `interior design, ${style} style, photorealistic, professional, high quality, modern furniture, beautiful lighting`;

    const outputs: string[] = [];

    // Generate 3 variations
    for (let i = 0; i < 3; i++) {
      const output = await replicate.run(
        "black-forest-labs/flux-schnell",
        {
          input: {
            prompt: prompt,
            image: imageBase64,
            num_outputs: 1,
            num_inference_steps: 4,
            guidance_scale: 0,
            seed: Math.floor(Math.random() * 1000000),
          },
        }
      ) as string[];

      if (output && output.length > 0) {
        outputs.push(output[0]);
      }
    }

    if (outputs.length === 0) {
      return NextResponse.json(
        { error: "Failed to generate designs" },
        { status: 500 }
      );
    }

    // Save to database
    const id = uuidv4();

    await sql`
      INSERT INTO generations (id, user_email, input_url, outputs, style, created_at)
      VALUES (
        ${id},
        ${email || null},
        ${imageBase64},
        ${JSON.stringify(outputs)},
        ${style},
        ${new Date().toISOString()}
      )
    `;

    return NextResponse.json({
      id,
      outputs,
      style,
    });
  } catch (error) {
    console.error("Error generating designs:", error);
    return NextResponse.json(
      { error: "Failed to generate designs" },
      { status: 500 }
    );
  }
}
