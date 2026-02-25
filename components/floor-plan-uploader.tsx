"use client"

import React from "react"

import { useState, useCallback } from "react"
import { useDropzone } from "react-dropzone"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Upload,
  FileText,
  FileImage,
  ArrowRight,
  Sparkles,
  CheckCircle2,
  Ruler,
  Loader2,
  AlertCircle,
  Pencil,
  X,
} from "lucide-react"
import type { RoomDimensions, FloorPlanAnalysis, DetectedRoom } from "@/lib/types"

interface FloorPlanUploaderProps {
  onUpload: (dimensions: RoomDimensions) => void
}

type UploadStep = "upload" | "analyzing" | "review"

export function FloorPlanUploader({ onUpload }: FloorPlanUploaderProps) {
  const [step, setStep] = useState<UploadStep>("upload")
  const [uploadedFile, setUploadedFile] = useState<{ name: string; type: string; preview?: string } | null>(null)
  const [analysis, setAnalysis] = useState<FloorPlanAnalysis | null>(null)
  const [selectedRoomIndex, setSelectedRoomIndex] = useState(0)
  const [editingDimensions, setEditingDimensions] = useState(false)
  const [manualDimensions, setManualDimensions] = useState<RoomDimensions>({
    width: 0,
    depth: 0,
    height: 2.7,
  })
  const [error, setError] = useState<string | null>(null)

  const convertPdfToImages = useCallback(async (file: File): Promise<string[]> => {
    const pdfjsLib = await import("pdfjs-dist")
    ;(pdfjsLib as any).GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs"

    const arrayBuffer = await file.arrayBuffer()
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise
    const images: string[] = []

    // Render up to first 3 pages (floor plans rarely exceed this)
    const pageCount = Math.min(pdf.numPages, 3)
    for (let i = 1; i <= pageCount; i++) {
      const page = await pdf.getPage(i)
      const scale = 2 // High-res rendering for better AI analysis
      const viewport = page.getViewport({ scale })

      const canvas = document.createElement("canvas")
      canvas.width = viewport.width
      canvas.height = viewport.height
      const ctx = canvas.getContext("2d")!

      await (page as any).render({ canvas, canvasContext: ctx, viewport }).promise
      images.push(canvas.toDataURL("image/png"))
    }

    return images
  }, [])

  const analyzeFloorPlan = useCallback(async (file: File) => {
    setStep("analyzing")
    setError(null)

    try {
      let images: string[]

      if (file.type === "application/pdf") {
        // Convert PDF pages to images on the client
        images = await convertPdfToImages(file)
      } else {
        // For image files, read as data URL directly
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(reader.result as string)
          reader.onerror = reject
          reader.readAsDataURL(file)
        })
        images = [dataUrl]
      }

      // Also store the first image as preview for PDFs
      if (file.type === "application/pdf" && images.length > 0) {
        setUploadedFile((prev) => prev ? { ...prev, preview: images[0] } : prev)
      }

      const response = await fetch("/api/analyze-floorplan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ images }),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || "Failed to analyze floor plan")
      }

      const floorPlan = data.floorPlan as FloorPlanAnalysis

      setAnalysis(floorPlan)
      setSelectedRoomIndex(0)

      if (floorPlan.rooms.length > 0) {
        const room = floorPlan.rooms[0]
        setManualDimensions({
          width: room.widthMeters,
          depth: room.depthMeters,
          height: room.heightMeters,
        })
      } else {
        setManualDimensions({
          width: floorPlan.totalWidthMeters,
          depth: floorPlan.totalDepthMeters,
          height: 2.7,
        })
      }

      setStep("review")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong analyzing the file.")
      setStep("upload")
    }
  }, [])

  const onDrop = useCallback(
    (acceptedFiles: File[]) => {
      const file = acceptedFiles[0]
      if (!file) return

      const isPdf = file.type === "application/pdf"
      const isImage = file.type.startsWith("image/")

      if (isImage) {
        const reader = new FileReader()
        reader.onload = () => {
          setUploadedFile({
            name: file.name,
            type: file.type,
            preview: reader.result as string,
          })
        }
        reader.readAsDataURL(file)
      } else {
        setUploadedFile({
          name: file.name,
          type: file.type,
        })
      }

      if (isPdf || isImage) {
        analyzeFloorPlan(file)
      }
    },
    [analyzeFloorPlan]
  )

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      "application/pdf": [".pdf"],
      "image/*": [".png", ".jpg", ".jpeg", ".webp"],
    },
    maxFiles: 1,
  })

  const handleRoomSelect = (index: number) => {
    setSelectedRoomIndex(index)
    if (analysis && analysis.rooms[index]) {
      const room = analysis.rooms[index]
      setManualDimensions({
        width: room.widthMeters,
        depth: room.depthMeters,
        height: room.heightMeters,
      })
    }
  }

  const handleGenerate = () => {
    onUpload(manualDimensions)
  }

  const handleReset = () => {
    setStep("upload")
    setUploadedFile(null)
    setAnalysis(null)
    setError(null)
    setEditingDimensions(false)
  }

  return (
    <div className="flex-1 flex items-center justify-center p-8 overflow-y-auto">
      <div className="w-full max-w-5xl">
        {/* Header */}
        <div className="text-center mb-10">
          <h1 className="text-4xl font-bold mb-4 text-balance">
            Upload Your Floor Plan
          </h1>
          <p className="text-muted-foreground text-lg max-w-2xl mx-auto text-pretty">
            Upload a PDF or image of your floor plan and our AI will automatically detect room dimensions and layout.
          </p>
        </div>

        {/* Step Indicator */}
        <div className="flex items-center justify-center gap-2 mb-10">
          {[
            { key: "upload", label: "Upload" },
            { key: "analyzing", label: "AI Analysis" },
            { key: "review", label: "Review & Generate" },
          ].map((s, i) => {
            const isActive = s.key === step
            const isPast =
              (s.key === "upload" && (step === "analyzing" || step === "review")) ||
              (s.key === "analyzing" && step === "review")

            return (
              <div key={s.key} className="flex items-center gap-2">
                {i > 0 && (
                  <div
                    className={`w-12 h-px ${isPast || isActive ? "bg-primary" : "bg-border"}`}
                  />
                )}
                <div className="flex items-center gap-2">
                  <div
                    className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium transition-colors ${
                      isActive
                        ? "bg-primary text-primary-foreground"
                        : isPast
                          ? "bg-primary/20 text-primary"
                          : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {isPast ? <CheckCircle2 className="w-4 h-4" /> : i + 1}
                  </div>
                  <span
                    className={`text-sm font-medium ${isActive ? "text-foreground" : "text-muted-foreground"}`}
                  >
                    {s.label}
                  </span>
                </div>
              </div>
            )
          })}
        </div>

        {/* Upload Step */}
        {step === "upload" && (
          <div className="max-w-2xl mx-auto">
            <Card className="p-8 bg-card border-border">
              <div
                {...getRootProps()}
                className={`
                  border-2 border-dashed rounded-xl p-12 text-center cursor-pointer
                  transition-all duration-200 min-h-[300px] flex flex-col items-center justify-center
                  ${
                    isDragActive
                      ? "border-primary bg-primary/5"
                      : "border-border hover:border-primary/50 hover:bg-muted/30"
                  }
                `}
              >
                <input {...getInputProps()} />
                <div className="w-20 h-20 rounded-2xl bg-muted flex items-center justify-center mb-6">
                  <Upload className="w-10 h-10 text-muted-foreground" />
                </div>
                <p className="text-xl font-semibold mb-2">
                  {isDragActive ? "Drop your floor plan here" : "Drag & drop your floor plan"}
                </p>
                <p className="text-muted-foreground mb-6">or click to browse your files</p>
                <div className="flex items-center gap-4 text-sm text-muted-foreground">
                  <span className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-muted">
                    <FileText className="w-4 h-4" />
                    PDF
                  </span>
                  <span className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-muted">
                    <FileImage className="w-4 h-4" />
                    PNG / JPG / WebP
                  </span>
                </div>
              </div>

              {error && (
                <div className="mt-4 flex items-center gap-2 text-destructive text-sm p-3 rounded-lg bg-destructive/10">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <p>{error}</p>
                </div>
              )}
            </Card>

            <div className="mt-8 grid grid-cols-3 gap-6">
              {[
                { icon: FileText, title: "PDF Support", desc: "Upload architectural PDFs with dimensions" },
                { icon: Sparkles, title: "AI Detection", desc: "Automatically reads room measurements" },
                { icon: Ruler, title: "Precise Dimensions", desc: "Review and fine-tune extracted data" },
              ].map((feature) => (
                <div key={feature.title} className="text-center p-4">
                  <div className="w-10 h-10 rounded-xl bg-muted flex items-center justify-center mx-auto mb-3">
                    <feature.icon className="w-5 h-5 text-muted-foreground" />
                  </div>
                  <h3 className="font-medium mb-1 text-sm">{feature.title}</h3>
                  <p className="text-xs text-muted-foreground">{feature.desc}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Analyzing Step */}
        {step === "analyzing" && (
          <div className="max-w-2xl mx-auto">
            <Card className="p-12 bg-card border-border">
              <div className="flex flex-col items-center text-center">
                <div className="relative mb-8">
                  <div className="w-24 h-24 rounded-2xl bg-primary/10 flex items-center justify-center">
                    <Sparkles className="w-12 h-12 text-primary animate-pulse" />
                  </div>
                  <div className="absolute -bottom-2 -right-2 w-10 h-10 rounded-full bg-card border-2 border-border flex items-center justify-center">
                    <Loader2 className="w-5 h-5 text-primary animate-spin" />
                  </div>
                </div>

                <h2 className="text-2xl font-bold mb-3">Analyzing Floor Plan</h2>
                <p className="text-muted-foreground mb-8 max-w-md">
                  Our AI is reading your floor plan and extracting room dimensions, layout information, and spatial data.
                </p>

                {uploadedFile && (
                  <div className="flex items-center gap-3 px-4 py-3 rounded-lg bg-muted/50 text-sm">
                    {uploadedFile.type === "application/pdf" ? (
                      <FileText className="w-5 h-5 text-primary" />
                    ) : (
                      <FileImage className="w-5 h-5 text-primary" />
                    )}
                    <span className="text-muted-foreground">{uploadedFile.name}</span>
                  </div>
                )}

                <div className="mt-8 space-y-3 w-full max-w-xs">
                  {["Reading document structure", "Detecting room boundaries", "Extracting measurements"].map(
                    (task, i) => (
                      <div key={task} className="flex items-center gap-3 text-sm">
                        <Loader2
                          className="w-4 h-4 text-primary animate-spin"
                          style={{ animationDelay: `${i * 200}ms` }}
                        />
                        <span className="text-muted-foreground">{task}</span>
                      </div>
                    )
                  )}
                </div>
              </div>
            </Card>
          </div>
        )}

        {/* Review Step */}
        {step === "review" && analysis && (
          <div className="grid lg:grid-cols-5 gap-6">
            {/* Left: Detected Rooms */}
            <div className="lg:col-span-3 space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold flex items-center gap-2">
                  <CheckCircle2 className="w-5 h-5 text-primary" />
                  Detected Rooms
                </h2>
                <Button variant="ghost" size="sm" onClick={handleReset} className="text-muted-foreground gap-1.5">
                  <X className="w-4 h-4" />
                  Upload Different File
                </Button>
              </div>

              {/* File info */}
              {uploadedFile && (
                <Card className="p-4 bg-card border-border">
                  <div className="flex items-center gap-4">
                    {uploadedFile.preview ? (
                      <img
                        src={uploadedFile.preview || "/placeholder.svg"}
                        alt="Floor plan preview"
                        className="w-20 h-20 rounded-lg object-cover border border-border"
                      />
                    ) : (
                      <div className="w-20 h-20 rounded-lg bg-muted flex items-center justify-center">
                        <FileText className="w-8 h-8 text-muted-foreground" />
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="font-medium truncate">{uploadedFile.name}</p>
                      <p className="text-sm text-muted-foreground mt-0.5">
                        Total area: {analysis.totalAreaSqMeters.toFixed(1)} m2 | {analysis.totalWidthMeters.toFixed(1)}m x {analysis.totalDepthMeters.toFixed(1)}m
                      </p>
                      {analysis.notes && (
                        <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{analysis.notes}</p>
                      )}
                    </div>
                  </div>
                </Card>
              )}

              {/* Room cards */}
              <div className="grid gap-3">
                {analysis.rooms.map((room: DetectedRoom, index: number) => (
                  <Card
                    key={`${room.name}-${index}`}
                    className={`p-4 cursor-pointer transition-all border-2 ${
                      selectedRoomIndex === index
                        ? "border-primary bg-primary/5"
                        : "border-transparent bg-card hover:bg-muted/30"
                    }`}
                    onClick={() => handleRoomSelect(index)}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div
                          className={`w-10 h-10 rounded-lg flex items-center justify-center text-sm font-semibold ${
                            selectedRoomIndex === index
                              ? "bg-primary text-primary-foreground"
                              : "bg-muted text-muted-foreground"
                          }`}
                        >
                          {index + 1}
                        </div>
                        <div>
                          <p className="font-medium">{room.name}</p>
                          <p className="text-sm text-muted-foreground">
                            {room.widthMeters.toFixed(1)}m x {room.depthMeters.toFixed(1)}m | H: {room.heightMeters.toFixed(1)}m
                          </p>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-medium">
                          {(room.widthMeters * room.depthMeters).toFixed(1)} m2
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {(room.widthMeters * room.depthMeters * 10.764).toFixed(0)} sq ft
                        </p>
                      </div>
                    </div>
                  </Card>
                ))}
              </div>
            </div>

            {/* Right: Selected Room Details */}
            <div className="lg:col-span-2 space-y-4">
              <Card className="p-6 bg-card border-border">
                <div className="flex items-center justify-between mb-5">
                  <h3 className="font-semibold">
                    {analysis.rooms[selectedRoomIndex]?.name || "Room"} Dimensions
                  </h3>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setEditingDimensions(!editingDimensions)}
                    className="gap-1.5 text-muted-foreground"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                    {editingDimensions ? "Done" : "Edit"}
                  </Button>
                </div>

                <div className="space-y-4">
                  <div>
                    <Label htmlFor="width" className="text-sm text-muted-foreground">
                      Width (meters)
                    </Label>
                    <Input
                      id="width"
                      type="number"
                      step="0.1"
                      value={manualDimensions.width}
                      onChange={(e) =>
                        setManualDimensions((d) => ({ ...d, width: Number.parseFloat(e.target.value) || 0 }))
                      }
                      disabled={!editingDimensions}
                      className="mt-1.5 bg-input border-border"
                    />
                  </div>
                  <div>
                    <Label htmlFor="depth" className="text-sm text-muted-foreground">
                      Depth (meters)
                    </Label>
                    <Input
                      id="depth"
                      type="number"
                      step="0.1"
                      value={manualDimensions.depth}
                      onChange={(e) =>
                        setManualDimensions((d) => ({ ...d, depth: Number.parseFloat(e.target.value) || 0 }))
                      }
                      disabled={!editingDimensions}
                      className="mt-1.5 bg-input border-border"
                    />
                  </div>
                  <div>
                    <Label htmlFor="height" className="text-sm text-muted-foreground">
                      Ceiling Height (meters)
                    </Label>
                    <Input
                      id="height"
                      type="number"
                      step="0.1"
                      value={manualDimensions.height}
                      onChange={(e) =>
                        setManualDimensions((d) => ({ ...d, height: Number.parseFloat(e.target.value) || 0 }))
                      }
                      disabled={!editingDimensions}
                      className="mt-1.5 bg-input border-border"
                    />
                  </div>
                </div>

                {/* Visual preview */}
                <div className="mt-6 p-4 rounded-lg bg-muted/50">
                  <p className="text-xs text-muted-foreground mb-3 text-center">Room Preview</p>
                  <div className="flex items-center justify-center">
                    <RoomPreview
                      width={manualDimensions.width}
                      depth={manualDimensions.depth}
                    />
                  </div>
                </div>
              </Card>

              <Button className="w-full gap-2" size="lg" onClick={handleGenerate}>
                <Sparkles className="w-4 h-4" />
                Generate 3D Environment
                <ArrowRight className="w-4 h-4" />
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function RoomPreview({ width, depth }: { width: number; depth: number }) {
  const maxSize = 160
  const ratio = width / depth
  let w: number
  let h: number

  if (ratio > 1) {
    w = maxSize
    h = maxSize / ratio
  } else {
    h = maxSize
    w = maxSize * ratio
  }

  return (
    <div className="relative" style={{ width: w, height: h }}>
      <div className="absolute inset-0 border-2 border-primary/60 rounded bg-primary/5" />
      {/* Width label */}
      <div className="absolute -bottom-6 left-0 right-0 text-center">
        <span className="text-xs font-medium text-primary">{width.toFixed(1)}m</span>
      </div>
      {/* Depth label */}
      <div className="absolute -right-10 top-0 bottom-0 flex items-center">
        <span className="text-xs font-medium text-primary">{depth.toFixed(1)}m</span>
      </div>
      {/* Corner dots */}
      {[
        { top: -3, left: -3 },
        { top: -3, right: -3 },
        { bottom: -3, left: -3 },
        { bottom: -3, right: -3 },
      ].map((pos, i) => (
        <div
          key={i}
          className="absolute w-1.5 h-1.5 rounded-full bg-primary"
          style={pos as React.CSSProperties}
        />
      ))}
    </div>
  )
}
