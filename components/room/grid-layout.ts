/**
 * 会議室のビデオグリッド行列計算（規格書 §7：自適応 1/2/4/6/9 宮格、≤10 人）。
 *
 * 純粋関数——本ファイルは DOM も React も触らない。ローカルの小窓（自分のプレビュー）は
 * グリッドに含めない別枠フロート表示なので、ここで数えるのは「グリッドに描画する
 * タイル数」（= 遠端参加者数。0 人なら「他の参加者を待っています」プレースホルダー
 * 1 枚を同じグリッドの中に出す想定なので、呼び出し側は 0 人のときも 1 を渡してよい）。
 *
 * tests/ui/grid-layout.test.ts が境界値を全数検証する。
 */
export interface GridLayout {
  rows: number
  cols: number
}

const FIXED_BREAKPOINTS: ReadonlyArray<{ maxCount: number; layout: GridLayout }> = [
  { maxCount: 1, layout: { rows: 1, cols: 1 } },
  { maxCount: 2, layout: { rows: 1, cols: 2 } },
  { maxCount: 4, layout: { rows: 2, cols: 2 } },
  { maxCount: 6, layout: { rows: 2, cols: 3 } },
  { maxCount: 9, layout: { rows: 3, cols: 3 } },
]

/**
 * @param tileCount グリッドに並べるタイル数（負数・小数は 0 / 整数に丸める）。
 */
export function computeGridLayout(tileCount: number): GridLayout {
  const n = Number.isFinite(tileCount) ? Math.max(0, Math.floor(tileCount)) : 0

  for (const { maxCount, layout } of FIXED_BREAKPOINTS) {
    if (n <= maxCount) return layout
  }

  // 9 人超（本 WP の設計上限は 10 人。将来 50 人まで拡張する余地を残し、
  // 上限を決め打ちせず正方形に近い形へ一般化しておく）。
  const cols = Math.ceil(Math.sqrt(n))
  const rows = Math.ceil(n / cols)
  return { rows, cols }
}
