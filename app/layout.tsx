import type { Metadata, Viewport } from 'next'
import { HeroUIProvider } from '@heroui/react'
import './globals.css'

export const metadata: Metadata = {
  title: 'オンライン会議',
  description: 'ブラウザだけで参加できるオンライン会議システムです。',
}

/**
 * 2026-08-14 追加：`viewportFit: 'cover'` で iOS Safari にレイアウトをノッチ／
 * ホームインジケータの下まで広げさせる（`env(safe-area-inset-*)` が意味を持つのは
 * これとセット——app/globals.css の safe-area ユーティリティ参照）。
 * `width`/`initialScale` も明示しているのは、Next.js は viewport を export すると
 * 既定値を暗黙にマージせず指定した値だけで meta タグを組むため——うっかり
 * `width=device-width` を失ってレスポンシブ表示が崩れるのを防ぐ。
 * `userScalable`/`maximumScale` は意図的に指定しない（＝「保留缩放默认」：
 * ピンチズームを無効化しない）。
 */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="ja">
      <body>
        <HeroUIProvider>{children}</HeroUIProvider>
      </body>
    </html>
  )
}
