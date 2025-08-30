const express = require('express');
const { body, validationResult } = require('express-validator');
const Decimal = require('decimal.js');

const router = express.Router();

// Mock trading data
let trades = [];
let positions = [];
let tradeId = 1;

// @route   GET /api/trading/symbols
// @desc    Get available trading symbols
// @access  Private
router.get('/symbols', (req, res) => {
  const symbols = [
    {
      symbol: 'BTCUSDT',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      status: 'TRADING',
      minQty: '0.00001',
      maxQty: '1000',
      stepSize: '0.00001',
      minPrice: '0.01',
      maxPrice: '100000',
      tickSize: '0.01',
      type: 'crypto'
    },
    {
      symbol: 'ETHUSDT',
      baseAsset: 'ETH',
      quoteAsset: 'USDT',
      status: 'TRADING',
      minQty: '0.0001',
      maxQty: '10000',
      stepSize: '0.0001',
      minPrice: '0.01',
      maxPrice: '10000',
      tickSize: '0.01',
      type: 'crypto'
    },
    {
      symbol: 'AAPL',
      baseAsset: 'AAPL',
      quoteAsset: 'USD',
      status: 'TRADING',
      minQty: '1',
      maxQty: '10000',
      stepSize: '1',
      minPrice: '0.01',
      maxPrice: '1000',
      tickSize: '0.01',
      type: 'stock'
    },
    {
      symbol: 'EURUSD',
      baseAsset: 'EUR',
      quoteAsset: 'USD',
      status: 'TRADING',
      minQty: '1000',
      maxQty: '10000000',
      stepSize: '1000',
      minPrice: '0.00001',
      maxPrice: '2.00000',
      tickSize: '0.00001',
      type: 'forex'
    }
  ];

  res.json({
    success: true,
    data: symbols
  });
});

// @route   POST /api/trading/order
// @desc    Place a new order
// @access  Private
router.post('/order', [
  body('symbol').notEmpty().withMessage('Symbol is required'),
  body('side').isIn(['BUY', 'SELL']).withMessage('Side must be BUY or SELL'),
  body('type').isIn(['MARKET', 'LIMIT', 'STOP']).withMessage('Invalid order type'),
  body('quantity').isFloat({ gt: 0 }).withMessage('Quantity must be greater than 0'),
  body('price').optional().isFloat({ gt: 0 }).withMessage('Price must be greater than 0')
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

    const { symbol, side, type, quantity, price, stopPrice } = req.body;
    const userId = req.user.id;

    // Validate order requirements
    if (type === 'LIMIT' && !price) {
      return res.status(400).json({
        success: false,
        message: 'Price is required for LIMIT orders'
      });
    }

    if (type === 'STOP' && !stopPrice) {
      return res.status(400).json({
        success: false,
        message: 'Stop price is required for STOP orders'
      });
    }

    // Create order
    const order = {
      id: tradeId++,
      userId,
      symbol,
      side,
      type,
      quantity: new Decimal(quantity).toFixed(),
      price: price ? new Decimal(price).toFixed() : null,
      stopPrice: stopPrice ? new Decimal(stopPrice).toFixed() : null,
      status: 'PENDING',
      createdAt: new Date(),
      updatedAt: new Date()
    };

    // Simulate order processing
    setTimeout(() => {
      order.status = 'FILLED';
      order.filledQuantity = order.quantity;
      order.filledPrice = order.price || '50000.00'; // Mock fill price
      order.updatedAt = new Date();

      // Emit order update via WebSocket
      if (global.io) {
        global.io.to(`user-${userId}`).emit('orderUpdate', order);
        global.io.to(`orders-${userId}`).emit('orderFilled', order);
      }
    }, 1000);

    trades.push(order);

    res.status(201).json({
      success: true,
      message: 'Order placed successfully',
      data: order
    });
  } catch (error) {
    console.error('Order placement error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to place order'
    });
  }
});

// @route   GET /api/trading/orders
// @desc    Get user's orders
// @access  Private
router.get('/orders', (req, res) => {
  try {
    const userId = req.user.id;
    const { symbol, status, limit = 50, offset = 0 } = req.query;

    let userOrders = trades.filter(order => order.userId === userId);

    // Apply filters
    if (symbol) {
      userOrders = userOrders.filter(order => order.symbol === symbol);
    }

    if (status) {
      userOrders = userOrders.filter(order => order.status === status);
    }

    // Pagination
    const total = userOrders.length;
    const paginatedOrders = userOrders
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(parseInt(offset), parseInt(offset) + parseInt(limit));

    res.json({
      success: true,
      data: {
        orders: paginatedOrders,
        total,
        limit: parseInt(limit),
        offset: parseInt(offset)
      }
    });
  } catch (error) {
    console.error('Get orders error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve orders'
    });
  }
});

// @route   DELETE /api/trading/order/:orderId
// @desc    Cancel an order
// @access  Private
router.delete('/order/:orderId', (req, res) => {
  try {
    const { orderId } = req.params;
    const userId = req.user.id;

    const orderIndex = trades.findIndex(
      order => order.id === parseInt(orderId) && order.userId === userId
    );

    if (orderIndex === -1) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }

    const order = trades[orderIndex];

    if (order.status === 'FILLED' || order.status === 'CANCELLED') {
      return res.status(400).json({
        success: false,
        message: 'Cannot cancel order in current status'
      });
    }

    order.status = 'CANCELLED';
    order.updatedAt = new Date();

    // Emit order update via WebSocket
    if (global.io) {
      global.io.to(`user-${userId}`).emit('orderUpdate', order);
      global.io.to(`orders-${userId}`).emit('orderCancelled', order);
    }

    res.json({
      success: true,
      message: 'Order cancelled successfully',
      data: order
    });
  } catch (error) {
    console.error('Cancel order error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to cancel order'
    });
  }
});

// @route   GET /api/trading/positions
// @desc    Get user's positions
// @access  Private
router.get('/positions', (req, res) => {
  try {
    const userId = req.user.id;
    
    // Mock positions data
    const userPositions = [
      {
        symbol: 'BTCUSDT',
        side: 'LONG',
        size: '0.5',
        entryPrice: '45000.00',
        markPrice: '47000.00',
        pnl: '1000.00',
        pnlPercentage: '4.44',
        margin: '4500.00',
        leverage: '10',
        liquidationPrice: '40500.00'
      },
      {
        symbol: 'ETHUSDT',
        side: 'SHORT',
        size: '2.0',
        entryPrice: '3000.00',
        markPrice: '2950.00',
        pnl: '100.00',
        pnlPercentage: '1.67',
        margin: '600.00',
        leverage: '10',
        liquidationPrice: '3300.00'
      }
    ];

    res.json({
      success: true,
      data: userPositions
    });
  } catch (error) {
    console.error('Get positions error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve positions'
    });
  }
});

// @route   GET /api/trading/history
// @desc    Get trading history
// @access  Private
router.get('/history', (req, res) => {
  try {
    const userId = req.user.id;
    const { symbol, startTime, endTime, limit = 50, offset = 0 } = req.query;

    let userTrades = trades.filter(
      trade => trade.userId === userId && trade.status === 'FILLED'
    );

    // Apply filters
    if (symbol) {
      userTrades = userTrades.filter(trade => trade.symbol === symbol);
    }

    if (startTime) {
      userTrades = userTrades.filter(trade => 
        new Date(trade.createdAt) >= new Date(startTime)
      );
    }

    if (endTime) {
      userTrades = userTrades.filter(trade => 
        new Date(trade.createdAt) <= new Date(endTime)
      );
    }

    // Pagination
    const total = userTrades.length;
    const paginatedTrades = userTrades
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(parseInt(offset), parseInt(offset) + parseInt(limit));

    res.json({
      success: true,
      data: {
        trades: paginatedTrades,
        total,
        limit: parseInt(limit),
        offset: parseInt(offset)
      }
    });
  } catch (error) {
    console.error('Get trading history error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve trading history'
    });
  }
});

module.exports = router;
