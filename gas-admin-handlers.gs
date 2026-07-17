/* =============================================================================
   FAST TICKET · Admin API handlers (getTickets / acceptTicket / updateTicketStatus)
   -----------------------------------------------------------------------------
   วิธีติดตั้ง:
     1) copy โค้ดทั้งไฟล์นี้ไปต่อท้าย Code.gs ในโปรเจกต์ GAS
     2) แก้ router ใน doPost ให้เพิ่ม 3 บรรทัด (ดู ROUTER PATCH ด้านล่าง)
     3) Deploy → Manage deployments → ✏️ → Version: "New version" → Deploy
        *** ต้องเป็น New version ของ deployment เดิม URL ถึงจะไม่เปลี่ยน ***

   ROUTER PATCH — ใน doPost แก้ handlers เป็น:
     const handlers = {
       generateDocument: generateDocument,
       createTicket: createTicket,
       deleteTempPdf: deleteTempPdf,
       getTickets: getTickets,                    // <-- เพิ่ม
       acceptTicket: acceptTicket,                // <-- เพิ่ม
       updateTicketStatus: updateTicketStatus     // <-- เพิ่ม
     };

   สัญญา API (ต้องตรงกับที่ admin.html รอ):
     getTickets({})
       -> { status:'success', tickets:[ { id, code, detail, category, branch,
             reporter, assignee, status, createdAt, acceptedAt, closedAt, pdfUrl } ] }
     acceptTicket({ ticketId, staff })      -> { status:'success' }
     updateTicketStatus({ ticketId, status })-> { status:'success' }

   Status: 1 = รอรับเรื่อง (Open) · 2 = กำลังดำเนินการ (In Progress) · 3 = เสร็จสิ้น (Closed)
   ============================================================================= */

const TICKET_STATUS = { OPEN: 1, IN_PROGRESS: 2, CLOSED: 3 };

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
// คืน null ถ้าไม่มีค่า -> admin.html จัดการ null ได้อยู่แล้ว
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
  let conn = null, stmt = null, rs = null;
  try {
    conn = getDbConnection();

    // LEFT JOIN เพื่อไม่ให้ตั๋วหายถ้า master data ขาด (เช่นยังไม่มี record ใน USER)
    const sql = `
      SELECT
        t."Ticket_ID", t."Issue_Detail", t."Status", t."IT_In_Charge", t."Doc_PDF_URL",
        t."Created_Date", t."Accepted_Date", t."Closed_Date",
        c."Category_Name", b."Branch_Name", u."Full_Name"
      FROM "TICKET" t
      LEFT JOIN "ISSUE_CATEGORY" c ON c."Category_ID"  = t."Category_ID"
      LEFT JOIN "BRANCH"         b ON b."Branch_ID"    = t."Branch_ID"
      LEFT JOIN "USER"           u ON u."LINE_User_ID" = t."LINE_User_ID"
      ORDER BY t."Ticket_ID" DESC
    `;
    stmt = conn.prepareStatement(sql);
    rs = stmt.executeQuery();

    const tickets = [];
    while (rs.next()) {
      const id = rs.getInt('Ticket_ID');
      tickets.push({
        id: id,
        code: 'TK-' + id,
        detail: strOrNull_(rs, 'Issue_Detail') || '(ไม่มีรายละเอียด)',
        category: strOrNull_(rs, 'Category_Name') || '',
        branch: strOrNull_(rs, 'Branch_Name') || '',
        reporter: strOrNull_(rs, 'Full_Name') || '-',
        assignee: strOrNull_(rs, 'IT_In_Charge'),
        status: rs.getInt('Status'),
        createdAt: toIsoLocal_(rs, 'Created_Date'),
        acceptedAt: toIsoLocal_(rs, 'Accepted_Date'),
        closedAt: toIsoLocal_(rs, 'Closed_Date'),
        pdfUrl: strOrNull_(rs, 'Doc_PDF_URL') || ''
      });
    }

    return { status: 'success', tickets: tickets };
  } catch (error) {
    return { status: 'error', message: error.toString() };
  } finally {
    if (rs) rs.close();
    if (stmt) stmt.close();
    if (conn) conn.close();
  }
}

// ==========================================
// 7. รับงาน (Open -> In Progress) + บันทึกชื่อเจ้าหน้าที่
// ==========================================
function acceptTicket(data) {
  let conn = null, stmt = null;
  try {
    const ticketId = parseInt(data && data.ticketId, 10);
    const staff = (data && data.staff || '').trim();
    if (!ticketId) return { status: 'error', message: 'ไม่ได้ระบุ ticketId' };
    if (!staff)    return { status: 'error', message: 'ไม่ได้ระบุชื่อเจ้าหน้าที่ผู้รับงาน' };

    conn = getDbConnection();
    const sql = `
      UPDATE "TICKET"
      SET "Status" = ?, "IT_In_Charge" = ?, "Accepted_Date" = NOW(), "Closed_Date" = NULL
      WHERE "Ticket_ID" = ?
    `;
    stmt = conn.prepareStatement(sql);
    stmt.setInt(1, TICKET_STATUS.IN_PROGRESS);
    stmt.setString(2, staff);
    stmt.setInt(3, ticketId);

    const rows = stmt.executeUpdate();
    if (rows === 0) return { status: 'error', message: 'ไม่พบตั๋ว TK-' + ticketId };

    return { status: 'success', message: 'รับงาน TK-' + ticketId + ' แล้ว' };
  } catch (error) {
    return { status: 'error', message: error.toString() };
  } finally {
    if (stmt) stmt.close();
    if (conn) conn.close();
  }
}

// ==========================================
// 8. เปลี่ยนสถานะตั๋ว (ลากการ์ด / ปิดงาน / เปิดใหม่)
// ==========================================
function updateTicketStatus(data) {
  let conn = null, stmt = null;
  try {
    const ticketId = parseInt(data && data.ticketId, 10);
    const status = parseInt(data && data.status, 10);
    if (!ticketId) return { status: 'error', message: 'ไม่ได้ระบุ ticketId' };
    if ([1, 2, 3].indexOf(status) === -1) {
      return { status: 'error', message: 'สถานะไม่ถูกต้อง: ' + data.status };
    }

    conn = getDbConnection();

    // แต่ละสถานะจัดการคอลัมน์เวลา/ผู้รับงานต่างกัน ให้ตรงกับที่ admin.html อัปเดตฝั่งหน้าจอ
    let sql;
    if (status === TICKET_STATUS.CLOSED) {
      // ปิดงาน: ประทับเวลาปิด
      sql = `UPDATE "TICKET" SET "Status" = ?, "Closed_Date" = NOW() WHERE "Ticket_ID" = ?`;
    } else if (status === TICKET_STATUS.OPEN) {
      // เปิดใหม่: ล้างผู้รับงาน + เวลารับ/ปิด (ตรงกับ admin.html ที่ล้าง assignee เป็น null)
      sql = `UPDATE "TICKET"
             SET "Status" = ?, "IT_In_Charge" = NULL, "Accepted_Date" = NULL, "Closed_Date" = NULL
             WHERE "Ticket_ID" = ?`;
    } else {
      // กลับมาดำเนินการ (เช่นลากจาก Closed): ล้างเวลาปิด คงผู้รับงานเดิม
      sql = `UPDATE "TICKET"
             SET "Status" = ?, "Closed_Date" = NULL, "Accepted_Date" = COALESCE("Accepted_Date", NOW())
             WHERE "Ticket_ID" = ?`;
    }

    stmt = conn.prepareStatement(sql);
    stmt.setInt(1, status);
    stmt.setInt(2, ticketId);

    const rows = stmt.executeUpdate();
    if (rows === 0) return { status: 'error', message: 'ไม่พบตั๋ว TK-' + ticketId };

    return { status: 'success', message: 'อัปเดตสถานะ TK-' + ticketId + ' เป็น ' + status };
  } catch (error) {
    return { status: 'error', message: error.toString() };
  } finally {
    if (stmt) stmt.close();
    if (conn) conn.close();
  }
}
