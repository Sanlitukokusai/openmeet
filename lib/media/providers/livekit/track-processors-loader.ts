/**
 * `@livekit/track-processors` の**唯一の読み込み点**（2026-08-16 に provider から括り出し）。
 *
 * 元は `LiveKitProvider.loadTrackProcessors()` という private メソッドだったが、
 * prejoin のリアルタイム背景プレビュー（./preview.ts）も同じ管線を使うことになったため、
 * 「dynamic import はこの 1 か所だけ」という不変条件を保ったまま両者で共有する。
 * ここを増やしてはいけない理由は 2 つとも重い：
 *
 *  - **§8.2 首屏バンドル**：静的 import すると `@mediapipe/tasks-vision` ごと
 *    room / prejoin の初期 chunk に入る（数百 KB + wasm）。`import()` でしか触らない。
 *  - **§8.1 大陸アクセス**：assetPaths を渡さないとライブラリは境外の公開 CDN へ取りに行く。
 *    構築は必ず ./background.ts の `createBackgroundProcessor()` 経由にすること
 *    （このモジュールは「読み込み」だけを担当し、`BackgroundProcessor` を自分では呼ばない）。
 *
 * キャッシュはモジュールスコープに 1 つ。**失敗はキャッシュしない**（一過性のネットワーク
 * 障害でその後ずっと背景効果が使えなくなるのを避ける）。
 */

/**
 * 遅延ロードするモジュールの型。**必ず `typeof import(...)` の形（純粋な型位置なので
 * TS のコンパイル後に完全に消える）で書くこと**——値として import した瞬間、
 * 依存グラフに実辺が生えて上記 2 つの前提が崩れる。
 */
export type TrackProcessorsModule = typeof import('@livekit/track-processors');

/** `BackgroundProcessor()` が返す processor 実体（`BackgroundProcessorWrapper`）。 */
export type BackgroundProcessorHandle = ReturnType<TrackProcessorsModule['BackgroundProcessor']>;

let modulePromise: Promise<TrackProcessorsModule> | undefined;

export function loadTrackProcessors(): Promise<TrackProcessorsModule> {
  if (!modulePromise) {
    modulePromise = import('@livekit/track-processors').catch((err: unknown) => {
      modulePromise = undefined;
      throw err;
    });
  }
  return modulePromise;
}
