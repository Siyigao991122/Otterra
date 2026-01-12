import { sql } from "@vercel/postgres";
import { notFound } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import Link from "next/link";

interface PageProps {
  params: {
    id: string;
  };
}

async function getGeneration(id: string) {
  try {
    const { rows } = await sql`
      SELECT * FROM generations WHERE id = ${id}
    `;
    return rows[0] || null;
  } catch (error) {
    console.error("Error fetching generation:", error);
    return null;
  }
}

export default async function ResultsPage({ params }: PageProps) {
  const generation = await getGeneration(params.id);

  if (!generation) {
    notFound();
  }

  const outputs = generation.outputs as string[];

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-50 to-gray-100 py-12">
      <div className="container mx-auto px-4">
        <div className="text-center mb-12">
          <h1 className="text-4xl md:text-5xl font-bold mb-4">Your AI Designs</h1>
          <p className="text-lg text-gray-600">
            Here are your generated design variations in {generation.style} style
          </p>
        </div>

        {/* Original Image */}
        <div className="max-w-4xl mx-auto mb-12">
          <Card>
            <CardHeader>
              <CardTitle>Original Image</CardTitle>
            </CardHeader>
            <CardContent>
              <img
                src={generation.input_url}
                alt="Original room"
                className="w-full rounded-lg"
              />
            </CardContent>
          </Card>
        </div>

        {/* Generated Images */}
        <div className="max-w-6xl mx-auto mb-12">
          <h2 className="text-3xl font-bold text-center mb-8">Generated Designs</h2>
          <div className="grid md:grid-cols-3 gap-6">
            {outputs.map((url, index) => (
              <Card key={index}>
                <CardHeader>
                  <CardTitle className="text-lg">Variation {index + 1}</CardTitle>
                </CardHeader>
                <CardContent>
                  <img
                    src={url}
                    alt={`Design variation ${index + 1}`}
                    className="w-full rounded-lg"
                  />
                  <a
                    href={url}
                    download={`design-${params.id}-${index + 1}.png`}
                    className="block mt-4"
                  >
                    <Button variant="outline" className="w-full">
                      Download
                    </Button>
                  </a>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>

        {/* CTA */}
        <div className="text-center">
          <Link href="/create">
            <Button size="lg">
              Create Another Design
            </Button>
          </Link>
        </div>

        {/* Metadata */}
        <div className="max-w-2xl mx-auto mt-12">
          <Card>
            <CardHeader>
              <CardTitle>Generation Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="flex justify-between">
                <span className="text-gray-600">Style:</span>
                <span className="font-medium">{generation.style}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">Created:</span>
                <span className="font-medium">
                  {new Date(generation.created_at).toLocaleString()}
                </span>
              </div>
              {generation.user_email && (
                <div className="flex justify-between">
                  <span className="text-gray-600">Email:</span>
                  <span className="font-medium">{generation.user_email}</span>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
