"use client"

import { supabaseBrowser } from "@/lib/supabaseBrowser"

export async function adminHeaders(json = true): Promise<Record<string, string>> {
  const { data } = await supabaseBrowser.auth.getSession()
  const token = data.session?.access_token
  return {
    ...(json ? { "Content-Type": "application/json" } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}
