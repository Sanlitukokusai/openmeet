/**
 * インラインアイコン集合（join / prejoin / room で共用）。
 *
 * 依存追加禁止（CLAUDE.md：npm install / package.json 変更は厳禁）なので、
 * lucide-react 等のアイコンライブラリを新規導入できない。絵文字はアイコンとして
 * 使わない（ui-ux-pro-max: no-emoji-icons）ので、必要な分だけ自前の SVG を用意する。
 * 全アイコン共通仕様：24×24 viewBox・stroke ベース・線幅 1.75・線端 round
 * （icon-style-consistent / stroke-consistency）。装飾用途のみなので aria-hidden、
 * アクセシブルな名前は必ず親のボタン側で aria-label として付与すること。
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

export function MicIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
      <path d="M9 21h6" />
    </svg>
  )
}

export function MicOffIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M3 3l18 18" />
      <path d="M9 5a3 3 0 0 1 6 0v6a3 3 0 0 1-.35 1.41" />
      <path d="M15 14.16A3 3 0 0 1 9 12v-2" />
      <path d="M5 11a7 7 0 0 0 10.24 6.2" />
      <path d="M19 11a7 7 0 0 1-.6 2.85" />
      <path d="M12 18v3" />
      <path d="M9 21h6" />
    </svg>
  )
}

export function CameraIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M3 8a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M21 8.5l-4.5 3 4.5 3z" />
    </svg>
  )
}

export function CameraOffIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M3 3l18 18" />
      <path d="M21 8.5l-4.5 3v1" />
      <path d="M16 6H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h9" />
      <path d="M15 18h1a2 2 0 0 0 2-2v-1" />
    </svg>
  )
}

export function PhoneHangupIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M3.5 13c4-4.2 13-4.2 17 0" />
      <path d="M8.5 15.8l1-2a1.4 1.4 0 0 1 1.7-.6c.5.2 1.1.3 1.8.3s1.3-.1 1.8-.3a1.4 1.4 0 0 1 1.7.6l1 2a1.3 1.3 0 0 1-.6 1.7l-1.6.8a1.4 1.4 0 0 1-1.5-.2 8.6 8.6 0 0 0-5.6 0 1.4 1.4 0 0 1-1.5.2l-1.6-.8a1.3 1.3 0 0 1-.6-1.7z" />
    </svg>
  )
}

export function SettingsIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}

export function StopCircleIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="9" />
      <rect x="9" y="9" width="6" height="6" rx="1" />
    </svg>
  )
}

export function CopyIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
    </svg>
  )
}

export function CheckIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M4 12l6 6L20 6" />
    </svg>
  )
}

export function ChevronLeftIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M15 5l-7 7 7 7" />
    </svg>
  )
}

export function AlertTriangleIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M12 3.5L2.5 20h19z" />
      <path d="M12 9.5v4.2" />
      <path d="M12 17h.01" />
    </svg>
  )
}

export function UsersIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M2.5 19a6.5 6.5 0 0 1 13 0" />
      <path d="M16 4.6a3.2 3.2 0 0 1 0 6.2" />
      <path d="M18 13.2a6.5 6.5 0 0 1 3.5 5.8" />
    </svg>
  )
}

export function SignalIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M4 18v-3" />
      <path d="M9.5 18v-6" />
      <path d="M15 18V9" />
      <path d="M20 18V4" />
    </svg>
  )
}
