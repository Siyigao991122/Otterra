"use client"

import React from "react"

type Props = {
  onError?: (err: unknown) => void
  fallback?: React.ReactNode
  children: React.ReactNode
}

type State = { hasError: boolean }

export class ModelErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  componentDidCatch(error: unknown) {
    this.props.onError?.(error)
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback ?? null
    }
    return this.props.children
  }
}