import Link from "next/link"

interface LogoProps {
  href?: string
  className?: string
  textClassName?: string
}

/** Serif wordmark + accent dot, matched to the landing page (components/waitlist-form.tsx). */
export function Logo({ href = "/", className = "", textClassName = "text-xl" }: LogoProps) {
  return (
    <Link
      href={href}
      className={`group inline-flex items-baseline hover:opacity-80 transition-opacity ${className}`}
      aria-label="Otterra home"
    >
      <span className={`font-serif tracking-[-0.045em] text-foreground ${textClassName}`}>Otterra</span>
      <span className="ml-1 h-1.5 w-1.5 rounded-full bg-accent" aria-hidden="true" />
    </Link>
  )
}
