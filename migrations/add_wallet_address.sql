-- ================================================
-- 🔐 Web3 錢包地址欄位遷移腳本
-- ================================================
-- 用途: 為 users 表添加 wallet_address 欄位，支持 Web3 登入
-- 版本: v1.0
-- 創建時間: 2025-10-04
-- ================================================

BEGIN;

-- 1️⃣ 添加 wallet_address 欄位
ALTER TABLE users 
ADD COLUMN IF NOT EXISTS wallet_address VARCHAR(42) UNIQUE;

-- 2️⃣ 創建索引以提高查詢效率
CREATE INDEX IF NOT EXISTS idx_users_wallet_address 
ON users(wallet_address);

-- 3️⃣ 添加欄位註釋
COMMENT ON COLUMN users.wallet_address IS 'Web3 錢包地址 (Ethereum 格式，以 0x 開頭)';

-- 4️⃣ 創建 deposit_wallets 表（充值錢包管理）
CREATE TABLE IF NOT EXISTS deposit_wallets (
  id SERIAL PRIMARY KEY,
  wallet_address VARCHAR(42) UNIQUE NOT NULL,
  wallet_name VARCHAR(100) NOT NULL,
  network VARCHAR(50) NOT NULL DEFAULT 'ETH',
  status VARCHAR(20) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

COMMENT ON TABLE deposit_wallets IS '系統充值錢包地址管理';
COMMENT ON COLUMN deposit_wallets.wallet_address IS '充值錢包地址';
COMMENT ON COLUMN deposit_wallets.wallet_name IS '錢包名稱/標籤';
COMMENT ON COLUMN deposit_wallets.network IS '區塊鏈網絡 (ETH/BSC/POLYGON 等)';

-- 5️⃣ 創建索引
CREATE INDEX IF NOT EXISTS idx_deposit_wallets_network 
ON deposit_wallets(network);

CREATE INDEX IF NOT EXISTS idx_deposit_wallets_status 
ON deposit_wallets(status);

-- 6️⃣ 創建 deposit_transactions 表（充值交易記錄）
CREATE TABLE IF NOT EXISTS deposit_transactions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  from_address VARCHAR(42) NOT NULL,
  to_address VARCHAR(42) NOT NULL,
  tx_hash VARCHAR(66) UNIQUE NOT NULL,
  amount BIGINT NOT NULL,
  network VARCHAR(50) NOT NULL DEFAULT 'ETH',
  status VARCHAR(20) DEFAULT 'pending',
  block_number BIGINT,
  confirmations INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  confirmed_at TIMESTAMP
);

COMMENT ON TABLE deposit_transactions IS '用戶充值交易記錄';
COMMENT ON COLUMN deposit_transactions.tx_hash IS '區塊鏈交易哈希';
COMMENT ON COLUMN deposit_transactions.amount IS '充值金額 (Wei 單位)';
COMMENT ON COLUMN deposit_transactions.confirmations IS '區塊確認數';

-- 7️⃣ 創建索引
CREATE INDEX IF NOT EXISTS idx_deposit_tx_user 
ON deposit_transactions(user_id);

CREATE INDEX IF NOT EXISTS idx_deposit_tx_hash 
ON deposit_transactions(tx_hash);

CREATE INDEX IF NOT EXISTS idx_deposit_tx_status 
ON deposit_transactions(status);

CREATE INDEX IF NOT EXISTS idx_deposit_tx_from 
ON deposit_transactions(from_address);

CREATE INDEX IF NOT EXISTS idx_deposit_tx_to 
ON deposit_transactions(to_address);

-- 8️⃣ 添加 trades 表的 symbol 欄位（如果不存在）
ALTER TABLE trades 
ADD COLUMN IF NOT EXISTS symbol VARCHAR(20) DEFAULT 'BTCUSDT';

CREATE INDEX IF NOT EXISTS idx_trades_symbol 
ON trades(symbol);

-- 9️⃣ 驗證遷移結果
DO $$
BEGIN
  -- 檢查 wallet_address 欄位
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'users' AND column_name = 'wallet_address'
  ) THEN
    RAISE NOTICE '✅ users.wallet_address 欄位創建成功';
  ELSE
    RAISE EXCEPTION '❌ users.wallet_address 欄位創建失敗';
  END IF;

  -- 檢查 deposit_wallets 表
  IF EXISTS (
    SELECT 1 FROM information_schema.tables 
    WHERE table_name = 'deposit_wallets'
  ) THEN
    RAISE NOTICE '✅ deposit_wallets 表創建成功';
  ELSE
    RAISE EXCEPTION '❌ deposit_wallets 表創建失敗';
  END IF;

  -- 檢查 deposit_transactions 表
  IF EXISTS (
    SELECT 1 FROM information_schema.tables 
    WHERE table_name = 'deposit_transactions'
  ) THEN
    RAISE NOTICE '✅ deposit_transactions 表創建成功';
  ELSE
    RAISE EXCEPTION '❌ deposit_transactions 表創建失敗';
  END IF;

  -- 檢查 trades.symbol 欄位
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'trades' AND column_name = 'symbol'
  ) THEN
    RAISE NOTICE '✅ trades.symbol 欄位創建成功';
  ELSE
    RAISE EXCEPTION '❌ trades.symbol 欄位創建失敗';
  END IF;
END $$;

COMMIT;

-- ================================================
-- 🎉 遷移完成！
-- ================================================
-- 執行結果:
-- ✅ users 表添加 wallet_address 欄位
-- ✅ 創建 deposit_wallets 表（充值錢包管理）
-- ✅ 創建 deposit_transactions 表（充值交易記錄）
-- ✅ trades 表添加 symbol 欄位
-- ✅ 創建所有必要的索引
-- ================================================

