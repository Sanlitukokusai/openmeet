/**
 * 轻量 i18n 字典（WP-4 §7 起步、WP-8 扩展为全站手动切换）。
 *
 * 设计取舍：不引入 i18n 库（next-intl / react-i18next 等）——条目量虽已从 WP-4 的
 * 3 个会议流程页面扩展到全站（含 auth / dashboard / roomForm），但依然是「一个静态字典
 * + 一个 hook」的形状就能覆盖，换库的迁移成本远低于现在提前引入框架的复杂度。
 *
 * 语言判定优先级（WP-8 新增手动切换后）：
 *   localStorage('meet.locale') 的手动选择 > navigator.language 推断（'zh' 开头→中文，
 *   否则日文） > 'ja'。实际的优先级解析、持久化与 <html lang> 同步逻辑都在
 *   lib/store/locale-store.ts（zustand store）——本文件的 useLocale() 只是订阅那个
 *   store，函数签名保持不变，全站已有调用点（`const locale = useLocale()`）无需改动。
 *   SSR 与客户端首次渲染都固定给 'ja'（服务器不知道客户端的 localStorage / navigator），
 *   挂载后由 store 的 hydrate() 校正一次真实值——避免 hydration mismatch，与 WP-4 时期
 *   「先 ja、挂载后再修正」的既有取舍完全一致，只是补上了「手动选择优先」这一层。
 *
 * ⚠️ ja / zh 两个字典的 key 集合必须完全一致（tests/ui/ui-text-keys.test.ts 用递归
 * 展开做全量比对）。新增文案时两边一起加，不要只加一边。
 */
import { useEffect } from 'react'
import type { MediaErrorCode } from '@/lib/media/types'
// ⚠️ 型だけ（`import type`）。lib/server/rooms-logic.ts は先頭で zod を実行時 import して
// いるので、値として import するとクライアントバンドルに zod が紛れ込む。型はコンパイル時に
// 消えるので安全——app/dashboard/room-actions.ts と同じ扱い。
import type { RoomState } from '@/lib/server/rooms-logic'
import { useLocaleStore } from '@/lib/store/locale-store'

export type Locale = 'ja' | 'zh'

/** POST /api/rooms/{code}/join 的错误码（lib/server/api-response.ts ApiErrorCode 的子集）
 *  + UNKNOWN 兜底（网络异常 / 未识别错误码）。UI 侧只依赖这个字符串常量集合，
 *  不 import lib/server/**（WP-4 范围禁止）。 */
export type JoinErrorCode =
  | 'INVALID_PASSWORD'
  | 'LOGIN_REQUIRED'
  | 'ROOM_NOT_FOUND'
  | 'ROOM_FULL'
  | 'ROOM_EXPIRED'
  | 'ROOM_ENDED'
  | 'TOO_MANY_ATTEMPTS'
  /** 全局同時接続数の上限（サーバー全体が満杯。個別ルームの ROOM_FULL とは別物） */
  | 'SERVER_AT_CAPACITY'
  | 'VALIDATION_ERROR'
  | 'INTERNAL_ERROR'
  | 'UNKNOWN'

/** POST /api/rooms/{id}/participants/mute（および mute-all）のエラーコード。
 *  join 側と同じ方針で、UI は lib/server/** を import せず文字列定数集合だけに依存する。 */
export type MuteErrorCode =
  | 'PARTICIPANT_NOT_FOUND'
  | 'NO_AUDIO_TRACK'
  | 'REMOTE_UNMUTE_DISABLED'
  | 'ROOM_NOT_FOUND'
  | 'UNAUTHORIZED'
  | 'VALIDATION_ERROR'
  | 'INTERNAL_ERROR'
  | 'UNKNOWN'

export interface UiTextDict {
  common: {
    appName: string
    backHome: string
    retry: string
    loading: string
    copyLink: string
    linkCopied: string
    cancel: string
    confirm: string
    /** 通用通信エラー（WP-8：auth/dashboard/roomForm など、専用文言を持たない fetch 失败 catch 用）。 */
    networkError: string
  }
  home: {
    subtitle: string
    loginLink: string
    dashboardLink: string
    roomCodeLabel: string
    roomCodePlaceholder: string
    roomCodeSubmit: string
    roomCodeRequired: string
  }
  /** WP-8：/login, /signup（旧 WP-1 は日本語ハードコードだった箇所を辞書化）。 */
  auth: {
    loginTitle: string
    loginSubtitle: string
    signupTitle: string
    signupSubtitle: string
    emailLabel: string
    passwordLabel: string
    signupPasswordLabel: string
    loginSubmit: string
    signupSubmit: string
    loginErrorTitle: string
    signupErrorTitle: string
    loginFailedFallback: string
    signupFailedFallback: string
    /** AUTH_FAILED（Supabase の signInWithPassword 失败）専用文言。サーバーの message は
     *  Supabase SDK 由来の英語で言語非対応のため、既知コードとして固定文言に差し替える。 */
    loginAuthFailed: string
    /** AUTH_FAILED（signUp 失败。既に登録済みのメールアドレス等）専用文言。 */
    signupAuthFailed: string
    confirmEmailSentTitle: string
    confirmEmailSentBody: string
    noAccountPrompt: string
    signupLink: string
    haveAccountPrompt: string
    loginLink: string
  }
  /** WP-8：/dashboard 一覧 + EditRoomModal + ConfirmActionModal（削除/終了）+ RoomActionsCell。 */
  dashboard: {
    title: string
    createRoomButton: string
    logoutButton: string
    emptyRooms: string
    columnTitle: string
    columnRoomCode: string
    columnStatus: string
    columnSchedule: string
    columnJoinLink: string
    columnActions: string
    scheduleLabelPrefix: string
    expiresLabelPrefix: string
    /** 2026-08-07：`active` の 3 分岐（旧 statusActive「開催中/进行中」は誤解を招くので廃止）。
     *  statusInMeeting は {count} プレースホルダーを含む。 */
    statusInMeeting: string
    statusWaiting: string
    statusAvailable: string
    statusEnded: string
    statusExpired: string
    statusDisabled: string
    enterRoom: string
    loadRoomsFailed: string
    roomNotFoundRefreshed: string
    toastRoomUpdated: string
    toastRoomDeleted: string
    toastMeetingEnded: string
    deleteRoomFailed: string
    endMeetingFailed: string
    /** {title} プレースホルダーを含む。interpolate() で埋める。 */
    deleteConfirmTitle: string
    deleteConfirmBody: string
    deleteConfirmButton: string
    endConfirmTitle: string
    endConfirmBody: string
    endConfirmButton: string
    editModalTitle: string
    editLoadErrorTitle: string
    editLoadFailedFallback: string
    editSaveErrorTitle: string
    editSaveFailedFallback: string
    editExpiresLabel: string
    editExpiresAriaLabel: string
    editPasswordGroupLabel: string
    editPasswordUnchanged: string
    editPasswordSet: string
    editPasswordClear: string
    editPasswordClearHint: string
    editNewPasswordLabel: string
    editSaveButton: string
    /** RoomActionsCell の 3 アイコンボタン（Tooltip / aria-label 兼用）。 */
    actionEdit: string
    actionEnd: string
    actionDelete: string
    /** app/dashboard/room-actions.ts の DISABLED_REASON_BY_STATUS 相当（8 通り）。 */
    editDisabledDeleted: string
    deleteDisabledDeleted: string
    endDisabledDeleted: string
    endDisabledExpired: string
    endDisabledEnded: string
    enterDisabledDeleted: string
    enterDisabledExpired: string
    enterDisabledEnded: string
    /** app/dashboard/room-actions.ts の validateRoomEditForm。{min}/{max} は interpolate() で埋める。 */
    validationTitleRequired: string
    validationMaxParticipantsRange: string
    validationPasswordRange: string
  }
  /** WP-8：/rooms/new。titleLabel 等の一部フィールドラベルは EditRoomModal と文言が同一のため共用する。 */
  roomForm: {
    createTitle: string
    titleLabel: string
    passwordLabel: string
    passwordDescription: string
    maxParticipantsLabel: string
    requireLoginLabel: string
    scheduledAtLabel: string
    expiresAtLabel: string
    submitButton: string
    createErrorTitle: string
    createFailedFallback: string
    successTitle: string
    roomCodeLabel: string
    joinLinkLabel: string
    copyButton: string
    /** {password} プレースホルダーを含む。interpolate() で埋める。 */
    passwordOnceTitle: string
    passwordOnceBody: string
    goToDashboardButton: string
    createAnotherButton: string
  }
  joinEntry: {
    loadingMeta: string
    notFoundTitle: string
    notFoundBody: string
    endedTitle: string
    endedBody: string
    expiredTitle: string
    expiredBody: string
    fullNotice: string
    loginRequiredNotice: string
    loginCta: string
    displayNameLabel: string
    displayNamePlaceholder: string
    displayNameRequired: string
    passwordLabel: string
    passwordRequired: string
    submit: string
    leftNotice: string
    endedByHostNotice: string
    networkError: string
  }
  prejoin: {
    title: string
    permissionDeniedTitle: string
    permissionDeniedBody: string
    permissionRetry: string
    micLabel: string
    cameraLabel: string
    micDeviceLabel: string
    cameraDeviceLabel: string
    speakerDeviceLabel: string
    listenOnlyAction: string
    audioOnlyAction: string
    join: string
    joining: string
    cameraOffPlaceholder: string
    backToEntry: string
    missingDraftBody: string
  }
  room: {
    waitingForOthers: string
    inviteHint: string
    micOn: string
    micOff: string
    cameraOn: string
    cameraOff: string
    deviceSettings: string
    leave: string
    /** 2026-08-16 実機フィードバック：ワンタップ即断線が突然すぎるため追加した退出確認。
     *  endMeetingConfirm* と同じ命名（{action}ConfirmTitle/Body、確定ボタンは {action}Confirm）。 */
    leaveConfirmTitle: string
    leaveConfirmBody: string
    leaveConfirm: string
    endMeeting: string
    endMeetingConfirmTitle: string
    endMeetingConfirmBody: string
    endMeetingConfirm: string
    endMeetingError: string
    endedByHostTitle: string
    endedByHostBody: string
    backHome: string
    reconnecting: string
    disconnectedTitle: string
    disconnectedBody: string
    rejoin: string
    missingSessionTitle: string
    missingSessionBody: string
    goToEntry: string
    qualityExcellent: string
    qualityGood: string
    qualityPoor: string
    qualityLost: string
    speaking: string
    muted: string
    videoOff: string
    you: string
    noAudioOutputNote: string
    /** 2026-08-14：モバイル（<md）コントロールドックの「その他」メニュー（設備設定・全員ミュート・
     *  会議終了をまとめる開閉トリガー及びメニュー自体の aria-label）。 */
    moreOptions: string
    /** 2026-08-14：モバイルのビデオグリッドページング（5 人以上を 2×2 ずつ捌く）。 */
    previousPage: string
    nextPage: string
    /** {page}/{total} プレースホルダーを含む（ページドットの sr-only 読み上げ用）。 */
    pageIndicator: string
    /** 2026-08-14 第 2 波：満屏タイルをタップして表示の収め方を切り替える透明ボタンの aria-label。 */
    toggleVideoFit: string
    /** 切替チップ：contain（16:9 全体が見える・上下に黒帯）。 */
    fitContain: string
    /** 切替チップ：cover（画面いっぱい・左右が切れる）。 */
    fitCover: string
    /** 自己修復でカメラが戻ったとき。 */
    cameraRecovered: string
    /** 自己修復に失敗し、カメラがオフで確定したとき（次の操作を明示する）。 */
    cameraStopped: string
  }
  /** 2026-08-07 FR-4：会議内テキストチャット（保存しない・会議終了で消える）。 */
  chat: {
    title: string
    /** パネル上部の但し書き。「保存されない」ことを最初に明示する（後から驚かせない）。 */
    ephemeralNote: string
    open: string
    close: string
    inputPlaceholder: string
    /** 未接続/再接続中は送信できないことを入力欄自身で説明する。 */
    inputDisabledPlaceholder: string
    send: string
    empty: string
    jumpToLatest: string
    sendFailed: string
    /** {max} プレースホルダーを含む。 */
    tooLong: string
    /** {count} プレースホルダーを含む（未読バッジの読み上げ用）。 */
    unreadAria: string
  }
  /** 2026-08-07（第 2 波）：参加者一覧パネル。タイル右上のホバー式ミュートに気付けない
   *  という実利用者の指摘を受けて追加した、明示的な入口。 */
  participants: {
    title: string
    open: string
    close: string
    /** コントロールバーのボタン。{count} プレースホルダーを含む（バッジ数値の読み上げ用）。 */
    toggleAria: string
    /** パネル見出し脇の人数。{count} プレースホルダーを含む。 */
    countLabel: string
    /** 自分の行に付ける接尾辞。 */
    selfSuffix: string
    hostBadge: string
    micOnLabel: string
    micOffLabel: string
    cameraOnLabel: string
    cameraOffLabel: string
    /** 遠端参加者がまだ 1 人も居ないときの本文。 */
    empty: string
    listAria: string
    /** 2026-08-16 実機フィードバック：手機からリンク直入りだと未ログイン＝ guest になり
     *  主催者操作が見えない（身份モデルの自然な結果）。role!=='host' のときだけパネル上部に
     *  出す低調な案内（判定条件は requireLogin を見ない・role だけで決める）。 */
    guestNotice: string
    /** 自分の行に付ける小さなバッジ（既存の hostBadge と対になる。guest かつ自分の行のみ）。 */
    guestBadge: string
  }
  /** 2026-08-07：主催者による遠隔ミュート（個別 / 全員）。 */
  mute: {
    muteParticipant: string
    unmuteParticipant: string
    muteAll: string
    muteAllConfirmTitle: string
    muteAllConfirmBody: string
    muteAllConfirm: string
    /** {count} プレースホルダーを含む。 */
    muteAllSuccess: string
    /** {failed} プレースホルダーを含む。 */
    muteAllPartial: string
    muteAllFailed: string
    /** {name} プレースホルダーを含む。 */
    muteSuccess: string
    unmuteSuccess: string
    /** 自分が遠隔でミュート/解除されたときの通知。 */
    mutedByHost: string
    unmutedByHost: string
  }
  /** 2026-08-07：全局同時接続数の表示（GET /api/capacity）。 */
  capacity: {
    /** {current}/{max} プレースホルダーを含む。current は不明時 unknownCount に差し替える。 */
    onlineCount: string
    unknownCount: string
    ariaLabel: string
    createDisabledTooltip: string
  }
  /** 2026-08-13 FR-7：背景ぼかし / バーチャル背景（prejoin と会議内で共用する BackgroundPicker）。 */
  background: {
    /** ピッカーの見出し（会議内タブのラベルにも使う）。 */
    sectionTitle: string
    none: string
    /** 弱め（DEFAULT_BACKGROUND_BLUR_RADIUS=10 相当）。 */
    blurLight: string
    /** 強め（blurRadius=25。2026-08-14 実機フィードバック「弱すぎる」を受けて追加、既定の推奨値）。 */
    blurStrong: string
    builtinOffice: string
    builtinBookshelf: string
    builtinLiving: string
    builtinNature: string
    addImage: string
    deleteImage: string
    // 2026-08-16 削除：`takesEffectAfterJoinNote`（「背景効果は入室後に反映されます」）。
    // prejoin が本物の処理管線でその場プレビューするようになり、但し書きが事実と食い違った
    // （components/join/PrejoinView.tsx / lib/media/providers/livekit/preview.ts）。
    /** 実行環境が背景処理に非対応のときにピッカー全体へ添える説明文。 */
    unsupportedNote: string
    /** 初回有効化のダウンロード待ちを含む、適用中の共通キャプション。 */
    applying: string
    applyFailed: string
    uploadFailed: string
    /** {max} プレースホルダーを含む。 */
    limitReached: string
    /** 2026-08-14 第 2 波：処理管線が運行中に落ちて、効果を自動で解除したときの通知。 */
    disabledByError: string
  }
  joinErrors: Record<JoinErrorCode, string>
  mediaErrors: Record<MediaErrorCode, string>
  muteErrors: Record<MuteErrorCode, string>
}

const ja: UiTextDict = {
  common: {
    appName: 'オンライン会議',
    backHome: 'ホームに戻る',
    retry: '再試行',
    loading: '読み込み中...',
    copyLink: 'リンクをコピー',
    linkCopied: 'コピーしました',
    cancel: 'キャンセル',
    confirm: '確認',
    networkError: '通信エラーが発生しました。しばらくしてから再度お試しください。',
  },
  home: {
    subtitle:
      'ブラウザだけで参加できるオンライン会議システムです。ログイン後に会議室を作成し、発行されたリンクを受け取った人はクリックするだけで入室できます。',
    loginLink: 'ログイン',
    dashboardLink: 'ダッシュボード',
    roomCodeLabel: 'ルームコードで参加',
    roomCodePlaceholder: '例）abfk-92mp-tq',
    roomCodeSubmit: '参加する',
    roomCodeRequired: 'ルームコードを入力してください',
  },
  auth: {
    loginTitle: 'ログイン',
    loginSubtitle: 'オンライン会議システムにログインします。',
    signupTitle: '新規登録',
    signupSubtitle: 'アカウントを作成して会議室を管理します。',
    emailLabel: 'メールアドレス',
    passwordLabel: 'パスワード',
    signupPasswordLabel: 'パスワード（6文字以上）',
    loginSubmit: 'ログイン',
    signupSubmit: '登録する',
    loginErrorTitle: 'ログインできません',
    signupErrorTitle: '登録できません',
    loginFailedFallback: 'ログインに失敗しました',
    signupFailedFallback: '登録に失敗しました',
    loginAuthFailed: 'メールアドレスまたはパスワードが正しくありません。',
    signupAuthFailed: '登録できませんでした。入力内容をご確認のうえ、もう一度お試しください。',
    confirmEmailSentTitle: '確認メールを送信しました',
    confirmEmailSentBody: 'メール内のリンクをクリックしてからログインしてください。',
    noAccountPrompt: 'アカウントをお持ちでない場合は',
    signupLink: '新規登録',
    haveAccountPrompt: 'すでにアカウントをお持ちの場合は',
    loginLink: 'ログイン',
  },
  dashboard: {
    title: '会議室一覧',
    createRoomButton: '新しい会議室を作成',
    logoutButton: 'ログアウト',
    emptyRooms: 'まだ会議室がありません。',
    columnTitle: 'タイトル',
    columnRoomCode: 'ルームコード',
    columnStatus: '状態',
    columnSchedule: '予定 / 期限',
    columnJoinLink: '入室リンク',
    columnActions: '操作',
    scheduleLabelPrefix: '予定: ',
    expiresLabelPrefix: '期限: ',
    statusInMeeting: '会議中 {count} 人',
    statusWaiting: '待機中',
    statusAvailable: '利用可能',
    statusEnded: '終了済み',
    statusExpired: '期限切れ',
    statusDisabled: '削除済み',
    enterRoom: '入室する',
    loadRoomsFailed: '会議室一覧の取得に失敗しました',
    roomNotFoundRefreshed: '会議室が見つかりません。一覧を更新しました。',
    toastRoomUpdated: '会議室を更新しました',
    toastRoomDeleted: '会議室を削除しました',
    toastMeetingEnded: '会議を終了しました',
    deleteRoomFailed: '会議室の削除に失敗しました',
    endMeetingFailed: '会議の終了に失敗しました',
    deleteConfirmTitle: '会議室を削除しますか？',
    deleteConfirmBody:
      '「{title}」を削除します。ソフト削除のため入室リンクは即座に無効になりますが、履歴データは保持されます。この操作は一覧からは元に戻せません。',
    deleteConfirmButton: '削除する',
    endConfirmTitle: '進行中の会議を終了しますか？',
    endConfirmBody: '「{title}」で進行中の会議を終了し、参加者全員を切断します。会議室自体は削除されず、そのまま次回も利用できます。',
    endConfirmButton: '終了する',
    editModalTitle: '会議室を編集',
    editLoadErrorTitle: '読み込めません',
    editLoadFailedFallback: '会議室情報の取得に失敗しました',
    editSaveErrorTitle: '保存できません',
    editSaveFailedFallback: '会議室の更新に失敗しました',
    editExpiresLabel: '有効期限（空欄で無期限）',
    editExpiresAriaLabel: '有効期限',
    editPasswordGroupLabel: 'パスワード',
    editPasswordUnchanged: '変更しない',
    editPasswordSet: '新しいパスワードを設定',
    editPasswordClear: 'パスワードを削除',
    editPasswordClearHint: '現在パスワードは設定されていません',
    editNewPasswordLabel: '新しいパスワード（6〜8文字）',
    editSaveButton: '保存する',
    actionEdit: '編集',
    actionEnd: '会議を終了',
    actionDelete: '削除',
    editDisabledDeleted: 'この会議室はすでに削除済みのため編集できません。',
    deleteDisabledDeleted: 'この会議室はすでに削除済みです。',
    endDisabledDeleted: 'この会議室はすでに削除済みです。',
    endDisabledExpired: '期限切れのため、進行中の会議がありません。',
    endDisabledEnded: '現在進行中の会議がありません。',
    enterDisabledDeleted: 'この会議室は削除済みのため入室できません。',
    enterDisabledExpired: '有効期限が切れています。期限を編集すると再び入室できます。',
    enterDisabledEnded: 'この会議は終了しています。',
    validationTitleRequired: 'タイトルは必須です',
    validationMaxParticipantsRange: '参加人数は{min}〜{max}人の範囲で指定してください',
    validationPasswordRange: 'パスワードは{min}〜{max}桁で入力してください',
  },
  roomForm: {
    createTitle: '会議室を作成',
    titleLabel: 'タイトル',
    passwordLabel: 'パスワード（任意・6〜8文字）',
    passwordDescription: '未入力の場合はパスワードなしで作成されます',
    maxParticipantsLabel: '最大参加人数',
    requireLoginLabel: 'ログイン済みの参加者のみ許可する',
    scheduledAtLabel: '開催予定日時（任意）',
    expiresAtLabel: '有効期限（任意）',
    submitButton: '作成する',
    createErrorTitle: '作成できません',
    createFailedFallback: '会議室の作成に失敗しました',
    successTitle: '会議室を作成しました',
    roomCodeLabel: 'ルームコード',
    joinLinkLabel: '入室リンク',
    copyButton: 'コピー',
    passwordOnceTitle: 'このパスワードは今だけ表示されます',
    passwordOnceBody: '二度と表示されません。今すぐ控えてください：{password}',
    goToDashboardButton: 'ダッシュボードへ',
    createAnotherButton: 'もう一つ作成する',
  },
  joinEntry: {
    loadingMeta: '会議情報を確認しています...',
    notFoundTitle: 'ルームが見つかりません',
    notFoundBody: 'リンクまたはルームコードをご確認ください。',
    endedTitle: 'この会議は終了しました',
    endedBody: '主催者がこの会議を終了しました。',
    expiredTitle: '有効期限が切れています',
    expiredBody: 'このルームの有効期限が終了しました。主催者にお問い合わせください。',
    fullNotice: 'この会議は満員に近い可能性があります。参加できない場合があります。',
    loginRequiredNotice: 'この会議への参加にはログインが必要な場合があります。',
    loginCta: 'ログインする',
    displayNameLabel: '表示名',
    displayNamePlaceholder: '会議で表示される名前',
    displayNameRequired: '表示名を入力してください',
    passwordLabel: 'パスワード',
    passwordRequired: 'パスワードを入力してください',
    submit: '次へ（デバイス確認）',
    leftNotice: '会議から退出しました。',
    endedByHostNotice: '主催者が会議を終了しました。',
    networkError: '通信エラーが発生しました。しばらくしてから再度お試しください。',
  },
  prejoin: {
    title: '参加前の確認',
    permissionDeniedTitle: 'カメラ・マイクを利用できません',
    permissionDeniedBody:
      'アドレスバーのカメラ / マイクアイコンから許可するか、ブラウザ設定でこのサイトへのアクセスを許可してください。許可しなくても視聴のみで参加できます。',
    permissionRetry: '権限を再確認する',
    micLabel: 'マイク',
    cameraLabel: 'カメラ',
    micDeviceLabel: 'マイクを選択',
    cameraDeviceLabel: 'カメラを選択',
    speakerDeviceLabel: 'スピーカーを選択',
    listenOnlyAction: '音声・映像なしで参加（視聴のみ）',
    audioOnlyAction: 'マイクのみで参加',
    join: '参加する',
    joining: '接続しています...',
    cameraOffPlaceholder: 'カメラはオフです',
    backToEntry: '前の画面に戻る',
    missingDraftBody: '参加情報が見つかりません。最初からやり直してください。',
  },
  room: {
    waitingForOthers: '他の参加者を待っています...',
    inviteHint: 'リンクを共有して他の人を招待できます。',
    micOn: 'マイクをオフにする',
    micOff: 'マイクをオンにする',
    cameraOn: 'カメラをオフにする',
    cameraOff: 'カメラをオンにする',
    deviceSettings: 'デバイス設定',
    leave: '退出',
    leaveConfirmTitle: '会議室から退出しますか？',
    leaveConfirmBody: '退出すると通話から切断されます。もう一度参加するには、参加リンクから入り直してください。',
    leaveConfirm: '退出する',
    endMeeting: '会議を終了',
    endMeetingConfirmTitle: '会議を終了しますか？',
    endMeetingConfirmBody: '会議を終了すると、参加者全員が退出されます。この操作は取り消せません。',
    endMeetingConfirm: '終了する',
    endMeetingError: '会議の終了に失敗しました。もう一度お試しください。',
    endedByHostTitle: '会議は終了しました',
    endedByHostBody: 'この会議を終了しました。ご参加ありがとうございました。',
    backHome: 'ホームに戻る',
    reconnecting: '再接続しています...',
    disconnectedTitle: '接続が切断されました',
    disconnectedBody: 'ネットワークの問題、または主催者の操作により接続が切断されました。',
    rejoin: 'もう一度参加する',
    missingSessionTitle: '参加情報が見つかりません',
    missingSessionBody: '参加手続きを最初からやり直してください。',
    goToEntry: '参加画面へ',
    qualityExcellent: '接続良好',
    qualityGood: '接続普通',
    qualityPoor: '接続不安定',
    qualityLost: '接続なし',
    speaking: '発言中',
    muted: 'ミュート中',
    videoOff: 'カメラオフ',
    you: '自分',
    noAudioOutputNote: 'このブラウザではスピーカー選択が利用できない場合があります。',
    moreOptions: 'その他の操作',
    previousPage: '前のページ',
    nextPage: '次のページ',
    pageIndicator: '{page} / {total} ページ',
    toggleVideoFit: '映像の表示方法を切り替える',
    fitContain: 'フル表示',
    fitCover: '画面いっぱい',
    cameraRecovered: 'カメラを復旧しました。',
    cameraStopped: 'カメラが停止しました。カメラボタンから再開してください。',
  },
  background: {
    sectionTitle: '背景',
    none: 'なし',
    blurLight: 'ぼかし（弱）',
    blurStrong: 'ぼかし（強）',
    builtinOffice: 'オフィス',
    builtinBookshelf: '本棚',
    builtinLiving: 'リビング',
    builtinNature: '自然',
    addImage: '画像を追加',
    deleteImage: 'この画像を削除',
    unsupportedNote: 'このブラウザは背景効果に対応していません。',
    applying: '適用しています...',
    applyFailed: '背景効果を適用できませんでした。',
    uploadFailed: '画像を追加できませんでした。別の画像でお試しください。',
    limitReached: '画像は最大{max}枚までです。不要な画像を削除してから追加してください。',
    disabledByError: '背景効果の処理が停止したため、背景をオフにしました。',
  },
  chat: {
    title: 'チャット',
    ephemeralNote: 'メッセージは保存されません。会議が終了すると消えます。',
    open: 'チャットを開く',
    close: 'チャットを閉じる',
    inputPlaceholder: 'メッセージを入力（Enter で送信）',
    inputDisabledPlaceholder: '接続中はメッセージを送信できません',
    send: '送信',
    empty: 'まだメッセージはありません。',
    jumpToLatest: '新しいメッセージ',
    sendFailed: 'メッセージを送信できませんでした。接続状態をご確認ください。',
    tooLong: 'メッセージは{max}文字以内で入力してください。',
    unreadAria: '未読 {count} 件',
  },
  participants: {
    title: '参加者',
    open: '参加者一覧を開く',
    close: '参加者一覧を閉じる',
    toggleAria: '参加者一覧（{count} 人）',
    countLabel: '{count} 人',
    selfSuffix: '（自分）',
    hostBadge: '主催者',
    micOnLabel: 'マイクオン',
    micOffLabel: 'マイクオフ',
    cameraOnLabel: 'カメラオン',
    cameraOffLabel: 'カメラオフ',
    empty: 'まだ他の参加者はいません。',
    listAria: '参加者一覧',
    guestNotice: 'ゲストとして参加中。ホスト機能はコンソールからログインして入室すると利用できます。',
    guestBadge: 'ゲスト',
  },
  mute: {
    muteParticipant: 'この参加者をミュート',
    unmuteParticipant: 'この参加者のミュートを解除',
    muteAll: '全員をミュート',
    muteAllConfirmTitle: '全員をミュートしますか？',
    muteAllConfirmBody:
      '自分以外の参加者全員のマイクをオフにします。参加者は自分でマイクを再びオンにできます。',
    muteAllConfirm: 'ミュートする',
    muteAllSuccess: '{count} 人をミュートしました。',
    muteAllPartial: 'うち {failed} 人はミュートできませんでした。',
    muteAllFailed: '一括ミュートに失敗しました。',
    muteSuccess: '{name} をミュートしました。',
    unmuteSuccess: '{name} のミュートを解除しました。',
    mutedByHost: '主催者によってマイクがミュートされました。',
    unmutedByHost: '主催者がマイクのミュートを解除しました。',
  },
  capacity: {
    onlineCount: 'オンライン {current} / {max}',
    unknownCount: '—',
    ariaLabel: 'サーバー全体のオンライン人数',
    createDisabledTooltip:
      'ただいまアクセスが集中しているため、新しい会議室を作成できません。しばらくしてからお試しください。',
  },
  joinErrors: {
    INVALID_PASSWORD: 'パスワードが正しくありません。',
    LOGIN_REQUIRED: 'この会議に参加するにはログインが必要です。',
    ROOM_NOT_FOUND: 'ルームが見つかりません。',
    ROOM_FULL: 'この会議は満員です。',
    ROOM_EXPIRED: 'このルームは有効期限が切れています。',
    ROOM_ENDED: 'この会議はすでに終了しています。',
    TOO_MANY_ATTEMPTS: '試行回数が上限に達しました。しばらくしてからお試しください。',
    SERVER_AT_CAPACITY: 'ただいまアクセスが集中しています。しばらくしてからお試しください。',
    VALIDATION_ERROR: '入力内容をご確認ください。',
    INTERNAL_ERROR: 'サーバーエラーが発生しました。しばらくしてから再度お試しください。',
    UNKNOWN: '予期しないエラーが発生しました。',
  },
  mediaErrors: {
    PERMISSION_DENIED: 'カメラ・マイクへのアクセスが許可されていません。',
    DEVICE_NOT_FOUND: 'カメラまたはマイクが見つかりません。',
    CONNECT_FAILED: '会議サーバーに接続できませんでした。',
    TOKEN_INVALID: '参加情報が無効です。もう一度参加し直してください。',
    ROOM_FULL: 'この会議は満員です。',
    DISCONNECTED_BY_SERVER: 'サーバーによって接続が切断されました。',
    UNKNOWN: '予期しないエラーが発生しました。',
  },
  muteErrors: {
    PARTICIPANT_NOT_FOUND: 'この参加者はすでに会議にいません。',
    NO_AUDIO_TRACK: 'この参加者はマイクを使用していません（視聴のみ）。',
    REMOTE_UNMUTE_DISABLED: 'サーバー設定により、遠隔でミュートを解除できません。',
    ROOM_NOT_FOUND: '会議室が見つかりません。',
    UNAUTHORIZED: 'この操作を行う権限がありません。',
    VALIDATION_ERROR: '操作内容が正しくありません。',
    INTERNAL_ERROR: 'ミュート操作に失敗しました。しばらくしてからお試しください。',
    UNKNOWN: 'ミュート操作に失敗しました。',
  },
}

const zh: UiTextDict = {
  common: {
    appName: '在线会议',
    backHome: '返回首页',
    retry: '重试',
    loading: '加载中...',
    copyLink: '复制链接',
    linkCopied: '已复制',
    cancel: '取消',
    confirm: '确认',
    networkError: '发生通信错误，请稍后重试。',
  },
  home: {
    subtitle: '这是一个只需浏览器即可参加的在线会议系统。登录后即可创建会议室，收到链接的人只需点击即可入会。',
    loginLink: '登录',
    dashboardLink: '控制台',
    roomCodeLabel: '输入房间码加入',
    roomCodePlaceholder: '例如：abfk-92mp-tq',
    roomCodeSubmit: '加入会议',
    roomCodeRequired: '请输入房间码',
  },
  auth: {
    loginTitle: '登录',
    loginSubtitle: '登录在线会议系统。',
    signupTitle: '注册账号',
    signupSubtitle: '创建账号来管理你的会议室。',
    emailLabel: '邮箱地址',
    passwordLabel: '密码',
    signupPasswordLabel: '密码（至少 6 位）',
    loginSubmit: '登录',
    signupSubmit: '注册',
    loginErrorTitle: '无法登录',
    signupErrorTitle: '无法注册',
    loginFailedFallback: '登录失败',
    signupFailedFallback: '注册失败',
    loginAuthFailed: '邮箱或密码不正确，请重新输入。',
    signupAuthFailed: '注册未成功，请检查填写内容后重试。',
    confirmEmailSentTitle: '确认邮件已发送',
    confirmEmailSentBody: '请点击邮件中的链接完成确认后再登录。',
    noAccountPrompt: '还没有账号？',
    signupLink: '去注册',
    haveAccountPrompt: '已经有账号？',
    loginLink: '去登录',
  },
  dashboard: {
    title: '会议室列表',
    createRoomButton: '新建会议室',
    logoutButton: '退出登录',
    emptyRooms: '暂时还没有会议室。',
    columnTitle: '标题',
    columnRoomCode: '房间码',
    columnStatus: '状态',
    columnSchedule: '预定 / 期限',
    columnJoinLink: '入会链接',
    columnActions: '操作',
    scheduleLabelPrefix: '预定：',
    expiresLabelPrefix: '期限：',
    statusInMeeting: '会议中 {count} 人',
    statusWaiting: '待机中',
    statusAvailable: '可用',
    statusEnded: '已结束',
    statusExpired: '已过期',
    statusDisabled: '已删除',
    enterRoom: '进入会议',
    loadRoomsFailed: '获取会议室列表失败',
    roomNotFoundRefreshed: '未找到该会议室，列表已刷新。',
    toastRoomUpdated: '会议室已更新',
    toastRoomDeleted: '会议室已删除',
    toastMeetingEnded: '会议已结束',
    deleteRoomFailed: '删除会议室失败',
    endMeetingFailed: '结束会议失败',
    deleteConfirmTitle: '确定要删除这个会议室吗？',
    deleteConfirmBody: '将删除"{title}"。这是软删除，入会链接会立即失效，但历史数据仍会保留。此操作在列表中无法撤销。',
    deleteConfirmButton: '删除',
    endConfirmTitle: '确定要结束正在进行的会议吗？',
    endConfirmBody: '将结束"{title}"中正在进行的会议，所有参会者都会被断开连接。会议室本身不会被删除，下次仍可继续使用。',
    endConfirmButton: '结束会议',
    editModalTitle: '编辑会议室',
    editLoadErrorTitle: '无法加载',
    editLoadFailedFallback: '获取会议室信息失败',
    editSaveErrorTitle: '无法保存',
    editSaveFailedFallback: '更新会议室失败',
    editExpiresLabel: '有效期限（留空表示不限期）',
    editExpiresAriaLabel: '有效期限',
    editPasswordGroupLabel: '密码',
    editPasswordUnchanged: '不修改',
    editPasswordSet: '设置新密码',
    editPasswordClear: '删除密码',
    editPasswordClearHint: '当前尚未设置密码',
    editNewPasswordLabel: '新密码（6〜8 位）',
    editSaveButton: '保存',
    actionEdit: '编辑',
    actionEnd: '结束会议',
    actionDelete: '删除',
    editDisabledDeleted: '该会议室已被删除，无法编辑。',
    deleteDisabledDeleted: '该会议室已经被删除。',
    endDisabledDeleted: '该会议室已经被删除。',
    endDisabledExpired: '房间已过期，没有正在进行的会议。',
    endDisabledEnded: '当前没有正在进行的会议。',
    enterDisabledDeleted: '该会议室已被删除，无法进入。',
    enterDisabledExpired: '已超过有效期限，修改期限后即可重新进入。',
    enterDisabledEnded: '该会议已结束。',
    validationTitleRequired: '标题为必填项',
    validationMaxParticipantsRange: '参加人数需在 {min}〜{max} 人之间',
    validationPasswordRange: '密码长度需为 {min}〜{max} 位',
  },
  roomForm: {
    createTitle: '创建会议室',
    titleLabel: '标题',
    passwordLabel: '密码（选填，6〜8 位）',
    passwordDescription: '不填写则创建无密码的会议室',
    maxParticipantsLabel: '最大参会人数',
    requireLoginLabel: '仅允许已登录用户加入',
    scheduledAtLabel: '预定开始时间（选填）',
    expiresAtLabel: '有效期限（选填）',
    submitButton: '创建',
    createErrorTitle: '无法创建',
    createFailedFallback: '创建会议室失败',
    successTitle: '会议室创建成功',
    roomCodeLabel: '房间码',
    joinLinkLabel: '入会链接',
    copyButton: '复制',
    passwordOnceTitle: '此密码仅显示这一次',
    passwordOnceBody: '之后将不再显示，请立即记下：{password}',
    goToDashboardButton: '前往控制台',
    createAnotherButton: '再创建一个',
  },
  joinEntry: {
    loadingMeta: '正在确认会议信息...',
    notFoundTitle: '未找到该会议室',
    notFoundBody: '请确认链接或房间码是否正确。',
    endedTitle: '该会议已结束',
    endedBody: '主持人已结束此会议。',
    expiredTitle: '该会议已过期',
    expiredBody: '该房间的有效期已结束，请联系主持人。',
    fullNotice: '该会议可能已接近满员，可能无法加入。',
    loginRequiredNotice: '此会议可能需要登录才能参加。',
    loginCta: '去登录',
    displayNameLabel: '显示名称',
    displayNamePlaceholder: '将在会议中显示的名称',
    displayNameRequired: '请输入显示名称',
    passwordLabel: '密码',
    passwordRequired: '请输入密码',
    submit: '下一步（设备检查）',
    leftNotice: '已退出会议。',
    endedByHostNotice: '主持人已结束会议。',
    networkError: '发生通信错误，请稍后重试。',
  },
  prejoin: {
    title: '加入前设置',
    permissionDeniedTitle: '无法使用摄像头或麦克风',
    permissionDeniedBody:
      '请点击地址栏的摄像头/麦克风图标允许访问，或在浏览器设置中允许此网站。不允许也可以仅收听方式加入。',
    permissionRetry: '重新检查权限',
    micLabel: '麦克风',
    cameraLabel: '摄像头',
    micDeviceLabel: '选择麦克风',
    cameraDeviceLabel: '选择摄像头',
    speakerDeviceLabel: '选择扬声器',
    listenOnlyAction: '不开启音视频加入（仅收听）',
    audioOnlyAction: '仅开启麦克风加入',
    join: '加入会议',
    joining: '正在连接...',
    cameraOffPlaceholder: '摄像头已关闭',
    backToEntry: '返回上一步',
    missingDraftBody: '未找到加入信息，请重新开始。',
  },
  room: {
    waitingForOthers: '正在等待其他参会者...',
    inviteHint: '分享链接即可邀请他人加入。',
    micOn: '关闭麦克风',
    micOff: '开启麦克风',
    cameraOn: '关闭摄像头',
    cameraOff: '开启摄像头',
    deviceSettings: '设备设置',
    leave: '离开会议',
    leaveConfirmTitle: '确定要退出会议室吗？',
    leaveConfirmBody: '退出后将断开当前通话连接。如需重新加入，请通过入会链接重新进入。',
    leaveConfirm: '退出会议',
    endMeeting: '结束会议',
    endMeetingConfirmTitle: '确定要结束会议吗？',
    endMeetingConfirmBody: '结束会议后，所有参会者都会被断开连接，此操作无法撤销。',
    endMeetingConfirm: '结束会议',
    endMeetingError: '结束会议失败，请重试。',
    endedByHostTitle: '会议已结束',
    endedByHostBody: '您已结束此会议，感谢参与。',
    backHome: '返回首页',
    reconnecting: '正在重新连接...',
    disconnectedTitle: '连接已断开',
    disconnectedBody: '由于网络问题或主持人操作，连接已断开。',
    rejoin: '重新加入',
    missingSessionTitle: '未找到加入信息',
    missingSessionBody: '请重新完成加入流程。',
    goToEntry: '前往加入页面',
    qualityExcellent: '网络良好',
    qualityGood: '网络正常',
    qualityPoor: '网络不稳定',
    qualityLost: '网络已断开',
    speaking: '正在发言',
    muted: '已静音',
    videoOff: '摄像头已关闭',
    you: '我',
    noAudioOutputNote: '此浏览器可能不支持选择扬声器。',
    moreOptions: '更多操作',
    previousPage: '上一页',
    nextPage: '下一页',
    pageIndicator: '第 {page}/{total} 页',
    toggleVideoFit: '切换画面显示方式',
    fitContain: '完整显示',
    fitCover: '铺满画面',
    cameraRecovered: '摄像头已恢复。',
    cameraStopped: '摄像头已停止，请点击摄像头按钮重新开启。',
  },
  background: {
    sectionTitle: '背景',
    none: '无',
    blurLight: '轻度虚化',
    blurStrong: '背景虚化',
    builtinOffice: '办公室',
    builtinBookshelf: '书架',
    builtinLiving: '客厅',
    builtinNature: '自然',
    addImage: '添加图片',
    deleteImage: '删除该图片',
    unsupportedNote: '此浏览器不支持背景效果。',
    applying: '正在应用...',
    applyFailed: '背景效果应用失败。',
    uploadFailed: '图片添加失败，请换一张试试。',
    limitReached: '最多可保存 {max} 张图片，请先删除不需要的图片。',
    disabledByError: '背景处理已中断，已自动关闭背景效果。',
  },
  chat: {
    title: '聊天',
    ephemeralNote: '消息不会保存，会议结束即消失。',
    open: '打开聊天',
    close: '关闭聊天',
    inputPlaceholder: '输入消息（按 Enter 发送）',
    inputDisabledPlaceholder: '连接期间无法发送消息',
    send: '发送',
    empty: '还没有消息。',
    jumpToLatest: '新消息',
    sendFailed: '消息发送失败，请检查网络连接。',
    tooLong: '消息长度不能超过 {max} 个字符。',
    unreadAria: '{count} 条未读消息',
  },
  participants: {
    title: '参会者',
    open: '打开参会者列表',
    close: '关闭参会者列表',
    toggleAria: '参会者列表（{count} 人）',
    countLabel: '{count} 人',
    selfSuffix: '（我）',
    hostBadge: '主持人',
    micOnLabel: '麦克风已开启',
    micOffLabel: '麦克风已关闭',
    cameraOnLabel: '摄像头已开启',
    cameraOffLabel: '摄像头已关闭',
    empty: '还没有其他参会者。',
    listAria: '参会者列表',
    guestNotice: '以访客身份参会。主持人功能需从控制台登录后进入。',
    guestBadge: '访客',
  },
  mute: {
    muteParticipant: '将该参会者静音',
    unmuteParticipant: '取消该参会者的静音',
    muteAll: '全体静音',
    muteAllConfirmTitle: '确定要将全体静音吗？',
    muteAllConfirmBody: '将关闭除您以外所有参会者的麦克风。参会者之后仍可自行重新开启麦克风。',
    muteAllConfirm: '全体静音',
    muteAllSuccess: '已将 {count} 人静音。',
    muteAllPartial: '其中 {failed} 人未能静音。',
    muteAllFailed: '全体静音失败。',
    muteSuccess: '已将 {name} 静音。',
    unmuteSuccess: '已取消 {name} 的静音。',
    mutedByHost: '主持人已将您静音。',
    unmutedByHost: '主持人已取消您的静音。',
  },
  capacity: {
    onlineCount: '在线 {current} / {max}',
    unknownCount: '—',
    ariaLabel: '服务器在线人数',
    createDisabledTooltip: '当前使用人数已满，暂时无法新建会议室，请稍后再试。',
  },
  joinErrors: {
    INVALID_PASSWORD: '密码不正确。',
    LOGIN_REQUIRED: '参加此会议需要登录。',
    ROOM_NOT_FOUND: '未找到该会议室。',
    ROOM_FULL: '该会议人数已满。',
    ROOM_EXPIRED: '该房间已过期。',
    ROOM_ENDED: '该会议已结束。',
    TOO_MANY_ATTEMPTS: '尝试次数过多，请稍后再试。',
    SERVER_AT_CAPACITY: '当前使用人数已满，请稍后再试。',
    VALIDATION_ERROR: '请检查输入内容。',
    INTERNAL_ERROR: '服务器发生错误，请稍后重试。',
    UNKNOWN: '发生未知错误。',
  },
  mediaErrors: {
    PERMISSION_DENIED: '未获得摄像头或麦克风的访问权限。',
    DEVICE_NOT_FOUND: '未找到摄像头或麦克风。',
    CONNECT_FAILED: '无法连接到会议服务器。',
    TOKEN_INVALID: '加入信息已失效，请重新加入。',
    ROOM_FULL: '该会议人数已满。',
    DISCONNECTED_BY_SERVER: '服务器已断开此连接。',
    UNKNOWN: '发生未知错误。',
  },
  muteErrors: {
    PARTICIPANT_NOT_FOUND: '该参会者已不在会议中。',
    NO_AUDIO_TRACK: '该参会者没有使用麦克风（仅收听）。',
    REMOTE_UNMUTE_DISABLED: '服务器设置不允许远程取消静音。',
    ROOM_NOT_FOUND: '未找到该会议室。',
    UNAUTHORIZED: '您没有执行此操作的权限。',
    VALIDATION_ERROR: '操作内容不正确。',
    INTERNAL_ERROR: '静音操作失败，请稍后重试。',
    UNKNOWN: '静音操作失败。',
  },
}

export const uiText: Record<Locale, UiTextDict> = { ja, zh }

/** navigator.language が 'zh' 始まりなら中国語、それ以外は日本語（既定）。
 *  ⚠️ WP-8 以降、useLocale() はこの関数を直接使わず lib/store/locale-store.ts の
 *  detectBrowserLocale()（同じロジックの独立コピー）を経由する。本関数自体は後方互換と
 *  既存テスト（tests/ui/ui-text-keys.test.ts）のために残す。 */
export function detectLocale(): Locale {
  if (typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('zh')) {
    return 'zh'
  }
  return 'ja'
}

/**
 * クライアント側でロケールを解決する hook。実体は lib/store/locale-store.ts の
 * zustand store（手動選択 > ブラウザ言語 > 'ja'）を購読するだけ——関数シグネチャは
 * WP-4 当初から変えていないので、全站已有調用点（`const locale = useLocale()`）は
 * 無改动のまま新しい優先順位ロジックの恩恵を受ける。
 * SSR/初回レンダーは常に 'ja'（サーバーは localStorage も navigator も知らない）。
 * マウント後に一度 store.hydrate() を呼び、実際の値へ補正する（hydration mismatch 回避）。
 */
export function useLocale(): Locale {
  const locale = useLocaleStore((s) => s.locale)
  const hydrate = useLocaleStore((s) => s.hydrate)
  useEffect(() => {
    hydrate()
  }, [hydrate])
  return locale
}

/** `{key}` トークンを埋め込んだ文言テンプレートの簡易置換ヘルパー。
 *  i18n ライブラリを増やさず（依存追加禁止）、変数を含む文言はこれで埋める。
 *  例：interpolate(t.dashboard.deleteConfirmBody, { title: room.title }) */
export function interpolate(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (matched, key: string) =>
    Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : matched,
  )
}

/** POST /join のエラーコード → 文案。未知コードは UNKNOWN にフォールバック。 */
export function joinErrorMessage(code: string, locale: Locale): string {
  const dict = uiText[locale].joinErrors
  if (Object.prototype.hasOwnProperty.call(dict, code)) {
    return dict[code as JoinErrorCode]
  }
  return dict.UNKNOWN
}

/** MediaProvider の `error` イベント（MediaErrorCode）→ 文案。会議室内の一時トースト用。 */
export function mediaErrorMessage(code: string, locale: Locale): string {
  const dict = uiText[locale].mediaErrors
  if (Object.prototype.hasOwnProperty.call(dict, code)) {
    return dict[code as MediaErrorCode]
  }
  return dict.UNKNOWN
}

/** POST /participants/mute・mute-all のエラーコード → 文案。未知コードは UNKNOWN。
 *  サーバー側 message（日本語固定）は使わない——joinErrorMessage と同じ判断。 */
export function muteErrorMessage(code: string | null | undefined, locale: Locale): string {
  const dict = uiText[locale].muteErrors
  if (code && Object.prototype.hasOwnProperty.call(dict, code)) {
    return dict[code as MuteErrorCode]
  }
  return dict.UNKNOWN
}

/** GET /api/capacity の表示に必要な最小フィールド（app/api/capacity/route.ts の部分集合）。 */
export interface CapacityDisplayInput {
  /** null = 統計源が取れなかった（人数不明） */
  current: number | null
  max: number
  canCreate: boolean
}

export interface CapacityDisplay {
  /** Chip に出す文言（例「オンライン 3 / 20」／人数不明なら「オンライン — / 20」） */
  label: string
  /** Chip の色。満杯（作成不可）だけ警告色にする */
  tone: 'default' | 'warning'
  /** 作成ボタンを無効化する理由。null なら無効化しない */
  createDisabledReason: string | null
}

/**
 * 容量スナップショット → 表示（純関数。tests/ui/capacity-display.test.ts）。
 *
 * `current === null` は「統計源が全滅して人数が分からない」であって 0 人ではない。
 * ここで 0 と表示するとダッシュボードが平然と嘘をつくので「—」を出す。
 * その場合サーバー側のゲートもフェイルオープン（canCreate=true）なので、
 * 作成ボタンは押せるままにする——分からないことを理由に機能を止めない。
 */
export function describeCapacity(input: CapacityDisplayInput, locale: Locale): CapacityDisplay {
  const dict = uiText[locale].capacity
  return {
    label: interpolate(dict.onlineCount, {
      current: input.current ?? dict.unknownCount,
      max: input.max,
    }),
    tone: input.canCreate ? 'default' : 'warning',
    createDisabledReason: input.canCreate ? null : dict.createDisabledTooltip,
  }
}

// ============================================================
// 会議室一覧の「状態」列（2026-08-07 第 2 波）
// ============================================================

export interface RoomStatusDisplay {
  label: string
  tone: 'success' | 'default' | 'warning' | 'danger'
}

/**
 * 会議室の状態 ＋ 在線人数 → 一覧の状態チップ（純関数。tests/ui/room-status-display.test.ts）。
 *
 * ★ この関数が存在する理由：`status === 'active'` を素直に「開催中 / 进行中」と訳したのが
 *   誤解の元だった。DB の active は**「この会議室は使える」というライフサイクル上の状態**で
 *   あって「今まさに人が集まって会議している」ではない。誰も居ない部屋がいつまでも
 *   「開催中」と表示され、実利用者が「会議が終わらない / 誰か居るのでは」と混乱した。
 *
 *   そこで active を在線人数で 3 分岐させ、**「開催中／进行中」という文言そのものを廃止**する：
 *     - n > 0    → 「会議中 n 人」（success）……本当に人が居る。ここだけが強調に値する
 *     - n === 0  → 「待機中」（default）……使えるが誰も居ない
 *     - n === null → 「利用可能」（default）……メディアサーバーから人数を取れなかった。
 *                    ここで「待機中」と出すと 0 人だと嘘をつくので、人数に言及しない語にする
 *   （capacity 表示の「—」と同じ思想：分からないことを分かったふりで埋めない）
 *
 * active 以外（ended / expired / disabled）は在線人数を見ない——終わった部屋・消した部屋に
 * LiveKit のルームが残っていても、利用者に伝えるべき事実は「終了済み」「削除済み」の方。
 */
export function describeRoomStatus(
  status: RoomState,
  activeParticipants: number | null,
  locale: Locale,
): RoomStatusDisplay {
  const t = uiText[locale].dashboard
  switch (status) {
    case 'disabled':
      return { label: t.statusDisabled, tone: 'danger' }
    case 'expired':
      return { label: t.statusExpired, tone: 'warning' }
    case 'ended':
      return { label: t.statusEnded, tone: 'default' }
    case 'active':
      if (activeParticipants === null) return { label: t.statusAvailable, tone: 'default' }
      if (activeParticipants > 0) {
        return { label: interpolate(t.statusInMeeting, { count: activeParticipants }), tone: 'success' }
      }
      return { label: t.statusWaiting, tone: 'default' }
  }
}

/**
 * dashboard / auth 系 API 呼び出しの共通エラー文案解決（WP-8 §4：サーバーの日本語固定
 * message をそのまま出さない）。
 *
 * app/api/** の message はまだ多言語化されておらず日本語固定（他エージェントが並行改修
 * 中でもある）。`knownCodes`（そのエンドポイントが実際に返しうるコードとして呼び出し側が
 * 把握しているもの）に一致するなら、常に localizedFallback（呼び出し側が現在の locale で
 * 用意した文言）を優先し、サーバーの message は無視する——joinErrorMessage と同じ判断。
 * knownCodes に無いコード（将来 app/api/** 側が追加するコード等）のときだけサーバーの
 * message をそのまま透传し、それも無ければ localizedFallback を使う。
 */
export function resolveApiErrorMessage(
  code: string | null | undefined,
  knownCodes: readonly string[],
  serverMessage: string | null | undefined,
  localizedFallback: string,
): string {
  if (code && knownCodes.includes(code)) return localizedFallback
  return serverMessage || localizedFallback
}
