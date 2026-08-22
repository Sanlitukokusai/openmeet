'use client'

import { Divider, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, Button, Select, SelectItem } from '@heroui/react'
import type { MediaDeviceEntry } from '@/lib/media/types'
import type { BackgroundSelection } from '@/lib/background-storage'
import type { UiTextDict } from '@/lib/ui-text'
import { BackgroundPicker } from '@/components/BackgroundPicker'
import { LocaleSwitcher } from '@/components/LocaleSwitcher'

/**
 * デバイス切替モーダル。選択肢が 0〜1 件しかない種別は Select 自体を出さない
 * （切り替えようがないものを見せない＝偽の操作を置かない、という本プロジェクトの方針）。
 * スピーカー選択は §3.2 の契約どおり「非対応ブラウザでは静默忽略」——ここでは
 * livekit-client の対応判定 API を呼ばず（呼べば §3.1 の import 制限に触れる）、
 * enumerateDevices が audiooutput を返さない環境では自然に選択肢 0 件になり
 * Select 自体が表示されなくなることで同じ結果になる。
 *
 * 2026-08-13 FR-7：「背景」セクションを追加。Tabs ではなく Divider 区切りのフラット
 * レイアウトを選んだのは意図的な判断——実測したところ `@heroui/tabs`（react-aria/
 * react-stately の tabs 一式を追加で引き込む）だけで room ルートの First Load JS が
 * 約 38KB 増える一方、この Divider 版は BackgroundPicker 込みでも +5KB 程度で収まる
 * （build 後の比較は最終レポート参照）。本タスクの受け入れ基準が「room 初期チャンクを
 * 膨らませない」を明記しているため、見た目の分離は Tabs でなく Divider + 小見出しで
 * 十分と判断した。背景タブの対応判定・適用処理は呼び出し側（RoomExperience）が
 * provider 経由で持っており、本モーダルは受け取った値をそのまま BackgroundPicker に
 * 渡すだけ。
 *
 * 2026-08-14 追加：モバイル（<md）では room 画面に常駐していた LocaleSwitcher の
 * フロート表示をやめる（映像を覆ってしまうため）ので、代わりの導線としてこのモーダル
 * の先頭に同じコンポーネントを再利用して置く。デスクトップ（md 以上）はフロート表示が
 * そのまま残っているので、ここでは `md:hidden` で二重表示を避ける。
 */
export function DeviceSettingsModal({
  isOpen,
  onOpenChange,
  audioInputs,
  videoInputs,
  audioOutputs,
  selectedAudioId,
  selectedVideoId,
  selectedAudioOutputId,
  onChangeAudio,
  onChangeVideo,
  onChangeAudioOutput,
  isBackgroundSupported,
  backgroundSelection,
  onSelectBackground,
  text,
}: {
  isOpen: boolean
  onOpenChange: () => void
  audioInputs: MediaDeviceEntry[]
  videoInputs: MediaDeviceEntry[]
  audioOutputs: MediaDeviceEntry[]
  selectedAudioId?: string
  selectedVideoId?: string
  selectedAudioOutputId?: string
  onChangeAudio: (deviceId: string) => void
  onChangeVideo: (deviceId: string) => void
  onChangeAudioOutput: (deviceId: string) => void
  /** provider.isBackgroundEffectSupported()（RoomExperience 側で算出済み）。 */
  isBackgroundSupported: boolean
  backgroundSelection: BackgroundSelection
  onSelectBackground: (selection: BackgroundSelection) => Promise<boolean>
  text: UiTextDict
}) {
  const t = text.room
  // マイク/カメラ/スピーカーの各ラベルは prejoin と文言を共有する（重複定義しない）。
  const deviceLabels = text.prejoin

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} size="lg">
      <ModalContent>
        {(onClose) => (
          <>
            <ModalHeader>{t.deviceSettings}</ModalHeader>
            <ModalBody className="gap-4 pb-2">
              <div className="flex justify-end md:hidden">
                <LocaleSwitcher />
              </div>

              {audioInputs.length > 0 && (
                <Select
                  label={deviceLabels.micDeviceLabel}
                  selectedKeys={selectedAudioId ? [selectedAudioId] : []}
                  onSelectionChange={(keys) => {
                    const id = Array.from(keys)[0]
                    if (typeof id === 'string') onChangeAudio(id)
                  }}
                >
                  {audioInputs.map((d) => (
                    <SelectItem key={d.deviceId}>{d.label}</SelectItem>
                  ))}
                </Select>
              )}
              {videoInputs.length > 0 && (
                <Select
                  label={deviceLabels.cameraDeviceLabel}
                  selectedKeys={selectedVideoId ? [selectedVideoId] : []}
                  onSelectionChange={(keys) => {
                    const id = Array.from(keys)[0]
                    if (typeof id === 'string') onChangeVideo(id)
                  }}
                >
                  {videoInputs.map((d) => (
                    <SelectItem key={d.deviceId}>{d.label}</SelectItem>
                  ))}
                </Select>
              )}
              {audioOutputs.length > 0 ? (
                <Select
                  label={deviceLabels.speakerDeviceLabel}
                  selectedKeys={selectedAudioOutputId ? [selectedAudioOutputId] : []}
                  onSelectionChange={(keys) => {
                    const id = Array.from(keys)[0]
                    if (typeof id === 'string') onChangeAudioOutput(id)
                  }}
                >
                  {audioOutputs.map((d) => (
                    <SelectItem key={d.deviceId}>{d.label}</SelectItem>
                  ))}
                </Select>
              ) : (
                <p className="text-xs text-zinc-400">{t.noAudioOutputNote}</p>
              )}

              <Divider />

              <div className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-foreground">{text.background.sectionTitle}</span>
                <BackgroundPicker
                  isSupported={isBackgroundSupported}
                  value={backgroundSelection}
                  onSelect={onSelectBackground}
                  text={text}
                />
              </div>
            </ModalBody>
            <ModalFooter>
              <Button variant="flat" onPress={onClose}>
                {text.common.confirm}
              </Button>
            </ModalFooter>
          </>
        )}
      </ModalContent>
    </Modal>
  )
}
