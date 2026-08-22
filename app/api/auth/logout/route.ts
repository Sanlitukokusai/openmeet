import { NextResponse } from 'next/server'
import { createSupabaseRouteClient } from '@/lib/server/auth'
import { apiError } from '@/lib/server/api-response'

export async function POST() {
  const supabase = await createSupabaseRouteClient()
  const { error } = await supabase.auth.signOut()

  if (error) {
    return apiError(400, 'AUTH_FAILED', error.message)
  }

  return NextResponse.json({ ok: true })
}
