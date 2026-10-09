/* =============================================================================
   FAST TICKET · ApiRouter.gs — ทางเข้าเดียวของ backend: doPost -> ตรวจสิทธิ์ -> use case
   -----------------------------------------------------------------------------
   วิธี deploy: วางทุกไฟล์ใน gas/ ทับในโปรเจกต์ Apps Script (Code.gs ไม่อยู่ใน git — ไม่ต้องแตะ)
     ⚠️ ลบไฟล์ AdminApi.gs เดิมออกจากโปรเจกต์ ไม่งั้นฟังก์ชันซ้ำกันและตัวเก่าอาจทับตัวใหม่
     Deploy → Manage deployments → ✏️ → Version: "New version" → Deploy
   Script Property ที่ต้องมี: LIFF_CHANNEL_ID = Channel ID ของ LINE Login channel

   🔒 AUTH: config.js เป็น public repo -> ใครก็เห็น GAS URL แล้วยิง curl ตรงได้ การเช็คสิทธิ์ฝั่ง
      client เป็นแค่ UX ปลอมกันไม่ได้ จึงต้อง verify ที่ server: client แนบ LIFF ID Token (JWT ที่
      LINE เซ็น ปลอมไม่ได้) -> ถาม LINE ว่าของจริงไหม -> ได้ userId ตัวจริง -> เทียบ USER.Role กับ ACL
   ============================================================================= */

// สิทธิ์ต่อ action — '*' = แค่ login พอ (รวมผู้ใช้ที่ยังไม่มีใน USER เช่นคนแจ้งซ่อมครั้งแรก)
const ACL = {
  generateDocument:       ['*'],
  createTicket:           ['*'],
  deleteTempPdf:          ['*'],
  getMyTickets:           ['*'],
  getMasterData:          ['*'],
  getTickets:             ['IT', 'Admin'],
  acceptTicket:           ['IT', 'Admin'],
  updateTicketStatus:     ['IT', 'Admin'],
  getKnowledgeBase:       ['IT', 'Admin'],
  addKnowledgeArticle:    ['IT', 'Admin'],
  updateKnowledgeArticle: ['IT', 'Admin'],
  deleteKnowledgeArticle: ['IT', 'Admin'],
  getMyProfile:           ['IT', 'Admin'],
  deleteTicket:           ['Admin'],
  getUsers:               ['Admin'],
  updateUserRole:         ['Admin'],
  addMasterItem:          ['Admin'],
  updateMasterItem:       ['Admin'],
  deleteMasterItem:       ['Admin']
};

function jsonOutput(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return ContentService.createTextOutput('✅ API is running! (ระบบหลังบ้าน FAST TICKET พร้อมทำงาน)')
    .setMimeType(ContentService.MimeType.TEXT);
}

function doPost(e) {
  try {
    const request = JSON.parse(e.postData.contents);
    // สร้างในฟังก์ชัน (ไม่ใช่ const ระดับบนสุด) — use case อยู่คนละไฟล์ ต้องรอโหลดครบก่อน
    const handlers = {
      generateDocument: generateDocument,
      createTicket: createTicket,
      deleteTempPdf: deleteTempPdf,
      getTickets: getTickets,
      acceptTicket: acceptTicket,
      updateTicketStatus: updateTicketStatus,
      deleteTicket: deleteTicket,
      getUsers: getUsers,
      updateUserRole: updateUserRole,
      getKnowledgeBase: getKnowledgeBase,
      addKnowledgeArticle: addKnowledgeArticle,
      updateKnowledgeArticle: updateKnowledgeArticle,
      deleteKnowledgeArticle: deleteKnowledgeArticle,
      getMyProfile: getMyProfile,
      getMyTickets: getMyTickets,
      getMasterData: getMasterData,
      addMasterItem: addMasterItem,
      updateMasterItem: updateMasterItem,
      deleteMasterItem: deleteMasterItem
    };
    const handler = handlers[request.action];
    if (!handler) return jsonOutput(fail_('ไม่พบคำสั่ง Action: ' + request.action));

    const auth = authorize_(request.action, request.idToken);
    if (!auth.ok) return jsonOutput(fail_(auth.message, auth.code));

    // ส่งตัวตนที่ verify แล้ว (auth) เป็น arg ที่ 2 — use case ใช้ auth.userId ไม่เชื่อ client
    const result = handler(request.data, auth);
    // เขียนข้อมูลสำเร็จ -> แคชผลอ่านทั้งหมด (cachedRead_) ใช้ไม่ได้ทันที
    if (result && result.status === 'success' && !/^get/.test(request.action) && !NO_DATA_CHANGE[request.action]) {
      bumpDataVersion_();
    }
    return jsonOutput(result);
  } catch (error) {
    return jsonOutput(fail_(error.toString()));
  } finally {
    closeRequestConn_();   // connection เดียวของ request นี้ (ดู Infrastructure.gs)
  }
}

// คำสั่งที่ไม่ใช่ get* แต่ไม่แตะข้อมูลใน DB — ไม่ต้องล้างแคชผลอ่าน
const NO_DATA_CHANGE = { generateDocument: true, deleteTempPdf: true };

/* ---------------------------------------------------------------------------
   แคชระดับสคริปต์ (cache_() อยู่ใน Infrastructure.gs)
   - ผลตรวจ token: เก็บจนกว่า token หมดอายุจริง (เช็ค exp ทุกครั้งที่ใช้) — ตัดการยิงถาม LINE ~0.3-0.5 วิ
   - Role: 5 นาทีพอ — แคชหลุดก็แค่ query เดียวบน connection ที่ request เปิดอยู่แล้ว
     ห้ามยืดยาว: ลดสิทธิ์ตรงใน Supabase (ไม่ผ่าน updateUserRole) สิทธิ์เดิมจะค้างได้นานเท่า TTL
   --------------------------------------------------------------------------- */
const CACHE_TTL_TOKEN_MAX = 21600;   // วินาที (เพดานของ CacheService)
const CACHE_TTL_ROLE      = 300;

// ไม่ใช้ token ทั้งใบเป็น key: ยาวเกิน 250 ตัวอักษรที่ CacheService รับ และไม่ควรเก็บของดิบ
function tokenKey_(idToken) {
  const d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, idToken);
  return 'tk_' + Utilities.base64Encode(d);
}

// ถาม LINE ว่า idToken ของจริงไหม — คืน { ok, userId }
function verifyIdToken_(idToken) {
  if (!idToken) return { ok: false };

  // แคชช่วยข้าม "การยิงถาม" เท่านั้น ไม่ได้ยืดอายุ token — วันหมดอายุยังเช็คเองทุกครั้ง
  const key = tokenKey_(idToken);
  const hit = cache_().get(key);
  if (hit) {
    const c = JSON.parse(hit);
    if (c.exp && (Number(c.exp) * 1000) > Date.now()) return { ok: true, userId: c.sub };
    cache_().remove(key);
    return { ok: false };
  }

  const channelId = PropertiesService.getScriptProperties().getProperty('LIFF_CHANNEL_ID');
  if (!channelId) throw new Error('ยังไม่ได้ตั้ง Script Property: LIFF_CHANNEL_ID');

  const res = UrlFetchApp.fetch('https://api.line.me/oauth2/v2.1/verify', {
    method: 'post',
    payload: { id_token: idToken, client_id: channelId },  // form-urlencoded อัตโนมัติ
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) return { ok: false };   // token ผิด/หมดอายุ/ผิด channel

  const p = JSON.parse(res.getContentText());
  if (String(p.aud) !== String(channelId)) return { ok: false };          // ของ channel เราจริง
  if (p.exp && (Number(p.exp) * 1000) < Date.now()) return { ok: false };  // กันเหนียวเรื่องหมดอายุ

  // เก็บแค่ sub/exp ไม่เก็บตัว token · อายุแคช = เวลาที่ token เหลือ (อย่างน้อย 60 วิ ไม่เกินเพดาน)
  const ttl = Math.max(60, Math.min(CACHE_TTL_TOKEN_MAX, Math.floor(Number(p.exp || 0) - Date.now() / 1000)));
  cache_().put(key, JSON.stringify({ sub: p.sub, exp: p.exp }), ttl);
  return { ok: true, userId: p.sub };   // sub = LINE userId ตัวจริง
}

// 'Staff'/'IT'/'Admin' หรือ null (ไม่มีใน USER / DB ล่ม -> fail-closed)
function getUserRole_(userId) {
  const key = 'role_' + userId;
  const hit = cache_().get(key);
  if (hit !== null && hit !== undefined) return hit === '-' ? null : hit;   // '-' = ไม่มีบัญชีในระบบ

  const r = withConn_(function (conn) { return { role: findUserRole_(conn, userId) }; });
  // DB error -> withConn_ คืน {status:'error'} ไม่มี field role -> null (fail-closed)
  // และ "ห้ามแคช" กรณีนี้ ไม่งั้น DB สะดุดแวบเดียวจะทำให้ผู้ใช้ถูกปฏิเสธยาว 5 นาที
  if (!r || typeof r.role === 'undefined') return null;

  cache_().put(key, r.role || '-', CACHE_TTL_ROLE);
  return r.role;
}

// ต้องเรียกทุกครั้งที่แก้ Role ไม่งั้นสิทธิ์ใหม่จะยังไม่มีผลจนกว่าแคชจะหมดอายุ
function invalidateRoleCache_(userId) {
  if (userId) cache_().remove('role_' + userId);
}

// ประตูหลัก: verify token + เช็ค ACL — คืน { ok, userId, role } หรือ { ok:false, code, message }
function authorize_(action, idToken) {
  const allowed = ACL[action];
  if (!allowed) return { ok: false, message: 'ไม่พบคำสั่ง Action: ' + action };

  const v = verifyIdToken_(idToken);
  // code ให้ client ตัดสินใจ login ใหม่ได้โดยไม่ต้องจับคำในข้อความภาษาไทย
  if (!v.ok) return { ok: false, code: 'AUTH_INVALID', message: 'ยืนยันตัวตน LINE ไม่สำเร็จ กรุณาเข้าสู่ระบบใหม่' };

  if (allowed.indexOf('*') !== -1) return { ok: true, userId: v.userId, role: null };   // แค่ login พอ

  const role = getUserRole_(v.userId);
  if (allowed.indexOf(role) === -1) {
    return { ok: false, message: 'บัญชีนี้ไม่มีสิทธิ์ทำรายการนี้ (' + (role || 'ไม่พบบัญชีในระบบ') + ')' };
  }
  return { ok: true, userId: v.userId, role: role };
}
