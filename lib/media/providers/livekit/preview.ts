/**
 * prejoin の**リアルタイム背景プレビュー**（2026-08-16 実機フィードバック③）。
 *
 * それまでの prejoin は「素の `getUserMedia` の映像を出すだけ」で、背景効果は
 * 選択を localStorage に書くだけ＝入室してみるまで結果が分からなかった
 * （UI にも「入室後に反映されます」と但し書きを出していた）。ここでは会議内と
 * **同じ管線**を connect 前に一時的に組み、選んだその場で見えるようにする。
 *
 * ============ 会議内（./index.ts）との共有面 ============
 * 「同じ管線」というのは比喩ではなく、実際に同じコードを通る：
 *   - `createLocalVideoTrack()`（livekit-client）——Room に publish しないだけで、
 *     採集オプション（720p 固定、§3.4）も LocalVideoTrack の実体も会議内と同じ。
 *   - `normalizeBackgroundEffect()` / `planBackgroundApply()` / `createBackgroundProcessor()`
 *     ——検証・状態遷移・**自ホスト assetPaths の強制**（§8.1 の赤線）はすべて
 *     ./background.ts の同じ関数。プレビュー用に別実装を書いていない＝
 *     「プレビューでは効いたのに入室したら違う」が原理的に起きない。
 *   - `loadTrackProcessors()`——dynamic import の唯一の入口も共有（§8.2）。
 *
 * ============ あえて簡略化した点（取捨選択の明示）============
 * 会議内には運行期の自己修復（FR-9：`onFrameProcessed` の心跳 watchdog ＋
 * `webglcontextlost` ＋ `processedTrack.ended` の 3 点計測と、失敗回数に応じた
 * 効果の自動解除）があるが、**プレビューには載せない**。理由：
 *   - プレビューは滞在時間が数十秒で、ユーザーは画面を見ている（黙って黒くなっても
 *     すぐ気付ける）。会議中の「相手からだけ黒く見える」とは危険度が違う。
 *   - ここで管線が死んでも失うのはプレビューだけで、通話品質には影響しない。
 * そのぶん**適用時の失敗は握り潰さず reject する**——呼び出し側（PrejoinView）が
 * トーストを出し、ピッカーの選択状態を戻す。効果は none に落として素の映像は残す。
 *
 * ⚠️ 規格書 §3.1：`livekit-client` / `@livekit/track-processors` は本ディレクトリ配下
 * でのみ import 可（ESLint + scripts/check-china-safe.sh の二重強制）。UI 側は
 * `lib/media/index.ts` 経由でこのファクトリを受け取る。
 */
import { createLocalVideoTrack } from 'livekit-client';
import type { LocalVideoTrack } from 'livekit-client';

import type {
  BackgroundEffect,
  BackgroundPreviewOptions,
  BackgroundPreviewSession,
  CreateBackgroundPreviewSession,
} from '../../types';
import {
  computeBackgroundSupport,
  createBackgroundProcessor,
  noBackgroundEffect,
  normalizeBackgroundEffect,
  planBackgroundApply,
  probeBackgroundCapabilities,
  type NormalizedBackgroundEffect,
} from './background';
import { LiveKitMediaError, classifyError } from './mapping';
import { loadTrackProcessors, type BackgroundProcessorHandle } from './track-processors-loader';

/**
 * プレビューの採集解像度。会議内（./index.ts の LAYER_720P）と**同じ 720p** に揃える。
 * プレビューは publish しないので simulcast の段数とは無関係だが、揃えておかないと
 * 「プレビューでは軽かったのに入室したら重い」という食い違いが出るし、
 * 背景処理の負荷も解像度でまるきり変わる（＝プレビューが負荷の目安にならなくなる）。
 */
const PREVIEW_RESOLUTION = { width: 1280, height: 720 } as const;

class LiveKitBackgroundPreviewSession implements BackgroundPreviewSession {
  private readonly videoEl: HTMLVideoElement;

  private track?: LocalVideoTrack;

  private processor?: BackgroundProcessorHandle;

  /** processor が乗っている track。デバイス切替で track を作り直すので同一性で判定する。 */
  private processorTrack?: LocalVideoTrack;

  /** 現在**意図している**効果（track が無い一瞬でも保持し、再取得後に載せ直す）。 */
  private effect: NormalizedBackgroundEffect = noBackgroundEffect();

  private deviceId?: string;

  private disposed = false;

  /** 能力検出のセッション内キャッシュ（webgl2 判定は実際に context を作るので毎回はやらない）。 */
  private support?: boolean;

  /** 直列化キュー。ピッカーを連打されても setProcessor / switchTo が交叉しない（会議内と同じ作法）。 */
  private queue: Promise<void> = Promise.resolve();

  constructor(videoEl: HTMLVideoElement) {
    this.videoEl = videoEl;
  }

  /** ファクトリからのみ呼ぶ。カメラを開けなければそのまま throw（呼び出し側がプレースホルダー表示へ倒す）。 */
  async start(deviceId?: string): Promise<void> {
    this.deviceId = deviceId;
    await this.openTrack();
  }

  isBackgroundSupported(): boolean {
    if (this.support === undefined) {
      this.support = computeBackgroundSupport(probeBackgroundCapabilities());
    }
    return this.support;
  }

  async setEffect(effect: BackgroundEffect): Promise<void> {
    const normalized = normalizeBackgroundEffect(effect);
    if (!normalized.ok) {
      throw new LiveKitMediaError('UNKNOWN', normalized.message);
    }
    const next = normalized.effect;
    // 「効果を切る」はどの環境でも成立する（そもそも何も載っていない）ので、
    // 能力ゲートは実際に管線を起こす blur / image だけに掛ける（会議内と同じ判断）。
    if (next.type !== 'none' && !this.isBackgroundSupported()) {
      throw new LiveKitMediaError(
        'UNKNOWN',
        'background effects are not supported in this browser ' +
          '(requires WebGL2 + WebCodecs VideoFrame + OffscreenCanvas)',
      );
    }

    await this.enqueue(async () => {
      if (this.disposed) return;
      try {
        await this.applyEffect(next);
      } catch (err) {
        // 失敗したら管線ごと畳んで**素の映像は残す**。効果の意図も none に戻す
        // （中途半端に「blur のつもりだが実際は素通し」という嘘の状態を作らない）。
        await this.teardownProcessor();
        this.effect = noBackgroundEffect();
        throw classifyError(err, 'UNKNOWN');
      }
      this.effect = next;
    });
  }

  async setDeviceId(deviceId: string | undefined): Promise<void> {
    await this.enqueue(async () => {
      if (this.disposed || deviceId === this.deviceId) return;
      this.deviceId = deviceId;
      const desired = this.effect;
      // `restartTrack()` ではなく**作り直す**：processor が乗った状態の restart は
      // ライブラリ内部の processor.restart() に依存する（会議内はそれで良いが、
      // プレビューでは track を捨てて作る方が状態機械が単純で、失敗時の後始末も明確）。
      await this.teardownProcessor();
      this.closeTrack();
      await this.openTrack();
      if (this.disposed || desired.type === 'none') return;
      try {
        await this.applyEffect(desired);
      } catch (err) {
        await this.teardownProcessor();
        this.effect = noBackgroundEffect();
        throw classifyError(err, 'UNKNOWN');
      }
      this.effect = desired;
    });
  }

  /**
   * 後始末。**同期・冪等**（React の effect cleanup から呼ぶため）。
   * カメラを確実に手放すのが最優先——prejoin を離れてもインジケータが点いたままだと、
   * 会議側のカメラ取得と取り合いになる端末がある（iOS のカメラ排他）。
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const track = this.track;
    this.track = undefined;
    this.processor = undefined;
    this.processorTrack = undefined;
    this.effect = noBackgroundEffect();
    if (track) {
      try {
        track.detach(this.videoEl);
      } catch {
        // 既に外れていても構わない（冪等性のため飲む）
      }
      // LocalTrack.stop() は内部で processor.destroy() まで面倒を見る
      // （livekit-client の LocalTrack#stop 実装）ので、ここで stopProcessor() は要らない。
      track.stop();
    }
    this.videoEl.srcObject = null;
  }

  // ==========================================================
  // 内部
  // ==========================================================

  private async openTrack(): Promise<void> {
    const track = await createLocalVideoTrack({
      deviceId: this.deviceId,
      resolution: PREVIEW_RESOLUTION,
    });
    if (this.disposed) {
      // 取得中に dispose された：作った track をそのまま捨てる（カメラを点けっぱなしにしない）
      track.stop();
      return;
    }
    this.track = track;
    track.attach(this.videoEl);
  }

  private closeTrack(): void {
    const track = this.track;
    this.track = undefined;
    if (!track) return;
    try {
      track.detach(this.videoEl);
    } catch {
      // ignore
    }
    track.stop();
  }

  /** 会議内 `applyBackgroundEffect()` と同じ決定表（./background.ts の純関数）を使う。 */
  private async applyEffect(next: NormalizedBackgroundEffect): Promise<void> {
    const track = this.track;
    const processor = this.processor;
    const plan = planBackgroundApply({
      hasCameraTrack: track !== undefined,
      processorAttachedToCurrentTrack: processor !== undefined && this.processorTrack === track,
      effect: next,
    });

    if (plan.action === 'switch' && processor) {
      // 同じ track 上のモード変更：管線も分割モデルも作り直さない（切替の残像が出ない）
      await processor.switchTo(plan.options);
      return;
    }
    if (plan.action === 'teardown' || !track) {
      await this.teardownProcessor();
      return;
    }
    await this.teardownProcessor();
    const mod = await loadTrackProcessors();
    // ⚠️ ここが §8.1 の赤線：assetPaths（自ホストの wasm / tflite）を必ず通す唯一の入口。
    const created = createBackgroundProcessor(mod, next);
    await track.setProcessor(created);
    this.processor = created;
    this.processorTrack = track;
  }

  private async teardownProcessor(): Promise<void> {
    const target = this.processorTrack ?? this.track;
    this.processor = undefined;
    this.processorTrack = undefined;
    if (!target) return;
    try {
      await target.stopProcessor();
    } catch {
      // track が既に stop 済み（stop() が processor を destroy 済み）などは想定内
    }
  }

  /** 直列化。1 回の失敗でキューを毒さない（エラーは発起元にだけ返す）——会議内と同じ形。 */
  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(task, task);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

/**
 * prejoin 用プレビューセッションを作る。`videoEl` への attach まで済んだ状態で resolve する。
 * カメラが開けない（権限拒否・デバイス無し・他アプリが専有）ときは reject——
 * 呼び出し側は従来どおり「カメラオフ」のプレースホルダーを出せばよい。
 */
export const createBackgroundPreviewSession: CreateBackgroundPreviewSession = async (
  videoEl: HTMLVideoElement,
  opts: BackgroundPreviewOptions = {},
): Promise<BackgroundPreviewSession> => {
  const session = new LiveKitBackgroundPreviewSession(videoEl);
  await session.start(opts.deviceId);
  return session;
};
