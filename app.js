// Render API Backend Endpoint
const BACKEND_URL = "https://your-render-app-name.onrender.com/api/orders/create";

// Sample Catalog Items
const menuItems = [
  { id: "kf1", name: "Regular Chips", price: 100 },
  { id: "kf2", name: "Large Chips", price: 150 },
  { id: "kf3", name: "Chips Pasua (with Sausage)", price: 200 },
  { id: "kf4", name: "Smokey Pasua", price: 60 }
];

let cart = [];

// DOM Selectors
const menuGrid = document.getElementById('menuGrid');
const cartDrawer = document.getElementById('cartDrawer');
const cartOverlay = document.getElementById('cartOverlay');
const openCartBtn = document.getElementById('openCartBtn');
const closeCartBtn = document.getElementById('closeCartBtn');
const cartItemsContainer = document.getElementById('cartItemsContainer');
const cartCount = document.getElementById('cartCount');
const cartTotal = document.getElementById('cartTotal');
const checkoutForm = document.getElementById('checkoutForm');

// Render Menu Cards
function renderMenu() {
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

// Cart Functions
function addToCart(itemId) {
  const item = menuItems.find(i => i.id === itemId);
  const existing = cart.find(i => i.id === itemId);

  if (existing) {
    existing.qty += 1;
  } else {
    cart.push({ ...item, qty: 1 });
  }

  updateCartUI();
  toggleCart(true);
}

function updateCartUI() {
  const totalCount = cart.reduce((sum, item) => sum + item.qty, 0);
  const totalPrice = cart.reduce((sum, item) => sum + (item.price * item.qty), 0);

  cartCount.textContent = totalCount;
  cartTotal.textContent = totalPrice;

  if (cart.length === 0) {
    cartItemsContainer.innerHTML = '<p class="empty-msg">Your cart is empty.</p>';
    return;
  }

  cartItemsContainer.innerHTML = cart.map(item => `
    <div class="cart-item">
      <div>
        <strong>${item.name}</strong>
        <div><small>KES ${item.price} x ${item.qty}</small></div>
      </div>
      <strong>KES ${item.price * item.qty}</strong>
    </div>
  `).join('');
}

function toggleCart(open) {
  if (open) {
    cartDrawer.classList.add('open');
    cartOverlay.classList.add('open');
  } else {
    cartDrawer.classList.remove('open');
    cartOverlay.classList.remove('open');
  }
}

// Event Listeners
openCartBtn.addEventListener('click', () => toggleCart(true));
closeCartBtn.addEventListener('click', () => toggleCart(false));
cartOverlay.addEventListener('click', () => toggleCart(false));

// Submit Order Payload to Render Backend
checkoutForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  if (cart.length === 0) {
    alert("Please add items to your cart first.");
    return;
  }

  const payload = {
    customerPhone: document.getElementById('customerPhone').value.trim(),
    deliveryLocation: document.getElementById('deliveryLocation').value.trim(),
    items: cart,
    totalAmount: cart.reduce((sum, item) => sum + (item.price * item.qty), 0)
  };

  const submitBtn = document.getElementById('submitOrderBtn');
  submitBtn.disabled = true;
  submitBtn.textContent = "Dispatching Order...";

  try {
    const response = await fetch(BACKEND_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (response.ok) {
      alert("Order placed successfully! Riders are being alerted on WhatsApp.");
      cart = [];
      updateCartUI();
      checkoutForm.reset();
      toggleCart(false);
    } else {
      alert("Failed to place order. Please try again.");
    }
  } catch (err) {
    console.error("API Error:", err);
    alert("Server error connecting to backend.");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Confirm & Place Order";
  }
});

// Initialize
renderMenu();
