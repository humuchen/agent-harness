-- 迁移: 初始化leads表
-- 版本: 001
-- 向上迁移

CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  channel TEXT NOT NULL,
  intent TEXT,
  project TEXT,
  city TEXT,
  grade TEXT,
  stage TEXT NOT NULL DEFAULT 'new',
  reached TEXT NOT NULL DEFAULT 'new',
  
  -- 联系信息
  phone TEXT,
  wechat TEXT,
  name TEXT,
  consent_at DATETIME,
  
  -- 预约信息
  clinic_id TEXT,
  clinic_name TEXT,
  booking_date TEXT,
  booking_time TEXT,
  appointment_id TEXT,
  
  -- CRM/HIS同步
  crm_sync_state TEXT DEFAULT 'disabled',
  crm_synced_at DATETIME,
  crm_id TEXT,
  his_sync_state TEXT DEFAULT 'disabled',
  his_synced_at DATETIME,
  his_id TEXT,
  
  -- 转人工
  handed_off BOOLEAN DEFAULT FALSE,
  handoff_reason TEXT,
  handoff_at DATETIME,
  consultant TEXT,
  
  -- 时间戳
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_leads_tenant ON leads(tenant_id);
CREATE INDEX IF NOT EXISTS idx_leads_stage ON leads(stage);
CREATE INDEX IF NOT EXISTS idx_leads_channel ON leads(channel);
CREATE INDEX IF NOT EXISTS idx_leads_created ON leads(created_at);
