'use client'

import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, Button } from '@heroui/react'
import type { UiTextDict } from '@/lib/ui-text'

/**
 * 「全員をミュート」の確認ダイアログ（2026-08-07）。
 *
 * 会議終了ほど不可逆ではない（参加者は自分で開き直せる）が、他人のマイクを一斉に
 * 止める操作なので確認を挟む——本文でも「自分は対象外」「相手は再度オンにできる」の
 * 2 点を明示する（ui-ux-pro-max: confirmation-dialogs は"何が起きるか"を書けと言っている）。
 * 送信中は閉じられない（二重送信防止）。
 */
export function MuteAllModal({
  isOpen,
  onOpenChange,
  onConfirm,
  isMuting,
  text,
}: {
  isOpen: boolean
  onOpenChange: () => void
  onConfirm: () => void
  isMuting: boolean
  text: UiTextDict
}) {
  const t = text.mute
  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} isDismissable={!isMuting} isKeyboardDismissDisabled={isMuting}>
      <ModalContent>
        {(onClose) => (
          <>
            <ModalHeader>{t.muteAllConfirmTitle}</ModalHeader>
            <ModalBody>
              <p className="text-sm text-neutral-500">{t.muteAllConfirmBody}</p>
            </ModalBody>
            <ModalFooter>
              <Button variant="flat" onPress={onClose} isDisabled={isMuting}>
                {text.common.cancel}
              </Button>
              <Button color="warning" onPress={onConfirm} isLoading={isMuting}>
                {t.muteAllConfirm}
              </Button>
            </ModalFooter>
          </>
        )}
      </ModalContent>
    </Modal>
  )
}
