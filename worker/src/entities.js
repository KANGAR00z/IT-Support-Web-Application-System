/* =============================================================================
   FAST TICKET Worker · entities.js — ค่าคงที่ + กฎตรวจค่าแบบ pure (พอร์ตจาก gas/Entities.gs)
   ไม่แตะ DB / เครือข่าย · แก้กฎที่นี่ต้องแก้ใน gas/Entities.gs ให้ตรงกันด้วย (GAS ยังรับ createTicket อยู่)
   ============================================================================= */

// หน้าเว็บที่ส่ง apiVersion นี้ = รู้จักชื่อชุดใหม่ (office / branch / department)
export const API_VERSION = 2;

// 1 = รอรับเรื่อง · 2 = กำลังดำเนินการ · 3 = เสร็จสิ้น
export const TICKET_STATUS = { OPEN: 1, IN_PROGRESS: 2, CLOSED: 3 };

// DB มี CHECK "USER_Role_check" -> 'Staff'/'IT'/'Admin' ตามตัวพิมพ์นี้เป๊ะ · หน้าเว็บส่ง lowercase
export const ROLE_DB_VALUE = { admin: 'Admin', it: 'IT', staff: 'Staff' };

export const STALE_PAGE_MSG = 'หน้าเว็บเป็นเวอร์ชันเก่า กรุณาปิดแล้วเปิดใหม่ (หรือกดรีเฟรช)';

// id จาก client -> จำนวนเต็มบวก หรือ 0 (= ไม่ได้ระบุ/ไม่ถูกต้อง)
export function toId(v) {
  const n = parseInt(v, 10);
  return n > 0 ? n : 0;
}

export function cleanText(v) {
  return String(v === undefined || v === null ? '' : v).trim();
}

export const isTicketStatus = (s) =>
  s === TICKET_STATUS.OPEN || s === TICKET_STATUS.IN_PROGRESS || s === TICKET_STATUS.CLOSED;

export const ticketCode = (id) => 'TK-' + id;

// ---------- การแบ่งหน้า ----------
const PAGE_SIZE_DEFAULT = 20;
const PAGE_SIZE_MAX = 50;

export function pageArgs(data) {
  const size = parseInt(data && data.pageSize, 10);
  return {
    page: Math.max(1, parseInt(data && data.page, 10) || 1),
    size: size > 0 ? Math.min(size, PAGE_SIZE_MAX) : PAGE_SIZE_DEFAULT,
  };
}

// ขอหน้าที่เลยหน้าสุดท้าย -> ได้หน้าสุดท้ายที่มีจริงแทนหน้าว่าง
export function clampPage(page, size, total) {
  return Math.min(page, Math.max(1, Math.ceil(total / size)));
}

// คำค้น -> pattern ของ ILIKE ('' = ไม่ค้น) · escape % _ \ ไม่ให้กลายเป็น wildcard
export function likePattern(q) {
  const s = cleanText(q).slice(0, 100);
  return s ? '%' + s.replace(/[\\%_]/g, '\\$&') + '%' : '';
}

export const ok = (extra) => Object.assign({ status: 'success' }, extra || {});
export const fail = (message, code) =>
  code ? { status: 'error', code, message } : { status: 'error', message };

// ค่าจากไดรเวอร์ -> ชนิดที่หน้าเว็บคาดไว้ (เหมือนที่ GAS ส่ง)
// COUNT(*) เป็น bigint ไดรเวอร์คืนเป็นสตริง/BigInt · เวลาเป็น Date -> ISO แบบ "+00:00" (Safari อ่านได้)
export const num = (v) => (v === null || v === undefined ? 0 : Number(v));
export const str = (v) => (v === null || v === undefined ? '' : String(v));
export function iso(v) {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString().replace('Z', '+00:00');
}
