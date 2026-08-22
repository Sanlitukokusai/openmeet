// @supabase/ssr 官方 middleware 模式：每个请求刷新一次 session（token 快过期时
// 自动 refresh 并把新 cookie 写回响应），并对未登录访问的受保护路径做 302 重定向。
// 参考：https://supabase.com/docs/guides/auth/server-side/nextjs
import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

const PROTECTED_PREFIXES = ['/dashboard', '/rooms/new']

export async function middleware(request: NextRequest) {
  // ミドルウェアでは next/headers が使えないため、NextRequest/NextResponse の
  // cookies API を直接ラップする（Route Handler 用の lib/server/auth.ts とは
  // 別実装になるのが公式パターン）。
  let response = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet, headers) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          response = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options))
          // @supabase/ssr が auth cookie 更新時に付与する Cache-Control 等を反映
          // ——CDN/リバースプロキシに認証レスポンスがキャッシュされるのを防ぐ。
          Object.entries(headers).forEach(([key, value]) => response.headers.set(key, value))
        },
      },
    },
  )

  const {
    data: { user },
  } = await supabase.auth.getUser()

  const isProtected = PROTECTED_PREFIXES.some((prefix) => request.nextUrl.pathname.startsWith(prefix))
  if (isProtected && !user) {
    // ログイン後に元のページへ戻せるよう ?next= を付与する（/login 側で
    // safeNextPath によりサイト内パスのみ許可＝オープンリダイレクト対策）。
    const loginUrl = new URL('/login', request.url)
    loginUrl.searchParams.set('next', request.nextUrl.pathname + request.nextUrl.search)
    return NextResponse.redirect(loginUrl)
  }

  return response
}

export const config = {
  matcher: ['/dashboard/:path*', '/rooms/new/:path*'],
}
