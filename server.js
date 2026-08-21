import express from 'express';
import cors from 'cors';
import { DuckDBInstance } from '@duckdb/node-api';

const PORT = process.env.PORT || 3000;
const MOTHERDUCK_TOKEN = process.env.MOTHERDUCK_TOKEN;
const DB_NAME = process.env.MOTHERDUCK_DB || 'my_db';

if (!MOTHERDUCK_TOKEN) {
  console.error('Missing MOTHERDUCK_TOKEN environment variable.');
  process.exit(1);
}

let connection;
let queue = Promise.resolve();

// Binds params by JS type (string -> VARCHAR, number -> INTEGER) using the
// typed bind methods required by @duckdb/node-api 1.5.x, then runs the query.
function runQuery(sql, params = []) {
  queue = queue.then(async () => {
    const prepared = await connection.prepare(sql);
    params.forEach((p, i) => {
      const idx = i + 1;
      if (typeof p === 'number') {
        prepared.bindInteger(idx, p);
      } else {
        prepared.bindVarchar(idx, String(p));
      }
    });
    const reader = await prepared.runAndReadAll();
    return reader.getRowObjects();
  });
  return queue;
}

async function initDb() {
  const instance = await DuckDBInstance.create(
    `md:${DB_NAME}?motherduck_token=${MOTHERDUCK_TOKEN}`
  );
  connection = await instance.connect();

  await connection.run(`CREATE SEQUENCE IF NOT EXISTS leaderboard_seq;`);
  await connection.run(`
    CREATE TABLE IF NOT EXISTS leaderboard (
      id BIGINT DEFAULT nextval('leaderboard_seq'),
      player_name VARCHAR,
      score INTEGER,
      mode VARCHAR,
      created_at TIMESTAMP DEFAULT current_timestamp
    );
  `);
  console.log('Connected to MotherDuck and ensured leaderboard table exists.');
}

const app = express();
app.disable('etag'); // avoid 304 caching responses that can confuse fetch() on the client
app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.post('/api/scores', async (req, res) => {
  try {
    let { name, score, mode } = req.body;

    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    if (typeof score !== 'number' || !Number.isFinite(score)) {
      return res.status(400).json({ error: 'score must be a number' });
    }
    mode = typeof mode === 'string' && mode.trim() ? mode.trim() : 'infinite';

    name = name.trim().slice(0, 20);
    score = Math.max(0, Math.round(score));

    await runQuery(
      `INSERT INTO leaderboard (player_name, score, mode) VALUES ($1, $2, $3);`,
      [name, score, mode]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error('Error submitting score:', err);
    res.status(500).json({ error: 'Failed to submit score' });
  }
});

app.get('/api/leaderboard', async (req, res) => {
  try {
    const mode = typeof req.query.mode === 'string' && req.query.mode.trim()
      ? req.query.mode.trim()
      : 'infinite';
    let limit = parseInt(req.query.limit, 10);
    if (!Number.isFinite(limit) || limit <= 0) limit = 10;
    limit = Math.min(limit, 100);

    const rows = await runQuery(
      `SELECT player_name, score, created_at
       FROM leaderboard
       WHERE mode = $1
       ORDER BY score DESC, created_at ASC
       LIMIT $2;`,
      [mode, limit]
    );

    res.json({ leaderboard: rows });
  } catch (err) {
    console.error('Error fetching leaderboard:', err);
    res.status(500).json({ error: 'Failed to fetch leaderboard' });
  }
});

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Leaderboard server listening on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
