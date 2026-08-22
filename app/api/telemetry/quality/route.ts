// POST /api/telemetry/quality —— 規格書 §6.4（公開エンドポイント）。
// クライアントが 30 秒毎に送ってくる接続品質サンプルを meeting_sessions(event='quality') に
// 記録する。仕様上「恒 204 無 body」——参加者の存在有無・入力の妥当性のどちらについても
// 応答からは一切判別できないようにする（探测面を与えない。ROOM_META_NOT_FOUND と同じ思想）。
// そのため成功・検証失敗・participantId 不存在のいずれも同じ 204 を返す。
import { NextResponse, type NextRequest } from 'next/server'
import { qualityTelemetrySchema } from '@/lib/server/telemetry'
import { insertQualitySession } from '@/lib/server/meetings'

const NO_CONTENT = () => new NextResponse(null, { status: 204 })

export async function POST(request: NextRequest) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NO_CONTENT()
  }

  const parsed = qualityTelemetrySchema.safeParse(body)
  if (!parsed.success) {
    return NO_CONTENT()
  }

  const { participantId, rttMs, packetLossPct, inboundKbps, outboundKbps } = parsed.data
  const result = await insertQualitySession(participantId, { rttMs, packetLossPct, inboundKbps, outboundKbps })
  if (result === 'error') {
    // DB 障害は稀なベストエフォート失敗として黙って捨てる（§6.4 は常に 204 を要求しており、
    // 1 サンプルの取りこぼしより探测面を与えないことを優先する）。ログにだけ残す。
    console.error('[telemetry/quality] insert failed for participant', participantId)
  }
  return NO_CONTENT()
}
