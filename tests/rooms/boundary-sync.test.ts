// 客户端镜像常量与服务端 zod schema 边界的一致性守卫。
//
// 背景：app/dashboard/room-actions.ts 有意「不」在运行时 import
// lib/server/rooms-logic.ts —— 后者顶部 import zod，会把整个 zod 拖进客户端
// bundle（§8.2 首屏预算）。代价是边界值成了两份手写常量，改一边忘另一边就会
// 出现「前端放行、后端 400」或「前端拦截、后端其实允许」的错配。
//
// 本测试在构建期把这份约定钉死：任一侧改动而另一侧未同步，测试立即失败。
// 测试文件运行在 node 环境，import 服务端模块是安全的（rooms-logic 不依赖
// lib/supabase.ts 的 server-only）。
import { describe, expect, it } from 'vitest'
import {
  EDIT_MAX_PARTICIPANTS_MAX,
  EDIT_MAX_PARTICIPANTS_MIN,
  EDIT_PASSWORD_MAX,
  EDIT_PASSWORD_MIN,
} from '@/app/dashboard/room-actions'
import {
  MAX_PARTICIPANTS_MAX,
  MAX_PARTICIPANTS_MIN,
  ROOM_PASSWORD_MAX,
  ROOM_PASSWORD_MIN,
  patchRoomSchema,
} from '@/lib/server/rooms-logic'

describe('客户端镜像常量 ↔ 服务端 schema 边界', () => {
  it('参加人数の下限・上限が一致する', () => {
    expect(EDIT_MAX_PARTICIPANTS_MIN).toBe(MAX_PARTICIPANTS_MIN)
    expect(EDIT_MAX_PARTICIPANTS_MAX).toBe(MAX_PARTICIPANTS_MAX)
  })

  it('パスワード桁数の下限・上限が一致する', () => {
    expect(EDIT_PASSWORD_MIN).toBe(ROOM_PASSWORD_MIN)
    expect(EDIT_PASSWORD_MAX).toBe(ROOM_PASSWORD_MAX)
  })

  // 常量相等还不够：真正要保证的是「前端放行的值，后端一定接受」。
  // 直接拿 patchRoomSchema 验证边界值，防止 schema 改用了别的常量却没人发现。
  it('前端の境界値がサーバー schema を実際に通過する', () => {
    for (const n of [EDIT_MAX_PARTICIPANTS_MIN, EDIT_MAX_PARTICIPANTS_MAX]) {
      expect(patchRoomSchema.safeParse({ maxParticipants: n }).success).toBe(true)
    }
    for (const len of [EDIT_PASSWORD_MIN, EDIT_PASSWORD_MAX]) {
      expect(patchRoomSchema.safeParse({ password: 'a'.repeat(len) }).success).toBe(true)
    }
  })

  it('前端が弾く値はサーバーも弾く（越境防止）', () => {
    expect(patchRoomSchema.safeParse({ maxParticipants: EDIT_MAX_PARTICIPANTS_MIN - 1 }).success).toBe(false)
    expect(patchRoomSchema.safeParse({ maxParticipants: EDIT_MAX_PARTICIPANTS_MAX + 1 }).success).toBe(false)
    expect(patchRoomSchema.safeParse({ password: 'a'.repeat(EDIT_PASSWORD_MIN - 1) }).success).toBe(false)
    expect(patchRoomSchema.safeParse({ password: 'a'.repeat(EDIT_PASSWORD_MAX + 1) }).success).toBe(false)
  })
})
