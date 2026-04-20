"use client"

import React from "react"
import { useRouter } from "next/navigation"
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
import type {
  RoomDimensions,
  FloorPlanAnalysis,
  DetectedRoom,
  FloorplanPoint2D,
  RoomGeometryEnvelopeSource,
} from "@/lib/types"
import { isValidFootprintPolygon, polygonAABB } from "@/lib/floorplanGeometry"
import {
  persistRoomDimensionsToSession,
  clearRoomDimensionsSession,
} from "@/lib/roomDimensionsSession"
import {
  augmentPreflightWithAnalyzeHints,
  preflightLogSummary,
  runFloorplanPreflightFromImagePages,
  runFloorplanPreflightFromPdf,
} from "@/lib/floorplanPreflight"
import type { PDFDocumentProxy } from "pdfjs-dist"

interface FloorPlanUploaderProps {
  onUpload: (dimensions: RoomDimensions) => void
  onEnterRoom?: () => void
}

type UploadStep = "upload" | "analyzing" | "review"

/** Width/depth/height last applied from analysis or room selection (not from user input). */
type AnalysisSyncedDims = Pick<RoomDimensions, "width" | "depth" | "height">

const DIM_EPS = 0.001

/**
 * Dimensions that describe the whole unit for Generate (Phase 1 unit-first).
 * Prefer footprint polygon AABB when geometry is valid — best match to outer shell.
 * Otherwise use model totals. Ceiling height = max of detected room ceilings (typical one slab).
 */
function unitEnvelopeDimensionsFromAnalysis(floorPlan: FloorPlanAnalysis): AnalysisSyncedDims {
  const ceilingHeight =
    floorPlan.rooms.length > 0
      ? Math.max(...floorPlan.rooms.map((r) => r.heightMeters), 2.4)
      : 2.7

  const fp = floorPlan.geometry?.footprintPolygon
  if (fp && isValidFootprintPolygon(fp)) {
    const { width, depth } = polygonAABB(fp)
    if (width > 0 && depth > 0) {
      return { width, depth, height: ceilingHeight }
    }
  }

  const w = floorPlan.totalWidthMeters > 0 ? floorPlan.totalWidthMeters : 4
  const d = floorPlan.totalDepthMeters > 0 ? floorPlan.totalDepthMeters : 4
  return { width: w, depth: d, height: ceilingHeight }
}

export function FloorPlanUploader({ onUpload, onEnterRoom }: FloorPlanUploaderProps) {
  const router = useRouter()
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
  /** Baseline for detecting manual edits to the unit envelope; set only from analysis (not room cards). */
  const [analysisSyncedDimensions, setAnalysisSyncedDimensions] = useState<AnalysisSyncedDims | null>(null)
  const [error, setError] = useState<string | null>(null)

  const convertPdfToImages = useCallback(async (file: File): Promise<string[]> => {
    if (typeof window === "undefined") {
      throw new Error("PDF conversion must run in the browser")
    }

    try {
      const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs")
      const { getDocument, GlobalWorkerOptions } = pdfjs as {
        getDocument: (opts: { data: ArrayBuffer }) => { promise: Promise<PDFDocumentProxy> }
        GlobalWorkerOptions: { workerSrc: string }
      }

      if (typeof getDocument !== "function") {
        throw new Error("PDF.js getDocument is not available")
      }

      try {
        const workerSrc = new URL(
          "pdfjs-dist/legacy/build/pdf.worker.min.mjs",
          import.meta.url
        ).toString()
        GlobalWorkerOptions.workerSrc = workerSrc
      } catch {
        GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs"
      }

      const arrayBuffer = await file.arrayBuffer()
      const loadingTask = getDocument({ data: arrayBuffer })
      const pdf = await loadingTask.promise

      const images: string[] = []
      const pageCount = Math.min(pdf.numPages, 3)

      for (let i = 1; i <= pageCount; i++) {
        const page = await pdf.getPage(i)
        const viewport = page.getViewport({ scale: 2 })

        const canvas = document.createElement("canvas")
        canvas.width = viewport.width
        canvas.height = viewport.height
        const ctx = canvas.getContext("2d")
        if (!ctx) throw new Error("Could not get canvas 2d context")

        const renderTask = page.render({
          canvas,
          canvasContext: ctx,
          viewport,
        })
        await (renderTask?.promise ?? renderTask)

        images.push(canvas.toDataURL("image/png"))
      }

      return images
    } catch (err) {
      console.error("[FloorPlanUploader] PDF conversion error:", err)
      throw new Error(
        "Could not read PDF. Please try an image or enter room with default dimensions."
      )
    }
  }, [])

  const analyzeFloorPlan = useCallback(async (file: File) => {
    setStep("analyzing")
    setError(null)

    try {
      let images: string[]

      if (file.type === "application/pdf") {
        try {
          images = await convertPdfToImages(file)
        } catch (pdfErr) {
          const msg =
            pdfErr instanceof Error
              ? pdfErr.message
              : "Could not read PDF. Please try an image or enter room with default dimensions."
          throw new Error(msg)
        }
      } else {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(reader.result as string)
          reader.onerror = reject
          reader.readAsDataURL(file)
        })
        images = [dataUrl]
      }

      if (file.type === "application/pdf" && images.length > 0) {
        setUploadedFile((prev) => (prev ? { ...prev, preview: images[0] } : prev))
      }

      const preflightPromise = (async () => {
        try {
          if (file.type === "application/pdf") {
            return await runFloorplanPreflightFromImagePages(images.length || 1)
          }
          return await runFloorplanPreflightFromImagePages(images.length || 1)
        } catch (e) {
          console.warn("[FloorPlanUploader] preflight skipped (non-fatal)", e)
          return null
        }
      })()

      const analyzePromise = fetch("/api/analyze-floorplan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ images }),
      }).then(async (response) => {
        const data = await response.json()
        if (!response.ok) {
          throw new Error(data.error || "Failed to analyze floor plan")
        }
        return data
      })

      const [preflightBase, data] = await Promise.all([preflightPromise, analyzePromise])

      const floorPlan = data.floorPlan as FloorPlanAnalysis

      let floorPlanWithDiagnostics: FloorPlanAnalysis = floorPlan

      if (preflightBase) {
        const augmented = augmentPreflightWithAnalyzeHints(preflightBase, {
          usedFallbackRectangle: !!floorPlan._debugFloorplanGeometry?.usedFallbackRectangle,
          floorplanConfidence: floorPlan.geometry?.confidence,
        })
        const preflightSource =
          file.type === "application/pdf" ? "pdf-vector-analysis" : "image-fallback-analysis"
        const browserSafePreflightSource =
          file.type === "application/pdf" ? "pdf-browser-preview-analysis" : "image-fallback-analysis"
        floorPlanWithDiagnostics = {
          ...floorPlan,
          _preflightDiagnostic: { preflightSource: browserSafePreflightSource, result: augmented },
        }
        if (process.env.NODE_ENV === "development") {
          preflightLogSummary(augmented, `floor-plan-uploader:${browserSafePreflightSource}`)
        }
      }

      setAnalysis(floorPlanWithDiagnostics)
      setSelectedRoomIndex(0)

      const synced = unitEnvelopeDimensionsFromAnalysis(floorPlan)
      setManualDimensions(synced)
      setAnalysisSyncedDimensions(synced)

      setStep("review")
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Something went wrong. Try an image file or use \"enter room with default dimensions\" below."
      setError(message)
      setStep("upload")
    }
  }, [convertPdfToImages])

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

  /** Phase 1: optional focus/inspection only — does not change unit envelope or Generate. */
  const handleRoomSelect = (index: number) => {
    setSelectedRoomIndex(index)
  }

  const handleGenerate = () => {
    const synced = analysisSyncedDimensions
    const manuallyChangedFromAnalysis =
      synced == null ||
      Math.abs(manualDimensions.width - synced.width) >= DIM_EPS ||
      Math.abs(manualDimensions.depth - synced.depth) >= DIM_EPS ||
      Math.abs(manualDimensions.height - synced.height) >= DIM_EPS

    const shouldDropGeometry =
      manuallyChangedFromAnalysis && analysis?.geometry != null

    let geometryEnvelopeSource: RoomGeometryEnvelopeSource
    if (shouldDropGeometry) {
      geometryEnvelopeSource = "fallback-rectangle"
    } else if (analysis?._debugFloorplanGeometry?.usedFallbackRectangle) {
      geometryEnvelopeSource = "fallback-rectangle"
    } else if (
      analysis?.geometry?.footprintPolygon &&
      isValidFootprintPolygon(analysis.geometry.footprintPolygon)
    ) {
      geometryEnvelopeSource = "ai-derived"
    } else {
      geometryEnvelopeSource = "fallback-rectangle"
    }

    // TODO: rescale footprintPolygon (and interior walls) to match edited width/depth/height instead of dropping geometry.
    const dimensions: RoomDimensions = shouldDropGeometry
      ? {
          width: manualDimensions.width,
          depth: manualDimensions.depth,
          height: manualDimensions.height,
          geometryEnvelopeSource,
        }
      : {
          ...manualDimensions,
          ...(analysis?.geometry ? { geometry: analysis.geometry } : {}),
          geometryEnvelopeSource,
        }

    // Phase 2+: /room may read selectedZoneIndex for default camera / zone highlight.
    persistRoomDimensionsToSession({ ...dimensions, selectedZoneIndex: selectedRoomIndex })
    onUpload(dimensions)
    const params = new URLSearchParams({
      width: String(dimensions.width),
      depth: String(dimensions.depth),
      height: String(dimensions.height),
    })
    router.push(`/room?${params.toString()}`)
  }

  const handleReset = () => {
    clearRoomDimensionsSession()
    setStep("upload")
    setUploadedFile(null)
    setAnalysis(null)
    setAnalysisSyncedDimensions(null)
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
            { key: "review", label: "Review unit" },
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

            <p className="text-sm text-muted-foreground mt-6 text-center">
              or{" "}
              <button
                type="button"
                onClick={() => {
                  if (typeof onEnterRoom === "function") {
                    onEnterRoom()
                  } else {
                    router.push("/room")
                  }
                }}
                className="text-primary hover:underline font-medium"
              >
                enter room with default dimensions
              </button>
            </p>

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
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h2 className="text-lg font-semibold flex items-center gap-2">
                    <CheckCircle2 className="w-5 h-5 text-primary" />
                    Detected spaces
                  </h2>
                  <p className="text-xs text-muted-foreground mt-1">
                    Optional focus — tap to inspect. Generate always uses the whole apartment envelope →
                  </p>
                </div>
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
                        Unit (analyzed): {analysis.totalAreaSqMeters.toFixed(1)} m² ·{" "}
                        {analysis.totalWidthMeters.toFixed(1)}m × {analysis.totalDepthMeters.toFixed(1)}m span
                      </p>
                      {analysis.notes && (
                        <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{analysis.notes}</p>
                      )}
                      {/* TEMPORARY: footprint debug — remove _debugFloorplanGeometry plumbing when done */}
                      {analysis._debugFloorplanGeometry && (() => {
                        const dbg = analysis._debugFloorplanGeometry
                        const iw = dbg.interiorWalls
                        const dropTotal =
                          iw != null
                            ? iw.droppedInvalid + iw.droppedDegenerate + iw.droppedOutlier
                            : 0
                        return (
                          <>
                            <p className="mt-2 text-[10px] font-mono leading-snug text-amber-700 dark:text-amber-400/90 break-words">
                              DEBUG footprint: type={dbg.geometryType} · points={dbg.footprintPointCount} · fallback rectangle=
                              {dbg.usedFallbackRectangle ? "yes" : "no"} · model raw V={dbg.modelRawFootprintVertexCount} · model quad only=
                              {dbg.modelReturnedExactlyFourFootprintPoints ? "yes" : "no"}
                            </p>
                            {iw && (
                              <p className="mt-1 text-[10px] font-mono leading-snug text-amber-700 dark:text-amber-400/90 break-words">
                                DEBUG interior walls: raw {iw.modelRawArrayCount} / normalized {iw.normalizedCount}
                                {dropTotal > 0
                                  ? ` · dropped invalid/short/outlier=${iw.droppedInvalid}/${iw.droppedDegenerate}/${iw.droppedOutlier}`
                                  : ""}
                              </p>
                            )}
                          </>
                        )
                      })()}
                      {process.env.NODE_ENV === "development" && analysis._preflightDiagnostic && (() => {
                        const { preflightSource, result: pr } = analysis._preflightDiagnostic
                        const sourceLabel =
                          preflightSource === "pdf-vector-analysis"
                            ? "PDF vector analysis (full preflight on bytes)"
                            : preflightSource === "pdf-browser-preview-analysis"
                              ? "PDF browser preview analysis (client-safe placeholder preflight)"
                            : "Image fallback analysis (placeholder primitives only)"
                        const risksTop = pr.risks.slice(0, 4)
                        return (
                          <div className="mt-3 rounded-md border border-cyan-600/40 bg-cyan-950/20 dark:bg-cyan-950/35 px-2 py-2">
                            <p className="text-[10px] font-semibold uppercase tracking-wide text-cyan-700 dark:text-cyan-300">
                              Preflight (debug)
                            </p>
                            <p className="text-[10px] text-cyan-900/90 dark:text-cyan-200/90 mt-1 font-mono break-words">
                              Source: {sourceLabel}
                            </p>
                            <p className="text-[10px] font-mono text-cyan-900 dark:text-cyan-100/95 mt-1 break-words">
                              readinessTier={pr.readinessTier} · geometryFirst={pr.geometryFirstSuitability} · precision=
                              {pr.precisionSuitability} · recommendedMode={pr.recommendedMode}
                            </p>
                            <p className="text-[10px] font-mono text-cyan-800/95 dark:text-cyan-200/85 mt-1">
                              score={pr.readinessScore} · {pr.logLine}
                            </p>
                            {risksTop.length > 0 ? (
                              <ul className="mt-1.5 text-[10px] font-mono list-disc pl-4 text-cyan-900 dark:text-cyan-100/90 space-y-0.5">
                                {risksTop.map((r, i) => (
                                  <li key={`${i}-${r.slice(0, 40)}`}>{r}</li>
                                ))}
                              </ul>
                            ) : (
                              <p className="text-[10px] font-mono mt-1 text-cyan-800 dark:text-cyan-200/80">risks: none flagged</p>
                            )}
                            <p className="text-[10px] text-muted-foreground mt-1.5 leading-snug">{pr.summary}</p>
                          </div>
                        )
                      })()}
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

            {/* Right: whole-unit envelope (Generate); optional room focus as secondary */}
            <div className="lg:col-span-2 space-y-4">
              <Card className="p-6 bg-card border-border">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="font-semibold">Apartment / unit envelope</h3>
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
                <p className="text-xs text-muted-foreground mb-4">
                  These values drive <span className="font-medium text-foreground">Generate</span> (full unit 3D). Adjust
                  if totals need correction.
                </p>
                {analysis.rooms[selectedRoomIndex] && (
                  <div className="mb-4 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">Focus (optional): </span>
                    {analysis.rooms[selectedRoomIndex].name} ·{" "}
                    {analysis.rooms[selectedRoomIndex].widthMeters.toFixed(1)}m ×{" "}
                    {analysis.rooms[selectedRoomIndex].depthMeters.toFixed(1)}m ·{" "}
                    {(analysis.rooms[selectedRoomIndex].widthMeters * analysis.rooms[selectedRoomIndex].depthMeters).toFixed(1)}{" "}
                    m² est.
                  </div>
                )}

                <div className="space-y-4">
                  <div>
                    <Label htmlFor="width" className="text-sm text-muted-foreground">
                      Unit width (meters)
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
                      Unit depth (meters)
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
                      Ceiling height (meters)
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

                {/* Visual preview — whole-unit footprint when polygon exists */}
                <div className="mt-6 p-4 rounded-lg bg-muted/50">
                  <p className="text-xs text-muted-foreground mb-3 text-center">
                    Whole-unit footprint preview
                  </p>
                  <div className="flex items-center justify-center">
                    <RoomPreview
                      width={manualDimensions.width}
                      depth={manualDimensions.depth}
                      footprintPolygon={analysis.geometry?.footprintPolygon}
                    />
                  </div>
                </div>
              </Card>

              <div className="space-y-2">
                <Button className="w-full gap-2" size="lg" onClick={handleGenerate}>
                  <Sparkles className="w-4 h-4" />
                  Generate 3D apartment
                  <ArrowRight className="w-4 h-4" />
                </Button>
                <p className="text-xs text-muted-foreground text-center px-1">
                  Uses the unit envelope and footprint above, not the focused room card alone.
                  {/* TODO Phase 2: plan camera preset + zone picking on /room */}
                </p>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function RoomPreview({
  width,
  depth,
  footprintPolygon,
}: {
  width: number
  depth: number
  footprintPolygon?: FloorplanPoint2D[]
}) {
  if (footprintPolygon && isValidFootprintPolygon(footprintPolygon)) {
    return (
      <div className="flex flex-col items-center gap-1">
        <FootprintPolygonPreview polygon={footprintPolygon} />
        <p className="text-[10px] text-muted-foreground text-center max-w-[220px] leading-tight">
          Exterior footprint from analysis. Numbers below are the whole-unit envelope (editable).
        </p>
        <div className="flex gap-3 text-xs font-medium text-primary mt-1">
          <span>{width.toFixed(1)}m</span>
          <span className="text-muted-foreground">×</span>
          <span>{depth.toFixed(1)}m</span>
        </div>
      </div>
    )
  }

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
    <div className="flex flex-col items-center gap-1">
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
      <p className="text-[10px] text-muted-foreground text-center max-w-[220px] leading-tight mt-6">
        Rectangle from unit envelope (no polygon). Same values as width/depth fields.
      </p>
    </div>
  )
}

/** Plan-space preview: x right, y up (SVG Y flipped). */
function FootprintPolygonPreview({ polygon }: { polygon: FloorplanPoint2D[] }) {
  const maxSize = 160
  const pad = 6
  const xs = polygon.map((p) => p.x)
  const ys = polygon.map((p) => p.y)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const bw = maxX - minX || 1
  const bh = maxY - minY || 1
  const inner = maxSize - pad * 2
  const scale = inner / Math.max(bw, bh)

  const points = polygon
    .map((p) => {
      const sx = pad + (p.x - minX) * scale
      const sy = pad + (maxY - p.y) * scale
      return `${Number(sx.toFixed(2))},${Number(sy.toFixed(2))}`
    })
    .join(" ")

  return (
    <svg
      width={maxSize}
      height={maxSize}
      className="text-primary shrink-0 overflow-visible"
      aria-hidden
    >
      <polygon
        points={points}
        fill="currentColor"
        fillOpacity={0.08}
        stroke="currentColor"
        strokeOpacity={0.55}
        strokeWidth={1.5}
        strokeLinejoin="round"
      />
    </svg>
  )
}
