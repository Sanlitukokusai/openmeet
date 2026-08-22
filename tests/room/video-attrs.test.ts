// 構造ガード：**すべての `<video>` に `playsInline` / `muted` / `autoPlay` が付いている**こと。
//
// なぜテストで縛るのか（2026-08-14 実機「カメラを付けたまま揺らしたら真っ黒」の調査より）：
//   - `playsInline` が無いと **iOS Safari は再生を全画面に乗っ取る**（インライン再生を拒否）。
//     一部の Android WebView / 国産ブラウザは**そもそも再生しない**——見た目は「真っ黒」。
//   - `muted` が無いと、ブラウザの自動再生ポリシーで `autoPlay` が無視される
//     （音声付きメディアの自動再生は原則ブロック）。遠端タイルでは加えて、
//     遠端音声は provider 内部の隠し `<audio>` が鳴らしているので、ここでも鳴らすと二重再生になる。
//   - `autoPlay` が無いと、`track.attach()` が srcObject を差した後に誰も play() しない。
//
// これらは「一箇所直せば終わり」ではなく、新しい映像タイルを足すたびに再発しうる
// （speaking-highlight の animate-pulse と同じ性質の回帰）ので、ソースを機械的に検査する。
// vitest は node 環境（jsdom 無し）なので DOM ではなくソース文字列を見る。
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const COMPONENTS_DIR = fileURLToPath(new URL('../../components', import.meta.url))

function collectTsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return collectTsxFiles(full)
    return entry.isFile() && entry.name.endsWith('.tsx') ? [full] : []
  })
}

/**
 * コメントを落としてから走査する。ソース中の説明コメントにも `<video>` という語が出てくる
 * （ParticipantTile の「なぜコンテナに animate-pulse を付けないか」の説明など）ので、
 * 落とさないと本物のタグではない箇所を拾ってしまう——speaking-highlight.test.ts と同じ作法。
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '') // /* ... */ と JSX の {/* ... */}
    .replace(/(^|[^:])\/\/.*$/gm, '$1') // // 行コメント（URL の // は残す）
}

/** JSX の `<video ... />` タグを丸ごと拾う（自己閉じタグ前提——本プロジェクトの video は子を持たない）。 */
function collectVideoTags(source: string): string[] {
  // `<video` の直後は属性が続く（＝空白）ことを要求し、`<video>` のような素の記述は拾わない。
  return [...stripComments(source).matchAll(/<video\s[\s\S]*?\/>/g)].map((m) => m[0])
}

interface VideoTag {
  file: string
  tag: string
}

const videoTags: VideoTag[] = collectTsxFiles(COMPONENTS_DIR).flatMap((file) =>
  collectVideoTags(readFileSync(file, 'utf8')).map((tag) => ({ file, tag })),
)

describe('すべての <video> に必須属性が付いている', () => {
  it('検査対象を実際に見つけている（グロブが空振りして常に緑、を防ぐ）', () => {
    // 遠端タイル / 自分のプレビュー小窓 / prejoin のデバイスプレビュー の 3 つが最低ライン
    expect(videoTags.length).toBeGreaterThanOrEqual(3)
  })

  it.each(videoTags.map((v) => [v.file.replace(COMPONENTS_DIR, 'components'), v.tag] as const))(
    '%s の <video> に playsInline がある（iOS の全画面乗っ取り・一部 Android の再生拒否を防ぐ）',
    (_file, tag) => {
      expect(tag).toMatch(/\bplaysInline\b/)
    },
  )

  it.each(videoTags.map((v) => [v.file.replace(COMPONENTS_DIR, 'components'), v.tag] as const))(
    '%s の <video> に muted がある（自動再生ポリシー＋二重再生の防止）',
    (_file, tag) => {
      expect(tag).toMatch(/\bmuted\b/)
    },
  )

  it.each(videoTags.map((v) => [v.file.replace(COMPONENTS_DIR, 'components'), v.tag] as const))(
    '%s の <video> に autoPlay がある（attach 後に誰も play() しない事故の防止）',
    (_file, tag) => {
      expect(tag).toMatch(/\bautoPlay\b/)
    },
  )

  it('属性は真偽値ショートハンドで書かれている（playsInline={false} のような無効化を許さない）', () => {
    for (const { file, tag } of videoTags) {
      for (const attr of ['playsInline', 'muted', 'autoPlay']) {
        expect(tag, `${file}: ${attr} を false にしてはいけない`).not.toMatch(
          new RegExp(`\\b${attr}\\s*=\\s*\\{\\s*false\\s*\\}`),
        )
      }
    }
  })
})
