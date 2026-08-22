'use client'

import { Avatar, Button, Chip, Tooltip } from '@heroui/react'
import type { ParticipantId, RemoteParticipant } from '@/lib/media/types'
import { interpolate, type UiTextDict } from '@/lib/ui-text'
import { CameraIcon, CameraOffIcon, MicIcon, MicOffIcon } from '@/components/icons'
import { initialsOf } from '@/components/display-name'
import { CloseIcon, UsersMuteIcon } from './chat-icons'
import { buildParticipantRows, type ParticipantRow } from './participant-list'
import { speakingAvatarRingClass } from './speaking-highlight'
import { useReducedMotion } from './useReducedMotion'

/**
 * 参加者一覧パネル（2026-08-07 第 2 波）。
 *
 * ★ なぜ作ったか：個別ミュートの導線はタイル右上に既にあったが、デスクトップでは
 *   `md:opacity-0 md:group-hover:opacity-100` でホバーするまで見えない。実利用者は
 *   その存在に最後まで気付かず「一括ミュートしか無い」と受け取っていた。ホバーで
 *   隠れる操作は**発見できない操作**なので、常設の明示的な入口を用意する
 *   （タイル側のボタンは素早い経路として残す＝二重化であって置き換えではない）。
 *
 * レイアウトは ChatPanel と同じ作法：単一インスタンスを CSS だけで切り替える。
 *  - モバイル（< md）：`fixed inset-0 z-50` の全画面ドロワー
 *  - デスクトップ（≥ md）：幅 340px のサイドバーになり、親の flex 行の中でビデオ領域を押す
 * チャットとは**排他**（store の openPanel が保証）——両方開いても幅を取り合うだけなので、
 * 開閉のたびに相手を閉じる。
 */
export function ParticipantsPanel({
  self,
  localState,
  participants,
  activeSpeakers,
  hostControls,
  onRequestMuteAll,
  isMutingAll,
  onClose,
  text,
}: {
  self: { displayName: string; role: 'host' | 'guest' }
  localState: { audioEnabled: boolean; videoEnabled: boolean }
  participants: RemoteParticipant[]
  activeSpeakers: ParticipantId[]
  /** 主催者視点でのみ渡す。guest では undefined＝ミュート系の UI が一切描画されない。 */
  hostControls?: {
    pendingIdentity: string | null
    onToggleMute: (participant: RemoteParticipant) => void
  }
  /** 主催者のみ。パネル下部の「全員をミュート」（既存の確認モーダルを開く）。 */
  onRequestMuteAll?: () => void
  isMutingAll: boolean
  onClose: () => void
  text: UiTextDict
}) {
  const t = text.participants
  const rows = buildParticipantRows({ self, localState, participants, activeSpeakers })
  // 行 → 元の RemoteParticipant。ミュート要求は RoomExperience の既存ハンドラに
  // **そのままの型で**渡す（リクエストロジックを二重実装しない）。
  const byIdentity = new Map(participants.map((p) => [p.id, p]))

  return (
    <aside
      aria-label={t.title}
      // pb-safe/pt-safe：モバイルの全画面ドロワーが iOS のホームインジケータ／ノッチに
      // 被らないように（2026-08-14）。デスクトップでは env(safe-area-inset-*) が 0 なので
      // 無条件に付けても見た目は変わらない。
      // 2026-08-16：`inset-0` → `inset-x-0 top-0 h-dvh`（+ `md:h-auto`）。理由は ChatPanel の
      // 同じ箇所のコメント参照——iOS Safari のツールバーは safe-area に算入されないため、
      // 高さは dvh で明示する必要がある。
      className="fixed inset-x-0 top-0 h-dvh z-50 flex flex-col bg-zinc-900 pb-safe pt-safe text-zinc-100 md:static md:z-auto md:h-auto md:w-[340px] md:shrink-0 md:border-l md:border-white/10"
    >
      <header className="flex items-center justify-between gap-2 border-b border-white/10 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="text-sm font-semibold">{t.title}</h2>
          <Chip size="sm" variant="flat" className="text-xs">
            {interpolate(t.countLabel, { count: rows.length })}
          </Chip>
        </div>
        <Button isIconOnly size="sm" variant="light" radius="full" aria-label={t.close} onPress={onClose}>
          <CloseIcon className="h-4 w-4" />
        </Button>
      </header>

      {/* 2026-08-16 実機フィードバック「主催者がスマホから全員ミュートできない」の診断結果：
          手機からリンク直入りだと大半は未ログイン＝guest になり、主催者操作は仕様どおり
          非表示になる（診断の詳細は最終レポート）。guest 本人が「なぜ主催者操作が無いのか」
          を理解できるよう、低調な一行案内を出す。判定は requireLogin を見ず role だけ
          （どんな部屋でも guest なら主催者操作は無いという事実は変わらないため）。 */}
      {self.role !== 'host' && (
        <p className="border-b border-white/10 bg-white/[0.03] px-4 py-2 text-xs leading-relaxed text-zinc-400">
          {t.guestNotice}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        <ul role="list" aria-label={t.listAria} className="flex flex-col gap-0.5">
          {rows.map((row) => {
            // 自分の行は identity=null なので remote が引けず、結果としてミュートボタンも
            // 出ない（自分のマイクはコントロールバーで操作する）。guest 視点は
            // hostControls 自体が undefined なので全行でボタンが消える。
            const remote = row.identity !== null ? byIdentity.get(row.identity) : undefined
            return (
              <ParticipantRowItem
                key={row.id}
                row={row}
                onToggleMute={hostControls && remote ? () => hostControls.onToggleMute(remote) : undefined}
                isMutePending={remote !== undefined && hostControls?.pendingIdentity === remote.id}
                text={text}
              />
            )
          })}
        </ul>
        {participants.length === 0 && <p className="px-2 py-4 text-center text-xs text-zinc-500">{t.empty}</p>}
      </div>

      {onRequestMuteAll && (
        <div className="border-t border-white/10 px-3 py-3">
          <Button
            fullWidth
            size="sm"
            variant="flat"
            startContent={isMutingAll ? undefined : <UsersMuteIcon className="h-4 w-4" />}
            isLoading={isMutingAll}
            onPress={onRequestMuteAll}
          >
            {text.mute.muteAll}
          </Button>
        </div>
      )}
    </aside>
  )
}

function ParticipantRowItem({
  row,
  onToggleMute,
  isMutePending,
  text,
}: {
  row: ParticipantRow
  /** undefined = この行にミュート操作は無い（guest 視点、または自分の行）。 */
  onToggleMute?: () => void
  isMutePending: boolean
  text: UiTextDict
}) {
  const t = text.participants
  const reducedMotion = useReducedMotion()
  const muteLabel = row.audioEnabled ? text.mute.muteParticipant : text.mute.unmuteParticipant
  const micLabel = row.audioEnabled ? t.micOnLabel : t.micOffLabel
  const cameraLabel = row.videoEnabled ? t.cameraOnLabel : t.cameraOffLabel

  return (
    <li className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-white/5">
      {/* 発言中リングはアバター本体ではなくオーバーレイに載せる（タイル側と同じ理由——
          animate-pulse は要素の opacity を往復させるので、本体に付けるとイニシャル文字まで
          明滅する）。詳細は components/room/speaking-highlight.ts。 */}
      <span className="relative inline-flex shrink-0">
        <Avatar size="sm" name={initialsOf(row.name)} className="h-8 w-8 text-tiny" />
        {row.isSpeaking && <span aria-hidden className={speakingAvatarRingClass(reducedMotion)} />}
      </span>

      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm">
          {row.name}
          {row.isSelf && <span className="text-zinc-400">{t.selfSuffix}</span>}
        </span>
        <span className="flex items-center gap-1.5">
          {row.isHost && (
            <span className="rounded bg-primary/20 px-1 py-px text-[10px] leading-4 text-primary">{t.hostBadge}</span>
          )}
          {/* host バッジと対になる自分専用の表示（2026-08-16）。他の guest 参会者の行には
              付けない——「自分の身份」を明確にするための表示であって、全 guest 行への
              ラベル付けではない（一覧が guest バッジだらけになるのを避ける）。 */}
          {row.isSelf && !row.isHost && (
            <span className="rounded bg-white/10 px-1 py-px text-[10px] leading-4 text-zinc-400">{t.guestBadge}</span>
          )}
          {row.isSpeaking && <span className="text-[10px] leading-4 text-amber-400">{text.room.speaking}</span>}
        </span>
      </div>

      {/* 状態アイコンは「今どうなっているか」の表示専用（押せない）。操作は右の
          ミュートボタンとコントロールバーに集約する——見た目が同じで片方だけ押せる、
          という混乱を避けるため色も薄くしてある。 */}
      <span className="flex shrink-0 items-center gap-1.5 text-zinc-400">
        <span title={micLabel}>
          {row.audioEnabled ? <MicIcon className="h-4 w-4" /> : <MicOffIcon className="h-4 w-4 text-danger" />}
          <span className="sr-only">{micLabel}</span>
        </span>
        <span title={cameraLabel}>
          {row.videoEnabled ? <CameraIcon className="h-4 w-4" /> : <CameraOffIcon className="h-4 w-4" />}
          <span className="sr-only">{cameraLabel}</span>
        </span>
      </span>

      {onToggleMute && (
        <Tooltip content={muteLabel} closeDelay={0}>
          <Button
            isIconOnly
            size="sm"
            radius="full"
            variant="light"
            className="shrink-0"
            aria-label={`${muteLabel}（${row.name}）`}
            isLoading={isMutePending}
            onPress={onToggleMute}
          >
            {row.audioEnabled ? <MicOffIcon className="h-4 w-4" /> : <MicIcon className="h-4 w-4" />}
          </Button>
        </Tooltip>
      )}
    </li>
  )
}
