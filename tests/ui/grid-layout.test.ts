// components/room/grid-layout.ts の純粋関数を検証する。DOM 不要・lib/supabase.ts も
// import しない（vitest は node 環境で動く、vitest.config.ts 参照）。
import { describe, expect, it } from 'vitest'
import { computeGridLayout } from '@/components/room/grid-layout'

describe('computeGridLayout', () => {
  it.each([
    [0, { rows: 1, cols: 1 }],
    [1, { rows: 1, cols: 1 }],
    [2, { rows: 1, cols: 2 }],
    [3, { rows: 2, cols: 2 }],
    [4, { rows: 2, cols: 2 }],
    [5, { rows: 2, cols: 3 }],
    [6, { rows: 2, cols: 3 }],
    [7, { rows: 3, cols: 3 }],
    [8, { rows: 3, cols: 3 }],
    [9, { rows: 3, cols: 3 }],
    [10, { rows: 3, cols: 4 }],
  ])('%i participants -> %o', (count, expected) => {
    expect(computeGridLayout(count)).toEqual(expected)
  })

  it('produces enough cells for the requested count at every breakpoint', () => {
    for (let n = 0; n <= 20; n += 1) {
      const { rows, cols } = computeGridLayout(n)
      expect(rows * cols).toBeGreaterThanOrEqual(n)
      expect(rows).toBeGreaterThan(0)
      expect(cols).toBeGreaterThan(0)
    }
  })

  it('degrades gracefully beyond the 10-person MVP cap instead of throwing', () => {
    expect(() => computeGridLayout(16)).not.toThrow()
    const { rows, cols } = computeGridLayout(16)
    expect(rows * cols).toBeGreaterThanOrEqual(16)
  })

  it('clamps negative, fractional and non-finite input to a safe minimum', () => {
    expect(computeGridLayout(-5)).toEqual({ rows: 1, cols: 1 })
    expect(computeGridLayout(2.9)).toEqual(computeGridLayout(2))
    expect(computeGridLayout(Number.NaN)).toEqual({ rows: 1, cols: 1 })
  })
})
