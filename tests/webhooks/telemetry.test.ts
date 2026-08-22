// headless 回归测试：lib/server/telemetry.ts の zod スキーマ境界値のみを対象とする。
// ⚠️ lib/supabase.ts は import 禁止。route（app/api/telemetry/quality/route.ts）の
// 「常に 204」という応答仕様自体は、本 WP の curl 実測（E2E）で確認している。
import { describe, expect, it } from 'vitest'
import { MAX_BANDWIDTH_KBPS, MAX_PACKET_LOSS_PCT, MAX_RTT_MS, qualityTelemetrySchema } from '@/lib/server/telemetry'

const VALID_UUID = '123e4567-e89b-12d3-a456-426614174000'

function makeInput(overrides: Record<string, unknown> = {}) {
  return {
    participantId: VALID_UUID,
    rttMs: 80,
    packetLossPct: 1.5,
    inboundKbps: 800,
    outboundKbps: 600,
    ...overrides,
  }
}

describe('qualityTelemetrySchema：正常系', () => {
  it('§6.4 の 4 指標 + participantId を持つ妥当な payload を受理する', () => {
    const result = qualityTelemetrySchema.safeParse(makeInput())
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toEqual(makeInput())
    }
  })

  it('全指標 0 は妥当な値として受理する（品質最悪ではなく無通信を表しうる）', () => {
    const result = qualityTelemetrySchema.safeParse(
      makeInput({ rttMs: 0, packetLossPct: 0, inboundKbps: 0, outboundKbps: 0 }),
    )
    expect(result.success).toBe(true)
  })
})

describe('qualityTelemetrySchema：participantId は uuid 必須', () => {
  it('uuid 形式でなければ拒否する', () => {
    expect(qualityTelemetrySchema.safeParse(makeInput({ participantId: 'not-a-uuid' })).success).toBe(false)
    expect(qualityTelemetrySchema.safeParse(makeInput({ participantId: '12345' })).success).toBe(false)
    expect(qualityTelemetrySchema.safeParse(makeInput({ participantId: '' })).success).toBe(false)
  })

  it('欠落していれば拒否する', () => {
    const { participantId: _drop, ...rest } = makeInput()
    void _drop
    expect(qualityTelemetrySchema.safeParse(rest).success).toBe(false)
  })
})

describe('qualityTelemetrySchema：有限数値・負数拒絶・上限（rtt ≤ 60000 ほか）', () => {
  it(`rttMs は境界値 ${MAX_RTT_MS} まで許容し、超えると拒否する`, () => {
    expect(qualityTelemetrySchema.safeParse(makeInput({ rttMs: MAX_RTT_MS })).success).toBe(true)
    expect(qualityTelemetrySchema.safeParse(makeInput({ rttMs: MAX_RTT_MS + 1 })).success).toBe(false)
  })

  it(`packetLossPct は境界値 ${MAX_PACKET_LOSS_PCT} まで許容し、超えると拒否する`, () => {
    expect(qualityTelemetrySchema.safeParse(makeInput({ packetLossPct: MAX_PACKET_LOSS_PCT })).success).toBe(true)
    expect(qualityTelemetrySchema.safeParse(makeInput({ packetLossPct: MAX_PACKET_LOSS_PCT + 0.1 })).success).toBe(false)
  })

  it(`inbound/outboundKbps は境界値 ${MAX_BANDWIDTH_KBPS} まで許容し、超えると拒否する`, () => {
    expect(qualityTelemetrySchema.safeParse(makeInput({ inboundKbps: MAX_BANDWIDTH_KBPS })).success).toBe(true)
    expect(qualityTelemetrySchema.safeParse(makeInput({ inboundKbps: MAX_BANDWIDTH_KBPS + 1 })).success).toBe(false)
    expect(qualityTelemetrySchema.safeParse(makeInput({ outboundKbps: MAX_BANDWIDTH_KBPS + 1 })).success).toBe(false)
  })

  it('負の値はすべてのフィールドで拒否する', () => {
    expect(qualityTelemetrySchema.safeParse(makeInput({ rttMs: -1 })).success).toBe(false)
    expect(qualityTelemetrySchema.safeParse(makeInput({ packetLossPct: -0.1 })).success).toBe(false)
    expect(qualityTelemetrySchema.safeParse(makeInput({ inboundKbps: -1 })).success).toBe(false)
    expect(qualityTelemetrySchema.safeParse(makeInput({ outboundKbps: -1 })).success).toBe(false)
  })

  it('NaN / Infinity はすべてのフィールドで拒否する（有限数値のみ許容）', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(qualityTelemetrySchema.safeParse(makeInput({ rttMs: bad })).success).toBe(false)
      expect(qualityTelemetrySchema.safeParse(makeInput({ packetLossPct: bad })).success).toBe(false)
      expect(qualityTelemetrySchema.safeParse(makeInput({ inboundKbps: bad })).success).toBe(false)
      expect(qualityTelemetrySchema.safeParse(makeInput({ outboundKbps: bad })).success).toBe(false)
    }
  })

  it('数値でない型（文字列・null・undefined）は拒否する', () => {
    expect(qualityTelemetrySchema.safeParse(makeInput({ rttMs: '80' })).success).toBe(false)
    expect(qualityTelemetrySchema.safeParse(makeInput({ rttMs: null })).success).toBe(false)
    expect(qualityTelemetrySchema.safeParse(makeInput({ rttMs: undefined })).success).toBe(false)
  })
})

describe('qualityTelemetrySchema：余分なキー・全体的な非オブジェクト入力', () => {
  it('null / 配列 / 文字列など、そもそもオブジェクトでない入力を拒否する', () => {
    expect(qualityTelemetrySchema.safeParse(null).success).toBe(false)
    expect(qualityTelemetrySchema.safeParse([]).success).toBe(false)
    expect(qualityTelemetrySchema.safeParse('not an object').success).toBe(false)
    expect(qualityTelemetrySchema.safeParse(undefined).success).toBe(false)
  })
})
