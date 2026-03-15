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
