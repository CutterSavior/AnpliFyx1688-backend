const express = require('express');
const { body, validationResult } = require('express-validator');
const { authorizeRoles } = require('../middleware/auth');

const router = express.Router();

// Apply admin role authorization to all routes
router.use(authorizeRoles('admin'));

// Mock data (should be replaced with database)
const users = [
  {
    id: 1,
    username: 'admin',
    email: 'admin@example.com',
    role: 'admin',
    status: 'active',
    profile: { firstName: 'Admin', lastName: 'User', kycStatus: 'verified' },
    createdAt: '2024-01-01T00:00:00.000Z'
  },
  {
    id: 2,
    username: 'user',
    email: 'user@example.com',
    role: 'user',
    status: 'active',
    profile: { firstName: 'John', lastName: 'Doe', kycStatus: 'pending' },
    createdAt: '2024-01-15T10:30:00.000Z'
  }
];

const adminLogs = [];
let logId = 1;

// Helper function to log admin actions
const logAdminAction = (adminId, action, details, targetUserId = null) => {
  adminLogs.push({
    id: logId++,
    adminId,
    action,
    details,
    targetUserId,
    timestamp: new Date().toISOString(),
    ip: '127.0.0.1' // Should be extracted from request
  });
};

// @route   GET /api/admin/dashboard
// @desc    Get admin dashboard statistics
// @access  Private (Admin only)
router.get('/dashboard', (req, res) => {
  try {
    const stats = {
      totalUsers: users.length,
      activeUsers: users.filter(u => u.status === 'active').length,
      pendingKYC: users.filter(u => u.profile.kycStatus === 'pending').length,
      totalTrades: 1250,
      totalVolume: '15,234,567.89',
      systemHealth: {
        status: 'healthy',
        uptime: '99.9%',
        responseTime: '45ms'
      },
      recentActivity: [
        { type: 'user_registration', count: 15, change: '+12%' },
        { type: 'trades_completed', count: 89, change: '+5%' },
        { type: 'withdrawals_processed', count: 23, change: '-8%' },
        { type: 'kyc_submitted', count: 7, change: '+15%' }
      ]
    };

    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    console.error('Admin dashboard error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve dashboard data'
    });
  }
});

// @route   GET /api/admin/users
// @desc    Get all users with filtering and pagination
// @access  Private (Admin only)
router.get('/users', (req, res) => {
  try {
    const { 
      status, 
      role, 
      kycStatus, 
      search, 
      limit = 50, 
      offset = 0,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.query;

    let filteredUsers = [...users];

    // Apply filters
    if (status) {
      filteredUsers = filteredUsers.filter(u => u.status === status);
    }

    if (role) {
      filteredUsers = filteredUsers.filter(u => u.role === role);
    }

    if (kycStatus) {
      filteredUsers = filteredUsers.filter(u => u.profile.kycStatus === kycStatus);
    }

    if (search) {
      const searchLower = search.toLowerCase();
      filteredUsers = filteredUsers.filter(u => 
        u.username.toLowerCase().includes(searchLower) ||
        u.email.toLowerCase().includes(searchLower) ||
        `${u.profile.firstName} ${u.profile.lastName}`.toLowerCase().includes(searchLower)
      );
    }

    // Sorting
    filteredUsers.sort((a, b) => {
      let aValue = a[sortBy];
      let bValue = b[sortBy];

      if (sortBy.includes('.')) {
        const keys = sortBy.split('.');
        aValue = keys.reduce((obj, key) => obj[key], a);
        bValue = keys.reduce((obj, key) => obj[key], b);
      }

      if (sortOrder === 'desc') {
        return new Date(bValue) - new Date(aValue);
      } else {
        return new Date(aValue) - new Date(bValue);
      }
    });

    // Pagination
    const total = filteredUsers.length;
    const paginatedUsers = filteredUsers.slice(
      parseInt(offset), 
      parseInt(offset) + parseInt(limit)
    );

    // Remove sensitive data
    const safeUsers = paginatedUsers.map(user => {
      const { password, ...safeUser } = user;
      return safeUser;
    });

    res.json({
      success: true,
      data: {
        users: safeUsers,
        total,
        limit: parseInt(limit),
        offset: parseInt(offset)
      }
    });
  } catch (error) {
    console.error('Admin get users error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve users'
    });
  }
});

// @route   GET /api/admin/users/:userId
// @desc    Get user details
// @access  Private (Admin only)
router.get('/users/:userId', (req, res) => {
  try {
    const { userId } = req.params;
    const user = users.find(u => u.id === parseInt(userId));

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Remove sensitive data
    const { password, ...safeUser } = user;

    // Add additional admin-specific data
    const userDetails = {
      ...safeUser,
      loginHistory: [
        { ip: '192.168.1.100', timestamp: '2024-01-20T10:30:00.000Z', success: true },
        { ip: '192.168.1.100', timestamp: '2024-01-19T15:45:00.000Z', success: true }
      ],
      securityEvents: [],
      totalTrades: 45,
      totalVolume: '123,456.78',
      referrals: 3
    };

    res.json({
      success: true,
      data: userDetails
    });
  } catch (error) {
    console.error('Admin get user error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve user details'
    });
  }
});

// @route   PUT /api/admin/users/:userId/status
// @desc    Update user status
// @access  Private (Admin only)
router.put('/users/:userId/status', [
  body('status').isIn(['active', 'suspended', 'banned']).withMessage('Invalid status'),
  body('reason').optional().isString().withMessage('Reason must be a string')
], (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: errors.array()
      });
    }

    const { userId } = req.params;
    const { status, reason } = req.body;
    const adminId = req.user.id;

    const userIndex = users.findIndex(u => u.id === parseInt(userId));
    if (userIndex === -1) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const oldStatus = users[userIndex].status;
    users[userIndex].status = status;
    users[userIndex].updatedAt = new Date().toISOString();

    // Log admin action
    logAdminAction(
      adminId,
      'user_status_changed',
      `Changed user status from ${oldStatus} to ${status}. Reason: ${reason || 'Not specified'}`,
      parseInt(userId)
    );

    res.json({
      success: true,
      message: 'User status updated successfully',
      data: {
        userId: parseInt(userId),
        oldStatus,
        newStatus: status,
        reason
      }
    });
  } catch (error) {
    console.error('Admin update user status error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update user status'
    });
  }
});

// @route   PUT /api/admin/users/:userId/kyc
// @desc    Update user KYC status
// @access  Private (Admin only)
router.put('/users/:userId/kyc', [
  body('status').isIn(['pending', 'verified', 'rejected']).withMessage('Invalid KYC status'),
  body('reason').optional().isString().withMessage('Reason must be a string')
], (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: errors.array()
      });
    }

    const { userId } = req.params;
    const { status, reason } = req.body;
    const adminId = req.user.id;

    const userIndex = users.findIndex(u => u.id === parseInt(userId));
    if (userIndex === -1) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const oldKycStatus = users[userIndex].profile.kycStatus;
    users[userIndex].profile.kycStatus = status;
    users[userIndex].updatedAt = new Date().toISOString();

    if (status === 'verified') {
      users[userIndex].kyc = {
        ...users[userIndex].kyc,
        verifiedAt: new Date().toISOString(),
        verifiedBy: adminId
      };
    } else if (status === 'rejected') {
      users[userIndex].kyc = {
        ...users[userIndex].kyc,
        rejectedAt: new Date().toISOString(),
        rejectedBy: adminId,
        rejectionReason: reason
      };
    }

    // Log admin action
    logAdminAction(
      adminId,
      'kyc_status_changed',
      `Changed KYC status from ${oldKycStatus} to ${status}. Reason: ${reason || 'Not specified'}`,
      parseInt(userId)
    );

    res.json({
      success: true,
      message: 'KYC status updated successfully',
      data: {
        userId: parseInt(userId),
        oldStatus: oldKycStatus,
        newStatus: status,
        reason
      }
    });
  } catch (error) {
    console.error('Admin update KYC status error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update KYC status'
    });
  }
});

// @route   GET /api/admin/transactions
// @desc    Get all transactions for admin review
// @access  Private (Admin only)
router.get('/transactions', (req, res) => {
  try {
    const { 
      type, 
      status, 
      asset, 
      userId,
      startTime, 
      endTime, 
      limit = 50, 
      offset = 0 
    } = req.query;

    // Mock transaction data (should come from database)
    let transactions = [
      {
        id: 1,
        userId: 1,
        type: 'deposit',
        asset: 'USDT',
        amount: '1000.00',
        status: 'completed',
        txHash: '0x1234567890abcdef',
        createdAt: '2024-01-15T10:00:00.000Z'
      },
      {
        id: 2,
        userId: 2,
        type: 'withdraw',
        asset: 'BTC',
        amount: '0.05',
        status: 'pending',
        txHash: null,
        createdAt: '2024-01-16T14:30:00.000Z'
      }
    ];

    // Apply filters
    if (type) {
      transactions = transactions.filter(tx => tx.type === type);
    }

    if (status) {
      transactions = transactions.filter(tx => tx.status === status);
    }

    if (asset) {
      transactions = transactions.filter(tx => tx.asset === asset.toUpperCase());
    }

    if (userId) {
      transactions = transactions.filter(tx => tx.userId === parseInt(userId));
    }

    if (startTime) {
      transactions = transactions.filter(tx => 
        new Date(tx.createdAt) >= new Date(startTime)
      );
    }

    if (endTime) {
      transactions = transactions.filter(tx => 
        new Date(tx.createdAt) <= new Date(endTime)
      );
    }

    // Pagination
    const total = transactions.length;
    const paginatedTransactions = transactions
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(parseInt(offset), parseInt(offset) + parseInt(limit));

    res.json({
      success: true,
      data: {
        transactions: paginatedTransactions,
        total,
        limit: parseInt(limit),
        offset: parseInt(offset)
      }
    });
  } catch (error) {
    console.error('Admin get transactions error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve transactions'
    });
  }
});

// @route   GET /api/admin/logs
// @desc    Get admin action logs
// @access  Private (Admin only)
router.get('/logs', (req, res) => {
  try {
    const { 
      adminId, 
      action, 
      targetUserId,
      startTime, 
      endTime, 
      limit = 50, 
      offset = 0 
    } = req.query;

    let filteredLogs = [...adminLogs];

    // Apply filters
    if (adminId) {
      filteredLogs = filteredLogs.filter(log => log.adminId === parseInt(adminId));
    }

    if (action) {
      filteredLogs = filteredLogs.filter(log => log.action === action);
    }

    if (targetUserId) {
      filteredLogs = filteredLogs.filter(log => log.targetUserId === parseInt(targetUserId));
    }

    if (startTime) {
      filteredLogs = filteredLogs.filter(log => 
        new Date(log.timestamp) >= new Date(startTime)
      );
    }

    if (endTime) {
      filteredLogs = filteredLogs.filter(log => 
        new Date(log.timestamp) <= new Date(endTime)
      );
    }

    // Pagination
    const total = filteredLogs.length;
    const paginatedLogs = filteredLogs
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(parseInt(offset), parseInt(offset) + parseInt(limit));

    res.json({
      success: true,
      data: {
        logs: paginatedLogs,
        total,
        limit: parseInt(limit),
        offset: parseInt(offset)
      }
    });
  } catch (error) {
    console.error('Admin get logs error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve admin logs'
    });
  }
});

// @route   GET /api/admin/reports/summary
// @desc    Get summary reports
// @access  Private (Admin only)
router.get('/reports/summary', (req, res) => {
  try {
    const { period = '7d' } = req.query;

    // Mock report data
    const reports = {
      userMetrics: {
        newRegistrations: 45,
        activeUsers: 234,
        kycSubmissions: 12,
        kycApprovals: 8
      },
      tradingMetrics: {
        totalTrades: 1250,
        totalVolume: '15,234,567.89',
        uniqueTraders: 189,
        avgTradeSize: '12,187.65'
      },
      financialMetrics: {
        totalDeposits: '2,345,678.90',
        totalWithdrawals: '1,987,654.32',
        netFlow: '358,024.58',
        fees: '23,456.78'
      },
      systemMetrics: {
        uptime: '99.95%',
        avgResponseTime: '45ms',
        errorRate: '0.02%',
        activeConnections: 1234
      }
    };

    res.json({
      success: true,
      data: {
        period,
        generatedAt: new Date().toISOString(),
        reports
      }
    });
  } catch (error) {
    console.error('Admin get reports error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to generate reports'
    });
  }
});

module.exports = router;
