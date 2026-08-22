// 満屏タイルの object-fit 切替（2026-08-14 実機「人が映ると背景が全部見えない」）。
//
// 縦持ちで 16:9 の映像を cover すると左右が切り落とされるので、タップで contain
// （上下に黒帯・合成画面が丸ごと見える）へ切り替えられるようにした。その状態遷移と
// sessionStorage の入出力を固定する。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_VIDEO_FIT,
  VIDEO_FIT_HINT_MS,
  VIDEO_FIT_STORAGE_KEY,
  loadVideoFit,
  nextVideoFit,
  parseVideoFit,
  saveVideoFit,
  videoFitClass,
} from '@/components/room/video-fit'

/** node 環境なので window は無い。最小限の sessionStorage を持つ window を差し込む。 */
function installFakeWindow(storage?: Partial<Storage>) {
  const store = new Map<string, string>()
  const sessionStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
    ...storage,
  }
  ;(globalThis as Record<string, unknown>).window = { sessionStorage }
  return store
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window
})

describe('nextVideoFit', () => {
  it('cover ⇄ contain をトグルする', () => {
    expect(nextVideoFit('cover')).toBe('contain')
    expect(nextVideoFit('contain')).toBe('cover')
  })

  it('2 回で元に戻る（タップし続けても 2 状態から出ない）', () => {
    expect(nextVideoFit(nextVideoFit('cover'))).toBe('cover')
  })
})

describe('videoFitClass', () => {
  it('Tailwind のクラスへ 1:1 で対応する', () => {
    expect(videoFitClass('cover')).toBe('object-cover')
    expect(videoFitClass('contain')).toBe('object-contain')
  })

  it('返る文字列は完全なクラス名（部分文字列の合成をしない＝Tailwind の抽出が効く）', () => {
    for (const fit of ['cover', 'contain'] as const) {
      expect(videoFitClass(fit)).toMatch(/^object-(cover|contain)$/)
    }
  })
})

describe('parseVideoFit', () => {
  it('contain だけを contain と認め、それ以外は既定へ倒す', () => {
    expect(parseVideoFit('contain')).toBe('contain')
    expect(parseVideoFit('cover')).toBe('cover')
  })

  it.each([null, undefined, '', 'COVER', 'fill', 42, {}])('不正値 %j は既定（cover）', (raw) => {
    expect(parseVideoFit(raw)).toBe(DEFAULT_VIDEO_FIT)
  })

  it('既定は cover（没入感を優先し、黒帯を出さない）', () => {
    expect(DEFAULT_VIDEO_FIT).toBe('cover')
  })
})

describe('loadVideoFit / saveVideoFit', () => {
  beforeEach(() => {
    installFakeWindow()
  })

  it('保存した値を読み戻せる', () => {
    saveVideoFit('contain')
    expect(loadVideoFit()).toBe('contain')
    saveVideoFit('cover')
    expect(loadVideoFit()).toBe('cover')
  })

  it('キーは meet. 接頭辞付き（同一オリジンを他プロジェクトと共有しうるため）', () => {
    const store = installFakeWindow()
    saveVideoFit('contain')
    expect(store.get(VIDEO_FIT_STORAGE_KEY)).toBe('contain')
    expect(VIDEO_FIT_STORAGE_KEY.startsWith('meet.')).toBe(true)
  })

  it('未保存なら既定', () => {
    expect(loadVideoFit()).toBe(DEFAULT_VIDEO_FIT)
  })

  it('sessionStorage が例外を投げても落ちない（プライベートブラウジング等）', () => {
    installFakeWindow({
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    })
    expect(loadVideoFit()).toBe(DEFAULT_VIDEO_FIT)
    expect(() => saveVideoFit('contain')).not.toThrow()
  })

  it('window が無い（SSR）なら既定を返し、書き込みも何もしない', () => {
    delete (globalThis as Record<string, unknown>).window
    expect(loadVideoFit()).toBe(DEFAULT_VIDEO_FIT)
    expect(() => saveVideoFit('contain')).not.toThrow()
  })

  it('localStorage には触らない（会話中だけの一時的な好み＝次回に持ち越さない）', () => {
    const localSetItem = vi.fn()
    ;(globalThis as Record<string, unknown>).localStorage = { setItem: localSetItem, getItem: () => null }
    installFakeWindow()
    saveVideoFit('contain')
    loadVideoFit()
    expect(localSetItem).not.toHaveBeenCalled()
    delete (globalThis as Record<string, unknown>).localStorage
  })
})

describe('ヒントチップ', () => {
  it('表示時間は 1.2 秒（押した手応えとして十分、邪魔にならない長さ）', () => {
    expect(VIDEO_FIT_HINT_MS).toBe(1200)
  })
})
