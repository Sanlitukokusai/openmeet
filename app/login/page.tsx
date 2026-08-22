'use client'

import { Suspense, useState, type FormEvent } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import NextLink from 'next/link'
import { Alert, Button, Card, CardBody, CardHeader, Input, Link as HeroLink } from '@heroui/react'
import { safeNextPath } from '@/lib/safe-next'
import { resolveApiErrorMessage, useLocale, uiText } from '@/lib/ui-text'
import { LocaleSwitcher } from '@/components/LocaleSwitcher'

// このページは自前の /api/auth/login を fetch するだけで、Supabase の import は
// 一切行わない（規格书 §8.3：ブラウザは Supabase に直接繋がない）。
function LoginForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const locale = useLocale()
  const t = uiText[locale]
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setIsSubmitting(true)
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      const json = await res.json()
      if (!res.ok) {
        const code = json?.error?.code as string | undefined
        // AUTH_FAILED（メール/パスワード誤り等）はこのページ専用の文言に差し替える
        // ——サーバーの message は Supabase SDK 由来の英語で言語非対応のため。
        setError(
          code === 'AUTH_FAILED'
            ? t.auth.loginAuthFailed
            : resolveApiErrorMessage(code, ['VALIDATION_ERROR'], json?.error?.message, t.auth.loginFailedFallback),
        )
        return
      }
      // ?next= はサイト内パスのみ許可（safeNextPath＝オープンリダイレクト対策）。
      router.push(safeNextPath(searchParams.get('next')))
      router.refresh()
    } catch {
      setError(t.common.networkError)
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
      {error && <Alert color="danger" variant="flat" title={t.auth.loginErrorTitle} description={error} />}
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
        label={t.auth.passwordLabel}
        value={password}
        onValueChange={setPassword}
        isRequired
        autoComplete="current-password"
      />
      <Button type="submit" color="primary" isLoading={isSubmitting}>
        {t.auth.loginSubmit}
      </Button>
      <p className="text-center text-sm text-neutral-500">
        {t.auth.noAccountPrompt}{' '}
        <HeroLink as={NextLink} href="/signup" size="sm">
          {t.auth.signupLink}
        </HeroLink>
      </p>
    </form>
  )
}

export default function LoginPage() {
  const locale = useLocale()
  const t = uiText[locale]
  return (
    <main className="relative flex min-h-screen items-center justify-center px-6">
      <LocaleSwitcher className="absolute right-4 top-4" />
      <Card className="w-full max-w-sm">
        <CardHeader className="flex-col items-start gap-1 pb-0">
          <h1 className="text-xl font-semibold">{t.auth.loginTitle}</h1>
          <p className="text-sm text-neutral-500">{t.auth.loginSubtitle}</p>
        </CardHeader>
        <CardBody>
          {/* useSearchParams を使うため Suspense 境界が必要（Next.js 15） */}
          <Suspense fallback={<div className="h-64" aria-hidden />}>
            <LoginForm />
          </Suspense>
        </CardBody>
      </Card>
    </main>
  )
}
