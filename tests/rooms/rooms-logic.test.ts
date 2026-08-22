// headless 回归测试：只测 lib/server/rooms-logic.ts 的纯逻辑，禁止 import
// lib/supabase.ts（其 `server-only` 依赖在 vitest 的 node 环境下会直接抛错）。
import { describe, expect, it } from 'vitest'
import {
  buildJoinUrl,
  buildMediaRoomName,
  createRoomSchema,
  deriveRoomState,
  MAX_PARTICIPANTS_MAX,
  MAX_PARTICIPANTS_MIN,
  patchRoomSchema,
  resolveActiveParticipants,
  resolveJoinBaseUrl,
  ROOM_PASSWORD_MAX,
  ROOM_PASSWORD_MIN,
  toRoomCreateResponse,
  toRoomDTO,
  toRoomListItem,
  type RoomRow,
} from '@/lib/server/rooms-logic'

function makeRow(overrides: Partial<RoomRow> = {}): RoomRow {
  return {
    id: 'room-uuid-1',
    owner_id: 'owner-uuid-1',
    room_code: 'abfk92mptq',
    title: 'テスト会議',
    password_hash: null,
    media_room_name: 'meet_abfk92mptq',
    media_provider: 'livekit',
    max_participants: 10,
    require_login: false,
    scheduled_at: null,
    expires_at: null,
    status: 'active',
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('createRoomSchema', () => {
  it('accepts the minimal valid payload (title only)', () => {
    const result = createRoomSchema.safeParse({ title: '朝会' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.title).toBe('朝会')
      expect(result.data.maxParticipants).toBeUndefined()
      expect(result.data.password).toBeUndefined()
    }
  })

  it('rejects an empty title', () => {
    expect(createRoomSchema.safeParse({ title: '' }).success).toBe(false)
    expect(createRoomSchema.safeParse({ title: '   ' }).success).toBe(false)
  })

  it('rejects a title longer than the max length', () => {
    const tooLong = 'a'.repeat(201)
    expect(createRoomSchema.safeParse({ title: tooLong }).success).toBe(false)
    expect(createRoomSchema.safeParse({ title: 'a'.repeat(200) }).success).toBe(true)
  })

  describe('password length boundary (6-8 chars)', () => {
    it(`rejects a password shorter than ${ROOM_PASSWORD_MIN} chars`, () => {
      const result = createRoomSchema.safeParse({ title: 'x', password: 'a'.repeat(ROOM_PASSWORD_MIN - 1) })
      expect(result.success).toBe(false)
    })

    it(`accepts a password exactly ${ROOM_PASSWORD_MIN} chars (lower boundary)`, () => {
      const result = createRoomSchema.safeParse({ title: 'x', password: 'a'.repeat(ROOM_PASSWORD_MIN) })
      expect(result.success).toBe(true)
    })

    it(`accepts a password exactly ${ROOM_PASSWORD_MAX} chars (upper boundary)`, () => {
      const result = createRoomSchema.safeParse({ title: 'x', password: 'a'.repeat(ROOM_PASSWORD_MAX) })
      expect(result.success).toBe(true)
    })

    it(`rejects a password longer than ${ROOM_PASSWORD_MAX} chars`, () => {
      const result = createRoomSchema.safeParse({ title: 'x', password: 'a'.repeat(ROOM_PASSWORD_MAX + 1) })
      expect(result.success).toBe(false)
    })

    it('treats an empty-string password as "no password"', () => {
      const result = createRoomSchema.safeParse({ title: 'x', password: '' })
      expect(result.success).toBe(true)
      if (result.success) expect(result.data.password).toBeUndefined()
    })
  })

  describe('maxParticipants boundary (2-50)', () => {
    it(`rejects ${MAX_PARTICIPANTS_MIN - 1} (below minimum)`, () => {
      expect(createRoomSchema.safeParse({ title: 'x', maxParticipants: MAX_PARTICIPANTS_MIN - 1 }).success).toBe(
        false,
      )
    })

    it(`accepts ${MAX_PARTICIPANTS_MIN} (lower boundary)`, () => {
      expect(createRoomSchema.safeParse({ title: 'x', maxParticipants: MAX_PARTICIPANTS_MIN }).success).toBe(true)
    })

    it(`accepts ${MAX_PARTICIPANTS_MAX} (upper boundary)`, () => {
      expect(createRoomSchema.safeParse({ title: 'x', maxParticipants: MAX_PARTICIPANTS_MAX }).success).toBe(true)
    })

    it(`rejects ${MAX_PARTICIPANTS_MAX + 1} (above maximum)`, () => {
      expect(createRoomSchema.safeParse({ title: 'x', maxParticipants: MAX_PARTICIPANTS_MAX + 1 }).success).toBe(
        false,
      )
    })

    it('rejects a non-integer value', () => {
      expect(createRoomSchema.safeParse({ title: 'x', maxParticipants: 10.5 }).success).toBe(false)
    })
  })

  describe('scheduledAt / expiresAt', () => {
    it('accepts a valid ISO date string', () => {
      const result = createRoomSchema.safeParse({ title: 'x', expiresAt: '2026-08-01T00:00:00.000Z' })
      expect(result.success).toBe(true)
      if (result.success) expect(result.data.expiresAt).toBeInstanceOf(Date)
    })

    it('rejects an invalid date string', () => {
      expect(createRoomSchema.safeParse({ title: 'x', expiresAt: 'not-a-date' }).success).toBe(false)
    })
  })
})

describe('patchRoomSchema', () => {
  it('rejects a fully empty patch body', () => {
    expect(patchRoomSchema.safeParse({}).success).toBe(false)
  })

  it('accepts a single-field partial update', () => {
    const result = patchRoomSchema.safeParse({ title: '新しいタイトル' })
    expect(result.success).toBe(true)
  })

  describe('password tri-state (unset / clear / set)', () => {
    it('leaves password untouched when the key is omitted', () => {
      const result = patchRoomSchema.safeParse({ title: 'x' })
      expect(result.success).toBe(true)
      if (result.success) expect('password' in result.data).toBe(false)
    })

    it('clears the password when explicitly null', () => {
      const result = patchRoomSchema.safeParse({ password: null })
      expect(result.success).toBe(true)
      if (result.success) expect(result.data.password).toBeNull()
    })

    it('clears the password when set to an empty string', () => {
      const result = patchRoomSchema.safeParse({ password: '' })
      expect(result.success).toBe(true)
      if (result.success) expect(result.data.password).toBeNull()
    })

    it(`accepts a new password within ${ROOM_PASSWORD_MIN}-${ROOM_PASSWORD_MAX} chars`, () => {
      const result = patchRoomSchema.safeParse({ password: 'newpass' })
      expect(result.success).toBe(true)
      if (result.success) expect(result.data.password).toBe('newpass')
    })

    it('rejects a new password outside the length boundary', () => {
      expect(patchRoomSchema.safeParse({ password: 'a'.repeat(ROOM_PASSWORD_MIN - 1) }).success).toBe(false)
      expect(patchRoomSchema.safeParse({ password: 'a'.repeat(ROOM_PASSWORD_MAX + 1) }).success).toBe(false)
    })
  })

  describe('expiresAt tri-state', () => {
    it('leaves expiresAt untouched when the key is omitted', () => {
      const result = patchRoomSchema.safeParse({ title: 'x' })
      expect(result.success).toBe(true)
      if (result.success) expect('expiresAt' in result.data).toBe(false)
    })

    it('clears expiresAt when explicitly null', () => {
      const result = patchRoomSchema.safeParse({ expiresAt: null })
      expect(result.success).toBe(true)
      if (result.success) expect(result.data.expiresAt).toBeNull()
    })

    it('accepts a valid new expiresAt', () => {
      const result = patchRoomSchema.safeParse({ expiresAt: '2026-09-01T00:00:00.000Z' })
      expect(result.success).toBe(true)
      if (result.success) expect(result.data.expiresAt).toBeInstanceOf(Date)
    })
  })

  it('re-validates maxParticipants boundaries on patch too', () => {
    expect(patchRoomSchema.safeParse({ maxParticipants: MAX_PARTICIPANTS_MIN - 1 }).success).toBe(false)
    expect(patchRoomSchema.safeParse({ maxParticipants: MAX_PARTICIPANTS_MAX + 1 }).success).toBe(false)
    expect(patchRoomSchema.safeParse({ maxParticipants: MAX_PARTICIPANTS_MIN }).success).toBe(true)
    expect(patchRoomSchema.safeParse({ maxParticipants: MAX_PARTICIPANTS_MAX }).success).toBe(true)
  })
})

describe('deriveRoomState', () => {
  const now = new Date('2026-07-31T12:00:00.000Z')

  it('is "active" when status is active and there is no expiry', () => {
    expect(deriveRoomState(makeRow({ status: 'active', expires_at: null }), now)).toBe('active')
  })

  it('is "active" when expires_at is in the future', () => {
    const future = new Date(now.getTime() + 1).toISOString()
    expect(deriveRoomState(makeRow({ status: 'active', expires_at: future }), now)).toBe('active')
  })

  it('is "expired" at the exact expiry boundary (now === expires_at)', () => {
    expect(deriveRoomState(makeRow({ status: 'active', expires_at: now.toISOString() }), now)).toBe('expired')
  })

  it('is "expired" one millisecond after expiry', () => {
    const justPast = new Date(now.getTime() - 1).toISOString()
    expect(deriveRoomState(makeRow({ status: 'active', expires_at: justPast }), now)).toBe('expired')
  })

  it('is "ended" whenever status is ended, regardless of expires_at', () => {
    expect(deriveRoomState(makeRow({ status: 'ended', expires_at: null }), now)).toBe('ended')
    const future = new Date(now.getTime() + 1000).toISOString()
    expect(deriveRoomState(makeRow({ status: 'ended', expires_at: future }), now)).toBe('ended')
  })

  it('disabled takes priority over an already-expired expires_at', () => {
    const longPast = new Date(now.getTime() - 1000_000).toISOString()
    expect(deriveRoomState(makeRow({ status: 'disabled', expires_at: longPast }), now)).toBe('disabled')
  })

  it('disabled takes priority even with no expiry set', () => {
    expect(deriveRoomState(makeRow({ status: 'disabled', expires_at: null }), now)).toBe('disabled')
  })
})

describe('toRoomDTO / toRoomListItem — sensitive field leakage', () => {
  const now = new Date('2026-07-31T12:00:00.000Z')
  const secretHash = '$2b$10$THIS.IS.A.FAKE.BCRYPT.HASH.VALUE.FOR.TESTING....'
  const row = makeRow({
    password_hash: secretHash,
    owner_id: 'super-secret-owner-id',
    media_room_name: 'meet_super_secret_media_name',
  })

  it('toRoomDTO never exposes password_hash, owner_id, media_room_name or media_provider', () => {
    const dto = toRoomDTO(row, now)
    const serialized = JSON.stringify(dto)

    expect(dto).not.toHaveProperty('password_hash')
    expect(dto).not.toHaveProperty('owner_id')
    expect(dto).not.toHaveProperty('ownerId')
    expect(dto).not.toHaveProperty('media_room_name')
    expect(dto).not.toHaveProperty('mediaRoomName')
    expect(dto).not.toHaveProperty('media_provider')
    expect(dto).not.toHaveProperty('mediaProvider')
    expect(serialized).not.toContain(secretHash)
    expect(serialized).not.toContain('super-secret-owner-id')
    expect(serialized).not.toContain('super_secret_media_name')
  })

  it('toRoomDTO exposes hasPassword instead of the hash', () => {
    expect(toRoomDTO(row, now).hasPassword).toBe(true)
    expect(toRoomDTO(makeRow({ password_hash: null }), now).hasPassword).toBe(false)
  })

  it('toRoomListItem only contains the §6.1 whitelisted fields (+ the 2026-08-07 activeParticipants extension)', () => {
    const item = toRoomListItem(row, now)
    expect(Object.keys(item).sort()).toEqual(
      ['activeParticipants', 'expiresAt', 'id', 'roomCode', 'scheduledAt', 'status', 'title'].sort(),
    )
    expect(JSON.stringify(item)).not.toContain(secretHash)
  })

  it('toRoomListItem still hides media_room_name even though the caller now needs it as a map key', () => {
    // GET /api/rooms は在線人数の写像を引くために media_room_name を select する。
    // その値が DTO に紛れ込まないことを固定する（漏れると入室 token の房間名が推測できる）。
    const item = toRoomListItem(row, now, 3)
    expect(item).not.toHaveProperty('mediaRoomName')
    expect(item).not.toHaveProperty('media_room_name')
    expect(JSON.stringify(item)).not.toContain('super_secret_media_name')
  })
})

describe('toRoomListItem — activeParticipants の写像（2026-08-07）', () => {
  const now = new Date('2026-07-31T12:00:00.000Z')

  it('人数不明（引数省略）は null——「0 人」に潰さない', () => {
    expect(toRoomListItem(makeRow(), now).activeParticipants).toBeNull()
    expect(toRoomListItem(makeRow(), now, null).activeParticipants).toBeNull()
  })

  it('0 人はそのまま 0（null と区別される）', () => {
    expect(toRoomListItem(makeRow(), now, 0).activeParticipants).toBe(0)
  })

  it('n 人はそのまま n', () => {
    expect(toRoomListItem(makeRow(), now, 1).activeParticipants).toBe(1)
    expect(toRoomListItem(makeRow(), now, 7).activeParticipants).toBe(7)
  })

  it('会議室のライフサイクル状態とは独立に載る（終了済みでも人数欄は埋まる）', () => {
    const item = toRoomListItem(makeRow({ status: 'ended' }), now, 2)
    expect(item.status).toBe('ended')
    expect(item.activeParticipants).toBe(2)
  })
})

describe('resolveActiveParticipants', () => {
  it('写像が null（メディアサーバー不通）なら人数不明の null', () => {
    expect(resolveActiveParticipants(null, 'meet_abc')).toBeNull()
  })

  it('写像にキーがあればその人数', () => {
    const occupancy = new Map([
      ['meet_abc', 3],
      ['meet_def', 1],
    ])
    expect(resolveActiveParticipants(occupancy, 'meet_abc')).toBe(3)
    expect(resolveActiveParticipants(occupancy, 'meet_def')).toBe(1)
  })

  it('写像にキーが無ければ 0（LiveKit は無人のルームを一覧に出さない）', () => {
    expect(resolveActiveParticipants(new Map([['meet_abc', 3]]), 'meet_zzz')).toBe(0)
  })

  it('空の写像＝サーバーに 1 部屋も無い、は「全部 0 人」であって「不明」ではない', () => {
    expect(resolveActiveParticipants(new Map(), 'meet_abc')).toBe(0)
  })

  it('LiveKit が 0 を明示的に返した場合も 0（?? が 0 を握り潰さない）', () => {
    expect(resolveActiveParticipants(new Map([['meet_abc', 0]]), 'meet_abc')).toBe(0)
  })
})

describe('toRoomCreateResponse', () => {
  it('returns exactly the §6.1 whitelisted shape for POST /api/rooms', () => {
    const row = makeRow({ id: 'room-1', room_code: 'abfk92mptq', expires_at: null })
    const dto = toRoomCreateResponse(row, 'https://example.com/j/abfk92mptq')
    expect(Object.keys(dto).sort()).toEqual(['expiresAt', 'id', 'joinUrl', 'roomCode'].sort())
    expect(dto).toEqual({
      id: 'room-1',
      roomCode: 'abfk92mptq',
      joinUrl: 'https://example.com/j/abfk92mptq',
      expiresAt: null,
    })
  })
})

describe('room code / join url helpers', () => {
  it('buildMediaRoomName prefixes with meet_', () => {
    expect(buildMediaRoomName('abfk92mptq')).toBe('meet_abfk92mptq')
  })

  // 2026-08-14 本番事故の回帰テスト：env 一括上書きで APP_DOMAIN='' が入り、
  // 旧実装が招待リンクとしてコンテナ内部の localhost:8080 を配ってしまった。
  // 新実装は forwarded ヘッダ→Host→origin の順に評価し、内部アドレスは飛ばす。
  const LOCAL_DEV: Parameters<typeof resolveJoinBaseUrl>[1] = {
    forwardedHost: null,
    forwardedProto: null,
    hostHeader: 'localhost:3000',
    fallbackOrigin: 'http://localhost:3000',
  }
  const BEHIND_PROXY: Parameters<typeof resolveJoinBaseUrl>[1] = {
    forwardedHost: 'meet.example.com',
    forwardedProto: 'https',
    hostHeader: 'meet.example.com',
    fallbackOrigin: 'https://localhost:8080',
  }

  it('resolveJoinBaseUrl prefers APP_DOMAIN when set', () => {
    expect(resolveJoinBaseUrl('meet.example.com', LOCAL_DEV)).toBe('https://meet.example.com')
    expect(resolveJoinBaseUrl('meet.example.com', BEHIND_PROXY)).toBe('https://meet.example.com')
  })

  it('resolveJoinBaseUrl: 空 APP_DOMAIN + 反代 → 用 x-forwarded-host，绝不外泄 localhost（本番事故回归）', () => {
    for (const appDomain of ['', undefined, '   ']) {
      expect(resolveJoinBaseUrl(appDomain, BEHIND_PROXY)).toBe('https://meet.example.com')
    }
  })

  it('resolveJoinBaseUrl: 多段 forwarded 头取首值，proto 缺省为 https', () => {
    expect(
      resolveJoinBaseUrl('', {
        forwardedHost: 'meet.example.com, internal-lb',
        forwardedProto: null,
        hostHeader: null,
        fallbackOrigin: 'https://localhost:8080',
      }),
    ).toBe('https://meet.example.com')
  })

  it('resolveJoinBaseUrl: 无 forwarded 头时用 Host 头（内部地址跳过）', () => {
    expect(
      resolveJoinBaseUrl('', {
        forwardedHost: null,
        forwardedProto: null,
        hostHeader: 'meet.example.com',
        fallbackOrigin: 'https://localhost:8080',
      }),
    ).toBe('https://meet.example.com')
    // 内部 Host（127.0.0.1 等）不采用
    expect(
      resolveJoinBaseUrl('', {
        forwardedHost: '127.0.0.1:8080',
        forwardedProto: 'http',
        hostHeader: '[::1]:8080',
        fallbackOrigin: 'http://localhost:3000',
      }),
    ).toBe('http://localhost:3000')
  })

  it('resolveJoinBaseUrl: 本地 dev 全内部地址时回落 origin（行为与旧版一致）', () => {
    expect(resolveJoinBaseUrl('', LOCAL_DEV)).toBe('http://localhost:3000')
  })

  it('buildJoinUrl joins base url and room code under /j/', () => {
    expect(buildJoinUrl('https://meet.example.com', 'abfk92mptq')).toBe('https://meet.example.com/j/abfk92mptq')
    expect(buildJoinUrl('https://meet.example.com/', 'abfk92mptq')).toBe('https://meet.example.com/j/abfk92mptq')
  })
})
