/**
 * 言語（locale）のグローバル状態（WP-8：中日文手动切换）。
 *
 * 優先順位：localStorage('meet.locale') の手動選択 > navigator.language 推定
 * （'zh' 始まり→中国語、それ以外→日本語） > 'ja'。
 *
 * ⚠️ SSR / クライアント初回レンダーは常に 'ja' で固定する（サーバーは
 * localStorage も navigator も知らない）。実際の解決は hydrate() 呼び出し時
 * （lib/ui-text.ts の useLocale() が마운트 후 useEffect で一度だけ呼ぶ）まで遅らせる
 * ——モジュール読み込み時（トップレベル）に window/localStorage/navigator を読むと、
 * サーバー側の描画結果と クライアント初回レンダーが食い違い hydration mismatch を
 * 起こす（WP-4 時代の detectLocale() が同じ理由で「マウント後に一度だけ补正」する
 * 設計だったのを踏襲）。
 *
 * ⚠️ Locale 型は lib/ui-text.ts から `import type` のみで取り込む（値は import しない）。
 * 型 import はコンパイル時に消えるため、ui-text.ts → 本ファイルへの実行時 import と
 * 合わせても循環importにならない。ブラウザ言語判定ロジック自体も detectLocale() を
 * import せず自前で複製している（3 行程度なので、依存を増やすより複製の方が安全）。
 */
import { create } from 'zustand'
import type { Locale } from '@/lib/ui-text'

const STORAGE_KEY = 'meet.locale'

function isLocale(value: string | null | undefined): value is Locale {
  return value === 'ja' || value === 'zh'
}

/** lib/ui-text.ts の detectLocale() と同じ判定基準（意図的な複製。上のコメント参照）。 */
function detectBrowserLocale(): Locale {
  if (typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('zh')) {
    return 'zh'
  }
  return 'ja'
}

function readStoredLocale(): Locale | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return isLocale(stored) ? stored : null
  } catch {
    // Safari のプライベートブラウズ等でアクセス自体が例外を投げることがある。
    // 保存された選択が読めないだけなので、ブラウザ言語推定にフォールバックする。
    return null
  }
}

function writeStoredLocale(locale: Locale): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, locale)
  } catch {
    // 書き込めなくても今回の切り替え自体は画面に反映済み——次回リロード時に
    // 覚えていないだけなので、機能停止させるほどではない。
  }
}

function applyDocumentLang(locale: Locale): void {
  if (typeof document === 'undefined') return
  document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'ja'
}

/** localStorage の手動選択 > ブラウザ言語推定 > 'ja' の優先順位で実際のロケールを解決する。
 *  純関数として export しておき、store の hydrate() 実装とは独立にユニットテストできる
 *  ようにする（tests/ui/locale-store.test.ts）。 */
export function resolveInitialLocale(): Locale {
  return readStoredLocale() ?? detectBrowserLocale()
}

interface LocaleStoreState {
  locale: Locale
  /** hydrate() が一度でも実行済みか。二重実行自体は無害（同じ値を再計算するだけ）だが、
   *  意図を明確にするために保持する。 */
  hasHydrated: boolean
  /** ユーザーの手動選択。localStorage に永続化し、<html lang> も同期する。 */
  setLocale: (locale: Locale) => void
  /** クライアントマウント後に一度だけ呼ぶ：実際の値（localStorage/ブラウザ言語）に補正する。 */
  hydrate: () => void
}

export const useLocaleStore = create<LocaleStoreState>((set, get) => ({
  // SSR と初回クライアントレンダーの両方でこの値になる（hydration mismatch 回避）。
  locale: 'ja',
  hasHydrated: false,

  setLocale: (locale) => {
    set({ locale, hasHydrated: true })
    writeStoredLocale(locale)
    applyDocumentLang(locale)
  },

  hydrate: () => {
    if (get().hasHydrated) return
    const resolved = resolveInitialLocale()
    set({ locale: resolved, hasHydrated: true })
    applyDocumentLang(resolved)
  },
}))
