'use client'

import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react'
import { Avatar } from '@heroui/react'
import type { LocalState, MediaProvider } from '@/lib/media/types'
import type { UiTextDict } from '@/lib/ui-text'
import { MicOffIcon } from '@/components/icons'
import { initialsOf } from '@/components/display-name'
import {
  clampPipPosition,
  DEFAULT_PIP_CORNER,
  isPipClick,
  loadPipCorner,
  nearestPipCorner,
  PIP_DESKTOP_SIZE_CLASS,
  PIP_MARGIN_BOTTOM_PX,
  PIP_MARGIN_SIDE_PX,
  PIP_MARGIN_TOP_PX,
  PIP_MOBILE_SIZE_CLASS,
  PIP_SNAP_TRANSITION_MS,
  pipMobileTileSize,
  resolvePipCornerPosition,
  savePipCorner,
  type PipBounds,
  type PipCorner,
  type PipPoint,
} from './pip-drag'
import { useIsMobileRoomLayout } from './useIsMobileRoomLayout'

/**
 * `env(safe-area-inset-*)` を JS の数値として読む（一時プローブ要素を挿して
 * `getComputedStyle` で測る、既知の手法）。ドラッグ境界のクランプにだけ使う——
 * 静止位置は下の JSX で `calc(...+env(...))` を直接 CSS へ書くので、そちらは
 * この関数に依存しない（既存の `bottom-[calc(5.25rem_+_env(safe-area-inset-bottom,0px))]`
 * と同じ考え方）。失敗しても 0 を返すだけ（ドラッグ境界が数 px 甘くなるだけで致命的ではない）。
 */
function readSafeAreaInsetPx(side: 'top' | 'bottom'): number {
  if (typeof document === 'undefined') return 0
  try {
    const probe = document.createElement('div')
    probe.style.position = 'fixed'
    probe.style.visibility = 'hidden'
    probe.style.pointerEvents = 'none'
    probe.style.height = '0px'
    probe.style.width = '0px'
    if (side === 'top') probe.style.paddingTop = 'env(safe-area-inset-top, 0px)'
    else probe.style.paddingBottom = 'env(safe-area-inset-bottom, 0px)'
    document.body.appendChild(probe)
    const computed = getComputedStyle(probe)
    const raw = side === 'top' ? computed.paddingTop : computed.paddingBottom
    document.body.removeChild(probe)
    return Number.parseFloat(raw) || 0
  } catch {
    return 0
  }
}

/**
 * 自分のプレビュー小窓（規格書 §7：「本地画面小窓」）。メイングリッドには含めず、
 * 右下に固定フロート表示する。§12.6 の attach/detach 対を local 版でも守る。
 *
 * 2026-08-14：モバイル（<md）専用のサイズ・位置調整（実機フィードバック）。
 *  - 幅：`min(28vw, 128px)`——狭い端末では画面比で縮み、大きい端末では 128px で頭打ち。
 *  - 位置：コントロールドックが背が高くなった（触控目标 44px 化）ぶん、ドックの上に
 *    出るよう bottom オフセットを底上げする。安全区の calc() は Tailwind の JIT が
 *    そのまま処理する組み込みの arbitrary value（`bottom-[...]`）——globals.css の
 *    カスタムユーティリティを使わないのは、md: の上書きと同じプロパティを競合させて
 *    カスケード順に頼るリスクを避けるため（詳細は最終レポート）。
 *  - md 以上（デスクトップ）：旧来の `bottom-24 right-4 w-32 sm:w-40` と実質同じ見た目
 *    （sm ブレークポイントは本タスクで room 全体の統一しきい値 md に一本化したので、
 *    実際のデスクトップ幅（≥768px）では従来どおり w-40=160px になる）。
 *
 * 2026-08-16：モバイルのみドラッグ＆四隅スナップを追加（Zoom 式、実機フィードバック）。
 *  - デスクトップは完全に無改动——`isMobile` が false の間は `mobilePositionStyle` が
 *    `undefined` のままなので、旧来の Tailwind クラス（`md:bottom-24 md:right-4`）だけが
 *    効く。ドラッグの座標計算・クランプ・最近接コーナー判定は ./pip-drag.ts の純関数
 *    （フルカバレッジのテスト付き）。ここでは DOM 計測とポインタイベントの配線だけを行う。
 *  - 未計測の間（SSR・マウント直後の一瞬）は `restPoint` が null のままなので、
 *    下の Tailwind クラス（`right-3 bottom-[calc(...)]`）がフォールバックとして効く
 *    ——JS 計測前に位置が破綻しない安全網（video-fit や useIsMobileRoomLayout と同じ
 *    hydration-safe な考え方）。
 *  - アクセシビリティ：キーボードでの移動手段は用意しない（タスク要件で明示的に許容）。
 *    ドラッグを一度も使わなくても、この小窓は常に画面内の既定位置（右下）に留まり続ける
 *    ので「ドラッグできないと使えない」状態にはならない——静止位置そのものが兜底。
 *
 * 2026-08-16 第 2 波（実機②「ドラッグがカクつく」「自撮り窓を縦向きに」）：
 *  - **追従は ref 直駆**。旧実装は pointermove ごとに `setDragPoint` していたため、
 *    指 1 本の移動で RoomExperience 配下のツリーが毎フレーム再レンダーされていた
 *    （このタイルは memo 化されておらず、親は参加者イベントでも再描画される）。
 *    今は `left`/`top` を**静止座標だけ**に使い、追従中は `style.transform` を
 *    直接書く——React の再レンダーはドラッグ 1 回につき**松手時の 1 回だけ**。
 *    ⚠️ `style` プロパティに transform / transition を**入れない**のが要点：
 *    React のスタイル差分は「前回の style オブジェクトに無いキー」を触らないので、
 *    親の再レンダーが起きても手書きした transform は消えない。
 *  - 吸着は transform のまま行い、`left/top` を新コーナーへ移す差分をその場で
 *    transform で相殺してから 0 へ戻す（下の endDrag 参照）。left/top と transform を
 *    別々に動かすと 1 フレーム分の飛びが見えるため。
 *  - 小窓の縦横比はモバイルのみ 3:4（縦長）。クランプ／吸着は実測した高さで動くので
 *    純関数側の変更は不要だが、**実測できない一瞬**のためのフォールバック寸法だけ
 *    ./pip-drag.ts の `pipMobileTileSize()` に持たせてある。
 */
export function LocalPreviewTile({
  provider,
  displayName,
  localState,
  text,
}: {
  provider: MediaProvider
  displayName: string
  localState: LocalState
  text: UiTextDict
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const isMobile = useIsMobileRoomLayout()

  useEffect(() => {
    const el = videoRef.current
    if (!el) return
    provider.attachLocalVideo(el)
    return () => provider.detachLocalVideo()
  }, [provider])

  // ---- ドラッグ＆四隅スナップ（2026-08-16）----
  // corner は「今どの角に居るか」の唯一の事実源。state ではなく ref に持つのは、
  // resize/orientationchange ハンドラから常に最新値を読みたいだけで、corner の変化
  // そのものは画面に直接描画しない（描画を駆動するのは restPoint）ため——
  // state にすると変化のたびに resize effect を張り直す／古い closure を掴む面倒が増える。
  const cornerRef = useRef<PipCorner>(DEFAULT_PIP_CORNER)
  /** 静止位置（クランプ済みピクセル座標）。null の間は Tailwind クラスのフォールバックが効く。 */
  const [restPoint, setRestPoint] = useState<PipPoint | null>(null)
  /**
   * ドラッグ中のセッション。**state ではなく ref**——追従中は 1 回も再レンダーしない
   * のがこの実装の要点（ファイル冒頭 2026-08-16 第 2 波の注記）。
   * `bounds` は掴んだ瞬間に 1 回だけ測って固定する：pointermove ごとに
   * `getBoundingClientRect()` を読むと、直前に書いた transform とのあいだで
   * 強制同期レイアウト（layout thrashing）が発生してカクつきの原因になる。
   */
  const dragRef = useRef<{
    pointerId: number
    startClientX: number
    startClientY: number
    /** 掴んだ瞬間の見た目の左上（追従の起点） */
    originX: number
    originY: number
    /** そのとき left/top に効いていた静止座標（transform の原点） */
    baseX: number
    baseY: number
    bounds: PipBounds
    /** 現在の絶対座標（クランプ済み）。松手時の吸着判定に使う */
    point: PipPoint
  } | null>(null)
  /** 吸着アニメーションの後片付け用（rAF と後始末タイマー）。 */
  const snapFrameRef = useRef<number | null>(null)
  const snapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function measureBounds(): PipBounds | null {
    const el = containerRef.current
    if (!el || typeof window === 'undefined') return null
    const rect = el.getBoundingClientRect()
    // 実測できない一瞬（初回描画前など rect が 0）は想定寸法へ倒す。0 のまま
    // コーナー座標を解くと、小窓の幅・高さぶんだけ画面外にはみ出した位置になる。
    const fallback = pipMobileTileSize(window.innerWidth)
    return {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      tileWidth: rect.width > 0 ? rect.width : fallback.width,
      tileHeight: rect.height > 0 ? rect.height : fallback.height,
      marginTop: PIP_MARGIN_TOP_PX + readSafeAreaInsetPx('top'),
      marginRight: PIP_MARGIN_SIDE_PX,
      marginBottom: PIP_MARGIN_BOTTOM_PX + readSafeAreaInsetPx('bottom'),
      marginLeft: PIP_MARGIN_SIDE_PX,
    }
  }

  /** 追従・吸着で書いた手書きスタイルを消す（React の style プロパティは触らない）。 */
  function clearImperativeTransform(): void {
    const el = containerRef.current
    if (!el) return
    el.style.transition = ''
    el.style.transform = ''
  }

  function cancelSnapAnimation(): void {
    if (snapFrameRef.current !== null) {
      cancelAnimationFrame(snapFrameRef.current)
      snapFrameRef.current = null
    }
    if (snapTimerRef.current !== null) {
      clearTimeout(snapTimerRef.current)
      snapTimerRef.current = null
    }
  }

  // モバイル判定が付いた直後・画面回転／リサイズのたびに、保存済みコーナーから実座標を
  // 引き直す。isMobile が false に戻ったら restPoint を捨てて Tailwind の固定位置へ戻す
  // （デスクトップは常にこの effect の外＝無改动）。
  useEffect(() => {
    if (!isMobile) {
      setRestPoint(null)
      // デスクトップへ戻ると React は style プロパティを外すが、手書きの
      // transform / transition は React の管理外なので明示的に消す。
      cancelSnapAnimation()
      clearImperativeTransform()
      return
    }
    cornerRef.current = loadPipCorner()

    function recompute() {
      // ドラッグ中は触らない：iOS Safari はツールバーの出入りでも resize を投げるので、
      // ここで restPoint を書き換えると指の下で小窓が飛ぶ。
      if (dragRef.current) return
      const bounds = measureBounds()
      if (!bounds) return
      setRestPoint(resolvePipCornerPosition(cornerRef.current, bounds))
    }
    recompute()

    window.addEventListener('resize', recompute)
    window.addEventListener('orientationchange', recompute)
    return () => {
      window.removeEventListener('resize', recompute)
      window.removeEventListener('orientationchange', recompute)
    }
  }, [isMobile])

  // アンマウント時に走りかけの rAF / タイマーを畳む（会議を抜けた後に発火させない）。
  useEffect(() => {
    return () => cancelSnapAnimation()
  }, [])

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!isMobile) return
    const el = containerRef.current
    if (!el) return
    const bounds = measureBounds()
    if (!bounds) return
    // 吸着アニメの途中で掴まれた場合、後片付けが後から走ると手書きスタイルを消されるので先に畳む。
    cancelSnapAnimation()

    // 「見た目の位置」（アニメ途中でも正しい）と「left/top に効いている静止座標」を分けて持つ。
    const rect = el.getBoundingClientRect()
    const base = restPoint ?? resolvePipCornerPosition(cornerRef.current, bounds)
    // まだ Tailwind クラスで位置決めしていた場合はここで fixed 座標へ移行する
    // （transform で差分を相殺するので、見た目は 1px も動かない）。
    if (!restPoint) setRestPoint(base)

    el.style.transition = 'none'
    el.style.transform = `translate3d(${rect.left - base.x}px, ${rect.top - base.y}px, 0)`

    dragRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      originX: rect.left,
      originY: rect.top,
      baseX: base.x,
      baseY: base.y,
      bounds,
      point: { x: rect.left, y: rect.top },
    }
    try {
      el.setPointerCapture(event.pointerId)
    } catch {
      // 一部の古い実装で setPointerCapture が例外を投げても、以降は通常の
      // pointermove/pointerup で追従できるので致命的ではない。
    }
  }

  /**
   * 追従。**setState を一切呼ばない**——ここで再レンダーを起こさないことが
   * 「ドラッグを滑らかにする」の実体（回帰は tests/room/ios-layout-guards.test.ts が見張る）。
   */
  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current
    if (!drag || event.pointerId !== drag.pointerId) return
    const el = containerRef.current
    if (!el) return
    const point = clampPipPosition(
      {
        x: drag.originX + (event.clientX - drag.startClientX),
        y: drag.originY + (event.clientY - drag.startClientY),
      },
      drag.bounds,
    )
    drag.point = point
    el.style.transform = `translate3d(${point.x - drag.baseX}px, ${point.y - drag.baseY}px, 0)`
  }

  function endDrag(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current
    if (!drag || event.pointerId !== drag.pointerId) return
    dragRef.current = null
    const el = containerRef.current
    try {
      if (el?.hasPointerCapture(event.pointerId)) el.releasePointerCapture(event.pointerId)
    } catch {
      // ignore：解放できなくても致命的ではない（ブラウザが暗黙に解放する）
    }

    const totalDx = event.clientX - drag.startClientX
    const totalDy = event.clientY - drag.startClientY
    // 移動量 8px 未満はタップ扱い（誤操作防止）＝コーナーを変えず、掴む前の位置へ戻すだけ。
    if (!isPipClick(totalDx, totalDy)) {
      const nextCorner = nearestPipCorner(drag.point, drag.bounds)
      cornerRef.current = nextCorner
      savePipCorner(nextCorner)
    }
    const target = resolvePipCornerPosition(cornerRef.current, drag.bounds)

    // ① 静止座標（left/top）を吸着先へ移す。この setState がドラッグ 1 回あたり唯一の再レンダー。
    setRestPoint(target)
    if (!el) return
    // ② 見た目が飛ばないよう、①の差分をその場で transform に移し替える
    //    （React の commit は paint より前なので、途中の状態は描画されない）。
    el.style.transition = 'none'
    el.style.transform = `translate3d(${drag.point.x - target.x}px, ${drag.point.y - target.y}px, 0)`
    // ③ 次フレームで transform を 0 へ戻す＝「今の位置 → コーナー」へ滑らかに吸着。
    snapFrameRef.current = requestAnimationFrame(() => {
      snapFrameRef.current = null
      const node = containerRef.current
      if (!node) return
      node.style.transition = `transform ${PIP_SNAP_TRANSITION_MS}ms ease-out`
      node.style.transform = 'translate3d(0px, 0px, 0)'
      // ④ 終わったら手書きスタイルを消して素の状態に戻す（次のドラッグの前提を汚さない）。
      snapTimerRef.current = setTimeout(() => {
        snapTimerRef.current = null
        clearImperativeTransform()
      }, PIP_SNAP_TRANSITION_MS + 50)
    })
  }

  // ⚠️ transform / transition は**入れない**：React のスタイル差分が手書きの値を
  // 消さないようにするため（ファイル冒頭の注記）。ここが持つのは静止座標だけ。
  const mobilePositionStyle: CSSProperties | undefined =
    isMobile && restPoint
      ? {
          position: 'fixed',
          left: `${restPoint.x}px`,
          top: `${restPoint.y}px`,
          right: 'auto',
          bottom: 'auto',
        }
      : undefined

  return (
    <div
      ref={containerRef}
      onPointerDown={isMobile ? handlePointerDown : undefined}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      style={mobilePositionStyle}
      className={`absolute right-3 z-10 ${PIP_MOBILE_SIZE_CLASS} ${PIP_DESKTOP_SIZE_CLASS} bottom-[calc(5.25rem_+_env(safe-area-inset-bottom,0px))] md:bottom-24 md:right-4 ${
        isMobile ? 'pointer-events-auto touch-none select-none will-change-transform' : 'pointer-events-none'
      }`}
    >
      <div className="relative h-full w-full overflow-hidden rounded-xl bg-zinc-800 shadow-lg ring-1 ring-zinc-700">
        <video
          ref={videoRef}
          playsInline
          autoPlay
          muted
          className={`h-full w-full scale-x-[-1] object-cover ${localState.videoEnabled ? '' : 'hidden'}`}
        />
        {!localState.videoEnabled && (
          <div className="flex h-full w-full items-center justify-center">
            <Avatar name={initialsOf(displayName)} className="h-10 w-10" />
          </div>
        )}
        <div className="absolute inset-x-0 bottom-0 flex items-center justify-between bg-gradient-to-t from-black/70 to-transparent px-1.5 py-1">
          <span className="truncate text-[11px] text-white">{text.room.you}</span>
          {!localState.audioEnabled && (
            <span title={text.room.muted}>
              <MicOffIcon className="h-3.5 w-3.5 text-white/90" />
              <span className="sr-only">{text.room.muted}</span>
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
