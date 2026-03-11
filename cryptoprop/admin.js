// admin.js — deferred init, safe null checks throughout

function money(n){
  try{ return new Intl.NumberFormat(undefined,{style:"currency",currency:"USD",maximumFractionDigits:0}).format(n); }
  catch{ return "$"+Math.round(n); }
}
function toast(msg){ console.log("[admin]", msg); }
function key(){ return localStorage.getItem("cp_admin_key") || ""; }

async function api(url, opts={}){
  const headers = opts.headers || {};
  headers["x-admin-key"] = key();
  const res = await fetch(url, { ...opts, headers });
  const data = await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(data.error || "Admin request failed");
  return data;
}

function pct(x){ return (Number(x||0)*100).toFixed(2)+"%"; }
function el(id){ return document.getElementById(id); }

// ── All data loading functions ──

async function loadAccounts(){
  const body = el("acctBody");
  const body2 = el("acctBody2");
  const status = el("status");
  if(status) status.textContent = "Loading…";
  try{
    const data = await api("/api/admin/overview");
    // update stat cards
    if(data.totalAccounts  != null && el("ovTotal"))     el("ovTotal").textContent     = data.totalAccounts;
    if(data.inChallenge    != null && el("ovChallenge")) el("ovChallenge").textContent = data.inChallenge;
    if(data.pendingPayouts != null && el("ovPending"))   el("ovPending").textContent   = data.pendingPayouts;
    if(data.flaggedAccounts!= null && el("ovFlagged"))   el("ovFlagged").textContent   = data.flaggedAccounts;
    const rows = data.accounts || [];
    const html = rows.length === 0
      ? `<tr><td colspan="11" style="text-align:center;padding:20px;color:#5060a0;">No accounts yet.</td></tr>`
      : rows.map(a => `
        <tr>
          <td class="hi">${a.email}</td>
          <td>${a.phase}${a.failed?" <span style='color:#ff6b6b'>(FAILED)</span>":""}</td>
          <td>${money(a.equity)}</td>
          <td>${pct(a.dayDD)}</td>
          <td>${pct(a.totalDD)}</td>
          <td>${money(a.withdrawable)}</td>
          <td>${a.pendingPayouts||0}</td>
          <td>${a.frozen?'<span class="tag tr">Yes</span>':'<span class="tag tg">No</span>'}</td>
          <td style="white-space:nowrap">
            <button class="ab sm" data-freeze="${a.email}" data-state="${a.frozen?"0":"1"}">${a.frozen?"Unfreeze":"Freeze"}</button>
          </td>
        </tr>`).join("");
    if(body)  body.innerHTML  = html;
    if(body2) body2.innerHTML = html;
    if(status) status.textContent = "";
  }catch(err){
    if(status) status.textContent = err.message;
  }
}

async function loadQueue(){
  const body = el("queueBody");
  if(!body) return;
  try{
    const data = await api("/api/admin/payout/pending");
    const rows = data.pending || [];
    body.innerHTML = rows.length === 0
      ? `<tr><td colspan="6" style="text-align:center;padding:20px;color:#5060a0;">No pending payouts.</td></tr>`
      : rows.map(r => `
        <tr>
          <td>${r.time?new Date(r.time).toLocaleString():"—"}</td>
          <td class="hi">${r.email}</td>
          <td>${money(r.amount)}</td>
          <td>${r.period||"—"}</td>
          <td style="font-family:monospace;font-size:.8rem">${r.id}</td>
          <td><button class="ab sm pri" data-approve-email="${r.email}" data-approve-id="${r.id}">Approve</button></td>
        </tr>`).join("");
  }catch(err){
    body.innerHTML = `<tr><td colspan="6" style="color:#ff6b6b">${err.message}</td></tr>`;
  }
}

async function loadFlags(){
  const box = el("flagsBox");
  if(!box) return;
  try{
    const data = await api("/api/admin/risk/flags");
    const dev = data.deviceFlags||[], ips = data.ipFlags||[];
    box.innerHTML =
      (dev.length?`<div style="margin-bottom:10px"><strong>Shared devices (≥2 accounts)</strong><ul style="margin:6px 0 0 18px">${dev.slice(0,20).map(x=>`<li><code>${x.device}</code> → ${x.emails.join(", ")}</li>`).join("")}</ul></div>`:`<div style="color:#5060a0">No shared-device flags.</div>`)
      + (ips.length?`<div style="margin-top:10px"><strong>Shared IPs (≥3 accounts)</strong><ul style="margin:6px 0 0 18px">${ips.slice(0,20).map(x=>`<li><code>${x.ip}</code> → ${x.emails.join(", ")}</li>`).join("")}</ul></div>`:`<div style="color:#5060a0;margin-top:10px">No shared-IP flags.</div>`);
  }catch(err){ if(box) box.textContent = err.message; }
}

async function loadKyc(){
  const body = el("kycBody");
  if(!body) return;
  try{
    const data = await api("/api/admin/kyc/pending");
    const rows = data.pending||[];
    body.innerHTML = rows.length===0
      ? `<tr><td colspan="7" style="text-align:center;padding:20px;color:#5060a0;">No pending KYC.</td></tr>`
      : rows.map(r=>`
        <tr>
          <td>${r.submittedAt?new Date(r.submittedAt).toLocaleString():"—"}</td>
          <td class="hi">${r.email}</td>
          <td>${r.profile?.name||"—"}</td>
          <td>${r.profile?.dob||"—"}</td>
          <td>${r.profile?.address||"—"}</td>
          <td>${r.profile?.docType||"—"}</td>
          <td style="white-space:nowrap">
            <button class="ab sm pri" data-kyc="${r.email}" data-status="approved">Approve</button>
            <button class="ab sm" data-kyc="${r.email}" data-status="rejected">Reject</button>
          </td>
        </tr>`).join("");
  }catch(err){ body.innerHTML=`<tr><td colspan="7" style="color:#ff6b6b">${err.message}</td></tr>`; }
}

async function loadSimilarity(){
  const body = el("simBody");
  if(!body) return;
  try{
    const data = await api("/api/admin/risk/similarity");
    const rows = data.pairs||[];
    body.innerHTML = rows.length===0
      ? `<tr><td colspan="5" style="text-align:center;padding:20px;color:#5060a0;">No high-similarity pairs.</td></tr>`
      : rows.slice(0,30).map(r=>`
        <tr>
          <td>${(r.score*100).toFixed(1)}%</td>
          <td>${r.a}</td><td>${r.b}</td>
          <td>${r.aTrades}</td><td>${r.bTrades}</td>
        </tr>`).join("");
  }catch(err){ body.innerHTML=`<tr><td colspan="5" style="color:#ff6b6b">${err.message}</td></tr>`; }
}

async function loadAudit(){
  const body = el("auditBody");
  if(!body) return;
  try{
    const data = await api("/api/admin/audit?limit=200");
    const rows = data.audit||[];
    body.innerHTML = rows.length===0
      ? `<tr><td colspan="6" style="text-align:center;padding:20px;color:#5060a0;">No audit entries.</td></tr>`
      : rows.map(r=>`
        <tr>
          <td style="white-space:nowrap">${r.time?new Date(r.time).toLocaleString():"—"}</td>
          <td>${r.actor||"admin"}</td>
          <td class="hi">${r.action||"—"}</td>
          <td>${r.targetEmail||"—"}</td>
          <td style="font-size:.78rem">${r.meta?JSON.stringify(r.meta):""}</td>
          <td style="font-size:.78rem">${r.ip||""}</td>
        </tr>`).join("");
  }catch(err){ body.innerHTML=`<tr><td colspan="6" style="color:#ff6b6b">${err.message}</td></tr>`; }
}

async function loadOps(email){
  const box    = el("opsCards");
  const status = el("opsStatus");
  const detail = el("opsDetail");
  const pre    = el("opsJson");
  if(!box||!status||!pre) return;
  try{
    const data = await api(`/api/admin/account?email=${encodeURIComponent(email)}`);
    const a = data.account;
    box.style.display = "";
    const locked = a.lockedUntil && new Date(a.lockedUntil).getTime() > Date.now();
    status.textContent = `${(a.challengePhase||"challenge").toUpperCase()} • ${money(a.equity)}${a.challengeFailed?" • FAILED":""}${a.frozen?" • FROZEN":""}${locked?" • LOCKED":""}`;
    if(detail) detail.textContent = `DD day ${pct(a.dayDD)} • trailing ${pct(a.totalDD)} • withdrawable ${money(a.withdrawable||0)}`;
    pre.textContent = JSON.stringify(a, null, 2);
  }catch(err){ toast(err.message); }
}

async function loadReferrals(){
  const body = el("refBody");
  const uses  = el("refUses");
  if(!body) return;
  try{
    const data = await api("/api/admin/referral/list");
    const refs = data.referrals||[], u = data.uses||[];
    body.innerHTML = refs.length===0
      ? `<tr><td colspan="8" style="text-align:center;padding:20px;color:#5060a0;">No codes yet.</td></tr>`
      : refs.map(r=>`
        <tr>
          <td style="font-family:monospace">${r.code}</td>
          <td>${r.uses||0}</td>
          <td>${r.maxUses??"—"}</td>
          <td>${Number(r.commissionPct||0).toFixed(2)}</td>
          <td>${r.active!==false?'<span class="tag tg">Yes</span>':'<span class="tag tr">No</span>'}</td>
          <td style="white-space:nowrap">${r.createdAt?new Date(r.createdAt).toLocaleString():"—"}</td>
          <td style="font-size:.8rem">${r.note||""}</td>
          <td><button class="ab sm" data-ref-toggle="${r.code}" data-active="${r.active!==false?"0":"1"}">${r.active!==false?"Disable":"Enable"}</button></td>
        </tr>`).join("");
    if(uses) uses.textContent = u.slice(0,50).map(x=>`${x.time} • ${x.code} • ${x.refereeEmail} • plan ${x.planId} • $${x.amount} • commission $${x.commission}`).join("\n")||"No uses yet.";
  }catch(err){ body.innerHTML=`<tr><td colspan="8" style="color:#ff6b6b">${err.message}</td></tr>`; }
}

// ── Load all data ──
async function loadAll(){
  await Promise.allSettled([
    loadAccounts(), loadQueue(), loadFlags(),
    loadKyc(), loadSimilarity(), loadAudit(), loadReferrals()
  ]);
}

// ── Expose for gate unlock in admin.html ──
window.adminInit = function(){
  loadAll();
  el("refresh")?.addEventListener("click", loadAll);

  // Approve form
  el("approveForm")?.addEventListener("submit", async e => {
    e.preventDefault();
    const msg = el("approveMsg");
    if(msg) msg.textContent = "Approving…";
    try{
      const email = el("payEmail")?.value.trim();
      const id    = el("payId")?.value.trim();
      await api("/api/admin/payout/approve",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email,id})});
      if(msg) msg.textContent = "Approved ✅";
      await loadAll();
    }catch(err){ if(msg) msg.textContent = err.message; }
  });

  // Referral create
  el("refCreate")?.addEventListener("submit", async e => {
    e.preventDefault();
    const msg = el("refCreateMsg");
    if(msg) msg.textContent = "Creating…";
    try{
      const res = await api("/api/admin/referral/create",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({
        code: el("refNewCode")?.value.trim()||null,
        maxUses: el("refMaxUses")?.value ? Number(el("refMaxUses").value) : null,
        commissionPct: el("refCommission")?.value ? Number(el("refCommission").value) : null,
        note: el("refNote")?.value.trim()||""
      })});
      if(msg) msg.textContent = `Created ✅ ${res.referral?.code||""}`;
      await loadReferrals();
    }catch(err){ if(msg) msg.textContent = err.message; }
  });

  // Ops buttons
  el("opsLoad")?.addEventListener("click", async()=>{
    const email = el("opsEmail")?.value.trim();
    if(!email) return;
    localStorage.setItem("cp_ops_email", email);
    await loadOps(email);
  });
  el("opsRefresh")?.addEventListener("click", async()=>{
    const email = el("opsEmail")?.value.trim()||localStorage.getItem("cp_ops_email")||"";
    if(!email) return;
    if(el("opsEmail")) el("opsEmail").value = email;
    await loadOps(email);
  });
  el("opsFreeze")?.addEventListener("click",       async()=>{ const e=el("opsEmail")?.value.trim(); if(!e) return; try{ await api("/api/admin/account/freeze",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:e,frozen:true})});  await loadOps(e); await loadAll(); }catch(err){ toast(err.message); }});
  el("opsUnfreeze")?.addEventListener("click",     async()=>{ const e=el("opsEmail")?.value.trim(); if(!e) return; try{ await api("/api/admin/account/freeze",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:e,frozen:false})}); await loadOps(e); await loadAll(); }catch(err){ toast(err.message); }});
  el("opsUnlockDaily")?.addEventListener("click",  async()=>{ const e=el("opsEmail")?.value.trim(); if(!e) return; try{ await api("/api/admin/account/unlock-daily",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:e})}); await loadOps(e); await loadAll(); }catch(err){ toast(err.message); }});
  el("opsFlatten")?.addEventListener("click",      async()=>{ const e=el("opsEmail")?.value.trim(); if(!e) return; const reason=el("opsFlattenReason")?.value.trim()||""; try{ await api("/api/admin/account/flatten",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:e,reason})}); await loadOps(e); await loadAll(); }catch(err){ toast(err.message); }});
  el("opsReset")?.addEventListener("click",        async()=>{ const e=el("opsEmail")?.value.trim(); if(!e) return; if(!confirm("Reset this account?")) return; try{ await api("/api/admin/account/reset",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:e})}); await loadOps(e); await loadAll(); }catch(err){ toast(err.message); }});
  el("opsSetPhase")?.addEventListener("click",     async()=>{ const e=el("opsEmail")?.value.trim(); if(!e) return; const phase=el("opsPhase")?.value||"challenge"; try{ await api("/api/admin/account/set-phase",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:e,phase})}); await loadOps(e); await loadAll(); }catch(err){ toast(err.message); }});

  // Restore saved ops email
  const savedOps = localStorage.getItem("cp_ops_email");
  if(savedOps && el("opsEmail")) el("opsEmail").value = savedOps;

  // Global click delegation
  document.addEventListener("click", async e => {
    // Approve payout from queue
    const appBtn = e.target.closest("button[data-approve-email]");
    if(appBtn){ const email=appBtn.getAttribute("data-approve-email"), id=appBtn.getAttribute("data-approve-id"); try{ await api("/api/admin/payout/approve",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email,id})}); await loadAll(); }catch(err){ toast(err.message); } return; }
    // Freeze from table
    const frzBtn = e.target.closest("button[data-freeze]");
    if(frzBtn){ const email=frzBtn.getAttribute("data-freeze"), frozen=frzBtn.getAttribute("data-state")==="1"; try{ await api("/api/admin/account/freeze",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email,frozen})}); await loadAll(); }catch(err){ toast(err.message); } return; }
    // KYC approve/reject
    const kycBtn = e.target.closest("button[data-kyc]");
    if(kycBtn){ const email=kycBtn.getAttribute("data-kyc"), status=kycBtn.getAttribute("data-status"); try{ await api("/api/admin/kyc/set-status",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email,status})}); await loadKyc(); await loadAll(); }catch(err){ toast(err.message); } return; }
    // Referral toggle
    const refBtn = e.target.closest("button[data-ref-toggle]");
    if(refBtn){ const code=refBtn.getAttribute("data-ref-toggle"), active=refBtn.getAttribute("data-active")==="1"; try{ await api("/api/admin/referral/set-active",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({code,active})}); await loadReferrals(); }catch(err){ toast(err.message); } return; }
  });
};
