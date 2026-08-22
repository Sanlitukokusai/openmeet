import { describe, expect, it } from 'vitest'
import { DEFAULT_AFTER_LOGIN, safeNextPath } from '@/lib/safe-next'

describe('safeNextPath', () => {
  it('缺省/空值回落到默认页', () => {
    expect(safeNextPath(null)).toBe(DEFAULT_AFTER_LOGIN)
    expect(safeNextPath(undefined)).toBe(DEFAULT_AFTER_LOGIN)
    expect(safeNextPath('')).toBe(DEFAULT_AFTER_LOGIN)
  })

  it('放行站内绝对路径（含 query 与 hash）', () => {
    expect(safeNextPath('/dashboard')).toBe('/dashboard')
    expect(safeNextPath('/rooms/new')).toBe('/rooms/new')
    expect(safeNextPath('/j/abfk92mptq')).toBe('/j/abfk92mptq')
    expect(safeNextPath('/dashboard?tab=all#top')).toBe('/dashboard?tab=all#top')
  })

  it('挡下协议相对 URL（开放重定向的主要形态）', () => {
    expect(safeNextPath('//evil.example')).toBe(DEFAULT_AFTER_LOGIN)
    expect(safeNextPath('//evil.example/path')).toBe(DEFAULT_AFTER_LOGIN)
  })

  it('挡下反斜杠变体', () => {
    expect(safeNextPath('/\\evil.example')).toBe(DEFAULT_AFTER_LOGIN)
  })

  it('挡下带 scheme 的绝对 URL 与伪协议', () => {
    expect(safeNextPath('https://evil.example')).toBe(DEFAULT_AFTER_LOGIN)
    expect(safeNextPath('http://evil.example')).toBe(DEFAULT_AFTER_LOGIN)
    expect(safeNextPath('javascript:alert(1)')).toBe(DEFAULT_AFTER_LOGIN)
    expect(safeNextPath('data:text/html,<script>')).toBe(DEFAULT_AFTER_LOGIN)
  })

  it('挡下不以 / 开头的相对路径（避免歧义解析）', () => {
    expect(safeNextPath('dashboard')).toBe(DEFAULT_AFTER_LOGIN)
    expect(safeNextPath('../admin')).toBe(DEFAULT_AFTER_LOGIN)
  })

  it('挡下含控制字符的绕过尝试', () => {
    expect(safeNextPath('/\tjavascript:alert(1)')).toBe(DEFAULT_AFTER_LOGIN)
    expect(safeNextPath('/\nhttps://evil.example')).toBe(DEFAULT_AFTER_LOGIN)
    expect(safeNextPath('/ /evil.example')).toBe(DEFAULT_AFTER_LOGIN)
  })

  it('支持自定义 fallback', () => {
    expect(safeNextPath(null, '/')).toBe('/')
    expect(safeNextPath('//evil.example', '/')).toBe('/')
  })
})
