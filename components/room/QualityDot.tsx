'use client'

import { Tooltip } from '@heroui/react'
import type { ConnectionQuality } from '@/lib/media/types'
import type { UiTextDict } from '@/lib/ui-text'

const DOT_CLASS: Record<ConnectionQuality, string> = {
  excellent: 'bg-emerald-400',
  good: 'bg-emerald-400/80',
  poor: 'bg-amber-400',
  lost: 'bg-red-500',
}

/**
 * ネットワーク品質ドット。色だけに意味を乗せない（ui-ux-pro-max color-not-only）ため、
 * 必ず Tooltip + sr-only テキストで文言も提供する。
 */
export function QualityDot({ quality, text }: { quality: ConnectionQuality; text: UiTextDict }) {
  const label = {
    excellent: text.room.qualityExcellent,
    good: text.room.qualityGood,
    poor: text.room.qualityPoor,
    lost: text.room.qualityLost,
  }[quality]

  return (
    <Tooltip content={label} closeDelay={0}>
      <span className="inline-flex items-center justify-center p-0.5">
        <span className={`h-2 w-2 rounded-full ${DOT_CLASS[quality]}`} />
        <span className="sr-only">{label}</span>
      </span>
    </Tooltip>
  )
}
