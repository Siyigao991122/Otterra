import { createClient } from "@supabase/supabase-js"

function mustGet(name: string) {
  const v = process.env[name]
  if (!v) throw new Error(`Missing Supabase env: ${name}`)
  return v
}

export const supabasePublic = createClient(
  mustGet("NEXT_PUBLIC_SUPABASE_URL"),
  mustGet("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
  { auth: { persistSession: false } }
)