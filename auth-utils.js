/**
 * JWT 認證工具函數
 */
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-key-change-in-production';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '24h';
const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS) || 12;

/**
 * 生成JWT token
 * @param {number} userId - 用戶ID
 * @param {string} username - 用戶名
 * @param {string} role - 用戶角色
 * @returns {string} JWT token
 */
function generateToken(userId, username, role = 'user') {
  return jwt.sign(
    { 
      userId, 
      username, 
      role,
      iat: Math.floor(Date.now() / 1000)
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

/**
 * 驗證JWT token
 * @param {string} token - JWT token
 * @returns {object} 解碼後的token資料
 */
function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      throw new Error('TOKEN_EXPIRED');
    } else if (error.name === 'JsonWebTokenError') {
      throw new Error('INVALID_TOKEN');
    } else {
      throw new Error('TOKEN_VERIFICATION_FAILED');
    }
  }
}

/**
 * 密碼加密
 * @param {string} password - 明文密碼
 * @returns {Promise<string>} 加密後的密碼hash
 */
async function hashPassword(password) {
  return await bcrypt.hash(password, BCRYPT_ROUNDS);
}

/**
 * 密碼驗證
 * @param {string} password - 明文密碼
 * @param {string} hash - 密碼hash
 * @returns {Promise<boolean>} 驗證結果
 */
async function comparePassword(password, hash) {
  return await bcrypt.compare(password, hash);
}

/**
 * 提取token從請求header
 * @param {object} req - Express請求對象
 * @returns {string|null} token
 */
function extractToken(req) {
  const authHeader = req.headers.authorization;
  const authToken = req.headers.auth;
  
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  } else if (authToken) {
    return authToken;
  }
  
  return null;
}

/**
 * 驗證修改型操作權限
 * @param {object} user - 用戶資訊
 * @param {string} resourceUserId - 資源所屬用戶ID
 * @returns {boolean} 是否有權限
 */
function canModifyResource(user, resourceUserId) {
  // 管理員可以修改任何資源
  if (user.role === 'admin') {
    return true;
  }
  
  // 用戶只能修改自己的資源
  return user.userId.toString() === resourceUserId.toString();
}

/**
 * 格式化認證錯誤響應
 * @param {string} message - 錯誤訊息
 * @param {string} error - 錯誤代碼
 * @param {number} code - HTTP狀態碼
 * @returns {object} 格式化的錯誤響應
 */
function formatAuthError(message, error, code = 401) {
  return {
    code,
    message,
    error,
    timestamp: new Date().toISOString()
  };
}

module.exports = {
  generateToken,
  verifyToken,
  hashPassword,
  comparePassword,
  extractToken,
  canModifyResource,
  formatAuthError,
  JWT_SECRET,
  JWT_EXPIRES_IN,
  BCRYPT_ROUNDS
};
