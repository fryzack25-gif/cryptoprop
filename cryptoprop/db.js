// ---- db.js — PostgreSQL persistence layer ----
// Drop-in replacement for the flat data.json approach.
// Exposes the same readData() / writeData() API so server.js needs minimal changes.

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
// Runs once on startup. Creates tables if they don't exist.
export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kv (
      key   TEXT PRIMARY KEY,
      value JSONB NOT NULL
    );
  `);

  // Seed empty top-level keys if missing
  const keys = ["accounts", "users", "referrals", "referralUses", "audit", "applications"];
  for (const key of keys) {
    await pool.query(`
      INSERT INTO kv (key, value)
      VALUES ($1, $2)
      ON CONFLICT (key) DO NOTHING
    `, [key, key === "accounts" || key === "users" ? "{}" : "[]"]);
  }

  console.log("[DB] PostgreSQL ready");
}

// ---- Core helpers ----
async function getKey(key) {
  const res = await pool.query("SELECT value FROM kv WHERE key = $1", [key]);
  return res.rows.length ? res.rows[0].value : null;
}

async function setKey(key, value) {
  await pool.query(`
    INSERT INTO kv (key, value) VALUES ($1, $2)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `, [key, JSON.stringify(value)]);
}

// ---- readData — returns full data object (same shape as old JSON file) ----
export async function readData() {
  const [accounts, users, referrals, referralUses, audit, applications] = await Promise.all([
    getKey("accounts"),
    getKey("users"),
    getKey("referrals"),
    getKey("referralUses"),
    getKey("audit"),
    getKey("applications"),
  ]);

  return {
    accounts:     accounts     || {},
    users:        users        || {},
    referrals:    referrals    || [],
    referralUses: referralUses || [],
    audit:        audit        || [],
    applications: applications || [],
  };
}

// ---- writeData — persists changed keys ----
// Uses per-key upserts so concurrent writes on different keys don't block each other.
export async function writeData(data) {
  const keys = ["accounts", "users", "referrals", "referralUses", "audit", "applications"];
  await Promise.all(
    keys
      .filter(k => data[k] !== undefined)
      .map(k => setKey(k, data[k]))
  );
}

// ---- Fine-grained helpers (use these in hot paths to avoid full read/write) ----

// Read a single account by email
export async function getAccount(email) {
  const accounts = await getKey("accounts");
  return accounts ? accounts[email] || null : null;
}

// Write a single account (atomic — only updates that account's key in the JSON)
export async function saveAccount(email, account) {
  await pool.query(`
    UPDATE kv
    SET value = jsonb_set(value, $1, $2::jsonb)
    WHERE key = 'accounts'
  `, [`{${email}}`, JSON.stringify(account)]);
}

// Append to audit log
export async function appendAudit(entry) {
  await pool.query(`
    UPDATE kv
    SET value = value || $1::jsonb
    WHERE key = 'audit'
  `, [JSON.stringify([entry])]);
}

export { pool };
