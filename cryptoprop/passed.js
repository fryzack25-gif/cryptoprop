import { apiFetch } from "./auth.js";
import { money } from "./app.js";

async function load(){
  const res = await apiFetch("/api/account", { method:"GET" });
  const acct = await res.json();
  if(acct.challengeFailed){ window.location.href = "failed.html"; return; }
  if(acct.challengePhase !== "funded"){ window.location.href = "dashboard.html"; return; }

  document.getElementById("meta").textContent = `Funded activated: ${acct.fundedActivatedAt || "—"}`;
  document.getElementById("eligible").textContent = acct.payoutEligibleAt || "—";
  document.getElementById("cap").textContent = money(Number(acct.startEquity||0) * 0.04) + " per week";
}

load().catch(()=>{});
