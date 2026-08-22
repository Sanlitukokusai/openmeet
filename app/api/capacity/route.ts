import { NextResponse } from 'next/server'
import { getCapacitySnapshot, type CapacitySource } from '@/lib/server/capacity'
import { hasGlobalHeadroom } from '@/lib/server/join-policy'

// 常に実測値を返す（人数は毎秒変わる）。Next.js 15 の GET Route Handler は既定で
// 非キャッシュだが、暗黙の既定に依存せず明示しておく。
export const dynamic = 'force-dynamic'

/** 公開・読み取り専用。ルーム情報も所有者情報も一切含まない（全局の集計値のみ）。 */
interface CapacityResponse {
  /** サーバー全体の在線人数。null = 統計源が全滅（その場合ゲートはフェイルオープン）。 */
  current: number | null
  max: number
  /** 会議室を新規作成できるか。current=null（統計不能）のときは true。 */
  canCreate: boolean
  /** 新たに入室できるか（個別ルームの満員判定は別。こちらは全局のみ）。 */
  canJoin: boolean
  source: CapacitySource
}

/**
 * GET /api/capacity —— 全局容量の現況（2026-08-07 追加）。
 *
 * 用途：ダッシュボード / 入室画面で「今は混雑しています」を**先回りで**出すため。
 * これはあくまで表示用のヒントであり、**強制は POST /api/rooms と
 * POST /api/rooms/{code}/join のサーバー側ゲートが行う**（このエンドポイントを
 * 呼ばずに直接 POST しても弾かれる）。
 *
 * 公開エンドポイントだが、返すのは全局の集計値と上限だけ——どの部屋に誰が何人
 * 居るかは一切分からないので、探査面にはならない。
 */
export async function GET() {
  const { current, max, source } = await getCapacitySnapshot()
  const headroom = hasGlobalHeadroom(current, max)

  const response: CapacityResponse = {
    current,
    max,
    // 今のところ作成と入室で条件は同じ。将来「作成だけ先に絞る」等の運用を
    // 入れる余地を残すため、意味の違うフラグとして 2 つに分けて公開しておく。
    canCreate: headroom,
    canJoin: headroom,
    source,
  }
  return NextResponse.json(response)
}
