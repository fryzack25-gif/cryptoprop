/* AUTH_GUARD_V1 */

export function setYear(){
  const el = document.getElementById("year");
  if(el) el.textContent = new Date().getFullYear();
}

export function toast(message){
  const t = document.getElementById("toast");
  if(!t) return;
  t.textContent = message;
  t.style.display = "block";
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(()=>{ t.style.display="none"; }, 3200);
}

export function qs(id){ return document.getElementById(id); }

export function money(n){
  try{
    return new Intl.NumberFormat(undefined, { style:"currency", currency:"USD", maximumFractionDigits:0 }).format(n);
  }catch{
    return "$" + Math.round(n).toString();
  }
}

export function fmtDate(iso){
  try{
    const d = new Date(iso);
    return d.toLocaleString();
  }catch{
    return iso;
  }
}

// Referral code apply (index page)
document.addEventListener("click", async (e) => {
  const btn = e.target.closest("#applyRef");
  if(!btn) return;
  const code = (document.getElementById("refCode")?.value || "").trim();
  const msg = document.getElementById("refMsg");
  if(msg) msg.textContent = "Applying…";
  try{
    const res = await fetch("/api/referral/apply", {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ code })
    });
    const data = await res.json().catch(()=> ({}));
    if(!res.ok) throw new Error(data.error || "Failed");
    if(msg) msg.textContent = `Applied ✅ (${data.referredBy})`;
  }catch(err){
    if(msg) msg.textContent = err.message;
  }
});


document.addEventListener("click", async (e) => {
  const btn = e.target.closest("#logoutBtn");
  if(!btn) return;
  try{ await fetch("/api/auth/logout", { method:"POST" }); }catch(e){}
  window.location.href = "/auth.html";
});


async function acceptTermsIfChecked(){
  const cb = document.getElementById("termsCheckbox");
  if(!cb) return true;
  if(!cb.checked){
    alert("You must agree to the Terms & Conditions before continuing.");
    return false;
  }
  try{
    const res = await fetch("/api/terms/accept", {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ accept:true })
    });
    const data = await res.json().catch(()=> ({}));
    if(!res.ok) throw new Error(data.error || "Unable to record acceptance");
    return true;
  }catch(err){
    alert(err.message);
    return false;
  }
}

document.addEventListener("click", async (e) => {
  const btn = e.target.closest(".btn.primary");
  if(!btn) return;
  if(document.getElementById("termsCheckbox")){
    const ok = await acceptTermsIfChecked();
    if(!ok){
      e.preventDefault();
      e.stopPropagation();
    }
  }
});


async function requireLoginIfNeeded(){
  const path = window.location.pathname;
  const publicPaths = ["/", "/index.html", "/auth.html", "/terms.html", "/risk.html", "/privacy.html", "/kyc.html", "/payout.html", "/admin.html", "/support.html", "/reset-password.html"];
  if(publicPaths.includes(path)) return;
  try{
    const res = await fetch("/api/auth/me");
    const data = await res.json().catch(()=>({}));
    if(!data.user) window.location.href = "/auth.html";
  }catch(e){
    window.location.href = "/auth.html";
  }
}
requireLoginIfNeeded();
