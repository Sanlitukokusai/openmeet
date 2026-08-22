'use client'

import { Button } from '@heroui/react'
import { useLocale } from '@/lib/ui-text'
import { useLocaleStore } from '@/lib/store/locale-store'
import type { Locale } from '@/lib/ui-text'

/**
 * 手动语言切换器（WP-8）。紧凑双按钮设计，全站各页面角落挂载同一份组件即可联动
 * ——底层是同一个 zustand store（lib/store/locale-store.ts），任意挂载点点击后
 * 全站（含其他已挂载的 LocaleSwitcher 实例）都会立即反映。
 *
 * 按钮文案固定显示"日本語 / 中文"（各语言的母语自称），不随当前 locale 翻译——
 * 这是语言切换器本身的通用约定（例如从不会在英文界面下把 "日本語" 显示成
 * "Japanese"），因此这两个标签有意不放进 lib/ui-text.ts 字典。
 *
 * className 用于各挂载点自定位置/深色背景适配（如 room 页需要 absolute 定位、
 * 避免遮挡视频区）；组件自身默认是内联小胶囊，浅色/深色主题都靠 Tailwind
 * `dark:` 变体（tailwind.config.ts: darkMode: 'class'）自动适配最近的 .dark 祖先
 * ——与 components/room/** 现有的深色浮层同一套机制。
 */
const OPTIONS: ReadonlyArray<{ value: Locale; label: string; ariaLabel: string }> = [
  { value: 'ja', label: '日本語', ariaLabel: '日本語表示に切り替え' },
  { value: 'zh', label: '中文', ariaLabel: '切换为中文显示' },
]

export function LocaleSwitcher({ className }: { className?: string }) {
  const locale = useLocale()
  const setLocale = useLocaleStore((s) => s.setLocale)

  return (
    <div
      role="group"
      aria-label="言語切替 / 语言切换"
      className={`inline-flex items-center gap-0.5 rounded-full border border-black/10 bg-white/80 p-0.5 shadow-sm backdrop-blur dark:border-white/10 dark:bg-white/10 ${className ?? ''}`}
    >
      {OPTIONS.map((opt) => {
        const isActive = locale === opt.value
        return (
          <Button
            key={opt.value}
            size="sm"
            radius="full"
            variant={isActive ? 'solid' : 'light'}
            color={isActive ? 'primary' : 'default'}
            aria-label={opt.ariaLabel}
            aria-pressed={isActive}
            className="h-6 min-w-0 px-2.5 text-xs data-[hover=true]:opacity-100"
            onPress={() => setLocale(opt.value)}
          >
            {opt.label}
          </Button>
        )
      })}
    </div>
  )
}
