import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@libsql/client';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const frontendUrl = process.env.FRONTEND_URL || 'https://kimanafries.com';

// Enable CORS for all origins & explicitly handle preflight OPTIONS
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.options('*', cors()); // Enable preflight across-the-board

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

// Helper: Send WhatsApp Message via Meta Cloud API
async function sendWhatsAppMessage(payload) {
  const url = `https://graph.facebook.com/v20.0/${process.env.WA_PHONE_NUMBER_ID}/messages`;
  
  try {
    const msgSummary = payload.type === 'text' 
      ? payload.text?.body 
      : 'Interactive/Media Message';

    console.log(`[WhatsApp Outbound] To: ${payload.to} | Message: "${msgSummary.replace(/\n/g, ' ')}"`);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.WA_SYSTEM_USER_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    if (!response.ok) {
      console.error('[WhatsApp Outbound Failed]:', data.error?.message || data);
    }
    return data;
  } catch (err) {
    console.error('[Meta API Fetch Error]:', err);
  }
}

// Helper: Notify Manager via WhatsApp
async function notifyManager(messageText) {
  const managerPhone = process.env.MANAGER_PHONE;
  if (!managerPhone) {
    console.log('[Manager Alert Error] MANAGER_PHONE environment variable is not set.');
    return;
  }

  const payload = {
    messaging_product: 'whatsapp',
    to: managerPhone,
    type: 'text',
    text: { body: messageText }
  };

  await sendWhatsAppMessage(payload);
}

// Helper: Broadcast Order with Claim Link to Active Boda Riders
async function broadcastOrderToRiders(orderId, deliveryLocation, totalAmount, items) {
  const itemsSummary = items.map(i => `${i.qty}x ${i.name}`).join(', ');
  const claimLink = `${frontendUrl}/claim.html?orderId=${orderId}`;

  // Fetch available riders from Turso
  const ridersResult = await turso.execute(`SELECT phone_number FROM riders WHERE is_available = 1`);
  
  if (ridersResult.rows.length === 0) {
    console.log('[Dispatch] No active riders available.');
    await notifyManager(`⚠️ *NO RIDERS AVAILABLE!*\nOrder *${orderId}* was placed, but no riders are active on the platform.`);
    return;
  }

  // Send WhatsApp message with direct Web Claim link
  for (const rider of ridersResult.rows) {
    const riderPhone = rider.phone_number;

    const payload = {
      messaging_product: 'whatsapp',
      to: riderPhone,
      type: 'text',
      text: { 
        body: `🍔 *NEW KIMANA FRIES ORDER!*\n\n` +
              `*Order ID:* ${orderId}\n` +
              `*Location:* ${deliveryLocation}\n` +
              `*Items:* ${itemsSummary}\n` +
              `*Total:* KES ${totalAmount}\n\n` +
              `👉 *Tap link to claim order:* ${claimLink}`
      }
    };

    await sendWhatsAppMessage(payload);
  }
}

// ==========================================
// RIDER MANAGEMENT ENDPOINTS
// ==========================================

app.post('/api/riders/register', async (req, res) => {
  try {
    const { name, phone } = req.body;
    if (!name || !phone) {
      return res.status(400).json({ success: false, message: 'Rider name and phone number required.' });
    }

    const cleanPhone = String(phone).trim();
    const cleanName = String(name).trim();
    const portalLink = `${frontendUrl}/rider.html?phone=${cleanPhone}`;

    await turso.execute({
      sql: `INSERT INTO riders (phone_number, name, is_available) VALUES (?, ?, 0) ON CONFLICT(phone_number) DO UPDATE SET name = excluded.name`,
      args: [cleanPhone, cleanName]
    });

    await sendWhatsAppMessage({
      messaging_product: 'whatsapp',
      to: cleanPhone,
      type: 'text',
      text: {
        body: `👋 *Welcome to BodaSwift, ${cleanName}!*\n\n👉 *Your Personal Shift Portal:* ${portalLink}`
      }
    });

    return res.status(201).json({ success: true, message: 'Rider registered successfully!', portalLink });
  } catch (error) {
    console.error('[Register Rider Exception]:', error);
    return res.status(500).json({ success: false, message: error.message || 'Internal server error.' });
  }
});

app.post('/api/riders/toggle-status', async (req, res) => {
  try {
    const { phone, isAvailable } = req.body;
    if (!phone || isAvailable === undefined) {
      return res.status(400).json({ success: false, message: 'Missing phone or isAvailable status.' });
    }

    const cleanPhone = String(phone).trim();
    const newStatus = isAvailable ? 1 : 0;

    const riderCheck = await turso.execute({
      sql: `SELECT name FROM riders WHERE phone_number = ?`,
      args: [cleanPhone]
    });

    if (riderCheck.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Rider phone number not registered.' });
    }

    const riderName = riderCheck.rows[0].name || 'Rider';

    await turso.execute({
      sql: `UPDATE riders SET is_available = ? WHERE phone_number = ?`,
      args: [newStatus, cleanPhone]
    });

    return res.status(200).json({
      success: true,
      message: `Status updated successfully! You are now ${newStatus === 1 ? 'ONLINE' : 'OFFLINE'}.`,
      isAvailable: newStatus === 1,
      riderName: riderName
    });
  } catch (error) {
    console.error('[Toggle Status Exception]:', error);
    return res.status(500).json({ success: false, message: error.message || 'Internal server error.' });
  }
});

app.get('/api/riders/status', async (req, res) => {
  try {
    const phone = req.query.phone;
    if (!phone) {
      return res.status(400).json({ success: false, message: 'Phone parameter required.' });
    }

    const cleanPhone = String(phone).trim();
    const riderCheck = await turso.execute({
      sql: `SELECT name, is_available FROM riders WHERE phone_number = ?`,
      args: [cleanPhone]
    });

    if (riderCheck.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Rider not found.' });
    }

    const rider = riderCheck.rows[0];
    return res.status(200).json({
      success: true,
      name: rider.name || 'Rider',
      isAvailable: rider.is_available === 1
    });
  } catch (error) {
    console.error('[Rider Status Exception]:', error);
    return res.status(500).json({ success: false, message: error.message || 'Internal server error.' });
  }
});

// ==========================================
// ORDER ENDPOINTS
// ==========================================

app.post('/api/orders/create', async (req, res) => {
  try {
    const { customerPhone, deliveryLocation, items, totalAmount } = req.body;
    if (!customerPhone || !deliveryLocation || !items || !totalAmount) {
      return res.status(400).json({ success: false, message: 'Missing required order fields.' });
    }

    const orderId = `KF-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
    const itemsJson = JSON.stringify(items);
    const itemsSummary = items.map(i => `${i.qty}x ${i.name}`).join(', ');

    await turso.execute({
      sql: `INSERT INTO orders (id, customer_phone, delivery_location, items, total_amount, status) VALUES (?, ?, ?, ?, ?, 'PENDING_DISPATCH')`,
      args: [orderId, customerPhone, deliveryLocation, itemsJson, totalAmount],
    });

    await notifyManager(`🔔 *NEW KITCHEN ORDER RECEIVED!*\n*Order ID:* ${orderId}\n*Total:* KES ${totalAmount}`);
    await broadcastOrderToRiders(orderId, deliveryLocation, totalAmount, items);

    // 3-Minute Timeout Check
    setTimeout(async () => {
      try {
        const orderCheck = await turso.execute({ sql: `SELECT status FROM orders WHERE id = ?`, args: [orderId] });
        if (orderCheck.rows.length > 0 && String(orderCheck.rows[0].status).toUpperCase() === 'PENDING_DISPATCH') {
          await notifyManager(`⚠️ *ORDER TIMEOUT! (#${orderId})* - No rider has claimed it after 3 minutes!`);
        }
      } catch (err) { console.error('[Timeout Error]:', err); }
    }, 3 * 60 * 1000);

    return res.status(201).json({ success: true, message: 'Order created successfully.', orderId });
  } catch (error) {
    console.error('[Create Order Error]:', error);
    return res.status(500).json({ success: false, message: error.message || 'Internal server error.' });
  }
});

app.post('/api/orders/deliver', async (req, res) => {
  try {
    const { orderId, riderPhone } = req.body;
    if (!orderId || !riderPhone) return res.status(400).json({ success: false, message: 'Missing parameters.' });

    const cleanOrderId = String(orderId).trim();
    const cleanPhone = String(riderPhone).trim();

    await turso.execute({
      sql: `UPDATE orders SET status = 'DELIVERED' WHERE id = ? AND rider_id = ?`,
      args: [cleanOrderId, cleanPhone]
    });

    await notifyManager(`🎉 *ORDER DELIVERED! (#${cleanOrderId})* by rider ${cleanPhone}`);
    return res.status(200).json({ success: true, message: 'Order marked delivered!' });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/orders/claim', async (req, res) => {
  try {
    const { orderId, riderPhone } = req.body;
    if (!orderId || !riderPhone) return res.status(400).json({ success: false, message: 'Missing parameters.' });

    const cleanOrderId = String(orderId).trim();
    const cleanPhone = String(riderPhone).trim();

    const checkOrder = await turso.execute({ sql: `SELECT status FROM orders WHERE id = ?`, args: [cleanOrderId] });
    if (checkOrder.rows.length === 0) return res.status(404).json({ success: false, message: 'Order not found.' });

    if (String(checkOrder.rows[0].status).toUpperCase() === 'PENDING_DISPATCH') {
      await turso.execute({
        sql: `UPDATE orders SET status = 'DISPATCHED', rider_id = ? WHERE id = ?`,
        args: [cleanPhone, cleanOrderId]
      });

      await notifyManager(`🛵 *RIDER ASSIGNED! (#${cleanOrderId})* to rider ${cleanPhone}`);
      return res.status(200).json({ success: true, message: 'Order claimed successfully!' });
    } else {
      return res.status(409).json({ success: false, message: 'Order already claimed.' });
    }
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/orders/rider', async (req, res) => {
  try {
    const phone = req.query.phone;
    if (!phone) return res.status(400).json({ success: false, message: 'Phone required.' });

    const cleanPhone = String(phone).trim();
    const ordersResult = await turso.execute({
      sql: `SELECT id, customer_phone, delivery_location, items, total_amount, status, created_at FROM orders WHERE rider_id = ? ORDER BY created_at DESC`,
      args: [cleanPhone]
    });

    const pending = [];
    const completed = [];

    for (const row of ordersResult.rows) {
      let parsedItems = [];
      try { parsedItems = JSON.parse(row.items); } catch (e) { parsedItems = []; }

      const orderObj = {
        id: row.id,
        customerPhone: row.customer_phone,
        deliveryLocation: row.delivery_location,
        items: parsedItems,
        totalAmount: row.total_amount,
        status: row.status,
        createdAt: row.created_at
      };

      if (row.status === 'DISPATCHED') pending.push(orderObj);
      else if (row.status === 'DELIVERED') completed.push(orderObj);
    }

    return res.status(200).json({ success: true, pending, completed });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
