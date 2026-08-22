// components/display-name.ts の initialsOf()。
// 実機ブラウザ確認で見つかった不具合の回帰テスト：HeroUI Avatar は既定で name を
// そのまま描画する（先頭文字抽出はしない）ため、長い名前・スペース無しの日本語/
// 中国語名を渡すと丸いアバター内で文字が縦に折り返されて潰れる。
import { describe, expect, it } from 'vitest'
import { initialsOf } from '@/components/display-name'

describe('initialsOf', () => {
  it('takes the first letter of each of the first two words for space-separated names', () => {
    expect(initialsOf('Taro Yamada')).toBe('TY')
    expect(initialsOf('主持人 Host')).toBe('主H')
  })

  it('reduces a single-word name (CJK or Latin) to one character', () => {
    expect(initialsOf('田中花子')).toBe('田')
    expect(initialsOf('Alice')).toBe('A')
  })

  it('trims surrounding whitespace before computing initials', () => {
    expect(initialsOf('  Bob  ')).toBe('B')
  })

  it('returns an empty string for empty/whitespace-only input instead of throwing', () => {
    expect(initialsOf('')).toBe('')
    expect(initialsOf('   ')).toBe('')
  })

  it('never returns a string longer than 2 characters', () => {
    for (const name of ['A Very Long Display Name Indeed', '一二三四五六七八', 'X']) {
      expect([...initialsOf(name)].length).toBeLessThanOrEqual(2)
    }
  })
})
