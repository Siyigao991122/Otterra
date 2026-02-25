import { WaitlistForm } from "@/components/waitlist-form"

interface WaitlistPageProps {
  searchParams: Promise<{ ref?: string }>
}

export default async function WaitlistPage({ searchParams }: WaitlistPageProps) {
  const params = await searchParams
  const ref = params.ref ?? ""

  return <WaitlistForm refParam={ref} />
}
