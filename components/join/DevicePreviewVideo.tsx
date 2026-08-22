'use client'

import type { RefObject } from 'react'
import { Avatar, Spinner } from '@heroui/react'
import { CameraOffIcon } from '@/components/icons'
import { initialsOf } from '@/components/display-name'

/**
 * prejoin 専用のプレビュー表示。**素の `<video>` の置き場所**に徹する薄い層で、
 * 中身（トラックの取得・attach・背景処理管線）は呼び出し側が持つ
 * `BackgroundPreviewSession` が受け持つ。
 *
 * 2026-08-16（実機フィードバック③）：それまでは呼び出し側が `getUserMedia` で取った
 * `MediaStream` を props で受けて `srcObject` に差していたが、背景効果を**その場で**
 * 見せるには LiveKit の LocalVideoTrack（＝会議内と同じ管線）を attach する必要がある。
 * attach 先は DOM 要素そのものなので、props を `stream` から **`videoRef`** に変えた。
 *  - このコンポーネントは `srcObject` に一切触らない（二重管理で「片方が消す」事故を防ぐ）。
 *  - 縦横比はモバイルのみ 3:4（スマホのインカメラは縦持ち前提。実機フィードバック②）。
 *    デスクトップは従来どおり 16:9。
 */
export function DevicePreviewVideo({
  videoRef,
  isVideoVisible,
  isBusy,
  busyLabel,
  displayName,
  cameraOffLabel,
}: {
  /** 呼び出し側が保持する `<video>` への ref（プレビューセッションの attach 先）。 */
  videoRef: RefObject<HTMLVideoElement | null>
  /** 映像を見せてよいか（カメラ取得済み & カメラ ON）。false の間はプレースホルダー。 */
  isVideoVisible: boolean
  /** カメラ起動中・背景モデルの初回ダウンロード中など。映像の上にスピナーを重ねる。 */
  isBusy: boolean
  busyLabel: string
  displayName: string
  cameraOffLabel: string
}) {
  return (
    <div className="relative flex aspect-[3/4] w-full items-center justify-center overflow-hidden rounded-2xl bg-zinc-800 md:aspect-video">
      <video
        ref={videoRef}
        muted
        playsInline
        autoPlay
        className={`h-full w-full object-cover ${isVideoVisible ? '' : 'hidden'}`}
      />
      {!isVideoVisible && (
        <div className="flex flex-col items-center gap-2 text-zinc-400">
          <Avatar name={displayName ? initialsOf(displayName) : undefined} className="h-16 w-16 text-large" />
          <span className="flex items-center gap-1.5 text-xs">
            <CameraOffIcon className="h-3.5 w-3.5" />
            {cameraOffLabel}
          </span>
        </div>
      )}
      {isBusy && (
        // 「本当に処理が走っている」ことを示す実 loading（背景モデルの初回取得は ~9.7MB）。
        // aria-live で読み上げにも出す——見えない待ちを作らない。
        <div
          className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/50"
          aria-live="polite"
        >
          <Spinner size="sm" color="white" />
          <span className="text-xs text-white">{busyLabel}</span>
        </div>
      )}
    </div>
  )
}
