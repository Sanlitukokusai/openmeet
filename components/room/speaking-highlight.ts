/**
 * 「発言中」のハイライト用 class（2026-08-07 第 2 波・実機バグ修正）。
 *
 * ★ なぜ独立モジュールなのか（＝直接 className に書かない理由）
 *   当初は `animate-pulse` をタイルの**コンテナ**に直付けしていた。Tailwind の pulse は
 *   要素の **opacity を 100%↔50% で往復させる 2 秒アニメーション**なので、コンテナが
 *   点滅すると中身の `<video>` まで道連れで暗くなる——利用者には「相手が喋るたびに
 *   映像が呼吸灯のように明滅する」という不具合として見えた（実機フィードバック）。
 *
 *   直し方は「アニメーションを載せる要素を、映像を含まない**専用のオーバーレイ**に
 *   分離する」こと。オーバーレイはリングだけを持つ空の div なので、いくら点滅しても
 *   映像の明るさには一切影響しない。
 *
 *   class 計算をここに切り出したのは、tests/room/speaking-highlight.test.ts から
 *   「**映像の祖先になる class 群に animate-pulse が二度と混入しない**」ことを
 *   機械的に固定するため（vitest は node 環境で jsdom を持たないので、DOM ではなく
 *   純関数の戻り値で回帰を止める）。
 *
 * ⚠️ Tailwind の class 抽出はソースの**リテラル文字列**を見る。分岐ごとに完全な
 *   class 文字列をそのまま書き下すこと（`ring-${color}` のような部分文字列の合成を
 *   すると、そのクラスは生成されない）。
 */

/**
 * 遠端タイルのコンテナ（＝`<video>` の親）。
 *
 * ★ 発言中かどうかに関わらず **animate-pulse を含まない**。発言中の見た目は
 *   speakingOverlayClass() のオーバーレイが受け持つ。静的なリングだけをここに残すのは、
 *   発言の有無でリング幅が変わるとタイルの縁がガタつくため。
 */
export const TILE_CONTAINER_CLASS =
  'group relative flex aspect-video min-w-0 items-center justify-center overflow-hidden rounded-2xl bg-zinc-800 ring-1 ring-zinc-700 transition-shadow'

/**
 * フィルモード（モバイル専用、2026-08-14 実機フィードバック：竖屏レイアウト崩れの修正）。
 *
 * `aspect-video` を持たない——親（VideoGrid のモバイル分岐）が実サイズを与え、タイルは
 * 常にそれを `h-full w-full` で埋める（縦長画面で 16:9 の箱を強制すると上下に大きな
 * 余白ができてしまう、というのが今回の不具合の本体）。縁を丸めない・リングも省くのは、
 * 満屏（1 人）表示で縁取りが不自然に見えるのを避けるため——複数人グリッドでは
 * gap 自体が仕切りの役目を果たすので、装飾的なリングは無くても境界は分かる。
 *
 * ⚠️ TILE_CONTAINER_CLASS と同じ理由で animate-pulse は持たない（tests/room/speaking-highlight.test.ts
 * が両方を検査する）。
 */
export const TILE_CONTAINER_FILL_CLASS =
  'group relative flex h-full w-full min-w-0 min-h-0 items-center justify-center overflow-hidden bg-zinc-800 transition-shadow'

/**
 * 発言中リング（タイル用オーバーレイ）。`<video>` の**兄弟**として絶対配置し、
 * リングだけを描く。中身が無いので点滅しても暗くなるものが無い。
 *
 * @param reducedMotion prefers-reduced-motion:reduce のとき true → 静止リング
 */
export function speakingOverlayClass(reducedMotion: boolean): string {
  return reducedMotion
    ? 'pointer-events-none absolute inset-0 z-[5] rounded-2xl ring-2 ring-amber-400'
    : 'pointer-events-none absolute inset-0 z-[5] rounded-2xl ring-2 ring-amber-400 animate-pulse'
}

/**
 * 参加者一覧パネルのアバターに重ねる発言中リング。タイルと同じ理由——アバター本体に
 * animate-pulse を付けるとイニシャル文字まで明滅するので、リングだけを別要素に出す。
 * 形が円なので rounded-full なだけで、思想はタイル側と同一。
 */
export function speakingAvatarRingClass(reducedMotion: boolean): string {
  return reducedMotion
    ? 'pointer-events-none absolute inset-0 rounded-full ring-2 ring-amber-400'
    : 'pointer-events-none absolute inset-0 rounded-full ring-2 ring-amber-400 animate-pulse'
}
