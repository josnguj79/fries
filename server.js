import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@libsql/client';
import { crypto } from 'crypto';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors()); // Allows request from your frontend (GitHub Pages or local)
app.use(express.json());

// Initialize Turso Client
const turso = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// Health check endpoint (for pinging to prevent Render cold-starts)
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date() });
});

// POST Endpoint: Create Order
app.post('/api/orders/create', async (req, res) => {
  try {
    const { customerPhone, deliveryLocation, items, totalAmount } = req.body;

    // Basic Validation
    if (!customerPhone || !deliveryLocation || !items || !totalAmount) {
      return res.status(400).json({ 
        success: false, 
        message: 'Missing required order fields.' 
      });
    }

    // Generate unique order ID (e.g., KF-8F32A)
    const orderId = `KF-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;

    // Convert items array to JSON string for database storage
    const itemsJson = JSON.stringify(items);

    // Save order into Turso DB
    await turso.execute({
      sql: `INSERT INTO orders (id, customer_phone, delivery_location, items, total_amount, status)
            VALUES (?, ?, ?, ?, ?, 'PENDING_DISPATCH')`,
      args: [orderId, customerPhone, deliveryLocation, itemsJson, totalAmount],
    });

    console.log(`[Order Created] ${orderId} for ${customerPhone}`);

    // TODO: Trigger Meta WhatsApp Dispatch Engine here (broadcasting to riders)

    // Respond back to frontend
    return res.status(201).json({
      success: true,
      message: 'Order created successfully and queued for dispatch.',
      orderId: orderId,
    });

  } catch (error) {
    console.error('Turso DB Error:', error);
    return res.status(500).json({ 
      success: false, 
      message: 'Internal server error saving order.' 
    });
  }
});

// Start Express Server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});