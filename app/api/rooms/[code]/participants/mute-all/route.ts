import { NextResponse, type NextRequest } from 'next/server'
import { getRouteAuth } from '@/lib/server/auth'
import { getServiceClient } from '@/lib/supabase.server'
import { muteAllParticipantsAudio } from '@/lib/server/livekit'
import { apiError } from '@/lib/server/api-response'
import { authorizeHostRoomAction } from '@/lib/server/rooms-logic'
import { buildHostMediaIdentity } from '@/lib/server/join-policy'

// `[code]` は uuid（rooms.id）として解釈する（mute/route.ts と同じ。理由は ../../route.ts）。
type RouteParams = { params: Promise<{ code: string }> }

/**
 * POST /api/rooms/{id}/participants/mute-all —— 司会者以外の全員をミュート（2026-08-07 追加）。
 *
 * リクエストボディは不要。除外する identity は**サーバー側で導出する**
 * （`host_<userId>`＝この房主が入室したときの identity。lib/server/join-policy.ts の
 * buildHostMediaIdentity が唯一の事実源）。クライアントに「誰を除外するか」を
 * 送らせない設計にすることで、UI のバグや細工で司会者だけ生き残る／逆に司会者が
 * 黙らされる、といった食い違いが起きない。
 *
 * 部分失敗では中断しない：muted / skipped / failed の件数を集計して返す。
 * failed > 0 なら「一部の参加者はミュートできなかった」と UI で伝えること。
 */
export async function POST(_request: NextRequest, { params }: RouteParams) {
  const { code: id } = await params
  const { user } = await getRouteAuth()
  if (!user) return apiError(401, 'UNAUTHORIZED', 'ログインが必要です')

  const { data: room, error } = await getServiceClient()
    .from('rooms')
    .select('id, media_room_name')
    .eq('id', id)
    .eq('owner_id', user.id)
    .maybeSingle()

  if (error) {
    console.error('[api/rooms/:id/participants/mute-all] lookup failed', error)
    return apiError(500, 'INTERNAL_ERROR', '一括ミュートに失敗しました')
  }

  const auth = authorizeHostRoomAction(user.id, room)
  if (!auth.ok) return apiError(auth.status, auth.code, auth.message)
  if (!room) return apiError(404, 'ROOM_NOT_FOUND', 'ルームが見つかりません') // 型の絞り込み用

  const result = await muteAllParticipantsAudio(room.media_room_name, buildHostMediaIdentity(user.id))

  // null = 参加者一覧すら引けなかった＝何も実行していない。「0 人ミュートした」と
  // 返すと UI が「全員黙った」と誤解するので、明確に失敗として返す。
  if (result === null) return apiError(500, 'INTERNAL_ERROR', '一括ミュートに失敗しました')

  return NextResponse.json(result)
}
