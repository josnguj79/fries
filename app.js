// ==========================================
// CONFIGURATION & GLOBAL STATE
// ==========================================

const BACKEND_URL = "https://fries-v0l8.onrender.com/api/orders/create";

const menuItems = [
  { id: "kf1", name: "Regular Chips", price: 100 },
  { id: "kf2", name: "Large Chips", price: 150 },
  { id: "kf3", name: "Chips Pasua (with Sausage)", price: 200 },
  { id: "kf4", name: "Smokey Pasua", price: 60 }
];

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
 * Renders food items inside #menuGrid.
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
 * Adds an item to the cart or increments its quantity.
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
  toggleCart(true); // Open cart drawer on add
}

/**
 * Adjusts cart item quantity (+1 / -1).
 */
function updateItemQuantity(itemId, change) {
  const index = cart.findIndex(i => i.id === itemId);
  if (index === -1) return;

  cart[index].qty += change;

  if (cart[index].qty <= 0) {
    cart.splice(index, 1);
  }

  updateCartUI();
}

/**
 * Updates cart HTML counters and item breakdown list.
 */
function updateCartUI() {
  const totalCount = cart.reduce((sum, item) => sum + item.qty, 0);
  const totalPrice = cart.reduce((sum, item) => sum + (item.price * item.qty), 0);

  if (cartCount) cartCount.textContent = totalCount;
  if (cartTotal) cartTotal.textContent = totalPrice;

  if (cart.length === 0) {
    cartItemsContainer.innerHTML = '<p class="empty-msg">Your cart is empty.</p>';
    return;
  }

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
 * Toggles cart open or closed state explicitly.
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
// EVENT LISTENERS & CHECKOUT
// ==========================================

// Cart Button Toggle (Opens if closed, closes if open)
if (openCartBtn) {
  openCartBtn.addEventListener('click', () => {
    const isOpen = cartDrawer && cartDrawer.classList.contains('open');
    toggleCart(!isOpen);
  });
}

if (closeCartBtn) closeCartBtn.addEventListener('click', () => toggleCart(false));
if (cartOverlay) cartOverlay.addEventListener('click', () => toggleCart(false));

if (checkoutForm) {
  checkoutForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    if (cart.length === 0) {
      alert("Please add items to your cart first.");
      return;
    }

    const customerPhoneInput = document.getElementById('customerPhone');
    const deliveryLocationInput = document.getElementById('deliveryLocation');

    if (customerPhoneInput) {
      localStorage.setItem('kimana_customer_phone', customerPhoneInput.value.trim());
    }

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
      const response = await fetch(BACKEND_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const data = await response.json().catch(() => ({}));

      if (response.ok) {
        alert("🎉 Order placed successfully! Riders are being alerted on WhatsApp.");
        cart = [];
        updateCartUI();
        checkoutForm.reset();
        toggleCart(false);
        window.location.href = './customer-dashboard.html';
      } else {
        alert(data.message || "Failed to place order. Please try again.");
      }
    } catch (err) {
      console.error("API Error:", err);
      alert("Server error connecting to BodaSwift backend.");
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = "Confirm & Place Order";
      }
    }
  });
}


// ==========================================
// SIDE DRAWER NAVIGATION LOGIC
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
  const menuToggleBtn = document.getElementById('menuToggleBtn');
  const closeDrawerBtn = document.getElementById('closeDrawerBtn');
  const sideDrawer = document.getElementById('sideDrawer');
  const menuOverlay = document.getElementById('menuOverlay');

  function openMenu() {
    if (sideDrawer && menuOverlay) {
      sideDrawer.classList.add('open');
      menuOverlay.classList.add('active');
    }
  }

  function closeMenu() {
    if (sideDrawer && menuOverlay) {
      sideDrawer.classList.remove('open');
      menuOverlay.classList.remove('active');
    }
  }

  if (menuToggleBtn) menuToggleBtn.addEventListener('click', openMenu);
  if (closeDrawerBtn) closeDrawerBtn.addEventListener('click', closeMenu);
  if (menuOverlay) menuOverlay.addEventListener('click', closeMenu);
});

const slider = document.getElementById('promoSlider');
const dots = document.querySelectorAll('.slider-dots .dot');

// Update active dot on manual scroll/swipe
slider.addEventListener('scroll', () => {
  const cardWidth = slider.querySelector('.slide-card').offsetWidth + 16; // card width + gap
  const index = Math.round(slider.scrollLeft / cardWidth);
  
  dots.forEach((dot, i) => {
    dot.classList.toggle('active', i === index);
  });
});

// Click dot to jump to slide
function currentSlide(index) {
  const cardWidth = slider.querySelector('.slide-card').offsetWidth + 16;
  slider.scrollTo({
    left: cardWidth * index,
    behavior: 'smooth'
  });
}

// Optional helper to jump back to menu when clicking "Order Now"
function scrollToMenu() {
  const menuElement = document.getElementById('menuSection') || document.querySelector('.menu-container');
  if (menuElement) {
    menuElement.scrollIntoView({ behavior: 'smooth' });
  }
}
let map = null;
let riderMarker = null;
let trackingInterval = null;
let selectedRating = 0;
let currentTrackingOrderId = null;

function initMap(initialLat = -1.286389, initialLng = 36.817223) {
  if (map) return;
  map = L.map('map').setView([initialLat, initialLng], 15);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap'
  }).addTo(map);

  const motorcycleIcon = L.divIcon({
    html: '🛵',
    className: 'custom-map-icon',
    iconSize: [30, 30]
  });

  riderMarker = L.marker([initialLat, initialLng], { icon: motorcycleIcon }).addTo(map);
}

function startCustomerOrderTracking(orderId) {
  currentTrackingOrderId = orderId;
  document.getElementById('trackingCard').style.display = 'block';
  initMap();

  trackingInterval = setInterval(async () => {
    try {
      const res = await fetch(`${BACKEND_API}/api/customer/track-order/${orderId}`);
      const data = await res.json();

      if (data.success && data.trackingActive) {
        const { lat, lng } = data.location;
        const newPos = [lat, lng];
        
        riderMarker.setLatLng(newPos);
        map.panTo(newPos);
      }
    } catch (err) {
      console.error('[Map Sync Error]:', err);
    }
  }, 4000); // Sync location every 4 seconds
}

// Star Rating Interactivity
document.querySelectorAll('#starRating span').forEach(star => {
  star.addEventListener('click', (e) => {
    selectedRating = parseInt(e.target.getAttribute('data-star'), 10);
    document.querySelectorAll('#starRating span').forEach((s, idx) => {
      s.classList.toggle('active', idx < selectedRating);
    });
  });
});

function toggleTag(btn) {
  btn.classList.toggle('selected');
}

async function submitRating() {
  if (selectedRating === 0) return alert('Please select a star rating.');

  const selectedTags = Array.from(document.querySelectorAll('.tag-btn.selected')).map(b => b.textContent.trim());
  const comment = document.getElementById('ratingComment').value.trim();

  try {
    const res = await fetch(`${BACKEND_API}/api/customer/rate-rider`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orderId: currentTrackingOrderId,
        rating: selectedRating,
        tags: selectedTags,
        comment
      })
    });

    if (res.ok) {
      alert('Thank you for rating your rider!');
      document.getElementById('ratingModal').style.display = 'none';
      if (trackingInterval) clearInterval(trackingInterval);
    }
  } catch (err) {
    alert('Failed to submit rating.');
  }
}
// ==========================================
// INITIALIZATION
// ==========================================
renderMenu();
