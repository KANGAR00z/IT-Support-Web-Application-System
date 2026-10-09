/* =============================================================================
   FAST TICKET · UseCases.gs — ลอจิกของแต่ละ action (ชื่อฟังก์ชัน = ชื่อ action ใน doPost)
   -----------------------------------------------------------------------------
   ทุก use case รับ (data, auth): data = ค่าจาก client (ห้ามเชื่อ) · auth = ตัวตนที่ verify แล้ว
   🔒 ผู้กระทำมาจาก auth.userId เสมอ — client ไม่เคยส่ง userId ของตัวเองมา
      ถ้าเห็นโค้ดที่รับ data.userId มาเชื่อเป็นผู้กระทำ นั่นคือช่องโหว่
      (updateUserRole รับ data.userId ได้เพราะเป็น "เป้าหมาย" และ ACL บังคับ Admin แล้ว)
   ============================================================================= */

const STALE_PAGE_MSG = 'หน้าเว็บเป็นเวอร์ชันเก่า กรุณาปิดแล้วเปิดใหม่ (หรือกดรีเฟรช)';

/* ---------------------------------------------------------------------------
   เอกสาร PDF (บันทึกข้อความราชการ)
   --------------------------------------------------------------------------- */

function generateDocument(data) {
  try {
    return ok_({ url: renderMemoPdf_(data || {}) });
  } catch (error) {
    return fail_(error.toString());
  }
}

// ลบ PDF ฉบับร่างที่ผู้แจ้งกดยกเลิก — ACL '*' (ทุกคนที่ login) จึงต้องกันไม่ให้ใช้ลบเอกสารจริง:
// ลบได้เฉพาะไฟล์ในโฟลเดอร์ระบบ และยังไม่มีตั๋วใบไหนอ้างถึง
function deleteTempPdf(data) {
  const fileId = driveFileId_(data && data.url);
  if (!fileId) return fail_('ไม่พบ File ID ใน URL');
  const used = withConn_(function (conn) { return { used: isPdfUsedByTicket_(conn, fileId) }; });
  if (used.status === 'error') return used;
  if (used.used) return fail_('ไฟล์นี้เป็นเอกสารของตั๋วที่บันทึกแล้ว ลบไม่ได้');
  try {
    const reason = trashMemoFile_(fileId);
    return reason ? fail_(reason) : ok_({ message: 'ลบไฟล์ชั่วคราวสำเร็จ' });
  } catch (error) {
    return fail_(error.toString());
  }
}

/* ---------------------------------------------------------------------------
   TICKET
   --------------------------------------------------------------------------- */

// ชื่อ/ตำแหน่ง/สาขา/ส่วน เป็นข้อมูลที่ผู้แจ้งกรอกเองในฟอร์ม จึงมาจาก client ได้ตามปกติ
// ผู้แจ้ง = auth.userId (จาก idToken) ไม่ใช่ data.lineUserId — กันปลอมเป็นคนอื่น
function createTicket(data, auth) {
  const reporterId = auth && auth.userId;
  if (!reporterId) return fail_('ยืนยันตัวตนไม่สำเร็จ');
  data = data || {};

  // หน้าเว็บรุ่นก่อน apiVersion 2: deptId = สาขา, branchId = พื้นที่ (ชื่อเดียวกันแต่ความหมายต่าง)
  // departmentId = ส่วน ทั้งสองรุ่น (id ชุดเดียวกัน)
  const v2 = data.apiVersion === API_VERSION;
  const branchId = toId_(v2 ? data.branchId : data.deptId);
  const officeId = toId_(v2 ? data.officeId : data.branchId);
  const departmentId = toId_(data.departmentId);
  const categoryId = toId_(data.categoryId);
  const issueDetail = cleanText_(data.issueDetail);
  if (!categoryId) return fail_('กรุณาเลือกหมวดหมู่ปัญหา');
  if (!issueDetail) return fail_('กรุณากรอกรายละเอียดอาการ');

  // ผู้ใช้ + ตั๋ว บันทึกพร้อมกัน — ตั๋วพังแล้วชื่อผู้ใช้ไม่ถูกเขียนทับไปครึ่งทาง
  return withTx_(function (conn) {
    upsertReporter_(conn, {
      userId: reporterId,
      name: cleanText_(data.displayName) || 'Unknown User',
      position: cleanText_(data.position) || 'เจ้าหน้าที่',
      branchId: branchId || 1,   // ไม่ระบุ = สำนักงานใหญ่ (คงพฤติกรรมเดิม)
      departmentId: departmentId
    });
    const ticketId = insertTicket_(conn, {
      reporterId: reporterId, officeId: officeId, branchId: branchId, departmentId: departmentId,
      categoryId: categoryId, issueDetail: issueDetail,
      imageUrl: data.imageUrl, docPdfUrl: data.docPdfUrl
    });
    return ok_({ message: 'สร้างรายการแจ้งซ่อมสำเร็จ', ticketId: ticketId });
  });
}

// คำสั่งอ่านผ่าน cachedRead_ (Infrastructure.gs): ครั้งแรกอ่าน DB แล้วเก็บไว้ ครั้งถัดไปไม่แตะ DB เลย
// ทุกคำสั่งเขียนที่สำเร็จล้างแคชทั้งหมดให้เอง (doPost -> bumpDataVersion_) ข้อมูลจึงไม่ค้าง
// ผลที่ต่างกันตามผู้ใช้ ต้องใส่ userId ในชื่อแคชเสมอ (ไม่งั้นคนหนึ่งเห็นข้อมูลของอีกคน)

function getTickets() {
  return cachedRead_('tickets', function () {
    return withConn_(function (conn) {
      return ok_({ tickets: findActiveTickets_(conn) });
    });
  });
}

// ACL '*' — ใครก็ดูของตัวเองได้ (หน้า "ประวัติการแจ้งซ่อม" ของผู้แจ้ง)
function getMyTickets(data, auth) {
  return cachedRead_('my_' + auth.userId, function () {
    return withConn_(function (conn) {
      return ok_({ tickets: findTicketsByReporter_(conn, auth.userId) });
    });
  });
}

// รับงาน (รอรับเรื่อง -> กำลังดำเนินการ) — ผู้รับ = auth.userId
function acceptTicket(data, auth) {
  const ticketId = toId_(data && data.ticketId);
  const staffUserId = auth && auth.userId;
  if (!ticketId)    return fail_('ไม่ได้ระบุ ticketId');
  if (!staffUserId) return fail_('ยืนยันตัวตนไม่สำเร็จ');

  return withConn_(function (conn) {
    // เช็คตัวตนก่อน เพื่อคืน error ที่อ่านรู้เรื่องแทน FK violation ดิบ + เอาชื่อไปโชว์
    const staffName = findUserName_(conn, staffUserId);
    if (staffName === null) return fail_('ยังไม่มีบัญชีเจ้าหน้าที่คนนี้ในระบบ (USER)');
    if (markTicketAccepted_(conn, ticketId, staffUserId) === 0) return fail_('ไม่พบตั๋ว ' + ticketCode_(ticketId));
    return ok_({ message: 'รับงาน ' + ticketCode_(ticketId) + ' โดย ' + staffName, assignee: staffName });
  });
}

// เปลี่ยนสถานะ (ลากการ์ด / ปิดงาน / เปิดใหม่)
function updateTicketStatus(data) {
  const ticketId = toId_(data && data.ticketId);
  const status = parseInt(data && data.status, 10);
  if (!ticketId) return fail_('ไม่ได้ระบุ ticketId');
  if (!isTicketStatus_(status)) return fail_('สถานะไม่ถูกต้อง: ' + (data && data.status));

  return withConn_(function (conn) {
    if (updateTicketStatusRow_(conn, ticketId, status) === 0) return fail_('ไม่พบตั๋ว ' + ticketCode_(ticketId));
    return ok_({ message: 'อัปเดตสถานะ ' + ticketCode_(ticketId) + ' เป็น ' + status });
  });
}

// ยกเลิกงาน (Admin เท่านั้น) — soft delete: หายจากบอร์ด/แดชบอร์ด แต่แถวและ PDF ยังอยู่
// PDF เป็นบันทึกข้อความฉบับจริงของราชการ จึงไม่ลบไฟล์ใน Drive
function deleteTicket(data, auth) {
  const ticketId = toId_(data && data.ticketId);
  if (!ticketId) return fail_('ไม่ได้ระบุ ticketId');

  return withConn_(function (conn) {
    if (softDeleteTicket_(conn, ticketId, auth.userId) === 0) {
      return fail_('ไม่พบตั๋ว ' + ticketCode_(ticketId) + ' หรือถูกยกเลิกไปแล้ว');
    }
    return ok_({ message: 'ยกเลิกงาน ' + ticketCode_(ticketId) + ' แล้ว' });
  });
}

/* ---------------------------------------------------------------------------
   USER
   --------------------------------------------------------------------------- */

function getUsers() {
  return cachedRead_('users', function () {
    return withConn_(function (conn) {
      return ok_({ users: findAllUsers_(conn) });
    });
  });
}

// ข้อมูลบัญชีของตัวเอง (Topbar + หน้าตั้งค่า) — ไม่ต้องรอ getUsers (Admin-only)
function getMyProfile(data, auth) {
  return cachedRead_('prof_' + auth.userId, function () {
    return withConn_(function (conn) {
      return ok_({ profile: findProfile_(conn, auth.userId) });
    });
  });
}

// data.userId = ผู้ใช้เป้าหมาย · ผู้กระทำคือ auth (ACL ยืนยัน Admin แล้ว)
function updateUserRole(data) {
  const targetId = cleanText_(data && data.userId);
  const key = cleanText_(data && data.role).toLowerCase();
  const dbRole = ROLE_DB_VALUE[key];
  if (!targetId) return fail_('ไม่ได้ระบุ userId');
  if (!dbRole)   return fail_('บทบาทไม่ถูกต้อง: ' + key + ' (ต้องเป็น admin / it / staff)');

  return withConn_(function (conn) {
    const currentRole = findUserRole_(conn, targetId);
    if (currentRole === null) return fail_('ไม่พบผู้ใช้คนนี้ในระบบ');

    // กันแอดมินคนสุดท้ายหลุด: ลด Admin -> ไม่ใช่ Admin ต้องเหลือ Admin คนอื่น >= 1
    if (currentRole === ROLE_DB_VALUE.admin && dbRole !== ROLE_DB_VALUE.admin && countAdmins_(conn) <= 1) {
      return fail_('ต้องมีแอดมินอย่างน้อย 1 คนในระบบ — ตั้งคนอื่นเป็นแอดมินก่อนจึงจะลดสิทธิ์คนนี้ได้');
    }
    if (updateUserRoleRow_(conn, targetId, dbRole) === 0) return fail_('ไม่พบผู้ใช้คนนี้ในระบบ');
    invalidateRoleCache_(targetId);   // ไม่ล้าง = สิทธิ์ใหม่ยังไม่มีผลนานถึง 5 นาที
    return ok_({ role: dbRole });
  });
}

/* ---------------------------------------------------------------------------
   KNOWLEDGE_BASE (ประวัติการแจ้งซ่อม / วิธีแก้ไขปัญหา)
   --------------------------------------------------------------------------- */

function getKnowledgeBase() {
  return cachedRead_('kb', function () {
    return withConn_(function (conn) {
      return ok_({ articles: findAllArticles_(conn) });
    });
  });
}

// ตอนปิดงานพร้อมกรอกวิธีแก้ไข — ผู้บันทึก = auth.userId
function addKnowledgeArticle(data, auth) {
  const ticketId = toId_(data && data.ticketId);
  const resolutionText = cleanText_(data && data.resolutionText);
  if (!ticketId)       return fail_('ไม่ได้ระบุ ticketId');
  if (!resolutionText) return fail_('ไม่ได้ระบุวิธีแก้ไขปัญหา');

  return withConn_(function (conn) {
    if (insertArticleFromTicket_(conn, ticketId, resolutionText, (auth && auth.userId) || '') === 0) {
      return fail_('ไม่พบตั๋ว ' + ticketCode_(ticketId));
    }
    return ok_();
  });
}

function updateKnowledgeArticle(data) {
  const kbId = toId_(data && data.kbId);
  const resolutionText = cleanText_(data && data.resolutionText);
  if (!kbId)           return fail_('ไม่ได้ระบุ kbId');
  if (!resolutionText) return fail_('วิธีแก้ไขปัญหาห้ามว่าง');

  return withConn_(function (conn) {
    if (updateArticleText_(conn, kbId, resolutionText) === 0) return fail_('ไม่พบบทความ KB-' + kbId);
    return ok_({ message: 'แก้ไขบทความ KB-' + kbId + ' สำเร็จ' });
  });
}

// ลบถาวร — ไม่กระทบตั๋วต้นฉบับ
function deleteKnowledgeArticle(data) {
  const kbId = toId_(data && data.kbId);
  if (!kbId) return fail_('ไม่ได้ระบุ kbId');

  return withConn_(function (conn) {
    if (deleteArticle_(conn, kbId) === 0) return fail_('ไม่พบบทความ KB-' + kbId);
    return ok_({ message: 'ลบบทความ KB-' + kbId + ' สำเร็จ' });
  });
}

/* ---------------------------------------------------------------------------
   ข้อมูลหลัก (Master Data)
   --------------------------------------------------------------------------- */

// ACL '*' — ฟอร์มแจ้งซ่อมใช้เติม dropdown
// withUsage (นับการใช้งาน) เฉพาะ Admin — ผู้แจ้งไม่ต้องใช้ และไม่ควรเห็นยอดตั๋ว/ผู้ใช้ต่อสาขา
// ฟอร์มแจ้งซ่อมเรียกทุกครั้งที่เปิด แต่ข้อมูลหลักแทบไม่เปลี่ยน -> แคชของตัวเองที่อยู่ได้นาน
// (ไม่ผูกเลขเวอร์ชันข้อมูล ไม่งั้นทุกการแจ้งซ่อม/รับงานจะล้างทิ้งไปด้วย) ล้างเฉพาะตอน Admin แก้ข้อมูลหลัก
// ชุดที่มียอดการใช้งาน (Admin) ยอดเปลี่ยนตามตั๋ว จึงใช้แคชแบบผูกเวอร์ชันแทน
// เปลี่ยนเลขเมื่อรูปข้อมูลเปลี่ยน (เช่นรัน SQL ที่แก้ชื่อ) — แคชเก่าใน CacheService อยู่ได้ถึง 6 ชม.
const MASTER_CACHE_KEY = 'master_v3';
const MASTER_CACHE_TTL = 6 * 3600;   // วินาที (สูงสุดของ CacheService) — กันค้างถ้าแก้ตรงใน Supabase

function clearMasterCache_() {
  cache_().remove(MASTER_CACHE_KEY);
}

function readMasterData_(withUsage) {
  return withConn_(function (conn) {
    return ok_({
      offices:     readMasterRows_(conn, MASTER_TABLES.office, withUsage),
      branches:    readMasterRows_(conn, MASTER_TABLES.branch, withUsage),
      departments: readMasterRows_(conn, MASTER_TABLES.department, withUsage),
      categories:  readMasterRows_(conn, MASTER_TABLES.category, withUsage)
    });
  });
}

function getMasterData(data, auth) {
  const withUsage = !!(data && data.withUsage) && getUserRole_(auth.userId) === ROLE_DB_VALUE.admin;
  if (withUsage) return cachedRead_('master_usage', function () { return readMasterData_(true); });

  const hit = cache_().get(MASTER_CACHE_KEY);
  if (hit) return JSON.parse(hit);
  const res = readMasterData_(false);
  if (res.status === 'success') {
    try { cache_().put(MASTER_CACHE_KEY, JSON.stringify(res), MASTER_CACHE_TTL); } catch (e) { /* เกิน 100KB — ข้ามแคช */ }
  }
  return res;
}

// ตรวจ + หาตาราง สำหรับคำสั่งเขียน — คืน { m } หรือ { error }
// ต้องมี apiVersion: key "branch" เคยหมายถึง "พื้นที่" หน้าเว็บรุ่นเก่าที่ยังค้างจะแก้/ลบผิดตาราง
function masterTarget_(data) {
  if (!data || data.apiVersion !== API_VERSION) return { error: STALE_PAGE_MSG };
  const m = MASTER_TABLES[data.type];
  return m ? { m: m } : { error: 'ไม่รู้จักประเภทข้อมูล' };
}

// ตรวจ + แปลงค่าที่ client ส่งมา คืน { values } หรือ { error }
function cleanMasterInput_(m, input) {
  const values = {};
  const keys = Object.keys(m.cols);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const raw = input ? input[k] : undefined;
    if (m.ints.indexOf(k) !== -1) {
      values[k] = toId_(raw) || null;
    } else {
      const s = cleanText_(raw);
      if (s.length > 100) return { error: 'ข้อความยาวเกิน 100 ตัวอักษร' };   // varchar(100) ใน DB
      values[k] = s;
    }
    if (m.required.indexOf(k) !== -1 && !values[k]) return { error: 'กรุณากรอกข้อมูลให้ครบ' };
  }
  return { values: values };
}

// กติกาโครงสร้างหน่วยงาน (ภาค -> พื้นที่ -> สาขา) — คืนข้อความ error หรือ '' ถ้าผ่าน
// id = 0 ตอนเพิ่มใหม่
function checkOrgRules_(conn, type, id, values) {
  if (type === 'office' && values.parentId) {
    // รองรับ 2 ชั้นเท่านั้น: แม่ต้องเป็นระดับบนสุด และพื้นที่ที่มีลูกอยู่แล้วจะไปสังกัดใครไม่ได้
    if (values.parentId === id) return 'สังกัดตัวเองไม่ได้';
    const parent = findOffice_(conn, values.parentId);
    if (!parent) return 'ไม่พบหน่วยงานที่สังกัด';
    if (parent.parentId) return '"' + parent.name + '" เป็นพื้นที่ในสังกัดอยู่แล้ว เลือกเป็นหน่วยงานแม่ไม่ได้ (รองรับ 2 ชั้น: ภาค → พื้นที่)';
    if (id && countChildOffices_(conn, id) > 0) return 'หน่วยงานนี้มีพื้นที่ในสังกัดอยู่ จึงย้ายไปสังกัดหน่วยงานอื่นไม่ได้';
  }
  if (type === 'branch') {
    // ชื่อสาขาเก็บเต็ม: เท่ากับชื่อพื้นที่ (ตัวสำนักงานพื้นที่เอง) หรือ "ชื่อพื้นที่ สาขา..."
    const office = findOffice_(conn, values.officeId);
    if (!office) return 'ไม่พบพื้นที่ที่เลือก';
    if (values.name !== office.name && values.name.indexOf(office.name + ' ') !== 0) {
      return 'ชื่อต้องขึ้นต้นด้วยชื่อพื้นที่ "' + office.name + '" เช่น "' + office.name + ' สาขา..."';
    }
  }
  return '';
}

function addMasterItem(data) {
  const t = masterTarget_(data);
  if (t.error) return fail_(t.error);
  const c = cleanMasterInput_(t.m, data.item);
  if (c.error) return fail_(c.error);

  return withConn_(function (conn) {
    if (masterNameExists_(conn, t.m, c.values.name, 0)) {
      return fail_('มี' + t.m.label + 'ชื่อ "' + c.values.name + '" อยู่แล้ว');
    }
    const rule = checkOrgRules_(conn, data.type, 0, c.values);
    if (rule) return fail_(rule);
    const id = insertMasterRow_(conn, t.m, c.values);
    clearMasterCache_();
    return ok_({ message: 'เพิ่ม' + t.m.label + 'สำเร็จ', id: id });
  });
}

// เปลี่ยนชื่อพื้นที่ = เปลี่ยนคำนำหน้าชื่อสาขาทั้งหมดในพื้นที่นั้นด้วย (transaction เดียว ไม่ค้างครึ่งทาง)
function updateMasterItem(data) {
  const t = masterTarget_(data);
  if (t.error) return fail_(t.error);
  const id = toId_(data.id);
  if (!id) return fail_('ไม่ได้ระบุรายการที่จะแก้ไข');
  const c = cleanMasterInput_(t.m, data.item);
  if (c.error) return fail_(c.error);

  return withTx_(function (conn) {
    if (masterNameExists_(conn, t.m, c.values.name, id)) {
      return fail_('มี' + t.m.label + 'ชื่อ "' + c.values.name + '" อยู่แล้ว');
    }
    const rule = checkOrgRules_(conn, data.type, id, c.values);
    if (rule) return fail_(rule);
    const before = data.type === 'office' ? findOffice_(conn, id) : null;
    if (updateMasterRow_(conn, t.m, id, c.values) === 0) return fail_('ไม่พบ' + t.m.label + 'ที่จะแก้ไข');
    let renamed = 0;
    if (before && before.name && before.name !== c.values.name) {
      renamed = renameBranchPrefix_(conn, id, before.name, c.values.name);
    }
    clearMasterCache_();
    return ok_({ message: 'แก้ไข' + t.m.label + 'สำเร็จ' + (renamed ? ' (เปลี่ยนชื่อสาขาตามด้วย ' + renamed + ' รายการ)' : '') });
  });
}

// ลบได้เฉพาะรายการที่ไม่มีใครอ้างถึง — ตั๋วเก่า/ผู้ใช้ต้องยังแสดงชื่อได้ถูกต้อง
function deleteMasterItem(data) {
  const t = masterTarget_(data);
  if (t.error) return fail_(t.error);
  const id = toId_(data.id);
  if (!id) return fail_('ไม่ได้ระบุรายการที่จะลบ');

  return withConn_(function (conn) {
    const inUse = countMasterRefs_(conn, t.m, id);
    if (inUse.length) {
      return fail_('ลบไม่ได้ — ' + t.m.label + 'นี้ยังถูกใช้อยู่ใน ' +
        inUse.map(function (u) { return u.label + ' ' + u.n + ' รายการ'; }).join(', '));
    }
    if (deleteMasterRow_(conn, t.m, id) === 0) return fail_('ไม่พบ' + t.m.label + 'ที่จะลบ');
    clearMasterCache_();
    return ok_({ message: 'ลบ' + t.m.label + 'สำเร็จ' });
  });
}
