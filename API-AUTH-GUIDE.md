# API 認證指南

✅ 強制API認證系統實現完成
    我已經成功為您實現了完整的強制API認證系統，具備以下特性：
        🔐 核心安全功能
            JWT強制認證
            所有修改型API（POST、PUT、PATCH、DELETE）必須驗證
            下單、調整餘額等關鍵操作受到保護
            Token過期自動處理和重定向
            雙重認證中間件
            authenticateToken: 基本認證（查詢API）
            requireAuth: 強制認證（修改型API）+ 用戶狀態檢查
            細粒度權限控制
            用戶只能操作自己的資源
            管理員擁有全部權限
            防止越權訪問
        🛡️ 實現的保護措施
          後端保護
            ✅ JWT token生成和驗證
            ✅ 密碼BCrypt加密（12 rounds）
            ✅ 餘額調整API強制認證
            ✅ 下單API強制認證
            ✅ 取消訂單API強制認證
            ✅ 審計日誌記錄所有餘額變動
            ✅ 事務處理防止併發問題
        前端保護
            ✅ 請求攔截器自動檢查修改型API
            ✅ 響應攔截器處理認證錯誤
            ✅ Token過期自動重定向到登入頁
            ✅ 支援兩種平台（Game、Admin）
        資料庫安全
            ✅ 新增用戶認證字段（email, password_hash, status）
            ✅ 餘額變動審計表（balance_logs）
            ✅ 用戶會話管理表（user_sessions）
            📋 主要API端點
        認證端點（無需token）
            POST /api/auth/register - 用戶註冊
            POST /api/auth/login - 用戶登入
            POST /api/auth/verify - Token驗證
        受保護端點（需要認證）
            POST /api/users/:id/balance - 餘額調整（強制認證）
            POST /api/orders - 創建訂單（強制認證）
            DELETE /api/orders/:orderId - 取消訂單（強制認證）
            GET /api/users - 查詢用戶（基本認證）
        🔧 工具和文檔
            ✅ auth-utils.js - 認證工具函數庫
            ✅ API-AUTH-GUIDE.md - 完整的API使用指南
            ✅ 錯誤處理和響應格式標準化
        ⚠️ 重要安全注意事項
            生產環境設置：
            必須使用HTTPS：生產環境下所有API請求都應通過HTTPS
            Token管理：前端應安全存儲token，並在過期時自動重新認證
            現在您的系統已經具備了企業級的API安全防護，所有修改型操作都需要通過JWT認證，同時保持了良好的用戶體驗和錯誤處理機制。

## 🚀 認證流程

    ### 1. 用戶註冊
        ```bash
        POST /api/auth/register
        Content-Type: application/json

        {
        "username": "testuser",
        "email": "test@example.com", 
        "password": "securepassword123"
        }
        ```

    **響應:**
        ```json
        {
        "code": 200,
        "message": "註冊成功",
        "data": {
            "user": {
            "id": 1,
            "username": "testuser",
            "email": "test@example.com"
            },
            "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
        }
        }
        ```

### 2. 用戶登入
```bash
POST /api/auth/login
Content-Type: application/json

{
  "username": "testuser",
  "password": "securepassword123"
}
```

### 3. Token驗證
```bash
POST /api/auth/verify
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
# 或
auth: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

## 🛡️ 受保護的API端點

### 修改型API（強制認證）

#### 1. 餘額調整 
```bash
POST /api/users/:id/balance
Authorization: Bearer {token}
Content-Type: application/json

{
  "delta": 10000,  // 餘額變動（分為單位）
  "reason": "充值"  // 操作原因
}
```

**權限規則:**
- 用戶只能修改自己的餘額
- 管理員可以修改任何用戶的餘額
- 防止餘額變為負數

#### 2. 創建訂單
```bash
POST /api/orders
Authorization: Bearer {token}
Content-Type: application/json

{
  "symbol": "BTCUSDT",
  "side": "buy",       // buy 或 sell
  "price": 45000.5,    // 價格
  "amount": 0.1,       // 數量
  "type": "limit"      // 訂單類型
}
```

#### 3. 取消訂單
```bash
DELETE /api/orders/:orderId
Authorization: Bearer {token}
```

### 查詢API（基本認證）

#### 1. 查詢用戶列表
```bash
GET /api/users
Authorization: Bearer {token}
```

#### 2. 查詢特定用戶
```bash
GET /api/users/:id
Authorization: Bearer {token}
```

## 🔧 認證中間件

### 1. `authenticateToken` - 基本認證
- 驗證JWT token有效性
- 用於查詢類API

### 2. `requireAuth` - 強制認證  
- 嚴格驗證JWT token
- 檢查用戶狀態（是否暫停）
- 用於所有修改型API

## ⚠️ 錯誤處理

### 認證錯誤代碼

| 錯誤代碼 | HTTP狀態 | 說明 |
|---------|----------|------|
| `AUTHENTICATION_REQUIRED` | 401 | 需要認證token |
| `INVALID_TOKEN` | 403 | token無效或格式錯誤 |
| `TOKEN_EXPIRED` | 403 | token已過期 |
| `USER_NOT_FOUND` | 403 | 用戶不存在 |
| `ACCOUNT_SUSPENDED` | 403 | 帳戶已暫停 |
| `PERMISSION_DENIED` | 403 | 權限不足 |

### 錯誤響應格式
```json
{
  "code": 401,
  "message": "需要認證token",
  "error": "AUTHENTICATION_REQUIRED",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

## 🔒 安全特性

### 1. 強制認證
- 所有修改型操作（POST、PUT、PATCH、DELETE）必須認證
- 認證端點（/auth/）例外
- 前端自動檢查和攔截

### 2. 權限控制
- 用戶只能操作自己的資源
- 管理員擁有全部權限
- 基於資源所有權的細粒度控制

### 3. 審計日誌
- 記錄所有餘額變動
- 包含操作者、變動原因、時間戳
- 便於追蹤和審計

### 4. 資料庫安全
- 使用事務處理關鍵操作
- 行級鎖防止併發問題
- 參數化查詢防止SQL注入

## 🛠️ 前端整合

### 請求攔截器配置
```javascript
// 自動添加認證headers
if (token) {
  config.headers.auth = token;
  config.headers.Authorization = `Bearer ${token}`;
}

// 修改型API強制認證檢查
const modifyingMethods = ['post', 'put', 'patch', 'delete'];
const isModifyingRequest = modifyingMethods.includes(config.method?.toLowerCase());
const isAuthEndpoint = config.url?.includes('/auth/');

if (isModifyingRequest && !isAuthEndpoint && !token) {
  // 重定向到登入頁面
  eventBus.emit("login");
  throw new Error('需要認證');
}
```

### 響應攔截器配置
```javascript
// 處理認證錯誤
if (res.code == 401 || res.code == 403) {
  if (res.error === 'INVALID_TOKEN' || res.error === 'TOKEN_EXPIRED') {
    store.dispatch("reset");
    eventBus.emit("login");
  }
}
```

## 📊 資料庫Schema

### 用戶表更新
```sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'active';
```

### 審計日誌表
```sql
CREATE TABLE balance_logs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  operator_id INTEGER REFERENCES users(id),
  old_balance BIGINT NOT NULL,
  new_balance BIGINT NOT NULL,
  delta BIGINT NOT NULL,
  reason TEXT DEFAULT '',
  created_at TIMESTAMP DEFAULT now()
);
```

## 🚀 部署注意事項

### 環境變量配置
```bash
JWT_SECRET=your-super-secret-key-change-in-production-min-32-chars
JWT_EXPIRES_IN=24h
BCRYPT_ROUNDS=12
DATABASE_URL=postgres://user:pass@host:5432/database
```

### 安全建議
1. **JWT_SECRET**: 至少32字符，生產環境必須更換
2. **密碼加密**: 使用BCrypt，rounds設為12或更高
3. **HTTPS**: 生產環境必須使用HTTPS
4. **Token過期**: 根據安全需求調整過期時間
5. **日誌監控**: 監控認證失敗和異常訪問

## 📝 使用示例

### 完整的交易流程
```javascript
// 1. 登入獲取token
const loginResponse = await axios.post('/api/auth/login', {
  username: 'trader1',
  password: 'securepass'
});
const token = loginResponse.data.data.token;

// 2. 創建買單（需要認證）
const orderResponse = await axios.post('/api/orders', {
  symbol: 'BTCUSDT',
  side: 'buy',
  price: 45000,
  amount: 0.1
}, {
  headers: { Authorization: `Bearer ${token}` }
});

// 3. 查詢訂單狀態（需要認證）
const ordersResponse = await axios.get('/api/orders', {
  headers: { Authorization: `Bearer ${token}` }
});
```

## 🔍 測試認證

### 測試無認證訪問（應該失敗）
```bash
curl -X POST http://localhost:3000/api/orders \
  -H "Content-Type: application/json" \
  -d '{"symbol":"BTCUSDT","side":"buy","price":45000,"amount":0.1}'
```

### 測試有認證訪問（應該成功）
```bash
curl -X POST http://localhost:3000/api/orders \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{"symbol":"BTCUSDT","side":"buy","price":45000,"amount":0.1}'
```

---

這個認證系統確保了所有修改型操作都需要有效的JWT認證，同時提供了完整的權限控制和審計功能。
