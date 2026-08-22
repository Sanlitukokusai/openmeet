// headless 回归测试：只测 lib/server/join-policy.ts 的纯逻辑。
// ⚠️ lib/supabase.ts / lib/server/password.ts / lib/server/livekit.ts は import 禁止
//（`server-only` が vitest の node 環境で無条件に throw するため）。
// DB / bcrypt / LiveKit を伴う経路は本 WP の curl マトリクスで実機確認する。
import { describe, expect, it } from 'vitest'
import {
  buildMediaIdentity,
  checkCapacity,
  checkJoinGate,
  checkPasswordGate,
  computeTokenTtlSeconds,
  DEFAULT_MAX_CONCURRENT_PARTICIPANTS,
  evaluateJoin,
  joinRequestSchema,
  JOIN_ATTEMPT_MAX,
  resolveClientIp,
  resolveJoinRole,
  ROOM_META_NOT_FOUND,
  toPublicRoomStatus,
  toRoomMetaDTO,
  TOKEN_TTL_CAP_SECONDS,
  type JoinPolicyInput,
  type RoomSnapshot,
} from '@/lib/server/join-policy'

const NOW = new Date('2026-07-31T12:00:00.000Z')
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

/** 既定は「無密码・空室・匿名・サーバーに余裕あり」。各テストで必要な軸だけ上書きする。 */
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

/** 有密码房間で「限流 OK・パスワード一致」の状態。 */
function withCorrectPassword(overrides: Partial<JoinPolicyInput> = {}): JoinPolicyInput {
  return makeInput({
    room: makeRoom({ has_password: true }),
    rateLimitAllowed: true,
    passwordMatches: true,
    ...overrides,
  })
}

// ============================================================
// §11 WP-2 验收项 1：未登录 + 正确密码 → 有效な token（＝ ok 判定）
// ============================================================
describe('§11 WP-2 ①：未ログイン＋正しいパスワードで入室できる', () => {
  it('grants a guest join with a positive ttl', () => {
    const result = evaluateJoin(withCorrectPassword())
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.role).toBe('guest')
      expect(result.ttlSeconds).toBeGreaterThan(0)
    }
  })

  it('grants a join for a room with no password at all', () => {
    const result = evaluateJoin(makeInput())
    expect(result.ok).toBe(true)
  })
})

// ============================================================
// §11 WP-2 验收项 2：错误密码 400 / 过期 410 / 满员 409 / 需登录未登录 403
// ============================================================
describe('§11 WP-2 ②：エラーコードと HTTP ステータスの対応表（§6.2）', () => {
  it('wrong password → 400 INVALID_PASSWORD', () => {
    const result = evaluateJoin(withCorrectPassword({ passwordMatches: false }))
    expect(result).toMatchObject({ ok: false, code: 'INVALID_PASSWORD', status: 400 })
  })

  it('expired room → 410 ROOM_EXPIRED', () => {
    const expired = new Date(NOW.getTime() - 1000).toISOString()
    const result = evaluateJoin(makeInput({ room: makeRoom({ expires_at: expired }) }))
    expect(result).toMatchObject({ ok: false, code: 'ROOM_EXPIRED', status: 410 })
  })

  it('full room → 409 ROOM_FULL', () => {
    const result = evaluateJoin(makeInput({ room: makeRoom({ max_participants: 2 }), activeParticipantCount: 2 }))
    expect(result).toMatchObject({ ok: false, code: 'ROOM_FULL', status: 409 })
  })

  it('require_login room without a session → 403 LOGIN_REQUIRED', () => {
    const result = evaluateJoin(makeInput({ room: makeRoom({ require_login: true }) }))
    expect(result).toMatchObject({ ok: false, code: 'LOGIN_REQUIRED', status: 403 })
  })

  it('unknown room → 404 ROOM_NOT_FOUND', () => {
    const result = evaluateJoin(makeInput({ room: null }))
    expect(result).toMatchObject({ ok: false, code: 'ROOM_NOT_FOUND', status: 404 })
  })

  it('rate limited → 429 TOO_MANY_ATTEMPTS', () => {
    const result = evaluateJoin(withCorrectPassword({ rateLimitAllowed: false }))
    expect(result).toMatchObject({ ok: false, code: 'TOO_MANY_ATTEMPTS', status: 429 })
  })
})

// ============================================================
// disabled（软删除）は対外的に ROOM_ENDED
// ============================================================
describe('ended / disabled → 410 ROOM_ENDED', () => {
  it('status=ended → ROOM_ENDED', () => {
    const result = evaluateJoin(makeInput({ room: makeRoom({ status: 'ended' }) }))
    expect(result).toMatchObject({ ok: false, code: 'ROOM_ENDED', status: 410 })
  })

  it('status=disabled（ソフト削除）も ROOM_ENDED として扱う（内部状態を漏らさない）', () => {
    const result = evaluateJoin(makeInput({ room: makeRoom({ status: 'disabled' }) }))
    expect(result).toMatchObject({ ok: false, code: 'ROOM_ENDED', status: 410 })
  })

  it('disabled は expires_at が未来でも ROOM_ENDED', () => {
    const future = new Date(NOW.getTime() + 3600_000).toISOString()
    const result = evaluateJoin(makeInput({ room: makeRoom({ status: 'disabled', expires_at: future }) }))
    expect(result).toMatchObject({ ok: false, code: 'ROOM_ENDED' })
  })

  it('disabled かつ expires_at 経過済みでも ROOM_EXPIRED ではなく ROOM_ENDED', () => {
    const past = new Date(NOW.getTime() - 3600_000).toISOString()
    const result = evaluateJoin(makeInput({ room: makeRoom({ status: 'disabled', expires_at: past }) }))
    expect(result).toMatchObject({ ok: false, code: 'ROOM_ENDED' })
  })
})

// ============================================================
// §11 WP-2 验收项 3：token TTL ≤ 房间剩余时长、かつ 6h 上限
// ============================================================
describe('§11 WP-2 ③：computeTokenTtlSeconds（§7.3）', () => {
  it('expires_at が無ければ上限の 6 時間', () => {
    expect(computeTokenTtlSeconds(null, NOW)).toBe(TOKEN_TTL_CAP_SECONDS)
    expect(TOKEN_TTL_CAP_SECONDS).toBe(6 * 3600)
  })

  it('残り 1 秒 → 1 秒（剩余时长を超えない）', () => {
    const expiresAt = new Date(NOW.getTime() + 1000).toISOString()
    expect(computeTokenTtlSeconds(expiresAt, NOW)).toBe(1)
  })

  it('残りちょうど 6 時間 → 21600 秒', () => {
    const expiresAt = new Date(NOW.getTime() + TOKEN_TTL_CAP_SECONDS * 1000).toISOString()
    expect(computeTokenTtlSeconds(expiresAt, NOW)).toBe(TOKEN_TTL_CAP_SECONDS)
  })

  it('残り 6 時間 + 1 秒 → 21600 秒に頭打ち', () => {
    const expiresAt = new Date(NOW.getTime() + (TOKEN_TTL_CAP_SECONDS + 1) * 1000).toISOString()
    expect(computeTokenTtlSeconds(expiresAt, NOW)).toBe(TOKEN_TTL_CAP_SECONDS)
  })

  it('残り 24 時間でも 6 時間で頭打ち', () => {
    const expiresAt = new Date(NOW.getTime() + 24 * 3600 * 1000).toISOString()
    expect(computeTokenTtlSeconds(expiresAt, NOW)).toBe(TOKEN_TTL_CAP_SECONDS)
  })

  it('残り 1 秒未満でも 0 にはしない（SDK が ttl=0 を既定の 6h に化けさせるため）', () => {
    const expiresAt = new Date(NOW.getTime() + 400).toISOString()
    expect(computeTokenTtlSeconds(expiresAt, NOW)).toBe(1)
  })

  it('evaluateJoin が返す ttlSeconds も同じ規則に従う（必ず 1 以上）', () => {
    const expiresAt = new Date(NOW.getTime() + 90_000).toISOString()
    const result = evaluateJoin(makeInput({ room: makeRoom({ expires_at: expiresAt }) }))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.ttlSeconds).toBe(90)
      expect(result.ttlSeconds).toBeLessThanOrEqual(TOKEN_TTL_CAP_SECONDS)
      expect(result.ttlSeconds).toBeGreaterThanOrEqual(1)
    }
  })
})

// ============================================================
// §11 WP-2 验收项 4 + 限流境界（§12.3）
// ============================================================
describe('§11 WP-2 ④：限流の境界（10 回まで許容、11 回目で拒否）', () => {
  // meet.register_join_attempt() のセマンティクス（attempts <= p_max）を模した
  // カウンタ。DB 側の実挙動は curl マトリクスで別途確認している。
  function makeAttemptCounter(max = JOIN_ATTEMPT_MAX) {
    let attempts = 0
    return () => {
      attempts += 1
      return attempts <= max
    }
  }

  it('10 回目までは INVALID_PASSWORD、11 回目で TOO_MANY_ATTEMPTS に切り替わる', () => {
    const register = makeAttemptCounter()
    const codes: string[] = []

    for (let i = 0; i < JOIN_ATTEMPT_MAX + 1; i++) {
      const allowed = register()
      const result = evaluateJoin(
        withCorrectPassword({ rateLimitAllowed: allowed, passwordMatches: allowed ? false : null }),
      )
      expect(result.ok).toBe(false)
      if (!result.ok) codes.push(result.code)
    }

    expect(codes.slice(0, JOIN_ATTEMPT_MAX)).toEqual(Array(JOIN_ATTEMPT_MAX).fill('INVALID_PASSWORD'))
    expect(codes[JOIN_ATTEMPT_MAX]).toBe('TOO_MANY_ATTEMPTS')
    expect(JOIN_ATTEMPT_MAX).toBe(10)
  })

  it('上限に達した後は正しいパスワードでも通さない（総当たりの完全遮断）', () => {
    const result = evaluateJoin(withCorrectPassword({ rateLimitAllowed: false, passwordMatches: true }))
    expect(result).toMatchObject({ ok: false, code: 'TOO_MANY_ATTEMPTS' })
  })

  it('限流の評価自体が欠落していたら（null）フェイルクローズで拒否する', () => {
    const result = evaluateJoin(withCorrectPassword({ rateLimitAllowed: null, passwordMatches: true }))
    expect(result).toMatchObject({ ok: false, code: 'TOO_MANY_ATTEMPTS' })
  })

  it('無密码房間は限流の対象外——rateLimitAllowed=false でも入室できる', () => {
    const result = evaluateJoin(
      makeInput({ room: makeRoom({ has_password: false }), rateLimitAllowed: false, passwordMatches: false }),
    )
    expect(result.ok).toBe(true)
  })

  it('checkPasswordGate は requiresPassword=false のとき事実を一切見ない', () => {
    expect(checkPasswordGate(false, { rateLimitAllowed: null, passwordMatches: null })).toEqual({ ok: true })
    expect(checkPasswordGate(false, { rateLimitAllowed: false, passwordMatches: false })).toEqual({ ok: true })
  })
})

// ============================================================
// 判定順序そのもの（どちらのエラーが先に出るか＝情報漏洩の境界）
// ============================================================
describe('判定順序（§6.2）', () => {
  it('存在しないルームは、他のどの条件よりも先に ROOM_NOT_FOUND', () => {
    const result = evaluateJoin(makeInput({ room: null, rateLimitAllowed: false, activeParticipantCount: 999 }))
    expect(result).toMatchObject({ ok: false, code: 'ROOM_NOT_FOUND' })
  })

  it('期限切れは、パスワード誤り・満員より先に ROOM_EXPIRED', () => {
    const expired = new Date(NOW.getTime() - 1).toISOString()
    const result = evaluateJoin(
      makeInput({
        room: makeRoom({ expires_at: expired, has_password: true, max_participants: 2 }),
        rateLimitAllowed: true,
        passwordMatches: false,
        activeParticipantCount: 5,
      }),
    )
    expect(result).toMatchObject({ ok: false, code: 'ROOM_EXPIRED' })
  })

  it('終了済みは LOGIN_REQUIRED より先（ログインしても入れないことを伝える）', () => {
    const result = evaluateJoin(makeInput({ room: makeRoom({ status: 'ended', require_login: true }) }))
    expect(result).toMatchObject({ ok: false, code: 'ROOM_ENDED' })
  })

  it('LOGIN_REQUIRED はパスワード照合より先（未ログイン者にパスワードを試させない）', () => {
    const result = evaluateJoin(
      makeInput({
        room: makeRoom({ require_login: true, has_password: true }),
        rateLimitAllowed: true,
        passwordMatches: false,
      }),
    )
    expect(result).toMatchObject({ ok: false, code: 'LOGIN_REQUIRED' })
  })

  it('限流はパスワード照合より先（上限超過後に「正解なら通る」を残さない）', () => {
    const result = evaluateJoin(withCorrectPassword({ rateLimitAllowed: false, passwordMatches: false }))
    expect(result).toMatchObject({ ok: false, code: 'TOO_MANY_ATTEMPTS' })
  })

  it('パスワード誤りは満員判定より先（満員かどうかを部外者に教えない）', () => {
    const result = evaluateJoin(
      withCorrectPassword({ passwordMatches: false, room: makeRoom({ has_password: true, max_participants: 2 }) }),
    )
    // activeParticipantCount は既定 0 だが、満員でも順序は変わらないことを併せて確認
    expect(result).toMatchObject({ ok: false, code: 'INVALID_PASSWORD' })
    const full = evaluateJoin(
      withCorrectPassword({
        passwordMatches: false,
        room: makeRoom({ has_password: true, max_participants: 2 }),
        activeParticipantCount: 9,
      }),
    )
    expect(full).toMatchObject({ ok: false, code: 'INVALID_PASSWORD' })
  })
})

// ============================================================
// ステージ関数の単体（route はこの順で呼ぶ）
// ============================================================
describe('checkJoinGate', () => {
  it('パスワード付きルームでは requiresPassword=true を返す', () => {
    const result = checkJoinGate(makeRoom({ has_password: true }), { userId: null }, NOW)
    expect(result).toEqual({ ok: true, requiresPassword: true })
  })

  it('パスワード無しなら requiresPassword=false', () => {
    const result = checkJoinGate(makeRoom(), { userId: null }, NOW)
    expect(result).toEqual({ ok: true, requiresPassword: false })
  })

  it('require_login でもログイン済みなら通過する', () => {
    const result = checkJoinGate(makeRoom({ require_login: true }), { userId: 'someone' }, NOW)
    expect(result.ok).toBe(true)
  })

  it('expires_at ちょうど（now === expires_at）は期限切れ', () => {
    const result = checkJoinGate(makeRoom({ expires_at: NOW.toISOString() }), { userId: null }, NOW)
    expect(result).toMatchObject({ ok: false, code: 'ROOM_EXPIRED' })
  })

  it('expires_at の 1 ミリ秒前はまだ有効', () => {
    const result = checkJoinGate(
      makeRoom({ expires_at: new Date(NOW.getTime() + 1).toISOString() }),
      { userId: null },
      NOW,
    )
    expect(result.ok).toBe(true)
  })
})

describe('checkCapacity（§12.8）', () => {
  it('定員未満なら通過', () => {
    expect(checkCapacity({ max_participants: 2 }, 1)).toEqual({ ok: true })
  })

  it('ちょうど定員なら ROOM_FULL（3 人目を弾く境界）', () => {
    expect(checkCapacity({ max_participants: 2 }, 2)).toMatchObject({ ok: false, code: 'ROOM_FULL', status: 409 })
  })

  it('定員超過（データ不整合時）も ROOM_FULL', () => {
    expect(checkCapacity({ max_participants: 2 }, 3)).toMatchObject({ ok: false, code: 'ROOM_FULL' })
  })

  it('空室は当然通過', () => {
    expect(checkCapacity({ max_participants: 50 }, 0)).toEqual({ ok: true })
  })
})

// ============================================================
// host / guest 判定と media_identity（§7.3）
// ============================================================
describe('resolveJoinRole / buildMediaIdentity', () => {
  it('ログイン中ユーザー＝所有者なら host', () => {
    expect(resolveJoinRole({ owner_id: OWNER_ID }, { userId: OWNER_ID })).toBe('host')
  })

  it('ログイン中でも別人なら guest', () => {
    expect(resolveJoinRole({ owner_id: OWNER_ID }, { userId: 'another-user' })).toBe('guest')
  })

  it('匿名は常に guest', () => {
    expect(resolveJoinRole({ owner_id: OWNER_ID }, { userId: null })).toBe('guest')
  })

  it('evaluateJoin も所有者に host を割り当てる（roomAdmin 権限の根拠）', () => {
    const result = evaluateJoin(makeInput({ session: { userId: OWNER_ID } }))
    expect(result).toMatchObject({ ok: true, role: 'host' })
  })

  it('evaluateJoin は他人には guest を割り当てる', () => {
    const result = evaluateJoin(makeInput({ session: { userId: 'another-user' } }))
    expect(result).toMatchObject({ ok: true, role: 'guest' })
  })

  it('identity は host_<userId> / guest_<suffix>', () => {
    expect(buildMediaIdentity('host', OWNER_ID, 'abcdefghijkl')).toBe(`host_${OWNER_ID}`)
    expect(buildMediaIdentity('guest', null, 'abcdefghijkl')).toBe('guest_abcdefghijkl')
    expect(buildMediaIdentity('guest', 'some-user', 'abcdefghijkl')).toBe('guest_abcdefghijkl')
  })

  it('host なのに userId が無い場合は guest identity に倒す（host_null を作らない）', () => {
    expect(buildMediaIdentity('host', null, 'abcdefghijkl')).toBe('guest_abcdefghijkl')
  })
})

// ============================================================
// GET /meta の形状（§6.2）——機微情報の非漏洩
// ============================================================
describe('toRoomMetaDTO / ROOM_META_NOT_FOUND', () => {
  const META_KEYS = ['exists', 'isFull', 'requireLogin', 'requiresPassword', 'status', 'title']

  it('§6.2 の 6 キーちょうどを返す', () => {
    const dto = toRoomMetaDTO(makeRoom(), 0, NOW)
    expect(Object.keys(dto).sort()).toEqual(META_KEYS)
  })

  it('存在しないルームは中立な既定値（status は ended＝終了済みと区別できない）', () => {
    expect(Object.keys(ROOM_META_NOT_FOUND).sort()).toEqual(META_KEYS)
    expect(ROOM_META_NOT_FOUND).toEqual({
      exists: false,
      title: '',
      requiresPassword: false,
      requireLogin: false,
      isFull: false,
      status: 'ended',
    })
  })

  it('password_hash / owner_id / 内部 id / media_room_name を含まない', () => {
    const dto = toRoomMetaDTO(makeRoom({ has_password: true, owner_id: 'super-secret-owner-id' }), 0, NOW)
    const serialized = JSON.stringify(dto)
    expect(dto).not.toHaveProperty('password_hash')
    expect(dto).not.toHaveProperty('owner_id')
    expect(dto).not.toHaveProperty('id')
    expect(dto).not.toHaveProperty('media_room_name')
    expect(dto).not.toHaveProperty('maxParticipants')
    expect(serialized).not.toContain('super-secret-owner-id')
  })

  it('requiresPassword はハッシュの有無だけを反映する', () => {
    expect(toRoomMetaDTO(makeRoom({ has_password: true }), 0, NOW).requiresPassword).toBe(true)
    expect(toRoomMetaDTO(makeRoom({ has_password: false }), 0, NOW).requiresPassword).toBe(false)
  })

  it('isFull は在室数 >= max_participants で true', () => {
    expect(toRoomMetaDTO(makeRoom({ max_participants: 2 }), 1, NOW).isFull).toBe(false)
    expect(toRoomMetaDTO(makeRoom({ max_participants: 2 }), 2, NOW).isFull).toBe(true)
    expect(toRoomMetaDTO(makeRoom({ max_participants: 2 }), 3, NOW).isFull).toBe(true)
  })

  it('在室数が未計測（null）なら isFull=false', () => {
    expect(toRoomMetaDTO(makeRoom({ max_participants: 2 }), null, NOW).isFull).toBe(false)
  })

  it('status は active / ended / expired の 3 値のみ（disabled は ended へ丸める）', () => {
    expect(toRoomMetaDTO(makeRoom(), 0, NOW).status).toBe('active')
    expect(toRoomMetaDTO(makeRoom({ status: 'ended' }), 0, NOW).status).toBe('ended')
    expect(toRoomMetaDTO(makeRoom({ status: 'disabled' }), 0, NOW).status).toBe('ended')
    const expired = new Date(NOW.getTime() - 1).toISOString()
    expect(toRoomMetaDTO(makeRoom({ expires_at: expired }), 0, NOW).status).toBe('expired')
  })

  it('toPublicRoomStatus は disabled のみ変換し他は素通し', () => {
    expect(toPublicRoomStatus('disabled')).toBe('ended')
    expect(toPublicRoomStatus('ended')).toBe('ended')
    expect(toPublicRoomStatus('active')).toBe('active')
    expect(toPublicRoomStatus('expired')).toBe('expired')
  })
})

// ============================================================
// リクエスト検証と限流キー
// ============================================================
describe('joinRequestSchema', () => {
  it('displayName のみで成立する', () => {
    const result = joinRequestSchema.safeParse({ displayName: '田中' })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.password).toBeUndefined()
  })

  it('displayName は必須・空白のみは不可', () => {
    expect(joinRequestSchema.safeParse({}).success).toBe(false)
    expect(joinRequestSchema.safeParse({ displayName: '' }).success).toBe(false)
    expect(joinRequestSchema.safeParse({ displayName: '   ' }).success).toBe(false)
  })

  it('displayName は前後の空白を落とす', () => {
    const result = joinRequestSchema.safeParse({ displayName: '  田中  ' })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.displayName).toBe('田中')
  })

  it('displayName の長さ上限（50 文字）', () => {
    expect(joinRequestSchema.safeParse({ displayName: 'あ'.repeat(50) }).success).toBe(true)
    expect(joinRequestSchema.safeParse({ displayName: 'あ'.repeat(51) }).success).toBe(false)
  })

  it('パスワードは桁数を検証しない（VALIDATION_ERROR と INVALID_PASSWORD を混同させない）', () => {
    expect(joinRequestSchema.safeParse({ displayName: 'x', password: 'a' }).success).toBe(true)
    expect(joinRequestSchema.safeParse({ displayName: 'x', password: 'a'.repeat(100) }).success).toBe(true)
  })
})

describe('resolveClientIp（§12.3 の限流キー）', () => {
  it('x-forwarded-for の先頭ホップを採用する', () => {
    expect(resolveClientIp('203.0.113.10, 70.41.3.18, 150.172.238.178', null)).toBe('203.0.113.10')
  })

  it('前後の空白を落とす', () => {
    expect(resolveClientIp('  203.0.113.10  ,10.0.0.1', null)).toBe('203.0.113.10')
  })

  it('x-forwarded-for が無ければ x-real-ip', () => {
    expect(resolveClientIp(null, '198.51.100.7')).toBe('198.51.100.7')
    expect(resolveClientIp('', '198.51.100.7')).toBe('198.51.100.7')
    expect(resolveClientIp('   ', '198.51.100.7')).toBe('198.51.100.7')
  })

  it('どちらも無ければ unknown（ローカル開発時の正常系）', () => {
    expect(resolveClientIp(null, null)).toBe('unknown')
    expect(resolveClientIp('', '')).toBe('unknown')
  })
})
