/**
 * ローカルカメラの**自己修復**判定（2026-08-14 実機フィードバック
 * 「カメラを付けたまま端末を揺らしたら真っ黒になって、こちらが見えなくなる」）。
 *
 * ============ なぜ純関数として切り出すのか ============
 * mapping.ts / chat.ts / background.ts と同じ規律：
 *   - `livekit-client` の**ランタイムは引かない**（型すら引かない。ここが受け取るのは
 *     すべて素の値＝boolean と 'live' | 'ended' の文字列）。provider 本体は
 *     livekit-client を静的 import しているので node 環境の vitest では起動すらしない。
 *   - よって「いつ再起動するか」という**一番間違えたくない判断**だけをここに置き、
 *     tests/media/camera-health.test.ts が全マトリクスを固定する。
 *
 * ============ 何が起きているのか（現象の整理）============
 * Android の国産ブラウザ / WebView や iOS Safari では、次のような場面で
 * **ブラウザが勝手にカメラの供給を止める**ことがある：
 *   - タブがバックグラウンドに回る（別アプリ・ホーム画面・着信）
 *   - スクロールでアドレスバーが畳まれる／回転でビューポートが作り直される
 *   - 端末がカメラを他アプリに明け渡す（省電力・熱・カメラ排他）
 * このとき裏の `MediaStreamTrack` は
 *   - `readyState === 'ended'`（**完全に死ぬ**。二度と復活しない＝再取得が必要）か、
 *   - `muted === true`（**一時停止**。前面に戻れば普通は自分で `unmute` して回復する）
 * のどちらかになる。前者を放置すると「映像は真っ黒／相手からは固まったまま」になり、
 * しかも LiveKit 側の `isCameraEnabled` は publication が残っているので **true のまま**
 * ——つまり UI からは「カメラはオンです」という顔をし続ける。これが今回の黒画面。
 *
 * ============ 絶対に踏んではいけない一線 ============
 * **ユーザーが自分でカメラを切ったときに、勝手に点け直してはならない。**
 * これは「うっかり相手に映る」というプライバシー事故そのもので、黒画面よりずっと重い。
 * だから判定の順番として `desiredEnabled`（＝直近にユーザーが望んだ状態）のチェックを
 * 死活判定より**手前**に置く（meeting-store の micIntent と同じ思想：
 * 取りこぼしは軽傷、誤検知は重傷、なので迷ったら「何もしない」に倒す）。
 */

// ============================================================
// 1. 定数
// ============================================================

/**
 * 自己修復の**スロットル**。一度試したら次の試行までこの間隔を空ける。
 *
 * カメラを取り戻せない理由（他アプリが掴んでいる・OS に権限を剥がされた）は
 * 数百 ms で変わるものではない。連打すると `getUserMedia` の失敗ループになって
 * 電池と CPU を焼くだけなので、1 回試して駄目なら間を置く。
 */
export const CAMERA_RECOVERY_THROTTLE_MS = 10_000;

/**
 * 前面復帰後、ブラウザが**自力で** `unmute` するのを待つ猶予。
 *
 * `visibilitychange` が飛んだ瞬間はまだ `muted === true` のことが普通にある
 * （復帰処理はブラウザ側でも非同期）。ここで即断すると、放っておけば直るものを
 * わざわざ再取得して**画面を一瞬黒くする**という本末転倒になる。
 */
export const CAMERA_RESUME_SETTLE_MS = 700;

/**
 * 「短時間に何度も壊れている」を判定する窓。背景効果の切り離し（§3）に使う。
 */
export const CAMERA_RECOVERY_WINDOW_MS = 60_000;

/** この窓の中でこの回数以上の再起動が起きたら、背景効果を犯人とみなす（§3）。 */
export const BACKGROUND_FALLBACK_THRESHOLD = 2;

// ============================================================
// 2. 死活判定
// ============================================================

/**
 * 判定を要求した文脈。同じ「`muted === true`」でも意味が違うので区別する：
 *  - `track-event`：トラック側のイベント（ended / mute）で叩かれた。
 *    mute はまだ一時停止の可能性が高い → **触らない**。
 *  - `resume`：前面復帰（visibilitychange / pageshow）＋ 落ち着き待ち後の点検。
 *    ここでまだ mute のままなら自力復帰に失敗している → **壊れている**扱い。
 */
export type CameraHealthPhase = 'track-event' | 'resume';

export interface CameraHealthInput {
  phase: CameraHealthPhase;
  /** 会議に繋がっているか（切断中は再取得しても publish 先が無い） */
  connected: boolean;
  /**
   * ユーザーが「カメラはオンであってほしい」と最後に表明した状態。
   * `setCameraEnabled(true)` / 入室時の `initialVideo` で true、
   * `setCameraEnabled(false)` で false。**これが false なら何があっても触らない。**
   */
  desiredEnabled: boolean;
  /** provider が今カメラ track を持っているか（オフにすると publication ごと消える） */
  hasCameraTrack: boolean;
  /** LiveKit の publication が muted か（ユーザー/遠隔ミュート＝トラックは生きている） */
  publicationMuted: boolean;
  /** 裏の `MediaStreamTrack.readyState`。取得できないときは undefined */
  readyState: 'live' | 'ended' | undefined;
  /** 裏の `MediaStreamTrack.muted`（ブラウザがフレーム供給を止めている） */
  browserMuted: boolean;
  /** 直近に自己修復を試みた時刻（未試行なら undefined） */
  lastAttemptAt: number | undefined;
  now: number;
  /** 既定 CAMERA_RECOVERY_THROTTLE_MS */
  throttleMs?: number;
}

/** 「何もしない」理由。ログ・テストの可読性のために全部名前を付ける。 */
export type CameraHealthSkipReason =
  /** 未接続（再接続後に改めて点検される） */
  | 'not_connected'
  /** ユーザーが自分でカメラを切っている——**最優先の抑止**（勝手に点けない） */
  | 'user_disabled'
  /** そもそも track が無い（オフ直後・権限拒否後）。修復対象が存在しない */
  | 'no_track'
  /** ミュート中（ユーザー操作 or 遠隔）。トラックは生きているので壊れていない */
  | 'track_muted'
  /** 一時停止（mute）だが、まだ自力復帰の可能性がある段階 */
  | 'transient_mute'
  /** 直近に試したばかり */
  | 'throttled'
  /** 正常 */
  | 'healthy';

export type CameraBreakReason =
  /** `readyState === 'ended'`：完全に死んでいる。再取得以外に手が無い */
  | 'track_ended'
  /** 前面に戻ったのに mute のまま：自力復帰に失敗している */
  | 'stalled_after_resume';

export type CameraHealthDecision =
  | { action: 'none'; reason: CameraHealthSkipReason }
  | { action: 'restart'; reason: CameraBreakReason };

/**
 * カメラを再取得すべきか。**判定順が仕様そのもの**なので、並べ替えないこと。
 *
 * 1. 未接続 → 何もしない
 * 2. **ユーザーがオフにしている → 何もしない**（プライバシーの一線。§ファイル冒頭）
 * 3. track が無い → 修復対象が無い
 * 4. ミュート中 → 壊れていない（遠隔ミュートを「故障」と誤認しない）
 * 5. ended → 壊れている
 * 6. mute のまま前面復帰後 → 壊れている / それ以外の mute → 待つ
 * 7. 上記で壊れていても、直近に試していたらスロットル
 */
export function decideCameraHealth(input: CameraHealthInput): CameraHealthDecision {
  if (!input.connected) return { action: 'none', reason: 'not_connected' };
  if (!input.desiredEnabled) return { action: 'none', reason: 'user_disabled' };
  if (!input.hasCameraTrack) return { action: 'none', reason: 'no_track' };
  if (input.publicationMuted) return { action: 'none', reason: 'track_muted' };

  let broken: CameraBreakReason | null = null;
  if (input.readyState === 'ended') {
    broken = 'track_ended';
  } else if (input.browserMuted) {
    if (input.phase !== 'resume') return { action: 'none', reason: 'transient_mute' };
    broken = 'stalled_after_resume';
  }
  if (!broken) return { action: 'none', reason: 'healthy' };

  const throttleMs = input.throttleMs ?? CAMERA_RECOVERY_THROTTLE_MS;
  if (input.lastAttemptAt !== undefined && input.now - input.lastAttemptAt < throttleMs) {
    return { action: 'none', reason: 'throttled' };
  }
  return { action: 'restart', reason: broken };
}

// ============================================================
// 3. 背景効果を道連れにするかの判定
// ============================================================

/** 窓 `windowMs` の中に収まる試行だけ残す（provider が履歴を無限に伸ばさないため）。 */
export function pruneRecoveryAttempts(
  attempts: readonly number[],
  now: number,
  windowMs: number = CAMERA_RECOVERY_WINDOW_MS,
): number[] {
  return attempts.filter((at) => now - at < windowMs);
}

/**
 * 自己修復のついでに背景効果を切るべきか。
 *
 * 一度目の故障では**切らない**——大半は「他アプリにカメラを取られた」「バックグラウンドに
 * 回った」であって、背景処理管線とは無関係だから。ここで毎回背景を落とすと、
 * ちょっと裏に回っただけで設定が飛ぶという別の不満になる。
 *
 * 一方、同じ窓の中で**繰り返し**壊れるなら、疑うべきは常駐している処理管線の側
 * （WebGL コンテキストロスト、MediaPipe の異常終了、GPU メモリ逼迫）。
 * `@livekit/track-processors` 0.7.2 は運行期エラーを外に投げるイベント/コールバックを
 * 持たない（調査結果は最終レポート参照）ので、「壊れ方の繰り返し」を唯一の観測点として
 * 管線を犯人と見なし、**カメラ本体を生かすために**効果を捨てる。
 */
export function shouldDropBackgroundEffect(input: {
  /** 今まさに背景効果が掛かっているか */
  backgroundActive: boolean;
  /** 窓の中の試行回数（**今回の試行を含む**） */
  recentAttempts: number;
  /** 既定 BACKGROUND_FALLBACK_THRESHOLD */
  threshold?: number;
}): boolean {
  if (!input.backgroundActive) return false;
  return input.recentAttempts >= (input.threshold ?? BACKGROUND_FALLBACK_THRESHOLD);
}
