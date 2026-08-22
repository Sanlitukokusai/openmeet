import { RoomExperience } from '@/components/room/RoomExperience'

export default async function RoomPage({ params }: { params: Promise<{ roomCode: string }> }) {
  const { roomCode } = await params
  return <RoomExperience roomCode={roomCode} />
}
