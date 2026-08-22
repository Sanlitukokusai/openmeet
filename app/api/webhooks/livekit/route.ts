// POST /api/webhooks/livekit —— 規格書 §6.3。
// LiveKit サーバーからのイベント通知を受け取り、meet.rooms/meetings/participants/
// meeting_sessions へ反映する。LiveKit の webhook 配信は「少なくとも 1 回」——
// 失敗（4xx/5xx）すると再送されるので、業務的に無視してよいものは必ず 200 を返し、
// DB 書き込みが本当に失敗したときだけ 500 にする（再送されるのが望ましいケース）。
//
// 処理の骨格：
//   1. 生ボディ文字列を取得し、WebhookReceiver で署名検証（署名不正 → 401 / 非 JSON → 400）
//   2. classifyWebhookEvent()（純関数）でイベント→アクションへ写像。未知イベント等は 200 で無視
//   3. アクション種別ごとに meet.* を読み書き（各手順は lib/server/meetings.ts が冪等に実装済み）
import { NextResponse, type NextRequest } from 'next/server'
import { WebhookReceiver, type WebhookEvent } from 'livekit-server-sdk'
import { apiError } from '@/lib/server/api-response'
import {
  classifyReceiveError,
  classifyWebhookEvent,
  decideIdempotentAction,
  inferRoleFromIdentity,
  type NormalizedWebhookEvent,
} from '@/lib/server/webhooks'
import {
  closeMeeting,
  countActiveParticipants,
  findActiveMeetingId,
  findParticipantForActiveMeeting,
  findRoomIdByMediaRoomName,
  hasLoggedJoinEvent,
  insertMeetingSession,
  insertParticipant,
  markParticipantLeft,
  updatePeakParticipants,
} from '@/lib/server/meetings'

let cachedReceiver: WebhookReceiver | null = null

function getWebhookReceiver(): WebhookReceiver {
  if (!cachedReceiver) {
    cachedReceiver = new WebhookReceiver(process.env.LIVEKIT_API_KEY!, process.env.LIVEKIT_API_SECRET!)
  }
  return cachedReceiver
}

function toNormalizedEvent(event: WebhookEvent): NormalizedWebhookEvent {
  return {
    eventName: event.event,
    roomName: event.room?.name ?? null,
    participantIdentity: event.participant?.identity ?? null,
    participantName: event.participant?.name ?? null,
    participantSid: event.participant?.sid ?? null,
  }
}

const ok = (extra: Record<string, unknown> = {}) => NextResponse.json({ received: true, ...extra })

/**
 * room_started / room_finished / participant_joined / participant_left で共通する
 * 「room.name → meet.rooms.id」の解決。見つからなければ我々の DB に無いルーム宛て
 * （テスト用の野良ルーム等）——再送しても直らないので 200 で無視する。
 */
async function resolveRoomId(roomName: string): Promise<{ ok: true; roomId: string } | { ok: false; response: Response }> {
  const roomId = await findRoomIdByMediaRoomName(roomName)
  if (roomId === undefined) {
    return { ok: false, response: apiError(500, 'INTERNAL_ERROR', 'ルーム情報の取得に失敗しました') }
  }
  if (roomId === null) {
    console.warn('[webhooks/livekit] unknown room, ignoring', { roomName })
    return { ok: false, response: ok({ ignored: true }) }
  }
  return { ok: true, roomId }
}

export async function POST(request: NextRequest) {
  const bodyText = await request.text()
  const authHeader = request.headers.get('authorization') ?? undefined

  let event: WebhookEvent
  try {
    event = await getWebhookReceiver().receive(bodyText, authHeader)
  } catch (err) {
    const kind = classifyReceiveError(err)
    if (kind === 'invalid_body') {
      return apiError(400, 'VALIDATION_ERROR', 'Webhook のボディが不正な JSON です')
    }
    console.warn('[webhooks/livekit] signature verification failed', err instanceof Error ? err.message : err)
    return apiError(401, 'UNAUTHORIZED', 'Webhook の署名検証に失敗しました')
  }

  const action = classifyWebhookEvent(toNormalizedEvent(event))

  switch (action.kind) {
    case 'ignored': {
      // 未知イベント／必須フィールド欠落。業務ノイズで再送嵐を起こさないため 200。
      return ok({ ignored: true, reason: action.reason })
    }

    case 'room_started': {
      const room = await resolveRoomId(action.roomName)
      if (!room.ok) return room.response

      // ⚠️ ここで find-or-create はしない（実測で発覚した重複バグの修正）。
      // meeting の作成経路は POST /api/rooms/{code}/join 一本に統一する——クライアントは
      // token 取得後（＝/join の find-or-create 完了後）にしか LiveKit へ接続できないため、
      // 正規のトラフィックでは room_started が届く時点で meeting は必ず存在する。
      // もしここで作ってしまうと、「room_started の再送が、対応する会議が room_finished で
      // 既に閉じられた後に遅れて届く」場合に別の meeting を新規作成してしまい、
      // 冪等性が壊れる（同一イベントの再送で meeting が増殖する）。
      const meetingId = await findActiveMeetingId(room.roomId)
      if (meetingId === undefined) return apiError(500, 'INTERNAL_ERROR', '会議情報の取得に失敗しました')
      if (meetingId === null) {
        console.warn('[webhooks/livekit] room_started with no active meeting yet, ignoring', { roomName: action.roomName })
      }
      // meeting_sessions への書き込みも不要（participant 次元が無いため）。
      return ok()
    }

    case 'room_finished': {
      const room = await resolveRoomId(action.roomName)
      if (!room.ok) return room.response

      const meetingId = await findActiveMeetingId(room.roomId)
      if (meetingId === undefined) return apiError(500, 'INTERNAL_ERROR', '会議情報の取得に失敗しました')
      if (meetingId === null) return ok() // 既に終了済み／そもそも開始されていない＝冪等な no-op

      const closed = await closeMeeting(meetingId)
      if (!closed) return apiError(500, 'INTERNAL_ERROR', '会議の終了処理に失敗しました')
      return ok()
    }

    case 'participant_joined': {
      const room = await resolveRoomId(action.roomName)
      if (!room.ok) return room.response

      // ⚠️ ここも room_started と同じ理由で find-or-create はしない（実測で発覚した
      // 重複バグの修正）。/join が発行した token でなければ LiveKit に接続できない以上、
      // 正規のトラフィックでは participant_joined が届く時点で meeting は必ず存在する。
      // 見つからない場合は「対応の取りようがない」ケースとして無視する
      // （participant_left が unknown meeting で無視するのと対称的な扱い）。
      const meetingId = await findActiveMeetingId(room.roomId)
      if (meetingId === undefined) return apiError(500, 'INTERNAL_ERROR', '会議情報の取得に失敗しました')
      if (meetingId === null) {
        console.warn('[webhooks/livekit] participant_joined with no active meeting, ignoring', action)
        return ok({ ignored: true })
      }

      let participant = await findParticipantForActiveMeeting(meetingId, action.identity)
      if (participant === undefined) return apiError(500, 'INTERNAL_ERROR', '参加者情報の取得に失敗しました')
      if (participant === null) {
        // 一致行が無い＝token 再利用での再入室など。webhook 情報から補って挿入する。
        const role = inferRoleFromIdentity(action.identity)
        const newId = await insertParticipant({
          meeting_id: meetingId,
          user_id: null,
          media_identity: action.identity,
          display_name: action.name,
          role,
        })
        if (!newId) return apiError(500, 'INTERNAL_ERROR', '参加者情報の登録に失敗しました')
        participant = { id: newId, left_at: null }
      }

      // join ログの冪等性は event.id 突合で担保する（left の `left_at is null` に相当する
      // 自然な状態遷移が join には無いため）。
      const alreadyLogged = await hasLoggedJoinEvent(participant.id, event.id)
      if (alreadyLogged === undefined) return apiError(500, 'INTERNAL_ERROR', 'イベント記録の確認に失敗しました')
      if (decideIdempotentAction(alreadyLogged) === 'apply') {
        const logged = await insertMeetingSession(participant.id, 'join', {
          webhookEventId: event.id,
          sid: action.sid,
          identity: action.identity,
        })
        if (!logged) return apiError(500, 'INTERNAL_ERROR', '参加ログの記録に失敗しました')
      }

      const activeCount = await countActiveParticipants(meetingId)
      if (activeCount === undefined) return apiError(500, 'INTERNAL_ERROR', '在室人数の集計に失敗しました')
      const peakOk = await updatePeakParticipants(meetingId, activeCount)
      if (!peakOk) return apiError(500, 'INTERNAL_ERROR', 'ピーク人数の更新に失敗しました')

      return ok()
    }

    case 'participant_left': {
      const room = await resolveRoomId(action.roomName)
      if (!room.ok) return room.response

      const meetingId = await findActiveMeetingId(room.roomId)
      if (meetingId === undefined) return apiError(500, 'INTERNAL_ERROR', '会議情報の取得に失敗しました')
      if (meetingId === null) {
        console.warn('[webhooks/livekit] participant_left with no active meeting, ignoring', action)
        return ok({ ignored: true })
      }

      const participant = await findParticipantForActiveMeeting(meetingId, action.identity)
      if (participant === undefined) return apiError(500, 'INTERNAL_ERROR', '参加者情報の取得に失敗しました')
      if (participant === null) {
        // 一致する participants 行が無い（例：join webhook 未到達のうちに再送されたもの
        // とは別の、本当に対応が取れないケース）。臆測で行を作らず無視する。
        console.warn('[webhooks/livekit] participant_left with no matching participant, ignoring', action)
        return ok({ ignored: true })
      }

      const result = await markParticipantLeft(participant.id)
      if (result === 'error') return apiError(500, 'INTERNAL_ERROR', '退室処理に失敗しました')
      if (result === 'updated') {
        const logged = await insertMeetingSession(participant.id, 'leave', {
          webhookEventId: event.id,
          sid: action.sid,
          identity: action.identity,
        })
        if (!logged) return apiError(500, 'INTERNAL_ERROR', '退室ログの記録に失敗しました')
      }
      // result === 'already_left'：状態遷移が起きていない＝再送。ログも書かない（冪等）。
      return ok()
    }
  }
}
