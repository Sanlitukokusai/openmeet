'use client'

import { useState, type FormEvent } from 'react'
import NextLink from 'next/link'
import { Alert, Button, Card, CardBody, CardHeader, Input, NumberInput, Switch } from '@heroui/react'
import { formatRoomCode } from '@/lib/room-code'
import { interpolate, resolveApiErrorMessage, useLocale, uiText } from '@/lib/ui-text'

interface CreateRoomResult {
  id: string
  roomCode: string
  joinUrl: string
  expiresAt: string | null
}

export default function NewRoomPage() {
  const locale = useLocale()
  const t = uiText[locale]
  const [title, setTitle] = useState('')
  const [password, setPassword] = useState('')
  const [maxParticipants, setMaxParticipants] = useState(10)
  const [requireLogin, setRequireLogin] = useState(false)
  const [scheduledAt, setScheduledAt] = useState('')
  const [expiresAt, setExpiresAt] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [result, setResult] = useState<CreateRoomResult | null>(null)
  const [createdPassword, setCreatedPassword] = useState('')
  const [copied, setCopied] = useState(false)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setIsSubmitting(true)
    try {
      const payload: Record<string, unknown> = { title, maxParticipants, requireLogin }
      if (password) payload.password = password
      if (scheduledAt) payload.scheduledAt = new Date(scheduledAt).toISOString()
      if (expiresAt) payload.expiresAt = new Date(expiresAt).toISOString()

      const res = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const json = await res.json()
      if (!res.ok) {
        setError(
          resolveApiErrorMessage(
            json?.error?.code,
            ['UNAUTHORIZED', 'VALIDATION_ERROR', 'INTERNAL_ERROR'],
            json?.error?.message,
            t.roomForm.createFailedFallback,
          ),
        )
        return
      }
      setResult(json)
      // 送信時点でユーザーが入力した平文パスワードをページ内に保持して一度だけ表示する
      // ——サーバーはハッシュしか保存せず、レスポンスにも平文パスワードは含まれない。
      setCreatedPassword(password)
    } catch {
      setError(t.common.networkError)
    } finally {
      setIsSubmitting(false)
    }
  }

  async function handleCopy() {
    if (!result) return
    await navigator.clipboard.writeText(result.joinUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  function resetForm() {
    setResult(null)
    setCreatedPassword('')
    setCopied(false)
    setTitle('')
    setPassword('')
    setMaxParticipants(10)
    setRequireLogin(false)
    setScheduledAt('')
    setExpiresAt('')
  }

  if (result) {
    return (
      <main className="flex min-h-screen items-center justify-center px-6">
        <Card className="w-full max-w-md">
          <CardHeader className="flex-col items-start gap-1">
            <h1 className="text-xl font-semibold">{t.roomForm.successTitle}</h1>
          </CardHeader>
          <CardBody className="gap-4">
            <div>
              <p className="text-sm text-neutral-500">{t.roomForm.roomCodeLabel}</p>
              <p className="font-mono text-lg">{formatRoomCode(result.roomCode)}</p>
            </div>
            <div>
              <p className="text-sm text-neutral-500">{t.roomForm.joinLinkLabel}</p>
              <div className="flex items-center gap-2">
                <code className="flex-1 truncate rounded bg-neutral-100 px-2 py-1 text-sm">{result.joinUrl}</code>
                <Button size="sm" onPress={handleCopy}>
                  {copied ? t.common.linkCopied : t.roomForm.copyButton}
                </Button>
              </div>
            </div>
            {createdPassword && (
              <Alert
                color="warning"
                variant="flat"
                title={t.roomForm.passwordOnceTitle}
                description={interpolate(t.roomForm.passwordOnceBody, { password: createdPassword })}
              />
            )}
            <div className="flex gap-2">
              <Button as={NextLink} href="/dashboard" color="primary">
                {t.roomForm.goToDashboardButton}
              </Button>
              <Button variant="flat" onPress={resetForm}>
                {t.roomForm.createAnotherButton}
              </Button>
            </div>
          </CardBody>
        </Card>
      </main>
    )
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-6 py-10">
      <Card className="w-full max-w-md">
        <CardHeader className="flex-col items-start gap-1">
          <h1 className="text-xl font-semibold">{t.roomForm.createTitle}</h1>
        </CardHeader>
        <CardBody>
          <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
            {error && <Alert color="danger" variant="flat" title={t.roomForm.createErrorTitle} description={error} />}
            <Input label={t.roomForm.titleLabel} value={title} onValueChange={setTitle} isRequired maxLength={200} />
            <Input
              label={t.roomForm.passwordLabel}
              value={password}
              onValueChange={setPassword}
              description={t.roomForm.passwordDescription}
            />
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
            {/*
              HeroUI の Input はネイティブ <input type="datetime-local"> と組み合わせると
              labelPlacement="outside" でもラベルが入力欄と重なって表示される（ブラウザ側の
              日付ウィジェットが独自にプレースホルダー領域を描画するため）。ここだけラベルを
              通常の <label> として上に固定表示し、Input 自体には aria-label のみ渡す。
            */}
            <div className="flex flex-col gap-1.5">
              <label htmlFor="scheduledAt" className="px-1 text-sm text-neutral-600">
                {t.roomForm.scheduledAtLabel}
              </label>
              <Input
                id="scheduledAt"
                type="datetime-local"
                aria-label={t.roomForm.scheduledAtLabel}
                value={scheduledAt}
                onValueChange={setScheduledAt}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="expiresAt" className="px-1 text-sm text-neutral-600">
                {t.roomForm.expiresAtLabel}
              </label>
              <Input
                id="expiresAt"
                type="datetime-local"
                aria-label={t.roomForm.expiresAtLabel}
                value={expiresAt}
                onValueChange={setExpiresAt}
              />
            </div>
            <div className="flex gap-3">
              {/* 取消 = 返回 dashboard（表单未提交，无需确认——没有可丢失的服务端状态） */}
              <Button as={NextLink} href="/dashboard" variant="flat" className="flex-1" isDisabled={isSubmitting}>
                {t.common.cancel}
              </Button>
              <Button type="submit" color="primary" className="flex-1" isLoading={isSubmitting}>
                {t.roomForm.submitButton}
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>
    </main>
  )
}
