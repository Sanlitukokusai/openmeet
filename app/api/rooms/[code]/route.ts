import { NextResponse, type NextRequest } from 'next/server'
import { getRouteAuth } from '@/lib/server/auth'
import { getServiceClient } from '@/lib/supabase.server'
import { hashRoomPassword } from '@/lib/server/password'
import { apiError } from '@/lib/server/api-response'
import { patchRoomSchema, toRoomDTO } from '@/lib/server/rooms-logic'
import type { Database } from '@/lib/database.types'

// ⚠️ 動的セグメント名について（Next.js 制約）：
// 規格書 §6.1 は `/api/rooms/{id}`（uuid）、§6.2 は `/api/rooms/{roomCode}` と
// 別々の呼び名を使うが、Next.js App Router は**同一階層で異なる動的セグメント名を
// 許さない**（`[id]` と `[roomCode]` の併存はビルドエラー）。そこで物理ディレクトリは
// 中立な `[code]` に統一し、**各 handler が自分の解釈を持つ**：
//   - 本ファイル（GET/PATCH/DELETE）と end/route.ts は uuid として解釈（§6.1、URL 契約は不変）
//   - meta/route.ts と join/route.ts は roomCode として解釈（§6.2）
type RouteParams = { params: Promise<{ code: string }> }

type RoomUpdate = Database['meet']['Tables']['rooms']['Update']

// GET/PATCH の 200 応答 `{ ...room }` を組み立てるのに必要な列だけを明示的に select する。
// password_hash / owner_id / media_room_name / media_provider はここでも一切選択しない
// （password_hash は hasPassword 判定にのみ使い、レスポンスには出さない）。
const ROOM_SELECT =
  'id, room_code, title, status, password_hash, max_participants, require_login, scheduled_at, expires_at, created_at, updated_at'

/**
 * 会議室の詳細取得（規格书 §6.1 には明記の無い補助エンドポイント）。
 * WP-7：ダッシュボードの編集フォームは GET /api/rooms（一覧）の白名单
 * {id, roomCode, title, status, scheduledAt, expiresAt} だけでは
 * maxParticipants / requireLogin / hasPassword が欠けてプリフィルできないため追加。
 * PATCH/DELETE と全く同じ `id` + `owner_id` 絞り込みにすることで、他人の部屋も
 * 存在しない部屋も同じ 0 行ヒット＝404 にする（存在探査防止、§6.1 と同じ設計を踏襲）。
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  const { code: id } = await params
  const { user } = await getRouteAuth()
  if (!user) return apiError(401, 'UNAUTHORIZED', 'ログインが必要です')

  const { data, error } = await getServiceClient()
    .from('rooms')
    .select(ROOM_SELECT)
    .eq('id', id)
    .eq('owner_id', user.id)
    .maybeSingle()

  if (error) {
    console.error('[api/rooms/:id] get failed', error)
    return apiError(500, 'INTERNAL_ERROR', 'ルームの取得に失敗しました')
  }
  if (!data) {
    return apiError(404, 'ROOM_NOT_FOUND', 'ルームが見つかりません')
  }

  return NextResponse.json(toRoomDTO(data, new Date()))
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const { code: id } = await params
  const { user } = await getRouteAuth()
  if (!user) return apiError(401, 'UNAUTHORIZED', 'ログインが必要です')

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return apiError(400, 'VALIDATION_ERROR', '不正な JSON です')
  }

  const parsed = patchRoomSchema.safeParse(body)
  if (!parsed.success) {
    return apiError(400, 'VALIDATION_ERROR', parsed.error.issues[0]?.message ?? '入力内容を確認してください')
  }
  const input = parsed.data

  const updatePayload: RoomUpdate = {}
  if (input.title !== undefined) updatePayload.title = input.title
  if (input.maxParticipants !== undefined) updatePayload.max_participants = input.maxParticipants
  if (input.requireLogin !== undefined) updatePayload.require_login = input.requireLogin
  if (input.expiresAt !== undefined) {
    updatePayload.expires_at = input.expiresAt === null ? null : input.expiresAt.toISOString()
  }
  if (input.password !== undefined) {
    updatePayload.password_hash = input.password === null ? null : await hashRoomPassword(input.password)
  }

  // update+select を owner_id で絞った 1 クエリにすることで select→update 間の
  // TOCTOU を避け、かつ「他人の部屋」も「存在しない部屋」も同じ 0 行ヒットにする
  // ——他人房间返回 404 而非 403（規格书 §6.1）。
  const { data, error } = await getServiceClient()
    .from('rooms')
    .update(updatePayload)
    .eq('id', id)
    .eq('owner_id', user.id)
    .select(ROOM_SELECT)
    .maybeSingle()

  if (error) {
    console.error('[api/rooms/:id] patch failed', error)
    return apiError(500, 'INTERNAL_ERROR', 'ルームの更新に失敗しました')
  }
  if (!data) {
    return apiError(404, 'ROOM_NOT_FOUND', 'ルームが見つかりません')
  }

  return NextResponse.json(toRoomDTO(data, new Date()))
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  const { code: id } = await params
  const { user } = await getRouteAuth()
  if (!user) return apiError(401, 'UNAUTHORIZED', 'ログインが必要です')

  // ソフトデリート：status = 'disabled'（規格书 §6.1 DELETE）。
  const { data, error } = await getServiceClient()
    .from('rooms')
    .update({ status: 'disabled' })
    .eq('id', id)
    .eq('owner_id', user.id)
    .select('id')
    .maybeSingle()

  if (error) {
    console.error('[api/rooms/:id] delete failed', error)
    return apiError(500, 'INTERNAL_ERROR', 'ルームの削除に失敗しました')
  }
  if (!data) {
    return apiError(404, 'ROOM_NOT_FOUND', 'ルームが見つかりません')
  }

  return new NextResponse(null, { status: 204 })
}
