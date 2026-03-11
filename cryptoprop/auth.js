async function post(url, body){
  const res = await fetch(url, {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify(body||{})
  });
  const data = await res.json().catch(()=> ({}));
  if(!res.ok) throw new Error(data.error || "Request failed");
  return data;
}
function show(id, on){
  const el = document.getElementById(id);
  if(el) el.style.display = on ? "" : "none";
}
document.getElementById("tabLogin")?.addEventListener("click", () => { show("loginBox", true); show("signupBox", false); });
document.getElementById("tabSignup")?.addEventListener("click", () => { show("loginBox", false); show("signupBox", true); });
document.getElementById("signupBtn")?.addEventListener("click", async () => {
  const email = document.getElementById("signupEmail")?.value || "";
  const password = document.getElementById("signupPass")?.value || "";
  const confirm = document.getElementById("signupConfirm")?.value || "";
  const msg = document.getElementById("signupMsg");
  if(password !== confirm){ if(msg) msg.textContent = "Passwords do not match."; return; }
  if(password.length < 8){ if(msg) msg.textContent = "Password must be at least 8 characters."; return; }
  if(msg) msg.textContent = "Creating…";
  try{
    const data = await post("/api/auth/signup", { email, password });
    if(msg) msg.textContent = "Created ✅ Check your email for a verification code.";
    show("verifyBox", true);
    const vc = document.getElementById("verifyCode");
    if(vc && data.verifyCode) vc.value = data.verifyCode;
  }catch(e){ if(msg) msg.textContent = e.message; }
});
document.getElementById("verifyBtn")?.addEventListener("click", async () => {
  const email = document.getElementById("signupEmail")?.value || "";
  const code = document.getElementById("verifyCode")?.value || "";
  const msg = document.getElementById("verifyMsg");
  if(msg) msg.textContent = "Verifying…";
  try{ await post("/api/auth/verify-email", { email, code }); if(msg) msg.textContent = "Verified ✅ You can log in now."; }
  catch(e){ if(msg) msg.textContent = e.message; }
});
document.getElementById("forgotLink")?.addEventListener("click", (e) => {
  e.preventDefault();
  show("loginBox", false); show("signupBox", false); show("forgotBox", true);
});
document.getElementById("backToLogin")?.addEventListener("click", (e) => {
  e.preventDefault();
  show("forgotBox", false); show("loginBox", true);
});
document.getElementById("forgotBtn")?.addEventListener("click", async () => {
  const email = document.getElementById("forgotEmail")?.value || "";
  const msg = document.getElementById("forgotMsg");
  if(!email){ if(msg) msg.textContent = "Please enter your email."; return; }
  if(msg) msg.textContent = "Sending…";
  try{
    await post("/api/auth/forgot-password", { email });
    if(msg) msg.textContent = "If an account exists, a reset link has been sent to your email.";
  }catch(e){ if(msg) msg.textContent = e.message; }
});
document.getElementById("loginBtn")?.addEventListener("click", async () => {
  const email = document.getElementById("loginEmail")?.value || "";
  const password = document.getElementById("loginPass")?.value || "";
  const msg = document.getElementById("loginMsg");
  if(msg) msg.textContent = "Signing in…";
  try{ await post("/api/auth/login", { email, password }); window.location.href = "/dashboard.html"; }
  catch(e){ if(msg) msg.textContent = e.message; }
});
document.getElementById("adminBtn")?.addEventListener("click", async () => {
  const adminKey = document.getElementById("adminKey")?.value || "";
  const msg = document.getElementById("adminMsg");
  if(msg) msg.textContent = "Elevating…";
  try{ await post("/api/auth/admin-elevate", { adminKey }); if(msg) msg.textContent = "Admin enabled ✅ Redirecting…"; window.location.href = "/admin.html"; }
  catch(e){ if(msg) msg.textContent = e.message; }
});
(async function(){ try{ const res = await fetch("/api/auth/me"); const data = await res.json(); if(data.user) window.location.href = "/dashboard.html"; }catch(e){} })();
