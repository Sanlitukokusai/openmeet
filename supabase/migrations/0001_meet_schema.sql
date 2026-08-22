-- zoomVideo meet schema（规格书 §5.1 DDL + §5.2 RLS，幂等化，可重复执行）
-- 本项目使用独立的 `meet` schema，不占用 public（便于与其他应用共用同一个 Supabase 实例）。

create schema if not exists meet;

-- 会议室
create table if not exists meet.rooms (
  id                uuid primary key default gen_random_uuid(),
  owner_id          uuid not null references auth.users(id) on delete cascade,
  room_code         text not null unique,
  title             text not null default 'Meeting',
  password_hash     text,                        -- null = 无密码
  media_room_name   text not null unique,        -- 媒体服务器侧房间名
  media_provider    text not null default 'livekit'
                    check (media_provider in ('livekit','agora')),
  max_participants  smallint not null default 10
                    check (max_participants between 2 and 50),
  require_login     boolean not null default false,
  scheduled_at      timestamptz,
  expires_at        timestamptz,
  status            text not null default 'active'
                    check (status in ('active','ended','disabled')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_meet_rooms_owner on meet.rooms(owner_id);
create index if not exists idx_meet_rooms_code on meet.rooms(room_code);

-- 单次会议实例
create table if not exists meet.meetings (
  id          uuid primary key default gen_random_uuid(),
  room_id     uuid not null references meet.rooms(id) on delete cascade,
  started_at  timestamptz not null default now(),
  ended_at    timestamptz,
  peak_participants smallint not null default 0
);
create index if not exists idx_meet_meetings_room on meet.meetings(room_id);

-- 参与者（含匿名访客）
create table if not exists meet.participants (
  id            uuid primary key default gen_random_uuid(),
  meeting_id    uuid not null references meet.meetings(id) on delete cascade,
  user_id       uuid references auth.users(id) on delete set null,  -- 匿名为 null
  media_identity text not null,
  display_name  text not null,
  role          text not null default 'guest' check (role in ('host','guest')),
  joined_at     timestamptz not null default now(),
  left_at       timestamptz
);
create index if not exists idx_meet_participants_meeting on meet.participants(meeting_id);

-- 事件审计（含跨境质量数据，供 §9 验证）
create table if not exists meet.meeting_sessions (
  id              uuid primary key default gen_random_uuid(),
  participant_id  uuid not null references meet.participants(id) on delete cascade,
  event           text not null,   -- join|leave|reconnect|publish|error|quality
  detail          jsonb not null default '{}'::jsonb,
  at              timestamptz not null default now()
);
create index if not exists idx_meet_sessions_participant on meet.meeting_sessions(participant_id);

-- updated_at 触发器
create or replace function meet.touch_updated_at() returns trigger
language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;
drop trigger if exists trg_rooms_touch on meet.rooms;
create trigger trg_rooms_touch before update on meet.rooms
  for each row execute function meet.touch_updated_at();

-- RLS：纵深防御第二层（一切正常访问走服务端 service_role）
alter table meet.rooms             enable row level security;
alter table meet.meetings          enable row level security;
alter table meet.participants      enable row level security;
alter table meet.meeting_sessions  enable row level security;

drop policy if exists rooms_owner_all on meet.rooms;
create policy rooms_owner_all on meet.rooms
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

drop policy if exists meetings_owner on meet.meetings;
create policy meetings_owner on meet.meetings
  for all to authenticated
  using (exists (select 1 from meet.rooms r
                 where r.id = meetings.room_id and r.owner_id = auth.uid()))
  with check (exists (select 1 from meet.rooms r
                 where r.id = meetings.room_id and r.owner_id = auth.uid()));

drop policy if exists participants_owner_read on meet.participants;
create policy participants_owner_read on meet.participants
  for select to authenticated
  using (exists (
    select 1 from meet.meetings m
    join meet.rooms r on r.id = m.room_id
    where m.id = participants.meeting_id and r.owner_id = auth.uid()));

-- anon 角色：不建任何策略 = 默认全部拒绝；且本 schema 不授予 anon/authenticated 任何表权限，
-- 未加入 PostgREST Exposed schemas —— 三重兜底（§5.2）。
