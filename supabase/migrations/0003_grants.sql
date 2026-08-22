-- meet schema 权限定案（幂等）。
-- 设计（§5.2 + §8.3 强化）：一切数据访问走服务端 service_role；
-- anon / authenticated 不给任何 grant（即使全局默认授权带入也显式收回）。
-- RLS 策略保留在表上作为文档化的第二层（若未来恢复 authenticated 授权即刻生效）。

-- service_role：全权
grant usage on schema meet to service_role;
grant all on all tables in schema meet to service_role;
grant usage, select on all sequences in schema meet to service_role;
grant execute on all functions in schema meet to service_role;
alter default privileges in schema meet grant all on tables to service_role;
alter default privileges in schema meet grant usage, select on sequences to service_role;
alter default privileges in schema meet grant execute on functions to service_role;

-- anon / authenticated：显式收权（防全局默认授权渗入）
revoke all on all tables in schema meet from anon, authenticated;
revoke execute on all functions in schema meet from anon, authenticated;
revoke usage on schema meet from anon, authenticated;
alter default privileges in schema meet revoke all on tables from anon, authenticated;
alter default privileges in schema meet revoke execute on functions from anon, authenticated;
