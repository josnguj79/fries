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
    // Clean Log Output: Log destination and message summary instead of raw Meta response
    const msgSummary = payload.type === 'text' 
      ? payload.text?.body 
      : payload.type === 'interactive' 
        ? payload.interactive?.body?.text 
        : 'Template/Media Message';

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

// Helper: Broadcast Order to Active Boda Riders
async function broadcastOrderToRiders(orderId, deliveryLocation, totalAmount, items) {
  const itemsSummary = items.map(i => `${i.qty}x ${i.name}`).join(', ');

  // Fetch available riders from Turso
  const ridersResult = await turso.execute(`SELECT phone_number FROM riders WHERE is_available = 1`);
  
  if (ridersResult.rows.length === 0) {
    console.log('[Dispatch] No active riders available.');
    await notifyManager(`⚠️ *NO RIDERS AVAILABLE!*\nOrder *${orderId}* was placed, but no riders are active on the platform.`);
    return;
  }

  // Send interactive dispatch message to each rider
  for (const rider of ridersResult.rows) {
    const riderPhone = rider.phone_number;

    const payload = {
      messaging_product: 'whatsapp',
      to: riderPhone,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: {
          text: `🍔 *NEW KIMANA FRIES ORDER!*\n\n*Order ID:* ${orderId}\n*Location:* ${deliveryLocation}\n*Items:* ${itemsSummary}\n*Total:* KES ${totalAmount}`
        },
        action: {
          buttons: [
            {
              type: 'reply',
              reply: {
                id: `accept_${orderId}`,
                title: 'ACCEPT ORDER 🛵'
              }
            }
          ]
        }
      }
    };

    await sendWhatsAppMessage(payload);
  }
}

// 1. POST Endpoint: Create Order & Trigger Alerts
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
      `⏳ *Status:* Broadcasting to available riders...`
    );

    // Broadcast Order to active riders
    await broadcastOrderToRiders(orderId, deliveryLocation, totalAmount, items);

    return res.status(201).json({
      success: true,
      message: 'Order created, saved to database, and dispatched.',
      orderId: orderId,
    });

  } catch (error) {
    console.error('[Create Order Error]:', error);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

// 2. GET Endpoint: Meta Webhook Verification
app.get('/api/whatsapp/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === process.env.WA_VERIFY_TOKEN) {
      console.log('[Meta Webhook Verified]');
      return res.status(200).send(challenge);
    } else {
      return res.sendStatus(403);
    }
  }
});

// 3. POST Endpoint: Handle Rider Interaction (Accept Button Click)
app.post('/api/whatsapp/webhook', async (req, res) => {
  res.sendStatus(200); // Instantly acknowledge 200 OK to Meta

  try {
    const body = req.body;
    const changeValue = body.entry?.[0]?.changes?.[0]?.value;

    // Ignore delivery & read receipts
    if (changeValue?.statuses) return;

    const message = changeValue?.messages?.[0];
    if (!message) return;

    const riderPhone = message.from;

    if (message.type === 'interactive' && message.interactive?.type === 'button_reply') {
      const buttonId = message.interactive.button_reply.id;
      console.log(`[Webhook Clicked] Button: ${buttonId} | Rider: ${riderPhone}`);

      if (buttonId.startsWith('accept_')) {
        const orderId = buttonId.replace('accept_', '').trim();

        // 1. Check order in Turso
        const currentOrder = await turso.execute({
          sql: `SELECT id, status FROM orders WHERE id = ?`,
          args: [orderId]
        });

        console.log(`[Turso Query] Order: ${orderId} | Found Rows: ${currentOrder.rows.length}`);

        if (currentOrder.rows.length === 0) {
          console.error(`[Dispatch Error] Order ID ${orderId} does not exist in Turso DB.`);
          return;
        }

        const orderStatus = currentOrder.rows[0].status;
        console.log(`[Turso Status] Order ${orderId} current status: "${orderStatus}"`);

        if (orderStatus === 'PENDING_DISPATCH') {
          // Update Order State
          await turso.execute({
            sql: `UPDATE orders SET status = 'DISPATCHED', rider_id = ? WHERE id = ?`,
            args: [riderPhone, orderId]
          });

          console.log(`[Turso DB] Order ${orderId} updated to DISPATCHED by ${riderPhone}`);

          // Fetch Rider Name
          let riderName = 'Active Rider';
          try {
            const riderQuery = await turso.execute({
              sql: `SELECT name FROM riders WHERE phone_number = ?`,
              args: [riderPhone]
            });
            if (riderQuery.rows.length > 0 && riderQuery.rows[0].name) {
              riderName = riderQuery.rows[0].name;
            }
          } catch (rErr) {
            console.error('[Rider Fetch Error]:', rErr);
          }

          // Confirm to Winning Rider
          await sendWhatsAppMessage({
            messaging_product: 'whatsapp',
            to: riderPhone,
            type: 'text',
            text: { body: `✅ *Order Accepted!* Head to Kimana Fries counter for pick up. Order ID: ${orderId}` }
          });

          // Alert Manager
          console.log(`[Manager Notification] Alerting MANAGER_PHONE (${process.env.MANAGER_PHONE})...`);
          
          await notifyManager(
            `🛵 *RIDER ASSIGNED! (#${orderId})*\n\n` +
            `*Rider Name:* ${riderName}\n` +
            `*Rider Phone:* ${riderPhone}\n` +
            `*Status:* En route to Kimana Fries counter for pick up.`
          );

        } else {
          console.log(`[Dispatch Ignored] Order ${orderId} is already in state "${orderStatus}".`);
          
          await sendWhatsAppMessage({
            messaging_product: 'whatsapp',
            to: riderPhone,
            type: 'text',
            text: { body: `⚠️ *Order Taken!* Another rider accepted order ${orderId} before you.` }
          });
        }
      }
    }
  } catch (err) {
    console.error('[Webhook Exception]:', err);
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
