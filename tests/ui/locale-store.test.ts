// lib/store/locale-store.ts の優先順位ロジック（localStorage の手動選択 > navigator.language
// 推定 > 'ja'）を検証する。vitest は node 環境で動く（vitest.config.ts）ため、
// localStorage は既定で存在せず（tests/ui/join-storage.test.ts が使う window.*Storage の
// 依存注入パターンとは違い、resolveInitialLocale() は引数を取らない純関数なので）
// vi.stubGlobal で localStorage / navigator をそのテストの間だけ差し替える。
// Node は navigator をビルトインで持つ（configurable な accessor）ため、
// vi.stubGlobal('navigator', ...) で問題なく上書きできることを事前に確認済み。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveInitialLocale } from '@/lib/store/locale-store'

function stubLocalStorage(storedValue: string | null) {
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => (key === 'meet.locale' ? storedValue : null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  })
}

describe('resolveInitialLocale', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('prefers a manually-stored locale over the browser language, even when they disagree', () => {
    stubLocalStorage('zh')
    vi.stubGlobal('navigator', { language: 'ja-JP' })
    expect(resolveInitialLocale()).toBe('zh')
  })

  it('prefers a manually-stored "ja" over a zh browser language', () => {
    stubLocalStorage('ja')
    vi.stubGlobal('navigator', { language: 'zh-CN' })
    expect(resolveInitialLocale()).toBe('ja')
  })

  it('falls back to the browser language when nothing is stored', () => {
    stubLocalStorage(null)
    vi.stubGlobal('navigator', { language: 'zh-CN' })
    expect(resolveInitialLocale()).toBe('zh')
  })

  it('falls back to ja when nothing is stored and the browser language is not zh-*', () => {
    stubLocalStorage(null)
    vi.stubGlobal('navigator', { language: 'en-US' })
    expect(resolveInitialLocale()).toBe('ja')
  })

  it('ignores a stored value that is not a valid Locale and falls back to browser inference', () => {
    stubLocalStorage('fr') // 'ja' | 'zh' 以外の不正値
    vi.stubGlobal('navigator', { language: 'zh-TW' })
    expect(resolveInitialLocale()).toBe('zh')
  })

  it('treats a zh-* language as a case-insensitive prefix match (e.g. zh-Hans, ZH-CN)', () => {
    stubLocalStorage(null)
    vi.stubGlobal('navigator', { language: 'ZH-Hans' })
    expect(resolveInitialLocale()).toBe('zh')
  })

  it('does not throw when localStorage.getItem throws (e.g. Safari private mode) and falls back to browser inference', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('access denied')
      },
    })
    vi.stubGlobal('navigator', { language: 'zh-CN' })
    expect(resolveInitialLocale()).toBe('zh')
  })

  it('falls back to ja when localStorage is entirely unavailable and there is no navigator', () => {
    // localStorage は元々 undefined（stub しない）。navigator も無い状態を模倣する。
    vi.stubGlobal('navigator', undefined)
    expect(resolveInitialLocale()).toBe('ja')
  })
})
