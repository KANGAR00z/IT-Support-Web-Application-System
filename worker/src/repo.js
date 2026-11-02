/* =============================================================================
   FAST TICKET Worker · repo.js — SQL ทั้งหมด (พอร์ตจาก gas/Repositories.gs)
   -----------------------------------------------------------------------------
   db = { q(text, params) -> Promise<rows>, tx(fn) } (ดู db.js) · ค่าจากผู้ใช้ผ่าน $1, $2 ... เสมอ ห้ามต่อสตริงเข้า SQL
   ชื่อตาราง/คอลัมน์ที่ต่อสตริงได้ มาจากค่าคงที่ในไฟล์นี้เท่านั้น (MASTER_TABLES)
   แก้/ลบ ใช้ RETURNING แล้วนับแถว (ไดรเวอร์แต่ละตัวรายงานจำนวนแถวที่แก้ไม่เหมือนกัน)
   ค่าที่ชนิดกำกวม (อยู่ใน SELECT list / ต่อด้วย ||) ใส่ ::int / ::text กำกับ — ไม่งั้น Postgres เดาเป็น text แล้ว insert ลงคอลัมน์ int ไม่ได้
   ============================================================================= */
import { TICKET_STATUS, ROLE_DB_VALUE, ticketCode, num, str, iso } from './entities.js';

// ตัวสะสมพารามิเตอร์: p.add(ค่า) คืน "$n" ไปต่อใน SQL
function params() {
  const list = [];
  return { list, add: (v) => '$' + list.push(v) };
}

/* ---------------------------------------------------------------------------
   TICKET
   --------------------------------------------------------------------------- */

// LEFT JOIN กันตั๋วหายถ้า master data ขาด · JOIN "USER" 2 ครั้ง: ผู้แจ้ง (u) + ผู้รับงาน (it)
const TICKET_FROM = `
    FROM "TICKET" t
    LEFT JOIN "ISSUE_CATEGORY" c  ON c."Category_ID"   = t."Category_ID"
    LEFT JOIN "EXCISE_OFFICE"  o  ON o."Office_ID"     = t."Office_ID"
    LEFT JOIN "BRANCH"         b  ON b."Branch_ID"     = t."Branch_ID"
    LEFT JOIN "DEPARTMENT"     d  ON d."Dept_ID"       = t."Dept_ID"
    LEFT JOIN "USER"           u  ON u."LINE_User_ID"  = t."LINE_User_ID"
    LEFT JOIN "USER"           it ON it."LINE_User_ID" = t."IT_In_Charge"`;

function ticketSelect(withResolution, extraCol) {
  return `
    SELECT
      t."Ticket_ID", t."Issue_Detail", t."Status", t."IT_In_Charge", t."Doc_PDF_URL",
      t."Image_URL", t."Contact_Phone", t."Created_Date", t."Accepted_Date", t."Closed_Date", t."Deleted_At",
      c."Category_Name", o."Office_Name", o."Province", b."Branch_Name", d."Dept_Name",
      u."Full_Name"  AS "Reporter_Name",
      it."Full_Name" AS "Assignee_Name"` +
    (withResolution ? `,
      (SELECT kb."Resolution_Text" FROM "KNOWLEDGE_BASE" kb
        WHERE kb."Ticket_ID" = t."Ticket_ID"
        ORDER BY kb."Created_Date" DESC LIMIT 1) AS "Resolution_Text"` : '') +
    (extraCol ? ',\n      ' + extraCol : '') + TICKET_FROM;
}

function mapTicket(r, withResolution) {
  const id = num(r.Ticket_ID);
  const t = {
    id,
    code: ticketCode(id),
    detail: str(r.Issue_Detail) || '(ไม่มีรายละเอียด)',
    category: str(r.Category_Name),
    office: str(r.Office_Name),
    branch: str(r.Branch_Name),
    department: str(r.Dept_Name),
    province: str(r.Province),
    reporter: str(r.Reporter_Name) || '-',
    // หน้าประวัติของผู้แจ้ง (withResolution) ไม่โชว์ LINE id ของเจ้าหน้าที่
    assignee: str(r.Assignee_Name) || (withResolution ? null : (r.IT_In_Charge || null)),
    status: num(r.Status),
    createdAt: iso(r.Created_Date),
    acceptedAt: iso(r.Accepted_Date),
    closedAt: iso(r.Closed_Date),
    pdfUrl: str(r.Doc_PDF_URL),
    imageUrl: str(r.Image_URL),
    phone: str(r.Contact_Phone),
  };
  if (withResolution) {
    t.resolution = str(r.Resolution_Text);
    t.cancelled = !!r.Deleted_At;
  }
  return t;
}

/* ---------- บอร์ด (Kanban) — แบ่งหน้าแยกแต่ละคอลัมน์ ---------- */

const TICKET_SEARCH = `concat_ws(' ', 'TK-' || t."Ticket_ID", t."Issue_Detail", u."Full_Name", it."Full_Name",
      b."Branch_Name", d."Dept_Name", o."Office_Name", o."Province", c."Category_Name")`;

// ไม่รวม "ยังไม่ถูกยกเลิก" — ผู้เรียกใส่เอง เพราะยอดก่อนกรองต้องนับแยก
function boardWhere(f, p) {
  const w = [];
  if (f.categoryId) w.push(`t."Category_ID" = ${p.add(f.categoryId)}::int`);
  if (f.province) w.push(`strpos(COALESCE(o."Province", ''), ${p.add(f.province)}::text) > 0`);
  if (f.assignee) w.push(`t."IT_In_Charge" = ${p.add(f.assignee)}::text`);
  // ช่วงเวลามีผลกับงานที่เสร็จแล้วเท่านั้น — งานที่ยังไม่เสร็จต้องเห็นเสมอ
  if (f.closedDays) {
    w.push(`(t."Status" <> ${TICKET_STATUS.CLOSED} OR t."Closed_Date" IS NULL` +
      ` OR t."Closed_Date" >= NOW() - make_interval(days => ${p.add(f.closedDays)}::int))`);
  }
  if (f.q) w.push(`${TICKET_SEARCH} ILIKE ${p.add(f.q)}::text`);
  return w.length ? w.join(' AND ') : 'TRUE';
}

// { [status]: { n: ยอดที่ตรงตัวกรอง, all: ยอดทั้งคอลัมน์ } }
export async function countBoardTickets(db, f) {
  const p = params();
  const rows = await db.q(
    `SELECT t."Status" AS s, COUNT(*)::int AS all_n, (COUNT(*) FILTER (WHERE ${boardWhere(f, p)}))::int AS n` +
    TICKET_FROM + ' WHERE t."Deleted_At" IS NULL GROUP BY t."Status"', p.list);
  const out = {};
  rows.forEach((r) => { out[num(r.s)] = { n: num(r.n), all: num(r.all_n) }; });
  return out;
}

// การ์ดหน้าที่ขอของทุกคอลัมน์ใน query เดียว — ลำดับ = เวลาที่ตรงกับสถานะนั้น · id ต่อท้ายให้ลำดับนิ่ง
export async function findBoardPage(db, f, size, cols) {
  const p = params();
  const where = boardWhere(f, p);
  const dir = f.desc ? 'DESC' : 'ASC';
  const key = 'CASE t."Status"' +
    ` WHEN ${TICKET_STATUS.CLOSED} THEN COALESCE(t."Closed_Date", t."Created_Date")` +
    ` WHEN ${TICKET_STATUS.IN_PROGRESS} THEN COALESCE(t."Accepted_Date", t."Created_Date")` +
    ' ELSE t."Created_Date" END';
  const rn = `ROW_NUMBER() OVER (PARTITION BY t."Status" ORDER BY ${key} ${dir}, t."Ticket_ID" ${dir}) AS rn`;
  const pick = cols.map((c) =>
    `(x."Status" = ${p.add(c.status)}::int AND x.rn > ${p.add((c.page - 1) * size)}::int AND x.rn <= ${p.add(c.page * size)}::int)`);
  const rows = await db.q(
    `SELECT * FROM (${ticketSelect(false, rn)} WHERE t."Deleted_At" IS NULL AND ${where}) x WHERE ` +
    pick.join(' OR ') + ' ORDER BY x."Status", x.rn', p.list);
  return rows.map((r) => mapTicket(r, false));
}

// แดชบอร์ดทั้งหน้าใน query เดียว (Postgres ประกอบ JSON) · ไม่นับงานที่ถูกยกเลิก
export async function readDashboard(db, agingDays) {
  const rows = await db.q(`
    WITH a AS (SELECT * FROM "TICKET" WHERE "Deleted_At" IS NULL)
    SELECT json_build_object(
      'kpi', (SELECT json_build_object(
          'total', COUNT(*),
          'open',  COUNT(*) FILTER (WHERE "Status" = ${TICKET_STATUS.OPEN}),
          'prog',  COUNT(*) FILTER (WHERE "Status" = ${TICKET_STATUS.IN_PROGRESS}),
          'done',  COUNT(*) FILTER (WHERE "Status" = ${TICKET_STATUS.CLOSED}),
          'acceptAvgMs', AVG(EXTRACT(EPOCH FROM ("Accepted_Date" - "Created_Date")) * 1000),
          'acceptN',     COUNT("Accepted_Date"),
          'closeAvgMs',  AVG(EXTRACT(EPOCH FROM ("Closed_Date" - "Created_Date")) * 1000),
          'closeN',      COUNT("Closed_Date"),
          'aging', COUNT(*) FILTER (WHERE "Status" = ${TICKET_STATUS.OPEN}
                                    AND "Created_Date" < NOW() - make_interval(days => $1::int)))
        FROM a),
      'categories', (SELECT COALESCE(json_agg(json_build_object('name', x.name, 'n', x.n)), '[]'::json) FROM (
          SELECT c."Category_Name" AS name, COUNT(*) AS n FROM a
          LEFT JOIN "ISSUE_CATEGORY" c ON c."Category_ID" = a."Category_ID"
          GROUP BY 1) x),
      'provinces', (SELECT COALESCE(json_agg(json_build_object('province', x.province, 'office', x.office, 'n', x.n)), '[]'::json) FROM (
          SELECT o."Province" AS province, o."Office_Name" AS office, COUNT(*) AS n FROM a
          LEFT JOIN "EXCISE_OFFICE" o ON o."Office_ID" = a."Office_ID"
          GROUP BY 1, 2) x),
      'staff', (SELECT COALESCE(json_agg(json_build_object('name', x.name, 'n', x.n)), '[]'::json) FROM (
          SELECT COALESCE(it."Full_Name", a."IT_In_Charge") AS name, COUNT(*) AS n FROM a
          LEFT JOIN "USER" it ON it."LINE_User_ID" = a."IT_In_Charge"
          WHERE a."IT_In_Charge" IS NOT NULL
          GROUP BY 1) x),
      'oldest', (SELECT COALESCE(json_agg(json_build_object('id', x."Ticket_ID", 'detail', x."Issue_Detail",
            'province', x."Province", 'office', x."Office_Name",
            'createdAt', to_char(x."Created_Date" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
            ORDER BY x."Created_Date"), '[]'::json) FROM (
          SELECT a."Ticket_ID", a."Issue_Detail", a."Created_Date", o."Province", o."Office_Name" FROM a
          LEFT JOIN "EXCISE_OFFICE" o ON o."Office_ID" = a."Office_ID"
          WHERE a."Status" = ${TICKET_STATUS.OPEN}
          ORDER BY a."Created_Date" LIMIT 6) x),
      'trend', (SELECT COALESCE(json_agg(json_build_object('d', x.d, 'n', x.n)), '[]'::json) FROM (
          SELECT to_char(("Created_Date" AT TIME ZONE 'Asia/Bangkok')::date, 'YYYY-MM-DD') AS d, COUNT(*) AS n FROM a
          WHERE "Created_Date" >= NOW() - INTERVAL '32 days'
          GROUP BY 1) x)
    )::text AS j`, [agingDays]);
  return JSON.parse(rows[0].j);
}

// ตั๋วของผู้แจ้งคนหนึ่ง รวมที่ถูกยกเลิก (หน้าประวัติแสดงว่า "ยกเลิกแล้ว")
export async function findTicketsByReporter(db, userId) {
  const rows = await db.q(ticketSelect(true) + ' WHERE t."LINE_User_ID" = $1 ORDER BY t."Ticket_ID" DESC', [userId]);
  return rows.map((r) => mapTicket(r, true));
}

// รับงาน: ผู้รับ + เวลา · ล้าง Closed_Date เผื่อรับงานที่เคยปิดแล้วเปิดใหม่ — คืนจำนวนแถวที่แก้
export async function markTicketAccepted(db, ticketId, staffUserId) {
  const rows = await db.q(`
    UPDATE "TICKET"
    SET "Status" = ${TICKET_STATUS.IN_PROGRESS}, "IT_In_Charge" = $1::text, "Accepted_Date" = NOW(), "Closed_Date" = NULL
    WHERE "Ticket_ID" = $2::int AND "Deleted_At" IS NULL RETURNING 1`, [staffUserId, ticketId]);
  return rows.length;
}

// ปิด = ลงเวลาปิด · เปิดใหม่ = ล้างผู้รับ/เวลาทั้งหมด · กำลังทำ = ล้างเวลาปิด และลงเวลารับเรื่องถ้ายังไม่มี
export async function updateTicketStatusRow(db, ticketId, status) {
  let set;
  if (status === TICKET_STATUS.CLOSED) set = '"Status" = $1::int, "Closed_Date" = NOW()';
  else if (status === TICKET_STATUS.OPEN) set = '"Status" = $1::int, "IT_In_Charge" = NULL, "Accepted_Date" = NULL, "Closed_Date" = NULL';
  else set = '"Status" = $1::int, "Closed_Date" = NULL, "Accepted_Date" = COALESCE("Accepted_Date", NOW())';
  const rows = await db.q(
    `UPDATE "TICKET" SET ${set} WHERE "Ticket_ID" = $2::int AND "Deleted_At" IS NULL RETURNING 1`, [status, ticketId]);
  return rows.length;
}

// ยกเลิกงาน (soft delete) — แถว + PDF ยังอยู่
export async function softDeleteTicket(db, ticketId, byUserId) {
  const rows = await db.q(`
    UPDATE "TICKET" SET "Deleted_At" = NOW(), "Deleted_By" = $1::text
    WHERE "Ticket_ID" = $2::int AND "Deleted_At" IS NULL RETURNING 1`, [byUserId, ticketId]);
  return rows.length;
}

/* ---------------------------------------------------------------------------
   USER
   --------------------------------------------------------------------------- */

export async function findUserName(db, userId) {
  const rows = await db.q('SELECT "Full_Name" FROM "USER" WHERE "LINE_User_ID" = $1', [userId]);
  return rows.length ? str(rows[0].Full_Name) : null;   // null = ไม่มีบัญชี
}

// 'Staff'/'IT'/'Admin' หรือ null (ไม่มีบัญชี)
export async function findUserRole(db, userId) {
  const rows = await db.q('SELECT "Role" FROM "USER" WHERE "LINE_User_ID" = $1', [userId]);
  return rows.length ? (rows[0].Role || null) : null;
}

export async function countAdmins(db) {
  const rows = await db.q('SELECT COUNT(*)::int AS n FROM "USER" WHERE "Role" = $1', [ROLE_DB_VALUE.admin]);
  return num(rows[0].n);
}

export async function updateUserRoleRow(db, userId, dbRole) {
  const rows = await db.q('UPDATE "USER" SET "Role" = $1 WHERE "LINE_User_ID" = $2 RETURNING 1', [dbRole, userId]);
  return rows.length;
}

const USER_FROM = `
    FROM "USER" u
    LEFT JOIN "BRANCH"        b ON b."Branch_ID" = u."Branch_ID"
    LEFT JOIN "EXCISE_OFFICE" o ON o."Office_ID" = b."Office_ID"
    LEFT JOIN "DEPARTMENT"    d ON d."Dept_ID"   = u."Dept_ID"`;

// client เลือกได้แค่ key ในนี้ (ข้อความ SQL เป็นค่าคงที่) · เทียบแบบ lower เหมือน roleOf() ของหน้าเว็บ
const USER_ROLE_SQL = {
  admin: `lower(u."Role") = 'admin'`,
  it:    `lower(u."Role") = 'it'`,
  staff: `lower(COALESCE(u."Role", '')) NOT IN ('admin', 'it')`,
};

function userWhere(f, p) {
  const w = [];
  if (f.role) w.push(USER_ROLE_SQL[f.role]);
  if (f.q) w.push(`concat_ws(' ', u."Full_Name", u."Position", o."Office_Name", b."Branch_Name", d."Dept_Name") ILIKE ${p.add(f.q)}::text`);
  return w.length ? w.join(' AND ') : 'TRUE';
}

// ยอดบนการ์ด KPI (ทั้งระบบ) + จำนวนที่ตรงตัวกรอง (ใช้แบ่งหน้า) ใน query เดียว
export async function countUsers(db, f) {
  const p = params();
  const rows = await db.q(
    'SELECT COUNT(*)::int AS all_n,' +
    ` (COUNT(*) FILTER (WHERE ${USER_ROLE_SQL.admin}))::int AS admin_n,` +
    ` (COUNT(*) FILTER (WHERE ${USER_ROLE_SQL.it}))::int AS it_n,` +
    ` (COUNT(*) FILTER (WHERE ${userWhere(f, p)}))::int AS n` + USER_FROM, p.list);
  const r = rows[0];
  return { all: num(r.all_n), admin: num(r.admin_n), it: num(r.it_n), n: num(r.n) };
}

// เรียง: แอดมิน -> IT -> ทั่วไป แล้วตามชื่อ (LINE id ต่อท้ายให้ลำดับนิ่ง)
export async function findUsersPage(db, f, size, offset) {
  const p = params();
  const where = userWhere(f, p);
  const rows = await db.q(`
    SELECT
      u."LINE_User_ID", u."Full_Name", u."Position", u."Role",
      b."Branch_Name", o."Office_Name", o."Province", d."Dept_Name",
      (SELECT COUNT(*) FROM "TICKET" t
        WHERE t."LINE_User_ID" = u."LINE_User_ID" AND t."Deleted_At" IS NULL)::int AS "Reported",
      (SELECT COUNT(*) FROM "TICKET" t
        WHERE t."IT_In_Charge" = u."LINE_User_ID" AND t."Deleted_At" IS NULL)::int AS "Assigned"` +
    USER_FROM + `
    WHERE ${where}
    ORDER BY CASE lower(u."Role") WHEN 'admin' THEN 0 WHEN 'it' THEN 1 ELSE 2 END,
             u."Full_Name", u."LINE_User_ID"
    LIMIT ${p.add(size)}::int OFFSET ${p.add(offset)}::int`, p.list);
  return rows.map((r) => ({
    userId: r.LINE_User_ID,
    name: str(r.Full_Name) || '(ไม่มีชื่อ)',
    position: str(r.Position) || '-',
    role: str(r.Role) || 'staff',
    office: str(r.Office_Name),
    branch: str(r.Branch_Name),
    department: str(r.Dept_Name),
    province: str(r.Province),
    reported: num(r.Reported),
    assigned: num(r.Assigned),
  }));
}

export async function findProfile(db, userId) {
  const rows = await db.q(`
    SELECT u."Full_Name", u."Position", u."Role",
           b."Branch_Name", o."Office_Name", o."Province", d."Dept_Name"` + USER_FROM + `
    WHERE u."LINE_User_ID" = $1`, [userId]);
  if (!rows.length) return null;
  const r = rows[0];
  return {
    name: str(r.Full_Name), position: str(r.Position), role: str(r.Role),
    office: str(r.Office_Name), branch: str(r.Branch_Name), department: str(r.Dept_Name), province: str(r.Province),
  };
}

/* ---------------------------------------------------------------------------
   KNOWLEDGE_BASE
   --------------------------------------------------------------------------- */

const KB_FROM = `
    FROM "KNOWLEDGE_BASE" kb
    LEFT JOIN "ISSUE_CATEGORY" c ON c."Category_ID"  = kb."Category_ID"
    LEFT JOIN "TICKET"         t ON t."Ticket_ID"    = kb."Ticket_ID"
    LEFT JOIN "USER"           u ON u."LINE_User_ID" = kb."Created_By"`;

// categoryId: 0 = ทุกหมวด · 'none' = ไม่มีหมวด (NULL) · ตัวเลข = หมวดนั้น
function articleWhere(f, p) {
  const w = [];
  if (f.categoryId === 'none') w.push('kb."Category_ID" IS NULL');
  else if (f.categoryId) w.push(`kb."Category_ID" = ${p.add(f.categoryId)}::int`);
  if (f.q) w.push(`concat_ws(' ', 'TK-' || kb."Ticket_ID", t."Issue_Detail", kb."Resolution_Text") ILIKE ${p.add(f.q)}::text`);
  return w.length ? w.join(' AND ') : 'TRUE';
}

export async function countArticles(db, f) {
  const p = params();
  const rows = await db.q(`SELECT COUNT(*)::int AS n${KB_FROM} WHERE ${articleWhere(f, p)}`, p.list);
  return num(rows[0].n);
}

// ชิพหมวดหมู่: ยอดต่อหมวดของประวัติทั้งหมด (ไม่สนคำค้น) · id = null คือไม่มีหมวด
export async function countArticlesByCategory(db) {
  const rows = await db.q(
    'SELECT kb."Category_ID" AS id, c."Category_Name" AS name, COUNT(*)::int AS n' +
    ' FROM "KNOWLEDGE_BASE" kb LEFT JOIN "ISSUE_CATEGORY" c ON c."Category_ID" = kb."Category_ID"' +
    ' GROUP BY 1, 2 ORDER BY n DESC, 1');
  return rows.map((r) => ({ id: r.id === null || r.id === undefined ? null : num(r.id), name: str(r.name), n: num(r.n) }));
}

export async function findArticlesPage(db, f, size, offset) {
  const p = params();
  const where = articleWhere(f, p);
  const rows = await db.q(`
    SELECT
      kb."KB_ID", kb."Ticket_ID", kb."Resolution_Text", kb."Created_Date", kb."Created_By",
      c."Category_Name", t."Issue_Detail", t."Doc_PDF_URL",
      u."Full_Name" AS "Author_Name"` + KB_FROM + `
    WHERE ${where}
    ORDER BY kb."Created_Date" DESC, kb."KB_ID" DESC
    LIMIT ${p.add(size)}::int OFFSET ${p.add(offset)}::int`, p.list);
  return rows.map((r) => {
    const ticketId = num(r.Ticket_ID);
    return {
      id: num(r.KB_ID), ticketId, ticketCode: ticketCode(ticketId),
      category: str(r.Category_Name), detail: str(r.Issue_Detail), resolution: str(r.Resolution_Text),
      pdfUrl: str(r.Doc_PDF_URL), author: str(r.Author_Name) || '-', createdAt: iso(r.Created_Date),
    };
  });
}

// หมวดหมู่คัดลอกจากตัวตั๋ว · Created_By เป็น FK -> USER
export async function insertArticleFromTicket(db, ticketId, resolutionText, createdBy) {
  const rows = await db.q(`
    INSERT INTO "KNOWLEDGE_BASE" ("Ticket_ID", "Category_ID", "Resolution_Text", "Created_Date", "Created_By")
    SELECT $1::int, "Category_ID", $2::text, NOW(), $3::text
    FROM "TICKET" WHERE "Ticket_ID" = $1::int AND "Deleted_At" IS NULL RETURNING 1`,
    [ticketId, resolutionText, createdBy || null]);
  return rows.length;
}

export async function updateArticleText(db, kbId, resolutionText) {
  const rows = await db.q('UPDATE "KNOWLEDGE_BASE" SET "Resolution_Text" = $1::text WHERE "KB_ID" = $2::int RETURNING 1', [resolutionText, kbId]);
  return rows.length;
}

export async function deleteArticle(db, kbId) {
  const rows = await db.q('DELETE FROM "KNOWLEDGE_BASE" WHERE "KB_ID" = $1::int RETURNING 1', [kbId]);
  return rows.length;
}

/* ---------------------------------------------------------------------------
   ข้อมูลหลัก (Master Data)
   🔒 client ส่งมาแค่ key — ชื่อตาราง/คอลัมน์ที่ต่อเข้า SQL มาจากตารางนี้เท่านั้น
   refs = ตาราง/คอลัมน์ที่อ้างถึงแถวนี้ — ใช้นับการใช้งานและกันลบ
   --------------------------------------------------------------------------- */
export const MASTER_TABLES = {
  office: {
    table: 'EXCISE_OFFICE', id: 'Office_ID', label: 'พื้นที่',
    cols: { name: 'Office_Name', province: 'Province', parentId: 'Parent_Office_ID' }, ints: ['parentId'], required: ['name'],
    refs: [['TICKET', 'Office_ID', 'ตั๋วแจ้งซ่อม'], ['BRANCH', 'Office_ID', 'สาขา'],
           ['EXCISE_OFFICE', 'Parent_Office_ID', 'พื้นที่ในสังกัด']],
  },
  branch: {
    table: 'BRANCH', id: 'Branch_ID', label: 'สาขา',
    cols: { name: 'Branch_Name', officeId: 'Office_ID' }, ints: ['officeId'], required: ['name', 'officeId'],
    refs: [['TICKET', 'Branch_ID', 'ตั๋วแจ้งซ่อม'], ['USER', 'Branch_ID', 'ผู้ใช้งาน']],
  },
  department: {
    table: 'DEPARTMENT', id: 'Dept_ID', label: 'ส่วน',
    cols: { name: 'Dept_Name' }, ints: [], required: ['name'],
    refs: [['TICKET', 'Dept_ID', 'ตั๋วแจ้งซ่อม'], ['USER', 'Dept_ID', 'ผู้ใช้งาน']],
  },
  category: {
    table: 'ISSUE_CATEGORY', id: 'Category_ID', label: 'หมวดหมู่',
    cols: { name: 'Category_Name' }, ints: [], required: ['name'],
    refs: [['TICKET', 'Category_ID', 'ตั๋วแจ้งซ่อม'], ['KNOWLEDGE_BASE', 'Category_ID', 'ประวัติการแจ้งซ่อม']],
  },
};

// withUsage = นับการใช้งานแยกตามตาราง (u0, u1, ...) — ยอดรวมอ่านแล้วเข้าใจผิด
export async function readMasterRows(db, m, withUsage) {
  const keys = Object.keys(m.cols);
  const usage = withUsage ? ', ' + m.refs.map((r, i) =>
    `(SELECT COUNT(*) FROM "${r[0]}" x WHERE x."${r[1]}" = m."${m.id}")::int AS u${i}`).join(', ') : '';
  const rows = await db.q(`SELECT m."${m.id}" AS id, ` +
    keys.map((k) => `m."${m.cols[k]}" AS "${k}"`).join(', ') + usage +
    ` FROM "${m.table}" m ORDER BY m."${m.id}"`);
  return rows.map((r) => {
    const row = { id: num(r.id) };
    if (withUsage) {
      row.used = 0;
      row.usedBy = [];
      m.refs.forEach((ref, i) => {
        const n = num(r['u' + i]);
        row.used += n;
        if (n > 0) row.usedBy.push({ label: ref[2], n });
      });
    }
    keys.forEach((k) => { row[k] = m.ints.includes(k) ? num(r[k]) : str(r[k]); });
    return row;
  });
}

export async function masterNameExists(db, m, name, excludeId) {
  const rows = await db.q(
    `SELECT 1 FROM "${m.table}" WHERE LOWER(TRIM("${m.cols.name}")) = LOWER($1::text) AND "${m.id}" <> $2::int`,
    [name, excludeId || 0]);
  return rows.length > 0;
}

// ค่าตามลำดับคอลัมน์ใน m.cols — ตัวเลขว่างเป็น NULL
const masterValues = (m, values) => Object.keys(m.cols).map((k) => (values[k] || values[k] === 0 ? values[k] : null));
const masterCast = (m, k) => (m.ints.includes(k) ? '::int' : '::text');

async function hasIdDefault(db, m) {
  const rows = await db.q(
    `SELECT column_default, is_identity FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`, [m.table, m.id]);
  return rows.length > 0 && (!!rows[0].column_default || rows[0].is_identity === 'YES');
}

// id มี default (serial/identity) -> ให้ DB ออกเอง (เลื่อน sequence ต่อจาก MAX ก่อน — ข้อมูลตั้งต้นใส่ id เอง)
// ไม่มี default -> MAX+1
export async function insertMasterRow(db, m, values) {
  const keys = Object.keys(m.cols);
  const colList = keys.map((k) => `"${m.cols[k]}"`).join(', ');
  const ph = keys.map((k, i) => `$${i + 1}${masterCast(m, k)}`).join(', ');
  const useDefault = await hasIdDefault(db, m);
  if (useDefault) {
    await db.q(`SELECT setval(pg_get_serial_sequence($1, $2), (SELECT COALESCE(MAX("${m.id}"), 0) + 1 FROM "${m.table}"), false)`,
      [`"${m.table}"`, m.id]);
  }
  const sql = useDefault
    ? `INSERT INTO "${m.table}" (${colList}) VALUES (${ph}) RETURNING "${m.id}" AS id`
    : `INSERT INTO "${m.table}" ("${m.id}", ${colList}) SELECT COALESCE(MAX("${m.id}"), 0) + 1, ${ph} FROM "${m.table}" RETURNING "${m.id}" AS id`;
  const rows = await db.q(sql, masterValues(m, values));
  return rows.length ? num(rows[0].id) : null;
}

export async function updateMasterRow(db, m, id, values) {
  const keys = Object.keys(m.cols);
  const set = keys.map((k, i) => `"${m.cols[k]}" = $${i + 1}${masterCast(m, k)}`).join(', ');
  const rows = await db.q(`UPDATE "${m.table}" SET ${set} WHERE "${m.id}" = $${keys.length + 1}::int RETURNING 1`,
    masterValues(m, values).concat([id]));
  return rows.length;
}

// [{ label, n }] ของตารางที่ยังอ้างถึงแถวนี้ (n > 0 เท่านั้น)
export async function countMasterRefs(db, m, id) {
  const inUse = [];
  for (const r of m.refs) {
    const rows = await db.q(`SELECT COUNT(*)::int AS n FROM "${r[0]}" WHERE "${r[1]}" = $1::int`, [id]);
    const n = num(rows[0].n);
    if (n > 0) inUse.push({ label: r[2], n });
  }
  return inUse;
}

export async function findOffice(db, officeId) {
  const rows = await db.q('SELECT "Office_ID", "Office_Name", "Parent_Office_ID" FROM "EXCISE_OFFICE" WHERE "Office_ID" = $1::int', [officeId]);
  if (!rows.length) return null;
  const r = rows[0];
  return { id: num(r.Office_ID), name: str(r.Office_Name), parentId: num(r.Parent_Office_ID) };
}

export async function countChildOffices(db, officeId) {
  const rows = await db.q('SELECT COUNT(*)::int AS n FROM "EXCISE_OFFICE" WHERE "Parent_Office_ID" = $1::int', [officeId]);
  return num(rows[0].n);
}

// เปลี่ยนชื่อพื้นที่ -> เปลี่ยนคำนำหน้าชื่อทุกสาขาในพื้นที่นั้น · left() ไม่ใช่ LIKE (กัน % _ เป็น wildcard)
export async function renameBranchPrefix(db, officeId, oldName, newName) {
  const rows = await db.q(`
    UPDATE "BRANCH" SET "Branch_Name" = $1::text || substr("Branch_Name", $2::int)
    WHERE "Office_ID" = $3::int AND left("Branch_Name", $4::int) = $5::text RETURNING 1`,
    [newName, oldName.length + 1, officeId, oldName.length, oldName]);
  return rows.length;
}

export async function deleteMasterRow(db, m, id) {
  const rows = await db.q(`DELETE FROM "${m.table}" WHERE "${m.id}" = $1::int RETURNING 1`, [id]);
  return rows.length;
}
