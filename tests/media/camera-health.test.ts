// カメラ自己修復の判定（2026-08-14 実機「揺らしたら真っ黒」の対策その 3）。
//
// ここで固定したい一番の性質は **「ユーザーが自分で切ったカメラを、勝手に点け直さない」**。
// 黒画面を直そうとして勝手にカメラを開くのは、黒画面よりよほど重い事故（プライバシー）なので、
// 判定順とマトリクスを機械的に縛る。lib/media/providers/livekit/camera-health.ts は
// livekit-client を一切引かないので node 環境の vitest からそのまま叩ける。
import { describe, expect, it } from 'vitest'
import {
  BACKGROUND_FALLBACK_THRESHOLD,
  CAMERA_RECOVERY_THROTTLE_MS,
  CAMERA_RECOVERY_WINDOW_MS,
  decideCameraHealth,
  pruneRecoveryAttempts,
  shouldDropBackgroundEffect,
  type CameraHealthInput,
} from '@/lib/media/providers/livekit/camera-health'
import { planBackgroundApply } from '@/lib/media/providers/livekit/background'

const NOW = 1_700_000_000_000

/** 「カメラは正常に動いている」既定形。各テストは壊したい 1 項目だけを上書きする。 */
function healthy(overrides: Partial<CameraHealthInput> = {}): CameraHealthInput {
  return {
    phase: 'track-event',
    connected: true,
    desiredEnabled: true,
    hasCameraTrack: true,
    publicationMuted: false,
    readyState: 'live',
    browserMuted: false,
    lastAttemptAt: undefined,
    now: NOW,
    ...overrides,
  }
}

// ============================================================
// 1. 絶対に触ってはいけないケース（誤検知の禁止）
// ============================================================

describe('ユーザーが自分でカメラを切っている間は、何があっても再取得しない', () => {
  it.each([
    ['トラックが ended', { readyState: 'ended' as const }],
    ['ブラウザに mute された', { browserMuted: true }],
    ['前面復帰の点検でも', { phase: 'resume' as const, browserMuted: true }],
    ['ended かつ前面復帰でも', { phase: 'resume' as const, readyState: 'ended' as const }],
  ])('%s でも desiredEnabled=false なら none/user_disabled', (_label, broken) => {
    expect(decideCameraHealth(healthy({ desiredEnabled: false, ...broken }))).toEqual({
      action: 'none',
      reason: 'user_disabled',
    })
  })

  it('判定順：user_disabled は not_connected の次・他のどの判定より手前', () => {
    // 未接続かつユーザーオフ → 先に評価される not_connected が勝つ（どちらも「何もしない」）
    expect(decideCameraHealth(healthy({ connected: false, desiredEnabled: false })).action).toBe('none')
    // トラック無しとユーザーオフが同時 → user_disabled が勝つ（＝理由の取り違えをしない）
    expect(decideCameraHealth(healthy({ desiredEnabled: false, hasCameraTrack: false })).reason).toBe(
      'user_disabled',
    )
  })
})

describe('遠隔ミュート / 自分のミュートを「故障」と誤認しない', () => {
  it('publication が muted なら、たとえ browserMuted でも触らない', () => {
    expect(decideCameraHealth(healthy({ publicationMuted: true, browserMuted: true }))).toEqual({
      action: 'none',
      reason: 'track_muted',
    })
  })

  it('publication が muted なら、前面復帰の点検でも触らない', () => {
    expect(
      decideCameraHealth(healthy({ phase: 'resume', publicationMuted: true, browserMuted: true })).action,
    ).toBe('none')
  })
})

describe('修復対象が存在しない / そもそも動いていない', () => {
  it('未接続なら何もしない（再取得しても publish 先が無い）', () => {
    expect(decideCameraHealth(healthy({ connected: false }))).toEqual({
      action: 'none',
      reason: 'not_connected',
    })
  })

  it('カメラトラックが無ければ何もしない（オフ直後・権限拒否後）', () => {
    expect(decideCameraHealth(healthy({ hasCameraTrack: false }))).toEqual({
      action: 'none',
      reason: 'no_track',
    })
  })

  it('正常なら何もしない', () => {
    expect(decideCameraHealth(healthy())).toEqual({ action: 'none', reason: 'healthy' })
    expect(decideCameraHealth(healthy({ phase: 'resume' }))).toEqual({ action: 'none', reason: 'healthy' })
  })

  it('readyState が読めない（processor が源トラックを隠している）なら何もしない側に倒す', () => {
    expect(decideCameraHealth(healthy({ readyState: undefined })).action).toBe('none')
    expect(decideCameraHealth(healthy({ phase: 'resume', readyState: undefined })).action).toBe('none')
  })
})

// ============================================================
// 2. 実際に壊れているケース
// ============================================================

describe('壊れていれば再取得する', () => {
  it('readyState が ended なら、どの phase でも restart', () => {
    for (const phase of ['track-event', 'resume'] as const) {
      expect(decideCameraHealth(healthy({ phase, readyState: 'ended' }))).toEqual({
        action: 'restart',
        reason: 'track_ended',
      })
    }
  })

  it('mute のままでも track-event の段階では待つ（自力復帰するのが普通）', () => {
    expect(decideCameraHealth(healthy({ browserMuted: true }))).toEqual({
      action: 'none',
      reason: 'transient_mute',
    })
  })

  it('前面に戻ったのにまだ mute なら、自力復帰に失敗している → restart', () => {
    expect(decideCameraHealth(healthy({ phase: 'resume', browserMuted: true }))).toEqual({
      action: 'restart',
      reason: 'stalled_after_resume',
    })
  })

  it('ended は browserMuted より優先して理由付けされる（原因の取り違え防止）', () => {
    expect(
      decideCameraHealth(healthy({ phase: 'resume', readyState: 'ended', browserMuted: true })).action,
    ).toBe('restart')
    expect(
      decideCameraHealth(healthy({ phase: 'resume', readyState: 'ended', browserMuted: true })),
    ).toMatchObject({ reason: 'track_ended' })
  })
})

// ============================================================
// 3. スロットル（失敗ループで getUserMedia を連打しない）
// ============================================================

describe('スロットル', () => {
  it('直近に試していれば、壊れていても待つ', () => {
    expect(
      decideCameraHealth(healthy({ readyState: 'ended', lastAttemptAt: NOW - 1_000 })),
    ).toEqual({ action: 'none', reason: 'throttled' })
  })

  it('窓を過ぎていれば再び試す', () => {
    expect(
      decideCameraHealth(
        healthy({ readyState: 'ended', lastAttemptAt: NOW - CAMERA_RECOVERY_THROTTLE_MS - 1 }),
      ).action,
    ).toBe('restart')
  })

  it('境界（ちょうど throttleMs 経過）は試す側', () => {
    expect(
      decideCameraHealth(
        healthy({ readyState: 'ended', lastAttemptAt: NOW - CAMERA_RECOVERY_THROTTLE_MS }),
      ).action,
    ).toBe('restart')
  })

  it('スロットルは「壊れている」と判定した後にだけ効く（正常時に throttled とは言わない）', () => {
    expect(decideCameraHealth(healthy({ lastAttemptAt: NOW - 10 })).reason).toBe('healthy')
  })

  it('throttleMs は上書きできる', () => {
    expect(
      decideCameraHealth(
        healthy({ readyState: 'ended', lastAttemptAt: NOW - 50, throttleMs: 10 }),
      ).action,
    ).toBe('restart')
  })
})

// ============================================================
// 4. 背景効果を道連れにするかの判定
// ============================================================

describe('pruneRecoveryAttempts', () => {
  it('窓の外の試行を落とす', () => {
    const attempts = [NOW - CAMERA_RECOVERY_WINDOW_MS - 1, NOW - 1_000, NOW]
    expect(pruneRecoveryAttempts(attempts, NOW)).toEqual([NOW - 1_000, NOW])
  })

  it('窓の内側だけなら全部残る／空配列でも落ちない', () => {
    expect(pruneRecoveryAttempts([NOW - 10, NOW], NOW)).toHaveLength(2)
    expect(pruneRecoveryAttempts([], NOW)).toEqual([])
  })
})

describe('shouldDropBackgroundEffect', () => {
  it('背景効果が掛かっていなければ常に false（捨てるものが無い）', () => {
    expect(shouldDropBackgroundEffect({ backgroundActive: false, recentAttempts: 99 })).toBe(false)
  })

  it('1 回目の故障では効果を保つ（大半はカメラ側の事情で、管線は無罪）', () => {
    expect(shouldDropBackgroundEffect({ backgroundActive: true, recentAttempts: 1 })).toBe(false)
  })

  it('同じ窓で繰り返すなら管線を犯人とみなして捨てる（カメラ本体を生かす）', () => {
    expect(
      shouldDropBackgroundEffect({ backgroundActive: true, recentAttempts: BACKGROUND_FALLBACK_THRESHOLD }),
    ).toBe(true)
    expect(shouldDropBackgroundEffect({ backgroundActive: true, recentAttempts: 5 })).toBe(true)
  })

  it('閾値は上書きできる', () => {
    expect(shouldDropBackgroundEffect({ backgroundActive: true, recentAttempts: 1, threshold: 1 })).toBe(true)
  })
})

// ============================================================
// 5. 自己修復とバックグラウンド効果の噛み合わせ
//    （restartCamera は setCameraEnabled(false)→(true) を撃つので、
//     再取得後は「別のトラック」になる＝効果は recreate で載せ直される）
// ============================================================

describe('カメラ再取得の後、背景効果は載せ直される', () => {
  it('新しいトラックには processor が付いていないので plan は recreate', () => {
    expect(
      planBackgroundApply({
        hasCameraTrack: true,
        processorAttachedToCurrentTrack: false, // 再取得直後＝別トラック
        effect: { type: 'blur', blurRadius: 25 },
      }),
    ).toEqual({ action: 'recreate' })
  })

  it('効果が none なら再取得しても何も載せない（CPU を残さない契約）', () => {
    expect(
      planBackgroundApply({
        hasCameraTrack: true,
        processorAttachedToCurrentTrack: false,
        effect: { type: 'none' },
      }),
    ).toEqual({ action: 'teardown' })
  })
})
