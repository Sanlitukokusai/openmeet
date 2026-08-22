'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Badge, Button, Divider, Tooltip } from '@heroui/react'
import type { LocalState } from '@/lib/media/types'
import { interpolate, type UiTextDict } from '@/lib/ui-text'
import {
  CameraIcon,
  CameraOffIcon,
  MicIcon,
  MicOffIcon,
  PhoneHangupIcon,
  SettingsIcon,
  StopCircleIcon,
  UsersIcon,
} from '@/components/icons'
import { ChatIcon, MoreIcon, UsersMuteIcon } from './chat-icons'

/** モバイル（<md）で触控目标を ≥44px（h-11/w-11）に底上げするための共通上書き。
 *  `!` 付き（important）なのは、HeroUI Button 内部が生成する既定サイズ（"md"=40px）の
 *  ユーティリティと衝突したときに、カスケード順を気にせず確実に勝たせるため。
 *  デスクトップ（md 以上）ではこのクラス自体が発火しないので、既存の見た目に影響しない。 */
const MOBILE_TOUCH_TARGET_CLASS = 'max-md:!h-11 max-md:!w-11 max-md:!min-w-11'

/**
 * 会議室下部のコントロールドック。破壊的操作（退出・終了）は §9 destructive-nav-separation
 * に従い Divider で通常操作と視覚的に分離する。すべてのアイコンボタンに aria-label を付与
 * （icon-only ボタンはラベルが無いとスクリーンリーダーで用途不明になるため）。
 *
 * 2026-08-07 追加：チャット開閉（未読バッジ付き）と、主催者専用の「全員をミュート」。
 * 全員ミュートは他人に影響する操作なので Divider の**手前**（＝通常操作側）には置かず、
 * 会議終了と同じ主催者ブロックにまとめる——ただし色は danger ではなく既定のまま
 * （不可逆ではなく、相手は自分で解除できるため。過剰な警告色は本当の危険操作の
 * シグナルを薄める）。
 *
 * 2026-08-07 第 2 波：参加者一覧の開閉をチャットの**隣**に追加。両者は同じサイドバー枠を
 * 使う排他パネルなので、入口も隣り合わせに置いて「切り替わるもの」だと分かるようにする。
 *
 * 2026-08-14 追加：モバイル（<md）専用のレイアウト調整（実機フィードバック）。
 *  - 触控目标を 44px 以上に底上げ・間隔を広げる。
 *  - 主排は mic/camera/participants/chat/leave の 5 つだけ残し、デバイス設定・全員ミュート・
 *    会議終了は「その他」メニュー（MoreMenu、自前実装）にまとめる。
 *  - デスクトップ側のクラスタ（設定＋Divider＋主催者ボタン）は `hidden md:contents` で
 *    包むだけ——`display:contents` は要素自身を箱として持たないので、md 以上では
 *    従来どおり直接の flex 子として並び、gap の計算も含めて既存レイアウトと**完全に同一**
 *    のまま保たれる（桌面端零回归）。
 *  - MoreMenu は HeroUI の Dropdown（@heroui/dropdown、内部で @heroui/menu + popover 一式を
 *    追加で引き込む）をあえて使わない——本ファイルの上で DeviceSettingsModal が Tabs では
 *    なく Divider 区切りを選んだのと同じ理由（room 初期チャンクを膨らませない方針）。
 *    ボタン＋素の absolute パネルだけで組む軽量版。
 */
export function ControlBar({
  localState,
  isHost,
  isChatOpen,
  isParticipantsOpen,
  participantCount,
  unreadCount,
  isMutingAll,
  onToggleMic,
  onToggleCamera,
  onOpenSettings,
  onToggleChat,
  onToggleParticipants,
  onRequestMuteAll,
  onLeave,
  onRequestEndMeeting,
  text,
}: {
  localState: LocalState
  isHost: boolean
  isChatOpen: boolean
  isParticipantsOpen: boolean
  /** バッジに出す総人数（遠端 ＋ 自分）。 */
  participantCount: number
  unreadCount: number
  isMutingAll: boolean
  onToggleMic: () => void
  onToggleCamera: () => void
  onOpenSettings: () => void
  onToggleChat: () => void
  onToggleParticipants: () => void
  onRequestMuteAll: () => void
  onLeave: () => void
  onRequestEndMeeting: () => void
  text: UiTextDict
}) {
  const t = text.room
  const chatLabel = isChatOpen ? text.chat.close : text.chat.open
  const chatAriaLabel =
    unreadCount > 0 ? `${chatLabel}（${interpolate(text.chat.unreadAria, { count: unreadCount })}）` : chatLabel
  const participantsLabel = isParticipantsOpen ? text.participants.close : text.participants.open
  // バッジの数字は装飾（aria-hidden）なので、人数は aria-label 側で言葉にして持たせる。
  const participantsAriaLabel = `${participantsLabel}（${interpolate(text.participants.countLabel, {
    count: participantCount,
  })}）`

  return (
    <div className="bottom-dock-safe pointer-events-none absolute inset-x-0 z-20 flex justify-center px-4">
      <div className="pointer-events-auto flex items-center gap-1.5 rounded-full bg-zinc-900/90 px-2.5 py-2 shadow-lg ring-1 ring-white/10 backdrop-blur max-md:gap-2 max-md:px-3 max-md:py-2.5">
        <Tooltip content={localState.audioEnabled ? t.micOn : t.micOff} closeDelay={0}>
          <Button
            isIconOnly
            radius="full"
            variant={localState.audioEnabled ? 'flat' : 'solid'}
            color={localState.audioEnabled ? 'default' : 'danger'}
            aria-label={localState.audioEnabled ? t.micOn : t.micOff}
            onPress={onToggleMic}
            className={MOBILE_TOUCH_TARGET_CLASS}
          >
            {localState.audioEnabled ? <MicIcon className="h-5 w-5" /> : <MicOffIcon className="h-5 w-5" />}
          </Button>
        </Tooltip>

        <Tooltip content={localState.videoEnabled ? t.cameraOn : t.cameraOff} closeDelay={0}>
          <Button
            isIconOnly
            radius="full"
            variant={localState.videoEnabled ? 'flat' : 'solid'}
            color={localState.videoEnabled ? 'default' : 'danger'}
            aria-label={localState.videoEnabled ? t.cameraOn : t.cameraOff}
            onPress={onToggleCamera}
            className={MOBILE_TOUCH_TARGET_CLASS}
          >
            {localState.videoEnabled ? <CameraIcon className="h-5 w-5" /> : <CameraOffIcon className="h-5 w-5" />}
          </Button>
        </Tooltip>

        <Tooltip content={participantsLabel} closeDelay={0}>
          {/* 人数バッジは常に 1 以上（自分が居る）なので常時表示。 */}
          <Badge content={participantCount > 99 ? '99+' : participantCount} color="default" size="sm" aria-hidden>
            <Button
              isIconOnly
              radius="full"
              variant={isParticipantsOpen ? 'solid' : 'flat'}
              color={isParticipantsOpen ? 'primary' : 'default'}
              aria-label={participantsAriaLabel}
              aria-pressed={isParticipantsOpen}
              onPress={onToggleParticipants}
              className={MOBILE_TOUCH_TARGET_CLASS}
            >
              <UsersIcon className="h-5 w-5" />
            </Button>
          </Badge>
        </Tooltip>

        <Tooltip content={chatLabel} closeDelay={0}>
          {/* Badge は children を包んで右上にバッジを出す。未読 0 のときは非表示。 */}
          <Badge
            content={unreadCount > 99 ? '99+' : unreadCount}
            color="danger"
            size="sm"
            isInvisible={unreadCount === 0}
            aria-hidden
          >
            <Button
              isIconOnly
              radius="full"
              variant={isChatOpen ? 'solid' : 'flat'}
              color={isChatOpen ? 'primary' : 'default'}
              aria-label={chatAriaLabel}
              aria-pressed={isChatOpen}
              onPress={onToggleChat}
              className={MOBILE_TOUCH_TARGET_CLASS}
            >
              <ChatIcon className="h-5 w-5" />
            </Button>
          </Badge>
        </Tooltip>

        {/* デスクトップ（md 以上）：既存のまま——設定・Divider・主催者専用ボタンを直接並べる。
            display:contents なのでこの div 自体は箱を持たず、子は親 flex の直接の子と
            同じに振る舞う（gap もそのまま効く＝レイアウトは 1px も変わらない）。 */}
        <div className="hidden md:contents">
          <Tooltip content={t.deviceSettings} closeDelay={0}>
            <Button isIconOnly radius="full" variant="flat" aria-label={t.deviceSettings} onPress={onOpenSettings}>
              <SettingsIcon className="h-5 w-5" />
            </Button>
          </Tooltip>

          <Divider orientation="vertical" className="mx-1 h-8" />

          {isHost && (
            <Tooltip content={text.mute.muteAll} closeDelay={0}>
              <Button
                isIconOnly
                radius="full"
                variant="flat"
                aria-label={text.mute.muteAll}
                isLoading={isMutingAll}
                onPress={onRequestMuteAll}
              >
                <UsersMuteIcon className="h-5 w-5" />
              </Button>
            </Tooltip>
          )}

          {isHost && (
            <Tooltip content={t.endMeeting} closeDelay={0}>
              <Button
                isIconOnly
                radius="full"
                variant="flat"
                color="danger"
                aria-label={t.endMeeting}
                onPress={onRequestEndMeeting}
              >
                <StopCircleIcon className="h-5 w-5" />
              </Button>
            </Tooltip>
          )}
        </div>

        {/* モバイル（<md）：設定・全員ミュート（主催者のみ）・会議終了（主催者のみ）を
            「その他」にまとめる。MoreMenu のルート自体が md:hidden なのでデスクトップでは
            丸ごと描画されない（＝上のデスクトップ用クラスタと排他）。 */}
        <MoreMenu
          triggerLabel={t.moreOptions}
          items={[
            {
              key: 'settings',
              label: t.deviceSettings,
              icon: <SettingsIcon className="h-4 w-4" />,
              onSelect: onOpenSettings,
            },
            ...(isHost
              ? [
                  {
                    key: 'muteAll',
                    label: text.mute.muteAll,
                    icon: <UsersMuteIcon className="h-4 w-4" />,
                    isLoading: isMutingAll,
                    onSelect: onRequestMuteAll,
                  },
                  {
                    key: 'end',
                    label: t.endMeeting,
                    icon: <StopCircleIcon className="h-4 w-4" />,
                    danger: true,
                    onSelect: onRequestEndMeeting,
                  },
                ]
              : []),
          ]}
        />

        <Tooltip content={t.leave} closeDelay={0}>
          <Button
            isIconOnly
            radius="full"
            color="danger"
            aria-label={t.leave}
            onPress={onLeave}
            className={MOBILE_TOUCH_TARGET_CLASS}
          >
            <PhoneHangupIcon className="h-5 w-5" />
          </Button>
        </Tooltip>
      </div>
    </div>
  )
}

interface MoreMenuItem {
  key: string
  label: string
  icon: ReactNode
  /** 会議終了のような不可逆寄りの操作に危険色を当てる（離開/結束保持红色语义）。 */
  danger?: boolean
  isLoading?: boolean
  onSelect: () => void
}

/**
 * モバイル専用の軽量「その他」メニュー（2026-08-14）。
 *
 * HeroUI の Dropdown（@heroui/dropdown）を使わない意図的な選択——それは内部で
 * @heroui/popover・@heroui/menu・react-aria の overlay/menu 一式を追加で引き込み、
 * room ルートの First Load JS を増やす（このファイルの上、DeviceSettingsModal が
 * Tabs の代わりに Divider を選んだのと同じ判断基準）。ボタン＋ role="menu" の
 * 素の absolute パネルだけで組み、フォーカストラップや矢印キーでのローミングは
 * 持たない簡易実装（Tab キーでの到達・Enter/Space での実行・Escape での閉鎖・
 * 外側クリックでの閉鎖はサポートする）。
 */
function MoreMenu({ triggerLabel, items }: { triggerLabel: string; items: MoreMenuItem[] }) {
  const [isOpen, setIsOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isOpen) return
    function handlePointerDown(event: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setIsOpen(false)
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setIsOpen(false)
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen])

  return (
    <div ref={rootRef} className="relative md:hidden">
      <Button
        isIconOnly
        radius="full"
        variant="flat"
        aria-label={triggerLabel}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onPress={() => setIsOpen((v) => !v)}
        className="!h-11 !w-11 !min-w-11"
      >
        <MoreIcon className="h-5 w-5" />
      </Button>
      {isOpen && (
        <div
          role="menu"
          aria-label={triggerLabel}
          className="absolute bottom-full right-0 z-30 mb-2 min-w-[190px] overflow-hidden rounded-xl bg-zinc-900/95 py-1 shadow-lg ring-1 ring-white/10 backdrop-blur"
        >
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              disabled={item.isLoading}
              onClick={() => {
                setIsOpen(false)
                item.onSelect()
              }}
              className={`flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-sm transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50 ${
                item.danger ? 'text-danger' : 'text-zinc-100'
              }`}
            >
              {item.icon}
              <span className="flex-1">{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
