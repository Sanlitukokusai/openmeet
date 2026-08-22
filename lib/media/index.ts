import type { MediaProvider, ProviderConfig } from './types';
import { LiveKitProvider } from './providers/livekit';

/**
 * prejoin 用の背景プレビューセッション（2026-08-16 実機フィードバック③）。
 *
 * provider と同じく **UI からは必ず `await import('@/lib/media')` 経由で取ること**——
 * このモジュールは livekit-client を静的 import しているので、素直に import すると
 * prejoin の初期 chunk に入ってしまう（§8.2 / WP-3 交接注記）。
 *
 * ⚠️ Agora を実装する期には、config.provider に応じて実装を差し替える形に変える
 * （現状は本期の方針どおり LiveKit 一本なので分岐を作らない＝使われない抽象を先に作らない）。
 */
export { createBackgroundPreviewSession } from './providers/livekit/preview';

export function createMediaProvider(config: ProviderConfig): MediaProvider {
  switch (config.provider) {
    case 'livekit':
      return new LiveKitProvider();
    case 'agora':
      // 本期不实装。启用时在此 return new AgoraProvider();
      throw new Error('AgoraProvider not implemented in this phase');
    default:
      throw new Error('Unknown provider');
  }
}
