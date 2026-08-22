import { NextResponse, type NextRequest } from 'next/server'
import { getRouteAuth } from '@/lib/server/auth'
import { getServiceClient } from '@/lib/supabase.server'
import { hashRoomPassword } from '@/lib/server/password'
import { apiError } from '@/lib/server/api-response'
import { generateRoomCode } from '@/lib/room-code'
import { getCapacitySnapshot } from '@/lib/server/capacity'
import { getRoomOccupancy } from '@/lib/server/livekit'
import { hasGlobalHeadroom, SERVER_AT_CAPACITY_MESSAGE } from '@/lib/server/join-policy'
import type { Database } from '@/lib/database.types'
import {
  buildJoinUrl,
  buildMediaRoomName,
  createRoomSchema,
  resolveActiveParticipants,
  resolveJoinBaseUrl,
  toRoomCreateResponse,
  toRoomListItem,
} from '@/lib/server/rooms-logic'

type RoomInsert = Database['meet']['Tables']['rooms']['Insert']

// room_code / media_room_name の一意制約に稀に衝突した場合の再試行回数上限。
// nanoid(10) の英数字空間からすれば天文学的に低確率だが、保険として入れておく。
const MAX_ROOM_CODE_RETRIES = 5

export async function POST(request: NextRequest) {
  const { user } = await getRouteAuth()
  if (!user) return apiError(401, 'UNAUTHORIZED', 'ログインが必要です')

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return apiError(400, 'VALIDATION_ERROR', '不正な JSON です')
  }

  const parsed = createRoomSchema.safeParse(body)
  if (!parsed.success) {
    return apiError(400, 'VALIDATION_ERROR', parsed.error.issues[0]?.message ?? '入力内容を確認してください')
  }
  const input = parsed.data

  // ---- 全局容量闸（2026-08-07）----
  // 位置の理由：**session 検証と入力検証の後、bcrypt と INSERT の前**。
  //   - 未ログイン / 壊れた入力には、混雑を語る前にそちらを答えるべき（401・400 が先）
  //   - 満杯なら会議室を作らせない以上、bcrypt を回すのも DB に書くのも無駄
  // 統計源が全滅していたら通す（フェイルオープン——理由は join-policy.ts の
  // hasGlobalHeadroom() のコメント）。
  const capacity = await getCapacitySnapshot()
  if (!hasGlobalHeadroom(capacity.current, capacity.max)) {
    return apiError(503, 'SERVER_AT_CAPACITY', SERVER_AT_CAPACITY_MESSAGE)
  }

  const passwordHash = input.password ? await hashRoomPassword(input.password) : null

  let lastError: unknown = null
  for (let attempt = 0; attempt < MAX_ROOM_CODE_RETRIES; attempt++) {
    const roomCode = generateRoomCode()
    const insertPayload: RoomInsert = {
      owner_id: user.id,
      room_code: roomCode,
      title: input.title,
      media_room_name: buildMediaRoomName(roomCode),
      password_hash: passwordHash,
    }
    if (input.maxParticipants !== undefined) insertPayload.max_participants = input.maxParticipants
    if (input.requireLogin !== undefined) insertPayload.require_login = input.requireLogin
    if (input.scheduledAt !== undefined) insertPayload.scheduled_at = input.scheduledAt.toISOString()
    if (input.expiresAt !== undefined) insertPayload.expires_at = input.expiresAt.toISOString()

    const { data: row, error } = await getServiceClient()
      .from('rooms')
      .insert(insertPayload)
      .select('id, room_code, expires_at')
      .single()

    if (!error && row) {
      const baseUrl = resolveJoinBaseUrl(process.env.APP_DOMAIN, {
        forwardedHost: request.headers.get('x-forwarded-host'),
        forwardedProto: request.headers.get('x-forwarded-proto'),
        hostHeader: request.headers.get('host'),
        fallbackOrigin: request.nextUrl.origin,
      })
      const joinUrl = buildJoinUrl(baseUrl, row.room_code)
      return NextResponse.json(toRoomCreateResponse(row, joinUrl), { status: 201 })
    }

    lastError = error
    // 23505 = unique_violation（room_code か media_room_name の衝突）のときだけ
    // コードを引き直して再試行。それ以外のエラーは即座に諦める。
    const pgCode = error && typeof error === 'object' ? (error as { code?: string }).code : undefined
    if (pgCode !== '23505') break
  }

  console.error('[api/rooms] create failed', lastError)
  return apiError(500, 'INTERNAL_ERROR', 'ルームの作成に失敗しました')
}

export async function GET() {
  const { user } = await getRouteAuth()
  if (!user) return apiError(401, 'UNAUTHORIZED', 'ログインが必要です')

  // ---- 在線人数の付与（2026-08-07）----
  // media_room_name を select に足すのは**写像のキーに使うためだけ**。DTO には
  // 絶対に載せない（toRoomListItem の白名单が守る／単測で漏洩を固定してある）。
  //
  // LiveKit 側は listRooms 1 回で全部屋分をまとめて取る。DB クエリと**並列**に投げるので、
  // この機能追加で一覧の応答時間は伸びない（遅い方に律速するだけ）。
  // getRoomOccupancy() は到達不能を null で返し例外を投げない契約なので、
  // **メディアサーバーが落ちていても一覧そのものは 200 で返る**（人数だけ「不明」になる）。
  const [listResult, occupancy] = await Promise.all([
    getServiceClient()
      .from('rooms')
      .select('id, room_code, title, status, scheduled_at, expires_at, media_room_name')
      .eq('owner_id', user.id)
      // 2026-08-17 ユーザー要望：削除済み（ソフトデリート）の部屋は一覧に出さない。
      // DB の行は監査のため残す（DELETE ハンドラは従来どおり status='disabled' に
      // するだけ）。一覧から消えるので、フロントの「削除済み」表示・全操作 disabled の
      // 行はもう通常経路では現れない（防御的に残置）。
      .neq('status', 'disabled')
      .order('created_at', { ascending: false }),
    getRoomOccupancy(),
  ])

  const { data, error } = listResult
  if (error) {
    console.error('[api/rooms] list failed', error)
    return apiError(500, 'INTERNAL_ERROR', 'ルーム一覧の取得に失敗しました')
  }

  const now = new Date()
  const rooms = (data ?? []).map((row) =>
    toRoomListItem(row, now, resolveActiveParticipants(occupancy, row.media_room_name)),
  )
  return NextResponse.json({ rooms })
}
