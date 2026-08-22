// 房间密码哈希（規格書 §5.2 / §7.4：password_hash 绝不明文存储）。
// 仅服务端使用；不得被 tests/rooms/**（headless 测试）import——bcrypt 哈希是异步
// 副作用操作，边界值校验已经由 lib/server/rooms-logic.ts 的 zod schema 覆盖，
// 这里保持纯粹的「哈希/校验」职责，不参与单元测试矩阵。
import 'server-only'
import { hash, compare } from 'bcryptjs'

// 規格书 §7.4：bcrypt cost 10。
const BCRYPT_COST = 10

export async function hashRoomPassword(password: string): Promise<string> {
  return hash(password, BCRYPT_COST)
}

export async function verifyRoomPassword(password: string, passwordHash: string): Promise<boolean> {
  return compare(password, passwordHash)
}
