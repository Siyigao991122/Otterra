"use client"

import { useState } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Sparkles } from "lucide-react"

const ROLES = [
  { value: "", label: "Select your role (optional)" },
  { value: "renter", label: "Renter" },
  { value: "designer", label: "Designer" },
  { value: "agent", label: "Agent" },
  { value: "other", label: "Other" },
]

interface WaitlistFormProps {
  refParam: string
}

export function WaitlistForm({ refParam }: WaitlistFormProps) {
  const [email, setEmail] = useState("")
  const [name, setName] = useState("")
  const [role, setRole] = useState("")
  const [company, setCompany] = useState("") // Honeypot
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle")
  const [message, setMessage] = useState("")
  const [referralLink, setReferralLink] = useState("")

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setStatus("loading")
    setMessage("")

    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          name: name.trim() || undefined,
          role: role || undefined,
          ref: refParam || undefined,
          company: company || undefined,
        }),
      })

      const data = await res.json()

      if (!res.ok) {
        setStatus("error")
        setMessage(data.error || "Something went wrong.")
        return
      }

      setStatus("success")
      const origin = typeof window !== "undefined" ? window.location.origin : ""
      setReferralLink(`${origin}/waitlist?ref=${encodeURIComponent(email.trim())}`)
    } catch {
      setStatus("error")
      setMessage("Network error. Please try again.")
    }
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6 bg-background">
      <div className="w-full max-w-md">
        <Link href="/" className="inline-flex items-center gap-2 text-muted-foreground hover:text-foreground mb-8">
          <Sparkles className="w-5 h-5" />
          <span className="font-semibold">Otterra</span>
        </Link>

        <Card className="border-border">
          <CardHeader className="text-center">
            <CardTitle className="text-2xl">Join the Otterra Early Access Waitlist</CardTitle>
            <CardDescription>
              Upload your floor plans and generate stunning 3D spaces with AI. Be the first to try it.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {status === "success" ? (
              <div className="space-y-4 text-center">
                <p className="text-lg font-medium text-primary">You&apos;re on the list!</p>
                <p className="text-sm text-muted-foreground">Share your referral link:</p>
                <div className="p-3 rounded-lg bg-muted text-sm break-all font-mono">
                  {referralLink}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => navigator.clipboard.writeText(referralLink)}
                >
                  Copy link
                </Button>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <Label htmlFor="email">Email *</Label>
                  <Input
                    id="email"
                    type="email"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    disabled={status === "loading"}
                    className="mt-1.5"
                  />
                </div>
                <div>
                  <Label htmlFor="name">Name (optional)</Label>
                  <Input
                    id="name"
                    type="text"
                    placeholder="Your name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    disabled={status === "loading"}
                    className="mt-1.5"
                  />
                </div>
                <div>
                  <Label htmlFor="role">Role (optional)</Label>
                  <select
                    id="role"
                    value={role}
                    onChange={(e) => setRole(e.target.value)}
                    disabled={status === "loading"}
                    className="mt-1.5 w-full h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {ROLES.map((r) => (
                      <option key={r.value} value={r.value}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="hidden" aria-hidden="true">
                  <Label htmlFor="company">Company</Label>
                  <Input
                    id="company"
                    type="text"
                    tabIndex={-1}
                    autoComplete="off"
                    value={company}
                    onChange={(e) => setCompany(e.target.value)}
                  />
                </div>
                {status === "error" && (
                  <p className="text-sm text-destructive">{message}</p>
                )}
                <Button type="submit" className="w-full" disabled={status === "loading"}>
                  {status === "loading" ? "Joining..." : "Join Waitlist"}
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
