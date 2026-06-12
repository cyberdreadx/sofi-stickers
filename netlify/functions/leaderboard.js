const { getStore } = require('@netlify/blobs');

// GET /.netlify/functions/leaderboard
// Returns live state from Netlify Blobs once the first Stripe webhook fires.
// Before that, redirects to the static leaderboard.json so the page works immediately.
exports.handler = async () => {
  try {
    const store = getStore('leaderboard');
    const state = await store.get('state', { type: 'json' });
    if (state) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        body: JSON.stringify(state)
      };
    }
  } catch (e) {
    // Blobs not seeded yet — fall through
  }

  // Pre-webhook fallback: serve the hand-edited static file
  return {
    statusCode: 302,
    headers: { Location: '/leaderboard.json' },
    body: ''
  };
};
