import { PrejoinView } from '@/components/join/PrejoinView'

export default async function PrejoinPage({ params }: { params: Promise<{ roomCode: string }> }) {
  const { roomCode } = await params
  return <PrejoinView roomCode={roomCode} />
}
