/**
 * 会議内クライアント状態（規格書 §1 決定事項：Zustand は会議内クライアント状態のみを扱う）。
 *
 * ここが依存するのは `lib/media/types.ts` の型だけ（すべて `import type`）。
 * `MediaProvider` を保持はするが、生成は必ず呼び出し側（components/room/RoomExperience.tsx）が
 * `await import('@/lib/media')` の動的 import で行う——本ファイルは型しか触らないので
 * `livekit-client` はバンドルに一切引き込まない（§8.2 / §11 WP-3 の ESLint no-restricted-imports
 * とも無関係に安全）。
 *
 * 2026-08-07（FR-4 チャット / 遠隔ミュート）で追加した状態も同じ方針：
 * 純ロジック（リング裁断・ミュート由来判定）は下の export された純関数に切り出し、
 * store 本体はその薄いラッパーに留める（tests/room/chat-store.test.ts で直接叩ける）。
 */
import { create } from 'zustand'
import type {
  ChatMessage,
  LocalState,
  MediaError,
  MediaProvider,
  ParticipantId,
  RemoteParticipant,
} from '@/lib/media/types'

export type RoomConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected'

/**
 * 右サイドバーに出せるパネル（2026-08-07 第 2 波）。**同時に開けるのは 1 つだけ**。
 *
 * boolean を 2 本（isChatOpen / isParticipantsOpen）持って「開くときに相手を閉じる」と
 * 書く手もあるが、それだと "両方 true" という不正状態が型の上では表現できてしまい、
 * 書き換えのたびに排他を人力で守り続ける必要がある。単一のフィールドにすれば
 * **排他違反そのものが表現不能**になる。
 * そもそも同時に開いても表示できない——デスクトップではサイドバーの幅を取り合い、
 * モバイルでは両方が全画面ドロワーなので、片方が完全に隠れる。
 */
export type SidePanel = 'chat' | 'participants' | null

export interface SelfInfo {
  participantId: string
  displayName: string
  role: 'host' | 'guest'
}

const INITIAL_LOCAL_STATE: LocalState = { audioEnabled: false, videoEnabled: false }

// ============================================================
// チャット（FR-4）の純ロジック
// ============================================================

/** 保持するメッセージ数の上限。長時間の会議でメモリが単調増加しないよう古い方から捨てる。
 *  200 件＝画面をかなり遡っても足りる量で、かつ 500 字 × 200 でも高々 100 KB 程度。 */
export const CHAT_HISTORY_LIMIT = 200

/**
 * メッセージ追記（純関数）。
 * - 同じ id が既にあれば**無視**（自分の送信は送信結果で回显する契約なので二重にはならない
 *   はずだが、再接続直後の再配送など想定外の重複が来ても UI に二重表示させない）。
 * - 上限超過分は先頭（古い方）から捨てる。
 */
export function appendChatMessage(
  list: readonly ChatMessage[],
  message: ChatMessage,
  limit: number = CHAT_HISTORY_LIMIT,
): ChatMessage[] {
  if (list.some((m) => m.id === message.id)) return list as ChatMessage[]
  const next = [...list, message]
  return next.length > limit ? next.slice(next.length - limit) : next
}

// ============================================================
// 遠隔ミュートの由来判定（FR-4）
// ============================================================

/**
 * 「自分がマイクを操作するつもりだった」という意図の記録。
 *
 * 主催者による遠隔ミュートは、LiveKit のサーバー API（mutePublishedTrack）で
 * トラックが止められた結果として `TrackMuted` → `localStateChanged` が飛んでくる。
 * つまり**ローカル操作と遠隔操作はイベントとしては完全に同じ形**で届く。
 * 区別する唯一の手掛かりは「直前に自分が要求したかどうか」なので、
 * setMicrophoneEnabled を呼ぶ**直前**にこの意図を置き、届いた状態変化がそれと
 * 一致すればローカル由来、しなければ遠隔由来と判定する。
 *
 * 誤検知（自分でミュートしたのに「主催者にミュートされました」と出る）は明確なバグ。
 * 逆に取りこぼし（遠隔なのに黙って変わる）は実害が小さい——なので判定は
 * 「一致すればローカル」に倒し、期限も短すぎない値にしてある。
 */
export interface MicIntent {
  /** 自分が要求した状態（true=オンにしようとした） */
  enabled: boolean
  /** この時刻（epoch ms）までに届いた一致する変化はローカル由来とみなす */
  expiresAt: number
}

/** 通常のユーザー操作（ボタン押下 → provider 呼び出し）の猶予。往復に数百 ms かかる想定の余裕。 */
export const MIC_INTENT_TTL_MS = 3_000

export interface MicChangeEvent {
  source: 'local' | 'remote'
  /** 変化後のマイク状態（false＝ミュートされた） */
  audioEnabled: boolean
}

/**
 * マイク状態の変化がローカル由来か遠隔由来かを判定する（純関数）。
 * 意図が「同じ方向」かつ「期限内（expiresAt は含む）」のときだけローカル。
 */
export function classifyMicChange(
  nextAudioEnabled: boolean,
  intent: MicIntent | null,
  nowMs: number,
): MicChangeEvent {
  const matchesIntent = intent !== null && intent.enabled === nextAudioEnabled && nowMs <= intent.expiresAt
  return { source: matchesIntent ? 'local' : 'remote', audioEnabled: nextAudioEnabled }
}

interface MeetingStoreState {
  /** LiveKitProvider 等の実インスタンス。RoomExperience の接続 effect が唯一の書き手。 */
  provider: MediaProvider | null
  connectionState: RoomConnectionState
  /** 直近の切断理由（disconnectReasonText 由来の機械可読文字列）。UI が文言に変換する。 */
  disconnectReason: string | null
  self: SelfInfo | null
  localState: LocalState
  participants: Record<ParticipantId, RemoteParticipant>
  activeSpeakers: ParticipantId[]
  lastError: MediaError | null
  /** 会議中のみ保持するチャット履歴（永続化しない＝会議が終われば消える）。 */
  chatMessages: ChatMessage[]
  /**
   * 自分のメディア identity（＝`host_<userId>` / `guest_<nanoid12>`）。
   *
   * ⚠️ `self.participantId` は **DB の participants.id（uuid）** であって
   * メディア層の identity ではない（app/api/rooms/[code]/join/route.ts）。
   * チャットの吹き出しを「自分＝右寄せ」に振り分けるには後者が要るが、
   * join レスポンスには含まれていないし、抽象インターフェースにも
   * 「自分の identity を返す」メソッドは無い（§3.2 は凍結）。
   * 自分が最初に送信したメッセージの senderIdentity（provider が
   * localParticipant.identity から埋める）を控えることで解決する——
   * 1 通も送っていない間は自分の吹き出し自体が存在しないので、null で困らない。
   */
  selfChatIdentity: string | null
  /** チャットパネルを閉じている間に届いた遠端メッセージ数（開いた瞬間に 0）。 */
  unreadCount: number
  /** 今開いているサイドパネル（排他。null = どちらも閉じている）。 */
  openPanel: SidePanel
  /** 直近の「自分でマイクを操作するつもり」の記録（遠隔ミュート判定用）。 */
  micIntent: MicIntent | null

  setProvider: (provider: MediaProvider | null) => void
  setSelf: (self: SelfInfo | null) => void
  setConnectionState: (state: RoomConnectionState, reason?: string | null) => void
  upsertParticipant: (participant: RemoteParticipant) => void
  removeParticipant: (id: ParticipantId) => void
  setActiveSpeakers: (ids: ParticipantId[]) => void
  /** localStateChanged の唯一の受け口。マイク状態が変わった場合のみ由来判定を返す
   *  （変化なし＝null）。呼び出し側はそれを見てトーストを出す。 */
  setLocalState: (state: LocalState, nowMs?: number) => MicChangeEvent | null
  setError: (error: MediaError | null) => void
  /** 自分の送信メッセージ（provider.sendChatMessage() の戻り値）を回显する。未読は増えない。 */
  addLocalChatMessage: (message: ChatMessage) => void
  /** 遠端から届いたメッセージ。チャットパネルが**見えていなければ**未読 +1
   *  （参加者一覧を開いている間はチャットは見えていないので、未読は増える）。 */
  receiveChatMessage: (message: ChatMessage) => void
  /** サイドパネルの唯一の書き手。他方が開いていれば自動的に閉じる。 */
  setOpenPanel: (panel: SidePanel) => void
  setChatOpen: (open: boolean) => void
  toggleChat: () => void
  setParticipantsOpen: (open: boolean) => void
  toggleParticipants: () => void
  /** setMicrophoneEnabled を呼ぶ**直前**に、これから要求する状態を記録する。 */
  noteMicIntent: (enabled: boolean, ttlMs?: number) => void
  reset: () => void
}

export const useMeetingStore = create<MeetingStoreState>((set, get) => ({
  provider: null,
  connectionState: 'connecting',
  disconnectReason: null,
  self: null,
  localState: INITIAL_LOCAL_STATE,
  participants: {},
  activeSpeakers: [],
  lastError: null,
  chatMessages: [],
  selfChatIdentity: null,
  unreadCount: 0,
  openPanel: null,
  micIntent: null,

  setProvider: (provider) => set({ provider }),
  setSelf: (self) => set({ self }),
  setConnectionState: (connectionState, reason = null) => set({ connectionState, disconnectReason: reason }),
  upsertParticipant: (participant) =>
    set((s) => ({ participants: { ...s.participants, [participant.id]: participant } })),
  removeParticipant: (id) =>
    set((s) => {
      if (!(id in s.participants)) return s
      const next = { ...s.participants }
      delete next[id]
      return { participants: next }
    }),
  setActiveSpeakers: (activeSpeakers) => set({ activeSpeakers }),
  setLocalState: (localState, nowMs = Date.now()) => {
    const prev = get().localState
    const audioChanged = prev.audioEnabled !== localState.audioEnabled
    if (!audioChanged) {
      set({ localState })
      return null
    }
    const change = classifyMicChange(localState.audioEnabled, get().micIntent, nowMs)
    // 一致してもしなくても意図は使い切る：残しておくと、後から本当に主催者が
    // ミュートしてきたときに古い意図で「ローカル由来」と誤判定してしまう。
    set({ localState, micIntent: null })
    return change
  },
  setError: (lastError) => set({ lastError }),
  addLocalChatMessage: (message) =>
    set((s) => ({
      chatMessages: appendChatMessage(s.chatMessages, message),
      selfChatIdentity: message.senderIdentity,
    })),
  receiveChatMessage: (message) =>
    set((s) => {
      const chatMessages = appendChatMessage(s.chatMessages, message)
      // 重複で捨てられた場合は未読も増やさない（同じ参照が返る＝追記されていない）
      if (chatMessages === s.chatMessages) return s
      const chatVisible = s.openPanel === 'chat'
      return { chatMessages, unreadCount: chatVisible ? s.unreadCount : s.unreadCount + 1 }
    }),
  // 排他の唯一の実装点。他のパネル操作はすべてここを経由する（＝排他ロジックが 1 か所）。
  // チャットを開いた瞬間だけ未読を 0 に落とす（参加者一覧を開いてもチャットは読んで
  // いないので未読は残す。閉じるときも消さない——閉じた後に届いた分から数え直さない）。
  setOpenPanel: (panel) => set((s) => ({ openPanel: panel, unreadCount: panel === 'chat' ? 0 : s.unreadCount })),
  setChatOpen: (open) => {
    // 「閉じろ」と言われたときに開いているのが参加者一覧なら、それは閉じない
    // （チャットの閉じるボタンが他人のパネルを巻き添えにしないため）。
    if (!open && get().openPanel !== 'chat') return
    get().setOpenPanel(open ? 'chat' : null)
  },
  toggleChat: () => get().setOpenPanel(get().openPanel === 'chat' ? null : 'chat'),
  setParticipantsOpen: (open) => {
    if (!open && get().openPanel !== 'participants') return
    get().setOpenPanel(open ? 'participants' : null)
  },
  toggleParticipants: () => get().setOpenPanel(get().openPanel === 'participants' ? null : 'participants'),
  noteMicIntent: (enabled, ttlMs = MIC_INTENT_TTL_MS) =>
    set({ micIntent: { enabled, expiresAt: Date.now() + ttlMs } }),
  reset: () =>
    set({
      provider: null,
      connectionState: 'connecting',
      disconnectReason: null,
      self: null,
      localState: INITIAL_LOCAL_STATE,
      participants: {},
      activeSpeakers: [],
      lastError: null,
      chatMessages: [],
      selfChatIdentity: null,
      unreadCount: 0,
      openPanel: null,
      micIntent: null,
    }),
}))
