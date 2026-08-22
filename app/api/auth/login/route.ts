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
  const { data, error } = await supabase.auth.signInWithPassword(parsed.data)

  if (error) {
    return apiError(error.status ?? 401, 'AUTH_FAILED', error.message)
  }

  return NextResponse.json({ user: { id: data.user.id, email: data.user.email } })
}
