import { apiFetch } from "./app.js";
import { money, toast } from "./app.js";

async function load(){
  const res = await apiFetch("/api/account", { method: "GET" });
  const acct = await res.json();

  const reason = document.getElementById("reason");
  reason.textContent = acct.failReason || (acct.challengeFailed ? "Challenge failed." : "Not failed.");

  document.getElementById("startEq").textContent = money(Number(acct.startEquity || 0));
  document.getElementById("eq").textContent = money(Number(acct.equity || 0));
  document.getElementById("dayDD").textContent = ((Number(acct.dayDD || 0) * 100).toFixed(2)) + "%";
  document.getElementById("totalDD").textContent = ((Number(acct.totalDD || 0) * 100).toFixed(2)) + "%";
}

document.getElementById("resetBtn").addEventListener("click", async () => {
  try{
    const res = await apiFetch("/api/account/reset", { method: "POST" });
    const data = await res.json();
    toast("Challenge reset ✅");
    window.location.href = "dashboard.html";
  }catch(err){
    toast(err.message || "Reset failed");
  }
});

load().catch(()=>{});

async function loadRetryOffer(){
  try{
    const res = await fetch("/api/account");
    const acct = await res.json();
    const box = document.getElementById("retryOfferBox");
    const txt = document.getElementById("retryOfferText");
    if(!box || !txt) return;
    if(acct.retryOffer && acct.retryOffer.eligible){
      box.style.display = "block";
      txt.textContent = `Retry your ${acct.retryOffer.planId} challenge for $${acct.retryOffer.discounted} (normally $${acct.retryOffer.original}). This is a ONE-TIME offer.`;
    }else{
      box.style.display = "none";
    }
  }catch(e){}
}

document.addEventListener("click", async (e) => {
  const btn = e.target.closest("#buyRetry");
  if(!btn) return;
  const msg = document.getElementById("retryMsg");
  if(msg) msg.textContent = "Processing…";
  try{
    const res = await fetch("/api/plan/retry-offer", { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({}) });
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || "Failed");
    if(msg) msg.textContent = "Success ✅ Redirecting…";
    window.location.href = "/paper.html";
  }catch(err){
    if(msg) msg.textContent = err.message;
  }
});

loadRetryOffer();
