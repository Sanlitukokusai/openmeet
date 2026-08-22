// 本地プレビュー小窓のドラッグ＆四隅スナップ（2026-08-16 実機フィードバック）。
// components/room/pip-drag.ts は React にも DOM にも依存しない純関数群なので、
// tests/ui/video-fit.test.ts と同じ作法でそのまま node 環境の vitest から叩ける。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clampPipPosition,
  DEFAULT_PIP_CORNER,
  isPipClick,
  loadPipCorner,
  nearestPipCorner,
  parsePipCorner,
  PIP_CORNER_STORAGE_KEY,
  PIP_DESKTOP_SIZE_CLASS,
  PIP_DRAG_CLICK_THRESHOLD_PX,
  PIP_MARGIN_BOTTOM_PX,
  PIP_MARGIN_SIDE_PX,
  PIP_MARGIN_TOP_PX,
  PIP_MOBILE_ASPECT_HEIGHT,
  PIP_MOBILE_ASPECT_WIDTH,
  PIP_MOBILE_MAX_WIDTH_PX,
  PIP_MOBILE_SIZE_CLASS,
  PIP_MOBILE_VIEWPORT_WIDTH_RATIO,
  PIP_SNAP_TRANSITION_MS,
  pipMobileTileSize,
  resolvePipCornerPosition,
  savePipCorner,
  type PipBounds,
  type PipCorner,
} from '@/components/room/pip-drag'

/** iPhone SE 相当（375×812）に、実測に近いタイル寸法（min(28vw,128px)=105、16:9→59）を仮定。 */
function bounds(overrides: Partial<PipBounds> = {}): PipBounds {
  return {
    viewportWidth: 375,
    viewportHeight: 812,
    tileWidth: 105,
    tileHeight: 59,
    marginTop: 12,
    marginRight: 12,
    marginBottom: 84,
    marginLeft: 12,
    ...overrides,
  }
}

/** node 環境なので window は無い。最小限の sessionStorage を持つ window を差し込む（video-fit.test.ts と同じ手法）。 */
function installFakeWindow(storage?: Partial<Storage>) {
  const store = new Map<string, string>()
  const sessionStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
    ...storage,
  }
  ;(globalThis as Record<string, unknown>).window = { sessionStorage }
  return store
}

describe('clampPipPosition', () => {
  it('境界内の座標はそのまま返る', () => {
    const b = bounds()
    expect(clampPipPosition({ x: 100, y: 300 }, b)).toEqual({ x: 100, y: 300 })
  })

  it('左・上・右・下、それぞれ単独のはみ出しをクランプする', () => {
    const b = bounds()
    expect(clampPipPosition({ x: -50, y: 300 }, b)).toEqual({ x: b.marginLeft, y: 300 })
    expect(clampPipPosition({ x: 100, y: -50 }, b)).toEqual({ x: 100, y: b.marginTop })
    expect(clampPipPosition({ x: 9999, y: 300 }, b)).toEqual({
      x: b.viewportWidth - b.marginRight - b.tileWidth,
      y: 300,
    })
    expect(clampPipPosition({ x: 100, y: 9999 }, b)).toEqual({
      x: 100,
      y: b.viewportHeight - b.marginBottom - b.tileHeight,
    })
  })

  it('四隅すべて同時にはみ出しても安定してクランプされる', () => {
    const b = bounds()
    expect(clampPipPosition({ x: -999, y: -999 }, b)).toEqual({ x: b.marginLeft, y: b.marginTop })
    expect(clampPipPosition({ x: 9999, y: 9999 }, b)).toEqual({
      x: b.viewportWidth - b.marginRight - b.tileWidth,
      y: b.viewportHeight - b.marginBottom - b.tileHeight,
    })
  })

  it('境界ちょうど（min/max 自体）はクランプされない', () => {
    const b = bounds()
    const maxX = b.viewportWidth - b.marginRight - b.tileWidth
    const maxY = b.viewportHeight - b.marginBottom - b.tileHeight
    expect(clampPipPosition({ x: b.marginLeft, y: b.marginTop }, b)).toEqual({ x: b.marginLeft, y: b.marginTop })
    expect(clampPipPosition({ x: maxX, y: maxY }, b)).toEqual({ x: maxX, y: maxY })
  })

  it('ビューポートが小窓＋マージンより狭い退化ケースでも min>max による破綻が起きない', () => {
    const tiny = bounds({ viewportWidth: 50, viewportHeight: 50 })
    const result = clampPipPosition({ x: 500, y: 500 }, tiny)
    expect(result.x).toBe(tiny.marginLeft)
    expect(result.y).toBe(tiny.marginTop)
    // マイナス方向にはみ出させても同じく marginLeft/marginTop（inverted clamp にならない）
    expect(clampPipPosition({ x: -500, y: -500 }, tiny)).toEqual({ x: tiny.marginLeft, y: tiny.marginTop })
  })
})

describe('nearestPipCorner', () => {
  const b = bounds()

  it('四隅ぴったりの座標はそれぞれ対応する角を返す', () => {
    expect(nearestPipCorner({ x: b.marginLeft, y: b.marginTop }, b)).toBe('top-left')
    expect(nearestPipCorner({ x: b.viewportWidth - b.tileWidth - b.marginRight, y: b.marginTop }, b)).toBe('top-right')
    expect(nearestPipCorner({ x: b.marginLeft, y: b.viewportHeight - b.tileHeight - b.marginBottom }, b)).toBe(
      'bottom-left',
    )
    expect(
      nearestPipCorner(
        { x: b.viewportWidth - b.tileWidth - b.marginRight, y: b.viewportHeight - b.tileHeight - b.marginBottom },
        b,
      ),
    ).toBe('bottom-right')
  })

  it('中心よりわずかに寄っているだけでもその側の角を返す（4 象限の全パターン）', () => {
    const cx = b.viewportWidth / 2 - b.tileWidth / 2
    const cy = b.viewportHeight / 2 - b.tileHeight / 2
    expect(nearestPipCorner({ x: cx - 1, y: cy - 1 }, b)).toBe('top-left')
    expect(nearestPipCorner({ x: cx + 1, y: cy - 1 }, b)).toBe('top-right')
    expect(nearestPipCorner({ x: cx - 1, y: cy + 1 }, b)).toBe('bottom-left')
    expect(nearestPipCorner({ x: cx + 1, y: cy + 1 }, b)).toBe('bottom-right')
  })

  it('ビューポート中心ちょうど（タイブレーク）は既定コーナーと同じ bottom-right に倒す', () => {
    const cx = b.viewportWidth / 2 - b.tileWidth / 2
    const cy = b.viewportHeight / 2 - b.tileHeight / 2
    expect(nearestPipCorner({ x: cx, y: cy }, b)).toBe('bottom-right')
    expect(DEFAULT_PIP_CORNER).toBe('bottom-right')
  })

  it('境界外（クランプ前）の座標でも中心の相対位置だけで判定する', () => {
    expect(nearestPipCorner({ x: -500, y: -500 }, b)).toBe('top-left')
    expect(nearestPipCorner({ x: 9999, y: 9999 }, b)).toBe('bottom-right')
  })
})

describe('resolvePipCornerPosition', () => {
  const b = bounds()
  const corners: PipCorner[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right']

  it('4 隅すべてがマージン通りの座標に解決される（往復整合性：nearestPipCorner で同じ角に戻る）', () => {
    for (const corner of corners) {
      const point = resolvePipCornerPosition(corner, b)
      expect(nearestPipCorner(point, b)).toBe(corner)
    }
  })

  it('top-left は左上マージン、bottom-right は右下マージン', () => {
    expect(resolvePipCornerPosition('top-left', b)).toEqual({ x: b.marginLeft, y: b.marginTop })
    expect(resolvePipCornerPosition('bottom-right', b)).toEqual({
      x: b.viewportWidth - b.marginRight - b.tileWidth,
      y: b.viewportHeight - b.marginBottom - b.tileHeight,
    })
  })

  it('退化ケース（極小ビューポート）でもクランプされて境界内に収まる', () => {
    const tiny = bounds({ viewportWidth: 50, viewportHeight: 50 })
    for (const corner of corners) {
      const result = resolvePipCornerPosition(corner, tiny)
      expect(result.x).toBeGreaterThanOrEqual(tiny.marginLeft)
      expect(result.y).toBeGreaterThanOrEqual(tiny.marginTop)
    }
  })
})

describe('isPipClick / PIP_DRAG_CLICK_THRESHOLD_PX', () => {
  it('閾値定数は 8px（タスク仕様「位移 < 8px 視为点击」）', () => {
    expect(PIP_DRAG_CLICK_THRESHOLD_PX).toBe(8)
  })

  it('0px 〜 7.9px はタップ扱い', () => {
    expect(isPipClick(0, 0)).toBe(true)
    expect(isPipClick(5, 0)).toBe(true)
    expect(isPipClick(0, -5)).toBe(true)
    expect(isPipClick(7.9, 0)).toBe(true)
  })

  it('ちょうど 8px はドラッグ扱い（< 8px の「未満」を厳密に守る）', () => {
    expect(isPipClick(8, 0)).toBe(false)
    expect(isPipClick(0, 8)).toBe(false)
  })

  it('斜め移動はユークリッド距離で判定する（軸ごとは 8px 未満でも合成距離が 8px 以上ならドラッグ）', () => {
    // dx=6, dy=6 → hypot ≈ 8.485 ≥ 8
    expect(isPipClick(6, 6)).toBe(false)
    // dx=5, dy=5 → hypot ≈ 7.07 < 8
    expect(isPipClick(5, 5)).toBe(true)
  })

  it('負方向の移動量も距離として扱う（符号を無視する）', () => {
    expect(isPipClick(-3, -3)).toBe(true)
    expect(isPipClick(-8, 0)).toBe(false)
    expect(isPipClick(0, -8)).toBe(false)
  })
})

describe('parsePipCorner', () => {
  it('4 種の正しい値だけをそのまま通す', () => {
    expect(parsePipCorner('top-left')).toBe('top-left')
    expect(parsePipCorner('top-right')).toBe('top-right')
    expect(parsePipCorner('bottom-left')).toBe('bottom-left')
    expect(parsePipCorner('bottom-right')).toBe('bottom-right')
  })

  it.each([null, undefined, '', 'center', 'BOTTOM-RIGHT', 'top_left', 42, {}, []])(
    '不正値 %j は既定（bottom-right）へ倒す',
    (raw) => {
      expect(parsePipCorner(raw)).toBe(DEFAULT_PIP_CORNER)
    },
  )
})

describe('loadPipCorner / savePipCorner', () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).window
  })

  beforeEach(() => {
    installFakeWindow()
  })

  it('保存した角を読み戻せる（4 択すべて）', () => {
    const corners: PipCorner[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right']
    for (const corner of corners) {
      savePipCorner(corner)
      expect(loadPipCorner()).toBe(corner)
    }
  })

  it('キーは meet. 接頭辞付き（他プロジェクトと同一オリジンを共有しうるため）', () => {
    const store = installFakeWindow()
    savePipCorner('top-left')
    expect(store.get(PIP_CORNER_STORAGE_KEY)).toBe('top-left')
    expect(PIP_CORNER_STORAGE_KEY.startsWith('meet.')).toBe(true)
  })

  it('未保存なら既定（bottom-right＝旧来の固定位置）', () => {
    expect(loadPipCorner()).toBe(DEFAULT_PIP_CORNER)
  })

  it('sessionStorage が例外を投げても既定へ倒す（プライベートブラウジング等）', () => {
    installFakeWindow({
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    })
    expect(loadPipCorner()).toBe(DEFAULT_PIP_CORNER)
    expect(() => savePipCorner('top-left')).not.toThrow()
  })

  it('window が無い（SSR）なら既定のまま、書き込みも何もしない', () => {
    delete (globalThis as Record<string, unknown>).window
    expect(loadPipCorner()).toBe(DEFAULT_PIP_CORNER)
    expect(() => savePipCorner('top-left')).not.toThrow()
  })
})

describe('マージン・遷移時間の既定値（旧固定位置との整合性）', () => {
  it('左右マージンは旧来の `right-3`（12px）と一致する', () => {
    expect(PIP_MARGIN_SIDE_PX).toBe(12)
  })

  it('下辺マージンは旧来の `bottom-[calc(5.25rem+...)]`（5.25rem=84px）と一致する', () => {
    expect(PIP_MARGIN_BOTTOM_PX).toBe(84)
  })

  it('上辺マージンは左右と同じ小さめの余白（上部に常設の遮蔽物が無いため）', () => {
    expect(PIP_MARGIN_TOP_PX).toBe(PIP_MARGIN_SIDE_PX)
  })

  it('既定コーナーで解決した座標は、ドラッグ機能導入前の固定位置と一致する', () => {
    const b = bounds()
    // 旧来の右下固定＝ right: marginRight, bottom: marginBottom 相当
    expect(resolvePipCornerPosition(DEFAULT_PIP_CORNER, b)).toEqual({
      x: b.viewportWidth - PIP_MARGIN_SIDE_PX - b.tileWidth,
      y: b.viewportHeight - PIP_MARGIN_BOTTOM_PX - b.tileHeight,
    })
  })

  it('スナップ遷移は 200ms（タスク仕様「~200ms」）', () => {
    expect(PIP_SNAP_TRANSITION_MS).toBe(200)
  })
})

// ============================================================
// 2026-08-16 実機フィードバック②：モバイル小窓を縦向き（3:4）へ
// ============================================================

describe('pipMobileTileSize（縦向き 3:4 の想定寸法）', () => {
  it('縦横比は 3:4（幅より高さが大きい＝縦長）', () => {
    const size = pipMobileTileSize(375)
    expect(size.height / size.width).toBeCloseTo(PIP_MOBILE_ASPECT_HEIGHT / PIP_MOBILE_ASPECT_WIDTH, 10)
    expect(size.height).toBeGreaterThan(size.width)
  })

  it('狭い端末では 28vw で縮む（iPhone SE 375px → 105px）', () => {
    const size = pipMobileTileSize(375)
    expect(size.width).toBeCloseTo(375 * PIP_MOBILE_VIEWPORT_WIDTH_RATIO, 10)
    expect(size.width).toBeCloseTo(105, 10)
    expect(size.height).toBeCloseTo(140, 10)
  })

  it('大きい端末でも幅は 128px で頭打ち（高さも 4/3 でそれに従う）', () => {
    const size = pipMobileTileSize(1024)
    expect(size.width).toBe(PIP_MOBILE_MAX_WIDTH_PX)
    expect(size.height).toBeCloseTo((PIP_MOBILE_MAX_WIDTH_PX * 4) / 3, 10)
  })

  it('Tailwind クラス文字列と数値が食い違っていない（レイアウトと計算の事実源をひとつに保つ）', () => {
    // 0.28 * 100 は浮動小数で 28.000000000000004 になるので四捨五入してから比べる
    const vw = Math.round(PIP_MOBILE_VIEWPORT_WIDTH_RATIO * 100)
    expect(PIP_MOBILE_SIZE_CLASS).toContain(`w-[min(${vw}vw,${PIP_MOBILE_MAX_WIDTH_PX}px)]`)
    expect(PIP_MOBILE_SIZE_CLASS).toContain(`aspect-[${PIP_MOBILE_ASPECT_WIDTH}/${PIP_MOBILE_ASPECT_HEIGHT}]`)
    // デスクトップは 16:9・160px のまま（今回の変更をデスクトップへ漏らさない）
    expect(PIP_DESKTOP_SIZE_CLASS).toContain('md:aspect-video')
    expect(PIP_DESKTOP_SIZE_CLASS).toContain('md:w-40')
  })
})

describe('縦長になった小窓とクランプ／吸着の連動', () => {
  /** 375×812 の端末で 3:4 の小窓（105×140）を使った実際の境界。 */
  function portraitBounds(): PipBounds {
    const size = pipMobileTileSize(375)
    return {
      viewportWidth: 375,
      viewportHeight: 812,
      tileWidth: size.width,
      tileHeight: size.height,
      marginTop: PIP_MARGIN_TOP_PX,
      marginRight: PIP_MARGIN_SIDE_PX,
      marginBottom: PIP_MARGIN_BOTTOM_PX,
      marginLeft: PIP_MARGIN_SIDE_PX,
    }
  }

  it('下方向のクランプは新しい（背が高い）高さを差し引く＝ドックに被らない', () => {
    const b = portraitBounds()
    const clamped = clampPipPosition({ x: 100, y: 9999 }, b)
    expect(clamped.y).toBe(812 - PIP_MARGIN_BOTTOM_PX - b.tileHeight)
    // 16:9（59px）のままの計算だと 81px ぶん下にずれてドックへ潜り込む
    expect(clamped.y).toBeLessThan(812 - PIP_MARGIN_BOTTOM_PX - 59)
  })

  it('4 隅すべてが画面内に収まる（縦長にしてもはみ出さない）', () => {
    const b = portraitBounds()
    for (const corner of ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const) {
      const point = resolvePipCornerPosition(corner, b)
      expect(point.x).toBeGreaterThanOrEqual(b.marginLeft)
      expect(point.y).toBeGreaterThanOrEqual(b.marginTop)
      expect(point.x + b.tileWidth).toBeLessThanOrEqual(b.viewportWidth - b.marginRight)
      expect(point.y + b.tileHeight).toBeLessThanOrEqual(b.viewportHeight - b.marginBottom)
    }
  })

  it('吸着判定は縦長の中心で行われる（4 隅すべて往復整合する）', () => {
    const b = portraitBounds()
    for (const corner of ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const) {
      expect(nearestPipCorner(resolvePipCornerPosition(corner, b), b)).toBe(corner)
    }
  })
})
