/**
 * モバイル／デスクトップ**レイアウト分岐の切替を遅延確定**させる去抖（2026-08-14）。
 *
 * ============ なぜ必要か ============
 * VideoGrid の分岐は CSS の出し分けではなく JS（matchMedia）による**排他分岐**で、
 * ParticipantTile は `attachRemoteVideo` を副作用に持つ。端末を回した瞬間、
 * `(max-width: 767px) and (min-height: 450px)` は
 *   縦 → （回転アニメーション中の中間サイズ）→ 横
 * と**短時間に何度も反転しうる**。その都度レイアウトを作り直すと、
 * 映像タイルが detach → attach を連打され、環境（Android の国産ブラウザ／WebView）に
 * よってはそこで映像が戻ってこなくなる＝実機で報告された「揺らしたら真っ黒」。
 *
 * 対策は二段構えで、こちらは**二段目**：
 *   一段目 … VideoGrid の DOM 構造を統一して、そもそも分岐で**タイルを再マウントさせない**
 *            （React が key で同一視できる形にする。こちらが本命の修正）
 *   二段目 … それでも走る再レンダーの回数自体を、この去抖で落とす（本ファイル）
 *
 * ============ 意味論（テストで固定する挙動）============
 *  - **初期値は即決**。マウント直後に 150ms も間違ったレイアウトを見せない。
 *  - 現在の確定値と同じ値が来たら、**保留中の切替を取り消す**（行って戻ってきた＝揺れ）。
 *  - 違う値が来たら delayMs 後に確定。確定前にさらに違う値が来たらタイマーを引き直す
 *    ＝「delayMs のあいだ落ち着いていた値」だけが確定する。
 *
 * タイマーは注入可能にしてある（vitest は node 環境なので、偽タイマーを差して
 * tests/room/layout-flip.test.ts が時間を完全に支配できるようにするため）。
 */

/**
 * 落ち着き待ちの時間。回転アニメーションは端末により 200〜400ms 程度だが、
 * ここで待ちたいのは「アニメーション全体」ではなく「クエリが反転しきる瞬間」なので
 * 150ms で足りる。長くするとレイアウト確定の体感遅れが目立ちはじめる。
 */
export const LAYOUT_FLIP_DEBOUNCE_MS = 150;

/** 注入されるタイマーのハンドル（node の Timeout でも number でもよい）。 */
type TimerHandle = unknown;

export interface LayoutFlipDebouncer {
  /** matchMedia から届いた新しい値を投げ込む。 */
  request(next: boolean): void;
  /** 保留中の切替を破棄する（アンマウント時）。 */
  cancel(): void;
  /** 現在**確定している**値（テスト・デバッグ用）。 */
  current(): boolean;
}

export interface LayoutFlipDebouncerOptions {
  /** マウント時に読んだ初期値。これは去抖せず即座に確定値になる。 */
  initial: boolean;
  /** 確定したときに呼ばれる。初期値では呼ばれない（呼び出し側が既に知っている）。 */
  commit: (value: boolean) => void;
  /** 既定 LAYOUT_FLIP_DEBOUNCE_MS */
  delayMs?: number;
  schedule?: (fn: () => void, ms: number) => TimerHandle;
  clear?: (handle: TimerHandle) => void;
}

export function createLayoutFlipDebouncer(options: LayoutFlipDebouncerOptions): LayoutFlipDebouncer {
  const delayMs = options.delayMs ?? LAYOUT_FLIP_DEBOUNCE_MS;
  const schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const clear = options.clear ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let committed = options.initial;
  let pendingValue: boolean | null = null;
  let handle: TimerHandle | null = null;

  function clearPending(): void {
    if (handle !== null) clear(handle);
    handle = null;
    pendingValue = null;
  }

  return {
    request(next: boolean): void {
      if (next === committed) {
        // 揺れて元に戻っただけ。保留を捨てて何もしない（＝再レンダーを一切起こさない）。
        clearPending();
        return;
      }
      if (pendingValue === next) return; // 同じ向きの保留が既にある：引き直すと永久に確定しない
      clearPending();
      pendingValue = next;
      handle = schedule(() => {
        handle = null;
        pendingValue = null;
        committed = next;
        options.commit(next);
      }, delayMs);
    },
    cancel: clearPending,
    current: () => committed,
  };
}
