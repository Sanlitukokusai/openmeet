#!/usr/bin/env node
// 生成 LiveKit 入会测试 token（HS256 JWT，零依赖）。WP-0.5 跨境测试用。
// 用法：node scripts/lk-token.mjs [room] [identity] [ttl秒，默认 21600=6h]
// 密钥来源：环境变量或 .env.local 里的 LIVEKIT_API_KEY / LIVEKIT_API_SECRET
import { createHmac } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'

function loadEnvLocal() {
  const p = new URL('../.env.local', import.meta.url)
  if (!existsSync(p)) return
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
  }
}
loadEnvLocal()

const [room = 'wp05-test', identity = `tester_${Math.random().toString(36).slice(2, 8)}`, ttl = '21600'] = process.argv.slice(2)
const key = process.env.LIVEKIT_API_KEY
const secret = process.env.LIVEKIT_API_SECRET
if (!key || !secret) {
  console.error('缺 LIVEKIT_API_KEY / LIVEKIT_API_SECRET（填在 .env.local）')
  process.exit(1)
}

const b64u = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url')
const now = Math.floor(Date.now() / 1000)
const payload = {
  iss: key,
  sub: identity,
  name: identity,
  nbf: now - 10,
  exp: now + Number(ttl),
  video: { roomJoin: true, room, canPublish: true, canSubscribe: true, canPublishData: false },
}
const unsigned = `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u(payload)}`
const sig = createHmac('sha256', secret).update(unsigned).digest('base64url')
const token = `${unsigned}.${sig}`

console.log(token)
const url = process.env.NEXT_PUBLIC_LIVEKIT_URL
if (url) {
  console.error('\n浏览器一键测试（meet.livekit.io Custom 模式）：')
  console.error(`https://meet.livekit.io/custom?liveKitUrl=${encodeURIComponent(url)}&token=${encodeURIComponent(token)}`)
}
