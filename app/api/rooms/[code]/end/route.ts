import { NextResponse, type NextRequest } from 'next/server'
import { getRouteAuth } from '@/lib/server/auth'
import { getServiceClient } from '@/lib/supabase.server'
import { endLiveKitRoom } from '@/lib/server/livekit'
import { apiError } from '@/lib/server/api-response'

// `[code]` は物理セグメント名（理由は ../route.ts のコメント参照）。
// 本 handler は §6.1 の `/{id}` なので uuid として解釈する。
type RouteParams = { params: Promise<{ code: string }> }

/**
 * 会議室の「現在進行中の会議」を終了する（規格书 §6.1 POST /{id}/end）。
 * 设计决策：只把 meet.meetings 里该房间尚未结束的行补上 ended_at，并断开 LiveKit
 * 侧连接；不改动 meet.rooms.status——房间本身仍是 active，可以承载下一场会议
 * （rooms.status 的 'ended' 是留给未来「永久停用」语义的，与「结束当前一场会议」
 * 不是同一件事；DDL 也把 rooms 与 meetings 拆成两张表印证了这个设计）。
 */
export async function POST(_request: NextRequest, { params }: RouteParams) {
  const { code: id } = await params
  const { user } = await getRouteAuth()
  if (!user) return apiError(401, 'UNAUTHORIZED', 'ログインが必要です')

  const { data: room, error: roomError } = await getServiceClient()
    .from('rooms')
    .select('id, media_room_name')
    .eq('id', id)
    .eq('owner_id', user.id)
    .maybeSingle()

  if (roomError) {
    console.error('[api/rooms/:id/end] lookup failed', roomError)
    return apiError(500, 'INTERNAL_ERROR', '会議の終了に失敗しました')
  }
  if (!room) {
    return apiError(404, 'ROOM_NOT_FOUND', 'ルームが見つかりません')
  }

  const { error: meetingsError } = await getServiceClient()
    .from('meetings')
    .update({ ended_at: new Date().toISOString() })
    .eq('room_id', room.id)
    .is('ended_at', null)

  if (meetingsError) {
    console.error('[api/rooms/:id/end] meetings update failed', meetingsError)
    return apiError(500, 'INTERNAL_ERROR', '会議の終了に失敗しました')
  }

  await endLiveKitRoom(room.media_room_name)

  return NextResponse.json({ ended: true })
}
