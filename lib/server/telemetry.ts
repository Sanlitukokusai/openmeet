// POST /api/telemetry/quality（規格書 §6.4）の純ロジック層：リクエストボディの zod 校验。
// ⚠️ 硬性约束：本文件は lib/supabase.ts を import 禁止（tests/webhooks/telemetry.test.ts が
// vitest の node 環境で直接 import できるようにするため）。実際の DB 書き込みは
// lib/server/meetings.ts、route は app/api/telemetry/quality/route.ts。
import { z } from 'zod'

// rtt の上限（ミリ秒）。タスク仕様の具体例をそのまま定数化。
export const MAX_RTT_MS = 60_000
// packetLossPct はパーセンテージなので 0〜100 が自然な範囲（仕様に明示は無いが、
// フィールド名の意味から導ける常識的な上限——kbps 系と異なり恣意的な数値ではない）。
export const MAX_PACKET_LOSS_PCT = 100
// inbound/outboundKbps には仕様上の具体的な上限指定が無い。1Gbps 相当を安全弁として
// 設定し、明らかに壊れた/桁違いの入力だけを弾く（実際の帯域は §4.1 の見積りで
// 数 Mbps 止まりなので、正常系を締め付ける心配はない）。
export const MAX_BANDWIDTH_KBPS = 1_000_000

/**
 * §6.4：{ participantId, rttMs, packetLossPct, inboundKbps, outboundKbps }。
 * 「有限数値・負数拒絶・上限 clamp（例：rtt≤60000）」を全フィールドに適用する。
 * ここでの「clamp」は値を丸める意味ではなく、範囲外を reject する意味で使っている
 * （route 側は検証落ちを 204 で静かに握りつぶす——§6.4 の「探测面を与えない」仕様）。
 */
export const qualityTelemetrySchema = z.object({
  participantId: z.uuid(),
  rttMs: z.number().finite().nonnegative().max(MAX_RTT_MS),
  packetLossPct: z.number().finite().nonnegative().max(MAX_PACKET_LOSS_PCT),
  inboundKbps: z.number().finite().nonnegative().max(MAX_BANDWIDTH_KBPS),
  outboundKbps: z.number().finite().nonnegative().max(MAX_BANDWIDTH_KBPS),
})
export type QualityTelemetryInput = z.infer<typeof qualityTelemetrySchema>
