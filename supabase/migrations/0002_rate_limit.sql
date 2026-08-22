-- 密码爆破限流（规格书 §12.3）：同一 IP × 同一 room_code 每 10 分钟最多 10 次尝试。
-- 实现选型：Supabase 表 + RPC（WorkDev 无 Upstash，避免新增外部依赖）。
-- 仅 service_role 调用（RLS 开启且无策略 = anon/authenticated 全拒）。幂等，可重复执行。

create table if not exists meet.join_attempts (
  room_code     text not null,
  ip            text not null,
  window_start  timestamptz not null default now(),
  attempts      int not null default 1,
  primary key (room_code, ip)
);
create index if not exists idx_meet_join_attempts_window on meet.join_attempts(window_start);

alter table meet.join_attempts enable row level security;

-- 原子计数：窗口过期则重置，返回「本次是否仍允许尝试」（attempts<=max）。
create or replace function meet.register_join_attempt(
  p_room_code text,
  p_ip        text,
  p_max       int default 10,
  p_window    interval default '10 minutes'
) returns boolean
language plpgsql
security definer
set search_path = meet
as $$
declare
  v_allowed boolean;
begin
  insert into meet.join_attempts as ja (room_code, ip)
  values (p_room_code, p_ip)
  on conflict (room_code, ip) do update set
    attempts     = case when now() - ja.window_start > p_window then 1 else ja.attempts + 1 end,
    window_start = case when now() - ja.window_start > p_window then now() else ja.window_start end
  returning attempts <= p_max into v_allowed;
  return v_allowed;
end
$$;

-- 密码校验成功后可重置该 IP 的计数（是否调用由 join 逻辑决定）。
create or replace function meet.reset_join_attempts(p_room_code text, p_ip text)
returns void
language sql
security definer
set search_path = meet
as $$
  delete from meet.join_attempts where room_code = p_room_code and ip = p_ip;
$$;

-- 陈旧行清理（供后续 cron / WP-5 使用）：
create or replace function meet.prune_join_attempts()
returns void
language sql
security definer
set search_path = meet
as $$
  delete from meet.join_attempts where window_start < now() - interval '1 hour';
$$;
