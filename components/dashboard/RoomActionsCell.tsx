'use client'

import type { ReactNode } from 'react'
import { Button, Tooltip } from '@heroui/react'
import { StopCircleIcon } from '@/components/icons'
import { PencilIcon, TrashIcon } from '@/components/dashboard/icons'
import { getRoomActionDisabledReason, isRoomActionEnabled, type RoomAction } from '@/app/dashboard/room-actions'
import type { RoomState } from '@/lib/server/rooms-logic'
import { useLocale, uiText, type Locale } from '@/lib/ui-text'

/**
 * 一覧の「操作」列。3 つの icon-only ボタン（編集・会議を終了・削除）。
 * status に応じて活性/非活性が変わり、非活性時は必ず Tooltip で理由を説明する
 * （CLAUDE.md：disabled 时は理由を説明、静默禁用しない）。
 */
export function RoomActionsCell({
  status,
  onEdit,
  onDelete,
  onEnd,
}: {
  status: RoomState
  onEdit: () => void
  onDelete: () => void
  onEnd: () => void
}) {
  const locale = useLocale()
  const t = uiText[locale]
  return (
    <div className="flex items-center gap-1">
      <RoomActionButton
        action="edit"
        status={status}
        label={t.dashboard.actionEdit}
        color="default"
        onPress={onEdit}
        icon={<PencilIcon className="h-4 w-4" />}
        locale={locale}
      />
      <RoomActionButton
        action="end"
        status={status}
        label={t.dashboard.actionEnd}
        color="warning"
        onPress={onEnd}
        icon={<StopCircleIcon className="h-4 w-4" />}
        locale={locale}
      />
      <RoomActionButton
        action="delete"
        status={status}
        label={t.dashboard.actionDelete}
        color="danger"
        onPress={onDelete}
        icon={<TrashIcon className="h-4 w-4" />}
        locale={locale}
      />
    </div>
  )
}

function RoomActionButton({
  action,
  status,
  label,
  color,
  onPress,
  icon,
  locale,
}: {
  action: RoomAction
  status: RoomState
  label: string
  color: 'default' | 'warning' | 'danger'
  onPress: () => void
  icon: ReactNode
  locale: Locale
}) {
  const enabled = isRoomActionEnabled(status, action)
  const disabledReason = getRoomActionDisabledReason(status, action, locale)

  const button = (
    <Button isIconOnly size="sm" variant="flat" color={color} aria-label={label} isDisabled={!enabled} onPress={onPress}>
      {icon}
    </Button>
  )

  if (enabled) {
    return <Tooltip content={label}>{button}</Tooltip>
  }

  // 無効化されたネイティブ <button disabled> はブラウザによって pointer イベントを
  // 一切発火しない（Chrome/WebKit で hover/mouseenter が届かない）ため、Tooltip の
  // トリガーをボタンではなく tabIndex 付きの <span> にラップして hover/focus を拾う
  // ——「非活性ボタンに Tooltip が出ない」という定番の落とし穴への対処。
  return (
    <Tooltip content={disabledReason ?? label}>
      <span tabIndex={0} className="inline-flex cursor-not-allowed rounded-full">
        {button}
      </span>
    </Tooltip>
  )
}
