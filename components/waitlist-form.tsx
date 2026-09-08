"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import Image from "next/image"
import { ArrowRight, Check, ChevronRight, Layers3, Move3d, Ruler, Sparkles, Upload } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

const ROLES = [
  ["", "I am a…"], ["renter", "Renter"], ["homeowner", "Homeowner"],
  ["designer", "Interior designer"], ["agent", "Real estate professional"], ["other", "Other"],
]

export function WaitlistForm({ refParam }: { refParam: string }) {
  const [email, setEmail] = useState("")
  const [name, setName] = useState("")
  const [role, setRole] = useState("")
  const [company, setCompany] = useState("")
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle")
  const [message, setMessage] = useState("")
  const [referralLink, setReferralLink] = useState("")
  const [roomProgress, setRoomProgress] = useState(0)

  useEffect(() => {
    const updateRoomProgress = () => {
      const section = document.getElementById("room-reveal")
      if (!section) return
      const roomStage = document.getElementById("room-stage")
      if (!roomStage) return
      const rect = roomStage.getBoundingClientRect()
      const centeredTop = (window.innerHeight - rect.height) / 2
      const animationDistance = Math.max(window.innerHeight * .28, 220)
      const progress = (centeredTop + animationDistance - rect.top) / animationDistance
      setRoomProgress(Math.max(0, Math.min(1, progress)))
    }
    updateRoomProgress()
    window.addEventListener("scroll", updateRoomProgress, { passive: true })
    window.addEventListener("resize", updateRoomProgress)
    return () => {
      window.removeEventListener("scroll", updateRoomProgress)
      window.removeEventListener("resize", updateRoomProgress)
    }
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault(); setStatus("loading"); setMessage("")
    try {
      const res = await fetch("/api/waitlist", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: email.trim(), name: name.trim() || undefined, role: role || undefined, ref: refParam || undefined, company: company || undefined }) })
      const data = await res.json()
      if (!res.ok) { setStatus("error"); setMessage(data.error || "Something went wrong."); return }
      setStatus("success")
      setReferralLink(`${window.location.origin}/waitlist?ref=${encodeURIComponent(email.trim())}`)
    } catch { setStatus("error"); setMessage("Network error. Please try again.") }
  }

  function Fields({ compact = false }: { compact?: boolean }) {
    if (status === "success") return <div className="rounded-3xl bg-[#ebe4d8] p-6"><div className="mb-3 grid h-9 w-9 place-items-center rounded-full bg-[#78614b] text-white"><Check className="h-4 w-4" /></div><p className="font-serif text-2xl">You&apos;re on the list.</p><p className="mt-2 text-sm text-[#6b5d50]">Share your private referral link.</p><div className="mt-4 break-all rounded-xl bg-white/70 p-3 font-mono text-xs">{referralLink}</div><div className="mt-4 flex gap-2"><Button variant="outline" onClick={() => navigator.clipboard.writeText(referralLink)}>Copy link</Button><Button asChild className="bg-[#3a3028] text-white"><Link href="/access?next=%2Fdesign">Enter code</Link></Button></div></div>
    const suffix = compact ? "-bottom" : ""
    return <form onSubmit={handleSubmit} className="space-y-3">
      <div className={compact ? "grid gap-3 sm:grid-cols-2" : "space-y-3"}>
        <Label className="sr-only" htmlFor={`email${suffix}`}>Email</Label><Input id={`email${suffix}`} type="email" placeholder="Email address" value={email} onChange={e => setEmail(e.target.value)} required disabled={status === "loading"} className="h-12 rounded-full border-[#c8b9a9] bg-white/80 px-5 shadow-none" />
        <Label className="sr-only" htmlFor={`name${suffix}`}>Name</Label><Input id={`name${suffix}`} placeholder="Your name" value={name} onChange={e => setName(e.target.value)} disabled={status === "loading"} className="h-12 rounded-full border-[#c8b9a9] bg-white/80 px-5 shadow-none" />
      </div>
      <div className={compact ? "grid gap-3 sm:grid-cols-[1fr_auto]" : "space-y-3"}>
        <Label className="sr-only" htmlFor={`role${suffix}`}>Role</Label><select id={`role${suffix}`} value={role} onChange={e => setRole(e.target.value)} className="h-12 w-full rounded-full border border-[#c8b9a9] bg-white/80 px-5 text-sm text-[#66584c] outline-none">{ROLES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
        <Button disabled={status === "loading"} className="h-12 rounded-full bg-[#3a3028] px-7 text-white hover:bg-[#55463a]">{status === "loading" ? "Joining…" : "Join the waitlist"}<ArrowRight className="ml-2 h-4 w-4" /></Button>
      </div>
      <div className="hidden"><Label htmlFor={`company${suffix}`}>Company</Label><Input id={`company${suffix}`} tabIndex={-1} value={company} onChange={e => setCompany(e.target.value)} /></div>
      {status === "error" && <p className="text-sm text-red-700">{message}</p>}<p className="text-xs text-[#7c6d60]">Private beta. We&apos;ll only email you about early access.</p>
    </form>
  }

  const steps = [[Upload, "01", "Build", "Upload a floor plan and watch Otterra shape it into a true-to-scale room."], [Sparkles, "02", "Furnish", "Explore AI ideas and place real furniture from a curated catalog."], [Layers3, "03", "See it", "Swap, compare, and understand the whole room before spending a dollar."]] as const
  const features = [[Ruler, "Made to fit", "True dimensions help you avoid pieces that overwhelm—or disappear inside—your room."], [Move3d, "Made to explore", "Walk around your ideas in 3D and make changes while they are still easy."], [Layers3, "Made to finish", "Keep the room, furniture, and total vision together instead of juggling tabs."]] as const
  const furnitureLayers = [
    { src: "/otterra-sofa-v1.png", brand: "Article", item: "Modular sofa", from: 620, left: "22%", bottom: "10%", width: "70%", z: 2 },
    { src: "/otterra-chair-v1.png", brand: "HAY", item: "Bouclé lounge chair", from: -500, left: "1%", bottom: "7%", width: "30%", z: 4 },
    { src: "/otterra-table-v1.png", brand: "West Elm", item: "Walnut table", from: 520, left: "34%", bottom: "-2%", width: "40%", z: 5 },
    { src: "/otterra-lamp-v1.png", brand: "CB2", item: "Arc floor lamp", from: -460, left: "12%", bottom: "18%", width: "20%", z: 3 },
  ]

  return <main className="min-h-screen overflow-hidden bg-[#f4f0e8] text-[#30271f]">
    <header className="relative z-20 mx-auto flex max-w-7xl items-center justify-between px-6 py-6 lg:px-10">
      <Link href="/" className="group inline-flex items-baseline" aria-label="Otterra home"><span className="font-serif text-[1.75rem] tracking-[-0.045em] text-[#30271f] transition-opacity group-hover:opacity-70">Otterra</span><span className="ml-1 h-1.5 w-1.5 rounded-full bg-[#9a795d]" aria-hidden="true" /></Link>
      <nav className="hidden gap-8 text-sm text-[#695a4d] md:flex"><a href="#how">How it works</a><a href="#why">Why Otterra</a></nav>
      <Button asChild variant="ghost" className="rounded-full"><Link href="/access?next=%2Fdesign">I have an invite <ChevronRight className="ml-1 h-4 w-4" /></Link></Button>
    </header>

    <section id="room-reveal" className="relative mx-auto min-h-[1500px] max-w-7xl px-6 pb-24 pt-10 lg:px-10">
      <div className="relative z-10 mx-auto max-w-3xl text-center"><div className="mb-7 inline-flex items-center gap-2 rounded-full border border-[#cdbdab] bg-white/50 px-4 py-2 text-xs uppercase tracking-[.18em] text-[#725f4e]"><span className="h-1.5 w-1.5 rounded-full bg-[#a77c55]" />Now welcoming early members</div>
        <h1 className="font-serif text-[clamp(3.5rem,7vw,6.6rem)] leading-[.89] tracking-[-.055em]">Your space,<br /><span className="italic text-[#8b6c50]">before</span> it exists.</h1>
        <p className="mx-auto mt-8 max-w-2xl text-lg leading-8 text-[#6a5c50]">Turn any floor plan into a furnished 3D home. Explore real pieces and design with confidence—before you buy.</p>
        <div className="mx-auto mt-9 max-w-lg rounded-[2rem] border border-[#d4c6b7] bg-[#fbf8f2]/80 p-5 text-left shadow-[0_24px_70px_rgba(73,55,38,.1)]"><Fields /></div>
      </div>
      <div id="room-stage" className="sticky top-20 mx-auto mt-28 w-full max-w-[920px]"><div className="absolute -inset-12 rounded-full bg-[#d8c5ad]/55 blur-3xl" />
        <div className="relative rotate-[1.5deg] rounded-[2rem] border border-white/80 bg-[#e5d6c5] p-3 shadow-[0_40px_100px_rgba(73,55,38,.22)]"><div className="overflow-hidden rounded-[1.35rem] bg-[#f8f5ef]"><div className="flex h-12 items-center justify-between border-b border-[#ded5c9] px-5"><span className="flex gap-2"><i className="h-2.5 w-2.5 rounded-full bg-[#d6a583]" /><i className="h-2.5 w-2.5 rounded-full bg-[#dfc7a5]" /><i className="h-2.5 w-2.5 rounded-full bg-[#9daf93]" /></span><span className="text-[10px] uppercase tracking-[.18em] text-[#8c7e71]">Living room · 3D view</span><Move3d className="h-4 w-4 text-[#8c7e71]" /></div>
          <div className="relative min-h-[500px] overflow-hidden bg-[#ddd2c5]">
            <Image src="/otterra-empty-room-v1.png" alt="An empty warm contemporary living room" fill priority className="object-cover" sizes="(min-width: 1024px) 700px, 100vw" />
            {furnitureLayers.map((furniture) => {
              const reveal = roomProgress
              return <div key={furniture.src} className="absolute" style={{ left: furniture.left, bottom: furniture.bottom, width: furniture.width, zIndex: furniture.z, opacity: reveal, transform: `translateX(${furniture.from * (1 - reveal)}px) scale(${.9 + reveal * .1})`, filter: `blur(${(1 - reveal) * 3}px)` }}>
                <Image src={furniture.src} alt={`${furniture.brand} ${furniture.item}`} width={900} height={600} className="h-auto w-full object-contain drop-shadow-[0_18px_18px_rgba(60,42,27,.24)]" />
                <div className="absolute left-1/2 top-[48%] -translate-x-1/2 whitespace-nowrap rounded-xl border border-white/70 bg-white/90 px-3 py-2 shadow-lg backdrop-blur"><p className="text-[8px] uppercase tracking-[.15em] text-[#8b6c50]">{furniture.brand} · sample</p><p className="mt-0.5 text-[10px] font-medium">{furniture.item}</p></div>
              </div>
            })}
            <div className="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-black/35 to-transparent" /><div className="absolute bottom-5 left-5 rounded-full bg-white/90 px-4 py-2 text-[10px] font-medium shadow-lg backdrop-blur">Scroll to furnish · {Math.round(roomProgress * 100)}%</div><div className="absolute bottom-5 right-5 rounded-full bg-[#3a3028] px-4 py-2 text-[10px] text-white shadow-lg">Shop this room</div>
          </div></div></div>
        <div className="absolute -bottom-8 -left-4 rounded-2xl border border-white/70 bg-[#fbf8f2]/95 p-4 shadow-xl sm:-left-12"><p className="text-[10px] uppercase tracking-[.18em] text-[#8b7a6b]">Room fit</p><p className="mt-1 font-serif text-xl">Perfectly scaled</p><p className="mt-2 flex items-center gap-2 text-xs"><Ruler className="h-3.5 w-3.5" />Dimensions checked</p></div>
      </div>
    </section>

    <section id="how" className="bg-[#342a23] px-6 py-24 text-[#f4eee6] lg:px-10"><div className="mx-auto grid max-w-7xl gap-10 lg:grid-cols-[.75fr_1.25fr]"><div><p className="text-xs uppercase tracking-[.22em] text-[#c2a98f]">From plan to place</p><h2 className="mt-5 font-serif text-5xl leading-[1.02] sm:text-6xl">A home you can feel, before move-in day.</h2></div><div className="grid gap-px overflow-hidden rounded-[2rem] bg-[#665548] sm:grid-cols-3">{steps.map(([Icon,n,t,c])=><article key={n} className="min-h-[330px] bg-[#40342c] p-7"><div className="flex justify-between text-[#c9af96]"><Icon className="h-5 w-5" /><span>{n}</span></div><h3 className="mt-24 font-serif text-3xl">{t}</h3><p className="mt-4 text-sm leading-6 text-[#c9beb4]">{c}</p></article>)}</div></div></section>
    <section id="why" className="px-6 py-24 lg:px-10"><div className="mx-auto max-w-7xl"><div className="mx-auto max-w-3xl text-center"><p className="text-xs uppercase tracking-[.22em] text-[#8a6d52]">Designed for real life</p><h2 className="mt-5 font-serif text-5xl leading-tight sm:text-6xl">Less guessing.<br /><span className="italic text-[#8b6c50]">More belonging.</span></h2><p className="mt-6 text-lg leading-8 text-[#6c5e52]">Moving is already hard. Otterra brings planning, styling, and shopping into one calm, visual experience.</p></div><div className="mt-16 grid gap-5 md:grid-cols-3">{features.map(([Icon,t,c])=><article key={t} className="rounded-[2rem] border border-[#d5c8b8] bg-[#faf7f1] p-8"><span className="grid h-11 w-11 place-items-center rounded-full bg-[#e4d7c8] text-[#725b48]"><Icon className="h-5 w-5" /></span><h3 className="mt-8 font-serif text-2xl">{t}</h3><p className="mt-3 text-sm leading-6 text-[#75675b]">{c}</p></article>)}</div></div></section>
    <section className="px-6 pb-24 lg:px-10"><div className="mx-auto grid max-w-7xl items-center gap-10 rounded-[2.5rem] bg-[#d8c2aa] px-6 py-16 sm:px-12 lg:grid-cols-[.85fr_1.15fr] lg:px-20"><div><p className="text-xs uppercase tracking-[.22em] text-[#6b5441]">Private beta</p><h2 className="mt-4 font-serif text-5xl leading-tight">Make yourself<br />at home, sooner.</h2><p className="mt-5 max-w-md leading-7 text-[#655446]">Join the waitlist. Early members will receive a personal invite code when their place opens.</p></div><div className="rounded-[2rem] bg-[#f7f2e9]/85 p-6"><Fields compact /></div></div></section>
    <footer className="border-t border-[#d8cdbf] px-6 py-8"><div className="mx-auto flex max-w-7xl flex-col gap-4 text-sm text-[#7a6b5e] sm:flex-row sm:items-center sm:justify-between"><div><Link href="/" className="inline-flex items-baseline" aria-label="Otterra home"><span className="font-serif text-2xl tracking-[-0.045em] text-[#30271f]">Otterra</span><span className="ml-1 h-1.5 w-1.5 rounded-full bg-[#9a795d]" aria-hidden="true" /></Link><p className="mt-1 text-xs">© 2026 Otterra, Inc. All rights reserved.</p></div><p>From floor plans to move-in ready living.</p><Link href="/access?next=%2Fdesign">Member access</Link></div></footer>
  </main>
}
