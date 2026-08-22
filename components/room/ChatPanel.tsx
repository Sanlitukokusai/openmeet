'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Button, Input } from '@heroui/react'
import { MAX_CHAT_TEXT_LENGTH, type ChatMessage } from '@/lib/media/types'
import type { UiTextDict } from '@/lib/ui-text'
import { ArrowDownIcon, CloseIcon, SendIcon } from './chat-icons'

/** 「最下部にいる」とみなす許容距離。これ以内なら新着で自動スクロール、超えていれば
 *  ユーザーが過去ログを読んでいる最中なので勝手に引っ張らない（§FR-4 の要求）。 */
const STICK_TO_BOTTOM_THRESHOLD_PX = 100

/** 文字数カウンターを出し始める閾値（残り 100 文字）。常時出すと視覚ノイズになる。 */
const COUNTER_VISIBLE_FROM = MAX_CHAT_TEXT_LENGTH - 100

/** HH:mm（24 時間表記）。`toLocaleTimeString` はロケール次第で AM/PM や
 *  和暦めいた表記に振れるうえ SSR とクライアントで結果が食い違いうるので、自前で組む。 */
function formatChatTime(timestamp: number): string {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return ''
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/**
 * 会議内チャットパネル（2026-08-07 FR-4）。
 *
 * レイアウト：**単一インスタンスを CSS だけでレスポンシブに切り替える**。
 *  - モバイル（< md）：`fixed inset-0 z-50` の全画面ドロワー（コントロールドックも覆う）
 *  - デスクトップ（≥ md）：`static` に戻して幅 360px のサイドバーになり、親の flex 行の
 *    中でビデオ領域を押し縮める（グリッドの上に被せない）
 * インスタンスを 2 つ置いてブレークポイントで出し分けると、入力途中の下書きや
 * スクロール位置が画面幅の変化で消えるので、意図的に 1 つに統一している。
 *
 * XSS：本文は React のテキストノードとしてのみ描画する（自動エスケープ）。
 * `dangerouslySetInnerHTML` は使わない——リンク自動検出のような「便利機能」も、
 * 相手が任意文字列を送れるチャットでは足がかりになるので本期は入れない。
 */
export function ChatPanel({
  messages,
  selfIdentity,
  canSend,
  onSend,
  onClose,
  text,
}: {
  messages: ChatMessage[]
  /** 自分のメディア identity。まだ 1 通も送っていない間は null（自分の吹き出しも無い）。 */
  selfIdentity: string | null
  /** 接続中のみ送信可（再接続中・切断中は入力欄ごと無効化する） */
  canSend: boolean
  /** 送信成功なら true。false のとき下書きは消さない（打ち直させない） */
  onSend: (text: string) => Promise<boolean>
  onClose: () => void
  text: UiTextDict
}) {
  const t = text.chat
  const listRef = useRef<HTMLDivElement>(null)
  const [draft, setDraft] = useState('')
  const [isSending, setIsSending] = useState(false)
  /** 最下部に貼り付いているか（＝新着で自動スクロールしてよいか） */
  const [isPinnedToBottom, setIsPinnedToBottom] = useState(true)
  /** 上に遡っている間に届いた新着があるか（「新しいメッセージ↓」ボタンの出し分け） */
  const [hasUnseenBelow, setHasUnseenBelow] = useState(false)

  const scrollToBottom = useCallback(() => {
    const el = listRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    setIsPinnedToBottom(true)
    setHasUnseenBelow(false)
  }, [])

  // 新着時の追従。useLayoutEffect にするのは、描画後・ブラウザのペイント前に位置を
  // 合わせて「一瞬前のメッセージが見えてからガクッと下がる」のを避けるため。
  useLayoutEffect(() => {
    if (messages.length === 0) return
    if (isPinnedToBottom) {
      scrollToBottom()
    } else {
      setHasUnseenBelow(true)
    }
    // isPinnedToBottom は「新着が来た瞬間の値」だけを見たいので依存に入れない
    // （スクロールしただけで再実行されると、遡り中に勝手に下へ飛ぶ）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length])

  // パネルを開いた直後は必ず最新を見せる（未読を見に来ているので）
  useEffect(() => {
    scrollToBottom()
  }, [scrollToBottom])

  function handleScroll() {
    const el = listRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    const pinned = distanceFromBottom <= STICK_TO_BOTTOM_THRESHOLD_PX
    setIsPinnedToBottom(pinned)
    if (pinned) setHasUnseenBelow(false)
  }

  async function handleSend() {
    const trimmed = draft.trim()
    if (trimmed.length === 0 || isSending || !canSend) return
    setIsSending(true)
    try {
      const ok = await onSend(trimmed)
      if (ok) {
        setDraft('')
        // 自分の発言は常に最新を見たい（遡っていても引き戻す）
        setIsPinnedToBottom(true)
      }
    } finally {
      setIsSending(false)
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    // IME 変換確定の Enter を送信と誤認しない（日本語・中国語入力では致命的）
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
    event.preventDefault()
    void handleSend()
  }

  const remaining = MAX_CHAT_TEXT_LENGTH - draft.length

  return (
    <aside
      aria-label={t.title}
      // pb-safe/pt-safe：モバイルの全画面ドロワーが iOS のホームインジケータ／ノッチに
      // 被らないように（2026-08-14）。デスクトップでは env(safe-area-inset-*) が 0 なので
      // 無条件に付けても見た目は変わらない。
      //
      // 2026-08-16：`inset-0` を `inset-x-0 top-0 h-dvh` に置換（iOS Safari のツールバー対策）。
      // `bottom-0` 由来の暗黙の高さは「最大ビューポート」基準になり、ツールバーが出ている間は
      // 下端（＝入力欄と送信ボタン）がツールバーの裏に隠れて触れない。dvh は実際に見えている
      // 高さに追従する唯一の単位なので、高さを明示する形に変える。
      // `md:h-auto` は必須——デスクトップでは md:static のフレックス子要素になるため、
      // h-dvh が残ると行の高さ（＝ルートの h-dvh からバナー等を引いた値）を超えてはみ出す。
      className="fixed inset-x-0 top-0 h-dvh z-50 flex flex-col bg-zinc-900 pb-safe pt-safe text-zinc-100 md:static md:z-auto md:h-auto md:w-[360px] md:shrink-0 md:border-l md:border-white/10"
    >
      <header className="flex items-start justify-between gap-2 border-b border-white/10 px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{t.title}</h2>
          <p className="mt-0.5 text-xs text-zinc-400">{t.ephemeralNote}</p>
        </div>
        <Button isIconOnly size="sm" variant="light" radius="full" aria-label={t.close} onPress={onClose}>
          <CloseIcon className="h-4 w-4" />
        </Button>
      </header>

      <div className="relative min-h-0 flex-1">
        <div
          ref={listRef}
          onScroll={handleScroll}
          className="flex h-full flex-col gap-3 overflow-y-auto px-4 py-3"
          // 新着は視覚的に追えるが、スクリーンリーダーにも読み上げさせる（会議中に
          // 画面を見ていない参加者がいる前提）。polite なので発言を遮らない。
          aria-live="polite"
        >
          {messages.length === 0 ? (
            <p className="m-auto text-center text-xs text-zinc-500">{t.empty}</p>
          ) : (
            messages.map((message) => (
              <ChatBubble
                key={message.id}
                message={message}
                isSelf={selfIdentity !== null && message.senderIdentity === selfIdentity}
              />
            ))
          )}
        </div>

        {hasUnseenBelow && (
          <div className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center">
            <Button
              size="sm"
              radius="full"
              color="primary"
              variant="solid"
              className="pointer-events-auto shadow-lg"
              startContent={<ArrowDownIcon className="h-3.5 w-3.5" />}
              onPress={scrollToBottom}
            >
              {t.jumpToLatest}
            </Button>
          </div>
        )}
      </div>

      <div className="border-t border-white/10 px-3 py-3">
        <div className="flex items-end gap-2">
          <Input
            size="sm"
            variant="bordered"
            aria-label={t.inputPlaceholder}
            placeholder={canSend ? t.inputPlaceholder : t.inputDisabledPlaceholder}
            value={draft}
            onValueChange={setDraft}
            onKeyDown={handleKeyDown}
            isDisabled={!canSend}
            maxLength={MAX_CHAT_TEXT_LENGTH}
            autoComplete="off"
            classNames={{ inputWrapper: 'border-white/20 data-[hover=true]:border-white/30' }}
          />
          <Button
            isIconOnly
            size="sm"
            color="primary"
            aria-label={t.send}
            isDisabled={!canSend || draft.trim().length === 0}
            isLoading={isSending}
            onPress={handleSend}
          >
            <SendIcon className="h-4 w-4" />
          </Button>
        </div>
        {draft.length >= COUNTER_VISIBLE_FROM && (
          <p className={`mt-1 text-right text-[11px] ${remaining <= 0 ? 'text-danger' : 'text-zinc-500'}`}>
            {draft.length} / {MAX_CHAT_TEXT_LENGTH}
          </p>
        )}
      </div>
    </aside>
  )
}

function ChatBubble({ message, isSelf }: { message: ChatMessage; isSelf: boolean }) {
  // 壊れた timestamp（provider 側で弾いているはずだが）で `toISOString()` が
  // RangeError を投げ、チャット全体が真っ白になるのを防ぐ。
  const parsed = new Date(message.timestamp)
  const isoTimestamp = Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString()
  return (
    <div className={`flex flex-col gap-0.5 ${isSelf ? 'items-end' : 'items-start'}`}>
      {!isSelf && <span className="max-w-full truncate px-1 text-[11px] text-zinc-400">{message.senderName}</span>}
      <div className={`flex max-w-[85%] items-end gap-1.5 ${isSelf ? 'flex-row-reverse' : 'flex-row'}`}>
        <div
          className={`whitespace-pre-wrap break-words rounded-2xl px-3 py-1.5 text-sm ${
            isSelf ? 'rounded-br-sm bg-primary text-primary-foreground' : 'rounded-bl-sm bg-zinc-800 text-zinc-100'
          }`}
        >
          {message.text}
        </div>
        <time dateTime={isoTimestamp} className="shrink-0 pb-0.5 text-[10px] tabular-nums text-zinc-500">
          {formatChatTime(message.timestamp)}
        </time>
      </div>
    </div>
  )
}
