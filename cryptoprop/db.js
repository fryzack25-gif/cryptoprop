// ---- db.js — PostgreSQL persistence layer ----
// users and accounts have proper rows (no race conditions).
// referrals, referralUses, audit, applications stay in kv blobs (low write volume).

import pg from "pg";
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on("error", (err) => {
  console.error("[DB] Unexpected pool error:", err.message);
});

// ---- Schema bootstrap ----
export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      email       TEXT PRIMARY KEY,
      data        JSONB NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS accounts (
      email       TEXT PRIMARY KEY,
      data        JSONB NOT NULL,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS kv (
      key   TEXT PRIMARY KEY,
      value JSONB NOT NULL
    );
  `);

  // Seed kv keys
  const kvKeys = ["referrals", "referralUses", "audit", "applications"];
  for (const key of kvKeys) {
    await pool.query(`
      INSERT INTO kv (key, value) VALUES ($1, '[]'::jsonb)
      ON CONFLICT (key) DO NOTHING
    `, [key]);
  }

  console.log("[DB] PostgreSQL ready");
}

// ---- KV helpers (for low-volume blobs) ----
async function getKv(key) {
  const res = await pool.query("SELECT value FROM kv WHERE key = $1", [key]);
  return res.rows.length ? res.rows[0].value : [];
}

async function setKv(key, value) {
  await pool.query(`
    INSERT INTO kv (key, value) VALUES ($1, $2::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `, [key, JSON.stringify(value)]);
}

// ---- User helpers ----
export async function getUser(email) {
  const res = await pool.query("SELECT data FROM users WHERE email = $1", [email]);
  return res.rows.length ? res.rows[0].data : null;
}

export async function saveUser(email, userData) {
  await pool.query(`
    INSERT INTO users (email, data) VALUES ($1, $2::jsonb)
    ON CONFLICT (email) DO UPDATE SET data = EXCLUDED.data
  `, [email, JSON.stringify(userData)]);
}

export async function getAllUsers() {
  const res = await pool.query("SELECT email, data FROM users");
  const users = {};
  for (const row of res.rows) users[row.email] = row.data;
  return users;
}

// ---- Account helpers ----
export async function getAccount(email) {
  const res = await pool.query("SELECT data FROM accounts WHERE email = $1", [email]);
  return res.rows.length ? res.rows[0].data : null;
}

export async function saveAccount(email, accountData) {
  await pool.query(`
    INSERT INTO accounts (email, data) VALUES ($1, $2::jsonb)
    ON CONFLICT (email) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
  `, [email, JSON.stringify(accountData)]);
}

export async function getAllAccounts() {
  const res = await pool.query("SELECT email, data FROM accounts");
  const accounts = {};
  for (const row of res.rows) accounts[row.email] = row.data;
  return accounts;
}

// ---- readData / writeData (backward-compat for routes that use the full object) ----
export async function readData() {
  const [accounts, users, referrals, referralUses, audit, applications] = await Promise.all([
    getAllAccounts(),
    getAllUsers(),
    getKv("referrals"),
    getKv("referralUses"),
    getKv("audit"),
    getKv("applications"),
  ]);
  return { accounts, users, referrals, referralUses, audit, applications };
}

export async function writeData(data) {
  const ops = [];

  if (data.users) {
    for (const [email, u] of Object.entries(data.users)) {
      ops.push(saveUser(email, u));
    }
  }

  if (data.accounts) {
    for (const [email, a] of Object.entries(data.accounts)) {
      ops.push(saveAccount(email, a));
    }
  }

  for (const key of ["referrals", "referralUses", "audit", "applications"]) {
    if (data[key] !== undefined) ops.push(setKv(key, data[key]));
  }

  await Promise.all(ops);
}

// ---- Audit append (no read-modify-write needed) ----
export async function appendAudit(entry) {
  await pool.query(`
    UPDATE kv SET value = value || $1::jsonb WHERE key = 'audit'
  `, [JSON.stringify([entry])]);
}

export { pool };
