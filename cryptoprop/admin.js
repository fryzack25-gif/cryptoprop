import { toast, money } from "./app.js";

function key(){ return localStorage.getItem("cp_admin_key") || ""; }

async function api(url, opts={}){
  const headers = opts.headers || {};
  headers["x-admin-key"] = key();
  const res = await fetch(url, { ...opts, headers });
  const data = await res.json().catch(()=> ({}));
  if(!res.ok) throw new Error(data.error || "Admin request failed");
  return data;
}

function pct(x){ return (Number(x||0)*100).toFixed(2) + "%"; }

async function load(){
  const status = document.getElementById("status");
  status.textContent = "Loading…";
  try{
    const data = await api("/api/admin/overview");
    const body = document.getElementById("acctBody");
    const rows = data.accounts || [];
    if(rows.length === 0){
      body.innerHTML = `<tr><td colspan="11">No accounts.</td></tr>`;
    }else{
      body.innerHTML = rows.map(a => `
        <tr>
          <td>${a.email}</td>
          <td>${a.phase}${a.failed ? " (FAILED)" : ""}</td>
          <td>${money(a.equity)}</td>
          <td>${pct(a.dayDD)}</td>
          <td>${pct(a.totalDD)}</td>
          <td>${money(a.withdrawable)}</td>
          <td>${a.pendingPayouts}</td>
          <td>${a.deviceCount || 0}</td>
          <td>${a.ipCount || 0}</td>
          <td>${a.frozen ? "Yes" : "No"}</td>
          <td style="white-space:nowrap">
            <button class="btn" data-freeze="${a.email}" data-state="${a.frozen ? "0":"1"}">${a.frozen ? "Unfreeze":"Freeze"}</button>
          </td>
        </tr>
      `).join("");
    }
    status.textContent = "Updated ✅";
  }catch(err){
    status.textContent = err.message;
    toast(err.message);
  }
}

document.getElementById("adminKey").value = key();
document.getElementById("saveKey").addEventListener("click", () => {
  localStorage.setItem("cp_admin_key", document.getElementById("adminKey").value.trim());
  toast("Saved admin key");
});
document.getElementById("refresh").addEventListener("click", load);

document.getElementById("acctBody").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-freeze]");
  if(!btn) return;
  const email = btn.getAttribute("data-freeze");
  const frozen = btn.getAttribute("data-state") === "1";
  try{
    await api("/api/admin/account/freeze", {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ email, frozen })
    });
    toast(frozen ? "Frozen" : "Unfrozen");
    load();
  }catch(err){
    toast(err.message);
  }
});

document.getElementById("approveForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = document.getElementById("approveMsg");
  msg.textContent = "Approving…";
  try{
    const email = document.getElementById("payEmail").value.trim();
    const id = document.getElementById("payId").value.trim();
    await api("/api/admin/payout/approve", {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ email, id })
    });
    msg.textContent = "Approved ✅";
    toast("Payout approved");
    load();
  }catch(err){
    msg.textContent = err.message;
    toast(err.message);
  }
});

load();


async function loadQueue(){
  const body = document.getElementById("queueBody");
  if(!body) return;
  try{
    const data = await api("/api/admin/payout/pending");
    const rows = data.pending || [];
    if(rows.length === 0){
      body.innerHTML = `<tr><td colspan="6">No pending payouts.</td></tr>`;
      return;
    }
    body.innerHTML = rows.map(r => `
      <tr>
        <td>${r.time ? new Date(r.time).toLocaleString() : "—"}</td>
        <td>${r.email}</td>
        <td>${money(r.amount)}</td>
        <td>${r.period || "—"}</td>
        <td style="font-family: ui-monospace, SFMono-Regular, Menlo, monospace">${r.id}</td>
        <td><button class="btn primary" data-approve-email="${r.email}" data-approve-id="${r.id}">Approve</button></td>
      </tr>
    `).join("");
  }catch(err){
    body.innerHTML = `<tr><td colspan="6">${err.message}</td></tr>`;
  }
}

async function loadFlags(){
  const box = document.getElementById("flagsBox");
  if(!box) return;
  try{
    const data = await api("/api/admin/risk/flags");
    const dev = data.deviceFlags || [];
    const ips = data.ipFlags || [];
    const devHtml = dev.length ? `<div><b>Device shared by ≥2 accounts</b><ul>${dev.slice(0,20).map(x=>`<li><span style="font-family: ui-monospace">${x.device}</span> → ${x.emails.join(", ")}</li>`).join("")}</ul></div>` : `<div>No shared-device flags.</div>`;
    const ipHtml = ips.length ? `<div style="margin-top:10px"><b>IP shared by ≥3 accounts</b><ul>${ips.slice(0,20).map(x=>`<li><span style="font-family: ui-monospace">${x.ip}</span> → ${x.emails.join(", ")}</li>`).join("")}</ul></div>` : `<div style="margin-top:10px">No shared-IP flags.</div>`;
    box.innerHTML = devHtml + ipHtml;
  }catch(err){
    box.textContent = err.message;
  }
}

// hook approve buttons in queue
document.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-approve-email]");
  if(!btn) return;
  const email = btn.getAttribute("data-approve-email");
  const id = btn.getAttribute("data-approve-id");
  try{
    await api("/api/admin/payout/approve", {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ email, id })
    });
    toast("Payout approved");
    load();
    loadQueue();
  }catch(err){
    toast(err.message);
  }
});

// refresh extra panels when loading
const _origLoad = load;
load = async function(){
  await _origLoad();
  await loadQueue();
  await loadFlags();
};

async function loadKyc(){
  const body = document.getElementById("kycBody");
  if(!body) return;
  try{
    const data = await api("/api/admin/kyc/pending");
    const rows = data.pending || [];
    if(rows.length === 0){
      body.innerHTML = `<tr><td colspan="7">No pending KYC.</td></tr>`;
      return;
    }
    body.innerHTML = rows.map(r => `
      <tr>
        <td>${r.submittedAt ? new Date(r.submittedAt).toLocaleString() : "—"}</td>
        <td>${r.email}</td>
        <td>${(r.profile?.name||"—")}</td>
        <td>${(r.profile?.dob||"—")}</td>
        <td>${(r.profile?.address||"—")}</td>
        <td>${(r.profile?.docType||"—")}</td>
        <td style="white-space:nowrap">
          <button class="btn primary" data-kyc="${r.email}" data-status="approved">Approve</button>
          <button class="btn" data-kyc="${r.email}" data-status="rejected">Reject</button>
        </td>
      </tr>
    `).join("");
  }catch(err){
    body.innerHTML = `<tr><td colspan="7">${err.message}</td></tr>`;
  }
}

async function loadSimilarity(){
  const body = document.getElementById("simBody");
  if(!body) return;
  try{
    const data = await api("/api/admin/risk/similarity");
    const rows = data.pairs || [];
    if(rows.length === 0){
      body.innerHTML = `<tr><td colspan="5">No high-similarity pairs.</td></tr>`;
      return;
    }
    body.innerHTML = rows.slice(0,30).map(r => `
      <tr>
        <td>${(r.score*100).toFixed(1)}%</td>
        <td>${r.a}</td>
        <td>${r.b}</td>
        <td>${r.aTrades}</td>
        <td>${r.bTrades}</td>
      </tr>
    `).join("");
  }catch(err){
    body.innerHTML = `<tr><td colspan="5">${err.message}</td></tr>`;
  }
}

document.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-kyc]");
  if(!btn) return;
  const email = btn.getAttribute("data-kyc");
  const status = btn.getAttribute("data-status");
  try{
    await api("/api/admin/kyc/set-status", {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ email, status })
    });
    toast(`KYC ${status}`);
    loadKyc();
    load();
  }catch(err){
    toast(err.message);
  }
});

// extend load wrapper to include KYC & similarity
const __origLoad2 = load;
load = async function(){
  await __origLoad2();
  await loadQueue();
  await loadFlags();
  await loadKyc();
  await loadSimilarity();
};

async function loadAudit(){
  const body = document.getElementById("auditBody");
  if(!body) return;
  try{
    const data = await api("/api/admin/audit?limit=200");
    const rows = data.audit || [];
    if(rows.length === 0){
      body.innerHTML = `<tr><td colspan="6">No audit entries.</td></tr>`;
      return;
    }
    body.innerHTML = rows.map(r => `
      <tr>
        <td>${r.time ? new Date(r.time).toLocaleString() : "—"}</td>
        <td>${r.actor || "admin"}</td>
        <td>${r.action || "—"}</td>
        <td>${r.targetEmail || "—"}</td>
        <td class="muted small">${r.meta ? JSON.stringify(r.meta) : ""}</td>
        <td class="muted small">${r.ip || ""}</td>
      </tr>
    `).join("");
  }catch(err){
    body.innerHTML = `<tr><td colspan="6">${err.message}</td></tr>`;
  }
}

async function loadOps(email){
  const box = document.getElementById("opsCards");
  const status = document.getElementById("opsStatus");
  const detail = document.getElementById("opsDetail");
  const pre = document.getElementById("opsJson");
  if(!box || !status || !pre) return;

  try{
    const data = await api(`/api/admin/account?email=${encodeURIComponent(email)}`);
    const a = data.account;
    box.style.display = "flex";
    const locked = a.lockedUntil && (new Date(a.lockedUntil).getTime() > Date.now());
    status.textContent = `${(a.challengePhase||"challenge").toUpperCase()} • Equity ${money(a.equity)}${a.challengeFailed ? " • FAILED" : ""}${a.frozen ? " • FROZEN" : ""}${locked ? " • LOCKED" : ""}`;
    if(detail){
      detail.textContent = `DD day ${(Number(a.dayDD||0)*100).toFixed(2)}% • trailing ${(Number(a.totalDD||0)*100).toFixed(2)}% • withdrawable ${money(a.withdrawable||0)}`;
    }
    pre.textContent = JSON.stringify(a, null, 2);
  }catch(err){
    toast(err.message);
  }
}

function opsEmail(){
  return (document.getElementById("opsEmail")?.value || "").trim();
}

document.getElementById("opsLoad")?.addEventListener("click", async () => {
  const email = opsEmail();
  if(!email) return toast("Enter an email");
  localStorage.setItem("cp_ops_email", email);
  await loadOps(email);
});

document.getElementById("opsRefresh")?.addEventListener("click", async () => {
  const email = opsEmail() || localStorage.getItem("cp_ops_email") || "";
  if(!email) return toast("Enter an email");
  document.getElementById("opsEmail").value = email;
  await loadOps(email);
  await loadAudit();
});

document.getElementById("opsFreeze")?.addEventListener("click", async () => {
  const email = opsEmail(); if(!email) return;
  try{
    await api("/api/admin/account/freeze", { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ email, frozen:true }) });
    toast("Frozen");
    await loadOps(email); await loadAudit(); await load();
  }catch(err){ toast(err.message); }
});

document.getElementById("opsUnfreeze")?.addEventListener("click", async () => {
  const email = opsEmail(); if(!email) return;
  try{
    await api("/api/admin/account/freeze", { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ email, frozen:false }) });
    toast("Unfrozen");
    await loadOps(email); await loadAudit(); await load();
  }catch(err){ toast(err.message); }
});

document.getElementById("opsUnlockDaily")?.addEventListener("click", async () => {
  const email = opsEmail(); if(!email) return;
  try{
    await api("/api/admin/account/unlock-daily", { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ email }) });
    toast("Unlocked daily lock");
    await loadOps(email); await loadAudit(); await load();
  }catch(err){ toast(err.message); }
});

document.getElementById("opsFlatten")?.addEventListener("click", async () => {
  const email = opsEmail(); if(!email) return;
  const reason = (document.getElementById("opsFlattenReason")?.value || "").trim();
  try{
    await api("/api/admin/account/flatten", { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ email, reason }) });
    toast("Flattened");
    await loadOps(email); await loadAudit(); await load();
  }catch(err){ toast(err.message); }
});

document.getElementById("opsReset")?.addEventListener("click", async () => {
  const email = opsEmail(); if(!email) return;
  if(!confirm("Reset this account to starting equity and clear history?")) return;
  try{
    await api("/api/admin/account/reset", { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ email }) });
    toast("Reset");
    await loadOps(email); await loadAudit(); await load();
  }catch(err){ toast(err.message); }
});

document.getElementById("opsSetPhase")?.addEventListener("click", async () => {
  const email = opsEmail(); if(!email) return;
  const phase = (document.getElementById("opsPhase")?.value || "challenge");
  try{
    await api("/api/admin/account/set-phase", { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ email, phase }) });
    toast("Updated phase");
    await loadOps(email); await loadAudit(); await load();
  }catch(err){ toast(err.message); }
});

// initialize ops email
const savedOps = localStorage.getItem("cp_ops_email");
if(savedOps && document.getElementById("opsEmail")) document.getElementById("opsEmail").value = savedOps;

const __origLoad3 = load;
load = async function(){
  await __origLoad3();
  await loadAudit();
};

async function loadReferrals(){
  const body = document.getElementById("refBody");
  const uses = document.getElementById("refUses");
  if(!body) return;
  try{
    const data = await api("/api/admin/referral/list");
    const refs = data.referrals || [];
    const u = data.uses || [];
    if(refs.length === 0){
      body.innerHTML = `<tr><td colspan="8">No codes yet.</td></tr>`;
    }else{
      body.innerHTML = refs.map(r => `
        <tr>
          <td style="font-family: ui-monospace, SFMono-Regular, Menlo, monospace">${r.code}</td>
          <td>${r.uses || 0}</td>
          <td>${r.maxUses ?? "—"}</td>
          <td>${Number(r.commissionPct||0).toFixed(2)}</td>
          <td>${r.active !== false ? "Yes" : "No"}</td>
          <td>${r.createdAt ? new Date(r.createdAt).toLocaleString() : "—"}</td>
          <td class="muted small">${r.note || ""}</td>
          <td style="white-space:nowrap">
            <button class="btn" data-ref-toggle="${r.code}" data-active="${r.active !== false ? "0":"1"}">${r.active !== false ? "Disable":"Enable"}</button>
          </td>
        </tr>
      `).join("");
    }
    if(uses){
      uses.textContent = u.slice(0,50).map(x => `${x.time} • ${x.code} • ${x.refereeEmail} • plan ${x.planId} • amount $${x.amount} • commission $${x.commission}`).join("\n") || "No uses yet.";
    }
  }catch(err){
    body.innerHTML = `<tr><td colspan="8">${err.message}</td></tr>`;
    if(uses) uses.textContent = "";
  }
}

document.getElementById("refCreate")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = document.getElementById("refCreateMsg");
  if(msg) msg.textContent = "Creating…";
  const code = (document.getElementById("refNewCode")?.value || "").trim();
  const maxUses = (document.getElementById("refMaxUses")?.value || "").trim();
  const commissionPct = (document.getElementById("refCommission")?.value || "").trim();
  const note = (document.getElementById("refNote")?.value || "").trim();
  try{
    const res = await api("/api/admin/referral/create", {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({
        code: code || null,
        maxUses: maxUses ? Number(maxUses) : null,
        commissionPct: commissionPct ? Number(commissionPct) : null,
        note
      })
    });
    if(msg) msg.textContent = `Created ✅ ${res.referral.code}`;
    toast("Referral code created");
    await loadReferrals();
    await loadAudit();
  }catch(err){
    if(msg) msg.textContent = err.message;
    toast(err.message);
  }
});

document.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-ref-toggle]");
  if(!btn) return;
  const code = btn.getAttribute("data-ref-toggle");
  const active = btn.getAttribute("data-active") === "1";
  try{
    await api("/api/admin/referral/set-active", {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ code, active })
    });
    toast(active ? "Enabled" : "Disabled");
    await loadReferrals();
    await loadAudit();
  }catch(err){
    toast(err.message);
  }
});

const __origLoad4 = load;
load = async function(){
  await __origLoad4();
  await loadReferrals();
};
