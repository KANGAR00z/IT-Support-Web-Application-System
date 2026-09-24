/* =============================================================================
   FAST TICKET · AdminApi.gs — Backend API ทั้งหมด (ยกเว้นรหัส DB)
   =============================================================================
   สถาปัตยกรรมไฟล์ GAS (2 ไฟล์เท่านั้น):
     • Code.gs     = เฉพาะ config + รหัส DB : DB_CONFIG, getDbConnection()
                     (มี credentials จึงห้าม commit — .gitignore กันไว้)
     • AdminApi.gs = ไฟล์นี้ : doGet/doPost + auth + handler ทั้งหมด + PDF/ticket
                     (ไม่มี secret — อยู่ใน git ได้)

   วิธี deploy (ไม่ต้องแก้ surgical อีกแล้ว):
     1) วางไฟล์นี้ทับ AdminApi.gs ทั้งไฟล์
     2) Code.gs เหลือแค่บล็อก config (เอาฟังก์ชัน doPost/createTicket/
        generateDocument/deleteTempPdf/doGet/jsonOutput/setStringOrNull ออก เพราะ
        ย้ายมาที่นี่แล้ว ไม่งั้น GAS error "ประกาศฟังก์ชันซ้ำ")
     3) ตั้ง Script Property: LIFF_CHANNEL_ID = Channel ID ของ LINE Login channel
        (LINE console → channel → Basic settings → Channel ID)
     4) Deploy → Manage deployments → ✏️ → Version: "New version" → Deploy

   🔒 AUTH: ทุก request ต้องแนบ idToken — verify กับ LINE + เช็ค role ตาม ACL ก่อน
      ทำงานเสมอ ตัวตนผู้กระทำมาจาก token ที่ verify แล้ว ไม่เชื่อค่าจาก client

   Status: 1 = รอรับเรื่อง · 2 = กำลังดำเนินการ · 3 = เสร็จสิ้น
   Role  : DB มี CHECK constraint "USER_Role_check" -> ค่าต้องเป็น 'Staff'/'IT'/'Admin'
           เป๊ะ (ตัวพิมพ์นี้เท่านั้น เขียนค่าอื่น Postgres reject error 23514)
   ============================================================================= */

// โฟลเดอร์เก็บ PDF ใน Drive (ไม่ใช่ secret — เก็บที่นี่ได้)
const FOLDER_ID = '1wQSNqJ0QHgm9hKaVf4sm0_fIXprEpSsc';

const TICKET_STATUS = { OPEN: 1, IN_PROGRESS: 2, CLOSED: 3 };
const ROLE_DB_VALUE = { admin: 'Admin', it: 'IT', staff: 'Staff' };  // map ค่าตาม USER_Role_check

function jsonOutput(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ==========================================
// Entry points
// ==========================================
function doGet(e) {
  return ContentService.createTextOutput('✅ API is running! (ระบบหลังบ้าน FAST TICKET พร้อมทำงาน)')
    .setMimeType(ContentService.MimeType.TEXT);
}

function doPost(e) {
  try {
    const request = JSON.parse(e.postData.contents);
    const handlers = {
      generateDocument: generateDocument,
      createTicket: createTicket,
      deleteTempPdf: deleteTempPdf,
      getTickets: getTickets,
      acceptTicket: acceptTicket,
      updateTicketStatus: updateTicketStatus,
      getUsers: getUsers,
      updateUserRole: updateUserRole,
      getKnowledgeBase: getKnowledgeBase,
      addKnowledgeArticle: addKnowledgeArticle,
      updateKnowledgeArticle: updateKnowledgeArticle,
      deleteKnowledgeArticle: deleteKnowledgeArticle,
      getMyProfile: getMyProfile,
      getMyTickets: getMyTickets,
      getMasterData: getMasterData,
      addMasterItem: addMasterItem,
      updateMasterItem: updateMasterItem,
      deleteMasterItem: deleteMasterItem
    };
    const handler = handlers[request.action];
    if (!handler) return jsonOutput({ status: 'error', message: 'ไม่พบคำสั่ง Action: ' + request.action });

    // 🔒 ชั้นตรวจสิทธิ์: verify idToken + เช็ค ACL
    const auth = authorize_(request.action, request.idToken);
    if (!auth.ok) return jsonOutput({ status: 'error', code: auth.code || null, message: auth.message });

    // ส่งตัวตนที่ verify แล้ว (auth) เป็น arg ที่ 2 — handler ใช้ auth.userId ไม่เชื่อ client
    return jsonOutput(handler(request.data, auth));
  } catch (error) {
    return jsonOutput({ status: 'error', message: error.toString() });
  }
}

/* =============================================================================
   AUTH — ยืนยันตัวตนด้วย LINE ID Token + เช็คสิทธิ์ตาม ACL
   -----------------------------------------------------------------------------
   config.js เป็น public repo -> ใครก็เห็น GAS URL แล้วยิง curl ตรงได้ การเช็คสิทธิ์
   ฝั่ง client เป็นแค่ UX ปลอมกันไม่ได้ จึงต้อง verify ที่ server: client แนบ LIFF
   ID Token (JWT ที่ LINE เซ็นลายเซ็น ปลอมไม่ได้) -> backend ถาม LINE ว่าของจริงไหม
   -> ได้ userId ตัวจริง -> เทียบ USER.Role กับ ACL
   ============================================================================= */

// สิทธิ์ต่อ action — '*' = แค่ login พอ (รวมผู้ใช้ที่ยังไม่มีใน USER เช่นคนแจ้งซ่อมครั้งแรก)
const ACL = {
  generateDocument:    ['*'],
  createTicket:        ['*'],
  deleteTempPdf:       ['*'],
  getTickets:          ['IT', 'Admin'],
  acceptTicket:        ['IT', 'Admin'],
  updateTicketStatus:  ['IT', 'Admin'],
  getKnowledgeBase:       ['IT', 'Admin'],
  addKnowledgeArticle:    ['IT', 'Admin'],
  updateKnowledgeArticle: ['IT', 'Admin'],
  deleteKnowledgeArticle: ['IT', 'Admin'],
  getMyProfile:            ['IT', 'Admin'],
  getMyTickets:            ['*'],
  getMasterData:           ['*'],
  getUsers:               ['Admin'],
  updateUserRole:      ['Admin'],
  addMasterItem:          ['Admin'],
  updateMasterItem:       ['Admin'],
  deleteMasterItem:       ['Admin'],
};

/* ---------- แคชระดับสคริปต์: ตัดงานซ้ำที่ทำทุก request ------------------------
   เดิมทุก request ที่ต้องตรวจสิทธิ์ทำของช้า 2 อย่าง
     1) ยิง UrlFetch ไปถาม LINE ว่า token ของจริงไหม  (ข้ามเน็ต)
     2) เปิด connection ไป Postgres เพื่ออ่าน Role หนึ่งครั้ง
        แล้ว handler ก็เปิด connection ของตัวเองอีกครั้ง = 2 connection ต่อ 1 request
   ทั้งสองอย่างแทบไม่เปลี่ยนระหว่างการใช้งานรอบเดียว จึงแคชไว้ได้
   ---------------------------------------------------------------------------- */
const CACHE_TTL_TOKEN = 300;   // วินาที
const CACHE_TTL_ROLE  = 300;

function cache_() { return CacheService.getScriptCache(); }

// ไม่ใช้ token ทั้งใบเป็น key: ยาวเกิน 250 ตัวอักษรที่ CacheService รับ และไม่ควรเก็บของดิบ
function tokenKey_(idToken) {
  const d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, idToken);
  return 'tk_' + Utilities.base64Encode(d);
}

// ยิงถาม LINE ว่า idToken ของจริงไหม — คืน { ok, userId }
function verifyIdToken_(idToken) {
  if (!idToken) return { ok: false };

  // แคชช่วยข้าม "การยิงถาม" เท่านั้น ไม่ได้ยืดอายุ token — วันหมดอายุยังเช็คเองทุกครั้ง
  const key = tokenKey_(idToken);
  const hit = cache_().get(key);
  if (hit) {
    const c = JSON.parse(hit);
    if (c.exp && (Number(c.exp) * 1000) > Date.now()) return { ok: true, userId: c.sub };
    cache_().remove(key);
    return { ok: false };
  }

  const channelId = PropertiesService.getScriptProperties().getProperty('LIFF_CHANNEL_ID');
  if (!channelId) throw new Error('ยังไม่ได้ตั้ง Script Property: LIFF_CHANNEL_ID');

  const res = UrlFetchApp.fetch('https://api.line.me/oauth2/v2.1/verify', {
    method: 'post',
    payload: { id_token: idToken, client_id: channelId },  // form-urlencoded อัตโนมัติ
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) return { ok: false };   // token ผิด/หมดอายุ/ผิด channel

  const p = JSON.parse(res.getContentText());
  if (String(p.aud) !== String(channelId)) return { ok: false };          // ของ channel เราจริง
  if (p.exp && (Number(p.exp) * 1000) < Date.now()) return { ok: false };  // กันเหนียวเรื่องหมดอายุ

  // เก็บแค่ sub กับ exp พอ ไม่เก็บตัว token
  cache_().put(key, JSON.stringify({ sub: p.sub, exp: p.exp }), CACHE_TTL_TOKEN);
  return { ok: true, userId: p.sub };   // sub = LINE userId ตัวจริง
}

// อ่าน role จาก DB — คืน 'Staff'/'IT'/'Admin' หรือ null (ไม่มีใน USER / DB ล่ม -> fail-closed)
function getUserRole_(userId) {
  const key = 'role_' + userId;
  const hit = cache_().get(key);
  if (hit !== null && hit !== undefined) return hit === '-' ? null : hit;   // '-' = ไม่มีบัญชีในระบบ

  const r = withConn_(function (conn) {
    const stmt = conn.prepareStatement('SELECT "Role" FROM "USER" WHERE "LINE_User_ID" = ?');
    stmt.setString(1, userId);
    const rs = stmt.executeQuery();
    return { role: rs.next() ? rs.getString('Role') : null };
  });
  // DB error -> withConn_ คืน {status:'error'} ไม่มี field role -> null (fail-closed)
  // และ "ห้ามแคช" กรณีนี้ ไม่งั้น DB สะดุดแวบเดียวจะทำให้ผู้ใช้ถูกปฏิเสธยาว 5 นาที
  if (!r || typeof r.role === 'undefined') return null;

  cache_().put(key, r.role || '-', CACHE_TTL_ROLE);
  return r.role;
}

// ต้องเรียกทุกครั้งที่แก้ Role ไม่งั้นสิทธิ์ใหม่จะยังไม่มีผลจนกว่าแคชจะหมดอายุ
function invalidateRoleCache_(userId) {
  if (userId) cache_().remove('role_' + userId);
}

// ประตูหลัก: verify token + เช็ค ACL — คืน { ok, userId, role } หรือ { ok:false, message }
function authorize_(action, idToken) {
  const allowed = ACL[action];
  if (!allowed) return { ok: false, message: 'ไม่พบคำสั่ง Action: ' + action };

  const v = verifyIdToken_(idToken);
  // code ให้ client ตัดสินใจ login ใหม่ได้โดยไม่ต้องจับคำในข้อความภาษาไทย
  if (!v.ok) return { ok: false, code: 'AUTH_INVALID', message: 'ยืนยันตัวตน LINE ไม่สำเร็จ กรุณาเข้าสู่ระบบใหม่' };

  if (allowed.indexOf('*') !== -1) return { ok: true, userId: v.userId, role: null };  // แค่ login พอ

  const role = getUserRole_(v.userId);
  if (allowed.indexOf(role) === -1) {
    return { ok: false, message: 'บัญชีนี้ไม่มีสิทธิ์ทำรายการนี้ (' + (role || 'ไม่พบบัญชีในระบบ') + ')' };
  }
  return { ok: true, userId: v.userId, role: role };
}

// -----------------------------------------------------------------------------
// helper: เปิด connection -> เรียก fn -> ปิดเสมอ + แปลง exception เป็น error response
// getDbConnection() นิยามใน Code.gs · ตามสเปก JDBC ปิด Connection = ปิด Statement/
// ResultSet ที่เปิดจากมันทั้งหมด จึงไม่ต้องปิด stmt/rs รายตัว
// -----------------------------------------------------------------------------
function withConn_(fn) {
  let conn = null;
  try {
    conn = getDbConnection();
    return fn(conn);
  } catch (error) {
    return { status: 'error', message: error.toString() };
  } finally {
    if (conn) conn.close();
  }
}

// -----------------------------------------------------------------------------
// helper: แปลงเวลา Postgres timestamptz ("2026-07-13 15:50:09.111633+00") ให้เป็น
// ISO 8601 ที่ JS parse ได้ทุกเบราว์เซอร์ (Safari/iOS เข้มกว่า Chrome — ต้องถูกสเปก)
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

// helper: เซ็ตค่า string ถ้ามี ไม่งั้น NULL
function setStringOrNull(stmt, index, value) {
  if (value) stmt.setString(index, value);
  else stmt.setNull(index, Jdbc.Types.VARCHAR);
}

// ==========================================
// สร้างเอกสาร PDF (บันทึกข้อความราชการ)
// ==========================================
function generateDocument(formData) {
  try {
    const folder = DriveApp.getFolderById(FOLDER_ID);

    const htmlTemplate = HtmlService.createTemplateFromFile('Template');
    htmlTemplate.name = formData.name || '-';
    htmlTemplate.position = formData.position || '-';
    htmlTemplate.department = formData.department || '-';
    htmlTemplate.asset_id = formData.asset_id || '-';
    htmlTemplate.problem_type = formData.problem_type || '-';
    htmlTemplate.description = formData.description || '-';
    htmlTemplate.phone = formData.phone || '-';

    const htmlContent = htmlTemplate.evaluate().getContent();
    const blob = Utilities.newBlob(htmlContent, 'text/html', 'temp.html').getAs('application/pdf');
    blob.setName('แจ้งซ่อม_' + (formData.name || 'user') + '_' + new Date().getTime() + '.pdf');

    const pdfFile = folder.createFile(blob);
    pdfFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

    return { status: 'success', url: pdfFile.getUrl() };
  } catch (error) {
    return { status: 'error', message: error.toString() };
  }
}

// ==========================================
// บันทึกใบแจ้งซ่อมลง DB
// ⚠️ ผู้แจ้ง = auth.userId (จาก idToken) ไม่ใช่ data.lineUserId จาก client — กันปลอมเป็นคนอื่น
//    ส่วนชื่อ/ตำแหน่ง/แผนก เป็นข้อมูลที่ผู้แจ้งกรอกเองในฟอร์ม จึงมาจาก client ได้ตามปกติ
// ==========================================
function createTicket(data, auth) {
  const reporterId = auth && auth.userId;
  if (!reporterId) return { status: 'error', message: 'ยืนยันตัวตนไม่สำเร็จ' };

  let conn = null, stmtUser = null, stmtTicket = null, rs = null;
  try {
    conn = getDbConnection();

    // Upsert พนักงาน (DO UPDATE ไม่แตะ "Role" — ผู้ใช้เดิมคง role เดิม, ผู้ใช้ใหม่ได้ 'Staff')
    const sqlUser = `
      INSERT INTO "USER" ("LINE_User_ID", "Full_Name", "Position", "Role", "Dept_ID")
      VALUES (?, ?, ?, 'Staff', ?)
      ON CONFLICT ("LINE_User_ID")
      DO UPDATE SET
        "Full_Name" = EXCLUDED."Full_Name",
        "Position"  = EXCLUDED."Position",
        "Dept_ID"   = EXCLUDED."Dept_ID";
    `;
    stmtUser = conn.prepareStatement(sqlUser);
    stmtUser.setString(1, reporterId);
    stmtUser.setString(2, data.displayName || 'Unknown User');
    stmtUser.setString(3, data.position || 'เจ้าหน้าที่');
    stmtUser.setInt(4, data.deptId || 1);
    stmtUser.executeUpdate();

    // Insert ใบแจ้งซ่อม
    const sqlTicket = `
      INSERT INTO "TICKET"
      ("LINE_User_ID", "Branch_ID", "Category_ID", "Issue_Detail", "Image_URL", "Doc_PDF_URL", "Status")
      VALUES (?, ?, ?, ?, ?, ?, 1)
      RETURNING "Ticket_ID"
    `;
    stmtTicket = conn.prepareStatement(sqlTicket);
    stmtTicket.setString(1, reporterId);
    stmtTicket.setInt(2, data.branchId);
    stmtTicket.setInt(3, data.categoryId);
    stmtTicket.setString(4, data.issueDetail);
    setStringOrNull(stmtTicket, 5, data.imageUrl);
    setStringOrNull(stmtTicket, 6, data.docPdfUrl);

    rs = stmtTicket.executeQuery();
    const newTicketId = rs.next() ? rs.getInt('Ticket_ID') : null;

    return { status: 'success', message: 'สร้างรายการแจ้งซ่อมสำเร็จ', ticketId: newTicketId };
  } catch (error) {
    return { status: 'error', message: error.toString() };
  } finally {
    if (rs) rs.close();
    if (stmtTicket) stmtTicket.close();
    if (stmtUser) stmtUser.close();
    if (conn) conn.close();
  }
}

// ==========================================
// ลบไฟล์ PDF ชั่วคราวออกจาก Drive
// ==========================================
function deleteTempPdf(data) {
  try {
    const url = (data && data.url) || '';
    const match = url.match(/[-\w]{25,}/);
    if (!match) return { status: 'error', message: 'ไม่พบ File ID ใน URL' };
    DriveApp.getFileById(match[0]).setTrashed(true);
    return { status: 'success', message: 'ลบไฟล์ชั่วคราวสำเร็จ' };
  } catch (error) {
    return { status: 'error', message: error.toString() };
  }
}

// ==========================================
// ดึงตั๋วทั้งหมดสำหรับ Task Board / Dashboard
// ==========================================
function getTickets(data) {
  return withConn_(function (conn) {
    // LEFT JOIN กันตั๋วหายถ้า master data ขาด · JOIN "USER" 2 ครั้ง: ผู้แจ้ง (u) + ผู้รับงาน (it)
    // IT_In_Charge เก็บเป็น LINE_User_ID (FK) ต้องแปลงกลับเป็นชื่อให้หน้าเว็บโชว์
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
        province: strOrNull_(rs, 'Province') || '',
        reporter: strOrNull_(rs, 'Reporter_Name') || '-',
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
// รับงาน (Open -> In Progress) — ผู้รับ = auth.userId
// ==========================================
function acceptTicket(data, auth) {
  return withConn_(function (conn) {
    const ticketId = parseInt(data && data.ticketId, 10);
    const staffUserId = auth && auth.userId;   // ตัวตนจาก idToken ไม่รับจาก client
    if (!ticketId)    return { status: 'error', message: 'ไม่ได้ระบุ ticketId' };
    if (!staffUserId) return { status: 'error', message: 'ยืนยันตัวตนไม่สำเร็จ' };

    // เช็คตัวตนก่อน เพื่อคืน error ที่อ่านรู้เรื่อง แทน FK violation ดิบจาก Postgres + เอาชื่อไปโชว์
    const stmtChk = conn.prepareStatement('SELECT "Full_Name" FROM "USER" WHERE "LINE_User_ID" = ?');
    stmtChk.setString(1, staffUserId);
    const rsChk = stmtChk.executeQuery();
    if (!rsChk.next()) {
      return { status: 'error', message: 'ยังไม่มีบัญชีเจ้าหน้าที่คนนี้ในระบบ (USER)' };
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
// เปลี่ยนสถานะตั๋ว (ลากการ์ด / ปิดงาน / เปิดใหม่)
// ==========================================
function updateTicketStatus(data) {
  return withConn_(function (conn) {
    const ticketId = parseInt(data && data.ticketId, 10);
    const status = parseInt(data && data.status, 10);
    if (!ticketId) return { status: 'error', message: 'ไม่ได้ระบุ ticketId' };
    if ([1, 2, 3].indexOf(status) === -1) return { status: 'error', message: 'สถานะไม่ถูกต้อง: ' + (data && data.status) };

    let sql;
    if (status === TICKET_STATUS.CLOSED) {
      sql = `UPDATE "TICKET" SET "Status" = ?, "Closed_Date" = NOW() WHERE "Ticket_ID" = ?`;
    } else if (status === TICKET_STATUS.OPEN) {
      sql = `UPDATE "TICKET"
             SET "Status" = ?, "IT_In_Charge" = NULL, "Accepted_Date" = NULL, "Closed_Date" = NULL
             WHERE "Ticket_ID" = ?`;
    } else {
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
// รายชื่อผู้ใช้ทั้งหมด (โมดูล Users)
// ==========================================
function getUsers(data) {
  return withConn_(function (conn) {
    // JOIN TICKET สองขา (ผู้แจ้ง/ผู้รับผิดชอบ) คูณกันเป็น cartesian -> ต้อง COUNT(DISTINCT)
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
// ดึงข้อมูลบัญชีของตัวเอง (ชื่อจริง, ตำแหน่ง, สังกัด, บทบาท)
// ใช้แสดง Topbar + หน้า Settings — ไม่ต้องรอ getUsers (Admin-only)
// ==========================================
function getMyProfile(data, auth) {
  return withConn_(function (conn) {
    const sql = `
      SELECT u."Full_Name", u."Position", u."Role",
             d."Dept_Name", b."Branch_Name", b."Province"
      FROM "USER" u
      LEFT JOIN "DEPARTMENT" d ON d."Dept_ID"   = u."Dept_ID"
      LEFT JOIN "BRANCH"     b ON b."Branch_ID" = d."Branch_ID"
      WHERE u."LINE_User_ID" = ?
    `;
    const stmt = conn.prepareStatement(sql);
    stmt.setString(1, auth.userId);
    const rs = stmt.executeQuery();
    if (!rs.next()) return { status: 'success', profile: null };
    return {
      status: 'success',
      profile: {
        name: strOrNull_(rs, 'Full_Name') || '',
        position: strOrNull_(rs, 'Position') || '',
        role: strOrNull_(rs, 'Role') || '',
        dept: strOrNull_(rs, 'Dept_Name') || '',
        branch: strOrNull_(rs, 'Branch_Name') || '',
        province: strOrNull_(rs, 'Province') || ''
      }
    };
  });
}

// ==========================================
// เปลี่ยนบทบาทผู้ใช้ (โมดูล Users) — userId = เป้าหมาย, ผู้กระทำคือ auth (ACL ยืนยัน Admin แล้ว)
// ==========================================
function updateUserRole(data, auth) {
  return withConn_(function (conn) {
    const targetId = String((data && data.userId) || '').trim();
    const key = String((data && data.role) || '').trim().toLowerCase();
    const dbRole = ROLE_DB_VALUE[key];
    if (!targetId) return { status: 'error', message: 'ไม่ได้ระบุ userId' };
    if (!dbRole)   return { status: 'error', message: 'บทบาทไม่ถูกต้อง: ' + key + ' (ต้องเป็น admin / it / staff)' };

    const cur = conn.prepareStatement('SELECT "Role" FROM "USER" WHERE "LINE_User_ID" = ?');
    cur.setString(1, targetId);
    const rsCur = cur.executeQuery();
    if (!rsCur.next()) return { status: 'error', message: 'ไม่พบผู้ใช้คนนี้ในระบบ' };
    const currentRole = rsCur.getString('Role');

    // กันแอดมินคนสุดท้ายหลุด: ลด Admin -> ไม่ใช่ Admin ต้องเหลือ Admin คนอื่น >= 1
    if (currentRole === 'Admin' && dbRole !== 'Admin') {
      const cnt = conn.prepareStatement('SELECT COUNT(*) AS n FROM "USER" WHERE "Role" = \'Admin\'');
      const rsN = cnt.executeQuery(); rsN.next();
      if (rsN.getInt('n') <= 1) {
        return { status: 'error', message: 'ต้องมีแอดมินอย่างน้อย 1 คนในระบบ — ตั้งคนอื่นเป็นแอดมินก่อนจึงจะลดสิทธิ์คนนี้ได้' };
      }
    }

    const stmt = conn.prepareStatement('UPDATE "USER" SET "Role" = ? WHERE "LINE_User_ID" = ?');
    stmt.setString(1, dbRole);   // ต้องตรง USER_Role_check เป๊ะ ไม่งั้น 23514
    stmt.setString(2, targetId);

    if (stmt.executeUpdate() === 0) return { status: 'error', message: 'ไม่พบผู้ใช้คนนี้ในระบบ' };
    invalidateRoleCache_(targetId);   // ไม่ล้าง = สิทธิ์ใหม่ยังไม่มีผลนานถึง 5 นาที
    return { status: 'success', role: dbRole };
  });
}

// ==========================================
// รายการบทความในฐานความรู้ (โมดูล Knowledge Base)
// ==========================================
function getKnowledgeBase(data) {
  return withConn_(function (conn) {
    const sql = `
      SELECT
        kb."KB_ID", kb."Ticket_ID", kb."Resolution_Text", kb."Created_Date", kb."Created_By",
        c."Category_Name", t."Issue_Detail", t."Doc_PDF_URL",
        u."Full_Name" AS "Author_Name"
      FROM "KNOWLEDGE_BASE" kb
      LEFT JOIN "ISSUE_CATEGORY" c ON c."Category_ID"  = kb."Category_ID"
      LEFT JOIN "TICKET"        t  ON t."Ticket_ID"    = kb."Ticket_ID"
      LEFT JOIN "USER"          u  ON u."LINE_User_ID" = kb."Created_By"
      ORDER BY kb."Created_Date" DESC
    `;
    const rs = conn.prepareStatement(sql).executeQuery();
    const articles = [];
    while (rs.next()) {
      const ticketId = rs.getInt('Ticket_ID');
      articles.push({
        id: rs.getInt('KB_ID'),
        ticketId: ticketId,
        ticketCode: 'TK-' + ticketId,
        category: strOrNull_(rs, 'Category_Name') || '',
        detail: strOrNull_(rs, 'Issue_Detail') || '',
        resolution: strOrNull_(rs, 'Resolution_Text') || '',
        pdfUrl: strOrNull_(rs, 'Doc_PDF_URL') || '',
        author: strOrNull_(rs, 'Author_Name') || '-',
        createdAt: toIsoLocal_(rs, 'Created_Date')
      });
    }
    return { status: 'success', articles: articles };
  });
}

// ==========================================
// เพิ่มบทความ (ตอนปิดงานพร้อมกรอกวิธีแก้ไข) — ผู้บันทึก = auth.userId
// Created_By เป็น FK -> USER.LINE_User_ID (fk_kb_creator) · Category_ID ดึงจากตัวตั๋วเอง
// ==========================================
function addKnowledgeArticle(data, auth) {
  return withConn_(function (conn) {
    const ticketId = parseInt(data && data.ticketId, 10);
    const resolutionText = String((data && data.resolutionText) || '').trim();
    const createdBy = (auth && auth.userId) || '';   // ตัวตนจาก idToken
    if (!ticketId)       return { status: 'error', message: 'ไม่ได้ระบุ ticketId' };
    if (!resolutionText) return { status: 'error', message: 'ไม่ได้ระบุวิธีแก้ไขปัญหา' };

    const stmt = conn.prepareStatement(`
      INSERT INTO "KNOWLEDGE_BASE" ("Ticket_ID", "Category_ID", "Resolution_Text", "Created_Date", "Created_By")
      SELECT ?, "Category_ID", ?, NOW(), ?
      FROM "TICKET" WHERE "Ticket_ID" = ?
    `);
    stmt.setInt(1, ticketId);
    stmt.setString(2, resolutionText);
    if (createdBy) stmt.setString(3, createdBy); else stmt.setNull(3, Jdbc.Types.VARCHAR);
    stmt.setInt(4, ticketId);

    if (stmt.executeUpdate() === 0) return { status: 'error', message: 'ไม่พบตั๋ว TK-' + ticketId };
    return { status: 'success' };
  });
}

// ==========================================
// แก้ไขบทความฐานความรู้ (แก้วิธีแก้ไขปัญหาที่พิมพ์ผิด/ไม่ครบ)
// ==========================================
function updateKnowledgeArticle(data, auth) {
  return withConn_(function (conn) {
    const kbId = parseInt(data && data.kbId, 10);
    const resolutionText = String((data && data.resolutionText) || '').trim();
    if (!kbId)           return { status: 'error', message: 'ไม่ได้ระบุ kbId' };
    if (!resolutionText) return { status: 'error', message: 'วิธีแก้ไขปัญหาห้ามว่าง' };

    const stmt = conn.prepareStatement(
      'UPDATE "KNOWLEDGE_BASE" SET "Resolution_Text" = ? WHERE "KB_ID" = ?'
    );
    stmt.setString(1, resolutionText);
    stmt.setInt(2, kbId);

    if (stmt.executeUpdate() === 0) return { status: 'error', message: 'ไม่พบบทความ KB-' + kbId };
    return { status: 'success', message: 'แก้ไขบทความ KB-' + kbId + ' สำเร็จ' };
  });
}

// ==========================================
// ดึงตั๋วของผู้ใช้ปัจจุบัน (สำหรับหน้า "ดูประวัติการแจ้งซ่อม" ของ staff)
// ACL = ['*'] — ใครก็ดูของตัวเองได้
// ==========================================
function getMyTickets(data, auth) {
  return withConn_(function (conn) {
    const sql = `
      SELECT
        t."Ticket_ID", t."Issue_Detail", t."Status", t."Doc_PDF_URL",
        t."Created_Date", t."Accepted_Date", t."Closed_Date",
        c."Category_Name", b."Branch_Name", b."Province",
        it."Full_Name" AS "Assignee_Name",
        -- ตั๋วที่ปิด-เปิด-ปิดซ้ำมี KB หลายแถว: เอาอันล่าสุดอันเดียว ไม่งั้นตั๋วโผล่ซ้ำ
        (SELECT kb."Resolution_Text" FROM "KNOWLEDGE_BASE" kb
          WHERE kb."Ticket_ID" = t."Ticket_ID"
          ORDER BY kb."Created_Date" DESC LIMIT 1) AS "Resolution_Text"
      FROM "TICKET" t
      LEFT JOIN "ISSUE_CATEGORY" c  ON c."Category_ID"   = t."Category_ID"
      LEFT JOIN "BRANCH"         b  ON b."Branch_ID"     = t."Branch_ID"
      LEFT JOIN "USER"           it ON it."LINE_User_ID" = t."IT_In_Charge"
      WHERE t."LINE_User_ID" = ?
      ORDER BY t."Ticket_ID" DESC
    `;
    var stmt = conn.prepareStatement(sql);
    stmt.setString(1, auth.userId);
    var rs = stmt.executeQuery();
    var tickets = [];
    while (rs.next()) {
      var id = rs.getInt('Ticket_ID');
      tickets.push({
        id: id,
        code: 'TK-' + id,
        detail: strOrNull_(rs, 'Issue_Detail') || '(ไม่มีรายละเอียด)',
        category: strOrNull_(rs, 'Category_Name') || '',
        branch: strOrNull_(rs, 'Branch_Name') || '',
        province: strOrNull_(rs, 'Province') || '',
        assignee: strOrNull_(rs, 'Assignee_Name') || null,
        status: rs.getInt('Status'),
        createdAt: toIsoLocal_(rs, 'Created_Date'),
        acceptedAt: toIsoLocal_(rs, 'Accepted_Date'),
        closedAt: toIsoLocal_(rs, 'Closed_Date'),
        pdfUrl: strOrNull_(rs, 'Doc_PDF_URL') || '',
        resolution: strOrNull_(rs, 'Resolution_Text') || ''
      });
    }
    return { status: 'success', tickets: tickets };
  });
}

// ==========================================
// ลบบทความฐานความรู้ (ลบถาวร ไม่ได้กระทบตั๋วต้นฉบับ)
// ==========================================
function deleteKnowledgeArticle(data, auth) {
  return withConn_(function (conn) {
    const kbId = parseInt(data && data.kbId, 10);
    if (!kbId) return { status: 'error', message: 'ไม่ได้ระบุ kbId' };

    const stmt = conn.prepareStatement('DELETE FROM "KNOWLEDGE_BASE" WHERE "KB_ID" = ?');
    stmt.setInt(1, kbId);

    if (stmt.executeUpdate() === 0) return { status: 'error', message: 'ไม่พบบทความ KB-' + kbId };
    return { status: 'success', message: 'ลบบทความ KB-' + kbId + ' สำเร็จ' };
  });
}

/* =============================================================================
   ข้อมูลหลัก (Master Data) — BRANCH / DEPARTMENT / ISSUE_CATEGORY
   -----------------------------------------------------------------------------
   ชื่อใน DB กับความหมายจริงไม่ตรงกัน (อย่าเปลี่ยนชื่อตาราง FK ผูกอยู่ทั่วระบบ):
     BRANCH     = "พื้นที่" (ภาค 9 + 7 จังหวัด)  -> TICKET.Branch_ID
     DEPARTMENT = "สาขา" ผูกกับพื้นที่ผ่าน Branch_ID -> USER.Dept_ID
   🔒 client ส่งมาแค่ key ('branch'/'dept'/'category') — ชื่อตาราง/คอลัมน์ที่ต่อเข้า SQL
      มาจาก MASTER_TABLES ฝั่ง server เท่านั้น ห้ามรับชื่อคอลัมน์จาก client (SQL injection)
   ============================================================================= */
const MASTER_TABLES = {
  branch: {
    table: 'BRANCH', id: 'Branch_ID', label: 'พื้นที่',
    cols: { name: 'Branch_Name', province: 'Province' }, ints: [], required: ['name'],
    refs: [['TICKET', 'Branch_ID', 'ตั๋วแจ้งซ่อม'], ['DEPARTMENT', 'Branch_ID', 'สาขา']]
  },
  dept: {
    table: 'DEPARTMENT', id: 'Dept_ID', label: 'สาขา',
    cols: { name: 'Dept_Name', branchId: 'Branch_ID' }, ints: ['branchId'], required: ['name', 'branchId'],
    refs: [['USER', 'Dept_ID', 'ผู้ใช้งาน']]
  },
  category: {
    table: 'ISSUE_CATEGORY', id: 'Category_ID', label: 'หมวดหมู่',
    cols: { name: 'Category_Name' }, ints: [], required: ['name'],
    refs: [['TICKET', 'Category_ID', 'ตั๋วแจ้งซ่อม'], ['KNOWLEDGE_BASE', 'Category_ID', 'ประวัติการแจ้งซ่อม']]
  }
};

// จำนวนแถวที่อ้างถึงรายการนี้ แยกตามตาราง (u0, u1, ...) — แยกไว้เพราะยอดรวมอ่านแล้วเข้าใจผิด
// (เช่น พื้นที่ "ใช้อยู่ 4" จริงๆ คือ ตั๋ว 1 + สาขาในพื้นที่ 3)
// withUsage = นับการใช้งานด้วย (เฉพาะ Admin) — ฟอร์มแจ้งซ่อมไม่ต้องใช้ และไม่ควรเห็นยอดตั๋ว/ผู้ใช้ต่อสาขา
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

// ACL '*' — ฟอร์มแจ้งซ่อมของ staff ใช้เติม dropdown
function getMasterData(data, auth) {
  const withUsage = !!(data && data.withUsage) && getUserRole_(auth.userId) === 'Admin';
  return withConn_(function (conn) {
    return {
      status: 'success',
      branches:   readMasterRows_(conn, MASTER_TABLES.branch, withUsage),
      depts:      readMasterRows_(conn, MASTER_TABLES.dept, withUsage),
      categories: readMasterRows_(conn, MASTER_TABLES.category, withUsage)
    };
  });
}

// ตรวจ + แปลงค่าที่ client ส่งมา คืน { values } หรือ { error }
function cleanMasterInput_(m, input) {
  const values = {};
  const keys = Object.keys(m.cols);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const raw = input ? input[k] : undefined;
    if (m.ints.indexOf(k) !== -1) {
      const n = parseInt(raw, 10);
      values[k] = n > 0 ? n : null;
    } else {
      const s = String(raw === undefined || raw === null ? '' : raw).trim();
      if (s.length > 200) return { error: 'ข้อความยาวเกิน 200 ตัวอักษร' };
      values[k] = s;
    }
    if (m.required.indexOf(k) !== -1 && !values[k]) return { error: 'กรุณากรอกข้อมูลให้ครบ' };
  }
  return { values: values };
}

function masterDuplicate_(conn, m, name, excludeId) {
  const stmt = conn.prepareStatement(
    'SELECT 1 FROM "' + m.table + '" WHERE LOWER(TRIM("' + m.cols.name + '")) = LOWER(?) AND "' + m.id + '" <> ?');
  stmt.setString(1, name);
  stmt.setInt(2, excludeId || 0);
  return stmt.executeQuery().next();
}

function bindMasterValues_(stmt, m, values, startIndex) {
  let i = startIndex;
  Object.keys(m.cols).forEach(function (k) {
    if (m.ints.indexOf(k) !== -1) {
      if (values[k]) stmt.setInt(i, values[k]); else stmt.setNull(i, Jdbc.Types.INTEGER);
    } else {
      setStringOrNull(stmt, i, values[k]);
    }
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

function addMasterItem(data, auth) {
  const m = MASTER_TABLES[data && data.type];
  if (!m) return { status: 'error', message: 'ไม่รู้จักประเภทข้อมูล' };
  const c = cleanMasterInput_(m, data.item);
  if (c.error) return { status: 'error', message: c.error };

  return withConn_(function (conn) {
    if (masterDuplicate_(conn, m, c.values.name, 0)) {
      return { status: 'error', message: 'มี' + m.label + 'ชื่อ "' + c.values.name + '" อยู่แล้ว' };
    }
    // id มี default (serial/identity) -> ปล่อยให้ DB ออกเอง sequence จะได้เดินตาม
    // (ใส่เองจะชน GENERATED ALWAYS และทำให้ insert ครั้งหน้าที่ใช้ default ได้ id ซ้ำ)
    // ไม่มี default -> ใช้ MAX+1 (admin เพิ่มนานๆ ครั้ง โอกาสชนกันแทบไม่มี)
    const colKeys = Object.keys(m.cols);
    const colList = colKeys.map(function (k) { return '"' + m.cols[k] + '"'; }).join(', ');
    const params = colKeys.map(function () { return '?'; }).join(', ');
    const sql = hasIdDefault_(conn, m)
      ? 'INSERT INTO "' + m.table + '" (' + colList + ') VALUES (' + params + ') RETURNING "' + m.id + '"'
      : 'INSERT INTO "' + m.table + '" ("' + m.id + '", ' + colList + ') ' +
        'SELECT COALESCE(MAX("' + m.id + '"), 0) + 1, ' + params + ' FROM "' + m.table + '" RETURNING "' + m.id + '"';
    const stmt = conn.prepareStatement(sql);
    bindMasterValues_(stmt, m, c.values, 1);
    const rs = stmt.executeQuery();
    const newId = rs.next() ? rs.getInt(1) : null;
    return { status: 'success', message: 'เพิ่ม' + m.label + 'สำเร็จ', id: newId };
  });
}

function updateMasterItem(data, auth) {
  const m = MASTER_TABLES[data && data.type];
  if (!m) return { status: 'error', message: 'ไม่รู้จักประเภทข้อมูล' };
  const id = parseInt(data.id, 10);
  if (!id) return { status: 'error', message: 'ไม่ได้ระบุรายการที่จะแก้ไข' };
  const c = cleanMasterInput_(m, data.item);
  if (c.error) return { status: 'error', message: c.error };

  return withConn_(function (conn) {
    if (masterDuplicate_(conn, m, c.values.name, id)) {
      return { status: 'error', message: 'มี' + m.label + 'ชื่อ "' + c.values.name + '" อยู่แล้ว' };
    }
    const sql = 'UPDATE "' + m.table + '" SET ' +
      Object.keys(m.cols).map(function (k) { return '"' + m.cols[k] + '" = ?'; }).join(', ') +
      ' WHERE "' + m.id + '" = ?';
    const stmt = conn.prepareStatement(sql);
    const next = bindMasterValues_(stmt, m, c.values, 1);
    stmt.setInt(next, id);
    if (stmt.executeUpdate() === 0) return { status: 'error', message: 'ไม่พบ' + m.label + 'ที่จะแก้ไข' };
    return { status: 'success', message: 'แก้ไข' + m.label + 'สำเร็จ' };
  });
}

// ลบได้เฉพาะรายการที่ไม่มีใครอ้างถึง — ตั๋วเก่า/ผู้ใช้ต้องยังแสดงชื่อได้ถูกต้อง
function deleteMasterItem(data, auth) {
  const m = MASTER_TABLES[data && data.type];
  if (!m) return { status: 'error', message: 'ไม่รู้จักประเภทข้อมูล' };
  const id = parseInt(data.id, 10);
  if (!id) return { status: 'error', message: 'ไม่ได้ระบุรายการที่จะลบ' };

  return withConn_(function (conn) {
    const inUse = [];
    m.refs.forEach(function (r) {
      const stmt = conn.prepareStatement('SELECT COUNT(*) FROM "' + r[0] + '" WHERE "' + r[1] + '" = ?');
      stmt.setInt(1, id);
      const rs = stmt.executeQuery();
      const n = rs.next() ? rs.getInt(1) : 0;
      if (n > 0) inUse.push(r[2] + ' ' + n + ' รายการ');
    });
    if (inUse.length) {
      return { status: 'error', message: 'ลบไม่ได้ — ' + m.label + 'นี้ยังถูกใช้อยู่ใน ' + inUse.join(', ') };
    }
    const stmt = conn.prepareStatement('DELETE FROM "' + m.table + '" WHERE "' + m.id + '" = ?');
    stmt.setInt(1, id);
    if (stmt.executeUpdate() === 0) return { status: 'error', message: 'ไม่พบ' + m.label + 'ที่จะลบ' };
    return { status: 'success', message: 'ลบ' + m.label + 'สำเร็จ' };
  });
}
