'use client'

import { useEffect, useState } from 'react'
import { Button } from '@heroui/react'
import type { MediaProvider, ParticipantId, RemoteParticipant } from '@/lib/media/types'
import type { UiTextDict } from '@/lib/ui-text'
import { CheckIcon, CopyIcon, UsersIcon } from '@/components/icons'
import { computeGridLayout } from './grid-layout'
import { MobilePageControls } from './MobilePageControls'
import { clampMobilePageIndex, computeMobileGridLayout, computeMobilePageCount, sliceMobilePage } from './mobile-grid'
import { ParticipantTile, type TileHostControls } from './ParticipantTile'
import { useIsMobileRoomLayout } from './useIsMobileRoomLayout'
import { DEFAULT_VIDEO_FIT, loadVideoFit, nextVideoFit, saveVideoFit, VIDEO_FIT_HINT_MS, type VideoFit } from './video-fit'

/**
 * メイングリッド（規格書 §7：自適応 1/2/4/6/9 宮格）。並ぶのは遠端参加者のみ——
 * 自分のプレビューは LocalPreviewTile が別枠フロートで担当する。
 * 誰もいない場合は「待っています」＋招待リンクコピーのプレースホルダーを 1 枠表示する。
 *
 * 2026-08-14：モバイル（<md）専用の出し分け。実機フィードバック（竖屏で遠端が 16:9 の
 * 細い帯に押し潰され、画面中央が大きく黒く余る）を受けて、人数に応じて満屏／縦積み2段／
 * 2×2／ページング宮格に出し分ける（具体的な行列・ページングは components/room/mobile-grid.ts）。
 *
 * ★ 2026-08-14 第 2 波：**外枠を共通化**した（実機「揺らしたら映像が真っ黒」の対策その 1・本命）。
 *
 *   以前はモバイル分岐とデスクトップ分岐が**別々の JSX ツリー**を return していた。
 *   これだと端末回転で isMobile が反転した瞬間、React から見て木の形が変わるので
 *   ParticipantTile が丸ごと**アンマウント → 再マウント**される。ParticipantTile は
 *   `attachRemoteVideo` / `detachRemoteVideo` を useEffect の対で持つので、
 *   これは「回転のたびに全タイルの detach → attach を走らせる」という意味になり、
 *   回転アニメーション中にクエリが何度も反転すればそれが連打される。Android の
 *   国産ブラウザ / WebView ではここで映像が戻ってこなくなることがある。
 *
 *   今は **外枠（flex 縦）と grid を常に同じ位置に置き、変えるのは className / style /
 *   並べる要素の中身だけ**。タイルの key は participant.id なので、分岐が入れ替わっても
 *   React はタイルを同一視して**再マウントしない**＝attach/detach が走らない。
 *   `fill` は真偽値の props として渡るだけなので、コンテナの class が差し替わるのみ。
 *   （去抖はもう一段の保険：./layout-flip.ts + useIsMobileRoomLayout）
 *
 * ⚠️ それでも「同じ参加者のタイルを 2 つ同時にマウントしない」という原則は不変
 *   （§12.6 の attach/detach 対の前提）。だから分岐は今も**排他**——CSS で両方 DOM に
 *   置いて片方を hidden にする、という書き方には絶対にしないこと。
 */
export function VideoGrid({
  provider,
  participants,
  activeSpeakers,
  roomCode,
  hostControls,
  text,
}: {
  provider: MediaProvider
  participants: RemoteParticipant[]
  activeSpeakers: ParticipantId[]
  roomCode: string
  /** 主催者視点でのみ渡す（遠隔ミュート）。guest では undefined。 */
  hostControls?: TileHostControls
  text: UiTextDict
}) {
  const isMobile = useIsMobileRoomLayout()
  const speakingSet = new Set(activeSpeakers)

  // ページ番号の state はモバイル・デスクトップ問わず常に確保する（React のフック規則：
  // 早期 return の手前で分岐せず、どのレンダーでも同じ順序でフックを呼ぶ）。
  // デスクトップ表示中は pageCount は使われないが、計算自体は軽い純関数なので害はない。
  const pageCount = computeMobilePageCount(participants.length)
  const [page, setPage] = useState(0)
  useEffect(() => {
    // 参加者の増減でページ数が変わったときの保護（例：ページ 2 を見ている最中に
    // 退出が相次いでページが 1 つに減った）。発言者のいるページへの自動ジャンプは
    // しない——ここはあくまで「今の page が有効範囲か」だけを見る安全弁。
    setPage((current) => clampMobilePageIndex(current, pageCount))
  }, [pageCount])

  // ---- object-fit の切替（2026-08-14 第 2 波・実機「背景が全部見えない」）----
  // 初期値は既定の cover 固定にして、sessionStorage の実値はマウント後に読む
  // （useReducedMotion と同じ hydration-safe パターン。サーバーは知りようがない）。
  const [videoFit, setVideoFit] = useState<VideoFit>(DEFAULT_VIDEO_FIT)
  const [fitHint, setFitHint] = useState<VideoFit | null>(null)
  useEffect(() => {
    setVideoFit(loadVideoFit())
  }, [])
  useEffect(() => {
    if (!fitHint) return
    const timer = setTimeout(() => setFitHint(null), VIDEO_FIT_HINT_MS)
    return () => clearTimeout(timer)
  }, [fitHint])

  const visible = isMobile ? sliceMobilePage(participants, page) : participants
  const { rows, cols } = isMobile ? computeMobileGridLayout(visible.length) : computeGridLayout(participants.length)

  // タップ切替を出すのは**モバイルの満屏（タイル 1 枚）**のときだけ。宮格でタイルごとに
  // 収め方が変わると混乱するし、デスクトップは元々余白の付き方が違うので不要（桌面零改动）。
  const fitToggleEnabled = isMobile && visible.length === 1

  function handleToggleFit() {
    const next = nextVideoFit(videoFit)
    setVideoFit(next)
    saveVideoFit(next)
    setFitHint(next)
  }

  return (
    <div className="relative flex h-full w-full flex-col">
      <div
        className={
          isMobile
            ? 'grid min-h-0 w-full flex-1 gap-1'
            : 'grid min-h-0 w-full flex-1 auto-rows-fr gap-3 p-4'
        }
        style={{
          gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
        }}
      >
        {participants.length === 0 ? (
          <EmptyGridPlaceholder roomCode={roomCode} text={text} />
        ) : (
          visible.map((participant) => (
            <ParticipantTile
              key={participant.id}
              provider={provider}
              participant={participant}
              isSpeaking={speakingSet.has(participant.id)}
              hostControls={hostControls}
              text={text}
              fill={isMobile}
              objectFit={fitToggleEnabled ? videoFit : DEFAULT_VIDEO_FIT}
              onToggleFit={fitToggleEnabled ? handleToggleFit : undefined}
            />
          ))
        )}
      </div>

      {/* 切替の手応え。押した瞬間に見た目が変わるとはいえ、「今どちらなのか」を
          言葉で 1.2 秒だけ出す（黒帯が出る contain 側は特に、故障と誤解されやすい）。 */}
      {fitHint && (
        <div className="pointer-events-none absolute inset-x-0 top-4 z-20 flex justify-center px-4">
          <span
            role="status"
            className="rounded-full bg-black/70 px-3 py-1.5 text-xs text-white shadow ring-1 ring-white/10 backdrop-blur"
          >
            {fitHint === 'contain' ? text.room.fitContain : text.room.fitCover}
          </span>
        </div>
      )}

      {/* 5 人以上（pageCount > 1）のときだけページングを出す——自分たちの矢印＋ドット。
          ブラウザのスワイプジェスチャーには依存しない（タスク要件）。 */}
      {isMobile && pageCount > 1 && (
        <MobilePageControls
          page={page}
          pageCount={pageCount}
          onPrev={() => setPage((current) => clampMobilePageIndex(current - 1, pageCount))}
          onNext={() => setPage((current) => clampMobilePageIndex(current + 1, pageCount))}
          text={text}
        />
      )}
    </div>
  )
}

function EmptyGridPlaceholder({ roomCode, text }: { roomCode: string; text: UiTextDict }) {
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    const url = `${window.location.origin}/j/${roomCode}`
    await navigator.clipboard.writeText(url)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="col-span-full row-span-full flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-zinc-700 text-zinc-400">
      <UsersIcon className="h-8 w-8" />
      <p className="text-sm">{text.room.waitingForOthers}</p>
      <p className="text-xs text-zinc-500">{text.room.inviteHint}</p>
      <Button
        size="sm"
        variant="flat"
        onPress={handleCopy}
        startContent={copied ? <CheckIcon className="h-4 w-4" /> : <CopyIcon className="h-4 w-4" />}
      >
        {copied ? text.common.linkCopied : text.common.copyLink}
      </Button>
    </div>
  )
}
