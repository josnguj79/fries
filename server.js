import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@libsql/client';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors()); // Enables cross-origin requests from frontend
app.use(express.json());

// Initialize Turso Client
const turso = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// Health Check Endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date() });
});

// POST Endpoint: Save Order to Turso DB
app.post('/api/orders/create', async (req, res) => {
  try {
    const { customerPhone, deliveryLocation, items, totalAmount } = req.body;

    // 1. Basic Validation
    if (!customerPhone || !deliveryLocation || !items || !totalAmount) {
      return res.status(400).json({ 
        success: false, 
        message: 'Missing required order fields.' 
      });
    }

    // 2. Generate Unique Order ID (e.g., KF-7B2A9)
    const orderId = `KF-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;

    // 3. Serialize items array into JSON string
    const itemsJson = JSON.stringify(items);

    // 4. Insert row into Turso DB
    await turso.execute({
      sql: `INSERT INTO orders (id, customer_phone, delivery_location, items, total_amount, status)
            VALUES (?, ?, ?, ?, ?, 'PENDING_DISPATCH')`,
      args: [orderId, customerPhone, deliveryLocation, itemsJson, totalAmount],
    });

    console.log(`[Turso DB] Order saved successfully: ${orderId}`);

    // 5. Success Response
    return res.status(201).json({
      success: true,
      message: 'Order saved to database successfully.',
      orderId: orderId,
    });

  } catch (error) {
    console.error('[Turso DB Error]:', error);
    return res.status(500).json({ 
      success: false, 
      message: 'Failed to insert order into database.',
      error: error.message
    });
  }
});

// Start Express Server
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
