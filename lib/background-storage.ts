/**
 * 背景虚化 / 虚拟背景的 **UI 侧存储封装**（2026-08-13 FR-7 UI 层）。
 *
 * 这里其实是两件独立的持久化拼在一个文件里：
 *  - **自传图的图片实体**（Blob）→ IndexedDB。图片本身可能有几百 KB，localStorage
 *    既没有这个容量、也没有存二进制的能力，只能走 IndexedDB。
 *  - **当前选择的是哪一项** → localStorage（key 固定为 `meet.backgroundEffect`）。
 *    这是个很小的 JSON，和 lib/store/join-storage.ts 里的设备选好放在同一层级即可。
 *
 * `BackgroundImageStore` 抽成接口，同时提供 IndexedDB 实现与纯内存实现——项目里没有
 * fake-indexeddb，也不允许新增依赖，所以单测（tests/ui/background-storage.test.ts）
 * 直接 new 一个 `MemoryBackgroundImageStore` 来验证逻辑（上限裁剪 / 删除联动 / key
 * 往返），真实的 IndexedDB 路径留给浏览器实测覆盖。
 *
 * ⚠️ 不 import lib/media/** 的任何实现，只借用 `types.ts` 的 `BackgroundEffect` 类型——
 * UI 只依赖抽象接口这条线（CLAUDE.md 硬规则 1）在这个文件里同样成立。
 * ⚠️ 也不在模块顶层触碰 window / indexedDB 之外的东西，所有浏览器 API 访问都延迟到
 * 调用时——Next.js 的 'use client' 组件仍会被 SSR 求值一次，模块顶层代码必须在
 * node/SSR 环境下不抛异常（与 join-storage.ts / background.ts 的 probe 函数同一纪律）。
 */
import { nanoid } from 'nanoid'
import { DEFAULT_BACKGROUND_BLUR_RADIUS, type BackgroundEffect } from '@/lib/media/types'

// ============================================================
// 0. 存储抽象（vitest 是无 DOM 的 node 环境，见 vitest.config.ts）
// ============================================================

/** 与 window.localStorage 兼容的最小接口，测试可以注入自己的假实现。 */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function resolveStorage(explicit: StorageLike | undefined): StorageLike | null {
  if (explicit) return explicit
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    // Safari 隐私浏览模式等场景下，访问 localStorage 本身就会抛异常——
    // 存不了就算了，不能因此让背景功能整体崩溃。
    return null
  }
}

function safeParseJson<T>(raw: string | null): T | null {
  if (raw === null || raw === '') return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

// ============================================================
// 1. 当前选择（localStorage）
// ============================================================

/**
 * 虚化強度のプリセット（2026-08-14 実機フィードバック：「ぼかしが弱すぎる」）。
 * 'light' は従来の既定値（DEFAULT_BACKGROUND_BLUR_RADIUS=10）相当、'strong' はより強く
 * （25、契約区間 [1,30] の上寄り＝「背景がほぼ判別できない」に近い水準）。
 *
 * ⚠️ 旧バージョンで保存された `{ kind: 'blur' }`（strength 未指定）は常に 'strong' として
 * 解釈する——「弱すぎる」という不満への移行として、強い方へ倒すのがユーザーの期待に合う。
 */
export type BlurStrength = 'light' | 'strong'

export const DEFAULT_BLUR_STRENGTH: BlurStrength = 'strong'

/** strength → provider に渡す blurRadius。両方とも契約区間 [1,30] 内
 *  （lib/media/providers/livekit/background.ts の MIN/MAX_BACKGROUND_BLUR_RADIUS）。
 *  light は既存の既定値に揃えて据え置き、strong は「認識できない」に近い 25。 */
export const BLUR_RADIUS_BY_STRENGTH: Record<BlurStrength, number> = {
  light: DEFAULT_BACKGROUND_BLUR_RADIUS,
  strong: 25,
}

/** 選択済みの blur から実効強度を取り出す（strength 未指定＝旧保存値は DEFAULT_BLUR_STRENGTH）。 */
export function blurStrengthOf(selection: { kind: 'blur'; strength?: BlurStrength }): BlurStrength {
  return selection.strength ?? DEFAULT_BLUR_STRENGTH
}

/**
 * 选择器里当前选中的项。与 provider 侧的 `BackgroundEffect` 形状相似但故意做成
 * 独立类型，原因只有一个：**自传图的 blob: URL 没法持久化**（刷新页面就失效）。
 * 能持久化的是 IndexedDB 里的 key，不是 URL。内置图是静态站内路径，天然稳定，
 * 直接存 imageUrl 即可。
 */
export type BackgroundSelection =
  | { kind: 'none' }
  | { kind: 'blur'; strength?: BlurStrength }
  | { kind: 'builtin'; imageUrl: string }
  | { kind: 'custom'; imageKey: string }

export const NONE_SELECTION: BackgroundSelection = { kind: 'none' }

const BACKGROUND_SELECTION_KEY = 'meet.backgroundEffect'

function isBackgroundSelection(value: unknown): value is BackgroundSelection {
  if (typeof value !== 'object' || value === null) return false
  const kind = (value as { kind?: unknown }).kind
  if (kind === 'none') return true
  if (kind === 'blur') {
    // strength は省略可（旧バージョンの保存値との後方互換）。値がある場合のみ検証する。
    const strength = (value as { strength?: unknown }).strength
    return strength === undefined || strength === 'light' || strength === 'strong'
  }
  if (kind === 'builtin') {
    const imageUrl = (value as { imageUrl?: unknown }).imageUrl
    return typeof imageUrl === 'string' && imageUrl.length > 0
  }
  if (kind === 'custom') {
    const imageKey = (value as { imageKey?: unknown }).imageKey
    return typeof imageKey === 'string' && imageKey.length > 0
  }
  return false
}

/** 值损坏或从未设置过时一律落回 `none`（与设备选好那组函数同样宽容，不抛异常）。 */
export function loadBackgroundSelection(storage?: StorageLike): BackgroundSelection {
  const parsed = safeParseJson<unknown>(resolveStorage(storage)?.getItem(BACKGROUND_SELECTION_KEY) ?? null)
  return isBackgroundSelection(parsed) ? parsed : NONE_SELECTION
}

export function saveBackgroundSelection(selection: BackgroundSelection, storage?: StorageLike): void {
  resolveStorage(storage)?.setItem(BACKGROUND_SELECTION_KEY, JSON.stringify(selection))
}

export function clearBackgroundSelection(storage?: StorageLike): void {
  resolveStorage(storage)?.removeItem(BACKGROUND_SELECTION_KEY)
}

/** 结构等价判定，和 provider 侧的 `isSameBackgroundEffect` 对应的 UI 版本。 */
export function isSameBackgroundSelection(a: BackgroundSelection, b: BackgroundSelection): boolean {
  if (a === b) return true
  if (a.kind !== b.kind) return false
  if (a.kind === 'builtin' && b.kind === 'builtin') return a.imageUrl === b.imageUrl
  if (a.kind === 'custom' && b.kind === 'custom') return a.imageKey === b.imageKey
  // blur は strength まで一致して初めて同一選択（未指定＝strong として比較。DEFAULT_BLUR_STRENGTH 参照）。
  if (a.kind === 'blur' && b.kind === 'blur') return blurStrengthOf(a) === blurStrengthOf(b)
  return true // none 本身不带值，kind 相同就是相同
}

/**
 * `BackgroundSelection` → 传给 provider 的 `BackgroundEffect`（纯函数）。
 *
 * `custom` 这一支单靠本文件解不出 blob: URL（`URL.createObjectURL` 是浏览器 API，
 * 且必须先从 IndexedDB 取出 Blob——这是调用方的职责），不传 `customImageUrl` 时
 * 返回 `null`，意思是「这个选择现在还解析不出效果，去把 blob 取来」。
 */
export function backgroundSelectionToEffect(
  selection: BackgroundSelection,
  customImageUrl?: string,
): BackgroundEffect | null {
  switch (selection.kind) {
    case 'none':
      return { type: 'none' }
    case 'blur':
      // 2026-08-14：二档强度显式换算成 blurRadius 传给 provider（旧版让 provider 落到自己的
      // 默认值，这正是「虚化太弱」反馈的成因）。strength 缺省（旧存值）按 DEFAULT_BLUR_STRENGTH
      // （'strong'）解释。
      return { type: 'blur', blurRadius: BLUR_RADIUS_BY_STRENGTH[blurStrengthOf(selection)] }
    case 'builtin':
      return { type: 'image', imageUrl: selection.imageUrl }
    case 'custom':
      return customImageUrl ? { type: 'image', imageUrl: customImageUrl } : null
  }
}

/**
 * 当前选中的自传图被删除时，下一个应该生效的选择（纯函数）。
 * 和 `deletedKey` 无关时返回**同一个引用**（`current` 本身），调用方可以用
 * `!==` 判断"是否需要先切走"——与 meeting-store.ts 的 `appendChatMessage` 同款技巧。
 */
export function nextSelectionAfterImageDeletion(
  current: BackgroundSelection,
  deletedKey: string,
): BackgroundSelection {
  if (current.kind === 'custom' && current.imageKey === deletedKey) return NONE_SELECTION
  return current
}

// ============================================================
// 2. 自传图实体（IndexedDB）
// ============================================================

export interface StoredBackgroundImage {
  key: string
  blob: Blob
  createdAt: number
}

/** 自传图张数上限。超出时**不做静默淘汰**——提示用户自己删掉旧图再传（诚实降级，
 *  不要替用户做"帮你删掉一张"这种有损的决定）。 */
export const MAX_STORED_BACKGROUND_IMAGES = 5

export type AddBackgroundImageResult =
  | { ok: true; image: StoredBackgroundImage }
  | { ok: false; reason: 'limit_reached' }

export interface BackgroundImageStore {
  listImages(): Promise<StoredBackgroundImage[]>
  getImage(key: string): Promise<StoredBackgroundImage | null>
  addImage(blob: Blob): Promise<AddBackgroundImageResult>
  deleteImage(key: string): Promise<void>
}

/**
 * 纯内存实现，专供单测使用。行为契约必须和 IndexedDB 版一致（上限、排序、
 * key 唯一），但没有真的持久化——测试进程结束就没了，这正是我们想要的。
 */
export class MemoryBackgroundImageStore implements BackgroundImageStore {
  private images = new Map<string, StoredBackgroundImage>()
  private seq = 0

  async listImages(): Promise<StoredBackgroundImage[]> {
    return Array.from(this.images.values()).sort((a, b) => a.createdAt - b.createdAt)
  }

  async getImage(key: string): Promise<StoredBackgroundImage | null> {
    return this.images.get(key) ?? null
  }

  async addImage(blob: Blob): Promise<AddBackgroundImageResult> {
    if (this.images.size >= MAX_STORED_BACKGROUND_IMAGES) return { ok: false, reason: 'limit_reached' }
    this.seq += 1
    // createdAt 用递增序号而不是 Date.now()：同一个 tick 里连续 add 多张时
    // Date.now() 可能撞车，导致排序测试不稳定；序号本身就足够表达"先后"。
    const image: StoredBackgroundImage = { key: `mem-${this.seq}`, blob, createdAt: this.seq }
    this.images.set(image.key, image)
    return { ok: true, image }
  }

  async deleteImage(key: string): Promise<void> {
    this.images.delete(key)
  }
}

const INDEXEDDB_NAME = 'meet-background-images'
const INDEXEDDB_VERSION = 1
const INDEXEDDB_STORE = 'images'

/** 浏览器 IndexedDB 的真实实现。 */
export class IndexedDbBackgroundImageStore implements BackgroundImageStore {
  private dbPromise: Promise<IDBDatabase> | null = null

  private openDb(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
          reject(new Error('indexedDB is unavailable in this environment'))
          return
        }
        const request = indexedDB.open(INDEXEDDB_NAME, INDEXEDDB_VERSION)
        request.onupgradeneeded = () => {
          const db = request.result
          if (!db.objectStoreNames.contains(INDEXEDDB_STORE)) {
            db.createObjectStore(INDEXEDDB_STORE, { keyPath: 'key' })
          }
        }
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error ?? new Error('failed to open indexedDB'))
      })
    }
    return this.dbPromise
  }

  async listImages(): Promise<StoredBackgroundImage[]> {
    const db = await this.openDb()
    return new Promise((resolve, reject) => {
      const request = db.transaction(INDEXEDDB_STORE, 'readonly').objectStore(INDEXEDDB_STORE).getAll()
      request.onsuccess = () => {
        const images = request.result as StoredBackgroundImage[]
        resolve(images.slice().sort((a, b) => a.createdAt - b.createdAt))
      }
      request.onerror = () => reject(request.error ?? new Error('failed to list background images'))
    })
  }

  async getImage(key: string): Promise<StoredBackgroundImage | null> {
    const db = await this.openDb()
    return new Promise((resolve, reject) => {
      const request = db.transaction(INDEXEDDB_STORE, 'readonly').objectStore(INDEXEDDB_STORE).get(key)
      request.onsuccess = () => resolve((request.result as StoredBackgroundImage | undefined) ?? null)
      request.onerror = () => reject(request.error ?? new Error('failed to read background image'))
    })
  }

  async addImage(blob: Blob): Promise<AddBackgroundImageResult> {
    const existing = await this.listImages()
    if (existing.length >= MAX_STORED_BACKGROUND_IMAGES) return { ok: false, reason: 'limit_reached' }

    const image: StoredBackgroundImage = { key: nanoid(12), blob, createdAt: Date.now() }
    const db = await this.openDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(INDEXEDDB_STORE, 'readwrite')
      tx.objectStore(INDEXEDDB_STORE).put(image)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('failed to store background image'))
    })
    return { ok: true, image }
  }

  async deleteImage(key: string): Promise<void> {
    const db = await this.openDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(INDEXEDDB_STORE, 'readwrite')
      tx.objectStore(INDEXEDDB_STORE).delete(key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('failed to delete background image'))
    })
  }
}

/**
 * 全局单例：UI 组件直接用这个（测试才需要自己 new 一个 `MemoryBackgroundImageStore`）。
 * Next.js 的 'use client' 组件仍会在服务端求值一次，模块顶层这里判断
 * `typeof indexedDB` 而不是直接 `new IndexedDbBackgroundImageStore()`，避免 SSR 时
 * 因为访问不存在的全局对象类型而出问题——真正被调用永远只会发生在浏览器里。
 */
function createDefaultBackgroundImageStore(): BackgroundImageStore {
  if (typeof indexedDB === 'undefined') return new MemoryBackgroundImageStore()
  return new IndexedDbBackgroundImageStore()
}

export const backgroundImageStore: BackgroundImageStore = createDefaultBackgroundImageStore()
