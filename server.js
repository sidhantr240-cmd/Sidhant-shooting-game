require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');

const app = express();
app.use(express.json());
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));

const uri = process.env.MONGODB_URI;
const dbName = process.env.DB_NAME || 'shooting_game';

if (!uri) {
  console.error('Missing MONGODB_URI in .env — see .env.example');
  process.exit(1);
}

const client = new MongoClient(uri);
let scoresCollection;

async function start() {
  await client.connect();
  const db = client.db(dbName);
  scoresCollection = db.collection('scores');

  // Index so leaderboard queries are fast, and so we can upsert
  // "this player's best score" cleanly.
  await scoresCollection.createIndex({ score: -1 });
  await scoresCollection.createIndex({ playerId: 1 }, { unique: true, sparse: true });

  app.listen(process.env.PORT || 3000, () => {
    console.log(`Leaderboard API running on port ${process.env.PORT || 3000}`);
  });
}

// Basic input sanitation — keep names short and printable, scores numeric.
function cleanName(name) {
  if (typeof name !== 'string') return 'Player';
  return name.trim().slice(0, 16).replace(/[^\w \-]/g, '') || 'Player';
}

// POST /api/scores
// body: { playerId: "some-stable-device-or-account-id", name: "RK", score: 1234, level: 12 }
// Only updates if this is a new best for that playerId (classic "personal best" leaderboard).
app.post('/api/scores', async (req, res) => {
  try {
    const { playerId, name, score, level } = req.body;
    if (!playerId || typeof score !== 'number' || score < 0) {
      return res.status(400).json({ error: 'playerId and numeric score are required' });
    }

    const doc = {
      playerId: String(playerId).slice(0, 64),
      name: cleanName(name),
      score: Math.floor(score),
      level: Number.isFinite(level) ? Math.floor(level) : null,
      updatedAt: new Date()
    };

    const existing = await scoresCollection.findOne({ playerId: doc.playerId });
    if (!existing || doc.score > existing.score) {
      await scoresCollection.updateOne(
        { playerId: doc.playerId },
        { $set: doc },
        { upsert: true }
      );
      return res.json({ ok: true, newBest: true, score: doc.score });
    }
    res.json({ ok: true, newBest: false, score: existing.score });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save score' });
  }
});

// GET /api/leaderboard?limit=20
app.get('/api/leaderboard', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const top = await scoresCollection
      .find({}, { projection: { _id: 0, playerId: 0 } })
      .sort({ score: -1 })
      .limit(limit)
      .toArray();
    res.json(top);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load leaderboard' });
  }
});

app.get('/', (req, res) => res.send('Leaderboard API is running.'));

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
    
