'use client'

import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import NextLink from 'next/link'
import { Alert, Button, Card, CardBody, CardHeader, Input, Link as HeroLink, Spinner } from '@heroui/react'
import { formatRoomCode, normalizeRoomCode } from '@/lib/room-code'
import { getLastDisplayName, saveJoinDraft, setLastDisplayName } from '@/lib/store/join-storage'
import { joinErrorMessage, useLocale, uiText } from '@/lib/ui-text'
import { LocaleSwitcher } from '@/components/LocaleSwitcher'

/**
 * GET /api/rooms/{roomCode}/meta の応答形状（規格書 §6.2）。
 * lib/server/** は WP-4 の対象外なので DTO 型を import せず、公開されている
 * HTTP 契約の形だけをここに写す（バックエンドは既に実装・実測済み — API 応答自体は
 * 信頼できる事実源として扱い、型はこちら側で契約通りに宣言するだけでよい）。
 */
interface RoomMeta {
  exists: boolean
  title: string
  requiresPassword: boolean
  requireLogin: boolean
  isFull: boolean
  status: 'active' | 'ended' | 'expired'
}

type MetaFetchState = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; meta: RoomMeta }

export function JoinEntryView({ roomCode: rawRoomCode }: { roomCode: string }) {
  const roomCode = normalizeRoomCode(rawRoomCode)
  const router = useRouter()
  const searchParams = useSearchParams()
  const locale = useLocale()
  const t = uiText[locale]

  const [state, setState] = useState<MetaFetchState>({ kind: 'loading' })
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [isNavigating, setIsNavigating] = useState(false)

  const notice = searchParams.get('left') === '1' ? 'left' : searchParams.get('ended') === 'host' ? 'ended' : null
  const errorCode = searchParams.get('error')
  const strippedQueryOnce = useRef(false)

  const loadMeta = async () => {
    setState({ kind: 'loading' })
    try {
      const res = await fetch(`/api/rooms/${roomCode}/meta`)
      if (!res.ok) {
        setState({ kind: 'error' })
        return
      }
      const meta = (await res.json()) as RoomMeta
      setState({ kind: 'ready', meta })
    } catch {
      setState({ kind: 'error' })
    }
  }

  useEffect(() => {
    loadMeta()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomCode])

  // 前回の表示名を localStorage から復元。SSR とのハイドレーション不一致を避けるため
  // 初期値は空のままにし、マウント後（クライアントのみ）に一度だけ反映する。
  useEffect(() => {
    const last = getLastDisplayName()
    if (last) setDisplayName(last)
  }, [])

  // ?error=CODE はプレジョインでの失敗（主に INVALID_PASSWORD）を戻して表示するためのもの。
  // 一度見せたら URL から取り除く（リロード時に再表示されないように）。
  useEffect(() => {
    if (errorCode && !strippedQueryOnce.current) {
      strippedQueryOnce.current = true
      setSubmitError(joinErrorMessage(errorCode, locale))
      const params = new URLSearchParams(searchParams.toString())
      params.delete('error')
      const qs = params.toString()
      router.replace(qs ? `/j/${roomCode}?${qs}` : `/j/${roomCode}`)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [errorCode, locale])

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (state.kind !== 'ready' || !state.meta.exists) return
    setFormError(null)

    const trimmedName = displayName.trim()
    if (trimmedName.length === 0) {
      setFormError(t.joinEntry.displayNameRequired)
      return
    }
    if (state.meta.requiresPassword && password.length === 0) {
      setFormError(t.joinEntry.passwordRequired)
      return
    }

    setLastDisplayName(trimmedName)
    saveJoinDraft(roomCode, {
      displayName: trimmedName,
      password: state.meta.requiresPassword ? password : undefined,
    })
    setIsNavigating(true)
    router.push(`/j/${roomCode}/prejoin`)
  }

  // min-h-dvh（旧 min-h-screen＝100vh）：iOS Safari の 100vh は「ツールバーを畳んだときの
  // 最大ビューポート」なので、ツールバーが出ている間はページ末尾がその裏に隠れる。
  // dvh は実際に見えている高さに追従する（2026-08-16 実機フィードバック①）。
  return (
    <main className="relative flex min-h-dvh items-center justify-center px-6 py-10">
      <LocaleSwitcher className="absolute right-4 top-4" />
      <Card className="w-full max-w-sm">
        <CardHeader className="flex-col items-start gap-1 pb-0">
          <h1 className="text-xl font-semibold">{t.common.appName}</h1>
          {state.kind === 'ready' && state.meta.exists && (
            <p className="text-sm text-neutral-500">{state.meta.title}</p>
          )}
          <p className="font-mono text-xs text-neutral-400">{formatRoomCode(roomCode)}</p>
        </CardHeader>
        <CardBody className="gap-4">
          {notice === 'left' && <Alert color="success" variant="flat" description={t.joinEntry.leftNotice} />}
          {notice === 'ended' && <Alert color="warning" variant="flat" description={t.joinEntry.endedByHostNotice} />}

          {state.kind === 'loading' && (
            <div className="flex items-center justify-center gap-2 py-6 text-neutral-500">
              <Spinner size="sm" />
              <span className="text-sm">{t.joinEntry.loadingMeta}</span>
            </div>
          )}

          {state.kind === 'error' && (
            <div className="flex flex-col items-center gap-3 py-4">
              <Alert color="danger" variant="flat" description={t.joinEntry.networkError} />
              <Button size="sm" variant="flat" onPress={loadMeta}>
                {t.common.retry}
              </Button>
            </div>
          )}

          {state.kind === 'ready' && !state.meta.exists && (
            <RoomUnavailableNotice
              title={t.joinEntry.notFoundTitle}
              body={t.joinEntry.notFoundBody}
              backHomeLabel={t.common.backHome}
            />
          )}

          {state.kind === 'ready' && state.meta.exists && state.meta.status === 'expired' && (
            <RoomUnavailableNotice
              title={t.joinEntry.expiredTitle}
              body={t.joinEntry.expiredBody}
              backHomeLabel={t.common.backHome}
            />
          )}

          {state.kind === 'ready' && state.meta.exists && state.meta.status === 'ended' && (
            <RoomUnavailableNotice
              title={t.joinEntry.endedTitle}
              body={t.joinEntry.endedBody}
              backHomeLabel={t.common.backHome}
            />
          )}

          {state.kind === 'ready' && state.meta.exists && state.meta.status === 'active' && (
            <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
              {submitError && <Alert color="danger" variant="flat" description={submitError} />}
              {state.meta.requireLogin && (
                <Alert
                  color="primary"
                  variant="flat"
                  description={
                    <span>
                      {t.joinEntry.loginRequiredNotice}{' '}
                      <HeroLink as={NextLink} href={`/login?next=/j/${roomCode}`} size="sm">
                        {t.joinEntry.loginCta}
                      </HeroLink>
                    </span>
                  }
                />
              )}
              {state.meta.isFull && (
                <Alert color="warning" variant="flat" description={t.joinEntry.fullNotice} />
              )}
              {formError && <Alert color="danger" variant="flat" description={formError} />}

              <Input
                label={t.joinEntry.displayNameLabel}
                placeholder={t.joinEntry.displayNamePlaceholder}
                value={displayName}
                onValueChange={setDisplayName}
                isRequired
                maxLength={50}
                autoComplete="name"
              />
              {state.meta.requiresPassword && (
                <Input
                  type="password"
                  label={t.joinEntry.passwordLabel}
                  value={password}
                  onValueChange={setPassword}
                  isRequired
                  autoComplete="off"
                />
              )}
              <Button type="submit" color="primary" isLoading={isNavigating}>
                {t.joinEntry.submit}
              </Button>
            </form>
          )}
        </CardBody>
      </Card>
    </main>
  )
}

function RoomUnavailableNotice({
  title,
  body,
  backHomeLabel,
}: {
  title: string
  body: string
  backHomeLabel: string
}) {
  return (
    <div className="flex flex-col items-center gap-3 py-4 text-center">
      <h2 className="text-base font-medium text-neutral-800">{title}</h2>
      <p className="text-sm text-neutral-500">{body}</p>
      <Button as={NextLink} href="/" variant="flat" size="sm">
        {backHomeLabel}
      </Button>
    </div>
  )
}
