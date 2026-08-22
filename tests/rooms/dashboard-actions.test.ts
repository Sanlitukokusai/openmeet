// headless 回归测试：只测 app/dashboard/room-actions.ts 的纯逻辑（按钮可用性矩阵 +
// 编辑表单 diff 计算）。room-actions.ts 只 `import type` lib/server/rooms-logic.ts，
// 本文件同样只做类型导入，不 import lib/supabase.ts（其 `server-only` 在 vitest 的
// node 环境下会直接抛错）。
import { describe, expect, it } from 'vitest'
import {
  computeRoomPatchDiff,
  EDIT_MAX_PARTICIPANTS_MAX,
  EDIT_MAX_PARTICIPANTS_MIN,
  EDIT_PASSWORD_MAX,
  EDIT_PASSWORD_MIN,
  getRoomActionDisabledReason,
  isEmptyPatch,
  isoToLocalDateTime,
  isRoomActionEnabled,
  localDateTimeToIso,
  validateRoomEditForm,
  type RoomAction,
  type RoomEditBaseline,
  type RoomEditFormValues,
} from '@/app/dashboard/room-actions'
import type { RoomState } from '@/lib/server/rooms-logic'
// WP-8：locale 引数の挙動確認用。room-actions.ts 自身が依存している uiText を
// テスト側でも参照し、返ってくる文言が辞書の値と一致することを固定する
// （既存の「非 null / 非空文字」だけのアサーションより一段強い回帰）。
import { uiText } from '@/lib/ui-text'

// ============ ボタン可用性マトリクス（4 status × 3 action = 12）============
describe('isRoomActionEnabled — button availability matrix (4 status x 4 actions)', () => {
  const MATRIX: Array<{ status: RoomState; action: RoomAction; expected: boolean }> = [
    // active：すべて可能
    { status: 'active', action: 'edit', expected: true },
    { status: 'active', action: 'delete', expected: true },
    { status: 'active', action: 'end', expected: true },
    { status: 'active', action: 'enter', expected: true },
    // expired：編集（有効期限を変えれば復活）・削除は可能、終了のみ不可
    { status: 'expired', action: 'edit', expected: true },
    { status: 'expired', action: 'delete', expected: true },
    { status: 'expired', action: 'end', expected: false },
    { status: 'expired', action: 'enter', expected: false },
    // ended：編集・削除は可能、終了のみ不可（すでに進行中の会議が無い）
    { status: 'ended', action: 'edit', expected: true },
    { status: 'ended', action: 'delete', expected: true },
    { status: 'ended', action: 'end', expected: false },
    { status: 'ended', action: 'enter', expected: false },
    // disabled（削除済み）：すべて不可
    { status: 'disabled', action: 'edit', expected: false },
    { status: 'disabled', action: 'delete', expected: false },
    { status: 'disabled', action: 'end', expected: false },
    { status: 'disabled', action: 'enter', expected: false },
  ]

  // 「入室する」の活性条件は後端 /join の受理条件と一致していなければならない
  // （expired→410 ROOM_EXPIRED、ended/disabled→410 ROOM_ENDED）。押せるのに必ず
  // 失敗する導線＝実質的な死ボタンなので、ここを回帰で固定する。
  it('enter is enabled only for active — mirrors /join acceptance', () => {
    const enterable = (['active', 'expired', 'ended', 'disabled'] as RoomState[]).filter((s) =>
      isRoomActionEnabled(s, 'enter'),
    )
    expect(enterable).toEqual(['active'])
  })

  it('every disabled enter combination explains why', () => {
    for (const status of ['expired', 'ended', 'disabled'] as RoomState[]) {
      expect(getRoomActionDisabledReason(status, 'enter')).toBeTruthy()
    }
    expect(getRoomActionDisabledReason('active', 'enter')).toBeNull()
  })

  it.each(MATRIX)('status=$status action=$action -> enabled=$expected', ({ status, action, expected }) => {
    expect(isRoomActionEnabled(status, action)).toBe(expected)
  })
})

describe('getRoomActionDisabledReason', () => {
  it('returns null for every enabled combination', () => {
    expect(getRoomActionDisabledReason('active', 'edit')).toBeNull()
    expect(getRoomActionDisabledReason('active', 'delete')).toBeNull()
    expect(getRoomActionDisabledReason('active', 'end')).toBeNull()
    expect(getRoomActionDisabledReason('expired', 'edit')).toBeNull()
    expect(getRoomActionDisabledReason('expired', 'delete')).toBeNull()
    expect(getRoomActionDisabledReason('ended', 'edit')).toBeNull()
    expect(getRoomActionDisabledReason('ended', 'delete')).toBeNull()
  })

  it('returns a non-empty explanation for every disabled combination (never a silent disable)', () => {
    const disabledCases: Array<[RoomState, RoomAction]> = [
      ['disabled', 'edit'],
      ['disabled', 'delete'],
      ['disabled', 'end'],
      ['expired', 'end'],
      ['ended', 'end'],
    ]
    for (const [status, action] of disabledCases) {
      const reason = getRoomActionDisabledReason(status, action)
      expect(typeof reason).toBe('string')
      expect((reason ?? '').length).toBeGreaterThan(0)
    }
  })
})

// ============ 編集フォーム diff 計算 ============
function makeBaseline(overrides: Partial<RoomEditBaseline> = {}): RoomEditBaseline {
  return {
    title: '朝会',
    maxParticipants: 10,
    expiresAtLocal: '2026-08-01T10:00',
    requireLogin: false,
    ...overrides,
  }
}

function makeForm(baseline: RoomEditBaseline, overrides: Partial<RoomEditFormValues> = {}): RoomEditFormValues {
  return {
    ...baseline,
    passwordMode: 'unchanged',
    newPassword: '',
    ...overrides,
  }
}

describe('computeRoomPatchDiff', () => {
  it('returns {} when nothing changed', () => {
    const baseline = makeBaseline()
    const diff = computeRoomPatchDiff(baseline, makeForm(baseline))
    expect(diff).toEqual({})
    expect(isEmptyPatch(diff)).toBe(true)
  })

  it('returns only the changed field for a single-field edit (title)', () => {
    const baseline = makeBaseline()
    const diff = computeRoomPatchDiff(baseline, makeForm(baseline, { title: '夕会' }))
    expect(diff).toEqual({ title: '夕会' })
  })

  it('returns only the changed field for a single-field edit (maxParticipants)', () => {
    const baseline = makeBaseline()
    const diff = computeRoomPatchDiff(baseline, makeForm(baseline, { maxParticipants: 20 }))
    expect(diff).toEqual({ maxParticipants: 20 })
  })

  it('returns only the changed field for a single-field edit (requireLogin)', () => {
    const baseline = makeBaseline()
    const diff = computeRoomPatchDiff(baseline, makeForm(baseline, { requireLogin: true }))
    expect(diff).toEqual({ requireLogin: true })
  })

  it('trims the title before comparing/sending, so incidental whitespace is not a false-positive change', () => {
    const baseline = makeBaseline({ title: '朝会' })
    const diff = computeRoomPatchDiff(baseline, makeForm(baseline, { title: '  朝会  ' }))
    expect(diff).toEqual({})
  })

  describe('password tri-state (unchanged / set / clear)', () => {
    it('unchanged -> {} (no password key at all)', () => {
      const baseline = makeBaseline()
      const diff = computeRoomPatchDiff(baseline, makeForm(baseline, { passwordMode: 'unchanged' }))
      expect(diff).toEqual({})
      expect('password' in diff).toBe(false)
    })

    it('set -> { password: "xxxxxx" }', () => {
      const baseline = makeBaseline()
      const diff = computeRoomPatchDiff(baseline, makeForm(baseline, { passwordMode: 'set', newPassword: 'xxxxxx' }))
      expect(diff).toEqual({ password: 'xxxxxx' })
    })

    it('clear -> { password: null }', () => {
      const baseline = makeBaseline()
      const diff = computeRoomPatchDiff(baseline, makeForm(baseline, { passwordMode: 'clear' }))
      expect(diff).toEqual({ password: null })
    })
  })

  describe('expiresAt', () => {
    it('detects a change and converts the new local value to ISO', () => {
      const baseline = makeBaseline({ expiresAtLocal: '2026-08-01T10:00' })
      const diff = computeRoomPatchDiff(baseline, makeForm(baseline, { expiresAtLocal: '2026-09-01T09:30' }))
      expect(diff).toEqual({ expiresAt: new Date('2026-09-01T09:30').toISOString() })
    })

    it('clearing it to empty produces { expiresAt: null }', () => {
      const baseline = makeBaseline({ expiresAtLocal: '2026-08-01T10:00' })
      const diff = computeRoomPatchDiff(baseline, makeForm(baseline, { expiresAtLocal: '' }))
      expect(diff).toEqual({ expiresAt: null })
    })

    it('leaves it out of the diff when both baseline and form have no expiry', () => {
      const baseline = makeBaseline({ expiresAtLocal: '' })
      const diff = computeRoomPatchDiff(baseline, makeForm(baseline, { expiresAtLocal: '' }))
      expect(diff).toEqual({})
    })
  })

  it('combines multiple simultaneously-changed fields in a single diff', () => {
    const baseline = makeBaseline()
    const diff = computeRoomPatchDiff(
      baseline,
      makeForm(baseline, { title: '夕会', requireLogin: true, passwordMode: 'set', newPassword: 'abcdef' }),
    )
    expect(diff).toEqual({ title: '夕会', requireLogin: true, password: 'abcdef' })
  })
})

describe('isEmptyPatch', () => {
  it('is true for {}', () => {
    expect(isEmptyPatch({})).toBe(true)
  })

  it('is false whenever at least one field is present (including password: null)', () => {
    expect(isEmptyPatch({ title: 'x' })).toBe(false)
    expect(isEmptyPatch({ password: null })).toBe(false)
  })
})

// ============ datetime-local <-> ISO 変換ヘルパー ============
describe('localDateTimeToIso / isoToLocalDateTime', () => {
  it('localDateTimeToIso: empty string -> null', () => {
    expect(localDateTimeToIso('')).toBeNull()
  })

  it('isoToLocalDateTime: null -> empty string', () => {
    expect(isoToLocalDateTime(null)).toBe('')
  })

  it('round-trips a local datetime string through ISO and back', () => {
    const local = '2026-08-01T10:30'
    const iso = localDateTimeToIso(local)
    expect(iso).toBe(new Date(local).toISOString())
    expect(isoToLocalDateTime(iso)).toBe(local)
  })
})

// ============ クライアント側事前検証（patchRoomSchema §5.1 と境界値を揃える） ============
describe('validateRoomEditForm', () => {
  const baseline = makeBaseline()

  it('a fully valid, unmodified form passes', () => {
    expect(validateRoomEditForm(makeForm(baseline))).toBeNull()
  })

  it('rejects an empty (or whitespace-only) title', () => {
    expect(validateRoomEditForm(makeForm(baseline, { title: '' }))).not.toBeNull()
    expect(validateRoomEditForm(makeForm(baseline, { title: '   ' }))).not.toBeNull()
  })

  describe(`maxParticipants boundary (${EDIT_MAX_PARTICIPANTS_MIN}-${EDIT_MAX_PARTICIPANTS_MAX})`, () => {
    it('rejects below the minimum', () => {
      expect(
        validateRoomEditForm(makeForm(baseline, { maxParticipants: EDIT_MAX_PARTICIPANTS_MIN - 1 })),
      ).not.toBeNull()
    })
    it('accepts the lower boundary', () => {
      expect(validateRoomEditForm(makeForm(baseline, { maxParticipants: EDIT_MAX_PARTICIPANTS_MIN }))).toBeNull()
    })
    it('accepts the upper boundary', () => {
      expect(validateRoomEditForm(makeForm(baseline, { maxParticipants: EDIT_MAX_PARTICIPANTS_MAX }))).toBeNull()
    })
    it('rejects above the maximum', () => {
      expect(
        validateRoomEditForm(makeForm(baseline, { maxParticipants: EDIT_MAX_PARTICIPANTS_MAX + 1 })),
      ).not.toBeNull()
    })
  })

  describe(`new password boundary (${EDIT_PASSWORD_MIN}-${EDIT_PASSWORD_MAX}), only enforced when passwordMode='set'`, () => {
    it('rejects a new password shorter than the minimum', () => {
      const form = makeForm(baseline, { passwordMode: 'set', newPassword: 'a'.repeat(EDIT_PASSWORD_MIN - 1) })
      expect(validateRoomEditForm(form)).not.toBeNull()
    })
    it('accepts a new password at the lower boundary', () => {
      const form = makeForm(baseline, { passwordMode: 'set', newPassword: 'a'.repeat(EDIT_PASSWORD_MIN) })
      expect(validateRoomEditForm(form)).toBeNull()
    })
    it('accepts a new password at the upper boundary', () => {
      const form = makeForm(baseline, { passwordMode: 'set', newPassword: 'a'.repeat(EDIT_PASSWORD_MAX) })
      expect(validateRoomEditForm(form)).toBeNull()
    })
    it('rejects a new password longer than the maximum', () => {
      const form = makeForm(baseline, { passwordMode: 'set', newPassword: 'a'.repeat(EDIT_PASSWORD_MAX + 1) })
      expect(validateRoomEditForm(form)).not.toBeNull()
    })
    it('is not enforced when passwordMode is "clear" (newPassword is irrelevant)', () => {
      const form = makeForm(baseline, { passwordMode: 'clear', newPassword: '' })
      expect(validateRoomEditForm(form)).toBeNull()
    })
    it('is not enforced when passwordMode is "unchanged" (newPassword is irrelevant)', () => {
      const form = makeForm(baseline, { passwordMode: 'unchanged', newPassword: 'x' })
      expect(validateRoomEditForm(form)).toBeNull()
    })
  })
})

// ============ WP-8：locale 引数（中日文手动切换）============
// 上のテスト群は既存どおり locale を省略して呼び、既定値 'ja' のままで通ることを
// そのまま確認する（後方互換：既存呼び出し元は無改动で動く）。ここでは追加された
// locale 引数自体が実際に効いていること・lib/ui-text.ts の辞書と一致することを見る。
describe('getRoomActionDisabledReason — locale', () => {
  it('defaults to ja when locale is omitted (backward compatible)', () => {
    expect(getRoomActionDisabledReason('disabled', 'edit')).toBe(uiText.ja.dashboard.editDisabledDeleted)
  })

  it('returns the ja dictionary text when locale="ja" is passed explicitly', () => {
    expect(getRoomActionDisabledReason('expired', 'enter', 'ja')).toBe(uiText.ja.dashboard.enterDisabledExpired)
  })

  it('returns the zh dictionary text when locale="zh" is passed', () => {
    expect(getRoomActionDisabledReason('expired', 'enter', 'zh')).toBe(uiText.zh.dashboard.enterDisabledExpired)
  })

  it('covers every disabled combination in zh too (mirrors the ja matrix test above)', () => {
    const disabledCases: Array<[RoomState, RoomAction]> = [
      ['disabled', 'edit'],
      ['disabled', 'delete'],
      ['disabled', 'end'],
      ['expired', 'end'],
      ['ended', 'end'],
      ['disabled', 'enter'],
      ['expired', 'enter'],
      ['ended', 'enter'],
    ]
    for (const [status, action] of disabledCases) {
      const reason = getRoomActionDisabledReason(status, action, 'zh')
      expect(typeof reason).toBe('string')
      expect((reason ?? '').length).toBeGreaterThan(0)
    }
  })
})

describe('validateRoomEditForm — locale', () => {
  const baseline = makeBaseline()

  it('defaults to ja when locale is omitted (backward compatible)', () => {
    const form = makeForm(baseline, { title: '' })
    expect(validateRoomEditForm(form)).toBe(uiText.ja.dashboard.validationTitleRequired)
  })

  it('returns the zh title-required message for an empty title', () => {
    const form = makeForm(baseline, { title: '   ' })
    expect(validateRoomEditForm(form, 'zh')).toBe(uiText.zh.dashboard.validationTitleRequired)
  })

  it('returns the zh maxParticipants-range message with {min}/{max} interpolated', () => {
    const form = makeForm(baseline, { maxParticipants: EDIT_MAX_PARTICIPANTS_MAX + 1 })
    const message = validateRoomEditForm(form, 'zh')
    expect(message).toContain(String(EDIT_MAX_PARTICIPANTS_MIN))
    expect(message).toContain(String(EDIT_MAX_PARTICIPANTS_MAX))
    expect(message).not.toContain('{min}')
    expect(message).not.toContain('{max}')
  })

  it('returns the zh password-range message with {min}/{max} interpolated', () => {
    const form = makeForm(baseline, { passwordMode: 'set', newPassword: 'a'.repeat(EDIT_PASSWORD_MAX + 1) })
    const message = validateRoomEditForm(form, 'zh')
    expect(message).toContain(String(EDIT_PASSWORD_MIN))
    expect(message).toContain(String(EDIT_PASSWORD_MAX))
  })

  it('a valid form still passes (returns null) regardless of locale', () => {
    expect(validateRoomEditForm(makeForm(baseline), 'zh')).toBeNull()
  })
})
