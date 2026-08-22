// 発言中ハイライトの class（2026-08-07 第 2 波・実機バグ修正の回帰テスト）。
//
// 直した不具合：`animate-pulse`（opacity 100%↔50% の 2 秒往復）を遠端タイルの**コンテナ**に
// 付けていたため、相手が喋るたびに子要素の <video> まで一緒に暗くなり、映像が呼吸灯のように
// 明滅した。アニメーションは映像を含まない専用オーバーレイへ移した。
//
// ここで固定するのは「二度と映像の祖先に animate-pulse を戻さない」という一点。
// vitest は node 環境（jsdom 無し）なので DOM ではなく class 計算の純関数を直接叩く。
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  speakingAvatarRingClass,
  speakingOverlayClass,
  TILE_CONTAINER_CLASS,
  TILE_CONTAINER_FILL_CLASS,
} from '@/components/room/speaking-highlight'

const PULSE = 'animate-pulse'

describe('TILE_CONTAINER_CLASS（<video> の祖先）', () => {
  it('animate-pulse を含まない——これが混入すると映像が明滅する', () => {
    expect(TILE_CONTAINER_CLASS).not.toContain(PULSE)
  })

  it('animate- 系のアニメーションユーティリティを一切持たない', () => {
    expect(TILE_CONTAINER_CLASS).not.toMatch(/\banimate-/)
  })

  it('静的なリングは残す（発言の有無でタイルの縁幅が変わらない）', () => {
    expect(TILE_CONTAINER_CLASS).toContain('ring-1')
    expect(TILE_CONTAINER_CLASS).toContain('ring-zinc-700')
  })

  it('タイルのレイアウト前提は維持（相対配置＝オーバーレイの基準、映像のはみ出し抑止）', () => {
    expect(TILE_CONTAINER_CLASS).toContain('relative')
    expect(TILE_CONTAINER_CLASS).toContain('overflow-hidden')
    // ホバーで出るミュートボタン（md:group-hover:opacity-100）の起点
    expect(TILE_CONTAINER_CLASS).toContain('group')
  })
})

describe('TILE_CONTAINER_FILL_CLASS（モバイルの満屏/宮格タイル、2026-08-14）', () => {
  it('animate-pulse を含まない——TILE_CONTAINER_CLASS と同じ理由', () => {
    expect(TILE_CONTAINER_FILL_CLASS).not.toContain(PULSE)
  })

  it('animate- 系のアニメーションユーティリティを一切持たない', () => {
    expect(TILE_CONTAINER_FILL_CLASS).not.toMatch(/\banimate-/)
  })

  it('aspect-video を持たない——親のサイズをそのまま埋めるのが目的', () => {
    expect(TILE_CONTAINER_FILL_CLASS).not.toContain('aspect-video')
    expect(TILE_CONTAINER_FILL_CLASS).toContain('h-full')
    expect(TILE_CONTAINER_FILL_CLASS).toContain('w-full')
  })

  it('タイルのレイアウト前提は TILE_CONTAINER_CLASS と共通（オーバーレイの基準・ホバーボタンの起点）', () => {
    expect(TILE_CONTAINER_FILL_CLASS).toContain('relative')
    expect(TILE_CONTAINER_FILL_CLASS).toContain('overflow-hidden')
    expect(TILE_CONTAINER_FILL_CLASS).toContain('group')
  })
})

describe('speakingOverlayClass（アニメーションを載せる専用オーバーレイ）', () => {
  it('通常は animate-pulse を持つ', () => {
    expect(speakingOverlayClass(false)).toContain(PULSE)
  })

  it('prefers-reduced-motion では静止リング（アニメーションしない）', () => {
    expect(speakingOverlayClass(true)).not.toContain(PULSE)
  })

  it('どちらの分岐でも琥珀色のリングは出る（見た目の意味は変えない）', () => {
    for (const reduced of [true, false]) {
      expect(speakingOverlayClass(reduced)).toContain('ring-2')
      expect(speakingOverlayClass(reduced)).toContain('ring-amber-400')
    }
  })

  it('操作を奪わない・映像に重ならない位置指定（クリックはタイル側へ抜ける）', () => {
    for (const reduced of [true, false]) {
      const cls = speakingOverlayClass(reduced)
      expect(cls).toContain('pointer-events-none')
      expect(cls).toContain('absolute')
      expect(cls).toContain('inset-0')
    }
  })

  it('2 つの分岐は animate-pulse の有無だけが違う（片方だけ見た目が崩れない）', () => {
    expect(speakingOverlayClass(false)).toBe(`${speakingOverlayClass(true)} ${PULSE}`)
  })

  it('コンテナ側の class とは別物（オーバーレイを消してコンテナに戻す回帰を防ぐ）', () => {
    expect(speakingOverlayClass(false)).not.toBe(TILE_CONTAINER_CLASS)
  })
})

// ============================================================
// 構造的なガード：class 計算関数を経由せず、その場で書き戻される回帰も止める。
// 「<video> を描画するファイルは animate-pulse という文字列を一切含んではならない」
// ——オーバーレイの class は speaking-highlight.ts（映像を描かないファイル）にあるので
// この規則と両立する。ここに引っかかったら、まず「その pulse は映像の祖先か？」を疑うこと。
// ============================================================
describe('映像を描画するコンポーネントに animate-pulse が書かれていない', () => {
  const componentsDir = fileURLToPath(new URL('../../components', import.meta.url))

  function collectTsxFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) return collectTsxFiles(full)
      return entry.isFile() && entry.name.endsWith('.tsx') ? [full] : []
    })
  }

  /**
   * コメントを落としてから検査する。この不具合の**説明コメント**（ParticipantTile.tsx に
   * 書いてある「なぜコンテナに animate-pulse を付けてはいけないか」）まで違反として
   * 拾ってしまうと、直した理由を書けなくなる——検査したいのは実際に DOM へ渡る class だけ。
   */
  function stripComments(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, '') // /* ... */ と JSX の {/* ... */}
      .replace(/(^|[^:])\/\/.*$/gm, '$1') // // 行コメント（URL の // は残す）
  }

  const videoFiles = collectTsxFiles(componentsDir).filter((path) => readFileSync(path, 'utf8').includes('<video'))

  it('対象ファイルを実際に見つけている（グロブが空振りして常に緑、を防ぐ）', () => {
    expect(videoFiles.length).toBeGreaterThan(0)
  })

  it.each(videoFiles)('%s', (path) => {
    expect(stripComments(readFileSync(path, 'utf8'))).not.toContain(PULSE)
  })
})

describe('speakingAvatarRingClass（参加者一覧パネルのアバター）', () => {
  it('タイルと同じ規約：アニメーションは本体ではなくオーバーレイに載る', () => {
    expect(speakingAvatarRingClass(false)).toContain(PULSE)
    expect(speakingAvatarRingClass(true)).not.toContain(PULSE)
    expect(speakingAvatarRingClass(false)).toBe(`${speakingAvatarRingClass(true)} ${PULSE}`)
  })

  it('円形のリングで、下のイニシャル文字のクリックを奪わない', () => {
    for (const reduced of [true, false]) {
      const cls = speakingAvatarRingClass(reduced)
      expect(cls).toContain('rounded-full')
      expect(cls).toContain('ring-amber-400')
      expect(cls).toContain('pointer-events-none')
    }
  })
})
