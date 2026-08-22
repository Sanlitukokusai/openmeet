// 会議内チャット（2026-08-07 FR-4）の純ロジック。
// ⚠️ lib/media/providers/livekit/chat.ts は livekit-client を一切 import しないので
// node 環境の vitest からそのまま叩ける（mapping.test.ts と同じ理由・同じ方針）。
import { describe, expect, it } from 'vitest'
import { normalizeOutgoingChatText, toChatMessage } from '@/lib/media/providers/livekit/chat'
import { MAX_CHAT_TEXT_LENGTH } from '@/lib/media/types'

const SENDER = { identity: 'guest_abc123', name: '田中' }
const FALLBACK = { id: 'fallback-id', timestamp: 1_700_000_000_000 }

describe('normalizeOutgoingChatText（送信前の検証）', () => {
  it('前後の空白を落とす', () => {
    expect(normalizeOutgoingChatText('  こんにちは  ')).toEqual({ ok: true, text: 'こんにちは' })
  })

  it.each(['', '   ', '\n\t ', '　　'])('空白のみ（%j）は empty で拒否する', (input) => {
    expect(normalizeOutgoingChatText(input)).toEqual({ ok: false, reason: 'empty' })
  })

  it('ちょうど上限（500 字）は通す', () => {
    const text = 'あ'.repeat(MAX_CHAT_TEXT_LENGTH)
    expect(normalizeOutgoingChatText(text)).toEqual({ ok: true, text })
  })

  it('上限 +1 字は too_long で拒否する（勝手に切り詰めない）', () => {
    expect(normalizeOutgoingChatText('あ'.repeat(MAX_CHAT_TEXT_LENGTH + 1))).toEqual({
      ok: false,
      reason: 'too_long',
    })
  })

  it('trim 後に上限以内なら通す（末尾の空白で弾かれない）', () => {
    const result = normalizeOutgoingChatText(`${'あ'.repeat(MAX_CHAT_TEXT_LENGTH)}   `)
    expect(result).toEqual({ ok: true, text: 'あ'.repeat(MAX_CHAT_TEXT_LENGTH) })
  })
})

describe('toChatMessage（受信メッセージの容錯）', () => {
  it('正常な本体をそのまま写す', () => {
    expect(toChatMessage({ id: 'm1', message: 'やあ', timestamp: 1234 }, SENDER, FALLBACK)).toEqual({
      id: 'm1',
      senderIdentity: 'guest_abc123',
      senderName: '田中',
      text: 'やあ',
      timestamp: 1234,
    })
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['文字列（＝壊れた JSON をそのまま渡した相当）', '{"message":'],
    ['数値', 42],
    ['配列でも message が無い', ['message']],
    ['message が文字列でない', { id: 'm1', message: { nested: true } }],
    ['message が欠落', { id: 'm1', timestamp: 1 }],
    ['本文が空', { id: 'm1', message: '' }],
    ['本文が空白のみ', { id: 'm1', message: '   \n' }],
  ])('壊れた本体（%s）は null を返して黙って捨てる', (_label, raw) => {
    expect(toChatMessage(raw, SENDER, FALLBACK)).toBeNull()
  })

  it('送信者 identity が空なら捨てる（帰属不能な発言は表示しない）', () => {
    expect(toChatMessage({ id: 'm1', message: 'やあ' }, { identity: '  ' }, FALLBACK)).toBeNull()
  })

  it('超長メッセージは上限で切り詰める（丸ごと捨てない）', () => {
    const result = toChatMessage({ id: 'm1', message: 'あ'.repeat(5000) }, SENDER, FALLBACK)
    expect(result?.text).toHaveLength(MAX_CHAT_TEXT_LENGTH)
  })

  it('id / timestamp が欠けていれば呼び出し側の兜底値を使う', () => {
    const result = toChatMessage({ message: 'やあ' }, SENDER, FALLBACK)
    expect(result).toMatchObject({ id: FALLBACK.id, timestamp: FALLBACK.timestamp })
  })

  it.each([
    ['0', 0],
    ['負数', -1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['文字列', '1700000000000'],
  ])('不正な timestamp（%s）は兜底値に置き換える', (_label, timestamp) => {
    const result = toChatMessage({ id: 'm1', message: 'やあ', timestamp }, SENDER, FALLBACK)
    expect(result?.timestamp).toBe(FALLBACK.timestamp)
  })

  it('名前が無い / 空なら identity を表示名に使う', () => {
    expect(toChatMessage({ message: 'やあ' }, { identity: 'guest_x' }, FALLBACK)?.senderName).toBe('guest_x')
    expect(toChatMessage({ message: 'やあ' }, { identity: 'guest_x', name: '  ' }, FALLBACK)?.senderName).toBe(
      'guest_x',
    )
  })

  it('本文の前後空白は落とすが、内部の改行は保つ（複数行の発言をそのまま見せる）', () => {
    expect(toChatMessage({ message: '  1 行目\n2 行目  ' }, SENDER, FALLBACK)?.text).toBe('1 行目\n2 行目')
  })
})
