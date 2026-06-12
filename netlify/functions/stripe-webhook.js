const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { getStore } = require('@netlify/blobs');

// Points per pack — keep in sync with PACK_POINTS in index.html
const PACK_POINTS = { mini: 1, collection: 3, archive: 5 };

// POST /.netlify/functions/stripe-webhook
// Register this URL in Stripe → Webhooks. Listen for: checkout.session.completed
//
// Fulfillment: StickerMule bulk orders + self-shipping.
// Orders appear in your Stripe Dashboard — pack & ship manually.
//
// Required env vars (Netlify → Site configuration → Environment variables):
//   STRIPE_SECRET_KEY      — Stripe Dashboard → API keys
//   STRIPE_WEBHOOK_SECRET  — Stripe Dashboard → Webhooks → signing secret
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

  await updateLeaderboard({ leaderboardName, points });

  console.log(`Order received: ${leaderboardName ?? '(anonymous)'} +${points} pts, pack: ${packType}`);
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
