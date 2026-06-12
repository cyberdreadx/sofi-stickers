const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { getStore } = require('@netlify/blobs');

// Points per pack — keep in sync with PACK_POINTS in index.html
const PACK_POINTS = { mini: 1, collection: 3, archive: 5 };

// Printful variant IDs for each pack.
// After creating your products in Printful, paste the variant IDs here.
// Find them: Printful Dashboard → Stores → your product → Edit → copy the variant ID from the URL or API.
// Set PRINTFUL_API_KEY in Netlify → Site configuration → Environment variables.
const PRINTFUL_VARIANTS = {
  mini:       null, // e.g. 123456789
  collection: null, // e.g. 123456790
  archive:    null, // e.g. 123456791
};

// POST /.netlify/functions/stripe-webhook
// Register this URL in Stripe → Webhooks. Listen for: checkout.session.completed
//
// Required env vars (Netlify → Site configuration → Environment variables):
//   STRIPE_SECRET_KEY      — Stripe Dashboard → API keys
//   STRIPE_WEBHOOK_SECRET  — Stripe Dashboard → Webhooks → signing secret
//   PRINTFUL_API_KEY       — Printful Dashboard → Settings → API → Generate token
//
// Stripe Checkout metadata setup:
//   1. On each Payment Link: add a Custom Field, type Text, key "leaderboard_name" (optional)
//   2. On each Stripe Product: add metadata  pack_type = mini | collection | archive
//      Stripe copies product metadata into the session automatically.
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // Verify the payload came from Stripe
  const sig = event.headers['stripe-signature'];
  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Stripe signature verification failed:', err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  if (stripeEvent.type !== 'checkout.session.completed') {
    return { statusCode: 200, body: 'Ignored' };
  }

  const session = stripeEvent.data.object;
  const leaderboardName = session.metadata?.leaderboard_name?.trim();
  const packType = session.metadata?.pack_type;
  const points = PACK_POINTS[packType] ?? 1;

  // Run leaderboard update and Printful fulfillment in parallel
  await Promise.all([
    updateLeaderboard({ leaderboardName, points }),
    fulfillWithPrintful({ session, packType }),
  ]);

  console.log(`Done: ${leaderboardName ?? '(anonymous)'} +${points} pts, pack: ${packType}`);
  return { statusCode: 200, body: 'OK' };
};

async function updateLeaderboard({ leaderboardName, points }) {
  const store = getStore('leaderboard');
  const state = (await store.get('state', { type: 'json' })) ?? {
    goal: 500, packsSold: 0, players: []
  };

  state.packsSold += 1;

  if (leaderboardName) {
    const player = state.players.find(p => p.name === leaderboardName);
    if (player) {
      player.points += points;
    } else {
      state.players.push({ name: leaderboardName, points });
    }
  }

  await store.set('state', JSON.stringify(state));
}

async function fulfillWithPrintful({ session, packType }) {
  const variantId = PRINTFUL_VARIANTS[packType];
  if (!variantId || !process.env.PRINTFUL_API_KEY) {
    // Printful not configured yet — skip silently, leaderboard still updates
    console.log('Printful fulfillment skipped (no variant ID or API key)');
    return;
  }

  const shipping = session.shipping_details;
  if (!shipping?.address) {
    console.warn('No shipping address on session — cannot fulfill');
    return;
  }

  const order = {
    recipient: {
      name:      shipping.name,
      address1:  shipping.address.line1,
      address2:  shipping.address.line2 ?? '',
      city:      shipping.address.city,
      state_code: shipping.address.state,
      country_code: shipping.address.country,
      zip:       shipping.address.postal_code,
      email:     session.customer_details?.email,
    },
    items: [{ variant_id: variantId, quantity: 1 }],
    // Printful will use your store's default packing slip / branding
  };

  const res = await fetch('https://api.printful.com/orders', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.PRINTFUL_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(order),
  });

  const data = await res.json();
  if (!res.ok) {
    console.error('Printful order failed:', JSON.stringify(data));
  } else {
    console.log('Printful order created:', data.result?.id);
  }
}
