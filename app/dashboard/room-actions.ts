// WP-7: dashboard の房间管理操作用の純粋ロジック（React/HeroUI に依存しない）。
// tests/rooms/dashboard-actions.test.ts から直接 import してユニットテストする。
//
// ⚠️ 意図的に lib/server/rooms-logic.ts の**実行時バインディング**（schema・定数）は
// import しない。あちらは先頭で `import { z } from 'zod'` しており、実行時 import は
// zod ごとクライアントバンドルに持ち込んでしまう——app/dashboard/page.tsx が
// `RoomListItemDTO` / `RoomState` を `import type` に留めているのと同じ理由（型は
// コンパイル時に消えるので安全）。ここで使う境界値は lib/server/rooms-logic.ts §5.1 の
// MAX_PARTICIPANTS_MIN/MAX・ROOM_PASSWORD_MIN/MAX のクライアント側ミラー。値を変える
// ときは両方直すこと。
import type { RoomState } from '@/lib/server/rooms-logic'
// WP-8：Tooltip / 校验文案の多语言化。uiText は zod 等の重い実行時依存を持たない
// （lib/ui-text.ts 冒头コメント参照）ので、ここで value import しても zod がクライアント
// バンドルに紛れ込む心配はない——避けているのは lib/server/rooms-logic.ts の実行時 import
// だけ（上のコメント参照）。
import { interpolate, uiText, type Locale } from '@/lib/ui-text'

export const EDIT_MAX_PARTICIPANTS_MIN = 2
export const EDIT_MAX_PARTICIPANTS_MAX = 50
export const EDIT_PASSWORD_MIN = 6
export const EDIT_PASSWORD_MAX = 8

// ============ ボタン可用性マトリクス ============
// 仕様（WP-7 依頼書より）：
//   disabled（削除済み）：編集・削除・会議を終了のすべて禁止
//   expired（期限切れ） ：編集○（有効期限を変えれば復活できる）・削除○・終了✕
//   ended  （終了済み） ：編集○・削除○・終了✕
//   active （開催中）   ：すべて○
//   enter  （入室する）  ：active のみ○——ここは後端 /join の挙動と必ず一致させる
//                          （expired→410 ROOM_EXPIRED、ended/disabled→410 ROOM_ENDED）。
//                          押せるのに必ず失敗する導線を作らないための同期。
export type RoomAction = 'edit' | 'delete' | 'end' | 'enter'

const ACTION_ENABLED_BY_STATUS: Record<RoomAction, Record<RoomState, boolean>> = {
  edit: { active: true, expired: true, ended: true, disabled: false },
  delete: { active: true, expired: true, ended: true, disabled: false },
  end: { active: true, expired: false, ended: false, disabled: false },
  enter: { active: true, expired: false, ended: false, disabled: false },
}

// 無効化理由（Tooltip 表示用の文言。ja/zh は lib/ui-text.ts の dashboard.*DisabledXxx）。
// 有効な組み合わせにはキーを持たせない。locale ごとに動的に組み立てる
// （文言そのものは辞書に一本化し、ここは「どの状態にどのキーを当てるか」のマトリクスだけ持つ）。
function disabledReasonByStatus(locale: Locale): Record<RoomAction, Partial<Record<RoomState, string>>> {
  const t = uiText[locale].dashboard
  return {
    edit: {
      disabled: t.editDisabledDeleted,
    },
    delete: {
      disabled: t.deleteDisabledDeleted,
    },
    end: {
      disabled: t.endDisabledDeleted,
      expired: t.endDisabledExpired,
      ended: t.endDisabledEnded,
    },
    enter: {
      disabled: t.enterDisabledDeleted,
      expired: t.enterDisabledExpired,
      ended: t.enterDisabledEnded,
    },
  }
}

export function isRoomActionEnabled(status: RoomState, action: RoomAction): boolean {
  return ACTION_ENABLED_BY_STATUS[action][status]
}

/** ボタン無効時に Tooltip へ出す理由文言。有効なら null（＝静默禁用ではなく明示説明を必須にする）。
 *  locale 省略時は 'ja'（既存呼び出し元・既存テストとの後方互換）。 */
export function getRoomActionDisabledReason(status: RoomState, action: RoomAction, locale: Locale = 'ja'): string | null {
  if (isRoomActionEnabled(status, action)) return null
  return disabledReasonByStatus(locale)[action][status] ?? null
}

// ============ 編集フォーム：diff 計算 ============
// PATCH は部分更新なので「実際に変更されたフィールドだけ」を送る。password は
// 三態（変更しない/新しく設定/削除）なので diff とは別ロジックで扱う。

export type PasswordEditMode = 'unchanged' | 'set' | 'clear'

/** GET /api/rooms/{id} の応答から作る、編集フォームの初期値（＝比較基準）。 */
export interface RoomEditBaseline {
  title: string
  maxParticipants: number
  /** <input type="datetime-local"> 形式の文字列。未設定は ''。isoToLocalDateTime() で変換して渡す。 */
  expiresAtLocal: string
  requireLogin: boolean
}

export interface RoomEditFormValues extends RoomEditBaseline {
  passwordMode: PasswordEditMode
  /** passwordMode === 'set' のときだけ意味を持つ。 */
  newPassword: string
}

export interface RoomPatchPayload {
  title?: string
  maxParticipants?: number
  expiresAt?: string | null
  requireLogin?: boolean
  password?: string | null
}

/** <input type="datetime-local"> の値 → ISO 文字列。空文字・不正な値は null。 */
export function localDateTimeToIso(value: string): string | null {
  if (!value) return null
  const time = new Date(value).getTime()
  return Number.isNaN(time) ? null : new Date(time).toISOString()
}

/** ISO 文字列 → <input type="datetime-local"> 用の値。null は空文字（プリフィル用）。 */
export function isoToLocalDateTime(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * baseline（GET 直後の初期値）と form（現在の入力値）を比較し、実際に変更された
 * フィールドだけを積んだ PATCH ボディを作る。何も変わっていなければ {} を返し、
 * 呼び出し側はこれで送信ボタンの活性/非活性を判定する（{} を送ると patchRoomSchema の
 * refine に落ちて「更新する項目がありません」400 になるため、そもそも送らせない）。
 *
 * expiresAt は datetime-local の**文字列同士**を比較してから ISO に変換する
 * （baseline 側も isoToLocalDateTime() 経由の同じ形式なので、未変更なら文字列が完全一致し、
 * Date 往復による秒未満の誤差で誤検知することがない）。
 */
export function computeRoomPatchDiff(baseline: RoomEditBaseline, form: RoomEditFormValues): RoomPatchPayload {
  const diff: RoomPatchPayload = {}

  const trimmedTitle = form.title.trim()
  if (trimmedTitle !== baseline.title) {
    diff.title = trimmedTitle
  }

  if (form.maxParticipants !== baseline.maxParticipants) {
    diff.maxParticipants = form.maxParticipants
  }

  if (form.requireLogin !== baseline.requireLogin) {
    diff.requireLogin = form.requireLogin
  }

  if (form.expiresAtLocal !== baseline.expiresAtLocal) {
    diff.expiresAt = localDateTimeToIso(form.expiresAtLocal)
  }

  if (form.passwordMode === 'set') {
    diff.password = form.newPassword
  } else if (form.passwordMode === 'clear') {
    diff.password = null
  }
  // 'unchanged' の場合は password キー自体を持たせない（省略＝現状維持、patchRoomSchema の三態と一致）。

  return diff
}

export function isEmptyPatch(diff: RoomPatchPayload): boolean {
  return Object.keys(diff).length === 0
}

/**
 * lib/server/rooms-logic.ts の patchRoomSchema（§5.1）と境界値を揃えたクライアント側の
 * 事前検証。サーバーの検証を置き換えるものではなく、往復せずに即座にフィードバックを
 * 返すためのもの——最終的な正はサーバー応答（エラー時はその message を表示する）。
 */
export function validateRoomEditForm(form: RoomEditFormValues, locale: Locale = 'ja'): string | null {
  const t = uiText[locale].dashboard
  if (form.title.trim().length === 0) {
    return t.validationTitleRequired
  }
  if (form.maxParticipants < EDIT_MAX_PARTICIPANTS_MIN || form.maxParticipants > EDIT_MAX_PARTICIPANTS_MAX) {
    return interpolate(t.validationMaxParticipantsRange, { min: EDIT_MAX_PARTICIPANTS_MIN, max: EDIT_MAX_PARTICIPANTS_MAX })
  }
  if (form.passwordMode === 'set') {
    const len = form.newPassword.length
    if (len < EDIT_PASSWORD_MIN || len > EDIT_PASSWORD_MAX) {
      return interpolate(t.validationPasswordRange, { min: EDIT_PASSWORD_MIN, max: EDIT_PASSWORD_MAX })
    }
  }
  return null
}
