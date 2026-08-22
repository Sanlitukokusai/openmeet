// 司会者ミュート（2026-08-07 追加）の純ロジック回帰テスト。
// ⚠️ lib/server/livekit.ts は `server-only`（RoomServiceClient を持つ IO 層）なので
// ここからは import できない。テスト可能な部分——リクエスト検証・鉴权判定・
// 一括ミュートの対象選別・失敗理由 → HTTP 写像——はすべて lib/server/rooms-logic.ts
// 側に切り出してある。LiveKit を実際に叩く経路は curl / 真機で確認する。
import { describe, expect, it } from 'vitest'
import {
  authorizeHostRoomAction,
  muteFailureToApiError,
  muteParticipantSchema,
  planMuteAllTargets,
  type MuteAllCandidate,
  type MuteAudioFailureReason,
} from '@/lib/server/rooms-logic'
import { buildHostMediaIdentity, buildMediaIdentity } from '@/lib/server/join-policy'

const HOST_ID = 'owner-uuid-1'

// ============================================================
// 鉴权マトリクス（未ログイン 401 / 他人・不在の部屋 404 / 房主本人 通過）
// ============================================================
describe('authorizeHostRoomAction', () => {
  // room は「owner_id で絞り込んだクエリの結果」。他人の部屋も存在しない部屋も
  // 同じ 0 行ヒット（null）になる＝呼び出し側では区別できない、という前提が肝。
  const foundRoom = { id: 'room-uuid', media_room_name: 'meet_abc' }

  it('未ログイン → 401 UNAUTHORIZED（部屋が見つかっていても優先）', () => {
    expect(authorizeHostRoomAction(null, foundRoom)).toMatchObject({ ok: false, status: 401, code: 'UNAUTHORIZED' })
    expect(authorizeHostRoomAction(null, null)).toMatchObject({ ok: false, status: 401, code: 'UNAUTHORIZED' })
  })

  it('ログイン済みだが 0 行ヒット（他人の部屋 / 存在しない部屋）→ 404 ROOM_NOT_FOUND', () => {
    expect(authorizeHostRoomAction(HOST_ID, null)).toMatchObject({ ok: false, status: 404, code: 'ROOM_NOT_FOUND' })
    expect(authorizeHostRoomAction(HOST_ID, undefined)).toMatchObject({ ok: false, status: 404, code: 'ROOM_NOT_FOUND' })
  })

  it('他人の部屋と存在しない部屋は外形上まったく同じ応答（room id の存在探査を防ぐ）', () => {
    const othersRoom = authorizeHostRoomAction(HOST_ID, null)
    const missingRoom = authorizeHostRoomAction(HOST_ID, null)
    expect(othersRoom).toEqual(missingRoom)
  })

  it('房主本人 → 通過', () => {
    expect(authorizeHostRoomAction(HOST_ID, foundRoom)).toEqual({ ok: true })
  })

  it('403 は返さない（他人の部屋は 404 に潰す——§6.1 の既存 route と同設計）', () => {
    const results = [
      authorizeHostRoomAction(null, foundRoom),
      authorizeHostRoomAction(HOST_ID, null),
      authorizeHostRoomAction(HOST_ID, foundRoom),
    ]
    for (const r of results) {
      if (!r.ok) expect(r.status).not.toBe(403)
    }
  })
})

// ============================================================
// リクエストボディ検証
// ============================================================
describe('muteParticipantSchema', () => {
  it('identity と muted の両方が必要', () => {
    expect(muteParticipantSchema.safeParse({ identity: 'guest_abc', muted: true }).success).toBe(true)
    expect(muteParticipantSchema.safeParse({ identity: 'guest_abc', muted: false }).success).toBe(true)
    expect(muteParticipantSchema.safeParse({ identity: 'guest_abc' }).success).toBe(false)
    expect(muteParticipantSchema.safeParse({ muted: true }).success).toBe(false)
    expect(muteParticipantSchema.safeParse({}).success).toBe(false)
  })

  it('identity は空文字・空白のみを拒否する', () => {
    expect(muteParticipantSchema.safeParse({ identity: '', muted: true }).success).toBe(false)
    expect(muteParticipantSchema.safeParse({ identity: '   ', muted: true }).success).toBe(false)
  })

  it('identity は前後の空白を落とす', () => {
    const parsed = muteParticipantSchema.safeParse({ identity: '  host_x  ', muted: true })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.identity).toBe('host_x')
  })

  it('muted は真偽値のみ（"true" 等の文字列は受け付けない）', () => {
    expect(muteParticipantSchema.safeParse({ identity: 'g', muted: 'true' }).success).toBe(false)
    expect(muteParticipantSchema.safeParse({ identity: 'g', muted: 1 }).success).toBe(false)
  })
})

// ============================================================
// 一括ミュートの対象選別（無音轨容错の本体）
// ============================================================
describe('planMuteAllTargets', () => {
  const host: MuteAllCandidate = { identity: 'host_owner-uuid-1', audioTrackSids: ['TR_host_a'] }
  const speaker: MuteAllCandidate = { identity: 'guest_aaa', audioTrackSids: ['TR_a'] }
  const speaker2: MuteAllCandidate = { identity: 'guest_bbb', audioTrackSids: ['TR_b'] }
  /** 旁聴者：入室しているがマイクを publish していない（音声トラック 0 本）。 */
  const listener: MuteAllCandidate = { identity: 'guest_listener', audioTrackSids: [] }

  it('司会者自身は除外する（自分の口を塞いで進行できなくなるのを防ぐ）', () => {
    const plan = planMuteAllTargets([host, speaker], host.identity)
    expect(plan.targets.map((t) => t.identity)).toEqual(['guest_aaa'])
    expect(plan.skipped).toBe(1)
  })

  it('音声トラックを持たない旁聴者は除外する（ミュートすべき対象が無い）', () => {
    const plan = planMuteAllTargets([speaker, listener], null)
    expect(plan.targets.map((t) => t.identity)).toEqual(['guest_aaa'])
    expect(plan.skipped).toBe(1)
  })

  it('司会者＋旁聴者の両方を除外し、残りを全部対象にする', () => {
    const plan = planMuteAllTargets([host, speaker, listener, speaker2], host.identity)
    expect(plan.targets.map((t) => t.identity)).toEqual(['guest_aaa', 'guest_bbb'])
    expect(plan.skipped).toBe(2)
  })

  it('全員が旁聴者なら対象 0・skipped が全員分（例外にはしない）', () => {
    const plan = planMuteAllTargets([listener, { identity: 'guest_ccc', audioTrackSids: [] }], null)
    expect(plan.targets).toEqual([])
    expect(plan.skipped).toBe(2)
  })

  it('誰も居なければ 0 件（会議開始前に押しても壊れない）', () => {
    expect(planMuteAllTargets([], 'host_x')).toEqual({ targets: [], skipped: 0 })
  })

  it('exceptIdentity=null なら誰も除外しない（音声トラックの有無だけで判定）', () => {
    const plan = planMuteAllTargets([host, speaker], null)
    expect(plan.targets.map((t) => t.identity)).toEqual([host.identity, speaker.identity])
    expect(plan.skipped).toBe(0)
  })

  it('exceptIdentity が誰とも一致しなくても壊れない（房主が未入室のケース）', () => {
    const plan = planMuteAllTargets([speaker, speaker2], 'host_someone-else')
    expect(plan.targets).toHaveLength(2)
    expect(plan.skipped).toBe(0)
  })

  it('複数の音声トラック（マイク＋画面共有音声）は全部が対象に残る', () => {
    const dual: MuteAllCandidate = { identity: 'guest_dual', audioTrackSids: ['TR_mic', 'TR_screen'] }
    const plan = planMuteAllTargets([dual], null)
    expect(plan.targets[0]?.audioTrackSids).toEqual(['TR_mic', 'TR_screen'])
  })

  it('targets + skipped は必ず候補全体と一致する（取りこぼしの検出）', () => {
    const candidates = [host, speaker, listener, speaker2]
    const plan = planMuteAllTargets(candidates, host.identity)
    expect(plan.targets.length + plan.skipped).toBe(candidates.length)
  })
})

// ============================================================
// 除外 identity の導出（サーバー側で決める＝クライアント入力に依存しない）
// ============================================================
describe('buildHostMediaIdentity', () => {
  it('token 発行時（buildMediaIdentity）と同じ文字列を作る', () => {
    expect(buildHostMediaIdentity(HOST_ID)).toBe('host_owner-uuid-1')
    expect(buildHostMediaIdentity(HOST_ID)).toBe(buildMediaIdentity('host', HOST_ID, 'ignored-suffix'))
  })

  it('この一致が崩れると一括ミュートで司会者自身が黙らされる（回帰防止）', () => {
    const userId = 'another-owner-uuid'
    expect(buildMediaIdentity('host', userId, 'xxxxxxxxxxxx')).toBe(buildHostMediaIdentity(userId))
  })
})

// ============================================================
// 失敗理由 → HTTP 写像
// ============================================================
describe('muteFailureToApiError', () => {
  it('参加者不在 → 409 PARTICIPANT_NOT_FOUND', () => {
    expect(muteFailureToApiError('participant-not-found')).toMatchObject({
      status: 409,
      code: 'PARTICIPANT_NOT_FOUND',
    })
  })

  it('音声トラック無し（旁聴者）→ 409 NO_AUDIO_TRACK', () => {
    expect(muteFailureToApiError('no-audio-track')).toMatchObject({ status: 409, code: 'NO_AUDIO_TRACK' })
  })

  it('remote unmute 無効 → 409 REMOTE_UNMUTE_DISABLED', () => {
    expect(muteFailureToApiError('remote-unmute-disabled')).toMatchObject({
      status: 409,
      code: 'REMOTE_UNMUTE_DISABLED',
    })
  })

  it('LiveKit 到達不能 → 500 INTERNAL_ERROR', () => {
    expect(muteFailureToApiError('media-server-error')).toMatchObject({ status: 500, code: 'INTERNAL_ERROR' })
  })

  it('どの理由も 2xx にはならない（「押したのに無反応」を成功で返さない）', () => {
    const reasons: MuteAudioFailureReason[] = [
      'participant-not-found',
      'no-audio-track',
      'remote-unmute-disabled',
      'media-server-error',
    ]
    for (const reason of reasons) {
      const mapped = muteFailureToApiError(reason)
      expect(mapped.status).toBeGreaterThanOrEqual(400)
      expect(mapped.message.length).toBeGreaterThan(0)
    }
  })

  it('理由ごとにコードが重複しない（UI が原因を出し分けられる）', () => {
    const codes = (
      ['participant-not-found', 'no-audio-track', 'remote-unmute-disabled'] as MuteAudioFailureReason[]
    ).map((r) => muteFailureToApiError(r).code)
    expect(new Set(codes).size).toBe(codes.length)
  })
})
