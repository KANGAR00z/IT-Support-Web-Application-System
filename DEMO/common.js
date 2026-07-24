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
async function ftCallBackend(action, data, log) {
  if (log) log('Sending payload to ' + action);
  let idToken = null;
  try { if (typeof liff !== 'undefined' && liff.getIDToken) idToken = liff.getIDToken(); } catch (e) { /* ยังไม่ login */ }
  const res = await fetch(GAS_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action, idToken, data: data || {} })
  });
  if (!res.ok) throw new Error('เซิร์ฟเวอร์ตอบ HTTP ' + res.status);
  return await res.json();
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
