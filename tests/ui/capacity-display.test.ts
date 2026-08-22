// ダッシュボードの容量表示（2026-08-07）。GET /api/capacity のスナップショット →
// Chip の文言 / 色 / 作成ボタンの無効化理由という写像だけを検証する（IO は含まない）。
import { describe, expect, it } from 'vitest'
import { describeCapacity, uiText } from '@/lib/ui-text'

describe('describeCapacity', () => {
  it('通常時：人数を出し、作成は許可（無効化理由なし）', () => {
    const display = describeCapacity({ current: 3, max: 20, canCreate: true }, 'ja')
    expect(display).toEqual({ label: 'オンライン 3 / 20', tone: 'default', createDisabledReason: null })
  })

  it('満杯：警告色 + 作成ボタンの無効化理由を返す', () => {
    const display = describeCapacity({ current: 20, max: 20, canCreate: false }, 'ja')
    expect(display.label).toBe('オンライン 20 / 20')
    expect(display.tone).toBe('warning')
    expect(display.createDisabledReason).toBe(uiText.ja.capacity.createDisabledTooltip)
  })

  it('人数不明（current=null）：0 ではなく「—」を出し、作成はブロックしない', () => {
    const display = describeCapacity({ current: null, max: 20, canCreate: true }, 'ja')
    expect(display.label).toBe('オンライン — / 20')
    expect(display.createDisabledReason).toBeNull()
  })

  it('0 人と人数不明を混同しない', () => {
    expect(describeCapacity({ current: 0, max: 20, canCreate: true }, 'ja').label).toBe('オンライン 0 / 20')
  })

  it('中国語でも同じ構造で出る', () => {
    expect(describeCapacity({ current: 3, max: 20, canCreate: true }, 'zh').label).toBe('在线 3 / 20')
    expect(describeCapacity({ current: null, max: 20, canCreate: true }, 'zh').label).toBe('在线 — / 20')
    expect(describeCapacity({ current: 20, max: 20, canCreate: false }, 'zh').createDisabledReason).toBe(
      uiText.zh.capacity.createDisabledTooltip,
    )
  })
})
