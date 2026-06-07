"use client"

import React from "react"
import { useRouter } from "next/navigation"
import { useState, useCallback, useRef } from "react"
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
  FloorplanGeometry,
  RoomGeometryEnvelopeSource,
  ManualScaleCalibration,
} from "@/lib/types"
import type { ScaleDetectionResult } from "@/app/api/analyze-floorplan/route"
import {
  isValidFootprintPolygon,
  polygonAABB,
  scaleFloorplanGeometry,
} from "@/lib/floorplanGeometry"
import {
  persistRoomDimensionsToSession,
  clearRoomDimensionsSession,
} from "@/lib/roomDimensionsSession"
import { clearLayout } from "@/lib/roomLayout"
import {
  augmentPreflightWithAnalyzeHints,
  preflightLogSummary,
  runFloorplanPreflightFromImagePages,
} from "@/lib/floorplanPreflight"
import type { PDFDocumentProxy } from "pdfjs-dist"
import {
  buildManualScaleCalibration,
  derivePlanScaleFactorFromCalibration,
} from "@/lib/floorplanCalibration"
import type { PlanContentBounds } from "@/lib/floorplanCalibration"
import { WallMaskEditor } from "@/components/WallMaskEditor"
import { CropBoxEditor } from "@/components/CropBoxEditor"
import type { WallMassResult } from "@/lib/wallMassDetect"

interface FloorPlanUploaderProps {
  onUpload: (dimensions: RoomDimensions) => void
  onEnterRoom?: () => void
}

type UploadStep = "upload" | "cropping" | "editing" | "calibrating" | "analyzing" | "review"

/** Width/depth/height last applied from analysis or room selection (not from user input). */
type AnalysisSyncedDims = Pick<RoomDimensions, "width" | "depth" | "height">

const DIM_EPS = 0.001
const FOREGROUND_CHANNEL_THRESHOLD = 245
const BASE64_CHUNK_SIZE = 0x8000

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

async function measurePlanContentBoundsFromPreview(previewSrc: string): Promise<PlanContentBounds> {
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new window.Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error("Could not load the floor plan preview"))
    img.src = previewSrc
  })

  const canvas = document.createElement("canvas")
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight

  const ctx = canvas.getContext("2d", { willReadFrequently: true })
  if (!ctx) {
    throw new Error("Could not read the floor plan preview")
  }

  ctx.drawImage(image, 0, 0)
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height)

  let minX = width
  let maxX = -1
  let minY = height
  let maxY = -1

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4
      const alpha = data[idx + 3]
      if (alpha < 16) continue

      const r = data[idx]
      const g = data[idx + 1]
      const b = data[idx + 2]
      const isForeground =
        r < FOREGROUND_CHANNEL_THRESHOLD ||
        g < FOREGROUND_CHANNEL_THRESHOLD ||
        b < FOREGROUND_CHANNEL_THRESHOLD

      if (!isForeground) continue

      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }

  if (maxX < minX || maxY < minY) {
    return {
      minX: 0,
      minY: 0,
      maxX: Math.max(0, width - 1),
      maxY: Math.max(0, height - 1),
      width,
      height,
    }
  }

  return {
    minX,
    minY,
    maxX,
    maxY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  }
}

function scaleAnalysisPlan(floorPlan: FloorPlanAnalysis, scaleFactor: number): FloorPlanAnalysis {
  const safeScaleFactor = Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1

  return {
    ...floorPlan,
    rooms: floorPlan.rooms.map((room) => ({
      ...room,
      widthMeters: room.widthMeters * safeScaleFactor,
      depthMeters: room.depthMeters * safeScaleFactor,
    })),
    totalWidthMeters: floorPlan.totalWidthMeters * safeScaleFactor,
    totalDepthMeters: floorPlan.totalDepthMeters * safeScaleFactor,
    totalAreaSqMeters: floorPlan.totalAreaSqMeters * safeScaleFactor * safeScaleFactor,
    geometry: floorPlan.geometry
      ? scaleFloorplanGeometry(floorPlan.geometry, safeScaleFactor, safeScaleFactor)
      : floorPlan.geometry,
    notes: floorPlan.notes
      ? `${floorPlan.notes} Manual scale calibration applied (${safeScaleFactor.toFixed(3)}x).`
      : `Manual scale calibration applied (${safeScaleFactor.toFixed(3)}x).`,
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ""
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK_SIZE) {
    const chunk = bytes.subarray(i, i + BASE64_CHUNK_SIZE)
    binary += String.fromCharCode(...chunk)
  }
  return window.btoa(binary)
}

export function FloorPlanUploader({ onUpload, onEnterRoom }: FloorPlanUploaderProps) {
  const calibrationImageRef = useRef<HTMLImageElement | null>(null)
  const [baseAnalysis, setBaseAnalysis] = useState<FloorPlanAnalysis | null>(null)
  const [calibrationPoints, setCalibrationPoints] = useState<FloorplanPoint2D[]>([])
  const [knownLengthMeters, setKnownLengthMeters] = useState("")
  const [manualCalibration, setManualCalibration] = useState<ManualScaleCalibration | null>(null)
  const [calibrationError, setCalibrationError] = useState<string | null>(null)
  const [scaleDetection, setScaleDetection] = useState<ScaleDetectionResult | null>(null)
  const router = useRouter()
  const [step, setStep] = useState<UploadStep>("upload")
  const [uploadedFile, setUploadedFile] = useState<{ name: string; type: string; preview?: string } | null>(null)
  const imageDimsRef = useRef<{ w: number; h: number } | null>(null)
  const cropBoxRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null)
  const [outlineVertices, setOutlineVertices] = useState<FloorplanPoint2D[]>([])
  const [convertedImages, setConvertedImages] = useState<string[]>([])
  const [pdfBase64State, setPdfBase64State] = useState<string | undefined>(undefined)
  const [wallMass, setWallMass] = useState<WallMassResult | null>(null)
  const [wallMassOverlayUrl, setWallMassOverlayUrl] = useState<string | null>(null)
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

  const computeWallMass = useCallback(async (imageDataUrl: string) => {
    try {
      const { detectWallMassFromDataUrl } = await import("@/lib/wallMassDetect")
      const result = await detectWallMassFromDataUrl(imageDataUrl)
      setWallMass(result)
      // Build red overlay from wall mask
      const { width: mW, height: mH, mask } = result
      const cv = document.createElement("canvas")
      cv.width = mW; cv.height = mH
      const ctx = cv.getContext("2d")!
      const imgData = ctx.createImageData(mW, mH)
      for (let i = 0; i < mW * mH; i++) {
        if (mask[i]) {
          imgData.data[i*4]   = 255
          imgData.data[i*4+1] = 50
          imgData.data[i*4+2] = 50
          imgData.data[i*4+3] = 200
        }
      }
      ctx.putImageData(imgData, 0, 0)
      setWallMassOverlayUrl(cv.toDataURL("image/png"))
      console.log(`[wall-mass] detected: ${result.mask.reduce((a, v) => a + v, 0)} wall pixels`)
    } catch (e) {
      console.warn("[wall-mass] detection failed:", e)
    }
  }, [])

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

  /** After AI analysis completes, build final geometry from outline + calibration + AI result. */
  const buildFinalGeometry = useCallback(
    async (analysisResult: FloorPlanAnalysis, calibration: ManualScaleCalibration, vertices: FloorplanPoint2D[]) => {
      if (vertices.length < 3) return

      if (!imageDimsRef.current && uploadedFile?.preview) {
        await new Promise<void>((resolve) => {
          const img = new Image()
          img.onload = () => {
            imageDimsRef.current = { w: img.naturalWidth, h: img.naturalHeight }
            resolve()
          }
          img.onerror = () => resolve()
          img.src = uploadedFile.preview!
        })
      }

      const mpu = calibration.metersPerUnit
      const polygonMeters = vertices.map((v) => ({ x: v.x * mpu, y: -v.y * mpu }))

      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
      for (const p of polygonMeters) {
        if (p.x < minX) minX = p.x
        if (p.x > maxX) maxX = p.x
        if (p.y < minY) minY = p.y
        if (p.y > maxY) maxY = p.y
      }
      const cx = (minX + maxX) / 2
      const cy = (minY + maxY) / 2
      const centered = polygonMeters.map((p) => ({ x: p.x - cx, y: p.y - cy }))

      const widthM = maxX - minX
      const depthM = maxY - minY

      const aiGeom = analysisResult.geometry

      // Trace exact wall-region contours from the pixel mask
      let wallPolygons: FloorplanGeometry["wallPolygons"] | undefined
      const img = imageDimsRef.current
      if (wallMass && wallMass.mask.length > 0 && img) {
        const { wallMaskToPolygons } = await import("@/lib/wallMaskContour")
        const polys = wallMaskToPolygons({
          wallMass,
          outlineVertices: vertices,
          metersPerUnit: mpu,
          imageDims: img,
        })
        if (polys.length > 0) wallPolygons = polys
      }

      // Convert detected room centres (normalised 0-1) → FloorplanRoomZone with scene-space polygon
      // We store just a single-point "polygon" (the centroid) so the Design API can read positions.
      const roomZones: FloorplanGeometry["rooms"] = analysisResult.rooms
        .filter(r => r.cx != null && r.cy != null)
        .map((r, i) => ({
          id: `room-${i}`,
          label: r.name,
          // Single centroid point in plan-space metres (centred like footprintPolygon)
          polygon: [{
            x: r.cx! * widthM - widthM / 2,
            y: -(r.cy! * depthM - depthM / 2),
          }],
        }))

      const nextGeometry: FloorplanGeometry = {
        ...(aiGeom ?? {}),
        units: "m",
        footprintPolygon: centered,
        ...(wallPolygons ? { wallPolygons } : {}),
        rooms: roomZones.length > 0 ? roomZones : undefined,
        doorOpenings: undefined,
        windowOpenings: undefined,
      }

      console.log("[build-final-geometry]", {
        wallPolygonsOut: wallPolygons?.length ?? 0,
        widthM, depthM,
      })

      const nextAnalysis: FloorPlanAnalysis = {
        ...analysisResult,
        geometry: nextGeometry,
        totalWidthMeters: widthM,
        totalDepthMeters: depthM,
      }

      const synced = unitEnvelopeDimensionsFromAnalysis(nextAnalysis)

      setAnalysis(nextAnalysis)
      setManualDimensions(synced)
      setAnalysisSyncedDimensions(synced)

      if (uploadedFile?.preview) {
        const imgEl = new Image()
        imgEl.onload = () => {
          const w = imgEl.naturalWidth
          const h = imgEl.naturalHeight

          // Legacy annotation save
          void fetch("/api/save-annotation", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sourceImage: uploadedFile.preview,
              sourceImageWidth: w,
              sourceImageHeight: h,
              sourceFilename: uploadedFile.name,
              polygonVertices: vertices,
              calibration,
              widthMeters: widthM,
              depthMeters: depthM,
            }),
          }).catch((e) => console.warn("save-annotation failed:", e))

          // New semantic training-data save (floor_plan_sessions + wall mask)
          const saveSession = async () => {
            // Render wall mask to a PNG data URL for storage
            let wallMaskDataUrl: string | undefined
            if (wallMass && wallMass.mask.length > 0) {
              const canvas = document.createElement("canvas")
              canvas.width = wallMass.width
              canvas.height = wallMass.height
              const ctx = canvas.getContext("2d")!
              const imgData = ctx.createImageData(wallMass.width, wallMass.height)
              for (let i = 0; i < wallMass.mask.length; i++) {
                const on = wallMass.mask[i] === 1
                imgData.data[i * 4 + 0] = on ? 255 : 0
                imgData.data[i * 4 + 1] = 0
                imgData.data[i * 4 + 2] = 0
                imgData.data[i * 4 + 3] = on ? 255 : 0
              }
              ctx.putImageData(imgData, 0, 0)
              wallMaskDataUrl = canvas.toDataURL("image/png")
            }

            const cropBox = cropBoxRef.current

            await fetch("/api/save-floor-plan-session", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                source_image_data_url: uploadedFile.preview,
                source_filename: uploadedFile.name,
                image_width: w,
                image_height: h,
                crop_box: cropBox ?? undefined,
                calibration,
                width_meters: widthM,
                depth_meters: depthM,
                footprint_polygon: vertices,
                wall_mask_data_url: wallMaskDataUrl,
              }),
            })
          }
          saveSession().catch((e) => console.warn("save-floor-plan-session failed:", e))
        }
        imgEl.src = uploadedFile.preview
      }
    },
    [uploadedFile, wallMass]
  )

  const runAnalysisAndFinalize = useCallback(async (calibration: ManualScaleCalibration, vertices: FloorplanPoint2D[]) => {
    setStep("analyzing")
    setError(null)
    setBaseAnalysis(null)

    const images = convertedImages
    const pdfBase64 = pdfBase64State

    if (!images.length) {
      setError("No images available for analysis.")
      setStep("upload")
      return
    }

    try {
      const preflightPromise = (async () => {
        try {
          return await runFloorplanPreflightFromImagePages(images.length || 1)
        } catch (e) {
          console.warn("[FloorPlanUploader] preflight skipped (non-fatal)", e)
          return null
        }
      })()

      const analyzePromise = fetch("/api/analyze-floorplan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          images,
          ...(pdfBase64 ? { pdfBase64, sourceFileName: uploadedFile?.name } : {}),
        }),
      }).then(async (response) => {
        const data = await response.json()
        if (!response.ok) {
          throw new Error(data.error || "Failed to analyze floor plan")
        }
        return data
      })

      const [preflightBase, data] = await Promise.all([preflightPromise, analyzePromise])

      const floorPlan = data.floorPlan as FloorPlanAnalysis
      setScaleDetection((data.scaleDetection as ScaleDetectionResult) ?? null)

      let floorPlanWithDiagnostics: FloorPlanAnalysis = floorPlan

      if (preflightBase) {
        const augmented = augmentPreflightWithAnalyzeHints(preflightBase, {
          usedFallbackRectangle: !!floorPlan._debugFloorplanGeometry?.usedFallbackRectangle,
          floorplanConfidence: floorPlan.geometry?.confidence,
        })
        const isPdf = uploadedFile?.type === "application/pdf"
        const browserSafePreflightSource = isPdf ? "pdf-browser-preview-analysis" : "image-fallback-analysis"
        floorPlanWithDiagnostics = {
          ...floorPlan,
          _preflightDiagnostic: { preflightSource: browserSafePreflightSource, result: augmented },
        }
        if (process.env.NODE_ENV === "development") {
          preflightLogSummary(augmented, `floor-plan-uploader:${browserSafePreflightSource}`)
        }
      }

      setBaseAnalysis(floorPlanWithDiagnostics)
      setAnalysis(floorPlanWithDiagnostics)
      setSelectedRoomIndex(0)

      // Build final geometry from outline + calibration + AI analysis
      await buildFinalGeometry(floorPlanWithDiagnostics, calibration, vertices)
      setStep("review")
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Something went wrong. Try an image file or use \"enter room with default dimensions\" below."
      setError(message)
      setStep("upload")
    }
  }, [convertedImages, pdfBase64State, uploadedFile, buildFinalGeometry])

  const onDrop = useCallback(
    async (acceptedFiles: File[]) => {
      const file = acceptedFiles[0]
      if (!file) return

      const isPdf = file.type === "application/pdf"
      const isImage = file.type.startsWith("image/")
      if (!isPdf && !isImage) return

      setError(null)
      setOutlineVertices([])
      setConvertedImages([])
      setPdfBase64State(undefined)
      setWallMass(null)
      setWallMassOverlayUrl(null)

      imageDimsRef.current = null  // reset dims on new upload

      if (isImage) {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(reader.result as string)
          reader.onerror = reject
          reader.readAsDataURL(file)
        })
        // Pre-load image dims so CropBoxEditor renders immediately
        await new Promise<void>((resolve) => {
          const img = new Image()
          img.onload = () => { imageDimsRef.current = { w: img.naturalWidth, h: img.naturalHeight }; resolve() }
          img.onerror = () => resolve()
          img.src = dataUrl
        })
        setUploadedFile({ name: file.name, type: file.type, preview: dataUrl })
        setConvertedImages([dataUrl])
        computeWallMass(dataUrl)
      } else {
        setUploadedFile({ name: file.name, type: file.type })
      }

      if (isPdf) {
        try {
          const images = await convertPdfToImages(file)
          const pdfBase64 = arrayBufferToBase64(await file.arrayBuffer())
          setConvertedImages(images)
          setPdfBase64State(pdfBase64)
          if (images.length > 0) {
            setUploadedFile((prev) => (prev ? { ...prev, preview: images[0] } : prev))
            // Pre-load image dims
            await new Promise<void>((resolve) => {
              const img = new Image()
              img.onload = () => { imageDimsRef.current = { w: img.naturalWidth, h: img.naturalHeight }; resolve() }
              img.onerror = () => resolve()
              img.src = images[0]!
            })
            computeWallMass(images[0]!)
          }
        } catch (pdfErr) {
          const msg = pdfErr instanceof Error ? pdfErr.message : "Could not read PDF."
          setError(msg)
          setStep("upload")
          return
        }

      }

      setStep("cropping")
    },
    [convertPdfToImages, computeWallMass]
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
    const baseGeometry = analysis?.geometry
    const shouldScaleGeometry =
      synced != null &&
      baseGeometry != null &&
      (Math.abs(manualDimensions.width - synced.width) >= DIM_EPS ||
        Math.abs(manualDimensions.depth - synced.depth) >= DIM_EPS)

    const geometry =
      shouldScaleGeometry && synced
        ? scaleFloorplanGeometry(
            baseGeometry,
            manualDimensions.width / Math.max(synced.width, DIM_EPS),
            manualDimensions.depth / Math.max(synced.depth, DIM_EPS)
          )
        : baseGeometry

    let geometryEnvelopeSource: RoomGeometryEnvelopeSource
    if (analysis?._debugFloorplanGeometry?.usedFallbackRectangle) {
      geometryEnvelopeSource = "fallback-rectangle"
    } else if (geometry?.footprintPolygon && isValidFootprintPolygon(geometry.footprintPolygon)) {
      geometryEnvelopeSource = "ai-derived"
    } else {
      geometryEnvelopeSource = "fallback-rectangle"
    }

    const dimensions: RoomDimensions = {
      ...manualDimensions,
      ...(manualCalibration ? { manualCalibration } : {}),
      ...(geometry ? { geometry } : {}),
      geometryEnvelopeSource,
    }

    clearLayout()
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
    setBaseAnalysis(null)
    setAnalysis(null)
    setAnalysisSyncedDimensions(null)
    setCalibrationPoints([])
    setKnownLengthMeters("")
    setManualCalibration(null)
    setError(null)
    setCalibrationError(null)
    setEditingDimensions(false)
    setScaleDetection(null)
    setOutlineVertices([])
    setConvertedImages([])
    setPdfBase64State(undefined)
    setWallMass(null)
    setWallMassOverlayUrl(null)
  }

  const handleCalibrationPreviewClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const img = calibrationImageRef.current
      if (!img) return

      const rect = img.getBoundingClientRect()
      const x = ((event.clientX - rect.left) / rect.width) * img.naturalWidth
      const y = ((event.clientY - rect.top) / rect.height) * img.naturalHeight

      const point: FloorplanPoint2D = { x, y }

      setCalibrationPoints((prev) => {
        if (prev.length >= 2) {
          return [point]
        }
        return [...prev, point]
      })
      setCalibrationError(null)
    },
    []
  )

  const handleConfirmCalibration = useCallback(async () => {
    if (calibrationPoints.length !== 2) return

    const realLength = Number(knownLengthMeters)
    if (!Number.isFinite(realLength) || realLength <= 0) {
      setCalibrationError("Please enter a valid wall length in meters.")
      return
    }

    try {
      if (!uploadedFile?.preview) {
        throw new Error("Missing floor plan preview for calibration")
      }

      const calibration = buildManualScaleCalibration(
        calibrationPoints[0]!,
        calibrationPoints[1]!,
        realLength
      )

      setManualCalibration(calibration)
      setCalibrationError(null)
      setError(null)

      // Now run AI analysis, then build final geometry
      await runAnalysisAndFinalize(calibration, outlineVertices)
    } catch (err) {
      setCalibrationError(err instanceof Error ? err.message : "Failed to build calibration.")
    }
  }, [calibrationPoints, knownLengthMeters, uploadedFile, runAnalysisAndFinalize, outlineVertices])

  const handleConfirmCrop = useCallback(
    async (cropBox: { x: number; y: number; w: number; h: number }) => {
      cropBoxRef.current = cropBox
      // Ensure image dims are known
      if (!imageDimsRef.current && uploadedFile?.preview) {
        await new Promise<void>((resolve) => {
          const img = new Image()
          img.onload = () => { imageDimsRef.current = { w: img.naturalWidth, h: img.naturalHeight }; resolve() }
          img.onerror = () => resolve()
          img.src = uploadedFile.preview!
        })
      }

      // The crop box becomes the outline polygon (apartment boundary)
      setOutlineVertices([
        { x: cropBox.x,               y: cropBox.y },
        { x: cropBox.x + cropBox.w,   y: cropBox.y },
        { x: cropBox.x + cropBox.w,   y: cropBox.y + cropBox.h },
        { x: cropBox.x,               y: cropBox.y + cropBox.h },
      ])

      // Clip wall mask to crop box
      if (wallMass) {
        const imgDims = imageDimsRef.current
        if (imgDims) {
          const scaleX = wallMass.width / imgDims.w
          const scaleY = wallMass.height / imgDims.h
          const clipped = new Uint8Array(wallMass.mask.length)
          for (let my = 0; my < wallMass.height; my++) {
            for (let mx = 0; mx < wallMass.width; mx++) {
              const imgX = mx / scaleX
              const imgY = my / scaleY
              if (imgX >= cropBox.x && imgX <= cropBox.x + cropBox.w &&
                  imgY >= cropBox.y && imgY <= cropBox.y + cropBox.h) {
                clipped[my * wallMass.width + mx] = wallMass.mask[my * wallMass.width + mx]
              }
            }
          }
          setWallMass({ ...wallMass, mask: clipped })
          // Update the red overlay to reflect the clipped mask
          const canvas = document.createElement("canvas")
          canvas.width = wallMass.width; canvas.height = wallMass.height
          const ctx = canvas.getContext("2d")!
          const imgData = ctx.createImageData(wallMass.width, wallMass.height)
          for (let i = 0; i < wallMass.width * wallMass.height; i++) {
            if (clipped[i]) {
              imgData.data[i*4]=255; imgData.data[i*4+1]=50; imgData.data[i*4+2]=50; imgData.data[i*4+3]=200
            }
          }
          ctx.putImageData(imgData, 0, 0)
          setWallMassOverlayUrl(canvas.toDataURL("image/png"))
        }
      }

      setStep("editing")
    },
    [wallMass, uploadedFile]
  )

  const handleConfirmEditing = useCallback(
    (correctedMask: WallMassResult) => {
      setWallMass(correctedMask)
      // outlineVertices were already set from the crop box — don't override
      setStep("calibrating")
    },
    []
  )


  const projectCalibrationPointToPreview = useCallback((p: FloorplanPoint2D) => {
    const img = calibrationImageRef.current
    if (!img || !img.naturalWidth || !img.naturalHeight) {
      return { left: p.x, top: p.y }
    }
    return {
      left: (p.x / img.naturalWidth) * img.clientWidth,
      top: (p.y / img.naturalHeight) * img.clientHeight,
    }
  }, [])

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
            { key: "upload",      label: "Upload" },
            { key: "cropping",    label: "Crop area" },
            { key: "editing",     label: "Edit walls" },
            { key: "calibrating", label: "Calibrate" },
            { key: "analyzing",   label: "AI Analysis" },
            { key: "review",      label: "Review unit" },
          ].map((s, i) => {
            const isActive = s.key === step
            const order: UploadStep[] = ["upload", "cropping", "editing", "calibrating", "analyzing", "review"]
            const isPast = order.indexOf(s.key as UploadStep) < order.indexOf(step as UploadStep)

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

        {/* Calibrating Step */}
        {step === "calibrating" && (
          <div className="max-w-4xl mx-auto">
            <Card className="p-6 bg-card border-border">
              <div className="mb-4">
                <h2 className="text-xl font-semibold">Calibrate Floor Plan Scale</h2>
                <p className="text-sm text-muted-foreground mt-1">
                  Click two points on a wall with known real length, then enter that length in meters.
                </p>
              </div>

              <div className="mb-4 flex items-start gap-2 text-sm p-3 rounded-lg bg-amber-500/10 text-amber-700 dark:text-amber-400 border border-amber-500/20">
                <Ruler className="w-4 h-4 mt-0.5 shrink-0" />
                <div>
                  <p className="font-medium">Set the real-world scale</p>
                  <p className="text-xs mt-0.5 opacity-80">Click two points on a wall or dimension line with a known distance, then enter the real length.</p>
                </div>
              </div>

              {uploadedFile?.preview && (
                <div
                  className="relative inline-block border border-border rounded-lg overflow-hidden cursor-crosshair"
                  onClick={handleCalibrationPreviewClick}
                >
                  <img
                    ref={calibrationImageRef}
                    src={uploadedFile.preview}
                    alt="Floor plan preview"
                    className="max-w-full h-auto block"
                  />

                  {calibrationPoints.map((p, i) => (
                    <div
                      key={i}
                      className="absolute w-3 h-3 rounded-full bg-primary border border-white -translate-x-1/2 -translate-y-1/2"
                      style={projectCalibrationPointToPreview(p)}
                    />
                  ))}

                  {calibrationPoints.length === 2 && (
                    <div
                      className="absolute border-t-2 border-primary"
                      style={(() => {
                        const p1 = projectCalibrationPointToPreview(calibrationPoints[0]!)
                        const p2 = projectCalibrationPointToPreview(calibrationPoints[1]!)
                        return {
                          left: p1.left,
                          top: p1.top,
                          width: Math.hypot(p2.left - p1.left, p2.top - p1.top),
                          transform: `rotate(${Math.atan2(p2.top - p1.top, p2.left - p1.left)}rad)`,
                          transformOrigin: "0 0",
                        }
                      })()}
                    />
                  )}
                </div>
              )}

              <div className="mt-6 max-w-xs">
                <Label htmlFor="known-length">Known wall length (meters)</Label>
                <Input
                  id="known-length"
                  type="number"
                  step="0.01"
                  value={knownLengthMeters}
                  onChange={(e) => {
                    setKnownLengthMeters(e.target.value)
                    setCalibrationError(null)
                  }}
                  placeholder="e.g. 2.64"
                />
              </div>

              {calibrationError && (
                <div className="mt-4 flex items-center gap-2 text-destructive text-sm p-3 rounded-lg bg-destructive/10">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <p>{calibrationError}</p>
                </div>
              )}

              <div className="mt-4 flex gap-3">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setCalibrationPoints([])
                    setKnownLengthMeters("")
                    setCalibrationError(null)
                  }}
                >
                  Reset
                </Button>

                <Button
                  type="button"
                  onClick={handleConfirmCalibration}
                  disabled={calibrationPoints.length !== 2 || !knownLengthMeters}
                >
                  Confirm Calibration
                </Button>
              </div>

              {manualCalibration && (
                <p className="mt-4 text-sm text-muted-foreground">
                  Scale set: {manualCalibration.metersPerUnit.toFixed(6)} meters per drawing unit
                  {manualCalibration.analysisScaleFactor != null
                    ? ` · applying ${manualCalibration.analysisScaleFactor.toFixed(3)}x to the analyzed plan`
                    : ""}
                </p>
              )}

              {/* Back to edit walls step */}
              <div className="mt-4 pt-4 border-t border-border">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setStep("editing")}
                  className="text-muted-foreground"
                >
                  Back to edit walls
                </Button>
              </div>
            </Card>
          </div>
        )}

        {/* Crop Area Step */}
        {step === "cropping" && uploadedFile?.preview && (
          <div className="space-y-6">
            <Card className="p-6">
              <h2 className="text-xl font-semibold mb-1">Define the apartment boundary</h2>
              <p className="text-sm text-muted-foreground mb-4">
                Drag the corner handles to enclose only the apartment floor plan area.
              </p>
              {!imageDimsRef.current ? (
                <div className="flex items-center gap-3 py-12 justify-center text-muted-foreground">
                  <Loader2 className="w-5 h-5 animate-spin" />
                  <span className="text-sm">Loading…</span>
                </div>
              ) : (
                <CropBoxEditor
                  imageSrc={uploadedFile.preview}
                  wallMassOverlayUrl={wallMassOverlayUrl}
                  imageDims={imageDimsRef.current}
                  onConfirm={handleConfirmCrop}
                  onCancel={() => setStep("upload")}
                />
              )}
            </Card>
          </div>
        )}

        {/* Edit Walls Step */}
        {step === "editing" && uploadedFile?.preview && (
          <div className="space-y-6">
            <Card className="p-6">
              <h2 className="text-xl font-semibold mb-1">Edit detected walls</h2>
              <p className="text-sm text-muted-foreground mb-4">
                Red areas are detected walls. Erase anything that isn&apos;t a wall, or paint back
                any walls that were missed.
              </p>
              {!wallMass ? (
                <div className="flex items-center gap-3 py-12 justify-center text-muted-foreground">
                  <Loader2 className="w-5 h-5 animate-spin" />
                  <span className="text-sm">Detecting walls…</span>
                </div>
              ) : (
                <WallMaskEditor
                  imageSrc={uploadedFile.preview}
                  initialMask={wallMass}
                  onConfirm={handleConfirmEditing}
                  onCancel={() => setStep("cropping")}
                />
              )}
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

              {/* File info + fixture overlay */}
              {uploadedFile && (
                <Card className="p-4 bg-card border-border">
                  <div className="flex-1 min-w-0 mb-3">
                    <p className="font-medium truncate">{uploadedFile.name}</p>
                    <p className="text-sm text-muted-foreground mt-0.5">
                      Unit (analyzed): {analysis.totalAreaSqMeters.toFixed(1)} m² ·{" "}
                      {analysis.totalWidthMeters.toFixed(1)}m × {analysis.totalDepthMeters.toFixed(1)}m span
                    </p>
                    {analysis.notes && (
                      <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{analysis.notes}</p>
                    )}
                  </div>
                  {uploadedFile.preview && (
                    <div className="relative inline-block w-full">
                      <img
                        src={uploadedFile.preview}
                        alt="Floor plan preview"
                        className="w-full h-auto rounded-lg border border-border block"
                      />
                    </div>
                  )}
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
                {manualCalibration && (
                  <div className="mb-4 rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">Manual scale calibration: </span>
                    {manualCalibration.realLengthMeters.toFixed(2)} m over selected reference line ·{" "}
                    {manualCalibration.metersPerUnit.toFixed(6)} meters per image unit
                    {manualCalibration.analysisScaleFactor != null
                      ? ` · AI plan rescaled ${manualCalibration.analysisScaleFactor.toFixed(3)}x`
                      : ""}
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
