import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

import session from "express-session";
import bcrypt from "bcryptjs";
import cookieParser from "cookie-parser";
import { initDb, readData, writeData, getUser, saveUser, getAccount, saveAccount, pool } from "./db.js";

// ---- EMAIL via Resend ----
const RESEND_API_KEY = process.env.RESEND_API_KEY || null;
const FROM_EMAIL = "CryptoProp <noreply@thecryptoprop.com>";

async function sendEmail({ to, subject, html }) {
  if (!RESEND_API_KEY) {
    console.log(`[CryptoProp] EMAIL (no API key) to=${to} subject="${subject}" body=${html}`);
    return;
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ from: FROM_EMAIL, to, subject, html })
    });
    if (!res.ok) {
      const err = await res.text();
      console.error("[CryptoProp] Resend error:", err);
    }
  } catch (e) {
    console.error("[CryptoProp] Resend send failed:", e.message);
  }
}

// ---- CHALLENGE_EXTENSION_FEE_V1 ----
// Users can purchase +14 days once per step for $39

// ---- DYNAMIC_EXTENSION_PRICING_V1 ----
function dynamicExtensionPrice(daysLeft){
  if(daysLeft <= 1) return 19;
  if(daysLeft <= 3) return 29;
  return 39;
}
const EXTENSION_DAYS = 14;
const EXTENSION_FEE = 39;

// ---- CONSISTENCY_RULE_V1 ----
const MIN_TRADING_DAYS_STEP1 = 5;
const MIN_TRADING_DAYS_STEP2 = 7;
const MAX_SINGLE_DAY_PROFIT_SHARE = 0.40; // 40%
// ---- TWO_STEP_CHALLENGE_V1 ----
// Step 1: 8% target in 30 days, 5% trailing DD
// Step 2: 5% target in 60 days, 4% trailing DD
const STEP1_TARGET_PCT = 0.08;
const STEP1_MAX_DAYS = 30;
const STEP1_TOTAL_DD = 0.05;

const STEP2_TARGET_PCT = 0.05;
const STEP2_MAX_DAYS = 45;
const STEP2_TOTAL_DD = 0.04;

function utcDateKey(d=new Date()){
  return d.toISOString().slice(0,10);
}
function daysSince(startDateKey){
  if(!startDateKey) return 0;
  const a = new Date(startDateKey + "T00:00:00.000Z").getTime();
  const b = new Date(utcDateKey() + "T00:00:00.000Z").getTime();
  if(!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.floor((b - a) / 86400000);
}
function getStepConfig(acct){
  const step = Number(acct.challengeStep || 1);
  if(step === 2){
    return { step:2, label:"Step 2", targetPct:STEP2_TARGET_PCT, maxDays:STEP2_MAX_DAYS, totalDdLimit:STEP2_TOTAL_DD };
  }
  return { step:1, label:"Step 1", targetPct:STEP1_TARGET_PCT, maxDays:STEP1_MAX_DAYS, totalDdLimit:STEP1_TOTAL_DD };
}
function ensureStepFields(acct){
  if(acct.challengePhase === "funded") return;
  if(!acct.challengeStep) acct.challengeStep = 1;
  if(!acct.stepStartDate) acct.stepStartDate = utcDateKey();
  if(!acct.stepStartEquity) acct.stepStartEquity = Number(acct.startEquity || acct.cash || acct.equity || 0);
}

function resetTradingStateToStart(acct){
  const start = Number(acct.startEquity || acct.cash || 0);
  acct.cash = start;
  acct.equity = start;
  acct.positions = {};
  acct.avgCost = {};
  acct.realizedPnL = 0;
  acct.orders = [];
  acct.liquidations = [];
  acct.equityHistory = [];
  acct.highWatermark = start;
  acct.dayDate = null;
  acct.dayStartEquity = start;
  acct.dailyProfitHistory = {};
  acct.dailyLocked = false;
  acct.lockedUntil = null;
  acct.lockReason = null;
  ensureStepFields(acct);
  return acct;
}

function archiveChallengeStep(acct, result){
  acct.challengeHistory = Array.isArray(acct.challengeHistory) ? acct.challengeHistory : [];
  acct.challengeHistory.unshift({
    time: new Date().toISOString(),
    step: result.step,
    status: result.status, // "passed"|"failed"
    startDate: acct.stepStartDate || null,
    endDate: utcDateKey(),
    startEquity: Number(acct.stepStartEquity || 0),
    endEquity: Number(acct.equity || 0),
    returnPct: Number(result.returnPct || 0),
    reason: result.reason || null
  });
  acct.challengeHistory = acct.challengeHistory.slice(0, 50);
}

// Profit buffer before payouts + daily profit cap for payout eligibility
const PAYOUT_PROFIT_BUFFER_PCT = 0.08; // must earn 8% before any payout
const PAYOUT_DAILY_PROFIT_CAP_PCT = 0.04; // per-day profit counted toward payout capped at 4%




const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;


// ---- REAL_AUTH_V1 ----
app.set("trust proxy", 1);
app.use(cookieParser());

// ---- SECURITY: Fail fast if secrets are not set in production ----
if(process.env.NODE_ENV === "production"){
  if(!process.env.SESSION_SECRET) throw new Error("SESSION_SECRET environment variable must be set in production.");
  if(!process.env.ADMIN_KEY) throw new Error("ADMIN_KEY environment variable must be set in production.");
}
const SESSION_SECRET = process.env.SESSION_SECRET || "dev-session-secret-DO-NOT-USE-IN-PRODUCTION-" + Math.random();
app.use(session({
  name: "cp.sid",
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: (process.env.NODE_ENV === "production"),
    maxAge: 1000 * 60 * 60 * 24 * 14
  }
}));

function ensureUsers(db){ db.users = db.users || {}; return db; }
function sanitizeEmail(email){ return (email||"").toString().trim().toLowerCase(); }
function getSessionUser(req){ return req.session && req.session.user ? req.session.user : null; }
function currentEmail(req){
  const u = getSessionUser(req);
  if(!u) return null;
  // Admin beta mode: impersonate the beta account
  if(u.betaMode && u.isAdmin) return "__beta__@cryptoprop.internal";
  return u.email;
}
function requireAuth(req, res, next){
  const u = getSessionUser(req);
  if(!u) return res.status(401).json({ error:"Not authenticated" });
  return next();
}


app.use(express.json());
app.use(rateLimitByIp);

// ---- ANTI_ABUSE_V1 ----
const MAX_REQS_PER_MIN_PER_IP = 180;
const MAX_ORDERS_PER_MIN_PER_ACCOUNT = 15;
const MIN_HOLD_SECONDS = 12; // prevent instant flip/scalp in simulated env
const ADMIN_KEY = process.env.ADMIN_KEY || null; // Must be set via env var — no fallback

const ipBuckets = new Map(); // ip -> {ts,count}
const acctOrderBuckets = new Map(); // email -> {ts,count}
const lastTradeBySymbol = new Map(); // email|symbol -> lastTradeTs

function rateLimitByIp(req, res, next){
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").toString().split(",")[0].trim();
  const now = Date.now();
  const b = ipBuckets.get(ip) || { ts: now, count: 0 };
  if(now - b.ts > 60_000){ b.ts = now; b.count = 0; }
  b.count++;
  ipBuckets.set(ip, b);
  if(b.count > MAX_REQS_PER_MIN_PER_IP){
    return res.status(429).json({ error: "Rate limit exceeded" });
  }
  next();
}

function rateLimitOrders(email){
  const now = Date.now();
  const b = acctOrderBuckets.get(email) || { ts: now, count: 0 };
  if(now - b.ts > 60_000){ b.ts = now; b.count = 0; }
  b.count++;
  acctOrderBuckets.set(email, b);
  return b.count <= MAX_ORDERS_PER_MIN_PER_ACCOUNT;
}

function enforceMinHold(email, product){
  const key = `${email}|${product}`;
  const now = Date.now();
  const last = lastTradeBySymbol.get(key) || 0;
  if(last && (now - last) < MIN_HOLD_SECONDS*1000){
    return { ok:false, waitMs: (MIN_HOLD_SECONDS*1000) - (now-last) };
  }
  lastTradeBySymbol.set(key, now);
  return { ok:true, waitMs: 0 };
}


function requireAdmin(req, res, next){
  const hdr = (req.headers["x-admin-key"] || req.query.adminKey || "").toString();
  if(hdr && ADMIN_KEY && hdr === ADMIN_KEY) return next();
  const u = getSessionUser(req);
  if(u && u.isAdmin) return next();
  return res.status(403).json({ error:"Admin only" });
}



// ---- Market universe: Coinbase top 50 by market cap (demo) ----
// We build a universe by:
// 1) Fetching top 50 coins by market cap (CoinGecko)
// 2) Intersecting with Coinbase Exchange USD trading pairs (/products)
const TOP50_CACHE_MS = 10 * 60 * 1000; // 10 minutes
let top50ProductIds = [];
let top50LastUpdated = 0;

async function fetchCoinbaseUsdProducts(){
  const url = "https://api.exchange.coinbase.com/products";
  const r = await fetch(url, { headers: { "User-Agent": "CryptoProp-Demo/1.0", "Accept": "application/json" }});
  if(!r.ok) throw new Error("Failed to fetch Coinbase products.");
  const data = await r.json();
  const products = Array.isArray(data) ? data : [];
  const usdPairs = products.filter(p => p && p.quote_currency === "USD" && p.id && (!p.status || p.status === "online"));
  const idSet = new Set(usdPairs.map(p => p.id));
  return { idSet };
}

async function fetchTop50SymbolsFromCoinGecko(){
  const base = process.env.COINGECKO_API_BASE || "https://api.coingecko.com/api/v3";
  const url = `${base}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=50&page=1&sparkline=false`;
  const headers = { "Accept": "application/json", "User-Agent": "CryptoProp-Demo/1.0" };
  if(process.env.COINGECKO_API_KEY){
    headers["x-cg-pro-api-key"] = process.env.COINGECKO_API_KEY;
  }
  const r = await fetch(url, { headers });
  if(!r.ok) throw new Error("Failed to fetch CoinGecko top 50.");
  const data = await r.json();
  const coins = Array.isArray(data) ? data : [];
  return coins.map(c => String(c.symbol || "").toUpperCase()).filter(Boolean);
}

async function refreshTop50Universe(force=false){
  const now = Date.now();
  if(!force && (now - top50LastUpdated) < TOP50_CACHE_MS && top50ProductIds.length) return top50ProductIds;

  try{
    const [{ idSet }, syms] = await Promise.all([fetchCoinbaseUsdProducts(), fetchTop50SymbolsFromCoinGecko()]);
    const wanted = syms.map(s => `${s}-USD`);
    top50ProductIds = wanted.filter(pid => idSet.has(pid)).slice(0, 50);
    top50LastUpdated = now;
    return top50ProductIds;
  }catch{
    top50LastUpdated = now;
    return top50ProductIds;
  }
}

app.get("/api/market/top50", async (req, res) => {
  const list = await refreshTop50Universe(false);
  const fallback = ["BTC-USD","ETH-USD","SOL-USD","XRP-USD","ADA-USD","DOGE-USD","AVAX-USD","BNB-USD","LINK-USD"];
  return res.json({ product_ids: (list && list.length ? list : fallback), updated_at: top50LastUpdated });
});


// ---- API ----
// Legacy /api/login removed — use /api/auth/login instead

app.post("/api/applications", async (req, res) => {
  const payload = req.body || {};
  const required = ["name", "email", "tier", "experience", "message"];
  for(const k of required){
    if(!payload[k] || String(payload[k]).trim().length === 0){
      return res.status(400).json({ error: `Missing field: ${k}` });
    }
  }

  const data = await readData();
  const record = {
    id: cryptoRandomId(),
    createdAt: new Date().toISOString(),
    name: String(payload.name).trim(),
    email: String(payload.email).trim(),
    tier: String(payload.tier).trim(),
    experience: String(payload.experience).trim(),
    message: String(payload.message).trim(),
  };
  data.applications.unshift(record);
  await writeData(data);

  return res.json({ ok: true, id: record.id });
});

app.get("/api/applications", requireAuth, async (req, res) => {
  const data = await readData();
  return res.json(data.applications || []);
});



// ---- Accounts (server-side liquidity for demo) ----
async function getOrCreateAccount(email){
  let acct = await getAccount(email);
  if(!acct){
    acct = {
      cash: 0,
      baseEquity: 0,
      firmProfit: 0,
      positions: {},
      orders: [],
      openOrders: [],
      pendingOrders: [],
      challengePhase: "challenge",
      challengeStartAt: null,
      challengePassedAt: null,
      fundedActivatedAt: null,
      payoutEligibleAt: null,
      payoutsPaidTotal: 0,
      payoutsPaidThisPeriod: 0,
      payoutPeriodStart: null,
      realizedPnL: 0,
      tradingDays: [],
      dailyProfitHistory: {},
      lastEquityAtCheck: null,
      challengeHistory: [],
      extensionsUsed: {},
      stepMaxDaysOverride: null,
      attemptsByPlan: {},
      retryOfferUsed: {},
      lastPurchase: null,
      equityHistory: [],
      devices: [],
      ips: [],
      emailVerified: false,
      phoneVerified: false,
      emailVerifyCode: null,
      phoneVerifyCode: null,
      kycStatus: "not_started",
      kycSubmittedAt: null,
      kycProfile: null,
      termsAccepted: false,
      termsAcceptedAt: null,
      termsVersion: null,
      termsIp: null,
      termsUserAgent: null,
      referredBy: null,
      referralAppliedAt: null,
      firstPurchaseCredited: false
    };
    await saveAccount(email, acct);
  }
  return acct;
}

// saveAccount is imported directly from db.js — no wrapper needed

function allowlistProduct(product){
  if(Array.isArray(top50ProductIds) && top50ProductIds.includes(product)) return true;
  const allowed = new Set(["BTC-USD","ETH-USD","SOL-USD","XRP-USD","ADA-USD","DOGE-USD","AVAX-USD","BNB-USD","LINK-USD"]);
  return allowed.has(product);
}


// ---- VOL_EXEC_MODEL_V1 ----
const priceWindow = new Map(); // product -> [{t,p},...]
const PRICE_WIN_MAX = 60;

function pushPriceSample(product, price){
  if(!product || !Number.isFinite(price)) return;
  const arr = priceWindow.get(product) || [];
  arr.push({ t: Date.now(), p: Number(price) });
  while(arr.length > PRICE_WIN_MAX) arr.shift();
  priceWindow.set(product, arr);
}

function estimateVolatility(product){
  const arr = priceWindow.get(product) || [];
  if(arr.length < 6) return 0;
  const rets = [];
  for(let i=1;i<arr.length;i++){
    const a = arr[i-1].p, b = arr[i].p;
    if(a>0 && b>0) rets.push(Math.log(b/a));
  }
  if(rets.length < 5) return 0;
  const mean = rets.reduce((x,y)=>x+y,0)/rets.length;
  const varr = rets.reduce((x,y)=>x+(y-mean)*(y-mean),0)/rets.length;
  return Math.sqrt(varr);
}

function execParams(product, notional){
  const vol = estimateVolatility(product);
  const volBps = Math.min(120, Math.max(0, vol * 10000 * 1.2));
  const baseSpreadBps = 4;
  const spreadBps = baseSpreadBps + volBps;

  const sizeBps = Math.min(80, Math.max(0, (notional/1000) * 0.5));
  const slipBps = Math.min(160, 2 + volBps*0.8 + sizeBps);

  return { vol, spreadBps, slipBps };
}

function applyExecPrice(side, mid, spreadBps, slipBps){
  const spread = spreadBps / 10000;
  const slip = slipBps / 10000;
  if(side === "buy") return mid * (1 + spread/2 + slip);
  return mid * (1 - spread/2 - slip);
}

async function fetchCoinbaseTicker(product){
  const url = `https://api.exchange.coinbase.com/products/${encodeURIComponent(product)}/ticker`;
  const r = await fetch(url, {
    headers: { "User-Agent": "CryptoProp-Demo/1.0", "Accept": "application/json" }
  });
  if(!r.ok){
    const txt = await r.text().catch(()=> "");
    throw new Error("Coinbase market data error: " + String(txt).slice(0, 120));
  }
  const data = await r.json();
  const price = Number(data.price);
  if(!Number.isFinite(price)) throw new Error("Invalid price from Coinbase.");
  return price;
}

// Get account (auth required)


async function recordReferralFirstPurchase(refCode, refereeEmail, planId, amount){
  const db = ensureReferrals(await readData());
  const ref = findReferral(db, refCode);
  if(!ref) return;
  if(ref.maxUses && Number(ref.uses||0) >= Number(ref.maxUses)) return;
  ref.uses = Number(ref.uses||0) + 1;
  const commission = Number(amount||0) * Number(ref.commissionPct||DEFAULT_REFERRAL_COMMISSION_PCT);
  db.referralUses.unshift({
    time: new Date().toISOString(),
    code: ref.code,
    refereeEmail,
    planId: planId || null,
    amount: Number(amount||0),
    commission
  });
  await writeData(db);
}

// ------------------- Referral (admin-created codes) -------------------
app.post("/api/referral/apply", requireAuth, requireTermsAccepted, async (req, res) => {
  const code = normalizeCode(req.body?.code || req.query?.code || "");
  if(!code) return res.status(400).json({ error:"Missing code" });

  const db = ensureReferrals(await readData());
  const ref = findReferral(db, code);
  if(!ref) return res.status(404).json({ error:"Invalid code" });

  const email = currentEmail(req);
  const acct = await getOrCreateAccount(email);
  if(acct.referredBy) return res.status(400).json({ error:"Referral already applied" });
  if(ref.maxUses && Number(ref.uses||0) >= Number(ref.maxUses)) return res.status(400).json({ error:"Code maxed out" });

  acct.referredBy = ref.code;
  acct.referralAppliedAt = new Date().toISOString();
  await saveAccount(email, acct);
  return res.json({ ok:true, referredBy: acct.referredBy });
});

app.get("/api/account", requireAuth, async (req, res) => {
  const email = currentEmail(req); // demo token maps to single demo user
  const acct = await getOrCreateAccount(email);
  noteDeviceAndIp(acct, req);
  if(!rateLimitOrders(email)) return res.status(429).json({ error: "Too many orders per minute" });
  acct.pendingOrders = acct.pendingOrders || [];
  await refreshChallengeState(acct, email);
  acct.challengePhase = "challenge";
  acct.challengeStartAt = new Date().toISOString();
  acct.challengePassedAt = null;
  acct.fundedActivatedAt = null;
  acct.payoutEligibleAt = null;
  acct.payoutsPaidTotal = 0;
  acct.payoutsPaidThisPeriod = 0;
  acct.payoutPeriodStart = null;
  acct.realizedPnL = 0;
  acct.tradingDays = [];
  acct.dailyProfitHistory = {};
  acct.lastEquityAtCheck = null;
  await saveAccount(email, acct);
  const _cfg = getStepConfig(acct);
  const _elapsed = daysSince(acct.stepStartDate);
  const _maxDays = acct.stepMaxDaysOverride || _cfg.maxDays;
  const _daysLeft = Math.max(0, _maxDays - _elapsed);
  const _startEq = Number(acct.stepStartEquity || acct.startEquity || 0);
  const _ret = _startEq>0 ? ((Number(acct.equity||0)-_startEq)/_startEq) : 0;
  acct.challengeStepInfo = { step:_cfg.step, label:_cfg.label, targetPct:_cfg.targetPct, maxDays:_cfg.maxDays, daysLeft:_daysLeft, returnPct:_ret, trailingDdLimit:_cfg.totalDdLimit };

  acct.payoutEligiblePnL = eligibleProfitForPayout(acct);
  acct.profitBuffer = profitBufferDollar(acct);
  acct.dailyPayoutCap = dailyProfitCapDollar(acct);
  acct.withdrawable = withdrawableAmount(acct);
  acct.payoutCap = payoutCap(acct);
  acct.payoutCapRemaining = payoutCapRemaining(acct);
  return res.json(acct);
});

app.get("/api/challenge/history", requireAuth, async (req, res) => {
  const email = currentEmail(req);
  const acct = await getOrCreateAccount(email);
  acct.challengeHistory = Array.isArray(acct.challengeHistory) ? acct.challengeHistory : [];
  return res.json({ ok: true, history: acct.challengeHistory });
});

app.get("/api/equity/history", requireAuth, async (req, res) => {
  const email = currentEmail(req);
  const acct = await getOrCreateAccount(email);
  await refreshChallengeState(acct, email);
  await saveAccount(email, acct);
  const hist = Array.isArray(acct.equityHistory) ? acct.equityHistory : [];
  return res.json({ ok: true, points: hist.slice().reverse() });
});


// Request a payout (simulated). This does NOT move money externally; it records a payout and reduces withdrawable.
app.post("/api/payout/request", requireAuth, async (req, res) => {
  const email = currentEmail(req);
  const acct = await getOrCreateAccount(email);
  await refreshChallengeState(acct, email);
  if(acct.challengeFailed) return res.status(403).json({ error: "Challenge failed", reason: acct.failReason });

  if(acct.challengePhase !== "funded"){
    return res.status(400).json({ error: "Payouts available only after passing (funded phase)." });
  }

  const now = Date.now();
  const eligibleAt = new Date(acct.payoutEligibleAt || 0).getTime();
  if(!Number.isFinite(eligibleAt) || now < eligibleAt){
    return res.status(400).json({ error: "Payout not yet eligible.", eligibleAt: acct.payoutEligibleAt });
  }

  resetPayoutPeriodIfNeeded(acct);

  if(!requireVerifiedForPayout(acct)){
    return res.status(400).json({ error: "Verification required before payouts.", requirements: { emailVerified: !!acct.emailVerified, kycStatus: acct.kycStatus } });
  }

  const amount = Number(req.body?.amount);
  if(!Number.isFinite(amount) || amount <= 0){
    return res.status(400).json({ error: "Invalid payout amount." });
  }

  const withdrawable = Math.max(0, Number(acct.realizedPnL || 0) - Number(acct.payoutsPaidTotal || 0));
  const cap = Number(acct.startEquity || 0) * PAYOUT_CAP_PCT;
  const capRemaining = Math.max(0, cap - Number(acct.payoutsPaidThisPeriod || 0));

  if(amount > withdrawable){
    return res.status(400).json({ error: "Amount exceeds withdrawable.", withdrawable });
  }
  if(amount > capRemaining){
    return res.status(400).json({ error: "Amount exceeds weekly cap.", capRemaining, cap });
  }

  acct.payoutRequests = Array.isArray(acct.payoutRequests) ? acct.payoutRequests : [];
  const reqId = cryptoRandomId();
  acct.payoutRequests.unshift({ id: reqId, time: new Date().toISOString(), amount, period: acct.payoutPeriodStart, status: "pending" });

  await saveAccount(email, acct);
  return res.json({ ok: true, request: acct.payoutRequests[0], withdrawableAfter: withdrawableAmount(acct), account: acct });
});


// ------------------- Verification & KYC (demo) -------------------
app.post("/api/verify/request-email", requireAuth, async (req, res) => {
  const email = currentEmail(req);
  const acct = await getOrCreateAccount(email);
  noteDeviceAndIp(acct, req);
  acct.emailVerifyCode = genCode(6);
  await saveAccount(email, acct);
  // In production: send code via email.
  console.log("[CryptoProp] Email verify code for", email, "=>", acct.emailVerifyCode);
  await sendEmail({
    to: email,
    subject: "Your CryptoProp email verification code",
    html: `<p>Hi,</p><p>Your CryptoProp email verification code is:</p><h2 style="letter-spacing:4px">${acct.emailVerifyCode}</h2><p>Enter this code in your dashboard to verify your email address.</p><p>If you didn't request this, you can ignore this email.</p>`
  });
  return res.json({ ok:true, message: "Verification code sent to your email." });
});

app.post("/api/verify/confirm-email", requireAuth, async (req, res) => {
  const email = currentEmail(req);
  const acct = await getOrCreateAccount(email);
  const code = (req.body?.code || "").toString();
  if(code && acct.emailVerifyCode && code === acct.emailVerifyCode){
    acct.emailVerified = true;
    acct.emailVerifyCode = null;
    await saveAccount(email, acct);
    return res.json({ ok:true });
  }
  return res.status(400).json({ error:"Invalid code" });
});

app.post("/api/verify/request-phone", requireAuth, async (req, res) => {
  const email = currentEmail(req);
  const acct = await getOrCreateAccount(email);
  noteDeviceAndIp(acct, req);
  const phone = (req.body?.phone || "").toString().slice(0, 32);
  acct.phone = phone || acct.phone || null;
  acct.phoneVerifyCode = genCode(6);
  await saveAccount(email, acct);
  // In production: send code via SMS. Logged to server console only.
  console.log("[CryptoProp] Phone verify code for", email, "=>", acct.phoneVerifyCode);
  return res.json({ ok:true, message: "Verification code sent to your phone." });
});

app.post("/api/verify/confirm-phone", requireAuth, async (req, res) => {
  const email = currentEmail(req);
  const acct = await getOrCreateAccount(email);
  const code = (req.body?.code || "").toString();
  if(code && acct.phoneVerifyCode && code === acct.phoneVerifyCode){
    acct.phoneVerified = true;
    acct.phoneVerifyCode = null;
    await saveAccount(email, acct);
    return res.json({ ok:true });
  }
  return res.status(400).json({ error:"Invalid code" });
});

app.post("/api/kyc/submit", requireAuth, async (req, res) => {
  const email = currentEmail(req);
  const acct = await getOrCreateAccount(email);
  noteDeviceAndIp(acct, req);
  const profile = req.body?.profile || {};
  acct.kycProfile = {
    name: (profile.name || "").toString().slice(0, 120),
    dob: (profile.dob || "").toString().slice(0, 20),
    address: (profile.address || "").toString().slice(0, 180),
    docType: (profile.docType || "").toString().slice(0, 40),
    note: (profile.note || "").toString().slice(0, 240),
  };
  acct.kycStatus = "pending";
  acct.kycSubmittedAt = new Date().toISOString();
  await saveAccount(email, acct);
  return res.json({ ok:true, status: acct.kycStatus });
});


// Seed liquidity (auth required)
app.post("/api/account/seed", requireAuth, async (req, res) => {
  const email = currentEmail(req);
  const acct = await getOrCreateAccount(email);
  acct.cash = Math.max(acct.cash || 0, 50000);
  acct.baseEquity = Math.max(acct.baseEquity || 0, acct.cash);
  acct.startEquity = acct.startEquity || acct.baseEquity;
  acct.challengePhase = acct.challengePhase || "challenge";
  acct.challengeStartAt = acct.challengeStartAt || new Date().toISOString();
  acct.payoutsPaidTotal = acct.payoutsPaidTotal || 0;
  acct.payoutsPaidThisPeriod = acct.payoutsPaidThisPeriod || 0;
  acct.realizedPnL = acct.realizedPnL || 0;
  acct.tradingDays = acct.tradingDays || [];
  acct.dailyProfitHistory = acct.dailyProfitHistory || {};
  acct.lastEquityAtCheck = acct.lastEquityAtCheck || null;
  acct.peakEquity = Math.max(acct.peakEquity || 0, acct.startEquity);
  acct.trailingFloor = acct.trailingFloor || (acct.peakEquity * (1 - CHALLENGE_TOTAL_DD));
  acct.dayDate = acct.dayDate || (new Date()).toISOString().slice(0,10);
  acct.dayStartEquity = acct.dayStartEquity || acct.baseEquity;
  acct.dayLowEquity = acct.dayLowEquity || acct.baseEquity;
  acct.firmProfit = acct.firmProfit || 0;
  acct.challengeFailed = acct.challengeFailed || false;

await saveAccount(email, acct);
  const _cfg = getStepConfig(acct);
  const _elapsed = daysSince(acct.stepStartDate);
  const _maxDays = acct.stepMaxDaysOverride || _cfg.maxDays;
  const _daysLeft = Math.max(0, _maxDays - _elapsed);
  const _startEq = Number(acct.stepStartEquity || acct.startEquity || 0);
  const _ret = _startEq>0 ? ((Number(acct.equity||0)-_startEq)/_startEq) : 0;
  acct.challengeStepInfo = { step:_cfg.step, label:_cfg.label, targetPct:_cfg.targetPct, maxDays:_cfg.maxDays, daysLeft:_daysLeft, returnPct:_ret, trailingDdLimit:_cfg.totalDdLimit };

  acct.payoutEligiblePnL = eligibleProfitForPayout(acct);
  acct.profitBuffer = profitBufferDollar(acct);
  acct.dailyPayoutCap = dailyProfitCapDollar(acct);
  acct.withdrawable = withdrawableAmount(acct);
  acct.payoutCap = payoutCap(acct);
  acct.payoutCapRemaining = payoutCapRemaining(acct);
  return res.json(acct);
});

// Reset account (auth required)
app.post("/api/account/reset", requireAuth, async (req, res) => {
  const email = currentEmail(req);
  const acct = { cash: 0, baseEquity: 0, firmProfit: 0, positions: {}, orders: [], openOrders: [], pendingOrders: [], startEquity: 0, dayDate: null, dayStartEquity: 0, dayLowEquity: 0, challengeFailed: false, failReason: null, failedAt: null, equity: 0, dayDD: 0, totalDD: 0, peakEquity: 0, trailingFloor: 0 };
  await saveAccount(email, acct);
  const _cfg = getStepConfig(acct);
  const _elapsed = daysSince(acct.stepStartDate);
  const _maxDays = acct.stepMaxDaysOverride || _cfg.maxDays;
  const _daysLeft = Math.max(0, _maxDays - _elapsed);
  const _startEq = Number(acct.stepStartEquity || acct.startEquity || 0);
  const _ret = _startEq>0 ? ((Number(acct.equity||0)-_startEq)/_startEq) : 0;
  acct.challengeStepInfo = { step:_cfg.step, label:_cfg.label, targetPct:_cfg.targetPct, maxDays:_cfg.maxDays, daysLeft:_daysLeft, returnPct:_ret, trailingDdLimit:_cfg.totalDdLimit };

  acct.payoutEligiblePnL = eligibleProfitForPayout(acct);
  acct.profitBuffer = profitBufferDollar(acct);
  acct.dailyPayoutCap = dailyProfitCapDollar(acct);
  acct.withdrawable = withdrawableAmount(acct);
  acct.payoutCap = payoutCap(acct);
  acct.payoutCapRemaining = payoutCapRemaining(acct);
  return res.json(acct);
});

// Place a simulated spot trade at last price (auth required)
app.post("/api/trade", requireAuth, requireTermsAccepted, guardChallenge, async (req, res) => {
  await refreshTop50Universe(false).catch(()=>{});

  const email = currentEmail(req);
  const { product, side, qty } = req.body || {};
  const p = String(product || "").trim();
  const s = String(side || "").trim().toLowerCase();
  const q = Number(qty);

  if(!p || !s || !Number.isFinite(q) || q <= 0){
    return res.status(400).json({ error: "Invalid order parameters." });
  }
  if(s !== "buy" && s !== "sell"){
    return res.status(400).json({ error: "Side must be buy or sell." });
  }
  if(!allowlistProduct(p)){
    return res.status(400).json({ error: "Unsupported product. Use a Coinbase USD pair from /api/market/top50." });
  }

  const acct = await getOrCreateAccount(email);
  acct.positions = acct.positions || {};
  acct.orders = acct.orders || [];
  acct.openOrders = acct.openOrders || [];
  acct.pendingOrders = acct.pendingOrders || [];

  // Use current price to enforce position cap (1% hard cap)
  let priceNow;
  try{
    priceNow = await fetchCoinbaseTicker(p);
  }catch(err){
    return res.status(502).json({ error: err.message || "Market data unavailable." });
  }

  acct.baseEquity = Math.max(acct.baseEquity || 0, acct.cash || 0);
  const maxNotional = maxTradeNotional(acct);
  const notionalNow = q * priceNow;

  if(s === "buy"){
    const mh = enforceMinHold(email, p);
    if(!mh.ok){ return res.status(400).json({ error: `Min hold rule: wait ${Math.ceil(mh.waitMs/1000)}s before trading ${p} again.` }); }

    const posNot = positionNotional(acct, p, priceNow);
    const openNot = openBuyNotional(acct, p);
    const after = posNot + openNot + notionalNow;
    if(after > maxNotional){
      return res.status(400).json({ error: `Position size too large (1% max). Current+open: $${(posNot+openNot).toFixed(2)}; After: $${after.toFixed(2)}; Limit: $${maxNotional.toFixed(2)}` });
    }

    // Reserve cash using worst-case fee + price buffer
    const reserveBuffer = 1.01; // small cushion
    const reservedCash = (notionalNow * reserveBuffer) + (notionalNow * TAKER_FEE);
    if((acct.cash || 0) < reservedCash){
      return res.status(400).json({ error: "Insufficient cash." });
    }
    acct.cash = (acct.cash || 0) - reservedCash;

    const id = cryptoRandomId();
    const etaMs = randomFillDelayMs();
    const executeAt = Date.now() + etaMs;

    acct.pendingOrders.unshift({
      id,
      time: new Date().toISOString(),
      executeAt,
      product: p,
      side: s,
      qty: round8(q),
      reservedCash,
      feeRate: TAKER_FEE,
      type: "market"
    });

    await saveAccount(email, acct);
    return res.json({ ok: true, queued: true, id, executeAt, etaMs, account: acct });
  }

  if(s === "sell"){
    const mh = enforceMinHold(email, p);
    if(!mh.ok){ return res.status(400).json({ error: `Min hold rule: wait ${Math.ceil(mh.waitMs/1000)}s before trading ${p} again.` }); }
  }

  // SELL: reserve qty by removing from position now
  const pos = acct.positions[p] || { qty: 0, avg: 0 };
  if((pos.qty || 0) < q){
    return res.status(400).json({ error: "Insufficient position." });
  }
  const avg = pos.avg || 0;
  pos.qty = round8(pos.qty - q);
  if(pos.qty === 0) delete acct.positions[p];
  else acct.positions[p] = pos;

  const id = cryptoRandomId();
  const etaMs = randomFillDelayMs();
  const executeAt = Date.now() + etaMs;

  acct.pendingOrders.unshift({
    id,
    time: new Date().toISOString(),
    executeAt,
    product: p,
    side: s,
    qty: round8(q),
    reservedQty: round8(q),
    avg,
    feeRate: TAKER_FEE,
    type: "market"
  });

  await saveAccount(email, acct);
  return res.json({ ok: true, queued: true, id, executeAt, etaMs, account: acct });
});

app.post("/api/orders/limit", requireAuth, guardChallenge, async (req, res) => {
  await refreshTop50Universe(false).catch(()=>{});
  const email = currentEmail(req);
  const { product, side, qty, limitPrice } = req.body || {};
  const p = String(product || "").trim();
  const s = String(side || "").trim().toLowerCase();
  const q = Number(qty);
  const lp = Number(limitPrice);

  if(!p || !s || !Number.isFinite(q) || q <= 0 || !Number.isFinite(lp) || lp <= 0){
    return res.status(400).json({ error: "Invalid limit order parameters." });
  }
  if(s !== "buy" && s !== "sell"){
    return res.status(400).json({ error: "Side must be buy or sell." });
  }
  if(!allowlistProduct(p)){
    return res.status(400).json({ error: "Unsupported product. Use a Coinbase USD pair from /api/market/top50." });
  }

  const acct = await getOrCreateAccount(email);
  acct.openOrders = acct.openOrders || [];
  acct.positions = acct.positions || {};
  acct.orders = acct.orders || [];

  const notional = q * lp;
  const fee = notional * MAKER_FEE;

  acct.baseEquity = Math.max(acct.baseEquity || 0, acct.cash || 0);
  const maxNotional = maxTradeNotional(acct);

  if(s === "buy"){
    const posNot = positionNotional(acct, p, lp);
    const openNot = openBuyNotional(acct, p);
    const after = posNot + openNot + notional;
    if(after > maxNotional){
      return res.status(400).json({ error: `Position size too large (1% max). Current+open: $${(posNot+openNot).toFixed(2)}; After: $${after.toFixed(2)}; Limit: $${maxNotional.toFixed(2)}` });
    }
  }

  if(s === "buy"){
    const reserve = notional + fee;
    if((acct.cash || 0) < reserve){
      return res.status(400).json({ error: "Insufficient cash to place buy limit (includes reserved fee)." });
    }
    acct.cash = (acct.cash || 0) - reserve;
  }else{
    const pos = acct.positions[p] || { qty: 0, avg: 0 };
    if((pos.qty || 0) < q){
      return res.status(400).json({ error: "Insufficient position to place sell limit." });
    }
    pos.qty = round8(pos.qty - q);
    acct.positions[p] = pos;
    if(pos.qty === 0) delete acct.positions[p];
  }

  const order = {
    id: cryptoRandomId(),
    time: new Date().toISOString(),
    product: p,
    side: s,
    type: "limit",
    qty: round8(q),
    limitPrice: lp,
    feeRate: MAKER_FEE
  };
  acct.openOrders.unshift(order);
  await saveAccount(email, acct);
  const _cfg = getStepConfig(acct);
  const _elapsed = daysSince(acct.stepStartDate);
  const _maxDays = acct.stepMaxDaysOverride || _cfg.maxDays;
  const _daysLeft = Math.max(0, _maxDays - _elapsed);
  const _startEq = Number(acct.stepStartEquity || acct.startEquity || 0);
  const _ret = _startEq>0 ? ((Number(acct.equity||0)-_startEq)/_startEq) : 0;
  acct.challengeStepInfo = { step:_cfg.step, label:_cfg.label, targetPct:_cfg.targetPct, maxDays:_cfg.maxDays, daysLeft:_daysLeft, returnPct:_ret, trailingDdLimit:_cfg.totalDdLimit };

  acct.payoutEligiblePnL = eligibleProfitForPayout(acct);
  acct.profitBuffer = profitBufferDollar(acct);
  acct.dailyPayoutCap = dailyProfitCapDollar(acct);
  acct.withdrawable = withdrawableAmount(acct);
  acct.payoutCap = payoutCap(acct);
  acct.payoutCapRemaining = payoutCapRemaining(acct);
  return res.json(acct);
});

app.post("/api/orders/cancel", requireAuth, async (req, res) => {
  const email = currentEmail(req);
  const { id } = req.body || {};
  const oid = String(id || "").trim();
  if(!oid) return res.status(400).json({ error: "Missing id." });

  const acct = await getOrCreateAccount(email);
  acct.openOrders = acct.openOrders || [];
  acct.positions = acct.positions || {};

  const idx = acct.openOrders.findIndex(o => o.id === oid);
  if(idx === -1) return res.status(404).json({ error: "Order not found." });

  const o = acct.openOrders[idx];
  acct.openOrders.splice(idx, 1);

  const notional = o.qty * o.limitPrice;
  const fee = notional * MAKER_FEE;

  if(o.side === "buy"){
    acct.cash = (acct.cash || 0) + (notional + fee);
  }else{
    const pos = acct.positions[o.product] || { qty: 0, avg: 0 };
    pos.qty = round8((pos.qty || 0) + o.qty);
    acct.positions[o.product] = pos;
  }

  await saveAccount(email, acct);
  const _cfg = getStepConfig(acct);
  const _elapsed = daysSince(acct.stepStartDate);
  const _maxDays = acct.stepMaxDaysOverride || _cfg.maxDays;
  const _daysLeft = Math.max(0, _maxDays - _elapsed);
  const _startEq = Number(acct.stepStartEquity || acct.startEquity || 0);
  const _ret = _startEq>0 ? ((Number(acct.equity||0)-_startEq)/_startEq) : 0;
  acct.challengeStepInfo = { step:_cfg.step, label:_cfg.label, targetPct:_cfg.targetPct, maxDays:_cfg.maxDays, daysLeft:_daysLeft, returnPct:_ret, trailingDdLimit:_cfg.totalDdLimit };

  acct.payoutEligiblePnL = eligibleProfitForPayout(acct);
  acct.profitBuffer = profitBufferDollar(acct);
  acct.dailyPayoutCap = dailyProfitCapDollar(acct);
  acct.withdrawable = withdrawableAmount(acct);
  acct.payoutCap = payoutCap(acct);
  acct.payoutCapRemaining = payoutCapRemaining(acct);
  return res.json(acct);
});

app.post("/api/orders/process", requireAuth, guardChallenge, async (req, res) => {
  const email = currentEmail(req);
  const acct = await getOrCreateAccount(email);
  acct.openOrders = acct.openOrders || [];
  acct.positions = acct.positions || {};
  acct.orders = acct.orders || [];

  if(acct.openOrders.length === 0){
    const _cfg = getStepConfig(acct);
  const _elapsed = daysSince(acct.stepStartDate);
  const _maxDays = acct.stepMaxDaysOverride || _cfg.maxDays;
  const _daysLeft = Math.max(0, _maxDays - _elapsed);
  const _startEq = Number(acct.stepStartEquity || acct.startEquity || 0);
  const _ret = _startEq>0 ? ((Number(acct.equity||0)-_startEq)/_startEq) : 0;
  acct.challengeStepInfo = { step:_cfg.step, label:_cfg.label, targetPct:_cfg.targetPct, maxDays:_cfg.maxDays, daysLeft:_daysLeft, returnPct:_ret, trailingDdLimit:_cfg.totalDdLimit };

  acct.payoutEligiblePnL = eligibleProfitForPayout(acct);
  acct.profitBuffer = profitBufferDollar(acct);
  acct.dailyPayoutCap = dailyProfitCapDollar(acct);
  acct.withdrawable = withdrawableAmount(acct);
  acct.payoutCap = payoutCap(acct);
  acct.payoutCapRemaining = payoutCapRemaining(acct);
  return res.json(acct);
  }

  const remaining = [];
  for(const o of acct.openOrders){
    try{
      const last = await fetchCoinbaseTicker(o.product);
      const canFill = (o.side === "buy") ? (last <= o.limitPrice) : (last >= o.limitPrice);
      if(!canFill){
        remaining.push(o);
        continue;
      }

      // Max position size check (1%): if buy would exceed limit, cancel and refund reservation
      const maxNotional = maxTradeNotional(acct);
      if(o.side === "buy"){
        const posNotional = positionNotional(acct, o.product, o.limitPrice);
        if((posNotional + (o.qty * o.limitPrice)) > maxNotional){
          // Cancel: refund reserved cash + maker fee reservation already deducted on placement
          const notionalCancel = o.qty * o.limitPrice;
          const feeCancel = notionalCancel * MAKER_FEE;
          acct.cash = (acct.cash || 0) + (notionalCancel + feeCancel);
          // Do not keep order
          continue;
        }
      }

      const price = o.limitPrice;
      const notional = o.qty * price;
      const fee = notional * MAKER_FEE;

      if(o.side === "buy"){
        const pos = acct.positions[o.product] || { qty: 0, avg: 0 };
        const newQty = (pos.qty || 0) + o.qty;
        const newAvg = newQty === 0 ? 0 : (((pos.qty || 0) * (pos.avg || 0)) + (o.qty * price)) / newQty;
        pos.qty = round8(newQty);
        pos.avg = newAvg;
        acct.positions[o.product] = pos;
      }else{
        acct.cash = (acct.cash || 0) + (notional - fee);
        applyProfitSplitOnSell(acct, o.product, o.qty, price);
      }

      const fill = {
        id: cryptoRandomId(),
        time: new Date().toISOString(),
        product: o.product,
        side: o.side,
        type: "limit",
        qty: o.qty,
        price,
        notional,
        fee,
        feeRate: MAKER_FEE
      };
      acct.orders.unshift(fill);
    }catch{
      remaining.push(o);
    }
  }

  acct.openOrders = remaining;
  await saveAccount(email, acct);
  const _cfg = getStepConfig(acct);
  const _elapsed = daysSince(acct.stepStartDate);
  const _maxDays = acct.stepMaxDaysOverride || _cfg.maxDays;
  const _daysLeft = Math.max(0, _maxDays - _elapsed);
  const _startEq = Number(acct.stepStartEquity || acct.startEquity || 0);
  const _ret = _startEq>0 ? ((Number(acct.equity||0)-_startEq)/_startEq) : 0;
  acct.challengeStepInfo = { step:_cfg.step, label:_cfg.label, targetPct:_cfg.targetPct, maxDays:_cfg.maxDays, daysLeft:_daysLeft, returnPct:_ret, trailingDdLimit:_cfg.totalDdLimit };

  acct.payoutEligiblePnL = eligibleProfitForPayout(acct);
  acct.profitBuffer = profitBufferDollar(acct);
  acct.dailyPayoutCap = dailyProfitCapDollar(acct);
  acct.withdrawable = withdrawableAmount(acct);
  acct.payoutCap = payoutCap(acct);
  acct.payoutCapRemaining = payoutCapRemaining(acct);
  return res.json(acct);
});

// ---- Prop rules ----
const PROFIT_SPLIT_TRADER = 0.80; // 80% to trader
const PROFIT_SPLIT_FIRM = 0.20;   // 20% to firm
const MAX_TRADE_PCT = 0.01; // 1% of base equity max position
const TAKER_FEE = 0.0010; // 0.10% taker fee (sim)
const MAKER_FEE = 0.0005; // 0.05% maker fee (sim)

// ---- Recommended parameters (v1) ----
const RECOMMENDED_PARAMS_V1 = true;
const PROFIT_TARGET_PCT = 0.08;     // 8% profit target (challenge)
const CHALLENGE_TIME_LIMIT_DAYS = 30;
const MIN_TRADING_DAYS = 5;
const CONSISTENCY_MAX_DAY_SHARE = 0.40; // max single-day profit share of total profit to pass
const PAYOUT_FIRST_DELAY_DAYS = 14;     // first payout available 14 days after funded activation
const PAYOUT_PERIOD_DAYS = 7;           // weekly payout cadence
const PAYOUT_CAP_PCT = 0.04;            // max 4% of starting equity per payout period

// ---- Challenge rules (demo) ----
const CHALLENGE_DAILY_DD = 0.02;  // 2% daily max drawdown
const CHALLENGE_TOTAL_DD = 0.05;  // 5% max drawdown (TRAILING from peak equity)

// price cache for equity calc
const EQ_TICKER_CACHE_MS = 2000;
const eqTickerCache = new Map(); // product -> { ts, price }

async function cachedLastPrice(product){
  const now = Date.now();
  const c = eqTickerCache.get(product);
  if(c && (now - c.ts) < EQ_TICKER_CACHE_MS) return c.price;
  const px = await fetchCoinbaseTicker(product);
  eqTickerCache.set(product, { ts: now, price: px });
  return px;
}

function isoDay(d=new Date()){
  return d.toISOString().slice(0,10);
}

async function computeEquity(acct){
  const positions = acct.positions || {};
  const products = Object.keys(positions);
  const prices = await Promise.all(products.map(async p => {
    const qty = Number(positions[p]?.qty || 0);
    if(!Number.isFinite(qty) || qty === 0) return 0;
    const px = await cachedLastPrice(p);
    return qty * px;
  }));
  const posVal = prices.reduce((a,b)=>a+b,0);
  return Number(acct.cash || 0) + posVal;
}



function uniqPush(arr, v){
  if(!Array.isArray(arr)) return [v];
  if(!arr.includes(v)) arr.push(v);
  return arr;
}

function payoutPeriodKey(d=new Date()){
  // weekly cadence based on ISO week key
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(),0,1));
  const weekNo = Math.ceil((((date - yearStart)/86400000) + 1)/7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2,"0")}`;
}

function currentDayProfit(acct, eqNow){
  // profit vs dayStartEquity (can be negative)
  const base = Number(acct.dayStartEquity || 0);
  return eqNow - base;
}

function maxDailyProfitShare(acct, eqNow){
  const hist = acct.dailyProfitHistory || {};
  const today = isoDay();
  const totalProfit = eqNow - Number(acct.startEquity || 0);
  if(totalProfit <= 0) return { share: 1, maxDayProfit: 0, totalProfit };
  let maxDay = 0;
  for(const k of Object.keys(hist)){
    maxDay = Math.max(maxDay, Number(hist[k] || 0));
  }
  // include current day if positive
  const cur = currentDayProfit(acct, eqNow);
  if(cur > 0) maxDay = Math.max(maxDay, cur);
  return { share: maxDay / totalProfit, maxDayProfit: maxDay, totalProfit };
}

function resetPayoutPeriodIfNeeded(acct){
  const key = payoutPeriodKey();
  if(acct.payoutPeriodStart !== key){
    acct.payoutPeriodStart = key;
    acct.payoutsPaidThisPeriod = 0;
  }
}



function archiveChallengeRun(acct, snapshot){
  acct.challengeHistory = Array.isArray(acct.challengeHistory) ? acct.challengeHistory : [];
  acct.challengeHistory.unshift({
    id: cryptoRandomId(),
    archivedAt: new Date().toISOString(),
    ...snapshot
  });
  // keep last 50
  acct.challengeHistory = acct.challengeHistory.slice(0, 50);
}

function resetToStartingBalanceOnPass(acct){
  const start = Number(acct.startEquity || 0);
  if(!Number.isFinite(start) || start <= 0) return;

  // Wipe risk exposure
  acct.positions = {};
  acct.openOrders = [];
  acct.pendingOrders = [];

  // Reset cash so equity equals starting balance
  acct.cash = start;

  // Reset equity tracking baselines
  const today = isoDay();
  acct.dailyLocked = false;
  acct.lockedUntil = null;
  acct.lockReason = null;
  acct.dayDate = today;
  acct.dayStartEquity = start;
  acct.dayLowEquity = start;
  acct.lastEquityAtCheck = start;

  // Reset trailing drawdown baseline in funded phase
  acct.peakEquity = start;
  acct.trailingFloor = start * (1 - CHALLENGE_TOTAL_DD);

  // Reset performance accounting for funded phase
  acct.realizedPnL = 0;
  acct.payoutsPaidTotal = 0;
  acct.payoutsPaidThisPeriod = 0;
  acct.payoutPeriodStart = null;
  acct.payouts = [];

  // Funded phase starts fresh; keep trading day history but it's okay to clear
  acct.tradingDays = [];
  acct.dailyProfitHistory = {};
  acct.passBlockedReason = null;
}



function profitBufferDollar(acct){
  return Number(acct.startEquity || 0) * PAYOUT_PROFIT_BUFFER_PCT;
}

function dailyProfitCapDollar(acct){
  return Number(acct.startEquity || 0) * PAYOUT_DAILY_PROFIT_CAP_PCT;
}

function eligibleProfitForPayout(acct){
  // Net PnL, but cap *positive* daily profit contributions (losses count fully).
  const hist = acct.dailyProfitHistory || {};
  const start = Number(acct.startEquity || 0);
  const cap = dailyProfitCapDollar(acct);
  let sum = 0;

  // include historical days
  for(const k of Object.keys(hist)){
    const v = Number(hist[k] || 0);
    if(v >= 0) sum += Math.min(v, cap);
    else sum += v;
  }

  // include current day-to-date profit (not yet in history) so UI feels real-time
  const todayKey = (new Date()).toISOString().slice(0,10);
  const curDay = Number(acct.equity || 0) - Number(acct.dayStartEquity || 0);
  if(!(todayKey in hist)){
    if(curDay >= 0) sum += Math.min(curDay, cap);
    else sum += curDay;
  }

  return sum;
}

function withdrawableAmount(acct){
  const pending = (Array.isArray(acct.payoutRequests)?acct.payoutRequests:[]).filter(r=>r.status==='pending').reduce((a,r)=>a+Number(r.amount||0),0);
  const eligible = eligibleProfitForPayout(acct);
  const buffer = profitBufferDollar(acct);
  return Math.max(0, eligible - buffer - Number(acct.payoutsPaidTotal || 0) - pending);
}

function payoutCap(acct){
  return Number(acct.startEquity || 0) * PAYOUT_CAP_PCT;
}

function payoutCapRemaining(acct){
  const cap = payoutCap(acct);
  return Math.max(0, cap - Number(acct.payoutsPaidThisPeriod || 0));
}

function pushEquityPoint(acct, equity){
  acct.equityHistory = Array.isArray(acct.equityHistory) ? acct.equityHistory : [];
  const now = Date.now();
  const last = acct.equityHistory.length ? acct.equityHistory[0] : null; // newest first
  if(last && (now - Number(last.t || 0)) < 60_000) return; // 1-minute throttle
  acct.equityHistory.unshift({ t: now, e: Number(equity || 0) });
  acct.equityHistory = acct.equityHistory.slice(0, 2000);
}


// ---- AUTO_FLATTEN_LOCKOUT_V1 ----
function nextUtcMidnightIso(){
  const d = new Date();
  d.setUTCHours(24,0,0,0); // next midnight UTC
  return d.toISOString();
}

async function autoFlattenAllPositions(email, acct, reason){
  const pos = acct.positions || {};
  const symbols = Object.keys(pos);
  if(symbols.length === 0) return;

  acct.liquidations = Array.isArray(acct.liquidations) ? acct.liquidations : [];

  for(const p of symbols){
    const qty = Number(pos[p] || 0);
    if(!qty || qty <= 0) continue;

    const mid = await fetchCoinbaseTicker(p).catch(()=>null);
    if(!mid || !Number.isFinite(mid)) continue;

    const notional = qty * mid;
    const { spreadBps, slipBps } = execParams(p, notional);
    const px = applyExecPrice("sell", mid, spreadBps, slipBps);

    const avg = Number((acct.avgCost && acct.avgCost[p]) || 0);
    const pnl = (px - avg) * qty;

    acct.cash = Number(acct.cash||0) + qty * px;
    acct.realizedPnL = Number(acct.realizedPnL||0) + pnl;

    acct.orders = Array.isArray(acct.orders) ? acct.orders : [];
    acct.orders.unshift({
      id: cryptoRandomId(),
      time: new Date().toISOString(),
      product: p,
      side: "sell",
      type: "liquidation",
      qty: round8(qty),
      mid,
      price: px,
      notional: qty*px,
      fee: 0,
      feeRate: 0,
      execCostBps: (spreadBps/2) + slipBps,
      note: reason || "Auto-flatten"
    });

    acct.liquidations.unshift({
      time: new Date().toISOString(),
      product: p,
      qty: round8(qty),
      mid,
      price: px,
      pnl,
      reason: reason || "Auto-flatten"
    });

    pos[p] = 0;
    if(acct.avgCost) acct.avgCost[p] = 0;
  }

  acct.positions = Object.fromEntries(Object.entries(pos).filter(([k,v]) => Number(v||0) > 0));

  await saveAccount(email, acct);
}

async function refreshChallengeState(acct, email){
  ensureStepFields(acct);
  acct.baseEquity = Math.max(acct.baseEquity || 0, acct.cash || 0);
  if(!acct.startEquity || acct.startEquity <= 0){
    // startEquity locks at the time the account is seeded/first funded
    acct.startEquity = acct.baseEquity || acct.cash || 0;
  }

  const today = isoDay();
  if(!acct.dayDate || acct.dayDate !== today){
    // persist yesterday profit into history
    if(acct.dayDate && acct.lastEquityAtCheck != null){
      const yProfit = Number(acct.lastEquityAtCheck) - Number(acct.dayStartEquity || 0);
      acct.dailyProfitHistory = acct.dailyProfitHistory || {};
      acct.dailyProfitHistory[acct.dayDate] = yProfit;
    }
    // reset daily baseline at start of day (mark-to-market)
    const eq = await computeEquity(acct);
    acct.dayDate = today;
    acct.dayStartEquity = eq;
    acct.dayLowEquity = eq;
  }

  const eqNow = await computeEquity(acct);
  acct.dayLowEquity = Math.min(Number(acct.dayLowEquity ?? eqNow), eqNow);

  const dayDD = acct.dayStartEquity > 0 ? (acct.dayStartEquity - acct.dayLowEquity) / acct.dayStartEquity : 0;
  // Trailing max drawdown from peak equity
  acct.peakEquity = Math.max(Number(acct.peakEquity || 0), eqNow, Number(acct.startEquity || 0));
  acct.trailingFloor = acct.peakEquity * (1 - CHALLENGE_TOTAL_DD);
  const totalDD = acct.peakEquity > 0 ? (acct.peakEquity - eqNow) / acct.peakEquity : 0;

  
  // Challenge time limit (only while in challenge phase)
  if(acct.challengePhase === "challenge"){
    const elapsedDays = daysSince(acct.challengeStartAt);
    if(elapsedDays > CHALLENGE_TIME_LIMIT_DAYS && !acct.challengeFailed){
      acct.challengeFailed = true;
      acct.failedAt = new Date().toISOString();
      acct.failReason = `Challenge time limit exceeded: ${elapsedDays} days (max ${CHALLENGE_TIME_LIMIT_DAYS})`;
    }
  }

  // Challenge pass logic: profit target + min trading days + consistency rule
  if(acct.challengePhase === "challenge" && !acct.challengeFailed){
    const targetEq = Number(acct.startEquity || 0) * (1 + PROFIT_TARGET_PCT);
    const tradedDays = Array.isArray(acct.tradingDays) ? acct.tradingDays.length : 0;
    if(eqNow >= targetEq && tradedDays >= MIN_TRADING_DAYS){
      const { share, maxDayProfit, totalProfit } = maxDailyProfitShare(acct, eqNow);
      if(share <= CONSISTENCY_MAX_DAY_SHARE){
        acct.challengePhase = "funded";
        acct.challengePassedAt = new Date().toISOString();
        acct.fundedActivatedAt = new Date().toISOString();
        acct.payoutEligibleAt = new Date(Date.now() + PAYOUT_FIRST_DELAY_DAYS*24*3600*1000).toISOString();
        // Archive challenge results BEFORE resetting
        archiveChallengeRun(acct, {
          startEquity: Number(acct.startEquity || 0),
          endEquity: Number(eqNow || 0),
          profitPct: (Number(acct.startEquity || 0) > 0) ? ((Number(eqNow || 0) - Number(acct.startEquity || 0)) / Number(acct.startEquity || 0)) : 0,
          tradingDays: Array.isArray(acct.tradingDays) ? acct.tradingDays.length : 0,
          challengeStartAt: acct.challengeStartAt,
          challengePassedAt: acct.challengePassedAt,
          rules: {
            profitTargetPct: PROFIT_TARGET_PCT,
            timeLimitDays: CHALLENGE_TIME_LIMIT_DAYS,
            minTradingDays: MIN_TRADING_DAYS,
            dailyDDPct: CHALLENGE_DAILY_DD,
            trailingDDPct: CHALLENGE_TOTAL_DD,
            consistencyMaxDayShare: CONSISTENCY_MAX_DAY_SHARE
          },
          peakEquity: Number(acct.peakEquity || 0),
          trailingFloor: Number(acct.trailingFloor || 0),
          dayDD: Number(acct.dayDD || 0),
          totalDD: Number(acct.totalDD || 0)
        });
        // Model A: reset to starting balance upon passing
        resetToStartingBalanceOnPass(acct);
        resetPayoutPeriodIfNeeded(acct);
      }else{
        // not failed, but not passed yet; show constraint in status
        acct.passBlockedReason = `Consistency rule: best day ${money(maxDayProfit)} is ${(share*100).toFixed(1)}% of total profit (max ${(CONSISTENCY_MAX_DAY_SHARE*100).toFixed(0)}%)`;
      }
    }
  }else{
    acct.passBlockedReason = null;
  }

  // Funded: reset payout period weekly
  if(acct.challengePhase === "funded"){
    resetPayoutPeriodIfNeeded(acct);
  }
if(!acct.challengeFailed && (dayDD >= CHALLENGE_DAILY_DD || totalDD >= getStepConfig(acct).totalDdLimit)){
    acct.challengeFailed = true;
    acct.failedAt = new Date().toISOString();
    acct.failReason = dayDD >= CHALLENGE_DAILY_DD
      ? `Daily drawdown exceeded: ${(dayDD*100).toFixed(2)}% (max ${(CHALLENGE_DAILY_DD*100).toFixed(0)}%)`
      : `Trailing drawdown exceeded: ${(totalDD*100).toFixed(2)}% (max ${(CHALLENGE_TOTAL_DD*100).toFixed(0)}%)`;
  }

  acct.lastEquityAtCheck = eqNow;
  pushEquityPoint(acct, eqNow);
  acct.equity = eqNow;      // convenience
  acct.dayDD = dayDD;       // convenience
  acct.totalDD = totalDD;
  
  // Auto-flatten + lockout on rule breach
  if(!acct.challengeFailed && !acct.dailyLocked && dayDD >= CHALLENGE_DAILY_DD){
    acct.dailyLocked = true;
    acct.lockedUntil = nextUtcMidnightIso();
    acct.lockReason = "Daily drawdown breached";
    await autoFlattenAllPositions(email, acct, "Daily DD breach — auto-flatten");
  }

  if(!acct.challengeFailed && totalDD >= getStepConfig(acct).totalDdLimit){
    acct.challengeFailed = true;
    acct.failedAt = new Date().toISOString();
    acct.failReason = "Trailing drawdown breached";
    acct.frozen = true;
    await autoFlattenAllPositions(email, acct, "Trailing DD breach — liquidation");
  }

  // Step pass evaluation
  if(!acct.challengeFailed && acct.challengePhase !== "funded"){
    const cfg = getStepConfig(acct);
    const startEq = Number(acct.stepStartEquity || acct.startEquity || 0);
    let ret = startEq > 0 ? ((Number(acct.equity||0) - startEq) / startEq) : 0;
    const elapsed = daysSince(acct.stepStartDate);
    const maxDays = acct.stepMaxDaysOverride || cfg.maxDays;
    const daysLeft = Math.max(0, maxDays - elapsed);

    // if time expired without pass -> fail
    if(daysLeft === 0 && ret < cfg.targetPct){
      acct.challengeFailed = true;
      acct.failedAt = new Date().toISOString();
      acct.failReason = `${cfg.label} time limit exceeded`;
      acct.frozen = true;
      archiveChallengeStep(acct, { step: cfg.step, status:"failed", returnPct: ret, reason: acct.failReason });
      await autoFlattenAllPositions(email, acct, `${cfg.label} expired — liquidation`);
    }

    // pass step
    if(!acct.challengeFailed && ret >= cfg.targetPct){
      // Minimum trading days check
      const minDays = cfg.step === 1 ? MIN_TRADING_DAYS_STEP1 : MIN_TRADING_DAYS_STEP2;
      const tradedDays = Array.isArray(acct.tradingDays) ? acct.tradingDays.length : Object.keys(acct.tradingDays||{}).length;
      if(tradedDays < minDays) ret = -1; // block pass

      // Consistency rule check
      const totalProfit = Number(acct.equity||0) - Number(acct.stepStartEquity||0);
      const maxAllowedSingleDay = totalProfit * MAX_SINGLE_DAY_PROFIT_SHARE;
      const maxSingle = Math.max(...Object.values(acct.profitableDays||{}), 0);
      if(maxSingle > maxAllowedSingleDay) ret = -1; // block pass

      if(ret >= cfg.targetPct){
        archiveChallengeStep(acct, { step: cfg.step, status:"passed", returnPct: ret, reason: null });
        if(cfg.step === 1){
          acct.challengeStep = 2;
          acct.stepStartDate = utcDateKey();
          acct.stepStartEquity = Number(acct.startEquity || 0);
          resetTradingStateToStart(acct);
        }else{
          acct.challengePhase = "funded";
          acct.challengeStep = 0;
          acct.stepStartDate = null;
          acct.stepStartEquity = null;
          resetTradingStateToStart(acct);
          resetPayoutPeriodIfNeeded(acct);
        }
      }
    }
  }
   // convenience
}

async function guardChallenge(req, res, next){
  try{
    const email = currentEmail(req);
    const acct = await getOrCreateAccount(email);
    acct.pendingOrders = acct.pendingOrders || [];
    await refreshChallengeState(acct, email);
    await saveAccount(email, acct);
    if(acct.frozen){ return res.status(403).json({ error: "Account frozen" }); }
    if(acct.lockedUntil){
      const t = new Date(acct.lockedUntil).getTime();
      if(Number.isFinite(t) && Date.now() < t){
        return res.status(403).json({ error: `Trading locked until ${acct.lockedUntil}` });
      }
    }
    if(acct.challengeFailed){
      return res.status(403).json({ error: "Challenge failed", reason: acct.failReason });
    }
    next();
  }catch(err){
    return res.status(500).json({ error: "Challenge check failed", detail: err.message });
  }
}


function positionNotional(acct, product, price){
  const pos = acct.positions?.[product];
  const qty = Number(pos?.qty || 0);
  if(!Number.isFinite(qty) || qty <= 0) return 0;
  return qty * price;
}

function openBuyNotional(acct, product){
  const opens = Array.isArray(acct.openOrders) ? acct.openOrders : [];
  return opens
    .filter(o => o && o.type === "limit" && o.side === "buy" && o.product === product)
    .reduce((sum, o) => sum + (Number(o.qty) * Number(o.limitPrice)), 0);
}

function maxTradeNotional(acct){
  const base = Number(acct.baseEquity || 0);
  const cash = Number(acct.cash || 0);
  const ref = base > 0 ? base : cash; // fallback
  return Math.max(0, ref * MAX_TRADE_PCT);
}

function applyProfitSplitOnSell(acct, product, qty, sellPrice){
  // Spot-only: realized P&L when selling against avg cost.
  const pos = acct.positions?.[product];
  if(!pos) return 0;

  const realized = qty * (sellPrice - (pos.avg || 0));
  if(realized > 0){
    const firmCut = realized * PROFIT_SPLIT_FIRM;
    // Reduce trader proceeds by firm cut; track firm profit.
    acct.cash = (acct.cash || 0) - firmCut;
    acct.firmProfit = (acct.firmProfit || 0) + firmCut;
    return firmCut;
  }
  return 0;
}


// ---- Simulated fill delay (random 10–15 seconds) ----
function randomFillDelayMs(){
  return 10000 + Math.floor(Math.random() * 5000);
}

function isDue(o){
  return o && typeof o.executeAt === "number" && o.executeAt <= Date.now();
}

async function processPendingOrders(){
  try{
    const db = await readData();
    const accounts = db.accounts || {};
    for(const email of Object.keys(accounts)){
      const acct = accounts[email];
      if(!acct || !Array.isArray(acct.pendingOrders) || acct.pendingOrders.length === 0) continue;

      const remaining = [];
      const due = [];
      for(const o of acct.pendingOrders){
        if(isDue(o)) due.push(o);
        else remaining.push(o);
      }
      if(due.length === 0) continue;

      // Execute due orders sequentially
      for(const o of due){
        try{
          await executePendingOrder(acct, o);
        }catch{
          // best-effort refund on failure
          if(o.side === "buy" && o.reservedCash){
            acct.cash = (acct.cash || 0) + Number(o.reservedCash || 0);
          }
          if(o.side === "sell" && o.reservedQty && o.product){
            const pos = acct.positions?.[o.product] || { qty: 0, avg: o.avg || 0 };
            pos.qty = round8((pos.qty || 0) + Number(o.reservedQty || 0));
            acct.positions[o.product] = pos;
          }
        }
      }

      acct.pendingOrders = remaining;
      accounts[email] = acct;
    }
    db.accounts = accounts;
    await writeData(db);
  }catch{
    // ignore
  }
}

setInterval(processPendingOrders, 500);

async function executePendingOrder(acct, o){
  const p = o.product;
  const side = o.side;
  const q = Number(o.qty);
  if(!p || !side || !Number.isFinite(q) || q <= 0) return;

  const mid = await fetchCoinbaseTicker(p);
  const grossNotional = q * mid;
  const { spreadBps, slipBps } = execParams(p, grossNotional);
  const price = applyExecPrice(side, mid, spreadBps, slipBps);
  const execCostBps = (spreadBps/2) + slipBps;
  const notional = q * price;
  acct.tradingDays = uniqPush(acct.tradingDays || [], isoDay());


  const feeRate = o.feeRate != null ? Number(o.feeRate) : TAKER_FEE;
  const fee = notional * feeRate;

  acct.positions = acct.positions || {};
  acct.orders = acct.orders || [];
  acct.openOrders = acct.openOrders || [];
  acct.pendingOrders = acct.pendingOrders || [];

  if(side === "buy"){
    // reservedCash was removed from cash on placement
    const reserved = Number(o.reservedCash || 0);
    const actual = notional + fee;
    // If actual > reserved, reject and refund reserved
    if(reserved > 0 && actual > reserved){
      acct.cash = (acct.cash || 0) + reserved;
      acct.orders.unshift({ id: o.id, time: new Date().toISOString(), product: p, side, type: (o.type||"market"), status: "rejected", reason: "Reserved cash insufficient", qty: round8(q), price, notional, fee });
      return;
    }
    const pos = acct.positions[p] || { qty: 0, avg: 0 };
    const newQty = (pos.qty || 0) + q;
    const newAvg = newQty === 0 ? 0 : (((pos.qty || 0) * (pos.avg || 0)) + (q * price)) / newQty;
    pos.qty = round8(newQty);
    pos.avg = newAvg;
    acct.positions[p] = pos;

    // refund any excess
    if(reserved > 0){
      const refund = reserved - actual;
      if(refund > 0) acct.cash = (acct.cash || 0) + refund;
    }

    acct.orders.unshift({ id: o.id, time: new Date().toISOString(), product:p, side, type:o.type||"market", qty: round8(q), price, notional, fee, feeRate });
    return;
  }

  // sell
  acct.cash = (acct.cash || 0) + (notional - fee);
  // Profit split on realized gains
  const avg = Number(o.avg || 0);
  const realized = q * (price - avg);
  acct.realizedPnL = Number(acct.realizedPnL || 0) + realized;
  if(realized > 0){
    const firmCut = realized * PROFIT_SPLIT_FIRM;
    acct.cash = (acct.cash || 0) - firmCut;
    acct.firmProfit = (acct.firmProfit || 0) + firmCut;
  }

  acct.orders.unshift({ id: o.id, time: new Date().toISOString(), product:p, side, type:o.type||"market", qty: round8(q), price, notional, fee, feeRate });
}

function round8(n){
  return Math.round(Number(n) * 1e8) / 1e8;
}

// ---- Coinbase market data proxy (public) ----
// Uses Coinbase Exchange REST market-data endpoints (public).
// Docs: GET https://api.exchange.coinbase.com/products/{product_id}/ticker
app.get("/api/market/ticker", async (req, res) => {
  const product = String(req.query.product || "").trim();
  if(!product) return res.status(400).json({ error: "Missing product query param." });

  // Dynamic allowlist: top50 universe (fallback handled by /api/market/top50)
  await refreshTop50Universe(false).catch(()=>{});
  if(!allowlistProduct(product)){
    return res.status(400).json({ error: "Unsupported product. Use a Coinbase USD pair from /api/market/top50." });
  }

  try{
    const url = `https://api.exchange.coinbase.com/products/${encodeURIComponent(product)}/ticker`;
    const r = await fetch(url, {
      headers: {
        "User-Agent": "CryptoProp-Demo/1.0",
        "Accept": "application/json"
      }
    });
    if(!r.ok){
      const txt = await r.text().catch(()=> "");
      return res.status(502).json({ error: "Coinbase market data error.", detail: txt.slice(0, 200) });
    }
    const data = await r.json();
    return res.json(data);
  }catch(err){
    return res.status(502).json({ error: "Failed to fetch market data." });
  }
});


// Candles endpoint (public, proxied)
// Coinbase Exchange: GET /products/{product_id}/candles?granularity=...
app.get("/api/market/candles", async (req, res) => {
  const product = String(req.query.product || "").trim();
  const granularity = String(req.query.granularity || "3600").trim();
  const limit = Math.min(300, Math.max(10, Number(req.query.limit || 100)));

    await refreshTop50Universe(false).catch(()=>{});
  if(!product || !allowlistProduct(product)){
    return res.status(400).json({ error: "Unsupported product. Use a Coinbase USD pair from /api/market/top50." });
  }

  try{
    const url = `https://api.exchange.coinbase.com/products/${encodeURIComponent(product)}/candles?granularity=${encodeURIComponent(granularity)}`;
    const r = await fetch(url, {
      headers: { "User-Agent": "CryptoProp-Demo/1.0", "Accept": "application/json" }
    });
    if(!r.ok){
      const txt = await r.text().catch(()=> "");
      return res.status(502).json({ error: "Coinbase candles error.", detail: txt.slice(0, 200) });
    }
    const data = await r.json();
    return res.json(Array.isArray(data) ? data.slice(0, limit) : []);
  }catch{
    return res.status(502).json({ error: "Failed to fetch candles." });
  }
});


// ---- Ticker cache + batch endpoint (REST fallback for UIs) ----
const TICKER_CACHE_MS = 2000;
const tickerCache = new Map(); // product -> { ts, data }

async function fetchCoinbaseTickerFull(product){
  const url = `https://api.exchange.coinbase.com/products/${encodeURIComponent(product)}/ticker`;
  const r = await fetch(url, { headers: { "User-Agent": "CryptoProp-Demo/1.0", "Accept": "application/json" }});
  if(!r.ok){
    const txt = await r.text().catch(()=> "");
    throw new Error(`Coinbase ticker error: ${txt.slice(0,120)}`);
  }
  const data = await r.json();
  return {
    price: Number(data.price),
    open_24h: Number(data.open_24h),
    volume_24h: Number(data.volume),
    time: data.time || new Date().toISOString()
  };
}

// Fetch multiple tickers in one call (for dashboard fallback polling)
app.get("/api/market/tickers", async (req, res) => {
  const raw = String(req.query.products || "").trim();
  const list = raw ? raw.split(",").map(s=>s.trim()).filter(Boolean) : [];
  const products = list.slice(0, 50);

  await refreshTop50Universe(false).catch(()=>{});

  const out = {};
  await Promise.all(products.map(async (p) => {
    if(!allowlistProduct(p)) return;
    const now = Date.now();
    const cached = tickerCache.get(p);
    if(cached && (now - cached.ts) < TICKER_CACHE_MS){
      out[p] = cached.data;
      return;
    }
    try{
      const data = await fetchCoinbaseTickerFull(p);
      if(Number.isFinite(data.price)){
        tickerCache.set(p, { ts: now, data });
        out[p] = data;
      }
    }catch{
      // ignore individual failures
    }
  }));

  return res.json({ tickers: out, ts: Date.now() });
});

// ---- Static site ----
app.use(express.static(__dirname));

app.get("*", async (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});


// ------------------- Admin API (demo) -------------------
app.get("/api/admin/overview", requireAdmin, async (req, res) => {
  const db = await readData();
  const accounts = db.accounts || {};
  const list = Object.keys(accounts).map(email => {
    const a = accounts[email];
    return {
      email,
      phase: a.challengePhase || "challenge",
      failed: !!a.challengeFailed,
      frozen: !!a.frozen,
      equity: Number(a.equity || a.cash || 0),
      startEquity: Number(a.startEquity || 0),
      dayDD: Number(a.dayDD || 0),
      totalDD: Number(a.totalDD || 0),
      withdrawable: withdrawableAmount(a),
      pendingPayouts: (Array.isArray(a.payoutRequests)?a.payoutRequests:[]).filter(r=>r.status==="pending").length,
      deviceCount: (Array.isArray(a.devices)?a.devices:[]).length,
      ipCount: (Array.isArray(a.ips)?a.ips:[]).length
    };
  });
  return res.json({ ok:true, accounts:list });
}); // close /api/admin/overview

app.get("/api/admin/payout/pending", requireAdmin, async (req, res) => {
  const db = await readData();
  const accounts = db.accounts || {};
  const pending = [];
  for(const email of Object.keys(accounts)){
    const a = accounts[email];
    const reqs = Array.isArray(a.payoutRequests) ? a.payoutRequests : [];
    for(const r of reqs){
      if(r.status === "pending"){
        pending.push({ email, id: r.id, time: r.time, amount: Number(r.amount||0), period: r.period || null });
      }
    }
  }
  // newest first
  pending.sort((x,y)=> (new Date(y.time).getTime() - new Date(x.time).getTime()));
  return res.json({ ok:true, pending });
});

app.get("/api/admin/risk/flags", requireAdmin, async (req, res) => {
  const db = await readData();
  const accounts = db.accounts || {};
  const deviceMap = new Map(); // device -> [emails]
  const ipMap = new Map();     // ip -> [emails]
  for(const email of Object.keys(accounts)){
    const a = accounts[email];
    (Array.isArray(a.devices)?a.devices:[]).forEach(d => {
      if(!d) return;
      const arr = deviceMap.get(d) || [];
      if(!arr.includes(email)) arr.push(email);
      deviceMap.set(d, arr);
    });
    (Array.isArray(a.ips)?a.ips:[]).forEach(ip => {
      if(!ip) return;
      const arr = ipMap.get(ip) || [];
      if(!arr.includes(email)) arr.push(email);
      ipMap.set(ip, arr);
    });
  }
  const deviceFlags = [];
  for(const [device, emails] of deviceMap.entries()){
    if(emails.length >= 2) deviceFlags.push({ device, emails });
  }
  const ipFlags = [];
  for(const [ip, emails] of ipMap.entries()){
    if(emails.length >= 3) ipFlags.push({ ip, emails });
  }
  return res.json({ ok:true, deviceFlags, ipFlags });
});

app.post("/api/admin/account/freeze", requireAdmin, async (req, res) => {
  const { email, frozen } = req.body || {};
  const db = await readData();
  db.accounts = db.accounts || {};
  if(!db.accounts[email]) return res.status(404).json({ error:"Not found" });
  db.accounts[email].frozen = !!frozen;
  await writeData(db);
  await auditLog(req, frozen ? "freeze" : "unfreeze", email, {});
  return res.json({ ok:true });
});

app.post("/api/admin/account/fail", requireAdmin, async (req, res) => {
  const { email, reason } = req.body || {};
  const db = await readData();
  db.accounts = db.accounts || {};
  const a = db.accounts[email];
  if(!a) return res.status(404).json({ error:"Not found" });
  a.challengeFailed = true;
  a.failedAt = new Date().toISOString();
  a.failReason = reason || "Failed by admin";
  db.accounts[email] = a;
  await writeData(db);
  await auditLog(req, "fail", email, { reason: a.failReason });
  return res.json({ ok:true });
});

app.post("/api/admin/payout/approve", requireAdmin, async (req, res) => {
  const { email, id } = req.body || {};
  const db = await readData();
  db.accounts = db.accounts || {};
  const a = db.accounts[email];
  if(!a) return res.status(404).json({ error:"Not found" });

  a.payoutRequests = Array.isArray(a.payoutRequests) ? a.payoutRequests : [];
  const pr = a.payoutRequests.find(x => x.id === id);
  if(!pr) return res.status(404).json({ error:"Request not found" });
  if(pr.status !== "pending") return res.status(400).json({ error:"Not pending" });

  resetPayoutPeriodIfNeeded(a);
  const amount = Number(pr.amount||0);
  pr.status = "approved";
  a.payoutsPaidTotal = Number(a.payoutsPaidTotal||0) + amount;
  a.payoutsPaidThisPeriod = Number(a.payoutsPaidThisPeriod||0) + amount;
  a.payouts = Array.isArray(a.payouts) ? a.payouts : [];
  a.payouts.unshift({ id: pr.id, time: new Date().toISOString(), amount, period: pr.period, status:"paid" });
  pr.approvedAt = new Date().toISOString();
  db.accounts[email] = a;
  await writeData(db);
  await auditLog(req, "approve_payout", email, { id });
  return res.json({ ok:true });
});

app.get("/api/admin/kyc/pending", requireAdmin, async (req, res) => {
  const db = await readData();
  const accounts = db.accounts || {};
  const pending = [];
  for(const email of Object.keys(accounts)){
    const a = accounts[email];
    if(a.kycStatus === "pending"){
      pending.push({ email, submittedAt: a.kycSubmittedAt, profile: a.kycProfile || null });
    }
  }
  pending.sort((x,y)=> new Date(y.submittedAt||0).getTime() - new Date(x.submittedAt||0).getTime());
  return res.json({ ok:true, pending });
});

app.post("/api/admin/kyc/set-status", requireAdmin, async (req, res) => {
  const { email, status } = req.body || {};
  const db = await readData();
  db.accounts = db.accounts || {};
  const a = db.accounts[email];
  if(!a) return res.status(404).json({ error:"Not found" });
  if(!["approved","rejected","pending"].includes(status)) return res.status(400).json({ error:"Invalid status" });
  a.kycStatus = status;
  db.accounts[email] = a;
  await writeData(db);
  await auditLog(req, "kyc_set_status", email, { status });
  return res.json({ ok:true });
});

app.get("/api/admin/risk/similarity", requireAdmin, async (req, res) => {
  const db = await readData();
  const accounts = db.accounts || {};
  const emails = Object.keys(accounts);
  const sigs = {};
  for(const e of emails){
    sigs[e] = tradeSignatureSet(accounts[e], 200);
  }
  const pairs = [];
  for(let i=0;i<emails.length;i++){
    for(let j=i+1;j<emails.length;j++){
      const a = emails[i], b = emails[j];
      const s = jaccard(sigs[a], sigs[b]);
      if(s >= 0.6){
        pairs.push({ a, b, score: s, aTrades: sigs[a].size, bTrades: sigs[b].size });
      }
    }
  }
  pairs.sort((x,y)=> y.score - x.score);
  return res.json({ ok:true, pairs });
});



// ---- ONE_TIME_RETRY_OFFER_V1 ----
function resetChallengeAttempt(acct){
  // reset to a fresh Step 1 attempt
  acct.challengePhase = "challenge";
  acct.challengeFailed = false;
  acct.failReason = null;
  acct.failedAt = null;
  acct.frozen = false;

  acct.challengeStep = 1;
  acct.stepStartDate = utcDateKey();
  acct.stepStartEquity = Number(acct.startEquity || 0);

  // clear lockouts
  acct.dailyLocked = false;
  acct.lockedUntil = null;
  acct.lockReason = null;

  // clear trading state, but keep startEquity already set by plan
  resetTradingStateToStart(acct);
  ensureStepFields(acct);
}

function planPrice(planId){
  const plan = PLANS[planId];
  return plan ? Number(plan.price || 0) : 0;
}



// ---- CLICKWRAP_TERMS_V1 ----
const TERMS_EFFECTIVE_DATE = "2026-02-25";
const TERMS_VERSION = "2026-02-25-e24c9e37f4c48042";
function clientIp(req){
  return (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").toString().split(",")[0].trim();
}
async function requireTermsAccepted(req, res, next){
  const acct = await getOrCreateAccount(currentEmail(req));
  if(acct.termsAccepted && acct.termsVersion === TERMS_VERSION) return next();
  return res.status(403).json({ error:"Terms not accepted", termsVersion: TERMS_VERSION });
}

// ------------------- Authentication -------------------
app.get("/api/auth/me", async (req, res) => {
  const u = getSessionUser(req);
  if(!u) return res.json({ ok:true, user:null });
  return res.json({ ok:true, user:{ email:u.email, isAdmin:!!u.isAdmin } });
});

app.post("/api/auth/signup", async (req, res) => {
  const email = sanitizeEmail(req.body?.email);
  const password = (req.body?.password || "").toString();
  if(!email || !password || password.length < 8) return res.status(400).json({ error:"Email and password (min 8 chars) required" });
  const existing = await getUser(email);
  if(existing) return res.status(400).json({ error:"Account already exists" });
  const hash = await bcrypt.hash(password, 12);
  const verifyCode = Math.random().toString(36).slice(2, 8).toUpperCase();
  await saveUser(email, { email, passwordHash: hash, createdAt: new Date().toISOString(), emailVerified: false, verifyCode, isAdmin: false });
  // In production: send verifyCode via email.
  console.log("[CryptoProp] Verify code for", email, "=>", verifyCode);
  await sendEmail({
    to: email,
    subject: "Your CryptoProp verification code",
    html: `<p>Hi,</p><p>Your CryptoProp email verification code is:</p><h2 style="letter-spacing:4px">${verifyCode}</h2><p>Enter this code on the verification page to activate your account.</p><p>If you didn't create an account, you can ignore this email.</p>`
  });
  return res.json({ ok:true, message: "Account created. Check your email for a verification code." });
});

app.post("/api/auth/verify-email", async (req, res) => {
  const email = sanitizeEmail(req.body?.email);
  const code = (req.body?.code || "").toString().trim().toUpperCase();
  const u = await getUser(email);
  if(!u) return res.status(404).json({ error:"Not found" });
  if(u.emailVerified) return res.json({ ok:true, verified:true });
  if(!code || code !== u.verifyCode) return res.status(400).json({ error:"Invalid code" });
  u.emailVerified = true;
  u.verifyCode = null;
  await saveUser(email, u);
  return res.json({ ok:true, verified:true });
});

app.post("/api/auth/login", async (req, res) => {
  const email = sanitizeEmail(req.body?.email);
  const password = (req.body?.password || "").toString();
  const u = await getUser(email);
  if(!u) return res.status(400).json({ error:"Invalid credentials" });
  const ok = await bcrypt.compare(password, u.passwordHash);
  if(!ok) return res.status(400).json({ error:"Invalid credentials" });
  if(!u.emailVerified) return res.status(403).json({ error:"Email not verified" });
  req.session.user = { email: u.email, isAdmin: !!u.isAdmin };
  return res.json({ ok:true });
});

app.post("/api/auth/logout", async (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("cp.sid");
    return res.json({ ok:true });
  });
});

// ---- Forgot / Reset Password ----
app.post("/api/auth/forgot-password", async (req, res) => {
  const email = sanitizeEmail(req.body?.email);
  if(!email) return res.status(400).json({ error:"Email required" });
  const u = await getUser(email);
  // Always return ok to avoid user enumeration
  if(!u) return res.json({ ok:true });
  const token = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  u.resetToken = token;
  u.resetTokenExpiry = Date.now() + 60 * 60 * 1000; // 1 hour
  await saveUser(email, u);
  const baseUrl = process.env.BASE_URL || "https://thecryptoprop.com";
  const resetLink = `${baseUrl}/reset-password.html?token=${token}&email=${encodeURIComponent(email)}`;
  console.log("[CryptoProp] Password reset link for", email, "=>", resetLink);
  await sendEmail({
    to: email,
    subject: "Reset your CryptoProp password",
    html: `<p>Hi,</p><p>We received a request to reset your CryptoProp password.</p><p><a href="${resetLink}" style="background:#7c5cff;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;display:inline-block;">Reset Password</a></p><p>This link expires in 1 hour.</p><p>If you didn't request this, you can safely ignore this email.</p>`
  });
  return res.json({ ok:true });
});

app.post("/api/auth/reset-password", async (req, res) => {
  const email = sanitizeEmail(req.body?.email);
  const token = (req.body?.token || "").toString().trim();
  const password = (req.body?.password || "").toString();
  if(!email || !token || !password || password.length < 8)
    return res.status(400).json({ error:"Email, token, and new password (min 8 chars) required" });
  const u = await getUser(email);
  if(!u || u.resetToken !== token) return res.status(400).json({ error:"Invalid or expired reset link" });
  if(!u.resetTokenExpiry || Date.now() > u.resetTokenExpiry) return res.status(400).json({ error:"Reset link has expired" });
  u.passwordHash = await bcrypt.hash(password, 12);
  u.resetToken = null;
  u.resetTokenExpiry = null;
  await saveUser(email, u);
  return res.json({ ok:true });
});

app.post("/api/auth/admin-elevate", async (req, res) => {
  const key = (req.body?.adminKey || "").toString();
  if(!ADMIN_KEY || key !== ADMIN_KEY) return res.status(403).json({ error:"Invalid admin key" });
  const u = getSessionUser(req);
  if(!u) return res.status(401).json({ error:"Not authenticated" });
  req.session.user.isAdmin = true;
  const adminUser = await getUser(u.email);
  if(adminUser){
    adminUser.isAdmin = true;
    await saveUser(u.email, adminUser);
  }
  return res.json({ ok:true, isAdmin:true });
});


// ------------------- Clickwrap Terms Acceptance -------------------
app.get("/api/terms/status", requireAuth, async (req, res) => {
  const acct = await getOrCreateAccount(currentEmail(req));
  return res.json({ ok:true, accepted: !!acct.termsAccepted && acct.termsVersion === TERMS_VERSION, termsVersion: TERMS_VERSION, acceptedAt: acct.termsAcceptedAt || null });
});

app.post("/api/terms/accept", requireAuth, async (req, res) => {
  if(!req.body?.accept) return res.status(400).json({ error:"Must accept" });
  const acct = await getOrCreateAccount(currentEmail(req));
  acct.termsAccepted = true;
  acct.termsAcceptedAt = new Date().toISOString();
  acct.termsVersion = TERMS_VERSION;
  acct.termsIp = clientIp(req);
  acct.termsUserAgent = (req.headers["user-agent"] || "").toString().slice(0, 240);
  await saveAccount(currentEmail(req), acct);
  return res.json({ ok:true, termsVersion: TERMS_VERSION });
});

// ------------------- Plan Selection (demo) -------------------
// In production, this should be driven by Stripe webhooks.
const PLANS = {
  "25k": { startEquity: 25000, price: 149 },
  "50k": { startEquity: 50000, price: 279 },
  "100k": { startEquity: 100000, price: 499 }
};



// ---- BETA / IMPERSONATION MODE ----
const BETA_EMAIL = "__beta__@cryptoprop.internal";

async function ensureBetaAccount() {
  let acct = await getAccount(BETA_EMAIL);
  if (!acct) {
    acct = {
      cash: 100000, baseEquity: 100000, firmProfit: 0,
      startEquity: 100000, equity: 100000,
      positions: {}, orders: [], openOrders: [], pendingOrders: [],
      challengePhase: "funded",
      challengeStartAt: new Date(Date.now() - 5*86400000).toISOString(),
      challengePassedAt: new Date(Date.now() - 2*86400000).toISOString(),
      fundedActivatedAt: new Date(Date.now() - 2*86400000).toISOString(),
      payoutEligibleAt: new Date().toISOString(),
      payoutsPaidTotal: 0, payoutsPaidThisPeriod: 0, payoutPeriodStart: null,
      realizedPnL: 2500, tradingDays: ["day1","day2","day3","day4","day5"],
      dailyProfitHistory: {}, lastEquityAtCheck: null,
      challengeHistory: [], extensionsUsed: {}, stepMaxDaysOverride: null,
      attemptsByPlan: { "100k": 1 }, retryOfferUsed: {},
      planId: "100k",
      lastPurchase: { time: new Date().toISOString(), planId: "100k", amount: 0, type: "beta" },
      equityHistory: [], devices: [], ips: [],
      emailVerified: true, phoneVerified: true,
      kycStatus: "approved", kycSubmittedAt: new Date().toISOString(), kycProfile: null,
      termsAccepted: true, termsAcceptedAt: new Date().toISOString(),
      termsVersion: "1.0", termsIp: "127.0.0.1", termsUserAgent: "beta",
      referredBy: null, referralAppliedAt: null, firstPurchaseCredited: false,
      isBeta: true
    };
    await saveAccount(BETA_EMAIL, acct);
  }
  // Ensure beta user exists
  let user = await getUser(BETA_EMAIL);
  if (!user) {
    const hash = await bcrypt.hash("beta-test-account", 10);
    await saveUser(BETA_EMAIL, { email: BETA_EMAIL, passwordHash: hash, createdAt: new Date().toISOString(), emailVerified: true, isAdmin: false, isBeta: true });
  }
  return acct;
}

// Admin: enter beta mode
app.post("/api/admin/beta/enter", requireAdmin, async (req, res) => {
  await ensureBetaAccount();
  req.session.user.betaMode = true;
  return res.json({ ok: true, message: "Beta mode active — you are now trading as the beta account" });
});

// Admin: exit beta mode
app.post("/api/admin/beta/exit", requireAdmin, async (req, res) => {
  req.session.user.betaMode = false;
  return res.json({ ok: true, message: "Beta mode exited" });
});

// Admin: reset beta account to fresh funded state
app.post("/api/admin/beta/reset", requireAdmin, async (req, res) => {
  await getAccount(BETA_EMAIL); // ensure exists
  const fresh = {
    cash: 100000, baseEquity: 100000, firmProfit: 0,
    startEquity: 100000, equity: 100000,
    positions: {}, orders: [], openOrders: [], pendingOrders: [],
    challengePhase: "funded",
    challengeStartAt: new Date(Date.now() - 5*86400000).toISOString(),
    challengePassedAt: new Date(Date.now() - 2*86400000).toISOString(),
    fundedActivatedAt: new Date(Date.now() - 2*86400000).toISOString(),
    payoutEligibleAt: new Date().toISOString(),
    payoutsPaidTotal: 0, payoutsPaidThisPeriod: 0, payoutPeriodStart: null,
    realizedPnL: 2500, tradingDays: ["day1","day2","day3","day4","day5"],
    dailyProfitHistory: {}, lastEquityAtCheck: null,
    challengeHistory: [], extensionsUsed: {}, stepMaxDaysOverride: null,
    attemptsByPlan: { "100k": 1 }, retryOfferUsed: {},
    planId: "100k",
    lastPurchase: { time: new Date().toISOString(), planId: "100k", amount: 0, type: "beta" },
    equityHistory: [], devices: [], ips: [],
    emailVerified: true, phoneVerified: true,
    kycStatus: "approved", kycSubmittedAt: new Date().toISOString(), kycProfile: null,
    termsAccepted: true, termsAcceptedAt: new Date().toISOString(),
    termsVersion: "1.0", termsIp: "127.0.0.1", termsUserAgent: "beta",
    referredBy: null, referralAppliedAt: null, firstPurchaseCredited: false,
    isBeta: true
  };
  await saveAccount(BETA_EMAIL, fresh);
  return res.json({ ok: true, message: "Beta account reset to funded state with $100K" });
});

// Admin: get beta mode status
app.get("/api/admin/beta/status", requireAdmin, async (req, res) => {
  const active = !!(req.session.user && req.session.user.betaMode);
  const acct = await getAccount(BETA_EMAIL);
  return res.json({ ok: true, active, account: acct });
});

// ---- PROMO CODES ----
// Admin creates codes via POST /api/admin/promo/create
// Format: { code, discountPct, maxUses, expiresAt }

async function getPromoCodes() {
  const res = await pool.query("SELECT value FROM kv WHERE key = 'promoCodes'");
  return res.rows.length ? res.rows[0].value : {};
}

async function savePromoCodes(codes) {
  await pool.query(`
    INSERT INTO kv (key, value) VALUES ('promoCodes', $1::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `, [JSON.stringify(codes)]);
}

app.post("/api/promo/validate", requireAuth, async (req, res) => {
  const code = (req.body?.code || "").toString().trim().toUpperCase();
  const planId = (req.body?.planId || "").toString();
  if(!code) return res.status(400).json({ error: "No code provided" });
  const plan = PLANS[planId];
  if(!plan) return res.status(400).json({ error: "Invalid plan" });

  const codes = await getPromoCodes();
  const promo = codes[code];
  if(!promo) return res.status(404).json({ error: "Invalid promo code" });
  if(promo.expiresAt && Date.now() > new Date(promo.expiresAt).getTime())
    return res.status(400).json({ error: "Promo code has expired" });
  if(promo.maxUses && (promo.uses || 0) >= promo.maxUses)
    return res.status(400).json({ error: "Promo code has reached its usage limit" });

  const discountAmt = Math.round(plan.price * (promo.discountPct / 100));
  const finalPrice = Math.max(0, plan.price - discountAmt);
  return res.json({ ok: true, code, discountPct: promo.discountPct, discountAmt, originalPrice: plan.price, finalPrice });
});

// Admin: create promo code
app.post("/api/admin/promo/create", requireAdmin, async (req, res) => {
  const code = (req.body?.code || "").toString().trim().toUpperCase();
  const discountPct = Number(req.body?.discountPct || 0);
  const maxUses = req.body?.maxUses ? Number(req.body.maxUses) : null;
  const expiresAt = req.body?.expiresAt || null;
  if(!code || discountPct <= 0 || discountPct > 100)
    return res.status(400).json({ error: "code and discountPct (1-100) required" });
  const codes = await getPromoCodes();
  codes[code] = { code, discountPct, maxUses, expiresAt, uses: 0, createdAt: new Date().toISOString() };
  await savePromoCodes(codes);
  return res.json({ ok: true, promo: codes[code] });
});

// Admin: list promo codes
app.get("/api/admin/promo/list", requireAdmin, async (req, res) => {
  const codes = await getPromoCodes();
  return res.json({ ok: true, codes: Object.values(codes) });
});

// Admin: delete promo code
app.post("/api/admin/promo/delete", requireAdmin, async (req, res) => {
  const code = (req.body?.code || "").toString().trim().toUpperCase();
  const codes = await getPromoCodes();
  delete codes[code];
  await savePromoCodes(codes);
  return res.json({ ok: true });
});

app.post("/api/plan/choose", requireAuth, requireTermsAccepted, async (req, res) => {
  const planId = (req.body?.planId || "").toString();
  const promoCode = (req.body?.promoCode || "").toString().trim().toUpperCase();
  const plan = PLANS[planId];
  if(!plan) return res.status(400).json({ error:"Invalid plan" });

  const email = currentEmail(req);
  const acct = await getOrCreateAccount(email);

  // Apply promo code if provided
  let paid = plan.price;
  let promoApplied = null;
  if(promoCode){
    const codes = await getPromoCodes();
    const promo = codes[promoCode];
    if(!promo) return res.status(400).json({ error: "Invalid promo code" });
    if(promo.expiresAt && Date.now() > new Date(promo.expiresAt).getTime())
      return res.status(400).json({ error: "Promo code has expired" });
    if(promo.maxUses && (promo.uses || 0) >= promo.maxUses)
      return res.status(400).json({ error: "Promo code has reached its usage limit" });
    const discountAmt = Math.round(plan.price * (promo.discountPct / 100));
    paid = Math.max(0, plan.price - discountAmt);
    promo.uses = (promo.uses || 0) + 1;
    codes[promoCode] = promo;
    await savePromoCodes(codes);
    promoApplied = { code: promoCode, discountPct: promo.discountPct, discountAmt, originalPrice: plan.price, finalPrice: paid };
  }

  acct.attemptsByPlan = acct.attemptsByPlan || {};
  acct.retryOfferUsed = acct.retryOfferUsed || {};
  const prevAttempts = Number(acct.attemptsByPlan[planId] || 0);
  acct.attemptsByPlan[planId] = prevAttempts + 1;

  acct.planId = planId;
  acct.lastPurchase = { time: new Date().toISOString(), planId, amount: paid, type: "initial", promo: promoApplied };
  acct.startEquity = plan.startEquity;
  acct.cash = Number(acct.cash || plan.startEquity);
  acct.equity = Number(acct.equity || plan.startEquity);

  if(acct.referredBy && !acct.firstPurchaseCredited){
    await recordReferralFirstPurchase(acct.referredBy, email, planId, plan.price);
    acct.firstPurchaseCredited = true;
  }

  resetChallengeAttempt(acct);
  await saveAccount(email, acct);
  return res.json({ ok:true, account: acct, promoApplied });
});

// ------------------- Admin Ops Console -------------------

app.get("/api/admin/account", requireAdmin, async (req, res) => {
  const email = (req.query.email || "").toString();
  const db = await readData();
  const a = (db.accounts||{})[email];
  if(!a) return res.status(404).json({ error:"Not found" });
  // attach derived payout fields
  a.payoutEligiblePnL = eligibleProfitForPayout(a);
  a.profitBuffer = profitBufferDollar(a);
  a.dailyPayoutCap = dailyProfitCapDollar(a);
  a.withdrawable = withdrawableAmount(a);
  a.payoutCap = payoutCap(a);
  a.payoutCapRemaining = payoutCapRemaining(a);
  return res.json({ ok:true, account: a });
});
app.get("/api/admin/audit", requireAdmin, async (req, res) => {
  const limit = Math.max(1, Math.min(500, Number(req.query.limit || 200)));
  const db = await readData();
  const audit = Array.isArray(db.audit) ? db.audit : [];
  return res.json({ ok:true, audit: audit.slice(0, limit) });
});

app.post("/api/admin/account/unlock-daily", requireAdmin, async (req, res) => {
  const { email } = req.body || {};
  const db = await readData();
  db.accounts = db.accounts || {};
  const a = db.accounts[email];
  if(!a) return res.status(404).json({ error:"Not found" });
  a.dailyLocked = false;
  a.lockedUntil = null;
  a.lockReason = null;
  // do not un-fail, only unlock daily lock; keep frozen if failed
  if(!a.challengeFailed) a.frozen = false;
  db.accounts[email] = a;
  await writeData(db);
  await auditLog(req, "unlock_daily", email, {});
  return res.json({ ok:true });
});

app.post("/api/admin/account/flatten", requireAdmin, async (req, res) => {
  const { email, reason } = req.body || {};
  const db = await readData();
  db.accounts = db.accounts || {};
  const a = db.accounts[email];
  if(!a) return res.status(404).json({ error:"Not found" });
  await autoFlattenAllPositions(email, a, reason || "Admin flatten");
  // reload to ensure saved snapshot
  const db2 = await readData();
  await auditLog(req, "flatten", email, { reason: reason || "Admin flatten" });
  return res.json({ ok:true, account: (db2.accounts||{})[email] });
});

function resetAccountToStart(a){
  const start = Number(a.startEquity || a.cash || 0);
  a.cash = start;
  a.equity = start;
  a.positions = {};
  a.avgCost = {};
  a.realizedPnL = 0;
  a.orders = [];
  a.liquidations = [];
  a.equityHistory = [];
  a.highWatermark = start;
  a.dayDate = null;
  a.dayStartEquity = start;
  a.dailyProfitHistory = {};
  a.challengeFailed = false;
  a.failReason = null;
  a.failedAt = null;
  a.frozen = false;
  a.dailyLocked = false;
  a.lockedUntil = null;
  a.lockReason = null;
  a.challengePhase = "challenge";
  // do not touch subscription/pricing; reset payouts for safety
  a.payouts = [];
  a.payoutRequests = [];
  a.payoutsPaidTotal = 0;
  a.payoutsPaidThisPeriod = 0;
  a.payoutPeriodStart = new Date().toISOString().slice(0,10);
  return a;
}

app.post("/api/admin/account/reset", requireAdmin, async (req, res) => {
  const { email } = req.body || {};
  const db = await readData();
  db.accounts = db.accounts || {};
  const a = db.accounts[email];
  if(!a) return res.status(404).json({ error:"Not found" });
  resetAccountToStart(a);
  db.accounts[email] = a;
  await writeData(db);
  await auditLog(req, "reset_account", email, {});
  return res.json({ ok:true });
});

app.post("/api/admin/account/set-phase", requireAdmin, async (req, res) => {
  const { email, phase } = req.body || {};
  const db = await readData();
  db.accounts = db.accounts || {};
  const a = db.accounts[email];
  if(!a) return res.status(404).json({ error:"Not found" });
  if(!["challenge","funded"].includes(phase)) return res.status(400).json({ error:"Invalid phase" });
  a.challengePhase = phase;
  if(phase === "funded"){
    a.challengeFailed = false;
    a.frozen = false;
    // reset payout period on funding
    resetPayoutPeriodIfNeeded(a);
  }
  db.accounts[email] = a;
  await writeData(db);
  await auditLog(req, "set_phase", email, { phase });
  return res.json({ ok:true });
});



// One-time retry offer: if you fail a challenge, you can repurchase the SAME plan once for $20 less.

// ---- ESCALATING_RETRY_V1 ----
function retryDiscount(planId, attempts){
  if(attempts === 0) return 20;
  if(attempts === 1) return 10;
  return 0;
}
app.post("/api/plan/retry-offer", requireAuth, requireTermsAccepted, async (req, res) => {
  const email = currentEmail(req);
  const acct = await getOrCreateAccount(email);
  const planId = acct.planId;
  if(!planId || !PLANS[planId]) return res.status(400).json({ error:"No active plan" });
  if(!acct.challengeFailed) return res.status(400).json({ error:"Retry offer available only after failing a challenge" });

  acct.retryOfferUsed = acct.retryOfferUsed || {};
  if(acct.retryOfferUsed[planId]) return res.status(400).json({ error:"Retry offer already used" });

  const original = planPrice(planId);
  const attempts = Number(acct.attemptsByPlan?.[planId] || 0);
  const discount = retryDiscount(planId, attempts);
  const discounted = Math.max(0, original - discount);

  // mark used and reset attempt
  acct.retryOfferUsed[planId] = true;
  acct.attemptsByPlan = acct.attemptsByPlan || {};
  acct.attemptsByPlan[planId] = Number(acct.attemptsByPlan[planId] || 0) + 1;
  acct.lastPurchase = { time: new Date().toISOString(), planId, amount: discounted, type: "retry_offer" };

  // keep same plan and equity
  acct.startEquity = PLANS[planId].startEquity;
  resetChallengeAttempt(acct);

  await saveAccount(email, acct);
  return res.json({ ok:true, account: acct, offer: { original, discounted, oneTime:true } });
});

// ------------------- Admin Referral Codes -------------------
app.get("/api/admin/referral/list", requireAdmin, async (req, res) => {
  const db = ensureReferrals(await readData());
  return res.json({ ok:true, referrals: db.referrals, uses: db.referralUses });
});

app.post("/api/admin/referral/create", requireAdmin, async (req, res) => {
  const db = ensureReferrals(await readData());
  let code = normalizeCode(req.body?.code || "");
  const maxUses = req.body?.maxUses != null ? Number(req.body.maxUses) : null;
  const commissionPct = req.body?.commissionPct != null ? Number(req.body.commissionPct) : DEFAULT_REFERRAL_COMMISSION_PCT;

  if(!code) code = genReferralCode(8);
  if(db.referrals.find(r => r.code === code)) return res.status(400).json({ error:"Code already exists" });

  const rec = {
    code,
    createdAt: new Date().toISOString(),
    createdBy: adminActor(req),
    commissionPct: Math.max(0, Math.min(0.5, commissionPct || DEFAULT_REFERRAL_COMMISSION_PCT)),
    maxUses: (maxUses && Number.isFinite(maxUses)) ? Math.max(1, Math.floor(maxUses)) : null,
    uses: 0,
    active: true,
    note: (req.body?.note || "").toString().slice(0, 140)
  };
  db.referrals.unshift(rec);
  await writeData(db);
  await auditLog(req, "referral_create", null, { code: rec.code, maxUses: rec.maxUses, commissionPct: rec.commissionPct });
  return res.json({ ok:true, referral: rec });
});

app.post("/api/admin/referral/set-active", requireAdmin, async (req, res) => {
  const code = normalizeCode(req.body?.code || "");
  const active = !!req.body?.active;
  const db = ensureReferrals(await readData());
  const r = db.referrals.find(x => x.code === code);
  if(!r) return res.status(404).json({ error:"Not found" });
  r.active = active;
  await writeData(db);
  await auditLog(req, "referral_set_active", null, { code, active });
  return res.json({ ok:true });
});


// Purchase challenge extension (+14 days)
app.post("/api/challenge/extend", requireAuth, requireTermsAccepted, async (req, res) => {
  const email = currentEmail(req);
  const acct = await getOrCreateAccount(email);

  if(acct.challengePhase !== "challenge" || acct.challengeFailed){
    return res.status(400).json({ error:"Extension only available during active challenge" });
  }

  const step = acct.challengeStep || 1;
  acct.extensionsUsed = acct.extensionsUsed || {};
  if(acct.extensionsUsed[step]){
    return res.status(400).json({ error:"Extension already used for this step" });
  }

  const cfgInitial = getStepConfig(acct);
  acct.extensionsUsed[step] = true;

  // override max days for this step
  acct.stepMaxDaysOverride = (cfgInitial.maxDays + EXTENSION_DAYS);

  const cfg = getStepConfig(acct);
  const elapsed = daysSince(acct.stepStartDate);
  const maxDays = acct.stepMaxDaysOverride || cfg.maxDays;
  const daysLeft = Math.max(0, maxDays - elapsed);
  const dynamicPrice = dynamicExtensionPrice(daysLeft);

  acct.lastPurchase = {
    time: new Date().toISOString(),
    type: "extension",
    step,
    amount: dynamicPrice
  };

  await saveAccount(email, acct);

  return res.json({
    ok:true,
    extension:{ days:EXTENSION_DAYS, fee:EXTENSION_FEE }
  });
});

// ---- INSTANT_RESET_V1 ----
// Allows reset mid-challenge for $79
app.post("/api/challenge/reset-now", requireAuth, requireTermsAccepted, async (req, res) => {
  const email = currentEmail(req);
  const acct = await getOrCreateAccount(email);

  if(acct.challengePhase !== "challenge" || acct.challengeFailed){
    return res.status(400).json({ error:"Reset only during active challenge" });
  }

  acct.lastPurchase = {
    time: new Date().toISOString(),
    type: "instant_reset",
    amount: 79
  };

  resetChallengeAttempt(acct);
  await saveAccount(email, acct);

  return res.json({ ok:true });
});
// ---- DATA PERSISTENCE ----
// readData() and await writeData() are now imported from db.js (PostgreSQL).
// Kept as async wrappers — callers that were synchronous now need await.
// See db.js for the implementation.

// ---- DEVICE / IP TRACKING ----
function noteDeviceAndIp(acct, req){
  const ip = clientIp(req);
  const ua = (req.headers["user-agent"] || "").toString().slice(0, 200);
  acct.ips = Array.isArray(acct.ips) ? acct.ips : [];
  acct.devices = Array.isArray(acct.devices) ? acct.devices : [];
  if(ip && !acct.ips.includes(ip)) acct.ips.push(ip);
  if(ua && !acct.devices.includes(ua)) acct.devices.push(ua);
  // cap to last 50
  acct.ips = acct.ips.slice(-50);
  acct.devices = acct.devices.slice(-50);
}

// ---- CODE GENERATOR ----
function genCode(len){
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for(let i=0;i<len;i++) out += chars[Math.floor(Math.random()*chars.length)];
  return out;
}

// ---- AUDIT LOG ----
async function auditLog(req, action, targetEmail, meta){
  try{
    const db = await readData();
    db.audit = Array.isArray(db.audit) ? db.audit : [];
    db.audit.unshift({
      time: new Date().toISOString(),
      actor: currentEmail(req) || "system",
      ip: clientIp(req),
      action,
      target: targetEmail || null,
      meta: meta || {}
    });
    db.audit = db.audit.slice(0, 2000);
    await writeData(db);
  }catch(err){
    console.error("[CryptoProp] auditLog error:", err.message);
  }
}

function adminActor(req){
  return currentEmail(req) || "admin";
}

// ---- MONEY FORMATTER ----
function money(n){
  return "$" + Number(n || 0).toFixed(2);
}

// ---- REFERRAL HELPERS ----
const DEFAULT_REFERRAL_COMMISSION_PCT = 0.10;

function ensureReferrals(db){
  db.referrals = Array.isArray(db.referrals) ? db.referrals : [];
  db.referralUses = Array.isArray(db.referralUses) ? db.referralUses : [];
  return db;
}

function normalizeCode(code){
  return (code || "").toString().trim().toUpperCase();
}

function findReferral(db, code){
  return (db.referrals || []).find(r => r.code === normalizeCode(code) && r.active !== false);
}

function genReferralCode(len){
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for(let i=0;i<len;i++) out += chars[Math.floor(Math.random()*chars.length)];
  return out;
}

// ---- PAYOUT VERIFICATION CHECK ----
function requireVerifiedForPayout(acct){
  return !!acct.emailVerified && acct.kycStatus === "approved";
}

// ---- TRADE SIMILARITY (anti-abuse) ----
function tradeSignatureSet(acct, maxTrades){
  const orders = Array.isArray(acct.orders) ? acct.orders : [];
  const sigs = new Set();
  for(const o of orders.slice(0, maxTrades)){
    if(!o || !o.product || !o.side) continue;
    // signature: product + side + rounded price bucket
    const bucket = Math.round(Number(o.price || 0) / 10) * 10;
    sigs.add(`${o.product}|${o.side}|${bucket}`);
  }
  return sigs;
}

function jaccard(a, b){
  if(!a || !b || a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for(const v of a){ if(b.has(v)) inter++; }
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

// ---- Startup: init DB then start server ----
initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`CryptoProp demo running on http://localhost:${PORT}`);
      console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
    });
  })
  .catch((err) => {
    console.error("[DB] Failed to initialise database:", err.message);
    process.exit(1);
  });

function cryptoRandomId(){
  // No extra deps: small random id
  return Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2);
}
