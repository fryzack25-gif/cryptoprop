// Lightweight device fingerprint (non-unique, privacy-respecting) for anti-abuse.
// This is NOT a guarantee of uniqueness and can be spoofed.
export async function getDeviceId(){
  const key = "cp_device_id_v1";
  const existing = localStorage.getItem(key);
  if(existing) return existing;

  const parts = [
    navigator.userAgent || "",
    navigator.language || "",
    String(screen.width || 0),
    String(screen.height || 0),
    String(screen.colorDepth || 0),
    Intl.DateTimeFormat().resolvedOptions().timeZone || "",
    String(navigator.hardwareConcurrency || 0),
    String(navigator.platform || "")
  ].join("|");

  const enc = new TextEncoder().encode(parts);
  const hashBuf = await crypto.subtle.digest("SHA-256", enc);
  const hashArr = Array.from(new Uint8Array(hashBuf));
  const hex = hashArr.map(b => b.toString(16).padStart(2,"0")).join("").slice(0, 32); // 128-bit hex
  localStorage.setItem(key, hex);
  return hex;
}
