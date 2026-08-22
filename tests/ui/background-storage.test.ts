// lib/background-storage.ts の回帰テスト（2026-08-13 FR-7 UI 層）。
// vitest は DOM 無しの node 環境（vitest.config.ts）——localStorage 系は
// join-storage.test.ts と同じ作法で自作の StorageLike を注入して検証し、
// IndexedDB 系は MemoryBackgroundImageStore（同じ契約の純メモリ実装）で検証する。
// 実 IndexedDB 経路そのものはブラウザ実測でのみ確認できる。
import { describe, expect, it } from 'vitest'
import {
  BLUR_RADIUS_BY_STRENGTH,
  DEFAULT_BLUR_STRENGTH,
  MAX_STORED_BACKGROUND_IMAGES,
  MemoryBackgroundImageStore,
  NONE_SELECTION,
  backgroundSelectionToEffect,
  blurStrengthOf,
  clearBackgroundSelection,
  isSameBackgroundSelection,
  loadBackgroundSelection,
  nextSelectionAfterImageDeletion,
  saveBackgroundSelection,
  type BackgroundSelection,
  type StorageLike,
} from '@/lib/background-storage'
import { DEFAULT_BACKGROUND_BLUR_RADIUS } from '@/lib/media/types'
import {
  MAX_BACKGROUND_BLUR_RADIUS,
  MIN_BACKGROUND_BLUR_RADIUS,
} from '@/lib/media/providers/livekit/background'

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

function makeBlob(content = 'x'): Blob {
  return new Blob([content], { type: 'image/webp' })
}

// ============================================================
// localStorage 往返（当前选择）
// ============================================================
describe('loadBackgroundSelection / saveBackgroundSelection', () => {
  it('round-trips "none"', () => {
    const storage = createMemoryStorage()
    saveBackgroundSelection(NONE_SELECTION, storage)
    expect(loadBackgroundSelection(storage)).toEqual(NONE_SELECTION)
  })

  it('round-trips "blur" (legacy, no strength)', () => {
    const storage = createMemoryStorage()
    saveBackgroundSelection({ kind: 'blur' }, storage)
    expect(loadBackgroundSelection(storage)).toEqual({ kind: 'blur' })
  })

  it.each(['light', 'strong'] as const)('round-trips "blur" with strength=%s', (strength) => {
    const storage = createMemoryStorage()
    saveBackgroundSelection({ kind: 'blur', strength }, storage)
    expect(loadBackgroundSelection(storage)).toEqual({ kind: 'blur', strength })
  })

  it('rejects an invalid strength value and falls back to "none"', () => {
    const storage = createMemoryStorage()
    storage.setItem('meet.backgroundEffect', JSON.stringify({ kind: 'blur', strength: 'ultra' }))
    expect(loadBackgroundSelection(storage)).toEqual(NONE_SELECTION)
  })

  it('round-trips "builtin" including its imageUrl', () => {
    const storage = createMemoryStorage()
    const selection: BackgroundSelection = { kind: 'builtin', imageUrl: '/backgrounds/bg-office.webp' }
    saveBackgroundSelection(selection, storage)
    expect(loadBackgroundSelection(storage)).toEqual(selection)
  })

  it('round-trips "custom" as an IndexedDB key, not a blob: URL', () => {
    const storage = createMemoryStorage()
    const selection: BackgroundSelection = { kind: 'custom', imageKey: 'abc123' }
    saveBackgroundSelection(selection, storage)
    const raw = storage.getItem('meet.backgroundEffect')
    expect(raw).not.toContain('blob:')
    expect(loadBackgroundSelection(storage)).toEqual(selection)
  })

  it('returns "none" when nothing was saved', () => {
    expect(loadBackgroundSelection(createMemoryStorage())).toEqual(NONE_SELECTION)
  })

  it('returns "none" for corrupted JSON instead of throwing', () => {
    const storage = createMemoryStorage()
    storage.setItem('meet.backgroundEffect', '{not json')
    expect(() => loadBackgroundSelection(storage)).not.toThrow()
    expect(loadBackgroundSelection(storage)).toEqual(NONE_SELECTION)
  })

  it('returns "none" when kind is unknown', () => {
    const storage = createMemoryStorage()
    storage.setItem('meet.backgroundEffect', JSON.stringify({ kind: 'sepia' }))
    expect(loadBackgroundSelection(storage)).toEqual(NONE_SELECTION)
  })

  it('returns "none" when "builtin" is missing imageUrl', () => {
    const storage = createMemoryStorage()
    storage.setItem('meet.backgroundEffect', JSON.stringify({ kind: 'builtin' }))
    expect(loadBackgroundSelection(storage)).toEqual(NONE_SELECTION)
  })

  it('returns "none" when "custom" is missing imageKey', () => {
    const storage = createMemoryStorage()
    storage.setItem('meet.backgroundEffect', JSON.stringify({ kind: 'custom', imageKey: '' }))
    expect(loadBackgroundSelection(storage)).toEqual(NONE_SELECTION)
  })

  it('clearBackgroundSelection removes the entry', () => {
    const storage = createMemoryStorage()
    saveBackgroundSelection({ kind: 'blur' }, storage)
    clearBackgroundSelection(storage)
    expect(loadBackgroundSelection(storage)).toEqual(NONE_SELECTION)
  })
})

// ============================================================
// 等価判定
// ============================================================
describe('isSameBackgroundSelection', () => {
  it('none === none, blur === blur', () => {
    expect(isSameBackgroundSelection(NONE_SELECTION, { kind: 'none' })).toBe(true)
    expect(isSameBackgroundSelection({ kind: 'blur' }, { kind: 'blur' })).toBe(true)
  })

  // 2026-08-14：旧保存値 `{ kind: 'blur' }`（strength 未指定）は常に 'strong' として扱う
  // ——「ぼかしが弱すぎる」への移行は強い方に倒すのが期待に合う（DEFAULT_BLUR_STRENGTH）。
  describe('blur strength（2026-08-14）', () => {
    it('未指定（旧保存値）は strength="strong" と同一視される', () => {
      expect(isSameBackgroundSelection({ kind: 'blur' }, { kind: 'blur', strength: 'strong' })).toBe(true)
    })

    it('未指定（旧保存値）は strength="light" とは別物', () => {
      expect(isSameBackgroundSelection({ kind: 'blur' }, { kind: 'blur', strength: 'light' })).toBe(false)
    })

    it('同じ strength 同士は同一', () => {
      expect(isSameBackgroundSelection({ kind: 'blur', strength: 'light' }, { kind: 'blur', strength: 'light' })).toBe(
        true,
      )
      expect(
        isSameBackgroundSelection({ kind: 'blur', strength: 'strong' }, { kind: 'blur', strength: 'strong' }),
      ).toBe(true)
    })

    it('light と strong は別物', () => {
      expect(
        isSameBackgroundSelection({ kind: 'blur', strength: 'light' }, { kind: 'blur', strength: 'strong' }),
      ).toBe(false)
    })
  })

  it('builtin compares by imageUrl', () => {
    const a: BackgroundSelection = { kind: 'builtin', imageUrl: '/backgrounds/bg-office.webp' }
    const b: BackgroundSelection = { kind: 'builtin', imageUrl: '/backgrounds/bg-office.webp' }
    const c: BackgroundSelection = { kind: 'builtin', imageUrl: '/backgrounds/bg-nature.webp' }
    expect(isSameBackgroundSelection(a, b)).toBe(true)
    expect(isSameBackgroundSelection(a, c)).toBe(false)
  })

  it('custom compares by imageKey', () => {
    expect(isSameBackgroundSelection({ kind: 'custom', imageKey: 'k1' }, { kind: 'custom', imageKey: 'k1' })).toBe(
      true,
    )
    expect(isSameBackgroundSelection({ kind: 'custom', imageKey: 'k1' }, { kind: 'custom', imageKey: 'k2' })).toBe(
      false,
    )
  })

  it('different kinds are never equal', () => {
    expect(isSameBackgroundSelection(NONE_SELECTION, { kind: 'blur' })).toBe(false)
    expect(
      isSameBackgroundSelection({ kind: 'builtin', imageUrl: '/x.webp' }, { kind: 'custom', imageKey: '/x.webp' }),
    ).toBe(false)
  })
})

// ============================================================
// BackgroundSelection → BackgroundEffect（选择器状态映射）
// ============================================================
describe('backgroundSelectionToEffect', () => {
  it('maps none/builtin without needing a resolved URL', () => {
    expect(backgroundSelectionToEffect(NONE_SELECTION)).toEqual({ type: 'none' })
    expect(backgroundSelectionToEffect({ kind: 'builtin', imageUrl: '/backgrounds/bg-office.webp' })).toEqual({
      type: 'image',
      imageUrl: '/backgrounds/bg-office.webp',
    })
  })

  // 2026-08-14：strength → blurRadius の換算（実機フィードバック「弱すぎる」への対応）。
  describe('blur strength → blurRadius（2026-08-14）', () => {
    it('strength 未指定（旧保存値）は strong 相当の blurRadius=25 になる', () => {
      expect(backgroundSelectionToEffect({ kind: 'blur' })).toEqual({ type: 'blur', blurRadius: 25 })
    })

    it('strength="light" は blurRadius=10（従来の既定値と同じ）', () => {
      expect(backgroundSelectionToEffect({ kind: 'blur', strength: 'light' })).toEqual({
        type: 'blur',
        blurRadius: 10,
      })
    })

    it('strength="strong" は blurRadius=25', () => {
      expect(backgroundSelectionToEffect({ kind: 'blur', strength: 'strong' })).toEqual({
        type: 'blur',
        blurRadius: 25,
      })
    })

    it('BLUR_RADIUS_BY_STRENGTH の値そのものを固定する（回帰防止）', () => {
      expect(BLUR_RADIUS_BY_STRENGTH.light).toBe(10)
      expect(BLUR_RADIUS_BY_STRENGTH.strong).toBe(25)
      expect(BLUR_RADIUS_BY_STRENGTH.light).toBe(DEFAULT_BACKGROUND_BLUR_RADIUS)
    })

    it('両方とも provider 契約の区間 [1,30] に収まっている', () => {
      expect(BLUR_RADIUS_BY_STRENGTH.light).toBeGreaterThanOrEqual(MIN_BACKGROUND_BLUR_RADIUS)
      expect(BLUR_RADIUS_BY_STRENGTH.light).toBeLessThanOrEqual(MAX_BACKGROUND_BLUR_RADIUS)
      expect(BLUR_RADIUS_BY_STRENGTH.strong).toBeGreaterThanOrEqual(MIN_BACKGROUND_BLUR_RADIUS)
      expect(BLUR_RADIUS_BY_STRENGTH.strong).toBeLessThanOrEqual(MAX_BACKGROUND_BLUR_RADIUS)
    })

    it('DEFAULT_BLUR_STRENGTH は "strong"（弱すぎる不満への移行なので強い方に倒す）', () => {
      expect(DEFAULT_BLUR_STRENGTH).toBe('strong')
    })

    it('blurStrengthOf: 未指定は DEFAULT_BLUR_STRENGTH、指定があればそれを優先する', () => {
      expect(blurStrengthOf({ kind: 'blur' })).toBe('strong')
      expect(blurStrengthOf({ kind: 'blur', strength: 'light' })).toBe('light')
      expect(blurStrengthOf({ kind: 'blur', strength: 'strong' })).toBe('strong')
    })
  })

  it('maps custom to an image effect once a resolved URL is supplied', () => {
    const result = backgroundSelectionToEffect({ kind: 'custom', imageKey: 'k1' }, 'blob:http://x/1')
    expect(result).toEqual({ type: 'image', imageUrl: 'blob:http://x/1' })
  })

  it('returns null for custom without a resolved URL (caller must fetch the blob first)', () => {
    expect(backgroundSelectionToEffect({ kind: 'custom', imageKey: 'k1' })).toBeNull()
  })
})

// ============================================================
// 删除选中图的联动
// ============================================================
describe('nextSelectionAfterImageDeletion', () => {
  it('falls back to none when the deleted key is the one currently selected', () => {
    const current: BackgroundSelection = { kind: 'custom', imageKey: 'k1' }
    expect(nextSelectionAfterImageDeletion(current, 'k1')).toEqual(NONE_SELECTION)
  })

  it('returns the exact same reference when the deleted key is unrelated (cheap no-op check)', () => {
    const current: BackgroundSelection = { kind: 'custom', imageKey: 'k1' }
    expect(nextSelectionAfterImageDeletion(current, 'other-key')).toBe(current)
  })

  it('is a no-op for non-custom selections', () => {
    expect(nextSelectionAfterImageDeletion(NONE_SELECTION, 'k1')).toBe(NONE_SELECTION)
    const blur: BackgroundSelection = { kind: 'blur' }
    expect(nextSelectionAfterImageDeletion(blur, 'k1')).toBe(blur)
  })
})

// ============================================================
// 自传图存储（MemoryBackgroundImageStore——与 IndexedDB 版同一契约）
// ============================================================
describe('MemoryBackgroundImageStore', () => {
  it('starts empty', async () => {
    expect(await new MemoryBackgroundImageStore().listImages()).toEqual([])
  })

  it('addImage assigns a unique key and stores the blob as-is', async () => {
    const store = new MemoryBackgroundImageStore()
    const blob = makeBlob('a')
    const result = await store.addImage(blob)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.image.blob).toBe(blob)
    expect(result.image.key.length).toBeGreaterThan(0)
  })

  it('listImages returns images in creation order', async () => {
    const store = new MemoryBackgroundImageStore()
    const first = await store.addImage(makeBlob('1'))
    const second = await store.addImage(makeBlob('2'))
    if (!first.ok || !second.ok) throw new Error('unreachable')
    const list = await store.listImages()
    expect(list.map((i) => i.key)).toEqual([first.image.key, second.image.key])
  })

  it('getImage finds a stored image by key and returns null for a missing one', async () => {
    const store = new MemoryBackgroundImageStore()
    const added = await store.addImage(makeBlob())
    if (!added.ok) throw new Error('unreachable')
    expect(await store.getImage(added.image.key)).toEqual(added.image)
    expect(await store.getImage('does-not-exist')).toBeNull()
  })

  it(`rejects the ${MAX_STORED_BACKGROUND_IMAGES + 1}th image with "limit_reached" once the cap is hit`, async () => {
    const store = new MemoryBackgroundImageStore()
    for (let i = 0; i < MAX_STORED_BACKGROUND_IMAGES; i += 1) {
      const result = await store.addImage(makeBlob(`img-${i}`))
      expect(result.ok).toBe(true)
    }
    const overflow = await store.addImage(makeBlob('overflow'))
    expect(overflow).toEqual({ ok: false, reason: 'limit_reached' })
    expect(await store.listImages()).toHaveLength(MAX_STORED_BACKGROUND_IMAGES)
  })

  it('deleteImage frees a slot so a new image can be added again', async () => {
    const store = new MemoryBackgroundImageStore()
    const keys: string[] = []
    for (let i = 0; i < MAX_STORED_BACKGROUND_IMAGES; i += 1) {
      const result = await store.addImage(makeBlob(`img-${i}`))
      if (result.ok) keys.push(result.image.key)
    }
    expect((await store.addImage(makeBlob('blocked'))).ok).toBe(false)

    await store.deleteImage(keys[0])
    expect(await store.listImages()).toHaveLength(MAX_STORED_BACKGROUND_IMAGES - 1)

    const afterDelete = await store.addImage(makeBlob('fits-now'))
    expect(afterDelete.ok).toBe(true)
    expect(await store.listImages()).toHaveLength(MAX_STORED_BACKGROUND_IMAGES)
  })

  it('deleteImage on a missing key is a harmless no-op', async () => {
    const store = new MemoryBackgroundImageStore()
    await expect(store.deleteImage('never-existed')).resolves.toBeUndefined()
  })
})
