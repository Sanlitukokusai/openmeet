// components/room/mobile-grid.ts の純粋関数を検証する（grid-layout.test.ts と同じ方針）。
// DOM 不要・lib/supabase.server.ts も import しない（vitest は node 環境、vitest.config.ts 参照）。
import { describe, expect, it } from 'vitest'
import {
  MOBILE_PAGE_SIZE,
  clampMobilePageIndex,
  computeMobileGridLayout,
  computeMobilePageCount,
  sliceMobilePage,
} from '@/components/room/mobile-grid'

describe('computeMobileGridLayout', () => {
  it.each([
    [0, { rows: 1, cols: 1 }],
    [1, { rows: 1, cols: 1 }],
    [2, { rows: 2, cols: 1 }],
    [3, { rows: 2, cols: 2 }],
    [4, { rows: 2, cols: 2 }],
  ])('%i 人（そのページ内）-> %o', (count, expected) => {
    expect(computeMobileGridLayout(count)).toEqual(expected)
  })

  it('2 人はデスクトップと違って縦積み（cols=1, rows=2）になる', () => {
    // デスクトップの computeGridLayout(2) は { rows: 1, cols: 2 }（横並び）——
    // モバイルは縦長画面向けに意図的に逆にしている。
    expect(computeMobileGridLayout(2)).toEqual({ rows: 2, cols: 1 })
  })

  it('5 人以上を渡しても 2×2 に切り詰める（呼び出し側がページングで捌く前提）', () => {
    expect(computeMobileGridLayout(5)).toEqual({ rows: 2, cols: 2 })
    expect(computeMobileGridLayout(9)).toEqual({ rows: 2, cols: 2 })
  })

  it('負数・小数・非有限値を安全な最小値へ丸める', () => {
    expect(computeMobileGridLayout(-5)).toEqual({ rows: 1, cols: 1 })
    expect(computeMobileGridLayout(1.9)).toEqual(computeMobileGridLayout(1))
    expect(computeMobileGridLayout(Number.NaN)).toEqual({ rows: 1, cols: 1 })
  })
})

describe('MOBILE_PAGE_SIZE', () => {
  it('2×2 グリッドと一致する 4', () => {
    expect(MOBILE_PAGE_SIZE).toBe(4)
  })
})

describe('computeMobilePageCount', () => {
  it.each([
    [0, 1],
    [1, 1],
    [4, 1],
    [5, 2],
    [8, 2],
    [9, 3],
    [16, 4],
  ])('%i 人 -> %i ページ', (count, expected) => {
    expect(computeMobilePageCount(count)).toBe(expected)
  })

  it('0 人でも最低 1 ページを返す（待機プレースホルダー用）', () => {
    expect(computeMobilePageCount(0)).toBeGreaterThanOrEqual(1)
  })

  it('負数・非有限値を安全に丸める', () => {
    expect(computeMobilePageCount(-3)).toBe(1)
    expect(computeMobilePageCount(Number.NaN)).toBe(1)
  })
})

describe('clampMobilePageIndex', () => {
  it('範囲内はそのまま', () => {
    expect(clampMobilePageIndex(1, 3)).toBe(1)
  })

  it('負数は 0 に丸める', () => {
    expect(clampMobilePageIndex(-1, 3)).toBe(0)
  })

  it('pageCount 以上は末尾ページに丸める', () => {
    expect(clampMobilePageIndex(5, 3)).toBe(2)
  })

  it('参加者退出でページ数が減った場合の保護（前のページ番号が古いまま渡ってきても安全）', () => {
    // 例：9 人（3 ページ）でページ 2（0-indexed）を見ていた最中に 4 人まで退出（1 ページに減少）
    expect(clampMobilePageIndex(2, 1)).toBe(0)
  })

  it('非有限値は 0 として扱う', () => {
    expect(clampMobilePageIndex(Number.NaN, 3)).toBe(0)
  })

  it('pageCount が 0 でも例外を投げず 0 を返す（呼び出し側の防御）', () => {
    expect(clampMobilePageIndex(0, 0)).toBe(0)
  })
})

describe('sliceMobilePage', () => {
  const items = ['a', 'b', 'c', 'd', 'e', 'f']

  it('ページ 0 は先頭 4 件', () => {
    expect(sliceMobilePage(items, 0)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('ページ 1 は残り（4 件に満たなくてもそのまま返す）', () => {
    expect(sliceMobilePage(items, 1)).toEqual(['e', 'f'])
  })

  it('範囲外のページは空配列', () => {
    expect(sliceMobilePage(items, 5)).toEqual([])
  })

  it('負のページは 0 扱い（防御的）', () => {
    expect(sliceMobilePage(items, -1)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('ちょうど 4 の倍数の人数でも空ページを作らない（呼び出し側は pageCount で境界を決める）', () => {
    const exact = ['a', 'b', 'c', 'd']
    expect(sliceMobilePage(exact, 0)).toEqual(exact)
    expect(sliceMobilePage(exact, 1)).toEqual([])
  })
})
