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
  cors: {
    origin: [
      // 开发环境
      'http://localhost:8087',  // G平台开发环境
      'http://localhost:9528',  // A平台开发环境
      
      // G平台生产域名
      'https://amplifyx1688.pages.dev',  // G平台预期生产环境
      'https://game.andy123.net',  // G平台实际生产域名
      'https://andy123.net',  // G平台根域名
      
      // A平台生产域名
      'https://admin-amplifyx1688.pages.dev',  // A平台预期生产环境
      'https://tw-amplfyx.online',  // A平台实际域名
      
      // 通配符域名支持
      /\.pages\.dev$/,  // Cloudflare Pages域名
      /\.onrender\.com$/,  // Render.com域名
      /\.vercel\.app$/,  // Vercel域名
      /\.netlify\.app$/,  // Netlify域名
      /\.online$/,  // .online域名
      /\.net$/  // .net域名
    ],
    credentials: false,  // 关闭credentials，避免CORS问题
    methods: ['GET', 'POST']
  },
  path: '/socket.io',
  transports: ['websocket', 'polling']
});

// 更详细的CORS配置，支持G平台和A平台
app.use(cors({
  origin: [
    // 开发环境
    'http://localhost:8087',  // G平台开发环境
    'http://localhost:9528',  // A平台开发环境
    
    // G平台生产域名
    'https://amplifyx1688.pages.dev',  // G平台预期生产环境
    'https://game.andy123.net',  // G平台实际生产域名
    'https://andy123.net',  // G平台根域名
    
    // A平台生产域名
    'https://admin-amplifyx1688.pages.dev',  // A平台预期生产环境
    'https://tw-amplfyx.online',  // A平台实际域名（注意：amplfyx缺少i）
    
    // 通配符域名支持
    /\.pages\.dev$/,  // Cloudflare Pages域名
    /\.onrender\.com$/,  // Render.com域名
    /\.vercel\.app$/,  // Vercel域名
    /\.netlify\.app$/,  // Netlify域名
    /\.online$/,  // .online域名
    /\.net$/  // .net域名
  ],
  credentials: false,  // 关闭credentials，避免CORS问题
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'auth', 'lang', 'X-Requested-With'],
  exposedHeaders: ['Content-Length', 'X-Foo', 'X-Bar']
}));

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
      
      // 創建默認管理員用戶
      try {
        const adminCheck = await pool.query('SELECT id FROM users WHERE username = $1', ['admin']);
        if (adminCheck.rows.length === 0) {
          const hashedPassword = await bcrypt.hash('admin123', 12);
          await pool.query(`
            INSERT INTO users (username, email, password_hash, status, balance, metadata) 
            VALUES ($1, $2, $3, $4, $5, $6)
          `, [
            'admin',
            'admin@example.com',
            hashedPassword,
            'active',
            0,
            JSON.stringify({
              realname: '系統管理員',
              phone: '',
              level: 'Admin',
              google_bound: 'true',
              identity_verified: 'true',
              kyc_status: 'verified'
            })
          ]);
          console.log('👤 Created default admin user: admin / admin123');
        } else {
          console.log('👤 Admin user already exists');
        }
      } catch (e) {
        console.warn('Failed to create default admin user:', e?.message || e);
      }
      
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

// G平台用户注册 - 无/api前缀
app.post('/anon/v1/user/register', async (req, res) => {
  const { username, email, password, verifcode, token } = req.body || {};

  // 验证session token (简化处理)
  if (!token) {
    return res.status(200).json({ code: 400, message: '缺少session token' });
  }

  // 验证图形验证码
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const rec = memoryStore.captchas[ip];
  if (!verifcode || !rec || Date.now() > rec.expires || String(verifcode).toUpperCase() !== rec.code) {
    return res.status(200).json({ code: 1001, message: '请输入验证码' });
  }

  // 验证码正确后立即清除
  delete memoryStore.captchas[ip];

  if (!username || !email || !password) {
    return res.status(200).json({ code: 400, message: '用户名、邮箱和密码为必填项目' });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 12);
    
    if (useMemoryStore) {
      const existingUser = memoryStore.users.find(u => 
        u.username === username || u.email === email
      );
      
      if (existingUser) {
        return res.status(200).json({ code: 1101, message: '用户名或邮箱已存在' });
      }
      
      const user = {
        id: memoryStore.nextUserId++,
        username,
        email,
        password_hash: hashedPassword,
        status: 'active',
        balance: 0,
        created_at: new Date(),
        metadata: { kyc_status: 'none', google_bound: 'false' }
      };
      
      memoryStore.users.push(user);
      const authToken = generateToken(user.id, user.username);
      
      res.json({
        code: 200,
        message: '注册成功',
        data: {
          id: user.id,
          username: user.username,
          email: user.email,
          auth: authToken
        }
      });
    } else {
      const r = await pool.query(
        "INSERT INTO users(username, email, password_hash, metadata) VALUES($1, $2, $3, jsonb_build_object('kyc_status','none','google_bound', 'false')) RETURNING id, username, email",
        [username, email, hashedPassword]
      );
      
      const user = r.rows[0];
      const authToken = generateToken(user.id, user.username);
      
      res.json({
        code: 200,
        message: '注册成功',
        data: {
          id: user.id,
          username: user.username,
          email: user.email,
          auth: authToken
        }
      });
    }
  } catch (err) {
    if (err.code === '23505') {
      return res.status(200).json({ code: 1101, message: '用户名或邮箱已存在' });
    }
    res.status(500).json({
      code: 500,
      message: '注册失败',
      error: err.message
    });
  }
});

// 模拟用户注册 - G平台
app.post('/anon/v1/user/guest/register', async (req, res) => {
  const { verifcode, token } = req.body || {};

  // 验证session token
  if (!token) {
    return res.status(200).json({ code: 400, message: '缺少session token' });
  }

  // 验证图形验证码
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const rec = memoryStore.captchas[ip];
  if (!verifcode || !rec || Date.now() > rec.expires || String(verifcode).toUpperCase() !== rec.code) {
    return res.status(200).json({ code: 1001, message: '请输入验证码' });
  }

  // 验证码正确后立即清除
  delete memoryStore.captchas[ip];

  try {
    // 生成随机的模拟用户
    const guestId = 'guest_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
    const user = {
      id: useMemoryStore ? memoryStore.nextUserId++ : Date.now(),
      username: guestId,
      email: `${guestId}@demo.com`,
      password_hash: '',
      status: 'active',
      balance: 100000, // 模拟用户给10万演示金
      created_at: new Date(),
      metadata: { kyc_status: 'none', google_bound: 'false', is_guest: true }
    };

    if (useMemoryStore) {
      memoryStore.users.push(user);
    }

    const authToken = generateToken(user.id, user.username);

    res.json({
      code: 200,
      message: '模拟注册成功',
      data: {
        id: user.id,
        username: user.username,
        email: user.email,
        auth: authToken
      }
    });
  } catch (err) {
    res.status(500).json({
      code: 500,
      message: '模拟注册失败',
      error: err.message
    });
  }
});

// Session Token生成 - G平台
app.post('/anon/v1/comm/token', (req, res) => {
  const token = 'session_' + Date.now() + '_' + Math.random().toString(36).substring(2, 12);
  res.json({
    code: 200,
    message: '获取成功',
    data: token
  });
});

// G平台缺失的API端点
app.post('/anon/v1/notice/list', (req, res) => {
  res.json({
    code: 200,
    data: []
  });
});

app.post('/anon/v1/wallet/currency', (req, res) => {
  res.json({ 
    code: 200, 
    data: [
      { id: 1, symbol: 'USDT', name: 'Tether USD' },
      { id: 2, symbol: 'BTC', name: 'Bitcoin' },
      { id: 3, symbol: 'ETH', name: 'Ethereum' }
    ]
  });
});

app.post('/anon/v1/support/list', (req, res) => {
  res.json({
    code: 200,
    data: []
  });
});

app.post('/anon/v1/market/stock/recommend', (req, res) => {
  const symbols = ['BTC/USDT','ETH/USDT','BNB/USDT','SOL/USDT','XRP/USDT','DOGE/USDT'];
  const data = symbols.map(s => {
    const base = 500 + Math.random() * 50000;
    const changePct = (Math.random() - 0.5) * 0.08;
    const price = Math.max(0.0001, base * (1 + changePct));
    return { symbol: s, price: price.toFixed(4), change24h: (changePct * 100).toFixed(2) + '%' };
  });
  res.json({ code: 200, data });
});

app.post('/anon/v22/contract/item', (req, res) => {
  res.json({ 
    code: 200, 
    data: []
  });
});

app.get('/anon/v1/ticker/realtime', (req, res) => {
  const { symbol = 'BTC/USDT' } = req.query || {};
  const base = 50000 + (Math.random() - 0.5) * 200;
  const changePct = (Math.random() - 0.5) * 0.06;
  const price = Math.max(0.0001, base * (1 + changePct));
  res.json({ 
    code: 200, 
    data: { 
      symbol, 
      price: price.toFixed(2), 
      change24h: (changePct * 100).toFixed(2) + '%',
      volume: (Math.random() * 1000000).toFixed(2)
    }
  });
});

// 支持不同symbol的实时行情 - 修复路径格式
app.get('/anon/v1/ticker/realtime2symbol=*', (req, res) => {
  const url = req.originalUrl;
  const symbolMatch = url.match(/symbol=([^&?]+)/);
  const symbol = symbolMatch ? symbolMatch[1] : 'BTCUSDT';
  
  // 根据不同symbol返回不同的基础价格
  const symbolPrices = {
    'BTCUSDT': 50000,
    'ETHUSDT': 2500,
    'BNBUSDT': 300,
    'SOLUSDT': 100,
    'XRPUSDT': 0.6,
    'DOGEUSDT': 0.08
  };
  
  const base = symbolPrices[symbol] || 1000;
  const changePct = (Math.random() - 0.5) * 0.08;
  const price = Math.max(0.0001, base * (1 + changePct));
  
  res.json({ 
    code: 200, 
    data: { 
      symbol, 
      price: price.toFixed(symbol.includes('USDT') && price < 1 ? 6 : 2), 
      change24h: (changePct * 100).toFixed(2) + '%',
      volume: (Math.random() * 1000000).toFixed(2)
    }
  });
});

// 钱包货币列表 - 修复重复问题
app.get('/anon/v1/wallet/currency', (req, res) => {
  res.json({ 
    code: 200, 
    data: [
      { id: 1, symbol: 'USDT', name: 'Tether USD', icon: 'usdt.svg' },
      { id: 2, symbol: 'BTC', name: 'Bitcoin', icon: 'btc.svg' },
      { id: 3, symbol: 'ETH', name: 'Ethereum', icon: 'eth.svg' },
      { id: 4, symbol: 'BNB', name: 'Binance Coin', icon: 'bnb.svg' },
      { id: 5, symbol: 'SOL', name: 'Solana', icon: 'sol.svg' }
    ]
  });
});

// 通用ticker路由处理所有symbol请求
app.get('/anon/v1/ticker/*', (req, res) => {
  const url = req.originalUrl;
  let symbol = 'BTCUSDT';
  
  // 从URL中提取symbol
  if (url.includes('symbol=')) {
    const symbolMatch = url.match(/symbol=([^&?]+)/);
    symbol = symbolMatch ? symbolMatch[1] : 'BTCUSDT';
  }
  
  // 根据不同symbol返回不同的基础价格
  const symbolPrices = {
    'BTCUSDT': 50000, 'BTC%2FUSDT': 50000,
    'ETHUSDT': 2500, 'ETH%2FUSDT': 2500,
    'BNBUSDT': 300, 'BNB%2FUSDT': 300,
    'SOLUSDT': 100, 'SOL%2FUSDT': 100,
    'XRPUSDT': 0.6, 'XRP%2FUSDT': 0.6,
    'DOGEUSDT': 0.08, 'DOGE%2FUSDT': 0.08
  };
  
  const base = symbolPrices[symbol] || 1000;
  const changePct = (Math.random() - 0.5) * 0.08;
  const price = Math.max(0.0001, base * (1 + changePct));
  
  res.json({ 
    code: 200, 
    data: { 
      symbol: symbol.replace('%2F', '/'), 
      price: price.toFixed(symbol.includes('USDT') && price < 1 ? 6 : 2), 
      change24h: (changePct * 100).toFixed(2) + '%',
      volume: (Math.random() * 1000000).toFixed(2),
      high24h: (price * 1.05).toFixed(2),
      low24h: (price * 0.95).toFixed(2)
    }
  });
});

// G平台Google验证器获取 - 无/api前缀
app.post('/authc/v1/auth/google/get', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    
    let user;
    if (useMemoryStore) {
      user = memoryStore.users.find(u => u.id === userId);
    } else {
      const result = await pool.query('SELECT metadata FROM users WHERE id = $1', [userId]);
      user = result.rows[0];
    }
    
    if (!user) {
      return res.status(404).json({
        code: 404,
        message: '用户不存在'
      });
    }
    
    const metadata = user.metadata || {};
    
    // 如果已经绑定，返回提示
    if (metadata.google_bound === 'true') {
      return res.json({
        code: 200,
        message: '已绑定Google验证器',
        googlebind: true
      });
    }
    
    // 生成 Google 验证器密钥（演示用）
    const googleSecret = 'DEMO' + Math.random().toString(36).substring(2, 18).toUpperCase();
    const qrCodeUrl = `otpauth://totp/AmpliFy:${user.username || userId}?secret=${googleSecret}&issuer=AmpliFy`;
    
    res.json({
      code: 200,
      message: '获取成功',
      googlesecret: googleSecret,
      googlesecretqr: qrCodeUrl,
      googlebind: false
    });
  } catch (error) {
    console.error('获取Google验证器信息失败:', error);
    res.status(500).json({
      code: 500,
      message: '获取失败',
      error: error.message
    });
  }
});

// G平台Google验证器绑定 - 无/api前缀
app.post('/authc/v1/auth/google/bind', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { googlesecret, googlecode } = req.body || {};
    
    if (!googlesecret || !googlecode) {
      return res.status(400).json({
        code: 400,
        message: '参数不完整'
      });
    }
    
    // 简单验证（生产环境应该用真实的 TOTP 验证）
    if (googlecode.length !== 6 || !/^\d{6}$/.test(googlecode)) {
      return res.status(400).json({
        code: 400,
        message: '验证码格式错误'
      });
    }
    
    if (useMemoryStore) {
      const user = memoryStore.users.find(u => u.id === userId);
      if (user) {
        user.metadata = user.metadata || {};
        user.metadata.google_bound = 'true';
      }
    } else {
      await pool.query(`
        UPDATE users 
        SET metadata = jsonb_set(
          COALESCE(metadata, '{}'), 
          '{google_bound}', 
          '"true"'
        ),
        updated_at = now()
        WHERE id = $1
      `, [userId]);
    }
    
    res.json({
      code: 200,
      message: '绑定成功'
    });
  } catch (error) {
    console.error('绑定Google验证器失败:', error);
    res.status(500).json({
      code: 500,
      message: '绑定失败',
      error: error.message
    });
  }
});

// 与前端对齐：匿名注册（需要图形验证码）- 带/api前缀
app.post('/api/anon/v1/user/register', async (req, res) => {
  const { username, email, password, verifcode } = req.body || {};

  // 驗證圖形驗證碼（以 IP 作為簡易關聯）
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const rec = memoryStore.captchas[ip];
  if (!verifcode || !rec || Date.now() > rec.expires || String(verifcode).toUpperCase() !== rec.code) {
    return res.status(200).json({ code: 1001, message: '請輸入驗證碼' });
  }

  // 驗證碼正確後立即清除，防止重複使用
  delete memoryStore.captchas[ip];

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

// G平台用户登录 - 无/api前缀
app.post('/anon/v1/user/login', async (req, res) => {
  const { username, password, verifcode } = req.body || {};

  // 验证图形验证码
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const rec = memoryStore.captchas[ip];
  if (!verifcode || !rec || Date.now() > rec.expires || String(verifcode).toUpperCase() !== rec.code) {
    return res.status(200).json({ code: 1001, message: '请输入验证码' });
  }
  
  // 验证码正确后立即清除
  delete memoryStore.captchas[ip];

  if (!username || !password) {
    return res.status(200).json({ code: 400, message: '用户名和密码为必填项目' });
  }

  try {
    let user;
    if (useMemoryStore) {
      user = memoryStore.users.find(u => u.username === username || u.email === username);
      if (!user) {
        return res.status(200).json({ code: 404, message: '账号不存在' });
      }
      
      const isValidPassword = await bcrypt.compare(password, user.password_hash);
      if (!isValidPassword) {
        return res.status(200).json({ code: 400, message: '密码错误' });
      }
    } else {
      const r = await pool.query(
        'SELECT id, username, email, password_hash, status, balance FROM users WHERE username = $1 OR email = $1',
        [username]
      );
      
      if (!r.rows.length) {
        return res.status(200).json({ code: 404, message: '账号不存在' });
      }
      
      user = r.rows[0];
      const isValidPassword = await bcrypt.compare(password, user.password_hash);
      if (!isValidPassword) {
        return res.status(200).json({ code: 400, message: '密码错误' });
      }
    }

    if (user.status !== 'active') {
      return res.status(200).json({ code: 403, message: '账号已被禁用' });
    }

    const authToken = generateToken(user.id, user.username);
    
    res.json({
      code: 200,
      message: '登录成功',
      data: {
        id: user.id,
        username: user.username,
        email: user.email,
        balance: user.balance || 0,
        auth: authToken
      }
    });
  } catch (err) {
    res.status(500).json({
      code: 500,
      message: '登录失败',
      error: err.message
    });
  }
});

// 与前端对齐：匿名登入（需要图形验证码）- 带/api前缀
app.post('/api/anon/v1/user/login', async (req, res) => {
  const { username, password, verifcode } = req.body || {};

  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const rec = memoryStore.captchas[ip];
  if (!verifcode || !rec || Date.now() > rec.expires || String(verifcode).toUpperCase() !== rec.code) {
    return res.status(200).json({ code: 1001, message: '請輸入驗證碼' });
  }
  
  // 驗證碼正確後立即清除，防止重複使用
  delete memoryStore.captchas[ip];

  if (!username || !password) {
    return res.status(200).json({ code: 400, message: '用戶名和密碼為必填項目' });
  }

  try {
    let user;
    if (useMemoryStore) {
      // 如果 users 陣列為空，初始化預設用戶
      if (!memoryStore.users || memoryStore.users.length === 0) {
        memoryStore.users = [
          { 
            id: 1, 
            username: 'demo_user', 
            email: 'demo@example.com', 
            password_hash: '$2b$12$K8YQF.X2tX8QGY9XvFVQz.rBRZq1QG6Mz8KQF.X2tX8QGY9XvFVQz.', // 密碼：123456
            partyid: 'DEMO001', 
            role: 'user', 
            kyc: 0, 
            uid: '100001', 
            father_username: 'root', 
            limit: '0', 
            lastlogin: '2024-01-15 10:30:00', 
            remarks: '演示用戶', 
            wallet: '1000.00',
            status: 'active',
            created_at: '2024-01-01 00:00:00'
          },
          { 
            id: 2, 
            username: 'test_user', 
            email: 'test@example.com', 
            password_hash: '$2b$12$K8YQF.X2tX8QGY9XvFVQz.rBRZq1QG6Mz8KQF.X2tX8QGY9XvFVQz.', // 密碼：123456
            partyid: 'TEST001', 
            role: 'user', 
            kyc: 1, 
            uid: '100002', 
            father_username: 'root', 
            limit: '0', 
            lastlogin: '2024-01-15 11:30:00', 
            remarks: '測試用戶', 
            wallet: '500.00',
            status: 'active',
            created_at: '2024-01-01 00:00:00'
          }
        ];
        memoryStore.nextUserId = 3;
      }
      
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
// 受保護別名：/api/authc/v1/wallet/currency
app.post('/api/authc/v1/wallet/currency', authenticateToken, (req, res) => {
  const { type, dedup } = req.body || {};
  
  if (type === 'crypto' && dedup === false) {
    // 返回加密貨幣和網路列表，供增加地址功能使用
  res.json({ code: 200, data: [
      { name: 'USDT', network: ['TRC20', 'ERC20', 'BEP20'] },
      { name: 'BTC', network: ['Bitcoin'] },
      { name: 'ETH', network: ['ERC20'] },
      { name: 'DOGE', network: ['Dogecoin'] },
      { name: 'LTC', network: ['Litecoin'] },
      { name: 'TRX', network: ['TRC20'] }
    ]});
  } else {
    // 返回用戶錢包貨幣列表
    res.json({ code: 200, data: [
      { currency: 'USDT', name: '現金賬戶 (USDT)', amount: '0.00' },
      { currency: 'BTC', name: '比特幣賬戶 (BTC)', amount: '0.00' },
      { currency: 'ETH', name: '以太幣賬戶 (ETH)', amount: '0.00' }
    ]});
  }
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
app.post('/api/authc/v1/user/google/get', authenticateToken, async (req, res) => {
  try {
    const uid = req.user.userId;
    
    if (useMemoryStore) {
      // 記憶體模式
      const info = memoryStore.google[uid] || { bound: false };
      if (!info.secret) {
        const secret = Math.random().toString(36).slice(2, 18).toUpperCase();
        const otpauth = `otpauth://totp/AmpliFyx:${uid}?secret=${secret}&issuer=AmpliFyx`;
        memoryStore.google[uid] = { secret, bound: false, created_at: Date.now() };
        return res.json({ code: 200, data: { googlebind: false, googlesecret: secret, googlesecretqr: otpauth } });
      }
      const otpauth = `otpauth://totp/AmpliFyx:${uid}?secret=${info.secret}&issuer=AmpliFyx`;
      return res.json({ code: 200, data: { googlebind: !!info.bound, googlesecret: info.secret, googlesecretqr: otpauth } });
    } else {
      // 數據庫模式
      const userResult = await pool.query('SELECT metadata FROM users WHERE id = $1', [uid]);
      if (userResult.rows.length === 0) {
        return res.status(404).json({ code: 404, message: '用戶不存在' });
      }
      
      const metadata = userResult.rows[0].metadata || {};
      const googleBound = metadata.google_bound === 'true';
      let secret = metadata.google_secret;
      
      if (!secret) {
        secret = Math.random().toString(36).slice(2, 18).toUpperCase();
        metadata.google_secret = secret;
        await pool.query('UPDATE users SET metadata = $1 WHERE id = $2', [JSON.stringify(metadata), uid]);
      }
      
      const otpauth = `otpauth://totp/AmpliFyx:${uid}?secret=${secret}&issuer=AmpliFyx`;
      return res.json({ 
        code: 200, 
        data: { 
          googlebind: googleBound, 
          googlesecret: secret, 
          googlesecretqr: otpauth 
        } 
      });
    }
  } catch (error) {
    console.error('Google get API錯誤:', error);
    res.status(500).json({ code: 500, message: '系統錯誤' });
  }
});
// 別名：/api/authc/v1/auth/google/get（部分前端會呼叫此路徑）
app.post('/api/authc/v1/auth/google/get', authenticateToken, async (req, res) => {
  // 重定向到主要的Google get API
  req.url = '/api/authc/v1/user/google/get';
  return app._router.handle(req, res);
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

// 別名：/api/authc/v1/auth/google/bind（部分前端會呼叫此路徑）
app.post('/api/authc/v1/auth/google/bind', authenticateToken, (req, res) => {
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

// （移除重複的 API，已在前面實現）

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

// 圖形驗證碼（SVG 格式）- 支持G平台路径
app.get('/anon/v1/comm/verifcode', (req, res) => {
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

// 圖形驗證碼（SVG 格式）- 支持带/api前缀的路径
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
// 股票列表 API (GET)
app.get('/api/anon/v1/stock', (req, res) => {
  const { page = '1', name = '', market = '', country = '' } = req.query || {};
  const pageNum = Math.max(parseInt(page, 10) || 1, 1);
  
  // 按國家分類的股票數據
  const stocksByCountry = {
    us: [
      { symbol: 'AAPL', name: 'Apple Inc.', price: 150 + Math.random() * 50, change24h: (Math.random() - 0.5) * 0.08, market: 'NASDAQ', sectors: ['Technology'], country: 'us', enabled: 1 },
      { symbol: 'GOOGL', name: 'Alphabet Inc.', price: 2500 + Math.random() * 200, change24h: (Math.random() - 0.5) * 0.08, market: 'NASDAQ', sectors: ['Technology'], country: 'us', enabled: 1 },
      { symbol: 'TSLA', name: 'Tesla Inc.', price: 800 + Math.random() * 200, change24h: (Math.random() - 0.5) * 0.08, market: 'NASDAQ', sectors: ['Consumer Cyclical'], country: 'us', enabled: 1 },
      { symbol: 'MSFT', name: 'Microsoft Corp.', price: 300 + Math.random() * 50, change24h: (Math.random() - 0.5) * 0.08, market: 'NASDAQ', sectors: ['Technology'], country: 'us', enabled: 1 },
      { symbol: 'AMZN', name: 'Amazon.com Inc.', price: 3000 + Math.random() * 300, change24h: (Math.random() - 0.5) * 0.08, market: 'NASDAQ', sectors: ['Consumer Cyclical'], country: 'us', enabled: 1 },
      { symbol: 'NVDA', name: 'NVIDIA Corp.', price: 400 + Math.random() * 100, change24h: (Math.random() - 0.5) * 0.08, market: 'NASDAQ', sectors: ['Technology'], country: 'us', enabled: 1 },
      { symbol: 'META', name: 'Meta Platforms Inc.', price: 250 + Math.random() * 50, change24h: (Math.random() - 0.5) * 0.08, market: 'NASDAQ', sectors: ['Communication Services'], country: 'us', enabled: 1 },
      { symbol: 'JPM', name: 'JPMorgan Chase & Co.', price: 150 + Math.random() * 30, change24h: (Math.random() - 0.5) * 0.08, market: 'NYSE', sectors: ['Financial Services'], country: 'us', enabled: 1 }
    ],
    japan: [
      { symbol: '7203.T', name: 'Toyota Motor Corp.', price: 2000 + Math.random() * 200, change24h: (Math.random() - 0.5) * 0.08, market: 'TSE', sectors: ['Consumer Cyclical'], country: 'japan', enabled: 1 },
      { symbol: '6758.T', name: 'Sony Group Corp.', price: 10000 + Math.random() * 1000, change24h: (Math.random() - 0.5) * 0.08, market: 'TSE', sectors: ['Technology'], country: 'japan', enabled: 1 },
      { symbol: '9984.T', name: 'SoftBank Group Corp.', price: 5000 + Math.random() * 500, change24h: (Math.random() - 0.5) * 0.08, market: 'TSE', sectors: ['Technology'], country: 'japan', enabled: 1 },
      { symbol: '8306.T', name: 'Mitsubishi UFJ Financial Group', price: 800 + Math.random() * 80, change24h: (Math.random() - 0.5) * 0.08, market: 'TSE', sectors: ['Financial Services'], country: 'japan', enabled: 1 }
    ],
    china: [
      { symbol: '000001.SZ', name: '平安银行', price: 12.5 + Math.random() * 2, change24h: (Math.random() - 0.5) * 0.08, market: 'SZSE', sectors: ['Financial Services'], country: 'china', enabled: 1 },
      { symbol: '600519.SS', name: '贵州茅台', price: 1800 + Math.random() * 200, change24h: (Math.random() - 0.5) * 0.08, market: 'SSE', sectors: ['Consumer Defensive'], country: 'china', enabled: 1 },
      { symbol: '000858.SZ', name: '五粮液', price: 200 + Math.random() * 20, change24h: (Math.random() - 0.5) * 0.08, market: 'SZSE', sectors: ['Consumer Defensive'], country: 'china', enabled: 1 },
      { symbol: '000002.SZ', name: '万科A', price: 18 + Math.random() * 2, change24h: (Math.random() - 0.5) * 0.08, market: 'SZSE', sectors: ['Real Estate'], country: 'china', enabled: 1 }
    ],
    hongkong: [
      { symbol: '0700.HK', name: '腾讯控股', price: 320 + Math.random() * 30, change24h: (Math.random() - 0.5) * 0.08, market: 'HKEX', sectors: ['Technology'], country: 'hongkong', enabled: 1 },
      { symbol: '9988.HK', name: '阿里巴巴-SW', price: 90 + Math.random() * 10, change24h: (Math.random() - 0.5) * 0.08, market: 'HKEX', sectors: ['Consumer Cyclical'], country: 'hongkong', enabled: 1 },
      { symbol: '0941.HK', name: '中国移动', price: 60 + Math.random() * 6, change24h: (Math.random() - 0.5) * 0.08, market: 'HKEX', sectors: ['Communication Services'], country: 'hongkong', enabled: 1 },
      { symbol: '0005.HK', name: '汇丰控股', price: 45 + Math.random() * 5, change24h: (Math.random() - 0.5) * 0.08, market: 'HKEX', sectors: ['Financial Services'], country: 'hongkong', enabled: 1 }
    ],
    taiwan: [
      { symbol: '2330.TW', name: '台积电', price: 580 + Math.random() * 50, change24h: (Math.random() - 0.5) * 0.08, market: 'TWSE', sectors: ['Technology'], country: 'taiwan', enabled: 1 },
      { symbol: '2317.TW', name: '鸿海', price: 110 + Math.random() * 10, change24h: (Math.random() - 0.5) * 0.08, market: 'TWSE', sectors: ['Technology'], country: 'taiwan', enabled: 1 },
      { symbol: '2454.TW', name: '联发科', price: 850 + Math.random() * 80, change24h: (Math.random() - 0.5) * 0.08, market: 'TWSE', sectors: ['Technology'], country: 'taiwan', enabled: 1 },
      { symbol: '2412.TW', name: '中华电', price: 120 + Math.random() * 12, change24h: (Math.random() - 0.5) * 0.08, market: 'TWSE', sectors: ['Communication Services'], country: 'taiwan', enabled: 1 }
    ],
    korea: [
      { symbol: '005930.KS', name: 'Samsung Electronics', price: 65000 + Math.random() * 5000, change24h: (Math.random() - 0.5) * 0.08, market: 'KRX', sectors: ['Technology'], country: 'korea', enabled: 1 },
      { symbol: '000660.KS', name: 'SK Hynix', price: 120000 + Math.random() * 10000, change24h: (Math.random() - 0.5) * 0.08, market: 'KRX', sectors: ['Technology'], country: 'korea', enabled: 1 },
      { symbol: '207940.KS', name: 'Samsung Biologics', price: 800000 + Math.random() * 50000, change24h: (Math.random() - 0.5) * 0.08, market: 'KRX', sectors: ['Healthcare'], country: 'korea', enabled: 1 }
    ],
    singapore: [
      { symbol: 'D05.SI', name: 'DBS Group Holdings', price: 32 + Math.random() * 3, change24h: (Math.random() - 0.5) * 0.08, market: 'SGX', sectors: ['Financial Services'], country: 'singapore', enabled: 1 },
      { symbol: 'O39.SI', name: 'OCBC Bank', price: 13.5 + Math.random() * 1.5, change24h: (Math.random() - 0.5) * 0.08, market: 'SGX', sectors: ['Financial Services'], country: 'singapore', enabled: 1 },
      { symbol: 'U11.SI', name: 'United Overseas Bank', price: 28 + Math.random() * 3, change24h: (Math.random() - 0.5) * 0.08, market: 'SGX', sectors: ['Financial Services'], country: 'singapore', enabled: 1 }
    ]
  };
  
  // 合併所有國家的股票數據
  let allStocks = [];
  if (country && stocksByCountry[country]) {
    allStocks = stocksByCountry[country];
  } else {
    for (const countryKey in stocksByCountry) {
      allStocks = allStocks.concat(stocksByCountry[countryKey]);
    }
  }
  
  // 過濾和搜索
  let filteredStocks = allStocks;
  if (name) {
    filteredStocks = allStocks.filter(stock => 
      stock.symbol.toLowerCase().includes(name.toLowerCase()) || 
      stock.name.toLowerCase().includes(name.toLowerCase())
    );
  }
  if (market) {
    filteredStocks = filteredStocks.filter(stock => stock.market === market);
  }
  
  // 分頁
  const pageSize = 20;
  const startIndex = (pageNum - 1) * pageSize;
  const paginatedStocks = filteredStocks.slice(startIndex, startIndex + pageSize);
  
  res.json({ code: 200, data: paginatedStocks });
});

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
// 市場列表 API
app.get('/api/anon/v1/market/get', (req, res) => {
  const markets = [
    { market: 'NASDAQ', name: 'NASDAQ Stock Market' },
    { market: 'NYSE', name: 'New York Stock Exchange' },
    { market: 'CRYPTO', name: 'Cryptocurrency Market' },
  ];
  return res.json({ code: 200, data: markets });
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

// ===== 合約/交易對相關 API =====
// 合約列表
app.post('/api/anon/v22/contract/item', (req, res) => {
  const { type = 'crypto' } = req.body || {};
  // 根據類型返回不同的交易對
  let symbols = [];
  switch (type) {
    case 'crypto':
    case 'constract':
      symbols = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'DOTUSDT'];
      break;
    case 'forex':
    case 'foreign':
      symbols = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'USDCHF'];
      break;
    case 'blocktrade':
    case 'commodities':
      symbols = ['XAUUSD', 'XAGUSD', 'WTIUSD', 'BRENTUSD'];
      break;
    case 'ai':
      symbols = ['BTCUSDT', 'ETHUSDT', 'EURUSD', 'XAUUSD'];
      break;
    case 'spot':
      symbols = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT'];
      break;
    default:
      symbols = ['BTCUSDT', 'ETHUSDT'];
  }
  
  const data = symbols.map(symbol => {
    const base = 1000 + Math.random() * 50000;
    const changePct = (Math.random() - 0.5) * 0.08;
    const price = Math.max(0.0001, base * (1 + changePct));
    return {
      symbol,
      name: symbol.replace('USDT', '/USDT').replace('USD', '/USD'),
      price,
      change24h: changePct,
      type,
      status: 'trading'
    };
  });
  
  res.json({ code: 200, data });
});

// 合約參數
app.post('/api/anon/v22/contract/para', (req, res) => {
  return res.json({ 
    code: 200, 
    data: { 
      minAmount: 10, 
      maxAmount: 1000000, 
      feeRate: 0.001,
      leverage: [1, 2, 5, 10, 20, 50, 100]
    } 
  });
});

// AI量化列表
app.post('/api/anon/v1/aiquant2', (req, res) => {
  const symbols = ['BTCUSDT', 'ETHUSDT', 'EURUSD', 'XAUUSD'];
  const data = symbols.map(symbol => {
    const base = 1000 + Math.random() * 50000;
    const changePct = (Math.random() - 0.5) * 0.08;
    const price = Math.max(0.0001, base * (1 + changePct));
    return {
      symbol,
      name: symbol.replace('USDT', '/USDT').replace('USD', '/USD'),
      price,
      change24h: changePct,
      type: 'ai'
    };
  });
  res.json({ code: 200, data });
});

// 時時彩列表
app.post('/api/anon/v1/shishicai', (req, res) => {
  const symbols = ['SSC1', 'SSC2', 'SSC3', 'SSC5'];
  const data = symbols.map(symbol => {
    return {
      symbol,
      name: `時時彩 ${symbol}`,
      price: Math.floor(Math.random() * 1000),
      change24h: (Math.random() - 0.5) * 0.08,
      type: 'lottery'
    };
  });
  res.json({ code: 200, data });
});

// ===== C2C 一鍵買幣相關 API =====
// 快捷買入或賣出
app.post('/api/authc/v1/c2c/order/fast', authenticateToken, (req, res) => {
  const { offset, volume, crypto, currency, safeword } = req.body || {};
  
  // 簡單模擬成功
  const orderId = 'ORD' + Date.now();
  res.json({
    code: 200,
    message: '訂單提交成功',
    data: {
      id: orderId,
      offset,
      volume,
      crypto,
      currency,
      status: 'pending',
      created_at: new Date().toISOString()
    }
  });
});

// 自選交易
app.post('/api/authc/v1/c2c/order/buysell', authenticateToken, (req, res) => {
  const { ad_id, volume, safeword } = req.body || {};
  
  const orderId = 'ORD' + Date.now();
  res.json({
    code: 200,
    message: '交易提交成功',
    data: {
      id: orderId,
      ad_id,
      volume,
      status: 'pending',
      created_at: new Date().toISOString()
    }
  });
});

// 自選列表
app.post('/api/anon/v1/c2c/ad/list', (req, res) => {
  const { offset = 'buy', crypto = 'USDT', currency = 'TWD' } = req.body || {};
  
  // 模擬廣告列表
  const ads = Array.from({ length: 10 }).map((_, i) => ({
    id: `AD${Date.now() + i}`,
    user: {
      nickname: `User${1000 + i}`,
      orders: 100 + Math.floor(Math.random() * 500),
      success_rate: 0.95 + Math.random() * 0.05
    },
    offset,
    crypto,
    currency,
    price: 31.5 + Math.random() * 2,
    limitmin: 1000,
    limitmax: 50000,
    available: 10000 + Math.random() * 40000,
    payments: ['bank_transfer', 'alipay', 'wechat']
  }));
  
  res.json({ code: 200, data: ads });
});

// 質押挖礦 API 的模擬實現
app.post('/api/anon/v1/mining/list', (req, res) => {
  const { page = 1 } = req.body || {};
  const stakingProducts = [
    {
      id: 1,
      name: 'USDT 穩定收益計畫',
      currency: 'USDT',
      apy: '8.5%',
      minAmount: '100',
      maxAmount: '50000',
      duration: '30天',
      status: 'active',
      description: '低風險穩定收益，適合新手投資者',
      totalAmount: '1000000',
      currentAmount: '850000'
    },
    {
      id: 2,
      name: 'BTC 長期質押',
      currency: 'BTC',
      apy: '12.8%',
      minAmount: '0.01',
      maxAmount: '10',
      duration: '90天',
      status: 'active',
      description: '比特幣長期質押計畫，享受高額收益',
      totalAmount: '100',
      currentAmount: '75.5'
    },
    {
      id: 3,
      name: 'ETH 智能合約挖礦',
      currency: 'ETH',
      apy: '15.2%',
      minAmount: '0.1',
      maxAmount: '50',
      duration: '60天',
      status: 'active',
      description: '基於以太坊智能合約的挖礦計畫',
      totalAmount: '500',
      currentAmount: '320.8'
    }
  ];
  
  res.json({ 
    code: 200, 
    data: stakingProducts
  });
});

app.post('/api/anon/v1/mining/get', (req, res) => {
  const { id } = req.body || {};
  const product = {
    id: id || 1,
    name: 'USDT 穩定收益計畫',
    currency: 'USDT',
    apy: '8.5%',
    minAmount: '100',
    maxAmount: '50000',
    duration: '30天',
    status: 'active',
    description: '低風險穩定收益，適合新手投資者。本產品通過專業的資金管理團隊，為用戶提供穩定的收益保障。',
    totalAmount: '1000000',
    currentAmount: '850000',
    startDate: '2024-01-01',
    endDate: '2024-12-31',
    terms: [
      '質押期間不可提前贖回',
      '收益每日計算，到期一次性發放',
      '本產品具有一定投資風險，請謹慎投資'
    ]
  };
  
  res.json({ 
    code: 200, 
    data: product
  });
});

app.post('/api/authc/v1/mining/apply', authenticateToken, (req, res) => {
  const { id, amount } = req.body || {};
  res.json({ 
    code: 200, 
    message: '申購成功',
    data: {
      orderId: `ORDER_${Date.now()}`,
      amount: amount,
      productId: id,
      status: 'success'
    }
  });
});

app.post('/api/authc/v1/mining/orders', authenticateToken, (req, res) => {
  const orders = [
    {
      id: 1,
      orderId: 'ORDER_1704067200000',
      productName: 'USDT 穩定收益計畫',
      currency: 'USDT',
      amount: '1000',
      apy: '8.5%',
      status: 'active',
      startDate: '2024-01-01',
      endDate: '2024-01-31',
      expectedEarning: '23.29'
    },
    {
      id: 2,
      orderId: 'ORDER_1704153600000',
      productName: 'BTC 長期質押',
      currency: 'BTC',
      amount: '0.5',
      apy: '12.8%',
      status: 'completed',
      startDate: '2024-01-02',
      endDate: '2024-04-01',
      expectedEarning: '0.0158'
    }
  ];
  
  res.json({ 
    code: 200, 
    data: orders
  });
});

app.post('/api/authc/v1/mining/earn', authenticateToken, (req, res) => {
  const earnings = [
    {
      date: '2024-01-15',
      productName: 'USDT 穩定收益計畫',
      currency: 'USDT',
      amount: '0.78',
      type: 'daily_interest'
    },
    {
      date: '2024-01-14',
      productName: 'USDT 穩定收益計畫',
      currency: 'USDT',
      amount: '0.78',
      type: 'daily_interest'
    }
  ];
  
  res.json({ 
    code: 200, 
    data: {
      totalEarning: '15.60',
      currency: 'USDT',
      list: earnings
    }
  });
});

// 股票訂單查詢 API (Admin 平台用)
app.post('/api/roles/v1/stock/q/list', authenticateToken, (req, res) => {
  const { page = 1, params = '', role = 'all', status = 'all', start_time, end_time } = req.body || {};
  
  console.log('收到股票訂單查詢請求:', req.body);
  
  // 模擬股票訂單數據
  const orders = [
    {
      order_no: 'STK001',
      uid: '100001',
      username: 'demo_user',
      partyid: 'DEMO001',
      symbol: 'AAPL',
      name: '蘋果公司',
      offset: 'long',
      lever_type: 'cross',
      lever: 1,
      price_type: 'market',
      open_volume: '100',
      unsold_volume: '0',
      open_price: '150.25',
      settled_price: '155.80',
      margin: '15025.00',
      surplus_margin: '15580.00',
      unlock: '0.00',
      profit: '555.00',
      ratio: '3.69',
      fee: '15.03',
      interest: '0.00',
      stop_profit: false,
      stop_loss: false,
      status: 'done',
      date: '2024-01-15 09:30:00',
      role: 'user'
    },
    {
      order_no: 'STK002',
      uid: '100002',
      username: 'test_user',
      partyid: 'TEST001',
      symbol: 'TSLA',
      name: '特斯拉',
      offset: 'short',
      lever_type: 'isolated',
      lever: 1,
      price_type: 'limit',
      open_volume: '50',
      unsold_volume: '50',
      open_price: '240.50',
      settled_price: '235.20',
      margin: '12025.00',
      surplus_margin: '11760.00',
      unlock: '0.00',
      profit: '265.00',
      ratio: '2.20',
      fee: '12.03',
      interest: '5.00',
      stop_profit: true,
      stop_profit_type: 'price',
      stop_profit_price: '250.00',
      stop_loss: true,
      stop_loss_type: 'price',
      stop_loss_price: '245.00',
      status: 'open',
      date: '2024-01-15 10:15:00',
      role: 'user'
    },
    {
      order_no: 'STK003',
      uid: '100001',
      username: 'demo_user',
      partyid: 'DEMO001',
      symbol: 'GOOGL',
      name: '谷歌A股',
      offset: 'long',
      lever_type: 'cross',
      lever: 1,
      price_type: 'market',
      open_volume: '25',
      unsold_volume: '0',
      open_price: '140.75',
      settled_price: '138.90',
      margin: '3518.75',
      surplus_margin: '3472.50',
      unlock: '0.00',
      profit: '-46.25',
      ratio: '-1.31',
      fee: '3.52',
      interest: '0.00',
      stop_profit: false,
      stop_loss: false,
      status: 'done',
      date: '2024-01-14 14:20:00',
      role: 'user'
    },
    {
      order_no: 'STK004',
      uid: '100003',
      username: 'vip_user',
      partyid: 'VIP001',
      symbol: 'MSFT',
      name: '微軟',
      offset: 'long',
      lever_type: 'cross',
      lever: 1,
      price_type: 'limit',
      open_volume: '75',
      unsold_volume: '25',
      open_price: '380.00',
      settled_price: '385.50',
      margin: '28500.00',
      surplus_margin: '28912.50',
      unlock: '9637.50',
      profit: '412.50',
      ratio: '1.45',
      fee: '28.50',
      interest: '2.50',
      stop_profit: true,
      stop_profit_type: 'ratio',
      stop_profit_price: '5',
      stop_loss: true,
      stop_loss_type: 'ratio',
      stop_loss_price: '3',
      status: 'open',
      date: '2024-01-15 11:45:00',
      role: 'vip'
    }
  ];
  
  // 過濾數據
  let filteredOrders = orders;
  
  if (params) {
    filteredOrders = filteredOrders.filter(order => 
      order.uid.includes(params) || 
      order.username.includes(params) || 
      order.symbol.includes(params)
    );
  }
  
  if (role !== 'all') {
    filteredOrders = filteredOrders.filter(order => order.role === role);
  }
  
  if (status !== 'all') {
    filteredOrders = filteredOrders.filter(order => order.status === status);
  }
  
  // 分頁處理
  const pageSize = 20;
  const startIndex = (page - 1) * pageSize;
  const paginatedOrders = filteredOrders.slice(startIndex, startIndex + pageSize);
  
  res.json(paginatedOrders);
});

// 股票訂單詳情查詢
app.post('/api/roles/v1/stock/q/get', authenticateToken, (req, res) => {
  const { order_no } = req.body || {};
  
  const orderDetail = {
    order_no: order_no || 'STK001',
    uid: '100001',
    username: 'demo_user',
    partyid: 'DEMO001',
    symbol: 'AAPL',
    name: '蘋果公司',
    offset: 'long',
    lever_type: 'cross',
    lever: 1,
    price_type: 'market',
    open_volume: '100',
    unsold_volume: '0',
    open_price: '150.25',
    settled_price: '155.80',
    margin: '15025.00',
    surplus_margin: '15580.00',
    unlock: '0.00',
    profit: '555.00',
    ratio: '3.69',
    fee: '15.03',
    interest: '0.00',
    stop_profit: false,
    stop_loss: false,
    status: 'done',
    date: '2024-01-15 09:30:00'
  };
  
  res.json(orderDetail);
});

// 股票訂單賣出操作
app.post('/api/roles/v1/stock/m/sell', authenticateToken, (req, res) => {
  const { order_no, volume } = req.body || {};
  res.json({ 
    code: 200, 
    message: '賣出操作成功',
    data: {
      order_no,
      sold_volume: volume,
      remaining_volume: Math.max(0, 100 - volume)
    }
  });
});

// 股票交易參數配置
app.post('/api/roles/v1/stock/m/para', authenticateToken, (req, res) => {
  res.json({ 
    code: 200, 
    data: {
      min_trade_amount: 100,
      max_trade_amount: 1000000,
      trade_fee_rate: 0.001,
      margin_rate: 1.0,
      max_leverage: 1
    }
  });
});

// 合約訂單查詢 API (Admin 平台用)
app.post('/api/roles/v1/futures/q/list', authenticateToken, (req, res) => {
  const { page = 1, params = '', role = 'all', status = 'all', start_time, end_time } = req.body || {};
  
  // 模擬合約訂單數據
  const orders = [
    {
      order_no: 'FUT001',
      uid: '100001',
      username: 'demo_user',
      partyid: 'DEMO001',
      symbol: 'BTCUSDT',
      name: 'BTC/USDT 永續合約',
      offset: 'long',
      lever_type: 'cross',
      lever: 10,
      price_type: 'market',
      open_volume: '1.5',
      unsold_volume: '0',
      open_price: '42500.00',
      settled_price: '43200.00',
      margin: '6375.00',
      surplus_margin: '6480.00',
      unlock: '0.00',
      profit: '1050.00',
      ratio: '16.47',
      fee: '6.38',
      interest: '2.50',
      stop_profit: true,
      stop_profit_type: 'price',
      stop_profit_price: '45000.00',
      stop_loss: true,
      stop_loss_type: 'price',
      stop_loss_price: '40000.00',
      status: 'done',
      date: '2024-01-15 09:30:00',
      role: 'user'
    },
    {
      order_no: 'FUT002',
      uid: '100002',
      username: 'test_user',
      partyid: 'TEST001',
      symbol: 'ETHUSDT',
      name: 'ETH/USDT 永續合約',
      offset: 'short',
      lever_type: 'isolated',
      lever: 20,
      price_type: 'limit',
      open_volume: '5.0',
      unsold_volume: '2.5',
      open_price: '2580.00',
      settled_price: '2520.00',
      margin: '645.00',
      surplus_margin: '630.00',
      unlock: '322.50',
      profit: '750.00',
      ratio: '116.28',
      fee: '12.90',
      interest: '8.50',
      stop_profit: false,
      stop_loss: true,
      stop_loss_type: 'ratio',
      stop_loss_price: '5',
      status: 'open',
      date: '2024-01-15 10:15:00',
      role: 'user'
    },
    {
      order_no: 'FUT003',
      uid: '100003',
      username: 'vip_user',
      partyid: 'VIP001',
      symbol: 'ADAUSDT',
      name: 'ADA/USDT 永續合約',
      offset: 'long',
      lever_type: 'cross',
      lever: 5,
      price_type: 'market',
      open_volume: '1000',
      unsold_volume: '0',
      open_price: '0.4850',
      settled_price: '0.4920',
      margin: '97.00',
      surplus_margin: '98.40',
      unlock: '0.00',
      profit: '70.00',
      ratio: '72.16',
      fee: '0.97',
      interest: '0.20',
      stop_profit: true,
      stop_profit_type: 'ratio',
      stop_profit_price: '10',
      stop_loss: false,
      status: 'done',
      date: '2024-01-14 16:45:00',
      role: 'vip'
    }
  ];
  
  // 過濾數據
  let filteredOrders = orders;
  
  if (params) {
    filteredOrders = filteredOrders.filter(order => 
      order.uid.includes(params) || 
      order.username.includes(params) || 
      order.symbol.includes(params)
    );
  }
  
  if (role !== 'all') {
    filteredOrders = filteredOrders.filter(order => order.role === role);
  }
  
  if (status !== 'all') {
    filteredOrders = filteredOrders.filter(order => order.status === status);
  }
  
  // 分頁處理
  const pageSize = 20;
  const startIndex = (page - 1) * pageSize;
  const paginatedOrders = filteredOrders.slice(startIndex, startIndex + pageSize);
  
  res.json(paginatedOrders);
});

// 合約訂單詳情查詢
app.post('/api/roles/v1/futures/q/get', authenticateToken, (req, res) => {
  const { order_no } = req.body || {};
  
  const orderDetail = {
    order_no: order_no || 'FUT001',
    uid: '100001',
    username: 'demo_user',
    partyid: 'DEMO001',
    symbol: 'BTCUSDT',
    name: 'BTC/USDT 永續合約',
    offset: 'long',
    lever_type: 'cross',
    lever: 10,
    price_type: 'market',
    open_volume: '1.5',
    unsold_volume: '0',
    open_price: '42500.00',
    settled_price: '43200.00',
    margin: '6375.00',
    surplus_margin: '6480.00',
    unlock: '0.00',
    profit: '1050.00',
    ratio: '16.47',
    fee: '6.38',
    interest: '2.50',
    stop_profit: true,
    stop_profit_type: 'price',
    stop_profit_price: '45000.00',
    stop_loss: true,
    stop_loss_type: 'price',
    stop_loss_price: '40000.00',
    status: 'done',
    date: '2024-01-15 09:30:00'
  };
  
  res.json(orderDetail);
});

// 合約配置列表
app.post('/api/roles/v1/futures/config/list', authenticateToken, (req, res) => {
  const contracts = [
    {
      symbol: 'BTCUSDT',
      name: 'BTC/USDT 永續合約',
      type: 'crypto',
      base_currency: 'BTC',
      quote_currency: 'USDT',
      min_volume: '0.001',
      max_volume: '100',
      price_precision: 2,
      volume_precision: 3,
      status: 'active'
    },
    {
      symbol: 'ETHUSDT',
      name: 'ETH/USDT 永續合約',
      type: 'crypto',
      base_currency: 'ETH',
      quote_currency: 'USDT',
      min_volume: '0.01',
      max_volume: '1000',
      price_precision: 2,
      volume_precision: 2,
      status: 'active'
    }
  ];
  
  res.json(contracts);
});

// 合約配置項目
app.post('/api/roles/v1/futures/config/items', authenticateToken, (req, res) => {
  res.json([
    { symbol: 'BTCUSDT', name: 'BTC/USDT', type: 'crypto' },
    { symbol: 'ETHUSDT', name: 'ETH/USDT', type: 'crypto' }
  ]);
});

// 合約場控相關 API
app.post('/api/roles/v1/futures/control/adjust', authenticateToken, (req, res) => {
  res.json({ code: 200, message: '價格調整成功' });
});

app.post('/api/roles/v1/futures/control/volume', authenticateToken, (req, res) => {
  res.json({ code: 200, message: '成交量調整成功' });
});

app.post('/api/roles/v1/futures/control/clear', authenticateToken, (req, res) => {
  res.json({ code: 200, message: '清倉操作成功' });
});

// 合約賣出操作
app.post('/api/roles/v1/futures/m/sell', authenticateToken, (req, res) => {
  const { order_no, volume } = req.body || {};
  res.json({ 
    code: 200, 
    message: '合約賣出操作成功',
    data: {
      order_no,
      sold_volume: volume,
      remaining_volume: Math.max(0, 1.5 - volume)
    }
  });
});

// 系統管理相關 API
app.post('/api/roles/v1/sysrole/list', authenticateToken, (req, res) => {
  // 與前端期望字段對齊：roleid, rolename, auths, remarks
  res.json([
    { roleid: 1, rolename: '系統管理員', auths: 'dashboard,users,orders,finance,system', remarks: '擁有全部權限', preset: true },
    { roleid: 2, rolename: '客服人員', auths: 'dashboard,service,users', remarks: '客服相關權限', preset: true }
  ]);
});

app.post('/api/roles/v1/sysuser/list', authenticateToken, (req, res) => {
  res.json([
    { id: 1, username: 'admin', role: 'super_admin', status: 'active', created_at: '2024-01-01' },
    { id: 2, username: 'support1', role: 'support', status: 'active', created_at: '2024-01-01' }
  ]);
});

app.post('/api/roles/v1/syspara/list', authenticateToken, (req, res) => {
  // 與前端 ParamsSet 頁面對齊字段：name, value, remark
  res.json([
    { name: 'site_name', value: 'AmpliFyx 交易平台', remark: '網站名稱' },
    { name: 'maintenance_mode', value: 'false', remark: '維護模式 (true/false)' },
    { name: 'max_trade_amount', value: '1000000', remark: '最大交易金額' }
  ]);
});

// 代理商數據統計 API
app.post('/api/roles/v1/data/agent/list', authenticateToken, (req, res) => {
  res.json([
    { id: 1, username: 'agent001', sub_count: 15, total_deposit: '50000.00', total_withdraw: '25000.00', commission: '2500.00' },
    { id: 2, username: 'agent002', sub_count: 8, total_deposit: '30000.00', total_withdraw: '15000.00', commission: '1500.00' }
  ]);
});

// 用戶數據收集相關 API
app.post('/api/roles/v1/data/user/collect', authenticateToken, (req, res) => {
  res.json({ code: 200, message: '數據收集完成' });
});

app.post('/api/roles/v1/data/symbol/category', authenticateToken, (req, res) => {
  res.json([
    { category: 'stock', name: '股票', count: 150 },
    { category: 'crypto', name: '加密貨幣', count: 50 },
    { category: 'forex', name: '外匯', count: 30 }
  ]);
});

// 用戶管理 API
app.post('/api/roles/v1/user/q/list', authenticateToken, async (req, res) => {
  try {
    const { page = 1, size = 10, keyword = '', status = '' } = req.body || {};
    const offset = (page - 1) * size;
    
    let whereClause = 'WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    
    if (keyword) {
      whereClause += ` AND (username ILIKE $${paramIndex} OR email ILIKE $${paramIndex})`;
      params.push(`%${keyword}%`);
      paramIndex++;
    }
    
    if (status) {
      whereClause += ` AND status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }
    
    // 查詢用戶列表
    const usersQuery = `
      SELECT id, username, email, status, balance, created_at, updated_at,
             COALESCE(metadata->>'realname', '') as realname,
             COALESCE(metadata->>'phone', '') as phone,
             COALESCE(metadata->>'level', 'Normal') as level,
             COALESCE(metadata->>'google_bound', 'false') as google_bound
      FROM users 
      ${whereClause} 
      ORDER BY created_at DESC 
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;
    params.push(size, offset);
    
    const countQuery = `SELECT COUNT(*) as total FROM users ${whereClause}`;
    const countParams = params.slice(0, -2); // 移除 LIMIT 和 OFFSET 參數
    
    const [usersResult, countResult] = await Promise.all([
      pool.query(usersQuery, params),
      pool.query(countQuery, countParams)
    ]);
    
    const users = usersResult.rows.map(user => ({
      id: user.id,
      username: user.username,
      email: user.email || '',
      realname: user.realname || '',
      phone: user.phone || '',
      level: user.level,
      balance: (user.balance / 100).toFixed(2), // 分轉元
      status: user.status,
      google_bound: user.google_bound === 'true',
      created_at: user.created_at,
      updated_at: user.updated_at,
      last_login: user.updated_at // 暫時使用 updated_at
    }));
    
    res.json({
      code: 200,
      message: '查詢成功',
      data: {
        list: users,
        total: parseInt(countResult.rows[0].total),
        page: parseInt(page),
        size: parseInt(size)
      }
    });
  } catch (error) {
    console.error('查詢用戶列表失敗:', error);
    res.status(500).json({
      code: 500,
      message: '查詢失敗',
      error: error.message
    });
  }
});

// 獲取單個用戶詳情
app.post('/api/roles/v1/user/get', authenticateToken, async (req, res) => {
  try {
    const { id } = req.body || {};
    
    if (!id) {
      return res.status(400).json({
        code: 400,
        message: '用戶ID不能為空'
      });
    }
    
    const userQuery = `
      SELECT id, username, email, status, balance, created_at, updated_at, metadata
      FROM users 
      WHERE id = $1
    `;
    
    const result = await pool.query(userQuery, [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        code: 404,
        message: '用戶不存在'
      });
    }
    
    const user = result.rows[0];
    const metadata = user.metadata || {};
    
    res.json({
      code: 200,
      message: '查詢成功',
      data: {
        id: user.id,
        username: user.username,
        email: user.email || '',
        realname: metadata.realname || '',
        phone: metadata.phone || '',
        level: metadata.level || 'Normal',
        balance: (user.balance / 100).toFixed(2),
        status: user.status,
        google_bound: metadata.google_bound === 'true',
        identity_verified: metadata.identity_verified === 'true',
        created_at: user.created_at,
        updated_at: user.updated_at
      }
    });
  } catch (error) {
    console.error('查詢用戶詳情失敗:', error);
    res.status(500).json({
      code: 500,
      message: '查詢失敗',
      error: error.message
    });
  }
});

// 用戶基礎信息API (管理端需要)
app.post('/api/authc/v1/user/basic', authenticateToken, async (req, res) => {
  try {
    const { partyid } = req.body || {};
    
    if (!partyid) {
      return res.status(400).json({
        code: 400,
        message: 'partyid不能為空'
      });
    }
    
    // 根據partyid查詢用戶
    const userQuery = `
      SELECT id, username, email, status, balance, created_at, updated_at, metadata
      FROM users 
      WHERE username = $1 OR id::text = $1
    `;
    
    const result = await pool.query(userQuery, [partyid]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        code: 404,
        message: '用戶不存在'
      });
    }
    
    const user = result.rows[0];
    const metadata = user.metadata || {};
    
    res.json({
      code: 200,
      message: '查詢成功',
      uid: user.id.toString(),
      username: user.username,
      email: user.email || '',
      father_username: 'root', // 演示數據
      role: 'user',
      kyc: metadata.identity_verified === 'true' ? 2 : 0,
      limit: metadata.withdraw_limit || '0',
      enabled: user.status === 'active',
      withdauth: user.status === 'active',
      locked: user.status !== 'active',
      created: user.created_at,
      lastlogin: user.updated_at,
      remarks: metadata.remarks || '無備註'
    });
  } catch (error) {
    console.error('查詢用戶基礎信息失敗:', error);
    res.status(500).json({
      code: 500,
      message: '查詢失敗',
      error: error.message
    });
  }
});

// 用戶資金信息API (管理端需要)
app.post('/api/authc/v1/user/funds', authenticateToken, async (req, res) => {
  try {
    const { partyid, start_time, end_time } = req.body || {};
    
    if (!partyid) {
      return res.status(400).json({
        code: 400,
        message: 'partyid不能為空'
      });
    }
    
    // 查詢用戶
    const userQuery = `
      SELECT id, username, balance
      FROM users 
      WHERE username = $1 OR id::text = $1
    `;
    
    const userResult = await pool.query(userQuery, [partyid]);
    
    if (userResult.rows.length === 0) {
      return res.status(404).json({
        code: 404,
        message: '用戶不存在'
      });
    }
    
    const user = userResult.rows[0];
    
    // 演示資金數據結構
    res.json({
      code: 200,
      message: '查詢成功',
      deposit: '1000.00',
      withdraw: '200.00',
      money: (user.balance / 100).toFixed(2),
      forex: [{ name: 'USD', currency: 'USD', amount: '0.00' }],
      futures: [{ name: 'USDT', currency: 'USDT', amount: '0.00' }],
      stock: [{ name: 'USD', currency: 'USD', amount: '0.00' }],
      blocktrade: [{ name: 'USDT', currency: 'USDT', amount: '0.00' }],
      wallet: [
        { name: 'USDT', currency: 'USDT', amount: (user.balance / 100).toFixed(2) },
        { name: 'USD', currency: 'USD', amount: '0.00' },
        { name: 'CNY', currency: 'CNY', amount: '0.00' }
      ]
    });
  } catch (error) {
    console.error('查詢用戶資金信息失敗:', error);
    res.status(500).json({
      code: 500,
      message: '查詢失敗',
      error: error.message
    });
  }
});

// Google 驗證器相關 API
app.post('/api/authc/v1/auth/google/get', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    
    // 查詢用戶是否已綁定 Google 驗證器
    const userQuery = `
      SELECT metadata
      FROM users 
      WHERE id = $1
    `;
    
    const result = await pool.query(userQuery, [userId]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        code: 404,
        message: '用戶不存在'
      });
    }
    
    const user = result.rows[0];
    const metadata = user.metadata || {};
    
    // 如果已經綁定，返回提示
    if (metadata.google_bound === 'true') {
      return res.json({
        code: 200,
        message: '已綁定Google驗證器',
        googlebind: true
      });
    }
    
    // 生成 Google 驗證器密鑰（演示用）
    const googleSecret = 'DEMO' + Math.random().toString(36).substring(2, 18).toUpperCase();
    const qrCodeUrl = `otpauth://totp/AmpliFy:${user.username || userId}?secret=${googleSecret}&issuer=AmpliFy`;
    
    res.json({
      code: 200,
      message: '獲取成功',
      googlesecret: googleSecret,
      googlesecretqr: qrCodeUrl,
      googlebind: false
    });
  } catch (error) {
    console.error('獲取Google驗證器信息失敗:', error);
    res.status(500).json({
      code: 500,
      message: '獲取失敗',
      error: error.message
    });
  }
});

app.post('/api/authc/v1/auth/google/bind', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { googlesecret, googlecode } = req.body || {};
    
    if (!googlesecret || !googlecode) {
      return res.status(400).json({
        code: 400,
        message: '參數不完整'
      });
    }
    
    // 簡單驗證（生產環境應該用真實的 TOTP 驗證）
    if (googlecode.length !== 6 || !/^\d{6}$/.test(googlecode)) {
      return res.status(400).json({
        code: 400,
        message: '驗證碼格式錯誤'
      });
    }
    
    // 更新用戶元數據
    const updateQuery = `
      UPDATE users 
      SET metadata = jsonb_set(
        COALESCE(metadata, '{}'), 
        '{google_bound}', 
        '"true"'
      ),
      updated_at = now()
      WHERE id = $1
    `;
    
    await pool.query(updateQuery, [userId]);
    
    res.json({
      code: 200,
      message: '綁定成功'
    });
  } catch (error) {
    console.error('綁定Google驗證器失敗:', error);
    res.status(500).json({
      code: 500,
      message: '綁定失敗',
      error: error.message
    });
  }
});

// 業務相關 API
app.post('/api/roles/v1/business/player/list', authenticateToken, (req, res) => {
  res.json([
    { id: 1, username: 'player001', level: 'VIP', balance: '5000.00', status: 'active' },
    { id: 2, username: 'player002', level: 'Normal', balance: '1000.00', status: 'active' }
  ]);
});

app.post('/api/roles/v1/business/player/get', authenticateToken, (req, res) => {
  const { id } = req.body || {};
  res.json({
    id: id || 1,
    username: 'player001',
    level: 'VIP',
    balance: '5000.00',
    status: 'active',
    created_at: '2024-01-01',
    last_login: '2024-01-15'
  });
});

// IPO 相關 API
app.post('/api/roles/v1/ipo/list', authenticateToken, (req, res) => {
  res.json([
    { id: 1, symbol: 'TEST.IPO', name: '測試 IPO', price: '10.00', status: 'active', start_date: '2024-02-01' }
  ]);
});

app.post('/api/roles/v1/ipo/config/list', authenticateToken, (req, res) => {
  res.json([
    { id: 1, symbol: 'TEST.IPO', allocation_rate: '0.1', min_amount: '1000', max_amount: '100000' }
  ]);
});

// 客服相關 API
app.post('/api/roles/v1/service/user/list', authenticateToken, (req, res) => {
  res.json([
    { id: 1, username: 'user001', last_message: '需要幫助', unread_count: 2, status: 'online' },
    { id: 2, username: 'user002', last_message: '交易問題', unread_count: 0, status: 'offline' }
  ]);
});

app.post('/api/roles/v1/service/message/list', authenticateToken, (req, res) => {
  const { user_id } = req.body || {};
  res.json([
    { id: 1, user_id: user_id || 1, content: '您好，有什麼可以幫助您的？', type: 'text', from: 'support', timestamp: Date.now() - 3600000 },
    { id: 2, user_id: user_id || 1, content: '我需要幫助處理訂單', type: 'text', from: 'user', timestamp: Date.now() - 1800000 }
  ]);
});

// C2C 匯率查詢
app.post('/api/anon/v1/c2c/rate', (req, res) => {
  const { crypto = 'USDT', currency = 'TWD' } = req.body || {};
  
  // 模擬匯率
  const rate = 31.5 + (Math.random() - 0.5) * 1;
  res.json({
    code: 200,
    data: {
      crypto,
      currency,
      rate: rate.toFixed(2),
      updated_at: new Date().toISOString()
    }
  });
});

// C2C 我的訂單
app.post('/api/authc/v1/c2c/order/list', authenticateToken, (req, res) => {
  const { status = 'all' } = req.body || {};
  
  // 模擬訂單列表
  const orders = Array.from({ length: 5 }).map((_, i) => ({
    id: `ORD${Date.now() - i * 86400000}`,
    type: i % 2 === 0 ? 'buy' : 'sell',
    crypto: 'USDT',
    currency: 'TWD',
    amount: 1000 + Math.random() * 10000,
    price: 31.5 + Math.random() * 1,
    status: ['pending', 'completed', 'cancelled'][i % 3],
    created_at: new Date(Date.now() - i * 86400000).toISOString()
  }));
  
  res.json({ code: 200, data: orders });
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
    // 返回演示用戶數據 - 所有用戶都設為未上傳資料狀態
    const demoUsers = [
      { id: 1, username: 'demo_user', email: 'demo@example.com', partyid: 'DEMO001', role: 'user', kyc: 0, kyc_status: 'none', uid: '100001', father_username: 'root', limit: '0', lastlogin: '2024-01-15 10:30:00', remarks: '演示用戶', wallet: '1000.00', status: 'active', created_at: '2024-01-01 00:00:00' },
      { id: 2, username: 'test_user', email: 'test@example.com', partyid: 'TEST001', role: 'user', kyc: 0, kyc_status: 'none', uid: '100002', father_username: 'root', limit: '0', lastlogin: '2024-01-15 11:30:00', remarks: '測試用戶', wallet: '500.00', status: 'active', created_at: '2024-01-01 00:00:00' },
      { id: 3, username: 'guest_001', email: 'guest001@example.com', partyid: 'GUEST001', role: 'guest', kyc: 0, kyc_status: 'none', uid: '100003', father_username: 'root', limit: '0', lastlogin: '2024-01-15 12:30:00', remarks: '模擬用戶1', wallet: '10000.00', status: 'active', created_at: '2024-01-01 00:00:00' },
      { id: 4, username: 'guest_002', email: 'guest002@example.com', partyid: 'GUEST002', role: 'guest', kyc: 0, kyc_status: 'none', uid: '100004', father_username: 'root', limit: '0', lastlogin: '2024-01-15 13:30:00', remarks: '模擬用戶2', wallet: '5000.00', status: 'active', created_at: '2024-01-01 00:00:00' }
    ];
    return ok(demoUsers);
  }
  // 代理列表與新增
  if (/\/roles\/v1\/agent\/q\/list$/.test(p)) {
    const list = memoryStore.agents || (memoryStore.agents = []);
    return ok(list);
  }
  if (/\/roles\/v1\/agent\/m\/add$/.test(p)) {
    const { username, email, phone, remarks } = req.body || {};
    memoryStore.agents = memoryStore.agents || [];
    const id = memoryStore.agents.length ? (memoryStore.agents[memoryStore.agents.length-1].id + 1) : 1;
    const agent = { id, username: username || ('agent'+id), email: email||'', phone: phone||'', remarks: remarks||'', created_at: new Date().toISOString() };
    memoryStore.agents.push(agent);
    return okMsg('新增成功');
  }
  if (/\/roles\/v1\/agent\/m\/update$/.test(p)) return okMsg('更新成功');
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
    const { country, symbol } = req.body || {};
    
    // 複用股票數據結構
    const stocksByCountry = {
      us: [
        { id: 1, symbol: 'AAPL', name: 'Apple Inc.', market: 'NASDAQ', country: 'us', enabled: 1 },
        { id: 2, symbol: 'GOOGL', name: 'Alphabet Inc.', market: 'NASDAQ', country: 'us', enabled: 1 },
        { id: 3, symbol: 'TSLA', name: 'Tesla Inc.', market: 'NASDAQ', country: 'us', enabled: 1 },
        { id: 4, symbol: 'MSFT', name: 'Microsoft Corp.', market: 'NASDAQ', country: 'us', enabled: 1 },
        { id: 5, symbol: 'AMZN', name: 'Amazon.com Inc.', market: 'NASDAQ', country: 'us', enabled: 1 },
        { id: 6, symbol: 'NVDA', name: 'NVIDIA Corp.', market: 'NASDAQ', country: 'us', enabled: 1 },
        { id: 7, symbol: 'META', name: 'Meta Platforms Inc.', market: 'NASDAQ', country: 'us', enabled: 1 },
        { id: 8, symbol: 'JPM', name: 'JPMorgan Chase & Co.', market: 'NYSE', country: 'us', enabled: 1 }
      ],
      japan: [
        { id: 9, symbol: '7203.T', name: 'Toyota Motor Corp.', market: 'TSE', country: 'japan', enabled: 1 },
        { id: 10, symbol: '6758.T', name: 'Sony Group Corp.', market: 'TSE', country: 'japan', enabled: 1 },
        { id: 11, symbol: '9984.T', name: 'SoftBank Group Corp.', market: 'TSE', country: 'japan', enabled: 1 },
        { id: 12, symbol: '8306.T', name: 'Mitsubishi UFJ Financial Group', market: 'TSE', country: 'japan', enabled: 1 }
      ],
      china: [
        { id: 13, symbol: '000001.SZ', name: '平安银行', market: 'SZSE', country: 'china', enabled: 1 },
        { id: 14, symbol: '600519.SS', name: '贵州茅台', market: 'SSE', country: 'china', enabled: 1 },
        { id: 15, symbol: '000858.SZ', name: '五粮液', market: 'SZSE', country: 'china', enabled: 1 },
        { id: 16, symbol: '000002.SZ', name: '万科A', market: 'SZSE', country: 'china', enabled: 1 }
      ],
      hongkong: [
        { id: 17, symbol: '0700.HK', name: '腾讯控股', market: 'HKEX', country: 'hongkong', enabled: 1 },
        { id: 18, symbol: '9988.HK', name: '阿里巴巴-SW', market: 'HKEX', country: 'hongkong', enabled: 1 },
        { id: 19, symbol: '0941.HK', name: '中国移动', market: 'HKEX', country: 'hongkong', enabled: 1 },
        { id: 20, symbol: '0005.HK', name: '汇丰控股', market: 'HKEX', country: 'hongkong', enabled: 1 }
      ],
      taiwan: [
        { id: 21, symbol: '2330.TW', name: '台积电', market: 'TWSE', country: 'taiwan', enabled: 1 },
        { id: 22, symbol: '2317.TW', name: '鸿海', market: 'TWSE', country: 'taiwan', enabled: 1 },
        { id: 23, symbol: '2454.TW', name: '联发科', market: 'TWSE', country: 'taiwan', enabled: 1 },
        { id: 24, symbol: '2412.TW', name: '中华电', market: 'TWSE', country: 'taiwan', enabled: 1 }
      ],
      korea: [
        { id: 25, symbol: '005930.KS', name: 'Samsung Electronics', market: 'KRX', country: 'korea', enabled: 1 },
        { id: 26, symbol: '000660.KS', name: 'SK Hynix', market: 'KRX', country: 'korea', enabled: 1 },
        { id: 27, symbol: '207940.KS', name: 'Samsung Biologics', market: 'KRX', country: 'korea', enabled: 1 }
      ],
      singapore: [
        { id: 28, symbol: 'D05.SI', name: 'DBS Group Holdings', market: 'SGX', country: 'singapore', enabled: 1 },
        { id: 29, symbol: 'O39.SI', name: 'OCBC Bank', market: 'SGX', country: 'singapore', enabled: 1 },
        { id: 30, symbol: 'U11.SI', name: 'United Overseas Bank', market: 'SGX', country: 'singapore', enabled: 1 }
      ],
      malaysia: [
        { id: 31, symbol: 'MAYBANK.KL', name: 'Malayan Banking Berhad', market: 'KLSE', country: 'malaysia', enabled: 1 },
        { id: 32, symbol: 'CIMB.KL', name: 'CIMB Group Holdings', market: 'KLSE', country: 'malaysia', enabled: 1 }
      ],
      thailand: [
        { id: 33, symbol: 'PTT.BK', name: 'PTT Public Company Limited', market: 'SET', country: 'thailand', enabled: 1 },
        { id: 34, symbol: 'CPALL.BK', name: 'CP ALL Public Company Limited', market: 'SET', country: 'thailand', enabled: 1 }
      ],
      philippines: [
        { id: 35, symbol: 'BDO.PS', name: 'BDO Unibank Inc.', market: 'PSE', country: 'philippines', enabled: 1 },
        { id: 36, symbol: 'SM.PS', name: 'SM Investments Corporation', market: 'PSE', country: 'philippines', enabled: 1 }
      ],
      indonesia: [
        { id: 37, symbol: 'BBCA.JK', name: 'Bank Central Asia Tbk PT', market: 'IDX', country: 'indonesia', enabled: 1 },
        { id: 38, symbol: 'BBRI.JK', name: 'Bank Rakyat Indonesia Tbk PT', market: 'IDX', country: 'indonesia', enabled: 1 }
      ],
      vietnam: [
        { id: 39, symbol: 'VCB.VN', name: 'Joint Stock Commercial Bank for Foreign Trade of Vietnam', market: 'HOSE', country: 'vietnam', enabled: 1 },
        { id: 40, symbol: 'VIC.VN', name: 'Vingroup Joint Stock Company', market: 'HOSE', country: 'vietnam', enabled: 1 }
      ],
      india: [
        { id: 41, symbol: 'RELIANCE.NS', name: 'Reliance Industries Limited', market: 'NSE', country: 'india', enabled: 1 },
        { id: 42, symbol: 'TCS.NS', name: 'Tata Consultancy Services Limited', market: 'NSE', country: 'india', enabled: 1 }
      ],
      uk: [
        { id: 43, symbol: 'LLOY.L', name: 'Lloyds Banking Group plc', market: 'LSE', country: 'uk', enabled: 1 },
        { id: 44, symbol: 'HSBA.L', name: 'HSBC Holdings plc', market: 'LSE', country: 'uk', enabled: 1 }
      ],
      germany: [
        { id: 45, symbol: 'SAP.DE', name: 'SAP SE', market: 'XETRA', country: 'germany', enabled: 1 },
        { id: 46, symbol: 'SIE.DE', name: 'Siemens AG', market: 'XETRA', country: 'germany', enabled: 1 }
      ],
      australia: [
        { id: 47, symbol: 'CBA.AX', name: 'Commonwealth Bank of Australia', market: 'ASX', country: 'australia', enabled: 1 },
        { id: 48, symbol: 'BHP.AX', name: 'BHP Group Limited', market: 'ASX', country: 'australia', enabled: 1 }
      ],
      canada: [
        { id: 49, symbol: 'SHOP.TO', name: 'Shopify Inc.', market: 'TSX', country: 'canada', enabled: 1 },
        { id: 50, symbol: 'RY.TO', name: 'Royal Bank of Canada', market: 'TSX', country: 'canada', enabled: 1 }
      ]
    };
    
    // 合併或篩選股票
    let allStocks = [];
    if (country && country !== 'all' && stocksByCountry[country]) {
      allStocks = stocksByCountry[country];
    } else {
      for (const countryKey in stocksByCountry) {
        allStocks = allStocks.concat(stocksByCountry[countryKey]);
      }
    }
    
    // 根據股票代碼或名稱篩選
    if (symbol) {
      allStocks = allStocks.filter(stock => 
        stock.symbol.toLowerCase().includes(symbol.toLowerCase()) ||
        stock.name.toLowerCase().includes(symbol.toLowerCase())
      );
    }
    
    return ok(allStocks);
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
    // 返回演示用戶數據 - 所有用戶都設為未上傳資料狀態
    const demoUsers = [
      { id: 1, username: 'demo_user', email: 'demo@example.com', partyid: 'DEMO001', role: 'user', kyc: 0, kyc_status: 'none', uid: '100001', father_username: 'root', limit: '0', lastlogin: '2024-01-15 10:30:00', remarks: '演示用戶', wallet: '1000.00', status: 'active', created_at: '2024-01-01 00:00:00' },
      { id: 2, username: 'test_user', email: 'test@example.com', partyid: 'TEST001', role: 'user', kyc: 0, kyc_status: 'none', uid: '100002', father_username: 'root', limit: '0', lastlogin: '2024-01-15 11:30:00', remarks: '測試用戶', wallet: '500.00', status: 'active', created_at: '2024-01-01 00:00:00' }
    ];
    return ok(demoUsers);
  }
  if (/\/roles\/v1\/data\/(user|my)\/currency$/.test(p)) {
    return ok([{ currency: 'USDT', total: 0 }]);
  }
  if (/\/roles\/v1\/data\/(my)\/(total|list)$/.test(p)) {
    return ok([]);
  }
  
  // 概覽頁面 API
  if (/\/roles\/v1\/data\/global\/total$/.test(p)) {
    // 返回平台總體數據
    return ok({
      deposit: '1,234,567.89',
      withdraw: '987,654.32',
      balance: '246,913.57'
    });
  }
  
  if (/\/roles\/v1\/data\/global\/total\/currency$/.test(p)) {
    // 返回各幣種詳細數據
    return ok([
      { currency: 'USDT', deposit: '800000.00', withdraw: '600000.00', balance: '200000.00', deposit_usdt: '800000.00', withdraw_usdt: '600000.00', deposit_ratio: 65, withdraw_ratio: 60 },
      { currency: 'BTC', deposit: '50.5', withdraw: '35.2', balance: '15.3', deposit_usdt: '300000.00', withdraw_usdt: '250000.00', deposit_ratio: 25, withdraw_ratio: 25 },
      { currency: 'ETH', deposit: '200.8', withdraw: '180.5', balance: '20.3', deposit_usdt: '134567.89', withdraw_usdt: '137654.32', deposit_ratio: 10, withdraw_ratio: 15 }
    ]);
  }
  
  // C2C 廣告管理
  if (/\/roles\/v1\/c2c\/ad\/list$/.test(p)) {
    const { page = 1, offset, crypto, currency } = req.body || {};
    // 返回演示廣告數據
    const ads = [
      { id: 1, merchant_id: 1, merchant_name: 'Merchant_A', offset: 'buy', crypto: 'USDT', currency: 'CNY', price: 7.20, limitmin: 100, limitmax: 50000, status: 'active', created_at: '2024-01-15 10:00:00' },
      { id: 2, merchant_id: 2, merchant_name: 'Merchant_B', offset: 'sell', crypto: 'USDT', currency: 'CNY', price: 7.25, limitmin: 200, limitmax: 100000, status: 'active', created_at: '2024-01-15 11:00:00' },
      { id: 3, merchant_id: 1, merchant_name: 'Merchant_A', offset: 'buy', crypto: 'BTC', currency: 'CNY', price: 480000, limitmin: 1000, limitmax: 500000, status: 'active', created_at: '2024-01-15 12:00:00' }
    ];
    
    let filteredAds = ads;
    if (offset && offset !== 'all') {
      filteredAds = filteredAds.filter(ad => ad.offset === offset);
    }
    if (crypto && crypto !== 'all') {
      filteredAds = filteredAds.filter(ad => ad.crypto === crypto);
    }
    if (currency && currency !== 'all') {
      filteredAds = filteredAds.filter(ad => ad.currency === currency);
    }
    
    return ok(filteredAds);
  }
  
  if (/\/roles\/v1\/c2c\/ad\/add$/.test(p)) {
    const { merchant_id, offset, crypto, currency, price, limitmin, limitmax } = req.body || {};
    // 模擬新增廣告
    const newAd = {
      id: Date.now(),
      merchant_id,
      offset,
      crypto,
      currency,
      price,
      limitmin,
      limitmax,
      status: 'active',
      created_at: new Date().toISOString().substring(0, 19).replace('T', ' ')
    };
    return ok(newAd);
  }
  
  if (/\/roles\/v1\/c2c\/ad\/update$/.test(p)) {
    const { id, merchant_id, offset, crypto, currency, price, limitmin, limitmax } = req.body || {};
    // 模擬更新廣告
    return ok({ id, merchant_id, offset, crypto, currency, price, limitmin, limitmax });
  }
  
  if (/\/roles\/v1\/c2c\/ad\/del$/.test(p)) {
    const { id } = req.body || {};
    return ok({ id });
  }
  
  if (/\/roles\/v1\/c2c\/ad\/get$/.test(p)) {
    const { id } = req.body || {};
    // 返回單個廣告詳情
    const ad = { id, merchant_id: 1, offset: 'buy', crypto: 'USDT', currency: 'CNY', price: 7.20, limitmin: 100, limitmax: 50000 };
    return ok(ad);
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
    // 兼容前端期望: 返回陣列 [{id,label,auth}]
    return ok([
      { id: 1, label: 'dashboard', auth: true },
      { id: 2, label: 'users', auth: false },
      { id: 3, label: 'orders', auth: false },
      { id: 4, label: 'finance', auth: false },
      { id: 5, label: 'system', auth: true },
      { id: 6, label: 'service', auth: false },
      { id: 7, label: 'market', auth: false },
      { id: 8, label: 'c2c', auth: false },
      { id: 9, label: 'ipo', auth: false },
      { id: 10, label: 'contract', auth: false },
      { id: 11, label: 'crypto', auth: false },
      { id: 12, label: 'blocktrade', auth: false }
    ]);
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

// 客服聊天 WebSocket (Socket.IO Namespace)
const supportNamespace = io.of('/support');
supportNamespace.on('connection', (socket) => {
  console.log('Support client connected:', socket.id);
  
  const { auth, nologinid } = socket.handshake.query;
  let userId = 'guest_' + (nologinid || socket.id);
  
  if (auth) {
    try {
      const decoded = jwt.verify(auth, JWT_SECRET);
      userId = 'user_' + decoded.userId;
    } catch (err) {
      console.log('Invalid auth token in support chat');
    }
  }
  
  socket.userId = userId;
  socket.join(userId); // 加入個人房間
  
  // 發送歷史消息（模擬）
  socket.emit('receive', {
    data: [
      {
        id: Date.now().toString(),
        content: '您好！歡迎使用客服服務，有什麼可以幫助您的嗎？',
        type: 'text',
        from: 'support',
        timestamp: Date.now()
      }
    ]
  });
  
  // 接收用戶消息
  socket.on('send', (message) => {
    console.log('Received message from', userId, ':', message);
    
    // 廣播給該用戶（模擬客服回覆）
    setTimeout(() => {
      socket.emit('receive', {
        data: [
          {
            id: (Date.now() + 1000).toString(),
            content: '感謝您的消息，我們的客服人員會盡快回覆您。',
            type: 'text',
            from: 'support',
            timestamp: Date.now() + 1000
          }
        ]
      });
    }, 1000);
  });
  
  socket.on('disconnect', () => {
    console.log('Support client disconnected:', socket.id);
  });
});

// 客服聊天 WebSocket (liveSupport Namespace for Admin)
const liveSupportNamespace = io.of('/liveSupport');
liveSupportNamespace.on('connection', (socket) => {
  console.log('LiveSupport client connected:', socket.id);
  
  const { auth } = socket.handshake.query;
  let userId = 'admin_' + socket.id;
  
  if (auth) {
    try {
      const decoded = jwt.verify(auth, JWT_SECRET);
      userId = 'admin_' + decoded.userId;
    } catch (err) {
      console.log('Invalid auth token in liveSupport');
    }
  }
  
  socket.userId = userId;
  
  // 發送歡迎消息 - 確保 data 是數組格式
  socket.emit('receive', {
    data: [
      {
        id: Date.now().toString(),
        content: '管理端客服系統已連接',
        type: 'text',
        from: 'system',
        timestamp: Date.now()
      }
    ]
  });
  
  socket.on('send', (message) => {
    console.log('LiveSupport received message from', userId, ':', message);
    
    // 確保回覆的 data 也是數組格式
    setTimeout(() => {
      socket.emit('receive', {
        data: [
          {
            id: (Date.now() + 1000).toString(),
            content: '管理端消息已收到',
            type: 'text',
            from: 'system',
            timestamp: Date.now() + 1000
          }
        ]
      });
    }, 500);
  });
  
  socket.on('disconnect', () => {
    console.log('LiveSupport client disconnected:', socket.id);
  });
});

// Admin 主要 WebSocket 連接
const adminNamespace = io.of('/admin');
adminNamespace.on('connection', (socket) => {
  console.log('Admin main client connected:', socket.id);
  
  // 定期發送模擬數據，確保 data 都是數組格式
  const sendMockData = () => {
    // 股票訂單數據
    socket.emit('stockorder', {
      code: 200,
      data: [
        {
          order_no: 'STK' + Date.now(),
          symbol: 'AAPL',
          username: 'demo_user',
          profit: (Math.random() * 1000).toFixed(2),
          status: 'open'
        }
      ]
    });
    
    // 合約訂單數據
    socket.emit('futuresorder', {
      code: 200,
      data: [
        {
          order_no: 'FUT' + Date.now(),
          symbol: 'BTCUSDT',
          username: 'test_user',
          profit: (Math.random() * 2000).toFixed(2),
          status: 'open'
        }
      ]
    });
    
    // 實時行情數據
    socket.emit('realtime', {
      code: 200,
      data: [
        {
          symbol: 'BTCUSDT',
          price: (42000 + Math.random() * 2000).toFixed(2),
          change: ((Math.random() - 0.5) * 10).toFixed(2) + '%'
        }
      ]
    });
    
    // 合約場控數據
    socket.emit('futures_control_list', {
      code: 200,
      data: [
        {
          symbol: 'BTCUSDT',
          name: 'BTC/USDT 永續合約',
          price: (42000 + Math.random() * 2000).toFixed(2),
          volume: (Math.random() * 10000).toFixed(2)
        },
        {
          symbol: 'ETHUSDT',
          name: 'ETH/USDT 永續合約',
          price: (2400 + Math.random() * 200).toFixed(2),
          volume: (Math.random() * 50000).toFixed(2)
        }
      ]
    });
  };
  
  // 立即發送一次數據
  sendMockData();
  
  // 每10秒發送一次更新
  const interval = setInterval(sendMockData, 10000);
  
  socket.on('disconnect', () => {
    console.log('Admin main client disconnected:', socket.id);
    clearInterval(interval);
  });
});

// 通用404处理中间件 - 放在所有路由定义之后
app.use('*', (req, res) => {
  // 对API路径返回JSON格式的404响应
  if (req.originalUrl.startsWith('/anon') || req.originalUrl.startsWith('/authc') || req.originalUrl.startsWith('/api')) {
    return res.status(200).json({
      code: 404,
      message: 'API端点不存在',
      path: req.originalUrl,
      method: req.method
    });
  }
  // 对其他路径返回HTML 404
  res.status(404).send('Page Not Found');
});