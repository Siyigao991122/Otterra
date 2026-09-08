"use client"

import { Suspense, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { AlertCircle, Loader2 } from "lucide-react"
import Link from "next/link"
import { Logo } from "@/components/logo"

function AccessForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [code, setCode] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!code.trim() || loading) return
    setLoading(true)
    setError(null)

    try {
      const res = await fetch("/api/access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: code.trim() }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data?.error || "Incorrect invite code.")
        setLoading(false)
        return
      }
      const requestedNext = searchParams.get("next")
      const next =
        requestedNext?.startsWith("/") && !requestedNext.startsWith("//")
          ? requestedNext
          : "/design"
      router.push(next)
      router.refresh()
    } catch {
      setError("Something went wrong. Please try again.")
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-8">
      <Card className="w-full max-w-sm p-8 bg-card border-border">
        <Logo className="mb-6" />
        <h1 className="text-xl font-semibold mb-1">Otterra is invite-only</h1>
        <p className="text-sm text-muted-foreground mb-6">
          Enter the personal invite code sent to you to access the floor plan studio.
        </p>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Label htmlFor="invite-code">Invite code</Label>
            <Input
              id="invite-code"
              type="password"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Enter code"
              autoFocus
              className="mt-1.5"
            />
          </div>
          {error && (
            <div className="flex items-center gap-2 text-destructive text-sm p-3 rounded-lg bg-destructive/10">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <p>{error}</p>
            </div>
          )}
          <Button type="submit" className="w-full gap-2" disabled={!code.trim() || loading}>
            {loading && <Loader2 className="w-4 h-4 animate-spin" />}
            Continue
          </Button>
        </form>
        <p className="mt-6 text-center text-sm text-muted-foreground">
          Don&apos;t have a code?{" "}
          <Link href="/" className="text-primary hover:underline">
            Join the waitlist
          </Link>
        </p>
      </Card>
    </div>
  )
}

export default function AccessPage() {
  return (
    <Suspense fallback={null}>
      <AccessForm />
    </Suspense>
  )
}
