import { setYear, toast, qs, money } from "./app.js";
import { requireAuth, logout, getSession, apiFetch } from "./app.js";


function clamp01(x){ return Math.max(0, Math.min(1, x)); }

function fmtTime(iso){
  if(!iso) return "—";
  const d = new Date(iso);
  if(isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function renderEquityChart(points){
  const el = document.getElementById("equityChart");
  if(!el) return;
  if(!Array.isArray(points) || points.length < 2){
    el.innerHTML = `<div class="muted small">Not enough data yet. Place some trades to generate an equity curve.</div>`;
    return;
  }

  const w = 900, h = 180, pad = 10;
  const xs = points.map((p,i)=>i);
  const ys = points.map(p=>Number(p.e||0));
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const range = (maxY - minY) || 1;

  const scaleX = (i) => pad + (i/(points.length-1))*(w-2*pad);
  const scaleY = (y) => pad + (1-((y-minY)/range))*(h-2*pad);

  const path = points.map((p,i)=>`${scaleX(i).toFixed(1)},${scaleY(Number(p.e||0)).toFixed(1)}`).join(" ");

  const last = ys[ys.length-1];
  el.innerHTML = `
    <svg viewBox="0 0 ${w} ${h}" width="100%" height="160" preserveAspectRatio="none">
      <polyline fill="none" stroke="currentColor" stroke-width="2" points="${path}" opacity="0.9"></polyline>
      <line x1="${pad}" y1="${scaleY(last)}" x2="${w-pad}" y2="${scaleY(last)}" stroke="currentColor" stroke-dasharray="4 4" opacity="0.25"></line>
      <text x="${pad}" y="${pad+12}" font-size="12" fill="currentColor" opacity="0.6">${money(maxY)}</text>
      <text x="${pad}" y="${h-pad}" font-size="12" fill="currentColor" opacity="0.6">${money(minY)}</text>
    </svg>
  `;
}

function renderPnlCalendar(account){
  const el = document.getElementById("pnlCalendar");
  if(!el) return;

  const hist = account.dailyProfitHistory || {};
  // include current day profit (equity - dayStartEquity)
  const todayKey = (new Date()).toISOString().slice(0,10);
  const curDayProfit = Number(account.equity || 0) - Number(account.dayStartEquity || 0);
  const merged = { ...hist };
  merged[todayKey] = curDayProfit;

  const days = 30;
  const today = new Date();
  const dates = [];
  for(let i=days-1;i>=0;i--){
    const d = new Date(today.getTime() - i*86400000);
    const key = d.toISOString().slice(0,10);
    dates.push(key);
  }

  const vals = dates.map(k => Number(merged[k] || 0));
  const maxAbs = Math.max(1, ...vals.map(v=>Math.abs(v)));

  const cells = dates.map((k, idx) => {
    const v = Number(merged[k] || 0);
    const intensity = Math.min(1, Math.abs(v)/maxAbs);
    const bg = v > 0 ? `rgba(0,255,153,${0.08 + 0.35*intensity})`
             : v < 0 ? `rgba(255,77,77,${0.08 + 0.35*intensity})`
             : `rgba(255,255,255,0.05)`;
    const title = `${k}: ${money(v)}`;
    return `<div title="${title}" style="background:${bg}; border:1px solid rgba(255,255,255,0.06); border-radius:10px; padding:8px; min-height:44px; display:flex; flex-direction:column; justify-content:space-between">
      <div class="tiny muted">${k.slice(5)}</div>
      <div style="font-weight:700; font-size:.9rem">${v===0 ? "—" : (v>0?"+":"") + money(v)}</div>
    </div>`;
  }).join("");

  el.innerHTML = `
    <div style="display:grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap:8px">
      ${cells}
    </div>
    <div class="tiny muted" style="margin-top:8px">Green = profitable day • Red = losing day • Hover for exact PnL</div>
  `;
}

function updatePayoutPanel(account){
  const panel = document.getElementById("payoutPanel");
  if(!panel) return;

  const wEl = document.getElementById("withdrawable");
  const eLine = document.getElementById("eligibleLine");
  const capR = document.getElementById("capRemaining");
  const capL = document.getElementById("capLine");
  const body = document.getElementById("payoutBody");

  const phase = account.challengePhase || "challenge";
  const withdrawable = Number(account.withdrawable || 0);
  const capRem = Number(account.payoutCapRemaining || 0);
  const cap = Number(account.payoutCap || 0);
  const eligibleAt = account.payoutEligibleAt || null;

  if(wEl) wEl.textContent = money(withdrawable);
  const elig = Number(account.payoutEligiblePnL||0);
  const buf = Number(account.profitBuffer||0);
  if(eLine && (account.challengePhase||'challenge')==='funded'){
    // augment eligibility line with buffer progress
    const prog = buf>0 ? Math.max(0, Math.min(1, elig/buf)) : 1;
    const pct = (prog*100).toFixed(0);
    eLine.textContent += ` • Buffer progress: ${pct}%`;
  }
  if(capR) capR.textContent = money(capRem);
  if(capL) capL.textContent = `Weekly cap: ${money(cap)} • Paid this period: ${money(Number(account.payoutsPaidThisPeriod||0))} • Profit buffer: ${money(Number(account.profitBuffer||0))} • Daily payout cap: ${money(Number(account.dailyPayoutCap||0))}`;

  if(eLine){
    if(phase !== "funded"){
      eLine.textContent = "Payouts available after passing (funded phase).";
    }else if(eligibleAt){
      const t = new Date(eligibleAt).getTime();
      const now = Date.now();
      if(now >= t) eLine.textContent = `Eligible now • Period: ${account.payoutPeriodStart || "—"}`;
      else{
        const hrs = Math.ceil((t-now)/3600000);
        eLine.textContent = `Eligible at ${eligibleAt} (~${hrs}h)`;
      }
    }else{
      eLine.textContent = "Eligibility not set.";
    }
  }



function statusBadge(ok){ return ok ? "✅ Verified" : "❌ Not verified"; }

function updateVerifyPanel(acct){
  const e = document.getElementById("emailStatus");
  const k = document.getElementById("kycStatus");
  if(e) e.textContent = statusBadge(!!acct.emailVerified);
  if(k) k.textContent = (acct.kycStatus || "not_started").toUpperCase();
}

function wireVerification(loadAccount){
  const reqEmail = document.getElementById("reqEmail");
  const confEmail = document.getElementById("confEmail");
  const kycForm = document.getElementById("kycForm");

  if(reqEmail) reqEmail.addEventListener("click", async () => {
    const hint = document.getElementById("emailHint");
    if(hint) hint.textContent = "Sending…";
    try{
      const res = await apiFetch("/api/verify/request-email", { method:"POST" });
      const data = await res.json();
      if(!res.ok) throw new Error(data.error || "Failed");
      if(hint) hint.textContent = 'Code sent — check your email.';
    }catch(err){
      if(hint) hint.textContent = err.message;
      toast(err.message);
    }
  });

  if(confEmail) confEmail.addEventListener("click", async () => {
    const code = (document.getElementById("emailCode")?.value || "").trim();
    try{
      const res = await apiFetch("/api/verify/confirm-email", { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ code }) });
      const data = await res.json();
      if(!res.ok) throw new Error(data.error || "Failed");
      toast("Email verified");
      await loadAccount();
    }catch(err){ toast(err.message); }
  });

  if(kycForm) kycForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = document.getElementById("kycMsg");
    if(msg) msg.textContent = "Submitting…";
    const profile = {
      name: (document.getElementById("kycName")?.value || "").trim(),
      dob: (document.getElementById("kycDob")?.value || "").trim(),
      address: (document.getElementById("kycAddr")?.value || "").trim(),
      docType: (document.getElementById("kycDoc")?.value || "").trim(),
    };
    try{
      const res = await apiFetch("/api/kyc/submit", { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ profile }) });
      const data = await res.json();
      if(!res.ok) throw new Error(data.error || "Failed");
      if(msg) msg.textContent = "Submitted ✅ (pending review)";
      await loadAccount();
    }catch(err){
      if(msg) msg.textContent = err.message;
      toast(err.message);
    }
  });
}

  const payouts = Array.isArray(account.payouts) ? account.payouts : [];
  const reqs = Array.isArray(account.payoutRequests) ? account.payoutRequests : [];
  const pending = reqs.filter(r => r.status === 'pending');
  if(body){
    if(pending.length > 0){
      body.innerHTML = pending.slice(0,25).map(p => `
        <tr>
          <td>${fmtTime(p.time)}</td>
          <td>${money(p.amount)}</td>
          <td>${(p.period||'—')} (PENDING) • id: ${p.id}</td>
        </tr>
      `).join('') + (payouts.length? payouts.slice(0,25).map(p => `
        <tr>
          <td>${fmtTime(p.time)}</td>
          <td>${money(p.amount)}</td>
          <td>${p.period || '—'}</td>
        </tr>
      `).join('') : '');
    } else if(payouts.length === 0){
      body.innerHTML = `<tr><td colspan="3">No payouts yet.</td></tr>`;
    }else{
      body.innerHTML = payouts.slice(0,25).map(p => `
        <tr>
          <td>${fmtTime(p.time)}</td>
          <td>${money(p.amount)}</td>
          <td>${p.period || "—"}</td>
        </tr>
      `).join("");
    }
  }
}

async function loadEquityHistory(){
  try{
    const res = await apiFetch("/api/equity/history", { method:"GET" });
    const data = await res.json();
    if(data && data.points) renderEquityChart(data.points);
  }catch{
    // ignore
  }
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



function clamp01(x){ return Math.max(0, Math.min(1, x)); }

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


requireAuth();
setYear();

const session = getSession();
qs("who").textContent = session?.email ? `Signed in as ${session.email}` : "";
qs("logoutBtn").addEventListener("click", () => logout());

const grid = document.getElementById("tickerGrid");
const filterInput = document.getElementById("marketFilter");
const wsStatus = document.getElementById("dashWsStatus");

let universe = [];
let tick = {}; // { "BTC-USD": { price, open24, changePct } }
let ws = null;
let wsConnected = false;

function setWsStatus(t){
  if(wsStatus) wsStatus.textContent = t;
}

function escapeHtml(str){
  return String(str).replace(/[&<>"']/g, (m) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[m]));
}

function fmtPct(x){
  if(typeof x !== "number" || !Number.isFinite(x)) return "—";
  return (x >= 0 ? "+" : "") + (x*100).toFixed(2) + "%";
}

function cardHTML(pid){
  const d = tick[pid] || {};
  const price = (typeof d.price === "number" && Number.isFinite(d.price)) ? money(d.price) : "—";
  const pct = (typeof d.changePct === "number" && Number.isFinite(d.changePct)) ? d.changePct : null;
  const pctTxt = fmtPct(pct);
  const pctColor = pct == null ? "rgba(255,255,255,.65)" : (pct >= 0 ? "var(--good)" : "var(--bad)");
  const sym = pid.replace("-USD","");
  return `
    <div class="card glass" style="padding:14px">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:10px">
        <div>
          <div style="font-weight:700; letter-spacing:.2px">${escapeHtml(sym)}</div>
          <div class="tiny muted">${escapeHtml(pid)}</div>
        </div>
        <div style="text-align:right">
          <div style="font-weight:700">${price}</div>
          <div class="tiny" style="color:${pctColor}">${pctTxt}</div>
        </div>
      </div>
    </div>
  `;
}

function render(){
  if(!grid) return;
  const q = (filterInput?.value || "").trim().toUpperCase();
  const list = universe.filter(pid => !q || pid.includes(q) || pid.replace("-USD","").includes(q));
  grid.innerHTML = list.map(cardHTML).join("");
}

async function loadUniverse(){
  try{
    const res = await apiFetch("/api/market/top50", { method:"GET" });
    const data = await res.json();
    universe = Array.isArray(data.product_ids) ? data.product_ids : [];
  }catch(err){
    toast(err.message);
    universe = ["BTC-USD","ETH-USD","SOL-USD"];
  }
}

function applyTicker(pid, price, open24){
  if(!Number.isFinite(price)) return;
  const o = Number.isFinite(open24) ? open24 : (tick[pid]?.open24 ?? null);
  tick[pid] = {
    price,
    open24: o,
    changePct: (Number.isFinite(o) && o > 0) ? (price - o)/o : (tick[pid]?.changePct ?? null)
  };
}

async function hydrateOnceWithREST(){
  // Fill initial grid quickly before WS ticks arrive
  try{
    const sample = universe.slice(0, 30);
    const res = await apiFetch(`/api/market/tickers?products=${encodeURIComponent(sample.join(","))}`, { method:"GET" });
    const data = await res.json();
    const t = data?.tickers || {};
    for(const pid of Object.keys(t)){
      const price = Number(t[pid]?.price);
      const open24 = Number(t[pid]?.open_24h);
      applyTicker(pid, price, open24);
    }
  }catch{
    // ignore
  }
  render();
  updateRiskMeter(account);
  if(window.updateCheckoutBanner) window.updateCheckoutBanner(account);
  updateChallengeProgress(account);
  updatePayoutPanel(account);


  updateVerifyPanel(account);
  if(account.challengeStepInfo && (account.challengePhase||'challenge')==='challenge'){
    const s = account.challengeStepInfo;
    // no-op, info available
  }
  if(account.lockedUntil){
    const t = new Date(account.lockedUntil).getTime();
    if(Number.isFinite(t) && Date.now() < t){ toast(`Trading locked until ${account.lockedUntil}`); }
  }
  renderPnlCalendar(account);
  loadEquityHistory();
}

function wsSubscribe(products){
  if(!ws || ws.readyState !== WebSocket.OPEN) return;
  // Subscribe to ticker + heartbeat to help keep the connection active.
  ws.send(JSON.stringify({ type:"subscribe", product_ids: products, channels:["ticker","heartbeat"] }));
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
    setWsStatus("Live feed: connected");
    wsSubscribe(universe);
  });

  ws.addEventListener("message", (ev) => {
    try{
      const msg = JSON.parse(ev.data);

      if(msg.type === "subscriptions"){
        // ok
        return;
      }

      if(msg.type === "error"){
        setWsStatus(`Live feed: error (${msg.message || "unknown"})`);
        return;
      }

      if(msg.type === "ticker" && msg.product_id && msg.price){
        const pid = msg.product_id;
        const price = Number(msg.price);
        const open24 = Number(msg.open_24h);
        applyTicker(pid, price, open24);

        if(!render._t){
          render._t = setTimeout(() => { render._t = null; render(); }, 250);
        }
      }
    }catch{
      // ignore
    }
  });

  ws.addEventListener("close", () => {
    wsConnected = false;
    setWsStatus("Live feed: reconnecting…");
    setTimeout(connectWs, 1500);
  });

  ws.addEventListener("error", () => setWsStatus("Live feed: error (reconnecting…)"));
}

// REST fallback polling (works even if WS blocked)
async function pollREST(){
  try{
    const q = (filterInput?.value || "").trim().toUpperCase();
    const list = universe.filter(pid => !q || pid.includes(q) || pid.replace("-USD","").includes(q)).slice(0, 50);
    if(list.length === 0) return;
    const res = await apiFetch(`/api/market/tickers?products=${encodeURIComponent(list.join(","))}`, { method:"GET" });
    const data = await res.json();
    const t = data?.tickers || {};
    for(const pid of Object.keys(t)){
      const price = Number(t[pid]?.price);
      const open24 = Number(t[pid]?.open_24h);
      applyTicker(pid, price, open24);
    }
    render();
  }catch{
    // ignore
  }
}

filterInput?.addEventListener("input", () => {
  render();
  // also refresh REST quickly when searching
  pollREST();
});

// init
await loadUniverse();
render();
await hydrateOnceWithREST();
connectWs();

// Keep updating even if WS is blocked / rejected
setInterval(pollREST, 5000);


const payoutForm = document.getElementById("payoutForm");
if(payoutForm){
  payoutForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = document.getElementById("payoutMsg");
    const amt = Number(document.getElementById("payoutAmount")?.value || 0);
    if(msg) msg.textContent = "Submitting…";
    try{
      const res = await apiFetch("/api/payout/request", {
        method:"POST",
        headers: { "Content-Type":"application/json" },
        body: JSON.stringify({ amount: amt })
      });
      const data = await res.json();
      if(!res.ok) throw new Error(data.error || "Payout request failed");
      if(msg) msg.textContent = "Payout recorded ✅";
      // refresh account
      await loadAccount();
    }catch(err){
      if(msg) msg.textContent = err.message;
      toast(err.message);
    }
  });
}


wireVerification(loadAccount);





function updateConsistencyUI(account){
  const box = document.getElementById("consistencyBox");
  const text = document.getElementById("consistencyText");
  const bar = document.getElementById("consistencyBar");
  const badge = document.getElementById("minDaysBadge");

  if(!box || account.challengePhase !== "challenge"){
    if(box) box.style.display = "none";
    return;
  }

  const info = account.challengeStepInfo;
  if(!info){
    box.style.display = "none";
    return;
  }

  box.style.display = "block";

  const tradedDays = Object.keys(account.tradingDays||{}).length;
  const minDays = info.step === 1 ? 5 : 7;
  const remainingDays = Math.max(0, minDays - tradedDays);

  const totalProfit = (account.equity - (account.stepStartEquity||account.startEquity||0));
  const maxSingle = Math.max(...Object.values(account.profitableDays||{}), 0);
  const allowed = totalProfit * 0.40;

  let consistencyRatio = 1;
  if(totalProfit > 0){
    consistencyRatio = Math.min(1, allowed > 0 ? (allowed - maxSingle + allowed) / allowed : 1);
  }

  const pct = Math.max(0, Math.min(100, consistencyRatio * 100));
  bar.style.width = pct + "%";

  text.textContent = `Max single-day profit: $${maxSingle.toFixed(2)} | Allowed: $${allowed.toFixed(2)} (40% rule)`;

  if(remainingDays > 0){
    badge.textContent = `You need ${remainingDays} more trading day(s) to pass.`;
    badge.style.color = "#facc15";
  }else{
    badge.textContent = "Minimum trading days requirement satisfied.";
    badge.style.color = "#22c55e";
  }
}

// ===== CHECKOUT MODAL =====
(function(){
  const PRICES = { "25k": 149, "50k": 279, "100k": 499 };
  const LABELS = { "25k": "$25K Account", "50k": "$50K Account", "100k": "$100K Account" };

  let selectedPlan = null;
  let promoData = null; // { discountPct, discountAmt, finalPrice, code }

  const overlay   = document.getElementById("checkoutOverlay");
  const closeBtn  = document.getElementById("checkoutClose");
  const openBtn   = document.getElementById("openCheckoutBtn");
  const confirmBtn = document.getElementById("checkoutConfirm");
  const promoInput = document.getElementById("promoInput");
  const promoApply = document.getElementById("promoApply");
  const promoMsg  = document.getElementById("promoMsg");
  const checkoutMsg = document.getElementById("checkoutMsg");
  const noPlanBanner = document.getElementById("noPlanBanner");
  const challengeProgress = document.getElementById("challengeProgress");

  // Show/hide no-plan banner based on account state
  window.updateCheckoutBanner = function(account) {
    if(!account || !account.planId) {
      if(noPlanBanner) noPlanBanner.style.display = "block";
      if(challengeProgress) challengeProgress.style.display = "none";
    } else {
      if(noPlanBanner) noPlanBanner.style.display = "none";
      if(challengeProgress) challengeProgress.style.display = "";
    }
  };

  function openModal() {
    if(overlay) overlay.style.display = "flex";
    selectedPlan = null;
    promoData = null;
    if(promoInput) promoInput.value = "";
    if(promoMsg) promoMsg.textContent = "";
    if(checkoutMsg) checkoutMsg.textContent = "";
    updateSummary();
    document.querySelectorAll(".checkout-plan").forEach(el => el.classList.remove("selected"));
  }

  function closeModal() {
    if(overlay) overlay.style.display = "none";
  }

  function updateSummary() {
    const summaryPlan = document.getElementById("summaryPlan");
    const summaryTotal = document.getElementById("summaryTotal");
    const summaryDiscountRow = document.getElementById("summaryDiscountRow");
    const summaryDiscount = document.getElementById("summaryDiscount");
    const summaryDiscountLabel = document.getElementById("summaryDiscountLabel");

    if(!selectedPlan) {
      if(summaryPlan) summaryPlan.textContent = "—";
      if(summaryTotal) summaryTotal.textContent = "—";
      if(summaryDiscountRow) summaryDiscountRow.style.display = "none";
      if(confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = "Select a plan to continue"; }
      return;
    }

    const basePrice = PRICES[selectedPlan];
    if(summaryPlan) summaryPlan.textContent = LABELS[selectedPlan];

    if(promoData) {
      if(summaryDiscountRow) summaryDiscountRow.style.display = "flex";
      if(summaryDiscountLabel) summaryDiscountLabel.textContent = `Promo (${promoData.code}) −${promoData.discountPct}%`;
      if(summaryDiscount) summaryDiscount.textContent = `−$${promoData.discountAmt}`;
      if(summaryTotal) summaryTotal.textContent = `$${promoData.finalPrice}`;
    } else {
      if(summaryDiscountRow) summaryDiscountRow.style.display = "none";
      if(summaryTotal) summaryTotal.textContent = `$${basePrice}`;
    }

    if(confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = "Confirm & Start Challenge"; }
  }

  // Plan card selection
  document.querySelectorAll(".checkout-plan").forEach(card => {
    card.addEventListener("click", () => {
      document.querySelectorAll(".checkout-plan").forEach(c => c.classList.remove("selected"));
      card.classList.add("selected");
      selectedPlan = card.dataset.plan;
      promoData = null;
      if(promoMsg) promoMsg.textContent = "";
      if(promoInput) promoInput.value = "";
      updateSummary();
    });
  });

  // Apply promo code
  if(promoApply) promoApply.addEventListener("click", async () => {
    const code = (promoInput?.value || "").trim();
    if(!code) return;
    if(!selectedPlan) { if(promoMsg) { promoMsg.textContent = "Please select a plan first."; promoMsg.style.color = "#f87171"; } return; }
    promoApply.disabled = true;
    promoApply.textContent = "Checking…";
    if(promoMsg) promoMsg.textContent = "";
    try {
      const res = await apiFetch("/api/promo/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, planId: selectedPlan })
      });
      const data = await res.json();
      if(!res.ok) throw new Error(data.error || "Invalid code");
      promoData = data;
      if(promoMsg) { promoMsg.textContent = `✅ ${data.discountPct}% off applied! You save $${data.discountAmt}.`; promoMsg.style.color = "#4ade80"; }
      updateSummary();
    } catch(err) {
      promoData = null;
      if(promoMsg) { promoMsg.textContent = `❌ ${err.message}`; promoMsg.style.color = "#f87171"; }
      updateSummary();
    } finally {
      promoApply.disabled = false;
      promoApply.textContent = "Apply";
    }
  });

  // Allow pressing Enter in promo input
  if(promoInput) promoInput.addEventListener("keydown", e => { if(e.key === "Enter") promoApply?.click(); });

  // Confirm purchase
  if(confirmBtn) confirmBtn.addEventListener("click", async () => {
    if(!selectedPlan) return;
    confirmBtn.disabled = true;
    confirmBtn.textContent = "Processing…";
    if(checkoutMsg) checkoutMsg.textContent = "";
    try {
      const body = { planId: selectedPlan };
      if(promoData) body.promoCode = promoData.code;
      const res = await apiFetch("/api/plan/choose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if(!res.ok) throw new Error(data.error || "Purchase failed");
      closeModal();
      location.reload();
    } catch(err) {
      if(checkoutMsg) { checkoutMsg.textContent = err.message; checkoutMsg.style.color = "#f87171"; }
      confirmBtn.disabled = false;
      confirmBtn.textContent = "Confirm & Start Challenge";
    }
  });

  if(openBtn) openBtn.addEventListener("click", openModal);
  if(closeBtn) closeBtn.addEventListener("click", closeModal);
  if(overlay) overlay.addEventListener("click", e => { if(e.target === overlay) closeModal(); });
})();
