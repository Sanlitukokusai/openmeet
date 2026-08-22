// 会議室一覧の「状態」列（2026-08-07 第 2 波）。
//
// 背景：旧実装は DB の status をそのまま訳しており、誰も居ない部屋も「開催中 / 进行中」と
// 表示していた。利用者はそれを「会議が進行中」と読み、混乱した。ここでは
//   ① active が在線人数で 3 分岐すること
//   ② 「開催中 / 进行中」という文言が**どの分岐からも出ない**こと
// を固定する（②は文言だけ差し替えて分岐を戻す、という回帰も防ぐ）。
import { describe, expect, it } from 'vitest'
import type { RoomState } from '@/lib/server/rooms-logic'
import { describeRoomStatus, uiText } from '@/lib/ui-text'

const LOCALES = ['ja', 'zh'] as const

describe('describeRoomStatus — active の 3 分岐（在線人数）', () => {
  it('人が居れば「会議中 n 人」＋ success', () => {
    expect(describeRoomStatus('active', 1, 'ja')).toEqual({ label: '会議中 1 人', tone: 'success' })
    expect(describeRoomStatus('active', 6, 'zh')).toEqual({ label: '会议中 6 人', tone: 'success' })
  })

  it('0 人は「待機中 / 待机中」＋ default（success で目立たせない）', () => {
    expect(describeRoomStatus('active', 0, 'ja')).toEqual({ label: uiText.ja.dashboard.statusWaiting, tone: 'default' })
    expect(describeRoomStatus('active', 0, 'zh')).toEqual({ label: uiText.zh.dashboard.statusWaiting, tone: 'default' })
  })

  it('人数不明（null）は「利用可能 / 可用」——0 人だと嘘をつかない', () => {
    expect(describeRoomStatus('active', null, 'ja')).toEqual({
      label: uiText.ja.dashboard.statusAvailable,
      tone: 'default',
    })
    expect(describeRoomStatus('active', null, 'zh')).toEqual({
      label: uiText.zh.dashboard.statusAvailable,
      tone: 'default',
    })
  })

  it('null と 0 は別の文言になる（区別が潰れていない）', () => {
    for (const locale of LOCALES) {
      expect(describeRoomStatus('active', null, locale).label).not.toBe(describeRoomStatus('active', 0, locale).label)
    }
  })

  it('{count} が実数で埋まる（テンプレートのまま出ない）', () => {
    for (const locale of LOCALES) {
      const label = describeRoomStatus('active', 12, locale).label
      expect(label).not.toContain('{count}')
      expect(label).toContain('12')
    }
  })
})

describe('describeRoomStatus — active 以外は在線人数を見ない', () => {
  const terminalStates: RoomState[] = ['ended', 'expired', 'disabled']

  it.each(terminalStates)('%s は人数 0 / n / null のどれでも同じ表示', (status) => {
    for (const locale of LOCALES) {
      const base = describeRoomStatus(status, null, locale)
      expect(describeRoomStatus(status, 0, locale)).toEqual(base)
      expect(describeRoomStatus(status, 5, locale)).toEqual(base)
    }
  })

  it('色分けは ended=default / expired=warning / disabled=danger', () => {
    expect(describeRoomStatus('ended', null, 'ja').tone).toBe('default')
    expect(describeRoomStatus('expired', null, 'ja').tone).toBe('warning')
    expect(describeRoomStatus('disabled', null, 'ja').tone).toBe('danger')
  })

  it('文言は既存の辞書キーをそのまま使う（ja/zh とも）', () => {
    for (const locale of LOCALES) {
      const t = uiText[locale].dashboard
      expect(describeRoomStatus('ended', null, locale).label).toBe(t.statusEnded)
      expect(describeRoomStatus('expired', null, locale).label).toBe(t.statusExpired)
      expect(describeRoomStatus('disabled', null, locale).label).toBe(t.statusDisabled)
    }
  })
})

describe('「開催中 / 进行中」は全分岐から消えている（誤解の再発防止）', () => {
  const allStates: RoomState[] = ['active', 'ended', 'expired', 'disabled']
  const counts = [null, 0, 1, 42] as const
  const bannedPhrases = ['開催中', '进行中', '進行中']

  it.each(allStates)('%s のどの人数でも禁止語を含まない', (status) => {
    for (const locale of LOCALES) {
      for (const count of counts) {
        const { label } = describeRoomStatus(status, count, locale)
        for (const banned of bannedPhrases) {
          expect(label, `${locale}/${status}/${count}`).not.toContain(banned)
        }
      }
    }
  })

  it('辞書側にも statusActive というキーはもう存在しない', () => {
    for (const locale of LOCALES) {
      expect(uiText[locale].dashboard).not.toHaveProperty('statusActive')
    }
  })
})
