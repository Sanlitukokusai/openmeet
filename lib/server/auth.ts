// Supabase Auth のサーバー側クライアント（規格书 §8.3 铁律：浏览器零直连 Supabase）。
// Route Handlers / Server Actions 専用——next/headers の cookies() が書き込み可能な
// コンテキストであることに依存する（Server Component から呼ぶと `.set()` で例外になる）。
import 'server-only'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import type { User } from '@supabase/supabase-js'
import { z } from 'zod'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
// SUPABASE_ANON_KEY は意図的に NEXT_PUBLIC_ プレフィックスなし（lib/supabase.ts 参照）。
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY!

/**
 * リクエストごとに新規作成すること（Supabase 公式の要求）。シングルトン化しない。
 * setAll は next/headers の cookieStore に書き込むだけで、Next.js が Route Handler /
 * Server Action のレスポンスへ自動的に Set-Cookie を反映する。
 */
export async function createSupabaseRouteClient() {
  const cookieStore = await cookies()
  return createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll()
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value, options }) => {
          cookieStore.set(name, value, options)
        })
      },
    },
  })
}

export interface RouteAuth {
  supabase: Awaited<ReturnType<typeof createSupabaseRouteClient>>
  user: User | null
}

/**
 * Route Handler で「現在ログイン中のユーザー」を取得する。
 * getSession() ではなく getUser() を使う——後者は Supabase Auth サーバーに
 * 問い合わせて JWT を検証するため、cookie の中身を無条件に信用しない。
 */
export async function getRouteAuth(): Promise<RouteAuth> {
  const supabase = await createSupabaseRouteClient()
  const { data, error } = await supabase.auth.getUser()
  return { supabase, user: error ? null : data.user }
}

/** /api/auth/login, /api/auth/signup 共通のリクエストボディ検証。 */
export const authCredentialsSchema = z.object({
  email: z.email('メールアドレスの形式が正しくありません'),
  // Supabase Auth のデフォルト最小長も 6 文字。
  password: z.string().min(6, 'パスワードは6文字以上で入力してください'),
})
export type AuthCredentials = z.infer<typeof authCredentialsSchema>
