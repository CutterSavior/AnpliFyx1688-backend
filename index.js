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
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(bodyParser.json());

// JWT 密鑰配置
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-key-change-in-production';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '24h';

// 判斷是否在生產環境且沒有數據庫
const isProduction = process.env.NODE_ENV === 'production' || process.env.RENDER;
const hasDatabase = process.env.DATABASE_URL;
const useMemoryStore = isProduction && !hasDatabase;

// 只在有數據庫時初始化連接池
let pool = null;
if (hasDatabase) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgres://postgres:postgres@postgres:5432/exchange'
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
  users: [],
  orders: [],
  nextUserId: 1,
  nextOrderId: 1
};

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
    
    // 驗證用戶是否存在且狀態正常
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
        'INSERT INTO users(username, email, password_hash) VALUES($1, $2, $3) RETURNING id, username, email',
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
        token
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
// 錢包貨幣端點
app.post('/api/anon/v1/wallet/currency', (req, res) => {
  res.json({
    code: 200,
    data: [
      { id: 1, symbol: 'USDT', name: 'Tether USD', balance: 1000.00 },
      { id: 2, symbol: 'BTC', name: 'Bitcoin', balance: 0.001 },
      { id: 3, symbol: 'ETH', name: 'Ethereum', balance: 0.1 }
    ]
  });
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
});

// 啟動服務器
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎉 服務已上線`);
  console.log(`🔗 後端網址: https://anplifyx1688-backend.onrender.com`);
  console.log(`📡 API 基本 URL: http://localhost:${PORT}/api`);
  console.log(`🏥 健康檢查: http://localhost:${PORT}/health`);
  console.log(`📝 指定網域的交友URL: https://render.com/docs/web-services#port-binding`);
});