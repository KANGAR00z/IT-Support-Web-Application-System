/* =============================================================================
   FAST TICKET · Admin API handlers (getTickets / acceptTicket / updateTicketStatus)
   -----------------------------------------------------------------------------
   วิธีติดตั้ง:
     1) copy โค้ดทั้งไฟล์นี้ไปวางในไฟล์ AdminApi.gs ของโปรเจกต์ GAS (แทนของเดิมทั้งไฟล์)
     2) router (handlers map) ใน doPost ของ Code.gs ต้องมีครบ 5 บรรทัดนี้:
          getTickets: getTickets,
          acceptTicket: acceptTicket,
          updateTicketStatus: updateTicketStatus,
          getUsers: getUsers,                    // <-- ใหม่ (โมดูล Users)
          updateUserRole: updateUserRole         // <-- ใหม่ (โมดูล Users)
     3) Deploy → Manage deployments → ✏️ → Version: "New version" → Deploy
        *** ต้องเป็น New version ของ deployment เดิม URL ถึงจะไม่เปลี่ยน ***

   สัญญา API (ต้องตรงกับ admin.js):
     getTickets({})
       -> { status:'success', tickets:[ { id, code, detail, category, branch,
             province, reporter, assignee, status, createdAt, acceptedAt,
             closedAt, pdfUrl } ] }
     acceptTicket({ ticketId, staffUserId })
       -> { status:'success', assignee:'<USER.Full_Name>' }
       ⚠️ staffUserId = LINE userId เพราะ TICKET.IT_In_Charge เป็น FK ->
          USER.LINE_User_ID (constraint fk_ticket_it) — ส่ง "ชื่อ" มา DB จะปฏิเสธ
     updateTicketStatus({ ticketId, status })   // status 1/2/3
       -> { status:'success' }
     getUsers({})
       -> { status:'success', users:[ { userId, name, position, role, dept,
             branch, province, reported, assigned } ] }
     updateUserRole({ userId, role })           // role: 'admin' | 'it' | 'staff'
       -> { status:'success', role:'<ค่าที่บันทึก>' }

   Status: 1 = รอรับเรื่อง (Open) · 2 = กำลังดำเนินการ (In Progress) · 3 = เสร็จสิ้น (Closed)
   Role:   admin = แอดมิน · it = เจ้าหน้าที่ IT · อื่นๆ/Staff = ผู้ใช้งานทั่วไป
           (ข้อมูลเก่ามี 'Staff' ตัวใหญ่จาก createTicket — frontend เทียบแบบ case-insensitive)
   ============================================================================= */

const TICKET_STATUS = { OPEN: 1, IN_PROGRESS: 2, CLOSED: 3 };

// -----------------------------------------------------------------------------
// helper: เปิด connection -> เรียก fn -> ปิดเสมอ + แปลง exception เป็น error response
// ตามสเปก JDBC การปิด Connection จะปิด Statement/ResultSet ที่เปิดจากมันทั้งหมด
// จึงไม่ต้องปิด stmt/rs รายตัวในแต่ละ handler
// -----------------------------------------------------------------------------
function withConn_(fn) {
  let conn = null;
  try {
    conn = getDbConnection();   // นิยามใน Code.gs
    return fn(conn);
  } catch (error) {
    return { status: 'error', message: error.toString() };
  } finally {
    if (conn) conn.close();
  }
}

// -----------------------------------------------------------------------------
// helper: แปลงค่าเวลาจาก DB ให้เป็น ISO 8601 ที่ JS parse ได้ทุกเบราว์เซอร์
//
// Postgres timestamptz คืนค่ามาแบบ "2026-07-13 15:50:09.111633+00" ซึ่ง "ผิดสเปก" 2 จุด:
//   1) เศษวินาที 6 หลัก (สเปก ECMAScript กำหนด .sss = 3 หลักเป๊ะ)
//   2) offset เป็น "+00" (สเปกต้องเป็น ±HH:mm หรือ Z)
// Chrome อาจ parse รอดด้วย parser สำรอง แต่ Safari/iOS เข้มกว่า -> Invalid Date
// (โปรเจกต์นี้เคยเจอปัญหา iOS มาแล้ว จึงต้อง normalize ให้ถูกสเปกเสมอ)
//
// รับได้ทั้ง timestamptz ("…+00", "…+0700") และ timestamp ธรรมดา ("…15:30:00.0")
// คืน null ถ้าไม่มีค่า -> admin.js จัดการ null ได้อยู่แล้ว
// -----------------------------------------------------------------------------
function toIsoLocal_(rs, col) {
  const raw = rs.getString(col);
  if (!raw || rs.wasNull()) return null;

  let s = String(raw).trim().replace(' ', 'T');       // "…13 15:50" -> "…13T15:50"
  s = s.replace(/(\.\d{3})\d+/, '$1');                // เศษวินาที 6 หลัก -> 3 หลัก
  s = s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');      // "+0700" -> "+07:00"
  s = s.replace(/([+-]\d{2})$/, '$1:00');             // "+00"   -> "+00:00"
  s = s.replace(/\.(\d{1,2})$/, '');                  // timestamp ธรรมดาลงท้าย ".0" -> ตัดทิ้ง
  return s;
}

function strOrNull_(rs, col) {
  const v = rs.getString(col);
  return (!v || rs.wasNull()) ? null : v;
}

// ==========================================
// 6. ดึงตั๋วทั้งหมดสำหรับ Task Board / Dashboard
// ==========================================
function getTickets(data) {
  return withConn_(function (conn) {
    // LEFT JOIN เพื่อไม่ให้ตั๋วหายถ้า master data ขาด (เช่นยังไม่มี record ใน USER)
    // JOIN "USER" 2 ครั้ง: u = ผู้แจ้ง (LINE_User_ID) · it = เจ้าหน้าที่ (IT_In_Charge
    // เก็บเป็น LINE_User_ID เพราะเป็น FK ต้องแปลงกลับเป็นชื่อให้หน้าเว็บโชว์)
    const sql = `
      SELECT
        t."Ticket_ID", t."Issue_Detail", t."Status", t."IT_In_Charge", t."Doc_PDF_URL",
        t."Created_Date", t."Accepted_Date", t."Closed_Date",
        c."Category_Name", b."Branch_Name", b."Province",
        u."Full_Name"  AS "Reporter_Name",
        it."Full_Name" AS "Assignee_Name"
      FROM "TICKET" t
      LEFT JOIN "ISSUE_CATEGORY" c  ON c."Category_ID"   = t."Category_ID"
      LEFT JOIN "BRANCH"         b  ON b."Branch_ID"     = t."Branch_ID"
      LEFT JOIN "USER"           u  ON u."LINE_User_ID"  = t."LINE_User_ID"
      LEFT JOIN "USER"           it ON it."LINE_User_ID" = t."IT_In_Charge"
      ORDER BY t."Ticket_ID" DESC
    `;
    const rs = conn.prepareStatement(sql).executeQuery();

    const tickets = [];
    while (rs.next()) {
      const id = rs.getInt('Ticket_ID');
      tickets.push({
        id: id,
        code: 'TK-' + id,
        detail: strOrNull_(rs, 'Issue_Detail') || '(ไม่มีรายละเอียด)',
        category: strOrNull_(rs, 'Category_Name') || '',
        branch: strOrNull_(rs, 'Branch_Name') || '',
        province: strOrNull_(rs, 'Province') || '',   // ใช้กับแผนที่ 7 จังหวัดใน Dashboard
        reporter: strOrNull_(rs, 'Reporter_Name') || '-',
        // โชว์ชื่อเจ้าหน้าที่ ถ้าหาไม่เจอใน USER ค่อย fallback เป็น userId ดิบ (กันการ์ดว่าง)
        assignee: strOrNull_(rs, 'Assignee_Name') || strOrNull_(rs, 'IT_In_Charge'),
        status: rs.getInt('Status'),
        createdAt: toIsoLocal_(rs, 'Created_Date'),
        acceptedAt: toIsoLocal_(rs, 'Accepted_Date'),
        closedAt: toIsoLocal_(rs, 'Closed_Date'),
        pdfUrl: strOrNull_(rs, 'Doc_PDF_URL') || ''
      });
    }
    return { status: 'success', tickets: tickets };
  });
}

// ==========================================
// 7. รับงาน (Open -> In Progress) + บันทึกเจ้าหน้าที่ผู้รับ
// ==========================================
function acceptTicket(data) {
  return withConn_(function (conn) {
    const ticketId = parseInt(data && data.ticketId, 10);
    // รองรับ staffUserId (ชื่อใหม่) และ staff (ชื่อเดิม) เผื่อ frontend เวอร์ชันเก่ายังค้าง cache
    const staffUserId = String((data && (data.staffUserId || data.staff)) || '').trim();
    if (!ticketId)    return { status: 'error', message: 'ไม่ได้ระบุ ticketId' };
    if (!staffUserId) return { status: 'error', message: 'ไม่ได้ระบุผู้รับงาน (ต้องเข้าสู่ระบบ LINE ก่อน)' };

    // เช็คตัวตนก่อน เพื่อคืน error ที่มนุษย์อ่านรู้เรื่อง แทน FK violation ดิบๆ จาก Postgres
    const stmtChk = conn.prepareStatement('SELECT "Full_Name" FROM "USER" WHERE "LINE_User_ID" = ?');
    stmtChk.setString(1, staffUserId);
    const rsChk = stmtChk.executeQuery();
    if (!rsChk.next()) {
      return {
        status: 'error',
        message: 'ยังไม่มีบัญชีเจ้าหน้าที่คนนี้ในระบบ (USER) — ต้องลงทะเบียนผู้ใช้ก่อนจึงจะรับงานได้'
      };
    }
    const staffName = rsChk.getString('Full_Name');

    const stmt = conn.prepareStatement(`
      UPDATE "TICKET"
      SET "Status" = ?, "IT_In_Charge" = ?, "Accepted_Date" = NOW(), "Closed_Date" = NULL
      WHERE "Ticket_ID" = ?
    `);
    stmt.setInt(1, TICKET_STATUS.IN_PROGRESS);
    stmt.setString(2, staffUserId);
    stmt.setInt(3, ticketId);

    if (stmt.executeUpdate() === 0) return { status: 'error', message: 'ไม่พบตั๋ว TK-' + ticketId };
    return { status: 'success', message: 'รับงาน TK-' + ticketId + ' โดย ' + staffName, assignee: staffName };
  });
}

// ==========================================
// 8. เปลี่ยนสถานะตั๋ว (ลากการ์ด / ปิดงาน / เปิดใหม่)
// ==========================================
function updateTicketStatus(data) {
  return withConn_(function (conn) {
    const ticketId = parseInt(data && data.ticketId, 10);
    const status = parseInt(data && data.status, 10);
    if (!ticketId) return { status: 'error', message: 'ไม่ได้ระบุ ticketId' };
    if ([1, 2, 3].indexOf(status) === -1) {
      return { status: 'error', message: 'สถานะไม่ถูกต้อง: ' + (data && data.status) };
    }

    // แต่ละสถานะจัดการคอลัมน์เวลา/ผู้รับงานต่างกัน ให้ตรงกับที่ admin.js อัปเดตฝั่งหน้าจอ
    let sql;
    if (status === TICKET_STATUS.CLOSED) {
      // ปิดงาน: ประทับเวลาปิด
      sql = `UPDATE "TICKET" SET "Status" = ?, "Closed_Date" = NOW() WHERE "Ticket_ID" = ?`;
    } else if (status === TICKET_STATUS.OPEN) {
      // เปิดใหม่: ล้างผู้รับงาน + เวลารับ/ปิด (ตรงกับ admin.js ที่ล้าง assignee เป็น null)
      sql = `UPDATE "TICKET"
             SET "Status" = ?, "IT_In_Charge" = NULL, "Accepted_Date" = NULL, "Closed_Date" = NULL
             WHERE "Ticket_ID" = ?`;
    } else {
      // กลับมาดำเนินการ (เช่นลากจาก Closed): ล้างเวลาปิด คงผู้รับงานเดิม
      sql = `UPDATE "TICKET"
             SET "Status" = ?, "Closed_Date" = NULL, "Accepted_Date" = COALESCE("Accepted_Date", NOW())
             WHERE "Ticket_ID" = ?`;
    }

    const stmt = conn.prepareStatement(sql);
    stmt.setInt(1, status);
    stmt.setInt(2, ticketId);

    if (stmt.executeUpdate() === 0) return { status: 'error', message: 'ไม่พบตั๋ว TK-' + ticketId };
    return { status: 'success', message: 'อัปเดตสถานะ TK-' + ticketId + ' เป็น ' + status };
  });
}

// ==========================================
// 9. รายชื่อผู้ใช้ทั้งหมด (โมดูล Users)
// ==========================================
function getUsers(data) {
  return withConn_(function (conn) {
    // JOIN TICKET สองขา (ผู้แจ้ง / ผู้รับผิดชอบ) — สองขาคูณกันเป็น cartesian ต่อ user
    // จึงต้องนับแบบ COUNT(DISTINCT id) ไม่งั้นตัวเลขบวม
    const sql = `
      SELECT
        u."LINE_User_ID", u."Full_Name", u."Position", u."Role",
        d."Dept_Name", b."Branch_Name", b."Province",
        COUNT(DISTINCT t."Ticket_ID")  AS "Reported",
        COUNT(DISTINCT ta."Ticket_ID") AS "Assigned"
      FROM "USER" u
      LEFT JOIN "DEPARTMENT" d ON d."Dept_ID"       = u."Dept_ID"
      LEFT JOIN "BRANCH"     b ON b."Branch_ID"     = d."Branch_ID"
      LEFT JOIN "TICKET"     t ON t."LINE_User_ID"  = u."LINE_User_ID"
      LEFT JOIN "TICKET"    ta ON ta."IT_In_Charge" = u."LINE_User_ID"
      GROUP BY u."LINE_User_ID", u."Full_Name", u."Position", u."Role",
               d."Dept_Name", b."Branch_Name", b."Province"
      ORDER BY u."Full_Name"
    `;
    const rs = conn.prepareStatement(sql).executeQuery();

    const users = [];
    while (rs.next()) {
      users.push({
        userId: rs.getString('LINE_User_ID'),
        name: strOrNull_(rs, 'Full_Name') || '(ไม่มีชื่อ)',
        position: strOrNull_(rs, 'Position') || '-',
        role: strOrNull_(rs, 'Role') || 'staff',
        dept: strOrNull_(rs, 'Dept_Name') || '',
        branch: strOrNull_(rs, 'Branch_Name') || '',
        province: strOrNull_(rs, 'Province') || '',
        reported: rs.getInt('Reported'),
        assigned: rs.getInt('Assigned')
      });
    }
    return { status: 'success', users: users };
  });
}

// ==========================================
// 10. เปลี่ยนบทบาทผู้ใช้ (โมดูล Users)
// ==========================================
function updateUserRole(data) {
  return withConn_(function (conn) {
    const userId = String((data && data.userId) || '').trim();
    const role = String((data && data.role) || '').trim().toLowerCase();
    if (!userId) return { status: 'error', message: 'ไม่ได้ระบุ userId' };
    if (['admin', 'it', 'staff'].indexOf(role) === -1) {
      return { status: 'error', message: 'บทบาทไม่ถูกต้อง: ' + role + ' (ต้องเป็น admin / it / staff)' };
    }

    const stmt = conn.prepareStatement('UPDATE "USER" SET "Role" = ? WHERE "LINE_User_ID" = ?');
    stmt.setString(1, role);
    stmt.setString(2, userId);

    if (stmt.executeUpdate() === 0) return { status: 'error', message: 'ไม่พบผู้ใช้คนนี้ในระบบ' };
    return { status: 'success', role: role };
  });
}
