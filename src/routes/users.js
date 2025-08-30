const express = require('express');
const { body, validationResult } = require('express-validator');
const bcrypt = require('bcryptjs');

const router = express.Router();

// Mock users database (same as in auth.js, should be shared)
const users = [
  {
    id: 1,
    username: 'admin',
    email: 'admin@example.com',
    password: '$2a$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewdBPj/GKUdHFCVS',
    role: 'admin',
    status: 'active',
    profile: {
      firstName: 'Admin',
      lastName: 'User',
      phone: '+1234567890',
      country: 'US',
      kycStatus: 'verified',
      twoFactorEnabled: false
    },
    createdAt: '2024-01-01T00:00:00.000Z'
  },
  {
    id: 2,
    username: 'user',
    email: 'user@example.com',
    password: '$2a$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewdBPj/GKUdHFCVS',
    role: 'user',
    status: 'active',
    profile: {
      firstName: 'John',
      lastName: 'Doe',
      phone: '+1987654321',
      country: 'US',
      kycStatus: 'pending',
      twoFactorEnabled: true
    },
    createdAt: '2024-01-15T10:30:00.000Z'
  }
];

// @route   GET /api/users/profile
// @desc    Get user profile
// @access  Private
router.get('/profile', (req, res) => {
  try {
    const userId = req.user.id;
    const user = users.find(u => u.id === userId);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Remove sensitive information
    const { password, ...userProfile } = user;

    res.json({
      success: true,
      data: userProfile
    });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve profile'
    });
  }
});

// @route   PUT /api/users/profile
// @desc    Update user profile
// @access  Private
router.put('/profile', [
  body('firstName').optional().isLength({ min: 1 }).withMessage('First name cannot be empty'),
  body('lastName').optional().isLength({ min: 1 }).withMessage('Last name cannot be empty'),
  body('phone').optional().isMobilePhone().withMessage('Invalid phone number'),
  body('country').optional().isLength({ min: 2, max: 2 }).withMessage('Country code must be 2 characters')
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

    const userId = req.user.id;
    const userIndex = users.findIndex(u => u.id === userId);

    if (userIndex === -1) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const { firstName, lastName, phone, country } = req.body;

    // Update profile
    if (firstName !== undefined) users[userIndex].profile.firstName = firstName;
    if (lastName !== undefined) users[userIndex].profile.lastName = lastName;
    if (phone !== undefined) users[userIndex].profile.phone = phone;
    if (country !== undefined) users[userIndex].profile.country = country;

    users[userIndex].updatedAt = new Date().toISOString();

    const { password, ...updatedUser } = users[userIndex];

    res.json({
      success: true,
      message: 'Profile updated successfully',
      data: updatedUser
    });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update profile'
    });
  }
});

// @route   PUT /api/users/password
// @desc    Change password
// @access  Private
router.put('/password', [
  body('currentPassword').notEmpty().withMessage('Current password is required'),
  body('newPassword').isLength({ min: 6 }).withMessage('New password must be at least 6 characters'),
  body('confirmPassword').custom((value, { req }) => {
    if (value !== req.body.newPassword) {
      throw new Error('Passwords do not match');
    }
    return true;
  })
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

    const userId = req.user.id;
    const userIndex = users.findIndex(u => u.id === userId);

    if (userIndex === -1) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const { currentPassword, newPassword } = req.body;
    const user = users[userIndex];

    // Verify current password
    const isCurrentPasswordValid = await bcrypt.compare(currentPassword, user.password);
    if (!isCurrentPasswordValid) {
      return res.status(400).json({
        success: false,
        message: 'Current password is incorrect'
      });
    }

    // Hash new password
    const hashedNewPassword = await bcrypt.hash(newPassword, 12);
    users[userIndex].password = hashedNewPassword;
    users[userIndex].updatedAt = new Date().toISOString();

    res.json({
      success: true,
      message: 'Password changed successfully'
    });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to change password'
    });
  }
});

// @route   POST /api/users/kyc
// @desc    Submit KYC verification
// @access  Private
router.post('/kyc', [
  body('documentType').isIn(['passport', 'id_card', 'driver_license']).withMessage('Invalid document type'),
  body('documentNumber').notEmpty().withMessage('Document number is required'),
  body('firstName').notEmpty().withMessage('First name is required'),
  body('lastName').notEmpty().withMessage('Last name is required'),
  body('dateOfBirth').isISO8601().withMessage('Invalid date of birth'),
  body('address').notEmpty().withMessage('Address is required'),
  body('city').notEmpty().withMessage('City is required'),
  body('postalCode').notEmpty().withMessage('Postal code is required'),
  body('country').isLength({ min: 2, max: 2 }).withMessage('Country code must be 2 characters')
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

    const userId = req.user.id;
    const userIndex = users.findIndex(u => u.id === userId);

    if (userIndex === -1) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const kycData = req.body;

    // Update KYC information
    users[userIndex].kyc = {
      ...kycData,
      status: 'pending',
      submittedAt: new Date().toISOString()
    };
    users[userIndex].profile.kycStatus = 'pending';
    users[userIndex].updatedAt = new Date().toISOString();

    res.json({
      success: true,
      message: 'KYC verification submitted successfully',
      data: {
        status: 'pending',
        submittedAt: users[userIndex].kyc.submittedAt
      }
    });
  } catch (error) {
    console.error('KYC submission error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to submit KYC verification'
    });
  }
});

// @route   GET /api/users/kyc
// @desc    Get KYC status
// @access  Private
router.get('/kyc', (req, res) => {
  try {
    const userId = req.user.id;
    const user = users.find(u => u.id === userId);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const kycStatus = {
      status: user.profile.kycStatus,
      submittedAt: user.kyc?.submittedAt || null,
      verifiedAt: user.kyc?.verifiedAt || null,
      rejectedAt: user.kyc?.rejectedAt || null,
      rejectionReason: user.kyc?.rejectionReason || null
    };

    res.json({
      success: true,
      data: kycStatus
    });
  } catch (error) {
    console.error('Get KYC status error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve KYC status'
    });
  }
});

// @route   POST /api/users/2fa/enable
// @desc    Enable two-factor authentication
// @access  Private
router.post('/2fa/enable', (req, res) => {
  try {
    const userId = req.user.id;
    const userIndex = users.findIndex(u => u.id === userId);

    if (userIndex === -1) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Generate mock secret (in real app, use speakeasy or similar)
    const secret = 'JBSWY3DPEHPK3PXP';
    const qrCodeUrl = `otpauth://totp/TradingPlatform:${users[userIndex].email}?secret=${secret}&issuer=TradingPlatform`;

    users[userIndex].twoFactor = {
      secret,
      enabled: false, // Will be enabled after verification
      backupCodes: [
        '12345678', '87654321', '11111111', '22222222', '33333333'
      ]
    };

    res.json({
      success: true,
      message: '2FA setup initiated',
      data: {
        secret,
        qrCodeUrl,
        backupCodes: users[userIndex].twoFactor.backupCodes
      }
    });
  } catch (error) {
    console.error('Enable 2FA error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to enable 2FA'
    });
  }
});

// @route   POST /api/users/2fa/verify
// @desc    Verify and activate two-factor authentication
// @access  Private
router.post('/2fa/verify', [
  body('token').isLength({ min: 6, max: 6 }).withMessage('Token must be 6 digits')
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

    const userId = req.user.id;
    const userIndex = users.findIndex(u => u.id === userId);
    const { token } = req.body;

    if (userIndex === -1) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Mock verification (in real app, verify TOTP token)
    if (token === '123456') {
      users[userIndex].profile.twoFactorEnabled = true;
      users[userIndex].twoFactor.enabled = true;
      users[userIndex].updatedAt = new Date().toISOString();

      res.json({
        success: true,
        message: '2FA enabled successfully'
      });
    } else {
      res.status(400).json({
        success: false,
        message: 'Invalid token'
      });
    }
  } catch (error) {
    console.error('Verify 2FA error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to verify 2FA'
    });
  }
});

// @route   POST /api/users/2fa/disable
// @desc    Disable two-factor authentication
// @access  Private
router.post('/2fa/disable', [
  body('password').notEmpty().withMessage('Password is required')
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

    const userId = req.user.id;
    const userIndex = users.findIndex(u => u.id === userId);
    const { password } = req.body;

    if (userIndex === -1) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Verify password
    const isPasswordValid = await bcrypt.compare(password, users[userIndex].password);
    if (!isPasswordValid) {
      return res.status(400).json({
        success: false,
        message: 'Invalid password'
      });
    }

    users[userIndex].profile.twoFactorEnabled = false;
    users[userIndex].twoFactor = undefined;
    users[userIndex].updatedAt = new Date().toISOString();

    res.json({
      success: true,
      message: '2FA disabled successfully'
    });
  } catch (error) {
    console.error('Disable 2FA error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to disable 2FA'
    });
  }
});

module.exports = router;
