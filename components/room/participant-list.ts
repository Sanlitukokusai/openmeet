/**
 * 参加者一覧パネルの並び順と行データ（2026-08-07 第 2 波）。
 *
 * React にも HeroUI にも依存しない純ロジック——components/room/grid-layout.ts と同じ方針で、
 * tests/room/participant-list.test.ts から直接叩いて全分岐を固定する。
 */
import type { ParticipantId, RemoteParticipant } from '@/lib/media/types'

/**
 * 主催者の LiveKit identity 接頭辞（§7.3：`host_<userId>` / `guest_<nanoid12>`）。
 *
 * ⚠️ トークン発行時にサーバーが決める形式であり、クライアントからは**この文字列でしか**
 * 主催者を判別できない（RemoteParticipant には role フィールドが無い——§3.2 は凍結）。
 * サーバー側 mute-all の除外条件（lib/server/livekit.ts / rooms-logic.ts）と同じ前提なので、
 * 命名規則を変えるならそちらも一緒に直すこと。
 */
export const HOST_IDENTITY_PREFIX = 'host_'

export function isHostIdentity(identity: string): boolean {
  return identity.startsWith(HOST_IDENTITY_PREFIX)
}

/** 自分の行に使う擬似 id。遠端の identity 空間（host_ / guest_ 接頭辞）とは絶対に衝突しない。 */
export const SELF_ROW_ID = '@self'

export interface ParticipantRow {
  /** React の key。自分の行だけは SELF_ROW_ID（メディア identity ではない）。 */
  id: string
  /** 遠隔ミュート API に渡す identity。**自分の行は null**（自分は対象にしない）。 */
  identity: ParticipantId | null
  name: string
  isSelf: boolean
  isHost: boolean
  audioEnabled: boolean
  videoEnabled: boolean
  isSpeaking: boolean
}

export interface ParticipantRowsInput {
  self: { displayName: string; role: 'host' | 'guest' }
  /** 自分のマイク/カメラ状態（遠端と違い provider の localState から来る）。 */
  localState: { audioEnabled: boolean; videoEnabled: boolean }
  participants: readonly RemoteParticipant[]
  activeSpeakers: readonly ParticipantId[]
}

/**
 * 表示順を組み立てる。
 *
 * 順序：**自分 → 遠端の主催者 → その他**。それぞれのグループ内は引数の順序（＝入室順）を
 * そのまま保つ。
 *
 * ★ 発言中の人を上に浮かせる案は採らない：一覧の行が喋るたびに入れ替わると、
 *   ミュートボタンを押そうとした瞬間に別人の行が滑り込んできて誤操作になる。
 *   発言中であることは「行の中の視覚表現」で伝え、位置は動かさない。
 *
 * ★ 自分の行に発言中表示は出さない：LiveKit の activeSpeakers はローカル参加者も含むが、
 *   このクライアントは**自分のメディア identity を知らない**（join レスポンスが返すのは
 *   DB の participants.id で、抽象インターフェース §3.2 に「自分の identity」を返す口は
 *   無い）。推測で光らせるくらいなら出さない方が正確。
 */
export function buildParticipantRows(input: ParticipantRowsInput): ParticipantRow[] {
  const speaking = new Set(input.activeSpeakers)

  const selfRow: ParticipantRow = {
    id: SELF_ROW_ID,
    identity: null,
    name: input.self.displayName,
    isSelf: true,
    isHost: input.self.role === 'host',
    audioEnabled: input.localState.audioEnabled,
    videoEnabled: input.localState.videoEnabled,
    isSpeaking: false,
  }

  const remoteRows = input.participants.map<ParticipantRow>((p) => ({
    id: p.id,
    identity: p.id,
    name: p.name,
    isSelf: false,
    isHost: isHostIdentity(p.id),
    audioEnabled: p.audioEnabled,
    videoEnabled: p.videoEnabled,
    isSpeaking: speaking.has(p.id),
  }))

  return [selfRow, ...remoteRows.filter((r) => r.isHost), ...remoteRows.filter((r) => !r.isHost)]
}

/** コントロールバーのバッジに出す総人数（遠端 ＋ 自分）。 */
export function totalParticipantCount(remoteCount: number): number {
  return remoteCount + 1
}
