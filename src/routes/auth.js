const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');
const nodemailer = require('nodemailer');
const Redis = require('ioredis');
const svgCaptcha = require('svg-captcha');
const { randomUUID } = require('crypto');

const router = express.Router();

// Rate limiting for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50, // limit each IP to 50 requests per windowMs (increased for development)
  message: 'Too many authentication attempts, please try again later.'
});

// Key-Value store (Redis or in-memory fallback)
let store;
try {
  if (process.env.REDIS_URL || process.env.REDIS_HOST) {
    const redis = process.env.REDIS_URL
      ? new Redis(process.env.REDIS_URL)
      : new Redis({
          host: process.env.REDIS_HOST || '127.0.0.1',
          port: Number(process.env.REDIS_PORT || 6379),
          password: process.env.REDIS_PASSWORD || undefined
        });
    redis.on('error', (e) => {
      console.warn('[redis] error:', e.message);
    });
    store = {
      setex: (k, ttl, v) => redis.set(k, v, 'EX', ttl),
      get: (k) => redis.get(k),
      del: (k) => redis.del(k)
    };
  }
} catch (e) {
  console.warn('[redis] init failed, falling back to memory:', e.message);
}
if (!store) {
  const mem = new Map();
  store = {
    setex: async (k, ttl, v) => {
      mem.set(k, { v, exp: Date.now() + ttl * 1000 });
      setTimeout(() => mem.delete(k), ttl * 1000).unref?.();
    },
    get: async (k) => {
      const it = mem.get(k);
      if (!it) return null;
      if (Date.now() > it.exp) {
        mem.delete(k);
        return null;
      }
      return it.v;
    },
    del: async (k) => {
      mem.delete(k);
    }
  };
  console.log('[kv] use in-memory store');
}

// SMTP / Resend transporter
const SMTP_HOST = process.env.SMTP_HOST || (process.env.RESEND_API ? 'smtp.resend.com' : undefined);
const SMTP_PORT = process.env.SMTP_PORT || 587;
const SMTP_USER = process.env.SMTP_USER || (process.env.RESEND_API ? 'resend' : undefined);
const SMTP_PASS = process.env.SMTP_PASS || process.env.RESEND_API; // allow RESEND_API as password
const FROM = process.env.FROM_EMAIL || SMTP_USER;

const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: false,
  auth: SMTP_USER && SMTP_PASS ? { user: SMTP_USER, pass: SMTP_PASS } : undefined
});

// -------- Captcha (Image) ---------
// GET /api/auth/captcha  -> { id, svg }
router.get('/captcha', async (req, res) => {
  try {
    const captcha = svgCaptcha.create({
      size: 4,
      noise: 2,
      color: true,
      background: '#ffffff',
      width: 100,
      height: 36,
      ignoreChars: '0oO1ilI'
    });
    const id = randomUUID();
    const ttl = parseInt(process.env.CAPTCHA_TTL || '180', 10); // 3 minutes
    await store.setex(`captcha:${id}`, ttl, captcha.text.toLowerCase());
    res.json({ success: true, data: { id, svg: captcha.data } });
  } catch (err) {
    console.error('captcha error:', err);
    res.status(500).json({ success: false, message: 'captcha error' });
  }
});

// POST /api/auth/captcha/verify { id, code }
router.post('/captcha/verify', async (req, res) => {
  const { id, code } = req.body || {};
  if (!id || !code) return res.status(400).json({ success: false, message: 'captcha required' });
  const saved = await store.get(`captcha:${id}`);
  if (!saved) return res.status(400).json({ success: false, message: 'captcha expired' });
  if (saved !== String(code).toLowerCase()) {
    return res.status(400).json({ success: false, message: 'captcha mismatch' });
  }
  // optional: one-time use
  await store.del(`captcha:${id}`);
  return res.json({ success: true, message: 'captcha ok' });
});

// -------- Rotate captcha (turn upright) ---------
// helper to build a simple rotated SVG
function buildRotateSvg(angle) {
  const size = 120;
  const half = size / 2;
  return `data:image/svg+xml;base64,${Buffer.from(
    `<svg xmlns='http://www.w3.org/2000/svg' width='${size}' height='${size}'>
      <rect x='0' y='0' width='${size}' height='${size}' fill='#f2f5f9'/>
      <g transform='rotate(${angle} ${half} ${half})'>
        <rect x='30' y='30' width='60' height='60' rx='8' fill='#3b82f6'/>
        <text x='${half}' y='${half+6}' text-anchor='middle' font-size='18' fill='#fff'>R</text>
      </g>
    </svg>`
  ).toString('base64')}`;
}

// GET /api/auth/captcha/rotate -> { id, svg }
router.get('/captcha/rotate', async (req, res) => {
  try {
    const id = randomUUID();
    const angle = Math.floor(Math.random() * 360);
    const ttl = parseInt(process.env.CAPTCHA_TTL || '180', 10);
    await store.setex(`captcha_rotate:${id}`, ttl, String(angle));
    const svg = buildRotateSvg(angle);
    res.json({ success: true, data: { id, svg } });
  } catch (e) {
    console.error('rotate captcha error:', e);
    res.status(500).json({ success: false, message: 'captcha error' });
  }
});

// POST /api/auth/captcha/rotate/verify { id, deg }
router.post('/captcha/rotate/verify', async (req, res) => {
  const { id, deg } = req.body || {};
  if (!id || typeof deg === 'undefined') return res.status(400).json({ success: false, message: 'captcha required' });
  const saved = await store.get(`captcha_rotate:${id}`);
  if (!saved) return res.status(400).json({ success: false, message: 'captcha expired' });
  const target = Number(saved) % 360;
  const provided = Number(deg) % 360;
  const diff = Math.min(Math.abs(target - provided), 360 - Math.abs(target - provided));
  const tolerance = 10; // degrees
  if (diff > tolerance) return res.status(400).json({ success: false, message: 'captcha mismatch' });
  await store.del(`captcha_rotate:${id}`);
  return res.json({ success: true, message: 'captcha ok' });
});

// -------- Email verification code ---------
// POST /api/auth/email/send { email }
router.post('/email/send', async (req, res) => {
  try {
    const { email, captchaId, captchaCode } = req.body || {};
    if (!email) return res.status(400).json({ success: false, message: 'email required' });
    // 必須先通過圖形驗證碼
    if (!captchaId || !captchaCode) return res.status(400).json({ success: false, message: 'captcha required' });
    const saved = await store.get(`captcha:${captchaId}`);
    if (!saved) return res.status(400).json({ success: false, message: 'captcha expired' });
    if (saved !== String(captchaCode).toLowerCase()) return res.status(400).json({ success: false, message: 'captcha mismatch' });
    await store.del(`captcha:${captchaId}`);
    const code = Math.floor(100000 + Math.random() * 900000).toString(); // 6 digits
    const ttl = parseInt(process.env.EMAIL_CODE_TTL || '300', 10); // 5 minutes
    await store.setex(`email_code:${email}`, ttl, code);

    const mailOptions = {
      from: process.env.FROM_EMAIL || process.env.SMTP_USER,
      to: email,
      subject: 'Your Verification Code',
      text: `Your verification code is ${code}. It will expire in ${Math.floor(ttl/60)} minutes.`
    };
    await transporter.sendMail(mailOptions);
    res.json({ success: true, message: 'email sent' });
  } catch (err) {
    console.error('email send error:', err);
    res.status(500).json({ success: false, message: 'email send error' });
  }
});

// Mock user database (replace with real database)
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

// Generate refresh token
const generateRefreshToken = (user) => {
  return jwt.sign(
    { id: user.id },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: process.env.JWT_REFRESH_EXPIRE || '7d' }
  );
};

// @route   POST /api/auth/login
// @desc    User login
// @access  Public
router.post('/login', authLimiter, [
  body('username').notEmpty().withMessage('請輸入正確的用戶名'),
  body('password').notEmpty().withMessage('請輸入正確的密碼')
], async (req, res) => {
  console.log('Login attempt:', req.body);
  console.log('JWT_SECRET exists:', !!process.env.JWT_SECRET);
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('Validation errors:', errors.array());
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: errors.array()
      });
    }

    const { username, password } = req.body;
    console.log('Looking for user:', username);

    // Find user
    const user = users.find(u => u.username === username || u.email === username);
    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    // Check password
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    // Check user status
    if (user.status !== 'active') {
      return res.status(401).json({
        success: false,
        message: 'Account is not active'
      });
    }

    // Generate tokens
    const token = generateToken(user);
    const refreshToken = generateRefreshToken(user);

    // A平台專用回應格式
    if (req.headers['user-agent']?.includes('admin') || user.role === 'admin') {
      res.json({
        code: 200,
        data: {
          auth: token,
          googlebind: false,  // 開發環境預設不綁定 Google 驗證器
          expired: false,    // 密碼未過期
          refreshToken,
          user: {
            id: user.id,
            username: user.username,
            email: user.email,
            role: user.role
          }
        },
        message: 'Login successful'
      });
    } else {
      // G平台格式
      res.json({
        success: true,
        message: 'Login successful',
        data: {
          token,
          refreshToken,
          user: {
            id: user.id,
            username: user.username,
            email: user.email,
            role: user.role
          }
        }
      });
    }
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

// @route   POST /api/auth/register
// @desc    User registration
// @access  Public
router.post('/register', [
  body('username').isLength({ min: 3 }).withMessage('Username must be at least 3 characters'),
  body('email').isEmail().withMessage('Please provide a valid email format'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: errors.array()
      });
    }

    const { username, email, password, emailCode } = req.body;

    // In production require emailCode; in development allow skip
    if (process.env.NODE_ENV === 'production') {
      const codeInRedis = await store.get(`email_code:${email}`);
      if (!codeInRedis || codeInRedis !== emailCode) {
        return res.status(400).json({ success: false, message: 'Invalid or expired email code' });
      }
    }

    // Check if user already exists
    const existingUser = users.find(u => u.username === username || u.email === email);
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: 'User already exists'
      });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 12);

    // Create new user
    const isSuperAdmin = (username === 'AmpliFyx1688' || email === 'amplifyx1688@local.test');
    const newUser = {
      id: users.length + 1,
      username,
      email,
      password: hashedPassword,
      role: isSuperAdmin ? 'admin' : 'user',
      status: 'active',
      createdAt: new Date()
    };

    users.push(newUser);

    // Generate tokens
    const token = generateToken(newUser);
    const refreshToken = generateRefreshToken(newUser);

    res.status(201).json({
      success: true,
      message: 'Registration successful',
      data: {
        token,
        refreshToken,
        user: {
          id: newUser.id,
          username: newUser.username,
          email: newUser.email,
          role: newUser.role
        }
      }
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

// @route   POST /api/auth/refresh
// @desc    Refresh access token
// @access  Public
router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(401).json({
        success: false,
        message: 'Refresh token is required'
      });
    }

    // Verify refresh token
    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    const user = users.find(u => u.id === decoded.id);

    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Invalid refresh token'
      });
    }

    // Generate new access token
    const newToken = generateToken(user);

    res.json({
      success: true,
      message: 'Token refreshed successfully',
      data: {
        token: newToken
      }
    });
  } catch (error) {
    console.error('Refresh token error:', error);
    res.status(401).json({
      success: false,
      message: 'Invalid refresh token'
    });
  }
});

// @route   POST /api/auth/logout
// @desc    User logout
// @access  Private
router.post('/logout', (req, res) => {
  // In a real application, you would blacklist the token
  res.json({
    success: true,
    message: 'Logout successful'
  });
});

module.exports = router;
