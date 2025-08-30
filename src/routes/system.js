const express = require('express');
const { body, validationResult } = require('express-validator');
const { authorizeRoles } = require('../middleware/auth');

const router = express.Router();

// Mock system configuration
let systemConfig = {
  trading: {
    maintenanceMode: false,
    tradingEnabled: true,
    depositEnabled: true,
    withdrawalEnabled: true,
    maxOrderSize: '1000000',
    minOrderSize: '1',
    tradingFee: '0.001'
  },
  security: {
    kycRequired: true,
    twoFactorRequired: false,
    maxLoginAttempts: 5,
    sessionTimeout: 3600,
    ipWhitelist: [],
    passwordMinLength: 8
  },
  notifications: {
    emailEnabled: true,
    smsEnabled: false,
    pushEnabled: true,
    maintenanceNotifications: true
  },
  limits: {
    dailyWithdrawLimit: '100000',
    monthlyWithdrawLimit: '1000000',
    unverifiedWithdrawLimit: '1000',
    maxOpenOrders: 100
  }
};

// Mock announcements
let announcements = [
  {
    id: 1,
    title: 'System Maintenance Scheduled',
    content: 'We will be performing system maintenance on January 25th from 02:00 to 04:00 UTC.',
    type: 'maintenance',
    priority: 'high',
    published: true,
    publishedAt: '2024-01-20T10:00:00.000Z',
    createdBy: 1
  },
  {
    id: 2,
    title: 'New Trading Pairs Added',
    content: 'We have added MATIC/USDT and SOL/USDT trading pairs.',
    type: 'feature',
    priority: 'medium',
    published: true,
    publishedAt: '2024-01-18T15:30:00.000Z',
    createdBy: 1
  }
];

let announcementId = 3;

// @route   GET /api/system/config
// @desc    Get system configuration
// @access  Private (Admin only for sensitive configs)
router.get('/config', (req, res) => {
  try {
    // Return public config for regular users
    const publicConfig = {
      trading: {
        maintenanceMode: systemConfig.trading.maintenanceMode,
        tradingEnabled: systemConfig.trading.tradingEnabled,
        depositEnabled: systemConfig.trading.depositEnabled,
        withdrawalEnabled: systemConfig.trading.withdrawalEnabled,
        tradingFee: systemConfig.trading.tradingFee
      },
      security: {
        kycRequired: systemConfig.security.kycRequired,
        twoFactorRequired: systemConfig.security.twoFactorRequired,
        passwordMinLength: systemConfig.security.passwordMinLength
      },
      limits: systemConfig.limits
    };

    // Return full config for admins
    const config = req.user.role === 'admin' ? systemConfig : publicConfig;

    res.json({
      success: true,
      data: config
    });
  } catch (error) {
    console.error('Get system config error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve system configuration'
    });
  }
});

// @route   PUT /api/system/config
// @desc    Update system configuration
// @access  Private (Admin only)
router.put('/config', authorizeRoles('admin'), [
  body('trading').optional().isObject().withMessage('Trading config must be an object'),
  body('security').optional().isObject().withMessage('Security config must be an object'),
  body('notifications').optional().isObject().withMessage('Notifications config must be an object'),
  body('limits').optional().isObject().withMessage('Limits config must be an object')
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

    const { trading, security, notifications, limits } = req.body;

    // Update configurations
    if (trading) {
      systemConfig.trading = { ...systemConfig.trading, ...trading };
    }

    if (security) {
      systemConfig.security = { ...systemConfig.security, ...security };
    }

    if (notifications) {
      systemConfig.notifications = { ...systemConfig.notifications, ...notifications };
    }

    if (limits) {
      systemConfig.limits = { ...systemConfig.limits, ...limits };
    }

    systemConfig.updatedAt = new Date().toISOString();

    // Emit system update via WebSocket
    if (global.io) {
      global.io.emit('systemConfigUpdate', {
        timestamp: systemConfig.updatedAt,
        changes: { trading, security, notifications, limits }
      });
    }

    res.json({
      success: true,
      message: 'System configuration updated successfully',
      data: systemConfig
    });
  } catch (error) {
    console.error('Update system config error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update system configuration'
    });
  }
});

// @route   GET /api/system/announcements
// @desc    Get system announcements
// @access  Public
router.get('/announcements', (req, res) => {
  try {
    const { type, published, limit = 10, offset = 0 } = req.query;

    let filteredAnnouncements = [...announcements];

    // Apply filters
    if (type) {
      filteredAnnouncements = filteredAnnouncements.filter(a => a.type === type);
    }

    if (published !== undefined) {
      const isPublished = published === 'true';
      filteredAnnouncements = filteredAnnouncements.filter(a => a.published === isPublished);
    } else {
      // Default to published only for non-admin users
      if (req.user?.role !== 'admin') {
        filteredAnnouncements = filteredAnnouncements.filter(a => a.published);
      }
    }

    // Sort by published date (newest first)
    filteredAnnouncements.sort((a, b) => 
      new Date(b.publishedAt || b.createdAt) - new Date(a.publishedAt || a.createdAt)
    );

    // Pagination
    const total = filteredAnnouncements.length;
    const paginatedAnnouncements = filteredAnnouncements.slice(
      parseInt(offset),
      parseInt(offset) + parseInt(limit)
    );

    res.json({
      success: true,
      data: {
        announcements: paginatedAnnouncements,
        total,
        limit: parseInt(limit),
        offset: parseInt(offset)
      }
    });
  } catch (error) {
    console.error('Get announcements error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve announcements'
    });
  }
});

// @route   POST /api/system/announcements
// @desc    Create system announcement
// @access  Private (Admin only)
router.post('/announcements', authorizeRoles('admin'), [
  body('title').notEmpty().withMessage('Title is required'),
  body('content').notEmpty().withMessage('Content is required'),
  body('type').isIn(['maintenance', 'feature', 'security', 'general']).withMessage('Invalid announcement type'),
  body('priority').isIn(['low', 'medium', 'high', 'critical']).withMessage('Invalid priority level'),
  body('published').optional().isBoolean().withMessage('Published must be a boolean')
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

    const { title, content, type, priority, published = false } = req.body;
    const createdBy = req.user.id;

    const announcement = {
      id: announcementId++,
      title,
      content,
      type,
      priority,
      published,
      publishedAt: published ? new Date().toISOString() : null,
      createdAt: new Date().toISOString(),
      createdBy
    };

    announcements.push(announcement);

    // Emit announcement via WebSocket if published
    if (published && global.io) {
      global.io.emit('newAnnouncement', announcement);
    }

    res.status(201).json({
      success: true,
      message: 'Announcement created successfully',
      data: announcement
    });
  } catch (error) {
    console.error('Create announcement error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create announcement'
    });
  }
});

// @route   PUT /api/system/announcements/:id
// @desc    Update system announcement
// @access  Private (Admin only)
router.put('/announcements/:id', authorizeRoles('admin'), [
  body('title').optional().notEmpty().withMessage('Title cannot be empty'),
  body('content').optional().notEmpty().withMessage('Content cannot be empty'),
  body('type').optional().isIn(['maintenance', 'feature', 'security', 'general']).withMessage('Invalid announcement type'),
  body('priority').optional().isIn(['low', 'medium', 'high', 'critical']).withMessage('Invalid priority level'),
  body('published').optional().isBoolean().withMessage('Published must be a boolean')
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

    const { id } = req.params;
    const announcementIndex = announcements.findIndex(a => a.id === parseInt(id));

    if (announcementIndex === -1) {
      return res.status(404).json({
        success: false,
        message: 'Announcement not found'
      });
    }

    const { title, content, type, priority, published } = req.body;
    const announcement = announcements[announcementIndex];

    // Update fields
    if (title !== undefined) announcement.title = title;
    if (content !== undefined) announcement.content = content;
    if (type !== undefined) announcement.type = type;
    if (priority !== undefined) announcement.priority = priority;
    
    if (published !== undefined) {
      const wasPublished = announcement.published;
      announcement.published = published;
      
      // Set publishedAt if just published
      if (published && !wasPublished) {
        announcement.publishedAt = new Date().toISOString();
        
        // Emit new announcement via WebSocket
        if (global.io) {
          global.io.emit('newAnnouncement', announcement);
        }
      }
    }

    announcement.updatedAt = new Date().toISOString();

    res.json({
      success: true,
      message: 'Announcement updated successfully',
      data: announcement
    });
  } catch (error) {
    console.error('Update announcement error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update announcement'
    });
  }
});

// @route   DELETE /api/system/announcements/:id
// @desc    Delete system announcement
// @access  Private (Admin only)
router.delete('/announcements/:id', authorizeRoles('admin'), (req, res) => {
  try {
    const { id } = req.params;
    const announcementIndex = announcements.findIndex(a => a.id === parseInt(id));

    if (announcementIndex === -1) {
      return res.status(404).json({
        success: false,
        message: 'Announcement not found'
      });
    }

    const deletedAnnouncement = announcements.splice(announcementIndex, 1)[0];

    res.json({
      success: true,
      message: 'Announcement deleted successfully',
      data: deletedAnnouncement
    });
  } catch (error) {
    console.error('Delete announcement error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete announcement'
    });
  }
});

// @route   GET /api/system/status
// @desc    Get system status
// @access  Public
router.get('/status', (req, res) => {
  try {
    const status = {
      online: true,
      maintenance: systemConfig.trading.maintenanceMode,
      services: {
        trading: systemConfig.trading.tradingEnabled,
        deposits: systemConfig.trading.depositEnabled,
        withdrawals: systemConfig.trading.withdrawalEnabled,
        api: true,
        websocket: true
      },
      lastUpdate: new Date().toISOString(),
      version: '1.0.0',
      uptime: process.uptime()
    };

    res.json({
      success: true,
      data: status
    });
  } catch (error) {
    console.error('Get system status error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve system status'
    });
  }
});

// @route   POST /api/system/maintenance
// @desc    Toggle maintenance mode
// @access  Private (Admin only)
router.post('/maintenance', authorizeRoles('admin'), [
  body('enabled').isBoolean().withMessage('Enabled must be a boolean'),
  body('message').optional().isString().withMessage('Message must be a string'),
  body('estimatedDuration').optional().isInt().withMessage('Estimated duration must be a number (minutes)')
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

    const { enabled, message, estimatedDuration } = req.body;

    systemConfig.trading.maintenanceMode = enabled;
    
    const maintenanceInfo = {
      enabled,
      message: message || (enabled ? 'System is under maintenance' : 'Maintenance completed'),
      startTime: enabled ? new Date().toISOString() : null,
      estimatedDuration: estimatedDuration || null,
      updatedBy: req.user.id
    };

    // Emit maintenance mode change via WebSocket
    if (global.io) {
      global.io.emit('maintenanceUpdate', maintenanceInfo);
    }

    res.json({
      success: true,
      message: `Maintenance mode ${enabled ? 'enabled' : 'disabled'} successfully`,
      data: maintenanceInfo
    });
  } catch (error) {
    console.error('Toggle maintenance error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to toggle maintenance mode'
    });
  }
});

module.exports = router;
