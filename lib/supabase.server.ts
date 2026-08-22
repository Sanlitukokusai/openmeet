// 服务端专用 Supabase 客户端。
// 本项目【浏览器不直连 Supabase】（docs/DESIGN-v2.md §8.3）：一切数据访问经
// Next.js Route Handler 中转，禁止在任何客户端组件 import 本文件。
import 'server-only'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/database.types'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!

// Database 型は lib/database.types.ts（DDL に基づく手書き）。整库 generate ではなく
// 手書きなのは、共享库が他プロジェクトの schema まで巻き込むため（同ファイル冒頭参照）。
// この型を渡すことで .from('rooms') / .rpc('register_join_attempt') が完全に型付けされ、
// WP-1 期の lib/server/db.ts（`as any` 垫片）は不要になった（WP-2 で削除済み）。
export type ServiceClient = SupabaseClient<Database, 'meet'>

// service_role + meet schema 单例。
// 前置：PostgREST の Exposed schemas に `meet` が含まれていること
//（本共有库では authenticator ロールの pgrst.db_schemas が事実源——CLAUDE.md 技術注記）。
// 若改用直连 Postgres（pg/drizzle），必须走 Supavisor transaction 池（§12.5）。
let _service: ServiceClient | null = null
export function getServiceClient(): ServiceClient {
  if (!_service) {
    _service = createClient<Database, 'meet'>(supabaseUrl, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
      db: { schema: 'meet' },
      auth: { persistSession: false },
    })
  }
  return _service
}

// 登录/注册用的 @supabase/ssr 服务端客户端（cookie session）在 WP-1 实装，
// 同样只存在于服务端；anon key 见 SUPABASE_ANON_KEY（无 NEXT_PUBLIC_ 前缀，故意）。
