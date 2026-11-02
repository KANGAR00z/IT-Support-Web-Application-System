/* =============================================================================
   FAST TICKET · admin.js — Task Board (Kanban) + Dashboard
   -----------------------------------------------------------------------------
   ต้องโหลดหลัง: config.js, common.js, map-data.js

   API contract (ฝั่ง GAS — ดู gas/UseCases.gs) · รายการทุกหน้าแบ่งหน้าที่ DB (ดึงทีละหน้า)
     getBoard({ q, categoryId, province, mine, closedDays, sort, pageSize, pages:{1:n,2:n,3:n}, facets })
       -> { columns:[ { status, page, total, all, tickets:[ { id, code, detail, category, office,
            branch, department, province, reporter, assignee, status, createdAt, acceptedAt,
            closedAt, pdfUrl } ] } ], categories? }   (ไม่รวมงานที่ถูกยกเลิก)
          total = ยอดที่ตรงตัวกรอง · all = ยอดทั้งคอลัมน์ · page ถูกปรับถ้าขอเกินหน้าสุดท้าย
          office = พื้นที่ (EXCISE_OFFICE) · branch = สาขา (BRANCH) · department = ส่วน (DEPARTMENT)
          branch/department ว่างได้สำหรับตั๋วเก่า
     getDashboard({ agingDays }) -> { kpi, categories, provinces, staff, oldest, trend }  (สรุปจาก SQL)
     getUsers({ q, role, page, pageSize }) -> { users, total, page, counts }
     getKnowledgeBase({ q, categoryId, page, pageSize, facets }) -> { articles, total, page, categories? }
     deleteTicket({ ticketId })                 // Admin เท่านั้น — ยกเลิกงาน (soft delete)
     acceptTicket({ ticketId, staffUserId })   // รับงาน -> IN_PROGRESS
       -> { status:'success', assignee:'<Full_Name จาก DB>' }
       ⚠️ staffUserId ต้องเป็น LINE userId เพราะ TICKET.IT_In_Charge เป็น FK
          ชี้ USER.LINE_User_ID (constraint fk_ticket_it) — ชื่อเปล่าๆ DB ปฏิเสธ
     updateTicketStatus({ ticketId, status })  // ลากการ์ด/ปิดงาน/เปิดใหม่
       -> { status:'success' }
   ============================================================================= */

// ---------- ค่าคงที่ ----------
// ⚙️ ตรงกับ TICKET.Status ในฐานข้อมูล: 1 รอรับเรื่อง / 2 กำลังดำเนินการ / 3 เสร็จสิ้น
const STATUS = { OPEN: 1, IN_PROGRESS: 2, CLOSED: 3 };

const COLUMNS = [
  // สีสถานะเหลือแค่ "จุด" หน้าชื่อคอลัมน์ (ชื่อเป็นสีหมึก) — พื้นคอลัมน์เป็นเทาเรียบเหมือนกันหมด (.col-surface)
  // tab = ชื่อบนแท็บมือถือ (3 แท็บในจอ 360px — "กำลังดำเนินการ" ยาวจนถูกตัด)
  { key:'OPEN',        status:STATUS.OPEN,        title:'รอรับเรื่อง',      tab:'รอรับเรื่อง', en:'Open',        dot:'bg-amber-500' },
  { key:'IN_PROGRESS', status:STATUS.IN_PROGRESS, title:'กำลังดำเนินการ',   tab:'กำลังทำ',    en:'In Progress', dot:'bg-blue-600' },
  { key:'CLOSED',      status:STATUS.CLOSED,      title:'เสร็จสิ้น',         tab:'เสร็จสิ้น',   en:'Closed',      dot:'bg-emerald-600' },
];

// จอสัมผัส: HTML5 drag & drop ไม่ทำงานบนมือถือเลย (dragstart ไม่ยิง)
// จึงต้องเปลี่ยนทั้งข้อความบอกวิธีใช้ และปิด draggable ทิ้ง ไม่งั้น Android จะกดค้าง
// แล้วเกิด ghost image ค้างจนเลื่อนบอร์ดไม่ได้ — ปุ่มบนการ์ดคือทางเปลี่ยนสถานะบนมือถือ
const IS_TOUCH = window.matchMedia('(hover: none)').matches;

// short = หัวข้อบนมือถือ (ชื่อเต็มสองภาษายาวจนถูกตัดเป็น "ตารางงาน IT Supp…")
const VIEWS = {
  dashboard: { title:'แดชบอร์ด (Dashboard)', short:'แดชบอร์ด', sub:'ภาพรวมงานแจ้งซ่อม · คำนวณจากตั๋วทั้งหมด' },
  board:     { title:'ตารางงาน IT Support (Task Board)', short:'ตารางงาน',
               sub: IS_TOUCH ? 'แตะการ์ดเพื่อดูรายละเอียด · ปัดซ้าย-ขวาเพื่อดูคอลัมน์อื่น'
                             : 'ลากการ์ดเพื่อเปลี่ยนสถานะ · คลิกการ์ดเพื่อดูรายละเอียด' },
  kb:        { title:'ประวัติการแจ้งซ่อม', short:'ประวัติการแจ้งซ่อม', sub:'รวมประวัติและวิธีแก้ไขปัญหาจากตั๋วที่ปิดงานแล้ว' },
  users:     { title:'ผู้ใช้งาน (Users)', short:'ผู้ใช้งาน', sub:'จัดการบัญชีผู้ใช้งานและสิทธิ์การเข้าถึงระบบทั้งหมด' },
  master:    { title:'ข้อมูลหลัก (Master Data)', short:'ข้อมูลหลัก', sub:'พื้นที่ · สาขา · ส่วน · หมวดหมู่ปัญหา ที่ใช้ในฟอร์มแจ้งซ่อม' },
  settings:  { title:'ตั้งค่า (Settings)', short:'ตั้งค่า', sub:'เกี่ยวกับฉันและค่าตั้งต้นของแดชบอร์ด' },
};

// บทบาทผู้ใช้ — DB มีค่าเก่าปนอยู่ ('Staff' ตัวใหญ่จาก createTicket) จึง normalize
// แบบ case-insensitive ผ่าน roleOf(): รู้จักแค่ admin/it ที่เหลือถือเป็นผู้ใช้ทั่วไปหมด
const ROLES = {
  admin: { label:'แอดมิน',         badge:'bg-violet-100 text-violet-700' },
  it:    { label:'เจ้าหน้าที่ IT', badge:'bg-blue-100 text-blue-700' },
  staff: { label:'ผู้ใช้งานทั่วไป', badge:'bg-slate-100 text-slate-600' },
};
const roleOf = (r) => {
  const x = String(r || '').trim().toLowerCase();
  return (x === 'admin' || x === 'it') ? x : 'staff';
};

const SEQ = ['--seq-1','--seq-2','--seq-3','--seq-4'];   // ramp 4 ขั้นของแผนที่ (0 ตั๋วใช้ --seq-0)
const NO_PROV = 'ไม่ระบุพื้นที่';
const DAY_MS = 86400000;

// พื้นหลังกับตัวอักษรต้องเป็นสีเดียวกัน (เฉด 100 คู่กับ 700) เหมือนอีกสามหมวด
// พื้นส้ม + ตัวอักษรแดง อ่านเหมือนใส่ผิดมากกว่าตั้งใจเน้น
const catColor = (c) => ({
  'ฮาร์ดแวร์':'bg-red-100 text-red-700',
  'ซอฟต์แวร์':'bg-blue-100 text-blue-700',
  'เครือข่าย':'bg-purple-100 text-purple-700'
}[c] || 'bg-slate-100 text-slate-600');

const cssVar = (n) => getComputedStyle(document.body).getPropertyValue(n).trim();

// ---------- สถานะของหน้า ----------
// ทุกหน้าโหลดเฉพาะตอนเปิดดู (lazy) และดึงจาก DB ทีละหน้า — ไม่โหลดตั๋ว/ผู้ใช้/ประวัติทั้งหมดมาไว้ในเครื่อง
let tickets = [];             // ตั๋วบนบอร์ด "หน้าที่แสดงอยู่" ของทุกคอลัมน์ (หาตั๋วจาก id ตอนกดปุ่ม/ลากการ์ด)
let currentView = 'board';
// ---------- บอร์ด ----------
let boardSearch = '';
let boardCat = 'all';         // Category_ID (string) หรือ 'all'
let boardProv = 'all';        // ชื่อจังหวัด (key ใน PROVINCES) หรือ 'all'
let boardMine = false;
let boardSort = 'new';        // new = ใหม่สุดก่อน · old = เก่าสุดก่อน (ไล่งานค้าง)
// คอลัมน์ "เสร็จสิ้น" โตขึ้นเรื่อยๆ ไม่มีวันหยุด และงานที่ปิดไปนานแล้วแทบไม่มีใครดู
// จึงตัดให้เหลือเฉพาะช่วงล่าสุด (0 = แสดงทั้งหมด)
let closedDays = parseInt(localStorage.getItem('ft_closed_days'), 10);
if (isNaN(closedDays)) closedDays = 7;
let boardCompact = localStorage.getItem('ft_board_compact') === '1';
// คอลัมน์ที่แสดงบนมือถือ (แท็บสถานะ) — จำไว้ข้ามการเปิดหน้า
let mobileCol = parseInt(localStorage.getItem('ft_mobile_col'), 10) || 1;
const BOARD_PAGE = 20;        // การ์ดต่อหน้า ต่อคอลัมน์
let colPage = { 1: 1, 2: 1, 3: 1 };   // status -> หน้าที่แสดง
let boardCols = null;         // status -> { tickets, total, all, page } จาก getBoard (null = ยังไม่มีข้อมูล)
let boardCats = [];           // ตัวเลือกหมวดหมู่ของตัวกรอง [{ id, name }]
let boardLoaded = false;      // โหลดสำเร็จแล้ว — สลับหน้ากลับมาไม่ต้องโหลดซ้ำ (ล้มเหลว = กลับมาแล้วลองใหม่เอง)
// โมดูล Users — โหลดแบบ lazy ตอนเข้าหน้า ไม่ดึงพร้อมตั๋ว
const USERS_PAGE = 20;
let users = [];               // ผู้ใช้ในหน้าที่แสดงอยู่
let usersPage = 1;
let usersTotal = 0;           // จำนวนที่ตรงตัวกรอง (ใช้แบ่งหน้า)
let usersCounts = { all: 0, admin: 0, it: 0, staff: 0 };   // ยอด KPI ของทั้งระบบ
let usersLoaded = false;
let userSearch = '';
let userRoleFilter = 'all';
// โมดูล Knowledge Base — โหลดแบบ lazy เหมือนกัน
const KB_PAGE = 20;
let kbArticles = [];          // ประวัติในหน้าที่แสดงอยู่
let kbPage = 1;
let kbTotal = 0;
let kbCats = null;            // ชิพหมวดหมู่ [{ id, name, n }] — null = ขอใหม่พร้อมหน้าถัดไป (facets)
let kbLoaded = false;
let kbSearch = '';
let kbCatFilter = 'all';      // 'all' | 'none' (ไม่มีหมวด) | Category_ID (string)
let pendingKbEditId = null;   // KB_ID ที่กำลังแก้ไขใน kbEditModal
// ticketId ที่รอกรอกวิธีแก้ไขใน closeModal ก่อนปิดงานจริง (ดู requestClose/finishClose)
let pendingCloseId = null;
// ---------- Settings ----------
// เก็บไว้ใน localStorage ล้วนๆ (ต่อเบราว์เซอร์ ไม่ใช่ค่าส่วนกลาง) — ยังไม่มีเหตุผลพอจะ
// เพิ่มตาราง/คอลัมน์ backend สำหรับตั้งค่าที่มีแค่ตัวเดียวตอนนี้
let agingDays = parseInt(localStorage.getItem('ft_aging_days'), 10) || 3;
// ตัวตนเจ้าหน้าที่มาจาก LINE login เท่านั้น (เหตุผลดู contract ด้านบน)
let currentStaff   = localStorage.getItem('ft_staff') || '';      // ชื่อสำหรับแสดงผล (LINE displayName -> ถูกแทนที่ด้วย Full_Name จาก DB หลังโหลดโปรไฟล์)
let currentStaffId = localStorage.getItem('ft_staff_id') || '';   // LINE userId ที่ส่งให้ backend
let staffPicUrl    = localStorage.getItem('ft_staff_pic') || '';   // URL รูปโปรไฟล์จาก LINE
// ข้อมูลจาก DB (getMyProfile) — โหลดหลัง login สำเร็จ
// key มี _v2: โปรไฟล์/แคชตั๋วรุ่นก่อนเปลี่ยนชื่อตาราง ใช้ branch = พื้นที่ ซึ่งตอนนี้ branch = สาขา
const PROFILE_KEY = 'ft_staff_profile_v2';
try { localStorage.removeItem('ft_staff_profile'); localStorage.removeItem('ft_tickets_cache'); } catch (e) {}
let staffProfile   = JSON.parse(localStorage.getItem(PROFILE_KEY) || 'null');  // { name, position, role, office, branch, department, province }

// ปุ่มยกเลิกงานแสดงเฉพาะแอดมิน (ด่านจริงคือ ACL ของ deleteTicket ฝั่ง backend)
function isAdminUser() {
  return !!staffProfile && roleOf(staffProfile.role) === 'admin';
}

const callBackend = (action, data) => ftCallBackend(action, data);

// LIFF init เป็น async แต่ switchView() วาดหน้าทันทีและสั่งโหลดข้อมูลของหน้านั้นเลย
// ถ้าไม่รอ liff.init() ให้เสร็จก่อน getIDToken() จะคืน null -> backend ปฏิเสธ -> ขึ้นหน้า "ยังไม่ได้เข้าสู่ระบบ"
// ทั้งที่ login อยู่แท้ๆ · ทุก loadX() จึงต้อง await ตัวนี้ก่อนยิง backend
// ค่า false = กำลังเด้งไปหน้า login (หน้านี้กำลังถูกทิ้ง) -> loadX() หยุด ไม่ต้องยิง backend
let liffReady = Promise.resolve(true);
let liffError = '';   // สาเหตุที่ login LINE ไม่ผ่าน — โชว์บนจอ เพราะในแอป LINE เปิด console ไม่ได้

/* ---------- หน้าสถานะ "โหลดไม่สำเร็จ" (แทนข้อมูลตัวอย่างเดิม) ----------
   โหลดหน้าไหนไม่สำเร็จ = ซ่อนเนื้อหาหน้านั้นทั้งหมด (รวมข้อมูลเก่า/แคช) แล้วโชว์ไอคอน + สาเหตุ + คำแนะนำ
   (ftErrorState ใน common.js) — ข้อมูลเก่าที่ค้างจออาจทำให้เข้าใจผิดว่าเป็นปัจจุบัน
   ข้อความดิบพับไว้ใต้ "รายละเอียดสำหรับผู้ดูแลระบบ" — ในแอป LINE เปิด DevTools ไม่ได้ นี่คือทางเดียวที่จะรู้สาเหตุ */
const VIEW_ERR_BOX = { board: 'viewBoard', dashboard: 'viewDashboard', users: 'viewUsers', kb: 'viewKB', master: 'viewMaster' };
const ERR_EL = { board: 'boardError', dashboard: 'dashError', users: 'usersError', kb: 'kbError', master: 'masterError' };
const viewErr = {};   // view -> Error ล่าสุดที่ยังไม่หาย (ใช้ตอนกลับมาออนไลน์ / สลับกลับมาหน้านี้)

function showViewError(view, e, retry, opts) {
  // ไม่มี token เพราะ LINE login พังตั้งแต่เปิดหน้า -> บอกสาเหตุจริง (liffError) แทน "ยังไม่ได้เข้าสู่ระบบ"
  if (liffError && ftErrorKind(e) === 'nologin') {
    e = ftErr(liffError, 'liff');
    retry = () => location.reload();
  }
  viewErr[view] = e;
  $(VIEW_ERR_BOX[view]).classList.add('has-error');
  if (view === 'board') $('boardTools').classList.add('has-error');   // แถบกรองอยู่นอก #viewBoard
  ftErrorState($(ERR_EL[view]), e, Object.assign({
    onRetry: retry,
    onLogin: ensureLogin,
    lineId: currentStaffId,
    where: 'admin · ' + VIEWS[view].title,
  }, opts));
}

function clearViewError(view) {
  if (!viewErr[view]) return;
  viewErr[view] = null;
  $(VIEW_ERR_BOX[view]).classList.remove('has-error');
  if (view === 'board') $('boardTools').classList.remove('has-error');
}

// แยก "เซสชันหมดอายุ" ออกจากความผิดพลาดอื่น (เน็ตหลุด / backend ล่ม)
// เพราะสองอย่างนี้ผู้ใช้ต้องทำคนละเรื่อง: อันนี้ต้อง login ใหม่ ส่วนอันนั้นแค่กดโหลดใหม่
// liff.getIDToken() ไม่ต่ออายุ token ให้เอง มันคืนใบเดิมที่หมดอายุไปเรื่อยๆ
// ทางเดียวคือ login ใหม่ ซึ่งผู้ใช้เดาเองไม่ได้ถ้าระบบไม่บอก
const isAuthError = (e) => /ยืนยันตัวตน|ID Token|เข้าสู่ระบบใหม่/.test((e && e.message) || '');

// แถบเตือนเมื่อ "บันทึก" ไม่สำเร็จเพราะเซสชันหมดอายุ (โหลดไม่สำเร็จใช้หน้าสถานะแทน)
// ไม่เด้งไปหน้า login เองอัตโนมัติ — ถ้า login ไม่ผ่านจะวนซ้ำไม่รู้จบ ให้ผู้ใช้กดเองจากปุ่มบนแถบ
function setAuthExpired(on) {
  const el = $('authBanner');
  if (el) el.classList.toggle('hidden', !on);
  const reason = $('authReason');
  if (reason) reason.innerText = on && liffError ? 'สาเหตุ: ' + liffError : '';
}

/* ---------- แคชตั๋วในเครื่อง (stale-while-revalidate) ------------------------
   วัดจริงแล้วรอบหนึ่งของ GAS กินเวลา 1.3-2.1 วิ ก่อนแตะฐานข้อมูลด้วยซ้ำ
   (302 redirect ของ GAS อย่างเดียวก็ ~1-1.7 วิ) บวก liff.init อีกราว 0.7 วิ
   -> เปิดแอปแล้วจอว่างหลายวินาทีทุกครั้ง ทั้งที่ข้อมูลส่วนใหญ่เหมือนเดิม

   จึงเก็บผลลัพธ์ล่าสุดไว้ แล้ววาดทันทีตอนเปิด จากนั้นค่อยดึงของใหม่มาทับเบื้องหลัง
   ผู้ใช้เห็นบอร์ดทันที แต่ต้องบอกให้ชัดว่ากำลังอัปเดตอยู่ ไม่งั้นจะเข้าใจผิดว่าสดแล้ว
   เก็บเฉพาะ "หน้าแรกที่ไม่ได้กรอง" ของบอร์ด และแดชบอร์ด — คือสิ่งที่เห็นตอนเปิดแอป
   ---------------------------------------------------------------------------- */
const BOARD_CACHE_KEY = 'ft_board_v3';      // v3: บอร์ดแบ่งหน้า (v2 เก็บตั๋วทั้งหมด)
const DASH_CACHE_KEY = 'ft_dash_v1';
const VIEW_CACHE_MAX_AGE = 24 * 3600e3;     // เกิน 1 วันถือว่าเก่าเกินกว่าจะเอามาโชว์
try { localStorage.removeItem('ft_tickets_v2'); } catch (e) {}

// tag = สิ่งที่ต้องตรงกันถึงจะใช้ได้ (ตัวกรองของบอร์ด / เกณฑ์ค้างของแดชบอร์ด)
function readViewCache(key, tag) {
  try {
    const o = JSON.parse(localStorage.getItem(key) || 'null');
    if (!o || !o.res || !o.savedAt || o.tag !== tag) return null;
    if (Date.now() - o.savedAt > VIEW_CACHE_MAX_AGE) return null;
    // แคชผูกกับบัญชี — กันข้อมูลของคนก่อนหน้าโผล่ให้อีกคนเห็นบนเครื่องที่ใช้ร่วมกัน
    if (o.owner && currentStaffId && o.owner !== currentStaffId) return null;
    return o;
  } catch (e) { return null; }
}

function writeViewCache(key, tag, res) {
  try {
    localStorage.setItem(key, JSON.stringify({ savedAt: Date.now(), owner: currentStaffId || '', tag, res }));
  } catch (e) { /* โควตาเต็ม/โหมดส่วนตัว — แคชเป็นของแถม ไม่ใช่ของจำเป็น */ }
}

function clearViewCaches() {
  try { localStorage.removeItem(BOARD_CACHE_KEY); localStorage.removeItem(DASH_CACHE_KEY); } catch (e) {}
}

// แถบเล็กๆ บอกว่าที่เห็นอยู่เป็นของเก่าและกำลังดึงของใหม่ — แยกตามหน้า (บอร์ด/แดชบอร์ดโหลดคนละชุด)
// savedAt: เวลาของข้อมูลเก่าที่โชว์อยู่ · true = ยังไม่มีอะไรให้ดู (กำลังโหลดครั้งแรก) · false = ปิด
const staleState = { board: false, dashboard: false };
function setStale(view, savedAt) {
  staleState[view] = savedAt;
  syncStaleBar();
}
function syncStaleBar() {
  const el = $('staleBar');
  if (!el) return;
  const s = staleState[currentView];
  el.classList.toggle('hidden', !s);
  if (s) $('staleText').innerText = s === true ? 'กำลังโหลดข้อมูล…'
    : 'กำลังอัปเดตข้อมูล… ที่เห็นอยู่คือข้อมูลเมื่อ ' + timeAgo(new Date(s).toISOString());
}

/* ---------- แบ่งหน้า: แคชหน้าในเครื่อง + โหลดหน้าถัดไปรอไว้ -------------------------
   เปลี่ยนหน้าแต่ละครั้ง = เรียก GAS 1 รอบ (~1.5-2 วิ) จึงเก็บหน้าที่เคยโหลดไว้สั้นๆ และโหลดหน้าถัดไป
   รอไว้เบื้องหลัง กด "ถัดไป" แล้วขึ้นทันที · ล้างทิ้งทุกครั้งที่มีการแก้ข้อมูลหรือกดโหลดใหม่
   ---------------------------------------------------------------------------- */
const PAGE_CACHE_MS = 60e3;
const pageCache = new Map();   // action + พารามิเตอร์ (JSON) -> { at, res }

// facets (ขอรายการหมวดหมู่แนบมาด้วย) ไม่อยู่ใน key — คำตอบที่มี categories อยู่แล้วใช้แทนคำขอที่ไม่ขอได้
// ไม่งั้นหน้าแรก (ขอ facets ตอนเปิด) จะไม่ตรงกับตอนกดย้อนกลับมา (ไม่ขอแล้ว) ต้องโหลดใหม่ทุกครั้ง
async function fetchPage(action, params, opts) {
  const { facets, ...rest } = params;
  const k = action + JSON.stringify(rest);
  const hit = pageCache.get(k);
  if (hit && Date.now() - hit.at < PAGE_CACHE_MS && (!facets || hit.res.categories)) return hit.res;
  const res = await ftCallBackend(action, params, null, opts);
  if (!res || res.status !== 'success') throw new Error((res && res.message) || 'ไม่มีข้อมูลจาก backend');
  pageCache.set(k, { at: Date.now(), res });
  return res;
}

// พังก็ช่าง — ตอนกดจริงจะโหลดใหม่และแจ้ง error ตามปกติ · noRelogin: งานเบื้องหลังห้ามพาเด้งไปหน้า login
function prefetchPage(action, params) {
  fetchPage(action, params, { noRelogin: true }).catch(() => {});
}

function clearPageCache() { pageCache.clear(); }

// แถบเปลี่ยนหน้า "‹ ก่อนหน้า · หน้า 2/5 · ถัดไป ›" — ซ่อนเองถ้ามีหน้าเดียว
// compact = ในคอลัมน์บอร์ด (แคบ) เหลือแค่ลูกศร
function renderPager(el, { page, total, size, onGo, compact }) {
  if (!el) return;
  const pages = Math.max(1, Math.ceil(total / size));
  el.classList.toggle('hidden', pages <= 1);
  if (pages <= 1) { el.innerHTML = ''; return; }
  const from = (page - 1) * size + 1, to = Math.min(total, page * size);
  const btn = (step, html, disabled, label) =>
    `<button data-go="${step}" ${disabled ? 'disabled' : ''} aria-label="${label}" class="inline-flex items-center gap-1 px-2.5 sm:px-3 py-1.5 min-h-[36px] rounded-lg text-xs font-medium border border-slate-300 bg-white text-slate-600 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed">${html}</button>`;
  el.innerHTML =
    btn(-1, icon('chevron-left', 'w-4 h-4') + (compact ? '' : '<span class="hidden sm:inline">ก่อนหน้า</span>'), page <= 1, 'หน้าก่อนหน้า') +
    `<span class="text-xs tabular-nums text-center" style="color:var(--ink-2)">หน้า <b>${page}</b>/${pages}` +
      (compact ? '' : `<span class="hidden sm:inline" style="color:var(--ink-muted)"> · ${from}–${to} จาก ${total}</span>`) + `</span>` +
    btn(1, (compact ? '' : '<span class="hidden sm:inline">ถัดไป</span>') + icon('chevron-right', 'w-4 h-4'), page >= pages, 'หน้าถัดไป');
  el.querySelectorAll('[data-go]').forEach(b =>
    b.addEventListener('click', () => onGo(Math.min(pages, Math.max(1, page + Number(b.dataset.go))))));
}

// ระหว่างรอหน้าใหม่: จางเนื้อหาเดิมไว้ให้รู้ว่ากำลังโหลด
// (กดรัวได้ — ทุกตัวโหลดมีเลขลำดับคำขอ คำตอบของคำขอเก่าที่มาช้าจะถูกทิ้ง)
function setBusy(el, on) {
  if (!el) return;
  el.classList.toggle('is-busy', !!on);
  el.setAttribute('aria-busy', on ? 'true' : 'false');
}

// ---------- โหลดบอร์ด (ทีละหน้า) ----------
function boardParams() {
  return {
    q: boardSearch.trim(),
    categoryId: boardCat === 'all' ? 0 : Number(boardCat),
    province: boardProv === 'all' ? '' : boardProv,
    mine: boardMine,
    closedDays,
    sort: boardSort,
    pageSize: BOARD_PAGE,
    pages: { ...colPage },
    facets: !boardCats.length,   // รายการหมวดหมู่ของตัวกรอง ขอจาก DB แค่ครั้งแรก
  };
}

// แคชในเครื่อง (เปิดแอปแล้วเห็นบอร์ดทันที) เก็บเฉพาะหน้าแรกที่ไม่ได้กรอง — tag = ช่วงวันของงานเสร็จ
const boardIsLanding = (p) => !p.q && !p.categoryId && !p.province && !p.mine && p.sort === 'new' &&
  p.pages[1] === 1 && p.pages[2] === 1 && p.pages[3] === 1;

let boardSeq = 0;           // เลขลำดับคำขอ — คำตอบของคำขอเก่าที่มาช้ากว่าจะถูกทิ้ง
let boardBusy = false;      // กำลังรอหน้าใหม่ (มุมขวาของแถบเครื่องมือแสดง "กำลังโหลด…")
let boardWrites = 0;        // คำสั่งเขียนที่ยังรอผล — ระหว่างนี้อย่าเพิ่งโหลดบอร์ดใหม่ทับ
let boardRefreshTimer = null;

// opts.quiet = โหลดเบื้องหลังหลังแก้ข้อมูล (ไม่จางบอร์ด)
// opts.prefetch = status ของคอลัมน์ที่เพิ่งเปลี่ยนหน้า -> โหลดหน้าถัดไปของคอลัมน์นั้นรอไว้
async function loadBoard(opts = {}) {
  const seq = ++boardSeq;
  const params = boardParams();
  // รอบแรก: วาดของที่จำไว้ก่อน ไม่ต้องมองจอว่างระหว่างรอ liff.init + GAS (รวม ~2-4 วิ)
  if (!boardCols && boardIsLanding(params)) {
    const cached = readViewCache(BOARD_CACHE_KEY, closedDays);
    if (cached) { applyBoard(cached.res); setStale('board', cached.savedAt); }
  }
  if (!opts.quiet) {
    boardBusy = true;
    setBusy($('board'), boardLoaded);   // รอบแรกไม่จาง — ของจากแคชควรดูใช้งานได้ (แถบด้านบนบอกว่ากำลังอัปเดต)
    syncBoardCount();
  }

  if ((await liffReady) === false) return;   // กำลังเด้งไปหน้า login (ดูคอมเมนต์ที่ liffReady)
  try {
    const res = await fetchPage('getBoard', params);
    if (seq !== boardSeq) return;   // ผู้ใช้เปลี่ยนหน้า/ตัวกรองต่อไปแล้ว
    applyBoard(res);
    clearViewError('board');
    boardLoaded = true;
    if (boardIsLanding(params)) writeViewCache(BOARD_CACHE_KEY, closedDays, res);
    setStale('board', false);
    const st = opts.prefetch, c = st && boardCols[st];
    if (c && c.page * BOARD_PAGE < c.total) {
      prefetchPage('getBoard', { ...boardParams(), pages: { ...colPage, [st]: c.page + 1 } });
    }
  } catch (e) {
    if (seq !== boardSeq) return;
    // โหลดไม่สำเร็จ = หน้าสถานะแทนเสมอ แม้มีข้อมูลเก่า/แคชอยู่ (ข้อมูลเก่าอาจทำให้เข้าใจผิดว่าเป็นปัจจุบัน)
    setStale('board', false);
    showViewError('board', e, () => loadBoard());
  } finally {
    if (seq === boardSeq) {
      boardBusy = false;
      setBusy($('board'), false);
      syncBoardCount();
    }
  }
}

function applyBoard(res) {
  boardCols = {};
  (res.columns || []).forEach(c => {
    boardCols[c.status] = {
      tickets: (c.tickets || []).map(normalize),
      total: Number(c.total) || 0, all: Number(c.all) || 0, page: Number(c.page) || 1,
    };
    colPage[c.status] = boardCols[c.status].page;   // server ปรับให้ถ้าหน้าที่ขอเลยหน้าสุดท้าย
  });
  if (res.categories) boardCats = res.categories.map(c => ({ id: c.id, name: cleanCategory(c.name) || c.name }));
  tickets = Object.values(boardCols).flatMap(c => c.tickets);
  render();
}

// หลังแก้ข้อมูลสำเร็จ: โหลดหน้าที่ดูอยู่ใหม่เบื้องหลัง ให้ลำดับ/การแบ่งหน้าตรงกับ DB
// หน่วงไว้ให้กดหลายใบติดกันได้ก่อน แล้วค่อยโหลดครั้งเดียว
function refreshBoardSoon() {
  clearTimeout(boardRefreshTimer);
  boardRefreshTimer = setTimeout(() => {
    if (boardWrites > 0) return refreshBoardSoon();
    loadBoard({ quiet: true });
  }, 1500);
}

// เติมค่าที่อาจขาดจาก backend ให้ครบทุก field ที่หน้าเว็บใช้
function normalize(t) {
  return {
    id: t.id,
    code: t.code || ('TK-' + t.id),
    detail: t.detail || '(ไม่มีรายละเอียด)',
    category: cleanCategory(t.category || ''),
    office: t.office || '',           // พื้นที่
    branch: t.branch || '',       // สาขา — ว่าง = ตั๋วเก่าที่ไม่รู้สาขา
    department: t.department || '',     // ส่วน — ว่าง = ตั๋วก่อนเริ่มเก็บส่วนลง DB
    province: t.province || '',   // ใช้กับแผนที่ (ถ้าไม่มี จะ fallback เดาจากชื่อสาขาใน normProv)
    reporter: t.reporter || '-',
    assignee: t.assignee || null,
    status: Number(t.status),
    createdAt: t.createdAt || null,
    acceptedAt: t.acceptedAt || null,
    closedAt: t.closedAt || null,
    pdfUrl: t.pdfUrl || '',
    imageUrl: t.imageUrl || '',   // รูปอาการเสีย (Drive) — backend ก่อน 2026-11-02 ไม่ส่งมา
    phone: t.phone || ''          // เบอร์ภายในตอนแจ้ง — ตั๋วเก่ามีแค่ในเอกสาร PDF
  };
}

/* =============================================================================
   Task Board (Kanban)
   ============================================================================= */

// กรอง/ค้นหา/เรียง/แบ่งหน้า ทำที่ DB ทั้งหมด (getBoard) — เปลี่ยนตัวกรองแล้วกลับไปหน้า 1 ทุกคอลัมน์
function applyBoardFilter() {
  colPage = { 1: 1, 2: 1, 3: 1 };
  loadBoard();
}

// เปลี่ยนหน้าของคอลัมน์เดียว (คอลัมน์อื่นอยู่หน้าเดิม) แล้วโหลดหน้าถัดไปของคอลัมน์นี้รอไว้
function goColPage(status, page) {
  colPage[status] = page;
  loadBoard({ prefetch: status });
}

function render() {
  const board = $('board');
  if (!boardCols) return;   // ยังไม่มีข้อมูล — ปล่อยโครงหน้า (skeleton) ไว้
  board.innerHTML = '';
  board.classList.toggle('board-compact', boardCompact);
  for (const col of COLUMNS) {
    const c = boardCols[col.status] || { tickets: [], total: 0, all: 0, page: 1 };
    const colEl = document.createElement('div');
    // มือถือ: กว้าง 86vw ให้เห็นคอลัมน์ถัดไปโผล่มานิดนึง = บอกใบ้ว่าปัดต่อได้
    // (ถ้า fix 320px บนจอ 360px จะเต็มพอดีจนดูเหมือนไม่มีอะไรต่อ)
    // max-w ต้องปลดที่ md ด้วย (md:max-w-none) ไม่งั้นมันคุมทับ w-[320px] บนเดสก์ท็อป
    // ทำให้คอลัมน์กว้าง 340px แล้วบอร์ดเลื่อนแนวนอนทั้งที่จอกว้างพอ
    // ขยายเป็น 360px เฉพาะ 2xl (1536px+) ซึ่งกว้างพอให้ 3 คอลัมน์อยู่ครบโดยไม่ต้องเลื่อน
    colEl.className = 'board-col col-surface w-[86vw] max-w-[340px] md:max-w-none md:w-[320px] 2xl:w-[360px] shrink-0 flex flex-col rounded-2xl' +
      (col.status === mobileCol ? ' is-mobile-active' : '');
    colEl.dataset.status = col.status;
    colEl.id = 'boardCol' + col.status;
    colEl.setAttribute('role', 'tabpanel');

    // ยอดเป็นป้ายกลม — กรองอยู่ ("5/23") ป้ายเป็นสีแบรนด์ให้รู้ว่าไม่ใช่ทั้งหมด
    colEl.innerHTML = `
      <div class="flex items-center justify-between gap-2 px-4 pt-3.5 pb-3 shrink-0">
        <div class="flex items-center gap-2 font-semibold text-[15px] min-w-0" style="color:var(--ink)">
          <span class="w-2 h-2 rounded-full shrink-0 ${col.dot}"></span><span class="truncate">${col.title}</span>
          <span class="font-normal text-[13px] hidden sm:inline" style="color:var(--ink-faint)">${col.en}</span>
        </div>
        <span class="col-count shrink-0 tabular-nums ${c.total !== c.all ? 'is-filtered' : ''}">${c.total !== c.all ? c.total + '/' + c.all : c.all}</span>
      </div>
      <div class="col-scroll flex-1 overflow-y-auto px-3 pb-3 flex flex-col gap-3" data-drop="${col.status}"></div>
      <div class="col-pager shrink-0 flex items-center justify-between gap-2 px-3 pb-3"></div>
    `;
    const list = colEl.querySelector('[data-drop]');
    if (!c.tickets.length) {
      // แยกสองกรณีให้ชัด ไม่งั้นผู้ใช้จะนึกว่าระบบพังทั้งที่แค่กรองจนไม่เหลือ
      list.innerHTML = `<div class="text-center text-xs text-slate-400 py-6">${
        c.all ? 'ไม่มีงานที่ตรงกับตัวกรอง' : 'ยังไม่มีงานในคอลัมน์นี้'}</div>`;
    } else {
      c.tickets.forEach(t => list.appendChild(cardEl(t)));
    }
    renderPager(colEl.querySelector('.col-pager'), {
      page: c.page, total: c.total, size: BOARD_PAGE, compact: true,
      onGo: (p) => goColPage(col.status, p),
    });

    // drag targets
    list.addEventListener('dragover', (e) => { e.preventDefault(); colEl.classList.add('col-over'); });
    list.addEventListener('dragleave', () => colEl.classList.remove('col-over'));
    list.addEventListener('drop', (e) => {
      e.preventDefault(); colEl.classList.remove('col-over');
      const id = Number(e.dataTransfer.getData('text/plain'));
      // ปิดงานต้องผ่าน modal เสมอ (ทั้งลากและกดปุ่ม) เพื่อชวนบันทึกวิธีแก้ไขเข้า Knowledge Base
      if (col.status === STATUS.CLOSED) requestClose(id); else moveTicket(id, col.status);
    });
    board.appendChild(colEl);
  }
  renderBoardTabs();
  syncBoardTools();
  syncTicketDrawer();
}

// แท็บสถานะบนมือถือ — แสดงทีละคอลัมน์ (CSS ใน admin.html ซ่อนคอลัมน์ที่ไม่มี .is-mobile-active)
function renderBoardTabs() {
  const box = $('boardTabs');
  if (!box || !boardCols) return;
  box.innerHTML = COLUMNS.map(col => {
    const c = boardCols[col.status] || { total: 0 };
    return `<button type="button" role="tab" data-col="${col.status}" aria-controls="boardCol${col.status}"
      aria-selected="${col.status === mobileCol}" class="board-tab rounded-lg px-1 py-1.5 min-h-[40px] text-[13px] font-medium text-slate-500 inline-flex items-center justify-center gap-1.5 min-w-0">
      <span class="w-1.5 h-1.5 rounded-full shrink-0 ${col.dot}"></span><span class="truncate">${col.tab}</span><span class="tabular-nums shrink-0">${c.total}</span></button>`;
  }).join('');
  box.querySelectorAll('.board-tab').forEach(b => b.addEventListener('click', () => {
    mobileCol = +b.dataset.col;
    localStorage.setItem('ft_mobile_col', String(mobileCol));
    box.querySelectorAll('.board-tab').forEach(x => x.setAttribute('aria-selected', String(+x.dataset.col === mobileCol)));
    document.querySelectorAll('#board .board-col').forEach(c => c.classList.toggle('is-mobile-active', +c.dataset.status === mobileCol));
  }));
}

// options = [[value, label], ...] — หมวดหมู่มาจาก DB (เพิ่มได้) ไม่ hardcode
// เขียนทับเฉพาะตอนรายการเปลี่ยนจริง ไม่งั้น dropdown จะปิดตัวเองระหว่างผู้ใช้กำลังเลือก
function fillSelect(el, options, cur, allLabel) {
  if (!el) return;
  const opts = [['all', allLabel], ...options];
  const sig = opts.map(o => o.join('=')).join('|');
  if (el.dataset.sig !== sig) {
    el.dataset.sig = sig;
    el.innerHTML = opts.map(([v, label]) => `<option value="${escapeHtml(v)}">${escapeHtml(label)}</option>`).join('');
  }
  el.value = cur;
}

const toggleBtn = (el, on) => {
  if (!el) return;
  el.classList.toggle('bg-brand-600', on);
  el.classList.toggle('text-white', on);
  el.classList.toggle('bg-slate-100', !on);
  el.classList.toggle('text-slate-600', !on);
};

// ยอดรวมมุมขวาของแถบเครื่องมือ — ตอนกรองอยู่บอกว่าเจอเท่าไรจากทั้งหมด
function syncBoardCount() {
  const cnt = $('boardCount');
  if (!cnt) return;
  if (viewErr.board) { cnt.textContent = ''; return; }   // หน้าสถานะแสดงอยู่ — ยอดของข้อมูลเก่าไม่มีความหมาย
  if (boardBusy || !boardCols) {
    cnt.innerHTML = `<span class="inline-flex items-center gap-1.5">${icon('loader-circle', 'w-3.5 h-3.5 animate-spin')}กำลังโหลด…</span>`;
    return;
  }
  const cols = Object.values(boardCols);
  const shown = cols.reduce((s, c) => s + c.total, 0);
  const grand = cols.reduce((s, c) => s + c.all, 0);
  cnt.textContent = shown === grand ? `${grand} งาน` : `พบ ${shown} จาก ${grand} งาน`;
}

function syncBoardTools() {
  fillSelect($('boardCat'), boardCats.map(c => [String(c.id), c.name]), boardCat, 'ทุกหมวดหมู่');
  fillSelect($('boardProv'), PROVINCES.map(p => [p.key, p.key]), boardProv, 'ทุกพื้นที่');
  syncBoardCount();
  toggleBtn($('boardMine'), boardMine);
  toggleBtn($('boardCompact'), boardCompact);
  const mine = $('boardMine');
  if (mine) {                       // ยังไม่ login ก็ไม่รู้ว่า "ของฉัน" หมายถึงใคร
    mine.disabled = !currentStaff;
    mine.classList.toggle('opacity-40', !currentStaff);
    mine.title = currentStaff ? '' : 'ต้องเข้าสู่ระบบ LINE ก่อน';
  }
  const cd = $('boardClosedDays');
  if (cd) cd.value = String(closedDays);
  const sc = $('boardSort');
  if (sc) sc.value = boardSort;
  // มือถือ: ตัวกรองพับอยู่ในปุ่ม -> บอกจำนวนที่ใช้อยู่ ไม่งั้นลืมว่ากรองไว้แล้วนึกว่างานหาย
  const n = [boardCat !== 'all', boardProv !== 'all', boardMine, boardSort !== 'new', closedDays !== 7].filter(Boolean).length;
  const badge = $('boardFilterBadge');
  if (badge) { badge.textContent = n; badge.classList.toggle('hidden', !n); }
}

function initBoardTools() {
  const s = $('boardSearch');
  if (s) {
    let timer = null;
    s.addEventListener('input', () => {            // debounce: ค้นที่ DB — รอพิมพ์จบก่อนค่อยยิง ไม่ยิงทุกตัวอักษร
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (s.value.trim() === boardSearch.trim()) return;   // เติม/ลบแค่ช่องว่าง ผลเหมือนเดิม
        boardSearch = s.value;
        applyBoardFilter();
      }, 400);
    });
  }
  $('boardCat')?.addEventListener('change', (e) => { boardCat = e.target.value; applyBoardFilter(); });
  $('boardProv')?.addEventListener('change', (e) => { boardProv = e.target.value; applyBoardFilter(); });
  $('boardSort')?.addEventListener('change', (e) => { boardSort = e.target.value; applyBoardFilter(); });
  $('boardClosedDays')?.addEventListener('change', (e) => {
    closedDays = parseInt(e.target.value, 10) || 0;
    localStorage.setItem('ft_closed_days', String(closedDays));
    applyBoardFilter();
  });
  $('boardMine')?.addEventListener('click', () => { boardMine = !boardMine; applyBoardFilter(); });
  $('boardCompact')?.addEventListener('click', () => {
    boardCompact = !boardCompact;
    localStorage.setItem('ft_board_compact', boardCompact ? '1' : '0');
    render();   // แค่หน้าตาการ์ด ไม่ต้องโหลดข้อมูลใหม่
  });
  $('boardReset')?.addEventListener('click', () => {
    boardSearch = ''; boardCat = 'all'; boardProv = 'all'; boardMine = false; boardSort = 'new';
    closedDays = 7;
    localStorage.setItem('ft_closed_days', '7');
    if (s) s.value = '';
    applyBoardFilter();
  });
  $('boardFilterToggle')?.addEventListener('click', (e) => {
    const open = $('boardFilters').classList.toggle('hidden') === false;
    e.currentTarget.setAttribute('aria-expanded', String(open));
  });
}

function cardEl(t) {
  const el = document.createElement('div');
  // งานที่ยังไม่ปิดและค้างเกินเกณฑ์ (agingDays จากหน้าตั้งค่า) ต้องสะดุดตาบนบอร์ด
  // ไม่งั้นพอคิวยาว งานเก่าจะจมอยู่ล่างสุดโดยไม่มีใครสังเกต
  const ageDays = t.status === STATUS.CLOSED ? 0
    : (Date.now() - (parseT(t.createdAt) || Date.now())) / DAY_MS;
  const isOld = ageDays >= agingDays;

  el.className = (IS_TOUCH ? '' : 'card-drag ') + 'tk-card bg-white rounded-xl border p-3.5'   /* เส้นขอบ/เงา/hover อยู่ที่ .board-col .tk-card ใน admin.html */
    + (isOld ? ' tk-old' : '');
  el.draggable = !IS_TOUCH;   // ดูเหตุผลที่ IS_TOUCH
  el.dataset.id = t.id;

  // ผู้รับงานอยู่ในบรรทัดเวลา ส่วนแถวล่างเป็นผู้แจ้งเสมอ (เดิมรับงานแล้วชื่อผู้แจ้งหายจากการ์ด)
  const by = t.assignee ? ' · ' + t.assignee : '';
  const timeLine = t.status === STATUS.CLOSED
    ? (t.closedAt ? `ปิดงาน ${ftWhen(t.closedAt)}${by}` : '')
    : (t.status === STATUS.IN_PROGRESS && t.acceptedAt ? `รับงาน ${ftWhen(t.acceptedAt)}${by}` : `แจ้ง ${ftWhen(t.createdAt)}`);

  // ปุ่มตามคอลัมน์ — บนมือถือปุ่มพวกนี้คือ "ทางเดียว" ที่เปลี่ยนสถานะได้ (ลากไม่ได้)
  // จึงทำเป็นปุ่มมีพื้นหลัง + เป้ากดใหญ่ (.card-act) ไม่ใช่ตัวหนังสือเปล่าๆ
  let action = '';
  if (t.status === STATUS.OPEN) {
    action = `<button data-act="accept" class="card-act bg-brand-50 text-brand-700 hover:bg-brand-100 font-semibold inline-flex items-center gap-1">รับงาน${icon('arrow-right', 'w-3.5 h-3.5')}</button>`;
  } else if (t.status === STATUS.IN_PROGRESS) {
    action = `<button data-act="close" class="card-act bg-emerald-50 text-emerald-700 hover:bg-emerald-100 font-semibold inline-flex items-center gap-1">${icon('check', 'w-3.5 h-3.5')}ปิดงาน</button>`;
  } else {
    action = t.pdfUrl
      ? `<button data-act="pdf" class="card-act bg-slate-100 text-slate-600 hover:text-brand-700 font-medium inline-flex items-center gap-1">${icon('file-text', 'w-3.5 h-3.5')}ดูเอกสาร</button>`
      : `<button data-act="reopen" class="card-act bg-slate-100 text-slate-500 hover:text-slate-700 font-medium inline-flex items-center gap-1">${icon('rotate-ccw', 'w-3.5 h-3.5')}เปิดใหม่</button>`;
  }

  // "สาขาหาดใหญ่ · ส่วนอำนวยการ" — ตั๋วเก่าที่ไม่รู้สาขาใช้ชื่อพื้นที่แทน
  // ชื่อสาขาเก็บเต็ม (มีชื่อพื้นที่อยู่แล้ว) — ตัดคำนำหน้าที่ซ้ำทุกการ์ดให้สั้นลง: "พื้นที่สงขลา สาขาหาดใหญ่ · ส่วน..."
  const place = [ftShortOrg(t.branch || t.office), t.department].filter(Boolean).join(' · ');

  el.innerHTML = `
    <div class="flex items-start justify-between gap-2 mb-1.5">
      <span class="font-bold text-slate-700 inline-flex items-center gap-1.5 min-w-0">
        <span class="truncate">${escapeHtml(t.code)}</span>
        ${isOld ? `<span class="tk-age shrink-0 text-[11px] font-semibold px-1.5 py-0.5 rounded bg-red-100 text-red-700">ค้าง ${Math.floor(ageDays)} วัน</span>` : ''}
      </span>
      <span class="inline-flex items-center gap-1 shrink-0">
        ${t.imageUrl ? `<span class="text-slate-400" title="มีรูปแนบ">${icon('camera', 'w-3.5 h-3.5')}</span>` : ''}
        ${t.category ? `<span class="tk-cat text-xs px-2 py-0.5 rounded-full ${catColor(t.category)}">${escapeHtml(t.category)}</span>` : ''}
        ${isAdminUser() ? `<button data-act="cancel" class="tk-del text-slate-400 hover:text-red-600 p-1 -m-1 rounded" title="ยกเลิกงาน" aria-label="ยกเลิกงาน ${escapeHtml(t.code)}">${icon('trash-2', 'w-3.5 h-3.5')}</button>` : ''}
      </span>
    </div>
    <p class="tk-detail text-sm text-slate-700 leading-snug mb-2">${escapeHtml(t.detail)}</p>
    ${place ? `<div class="tk-place text-xs text-slate-500 mb-2.5 flex items-center gap-1 min-w-0">${icon('map-pin', 'w-3.5 h-3.5')}<span class="truncate">${escapeHtml(place)}</span></div>` : ''}
    <div class="tk-meta flex items-center justify-between gap-2 text-xs text-slate-500 border-t border-slate-100 pt-2.5">
      <span class="inline-flex items-center gap-1 min-w-0">
        ${icon('user', 'w-3.5 h-3.5')}<span class="truncate">${escapeHtml(t.reporter)}</span>
      </span>
      ${action}
    </div>
    ${timeLine ? `<div class="tk-time text-xs text-slate-400 mt-1.5 inline-flex items-center gap-1">${icon('clock', 'w-3.5 h-3.5')}${timeLine}</div>` : ''}
  `;

  el.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', String(t.id));
    el.classList.add('drag-ghost');
  });
  el.addEventListener('dragend', () => el.classList.remove('drag-ghost'));

  // กดที่การ์ด (นอกปุ่ม) = เปิดรายละเอียด · คีย์บอร์ด: Tab มาที่การ์ดแล้ว Enter
  el.tabIndex = 0;
  el.setAttribute('role', 'button');
  el.setAttribute('aria-haspopup', 'dialog');
  el.addEventListener('click', () => openTicket(t.id));
  el.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target === el) { e.preventDefault(); openTicket(t.id); }
  });

  el.querySelectorAll('[data-act]').forEach(btn => btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const act = btn.dataset.act;
    if (act === 'accept')  moveTicket(t.id, STATUS.IN_PROGRESS);
    if (act === 'close')   requestClose(t.id);
    if (act === 'reopen')  moveTicket(t.id, STATUS.OPEN);
    if (act === 'pdf')     openPdf(t);
    if (act === 'cancel')  cancelTicket(t);
  }));

  return el;
}

/* ---------- รายละเอียดตั๋ว (กดที่การ์ด) ----------
   ทุกอย่างที่ต้องใช้ตอนลงมือ: อาการเต็ม, รูป, ผู้แจ้ง + เบอร์โทรกลับ, สังกัด, ลำดับเวลา, เอกสาร, ปุ่มเปลี่ยนสถานะ
   (เดิมเอกสารที่มีเบอร์โทรเปิดได้เฉพาะคอลัมน์เสร็จสิ้น — ระหว่างทำงานจึงหาเบอร์ผู้แจ้งไม่เจอ) */
let drawerId = null;
let drawerReturnFocus = null;
const STATUS_PILL = {
  1: ['รอรับเรื่อง', 'bg-amber-100 text-amber-800'],
  2: ['กำลังดำเนินการ', 'bg-blue-100 text-blue-800'],
  3: ['เสร็จสิ้น', 'bg-emerald-100 text-emerald-800'],
};

function openTicket(id) {
  const t = tickets.find(x => x.id === id);
  if (!t) return;
  if (drawerId == null) drawerReturnFocus = document.activeElement;
  drawerId = id;
  renderTicketDrawer(t);
  $('ticketDrawer').classList.remove('hidden');
  $('tdClose').focus();
}

function closeTicket() {
  if (drawerId == null) return;
  drawerId = null;
  $('ticketDrawer').classList.add('hidden');
  if (drawerReturnFocus && document.contains(drawerReturnFocus)) drawerReturnFocus.focus();
}

// บอร์ดวาดใหม่ (เปลี่ยนสถานะ / โหลดเบื้องหลัง) -> แผงที่เปิดอยู่ตามข้อมูลล่าสุด · ตั๋วไม่อยู่ในหน้านี้แล้ว = ปิด
function syncTicketDrawer() {
  if (drawerId == null) return;
  const t = tickets.find(x => x.id === drawerId);
  if (t) renderTicketDrawer(t); else closeTicket();
}

function renderTicketDrawer(t) {
  const [stText, stCls] = STATUS_PILL[t.status] || STATUS_PILL[1];
  $('tdTitle').innerText = t.code;
  $('tdStatus').className = 'text-xs font-medium px-2 py-0.5 rounded-full ' + stCls;
  $('tdStatus').innerText = stText;
  $('tdCat').className = t.category ? 'text-xs px-2 py-0.5 rounded-full ' + catColor(t.category) : 'hidden';
  $('tdCat').innerText = t.category || '';
  $('tdSub').innerText = 'แจ้งเมื่อ ' + ftDate(t.createdAt);

  const row = (ic, label, html) => `
    <div class="flex gap-3 py-2.5">
      <span class="w-5 shrink-0 mt-0.5 text-slate-400">${icon(ic, 'w-4 h-4')}</span>
      <div class="min-w-0"><div class="text-xs" style="color:var(--ink-muted)">${label}</div>
        <div class="text-sm break-words" style="color:var(--ink)">${html}</div></div>
    </div>`;
  // เบอร์เก็บตั้งแต่ 2026-11-02 — ตั๋วก่อนหน้านั้นมีแค่ในเอกสาร
  const phone = t.phone
    ? `<a href="tel:${escapeHtml(t.phone.replace(/[^0-9+]/g, ''))}" class="font-medium text-brand-700 hover:underline">${escapeHtml(t.phone)}</a>`
    : `<span style="color:var(--ink-muted)">${t.pdfUrl ? 'ไม่ได้บันทึกไว้ — ดูในเอกสาร' : 'ไม่ได้ระบุ'}</span>`;
  const place = [t.branch || t.office, t.department].filter(Boolean).map(escapeHtml).join('<br>') || '<span style="color:var(--ink-muted)">ไม่ระบุ</span>';
  const thumb = ftDriveThumb(t.imageUrl, 900);
  const ageDays = Math.floor((Date.now() - (parseT(t.createdAt) || Date.now())) / DAY_MS);
  const step = (done, label, when) => `
    <li class="flex gap-3">
      <span class="mt-1 w-2.5 h-2.5 rounded-full shrink-0 ${done ? 'bg-brand-600' : 'bg-slate-200'}"></span>
      <div class="min-w-0 pb-3"><div class="text-sm font-medium" style="color:${done ? 'var(--ink)' : 'var(--ink-muted)'}">${label}</div>
        ${when ? `<div class="text-xs" style="color:var(--ink-muted)">${when}</div>` : ''}</div>
    </li>`;

  $('tdBody').innerHTML = `
    <p class="text-[15px] leading-relaxed whitespace-pre-wrap" style="color:var(--ink)">${escapeHtml(t.detail)}</p>
    ${thumb ? `
      <a href="${escapeHtml(t.imageUrl)}" target="_blank" rel="noopener" class="block space-y-1.5">
        <img src="${escapeHtml(thumb)}" alt="รูปที่ผู้แจ้งแนบมา" loading="lazy" onerror="this.remove()" class="w-full max-h-64 object-cover rounded-xl border bg-slate-100" style="border-color:var(--line)">
        <span class="inline-flex items-center gap-1.5 text-sm text-brand-700">${icon('camera', 'w-4 h-4')}รูปที่ผู้แจ้งแนบมา · เปิดขนาดเต็ม${icon('external-link', 'w-3.5 h-3.5')}</span>
      </a>` : ''}
    <div class="rounded-xl border px-3 divide-y" style="border-color:var(--line)">
      ${row('user', 'ผู้แจ้ง', escapeHtml(t.reporter || '-'))}
      ${row('phone', 'เบอร์โทรภายใน', phone)}
      ${row('map-pin', 'สังกัด', place)}
      ${row('wrench', 'ผู้รับผิดชอบ', t.assignee ? escapeHtml(t.assignee) : '<span style="color:var(--ink-muted)">ยังไม่มีผู้รับงาน</span>')}
    </div>
    <div>
      <div class="text-xs font-medium mb-2" style="color:var(--ink-muted)">ลำดับเวลา</div>
      <ol>
        ${step(true, 'แจ้งเรื่อง', escapeHtml(ftDate(t.createdAt)))}
        ${step(!!t.acceptedAt || t.status !== STATUS.OPEN, 'รับเรื่อง', t.acceptedAt
            ? escapeHtml(ftDate(t.acceptedAt) + (t.assignee ? ' · ' + t.assignee : ''))
            : (t.status === STATUS.OPEN ? 'รอมา ' + (ageDays ? ageDays + ' วัน' : 'ไม่ถึงวัน') : ''))}
        ${step(t.status === STATUS.CLOSED, 'เสร็จสิ้น', t.closedAt ? escapeHtml(ftDate(t.closedAt)) : '')}
      </ol>
    </div>`;

  // ปุ่ม: ยกเลิกงาน (แอดมิน) ชิดซ้าย · เอกสาร + การกระทำหลักชิดขวา
  const btn = 'inline-flex items-center justify-center gap-1.5 px-4 min-h-[44px] rounded-xl text-sm font-semibold transition-colors';
  const main = t.status === STATUS.OPEN
    ? `<button type="button" data-td="accept" class="${btn} bg-brand-600 text-white hover:bg-brand-700">รับงาน${icon('arrow-right', 'w-4 h-4')}</button>`
    : t.status === STATUS.IN_PROGRESS
      ? `<button type="button" data-td="close" class="${btn} bg-emerald-600 text-white hover:bg-emerald-700">${icon('check', 'w-4 h-4')}ปิดงาน</button>`
      : `<button type="button" data-td="reopen" class="${btn} border bg-white text-slate-600 hover:bg-slate-50" style="border-color:var(--line-strong)">${icon('rotate-ccw', 'w-4 h-4')}เปิดใหม่</button>`;
  $('tdActions').innerHTML = `
    ${isAdminUser() ? `<button type="button" data-td="cancel" class="${btn} text-red-600 hover:bg-red-50 px-3">${icon('trash-2', 'w-4 h-4')}ยกเลิกงาน</button>` : ''}
    <span class="flex-1"></span>
    ${t.pdfUrl ? `<button type="button" data-td="pdf" class="${btn} border bg-white text-slate-700 hover:bg-slate-50" style="border-color:var(--line-strong)">${icon('file-text', 'w-4 h-4')}เอกสาร</button>` : ''}
    ${main}`;
  $('tdActions').querySelectorAll('[data-td]').forEach(b => b.addEventListener('click', () => {
    const act = b.dataset.td;
    if (act === 'accept') moveTicket(t.id, STATUS.IN_PROGRESS);
    if (act === 'close')  requestClose(t.id);
    if (act === 'reopen') moveTicket(t.id, STATUS.OPEN);
    if (act === 'pdf')    openPdf(t);
    if (act === 'cancel') cancelTicket(t);
  }));
}

// ---------- ยกเลิกงาน (Admin) — soft delete: หายจากบอร์ด/แดชบอร์ด แต่แถวและ PDF ยังอยู่ ----------
// ไม่ทำ optimistic update: ยกเลิกแล้วย้อนเองไม่ได้จากหน้าเว็บ ต้องรอ backend ยืนยันก่อนเอาออก
async function cancelTicket(t) {
  const ok = await ftConfirm(
    'งานจะหายจากตารางงานและแดชบอร์ด ผู้แจ้งจะเห็นสถานะ "ยกเลิกแล้ว" ในหน้าประวัติ\nข้อมูลและเอกสาร PDF ยังเก็บไว้ (ผู้ดูแลฐานข้อมูลกู้คืนได้)',
    { title: `ยกเลิกงาน ${t.code}?`, confirmText: 'ยกเลิกงาน', danger: true, icon: 'trash-2' });
  if (!ok) return;
  boardWrites++;
  try {
    const res = await callBackend('deleteTicket', { ticketId: t.id });
    if (!res || res.status !== 'success') throw new Error((res && res.message) || 'ยกเลิกงานไม่สำเร็จ');
    const c = boardCols && boardCols[t.status];
    if (c) { c.tickets = c.tickets.filter(x => x.id !== t.id); c.total--; c.all--; }
    tickets = tickets.filter(x => x.id !== t.id);
    render();
    ftToast(`ยกเลิกงาน ${t.code} แล้ว`, 'success');
    afterTicketWrite();
  } catch (e) {
    ftToast(e.message, 'error');
    if (isAuthError(e)) setAuthExpired(true);
  } finally {
    boardWrites--;
  }
}

// แก้ตั๋วสำเร็จ: หน้าที่จำไว้ทุกหน้าเก่าหมดแล้ว · แดชบอร์ดต้องคำนวณใหม่ · โหลดบอร์ดใหม่เบื้องหลัง
function afterTicketWrite() {
  clearPageCache();
  dashLoaded = false;
  refreshBoardSoon();
}

// ย้ายการ์ดข้ามคอลัมน์ในหน้าที่แสดงอยู่ทันที (optimistic) พร้อมยอดหัวคอลัมน์
// ตำแหน่งจริงตามการเรียง/การแบ่งหน้าจะตามมาตอนโหลดบอร์ดใหม่เบื้องหลัง (refreshBoardSoon)
function relocate(t, from, to) {
  const a = boardCols && boardCols[from], b = boardCols && boardCols[to];
  if (!a || !b) return;
  const i = a.tickets.indexOf(t);
  if (i < 0) return;   // บอร์ดถูกโหลดหน้าใหม่ไปแล้ว ไม่มีการ์ดใบนี้ให้ย้าย
  a.tickets.splice(i, 1);
  a.total--;
  a.all--;
  // ใหม่สุดก่อน: งานที่เพิ่งเปลี่ยนสถานะคือใหม่สุด -> บนสุด · เก่าสุดก่อน -> ท้ายสุด
  if (boardSort === 'old') b.tickets.push(t); else b.tickets.unshift(t);
  b.total++;
  b.all++;
}

// ---------- ย้ายสถานะตั๋ว (optimistic update + revert เมื่อ backend ปฏิเสธ) ----------
// resolutionText: ใช้เฉพาะตอนปิดงาน (toStatus===CLOSED) — มาจาก closeModal ผ่าน requestClose/finishClose
async function moveTicket(id, toStatus, resolutionText) {
  const t = tickets.find(x => x.id === id);
  if (!t) {   // บอร์ดเพิ่งโหลดใหม่เบื้องหลัง แล้วการ์ดใบนี้ย้ายไปอยู่หน้าอื่น
    ftToast('ไม่พบงานนี้ในหน้าที่แสดงอยู่ — ลองค้นหาด้วยรหัสงานอีกครั้ง', 'info');
    return;
  }
  if (t.status === toStatus) return;

  const isAccept = (t.status === STATUS.OPEN && toStatus === STATUS.IN_PROGRESS);
  if (isAccept && !currentStaffId) {
    ftToast('ต้องเข้าสู่ระบบ LINE ก่อนจึงจะรับงานได้', 'info');
    ensureLogin();
    return;
  }

  const from = t.status;
  const prev = { status:t.status, assignee:t.assignee, acceptedAt:t.acceptedAt, closedAt:t.closedAt };
  t.status = toStatus;
  if (isAccept) { t.assignee = currentStaff; t.acceptedAt = new Date().toISOString(); }
  if (toStatus === STATUS.CLOSED) t.closedAt = new Date().toISOString();
  if (toStatus === STATUS.OPEN)   { t.assignee = null; t.acceptedAt = null; t.closedAt = null; }
  relocate(t, from, toStatus);
  render();

  boardWrites++;
  try {
    const res = isAccept
      ? await callBackend('acceptTicket', { ticketId:id })   // backend รู้ผู้รับจาก idToken เอง
      : await callBackend('updateTicketStatus', { ticketId:id, status:toStatus });
    if (!res || res.status !== 'success') throw new Error(res && res.message || 'อัปเดตไม่สำเร็จ');
    // ชื่อบนการ์ดใช้ USER.Full_Name จาก DB (backend ส่งกลับมา) ไม่ใช่ชื่อ LINE
    // ไม่งั้นชื่อจะ "เปลี่ยนเอง" ตอนโหลดใหม่ เพราะ getBoard ก็ JOIN เอา Full_Name
    if (isAccept && res.assignee && res.assignee !== t.assignee) {
      t.assignee = res.assignee;
      render();
    }
    afterTicketWrite();
    // บันทึกวิธีแก้ไขเข้า Knowledge Base — เกิดขึ้นหลังปิดงานสำเร็จเท่านั้น และไม่ทำให้
    // การปิดงาน "ล้มเหลว" ถ้าขั้นนี้พังต่อ (คนละ resource กัน แค่แจ้งเตือนเบาๆ พอ)
    if (toStatus === STATUS.CLOSED && resolutionText) {
      try {
        const kbRes = await callBackend('addKnowledgeArticle', { ticketId:id, resolutionText });   // ผู้บันทึกมาจาก idToken
        if (!kbRes || kbRes.status !== 'success') throw new Error((kbRes && kbRes.message) || 'ไม่ทราบสาเหตุ');
        kbLoaded = false;   // บังคับให้โหลดใหม่ครั้งถัดไปที่เข้าหน้าประวัติ (พร้อมยอดชิพหมวดหมู่)
        kbCats = null;
        clearPageCache();
      } catch (kbErr) {
        ftToast('ปิดงานสำเร็จ แต่บันทึกประวัติวิธีแก้ไขไม่สำเร็จ: ' + kbErr.message, 'error');
      }
    }
  } catch (e) {
    Object.assign(t, prev); // revert
    relocate(t, toStatus, from);
    render();
    if (isAuthError(e)) setAuthExpired(true);
    ftToast('บันทึกไม่สำเร็จ: ' + e.message, 'error');
  } finally {
    boardWrites--;
  }
}

// ---------- เจ้าหน้าที่ปัจจุบัน (ตัวตนมาจาก LINE เท่านั้น) ----------
function setStaffUI() {
  const avatar = $('staffAvatar');
  const nameEl = $('staffName');
  const infoEl = $('staffInfo');
  if (currentStaff) {
    // ชื่อที่แสดง: ใช้ชื่อจริงจาก DB ถ้ามี ไม่งั้น fallback เป็น LINE displayName
    const displayName = (staffProfile && staffProfile.name) || currentStaff;
    nameEl.innerText = displayName;
    nameEl.classList.replace('text-slate-600','text-slate-800');
    // ข้อมูลเพิ่มเติมใต้ชื่อ (ตำแหน่ง · สังกัด)
    if (infoEl) {
      const parts = [];
      if (staffProfile && staffProfile.position) parts.push(staffProfile.position);
      if (staffProfile && staffProfile.office) parts.push(staffProfile.office);
      if (parts.length) { infoEl.innerText = parts.join(' · '); infoEl.classList.remove('hidden'); }
      else infoEl.classList.add('hidden');
    }
    // รูปโปรไฟล์จาก LINE
    if (staffPicUrl) {
      avatar.innerHTML = `<img src="${escapeHtml(staffPicUrl)}" alt="" class="w-full h-full rounded-full object-cover">`;
    } else {
      avatar.innerHTML = '';
      avatar.innerText = displayName.trim().charAt(0) || '?';
    }
  } else {
    nameEl.innerText = 'เข้าสู่ระบบ LINE';
    if (infoEl) infoEl.classList.add('hidden');
    avatar.innerHTML = '';
    avatar.innerText = '?';
  }
}

// ---------- ดึงข้อมูลบัญชีจาก DB (ชื่อจริง, ตำแหน่ง, สังกัด) ----------
// เรียกหลัง LIFF login สำเร็จ — ข้อมูลนี้แทบไม่เปลี่ยน จึงแคชไว้ใน localStorage
// ถ้าดึงไม่ได้ก็ไม่เป็นไร แค่แสดง LINE displayName แทน
async function loadMyProfile() {
  try {
    const res = await callBackend('getMyProfile', {});
    if (res && res.status === 'success' && res.profile) {
      staffProfile = res.profile;
      localStorage.setItem(PROFILE_KEY, JSON.stringify(staffProfile));
      // อัปเดตชื่อที่ใช้จับคู่ "งานของฉัน" บนบอร์ดด้วย (ถ้า DB มีชื่อจริง)
      if (staffProfile.name) {
        currentStaff = staffProfile.name;
        localStorage.setItem('ft_staff', currentStaff);
      }
      setStaffUI();
      refreshIdentityDependentViews();
    }
  } catch (e) {
    // ไม่ fatal — แค่ topbar จะโชว์ LINE displayName แทนชื่อจริง
    console.warn('loadMyProfile:', e.message);
  }
}

// พาไปหน้าเข้าสู่ระบบ LINE — ftRelogin (common.js) logout ก่อนเสมอ เพราะถ้ายัง login ค้าง
// ด้วย token หมดอายุ liff.login() เฉยๆ จะคืนใบเดิมกลับมา · redirectUri = หน้าปัจจุบัน
// ไม่งั้นตอน fallback เป็น MY_LIFF_ID จะเด้งกลับไป index.html
function ensureLogin() {
  if (typeof liff === 'undefined' || !liff.login) return ftToast('โหลด LINE SDK ไม่สำเร็จ', 'error');
  if (!ftRelogin(true)) ftToast('เรียกหน้าเข้าสู่ระบบ LINE ไม่สำเร็จ', 'error');
}

// ---------- PDF ----------
function openPdf(t) {
  if (!t.pdfUrl) { ftToast('ตั๋วนี้ยังไม่มีไฟล์เอกสาร', 'info'); return; }
  const preview = t.pdfUrl.replace('/view?usp=drivesdk','/preview').replace('/view','/preview');
  $('pdfTitle').innerText = 'บันทึกข้อความ · ' + t.code;
  $('pdfFrame').src = preview;
  $('pdfOpen').href = t.pdfUrl;
  $('pdfModal').classList.remove('hidden');
}
function closePdf(){ $('pdfModal').classList.add('hidden'); $('pdfFrame').src=''; }

// ---------- ปิดงาน + บันทึกวิธีแก้ไข (ผูกกับ Knowledge Base) ----------
function requestClose(id) {
  const t = tickets.find(x => x.id === id);
  if (!t || t.status === STATUS.CLOSED) return;   // ปิดไปแล้ว ไม่ต้องถามซ้ำ
  pendingCloseId = id;
  $('closeResolution').value = '';
  $('closeModal').classList.remove('hidden');
  $('closeResolution').focus();
}
function cancelClose() {
  $('closeModal').classList.add('hidden');
  pendingCloseId = null;
}
function finishClose(resolutionText) {
  const id = pendingCloseId;
  $('closeModal').classList.add('hidden');
  pendingCloseId = null;
  if (id == null) return;
  moveTicket(id, STATUS.CLOSED, resolutionText);
}

/* =============================================================================
   Dashboard — ยอดสรุปคำนวณใน SQL (getDashboard) ไม่โหลดตั๋วทุกใบมาไว้ในเครื่อง
   หน้าเว็บแค่รวมยอดที่ชื่อซ้ำกันหลังทำความสะอาด (cleanCategory / normProv) แล้ววาด
   ============================================================================= */

let dashData = null;       // คำตอบล่าสุดของ getDashboard
let dashLoaded = false;    // false = เข้าหน้าครั้งหน้าต้องโหลดใหม่ (ยังไม่สำเร็จ / มีการแก้ตั๋ว / เปลี่ยนเกณฑ์ค้าง)
let dashSeq = 0;

async function loadDashboard() {
  const seq = ++dashSeq;
  if (!dashData) {
    const cached = readViewCache(DASH_CACHE_KEY, agingDays);
    if (cached) { dashData = cached.res; setStale('dashboard', cached.savedAt); }
    else setStale('dashboard', true);
    renderDashboard();
  }
  if ((await liffReady) === false) return;
  try {
    const res = await fetchPage('getDashboard', { agingDays });
    if (seq !== dashSeq) return;
    dashData = res;
    dashLoaded = true;
    clearViewError('dashboard');
    writeViewCache(DASH_CACHE_KEY, agingDays, res);
    setStale('dashboard', false);
    if (currentView === 'dashboard') renderDashboard();
  } catch (e) {
    if (seq !== dashSeq) return;
    // หน้าสถานะแทนเสมอ แม้มีตัวเลขจากแคช (ตัวเลขเก่าบนแดชบอร์ดอ่านแล้วเข้าใจผิดง่ายที่สุด)
    setStale('dashboard', false);
    showViewError('dashboard', e, loadDashboard);
  }
}

// "YYYY-MM-DD" ตามเวลาเครื่อง — ใช้จับคู่กับยอดรายวันจาก server (จัดกลุ่มตามเวลาไทย)
// ผู้ใช้ทั้งหมดอยู่ในไทย เวลาเครื่องจึงตรงกัน
const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// รวมยอดของแถวที่ได้ key เดียวกัน -> [[key, n], ...] เรียงมากไปน้อย (key ว่าง = ทิ้ง)
function mergeCounts(rows, keyFn) {
  const m = new Map();
  (rows || []).forEach(r => { const k = keyFn(r); if (!k) return; m.set(k, (m.get(k) || 0) + (Number(r.n) || 0)); });
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

// คืนชื่อจังหวัดที่รู้จักเท่านั้น ไม่งั้นคืน '' (= ไม่ระบุ)
// ปกติใช้ EXCISE_OFFICE.Province จาก backend ถ้าไม่มีจะเดาจากชื่อพื้นที่
// ห้ามคืนสตริงดิบ: "สำนักงานสรรพสามิตภาคที่ 9" ไม่ใช่จังหวัด
// ถ้าปล่อยผ่านจะโผล่เป็นจังหวัดปลอมในอันดับพื้นที่
function normProv(s) {
  const raw = String(s || '');
  const hit = PROVINCES.find(p => raw.indexOf(p.key) !== -1);
  return hit ? hit.key : '';
}

// แถบแนวนอน: ความยาว = ขนาด · ตัวเลขกำกับทุกแถบ (direct label ตามกติกา relief)
function barRow(label, value, max, color) {
  const pct = max > 0 ? Math.max(2, Math.round(value / max * 100)) : 0;
  const el = document.createElement('div');
  el.innerHTML = `
    <div class="flex items-center justify-between gap-2 mb-1.5">
      <span class="text-[13px] truncate" style="color:var(--ink-2)">${escapeHtml(label)}</span>
      <span class="text-[13px] font-semibold tabular-nums" style="color:var(--ink)">${value}</span>
    </div>
    <div class="viz-bar-track"><div class="viz-bar-fill" style="width:${pct}%;background:${color}"></div></div>`;
  return el;
}

function renderDashboard() {
  const d = dashData;
  if (!d) return;   // ยังไม่มีข้อมูล — การ์ดแสดง "—" ไว้
  const k = d.kpi || {};
  const n = Number(k.total) || 0;
  const num = (v) => Number(v) || 0;
  const pct = (v) => n ? Math.round(v / n * 100) : 0;

  $('kpiTotal').innerText = n;
  $('kpiOpen').innerText = num(k.open);
  $('kpiProg').innerText = num(k.prog);
  $('kpiDone').innerText = num(k.done);
  $('kpiOpenPct').innerText = `Open · ${pct(num(k.open))}%`;
  $('kpiProgPct').innerText = `In Progress · ${pct(num(k.prog))}%`;
  $('kpiDonePct').innerText = `Closed · ${pct(num(k.done))}%`;
  // แถบสัดส่วนเทียบตั๋วทั้งหมด (ตัวเลข % อยู่ใต้แถบแล้ว แถบจึงเป็นภาพประกอบ ไม่ใช่ข้อมูลเพียงทางเดียว)
  $('kpiOpenBar').style.width = pct(num(k.open)) + '%';
  $('kpiProgBar').style.width = pct(num(k.prog)) + '%';
  $('kpiDoneBar').style.width = pct(num(k.done)) + '%';

  // ---- SLA ---- (เวลาเฉลี่ยเป็น ms · null = ยังไม่มีตั๋วให้เฉลี่ย)
  const ms = (v) => (v == null ? null : Number(v));
  $('slaAccept').innerText = fmtDur(ms(k.acceptAvgMs));
  $('slaClose').innerText  = fmtDur(ms(k.closeAvgMs));
  $('slaAcceptNote').innerText = num(k.acceptN) ? `จาก ${num(k.acceptN)} ตั๋ว` : 'ยังไม่มีตั๋วที่ถูกรับเรื่อง';
  $('slaCloseNote').innerText  = num(k.closeN)  ? `จาก ${num(k.closeN)} ตั๋ว`  : 'ยังไม่มีตั๋วที่ปิดงาน';

  const now = Date.now();
  // agingDays ตั้งค่าได้ที่หน้า Settings (ค่าเริ่มต้น 3 วัน) — server นับตามค่าที่ส่งไป
  $('slaAging').innerText = num(k.aging);
  $('slaAgingLabel').innerText = `ค้างเกิน ${agingDays} วัน (ยังไม่รับ)`;
  // มีงานค้างจริง = สถานะเตือน (ไอคอนส้ม + ข้อความ) · ไม่มี = เทากลางๆ ไม่ต้องดึงสายตา
  $('slaAgingIcon').classList.toggle('is-warn', num(k.aging) > 0);
  $('slaAgingNote').innerText = num(k.aging) > 0 ? 'ต้องเร่งจัดการ' : 'ไม่มีงานค้าง';

  // ---- หมวดหมู่ / พื้นที่ / เจ้าหน้าที่ ----
  // ชื่อใน DB อาจมี emoji/วงเล็บอังกฤษ -> ทำความสะอาดแล้วรวมยอดที่ซ้ำกัน
  const cats = mergeCounts(d.categories, r => cleanCategory(r.name || '') || 'ไม่ระบุ');
  const catMax = cats.length ? cats[0][1] : 0;
  const catBox = $('catBars'); catBox.innerHTML = '';
  if (!cats.length) catBox.innerHTML = `<div class="text-xs" style="color:var(--ink-muted)">ยังไม่มีข้อมูล</div>`;
  cats.forEach(([k, v]) => catBox.appendChild(barRow(k, v, catMax, cssVar('--st-prog'))));

  const provs = mergeCounts(d.provinces, r => normProv(r.province || r.office) || NO_PROV);
  const provMax = provs.length ? provs[0][1] : 0;
  const provBox = $('provBars'); provBox.innerHTML = '';
  if (!provs.length) provBox.innerHTML = `<div class="text-xs" style="color:var(--ink-muted)">ยังไม่มีข้อมูล</div>`;
  provs.forEach(([k, v]) => provBox.appendChild(barRow(k, v, provMax, cssVar('--st-prog'))));

  const staff = mergeCounts(d.staff, r => r.name);
  const staffMax = staff.length ? staff[0][1] : 0;
  const staffBox = $('staffBars'); staffBox.innerHTML = '';
  if (!staff.length) {
    staffBox.innerHTML = `<div class="text-xs" style="color:var(--ink-muted)">ยังไม่มีตั๋วที่ถูกรับเรื่อง<br>กดปุ่ม “รับงาน” บนบอร์ดเพื่อเริ่ม</div>`;
  }
  staff.forEach(([k, v]) => staffBox.appendChild(barRow(k, v, staffMax, cssVar('--st-prog'))));

  // ---- ตั๋วค้างนาน ---- (server เรียงจากแจ้งนานสุดและตัดเหลือ 6 ใบมาให้แล้ว)
  const agingBody = $('agingBody');
  const oldest = (d.oldest || []).filter(t => parseT(t.createdAt));
  agingBody.innerHTML = oldest.length ? '' : `<tr><td colspan="4" class="py-3 text-xs" style="color:var(--ink-muted)"><span class="inline-flex items-center gap-1">${icon('circle-check', 'w-3.5 h-3.5')}ไม่มีตั๋วค้าง</span></td></tr>`;
  oldest.forEach(t => {
    const days = (now - parseT(t.createdAt)) / DAY_MS;
    const hot = days > agingDays;
    const tr = document.createElement('tr');
    tr.className = 'border-t';
    tr.style.borderColor = 'var(--grid)';
    tr.innerHTML = `
      <td class="py-2 pr-3 font-bold whitespace-nowrap" style="color:var(--ink)">${escapeHtml(t.code || ('TK-' + t.id))}</td>
      <td class="py-2 pr-3 sm:max-w-[22rem] truncate" style="color:var(--ink-2)">${escapeHtml(t.detail || '(ไม่มีรายละเอียด)')}</td>
      <td class="py-2 pr-3 text-xs whitespace-nowrap hidden sm:table-cell" style="color:var(--ink-muted)">${escapeHtml(normProv(t.province || t.office) || '-')}</td>
      <td class="py-2 pr-3 text-right whitespace-nowrap tabular-nums text-xs font-semibold"
          style="color:${hot ? 'var(--st-open)' : 'var(--ink-2)'}">${hot ? icon('flame', 'w-3.5 h-3.5 inline -mt-0.5 mr-0.5') : ''}${timeAgo(t.createdAt).replace('ที่แล้ว','').trim()}</td>`;
    agingBody.appendChild(tr);
  });

  renderTrend(d.trend);
  renderMap(new Map(provs), n);
}

// ---------- กราฟเส้น: ตั๋วเข้าใหม่ 30 วัน (ซีรีส์เดียว -> ไม่ต้องมี legend) ----------
// rows = ยอดแจ้งรายวันจาก server [{ d: 'YYYY-MM-DD', n }] (วันที่ไม่มีตั๋วไม่มีแถว = 0)
function renderTrend(rows) {
  const svg = $('trendChart');
  const days = 30;
  const perDay = new Map(mergeCounts(rows, r => r.d));
  const today = new Date(); today.setHours(23, 59, 59, 999);
  const buckets = [];
  for (let i = days - 1; i >= 0; i--) {
    const end = today.getTime() - i * DAY_MS;
    buckets.push({ end, n: perDay.get(dayKey(new Date(end))) || 0 });
  }
  // ขนาด viewBox ต้องใกล้เคียงความกว้างจริงของ SVG (อัตราส่วน ~1:1)
  // ไม่งั้น preserveAspectRatio จะย่อทั้งภาพ -> font-size 10 หน่วยเหลือ ~5px บนมือถือ
  const cw = Math.round(svg.getBoundingClientRect().width) || 640;
  const W = Math.max(320, Math.min(720, cw));
  const H = cw < 480 ? 190 : 170;                 // จอแคบเพิ่มความสูงชดเชยพื้นที่กราฟที่หายไป
  const L = cw < 480 ? 26 : 34, R = 8, T = 12, B = 26;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.style.height = H + 'px';
  const maxY = Math.max(1, ...buckets.map(b => b.n));
  const niceY = maxY <= 4 ? maxY : Math.ceil(maxY / 4) * 4;
  const px = (i) => L + i * (W - L - R) / (buckets.length - 1);
  const py = (v) => T + (1 - v / niceY) * (H - T - B);

  const grid = cssVar('--grid'), muted = cssVar('--ink-muted'), blue = cssVar('--st-prog');
  let g = '';
  // เส้นกริดแนวนอน + แกน Y (recessive)
  const steps = Math.min(4, niceY);
  for (let s = 0; s <= steps; s++) {
    const v = Math.round(niceY * s / steps), y = py(v);
    g += `<line x1="${L}" y1="${y}" x2="${W - R}" y2="${y}" stroke="${grid}" stroke-width="1"/>`;
    g += `<text x="${L - 6}" y="${y + 3.5}" text-anchor="end" font-size="10" fill="${muted}">${v}</text>`;
  }
  // แกน X: ป้ายทุก 7 วัน + วันสุดท้ายเฉพาะเมื่อห่างจาก tick ก่อนหน้าพอ (กันป้ายทับกัน)
  const ticks = [];
  for (let i = 0; i < buckets.length; i += 7) ticks.push(i);
  const lastI = buckets.length - 1;
  if (lastI - ticks[ticks.length - 1] >= 4) ticks.push(lastI);
  ticks.forEach(i => {
    const d = new Date(buckets[i].end);
    g += `<text x="${px(i)}" y="${H - 8}" text-anchor="middle" font-size="10" fill="${muted}">${d.getDate()}/${d.getMonth() + 1}</text>`;
  });
  // พื้นที่ใต้เส้น + เส้น 2px
  const line = buckets.map((b, i) => `${i ? 'L' : 'M'}${px(i).toFixed(1)},${py(b.n).toFixed(1)}`).join(' ');
  const area = `${line} L${px(buckets.length - 1).toFixed(1)},${py(0)} L${px(0).toFixed(1)},${py(0)} Z`;
  g += `<path d="${area}" fill="${blue}" opacity="0.10"/>`;
  g += `<path d="${line}" fill="none" stroke="${blue}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  // จุดเฉพาะวันที่มีตั๋ว (ไม่ยัดตัวเลขทุกจุด)
  buckets.forEach((b, i) => { if (b.n > 0) g += `<circle cx="${px(i).toFixed(1)}" cy="${py(b.n).toFixed(1)}" r="3" fill="${blue}" stroke="#fff" stroke-width="1.5"/>`; });
  // แถบรับเมาส์ (hit target กว้างกว่าจุด)
  buckets.forEach((b, i) => {
    const w = (W - L - R) / buckets.length;
    g += `<rect x="${(px(i) - w / 2).toFixed(1)}" y="${T}" width="${w.toFixed(1)}" height="${H - T - B}" fill="transparent" data-i="${i}" class="trend-hit"/>`;
  });
  svg.innerHTML = g;

  const tip = $('trendTip');
  svg.querySelectorAll('.trend-hit').forEach(r => {
    const show = () => {
      const i = +r.dataset.i, b = buckets[i], d = new Date(b.end);
      tip.innerHTML = `${d.getDate()}/${d.getMonth() + 1} · <b>${b.n}</b> ตั๋ว`;
      tip.classList.remove('hidden');
      const box = svg.getBoundingClientRect();
      // clamp: tip ใช้ translate(-50%) ถ้าจุดอยู่ริมสุดป้ายจะล้นออกนอกการ์ด
      const x = box.width * (px(i) / W);
      tip.style.left = Math.max(46, Math.min(box.width - 46, x)) + 'px';
      tip.style.top  = (box.height * (py(b.n) / H)) + 'px';
    };
    r.addEventListener('mouseenter', show);
    r.addEventListener('mouseleave', () => tip.classList.add('hidden'));
    // จอสัมผัสไม่มี hover — ต้องแตะแล้วโชว์ แล้วซ่อนเองใน 2.5 วิ
    r.addEventListener('click', () => { show(); scheduleTipHide(tip); });
  });
}

// ซ่อน tooltip อัตโนมัติหลังแตะบนจอสัมผัส (ไม่มี mouseleave ให้พึ่ง)
let tipHideTimer = null;
function scheduleTipHide(tip) {
  clearTimeout(tipHideTimer);
  tipHideTimer = setTimeout(() => tip.classList.add('hidden'), 2500);
}

// ---------- แผนที่: choropleth ขอบเขตจังหวัดจริง (ข้อมูลใน map-data.js) ----------
// provCounts = Map(จังหวัด -> ยอด) ชุดเดียวกับอันดับพื้นที่ · total = ตั๋วทั้งหมด (ใช้คิด %)
function renderMap(provCounts, total) {
  const svg = $('provMap');
  const counts = new Map(PROVINCES.map(p => [p.key, provCounts.get(p.key) || 0]));
  const max = Math.max(0, ...counts.values());

  // bucket -> ramp เฉดเดียว (เข้ม = เยอะ) · 0 ตั๋ว = สีพื้น ไม่ใช่เฉดอ่อนสุด
  // จะได้แยกออกว่า "ไม่มีตั๋ว" ต่างจาก "มีน้อย"
  const bucketOf = (v) => {
    if (v <= 0) return -1;
    if (max <= 1) return SEQ.length - 1;
    return Math.min(SEQ.length - 1, Math.floor((v - 1) / max * SEQ.length));
  };
  const fillOf = (v) => { const b = bucketOf(v); return b < 0 ? cssVar('--seq-0') : cssVar(SEQ[b]); };
  // สีตัวอักษรเลือกจาก contrast ที่คำนวณจริง: bucket 0-1 (#86b6ef/#5598e7) ใช้ ink เข้ม
  // (8.46:1 / 5.98:1) · bucket 2-3 (#2a78d6/#184f95) ใช้ขาว (4.42:1 / 8.10:1)
  const inkOf = (v) => (bucketOf(v) >= 2 ? '#ffffff' : cssVar('--ink'));

  svg.setAttribute('viewBox', MAP_VIEWBOX);
  let g = '';
  PROVINCES.forEach(p => {
    const v = counts.get(p.key);
    g += `<path class="map-region" d="${p.d}" fill="${fillOf(v)}" data-prov="${p.key}" data-n="${v}"/>`;
  });
  // ป้ายวาดทีหลังทั้งหมด เพื่อไม่ให้จังหวัดข้างๆ ทับตัวหนังสือ
  PROVINCES.forEach(p => {
    const v = counts.get(p.key), ink = inkOf(v);
    g += `<g pointer-events="none">
      <text x="${p.cx}" y="${p.cy - 1}" text-anchor="middle" font-size="5.2" font-weight="600" fill="${ink}">${p.key}</text>
      <text x="${p.cx}" y="${p.cy + 6}" text-anchor="middle" font-size="7" font-weight="700" fill="${ink}">${v}</text>
    </g>`;
  });
  svg.innerHTML = g;

  // legend: 0 -> น้อย -> มาก
  $('mapLegend').innerHTML = `<span>0</span>` +
    `<span style="width:16px;height:10px;border-radius:2px;background:${cssVar('--seq-0')};display:inline-block;border:1px solid var(--grid)"></span>` +
    SEQ.map(s => `<span style="width:16px;height:10px;border-radius:2px;background:${cssVar(s)};display:inline-block"></span>`).join('') +
    `<span>มาก (สูงสุด ${max})</span>`;

  const tip = $('mapTip');
  svg.querySelectorAll('.map-region').forEach(el => {
    const showAt = (clientX, clientY) => {
      const n = +el.dataset.n, pct = total ? Math.round(n / total * 100) : 0;
      tip.innerHTML = `${escapeHtml(el.dataset.prov)} · <b>${n}</b> ตั๋ว (${pct}%)`;
      tip.classList.remove('hidden');
      const box = svg.parentElement.getBoundingClientRect();
      // clamp เหมือนกราฟเส้น — จังหวัดริมซ้าย/ขวาไม่งั้นป้ายล้นการ์ด
      tip.style.left = Math.max(60, Math.min(box.width - 60, clientX - box.left)) + 'px';
      tip.style.top  = (clientY - box.top) + 'px';
    };
    el.addEventListener('mousemove', (e) => showAt(e.clientX, e.clientY));
    el.addEventListener('mouseleave', () => tip.classList.add('hidden'));
    // จอสัมผัส: แตะจังหวัดแล้วโชว์ป้าย (ไม่มี hover ให้ใช้)
    el.addEventListener('click', (e) => { showAt(e.clientX, e.clientY); scheduleTipHide(tip); });
  });
}

/* =============================================================================
   Users — จัดการบัญชีผู้ใช้และบทบาท (แอดมิน / เจ้าหน้าที่ IT / ผู้ใช้งานทั่วไป)
   ============================================================================= */

function normalizeUser(u) {
  return {
    userId: u.userId || '',
    name: u.name || '(ไม่มีชื่อ)',
    position: u.position || '-',
    role: roleOf(u.role),
    office: u.office || '',
    branch: u.branch || '',
    department: u.department || '',
    province: u.province || '',
    reported: Number(u.reported) || 0,
    assigned: Number(u.assigned) || 0,
  };
}

const usersParams = (page) => ({
  q: userSearch.trim(), role: userRoleFilter === 'all' ? '' : userRoleFilter, page, pageSize: USERS_PAGE,
});

let usersSeq = 0;

// page ไม่ระบุ = หน้าปัจจุบัน (โหลดใหม่)
async function loadUsers(page) {
  const seq = ++usersSeq;
  const params = usersParams(page || usersPage);
  const table = $('usersBody').closest('table');
  if (!usersLoaded) $('usersBody').innerHTML = `<tr><td colspan="9" class="px-2">${ftSkeleton('row', 5)}</td></tr>`;
  else setBusy(table, true);
  if ((await liffReady) === false) return;   // ดูคอมเมนต์ที่ liffReady
  let res;
  try {
    res = await fetchPage('getUsers', params);
    if (seq !== usersSeq) return;
    usersViewerIsAdmin = true;   // getUsers เปิดเฉพาะแอดมิน (ACL ฝั่ง server) — ตอบสำเร็จ = คนดูเป็นแอดมิน
  } catch (e) {
    if (seq !== usersSeq) return;
    setBusy(table, false);
    // IT เปิดเมนูนี้ = ไม่มีสิทธิ์ (getUsers เฉพาะแอดมิน) — บอกตรงๆ ว่าหน้านี้ของแอดมิน
    showViewError('users', e, () => loadUsers(), { title: { forbidden: 'หน้านี้สำหรับแอดมินเท่านั้น' } });
    return;
  }
  clearViewError('users');
  users = (res.users || []).map(normalizeUser);
  usersTotal = Number(res.total) || 0;
  usersPage = Number(res.page) || 1;
  usersCounts = res.counts || usersCounts;
  usersLoaded = true;
  setBusy(table, false);
  renderUsers();
  // หน้าถัดไปรอไว้ — กด "ถัดไป" แล้วขึ้นทันที
  if (usersPage * USERS_PAGE < usersTotal) prefetchPage('getUsers', usersParams(usersPage + 1));
}

// สิทธิ์แก้บทบาท: แค่ซ่อน/แสดงปุ่ม — ด่านจริงคือ ACL ของ updateUserRole ฝั่ง backend (Admin เท่านั้น)
let usersViewerIsAdmin = false;
function canEditRoles() {
  return usersViewerIsAdmin;
}

function roleBadge(role) {
  const r = ROLES[role] || ROLES.staff;
  return `<span class="text-xs px-2 py-0.5 rounded-full whitespace-nowrap ${r.badge}">${r.label}</span>`;
}

function renderUsers() {
  // KPI = ยอดทั้งระบบจาก server (ไม่ใช่แค่หน้านี้)
  $('usrTotal').innerText = usersCounts.all;
  $('usrAdmin').innerText = usersCounts.admin;
  $('usrIt').innerText = usersCounts.it;
  $('usrStaff').innerText = usersCounts.staff;

  // role filter chips — กรองที่ DB แล้วกลับไปหน้า 1
  const chips = [['all','ทั้งหมด'], ['admin',ROLES.admin.label], ['it',ROLES.it.label], ['staff',ROLES.staff.label]];
  $('roleChips').innerHTML = chips.map(([k, label]) =>
    `<button data-role="${k}" class="px-2.5 py-1 rounded-full border transition-colors ${
      userRoleFilter === k ? 'bg-brand-600 text-white border-brand-600' : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
    }">${label}</button>`).join('');
  $('roleChips').querySelectorAll('button').forEach(b =>
    b.addEventListener('click', () => {
      if (userRoleFilter === b.dataset.role) return;
      userRoleFilter = b.dataset.role;
      renderUsers();   // ชิพที่เลือกเปลี่ยนสีทันที ไม่ต้องรอข้อมูล
      loadUsers(1);
    }));

  // server กรอง/เรียงมาให้แล้ว (แอดมิน -> IT -> ทั่วไป แล้วตามชื่อ)
  const list = users;

  const editable = canEditRoles();
  $('usersEditNote').classList.toggle('hidden', editable || !currentStaffId);

  const body = $('usersBody');
  body.innerHTML = '';
  $('usersEmpty').classList.toggle('hidden', list.length > 0);
  renderPager($('usersPager'), { page: usersPage, total: usersTotal, size: USERS_PAGE, onGo: (p) => loadUsers(p) });

  list.forEach(u => {
    const isMe = !!currentStaffId && u.userId === currentStaffId;
    const tr = document.createElement('tr');
    tr.className = 'border-t';
    tr.style.borderColor = 'var(--grid)';
    // จอเล็กซ่อนคอลัมน์ ตำแหน่ง/สังกัด/สถิติ (ดู admin.html) — ข้อมูลไม่หายไปไหน
    // แต่ย้ายมาต่อท้ายชื่อเป็นบรรทัดเล็กแทน จะได้ไม่ต้องเลื่อนตารางแนวนอนบนมือถือ
    tr.innerHTML = `
      <td class="py-2.5 pr-3">
        <div class="flex items-center gap-2.5">
          <span class="w-8 h-8 rounded-full bg-brand-600 text-white text-xs font-bold flex items-center justify-center shrink-0">${escapeHtml(u.name.trim().charAt(0) || '?')}</span>
          <div class="min-w-0">
            <div class="font-semibold truncate" style="color:var(--ink)">${escapeHtml(u.name)}${isMe ? ' <span class="text-[11px] font-normal text-brand-600">(คุณ)</span>' : ''}</div>
            <div class="text-[11px] truncate hidden lg:block" style="color:var(--ink-muted)">${escapeHtml(u.userId)}</div>
            <div class="text-[11px] truncate lg:hidden" style="color:var(--ink-muted)">${escapeHtml(u.position)}${u.office ? ' · ' + escapeHtml(u.office) : ''}</div>
            <div class="text-[11px] truncate sm:hidden" style="color:var(--ink-muted)">แจ้งซ่อม ${u.reported} · รับผิดชอบ ${u.assigned}</div>
            <div class="lg:hidden mt-1">${roleBadge(u.role)}</div>
          </div>
        </div>
      </td>
      <td class="py-2.5 pr-3 text-xs hidden lg:table-cell" style="color:var(--ink-2)">${escapeHtml(u.position)}</td>
      <td class="py-2.5 pr-3 text-xs hidden lg:table-cell" style="color:var(--ink-2)">
        <div class="truncate max-w-[16rem]">${escapeHtml(u.office || '-')}</div>
        <div class="text-[11px] truncate max-w-[16rem]" style="color:var(--ink-muted)">${escapeHtml([ftShortOrg(u.branch), u.department].filter(Boolean).join(' · '))}</div>
      </td>
      <td class="py-2.5 pr-3 hidden lg:table-cell">${roleBadge(u.role)}</td>
      <td class="py-2.5 pr-3 text-right tabular-nums text-xs hidden sm:table-cell" style="color:var(--ink-2)">${u.reported}</td>
      <td class="py-2.5 pr-3 text-right tabular-nums text-xs hidden sm:table-cell" style="color:var(--ink-2)">${u.assigned}</td>
      <td class="py-2.5 pl-3 text-right">${
        editable
          ? `<select data-uid="${escapeHtml(u.userId)}" class="role-select w-full sm:w-auto border border-slate-300 rounded-lg px-2 py-1.5 sm:py-1 text-xs bg-white outline-none focus:ring-2 focus:ring-brand-500">
               ${Object.entries(ROLES).map(([k, r]) => `<option value="${k}" ${k === u.role ? 'selected' : ''}>${r.label}</option>`).join('')}
             </select>`
          : `<span class="text-[11px]" style="color:var(--ink-muted)">—</span>`
      }</td>`;
    body.appendChild(tr);
  });

  body.querySelectorAll('.role-select').forEach(sel =>
    sel.addEventListener('change', () => changeRole(sel.dataset.uid, sel.value)));
}

async function changeRole(userId, newRole) {
  const u = users.find(x => x.userId === userId);
  if (!u || u.role === newRole) return;

  const isSelfDemote = userId === currentStaffId && newRole !== 'admin';
  const msg = isSelfDemote
    ? `กำลังลดสิทธิ์ "บัญชีของคุณเอง" เป็น ${ROLES[newRole].label} — จะแก้บทบาทใครไม่ได้อีกจนกว่าแอดมินคนอื่นจะคืนสิทธิ์ให้\n\nยืนยันหรือไม่?`
    : `เปลี่ยนบทบาทของ "${u.name}" เป็น ${ROLES[newRole].label}?`;
  if (!(await ftConfirm(msg, { title: 'เปลี่ยนบทบาท', confirmText: 'เปลี่ยนบทบาท', danger: isSelfDemote, icon: 'users' }))) { renderUsers(); return; }   // วาดใหม่ให้ select เด้งกลับค่าเดิม

  const prevRole = u.role;
  // optimistic — ยอด KPI ย้ายตามด้วย (แถวยังอยู่ที่เดิมจนกว่าจะโหลดหน้าใหม่ ผู้ใช้จะได้เห็นผลที่เพิ่งกด)
  const setRole = (from, to) => { u.role = to; usersCounts[from]--; usersCounts[to]++; };
  setRole(prevRole, newRole);
  renderUsers();

  try {
    const res = await callBackend('updateUserRole', { userId, role: newRole });
    if (!res || res.status !== 'success') throw new Error((res && res.message) || 'อัปเดตไม่สำเร็จ');
    clearPageCache();   // หน้าที่จำไว้มีบทบาท/ลำดับเก่า
    if (isSelfDemote) { usersViewerIsAdmin = false; renderUsers(); }   // ไม่ใช่แอดมินแล้ว ปิดการแก้ทันที
  } catch (e) {
    setRole(newRole, prevRole);   // revert
    renderUsers();
    ftToast('เปลี่ยนบทบาทไม่สำเร็จ: ' + e.message, 'error');
  }
}

/* =============================================================================
   Knowledge Base — บทความถูกสร้างอัตโนมัติตอนปิดงานพร้อมกรอกวิธีแก้ไข (ดู moveTicket)
   ============================================================================= */

function normalizeKb(a) {
  return {
    id: a.id,
    ticketId: a.ticketId,
    ticketCode: a.ticketCode || ('TK-' + a.ticketId),
    category: cleanCategory(a.category || '') || 'ไม่ระบุ',
    detail: a.detail || '',
    resolution: a.resolution || '',
    pdfUrl: a.pdfUrl || '',
    author: a.author || 'ไม่ทราบผู้บันทึก',
    createdAt: a.createdAt || null,
  };
}

const kbParams = (page) => ({
  q: kbSearch.trim(),
  categoryId: kbCatFilter === 'all' ? 0 : kbCatFilter === 'none' ? 'none' : Number(kbCatFilter),
  page, pageSize: KB_PAGE,
  facets: !kbCats,   // ยอดต่อหมวดของชิพ ขอเฉพาะตอนยังไม่มี/ข้อมูลเปลี่ยน
});

let kbSeq = 0;

// page ไม่ระบุ = หน้าปัจจุบัน (โหลดใหม่)
async function loadKB(page) {
  const seq = ++kbSeq;
  const params = kbParams(page || kbPage);
  if (!kbLoaded) $('kbList').innerHTML = ftSkeleton('card', 3);
  else setBusy($('kbList'), true);
  if ((await liffReady) === false) return;   // ดูคอมเมนต์ที่ liffReady
  let res;
  try {
    res = await fetchPage('getKnowledgeBase', params);
    if (seq !== kbSeq) return;
  } catch (e) {
    if (seq !== kbSeq) return;
    setBusy($('kbList'), false);
    showViewError('kb', e, () => loadKB());
    return;
  }
  clearViewError('kb');
  kbArticles = (res.articles || []).map(normalizeKb);
  kbTotal = Number(res.total) || 0;
  kbPage = Number(res.page) || 1;
  if (res.categories) {
    kbCats = res.categories.map(c => ({ id: c.id, name: cleanCategory(c.name || '') || 'ไม่ระบุ', n: Number(c.n) || 0 }));
  }
  kbLoaded = true;
  setBusy($('kbList'), false);
  renderKB();
  if (kbPage * KB_PAGE < kbTotal) prefetchPage('getKnowledgeBase', kbParams(kbPage + 1));
}

function renderKB() {

  // ชิพหมวดหมู่ + ยอดของประวัติทั้งหมด (จาก server) — หมวดที่ไม่มี id = ไม่มีหมวด ('none')
  const cats = kbCats || [];
  const grand = cats.reduce((s, c) => s + c.n, 0);
  const chips = [['all', 'ทั้งหมด', grand], ...cats.map(c => [c.id == null ? 'none' : String(c.id), c.name, c.n])];
  $('kbCatChips').innerHTML = chips.map(([key, label, n]) => {
    const active = kbCatFilter === key;
    return `<button data-cat="${escapeHtml(key)}" class="px-2.5 py-1 rounded-full border transition-colors ${
      active ? 'bg-brand-600 text-white border-brand-600' : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
    }">${escapeHtml(label)} <span class="tabular-nums ${active ? 'opacity-80' : 'text-slate-400'}">${n}</span></button>`;
  }).join('');
  $('kbCatChips').querySelectorAll('button').forEach(b =>
    b.addEventListener('click', () => {
      if (kbCatFilter === b.dataset.cat) return;
      kbCatFilter = b.dataset.cat;
      renderKB();   // ชิพที่เลือกเปลี่ยนสีทันที ไม่ต้องรอข้อมูล
      loadKB(1);
    }));

  // server กรอง/เรียง (ใหม่สุดก่อน) มาให้แล้ว
  const list = kbArticles;
  const box = $('kbList');
  box.innerHTML = '';
  // แยก "ยังไม่มีประวัติเลย" ออกจาก "กรองแล้วไม่เจอ" — ไม่งั้นผู้ใช้นึกว่าข้อมูลหาย
  $('kbEmpty').classList.toggle('hidden', !(kbCats && grand === 0));
  $('kbNoMatch').classList.toggle('hidden', list.length > 0 || !(grand > 0));
  renderPager($('kbPager'), { page: kbPage, total: kbTotal, size: KB_PAGE, onGo: (p) => loadKB(p) });

  list.forEach(a => {
    const el = document.createElement('div');
    el.className = 'border rounded-xl p-4 transition-colors hover:bg-slate-50/60';
    el.style.borderColor = 'var(--grid)';
    el.innerHTML = `
      <div class="flex items-start justify-between gap-2 mb-1.5">
        <div class="flex items-center gap-2 flex-wrap">
          <span class="font-bold text-sm" style="color:var(--ink)">${escapeHtml(a.ticketCode)}</span>
          <span class="text-xs px-2 py-0.5 rounded-full ${catColor(a.category)}">${escapeHtml(a.category)}</span>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          ${a.pdfUrl ? `<button data-pdf="${a.id}" class="text-xs text-brand-600 hover:underline whitespace-nowrap inline-flex items-center gap-1">${icon('file-text', 'w-3.5 h-3.5')}เอกสารต้นฉบับ</button>` : ''}
          <button data-edit="${a.id}" class="text-xs text-slate-500 hover:text-brand-600 min-h-[32px] px-1.5" title="แก้ไข" aria-label="แก้ไข">${icon('pencil')}</button>
          <button data-del="${a.id}" class="text-xs text-slate-500 hover:text-red-600 min-h-[32px] px-1.5" title="ลบ" aria-label="ลบ">${icon('trash-2')}</button>
        </div>
      </div>
      ${a.detail ? `<div class="text-xs mb-1.5" style="color:var(--ink-muted)">อาการ: ${escapeHtml(a.detail)}</div>` : ''}
      <p class="text-sm leading-relaxed whitespace-pre-wrap" style="color:var(--ink-2)">${escapeHtml(a.resolution)}</p>
      <div class="text-xs mt-2" style="color:var(--ink-muted)">บันทึกโดย ${escapeHtml(a.author)} · ${timeAgo(a.createdAt)}</div>
    `;
    const pdfBtn = el.querySelector('[data-pdf]');
    if (pdfBtn) pdfBtn.addEventListener('click', () => openPdf({ code:a.ticketCode, pdfUrl:a.pdfUrl }));
    const editBtn = el.querySelector('[data-edit]');
    if (editBtn) editBtn.addEventListener('click', () => openKbEdit(a));
    const delBtn = el.querySelector('[data-del]');
    if (delBtn) delBtn.addEventListener('click', () => deleteKbArticle(a));
    box.appendChild(el);
  });
}

// ---------- แก้ไขบทความ KB ----------
function openKbEdit(article) {
  pendingKbEditId = article.id;
  $('kbEditTicketInfo').innerText = article.ticketCode + ' — ' + (article.detail || '(ไม่มีรายละเอียด)');
  $('kbEditResolution').value = article.resolution;
  $('kbEditModal').classList.remove('hidden');
  $('kbEditResolution').focus();
}
function cancelKbEdit() {
  $('kbEditModal').classList.add('hidden');
  pendingKbEditId = null;
}
async function saveKbEdit() {
  const kbId = pendingKbEditId;
  const text = $('kbEditResolution').value.trim();
  if (!kbId) return;
  if (!text) { ftToast('วิธีแก้ไขปัญหาห้ามว่าง', 'error'); return; }

  // optimistic update
  const a = kbArticles.find(x => x.id === kbId);
  const prevText = a ? a.resolution : '';
  if (a) a.resolution = text;
  cancelKbEdit();
  renderKB();

  try {
    const res = await callBackend('updateKnowledgeArticle', { kbId, resolutionText: text });
    if (!res || res.status !== 'success') throw new Error((res && res.message) || 'อัปเดตไม่สำเร็จ');
    clearPageCache();   // หน้าที่จำไว้ (และที่โหลดรอไว้) มีข้อความเก่า
  } catch (e) {
    if (a) a.resolution = prevText;  // revert
    renderKB();
    ftToast('แก้ไขไม่สำเร็จ: ' + e.message, 'error');
  }
}

// ---------- ลบบทความ KB ----------
async function deleteKbArticle(article) {
  if (!(await ftConfirm('ตั๋วต้นฉบับจะไม่ถูกกระทบ แต่วิธีแก้ไขปัญหานี้จะหายไปถาวร', { title: `ลบประวัติ ${article.ticketCode}?`, confirmText: 'ลบ', danger: true, icon: 'trash-2' }))) return;

  // optimistic remove
  const idx = kbArticles.findIndex(x => x.id === article.id);
  const removed = idx >= 0 ? kbArticles.splice(idx, 1)[0] : null;
  renderKB();

  try {
    const res = await callBackend('deleteKnowledgeArticle', { kbId: article.id });
    if (!res || res.status !== 'success') throw new Error((res && res.message) || 'ลบไม่สำเร็จ');
    clearPageCache();
    // โหลดหน้านี้ใหม่: เติมช่องที่ว่างด้วยรายการจากหน้าถัดไป + ยอดชิพ/จำนวนหน้าใหม่
    // (ลบใบสุดท้ายของหน้าสุดท้าย server จะส่งหน้าก่อนหน้ามาแทนเอง)
    kbCats = null;
    loadKB();
  } catch (e) {
    if (removed && idx >= 0) kbArticles.splice(idx, 0, removed);  // revert
    renderKB();
    ftToast('ลบไม่สำเร็จ: ' + e.message, 'error');
  }
}

/* =============================================================================
   ข้อมูลหลัก (Master Data) — พื้นที่ (EXCISE_OFFICE) · สาขา (BRANCH) · ส่วน (DEPARTMENT) · หมวดหมู่ (ISSUE_CATEGORY)
   โหลดไม่ได้ = หน้าสถานะ (showViewError) — ไม่มีรายการให้แก้จนกว่าจะโหลดสำเร็จ
   ไม่ทำ optimistic update — แก้นานๆ ครั้ง และ backend อาจปฏิเสธ (ชื่อซ้ำ/ยังถูกใช้อยู่)
   คำสั่งเขียนต้องแนบ apiVersion — backend ปฏิเสธหน้าเว็บรุ่นเก่าที่ใช้ "branch" ในความหมายพื้นที่
   ============================================================================= */
const MASTER_TYPES = {
  office:     { label: 'พื้นที่',       key: 'offices' },
  branch:   { label: 'สาขา',         key: 'branches' },
  department:  { label: 'ส่วน',         key: 'departments' },
  category: { label: 'หมวดหมู่ปัญหา', key: 'categories' },
};
const emptyMaster = () => ({ offices: [], branches: [], departments: [], categories: [] });
let masterData = emptyMaster();
let masterLoaded = false;
let masterTab = 'office';
let masterEditing = null;   // { type, id } — id = null คือเพิ่มใหม่

async function loadMaster() {
  if ((await liffReady) === false) return;
  if (!masterLoaded) $('masterList').innerHTML = ftSkeleton('row', 5);
  try {
    const res = await callBackend('getMasterData', { withUsage: true });
    if (!res || res.status !== 'success') throw new Error((res && res.message) || 'ไม่มีข้อมูลจาก backend');
    masterData = { offices: res.offices || [], branches: res.branches || [], departments: res.departments || [], categories: res.categories || [] };
    masterLoaded = true;
    clearViewError('master');
    renderMaster();
  } catch (e) {
    showViewError('master', e, loadMaster);
  }
}

// "ตั๋วแจ้งซ่อม 1 · สาขา 3" — ยอดรวมเดียวอ่านแล้วนึกว่าเป็นจำนวนตั๋ว
const usageText = (r) => (r.usedBy && r.usedBy.length)
  ? r.usedBy.map(u => u.label + ' ' + u.n).join(' · ')
  : (r.used ? 'ใช้อยู่ ' + r.used : 'ยังไม่ถูกใช้');

const officeName = (id) => (masterData.offices.find(a => a.id === id) || {}).name || '(ไม่พบพื้นที่ #' + id + ')';

function renderMaster() {
  document.querySelectorAll('.master-tab').forEach(b => {
    const on = b.dataset.tab === masterTab;
    b.className = 'master-tab px-3 py-1.5 rounded-full border transition-colors ' +
      (on ? 'bg-brand-600 text-white border-brand-600' : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50');
    b.innerText = MASTER_TYPES[b.dataset.tab].label + ' (' + masterData[MASTER_TYPES[b.dataset.tab].key].length + ')';
  });
  $('masterAddLabel').innerText = MASTER_TYPES[masterTab].label;
  // ไม่ใช่แอดมิน: ซ่อนปุ่มเพิ่ม/แก้/ลบ (เดิมกรอกฟอร์มจนเสร็จ กดบันทึกแล้วค่อยรู้ว่าไม่มีสิทธิ์)
  const canEdit = isAdminUser();
  $('masterAddBtn').classList.toggle('hidden', !canEdit);
  $('masterSub').innerText = canEdit
    ? 'ตัวเลือกในฟอร์มแจ้งซ่อม · ลบได้เฉพาะรายการที่ยังไม่มีตั๋วหรือผู้ใช้อ้างถึง'
    : 'ตัวเลือกในฟอร์มแจ้งซ่อม · ดูได้อย่างเดียว — เพิ่ม/แก้ไข/ลบ ได้เฉพาะแอดมิน';

  let rows = masterData[MASTER_TYPES[masterTab].key];
  // เรียงตามผังหน่วยงานเหมือน dropdown ในฟอร์มแจ้งซ่อม (ftSortOffices / ftSortBranches ใน common.js)
  // สาขา: จัดตามลำดับพื้นที่ก่อน แล้วชื่อในพื้นที่
  if (masterTab === 'office') rows = ftSortOffices(rows);
  if (masterTab === 'branch') {
    const order = new Map(ftSortOffices(masterData.offices).map((o, i) => [o.id, i]));
    rows = ftSortBranches(rows).sort((a, b) => (order.get(a.officeId) ?? 999) - (order.get(b.officeId) ?? 999));
  }

  $('masterEmpty').classList.toggle('hidden', rows.length > 0);
  const box = $('masterList');
  box.innerHTML = '';
  rows.forEach(r => {
    const sub = masterTab === 'office'
      ? [r.parentId ? 'สังกัด ' + officeName(r.parentId) : 'ระดับบนสุด', r.province ? 'จังหวัด' + r.province : ''].filter(Boolean).join(' · ')
      : masterTab === 'branch' ? (r.name === officeName(r.officeId) ? 'ตัวสำนักงาน (ไม่ใช่สาขา)' : '') : '';
    const el = document.createElement('div');
    el.className = 'flex items-center gap-3 py-2.5';
    el.innerHTML = `
      <span class="text-xs w-8 shrink-0 text-right tabular-nums" style="color:var(--ink-muted)">#${r.id}</span>
      <div class="min-w-0 flex-1">
        <div class="text-sm truncate" style="color:var(--ink)">${escapeHtml(r.name || '(ไม่มีชื่อ)')}</div>
        ${sub ? `<div class="text-xs truncate" style="color:var(--ink-muted)">${escapeHtml(sub)}</div>` : ''}
      </div>
      <span class="text-xs shrink-0 text-right max-w-[40%]" style="color:var(--ink-muted)">${escapeHtml(usageText(r))}</span>
      ${canEdit ? `
      <button data-act="edit" class="text-xs text-slate-500 hover:text-brand-600 min-h-[36px] px-1.5 shrink-0" title="แก้ไข" aria-label="แก้ไข ${escapeHtml(r.name || '')}">${icon('pencil')}</button>
      <button data-act="del" class="text-xs min-h-[36px] px-1.5 shrink-0 ${r.used ? 'opacity-30 cursor-not-allowed' : 'text-slate-500 hover:text-red-600'}"
              title="${r.used ? 'ลบไม่ได้ — ยังถูกใช้อยู่' : 'ลบ'}" aria-label="ลบ ${escapeHtml(r.name || '')}">${icon('trash-2')}</button>` : ''}`;
    if (canEdit) {
      el.querySelector('[data-act="edit"]').addEventListener('click', () => openMasterModal(masterTab, r));
      el.querySelector('[data-act="del"]').addEventListener('click', () => deleteMaster(masterTab, r));
    }
    box.appendChild(el);
  });
}

function openMasterModal(type, row) {
  masterEditing = { type, id: row ? row.id : null };
  const label = MASTER_TYPES[type].label;
  $('masterModalTitle').innerHTML = icon(row ? 'pencil' : 'plus', 'w-5 h-5 text-brand-600') + escapeHtml((row ? 'แก้ไข' : 'เพิ่ม') + label);
  $('masterModalSub').innerText = row && row.used
    ? `ถูกใช้อยู่ใน ${usageText(row)} — ชื่อที่แก้จะมีผลกับข้อมูลเดิมทั้งหมดด้วย`
    : 'จะแสดงเป็นตัวเลือกในฟอร์มแจ้งซ่อม';
  $('masterName').value = row ? row.name : '';
  $('masterProvinceRow').classList.toggle('hidden', type !== 'office');
  $('masterProvince').value = row && type === 'office' ? row.province : '';
  $('masterOfficeRow').classList.toggle('hidden', type !== 'branch');
  $('masterParentRow').classList.toggle('hidden', type !== 'office');
  masterNamePrefix = '';
  if (type === 'branch') {
    $('masterOffice').innerHTML = '<option value="">-- เลือกพื้นที่ --</option>' +
      ftSortOffices(masterData.offices).map(a => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('');
    $('masterOffice').value = row ? String(row.officeId) : '';
  }
  if (type === 'office') {
    // รองรับ 2 ชั้น (ภาค -> พื้นที่): เลือกได้เฉพาะหน่วยงานระดับบนสุดที่ไม่ใช่ตัวเอง
    const roots = ftSortOffices(masterData.offices).filter(o => !o.parentId && (!row || o.id !== row.id));
    $('masterParent').innerHTML = '<option value="">— ไม่มี (ระดับบนสุด) —</option>' +
      roots.map(o => `<option value="${o.id}">${escapeHtml(o.name)}</option>`).join('');
    // พื้นที่ใหม่สังกัดภาค 9 เป็นค่าเริ่มต้น (มีระดับบนสุดตัวเดียว)
    $('masterParent').value = row ? (row.parentId ? String(row.parentId) : '') : (roots.length === 1 ? String(roots[0].id) : '');
  }
  updateMasterNameHint();
  $('masterFormError').classList.add('hidden');
  $('masterModal').classList.remove('hidden');
  (type === 'branch' && !row ? $('masterOffice') : $('masterName')).focus();
}

// สาขาเก็บชื่อเต็ม — เลือกพื้นที่แล้วเติม "ชื่อพื้นที่ " ให้ (เฉพาะตอนช่องชื่อว่าง หรือยังเป็นคำนำหน้าที่เราเติมไว้)
let masterNamePrefix = '';
function updateMasterNameHint() {
  const hint = $('masterNameHint');
  const type = masterEditing && masterEditing.type;
  if (type === 'branch') {
    const office = masterData.offices.find(o => String(o.id) === $('masterOffice').value);
    hint.innerText = office
      ? `ต้องขึ้นต้นด้วย "${office.name}" — ใช้ชื่อนี้เฉยๆ = ตัวสำนักงานพื้นที่ · เติม " สาขา..." = สาขา`
      : 'เลือกพื้นที่ก่อน ระบบจะเติมคำนำหน้าชื่อให้';
    hint.classList.remove('hidden');
  } else if (type === 'office') {
    hint.innerText = 'เปลี่ยนชื่อพื้นที่ — ชื่อสาขาในพื้นที่นี้จะเปลี่ยนคำนำหน้าตามให้อัตโนมัติ';
    hint.classList.toggle('hidden', !masterEditing.id);
  } else {
    hint.classList.add('hidden');
  }
}
$('masterOffice').addEventListener('change', () => {
  const office = masterData.offices.find(o => String(o.id) === $('masterOffice').value);
  const cur = $('masterName').value.trim();
  if (office && (!cur || cur === masterNamePrefix.trim())) {
    masterNamePrefix = office.name + ' ';
    $('masterName').value = masterNamePrefix;
    $('masterName').focus();
  }
  updateMasterNameHint();
});

function closeMasterModal() {
  $('masterModal').classList.add('hidden');
  masterEditing = null;
}

async function saveMaster() {
  if (!masterEditing || $('masterSaveBtn').disabled) return;   // กด Enter ซ้ำระหว่างรอ = เพิ่มซ้ำ
  const { type, id } = masterEditing;
  const item = { name: $('masterName').value.trim() };
  if (type === 'office') {
    item.province = $('masterProvince').value.trim();
    item.parentId = parseInt($('masterParent').value, 10) || null;
  }
  if (type === 'branch') item.officeId = parseInt($('masterOffice').value, 10) || null;

  const showErr = (msg) => { $('masterFormError').innerText = msg; $('masterFormError').classList.remove('hidden'); };
  if (!item.name) return showErr('กรุณากรอกชื่อ');
  if (type === 'branch' && !item.officeId) return showErr('กรุณาเลือกพื้นที่');
  if (type === 'branch') {
    // ตรวจซ้ำกับ backend เพื่อบอกเร็ว ไม่ต้องรอรอบ GAS (ด่านจริงอยู่ที่ backend)
    const office = masterData.offices.find(o => o.id === item.officeId);
    if (office && item.name !== office.name && !item.name.startsWith(office.name + ' ')) {
      return showErr(`ชื่อต้องขึ้นต้นด้วย "${office.name}"`);
    }
  }

  const btn = $('masterSaveBtn');
  btn.disabled = true;
  btn.innerText = 'กำลังบันทึก...';
  try {
    const res = await callBackend(id ? 'updateMasterItem' : 'addMasterItem', { apiVersion: FT_API_VERSION, type, id, item });
    if (!res || res.status !== 'success') throw new Error((res && res.message) || 'บันทึกไม่สำเร็จ');
    closeMasterModal();
    ftToast(res.message || 'บันทึกแล้ว', 'success');
    await loadMaster();
  } catch (e) {
    showErr(e.message);
    if (isAuthError(e)) setAuthExpired(true);
  } finally {
    btn.disabled = false;
    btn.innerText = 'บันทึก';
  }
}

async function deleteMaster(type, row) {
  const label = MASTER_TYPES[type].label;
  if (row.used) {
    ftAlert(`ยังถูกใช้อยู่ใน ${usageText(row)}\n\nข้อมูลเดิม (ตั๋ว/ผู้ใช้) ต้องยังแสดงชื่อได้ถูกต้อง แก้ชื่อแทนได้`, { title: `ลบ${label} "${row.name}" ไม่ได้`, icon: 'lock' });
    return;
  }
  if (!(await ftConfirm('จะหายจากตัวเลือกในฟอร์มแจ้งซ่อมทันที', { title: `ลบ${label} "${row.name}"?`, confirmText: 'ลบ', danger: true, icon: 'trash-2' }))) return;
  try {
    const res = await callBackend('deleteMasterItem', { apiVersion: FT_API_VERSION, type, id: row.id });
    if (!res || res.status !== 'success') throw new Error((res && res.message) || 'ลบไม่สำเร็จ');
    ftToast(res.message || 'ลบแล้ว', 'success');
    await loadMaster();
  } catch (e) {
    ftToast(e.message, 'error');
    if (isAuthError(e)) setAuthExpired(true);
  }
}

/* =============================================================================
   Settings — เกี่ยวกับฉัน (ข้อมูลเจ้าหน้าที่) + ค่าตั้งต้นของแดชบอร์ด (เก็บใน localStorage ล้วนๆ)
   ============================================================================= */

// สิ่งที่แต่ละบทบาททำได้ — ตรงกับตาราง ACL ใน gas/ApiRouter.gs (ด่านจริงอยู่ที่ backend)
const ROLE_CAN = {
  admin: 'ทุกอย่างของเจ้าหน้าที่ IT + จัดการผู้ใช้ ข้อมูลหลัก และยกเลิกงาน',
  it:    'รับงาน ปิดงาน บันทึกวิธีแก้ไข และดูแดชบอร์ด',
  staff: 'แจ้งซ่อมและดูประวัติการแจ้งซ่อมของตัวเอง',
};

function renderSettings() {
  // เกี่ยวกับฉัน: ข้อมูลจาก getMyProfile (staffProfile) · role ใช้จาก users ถ้าโหลดแล้ว (สดกว่าหลังเปลี่ยนบทบาท)
  const me = users.find(u => u.userId === currentStaffId);
  const box = $('settingsAccountBox');
  if (!currentStaffId) {
    box.innerHTML = `
      <div class="text-sm" style="color:var(--ink-2)">ยังไม่ได้เข้าสู่ระบบ LINE</div>
      ${liffError ? `<div class="text-xs mt-1 text-red-600 break-words">สาเหตุ: ${escapeHtml(liffError)}</div>` : ''}
      <button id="settingsLoginBtn" class="mt-2 px-3 py-1.5 rounded-lg text-sm font-medium bg-brand-600 text-white hover:bg-brand-700">เข้าสู่ระบบ LINE</button>
    `;
    $('settingsLoginBtn').addEventListener('click', ensureLogin);
    return;
  }
  const displayName = (staffProfile && staffProfile.name) || currentStaff || '-';
  const avatarHtml = staffPicUrl
    ? `<img src="${escapeHtml(staffPicUrl)}" alt="" class="w-16 h-16 rounded-full object-cover shrink-0">`
    : `<span class="w-16 h-16 rounded-full bg-brand-600 text-white text-xl font-bold flex items-center justify-center shrink-0">${escapeHtml(displayName.trim().charAt(0) || '?')}</span>`;
  const sp = staffProfile || {};
  const role = me ? me.role : (sp.role ? roleOf(sp.role) : null);
  // แถวที่เป็นตัวสำนักงานเอง (ชื่อสาขา = ชื่อหน่วยงาน เช่น ภาค 9 / สำนักงานพื้นที่) ไม่ใช่สาขา — บอกให้ชัด ไม่โชว์ชื่อซ้ำ
  // คำเดียวกับเมนูข้อมูลหลัก ("ตัวสำนักงาน (ไม่ใช่สาขา)")
  const branchText = !sp.branch ? '' : sp.branch === sp.office ? 'ตัวสำนักงาน (ไม่ใช่สาขา)' : ftShortOrg(sp.branch);
  const rows = [
    ['ตำแหน่ง', sp.position],
    ['บทบาทในระบบ', role ? `${ROLES[role].label} — ${ROLE_CAN[role]}` : ''],
    ['หน่วยงาน', sp.office],
    ['สาขา', branchText],
    ['ส่วน', sp.department],
    ['จังหวัด', sp.province],
  ];
  const loading = !staffProfile;   // getMyProfile ยังไม่ตอบ (หรือดึงไม่ได้) — มีแค่ชื่อจาก LINE
  box.innerHTML = `
    <div class="flex items-center gap-4">
      ${avatarHtml}
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2 flex-wrap">
          <span class="text-lg font-bold truncate" style="color:var(--ink)">${escapeHtml(displayName)}</span>
          ${role ? roleBadge(role) : ''}
        </div>
        <div class="text-sm truncate mt-0.5" style="color:var(--ink-2)">${escapeHtml(sp.position || (loading ? 'กำลังโหลดข้อมูลจากระบบ…' : '-'))}</div>
      </div>
    </div>
    <dl class="mt-4 border-t" style="border-color:var(--grid)">
      ${rows.map(([k, v]) => `
        <div class="flex flex-col sm:flex-row sm:gap-4 py-2.5 border-b" style="border-color:var(--grid)">
          <dt class="text-xs sm:text-sm sm:w-32 shrink-0" style="color:var(--ink-muted)">${k}</dt>
          <dd class="text-sm min-w-0 break-words" style="color:var(--ink)">${v ? escapeHtml(v) : `<span style="color:var(--ink-muted)">${loading ? '…' : '-'}</span>`}</dd>
        </div>`).join('')}
      <div class="flex flex-col sm:flex-row sm:gap-4 py-2.5 border-b" style="border-color:var(--grid)">
        <dt class="text-xs sm:text-sm sm:w-32 shrink-0" style="color:var(--ink-muted)">LINE User ID</dt>
        <dd class="text-xs min-w-0 flex items-center gap-2" style="color:var(--ink-2)">
          <span class="font-mono break-all">${escapeHtml(currentStaffId)}</span>
          <button id="settingsCopyIdBtn" class="shrink-0 text-slate-400 hover:text-brand-600 p-1 -m-1 rounded" title="คัดลอก" aria-label="คัดลอก LINE User ID">${icon('copy', 'w-4 h-4')}</button>
        </dd>
      </div>
    </dl>
    <!-- USER ถูกเขียนทับด้วยค่าล่าสุดที่กรอกตอนแจ้งซ่อม (upsertReporter_) · บทบาทเปลี่ยนได้ที่เมนูผู้ใช้งานโดยแอดมินเท่านั้น -->
    <div class="text-xs mt-2" style="color:var(--ink-muted)">ชื่อ ตำแหน่ง สาขา และส่วน มาจากข้อมูลที่กรอกในฟอร์มแจ้งซ่อมครั้งล่าสุด · บทบาทเปลี่ยนได้โดยแอดมินเท่านั้น</div>
    <button id="settingsLogoutBtn" class="mt-3 px-3 py-1.5 rounded-lg text-sm font-medium border border-slate-300 text-slate-600 hover:bg-slate-50">ออกจากระบบ</button>
  `;
  $('settingsCopyIdBtn').addEventListener('click', () => ftCopy(currentStaffId, ' LINE User ID '));
  $('settingsLogoutBtn').addEventListener('click', doLogout);
}

async function doLogout() {
  if (!(await ftConfirm('ออกจากระบบ LINE บนเบราว์เซอร์นี้?', { title: 'ออกจากระบบ', confirmText: 'ออกจากระบบ', icon: 'lock' }))) return;
  localStorage.removeItem('ft_staff');
  localStorage.removeItem('ft_staff_id');
  localStorage.removeItem('ft_staff_pic');
  localStorage.removeItem(PROFILE_KEY);
  clearViewCaches();   // บอร์ด/แดชบอร์ดที่แคชไว้เป็นข้อมูลของหน่วยงาน ห้ามค้างให้คนถัดไปเห็น
  try { if (typeof liff !== 'undefined' && liff.isLoggedIn && liff.isLoggedIn()) liff.logout(); } catch (e) { /* ไม่ต้องบล็อกถ้า logout ฝั่ง LIFF พัง */ }
  location.reload();
}

function initSettingsForm() {
  $('agingDaysInput').value = agingDays;
  $('agingDaysInput').addEventListener('change', () => {
    const v = Math.max(1, Math.min(30, parseInt($('agingDaysInput').value, 10) || 3));
    agingDays = v;
    $('agingDaysInput').value = v;
    localStorage.setItem('ft_aging_days', String(v));
    $('agingSavedNote').classList.remove('hidden');
    setTimeout(() => $('agingSavedNote').classList.add('hidden'), 1500);
    // แดชบอร์ดนับ "ค้าง" ที่ server ตามค่านี้ -> เข้าหน้าแดชบอร์ดครั้งหน้าต้องโหลดใหม่
    dashLoaded = false;
    // บอร์ดใช้ค่านี้ตัดสินว่าการ์ดไหน "ค้าง" ด้วย (ขีดแดง + ป้ายค้าง N วัน)
    // ต้องวาดใหม่ทันทีแม้ตอนนี้จะอยู่หน้าตั้งค่า ไม่งั้นพอสลับกลับไปบอร์ดจะเห็นเกณฑ์เก่า
    // (switchView ไม่ได้เรียก render() ตอนกลับเข้าบอร์ด)
    render();
  });
}

/* =============================================================================
   View switching + Init
   ============================================================================= */

// รู้บทบาทแล้ว (โปรไฟล์จาก DB) และไม่ใช่แอดมิน -> ซ่อนสิ่งที่ ACL ใน ApiRouter.gs ไม่ยอมให้ทำ
// ยังไม่รู้บทบาท = แสดงตามปกติ (server ตรวจซ้ำอยู่แล้ว) กันแอดมินเห็นเมนูหายระหว่างโหลดโปรไฟล์
const roleKnownNotAdmin = () => !!staffProfile && !isAdminUser();
function applyRoleUI() {
  const hide = roleKnownNotAdmin();
  document.querySelectorAll('.nav-item[data-view="users"]').forEach(a => a.classList.toggle('hidden', hide));
  $('tabBar').classList.toggle('grid-cols-6', !hide);
  $('tabBar').classList.toggle('grid-cols-5', hide);
  if (hide && currentView === 'users') switchView('board');
}

function switchView(v) {
  if (!VIEWS[v]) v = 'board';   // กันค่าเพี้ยนใน localStorage (เช่นจากเวอร์ชันอนาคต) ทำหน้า crash
  if (v === 'users' && roleKnownNotAdmin()) v = 'board';   // จำหน้าผู้ใช้งานไว้ตอนยังเป็นแอดมิน
  currentView = v;
  $('viewBoard').classList.toggle('hidden', v !== 'board');
  $('boardTools').classList.toggle('hidden', v !== 'board');   // แถบกรองอยู่นอก #viewBoard ต้องซ่อนเอง
  $('viewDashboard').classList.toggle('hidden', v !== 'dashboard');
  $('viewKB').classList.toggle('hidden', v !== 'kb');
  $('viewUsers').classList.toggle('hidden', v !== 'users');
  $('viewMaster').classList.toggle('hidden', v !== 'master');
  $('viewSettings').classList.toggle('hidden', v !== 'settings');
  $('viewTitle').innerHTML = `<span class="md:hidden">${VIEWS[v].short}</span><span class="hidden md:inline">${VIEWS[v].title}</span>`;
  if (v !== 'board') closeTicket();
  $('viewSubtitle').innerText = VIEWS[v].sub;
  document.querySelectorAll('.nav-item').forEach(a => a.classList.toggle('active', a.dataset.view === v));
  localStorage.setItem('ft_view', v);
  syncStaleBar();
  // ทุกหน้าโหลดครั้งแรกตอนเข้าหน้า (เปิดแอปแล้วไม่ต้องรอโหลดของหน้าที่ยังไม่ได้ดู)
  if (v === 'board')     { if (!boardLoaded) loadBoard(); }
  if (v === 'dashboard') { renderDashboard(); if (!dashLoaded) loadDashboard(); }   // วาดใหม่ตอนแสดงเสมอ ให้ขนาด svg ถูก
  if (v === 'kb')        { kbLoaded    ? renderKB()    : loadKB(); }
  if (v === 'users')     { usersLoaded ? renderUsers() : loadUsers(); }
  if (v === 'master')    { masterLoaded ? renderMaster() : loadMaster(); }
  if (v === 'settings')  renderSettings();
}

// ---------- Events ----------
document.querySelectorAll('.nav-item').forEach(a =>
  a.addEventListener('click', () => switchView(a.dataset.view)));
$('staffBtn').addEventListener('click', () => { if (!currentStaffId) ensureLogin(); });
// โหลดใหม่ตาม view ที่เปิดอยู่ (แต่ละหน้าโหลดข้อมูลคนละชุด) — ทิ้งหน้าที่จำไว้ทั้งหมด เอาของสดจาก DB
function reloadView(v) {
  clearPageCache();
  if (v === 'users')     return loadUsers();
  if (v === 'kb')        { kbCats = null; return loadKB(); }
  if (v === 'master')    return loadMaster();
  if (v === 'dashboard') return loadDashboard();
  if (v === 'settings')  return loadMyProfile();
  loadBoard();
}
$('refreshBtn').addEventListener('click', () => reloadView(currentView));
// เน็ตกลับมา: หน้าที่ค้างอยู่ที่หน้าสถานะ "โหลดไม่สำเร็จ" ลองใหม่เอง (ตามที่หน้าสถานะบอกผู้ใช้ไว้)
window.addEventListener('online', () => { if (viewErr[currentView]) reloadView(currentView); });
$('pdfClose').addEventListener('click', closePdf);
$('tdClose').addEventListener('click', closeTicket);
$('ticketDrawer').addEventListener('click', (e) => { if (e.target === $('ticketDrawer')) closeTicket(); });
// Esc ปิดแผง — ยกเว้นมี modal ซ้อนอยู่ข้างบน (ปิดงาน/PDF) ให้ตัวบนปิดก่อน
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && drawerId != null &&
      $('closeModal').classList.contains('hidden') && $('pdfModal').classList.contains('hidden')) closeTicket();
});
$('pdfModal').addEventListener('click', (e) => { if (e.target === $('pdfModal')) closePdf(); });
// ค้นที่ DB — รอพิมพ์จบก่อนค่อยยิง (ไม่ยิงทุกตัวอักษร) แล้วกลับไปหน้า 1
function debounced(fn, ms) {
  let timer = null;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}
$('userSearch').addEventListener('input', debounced((e) => {
  if (e.target.value.trim() === userSearch.trim()) return;
  userSearch = e.target.value;
  loadUsers(1);
}, 400));
$('kbSearchInput').addEventListener('input', debounced((e) => {
  if (e.target.value.trim() === kbSearch.trim()) return;
  kbSearch = e.target.value;
  loadKB(1);
}, 400));
$('closeCancelBtn').addEventListener('click', cancelClose);
$('closeSkipBtn').addEventListener('click', () => finishClose(''));
$('closeConfirmBtn').addEventListener('click', () => finishClose($('closeResolution').value.trim()));
$('closeModal').addEventListener('click', (e) => { if (e.target === $('closeModal')) cancelClose(); });
$('kbEditCancelBtn').addEventListener('click', cancelKbEdit);
$('kbEditSaveBtn').addEventListener('click', saveKbEdit);
$('kbEditModal').addEventListener('click', (e) => { if (e.target === $('kbEditModal')) cancelKbEdit(); });
document.querySelectorAll('.master-tab').forEach(b =>
  b.addEventListener('click', () => { masterTab = b.dataset.tab; renderMaster(); }));
$('masterAddBtn').addEventListener('click', () => {
  if (masterTab === 'branch' && !masterData.offices.length) return ftToast('ต้องมีพื้นที่อย่างน้อย 1 รายการก่อนเพิ่มสาขา', 'info');
  openMasterModal(masterTab, null);
});
$('masterCancelBtn').addEventListener('click', closeMasterModal);
$('masterSaveBtn').addEventListener('click', saveMaster);
$('masterName').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveMaster(); });
$('masterModal').addEventListener('click', (e) => { if (e.target === $('masterModal')) closeMasterModal(); });

// หมุนจอ/ย่อขยายหน้าต่าง: กราฟเส้นคำนวณ viewBox จากความกว้างจริง ต้องวาดใหม่
// (การ์ด/ตารางเป็น CSS ล้วน ปรับเองอยู่แล้ว) — debounce กันวาดรัวตอนลากขอบหน้าต่าง
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (currentView === 'dashboard' && dashData) renderDashboard();
  }, 200);
});

// ---------- Init ----------
// ถ้า currentView เป็น view ที่ผลลัพธ์ขึ้นกับตัวตน (settings แสดงบัญชี, users มีปุ่มแก้บทบาท)
// ต้องวาดใหม่หลัง LIFF login resolve เสร็จ ไม่งั้นค้างสถานะ "ยังไม่ login" ทั้งที่ล็อกอินแล้ว
function refreshIdentityDependentViews() {
  applyRoleUI();
  if (currentView === 'board') render();   // ปุ่มยกเลิกงานบนการ์ดขึ้นกับบทบาท
  if (currentView === 'master' && masterLoaded) renderMaster();   // ปุ่มเพิ่ม/แก้/ลบ เฉพาะแอดมิน
  if (currentView === 'settings') renderSettings();
  if (currentView === 'users' && usersLoaded) renderUsers();
}

// ระบุตัวจาก LINE — ใช้ LIFF app ตัวที่ 2 (ADMIN_LIFF_ID, endpoint = admin.html)
// ถ้ายังไม่ได้ตั้ง จะ fallback เป็น MY_LIFF_ID (เปิด URL ตรงบนเดสก์ท็อปก็ใช้ได้)
// คืน false เมื่อกำลังเด้งไปหน้า login (หน้านี้กำลังจะถูกทิ้ง ไม่ต้องโหลดข้อมูลต่อ)
async function setupLiff() {
  try {
    const adminLiffId = (typeof ADMIN_LIFF_ID !== 'undefined' && ADMIN_LIFF_ID)
      ? ADMIN_LIFF_ID
      : (typeof MY_LIFF_ID !== 'undefined' ? MY_LIFF_ID : '');
    if (adminLiffId) {
      await liff.init({ liffId: adminLiffId });
      if (!liff.isLoggedIn()) {
        // ในแอป LINE ต้อง login อัตโนมัติตั้งแต่ init — ถ้าไม่ แปลว่า LIFF ID ไม่ตรงกับ LIFF app ที่เปิดหน้านี้
        // ห้ามเด้ง/reload เอง ไม่งั้นวนไม่รู้จบ
        if (liff.isInClient()) throw new Error('LIFF ID ไม่ตรงกับ LIFF app ที่เปิดหน้านี้ (' + adminLiffId + ') — ตั้ง ADMIN_LIFF_ID ใน config.js');
        ensureLogin(); return false;   // เด้งไป login แล้วกลับมาที่หน้านี้
      }
      if (!liff.getIDToken()) throw new Error('ไม่ได้ ID Token — LIFF ID ใน config.js ไม่ตรงกับ LIFF app ที่เปิดหน้านี้ (' + adminLiffId + ')');

      // getProfile() ต้องเปิด scope "profile" ใน LIFF app — ถ้าไม่ได้เปิด ยังใช้ userId จาก ID Token (sub) ได้
      let p = null;
      try { p = await liff.getProfile(); } catch (e) { console.warn('getProfile:', e.message); }
      const tok = liff.getDecodedIDToken() || {};
      const prevId = currentStaffId;
      currentStaffId = (p && p.userId) || tok.sub || '';   // ค่านี้แหละที่ลง IT_In_Charge ได้จริง
      // เปลี่ยนบัญชี LINE บนเครื่องเดิม -> ทิ้งโปรไฟล์ DB ของคนก่อน (ไม่งั้นมุมขวาบนโชว์ชื่อ/ตำแหน่งคนอื่น)
      if (prevId && prevId !== currentStaffId) { staffProfile = null; localStorage.removeItem(PROFILE_KEY); }
      currentStaff = (p && p.displayName) || tok.name || currentStaff || 'ผู้ใช้ LINE';
      staffPicUrl = (p && p.pictureUrl) || tok.picture || '';
      localStorage.setItem('ft_staff', currentStaff);
      localStorage.setItem('ft_staff_id', currentStaffId);
      localStorage.setItem('ft_staff_pic', staffPicUrl);
      setStaffUI();
      refreshIdentityDependentViews();

      // ดึงข้อมูลจาก DB (ชื่อจริง, ตำแหน่ง, สังกัด) — ไม่บล็อก UI เรียกเบื้องหลัง
      loadMyProfile();
    }
  } catch (e) {
    // login พังไม่ควรทำให้ดูบอร์ดไม่ได้ — ยังดูได้ แต่กดรับงานจะโดนเตือนให้ login ก่อน
    console.warn('LINE login ไม่สำเร็จ:', e);
    liffError = e.message || String(e);
    currentStaffId = '';
    setStaffUI();
    refreshIdentityDependentViews();
  }
  return true;
}

function init() {
  setStaffUI();
  applyRoleUI();
  initSettingsForm();
  initBoardTools();
  $('authReloginBtn')?.addEventListener('click', ensureLogin);
  liffReady = setupLiff();   // เริ่ม login ทันที แต่ไม่บล็อกการวาดหน้า — loadX() จะ await เอง
  // จำ view ล่าสุดที่เปิดไว้ · switchView เป็นคนสั่งโหลดข้อมูลของหน้านั้น (หน้าอื่นโหลดตอนเปิดดู)
  switchView(localStorage.getItem('ft_view') || 'board');
}
init();
