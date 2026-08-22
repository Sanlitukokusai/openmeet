'use client'

import { Button, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@heroui/react'
import { useLocale, uiText } from '@/lib/ui-text'

/**
 * 破壊的操作（削除・会議の強制終了）の確認ダイアログ。汎用化して 2 か所から使い回す
 * ——文面と色だけ呼び出し側が決める（ui-ux-pro-max: confirmation-dialogs /
 * destructive-action-confirm）。ロード中は閉じられない（isDismissable={!isLoading}）
 * ことで二重送信・送信中の取り消しによる状態不整合を防ぐ。
 */
export function ConfirmActionModal({
  isOpen,
  onOpenChange,
  title,
  description,
  confirmLabel,
  confirmColor = 'danger',
  isLoading,
  onConfirm,
}: {
  isOpen: boolean
  onOpenChange: () => void
  title: string
  description: string
  confirmLabel: string
  confirmColor?: 'danger' | 'warning' | 'primary'
  isLoading: boolean
  onConfirm: () => void
}) {
  const locale = useLocale()
  const t = uiText[locale]
  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} isDismissable={!isLoading} isKeyboardDismissDisabled={isLoading}>
      <ModalContent>
        {(onClose) => (
          <>
            <ModalHeader>{title}</ModalHeader>
            <ModalBody>
              <p className="text-sm text-neutral-500">{description}</p>
            </ModalBody>
            <ModalFooter>
              <Button variant="flat" onPress={onClose} isDisabled={isLoading}>
                {t.common.cancel}
              </Button>
              <Button color={confirmColor} onPress={onConfirm} isLoading={isLoading}>
                {confirmLabel}
              </Button>
            </ModalFooter>
          </>
        )}
      </ModalContent>
    </Modal>
  )
}
