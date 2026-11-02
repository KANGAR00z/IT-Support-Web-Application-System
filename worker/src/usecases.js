/* =============================================================================
   FAST TICKET Worker · usecases.js — ลอจิกของแต่ละ action (พอร์ตจาก gas/UseCases.gs)
   -----------------------------------------------------------------------------
   ทุก use case รับ (data, auth, db): data = ค่าจาก client (ห้ามเชื่อ) · auth = ตัวตนที่ verify แล้ว
   🔒 ผู้กระทำมาจาก auth.userId เสมอ — client ไม่เคยส่ง userId ของตัวเองมา
   ไม่มี generateDocument / createTicket / deleteTempPdf — ใช้ Google Drive จึงยังอยู่ที่ GAS
   ไม่มีแคชผลอ่านแบบ GAS: Hyperdrive ต่อ DB ใกล้ๆ แต่ละ query ~ไม่กี่สิบ ms และไม่ต้องห่วงข้อมูลค้าง
   ============================================================================= */
import {
  API_VERSION, TICKET_STATUS, ROLE_DB_VALUE, STALE_PAGE_MSG,
  toId, cleanText, isTicketStatus, ticketCode, pageArgs, clampPage, likePattern, ok, fail,
} from './entities.js';
import * as R from './repo.js';

/* ---------------------------------------------------------------------------
   TICKET
   --------------------------------------------------------------------------- */

function boardFilter(data, auth) {
  return {
    q: likePattern(data.q),
    categoryId: toId(data.categoryId),
    province: cleanText(data.province).slice(0, 50),
    assignee: data.mine ? auth.userId : '',          // งานของฉัน = ผู้รับงานคือคนที่ login
    closedDays: Math.min(toId(data.closedDays), 3650),   // 0 = งานเสร็จทั้งหมด
    desc: data.sort !== 'old',
  };
}

// บอร์ด Kanban — แบ่งหน้าแยกแต่ละคอลัมน์ แต่ตอบครบ 3 คอลัมน์ในรอบเดียว
export async function getBoard(data, auth, db) {
  data = data || {};
  const f = boardFilter(data, auth);
  const size = pageArgs(data).size;
  const statuses = [TICKET_STATUS.OPEN, TICKET_STATUS.IN_PROGRESS, TICKET_STATUS.CLOSED];
  const want = statuses.map((s) => Math.max(1, parseInt(data.pages && data.pages[s], 10) || 1));
  const counts = await R.countBoardTickets(db, f);
  const cols = statuses.map((s, i) => {
    const c = counts[s] || { n: 0, all: 0 };
    return { status: s, page: clampPage(want[i], size, c.n), total: c.n, all: c.all, tickets: [] };
  });
  (await R.findBoardPage(db, f, size, cols)).forEach((t) => {
    cols.forEach((c) => { if (c.status === t.status) c.tickets.push(t); });
  });
  const res = { columns: cols, pageSize: size };
  if (data.facets) res.categories = await R.readMasterRows(db, R.MASTER_TABLES.category, false);
  return ok(res);
}

export async function getDashboard(data, auth, db) {
  const agingDays = Math.min(toId(data && data.agingDays) || 3, 30);
  const d = await R.readDashboard(db, agingDays);
  d.oldest.forEach((t) => { t.code = ticketCode(t.id); });
  return ok(d);
}

// ACL '*' — ใครก็ดูของตัวเองได้
export async function getMyTickets(data, auth, db) {
  return ok({ tickets: await R.findTicketsByReporter(db, auth.userId) });
}

export async function acceptTicket(data, auth, db) {
  const ticketId = toId(data && data.ticketId);
  if (!ticketId) return fail('ไม่ได้ระบุ ticketId');
  const staffName = await R.findUserName(db, auth.userId);
  if (staffName === null) return fail('ยังไม่มีบัญชีเจ้าหน้าที่คนนี้ในระบบ (USER)');
  if (await R.markTicketAccepted(db, ticketId, auth.userId) === 0) return fail('ไม่พบตั๋ว ' + ticketCode(ticketId));
  return ok({ message: 'รับงาน ' + ticketCode(ticketId) + ' โดย ' + staffName, assignee: staffName });
}

export async function updateTicketStatus(data, auth, db) {
  const ticketId = toId(data && data.ticketId);
  const status = parseInt(data && data.status, 10);
  if (!ticketId) return fail('ไม่ได้ระบุ ticketId');
  if (!isTicketStatus(status)) return fail('สถานะไม่ถูกต้อง: ' + (data && data.status));
  if (await R.updateTicketStatusRow(db, ticketId, status) === 0) return fail('ไม่พบตั๋ว ' + ticketCode(ticketId));
  return ok({ message: 'อัปเดตสถานะ ' + ticketCode(ticketId) + ' เป็น ' + status });
}

// ยกเลิกงาน (Admin) — soft delete
export async function deleteTicket(data, auth, db) {
  const ticketId = toId(data && data.ticketId);
  if (!ticketId) return fail('ไม่ได้ระบุ ticketId');
  if (await R.softDeleteTicket(db, ticketId, auth.userId) === 0) {
    return fail('ไม่พบตั๋ว ' + ticketCode(ticketId) + ' หรือถูกยกเลิกไปแล้ว');
  }
  return ok({ message: 'ยกเลิกงาน ' + ticketCode(ticketId) + ' แล้ว' });
}

/* ---------------------------------------------------------------------------
   USER
   --------------------------------------------------------------------------- */

export async function getUsers(data, auth, db) {
  data = data || {};
  const role = cleanText(data.role).toLowerCase();
  const f = { q: likePattern(data.q), role: ROLE_DB_VALUE[role] ? role : '' };
  const pg = pageArgs(data);
  const c = await R.countUsers(db, f);
  const page = clampPage(pg.page, pg.size, c.n);
  return ok({
    users: await R.findUsersPage(db, f, pg.size, (page - 1) * pg.size),
    total: c.n, page, pageSize: pg.size,
    counts: { all: c.all, admin: c.admin, it: c.it, staff: c.all - c.admin - c.it },
  });
}

export async function getMyProfile(data, auth, db) {
  return ok({ profile: await R.findProfile(db, auth.userId) });
}

// data.userId = ผู้ใช้เป้าหมาย · ผู้กระทำคือ auth (ACL ยืนยัน Admin แล้ว)
export async function updateUserRole(data, auth, db) {
  const targetId = cleanText(data && data.userId);
  const key = cleanText(data && data.role).toLowerCase();
  const dbRole = ROLE_DB_VALUE[key];
  if (!targetId) return fail('ไม่ได้ระบุ userId');
  if (!dbRole) return fail('บทบาทไม่ถูกต้อง: ' + key + ' (ต้องเป็น admin / it / staff)');

  // นับแอดมิน + แก้ ใน transaction เดียว — สองคนลดสิทธิ์แอดมินพร้อมกันจะไม่เหลือ 0 คน
  return db.tx(async (tx) => {
    const currentRole = await R.findUserRole(tx, targetId);
    if (currentRole === null) return fail('ไม่พบผู้ใช้คนนี้ในระบบ');
    if (currentRole === ROLE_DB_VALUE.admin && dbRole !== ROLE_DB_VALUE.admin && await R.countAdmins(tx) <= 1) {
      return fail('ต้องมีแอดมินอย่างน้อย 1 คนในระบบ — ตั้งคนอื่นเป็นแอดมินก่อนจึงจะลดสิทธิ์คนนี้ได้');
    }
    if (await R.updateUserRoleRow(tx, targetId, dbRole) === 0) return fail('ไม่พบผู้ใช้คนนี้ในระบบ');
    return ok({ role: dbRole });
  });
}

/* ---------------------------------------------------------------------------
   KNOWLEDGE_BASE (ประวัติการแจ้งซ่อม / วิธีแก้ไขปัญหา)
   --------------------------------------------------------------------------- */

export async function getKnowledgeBase(data, auth, db) {
  data = data || {};
  const f = { q: likePattern(data.q), categoryId: data.categoryId === 'none' ? 'none' : toId(data.categoryId) };
  const pg = pageArgs(data);
  const total = await R.countArticles(db, f);
  const page = clampPage(pg.page, pg.size, total);
  const res = {
    articles: await R.findArticlesPage(db, f, pg.size, (page - 1) * pg.size),
    total, page, pageSize: pg.size,
  };
  if (data.facets) res.categories = await R.countArticlesByCategory(db);
  return ok(res);
}

export async function addKnowledgeArticle(data, auth, db) {
  const ticketId = toId(data && data.ticketId);
  const resolutionText = cleanText(data && data.resolutionText);
  if (!ticketId) return fail('ไม่ได้ระบุ ticketId');
  if (!resolutionText) return fail('ไม่ได้ระบุวิธีแก้ไขปัญหา');
  if (await R.insertArticleFromTicket(db, ticketId, resolutionText, auth.userId) === 0) {
    return fail('ไม่พบตั๋ว ' + ticketCode(ticketId));
  }
  return ok();
}

export async function updateKnowledgeArticle(data, auth, db) {
  const kbId = toId(data && data.kbId);
  const resolutionText = cleanText(data && data.resolutionText);
  if (!kbId) return fail('ไม่ได้ระบุ kbId');
  if (!resolutionText) return fail('วิธีแก้ไขปัญหาห้ามว่าง');
  if (await R.updateArticleText(db, kbId, resolutionText) === 0) return fail('ไม่พบบทความ KB-' + kbId);
  return ok({ message: 'แก้ไขบทความ KB-' + kbId + ' สำเร็จ' });
}

export async function deleteKnowledgeArticle(data, auth, db) {
  const kbId = toId(data && data.kbId);
  if (!kbId) return fail('ไม่ได้ระบุ kbId');
  if (await R.deleteArticle(db, kbId) === 0) return fail('ไม่พบบทความ KB-' + kbId);
  return ok({ message: 'ลบบทความ KB-' + kbId + ' สำเร็จ' });
}

/* ---------------------------------------------------------------------------
   ข้อมูลหลัก (Master Data)
   --------------------------------------------------------------------------- */

// ACL '*' — ฟอร์มแจ้งซ่อมใช้เติม dropdown · ยอดการใช้งาน (withUsage) เฉพาะ Admin
export async function getMasterData(data, auth, db) {
  const withUsage = !!(data && data.withUsage) && await R.findUserRole(db, auth.userId) === ROLE_DB_VALUE.admin;
  const T = R.MASTER_TABLES;
  return ok({
    offices:     await R.readMasterRows(db, T.office, withUsage),
    branches:    await R.readMasterRows(db, T.branch, withUsage),
    departments: await R.readMasterRows(db, T.department, withUsage),
    categories:  await R.readMasterRows(db, T.category, withUsage),
  });
}

// ต้องมี apiVersion: key "branch" เคยหมายถึง "พื้นที่" หน้าเว็บรุ่นเก่าที่ยังค้างจะแก้/ลบผิดตาราง
function masterTarget(data) {
  if (!data || data.apiVersion !== API_VERSION) return { error: STALE_PAGE_MSG };
  const m = R.MASTER_TABLES[data.type];
  return m ? { m } : { error: 'ไม่รู้จักประเภทข้อมูล' };
}

function cleanMasterInput(m, input) {
  const values = {};
  for (const k of Object.keys(m.cols)) {
    const raw = input ? input[k] : undefined;
    if (m.ints.includes(k)) {
      values[k] = toId(raw) || null;
    } else {
      const s = cleanText(raw);
      if (s.length > 100) return { error: 'ข้อความยาวเกิน 100 ตัวอักษร' };   // varchar(100) ใน DB
      values[k] = s;
    }
    if (m.required.includes(k) && !values[k]) return { error: 'กรุณากรอกข้อมูลให้ครบ' };
  }
  return { values };
}

// กติกาโครงสร้างหน่วยงาน (ภาค -> พื้นที่ -> สาขา) — คืนข้อความ error หรือ '' · id = 0 ตอนเพิ่มใหม่
async function checkOrgRules(db, type, id, values) {
  if (type === 'office' && values.parentId) {
    if (values.parentId === id) return 'สังกัดตัวเองไม่ได้';
    const parent = await R.findOffice(db, values.parentId);
    if (!parent) return 'ไม่พบหน่วยงานที่สังกัด';
    if (parent.parentId) return '"' + parent.name + '" เป็นพื้นที่ในสังกัดอยู่แล้ว เลือกเป็นหน่วยงานแม่ไม่ได้ (รองรับ 2 ชั้น: ภาค → พื้นที่)';
    if (id && await R.countChildOffices(db, id) > 0) return 'หน่วยงานนี้มีพื้นที่ในสังกัดอยู่ จึงย้ายไปสังกัดหน่วยงานอื่นไม่ได้';
  }
  if (type === 'branch') {
    const office = await R.findOffice(db, values.officeId);
    if (!office) return 'ไม่พบพื้นที่ที่เลือก';
    if (values.name !== office.name && values.name.indexOf(office.name + ' ') !== 0) {
      return 'ชื่อต้องขึ้นต้นด้วยชื่อพื้นที่ "' + office.name + '" เช่น "' + office.name + ' สาขา..."';
    }
  }
  return '';
}

export async function addMasterItem(data, auth, db) {
  const t = masterTarget(data);
  if (t.error) return fail(t.error);
  const c = cleanMasterInput(t.m, data.item);
  if (c.error) return fail(c.error);
  if (await R.masterNameExists(db, t.m, c.values.name, 0)) return fail('มี' + t.m.label + 'ชื่อ "' + c.values.name + '" อยู่แล้ว');
  const rule = await checkOrgRules(db, data.type, 0, c.values);
  if (rule) return fail(rule);
  const id = await R.insertMasterRow(db, t.m, c.values);
  return ok({ message: 'เพิ่ม' + t.m.label + 'สำเร็จ', id });
}

// เปลี่ยนชื่อพื้นที่ = เปลี่ยนคำนำหน้าชื่อสาขาทั้งหมดในพื้นที่นั้นด้วย (transaction เดียว)
export async function updateMasterItem(data, auth, db) {
  const t = masterTarget(data);
  if (t.error) return fail(t.error);
  const id = toId(data.id);
  if (!id) return fail('ไม่ได้ระบุรายการที่จะแก้ไข');
  const c = cleanMasterInput(t.m, data.item);
  if (c.error) return fail(c.error);

  return db.tx(async (tx) => {
    if (await R.masterNameExists(tx, t.m, c.values.name, id)) return fail('มี' + t.m.label + 'ชื่อ "' + c.values.name + '" อยู่แล้ว');
    const rule = await checkOrgRules(tx, data.type, id, c.values);
    if (rule) return fail(rule);
    const before = data.type === 'office' ? await R.findOffice(tx, id) : null;
    if (await R.updateMasterRow(tx, t.m, id, c.values) === 0) return fail('ไม่พบ' + t.m.label + 'ที่จะแก้ไข');
    let renamed = 0;
    if (before && before.name && before.name !== c.values.name) {
      renamed = await R.renameBranchPrefix(tx, id, before.name, c.values.name);
    }
    return ok({ message: 'แก้ไข' + t.m.label + 'สำเร็จ' + (renamed ? ' (เปลี่ยนชื่อสาขาตามด้วย ' + renamed + ' รายการ)' : '') });
  });
}

// ลบได้เฉพาะรายการที่ไม่มีใครอ้างถึง
export async function deleteMasterItem(data, auth, db) {
  const t = masterTarget(data);
  if (t.error) return fail(t.error);
  const id = toId(data.id);
  if (!id) return fail('ไม่ได้ระบุรายการที่จะลบ');
  const inUse = await R.countMasterRefs(db, t.m, id);
  if (inUse.length) {
    return fail('ลบไม่ได้ — ' + t.m.label + 'นี้ยังถูกใช้อยู่ใน ' + inUse.map((u) => u.label + ' ' + u.n + ' รายการ').join(', '));
  }
  if (await R.deleteMasterRow(db, t.m, id) === 0) return fail('ไม่พบ' + t.m.label + 'ที่จะลบ');
  return ok({ message: 'ลบ' + t.m.label + 'สำเร็จ' });
}
