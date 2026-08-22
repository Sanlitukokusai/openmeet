// 参加者一覧パネルの並び順と行データ（2026-08-07 第 2 波）。
// components/room/participant-list.ts は React にも HeroUI にも依存しない純ロジックなので、
// node 環境の vitest でそのまま叩ける（grid-layout.ts と同じ方針）。
import { describe, expect, it } from 'vitest'
import type { RemoteParticipant } from '@/lib/media/types'
import {
  buildParticipantRows,
  HOST_IDENTITY_PREFIX,
  isHostIdentity,
  SELF_ROW_ID,
  totalParticipantCount,
  type ParticipantRowsInput,
} from '@/components/room/participant-list'

function remote(id: string, overrides: Partial<RemoteParticipant> = {}): RemoteParticipant {
  return {
    id,
    name: id,
    isSpeaking: false,
    audioEnabled: true,
    videoEnabled: true,
    quality: 'good',
    ...overrides,
  }
}

function input(overrides: Partial<ParticipantRowsInput> = {}): ParticipantRowsInput {
  return {
    self: { displayName: '自分', role: 'guest' },
    localState: { audioEnabled: true, videoEnabled: false },
    participants: [],
    activeSpeakers: [],
    ...overrides,
  }
}

describe('isHostIdentity', () => {
  it('host_ 接頭辞だけを主催者と見なす（§7.3 の identity 規則）', () => {
    expect(isHostIdentity('host_abc')).toBe(true)
    expect(isHostIdentity(`${HOST_IDENTITY_PREFIX}1`)).toBe(true)
    expect(isHostIdentity('guest_abc')).toBe(false)
    expect(isHostIdentity('hostile_user')).toBe(false)
    expect(isHostIdentity('host')).toBe(false)
    // 途中に含まれるだけでは主催者にしない（表示名由来の偽装を通さない）
    expect(isHostIdentity('guest_host_abc')).toBe(false)
  })
})

describe('buildParticipantRows — 自分の置き方', () => {
  it('参加者がゼロでも必ず自分の 1 行が出る', () => {
    const rows = buildParticipantRows(input())
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: SELF_ROW_ID, isSelf: true, name: '自分' })
  })

  it('常に先頭（遠端に主催者が居ても自分が上）', () => {
    const rows = buildParticipantRows(input({ participants: [remote('host_x'), remote('guest_y')] }))
    expect(rows[0].isSelf).toBe(true)
  })

  it('自分の identity は null——遠隔ミュートの対象にできないことを型で担保する', () => {
    expect(buildParticipantRows(input())[0].identity).toBeNull()
  })

  it('自分のマイク/カメラは localState から取る（遠端の participant 情報ではない）', () => {
    const rows = buildParticipantRows(input({ localState: { audioEnabled: false, videoEnabled: true } }))
    expect(rows[0]).toMatchObject({ audioEnabled: false, videoEnabled: true })
  })

  it('role=host なら自分の行にも主催者バッジが立つ', () => {
    expect(buildParticipantRows(input({ self: { displayName: '私', role: 'host' } }))[0].isHost).toBe(true)
    expect(buildParticipantRows(input({ self: { displayName: '私', role: 'guest' } }))[0].isHost).toBe(false)
  })

  it('自分の行は発言中にしない（自分のメディア identity を知らないので推測しない）', () => {
    // activeSpeakers にローカル参加者が含まれていても（LiveKit はそうする）、
    // どれが自分かをこのクライアントは判定できない。
    const rows = buildParticipantRows(input({ activeSpeakers: ['host_x', 'unknown_local'] }))
    expect(rows[0].isSpeaking).toBe(false)
  })

  it('SELF_ROW_ID は遠端の identity 空間と衝突しない', () => {
    expect(isHostIdentity(SELF_ROW_ID)).toBe(false)
    expect(SELF_ROW_ID.startsWith('guest_')).toBe(false)
  })
})

describe('buildParticipantRows — 遠端の並び順', () => {
  it('主催者を先に、それ以外を後に（各グループ内は入室順のまま）', () => {
    const rows = buildParticipantRows(
      input({ participants: [remote('guest_b'), remote('host_a'), remote('guest_c'), remote('host_d')] }),
    )
    expect(rows.map((r) => r.id)).toEqual([SELF_ROW_ID, 'host_a', 'host_d', 'guest_b', 'guest_c'])
  })

  it('主催者が居なければ入室順そのまま', () => {
    const rows = buildParticipantRows(input({ participants: [remote('guest_c'), remote('guest_a'), remote('guest_b')] }))
    expect(rows.map((r) => r.id)).toEqual([SELF_ROW_ID, 'guest_c', 'guest_a', 'guest_b'])
  })

  it('発言中でも順番は動かない（押そうとした行が滑り込むのを防ぐ）', () => {
    const participants = [remote('guest_a'), remote('guest_b'), remote('guest_c')]
    const quiet = buildParticipantRows(input({ participants })).map((r) => r.id)
    const noisy = buildParticipantRows(input({ participants, activeSpeakers: ['guest_c'] })).map((r) => r.id)
    expect(noisy).toEqual(quiet)
  })

  it('入力配列を破壊しない（呼び出し側の participants は並べ替えられない）', () => {
    const participants = [remote('guest_b'), remote('host_a')]
    buildParticipantRows(input({ participants }))
    expect(participants.map((p) => p.id)).toEqual(['guest_b', 'host_a'])
  })
})

describe('buildParticipantRows — 行の内容', () => {
  it('遠端のマイク/カメラ状態をそのまま写す', () => {
    const rows = buildParticipantRows(
      input({ participants: [remote('guest_a', { audioEnabled: false, videoEnabled: true, name: 'あきら' })] }),
    )
    expect(rows[1]).toMatchObject({
      id: 'guest_a',
      identity: 'guest_a',
      name: 'あきら',
      isSelf: false,
      isHost: false,
      audioEnabled: false,
      videoEnabled: true,
    })
  })

  it('activeSpeakers に載っている遠端だけ isSpeaking=true', () => {
    const rows = buildParticipantRows(
      input({ participants: [remote('guest_a'), remote('guest_b')], activeSpeakers: ['guest_b'] }),
    )
    const byId = new Map(rows.map((r) => [r.id, r]))
    expect(byId.get('guest_a')?.isSpeaking).toBe(false)
    expect(byId.get('guest_b')?.isSpeaking).toBe(true)
  })

  it('activeSpeakers に居ない id が混ざっていても無視される', () => {
    const rows = buildParticipantRows(
      input({ participants: [remote('guest_a')], activeSpeakers: ['guest_zzz', 'guest_a'] }),
    )
    expect(rows[1].isSpeaking).toBe(true)
    expect(rows).toHaveLength(2)
  })

  it('遠端の identity は必ず埋まる（ミュート API に渡せる）', () => {
    const rows = buildParticipantRows(input({ participants: [remote('host_a'), remote('guest_b')] }))
    expect(rows.slice(1).every((r) => r.identity === r.id)).toBe(true)
  })
})

describe('totalParticipantCount', () => {
  it('遠端 ＋ 自分（誰も居なくても 1）', () => {
    expect(totalParticipantCount(0)).toBe(1)
    expect(totalParticipantCount(1)).toBe(2)
    expect(totalParticipantCount(5)).toBe(6)
  })

  it('パネルの行数と一致する（バッジと一覧が食い違わない）', () => {
    const participants = [remote('guest_a'), remote('host_b')]
    expect(totalParticipantCount(participants.length)).toBe(buildParticipantRows(input({ participants })).length)
  })
})
