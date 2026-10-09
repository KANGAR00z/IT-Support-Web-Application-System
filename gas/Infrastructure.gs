/* =============================================================================
   FAST TICKET · Infrastructure.gs — ชั้นนอกสุด: ฐานข้อมูล (JDBC) + Google Drive / PDF
   getDbConnection() อยู่ใน Code.gs (มีรหัส DB — ไม่อยู่ใน git)
   ============================================================================= */

// -----------------------------------------------------------------------------
// Connection เดียวต่อ request
// DB อยู่โตเกียว (Supabase ap-northeast-1) แต่ GAS รันใน data center ของ Google ฝั่งอเมริกา
// การเปิด connection ใหม่ (TCP + TLS + login) จึงกิน ~0.7-1.5 วิ — เดิมเปิด 2 รอบต่อ request
// (อ่าน role รอบหนึ่ง + handler อีกรอบ) ตอนนี้เปิดครั้งแรกที่มีคนขอ แล้วใช้ร่วมจนจบ request
// doPost เรียก closeRequestConn_() ใน finally เสมอ · ทุก execution ของ GAS มี global แยกกัน
// ตามสเปก JDBC ปิด Connection = ปิด Statement/ResultSet ที่เปิดจากมันทั้งหมด จึงไม่ต้องปิดรายตัว
// -----------------------------------------------------------------------------
let REQ_CONN_ = null;

function closeRequestConn_() {
  if (!REQ_CONN_) return;
  try { REQ_CONN_.close(); } catch (e) { /* ปิดไม่ได้ก็ทิ้งไป */ }
  REQ_CONN_ = null;
}

// เรียก fn ด้วย connection ของ request นี้ + แปลง exception เป็น error response
// error = ทิ้ง connection (อาจเสียกลางทาง) ครั้งถัดไปเปิดใหม่
function withConn_(fn) {
  try {
    if (!REQ_CONN_) REQ_CONN_ = getDbConnection();
    return fn(REQ_CONN_);
  } catch (error) {
    closeRequestConn_();
    return fail_(error.toString());
  }
}

// เหมือน withConn_ แต่ทุกคำสั่งใน fn สำเร็จพร้อมกันหรือไม่สำเร็จเลย
// fn คืน status 'error' (เช่นตรวจแล้วไม่ผ่าน) = rollback ด้วย
// คืน autocommit ทุกครั้ง — connection ถูกใช้ต่อในคำสั่งถัดไปของ request เดียวกัน
function withTx_(fn) {
  return withConn_(function (conn) {
    conn.setAutoCommit(false);
    try {
      const result = fn(conn);
      if (result && result.status === 'error') conn.rollback(); else conn.commit();
      return result;
    } catch (error) {
      conn.rollback();
      throw error;
    } finally {
      conn.setAutoCommit(true);
    }
  });
}

// -----------------------------------------------------------------------------
// แคชระดับสคริปต์ (CacheService) — ใช้ร่วมกันทุก execution ไม่ผูกกับผู้ใช้
// -----------------------------------------------------------------------------
function cache_() { return CacheService.getScriptCache(); }

const READ_CACHE_TTL = 600;          // วินาที — เพดานความค้างถ้ามีคนแก้ตรงใน Supabase (ไม่ผ่านระบบ)
const CACHE_CHUNK = 90000;           // CacheService รับค่าละไม่เกิน 100KB -> แบ่งก้อน
const DATA_VER_KEY = 'data_ver';

// เลขเวอร์ชันข้อมูล — ทุกคำสั่งเขียนที่สำเร็จเปลี่ยนเลขนี้ (bumpDataVersion_ ใน doPost)
// แคชของผลอ่านผูกกับเลขนี้ในชื่อ key: เขียนเมื่อไหร่ แคชเก่าทั้งหมดใช้ไม่ได้ทันทีโดยไม่ต้องไล่ลบ
function dataVersion_() {
  let v = cache_().get(DATA_VER_KEY);
  if (!v) { v = String(Date.now()); cache_().put(DATA_VER_KEY, v, 21600); }
  return v;
}

function bumpDataVersion_() {
  cache_().put(DATA_VER_KEY, String(Date.now()) + '_' + Math.floor(Math.random() * 1e6), 21600);
}

// เก็บ object แบบ gzip + base64 (ข้อความไทยซ้ำๆ บีบได้ ~5-8 เท่า) แบ่งก้อนถ้าใหญ่
function cachePutObj_(key, obj, ttl) {
  try {
    const gz = Utilities.gzip(Utilities.newBlob(JSON.stringify(obj), 'application/json'));
    const s = Utilities.base64Encode(gz.getBytes());
    const parts = {};
    let n = 0;
    for (let i = 0; i < s.length; i += CACHE_CHUNK) parts[key + '#' + (n++)] = s.substring(i, i + CACHE_CHUNK);
    parts[key] = String(n);
    cache_().putAll(parts, ttl);
  } catch (e) { /* แคชเป็นของแถม — ใหญ่เกิน/โควตาเต็มก็แค่ไม่แคช */ }
}

function cacheGetObj_(key) {
  try {
    const n = parseInt(cache_().get(key), 10);
    if (!n) return null;
    const keys = [];
    for (let i = 0; i < n; i++) keys.push(key + '#' + i);
    const got = cache_().getAll(keys);
    let s = '';
    for (let i = 0; i < n; i++) {
      if (!got[keys[i]]) return null;   // บางก้อนหลุดจากแคชไปแล้ว -> ถือว่าไม่มี
      s += got[keys[i]];
    }
    const blob = Utilities.newBlob(Utilities.base64Decode(s), 'application/x-gzip');
    return JSON.parse(Utilities.ungzip(blob).getDataAsString('UTF-8'));
  } catch (e) { return null; }
}

// ผลอ่านที่แคชได้: key ผูกเลขเวอร์ชันข้อมูล · แคชเฉพาะผลที่สำเร็จ
// name ต้องแยกตามผู้ใช้เองถ้าผลต่างกันตามคน (เช่น 'my_' + userId) · เรียกหลังผ่าน ACL แล้วเท่านั้น
// READ_CACHE_PREFIX: เปลี่ยนเมื่อรูปข้อมูลเปลี่ยนจาก SQL (ไม่ผ่านระบบ = ไม่เปลี่ยนเลขเวอร์ชันข้อมูลให้)
const READ_CACHE_PREFIX = 'rd3_';

function cachedRead_(name, fn) {
  const key = READ_CACHE_PREFIX + name + '_' + dataVersion_();
  const hit = cacheGetObj_(key);
  if (hit) return hit;
  const res = fn();
  if (res && res.status === 'success') cachePutObj_(key, res, READ_CACHE_TTL);
  return res;
}

// -----------------------------------------------------------------------------
// แปลงเวลา Postgres timestamptz ("2026-07-13 15:50:09.111633+00") เป็น ISO 8601
// ที่ JS parse ได้ทุกเบราว์เซอร์ (Safari/iOS เข้มกว่า Chrome — ต้องถูกสเปก)
// -----------------------------------------------------------------------------
function toIsoLocal_(rs, col) {
  const raw = rs.getString(col);
  if (!raw || rs.wasNull()) return null;
  let s = String(raw).trim().replace(' ', 'T');
  s = s.replace(/(\.\d{3})\d+/, '$1');           // เศษวินาที 6 หลัก -> 3 หลัก
  s = s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'); // "+0700" -> "+07:00"
  s = s.replace(/([+-]\d{2})$/, '$1:00');        // "+00"   -> "+00:00"
  s = s.replace(/\.(\d{1,2})$/, '');             // ".0" ท้ายสุด -> ตัดทิ้ง
  return s;
}

function strOrNull_(rs, col) {
  const v = rs.getString(col);
  return (!v || rs.wasNull()) ? null : v;
}

function setStringOrNull(stmt, index, value) {
  if (value) stmt.setString(index, value);
  else stmt.setNull(index, Jdbc.Types.VARCHAR);
}

function setIntOrNull_(stmt, index, value) {
  if (value) stmt.setInt(index, value);
  else stmt.setNull(index, Jdbc.Types.INTEGER);
}

// -----------------------------------------------------------------------------
// Drive: บันทึกข้อความ PDF จาก Template.html (แชร์แบบมีลิงก์ดูได้) -> คืน URL
// ตัวแปรที่ template ใช้ต้องตั้งครบทุกตัว — ตัวที่ไม่ได้ตั้ง template จะ error
// -----------------------------------------------------------------------------
function renderMemoPdf_(form) {
  const tpl = HtmlService.createTemplateFromFile('Template');
  tpl.name = form.name || '-';
  tpl.position = form.position || '-';
  tpl.department = form.department || '-';   // ส่วนราชการเต็ม = พื้นที่ + สาขา + ส่วน
  tpl.section = form.section || '';           // ใช้ตัดบรรทัด "ส่วนราชการ" ให้แม่น
  tpl.asset_id = form.asset_id || '-';
  tpl.problem_type = form.problem_type || '-';
  tpl.description = form.description || '-';
  tpl.phone = form.phone || '-';

  const blob = Utilities.newBlob(tpl.evaluate().getContent(), 'text/html', 'temp.html').getAs('application/pdf');
  blob.setName('แจ้งซ่อม_' + (form.name || 'user') + '_' + new Date().getTime() + '.pdf');

  const file = DriveApp.getFolderById(FOLDER_ID).createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return file.getUrl();
}

// ย้ายไฟล์ไปถังขยะ (กู้คืนได้ใน 30 วัน) — เฉพาะไฟล์ในโฟลเดอร์ PDF ของระบบเท่านั้น
// คืน '' ถ้าสำเร็จ หรือข้อความบอกเหตุผลที่ไม่ลบ
function trashMemoFile_(fileId) {
  const file = DriveApp.getFileById(fileId);
  const parents = file.getParents();
  while (parents.hasNext()) {
    if (parents.next().getId() === FOLDER_ID) {
      file.setTrashed(true);
      return '';
    }
  }
  return 'ไฟล์นี้ไม่ได้อยู่ในโฟลเดอร์เอกสารของระบบ';
}
