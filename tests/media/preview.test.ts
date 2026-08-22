// prejoin のリアルタイム背景プレビュー（2026-08-16 実機フィードバック③）。
//
// lib/media/providers/livekit/preview.ts は livekit-client と
// @livekit/track-processors に触るので、両方を差し替えて node 環境で回す
// （tests/media/background.test.ts と同じ「偽モジュールを同じコードパスへ流す」作法）。
// ここで押さえるのは 4 点：
//   ① 会議内と同じ **自ホスト assetPaths** が必ず渡ること（§8.1 の赤線をプレビュー側でも固定）
//   ② 効果の状態機械（none→blur は作り直し／同一トラック上の変更は switchTo）
//   ③ 失敗したら効果は none に落ちるが**カメラ映像は残る**、かつ reject する（黙って飲まない）
//   ④ dispose が同期・冪等で、カメラを必ず手放すこと
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MEDIAPIPE_ASSET_PATHS } from '@/lib/media/providers/livekit/background'

// ============================================================
// 偽モジュール（vi.mock はホイストされるので状態は vi.hoisted 経由で共有する）
// ============================================================

interface FakeProcessor {
  switchTo: ReturnType<typeof vi.fn>
  id: number
}

const shared = vi.hoisted(() => {
  return {
    /** loadTrackProcessors() が返す偽モジュール。テストごとに差し替える。 */
    processorsModule: null as unknown,
    /** createLocalVideoTrack() が投げるエラー（カメラが開けないケースの再現）。 */
    createTrackError: null as Error | null,
    /** createLocalVideoTrack() に渡されたオプションの記録。 */
    createTrackCalls: [] as unknown[],
    /** 生成された偽トラック（stop 済みかどうかを見る）。 */
    tracks: [] as Array<Record<string, unknown>>,
  }
})

vi.mock('livekit-client', () => ({
  createLocalVideoTrack: async (options: unknown) => {
    shared.createTrackCalls.push(options)
    if (shared.createTrackError) throw shared.createTrackError
    const track = {
      attachedTo: [] as unknown[],
      detachedFrom: [] as unknown[],
      stopped: false,
      processor: undefined as unknown,
      stopProcessorCalls: 0,
      setProcessorError: null as Error | null,
      attach(el: unknown) {
        this.attachedTo.push(el)
        return el
      },
      detach(el: unknown) {
        this.detachedFrom.push(el)
      },
      stop() {
        this.stopped = true
        this.processor = undefined
      },
      async setProcessor(processor: unknown) {
        if (this.setProcessorError) throw this.setProcessorError
        this.processor = processor
      },
      async stopProcessor() {
        this.stopProcessorCalls += 1
        this.processor = undefined
      },
    }
    shared.tracks.push(track)
    return track
  },
}))

vi.mock('@/lib/media/providers/livekit/track-processors-loader', () => ({
  loadTrackProcessors: async () => shared.processorsModule,
}))

const { createBackgroundPreviewSession } = await import('@/lib/media/providers/livekit/preview')

// ============================================================
// テスト用の環境づくり
// ============================================================

/** 偽 track-processors モジュール。構築引数を全部記録する。 */
function makeProcessorsModule(supported = true) {
  const constructed: Array<{ options: Record<string, unknown>; name?: string }> = []
  const processors: FakeProcessor[] = []
  const mod = {
    supportsBackgroundProcessors: () => supported,
    BackgroundProcessor: (options: Record<string, unknown>, name?: string) => {
      constructed.push({ options, name })
      const processor: FakeProcessor = { switchTo: vi.fn(async () => {}), id: processors.length }
      processors.push(processor)
      return processor
    },
  }
  return { mod, constructed, processors }
}

/**
 * `probeBackgroundCapabilities()` が「対応環境」と判定するのに必要な最小のグローバル群。
 * ここに並ぶものが増減したら、それはライブラリ側の判定式が変わったということ
 * （lib/media/providers/livekit/background.ts の BackgroundCapabilityProbe と 1:1）。
 */
function installCapableBrowserGlobals(): void {
  const g = globalThis as Record<string, unknown>
  class FakeCanvasElement {
    captureStream() {
      return {}
    }
  }
  g.OffscreenCanvas = class {}
  g.VideoFrame = class {}
  g.createImageBitmap = () => undefined
  g.MediaStreamTrackProcessor = class {}
  g.MediaStreamTrackGenerator = class {}
  g.HTMLCanvasElement = FakeCanvasElement
  g.window = {}
  g.document = {
    createElement: () => ({
      getContext: () => ({ getExtension: () => null }),
    }),
  }
}

function removeBrowserGlobals(): void {
  const g = globalThis as Record<string, unknown>
  for (const key of [
    'OffscreenCanvas',
    'VideoFrame',
    'createImageBitmap',
    'MediaStreamTrackProcessor',
    'MediaStreamTrackGenerator',
    'HTMLCanvasElement',
    'window',
    'document',
  ]) {
    delete g[key]
  }
}

function fakeVideoElement() {
  return { srcObject: {} as unknown } as unknown as HTMLVideoElement
}

function currentTrack() {
  return shared.tracks[shared.tracks.length - 1]
}

beforeEach(() => {
  shared.createTrackError = null
  shared.createTrackCalls = []
  shared.tracks = []
  installCapableBrowserGlobals()
})

afterEach(() => {
  removeBrowserGlobals()
})

// ============================================================

describe('セッションの生成', () => {
  it('カメラトラックを作って <video> へ attach する', async () => {
    const { mod } = makeProcessorsModule()
    shared.processorsModule = mod
    const el = fakeVideoElement()

    const session = await createBackgroundPreviewSession(el, { deviceId: 'cam-1' })

    expect(shared.createTrackCalls).toHaveLength(1)
    expect(currentTrack().attachedTo).toEqual([el])
    session.dispose()
  })

  it('採集解像度は会議内と同じ 720p（プレビューが負荷の目安になるように）', async () => {
    shared.processorsModule = makeProcessorsModule().mod
    const session = await createBackgroundPreviewSession(fakeVideoElement())
    expect(shared.createTrackCalls[0]).toMatchObject({ resolution: { width: 1280, height: 720 } })
    session.dispose()
  })

  it('deviceId 省略時はそのまま undefined を渡す（ブラウザ既定のカメラ）', async () => {
    shared.processorsModule = makeProcessorsModule().mod
    const session = await createBackgroundPreviewSession(fakeVideoElement())
    expect((shared.createTrackCalls[0] as { deviceId?: string }).deviceId).toBeUndefined()
    session.dispose()
  })

  it('カメラが開けなければ reject する（呼び出し側がプレースホルダー表示へ倒せる）', async () => {
    shared.processorsModule = makeProcessorsModule().mod
    shared.createTrackError = new Error('NotReadableError')
    await expect(createBackgroundPreviewSession(fakeVideoElement())).rejects.toThrow(/NotReadableError/)
  })
})

describe('§8.1 レッドライン：プレビューでも assetPaths は必ず自ホスト', () => {
  it('blur を適用すると自ホストの wasm / モデルパスでライブラリを構築する', async () => {
    const { mod, constructed } = makeProcessorsModule()
    shared.processorsModule = mod
    const session = await createBackgroundPreviewSession(fakeVideoElement())

    await session.setEffect({ type: 'blur', blurRadius: 25 })

    expect(constructed).toHaveLength(1)
    expect(constructed[0].options.assetPaths).toEqual(MEDIAPIPE_ASSET_PATHS)
    expect(MEDIAPIPE_ASSET_PATHS.tasksVisionFileSet.startsWith('/')).toBe(true)
    expect(MEDIAPIPE_ASSET_PATHS.modelAssetPath.startsWith('/')).toBe(true)
    session.dispose()
  })

  it('画像背景（虚拟背景）でも同じく自ホストの assetPaths を渡す', async () => {
    const { mod, constructed } = makeProcessorsModule()
    shared.processorsModule = mod
    const session = await createBackgroundPreviewSession(fakeVideoElement())

    await session.setEffect({ type: 'image', imageUrl: '/backgrounds/bg-office.webp' })

    expect(constructed[0].options.assetPaths).toEqual(MEDIAPIPE_ASSET_PATHS)
    expect(constructed[0].options.mode).toBe('virtual-background')
    session.dispose()
  })
})

describe('効果の状態機械（会議内 applyBackgroundEffect と同じ決定表）', () => {
  it('none → blur は processor を作って track へ載せる', async () => {
    const { mod, constructed } = makeProcessorsModule()
    shared.processorsModule = mod
    const session = await createBackgroundPreviewSession(fakeVideoElement())

    await session.setEffect({ type: 'blur', blurRadius: 10 })

    expect(constructed).toHaveLength(1)
    expect(currentTrack().processor).toBeDefined()
    session.dispose()
  })

  it('同じトラック上の効果変更は switchTo（作り直さない＝モデル再読込も残像も無い）', async () => {
    const { mod, constructed, processors } = makeProcessorsModule()
    shared.processorsModule = mod
    const session = await createBackgroundPreviewSession(fakeVideoElement())

    await session.setEffect({ type: 'blur', blurRadius: 10 })
    await session.setEffect({ type: 'blur', blurRadius: 25 })
    await session.setEffect({ type: 'image', imageUrl: '/backgrounds/bg-nature.webp' })

    expect(constructed).toHaveLength(1) // 構築は 1 回だけ
    expect(processors[0].switchTo).toHaveBeenCalledTimes(2)
    expect(processors[0].switchTo).toHaveBeenLastCalledWith({
      mode: 'virtual-background',
      imagePath: '/backgrounds/bg-nature.webp',
    })
    session.dispose()
  })

  it('none は管線を本当に外す（CPU を返す。常駐 disabled にしない）', async () => {
    shared.processorsModule = makeProcessorsModule().mod
    const session = await createBackgroundPreviewSession(fakeVideoElement())

    await session.setEffect({ type: 'blur' })
    await session.setEffect({ type: 'none' })

    expect(currentTrack().stopProcessorCalls).toBeGreaterThan(0)
    expect(currentTrack().processor).toBeUndefined()
    session.dispose()
  })

  it('none → none は何も壊さない（冪等）', async () => {
    shared.processorsModule = makeProcessorsModule().mod
    const session = await createBackgroundPreviewSession(fakeVideoElement())
    await session.setEffect({ type: 'none' })
    await expect(session.setEffect({ type: 'none' })).resolves.toBeUndefined()
    session.dispose()
  })

  it('不正な imageUrl（外部リンク）は管線を起こす前に reject する', async () => {
    const { mod, constructed } = makeProcessorsModule()
    shared.processorsModule = mod
    const session = await createBackgroundPreviewSession(fakeVideoElement())

    await expect(session.setEffect({ type: 'image', imageUrl: 'https://example.com/x.png' })).rejects.toThrow(
      /same-origin/i,
    )
    expect(constructed).toHaveLength(0)
    session.dispose()
  })

  it('ライブラリが非対応と言えば reject し、カメラ映像はそのまま残る', async () => {
    const { mod } = makeProcessorsModule(false)
    shared.processorsModule = mod
    const el = fakeVideoElement()
    const session = await createBackgroundPreviewSession(el)

    await expect(session.setEffect({ type: 'blur' })).rejects.toThrow(/not supported/i)
    expect(currentTrack().stopped).toBe(false)
    expect(currentTrack().attachedTo).toEqual([el])
    session.dispose()
  })

  it('setProcessor が途中で失敗したら効果は none に落ち、次の setEffect は作り直しから始まる', async () => {
    const { mod, constructed } = makeProcessorsModule()
    shared.processorsModule = mod
    const session = await createBackgroundPreviewSession(fakeVideoElement())
    currentTrack().setProcessorError = new Error('webgl blew up')

    await expect(session.setEffect({ type: 'blur' })).rejects.toThrow()
    expect(currentTrack().processor).toBeUndefined()

    // 効果が none に戻っている＝次は switchTo ではなく構築からやり直す
    currentTrack().setProcessorError = null
    await session.setEffect({ type: 'blur' })
    expect(constructed).toHaveLength(2)
    expect(currentTrack().processor).toBeDefined()
    session.dispose()
  })
})

describe('カメラ切替（setDeviceId）', () => {
  it('新しい deviceId でトラックを作り直し、古いトラックは止める', async () => {
    shared.processorsModule = makeProcessorsModule().mod
    const el = fakeVideoElement()
    const session = await createBackgroundPreviewSession(el, { deviceId: 'cam-1' })
    const first = currentTrack()

    await session.setDeviceId('cam-2')

    expect(shared.createTrackCalls).toHaveLength(2)
    expect((shared.createTrackCalls[1] as { deviceId?: string }).deviceId).toBe('cam-2')
    expect(first.stopped).toBe(true)
    expect(first.detachedFrom).toEqual([el])
    expect(currentTrack().attachedTo).toEqual([el])
    session.dispose()
  })

  it('同じ deviceId なら何もしない（無駄なカメラ再取得を防ぐ）', async () => {
    shared.processorsModule = makeProcessorsModule().mod
    const session = await createBackgroundPreviewSession(fakeVideoElement(), { deviceId: 'cam-1' })
    await session.setDeviceId('cam-1')
    expect(shared.createTrackCalls).toHaveLength(1)
    session.dispose()
  })

  it('切替後も現在の効果が新しいトラックへ載せ直される（UI からの再適用は不要）', async () => {
    const { mod, constructed } = makeProcessorsModule()
    shared.processorsModule = mod
    const session = await createBackgroundPreviewSession(fakeVideoElement(), { deviceId: 'cam-1' })

    await session.setEffect({ type: 'blur', blurRadius: 25 })
    await session.setDeviceId('cam-2')

    expect(constructed).toHaveLength(2) // 新しいトラック用に作り直し
    expect(constructed[1].options).toMatchObject({ mode: 'background-blur', blurRadius: 25 })
    expect(constructed[1].options.assetPaths).toEqual(MEDIAPIPE_ASSET_PATHS)
    expect(currentTrack().processor).toBeDefined()
    session.dispose()
  })

  it('新しいカメラが開けなければ reject する（黙ってプレビューが消えない）', async () => {
    shared.processorsModule = makeProcessorsModule().mod
    const session = await createBackgroundPreviewSession(fakeVideoElement(), { deviceId: 'cam-1' })
    shared.createTrackError = new Error('OverconstrainedError')

    await expect(session.setDeviceId('cam-2')).rejects.toThrow(/OverconstrainedError/)
    session.dispose()
  })
})

describe('dispose（カメラを必ず手放す・冪等）', () => {
  it('トラックを止めて detach し、srcObject も空にする', async () => {
    shared.processorsModule = makeProcessorsModule().mod
    const el = fakeVideoElement()
    const session = await createBackgroundPreviewSession(el)
    const track = currentTrack()

    session.dispose()

    expect(track.stopped).toBe(true)
    expect(track.detachedFrom).toEqual([el])
    expect(el.srcObject).toBeNull()
  })

  it('2 回呼んでも安全（React の cleanup が二重に走っても壊れない）', async () => {
    shared.processorsModule = makeProcessorsModule().mod
    const session = await createBackgroundPreviewSession(fakeVideoElement())
    const track = currentTrack()

    session.dispose()
    session.dispose()

    expect(track.detachedFrom).toHaveLength(1) // 2 回目は何もしていない
  })

  it('dispose 後の setEffect / setDeviceId は無副作用で resolve する', async () => {
    const { mod, constructed } = makeProcessorsModule()
    shared.processorsModule = mod
    const session = await createBackgroundPreviewSession(fakeVideoElement())
    session.dispose()

    await expect(session.setEffect({ type: 'blur' })).resolves.toBeUndefined()
    await expect(session.setDeviceId('cam-9')).resolves.toBeUndefined()
    expect(constructed).toHaveLength(0)
    expect(shared.createTrackCalls).toHaveLength(1)
  })

  it('効果が載った状態で dispose してもトラックは確実に止まる（管線ごと破棄される）', async () => {
    shared.processorsModule = makeProcessorsModule().mod
    const session = await createBackgroundPreviewSession(fakeVideoElement())
    await session.setEffect({ type: 'blur' })
    const track = currentTrack()

    session.dispose()

    expect(track.stopped).toBe(true)
    expect(track.processor).toBeUndefined()
  })
})
