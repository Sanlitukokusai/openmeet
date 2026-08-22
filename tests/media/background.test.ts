// 背景ぼかし / バーチャル背景（2026-08-13 FR-7）の純ロジック。
// ⚠️ lib/media/providers/livekit/background.ts は livekit-client も
// @livekit/track-processors も import しない（後者は provider 側で dynamic import する）ので、
// node 環境の vitest からそのまま叩ける（chat.test.ts / mapping.test.ts と同じ方針）。
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  BACKGROUND_PROCESSOR_NAME,
  MAX_BACKGROUND_BLUR_RADIUS,
  MEDIAPIPE_ASSET_PATHS,
  MIN_BACKGROUND_BLUR_RADIUS,
  computeBackgroundSupport,
  createBackgroundProcessor,
  isSameBackgroundEffect,
  noBackgroundEffect,
  normalizeBackgroundEffect,
  planBackgroundApply,
  probeBackgroundCapabilities,
  toProcessorConstructorOptions,
  toSwitchOptions,
  validateBackgroundImageUrl,
  type BackgroundCapabilityProbe,
  type BackgroundProcessorConstructorOptions,
  type BackgroundSwitchOptions,
  type NormalizedBackgroundEffect,
} from '@/lib/media/providers/livekit/background'
import { DEFAULT_BACKGROUND_BLUR_RADIUS } from '@/lib/media/types'

const BLUR: NormalizedBackgroundEffect = { type: 'blur', blurRadius: 10 }
const IMAGE: NormalizedBackgroundEffect = { type: 'image', imageUrl: '/backgrounds/bg-office.webp' }
const NONE: NormalizedBackgroundEffect = { type: 'none' }
const ALL_EFFECTS: NormalizedBackgroundEffect[] = [NONE, BLUR, IMAGE]

/** `await import('@livekit/track-processors')` の代役。構築引数をそのまま捕まえる。 */
function fakeTrackProcessorsModule(supported = true) {
  const constructed: { options: BackgroundProcessorConstructorOptions; name?: string }[] = []
  const switched: BackgroundSwitchOptions[] = []
  let supportCalls = 0
  const mod = {
    supportsBackgroundProcessors: () => {
      supportCalls += 1
      return supported
    },
    BackgroundProcessor(options: BackgroundProcessorConstructorOptions, name?: string) {
      constructed.push({ options, name })
      return {
        switchTo: async (o: BackgroundSwitchOptions) => {
          switched.push(o)
        },
      }
    },
  }
  return { mod, constructed, switched, supportCalls: () => supportCalls }
}

// ============================================================
// 1. 大陸アクセスのレッドライン（§8.1）—— ここが本テストの主目的
// ============================================================

describe('MediaPipe アセットは常に自ホスト（§8.1 のレッドライン）', () => {
  it('assetPaths は同一オリジンの絶対パスである', () => {
    expect(MEDIAPIPE_ASSET_PATHS.tasksVisionFileSet).toBe('/mediapipe/wasm')
    expect(MEDIAPIPE_ASSET_PATHS.modelAssetPath).toBe('/mediapipe/selfie_segmenter.tflite')
    for (const value of Object.values(MEDIAPIPE_ASSET_PATHS)) {
      expect(value.startsWith('/')).toBe(true)
      // `//host` 形式（プロトコル相対＝外部）も弾く
      expect(value.startsWith('//')).toBe(false)
      expect(value).not.toMatch(/^[a-z]+:/i)
    }
  })

  it.each(ALL_EFFECTS)('どの effect（%j）でも構築オプションに assetPaths が乗る', (effect) => {
    const options = toProcessorConstructorOptions(effect)
    expect(options.assetPaths).toEqual({
      tasksVisionFileSet: '/mediapipe/wasm',
      modelAssetPath: '/mediapipe/selfie_segmenter.tflite',
    })
  })

  it('assetPaths は毎回コピーされる（呼び出し側が書き換えても定数は汚れない）', () => {
    const options = toProcessorConstructorOptions(BLUR)
    options.assetPaths.modelAssetPath = 'https://example.com/evil.tflite'
    expect(MEDIAPIPE_ASSET_PATHS.modelAssetPath).toBe('/mediapipe/selfie_segmenter.tflite')
    expect(toProcessorConstructorOptions(BLUR).assetPaths.modelAssetPath).toBe(
      '/mediapipe/selfie_segmenter.tflite',
    )
  })

  it.each(ALL_EFFECTS)(
    'createBackgroundProcessor は %j でもライブラリに自ホスト assetPaths を渡す',
    (effect) => {
      const { mod, constructed } = fakeTrackProcessorsModule()
      createBackgroundProcessor(mod, effect)
      expect(constructed).toHaveLength(1)
      expect(constructed[0].options.assetPaths).toEqual(MEDIAPIPE_ASSET_PATHS)
      expect(constructed[0].name).toBe(BACKGROUND_PROCESSOR_NAME)
    },
  )
})

describe('createBackgroundProcessor（遅延ロード後のライブラリ側再確認）', () => {
  it('ライブラリが非対応と言えば throw し、processor を作らない', () => {
    const { mod, constructed } = fakeTrackProcessorsModule(false)
    expect(() => createBackgroundProcessor(mod, BLUR)).toThrow(/not supported/i)
    expect(constructed).toHaveLength(0)
  })

  it('mode は effect に対応したものになる', () => {
    const { mod, constructed } = fakeTrackProcessorsModule()
    createBackgroundProcessor(mod, BLUR)
    createBackgroundProcessor(mod, IMAGE)
    createBackgroundProcessor(mod, NONE)
    expect(constructed.map((c) => c.options.mode)).toEqual([
      'background-blur',
      'virtual-background',
      'disabled',
    ])
  })

  // ★ 2026-08-14：ライブラリの `supportsBackgroundProcessors()` は内部で
  //   `document.createElement('canvas').getContext('webgl2')` を**毎回**実行し、その
  //   context を解放しない（0.7.2 の BackgroundTransformer.isSupported）。ブラウザの
  //   同時 WebGL context 数には上限があるので、processor を作り直すたびに呼ぶと
  //   本命の背景管線が巻き添えで context lost になる＝実機の「黒画面」の一因。
  //   よってモジュール単位で 1 回だけ呼ぶ。
  it('ライブラリ側の能力確認は 1 モジュールにつき 1 回だけ（WebGL context の食い潰し防止）', () => {
    const { mod, supportCalls } = fakeTrackProcessorsModule()
    createBackgroundProcessor(mod, BLUR)
    createBackgroundProcessor(mod, IMAGE)
    createBackgroundProcessor(mod, BLUR)
    expect(supportCalls()).toBe(1)
  })

  it('別モジュール（＝別セッション/別テスト）ではキャッシュが混ざらない', () => {
    const first = fakeTrackProcessorsModule(true)
    const second = fakeTrackProcessorsModule(false)
    createBackgroundProcessor(first.mod, BLUR)
    expect(() => createBackgroundProcessor(second.mod, BLUR)).toThrow(/not supported/i)
  })

  // 運行期の存活監視（provider の watchdog）は、ライブラリが唯一くれる正向シグナル。
  it('onFrameProcessed を渡すと構築オプションに載る（運行期の心跳）', () => {
    const { mod, constructed } = fakeTrackProcessorsModule()
    const heartbeat = () => {}
    createBackgroundProcessor(mod, BLUR, heartbeat)
    expect(constructed[0].options.onFrameProcessed).toBe(heartbeat)
  })

  it('渡さなければキー自体を作らない（ライブラリの既定挙動を変えない）', () => {
    const { mod, constructed } = fakeTrackProcessorsModule()
    createBackgroundProcessor(mod, BLUR)
    expect('onFrameProcessed' in constructed[0].options).toBe(false)
  })

  it('assetPaths は onFrameProcessed の有無に関わらず必ず自ホスト（§8.1 は崩さない）', () => {
    const { mod, constructed } = fakeTrackProcessorsModule()
    createBackgroundProcessor(mod, IMAGE, () => {})
    expect(constructed[0].options.assetPaths).toEqual(MEDIAPIPE_ASSET_PATHS)
  })
})

// ============================================================
// 2. imageUrl の検証マトリクス
// ============================================================

describe('validateBackgroundImageUrl（同一オリジンのホワイトリスト）', () => {
  it.each([
    ['サイト内絶対パス', '/backgrounds/bg-office.webp'],
    ['クエリ付き', '/backgrounds/bg-nature.webp?v=2'],
    ['blob:（ローカルアップロード）', 'blob:https://meet.example.com/9f2c-1234'],
    ['data:image/png', 'data:image/png;base64,iVBORw0KGgo='],
    ['data:image/webp', 'data:image/webp;base64,UklGRg=='],
    ['大文字スキーム', 'DATA:IMAGE/PNG;base64,iVBORw0KGgo='],
  ])('通す: %s', (_label, url) => {
    expect(validateBackgroundImageUrl(url)).toEqual({ ok: true, url: url.trim() })
  })

  it.each([
    ['https 外部リンク', 'https://images.example.com/bg.png', 'external'],
    ['http 外部リンク', 'http://images.example.com/bg.png', 'external'],
    ['プロトコル相対 //', '//images.example.com/bg.png', 'external'],
    ['バックスラッシュ版 /\\', '/\\images.example.com/bg.png', 'external'],
    ['相対パス', 'backgrounds/bg.png', 'unsupported_scheme'],
    ['data: だが画像でない', 'data:text/html,<script>alert(1)</script>', 'unsupported_scheme'],
    ['javascript:', 'javascript:alert(1)', 'unsupported_scheme'],
    ['file:', 'file:///etc/passwd', 'unsupported_scheme'],
    ['空文字', '', 'empty'],
    ['空白のみ', '   ', 'empty'],
    ['改行入り', '/bg.png\nhttps://evil.example.com', 'malformed'],
    ['数値', 42, 'malformed'],
    ['null', null, 'malformed'],
    ['undefined', undefined, 'malformed'],
  ])('拒否: %s', (_label, url, reason) => {
    expect(validateBackgroundImageUrl(url)).toEqual({ ok: false, reason })
  })

  it('前後の空白は落としてから判定する', () => {
    expect(validateBackgroundImageUrl('  /backgrounds/bg-living.webp  ')).toEqual({
      ok: true,
      url: '/backgrounds/bg-living.webp',
    })
  })
})

// ============================================================
// 3. normalizeBackgroundEffect
// ============================================================

describe('normalizeBackgroundEffect', () => {
  it('none はそのまま通す', () => {
    expect(normalizeBackgroundEffect({ type: 'none' })).toEqual({ ok: true, effect: { type: 'none' } })
  })

  it('blurRadius 未指定なら既定値 10 を入れる', () => {
    expect(normalizeBackgroundEffect({ type: 'blur' })).toEqual({
      ok: true,
      effect: { type: 'blur', blurRadius: DEFAULT_BACKGROUND_BLUR_RADIUS },
    })
    expect(DEFAULT_BACKGROUND_BLUR_RADIUS).toBe(10)
  })

  it.each([
    [0, MIN_BACKGROUND_BLUR_RADIUS],
    [-5, MIN_BACKGROUND_BLUR_RADIUS],
    [1, 1],
    [15, 15],
    [30, 30],
    [999, MAX_BACKGROUND_BLUR_RADIUS],
  ])('blurRadius %d は範囲 [1,30] に丸める（拒否ではなく clamp）', (input, expected) => {
    expect(normalizeBackgroundEffect({ type: 'blur', blurRadius: input })).toEqual({
      ok: true,
      effect: { type: 'blur', blurRadius: expected },
    })
  })

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['文字列', '10'],
    ['null', null],
  ])('blurRadius が有限数でない（%s）なら拒否する', (_label, blurRadius) => {
    const result = normalizeBackgroundEffect({ type: 'blur', blurRadius })
    expect(result.ok).toBe(false)
  })

  it('image は URL 検証を通ったものだけ受ける', () => {
    expect(normalizeBackgroundEffect({ type: 'image', imageUrl: '/backgrounds/bg-office.webp' })).toEqual({
      ok: true,
      effect: { type: 'image', imageUrl: '/backgrounds/bg-office.webp' },
    })
  })

  it('外部リンクの imageUrl は拒否し、理由をメッセージに書く（黙って飲まない）', () => {
    const result = normalizeBackgroundEffect({ type: 'image', imageUrl: 'https://cdn.example.com/x.png' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(/same-origin/)
  })

  it.each([
    ['未知の type', { type: 'sepia' }],
    ['type なし', {}],
    ['null', null],
    ['文字列', 'blur'],
  ])('不正な effect（%s）は拒否する', (_label, effect) => {
    expect(normalizeBackgroundEffect(effect).ok).toBe(false)
  })

  it('返る effect は凍結されている（呼び出し側の書き換えで状態が壊れない）', () => {
    const result = normalizeBackgroundEffect({ type: 'blur', blurRadius: 12 })
    expect(result.ok).toBe(true)
    if (result.ok) expect(Object.isFrozen(result.effect)).toBe(true)
  })
})

// ============================================================
// 4. 状態機械（none → blur → image → none、および冪等性）
// ============================================================

describe('effect 状態機械', () => {
  it('toSwitchOptions はライブラリの mode に 1:1 対応する', () => {
    expect(toSwitchOptions(NONE)).toEqual({ mode: 'disabled' })
    expect(toSwitchOptions(BLUR)).toEqual({ mode: 'background-blur', blurRadius: 10 })
    expect(toSwitchOptions(IMAGE)).toEqual({
      mode: 'virtual-background',
      imagePath: '/backgrounds/bg-office.webp',
    })
  })

  it('none → blur → image → none を一巡しても各段で正しい plan になる', () => {
    // カメラ ON、processor は現在のトラックに付いている状態で切り替えていく
    const attached = (effect: NormalizedBackgroundEffect) =>
      planBackgroundApply({ hasCameraTrack: true, processorAttachedToCurrentTrack: true, effect })

    // none 開始（まだ processor なし）
    expect(
      planBackgroundApply({ hasCameraTrack: true, processorAttachedToCurrentTrack: false, effect: NONE }),
    ).toEqual({ action: 'teardown' })
    // none → blur: processor がないので作り直し
    expect(
      planBackgroundApply({ hasCameraTrack: true, processorAttachedToCurrentTrack: false, effect: BLUR }),
    ).toEqual({ action: 'recreate' })
    // blur → image: 同一トラック上なので switchTo（残像なし・モデル再読み込みなし）
    expect(attached(IMAGE)).toEqual({
      action: 'switch',
      options: { mode: 'virtual-background', imagePath: '/backgrounds/bg-office.webp' },
    })
    // image → none: パイプラインごと畳む（CPU を残さない）
    expect(attached(NONE)).toEqual({ action: 'teardown' })
  })

  it('同じ effect を繰り返し指定しても plan は同一（冪等）', () => {
    const input = { hasCameraTrack: true, processorAttachedToCurrentTrack: true, effect: BLUR }
    expect(planBackgroundApply(input)).toEqual(planBackgroundApply(input))
    expect(planBackgroundApply(input)).toEqual({
      action: 'switch',
      options: { mode: 'background-blur', blurRadius: 10 },
    })
  })

  it('blurRadius だけ変えた場合も switch で済ませる（作り直さない）', () => {
    const plan = planBackgroundApply({
      hasCameraTrack: true,
      processorAttachedToCurrentTrack: true,
      effect: { type: 'blur', blurRadius: 25 },
    })
    expect(plan).toEqual({ action: 'switch', options: { mode: 'background-blur', blurRadius: 25 } })
  })
})

describe('カメラの開閉に伴う再適用（planBackgroundApply）', () => {
  it.each(ALL_EFFECTS)('カメラ OFF（トラックなし）なら effect %j でも teardown', (effect) => {
    expect(
      planBackgroundApply({ hasCameraTrack: false, processorAttachedToCurrentTrack: false, effect }),
    ).toEqual({ action: 'teardown' })
  })

  it('カメラを閉じて開き直した直後は recreate になる（新しい LocalVideoTrack のため）', () => {
    // LiveKit は LocalTrack.stop() で processor を destroy する＋
    // stopLocalTrackOnUnpublish: true なのでカメラ再開は「別トラック」
    expect(
      planBackgroundApply({
        hasCameraTrack: true,
        processorAttachedToCurrentTrack: false, // 別トラックなので付いていない扱い
        effect: BLUR,
      }),
    ).toEqual({ action: 'recreate' })
  })

  it('デバイス切替のようにトラックが同一のままなら switch で済む', () => {
    expect(
      planBackgroundApply({
        hasCameraTrack: true,
        processorAttachedToCurrentTrack: true,
        effect: IMAGE,
      }),
    ).toEqual({
      action: 'switch',
      options: { mode: 'virtual-background', imagePath: '/backgrounds/bg-office.webp' },
    })
  })
})

describe('isSameBackgroundEffect（localStateChanged の抑制用）', () => {
  it('内容が同じなら別オブジェクトでも同一とみなす', () => {
    expect(isSameBackgroundEffect({ type: 'none' }, { type: 'none' })).toBe(true)
    expect(isSameBackgroundEffect({ type: 'blur', blurRadius: 10 }, { type: 'blur', blurRadius: 10 })).toBe(true)
    expect(isSameBackgroundEffect({ type: 'image', imageUrl: '/a.webp' }, { type: 'image', imageUrl: '/a.webp' })).toBe(true)
  })

  it.each([
    [{ type: 'blur', blurRadius: 10 } as const, { type: 'blur', blurRadius: 20 } as const],
    [{ type: 'image', imageUrl: '/a.webp' } as const, { type: 'image', imageUrl: '/b.webp' } as const],
    [{ type: 'none' } as const, { type: 'blur', blurRadius: 10 } as const],
  ])('内容が違えば別物と判定する（%j / %j）', (a, b) => {
    expect(isSameBackgroundEffect(a, b)).toBe(false)
  })

  // provider 側は最初から { type: 'none' } を入れるので undefined は本来出てこないが、
  // 他 provider（将来の Agora）や古い state が undefined を渡してきても落ちないこと。
  it('undefined と none は別物扱い（安全側：変化ありとして扱い、握り潰さない）', () => {
    expect(isSameBackgroundEffect(undefined, { type: 'none' })).toBe(false)
    expect(isSameBackgroundEffect(undefined, undefined)).toBe(true)
  })

  it('noBackgroundEffect() は毎回同じ凍結オブジェクトを返す', () => {
    expect(noBackgroundEffect()).toBe(noBackgroundEffect())
    expect(Object.isFrozen(noBackgroundEffect())).toBe(true)
  })
})

// ============================================================
// 5. 能力検出
// ============================================================

const FULL_PROBE: BackgroundCapabilityProbe = {
  offscreenCanvas: true,
  videoFrame: true,
  createImageBitmap: true,
  webgl2: true,
  streamTrackProcessor: true,
  canvasCaptureStream: true,
}

describe('computeBackgroundSupport（ライブラリの判定式のミラー）', () => {
  it('全部揃っていれば true', () => {
    expect(computeBackgroundSupport(FULL_PROBE)).toBe(true)
  })

  it.each([
    'offscreenCanvas',
    'videoFrame',
    'createImageBitmap',
    'webgl2',
  ] as const)('BackgroundTransformer 側の必須項目 %s が欠けたら false', (key) => {
    expect(computeBackgroundSupport({ ...FULL_PROBE, [key]: false })).toBe(false)
  })

  it('Insertable Streams が無くても canvas.captureStream があれば true（Safari 経路）', () => {
    expect(
      computeBackgroundSupport({ ...FULL_PROBE, streamTrackProcessor: false, canvasCaptureStream: true }),
    ).toBe(true)
  })

  it('どちらの出力経路も無ければ false', () => {
    expect(
      computeBackgroundSupport({ ...FULL_PROBE, streamTrackProcessor: false, canvasCaptureStream: false }),
    ).toBe(false)
  })
})

describe('probeBackgroundCapabilities（SSR / node 安全性）', () => {
  it('node 環境では例外を投げず、全項目 false を返す', () => {
    const probe = probeBackgroundCapabilities()
    expect(Object.values(probe).every((v) => v === false)).toBe(true)
  })

  it('つまり node / SSR では非対応と判定される（UI は入口を disabled にできる）', () => {
    expect(computeBackgroundSupport(probeBackgroundCapabilities())).toBe(false)
  })
})

// ============================================================
// 6. 構造ガード —— ソースに外部 CDN の痕跡が復活していないか
// ============================================================

const MEDIA_DIR = fileURLToPath(new URL('../../lib/media', import.meta.url))

function collectSourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...collectSourceFiles(full))
    else if (/\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

describe('構造ガード：lib/media/** に外部 CDN 参照を残さない（§8.1）', () => {
  const files = collectSourceFiles(MEDIA_DIR)

  it('走査対象が空でない（テスト自体が空振りしていないことの確認）', () => {
    expect(files.length).toBeGreaterThan(3)
  })

  it.each(['googleapis', 'gstatic', 'jsdelivr', 'mediapipe-models', 'unpkg.com'])(
    '禁止トークン "%s" がどのファイルにも現れない（コメント内も含む）',
    (token) => {
      const hits = files.filter((f) => readFileSync(f, 'utf8').toLowerCase().includes(token))
      expect(hits).toEqual([])
    },
  )

  it('@livekit/track-processors は静的 import されていない（初期 chunk 肥大化の防止・§8.2）', () => {
    // 許されるのは dynamic import と `typeof import(...)` の型位置だけ。
    // 静的 import 文（import ... from '@livekit/track-processors'）が現れたら失敗させる。
    const staticImport = /import\s[^;]*?from\s+['"]@livekit\/track-processors['"]/
    const hits = files.filter((f) => staticImport.test(readFileSync(f, 'utf8')))
    expect(hits).toEqual([])
  })

  it('assetPaths の定義箇所は background.ts のみ（レッドラインの単一事実源）', () => {
    const hits = files.filter((f) => readFileSync(f, 'utf8').includes('tasksVisionFileSet:'))
    expect(hits.map((f) => f.split('/').pop())).toEqual(['background.ts'])
  })
})
