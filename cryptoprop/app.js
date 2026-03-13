/* AUTH_GUARD_V1 */

export function setYear(){
  const el = document.getElementById("year");
  if(el) el.textContent = new Date().getFullYear();
}

export function toast(message){
  const t = document.getElementById("toast");
  if(!t) return;
  t.textContent = message;
  t.classList.add("show");
  t.style.display = "block";
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(()=>{ t.classList.remove("show"); t.style.display="none"; }, 3200);
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
  window.location.href = "/auth.html?force=true";
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



export async function apiFetch(url, opts){
  const res = await fetch(url, opts || {});
  if(res.status === 401){ window.location.href = "/auth.html?force=true"; throw new Error("Not authenticated"); }
  return res;
}

export function getSession(){
  try{ return JSON.parse(sessionStorage.getItem("cp_session") || "null"); }catch{ return null; }
}

export function setSession(data){
  sessionStorage.setItem("cp_session", JSON.stringify(data));
}

export async function requireAuth(){
  try{
    const res = await fetch("/api/auth/me");
    const data = await res.json().catch(()=>({}));
    if(!res.ok || !data.user){ window.location.href = "/auth.html?force=true"; return null; }
    setSession(data.user);
    return data.user;
  }catch{
    window.location.href = "/auth.html?force=true";
    return null;
  }
}

export async function logout(){
  try{ await fetch("/api/auth/logout", { method:"POST" }); }catch(e){}
  sessionStorage.removeItem("cp_session");
  window.location.href = "/auth.html?force=true";
}

// Auth guard removed from app.js - handled per-page in dashboard.html
