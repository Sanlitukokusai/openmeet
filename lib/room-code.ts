import { customAlphabet } from 'nanoid'

// §7.4：去除 0O1lIi 等易混字符的字符集，长度 10。
const ROOM_CODE_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz'
export const ROOM_CODE_LENGTH = 10

export const generateRoomCode = customAlphabet(ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH)

// 展示分组：abfk92mptq → abfk-92mp-tq
export function formatRoomCode(code: string): string {
  return [code.slice(0, 4), code.slice(4, 8), code.slice(8)].filter(Boolean).join('-')
}

// 用户输入宽容化：大小写/连字符/空白全部归一，仅保留合法字符。
export function normalizeRoomCode(input: string): string {
  return input.toLowerCase().replace(/[^23456789abcdefghjkmnpqrstuvwxyz]/g, '')
}

export function isValidRoomCode(input: string): boolean {
  return normalizeRoomCode(input).length === ROOM_CODE_LENGTH
}
