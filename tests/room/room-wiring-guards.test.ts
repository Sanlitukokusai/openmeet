// 2026-08-16 実機フィードバック対応の配線を構造的に固定するガード。
//
// vitest は node 環境（jsdom 無し）で RoomExperience / ParticipantsPanel はクライアント
// コンポーネントなので、レンダリングテストはしない（本プロジェクトの既定方針。
// tests/room/video-attrs.test.ts と同じ割り切り）。ソースを機械的に検査して、
// 「うっかり退出ボタンを handleLeave 直呼びに戻す」「guest 案内の分岐を消す」といった
// 回帰を防ぐ。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')
}

/** コメントを落としてから走査する（video-attrs.test.ts / speaking-highlight.test.ts と同じ作法）。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const roomExperienceSource = stripComments(readSource('../../components/room/RoomExperience.tsx'))
const participantsPanelSource = stripComments(readSource('../../components/room/ParticipantsPanel.tsx'))

describe('離開（退出）ボタンは確認モーダルを経由してから断線する', () => {
  it('<ControlBar> の onLeave は handleLeave を直接指さない', () => {
    const controlBarTag = roomExperienceSource.match(/<ControlBar[\s\S]*?\/>/)?.[0]
    expect(controlBarTag, 'RoomExperience.tsx に <ControlBar> の JSX が見つからない').toBeTruthy()
    expect(controlBarTag).toMatch(/onLeave=\{[^}]*\}/)
    expect(controlBarTag).not.toMatch(/onLeave=\{\s*handleLeave\s*\}/)
  })

  it('LeaveConfirmModal が import され、レンダーツリーに存在する', () => {
    expect(roomExperienceSource).toMatch(/import\s*\{\s*LeaveConfirmModal\s*\}\s*from\s*['"]\.\/LeaveConfirmModal['"]/)
    expect(roomExperienceSource).toMatch(/<LeaveConfirmModal[\s\S]*?\/>/)
  })

  it('handleLeave（実際の退出処理）自体は引き続き存在する（確認後に呼ばれるため）', () => {
    expect(roomExperienceSource).toMatch(/function handleLeave\(/)
  })

  it('LeaveConfirmModal と EndMeetingModal は別々の disclosure を使う（片方の確認がもう片方に波及しない）', () => {
    const endTag = roomExperienceSource.match(/<EndMeetingModal[\s\S]*?\/>/)?.[0]
    const leaveTag = roomExperienceSource.match(/<LeaveConfirmModal[\s\S]*?\/>/)?.[0]
    expect(endTag, 'EndMeetingModal の JSX が見つからない').toBeTruthy()
    expect(leaveTag, 'LeaveConfirmModal の JSX が見つからない').toBeTruthy()
    const endIsOpen = endTag?.match(/isOpen=\{([^}]+)\}/)?.[1]
    const leaveIsOpen = leaveTag?.match(/isOpen=\{([^}]+)\}/)?.[1]
    expect(endIsOpen).toBeTruthy()
    expect(leaveIsOpen).toBeTruthy()
    expect(endIsOpen).not.toBe(leaveIsOpen)
  })
})

describe('参会者面板の guest 向け案内（身份診断・2026-08-16）', () => {
  it('guest 向け案内は self.role を条件にしている（requireLogin は見ない）', () => {
    expect(participantsPanelSource).toMatch(/self\.role\s*!==\s*['"]host['"][\s\S]{0,300}t\.guestNotice/)
  })

  it('guestNotice / guestBadge の文言キーが実際に使われている', () => {
    expect(participantsPanelSource).toMatch(/t\.guestNotice/)
    expect(participantsPanelSource).toMatch(/t\.guestBadge/)
  })

  it('guest バッジは自分の行だけに限定されている（全 guest 行に付けない）', () => {
    expect(participantsPanelSource).toMatch(/row\.isSelf\s*&&\s*!row\.isHost[\s\S]{0,300}t\.guestBadge/)
  })
})
