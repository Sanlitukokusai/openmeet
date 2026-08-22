'use client'

/** 再接続中の非ブロッキング上部バナー（規格書 §7：reconnecting → 表示、reconnected → 自動で消える）。 */
export function ConnectionBanner({ message }: { message: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-center pt-3"
    >
      <div className="flex items-center gap-2 rounded-full bg-amber-500/95 px-4 py-1.5 text-sm font-medium text-zinc-950 shadow">
        <span className="h-2 w-2 animate-pulse rounded-full bg-zinc-950/70" />
        {message}
      </div>
    </div>
  )
}
