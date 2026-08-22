// 密码爆破限流（規格書 §12.3）の IO ラッパー。
// 実体は meet.register_join_attempt / meet.reset_join_attempts（supabase/migrations/0002）。
// 「同一 IP × 同一 roomCode で 10 分あたり 10 回」という値は join-policy 側の定数を使う。
import 'server-only'
import { getServiceClient } from '@/lib/supabase.server'
import { JOIN_ATTEMPT_MAX, JOIN_ATTEMPT_WINDOW } from '@/lib/server/join-policy'

/**
 * 試行を 1 回記録し、「まだ許容範囲内か」を返す（RPC 側で原子的にカウント）。
 *
 * ⚠️ **フェイルクローズ**：RPC がエラーになったら false（＝拒否）を返す。
 * 限流が機能していない状態で総当たりを通すより、パスワード付きルームへの入室を
 * 一時的に止める方が安全という判断（§12.3 は「必須実装」と明記）。
 */
export async function registerJoinAttempt(roomCode: string, ip: string): Promise<boolean> {
  const { data, error } = await getServiceClient().rpc('register_join_attempt', {
    p_room_code: roomCode,
    p_ip: ip,
    p_max: JOIN_ATTEMPT_MAX,
    p_window: JOIN_ATTEMPT_WINDOW,
  })

  if (error) {
    console.error('[rate-limit] register_join_attempt failed (fail-closed)', error)
    return false
  }
  return data === true
}

/**
 * パスワード照合に成功したら呼ぶ。以降その IP は満額のクォータを取り戻す
 * （正規利用者が数回打ち間違えてから成功した場合に、次の入室で巻き込まれないため）。
 * 失敗しても入室そのものは止めない（ログのみ）。
 */
export async function resetJoinAttempts(roomCode: string, ip: string): Promise<void> {
  const { error } = await getServiceClient().rpc('reset_join_attempts', { p_room_code: roomCode, p_ip: ip })
  if (error) console.error('[rate-limit] reset_join_attempts failed', error)
}
