// Entry point: start HTTP server. (Vercel entry wraps createApp separately in api/index.js.)
const { createApp } = require('./app');

const requested = Number(process.env.PORT);
const PORT = Number.isFinite(requested) && requested > 0 ? requested : 3000;
const app = createApp();

app.listen(PORT, () => {
  console.log(`Waypoint API + client listening on http://localhost:${PORT}`);
});
