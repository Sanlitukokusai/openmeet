/**
 * dashboard 専用のインラインアイコン（编集・削除）。
 *
 * components/icons.tsx と同じ仕様（24×24 viewBox・stroke ベース・線幅 1.75・
 * 線端 round・aria-hidden）で揃えるが、あちらの `base()` ヘルパーは export されて
 * いないため複製している。依存追加禁止（CLAUDE.md：npm install / package.json
 * 変更は厳禁）なのでアイコンライブラリは使わず、絵文字も使わない
 * （ui-ux-pro-max: no-emoji-icons）。装飾用途のみなので aria-hidden、
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

/** 編集（鉛筆）アイコン。 */
export function PencilIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M4 20h4L19.5 8.5a2.121 2.121 0 0 0-3-3L5 17v3z" />
      <path d="M14.5 6.5l3 3" />
    </svg>
  )
}

/** 削除（ゴミ箱）アイコン。 */
export function TrashIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M5 7h14" />
      <path d="M10 7V5a2 2 0 0 1 2-2v0a2 2 0 0 1 2 2v2" />
      <path d="M7 7l1 12a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2l1-12" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </svg>
  )
}
