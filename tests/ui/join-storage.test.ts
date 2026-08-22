// lib/store/join-storage.ts の sessionStorage/localStorage 封装を検証する。
// vitest は DOM 無しの node 環境（vitest.config.ts）なので、window.sessionStorage は
// 実在しない——本ファイルはテスト用のインメモリ StorageLike を作り、各関数の
// 第 2 引数（storage 注入）経由で渡すことで DOM に依存せず検証する。
import { describe, expect, it } from 'vitest'
import {
  clearJoinDraft,
  clearJoinResult,
  getDevicePrefs,
  getLastDisplayName,
  joinDraftKey,
  joinResultKey,
  loadJoinDraft,
  loadJoinResult,
  saveJoinDraft,
  saveJoinResult,
  setDevicePrefs,
  setLastDisplayName,
  type StorageLike,
} from '@/lib/store/join-storage'
import type { ProviderConfig } from '@/lib/media/types'

function createMemoryStorage(): StorageLike {
  const map = new Map<string, string>()
  return {
    getItem: (key) => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key, value) => {
      map.set(key, value)
    },
    removeItem: (key) => {
      map.delete(key)
    },
  }
}

const SAMPLE_CONFIG: ProviderConfig = { provider: 'livekit', serverUrl: 'wss://example.test', token: 'tok' }

describe('join draft (sessionStorage)', () => {
  it('round-trips displayName + password', () => {
    const storage = createMemoryStorage()
    saveJoinDraft('abfk92mptq', { displayName: 'Alice', password: 'secret1' }, storage)
    expect(loadJoinDraft('abfk92mptq', storage)).toEqual({ displayName: 'Alice', password: 'secret1' })
  })

  it('keys are namespaced per roomCode so two rooms never collide', () => {
    const storage = createMemoryStorage()
    saveJoinDraft('room-a', { displayName: 'Alice' }, storage)
    saveJoinDraft('room-b', { displayName: 'Bob' }, storage)
    expect(loadJoinDraft('room-a', storage)?.displayName).toBe('Alice')
    expect(loadJoinDraft('room-b', storage)?.displayName).toBe('Bob')
    expect(joinDraftKey('room-a')).not.toBe(joinDraftKey('room-b'))
  })

  it('returns null when nothing was saved', () => {
    const storage = createMemoryStorage()
    expect(loadJoinDraft('missing-room', storage)).toBeNull()
  })

  it('returns null for corrupted JSON instead of throwing', () => {
    const storage = createMemoryStorage()
    storage.setItem(joinDraftKey('bad-room'), '{not json')
    expect(() => loadJoinDraft('bad-room', storage)).not.toThrow()
    expect(loadJoinDraft('bad-room', storage)).toBeNull()
  })

  it('returns null when the stored shape is missing displayName', () => {
    const storage = createMemoryStorage()
    storage.setItem(joinDraftKey('shape-room'), JSON.stringify({ password: 'x' }))
    expect(loadJoinDraft('shape-room', storage)).toBeNull()
  })

  it('clearJoinDraft removes the entry', () => {
    const storage = createMemoryStorage()
    saveJoinDraft('room-c', { displayName: 'Carol' }, storage)
    clearJoinDraft('room-c', storage)
    expect(loadJoinDraft('room-c', storage)).toBeNull()
  })
})

describe('join result (sessionStorage)', () => {
  const sampleResult = {
    config: SAMPLE_CONFIG,
    role: 'guest' as const,
    participantId: 'p-1',
    displayName: 'Alice',
    initialAudio: true,
    initialVideo: false,
  }

  it('round-trips the full join result', () => {
    const storage = createMemoryStorage()
    saveJoinResult('room-x', sampleResult, storage)
    expect(loadJoinResult('room-x', storage)).toEqual(sampleResult)
  })

  it('returns null when participantId or config is missing (defensive shape guard)', () => {
    const storage = createMemoryStorage()
    storage.setItem(joinResultKey('room-y'), JSON.stringify({ displayName: 'Alice' }))
    expect(loadJoinResult('room-y', storage)).toBeNull()
  })

  it('clearJoinResult removes the entry without touching the draft', () => {
    const storage = createMemoryStorage()
    saveJoinDraft('room-z', { displayName: 'Alice' }, storage)
    saveJoinResult('room-z', sampleResult, storage)
    clearJoinResult('room-z', storage)
    expect(loadJoinResult('room-z', storage)).toBeNull()
    expect(loadJoinDraft('room-z', storage)).not.toBeNull()
  })
})

describe('last display name (localStorage)', () => {
  it('defaults to an empty string when unset', () => {
    const storage = createMemoryStorage()
    expect(getLastDisplayName(storage)).toBe('')
  })

  it('round-trips a saved name', () => {
    const storage = createMemoryStorage()
    setLastDisplayName('Dave', storage)
    expect(getLastDisplayName(storage)).toBe('Dave')
  })
})

describe('device prefs (localStorage)', () => {
  it('defaults to an empty object when unset', () => {
    const storage = createMemoryStorage()
    expect(getDevicePrefs(storage)).toEqual({})
  })

  it('round-trips partial and full preference sets', () => {
    const storage = createMemoryStorage()
    setDevicePrefs({ audioDeviceId: 'mic-1' }, storage)
    expect(getDevicePrefs(storage)).toEqual({ audioDeviceId: 'mic-1' })

    setDevicePrefs({ audioDeviceId: 'mic-2', videoDeviceId: 'cam-1', audioOutputDeviceId: 'spk-1' }, storage)
    expect(getDevicePrefs(storage)).toEqual({ audioDeviceId: 'mic-2', videoDeviceId: 'cam-1', audioOutputDeviceId: 'spk-1' })
  })

  it('returns an empty object for corrupted JSON instead of throwing', () => {
    const storage = createMemoryStorage()
    storage.setItem('meet:device-prefs', 'not-json{{')
    expect(() => getDevicePrefs(storage)).not.toThrow()
    expect(getDevicePrefs(storage)).toEqual({})
  })
})

describe('storage resolution without an explicit StorageLike (browser globals absent)', () => {
  it('does not throw when window is unavailable — it just no-ops', () => {
    // vitest environment is 'node': no window/sessionStorage/localStorage globals exist.
    // Every public function must fail soft (return null/{}/'' ) rather than throwing,
    // otherwise importing this module in a non-browser context would break test suites
    // or SSR passes that call these helpers before hydration.
    expect(() => loadJoinDraft('no-window-room')).not.toThrow()
    expect(loadJoinDraft('no-window-room')).toBeNull()
    expect(() => saveJoinDraft('no-window-room', { displayName: 'X' })).not.toThrow()
    expect(getLastDisplayName()).toBe('')
    expect(getDevicePrefs()).toEqual({})
  })
})
