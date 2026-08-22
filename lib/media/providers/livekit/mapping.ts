/**
 * LiveKitProvider 的纯逻辑层（规格书 §3.4 / WP-3）
 *
 * 本文件的全部导出都是**无副作用的纯函数或纯数据类**：
 *   - 不碰 window / document / navigator / RTCPeerConnection
 *   - 只用 `import type` 引 livekit-client 的类型，**绝不引入其运行时**
 *     （livekit-client 运行时会拉起 webrtc-adapter 并访问浏览器全局，
 *      在 vitest 的 node 环境里会直接炸；纯逻辑抽到这里才好写单测）
 *
 * 因此这里对 livekit 侧的几个枚举值做了「常量镜像」（见 LK_SOURCE_* / LK_DISCONNECT_REASON）。
 * 镜像来源：livekit-client 2.21.0 的 `room/track/Track.ts`（Track.Source）
 * 与 `@livekit/protocol` 的 `DisconnectReason`。升级 SDK 时若这些枚举有变，
 * 只需改这一处；tests/media/mapping.test.ts 会锁住行为。
 */
import type {
  ConnectionQuality as LkConnectionQuality,
  DisconnectReason as LkDisconnectReason,
} from 'livekit-client';
import type {
  ConnectionQuality,
  ConnectionStats,
  MediaError,
  MediaErrorCode,
  ParticipantId,
  RemoteParticipant,
} from '../../types';

// ============================================================
// 0. 错误类型
// ============================================================

/**
 * 抽象层 MediaError 的具体载体。
 * 既满足 `MediaError` 接口（可直接 emit 给 `error` 事件），
 * 又是真正的 `Error` 子类（可以 throw，堆栈完整）。
 */
export class LiveKitMediaError extends Error implements MediaError {
  readonly code: MediaErrorCode;

  readonly cause?: unknown;

  constructor(code: MediaErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'LiveKitMediaError';
    this.code = code;
    this.cause = cause;
  }
}

// ============================================================
// 1. livekit 枚举值镜像（见文件头说明）
// ============================================================

/** === `Track.Source.Camera` */
export const LK_SOURCE_CAMERA = 'camera';
/** === `Track.Source.Microphone` */
export const LK_SOURCE_MICROPHONE = 'microphone';

/** === `@livekit/protocol` 的 DisconnectReason（数字枚举） */
export const LK_DISCONNECT_REASON = {
  UNKNOWN_REASON: 0,
  CLIENT_INITIATED: 1,
  DUPLICATE_IDENTITY: 2,
  SERVER_SHUTDOWN: 3,
  PARTICIPANT_REMOVED: 4,
  ROOM_DELETED: 5,
  STATE_MISMATCH: 6,
  JOIN_FAILURE: 7,
  MIGRATION: 8,
  SIGNAL_CLOSE: 9,
  ROOM_CLOSED: 10,
  USER_UNAVAILABLE: 11,
  USER_REJECTED: 12,
  SIP_TRUNK_FAILURE: 13,
  CONNECTION_TIMEOUT: 14,
  MEDIA_FAILURE: 15,
  AGENT_ERROR: 16,
} as const;

const DISCONNECT_REASON_TEXT: Readonly<Record<number, string>> = {
  [LK_DISCONNECT_REASON.UNKNOWN_REASON]: 'unknown_reason',
  [LK_DISCONNECT_REASON.CLIENT_INITIATED]: 'client_initiated',
  [LK_DISCONNECT_REASON.DUPLICATE_IDENTITY]: 'duplicate_identity',
  [LK_DISCONNECT_REASON.SERVER_SHUTDOWN]: 'server_shutdown',
  [LK_DISCONNECT_REASON.PARTICIPANT_REMOVED]: 'participant_removed',
  [LK_DISCONNECT_REASON.ROOM_DELETED]: 'room_deleted',
  [LK_DISCONNECT_REASON.STATE_MISMATCH]: 'state_mismatch',
  [LK_DISCONNECT_REASON.JOIN_FAILURE]: 'join_failure',
  [LK_DISCONNECT_REASON.MIGRATION]: 'migration',
  [LK_DISCONNECT_REASON.SIGNAL_CLOSE]: 'signal_close',
  [LK_DISCONNECT_REASON.ROOM_CLOSED]: 'room_closed',
  [LK_DISCONNECT_REASON.USER_UNAVAILABLE]: 'user_unavailable',
  [LK_DISCONNECT_REASON.USER_REJECTED]: 'user_rejected',
  [LK_DISCONNECT_REASON.SIP_TRUNK_FAILURE]: 'sip_trunk_failure',
  [LK_DISCONNECT_REASON.CONNECTION_TIMEOUT]: 'connection_timeout',
  [LK_DISCONNECT_REASON.MEDIA_FAILURE]: 'media_failure',
  [LK_DISCONNECT_REASON.AGENT_ERROR]: 'agent_error',
};

/**
 * 「服务端主动把你踢下线」这一类断开原因 → 映射为 DISCONNECTED_BY_SERVER。
 * 不在此集合里的（客户端主动挂断、信令socket断、媒体超时、迁移）属于
 * 网络/客户端侧事件，不该报成"被服务器断开"。
 */
const SERVER_INITIATED_REASONS: ReadonlySet<number> = new Set<number>([
  LK_DISCONNECT_REASON.DUPLICATE_IDENTITY, // 同 identity 重复登录，服务端踢旧连接
  LK_DISCONNECT_REASON.SERVER_SHUTDOWN,
  LK_DISCONNECT_REASON.PARTICIPANT_REMOVED, // 房主踢人（§7.3 roomAdmin）
  LK_DISCONNECT_REASON.ROOM_DELETED, // 房主结束会议（§6.1 /end）
  LK_DISCONNECT_REASON.STATE_MISMATCH, // 服务端不认这个会话，拒绝 resume
  LK_DISCONNECT_REASON.ROOM_CLOSED,
  LK_DISCONNECT_REASON.USER_UNAVAILABLE,
  LK_DISCONNECT_REASON.USER_REJECTED,
  LK_DISCONNECT_REASON.SIP_TRUNK_FAILURE,
  LK_DISCONNECT_REASON.CONNECTION_TIMEOUT, // 服务端判定会话超时
  LK_DISCONNECT_REASON.AGENT_ERROR,
]);

/** DisconnectReason → 稳定的机器可读文本（UI 侧自行本地化） */
export function disconnectReasonText(reason?: LkDisconnectReason | number): string {
  if (reason === undefined || reason === null) return 'unknown_reason';
  return DISCONNECT_REASON_TEXT[reason] ?? `reason_${reason}`;
}

/** 是否属于「服务端主动断开」 */
export function isServerInitiatedDisconnect(reason?: LkDisconnectReason | number): boolean {
  return reason !== undefined && reason !== null && SERVER_INITIATED_REASONS.has(reason);
}

/**
 * 断开原因 → MediaError；只有服务端主动断开才产出错误，
 * 其余（客户端主动挂断 / 网络断）由 `disconnected` 事件自己表达，不额外报错。
 */
export function classifyDisconnect(
  reason?: LkDisconnectReason | number,
): LiveKitMediaError | undefined {
  if (!isServerInitiatedDisconnect(reason)) return undefined;
  return new LiveKitMediaError(
    'DISCONNECTED_BY_SERVER',
    `disconnected by server: ${disconnectReasonText(reason)}`,
    reason,
  );
}

// ============================================================
// 2. 连接质量
// ============================================================

/**
 * LiveKit ConnectionQuality → 抽象层 ConnectionQuality。
 *
 * LiveKit 多一个 `'unknown'`（刚入会、还没收到第一次质量上报时的初始值）。
 * 抽象层只有 4 档，这里把 unknown 归到中性的 `'good'`：
 * 归到 poor/lost 会让 UI 一进会就误报网络故障，比"乐观一点"危害更大。
 */
export function mapConnectionQuality(
  quality: LkConnectionQuality | string | undefined,
): ConnectionQuality {
  switch (quality) {
    case 'excellent':
      return 'excellent';
    case 'poor':
      return 'poor';
    case 'lost':
      return 'lost';
    case 'good':
      return 'good';
    default:
      return 'good';
  }
}

// ============================================================
// 3. 参与者快照
// ============================================================

/** 与 livekit `TrackPublication` 结构兼容的最小只读视图 */
export interface PublicationLike {
  readonly isMuted: boolean;
  readonly source: string;
}

/** 与 livekit `Participant` 结构兼容的最小只读视图 */
export interface ParticipantLike {
  readonly identity: string;
  readonly name?: string;
  readonly isSpeaking: boolean;
  readonly connectionQuality: LkConnectionQuality | string;
  readonly trackPublications: ReadonlyMap<string, PublicationLike>;
}

/**
 * livekit Participant → 抽象层 RemoteParticipant 快照。
 *
 * - id 用 `identity`（token 里签的，服务端可控、跨重连稳定；不用 sid）
 * - audio/videoEnabled 从对应 publication 的**存在性 + isMuted** 推导：
 *   没发布过 = 关；发布了但 muted = 关；发布且未 muted = 开。
 *   （不看订阅状态：AdaptiveStream 下"没订阅"是带宽策略，不代表对方关了摄像头）
 */
export function toRemoteParticipant(p: ParticipantLike): RemoteParticipant {
  let camera: PublicationLike | undefined;
  let microphone: PublicationLike | undefined;
  for (const pub of p.trackPublications.values()) {
    if (pub.source === LK_SOURCE_CAMERA) camera = pub;
    else if (pub.source === LK_SOURCE_MICROPHONE) microphone = pub;
  }
  return {
    id: p.identity,
    name: p.name && p.name.length > 0 ? p.name : p.identity,
    isSpeaking: p.isSpeaking === true,
    audioEnabled: microphone !== undefined && !microphone.isMuted,
    videoEnabled: camera !== undefined && !camera.isMuted,
    quality: mapConnectionQuality(p.connectionQuality),
  };
}

// ============================================================
// 4. 活跃发言者
// ============================================================

/** 与 livekit `Participant` 结构兼容的最小发言者视图 */
export interface SpeakerLike {
  readonly identity: string;
  readonly audioLevel?: number;
}

/**
 * ActiveSpeakersChanged → 按 audioLevel **降序**的 id 数组。
 *
 * LiveKit 自己已经按响度排过序，这里再排一次是防御性的（顺序是接口契约）。
 * `Array.prototype.sort` 自 ES2019 起稳定，音量相同的保持原顺序。
 * 注意：LiveKit 的 activeSpeakers **包含本地参与者**，这里原样保留 ——
 * UI 要高亮"我在说话"时也需要这个 id。
 */
export function sortSpeakerIds(speakers: readonly SpeakerLike[]): ParticipantId[] {
  return [...speakers]
    .sort((a, b) => (b.audioLevel ?? 0) - (a.audioLevel ?? 0))
    .map((s) => s.identity);
}

// ============================================================
// 5. 错误分类
// ============================================================

function readString(target: unknown, key: string): string | undefined {
  if (typeof target !== 'object' || target === null) return undefined;
  const value = (target as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

function readNumber(target: unknown, key: string): number | undefined {
  if (typeof target !== 'object' || target === null) return undefined;
  const value = (target as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** getUserMedia 的权限类失败：DOMException.name + LiveKit MediaDeviceFailure 名 */
const PERMISSION_ERROR_NAMES: ReadonlySet<string> = new Set([
  'NotAllowedError',
  'PermissionDeniedError', // 旧版 Chrome
  'PermissionDenied', // LiveKit MediaDeviceFailure
  'SecurityError', // 非安全上下文（§7.5：必须 HTTPS），引导路径与"被拒绝"一致
]);

/** 设备类失败：找不到 / 被占用 / 约束不满足，UI 的处置都是"换个设备再来" */
const DEVICE_ERROR_NAMES: ReadonlySet<string> = new Set([
  'NotFoundError',
  'DevicesNotFoundError', // 旧版 Chrome
  'NotFound', // LiveKit MediaDeviceFailure
  'OverconstrainedError', // 指定 deviceId 已拔掉
  'ConstraintNotSatisfiedError',
  'NotReadableError', // 设备被其他程序占用
  'TrackStartError', // 旧版 Chrome 的 NotReadableError
  'DeviceInUse', // LiveKit MediaDeviceFailure
  'DeviceUnsupportedError', // LiveKit：浏览器不支持该设备能力
]);

function classifyCode(
  name: string,
  message: string,
  status: number | undefined,
  fallback: MediaErrorCode,
): MediaErrorCode {
  // 连接类错误（LiveKit ConnectionError 带 name / HTTP status）不走设备分支，
  // 否则服务端的 "permissions denied"（token 授权不足）会被误判成摄像头权限被拒。
  const looksLikeConnection = name === 'ConnectionError' || status !== undefined;

  if (!looksLikeConnection) {
    if (PERMISSION_ERROR_NAMES.has(name)) return 'PERMISSION_DENIED';
    if (DEVICE_ERROR_NAMES.has(name)) return 'DEVICE_NOT_FOUND';
    // 没有 name 时退回文案匹配（部分浏览器把原因只写在 message 里）
    if (/permission denied|not allowed|permission dismissed/i.test(message)) {
      return 'PERMISSION_DENIED';
    }
    if (/device not found|requested device not found|no device|could not start/i.test(message)) {
      return 'DEVICE_NOT_FOUND';
    }
  }

  // 房间满员：服务端第二道防线（§12.8，第一道在 token 签发时）
  if (/room is full|room full|exceeds? .*(participant|room) limit|max_participants/i.test(message)) {
    return 'ROOM_FULL';
  }

  // token / 鉴权
  if (status === 401 || status === 403) return 'TOKEN_INVALID';
  if (/token|unauthorized|invalid api key|jwt/i.test(message)) return 'TOKEN_INVALID';

  // 连不上媒体服务器
  if (
    name === 'ConnectionError' ||
    /could not (establish|connect)|server unreachable|websocket|timed ?out|timeout|network error|failed to connect/i.test(
      message,
    )
  ) {
    return 'CONNECT_FAILED';
  }

  return fallback;
}

const DEFAULT_MESSAGE: Readonly<Record<MediaErrorCode, string>> = {
  PERMISSION_DENIED: 'camera/microphone permission denied',
  DEVICE_NOT_FOUND: 'camera/microphone not available',
  CONNECT_FAILED: 'failed to connect to media server',
  TOKEN_INVALID: 'media token rejected',
  ROOM_FULL: 'room is full',
  DISCONNECTED_BY_SERVER: 'disconnected by server',
  UNKNOWN: 'unknown media error',
};

/**
 * 任意异常 → MediaError（规格书 §3.2 的 7 个错误码）。
 *
 * @param fallback 无法识别时用哪个码（按调用点上下文给：connect 给 CONNECT_FAILED，
 *                 设备操作给 UNKNOWN 让 name 分类去兜底）。
 */
export function classifyError(err: unknown, fallback: MediaErrorCode = 'UNKNOWN'): LiveKitMediaError {
  // 已经分好类的不再二次包装，避免 message/code 被覆盖
  if (err instanceof LiveKitMediaError) return err;

  const name = readString(err, 'name') ?? '';
  const message = readString(err, 'message') ?? (typeof err === 'string' ? err : '');
  const status = readNumber(err, 'status');
  const code = classifyCode(name, message, status, fallback);
  return new LiveKitMediaError(code, message.length > 0 ? message : DEFAULT_MESSAGE[code], err);
}

// ============================================================
// 6. getStats 聚合
// ============================================================

/** RTCStats 条目的最小视图（RTCStatsReport 的 value 在 TS 里是 any，这里收紧成可枚举对象） */
export interface RtcStatLike {
  readonly id?: string;
  readonly type?: string;
  readonly timestamp?: number;
  readonly [key: string]: unknown;
}

/** 一次采样的原始累计量（RTP 计数器都是**累计值**，必须两次采样求差才有意义） */
export interface StatsSnapshot {
  /** 采样时刻（ms）：优先用 RTCStats 自带 timestamp，缺失时用调用方给的 now */
  atMs: number;
  rttMs: number;
  bytesReceived: number;
  bytesSent: number;
  packetsReceived: number;
  packetsSent: number;
  packetsLost: number;
}

const EMPTY_STATS: ConnectionStats = {
  rttMs: 0,
  packetLossPct: 0,
  outboundKbps: 0,
  inboundKbps: 0,
};

/** 无数据时返回全 0（接口不允许 undefined，见 §3.2 ConnectionStats） */
export function emptyConnectionStats(): ConnectionStats {
  return { ...EMPTY_STATS };
}

function toNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * 把若干 RTCStatsReport 拍平后的条目聚合成一次采样。
 *
 * 取数规则（尽力而为，取不到就是 0）：
 * - **rttMs**：`candidate-pair` 的 `currentRoundTripTime`（秒 → 毫秒）。
 *   只认 `state === 'succeeded'` 或 `nominated` 的候选对；同一 PeerConnection 上
 *   每路 track 的 getStats 都会带出同一条候选对，靠 `id` 去重后取最大（最差）的一条。
 *   候选对拿不到时退回 `remote-inbound-rtp.roundTripTime`（对端回报的 RTT）。
 * - **字节/包**：`inbound-rtp`（下行）与 `outbound-rtp`（上行）分别累加；
 *   丢包同时计入 `inbound-rtp.packetsLost`（我方收丢）和
 *   `remote-inbound-rtp.packetsLost`（对端报我方发丢），即**双向合计丢包**。
 * - **去重**：多路 track 的 report 会重复给出 transport / candidate-pair 级条目，
 *   按 `stat.id` 去重，避免字节数被重复累加。
 */
export function collectStatsSnapshot(
  entries: Iterable<RtcStatLike>,
  nowMs: number = Date.now(),
): StatsSnapshot {
  const seen = new Set<string>();
  let latestTs = 0;
  let candidatePairRttMs = 0;
  let remoteRttMs = 0;
  let bytesReceived = 0;
  let bytesSent = 0;
  let packetsReceived = 0;
  let packetsSent = 0;
  let packetsLost = 0;

  for (const entry of entries) {
    if (!entry) continue;
    const id = typeof entry.id === 'string' ? entry.id : undefined;
    if (id !== undefined) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    const ts = toNumber(entry.timestamp);
    if (ts > latestTs) latestTs = ts;

    switch (entry.type) {
      case 'candidate-pair': {
        const usable = entry.state === 'succeeded' || entry.nominated === true;
        if (usable) {
          const rtt = toNumber(entry.currentRoundTripTime) * 1000;
          if (rtt > candidatePairRttMs) candidatePairRttMs = rtt;
        }
        break;
      }
      case 'inbound-rtp':
        bytesReceived += toNumber(entry.bytesReceived);
        packetsReceived += toNumber(entry.packetsReceived);
        packetsLost += toNumber(entry.packetsLost);
        break;
      case 'outbound-rtp':
        bytesSent += toNumber(entry.bytesSent);
        packetsSent += toNumber(entry.packetsSent);
        break;
      case 'remote-inbound-rtp': {
        packetsLost += toNumber(entry.packetsLost);
        const rtt = toNumber(entry.roundTripTime) * 1000;
        if (rtt > remoteRttMs) remoteRttMs = rtt;
        break;
      }
      default:
        break;
    }
  }

  return {
    atMs: latestTs > 0 ? latestTs : nowMs,
    rttMs: candidatePairRttMs > 0 ? candidatePairRttMs : remoteRttMs,
    // RFC 3550 允许 packetsLost 为负（重复包多于丢包），钳到 0
    packetsLost: Math.max(0, packetsLost),
    bytesReceived,
    bytesSent,
    packetsReceived,
    packetsSent,
  };
}

function ratePerSecondKbps(deltaBytes: number, deltaSeconds: number): number {
  if (deltaSeconds <= 0) return 0;
  return Math.max(0, (deltaBytes * 8) / 1000 / deltaSeconds);
}

/**
 * 两次采样 → ConnectionStats。
 *
 * - kbps 必须靠**相邻两次采样求差**：RTP 的 bytesSent/Received 是会话累计值，
 *   直接除以会话时长会把突发流量抹平。首次调用没有基线 → kbps 给 0（不是估算，是没数据）。
 * - packetLossPct 同理优先用窗口增量（反映"此刻"网络），
 *   没有基线时退回累计值（仍有参考意义，总比 0 强）。
 * - 计数器在重连后可能被清零 → 增量为负时视为无效，退回 0 / 累计值。
 */
export function computeConnectionStats(
  current: StatsSnapshot,
  previous?: StatsSnapshot,
): ConnectionStats {
  const deltaSeconds = previous ? (current.atMs - previous.atMs) / 1000 : 0;
  const hasBaseline = previous !== undefined && deltaSeconds > 0;

  const inboundKbps = hasBaseline
    ? ratePerSecondKbps(current.bytesReceived - previous.bytesReceived, deltaSeconds)
    : 0;
  const outboundKbps = hasBaseline
    ? ratePerSecondKbps(current.bytesSent - previous.bytesSent, deltaSeconds)
    : 0;

  let lost = current.packetsLost;
  let total = current.packetsLost + current.packetsReceived + current.packetsSent;
  if (hasBaseline) {
    const deltaLost = current.packetsLost - previous.packetsLost;
    const deltaTotal =
      deltaLost +
      (current.packetsReceived - previous.packetsReceived) +
      (current.packetsSent - previous.packetsSent);
    if (deltaLost >= 0 && deltaTotal > 0) {
      lost = deltaLost;
      total = deltaTotal;
    }
  }
  const packetLossPct = total > 0 ? Math.min(100, Math.max(0, (lost / total) * 100)) : 0;

  return {
    rttMs: Math.round(current.rttMs),
    packetLossPct: Math.round(packetLossPct * 10) / 10,
    inboundKbps: Math.round(inboundKbps),
    outboundKbps: Math.round(outboundKbps),
  };
}
