'use client'

import { useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import NextLink from 'next/link'
import { Button, Input, Link as HeroLink } from '@heroui/react'
import { normalizeRoomCode } from '@/lib/room-code'
import { useLocale, uiText } from '@/lib/ui-text'
import { LocaleSwitcher } from '@/components/LocaleSwitcher'

export default function HomePage() {
  const router = useRouter()
  const locale = useLocale()
  const t = uiText[locale]
  const [roomCode, setRoomCode] = useState('')
  const [error, setError] = useState<string | null>(null)

  function handleJoinByCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const normalized = normalizeRoomCode(roomCode)
    if (normalized.length === 0) {
      setError(t.home.roomCodeRequired)
      return
    }
    setError(null)
    router.push(`/j/${normalized}`)
  }

  return (
    <main className="relative flex min-h-screen flex-col items-center justify-center gap-8 px-6 text-center">
      <LocaleSwitcher className="absolute right-4 top-4" />
      <div className="flex flex-col items-center gap-4">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{t.common.appName}</h1>
        <p className="max-w-md text-base text-neutral-600">{t.home.subtitle}</p>
      </div>

      <div className="flex items-center gap-4">
        <HeroLink as={NextLink} href="/login" size="sm">
          {t.home.loginLink}
        </HeroLink>
        <span className="text-neutral-300">|</span>
        <HeroLink as={NextLink} href="/dashboard" size="sm">
          {t.home.dashboardLink}
        </HeroLink>
      </div>

      <form onSubmit={handleJoinByCode} className="flex w-full max-w-xs flex-col gap-2">
        <Input
          label={t.home.roomCodeLabel}
          placeholder={t.home.roomCodePlaceholder}
          value={roomCode}
          onValueChange={setRoomCode}
          isInvalid={error !== null}
          errorMessage={error}
          autoComplete="off"
        />
        <Button type="submit" color="primary" variant="flat">
          {t.home.roomCodeSubmit}
        </Button>
      </form>
    </main>
  )
}
