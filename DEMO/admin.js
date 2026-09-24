/* =============================================================================
   FAST TICKET · admin.js — Task Board (Kanban) + Dashboard
   -----------------------------------------------------------------------------
   ต้องโหลดหลัง: config.js, common.js, map-data.js

   API contract (ฝั่ง GAS — ดู AdminApi.gs):
     getTickets({})
       -> { status:'success', tickets:[ { id, code, detail, category, branch,
            province, reporter, assignee, status, createdAt, acceptedAt,
            closedAt, pdfUrl } ] }
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
  { key:'OPEN',        status:STATUS.OPEN,        title:'รอรับเรื่อง',      en:'Open',        dot:'bg-amber-400',  head:'text-amber-600',  body:'bg-amber-50/40' },
  { key:'IN_PROGRESS', status:STATUS.IN_PROGRESS, title:'กำลังดำเนินการ',   en:'In Progress', dot:'bg-blue-500',   head:'text-blue-600',   body:'bg-blue-50/40' },
  { key:'CLOSED',      status:STATUS.CLOSED,      title:'เสร็จสิ้น',         en:'Closed',      dot:'bg-emerald-500',head:'text-emerald-600',body:'bg-emerald-50/40' },
];

// จอสัมผัส: HTML5 drag & drop ไม่ทำงานบนมือถือเลย (dragstart ไม่ยิง)
// จึงต้องเปลี่ยนทั้งข้อความบอกวิธีใช้ และปิด draggable ทิ้ง ไม่งั้น Android จะกดค้าง
// แล้วเกิด ghost image ค้างจนเลื่อนบอร์ดไม่ได้ — ปุ่มบนการ์ดคือทางเปลี่ยนสถานะบนมือถือ
const IS_TOUCH = window.matchMedia('(hover: none)').matches;

const VIEWS = {
  dashboard: { title:'แดชบอร์ด (Dashboard)', sub:'ภาพรวมงานแจ้งซ่อม · คำนวณจากตั๋วทั้งหมด' },
  board:     { title:'ตารางงาน IT Support (Task Board)',
               sub: IS_TOUCH ? 'ปัดซ้าย-ขวาเพื่อดูคอลัมน์อื่น · แตะปุ่มบนการ์ดเพื่อเปลี่ยนสถานะ'
                             : 'จัดการคิวงานแบบ Kanban · ลากการ์ดเพื่อเปลี่ยนสถานะ' },
  kb:        { title:'ประวัติการแจ้งซ่อม', sub:'รวมประวัติและวิธีแก้ไขปัญหาจากตั๋วที่ปิดงานแล้ว' },
  users:     { title:'ผู้ใช้งาน (Users)', sub:'จัดการบัญชีผู้ใช้งานและสิทธิ์การเข้าถึงระบบทั้งหมด' },
  master:    { title:'ข้อมูลหลัก (Master Data)', sub:'พื้นที่ · สาขา · หมวดหมู่ปัญหา ที่ใช้ในฟอร์มแจ้งซ่อม' },
  settings:  { title:'ตั้งค่า (Settings)', sub:'บัญชีของฉันและค่าตั้งต้นของแดชบอร์ด' },
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
let tickets = [];
let usingMock = false;
let currentView = 'board';
// ---------- ตัวกรองของบอร์ด ----------
// พอคิวงานยาวขึ้น การวาดทุกใบพร้อมกันทำให้หางานไม่เจอและ DOM บวมจนเลื่อนหนืด
// จึงต้องมีทั้ง "กรองให้เหลือน้อยลง" และ "ทยอยวาด" ควบคู่กัน
let boardSearch = '';
let boardCat = 'all';
let boardProv = 'all';
let boardMine = false;
let boardSort = 'new';        // new = ใหม่สุดก่อน · old = เก่าสุดก่อน (ไล่งานค้าง)
// คอลัมน์ "เสร็จสิ้น" โตขึ้นเรื่อยๆ ไม่มีวันหยุด และงานที่ปิดไปนานแล้วแทบไม่มีใครดู
// จึงตัดให้เหลือเฉพาะช่วงล่าสุด (0 = แสดงทั้งหมด)
let closedDays = parseInt(localStorage.getItem('ft_closed_days'), 10);
if (isNaN(closedDays)) closedDays = 7;
let boardCompact = localStorage.getItem('ft_board_compact') === '1';
const BOARD_PAGE = 25;        // จำนวนการ์ดที่วาดต่อคอลัมน์ในรอบแรก
let colLimit = {};            // status -> จำนวนที่แสดงอยู่ตอนนี้
// โมดูล Users — โหลดแบบ lazy ตอนเข้าหน้า ไม่ดึงพร้อมตั๋ว
let users = [];
let usingMockUsers = false;
let usersLoaded = false;
let userSearch = '';
let userRoleFilter = 'all';
// โมดูล Knowledge Base — โหลดแบบ lazy เหมือนกัน
let kbArticles = [];
let usingMockKb = false;
let kbLoaded = false;
let kbSearch = '';
let kbCatFilter = 'all';
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
let staffProfile   = JSON.parse(localStorage.getItem('ft_staff_profile') || 'null');  // { name, position, role, dept, branch, province }

const callBackend = (action, data) => ftCallBackend(action, data);

// LIFF init เป็น async แต่ switchView() วาดหน้าทันทีและอาจสั่งโหลดข้อมูลเลย (ft_view = users/kb)
// ถ้าไม่รอ liff.init() ให้เสร็จก่อน getIDToken() จะคืน null -> backend ปฏิเสธ -> ตกโหมดตัวอย่าง
// ทั้งที่ login อยู่แท้ๆ · ทุก loadX() จึงต้อง await ตัวนี้ก่อนยิง backend
let liffReady = Promise.resolve(true);
let liffError = '';   // สาเหตุที่ login LINE ไม่ผ่าน — โชว์บนจอ เพราะในแอป LINE เปิด console ไม่ได้

// พิมพ์ "สาเหตุจริง" ลงแบนเนอร์ — ใน LINE in-app browser เปิด DevTools ไม่ได้
// ถ้า catch กลืน error ทิ้งเงียบๆ จะ debug บนมือถือไม่ได้เลยว่าพังเพราะอะไร
function setMockReason(elId, err) {
  const el = $(elId);
  if (el) el.innerText = err ? 'สาเหตุ: ' + err.message : '';
}

// แยก "เซสชันหมดอายุ" ออกจากความผิดพลาดอื่น (เน็ตหลุด / backend ล่ม)
// เพราะสองอย่างนี้ผู้ใช้ต้องทำคนละเรื่อง: อันนี้ต้อง login ใหม่ ส่วนอันนั้นแค่กดโหลดใหม่
// liff.getIDToken() ไม่ต่ออายุ token ให้เอง มันคืนใบเดิมที่หมดอายุไปเรื่อยๆ
// ทางเดียวคือ login ใหม่ ซึ่งผู้ใช้เดาเองไม่ได้ถ้าระบบไม่บอก
const isAuthError = (e) => /ยืนยันตัวตน|ID Token|เข้าสู่ระบบใหม่/.test((e && e.message) || '');

// ไม่เด้งไปหน้า login เองอัตโนมัติ — ถ้า login ไม่ผ่านจะวนซ้ำไม่รู้จบ
// ให้ผู้ใช้กดเองจากปุ่มบนแถบเตือนแทน
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
   ---------------------------------------------------------------------------- */
const TICKET_CACHE_KEY = 'ft_tickets_cache';
const TICKET_CACHE_MAX_AGE = 24 * 3600e3;   // เกิน 1 วันถือว่าเก่าเกินกว่าจะเอามาโชว์

function readTicketCache() {
  try {
    const o = JSON.parse(localStorage.getItem(TICKET_CACHE_KEY) || 'null');
    if (!o || !Array.isArray(o.tickets) || !o.savedAt) return null;
    if (Date.now() - o.savedAt > TICKET_CACHE_MAX_AGE) return null;
    // แคชผูกกับบัญชี — กันข้อมูลของคนก่อนหน้าโผล่ให้อีกคนเห็นบนเครื่องที่ใช้ร่วมกัน
    if (o.owner && currentStaffId && o.owner !== currentStaffId) return null;
    return o;
  } catch (e) { return null; }
}

function writeTicketCache(list) {
  try {
    localStorage.setItem(TICKET_CACHE_KEY,
      JSON.stringify({ savedAt: Date.now(), owner: currentStaffId || '', tickets: list }));
  } catch (e) { /* โควตาเต็ม/โหมดส่วนตัว — แคชเป็นของแถม ไม่ใช่ของจำเป็น */ }
}

function clearTicketCache() {
  try { localStorage.removeItem(TICKET_CACHE_KEY); } catch (e) {}
}

// แถบเล็กๆ บอกว่าที่เห็นอยู่เป็นของเก่าและกำลังดึงของใหม่
function setStale(on, savedAt) {
  const el = $('staleBar');
  if (!el) return;
  el.classList.toggle('hidden', !on);
  if (on) $('staleText').innerText = 'กำลังอัปเดตข้อมูล… ที่เห็นอยู่คือข้อมูลเมื่อ ' + timeAgo(new Date(savedAt).toISOString());
}

// ---------- ข้อมูลตัวอย่าง (fallback เมื่อเรียก backend ไม่สำเร็จ) ----------
const MOCK_NOW = Date.now();
const hrsAgo = (h) => new Date(MOCK_NOW - h * 3600e3).toISOString();
const MOCK = [
  { id:125, code:'TK-125', detail:'ปริ้นเตอร์ที่ชั้น 3 พิมพ์ไม่ออก', category:'ฮาร์ดแวร์', branch:'สาขาเมืองสงขลา', province:'สงขลา', reporter:'กัญญาภัทร', assignee:null, status:STATUS.OPEN, createdAt:hrsAgo(2), acceptedAt:null, closedAt:null, pdfUrl:'' },
  { id:126, code:'TK-126', detail:'ต้องการตั้งค่าอีเมลในมือถือใหม่', category:'ซอฟต์แวร์', branch:'สาขาหาดใหญ่', province:'สงขลา', reporter:'นพดล', assignee:null, status:STATUS.OPEN, createdAt:hrsAgo(5), acceptedAt:null, closedAt:null, pdfUrl:'' },
  { id:127, code:'TK-127', detail:'ลืมรหัสผ่านเข้าระบบ CRM', category:'ซอฟต์แวร์', branch:'สาขาเมืองตรัง', province:'ตรัง', reporter:'วิภาดา', assignee:null, status:STATUS.OPEN, createdAt:hrsAgo(9), acceptedAt:null, closedAt:null, pdfUrl:'' },
  { id:124, code:'TK-124', detail:'เน็ตหลุดบ่อยช่วงบ่าย', category:'เครือข่าย', branch:'สาขาเมืองนราธิวาส', province:'นราธิวาส', reporter:'ฮาซัน', assignee:null, status:STATUS.OPEN, createdAt:hrsAgo(96), acceptedAt:null, closedAt:null, pdfUrl:'' },
  { id:123, code:'TK-123', detail:'จอมอนิเตอร์มีเส้นแนวตั้ง', category:'ฮาร์ดแวร์', branch:'สาขาเมืองยะลา', province:'ยะลา', reporter:'ปรีชา', assignee:null, status:STATUS.OPEN, createdAt:hrsAgo(120), acceptedAt:null, closedAt:null, pdfUrl:'' },
  { id:122, code:'TK-122', detail:'ขอติดตั้งโปรแกรม AutoCAD', category:'ซอฟต์แวร์', branch:'สาขาเมืองสงขลา', province:'สงขลา', reporter:'ประสิทธิ์', assignee:'สมคิด ไอที', status:STATUS.IN_PROGRESS, createdAt:hrsAgo(6), acceptedAt:hrsAgo(2), closedAt:null, pdfUrl:'' },
  { id:121, code:'TK-121', detail:'ตั้งค่าเครื่องสแกนใหม่', category:'ฮาร์ดแวร์', branch:'สาขาเมืองพัทลุง', province:'พัทลุง', reporter:'สมหญิง', assignee:'สมคิด ไอที', status:STATUS.IN_PROGRESS, createdAt:hrsAgo(28), acceptedAt:hrsAgo(20), closedAt:null, pdfUrl:'' },
  { id:120, code:'TK-120', detail:'อัปเกรด RAM เครื่อง Design', category:'ฮาร์ดแวร์', branch:'สาขาหาดใหญ่', province:'สงขลา', reporter:'มานี', assignee:'วิชัย ไอที', status:STATUS.IN_PROGRESS, createdAt:hrsAgo(10), acceptedAt:hrsAgo(4), closedAt:null, pdfUrl:'' },
  { id:119, code:'TK-119', detail:'อีเมลส่งออกไม่ได้', category:'ซอฟต์แวร์', branch:'สาขาเมืองปัตตานี', province:'ปัตตานี', reporter:'นูรีดา', assignee:'วิชัย ไอที', status:STATUS.CLOSED, createdAt:hrsAgo(72), acceptedAt:hrsAgo(66), closedAt:hrsAgo(50), pdfUrl:'' },
  { id:118, code:'TK-118', detail:'เปลี่ยนสาย LAN ใหม่', category:'เครือข่าย', branch:'สาขาเมืองสงขลา', province:'สงขลา', reporter:'สุรชัย', assignee:'สมคิด ไอที', status:STATUS.CLOSED, createdAt:hrsAgo(30), acceptedAt:hrsAgo(28), closedAt:hrsAgo(24), pdfUrl:'' },
  { id:117, code:'TK-117', detail:'ขอสิทธิ์เข้าระบบสารบรรณ', category:'อื่นๆ', branch:'สาขาเมืองสตูล', province:'สตูล', reporter:'ยะห์ยา', assignee:'วิชัย ไอที', status:STATUS.CLOSED, createdAt:hrsAgo(140), acceptedAt:hrsAgo(130), closedAt:hrsAgo(120), pdfUrl:'' },
  { id:115, code:'TK-115', detail:'ตั้งค่าแชร์ปริ้นเตอร์', category:'ฮาร์ดแวร์', branch:'สาขาเบตง', province:'ยะลา', reporter:'อารีย์', assignee:'วิชัย ไอที', status:STATUS.CLOSED, createdAt:hrsAgo(50), acceptedAt:hrsAgo(48), closedAt:hrsAgo(26), pdfUrl:'' },
];

// ---------- โหลดตั๋ว ----------
async function loadTickets() {
  // วาดของที่แคชไว้ก่อน ผู้ใช้จะได้ไม่ต้องมองจอว่างระหว่างรอ liff.init + GAS (รวม ~2-4 วิ)
  // ทำเฉพาะรอบแรกที่ยังไม่มีข้อมูลในหน้า — กดปุ่มโหลดใหม่ไม่ต้องย้อนไปแสดงของเก่า
  const cached = tickets.length ? null : readTicketCache();
  if (cached) {
    tickets = cached.tickets.map(normalize);
    usingMock = false;
    setStale(true, cached.savedAt);
    render();
  } else {
    $('boardLoading')?.classList.remove('hidden');
  }

  await liffReady;   // ดูคอมเมนต์ที่ liffReady
  try {
    const res = await callBackend('getTickets', {});
    if (res && res.status === 'success' && Array.isArray(res.tickets)) {
      tickets = res.tickets.map(normalize);
      usingMock = false;
      writeTicketCache(res.tickets);
    } else { throw new Error((res && res.message) || 'ไม่มีข้อมูลจาก backend'); }
    setMockReason('mockReason', null);
    setAuthExpired(false);
    setStale(false);
  } catch (e) {
    // มีของจริงจากแคชอยู่แล้ว อย่าเอาข้อมูลจำลองไปทับ — ของเก่าที่จริงยังมีประโยชน์
    // กว่าของปลอมที่สด และผู้ใช้ยังเห็นแถบเตือนว่าอัปเดตไม่สำเร็จอยู่ดี
    if (!cached) {
      tickets = MOCK.map(normalize);
      usingMock = true;
    } else {
      setStale(true, cached.savedAt);
    }
    setMockReason('mockReason', e);
    if (isAuthError(e)) setAuthExpired(true);   // เน็ตหลุดไม่ต้องขึ้น ให้ขึ้นเฉพาะเซสชันหมดอายุ
  }
  $('mockBanner').classList.toggle('hidden', !usingMock);
  render();
}

// เติมค่าที่อาจขาดจาก backend ให้ครบทุก field ที่หน้าเว็บใช้
function normalize(t) {
  return {
    id: t.id,
    code: t.code || ('TK-' + t.id),
    detail: t.detail || '(ไม่มีรายละเอียด)',
    category: cleanCategory(t.category || ''),
    branch: t.branch || '',
    province: t.province || '',   // ใช้กับแผนที่ (ถ้าไม่มี จะ fallback เดาจากชื่อสาขาใน normProv)
    reporter: t.reporter || '-',
    assignee: t.assignee || null,
    status: Number(t.status),
    createdAt: t.createdAt || null,
    acceptedAt: t.acceptedAt || null,
    closedAt: t.closedAt || null,
    pdfUrl: t.pdfUrl || ''
  };
}

/* =============================================================================
   Task Board (Kanban)
   ============================================================================= */

// คืนตั๋วของคอลัมน์หลังกรอง + จำนวนก่อนกรอง (เอาไว้โชว์ "5/23" ที่หัวคอลัมน์)
function boardItems(status) {
  const all = tickets.filter(t => t.status === status);
  let items = all;

  // คอลัมน์ปิดงานสะสมไปเรื่อยๆ ไม่มีเพดาน ตัดให้เหลือช่วงล่าสุดก่อนเป็นอย่างแรก
  if (status === STATUS.CLOSED && closedDays > 0) {
    const cut = Date.now() - closedDays * DAY_MS;
    items = items.filter(t => { const c = parseT(t.closedAt); return c == null || c >= cut; });
  }
  if (boardCat !== 'all')  items = items.filter(t => (t.category || 'อื่นๆ') === boardCat);
  if (boardProv !== 'all') items = items.filter(t => normProv(t.province) === boardProv);
  // "งานของฉัน" เทียบด้วยชื่อที่แสดง เพราะ backend ส่ง assignee มาเป็นชื่อ ไม่ใช่ userId
  if (boardMine) items = items.filter(t => t.assignee && t.assignee === currentStaff);

  const q = boardSearch.trim().toLowerCase();
  if (q) items = items.filter(t =>
    [t.code, t.detail, t.reporter, t.assignee, t.branch, t.province, t.category]
      .some(v => String(v || '').toLowerCase().includes(q)));

  // เรียงตามเวลาที่ "ตรงกับสถานะนั้น" ไม่ใช่เวลาแจ้งเสมอไป
  // (คอลัมน์เสร็จสิ้นควรเรียงตามเวลาปิด ไม่ใช่เวลาที่แจ้งเข้ามา)
  const key = (t) => parseT(
    t.status === STATUS.CLOSED      ? (t.closedAt   || t.createdAt) :
    t.status === STATUS.IN_PROGRESS ? (t.acceptedAt || t.createdAt) : t.createdAt) || 0;
  items = items.slice().sort((a, b) => boardSort === 'new' ? key(b) - key(a) : key(a) - key(b));

  return { items, total: all.length };
}

// เปลี่ยนตัวกรองแล้วต้องรีเซ็ตจำนวนที่ทยอยวาดด้วย ไม่งั้นผลลัพธ์ชุดใหม่จะถูกตัดด้วยเพดานเก่า
function applyBoardFilter() { colLimit = {}; render(); }

function render() {
  const board = $('board');
  board.innerHTML = '';
  board.classList.toggle('board-compact', boardCompact);
  let shown = 0, grand = 0;
  for (const col of COLUMNS) {
    const r = boardItems(col.status);
    const items = r.items;
    const limit = colLimit[col.status] || BOARD_PAGE;
    const visible = items.slice(0, limit);
    shown += items.length;
    grand += r.total;
    const colEl = document.createElement('div');
    // มือถือ: กว้าง 86vw ให้เห็นคอลัมน์ถัดไปโผล่มานิดนึง = บอกใบ้ว่าปัดต่อได้
    // (ถ้า fix 320px บนจอ 360px จะเต็มพอดีจนดูเหมือนไม่มีอะไรต่อ)
    // max-w ต้องปลดที่ md ด้วย (md:max-w-none) ไม่งั้นมันคุมทับ w-[320px] บนเดสก์ท็อป
    // ทำให้คอลัมน์กว้าง 340px แล้วบอร์ดเลื่อนแนวนอนทั้งที่จอกว้างพอ
    // ขยายเป็น 360px เฉพาะ 2xl (1536px+) ซึ่งกว้างพอให้ 3 คอลัมน์อยู่ครบโดยไม่ต้องเลื่อน
    colEl.className = 'board-col w-[86vw] max-w-[340px] md:max-w-none md:w-[320px] 2xl:w-[360px] shrink-0 flex flex-col rounded-xl border border-slate-200 ' + col.body;
    colEl.dataset.status = col.status;

    colEl.innerHTML = `
      <div class="flex items-center justify-between gap-2 px-3.5 md:px-4 py-3 shrink-0">
        <div class="flex items-center gap-2 font-semibold min-w-0 ${col.head}">
          <span class="w-2.5 h-2.5 rounded-full shrink-0 ${col.dot}"></span><span class="truncate">${col.title}</span>
          <span class="text-slate-400 font-normal text-sm hidden sm:inline">(${col.en})</span>
        </div>
        <span class="text-sm font-bold shrink-0 ${items.length !== r.total ? 'text-blue-600' : 'text-slate-400'}">${items.length !== r.total ? items.length + '/' + r.total : r.total}</span>
      </div>
      <div class="col-scroll flex-1 overflow-y-auto px-3 pb-3 flex flex-col gap-3" data-drop="${col.status}"></div>
    `;
    const list = colEl.querySelector('[data-drop]');
    if (!items.length) {
      // แยกสองกรณีให้ชัด ไม่งั้นผู้ใช้จะนึกว่าระบบพังทั้งที่แค่กรองจนไม่เหลือ
      list.innerHTML = `<div class="text-center text-xs text-slate-400 py-6">${
        r.total ? 'ไม่มีงานที่ตรงกับตัวกรอง' : 'ยังไม่มีงานในคอลัมน์นี้'}</div>`;
    } else {
      visible.forEach(t => list.appendChild(cardEl(t)));
      if (items.length > visible.length) {
        const more = document.createElement('button');
        more.className = 'shrink-0 w-full text-xs font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-lg py-2.5 min-h-[40px]';
        more.textContent = `แสดงเพิ่ม (เหลืออีก ${items.length - visible.length})`;
        more.addEventListener('click', () => { colLimit[col.status] = limit + BOARD_PAGE; render(); });
        list.appendChild(more);
      }
    }

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
  syncBoardTools(shown, grand);
  // บอร์ดกับแดชบอร์ดใช้ tickets ชุดเดียวกัน — แต่วาดแดชบอร์ดเฉพาะตอนที่มองเห็น
  // (switchView จะวาดใหม่เสมอเมื่อสลับมา จึงไม่มีทางเห็นข้อมูลเก่า)
  if (!$('viewDashboard').classList.contains('hidden')) renderDashboard();
}

// เติมตัวเลือกจากข้อมูลจริง ไม่ hardcode เพราะหมวดหมู่/พื้นที่มาจาก DB และเพิ่มได้
// เขียนทับเฉพาะตอนรายการเปลี่ยนจริง ไม่งั้น dropdown จะปิดตัวเองระหว่างผู้ใช้กำลังเลือก
function fillSelect(el, values, cur, allLabel) {
  if (!el) return;
  const opts = ['all', ...values];
  const sig = opts.join('|');
  if (el.dataset.sig !== sig) {
    el.dataset.sig = sig;
    el.innerHTML = opts.map(v =>
      `<option value="${escapeHtml(v)}">${v === 'all' ? allLabel : escapeHtml(v)}</option>`).join('');
  }
  el.value = cur;
}

const toggleBtn = (el, on) => {
  if (!el) return;
  el.classList.toggle('bg-blue-600', on);
  el.classList.toggle('text-white', on);
  el.classList.toggle('bg-slate-100', !on);
  el.classList.toggle('text-slate-600', !on);
};

function syncBoardTools(shown, grand) {
  fillSelect($('boardCat'),  [...new Set(tickets.map(t => t.category || 'อื่นๆ'))].sort(), boardCat,  'ทุกหมวดหมู่');
  fillSelect($('boardProv'), [...new Set(tickets.map(t => normProv(t.province)))].sort(),  boardProv, 'ทุกพื้นที่');
  const cnt = $('boardCount');
  if (cnt) cnt.textContent = shown === grand ? `${grand} งาน` : `แสดง ${shown} จาก ${grand} งาน`;
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
}

function initBoardTools() {
  const s = $('boardSearch');
  if (s) {
    let timer = null;
    s.addEventListener('input', () => {            // debounce: อย่าวาดบอร์ดใหม่ทุกตัวอักษร
      clearTimeout(timer);
      timer = setTimeout(() => { boardSearch = s.value; applyBoardFilter(); }, 200);
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
    applyBoardFilter();
  });
  $('boardReset')?.addEventListener('click', () => {
    boardSearch = ''; boardCat = 'all'; boardProv = 'all'; boardMine = false; boardSort = 'new';
    if (s) s.value = '';
    applyBoardFilter();
  });
}

function cardEl(t) {
  const el = document.createElement('div');
  // งานที่ยังไม่ปิดและค้างเกินเกณฑ์ (agingDays จากหน้าตั้งค่า) ต้องสะดุดตาบนบอร์ด
  // ไม่งั้นพอคิวยาว งานเก่าจะจมอยู่ล่างสุดโดยไม่มีใครสังเกต
  const ageDays = t.status === STATUS.CLOSED ? 0
    : (Date.now() - (parseT(t.createdAt) || Date.now())) / DAY_MS;
  const isOld = ageDays >= agingDays;

  el.className = (IS_TOUCH ? '' : 'card-drag ') + 'tk-card bg-white rounded-lg border border-slate-200 p-3.5 shadow-sm hover:shadow-md transition-shadow'
    + (isOld ? ' tk-old' : '');
  el.draggable = !IS_TOUCH;   // ดูเหตุผลที่ IS_TOUCH
  el.dataset.id = t.id;

  const timeLine = t.status === STATUS.CLOSED
    ? (t.closedAt ? `ปิดงาน: ${timeAgo(t.closedAt)}` : '')
    : (t.status === STATUS.IN_PROGRESS && t.acceptedAt ? `เริ่ม: ${timeAgo(t.acceptedAt)}` : `แจ้ง: ${timeAgo(t.createdAt)}`);

  // ปุ่มตามคอลัมน์ — บนมือถือปุ่มพวกนี้คือ "ทางเดียว" ที่เปลี่ยนสถานะได้ (ลากไม่ได้)
  // จึงทำเป็นปุ่มมีพื้นหลัง + เป้ากดใหญ่ (.card-act) ไม่ใช่ตัวหนังสือเปล่าๆ
  let action = '';
  if (t.status === STATUS.OPEN) {
    action = `<button data-act="accept" class="card-act bg-blue-50 text-blue-700 hover:bg-blue-100 font-semibold">รับงาน →</button>`;
  } else if (t.status === STATUS.IN_PROGRESS) {
    action = `<button data-act="close" class="card-act bg-emerald-50 text-emerald-700 hover:bg-emerald-100 font-semibold">ปิดงาน ✓</button>`;
  } else {
    action = t.pdfUrl
      ? `<button data-act="pdf" class="card-act bg-slate-100 text-slate-600 hover:text-blue-700 font-medium inline-flex items-center gap-1">📄 ดูเอกสาร</button>`
      : `<button data-act="reopen" class="card-act bg-slate-100 text-slate-500 hover:text-slate-700 font-medium">↩ เปิดใหม่</button>`;
  }

  el.innerHTML = `
    <div class="flex items-start justify-between gap-2 mb-1.5">
      <span class="font-bold text-slate-700 inline-flex items-center gap-1.5 min-w-0">
        <span class="truncate">${escapeHtml(t.code)}</span>
        ${isOld ? `<span class="tk-age shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-red-100 text-red-700">ค้าง ${Math.floor(ageDays)} วัน</span>` : ''}
      </span>
      ${t.category ? `<span class="tk-cat text-[11px] px-2 py-0.5 rounded-full shrink-0 ${catColor(t.category)}">${escapeHtml(t.category)}</span>` : ''}
    </div>
    <p class="tk-detail text-sm text-slate-700 leading-snug mb-3">${escapeHtml(t.detail)}</p>
    <div class="tk-meta flex items-center justify-between gap-2 text-xs text-slate-500 border-t border-slate-100 pt-2.5">
      <span class="inline-flex items-center gap-1 min-w-0">
        <span class="shrink-0">👤</span><span class="truncate">${escapeHtml(t.assignee || t.reporter)}</span>
      </span>
      ${action}
    </div>
    ${timeLine ? `<div class="tk-time text-[11px] text-slate-400 mt-1.5 inline-flex items-center gap-1">🕒 ${timeLine}</div>` : ''}
  `;

  el.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', String(t.id));
    el.classList.add('drag-ghost');
  });
  el.addEventListener('dragend', () => el.classList.remove('drag-ghost'));

  const btn = el.querySelector('[data-act]');
  if (btn) btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const act = btn.dataset.act;
    if (act === 'accept')  moveTicket(t.id, STATUS.IN_PROGRESS);
    if (act === 'close')   requestClose(t.id);
    if (act === 'reopen')  moveTicket(t.id, STATUS.OPEN);
    if (act === 'pdf')     openPdf(t);
  });

  return el;
}

// ---------- ย้ายสถานะตั๋ว (optimistic update + revert เมื่อ backend ปฏิเสธ) ----------
// resolutionText: ใช้เฉพาะตอนปิดงาน (toStatus===CLOSED) — มาจาก closeModal ผ่าน requestClose/finishClose
async function moveTicket(id, toStatus, resolutionText) {
  const t = tickets.find(x => x.id === id);
  if (!t || t.status === toStatus) return;

  const isAccept = (t.status === STATUS.OPEN && toStatus === STATUS.IN_PROGRESS);
  if (isAccept && !currentStaffId) {
    alert('ต้องเข้าสู่ระบบ LINE ก่อนจึงจะรับงานได้');
    ensureLogin();
    return;
  }

  const prev = { status:t.status, assignee:t.assignee, acceptedAt:t.acceptedAt, closedAt:t.closedAt };
  t.status = toStatus;
  if (isAccept) { t.assignee = currentStaff; t.acceptedAt = new Date().toISOString(); }
  if (toStatus === STATUS.CLOSED) t.closedAt = new Date().toISOString();
  if (toStatus === STATUS.OPEN)   { t.assignee = null; t.acceptedAt = null; t.closedAt = null; }
  render();

  if (usingMock) return; // โหมดตัวอย่าง: ไม่ยิง backend

  try {
    const res = isAccept
      ? await callBackend('acceptTicket', { ticketId:id })   // backend รู้ผู้รับจาก idToken เอง
      : await callBackend('updateTicketStatus', { ticketId:id, status:toStatus });
    if (!res || res.status !== 'success') throw new Error(res && res.message || 'อัปเดตไม่สำเร็จ');
    // ชื่อบนการ์ดใช้ USER.Full_Name จาก DB (backend ส่งกลับมา) ไม่ใช่ชื่อ LINE
    // ไม่งั้นชื่อจะ "เปลี่ยนเอง" ตอนกดโหลดใหม่ เพราะ getTickets ก็ JOIN เอา Full_Name
    if (isAccept && res.assignee && res.assignee !== t.assignee) {
      t.assignee = res.assignee;
      render();
    }
    // อัปเดตแคชให้ตรงกับที่บันทึกจริง ไม่งั้นเปิดแอปรอบหน้าจะเห็นสถานะเก่าแวบหนึ่ง
    writeTicketCache(tickets);
    // บันทึกวิธีแก้ไขเข้า Knowledge Base — เกิดขึ้นหลังปิดงานสำเร็จเท่านั้น และไม่ทำให้
    // การปิดงาน "ล้มเหลว" ถ้าขั้นนี้พังต่อ (คนละ resource กัน แค่แจ้งเตือนเบาๆ พอ)
    if (toStatus === STATUS.CLOSED && resolutionText) {
      try {
        const kbRes = await callBackend('addKnowledgeArticle', { ticketId:id, resolutionText });   // ผู้บันทึกมาจาก idToken
        if (!kbRes || kbRes.status !== 'success') throw new Error((kbRes && kbRes.message) || 'ไม่ทราบสาเหตุ');
        kbLoaded = false;   // บังคับให้โหลดใหม่ครั้งถัดไปที่เข้าหน้า Knowledge Base
      } catch (kbErr) {
        alert('⚠️ ปิดงานสำเร็จ แต่บันทึกประวัติวิธีแก้ไขไม่สำเร็จ: ' + kbErr.message);
      }
    }
  } catch (e) {
    Object.assign(t, prev); // revert
    render();
    alert('❌ บันทึกไม่สำเร็จ: ' + e.message);
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
      if (staffProfile && staffProfile.branch) parts.push(staffProfile.branch);
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
      localStorage.setItem('ft_staff_profile', JSON.stringify(staffProfile));
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
  if (typeof liff === 'undefined' || !liff.login) return alert('โหลด LINE SDK ไม่สำเร็จ');
  if (!ftRelogin(true)) alert('เรียกหน้าเข้าสู่ระบบ LINE ไม่สำเร็จ');
}

// ---------- PDF ----------
function openPdf(t) {
  if (!t.pdfUrl) { alert('ตั๋วนี้ยังไม่มีไฟล์เอกสาร'); return; }
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
   Dashboard — คำนวณทุกอย่างฝั่ง client จาก tickets ชุดเดียวกับบอร์ด
   ============================================================================= */

// คืนชื่อจังหวัดที่รู้จักเท่านั้น ไม่งั้นคืน '' (= ไม่ระบุ)
// ปกติใช้ BRANCH.Province จาก backend ถ้าไม่มีจะเดาจากชื่อสาขา
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
    <div class="flex items-center justify-between gap-2 mb-1">
      <span class="text-xs truncate" style="color:var(--ink-2)">${escapeHtml(label)}</span>
      <span class="text-xs font-bold tabular-nums" style="color:var(--ink)">${value}</span>
    </div>
    <div class="viz-bar-track"><div class="viz-bar-fill" style="width:${pct}%;background:${color}"></div></div>`;
  return el;
}

function countBy(list, keyFn) {
  const m = new Map();
  list.forEach(t => { const k = keyFn(t); if (!k) return; m.set(k, (m.get(k) || 0) + 1); });
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

function renderDashboard() {
  const all = tickets;
  const n = all.length;
  const open = all.filter(t => t.status === STATUS.OPEN);
  const prog = all.filter(t => t.status === STATUS.IN_PROGRESS);
  const done = all.filter(t => t.status === STATUS.CLOSED);
  const pct = (k) => n ? Math.round(k / n * 100) : 0;

  $('kpiTotal').innerText = n;
  $('kpiOpen').innerText = open.length;
  $('kpiProg').innerText = prog.length;
  $('kpiDone').innerText = done.length;
  $('kpiOpenPct').innerText = `Open · ${pct(open.length)}%`;
  $('kpiProgPct').innerText = `In Progress · ${pct(prog.length)}%`;
  $('kpiDonePct').innerText = `Closed · ${pct(done.length)}%`;

  // ---- SLA ----
  const acceptGaps = all.map(t => { const a = parseT(t.acceptedAt), c = parseT(t.createdAt); return (a && c) ? a - c : null; }).filter(x => x != null);
  const closeGaps  = all.map(t => { const z = parseT(t.closedAt),   c = parseT(t.createdAt); return (z && c) ? z - c : null; }).filter(x => x != null);
  $('slaAccept').innerText = fmtDur(mean(acceptGaps));
  $('slaClose').innerText  = fmtDur(mean(closeGaps));
  $('slaAcceptNote').innerText = acceptGaps.length ? `จาก ${acceptGaps.length} ตั๋ว` : 'ยังไม่มีตั๋วที่ถูกรับเรื่อง';
  $('slaCloseNote').innerText  = closeGaps.length  ? `จาก ${closeGaps.length} ตั๋ว`  : 'ยังไม่มีตั๋วที่ปิดงาน';

  const now = Date.now();
  // agingDays ตั้งค่าได้ที่หน้า Settings (ค่าเริ่มต้น 3 วัน) — เก็บใน localStorage ต่อเบราว์เซอร์
  const aging = open.filter(t => { const c = parseT(t.createdAt); return c && (now - c) > agingDays * DAY_MS; });
  $('slaAging').innerText = aging.length;
  $('slaAgingLabel').innerText = `🔥 ค้างเกิน ${agingDays} วัน (ยังไม่รับ)`;

  // ---- หมวดหมู่ / พื้นที่ / เจ้าหน้าที่ ----
  const cats = countBy(all, t => t.category || 'ไม่ระบุ');
  const catMax = cats.length ? cats[0][1] : 0;
  const catBox = $('catBars'); catBox.innerHTML = '';
  if (!cats.length) catBox.innerHTML = `<div class="text-xs" style="color:var(--ink-muted)">ยังไม่มีข้อมูล</div>`;
  cats.forEach(([k, v]) => catBox.appendChild(barRow(k, v, catMax, cssVar('--st-prog'))));

  const provs = countBy(all, t => normProv(t.province || t.branch) || NO_PROV);
  const provMax = provs.length ? provs[0][1] : 0;
  const provBox = $('provBars'); provBox.innerHTML = '';
  if (!provs.length) provBox.innerHTML = `<div class="text-xs" style="color:var(--ink-muted)">ยังไม่มีข้อมูล</div>`;
  provs.forEach(([k, v]) => provBox.appendChild(barRow(k, v, provMax, cssVar('--st-prog'))));

  const staff = countBy(all.filter(t => t.assignee), t => t.assignee);
  const staffMax = staff.length ? staff[0][1] : 0;
  const staffBox = $('staffBars'); staffBox.innerHTML = '';
  if (!staff.length) {
    staffBox.innerHTML = `<div class="text-xs" style="color:var(--ink-muted)">ยังไม่มีตั๋วที่ถูกรับเรื่อง<br>กดปุ่ม “รับงาน” บนบอร์ดเพื่อเริ่ม</div>`;
  }
  staff.forEach(([k, v]) => staffBox.appendChild(barRow(k, v, staffMax, cssVar('--st-prog'))));

  // ---- ตั๋วค้างนาน ----
  const agingBody = $('agingBody');
  const oldest = [...open].filter(t => parseT(t.createdAt)).sort((a, b) => parseT(a.createdAt) - parseT(b.createdAt)).slice(0, 6);
  agingBody.innerHTML = oldest.length ? '' : `<tr><td colspan="4" class="py-3 text-xs" style="color:var(--ink-muted)">ไม่มีตั๋วค้าง 🎉</td></tr>`;
  oldest.forEach(t => {
    const days = (now - parseT(t.createdAt)) / DAY_MS;
    const hot = days > agingDays;
    const tr = document.createElement('tr');
    tr.className = 'border-t';
    tr.style.borderColor = 'var(--grid)';
    tr.innerHTML = `
      <td class="py-2 pr-3 font-bold whitespace-nowrap" style="color:var(--ink)">${escapeHtml(t.code)}</td>
      <td class="py-2 pr-3 sm:max-w-[22rem] truncate" style="color:var(--ink-2)">${escapeHtml(t.detail)}</td>
      <td class="py-2 pr-3 text-xs whitespace-nowrap hidden sm:table-cell" style="color:var(--ink-muted)">${escapeHtml(normProv(t.province || t.branch) || '-')}</td>
      <td class="py-2 pr-3 text-right whitespace-nowrap tabular-nums text-xs font-semibold"
          style="color:${hot ? 'var(--st-open)' : 'var(--ink-2)'}">${hot ? '🔥 ' : ''}${timeAgo(t.createdAt).replace('ที่แล้ว','').trim()}</td>`;
    agingBody.appendChild(tr);
  });

  renderTrend(all);
  renderMap(all);
}

// ---------- กราฟเส้น: ตั๋วเข้าใหม่ 30 วัน (ซีรีส์เดียว -> ไม่ต้องมี legend) ----------
function renderTrend(all) {
  const svg = $('trendChart');
  const days = 30;
  const today = new Date(); today.setHours(23, 59, 59, 999);
  const buckets = [];
  for (let i = days - 1; i >= 0; i--) {
    const end = today.getTime() - i * DAY_MS, start = end - DAY_MS;
    buckets.push({ end, n: all.filter(t => { const c = parseT(t.createdAt); return c && c > start && c <= end; }).length });
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
function renderMap(all) {
  const svg = $('provMap');
  const counts = new Map(PROVINCES.map(p => [p.key, 0]));
  all.forEach(t => { const k = normProv(t.province || t.branch); if (counts.has(k)) counts.set(k, counts.get(k) + 1); });
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
      const n = +el.dataset.n, pct = all.length ? Math.round(n / all.length * 100) : 0;
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

const MOCK_USERS = [
  { userId:'Umock-admin-001', name:'นายสองพัน แซ่ชั่น', position:'เจ้าหน้าที่ไอที', role:'admin', dept:'ส่วนเทคโนโลยีสารสนเทศ', branch:'สำนักงานสรรพสามิตภาคที่ 9', province:'สงขลา', reported:2, assigned:5 },
  { userId:'Umock-it-002', name:'วิชัย ไอที', position:'นักวิชาการคอมพิวเตอร์', role:'it', dept:'ส่วนเทคโนโลยีสารสนเทศ', branch:'สำนักงานสรรพสามิตภาคที่ 9', province:'สงขลา', reported:0, assigned:4 },
  { userId:'Umock-staff-003', name:'กัญญาภัทร ใจดี', position:'เจ้าหน้าที่ธุรการ', role:'Staff', dept:'ส่วนอำนวยการ', branch:'สาขาเมืองสงขลา', province:'สงขลา', reported:3, assigned:0 },
  { userId:'Umock-staff-004', name:'นพดล รักงาน', position:'นักตรวจสอบภาษี', role:'Staff', dept:'ส่วนบริหารจัดเก็บภาษี', branch:'สาขาหาดใหญ่', province:'สงขลา', reported:1, assigned:0 },
  { userId:'Umock-staff-005', name:'นูรีดา สาและ', position:'เจ้าหน้าที่ทั่วไป', role:'Staff', dept:'ส่วนอำนวยการ', branch:'สาขาเมืองปัตตานี', province:'ปัตตานี', reported:1, assigned:0 },
];

function normalizeUser(u) {
  return {
    userId: u.userId || '',
    name: u.name || '(ไม่มีชื่อ)',
    position: u.position || '-',
    role: roleOf(u.role),
    dept: u.dept || '',
    branch: u.branch || '',
    province: u.province || '',
    reported: Number(u.reported) || 0,
    assigned: Number(u.assigned) || 0,
  };
}

async function loadUsers() {
  await liffReady;   // ดูคอมเมนต์ที่ liffReady
  try {
    const res = await callBackend('getUsers', {});
    if (res && res.status === 'success' && Array.isArray(res.users)) {
      users = res.users.map(normalizeUser);
      usingMockUsers = false;
    } else { throw new Error((res && res.message) || 'ไม่มีข้อมูลจาก backend'); }
    setMockReason('usersMockReason', null);
    setAuthExpired(false);
  } catch (e) {
    users = MOCK_USERS.map(normalizeUser);
    usingMockUsers = true;
    setMockReason('usersMockReason', e);
    if (isAuthError(e)) setAuthExpired(true);
  }
  usersLoaded = true;
  renderUsers();
}

// สิทธิ์แก้บทบาท: เฉพาะบัญชีที่ login แล้วและมี role=admin ใน DB
// (โหมด mock เปิดให้ลองกดได้ เพราะไม่บันทึกจริงอยู่แล้ว)
// ⚠️ นี่คือ gate ระดับ UI เท่านั้น — backend ยังไม่มี auth (finding เฟส 0 ที่ค้างอยู่)
function canEditRoles() {
  if (usingMockUsers) return true;
  const me = users.find(u => u.userId === currentStaffId);
  return !!me && me.role === 'admin';
}

function roleBadge(role) {
  const r = ROLES[role] || ROLES.staff;
  return `<span class="text-[11px] px-2 py-0.5 rounded-full whitespace-nowrap ${r.badge}">${r.label}</span>`;
}

function renderUsers() {
  // KPI
  const counts = { admin:0, it:0, staff:0 };
  users.forEach(u => counts[u.role]++);
  $('usrTotal').innerText = users.length;
  $('usrAdmin').innerText = counts.admin;
  $('usrIt').innerText = counts.it;
  $('usrStaff').innerText = counts.staff;
  $('usersMockBanner').classList.toggle('hidden', !usingMockUsers);

  // role filter chips
  const chips = [['all','ทั้งหมด'], ['admin',ROLES.admin.label], ['it',ROLES.it.label], ['staff',ROLES.staff.label]];
  $('roleChips').innerHTML = chips.map(([k, label]) =>
    `<button data-role="${k}" class="px-2.5 py-1 rounded-full border transition-colors ${
      userRoleFilter === k ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
    }">${label}</button>`).join('');
  $('roleChips').querySelectorAll('button').forEach(b =>
    b.addEventListener('click', () => { userRoleFilter = b.dataset.role; renderUsers(); }));

  // filter + sort (แอดมินขึ้นก่อน แล้ว IT แล้วทั่วไป, ในกลุ่มเรียงตามชื่อ)
  const q = userSearch.trim().toLowerCase();
  const weight = { admin:0, it:1, staff:2 };
  const list = users
    .filter(u => userRoleFilter === 'all' || u.role === userRoleFilter)
    .filter(u => !q || [u.name, u.position, u.branch, u.dept].some(s => String(s).toLowerCase().includes(q)))
    .sort((a, b) => (weight[a.role] - weight[b.role]) || a.name.localeCompare(b.name, 'th'));

  const editable = canEditRoles();
  $('usersEditNote').classList.toggle('hidden', editable || !currentStaffId);

  const body = $('usersBody');
  body.innerHTML = '';
  $('usersEmpty').classList.toggle('hidden', list.length > 0);

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
          <span class="w-8 h-8 rounded-full bg-blue-600 text-white text-xs font-bold flex items-center justify-center shrink-0">${escapeHtml(u.name.trim().charAt(0) || '?')}</span>
          <div class="min-w-0">
            <div class="font-semibold truncate" style="color:var(--ink)">${escapeHtml(u.name)}${isMe ? ' <span class="text-[10px] font-normal text-blue-600">(คุณ)</span>' : ''}</div>
            <div class="text-[10px] truncate hidden lg:block" style="color:var(--ink-muted)">${escapeHtml(u.userId)}</div>
            <div class="text-[10px] truncate lg:hidden" style="color:var(--ink-muted)">${escapeHtml(u.position)}${u.branch ? ' · ' + escapeHtml(u.branch) : ''}</div>
            <div class="text-[10px] truncate sm:hidden" style="color:var(--ink-muted)">แจ้งซ่อม ${u.reported} · รับผิดชอบ ${u.assigned}</div>
            <div class="lg:hidden mt-1">${roleBadge(u.role)}</div>
          </div>
        </div>
      </td>
      <td class="py-2.5 pr-3 text-xs hidden lg:table-cell" style="color:var(--ink-2)">${escapeHtml(u.position)}</td>
      <td class="py-2.5 pr-3 text-xs hidden lg:table-cell" style="color:var(--ink-2)">
        <div class="truncate max-w-[16rem]">${escapeHtml(u.branch || '-')}</div>
        <div class="text-[10px] truncate max-w-[16rem]" style="color:var(--ink-muted)">${escapeHtml(u.dept || '')}</div>
      </td>
      <td class="py-2.5 pr-3 hidden lg:table-cell">${roleBadge(u.role)}</td>
      <td class="py-2.5 pr-3 text-right tabular-nums text-xs hidden sm:table-cell" style="color:var(--ink-2)">${u.reported}</td>
      <td class="py-2.5 pr-3 text-right tabular-nums text-xs hidden sm:table-cell" style="color:var(--ink-2)">${u.assigned}</td>
      <td class="py-2.5 pl-3 text-right">${
        editable
          ? `<select data-uid="${escapeHtml(u.userId)}" class="role-select w-full sm:w-auto border border-slate-300 rounded-lg px-2 py-1.5 sm:py-1 text-xs bg-white outline-none focus:ring-2 focus:ring-blue-500">
               ${Object.entries(ROLES).map(([k, r]) => `<option value="${k}" ${k === u.role ? 'selected' : ''}>${r.label}</option>`).join('')}
             </select>`
          : `<span class="text-[10px]" style="color:var(--ink-muted)">—</span>`
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
    ? `⚠️ กำลังลดสิทธิ์ "บัญชีของคุณเอง" เป็น ${ROLES[newRole].label} — จะแก้บทบาทใครไม่ได้อีกจนกว่าแอดมินคนอื่นจะคืนสิทธิ์ให้\n\nยืนยันหรือไม่?`
    : `เปลี่ยนบทบาทของ "${u.name}" เป็น ${ROLES[newRole].label}?`;
  if (!confirm(msg)) { renderUsers(); return; }   // วาดใหม่ให้ select เด้งกลับค่าเดิม

  const prevRole = u.role;
  u.role = newRole;         // optimistic
  renderUsers();

  if (usingMockUsers) return;   // โหมดตัวอย่าง: ไม่ยิง backend

  try {
    const res = await callBackend('updateUserRole', { userId, role: newRole });
    if (!res || res.status !== 'success') throw new Error((res && res.message) || 'อัปเดตไม่สำเร็จ');
  } catch (e) {
    u.role = prevRole;      // revert
    renderUsers();
    alert('❌ เปลี่ยนบทบาทไม่สำเร็จ: ' + e.message);
  }
}

/* =============================================================================
   Knowledge Base — บทความถูกสร้างอัตโนมัติตอนปิดงานพร้อมกรอกวิธีแก้ไข (ดู moveTicket)
   ============================================================================= */

const MOCK_KB = [
  { id:1, ticketId:118, ticketCode:'TK-118', category:'เครือข่าย', detail:'เปลี่ยนสาย LAN ใหม่', resolution:'สาย LAN เส้นเดิมชำรุดจากการงอพับ เปลี่ยนเป็นสาย Cat6 เส้นใหม่และทดสอบความเร็วผ่าน speedtest ภายในแล้วปกติ', author:'สมคิด ไอที', createdAt:hrsAgo(24) },
  { id:2, ticketId:119, ticketCode:'TK-119', category:'ซอฟต์แวร์', detail:'อีเมลส่งออกไม่ได้', resolution:'พบว่ากล่องขาออกเต็มโควตา (quota) ให้ลบไฟล์แนบเก่าที่ไม่ใช้แล้วและตั้งค่าเลี่ยงแนบไฟล์ใหญ่ผ่านอีเมลโดยตรง', author:'วิชัย ไอที', createdAt:hrsAgo(50) },
  { id:3, ticketId:115, ticketCode:'TK-115', category:'ฮาร์ดแวร์', detail:'ตั้งค่าแชร์ปริ้นเตอร์', resolution:'ติดตั้งไดรเวอร์ปริ้นเตอร์รุ่นที่ตรงกับ Windows 11 ใหม่ แล้วแชร์ผ่านเครื่อง server กลางแทนเครื่องเดิมที่ปิดเครื่องบ่อย', author:'วิชัย ไอที', createdAt:hrsAgo(26) },
];

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

async function loadKB() {
  await liffReady;   // ดูคอมเมนต์ที่ liffReady
  try {
    const res = await callBackend('getKnowledgeBase', {});
    if (res && res.status === 'success' && Array.isArray(res.articles)) {
      kbArticles = res.articles.map(normalizeKb);
      usingMockKb = false;
    } else { throw new Error((res && res.message) || 'ไม่มีข้อมูลจาก backend'); }
    setMockReason('kbMockReason', null);
    setAuthExpired(false);
  } catch (e) {
    kbArticles = MOCK_KB.map(normalizeKb);
    usingMockKb = true;
    setMockReason('kbMockReason', e);
    if (isAuthError(e)) setAuthExpired(true);
  }
  kbLoaded = true;
  renderKB();
}

function renderKB() {
  $('kbMockBanner').classList.toggle('hidden', !usingMockKb);

  // ชิพหมวดหมู่ — สร้างจากหมวดหมู่ที่ปรากฏจริงในบทความ ไม่ hardcode
  const cats = ['all', ...new Set(kbArticles.map(a => a.category))];
  $('kbCatChips').innerHTML = cats.map(c => {
    const label = c === 'all' ? 'ทั้งหมด' : c;
    const active = kbCatFilter === c;
    return `<button data-cat="${escapeHtml(c)}" class="px-2.5 py-1 rounded-full border transition-colors ${
      active ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
    }">${escapeHtml(label)}</button>`;
  }).join('');
  $('kbCatChips').querySelectorAll('button').forEach(b =>
    b.addEventListener('click', () => { kbCatFilter = b.dataset.cat; renderKB(); }));

  const q = kbSearch.trim().toLowerCase();
  const list = kbArticles
    .filter(a => kbCatFilter === 'all' || a.category === kbCatFilter)
    .filter(a => !q || [a.detail, a.resolution, a.ticketCode].some(s => String(s).toLowerCase().includes(q)))
    .sort((a, b) => (parseT(b.createdAt) || 0) - (parseT(a.createdAt) || 0));

  const box = $('kbList');
  box.innerHTML = '';
  $('kbEmpty').classList.toggle('hidden', kbArticles.length > 0);

  list.forEach(a => {
    const el = document.createElement('div');
    el.className = 'border rounded-lg p-3.5';
    el.style.borderColor = 'var(--grid)';
    el.innerHTML = `
      <div class="flex items-start justify-between gap-2 mb-1.5">
        <div class="flex items-center gap-2 flex-wrap">
          <span class="font-bold text-sm" style="color:var(--ink)">${escapeHtml(a.ticketCode)}</span>
          <span class="text-[11px] px-2 py-0.5 rounded-full ${catColor(a.category)}">${escapeHtml(a.category)}</span>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          ${a.pdfUrl ? `<button data-pdf="${a.id}" class="text-xs text-blue-600 hover:underline whitespace-nowrap">📄 เอกสารต้นฉบับ</button>` : ''}
          <button data-edit="${a.id}" class="text-xs text-slate-500 hover:text-blue-600 min-h-[32px] px-1.5" title="แก้ไข">✏️</button>
          <button data-del="${a.id}" class="text-xs text-slate-500 hover:text-red-600 min-h-[32px] px-1.5" title="ลบ">🗑️</button>
        </div>
      </div>
      ${a.detail ? `<div class="text-xs mb-1.5" style="color:var(--ink-muted)">อาการ: ${escapeHtml(a.detail)}</div>` : ''}
      <p class="text-sm leading-relaxed whitespace-pre-wrap" style="color:var(--ink-2)">${escapeHtml(a.resolution)}</p>
      <div class="text-[11px] mt-2" style="color:var(--ink-muted)">บันทึกโดย ${escapeHtml(a.author)} · ${timeAgo(a.createdAt)}</div>
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
  if (!text) { alert('วิธีแก้ไขปัญหาห้ามว่าง'); return; }

  // optimistic update
  const a = kbArticles.find(x => x.id === kbId);
  const prevText = a ? a.resolution : '';
  if (a) a.resolution = text;
  cancelKbEdit();
  renderKB();

  if (usingMockKb) return;

  try {
    const res = await callBackend('updateKnowledgeArticle', { kbId, resolutionText: text });
    if (!res || res.status !== 'success') throw new Error((res && res.message) || 'อัปเดตไม่สำเร็จ');
  } catch (e) {
    if (a) a.resolution = prevText;  // revert
    renderKB();
    alert('❌ แก้ไขบทความไม่สำเร็จ: ' + e.message);
  }
}

// ---------- ลบบทความ KB ----------
async function deleteKbArticle(article) {
  if (!confirm(`ลบประวัติ ${article.ticketCode} ออกจากรายการ?\n\nตั๋วต้นฉบับจะไม่ถูกกระทบ แต่วิธีแก้ไขปัญหานี้จะหายไปถาวร`)) return;

  // optimistic remove
  const idx = kbArticles.findIndex(x => x.id === article.id);
  const removed = idx >= 0 ? kbArticles.splice(idx, 1)[0] : null;
  renderKB();

  if (usingMockKb) return;

  try {
    const res = await callBackend('deleteKnowledgeArticle', { kbId: article.id });
    if (!res || res.status !== 'success') throw new Error((res && res.message) || 'ลบไม่สำเร็จ');
  } catch (e) {
    if (removed && idx >= 0) kbArticles.splice(idx, 0, removed);  // revert
    renderKB();
    alert('❌ ลบบทความไม่สำเร็จ: ' + e.message);
  }
}

/* =============================================================================
   ข้อมูลหลัก (Master Data) — พื้นที่ (BRANCH) · สาขา (DEPARTMENT) · หมวดหมู่ (ISSUE_CATEGORY)
   ไม่มีข้อมูลจำลอง: ถ้าโหลดไม่ได้ให้เห็นว่าว่าง ดีกว่าแก้ของปลอมแล้วคิดว่าบันทึกแล้ว
   ไม่ทำ optimistic update — แก้นานๆ ครั้ง และ backend อาจปฏิเสธ (ชื่อซ้ำ/ยังถูกใช้อยู่)
   ============================================================================= */
const MASTER_TYPES = {
  branch:   { label: 'พื้นที่',       key: 'branches' },
  dept:     { label: 'สาขา',         key: 'depts' },
  category: { label: 'หมวดหมู่ปัญหา', key: 'categories' },
};
let masterData = { branches: [], depts: [], categories: [] };
let masterLoaded = false;
let masterTab = 'branch';
let masterEditing = null;   // { type, id } — id = null คือเพิ่มใหม่

async function loadMaster() {
  await liffReady;
  $('masterList').innerHTML = '<div class="py-6 text-center text-xs" style="color:var(--ink-muted)">กำลังโหลด...</div>';
  try {
    const res = await callBackend('getMasterData', { withUsage: true });
    if (!res || res.status !== 'success') throw new Error((res && res.message) || 'ไม่มีข้อมูลจาก backend');
    masterData = { branches: res.branches || [], depts: res.depts || [], categories: res.categories || [] };
    $('masterErrorBanner').classList.add('hidden');
    setAuthExpired(false);
  } catch (e) {
    masterData = { branches: [], depts: [], categories: [] };
    $('masterErrorReason').innerText = 'สาเหตุ: ' + e.message;
    $('masterErrorBanner').classList.remove('hidden');
    if (isAuthError(e)) setAuthExpired(true);
  }
  masterLoaded = true;
  renderMaster();
}

// "ตั๋วแจ้งซ่อม 1 · สาขา 3" — ยอดรวมเดียวอ่านแล้วนึกว่าเป็นจำนวนตั๋ว
const usageText = (r) => (r.usedBy && r.usedBy.length)
  ? r.usedBy.map(u => u.label + ' ' + u.n).join(' · ')
  : (r.used ? 'ใช้อยู่ ' + r.used : 'ยังไม่ถูกใช้');

const branchName = (id) => (masterData.branches.find(b => b.id === id) || {}).name || '(ไม่พบพื้นที่ #' + id + ')';

function renderMaster() {
  document.querySelectorAll('.master-tab').forEach(b => {
    const on = b.dataset.tab === masterTab;
    b.className = 'master-tab px-3 py-1.5 rounded-full border transition-colors ' +
      (on ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50');
    b.innerText = MASTER_TYPES[b.dataset.tab].label + ' (' + masterData[MASTER_TYPES[b.dataset.tab].key].length + ')';
  });
  $('masterAddLabel').innerText = MASTER_TYPES[masterTab].label;

  let rows = masterData[MASTER_TYPES[masterTab].key];
  // สาขาเรียงตามพื้นที่ก่อน จะได้อ่านเป็นกลุ่มเหมือนในฟอร์มแจ้งซ่อม
  if (masterTab === 'dept') rows = [...rows].sort((a, b) => (a.branchId - b.branchId) || (a.id - b.id));

  $('masterEmpty').classList.toggle('hidden', rows.length > 0);
  const box = $('masterList');
  box.innerHTML = '';
  rows.forEach(r => {
    const sub = masterTab === 'branch' ? (r.province ? 'จังหวัด' + r.province : '')
              : masterTab === 'dept'   ? branchName(r.branchId) : '';
    const el = document.createElement('div');
    el.className = 'flex items-center gap-3 py-2.5';
    el.innerHTML = `
      <span class="text-[11px] w-8 shrink-0 text-right tabular-nums" style="color:var(--ink-muted)">#${r.id}</span>
      <div class="min-w-0 flex-1">
        <div class="text-sm truncate" style="color:var(--ink)">${escapeHtml(r.name || '(ไม่มีชื่อ)')}</div>
        ${sub ? `<div class="text-[11px] truncate" style="color:var(--ink-muted)">${escapeHtml(sub)}</div>` : ''}
      </div>
      <span class="text-[11px] shrink-0 text-right max-w-[40%]" style="color:var(--ink-muted)">${escapeHtml(usageText(r))}</span>
      <button data-act="edit" class="text-xs text-slate-500 hover:text-blue-600 min-h-[36px] px-1.5 shrink-0" title="แก้ไข">✏️</button>
      <button data-act="del" class="text-xs min-h-[36px] px-1.5 shrink-0 ${r.used ? 'opacity-30 cursor-not-allowed' : 'text-slate-500 hover:text-red-600'}"
              title="${r.used ? 'ลบไม่ได้ — ยังถูกใช้อยู่' : 'ลบ'}">🗑️</button>`;
    el.querySelector('[data-act="edit"]').addEventListener('click', () => openMasterModal(masterTab, r));
    el.querySelector('[data-act="del"]').addEventListener('click', () => deleteMaster(masterTab, r));
    box.appendChild(el);
  });
}

function openMasterModal(type, row) {
  masterEditing = { type, id: row ? row.id : null };
  const label = MASTER_TYPES[type].label;
  $('masterModalTitle').innerText = (row ? '✏️ แก้ไข' : '＋ เพิ่ม') + label;
  $('masterModalSub').innerText = row && row.used
    ? `ถูกใช้อยู่ใน ${usageText(row)} — ชื่อที่แก้จะมีผลกับข้อมูลเดิมทั้งหมดด้วย`
    : 'จะแสดงเป็นตัวเลือกในฟอร์มแจ้งซ่อม';
  $('masterName').value = row ? row.name : '';
  $('masterProvinceRow').classList.toggle('hidden', type !== 'branch');
  $('masterProvince').value = row && type === 'branch' ? row.province : '';
  $('masterBranchRow').classList.toggle('hidden', type !== 'dept');
  if (type === 'dept') {
    $('masterBranch').innerHTML = '<option value="">-- เลือกพื้นที่ --</option>' +
      masterData.branches.map(b => `<option value="${b.id}">${escapeHtml(b.name)}</option>`).join('');
    $('masterBranch').value = row ? String(row.branchId) : '';
  }
  $('masterFormError').classList.add('hidden');
  $('masterModal').classList.remove('hidden');
  $('masterName').focus();
}

function closeMasterModal() {
  $('masterModal').classList.add('hidden');
  masterEditing = null;
}

async function saveMaster() {
  if (!masterEditing || $('masterSaveBtn').disabled) return;   // กด Enter ซ้ำระหว่างรอ = เพิ่มซ้ำ
  const { type, id } = masterEditing;
  const item = { name: $('masterName').value.trim() };
  if (type === 'branch') item.province = $('masterProvince').value.trim();
  if (type === 'dept')   item.branchId = parseInt($('masterBranch').value, 10) || null;

  const showErr = (msg) => { $('masterFormError').innerText = msg; $('masterFormError').classList.remove('hidden'); };
  if (!item.name) return showErr('กรุณากรอกชื่อ');
  if (type === 'dept' && !item.branchId) return showErr('กรุณาเลือกพื้นที่');

  const btn = $('masterSaveBtn');
  btn.disabled = true;
  btn.innerText = 'กำลังบันทึก...';
  try {
    const res = await callBackend(id ? 'updateMasterItem' : 'addMasterItem', { type, id, item });
    if (!res || res.status !== 'success') throw new Error((res && res.message) || 'บันทึกไม่สำเร็จ');
    closeMasterModal();
    await loadMaster();
  } catch (e) {
    showErr('❌ ' + e.message);
    if (isAuthError(e)) setAuthExpired(true);
  } finally {
    btn.disabled = false;
    btn.innerText = 'บันทึก';
  }
}

async function deleteMaster(type, row) {
  const label = MASTER_TYPES[type].label;
  if (row.used) {
    alert(`ลบ${label} "${row.name}" ไม่ได้ เพราะยังถูกใช้อยู่ใน ${usageText(row)}\n\nข้อมูลเดิม (ตั๋ว/ผู้ใช้) ต้องยังแสดงชื่อได้ถูกต้อง แก้ชื่อแทนได้`);
    return;
  }
  if (!confirm(`ลบ${label} "${row.name}"?\n\nจะหายจากตัวเลือกในฟอร์มแจ้งซ่อมทันที`)) return;
  try {
    const res = await callBackend('deleteMasterItem', { type, id: row.id });
    if (!res || res.status !== 'success') throw new Error((res && res.message) || 'ลบไม่สำเร็จ');
    await loadMaster();
  } catch (e) {
    alert('❌ ' + e.message);
    if (isAuthError(e)) setAuthExpired(true);
  }
}

/* =============================================================================
   Settings — บัญชีของฉัน + ค่าตั้งต้นของแดชบอร์ด (เก็บใน localStorage ล้วนๆ)
   ============================================================================= */

function renderSettings() {
  // บัญชีของฉัน: ใช้ role จาก users ถ้าโหลดแล้ว ไม่งั้นโชว์แค่ชื่อ/userId ที่มีจาก LIFF
  const me = users.find(u => u.userId === currentStaffId);
  const box = $('settingsAccountBox');
  if (!currentStaffId) {
    box.innerHTML = `
      <div class="text-sm" style="color:var(--ink-2)">ยังไม่ได้เข้าสู่ระบบ LINE</div>
      ${liffError ? `<div class="text-xs mt-1 text-red-600 break-words">สาเหตุ: ${escapeHtml(liffError)}</div>` : ''}
      <button id="settingsLoginBtn" class="mt-2 px-3 py-1.5 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700">เข้าสู่ระบบ LINE</button>
    `;
    $('settingsLoginBtn').addEventListener('click', ensureLogin);
    return;
  }
  const displayName = (staffProfile && staffProfile.name) || currentStaff || '-';
  const avatarHtml = staffPicUrl
    ? `<img src="${escapeHtml(staffPicUrl)}" alt="" class="w-12 h-12 rounded-full object-cover shrink-0">`
    : `<span class="w-12 h-12 rounded-full bg-blue-600 text-white text-sm font-bold flex items-center justify-center shrink-0">${escapeHtml(displayName.trim().charAt(0) || '?')}</span>`;
  const sp = staffProfile || {};
  const role = me ? me.role : (sp.role ? roleOf(sp.role) : null);
  const infoParts = [sp.position, sp.dept, sp.branch].filter(Boolean);
  box.innerHTML = `
    <div class="flex items-center gap-3">
      ${avatarHtml}
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2 flex-wrap">
          <span class="font-semibold truncate" style="color:var(--ink)">${escapeHtml(displayName)}</span>
          ${role ? roleBadge(role) : ''}
        </div>
        ${infoParts.length ? `<div class="text-xs truncate mt-0.5" style="color:var(--ink-2)">${escapeHtml(infoParts.join(' · '))}</div>` : ''}
        <div class="text-[10px] truncate mt-0.5" style="color:var(--ink-muted)">LINE: ${escapeHtml(currentStaffId)}</div>
      </div>
    </div>
    <button id="settingsLogoutBtn" class="mt-3 px-3 py-1.5 rounded-lg text-sm font-medium border border-slate-300 text-slate-600 hover:bg-slate-50">ออกจากระบบ</button>
  `;
  $('settingsLogoutBtn').addEventListener('click', doLogout);
}

function doLogout() {
  if (!confirm('ออกจากระบบ LINE บนเบราว์เซอร์นี้?')) return;
  localStorage.removeItem('ft_staff');
  localStorage.removeItem('ft_staff_id');
  localStorage.removeItem('ft_staff_pic');
  localStorage.removeItem('ft_staff_profile');
  clearTicketCache();   // ตั๋วที่แคชไว้เป็นข้อมูลของหน่วยงาน ห้ามค้างให้คนถัดไปเห็น
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
    if (currentView === 'dashboard' || !$('viewDashboard').classList.contains('hidden')) renderDashboard();
    // บอร์ดใช้ค่านี้ตัดสินว่าการ์ดไหน "ค้าง" ด้วย (ขีดแดง + ป้ายค้าง N วัน)
    // ต้องวาดใหม่ทันทีแม้ตอนนี้จะอยู่หน้าตั้งค่า ไม่งั้นพอสลับกลับไปบอร์ดจะเห็นเกณฑ์เก่า
    // (switchView ไม่ได้เรียก render() ตอนกลับเข้าบอร์ด)
    if (tickets.length) render();
  });
}

/* =============================================================================
   View switching + Init
   ============================================================================= */

function switchView(v) {
  if (!VIEWS[v]) v = 'board';   // กันค่าเพี้ยนใน localStorage (เช่นจากเวอร์ชันอนาคต) ทำหน้า crash
  currentView = v;
  $('viewBoard').classList.toggle('hidden', v !== 'board');
  $('boardTools').classList.toggle('hidden', v !== 'board');   // แถบกรองอยู่นอก #viewBoard ต้องซ่อนเอง
  $('viewDashboard').classList.toggle('hidden', v !== 'dashboard');
  $('viewKB').classList.toggle('hidden', v !== 'kb');
  $('viewUsers').classList.toggle('hidden', v !== 'users');
  $('viewMaster').classList.toggle('hidden', v !== 'master');
  $('viewSettings').classList.toggle('hidden', v !== 'settings');
  $('viewTitle').innerText = VIEWS[v].title;
  $('viewSubtitle').innerText = VIEWS[v].sub;
  document.querySelectorAll('.nav-item').forEach(a => a.classList.toggle('active', a.dataset.view === v));
  localStorage.setItem('ft_view', v);
  if (v === 'dashboard') renderDashboard();  // วาดใหม่ตอนแสดงเสมอ ให้ตัวเลข/ขนาด svg สดล่าสุด
  if (v === 'kb')        { kbLoaded    ? renderKB()    : loadKB(); }     // โหลดครั้งแรกตอนเข้าหน้า
  if (v === 'users')     { usersLoaded ? renderUsers() : loadUsers(); }  // โหลดครั้งแรกตอนเข้าหน้า
  if (v === 'master')    { masterLoaded ? renderMaster() : loadMaster(); }
  if (v === 'settings')  renderSettings();
}

// ---------- Events ----------
document.querySelectorAll('.nav-item').forEach(a =>
  a.addEventListener('click', () => switchView(a.dataset.view)));
$('staffBtn').addEventListener('click', () => { if (!currentStaffId) ensureLogin(); });
// โหลดใหม่ตาม view ที่เปิดอยู่ (users/kb แยกชุดข้อมูลจากตั๋ว)
$('refreshBtn').addEventListener('click', () => {
  if (currentView === 'users') return loadUsers();
  if (currentView === 'kb')    return loadKB();
  if (currentView === 'master') return loadMaster();
  loadTickets();
});
$('pdfClose').addEventListener('click', closePdf);
$('pdfModal').addEventListener('click', (e) => { if (e.target === $('pdfModal')) closePdf(); });
$('userSearch').addEventListener('input', (e) => { userSearch = e.target.value; renderUsers(); });
$('kbSearchInput').addEventListener('input', (e) => { kbSearch = e.target.value; renderKB(); });
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
  if (masterTab === 'dept' && !masterData.branches.length) return alert('ต้องมีพื้นที่อย่างน้อย 1 รายการก่อนเพิ่มสาขา');
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
    if (currentView === 'dashboard' && tickets.length) renderDashboard();
  }, 200);
});

// ---------- Init ----------
// ถ้า currentView เป็น view ที่ผลลัพธ์ขึ้นกับตัวตน (settings แสดงบัญชี, users มีปุ่มแก้บทบาท)
// ต้องวาดใหม่หลัง LIFF login resolve เสร็จ ไม่งั้นค้างสถานะ "ยังไม่ login" ทั้งที่ล็อกอินแล้ว
function refreshIdentityDependentViews() {
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
      currentStaffId = (p && p.userId) || tok.sub || '';   // ค่านี้แหละที่ลง IT_In_Charge ได้จริง
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

async function init() {
  setStaffUI();
  initSettingsForm();
  initBoardTools();
  $('authReloginBtn')?.addEventListener('click', ensureLogin);
  liffReady = setupLiff();   // เริ่ม login ทันที แต่ไม่บล็อกการวาดหน้า — loadX() จะ await เอง
  switchView(localStorage.getItem('ft_view') || 'board');   // จำ view ล่าสุดที่เปิดไว้
  if (await liffReady) loadTickets();
}
init();
