// 会議内 store（チャット履歴・未読・遠隔ミュート判定）の回帰テスト（2026-08-07 FR-4）。
// lib/store/meeting-store.ts は zustand と型だけに依存する（lib/supabase.ts は import しない）ので
// node 環境の vitest でそのまま動かせる。
import { beforeEach, describe, expect, it } from 'vitest'
import type { ChatMessage, LocalState } from '@/lib/media/types'
import {
  CHAT_HISTORY_LIMIT,
  MIC_INTENT_TTL_MS,
  appendChatMessage,
  classifyMicChange,
  useMeetingStore,
} from '@/lib/store/meeting-store'

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm1',
    senderIdentity: 'guest_a',
    senderName: 'A',
    text: 'hello',
    timestamp: 1_700_000_000_000,
    ...overrides,
  }
}

function localState(overrides: Partial<LocalState> = {}): LocalState {
  return { audioEnabled: false, videoEnabled: false, ...overrides }
}

beforeEach(() => {
  useMeetingStore.getState().reset()
})

// ============================================================
// リング裁断（純関数）
// ============================================================
describe('appendChatMessage', () => {
  it('末尾に追記する', () => {
    const list = [makeMessage({ id: 'a' })]
    expect(appendChatMessage(list, makeMessage({ id: 'b' })).map((m) => m.id)).toEqual(['a', 'b'])
  })

  it('同じ id は無視して同一参照を返す（＝呼び出し側で「追記されなかった」と判別できる）', () => {
    const list = [makeMessage({ id: 'a' })]
    expect(appendChatMessage(list, makeMessage({ id: 'a', text: '別の本文' }))).toBe(list)
  })

  it('上限を超えたら古い方から捨てる', () => {
    let list: ChatMessage[] = []
    for (let i = 0; i < CHAT_HISTORY_LIMIT + 5; i += 1) {
      list = appendChatMessage(list, makeMessage({ id: `m${i}` }))
    }
    expect(list).toHaveLength(CHAT_HISTORY_LIMIT)
    expect(list[0].id).toBe('m5')
    expect(list[list.length - 1].id).toBe(`m${CHAT_HISTORY_LIMIT + 4}`)
  })

  it('上限ちょうどでは捨てない（境界）', () => {
    let list: ChatMessage[] = []
    for (let i = 0; i < CHAT_HISTORY_LIMIT; i += 1) list = appendChatMessage(list, makeMessage({ id: `m${i}` }))
    expect(list).toHaveLength(CHAT_HISTORY_LIMIT)
    expect(list[0].id).toBe('m0')
  })

  it('limit は引数で上書きできる', () => {
    const list = appendChatMessage([makeMessage({ id: 'a' }), makeMessage({ id: 'b' })], makeMessage({ id: 'c' }), 2)
    expect(list.map((m) => m.id)).toEqual(['b', 'c'])
  })
})

// ============================================================
// 未読カウント
// ============================================================
describe('未読カウント', () => {
  it('パネルを閉じている間の遠端メッセージで増える', () => {
    const store = useMeetingStore.getState()
    store.receiveChatMessage(makeMessage({ id: 'a' }))
    store.receiveChatMessage(makeMessage({ id: 'b' }))
    expect(useMeetingStore.getState().unreadCount).toBe(2)
  })

  it('パネルを開いている間は増えない', () => {
    useMeetingStore.getState().setChatOpen(true)
    useMeetingStore.getState().receiveChatMessage(makeMessage({ id: 'a' }))
    expect(useMeetingStore.getState().unreadCount).toBe(0)
  })

  it('開いた瞬間に 0 に戻る', () => {
    useMeetingStore.getState().receiveChatMessage(makeMessage({ id: 'a' }))
    expect(useMeetingStore.getState().unreadCount).toBe(1)
    useMeetingStore.getState().setChatOpen(true)
    expect(useMeetingStore.getState().unreadCount).toBe(0)
  })

  it('閉じるだけでは未読を消さない（閉じた後に届いた分から数え直さない）', () => {
    useMeetingStore.getState().setChatOpen(true)
    useMeetingStore.getState().setChatOpen(false)
    useMeetingStore.getState().receiveChatMessage(makeMessage({ id: 'a' }))
    useMeetingStore.getState().setChatOpen(false)
    expect(useMeetingStore.getState().unreadCount).toBe(1)
  })

  it('toggleChat も開くときだけ未読を消す', () => {
    useMeetingStore.getState().receiveChatMessage(makeMessage({ id: 'a' }))
    useMeetingStore.getState().toggleChat() // 開く
    expect(useMeetingStore.getState()).toMatchObject({ openPanel: 'chat', unreadCount: 0 })
    useMeetingStore.getState().receiveChatMessage(makeMessage({ id: 'b' }))
    useMeetingStore.getState().toggleChat() // 閉じる
    expect(useMeetingStore.getState()).toMatchObject({ openPanel: null, unreadCount: 0 })
  })

  it('参加者一覧を開いている間はチャットが見えていないので未読は増える', () => {
    useMeetingStore.getState().setParticipantsOpen(true)
    useMeetingStore.getState().receiveChatMessage(makeMessage({ id: 'a' }))
    expect(useMeetingStore.getState().unreadCount).toBe(1)
  })

  it('参加者一覧を開いても未読は消えない（チャットを読んだわけではない）', () => {
    useMeetingStore.getState().receiveChatMessage(makeMessage({ id: 'a' }))
    useMeetingStore.getState().toggleParticipants()
    expect(useMeetingStore.getState().unreadCount).toBe(1)
  })

  it('未読が溜まった状態から参加者一覧 → チャットへ切り替えると、そこで初めて 0 になる', () => {
    useMeetingStore.getState().receiveChatMessage(makeMessage({ id: 'a' }))
    useMeetingStore.getState().setParticipantsOpen(true)
    expect(useMeetingStore.getState().unreadCount).toBe(1)
    useMeetingStore.getState().setChatOpen(true)
    expect(useMeetingStore.getState()).toMatchObject({ openPanel: 'chat', unreadCount: 0 })
  })

  it('重複メッセージは履歴にも未読にも足さない', () => {
    useMeetingStore.getState().receiveChatMessage(makeMessage({ id: 'a' }))
    useMeetingStore.getState().receiveChatMessage(makeMessage({ id: 'a' }))
    expect(useMeetingStore.getState().chatMessages).toHaveLength(1)
    expect(useMeetingStore.getState().unreadCount).toBe(1)
  })

  it('自分の送信は未読を増やさず、自分の identity を控える', () => {
    useMeetingStore.getState().addLocalChatMessage(makeMessage({ id: 'me', senderIdentity: 'host_1' }))
    expect(useMeetingStore.getState().unreadCount).toBe(0)
    expect(useMeetingStore.getState().selfChatIdentity).toBe('host_1')
  })

  it('reset で会議内の痕跡が全部消える（次の会議に持ち越さない）', () => {
    useMeetingStore.getState().receiveChatMessage(makeMessage({ id: 'a' }))
    useMeetingStore.getState().addLocalChatMessage(makeMessage({ id: 'me', senderIdentity: 'host_1' }))
    useMeetingStore.getState().reset()
    expect(useMeetingStore.getState()).toMatchObject({
      chatMessages: [],
      unreadCount: 0,
      openPanel: null,
      selfChatIdentity: null,
      micIntent: null,
    })
  })
})

// ============================================================
// サイドパネルの排他（2026-08-07 第 2 波）
// ============================================================
describe('サイドパネル（チャット / 参加者一覧）は排他', () => {
  it('初期状態はどちらも閉じている', () => {
    expect(useMeetingStore.getState().openPanel).toBeNull()
  })

  it('チャットを開いてから参加者一覧を開くと、チャットは閉じる', () => {
    useMeetingStore.getState().toggleChat()
    useMeetingStore.getState().toggleParticipants()
    expect(useMeetingStore.getState().openPanel).toBe('participants')
  })

  it('参加者一覧を開いてからチャットを開くと、参加者一覧は閉じる', () => {
    useMeetingStore.getState().toggleParticipants()
    useMeetingStore.getState().toggleChat()
    expect(useMeetingStore.getState().openPanel).toBe('chat')
  })

  it('同じボタンをもう一度押すと閉じる（トグル）', () => {
    useMeetingStore.getState().toggleParticipants()
    useMeetingStore.getState().toggleParticipants()
    expect(useMeetingStore.getState().openPanel).toBeNull()
    useMeetingStore.getState().toggleChat()
    useMeetingStore.getState().toggleChat()
    expect(useMeetingStore.getState().openPanel).toBeNull()
  })

  it('setXxxOpen(true) でも排他は同じ', () => {
    useMeetingStore.getState().setChatOpen(true)
    expect(useMeetingStore.getState().openPanel).toBe('chat')
    useMeetingStore.getState().setParticipantsOpen(true)
    expect(useMeetingStore.getState().openPanel).toBe('participants')
    useMeetingStore.getState().setChatOpen(true)
    expect(useMeetingStore.getState().openPanel).toBe('chat')
  })

  it('相手が開いているときの setXxxOpen(false) は巻き添えにしない', () => {
    // チャットの × ボタン（setChatOpen(false)）が、開いている参加者一覧まで
    // 閉じてしまわないこと。逆向きも同様。
    useMeetingStore.getState().setParticipantsOpen(true)
    useMeetingStore.getState().setChatOpen(false)
    expect(useMeetingStore.getState().openPanel).toBe('participants')

    useMeetingStore.getState().setChatOpen(true)
    useMeetingStore.getState().setParticipantsOpen(false)
    expect(useMeetingStore.getState().openPanel).toBe('chat')
  })

  it('自分自身を閉じる setXxxOpen(false) はちゃんと閉じる', () => {
    useMeetingStore.getState().setParticipantsOpen(true)
    useMeetingStore.getState().setParticipantsOpen(false)
    expect(useMeetingStore.getState().openPanel).toBeNull()

    useMeetingStore.getState().setChatOpen(true)
    useMeetingStore.getState().setChatOpen(false)
    expect(useMeetingStore.getState().openPanel).toBeNull()
  })

  it('何も開いていないときの setXxxOpen(false) は無害', () => {
    useMeetingStore.getState().setChatOpen(false)
    useMeetingStore.getState().setParticipantsOpen(false)
    expect(useMeetingStore.getState().openPanel).toBeNull()
  })

  it('reset で閉じる（次の会議に開きっぱなしを持ち越さない）', () => {
    useMeetingStore.getState().setParticipantsOpen(true)
    useMeetingStore.getState().reset()
    expect(useMeetingStore.getState().openPanel).toBeNull()
  })
})

// ============================================================
// 遠隔ミュートの由来判定
// ============================================================
describe('classifyMicChange（純関数・時間窓の境界）', () => {
  const NOW = 1_700_000_000_000

  it('意図が無ければ遠隔', () => {
    expect(classifyMicChange(false, null, NOW)).toEqual({ source: 'remote', audioEnabled: false })
  })

  it('同じ方向・期限内ならローカル', () => {
    expect(classifyMicChange(false, { enabled: false, expiresAt: NOW + 1 }, NOW)).toEqual({
      source: 'local',
      audioEnabled: false,
    })
  })

  it('期限ちょうど（expiresAt === now）はローカル扱い（境界は含む）', () => {
    expect(classifyMicChange(false, { enabled: false, expiresAt: NOW }, NOW).source).toBe('local')
  })

  it('期限を 1ms でも過ぎたら遠隔', () => {
    expect(classifyMicChange(false, { enabled: false, expiresAt: NOW - 1 }, NOW).source).toBe('remote')
  })

  it('方向が逆（オンにするつもりだったのにオフになった）なら遠隔', () => {
    expect(classifyMicChange(false, { enabled: true, expiresAt: NOW + 5000 }, NOW).source).toBe('remote')
  })
})

describe('setLocalState（store 経由の由来判定）', () => {
  const NOW = 1_700_000_000_000

  it('マイク状態が変わらなければ null（トーストを出さない）', () => {
    expect(useMeetingStore.getState().setLocalState(localState({ videoEnabled: true }), NOW)).toBeNull()
  })

  it('自分でオンにした直後の変化はローカル（＝「主催者に解除された」と誤報しない）', () => {
    useMeetingStore.getState().noteMicIntent(true)
    const change = useMeetingStore.getState().setLocalState(localState({ audioEnabled: true }))
    expect(change).toEqual({ source: 'local', audioEnabled: true })
  })

  it('意図なしにオフへ変われば遠隔ミュートと判定する', () => {
    useMeetingStore.getState().setLocalState(localState({ audioEnabled: true }), NOW)
    const change = useMeetingStore.getState().setLocalState(localState({ audioEnabled: false }), NOW)
    expect(change).toEqual({ source: 'remote', audioEnabled: false })
  })

  it('意図なしにオンへ変われば遠隔解除と判定する', () => {
    const change = useMeetingStore.getState().setLocalState(localState({ audioEnabled: true }), NOW)
    expect(change).toEqual({ source: 'remote', audioEnabled: true })
  })

  it('意図は 1 回で使い切る：自分でミュート → その後の遠隔ミュートを取りこぼさない', () => {
    useMeetingStore.getState().setLocalState(localState({ audioEnabled: true }), NOW)
    useMeetingStore.getState().noteMicIntent(false)
    expect(useMeetingStore.getState().setLocalState(localState({ audioEnabled: false }), NOW)?.source).toBe('local')
    expect(useMeetingStore.getState().micIntent).toBeNull()
    // 自分で戻して、その後に主催者がミュートしてくる
    useMeetingStore.getState().noteMicIntent(true)
    useMeetingStore.getState().setLocalState(localState({ audioEnabled: true }), NOW)
    expect(useMeetingStore.getState().setLocalState(localState({ audioEnabled: false }), NOW)?.source).toBe('remote')
  })

  it('意図が古すぎる（TTL 超過）なら遠隔扱い', () => {
    useMeetingStore.getState().setLocalState(localState({ audioEnabled: true }), NOW)
    useMeetingStore.getState().noteMicIntent(false, MIC_INTENT_TTL_MS)
    const expiresAt = useMeetingStore.getState().micIntent?.expiresAt ?? 0
    expect(useMeetingStore.getState().setLocalState(localState({ audioEnabled: false }), expiresAt + 1)?.source).toBe(
      'remote',
    )
  })
})
