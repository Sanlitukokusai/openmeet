'use client'

import { useEffect, useRef, useState, type ChangeEvent, type ReactNode, type SVGProps } from 'react'
import { Spinner, Tooltip } from '@heroui/react'
import {
  MAX_STORED_BACKGROUND_IMAGES,
  backgroundImageStore,
  isSameBackgroundSelection,
  nextSelectionAfterImageDeletion,
  type BackgroundSelection,
  type BlurStrength,
  type StoredBackgroundImage,
} from '@/lib/background-storage'
import { interpolate, type UiTextDict } from '@/lib/ui-text'
import { CloseIcon } from './room/chat-icons'

/**
 * 背景选择器（prejoin 与会议内共用，2026-08-13 FR-7）。
 *
 * 设计上完全**受控**：`value` 是已确认生效 / 已持久化的选择，本组件只在
 * `onSelect` 返回成功（resolve true）后才会跟着 `value` 的下一次渲染切换高亮；
 * 失败（resolve false）时不改 `value`，本组件的乐观高亮自动回落——不需要
 * 额外的"回滚"代码路径，回滚就是"什么都不做，等待父组件不更新 value"。
 *
 * 自传图的存取（IndexedDB）完全在组件内部完成，调用方不需要关心；只有
 * "把某个选择变成生效效果"这件事（可能涉及 provider、也可能只是 localStorage）
 * 交给调用方通过 `onSelect` 决定——prejoin 和会议内的实现完全不同，但对本组件
 * 来说是同一个契约。
 */
export interface BackgroundPickerProps {
  /** 当前环境能否运行背景处理管线。prejoin 阶段没有 provider 无法得知，调用方固定传
   *  true（详见 PrejoinView 内注释）；会议内由 provider.isBackgroundEffectSupported() 提供权威答案。 */
  isSupported: boolean
  /** 当前已确认生效的选择（受控）。 */
  value: BackgroundSelection
  /** 用户点选某一项（含"上传后自动选中"）。resolve true=已生效并已持久化；
   *  resolve false=调用方已自行处理提示，本组件只需要停止 spinner。 */
  onSelect: (selection: BackgroundSelection) => Promise<boolean>
  text: UiTextDict
}

const BUILTIN_BACKGROUNDS: ReadonlyArray<{
  imageUrl: string
  labelKey: 'builtinOffice' | 'builtinBookshelf' | 'builtinLiving' | 'builtinNature'
}> = [
  { imageUrl: '/backgrounds/bg-office.webp', labelKey: 'builtinOffice' },
  { imageUrl: '/backgrounds/bg-bookshelf.webp', labelKey: 'builtinBookshelf' },
  { imageUrl: '/backgrounds/bg-living.webp', labelKey: 'builtinLiving' },
  { imageUrl: '/backgrounds/bg-nature.webp', labelKey: 'builtinNature' },
]

/**
 * 虚化の二段階（2026-08-14 実機フィードバック：「ぼかしが弱すぎる」）。
 * 'strong' を先頭（None の直後）に置く——旧来の単一「ぼかし」サムネイルがあった位置を
 * そのまま引き継ぐ、虚化系の既定推奨スロット。'light' はその隣に追加した弱め選択肢。
 */
const BLUR_STRENGTH_OPTIONS: ReadonlyArray<{ strength: BlurStrength; labelKey: 'blurStrong' | 'blurLight' }> = [
  { strength: 'strong', labelKey: 'blurStrong' },
  { strength: 'light', labelKey: 'blurLight' },
]

/** 自传图压缩目标：最长边像素、webp 编码质量（规格见任务简报 §5）。 */
const MAX_IMAGE_EDGE = 1280
const IMAGE_QUALITY = 0.85

export function BackgroundPicker({ isSupported, value, onSelect, text }: BackgroundPickerProps) {
  const t = text.background
  const [images, setImages] = useState<StoredBackgroundImage[]>([])
  /** 正在等待 onSelect 结果的那一项（缩略图/内置图/无/虚化都可能是 pending）。 */
  const [pending, setPending] = useState<BackgroundSelection | null>(null)
  const [isUploading, setIsUploading] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  /** key → blob: URL 的缓存，随 images 列表增减而创建/回收，卸载时统一释放。 */
  const objectUrlsRef = useRef<Map<string, string>>(new Map())

  useEffect(() => {
    let cancelled = false
    backgroundImageStore.listImages().then((list) => {
      if (!cancelled) setImages(list)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const cache = objectUrlsRef.current
    const nextKeys = new Set(images.map((image) => image.key))
    for (const [key, url] of cache) {
      if (!nextKeys.has(key)) {
        URL.revokeObjectURL(url)
        cache.delete(key)
      }
    }
    for (const image of images) {
      if (!cache.has(image.key)) cache.set(image.key, URL.createObjectURL(image.blob))
    }
  }, [images])

  // アンマウント時に残っている blob: URL を全部解放する（§12.6 と同じ attach/detach の考え方）。
  useEffect(() => {
    const cache = objectUrlsRef.current
    return () => {
      for (const url of cache.values()) URL.revokeObjectURL(url)
      cache.clear()
    }
  }, [])

  const isBusy = pending !== null || isUploading
  const isDisabled = !isSupported || isBusy
  const isLimitReached = images.length >= MAX_STORED_BACKGROUND_IMAGES

  async function refreshImages() {
    setImages(await backgroundImageStore.listImages())
  }

  async function applySelection(selection: BackgroundSelection) {
    setPending(selection)
    setNotice(null)
    try {
      await onSelect(selection)
    } finally {
      setPending(null)
    }
  }

  async function handlePick(selection: BackgroundSelection) {
    if (isDisabled || isSameBackgroundSelection(selection, value)) return
    await applySelection(selection)
  }

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = '' // 允许连续两次选择同一个文件也能触发 onChange
    if (!file || isDisabled) return
    if (isLimitReached) {
      setNotice(interpolate(t.limitReached, { max: MAX_STORED_BACKGROUND_IMAGES }))
      return
    }
    setNotice(null)
    setIsUploading(true)
    try {
      const blob = await compressImageForBackground(file)
      const result = await backgroundImageStore.addImage(blob)
      if (!result.ok) {
        setNotice(interpolate(t.limitReached, { max: MAX_STORED_BACKGROUND_IMAGES }))
        return
      }
      await refreshImages()
      // 添加成功后直接选中它——用户点「添加图片」这个动作本身就是想用这张图。
      await applySelection({ kind: 'custom', imageKey: result.image.key })
    } catch {
      setNotice(t.uploadFailed)
    } finally {
      setIsUploading(false)
    }
  }

  async function handleDeleteImage(key: string) {
    if (isDisabled) return
    const next = nextSelectionAfterImageDeletion(value, key)
    if (next !== value) {
      setPending(next)
      let ok = false
      try {
        ok = await onSelect(next)
      } finally {
        setPending(null)
      }
      // 切走失败就不删——调用方已经为失败弹过提示，这里不重复；但不能留下
      // 「图删了、效果却还挂着一个不存在的 key」的悬空态。
      if (!ok) return
    }
    await backgroundImageStore.deleteImage(key)
    await refreshImages()
  }

  return (
    <div className="flex flex-col gap-2">
      {!isSupported && <p className="text-xs text-warning-600">{t.unsupportedNote}</p>}

      <div className="flex items-center gap-2 overflow-x-auto pb-1">
        <PickerItem
          label={t.none}
          isSelected={isSameBackgroundSelection(value, { kind: 'none' })}
          isPending={pending !== null && isSameBackgroundSelection(pending, { kind: 'none' })}
          isDisabled={isDisabled}
          onSelect={() => handlePick({ kind: 'none' })}
        >
          <div className="flex h-full w-full items-center justify-center bg-default-100 text-default-500">
            <NoneIcon className="h-7 w-7" />
          </div>
        </PickerItem>

        {BLUR_STRENGTH_OPTIONS.map((option) => (
          <PickerItem
            key={option.strength}
            label={t[option.labelKey]}
            isSelected={isSameBackgroundSelection(value, { kind: 'blur', strength: option.strength })}
            isPending={
              pending !== null && isSameBackgroundSelection(pending, { kind: 'blur', strength: option.strength })
            }
            isDisabled={isDisabled}
            onSelect={() => handlePick({ kind: 'blur', strength: option.strength })}
          >
            <BlurSwatch strength={option.strength} />
          </PickerItem>
        ))}

        {BUILTIN_BACKGROUNDS.map((builtin) => (
          <PickerItem
            key={builtin.imageUrl}
            label={t[builtin.labelKey]}
            isSelected={isSameBackgroundSelection(value, { kind: 'builtin', imageUrl: builtin.imageUrl })}
            isPending={
              pending !== null && isSameBackgroundSelection(pending, { kind: 'builtin', imageUrl: builtin.imageUrl })
            }
            isDisabled={isDisabled}
            onSelect={() => handlePick({ kind: 'builtin', imageUrl: builtin.imageUrl })}
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- 站内静态缩略图，用不到 next/image 的远程优化 */}
            <img src={builtin.imageUrl} alt="" className="h-full w-full object-cover" />
          </PickerItem>
        ))}

        {images.map((image) => (
          <PickerItem
            key={image.key}
            label={t.sectionTitle}
            isSelected={isSameBackgroundSelection(value, { kind: 'custom', imageKey: image.key })}
            isPending={
              pending !== null && isSameBackgroundSelection(pending, { kind: 'custom', imageKey: image.key })
            }
            isDisabled={isDisabled}
            onSelect={() => handlePick({ kind: 'custom', imageKey: image.key })}
            onDelete={() => void handleDeleteImage(image.key)}
            deleteLabel={t.deleteImage}
          >
            {objectUrlsRef.current.get(image.key) && (
              // eslint-disable-next-line @next/next/no-img-element -- blob: URL，无法交给 next/image
              <img src={objectUrlsRef.current.get(image.key)} alt="" className="h-full w-full object-cover" />
            )}
          </PickerItem>
        ))}

        <Tooltip content={t.addImage} closeDelay={0}>
          <button
            type="button"
            aria-label={t.addImage}
            disabled={isDisabled}
            onClick={() => fileInputRef.current?.click()}
            className="flex h-20 w-20 shrink-0 items-center justify-center rounded-xl border-2 border-dashed border-default-300 text-default-400 transition-colors hover:border-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-default-300 disabled:hover:text-default-400"
          >
            {isUploading ? <Spinner size="sm" /> : <PlusIcon className="h-6 w-6" />}
          </button>
        </Tooltip>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(event) => void handleFileChange(event)}
        />
      </div>

      {isBusy && (
        <p className="text-xs text-default-500" aria-live="polite">
          {t.applying}
        </p>
      )}
      {notice && (
        <p className="text-xs text-danger-500" aria-live="polite">
          {notice}
        </p>
      )}
    </div>
  )
}

function PickerItem({
  label,
  isSelected,
  isPending,
  isDisabled,
  onSelect,
  onDelete,
  deleteLabel,
  children,
}: {
  label: string
  isSelected: boolean
  isPending: boolean
  isDisabled: boolean
  onSelect: () => void
  onDelete?: () => void
  deleteLabel?: string
  children: ReactNode
}) {
  return (
    <div className="relative h-20 w-20 shrink-0">
      <Tooltip content={label} closeDelay={0}>
        <button
          type="button"
          aria-label={label}
          aria-pressed={isSelected}
          disabled={isDisabled}
          onClick={onSelect}
          className={`h-full w-full overflow-hidden rounded-xl border-2 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50 ${
            isSelected ? 'border-primary' : 'border-default-200 hover:border-primary/60'
          }`}
        >
          <span className="relative block h-full w-full">
            {children}
            {isPending && (
              <span className="absolute inset-0 flex items-center justify-center bg-black/40">
                <Spinner size="sm" color="white" />
              </span>
            )}
          </span>
        </button>
      </Tooltip>
      {onDelete && (
        <Tooltip content={deleteLabel} closeDelay={0}>
          <button
            type="button"
            aria-label={deleteLabel}
            disabled={isDisabled}
            onClick={(event) => {
              event.stopPropagation()
              onDelete()
            }}
            className="absolute -right-1.5 -top-1.5 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-default-800 text-white shadow disabled:cursor-not-allowed disabled:opacity-50"
          >
            <CloseIcon className="h-3 w-3" />
          </button>
        </Tooltip>
      )}
    </div>
  )
}

/** サムネイル自体の見た目でも強度差が伝わるように、ぼかし量を変える（弱=わずかに背景の
 *  輪郭が残る／強=ほぼ判別できない）。実際の映像処理への反映は blurRadius（背景ロジック側）
 *  が担い、これは選択 UI 上の示唆に過ぎない。 */
function BlurSwatch({ strength }: { strength: BlurStrength }) {
  const blurClass = strength === 'light' ? 'blur-[2px]' : 'blur-[9px]'
  return (
    <div className="relative h-full w-full overflow-hidden bg-gradient-to-br from-sky-200 via-indigo-200 to-violet-300">
      <div className={`absolute inset-0 ${blurClass}`} />
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="h-7 w-7 rounded-full bg-white/90 shadow-sm" />
      </div>
    </div>
  )
}

type IconProps = SVGProps<SVGSVGElement>

function iconBase(props: IconProps) {
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

/** 「无」——圆圈+斜线，通用的"关闭/none"图标语义。 */
function NoneIcon(props: IconProps) {
  return (
    <svg {...iconBase(props)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M5.5 5.5l13 13" />
    </svg>
  )
}

/** 「添加图片」。 */
function PlusIcon(props: IconProps) {
  return (
    <svg {...iconBase(props)}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  )
}

// ============================================================
// 自传图压缩（浏览器专用，不可单测——canvas/Image 在 vitest 的 node 环境下不存在）
// ============================================================

interface DrawableImage {
  source: CanvasImageSource
  width: number
  height: number
  cleanup: () => void
}

async function loadDrawableImage(file: File): Promise<DrawableImage> {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file)
    return { source: bitmap, width: bitmap.width, height: bitmap.height, cleanup: () => bitmap.close() }
  }
  // Safari の一部バージョンなど createImageBitmap が無い環境向けの回退経路。
  const url = URL.createObjectURL(file)
  const img = new Image()
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => reject(new Error('failed to decode image'))
    img.src = url
  })
  return { source: img, width: img.naturalWidth, height: img.naturalHeight, cleanup: () => URL.revokeObjectURL(url) }
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), type, quality))
}

/**
 * 自传图压缩：最长边缩到 {@link MAX_IMAGE_EDGE}，导出 webp（质量 {@link IMAGE_QUALITY}）。
 * Safari 部分版本 `canvas.toBlob('image/webp')` 不支持编码时会静默回退成 PNG——
 * 通过检查返回 Blob 的 `type` 是否真的是 webp 来判断，不是则改用 jpeg 显式重新编码。
 */
async function compressImageForBackground(file: File): Promise<Blob> {
  if (!file.type.startsWith('image/')) throw new Error('selected file is not an image')

  const drawable = await loadDrawableImage(file)
  try {
    if (drawable.width <= 0 || drawable.height <= 0) throw new Error('image has no visible size')
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(drawable.width, drawable.height))
    const width = Math.max(1, Math.round(drawable.width * scale))
    const height = Math.max(1, Math.round(drawable.height * scale))

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('canvas 2d context unavailable')
    ctx.drawImage(drawable.source, 0, 0, width, height)

    const webp = await canvasToBlob(canvas, 'image/webp', IMAGE_QUALITY)
    if (webp && webp.type === 'image/webp') return webp

    const jpeg = await canvasToBlob(canvas, 'image/jpeg', IMAGE_QUALITY)
    if (jpeg) return jpeg

    throw new Error('failed to encode compressed image')
  } finally {
    drawable.cleanup()
  }
}
