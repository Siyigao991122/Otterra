"use client"

import { useEffect, useState } from "react"
import type { Session } from "@supabase/supabase-js"
import { Loader2, LogOut } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { supabaseBrowser } from "@/lib/supabaseBrowser"

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState<string | null>(null)
  const [email, setEmail] = useState("sgao@ucsd.edu")
  const [sending, setSending] = useState(false)

  useEffect(() => {
    supabaseBrowser.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setLoading(false)
    })
    const { data } = supabaseBrowser.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession)
      setLoading(false)
    })
    return () => data.subscription.unsubscribe()
  }, [])

  const signIn = async () => {
    setMessage(null)
    setSending(true)
    const { error } = await supabaseBrowser.auth.signInWithOtp({
      email: email.trim(),
      options: {
        emailRedirectTo: `${window.location.origin}/admin/invites`,
        shouldCreateUser: true,
      },
    })
    setSending(false)
    setMessage(error ? error.message : "Check your email and click the secure sign-in link.")
  }

  if (loading) return <div className="min-h-screen grid place-items-center"><Loader2 className="h-6 w-6 animate-spin" /></div>

  if (!session) {
    return (
      <main className="min-h-screen grid place-items-center p-6 bg-muted/30">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Otterra Admin</CardTitle>
            <CardDescription>We will email a secure sign-in link to an authorized administrator.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <label className="block space-y-1.5 text-sm">
              <span>Email</span>
              <input
                className="h-10 w-full rounded-md border bg-background px-3"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="email"
              />
            </label>
            <Button className="w-full" onClick={signIn} disabled={sending || !email.trim()}>
              {sending ? "Sending…" : "Email me a sign-in link"}
            </Button>
            {message && <p className="text-sm text-destructive">{message}</p>}
          </CardContent>
        </Card>
      </main>
    )
  }

  return (
    <>
      <div className="fixed right-4 top-4 z-50 flex items-center gap-2 rounded-full border bg-background/90 px-3 py-1.5 text-xs shadow-sm backdrop-blur">
        <span>{session.user.email}</span>
        <button type="button" aria-label="Sign out" onClick={() => supabaseBrowser.auth.signOut()}><LogOut className="h-3.5 w-3.5" /></button>
      </div>
      {children}
    </>
  )
}
