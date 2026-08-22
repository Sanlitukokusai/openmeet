/**
 * 设备工具（规格书 §3.2 末尾「设备工具，与 provider 无关，独立导出」/ §7.5）
 *
 * 只依赖 `navigator.mediaDevices`，**不 import 任何 provider、更不 import livekit-client** ——
 * 换 Agora 时这个文件原样复用，pre-join 页（WP-4）也在建立媒体连接之前就要用它。
 *
 * 使用前提（§7.5）：必须 HTTPS（或 localhost），否则 `navigator.mediaDevices` 直接是
 * undefined，这里会抛 PERMISSION_DENIED 并在 message 里点明原因，不做静默降级。
 */
import type { MediaDeviceEntry, MediaDeviceHelper, MediaError, MediaErrorCode } from './types';

/**
 * 本文件自带的 MediaError 载体。
 *
 * 没有复用 provider 目录里的 `LiveKitMediaError`：那是 provider 私有实现，
 * 与 provider 无关的本文件不该反向依赖 `providers/livekit/**`（§3.1 分层）。
 * 两个类都只是「Error + code」，重复的代价小于把分层搞乱。
 */
export class MediaDeviceError extends Error implements MediaError {
  readonly code: MediaErrorCode;

  readonly cause?: unknown;

  constructor(code: MediaErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'MediaDeviceError';
    this.code = code;
    this.cause = cause;
  }
}

const SUPPORTED_KINDS: ReadonlySet<string> = new Set<MediaDeviceEntry['kind']>([
  'audioinput',
  'videoinput',
  'audiooutput',
]);

/** 权限未授予时浏览器返回空 label；给一个中性英文占位，UI 要本地化时按 kind 自行覆盖 */
const FALLBACK_LABEL: Readonly<Record<MediaDeviceEntry['kind'], string>> = {
  audioinput: 'Microphone',
  videoinput: 'Camera',
  audiooutput: 'Speaker',
};

function getMediaDevices(): MediaDevices {
  const devices = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
  if (!devices) {
    throw new MediaDeviceError(
      'PERMISSION_DENIED',
      'navigator.mediaDevices is unavailable — the page must be served over HTTPS or localhost (§7.5)',
    );
  }
  return devices;
}

function stopStream(stream: MediaStream): void {
  // 探测权限用完立刻关掉，否则摄像头指示灯会一直亮着
  for (const track of stream.getTracks()) track.stop();
}

export class BrowserMediaDeviceHelper implements MediaDeviceHelper {
  /**
   * 列出摄像头 / 麦克风 / 扬声器。
   *
   * 注意：**未授权前 label 为空**（浏览器防指纹），所以 pre-join 页应先
   * `requestPermission()` 再 `listDevices()`，否则用户看到的是一串占位名。
   */
  async listDevices(): Promise<MediaDeviceEntry[]> {
    const devices = await getMediaDevices().enumerateDevices();
    const seq: Record<string, number> = {};
    const entries: MediaDeviceEntry[] = [];
    for (const device of devices) {
      if (!SUPPORTED_KINDS.has(device.kind)) continue;
      const kind = device.kind as MediaDeviceEntry['kind'];
      seq[kind] = (seq[kind] ?? 0) + 1;
      entries.push({
        deviceId: device.deviceId,
        label: device.label.length > 0 ? device.label : `${FALLBACK_LABEL[kind]} ${seq[kind]}`,
        kind,
      });
    }
    return entries;
  }

  /**
   * 申请麦克风 / 摄像头权限，返回各自是否拿到。
   *
   * 策略：先一次性请求两者（多数浏览器只弹一个框）；失败时再分别请求，
   * 以便区分"只拒了摄像头"这种部分授权的情况 —— §7.5 的降级路径
   * （仅音频加入 / 纯旁听）就靠这个返回值决定。
   * 本方法**不抛异常**（拒绝授权是正常业务分支），只有在
   * `navigator.mediaDevices` 完全不可用时才抛（那是环境错误，必须响亮失败）。
   */
  async requestPermission(): Promise<{ audio: boolean; video: boolean }> {
    const devices = getMediaDevices();
    try {
      const stream = await devices.getUserMedia({ audio: true, video: true });
      stopStream(stream);
      return { audio: true, video: true };
    } catch {
      // 落到逐项探测
    }

    let audio = false;
    let video = false;
    try {
      const stream = await devices.getUserMedia({ audio: true });
      stopStream(stream);
      audio = true;
    } catch {
      audio = false;
    }
    try {
      const stream = await devices.getUserMedia({ video: true });
      stopStream(stream);
      video = true;
    } catch {
      video = false;
    }
    return { audio, video };
  }
}

/** 全局单例：UI 直接 `import { mediaDeviceHelper } from '@/lib/media/devices'` */
export const mediaDeviceHelper: MediaDeviceHelper = new BrowserMediaDeviceHelper();
