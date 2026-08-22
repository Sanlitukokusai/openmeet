// LiveKit webhook（規格書 §6.3）の純ロジック層：イベント→アクション写像・冪等判定・
// peak 再計算・identity 前缀推断。すべて副作用なしの純関数のみを置く。
//
// ⚠️ 硬性约束（CLAUDE.md 技术注记 + 本 WP 任务书）：本文件と tests/webhooks/*.test.ts は
// lib/supabase.ts を import 禁止（`server-only` が vitest の node 環境で無条件に throw する
// ため）。実際の DB IO（room/meeting/participant の読み書き）は lib/server/meetings.ts、
// 署名検証と一連の orchestration（IO 呼び出しの順序）は app/api/webhooks/livekit/route.ts の
// 責務——ここは join-policy.ts と同じ立ち位置で「事実→判定」だけを担う。
import type { ParticipantRole } from '@/lib/database.types'

// ============ WebhookEvent（livekit-server-sdk / @livekit/protocol）から抜き出す最小形 ============
// SDK の WebhookEvent クラスをそのまま純ロジック層へ持ち込むとプロトコル依存になるため、
// route 側で必要なフィールドだけへ詰め替えて渡す（テストも plain object で完結できる）。
export interface NormalizedWebhookEvent {
  /** LiveKit は将来イベントを追加しうるので、未知の文字列がそのまま来る前提。 */
  eventName: string
  roomName: string | null
  participantIdentity: string | null
  participantName: string | null
  participantSid: string | null
}

// ============ ① イベント → アクションの写像（事件→动作映射） ============
export type WebhookAction =
  | { kind: 'room_started'; roomName: string }
  | { kind: 'room_finished'; roomName: string }
  | { kind: 'participant_joined'; roomName: string; identity: string; name: string; sid: string }
  | { kind: 'participant_left'; roomName: string; identity: string; sid: string }
  | { kind: 'ignored'; reason: string }

/** §6.3 が処理を要求する 4 イベントのみ。他は LiveKit が送ってくる別種イベント（track_published 等）。 */
const HANDLED_EVENTS = new Set(['room_started', 'room_finished', 'participant_joined', 'participant_left'])

/**
 * イベント名とペイロードから「行うべきこと」を判定する唯一の事実源。
 * 判定できない（未知イベント／必須フィールド欠落）場合は必ず 'ignored' を返す——
 * route 側はこれを 200 で握りつぶす。4xx/5xx にすると LiveKit の再送嵐を招くため
 * （業務的に無視してよいものと、本当に失敗したもの＝5xx を混同しない）。
 */
export function classifyWebhookEvent(evt: NormalizedWebhookEvent): WebhookAction {
  if (!HANDLED_EVENTS.has(evt.eventName)) {
    return { kind: 'ignored', reason: `unknown event: ${evt.eventName}` }
  }
  if (!evt.roomName) {
    return { kind: 'ignored', reason: 'missing room name' }
  }
  if (evt.eventName === 'room_started') return { kind: 'room_started', roomName: evt.roomName }
  if (evt.eventName === 'room_finished') return { kind: 'room_finished', roomName: evt.roomName }

  // 残る 2 つ（participant_joined / participant_left）は participant 情報が必須。
  if (!evt.participantIdentity) {
    return { kind: 'ignored', reason: 'missing participant identity' }
  }
  if (evt.eventName === 'participant_joined') {
    return {
      kind: 'participant_joined',
      roomName: evt.roomName,
      identity: evt.participantIdentity,
      // LiveKit の Participant.name は空文字のことがある（表示名未設定）。identity にフォールバック。
      name: evt.participantName?.trim() || evt.participantIdentity,
      sid: evt.participantSid ?? '',
    }
  }
  return {
    kind: 'participant_left',
    roomName: evt.roomName,
    identity: evt.participantIdentity,
    sid: evt.participantSid ?? '',
  }
}

// ============ ② 冪等判定（幂等判定） ============
export type IdempotentDecision = 'apply' | 'skip'

/**
 * 「すでに処理済みなら何もしない」という、本 webhook 内の全ての冪等制御が
 * 帰着する共通の形。join のログ重複防止（event id 突合の結果）・leave の状態遷移防止
 * （left_at がすでに埋まっているか）は、どちらも「既知の事実を渡すと apply/skip が
 * 返ってくる」だけの同型の判定なのでここに統合する。
 *
 * ⚠️ 実際の DB 更新は（可能な場合は）追加で条件付き WHERE 句と組み合わせる
 * （例：`update ... where left_at is null`）——本関数は「ログを書くかどうか」の
 * 判定用で、真の排他性は DB 側の原子性に頼る（read-then-decide のレース窓を保険で塞ぐ）。
 */
export function decideIdempotentAction(alreadyDone: boolean): IdempotentDecision {
  return alreadyDone ? 'skip' : 'apply'
}

// ============ ③ peak_participants 再計算 ============
/**
 * GREATEST(現在値, 現在の在室数)。何度呼んでも同じ入力に対して同じ出力を返す
 * 数学的に冪等な演算——リトライで何度実行されても安全なのはこの性質による。
 * ピークは減らない（現在の在室数が過去のピークを下回っても current を維持）。
 */
export function recomputePeak(currentPeak: number, activeCount: number): number {
  return Math.max(currentPeak, activeCount)
}

// ============ ④ identity 前缀 → role 推断 ============
/**
 * §7.3 の命名規則（host_<userId> / guest_<nanoid12>）の逆写像。
 * participant_joined で一致する participants 行が無いとき（例：token 再利用での
 * 再入室）にのみ使う fallback insert 専用のヘルパー。判定に迷う入力は guest に倒す
 * （host 権限を誤って過剰付与しないため——安全側）。
 */
export function inferRoleFromIdentity(identity: string): ParticipantRole {
  return identity.startsWith('host_') ? 'host' : 'guest'
}

// ============ ⑤ 署名検証エラー → HTTP ステータスの写像 ============
/**
 * WebhookReceiver#receive() が投げる例外を 400/401 に振り分ける。
 * 実装（livekit-server-sdk の WebhookReceiver.receive）は「署名検証 → JSON.parse」の順で
 * 実行するため、署名が不正な場合は JSON.parse に到達する前に例外が飛ぶ。
 * つまり SyntaxError（JSON.parse 由来）だけが「署名は正しいが body が不正な JSON」を
 * 意味し、それ以外（authorization ヘッダ欠落／署名不一致／sha256 不一致）はすべて
 * 署名検証の失敗として扱ってよい。
 */
export function classifyReceiveError(err: unknown): 'invalid_body' | 'invalid_signature' {
  return err instanceof SyntaxError ? 'invalid_body' : 'invalid_signature'
}
