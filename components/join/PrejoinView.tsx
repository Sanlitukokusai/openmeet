'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import NextLink from 'next/link'
import {
  Alert,
  Button,
  Card,
  CardBody,
  CardHeader,
  Select,
  SelectItem,
  Spinner,
  Switch,
  ToastProvider,
  addToast,
} from '@heroui/react'
import { mediaDeviceHelper } from '@/lib/media/devices'
import type {
  BackgroundEffect,
  BackgroundPreviewSession,
  MediaDeviceEntry,
  ProviderConfig,
} from '@/lib/media/types'
import { formatRoomCode, normalizeRoomCode } from '@/lib/room-code'
import {
  getDevicePrefs,
  loadJoinDraft,
  saveJoinResult,
  setDevicePrefs,
  type JoinDraft,
} from '@/lib/store/join-storage'
import {
  NONE_SELECTION,
  backgroundImageStore,
  backgroundSelectionToEffect,
  loadBackgroundSelection,
  saveBackgroundSelection,
  type BackgroundSelection,
} from '@/lib/background-storage'
import { joinErrorMessage, mediaErrorMessage, useLocale, uiText } from '@/lib/ui-text'
import { LocaleSwitcher } from '@/components/LocaleSwitcher'
import { BackgroundPicker } from '@/components/BackgroundPicker'
import { AlertTriangleIcon, ChevronLeftIcon } from '@/components/icons'
import { DevicePreviewVideo } from './DevicePreviewVideo'

interface JoinSuccessResponse {
  config: ProviderConfig
  role: 'host' | 'guest'
  participantId: string
  maxParticipants: number
}

type PermissionState = 'checking' | { audio: boolean; video: boolean }

/**
 * プレビューが「今なにを待っているか」。null＝待ちなし。
 * `starting`＝カメラの取得／切替、`applying`＝背景効果の適用（初回は MediaPipe の
 * モデル ~9.7MB のダウンロードを含むので、ここは**本物の待ち時間**になる）。
 */
type PreviewPhase = 'starting' | 'applying' | null

type JoinErrorKind = 'retryable' | 'login' | 'terminal'

interface JoinErrorState {
  message: string
  kind: JoinErrorKind
}

export function PrejoinView({ roomCode: rawRoomCode }: { roomCode: string }) {
  const roomCode = normalizeRoomCode(rawRoomCode)
  const router = useRouter()
  const locale = useLocale()
  const t = uiText[locale]

  const [draft, setDraft] = useState<JoinDraft | null | 'checking'>('checking')
  const [permission, setPermission] = useState<PermissionState>('checking')
  const [audioInputs, setAudioInputs] = useState<MediaDeviceEntry[]>([])
  const [videoInputs, setVideoInputs] = useState<MediaDeviceEntry[]>([])
  const [audioOutputs, setAudioOutputs] = useState<MediaDeviceEntry[]>([])
  const [micOn, setMicOn] = useState(true)
  const [camOn, setCamOn] = useState(true)
  const [selectedAudioId, setSelectedAudioId] = useState<string | undefined>(undefined)
  const [selectedVideoId, setSelectedVideoId] = useState<string | undefined>(undefined)
  const [selectedAudioOutputId, setSelectedAudioOutputId] = useState<string | undefined>(undefined)
  /** デバイス列挙が終わったか。プレビューは「どのカメラを使うか」が確定してから起こす
   *  （先に起こすと既定カメラで開いてから即座に切り替える二度手間になる）。 */
  const [devicesReady, setDevicesReady] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [joinError, setJoinError] = useState<JoinErrorState | null>(null)
  // SSR / 初回レンダーは常に「なし」で固定し、マウント後に実際の localStorage 値へ
  // 補正する（lib/ui-text.ts の useLocale() と同じ hydration mismatch 回避策——
  // このピッカーは prejoin では常に表示されているので、サーバーとクライアントの
  // 初回出力を一致させる必要がある）。
  const [backgroundSelection, setBackgroundSelection] = useState<BackgroundSelection>(NONE_SELECTION)

  // ---- リアルタイムプレビュー（2026-08-16 実機フィードバック③）----
  /** `<video>` 実体。プレビューセッションはここへ直接 attach する。 */
  const videoRef = useRef<HTMLVideoElement>(null)
  /** 現在のセッション。カメラ OFF・ページ離脱で必ず dispose する（カメラを握ったままにしない）。 */
  const sessionRef = useRef<BackgroundPreviewSession | null>(null)
  /** セッションに実際に適用済みのカメラ deviceId（切替検知用。作り直しの二度手間を防ぐ）。 */
  const appliedDeviceIdRef = useRef<string | undefined>(undefined)
  /** レンダースコープの値を非同期処理の途中から読むための鏡（RoomExperience と同じ作法）。 */
  const selectedVideoIdRef = useRef<string | undefined>(undefined)
  const backgroundSelectionRef = useRef<BackgroundSelection>(NONE_SELECTION)
  /** 直近に作った自傳図の blob: URL。次を作る前に解放する（無限に溜めない）。 */
  const lastCustomBackgroundUrlRef = useRef<string | null>(null)
  const [isPreviewLive, setIsPreviewLive] = useState(false)
  const [previewPhase, setPreviewPhase] = useState<PreviewPhase>(null)

  useEffect(() => {
    selectedVideoIdRef.current = selectedVideoId
  }, [selectedVideoId])
  useEffect(() => {
    backgroundSelectionRef.current = backgroundSelection
  }, [backgroundSelection])

  // ---- draft の読み込み（無ければ前段へ戻す）----
  useEffect(() => {
    const loaded = loadJoinDraft(roomCode)
    setDraft(loaded)
    if (!loaded) {
      router.replace(`/j/${roomCode}`)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomCode])

  // ---- 背景効果の選択を localStorage から復元（2026-08-13 FR-7）----
  // マウント後にしか実行しない＝サーバー側の初回出力（常に「なし」選択）と食い違わない。
  useEffect(() => {
    setBackgroundSelection(loadBackgroundSelection())
  }, [])

  // ---- 権限確認 + デバイス列挙（§7.5）----
  useEffect(() => {
    let cancelled = false
    async function run() {
      let granted: { audio: boolean; video: boolean }
      try {
        granted = await mediaDeviceHelper.requestPermission()
      } catch {
        granted = { audio: false, video: false }
      }
      if (cancelled) return
      setPermission(granted)
      if (!granted.audio) setMicOn(false)
      if (!granted.video) setCamOn(false)

      const list = await mediaDeviceHelper.listDevices().catch(() => [])
      if (cancelled) return
      const audio = list.filter((d) => d.kind === 'audioinput')
      const video = list.filter((d) => d.kind === 'videoinput')
      const output = list.filter((d) => d.kind === 'audiooutput')
      setAudioInputs(audio)
      setVideoInputs(video)
      setAudioOutputs(output)

      const prefs = getDevicePrefs()
      const resolvedAudio = audio.find((d) => d.deviceId === prefs.audioDeviceId) ?? audio[0]
      const resolvedVideo = video.find((d) => d.deviceId === prefs.videoDeviceId) ?? video[0]
      const resolvedOutput = output.find((d) => d.deviceId === prefs.audioOutputDeviceId) ?? output[0]
      if (resolvedAudio) setSelectedAudioId(resolvedAudio.deviceId)
      if (resolvedVideo) {
        setSelectedVideoId(resolvedVideo.deviceId)
        selectedVideoIdRef.current = resolvedVideo.deviceId
      }
      if (resolvedOutput) setSelectedAudioOutputId(resolvedOutput.deviceId)
      setDevicesReady(true)
    }
    run()
    return () => {
      cancelled = true
    }
  }, [])

  function retryPermission() {
    setPermission('checking')
    mediaDeviceHelper
      .requestPermission()
      .catch(() => ({ audio: false, video: false }))
      .then((granted) => {
        setPermission(granted)
        if (granted.audio) setMicOn(true)
        if (granted.video) setCamOn(true)
        return mediaDeviceHelper.listDevices().catch(() => [])
      })
      .then((list) => {
        setAudioInputs(list.filter((d) => d.kind === 'audioinput'))
        setVideoInputs(list.filter((d) => d.kind === 'videoinput'))
        setAudioOutputs(list.filter((d) => d.kind === 'audiooutput'))
        setDevicesReady(true)
      })
  }

  // ==========================================================
  // ローカルプレビュー（2026-08-16：本物の背景処理管線つき）
  // ==========================================================
  //
  // 旧実装は素の `getUserMedia` の映像を映すだけで、背景効果は「選択を保存するだけ・
  // 入室後に反映」だった（画面にもその但し書きを出していた）。今は会議内とまったく同じ
  // 管線（LiveKit の LocalVideoTrack ＋ @livekit/track-processors）を connect 前に一時的に
  // 組んで、選んだその場で効果を見せる。
  //
  // ⚠️ 音声は取らない（旧実装は `getUserMedia({audio:true})` も投げていたが、prejoin に
  //    レベルメーターは無く、映像プレビューにも一切使っていなかった＝マイクのインジケータを
  //    無意味に点灯させていただけ）。マイクの可否判定は上の requestPermission() で済んでいる。

  /** セッションを畳んで表示を「カメラオフ」へ戻す。冪等（dispose 自体が冪等）。 */
  function disposePreviewSession() {
    sessionRef.current?.dispose()
    sessionRef.current = null
    appliedDeviceIdRef.current = undefined
    setIsPreviewLive(false)
    setPreviewPhase(null)
  }

  /**
   * `BackgroundSelection` → provider に渡せる `BackgroundEffect`。
   * `custom`（自傳図）だけ非同期：IndexedDB から Blob を出して blob: URL を作る。
   * RoomExperience の同名関数と対になる実装——共通化したいところだが、
   * lib/background-storage.ts は今回のタスクの改変範囲外なので各画面に置いている。
   */
  async function resolveBackgroundEffect(selection: BackgroundSelection): Promise<BackgroundEffect | null> {
    if (selection.kind !== 'custom') return backgroundSelectionToEffect(selection)
    const stored = await backgroundImageStore.getImage(selection.imageKey)
    if (!stored) return null // 別タブ等で削除済み——呼び出し側が失敗として扱う
    if (lastCustomBackgroundUrlRef.current) URL.revokeObjectURL(lastCustomBackgroundUrlRef.current)
    const url = URL.createObjectURL(stored.blob)
    lastCustomBackgroundUrlRef.current = url
    return backgroundSelectionToEffect(selection, url)
  }

  useEffect(() => {
    if (permission === 'checking' || !devicesReady) return
    if (!camOn || !permission.video) {
      // カメラ OFF：セッションを畳む。ピッカーは引き続き操作でき、選択は保存だけされる
      // （＝2026-08-13 以来の挙動に戻る。実際の反映は入室後）。
      disposePreviewSession()
      return
    }

    let cancelled = false
    setPreviewPhase('starting')
    ;(async () => {
      try {
        // ⚠️ 必ず動的 import：lib/media は livekit-client を静的に取り込むので、
        //    素直に import すると prejoin の**初期** chunk に入る（§8.2 / WP-3 交接注記）。
        const { createBackgroundPreviewSession } = await import('@/lib/media')
        const el = videoRef.current
        if (cancelled || !el) return
        const session = await createBackgroundPreviewSession(el, { deviceId: selectedVideoIdRef.current })
        if (cancelled) {
          session.dispose()
          return
        }
        sessionRef.current = session
        appliedDeviceIdRef.current = selectedVideoIdRef.current
        setIsPreviewLive(true)

        // 保存されていた選択をその場で再現する（「入室してみるまで分からない」の解消が今回の主眼）。
        const selection = backgroundSelectionRef.current
        if (selection.kind === 'none') return
        setPreviewPhase('applying')
        try {
          const effect = await resolveBackgroundEffect(selection)
          if (!effect) throw new Error('background selection could not be resolved')
          await session.setEffect(effect)
        } catch {
          // 選択そのもの（localStorage）は消さない：端末側の一過性の問題であることが多く、
          // 入室後に会議側の管線で成功することもある。ここでは「今のプレビューには
          // 反映できなかった」ことを黙らずに伝えるだけに留める。
          if (!cancelled) addToast({ title: t.background.applyFailed, color: 'warning' })
        }
      } catch {
        // カメラが開けない（権限拒否・デバイス無し・他アプリが専有）→ プレースホルダー表示のまま
        if (!cancelled) setIsPreviewLive(false)
      } finally {
        if (!cancelled) setPreviewPhase(null)
      }
    })()

    return () => {
      cancelled = true
      disposePreviewSession()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [permission, camOn, devicesReady])

  // カメラ切替：セッションを作り直さず setDeviceId で差し替える（効果は内部で載せ直される）。
  useEffect(() => {
    const session = sessionRef.current
    if (!session || !isPreviewLive) return
    if (appliedDeviceIdRef.current === selectedVideoId) return
    appliedDeviceIdRef.current = selectedVideoId
    let cancelled = false
    setPreviewPhase('starting')
    session
      .setDeviceId(selectedVideoId)
      .catch(() => {
        if (!cancelled) addToast({ title: mediaErrorMessage('DEVICE_NOT_FOUND', locale), color: 'danger' })
      })
      .finally(() => {
        if (!cancelled) setPreviewPhase(null)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedVideoId, isPreviewLive])

  // 自傳図の blob: URL はアンマウント時に必ず解放する（§12.6 と同じ attach/detach の考え方）。
  useEffect(() => {
    return () => {
      if (lastCustomBackgroundUrlRef.current) {
        URL.revokeObjectURL(lastCustomBackgroundUrlRef.current)
        lastCustomBackgroundUrlRef.current = null
      }
    }
  }, [])

  const permissionFullyDenied = permission !== 'checking' && !permission.audio && !permission.video

  function setListenOnly() {
    setMicOn(false)
    setCamOn(false)
  }

  function setAudioOnly() {
    if (permission !== 'checking' && permission.audio) setMicOn(true)
    setCamOn(false)
  }

  /** 選択を確定して永続化する（プレビューへの反映が成功した後にだけ呼ぶ）。 */
  function commitBackgroundSelection(selection: BackgroundSelection) {
    saveBackgroundSelection(selection)
    setBackgroundSelection(selection)
    backgroundSelectionRef.current = selection
  }

  /**
   * 背景効果ピッカーの `onSelect`（2026-08-16 実機フィードバック③で挙動が変わった）。
   *
   *  - プレビュー稼働中：**先に本物の管線へ適用**し、成功したときだけ localStorage と
   *    選択状態を進める。失敗したら false を返す＝ BackgroundPicker 側は `value` が
   *    変わらないので選択が自動的に元へ戻る（同コンポーネントの契約）＋トーストで理由を出す。
   *  - カメラ OFF（セッション無し）：見せる相手がいないので保存だけ。入室後に会議側が再生する。
   */
  async function handleSelectBackground(selection: BackgroundSelection): Promise<boolean> {
    const session = sessionRef.current
    if (!session) {
      commitBackgroundSelection(selection)
      return true
    }
    setPreviewPhase('applying')
    try {
      const effect = await resolveBackgroundEffect(selection)
      if (!effect) {
        addToast({ title: t.background.applyFailed, color: 'danger' })
        return false
      }
      await session.setEffect(effect)
      commitBackgroundSelection(selection)
      return true
    } catch {
      addToast({ title: t.background.applyFailed, color: 'danger' })
      return false
    } finally {
      setPreviewPhase(null)
    }
  }

  async function handleJoin() {
    if (draft === 'checking' || draft === null) return
    setJoinError(null)
    setIsSubmitting(true)
    try {
      const res = await fetch(`/api/rooms/${roomCode}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: draft.displayName, password: draft.password }),
      })
      const json = await res.json()
      if (!res.ok) {
        const code = json?.error?.code ?? 'UNKNOWN'
        if (code === 'INVALID_PASSWORD') {
          router.push(`/j/${roomCode}?error=${code}`)
          return
        }
        const kind: JoinErrorKind =
          code === 'LOGIN_REQUIRED' ? 'login' : code === 'ROOM_EXPIRED' || code === 'ROOM_ENDED' ? 'terminal' : 'retryable'
        setJoinError({ message: joinErrorMessage(code, locale), kind })
        return
      }

      const success = json as JoinSuccessResponse
      setDevicePrefs({
        audioDeviceId: selectedAudioId,
        videoDeviceId: selectedVideoId,
        audioOutputDeviceId: selectedAudioOutputId,
      })
      saveJoinResult(roomCode, {
        config: success.config,
        role: success.role,
        participantId: success.participantId,
        displayName: draft.displayName,
        initialAudio: micOn,
        initialVideo: camOn,
        initialAudioDeviceId: selectedAudioId,
        initialVideoDeviceId: selectedVideoId,
      })
      // ⚠️ 遷移**前**にプレビューのカメラを手放す。アンマウント時の cleanup でも dispose
      // されるが、端末によってはカメラが排他（iOS）で、会議側の getUserMedia が
      // 先に走ると「入室したら自分の映像だけ出ない」になる。確実に先に閉じる。
      disposePreviewSession()
      router.push(`/room/${roomCode}`)
    } catch {
      setJoinError({ message: t.joinEntry.networkError, kind: 'retryable' })
    } finally {
      setIsSubmitting(false)
    }
  }

  if (draft === 'checking' || draft === null) {
    return (
      <main className="relative flex min-h-dvh items-center justify-center px-6">
        <LocaleSwitcher className="absolute right-4 top-4" />
        <Spinner label={t.common.loading} />
      </main>
    )
  }

  return (
    // min-h-dvh：iOS Safari の 100vh（＝旧 min-h-screen）は「ツールバーを畳んだときの
    // 最大ビューポート」なので、ツールバーが出ている間はページ末尾が裏に隠れる。
    // pb-scroll-safe：そのツールバーは env(safe-area-inset-bottom) に算入されないため、
    // 最後のコントロール（スピーカー選択・参加ボタン）がツールバーより上までスクロール
    // できるだけの余白を明示的に積む（app/globals.css の同名ユーティリティ参照）。
    // items-center を使わず Card 側の my-auto で中央寄せするのは、内容がビューポートより
    // 高いときに flex の中央寄せが上方向のはみ出しをスクロール不能にする（＝カード上端に
    // 永久に届かない）ため——auto マージンならはみ出し時は 0 に解決されて素直に上詰めになる。
    <main className="relative flex min-h-dvh justify-center px-6 pt-10 pb-scroll-safe">
      <ToastProvider placement="top-center" />
      <LocaleSwitcher className="absolute right-4 top-4" />
      <Card className="my-auto w-full max-w-lg">
        <CardHeader className="flex-col items-start gap-1">
          <h1 className="text-xl font-semibold">{t.prejoin.title}</h1>
          <p className="font-mono text-xs text-neutral-400">{formatRoomCode(roomCode)}</p>
        </CardHeader>
        <CardBody className="gap-4">
          <DevicePreviewVideo
            videoRef={videoRef}
            isVideoVisible={camOn && isPreviewLive}
            isBusy={previewPhase !== null}
            busyLabel={previewPhase === 'applying' ? t.background.applying : t.common.loading}
            displayName={draft.displayName}
            cameraOffLabel={t.prejoin.cameraOffPlaceholder}
          />

          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-foreground">{t.background.sectionTitle}</span>
            <BackgroundPicker
              // 対応可否の権威的な判定は管線を持つ側（プレビューセッション / provider）にある。
              // ここで常に true を渡すのは、カメラ OFF の間はセッションが存在せず判定材料が
              // 無いから——その状態でも選択を保存できる（入室後に反映される）ようにしておく。
              // 非対応環境でプレビュー中に選ばれた場合は setEffect が明確に失敗し、
              // トースト＋選択の巻き戻しで伝わる（黙って無反応にはならない）。
              isSupported={true}
              value={backgroundSelection}
              onSelect={handleSelectBackground}
              text={t}
            />
          </div>

          {permissionFullyDenied && (
            <Alert
              color="warning"
              variant="flat"
              icon={<AlertTriangleIcon className="h-5 w-5" />}
              title={t.prejoin.permissionDeniedTitle}
              description={
                <div className="flex flex-col items-start gap-2">
                  <span>{t.prejoin.permissionDeniedBody}</span>
                  <Button size="sm" variant="flat" onPress={retryPermission}>
                    {t.prejoin.permissionRetry}
                  </Button>
                </div>
              }
            />
          )}

          <div className="flex flex-wrap items-center gap-6">
            <Switch isSelected={micOn} onValueChange={setMicOn} isDisabled={permission !== 'checking' && !permission.audio}>
              {t.prejoin.micLabel}
            </Switch>
            <Switch isSelected={camOn} onValueChange={setCamOn} isDisabled={permission !== 'checking' && !permission.video}>
              {t.prejoin.cameraLabel}
            </Switch>
          </div>

          {audioInputs.length > 1 && (
            <Select
              label={t.prejoin.micDeviceLabel}
              selectedKeys={selectedAudioId ? [selectedAudioId] : []}
              onSelectionChange={(keys) => {
                const id = Array.from(keys)[0]
                if (typeof id === 'string') setSelectedAudioId(id)
              }}
            >
              {audioInputs.map((d) => (
                <SelectItem key={d.deviceId}>{d.label}</SelectItem>
              ))}
            </Select>
          )}
          {videoInputs.length > 1 && (
            <Select
              label={t.prejoin.cameraDeviceLabel}
              selectedKeys={selectedVideoId ? [selectedVideoId] : []}
              onSelectionChange={(keys) => {
                const id = Array.from(keys)[0]
                if (typeof id === 'string') setSelectedVideoId(id)
              }}
            >
              {videoInputs.map((d) => (
                <SelectItem key={d.deviceId}>{d.label}</SelectItem>
              ))}
            </Select>
          )}
          {audioOutputs.length > 1 && (
            <Select
              label={t.prejoin.speakerDeviceLabel}
              selectedKeys={selectedAudioOutputId ? [selectedAudioOutputId] : []}
              onSelectionChange={(keys) => {
                const id = Array.from(keys)[0]
                if (typeof id === 'string') setSelectedAudioOutputId(id)
              }}
            >
              {audioOutputs.map((d) => (
                <SelectItem key={d.deviceId}>{d.label}</SelectItem>
              ))}
            </Select>
          )}

          <div className="flex flex-wrap gap-2">
            {permission !== 'checking' && permission.audio && camOn && (
              <Button size="sm" variant="flat" onPress={setAudioOnly}>
                {t.prejoin.audioOnlyAction}
              </Button>
            )}
            {(micOn || camOn) && (
              <Button size="sm" variant="flat" onPress={setListenOnly}>
                {t.prejoin.listenOnlyAction}
              </Button>
            )}
          </div>

          {joinError && (
            <Alert color="danger" variant="flat" description={joinError.message} />
          )}

          <div className="flex items-center justify-between gap-2 pt-2">
            <Button as={NextLink} href={`/j/${roomCode}`} variant="light" startContent={<ChevronLeftIcon className="h-4 w-4" />}>
              {t.prejoin.backToEntry}
            </Button>
            {joinError?.kind === 'login' ? (
              <Button as={NextLink} href={`/login?next=/j/${roomCode}`} color="primary">
                {t.joinEntry.loginCta}
              </Button>
            ) : joinError?.kind === 'terminal' ? null : (
              <Button color="primary" onPress={handleJoin} isLoading={isSubmitting}>
                {isSubmitting ? t.prejoin.joining : t.prejoin.join}
              </Button>
            )}
          </div>
        </CardBody>
      </Card>
    </main>
  )
}
