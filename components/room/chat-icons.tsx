/**
 * チャット / 遠隔ミュート用に追加したアイコン（2026-08-07 FR-4）。
 *
 * 仕様は components/icons.tsx と完全に同じ（24×24 viewBox・stroke ベース・線幅 1.75・
 * 線端 round・aria-hidden、アクセシブルな名前は親のボタン側で付ける）。
 * 既存の共有アイコン集合ではなくここに置いたのは、本波の作業範囲が components/room/**
 * に限定されているため——将来、他画面でも使うようになったら components/icons.tsx に
 * 移してよい（`base()` の実装はそちらからのコピーで、意図的な重複）。
 */
import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement>

function base(props: IconProps) {
  return {
    xmlns: 'http://www.w3.org/2000/svg',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.75,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    ...props,
  }
}

/** 吹き出し（チャットパネルの開閉ボタン） */
export function ChatIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M20 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z" />
    </svg>
  )
}

/** 紙飛行機（送信ボタン） */
export function SendIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M21 3 10.5 13.5" />
      <path d="M21 3l-6.5 18-4-8-8-4z" />
    </svg>
  )
}

/** ×（パネルを閉じる） */
export function CloseIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  )
}

/** 下向き矢印（「新しいメッセージ」→ 最下部へジャンプ） */
export function ArrowDownIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M12 5v14" />
      <path d="m19 12-7 7-7-7" />
    </svg>
  )
}

/** 複数人＋ミュート（全員をミュート） */
export function UsersMuteIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M16 8h6" />
    </svg>
  )
}

/**
 * 右向き山形（モバイルのビデオページング「次のページ」）。components/icons.tsx の
 * ChevronLeftIcon の鏡像——本波の作業範囲が components/room/** に限定されているため
 * ここに置く（icons.tsx は編集対象外）。将来共用化するならそちらへ移してよい。
 * 2026-08-14 追加。
 */
export function ChevronRightIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M9 5l7 7-7 7" />
    </svg>
  )
}

/** 横向き三点リーダー（モバイルコントロールドックの「その他」メニュートリガー）。2026-08-14 追加。 */
export function MoreIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="5" cy="12" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.3" fill="currentColor" stroke="none" />
    </svg>
  )
}
