// ============ 基础类型 ============
export type ParticipantId = string;
export type ConnectionQuality = 'excellent' | 'good' | 'poor' | 'lost';
export interface RemoteParticipant {
  id: ParticipantId;
  name: string;
  isSpeaking: boolean;
  audioEnabled: boolean;
  videoEnabled: boolean;
  quality: ConnectionQuality;
}
export interface LocalState {
  audioEnabled: boolean;
  videoEnabled: boolean;
  audioDeviceId?: string;
  videoDeviceId?: string;
}
export interface MediaDeviceEntry {
  deviceId: string;
  label: string;
  kind: 'audioinput' | 'videoinput' | 'audiooutput';
}
export interface ConnectionStats {
  rttMs: number;
  packetLossPct: number;
  outboundKbps: number;
  inboundKbps: number;
}
export type MediaErrorCode =
  | 'PERMISSION_DENIED'      // 用户拒绝摄像头/麦克风
  | 'DEVICE_NOT_FOUND'
  | 'CONNECT_FAILED'         // 无法连上媒体服务器
  | 'TOKEN_INVALID'
  | 'ROOM_FULL'
  | 'DISCONNECTED_BY_SERVER'
  | 'UNKNOWN';
export interface MediaError {
  code: MediaErrorCode;
  message: string;
  cause?: unknown;
}
// ============ 连接配置 ============
// 由后端 /api/rooms/{code}/join 原样返回，前端不解析内部结构，
// 直接透传给 provider.connect()。切换 provider 时前端零改动。
export type ProviderConfig =
  | { provider: 'livekit'; serverUrl: string; token: string }
  | { provider: 'agora'; appId: string; channel: string; token: string; uid: string };
export interface ConnectOptions {
  config: ProviderConfig;
  displayName: string;
  /** 入会时是否直接开麦/开摄像头（来自 pre-join 页的选择） */
  initialAudio: boolean;
  initialVideo: boolean;
  initialAudioDeviceId?: string;
  initialVideoDeviceId?: string;
}
// ============ 事件 ============
export interface MediaProviderEvents {
  connected: () => void;
  disconnected: (reason?: string) => void;
  reconnecting: () => void;
  reconnected: () => void;
  participantJoined: (p: RemoteParticipant) => void;
  participantLeft: (id: ParticipantId) => void;
  /** 远端静音/关摄像头/说话状态变化时触发 */
  participantUpdated: (p: RemoteParticipant) => void;
  /** 活跃发言者变化，按活跃度降序 */
  activeSpeakersChanged: (ids: ParticipantId[]) => void;
  localStateChanged: (s: LocalState) => void;
  error: (e: MediaError) => void;
}
// ============ 主接口 ============
export interface MediaProvider {
  // ---- 生命周期 ----
  connect(opts: ConnectOptions): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  // ---- 本地媒体控制 ----
  setMicrophoneEnabled(enabled: boolean): Promise<void>;
  setCameraEnabled(enabled: boolean): Promise<void>;
  switchAudioDevice(deviceId: string): Promise<void>;
  switchVideoDevice(deviceId: string): Promise<void>;
  // ---- 渲染绑定 ----
  // 两家 SDK 差异最大之处，必须由 provider 内部消化。
  // UI 层只负责提供 <video> 元素，不接触 Track 对象。
  attachLocalVideo(el: HTMLVideoElement): void;
  detachLocalVideo(): void;
  attachRemoteVideo(id: ParticipantId, el: HTMLVideoElement): void;
  detachRemoteVideo(id: ParticipantId): void;
  /** 扬声器选择，浏览器不支持时静默忽略 */
  setAudioOutputDevice(deviceId: string): Promise<void>;
  // ---- 查询 ----
  getParticipants(): RemoteParticipant[];
  getLocalState(): LocalState;
  getStats(): Promise<ConnectionStats>;
  // ---- 事件订阅 ----
  on<K extends keyof MediaProviderEvents>(e: K, cb: MediaProviderEvents[K]): void;
  off<K extends keyof MediaProviderEvents>(e: K, cb: MediaProviderEvents[K]): void;
}
// ============ 设备工具（与 provider 无关，独立导出）============
export interface MediaDeviceHelper {
  listDevices(): Promise<MediaDeviceEntry[]>;
  requestPermission(): Promise<{ audio: boolean; video: boolean }>;
}

// ============================================================
// ==== 2026-08-07 聊天扩展（用户需求 FR-4；Agora 侧未来用 RTM/DataStream 对应）====
//
// 以上 §3.2 原文一字未改。会议内文字聊天是规格书之后追加的需求，接口用
// **interface 声明合并**（同一模块内重复声明 `MediaProvider` / `MediaProviderEvents`
// 会自动合并成一个类型）向下追加，这样既拿到了新方法/新事件，又不必动冻结的原文。
//
// 语义约定（两家 provider 都必须照此实现）：
//  - 消息**不持久化**：只在会话期间经媒体通道（LiveKit=可靠 DataChannel，
//    Agora 未来用 RTM / DataStream）转发，会议结束即消失，不落库。
//  - `sendChatMessage` 返回**完整的消息体**供本地回显——本地消息**不**再通过
//    `chatMessageReceived` 回吐（单一事实源，避免自己的消息出现两条）。
//  - `chatMessageReceived` 只在收到**远端**消息时触发。
// ============================================================

/**
 * 单条消息正文的字符上限，**接口契约的一部分**（不是某个 provider 的私有实现细节）：
 * UI 用它做输入限长与超限提示，provider 用它做发送前拒绝与接收端截断，
 * 两侧必须是同一个数——所以放在这里，而不是各自写一份。
 */
export const MAX_CHAT_TEXT_LENGTH = 500;

/** 会议内文字聊天的一条消息（发送端与接收端共用同一形状）。 */
export interface ChatMessage {
  /** 消息唯一 id（发送端生成，接收端原样保留；UI 用作 React key 与去重依据） */
  id: string;
  /** 发送者的 ParticipantId（= token 里的 identity，与 RemoteParticipant.id 同一命名空间） */
  senderIdentity: ParticipantId;
  /** 发送者显示名。取不到名字时 provider 退回 identity，保证非空 */
  senderName: string;
  /** 纯文本正文。provider 侧已 trim 且限长，UI 直接按文本渲染（禁止当 HTML 解释） */
  text: string;
  /** 发送时刻（Unix 毫秒，发送端时钟） */
  timestamp: number;
}

export interface MediaProvider {
  /**
   * 发送一条聊天消息。返回**本地回显用**的完整消息体（id / 时间戳由发送端生成）。
   * 空文本、超长文本、未连接时一律 reject（`MediaError`），不做静默丢弃。
   */
  sendChatMessage(text: string): Promise<ChatMessage>;
}

export interface MediaProviderEvents {
  /** 收到**远端**参与者的聊天消息（本地消息不会触发，见上方说明） */
  chatMessageReceived: (m: ChatMessage) => void;
}

// ============================================================
// ==== 2026-08-13 背景效果扩展（FR-7；Agora 侧未来用其官方 virtual background extension 对应）====
//
// 同样是**只加不改**：上方 §3.2 原文与 2026-08-07 聊天扩展块一字未动，
// 这里继续用 **interface 声明合并** 往 `MediaProvider` / `LocalState` 上追加。
//
// 语义约定（两家 provider 都必须照此实现）：
//  - 效果只作用于**本地摄像头上行**：处理后的画面既是别人看到的，也是本地预览看到的
//    （不是"只有自己看得见"的滤镜），关摄像头时无事可做。
//  - **纯客户端处理**，不落库、不上报服务端；换 provider / 刷新页面即失效，
//    要记住用户的选择由 UI 侧自己持久化（localStorage）并在入会后重放。
//  - `{ type: 'none' }` 是"不挂任何处理管线"，不是"挂一个空效果"——
//    实现侧必须真正把 processor 拆掉，省 CPU（视频会议里这项开销不小）。
//  - 摄像头**关→重开**、**切换摄像头设备**之后，provider 负责把当前效果重新挂上，
//    UI 不需要（也不应该）自己补调用。
// ============================================================

/**
 * 本地摄像头的背景效果。
 *
 * `imageUrl` **只接受同源资源**：`/` 开头的站内路径、`blob:`、`data:image/`。
 * 外链（http/https）一律拒绝——一是跨域图片会污染 canvas 导致管线失败，
 * 二是境外图床在大陆不可达（§8.1 的同一条红线）。
 */
export type BackgroundEffect =
  | { type: 'none' }
  | { type: 'blur'; blurRadius?: number }
  | { type: 'image'; imageUrl: string };

/** `{ type: 'blur' }` 未指定 `blurRadius` 时的默认值（接口契约的一部分，UI 与 provider 共用同一个数）。 */
export const DEFAULT_BACKGROUND_BLUR_RADIUS = 10;

export interface MediaProvider {
  /**
   * 设置本地摄像头的背景效果。
   *
   * - 环境不支持（见 `isBackgroundEffectSupported`）、`imageUrl` 非法、
   *   底层管线启动失败 → **reject** `MediaError`（code `UNKNOWN`，message 说明原因）；
   *   一律不静默吞，UI 负责回滚自己的选中态并提示。
   * - 摄像头当前是关着的（或尚未连接）时**不报错**：效果被记下来，
   *   等摄像头开启/设备切换后由 provider 自动挂上。
   * - 成功后 `LocalState.backgroundEffect` 更新并触发 `localStateChanged`。
   */
  setBackgroundEffect(effect: BackgroundEffect): Promise<void>;
  /**
   * 运行时能力检测（当前浏览器能否跑 track processor 管线）。
   * 同步、无副作用、可在渲染期调用；SSR/非浏览器环境恒为 `false`。
   * UI 用它决定「背景」入口是可用还是 disabled+说明文案。
   */
  isBackgroundEffectSupported(): boolean;
}

export interface LocalState {
  /** 当前生效的背景效果（未设置过 = `{ type: 'none' }`）。 */
  backgroundEffect?: BackgroundEffect;
}

// ============================================================
// ==== 2026-08-16 prejoin 预览扩展（iOS 实机反馈③）====
//
// 依旧**只加不改**：上方 §3.2 原文 / 2026-08-07 聊天块 / 2026-08-13 背景效果块
// 三段一字未动。这里加的不是 `MediaProvider` 的方法，而是一个**独立工厂**——
// 原因是它服务的场景在 `connect()` 之前：prejoin 页还没有会话、没有 token，
// 也不该为了看一眼虚化效果就先入会。
//
// 语义约定（Agora 期需要自行实现同名工厂，用其官方 virtual background extension
// 配合本地采集轨；接口形状照此不变）：
//  - 工厂 resolve 时，摄像头轨已创建并 attach 到传入的 `<video>` 上；
//    摄像头打不开（拒绝授权 / 无设备 / 被占用）→ **reject**，调用方回落到占位图。
//  - `setEffect` 与会议内 `MediaProvider.setBackgroundEffect` **同义**：
//    非法参数 / 环境不支持 / 管线启动失败一律 reject，且失败后效果落回 `none`
//    但**保留素通し的摄像头画面**（不把预览一起弄没）。
//  - `setDeviceId` 换摄像头：内部重建采集轨并把当前效果重新挂上。
//  - `dispose` **同步且幂等**：停轨（连带销毁处理管线）+ detach，必须在离开
//    prejoin 前调用——摄像头握着不放会与入会后的采集抢设备（iOS 尤甚）。
//  - 会话**不持久化任何东西**：记住用户选了什么仍由 UI 侧 localStorage 负责，
//    入会后由会议内管线重放（与 2026-08-13 块的约定一致）。
// ============================================================

export interface BackgroundPreviewOptions {
  /** 初始摄像头设备。省略＝浏览器默认摄像头。 */
  deviceId?: string;
}

export interface BackgroundPreviewSession {
  /** 换效果（含 `{ type: 'none' }` = 拆管线）。失败 reject，调用方负责提示与回滚选中态。 */
  setEffect(effect: BackgroundEffect): Promise<void>;
  /** 换摄像头。当前效果由会话自动重挂，调用方不需要再调 `setEffect`。 */
  setDeviceId(deviceId: string | undefined): Promise<void>;
  /** 停轨 + detach。同步、幂等；调用后其余方法变为无副作用的 no-op。 */
  dispose(): void;
}

export type CreateBackgroundPreviewSession = (
  videoEl: HTMLVideoElement,
  opts?: BackgroundPreviewOptions,
) => Promise<BackgroundPreviewSession>;
