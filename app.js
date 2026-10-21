// ==========================================
// CONFIGURATION & GLOBAL STATE
// ==========================================

// Render Backend API Endpoint for Order Placement
const BACKEND_URL = "https://fries-v0l8.onrender.com/api/orders/create";

// Kimana Fries Catalog Items
const menuItems = [
  { id: "kf1", name: "Regular Chips", price: 100 },
  { id: "kf2", name: "Large Chips", price: 150 },
  { id: "kf3", name: "Chips Pasua (with Sausage)", price: 200 },
  { id: "kf4", name: "Smokey Pasua", price: 60 }
];

// Active Customer Shopping Cart Array
let cart = [];


// ==========================================
// DOM ELEMENT SELECTORS
// ==========================================
const menuGrid = document.getElementById('menuGrid');
const cartDrawer = document.getElementById('cartDrawer');
const cartOverlay = document.getElementById('cartOverlay');
const openCartBtn = document.getElementById('openCartBtn');
const closeCartBtn = document.getElementById('closeCartBtn');
const cartItemsContainer = document.getElementById('cartItemsContainer');
const cartCount = document.getElementById('cartCount');
const cartTotal = document.getElementById('cartTotal');
const checkoutForm = document.getElementById('checkoutForm');


// ==========================================
// MENU & CART UI RENDER FUNCTIONS
// ==========================================

/**
 * Renders the food catalog items dynamically inside the #menuGrid container.
 */
function renderMenu() {
  if (!menuGrid) return;

  menuGrid.innerHTML = menuItems.map(item => `
    <div class="card">
      <div>
        <h3>${item.name}</h3>
        <p class="price">KES ${item.price}</p>
      </div>
      <button class="add-btn" onclick="addToCart('${item.id}')">Add to Order</button>
    </div>
  `).join('');
}

/**
 * Adds an item to the shopping cart array by ID.
 * Increments quantity if the item already exists in the cart.
 * 
 * @param {string} itemId - The unique ID of the menu item (e.g. 'kf1')
 */
function addToCart(itemId) {
  const item = menuItems.find(i => i.id === itemId);
  if (!item) return;

  const existing = cart.find(i => i.id === itemId);

  if (existing) {
    existing.qty += 1;
  } else {
    cart.push({ ...item, qty: 1 });
  }

  updateCartUI();
  toggleCart(true); // Open cart drawer after adding item
}

/**
 * Adjusts the quantity of a specific cart item (+1 or -1).
 * Removes the item if the quantity drops below 1.
 * 
 * @param {string} itemId - The ID of the item to update
 * @param {number} change - +1 to increment, -1 to decrement
 */
function updateItemQuantity(itemId, change) {
  const index = cart.findIndex(i => i.id === itemId);
  if (index === -1) return;

  cart[index].qty += change;

  if (cart[index].qty <= 0) {
    cart.splice(index, 1); // Remove item if quantity hits 0
  }

  updateCartUI();
}

/**
 * Recalculates total items, overall total price, and updates cart HTML elements.
 */
function updateCartUI() {
  // Calculate total item count and sum price
  const totalCount = cart.reduce((sum, item) => sum + item.qty, 0);
  const totalPrice = cart.reduce((sum, item) => sum + (item.price * item.qty), 0);

  // Update header cart badge and footer total
  if (cartCount) cartCount.textContent = totalCount;
  if (cartTotal) cartTotal.textContent = totalPrice;

  // Handle empty cart display state
  if (cart.length === 0) {
    cartItemsContainer.innerHTML = '<p class="empty-msg">Your cart is empty.</p>';
    return;
  }

  // Render cart items list with item quantity controls (+ / -)
  cartItemsContainer.innerHTML = cart.map(item => `
    <div class="cart-item" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.8rem; padding-bottom: 0.5rem; border-bottom: 1px solid #edf2f7;">
      <div>
        <strong>${item.name}</strong>
        <div><small style="color: #666;">KES ${item.price} x ${item.qty}</small></div>
      </div>
      <div style="display: flex; align-items: center; gap: 8px;">
        <div style="display: flex; align-items: center; border: 1px solid #cbd5e1; border-radius: 4px;">
          <button type="button" onclick="updateItemQuantity('${item.id}', -1)" style="border: none; background: #f1f5f9; padding: 2px 8px; cursor: pointer; font-weight: bold;">-</button>
          <span style="padding: 0 8px; font-weight: bold; font-size: 0.85rem;">${item.qty}</span>
          <button type="button" onclick="updateItemQuantity('${item.id}', 1)" style="border: none; background: #f1f5f9; padding: 2px 8px; cursor: pointer; font-weight: bold;">+</button>
        </div>
        <strong>KES ${item.price * item.qty}</strong>
      </div>
    </div>
  `).join('');
}

/**
 * Opens or closes the sliding side cart drawer and backdrop overlay.
 * 
 * @param {boolean} open - True to open the cart drawer, false to close
 */
function toggleCart(open) {
  if (!cartDrawer || !cartOverlay) return;

  if (open) {
    cartDrawer.classList.add('open');
    cartOverlay.classList.add('open');
  } else {
    cartDrawer.classList.remove('open');
    cartOverlay.classList.remove('open');
  }
}


// ==========================================
// CART & ORDER SUBMISSION EVENT LISTENERS
// ==========================================

// Cart Drawer Open / Close Triggers
if (openCartBtn) openCartBtn.addEventListener('click', () => toggleCart(true));
if (closeCartBtn) closeCartBtn.addEventListener('click', () => toggleCart(false));
if (cartOverlay) cartOverlay.addEventListener('click', () => toggleCart(false));

/**
 * Handles checkout form submission, sends JSON order payload to Express backend,
 * and handles response feedback.
 */
if (checkoutForm) {
  checkoutForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    // Prevent checkout on empty cart
    if (cart.length === 0) {
      alert("Please add items to your cart first.");
      return;
    }

    const customerPhoneInput = document.getElementById('customerPhone');
    const deliveryLocationInput = document.getElementById('deliveryLocation');

    // Save customer phone number to local storage for automatic tracking session
    if (customerPhoneInput) {
      localStorage.setItem('kimana_customer_phone', customerPhoneInput.value.trim());
    }

    // Construct backend API order payload
    const payload = {
      customerPhone: customerPhoneInput.value.trim(),
      deliveryLocation: deliveryLocationInput.value.trim(),
      items: cart,
      totalAmount: cart.reduce((sum, item) => sum + (item.price * item.qty), 0)
    };

    const submitBtn = document.getElementById('submitOrderBtn');
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = "Dispatching Order...";
    }

    try {
      // POST order payload to Render Express API
      const response = await fetch(BACKEND_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
