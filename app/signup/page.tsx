'use client'

import { useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import NextLink from 'next/link'
import { Alert, Button, Card, CardBody, CardHeader, Input, Link as HeroLink } from '@heroui/react'
import { resolveApiErrorMessage, useLocale, uiText } from '@/lib/ui-text'
import { LocaleSwitcher } from '@/components/LocaleSwitcher'

// このページも自前の /api/auth/signup を fetch するだけ（Supabase import なし）。
export default function SignupPage() {
  const router = useRouter()
  const locale = useLocale()
  const t = uiText[locale]
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [needsConfirmation, setNeedsConfirmation] = useState(false)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setNeedsConfirmation(false)
    setIsSubmitting(true)
    try {
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      const json = await res.json()
      if (!res.ok) {
        const code = json?.error?.code as string | undefined
        // AUTH_FAILED（登録済みのメールアドレス等）はこのページ専用の文言に差し替える
        // ——サーバーの message は Supabase SDK 由来の英語で言語非対応のため。
        setError(
          code === 'AUTH_FAILED'
            ? t.auth.signupAuthFailed
            : resolveApiErrorMessage(code, ['VALIDATION_ERROR'], json?.error?.message, t.auth.signupFailedFallback),
        )
        return
      }
      if (json.needsEmailConfirmation) {
        setNeedsConfirmation(true)
        return
      }
      router.push('/dashboard')
      router.refresh()
    } catch {
      setError(t.common.networkError)
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <main className="relative flex min-h-screen items-center justify-center px-6">
      <LocaleSwitcher className="absolute right-4 top-4" />
      <Card className="w-full max-w-sm">
        <CardHeader className="flex-col items-start gap-1 pb-0">
          <h1 className="text-xl font-semibold">{t.auth.signupTitle}</h1>
          <p className="text-sm text-neutral-500">{t.auth.signupSubtitle}</p>
        </CardHeader>
        <CardBody>
          {needsConfirmation ? (
            <Alert
              color="success"
              variant="flat"
              title={t.auth.confirmEmailSentTitle}
              description={t.auth.confirmEmailSentBody}
            />
          ) : (
            <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
              {error && <Alert color="danger" variant="flat" title={t.auth.signupErrorTitle} description={error} />}
              <Input
                type="email"
                label={t.auth.emailLabel}
                value={email}
                onValueChange={setEmail}
                isRequired
                autoComplete="email"
              />
              <Input
                type="password"
                label={t.auth.signupPasswordLabel}
                value={password}
                onValueChange={setPassword}
                isRequired
                autoComplete="new-password"
              />
              <Button type="submit" color="primary" isLoading={isSubmitting}>
                {t.auth.signupSubmit}
              </Button>
            </form>
          )}
          <p className="mt-4 text-center text-sm text-neutral-500">
            {t.auth.haveAccountPrompt}{' '}
            <HeroLink as={NextLink} href="/login" size="sm">
              {t.auth.loginLink}
            </HeroLink>
          </p>
        </CardBody>
      </Card>
    </main>
  )
}
