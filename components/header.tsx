"use client"

import Link from "next/link"
import { Button } from "@/components/ui/button"
import { MessageSquare, Download, Undo2, Redo2, Save, Sparkles } from "lucide-react"

interface HeaderProps {
  showChat: boolean
  onToggleChat: () => void
  hasFloorPlan: boolean
}

export function Header({ showChat, onToggleChat, hasFloorPlan }: HeaderProps) {
  return (
    <header className="flex items-center justify-between px-6 h-16 border-b border-border bg-card">
      <div className="flex items-center gap-3">
        <Link href="/" className="flex items-center gap-2 hover:opacity-80 transition-opacity">
          <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
            <Sparkles className="w-5 h-5 text-primary-foreground" />
          </div>
          <span className="text-xl font-semibold tracking-tight">Otterra</span>
          <span className="text-xs px-2 py-0.5 rounded-full bg-primary/20 text-primary font-medium">AI</span>
        </Link>
      </div>

      <div className="flex items-center gap-2">
        {!hasFloorPlan && (
          <Link href="/waitlist">
            <Button variant="outline" size="sm">
              Join Waitlist
            </Button>
          </Link>
        )}

      {hasFloorPlan && (
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 mr-4">
            <Button variant="ghost" size="icon" className="h-9 w-9">
              <Undo2 className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" className="h-9 w-9">
              <Redo2 className="h-4 w-4" />
            </Button>
          </div>

          <Button variant="ghost" size="sm" className="gap-2">
            <Save className="h-4 w-4" />
            Save
          </Button>

          <Button variant="ghost" size="sm" className="gap-2">
            <Download className="h-4 w-4" />
            Export
          </Button>

          <Button variant={showChat ? "default" : "outline"} size="sm" className="gap-2" onClick={onToggleChat}>
            <MessageSquare className="h-4 w-4" />
            AI Assistant
          </Button>
        </div>
      )}
      </div>
    </header>
  )
}
