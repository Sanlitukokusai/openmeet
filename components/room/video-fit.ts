/**
 * 満屏（1 人）表示の **object-fit 切替**（2026-08-14 実機フィードバック
 * 「人が映ると背景（バーチャル背景の画像）が全部見えない」）。
 *
 * ============ 何が起きているか（直せる部分と直せない部分の切り分け）============
 * 縦持ちのスマホで相手を画面いっぱいに出すと、届く映像は 16:9 の横長なので
 * `object-fit: cover` は**左右をごっそり切り落として**縦に合わせる。相手が
 * バーチャル背景を使っていると、その背景画像の左右が消えて「全部見えない」に見える。
 *
 * ここで直せるのは**受信側の見せ方**だけ：`contain` に切り替えれば上下に黒帯は出るが
 * 16:9 の合成画面が丸ごと見える。切替式にするのは、通常の会話では `cover` の
 * 没入感（顔が大きい）の方が明らかに良いから——既定は cover のまま、
 * 「全部見たい」ときだけ 1 タップで切り替える。
 *
 * ⚠️ **送信側の切り落としは直せない**：送信側が縦持ちで撮った縦長の映像に対して
 * `@livekit/track-processors` が 16:9 の背景画像を合成する時点で、画像側は
 * すでに切り取られている。これは受信側でどう表示しようが戻らない
 * （Zoom も同じ挙動）。試みるだけ無駄なので触らない——最終レポートにも明記。
 *
 * ============ 保存の粒度 ============
 * sessionStorage（＝タブを閉じれば忘れる）。localStorage にしないのは、
 * これが「今この相手・今この画面の見え方」に対する一時的な好みだから。
 * 次の会議まで持ち越すと、なぜ黒帯が出ているのか分からないという事故になる。
 */

export type VideoFit = 'cover' | 'contain';

/** sessionStorage のキー。他プロジェクトと共有しうるオリジンなので `meet.` 接頭辞は必須。 */
export const VIDEO_FIT_STORAGE_KEY = 'meet.videoFit';

/** 既定。会話の没入感を優先する（黒帯が出ない）。 */
export const DEFAULT_VIDEO_FIT: VideoFit = 'cover';

/** 切替時に出す小さなヒントチップの表示時間。 */
export const VIDEO_FIT_HINT_MS = 1200;

/** タップごとに cover ⇄ contain。純関数（テストで固定）。 */
export function nextVideoFit(current: VideoFit): VideoFit {
  return current === 'cover' ? 'contain' : 'cover';
}

/**
 * Tailwind のクラス。
 * ⚠️ Tailwind の抽出はソースの**リテラル文字列**を見るので、分岐ごとに完全な形で書く
 *   （speaking-highlight.ts の注意書きと同じ理由）。
 */
export function videoFitClass(fit: VideoFit): 'object-cover' | 'object-contain' {
  return fit === 'contain' ? 'object-contain' : 'object-cover';
}

/** 保存値のパース。知らない値・欠損は既定へ倒す（壊れた値で表示が壊れない）。 */
export function parseVideoFit(raw: unknown): VideoFit {
  return raw === 'contain' ? 'contain' : DEFAULT_VIDEO_FIT;
}

/**
 * sessionStorage から読む。SSR・プライベートブラウジング・容量超過など、
 * どの失敗でも既定へ倒すだけで例外は投げない（表示の好みごときで画面を落とさない）。
 */
export function loadVideoFit(): VideoFit {
  if (typeof window === 'undefined') return DEFAULT_VIDEO_FIT;
  try {
    return parseVideoFit(window.sessionStorage.getItem(VIDEO_FIT_STORAGE_KEY));
  } catch {
    return DEFAULT_VIDEO_FIT;
  }
}

/** sessionStorage へ書く。失敗しても黙って諦める（上と同じ理由）。 */
export function saveVideoFit(fit: VideoFit): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(VIDEO_FIT_STORAGE_KEY, fit);
  } catch {
    // ignore
  }
}
