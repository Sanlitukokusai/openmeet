import { NextResponse, type NextRequest } from 'next/server'
import { getServiceClient } from '@/lib/supabase.server'
import { isValidRoomCode, normalizeRoomCode } from '@/lib/room-code'
import { apiError } from '@/lib/server/api-response'
import { deriveRoomState } from '@/lib/server/rooms-logic'
import { countActiveParticipants, findActiveMeetingId } from '@/lib/server/meetings'
import { ROOM_META_NOT_FOUND, toRoomMetaDTO } from '@/lib/server/join-policy'

// `[code]` は物理セグメント名（理由は ../route.ts のコメント）。
// 本 handler は §6.2 なので **roomCode** として解釈する。
type RouteParams = { params: Promise<{ code: string }> }

/**
 * GET /api/rooms/{roomCode}/meta —— 公開エンドポイント（§6.2）。
 *
 * 設計上の約束：
 *  - 正常系は**常に 200**。存在しないルームでも 404 を返さない（room_code 総当たりに
 *    レスポンスコードという手掛かりを与えないため）。形状も中立な既定値で揃える。
 *    ただし DB 障害は正常系ではないので 500（「存在しない」と偽るのは誤情報）。
 *  - 返すのは §6.2 の 6 キーちょうど。password_hash / owner_id / 内部 id /
 *    media_room_name は絶対に含めない（select 白名单で物理的に取ってこない）。
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  const { code } = await params
  const roomCode = normalizeRoomCode(code)

  // 形式が明らかに不正（長さ違い・使用可能文字以外のみ）なら DB を引くまでもない。
  if (!isValidRoomCode(roomCode)) {
    return NextResponse.json(ROOM_META_NOT_FOUND)
  }

  const { data: room, error } = await getServiceClient()
    .from('rooms')
    .select('id, status, expires_at, title, require_login, password_hash, max_participants')
    .eq('room_code', roomCode)
    .maybeSingle()

  if (error) {
    console.error('[api/rooms/:code/meta] lookup failed', error)
    return apiError(500, 'INTERNAL_ERROR', 'ルーム情報の取得に失敗しました')
  }
  if (!room) {
    return NextResponse.json(ROOM_META_NOT_FOUND)
  }

  const now = new Date()
  // password_hash はここで boolean に潰し、以降のレイヤーへは渡さない。
  const snapshot = {
    status: room.status,
    expires_at: room.expires_at,
    title: room.title,
    require_login: room.require_login,
    has_password: room.password_hash !== null,
    max_participants: room.max_participants,
  }

  // 満員判定は active なルームでのみ意味を持つ。終了/期限切れならカウントを丸ごと省略。
  // カウント失敗時も null 扱い（isFull=false）——/meta は情報提供に過ぎず、
  // 実際の入場制限は POST /join 側で強制する（§12.8）ので、ここで 500 にする価値がない。
  let activeCount: number | null = null
  if (deriveRoomState(snapshot, now) === 'active') {
    const meetingId = await findActiveMeetingId(room.id)
    activeCount = typeof meetingId === 'string' ? ((await countActiveParticipants(meetingId)) ?? null) : null
  }

  return NextResponse.json(toRoomMetaDTO(snapshot, activeCount, now))
}
