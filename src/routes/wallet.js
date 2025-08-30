const express = require('express');
const { body, validationResult } = require('express-validator');
const Decimal = require('decimal.js');

const router = express.Router();

// Mock wallet data
const wallets = [
  {
    userId: 1,
    balances: {
      'USDT': { available: '10000.00', locked: '500.00' },
      'BTC': { available: '0.25', locked: '0.05' },
      'ETH': { available: '5.0', locked: '0.0' },
      'USD': { available: '5000.00', locked: '0.00' }
    }
  },
  {
    userId: 2,
    balances: {
      'USDT': { available: '1000.00', locked: '100.00' },
      'BTC': { available: '0.1', locked: '0.0' },
      'ETH': { available: '2.0', locked: '0.5' },
      'USD': { available: '2000.00', locked: '0.00' }
    }
  }
];

// Mock transaction history
let transactions = [
  {
    id: 1,
    userId: 1,
    type: 'deposit',
    asset: 'USDT',
    amount: '1000.00',
    status: 'completed',
    txHash: '0x1234567890abcdef',
    network: 'TRC20',
    fee: '0.00',
    createdAt: '2024-01-15T10:00:00.000Z',
    completedAt: '2024-01-15T10:05:00.000Z'
  },
  {
    id: 2,
    userId: 2,
    type: 'withdraw',
    asset: 'BTC',
    amount: '0.05',
    status: 'pending',
    txHash: null,
    network: 'BTC',
    fee: '0.0005',
    toAddress: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
    createdAt: '2024-01-16T14:30:00.000Z',
    completedAt: null
  }
];

let transactionId = 3;

// Helper function to get user wallet
const getUserWallet = (userId) => {
  let wallet = wallets.find(w => w.userId === userId);
  if (!wallet) {
    wallet = {
      userId,
      balances: {}
    };
    wallets.push(wallet);
  }
  return wallet;
};

// Helper function to get asset balance
const getAssetBalance = (wallet, asset) => {
  if (!wallet.balances[asset]) {
    wallet.balances[asset] = { available: '0.00', locked: '0.00' };
  }
  return wallet.balances[asset];
};

// @route   GET /api/wallet/balances
// @desc    Get user wallet balances
// @access  Private
router.get('/balances', (req, res) => {
  try {
    const userId = req.user.id;
    const wallet = getUserWallet(userId);

    // Calculate total portfolio value in USDT
    let totalValue = new Decimal(0);
    const prices = {
      'USDT': 1,
      'BTC': 47000,
      'ETH': 3000,
      'USD': 1
    };

    const enrichedBalances = {};
    Object.keys(wallet.balances).forEach(asset => {
      const balance = wallet.balances[asset];
      const available = new Decimal(balance.available);
      const locked = new Decimal(balance.locked);
      const total = available.plus(locked);
      const price = prices[asset] || 0;
      const value = total.times(price);
      
      totalValue = totalValue.plus(value);
      
      enrichedBalances[asset] = {
        asset,
        available: balance.available,
        locked: balance.locked,
        total: total.toFixed(),
        usdtValue: value.toFixed(2)
      };
    });

    res.json({
      success: true,
      data: {
        balances: enrichedBalances,
        totalValue: totalValue.toFixed(2)
      }
    });
  } catch (error) {
    console.error('Get balances error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve balances'
    });
  }
});

// @route   GET /api/wallet/balance/:asset
// @desc    Get specific asset balance
// @access  Private
router.get('/balance/:asset', (req, res) => {
  try {
    const userId = req.user.id;
    const { asset } = req.params;
    
    const wallet = getUserWallet(userId);
    const balance = getAssetBalance(wallet, asset.toUpperCase());

    res.json({
      success: true,
      data: {
        asset: asset.toUpperCase(),
        available: balance.available,
        locked: balance.locked,
        total: new Decimal(balance.available).plus(balance.locked).toFixed()
      }
    });
  } catch (error) {
    console.error('Get balance error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve balance'
    });
  }
});

// @route   POST /api/wallet/deposit
// @desc    Generate deposit address
// @access  Private
router.post('/deposit', [
  body('asset').notEmpty().withMessage('Asset is required'),
  body('network').optional().isString().withMessage('Network must be a string')
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
    const { asset, network } = req.body;

    // Mock address generation
    const addresses = {
      'BTC': 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
      'ETH': '0x742C4A3e35e2C7c4e85b75e3B6C3aE7e9D3e4B1A',
      'USDT': {
        'ERC20': '0x742C4A3e35e2C7c4e85b75e3B6C3aE7e9D3e4B1A',
        'TRC20': 'TRX9yTMJ3M2E3Z8p7Q6X5V8N4L2K9H7F6E',
        'BEP20': 'bnb1jxfh2g7jkhgfdsa98uiojklmnbvcxz123456789'
      }
    };

    let address;
    let networkInfo;

    if (typeof addresses[asset.toUpperCase()] === 'string') {
      address = addresses[asset.toUpperCase()];
      networkInfo = asset.toUpperCase();
    } else if (addresses[asset.toUpperCase()]) {
      const assetNetworks = addresses[asset.toUpperCase()];
      const selectedNetwork = network || Object.keys(assetNetworks)[0];
      address = assetNetworks[selectedNetwork];
      networkInfo = selectedNetwork;
    } else {
      return res.status(400).json({
        success: false,
        message: 'Unsupported asset'
      });
    }

    // Mock minimum deposit amount
    const minDeposit = {
      'BTC': '0.001',
      'ETH': '0.01',
      'USDT': '10',
      'USD': '10'
    };

    res.json({
      success: true,
      data: {
        asset: asset.toUpperCase(),
        network: networkInfo,
        address,
        minDeposit: minDeposit[asset.toUpperCase()] || '1',
        memo: asset.toUpperCase() === 'XRP' ? `${userId}` : null,
        qrCode: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==`
      }
    });
  } catch (error) {
    console.error('Generate deposit address error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to generate deposit address'
    });
  }
});

// @route   POST /api/wallet/withdraw
// @desc    Request withdrawal
// @access  Private
router.post('/withdraw', [
  body('asset').notEmpty().withMessage('Asset is required'),
  body('amount').isFloat({ gt: 0 }).withMessage('Amount must be greater than 0'),
  body('address').notEmpty().withMessage('Address is required'),
  body('network').optional().isString().withMessage('Network must be a string'),
  body('memo').optional().isString().withMessage('Memo must be a string')
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
    const { asset, amount, address, network, memo } = req.body;

    const wallet = getUserWallet(userId);
    const balance = getAssetBalance(wallet, asset.toUpperCase());

    // Check balance
    const requestedAmount = new Decimal(amount);
    const availableBalance = new Decimal(balance.available);

    if (requestedAmount.gt(availableBalance)) {
      return res.status(400).json({
        success: false,
        message: 'Insufficient balance'
      });
    }

    // Mock withdrawal fee
    const withdrawalFees = {
      'BTC': '0.0005',
      'ETH': '0.005',
      'USDT': '1.0',
      'USD': '0.0'
    };

    const fee = new Decimal(withdrawalFees[asset.toUpperCase()] || '0');
    const totalAmount = requestedAmount.plus(fee);

    if (totalAmount.gt(availableBalance)) {
      return res.status(400).json({
        success: false,
        message: `Insufficient balance to cover withdrawal fee. Required: ${totalAmount.toFixed()}, Available: ${availableBalance.toFixed()}`
      });
    }

    // Create withdrawal transaction
    const transaction = {
      id: transactionId++,
      userId,
      type: 'withdraw',
      asset: asset.toUpperCase(),
      amount: requestedAmount.toFixed(),
      fee: fee.toFixed(),
      toAddress: address,
      network: network || asset.toUpperCase(),
      memo: memo || null,
      status: 'pending',
      txHash: null,
      createdAt: new Date().toISOString(),
      completedAt: null
    };

    transactions.push(transaction);

    // Update balance (lock funds)
    balance.available = availableBalance.minus(totalAmount).toFixed();
    balance.locked = new Decimal(balance.locked).plus(totalAmount).toFixed();

    // Simulate processing after delay
    setTimeout(() => {
      transaction.status = 'processing';
      transaction.txHash = `0x${Math.random().toString(16).substr(2, 64)}`;
      
      // Emit update via WebSocket
      if (global.io) {
        global.io.to(`user-${userId}`).emit('withdrawalUpdate', transaction);
      }

      // Complete withdrawal after another delay
      setTimeout(() => {
        transaction.status = 'completed';
        transaction.completedAt = new Date().toISOString();
        
        // Remove from locked balance
        const currentBalance = getAssetBalance(wallet, asset.toUpperCase());
        currentBalance.locked = new Decimal(currentBalance.locked).minus(totalAmount).toFixed();

        // Emit completion via WebSocket
        if (global.io) {
          global.io.to(`user-${userId}`).emit('withdrawalCompleted', transaction);
        }
      }, 30000); // Complete after 30 seconds
    }, 5000); // Start processing after 5 seconds

    res.status(201).json({
      success: true,
      message: 'Withdrawal request submitted',
      data: transaction
    });
  } catch (error) {
    console.error('Withdrawal error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to process withdrawal'
    });
  }
});

// @route   GET /api/wallet/transactions
// @desc    Get transaction history
// @access  Private
router.get('/transactions', (req, res) => {
  try {
    const userId = req.user.id;
    const { 
      type, 
      asset, 
      status, 
      startTime, 
      endTime, 
      limit = 50, 
      offset = 0 
    } = req.query;

    let userTransactions = transactions.filter(tx => tx.userId === userId);

    // Apply filters
    if (type) {
      userTransactions = userTransactions.filter(tx => tx.type === type);
    }

    if (asset) {
      userTransactions = userTransactions.filter(tx => tx.asset === asset.toUpperCase());
    }

    if (status) {
      userTransactions = userTransactions.filter(tx => tx.status === status);
    }

    if (startTime) {
      userTransactions = userTransactions.filter(tx => 
        new Date(tx.createdAt) >= new Date(startTime)
      );
    }

    if (endTime) {
      userTransactions = userTransactions.filter(tx => 
        new Date(tx.createdAt) <= new Date(endTime)
      );
    }

    // Pagination
    const total = userTransactions.length;
    const paginatedTransactions = userTransactions
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
    console.error('Get transactions error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve transactions'
    });
  }
});

// @route   GET /api/wallet/transaction/:txId
// @desc    Get transaction details
// @access  Private
router.get('/transaction/:txId', (req, res) => {
  try {
    const userId = req.user.id;
    const { txId } = req.params;

    const transaction = transactions.find(
      tx => tx.id === parseInt(txId) && tx.userId === userId
    );

    if (!transaction) {
      return res.status(404).json({
        success: false,
        message: 'Transaction not found'
      });
    }

    res.json({
      success: true,
      data: transaction
    });
  } catch (error) {
    console.error('Get transaction error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve transaction'
    });
  }
});

// @route   GET /api/wallet/networks/:asset
// @desc    Get supported networks for an asset
// @access  Private
router.get('/networks/:asset', (req, res) => {
  try {
    const { asset } = req.params;

    const networks = {
      'BTC': [
        { network: 'BTC', name: 'Bitcoin', fee: '0.0005', minDeposit: '0.001', minWithdraw: '0.001' }
      ],
      'ETH': [
        { network: 'ERC20', name: 'Ethereum', fee: '0.005', minDeposit: '0.01', minWithdraw: '0.01' }
      ],
      'USDT': [
        { network: 'ERC20', name: 'Ethereum', fee: '5.0', minDeposit: '10', minWithdraw: '10' },
        { network: 'TRC20', name: 'Tron', fee: '1.0', minDeposit: '10', minWithdraw: '10' },
        { network: 'BEP20', name: 'BSC', fee: '0.8', minDeposit: '10', minWithdraw: '10' }
      ]
    };

    const assetNetworks = networks[asset.toUpperCase()];
    
    if (!assetNetworks) {
      return res.status(404).json({
        success: false,
        message: 'Asset not supported'
      });
    }

    res.json({
      success: true,
      data: assetNetworks
    });
  } catch (error) {
    console.error('Get networks error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve networks'
    });
  }
});

module.exports = router;
