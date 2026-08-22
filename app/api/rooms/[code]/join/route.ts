import { NextResponse, type NextRequest } from 'next/server'
import { nanoid } from 'nanoid'
import { getRouteAuth } from '@/lib/server/auth'
import { getServiceClient } from '@/lib/supabase.server'
import { isValidRoomCode, normalizeRoomCode } from '@/lib/room-code'
import { apiError } from '@/lib/server/api-response'
import { verifyRoomPassword } from '@/lib/server/password'
import { registerJoinAttempt, resetJoinAttempts } from '@/lib/server/rate-limit'
import { countActiveParticipants, createMeeting, findActiveMeetingId, insertParticipant } from '@/lib/server/meetings'
import { ensureLiveKitRoom, issueJoinToken } from '@/lib/server/livekit'
import { getCapacitySnapshot } from '@/lib/server/capacity'
import {
  buildMediaIdentity,
  checkCapacity,
  checkGlobalCapacity,
  checkJoinGate,
  checkPasswordGate,
  computeTokenTtlSeconds,
  joinRequestSchema,
  resolveClientIp,
  resolveJoinRole,
  type JoinSession,
} from '@/lib/server/join-policy'
import type { ProviderConfig } from '@/lib/media/types'

// `[code]` は物理セグメント名（理由は ../route.ts のコメント）。
// 本 handler は §6.2 なので **roomCode** として解釈する。
type RouteParams = { params: Promise<{ code: string }> }

/** §6.2 の 200 応答。config は §3.2 の ProviderConfig をそのまま透過させる。 */
interface JoinResponse {
  config: ProviderConfig
  role: 'host' | 'guest'
  participantId: string
  maxParticipants: number
}

// password_hash を含むのは bcrypt 照合のためだけ。**レスポンスには絶対に出さない**
// （策略層へ渡す RoomSnapshot でも boolean に潰している）。
const ROOM_SELECT =
  'id, owner_id, status, expires_at, title, require_login, password_hash, max_participants, media_room_name'

/**
 * POST /api/rooms/{roomCode}/join —— 公開エンドポイント（§6.2）。
 *
 * ★ 判定順序（セキュリティ契約。単一の事実源は lib/server/join-policy.ts の
 *   evaluateJoin()。この route はまったく同じ順序でステージ関数を呼び、
 *   高価な IO——限流 RPC / bcrypt / 人数カウント——をそこへ到達したときだけ実行する）：
 *
 *   1. ルーム不在                 → 404 ROOM_NOT_FOUND
 *   2. expired                    → 410 ROOM_EXPIRED
 *      ended / disabled           → 410 ROOM_ENDED
 *   3. require_login かつ未ログイン → 403 LOGIN_REQUIRED
 *   3.5 サーバー全体が満杯         → 503 SERVER_AT_CAPACITY（2026-08-07 追加）
 *   4. 有密码房間のみ：限流 → 429 TOO_MANY_ATTEMPTS、続けて bcrypt → 400 INVALID_PASSWORD
 *   5. 満員                        → 409 ROOM_FULL（§12.8 サーバー側強制）
 *   6. 通過 → meetings を find-or-create、participants を作成、AccessToken を発行
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { code } = await params
  const roomCode = normalizeRoomCode(code)

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return apiError(400, 'VALIDATION_ERROR', '不正な JSON です')
  }

  const parsed = joinRequestSchema.safeParse(body)
  if (!parsed.success) {
    return apiError(400, 'VALIDATION_ERROR', parsed.error.issues[0]?.message ?? '入力内容を確認してください')
  }
  const input = parsed.data

  // 匿名でも通す。ログインが要るかどうかは策略層（require_login）が決める。
  const { user } = await getRouteAuth()
  const session: JoinSession = { userId: user?.id ?? null }

  // 形式不正な roomCode は DB を引かずに「不在」扱い（＝最終的に 404）。
  let room: Awaited<ReturnType<typeof fetchRoom>> = null
  if (isValidRoomCode(roomCode)) {
    try {
      room = await fetchRoom(roomCode)
    } catch (err) {
      console.error('[api/rooms/:code/join] lookup failed', err)
      return apiError(500, 'INTERNAL_ERROR', 'ルーム情報の取得に失敗しました')
    }
  }

  const now = new Date()
  // ★ password_hash はここで boolean に潰す。以降のレイヤーはハッシュを見ない。
  const snapshot = room
    ? {
        status: room.status,
        expires_at: room.expires_at,
        title: room.title,
        require_login: room.require_login,
        has_password: room.password_hash !== null,
        max_participants: room.max_participants,
        owner_id: room.owner_id,
      }
    : null

  // ---- ステージ 1：存在・状態・ログイン要否 ----
  const gate = checkJoinGate(snapshot, session, now)
  if (!gate.ok) return apiError(gate.status, gate.code, gate.message)
  // checkJoinGate が room=null を必ず弾くので到達しない。型の絞り込み用ガード。
  if (!room) return apiError(500, 'INTERNAL_ERROR', 'ルーム情報の取得に失敗しました')

  // ---- ステージ 1.5：全局容量闸（2026-08-07）----
  // 位置の理由：**ルームの存在・状態チェックの後、限流とパスワード照合の前**。
  //   - 存在しない / 終了済みのルームには「混雑しています」と答えない
  //     （存在探査に誤った希望を与えないため、そちらの拒否を先に出す）
  //   - サーバーが満杯なら、どのみち入れない。その状態で bcrypt を焼くのも、
  //     限流カウンタを進める（＝混雑解消後に正規利用者が 429 で締め出される）のも有害
  const globalCapacity = await getCapacitySnapshot()
  const globalGate = checkGlobalCapacity(globalCapacity.current, globalCapacity.max)
  if (!globalGate.ok) return apiError(globalGate.status, globalGate.code, globalGate.message)

  // ---- ステージ 2：限流 →（通れば）パスワード照合（§12.3）----
  const clientIp = resolveClientIp(request.headers.get('x-forwarded-for'), request.headers.get('x-real-ip'))
  let rateLimitAllowed: boolean | null = null
  let passwordMatches: boolean | null = null
  if (gate.requiresPassword && room.password_hash !== null) {
    // 無密码房間はここに来ない＝カウントもしない（リロードして入り直すだけの
    // 正常な利用者を巻き込まないため。総当たりの標的がそもそも無い）。
    rateLimitAllowed = await registerJoinAttempt(roomCode, clientIp)
    if (rateLimitAllowed) {
      // 上限超過時は bcrypt すら回さない（攻撃者に CPU を使わせない）。
      passwordMatches = await verifyRoomPassword(input.password ?? '', room.password_hash)
    }
  }

  const passwordGate = checkPasswordGate(gate.requiresPassword, { rateLimitAllowed, passwordMatches })
  if (!passwordGate.ok) return apiError(passwordGate.status, passwordGate.code, passwordGate.message)
  if (gate.requiresPassword) await resetJoinAttempts(roomCode, clientIp)

  // ---- ステージ 3：人数上限（§12.8）----
  // 進行中の会議が無ければ在室 0 人。**参照に失敗したら 0 とみなさず 500 で止める**
  // ——上限強制が目的なので、分からないまま通してはいけない。
  const meetingId = await findActiveMeetingId(room.id)
  if (meetingId === undefined) return apiError(500, 'INTERNAL_ERROR', '会議情報の取得に失敗しました')
  const activeCount = meetingId === null ? 0 : await countActiveParticipants(meetingId)
  if (activeCount === undefined) return apiError(500, 'INTERNAL_ERROR', '会議情報の取得に失敗しました')

  // 策略層へは必要な列だけを渡す（password_hash を含む row をそのまま渡さない）。
  const capacity = checkCapacity({ max_participants: room.max_participants }, activeCount)
  if (!capacity.ok) return apiError(capacity.status, capacity.code, capacity.message)

  // ---- 通過：会議・参加者レコード ----
  // 満員判定を通ってから create する（拒否された入室で空の meeting を作らないため）。
  const targetMeetingId = meetingId ?? (await createMeeting(room.id))
  if (!targetMeetingId) return apiError(500, 'INTERNAL_ERROR', '会議の開始に失敗しました')

  const role = resolveJoinRole({ owner_id: room.owner_id }, session)
  const mediaIdentity = buildMediaIdentity(role, session.userId, nanoid(12))
  const participantId = await insertParticipant({
    meeting_id: targetMeetingId,
    user_id: session.userId,
    media_identity: mediaIdentity,
    display_name: input.displayName,
    role,
  })
  if (!participantId) return apiError(500, 'INTERNAL_ERROR', '参加者情報の登録に失敗しました')

  // ---- token 発行（§7.3）----
  const ttlSeconds = computeTokenTtlSeconds(room.expires_at, now)
  const token = await issueJoinToken({
    identity: mediaIdentity,
    displayName: input.displayName,
    mediaRoomName: room.media_room_name,
    role,
    ttlSeconds,
  })

  // 第二の防波堤（§12.8）。ベストエフォートなので失敗しても入室は止めない。
  await ensureLiveKitRoom(room.media_room_name, room.max_participants)

  const response: JoinResponse = {
    config: { provider: 'livekit', serverUrl: process.env.NEXT_PUBLIC_LIVEKIT_URL!, token },
    role,
    participantId,
    maxParticipants: room.max_participants,
  }
  return NextResponse.json(response)
}

async function fetchRoom(roomCode: string) {
  const { data, error } = await getServiceClient()
    .from('rooms')
    .select(ROOM_SELECT)
    .eq('room_code', roomCode)
    .maybeSingle()

  if (error) throw error
  return data
}
