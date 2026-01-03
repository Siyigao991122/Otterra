'use client';

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

const DESIGN_STYLES = [
  "modern",
  "minimalist",
  "industrial",
  "scandinavian",
  "bohemian",
  "traditional",
  "contemporary",
  "rustic"
];

export default function CreatePage() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [style, setStyle] = useState("");
  const [email, setEmail] = useState("");
  const [previewUrl, setPreviewUrl] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
      setFile(selectedFile);
      const reader = new FileReader();
      reader.onloadend = () => {
        setPreviewUrl(reader.result as string);
      };
      reader.readAsDataURL(selectedFile);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!file || !style) {
      setError("Please select an image and a design style");
      return;
    }

    setLoading(true);

    try {
      const formData = new FormData();
      formData.append("image", file);
      formData.append("style", style);
      if (email) {
        formData.append("email", email);
      }

      const response = await fetch("/api/generate", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        throw new Error("Failed to generate designs");
      }

      const data = await response.json();
      router.push(`/results/${data.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate designs");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-50 to-gray-100 py-12">
      <div className="container mx-auto px-4 max-w-3xl">
        <div className="text-center mb-12">
          <h1 className="text-4xl md:text-5xl font-bold mb-4">Create Your AI Design</h1>
          <p className="text-lg text-gray-600">
            Upload a photo of your space and choose a style to get started
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Upload & Design</CardTitle>
            <CardDescription>
              Select an image of your room and choose your preferred design style
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-6">
              {/* File Upload */}
              <div>
                <label className="block text-sm font-medium mb-2">
                  Room Image
                </label>
                <Input
                  type="file"
                  accept="image/*"
                  onChange={handleFileChange}
                  required
                  className="cursor-pointer"
                />
                {previewUrl && (
                  <div className="mt-4 relative w-full h-64 rounded-lg overflow-hidden">
                    <img
                      src={previewUrl}
                      alt="Preview"
                      className="w-full h-full object-cover"
                    />
                  </div>
                )}
              </div>

              {/* Style Selection */}
              <div>
                <label className="block text-sm font-medium mb-2">
                  Design Style
                </label>
                <Select value={style} onValueChange={setStyle} required>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a design style" />
                  </SelectTrigger>
                  <SelectContent>
                    {DESIGN_STYLES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {s.charAt(0).toUpperCase() + s.slice(1)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Email (Optional) */}
              <div>
                <label className="block text-sm font-medium mb-2">
                  Email (Optional)
                </label>
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="your@email.com"
                />
                <p className="text-sm text-gray-500 mt-1">
                  We'll send you the results (optional)
                </p>
              </div>

              {error && (
                <div className="bg-red-50 border border-red-200 text-red-600 px-4 py-3 rounded">
                  {error}
                </div>
              )}

              <Button
                type="submit"
                className="w-full"
                size="lg"
                disabled={loading || !file || !style}
              >
                {loading ? "Generating Designs..." : "Generate AI Designs"}
              </Button>
            </form>
          </CardContent>
        </Card>

        {loading && (
          <div className="mt-8 text-center">
            <div className="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
            <p className="mt-4 text-gray-600">Creating your designs... This may take 30-60 seconds</p>
          </div>
        )}
      </div>
    </div>
  );
}
