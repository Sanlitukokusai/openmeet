'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ToastProvider, addToast, useDisclosure } from '@heroui/react'
import type {
  ChatMessage,
  LocalState,
  MediaDeviceEntry,
  MediaError,
  MediaProvider,
  ParticipantId,
  RemoteParticipant,
} from '@/lib/media/types'
import { MAX_CHAT_TEXT_LENGTH } from '@/lib/media/types'
import { useMeetingStore } from '@/lib/store/meeting-store'
import { useLocaleStore } from '@/lib/store/locale-store'
import { clearJoinResult, getDevicePrefs, loadJoinResult, setDevicePrefs } from '@/lib/store/join-storage'
import {
  backgroundImageStore,
  backgroundSelectionToEffect,
  loadBackgroundSelection,
  NONE_SELECTION,
  saveBackgroundSelection,
  type BackgroundSelection,
} from '@/lib/background-storage'
import { mediaDeviceHelper } from '@/lib/media/devices'
import { interpolate, mediaErrorMessage, muteErrorMessage, useLocale, uiText, type UiTextDict } from '@/lib/ui-text'
import { LocaleSwitcher } from '@/components/LocaleSwitcher'
import { AlertTriangleIcon } from '@/components/icons'
import {
  CAMERA_INTENT_TTL_MS,
  CAMERA_RECOVERY_GRACE_MS,
  INITIAL_CAMERA_INTENT_TTL_MS,
  classifyCameraChange,
  planCameraNotice,
  type CameraIntent,
} from './camera-notice'
import { ChatPanel } from './ChatPanel'
import { ConnectionBanner } from './ConnectionBanner'
import { ControlBar } from './ControlBar'
import { DeviceSettingsModal } from './DeviceSettingsModal'
import { EndMeetingModal } from './EndMeetingModal'
import { FullScreenNotice } from './FullScreenNotice'
import { LeaveConfirmModal } from './LeaveConfirmModal'
import { LocalPreviewTile } from './LocalPreviewTile'
import { MuteAllModal } from './MuteAllModal'
import { ParticipantsPanel } from './ParticipantsPanel'
import { totalParticipantCount } from './participant-list'
import { VideoGrid } from './VideoGrid'

const TELEMETRY_INTERVAL_MS = 30_000

/**
 * 入会時の初期マイク状態に対する「意図」の有効期間（2026-08-07 遠隔ミュート判定）。
 *
 * 通常のボタン操作は 3 秒（MIC_INTENT_TTL_MS）で足りるが、入会直後の
 * 「initialAudio に従ってマイクを開く」は connect() の完了を待ってから走るため、
 * ネットワーク次第で数秒〜十数秒遅れる。ここを短く取ると、入会しただけで
 * 「主催者がミュートを解除しました」という嘘のトーストが出る（＝誤検知＝バグ）。
 * 誤検知は絶対に避けたい側なので、初期状態の意図だけ長めに持たせる。
 */
const INITIAL_MIC_INTENT_TTL_MS = 60_000

/** GET /api/rooms 一覧アイテムの必要フィールドだけ（他は WP-4 では使わない）。 */
interface RoomListItem {
  id: string
  roomCode: string
}

/** POST /participants/mute-all のレスポンス（app/api/.../mute-all/route.ts）。 */
interface MuteAllResult {
  muted: number
  skipped: number
  failed: number
}

/**
 * トースト等、**イベントハンドラ内**で使う文言の解決。
 *
 * 接続 effect の中で定義したハンドラは deps=[roomCode] の closure に閉じ込められており、
 * レンダースコープの `text` を掴むと言語切替後も古い言語のまま出てしまう
 * （app/dashboard/page.tsx で実機確認済みの罠と同じ）。呼ばれた瞬間の locale を
 * store から直接読む。
 */
function currentText(): UiTextDict {
  return uiText[useLocaleStore.getState().locale]
}

export function RoomExperience({ roomCode }: { roomCode: string }) {
  const router = useRouter()
  const locale = useLocale()
  const text = uiText[locale]

  const provider = useMeetingStore((s) => s.provider)
  const connectionState = useMeetingStore((s) => s.connectionState)
  const self = useMeetingStore((s) => s.self)
  const localState = useMeetingStore((s) => s.localState)
  const participants = useMeetingStore((s) => s.participants)
  const activeSpeakers = useMeetingStore((s) => s.activeSpeakers)
  const lastError = useMeetingStore((s) => s.lastError)
  const chatMessages = useMeetingStore((s) => s.chatMessages)
  const selfChatIdentity = useMeetingStore((s) => s.selfChatIdentity)
  const unreadCount = useMeetingStore((s) => s.unreadCount)
  // サイドバーは排他（store の openPanel が唯一の事実源）。ここでは表示に必要な
  // 2 つの真偽値へ落とすだけで、「両方開いている」状態は型として存在しない。
  const openPanel = useMeetingStore((s) => s.openPanel)
  const isChatOpen = openPanel === 'chat'
  const isParticipantsOpen = openPanel === 'participants'
  const setProvider = useMeetingStore((s) => s.setProvider)
  const setSelf = useMeetingStore((s) => s.setSelf)
  const setConnectionState = useMeetingStore((s) => s.setConnectionState)
  const upsertParticipant = useMeetingStore((s) => s.upsertParticipant)
  const removeParticipant = useMeetingStore((s) => s.removeParticipant)
  const setActiveSpeakers = useMeetingStore((s) => s.setActiveSpeakers)
  const setLocalState = useMeetingStore((s) => s.setLocalState)
  const setError = useMeetingStore((s) => s.setError)
  const addLocalChatMessage = useMeetingStore((s) => s.addLocalChatMessage)
  const receiveChatMessage = useMeetingStore((s) => s.receiveChatMessage)
  const setChatOpen = useMeetingStore((s) => s.setChatOpen)
  const toggleChat = useMeetingStore((s) => s.toggleChat)
  const setParticipantsOpen = useMeetingStore((s) => s.setParticipantsOpen)
  const toggleParticipants = useMeetingStore((s) => s.toggleParticipants)
  const noteMicIntent = useMeetingStore((s) => s.noteMicIntent)
  const reset = useMeetingStore((s) => s.reset)

  const [sessionMissing, setSessionMissing] = useState(false)
  const [hostEndedMeeting, setHostEndedMeeting] = useState(false)
  const [isEnding, setIsEnding] = useState(false)
  const [endMeetingError, setEndMeetingError] = useState<string | null>(null)
  const [isMutingAll, setIsMutingAll] = useState(false)
  const [pendingMuteIdentity, setPendingMuteIdentity] = useState<string | null>(null)

  const [audioInputs, setAudioInputs] = useState<MediaDeviceEntry[]>([])
  const [videoInputs, setVideoInputs] = useState<MediaDeviceEntry[]>([])
  const [audioOutputs, setAudioOutputs] = useState<MediaDeviceEntry[]>([])
  const [selectedAudioId, setSelectedAudioId] = useState<string | undefined>(undefined)
  const [selectedVideoId, setSelectedVideoId] = useState<string | undefined>(undefined)
  const [selectedAudioOutputId, setSelectedAudioOutputId] = useState<string | undefined>(undefined)

  // ---- 背景効果（2026-08-13 FR-7）----
  // 「入室前に保存されていた選択」を一度だけ読む（joinResultRef と同じ作法）。
  // 設定モーダルは isOpen=false の間 DOM に出ないので、ここで実値を直読みしても
  // hydration mismatch にはならない（サーバー初回出力と食い違いようがない）。
  const initialBackgroundSelectionRef = useRef(loadBackgroundSelection())
  const [backgroundSelection, setBackgroundSelection] = useState<BackgroundSelection>(
    initialBackgroundSelectionRef.current,
  )
  /** 直近に作った自传図の blob: URL。次の切替の前に解放する（無限に溜めない）。 */
  const lastCustomBackgroundUrlRef = useRef<string | null>(null)
  /**
   * 今まさに背景効果を適用中か。provider が「効果を none に落とした」と言ってきたとき、
   * それが**運行中の故障**なのか**ユーザーが今 none を選んだ／適用に失敗した**のかを
   * 区別するためのガード（後者は既に別のトーストを出しているので二重に出さない）。
   */
  const backgroundApplyingRef = useRef(false)
  /** レンダースコープの backgroundSelection を、接続 effect 内の closure から読むための鏡。 */
  const backgroundSelectionRef = useRef(backgroundSelection)
  useEffect(() => {
    backgroundSelectionRef.current = backgroundSelection
  }, [backgroundSelection])

  // ---- カメラの自己修復通知（2026-08-14 第 2 波）----
  // provider は黙ってカメラを取り直す。UI から見えるのは videoEnabled の false→true だけで、
  // 自分の操作と区別が付かないので、マイク（micIntent）と同じく「呼ぶ直前の意図」で判定する。
  // 判定は純関数（./camera-notice.ts）、ここは ref とタイマーの管理だけ。
  const cameraIntentRef = useRef<CameraIntent | null>(null)
  /** 「オフになった。復旧を待っている」猶予タイマー。期限切れ＝復旧失敗の通知を出す。 */
  const cameraNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const settingsDisclosure = useDisclosure()
  const endConfirmDisclosure = useDisclosure()
  const muteAllDisclosure = useDisclosure()
  // 2026-08-16 実機フィードバック：退出ボタンの即断線が突然すぎるための確認モーダル。
  // endConfirmDisclosure（会議終了）とは別の state——「退出」と「終了」は別ボタン・
  // 別モーダルで、互いに独立して開閉する（片方の確認がもう片方を巻き込まない）。
  const leaveConfirmDisclosure = useDisclosure()

  // 一度だけ読む（sessionStorage は connect effect の外で確定させ、以後は ref に固定）。
  const joinResultRef = useRef(loadJoinResult(roomCode))

  // ⚠️ 実機確認で見つかった競合の回避：自分（host）が「会議を終了」した直後、
  // LiveKit サーバーから届く 'room_deleted' 切断イベントと、自分自身が呼ぶ
  // provider.disconnect() が競合する。前者が先に届くと handleDisconnected 内の
  // 'room_deleted' 分岐が自分自身にも発火し、/j へリダイレクトしてしまい、
  // 本来出すべき「会議を終了しました」の専用画面（hostEndedMeeting）を踏み潰す。
  // 自分が終了操作をした直後だけこのフラグを立て、'room_deleted' 分岐をスキップする。
  const endedByMeRef = useRef(false)

  // roomCode（公開用の短いコード）→ rooms.id（uuid）のキャッシュ。房主操作系 API
  // （end / participants/mute / mute-all）はすべて uuid を取るため（app/api/rooms/[code]/**）。
  const roomIdRef = useRef<string | null>(null)

  /**
   * rooms.id（uuid）を引く。GET /api/rooms は**自分が房主の部屋しか返さない**ので、
   * 引けること自体が房主であることの確認も兼ねている。会議中に変わらない値なので
   * 一度引けたら ref にキャッシュし、以後の房主操作は追加のラウンドトリップなしで撃てる。
   * （「会議を終了」が元々やっていた手順をそのまま関数に括り出したもの——重複実装しない）
   */
  const resolveRoomId = useCallback(async (): Promise<string> => {
    const cached = roomIdRef.current
    if (cached) return cached
    const listRes = await fetch('/api/rooms')
    if (!listRes.ok) throw new Error('list_failed')
    const listJson = (await listRes.json()) as { rooms?: RoomListItem[] }
    const match = listJson.rooms?.find((r) => r.roomCode === roomCode)
    if (!match) throw new Error('room_not_found')
    roomIdRef.current = match.id
    return match.id
  }, [roomCode])

  // ---- provider 接続ライフサイクル（WP-3 交接铁律：dynamic import、livekit-client は
  //      首屏に含めない）----
  useEffect(() => {
    const joinResult = joinResultRef.current
    if (!joinResult) {
      setSessionMissing(true)
      return
    }
    setSelf({ participantId: joinResult.participantId, displayName: joinResult.displayName, role: joinResult.role })
    setConnectionState('connecting')
    // 入会時に開くマイクを「自分の意図」として先に登録しておく（遠隔ミュート誤検知の防止。
    // 詳細は INITIAL_MIC_INTENT_TTL_MS のコメント）。
    noteMicIntent(joinResult.initialAudio, INITIAL_MIC_INTENT_TTL_MS)
    // カメラも同様。入室直後のカメラ ON を「勝手にオンになった」と誤検知させない。
    cameraIntentRef.current = {
      enabled: joinResult.initialVideo,
      expiresAt: Date.now() + INITIAL_CAMERA_INTENT_TTL_MS,
    }

    let cancelled = false
    let activeProvider: MediaProvider | undefined

    function handleConnected() {
      setConnectionState('connected')
    }
    function handleDisconnected(reason?: string) {
      // ホストが「会議を終了」した場合、LiveKit サーバーは deleteRoom() 経由で
      // 'room_deleted' 理由の切断を送ってくる（lib/server/livekit.ts endLiveKitRoom）。
      // このケースだけは「再接続すれば直る」ものではない（会議そのものが終わった）ので、
      // 汎用の切断オーバーレイではなく /j エントリーへ明確な文言付きで戻す。
      if (reason === 'room_deleted' && !endedByMeRef.current) {
        clearJoinResult(roomCode)
        router.push(`/j/${roomCode}?ended=host`)
        return
      }
      setConnectionState('disconnected', reason ?? null)
    }
    function handleReconnecting() {
      setConnectionState('reconnecting')
    }
    function handleReconnected() {
      setConnectionState('connected')
    }
    function handleParticipantJoined(p: RemoteParticipant) {
      upsertParticipant(p)
    }
    function handleParticipantLeft(id: ParticipantId) {
      removeParticipant(id)
    }
    function handleParticipantUpdated(p: RemoteParticipant) {
      upsertParticipant(p)
    }
    function handleActiveSpeakers(ids: ParticipantId[]) {
      setActiveSpeakers(ids)
    }
    /**
     * カメラ変化の通知。「オフを見たら猶予タイマー、期限内にオンが来たら復旧成功、
     * 来なければ停止の案内」——どちらに転んでも必ず何か言う（無言の黒画面を作らない）。
     */
    function applyCameraNotice(prevEnabled: boolean, nextEnabled: boolean) {
      const change = classifyCameraChange(prevEnabled, nextEnabled, cameraIntentRef.current, Date.now())
      const plan = planCameraNotice(change, cameraNoticeTimerRef.current !== null)
      if (plan === 'idle') return
      if (cameraNoticeTimerRef.current !== null) {
        clearTimeout(cameraNoticeTimerRef.current)
        cameraNoticeTimerRef.current = null
      }
      if (plan === 'cancel') return
      if (plan === 'recovered') {
        addToast({ title: currentText().room.cameraRecovered, color: 'success' })
        return
      }
      cameraNoticeTimerRef.current = setTimeout(() => {
        cameraNoticeTimerRef.current = null
        addToast({ title: currentText().room.cameraStopped, color: 'warning' })
      }, CAMERA_RECOVERY_GRACE_MS)
    }

    /**
     * 背景効果が provider 側の判断で none に落とされた（＝運行中に処理管線が死んだ）とき、
     * ピッカーの選択状態を戻して通知する。localStorage は**書き換えない**——
     * 端末や GPU の一過性の問題であることが多く、次のセッションでは普通に動くため。
     */
    function handleBackgroundFallback(s: LocalState) {
      if (backgroundApplyingRef.current) return // ユーザー操作の途中：別のトーストが担当
      if (s.backgroundEffect && s.backgroundEffect.type !== 'none') return
      if (backgroundSelectionRef.current.kind === 'none') return
      backgroundSelectionRef.current = NONE_SELECTION
      setBackgroundSelection(NONE_SELECTION)
      addToast({ title: currentText().background.disabledByError, color: 'warning' })
    }

    function handleLocalStateChanged(s: LocalState) {
      // 判定は「変化を受け取った時点で接続済みだったか」で見る：再接続完了時の
      // 状態同期（provider は Reconnected → syncLocalState → 'reconnected' の順で
      // 動くので、この時点ではまだ 'reconnecting'）を遠隔ミュートと誤認しない。
      const wasConnected = useMeetingStore.getState().connectionState === 'connected'
      // setLocalState は store を書き換えてしまうので、前の値はその**手前**で控える。
      const prevVideoEnabled = useMeetingStore.getState().localState.videoEnabled
      const change = setLocalState(s)
      if (wasConnected) {
        applyCameraNotice(prevVideoEnabled, s.videoEnabled)
        handleBackgroundFallback(s)
      }
      if (!change || change.source !== 'remote' || !wasConnected) return
      const t = currentText()
      addToast({
        title: change.audioEnabled ? t.mute.unmutedByHost : t.mute.mutedByHost,
        color: change.audioEnabled ? 'primary' : 'warning',
      })
    }
    function handleChatMessageReceived(message: ChatMessage) {
      receiveChatMessage(message)
    }
    function handleError(e: MediaError) {
      setError(e)
    }

    ;(async () => {
      const { createMediaProvider } = await import('@/lib/media')
      if (cancelled) return
      const instance = createMediaProvider(joinResult.config)
      activeProvider = instance

      instance.on('connected', handleConnected)
      instance.on('disconnected', handleDisconnected)
      instance.on('reconnecting', handleReconnecting)
      instance.on('reconnected', handleReconnected)
      instance.on('participantJoined', handleParticipantJoined)
      instance.on('participantLeft', handleParticipantLeft)
      instance.on('participantUpdated', handleParticipantUpdated)
      instance.on('activeSpeakersChanged', handleActiveSpeakers)
      instance.on('localStateChanged', handleLocalStateChanged)
      instance.on('chatMessageReceived', handleChatMessageReceived)
      instance.on('error', handleError)

      setProvider(instance)

      try {
        await instance.connect({
          config: joinResult.config,
          displayName: joinResult.displayName,
          initialAudio: joinResult.initialAudio,
          initialVideo: joinResult.initialVideo,
          initialAudioDeviceId: joinResult.initialAudioDeviceId,
          initialVideoDeviceId: joinResult.initialVideoDeviceId,
        })
        // ⚠️ 実機確認で見つかった不具合の修正：`participantJoined` は「自分の接続後に
        // 入ってきた人」にしか発火しない。自分より先に部屋にいた参加者は、connect()
        // 成功時点の room 状態にしか現れない（イベントは追って発火しない）ので、
        // ここで一度スナップショットを取って初期ロスターを埋める。以後の増減は
        // 通常どおり participantJoined/Left/Updated イベントに任せる。
        if (!cancelled) {
          for (const participant of instance.getParticipants()) {
            upsertParticipant(participant)
          }
        }
        // ---- 背景効果の再適用（2026-08-13 FR-7）----
        // 入室前に選んでいた効果を connect 完了後に一度だけ再生する。'none' なら
        // 何も呼ばない（provider 側は connect 直後 'none' が既定なので不要な呼び出し）。
        // 失敗してもここでは toast 一回だけ・入室自体はブロックしない契約。
        const savedSelection = initialBackgroundSelectionRef.current
        if (!cancelled && savedSelection.kind !== 'none') {
          backgroundApplyingRef.current = true
          try {
            const effect = await resolveBackgroundEffect(savedSelection)
            if (effect && !cancelled) {
              await instance.setBackgroundEffect(effect)
              setBackgroundSelection(savedSelection)
            }
          } catch {
            if (!cancelled) addToast({ title: currentText().background.applyFailed, color: 'warning' })
          } finally {
            backgroundApplyingRef.current = false
          }
        }
      } catch {
        // connect() はすでに 'error' を emit 済み・throw もする。ここでは状態は
        // イベント経由（store）で反映されるので追加処理は不要。
      }
    })()

    return () => {
      cancelled = true
      if (activeProvider) {
        activeProvider.off('connected', handleConnected)
        activeProvider.off('disconnected', handleDisconnected)
        activeProvider.off('reconnecting', handleReconnecting)
        activeProvider.off('reconnected', handleReconnected)
        activeProvider.off('participantJoined', handleParticipantJoined)
        activeProvider.off('participantLeft', handleParticipantLeft)
        activeProvider.off('participantUpdated', handleParticipantUpdated)
        activeProvider.off('activeSpeakersChanged', handleActiveSpeakers)
        activeProvider.off('localStateChanged', handleLocalStateChanged)
        activeProvider.off('chatMessageReceived', handleChatMessageReceived)
        activeProvider.off('error', handleError)
        void activeProvider.disconnect()
      }
      reset()
      // 猶予タイマーが生き残ると、会議を抜けた後に「カメラが停止しました」が出る。
      if (cameraNoticeTimerRef.current !== null) {
        clearTimeout(cameraNoticeTimerRef.current)
        cameraNoticeTimerRef.current = null
      }
      // 自传図の blob: URL が残っていれば解放する（§12.6 と同じ attach/detach の考え方）。
      if (lastCustomBackgroundUrlRef.current) {
        URL.revokeObjectURL(lastCustomBackgroundUrlRef.current)
        lastCustomBackgroundUrlRef.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomCode])

  // ---- デバイス一覧（設定モーダル用。既に許可済みなのでラベルも取れる）----
  useEffect(() => {
    let cancelled = false
    mediaDeviceHelper
      .listDevices()
      .then((list) => {
        if (cancelled) return
        setAudioInputs(list.filter((d) => d.kind === 'audioinput'))
        setVideoInputs(list.filter((d) => d.kind === 'videoinput'))
        setAudioOutputs(list.filter((d) => d.kind === 'audiooutput'))
        const prefs = getDevicePrefs()
        setSelectedAudioId(joinResultRef.current?.initialAudioDeviceId ?? prefs.audioDeviceId)
        setSelectedVideoId(joinResultRef.current?.initialVideoDeviceId ?? prefs.videoDeviceId)
        setSelectedAudioOutputId(prefs.audioOutputDeviceId)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  // ---- 遥测：接続後 30 秒毎に getStats() → POST /api/telemetry/quality。
  //      §6.4/WP-3 交接：首次采样丢弃（seed baseline のみ、送信しない）----
  useEffect(() => {
    if (connectionState !== 'connected' || !provider || !self) return
    let cancelled = false

    provider.getStats().catch(() => {})

    const timer = setInterval(() => {
      if (cancelled) return
      provider
        .getStats()
        .then((stats) =>
          fetch('/api/telemetry/quality', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ participantId: self.participantId, ...stats }),
          }),
        )
        .catch(() => {})
    }, TELEMETRY_INTERVAL_MS)

    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [connectionState, provider, self])

  // ---- iOS/バックグラウンド復帰時の断線検知（§7.6）----
  useEffect(() => {
    function handleVisibilityChange() {
      if (document.visibilityState !== 'visible') return
      if (!provider) return
      if (!provider.isConnected() && connectionState !== 'disconnected') {
        setConnectionState('disconnected', 'visibility_resume')
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [provider, connectionState, setConnectionState])

  // ---- lastError の自動クリア（トースト的表示。5 秒で消す）----
  useEffect(() => {
    if (!lastError) return
    const timer = setTimeout(() => setError(null), 5000)
    return () => clearTimeout(timer)
  }, [lastError, setError])

  const isHost = self?.role === 'host'
  // 同期・無副作用（契約どおり）なので毎レンダー呼んでよい。provider がまだ無い
  // ごく短い接続直後の窓では「非対応」寄りに倒れる（§ 詳細は最終レポート参照）。
  const isBackgroundSupported = provider?.isBackgroundEffectSupported() ?? false

  // ---- 房主なら uuid を先読みしておく（ミュートボタンを押した瞬間の待ちを無くす）----
  useEffect(() => {
    if (!isHost || connectionState !== 'connected') return
    // 失敗しても無視：実際に操作したときに再試行され、そこで初めてエラーを出す。
    resolveRoomId().catch(() => {})
  }, [isHost, connectionState, resolveRoomId])

  async function handleToggleMic() {
    if (!provider) return
    // ⚠️ provider を呼ぶ**前**に意図を記録する。呼んだ後だと、localStateChanged が
    // 先に届いて「自分でミュートしたのに主催者にミュートされた」と誤検知しうる。
    noteMicIntent(!localState.audioEnabled)
    try {
      await provider.setMicrophoneEnabled(!localState.audioEnabled)
    } catch {
      // provider が既に error イベントを emit 済み（store 経由でトースト表示）
    }
  }

  async function handleToggleCamera() {
    if (!provider) return
    // ⚠️ マイクと同じ理由で provider を呼ぶ**前**に意図を記録する。後だと
    // localStateChanged が先に届いて「勝手にオフになった」と誤検知しうる。
    cameraIntentRef.current = {
      enabled: !localState.videoEnabled,
      expiresAt: Date.now() + CAMERA_INTENT_TTL_MS,
    }
    try {
      await provider.setCameraEnabled(!localState.videoEnabled)
    } catch {
      // 同上
    }
  }

  async function handleChangeAudioDevice(deviceId: string) {
    setSelectedAudioId(deviceId)
    setDevicePrefs({ audioDeviceId: deviceId, videoDeviceId: selectedVideoId, audioOutputDeviceId: selectedAudioOutputId })
    await provider?.switchAudioDevice(deviceId).catch(() => {})
  }

  async function handleChangeVideoDevice(deviceId: string) {
    setSelectedVideoId(deviceId)
    setDevicePrefs({ audioDeviceId: selectedAudioId, videoDeviceId: deviceId, audioOutputDeviceId: selectedAudioOutputId })
    await provider?.switchVideoDevice(deviceId).catch(() => {})
  }

  async function handleChangeAudioOutputDevice(deviceId: string) {
    setSelectedAudioOutputId(deviceId)
    setDevicePrefs({ audioDeviceId: selectedAudioId, videoDeviceId: selectedVideoId, audioOutputDeviceId: deviceId })
    await provider?.setAudioOutputDevice(deviceId).catch(() => {})
  }

  // ---- 背景効果（2026-08-13 FR-7）----
  /**
   * `BackgroundSelection` → 実際に provider へ渡せる `BackgroundEffect` を解決する。
   * `custom` だけ非同期（IndexedDB から Blob を取ってきて blob: URL を作る）。
   * 前回作った自传図の blob: URL はここで使い切ったら用済みなので、次を作る前に解放する
   * （provider は setBackgroundEffect のその場で読むだけで、以後 URL を保持し続けない前提）。
   */
  async function resolveBackgroundEffect(selection: BackgroundSelection) {
    if (selection.kind !== 'custom') return backgroundSelectionToEffect(selection)
    const stored = await backgroundImageStore.getImage(selection.imageKey)
    if (!stored) return null // 別タブ等で既に削除されていた——呼び出し側が失敗として扱う
    if (lastCustomBackgroundUrlRef.current) URL.revokeObjectURL(lastCustomBackgroundUrlRef.current)
    const url = URL.createObjectURL(stored.blob)
    lastCustomBackgroundUrlRef.current = url
    return backgroundSelectionToEffect(selection, url)
  }

  /** BackgroundPicker の onSelect。成功したときだけ localStorage に書き、UI の選択状態を進める。 */
  async function handleSelectBackground(selection: BackgroundSelection): Promise<boolean> {
    const t = currentText()
    if (!provider) return false
    // 適用中フラグ：この間に飛んでくる localStateChanged（none への遷移を含む）は
    // ユーザー操作の結果であって「管線の故障」ではない——handleBackgroundFallback が誤爆しない。
    backgroundApplyingRef.current = true
    try {
      const effect = await resolveBackgroundEffect(selection)
      if (!effect) {
        addToast({ title: t.background.applyFailed, color: 'danger' })
        return false
      }
      await provider.setBackgroundEffect(effect)
      saveBackgroundSelection(selection)
      setBackgroundSelection(selection)
      backgroundSelectionRef.current = selection
      return true
    } catch {
      addToast({ title: t.background.applyFailed, color: 'danger' })
      return false
    } finally {
      backgroundApplyingRef.current = false
    }
  }

  // ---- チャット（FR-4）----
  /** 送信できたら true。失敗時は false を返し、ChatPanel 側で下書きを残す。 */
  async function handleSendChat(message: string): Promise<boolean> {
    const t = currentText()
    if (!provider) return false
    // provider も同じ上限で弾くが（MediaError UNKNOWN）、UI で先に止めて具体的な
    // 文言を出す——「送信できません」だけでは何を直せばいいか分からない。
    if (message.length > MAX_CHAT_TEXT_LENGTH) {
      addToast({ title: interpolate(t.chat.tooLong, { max: MAX_CHAT_TEXT_LENGTH }), color: 'warning' })
      return false
    }
    try {
      const sent = await provider.sendChatMessage(message)
      // 自分のメッセージは送信結果で回显する（chatMessageReceived は遠端専用）。
      addLocalChatMessage(sent)
      return true
    } catch {
      addToast({ title: t.chat.sendFailed, color: 'danger' })
      return false
    }
  }

  // ---- 遠隔ミュート（房主のみ）----
  /** resolveRoomId() が投げる内部エラー → ユーザー向け文言。 */
  function roomIdErrorMessage(err: unknown, t: UiTextDict): string {
    return err instanceof Error && err.message === 'room_not_found'
      ? muteErrorMessage('ROOM_NOT_FOUND', useLocaleStore.getState().locale)
      : t.common.networkError
  }

  async function handleToggleParticipantMute(participant: RemoteParticipant) {
    if (pendingMuteIdentity) return
    const t = currentText()
    const nextMuted = participant.audioEnabled // 今オン → ミュートする / 今オフ → 解除する
    setPendingMuteIdentity(participant.id)
    try {
      const roomId = await resolveRoomId()
      const res = await fetch(`/api/rooms/${roomId}/participants/mute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identity: participant.id, muted: nextMuted }),
      })
      if (!res.ok) {
        const json = await res.json().catch(() => null)
        addToast({
          title: muteErrorMessage(json?.error?.code, useLocaleStore.getState().locale),
          color: 'danger',
        })
        return
      }
      // 実際のミュート状態は LiveKit の TrackMuted → participantUpdated 経由で
      // タイルに反映される（ここで楽観更新はしない＝表示が嘘をつかない）。
      addToast({
        title: interpolate(nextMuted ? t.mute.muteSuccess : t.mute.unmuteSuccess, { name: participant.name }),
        color: 'success',
      })
    } catch (err) {
      addToast({ title: roomIdErrorMessage(err, t), color: 'danger' })
    } finally {
      setPendingMuteIdentity(null)
    }
  }

  async function handleConfirmMuteAll() {
    const t = currentText()
    setIsMutingAll(true)
    try {
      const roomId = await resolveRoomId()
      const res = await fetch(`/api/rooms/${roomId}/participants/mute-all`, { method: 'POST' })
      const json = await res.json().catch(() => null)
      if (!res.ok) {
        addToast({ title: muteErrorMessage(json?.error?.code, useLocaleStore.getState().locale), color: 'danger' })
        return
      }
      const result = (json ?? { muted: 0, skipped: 0, failed: 0 }) as MuteAllResult
      muteAllDisclosure.onClose()
      // 部分失敗（failed > 0）は必ず伝える：「全員ミュートしました」とだけ出して
      // 実は数人生きている、が一番まずい。
      addToast({
        title: interpolate(t.mute.muteAllSuccess, { count: result.muted }),
        description: result.failed > 0 ? interpolate(t.mute.muteAllPartial, { failed: result.failed }) : undefined,
        color: result.failed > 0 ? 'warning' : 'success',
      })
    } catch (err) {
      addToast({ title: roomIdErrorMessage(err, t), color: 'danger' })
    } finally {
      setIsMutingAll(false)
    }
  }

  function handleLeave() {
    void provider?.disconnect()
    clearJoinResult(roomCode)
    router.push(`/j/${roomCode}?left=1`)
  }

  /** LeaveConfirmModal の確定ボタン。閉じてから既存の退出処理へ進む（ネットワーク応答を
   *  待たない同期的な処理なので、EndMeetingModal のような isLoading 相当は不要）。 */
  function handleConfirmLeave() {
    leaveConfirmDisclosure.onClose()
    handleLeave()
  }

  async function handleConfirmEndMeeting() {
    setIsEnding(true)
    setEndMeetingError(null)
    // ⚠️ 実機確認で見つかった競合：/end の route handler は HTTP レスポンスを返す前に
    // LiveKit の deleteRoom() を呼ぶ（app/api/rooms/[code]/end/route.ts）。その結果届く
    // WebSocket 経由の 'room_deleted' 切断は、fetch の応答が戻るより早く自分のクライアントに
    // 到達しうる（別チャネルなので順序保証がない）。よってガードは fetch を投げる**前**に
    // 立てる必要がある——fetch 成功後に立てたのでは間に合わないことを実機で確認済み。
    endedByMeRef.current = true
    try {
      const roomId = await resolveRoomId()
      const endRes = await fetch(`/api/rooms/${roomId}/end`, { method: 'POST' })
      if (!endRes.ok) throw new Error('end_failed')

      endConfirmDisclosure.onClose()
      clearJoinResult(roomCode)
      setHostEndedMeeting(true)
      void provider?.disconnect()
    } catch {
      // 終了に失敗したなら抑制を解除する——今後この接続に届く本物の 'room_deleted' は
      // （通常あり得ないが）正しくハンドリングされるべきなので、フラグを立てっぱなしにしない。
      endedByMeRef.current = false
      setEndMeetingError(text.room.endMeetingError)
    } finally {
      setIsEnding(false)
    }
  }

  function handleRejoin() {
    router.push(`/j/${roomCode}/prejoin`)
  }

  function handleGoToEntry() {
    router.push(`/j/${roomCode}`)
  }

  const rootClass = 'dark relative flex h-dvh w-full flex-col overflow-hidden bg-zinc-950 text-zinc-100'

  // sessionMissing / hostEndedMeeting の早期 return 画面にも、下の本体 return と同じ
  // 位置・z-index で LocaleSwitcher を置く（このページに入った直後にセッションが無い/
  // 主催者が終了済みだった場合でも言語切替できるように）。
  if (sessionMissing) {
    return (
      <div className={rootClass}>
        <LocaleSwitcher className="absolute right-4 top-4 z-40" />
        <FullScreenNotice
          title={text.room.missingSessionTitle}
          body={text.room.missingSessionBody}
          primaryLabel={text.room.goToEntry}
          onPrimary={handleGoToEntry}
          icon={<AlertTriangleIcon className="h-8 w-8 text-amber-400" />}
        />
      </div>
    )
  }

  if (hostEndedMeeting) {
    return (
      <div className={rootClass}>
        <LocaleSwitcher className="absolute right-4 top-4 z-40" />
        <FullScreenNotice
          title={text.room.endedByHostTitle}
          body={text.room.endedByHostBody}
          primaryLabel={text.room.backHome}
          onPrimary={() => router.push('/')}
        />
      </div>
    )
  }

  const participantList = Object.values(participants)

  return (
    <div className={rootClass}>
      {/* トーストキューの受け皿（addToast はどこの ToastProvider にも積める共有キュー）。
          ミュート結果・チャット送信失敗・遠隔ミュート通知はすべてここに出る。 */}
      <ToastProvider placement="top-center" />
      {connectionState === 'reconnecting' && <ConnectionBanner message={text.room.reconnecting} />}

      {/* 横並びの行：左＝ビデオ領域、右＝チャット（デスクトップ）。チャットを開くと
          ビデオ領域が縮む（グリッドの上に被せない＝顔が隠れない）。 */}
      <div className="relative flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          {/* z-40：切断時などの FullScreenNotice（z-30）より上に置き、通知画面でも言語切替を
              使えるようにする。⚠️ ルート直下ではなく**ビデオ列の中**に置くこと——ルート直下だと
              チャットを開いたときにサイドバーの右上（＝パネルを閉じる × ボタンと但し書き）に
              重なって、閉じるボタンが押せなくなる（実機確認で発見）。
              2026-08-14：モバイル（<md）では非表示にする（映像を覆ってしまうため）。代わりの
              導線は DeviceSettingsModal の先頭に用意した（下記 DeviceSettingsModal 参照）。
              sessionMissing / hostEndedMeeting の早期 return 画面（このコンポーネントの他の
              LocaleSwitcher）は対象外——そちらには設定モーダルという代替導線が無いので、
              モバイルでも常時表示のまま変えない。 */}
          <LocaleSwitcher className="absolute right-4 top-4 z-40 hidden md:inline-flex" />
          {provider && (
            <VideoGrid
              provider={provider}
              participants={participantList}
              activeSpeakers={activeSpeakers}
              roomCode={roomCode}
              hostControls={
                isHost
                  ? { pendingIdentity: pendingMuteIdentity, onToggleMute: handleToggleParticipantMute }
                  : undefined
              }
              text={text}
            />
          )}
          {provider && self && (
            <LocalPreviewTile provider={provider} displayName={self.displayName} localState={localState} text={text} />
          )}

          {connectionState === 'disconnected' && (
            <FullScreenNotice
              title={text.room.disconnectedTitle}
              body={text.room.disconnectedBody}
              primaryLabel={text.room.rejoin}
              onPrimary={handleRejoin}
              icon={<AlertTriangleIcon className="h-8 w-8 text-amber-400" />}
            />
          )}

          {lastError && (
            <div className="pointer-events-none absolute inset-x-0 top-4 z-20 flex justify-center px-4">
              <div className="pointer-events-auto rounded-lg bg-zinc-800/95 px-4 py-2 text-sm text-zinc-100 shadow ring-1 ring-white/10">
                {mediaErrorMessage(lastError.code, locale)}
              </div>
            </div>
          )}
          {endMeetingError && (
            <div className="pointer-events-none absolute inset-x-0 top-4 z-20 flex justify-center px-4">
              <div className="pointer-events-auto rounded-lg bg-red-900/90 px-4 py-2 text-sm text-white shadow">
                {endMeetingError}
              </div>
            </div>
          )}

          {/* コントロールドックはビデオ列の中に置く：チャットを開いたときも
              ドックはビデオ領域の中央に留まり、サイドバーに被らない。 */}
          {self && (
            <ControlBar
              localState={localState}
              isHost={isHost}
              isChatOpen={isChatOpen}
              isParticipantsOpen={isParticipantsOpen}
              participantCount={totalParticipantCount(participantList.length)}
              unreadCount={unreadCount}
              isMutingAll={isMutingAll}
              onToggleMic={handleToggleMic}
              onToggleCamera={handleToggleCamera}
              onOpenSettings={settingsDisclosure.onOpen}
              onToggleChat={toggleChat}
              onToggleParticipants={toggleParticipants}
              onRequestMuteAll={muteAllDisclosure.onOpen}
              onLeave={leaveConfirmDisclosure.onOpen}
              onRequestEndMeeting={endConfirmDisclosure.onOpen}
              text={text}
            />
          )}
        </div>

        {isChatOpen && self && (
          <ChatPanel
            messages={chatMessages}
            // ⚠️ self.participantId（DB uuid）ではない。理由は meeting-store の
            // selfChatIdentity のコメント参照。
            selfIdentity={selfChatIdentity}
            canSend={connectionState === 'connected'}
            onSend={handleSendChat}
            onClose={() => setChatOpen(false)}
            text={text}
          />
        )}

        {isParticipantsOpen && self && (
          <ParticipantsPanel
            self={{ displayName: self.displayName, role: self.role }}
            localState={localState}
            participants={participantList}
            activeSpeakers={activeSpeakers}
            // 個別ミュートはタイル側と**同じハンドラ・同じ pending 状態**を渡す
            // （リクエスト処理を二重に持たない＝挙動もエラー文言も必ず一致する）。
            hostControls={
              isHost ? { pendingIdentity: pendingMuteIdentity, onToggleMute: handleToggleParticipantMute } : undefined
            }
            onRequestMuteAll={isHost ? muteAllDisclosure.onOpen : undefined}
            isMutingAll={isMutingAll}
            onClose={() => setParticipantsOpen(false)}
            text={text}
          />
        )}
      </div>

      <DeviceSettingsModal
        isOpen={settingsDisclosure.isOpen}
        onOpenChange={settingsDisclosure.onOpenChange}
        audioInputs={audioInputs}
        videoInputs={videoInputs}
        audioOutputs={audioOutputs}
        selectedAudioId={selectedAudioId}
        selectedVideoId={selectedVideoId}
        selectedAudioOutputId={selectedAudioOutputId}
        onChangeAudio={handleChangeAudioDevice}
        onChangeVideo={handleChangeVideoDevice}
        onChangeAudioOutput={handleChangeAudioOutputDevice}
        isBackgroundSupported={isBackgroundSupported}
        backgroundSelection={backgroundSelection}
        onSelectBackground={handleSelectBackground}
        text={text}
      />
      <EndMeetingModal
        isOpen={endConfirmDisclosure.isOpen}
        onOpenChange={endConfirmDisclosure.onOpenChange}
        onConfirm={handleConfirmEndMeeting}
        isEnding={isEnding}
        text={text}
      />
      <LeaveConfirmModal
        isOpen={leaveConfirmDisclosure.isOpen}
        onOpenChange={leaveConfirmDisclosure.onOpenChange}
        onConfirm={handleConfirmLeave}
        text={text}
      />
      <MuteAllModal
        isOpen={muteAllDisclosure.isOpen}
        onOpenChange={muteAllDisclosure.onOpenChange}
        onConfirm={handleConfirmMuteAll}
        isMuting={isMutingAll}
        text={text}
      />
    </div>
  )
}
