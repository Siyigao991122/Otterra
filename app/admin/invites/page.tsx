"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ArrowLeft, Copy, Loader2, Ban } from "lucide-react"

interface Invite {
  id: string
  code: string
  label: string | null
  max_uses: number
  use_count: number
  revoked: boolean
  created_at: string
  redeemed_at: string | null
}

const adminHeaders = {
  "Content-Type": "application/json",
  "x-admin-api-key": process.env.NEXT_PUBLIC_ADMIN_API_KEY ?? "",
}

function inviteStatus(invite: Invite): { label: string; className: string } {
  if (invite.revoked) return { label: "Revoked", className: "text-destructive" }
  if (invite.use_count >= invite.max_uses) return { label: "Used up", className: "text-muted-foreground" }
  return { label: "Active", className: "text-primary" }
}

export default function AdminInvitesPage() {
  const [invites, setInvites] = useState<Invite[]>([])
  const [loading, setLoading] = useState(true)
  const [label, setLabel] = useState("")
  const [maxUses, setMaxUses] = useState("1")
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const loadInvites = async () => {
    setLoading(true)
    try {
      const res = await fetch("/api/admin/invites", { headers: adminHeaders })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || "Failed to load invites")
      setInvites(data.invites ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load invites")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadInvites()
  }, [])

  const handleCreate = async () => {
    setCreating(true)
    setError(null)
    try {
      const res = await fetch("/api/admin/invites", {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({
          label: label.trim() || undefined,
          maxUses: Number(maxUses) || 1,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || "Failed to create invite")
      setInvites((prev) => [data.invite, ...prev])
      setLabel("")
      setMaxUses("1")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create invite")
    } finally {
      setCreating(false)
    }
  }

  const handleRevoke = async (id: string) => {
    try {
      const res = await fetch(`/api/admin/invites/${id}`, {
        method: "PATCH",
        headers: adminHeaders,
        body: JSON.stringify({ revoked: true }),
      })
      if (!res.ok) throw new Error("Failed to revoke")
      setInvites((prev) => prev.map((i) => (i.id === id ? { ...i, revoked: true } : i)))
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to revoke invite")
    }
  }

  const handleCopy = (invite: Invite) => {
    navigator.clipboard.writeText(invite.code).catch(() => {})
    setCopiedId(invite.id)
    setTimeout(() => setCopiedId((prev) => (prev === invite.id ? null : prev)), 1500)
  }

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      <Link href="/admin/import" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="w-4 h-4" />
        Back to admin
      </Link>

      <Card>
        <CardHeader>
          <CardTitle>Invite codes</CardTitle>
          <CardDescription>
            Generate a unique code per person. Each code works until it hits its use limit or you revoke it —
            already-unlocked browsers stay unlocked until their cookie expires (30 days).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-3 items-end flex-wrap">
            <div className="flex-1 min-w-[200px]">
              <Label htmlFor="label">Label (optional, e.g. who it's for)</Label>
              <Input id="label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Jane" />
            </div>
            <div className="w-28">
              <Label htmlFor="max-uses">Max uses</Label>
              <Input
                id="max-uses"
                type="number"
                min={1}
                value={maxUses}
                onChange={(e) => setMaxUses(e.target.value)}
              />
            </div>
            <Button onClick={handleCreate} disabled={creating}>
              {creating && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Generate
            </Button>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Issued codes</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center gap-2 text-muted-foreground text-sm py-6 justify-center">
              <Loader2 className="w-4 h-4 animate-spin" />
              Loading…
            </div>
          ) : invites.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">No invite codes yet.</p>
          ) : (
            <div className="divide-y divide-border">
              {invites.map((invite) => {
                const status = inviteStatus(invite)
                return (
                  <div key={invite.id} className="py-3 flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <code className="font-mono text-sm font-medium">{invite.code}</code>
                        <button
                          type="button"
                          onClick={() => handleCopy(invite)}
                          className="text-muted-foreground hover:text-foreground"
                          title="Copy code"
                        >
                          <Copy className="w-3.5 h-3.5" />
                        </button>
                        {copiedId === invite.id && <span className="text-xs text-primary">Copied</span>}
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5 truncate">
                        {invite.label ? `${invite.label} · ` : ""}
                        {invite.use_count}/{invite.max_uses} used
                        {invite.redeemed_at ? ` · first used ${new Date(invite.redeemed_at).toLocaleDateString()}` : ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <span className={`text-xs font-medium ${status.className}`}>{status.label}</span>
                      {!invite.revoked && (
                        <Button variant="ghost" size="sm" onClick={() => handleRevoke(invite.id)} className="gap-1.5 text-muted-foreground">
                          <Ban className="w-3.5 h-3.5" />
                          Revoke
                        </Button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
