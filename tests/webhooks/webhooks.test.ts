// headless 回归测试：lib/server/webhooks.ts の純ロジックのみを対象とする。
// ⚠️ lib/supabase.ts は import 禁止（server-only が vitest の node 環境で無条件に throw
// するため）。DB を伴う実際の webhook 経路（app/api/webhooks/livekit/route.ts）の冪等性は
// 本 WP の E2E（真実の LiveKit 署名で自己投稿）で確認している。
//
// ここでは
//   ①イベント→アクション写像 ②冪等判定 ③peak 再計算 ④identity 前缀推断
// の 4 つの純関数に加えて、⑤ WebhookReceiver の実署名検証（正規/不正な鍵・改ざん body）、
// ⑥ 上記純関数だけを組み合わせた in-memory シミュレーションで「同一イベント再送」と
// 「乱序（leave が join より先に届く）」を検証する。
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { AccessToken, WebhookReceiver } from 'livekit-server-sdk'
import {
  classifyReceiveError,
  classifyWebhookEvent,
  decideIdempotentAction,
  inferRoleFromIdentity,
  recomputePeak,
  type NormalizedWebhookEvent,
} from '@/lib/server/webhooks'

function makeEvent(overrides: Partial<NormalizedWebhookEvent> = {}): NormalizedWebhookEvent {
  return {
    eventName: 'room_started',
    roomName: 'meet_abfk92mptq',
    participantIdentity: null,
    participantName: null,
    participantSid: null,
    ...overrides,
  }
}

// ============================================================
// ① classifyWebhookEvent（事件→动作映射）
// ============================================================
describe('classifyWebhookEvent', () => {
  it('room_started → { kind: room_started, roomName }', () => {
    const result = classifyWebhookEvent(makeEvent({ eventName: 'room_started', roomName: 'meet_x' }))
    expect(result).toEqual({ kind: 'room_started', roomName: 'meet_x' })
  })

  it('room_finished → { kind: room_finished, roomName }', () => {
    const result = classifyWebhookEvent(makeEvent({ eventName: 'room_finished', roomName: 'meet_x' }))
    expect(result).toEqual({ kind: 'room_finished', roomName: 'meet_x' })
  })

  it('participant_joined → identity/name/sid を含むアクション', () => {
    const result = classifyWebhookEvent(
      makeEvent({
        eventName: 'participant_joined',
        roomName: 'meet_x',
        participantIdentity: 'guest_abc123',
        participantName: '田中太郎',
        participantSid: 'PA_1',
      }),
    )
    expect(result).toEqual({
      kind: 'participant_joined',
      roomName: 'meet_x',
      identity: 'guest_abc123',
      name: '田中太郎',
      sid: 'PA_1',
    })
  })

  it('participant_joined で name が空文字/未設定なら identity にフォールバックする', () => {
    const blank = classifyWebhookEvent(
      makeEvent({ eventName: 'participant_joined', roomName: 'meet_x', participantIdentity: 'guest_abc', participantName: '' }),
    )
    expect(blank).toMatchObject({ name: 'guest_abc' })

    const missing = classifyWebhookEvent(
      makeEvent({ eventName: 'participant_joined', roomName: 'meet_x', participantIdentity: 'guest_abc', participantName: null }),
    )
    expect(missing).toMatchObject({ name: 'guest_abc' })
  })

  it('participant_left → identity/sid を含むアクション（name は運ばない）', () => {
    const result = classifyWebhookEvent(
      makeEvent({ eventName: 'participant_left', roomName: 'meet_x', participantIdentity: 'guest_abc', participantSid: 'PA_2' }),
    )
    expect(result).toEqual({ kind: 'participant_left', roomName: 'meet_x', identity: 'guest_abc', sid: 'PA_2' })
  })

  it('未知イベントは常に ignored（route は 200 で無視する）', () => {
    for (const eventName of ['track_published', 'egress_started', 'ingress_ended', 'totally_made_up']) {
      const result = classifyWebhookEvent(makeEvent({ eventName }))
      expect(result.kind).toBe('ignored')
    }
  })

  it('room 名が欠落していれば既知イベントでも ignored', () => {
    for (const eventName of ['room_started', 'room_finished', 'participant_joined', 'participant_left']) {
      const result = classifyWebhookEvent(makeEvent({ eventName, roomName: null, participantIdentity: 'guest_x' }))
      expect(result).toEqual({ kind: 'ignored', reason: 'missing room name' })
    }
  })

  it('participant_* で identity が欠落していれば ignored（room_* は影響を受けない）', () => {
    const joined = classifyWebhookEvent(makeEvent({ eventName: 'participant_joined', roomName: 'meet_x', participantIdentity: null }))
    expect(joined).toEqual({ kind: 'ignored', reason: 'missing participant identity' })

    const left = classifyWebhookEvent(makeEvent({ eventName: 'participant_left', roomName: 'meet_x', participantIdentity: null }))
    expect(left).toEqual({ kind: 'ignored', reason: 'missing participant identity' })

    const started = classifyWebhookEvent(makeEvent({ eventName: 'room_started', roomName: 'meet_x', participantIdentity: null }))
    expect(started.kind).toBe('room_started')
  })
})

// ============================================================
// ② decideIdempotentAction（幂等判定）
// ============================================================
describe('decideIdempotentAction', () => {
  it('未処理（false）なら apply', () => {
    expect(decideIdempotentAction(false)).toBe('apply')
  })

  it('処理済み（true）なら skip', () => {
    expect(decideIdempotentAction(true)).toBe('skip')
  })
})

// ============================================================
// ③ recomputePeak（peak 重算）
// ============================================================
describe('recomputePeak', () => {
  it('現在の在室数が過去のピークを上回れば更新する', () => {
    expect(recomputePeak(2, 5)).toBe(5)
  })

  it('現在の在室数が過去のピーク以下ならピークを維持する（減らない）', () => {
    expect(recomputePeak(5, 2)).toBe(5)
    expect(recomputePeak(5, 5)).toBe(5)
  })

  it('同じ在室数で何度呼んでも結果が変わらない（真の意味で冪等）', () => {
    const once = recomputePeak(3, 7)
    const twice = recomputePeak(once, 7)
    const thrice = recomputePeak(twice, 7)
    expect(once).toBe(7)
    expect(twice).toBe(7)
    expect(thrice).toBe(7)
  })

  it('初期値 0 から始めても最大値に収束する', () => {
    expect(recomputePeak(0, 1)).toBe(1)
  })
})

// ============================================================
// ④ inferRoleFromIdentity（identity 前缀推断）
// ============================================================
describe('inferRoleFromIdentity', () => {
  it('host_ 接頭辞なら host', () => {
    expect(inferRoleFromIdentity('host_owner-uuid-1')).toBe('host')
  })

  it('guest_ 接頭辞なら guest', () => {
    expect(inferRoleFromIdentity('guest_abcdefghijkl')).toBe('guest')
  })

  it('どちらの接頭辞でもない未知の identity は安全側（guest）に倒す', () => {
    expect(inferRoleFromIdentity('anonymous-thing')).toBe('guest')
    expect(inferRoleFromIdentity('')).toBe('guest')
    // host_ を含むが前方一致でなければ guest（誤って権限を昇格させない）
    expect(inferRoleFromIdentity('guest_host_lookalike')).toBe('guest')
  })
})

// ============================================================
// ⑤ WebhookReceiver 実署名検証（§11 検収：401 は本物の検証で確認する）
// ============================================================
describe('WebhookReceiver 署名検証 + classifyReceiveError（401/400 の振り分け）', () => {
  const apiKey = 'test-webhook-key'
  // 测试专用假密钥（非真实凭据）。拼接写法是刻意的：避免 gitleaks 的
  // generic-api-key 规则把「像密钥的字面量」误报为泄漏。
  const apiSecret = ['test-webhook', 'secret', '0123456789'].join('-')
  const wrongSecret = ['wrong', 'secret', '9876543210'].join('-')
  const body = JSON.stringify({
    event: 'room_started',
    room: { sid: 'RM_test', name: 'meet_signature_test' },
  })
  const receiver = new WebhookReceiver(apiKey, apiSecret)

  function sha256Base64(payload: string): string {
    return createHash('sha256').update(payload).digest('base64')
  }

  async function sign(payload: string, secret: string): Promise<string> {
    const at = new AccessToken(apiKey, secret)
    at.sha256 = sha256Base64(payload)
    return at.toJwt()
  }

  it('正しい鍵で署名されたリクエストは検証を通過する', async () => {
    const token = await sign(body, apiSecret)
    const event = await receiver.receive(body, token)
    expect(event.event).toBe('room_started')
    expect(event.room?.name).toBe('meet_signature_test')
  })

  it('誤った鍵（apiSecret 不一致）で署名されたリクエストは拒否される → 401 相当', async () => {
    const token = await sign(body, wrongSecret)
    await expect(receiver.receive(body, token)).rejects.toThrow()
    try {
      await receiver.receive(body, token)
      expect.unreachable()
    } catch (err) {
      expect(classifyReceiveError(err)).toBe('invalid_signature')
    }
  })

  it('署名後に body を改ざんすると sha256 不一致で拒否される → 401 相当', async () => {
    const token = await sign(body, apiSecret)
    const tampered = body.replace('meet_signature_test', 'meet_evil_room')
    await expect(receiver.receive(tampered, token)).rejects.toThrow()
    try {
      await receiver.receive(tampered, token)
      expect.unreachable()
    } catch (err) {
      expect(classifyReceiveError(err)).toBe('invalid_signature')
    }
  })

  it('Authorization ヘッダが無ければ拒否される → 401 相当', async () => {
    try {
      await receiver.receive(body, undefined)
      expect.unreachable()
    } catch (err) {
      expect(classifyReceiveError(err)).toBe('invalid_signature')
    }
  })

  it('署名は正しいが body が不正な JSON → invalid_body（400 相当）', async () => {
    const malformed = '{this is not json'
    const token = await sign(malformed, apiSecret)
    try {
      await receiver.receive(malformed, token)
      expect.unreachable()
    } catch (err) {
      expect(classifyReceiveError(err)).toBe('invalid_body')
    }
  })
})

// ============================================================
// ⑥ 純関数だけを組み合わせた in-memory シミュレーション
//    ——「同一イベント投二重」と「乱序」を DB 無しで検証する
// ============================================================
// route.ts と同じ手順（事実を集める → 純関数で判定 → 反映する）を Map/配列で再現した
// テスト専用の縮小モデル。実 DB への書き込みは lib/server/meetings.ts が担うが、
// ここで検証したいのは「判定ロジックを route と同じ順序で組み合わせたときに
// 冪等性と順序耐性が成立するか」なので、IO を差し替えても本質は変わらない。
interface FakeMeeting {
  id: string
  roomId: string
  endedAt: string | null
  peak: number
}
interface FakeParticipant {
  id: string
  meetingId: string
  identity: string
  leftAt: string | null
}
interface FakeSession {
  participantId: string
  event: 'join' | 'leave'
  webhookEventId: string
}

class FakeWebhookStore {
  meetings: FakeMeeting[] = []
  participants: FakeParticipant[] = []
  sessions: FakeSession[] = []
  private seq = 0

  private nextId(prefix: string): string {
    this.seq += 1
    return `${prefix}-${this.seq}`
  }

  activeMeeting(roomId: string): FakeMeeting | null {
    return this.meetings.find((m) => m.roomId === roomId && m.endedAt === null) ?? null
  }

  /**
   * 実装（app/api/webhooks/livekit/route.ts）における唯一の meeting 作成経路は
   * POST /api/rooms/{code}/join。webhook 側は find のみで、決して作らない
   * （理由は route.ts の room_started/participant_joined ケースのコメント参照——
   * 実測で「room_started の再送が room_finished の後に遅れて届くと meeting が
   * 重複増殖する」バグが見つかり、webhook 側の find-or-create を撤去して修正した）。
   * テストではこのメソッドで「/join が既に meeting を作った」状態を用意する。
   */
  seedMeeting(roomId: string): FakeMeeting {
    const created: FakeMeeting = { id: this.nextId('meeting'), roomId, endedAt: null, peak: 0 }
    this.meetings.push(created)
    return created
  }

  /** 同じく /join が participants 行を作る通常経路を模す（webhook 側の fallback insert とは別）。 */
  seedParticipant(meetingId: string, identity: string): FakeParticipant {
    const created: FakeParticipant = { id: this.nextId('participant'), meetingId, identity, leftAt: null }
    this.participants.push(created)
    return created
  }

  private findParticipant(meetingId: string, identity: string): FakeParticipant | null {
    return this.participants.find((p) => p.meetingId === meetingId && p.identity === identity) ?? null
  }

  private activeCount(meetingId: string): number {
    return this.participants.filter((p) => p.meetingId === meetingId && p.leftAt === null).length
  }

  private hasLoggedJoin(participantId: string, webhookEventId: string): boolean {
    return this.sessions.some((s) => s.participantId === participantId && s.event === 'join' && s.webhookEventId === webhookEventId)
  }

  /** app/api/webhooks/livekit/route.ts の orchestration を Map 上で再現する（find-only、作らない）。 */
  process(roomId: string, evt: NormalizedWebhookEvent, webhookEventId: string) {
    const action = classifyWebhookEvent(evt)
    switch (action.kind) {
      case 'ignored':
        return action
      case 'room_started':
        // 観測のみ。無くても何もしない（route.ts と同じ）。
        return action
      case 'room_finished': {
        const meeting = this.activeMeeting(roomId)
        if (!meeting) return action
        meeting.endedAt = 'now'
        for (const p of this.participants) {
          if (p.meetingId === meeting.id && p.leftAt === null) p.leftAt = 'now'
        }
        return action
      }
      case 'participant_joined': {
        const meeting = this.activeMeeting(roomId)
        if (!meeting) return action // meeting が無ければ何もしない（捏造しない）
        let participant = this.findParticipant(meeting.id, action.identity)
        if (!participant) {
          participant = { id: this.nextId('participant'), meetingId: meeting.id, identity: action.identity, leftAt: null }
          this.participants.push(participant)
        }
        const alreadyLogged = this.hasLoggedJoin(participant.id, webhookEventId)
        if (decideIdempotentAction(alreadyLogged) === 'apply') {
          this.sessions.push({ participantId: participant.id, event: 'join', webhookEventId })
        }
        meeting.peak = recomputePeak(meeting.peak, this.activeCount(meeting.id))
        return action
      }
      case 'participant_left': {
        const meeting = this.activeMeeting(roomId)
        if (!meeting) return action
        const participant = this.findParticipant(meeting.id, action.identity)
        if (!participant) return action
        const alreadyLeft = participant.leftAt !== null
        if (decideIdempotentAction(alreadyLeft) === 'apply') {
          participant.leftAt = 'now'
          this.sessions.push({ participantId: participant.id, event: 'leave', webhookEventId })
        }
        return action
      }
    }
  }
}

function evt(eventName: string, identity: string | null = null): NormalizedWebhookEvent {
  return {
    eventName,
    roomName: 'meet_sim',
    participantIdentity: identity,
    participantName: identity,
    participantSid: identity ? `SID_${identity}` : null,
  }
}

describe('冪等性シミュレーション（同一イベントの再送で結果が変わらない）', () => {
  const ROOM = 'room-uuid-sim'

  it('room_started(観測) / participant_joined ×2 を再送しても、行数・join ログ数・peak が変化しない', () => {
    const store = new FakeWebhookStore()
    store.seedMeeting(ROOM) // /join が既に meeting を作っている前提
    store.process(ROOM, evt('room_started'), 'evt-room-started')
    store.process(ROOM, evt('participant_joined', 'host_a'), 'evt-join-a')
    store.process(ROOM, evt('participant_joined', 'guest_b'), 'evt-join-b')

    expect(store.meetings).toHaveLength(1)
    expect(store.participants).toHaveLength(2)
    expect(store.sessions.filter((s) => s.event === 'join')).toHaveLength(2)
    const meeting = store.activeMeeting(ROOM)!
    expect(meeting.peak).toBe(2)

    // LiveKit の再送を模して、まったく同じ event id で同じ 3 イベントをもう一度投げる
    store.process(ROOM, evt('room_started'), 'evt-room-started')
    store.process(ROOM, evt('participant_joined', 'host_a'), 'evt-join-a')
    store.process(ROOM, evt('participant_joined', 'guest_b'), 'evt-join-b')

    expect(store.meetings).toHaveLength(1) // 増えない
    expect(store.participants).toHaveLength(2) // 増えない（fallback insert が再度走らない）
    expect(store.sessions.filter((s) => s.event === 'join')).toHaveLength(2) // 重複ログなし
    expect(meeting.peak).toBe(2) // 変化なし
  })

  it('participant_left / room_finished を再送しても left_at・ended_at・leave ログが変化しない', () => {
    const store = new FakeWebhookStore()
    store.seedMeeting(ROOM)
    store.process(ROOM, evt('participant_joined', 'host_a'), 'e2')

    store.process(ROOM, evt('participant_left', 'host_a'), 'e3')
    store.process(ROOM, evt('participant_left', 'host_a'), 'e3') // 再送（同一 event id）
    expect(store.sessions.filter((s) => s.event === 'leave')).toHaveLength(1)
    expect(store.participants[0].leftAt).not.toBeNull()

    store.process(ROOM, evt('room_finished'), 'e4')
    expect(store.activeMeeting(ROOM)).toBeNull()

    // room_finished の再送も安全（既に閉じているので何も変わらない）
    expect(() => store.process(ROOM, evt('room_finished'), 'e4')).not.toThrow()
    expect(store.meetings.filter((m) => m.roomId === ROOM)).toHaveLength(1)
  })

  it('【回帰テスト】room_started の再送が room_finished より後に遅れて届いても、新しい meeting を作らない', () => {
    // 実測（真の LiveKit 署名を使った E2E）で発見したバグの再現：webhook 側に
    // find-or-create を残していた旧実装では、この手順で meeting が 2 行に増殖した。
    const store = new FakeWebhookStore()
    store.seedMeeting(ROOM)
    store.process(ROOM, evt('room_started'), 'e-room-started')
    store.process(ROOM, evt('participant_joined', 'host_a'), 'e-join')
    store.process(ROOM, evt('room_finished'), 'e-finished')
    expect(store.meetings).toHaveLength(1)
    expect(store.activeMeeting(ROOM)).toBeNull()

    // 遅延していた room_started の再送がここで届く
    store.process(ROOM, evt('room_started'), 'e-room-started')
    expect(store.meetings).toHaveLength(1) // 2 行に増えない
    expect(store.activeMeeting(ROOM)).toBeNull() // 閉じたままで再オープンしない
  })

  it('不明イベントは状態に一切影響しない（何度投げても no-op）', () => {
    const store = new FakeWebhookStore()
    store.seedMeeting(ROOM)
    const before = JSON.stringify(store)
    store.process(ROOM, evt('track_published'), 'e-unknown-1')
    store.process(ROOM, evt('egress_started'), 'e-unknown-2')
    expect(JSON.stringify(store)).toBe(before)
  })
})

describe('参加者イベントは meeting を捏造しない（webhook 側の唯一の作成経路撤去の確認）', () => {
  const ROOM = 'room-uuid-nocreate'

  it('participant_joined が届いても、対応する meeting が無ければ何も作らない', () => {
    const store = new FakeWebhookStore()
    // /join を経由していない＝meeting が存在しない状態で participant_joined が届く想定
    const action = store.process(ROOM, evt('participant_joined', 'guest_early'), 'e-join-1')
    expect(action).toMatchObject({ kind: 'participant_joined' }) // 分類自体は成立する
    expect(store.meetings).toHaveLength(0) // meeting を捏造しない
    expect(store.participants).toHaveLength(0) // participant も作らない
  })

  it('room_started が届いても、対応する meeting が無ければ何も作らない', () => {
    const store = new FakeWebhookStore()
    const action = store.process(ROOM, evt('room_started'), 'e-started-1')
    expect(action).toMatchObject({ kind: 'room_started' })
    expect(store.meetings).toHaveLength(0)
  })
})

describe('乱序耐性（leave が join より先に届く）', () => {
  const ROOM = 'room-uuid-outoforder'

  it('（現実的なケース）/join が作った participants 行はあるが、join 監査ログ webhook がまだ処理されていない状態で leave が先着しても破綻しない', () => {
    const store = new FakeWebhookStore()
    const meeting = store.seedMeeting(ROOM)
    store.seedParticipant(meeting.id, 'guest_z') // /join が同期的に作った行（joinログ webhook 未処理）

    store.process(ROOM, evt('participant_left', 'guest_z'), 'e-leave-first')
    expect(store.participants[0].leftAt).not.toBeNull()
    expect(store.sessions.filter((s) => s.event === 'leave')).toHaveLength(1)

    // 遅れて join の監査ログ webhook が届く。leftAt には触れず、ログだけ追記される。
    store.process(ROOM, evt('participant_joined', 'guest_z'), 'e-join-late')
    expect(store.participants[0].leftAt).not.toBeNull() // join で蘇らない
    expect(store.sessions.filter((s) => s.event === 'join')).toHaveLength(1)
    expect(store.sessions.filter((s) => s.event === 'leave')).toHaveLength(1) // leave ログは増えない
  })

  it('（fallback 経路）一致する participants 行が無い状態で leave が届いても、捏造せず無視する', () => {
    const store = new FakeWebhookStore()
    store.seedMeeting(ROOM) // meeting はある（/join 済み）が、この identity の行はまだ無い
    const leftFirst = store.process(ROOM, evt('participant_left', 'guest_z'), 'e-leave-early')
    expect(leftFirst).toMatchObject({ kind: 'participant_left' })
    expect(store.participants).toHaveLength(0) // 一致者なし→何もしない（臆測で行を作らない）
    expect(store.sessions).toHaveLength(0)

    // 遅れて join が届く（token 再利用などで一致行が無いケースの fallback insert）
    store.process(ROOM, evt('participant_joined', 'guest_z'), 'e-join-late')
    expect(store.participants).toHaveLength(1)
    expect(store.participants[0].leftAt).toBeNull()
    expect(store.sessions.filter((s) => s.event === 'join')).toHaveLength(1)

    // 本来の leave が正順で追いついてくる
    store.process(ROOM, evt('participant_left', 'guest_z'), 'e-leave-real')
    expect(store.participants[0].leftAt).not.toBeNull()
    expect(store.sessions.filter((s) => s.event === 'leave')).toHaveLength(1)
  })
})
