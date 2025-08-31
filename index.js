require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const bodyParser = require('body-parser');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*'},
  path: '/socket.io'
});

app.use(cors());
app.use(bodyParser.json());

// JWT 密鑰配置
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-key-change-in-production';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '24h';

// 判斷是否有資料庫，若無則一律使用記憶體模式（本機開發免 DB）
const hasDatabase = process.env.DATABASE_URL;
// 僅以是否提供 DATABASE_URL 決定是否走記憶體模式；不再受其他變數影響
const useMemoryStore = !hasDatabase;

// 只在有數據庫時初始化連接池
let pool = null;
if (hasDatabase) {
  const conn = process.env.DATABASE_URL || 'postgres://postgres:postgres@postgres:5432/exchange';
  const needSsl = /neon\.tech|sslmode=require/i.test(conn);
  pool = new Pool({
    connectionString: conn,
    ssl: needSsl ? { rejectUnauthorized: false } : undefined,
  });
}

console.log('🔧 Configuration:');
console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
console.log(`   Render: ${process.env.RENDER ? 'true' : 'false'}`);
console.log(`   Database URL: ${hasDatabase ? 'configured' : 'not configured'}`);
console.log(`   Memory Store: ${useMemoryStore ? 'enabled' : 'disabled'}`);

// 健康檢查端點
app.get('/health', async (req, res) => {
  try {
    if (useMemoryStore) {
      // 記憶體模式 - 不需要數據庫檢查
      res.status(200).json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        service: 'exchange-backend',
        database: 'memory-store',
        mode: 'memory'
      });
    } else {
      // 數據庫模式 - 檢查數據庫連接
      await pool.query('SELECT 1');
      res.status(200).json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        service: 'exchange-backend',
        database: 'connected',
        mode: 'database'
      });
    }
  } catch (error) {
    res.status(503).json({
      status: 'error',
      timestamp: new Date().toISOString(),
      service: 'exchange-backend',
      database: 'disconnected',
      error: error.message
    });
  }
});

// 記憶體存儲（當沒有數據庫時使用）
let memoryStore = {
  users: [], // 前台一般用戶
  adminUsers: [], // 後台管理用戶
  orders: [],
  nextUserId: 1,
  nextAdminUserId: 1,
  nextOrderId: 1,
  captchas: {},
  emailCodes: {},
  google: {}, // userId -> { secret, bound, created_at }
  // 客服中心（僅記憶體模式使用）
  supportUsers: [], // { id, uid, username, email, created_at }
  supportMessages: [], // { id, uid, from, to, content, created_at, read }
  supportBlacklist: [] // [uid]
};

const CAPTCHA_EXPIRY_MS = 5 * 60 * 1000;

// JWT 認證中間件
const authenticateToken = (req, res, next) => {
  const token = req.headers.auth || req.headers.authorization?.replace('Bearer ', '');
  
  if (!token) {
    return res.status(401).json({ 
      code: 401, 
      message: '需要認證token', 
      error: 'AUTHENTICATION_REQUIRED' 
    });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(403).json({ 
      code: 403, 
      message: 'token無效或已過期', 
      error: 'INVALID_TOKEN' 
    });
  }
};

// 強制認證中間件 - 用於修改型API
const requireAuth = (req, res, next) => {
  const token = req.headers.auth || req.headers.authorization?.replace('Bearer ', '');
  
  if (!token) {
    return res.status(401).json({ 
      code: 401, 
      message: '此操作需要認證', 
      error: 'AUTHENTICATION_REQUIRED' 
    });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    
    if (useMemoryStore) {
      // 記憶體模式：略過資料庫查詢，直接放行
      return next();
    }
    
    // 有資料庫時，驗證用戶是否存在且狀態正常
    pool.query('SELECT id, username, status FROM users WHERE id = $1', [decoded.userId])
    .then(result => {
      if (!result.rows.length) {
        return res.status(403).json({ 
          code: 403, 
          message: '用戶不存在', 
          error: 'USER_NOT_FOUND' 
        });
      }
      
      const user = result.rows[0];
      if (user.status === 'suspended') {
        return res.status(403).json({ 
          code: 403, 
          message: '帳戶已暫停', 
          error: 'ACCOUNT_SUSPENDED' 
        });
      }
      
      req.user.userInfo = user;
      next();
    })
    .catch(err => {
      return res.status(500).json({ 
        code: 500, 
        message: '認證驗證失敗', 
        error: 'AUTH_VERIFICATION_FAILED' 
      });
    });
  } catch (error) {
    return res.status(403).json({ 
      code: 403, 
      message: 'token無效或已過期', 
      error: 'INVALID_TOKEN' 
    });
  }
};

// Wait for DB to be ready with retries
async function waitForDb(retries = 30, delayMs = 2000) {
  for (let i = 0; i < retries; i++) {
    try {
      console.log(`Checking DB connection attempt ${i + 1}/${retries}...`);
      await pool.query('SELECT 1');
      console.log('Database connection successful!');
      return;
    } catch (err) {
      if (i === retries - 1) {
        console.error('Failed to connect to database after all retries:', err.message);
        throw err;
      }
      console.log(`DB not ready, retrying in ${delayMs}ms... (${i + 1}/${retries}) - Error: ${err.message}`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

// Simple DB init (users + orders + trades)
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE,
      email TEXT UNIQUE,
      password_hash TEXT,
      balance BIGINT DEFAULT 0,
      status VARCHAR(20) DEFAULT 'active',
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMP DEFAULT now(),
      updated_at TIMESTAMP DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      side VARCHAR(4) NOT NULL, -- 'buy' or 'sell'
      price BIGINT NOT NULL,
      amount BIGINT NOT NULL,
      remaining BIGINT NOT NULL,
      status VARCHAR(16) DEFAULT 'open',
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMP DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS trades (
      id SERIAL PRIMARY KEY,
      buy_order_id INTEGER REFERENCES orders(id),
      sell_order_id INTEGER REFERENCES orders(id),
      price BIGINT NOT NULL,
      amount BIGINT NOT NULL,
      created_at TIMESTAMP DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS user_sessions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      token_hash TEXT NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS balance_logs (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      operator_id INTEGER REFERENCES users(id),
      old_balance BIGINT NOT NULL,
      new_balance BIGINT NOT NULL,
      delta BIGINT NOT NULL,
      reason TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT now()
    );

    -- 為orders表新增必要欄位
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS symbol VARCHAR(20) DEFAULT 'BTCUSDT';
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS type VARCHAR(10) DEFAULT 'limit';
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT now();
  `);
}

// initialize with DB readiness retry
// initialize with DB readiness retry and initDb retry
async function ensureDbInit(retries = 5, delayMs = 2000) {
  try {
    console.log('Starting database initialization...');
    await waitForDb(30, 3000);
  } catch (err) {
    console.error('waitForDb failed', err);
    throw err;
  }

  for (let i = 0; i < retries; i++) {
    try {
      console.log(`initDb attempt ${i + 1}/${retries}`);
      await initDb();
      console.log('Database tables initialized successfully!');
      return;
    } catch (err) {
      console.error(`initDb failed on attempt ${i + 1}:`, err.message);
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

// 啟動應用
async function startApplication() {
  try {
    console.log('Starting application...');
    
    // 只在有數據庫時初始化數據庫
    if (!useMemoryStore) {
      console.log('🗄️ Initializing database...');
      await ensureDbInit();
      console.log('📊 Database initialized and ready');
    } else {
      console.log('💾 Using memory store (no database required)');
      // 記憶體模式：建立預設管理員帳號，便於本機測試登入
      try {
        const exists = memoryStore.adminUsers.find(u => u.username === 'admin' || u.email === 'admin@example.com');
        if (!exists) {
          const hashedPassword = await bcrypt.hash('admin123', 12);
          const user = {
            id: memoryStore.nextAdminUserId++,
            username: 'admin',
            email: 'admin@example.com',
            password_hash: hashedPassword,
            status: 'active',
            balance: 0,
            created_at: new Date()
          };
          memoryStore.adminUsers.push(user);
          console.log('👤 Seeded default admin user: admin / admin123');
        }
      } catch (e) {
        console.warn('Failed to seed default admin user:', e?.message || e);
      }
    }
    
    // 啟動HTTP服務器
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
      console.log(`🚀 Backend server listening on port ${PORT}`);
      console.log(`🔐 JWT authentication enabled`);
      if (useMemoryStore) {
        console.log('⚠️  Memory store mode - data will not persist between restarts');
      }
    });
    
  } catch (err) {
    console.error('❌ Failed to start application:', err);
    process.exit(1);
  }
}

// 啟動應用
startApplication();

// 工具函數
const generateToken = (userId, username) => {
  return jwt.sign(
    { userId, username },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
};

// 認證相關API (無需token)
app.post('/api/auth/register', async (req, res) => {
  const { username, email, password } = req.body;
  
  if (!username || !email || !password) {
    return res.status(400).json({ 
      code: 400, 
      message: '用戶名、信箱和密碼為必填項目' 
    });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 12);
    
    if (useMemoryStore) {
      // 記憶體存儲模式
      const existingUser = memoryStore.users.find(u => 
        u.username === username || u.email === email
      );
      
      if (existingUser) {
        return res.status(409).json({ 
          code: 409, 
          message: '用戶名或信箱已存在' 
        });
      }
      
      const user = {
        id: memoryStore.nextUserId++,
        username,
        email,
        password_hash: hashedPassword,
        status: 'active',
        balance: 0,
        created_at: new Date()
      };
      
      memoryStore.users.push(user);
      const token = generateToken(user.id, user.username);
      
      res.json({
        code: 200,
        message: '註冊成功',
        data: {
          user: { id: user.id, username: user.username, email: user.email },
          token
        }
      });
    } else {
      // 數據庫模式
      const r = await pool.query(
        "INSERT INTO users(username, email, password_hash, metadata) VALUES($1, $2, $3, jsonb_build_object('kyc_status','none','google_bound', false)) RETURNING id, username, email",
        [username, email, hashedPassword]
      );
      
      const user = r.rows[0];
      const token = generateToken(user.id, user.username);
      
      res.json({
        code: 200,
        message: '註冊成功',
        data: {
          user: { id: user.id, username: user.username, email: user.email },
          token
        }
      });
    }
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ 
        code: 409, 
        message: '用戶名或信箱已存在' 
      });
    }
    res.status(500).json({ 
      code: 500, 
      message: '註冊失敗',
      error: err.message 
    });
  }
});

// 與前端對齊：匿名註冊（需要圖形驗證碼）
app.post('/api/anon/v1/user/register', async (req, res) => {
  const { username, email, password, verifcode } = req.body || {};

  // 驗證圖形驗證碼（以 IP 作為簡易關聯）
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const rec = memoryStore.captchas[ip];
  if (!verifcode || !rec || Date.now() > rec.expires || String(verifcode).toUpperCase() !== rec.code) {
    return res.status(200).json({ code: 1001, message: '請輸入驗證碼' });
  }

  if (!username || !email || !password) {
    return res.status(200).json({ code: 400, message: '用戶名、信箱和密碼為必填項目' });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 12);

    if (useMemoryStore) {
      const existingUser = memoryStore.users.find(u => u.username === username || u.email === email);
      if (existingUser) {
        return res.status(200).json({ code: 1101, message: '用戶名或信箱已存在' });
      }
      const user = {
        id: memoryStore.nextUserId++,
        username,
        email,
        password_hash: hashedPassword,
        status: 'active',
        balance: 0,
        created_at: new Date()
      };
      memoryStore.users.push(user);
      const token = generateToken(user.id, user.username);
      return res.json({
        code: 200,
        message: '註冊成功',
        data: {
          user: { id: user.id, username: user.username, email: user.email },
          token,
          auth: token
        }
      });
    } else {
      const r = await pool.query(
        "INSERT INTO users(username, email, password_hash, metadata) VALUES($1, $2, $3, jsonb_build_object('kyc_status','none','google_bound', false)) RETURNING id, username, email",
        [username, email, hashedPassword]
      );
      const user = r.rows[0];
      const token = generateToken(user.id, user.username);
      return res.json({
        code: 200,
        message: '註冊成功',
        data: {
          user: { id: user.id, username: user.username, email: user.email },
          token,
          auth: token
        }
      });
    }
  } catch (err) {
    return res.status(200).json({ code: 500, message: '註冊失敗', error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ 
      code: 400, 
      message: '用戶名和密碼為必填項目' 
    });
  }

  try {
    let user;
    
    if (useMemoryStore) {
      // 記憶體存儲模式
      user = memoryStore.users.find(u => 
        u.username === username || u.email === username
      );
      
      if (!user) {
        return res.status(401).json({ 
          code: 401, 
          message: '用戶名或密碼錯誤' 
        });
      }
    } else {
      // 數據庫模式
      const r = await pool.query(
        'SELECT id, username, email, password_hash, status FROM users WHERE username = $1 OR email = $1',
        [username]
      );
      
      if (!r.rows.length) {
        return res.status(401).json({ 
          code: 401, 
          message: '用戶名或密碼錯誤' 
        });
      }
      
      user = r.rows[0];
    }
    
    if (user.status !== 'active') {
      return res.status(403).json({ 
        code: 403, 
        message: '帳戶已被暫停' 
      });
    }

    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    
    if (!isValidPassword) {
      return res.status(401).json({ 
        code: 401, 
        message: '用戶名或密碼錯誤' 
      });
    }

    const token = generateToken(user.id, user.username);
    
    res.json({
      code: 200,
      message: '登入成功',
      data: {
        user: { id: user.id, username: user.username, email: user.email },
        token,
        auth: token,
        googlebind: false,
        expired: false
      }
    });
  } catch (err) {
    res.status(500).json({ 
      code: 500, 
      message: '登入失敗',
      error: err.message 
    });
  }
});

// Admin 權限匹配（簡化回傳，避免登入後卡住）
app.post('/api/authc/v1/security/matcher', authenticateToken, (req, res) => {
  res.json({
    code: 200,
    data: { roles: ['admin'], perms: ['*'] }
  });
});

// 與前端對齊：匿名登入（需要圖形驗證碼）
app.post('/api/anon/v1/user/login', async (req, res) => {
  const { username, password, verifcode } = req.body || {};

  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const rec = memoryStore.captchas[ip];
  if (!verifcode || !rec || Date.now() > rec.expires || String(verifcode).toUpperCase() !== rec.code) {
    return res.status(200).json({ code: 1001, message: '請輸入驗證碼' });
  }

  if (!username || !password) {
    return res.status(200).json({ code: 400, message: '用戶名和密碼為必填項目' });
  }

  try {
    let user;
    if (useMemoryStore) {
      user = memoryStore.users.find(u => u.username === username || u.email === username);
      if (!user) {
        return res.status(200).json({ code: 401, message: '用戶名或密碼錯誤' });
      }
    } else {
      const r = await pool.query(
        'SELECT id, username, email, password_hash, status FROM users WHERE username = $1 OR email = $1',
        [username]
      );
      if (!r.rows.length) {
        return res.status(200).json({ code: 401, message: '用戶名或密碼錯誤' });
      }
      user = r.rows[0];
    }

    if (user.status !== 'active') {
      return res.status(200).json({ code: 403, message: '帳戶已被暫停' });
    }

    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    if (!isValidPassword) {
      return res.status(200).json({ code: 401, message: '用戶名或密碼錯誤' });
    }

    const token = generateToken(user.id, user.username);
    return res.json({
      code: 200,
      message: '登入成功',
      data: {
        user: { id: user.id, username: user.username, email: user.email },
        token,
        auth: token
      }
    });
  } catch (err) {
    return res.status(200).json({ code: 500, message: '登入失敗', error: err.message });
  }
});

// Token 驗證 API
app.post('/api/auth/verify', authenticateToken, async (req, res) => {
  try {
    const user = await pool.query(
      'SELECT id, username, email, status FROM users WHERE id = $1',
      [req.user.userId]
    );
    
    if (!user.rows.length) {
      return res.status(404).json({ 
        code: 404, 
        message: '用戶不存在' 
      });
    }

    res.json({
      code: 200,
      message: 'Token有效',
      data: { user: user.rows[0] }
    });
  } catch (err) {
    res.status(500).json({ 
      code: 500, 
      message: 'Token驗證失敗' 
    });
  }
});

// 查詢API (需要基本認證)
app.get('/api/users', authenticateToken, async (req, res) => {
  try {
    const r = await pool.query('SELECT id, username, email, balance, status, created_at FROM users ORDER BY id DESC');
    res.json({
      code: 200,
      data: r.rows
    });
  } catch (err) {
    res.status(500).json({ 
      code: 500, 
      message: '查詢失敗',
      error: err.message 
    });
  }
});

app.get('/api/users/:id', authenticateToken, async (req, res) => {
  try {
    const r = await pool.query('SELECT id, username, email, balance, status, created_at FROM users WHERE id = $1', [req.params.id]);
    if (!r.rows.length) {
      return res.status(404).json({ 
        code: 404, 
        message: '用戶不存在' 
      });
    }
    res.json({
      code: 200,
      data: r.rows[0]
    });
  } catch (err) {
    res.status(500).json({ 
      code: 500, 
      message: '查詢失敗',
      error: err.message 
    });
  }
});

// 修改型API (強制認證)
app.post('/api/users/:id/balance', requireAuth, async (req, res) => {
  const id = req.params.id;
  const { delta, reason } = req.body; // delta in cents, reason for audit
  
  // 驗證權限：只能修改自己的餘額或管理員權限
  if (req.user.userId != id && req.user.role !== 'admin') {
    return res.status(403).json({ 
      code: 403, 
      message: '無權限修改此用戶餘額' 
    });
  }
  
  if (!delta || typeof delta !== 'number') {
    return res.status(400).json({ 
      code: 400, 
      message: '餘額變動值為必填且必須為數字' 
    });
  }

  try {
    await pool.query('BEGIN');
    
    const cur = await pool.query('SELECT balance FROM users WHERE id=$1 FOR UPDATE', [id]);
    if (!cur.rows.length) {
      await pool.query('ROLLBACK');
      return res.status(404).json({ 
        code: 404, 
        message: '用戶不存在' 
      });
    }
    
    const currentBalance = BigInt(cur.rows[0].balance || 0);
    const deltaAmount = BigInt(delta);
    const newBalance = currentBalance + deltaAmount;
    
    // 防止餘額為負數
    if (newBalance < 0) {
      await pool.query('ROLLBACK');
      return res.status(400).json({ 
        code: 400, 
        message: '餘額不足，無法執行此操作' 
      });
    }
    
    await pool.query('UPDATE users SET balance=$1, updated_at=now() WHERE id=$2', [newBalance.toString(), id]);
    
    // 記錄操作日誌 (audit log)
    await pool.query(
      'INSERT INTO balance_logs (user_id, operator_id, old_balance, new_balance, delta, reason, created_at) VALUES ($1, $2, $3, $4, $5, $6, now())',
      [id, req.user.userId, currentBalance.toString(), newBalance.toString(), deltaAmount.toString(), reason || '餘額調整']
    );
    
    await pool.query('COMMIT');
    
    const r2 = await pool.query('SELECT id, username, balance FROM users WHERE id=$1', [id]);
    const user = r2.rows[0];
    
    io.emit('user:balance:updated', { 
      userId: user.id, 
      username: user.username, 
      balance: user.balance,
      operator: req.user.username 
    });
    
    res.json({
      code: 200,
      message: '餘額更新成功',
      data: user
    });
  } catch (err) {
    await pool.query('ROLLBACK');
    res.status(500).json({ 
      code: 500, 
      message: '餘額更新失敗',
      error: err.message 
    });
  }
});

// 下單API (強制認證)
app.post('/api/orders', requireAuth, async (req, res) => {
  const { symbol, side, price, amount, type = 'limit' } = req.body;
  
  if (!symbol || !side || !price || !amount) {
    return res.status(400).json({ 
      code: 400, 
      message: '訂單參數不完整' 
    });
  }
  
  if (!['buy', 'sell'].includes(side)) {
    return res.status(400).json({ 
      code: 400, 
      message: '訂單方向必須為buy或sell' 
    });
  }

  try {
    await pool.query('BEGIN');
    
    // 檢查用戶餘額
    const userResult = await pool.query('SELECT balance FROM users WHERE id = $1 FOR UPDATE', [req.user.userId]);
    if (!userResult.rows.length) {
      await pool.query('ROLLBACK');
      return res.status(404).json({ 
        code: 404, 
        message: '用戶不存在' 
      });
    }
    
    const userBalance = BigInt(userResult.rows[0].balance);
    const orderValue = BigInt(Math.floor(price * amount * 100)); // convert to cents
    
    if (side === 'buy' && userBalance < orderValue) {
      await pool.query('ROLLBACK');
      return res.status(400).json({ 
        code: 400, 
        message: '餘額不足' 
      });
    }
    
    // 創建訂單
    const orderResult = await pool.query(
      'INSERT INTO orders (user_id, symbol, side, price, amount, remaining, type, status, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now()) RETURNING *',
      [req.user.userId, symbol, side, BigInt(Math.floor(price * 100)), BigInt(Math.floor(amount * 100)), BigInt(Math.floor(amount * 100)), type, 'open']
    );
    
    const order = orderResult.rows[0];
    
    // 如果是買單，扣除餘額
    if (side === 'buy') {
      await pool.query('UPDATE users SET balance = balance - $1 WHERE id = $2', [orderValue.toString(), req.user.userId]);
    }
    
    await pool.query('COMMIT');
    
    io.emit('order:created', {
      ...order,
      username: req.user.username
    });
    
    res.json({
      code: 200,
      message: '訂單創建成功',
      data: order
    });
  } catch (err) {
    await pool.query('ROLLBACK');
    res.status(500).json({ 
      code: 500, 
      message: '訂單創建失敗',
      error: err.message 
    });
  }
});

// 取消訂單API (強制認證)
app.delete('/api/orders/:orderId', requireAuth, async (req, res) => {
  const orderId = req.params.orderId;
  
  try {
    await pool.query('BEGIN');
    
    const orderResult = await pool.query(
      'SELECT * FROM orders WHERE id = $1 AND user_id = $2 FOR UPDATE',
      [orderId, req.user.userId]
    );
    
    if (!orderResult.rows.length) {
      await pool.query('ROLLBACK');
      return res.status(404).json({ 
        code: 404, 
        message: '訂單不存在或無權限取消' 
      });
    }
    
    const order = orderResult.rows[0];
    
    if (order.status !== 'open') {
      await pool.query('ROLLBACK');
      return res.status(400).json({ 
        code: 400, 
        message: '只能取消未成交的訂單' 
      });
    }
    
    // 更新訂單狀態
    await pool.query('UPDATE orders SET status = $1, updated_at = now() WHERE id = $2', ['cancelled', orderId]);
    
    // 如果是買單，退還餘額
    if (order.side === 'buy') {
      const refundAmount = BigInt(order.remaining) * BigInt(order.price) / BigInt(100);
      await pool.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [refundAmount.toString(), req.user.userId]);
    }
    
    await pool.query('COMMIT');
    
    io.emit('order:cancelled', {
      orderId: order.id,
      userId: req.user.userId,
      username: req.user.username
    });
    
    res.json({
      code: 200,
      message: '訂單取消成功'
    });
  } catch (err) {
    await pool.query('ROLLBACK');
    res.status(500).json({ 
      code: 500, 
      message: '訂單取消失敗',
      error: err.message 
    });
  }
});

// 前端期望的缺失 API 端點
// 錢包與資產相關端點（demo）
app.post('/api/anon/v1/wallet/currency', (req, res) => {
  res.json({ code: 200, data: [
    { id: 1, symbol: 'USDT', name: 'Tether USD' },
    { id: 2, symbol: 'BTC', name: 'Bitcoin' },
    { id: 3, symbol: 'ETH', name: 'Ethereum' }
  ]});
});
app.post('/api/authc/v1/account/balance', authenticateToken, (req, res) => {
  // 現金帳戶
  res.json({ code: 200, data: [{ currency: 'USDT', available: 1000, frozen: 0 }] });
});
app.post('/api/authc/v1/wallet/balance', authenticateToken, (req, res) => {
  // 其它帳戶（stock/futures/forex）—回空
  res.json({ code: 200, data: [] });
});
app.post('/api/authc/v1/account/assets', authenticateToken, (req, res) => {
  res.json({ code: 200, data: { total: 1000, currency: 'USDT' } });
});

// 使用者資訊（前台 Header 判斷用）
app.post('/api/authc/v1/user/get', authenticateToken, (req, res) => {
  const uid = req.user.userId;
  const u = memoryStore.users.find(x => x.id === uid);
  const data = u ? { uid: u.id, username: u.username, email: u.email } : { uid, username: `user${uid}`, email: '' };
  res.json({ code: 200, data });
});

// 合約/彩種/AI 相關（補齊前台 404）
app.post('/api/authc/v22/contract/list', authenticateToken, (req, res) => {
  res.json({ code: 200, data: [] });
});
// 时时彩（shishicai）
app.post('/api/anon/v24/item/shishicai', (req, res) => {
  res.json({ code: 200, data: [] });
});
app.post('/api/anon/v24/shishicai/time', (req, res) => {
  const now = Date.now();
  res.json({ code: 200, data: [
    { issue: 'T1', start: now - 600000, end: now - 300000 },
    { issue: 'T2', start: now - 300000, end: now }
  ]});
});
app.post('/api/anon/v24/shishicai/number', (req, res) => {
  res.json({ code: 200, data: ['1','2','3','4','5'] });
});
app.post('/api/authc/v24/shishicai/list', authenticateToken, (req, res) => {
  res.json({ code: 200, data: [] });
});
// AI 量化
app.post('/api/anon/v2/item/aiquant', (req, res) => {
  res.json({ code: 200, data: [
    { id: 1, name: 'AI策略一', apy: '12.5%', symbol: 'BTCUSDT' },
    { id: 2, name: 'AI策略二', apy: '9.8%', symbol: 'ETHUSDT' }
  ]});
});
app.post('/api/authc/v1/aiquant/list', authenticateToken, (req, res) => {
  res.json({ code: 200, data: [] });
});

// 谷歌驗證（Demo：不連第三方，只模擬流程）
app.post('/api/authc/v1/user/google/get', authenticateToken, (req, res) => {
  const uid = req.user.userId;
  const info = memoryStore.google[uid] || { bound: false };
  if (!info.secret) {
    // 產生一個假的密鑰與對應的 otpauth URL 方便前端顯示 QR
    const secret = Math.random().toString(36).slice(2, 18).toUpperCase();
    const otpauth = `otpauth://totp/AmpliFyx:${uid}?secret=${secret}&issuer=AmpliFyx`;
    memoryStore.google[uid] = { secret, bound: false, created_at: Date.now() };
    return res.json({ code: 200, data: { bound: false, secret, otpauth } });
  }
  const otpauth = `otpauth://totp/AmpliFyx:${uid}?secret=${info.secret}&issuer=AmpliFyx`;
  return res.json({ code: 200, data: { bound: !!info.bound, secret: info.secret, otpauth } });
});

app.post('/api/authc/v1/user/google/bind', authenticateToken, (req, res) => {
  const uid = req.user.userId;
  const { googlecode } = req.body || {};
  if (!memoryStore.google[uid]) {
    const secret = Math.random().toString(36).slice(2, 18).toUpperCase();
    memoryStore.google[uid] = { secret, bound: false, created_at: Date.now() };
  }
  // Demo：只要有六位數就視為正確
  if (!googlecode || String(googlecode).length !== 6) {
    return res.status(200).json({ code: 400, message: '驗證碼錯誤' });
  }
  memoryStore.google[uid].bound = true;
  return res.json({ code: 200, message: '綁定成功' });
});

// 支援列表端點
app.post('/api/anon/v1/support/list', (req, res) => {
  res.json({
    code: 200,
    data: []
  });
});

// 通知列表端點
app.post('/api/anon/v1/notice/list', (req, res) => {
  res.json({
    code: 200,
    data: []
  });
});
app.post('/api/authc/v1/notice/joinlist', authenticateToken, (req, res) => {
  res.json({ code: 200, data: [] });
});

// 通訊 token 端點
app.post('/api/anon/v1/comm/token', (req, res) => {
  res.json({
    code: 200,
    data: {
      token: 'mock-session-token',
      expires: Date.now() + 3600000
    }
  });
});

// 圖形驗證碼（SVG 格式）
app.get('/api/anon/v1/comm/verifcode', (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  memoryStore.captchas[ip] = { code, expires: Date.now() + CAPTCHA_EXPIRY_MS };

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="120" height="48">
  <rect width="100%" height="100%" fill="#f5f7fa"/>
  <g font-family="Arial, Helvetica, sans-serif" font-size="28" font-weight="bold">
    <text x="14" y="34" fill="#2c3e50">${code}</text>
  </g>
  <line x1="0" y1="8" x2="120" y2="12" stroke="#dfe4ea" stroke-width="2"/>
  <line x1="0" y1="36" x2="120" y2="40" stroke="#dfe4ea" stroke-width="2"/>
</svg>`;

  res.setHeader('Content-Type', 'image/svg+xml');
  res.status(200).send(svg);
});

// 發送郵件驗證碼（demo：記憶體模式直接生成並記錄，不實際寄出）
app.post('/api/anon/v1/user/emailcode', (req, res) => {
  const { email } = req.body || {};
  if (!email) {
    return res.status(200).json({ code: 400, message: '需要 email' });
  }
  // 產生六位數驗證碼
  const code = ('' + Math.floor(100000 + Math.random() * 900000));
  memoryStore.emailCodes[email] = { code, expires: Date.now() + 10 * 60 * 1000 };
  console.log(`📧 [emailcode] ${email} -> ${code}`);
  return res.json({ code: 200, message: '驗證碼已發送（DEMO）', data: { code } });
});

// 綁定郵箱，驗證郵件驗證碼
app.post('/api/authc/v1/user/emailbind', (req, res) => {
  const { verifcode, email } = req.body || {};
  // DEMO：為了流程可測，若未提供 email，就接受任意六位數
  if (!email) {
    if (verifcode && String(verifcode).length === 6) {
      return res.json({ code: 200, message: '綁定成功' });
    }
    return res.status(200).json({ code: 400, message: '驗證碼錯誤' });
  }
  const rec = memoryStore.emailCodes[email];
  if (!rec || Date.now() > rec.expires) {
    return res.status(200).json({ code: 400, message: '驗證碼已過期' });
  }
  if (String(verifcode) !== rec.code) {
    return res.status(200).json({ code: 400, message: '驗證碼錯誤' });
  }
  return res.json({ code: 200, message: '綁定成功' });
});

// K 線歷史資料
app.get('/api/anon/v1/ticker/kline', (req, res) => {
  const { symbol = 'BTCUSDT', period = '1min', page = '1' } = req.query || {};
  const pageNum = Math.max(parseInt(page, 10) || 1, 1);
  const count = 100; // 每頁 100 筆
  const now = Date.now() - (pageNum - 1) * count * 60 * 1000;
  const data = [];
  let base = 50000;
  let volBase = 10;
  for (let i = count - 1; i >= 0; i--) {
    const t = now - i * 60 * 1000;
    const open = base + (Math.random() - 0.5) * 100;
    const close = open + (Math.random() - 0.5) * 120;
    const high = Math.max(open, close) + Math.random() * 60;
    const low = Math.min(open, close) - Math.random() * 60;
    const volume = Math.abs(close - open) * (volBase + Math.random() * 5);
    data.push({ symbol, period, open, high, low, close, volume, ts: t, timezone: 'Asia/Taipei' });
    base = close; // 漸進
  }
  res.json({ code: 200, data });
});

// 分時歷史資料
app.get('/api/anon/v1/ticker/time', (req, res) => {
  const { symbol = 'BTCUSDT' } = req.query || {};
  const count = 120;
  const now = Date.now();
  const data = [];
  let price = 50000 + (Math.random() - 0.5) * 200;
  for (let i = count - 1; i >= 0; i--) {
    const t = now - i * 60 * 1000;
    const delta = (Math.random() - 0.5) * 50;
    price = Math.max(1, price + delta);
    data.push({ symbol, price, ts: t, timezone: 'Asia/Taipei' });
  }
  res.json({ code: 200, data });
});

// 即時行情（首頁跑馬燈/匯率用）
app.get('/api/anon/v1/ticker/realtime', (req, res) => {
  const { symbol = 'BTC/USDT' } = req.query || {};
  // 簡單模擬實時價與 24h 變動
  const base = 50000 + (Math.random() - 0.5) * 200;
  const changePct = (Math.random() - 0.5) * 0.06; // ±6%
  const price = Math.max(0.0001, base * (1 + changePct));
  const high24h = Math.max(base, price) * (1 + Math.random() * 0.01);
  const low24h = Math.min(base, price) * (1 - Math.random() * 0.01);
  const volume24h = Math.floor(1000 + Math.random() * 10000);
  res.json({ code: 200, data: { symbol, price, change24h: changePct, high24h, low24h, volume24h, ts: Date.now() } });
});

// 首頁推薦清單（可供卡片/列表）
app.post('/api/anon/v1/market/stock/recommend', (req, res) => {
  const symbols = ['BTC/USDT','ETH/USDT','BNB/USDT','SOL/USDT','XRP/USDT','DOGE/USDT'];
  const data = symbols.map(s => {
    const base = 500 + Math.random() * 50000;
    const changePct = (Math.random() - 0.5) * 0.08;
    const price = Math.max(0.0001, base * (1 + changePct));
    return { symbol: s, price, change24h: changePct };
  });
  res.json({ code: 200, data });
});

// ===== 補齊首頁/市場所需匿名端點，避免 404 =====
app.post('/api/anon/v1/item/basic', (req, res) => {
  const { symbol = 'BTCUSDT' } = req.body || {};
  const name = symbol.replace('USDT','');
  return res.json({ code: 200, data: { symbol, name, price: 50000 + Math.random()*200, change24h: (Math.random()-0.5)*0.08 } });
});
app.post('/api/anon/v1/item/stock', (req, res) => {
  const { symbol = 'BTCUSDT' } = req.body || {};
  return res.json({ code: 200, data: { symbol, sectors: ['crypto'], exchange: 'AFX', status: 'trading' } });
});
app.post('/api/anon/v1/item/trade', (req, res) => {
  // 市場列表（示例）
  const data = ['BTC/USDT','ETH/USDT','BNB/USDT','SOL/USDT','XRP/USDT'].map(s => ({ symbol: s.replace('/',''), name: s, price: 100 + Math.random()*1000, change24h: (Math.random()-0.5)*0.08 }))
  return res.json({ code: 200, data });
});
app.post('/api/anon/v1/stock/para', (req, res) => {
  return res.json({ code: 200, data: { minAmount: 10, maxAmount: 1000000, feeRate: 0.001 } });
});
app.post('/api/anon/v1/trade/para', (req, res) => {
  return res.json({ code: 200, data: { minAmount: 10, maxAmount: 1000000, feeRate: 0.001 } });
});
app.post('/api/anon/v1/market/get', (req, res) => {
  return res.json({ code: 200, data: { markets: ['crypto','contract','c2c'] } });
});
app.post('/api/anon/v1/market/stock/exchange', (req, res) => {
  return res.json({ code: 200, data: [{ code: 'AFX', name: 'AmpliFyx Exchange' }] });
});
app.post('/api/anon/v21/market/stock/index', (req, res) => {
  return res.json({ code: 200, data: [] });
});
app.post('/api/anon/v21/market/stock/overview', (req, res) => {
  return res.json({ code: 200, data: [] });
});

// roles（可能被前端誤寫為 rules）— 補齊大宗交易相關端點
app.post('/api/roles/v1/blocktrade/para', (req, res) => {
  res.json({ code: 200, data: { minAmount: 1, maxLeverage: 5 } });
});
app.post('/api/roles/v1/blocktrade/q/list', (req, res) => {
  res.json({ code: 200, data: [] });
});
app.post('/api/roles/v1/blocktrade/m/sell', (req, res) => {
  res.json({ code: 200, message: '下單成功' });
});

// 通用：Admin 端多數 /roles/v1/* 請求（demo 回傳空清單/成功訊息，繁中）
app.all('/api/roles/v1/*', authenticateToken, async (req, res) => {
  const p = req.path || '';
  const ok = (data = {}) => res.json({ code: 200, data });
  const okMsg = (message = '操作成功') => res.json({ code: 200, message });
  // list 類
  if (/\/roles\/v1\/sysuser\/list$/.test(p)) {
    if (!useMemoryStore && pool) {
      try {
        const r = await pool.query('SELECT id, username, email, status FROM users ORDER BY id DESC LIMIT 200');
        return ok(r.rows);
      } catch (e) {
        console.warn('sysuser/list DB error, fallback memory:', e.message);
      }
    }
    return ok(memoryStore.adminUsers.map(u => ({ id: u.id, username: u.username, email: u.email, status: u.status })));
  }
  if (/\/roles\/v1\/sysrole\/list$/.test(p)) {
    // 預設給兩個角色
    return ok([
      { roleid: 1, rolename: '系統管理員', auths: 'dashboard,users,orders,finance,system', remarks: '擁有全部權限', preset: true },
      { roleid: 2, rolename: '客服人員', auths: 'dashboard,service,users', remarks: '客服相關權限', preset: true }
    ]);
  }
  // 金額異動（錢包日誌）
  if (/\/roles\/v1\/walletlog\/list$/.test(p)) {
    if (!useMemoryStore && pool) {
      try {
        const r = await pool.query(
          'SELECT id, user_id, old_balance, new_balance, delta, reason, created_at FROM balance_logs ORDER BY id DESC LIMIT 200'
        );
        return ok(r.rows);
      } catch (e) {
        console.warn('walletlog/list DB error:', e.message);
      }
    }
    return ok([]);
  }
  // 用戶列表（客服/玩家列表共用）
  if (/\/roles\/v1\/(user|support)\/list$/.test(p)) {
    if (!useMemoryStore && pool) {
      try {
        const r = await pool.query('SELECT id, username, email, status, created_at FROM users ORDER BY id DESC LIMIT 200');
        return ok(r.rows);
      } catch (e) {
        console.warn('user/support/list DB error:', e.message);
      }
    }
    return ok([]);
  }
  if (/\/roles\/v1\/support\/user\/search$/.test(p)) {
    const { keyword = '' } = req.body || {};
    if (!useMemoryStore && pool) {
      try {
        const r = await pool.query(
          `SELECT id, username, email, status, created_at FROM users
           WHERE username ILIKE $1 OR email ILIKE $1
           ORDER BY id DESC LIMIT 200`,
          [`%${keyword}%`]
        );
        return ok(r.rows);
      } catch (e) {
        console.warn('support/user/search DB error:', e.message);
      }
    }
    return ok([]);
  }
  // 客服訊息（簡化：回空/標記已讀/黑名單管理）
  if (/\/roles\/v1\/support\/msg\/list$/.test(p)) return ok([]);
  if (/\/roles\/v1\/support\/msg\/read$/.test(p)) return okMsg('已讀');
  if (/\/roles\/v1\/support\/manage\/delmsg$/.test(p)) return okMsg('已刪除');
  if (/\/roles\/v1\/support\/manage\/blacklist\/add$/.test(p)) { const { uid } = req.body||{}; if (uid) memoryStore.supportBlacklist.push(uid); return okMsg('已加入黑名單'); }
  if (/\/roles\/v1\/support\/manage\/blacklist\/del$/.test(p)) { const { uid } = req.body||{}; memoryStore.supportBlacklist = memoryStore.supportBlacklist.filter(x=>x!==uid); return okMsg('已移除黑名單'); }
  if (/\/roles\/v1\/support\/manage\/remarks$/.test(p)) return okMsg('已備註');
  // 交易紀錄（訂單/成交）
  if (/\/roles\/v1\/(stock|futures)\/q\/list$/.test(p) || /\/roles\/v1\/orders\/q\/list$/.test(p)) {
    if (!useMemoryStore && pool) {
      try {
        const r = await pool.query(
          'SELECT id, user_id, symbol, side, price, amount, remaining, status, created_at FROM orders ORDER BY id DESC LIMIT 200'
        );
        return ok(r.rows);
      } catch (e) {
        console.warn('orders/q/list DB error:', e.message);
      }
    }
    return ok([]);
  }
  if (/\/roles\/v1\/trades\/q\/list$/.test(p)) {
    if (!useMemoryStore && pool) {
      try {
        const r = await pool.query(
          'SELECT id, buy_order_id, sell_order_id, buyer_id, seller_id, symbol, price, amount, total, fee, created_at FROM trades ORDER BY id DESC LIMIT 200'
        );
        return ok(r.rows);
      } catch (e) {
        console.warn('trades/q/list DB error:', e.message);
      }
    }
    return ok([]);
  }
  // 交易數據（簡化彙總）
  if (/\/roles\/v1\/data\/global\/total$/.test(p)) {
    if (!useMemoryStore && pool) {
      try {
        const [{ rows: u } , { rows: o }, { rows: t }] = await Promise.all([
          pool.query('SELECT COUNT(*)::int AS users FROM users'),
          pool.query('SELECT COUNT(*)::int AS orders FROM orders'),
          pool.query('SELECT COUNT(*)::int AS trades FROM trades')
        ]);
        return ok({ users: u[0].users, orders: o[0].orders, trades: t[0].trades });
      } catch (e) {
        console.warn('data/global/total DB error:', e.message);
      }
    }
    return ok({ users: 0, orders: 0, trades: 0 });
  }
  if (/\/roles\/v1\/data\/global\/date$/.test(p)) {
    // 簡化：近7天空資料
    const now = Date.now();
    const data = Array.from({ length: 7 }).map((_,i)=>({ ts: now - (6-i)*86400000, users: 0, orders: 0, trades: 0 }));
    return ok(data);
  }
  if (/\/roles\/v1\/data\/user\/list$/.test(p)) {
    if (!useMemoryStore && pool) {
      try {
        const r = await pool.query('SELECT id, username, email, status, created_at FROM users ORDER BY id DESC LIMIT 200');
        return ok(r.rows);
      } catch (e) {
        console.warn('data/user/list DB error:', e.message);
      }
    }
    return ok([]);
  }
  if (/\/roles\/v1\/data\/(user|my)\/currency$/.test(p)) {
    return ok([{ currency: 'USDT', total: 0 }]);
  }
  if (/\/roles\/v1\/data\/(my)\/(total|list)$/.test(p)) {
    return ok([]);
  }
  if (/\/(q\/)?list$/.test(p) || /\/list$/.test(p)) return ok([]);
  // get 類
  if (/\/roles\/v1\/sysuser\/get$/.test(p)) {
    const { id } = req.body || {};
    if (!useMemoryStore && pool) {
      try {
        const r = await pool.query('SELECT id, username, email, status FROM users WHERE id = $1', [id]);
        return ok(r.rows[0] || {});
      } catch (e) {
        console.warn('sysuser/get DB error, fallback memory:', e.message);
      }
    }
    const u = memoryStore.adminUsers.find(x => String(x.id) === String(id));
    return ok(u ? { id: u.id, username: u.username, email: u.email, status: u.status } : {});
  }
  if (/\/roles\/v1\/sysrole\/authtree$/.test(p)) {
    return ok({
      menus: ['dashboard', 'users', 'orders', 'finance', 'system', 'service', 'market', 'c2c', 'ipo', 'contract', 'crypto', 'blocktrade'],
      actions: ['view', 'add', 'update', 'delete', 'export']
    });
  }
  if (/\/(q\/)?get$/.test(p) || /\/get$/.test(p) || /\/para$/.test(p) || /\/conf(get)?$/.test(p) || /\/authtree$/.test(p)) return ok({});
  // 其餘變更操作
  if (/\/roles\/v1\/sysuser\/add$/.test(p)) {
    const { username, email, password } = req.body || {};
    if (!useMemoryStore && pool) {
      try {
        const hashed = await bcrypt.hash(password || '123456', 12);
        try {
          await pool.query("INSERT INTO users(username, email, password_hash, role, status) VALUES($1,$2,$3,'admin','active')", [username, email, hashed]);
        } catch (e) {
          // role 欄位不存在時退化
          await pool.query("INSERT INTO users(username, email, password_hash, status) VALUES($1,$2,$3,'active')", [username, email, hashed]);
        }
        return okMsg('新增成功');
      } catch (e) {
        return res.json({ code: 500, message: '新增失敗', error: e.message });
      }
    }
    const id = memoryStore.nextAdminUserId++;
    memoryStore.adminUsers.push({ id, username: username || ('user' + id), email: email || '', password_hash: password || '', status: 'active', created_at: new Date() });
    return okMsg('新增成功');
  }
  if (/\/roles\/v1\/sysuser\/update$/.test(p)) {
    const { id, username, email, status } = req.body || {};
    if (!useMemoryStore && pool) {
      try {
        const fields = [];
        const params = [];
        let idx = 1;
        if (username) { fields.push(`username = $${idx++}`); params.push(username); }
        if (email) { fields.push(`email = $${idx++}`); params.push(email); }
        if (status) { fields.push(`status = $${idx++}`); params.push(status); }
        if (!fields.length) return okMsg('無需更新');
        params.push(id);
        await pool.query(`UPDATE users SET ${fields.join(', ')}, updated_at = now() WHERE id = $${idx}`, params);
        return okMsg('更新成功');
      } catch (e) {
        return res.json({ code: 500, message: '更新失敗', error: e.message });
      }
    }
    const u = memoryStore.adminUsers.find(x => String(x.id) === String(id));
    if (u) {
      if (username) u.username = username;
      if (email) u.email = email;
      if (status) u.status = status;
    }
    return okMsg('更新成功');
  }
  if (/\/(add|update|del|sell|buy|status|read|bank|confirm|enabled|resetps|autoup|adjust|volume|clear)$/.test(p) || /\/m\//.test(p)) return okMsg('操作成功');
  // 預設
  return ok({});
});

// 合約項目端點
app.post('/api/anon/v22/contract/item', (req, res) => {
  res.json({
    code: 200,
    data: []
  });
});

// Socket
io.on('connection', socket => {
  console.log('socket connected', socket.id);
  // 持續推送 K 線（每秒一筆）
  socket.data = socket.data || {};
  socket.on('kline', (payload) => {
    try {
      const params = JSON.parse(payload || '{}');
      // 清除既有計時器
      if (socket.data.klineTimer) {
        clearInterval(socket.data.klineTimer);
        socket.data.klineTimer = null;
      }
      if (!params || !params.symbol) return; // 空字串即為取消訂閱
      socket.data.klineTimer = setInterval(() => {
        const now = Date.now();
        const open = 50000 + (Math.random() - 0.5) * 100;
        const close = open + (Math.random() - 0.5) * 120;
        const high = Math.max(open, close) + Math.random() * 60;
        const low = Math.min(open, close) - Math.random() * 60;
        const volume = Math.abs(close - open) * (10 + Math.random() * 5);
        socket.emit('kline', {
          code: 200,
          symbol: params.symbol,
          period: params.period,
          data: [{ open, high, low, close, volume, ts: now, timezone: 'Asia/Taipei' }]
        });
      }, 1000);
    } catch {}
  });
  socket.on('disconnect', () => {
    if (socket.data?.klineTimer) {
      clearInterval(socket.data.klineTimer);
      socket.data.klineTimer = null;
    }
  });
  socket.on('time', (symbol) => {
    const now = Date.now();
    const price = 50000 + (Math.random() - 0.5) * 200;
    socket.emit('time', {
      code: 200,
      symbol,
      data: [{ price, ts: now, timezone: 'Asia/Taipei' }]
    });
  });
});