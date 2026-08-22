'use client'

import { useEffect, useRef } from 'react'
import { Avatar, Button, Tooltip } from '@heroui/react'
import type { MediaProvider, RemoteParticipant } from '@/lib/media/types'
import type { UiTextDict } from '@/lib/ui-text'
import { MicIcon, MicOffIcon } from '@/components/icons'
import { initialsOf } from '@/components/display-name'
import { QualityDot } from './QualityDot'
import { speakingOverlayClass, TILE_CONTAINER_CLASS, TILE_CONTAINER_FILL_CLASS } from './speaking-highlight'
import { useReducedMotion } from './useReducedMotion'
import { videoFitClass, type VideoFit } from './video-fit'

/** 主催者だけに渡す遠隔ミュート操作（guest には undefined を渡す＝ボタン自体が描画されない）。 */
export interface TileHostControls {
  /** 現在リクエスト中の identity（そのタイルのボタンだけ loading にする） */
  pendingIdentity: string | null
  /** 押下 → POST /api/rooms/{id}/participants/mute。muted は「これから設定したい状態」。 */
  onToggleMute: (participant: RemoteParticipant) => void
}

/**
 * 遠端参加者タイル。§12.6 の鉄則：`attachRemoteVideo` / `detachRemoteVideo` は
 * useEffect の対で必ずペアにする（cleanup で detach）。id が変わるたび
 * 古い id を detach してから新しい id を attach し直す。
 */
export function ParticipantTile({
  provider,
  participant,
  isSpeaking,
  hostControls,
  text,
  fill = false,
  objectFit = 'cover',
  onToggleFit,
}: {
  provider: MediaProvider
  participant: RemoteParticipant
  isSpeaking: boolean
  hostControls?: TileHostControls
  text: UiTextDict
  /**
   * true = モバイルの満屏/宮格用（2026-08-14）。`aspect-video` を持たず親のサイズを
   * そのまま埋める——縦長画面で 16:9 の箱を強制すると上下に大きな余白ができるのを
   * 避ける。既定 false（デスクトップの既存グリッド、無改动）。
   */
  fill?: boolean
  /**
   * 映像の収め方（2026-08-14 第 2 波）。既定の `cover` は縦画面で左右が切れる代わりに
   * 没入感が高い。`contain` は上下に黒帯が出るが 16:9 の合成画面が丸ごと見える
   * ——相手がバーチャル背景を使っているときに「背景が全部見えない」を解消するための逃げ道。
   * 詳細と「送信側の切り落としは直せない」という境界は ./video-fit.ts のファイル冒頭。
   */
  objectFit?: VideoFit
  /**
   * 渡されたときだけ、映像領域のタップで objectFit を切り替える透明ボタンを敷く。
   * VideoGrid はモバイルの**満屏（タイル 1 枚）**のときだけ渡す——宮格でタイルごとに
   * 収め方が変わると何を押したのか分からなくなるため。
   */
  onToggleFit?: () => void
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const reducedMotion = useReducedMotion()

  useEffect(() => {
    const el = videoRef.current
    if (!el) return
    provider.attachRemoteVideo(participant.id, el)
    return () => provider.detachRemoteVideo(participant.id)
  }, [provider, participant.id])

  const muteLabel = participant.audioEnabled ? text.mute.muteParticipant : text.mute.unmuteParticipant

  return (
    <div className={fill ? TILE_CONTAINER_FILL_CLASS : TILE_CONTAINER_CLASS}>
      {/* ⚠️ `playsInline` と `muted` は必須（削除禁止・tests/room/video-attrs.test.ts が固定）：
          playsInline が無いと iOS Safari は再生を全画面に乗っ取り、一部の Android WebView は
          そもそも再生を拒否する（＝実機の「真っ黒」の一因になりうる）。remote 側の muted は
          二重再生の防止——遠端音声は provider 内部の隠し <audio> が鳴らしている（provider の
          ファイル冒頭 3）ので、こちらでも鳴らすとエコーになる。 */}
      <video
        ref={videoRef}
        playsInline
        autoPlay
        muted
        className={`h-full w-full ${videoFitClass(objectFit)} ${participant.videoEnabled ? '' : 'hidden'}`}
      />
      {!participant.videoEnabled && (
        <Avatar name={initialsOf(participant.name)} className="h-14 w-14 text-large sm:h-16 sm:w-16" />
      )}

      {/* 映像領域のタップで cover ⇄ contain（モバイル満屏のみ／VideoGrid が判断して渡す）。
          ホストのミュートボタン（z-10）と発言中リング（pointer-events-none）より下、
          映像より上の z-[1] に敷く——**兄弟**なのでミュートボタンへのタップがここに
          バブリングして誤爆することはない。下端の名前バーは DOM 順で後ろ＝上に重なるので、
          そこはタップの不感帯になる（コントロールドックに近い場所での誤タップ防止にもなる）。 */}
      {onToggleFit && (
        <button
          type="button"
          aria-label={text.room.toggleVideoFit}
          onClick={onToggleFit}
          className="absolute inset-0 z-[1] cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/70"
        />
      )}
      {/* 発言中リングは**映像を含まない専用オーバーレイ**に載せる。コンテナ側に
          animate-pulse を付けると（＝以前の実装）pulse の opacity 往復が子の <video> にも
          効いてしまい、相手が喋るたびに映像が明滅した（実機で報告された不具合）。
          詳細と回帰テストは components/room/speaking-highlight.ts。 */}
      {isSpeaking && <div aria-hidden className={speakingOverlayClass(reducedMotion)} />}
      {isSpeaking && <span className="sr-only">{text.room.speaking}</span>}

      {/* 主催者のみ：右上に遠隔ミュートのトグル。タッチ端末では常時表示、
          デスクトップ（md 以上）ではホバー/フォーカス時のみ出して映像を邪魔しない。 */}
      {hostControls && (
        <div className="absolute right-1.5 top-1.5 z-10 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
          <Tooltip content={muteLabel} closeDelay={0}>
            <Button
              isIconOnly
              size="sm"
              radius="full"
              variant="flat"
              className="bg-black/60 text-white backdrop-blur data-[hover=true]:bg-black/80"
              aria-label={muteLabel}
              isLoading={hostControls.pendingIdentity === participant.id}
              onPress={() => hostControls.onToggleMute(participant)}
            >
              {participant.audioEnabled ? <MicOffIcon className="h-4 w-4" /> : <MicIcon className="h-4 w-4" />}
            </Button>
          </Tooltip>
        </div>
      )}

      <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-gradient-to-t from-black/70 to-transparent px-2 py-1.5">
        <span className="truncate text-sm text-white">{participant.name}</span>
        <div className="flex items-center gap-1.5 text-white/90">
          {!participant.audioEnabled && (
            <span title={text.room.muted}>
              <MicOffIcon className="h-4 w-4" />
              <span className="sr-only">{text.room.muted}</span>
            </span>
          )}
          <QualityDot quality={participant.quality} text={text} />
        </div>
      </div>
    </div>
  )
}
