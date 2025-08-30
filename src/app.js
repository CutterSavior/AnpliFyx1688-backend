const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const http = require('http');
const socketIo = require('socket.io');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

// Import routes
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const tradingRoutes = require('./routes/trading');
const orderRoutes = require('./routes/orders');
const walletRoutes = require('./routes/wallet');
const marketRoutes = require('./routes/market');
const adminRoutes = require('./routes/admin');
const systemRoutes = require('./routes/system');
const gameRoutes = require('./routes/game');

// Import middleware
const errorHandler = require('./middleware/errorHandler');
const { authenticateToken } = require('./middleware/auth');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: process.env.FRONTEND_URLS?.split(',') || ['http://localhost:3000', 'http://localhost:8080'],
    methods: ['GET', 'POST']
  },
  // 前端舊版 engine.io 參數（EIO=3）相容
  allowEIO3: true
});

// Security middleware
app.use(helmet());
app.use(compression());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.'
});
app.use('/api/', limiter);

// CORS configuration
app.use(cors({
  origin: process.env.FRONTEND_URLS?.split(',') || ['http://localhost:3000', 'http://localhost:8080'],
  credentials: true
}));

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Logging
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', authenticateToken, userRoutes);
app.use('/api/trading', authenticateToken, tradingRoutes);
app.use('/api/orders', authenticateToken, orderRoutes);
app.use('/api/wallet', authenticateToken, walletRoutes);
app.use('/api/market', marketRoutes); // Market data can be public
app.use('/api', marketRoutes); // Additional market routes without /market prefix
app.use('/api/admin', authenticateToken, adminRoutes);
app.use('/api/system', authenticateToken, systemRoutes);
app.use('/api', gameRoutes); // G Platform specific routes

// ---------------- Temporary stub endpoints for G initial requests ----------------
// 先回空資料避免 404；後續會替換成實際實作
app.post('/api/anon/v1/wallet/currency', (req, res) => {
  res.json({ code: 200, data: [], message: 'ok' });
});
// 通知列表
app.post('/api/anon/v1/notice/list', (req, res) => {
  res.json({ code: 200, data: [], message: 'ok' });
});
// 客服列表
app.post('/api/anon/v1/support/list', (req, res) => {
  res.json({ code: 200, data: [], message: 'ok' });
});
// Session token 產生
app.post('/api/anon/v1/comm/token', (req, res) => {
  res.json({ code: 200, data: { token: 'guest-' + Date.now() }, message: 'ok' });
});
// 合約商品列表 (v22)
app.post('/api/anon/v22/contract/item', (req, res) => {
  res.json({ code: 200, data: [], message: 'ok' });
});
// 圖形驗證碼 (blob)
app.get('/api/anon/v1/comm/verifcode', (req, res) => {
  res.type('png');
  res.send(Buffer.alloc(0));
});
app.post('/api/anon/v1/support/list', (req, res) => {
  res.json({ code: 200, data: [], message: 'ok' });
});

// ---------------- Temporary stub endpoints for A (Admin) dashboard ----------------
// Admin dashboard requests: 
//  - POST /api/roles/v1/data/global/total
//  - POST /api/roles/v1/data/global/total/currency
// Return a simple structure the frontend expects to render overview cards
app.post('/api/roles/v1/data/global/total', (req, res) => {
  res.json({
    code: 200,
    data: {
      deposit: '0',
      withdraw: '0',
      balance: '0'
    },
    message: 'ok'
  });
});

app.post('/api/roles/v1/data/global/total/currency', (req, res) => {
  res.json({
    code: 200,
    data: [
      { currency: 'USDT', deposit: 0, withdraw: 0, balance: 0, deposit_usdt: 0, withdraw_usdt: 0, deposit_ratio: 0, withdraw_ratio: 0 },
      { currency: 'BTC',  deposit: 0, withdraw: 0, balance: 0, deposit_usdt: 0, withdraw_usdt: 0, deposit_ratio: 0, withdraw_ratio: 0 },
      { currency: 'ETH',  deposit: 0, withdraw: 0, balance: 0, deposit_usdt: 0, withdraw_usdt: 0, deposit_ratio: 0, withdraw_ratio: 0 }
    ],
    message: 'ok'
  });
});

// A 平台加載幣種清單（帶認證路徑前綴），回傳空資料即可避免 404
app.post('/api/authc/v1/wallet/currency', (req, res) => {
  res.json({
    code: 200,
    data: [
      { symbol: 'USDT', name: 'Tether USD', network: 'TRC20' },
      { symbol: 'BTC', name: 'Bitcoin', network: 'BTC' },
      { symbol: 'ETH', name: 'Ethereum', network: 'ERC20' }
    ],
    message: 'ok'
  });
});

// login (G 舊路徑別名) - 暫時成功回應
app.post('/api/anon/v1/user/login', (req, res) => {
  const token = 'mock-token-' + Date.now();
  res.json({
    code: 200,
    data: {
      token,
      auth: token,
      refreshToken: token
    },
    message: 'ok'
  });
});

// register (G 舊路徑別名) - 暫時成功回應（僅示範）
app.post('/api/anon/v1/user/register', (req, res) => {
  const token = 'mock-token-' + Date.now();
  res.json({
    code: 200,
    data: {
      token,
      refreshToken: token,
      user: {
        id: Date.now(),
        username: req.body?.username || 'user',
        email: req.body?.email || 'user@example.com',
        role: 'user'
      }
    },
    message: 'ok'
  });
});

// Compatibility endpoint for Admin permission matcher
app.post('/api/authc/v1/security/matcher', authenticateToken, (req, res) => {
  try {
    const role = req.user?.role || 'admin';
    res.json({
      code: 200,
      data: {
        roles: [role],
        permissions: [
          'dashboard:view',
          'users:view',
          'orders:view',
          'wallet:view',
          'system:view'
        ]
      },
      message: 'ok'
    });
  } catch (e) {
    res.status(500).json({ code: 500, message: 'matcher error' });
  }
});

// WebSocket connection handling
io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);

  // Join market data room
  socket.on('join-market', (symbol) => {
    socket.join(`market-${symbol}`);
    console.log(`Client ${socket.id} joined market room: ${symbol}`);
  });

  // Join user specific room
  socket.on('join-user', (userId) => {
    socket.join(`user-${userId}`);
    console.log(`Client ${socket.id} joined user room: ${userId}`);
  });

  // Handle order updates
  socket.on('subscribe-orders', (userId) => {
    socket.join(`orders-${userId}`);
  });

  // Handle market data subscriptions
  socket.on('subscribe-ticker', (symbols) => {
    symbols.forEach(symbol => {
      socket.join(`ticker-${symbol}`);
    });
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Store io instance globally for use in other modules
global.io = io;

// Error handling middleware (must be last)
app.use(errorHandler);

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    message: 'API endpoint not found'
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`
🚀 Trading Platform Backend Server Started
📡 Port: ${PORT}
🌍 Environment: ${process.env.NODE_ENV || 'development'}
🔗 API Base URL: http://localhost:${PORT}/api
📊 Health Check: http://localhost:${PORT}/health
  `);
});

module.exports = app;
