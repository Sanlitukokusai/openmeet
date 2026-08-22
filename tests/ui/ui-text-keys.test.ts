// lib/ui-text.ts の ja / zh 辞書が同じキー集合を持つことを検証する。
// 新しい文案を片方の言語にだけ足す事故（表示が空文字/undefined になる）をここで防ぐ。
import { describe, expect, it } from 'vitest'
import { detectLocale, interpolate, muteErrorMessage, resolveApiErrorMessage, uiText } from '@/lib/ui-text'

function collectKeyPaths(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object') {
    return [prefix]
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    collectKeyPaths(child, prefix ? `${prefix}.${key}` : key),
  )
}

describe('uiText dictionary', () => {
  it('has an identical key set for ja and zh', () => {
    const jaKeys = collectKeyPaths(uiText.ja).sort()
    const zhKeys = collectKeyPaths(uiText.zh).sort()
    expect(zhKeys).toEqual(jaKeys)
  })

  it('has no empty string values in either locale', () => {
    for (const locale of ['ja', 'zh'] as const) {
      for (const path of collectKeyPaths(uiText[locale])) {
        const value = path.split('.').reduce<unknown>((acc, key) => (acc as Record<string, unknown>)[key], uiText[locale])
        expect(typeof value, `${locale}.${path} should be a string`).toBe('string')
        expect((value as string).length, `${locale}.${path} should not be empty`).toBeGreaterThan(0)
      }
    }
  })

  it('covers every JoinErrorCode / MediaErrorCode key referenced by the app', () => {
    const joinErrorCodes = [
      'INVALID_PASSWORD',
      'LOGIN_REQUIRED',
      'ROOM_NOT_FOUND',
      'ROOM_FULL',
      'ROOM_EXPIRED',
      'ROOM_ENDED',
      'TOO_MANY_ATTEMPTS',
      'SERVER_AT_CAPACITY',
      'VALIDATION_ERROR',
      'INTERNAL_ERROR',
      'UNKNOWN',
    ] as const
    const mediaErrorCodes = [
      'PERMISSION_DENIED',
      'DEVICE_NOT_FOUND',
      'CONNECT_FAILED',
      'TOKEN_INVALID',
      'ROOM_FULL',
      'DISCONNECTED_BY_SERVER',
      'UNKNOWN',
    ] as const

    // 2026-08-07：遠隔ミュート API（POST /participants/mute・mute-all）のエラーコード。
    const muteErrorCodes = [
      'PARTICIPANT_NOT_FOUND',
      'NO_AUDIO_TRACK',
      'REMOTE_UNMUTE_DISABLED',
      'ROOM_NOT_FOUND',
      'UNAUTHORIZED',
      'VALIDATION_ERROR',
      'INTERNAL_ERROR',
      'UNKNOWN',
    ] as const

    for (const locale of ['ja', 'zh'] as const) {
      for (const code of joinErrorCodes) expect(uiText[locale].joinErrors[code]).toBeTruthy()
      for (const code of mediaErrorCodes) expect(uiText[locale].mediaErrors[code]).toBeTruthy()
      for (const code of muteErrorCodes) expect(uiText[locale].muteErrors[code]).toBeTruthy()
    }
  })

  // WP-8：{title}/{min}/{max}/{password} のようなプレースホルダーを含む文言は、片方の
  // 言語だけトークンを消し忘れる/書き間違えるという「両方非空だが実際は壊れている」事故を
  // 上のテストでは検出できない（値が空文字列でさえなければ通ってしまうため）。テンプレート
  // 内の `{token}` 集合が ja/zh で完全一致することを個別に確認する。
  it('templated strings carry the same {token} placeholders in both locales', () => {
    const paths: Array<{
      section: 'dashboard' | 'roomForm' | 'chat' | 'mute' | 'capacity' | 'participants'
      key: string
    }> = [
      { section: 'dashboard', key: 'deleteConfirmBody' },
      { section: 'dashboard', key: 'endConfirmBody' },
      { section: 'dashboard', key: 'validationMaxParticipantsRange' },
      { section: 'dashboard', key: 'validationPasswordRange' },
      { section: 'roomForm', key: 'passwordOnceBody' },
      // 2026-08-07 追加分（チャット / 遠隔ミュート / 容量表示）
      { section: 'chat', key: 'tooLong' },
      { section: 'chat', key: 'unreadAria' },
      { section: 'mute', key: 'muteAllSuccess' },
      { section: 'mute', key: 'muteAllPartial' },
      { section: 'mute', key: 'muteSuccess' },
      { section: 'mute', key: 'unmuteSuccess' },
      { section: 'capacity', key: 'onlineCount' },
      // 2026-08-07 第 2 波（会議室一覧の在線人数 / 参加者一覧パネル）
      { section: 'dashboard', key: 'statusInMeeting' },
      { section: 'participants', key: 'toggleAria' },
      { section: 'participants', key: 'countLabel' },
    ]

    function tokensOf(template: string): string[] {
      return Array.from(template.matchAll(/\{(\w+)\}/g), (m) => m[1]).sort()
    }

    for (const { section, key } of paths) {
      const jaTemplate = (uiText.ja[section] as Record<string, string>)[key]
      const zhTemplate = (uiText.zh[section] as Record<string, string>)[key]
      expect(tokensOf(zhTemplate), `${section}.${key}`).toEqual(tokensOf(jaTemplate))
      // プレースホルダーが一つも無い ＝ 書き忘れの可能性が高いので、必ず 1 つ以上あることも確認する。
      expect(tokensOf(jaTemplate).length, `${section}.${key} should contain at least one {token}`).toBeGreaterThan(0)
    }
  })
})

describe('detectLocale', () => {
  it('falls back to ja when the runtime navigator.language does not start with zh', () => {
    // vitest runs in a plain Node environment (vitest.config.ts: environment 'node').
    // Node >=21 ships a minimal built-in `navigator` global (e.g. language 'en-US'),
    // so this also guards the "navigator exists but isn't a browser" branch, not just
    // the fully-undefined case.
    expect(detectLocale()).toBe('ja')
  })
})

describe('interpolate', () => {
  it('replaces every {token} with the matching param', () => {
    expect(interpolate('{a} + {b} = {c}', { a: 1, b: 2, c: 3 })).toBe('1 + 2 = 3')
  })

  it('leaves an unmatched {token} untouched instead of throwing', () => {
    expect(interpolate('hello {name}', {})).toBe('hello {name}')
  })

  it('is a no-op on a template with no tokens', () => {
    expect(interpolate('no tokens here', { unused: 1 })).toBe('no tokens here')
  })
})

describe('muteErrorMessage', () => {
  it('既知コードは専用文言を返す', () => {
    expect(muteErrorMessage('NO_AUDIO_TRACK', 'ja')).toBe(uiText.ja.muteErrors.NO_AUDIO_TRACK)
    expect(muteErrorMessage('NO_AUDIO_TRACK', 'zh')).toBe(uiText.zh.muteErrors.NO_AUDIO_TRACK)
  })

  it('未知コード・コード無しは UNKNOWN に落とす（サーバーの生 message は出さない）', () => {
    expect(muteErrorMessage('SOME_FUTURE_CODE', 'ja')).toBe(uiText.ja.muteErrors.UNKNOWN)
    expect(muteErrorMessage(undefined, 'zh')).toBe(uiText.zh.muteErrors.UNKNOWN)
    expect(muteErrorMessage(null, 'ja')).toBe(uiText.ja.muteErrors.UNKNOWN)
  })

  it('Object.prototype 由来のキーを拾わない（"toString" 等）', () => {
    expect(muteErrorMessage('toString', 'ja')).toBe(uiText.ja.muteErrors.UNKNOWN)
  })
})

describe('resolveApiErrorMessage', () => {
  const KNOWN = ['VALIDATION_ERROR', 'INTERNAL_ERROR'] as const

  it('prefers the localized fallback over the server message for a known code', () => {
    expect(resolveApiErrorMessage('INTERNAL_ERROR', KNOWN, 'サーバー内部の生メッセージ', '本地化された文言')).toBe(
      '本地化された文言',
    )
  })

  it('passes the server message through for an unrecognized code', () => {
    expect(resolveApiErrorMessage('SOME_FUTURE_CODE', KNOWN, 'サーバーの生メッセージ', 'ローカルの文言')).toBe(
      'サーバーの生メッセージ',
    )
  })

  it('falls back to the localized text when there is no code and no server message', () => {
    expect(resolveApiErrorMessage(undefined, KNOWN, undefined, 'ローカルの文言')).toBe('ローカルの文言')
    expect(resolveApiErrorMessage(null, KNOWN, null, 'ローカルの文言')).toBe('ローカルの文言')
  })

  it('falls back to the localized text when the code is unknown and the server message is an empty string', () => {
    expect(resolveApiErrorMessage('SOME_FUTURE_CODE', KNOWN, '', 'ローカルの文言')).toBe('ローカルの文言')
  })
})
