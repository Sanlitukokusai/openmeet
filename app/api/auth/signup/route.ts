import { NextResponse } from 'next/server'
import { createSupabaseRouteClient, authCredentialsSchema } from '@/lib/server/auth'
import { apiError } from '@/lib/server/api-response'

export async function POST(request: Request) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return apiError(400, 'VALIDATION_ERROR', '不正な JSON です')
  }

  const parsed = authCredentialsSchema.safeParse(body)
  if (!parsed.success) {
    return apiError(400, 'VALIDATION_ERROR', parsed.error.issues[0]?.message ?? '入力内容を確認してください')
  }

  const supabase = await createSupabaseRouteClient()
  const { data, error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
  })

  if (error) {
    return apiError(error.status ?? 400, 'AUTH_FAILED', error.message)
  }

  // 共享 Supabase 实例的「确认邮箱」设置是全局的，本项目不得修改（CLAUDE.md 硬规则）。
  // 若该设置处于开启状态，signUp 成功但 session 为 null，需前端提示用户先查收确认邮件。
  const needsEmailConfirmation = data.session === null

  return NextResponse.json(
    {
      user: data.user ? { id: data.user.id, email: data.user.email } : null,
      needsEmailConfirmation,
    },
    { status: 201 },
  )
}
