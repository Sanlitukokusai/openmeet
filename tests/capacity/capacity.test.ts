// 全局并发上限（2026-08-07 追加）の純ロジック回帰テスト。
// ⚠️ lib/server/capacity.ts は `server-only`（Supabase / LiveKit へ触る IO 層）なので
// ここからは import できない。判定そのものは lib/server/join-policy.ts に純関数として
// 切り出してあり、本ファイルはその全数マトリクスを叩く。
// IO 側（LiveKit → DB → フェイルオープンのフォールバック順）は curl 実測で確認する。
import { describe, expect, it } from 'vitest'
import {
  checkGlobalCapacity,
  DEFAULT_MAX_CONCURRENT_PARTICIPANTS,
  evaluateJoin,
  hasGlobalHeadroom,
  parseMaxConcurrent,
  SERVER_AT_CAPACITY_MESSAGE,
  type JoinPolicyInput,
  type RoomSnapshot,
} from '@/lib/server/join-policy'

const NOW = new Date('2026-08-07T12:00:00.000Z')
const OWNER_ID = 'owner-uuid-1'

function makeRoom(overrides: Partial<RoomSnapshot> = {}): RoomSnapshot {
  return {
    status: 'active',
    expires_at: null,
    title: 'テスト会議',
    require_login: false,
    has_password: false,
    max_participants: 10,
    owner_id: OWNER_ID,
    ...overrides,
  }
}

function makeInput(overrides: Partial<JoinPolicyInput> = {}): JoinPolicyInput {
  return {
    room: makeRoom(),
    session: { userId: null },
    now: NOW,
    globalOnline: 0,
    maxConcurrent: DEFAULT_MAX_CONCURRENT_PARTICIPANTS,
    rateLimitAllowed: null,
    passwordMatches: null,
    activeParticipantCount: 0,
    ...overrides,
  }
}

// ============================================================
// 既定値と境界（0 / 19 / 20 / 21）
// ============================================================
describe('既定上限は 20（40 Mbps の容量保護——docs/SERVER-FACTS.md）', () => {
  it('DEFAULT_MAX_CONCURRENT_PARTICIPANTS === 20', () => {
    expect(DEFAULT_MAX_CONCURRENT_PARTICIPANTS).toBe(20)
  })

  it.each([
    [0, true],
    [1, true],
    [19, true],
    [20, false],
    [21, false],
    [999, false],
  ])('在線 %i 人 → 余裕あり=%s（20 人ちょうどで閉じる）', (online, expected) => {
    expect(hasGlobalHeadroom(online, DEFAULT_MAX_CONCURRENT_PARTICIPANTS)).toBe(expected)
  })

  it('19 人目までは通し、20 人目で 503 SERVER_AT_CAPACITY', () => {
    expect(checkGlobalCapacity(19, 20)).toEqual({ ok: true })
    expect(checkGlobalCapacity(20, 20)).toMatchObject({
      ok: false,
      code: 'SERVER_AT_CAPACITY',
      status: 503,
      message: SERVER_AT_CAPACITY_MESSAGE,
    })
  })

  it('既に上限を超えている（データ不整合）状態でも拒否する', () => {
    expect(checkGlobalCapacity(21, 20)).toMatchObject({ ok: false, code: 'SERVER_AT_CAPACITY' })
  })
})

// ============================================================
// 上限のカスタマイズ（MAX_CONCURRENT_PARTICIPANTS）
// ============================================================
describe('parseMaxConcurrent（環境変数の解釈）', () => {
  it('正の整数はそのまま採用する', () => {
    expect(parseMaxConcurrent('2')).toBe(2)
    expect(parseMaxConcurrent('20')).toBe(20)
    expect(parseMaxConcurrent('100')).toBe(100)
    expect(parseMaxConcurrent(' 8 ')).toBe(8)
  })

  it('未設定・空文字は既定値', () => {
    expect(parseMaxConcurrent(undefined)).toBe(DEFAULT_MAX_CONCURRENT_PARTICIPANTS)
    expect(parseMaxConcurrent(null)).toBe(DEFAULT_MAX_CONCURRENT_PARTICIPANTS)
    expect(parseMaxConcurrent('')).toBe(DEFAULT_MAX_CONCURRENT_PARTICIPANTS)
    expect(parseMaxConcurrent('   ')).toBe(DEFAULT_MAX_CONCURRENT_PARTICIPANTS)
  })

  it('不正値は既定値へフォールバックする（タイプミスでサービス全体を止めない）', () => {
    expect(parseMaxConcurrent('abc')).toBe(DEFAULT_MAX_CONCURRENT_PARTICIPANTS)
    expect(parseMaxConcurrent('20人')).toBe(DEFAULT_MAX_CONCURRENT_PARTICIPANTS)
    expect(parseMaxConcurrent('20abc')).toBe(DEFAULT_MAX_CONCURRENT_PARTICIPANTS)
    expect(parseMaxConcurrent('1.5')).toBe(DEFAULT_MAX_CONCURRENT_PARTICIPANTS)
    expect(parseMaxConcurrent('-1')).toBe(DEFAULT_MAX_CONCURRENT_PARTICIPANTS)
    expect(parseMaxConcurrent('0')).toBe(DEFAULT_MAX_CONCURRENT_PARTICIPANTS)
    expect(parseMaxConcurrent('Infinity')).toBe(DEFAULT_MAX_CONCURRENT_PARTICIPANTS)
    expect(parseMaxConcurrent('NaN')).toBe(DEFAULT_MAX_CONCURRENT_PARTICIPANTS)
  })

  it('カスタム上限 2 のとき、境界も 2 で動く（curl 実測で使う設定）', () => {
    const max = parseMaxConcurrent('2')
    expect(hasGlobalHeadroom(0, max)).toBe(true)
    expect(hasGlobalHeadroom(1, max)).toBe(true)
    expect(hasGlobalHeadroom(2, max)).toBe(false)
    expect(hasGlobalHeadroom(3, max)).toBe(false)
  })
})

// ============================================================
// 統計源が落ちたとき＝フェイルオープン
// ============================================================
describe('統計源不明（null）はフェイルオープンで通す', () => {
  it('hasGlobalHeadroom(null, *) は常に true', () => {
    expect(hasGlobalHeadroom(null, 20)).toBe(true)
    expect(hasGlobalHeadroom(null, 1)).toBe(true)
    expect(hasGlobalHeadroom(null, 9999)).toBe(true)
  })

  it('checkGlobalCapacity(null, *) は拒否しない', () => {
    expect(checkGlobalCapacity(null, 20)).toEqual({ ok: true })
    expect(checkGlobalCapacity(null, 1)).toEqual({ ok: true })
  })

  it('限流（§12.3）とは逆向きの取捨選択であることを固定する', () => {
    // 限流は「評価できなければ拒否」＝フェイルクローズ（セキュリティ境界）。
    // 容量上限は「評価できなければ許可」＝フェイルオープン（品質保護）。
    // この非対称は意図的なので、テストで固定して回帰を防ぐ。
    expect(checkGlobalCapacity(null, 1)).toEqual({ ok: true })
  })
})

// ============================================================
// 判定パイプラインへの組み込み位置（evaluateJoin が唯一の事実源）
// ============================================================
describe('evaluateJoin における全局容量の判定順序', () => {
  it('満杯なら 503 SERVER_AT_CAPACITY を返す', () => {
    const result = evaluateJoin(makeInput({ globalOnline: 20, maxConcurrent: 20 }))
    expect(result).toMatchObject({ ok: false, code: 'SERVER_AT_CAPACITY', status: 503 })
  })

  it('存在しないルームは満杯より先に ROOM_NOT_FOUND（存在探査に希望を与えない）', () => {
    const result = evaluateJoin(makeInput({ room: null, globalOnline: 99, maxConcurrent: 20 }))
    expect(result).toMatchObject({ ok: false, code: 'ROOM_NOT_FOUND' })
  })

  it('終了済み・期限切れも満杯より先（入れない理由として正確な方を返す）', () => {
    const ended = evaluateJoin(makeInput({ room: makeRoom({ status: 'ended' }), globalOnline: 99 }))
    expect(ended).toMatchObject({ ok: false, code: 'ROOM_ENDED' })

    const expiredAt = new Date(NOW.getTime() - 1000).toISOString()
    const expired = evaluateJoin(makeInput({ room: makeRoom({ expires_at: expiredAt }), globalOnline: 99 }))
    expect(expired).toMatchObject({ ok: false, code: 'ROOM_EXPIRED' })
  })

  it('要ログインの部屋に未ログインで来た場合も満杯より先（LOGIN_REQUIRED）', () => {
    const result = evaluateJoin(makeInput({ room: makeRoom({ require_login: true }), globalOnline: 99 }))
    expect(result).toMatchObject({ ok: false, code: 'LOGIN_REQUIRED' })
  })

  it('満杯はパスワード照合より先（bcrypt を焼かない・限流カウンタを進めない）', () => {
    const result = evaluateJoin(
      makeInput({
        room: makeRoom({ has_password: true }),
        globalOnline: 20,
        maxConcurrent: 20,
        rateLimitAllowed: true,
        passwordMatches: false,
      }),
    )
    expect(result).toMatchObject({ ok: false, code: 'SERVER_AT_CAPACITY' })
  })

  it('満杯は限流超過より先（混雑解消後に 429 の巻き添えを残さない）', () => {
    const result = evaluateJoin(
      makeInput({
        room: makeRoom({ has_password: true }),
        globalOnline: 20,
        maxConcurrent: 20,
        rateLimitAllowed: false,
        passwordMatches: null,
      }),
    )
    expect(result).toMatchObject({ ok: false, code: 'SERVER_AT_CAPACITY' })
  })

  it('全局満杯は部屋の満員（ROOM_FULL）より先——別レイヤーの上限であることを区別する', () => {
    const result = evaluateJoin(
      makeInput({ room: makeRoom({ max_participants: 2 }), activeParticipantCount: 2, globalOnline: 20 }),
    )
    expect(result).toMatchObject({ ok: false, code: 'SERVER_AT_CAPACITY' })
  })

  it('全局に余裕があれば、部屋が満員なら従来どおり ROOM_FULL', () => {
    const result = evaluateJoin(
      makeInput({ room: makeRoom({ max_participants: 2 }), activeParticipantCount: 2, globalOnline: 3 }),
    )
    expect(result).toMatchObject({ ok: false, code: 'ROOM_FULL', status: 409 })
  })

  it('統計源が落ちていれば（globalOnline=null）従来どおり入室できる', () => {
    const result = evaluateJoin(makeInput({ globalOnline: null, maxConcurrent: 1 }))
    expect(result).toMatchObject({ ok: true })
  })

  it('上限を 2 に絞ると 2 人在線で拒否、1 人なら通る', () => {
    expect(evaluateJoin(makeInput({ globalOnline: 1, maxConcurrent: 2 }))).toMatchObject({ ok: true })
    expect(evaluateJoin(makeInput({ globalOnline: 2, maxConcurrent: 2 }))).toMatchObject({
      ok: false,
      code: 'SERVER_AT_CAPACITY',
    })
  })
})
