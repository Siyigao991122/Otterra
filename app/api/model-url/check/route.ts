import { NextRequest, NextResponse } from "next/server"

const TIMEOUT_MS = 8_000

function isValidUrl(url: string): boolean {
  const trimmed = url.trim()
  if (!trimmed) return false
  if (trimmed.startsWith("/")) return true
  try {
    const parsed = new URL(trimmed)
    return parsed.protocol === "http:" || parsed.protocol === "https:"
  } catch {
    return false
  }
}

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url")
  if (!url || !isValidUrl(url)) {
    return NextResponse.json(
      { error: "url query param required; must be http/https or start with /" },
      { status: 400 }
    )
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const resolvedUrl = url.startsWith("/")
      ? new URL(url, req.nextUrl.origin).href
      : url

    const headOptions = {
      method: "HEAD" as const,
      signal: controller.signal,
      redirect: "follow" as const,
    }
    const getOptions = {
      method: "GET" as const,
      headers: { Range: "bytes=0-0" },
      signal: controller.signal,
      redirect: "follow" as const,
    }

    let res: Response
    try {
      res = await fetch(resolvedUrl, headOptions)
      if (res.status === 405 || res.status === 403) {
        res = await fetch(resolvedUrl, getOptions)
      }
    } catch {
      res = await fetch(resolvedUrl, getOptions)
    }

    clearTimeout(timeoutId)
    const ok = res.ok
    const status = res.status
    const finalUrl = res.url !== resolvedUrl ? res.url : undefined
    return NextResponse.json({ ok, status, ...(finalUrl && { finalUrl }) })
  } catch (err) {
    clearTimeout(timeoutId)
    if ((err as Error).name === "AbortError") {
      return NextResponse.json({ ok: false, status: 0 })
    }
    return NextResponse.json({ ok: false, status: 0 })
  }
}
