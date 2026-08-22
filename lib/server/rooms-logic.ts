// 房间 CRUD / 房间控制 的纯逻辑层：zod 校验 schema、DB 行 → DTO 映射、状态推导、
// 房主操作（静音）的鉴权判定与目标筛选。
//
// ⚠️ 硬性约束（CLAUDE.md 技术注记）：本文件禁止 import lib/supabase.ts 或任何带
// `server-only` 标记的模块——vitest 跑在纯 node 环境，`server-only` 包会在该环境
// 无条件抛错（其 package.json exports 只在 `react-server` 条件下才解析到空实现）。
// 运行时依赖只有 zod（lib/database.types.ts 是纯类型文件，`import type` 编译后消失），
// 方便 tests/rooms/rooms-logic.test.ts 单独 import 测试。
import { z } from 'zod'
import type { Database, RoomStatus } from '@/lib/database.types'

// ============ 常量（与 supabase/migrations/0001_meet_schema.sql、规格书 §5.1/§7.4 对齐）============
export const MAX_PARTICIPANTS_MIN = 2
export const MAX_PARTICIPANTS_MAX = 50
export const ROOM_PASSWORD_MIN = 6
export const ROOM_PASSWORD_MAX = 8
export const TITLE_MAX_LENGTH = 200

// ============ DB 行类型 ============
// 単一の事実源は lib/database.types.ts（DDL 準拠の手書き型）。ここで再定義すると
// DDL 変更時に二重メンテになるので導出するだけにする（WP-1 期の手書きミラーは廃止）。
export type RoomRow = Database['meet']['Tables']['rooms']['Row']
export type { RoomStatus }
/** API 对外的派生状态：在 DB status 之上叠加「expired」（expires_at 已过期但 status 仍是 active）。*/
export type RoomState = RoomStatus | 'expired'

// ============ 校验 schema（zod v4）============
const titleSchema = z
  .string()
  .trim()
  .min(1, 'タイトルは必須です')
  .max(TITLE_MAX_LENGTH, `タイトルは${TITLE_MAX_LENGTH}文字以内で入力してください`)

const maxParticipantsSchema = z
  .number()
  .int('整数で指定してください')
  .min(MAX_PARTICIPANTS_MIN, `参加人数は${MAX_PARTICIPANTS_MIN}人以上にしてください`)
  .max(MAX_PARTICIPANTS_MAX, `参加人数は${MAX_PARTICIPANTS_MAX}人以下にしてください`)

const passwordSchema = z
  .string()
  .min(ROOM_PASSWORD_MIN, `パスワードは${ROOM_PASSWORD_MIN}〜${ROOM_PASSWORD_MAX}桁で入力してください`)
  .max(ROOM_PASSWORD_MAX, `パスワードは${ROOM_PASSWORD_MIN}〜${ROOM_PASSWORD_MAX}桁で入力してください`)

// scheduledAt / expiresAt は ISO 文字列や `datetime-local` 由来の文字列を許容するため coerce。
const dateInputSchema = z.coerce.date()

/** POST /api/rooms 请求体（规格书 §6.1）。 */
export const createRoomSchema = z.object({
  title: titleSchema,
  maxParticipants: maxParticipantsSchema.optional(),
  // 空字符串视为「未设置密码」，与前端表单留空的语义一致。
  password: z.preprocess((v) => (v === '' ? undefined : v), passwordSchema.optional()),
  scheduledAt: dateInputSchema.optional(),
  expiresAt: dateInputSchema.optional(),
  requireLogin: z.boolean().optional(),
})
export type CreateRoomInput = z.infer<typeof createRoomSchema>

/**
 * PATCH /api/rooms/{id} 请求体（规格书 §6.1）。
 * password 为三态字段：
 *   - 省略该键        → 不修改现有密码
 *   - null 或空字符串 → 清除密码（房间变为无密码）
 *   - 6~8 位字符串    → 更新为新密码
 * expiresAt 同理支持 null 显式清除到期时间。
 */
export const patchRoomSchema = z
  .object({
    title: titleSchema.optional(),
    // z.union は配列順に最初の成功を採用する。z.coerce.date() を先に置くと
    // `new Date(null)` が例外を投げず 1970-01-01（epoch）へ落ちて「成功」して
    // しまい、null 分岐まで到達しない。null を先に置いて明示的に短絡させる。
    password: z.preprocess((v) => (v === '' ? null : v), z.union([z.null(), passwordSchema])).optional(),
    expiresAt: z.union([z.null(), dateInputSchema]).optional(),
    maxParticipants: maxParticipantsSchema.optional(),
    requireLogin: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: '更新する項目がありません' })
export type PatchRoomInput = z.infer<typeof patchRoomSchema>

// ============ 状态推导 ============
// 优先级（由高到低）：disabled > ended > expired（expires_at 已到期）> active。
// disabled/ended 是房主主动操作产生的终态，即使 expires_at 早已过期也不应被「expired」掩盖。
export function deriveRoomState(row: Pick<RoomRow, 'status' | 'expires_at'>, now: Date): RoomState {
  if (row.status === 'disabled') return 'disabled'
  if (row.status === 'ended') return 'ended'
  if (row.expires_at !== null && new Date(row.expires_at).getTime() <= now.getTime()) return 'expired'
  return 'active'
}

// ============ DTO（响应白名单）============
// 任何情况下都绝不包含：password_hash / owner_id / media_room_name / media_provider。
export interface RoomDTO {
  id: string
  roomCode: string
  title: string
  status: RoomState
  hasPassword: boolean
  maxParticipants: number
  requireLogin: boolean
  scheduledAt: string | null
  expiresAt: string | null
  createdAt: string
  updatedAt: string
}

type RoomDTOSourceRow = Pick<
  RoomRow,
  | 'id'
  | 'room_code'
  | 'title'
  | 'status'
  | 'password_hash'
  | 'max_participants'
  | 'require_login'
  | 'scheduled_at'
  | 'expires_at'
  | 'created_at'
  | 'updated_at'
>

/** PATCH /api/rooms/{id} 響応（`200 { ...room }`）用の完全 DTO。 */
export function toRoomDTO(row: RoomDTOSourceRow, now: Date): RoomDTO {
  return {
    id: row.id,
    roomCode: row.room_code,
    title: row.title,
    status: deriveRoomState(row, now),
    hasPassword: row.password_hash !== null,
    maxParticipants: row.max_participants,
    requireLogin: row.require_login,
    scheduledAt: row.scheduled_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * GET /api/rooms 一覧アイテム。
 *
 * ベースは規格書 §6.1 の白名单（id/roomCode/title/status/scheduledAt/expiresAt）だが、
 * **2026-08-07 に `activeParticipants` を意図的に追加した**（§6.1 への明示的な拡張）。
 * 理由：`status: 'active'` は「会議室が使える状態」であって「今まさに会議中」ではない。
 * 一覧の状態列がライフサイクルしか映さないと、誰も居ない部屋がずっと「開催中」に見えて
 * 利用者を誤解させる（実利用者からの指摘）。
 *
 * 情報漏れの観点：返すのは**自分が房主の部屋の人数だけ**（GET /api/rooms は owner_id で
 * 絞ってある）。他人の部屋の在室状況は一切出ない。
 */
export interface RoomListItemDTO extends Pick<RoomDTO, 'id' | 'roomCode' | 'title' | 'status' | 'scheduledAt' | 'expiresAt'> {
  /**
   * 今その部屋に接続している人数。
   * **null = 人数不明**（メディアサーバーへ到達できなかった）。0 人と混同しないこと——
   * UI は null のとき「待機中（0 人）」ではなく「利用可能」と出す。
   */
  activeParticipants: number | null
}

type RoomListSourceRow = Pick<RoomRow, 'id' | 'room_code' | 'title' | 'status' | 'scheduled_at' | 'expires_at'>

/**
 * @param activeParticipants 在線人数。省略時は null（＝人数不明）——一覧を返す経路が
 *        メディアサーバーを引けなかった場合と、人数を必要としない呼び出しの両方を兼ねる。
 */
export function toRoomListItem(
  row: RoomListSourceRow,
  now: Date,
  activeParticipants: number | null = null,
): RoomListItemDTO {
  return {
    id: row.id,
    roomCode: row.room_code,
    title: row.title,
    status: deriveRoomState(row, now),
    scheduledAt: row.scheduled_at,
    expiresAt: row.expires_at,
    activeParticipants,
  }
}

/**
 * 「LiveKit から引いた在線人数の写像」＋「その部屋の media_room_name」→ 一覧に載せる人数。
 *
 * 写像が null（メディアサーバー不通）なら null を返す＝人数不明。写像はあるがキーが
 * 無い場合は 0——LiveKit は無人の部屋を一覧に出さないので「載っていない ＝ 誰も居ない」。
 * この 2 つを潰さないことが本関数の存在理由（純関数なので単測で全分岐を固定できる）。
 */
export function resolveActiveParticipants(
  occupancy: ReadonlyMap<string, number> | null,
  mediaRoomName: string,
): number | null {
  if (occupancy === null) return null
  return occupancy.get(mediaRoomName) ?? 0
}

/** POST /api/rooms 響応（規格書 §6.1 の白名单：id/roomCode/joinUrl/expiresAt のみ）。 */
export interface RoomCreateResponseDTO {
  id: string
  roomCode: string
  joinUrl: string
  expiresAt: string | null
}

type RoomCreateSourceRow = Pick<RoomRow, 'id' | 'room_code' | 'expires_at'>

export function toRoomCreateResponse(row: RoomCreateSourceRow, joinUrl: string): RoomCreateResponseDTO {
  return {
    id: row.id,
    roomCode: row.room_code,
    joinUrl,
    expiresAt: row.expires_at,
  }
}

// ============ 房主操作：参加者ミュート（2026-08-07 追加）============
/**
 * POST /api/rooms/{id}/participants/mute のリクエストボディ。
 * identity は LiveKit の participant identity（`host_<userId>` / `guest_<nanoid12>`）。
 * 空文字を弾くのは、空 identity が LiveKit 側で別の意味に解釈される事故を防ぐため。
 */
export const muteParticipantSchema = z.object({
  identity: z.string().trim().min(1, '参加者を指定してください'),
  muted: z.boolean(),
})
export type MuteParticipantInput = z.infer<typeof muteParticipantSchema>

/**
 * 房主専用エンドポイント（PATCH / DELETE / end / mute 系）共通の鉴权判定。
 *
 * @param userId  ログイン中ユーザー id（未ログインは null）
 * @param room    **owner_id で絞り込んだ**クエリの結果。0 行ヒット（=null）は
 *                「他人の部屋」と「存在しない部屋」の両方を意味する——両者を
 *                同じ 404 に潰すことで room id の存在探査に手掛かりを与えない
 *                （§6.1 の既存 PATCH / DELETE / end と同じ設計）。
 */
export type HostActionAuthResult =
  | { ok: true }
  | { ok: false; status: 401; code: 'UNAUTHORIZED'; message: string }
  | { ok: false; status: 404; code: 'ROOM_NOT_FOUND'; message: string }

export function authorizeHostRoomAction(userId: string | null, room: unknown): HostActionAuthResult {
  if (userId === null) return { ok: false, status: 401, code: 'UNAUTHORIZED', message: 'ログインが必要です' }
  if (room === null || room === undefined) {
    return { ok: false, status: 404, code: 'ROOM_NOT_FOUND', message: 'ルームが見つかりません' }
  }
  return { ok: true }
}

/**
 * ミュート操作が「実行はしたが状態を変えられなかった」ときの理由。
 * 実際に LiveKit を叩くのは lib/server/livekit.ts だが、**型と HTTP 写像は
 * こちら（純ロジック層）に置く**——server-only な livekit.ts は vitest から
 * import できないため、写像表をテスト可能な場所に出しておく必要がある。
 */
export type MuteAudioFailureReason =
  /** その identity は現在このルームに居ない（既に退出した等）。 */
  | 'participant-not-found'
  /** 居るが音声トラックを publish していない（旁聴参加者）。ミュートする対象が無い。 */
  | 'no-audio-track'
  /** LiveKit 側で remote unmute が無効（`room.enable_remote_unmute`）。muted=false のときのみ。 */
  | 'remote-unmute-disabled'
  /** LiveKit へ到達できない / 想定外のエラー。 */
  | 'media-server-error'

export interface MuteFailureApiError {
  status: 409 | 500
  code: 'PARTICIPANT_NOT_FOUND' | 'NO_AUDIO_TRACK' | 'REMOTE_UNMUTE_DISABLED' | 'INTERNAL_ERROR'
  message: string
}

/**
 * 失敗理由 → HTTP レスポンスの写像。
 *
 * 409 を選ぶ理由：鉴权（房主本人）は通っており、URL も正しい。通らないのは
 * 「対象参加者の**今の状態**がその操作を受け付けない」から——これは Conflict。
 * 404 にしないのは、UI 側で ROOM_NOT_FOUND（＝部屋ごと消えた、画面を離れるべき）と
 * 混同されると挙動が過剰になるため。
 *
 * ★ どの理由も **200 では返さない**。「押したのに何も起きなかった」を成功として
 *   返すと UI が嘘をつく（CLAUDE.md：静默 no-op / 伪装接通の禁止）。
 */
export function muteFailureToApiError(reason: MuteAudioFailureReason): MuteFailureApiError {
  switch (reason) {
    case 'participant-not-found':
      return { status: 409, code: 'PARTICIPANT_NOT_FOUND', message: 'この参加者は現在会議に参加していません' }
    case 'no-audio-track':
      return { status: 409, code: 'NO_AUDIO_TRACK', message: 'この参加者はマイクを使用していません' }
    case 'remote-unmute-disabled':
      return {
        status: 409,
        code: 'REMOTE_UNMUTE_DISABLED',
        message: 'サーバー設定によりミュート解除は許可されていません',
      }
    case 'media-server-error':
      return { status: 500, code: 'INTERNAL_ERROR', message: 'ミュート操作に失敗しました' }
  }
}

/** 一括ミュートの候補（LiveKit の ParticipantInfo から必要な 2 項目だけ抜いた形）。 */
export interface MuteAllCandidate {
  identity: string
  audioTrackSids: string[]
}

export interface MuteAllPlan {
  targets: MuteAllCandidate[]
  /** 除外した人数：exceptIdentity 本人 ＋ 音声トラックを持たない旁聴者。 */
  skipped: number
}

/**
 * 一括ミュートの対象を選ぶ純関数（LiveKit SDK に触れないのでテスト可能）。
 * 除外条件は 2 つだけ：
 *   1. exceptIdentity（＝司会者自身。自分の口を塞いで進行できなくなるのを防ぐ）
 *   2. 音声トラックが 1 本も無い参加者（旁聴者。ミュートすべき対象が存在しない）
 * 既にミュート済みかどうかは見ない——mutePublishedTrack は冪等で、
 * 「LiveKit 側の muted フラグ」と「実際に音が出ているか」がズレていた場合に
 * 取りこぼすより、もう一度確実に叩く方が司会者の意図に忠実。
 */
export function planMuteAllTargets(candidates: MuteAllCandidate[], exceptIdentity: string | null): MuteAllPlan {
  const targets = candidates.filter((c) => c.identity !== exceptIdentity && c.audioTrackSids.length > 0)
  return { targets, skipped: candidates.length - targets.length }
}

// ============ 房间码 / 入会链接工具（規格書 §7.4）============
export function buildMediaRoomName(roomCode: string): string {
  return `meet_${roomCode}`
}

/** joinUrl のベース URL を決めるための情報源（優先順に評価）。 */
export interface JoinBaseUrlSources {
  /** `x-forwarded-host`（一般的なリバースプロキシが付与。多段時は先頭が元ホスト）。 */
  forwardedHost?: string | null
  /** `x-forwarded-proto`。無ければ https とみなす（本番は常に TLS 終端の背後）。 */
  forwardedProto?: string | null
  /** `Host` ヘッダ。 */
  hostHeader?: string | null
  /** 最終フォールバック（`request.nextUrl.origin`）。ローカル dev ではこれが正解になる。 */
  fallbackOrigin: string
}

/** コンテナ内部アドレス（reverse proxy 背後の `nextUrl.origin` はこれになる）。
 *  ユーザーに配る招待リンクとして無意味なので、他に候補がある限り採用しない。 */
const INTERNAL_HOST_RE = /^(localhost|127\.|0\.0\.0\.0|\[::1\])/i

function firstHeaderValue(raw: string | null | undefined): string {
  return (raw ?? '').split(',')[0].trim()
}

/**
 * 招待リンクのベース URL。優先順：
 *   1. APP_DOMAIN（空文字は「未設定」扱い——2026-08-14 の本番事故：env 一括上書きで
 *      空文字が入り、旧実装が `nextUrl.origin`＝コンテナ内部の `localhost:8080` を
 *      ユーザーに配ってしまった）
 *   2. `x-forwarded-host`（+ proto）……リバースプロキシ経由の本番で常に正しい
 *   3. `Host` ヘッダ
 *   4. `fallbackOrigin`（ローカル dev はここで `http://localhost:3000` になる）
 * 2・3 は内部アドレスなら飛ばす。どの経路でも「設定ミスで localhost を配る」事故を
 * 構造的に不可能にするのが狙い。
 */
export function resolveJoinBaseUrl(appDomain: string | null | undefined, sources: JoinBaseUrlSources): string {
  const trimmed = appDomain?.trim()
  if (trimmed) return `https://${trimmed}`

  const forwardedHost = firstHeaderValue(sources.forwardedHost)
  if (forwardedHost && !INTERNAL_HOST_RE.test(forwardedHost)) {
    const proto = firstHeaderValue(sources.forwardedProto) || 'https'
    return `${proto}://${forwardedHost}`
  }

  const host = firstHeaderValue(sources.hostHeader)
  if (host && !INTERNAL_HOST_RE.test(host)) {
    return `https://${host}`
  }

  return sources.fallbackOrigin
}

export function buildJoinUrl(baseUrl: string, roomCode: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/j/${roomCode}`
}
