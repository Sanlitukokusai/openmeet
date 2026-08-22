import { NextResponse, type NextRequest } from 'next/server'
import { getRouteAuth } from '@/lib/server/auth'
import { getServiceClient } from '@/lib/supabase.server'
import { muteParticipantAudio } from '@/lib/server/livekit'
import { apiError } from '@/lib/server/api-response'
import { authorizeHostRoomAction, muteFailureToApiError, muteParticipantSchema } from '@/lib/server/rooms-logic'

// `[code]` は物理セグメント名（理由は ../../route.ts のコメント参照）。
// 本 handler は房主操作なので **uuid（rooms.id）** として解釈する
// ——PATCH / DELETE / end と同じ扱い。
type RouteParams = { params: Promise<{ code: string }> }

/**
 * POST /api/rooms/{id}/participants/mute —— 司会者による個別ミュート（2026-08-07 追加）。
 *
 * ★ サーバー側強制：LiveKit の管理 API（RoomServiceClient.mutePublishedTrack）で
 *   発行済みトラックを実際に止める。クライアントへの「お願い」ではないので、
 *   対象参加者が細工したブラウザを使っていても音は止まる。
 *
 * 鉴权：ログイン中 かつ rooms.owner_id が一致すること。他人の部屋も存在しない
 * 部屋も同じ 0 行ヒット＝404（room id の存在探査を防ぐ。§6.1 の既存 route と同設計）。
 *
 * 司会者が自分自身を指定することは禁じていない（API 的には通す）。UI 側では
 * 自分のマイクはローカルで切れば済むので通常は使わない。
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { code: id } = await params
  // 401 を最優先（既存の POST /api/rooms・PATCH /api/rooms/{id} と同じ順序）。
  // 部外者にはボディの妥当性すら教えない。
  const { user } = await getRouteAuth()
  if (!user) return apiError(401, 'UNAUTHORIZED', 'ログインが必要です')

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return apiError(400, 'VALIDATION_ERROR', '不正な JSON です')
  }

  const parsed = muteParticipantSchema.safeParse(body)
  if (!parsed.success) {
    return apiError(400, 'VALIDATION_ERROR', parsed.error.issues[0]?.message ?? '入力内容を確認してください')
  }
  const { identity, muted } = parsed.data

  const { data: room, error } = await getServiceClient()
    .from('rooms')
    .select('id, media_room_name')
    .eq('id', id)
    .eq('owner_id', user.id)
    .maybeSingle()

  if (error) {
    console.error('[api/rooms/:id/participants/mute] lookup failed', error)
    return apiError(500, 'INTERNAL_ERROR', 'ミュート操作に失敗しました')
  }

  const auth = authorizeHostRoomAction(user.id, room)
  if (!auth.ok) return apiError(auth.status, auth.code, auth.message)
  if (!room) return apiError(404, 'ROOM_NOT_FOUND', 'ルームが見つかりません') // 型の絞り込み用（上で担保済み）

  const result = await muteParticipantAudio(room.media_room_name, identity, muted)

  // 旁聴参加者（音声トラック無し）や既に退出済みの相手は**通常運転**の異常系。
  // ただし「何も起きなかった」ことは必ずエラーとして返す——成功で返すと UI が嘘をつく。
  // 理由 → HTTP の写像表は rooms-logic.ts（単測あり）。
  if (!result.ok) {
    const mapped = muteFailureToApiError(result.reason)
    return apiError(mapped.status, mapped.code, mapped.message)
  }

  return NextResponse.json({ identity, muted, trackCount: result.trackCount })
}
