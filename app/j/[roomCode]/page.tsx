import { Suspense } from 'react'
import { JoinEntryView } from '@/components/join/JoinEntryView'

// `useSearchParams()`（?left= / ?ended= / ?error= の読み取りに使用）は
// Suspense 境界の中で使う必要がある（Next.js 15 の要件）。
export default async function JoinEntryPage({ params }: { params: Promise<{ roomCode: string }> }) {
  const { roomCode } = await params
  return (
    <Suspense fallback={null}>
      <JoinEntryView roomCode={roomCode} />
    </Suspense>
  )
}
