/**
 * モバイル（<md、2026-08-14 実機フィードバック）専用のビデオグリッド行列とページング。
 *
 * デスクトップの grid-layout.ts（computeGridLayout）とは意図的に別ファイル——同じ人数でも
 * 形が違う（例：2 人はデスクトップ横並び・モバイル縦積み）のと、5 人以上の扱いが根本的に
 * 異なる（デスクトップは 9 人まで拡張しながら詰める・モバイルは常に 2×2 に固定してページング
 * で捌く——縦長画面に詰め込みすぎるとタイルが小さくなりすぎるため、Zoom モバイル版と同じ判断）。
 *
 * 純粋関数のみ。DOM・React 非依存——tests/ui/mobile-grid.test.ts が全分岐を固定する。
 */

export interface MobileGridLayout {
  rows: number
  cols: number
}

/** 1 ページに入れる最大タイル数（2×2）。 */
export const MOBILE_PAGE_SIZE = 4

/**
 * そのページに実際に並べるタイル数（0〜4 を想定）→ 行列。
 * 呼び出し側は sliceMobilePage() で切り出した「そのページの人数」を渡すこと
 * （全体人数を渡すと 5 人以上で常に 2×2 のはずが崩れる）。
 */
export function computeMobileGridLayout(tileCount: number): MobileGridLayout {
  const n = Number.isFinite(tileCount) ? Math.max(0, Math.floor(tileCount)) : 0
  if (n <= 1) return { rows: 1, cols: 1 } // 0 人（待機プレースホルダー）／1 人（満屏）
  if (n === 2) return { rows: 2, cols: 1 } // 縦積み——デスクトップの横並びとは意図的に異なる
  return { rows: 2, cols: 2 } // 3〜4 人。ページングにより 5 人以上でも常にこの形に切り詰められる
}

/** 総タイル数からページ数を出す（0 人でも最低 1 ページ＝空プレースホルダー用に確保する）。 */
export function computeMobilePageCount(totalCount: number): number {
  const n = Number.isFinite(totalCount) ? Math.max(0, Math.floor(totalCount)) : 0
  return Math.max(1, Math.ceil(n / MOBILE_PAGE_SIZE))
}

/**
 * ページ番号を有効範囲 [0, pageCount-1] に丸める（参加者退出でページ数が減った場合の保護。
 * 「発言者のいるページへ自動ジャンプしない」という要件はこの関数の外側の話——ここは
 * 純粋に「今の pageCount に対して安全な値か」だけを見る）。
 */
export function clampMobilePageIndex(page: number, pageCount: number): number {
  const safePage = Number.isFinite(page) ? Math.floor(page) : 0
  const maxIndex = Math.max(0, pageCount - 1)
  return Math.min(Math.max(0, safePage), maxIndex)
}

/** 指定ページに表示する要素を切り出す（純粋・副作用なし）。 */
export function sliceMobilePage<T>(items: readonly T[], page: number): T[] {
  const start = Math.max(0, Math.floor(page)) * MOBILE_PAGE_SIZE
  return items.slice(start, start + MOBILE_PAGE_SIZE)
}
