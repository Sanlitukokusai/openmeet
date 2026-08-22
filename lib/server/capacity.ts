// 全局同時接続数の統計（2026-08-07 追加）。
//
// 背景：公網出口帯域が 40 Mbps しかない（docs/SERVER-FACTS.md）。SFU の出方向は
// 参加人数の二乗で効くため、サーバー全体の在線人数に天井を設けないと、部屋を
// 増やされるだけで全会議が同時に劣化する。§12.8 の max_participants は
// 「1 部屋の中の上限」でしかなく、この穴は塞げない。
//
// ここは **IO 層**——判定は lib/server/join-policy.ts の checkGlobalCapacity()
// （純関数、全数マトリクス単測あり）。本ファイルは「今何人か」を取ってくるだけ。
import 'server-only'
import { getServiceClient } from '@/lib/supabase.server'
import { getGlobalOnlineCount } from '@/lib/server/livekit'
import { parseMaxConcurrent } from '@/lib/server/join-policy'

/** どの統計源で数えたか。GET /api/capacity が対外にも出す（運用時の切り分け用）。 */
export type CapacitySource = 'livekit' | 'db' | 'unavailable'

export interface CapacitySnapshot {
  /** 在線人数。**null = どの統計源からも取れなかった**（フェイルオープンで通す）。 */
  current: number | null
  max: number
  source: CapacitySource
}

/** 上限値。環境変数 MAX_CONCURRENT_PARTICIPANTS（未設定・不正値なら既定 20）。 */
export function getMaxConcurrent(): number {
  return parseMaxConcurrent(process.env.MAX_CONCURRENT_PARTICIPANTS)
}

/**
 * 予備の統計源：DB 上の「進行中の会議に紐づく、まだ退出していない参加者」の数。
 *
 * ⚠️ 単純に `participants where left_at is null` を数えてはいけない。
 * POST /api/rooms/{id}/end は meetings.ended_at を埋めるだけで participants.left_at は
 * 触らない（left_at を埋めるのは LiveKit webhook の room_finished 経由）。webhook が
 * 届かなかった過去の会議の行がそのまま残るため、素のカウントは際限なく過大になる。
 * そこで「ended_at が null の meeting に属する行」に限定する（クエリ 2 回になるが、
 * ここは LiveKit が落ちた時だけ通る経路なので往復コストは問題にならない）。
 *
 * @returns 人数 / **クエリ失敗は null**（0 に潰さない）
 */
async function countDbOnlineParticipants(): Promise<number | null> {
  const supabase = getServiceClient()

  const { data: meetings, error: meetingsError } = await supabase.from('meetings').select('id').is('ended_at', null)
  if (meetingsError) {
    console.error('[capacity] active meetings lookup failed', meetingsError)
    return null
  }

  const meetingIds = (meetings ?? []).map((m) => m.id)
  if (meetingIds.length === 0) return 0

  const { count, error } = await supabase
    .from('participants')
    .select('id', { count: 'exact', head: true })
    .in('meeting_id', meetingIds)
    .is('left_at', null)

  if (error) {
    console.error('[capacity] online participant count failed', error)
    return null
  }
  return count ?? 0
}

/**
 * 現在の在線人数と上限。**二重の統計源**：
 *   1. LiveKit（listRooms の numParticipants 合計）——実時間の真実。これが主。
 *   2. DB フォールバック——LiveKit へ到達できないときだけ。webhook 由来なので
 *      数秒〜数十秒遅れるが、「全く分からない」よりは遥かにマシ。
 *   3. 両方ダメ → current=null（＝呼び出し側でフェイルオープン）＋ 大声でログ。
 *
 * フェイルオープンの根拠は join-policy.ts の hasGlobalHeadroom() に書いた通り：
 * 容量上限は品質保護であってセキュリティ境界ではないので、統計側の故障で
 * 業務そのものを止めない。
 */
export async function getCapacitySnapshot(): Promise<CapacitySnapshot> {
  const max = getMaxConcurrent()

  const live = await getGlobalOnlineCount()
  if (live !== null) return { current: live, max, source: 'livekit' }

  const fromDb = await countDbOnlineParticipants()
  if (fromDb !== null) return { current: fromDb, max, source: 'db' }

  console.error(
    '[capacity] FAIL-OPEN: neither LiveKit nor DB could report the online participant count. ' +
      'The global capacity gate is effectively disabled until one of them recovers.',
  )
  return { current: null, max, source: 'unavailable' }
}
