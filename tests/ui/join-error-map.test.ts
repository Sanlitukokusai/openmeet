// POST /join のエラーコード → 文案マッピング（lib/ui-text.ts joinErrorMessage）の検証。
// lib/server/join-policy.ts の JoinDenyCode と 1 対 1 対応するコード集合を、
// WP-4 は API 契約（規格書 §6.2）としてのみ知っている（lib/server/** は import しない）。
import { describe, expect, it } from 'vitest'
import { joinErrorMessage, uiText } from '@/lib/ui-text'

// 規格书 §6.2 のエラーコード一覧（VALIDATION_ERROR / INTERNAL_ERROR は
// lib/server/api-response.ts ApiErrorCode 由来の一般エラー、join/route.ts が返しうる）。
const KNOWN_CODES = [
  'INVALID_PASSWORD',
  'LOGIN_REQUIRED',
  'ROOM_NOT_FOUND',
  'ROOM_FULL',
  'ROOM_EXPIRED',
  'ROOM_ENDED',
  'TOO_MANY_ATTEMPTS',
  'VALIDATION_ERROR',
  'INTERNAL_ERROR',
] as const

describe('joinErrorMessage', () => {
  it.each(KNOWN_CODES)('maps %s to a distinct, non-empty message in ja', (code) => {
    const message = joinErrorMessage(code, 'ja')
    expect(message).toBeTruthy()
    expect(message).not.toBe(uiText.ja.joinErrors.UNKNOWN)
  })

  it.each(KNOWN_CODES)('maps %s to a distinct, non-empty message in zh', (code) => {
    const message = joinErrorMessage(code, 'zh')
    expect(message).toBeTruthy()
    expect(message).not.toBe(uiText.zh.joinErrors.UNKNOWN)
  })

  it('falls back to the UNKNOWN message for an unrecognised code', () => {
    expect(joinErrorMessage('SOME_FUTURE_CODE', 'ja')).toBe(uiText.ja.joinErrors.UNKNOWN)
    expect(joinErrorMessage('SOME_FUTURE_CODE', 'zh')).toBe(uiText.zh.joinErrors.UNKNOWN)
  })

  it('produces a full set of unique messages per locale (no copy-paste duplicates)', () => {
    for (const locale of ['ja', 'zh'] as const) {
      const messages = KNOWN_CODES.map((code) => joinErrorMessage(code, locale))
      expect(new Set(messages).size).toBe(messages.length)
    }
  })
})
