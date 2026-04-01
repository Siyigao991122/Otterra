import { NextRequest, NextResponse } from "next/server";

const ADMIN_API_KEY = process.env.ADMIN_API_KEY;

/**
 * Validates the request has a valid admin API key (via Authorization: Bearer <key> or x-admin-api-key header).
 * Returns null if valid, or a NextResponse to return if invalid.
 */
export function requireAdminKey(
  request: NextRequest
): NextResponse | null {
  if (!ADMIN_API_KEY) {
    return NextResponse.json(
      { error: "Admin API key not configured" },
      { status: 500 }
    );
  }

  const authHeader = request.headers.get("authorization");
  const bearerKey = authHeader?.startsWith("Bearer ")
    ? authHeader.slice(7)
    : null;
  const headerKey = request.headers.get("x-admin-api-key");

  const providedKey = bearerKey ?? headerKey;

  if (!providedKey || providedKey !== ADMIN_API_KEY) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401 }
    );
  }

  return null;
}
