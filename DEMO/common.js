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

// ต้องตรงกับ API_VERSION ใน gas/Entities.gs — แนบไปกับคำสั่งเขียนที่ใช้ชื่อ area/branch
// (ชื่อ branch เปลี่ยนความหมายจาก พื้นที่ -> สาขา backend จึงต้องแยกหน้าเว็บรุ่นเก่าออก)
const FT_API_VERSION = 2;
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

// GAS ปกติตอบใน 1.5-3 วิ — เกินนี้มาก = ค้าง (DB ไม่ตอบ / GAS เกินเวลา) ไม่ใช่แค่ช้า
// ไม่มี timeout = ผู้ใช้เห็นโครงหน้าโหลดค้างไปเรื่อยๆ จนเบราว์เซอร์ตัดเองเป็น "Failed to fetch"
const FT_TIMEOUT_READ = 25e3;
const FT_TIMEOUT_WRITE = 60e3;   // สร้าง PDF ใช้เวลานานกว่า และห้ามตัดเร็วเกินจนผู้ใช้กดซ้ำ

// ยิง 1 ครั้ง -> JSON · แปลง error ดิบของเบราว์เซอร์ ("Failed to fetch") เป็นสาเหตุที่ผู้ใช้เข้าใจ
// GAS ที่พัง/เกินเวลาตอบเป็นหน้า HTML ไม่มี header CORS เบราว์เซอร์จึงรายงานแค่ "Failed to fetch"
// คำสั่งที่ใช้ Google Drive อยู่ที่ GAS เสมอ — ที่เหลือไป Worker ถ้าตั้ง WORKER_API_URL ใน config.js ไว้
const FT_GAS_ONLY = { generateDocument: true, createTicket: true, deleteTempPdf: true };
const ftWorkerUrl = () => (typeof WORKER_API_URL !== 'undefined' && WORKER_API_URL) || '';
const ftApiUrl = (action) => (ftWorkerUrl() && !FT_GAS_ONLY[action]) ? ftWorkerUrl() : GAS_API_URL;

// เปิดการเชื่อมต่อไป Worker ล่วงหน้าระหว่างรอ LIFF init (ของ GAS ใส่ไว้ใน <head> ทุกหน้าแล้ว)
if (ftWorkerUrl() && typeof document !== 'undefined') {
  try {
    const l = document.createElement('link');
    l.rel = 'preconnect';
    l.href = new URL(ftWorkerUrl(), location.href).origin;
    l.crossOrigin = '';
    document.head.appendChild(l);
  } catch (e) { /* URL ผิดรูปแบบ — ข้ามไป ตอนเรียกจริงจะขึ้นหน้าสถานะเอง */ }
}

async function ftFetchJson_(body, timeoutMs, url) {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await fetch(url || GAS_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body,
      signal: ctrl ? ctrl.signal : undefined
    });
    if (!res.ok) throw ftErr('เซิร์ฟเวอร์ตอบ HTTP ' + res.status, 'server');
    const text = await res.text();
    try { return JSON.parse(text); }
    catch (e) { throw ftErr('เซิร์ฟเวอร์ตอบกลับไม่ใช่ข้อมูล (อาจเกิดข้อผิดพลาดฝั่งระบบ) — ลองใหม่อีกครั้ง', 'server'); }
  } catch (e) {
    if (e.name === 'AbortError') {
      const err = ftErr('ระบบตอบช้าเกิน ' + Math.round(timeoutMs / 1000) + ' วินาที — ลองใหม่อีกครั้ง', 'timeout');
      err.ftTimeout = true;
      throw err;
    }
    if (e instanceof TypeError) {
      throw navigator.onLine === false
        ? ftErr('ไม่มีการเชื่อมต่ออินเทอร์เน็ต', 'offline')
        : ftErr('เชื่อมต่อระบบไม่สำเร็จ (เซิร์ฟเวอร์ไม่ตอบกลับ) — ลองใหม่อีกครั้ง', 'network');
    }
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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
  if (!idToken) throw ftErr('ไม่มี LINE ID Token — ยังไม่ได้ login หรือ LIFF app ไม่ได้เปิด scope "openid"', 'nologin');
  const body = JSON.stringify({ action, idToken, data: data || {} });
  const read = ftIsReadAction(action);
  let json;
  // คำสั่งอ่านลองซ้ำได้ 1 ครั้งเมื่อเน็ต/เซิร์ฟเวอร์สะดุด · คำสั่งเขียนห้ามลองซ้ำเอง (แจ้งซ่อมซ้ำ 2 ใบ)
  for (let attempt = 1; ; attempt++) {
    try {
      json = await ftFetchJson_(body, read ? FT_TIMEOUT_READ : FT_TIMEOUT_WRITE, ftApiUrl(action));
      break;
    } catch (e) {
      if (log) log(action + ' attempt ' + attempt + ' failed: ' + e.message);
      if (!read || attempt >= 2 || e.ftTimeout) throw e;
      await new Promise(r => setTimeout(r, 800));
    }
  }
  // token หมดอายุ / ถูก revoke — ข้อความเป็น fallback สำหรับ backend เวอร์ชันก่อนมี code
  const authFailed = json && json.status === 'error' &&
    (json.code === 'AUTH_INVALID' || (!json.code && /ยืนยันตัวตน LINE/.test(json.message || '')));
  if (authFailed) {
    if (ftIsReadAction(action) && !(opts && opts.noRelogin) && ftRelogin()) throw ftErr('กำลังเข้าสู่ระบบใหม่…', 'auth');
    throw ftErr(FT_AUTH_EXPIRED_MSG, 'auth');
  }
  try { sessionStorage.removeItem(FT_RELOGIN_KEY); } catch (e) {}
  return json;
}

// ---------- โครงสร้างหน่วยงาน (ภาค -> พื้นที่ -> สาขา) ----------
// เรียงตามผังของหน่วยงาน: ระดับบนสุด (ภาค 9) ก่อน แล้วตามชื่อ · สาขาเรียงตามชื่อเต็ม
// เทียบแบบรหัสตัวอักษร ไม่ใช้ localeCompare — ผังของหน่วยงานเรียงแบบนี้ "สาขาเมือง..." จึงอยู่ท้ายกลุ่ม
// และแถวสำนักงานพื้นที่ (ชื่อ = ชื่อพื้นที่) ขึ้นก่อนสาขาของตัวเองเสมอ เพราะเป็นคำนำหน้าของชื่อสาขา
const ftCmpName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const ftSortOffices = (list) => [...(list || [])].sort((a, b) => (!!a.parentId - !!b.parentId) || ftCmpName(a, b));
const ftSortBranches = (list) => [...(list || [])].sort(ftCmpName);
// ชื่อเต็มยาวมากบนการ์ด/ตาราง — ตัดคำนำหน้าที่ซ้ำทุกแถวออก ("พื้นที่ตรัง สาขากันตัง")
const ftShortOrg = (s) => String(s || '').replace(/^สำนักงานสรรพสามิต/, '');

// ---------- ไอคอน (Lucide v0.460.0, ISC License — https://lucide.dev) ----------
// ฝัง SVG ไว้ในไฟล์ ไม่โหลดจาก CDN: ไม่ต้องรอ request เพิ่ม และใช้ใน template ที่ render ซ้ำได้เลย
// stroke = currentColor -> สีตามตัวหนังสือรอบข้าง (เมนูที่เลือกอยู่เป็นสีน้ำเงินเอง)
// ใช้ใน JS: icon('pencil', 'w-4 h-4') · ใน HTML: <span data-icon="pencil" data-icon-class="w-4 h-4"></span>
const FT_ICONS = {
  'arrow-right': '<path d="M5 12h14" /><path d="m12 5 7 7-7 7" />',
  'camera': '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" /><circle cx="12" cy="13" r="3" />',
  'check': '<path d="M20 6 9 17l-5-5" />',
  'chevron-left': '<path d="m15 18-6-6 6-6" />',
  'chevron-right': '<path d="m9 18 6-6-6-6" />',
  'chevron-up': '<path d="m18 15-6-6-6 6" />',
  'circle-alert': '<circle cx="12" cy="12" r="10" /><line x1="12" x2="12" y1="8" y2="12" /><line x1="12" x2="12.01" y1="16" y2="16" />',
  'circle-check': '<circle cx="12" cy="12" r="10" /><path d="m9 12 2 2 4-4" />',
  'clipboard-list': '<rect width="8" height="4" x="8" y="2" rx="1" ry="1" /><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /><path d="M12 11h4" /><path d="M12 16h4" /><path d="M8 11h.01" /><path d="M8 16h.01" />',
  'copy': '<rect width="14" height="14" x="8" y="8" rx="2" ry="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />',
  'clock': '<circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />',
  'cloud-off': '<path d="m2 2 20 20" /><path d="M5.782 5.782A7 7 0 0 0 9 19h8.5a4.5 4.5 0 0 0 1.307-.193" /><path d="M21.532 16.5A4.5 4.5 0 0 0 17.5 10h-1.79A7.008 7.008 0 0 0 10 5.07" />',
  'database': '<ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M3 5V19A9 3 0 0 0 21 19V5" /><path d="M3 12A9 3 0 0 0 21 12" />',
  'download': '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" x2="12" y1="15" y2="3" />',
  'external-link': '<path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />',
  'file-text': '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /><path d="M10 9H8" /><path d="M16 13H8" /><path d="M16 17H8" />',
  'flame': '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" />',
  'inbox': '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12" /><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />',
  'layout-dashboard': '<rect width="7" height="9" x="3" y="3" rx="1" /><rect width="7" height="5" x="14" y="3" rx="1" /><rect width="7" height="9" x="14" y="12" rx="1" /><rect width="7" height="5" x="3" y="16" rx="1" />',
  'loader-circle': '<path d="M21 12a9 9 0 1 1-6.219-8.56" />',
  'map-pin': '<path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0" /><circle cx="12" cy="10" r="3" />',
  'lock': '<rect width="18" height="11" x="3" y="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />',
  'phone': '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />',
  'pencil': '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" /><path d="m15 5 4 4" />',
  'plus': '<path d="M5 12h14" /><path d="M12 5v14" />',
  'refresh-cw': '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M8 16H3v5" />',
  'rotate-ccw': '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" />',
  'save': '<path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" /><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7" /><path d="M7 3v4a1 1 0 0 0 1 1h7" />',
  'shield-alert': '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" /><path d="M12 8v4" /><path d="M12 16h.01" />',
  'settings':'<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" /><circle cx="12" cy="12" r="3" />',
  'sliders-horizontal': '<line x1="21" x2="14" y1="4" y2="4" /><line x1="10" x2="3" y1="4" y2="4" /><line x1="21" x2="12" y1="12" y2="12" /><line x1="8" x2="3" y1="12" y2="12" /><line x1="21" x2="16" y1="20" y2="20" /><line x1="12" x2="3" y1="20" y2="20" /><line x1="14" x2="14" y1="2" y2="6" /><line x1="8" x2="8" y1="10" y2="14" /><line x1="16" x2="16" y1="18" y2="22" />',
  'square-kanban': '<rect width="18" height="18" x="3" y="3" rx="2" /><path d="M8 7v7" /><path d="M12 7v4" /><path d="M16 7v9" />',
  'timer': '<line x1="10" x2="14" y1="2" y2="2" /><line x1="12" x2="15" y1="14" y2="11" /><circle cx="12" cy="14" r="8" />',
  'trash-2': '<path d="M3 6h18" /><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" /><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" /><line x1="10" x2="10" y1="11" y2="17" /><line x1="14" x2="14" y1="11" y2="17" />',
  'triangle-alert': '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" /><path d="M12 9v4" /><path d="M12 17h.01" />',
  'user': '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />',
  'user-x': '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><line x1="17" x2="22" y1="8" y2="13" /><line x1="22" x2="17" y1="8" y2="13" />',
  'users': '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />',
  'wrench': '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />',
  'wifi-off': '<path d="M12 20h.01" /><path d="M8.5 16.429a5 5 0 0 1 7 0" /><path d="M5 12.859a10 10 0 0 1 5.17-2.69" /><path d="M19 12.859a10 10 0 0 0-2.007-1.523" /><path d="M2 8.82a15 15 0 0 1 4.177-2.643" /><path d="M22 8.82a15 15 0 0 0-11.288-3.764" /><path d="m2 2 20 20" />',
  'x': '<path d="M18 6 6 18" /><path d="m6 6 12 12" />'
};

function icon(name, cls) {
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
    ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"' +
    ' class="shrink-0 ' + (cls || 'w-4 h-4') + '">' + (FT_ICONS[name] || '') + '</svg>';
}

// เติม SVG ให้ <span data-icon="..."> ที่เขียนไว้ใน HTML
function ftHydrateIcons(root) {
  (root || document).querySelectorAll('[data-icon]').forEach(el => {
    el.innerHTML = icon(el.dataset.icon, el.dataset.iconClass);
    el.removeAttribute('data-icon');
  });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => ftHydrateIcons());
else ftHydrateIcons();

// ---------- Toast / Dialog (แทน alert / confirm ของเบราว์เซอร์) ----------
// alert()/confirm() หน้าตาไม่เข้ากับระบบ ใส่ไอคอนไม่ได้ และในแอป LINE ขึ้นหัวเป็นชื่อโดเมน
// toast = แจ้งผลที่ไม่ต้องตอบ · ftConfirm = ถามยืนยัน คืน Promise<boolean>
const FT_TOAST_STYLE = {
  info:    { icon: 'circle-alert',   cls: 'bg-slate-800 text-white' },
  success: { icon: 'circle-check',   cls: 'bg-emerald-600 text-white' },
  error:   { icon: 'triangle-alert', cls: 'bg-red-600 text-white' },
};

function ftToast(message, type, ms) {
  let box = $('ftToastBox');
  if (!box) {
    box = document.createElement('div');
    box.id = 'ftToastBox';
    box.setAttribute('role', 'status');
    box.setAttribute('aria-live', 'polite');
    // ชิดบน ไม่ใช่ล่าง — ล่างจอคือปุ่มหลัก (สร้างเอกสาร/ยืนยัน/ดูสถานะ) และแถบเมนู ถ้าวางล่างจะบังปุ่มพอดี
    box.className = 'fixed inset-x-0 z-[200] flex flex-col items-center gap-2 px-4 pointer-events-none';
    box.style.top = 'calc(0.75rem + env(safe-area-inset-top, 0px))';
    document.body.appendChild(box);
  }
  const st = FT_TOAST_STYLE[type] || FT_TOAST_STYLE.info;
  const el = document.createElement('div');
  el.className = 'pointer-events-auto max-w-md w-full sm:w-auto flex items-start gap-2 rounded-xl px-4 py-3 text-sm shadow-lg ' +
    'transition-all duration-200 opacity-0 -translate-y-2 ' + st.cls;
  el.innerHTML = icon(st.icon, 'w-5 h-5 mt-px') + '<span class="whitespace-pre-line break-words">' + escapeHtml(message) + '</span>';
  el.addEventListener('click', () => dismiss());
  box.appendChild(el);
  requestAnimationFrame(() => el.classList.remove('opacity-0', '-translate-y-2'));
  // ข้อความยาว/ข้อผิดพลาดค้างนานกว่า ให้อ่านทัน
  const t = setTimeout(dismiss, ms || (type === 'error' ? 6000 : 3500) + Math.min(4000, message.length * 30));
  function dismiss() {
    clearTimeout(t);
    el.classList.add('opacity-0', '-translate-y-2');
    setTimeout(() => el.remove(), 200);
  }
}

// opts: { title, confirmText, cancelText, danger, icon }
function ftConfirm(message, opts) {
  opts = opts || {};
  return new Promise(resolve => {
    const prevFocus = document.activeElement;
    const wrap = document.createElement('div');
    wrap.className = 'fixed inset-0 z-[210] bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-4';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    const tone = opts.danger ? 'bg-red-50 text-red-600' : 'bg-brand-50 text-brand-600';
    const okCls = opts.danger ? 'bg-red-600 hover:bg-red-700' : 'bg-brand-600 hover:bg-brand-700';
    wrap.innerHTML = `
      <div class="bg-white rounded-t-2xl sm:rounded-xl w-full max-w-md shadow-2xl" style="padding-bottom:env(safe-area-inset-bottom,0px)">
        <div class="p-5 flex gap-3">
          <span class="w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${tone}">${icon(opts.icon || (opts.danger ? 'triangle-alert' : 'circle-alert'), 'w-5 h-5')}</span>
          <div class="min-w-0 pt-1.5">
            ${opts.title ? `<div class="font-bold text-slate-800">${escapeHtml(opts.title)}</div>` : ''}
            <div class="text-sm text-slate-600 mt-1 whitespace-pre-line break-words">${escapeHtml(message)}</div>
          </div>
        </div>
        <div class="px-4 sm:px-5 pb-5 flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
          ${opts.cancelText === null ? '' : `<button data-r="0" class="px-4 py-3 sm:py-2 rounded-lg text-sm font-medium text-slate-600 hover:bg-slate-100">${escapeHtml(opts.cancelText || 'ยกเลิก')}</button>`}
          <button data-r="1" class="px-4 py-3 sm:py-2 rounded-lg text-sm font-bold text-white ${okCls}">${escapeHtml(opts.confirmText || 'ตกลง')}</button>
        </div>
      </div>`;
    const done = (v) => {
      document.removeEventListener('keydown', onKey);
      wrap.remove();
      if (prevFocus && prevFocus.focus) prevFocus.focus();
      resolve(v);
    };
    const onKey = (e) => { if (e.key === 'Escape') done(false); };
    wrap.addEventListener('click', (e) => {
      const b = e.target.closest('[data-r]');
      if (b) done(b.dataset.r === '1');
      else if (e.target === wrap) done(false);
    });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(wrap);
    wrap.querySelector('[data-r="1"]').focus();
  });
}

// แจ้งเตือนที่ผู้ใช้ต้องอ่านก่อนไปต่อ (มีปุ่มเดียว)
const ftAlert = (message, opts) => ftConfirm(message, Object.assign({ cancelText: null }, opts));

async function ftCopy(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    ftToast('คัดลอก' + (label || '') + 'แล้ว', 'success');
  } catch (e) {
    ftToast('คัดลอกไม่ได้บนเบราว์เซอร์นี้ — กดค้างที่ข้อความเพื่อคัดลอกเอง', 'info');
  }
}

/* ---------- หน้าสถานะ "โหลดไม่สำเร็จ" ----------------------------------------
   แทนการโชว์ข้อมูลตัวอย่าง (เดิม) — ของปลอมทำให้คนเข้าใจผิดว่าระบบใช้ได้/ข้อมูลเป็นปัจจุบัน
   แยกสาเหตุให้ผู้ใช้รู้ว่าต้องทำอะไรต่อ: รอเน็ต / ลองใหม่ / login ใหม่ / ขอสิทธิ์ / แจ้งผู้ดูแล
   ข้อความดิบจากระบบพับไว้ใต้ "รายละเอียดสำหรับผู้ดูแลระบบ" (ในแอป LINE เปิด console ไม่ได้ นี่คือทางเดียวที่จะรู้สาเหตุจริง)
   ---------------------------------------------------------------------------- */
function ftErr(message, kind) {
  const e = new Error(message);
  e.ftKind = kind;
  return e;
}

// tone: warn = ปัญหาชั่วคราว (เน็ต/ช้า) · danger = ระบบพัง · brand = ผู้ใช้ทำต่อเองได้ (login/สิทธิ์)
const FT_ERR = {
  offline:   { icon: 'wifi-off',       tone: 'warn',   title: 'ไม่มีการเชื่อมต่ออินเทอร์เน็ต',
               hint: 'ตรวจ Wi-Fi หรือเน็ตมือถือ — กลับมาออนไลน์เมื่อไหร่ หน้านี้จะโหลดใหม่ให้เอง' },
  timeout:   { icon: 'clock',          tone: 'warn',   title: 'ระบบตอบช้ากว่าปกติ',
               hint: 'เซิร์ฟเวอร์อาจกำลังเริ่มทำงาน รอสักครู่แล้วกดลองใหม่ · ถ้ายังเป็นหลายครั้ง แจ้งผู้ดูแลระบบ (ฐานข้อมูลอาจถูกพักการใช้งาน)' },
  network:   { icon: 'cloud-off',      tone: 'warn',   title: 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้',
               hint: 'ลองใหม่อีกครั้ง · ถ้ายังไม่ได้ แจ้งผู้ดูแลระบบ' },
  auth:      { icon: 'lock',           tone: 'brand',  title: 'เซสชันหมดอายุ',
               hint: 'เข้าสู่ระบบ LINE ใหม่เพื่อใช้งานต่อ', login: 'เข้าสู่ระบบใหม่' },
  nologin:   { icon: 'lock',           tone: 'brand',  title: 'ยังไม่ได้เข้าสู่ระบบ LINE',
               hint: 'เปิดหน้านี้ผ่านแอป LINE หรือกดเข้าสู่ระบบ', login: 'เข้าสู่ระบบ LINE' },
  // liff.init / ID Token พังตอนเปิดหน้า (ส่วนใหญ่ LIFF ID ใน config.js ไม่ตรง) — ลองใหม่ = โหลดหน้าใหม่
  liff:      { icon: 'circle-alert',   tone: 'danger', title: 'เชื่อมต่อ LINE ไม่สำเร็จ',
               hint: 'ปิดหน้านี้แล้วเปิดใหม่จากเมนูในแอป LINE · ถ้ายังเป็น แจ้งผู้ดูแลระบบพร้อมรายละเอียดด้านล่าง' },
  noaccount: { icon: 'user-x',         tone: 'brand',  title: 'ยังไม่มีบัญชีนี้ในระบบ',
               hint: 'แจ้งซ่อมผ่านฟอร์มอย่างน้อย 1 ครั้งเพื่อสร้างบัญชี แล้วส่ง LINE ID ด้านล่างให้แอดมินตั้งบทบาท', showId: true },
  forbidden: { icon: 'shield-alert',   tone: 'brand',  title: 'บัญชีนี้ไม่มีสิทธิ์เข้าหน้านี้',
               hint: 'ถ้าต้องใช้งาน ส่ง LINE ID ด้านล่างให้แอดมินตั้งบทบาทที่เมนูผู้ใช้งาน', showId: true },
  outdated:  { icon: 'refresh-cw',     tone: 'brand',  title: 'หน้าเว็บกับระบบเป็นคนละเวอร์ชัน',
               hint: 'ปิดหน้านี้แล้วเปิดใหม่ · ถ้ายังเป็น แจ้งผู้ดูแลระบบให้ติดตั้งระบบให้ครบทั้งสองส่วน' },
  server:    { icon: 'triangle-alert', tone: 'danger', title: 'ระบบขัดข้อง โหลดข้อมูลไม่สำเร็จ',
               hint: 'ลองใหม่อีกครั้ง · ถ้ายังไม่ได้ แจ้งผู้ดูแลระบบพร้อมรายละเอียดด้านล่าง' },
};

// ประเภทของ error — ที่มาจากการเชื่อมต่อ ftFetchJson_/ftCallBackend ติด ftKind มาแล้ว
// ที่เหลือเป็นข้อความจาก backend (ACL / เวอร์ชัน) จึงจับจากข้อความ — ไม่มีอะไรตรง = ระบบขัดข้อง
function ftErrorKind(e) {
  if (e && e.ftKind) return e.ftKind;
  const m = String((e && e.message) || e || '');
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'offline';
  if (m === FT_AUTH_EXPIRED_MSG || /ยืนยันตัวตน|ID Token|เข้าสู่ระบบใหม่/.test(m)) return 'auth';
  if (/ไม่พบบัญชีในระบบ/.test(m)) return 'noaccount';                 // ACL: role = null
  if (/ไม่มีสิทธิ์/.test(m)) return 'forbidden';
  if (/ไม่พบคำสั่ง Action|เวอร์ชันเก่า/.test(m)) return 'outdated';   // หน้าเว็บใหม่กว่า/เก่ากว่า GAS
  return 'server';
}

// วาดหน้าสถานะลงใน el · opts: { onRetry, onLogin, lineId, where, title: {kind: 'หัวข้อเฉพาะหน้านี้'} }
function ftErrorState(el, e, opts) {
  opts = opts || {};
  const kind = ftErrorKind(e);
  const c = FT_ERR[kind];
  const tone = {
    warn:   'bg-amber-50 text-amber-600 ring-amber-100',
    danger: 'bg-red-50 text-red-600 ring-red-100',
    brand:  'bg-brand-50 text-brand-600 ring-brand-100',
  }[c.tone];
  const title = (opts.title && opts.title[kind]) || c.title;
  const msg = String((e && e.message) || e || '-');
  const detail = 'สาเหตุ: ' + msg + '\nประเภท: ' + kind + '\nหน้า: ' + (opts.where || location.pathname) +
                 '\nเวลา: ' + new Date().toLocaleString('th-TH');
  const login = c.login && opts.onLogin;
  const btn = 'inline-flex items-center justify-center gap-2 px-4 py-2.5 min-h-[44px] rounded-xl text-sm font-semibold transition-colors';
  el.innerHTML = `
    <div class="flex flex-col items-center text-center max-w-md mx-auto py-8 md:py-12 px-2" role="alert">
      <span class="w-16 h-16 rounded-full ring-8 flex items-center justify-center ${tone}">${icon(c.icon, 'w-7 h-7')}</span>
      <h2 class="mt-5 text-lg font-semibold text-slate-800">${escapeHtml(title)}</h2>
      <p class="mt-1.5 text-sm leading-relaxed text-slate-500">${escapeHtml(c.hint)}</p>
      ${c.showId && opts.lineId ? `
        <div class="mt-4 inline-flex items-center gap-2 max-w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs">
          <span class="text-slate-500 shrink-0">LINE ID</span>
          <code class="font-mono text-slate-700 break-all text-left">${escapeHtml(opts.lineId)}</code>
          <button type="button" data-err="copy-id" class="shrink-0 text-slate-400 hover:text-brand-600 p-1 -m-1 rounded" aria-label="คัดลอก LINE ID">${icon('copy', 'w-4 h-4')}</button>
        </div>` : ''}
      <div class="mt-5 flex flex-wrap items-center justify-center gap-2">
        ${login ? `<button type="button" data-err="login" class="${btn} bg-brand-600 text-white hover:bg-brand-700">${escapeHtml(c.login)}</button>` : ''}
        ${opts.onRetry ? `<button type="button" data-err="retry" class="${btn} ${login ? 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-50' : 'bg-brand-600 text-white hover:bg-brand-700'}">${icon('refresh-cw', 'w-4 h-4')}ลองใหม่</button>` : ''}
      </div>
      <div class="mt-3 text-[11px] text-slate-400">ลองโหลดล่าสุด ${new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })} น.</div>
      <details class="mt-5 w-full text-left">
        <summary class="text-xs text-slate-500 cursor-pointer select-none text-center">รายละเอียดสำหรับผู้ดูแลระบบ</summary>
        <pre class="mt-2 text-[11px] leading-relaxed whitespace-pre-wrap break-words rounded-xl border border-slate-200 bg-slate-50 p-3 text-slate-600">${escapeHtml(detail)}</pre>
        <button type="button" data-err="copy-detail" class="mt-2 inline-flex items-center gap-1.5 text-xs text-slate-500 hover:text-brand-600">${icon('copy', 'w-3.5 h-3.5')}คัดลอกรายละเอียด</button>
      </details>
    </div>`;
  el.querySelectorAll('[data-err]').forEach(b => b.addEventListener('click', () => {
    const a = b.dataset.err;
    if (a === 'copy-id') ftCopy(opts.lineId, ' LINE ID ');
    if (a === 'copy-detail') ftCopy(detail, 'รายละเอียด');
    if (a === 'login') opts.onLogin();
    if (a === 'retry') {
      b.disabled = true;   // กันกดซ้ำระหว่างรอ — ตัวโหลดจะวาดหน้านี้ใหม่ (หรือแสดงข้อมูล) เอง
      b.innerHTML = icon('refresh-cw', 'w-4 h-4 animate-spin') + 'กำลังลองใหม่…';
      opts.onRetry();
    }
  }));
  return kind;
}

// ---------- Skeleton (โครงหน้าระหว่างโหลด แทนวงกลมหมุน) ----------
// ผู้ใช้เห็นรูปร่างของสิ่งที่จะมา = รู้สึกรอน้อยกว่า และหน้าไม่กระโดดตอนข้อมูลมาถึง
const ftBar = (w, h) => `<div class="animate-pulse bg-slate-200 rounded ${h || 'h-3'} ${w}"></div>`;
function ftSkeleton(kind, n) {
  const one = {
    card: `<div class="bg-white rounded-xl border border-slate-100 p-4 space-y-2.5">
             <div class="flex justify-between">${ftBar('w-16', 'h-4')}${ftBar('w-14', 'h-4')}</div>
             ${ftBar('w-full')}${ftBar('w-2/3')}
             <div class="pt-1">${ftBar('w-24')}</div></div>`,
    row:  `<div class="flex items-center gap-3 py-3">${ftBar('w-8 shrink-0')}<div class="flex-1 space-y-1.5">${ftBar('w-1/2')}${ftBar('w-1/3', 'h-2.5')}</div>${ftBar('w-12 shrink-0')}</div>`,
  }[kind];
  return Array.from({ length: n || 3 }, () => one).join('');
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

// วันที่แบบไทยสั้น: "12 ต.ค. 69 · 14:30 น." (withTime false = ไม่มีเวลา)
function ftDate(iso, withTime) {
  const t = parseT(iso);
  if (t == null) return '';
  const d = new Date(t);
  const day = d.toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit' });
  return withTime === false ? day : day + ' · ' + d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }) + ' น.';
}

// ไม่เกิน 7 วัน "3 ชม.ที่แล้ว" อ่านเร็วกว่า · เก่ากว่านั้น "47 วันก่อน" ต้องนับย้อนเอง -> บอกเป็นวันที่
function ftWhen(iso) {
  const t = parseT(iso);
  if (t == null) return '';
  return Date.now() - t < 7 * 864e5 ? timeAgo(iso) : ftDate(iso, false);
}

// ลิงก์ไฟล์ Drive (แชร์แบบมีลิงก์) -> URL ภาพย่อที่ใส่ <img> ได้ตรงๆ · '' ถ้าไม่ใช่ลิงก์ Drive
function ftDriveThumb(url, width) {
  const m = String(url || '').match(/[-\w]{25,}/);
  return m ? 'https://drive.google.com/thumbnail?id=' + m[0] + '&sz=w' + (width || 800) : '';
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
