import { setYear, toast, qs, money, fmtDate } from "./app.js";
import { requireAuth, logout, getSession, apiFetch } from "./app.js";


function updatePayoutMini(account){
  const w = document.getElementById("miniWithdrawable");
  const e = document.getElementById("miniEligible");
  const c = document.getElementById("miniCap");
  const cl = document.getElementById("miniCapLine");
  if(!w) return;
  w.textContent = money(Number(account.withdrawable || 0));
  if(c) c.textContent = money(Number(account.payoutCapRemaining || 0));
  if(cl) cl.textContent = `Weekly cap: ${money(Number(account.payoutCap || 0))} • Buffer: ${money(Number(account.profitBuffer||0))} • Daily cap: ${money(Number(account.dailyPayoutCap||0))}`;
  const phase = account.challengePhase || "challenge";
  if(phase !== "funded") e.textContent = "Not funded yet";
  else{
    const eligibleAt = account.payoutEligibleAt || "—";
    e.textContent = `Eligible at: ${eligibleAt}`;
  }
}



function renderLockBanner(account){
  const b = document.getElementById("lockBanner");
  const t = document.getElementById("lockText");
  if(!b) return;
  const until = account.lockedUntil;
  if(until){
    const ms = new Date(until).getTime() - Date.now();
    if(ms > 0){
      b.style.display = "block";
      if(t) t.textContent = `${account.lockReason || "Rule breach"} • Locked until ${until}`;
      // disable common trading inputs/buttons if present
      ["qty","buyBtn","sellBtn","submitOrder","placeOrder"].forEach(id=>{
        const el = document.getElementById(id);
        if(el) el.disabled = true;
      });
      return;
    }
  }
  b.style.display = "none";
}



function clamp01(x){ return Math.max(0, Math.min(1, x)); }

function updateChallengeProgress(account){
  const start = Number(account.startEquity || 0);
  const eq = Number(account.equity || 0);
  const phaseEl = document.getElementById("phase");
  const timeLeftEl = document.getElementById("timeLeft");
  const profitLine = document.getElementById("profitLine");
  const profitBar = document.getElementById("profitBar");
  const daysLine = document.getElementById("daysLine");
  const consistencyLine = document.getElementById("consistencyLine");
  const payoutLine = document.getElementById("payoutLine");
  const payoutSub = document.getElementById("payoutSub");

  const phase = account.challengePhase || "challenge";
  if(phaseEl) phaseEl.textContent = phase.toUpperCase();

  // time left
  const startAt = account.challengeStartAt ? new Date(account.challengeStartAt).getTime() : Date.now();
  const elapsedDays = Math.floor((Date.now() - startAt) / 86400000);
  const left = Math.max(0, 30 - elapsedDays);
  if(timeLeftEl) timeLeftEl.textContent = phase === "challenge" ? `${left} days left • min 5 trading days` : `Funded since ${account.fundedActivatedAt || "—"}`;

  // profit progress
  const targetEq = start * 1.08;
  const prog = start > 0 ? clamp01((eq - start) / (targetEq - start)) : 0;
  if(profitLine){
    const pct = start > 0 ? ((eq - start)/start*100).toFixed(2) : "0.00";
    profitLine.textContent = `${money(eq)} • ${pct}% (target 8%)`;
  }
  if(profitBar) profitBar.style.width = (prog*100).toFixed(0) + "%";

  // days + consistency
  const td = Array.isArray(account.tradingDays) ? account.tradingDays.length : 0;
  if(daysLine) daysLine.textContent = `${td} / 5 trading days`;
  if(consistencyLine){
    const msg = account.passBlockedReason ? account.passBlockedReason : "Consistency OK (≤ 40% best-day share)";
    consistencyLine.textContent = msg;
  }

  // payout info
  if(payoutLine){
    if(phase !== "funded"){
      payoutLine.textContent = "Not funded yet";
      if(payoutSub) payoutSub.textContent = "";
    }else{
      const cap = start * 0.04;
      const paid = Number(account.payoutsPaidThisPeriod || 0);
      payoutLine.textContent = `Cap remaining: ${money(Math.max(0, cap - paid))}`;
      const eligible = account.payoutEligibleAt || "—";
      payoutSub.textContent = `Eligible at: ${eligible} • Period: ${account.payoutPeriodStart || "—"}`;
    }
  }

  // redirect on pass
  if(phase === "funded" && !sessionStorage.getItem("seenPassed")){
    sessionStorage.setItem("seenPassed","1");
    window.location.href = "passed.html";
  }
}



function updateRiskMeter(account){
  const dailyLimit = 0.02;
  const totalLimit = 0.05;
  const dayDD = Number(account.dayDD || 0);
  const totalDD = Number(account.totalDD || 0);

  const dailyUsed = clamp01(dayDD / dailyLimit);
  const totalUsed = clamp01(totalDD / totalLimit);

  const dailyPct = (dayDD * 100).toFixed(2) + "%";
  const totalPct = (totalDD * 100).toFixed(2) + "%";

  const dailyUsedEl = document.getElementById("dailyUsedPct");
  const totalUsedEl = document.getElementById("totalUsedPct");
  const dailyBar = document.getElementById("dailyBar");
  const totalBar = document.getElementById("totalBar");
  const dayEqLine = document.getElementById("dayEqLine");
  const totalEqLine = document.getElementById("totalEqLine");

  if(dailyUsedEl) dailyUsedEl.textContent = dailyPct;
  if(totalUsedEl) totalUsedEl.textContent = totalPct;
  if(dailyBar) dailyBar.style.width = (dailyUsed * 100).toFixed(0) + "%";
  if(totalBar) totalBar.style.width = (totalUsed * 100).toFixed(0) + "%";

  if(dayEqLine){
    const a = Number(account.dayStartEquity || 0);
    const b = Number(account.dayLowEquity || 0);
    dayEqLine.textContent = `Day start: ${money(a)} • Day low: ${money(b)}`;
  }
  if(totalEqLine){
    const s = Number(account.startEquity || 0);
    const e = Number(account.equity || 0);
    totalEqLine.textContent = `Peak: ${money(Number(account.peakEquity||s))} • Floor: ${money(Number(account.trailingFloor||0))} • Now: ${money(e)}`;
  }
}


// Auth check happens in init below
setYear();
qs("logoutBtn").addEventListener("click", () => logout());

let lastPrices = {};
let account = null;

const productSel = qs("product");
const priceInput = qs("price");
const typeSel = qs("type");
const limitInput = qs("limitPrice");
let _currentGran = '3600'; // default 1h
const granSel = { value: _currentGran }; // compat shim
window._onGranChange = function(g){ _currentGran = g; granSel.value = g; loadChartForCurrentProduct(); };
const countSel = qs("candlesCount");
const canvas = qs("candleCanvas");
const ctx = canvas ? canvas.getContext("2d") : null;
const wsStatus = document.getElementById("wsStatus");

// -------------------- Market universe (Top 50 on Coinbase) --------------------
const FALLBACK_PAIRS = ["BTC-USD","ETH-USD","SOL-USD","XRP-USD","ADA-USD","DOGE-USD","AVAX-USD","LINK-USD","DOT-USD","MATIC-USD","LTC-USD","BCH-USD","UNI-USD","ATOM-USD","ALGO-USD","XLM-USD","SHIB-USD","TRX-USD","TON-USD","NEAR-USD","ICP-USD","APT-USD","OP-USD","ARB-USD","FIL-USD","HBAR-USD","VET-USD","SAND-USD","MANA-USD","AXS-USD","AAVE-USD","GRT-USD","STX-USD","EGLD-USD","THETA-USD","FTM-USD","FLOW-USD","ROSE-USD","ENJ-USD","CHZ-USD","ZEC-USD","DASH-USD","ETC-USD","MKR-USD","SNX-USD","CRV-USD","COMP-USD","YFI-USD","SUSHI-USD","1INCH-USD"];

function populatePairs(list){
  if(!list || !list.length) return;
  const current = productSel.value;
  productSel.innerHTML = list.map(pid => `<option value="${pid}">${pid}</option>`).join("");
  if(list.includes(current)) productSel.value = current;
  const tickerBar = document.getElementById("tickerBar");
  if(tickerBar){
    tickerBar.innerHTML = list.slice(0,16).map((pid,i) => `
      <div class="ticker-item${i===0?' selected':''}" data-sym="${pid}">
        <div class="ticker-sym">${pid.replace('-USD','')}</div>
        <div class="ticker-price neu" id="tb-${pid.replace(/[^a-zA-Z0-9]/g,'_')}">—</div>
        <div class="ticker-chg neu" id="tc-${pid.replace(/[^a-zA-Z0-9]/g,'_')}">—</div>
      </div>
    `).join("");
  }
}

async function loadUniverse(){
  // Always populate with fallback first so pairs show immediately
  populatePairs(FALLBACK_PAIRS);
  try{
    const res = await apiFetch("/api/market/top50", { method:"GET" });
    const data = await res.json();
    const list = Array.isArray(data.product_ids) ? data.product_ids : [];
    if(list.length) populatePairs(list);
  }catch{
    // fallback already applied above
  }
}

function updateTickerBar(pid, price, open24){
  const safe = pid.replace(/[^a-zA-Z0-9]/g,'_');
  const el = document.getElementById('tb-'+safe);
  const chg = document.getElementById('tc-'+safe);
  if(!el) return;
  el.textContent = price >= 1000 ? '$'+price.toLocaleString(undefined,{maximumFractionDigits:0}) : '$'+price.toFixed(price<1?6:2);
  if(Number.isFinite(open24) && open24 > 0){
    const pct = ((price-open24)/open24*100).toFixed(2);
    const cls = price>=open24?'up':'dn';
    el.className = 'ticker-price '+cls;
    if(chg){ chg.textContent=(price>=open24?'+':'')+pct+'%'; chg.className='ticker-chg '+cls; }
  }
}


// -------------------- Order ticket helpers --------------------
function setLimitEnabled(){
  const isLimit = (document.getElementById("type")?.value || "market") === "limit";
  if(limitInput) limitInput.disabled = !isLimit;
  if(!isLimit && limitInput) limitInput.value = "";
}
setLimitEnabled();

// -------------------- REST helpers (fallback + candles) --------------------
async function fetchTickerREST(product){
  const res = await apiFetch(`/api/market/ticker?product=${encodeURIComponent(product)}`, { method:"GET" });
  const data = await res.json();
  const price = Number(data.price);
  if(Number.isFinite(price)) lastPrices[product] = price;
  return price;
}

async function refreshSelectedPriceREST(){
  const p = productSel.value;
  try{
    const price = await fetchTickerREST(p);
    priceInput.value = Number.isFinite(price) ? price.toFixed(2) : "";
  }catch{
    // ignore intermittent failures
  }
}

async function refreshAllPricesREST(){
  const prods = new Set([productSel.value, ...Object.keys(account?.positions || {})]);
  for(const p of prods){
    try{ await fetchTickerREST(p); }catch{ /* ignore */ }
  }
}

// -------------------- Account API (server-side liquidity) --------------------
async function loadAccount(){
  const res = await apiFetch("/api/account", { method:"GET" });
  account = await res.json();
  account.positions = account.positions || {};
  account.openOrders = account.openOrders || [];
  account.orders = account.orders || [];
  account.pendingOrders = account.pendingOrders || [];
}

function computeEquity(){
  let eq = account.cash;
  for(const [p, pos] of Object.entries(account.positions || {})){
    const last = lastPrices[p];
    eq += pos.qty * (typeof last === "number" ? last : pos.avg);
  }
  return eq;
}

function computeUnrealizedPLFor(product){
  const pos = (account.positions || {})[product];
  if(!pos) return 0;
  const last = lastPrices[product];
  if(typeof last !== "number") return 0;
  return pos.qty * (last - pos.avg);
}

function computeUnrealizedPL(){
  return Object.keys(account.positions || {}).reduce((a,p)=>a+computeUnrealizedPLFor(p),0);
}

function escapeHtml(str){
  return String(str).replace(/[&<>"']/g, (m) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[m]));
}

function render(){
  const equity = computeEquity();
  const upl = computeUnrealizedPL();

  qs("cash").textContent = money(account.cash);
  qs("equity").textContent = money(equity);
  qs("upl").textContent = (upl >= 0 ? "+" : "") + money(upl);

  const posBody = qs("posBody");
  const products = Object.keys(account.positions || {}).sort();
  posBody.innerHTML = products.length ? products.map(p => {
      const pos = account.positions[p];
      const last = lastPrices[p];
      const uplOne = computeUnrealizedPLFor(p);
      const lastTxt = (typeof last === "number") ? money(last) : "—";
      return `
        <tr>
          <td>${escapeHtml(p)}</td>
          <td>${pos.qty ? pos.qty.toFixed(8) : "0"}</td>
          <td>${pos.avg ? money(pos.avg) : "—"}</td>
          <td>${lastTxt}</td>
          <td style="color:${uplOne>=0?'var(--good)':'var(--bad)'}">${uplOne>=0?'+':''}${money(uplOne)}</td>
        </tr>`;
    }).join("") : `<tr><td colspan="5">No positions.</td></tr>`;

  const openBody = qs("openBody");
  const opens = account.openOrders || [];
  if(opens.length === 0){
    openBody.innerHTML = `<tr><td colspan="6">No open orders.</td></tr>`;
  }else{
    openBody.innerHTML = opens.slice(0,25).map(o => `
      <tr>
        <td>${fmtDate(o.time)}</td>
        <td>${escapeHtml(o.product)}</td>
        <td><span class="tag ${o.side==='buy'?'good':'warn'}">${escapeHtml(o.side.toUpperCase())}</span></td>
        <td>${Number(o.qty).toFixed(8)}</td>
        <td>${money(o.limitPrice)}</td>
        <td><button class="btn" data-cancel="${escapeHtml(o.id)}" type="button">Cancel</button></td>
      </tr>
    `).join("");

    openBody.querySelectorAll("button[data-cancel]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const id = btn.getAttribute("data-cancel");
        try{
          const res = await apiFetch("/api/orders/cancel", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ id }) });
          account = await res.json();
          account.openOrders = account.openOrders || [];
          toast("Order canceled");
          render();
  updateRiskMeter(account);
  updateChallengeProgress(account);
  updatePayoutMini(account);
  renderLockBanner(account);
        }catch(err){
          toast(err.message);
        }
      });
    });
  }

  
  const pendingBody = qs("pendingBody");
  const pending = account.pendingOrders || [];
  if(pendingBody){
    if(pending.length === 0){
      pendingBody.innerHTML = `<tr><td colspan="6">No queued orders.</td></tr>`;
    }else{
      const now = Date.now();
      pendingBody.innerHTML = pending.slice(0,25).map(o => {
        const etaMs = Math.max(0, (o.executeAt || 0) - now);
        const eta = `${Math.ceil(etaMs/1000)}s`;
        const typ = (o.type || "market").toUpperCase();
        return `
          <tr>
            <td>${fmtDate(o.time)}</td>
            <td>${eta}</td>
            <td>${escapeHtml(o.product)}</td>
            <td><span class="tag ${o.side==='buy'?'good':'warn'}">${escapeHtml(o.side.toUpperCase())}</span></td>
            <td>${typ}</td>
            <td>${Number(o.qty).toFixed(8)}</td>
          </tr>
        `;
      }).join("");
    }
  }

const ordersBody = qs("ordersBody");
  const orders = account.orders || [];
  ordersBody.innerHTML = orders.length ? orders.slice(0,25).map(o => `
      <tr>
        <td>${fmtDate(o.time)}</td>
        <td>${escapeHtml(o.product)}</td>
        <td><span class="tag ${o.side==='buy'?'good':'warn'}">${escapeHtml(o.side.toUpperCase())}</span></td>
        <td>${Number(o.qty).toFixed(8)}</td>
        <td>${money(o.price)}</td>
        <td>${money(o.notional)}</td>
      </tr>
  `).join("") : `<tr><td colspan="6">No orders yet.</td></tr>`;

  updateRiskMeter(account);
  updateChallengeProgress(account);
  updatePayoutMini(account);
  renderLockBanner(account);
}

// -------------------- WebSocket (real-time ticker) --------------------
let ws = null;
let wsConnected = false;
let wsProducts = new Set();

function setWsStatus(text){
  if(wsStatus) wsStatus.textContent = text;
}

function wsSubscribe(products){
  if(!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "subscribe", product_ids: Array.from(products), channels: ["ticker","heartbeat"] }));
}

function wsUnsubscribe(products){
  if(!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "unsubscribe", product_ids: Array.from(products), channels: ["ticker","heartbeat"] }));
}

function desiredProducts(){
  return new Set([productSel.value, ...Object.keys(account?.positions || {})]);
}

function syncWsSubscriptions(){
  if(!wsConnected) return;
  const want = desiredProducts();
  const toAdd = new Set([...want].filter(p => !wsProducts.has(p)));
  const toRemove = new Set([...wsProducts].filter(p => !want.has(p)));
  if(toRemove.size) wsUnsubscribe(toRemove);
  if(toAdd.size) wsSubscribe(toAdd);
  wsProducts = want;
}

function connectWs(){
  try{
    ws = new WebSocket("wss://ws-feed.exchange.coinbase.com");
  }catch{
    setWsStatus("Live feed: unavailable");
    return;
  }

  setWsStatus("Live feed: connecting…");
  wsConnected = false;

  ws.addEventListener("open", () => {
    wsConnected = true;
    setWsStatus("connected");
    wsProducts = new Set();
    syncWsSubscriptions();
    const dot = document.getElementById("statusDot");
    const st = document.getElementById("statusText");
    if(dot) dot.style.background = 'var(--term-green)';
    if(st) st.textContent = 'Live feed connected';
    const wsDot = document.getElementById("wsDot");
    if(wsDot){ wsDot.classList.remove("off"); }
  });

  ws.addEventListener("message", (ev) => {
    try{
      const msg = JSON.parse(ev.data);
      if(msg.type === "error"){ setWsStatus(`Live feed: error (${msg.message || "unknown"})`); return; }
      if(msg.type === "ticker" && msg.product_id && msg.price){
        const p = msg.product_id;
        const price = Number(msg.price);
        const open24 = Number(msg.open_24h);
        if(Number.isFinite(price)){
          lastPrices[p] = price;
          if(p === productSel.value){
            priceInput.value = price.toFixed(2);
            // Update live price display
            const liveEl = document.getElementById("price");
            if(liveEl){
              liveEl.textContent = price >= 1000 ? "$"+price.toLocaleString(undefined,{maximumFractionDigits:2}) : "$"+price.toFixed(price<1?6:2);
              if(Number.isFinite(open24) && open24>0){
                const pct = ((price-open24)/open24*100).toFixed(2);
                liveEl.style.color = price>=open24 ? 'var(--term-green)' : 'var(--term-red)';
                const chgEl = document.getElementById("priceChange");
                if(chgEl){ chgEl.textContent=(price>=open24?"+":"")+pct+"%"; chgEl.className=price>=open24?"up":"dn"; }
              }
            }
            // Status dot
            const dot = document.getElementById("statusDot");
            const st = document.getElementById("statusText");
            if(dot) dot.style.background = 'var(--term-green)';
            if(st) st.textContent = 'Live feed connected';
          }
          updateTickerBar(p, price, open24);
          render();
        }
      }
    }catch{
      // ignore
    }
  });

  ws.addEventListener("close", () => {
    wsConnected = false;
    setWsStatus("reconnecting…");
    const dot = document.getElementById("statusDot");
    const st = document.getElementById("statusText");
    if(dot) dot.style.background = 'var(--term-yellow)';
    if(st) st.textContent = 'Reconnecting…';
    const wsDot = document.getElementById("wsDot");
    if(wsDot) wsDot.classList.add("off");
    setTimeout(connectWs, 1200);
  });

  ws.addEventListener("error", () => {
    setWsStatus("Live feed: error (reconnecting…)"); 
  });
}

// -------------------- Trading actions --------------------
const msg = qs("msg");
const _safeMsg = (text, color) => { if(msg){ msg.textContent = text; if(color) msg.style.color = color; } };

window.submitOrder = async function() {
  msg.textContent = "Submitting…";
  msg.style.color = "var(--term-muted)";

  const payload = {
    product: productSel.value,
    side: document.getElementById("side").value,
    qty: Number(qs("qty").value),
    type: document.getElementById("type")?.value || "market",
    limitPrice: limitInput.value ? Number(limitInput.value) : null
  };

  if(!Number.isFinite(payload.qty) || payload.qty <= 0){
    msg.textContent = "Quantity must be positive.";
    return;
  }
  if(payload.type === "limit"){
    if(!Number.isFinite(payload.limitPrice) || payload.limitPrice <= 0){
      msg.textContent = "Enter a valid limit price.";
      return;
    }
  }

  try{
    const endpoint = payload.type === "limit" ? "/api/orders/limit" : "/api/trade";
    const res = await apiFetch(endpoint, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(payload) });
    const data = await res.json();
    account = data.account ? data.account : data;
    account.openOrders = account.openOrders || [];

    if(data.fill?.price){
      const fp = Number(data.fill.price);
      if(Number.isFinite(fp)) lastPrices[payload.product] = fp;
      priceInput.value = Number.isFinite(fp) ? fp.toFixed(2) : priceInput.value;
    }

    qs("qty").value = "";
    msg.textContent = payload.type === "limit" ? "Limit order placed." : (data.queued ? `Queued — filling in ~${Math.ceil((data.etaMs||12000)/1000)}s` : "Filled (demo).");
    toast(payload.type === "limit" ? "Limit order placed ✅" : (data.queued ? "Order queued ✅" : "Order filled ✅"));

    syncWsSubscriptions();
    render();
  }catch(err){
    msg.textContent = err.message;
    msg.style.color = 'var(--term-red)';
    toast(err.message);
  }
};

qs("resetBtn").addEventListener("click", async () => {
  if(confirm("Reset trading account? This clears positions, orders, and open orders.")){
    try{
      const res = await apiFetch("/api/account/reset", { method:"POST" });
      account = await res.json();
      account.openOrders = account.openOrders || [];
      toast("Account reset");
      syncWsSubscriptions();
      render();
    }catch(err){
      toast(err.message);
    }
  }
});

qs("seedBtn").addEventListener("click", async () => {
  try{
    const res = await apiFetch("/api/account/seed", { method:"POST" });
    account = await res.json();
    account.openOrders = account.openOrders || [];
    toast("Seeded $50,000");
    syncWsSubscriptions();
    render();
  }catch(err){
    toast(err.message);
  }
});

// -------------------- Candlestick chart (REST proxy) --------------------
async function fetchCandles(product, gran, limit){
  const res = await apiFetch(`/api/market/candles?product=${encodeURIComponent(product)}&granularity=${encodeURIComponent(gran)}&limit=${encodeURIComponent(limit)}`, { method:"GET" });
  return await res.json();
}

function resizeCanvas(){
  if(!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.parentElement.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  canvas.style.width = rect.width + "px";
  canvas.style.height = rect.height + "px";
  ctx.scale(dpr, dpr);
}

function drawCandles(candles){
  if(!ctx || !canvas) return;
  resizeCanvas();
  const dpr = window.devicePixelRatio || 1;
  const data = Array.isArray(candles) ? candles.slice().reverse() : [];
  ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);

  if(data.length === 0){
    ctx.fillStyle = "rgba(255,255,255,.65)";
    ctx.font = "16px system-ui";
    ctx.fillText("No candle data.", 20, 30);
    return;
  }

  let minP = Infinity, maxP = -Infinity;
  for(const c of data){
    const low = Number(c[1]), high = Number(c[2]);
    if(Number.isFinite(low)) minP = Math.min(minP, low);
    if(Number.isFinite(high)) maxP = Math.max(maxP, high);
  }
  if(!Number.isFinite(minP) || !Number.isFinite(maxP) || minP === maxP){
    minP = minP || 0; maxP = maxP || 1;
  }

  const dpr2 = window.devicePixelRatio || 1;
  const W = canvas.width / dpr2, H = canvas.height / dpr2;
  const pad = 28;
  const innerW = W - pad*2;
  const innerH = H - pad*2;

  ctx.strokeStyle = "rgba(255,255,255,.06)";
  ctx.lineWidth = 1;
  for(let i=0;i<=4;i++){
    const y = pad + (innerH*i/4);
    ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(W-pad, y); ctx.stroke();
  }

  const xStep = innerW / data.length;
  const priceToY = (p) => pad + (maxP - p) * (innerH / (maxP - minP));

  const bodyW = Math.max(2, xStep * 0.55);
  for(let i=0;i<data.length;i++){
    const low = Number(data[i][1]), high = Number(data[i][2]), open = Number(data[i][3]), close = Number(data[i][4]);
    const x = pad + i*xStep + (xStep/2);

    const yHigh = priceToY(high);
    const yLow  = priceToY(low);
    const yOpen = priceToY(open);
    const yClose= priceToY(close);

    const up = close >= open;

    ctx.strokeStyle = up ? "rgba(126,231,135,.95)" : "rgba(255,107,107,.95)";
    ctx.beginPath(); ctx.moveTo(x, yHigh); ctx.lineTo(x, yLow); ctx.stroke();

    const yTop = Math.min(yOpen, yClose);
    const yBot = Math.max(yOpen, yClose);
    ctx.fillStyle = up ? "rgba(126,231,135,.35)" : "rgba(255,107,107,.35)";
    ctx.fillRect(x - bodyW/2, yTop, bodyW, Math.max(2, yBot - yTop));
    ctx.strokeStyle = up ? "rgba(126,231,135,.75)" : "rgba(255,107,107,.75)";
    ctx.strokeRect(x - bodyW/2, yTop, bodyW, Math.max(2, yBot - yTop));
  }

  ctx.fillStyle = "rgba(255,255,255,.70)";
  ctx.font = "12px system-ui";
  ctx.fillText(maxP.toFixed(2), 8, pad+4);
  ctx.fillText(minP.toFixed(2), 8, H-pad+12);
}

async function refreshChart(){
  try{
    const candles = await fetchCandles(productSel.value, granSel.value, countSel.value);
    drawCandles(candles);
  }catch(err){
    toast(err.message);
    drawCandles([]);
  }
}

function loadChartForCurrentProduct(){ refreshChart(); }

window.addEventListener("resize", () => refreshChart());

productSel.addEventListener("change", () => {
  document.getElementById("activePair").textContent = productSel.value;
  syncWsSubscriptions();
  refreshChart();
});
countSel.addEventListener("change", refreshChart);

// Ticker bar product selection
window._onTickerSelect = function(sym){
  productSel.value = sym;
  document.getElementById("activePair").textContent = sym;
  syncWsSubscriptions();
  refreshChart();
};

// -------------------- Limit order processing loop --------------------
async function processOpenOrders(){
  try{
    const res = await apiFetch("/api/orders/process", { method:"POST" });
    account = await res.json();
    account.openOrders = account.openOrders || [];
    syncWsSubscriptions();
  }catch{
    // ignore
  }
}

// -------------------- Init --------------------
const _user = await requireAuth();
if(!_user) throw new Error("Not authenticated"); // stops module if redirected

qs("who").textContent = `Signed in as ${_user.email}`;
await loadAccount();
await loadUniverse();
connectWs();

// initial REST fallback
await refreshSelectedPriceREST();
await refreshAllPricesREST();

render();
await refreshChart();
syncWsSubscriptions();

productSel.addEventListener("change", async () => {
  await refreshSelectedPriceREST();
  syncWsSubscriptions();
});

// Polling: process open orders every 2s, reload account every 10s
let _pollCount = 0;
setInterval(async () => {
  _pollCount++;
  await processOpenOrders();
  await refreshSelectedPriceREST();
  if(_pollCount % 5 === 0) await loadAccount();
  render();
}, 2000);
