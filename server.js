import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@libsql/client';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
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

// 1. POST Endpoint: Create Order & Broadcast Claim Link
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
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

// 2. POST Endpoint: Web Claim Action (Rider Clicks Link)
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
      sql: `SELECT id, status FROM orders WHERE id = :id`,
      args: { id: cleanOrderId }
    });

    if (checkOrder.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Order not found.' });
    }

    const currentStatus = String(checkOrder.rows[0].status).toUpperCase();

    if (currentStatus === 'PENDING_DISPATCH') {
      // 2. Update Order State to DISPATCHED
      await turso.execute({
        sql: `UPDATE orders SET status = 'DISPATCHED', rider_id = :rider_id WHERE id = :order_id`,
        args: {
          rider_id: cleanPhone,
          order_id: cleanOrderId
        }
      });

      console.log(`[Web Claim Success] Order ${cleanOrderId} claimed by rider ${cleanPhone}`);

      // 3. Fetch Rider Name
      let riderName = 'Active Rider';
      try {
        const riderQuery = await turso.execute({
          sql: `SELECT name FROM riders WHERE phone_number = :phone`,
          args: { phone: cleanPhone }
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

      // 5. Send Confirmation SMS/WhatsApp to Rider
      await sendWhatsAppMessage({
        messaging_product: 'whatsapp',
        to: cleanPhone,
        type: 'text',
        text: { body: `✅ *Order ${cleanOrderId} Claimed!* Proceed to Kimana Fries counter for pick up.` }
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
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
