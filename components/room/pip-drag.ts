/**
 * 本地プレビュー小窓（画中画）のドラッグ＆四隅スナップ（2026-08-16 実機フィードバック
 * 「Zoom みたいに小窓を好きな位置へ動かしたい」）。
 *
 * components/room/video-fit.ts と同じ方針：React にも DOM にも依存しない純関数群を
 * ここに集め、座標計算・クランプ・最近接コーナー判定・sessionStorage の入出力を
 * すべてテストで固定する（LocalPreviewTile.tsx はこれらを呼び出すだけの薄い層にする）。
 *
 * ============ 座標モデル ============
 * 永続化するのは**スナップ先のコーナー**（4 択の enum）だけで、生のピクセル座標は
 * 保存しない——タスク要件「松手后吸附到最近的四角」＝静止状態は常に 4 択のどれかで、
 * 任意の自由位置に留まることはない（video-fit の 2 択トグルと同じ「離散状態のみ保存」
 * という考え方）。ドラッグ中の追従だけがピクセル単位の連続値（PipPoint）を必要とする。
 *
 * ============ マージンの出どころ ============
 * PIP_MARGIN_SIDE_PX / PIP_MARGIN_BOTTOM_PX は、このドラッグ機能を作る前の
 * LocalPreviewTile の固定位置（`right-3` = 12px、`bottom-[calc(5.25rem+...)]` = 84px）と
 * 意図的に一致させてある——ドラッグを一度も使わなければ「四隅スナップ導入前と
 * 見た目が 1px も変わらない」を保証するため。安全区（notch／ホームインジケータ）は
 * 呼び出し側（LocalPreviewTile）が `env(safe-area-inset-*)` の実測値を足して
 * `PipBounds.marginTop` / `marginBottom` に織り込む——この純関数側は「マージンは
 * 呼び出し側が計算済みの数値」として受け取るだけで、env() 自体は一切知らない
 * （DOM 非依存の原則を保つ）。
 */

export type PipCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

export interface PipPoint {
  x: number
  y: number
}

/**
 * ドラッグ境界の計算に必要な実測値。呼び出し側（LocalPreviewTile）が
 * `window.innerWidth/innerHeight` と `getBoundingClientRect()` から都度組み立てる。
 */
export interface PipBounds {
  viewportWidth: number
  viewportHeight: number
  /** 小窓自身の幅・高さ（測定値。レスポンシブ幅 `min(28vw,128px)` のため定数にできない）。 */
  tileWidth: number
  tileHeight: number
  /** 上辺の予約マージン（ステータスバー／ノッチの safe-area を含む実効値）。 */
  marginTop: number
  marginRight: number
  /** 下辺の予約マージン（コントロールドックの高さ＋ホームインジケータの safe-area を含む実効値）。 */
  marginBottom: number
  marginLeft: number
}

export const PIP_CORNER_STORAGE_KEY = 'meet.pipCorner'

/** 既定＝ドラッグ機能導入前の固定位置と同じ右下。 */
export const DEFAULT_PIP_CORNER: PipCorner = 'bottom-right'

/** 移動量がこの値未満ならドラッグではなくタップ（クリック）とみなす判定閾値（タスク仕様）。 */
export const PIP_DRAG_CLICK_THRESHOLD_PX = 8

/** スナップ時の遷移時間（タスク仕様「~200ms」）。 */
export const PIP_SNAP_TRANSITION_MS = 200

/** 左右の既定マージン。旧固定位置の `right-3`（0.75rem）と一致させる。 */
export const PIP_MARGIN_SIDE_PX = 12

/** 上辺の既定マージン。上部には（LocaleSwitcher はモバイルで非表示のため）常設の
 *  遮蔽物が無いので、左右と同じ小さめの余白のみ（＋呼び出し側が safe-area-inset-top を加算）。 */
export const PIP_MARGIN_TOP_PX = 12

/** 下辺の既定マージン。旧固定位置の `bottom-[calc(5.25rem+...)]`（5.25rem=84px）と一致させる
 *  ＝コントロールドックの上に出ていた既存の位置をそのままスナップ先として引き継ぐ
 *  （＋呼び出し側が safe-area-inset-bottom を加算）。 */
export const PIP_MARGIN_BOTTOM_PX = 84

/**
 * (x, y) を許容範囲内へクランプする（純関数）。
 *
 * ビューポートが小窓＋マージンより狭い退化ケース（極端に小さい画面・回転直後の過渡状態）
 * でも `maxX >= minX` / `maxY >= minY` を `Math.max` で保証し、クランプ結果が
 * 不安定にならないようにする（min > max のまま Math.min/Math.max へ渡すと直感に反する
 * 値になりうるため）。
 */
export function clampPipPosition(point: PipPoint, bounds: PipBounds): PipPoint {
  const minX = bounds.marginLeft
  const maxX = Math.max(minX, bounds.viewportWidth - bounds.marginRight - bounds.tileWidth)
  const minY = bounds.marginTop
  const maxY = Math.max(minY, bounds.viewportHeight - bounds.marginBottom - bounds.tileHeight)
  return {
    x: Math.min(Math.max(point.x, minX), maxX),
    y: Math.min(Math.max(point.y, minY), maxY),
  }
}

/**
 * 指定座標（小窓の左上）に最も近い角を求める（純関数）。
 *
 * 判定は「小窓の中心」対「ビューポートの中心」の左右・上下関係だけで行う——
 * 4 隅までの厳密な距離を測るまでもなく、中心がどちらの半分にいるかだけで
 * Zoom と同じ体感の吸着になる（実装も検証もシンプルになる）。
 * ちょうど中心線上（タイブレーク）は bottom-right 側に倒す——既定コーナーと同じ側に
 * 倒すことで「迷ったときの挙動」を既定位置と一貫させる。
 */
export function nearestPipCorner(point: PipPoint, bounds: PipBounds): PipCorner {
  const centerX = point.x + bounds.tileWidth / 2
  const centerY = point.y + bounds.tileHeight / 2
  const isLeft = centerX < bounds.viewportWidth / 2
  const isTop = centerY < bounds.viewportHeight / 2
  if (isTop && isLeft) return 'top-left'
  if (isTop && !isLeft) return 'top-right'
  if (!isTop && isLeft) return 'bottom-left'
  return 'bottom-right'
}

/** 角 → 実座標（クランプ済み）。マージン通りにその角へぴったり収まる位置を返す。 */
export function resolvePipCornerPosition(corner: PipCorner, bounds: PipBounds): PipPoint {
  const x =
    corner === 'top-left' || corner === 'bottom-left'
      ? bounds.marginLeft
      : bounds.viewportWidth - bounds.marginRight - bounds.tileWidth
  const y =
    corner === 'top-left' || corner === 'top-right'
      ? bounds.marginTop
      : bounds.viewportHeight - bounds.marginBottom - bounds.tileHeight
  return clampPipPosition({ x, y }, bounds)
}

/** 総移動量（絶対値の距離）がドラッグ判定閾値未満か＝タップ扱いにしてよいか。 */
export function isPipClick(totalDx: number, totalDy: number): boolean {
  return Math.hypot(totalDx, totalDy) < PIP_DRAG_CLICK_THRESHOLD_PX
}

// ============================================================
// モバイル小窓の寸法（2026-08-16 実機フィードバック②「自撮り窓を縦向きに」）
// ============================================================

/**
 * モバイル小窓の**縦横比 3:4（縦長）**。スマホのインカメラは縦持ちで使うのが普通なので、
 * 16:9 の横長窓だと自分の顔の上下が切れる（`object-cover` は中央基準で切る）。
 * 幅の基準（`min(28vw, 128px)`）は 2026-08-14 の調整から据え置き、高さだけを `幅 × 4/3` にする。
 *
 * ⚠️ 数値と Tailwind クラス文字列（{@link PIP_MOBILE_SIZE_CLASS}）は**必ず一致させる**こと。
 * 実際のレイアウトはクラス側が決め、この数値はクランプ／吸着計算の**フォールバック**
 * （実測できない一瞬）に使われる——ズレると「初回描画の位置だけおかしい」という
 * 再現しにくいバグになる。tests/ui/pip-drag.test.ts が両者の整合を機械的に確認する。
 */
export const PIP_MOBILE_ASPECT_WIDTH = 3;
export const PIP_MOBILE_ASPECT_HEIGHT = 4;

/** 幅の上限（px）。大画面のスマホでも小窓は 128px で頭打ち。 */
export const PIP_MOBILE_MAX_WIDTH_PX = 128;

/** 幅のビューポート比（`28vw`）。狭い端末では画面比で縮む。 */
export const PIP_MOBILE_VIEWPORT_WIDTH_RATIO = 0.28;

/**
 * 小窓の寸法クラス。**Tailwind の JIT はソース文字列を走査する**ので、ここに
 * リテラルで置いておけば `lib/**`・`components/**` を content に含む
 * tailwind.config.ts がそのまま拾う（LocalPreviewTile 側で組み立てない理由）。
 * デスクトップ（md 以上）は従来どおり 16:9・160px 幅に戻す。
 */
export const PIP_MOBILE_SIZE_CLASS = 'w-[min(28vw,128px)] aspect-[3/4]';
export const PIP_DESKTOP_SIZE_CLASS = 'md:w-40 md:aspect-video';

/**
 * ビューポート幅から小窓の想定寸法を求める（純関数）。
 * `getBoundingClientRect()` がまだ 0 を返す一瞬（初回描画前・非表示中）の
 * フォールバックとして使う——0 のまま `resolvePipCornerPosition` に渡すと、
 * 右下コーナーの座標が小窓の幅ぶんズレて画面外に出る。
 */
export function pipMobileTileSize(viewportWidth: number): { width: number; height: number } {
  const width = Math.min(viewportWidth * PIP_MOBILE_VIEWPORT_WIDTH_RATIO, PIP_MOBILE_MAX_WIDTH_PX);
  return { width, height: (width * PIP_MOBILE_ASPECT_HEIGHT) / PIP_MOBILE_ASPECT_WIDTH };
}

/** 保存値のパース。4 択以外（欠損・壊れた値）は既定へ倒す（video-fit.ts の parseVideoFit と同じ作法）。 */
export function parsePipCorner(raw: unknown): PipCorner {
  return raw === 'top-left' || raw === 'top-right' || raw === 'bottom-left' || raw === 'bottom-right'
    ? raw
    : DEFAULT_PIP_CORNER
}

/**
 * sessionStorage から読む（セッション限り＝タブを閉じれば忘れる。video-fit.ts の
 * VIDEO_FIT_STORAGE_KEY と同じ粒度判断——「今この会議室でのお好みの置き場所」であって、
 * 次回の会議に持ち越す設定ではない）。SSR・例外時は既定へ倒すだけで落とさない。
 */
export function loadPipCorner(): PipCorner {
  if (typeof window === 'undefined') return DEFAULT_PIP_CORNER
  try {
    return parsePipCorner(window.sessionStorage.getItem(PIP_CORNER_STORAGE_KEY))
  } catch {
    return DEFAULT_PIP_CORNER
  }
}

/** sessionStorage へ書く。失敗しても黙って諦める（表示位置ごときで画面を落とさない）。 */
export function savePipCorner(corner: PipCorner): void {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.setItem(PIP_CORNER_STORAGE_KEY, corner)
  } catch {
    // ignore
  }
}
