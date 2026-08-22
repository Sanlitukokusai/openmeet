// meet.meetings / meet.participants への共通アクセス（§6.2 の /meta と /join、
// §6.3 の webhook、§6.4 の telemetry が共有）。
// 判定は一切しない——ここは純粋に IO 層。判定は lib/server/join-policy.ts / lib/server/webhooks.ts。
import 'server-only'
import { getServiceClient } from '@/lib/supabase.server'
import type { Database, Json } from '@/lib/database.types'
import { recomputePeak } from '@/lib/server/webhooks'

type ParticipantInsert = Database['meet']['Tables']['participants']['Insert']

/**
 * 「進行中の会議」= ended_at が null の meetings 行。
 * 通常は 0 件か 1 件（POST /{id}/end が全件 ended_at を埋める）。理論上複数あり得るので
 * 最新の 1 件を採用する。
 *
 * @returns 見つかった meeting の id / 無ければ null / **クエリ失敗は undefined**
 *          （呼び出し側が「無い」と「分からない」を区別できるようにするため。
 *           人数上限の強制は分からない時に通してはいけない——§12.8）
 */
export async function findActiveMeetingId(roomId: string): Promise<string | null | undefined> {
  const { data, error } = await getServiceClient()
    .from('meetings')
    .select('id')
    .eq('room_id', roomId)
    .is('ended_at', null)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    console.error('[meetings] active meeting lookup failed', error)
    return undefined
  }
  return data?.id ?? null
}

/**
 * 在室人数（left_at が null の participants 行数）。
 * ⚠️ left_at は LiveKit webhook（WP-5）が埋める。webhook 未実装のうちは退室が
 * 反映されず、カウントは単調増加する（既知の制約——WP-2 の引き継ぎメモ参照）。
 *
 * @returns 件数 / **クエリ失敗は undefined**（0 にフォールバックしてはいけない）
 */
export async function countActiveParticipants(meetingId: string): Promise<number | undefined> {
  const { count, error } = await getServiceClient()
    .from('participants')
    .select('id', { count: 'exact', head: true })
    .eq('meeting_id', meetingId)
    .is('left_at', null)

  if (error) {
    console.error('[meetings] participant count failed', error)
    return undefined
  }
  return count ?? 0
}

/**
 * 新しい会議インスタンスを開始する。findActiveMeetingId() が null を返したときだけ
 * 呼ぶこと（§7.2 の「find-or-create」の create 側）。
 *
 * 同時入室の競合は DB 側の部分ユニーク索引で潰してある（migration 0004
 * `idx_meet_meetings_one_open_per_room`：room_id ごと ended_at is null は 1 行まで）。
 * find→create の隙間に相手が割り込むと insert が 23505 で弾かれるので、
 * その場合は引き直して相手が作った行に相乗りする＝入室は成立させる。
 * これが無いと負けた側だけ 500 になる。
 *
 * @returns meeting id / 失敗時 null
 */
export async function createMeeting(roomId: string): Promise<string | null> {
  const { data, error } = await getServiceClient().from('meetings').insert({ room_id: roomId }).select('id').single()

  if (!error && data) return data.id

  // 23505 = unique_violation。競合に負けただけなので既存行を採用する。
  if (error?.code === '23505') {
    const existing = await findActiveMeetingId(roomId)
    if (existing) return existing
    // 索引に弾かれたのに引けない＝その直後に相手が会議を終了した等。ここは諦める。
    console.error('[meetings] create meeting lost the race but no active meeting found', { roomId })
    return null
  }

  console.error('[meetings] create meeting failed', error)
  return null
}

/** participants 行を 1 件作って id を返す（失敗時 null）。 */
export async function insertParticipant(payload: ParticipantInsert): Promise<string | null> {
  const { data, error } = await getServiceClient().from('participants').insert(payload).select('id').single()

  if (error || !data) {
    console.error('[meetings] insert participant failed', error)
    return null
  }
  return data.id
}

// ============================================================
// ここから下は WP-5（webhook + telemetry、規格書 §6.3 / §6.4）向けの追加。
// find-or-create 系の既存関数はそのまま流用し、ここでは webhook 特有の参照・更新だけを足す。
// ============================================================

/**
 * room.name（= media_room_name）から meet.rooms.id を引く。webhook が room_id を
 * 知らない（LiveKit 側は media_room_name しか送ってこない）ので、全イベント処理の入口で使う。
 *
 * @returns room id / 見つからなければ null（DB とズレている＝異常系だが致命ではないので
 *          呼び出し側は 200 で無視してよい） / **クエリ失敗は undefined**
 */
export async function findRoomIdByMediaRoomName(mediaRoomName: string): Promise<string | null | undefined> {
  const { data, error } = await getServiceClient()
    .from('rooms')
    .select('id')
    .eq('media_room_name', mediaRoomName)
    .maybeSingle()

  if (error) {
    console.error('[meetings] room lookup by media_room_name failed', error)
    return undefined
  }
  return data?.id ?? null
}

export interface ActiveMeetingParticipant {
  id: string
  left_at: string | null
}

/**
 * media_identity + 進行中の meeting で participants 行を 1 件引く
 * （participant_joined / participant_left 共通のマッチングルール——規格書 §6.3）。
 * 同一 identity が同一 meeting に複数行存在することは通常運転では起きないが、
 * 万一の重複に備えて最新（joined_at 降順）の 1 件を採用する。
 *
 * @returns 一致行 / 無ければ null / **クエリ失敗は undefined**
 */
export async function findParticipantForActiveMeeting(
  meetingId: string,
  mediaIdentity: string,
): Promise<ActiveMeetingParticipant | null | undefined> {
  const { data, error } = await getServiceClient()
    .from('participants')
    .select('id, left_at')
    .eq('meeting_id', meetingId)
    .eq('media_identity', mediaIdentity)
    .order('joined_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    console.error('[meetings] participant lookup by identity failed', error)
    return undefined
  }
  return data ?? null
}

/**
 * 指定 participant について、webhook の event id が既にログ済みかを調べる
 * （participant_joined の meeting_sessions 書き込みを冪等にするための唯一の手段——
 * join には leave の `left_at is null` のような自然な状態遷移が無いため、
 * event id 突合で明示的に重複排除する。lib/server/webhooks.ts の decideIdempotentAction
 * に渡す「事実」がこれ）。
 *
 * @returns ログ済みなら true / 未ログインなら false / **クエリ失敗は undefined**
 */
export async function hasLoggedJoinEvent(participantId: string, webhookEventId: string): Promise<boolean | undefined> {
  // webhookEventId が空文字（テスト payload が id を省略した場合等）だと全件が
  // 一致してしまいうるので、その場合は「未ログイン」として常に書き込ませる
  // （空文字同士の誤突合による false-positive skip を避ける）。
  if (!webhookEventId) return false

  const { data, error } = await getServiceClient()
    .from('meeting_sessions')
    .select('id')
    .eq('participant_id', participantId)
    .eq('event', 'join')
    .eq('detail->>webhookEventId', webhookEventId)
    .limit(1)
    .maybeSingle()

  if (error) {
    console.error('[meetings] webhook event dedup check failed', error)
    return undefined
  }
  return data !== null
}

/** meeting_sessions に 1 行書く（審査監査ログ。§5.1）。成功可否だけを返す。 */
export async function insertMeetingSession(participantId: string, event: string, detail: Json): Promise<boolean> {
  const { error } = await getServiceClient().from('meeting_sessions').insert({ participant_id: participantId, event, detail })

  if (error) {
    console.error('[meetings] insert meeting_session failed', error, { participantId, event })
    return false
  }
  return true
}

/**
 * meetings.peak_participants を GREATEST(現在値, activeCount) に更新する
 * （純計算は lib/server/webhooks.ts の recomputePeak——ここは IO のみ）。
 *
 * 楽観的排他（`.eq('peak_participants', current)`）を掛けて、同時に複数の
 * participant_joined が処理された場合の lost update を減らす。競り負けても
 * エラー扱いにはしない——負けた側の更新が不要になっただけ（相手の書き込みが
 * 既に同じか、それ以上の値を反映しているはず）で、参加者数の把握用途に対して
 * 致命的ではないため（§5.1 の meeting_sessions が一次証跡で、peak_participants は
 * 補助的な集計値という位置づけ）。
 *
 * @returns 致命的な DB エラーなら false、それ以外（更新成功／不要／競合で 0 行）は true
 */
export async function updatePeakParticipants(meetingId: string, activeCount: number): Promise<boolean> {
  const { data: current, error: selectError } = await getServiceClient()
    .from('meetings')
    .select('peak_participants')
    .eq('id', meetingId)
    .maybeSingle()

  if (selectError) {
    console.error('[meetings] peak lookup failed', selectError)
    return false
  }
  if (!current) {
    // meeting 行が消えている（通常運転では起きない）。webhook 側の異常系だが
    // 再送しても直る見込みが無いので致命エラー扱いにはしない。
    console.error('[meetings] peak update skipped: meeting not found', { meetingId })
    return true
  }

  const nextPeak = recomputePeak(current.peak_participants, activeCount)
  if (nextPeak === current.peak_participants) return true // 変化なし＝書き込み不要（冪等）

  const { error: updateError } = await getServiceClient()
    .from('meetings')
    .update({ peak_participants: nextPeak })
    .eq('id', meetingId)
    .eq('peak_participants', current.peak_participants)

  if (updateError) {
    console.error('[meetings] peak update failed', updateError)
    return false
  }
  return true
}

export type MarkLeftResult = 'updated' | 'already_left' | 'error'

/**
 * participants.left_at を now() にする（§6.3 の participant_left）。
 * `is('left_at', null)` を条件に含めることで「まだ null のときだけ」更新する——
 * これが leave イベントの冪等性の本体（再送されても 2 回目以降は 0 行更新になる）。
 * 呼び出し側（route）はこの戻り値で「実際に状態遷移したか」を判定し、
 * meeting_sessions への 'leave' ログ書き込みを『状態遷移したときだけ』行う。
 */
export async function markParticipantLeft(participantId: string): Promise<MarkLeftResult> {
  const { data, error } = await getServiceClient()
    .from('participants')
    .update({ left_at: new Date().toISOString() })
    .eq('id', participantId)
    .is('left_at', null)
    .select('id')

  if (error) {
    console.error('[meetings] mark participant left failed', error)
    return 'error'
  }
  return data.length > 0 ? 'updated' : 'already_left'
}

/**
 * room_finished（§6.3）：進行中の meeting を終了し、その下で left_at が未設定の
 * participants を全員 left_at=now() に補う。
 *
 * 両方とも `... is null` を条件にした UPDATE なので、再送されても 2 回目は
 * 0 行しか触らず自然に冪等——事件ごとの ID 突合は不要（room_started と同じ理由）。
 *
 * @returns 致命的な DB エラーがあれば false
 */
export async function closeMeeting(meetingId: string): Promise<boolean> {
  const now = new Date().toISOString()

  const { error: meetingError } = await getServiceClient()
    .from('meetings')
    .update({ ended_at: now })
    .eq('id', meetingId)
    .is('ended_at', null)

  if (meetingError) {
    console.error('[meetings] close meeting failed', meetingError)
    return false
  }

  const { error: participantsError } = await getServiceClient()
    .from('participants')
    .update({ left_at: now })
    .eq('meeting_id', meetingId)
    .is('left_at', null)

  if (participantsError) {
    console.error('[meetings] bulk close participants failed', participantsError)
    return false
  }
  return true
}

export type QualitySessionResult = 'ok' | 'not_found' | 'error'

/**
 * POST /api/telemetry/quality（§6.4）：participant_id への外部キー制約に委ねて
 * 「存在確認 → 書き込み」を 1 回の insert に潰す（TOCTOU を避け、往復も減らす）。
 * 存在しない participantId は 23503（foreign_key_violation）になるのでそれを
 * 'not_found' として区別し、それ以外のエラーと分ける（route 側はどちらも
 * レスポンスとしては 204 のまま——§6.4「探测面を与えない」）。
 */
export async function insertQualitySession(participantId: string, detail: Json): Promise<QualitySessionResult> {
  const { error } = await getServiceClient()
    .from('meeting_sessions')
    .insert({ participant_id: participantId, event: 'quality', detail })

  if (!error) return 'ok'
  if (error.code === '23503') return 'not_found'
  console.error('[meetings] insert quality session failed', error)
  return 'error'
}
