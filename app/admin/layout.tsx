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
  const [code, setCode] = useState("")
  const [codeSent, setCodeSent] = useState(false)
  const [sending, setSending] = useState(false)
  const [verifying, setVerifying] = useState(false)

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
    try {
      const { error } = await supabaseBrowser.auth.signInWithOtp({
        email: email.trim(),
        options: { shouldCreateUser: true },
      })
      if (error) throw error
      setCodeSent(true)
      setMessage("A one-time code was sent to your email.")
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not send the code. Please try again.")
    } finally {
      setSending(false)
    }
  }

  const verifyCode = async () => {
    setMessage(null)
    setVerifying(true)
    try {
      const { error } = await supabaseBrowser.auth.verifyOtp({
        email: email.trim(),
        token: code.trim(),
        type: "email",
      })
      if (error) throw error
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "That code is invalid or expired.")
    } finally {
      setVerifying(false)
    }
  }

  if (loading) return <div className="min-h-screen grid place-items-center"><Loader2 className="h-6 w-6 animate-spin" /></div>

  if (!session) {
    return (
      <main className="min-h-screen grid place-items-center p-6 bg-muted/30">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Otterra Admin</CardTitle>
            <CardDescription>We will email a one-time code to an authorized administrator.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <label className="block space-y-1.5 text-sm">
              <span>Email</span>
              <input
                className="h-10 w-full rounded-md border bg-background px-3"
                type="email"
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value)
                  setCodeSent(false)
                  setCode("")
                }}
                autoComplete="email"
                disabled={codeSent}
              />
            </label>
            {codeSent && (
              <label className="block space-y-1.5 text-sm">
                <span>Verification code</span>
                <input
                  className="h-10 w-full rounded-md border bg-background px-3 text-center font-mono text-lg tracking-[0.3em]"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={10}
                  value={code}
                  onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 10))}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && code.length >= 6) void verifyCode()
                  }}
                />
              </label>
            )}
            {codeSent ? (
              <div className="space-y-2">
                <Button className="w-full" onClick={verifyCode} disabled={verifying || code.length < 6}>
                  {verifying ? "Verifying…" : "Verify and sign in"}
                </Button>
                <Button variant="ghost" className="w-full" onClick={() => { setCodeSent(false); setCode(""); setMessage(null) }}>
                  Use a different email
                </Button>
              </div>
            ) : (
              <Button className="w-full" onClick={signIn} disabled={sending || !email.trim()}>
                {sending ? "Sending…" : "Email me a code"}
              </Button>
            )}
            {message && <p className="text-sm text-muted-foreground">{message}</p>}
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
