/* =============================================================================
   FAST TICKET · Rich Menu Setup (ทาง B — rich menu เฉพาะ IT)
   -----------------------------------------------------------------------------
   สคริปต์ GAS สำหรับสร้าง rich menu 2 อัน แล้วผูกเมนู IT ให้เจ้าหน้าที่รายคน
     - เมนู STAFF (default) : ทุกคนเห็น มีปุ่ม "แจ้งซ่อม"
     - เมนู IT             : เจ้าหน้าที่ IT เห็น มีปุ่ม "แจ้งซ่อม" + "จัดการงาน" (เปิด admin.html)

   วิธีใช้ (ทำครั้งเดียว):
     1) ไฟล์นี้ต้องอยู่ในโปรเจกต์ GAS ที่ผูกกับ "Messaging API channel" (บอทที่โชว์ rich menu)
     2) ตั้งค่า Script Properties (Project Settings → Script properties):
          CHANNEL_ACCESS_TOKEN = <channel access token ของ Messaging API channel>
        *** อย่า hardcode token ในไฟล์ / อย่า commit token ขึ้น git ***
     3) อัปโหลดรูป rich menu 2 รูปขึ้น Google Drive แล้วเอา File ID มาใส่ใน CONFIG ด้านล่าง
          - ขนาดรูป: 2500x1686 (เต็ม) หรือ 2500x843 (เตี้ย) · .png/.jpg · <1MB
     4) ใส่ MY_LIFF_ID / ADMIN_LIFF_ID (จาก config.js) ให้ตรง
     5) รันฟังก์ชัน setupAllRichMenus() หนึ่งครั้ง → ได้ richMenuId ทั้งสอง (ดูใน Log)
     6) ใส่ userId ของเจ้าหน้าที่ IT ใน IT_STAFF_USER_IDS แล้วรัน linkITStaff()
   ============================================================================= */

// ---------- CONFIG (แก้ค่าตรงนี้) ----------
const RM = {
  MY_LIFF_ID:    '2010392375-KFCzC8ai',  // LIFF หน้าแจ้งซ่อม (index.html)
  ADMIN_LIFF_ID: '',                      // LIFF หน้า admin (admin.html) — เอามาจาก LIFF app #2

  // File ID ของรูป rich menu บน Google Drive (คลิกขวาไฟล์ใน Drive → Share → ดึง id จาก URL)
  STAFF_IMAGE_FILE_ID: '',                // รูปเมนูปกติ (ปุ่มเดียว: แจ้งซ่อม)
  IT_IMAGE_FILE_ID:    '',                // รูปเมนู IT (สองปุ่ม: แจ้งซ่อม | จัดการงาน)

  // userId (LINE) ของเจ้าหน้าที่ IT ที่จะได้เมนู IT (ดูจาก USER.LINE_User_ID ใน Supabase)
  // *** ต้องตั้ง USER.Role ใน Supabase ให้เป็น admin ด้วย (ดู sql/set-admin.sql) ***
  IT_STAFF_USER_IDS: [
    'U952f17025df2d3d3cd4b36d8a4e7a443',
  ],
};

const LINE_API = 'https://api.line.me/v2/bot';
const LINE_DATA_API = 'https://api-data.line.me/v2/bot';

function _token_() {
  const t = PropertiesService.getScriptProperties().getProperty('CHANNEL_ACCESS_TOKEN');
  if (!t) throw new Error('ยังไม่ได้ตั้ง Script Property: CHANNEL_ACCESS_TOKEN');
  return t;
}
function _headers_() {
  return { 'Authorization': 'Bearer ' + _token_() };
}

// ---------- รูปแบบ rich menu (แก้ bounds/ข้อความได้) ----------
// เมนูปกติ: เต็มจอ ปุ่มเดียว "แจ้งซ่อม" → เปิด LIFF แจ้งซ่อม
function staffMenuJson() {
  return {
    size: { width: 2500, height: 843 },
    selected: true,
    name: 'FAST TICKET - Staff',
    chatBarText: 'เมนูแจ้งซ่อม',
    areas: [
      { bounds: { x: 0, y: 0, width: 2500, height: 843 },
        action: { type: 'uri', label: 'แจ้งซ่อม', uri: 'https://liff.line.me/' + RM.MY_LIFF_ID } },
    ],
  };
}

// เมนู IT: แบ่งครึ่ง ซ้าย "แจ้งซ่อม" · ขวา "จัดการงาน" → เปิด LIFF admin
function itMenuJson() {
  if (!RM.ADMIN_LIFF_ID) throw new Error('ยังไม่ได้ตั้ง RM.ADMIN_LIFF_ID (สร้าง LIFF app #2 ก่อน)');
  return {
    size: { width: 2500, height: 843 },
    selected: true,
    name: 'FAST TICKET - IT',
    chatBarText: 'เมนูเจ้าหน้าที่ IT',
    areas: [
      { bounds: { x: 0, y: 0, width: 1250, height: 843 },
        action: { type: 'uri', label: 'แจ้งซ่อม', uri: 'https://liff.line.me/' + RM.MY_LIFF_ID } },
      { bounds: { x: 1250, y: 0, width: 1250, height: 843 },
        action: { type: 'uri', label: 'จัดการงาน', uri: 'https://liff.line.me/' + RM.ADMIN_LIFF_ID } },
    ],
  };
}

// ---------- ขั้นตอนย่อย (Messaging API) ----------
function createRichMenu(menuJson) {
  const res = UrlFetchApp.fetch(LINE_API + '/richmenu', {
    method: 'post',
    contentType: 'application/json',
    headers: _headers_(),
    payload: JSON.stringify(menuJson),
    muteHttpExceptions: true,
  });
  const body = JSON.parse(res.getContentText());
  if (res.getResponseCode() !== 200) throw new Error('createRichMenu ล้มเหลว: ' + res.getContentText());
  return body.richMenuId;
}

function uploadRichMenuImage(richMenuId, driveFileId) {
  if (!driveFileId) throw new Error('ยังไม่ได้ใส่ File ID ของรูป rich menu');
  const file = DriveApp.getFileById(driveFileId);
  const blob = file.getBlob();
  const contentType = blob.getContentType(); // image/png หรือ image/jpeg
  const res = UrlFetchApp.fetch(LINE_DATA_API + '/richmenu/' + richMenuId + '/content', {
    method: 'post',
    contentType: contentType,
    headers: _headers_(),
    payload: blob.getBytes(),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) throw new Error('uploadRichMenuImage ล้มเหลว: ' + res.getContentText());
}

function setDefaultRichMenu(richMenuId) {
  const res = UrlFetchApp.fetch(LINE_API + '/user/all/richmenu/' + richMenuId, {
    method: 'post', headers: _headers_(), muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) throw new Error('setDefaultRichMenu ล้มเหลว: ' + res.getContentText());
}

function linkRichMenuToUser(userId, richMenuId) {
  const res = UrlFetchApp.fetch(LINE_API + '/user/' + userId + '/richmenu/' + richMenuId, {
    method: 'post', headers: _headers_(), muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) throw new Error('linkRichMenuToUser(' + userId + ') ล้มเหลว: ' + res.getContentText());
}

// ---------- ตัวรันหลัก ----------
// สร้างเมนูทั้งสอง + อัปรูป + ตั้งเมนู STAFF เป็น default → เก็บ richMenuId ไว้ใน Script Properties
function setupAllRichMenus() {
  // STAFF (default ของทุกคน)
  const staffId = createRichMenu(staffMenuJson());
  uploadRichMenuImage(staffId, RM.STAFF_IMAGE_FILE_ID);
  setDefaultRichMenu(staffId);

  // IT (ผูกเฉพาะเจ้าหน้าที่)
  const itId = createRichMenu(itMenuJson());
  uploadRichMenuImage(itId, RM.IT_IMAGE_FILE_ID);

  PropertiesService.getScriptProperties().setProperties({
    RM_STAFF_ID: staffId,
    RM_IT_ID: itId,
  });
  Logger.log('เสร็จ! STAFF richMenuId = %s (ตั้งเป็น default แล้ว)', staffId);
  Logger.log('IT richMenuId = %s (เก็บไว้แล้ว รัน linkITStaff() เพื่อผูกให้เจ้าหน้าที่)', itId);
}

// ผูกเมนู IT ให้ userId ทุกคนใน RM.IT_STAFF_USER_IDS
function linkITStaff() {
  const itId = PropertiesService.getScriptProperties().getProperty('RM_IT_ID');
  if (!itId) throw new Error('ยังไม่มี RM_IT_ID — รัน setupAllRichMenus() ก่อน');
  if (!RM.IT_STAFF_USER_IDS.length) throw new Error('ยังไม่ได้ใส่ userId ใน RM.IT_STAFF_USER_IDS');
  RM.IT_STAFF_USER_IDS.forEach(uid => {
    linkRichMenuToUser(uid, itId);
    Logger.log('ผูกเมนู IT ให้ %s แล้ว', uid);
  });
}

// ถอดเมนู IT ออกจาก user (กลับไปใช้ default) — เผื่อย้ายคนออกจากทีม IT
function unlinkUser(userId) {
  const res = UrlFetchApp.fetch(LINE_API + '/user/' + userId + '/richmenu', {
    method: 'delete', headers: _headers_(), muteHttpExceptions: true,
  });
  Logger.log('unlink %s: %s', userId, res.getResponseCode());
}

// ลบ rich menu ทั้งหมด (ใช้ตอนอยากรีเซ็ตแล้วสร้างใหม่)
function deleteAllRichMenus() {
  const res = UrlFetchApp.fetch(LINE_API + '/richmenu/list', { headers: _headers_(), muteHttpExceptions: true });
  const list = JSON.parse(res.getContentText()).richmenus || [];
  list.forEach(m => {
    UrlFetchApp.fetch(LINE_API + '/richmenu/' + m.richMenuId, { method: 'delete', headers: _headers_(), muteHttpExceptions: true });
    Logger.log('ลบ %s', m.richMenuId);
  });
}
