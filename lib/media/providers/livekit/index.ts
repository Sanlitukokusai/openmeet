/**
 * LiveKitProvider —— MediaProvider 抽象层的 LiveKit 实装（规格书 §3.4 / WP-3）
 *
 * ============ 本文件的几条硬约束 ============
 *
 * 1) **AdaptiveStream + Dynacast 必须开启**。服务器公网出站只有 40 Mbps
 *    （docs/SERVER-FACTS.md 实测），6 人全员 720p 单场就要 ~45 Mbps。
 *    这两项在规格书里是"优化"，在 40 Mbps 下是**生存条件**：
 *    - adaptiveStream：按 <video> 元素的实际显示尺寸自动订阅低分辨率层，
 *      元素不可见时暂停拉流；
 *    - dynacast：没人订阅的层直接停发，省上行与 CPU。
 *    Simulcast 三档固定为 720p@1.5M / 360p@0.5M / 180p@0.15M（§3.4），
 *    码率显式写死，不用 SDK 默认值（默认 720p 是 1.7M，超出核算）。
 *    编码器 VP8 优先、H.264 作 backupCodec；不用 VP9/AV1（Safari 兼容，§3.4）。
 *
 * 2) **attach / detach 必须成对**（§12.6 内存泄漏红线）。
 *    provider 内部维护 participantId → { element, track } 登记表：
 *    - `attachRemoteVideo` 时若 track 还没订阅到，只登记元素；
 *      等 `TrackSubscribed` 到达再自动补挂（prejoin→入会的常见时序）；
 *    - `detachRemoteVideo` 必须把登记清干净，并清空 element.srcObject；
 *    - `disconnect()` 做全量清理：detach 全部 + removeAllListeners + room.disconnect()。
 *    detach 系列**幂等**：重复调用、对不存在的 id 调用都安全（React StrictMode 会重复跑 effect）。
 *
 * 3) **远端音频由 provider 内部接管**。抽象接口只让 UI 提供 <video> 元素
 *    （§3.2 注释：UI 不接触 Track 对象），而 livekit-client 不会自动播放远端音频 ——
 *    必须把音频 track attach 到一个 <audio> 元素上。这里为每条远端音频 track
 *    建一个隐藏 <audio> 挂到 document.body，随 TrackUnsubscribed / disconnect 一起拆掉。
 *
 * 4) **iOS Safari 首次音频播放需要用户手势**（§12.4）。types.ts 已冻结、不能加接口，
 *    所以在 provider 内部消化：监听 `RoomEvent.AudioPlaybackStatusChanged`，
 *    一旦播放被浏览器策略拦截（room.canPlaybackAudio === false），就在 document 上
 *    注册一次性的 click / touchend 监听，用户随便点一下就调 `room.startAudio()` 重试，
 *    成功后立刻注销监听。重连（Reconnected）后同样复查一次音频状态。
 *
 * 5) 纯逻辑（质量映射、发言者排序、错误分类、stats 聚合）全部在 `./mapping.ts`，
 *    那里不引 livekit-client 运行时，可在 node 环境直接单测（tests/media/mapping.test.ts）。
 *    聊天的纯逻辑（文本校验、消息体容错）同理在 `./chat.ts`。
 *
 * 6) **聊天用 SDK 内置的 chat API**（2026-08-07 FR-4）：
 *    `localParticipant.sendChatMessage()` + `RoomEvent.ChatMessage`。它在 2.21.0 里
 *    是协议级的 `DataPacket{ case: 'chatMessage' }`（可靠 DataChannel），不是我们自己
 *    在 `publishData` 上现搭的 JSON 约定——id/timestamp 的生成、分发、与将来 LiveKit
 *    生态（Agent、录制、其它端 SDK）的互通都由 SDK 负责，少一层自造格式要维护。
 *    ⚠️ 一个坑：`RoomEvent.ChatMessage` **对本地发出的消息也会触发**
 *    （Room 内部把 localParticipant 的 ParticipantEvent.ChatMessage 转发成同名房间事件）。
 *    抽象层的约定是「`chatMessageReceived` 只报远端」，所以这里必须按 `isLocal` 过滤，
 *    否则自己的每条消息会在 UI 里出现两遍（本地回显 + 事件回吐）。
 *
 * 7) **背景ぼかし / バーチャル背景**（2026-08-13 FR-7）：`@livekit/track-processors`
 *    走 **dynamic import**，只在首次真正要挂效果时才加载。理由与 §8.2 同源——
 *    这个包连带 `@mediapipe/tasks-vision` 有好几百 KB，多数会议根本不开背景效果，
 *    不该让它进 room 路由的初始 chunk。能力检测因此是**两段式**（见 ./background.ts §5）：
 *    同步的 `isBackgroundEffectSupported()` 用自实现探针（零依赖），
 *    懒加载之后再用库自己的 `supportsBackgroundProcessors()` 复核。
 *    MediaPipe 的 wasm 与模型**必须**指向本仓库 `public/mediapipe/` 的同源副本
 *    （不传 assetPaths 时库会退回境外公共 CDN，§8.1 明令禁止）——
 *    这条红线集中在 `./background.ts` 的 `MEDIAPIPE_ASSET_PATHS`，并有回归测试钉死。
 *
 * 8) **カメラと背景管線の自己修復**（2026-08-14 実機フィードバック
 *    「カメラを付けたまま揺らしたら真っ黒になって相手から見えなくなる」）。
 *    黒くなる経路は 3 つあり、**症状も検知方法も別物**なので個別に手当てする：
 *
 *    (a) レイアウト分岐の切替でタイルが再マウントされ attach/detach が連打される
 *        → UI 側の修正（components/room/VideoGrid.tsx ＋ layout-flip.ts）。ここでは扱わない。
 *    (b) **カメラのソーストラックがブラウザに殺される**（バックグラウンド・カメラ排他）
 *        → `TrackEvent.Ended` と前面復帰時の点検で検知し、カメラを取り直す（§ recoverCamera）。
 *    (c) **背景処理管線だけが死ぬ**（WebGL コンテキストロスト / MediaPipe 例外）
 *        → カメラは生きているのに黒フレーム・凍結フレームを流し続ける。**これが一番厄介**：
 *          `@livekit/track-processors` 0.7.2 は運行期エラーを一切外に出さない
 *          （EventEmitter も onError も無く、`transform()` の例外は内部の try/catch で
 *           握り潰されて loglevel に消える）。LiveKit 側も processedTrack には
 *          `ended` を張っていないので `TrackEvent.Ended` は上がらない。
 *          そこで**こちらから 3 点計測する**（§ armProcessorProbes）。
 *
 *    どの経路でも守る鉄則：**無言で黒いまま放置しない**。復旧できたら復旧を、
 *    できなければカメラを OFF 状態に確定させて（＝コントロールバーのカメラボタンが
 *    赤い「オフ」表示になる）UI にトーストを出させる。判定の純ロジックと
 *    「ユーザーが自分で切ったカメラを勝手に点け直さない」という一線は ./camera-health.ts。
 *
 * ⚠️ 規格書 §3.1：`livekit-client` 的 import 只允许出现在本目录下，
 *    已由 eslint.config.mjs 的 no-restricted-imports 与 scripts/check-china-safe.sh 双重强制。
 *    `@livekit/track-processors` 同属媒体实现细节，同样只许在本目录下 import（ESLint 已追加）。
 */
import {
  ConnectionState,
  Room,
  RoomEvent,
  Track,
  TrackEvent,
  VideoPreset,
  isLocalTrack,
  isRemoteTrack,
  supportsAudioOutputSelection,
} from 'livekit-client';
import type { LocalTrack, LocalVideoTrack } from 'livekit-client';

import {
  MAX_CHAT_TEXT_LENGTH,
  type BackgroundEffect,
  type ChatMessage,
  type ConnectionStats,
  type ConnectOptions,
  type LocalState,
  type MediaError,
  type MediaProvider,
  type MediaProviderEvents,
  type ParticipantId,
  type RemoteParticipant,
} from '../../types';
import {
  computeBackgroundSupport,
  createBackgroundProcessor,
  isSameBackgroundEffect,
  noBackgroundEffect,
  normalizeBackgroundEffect,
  planBackgroundApply,
  probeBackgroundCapabilities,
  type NormalizedBackgroundEffect,
} from './background';
import {
  CAMERA_RESUME_SETTLE_MS,
  decideCameraHealth,
  pruneRecoveryAttempts,
  shouldDropBackgroundEffect,
  type CameraHealthPhase,
} from './camera-health';
import { normalizeOutgoingChatText, toChatMessage } from './chat';
import { TypedEventEmitter } from './emitter';
import { loadTrackProcessors, type BackgroundProcessorHandle } from './track-processors-loader';
import {
  LiveKitMediaError,
  classifyDisconnect,
  classifyError,
  collectStatsSnapshot,
  computeConnectionStats,
  disconnectReasonText,
  emptyConnectionStats,
  sortSpeakerIds,
  toRemoteParticipant,
  type ParticipantLike,
  type RtcStatLike,
  type SpeakerLike,
  type StatsSnapshot,
} from './mapping';

/** livekit `Participant` 的结构视图：参与者快照所需字段 + 本地/远端标记 */
type LkParticipantView = ParticipantLike & { readonly isLocal: boolean };

/** 聊天消息发送者的最小结构视图（`RoomEvent.ChatMessage` 的第二参数，可能缺席） */
type LkChatSenderView = { readonly identity: string; readonly name?: string; readonly isLocal: boolean };

// ============================================================
// Simulcast 三档（§3.4，码率显式指定，勿用 SDK 默认值）
// ============================================================
/** 主层 1280×720 @ 1.5 Mbps */
const LAYER_720P = new VideoPreset({
  width: 1280,
  height: 720,
  maxBitrate: 1_500_000,
  maxFramerate: 30,
});
/** 中间层 640×360 @ 0.5 Mbps —— 40 Mbps 下多人会议的实际主力档 */
const LAYER_360P = new VideoPreset({
  width: 640,
  height: 360,
  maxBitrate: 500_000,
  maxFramerate: 25,
});
/** 最低层 320×180 @ 0.15 Mbps —— 网格里的小窗/弱网兜底 */
const LAYER_180P = new VideoPreset({
  width: 320,
  height: 180,
  maxBitrate: 150_000,
  maxFramerate: 15,
});

// ============================================================
// 自己修復のタイミング定数（文件头 8）
// ============================================================

/**
 * `TrackEvent.Ended` を受けてから点検するまでの待ち。
 *
 * ⚠️ **LiveKit 自身も**同じイベントで `restartTrack()` を試みる
 *（`LocalParticipant.handleTrackEnded`）。こちらが先に走ると復旧処理が二重になって
 * 取り合いになるので、**まず本家に譲り**、落ち着いた頃に「それで直ったか？」だけを見る。
 */
const CAMERA_ENDED_SETTLE_MS = 1_500;

/** 背景管線の再構築を試みる最小間隔（連続失敗のループ防止）。 */
const PIPELINE_RECOVERY_THROTTLE_MS = 5_000;

/** watchdog の点検周期。 */
const PROCESSOR_WATCHDOG_INTERVAL_MS = 2_000;

/**
 * 「フレームが流れていない」と判定するまでの無音時間。
 * 最低档の simulcast でも 15fps は出る設計なので、3 秒間 1 枚も来ないのは明確な異常。
 */
const PROCESSOR_FRAME_STALL_MS = 3_000;

/** 远端视频挂载登记项（§12.6） */
interface RemoteVideoBinding {
  /** UI 提供的 <video>，provider 只借用不持有其生命周期 */
  el: HTMLVideoElement;
  /** 已经挂上去的 track；尚未订阅到时为 undefined */
  track?: Track;
}

function isBrowser(): boolean {
  return typeof document !== 'undefined';
}

export class LiveKitProvider implements MediaProvider {
  private room?: Room;

  private readonly emitter = new TypedEventEmitter<MediaProviderEvents>();

  // backgroundEffect 从一开始就是 `{ type: 'none' }`，不留 undefined：
  // types.ts 的契约写的是「未设置过 = { type: 'none' }」，getLocalState() 在 connect 之前
  // 也该守住这句话，UI 才不用到处写 `?? { type: 'none' }`。
  private localState: LocalState = {
    audioEnabled: false,
    videoEnabled: false,
    backgroundEffect: noBackgroundEffect(),
  };

  /** 入会昵称。权威来源是 token 里的 name（§7.3），这里只留一份本地回显用的副本 */
  private displayName = '';

  private localVideoEl?: HTMLVideoElement;

  private localVideoTrack?: Track;

  private readonly remoteVideo = new Map<ParticipantId, RemoteVideoBinding>();

  /** trackSid → 隐藏的 <audio>（远端音频播放，见文件头 3） */
  private readonly remoteAudioEls = new Map<string, HTMLMediaElement>();

  private speakingIds = new Set<ParticipantId>();

  /** getStats 的上一次采样，用于算增量码率（RTP 计数器是累计值） */
  private prevStats?: StatsSnapshot;

  /** iOS 音频解锁用的一次性手势监听（见文件头 4） */
  private audioUnlockHandler?: () => void;

  /** 远端消息缺 id 时的兜底序号（保证同一会话内不重复，UI 拿它当 React key） */
  private chatFallbackSeq = 0;

  // ---- 背景效果（文件头 7）----

  /** 当前**意图**的效果。注意它与「processor 是否真的挂着」是两件事：
   *  摄像头关着时这里可以是 blur，而 processor 为空——等摄像头开了再挂。 */
  private backgroundEffect: NormalizedBackgroundEffect = noBackgroundEffect();

  /** 当前挂着的 processor（`{ type: 'none' }` 时必为 undefined，见 applyBackgroundEffect） */
  private backgroundProcessor?: BackgroundProcessorHandle;

  /** processor 挂在**哪一条** LocalVideoTrack 上。摄像头关→重开会换一条新 track，
   *  靠这个引用判断是「同轨换模式（switchTo，无残影）」还是「换轨重建」。 */
  private backgroundProcessorTrack?: LocalVideoTrack;

  /** 能力检测缓存：webgl2 那一项要真建一次上下文，别每次渲染都算 */
  private backgroundSupport?: boolean;

  /** 背景操作串行队列：UI 连点背景卡片时，setProcessor / switchTo 不能交叠 */
  private backgroundQueue: Promise<void> = Promise.resolve();

  // ---- カメラ自己修復（文件头 8）----

  /**
   * ユーザーが望むカメラの状態。**自己修復を撃つかどうかの最重要ガード**——
   * これが false のときは何があってもカメラを点け直さない（勝手に映るのはプライバシー事故）。
   * `setCameraEnabled()` の呼び出しと入室時の `initialVideo` だけがここを動かす。
   */
  private cameraIntent = false;

  /** 直近にカメラ再取得を試みた時刻（スロットル用） */
  private cameraRecoveryAt?: number;

  /** 自己修復の実行中（多重起動防止） */
  private cameraRecovering = false;

  /** 背景管線の再構築を試みた時刻の履歴（窓内の回数で「管線が犯人」を判定） */
  private pipelineRecoveryAttempts: number[] = [];

  /** processor に張った監視リスナーの解除関数（armProcessorProbes / disarmProcessorProbes） */
  private processorProbeCleanups: (() => void)[] = [];

  /** onFrameProcessed が最後に呼ばれた時刻（watchdog の心跳） */
  private lastProcessedFrameAt = 0;

  /** 前面復帰・ページ復帰の監視解除関数 */
  private lifecycleCleanups: (() => void)[] = [];

  /** 遅延点検のタイマー（重複して張らないよう 1 本に集約） */
  private healthCheckTimer?: ReturnType<typeof setTimeout>;

  /** 今 `TrackEvent.Ended` を張っているローカルカメラトラック */
  private watchedCameraTrack?: LocalTrack;

  // ==========================================================
  // 生命周期
  // ==========================================================

  async connect(opts: ConnectOptions): Promise<void> {
    const { config } = opts;
    if (config.provider !== 'livekit') {
      throw new LiveKitMediaError(
        'UNKNOWN',
        `LiveKitProvider only accepts provider === 'livekit', got '${config.provider}'`,
      );
    }
    if (this.room) {
      throw new LiveKitMediaError(
        'UNKNOWN',
        'LiveKitProvider is already in a session; call disconnect() first',
      );
    }

    this.displayName = opts.displayName;
    const room = new Room({
      // ↓ 40 Mbps 生存条件，勿关（文件头 1）
      adaptiveStream: true,
      dynacast: true,
      videoCaptureDefaults: {
        deviceId: opts.initialVideoDeviceId,
        // 采集就按 720p，simulcast 才有三档可分（<960px 采集时 SDK 只发两层）
        resolution: LAYER_720P.resolution,
      },
      audioCaptureDefaults: {
        deviceId: opts.initialAudioDeviceId,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      publishDefaults: {
        simulcast: true,
        videoCodec: 'vp8',
        // VP8 本身全平台可解，backupCodec 只在对端不支持主编码时才起效；
        // 这里显式写上 h264 是把 §3.4 的"H.264 作回退"落到配置里。
        backupCodec: { codec: 'h264' },
        videoEncoding: LAYER_720P.encoding,
        // SDK 内部会排序，这里按低→高书写便于阅读
        videoSimulcastLayers: [LAYER_180P, LAYER_360P],
        dtx: true,
        red: true,
        // 带宽不足时优先保帧率、降分辨率（会议场景动作连贯比清晰更重要）
        degradationPreference: 'maintain-framerate',
      },
      stopLocalTrackOnUnpublish: true,
      disconnectOnPageLeave: true,
    });

    // 先注册事件，再 connect：否则 Connected / 早期的 ParticipantConnected 会漏掉
    this.room = room;
    this.bindRoomEvents(room);

    try {
      await room.connect(config.serverUrl, config.token, { autoSubscribe: true });
    } catch (err) {
      const mediaError = classifyError(err, 'CONNECT_FAILED');
      room.removeAllListeners();
      this.room = undefined;
      this.emitter.emit('error', mediaError);
      throw mediaError;
    }

    // 连接已建立 → 开设备。设备失败只报错、不断开会议（§7.5 降级：
    // 允许"仅音频加入"甚至"纯旁听"，不能因为没摄像头就把人挡在门外）
    if (opts.initialAudio) {
      await this.enableLocalTrack('microphone', opts.initialAudioDeviceId);
    }
    // ⚠️ 「開こうとした」時点で意図を記録する（成功したかは別問題）。
    // 権限拒否などで開けなかった場合は track 自体が無いので、自己修復は
    // `no_track` で何もしない側に倒れる（./camera-health.ts の判定順）。
    this.cameraIntent = opts.initialVideo;
    if (opts.initialVideo) {
      await this.enableLocalTrack('camera', opts.initialVideoDeviceId);
    }
    this.armLifecycleWatchers();
    this.syncLocalState();
    this.ensureAudioPlayback();
  }

  async disconnect(): Promise<void> {
    const room = this.room;
    this.room = undefined;

    // 顺序：先拆 processor（还需要 track 在场）→ 再拆挂载（§12.6）→ 摘监听 → 最后断连
    await this.teardownBackgroundProcessor();
    this.detachAllMedia(true);
    this.disarmAudioUnlockGesture();
    // 自己修復まわりの監視も全部畳む（document / window / track / timer——
    // どれか一つでも残すと会議を抜けた後に動き続ける＝§12.6 と同じ漏れ）
    this.disarmLifecycleWatchers();
    this.unwatchCameraTrack();
    this.cancelHealthCheck();
    this.cameraIntent = false;
    this.cameraRecovering = false;
    this.cameraRecoveryAt = undefined;
    this.pipelineRecoveryAttempts = [];
    this.prevStats = undefined;
    this.speakingIds.clear();
    // 背景效果**不跨会话保留**：同一个 provider 实例 disconnect → connect 复用时，
    // 从零开始。要记住用户的选择由 UI 侧持久化（localStorage）后在入会完成时重放。
    this.backgroundEffect = noBackgroundEffect();
    this.localState = {
      audioEnabled: false,
      videoEnabled: false,
      backgroundEffect: this.backgroundEffect,
    };

    if (room) {
      // 注意：先 removeAllListeners 意味着本次不会再回吐 `disconnected` 事件 ——
      // 显式调用 disconnect() 的一方自己知道会话结束了，不需要事件回调，
      // 也避免 UI 卸载时被自己触发的 disconnected 带出跳转等副作用。
      room.removeAllListeners();
      await room.disconnect();
    }
    // emitter 上的订阅**不清**：调用方（UI）负责自己 off，
    // 这样同一个 provider 实例还能 disconnect → connect 复用。
  }

  isConnected(): boolean {
    return this.room?.state === ConnectionState.Connected;
  }

  // ==========================================================
  // 本地媒体控制
  // ==========================================================

  async setMicrophoneEnabled(enabled: boolean): Promise<void> {
    const room = this.requireRoom();
    try {
      await room.localParticipant.setMicrophoneEnabled(enabled);
    } catch (err) {
      throw this.reportError(err);
    }
    this.syncLocalState();
  }

  async setCameraEnabled(enabled: boolean): Promise<void> {
    const room = this.requireRoom();
    // ⚠️ provider を呼ぶ**前**に意図を更新する。呼んだ後だと、その最中に走った
    // 点検（Ended / 前面復帰）が古い意図を読んで「ユーザーはオンにしたいはず」と
    // 誤判定し、ユーザーが今まさに切ったカメラを点け直しかねない。
    this.cameraIntent = enabled;
    try {
      await room.localParticipant.setCameraEnabled(
        enabled,
        enabled ? { resolution: LAYER_720P.resolution } : undefined,
      );
    } catch (err) {
      throw this.reportError(err);
    }
    this.syncLocalState();
    // 关摄像头时 `stopLocalTrackOnUnpublish: true` 会把 LocalVideoTrack 停掉，
    // LiveKit 在 `LocalTrack.stop()` 里顺手 destroy 了 processor；重开则是**一条新 track**。
    // 所以这里必须重挂（await：让调用方的 promise 覆盖到效果真正生效）。
    await this.reapplyBackgroundEffect();
  }

  async switchAudioDevice(deviceId: string): Promise<void> {
    await this.switchDevice('audioinput', deviceId);
  }

  async switchVideoDevice(deviceId: string): Promise<void> {
    await this.switchDevice('videoinput', deviceId);
  }

  /**
   * 扬声器选择。Safari / iOS 全系不支持 `HTMLMediaElement.setSinkId`，
   * 按 §3.2 的接口注释**静默忽略**（不报错、不抛异常，UI 照常显示选择器）。
   */
  async setAudioOutputDevice(deviceId: string): Promise<void> {
    const room = this.room;
    if (!room) return;
    if (!supportsAudioOutputSelection()) return;
    try {
      await room.switchActiveDevice('audiooutput', deviceId);
    } catch (err) {
      // DeviceUnsupportedError = 浏览器不支持 → 同样静默；其余错误正常上报
      if (
        err instanceof Error &&
        (err.name === 'DeviceUnsupportedError' || err.name === 'NotSupportedError')
      ) {
        return;
      }
      throw this.reportError(err);
    }
  }

  // ==========================================================
  // 渲染绑定（§12.6：attach / detach 必须成对，且幂等）
  // ==========================================================

  attachLocalVideo(el: HTMLVideoElement): void {
    this.detachLocalVideo();
    this.localVideoEl = el;
    const track = this.localCameraTrack();
    if (track) {
      track.attach(el);
      this.localVideoTrack = track;
    }
    // 没有 track 时只登记元素：等 LocalTrackPublished 到达再补挂
  }

  detachLocalVideo(): void {
    const el = this.localVideoEl;
    this.localVideoEl = undefined;
    const track = this.localVideoTrack;
    this.localVideoTrack = undefined;
    if (!el) return;
    track?.detach(el);
    el.srcObject = null;
  }

  attachRemoteVideo(id: ParticipantId, el: HTMLVideoElement): void {
    // 先清掉同 id 的旧登记，避免一个参与者被挂到两个元素上（切换布局时很常见）
    this.detachRemoteVideo(id);
    const binding: RemoteVideoBinding = { el };
    this.remoteVideo.set(id, binding);

    const track = this.remoteCameraTrack(id);
    if (track) {
      track.attach(el);
      binding.track = track;
    }
    // track 还没订阅到 → 只登记；TrackSubscribed 时自动补挂（见 handleTrackSubscribed）
  }

  detachRemoteVideo(id: ParticipantId): void {
    const binding = this.remoteVideo.get(id);
    if (!binding) return;
    this.remoteVideo.delete(id);
    binding.track?.detach(binding.el);
    binding.el.srcObject = null;
  }

  // ==========================================================
  // 聊天（文件头 6）
  // ==========================================================

  /**
   * 发送一条聊天消息，返回本地回显用的完整消息体。
   *
   * 失败路径**只 reject、不 emit `error`**：聊天失败是一次局部操作的失败（重连中、
   * 权限不足），由发起这次发送的 UI 自己用 toast 说明并保留输入框内容即可；
   * 走全局 `error` 事件会让会议顶部弹出与聊天无关的「媒体错误」横幅，反而误导。
   */
  async sendChatMessage(text: string): Promise<ChatMessage> {
    const room = this.requireRoom();
    // 重连中 room 对象还在，但 DataChannel 已经不通 → 明确失败，别让消息静默蒸发
    if (room.state !== ConnectionState.Connected) {
      throw new LiveKitMediaError('CONNECT_FAILED', `cannot send chat while ${room.state}`);
    }

    const normalized = normalizeOutgoingChatText(text);
    if (!normalized.ok) {
      throw new LiveKitMediaError(
        'UNKNOWN',
        normalized.reason === 'empty'
          ? 'chat message is empty'
          : `chat message exceeds ${MAX_CHAT_TEXT_LENGTH} characters`,
      );
    }

    let sent: { id: string; message: string; timestamp: number };
    try {
      sent = await room.localParticipant.sendChatMessage(normalized.text);
    } catch (err) {
      throw classifyError(err, 'UNKNOWN');
    }

    const identity = room.localParticipant.identity;
    const name = room.localParticipant.name?.trim() || this.displayName.trim() || identity;
    return {
      id: sent.id,
      senderIdentity: identity,
      senderName: name,
      text: sent.message,
      timestamp: sent.timestamp,
    };
  }

  /** `RoomEvent.ChatMessage` → `chatMessageReceived`（只放行远端，见文件头 6） */
  private handleChatMessage(raw: unknown, participant?: LkChatSenderView): void {
    // participant 缺席 = 发送者已不在房间/无法归属 → 丢弃（不显示「幽灵发言人」）
    if (!participant || participant.isLocal) return;
    this.chatFallbackSeq += 1;
    const message = toChatMessage(
      raw,
      { identity: participant.identity, name: participant.name },
      { id: `chat-${participant.identity}-${Date.now()}-${this.chatFallbackSeq}`, timestamp: Date.now() },
    );
    if (!message) return;
    this.emitter.emit('chatMessageReceived', message);
  }

  // ==========================================================
  // 背景效果（文件头 7）
  // ==========================================================

  /**
   * 同步能力检测。第一段判据（自实现探针，不加载库）——见 ./background.ts §5 的取舍说明。
   * 结果缓存：webgl2 那一项要真建一次 canvas 上下文，不适合每次渲染都算。
   */
  isBackgroundEffectSupported(): boolean {
    if (this.backgroundSupport === undefined) {
      this.backgroundSupport = computeBackgroundSupport(probeBackgroundCapabilities());
    }
    return this.backgroundSupport;
  }

  /**
   * 设置背景效果。契约见 types.ts 的 FR-7 扩展块，这里只补实现侧的两条决定：
   *
   * - **摄像头关着时不报错**：效果被记下，等摄像头开启/换设备时自动挂上。
   *   （UI 常见流程就是在 pre-join 或关着摄像头时先挑背景。）
   * - **失败一律退回 `none`**：挂到一半炸了（WebGL 上下文丢失、图片载不进来、
   *   wasm 404）就把整条管线拆掉，保证摄像头本身还能用；错误 reject 给调用方，
   *   由 UI 回滚选中态。不做"退回上一个效果"——状态机越简单越不容易骗人。
   */
  async setBackgroundEffect(effect: BackgroundEffect): Promise<void> {
    const normalized = normalizeBackgroundEffect(effect);
    if (!normalized.ok) {
      throw new LiveKitMediaError('UNKNOWN', normalized.message);
    }
    const next = normalized.effect;

    // 「关掉效果」在任何环境下都成立（不支持的浏览器本来就没挂东西），
    // 所以只对真正要起管线的 blur / image 做能力闸。
    if (next.type !== 'none' && !this.isBackgroundEffectSupported()) {
      throw new LiveKitMediaError(
        'UNKNOWN',
        'background effects are not supported in this browser ' +
          '(requires WebGL2 + WebCodecs VideoFrame + OffscreenCanvas)',
      );
    }

    await this.enqueueBackgroundTask(async () => {
      try {
        await this.applyBackgroundEffect(next);
      } catch (err) {
        await this.teardownBackgroundProcessor();
        this.backgroundEffect = noBackgroundEffect();
        this.syncLocalState();
        throw classifyError(err, 'UNKNOWN');
      }
      this.backgroundEffect = next;
      this.syncLocalState();
    });
  }

  /**
   * 把 `next` 真正挂到当前摄像头 track 上。**只允许在 backgroundQueue 内调用**。
   * 单一职责：不改 `this.backgroundEffect`、不 emit —— 那是调用方的事。
   */
  private async applyBackgroundEffect(next: NormalizedBackgroundEffect): Promise<void> {
    const track = this.localCameraVideoTrack();
    const processor = this.backgroundProcessor;
    // 决策本身是纯函数（./background.ts），可在 node 环境单测
    const plan = planBackgroundApply({
      hasCameraTrack: track !== undefined,
      processorAttachedToCurrentTrack:
        processor !== undefined && this.backgroundProcessorTrack === track,
      effect: next,
    });

    // 同一条 track 上换模式 → switchTo：不重建管线、不重载分割模型，也就没有切换残影
    if (plan.action === 'switch' && processor) {
      await processor.switchTo(plan.options);
      return;
    }

    // 没有摄像头 track（关着 / 未连接 / 已断开）→ 无处可挂。
    // 效果值仍由调用方记住，等 track 出现时 reapply 补上。
    if (plan.action === 'teardown' || !track) {
      await this.teardownBackgroundProcessor();
      return;
    }

    // 换了 track（摄像头重开）或首次启用 → 拆旧建新。
    //
    // 注意这里**直接按目标模式构造**，没有照搬库 README 的「先建 disabled 再 switchTo」：
    // 那条建议的前提是 processor 常驻、靠 switchTo 开关效果，好处是切换无残影；
    // 我们的取舍相反——`none` 时坚决不留管线（会议场景下这条 CPU/GPU 开销不小，
    // 40 Mbps 的机器上更不该白烧），代价是 none→blur 要重建一次。
    // 既然要重建，直接进目标模式反而少一帧未处理的画面（隐私上也更稳妥）。
    // ⚠️ 已知残留：库的 BackgroundTransformer 首帧会先 enqueue 一份原始帧作为过渡，
    //    所以严格说仍有 1 帧真实背景会发出去——这是库的行为，无法从这里消除。
    await this.teardownBackgroundProcessor();
    // 読み込みは ./track-processors-loader.ts に集約（prejoin プレビューと共有）。
    const mod = await loadTrackProcessors();
    const created = createBackgroundProcessor(mod, next, () => {
      // 心跳。ここを通っている限りフレームは流れている（watchdog の唯一の正向信号）。
      this.lastProcessedFrameAt = Date.now();
    });
    await track.setProcessor(created);
    this.backgroundProcessor = created;
    this.backgroundProcessorTrack = track;
    // canvas / processedTrack は init（＝setProcessor の中）を通って初めて生えるので、
    // 監視を張るのは必ず setProcessor の**後**。
    this.armProcessorProbes(created);
  }

  /**
   * 摄像头 track 变化后把当前效果重新挂上（关→开、切设备、重连）。
   *
   * **永不 reject**：这是 provider 的自动行为，没有调用方能接住错误。
   * 失败就退回无效果 + emit `error`，让 UI 有机会提示"背景已关闭"。
   */
  private async reapplyBackgroundEffect(): Promise<void> {
    // 无效果且无残留管线 → 完全没事可做，别白排一次队
    if (this.backgroundEffect.type === 'none' && !this.backgroundProcessor) return;
    await this.enqueueBackgroundTask(async () => {
      try {
        await this.applyBackgroundEffect(this.backgroundEffect);
      } catch (err) {
        await this.teardownBackgroundProcessor();
        this.backgroundEffect = noBackgroundEffect();
        this.syncLocalState();
        this.emitter.emit('error', classifyError(err, 'UNKNOWN'));
      }
    });
  }

  /** 拆掉 processor 并清引用。幂等，且对"track 已被 stop"的情况安全。 */
  private async teardownBackgroundProcessor(): Promise<void> {
    // 監視を先に外す：この後 processedTrack.stop() が走るので、外さないと
    // 自分で起こした 'ended' を「管線が死んだ」と誤検知して復旧ループに入る。
    this.disarmProcessorProbes();
    // 回退到当前摄像头 track：能兜住"setProcessor 挂到一半失败"时引用还没记上的情况
    const target = this.backgroundProcessorTrack ?? this.localCameraVideoTrack();
    this.backgroundProcessor = undefined;
    this.backgroundProcessorTrack = undefined;
    if (!target) return;
    try {
      // track 上没有 processor 时 SDK 会直接 return，所以无条件调用是安全的
      await target.stopProcessor();
    } catch {
      // track 已 stop（LiveKit 在 LocalTrack.stop() 里已经 destroy 过 processor）
      // 或管线本身已崩 —— 两种情况都没有后续动作可做，吞掉即可。
    }
  }

  /**
   * 背景操作串行队列。UI 连点背景卡片时 setProcessor / switchTo 交叠会把管线搞坏，
   * 这里排成一条链。单次失败**不毒死队列**（队列只保留已吞错的版本），
   * 错误照常透传给发起这次操作的调用方。
   */
  private enqueueBackgroundTask(task: () => Promise<void>): Promise<void> {
    const run = this.backgroundQueue.then(task, task);
    this.backgroundQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** 当前本地摄像头 track。比 `localCameraTrack()` 的返回类型更具体（processor API 在 LocalVideoTrack 上） */
  private localCameraVideoTrack(): LocalVideoTrack | undefined {
    return this.room?.localParticipant.getTrackPublication(Track.Source.Camera)?.videoTrack;
  }

  // ==========================================================
  // 内部：カメラ／背景管線の自己修復（文件头 8）
  // ==========================================================

  /**
   * 前面復帰の監視を張る。**provider 側に置く**のは、UI からは判定に必要な材料
   * （トラックの readyState・native muted・publication の mute）が一切見えないから
   * ——`lib/media/types.ts` は凍結されていて「カメラの健康状態を問い合わせる」API を
   * 足せない。UI に残る責務はトーストとボタン表示だけ（RoomExperience）。
   *
   * `visibilitychange` に加えて `pageshow` も見るのは、iOS Safari の bfcache 復帰が
   * visibilitychange を伴わないことがあるため。
   */
  private armLifecycleWatchers(): void {
    if (!isBrowser()) return;
    this.disarmLifecycleWatchers();

    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      // 即断しない：ブラウザが自力で unmute するのを待ってから点検する
      //（待たずに再取得すると、放っておけば直るものを黒くしてしまう）。
      this.scheduleHealthCheck('resume', CAMERA_RESUME_SETTLE_MS);
    };
    document.addEventListener('visibilitychange', onVisible);
    this.lifecycleCleanups.push(() => document.removeEventListener('visibilitychange', onVisible));

    if (typeof window !== 'undefined') {
      const onPageShow = () => this.scheduleHealthCheck('resume', CAMERA_RESUME_SETTLE_MS);
      window.addEventListener('pageshow', onPageShow);
      this.lifecycleCleanups.push(() => window.removeEventListener('pageshow', onPageShow));
    }
  }

  private disarmLifecycleWatchers(): void {
    for (const cleanup of this.lifecycleCleanups.splice(0)) cleanup();
  }

  /**
   * カメラのソーストラックに `TrackEvent.Ended` を張る。
   *
   * ⚠️ このイベントは **ソースの `MediaStreamTrack` が ended になったときだけ** 上がる
   * （livekit-client は processedTrack には 'ended' を張っていない）。つまり
   * 「ブラウザ/OS にカメラを止められた」の専用シグナルであって、背景管線の故障は
   * ここには来ない——そちらは armProcessorProbes 側の担当。
   */
  private watchCameraTrack(track: LocalTrack): void {
    if (this.watchedCameraTrack === track) return;
    this.unwatchCameraTrack();
    this.watchedCameraTrack = track;
    track.on(TrackEvent.Ended, this.handleLocalTrackEnded);
  }

  private unwatchCameraTrack(): void {
    const track = this.watchedCameraTrack;
    this.watchedCameraTrack = undefined;
    track?.off(TrackEvent.Ended, this.handleLocalTrackEnded);
  }

  /** アロー関数プロパティ：off() で同一参照を渡せるようにする（外し忘れ＝リーク） */
  private readonly handleLocalTrackEnded = (): void => {
    this.scheduleHealthCheck('track-event', CAMERA_ENDED_SETTLE_MS);
  };

  private scheduleHealthCheck(phase: CameraHealthPhase, delayMs: number): void {
    this.cancelHealthCheck();
    this.healthCheckTimer = setTimeout(() => {
      this.healthCheckTimer = undefined;
      void this.runCameraHealthCheck(phase);
    }, delayMs);
  }

  private cancelHealthCheck(): void {
    if (this.healthCheckTimer !== undefined) clearTimeout(this.healthCheckTimer);
    this.healthCheckTimer = undefined;
  }

  /**
   * カメラの死活点検 → 必要なら再取得。判定そのものは純関数（./camera-health.ts）で、
   * ここは**材料を集めて結果に従うだけ**。
   *
   * ⚠️ 材料集めに一つ罠がある：`LocalTrack.mediaStreamTrack` は processor が付いていると
   * **処理後のトラック（MediaStreamTrackGenerator）を返す**（livekit-client の getter 実装）。
   * それを readyState 判定に使うとカメラではなく管線の状態を見てしまうので、
   * 「公開 getter が processedTrack と同一なら、ソースは覗けない（undefined）」と扱う。
   * 覗けないときは ended 判定を諦める＝**何もしない側に倒れる**（誤検知しない側、が常に優先）。
   * ソースが死んだ場合は結局 `TrackEvent.Ended` が上がるので、取りこぼしは実質ない。
   */
  private async runCameraHealthCheck(phase: CameraHealthPhase): Promise<void> {
    if (this.cameraRecovering) return;
    const room = this.room;
    const publication = room?.localParticipant.getTrackPublication(Track.Source.Camera);
    const track = publication?.videoTrack;
    const source = this.sourceMediaTrack(track);

    const decision = decideCameraHealth({
      phase,
      connected: room?.state === ConnectionState.Connected,
      desiredEnabled: this.cameraIntent,
      hasCameraTrack: track !== undefined,
      publicationMuted: publication?.isMuted ?? false,
      readyState: source === undefined ? undefined : source.readyState === 'ended' ? 'ended' : 'live',
      browserMuted: source?.muted ?? false,
      lastAttemptAt: this.cameraRecoveryAt,
      now: Date.now(),
    });
    if (decision.action !== 'restart') return;
    await this.restartCamera();
  }

  /** processor が付いていて覗けない場合は undefined（上のコメント参照）。 */
  private sourceMediaTrack(track: LocalVideoTrack | undefined): MediaStreamTrack | undefined {
    if (!track) return undefined;
    const exposed = track.mediaStreamTrack;
    const processed = track.getProcessor()?.processedTrack;
    return exposed && exposed === processed ? undefined : exposed;
  }

  /**
   * カメラを取り直す。`setCameraEnabled(false) → (true)` の素直な往復——
   * `stopLocalTrackOnUnpublish: true` なので前者で確実に古いトラックが停止し、
   * 後者が新しい `getUserMedia` を引く。背景効果は `setCameraEnabled` 内の
   * `reapplyBackgroundEffect()` が新しいトラックへ載せ直す（＝ここで別途面倒を見ない）。
   *
   * **失敗しても throw しない**：これは誰も待っていない自動処理。失敗の伝え方は
   *   - `videoEnabled` が false のまま確定する → UI のカメラボタンが「オフ」表示になる
   *   - `error` を emit する → UI がエラーバナー／トーストを出す
   * の 2 本立てで、**黙って黒いまま**にはしない（文件头 8 の鉄則）。
   */
  private async restartCamera(): Promise<void> {
    const room = this.room;
    if (!room || this.cameraRecovering) return;
    this.cameraRecovering = true;
    this.cameraRecoveryAt = Date.now();
    try {
      await room.localParticipant.setCameraEnabled(false);
      // ここで意図が変わっていたら（点検中にユーザーが自分でカメラを切った）中止する。
      // 何より優先するのは「ユーザーが切ったカメラを点け直さない」こと。
      if (!this.cameraIntent) return;
      await room.localParticipant.setCameraEnabled(true, { resolution: LAYER_720P.resolution });
    } catch (err) {
      this.emitter.emit('error', classifyError(err, 'DEVICE_NOT_FOUND'));
    } finally {
      this.cameraRecovering = false;
      this.syncLocalState();
      // setCameraEnabled を room.localParticipant 経由で直に叩いた（＝public API の
      // setCameraEnabled を通っていない）ので、背景の載せ直しはここで明示的に行う。
      await this.reapplyBackgroundEffect();
    }
  }

  /**
   * 背景処理管線の**運行期**監視を張る（文件头 8 の (c)）。
   *
   * ライブラリ 0.7.2 が運行期エラーを外に出さないので、こちらから 3 点計測する。
   * 3 つ**すべて**必要なのは、故障の種類ごとに症状がまったく違うため：
   *
   *   - **MediaPipe の例外**（セグメンテーション失敗）→ そのフレームは enqueue されず、
   *     画面は最後のフレームで**凍結**。processedTrack は live のまま。
   *     → 捕まえられるのは `onFrameProcessed` の心跳が止まることだけ。
   *   - **WebGL コンテキストロスト** → gl 呼び出しが no-op 化して canvas が空になり、
   *     **真っ黒なフレームが正常に流れ続ける**。心跳は止まらない（＝watchdog は無力）。
   *     → canvas の `webglcontextlost` を張るしかない。ライブラリは張っていない。
   *   - **pipe 層の致命的エラー**（稀）→ ライブラリが内部で destroy し、
   *     processedTrack が ended になる。LiveKit はこのトラックに 'ended' を張っていない。
   *     → 自分で張る。
   */
  private armProcessorProbes(processor: BackgroundProcessorHandle): void {
    this.disarmProcessorProbes();
    const onFailure = (reason: string) => () => {
      void this.recoverBackgroundPipeline(reason);
    };

    const canvas = processor.canvas;
    if (canvas && typeof canvas.addEventListener === 'function') {
      const handler = onFailure('webgl_context_lost');
      // preventDefault() は**あえて呼ばない**：呼ぶと webglcontextrestored 経由の
      // 復帰を期待することになるが、ライブラリは restore を待ち受けていないので
      // 復帰しても管線は死んだまま。こちらで作り直す方が確実。
      canvas.addEventListener('webglcontextlost', handler);
      this.processorProbeCleanups.push(() => canvas.removeEventListener('webglcontextlost', handler));
    }

    const processed = processor.processedTrack;
    if (processed && typeof processed.addEventListener === 'function') {
      const handler = onFailure('processed_track_ended');
      processed.addEventListener('ended', handler);
      this.processorProbeCleanups.push(() => processed.removeEventListener('ended', handler));
    }

    this.lastProcessedFrameAt = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - this.lastProcessedFrameAt < PROCESSOR_FRAME_STALL_MS) return;
      // 心跳が止まった。次の判定まで無駄撃ちしないよう、時計を進めてから撃つ。
      this.lastProcessedFrameAt = Date.now();
      void this.recoverBackgroundPipeline('frames_stalled');
    }, PROCESSOR_WATCHDOG_INTERVAL_MS);
    this.processorProbeCleanups.push(() => clearInterval(timer));
  }

  private disarmProcessorProbes(): void {
    for (const cleanup of this.processorProbeCleanups.splice(0)) cleanup();
  }

  /**
   * 背景管線が死んだときの立て直し。**カメラ本体には触らない**——管線だけを作り直す。
   *
   * 一度目は効果を保ったまま再構築する（コンテキストロストは GPU リセット等で
   * 一過性のことが多く、作り直せば直る）。同じ窓の中で繰り返すなら管線が犯人と見て、
   * `{ type: 'none' }` に落として**カメラだけは生かす**（判定は
   * ./camera-health.ts の shouldDropBackgroundEffect）。落としたことは
   * `localStateChanged`（backgroundEffect が none になる）と `error` の両方で外に出す
   * ——UI は前者で選択状態を戻し、後者でトーストを出す。黙って効果が消えることはない。
   */
  private async recoverBackgroundPipeline(reason: string): Promise<void> {
    if (this.backgroundEffect.type === 'none' || !this.backgroundProcessor) return;

    const now = Date.now();
    this.pipelineRecoveryAttempts = pruneRecoveryAttempts(this.pipelineRecoveryAttempts, now);
    const last = this.pipelineRecoveryAttempts[this.pipelineRecoveryAttempts.length - 1];
    if (last !== undefined && now - last < PIPELINE_RECOVERY_THROTTLE_MS) return;
    this.pipelineRecoveryAttempts.push(now);

    const drop = shouldDropBackgroundEffect({
      backgroundActive: true,
      recentAttempts: this.pipelineRecoveryAttempts.length,
    });

    await this.enqueueBackgroundTask(async () => {
      if (drop) {
        await this.fallbackToNoBackground(
          new LiveKitMediaError('UNKNOWN', `background pipeline failed repeatedly (${reason}); effect disabled`),
        );
        return;
      }
      try {
        await this.teardownBackgroundProcessor();
        await this.applyBackgroundEffect(this.backgroundEffect);
      } catch (err) {
        await this.fallbackToNoBackground(classifyError(err, 'UNKNOWN'));
      }
    });
  }

  /** 効果を捨てて none に確定させ、UI に両チャネルで伝える。**backgroundQueue の中でのみ呼ぶ**。 */
  private async fallbackToNoBackground(error: MediaError): Promise<void> {
    await this.teardownBackgroundProcessor();
    this.backgroundEffect = noBackgroundEffect();
    this.syncLocalState();
    this.emitter.emit('error', error);
  }

  // ==========================================================
  // 查询
  // ==========================================================

  getParticipants(): RemoteParticipant[] {
    const room = this.room;
    if (!room) return [];
    return [...room.remoteParticipants.values()].map((p) => toRemoteParticipant(p));
  }

  getLocalState(): LocalState {
    return { ...this.localState };
  }

  /**
   * 连接质量采样（§6.4 每 30 秒上报一次；WP-3 验收用它验证 AdaptiveStream 生效）。
   *
   * 做法：把本地已发布 + 远端已订阅的每条 track 的 `getRTCStatsReport()` 拉回来拍平，
   * 交给 `collectStatsSnapshot` 做纯聚合（去重、单位换算），再与**上一次采样**求差
   * 得到瞬时码率与窗口丢包率。取不到数据的字段一律给 0，不做任何估算/伪造。
   * 首次调用没有基线，故 in/outboundKbps 必然为 0 —— 这是有意为之，
   * 调用方按 §6.4 每 30 秒轮询一次，第二次起就有真实值。
   */
  async getStats(): Promise<ConnectionStats> {
    const room = this.room;
    if (!room) return emptyConnectionStats();

    const pending: Promise<RTCStatsReport | undefined>[] = [];
    for (const pub of room.localParticipant.trackPublications.values()) {
      const track = pub.track;
      if (track && isLocalTrack(track)) {
        pending.push(track.getRTCStatsReport().catch(() => undefined));
      }
    }
    for (const participant of room.remoteParticipants.values()) {
      for (const pub of participant.trackPublications.values()) {
        const track = pub.track;
        if (track && isRemoteTrack(track)) {
          pending.push(track.getRTCStatsReport().catch(() => undefined));
        }
      }
    }
    if (pending.length === 0) return emptyConnectionStats();

    const entries: RtcStatLike[] = [];
    for (const report of await Promise.all(pending)) {
      report?.forEach((stat) => {
        entries.push(stat as RtcStatLike);
      });
    }

    const snapshot = collectStatsSnapshot(entries);
    const stats = computeConnectionStats(snapshot, this.prevStats);
    this.prevStats = snapshot;
    return stats;
  }

  // ==========================================================
  // 事件订阅
  // ==========================================================

  on<K extends keyof MediaProviderEvents>(e: K, cb: MediaProviderEvents[K]): void {
    this.emitter.on(e, cb);
  }

  off<K extends keyof MediaProviderEvents>(e: K, cb: MediaProviderEvents[K]): void {
    this.emitter.off(e, cb);
  }

  // ==========================================================
  // 内部：事件映射（RoomEvent → MediaProviderEvents）
  // ==========================================================

  private bindRoomEvents(room: Room): void {
    room
      // ---- 连接生命周期 ----
      .on(RoomEvent.Connected, () => {
        this.syncLocalState();
        this.emitter.emit('connected');
      })
      .on(RoomEvent.Disconnected, (reason) => {
        const serverError = classifyDisconnect(reason);
        if (serverError) this.emitter.emit('error', serverError);
        // 断开即拆挂载，但**保留元素登记**：重连/重进时能自动补挂（见 reattachAll）
        this.detachAllMedia(false);
        this.disarmAudioUnlockGesture();
        this.emitter.emit('disconnected', disconnectReasonText(reason));
      })
      .on(RoomEvent.Reconnecting, () => {
        this.emitter.emit('reconnecting');
      })
      .on(RoomEvent.Reconnected, () => {
        this.reattachAll();
        this.syncLocalState();
        // §12.4：重连后 AudioContext 可能被挂起，重新确认一次
        this.ensureAudioPlayback();
        // 重连过程中本地轨可能被重新采集/重新发布 → 背景效果也复查一次（无效果时零成本）
        void this.reapplyBackgroundEffect();
        this.emitter.emit('reconnected');
      })

      // ---- 远端参与者 ----
      .on(RoomEvent.ParticipantConnected, (p) => {
        this.emitter.emit('participantJoined', toRemoteParticipant(p));
      })
      .on(RoomEvent.ParticipantDisconnected, (p) => {
        this.detachRemoteVideo(p.identity);
        this.speakingIds.delete(p.identity);
        this.emitter.emit('participantLeft', p.identity);
      })

      // ---- 远端状态变化 → participantUpdated ----
      .on(RoomEvent.TrackPublished, (_pub, p) => this.emitParticipantUpdated(p))
      .on(RoomEvent.TrackUnpublished, (_pub, p) => this.emitParticipantUpdated(p))
      .on(RoomEvent.TrackMuted, (_pub, p) => this.handleMuteChanged(p))
      .on(RoomEvent.TrackUnmuted, (_pub, p) => this.handleMuteChanged(p))
      .on(RoomEvent.ConnectionQualityChanged, (_quality, p) => {
        if (!p.isLocal) this.emitParticipantUpdated(p);
      })

      // ---- 订阅 / 取消订阅：挂载表的自动补挂与拆挂 ----
      .on(RoomEvent.TrackSubscribed, (track, pub, p) => {
        if (pub.source === Track.Source.Camera && track.kind === Track.Kind.Video) {
          this.bindSubscribedVideo(p.identity, track);
        } else if (track.kind === Track.Kind.Audio) {
          this.playRemoteAudio(track);
        }
        this.emitParticipantUpdated(p);
      })
      .on(RoomEvent.TrackUnsubscribed, (track, pub, p) => {
        if (pub.source === Track.Source.Camera && track.kind === Track.Kind.Video) {
          this.unbindSubscribedVideo(p.identity, track);
        } else if (track.kind === Track.Kind.Audio) {
          this.stopRemoteAudio(track);
        }
        this.emitParticipantUpdated(p);
      })

      // ---- 活跃发言者 ----
      .on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
        this.handleActiveSpeakers(speakers);
      })

      // ---- 本地轨与设备 ----
      .on(RoomEvent.LocalTrackPublished, (pub) => {
        if (pub.source === Track.Source.Camera && pub.track) {
          // カメラが（再）発行されるたびに死活監視を張り直す。restart で
          // トラックオブジェクト自体が変わることもあるので、毎回登録し直すのが正しい。
          this.watchCameraTrack(pub.track);
        }
        if (pub.source === Track.Source.Camera && this.localVideoEl && pub.track) {
          pub.track.attach(this.localVideoEl);
          this.localVideoTrack = pub.track;
        }
        this.syncLocalState();
      })
      .on(RoomEvent.LocalTrackUnpublished, (pub) => {
        if (pub.source === Track.Source.Camera) this.unwatchCameraTrack();
        if (pub.source === Track.Source.Camera && this.localVideoEl) {
          // unpublish 时 pub.track 可能已被置空，退回自己登记的那条，确保一定拆干净
          (pub.track ?? this.localVideoTrack)?.detach(this.localVideoEl);
          this.localVideoTrack = undefined;
          // 关摄像头后清掉最后一帧，别让画面冻在那儿
          this.localVideoEl.srcObject = null;
        }
        this.syncLocalState();
      })
      .on(RoomEvent.ActiveDeviceChanged, () => {
        this.syncLocalState();
      })
      .on(RoomEvent.MediaDevicesError, (err) => {
        this.emitter.emit('error', classifyError(err, 'DEVICE_NOT_FOUND'));
      })

      // ---- 聊天（文件头 6）----
      .on(RoomEvent.ChatMessage, (message, participant) => {
        this.handleChatMessage(message, participant);
      })

      // ---- iOS Safari 音频策略（§12.4）----
      .on(RoomEvent.AudioPlaybackStatusChanged, (playing) => {
        if (!playing) this.armAudioUnlockGesture();
      });
  }

  /** TrackMuted / TrackUnmuted 对本地和远端都会触发，分流到两条路径 */
  private handleMuteChanged(participant: LkParticipantView): void {
    if (participant.isLocal) {
      this.syncLocalState();
    } else {
      this.emitParticipantUpdated(participant);
    }
  }

  private emitParticipantUpdated(participant: ParticipantLike): void {
    this.emitter.emit('participantUpdated', toRemoteParticipant(participant));
  }

  /**
   * ActiveSpeakersChanged → activeSpeakersChanged + 说话状态变化的 participantUpdated。
   *
   * 说明：`IsSpeakingChanged` 是 **ParticipantEvent**（Room 层没有同名事件）。
   * Room 在派发 ActiveSpeakersChanged 之前已经把各参与者的 `isSpeaking` 更新好了，
   * 所以这里由它统一派生 participantUpdated —— 等价效果，且不必给每个远端参与者
   * 单独挂监听器（那种做法的清理成本正是 §12.6 想避免的泄漏来源）。
   */
  private handleActiveSpeakers(speakers: readonly SpeakerLike[]): void {
    const ids = sortSpeakerIds(speakers);
    this.emitter.emit('activeSpeakersChanged', ids);

    const next = new Set(ids);
    const changed = new Set<ParticipantId>();
    for (const id of next) if (!this.speakingIds.has(id)) changed.add(id);
    for (const id of this.speakingIds) if (!next.has(id)) changed.add(id);
    this.speakingIds = next;

    const room = this.room;
    if (!room) return;
    for (const id of changed) {
      const participant = room.remoteParticipants.get(id);
      if (participant) this.emitParticipantUpdated(participant);
    }
  }

  // ==========================================================
  // 内部：挂载表维护
  // ==========================================================

  private bindSubscribedVideo(id: ParticipantId, track: Track): void {
    const binding = this.remoteVideo.get(id);
    if (!binding) return; // UI 还没 attach，等它来取
    if (binding.track === track) return;
    binding.track?.detach(binding.el);
    track.attach(binding.el);
    binding.track = track;
  }

  private unbindSubscribedVideo(id: ParticipantId, track: Track): void {
    const binding = this.remoteVideo.get(id);
    if (!binding || binding.track !== track) return;
    track.detach(binding.el);
    binding.track = undefined;
    // 元素登记保留：AdaptiveStream 会在元素重新可见时再订阅回来
  }

  /** 重连后按当前订阅状态把登记过的元素重新挂一遍 */
  private reattachAll(): void {
    for (const [id, binding] of this.remoteVideo) {
      const track = this.remoteCameraTrack(id);
      if (track && track !== binding.track) {
        binding.track?.detach(binding.el);
        track.attach(binding.el);
        binding.track = track;
      }
    }
    const localTrack = this.localCameraTrack();
    if (this.localVideoEl && localTrack && localTrack !== this.localVideoTrack) {
      this.localVideoTrack?.detach(this.localVideoEl);
      localTrack.attach(this.localVideoEl);
      this.localVideoTrack = localTrack;
    }
  }

  /**
   * @param clearRegistrations true = 连元素登记一起清（显式 disconnect）；
   *        false = 只拆 track、保留元素登记（服务端断开，之后可能重连补挂）
   */
  private detachAllMedia(clearRegistrations: boolean): void {
    for (const [id, binding] of [...this.remoteVideo]) {
      binding.track?.detach(binding.el);
      binding.track = undefined;
      if (clearRegistrations) {
        binding.el.srcObject = null;
        this.remoteVideo.delete(id);
      }
    }
    for (const [sid, el] of [...this.remoteAudioEls]) {
      el.srcObject = null;
      el.remove();
      this.remoteAudioEls.delete(sid);
    }
    if (this.localVideoEl) {
      this.localVideoTrack?.detach(this.localVideoEl);
      this.localVideoTrack = undefined;
      if (clearRegistrations) {
        this.localVideoEl.srcObject = null;
        this.localVideoEl = undefined;
      }
    }
  }

  private remoteCameraTrack(id: ParticipantId): Track | undefined {
    return this.room?.remoteParticipants.get(id)?.getTrackPublication(Track.Source.Camera)
      ?.videoTrack;
  }

  private localCameraTrack(): Track | undefined {
    return this.room?.localParticipant.getTrackPublication(Track.Source.Camera)?.videoTrack;
  }

  // ==========================================================
  // 内部：远端音频播放（见文件头 3）
  // ==========================================================

  private playRemoteAudio(track: Track): void {
    if (!isBrowser()) return;
    const sid = track.sid;
    if (!sid || this.remoteAudioEls.has(sid)) return;
    // 无参 attach() 会新建一个 <audio> 并开始播放
    const el = track.attach();
    el.style.display = 'none';
    el.setAttribute('data-lk-remote-audio', sid);
    document.body.appendChild(el);
    this.remoteAudioEls.set(sid, el);
  }

  private stopRemoteAudio(track: Track): void {
    const sid = track.sid;
    if (!sid) return;
    const el = this.remoteAudioEls.get(sid);
    if (!el) return;
    this.remoteAudioEls.delete(sid);
    track.detach(el);
    el.srcObject = null;
    el.remove();
  }

  // ==========================================================
  // 内部：iOS 音频解锁（§12.4）
  // ==========================================================

  private ensureAudioPlayback(): void {
    const room = this.room;
    if (!room || room.canPlaybackAudio) return;
    room.startAudio().catch(() => {
      // 仍被浏览器策略拦住 → 挂手势监听等用户点一下
      this.armAudioUnlockGesture();
    });
  }

  private armAudioUnlockGesture(): void {
    if (!isBrowser() || this.audioUnlockHandler) return;
    const handler = () => {
      // 一次性：先摘监听再重试，避免用户连点导致重复 startAudio
      this.disarmAudioUnlockGesture();
      this.room?.startAudio().catch((err: unknown) => {
        this.emitter.emit('error', classifyError(err, 'UNKNOWN'));
      });
    };
    this.audioUnlockHandler = handler;
    document.addEventListener('click', handler, { capture: true });
    document.addEventListener('touchend', handler, { capture: true });
  }

  private disarmAudioUnlockGesture(): void {
    const handler = this.audioUnlockHandler;
    this.audioUnlockHandler = undefined;
    if (!handler || !isBrowser()) return;
    document.removeEventListener('click', handler, true);
    document.removeEventListener('touchend', handler, true);
  }

  // ==========================================================
  // 内部：本地状态与工具
  // ==========================================================

  private async enableLocalTrack(
    kind: 'microphone' | 'camera',
    deviceId: string | undefined,
  ): Promise<void> {
    const room = this.room;
    if (!room) return;
    try {
      if (kind === 'microphone') {
        await room.localParticipant.setMicrophoneEnabled(true, { deviceId });
      } else {
        await room.localParticipant.setCameraEnabled(true, {
          deviceId,
          resolution: LAYER_720P.resolution,
        });
      }
    } catch (err) {
      // 只报错不抛出：连接已建立，缺设备不该把人踢出会议（§7.5）
      this.emitter.emit('error', classifyError(err, 'UNKNOWN'));
    }
    // 入会时摄像头刚发布出来，若已有效果意图（provider 实例被复用的场景）就挂上。
    // 正常路径下 connect 时 backgroundEffect 必为 none（disconnect 会重置），这里是兜底。
    if (kind === 'camera') await this.reapplyBackgroundEffect();
  }

  private async switchDevice(kind: MediaDeviceKind, deviceId: string): Promise<void> {
    const room = this.requireRoom();
    try {
      await room.switchActiveDevice(kind, deviceId);
    } catch (err) {
      throw this.reportError(err);
    }
    this.syncLocalState();
    if (kind === 'videoinput') {
      // 换摄像头走的是 `LocalTrack.restart()` → `setMediaStreamTrack()`，SDK 会自己
      // `processor.restart()`，LocalVideoTrack 对象也不换——所以**通常**效果自动跟着走。
      // 仍然重挂一次：① 摄像头原本是关的（无 track）时，SDK 那条路径根本没跑；
      // ② 万一 SDK 换了实现，这里是唯一的兜底。同轨同模式时只是一次廉价的 switchTo。
      await this.reapplyBackgroundEffect();
    }
  }

  private syncLocalState(): void {
    const room = this.room;
    const next: LocalState = {
      audioEnabled: room?.localParticipant.isMicrophoneEnabled ?? false,
      videoEnabled: room?.localParticipant.isCameraEnabled ?? false,
      audioDeviceId: room?.getActiveDevice('audioinput'),
      videoDeviceId: room?.getActiveDevice('videoinput'),
      backgroundEffect: this.backgroundEffect,
    };
    const prev = this.localState;
    if (
      prev.audioEnabled === next.audioEnabled &&
      prev.videoEnabled === next.videoEnabled &&
      prev.audioDeviceId === next.audioDeviceId &&
      prev.videoDeviceId === next.videoDeviceId &&
      // backgroundEffect 是**对象**，不能跟其它字段一样用 ===：
      // normalize 每次都产出新对象，直接比引用会让每一次 syncLocalState
      //（静音、订阅变化、设备切换……）都白 emit 一次 localStateChanged。
      isSameBackgroundEffect(prev.backgroundEffect, next.backgroundEffect)
    ) {
      return;
    }
    this.localState = next;
    this.emitter.emit('localStateChanged', { ...next });
  }

  private requireRoom(): Room {
    const room = this.room;
    if (!room) {
      throw new LiveKitMediaError('UNKNOWN', 'not connected: call connect() first');
    }
    return room;
  }

  /** 分类 → 广播 error 事件 → 返回错误对象（调用方决定要不要 throw） */
  private reportError(err: unknown, fallback: Parameters<typeof classifyError>[1] = 'UNKNOWN') {
    const mediaError = classifyError(err, fallback);
    this.emitter.emit('error', mediaError);
    return mediaError;
  }

  /** 供调试/日志：当前入会昵称（权威值仍以 token 内的 name 为准，§7.3） */
  getDisplayName(): string {
    return this.displayName;
  }
}
