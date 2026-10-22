// ==========================================
// DEPENDENCIES & ENVIRONMENT SETUP
// ==========================================
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@libsql/client';

// Load environment variables from .env file
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const frontendUrl = process.env.FRONTEND_URL || 'https://kimanafries.com';

// Enable CORS for all origins and handle preflight OPTIONS requests
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());


// ==========================================
// TURSO DATABASE INITIALIZATION
// ==========================================
const turso = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});


// ==========================================
// HEALTH CHECK ENDPOINT
// ==========================================

/**
 * Basic health check route to verify server uptime.
 */
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date() });
});


// ==========================================
// WHATSAPP HELPER FUNCTIONS
// ==========================================

/**
 * Sends a WhatsApp message via the Meta Cloud API.
 * 
 * @param {Object} payload - The Meta WhatsApp message payload object
 * @returns {Promise<Object>} - The API response data
 */
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

/**
 * Sends a notification message to the restaurant manager's WhatsApp number.
 * 
 * @param {string} messageText - The message body to send
 */
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

/**
 * Broadcasts a new order alert containing a web claim link to all active (online) Boda riders.
 * 
 * @param {string} orderId - Unique Order ID
 * @param {string} deliveryLocation - Delivery destination
 * @param {number} totalAmount - Total cost in KES
 * @param {Array} items - Ordered items array
 */
async function broadcastOrderToRiders(orderId, deliveryLocation, totalAmount, items) {
  const itemsSummary = items.map(i => `${i.qty}x ${i.name}`).join(', ');
  const claimLink = `${frontendUrl}/claim.html?orderId=${orderId}`;

  // Fetch available (online) riders from Turso
  const ridersResult = await turso.execute(`SELECT phone_number FROM riders WHERE is_available = 1`);
  
  if (ridersResult.rows.length === 0) {
    console.log('[Dispatch] No active riders available.');
    await notifyManager(`⚠️ *NO RIDERS AVAILABLE!*\nOrder *${orderId}* was placed, but no riders are active on the platform.`);
    return;
  }

  // Send WhatsApp dispatch notification to each active rider
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

/**
 * 1. Register a new BodaSwift rider as offline and send portal credentials via WhatsApp.
 */
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

    console.log(`[Rider Registered] ${cleanName} (${cleanPhone}) -> Initialized OFFLINE (0)`);

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

/**
 * 2. Toggle rider online/offline status via the web portal.
 */
app.post('/api/riders/toggle-status', async (req, res) => {
  try {
    const { phone, isAvailable } = req.body;

    if (!phone || isAvailable === undefined) {
      return res.status(400).json({ success: false, message: 'Missing phone or isAvailable status.' });
    }

    const cleanPhone = String(phone).trim();
    const newStatus = isAvailable ? 1 : 0;

    const riderCheck = await turso.execute({
      sql: `SELECT name, is_available FROM riders WHERE phone_number = ?`,
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

/**
 * 3. Fetch rider name and availability status.
 */
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
// ORDER DISPATCH & LIFECYCLE ENDPOINTS
// ==========================================

/**
 * 4. Create a new order, save it to Turso, notify manager, and broadcast claim links to riders.
 * Includes a 3-minute unclaimed order safety timeout check.
 */
app.post('/api/orders/create', async (req, res) => {
  try {
    const { customerPhone, deliveryLocation, items, totalAmount } = req.body;

    if (!customerPhone || !deliveryLocation || !items || !totalAmount) {
      return res.status(400).json({ success: false, message: 'Missing required order fields.' });
    }

    const orderId = `KF-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
    const itemsJson = typeof items === 'string' ? items : JSON.stringify(items);
    const parsedItemsArr = Array.isArray(items) ? items : (typeof items === 'string' ? JSON.parse(items) : []);
    const itemsSummary = parsedItemsArr.map(i => `${i.qty || 1}x ${i.name || 'Item'}`).join(', ');

    await turso.execute({
      sql: `INSERT INTO orders (id, customer_phone, delivery_location, items, total_amount, status) VALUES (?, ?, ?, ?, ?, 'PENDING_DISPATCH')`,
      args: [
        String(orderId), 
        String(customerPhone).trim(), 
        String(deliveryLocation).trim(), 
        itemsJson, 
        Number(totalAmount)
      ],
    });

    console.log(`[Turso DB] Saved Order: ${orderId}`);

    // Notify manager and broadcast to riders in background
    Promise.allSettled([
      notifyManager(
        `🔔 *NEW KITCHEN ORDER RECEIVED!*\n\n` +
        `*Order ID:* ${orderId}\n` +
        `*Customer:* ${customerPhone}\n` +
        `*Location:* ${deliveryLocation}\n` +
        `*Items:* ${itemsSummary}\n` +
        `*Total:* KES ${totalAmount}\n\n` +
        `⏳ *Status:* Broadcasting claim links to riders...`
      ),
      broadcastOrderToRiders(orderId, deliveryLocation, totalAmount, parsedItemsArr)
    ]).catch(err => console.error('[Background Dispatch Alert Error]:', err));

    // 3-minute timeout safety check for unclaimed orders
    setTimeout(async () => {
      try {
        const orderCheck = await turso.execute({
          sql: `SELECT status FROM orders WHERE id = ?`,
          args: [orderId]
        });

        if (orderCheck.rows.length > 0) {
          const currentStatus = String(orderCheck.rows[0].status).toUpperCase();
          if (currentStatus === 'PENDING_DISPATCH') {
            console.log(`[Order Timeout] Order ${orderId} was unclaimed after 3 minutes.`);
            await notifyManager(
              `⚠️ *ORDER TIMEOUT! (#${orderId})*\n\n` +
              `This order has been pending for 3 minutes and *no rider has claimed it*.\n\n` +
              `👉 Please call a rider directly or assign manually!`
            );
          }
        }
      } catch (timeoutErr) {
        console.error('[Timeout Check Exception]:', timeoutErr);
      }
    }, 3 * 60 * 1000);

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

/**
 * 5. Mark an order as DELIVERED when the assigned rider completes drop-off.
 */
app.post('/api/orders/deliver', async (req, res) => {
  try {
    const { orderId, riderPhone } = req.body;

    if (!orderId || !riderPhone) {
      return res.status(400).json({ success: false, message: 'Missing orderId or riderPhone.' });
    }

    const cleanOrderId = String(orderId).trim();
    const cleanPhone = String(riderPhone).trim();

    const checkOrder = await turso.execute({
      sql: `SELECT status, customer_phone, rider_id FROM orders WHERE id = ?`,
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

    await turso.execute({
      sql: `UPDATE orders SET status = 'DELIVERED', rider_id = ? WHERE id = ?`,
      args: [cleanPhone, cleanOrderId]
    });

    console.log(`[Delivery Complete] Order ${cleanOrderId} marked DELIVERED by ${cleanPhone}`);

    await notifyManager(
      `🎉 *ORDER DELIVERED! (#${cleanOrderId})*\n\n` +
      `*Rider:* ${cleanPhone}\n` +
      `*Status:* Successfully delivered to customer!`
    );

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

/**
 * 6. Process web-based order claim action by a rider via the broadcast link.
 */
app.post('/api/orders/claim', async (req, res) => {
  try {
    const { orderId, riderPhone } = req.body;

    if (!orderId || !riderPhone) {
      return res.status(400).json({ success: false, message: 'Missing orderId or riderPhone.' });
    }

    const cleanOrderId = String(orderId).trim();
    const cleanPhone = String(riderPhone).trim();

    const checkOrder = await turso.execute({
      sql: `SELECT status FROM orders WHERE id = ?`,
      args: [cleanOrderId]
    });

    if (checkOrder.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Order not found.' });
    }

    const currentStatus = String(checkOrder.rows[0].status).toUpperCase();

    if (currentStatus === 'PENDING_DISPATCH') {
      await turso.execute({
        sql: `UPDATE orders SET status = 'DISPATCHED', rider_id = ? WHERE id = ?`,
        args: [cleanPhone, cleanOrderId]
      });

      console.log(`[Web Claim Success] Order ${cleanOrderId} claimed by rider ${cleanPhone}`);

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

      await notifyManager(
        `🛵 *RIDER ASSIGNED! (#${cleanOrderId})*\n\n` +
        `*Rider Name:* ${riderName}\n` +
        `*Rider Phone:* ${cleanPhone}\n` +
        `*Status:* En route to Kimana Fries counter for pick up.`
      );

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

/**
 * 7. Fetch active and completed orders assigned to a specific rider phone number.
 */
app.get('/api/orders/rider', async (req, res) => {
  try {
    const phone = req.query.phone;

    if (!phone) {
      return res.status(400).json({ success: false, message: 'Phone parameter required.' });
    }

    const cleanPhone = String(phone).trim();

    const ordersResult = await turso.execute({
      sql: `SELECT id, customer_phone, delivery_location, items, total_amount, status, created_at FROM orders WHERE rider_id = ? ORDER BY created_at DESC`,
      args: [cleanPhone]
    });

    const pending = [];
    const completed = [];

    for (const row of ordersResult.rows) {
      let parsedItems = [];
      try {
        parsedItems = JSON.parse(row.items);
      } catch (e) {
        parsedItems = [];
      }

      const orderObj = {
        id: row.id,
        customerPhone: row.customer_phone,
        deliveryLocation: row.delivery_location,
        items: parsedItems,
        totalAmount: row.total_amount,
        status: row.status,
        createdAt: row.created_at
      };

      if (row.status === 'DISPATCHED') {
        pending.push(orderObj);
      } else if (row.status === 'DELIVERED') {
        completed.push(orderObj);
      }
    }

    return res.status(200).json({
      success: true,
      pending: pending,
      completed: completed
    });

  } catch (error) {
    console.error('[Rider Orders Exception]:', error);
    return res.status(500).json({ success: false, message: error.message || 'Internal server error.' });
  }
});


// ==========================================
// CUSTOMER DASHBOARD ENDPOINTS
// ==========================================

/**
 * 8. Fetch active and past order history for a customer phone number (supporting number format variants).
 */
app.get('/api/orders/customer', async (req, res) => {
  try {
    const rawPhone = req.query.phone;

    if (!rawPhone) {
      return res.status(400).json({ success: false, message: 'Phone parameter required.' });
    }

    const cleanPhone = String(rawPhone).trim();
    const phoneNoPlus = cleanPhone.replace(/^\+/, '');
    const phoneLocal = cleanPhone.startsWith('254') ? '0' + cleanPhone.slice(3) : cleanPhone;

    const ordersResult = await turso.execute({
      sql: `SELECT id, customer_phone, delivery_location, items, total_amount, status, rider_id, created_at 
            FROM orders 
            WHERE customer_phone = ? OR customer_phone = ? OR customer_phone = ? OR customer_phone = ?
            ORDER BY created_at DESC`,
      args: [cleanPhone, `+${phoneNoPlus}`, phoneNoPlus, phoneLocal]
    });

    const ridersResult = await turso.execute(`SELECT phone_number, name FROM riders`);
    const riderMap = {};
    for (const r of ridersResult.rows) {
      riderMap[r.phone_number] = r.name || 'BodaSwift Rider';
    }

    const active = [];
    const history = [];

    for (const row of ordersResult.rows) {
      let parsedItems = [];
      try {
        parsedItems = typeof row.items === 'string' ? JSON.parse(row.items) : row.items;
      } catch (e) {
        parsedItems = [];
      }

      const riderName = row.rider_id ? (riderMap[row.rider_id] || 'BodaSwift Rider') : null;

      const orderObj = {
        id: row.id,
        customerPhone: row.customer_phone,
        deliveryLocation: row.delivery_location,
        items: parsedItems,
        totalAmount: row.total_amount,
        status: row.status,
        riderName: riderName,
        riderPhone: row.rider_id || null,
        createdAt: row.created_at
      };

      if (row.status === 'DELIVERED') {
        history.push(orderObj);
      } else {
        active.push(orderObj);
      }
    }

    return res.status(200).json({
      success: true,
      active: active,
      history: history
    });

  } catch (error) {
    console.error('[Customer Orders Exception]:', error);
    return res.status(500).json({ success: false, message: error.message || 'Internal server error.' });
  }
});

/**
 * 9. Track a single order status by Order ID.
 */
app.get('/api/orders/track/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    if (!orderId) {
      return res.status(400).json({ success: false, message: 'Order ID is required.' });
    }

    const orderResult = await turso.execute({
      sql: `SELECT id, customer_phone, delivery_location, items, total_amount, status, rider_id, created_at 
            FROM orders WHERE id = ?`,
      args: [String(orderId).trim()]
    });

    if (orderResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Order not found.' });
    }

    const row = orderResult.rows[0];
    let parsedItems = [];
    try {
      parsedItems = typeof row.items === 'string' ? JSON.parse(row.items) : row.items;
    } catch (e) {
      parsedItems = [];
    }

    let riderName = null;
    if (row.rider_id) {
      const riderRes = await turso.execute({
        sql: `SELECT name FROM riders WHERE phone_number = ?`,
        args: [row.rider_id]
      });
      if (riderRes.rows.length > 0) {
        riderName = riderRes.rows[0].name;
      }
    }

    return res.status(200).json({
      success: true,
      order: {
        id: row.id,
        customerPhone: row.customer_phone,
        deliveryLocation: row.delivery_location,
        items: parsedItems,
        totalAmount: row.total_amount,
        status: row.status,
        riderName: riderName,
        riderPhone: row.rider_id,
        createdAt: row.created_at
      }
    });

  } catch (error) {
    console.error('[Track Order Exception]:', error);
    return res.status(500).json({ success: false, message: error.message || 'Internal server error.' });
  }
});


// ==========================================
// MANAGER AUTHENTICATION & SECURITY
// ==========================================

// Secret PIN and token configuration
const MANAGER_PIN = process.env.MANAGER_PIN || "4321";
const ADMIN_SECRET_TOKEN = "bodaswift_admin_secret_token_2026";

/**
 * Admin Login Endpoint: Verifies the manager PIN and returns a bearer access token.
 */
app.post('/api/admin/login', (req, res) => {
  const { pin } = req.body;

  if (!pin || String(pin).trim() !== MANAGER_PIN) {
    return res.status(401).json({ success: false, message: 'Invalid Admin PIN.' });
  }

  return res.status(200).json({
    success: true,
    token: ADMIN_SECRET_TOKEN,
    message: 'Access granted.'
  });
});

/**
 * Security Middleware: Validates the Bearer Token for protected management endpoints.
 */
function authenticateAdmin(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || authHeader !== `Bearer ${ADMIN_SECRET_TOKEN}`) {
    return res.status(401).json({ success: false, message: 'Unauthorized. Admin login required.' });
  }
  next();
}


// ==========================================
// OPERATIONS & MANAGER ENDPOINTS (PROTECTED)
// ==========================================

/**
 * 10. Protected GET Endpoint: Kitchen Admin Overview (Live Orders & Rider Shift Stats).
 */
app.get('/api/admin/overview', authenticateAdmin, async (req, res) => {
  try {
    const liveOrdersResult = await turso.execute(`
      SELECT id, customer_phone, delivery_location, items, total_amount, status, rider_id, created_at 
      FROM orders 
      ORDER BY created_at DESC 
      LIMIT 50
    `);

    const ridersResult = await turso.execute(`
      SELECT phone_number, name, is_available 
      FROM riders
    `);

    const earningsResult = await turso.execute(`
      SELECT rider_id, COUNT(*) as completed_trips, SUM(total_amount) as total_revenue 
      FROM orders 
      WHERE status = 'DELIVERED' 
      GROUP BY rider_id
    `);

    const earningsMap = {};
    for (const row of earningsResult.rows) {
      if (row.rider_id) {
        earningsMap[row.rider_id] = {
          completedTrips: row.completed_trips,
          totalRevenue: row.total_revenue
        };
      }
    }

    const ridersWithStats = ridersResult.rows.map(r => ({
      phone: r.phone_number,
      name: r.name || 'Rider',
      isAvailable: r.is_available === 1,
      completedTrips: earningsMap[r.phone_number]?.completedTrips || 0,
      totalRevenue: earningsMap[r.phone_number]?.totalRevenue || 0
    }));

    return res.status(200).json({
      success: true,
      orders: liveOrdersResult.rows,
      riders: ridersWithStats
    });

  } catch (error) {
    console.error('[Admin Overview Error]:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * 11. Protected POST Endpoint: Manual Order Reassignment by Manager.
 */
app.post('/api/admin/reassign', authenticateAdmin, async (req, res) => {
  try {
    const { orderId, targetRiderPhone } = req.body;

    if (!orderId || !targetRiderPhone) {
      return res.status(400).json({ success: false, message: 'Missing orderId or targetRiderPhone.' });
    }

    const cleanOrderId = String(orderId).trim();
    const cleanPhone = String(targetRiderPhone).trim();

    // Check if order exists (Case-insensitive check)
    const orderCheck = await turso.execute({
      sql: `SELECT id FROM orders WHERE LOWER(TRIM(id)) = LOWER(?)`,
      args: [cleanOrderId]
    });

    if (orderCheck.rows.length === 0) {
      console.log(`[Reassign 404] Order ID '${cleanOrderId}' not found in database.`);
      return res.status(404).json({ success: false, message: `Order '${cleanOrderId}' not found in database.` });
    }

    const dbOrderId = orderCheck.rows[0].id;

    // Update order status to DISPATCHED and assign rider_id
    await turso.execute({
      sql: `UPDATE orders SET status = 'DISPATCHED', rider_id = ? WHERE id = ?`,
      args: [cleanPhone, dbOrderId]
    });

    console.log(`[Admin Action Success] Order ${dbOrderId} assigned to rider ${cleanPhone}`);

    // Send WhatsApp notification to assigned rider in background
    sendWhatsAppMessage({
      messaging_product: 'whatsapp',
      to: cleanPhone,
      type: 'text',
      text: {
        body: `⚡ *MANUAL DISPATCH ASSIGNMENT (#${dbOrderId})*\n\n` +
              `Manager assigned order ${dbOrderId} directly to you.\n\n` +
              `👉 *Open Shift Portal:* ${frontendUrl}/rider-dashboard.html`
      }
    }).catch(err => console.error('[WhatsApp Reassign Alert Error]:', err));

    return res.status(200).json({
      success: true,
      message: `Order ${dbOrderId} assigned successfully to ${cleanPhone}!`,
      orderId: dbOrderId,
      status: 'DISPATCHED'
    });

  } catch (error) {
    console.error('[Reassign Exception]:', error);
    return res.status(500).json({ success: false, message: error.message || 'Internal server error.' });
  }
});
import admin from 'firebase-admin';

// Initialize Firebase Admin SDK
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n')
    })
  });
}

// Store push tokens in Turso database table (ensure you have an fcm_tokens table)
// CREATE TABLE IF NOT EXISTS fcm_tokens (phone_number TEXT, token TEXT, role TEXT, PRIMARY KEY(phone_number, token));

// 1. Register Push Token Endpoint
app.post('/api/notifications/register-token', async (req, res) => {
  try {
    const { phone, token, role } = req.body;
    if (!phone || !token) {
      return res.status(400).json({ success: false, message: 'Missing phone or token.' });
    }

    await turso.execute({
      sql: `INSERT INTO fcm_tokens (phone_number, token, role) VALUES (?, ?, ?) ON CONFLICT(phone_number, token) DO UPDATE SET role = excluded.role`,
      args: [String(phone).trim(), String(token).trim(), role || 'customer']
    });

    return res.status(200).json({ success: true, message: 'Push token registered successfully!' });
  } catch (error) {
    console.error('[Token Registration Error]:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// 2. Helper: Send Push Notification to a Specific Phone Number
async function sendPushNotificationToUser(phone, title, body, targetUrl) {
  try {
    const tokenResult = await turso.execute({
      sql: `SELECT token FROM fcm_tokens WHERE phone_number = ?`,
      args: [String(phone).trim()]
    });

    if (tokenResult.rows.length === 0) return;

    const messages = tokenResult.rows.map(row => ({
      token: row.token,
      notification: { title, body },
      data: { url: targetUrl || './index.html' }
    }));

    // Send batch or individual messages via FCM
    for (const msg of messages) {
      await admin.messaging().send(msg);
    }
    console.log(`[Push Sent] To: ${phone} | Title: ${title}`);
  } catch (err) {
    console.error('[FCM Send Error]:', err);
  }
}
// In-memory or database OTP store (Order ID / Phone => { code, expiresAt })
const pushOtpStore = new Map();

/**
 * 1. POST Endpoint: Request Web Push OTP
 */
app.post('/api/auth/request-push-otp', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) {
      return res.status(400).json({ success: false, message: 'Phone number required.' });
    }

    const cleanPhone = String(phone).trim();

    // Generate a secure 6-digit passcode
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minute validity

    pushOtpStore.set(cleanPhone, { code: otpCode, expiresAt });

    // Send Web Push Notification via FCM Admin SDK
    const pushSent = await sendPushNotificationToUser(
      cleanPhone,
      '🔐 BodaSwift Access Passcode',
      `Your verification code is: ${otpCode}. Tap to enter your portal.`,
      './customer-dashboard.html'
    );

    console.log(`[Web Push OTP Sent] Phone: ${cleanPhone} | Code: ${otpCode}`);

    return res.status(200).json({
      success: true,
      message: 'Web Push notification sent! Check your browser / device notifications.'
    });

  } catch (error) {
    console.error('[Push OTP Exception]:', error);
    return res.status(500).json({ success: false, message: error.message || 'Internal server error.' });
  }
});

/**
 * 2. POST Endpoint: Verify Web Push OTP & Return Access Token
 */
app.post('/api/auth/verify-push-otp', async (req, res) => {
  try {
    const { phone, code } = req.body;
    if (!phone || !code) {
      return res.status(400).json({ success: false, message: 'Phone and OTP code are required.' });
    }

    const cleanPhone = String(phone).trim();
    const cleanCode = String(code).trim();
    const record = pushOtpStore.get(cleanPhone);

    if (!record) {
      return res.status(401).json({ success: false, message: 'No OTP requested for this phone.' });
    }

    if (Date.now() > record.expiresAt) {
      pushOtpStore.delete(cleanPhone);
      return res.status(401).json({ success: false, message: 'OTP expired. Please request a new one.' });
    }

    if (record.code !== cleanCode) {
      return res.status(401).json({ success: false, message: 'Invalid OTP code. Please try again.' });
    }

    // Clear used OTP
    pushOtpStore.delete(cleanPhone);

    // Generate verified token
    const sessionToken = `bodaswift_session_${Math.random().toString(36).substring(2)}`;

    return res.status(200).json({
      success: true,
      message: 'Verification successful!',
      token: sessionToken,
      phone: cleanPhone
    });

  } catch (error) {
    console.error('[Verify OTP Exception]:', error);
    return res.status(500).json({ success: false, message: error.message || 'Internal server error.' });
  }
});

// ==========================================
// SERVER INITIALIZATION
// ==========================================
app.listen(PORT, () => {
  console.log(`🚀 BodaSwift server successfully listening on port ${PORT}`);
});
