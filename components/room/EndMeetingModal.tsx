'use client'

import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, Button } from '@heroui/react'
import type { UiTextDict } from '@/lib/ui-text'

/** 破壊的操作の確認ダイアログ（ui-ux-pro-max confirmation-dialogs：全員が切断される不可逆操作）。 */
export function EndMeetingModal({
  isOpen,
  onOpenChange,
  onConfirm,
  isEnding,
  text,
}: {
  isOpen: boolean
  onOpenChange: () => void
  onConfirm: () => void
  isEnding: boolean
  text: UiTextDict
}) {
  const t = text.room
  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange}>
      <ModalContent>
        {(onClose) => (
          <>
            <ModalHeader>{t.endMeetingConfirmTitle}</ModalHeader>
            <ModalBody>
              <p className="text-sm text-neutral-500">{t.endMeetingConfirmBody}</p>
            </ModalBody>
            <ModalFooter>
              <Button variant="flat" onPress={onClose} isDisabled={isEnding}>
                {text.common.cancel}
              </Button>
              <Button color="danger" onPress={onConfirm} isLoading={isEnding}>
                {t.endMeetingConfirm}
              </Button>
            </ModalFooter>
          </>
        )}
      </ModalContent>
    </Modal>
  )
}
