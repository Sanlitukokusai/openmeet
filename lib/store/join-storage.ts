/**
 * 入会フロー用のブラウザストレージ封装（規格書 §7.1〜§7.5）。
 *
 * 三種類のデータを扱う：
 *  - join draft（sessionStorage, key に roomCode を含む）：/j エントリーページで
 *    入力した表示名・パスワードを一時保存し、/prejoin へ引き継ぐ。パスワードは
 *    URL に絶対に乗せない（§7.4）が、同一タブ内の sessionStorage は許容範囲。
 *  - join result（sessionStorage）：/prejoin が POST /join に成功した後の
 *    { config, role, participantId, ... } を /room ページへ引き継ぐ。
 *  - デバイス選好・前回の表示名（localStorage）：§7.5 の「選択結果は localStorage
 *    に保存し次回使う」。
 *
 * ⚠️ vitest は node 環境で動く（vitest.config.ts、DOM 無し）。この関数群は
 * window.sessionStorage / localStorage をトップレベルで参照せず、呼び出し時に
 * 遅延解決する（`resolveStorage` 内で `typeof window` を見る）ことで、
 * テストからは第 2 引数に自作の StorageLike を渡して DOM 無しで検証できる。
 */
import type { ProviderConfig } from '@/lib/media/types'

/** window.sessionStorage / localStorage と互換の最小インターフェース（テスト用のフェイクも実装できる）。 */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface JoinDraft {
  displayName: string
  /** 無密码房间では undefined。 */
  password?: string
}

/** POST /join 成功レスポンス + prejoin で選んだ初期デバイス状態。/room ページが読む。 */
export interface JoinResult {
  config: ProviderConfig
  role: 'host' | 'guest'
  participantId: string
  displayName: string
  initialAudio: boolean
  initialVideo: boolean
  initialAudioDeviceId?: string
  initialVideoDeviceId?: string
}

export interface DevicePrefs {
  audioDeviceId?: string
  videoDeviceId?: string
  audioOutputDeviceId?: string
}

const DRAFT_PREFIX = 'meet:join-draft:'
const RESULT_PREFIX = 'meet:join-result:'
const LAST_NAME_KEY = 'meet:last-display-name'
const DEVICE_PREFS_KEY = 'meet:device-prefs'

function resolveStorage(explicit: StorageLike | undefined, area: 'session' | 'local'): StorageLike | null {
  if (explicit) return explicit
  if (typeof window === 'undefined') return null
  try {
    return area === 'session' ? window.sessionStorage : window.localStorage
  } catch {
    // Safari のプライベートブラウズ等でアクセス自体が例外を投げることがある。
    // 保存できないだけで機能停止させるほどではないので静かに諦める。
    return null
  }
}

function safeParse<T>(raw: string | null): T | null {
  if (raw === null || raw === '') return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

export function joinDraftKey(roomCode: string): string {
  return `${DRAFT_PREFIX}${roomCode}`
}

export function joinResultKey(roomCode: string): string {
  return `${RESULT_PREFIX}${roomCode}`
}

// ============ join draft（sessionStorage）============

export function saveJoinDraft(roomCode: string, draft: JoinDraft, storage?: StorageLike): void {
  resolveStorage(storage, 'session')?.setItem(joinDraftKey(roomCode), JSON.stringify(draft))
}

export function loadJoinDraft(roomCode: string, storage?: StorageLike): JoinDraft | null {
  const parsed = safeParse<JoinDraft>(resolveStorage(storage, 'session')?.getItem(joinDraftKey(roomCode)) ?? null)
  if (!parsed || typeof parsed.displayName !== 'string' || parsed.displayName.length === 0) return null
  return parsed
}

export function clearJoinDraft(roomCode: string, storage?: StorageLike): void {
  resolveStorage(storage, 'session')?.removeItem(joinDraftKey(roomCode))
}

// ============ join result（sessionStorage）============

export function saveJoinResult(roomCode: string, result: JoinResult, storage?: StorageLike): void {
  resolveStorage(storage, 'session')?.setItem(joinResultKey(roomCode), JSON.stringify(result))
}

export function loadJoinResult(roomCode: string, storage?: StorageLike): JoinResult | null {
  const parsed = safeParse<JoinResult>(resolveStorage(storage, 'session')?.getItem(joinResultKey(roomCode)) ?? null)
  if (!parsed || typeof parsed.participantId !== 'string' || parsed.participantId.length === 0 || !parsed.config) {
    return null
  }
  return parsed
}

export function clearJoinResult(roomCode: string, storage?: StorageLike): void {
  resolveStorage(storage, 'session')?.removeItem(joinResultKey(roomCode))
}

// ============ 前回の表示名（localStorage）============

export function getLastDisplayName(storage?: StorageLike): string {
  return resolveStorage(storage, 'local')?.getItem(LAST_NAME_KEY) ?? ''
}

export function setLastDisplayName(name: string, storage?: StorageLike): void {
  resolveStorage(storage, 'local')?.setItem(LAST_NAME_KEY, name)
}

// ============ デバイス選好（localStorage）============

export function getDevicePrefs(storage?: StorageLike): DevicePrefs {
  return safeParse<DevicePrefs>(resolveStorage(storage, 'local')?.getItem(DEVICE_PREFS_KEY) ?? null) ?? {}
}

export function setDevicePrefs(prefs: DevicePrefs, storage?: StorageLike): void {
  resolveStorage(storage, 'local')?.setItem(DEVICE_PREFS_KEY, JSON.stringify(prefs))
}
