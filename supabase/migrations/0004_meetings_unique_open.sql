-- 修复 WP-2 标记的并发竞态：同一房间同时只允许一个「未结束」的会议实例。
-- find-or-create 并发时靠此索引兜底（冲突方重查即可）。幂等。
create unique index if not exists idx_meet_meetings_one_open_per_room
  on meet.meetings(room_id) where ended_at is null;
