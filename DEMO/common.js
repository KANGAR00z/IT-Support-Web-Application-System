/* =============================================================================
   FAST TICKET · common.js — helper กลางที่ index.html และ admin.html ใช้ร่วมกัน
   -----------------------------------------------------------------------------
   ไฟล์นี้ต้องถูกโหลด "ก่อน" สคริปต์ของแต่ละหน้า และห้ามประกาศชื่อซ้ำในหน้า
   (const ระดับบนสุดแชร์ global lexical scope ข้าม <script> — ประกาศซ้ำ = SyntaxError)
   ============================================================================= */

const $ = (id) => document.getElementById(id);

// ---------- Backend ----------
// POST เป็น text/plain "โดยตั้งใจ" เพื่อให้เป็น CORS simple request — GAS ไม่ตอบ
// preflight (OPTIONS) การเปลี่ยนเป็น application/json จะทำให้ทุก request พัง
// log เป็น optional: index.html ส่ง logDebug เข้ามาเพื่อโชว์ใน debug panel
//
// 🔒 แนบ LIFF ID Token ทุก request — backend เอาไป verify กับ LINE เพื่อยืนยันตัวตน
//    (JWT เซ็นลายเซ็นแล้ว ปลอมไม่ได้) จึง "ไม่ต้องส่ง userId จาก client" อีก backend
//    รู้เองว่าใครยิงจาก token getIDToken() คืน null ถ้ายังไม่ init/login -> backend ปฏิเสธ
const FT_AUTH_EXPIRED_MSG = 'เซสชัน LINE หมดอายุ กรุณาเข้าสู่ระบบใหม่';
const FT_RELOGIN_KEY = 'ft_relogin_at';
const FT_RELOGIN_COOLDOWN = 2 * 60e3;

// liff.getIDToken() ไม่ต่ออายุเอง ต้อง logout แล้ว login ใหม่ถึงจะได้ใบใหม่
// กันวนลูป: ถ้าเพิ่งลองไปภายใน 2 นาทีแล้วยังไม่ผ่าน (เช่น channel ตั้งผิด) ให้หยุดแล้วโชว์ error แทน
// คืน true = กำลังเด้งออกจากหน้านี้ · force = ผู้ใช้กดปุ่มเอง ไม่ต้องเช็ค cooldown
function ftRelogin(force) {
  try {
    const last = Number(sessionStorage.getItem(FT_RELOGIN_KEY) || 0);
    if (!force && Date.now() - last < FT_RELOGIN_COOLDOWN) return false;
    sessionStorage.setItem(FT_RELOGIN_KEY, String(Date.now()));
    if (liff.isLoggedIn()) liff.logout();
    // ในแอป LINE เรียก liff.login() ไม่ได้ — reload แล้ว liff.init จะขอ token ใหม่ให้เอง
    if (liff.isInClient()) location.reload();
    else liff.login({ redirectUri: location.href });
    return true;
  } catch (e) { return false; }
}

// อ่านอย่างเดียว (get*) เด้ง login ใหม่ได้เลยไม่เสียอะไร
// แต่คำสั่งเขียน (createTicket ฯลฯ) ห้ามเด้งเอง — ฟอร์มที่กรอกไว้/การกระทำจะหายเงียบๆ ให้หน้าจอบอกผู้ใช้แทน
const ftIsReadAction = (action) => /^get/.test(action);

// opts.noRelogin = ห้ามเด้ง login เองแม้เป็นคำสั่งอ่าน (เช่นโหลดเบื้องหลังในหน้าที่มีฟอร์มกรอกค้างอยู่)
// ไม่เช็ควันหมดอายุ token ฝั่งเครื่อง — นาฬิกามือถือเพี้ยนจะทำให้ token ใหม่ถูกมองว่าหมดอายุตลอด
// ให้ server (เวลาถูกต้อง) เป็นคนตัดสินอย่างเดียว
async function ftCallBackend(action, data, log, opts) {
  if (log) log('Sending payload to ' + action);
  let idToken = null;
  try { if (typeof liff !== 'undefined' && liff.getIDToken) idToken = liff.getIDToken(); } catch (e) { /* ยังไม่ login */ }
  // ตัดจบตั้งแต่ที่นี่ถ้าไม่มี token — ACL ฝั่ง backend ไม่มี action ไหนเปิดให้ไม่ login เลย
  // ยิงไปก็โดนปฏิเสธด้วยข้อความกลางๆ 'ยืนยันตัวตน LINE ไม่สำเร็จ' ซึ่งแยกสาเหตุไม่ออก
  // getIDToken() คืน null ได้ 2 กรณี: (1) liff.init() ยังไม่เสร็จ หรือยังไม่ login
  //                                 (2) LIFF app ไม่ได้เปิด scope "openid" ใน LINE console
  //     — กรณี (2) หลอกมาก เพราะ getProfile() ยังได้ชื่อ/รูปตามปกติ (นั่นคือ scope "profile")
  //       เห็นชื่อตัวเองมุมขวาบนจึงไม่ได้แปลว่ามี ID Token
  if (!idToken) throw new Error('ไม่มี LINE ID Token — ยังไม่ได้ login หรือ LIFF app ไม่ได้เปิด scope "openid"');
  const res = await fetch(GAS_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action, idToken, data: data || {} })
  });
  if (!res.ok) throw new Error('เซิร์ฟเวอร์ตอบ HTTP ' + res.status);
  const json = await res.json();
  // token หมดอายุ / ถูก revoke — ข้อความเป็น fallback สำหรับ backend เวอร์ชันก่อนมี code
  const authFailed = json && json.status === 'error' &&
    (json.code === 'AUTH_INVALID' || (!json.code && /ยืนยันตัวตน LINE/.test(json.message || '')));
  if (authFailed) {
    if (ftIsReadAction(action) && !(opts && opts.noRelogin) && ftRelogin()) throw new Error('กำลังเข้าสู่ระบบใหม่…');
    throw new Error(FT_AUTH_EXPIRED_MSG);
  }
  try { sessionStorage.removeItem(FT_RELOGIN_KEY); } catch (e) {}
  return json;
}

// ---------- ข้อความ ----------
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

// ลบ emoji/สัญลักษณ์ (เอกสารราชการห้ามมี emoji และคีย์สีหมวดหมู่ไม่มี emoji)
function stripEmoji(s) {
  return String(s)
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200D}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// "💻 ฮาร์ดแวร์ (Hardware)" -> "ฮาร์ดแวร์"
// ใช้ทั้งกับ option ในฟอร์มแจ้งซ่อม และกับ ISSUE_CATEGORY.Category_Name จาก DB
function cleanCategory(s) {
  return stripEmoji(s).replace(/\s*\([A-Za-z\s]+\)\s*/g, '').trim();
}

// ---------- เวลา ----------
// คืน epoch ms หรือ null ถ้า parse ไม่ได้ (backend normalize เป็น ISO แล้ว แต่กันไว้)
const parseT = (iso) => { if (!iso) return null; const t = new Date(iso).getTime(); return isNaN(t) ? null : t; };

function timeAgo(iso) {
  if (!iso) return '';
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return 'เมื่อสักครู่';
  if (diff < 3600) return Math.floor(diff / 60) + ' นาทีที่แล้ว';
  if (diff < 86400) return Math.floor(diff / 3600) + ' ชม.ที่แล้ว';
  const d = Math.floor(diff / 86400);
  return d === 1 ? 'เมื่อวาน' : d + ' วันก่อน';
}

// ระยะเวลาแบบอ่านง่าย: "45 นาที" / "3.2 ชม." / "1.5 วัน"
function fmtDur(ms) {
  if (ms == null || !isFinite(ms) || ms < 0) return '—';
  const m = ms / 60000;
  if (m < 60) return Math.round(m) + ' นาที';
  const h = m / 60;
  if (h < 24) return (h < 10 ? h.toFixed(1) : Math.round(h)) + ' ชม.';
  const d = h / 24;
  return (d < 10 ? d.toFixed(1) : Math.round(d)) + ' วัน';
}

const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
