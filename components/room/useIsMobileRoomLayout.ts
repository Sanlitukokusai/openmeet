'use client'

import { useEffect, useState } from 'react'
import { createLayoutFlipDebouncer } from './layout-flip'

/**
 * room ページのモバイル専用レイアウト（2026-08-14 実機フィードバック）を使うべきか。
 *
 * 幅は Tailwind の `md` ブレークポイント（767px 以下）に合わせる。加えて横向きの
 * 低height スマホ（高さ 450px 未満）は対象外とし、デスクトップ式グリッドへ単純に
 * フォールバックさせる——幅だけで判定すると、横向きでも縦積み 2 段のような縦長向け
 * レイアウトが出てしまい余白だらけになる（タスク要件「不必精雕」：厳密なブレークポイント
 * 設計は求められていないので、複合メディアクエリ 1 本で十分）。
 *
 * VideoGrid のグリッド／ページング分岐など、DOM 構造そのものを出し分ける必要がある
 * 箇所だけがこのフックを使う。ControlBar のボタンサイズや LocalPreviewTile の位置調整は
 * 副作用の重複（同じ参加者の映像を 2 つのタイルに attach する等）が起きないので、
 * このフックを使わず Tailwind の `md:` レスポンシブクラスだけで済ませている。
 *
 * SSR / 初回描画は常に false（＝デスクトップ扱い）固定——useReducedMotion() と同じ
 * hydration-safe パターン（サーバーは実際のビューポートを知らない）。
 *
 * ★ 2026-08-14 第 2 波：**切替の去抖**（実機「揺らしたら映像が真っ黒」の対策その 2）。
 *   端末回転の最中、このクエリは短時間に何度も反転しうる。その都度レイアウトを
 *   確定させると映像タイルの再レンダーが連打される。落ち着いた値だけを採用する
 *   ——判定ロジックは ./layout-flip.ts（純関数・単体テストあり）。
 *   初期値だけは去抖せず即決する（マウント直後に誤ったレイアウトを見せないため）。
 */
const MOBILE_LAYOUT_QUERY = '(max-width: 767px) and (min-height: 450px)'

export function useIsMobileRoomLayout(): boolean {
  const [isMobile, setIsMobile] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const query = window.matchMedia(MOBILE_LAYOUT_QUERY)
    const initial = query.matches
    setIsMobile(initial)

    const debouncer = createLayoutFlipDebouncer({ initial, commit: setIsMobile })
    const handler = (event: MediaQueryListEvent) => debouncer.request(event.matches)
    query.addEventListener('change', handler)
    return () => {
      query.removeEventListener('change', handler)
      debouncer.cancel()
    }
  }, [])

  return isMobile
}
