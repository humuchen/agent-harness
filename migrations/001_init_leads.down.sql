-- 回滚: 初始化leads表
-- 版本: 001
-- 向下回滚

DROP INDEX IF EXISTS idx_leads_created;
DROP INDEX IF EXISTS idx_leads_channel;
DROP INDEX IF EXISTS idx_leads_stage;
DROP INDEX IF EXISTS idx_leads_tenant;
DROP TABLE IF EXISTS leads;
