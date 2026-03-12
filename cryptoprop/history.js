import { apiFetch } from "./app.js";
import { money } from "./app.js";

function pct(x){ return (Number(x||0)*100).toFixed(2) + "%"; }

async function load(){
  const res = await apiFetch("/api/challenge/history", { method:"GET" });
  const data = await res.json();
  const body = document.getElementById("histBody");
  const rows = (data.history || []);

  if(rows.length === 0){
    body.innerHTML = `<tr><td colspan="6">No archived challenges yet.</td></tr>`;
    return;
  }

  body.innerHTML = rows.map(r => {
    const rules = r.rules ? `Tgt ${(r.rules.profitTargetPct*100).toFixed(0)}% • DD ${(r.rules.dailyDDPct*100).toFixed(0)}% • Trail ${(r.rules.trailingDDPct*100).toFixed(0)}%` : "—";
    return `
      <tr>
        <td>${(r.archivedAt || "—").slice(0,10)}</td>
        <td>${money(r.startEquity || 0)}</td>
        <td>${money(r.endEquity || 0)}</td>
        <td>${pct(r.profitPct || 0)}</td>
        <td>${r.tradingDays || 0}</td>
        <td>${rules}</td>
      </tr>
    `;
  }).join("");
}

load().catch(()=>{});
