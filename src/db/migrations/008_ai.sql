-- AI Usage Tracking
CREATE TABLE IF NOT EXISTS ai_usage (
  id         SERIAL PRIMARY KEY,
  company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  feature    VARCHAR(50) NOT NULL,  -- 'extract' | 'analyze' | 'assistant'
  tokens_in  INT DEFAULT 0,
  tokens_out INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_company  ON ai_usage(company_id);
CREATE INDEX IF NOT EXISTS idx_ai_usage_month    ON ai_usage(company_id, feature, created_at);
