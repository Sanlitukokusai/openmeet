'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import NextLink from 'next/link'
import {
  Button,
  Chip,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableHeader,
  TableRow,
  ToastProvider,
  Tooltip,
  addToast,
} from '@heroui/react'
import { formatRoomCode } from '@/lib/room-code'
import { getRoomActionDisabledReason, isRoomActionEnabled } from '@/app/dashboard/room-actions'
// 型だけの import（`import type`）はコンパイル時に消えるため、lib/server/** を
// クライアントバンドルへ持ち込まない。
import type { RoomDTO, RoomListItemDTO } from '@/lib/server/rooms-logic'
import { RoomActionsCell } from '@/components/dashboard/RoomActionsCell'
import { EditRoomModal } from '@/components/dashboard/EditRoomModal'
import { ConfirmActionModal } from '@/components/dashboard/ConfirmActionModal'
import { LocaleSwitcher } from '@/components/LocaleSwitcher'
import {
  describeCapacity,
  describeRoomStatus,
  interpolate,
  resolveApiErrorMessage,
  uiText,
  useLocale,
  type Locale,
} from '@/lib/ui-text'
import { useLocaleStore } from '@/lib/store/locale-store'

/** GET /api/capacity のレスポンス形状（app/api/capacity/route.ts の CapacityResponse）。
 *  lib/server/** は import せず、公開 HTTP 契約の形だけをここに写す（既存の RoomMeta と同じ方針）。 */
interface CapacitySnapshot {
  /** null = 統計源が全滅（人数不明）。UI は「—」を出し、作成はブロックしない。 */
  current: number | null
  max: number
  canCreate: boolean
  canJoin: boolean
  source: string
}

/** ポーリング間隔。全局容量（/api/capacity）と会議室ごとの在線人数（/api/rooms）を
 *  **同じ間隔・同じタイマー**で更新する。人数は刻々と変わるが、ダッシュボードは常時
 *  見つめる画面ではないので 30 秒で十分。 */
const POLL_INTERVAL_MS = 30_000

function formatDateTime(iso: string | null, locale: Locale): string | null {
  if (!iso) return null
  return new Date(iso).toLocaleString(locale === 'zh' ? 'zh-CN' : 'ja-JP', { dateStyle: 'medium', timeStyle: 'short' })
}

/**
 * 静默ポーリングの結果、表示に影響する差分が無いかどうか。
 *
 * 30 秒ごとに新しい配列を setRooms すると、それだけで（内容が同じでも）tableItems の
 * useMemo が作り直され、HeroUI の Table が全行を再構築する。人数が変わっていないなら
 * 前回の配列参照をそのまま保つことで、無風時の再描画をゼロにする。
 */
function sameRoomList(a: RoomListItemDTO[], b: RoomListItemDTO[]): boolean {
  if (a.length !== b.length) return false
  return a.every((room, i) => {
    const other = b[i]
    return (
      room.id === other.id &&
      room.title === other.title &&
      room.roomCode === other.roomCode &&
      room.status === other.status &&
      room.scheduledAt === other.scheduledAt &&
      room.expiresAt === other.expiresAt &&
      room.activeParticipants === other.activeParticipants
    )
  })
}

export default function DashboardPage() {
  const router = useRouter()
  const locale = useLocale()
  const t = uiText[locale]
  const [rooms, setRooms] = useState<RoomListItemDTO[] | null>(null)
  const [capacity, setCapacity] = useState<CapacitySnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [isLoggingOut, setIsLoggingOut] = useState(false)

  // WP-7: 編集モーダル（開いている部屋の id。null なら閉じている）。
  const [editRoomId, setEditRoomId] = useState<string | null>(null)
  // 削除・会議終了は確認モーダル対象の行そのものを保持する（文言に title を使うため）。
  const [deleteTarget, setDeleteTarget] = useState<RoomListItemDTO | null>(null)
  const [endTarget, setEndTarget] = useState<RoomListItemDTO | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const [isEnding, setIsEnding] = useState(false)

  // ⚠️ loadRooms は deps=[router] で固定（router は Next.js が安定参照を保証するので
  // 実質マウント時に一度だけ作られ、以後同じ関数のまま使い回される——WP-7 当初からの
  // 挙動で、locale スイッチのために毎回作り直すと useEffect が再実行されて余計な
  // fetch が走ってしまう）。そのためエラー文言は render スコープの `t`（switch 前の
  // 古い locale を closure に固定してしまう）ではなく、呼ばれた瞬間の locale を
  // useLocaleStore.getState() で直接読んで解決する。
  const loadRooms = useCallback(async () => {
    setError(null)
    try {
      const res = await fetch('/api/rooms')
      if (res.status === 401) {
        router.push('/login')
        return
      }
      const json = await res.json()
      if (!res.ok) {
        const currentT = uiText[useLocaleStore.getState().locale]
        setError(
          resolveApiErrorMessage(json?.error?.code, ['INTERNAL_ERROR'], json?.error?.message, currentT.dashboard.loadRoomsFailed),
        )
        return
      }
      setRooms(json.rooms)
    } catch {
      setError(uiText[useLocaleStore.getState().locale].common.networkError)
    }
  }, [router])

  useEffect(() => {
    loadRooms()
  }, [loadRooms])

  // ---- 30 秒ポーリング（1 本のタイマーで 2 つを更新）----
  //   1. 全局容量（2026-08-07）：入室時に「満員でした」と初めて知るのではなく、作成する前に
  //      混雑を見せる。取得失敗時は表示を出さない（＝古い数字を残さない）——作成ボタンの
  //      ブロックはサーバー側 POST /api/rooms が本番のゲートなので、ここが取れなくても
  //      安全側に倒れる。
  //   2. 会議室一覧（2026-08-07 第 2 波）：状態列が「今その部屋に何人いるか」を映すように
  //      なったため、開きっぱなしの画面でも数字が追随する必要がある。
  //
  // ★ 静默更新の作法：ここでは **loading を立てない・スピナーを出さない・エラーも出さない**。
  //   画面を見ていた人の目の前で一覧が消えたり赤字が出たりする方が、30 秒古い数字より
  //   遥かに邪魔なので、失敗したら前回の表示をそのまま保って次の周期に賭ける。
  //   （能動的な操作——初回ロード・削除後の再取得——は従来どおり loadRooms がエラーを出す）
  useEffect(() => {
    let cancelled = false

    async function loadCapacity() {
      try {
        const res = await fetch('/api/capacity')
        if (!res.ok) return
        const json = (await res.json()) as CapacitySnapshot
        if (!cancelled) setCapacity(json)
      } catch {
        // 通信断は無視（次のポーリングで復帰する）
      }
    }

    async function refreshRoomsQuietly() {
      try {
        const res = await fetch('/api/rooms')
        if (cancelled) return
        if (res.status === 401) {
          // セッション切れだけは黙って放置できない（以後ずっと空振りするため）。
          router.push('/login')
          return
        }
        if (!res.ok) return
        const json = (await res.json()) as { rooms?: RoomListItemDTO[] }
        const next = json.rooms
        if (cancelled || !next) return
        // 内容が同じなら前回の配列参照を保つ（下の tableItems useMemo の再計算＝
        // Table 全行の再構築を避ける）。人数が変われば新しい参照になり、行キャッシュも
        // 正しく破棄される。
        setRooms((current) => (current && sameRoomList(current, next) ? current : next))
      } catch {
        // 同上：次の周期で復帰する
      }
    }

    // 初回は容量だけ（会議室一覧はマウント時の loadRooms が既に取っている＝二重取得を避ける）。
    loadCapacity()
    const timer = setInterval(() => {
      void loadCapacity()
      void refreshRoomsQuietly()
    }, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
    // router は Next.js が安定参照を保証するため、この effect は実質マウント時 1 回きり
    // （＝タイマーが張り替わらない）。
  }, [router])

  async function handleCopy(room: RoomListItemDTO) {
    // §6.1 の GET 一覧レスポンスに joinUrl は含まれない（roomCode から一意に
    // 導出できるため）。ダッシュボード自身が動いている origin = APP_DOMAIN 未設定時に
    // サーバーが使う fallback と同じ値になる。
    const joinUrl = `${window.location.origin}/j/${room.roomCode}`
    await navigator.clipboard.writeText(joinUrl)
    setCopiedId(room.id)
    setTimeout(() => setCopiedId((current) => (current === room.id ? null : current)), 1500)
  }

  async function handleLogout() {
    setIsLoggingOut(true)
    try {
      await fetch('/api/auth/logout', { method: 'POST' })
      router.push('/login')
      router.refresh()
    } finally {
      setIsLoggingOut(false)
    }
  }

  // 編集モーダルが 404（他所で削除済みなど）を検出したときの共通処理。
  // loadRooms が安定参照（deps=[router]）なので useCallback の依存として安全に使える。
  const handleEditNotFound = useCallback(() => {
    setEditRoomId(null)
    // loadRooms 同様、closure に古い locale を固定しないよう現在値を直接読む。
    setError(uiText[useLocaleStore.getState().locale].dashboard.roomNotFoundRefreshed)
    loadRooms()
  }, [loadRooms])

  function handleEditSaved(updated: RoomDTO) {
    setRooms(
      (current) =>
        current?.map((room) =>
          room.id === updated.id
            ? {
                id: updated.id,
                roomCode: updated.roomCode,
                title: updated.title,
                status: updated.status,
                scheduledAt: updated.scheduledAt,
                expiresAt: updated.expiresAt,
                // PATCH は在室状況に影響しない（タイトル/パスワード/期限の変更）ので、
                // 直近のポーリングで得た人数をそのまま持ち越す。RoomDTO 側にこの
                // フィールドは無いため、ここで明示的に引き継がないと null に落ちて
                // 状態列が一瞬「利用可能」へ後退してしまう。
                activeParticipants: room.activeParticipants,
              }
            : room,
        ) ?? current,
    )
    setEditRoomId(null)
    addToast({ title: t.dashboard.toastRoomUpdated, color: 'success' })
  }

  async function handleConfirmDelete() {
    if (!deleteTarget) return
    setIsDeleting(true)
    setError(null)
    try {
      const res = await fetch(`/api/rooms/${deleteTarget.id}`, { method: 'DELETE' })
      if (res.status === 401) {
        router.push('/login')
        return
      }
      if (res.status === 404) {
        setDeleteTarget(null)
        setError(t.dashboard.roomNotFoundRefreshed)
        await loadRooms()
        return
      }
      if (!res.ok) {
        const json = await res.json().catch(() => null)
        setError(resolveApiErrorMessage(json?.error?.code, ['INTERNAL_ERROR'], json?.error?.message, t.dashboard.deleteRoomFailed))
        return
      }
      setDeleteTarget(null)
      addToast({ title: t.dashboard.toastRoomDeleted, color: 'success' })
      await loadRooms()
    } catch {
      setError(t.common.networkError)
    } finally {
      setIsDeleting(false)
    }
  }

  async function handleConfirmEnd() {
    if (!endTarget) return
    setIsEnding(true)
    setError(null)
    try {
      const res = await fetch(`/api/rooms/${endTarget.id}/end`, { method: 'POST' })
      if (res.status === 401) {
        router.push('/login')
        return
      }
      if (res.status === 404) {
        setEndTarget(null)
        setError(t.dashboard.roomNotFoundRefreshed)
        await loadRooms()
        return
      }
      if (!res.ok) {
        const json = await res.json().catch(() => null)
        setError(resolveApiErrorMessage(json?.error?.code, ['INTERNAL_ERROR'], json?.error?.message, t.dashboard.endMeetingFailed))
        return
      }
      setEndTarget(null)
      addToast({ title: t.dashboard.toastMeetingEnded, color: 'success' })
      await loadRooms()
    } catch {
      setError(t.common.networkError)
    } finally {
      setIsEnding(false)
    }
  }

  // ⚠️ HeroUI の <Table items={...}> は行の内容を「item オブジェクトの参照」をキーにした
  // WeakMap でキャッシュし、renderer（下の TableBody の子関数）を一度呼んだ後は
  // 再呼出ししない——react-stately の Row.shouldInvalidate() はカラム構成の変化しか
  // 見ておらず、locale や copiedId のようなこの関数の外側の状態変化を関知しない
  // （node_modules/@react-stately/table/src/Row.ts で確認）。同じ room オブジェクトを
  // items にそのまま渡し続けると、"入室する"/"リンクをコピー" 等セル内に直接埋め込んだ
  // 文言が最初に描画された言語のまま固まってしまう（実機確認で発見）。
  // rooms 本体・locale・copiedId のいずれかが変わるたびに新しいオブジェクト参照を
  // 作って渡すことで、意図的にキャッシュミスさせ再描画を強制する。
  // locale/copiedId は map() 本体では読んでいない（意図的なキャッシュ無効化トリガーとしてのみ
  // 依存に加えている）ため、exhaustive-deps には引っかかるが意図通り。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const tableItems = useMemo(() => (rooms ?? []).map((room) => ({ ...room })), [rooms, locale, copiedId])

  // 容量チップの文言・色・作成ボタンの無効化理由は純関数側（lib/ui-text.ts）で決める。
  const capacityDisplay = capacity ? describeCapacity(capacity, locale) : null

  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-6 px-6 py-10">
      {/* addToast() はどこにマウントされた ToastProvider にも積める共有キューを使うため、
          このページ内のどこに置いてもよい（HeroUIProvider は app/layout.tsx にあるが、
          ToastProvider 自体は個別に必要——WP-7 のスコープ外である layout.tsx は触らない）。 */}
      <ToastProvider placement="top-center" />

      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">{t.dashboard.title}</h1>
        <div className="flex flex-wrap items-center gap-2">
          {capacityDisplay && (
            <Chip variant="flat" size="sm" color={capacityDisplay.tone} aria-label={t.capacity.ariaLabel}>
              {capacityDisplay.label}
            </Chip>
          )}
          <LocaleSwitcher />
          {capacityDisplay?.createDisabledReason ? (
            <Tooltip content={capacityDisplay.createDisabledReason}>
              {/* disabled な Button 自体は hover を発火しないので span で包む（入室ボタンと同じ手当て） */}
              <span className="inline-flex">
                <Button color="primary" isDisabled>
                  {t.dashboard.createRoomButton}
                </Button>
              </span>
            </Tooltip>
          ) : (
            <Button as={NextLink} href="/rooms/new" color="primary">
              {t.dashboard.createRoomButton}
            </Button>
          )}
          <Button variant="flat" onPress={handleLogout} isLoading={isLoggingOut}>
            {t.dashboard.logoutButton}
          </Button>
        </div>
      </div>

      {error && <p className="text-sm text-danger">{error}</p>}

      <Table aria-label={t.dashboard.title}>
        <TableHeader>
          <TableColumn>{t.dashboard.columnTitle}</TableColumn>
          <TableColumn>{t.dashboard.columnRoomCode}</TableColumn>
          <TableColumn>{t.dashboard.columnStatus}</TableColumn>
          <TableColumn>{t.dashboard.columnSchedule}</TableColumn>
          <TableColumn>{t.dashboard.columnJoinLink}</TableColumn>
          <TableColumn>{t.dashboard.columnActions}</TableColumn>
        </TableHeader>
        <TableBody
          items={tableItems}
          isLoading={rooms === null}
          loadingContent={<Spinner label={t.common.loading} />}
          emptyContent={t.dashboard.emptyRooms}
        >
          {(room) => {
            const scheduledLabel = formatDateTime(room.scheduledAt, locale)
            const expiresLabel = formatDateTime(room.expiresAt, locale)
            // 状態列は「会議室のライフサイクル」だけでなく「今その部屋に人が居るか」も映す
            // （文言・色の決定は純関数側 lib/ui-text.ts の describeRoomStatus）。
            const statusDisplay = describeRoomStatus(room.status, room.activeParticipants, locale)
            return (
              <TableRow key={room.id}>
                <TableCell>{room.title}</TableCell>
                <TableCell className="font-mono">{formatRoomCode(room.roomCode)}</TableCell>
                <TableCell>
                  <Chip color={statusDisplay.tone} variant="flat" size="sm">
                    {statusDisplay.label}
                  </Chip>
                </TableCell>
                <TableCell className="text-sm text-neutral-500">
                  {scheduledLabel && (
                    <div>
                      {t.dashboard.scheduleLabelPrefix}
                      {scheduledLabel}
                    </div>
                  )}
                  {expiresLabel && (
                    <div>
                      {t.dashboard.expiresLabelPrefix}
                      {expiresLabel}
                    </div>
                  )}
                  {!scheduledLabel && !expiresLabel && '-'}
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    {/* 主催者自身の入室導線。ゲストと同じ /j フローに入り、ログイン済みの
                        ため /join が host ロールを付与する（§7.3）。 */}
                    {isRoomActionEnabled(room.status, 'enter') ? (
                      <Button as={NextLink} href={`/j/${room.roomCode}`} size="sm" color="primary">
                        {t.dashboard.enterRoom}
                      </Button>
                    ) : (
                      <Tooltip content={getRoomActionDisabledReason(room.status, 'enter', locale) ?? ''}>
                        {/* disabled な Button 自体は hover を発火しないので span で包む */}
                        <span className="inline-flex">
                          <Button size="sm" color="primary" isDisabled>
                            {t.dashboard.enterRoom}
                          </Button>
                        </span>
                      </Tooltip>
                    )}
                    <Button size="sm" variant="flat" onPress={() => handleCopy(room)}>
                      {copiedId === room.id ? t.common.linkCopied : t.common.copyLink}
                    </Button>
                  </div>
                </TableCell>
                <TableCell>
                  <RoomActionsCell
                    status={room.status}
                    onEdit={() => setEditRoomId(room.id)}
                    onDelete={() => setDeleteTarget(room)}
                    onEnd={() => setEndTarget(room)}
                  />
                </TableCell>
              </TableRow>
            )
          }}
        </TableBody>
      </Table>

      <EditRoomModal
        isOpen={editRoomId !== null}
        roomId={editRoomId}
        onOpenChange={() => setEditRoomId(null)}
        onSaved={handleEditSaved}
        onNotFound={handleEditNotFound}
      />

      <ConfirmActionModal
        isOpen={deleteTarget !== null}
        onOpenChange={() => setDeleteTarget(null)}
        title={t.dashboard.deleteConfirmTitle}
        description={interpolate(t.dashboard.deleteConfirmBody, { title: deleteTarget?.title ?? '' })}
        confirmLabel={t.dashboard.deleteConfirmButton}
        confirmColor="danger"
        isLoading={isDeleting}
        onConfirm={handleConfirmDelete}
      />

      <ConfirmActionModal
        isOpen={endTarget !== null}
        onOpenChange={() => setEndTarget(null)}
        title={t.dashboard.endConfirmTitle}
        description={interpolate(t.dashboard.endConfirmBody, { title: endTarget?.title ?? '' })}
        confirmLabel={t.dashboard.endConfirmButton}
        confirmColor="danger"
        isLoading={isEnding}
        onConfirm={handleConfirmEnd}
      />
    </main>
  )
}
