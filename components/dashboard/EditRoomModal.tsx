'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  Alert,
  Button,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  NumberInput,
  Radio,
  RadioGroup,
  Spinner,
  Switch,
} from '@heroui/react'
// 型だけの import。lib/server/rooms-logic.ts は先頭で zod を import しており、実行時
// import するとクライアントバンドルに zod ごと持ち込んでしまうため（app/dashboard/page.tsx
// と同じ理由）、型情報だけをコンパイル時に取り込む。
import type { RoomDTO } from '@/lib/server/rooms-logic'
import {
  computeRoomPatchDiff,
  isEmptyPatch,
  isoToLocalDateTime,
  validateRoomEditForm,
  type PasswordEditMode,
  type RoomEditBaseline,
} from '@/app/dashboard/room-actions'
import { resolveApiErrorMessage, useLocale, uiText } from '@/lib/ui-text'

type LoadPhase = 'loading' | 'ready' | 'error'

/**
 * 編集モーダル：開かれるたびに GET /api/rooms/{id} で最新値を取得してからプリフィルする
 * （一覧の §6.1 白名单には maxParticipants/requireLogin/hasPassword が無いため）。
 * 送信は PATCH の部分更新契約に合わせ、実際に変更されたフィールドだけを送る
 * （computeRoomPatchDiff、tests/rooms/dashboard-actions.test.ts で検証済み）。
 */
export function EditRoomModal({
  isOpen,
  roomId,
  onOpenChange,
  onSaved,
  onNotFound,
}: {
  isOpen: boolean
  roomId: string | null
  onOpenChange: () => void
  onSaved: (updated: RoomDTO) => void
  onNotFound: () => void
}) {
  const router = useRouter()
  const locale = useLocale()
  const t = uiText[locale]
  const [phase, setPhase] = useState<LoadPhase>('loading')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [baseline, setBaseline] = useState<RoomEditBaseline | null>(null)
  const [hasPassword, setHasPassword] = useState(false)

  const [title, setTitle] = useState('')
  const [maxParticipants, setMaxParticipants] = useState(2)
  const [expiresAtLocal, setExpiresAtLocal] = useState('')
  const [requireLogin, setRequireLogin] = useState(false)
  const [passwordMode, setPasswordMode] = useState<PasswordEditMode>('unchanged')
  const [newPassword, setNewPassword] = useState('')

  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  // モーダルが開く（＝ roomId が渡される）たびに最新値を取り直す。ignore フラグで
  // 「開く→即閉じる→別の部屋を開く」のような競合時に古い応答で状態を上書きしない。
  useEffect(() => {
    if (!isOpen || !roomId) return
    let ignore = false
    setPhase('loading')
    setLoadError(null)
    setSubmitError(null)

    async function load() {
      try {
        const res = await fetch(`/api/rooms/${roomId}`)
        if (ignore) return
        if (res.status === 401) {
          router.push('/login')
          return
        }
        if (res.status === 404) {
          onNotFound()
          return
        }
        const json = await res.json()
        if (!res.ok) {
          setLoadError(resolveApiErrorMessage(json?.error?.code, ['INTERNAL_ERROR'], json?.error?.message, t.dashboard.editLoadFailedFallback))
          setPhase('error')
          return
        }
        const dto = json as RoomDTO
        const nextBaseline: RoomEditBaseline = {
          title: dto.title,
          maxParticipants: dto.maxParticipants,
          expiresAtLocal: isoToLocalDateTime(dto.expiresAt),
          requireLogin: dto.requireLogin,
        }
        setBaseline(nextBaseline)
        setHasPassword(dto.hasPassword)
        setTitle(nextBaseline.title)
        setMaxParticipants(nextBaseline.maxParticipants)
        setExpiresAtLocal(nextBaseline.expiresAtLocal)
        setRequireLogin(nextBaseline.requireLogin)
        setPasswordMode('unchanged')
        setNewPassword('')
        setPhase('ready')
      } catch {
        if (!ignore) {
          setLoadError(t.common.networkError)
          setPhase('error')
        }
      }
    }
    void load()
    return () => {
      ignore = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, roomId, router, onNotFound, locale])

  const formValues = useMemo(
    () => ({ title, maxParticipants, expiresAtLocal, requireLogin, passwordMode, newPassword }),
    [title, maxParticipants, expiresAtLocal, requireLogin, passwordMode, newPassword],
  )

  const diff = useMemo(() => (baseline ? computeRoomPatchDiff(baseline, formValues) : {}), [baseline, formValues])
  const noChanges = isEmptyPatch(diff)
  // locale を依存に含める：切り替え直後もバリデーション文言が正しい言語で出るように
  // （入力自体は変わらなくても表示文言だけは locale に追随する必要がある）。
  const validationError = useMemo(() => validateRoomEditForm(formValues, locale), [formValues, locale])

  const handleSubmit = useCallback(async () => {
    if (!roomId || noChanges || validationError) return
    setIsSubmitting(true)
    setSubmitError(null)
    try {
      const res = await fetch(`/api/rooms/${roomId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(diff),
      })
      if (res.status === 401) {
        router.push('/login')
        return
      }
      if (res.status === 404) {
        onNotFound()
        return
      }
      const json = await res.json()
      if (!res.ok) {
        setSubmitError(
          resolveApiErrorMessage(json?.error?.code, ['VALIDATION_ERROR', 'INTERNAL_ERROR'], json?.error?.message, t.dashboard.editSaveFailedFallback),
        )
        return
      }
      onSaved(json as RoomDTO)
    } catch {
      setSubmitError(t.common.networkError)
    } finally {
      setIsSubmitting(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, noChanges, validationError, diff, router, onNotFound, onSaved, locale])

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      isDismissable={!isSubmitting}
      isKeyboardDismissDisabled={isSubmitting}
    >
      <ModalContent>
        {(onClose) => (
          <>
            <ModalHeader>{t.dashboard.editModalTitle}</ModalHeader>
            <ModalBody className="gap-4 pb-2">
              {phase === 'loading' && (
                <div className="flex justify-center py-8">
                  <Spinner label={t.common.loading} />
                </div>
              )}

              {phase === 'error' && (
                <Alert color="danger" variant="flat" title={t.dashboard.editLoadErrorTitle} description={loadError ?? ''} />
              )}

              {phase === 'ready' && (
                <>
                  {submitError && (
                    <Alert color="danger" variant="flat" title={t.dashboard.editSaveErrorTitle} description={submitError} />
                  )}
                  {!submitError && validationError && <Alert color="warning" variant="flat" description={validationError} />}

                  <Input label={t.roomForm.titleLabel} value={title} onValueChange={setTitle} isRequired maxLength={200} />

                  <NumberInput
                    label={t.roomForm.maxParticipantsLabel}
                    value={maxParticipants}
                    onValueChange={setMaxParticipants}
                    minValue={2}
                    maxValue={50}
                  />

                  <Switch isSelected={requireLogin} onValueChange={setRequireLogin}>
                    {t.roomForm.requireLoginLabel}
                  </Switch>

                  {/* datetime-local と HeroUI Input のラベル重なり対策は app/rooms/new/page.tsx と同じ */}
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="edit-expiresAt" className="px-1 text-sm text-neutral-600">
                      {t.dashboard.editExpiresLabel}
                    </label>
                    <Input
                      id="edit-expiresAt"
                      type="datetime-local"
                      aria-label={t.dashboard.editExpiresAriaLabel}
                      value={expiresAtLocal}
                      onValueChange={setExpiresAtLocal}
                    />
                  </div>

                  <RadioGroup
                    label={t.dashboard.editPasswordGroupLabel}
                    value={passwordMode}
                    onValueChange={(value) => setPasswordMode(value as PasswordEditMode)}
                  >
                    <Radio value="unchanged">{t.dashboard.editPasswordUnchanged}</Radio>
                    <Radio value="set">{t.dashboard.editPasswordSet}</Radio>
                    <Radio
                      value="clear"
                      isDisabled={!hasPassword}
                      description={!hasPassword ? t.dashboard.editPasswordClearHint : undefined}
                    >
                      {t.dashboard.editPasswordClear}
                    </Radio>
                  </RadioGroup>

                  {passwordMode === 'set' && (
                    <Input
                      label={t.dashboard.editNewPasswordLabel}
                      value={newPassword}
                      onValueChange={setNewPassword}
                      maxLength={8}
                      isRequired
                    />
                  )}
                </>
              )}
            </ModalBody>
            <ModalFooter>
              <Button variant="flat" onPress={onClose} isDisabled={isSubmitting}>
                {t.common.cancel}
              </Button>
              {phase === 'ready' && (
                <Button
                  color="primary"
                  onPress={handleSubmit}
                  isLoading={isSubmitting}
                  isDisabled={noChanges || !!validationError}
                >
                  {t.dashboard.editSaveButton}
                </Button>
              )}
            </ModalFooter>
          </>
        )}
      </ModalContent>
    </Modal>
  )
}
