'use client'

import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, Button } from '@heroui/react'
import type { UiTextDict } from '@/lib/ui-text'

/**
 * 「退出」の確認ダイアログ（2026-08-16 実機フィードバック）。
 *
 * 現状はコントロールバーの赤い「退出」ボタンを押した瞬間に即断線していた——誤タップの
 * コストが大きい（モバイルはボタン間隔が狭く、隣の「その他」メニューやチャットとの
 * 誤タップも起きやすい）。EndMeetingModal / MuteAllModal と同じ形（ModalHeader/Body/Footer、
 * キャンセル＝flat、確定＝色付き、isDismissable の絞り込みなし＝送信中の待機が無いため）
 * をそのまま踏襲する。
 *
 * EndMeetingModal との書き分け：
 *  - 終了は**全員**が切断される不可逆操作、退出は**自分だけ**（他の参加者は継続、
 *    自分もリンクから再入室できる）。それでも確定ボタンは danger のまま——理由は重さの
 *    違いではなく、コントロールバーの退出ボタン自体が既に赤（電話を切るアイコン）なので、
 *    確認ダイアログでも同じ色を保つことで「これはさっきの赤いボタンの続き」だと
 *    一目で分かるようにするため（Zoom 等の一般的な「退出」確認も同様に赤系）。
 *  - isLoading 相当の prop を持たない：handleLeave（RoomExperience）は
 *    provider.disconnect() を void で呼び捨て、sessionStorage 削除、router.push だけの
 *    同期的な処理で、ネットワーク応答を待つ必要が無い。確定を押した瞬間にモーダルを閉じて
 *    退出処理へ進んでよい（EndMeetingModal / MuteAllModal は実際の API 応答を待つので
 *    isEnding / isMuting を持つ——ここは前提が違う）。
 */
export function LeaveConfirmModal({
  isOpen,
  onOpenChange,
  onConfirm,
  text,
}: {
  isOpen: boolean
  onOpenChange: () => void
  onConfirm: () => void
  text: UiTextDict
}) {
  const t = text.room
  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange}>
      <ModalContent>
        {(onClose) => (
          <>
            <ModalHeader>{t.leaveConfirmTitle}</ModalHeader>
            <ModalBody>
              <p className="text-sm text-neutral-500">{t.leaveConfirmBody}</p>
            </ModalBody>
            <ModalFooter>
              <Button variant="flat" onPress={onClose}>
                {text.common.cancel}
              </Button>
              <Button color="danger" onPress={onConfirm}>
                {t.leaveConfirm}
              </Button>
            </ModalFooter>
          </>
        )}
      </ModalContent>
    </Modal>
  )
}
