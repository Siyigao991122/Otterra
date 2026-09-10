import { NextResponse, type NextRequest } from "next/server"
import { verifyAccessToken } from "@/lib/accessToken"

/**
 * Closed-beta gate. The landing page + waitlist stay public; product routes
 * (starting at /design) and admin/API routes require a redeemed invite code.
 * Unset ACCESS_TOKEN_SECRET to disable the gate entirely (e.g. local dev).
 */
const ACCESS_COOKIE = "otterra_access"

const PUBLIC_PATHS = new Set([
  "/",
  "/waitlist",
  "/access",
  "/api/waitlist",
  "/api/access",
  "/otterra-living-room-v1.png",
])
const PUBLIC_PREFIXES = ["/_next", "/models", "/pdf.worker", "/otterra-", "/admin"]

export async function middleware(req: NextRequest) {
  const secret = process.env.ACCESS_TOKEN_SECRET
  if (!secret) return NextResponse.next()

  const { pathname } = req.nextUrl
  if (
    PUBLIC_PATHS.has(pathname) ||
    PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  ) {
    return NextResponse.next()
  }

  const cookie = req.cookies.get(ACCESS_COOKIE)?.value
  if (cookie && (await verifyAccessToken(cookie, secret))) {
    return NextResponse.next()
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "This site is invite-only right now." }, { status: 401 })
  }

  const url = req.nextUrl.clone()
  url.pathname = "/access"
  url.search = ""
  url.searchParams.set("next", pathname)
  return NextResponse.redirect(url)
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
}
