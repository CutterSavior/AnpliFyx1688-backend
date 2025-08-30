const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');

const router = express.Router();

// Mock user database for G platform
const users = [
  {
    id: 1,
    username: 'admin',
    email: 'admin@example.com',
    password: '$2a$12$yUQmiUnlJ5NOifNHjIDUjO9xdwLHBF8Tkhm62Srre5yq1qXFdR/6C', // 'password'
    role: 'admin',
    status: 'active'
  },
  {
    id: 2,
    username: 'user@gmail.com',
    email: 'user@gmail.com',
    password: '$2a$12$yUQmiUnlJ5NOifNHjIDUjO9xdwLHBF8Tkhm62Srre5yq1qXFdR/6C', // 'password'
    role: 'user',
    status: 'active'
  }
];

// Generate JWT token
const generateToken = (user) => {
  return jwt.sign(
    {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRE || '24h' }
  );
};

// @route   POST /anon/v1/user/login
// @desc    G Platform User login
// @access  Public
router.post('/anon/v1/user/login', async (req, res) => {
  console.log('G Platform login attempt:', req.body);
  try {
    const { username, password } = req.body;

    // Find user
    const user = users.find(u => u.username === username || u.email === username);
    if (!user) {
      return res.json({
        code: 400,
        message: 'Invalid credentials'
      });
    }

    // Check password
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.json({
        code: 400,
        message: 'Invalid credentials'
      });
    }

    // Generate token
    const token = generateToken(user);

    res.json({
      code: 200,
      data: {
        token,
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          role: user.role
        }
      },
      message: 'Login successful'
    });
  } catch (error) {
    console.error('G Platform login error:', error);
    res.json({
      code: 500,
      message: 'Internal server error'
    });
  }
});

// @route   POST /anon/v1/market/stock/recommend
// @desc    Get stock recommendations
// @access  Public
router.post('/anon/v1/market/stock/recommend', (req, res) => {
  res.json({
    code: 200,
    data: [
      {
        symbol: 'TSLA',
        name: 'Tesla Inc.',
        price: 425.30,
        change: 8.75,
        changePercent: 2.10,
        volume: 1850000
      },
      {
        symbol: 'NVDA',
        name: 'NVIDIA Corp',
        price: 875.20,
        change: 15.40,
        changePercent: 1.79,
        volume: 2100000
      }
    ],
    message: 'Success'
  });
});

// @route   POST /anon/v1/wallet/currency
// @desc    Get supported currencies
// @access  Public
router.post('/anon/v1/wallet/currency', (req, res) => {
  res.json({
    code: 200,
    data: [
      { symbol: 'USDT', name: 'Tether USD', network: 'TRC20' },
      { symbol: 'BTC', name: 'Bitcoin', network: 'BTC' },
      { symbol: 'ETH', name: 'Ethereum', network: 'ERC20' }
    ],
    message: 'Success'
  });
});

// @route   POST /anon/v1/notice/list
// @desc    Get notice list
// @access  Public
router.post('/anon/v1/notice/list', (req, res) => {
  res.json({
    code: 200,
    data: [
      {
        id: 1,
        title: '系統維護通知',
        content: '平台將於今晚進行系統維護',
        createTime: new Date().toISOString()
      }
    ],
    message: 'Success'
  });
});

// @route   POST /anon/v1/support/list
// @desc    Get support list
// @access  Public
router.post('/anon/v1/support/list', (req, res) => {
  res.json({
    code: 200,
    data: [],
    message: 'Success'
  });
});

// @route   POST /anon/v1/comm/token
// @desc    Get communication token
// @access  Public
router.post('/anon/v1/comm/token', (req, res) => {
  res.json({
    code: 200,
    data: {
      token: 'mock-comm-token-' + Date.now()
    },
    message: 'Success'
  });
});

// @route   POST /anon/v22/contract/item
// @desc    Get contract items
// @access  Public
router.post('/anon/v22/contract/item', (req, res) => {
  res.json({
    code: 200,
    data: [
      {
        symbol: 'BTCUSDT',
        name: 'Bitcoin/USDT',
        price: 43250.50,
        change: 1250.30,
        changePercent: 2.98
      }
    ],
    message: 'Success'
  });
});

// @route   POST /anon/v1/user/emailcode
// @desc    Send email verification code
// @access  Public
router.post('/anon/v1/user/emailcode', (req, res) => {
  res.json({
    code: 200,
    data: { sent: true },
    message: 'Verification code sent'
  });
});

// @route   POST /anon/v1/user/register
// @desc    User registration
// @access  Public
router.post('/anon/v1/user/register', async (req, res) => {
  try {
    const { username, password, email } = req.body;
    res.json({
      code: 200,
      data: {
        auth: generateToken({ id: 999, username, email, role: 'user' }),
        user: { id: 999, username, email, role: 'user' }
      },
      message: 'Registration successful'
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      message: 'Registration failed'
    });
  }
});

// @route   POST /anon/v1/user/guest/register
// @desc    Guest registration
// @access  Public
router.post('/anon/v1/user/guest/register', (req, res) => {
  const guestId = 'guest_' + Date.now();
  res.json({
    code: 200,
    data: {
      auth: generateToken({ id: guestId, username: guestId, role: 'guest' }),
      user: { id: guestId, username: guestId, role: 'guest' }
    },
    message: 'Guest registration successful'
  });
});

// @route   POST /anon/v1/user/forget
// @desc    Forgot password
// @access  Public
router.post('/anon/v1/user/forget', (req, res) => {
  res.json({
    code: 200,
    data: { reset: true },
    message: 'Password reset email sent'
  });
});

// @route   POST /anon/v1/item/search
// @desc    Search items
// @access  Public
router.post('/anon/v1/item/search', (req, res) => {
  const { keyword } = req.body;
  res.json({
    code: 200,
    data: [
      {
        symbol: 'BTCUSDT',
        name: 'Bitcoin/USDT',
        price: 43250.50,
        type: 'crypto'
      }
    ].filter(item => !keyword || item.name.toLowerCase().includes(keyword.toLowerCase())),
    message: 'Success'
  });
});

// @route   POST /anon/v1/item/basic
// @desc    Get basic item info
// @access  Public
router.post('/anon/v1/item/basic', (req, res) => {
  res.json({
    code: 200,
    data: {
      symbol: 'BTCUSDT',
      name: 'Bitcoin/USDT',
      price: 43250.50,
      change: 1250.30,
      changePercent: 2.98,
      volume: 1850000,
      high24h: 44500.00,
      low24h: 42000.00
    },
    message: 'Success'
  });
});

// @route   POST /anon/v1/item/stock
// @desc    Get stock info
// @access  Public
router.post('/anon/v1/item/stock', (req, res) => {
  res.json({
    code: 200,
    data: [
      {
        symbol: 'TSLA',
        name: 'Tesla Inc.',
        price: 425.30,
        change: 8.75,
        changePercent: 2.10,
        volume: 1850000
      }
    ],
    message: 'Success'
  });
});

// @route   POST /anon/v1/item/stock/profile
// @desc    Get stock profile
// @access  Public
router.post('/anon/v1/item/stock/profile', (req, res) => {
  res.json({
    code: 200,
    data: {
      symbol: 'TSLA',
      name: 'Tesla Inc.',
      description: 'Electric vehicle manufacturer',
      sector: 'Technology',
      marketCap: 800000000000,
      employees: 100000
    },
    message: 'Success'
  });
});

// @route   GET /anon/v1/ticker/kline
// @desc    Get kline data
// @access  Public
router.get('/anon/v1/ticker/kline', (req, res) => {
  const { symbol, period, page } = req.query;
  res.json({
    code: 200,
    data: Array.from({ length: 100 }, (_, i) => ({
      time: Date.now() - i * 60000,
      open: 43000 + Math.random() * 1000,
      high: 43500 + Math.random() * 1000,
      low: 42500 + Math.random() * 1000,
      close: 43250 + Math.random() * 1000,
      volume: 1000 + Math.random() * 500
    })),
    message: 'Success'
  });
});

// @route   GET /anon/v1/ticker/time
// @desc    Get ticker time
// @access  Public
router.get('/anon/v1/ticker/time', (req, res) => {
  res.json({
    code: 200,
    data: {
      serverTime: Date.now(),
      timezone: 'UTC'
    },
    message: 'Success'
  });
});

// @route   POST /anon/v1/market/get
// @desc    Get market data
// @access  Public
router.post('/anon/v1/market/get', (req, res) => {
  res.json({
    code: 200,
    data: {
      markets: [
        {
          symbol: 'BTCUSDT',
          price: 43250.50,
          change: 1250.30,
          volume: 1850000
        }
      ]
    },
    message: 'Success'
  });
});

// @route   POST /anon/v21/market/stock/rankinglist
// @desc    Get stock ranking list
// @access  Public
router.post('/anon/v21/market/stock/rankinglist', (req, res) => {
  res.json({
    code: 200,
    data: [
      {
        symbol: 'TSLA',
        name: 'Tesla Inc.',
        price: 425.30,
        change: 8.75,
        changePercent: 2.10,
        rank: 1
      },
      {
        symbol: 'NVDA',
        name: 'NVIDIA Corp',
        price: 875.20,
        change: 15.40,
        changePercent: 1.79,
        rank: 2
      }
    ],
    message: 'Success'
  });
});

// @route   POST /anon/v1/stock/para
// @desc    Get stock parameters
// @access  Public
router.post('/anon/v1/stock/para', (req, res) => {
  res.json({
    code: 200,
    data: {
      minAmount: 100,
      maxAmount: 1000000,
      leverage: {
        min: 1,
        max: 100
      },
      fees: {
        maker: 0.001,
        taker: 0.001
      }
    },
    message: 'Success'
  });
});

// @route   POST /anon/v1/market/news
// @desc    Get market news
// @access  Public
router.post('/anon/v1/market/news', (req, res) => {
  res.json({
    code: 200,
    data: [
      {
        id: 1,
        title: 'Bitcoin breaks new high',
        content: 'Bitcoin reached a new all-time high today...',
        publishTime: new Date().toISOString(),
        source: 'CryptoNews'
      }
    ],
    message: 'Success'
  });
});

module.exports = router;
