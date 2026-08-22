/**
 * 背景ぼかし / バーチャル背景の**纯逻辑层**（2026-08-13 FR-7）。
 *
 * 与 mapping.ts / chat.ts 同一条纪律：
 *   - **不 import `@livekit/track-processors`，连 `import type` 都不引**。
 *     该包的 .d.ts 依赖 `MediaStreamTrackProcessor` 等浏览器实验性全局（可选 peer
 *     `@types/dom-mediacapture-transform` 并未安装），更要紧的是——它是本任务里
 *     唯一需要**懒加载**的重包，纯逻辑层一旦引到它，静态依赖图就把它拽回 room chunk。
 *     所以这里只声明**结构视图**（`TrackProcessorsModuleLike`），运行时由 provider
 *     把 `await import(...)` 的真模块传进来。测试则传一个假模块，用同一条代码路径
 *     捕获构造参数——「大陆红线」的回归断言就钉在这上面。
 *   - 不在模块顶层碰 window / document / navigator，可在 vitest 的 node 环境直接单测
 *     （tests/media/background.test.ts）。唯一读全局的 `probeBackgroundCapabilities()`
 *     全程 `typeof` 守卫，在 node / SSR 下老实返回全 false。
 *
 * ============ 大陆访问红线（§8.1）============
 * `@livekit/track-processors` 的 `assetPaths` 若不传，库会退回两个**境外公共 CDN**：
 * wasm 运行时走 npm 的公共镜像 CDN，分割模型走 Google 的模型托管域——
 * 两者在大陆都不可达，后者更是 §8.1 明令禁止的那一类第三方资源
 * （域名字面量刻意不写进源码：scripts/check-china-safe.sh 是纯 grep，
 *  连注释里的示例都会被判为违规；要查原值请看 node_modules 里 BackgroundTransformer 的 init）。
 *
 * 因此**构造 BackgroundProcessor 时必须显式传 `assetPaths`**，指向本仓库
 * `public/mediapipe/` 下自托管的同源副本。这件事只允许经由本文件的
 * `createBackgroundProcessor()` 发生，别处不许自己 new——库默认值绝不能有机会生效。
 */
import {
  DEFAULT_BACKGROUND_BLUR_RADIUS,
  type BackgroundEffect,
} from '../../types';

// ============================================================
// 1. 自托管资产路径（唯一事实源，勿内联到别处）
// ============================================================

/**
 * MediaPipe 资产的**同源**路径。对应仓库内：
 *   - `public/mediapipe/wasm/`（@mediapipe/tasks-vision 0.10.14 的 wasm 文件集，从 npm 包内直拷）
 *   - `public/mediapipe/selfie_segmenter.tflite`（官方 selfie segmenter，249 KB）
 *
 * ⚠️ 这两个值是 §8.1 的合规点，改动前先想清楚：任何指向外部 CDN 的写法都会让
 * 大陆用户的背景功能直接卡死在初始化（而且是静默卡死，段错不明显）。
 * tests/media/background.test.ts 会断言它们恒为同源路径。
 */
export const MEDIAPIPE_ASSET_PATHS = Object.freeze({
  /** `FilesetResolver.forVisionTasks()` 的 wasm 目录（不带结尾斜杠，与库示例一致） */
  tasksVisionFileSet: '/mediapipe/wasm',
  /** `ImageSegmenter` 的模型文件 */
  modelAssetPath: '/mediapipe/selfie_segmenter.tflite',
});

/** 传给 `BackgroundProcessor(options, name)` 的第二参数，仅用于日志/调试定位。 */
export const BACKGROUND_PROCESSOR_NAME = 'openmeet-background';

/**
 * `blurRadius` 的允许区间。
 * 库内部会 `Math.floor(radius / 4)` 后作用在降采样纹理上，所以 10 已经是明显的虚化，
 * 30 是"几乎认不出背景"。再大只会白烧 GPU，对 40 Mbps 的会议没有收益。
 */
export const MIN_BACKGROUND_BLUR_RADIUS = 1;
export const MAX_BACKGROUND_BLUR_RADIUS = 30;

// ============================================================
// 2. imageUrl 校验（同源白名单）
// ============================================================

export type BackgroundImageUrlResult =
  | { ok: true; url: string }
  | { ok: false; reason: 'empty' | 'external' | 'unsupported_scheme' | 'malformed' };

/**
 * 背景图 URL 的**白名单**校验。只放行三类：
 *
 *   1. `/` 开头的站内绝对路径（`/backgrounds/bg-office.webp`）；
 *   2. `blob:` —— 用户本地上传经 `URL.createObjectURL` 产生，天然同源；
 *   3. `data:image/` —— 内联图片，同样不产生网络请求。
 *
 * 明确拒绝 `http(s)://` 外链，两个独立理由，任一都足以拒绝：
 *   - **CORS**：库用 `img.crossOrigin='Anonymous'` 载图，对端不给 CORS 头就直接失败；
 *     即便拿到了，画进 canvas 也可能污染画布导致整条管线报错。
 *   - **大陆访问**（§8.1）：境外图床不可达，会变成"日本能用、大陆黑屏"的隐性差异。
 *
 * 另外挡掉两种伪装成站内路径的写法：
 *   - `//evil.com/x.png`（协议相对 URL，浏览器当成外链）；
 *   - `/\evil.com/x.png`（部分浏览器把 `\` 当 `/` 处理，等价于协议相对 URL）。
 */
export function validateBackgroundImageUrl(raw: unknown): BackgroundImageUrlResult {
  if (typeof raw !== 'string') return { ok: false, reason: 'malformed' };
  const url = raw.trim();
  if (url.length === 0) return { ok: false, reason: 'empty' };
  // 换行 / 制表 / 其它控制字符：正常路径不会有，出现即视为构造过的输入
  if (/[\u0000-\u001f\u007f]/.test(url)) return { ok: false, reason: 'malformed' };

  const lower = url.toLowerCase();
  if (lower.startsWith('blob:')) return { ok: true, url };
  if (lower.startsWith('data:image/')) return { ok: true, url };
  if (url.startsWith('/')) {
    // `//host` 与 `/\host` 都是协议相对 URL 的写法，等同外链
    const second = url[1];
    if (second === '/' || second === '\\') return { ok: false, reason: 'external' };
    return { ok: true, url };
  }
  if (lower.startsWith('http://') || lower.startsWith('https://')) {
    return { ok: false, reason: 'external' };
  }
  // 相对路径（`bg.png`）、`file:`、`javascript:` 等一律不收
  return { ok: false, reason: 'unsupported_scheme' };
}

// ============================================================
// 3. BackgroundEffect 规范化
// ============================================================

/**
 * 校验并补全后的效果值。与 `BackgroundEffect` 的差别只有一处：
 * `blur` 的 `blurRadius` 一定有值（已套默认值与区间钳制）。
 */
export type NormalizedBackgroundEffect =
  | { type: 'none' }
  | { type: 'blur'; blurRadius: number }
  | { type: 'image'; imageUrl: string };

export type NormalizeBackgroundEffectResult =
  | { ok: true; effect: NormalizedBackgroundEffect }
  | { ok: false; message: string };

const NONE_EFFECT: NormalizedBackgroundEffect = Object.freeze({ type: 'none' });

/** 未设置过效果时 `LocalState.backgroundEffect` 的取值（共享同一个冻结对象，浅比较友好）。 */
export function noBackgroundEffect(): NormalizedBackgroundEffect {
  return NONE_EFFECT;
}

/**
 * `BackgroundEffect`（来自 UI，可能是任意值）→ `NormalizedBackgroundEffect`。
 *
 * 处理策略刻意分成两类，别混：
 *   - **拒绝**（返回 `ok:false`，provider 据此 reject）：type 不认识、imageUrl 非法、
 *     blurRadius 不是有限数。这些都表示调用方写错了，静默兜底只会让 bug 藏起来。
 *   - **钳制**（照常返回 `ok:true`）：blurRadius 是有限数但超出 [1, 30]。
 *     滑块拖到端点不该弹错误，夹到边界即可——这条有单测钉住，不是随手行为。
 */
export function normalizeBackgroundEffect(effect: unknown): NormalizeBackgroundEffectResult {
  if (typeof effect !== 'object' || effect === null) {
    return { ok: false, message: 'background effect must be an object' };
  }
  const type = (effect as { type?: unknown }).type;

  if (type === 'none') return { ok: true, effect: NONE_EFFECT };

  if (type === 'blur') {
    const raw = (effect as { blurRadius?: unknown }).blurRadius;
    if (raw === undefined) {
      return { ok: true, effect: Object.freeze({ type: 'blur', blurRadius: DEFAULT_BACKGROUND_BLUR_RADIUS }) };
    }
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      return { ok: false, message: `blurRadius must be a finite number, got ${String(raw)}` };
    }
    const clamped = Math.min(MAX_BACKGROUND_BLUR_RADIUS, Math.max(MIN_BACKGROUND_BLUR_RADIUS, raw));
    return { ok: true, effect: Object.freeze({ type: 'blur', blurRadius: clamped }) };
  }

  if (type === 'image') {
    const result = validateBackgroundImageUrl((effect as { imageUrl?: unknown }).imageUrl);
    if (!result.ok) {
      return { ok: false, message: backgroundImageUrlErrorMessage(result.reason) };
    }
    return { ok: true, effect: Object.freeze({ type: 'image', imageUrl: result.url }) };
  }

  return { ok: false, message: `unknown background effect type: ${String(type)}` };
}

function backgroundImageUrlErrorMessage(reason: Exclude<BackgroundImageUrlResult, { ok: true }>['reason']): string {
  switch (reason) {
    case 'empty':
      return 'background imageUrl is empty';
    case 'external':
      return 'background imageUrl must be same-origin: cross-origin http(s) URLs are rejected (CORS + China reachability)';
    case 'unsupported_scheme':
      return "background imageUrl must start with '/', 'blob:' or 'data:image/'";
    case 'malformed':
      return 'background imageUrl is malformed';
  }
}

/**
 * 两个效果是否等价。`syncLocalState` 的浅比较用它——
 * `BackgroundEffect` 是对象，直接 `===` 会因为每次 normalize 都产生新对象而永远"变化了"，
 * 于是每一次 syncLocalState（设备切换、静音、订阅变化……）都白白 emit 一次 localStateChanged。
 */
export function isSameBackgroundEffect(a: BackgroundEffect | undefined, b: BackgroundEffect | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.type !== b.type) return false;
  if (a.type === 'blur' && b.type === 'blur') return a.blurRadius === b.blurRadius;
  if (a.type === 'image' && b.type === 'image') return a.imageUrl === b.imageUrl;
  return true; // 两边都是 none
}

// ============================================================
// 4. 与 @livekit/track-processors 的接口（结构视图，见文件头）
// ============================================================

/** 库的 `SwitchBackgroundProcessorOptions` 的结构镜像（0.7.2）。 */
export type BackgroundSwitchOptions =
  | { mode: 'disabled' }
  | { mode: 'background-blur'; blurRadius: number }
  | { mode: 'virtual-background'; imagePath: string };

/**
 * 库 `BackgroundOptions.onFrameProcessed` 的结构镜像。
 * 参数（处理耗时の内訳）我们用不到，只当作**心跳**——见下方 `createBackgroundProcessor`。
 */
export type BackgroundFrameCallback = () => void;

/** 库的 `BackgroundProcessorOptions`（mode 变体）中我们用到的部分。 */
export type BackgroundProcessorConstructorOptions = BackgroundSwitchOptions & {
  assetPaths: { tasksVisionFileSet: string; modelAssetPath: string };
  /** 每处理完一帧调用一次。运行期存活监视（provider 的 watchdog）唯一的正向信号。 */
  onFrameProcessed?: BackgroundFrameCallback;
};

/**
 * 我们实际接触到的 processor 表面。
 *
 * `switchTo` 以外の 2 つは**運行期の死活監視のため**に読む（2026-08-14）：
 * ライブラリは運行期エラーを一切外に出さない（EventEmitter も onError も無く、
 * `transform()` の例外は内部で握り潰されて `log.error` に消えるだけ）ので、
 * こちらから覗ける口はこの 2 つと onFrameProcessed の心跳しかない。詳細は
 * provider 側 `armProcessorProbes()` のコメント。
 */
export interface BackgroundProcessorLike {
  switchTo(options: BackgroundSwitchOptions): Promise<void>;
  /** WebGL2 コンテキストが載っている canvas（`webglcontextlost` を張る先）。init 後に生える。 */
  readonly canvas?: EventTarget;
  /** 処理後のトラック（`ended` を張る先）。init 後に生える。 */
  readonly processedTrack?: { addEventListener: EventTarget['addEventListener']; removeEventListener: EventTarget['removeEventListener'] };
}

/** `await import('@livekit/track-processors')` 的结构视图（只列用到的两个导出）。 */
export interface TrackProcessorsModuleLike<TProcessor extends BackgroundProcessorLike> {
  supportsBackgroundProcessors(): boolean;
  BackgroundProcessor(options: BackgroundProcessorConstructorOptions, name?: string): TProcessor;
}

/** 抽象层效果 → 库的 switch 参数。纯映射，单测直接锁。 */
export function toSwitchOptions(effect: NormalizedBackgroundEffect): BackgroundSwitchOptions {
  switch (effect.type) {
    case 'blur':
      return { mode: 'background-blur', blurRadius: effect.blurRadius };
    case 'image':
      return { mode: 'virtual-background', imagePath: effect.imageUrl };
    case 'none':
      return { mode: 'disabled' };
  }
}

/**
 * 构造参数 = switch 参数 + **强制的自托管 assetPaths**。
 * 这个函数是「库默认 CDN 绝无机会生效」的唯一保证点。
 */
export function toProcessorConstructorOptions(
  effect: NormalizedBackgroundEffect,
  onFrameProcessed?: BackgroundFrameCallback,
): BackgroundProcessorConstructorOptions {
  const options: BackgroundProcessorConstructorOptions = {
    ...toSwitchOptions(effect),
    assetPaths: { ...MEDIAPIPE_ASSET_PATHS },
  };
  if (onFrameProcessed) options.onFrameProcessed = onFrameProcessed;
  return options;
}

// ============================================================
// 4.5 挂载决策（摄像头开关 / 换设备时该做什么）
// ============================================================

/** `applyBackgroundEffect` 的三种动作。 */
export type BackgroundApplyPlan =
  /** 拆掉现有管线（目标是 none，或根本没有摄像头 track 可挂） */
  | { action: 'teardown' }
  /** 同一条 track 上换模式：不重建管线、不重载模型，无切换残影 */
  | { action: 'switch'; options: BackgroundSwitchOptions }
  /** 换了 track（摄像头关→重开）或首次启用：拆旧建新 */
  | { action: 'recreate' };

export interface BackgroundApplyInput {
  /** 当前是否存在本地摄像头 track（关摄像头 / 未连接时为 false） */
  hasCameraTrack: boolean;
  /** 现有 processor 是否正挂在**当前这条** camera track 上 */
  processorAttachedToCurrentTrack: boolean;
  /** 想要达到的效果 */
  effect: NormalizedBackgroundEffect;
}

/**
 * 挂载决策的**纯函数**。把 provider 里那段"该 switchTo 还是该重建"的判断抽出来，
 * 好处是「摄像头关→重开后效果自动重挂」这条行为可以在 node 环境直接单测
 * （provider 本体引了 livekit-client，在 node 里跑不起来）。
 *
 * 决策依据只有一条事实：**LiveKit 在 `LocalTrack.stop()` 里会 destroy processor**，
 * 而 `stopLocalTrackOnUnpublish: true` 让关摄像头等于 stop——所以重开后拿到的是
 * 一条全新的 LocalVideoTrack，必须重建；而换摄像头设备走的是
 * `LocalTrack.restart()` → `setMediaStreamTrack()`，SDK 自己会 `processor.restart()`，
 * track 对象不变，于是走 switch 分支（等价于一次廉价的参数更新）。
 */
export function planBackgroundApply(input: BackgroundApplyInput): BackgroundApplyPlan {
  if (!input.hasCameraTrack) return { action: 'teardown' };
  if (input.effect.type === 'none') return { action: 'teardown' };
  if (input.processorAttachedToCurrentTrack) {
    return { action: 'switch', options: toSwitchOptions(input.effect) };
  }
  return { action: 'recreate' };
}

/**
 * 库侧能力复核の**メモ化**（2026-08-14 の重要な発見）。
 *
 * ⚠️ `supportsBackgroundProcessors()` は見た目こそ数行の typeof 判定だが、内部の
 * `BackgroundTransformer.isSupported` が **毎回 `document.createElement('canvas').getContext('webgl2')`
 * を実行し、その context を解放しない**（ライブラリ 0.7.2 の実装。node_modules の
 * `src/transformers/BackgroundTransformer.ts` の isSupported を参照）。
 * ブラウザの WebGL context 上限はおおむね同時 16 個程度なので、
 * カメラの ON/OFF や背景の切替のたびに processor を作り直す本アプリでは、
 * **この関数を呼ぶこと自体が context を食い潰し、やがて実際の背景管線を
 * context lost に追い込む**——つまり「揺らしたら黒くなる」の一因になりうる。
 *
 * 判定結果は同一セッション内で変わらないので、モジュールオブジェクトをキーに一度だけ覚える。
 * （WeakMap なのは、テストが毎回新しい偽モジュールを渡してもキャッシュが混ざらないため）
 */
const librarySupportCache = new WeakMap<object, boolean>();

function librarySupportsProcessors(mod: { supportsBackgroundProcessors(): boolean }): boolean {
  const cached = librarySupportCache.get(mod);
  if (cached !== undefined) return cached;
  const supported = mod.supportsBackgroundProcessors();
  librarySupportCache.set(mod, supported);
  return supported;
}

/**
 * 用**懒加载来的真模块**创建 processor。provider 侧只许走这条路。
 *
 * 这里额外用库自己的 `supportsBackgroundProcessors()` 复核一次：我们的
 * `probeBackgroundCapabilities()` 是同一套判据的自实现（为了不把库拉进首屏），
 * 判据万一因为库升级而漂移，这道复核会把它变成一条明确的错误消息，
 * 而不是构造到一半炸在 WebGL 里。**ただし呼び出しは 1 回だけ**（上のメモ化の理由）。
 *
 * @param onFrameProcessed 運行期の存活監視（provider の watchdog）に渡す心跳コールバック。
 * @throws Error 环境不支持时（消息会被 provider 包成 `MediaError { code: 'UNKNOWN' }`）
 */
export function createBackgroundProcessor<TProcessor extends BackgroundProcessorLike>(
  mod: TrackProcessorsModuleLike<TProcessor>,
  effect: NormalizedBackgroundEffect,
  onFrameProcessed?: BackgroundFrameCallback,
): TProcessor {
  if (!librarySupportsProcessors(mod)) {
    throw new Error('background processors are not supported in this browser');
  }
  return mod.BackgroundProcessor(
    toProcessorConstructorOptions(effect, onFrameProcessed),
    BACKGROUND_PROCESSOR_NAME,
  );
}

// ============================================================
// 5. 能力检测（不加载库，见文件头与下方取舍说明）
// ============================================================

/**
 * 能力探针。字段与 `@livekit/track-processors` 0.7.2 的两个静态 `isSupported`
 * 一一对应（`BackgroundTransformer.isSupported` / `ProcessorWrapper.isSupported`）。
 *
 * **为什么要自己抄一遍判据**：库的 `supportsBackgroundProcessors()` 虽然只是几行 typeof，
 * 但它是 `dist/index.mjs` 的具名导出，静态 import 会把整个包（含 @mediapipe/tasks-vision）
 * 拉进 room 路由的初始 chunk——正是 §8.2 要避免的。所以走**两段式**：
 *   第一段（本函数，同步、零依赖）：给 UI 一个立刻能用的 `isBackgroundEffectSupported()`；
 *   第二段（`createBackgroundProcessor`）：懒加载之后用库自己的判据复核。
 * 代价是判据在两处，库升级时可能漂移——用第二段兜住，且单测里把判据表钉死。
 */
export interface BackgroundCapabilityProbe {
  /** `typeof OffscreenCanvas !== 'undefined'` */
  offscreenCanvas: boolean;
  /** `typeof VideoFrame !== 'undefined'`（WebCodecs） */
  videoFrame: boolean;
  /** `typeof createImageBitmap !== 'undefined'` */
  createImageBitmap: boolean;
  /** 能拿到 webgl2 上下文 */
  webgl2: boolean;
  /** `MediaStreamTrackProcessor` + `MediaStreamTrackGenerator`（Insertable Streams，性能最好的路径） */
  streamTrackProcessor: boolean;
  /** `HTMLCanvasElement.prototype.captureStream`（回退路径，Safari 走这条） */
  canvasCaptureStream: boolean;
}

/**
 * 纯判定：探针 → 能否跑背景管线。
 * 等价于库的 `BackgroundTransformer.isSupported && ProcessorWrapper.isSupported`。
 */
export function computeBackgroundSupport(probe: BackgroundCapabilityProbe): boolean {
  // BackgroundTransformer.isSupported
  const transformerOk =
    probe.offscreenCanvas && probe.videoFrame && probe.createImageBitmap && probe.webgl2;
  // ProcessorWrapper.isSupported（主路径 或 canvas.captureStream 回退）
  const processorOk = probe.streamTrackProcessor || (probe.canvasCaptureStream && probe.videoFrame);
  return transformerOk && processorOk;
}

const UNSUPPORTED_PROBE: BackgroundCapabilityProbe = Object.freeze({
  offscreenCanvas: false,
  videoFrame: false,
  createImageBitmap: false,
  webgl2: false,
  streamTrackProcessor: false,
  canvasCaptureStream: false,
});

/**
 * 读取真实环境的能力。**非浏览器（SSR / vitest node）下恒返回全 false**，不抛异常。
 *
 * webgl2 那一项要真的建一次上下文（typeof 检测不出被禁用/软件渲染缺失的情况），
 * 所以调用方应当缓存结果——见 provider 里的 `backgroundSupportCache`。
 */
export function probeBackgroundCapabilities(): BackgroundCapabilityProbe {
  if (typeof document === 'undefined' || typeof window === 'undefined') return UNSUPPORTED_PROBE;

  const g = globalThis as Record<string, unknown>;
  let webgl2 = false;
  try {
    const ctx = document.createElement('canvas').getContext('webgl2');
    webgl2 = !!ctx;
    // ⚠️ 作った context は**必ず捨てる**（2026-08-14 追加）。ブラウザの同時 WebGL context
    // 数には上限（おおむね 16）があり、古いものから強制的に lost にされる。ここで捨てずに
    // 溜めると、本命である背景管線の context が巻き添えで失われる＝実機の黒画面。
    // 破棄の作法は WebGL の標準拡張（無い環境では単に何もしない）。
    ctx?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {
    // 某些隐私模式 / 无 GPU 的环境会直接抛，视为不支持
    webgl2 = false;
  }

  return {
    offscreenCanvas: typeof g.OffscreenCanvas !== 'undefined',
    videoFrame: typeof g.VideoFrame !== 'undefined',
    createImageBitmap: typeof g.createImageBitmap !== 'undefined',
    webgl2,
    streamTrackProcessor:
      typeof g.MediaStreamTrackProcessor !== 'undefined' &&
      typeof g.MediaStreamTrackGenerator !== 'undefined',
    canvasCaptureStream:
      typeof HTMLCanvasElement !== 'undefined' && 'captureStream' in HTMLCanvasElement.prototype,
  };
}
