import { WaitlistForm } from "@/components/waitlist-form"

interface HomePageProps {
  searchParams: Promise<{ ref?: string }>
}

export default async function Home({ searchParams }: HomePageProps) {
  const params = await searchParams
  return <WaitlistForm refParam={params.ref ?? ""} />
}
