'use client'

import { Button } from '@heroui/react'
import { interpolate, type UiTextDict } from '@/lib/ui-text'
import { ChevronLeftIcon } from '@/components/icons'
import { ChevronRightIcon } from './chat-icons'

/**
 * モバイルビデオグリッドのページング（5 人以上を 2×2 ずつ捌く、2026-08-14 実機フィードバック）。
 *
 * ブラウザのスワイプジェスチャーには依存しない自前の矢印＋ドット——横スワイプはブラウザ／
 * WebView によってページ全体の「戻る」ジェスチャーと衝突しうるため、明示的なボタンで
 * 確実に操作できるようにする（タスク要件「我们自己的翻页控件，别依赖浏览器手势」）。
 *
 * 発言者がいるページへの自動ジャンプは行わない——components/room/participant-list.ts の
 * 「発言中でも行を動かさない」判断と同じ思想：ページが勝手に切り替わると、ボタンを
 * 押そうとした瞬間に別のページへ差し替わって誤操作を招く。
 *
 * ドットは表示専用（タップ不可）。矢印のみが操作口——Zoom モバイル版と同じ割り切り。
 */
export function MobilePageControls({
  page,
  pageCount,
  onPrev,
  onNext,
  text,
}: {
  /** 0-indexed の現在ページ。 */
  page: number
  pageCount: number
  onPrev: () => void
  onNext: () => void
  text: UiTextDict
}) {
  const t = text.room

  return (
    <div className="bottom-pager-safe pointer-events-none absolute inset-x-0 z-10 flex items-center justify-center gap-3">
      <Button
        isIconOnly
        radius="full"
        variant="flat"
        isDisabled={page === 0}
        aria-label={t.previousPage}
        onPress={onPrev}
        className="pointer-events-auto !h-11 !w-11 !min-w-11 bg-black/50 text-white backdrop-blur data-[hover=true]:bg-black/70"
      >
        <ChevronLeftIcon className="h-5 w-5" />
      </Button>

      <div className="pointer-events-auto flex items-center gap-1.5 rounded-full bg-black/50 px-3 py-2 backdrop-blur">
        {Array.from({ length: pageCount }, (_, index) => (
          <span
            key={index}
            aria-hidden
            className={`h-1.5 w-1.5 rounded-full transition-colors ${index === page ? 'bg-white' : 'bg-white/40'}`}
          />
        ))}
        <span className="sr-only" aria-live="polite">
          {interpolate(t.pageIndicator, { page: page + 1, total: pageCount })}
        </span>
      </div>

      <Button
        isIconOnly
        radius="full"
        variant="flat"
        isDisabled={page >= pageCount - 1}
        aria-label={t.nextPage}
        onPress={onNext}
        className="pointer-events-auto !h-11 !w-11 !min-w-11 bg-black/50 text-white backdrop-blur data-[hover=true]:bg-black/70"
      >
        <ChevronRightIcon className="h-5 w-5" />
      </Button>
    </div>
  )
}
