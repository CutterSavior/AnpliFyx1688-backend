const express = require('express');
const { body, validationResult } = require('express-validator');
const Decimal = require('decimal.js');

const router = express.Router();

// This is a simplified version - in trading.js we have more comprehensive order management
// This file focuses on order book and matching engine functionality

// Mock order book
const orderBooks = {
  'BTCUSDT': {
    bids: [], // Array of {price, quantity, userId, orderId, timestamp}
    asks: []
  },
  'ETHUSDT': {
    bids: [],
    asks: []
  }
};

// Mock filled orders
let filledOrders = [];
let orderId = 1000;

// Helper function to add order to book
const addToOrderBook = (order) => {
  const { symbol, side, price, quantity, userId } = order;
  
  if (!orderBooks[symbol]) {
    orderBooks[symbol] = { bids: [], asks: [] };
  }

  const bookOrder = {
    id: orderId++,
    price: new Decimal(price).toFixed(),
    quantity: new Decimal(quantity).toFixed(),
    userId,
    timestamp: new Date(),
    originalQuantity: new Decimal(quantity).toFixed()
  };

  if (side === 'BUY') {
    orderBooks[symbol].bids.push(bookOrder);
    // Sort bids by price descending (highest price first)
    orderBooks[symbol].bids.sort((a, b) => new Decimal(b.price).minus(a.price).toNumber());
  } else {
    orderBooks[symbol].asks.push(bookOrder);
    // Sort asks by price ascending (lowest price first)
    orderBooks[symbol].asks.sort((a, b) => new Decimal(a.price).minus(b.price).toNumber());
  }

  return bookOrder;
};

// Helper function to match orders
const matchOrders = (symbol) => {
  const book = orderBooks[symbol];
  if (!book || book.bids.length === 0 || book.asks.length === 0) {
    return [];
  }

  const matches = [];
  let bidIndex = 0;
  let askIndex = 0;

  while (bidIndex < book.bids.length && askIndex < book.asks.length) {
    const bid = book.bids[bidIndex];
    const ask = book.asks[askIndex];

    const bidPrice = new Decimal(bid.price);
    const askPrice = new Decimal(ask.price);

    // No match if bid price < ask price
    if (bidPrice.lt(askPrice)) {
      break;
    }

    // Match found
    const bidQty = new Decimal(bid.quantity);
    const askQty = new Decimal(ask.quantity);
    const matchedQty = Decimal.min(bidQty, askQty);
    const matchedPrice = askPrice; // Price priority: ask price (first come, first served)

    const trade = {
      id: Date.now() + Math.random(),
      symbol,
      buyOrderId: bid.id,
      sellOrderId: ask.id,
      buyerId: bid.userId,
      sellerId: ask.userId,
      price: matchedPrice.toFixed(),
      quantity: matchedQty.toFixed(),
      timestamp: new Date().toISOString()
    };

    matches.push(trade);
    filledOrders.push(trade);

    // Update quantities
    bid.quantity = bidQty.minus(matchedQty).toFixed();
    ask.quantity = askQty.minus(matchedQty).toFixed();

    // Remove filled orders
    if (new Decimal(bid.quantity).eq(0)) {
      book.bids.splice(bidIndex, 1);
    } else {
      bidIndex++;
    }

    if (new Decimal(ask.quantity).eq(0)) {
      book.asks.splice(askIndex, 1);
    } else {
      askIndex++;
    }
  }

  return matches;
};

// @route   GET /api/orders/book/:symbol
// @desc    Get order book for a symbol
// @access  Private
router.get('/book/:symbol', (req, res) => {
  try {
    const { symbol } = req.params;
    const { depth = 20 } = req.query;

    const book = orderBooks[symbol.toUpperCase()];
    if (!book) {
      return res.status(404).json({
        success: false,
        message: 'Symbol not found'
      });
    }

    const maxDepth = Math.min(parseInt(depth), 100);

    // Aggregate orders by price level
    const aggregateBids = {};
    const aggregateAsks = {};

    book.bids.slice(0, maxDepth).forEach(order => {
      const price = order.price;
      if (!aggregateBids[price]) {
        aggregateBids[price] = new Decimal(0);
      }
      aggregateBids[price] = aggregateBids[price].plus(order.quantity);
    });

    book.asks.slice(0, maxDepth).forEach(order => {
      const price = order.price;
      if (!aggregateAsks[price]) {
        aggregateAsks[price] = new Decimal(0);
      }
      aggregateAsks[price] = aggregateAsks[price].plus(order.quantity);
    });

    // Convert to arrays and sort
    const bids = Object.entries(aggregateBids)
      .map(([price, quantity]) => [price, quantity.toFixed()])
      .sort((a, b) => new Decimal(b[0]).minus(a[0]).toNumber());

    const asks = Object.entries(aggregateAsks)
      .map(([price, quantity]) => [price, quantity.toFixed()])
      .sort((a, b) => new Decimal(a[0]).minus(b[0]).toNumber());

    res.json({
      success: true,
      data: {
        symbol: symbol.toUpperCase(),
        lastUpdateId: Date.now(),
        bids,
        asks
      }
    });
  } catch (error) {
    console.error('Get order book error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve order book'
    });
  }
});

// @route   POST /api/orders/limit
// @desc    Place a limit order
// @access  Private
router.post('/limit', [
  body('symbol').notEmpty().withMessage('Symbol is required'),
  body('side').isIn(['BUY', 'SELL']).withMessage('Side must be BUY or SELL'),
  body('quantity').isFloat({ gt: 0 }).withMessage('Quantity must be greater than 0'),
  body('price').isFloat({ gt: 0 }).withMessage('Price must be greater than 0')
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

    const { symbol, side, quantity, price } = req.body;
    const userId = req.user.id;

    // Add order to book
    const order = addToOrderBook({
      symbol: symbol.toUpperCase(),
      side,
      quantity,
      price,
      userId
    });

    // Try to match orders
    const matches = matchOrders(symbol.toUpperCase());

    // Emit order book updates via WebSocket
    if (global.io) {
      global.io.to(`market-${symbol.toUpperCase()}`).emit('orderBookUpdate', {
        symbol: symbol.toUpperCase(),
        bids: orderBooks[symbol.toUpperCase()].bids.slice(0, 20),
        asks: orderBooks[symbol.toUpperCase()].asks.slice(0, 20)
      });

      // Emit trade updates
      matches.forEach(trade => {
        global.io.to(`market-${symbol.toUpperCase()}`).emit('trade', trade);
        global.io.to(`user-${trade.buyerId}`).emit('tradeUpdate', trade);
        global.io.to(`user-${trade.sellerId}`).emit('tradeUpdate', trade);
      });
    }

    res.status(201).json({
      success: true,
      message: 'Limit order placed successfully',
      data: {
        order,
        matches: matches.length
      }
    });
  } catch (error) {
    console.error('Place limit order error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to place limit order'
    });
  }
});

// @route   POST /api/orders/market
// @desc    Place a market order
// @access  Private
router.post('/market', [
  body('symbol').notEmpty().withMessage('Symbol is required'),
  body('side').isIn(['BUY', 'SELL']).withMessage('Side must be BUY or SELL'),
  body('quantity').isFloat({ gt: 0 }).withMessage('Quantity must be greater than 0')
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

    const { symbol, side, quantity } = req.body;
    const userId = req.user.id;

    const book = orderBooks[symbol.toUpperCase()];
    if (!book) {
      return res.status(400).json({
        success: false,
        message: 'No order book for symbol'
      });
    }

    const oppositeOrders = side === 'BUY' ? book.asks : book.bids;
    if (oppositeOrders.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No liquidity available'
      });
    }

    let remainingQty = new Decimal(quantity);
    const fills = [];
    let orderIndex = 0;

    while (remainingQty.gt(0) && orderIndex < oppositeOrders.length) {
      const order = oppositeOrders[orderIndex];
      const orderQty = new Decimal(order.quantity);
      const fillQty = Decimal.min(remainingQty, orderQty);

      const fill = {
        id: Date.now() + Math.random(),
        symbol: symbol.toUpperCase(),
        price: order.price,
        quantity: fillQty.toFixed(),
        timestamp: new Date().toISOString(),
        makerId: order.userId,
        takerId: userId,
        side
      };

      fills.push(fill);
      filledOrders.push(fill);

      // Update order quantity
      order.quantity = orderQty.minus(fillQty).toFixed();
      remainingQty = remainingQty.minus(fillQty);

      // Remove filled order
      if (new Decimal(order.quantity).eq(0)) {
        oppositeOrders.splice(orderIndex, 1);
      } else {
        orderIndex++;
      }
    }

    // Calculate average fill price
    let totalValue = new Decimal(0);
    let totalQty = new Decimal(0);
    
    fills.forEach(fill => {
      const value = new Decimal(fill.price).times(fill.quantity);
      totalValue = totalValue.plus(value);
      totalQty = totalQty.plus(fill.quantity);
    });

    const avgPrice = totalQty.gt(0) ? totalValue.div(totalQty) : new Decimal(0);

    // Emit updates via WebSocket
    if (global.io) {
      global.io.to(`market-${symbol.toUpperCase()}`).emit('orderBookUpdate', {
        symbol: symbol.toUpperCase(),
        bids: book.bids.slice(0, 20),
        asks: book.asks.slice(0, 20)
      });

      fills.forEach(fill => {
        global.io.to(`market-${symbol.toUpperCase()}`).emit('trade', fill);
        global.io.to(`user-${fill.makerId}`).emit('tradeUpdate', fill);
        global.io.to(`user-${fill.takerId}`).emit('tradeUpdate', fill);
      });
    }

    res.status(201).json({
      success: true,
      message: 'Market order executed successfully',
      data: {
        symbol: symbol.toUpperCase(),
        side,
        requestedQuantity: quantity,
        filledQuantity: totalQty.toFixed(),
        averagePrice: avgPrice.toFixed(),
        fills: fills.length,
        partialFill: remainingQty.gt(0)
      }
    });
  } catch (error) {
    console.error('Place market order error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to place market order'
    });
  }
});

// @route   DELETE /api/orders/:orderId
// @desc    Cancel an order
// @access  Private
router.delete('/:orderId', (req, res) => {
  try {
    const { orderId } = req.params;
    const userId = req.user.id;

    let orderFound = false;
    let cancelledOrder = null;

    // Search in all order books
    Object.keys(orderBooks).forEach(symbol => {
      const book = orderBooks[symbol];
      
      // Check bids
      const bidIndex = book.bids.findIndex(order => 
        order.id === parseInt(orderId) && order.userId === userId
      );
      
      if (bidIndex !== -1) {
        cancelledOrder = book.bids.splice(bidIndex, 1)[0];
        cancelledOrder.symbol = symbol;
        cancelledOrder.side = 'BUY';
        orderFound = true;
        return;
      }

      // Check asks
      const askIndex = book.asks.findIndex(order => 
        order.id === parseInt(orderId) && order.userId === userId
      );
      
      if (askIndex !== -1) {
        cancelledOrder = book.asks.splice(askIndex, 1)[0];
        cancelledOrder.symbol = symbol;
        cancelledOrder.side = 'SELL';
        orderFound = true;
        return;
      }
    });

    if (!orderFound) {
      return res.status(404).json({
        success: false,
        message: 'Order not found or already filled/cancelled'
      });
    }

    // Emit order book update via WebSocket
    if (global.io && cancelledOrder) {
      global.io.to(`market-${cancelledOrder.symbol}`).emit('orderBookUpdate', {
        symbol: cancelledOrder.symbol,
        bids: orderBooks[cancelledOrder.symbol].bids.slice(0, 20),
        asks: orderBooks[cancelledOrder.symbol].asks.slice(0, 20)
      });

      global.io.to(`user-${userId}`).emit('orderCancelled', {
        orderId: parseInt(orderId),
        symbol: cancelledOrder.symbol,
        side: cancelledOrder.side
      });
    }

    res.json({
      success: true,
      message: 'Order cancelled successfully',
      data: {
        orderId: parseInt(orderId),
        symbol: cancelledOrder.symbol,
        side: cancelledOrder.side,
        cancelledQuantity: cancelledOrder.quantity
      }
    });
  } catch (error) {
    console.error('Cancel order error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to cancel order'
    });
  }
});

// @route   GET /api/orders/my-orders
// @desc    Get user's active orders
// @access  Private
router.get('/my-orders', (req, res) => {
  try {
    const userId = req.user.id;
    const { symbol } = req.query;

    const userOrders = [];

    Object.keys(orderBooks).forEach(sym => {
      if (symbol && sym !== symbol.toUpperCase()) {
        return;
      }

      const book = orderBooks[sym];
      
      // Add user's bids
      book.bids.forEach(order => {
        if (order.userId === userId) {
          userOrders.push({
            ...order,
            symbol: sym,
            side: 'BUY'
          });
        }
      });

      // Add user's asks
      book.asks.forEach(order => {
        if (order.userId === userId) {
          userOrders.push({
            ...order,
            symbol: sym,
            side: 'SELL'
          });
        }
      });
    });

    // Sort by timestamp (newest first)
    userOrders.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    res.json({
      success: true,
      data: userOrders
    });
  } catch (error) {
    console.error('Get user orders error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve user orders'
    });
  }
});

// @route   GET /api/orders/recent-trades/:symbol
// @desc    Get recent trades for a symbol
// @access  Private
router.get('/recent-trades/:symbol', (req, res) => {
  try {
    const { symbol } = req.params;
    const { limit = 50 } = req.query;

    const recentTrades = filledOrders
      .filter(trade => trade.symbol === symbol.toUpperCase())
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, parseInt(limit));

    res.json({
      success: true,
      data: recentTrades
    });
  } catch (error) {
    console.error('Get recent trades error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve recent trades'
    });
  }
});

module.exports = router;
