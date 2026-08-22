// カメラの自己修復を UI にどう伝えるかの判定（2026-08-14 第 2 波）。
//
// provider は黙ってカメラを取り直すので、UI から見える手掛かりは videoEnabled の
// false→true という**自分の操作と区別が付かない**変化だけ。micIntent と同じ
// 「呼ぶ直前に置いた意図」で由来を判定し、猶予タイマーで成功/失敗を出し分ける。
//
// ここで固定する一番の性質：**自分でカメラを切ったのに「カメラが停止しました」と
// 言わない**（＝誤検知しない）。もう一つ：**復旧できなかった経路を無言にしない**。
import { describe, expect, it } from 'vitest'
import {
  CAMERA_INTENT_TTL_MS,
  classifyCameraChange,
  planCameraNotice,
  type CameraIntent,
} from '@/components/room/camera-notice'

const NOW = 1_700_000_000_000
const intent = (enabled: boolean, ttl = CAMERA_INTENT_TTL_MS): CameraIntent => ({
  enabled,
  expiresAt: NOW + ttl,
})

describe('classifyCameraChange', () => {
  it('変化がなければ null（トーストの起点にならない）', () => {
    expect(classifyCameraChange(true, true, null, NOW)).toBeNull()
    expect(classifyCameraChange(false, false, intent(true), NOW)).toBeNull()
  })

  it('意図と一致する変化はローカル由来', () => {
    expect(classifyCameraChange(true, false, intent(false), NOW)).toEqual({
      source: 'local',
      videoEnabled: false,
    })
    expect(classifyCameraChange(false, true, intent(true), NOW)).toEqual({
      source: 'local',
      videoEnabled: true,
    })
  })

  it('意図が無ければ自動由来（＝provider が勝手に動かした）', () => {
    expect(classifyCameraChange(true, false, null, NOW)).toEqual({ source: 'auto', videoEnabled: false })
  })

  it('意図の向きが逆なら自動由来（オンにしようとした直後のオフ＝失敗/横取り）', () => {
    expect(classifyCameraChange(true, false, intent(true), NOW)).toEqual({
      source: 'auto',
      videoEnabled: false,
    })
  })

  it('期限切れの意図は使わない', () => {
    const stale: CameraIntent = { enabled: false, expiresAt: NOW - 1 }
    expect(classifyCameraChange(true, false, stale, NOW)).toEqual({ source: 'auto', videoEnabled: false })
  })

  it('期限ちょうどはまだ有効（境界は「一致すればローカル」＝誤検知しない側）', () => {
    const edge: CameraIntent = { enabled: false, expiresAt: NOW }
    expect(classifyCameraChange(true, false, edge, NOW)?.source).toBe('local')
  })
})

describe('planCameraNotice', () => {
  it.each([
    // change,                                        pending, 期待
    [null, false, 'idle'],
    [null, true, 'idle'],
    // --- 自分の操作：何も言わない。張ってあるタイマーだけ畳む ---
    [{ source: 'local', videoEnabled: false }, false, 'idle'],
    [{ source: 'local', videoEnabled: false }, true, 'cancel'],
    [{ source: 'local', videoEnabled: true }, false, 'idle'],
    [{ source: 'local', videoEnabled: true }, true, 'cancel'],
    // --- 勝手にオフ：猶予タイマーを張る（期限切れ＝停止の案内） ---
    [{ source: 'auto', videoEnabled: false }, false, 'armStopped'],
    [{ source: 'auto', videoEnabled: false }, true, 'armStopped'],
    // --- 勝手にオン：猶予中なら復旧成功、そうでなければ黙る ---
    [{ source: 'auto', videoEnabled: true }, true, 'recovered'],
    [{ source: 'auto', videoEnabled: true }, false, 'idle'],
  ] as const)('change=%j pending=%s → %s', (change, pending, expected) => {
    expect(planCameraNotice(change, pending)).toBe(expected)
  })

  it('ユーザー操作は「停止しました」を絶対に出さない（全組み合わせ）', () => {
    for (const videoEnabled of [true, false]) {
      for (const pending of [true, false]) {
        const plan = planCameraNotice({ source: 'local', videoEnabled }, pending)
        expect(plan).not.toBe('armStopped')
        expect(plan).not.toBe('recovered')
      }
    }
  })

  it('自動でオフになった経路は必ず何かに繋がる（無言にならない）', () => {
    // armStopped＝猶予後に案内、その間にオンが来れば recovered。どちらでもトーストが出る。
    expect(planCameraNotice({ source: 'auto', videoEnabled: false }, false)).toBe('armStopped')
    expect(planCameraNotice({ source: 'auto', videoEnabled: true }, true)).toBe('recovered')
  })

  // provider の自己修復は setCameraEnabled(false) → (true) の二段で観測される。
  // その一連が「停止しました」ではなく「復旧しました」1 枚になることを、順番に流して確認する。
  it('自己修復のシーケンス（off → on）は復旧トースト 1 枚に収束する', () => {
    let pending = false
    const plans: string[] = []

    const step = (change: Parameters<typeof planCameraNotice>[0]) => {
      const plan = planCameraNotice(change, pending)
      plans.push(plan)
      if (plan === 'armStopped') pending = true
      if (plan === 'recovered' || plan === 'cancel') pending = false
    }

    step({ source: 'auto', videoEnabled: false })
    step({ source: 'auto', videoEnabled: true })

    expect(plans).toEqual(['armStopped', 'recovered'])
    expect(pending).toBe(false) // タイマーは残らない＝あとから遅れて誤通知しない
  })

  it('復旧しなければ猶予タイマーが残る（＝期限切れで停止の案内が出る）', () => {
    let pending = false
    const plan = planCameraNotice({ source: 'auto', videoEnabled: false }, pending)
    if (plan === 'armStopped') pending = true
    expect(pending).toBe(true)
  })

  it('復旧待ちの最中にユーザーが自分で操作したら、案内は取り消される', () => {
    // 「勝手にオフ→ユーザーが自分でオンにした」：停止の案内は不要（本人が把握している）
    expect(planCameraNotice({ source: 'local', videoEnabled: true }, true)).toBe('cancel')
  })
})
