import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@libsql/client';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const frontendUrl = process.env.FRONTEND_URL || 'https://kimanafries.com';

// Enable CORS for all origins & handle preflight OPTIONS
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

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
  const frontendUrl = process.env.FRONTEND_URL || 'https://kimanafries.com';
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

// 1. POST Endpoint: Register New Rider & Initialize Shift Portal Link (Defaults is_available = 0)
app.post('/api/riders/register', async (req, res) => {
  try {
    const { name, phone } = req.body;

    if (!name || !phone) {
      return res.status(400).json({ success: false, message: 'Rider name and phone number required.' });
    }

    const cleanPhone = String(phone).trim();
    const cleanName = String(name).trim();
    const frontendUrl = process.env.FRONTEND_URL || 'https://kimanafries.com';
    const portalLink = `${frontendUrl}/rider.html?phone=${cleanPhone}`;

    // Insert or update rider. Defaults is_available = 0 (OFFLINE)
    await turso.execute({
      sql: `INSERT INTO riders (phone_number, name, is_available) 
            VALUES (?, ?, 0)
            ON CONFLICT(phone_number) DO UPDATE SET name = excluded.name`,
      args: [cleanPhone, cleanName]
    });

    console.log(`[Rider Registered] ${cleanName} (${cleanPhone}) -> Initialized OFFLINE (0)`);

    // Dispatch initialized Shift Portal link via WhatsApp
    await sendWhatsAppMessage({
      messaging_product: 'whatsapp',
      to: cleanPhone,
      type: 'text',
      text: {
        body: `👋 *Welcome to BodaSwift, ${cleanName}!*\n\n` +
              `You are registered as a BodaSwift rider for Kimana Fries.\n` +
              `You are currently marked as *OFFLINE*.\n\n` +
              `👉 *Your Personal Shift Portal:* ${portalLink}\n\n` +
              `_Open the link to toggle your status ONLINE when you're ready for shifts._`
      }
    });

    return res.status(201).json({
      success: true,
      message: 'Rider registered as offline and shift portal link dispatched!',
      portalLink: portalLink
    });

  } catch (error) {
    console.error('[Register Rider Exception]:', error);
    return res.status(500).json({ success: false, message: error.message || 'Internal server error.' });
  }
});

// 2. POST Endpoint: Web-Based Rider Status Toggle
app.post('/api/riders/toggle-status', async (req, res) => {
  try {
    const { phone, isAvailable } = req.body;

    if (!phone || isAvailable === undefined) {
      return res.status(400).json({ success: false, message: 'Missing phone or isAvailable status.' });
    }

    const cleanPhone = String(phone).trim();
    const newStatus = isAvailable ? 1 : 0;

    // Check if rider exists in Turso DB
    const riderCheck = await turso.execute({
      sql: `SELECT name, is_available FROM riders WHERE phone_number = ?`,
      args: [cleanPhone]
    });

    if (riderCheck.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Rider phone number not registered.' });
    }

    const riderName = riderCheck.rows[0].name || 'Rider';

    // Update is_available state in Turso using positional arguments
    await turso.execute({
      sql: `UPDATE riders SET is_available = ? WHERE phone_number = ?`,
      args: [newStatus, cleanPhone]
    });

    console.log(`[Rider Web Status] ${riderName} (${cleanPhone}) set is_available to ${newStatus}`);

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

// 3. GET Endpoint: Fetch Rider Status & Name for rider.html
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
// ORDER DISPATCH ENDPOINTS
// ==========================================

// 4. POST Endpoint: Create Order & Broadcast Claim Link
app.post('/api/orders/create', async (req, res) => {
  try {
    const { customerPhone, deliveryLocation, items, totalAmount } = req.body;

    if (!customerPhone || !deliveryLocation || !items || !totalAmount) {
      return res.status(400).json({ success: false, message: 'Missing required order fields.' });
    }

    const orderId = `KF-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
    const itemsJson = JSON.stringify(items);
    const itemsSummary = items.map(i => `${i.qty}x ${i.name}`).join(', ');

    // Save order in Turso DB
    await turso.execute({
      sql: `INSERT INTO orders (id, customer_phone, delivery_location, items, total_amount, status)
            VALUES (?, ?, ?, ?, ?, 'PENDING_DISPATCH')`,
      args: [orderId, customerPhone, deliveryLocation, itemsJson, totalAmount],
    });

    console.log(`[Turso DB] Saved Order: ${orderId}`);

    // Notify Manager about the new kitchen order
    await notifyManager(
      `🔔 *NEW KITCHEN ORDER RECEIVED!*\n\n` +
      `*Order ID:* ${orderId}\n` +
      `*Customer:* ${customerPhone}\n` +
      `*Location:* ${deliveryLocation}\n` +
      `*Items:* ${itemsSummary}\n` +
      `*Total:* KES ${totalAmount}\n\n` +
      `⏳ *Status:* Broadcasting claim links to riders...`
    );

    // Broadcast Order to active riders
    await broadcastOrderToRiders(orderId, deliveryLocation, totalAmount, items);

    return res.status(201).json({
      success: true,
      message: 'Order created, saved to database, and dispatched to riders.',
      orderId: orderId,
    });

  } catch (error) {
    console.error('[Create Order Error]:', error);
    return res.status(500).json({ success: false, message: error.message || 'Internal server error.' });
  }
});
// ==========================================
// ORDER COMPLETION & DELIVERY ENDPOINTS
// ==========================================

// 5. POST Endpoint: Mark Order as DELIVERED (Rider completes dropoff)
app.post('/api/orders/deliver', async (req, res) => {
  try {
    const { orderId, riderPhone } = req.body;

    if (!orderId || !riderPhone) {
      return res.status(400).json({ success: false, message: 'Missing orderId or riderPhone.' });
    }

    const cleanOrderId = String(orderId).trim();
    const cleanPhone = String(riderPhone).trim();

    // 1. Fetch current order status from Turso
    const checkOrder = await turso.execute({
      sql: `SELECT status, customer_phone FROM orders WHERE id = ?`,
      args: [cleanOrderId]
    });

    if (checkOrder.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Order not found.' });
    }

    const currentStatus = String(checkOrder.rows[0].status).toUpperCase();
    const customerPhone = checkOrder.rows[0].customer_phone;

    if (currentStatus === 'DELIVERED') {
      return res.status(400).json({ success: false, message: 'Order is already marked as delivered.' });
    }

    // 2. Update status to DELIVERED in Turso
    await turso.execute({
      sql: `UPDATE orders SET status = 'DELIVERED' WHERE id = ? AND rider_id = ?`,
      args: [cleanOrderId, cleanPhone]
    });

    console.log(`[Delivery Complete] Order ${cleanOrderId} marked DELIVERED by ${cleanPhone}`);

    // 3. Notify Manager via WhatsApp
    await notifyManager(
      `🎉 *ORDER DELIVERED! (#${cleanOrderId})*\n\n` +
      `*Rider:* ${cleanPhone}\n` +
      `*Status:* Successfully delivered to customer!`
    );

    // 4. Send Confirmation WhatsApp to Customer
    if (customerPhone) {
      await sendWhatsAppMessage({
        messaging_product: 'whatsapp',
        to: customerPhone,
        type: 'text',
        text: { 
          body: `🍔 *ORDER DELIVERED!*\n\n` +
                `Your Kimana Fries order (*${cleanOrderId}*) has been delivered!\n` +
                `Thank you for ordering with us. Enjoy your meal! 😋` 
        }
      });
    }

    return res.status(200).json({
      success: true,
      message: `Order ${cleanOrderId} marked as DELIVERED!`,
      orderId: cleanOrderId
    });

  } catch (error) {
    console.error('[Delivery Exception]:', error);
    return res.status(500).json({ success: false, message: error.message || 'Internal server error.' });
  }
});
// 5. POST Endpoint: Web Claim Action (Rider Clicks Link)
app.post('/api/orders/claim', async (req, res) => {
  try {
    const { orderId, riderPhone } = req.body;

    if (!orderId || !riderPhone) {
      return res.status(400).json({ success: false, message: 'Missing orderId or riderPhone.' });
    }

    const cleanOrderId = String(orderId).trim();
    const cleanPhone = String(riderPhone).trim();

    // 1. Fetch current order status from Turso
    const checkOrder = await turso.execute({
      sql: `SELECT status FROM orders WHERE id = ?`,
      args: [cleanOrderId]
    });

    if (checkOrder.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Order not found.' });
    }

    const currentStatus = String(checkOrder.rows[0].status).toUpperCase();

    if (currentStatus === 'PENDING_DISPATCH') {
      // 2. Update Order State to DISPATCHED
      await turso.execute({
        sql: `UPDATE orders SET status = 'DISPATCHED', rider_id = ? WHERE id = ?`,
        args: [cleanPhone, cleanOrderId]
      });

      console.log(`[Web Claim Success] Order ${cleanOrderId} claimed by rider ${cleanPhone}`);

      // 3. Fetch Rider Name
      let riderName = 'Active Rider';
      try {
        const riderQuery = await turso.execute({
          sql: `SELECT name FROM riders WHERE phone_number = ?`,
          args: [cleanPhone]
        });
        if (riderQuery.rows.length > 0 && riderQuery.rows[0].name) {
          riderName = riderQuery.rows[0].name;
        }
      } catch (rErr) {
        console.error('[Rider Query Error]:', rErr);
      }

      // 4. Alert Manager via WhatsApp
      await notifyManager(
        `🛵 *RIDER ASSIGNED! (#${cleanOrderId})*\n\n` +
        `*Rider Name:* ${riderName}\n` +
        `*Rider Phone:* ${cleanPhone}\n` +
        `*Status:* En route to Kimana Fries counter for pick up.`
      );

      // 5. Send Confirmation WhatsApp to Rider
      // Send Confirmation & Tracking/Delivery Link to Rider
const trackLink = `${frontendUrl}/claim.html?orderId=${cleanOrderId}&phone=${cleanPhone}`;

await sendWhatsAppMessage({
  messaging_product: 'whatsapp',
  to: cleanPhone,
  type: 'text',
  text: { 
    body: `✅ *Order ${cleanOrderId} Claimed!*\n\n` +
          `Proceed to Kimana Fries counter for pick up.\n\n` +
          `👉 *Tap to Manage Order / Mark Delivered:* ${trackLink}` 
  }
});

      return res.status(200).json({ 
        success: true, 
        message: 'Order claimed successfully!', 
        orderId: cleanOrderId 
      });

    } else {
      console.log(`[Web Claim Rejected] Order ${cleanOrderId} already claimed.`);
      return res.status(409).json({ 
        success: false, 
        message: `Order ${cleanOrderId} has already been claimed by another rider.` 
      });
    }

  } catch (error) {
    console.error('[Web Claim Exception]:', error);
    return res.status(500).json({ success: false, message: error.message || 'Internal server error.' });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
