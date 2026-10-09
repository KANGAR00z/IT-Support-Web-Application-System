/* =============================================================================
   FAST TICKET · Entities.gs — ชั้นในสุด: ค่าคงที่ของระบบ + ฟังก์ชันตรวจค่าแบบ pure
   -----------------------------------------------------------------------------
   ไฟล์ backend ทั้งหมด (เรียงจากชั้นในไปชั้นนอก):
     Entities.gs        ค่าคงที่ + กฎตรวจค่า (ไม่แตะ DB/Drive/HTTP)
     UseCases.gs        ลอจิกของแต่ละ action — ตรวจ input, เรียก repository, จัดรูปคำตอบ
     Repositories.gs    SQL ทั้งหมด (PreparedStatement) + แปลงแถวเป็น object
     Infrastructure.gs  เปิด/ปิด connection, transaction, Drive/PDF
     ApiRouter.gs       doPost -> ตรวจ token + ACL -> ส่งต่อ use case
     Code.gs            🔒 DB_CONFIG + getDbConnection() เท่านั้น (gitignore — ห้าม commit)

   ⚠️ GAS ไม่มีระบบ module: ทุกไฟล์อยู่ใน global scope เดียวกัน "ชั้น" จึงเป็นข้อตกลง
      ห้ามประกาศชื่อฟังก์ชันซ้ำข้ามไฟล์ (ตัวหลังทับตัวแรกเงียบๆ)
   ⚠️ ค่าระดับบนสุด (const) ห้ามอ้างค่าของไฟล์อื่น — GAS โหลดไฟล์ตามลำดับในโปรเจกต์
      อ้างข้ามไฟล์ได้เฉพาะ "ภายในฟังก์ชัน" (ทำงานตอนถูกเรียก ทุกไฟล์โหลดครบแล้ว)
   ============================================================================= */

// หน้าเว็บที่ส่ง apiVersion นี้ = รู้จักชื่อชุดใหม่ (office / branch / department)
// ชื่อ "branch" เปลี่ยนความหมายจาก พื้นที่ -> สาขา จึงต้องแยกหน้าเว็บรุ่นเก่าที่ยังค้างในเครื่องออกให้ได้
const API_VERSION = 2;

// โฟลเดอร์เก็บ PDF ใน Drive (ไม่ใช่ secret)
const FOLDER_ID = '1wQSNqJ0QHgm9hKaVf4sm0_fIXprEpSsc';

// Status: 1 = รอรับเรื่อง · 2 = กำลังดำเนินการ · 3 = เสร็จสิ้น (ผูกกับคอลัมน์บอร์ดใน admin.js)
const TICKET_STATUS = { OPEN: 1, IN_PROGRESS: 2, CLOSED: 3 };

// Role: DB มี CHECK "USER_Role_check" -> ต้องเป็น 'Staff'/'IT'/'Admin' ตามตัวพิมพ์นี้เป๊ะ
//       (ค่าอื่น Postgres reject error 23514) · หน้าเว็บส่ง lowercase มา
const ROLE_DB_VALUE = { admin: 'Admin', it: 'IT', staff: 'Staff' };

// ---------- กฎตรวจค่า (pure) ----------

// id จาก client -> จำนวนเต็มบวก หรือ 0 (= ไม่ได้ระบุ/ไม่ถูกต้อง)
function toId_(v) {
  const n = parseInt(v, 10);
  return n > 0 ? n : 0;
}

function cleanText_(v) {
  return String(v === undefined || v === null ? '' : v).trim();
}

function isTicketStatus_(s) {
  return s === TICKET_STATUS.OPEN || s === TICKET_STATUS.IN_PROGRESS || s === TICKET_STATUS.CLOSED;
}

function ticketCode_(id) {
  return 'TK-' + id;
}

function ok_(extra) {
  return Object.assign({ status: 'success' }, extra || {});
}

function fail_(message, code) {
  return code ? { status: 'error', code: code, message: message } : { status: 'error', message: message };
}

// รหัสไฟล์ Drive ในลิงก์ (ยาว 25 ตัวขึ้นไป) — '' ถ้าไม่พบ
function driveFileId_(url) {
  const m = String(url || '').match(/[-\w]{25,}/);
  return m ? m[0] : '';
}
