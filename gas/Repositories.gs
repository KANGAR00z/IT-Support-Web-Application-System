/* =============================================================================
   FAST TICKET · Repositories.gs — SQL ทั้งหมดของระบบ
   -----------------------------------------------------------------------------
   ทุกฟังก์ชันรับ conn จากผู้เรียก (use case เป็นคนเปิด/ปิด/คุม transaction)
   ค่าจากผู้ใช้ผ่าน PreparedStatement (?) เสมอ — ห้ามต่อสตริงเข้า SQL
   ชื่อตาราง/คอลัมน์ที่ต่อสตริงได้ มาจากค่าคงที่ในไฟล์นี้เท่านั้น (MASTER_TABLES)

   ชื่อตาราง/คอลัมน์ case-sensitive ต้องใส่ double quote ทุกครั้ง ("USER", "LINE_User_ID")
   โครงสร้างหน่วยงาน: EXCISE_OFFICE (พื้นที่) -> BRANCH (สาขา) · DEPARTMENT (ส่วน) ใช้ร่วมทุกสาขา
   ============================================================================= */

/* ---------------------------------------------------------------------------
   TICKET
   --------------------------------------------------------------------------- */

// LEFT JOIN กันตั๋วหายถ้า master data ขาด · JOIN "USER" 2 ครั้ง: ผู้แจ้ง (u) + ผู้รับงาน (it)
const TICKET_FROM_SQL_ = `
    FROM "TICKET" t
    LEFT JOIN "ISSUE_CATEGORY" c  ON c."Category_ID"   = t."Category_ID"
    LEFT JOIN "EXCISE_OFFICE"  o  ON o."Office_ID"     = t."Office_ID"
    LEFT JOIN "BRANCH"         b  ON b."Branch_ID"     = t."Branch_ID"
    LEFT JOIN "DEPARTMENT"     d  ON d."Dept_ID"       = t."Dept_ID"
    LEFT JOIN "USER"           u  ON u."LINE_User_ID"  = t."LINE_User_ID"
    LEFT JOIN "USER"           it ON it."LINE_User_ID" = t."IT_In_Charge"`;

// withResolution: แนบวิธีแก้ล่าสุด (ตั๋วที่ปิด-เปิด-ปิดซ้ำมี KB หลายแถว เอาอันล่าสุดอันเดียว)
// extraCol: คอลัมน์เพิ่ม (เช่นลำดับในคอลัมน์บอร์ด) — ข้อความ SQL จากไฟล์นี้เท่านั้น
function ticketSelectSql_(withResolution, extraCol) {
  return `
    SELECT
      t."Ticket_ID", t."Issue_Detail", t."Status", t."IT_In_Charge", t."Doc_PDF_URL",
      t."Created_Date", t."Accepted_Date", t."Closed_Date", t."Deleted_At",
      c."Category_Name", o."Office_Name", o."Province", b."Branch_Name", d."Dept_Name",
      u."Full_Name"  AS "Reporter_Name",
      it."Full_Name" AS "Assignee_Name"` +
      (withResolution ? `,
      (SELECT kb."Resolution_Text" FROM "KNOWLEDGE_BASE" kb
        WHERE kb."Ticket_ID" = t."Ticket_ID"
        ORDER BY kb."Created_Date" DESC LIMIT 1) AS "Resolution_Text"` : '') +
      (extraCol ? `,
      ` + extraCol : '') + TICKET_FROM_SQL_;
}

function mapTicket_(rs, withResolution) {
  const id = rs.getInt('Ticket_ID');
  const t = {
    id: id,
    code: ticketCode_(id),
    detail: strOrNull_(rs, 'Issue_Detail') || '(ไม่มีรายละเอียด)',
    category: strOrNull_(rs, 'Category_Name') || '',
    office: strOrNull_(rs, 'Office_Name') || '',
    branch: strOrNull_(rs, 'Branch_Name') || '',     // ว่าง = ตั๋วเก่าที่ไม่รู้สาขา
    department: strOrNull_(rs, 'Dept_Name') || '',   // ว่าง = ตั๋วก่อนเริ่มเก็บส่วน (2026-10-06)
    province: strOrNull_(rs, 'Province') || '',
    reporter: strOrNull_(rs, 'Reporter_Name') || '-',
    // IT_In_Charge เก็บเป็น LINE_User_ID (FK) แปลงเป็นชื่อให้หน้าเว็บ — ไม่พบชื่อ: บอร์ด IT ใช้ id แทน
    // แต่หน้าประวัติของผู้แจ้ง (withResolution) ไม่โชว์ LINE id ของเจ้าหน้าที่
    assignee: strOrNull_(rs, 'Assignee_Name') || (withResolution ? null : strOrNull_(rs, 'IT_In_Charge')),
    status: rs.getInt('Status'),
    createdAt: toIsoLocal_(rs, 'Created_Date'),
    acceptedAt: toIsoLocal_(rs, 'Accepted_Date'),
    closedAt: toIsoLocal_(rs, 'Closed_Date'),
    pdfUrl: strOrNull_(rs, 'Doc_PDF_URL') || ''
  };
  if (withResolution) {
    t.resolution = strOrNull_(rs, 'Resolution_Text') || '';
    t.cancelled = !!strOrNull_(rs, 'Deleted_At');
  }
  return t;
}

/* ---------- บอร์ด (Kanban) — แบ่งหน้าแยกแต่ละคอลัมน์ ---------- */

// ข้อความที่ค้นได้ของตั๋ว (รหัส/อาการ/ผู้แจ้ง/ผู้รับงาน/หน่วยงาน/หมวดหมู่) — concat_ws ข้าม NULL ให้เอง
const TICKET_SEARCH_SQL_ = `concat_ws(' ', 'TK-' || t."Ticket_ID", t."Issue_Detail", u."Full_Name", it."Full_Name",
      b."Branch_Name", d."Dept_Name", o."Office_Name", o."Province", c."Category_Name")`;

// ตัวกรองของบอร์ด -> { sql, params } · f มาจาก boardFilter_ (UseCases) ที่ตรวจค่าแล้ว
// ไม่รวม "ยังไม่ถูกยกเลิก" — ผู้เรียกใส่เอง เพราะยอดก่อนกรองต้องนับแยก
function boardWhere_(f) {
  const w = [];
  const p = [];
  if (f.categoryId) { w.push('t."Category_ID" = ?'); p.push(['i', f.categoryId]); }
  if (f.province)   { w.push(`strpos(COALESCE(o."Province", ''), ?) > 0`); p.push(['s', f.province]); }
  if (f.assignee)   { w.push('t."IT_In_Charge" = ?'); p.push(['s', f.assignee]); }
  // ช่วงเวลามีผลกับงานที่เสร็จแล้วเท่านั้น — งานที่ยังไม่เสร็จต้องเห็นเสมอ ไม่ว่าแจ้งมานานแค่ไหน
  if (f.closedDays) {
    w.push('(t."Status" <> ' + TICKET_STATUS.CLOSED +
      ' OR t."Closed_Date" IS NULL OR t."Closed_Date" >= NOW() - make_interval(days => ?))');
    p.push(['i', f.closedDays]);
  }
  if (f.q) { w.push(TICKET_SEARCH_SQL_ + ' ILIKE ?'); p.push(['s', f.q]); }
  return { sql: w.length ? w.join(' AND ') : 'TRUE', params: p };
}

// { [status]: { n: ยอดที่ตรงตัวกรอง, all: ยอดทั้งคอลัมน์ } } — หัวคอลัมน์แสดง "n/all" ตอนกรองอยู่
function countBoardTickets_(conn, f) {
  const w = boardWhere_(f);
  const stmt = conn.prepareStatement(
    'SELECT t."Status" AS s, COUNT(*) AS all_n, COUNT(*) FILTER (WHERE ' + w.sql + ') AS n' +
    TICKET_FROM_SQL_ + ' WHERE t."Deleted_At" IS NULL GROUP BY t."Status"');
  bindParams_(stmt, w.params);
  const rs = stmt.executeQuery();
  const out = {};
  while (rs.next()) out[rs.getInt('s')] = { n: rs.getInt('n'), all: rs.getInt('all_n') };
  return out;
}

// การ์ดหน้าที่ขอของทุกคอลัมน์ใน query เดียว — cols = [{ status, page }]
// ลำดับในคอลัมน์ = เวลาที่ตรงกับสถานะนั้น (เสร็จสิ้นเรียงตามเวลาปิด ไม่ใช่เวลาแจ้ง) · id ต่อท้ายให้ลำดับนิ่ง
function findBoardPage_(conn, f, size, cols) {
  const w = boardWhere_(f);
  const dir = f.desc ? 'DESC' : 'ASC';
  const key = 'CASE t."Status"' +
    ' WHEN ' + TICKET_STATUS.CLOSED + ' THEN COALESCE(t."Closed_Date", t."Created_Date")' +
    ' WHEN ' + TICKET_STATUS.IN_PROGRESS + ' THEN COALESCE(t."Accepted_Date", t."Created_Date")' +
    ' ELSE t."Created_Date" END';
  const rn = 'ROW_NUMBER() OVER (PARTITION BY t."Status" ORDER BY ' + key + ' ' + dir + ', t."Ticket_ID" ' + dir + ') AS rn';
  const stmt = conn.prepareStatement(
    'SELECT * FROM (' + ticketSelectSql_(false, rn) + ' WHERE t."Deleted_At" IS NULL AND ' + w.sql + ') x WHERE ' +
    cols.map(function () { return '(x."Status" = ? AND x.rn > ? AND x.rn <= ?)'; }).join(' OR ') +
    ' ORDER BY x."Status", x.rn');
  let i = bindParams_(stmt, w.params);
  cols.forEach(function (c) {
    stmt.setInt(i++, c.status);
    stmt.setInt(i++, (c.page - 1) * size);
    stmt.setInt(i++, c.page * size);
  });
  const rs = stmt.executeQuery();
  const list = [];
  while (rs.next()) list.push(mapTicket_(rs, false));
  return list;
}

// แดชบอร์ดทั้งหน้าใน query เดียว (Postgres ประกอบ JSON ให้) — ไม่ต้องส่งตั๋วทุกใบไปคำนวณที่หน้าเว็บ
// และไป-กลับ DB รอบเดียว (GAS -> โตเกียว ~0.1-0.3 วิต่อรอบ) · ไม่นับงานที่ถูกยกเลิก
// เวลาเฉลี่ยเป็นมิลลิวินาที · trend = ยอดแจ้งรายวันตามเวลาไทย 32 วันล่าสุด (หน้าเว็บตัดเหลือ 30 วันเอง)
// oldest.createdAt ใช้ to_char เป็น ISO แบบ UTC — Safari parse รูปแบบดิบของ Postgres ไม่ได้ (ดู toIsoLocal_)
function readDashboard_(conn, agingDays) {
  const stmt = conn.prepareStatement(`
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
                                    AND "Created_Date" < NOW() - make_interval(days => ?)))
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
    )::text AS j
  `);
  stmt.setInt(1, agingDays);
  const rs = stmt.executeQuery();
  rs.next();
  return JSON.parse(rs.getString('j'));
}

// ตั๋วของผู้แจ้งคนหนึ่ง รวมที่ถูกยกเลิก (หน้าประวัติแสดงว่า "ยกเลิกแล้ว" ไม่ให้หายเงียบ)
function findTicketsByReporter_(conn, userId) {
  const stmt = conn.prepareStatement(ticketSelectSql_(true) +
    ' WHERE t."LINE_User_ID" = ? ORDER BY t."Ticket_ID" DESC');
  stmt.setString(1, userId);
  const rs = stmt.executeQuery();
  const list = [];
  while (rs.next()) list.push(mapTicket_(rs, true));
  return list;
}

// t = { reporterId, officeId, branchId, departmentId, categoryId, issueDetail, imageUrl, docPdfUrl }
// พื้นที่ (Office_ID) เอาจากสาขาฝั่ง server ให้ตรงกันเสมอ — ใช้ค่าจาก client เฉพาะเมื่อไม่รู้จักสาขานั้น
// สาขา/ส่วนผ่าน SELECT ก่อน: id ที่ไม่มีจริง (ถูกลบไปแล้ว / ตัวเลือกสำรองของหน้าเว็บที่ DB ยังไม่มี)
// เป็น NULL แทน FK error ที่ทำให้แจ้งซ่อมไม่ได้ทั้งใบ — พื้นที่ยังได้จากค่าที่ client ส่งมา
function insertTicket_(conn, t) {
  const stmt = conn.prepareStatement(`
    INSERT INTO "TICKET"
      ("LINE_User_ID", "Office_ID", "Branch_ID", "Dept_ID", "Category_ID",
       "Issue_Detail", "Image_URL", "Doc_PDF_URL", "Status")
    VALUES (?, COALESCE((SELECT "Office_ID" FROM "BRANCH" WHERE "Branch_ID" = ?), ?),
            (SELECT "Branch_ID" FROM "BRANCH" WHERE "Branch_ID" = ?),
            (SELECT "Dept_ID" FROM "DEPARTMENT" WHERE "Dept_ID" = ?), ?, ?, ?, ?, ?)
    RETURNING "Ticket_ID"
  `);
  stmt.setString(1, t.reporterId);
  setIntOrNull_(stmt, 2, t.branchId);
  setIntOrNull_(stmt, 3, t.officeId);
  setIntOrNull_(stmt, 4, t.branchId);
  stmt.setInt(5, t.departmentId || 0);
  stmt.setInt(6, t.categoryId);
  stmt.setString(7, t.issueDetail);
  setStringOrNull(stmt, 8, t.imageUrl);
  setStringOrNull(stmt, 9, t.docPdfUrl);
  stmt.setInt(10, TICKET_STATUS.OPEN);
  const rs = stmt.executeQuery();
  return rs.next() ? rs.getInt('Ticket_ID') : null;
}

// รับงาน: ผู้รับ + เวลา · ล้าง Closed_Date เผื่อรับงานที่เคยปิดแล้วเปิดใหม่ — คืนจำนวนแถวที่แก้
function markTicketAccepted_(conn, ticketId, staffUserId) {
  const stmt = conn.prepareStatement(`
    UPDATE "TICKET"
    SET "Status" = ?, "IT_In_Charge" = ?, "Accepted_Date" = NOW(), "Closed_Date" = NULL
    WHERE "Ticket_ID" = ? AND "Deleted_At" IS NULL
  `);
  stmt.setInt(1, TICKET_STATUS.IN_PROGRESS);
  stmt.setString(2, staffUserId);
  stmt.setInt(3, ticketId);
  return stmt.executeUpdate();
}

// เปลี่ยนสถานะ + เวลาที่สอดคล้อง: ปิด = ลงเวลาปิด · เปิดใหม่ = ล้างผู้รับ/เวลาทั้งหมด
// · กำลังทำ = ล้างเวลาปิด และลงเวลารับเรื่องถ้ายังไม่มี
function updateTicketStatusRow_(conn, ticketId, status) {
  let set;
  if (status === TICKET_STATUS.CLOSED) {
    set = '"Status" = ?, "Closed_Date" = NOW()';
  } else if (status === TICKET_STATUS.OPEN) {
    set = '"Status" = ?, "IT_In_Charge" = NULL, "Accepted_Date" = NULL, "Closed_Date" = NULL';
  } else {
    set = '"Status" = ?, "Closed_Date" = NULL, "Accepted_Date" = COALESCE("Accepted_Date", NOW())';
  }
  const stmt = conn.prepareStatement(
    'UPDATE "TICKET" SET ' + set + ' WHERE "Ticket_ID" = ? AND "Deleted_At" IS NULL');
  stmt.setInt(1, status);
  stmt.setInt(2, ticketId);
  return stmt.executeUpdate();
}

// ยกเลิกงาน (soft delete) — แถว + PDF ยังอยู่ กู้คืนด้วย SQL ได้ (ดู sql/2026-10-09-rename-org-tables.sql)
function softDeleteTicket_(conn, ticketId, byUserId) {
  const stmt = conn.prepareStatement(`
    UPDATE "TICKET" SET "Deleted_At" = NOW(), "Deleted_By" = ?
    WHERE "Ticket_ID" = ? AND "Deleted_At" IS NULL
  `);
  stmt.setString(1, byUserId);
  stmt.setInt(2, ticketId);
  return stmt.executeUpdate();
}

// มีตั๋วไหนใช้ไฟล์ Drive นี้เป็นเอกสารฉบับจริงอยู่ไหม (ห้ามลบไฟล์แบบนั้นในฐานะ "ไฟล์ชั่วคราว")
function isPdfUsedByTicket_(conn, fileId) {
  const stmt = conn.prepareStatement(
    'SELECT 1 FROM "TICKET" WHERE "Doc_PDF_URL" LIKE ? LIMIT 1');
  stmt.setString(1, '%' + fileId + '%');
  return stmt.executeQuery().next();
}

/* ---------------------------------------------------------------------------
   USER
   --------------------------------------------------------------------------- */

// Upsert ผู้แจ้ง — DO UPDATE ไม่แตะ "Role" (ผู้ใช้เดิมคง role เดิม ผู้ใช้ใหม่ได้ 'Staff')
// สาขา/ส่วนของผู้ใช้ = ค่าล่าสุดที่กรอก (ถูกเขียนทับทุกครั้ง — ของตั๋วเก็บแยกใน TICKET)
function upsertReporter_(conn, u) {
  const stmt = conn.prepareStatement(`
    INSERT INTO "USER" ("LINE_User_ID", "Full_Name", "Position", "Role", "Branch_ID", "Dept_ID")
    VALUES (?, ?, ?, ?, (SELECT "Branch_ID" FROM "BRANCH" WHERE "Branch_ID" = ?),
            (SELECT "Dept_ID" FROM "DEPARTMENT" WHERE "Dept_ID" = ?))
    ON CONFLICT ("LINE_User_ID")
    DO UPDATE SET
      "Full_Name"  = EXCLUDED."Full_Name",
      "Position"   = EXCLUDED."Position",
      "Branch_ID"  = EXCLUDED."Branch_ID",
      "Dept_ID" = EXCLUDED."Dept_ID"
  `);
  stmt.setString(1, u.userId);
  stmt.setString(2, u.name);
  stmt.setString(3, u.position);
  stmt.setString(4, ROLE_DB_VALUE.staff);
  stmt.setInt(5, u.branchId);
  stmt.setInt(6, u.departmentId || 0);
  stmt.executeUpdate();
}

function findUserName_(conn, userId) {
  const stmt = conn.prepareStatement('SELECT "Full_Name" FROM "USER" WHERE "LINE_User_ID" = ?');
  stmt.setString(1, userId);
  const rs = stmt.executeQuery();
  return rs.next() ? (rs.getString('Full_Name') || '') : null;   // null = ไม่มีบัญชี
}

// คืน 'Staff'/'IT'/'Admin' หรือ null (ไม่มีบัญชี)
function findUserRole_(conn, userId) {
  const stmt = conn.prepareStatement('SELECT "Role" FROM "USER" WHERE "LINE_User_ID" = ?');
  stmt.setString(1, userId);
  const rs = stmt.executeQuery();
  return rs.next() ? rs.getString('Role') : null;
}

function countAdmins_(conn) {
  const stmt = conn.prepareStatement('SELECT COUNT(*) AS n FROM "USER" WHERE "Role" = ?');
  stmt.setString(1, ROLE_DB_VALUE.admin);
  const r = stmt.executeQuery();
  r.next();
  return r.getInt('n');
}

function updateUserRoleRow_(conn, userId, dbRole) {
  const stmt = conn.prepareStatement('UPDATE "USER" SET "Role" = ? WHERE "LINE_User_ID" = ?');
  stmt.setString(1, dbRole);
  stmt.setString(2, userId);
  return stmt.executeUpdate();
}

const USER_FROM_SQL_ = `
    FROM "USER" u
    LEFT JOIN "BRANCH"        b ON b."Branch_ID" = u."Branch_ID"
    LEFT JOIN "EXCISE_OFFICE" o ON o."Office_ID" = b."Office_ID"
    LEFT JOIN "DEPARTMENT"    d ON d."Dept_ID"   = u."Dept_ID"`;

// ตัวกรองบทบาท — client เลือกได้แค่ key ในนี้ (ข้อความ SQL เป็นค่าคงที่ ไม่ใช่ค่าจากผู้ใช้)
// เทียบแบบ lower เหมือน roleOf() ของหน้าเว็บ
const USER_ROLE_SQL_ = {
  admin: `lower(u."Role") = 'admin'`,
  it:    `lower(u."Role") = 'it'`,
  staff: `lower(COALESCE(u."Role", '')) NOT IN ('admin', 'it')`
};

// f = { q: pattern จาก likePattern_, role: 'admin'|'it'|'staff'|'' }
function userWhere_(f) {
  const w = [];
  const p = [];
  if (f.role) w.push(USER_ROLE_SQL_[f.role]);
  if (f.q) {
    w.push(`concat_ws(' ', u."Full_Name", u."Position", o."Office_Name", b."Branch_Name", d."Dept_Name") ILIKE ?`);
    p.push(['s', f.q]);
  }
  return { sql: w.length ? w.join(' AND ') : 'TRUE', params: p };
}

// ยอดบนการ์ด KPI (ทั้งระบบ ไม่สนตัวกรอง) + จำนวนที่ตรงตัวกรอง (ใช้แบ่งหน้า) ใน query เดียว
function countUsers_(conn, f) {
  const w = userWhere_(f);
  const stmt = conn.prepareStatement(
    'SELECT COUNT(*) AS all_n,' +
    ' COUNT(*) FILTER (WHERE ' + USER_ROLE_SQL_.admin + ') AS admin_n,' +
    ' COUNT(*) FILTER (WHERE ' + USER_ROLE_SQL_.it + ') AS it_n,' +
    ' COUNT(*) FILTER (WHERE ' + w.sql + ') AS n' + USER_FROM_SQL_);
  bindParams_(stmt, w.params);
  const rs = stmt.executeQuery();
  rs.next();
  return { all: rs.getInt('all_n'), admin: rs.getInt('admin_n'), it: rs.getInt('it_n'), n: rs.getInt('n') };
}

// ยอดแจ้งซ่อม/รับผิดชอบเป็น subquery ต่อแถว — นับเฉพาะคนในหน้านี้ ไม่ JOIN ตั๋วทั้งตาราง · ไม่นับงานที่ถูกยกเลิก
// เรียง: แอดมิน -> IT -> ทั่วไป แล้วตามชื่อ (LINE id ต่อท้ายให้ลำดับนิ่ง คนไม่สลับข้ามหน้า)
function findUsersPage_(conn, f, size, offset) {
  const w = userWhere_(f);
  const stmt = conn.prepareStatement(`
    SELECT
      u."LINE_User_ID", u."Full_Name", u."Position", u."Role",
      b."Branch_Name", o."Office_Name", o."Province", d."Dept_Name",
      (SELECT COUNT(*) FROM "TICKET" t
        WHERE t."LINE_User_ID" = u."LINE_User_ID" AND t."Deleted_At" IS NULL) AS "Reported",
      (SELECT COUNT(*) FROM "TICKET" t
        WHERE t."IT_In_Charge" = u."LINE_User_ID" AND t."Deleted_At" IS NULL) AS "Assigned"` +
    USER_FROM_SQL_ + `
    WHERE ` + w.sql + `
    ORDER BY CASE lower(u."Role") WHEN 'admin' THEN 0 WHEN 'it' THEN 1 ELSE 2 END,
             u."Full_Name", u."LINE_User_ID"
    LIMIT ? OFFSET ?`);
  const i = bindParams_(stmt, w.params);
  stmt.setInt(i, size);
  stmt.setInt(i + 1, offset);
  const rs = stmt.executeQuery();
  const list = [];
  while (rs.next()) {
    list.push({
      userId: rs.getString('LINE_User_ID'),
      name: strOrNull_(rs, 'Full_Name') || '(ไม่มีชื่อ)',
      position: strOrNull_(rs, 'Position') || '-',
      role: strOrNull_(rs, 'Role') || 'staff',
      office: strOrNull_(rs, 'Office_Name') || '',
      branch: strOrNull_(rs, 'Branch_Name') || '',
      department: strOrNull_(rs, 'Dept_Name') || '',
      province: strOrNull_(rs, 'Province') || '',
      reported: rs.getInt('Reported'),
      assigned: rs.getInt('Assigned')
    });
  }
  return list;
}

function findProfile_(conn, userId) {
  const stmt = conn.prepareStatement(`
    SELECT u."Full_Name", u."Position", u."Role",
           b."Branch_Name", o."Office_Name", o."Province", d."Dept_Name"
    FROM "USER" u
    LEFT JOIN "BRANCH"  b ON b."Branch_ID"  = u."Branch_ID"
    LEFT JOIN "EXCISE_OFFICE"  o  ON o."Office_ID"     = b."Office_ID"
    LEFT JOIN "DEPARTMENT"     d  ON d."Dept_ID"       = u."Dept_ID"
    WHERE u."LINE_User_ID" = ?
  `);
  stmt.setString(1, userId);
  const rs = stmt.executeQuery();
  if (!rs.next()) return null;
  return {
    name: strOrNull_(rs, 'Full_Name') || '',
    position: strOrNull_(rs, 'Position') || '',
    role: strOrNull_(rs, 'Role') || '',
    office: strOrNull_(rs, 'Office_Name') || '',
    branch: strOrNull_(rs, 'Branch_Name') || '',
    department: strOrNull_(rs, 'Dept_Name') || '',
    province: strOrNull_(rs, 'Province') || ''
  };
}

/* ---------------------------------------------------------------------------
   KNOWLEDGE_BASE
   --------------------------------------------------------------------------- */

const KB_FROM_SQL_ = `
    FROM "KNOWLEDGE_BASE" kb
    LEFT JOIN "ISSUE_CATEGORY" c ON c."Category_ID"  = kb."Category_ID"
    LEFT JOIN "TICKET"         t ON t."Ticket_ID"    = kb."Ticket_ID"
    LEFT JOIN "USER"           u ON u."LINE_User_ID" = kb."Created_By"`;

// f = { q, categoryId } · categoryId: 0 = ทุกหมวด · 'none' = ไม่มีหมวด (NULL) · ตัวเลข = หมวดนั้น
function articleWhere_(f) {
  const w = [];
  const p = [];
  if (f.categoryId === 'none') w.push('kb."Category_ID" IS NULL');
  else if (f.categoryId) { w.push('kb."Category_ID" = ?'); p.push(['i', f.categoryId]); }
  if (f.q) {
    w.push(`concat_ws(' ', 'TK-' || kb."Ticket_ID", t."Issue_Detail", kb."Resolution_Text") ILIKE ?`);
    p.push(['s', f.q]);
  }
  return { sql: w.length ? w.join(' AND ') : 'TRUE', params: p };
}

function countArticles_(conn, f) {
  const w = articleWhere_(f);
  const stmt = conn.prepareStatement('SELECT COUNT(*) AS n' + KB_FROM_SQL_ + ' WHERE ' + w.sql);
  bindParams_(stmt, w.params);
  const rs = stmt.executeQuery();
  return rs.next() ? rs.getInt('n') : 0;
}

// ชิพหมวดหมู่: ยอดต่อหมวดของประวัติทั้งหมด (ไม่สนคำค้น) · id = null คือไม่มีหมวด
function countArticlesByCategory_(conn) {
  const rs = conn.prepareStatement(
    'SELECT kb."Category_ID" AS id, c."Category_Name" AS name, COUNT(*) AS n' +
    ' FROM "KNOWLEDGE_BASE" kb LEFT JOIN "ISSUE_CATEGORY" c ON c."Category_ID" = kb."Category_ID"' +
    ' GROUP BY 1, 2 ORDER BY n DESC, 1').executeQuery();
  const list = [];
  while (rs.next()) {
    list.push({ id: strOrNull_(rs, 'id') ? rs.getInt('id') : null, name: strOrNull_(rs, 'name') || '', n: rs.getInt('n') });
  }
  return list;
}

function findArticlesPage_(conn, f, size, offset) {
  const w = articleWhere_(f);
  const stmt = conn.prepareStatement(`
    SELECT
      kb."KB_ID", kb."Ticket_ID", kb."Resolution_Text", kb."Created_Date", kb."Created_By",
      c."Category_Name", t."Issue_Detail", t."Doc_PDF_URL",
      u."Full_Name" AS "Author_Name"` +
    KB_FROM_SQL_ + `
    WHERE ` + w.sql + `
    ORDER BY kb."Created_Date" DESC, kb."KB_ID" DESC
    LIMIT ? OFFSET ?`);
  const i = bindParams_(stmt, w.params);
  stmt.setInt(i, size);
  stmt.setInt(i + 1, offset);
  const rs = stmt.executeQuery();
  const list = [];
  while (rs.next()) {
    const ticketId = rs.getInt('Ticket_ID');
    list.push({
      id: rs.getInt('KB_ID'),
      ticketId: ticketId,
      ticketCode: ticketCode_(ticketId),
      category: strOrNull_(rs, 'Category_Name') || '',
      detail: strOrNull_(rs, 'Issue_Detail') || '',
      resolution: strOrNull_(rs, 'Resolution_Text') || '',
      pdfUrl: strOrNull_(rs, 'Doc_PDF_URL') || '',
      author: strOrNull_(rs, 'Author_Name') || '-',
      createdAt: toIsoLocal_(rs, 'Created_Date')
    });
  }
  return list;
}

// หมวดหมู่คัดลอกจากตัวตั๋ว · Created_By เป็น FK -> USER (fk_kb_creator) — คืนจำนวนแถวที่เพิ่ม
function insertArticleFromTicket_(conn, ticketId, resolutionText, createdBy) {
  const stmt = conn.prepareStatement(`
    INSERT INTO "KNOWLEDGE_BASE" ("Ticket_ID", "Category_ID", "Resolution_Text", "Created_Date", "Created_By")
    SELECT ?, "Category_ID", ?, NOW(), ?
    FROM "TICKET" WHERE "Ticket_ID" = ? AND "Deleted_At" IS NULL
  `);
  stmt.setInt(1, ticketId);
  stmt.setString(2, resolutionText);
  setStringOrNull(stmt, 3, createdBy);
  stmt.setInt(4, ticketId);
  return stmt.executeUpdate();
}

function updateArticleText_(conn, kbId, resolutionText) {
  const stmt = conn.prepareStatement('UPDATE "KNOWLEDGE_BASE" SET "Resolution_Text" = ? WHERE "KB_ID" = ?');
  stmt.setString(1, resolutionText);
  stmt.setInt(2, kbId);
  return stmt.executeUpdate();
}

function deleteArticle_(conn, kbId) {
  const stmt = conn.prepareStatement('DELETE FROM "KNOWLEDGE_BASE" WHERE "KB_ID" = ?');
  stmt.setInt(1, kbId);
  return stmt.executeUpdate();
}

/* ---------------------------------------------------------------------------
   ข้อมูลหลัก (Master Data) — EXCISE_OFFICE / BRANCH / DEPARTMENT / ISSUE_CATEGORY
   🔒 client ส่งมาแค่ key ('office'/'branch'/'department'/'category') — ชื่อตาราง/คอลัมน์ที่ต่อเข้า SQL
      มาจากตารางนี้เท่านั้น ห้ามรับชื่อคอลัมน์จาก client (SQL injection)
   refs = ตาราง/คอลัมน์ที่อ้างถึงแถวนี้ — ใช้นับการใช้งานและกันลบ
   --------------------------------------------------------------------------- */
const MASTER_TABLES = {
  office: {
    table: 'EXCISE_OFFICE', id: 'Office_ID', label: 'พื้นที่',
    cols: { name: 'Office_Name', province: 'Province', parentId: 'Parent_Office_ID' }, ints: ['parentId'], required: ['name'],
    refs: [['TICKET', 'Office_ID', 'ตั๋วแจ้งซ่อม'], ['BRANCH', 'Office_ID', 'สาขา'],
           ['EXCISE_OFFICE', 'Parent_Office_ID', 'พื้นที่ในสังกัด']]
  },
  branch: {
    table: 'BRANCH', id: 'Branch_ID', label: 'สาขา',
    cols: { name: 'Branch_Name', officeId: 'Office_ID' }, ints: ['officeId'], required: ['name', 'officeId'],
    refs: [['TICKET', 'Branch_ID', 'ตั๋วแจ้งซ่อม'], ['USER', 'Branch_ID', 'ผู้ใช้งาน']]
  },
  department: {
    table: 'DEPARTMENT', id: 'Dept_ID', label: 'ส่วน',
    cols: { name: 'Dept_Name' }, ints: [], required: ['name'],
    refs: [['TICKET', 'Dept_ID', 'ตั๋วแจ้งซ่อม'], ['USER', 'Dept_ID', 'ผู้ใช้งาน']]
  },
  category: {
    table: 'ISSUE_CATEGORY', id: 'Category_ID', label: 'หมวดหมู่',
    cols: { name: 'Category_Name' }, ints: [], required: ['name'],
    refs: [['TICKET', 'Category_ID', 'ตั๋วแจ้งซ่อม'], ['KNOWLEDGE_BASE', 'Category_ID', 'ประวัติการแจ้งซ่อม']]
  }
};

// withUsage = นับการใช้งานแยกตามตาราง (u0, u1, ...) — แยกไว้เพราะยอดรวมอ่านแล้วเข้าใจผิด
// (เช่น พื้นที่ "ใช้อยู่ 4" จริงๆ คือ ตั๋ว 1 + สาขาในพื้นที่ 3)
function readMasterRows_(conn, m, withUsage) {
  const colKeys = Object.keys(m.cols);
  const usage = withUsage ? ', ' + m.refs.map(function (r, i) {
    return '(SELECT COUNT(*) FROM "' + r[0] + '" x WHERE x."' + r[1] + '" = m."' + m.id + '") AS u' + i;
  }).join(', ') : '';
  const sql = 'SELECT m."' + m.id + '" AS id, ' +
    colKeys.map(function (k) { return 'm."' + m.cols[k] + '" AS "' + k + '"'; }).join(', ') +
    usage + ' FROM "' + m.table + '" m ORDER BY m."' + m.id + '"';
  const rs = conn.createStatement().executeQuery(sql);
  const rows = [];
  while (rs.next()) {
    const row = { id: rs.getInt('id') };
    if (withUsage) {
      row.used = 0;
      row.usedBy = [];
      m.refs.forEach(function (r, i) {
        const n = rs.getInt('u' + i);
        row.used += n;
        if (n > 0) row.usedBy.push({ label: r[2], n: n });
      });
    }
    colKeys.forEach(function (k) {
      row[k] = m.ints.indexOf(k) !== -1 ? rs.getInt(k) : (strOrNull_(rs, k) || '');
    });
    rows.push(row);
  }
  return rows;
}

function masterNameExists_(conn, m, name, excludeId) {
  const stmt = conn.prepareStatement(
    'SELECT 1 FROM "' + m.table + '" WHERE LOWER(TRIM("' + m.cols.name + '")) = LOWER(?) AND "' + m.id + '" <> ?');
  stmt.setString(1, name);
  stmt.setInt(2, excludeId || 0);
  return stmt.executeQuery().next();
}

function bindMasterValues_(stmt, m, values, startIndex) {
  let i = startIndex;
  Object.keys(m.cols).forEach(function (k) {
    if (m.ints.indexOf(k) !== -1) setIntOrNull_(stmt, i, values[k]);
    else setStringOrNull(stmt, i, values[k]);
    i++;
  });
  return i;
}

function hasIdDefault_(conn, m) {
  const stmt = conn.prepareStatement(
    'SELECT column_default, is_identity FROM information_schema.columns ' +
    "WHERE table_schema = 'public' AND table_name = ? AND column_name = ?");
  stmt.setString(1, m.table);
  stmt.setString(2, m.id);
  const rs = stmt.executeQuery();
  if (!rs.next()) return false;
  return !!rs.getString('column_default') || rs.getString('is_identity') === 'YES';
}

// ข้อมูลตั้งต้นถูก insert แบบระบุ id เอง sequence จึงค้างที่ 1 -> nextval ได้ id ที่มีอยู่แล้ว
// (duplicate key "..._pkey") เลยเลื่อน sequence ให้ต่อจาก MAX(id) ก่อนทุกครั้ง
// pg_get_serial_sequence ใช้ได้ทั้ง serial และ identity · อาร์กิวเมนต์ที่ 2 เป็นชื่อคอลัมน์ตรงตัว
function syncIdSequence_(conn, m) {
  const stmt = conn.prepareStatement(
    'SELECT setval(pg_get_serial_sequence(?, ?), (SELECT COALESCE(MAX("' + m.id + '"), 0) + 1 FROM "' + m.table + '"), false)');
  stmt.setString(1, '"' + m.table + '"');
  stmt.setString(2, m.id);
  stmt.executeQuery();
}

// id มี default (serial/identity) -> ปล่อยให้ DB ออกเอง sequence จะได้เดินตาม
// (ใส่เองจะชน GENERATED ALWAYS และทำให้ insert ครั้งหน้าที่ใช้ default ได้ id ซ้ำ)
// ไม่มี default -> ใช้ MAX+1 (admin เพิ่มนานๆ ครั้ง โอกาสชนกันแทบไม่มี)
function insertMasterRow_(conn, m, values) {
  const colKeys = Object.keys(m.cols);
  const colList = colKeys.map(function (k) { return '"' + m.cols[k] + '"'; }).join(', ');
  const params = colKeys.map(function () { return '?'; }).join(', ');
  const useDefault = hasIdDefault_(conn, m);
  if (useDefault) syncIdSequence_(conn, m);
  const sql = useDefault
    ? 'INSERT INTO "' + m.table + '" (' + colList + ') VALUES (' + params + ') RETURNING "' + m.id + '"'
    : 'INSERT INTO "' + m.table + '" ("' + m.id + '", ' + colList + ') ' +
      'SELECT COALESCE(MAX("' + m.id + '"), 0) + 1, ' + params + ' FROM "' + m.table + '" RETURNING "' + m.id + '"';
  const stmt = conn.prepareStatement(sql);
  bindMasterValues_(stmt, m, values, 1);
  const rs = stmt.executeQuery();
  return rs.next() ? rs.getInt(1) : null;
}

function updateMasterRow_(conn, m, id, values) {
  const stmt = conn.prepareStatement('UPDATE "' + m.table + '" SET ' +
    Object.keys(m.cols).map(function (k) { return '"' + m.cols[k] + '" = ?'; }).join(', ') +
    ' WHERE "' + m.id + '" = ?');
  const next = bindMasterValues_(stmt, m, values, 1);
  stmt.setInt(next, id);
  return stmt.executeUpdate();
}

// [{ label, n }] ของตารางที่ยังอ้างถึงแถวนี้ (n > 0 เท่านั้น)
function countMasterRefs_(conn, m, id) {
  const inUse = [];
  m.refs.forEach(function (r) {
    const stmt = conn.prepareStatement('SELECT COUNT(*) FROM "' + r[0] + '" WHERE "' + r[1] + '" = ?');
    stmt.setInt(1, id);
    const rs = stmt.executeQuery();
    const n = rs.next() ? rs.getInt(1) : 0;
    if (n > 0) inUse.push({ label: r[2], n: n });
  });
  return inUse;
}

// { id, name, parentId } ของสำนักงาน หรือ null
function findOffice_(conn, officeId) {
  const stmt = conn.prepareStatement(
    'SELECT "Office_ID", "Office_Name", "Parent_Office_ID" FROM "EXCISE_OFFICE" WHERE "Office_ID" = ?');
  stmt.setInt(1, officeId);
  const rs = stmt.executeQuery();
  if (!rs.next()) return null;
  return { id: rs.getInt('Office_ID'), name: rs.getString('Office_Name') || '', parentId: rs.getInt('Parent_Office_ID') };
}

function countChildOffices_(conn, officeId) {
  const stmt = conn.prepareStatement('SELECT COUNT(*) FROM "EXCISE_OFFICE" WHERE "Parent_Office_ID" = ?');
  stmt.setInt(1, officeId);
  const rs = stmt.executeQuery();
  return rs.next() ? rs.getInt(1) : 0;
}

// ชื่อสาขาเก็บเต็ม (ขึ้นต้นด้วยชื่อพื้นที่) — เปลี่ยนชื่อพื้นที่แล้วต้องเปลี่ยนคำนำหน้าของทุกสาขาในพื้นที่นั้นด้วย
// เทียบด้วย left() ไม่ใช้ LIKE: ชื่อที่มี % หรือ _ จะได้ไม่กลายเป็น wildcard
function renameBranchPrefix_(conn, officeId, oldName, newName) {
  const stmt = conn.prepareStatement(`
    UPDATE "BRANCH" SET "Branch_Name" = ? || substr("Branch_Name", ?)
    WHERE "Office_ID" = ? AND left("Branch_Name", ?) = ?
  `);
  stmt.setString(1, newName);
  stmt.setInt(2, oldName.length + 1);
  stmt.setInt(3, officeId);
  stmt.setInt(4, oldName.length);
  stmt.setString(5, oldName);
  return stmt.executeUpdate();
}

function deleteMasterRow_(conn, m, id) {
  const stmt = conn.prepareStatement('DELETE FROM "' + m.table + '" WHERE "' + m.id + '" = ?');
  stmt.setInt(1, id);
  return stmt.executeUpdate();
}
