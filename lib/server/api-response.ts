// Route Handler 共通のエラーレスポンス整形。
// 目的：全エンドポイントで { error: { code, message } } の形を統一し、
// 各 route.ts での重複を避ける。
import 'server-only'
import { NextResponse } from 'next/server'

export type ApiErrorCode =
  | 'UNAUTHORIZED'
  | 'VALIDATION_ERROR'
  | 'ROOM_NOT_FOUND'
  | 'AUTH_FAILED'
  | 'INTERNAL_ERROR'
  // ↓ §6.2 加入流程（lib/server/join-policy.ts の JoinDenyCode と一対一）
  | 'ROOM_EXPIRED'
  | 'ROOM_ENDED'
  | 'LOGIN_REQUIRED'
  | 'TOO_MANY_ATTEMPTS'
  | 'INVALID_PASSWORD'
  | 'ROOM_FULL'
  // ↓ 2026-08-07 追加：全局并发上限（40 Mbps の容量保護）。HTTP 503。
  // **ROOM_FULL（この部屋が定員）とは別物**——こちらは「サーバー全体が混雑」。
  | 'SERVER_AT_CAPACITY'
  // ↓ 2026-08-07 追加：司会者ミュート。いずれも HTTP 409（房主の鉴权は通っているが、
  //   対象参加者の現在の状態がその操作を受け付けない）。
  /** その identity は現在ルームに居ない（司会者の画面が古い）。 */
  | 'PARTICIPANT_NOT_FOUND'
  /** 居るが音声トラックを publish していない（旁聴参加者）。ミュートする対象が無い。 */
  | 'NO_AUDIO_TRACK'
  /** LiveKit 側の `room.enable_remote_unmute` が false。ミュート解除だけが通らない。 */
  | 'REMOTE_UNMUTE_DISABLED'

export function apiError(status: number, code: ApiErrorCode, message: string) {
  return NextResponse.json({ error: { code, message } }, { status })
}
