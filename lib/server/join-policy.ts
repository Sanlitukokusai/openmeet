// 入会判定（規格書 §6.2 / §7.3 / §12.3 / §12.8）の**純ロジック層**。
//
// ⚠️ 硬性约束（CLAUDE.md 技术注记）：本文件禁止 import lib/supabase.ts / lib/server/password.ts /
// lib/server/livekit.ts 等带 `server-only` 标记的模块——vitest 跑在纯 node 环境，
// `server-only` 会无条件抛错。DB 查询・bcrypt 比較・限流 RPC・token 署名は
// すべて route 側（app/api/rooms/[code]/join/route.ts）の責務で、ここは
// 「事実 → 判定」だけを担う。全数マトリクスは tests/join/join-policy.test.ts。
//
// ★ 判定順序はセキュリティ上の契約であり、evaluateJoin() が唯一の事実源。
//   route 側は同じ順序でステージ関数を呼ぶ（高価な IO を遅延させるため）。
import { z } from 'zod'
import { deriveRoomState, type RoomState } from '@/lib/server/rooms-logic'
import type { ParticipantRole, RoomStatus } from '@/lib/database.types'

export type { ParticipantRole }

// ============ 定数 ============
/** §7.3：token TTL は房间剩余时长以内、かつ 6 時間で頭打ち。 */
export const TOKEN_TTL_CAP_SECONDS = 6 * 60 * 60
export const DISPLAY_NAME_MAX_LENGTH = 50
/** §12.3：同一 IP × 同一 roomCode で 10 分あたり 10 回まで（RPC 側の既定値と一致）。 */
export const JOIN_ATTEMPT_MAX = 10
export const JOIN_ATTEMPT_WINDOW = '10 minutes'

/**
 * サーバー全体の同時接続人数の既定上限（2026-08-07 追加）。
 *
 * 根拠：docs/SERVER-FACTS.md ——公網出口帯域は **40 Mbps** しかない。SFU の出方向は
 * 人数の二乗で効くため、20 人（360p 相当で概ね 40 Mbps 近辺）を超えると
 * 全会議が同時に劣化する。個別ルームの max_participants（§12.8）は「1 部屋の中の
 * 上限」でしかなく、部屋が増えれば帯域は幾らでも溢れる——本上限はその穴を塞ぐ
 * **サーバー全体の容量保護**であり、部屋単位の上限とは別レイヤーの防波堤。
 *
 * 環境変数 MAX_CONCURRENT_PARTICIPANTS で上書き可（回線増強時にコード変更不要）。
 */
export const DEFAULT_MAX_CONCURRENT_PARTICIPANTS = 20

/**
 * MAX_CONCURRENT_PARTICIPANTS の解釈。**不正値は既定値へフォールバックする**：
 * 環境変数のタイプミス（空文字 / `"20人"` / `-1`）でサービス全体が入室不能に
 * 陥る方が、上限が既定値のままである事より遥かに事故として重い。
 * 0 も「不正」に含める——「0 でメンテナンス封鎖」という運用は、事故と区別が
 * つかないので敢えて塞ぐ（封鎖したいなら別の手段を用意すべき）。
 */
export function parseMaxConcurrent(raw: string | null | undefined): number {
  if (raw === null || raw === undefined) return DEFAULT_MAX_CONCURRENT_PARTICIPANTS
  const trimmed = raw.trim()
  if (trimmed === '') return DEFAULT_MAX_CONCURRENT_PARTICIPANTS
  // Number() は '20abc' を NaN にする（parseInt と違って前方一致で拾わない）。
  const value = Number(trimmed)
  if (!Number.isInteger(value) || value < 1) return DEFAULT_MAX_CONCURRENT_PARTICIPANTS
  return value
}

// ============ 入力型 ============
/**
 * 策略层が見る房间快照。**password_hash は意図的に含めない**——策略层に必要なのは
 * 「パスワードが設定されているか」だけで、ハッシュ本体を持ち回らないことで
 * 誤ってレスポンスへ混入する経路を型レベルで塞ぐ（CLAUDE.md 硬规则 4）。
 */
export interface RoomSnapshot {
  status: RoomStatus
  expires_at: string | null
  title: string
  require_login: boolean
  has_password: boolean
  max_participants: number
  owner_id: string
}

/** 現在のセッション。匿名は userId=null。 */
export interface JoinSession {
  userId: string | null
}

/** POST /api/rooms/{roomCode}/join のリクエストボディ（§6.2）。 */
export const joinRequestSchema = z.object({
  displayName: z
    .string()
    .trim()
    .min(1, '表示名を入力してください')
    .max(DISPLAY_NAME_MAX_LENGTH, `表示名は${DISPLAY_NAME_MAX_LENGTH}文字以内で入力してください`),
  // パスワードは長さ検証しない：ルーム作成時の 6〜8 桁制約に合わない入力も
  // 「間違ったパスワード」として 400 INVALID_PASSWORD に落とす（VALIDATION_ERROR と
  // 区別すると「桁数が違う＝そもそも別物」という情報を攻撃者に与えてしまう）。
  password: z.string().optional(),
})
export type JoinRequestInput = z.infer<typeof joinRequestSchema>

// ============ 出力型 ============
export type JoinDenyCode =
  | 'ROOM_NOT_FOUND'
  | 'ROOM_EXPIRED'
  | 'ROOM_ENDED'
  | 'SERVER_AT_CAPACITY'
  | 'LOGIN_REQUIRED'
  | 'TOO_MANY_ATTEMPTS'
  | 'INVALID_PASSWORD'
  | 'ROOM_FULL'

export interface JoinDeny {
  ok: false
  code: JoinDenyCode
  /** §6.2 のステータスコード表（+ 2026-08-07 追加の 503）。route はこれをそのまま apiError() へ渡す。 */
  status: 400 | 403 | 404 | 409 | 410 | 429 | 503
  message: string
}

/**
 * 全局容量オーバー時の利用者向け文言。入室でも会議室作成でも同じ事象なので
 * 1 つに統一する（route 側で使い回す）。**満室（ROOM_FULL）とは別物**——
 * あちらは「この部屋が定員」、こちらは「サーバー全体が混雑」。
 */
export const SERVER_AT_CAPACITY_MESSAGE =
  'ただいまアクセスが集中しています。しばらく時間をおいてからお試しください'

export interface JoinGrant {
  ok: true
  role: ParticipantRole
  /** AccessToken の ttl（秒）。必ず 1 以上（理由は computeTokenTtlSeconds 参照）。 */
  ttlSeconds: number
}

const DENIALS = {
  ROOM_NOT_FOUND: { status: 404, message: 'ルームが見つかりません' },
  ROOM_EXPIRED: { status: 410, message: 'このルームは有効期限が切れています' },
  ROOM_ENDED: { status: 410, message: 'この会議はすでに終了しています' },
  SERVER_AT_CAPACITY: { status: 503, message: SERVER_AT_CAPACITY_MESSAGE },
  LOGIN_REQUIRED: { status: 403, message: 'この会議に参加するにはログインが必要です' },
  TOO_MANY_ATTEMPTS: {
    status: 429,
    message: 'パスワードの試行回数が上限に達しました。しばらく時間をおいてからお試しください',
  },
  INVALID_PASSWORD: { status: 400, message: 'パスワードが正しくありません' },
  ROOM_FULL: { status: 409, message: 'この会議は満員です' },
} as const satisfies Record<JoinDenyCode, { status: JoinDeny['status']; message: string }>

function deny(code: JoinDenyCode): JoinDeny {
  return { ok: false, code, status: DENIALS[code].status, message: DENIALS[code].message }
}

// ============ ステージ 1：存在・状態・ログイン要否（IO 不要）============
export type JoinGateResult = JoinDeny | { ok: true; requiresPassword: boolean }

/**
 * 判定順の 1〜3 番目（§6.2）：
 *   1. ルームが無い            → 404 ROOM_NOT_FOUND
 *   2. expired                 → 410 ROOM_EXPIRED
 *      ended / disabled        → 410 ROOM_ENDED（disabled は対外的に ended と同一表現）
 *   3. require_login かつ未ログイン → 403 LOGIN_REQUIRED
 *
 * 順序の理由：状態チェックをログイン要求より先に置くことで、終了済みルームに対して
 * 「ログインすれば入れるかもしれない」という誤誘導を防ぐ。逆にログインを先にすると
 * 未ログイン利用者は 403 しか見えず、終了済みであることに気付けない。
 */
export function checkJoinGate(
  room: Pick<RoomSnapshot, 'status' | 'expires_at' | 'require_login' | 'has_password'> | null,
  session: JoinSession,
  now: Date,
): JoinGateResult {
  if (room === null) return deny('ROOM_NOT_FOUND')

  const state = deriveRoomState(room, now)
  if (state === 'expired') return deny('ROOM_EXPIRED')
  if (state === 'ended' || state === 'disabled') return deny('ROOM_ENDED')

  if (room.require_login && session.userId === null) return deny('LOGIN_REQUIRED')

  return { ok: true, requiresPassword: room.has_password }
}

// ============ ステージ 1.5：全局容量（2026-08-07 追加）============
/**
 * サーバー全体に空きがあるか。**統計源が落ちている（null）ときは true＝通す**。
 *
 * ★ フェイルオープンの理由（rate-limit のフェイルクローズと逆なので明記する）：
 *   容量上限は「品質を守るための保護機能」であって「セキュリティ境界」ではない。
 *   LiveKit と DB の両方から人数が取れない状況は、たいてい統計側だけの障害で、
 *   その時に全利用者の入室と会議室作成を止めるのは**保護機能が本体の障害を
 *   引き起こす**という本末転倒になる。帯域が溢れても劣化するだけで済むが、
 *   フェイルクローズだと業務そのものが止まる。だから通す（ログは大声で出す）。
 *   ——対して §12.3 の限流はブルートフォース遮断＝セキュリティ境界なので閉じる。
 */
export function hasGlobalHeadroom(globalOnline: number | null, maxConcurrent: number): boolean {
  if (globalOnline === null) return true
  return globalOnline < maxConcurrent
}

/**
 * 判定順の 3.5 番目：**全局容量チェックは限流・パスワード照合より前**。
 * 順序の理由：サーバーが満杯なら、どのみち入室できない。その状態で
 *   - bcrypt を回す＝無駄な CPU を焼く
 *   - 限流カウンタを進める＝満杯が解消した後に正規利用者が 429 で締め出される
 * ——のは両方とも有害。逆に「ルーム存在・状態チェックより後」に置くのは、
 * 終了済み / 存在しないルームに対して「混雑しています」と答えると、
 * 存在しない room_code の探査に対して誤った希望を与えるため。
 */
export function checkGlobalCapacity(globalOnline: number | null, maxConcurrent: number): JoinDeny | { ok: true } {
  return hasGlobalHeadroom(globalOnline, maxConcurrent) ? { ok: true } : deny('SERVER_AT_CAPACITY')
}

// ============ ステージ 2：限流 + パスワード（§12.3）============
/**
 * route が集めてくる「高価な事実」。
 * 無密码房間では両方 null＝「そもそも評価していない」を表す：
 * パスワードの無いルームは限流カウントの対象外（リロードして入り直すだけの
 * 正常な利用者を巻き込まないため。ブルートフォースの標的が存在しない）。
 */
export interface PasswordGateFacts {
  /** meet.register_join_attempt() の戻り値（true=まだ許容範囲内）。無密码房間は null。 */
  rateLimitAllowed: boolean | null
  /** bcrypt 比較の結果。無密码房間は null。 */
  passwordMatches: boolean | null
}

/**
 * 判定順の 4 番目：**限流を先、パスワード照合を後**（§12.3）。
 * 順序の理由：先に照合してしまうと、上限超過後も「正解なら通る」状態が残り
 * 総当たりの完全な遮断にならない。カウントを先に確定させ、上限を超えた時点で
 * 照合そのものを行わない（bcrypt の CPU コストを攻撃者に使わせない副次効果もある）。
 */
export function checkPasswordGate(requiresPassword: boolean, facts: PasswordGateFacts): JoinDeny | { ok: true } {
  if (!requiresPassword) return { ok: true }

  // rateLimitAllowed が null のまま有密码房間へ来るのは route 側のバグ。
  // フェイルクローズ（安全側）に倒し、限流未評価＝拒否として扱う。
  if (facts.rateLimitAllowed !== true) return deny('TOO_MANY_ATTEMPTS')
  if (facts.passwordMatches !== true) return deny('INVALID_PASSWORD')

  return { ok: true }
}

// ============ ステージ 3：人数上限（§12.8 サーバー側強制）============
/**
 * 判定順の 5 番目。activeParticipantCount は「終了していない meeting に紐づく
 * left_at is null の participants 行数」。LiveKit 側の room.max_participants は
 * あくまで第二の防波堤で、一次的な強制はここ（token 発行時）で行う。
 */
export function checkCapacity(
  room: Pick<RoomSnapshot, 'max_participants'>,
  activeParticipantCount: number,
): JoinDeny | { ok: true } {
  if (activeParticipantCount >= room.max_participants) return deny('ROOM_FULL')
  return { ok: true }
}

// ============ 許可時の付随情報 ============
/** ログイン中ユーザー＝ルーム所有者のときだけ host（roomAdmin 権限を伴う）。 */
export function resolveJoinRole(room: Pick<RoomSnapshot, 'owner_id'>, session: JoinSession): ParticipantRole {
  return session.userId !== null && session.userId === room.owner_id ? 'host' : 'guest'
}

/**
 * §7.3：ttl = min(房间剩余秒数, 6h)。
 *
 * ⚠️ 下限 1 秒のクランプは必須。livekit-server-sdk の AccessToken は
 * `this.ttl = options?.ttl || defaultTTL` と実装されており、**0 は falsy なので
 * 既定値の 6 時間に化ける**——残り 1 秒未満のルームに 6 時間有効な token を
 * 発行してしまう脆弱性になる。expired 判定済みのルームはここへ来ないため、
 * 残りは必ず正の値であり、1 秒に切り上げても「剩余时长を超えない」原則は保たれる。
 */
export function computeTokenTtlSeconds(expiresAt: string | null, now: Date): number {
  if (expiresAt === null) return TOKEN_TTL_CAP_SECONDS
  const remainingSeconds = Math.floor((new Date(expiresAt).getTime() - now.getTime()) / 1000)
  return Math.max(1, Math.min(remainingSeconds, TOKEN_TTL_CAP_SECONDS))
}

/**
 * §7.3：identity は host_<userId> / guest_<nanoid12>。
 * guestSuffix は route 側で nanoid(12) を生成して渡す（乱数を純関数から追い出し、
 * テストを決定的にするため）。role='host' で userId が無いのは呼び出し側のバグだが、
 * `host_null` のような identity を作るより guest 扱いに倒す方が安全。
 */
export function buildMediaIdentity(role: ParticipantRole, userId: string | null, guestSuffix: string): string {
  if (role === 'host' && userId !== null) return buildHostMediaIdentity(userId)
  return `guest_${guestSuffix}`
}

/**
 * 房主が入室したときの identity。token 発行時（buildMediaIdentity）と
 * 一括ミュートの除外判定（POST /participants/mute-all）で同じ文字列を作る必要が
 * あるので、`host_` プレフィックスの事実源をここ 1 か所に閉じ込める。
 */
export function buildHostMediaIdentity(userId: string): string {
  return `host_${userId}`
}

// ============ 合成：判定順序の唯一の事実源 ============
export interface JoinPolicyInput {
  room: RoomSnapshot | null
  session: JoinSession
  now: Date
  /** サーバー全体の在線人数。**null = 統計源が落ちている**（フェイルオープン）。 */
  globalOnline: number | null
  /** サーバー全体の同時接続上限（lib/server/capacity.ts の getMaxConcurrent()）。 */
  maxConcurrent: number
  /** 有密码房間のみ意味を持つ（無密码は null）。 */
  rateLimitAllowed: boolean | null
  passwordMatches: boolean | null
  activeParticipantCount: number
}

/**
 * 全ステージを規定順で合成した参照実装。テストはこれを全数マトリクスで叩く。
 * route 側は同じ順序でステージ関数を個別に呼ぶ——限流 RPC / bcrypt / 人数カウントを
 * 「そこまで到達したときだけ」実行したいため（存在しないルームへの限流書き込みや、
 * パスワード不一致時の無駄なカウントクエリを避ける）。
 */
export function evaluateJoin(input: JoinPolicyInput): JoinDeny | JoinGrant {
  const gate = checkJoinGate(input.room, input.session, input.now)
  if (!gate.ok) return gate
  // gate.ok が true の時点で room は非 null（checkJoinGate が null を弾いている）。
  const room = input.room as RoomSnapshot

  const globalCapacity = checkGlobalCapacity(input.globalOnline, input.maxConcurrent)
  if (!globalCapacity.ok) return globalCapacity

  const password = checkPasswordGate(gate.requiresPassword, {
    rateLimitAllowed: input.rateLimitAllowed,
    passwordMatches: input.passwordMatches,
  })
  if (!password.ok) return password

  const capacity = checkCapacity(room, input.activeParticipantCount)
  if (!capacity.ok) return capacity

  return {
    ok: true,
    role: resolveJoinRole(room, input.session),
    ttlSeconds: computeTokenTtlSeconds(room.expires_at, input.now),
  }
}

// ============ GET /api/rooms/{roomCode}/meta（§6.2）============
/** 対外公開する状態。DB の 'disabled' は 'ended' に丸める（内部運用を漏らさない）。 */
export type PublicRoomStatus = 'active' | 'ended' | 'expired'

export function toPublicRoomStatus(state: RoomState): PublicRoomStatus {
  return state === 'disabled' ? 'ended' : state
}

/** §6.2 の応答形状。これ以外のキーを足さないこと（形状テストで固定している）。 */
export interface RoomMetaDTO {
  exists: boolean
  title: string
  requiresPassword: boolean
  requireLogin: boolean
  isFull: boolean
  status: PublicRoomStatus
}

/**
 * 存在しないルーム用の中立な既定値。status を 'ended' にするのは、
 * 「存在しない」と「終了済み」を外形上区別できなくして room_code の総当たり列挙に
 * 手掛かりを与えないため（/meta は常に 200 を返す仕様なので、形状差だけが手掛かりになる）。
 */
export const ROOM_META_NOT_FOUND: RoomMetaDTO = {
  exists: false,
  title: '',
  requiresPassword: false,
  requireLogin: false,
  isFull: false,
  status: 'ended',
}

/**
 * @param activeParticipantCount 終了していない meeting の在室人数。
 *        null = 「数えていない」（active でないルームでは満員か否かに意味がないので
 *        route 側はカウントクエリを省略する）→ isFull は false。
 */
export function toRoomMetaDTO(
  room: Pick<RoomSnapshot, 'status' | 'expires_at' | 'title' | 'require_login' | 'has_password' | 'max_participants'>,
  activeParticipantCount: number | null,
  now: Date,
): RoomMetaDTO {
  return {
    exists: true,
    title: room.title,
    requiresPassword: room.has_password,
    requireLogin: room.require_login,
    isFull: activeParticipantCount !== null && activeParticipantCount >= room.max_participants,
    status: toPublicRoomStatus(deriveRoomState(room, now)),
  }
}

// ============ クライアント IP（§12.3 の限流キー）============
/**
 * ⚠️ 信頼できるのは「リバースプロキシ配下で、プロキシが x-forwarded-for を
 * **上書き**している」場合だけ。素の Node に直接届くリクエストではクライアントが
 * 任意の値を送れるため、限流はいくらでも回避できる。
 * 本番でリバースプロキシ（ingress / CDN 等）の背後に置く構成なら前提を満たす。
 * ローカル開発では 'unknown' に落ちるのが正常。
 *
 * XFF は `client, proxy1, proxy2` の順なので先頭ホップを採用する。
 */
export function resolveClientIp(forwardedFor: string | null, realIp: string | null): string {
  const firstHop = forwardedFor?.split(',')[0]?.trim()
  if (firstHop) return firstHop
  const fallback = realIp?.trim()
  if (fallback) return fallback
  return 'unknown'
}
