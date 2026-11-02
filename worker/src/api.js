/* =============================================================================
   FAST TICKET Worker · api.js — ตรวจ token + ACL -> ส่งต่อ use case (พอร์ตจาก gas/ApiRouter.gs)
   -----------------------------------------------------------------------------
   handle(body, deps) ไม่ผูกกับ Cloudflare — tests/worker.html เรียกตรงด้วย DB จำลอง (PGlite)
   deps = { db, verifyToken(idToken) -> { ok, userId } }
   ============================================================================= */
import { fail } from './entities.js';
import * as UC from './usecases.js';
import { findUserRole } from './repo.js';

// ใครทำอะไรได้ — '*' = แค่ login ด้วย LINE · ต้องตรงกับ ACL ใน gas/ApiRouter.gs (และการซ่อนปุ่มใน admin.js)
// generateDocument / createTicket / deleteTempPdf ไม่อยู่ที่นี่ — ใช้ Google Drive จึงยังอยู่ที่ GAS
export const ACL = {
  getMyTickets:           ['*'],
  getMasterData:          ['*'],
  getBoard:               ['IT', 'Admin'],
  getDashboard:           ['IT', 'Admin'],
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
  deleteMasterItem:       ['Admin'],
};

// ประตูหลัก: verify token + เช็ค ACL — คืน { ok, userId, role } หรือ { ok:false, code, message }
// role อ่านจาก DB ทุกครั้ง (query เดียว ~ไม่กี่ ms ผ่าน Hyperdrive) — ลดสิทธิ์แล้วมีผลทันที ไม่ค้าง 5 นาทีแบบแคชของ GAS
async function authorize(action, idToken, deps) {
  const allowed = ACL[action];
  const v = idToken ? await deps.verifyToken(idToken) : { ok: false };
  // code ให้ client ตัดสินใจ login ใหม่ได้โดยไม่ต้องจับคำในข้อความภาษาไทย
  if (!v.ok) return { ok: false, code: 'AUTH_INVALID', message: 'ยืนยันตัวตน LINE ไม่สำเร็จ กรุณาเข้าสู่ระบบใหม่' };
  if (allowed.includes('*')) return { ok: true, userId: v.userId, role: null };

  const role = await findUserRole(deps.db, v.userId);
  if (!allowed.includes(role)) {
    // ข้อความนี้หน้าเว็บใช้แยกประเภท (ftErrorKind: "ไม่มีสิทธิ์" / "ไม่พบบัญชีในระบบ") — แก้ต้องแก้ทั้งสองฝั่ง
    return { ok: false, message: 'บัญชีนี้ไม่มีสิทธิ์ทำรายการนี้ (' + (role || 'ไม่พบบัญชีในระบบ') + ')' };
  }
  return { ok: true, userId: v.userId, role };
}

export async function handle(body, deps) {
  let request;
  try { request = JSON.parse(body); } catch (e) { return fail('รูปแบบคำขอไม่ถูกต้อง'); }
  const action = request && request.action;
  const handler = Object.prototype.hasOwnProperty.call(ACL, action) && UC[action];
  if (!handler) return fail('ไม่พบคำสั่ง Action: ' + action);

  try {
    const auth = await authorize(action, request.idToken, deps);
    if (!auth.ok) return fail(auth.message, auth.code);
    return await handler(request.data || {}, auth, deps.db);
  } catch (error) {
    console.error(action, error);
    return fail(String(error && error.message ? 'Error: ' + error.message : error));
  }
}

// ---------- ตรวจ LINE ID Token ----------
// แคชผลในหน่วยความจำของ isolate (หายเมื่อ isolate ถูกรีไซเคิล) — ข้ามการยิงถาม LINE ~0.2-0.4 วิ
// ไม่ได้ยืดอายุ token: เช็ค exp ทุกครั้งที่ใช้
const tokenCache = new Map();

export function lineVerifier(channelId) {
  return async function verifyToken(idToken) {
    const hit = tokenCache.get(idToken);
    if (hit) {
      if (hit.exp * 1000 > Date.now()) return { ok: true, userId: hit.sub };
      tokenCache.delete(idToken);
      return { ok: false };
    }
    if (!channelId) throw new Error('ยังไม่ได้ตั้งค่า LIFF_CHANNEL_ID ใน wrangler.jsonc');
    const res = await fetch('https://api.line.me/oauth2/v2.1/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id_token: idToken, client_id: channelId }),
    });
    if (res.status !== 200) return { ok: false };   // token ผิด/หมดอายุ/ผิด channel
    const p = await res.json();
    if (String(p.aud) !== String(channelId)) return { ok: false };
    if (p.exp && Number(p.exp) * 1000 < Date.now()) return { ok: false };
    if (tokenCache.size > 1000) tokenCache.clear();   // กันโตไม่หยุด (คนใช้พร้อมกันไม่ถึงหลักร้อย)
    tokenCache.set(idToken, { sub: p.sub, exp: Number(p.exp) || 0 });
    return { ok: true, userId: p.sub };
  };
}

