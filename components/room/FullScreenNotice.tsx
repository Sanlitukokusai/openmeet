'use client'

import type { ReactNode } from 'react'
import { Button } from '@heroui/react'

/** 全画面通知（欠損セッション／切断／ホスト終了など、会議が続行できない状態を覆う）。 */
export function FullScreenNotice({
  title,
  body,
  primaryLabel,
  onPrimary,
  secondaryLabel,
  onSecondary,
  icon,
}: {
  title: string
  body: string
  primaryLabel: string
  onPrimary: () => void
  secondaryLabel?: string
  onSecondary?: () => void
  icon?: ReactNode
}) {
  return (
    <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-4 bg-zinc-950/95 px-6 text-center text-zinc-100">
      {icon}
      <h1 className="text-lg font-semibold">{title}</h1>
      <p className="max-w-sm text-sm text-zinc-400">{body}</p>
      <div className="flex gap-2">
        {secondaryLabel && onSecondary && (
          <Button variant="flat" onPress={onSecondary}>
            {secondaryLabel}
          </Button>
        )}
        <Button color="primary" onPress={onPrimary}>
          {primaryLabel}
        </Button>
      </div>
    </div>
  )
}
