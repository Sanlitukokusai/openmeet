// POST /api/rooms/{id}/end 用：LiveKit 側のルームを強制終了して全参加者を切断する。
// livekit-server-sdk の RoomServiceClient は管理 API 呼び出しであり、
// lib/media/** の MediaProvider 抽象（ブラウザ側の livekit-client）とは別物なので
// ESLint の no-restricted-imports（livekit-client 限定）の対象外。
import 'server-only'
import { AccessToken, RoomServiceClient, TrackType } from 'livekit-server-sdk'
import type { ParticipantRole } from '@/lib/database.types'
import { planMuteAllTargets, type MuteAllCandidate, type MuteAudioFailureReason } from '@/lib/server/rooms-logic'

function toHttpUrl(wsUrl: string): string {
  return wsUrl.replace(/^wss:\/\//i, 'https://').replace(/^ws:\/\//i, 'http://')
}

let cachedClient: RoomServiceClient | null = null

/**
 * requestTimeout=5 秒（SDK 既定は 10 秒）。
 * 2026-08-07：全局容量闸が **入会と会議室作成のたびに** LiveKit を叩くようになったため、
 * LiveKit が「落ちている」のではなく「無応答でぶら下がっている」ときの待ち時間が
 * そのまま全リクエストの応答時間になる。ここで叩くのは全部メタデータ API
 * （listRooms / getParticipant / mute / createRoom / deleteRoom）で、東京の同一
 * リージョンなら数十 ms。5 秒あれば正常系は取りこぼさず、異常系の巻き添えは半減する。
 */
function getRoomServiceClient(): RoomServiceClient {
  if (!cachedClient) {
    const host = toHttpUrl(process.env.NEXT_PUBLIC_LIVEKIT_URL!)
    cachedClient = new RoomServiceClient(host, process.env.LIVEKIT_API_KEY!, process.env.LIVEKIT_API_SECRET!, {
      requestTimeout: 5,
    })
  }
  return cachedClient
}

/**
 * LiveKit（Twirp）の「対象が存在しない」系エラー判定。
 * ServerError は status=404 / code='not_found' を持つが、SDK のバージョン差や
 * 中間プロキシ由来のエラーもあり得るのでメッセージ文言も併せて見る。
 * ルーム不在（deleteRoom / listParticipants）と参加者不在（getParticipant）の
 * 両方で使う——どちらも「もう居ない」という同じ意味の異常系。
 */
function isNotFoundError(err: unknown): boolean {
  if (err instanceof Error && /not[_ ]?found|does not exist/i.test(err.message)) return true
  if (typeof err === 'object' && err !== null) {
    const e = err as { status?: number; code?: string }
    if (e.status === 404) return true
    if (e.code === 'not_found') return true
  }
  return false
}

/**
 * LiveKit サーバー設定 `room.enable_remote_unmute` が false（既定値）のとき、
 * mutePublishedTrack(muted=false) は "cannot unmute track, remote unmute is disabled"
 * で失敗する。プライバシー保護のための既定動作であり、こちらのバグではないので
 * 呼び出し側が区別できるようにする（運用側で設定を入れるまで解除は通らない）。
 */
function isRemoteUnmuteDisabledError(err: unknown): boolean {
  return err instanceof Error && /remote unmute/i.test(err.message)
}

/**
 * LiveKit 房间を削除して全参加者を切断する（規格书 §6.1 POST /{id}/end）。
 * WP-1 の時点ではまだ join フロー（WP-2）が無いため、誰も入室していない
 * ルームに対して呼ばれるのが通常運転——「房间不存在」はここで容忍し、
 * それ以外のエラー（LiveKit 到達不能など）もログに残すのみで上位には伝播させない。
 * 理由：DB 側（meetings.ended_at）の後始末が本エンドポイントの主目的であり、
 * メディアサーバー側の切断はベストエフォートのクリーンアップだから。
 */
export async function endLiveKitRoom(mediaRoomName: string): Promise<void> {
  try {
    await getRoomServiceClient().deleteRoom(mediaRoomName)
  } catch (err) {
    if (!isNotFoundError(err)) {
      console.error('[livekit] deleteRoom failed for', mediaRoomName, err)
    }
  }
}

export interface JoinTokenParams {
  /** §7.3：host_<userId> / guest_<nanoid12>。LiveKit 側の participant identity になる。 */
  identity: string
  /** 表示名（Participant.name）。 */
  displayName: string
  mediaRoomName: string
  role: ParticipantRole
  /** 秒。lib/server/join-policy.ts の computeTokenTtlSeconds() で算出済み（必ず 1 以上）。 */
  ttlSeconds: number
}

/**
 * 入会 token を発行する（規格書 §7.3 の grant をそのまま実装）。
 *
 * ⚠️ ttlSeconds に 0 を渡してはならない：SDK 内部が `options?.ttl || defaultTTL` で
 * あるため 0 は既定の 6 時間に化ける。呼び出し側（computeTokenTtlSeconds）が
 * 1 以上を保証している。
 */
export async function issueJoinToken(params: JoinTokenParams): Promise<string> {
  const at = new AccessToken(process.env.LIVEKIT_API_KEY!, process.env.LIVEKIT_API_SECRET!, {
    identity: params.identity,
    name: params.displayName,
    ttl: params.ttlSeconds,
  })
  at.addGrant({
    roomJoin: true,
    room: params.mediaRoomName,
    canPublish: true,
    canSubscribe: true,
    // 2026-08-07 変更：false → true。§7.3 の原値 false は「MVP にチャットは無い」
    // 時代の判断だったが、後続のチャット機能（DataChannel 経由）の前提として開放する。
    // 併せて司会者ミュートの UI 通知など、メディア以外のリアルタイム連携もここに乗る。
    canPublishData: true,
    // 房主のみ踢人 / 会議終了が可能。
    roomAdmin: params.role === 'host',
  })
  return at.toJwt()
}

/**
 * §12.8 の第二の防波堤：LiveKit 側にも人数上限を持たせておく。
 * 一次的な強制は token 発行時（join-policy の checkCapacity）で行うので、
 * ここは **ベストエフォート**——既に同名ルームが存在する場合や LiveKit 到達不能でも
 * 入会そのものは止めない（ログのみ）。
 *
 * emptyTimeout=300：誰も入らないまま 5 分で自動破棄。
 * departureTimeout=20：最後の 1 人が抜けてから 20 秒でルームを閉じる。
 * 既存ルームに対する createRoom は LiveKit 側で冪等（現在の設定が返るだけ）だが、
 * **既存ルームの maxParticipants は更新されない**——max_participants を PATCH で
 * 変更した場合、LiveKit 側の上限は次にルームが破棄されるまで古い値のまま。
 * DB 側の強制が一次防衛線なので実害は無い。
 */
export async function ensureLiveKitRoom(mediaRoomName: string, maxParticipants: number): Promise<void> {
  try {
    await getRoomServiceClient().createRoom({
      name: mediaRoomName,
      maxParticipants,
      emptyTimeout: 300,
      departureTimeout: 20,
    })
  } catch (err) {
    console.error('[livekit] createRoom (best-effort) failed for', mediaRoomName, err)
  }
}

// ============================================================
// 司会者ミュート（2026-08-07 追加）。
// **サーバー側強制**であることが要件：クライアントに「静かにしてください」と
// 頼むのではなく、RoomServiceClient の管理 API で発行済みトラックを実際に止める。
// 対象参加者のブラウザが何をしていようとメディアは流れなくなる。
// ============================================================

// 失敗理由の型と HTTP 写像（muteFailureToApiError）は lib/server/rooms-logic.ts 側に置いてある
// ——本ファイルは `server-only` で vitest から import できないため、写像表はテスト可能な純ロジック層へ。
export type MuteAudioResult =
  /** 実際に mute/unmute を適用した音声トラック数（通常は 1、画面共有音声があれば 2 以上）。 */
  | { ok: true; trackCount: number }
  | { ok: false; reason: MuteAudioFailureReason }

function audioTrackSids(tracks: { sid: string; type: TrackType }[]): string[] {
  return tracks.filter((t) => t.type === TrackType.AUDIO).map((t) => t.sid)
}

/**
 * 指定参加者の音声トラックを mute / unmute する。
 *
 * ★ 例外を投げない契約：旁聴参加者（音声トラック無し）や既に退出した参加者に対して
 *   呼ばれるのは**通常運転**——司会者の画面が一瞬古いだけで起こる。呼び出し側が
 *   利用者向けメッセージを出し分けられるよう、区別可能な理由を戻り値で返す。
 *
 * 音声トラックが複数ある場合（マイク＋画面共有音声）は**全部**に適用する。
 * 「この人を黙らせる」という司会者の意図に対して、片方だけ残るのは期待外れなので。
 */
export async function muteParticipantAudio(
  mediaRoomName: string,
  identity: string,
  muted: boolean,
): Promise<MuteAudioResult> {
  const client = getRoomServiceClient()

  let sids: string[]
  try {
    const participant = await client.getParticipant(mediaRoomName, identity)
    sids = audioTrackSids(participant.tracks)
  } catch (err) {
    if (isNotFoundError(err)) return { ok: false, reason: 'participant-not-found' }
    console.error('[livekit] getParticipant failed', { mediaRoomName, identity }, err)
    return { ok: false, reason: 'media-server-error' }
  }

  if (sids.length === 0) return { ok: false, reason: 'no-audio-track' }

  let applied = 0
  let unmuteDisabled = false
  for (const sid of sids) {
    try {
      await client.mutePublishedTrack(mediaRoomName, identity, sid, muted)
      applied += 1
    } catch (err) {
      if (isRemoteUnmuteDisabledError(err)) {
        unmuteDisabled = true
      } else {
        console.error('[livekit] mutePublishedTrack failed', { mediaRoomName, identity, sid, muted }, err)
      }
    }
  }

  // 1 本でも通れば成功扱い（部分適用でも「音は止まった」方に倒す）。
  if (applied > 0) return { ok: true, trackCount: applied }
  if (unmuteDisabled) return { ok: false, reason: 'remote-unmute-disabled' }
  return { ok: false, reason: 'media-server-error' }
}

export interface MuteAllAudioResult {
  /** 実際に 1 本以上の音声トラックをミュートできた参加者数。 */
  muted: number
  /** 対象外だった参加者数（exceptIdentity 本人＋音声トラックを持たない旁聴者）。 */
  skipped: number
  /** ミュートを試みたが LiveKit 側で失敗した参加者数。0 でないなら要調査（ログに詳細あり）。 */
  failed: number
}

/**
 * ルーム内の全参加者を一括ミュートする（exceptIdentity は除外）。
 *
 * ★ 部分失敗で中断しない：1 人分の API 呼び出しが失敗しても残りは続行し、
 *   最後に件数を集計して返す。「10 人中 9 人は黙った」という事実の方が、
 *   途中で例外を投げて何人止まったのか分からなくなるより司会者の役に立つ。
 *
 * @returns 集計結果 / **参加者一覧そのものが引けなければ null**（＝何も実行していない）
 */
export async function muteAllParticipantsAudio(
  mediaRoomName: string,
  exceptIdentity: string | null,
): Promise<MuteAllAudioResult | null> {
  const client = getRoomServiceClient()

  let candidates: MuteAllCandidate[]
  try {
    const participants = await client.listParticipants(mediaRoomName)
    candidates = participants.map((p) => ({ identity: p.identity, audioTrackSids: audioTrackSids(p.tracks) }))
  } catch (err) {
    // ルームが LiveKit 側に無い＝誰も接続していない。「0 人ミュートした」が正しい答えで、
    // エラーではない（会議開始前に一括ミュートを押した場合に起こる）。
    if (isNotFoundError(err)) return { muted: 0, skipped: 0, failed: 0 }
    console.error('[livekit] listParticipants failed', { mediaRoomName }, err)
    return null
  }

  const plan = planMuteAllTargets(candidates, exceptIdentity)
  let muted = 0
  let failed = 0

  for (const target of plan.targets) {
    let applied = 0
    for (const sid of target.audioTrackSids) {
      try {
        await client.mutePublishedTrack(mediaRoomName, target.identity, sid, true)
        applied += 1
      } catch (err) {
        console.error('[livekit] mute-all: mutePublishedTrack failed', { mediaRoomName, identity: target.identity, sid }, err)
      }
    }
    if (applied > 0) muted += 1
    else failed += 1
  }

  return { muted, skipped: plan.skipped, failed }
}

// ============================================================
// 在線人数の取得（listRooms）。
// 全局容量闸（capacity.ts）と会議室一覧の「今何人いるか」表示が同じ 1 本の API を
// 共有する。**呼び出しは 1 リクエストにつき 1 回**——部屋ごとに listRooms を叩いたり、
// getParticipant を人数分回したりしない（40 Mbps の東京機に無駄な往復を積まない）。
// タイムアウトは getRoomServiceClient() の requestTimeout=5 秒がそのまま効く。
// ============================================================

/** listRooms から必要な 2 項目だけ抜いた形。 */
interface LiveRoomSummary {
  name: string
  numParticipants: number
}

/**
 * 全ルームの一覧を 1 回だけ引く共通土台。
 * @returns 一覧 / **LiveKit へ到達できなければ null**（空配列にフォールバックしない——
 *          「1 部屋も無い」と「分からない」は呼び出し側にとって全く別の事実）
 */
async function listLiveRooms(): Promise<LiveRoomSummary[] | null> {
  try {
    const rooms = await getRoomServiceClient().listRooms()
    return rooms.map((room) => ({ name: room.name, numParticipants: room.numParticipants }))
  } catch (err) {
    console.error('[livekit] listRooms failed', err)
    return null
  }
}

/**
 * LiveKit サーバー全体の在線人数（全ルームの numParticipants の合計）。
 * 全局并发上限（40 Mbps の容量保護）の一次統計源。
 *
 * @returns 人数 / **LiveKit へ到達できなければ null**（0 にフォールバックしない——
 *          「誰も居ない」と「分からない」は容量判定にとって全く別の事実。
 *          どうするかは呼び出し側 lib/server/capacity.ts が決める）
 */
export async function getGlobalOnlineCount(): Promise<number | null> {
  const rooms = await listLiveRooms()
  if (rooms === null) return null
  return rooms.reduce((sum, room) => sum + room.numParticipants, 0)
}

/** media_room_name → 現在その部屋に接続している人数。 */
export type RoomOccupancyMap = ReadonlyMap<string, number>

/**
 * 会議室ごとの在線人数（GET /api/rooms の `activeParticipants` 用）。
 *
 * LiveKit は**誰も居ない部屋を一覧に出さない**（emptyTimeout / departureTimeout で
 * 破棄される）ので、写像に無い ＝ 0 人。呼び出し側はその区別を持つこと：
 *   - 写像あり・キー無し → 0 人（＝「待機中」）
 *   - 写像そのものが null → 人数不明（＝「利用可能」。0 人と言い切ってはいけない）
 *
 * @returns 写像 / **LiveKit へ到達できなければ null**
 */
export async function getRoomOccupancy(): Promise<RoomOccupancyMap | null> {
  const rooms = await listLiveRooms()
  if (rooms === null) return null
  return new Map(rooms.map((room) => [room.name, room.numParticipants]))
}
