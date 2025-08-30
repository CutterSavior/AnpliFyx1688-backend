const express = require('express');
const { optionalAuth } = require('../middleware/auth');

const router = express.Router();

// Mock market data
const marketData = {
  'BTCUSDT': {
    symbol: 'BTCUSDT',
    price: '47123.45',
    priceChange: '1234.56',
    priceChangePercent: '2.69',
    high24h: '48500.00',
    low24h: '45000.00',
    volume24h: '12345.67',
    quoteVolume24h: '567890123.45',
    openTime: Date.now() - 24 * 60 * 60 * 1000,
    closeTime: Date.now()
  },
  'ETHUSDT': {
    symbol: 'ETHUSDT',
    price: '2987.65',
    priceChange: '-45.32',
    priceChangePercent: '-1.49',
    high24h: '3100.00',
    low24h: '2900.00',
    volume24h: '45678.90',
    quoteVolume24h: '136789012.34',
    openTime: Date.now() - 24 * 60 * 60 * 1000,
    closeTime: Date.now()
  },
  'AAPL': {
    symbol: 'AAPL',
    price: '150.25',
    priceChange: '2.15',
    priceChangePercent: '1.45',
    high24h: '152.00',
    low24h: '148.50',
    volume24h: '1234567',
    quoteVolume24h: '185432100.25',
    openTime: Date.now() - 24 * 60 * 60 * 1000,
    closeTime: Date.now()
  },
  'EURUSD': {
    symbol: 'EURUSD',
    price: '1.08245',
    priceChange: '0.00123',
    priceChangePercent: '0.11',
    high24h: '1.08500',
    low24h: '1.08000',
    volume24h: '987654321',
    quoteVolume24h: '1069123456.78',
    openTime: Date.now() - 24 * 60 * 60 * 1000,
    closeTime: Date.now()
  }
};

// Generate random kline data
const generateKlineData = (symbol, interval, limit) => {
  const data = [];
  const now = Date.now();
  const intervalMs = {
    '1m': 60 * 1000,
    '5m': 5 * 60 * 1000,
    '15m': 15 * 60 * 1000,
    '1h': 60 * 60 * 1000,
    '4h': 4 * 60 * 60 * 1000,
    '1d': 24 * 60 * 60 * 1000
  };

  const basePrice = parseFloat(marketData[symbol]?.price || '50000');
  
  for (let i = limit - 1; i >= 0; i--) {
    const openTime = now - (i * intervalMs[interval]);
    const closeTime = openTime + intervalMs[interval] - 1;
    
    const open = basePrice + (Math.random() - 0.5) * basePrice * 0.02;
    const close = open + (Math.random() - 0.5) * open * 0.01;
    const high = Math.max(open, close) + Math.random() * Math.max(open, close) * 0.005;
    const low = Math.min(open, close) - Math.random() * Math.min(open, close) * 0.005;
    const volume = Math.random() * 1000;

    data.push([
      openTime,
      open.toFixed(2),
      high.toFixed(2),
      low.toFixed(2),
      close.toFixed(2),
      volume.toFixed(8),
      closeTime,
      (volume * close).toFixed(8),
      Math.floor(Math.random() * 100),
      (volume * 0.6).toFixed(8),
      (volume * close * 0.6).toFixed(8),
      '0'
    ]);
  }

  return data;
};

// @route   GET /api/market/ticker
// @desc    Get ticker data for all symbols or specific symbol
// @access  Public
router.get('/ticker', optionalAuth, (req, res) => {
  try {
    const { symbol } = req.query;

    if (symbol) {
      const ticker = marketData[symbol.toUpperCase()];
      if (!ticker) {
        return res.status(404).json({
          success: false,
          message: 'Symbol not found'
        });
      }

      return res.json({
        success: true,
        data: ticker
      });
    }

    // Return all tickers
    const tickers = Object.values(marketData);
    
    res.json({
      success: true,
      data: tickers
    });
  } catch (error) {
    console.error('Get ticker error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve ticker data'
    });
  }
});

// @route   GET /api/market/klines
// @desc    Get kline/candlestick data
// @access  Public
router.get('/klines', optionalAuth, (req, res) => {
  try {
    const { symbol, interval = '1h', limit = 100 } = req.query;

    if (!symbol) {
      return res.status(400).json({
        success: false,
        message: 'Symbol is required'
      });
    }

    const validIntervals = ['1m', '5m', '15m', '1h', '4h', '1d'];
    if (!validIntervals.includes(interval)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid interval'
      });
    }

    const klineLimit = Math.min(parseInt(limit), 1000);
    const klines = generateKlineData(symbol.toUpperCase(), interval, klineLimit);

    res.json({
      success: true,
      data: klines
    });
  } catch (error) {
    console.error('Get klines error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve kline data'
    });
  }
});

// @route   GET /api/market/depth
// @desc    Get order book depth
// @access  Public
router.get('/depth', optionalAuth, (req, res) => {
  try {
    const { symbol, limit = 100 } = req.query;

    if (!symbol) {
      return res.status(400).json({
        success: false,
        message: 'Symbol is required'
      });
    }

    const ticker = marketData[symbol.toUpperCase()];
    if (!ticker) {
      return res.status(404).json({
        success: false,
        message: 'Symbol not found'
      });
    }

    const basePrice = parseFloat(ticker.price);
    const depthLimit = Math.min(parseInt(limit), 1000);
    
    // Generate mock order book
    const bids = [];
    const asks = [];

    for (let i = 0; i < depthLimit; i++) {
      const bidPrice = (basePrice - (i + 1) * basePrice * 0.0001).toFixed(2);
      const bidQuantity = (Math.random() * 10).toFixed(8);
      bids.push([bidPrice, bidQuantity]);

      const askPrice = (basePrice + (i + 1) * basePrice * 0.0001).toFixed(2);
      const askQuantity = (Math.random() * 10).toFixed(8);
      asks.push([askPrice, askQuantity]);
    }

    res.json({
      success: true,
      data: {
        lastUpdateId: Date.now(),
        bids,
        asks
      }
    });
  } catch (error) {
    console.error('Get depth error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve depth data'
    });
  }
});

// @route   GET /api/market/trades
// @desc    Get recent trades
// @access  Public
router.get('/trades', optionalAuth, (req, res) => {
  try {
    const { symbol, limit = 50 } = req.query;

    if (!symbol) {
      return res.status(400).json({
        success: false,
        message: 'Symbol is required'
      });
    }

    const ticker = marketData[symbol.toUpperCase()];
    if (!ticker) {
      return res.status(404).json({
        success: false,
        message: 'Symbol not found'
      });
    }

    const basePrice = parseFloat(ticker.price);
    const tradesLimit = Math.min(parseInt(limit), 1000);
    const trades = [];

    for (let i = 0; i < tradesLimit; i++) {
      const price = (basePrice + (Math.random() - 0.5) * basePrice * 0.001).toFixed(2);
      const quantity = (Math.random() * 5).toFixed(8);
      const isBuyerMaker = Math.random() > 0.5;

      trades.push({
        id: Date.now() + i,
        price,
        qty: quantity,
        quoteQty: (parseFloat(price) * parseFloat(quantity)).toFixed(8),
        time: Date.now() - (i * 1000),
        isBuyerMaker,
        isBestMatch: true
      });
    }

    res.json({
      success: true,
      data: trades.reverse()
    });
  } catch (error) {
    console.error('Get trades error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve trades data'
    });
  }
});

// @route   GET /api/market/stats
// @desc    Get 24hr statistics
// @access  Public
router.get('/stats', optionalAuth, (req, res) => {
  try {
    const { symbol } = req.query;

    if (symbol) {
      const stats = marketData[symbol.toUpperCase()];
      if (!stats) {
        return res.status(404).json({
          success: false,
          message: 'Symbol not found'
        });
      }

      return res.json({
        success: true,
        data: stats
      });
    }

    // Return stats for all symbols
    const allStats = Object.values(marketData);
    
    res.json({
      success: true,
      data: allStats
    });
  } catch (error) {
    console.error('Get stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve statistics'
    });
  }
});

// WebSocket market data simulation
setInterval(() => {
  if (global.io) {
    // Update market data with random changes
    Object.keys(marketData).forEach(symbol => {
      const data = marketData[symbol];
      const oldPrice = parseFloat(data.price);
      const change = (Math.random() - 0.5) * oldPrice * 0.001;
      const newPrice = (oldPrice + change).toFixed(2);
      
      data.price = newPrice;
      data.priceChange = (newPrice - oldPrice).toFixed(2);
      data.priceChangePercent = ((change / oldPrice) * 100).toFixed(2);
      data.closeTime = Date.now();

      // Emit to market rooms
      global.io.to(`market-${symbol}`).emit('ticker', data);
      global.io.to(`ticker-${symbol}`).emit('tickerUpdate', data);
    });
  }
}, 1000); // Update every second

// Note: /anon/v1/market/stock/recommend moved to game.js to avoid duplication

// Note: /anon/v1/wallet/currency moved to game.js to avoid duplication

// Note: /anon/v1/notice/list moved to game.js to avoid duplication

// Note: /anon/v1/support/list moved to game.js to avoid duplication

// Note: /anon/v1/comm/token moved to game.js to avoid duplication

// Note: /anon/v22/contract/item moved to game.js to avoid duplication

module.exports = router;
