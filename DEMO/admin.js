/* =============================================================================
   FAST TICKET · admin.js — Task Board (Kanban) + Dashboard
   -----------------------------------------------------------------------------
   ต้องโหลดหลัง: config.js, common.js, map-data.js

   API contract (ฝั่ง GAS — ดู gas-admin-handlers.gs):
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

const VIEWS = {
  dashboard: { title:'แดชบอร์ด (Dashboard)', sub:'ภาพรวมงานแจ้งซ่อม · คำนวณจากตั๋วทั้งหมด' },
  board:     { title:'ตารางงาน IT Support (Task Board)', sub:'จัดการคิวงานแบบ Kanban · ลากการ์ดเพื่อเปลี่ยนสถานะ' },
};

const SEQ = ['--seq-1','--seq-2','--seq-3','--seq-4'];   // ramp 4 ขั้นของแผนที่ (0 ตั๋วใช้ --seq-0)
const NO_PROV = 'ไม่ระบุพื้นที่';
const DAY_MS = 86400000;

const catColor = (c) => ({
  'ฮาร์ดแวร์':'bg-orange-100 text-orange-700',
  'ซอฟต์แวร์':'bg-blue-100 text-blue-700',
  'เครือข่าย':'bg-purple-100 text-purple-700'
}[c] || 'bg-slate-100 text-slate-600');

const cssVar = (n) => getComputedStyle(document.body).getPropertyValue(n).trim();

// ---------- สถานะของหน้า ----------
let tickets = [];
let usingMock = false;
// ตัวตนเจ้าหน้าที่มาจาก LINE login เท่านั้น (เหตุผลดู contract ด้านบน)
let currentStaff   = localStorage.getItem('ft_staff') || '';      // ชื่อสำหรับแสดงผล
let currentStaffId = localStorage.getItem('ft_staff_id') || '';   // LINE userId ที่ส่งให้ backend

const callBackend = (action, data) => ftCallBackend(action, data);

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
  $('boardLoading')?.classList.remove('hidden');
  try {
    const res = await callBackend('getTickets', {});
    if (res && res.status === 'success' && Array.isArray(res.tickets)) {
      tickets = res.tickets.map(normalize);
      usingMock = false;
    } else { throw new Error('ไม่มีข้อมูลจาก backend'); }
  } catch (e) {
    tickets = MOCK.map(normalize);
    usingMock = true;
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

function render() {
  const board = $('board');
  board.innerHTML = '';
  for (const col of COLUMNS) {
    const items = tickets.filter(t => t.status === col.status);
    const colEl = document.createElement('div');
    colEl.className = 'w-[320px] shrink-0 flex flex-col rounded-xl border border-slate-200 ' + col.body;
    colEl.dataset.status = col.status;

    colEl.innerHTML = `
      <div class="flex items-center justify-between px-4 py-3 shrink-0">
        <div class="flex items-center gap-2 font-semibold ${col.head}">
          <span class="w-2.5 h-2.5 rounded-full ${col.dot}"></span>${col.title}
          <span class="text-slate-400 font-normal text-sm">(${col.en})</span>
        </div>
        <span class="text-sm font-bold text-slate-400">${items.length}</span>
      </div>
      <div class="col-scroll flex-1 overflow-y-auto px-3 pb-3 flex flex-col gap-3" data-drop="${col.status}"></div>
    `;
    const list = colEl.querySelector('[data-drop]');
    items.forEach(t => list.appendChild(cardEl(t)));

    // drag targets
    list.addEventListener('dragover', (e) => { e.preventDefault(); colEl.classList.add('col-over'); });
    list.addEventListener('dragleave', () => colEl.classList.remove('col-over'));
    list.addEventListener('drop', (e) => {
      e.preventDefault(); colEl.classList.remove('col-over');
      const id = Number(e.dataTransfer.getData('text/plain'));
      moveTicket(id, col.status);
    });
    board.appendChild(colEl);
  }
  // บอร์ดกับแดชบอร์ดใช้ tickets ชุดเดียวกัน — แต่วาดแดชบอร์ดเฉพาะตอนที่มองเห็น
  // (switchView จะวาดใหม่เสมอเมื่อสลับมา จึงไม่มีทางเห็นข้อมูลเก่า)
  if (!$('viewDashboard').classList.contains('hidden')) renderDashboard();
}

function cardEl(t) {
  const el = document.createElement('div');
  el.className = 'card-drag bg-white rounded-lg border border-slate-200 p-3.5 shadow-sm hover:shadow-md transition-shadow';
  el.draggable = true;
  el.dataset.id = t.id;

  const timeLine = t.status === STATUS.CLOSED
    ? (t.closedAt ? `ปิดงาน: ${timeAgo(t.closedAt)}` : '')
    : (t.status === STATUS.IN_PROGRESS && t.acceptedAt ? `เริ่ม: ${timeAgo(t.acceptedAt)}` : `แจ้ง: ${timeAgo(t.createdAt)}`);

  // ปุ่มตามคอลัมน์
  let action = '';
  if (t.status === STATUS.OPEN) {
    action = `<button data-act="accept" class="text-blue-600 hover:text-blue-800 font-semibold">รับงาน →</button>`;
  } else if (t.status === STATUS.IN_PROGRESS) {
    action = `<button data-act="close" class="text-emerald-600 hover:text-emerald-800 font-semibold">ปิดงาน ✓</button>`;
  } else {
    action = t.pdfUrl
      ? `<button data-act="pdf" class="text-slate-600 hover:text-blue-700 font-medium inline-flex items-center gap-1">📄 ดูเอกสาร</button>`
      : `<button data-act="reopen" class="text-slate-400 hover:text-slate-600 font-medium">↩ เปิดใหม่</button>`;
  }

  el.innerHTML = `
    <div class="flex items-start justify-between gap-2 mb-1.5">
      <span class="font-bold text-slate-700">${escapeHtml(t.code)}</span>
      ${t.category ? `<span class="text-[11px] px-2 py-0.5 rounded-full ${catColor(t.category)}">${escapeHtml(t.category)}</span>` : ''}
    </div>
    <p class="text-sm text-slate-700 leading-snug mb-3">${escapeHtml(t.detail)}</p>
    <div class="flex items-center justify-between text-xs text-slate-500 border-t border-slate-100 pt-2.5">
      <span class="inline-flex items-center gap-1 truncate max-w-[55%]">
        👤 ${escapeHtml(t.assignee || t.reporter)}
      </span>
      ${action}
    </div>
    ${timeLine ? `<div class="text-[11px] text-slate-400 mt-1.5 inline-flex items-center gap-1">🕒 ${timeLine}</div>` : ''}
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
    if (act === 'close')   moveTicket(t.id, STATUS.CLOSED);
    if (act === 'reopen')  moveTicket(t.id, STATUS.OPEN);
    if (act === 'pdf')     openPdf(t);
  });

  return el;
}

// ---------- ย้ายสถานะตั๋ว (optimistic update + revert เมื่อ backend ปฏิเสธ) ----------
async function moveTicket(id, toStatus) {
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
      ? await callBackend('acceptTicket', { ticketId:id, staffUserId:currentStaffId })
      : await callBackend('updateTicketStatus', { ticketId:id, status:toStatus });
    if (!res || res.status !== 'success') throw new Error(res && res.message || 'อัปเดตไม่สำเร็จ');
    // ชื่อบนการ์ดใช้ USER.Full_Name จาก DB (backend ส่งกลับมา) ไม่ใช่ชื่อ LINE
    // ไม่งั้นชื่อจะ "เปลี่ยนเอง" ตอนกดโหลดใหม่ เพราะ getTickets ก็ JOIN เอา Full_Name
    if (isAccept && res.assignee && res.assignee !== t.assignee) {
      t.assignee = res.assignee;
      render();
    }
  } catch (e) {
    Object.assign(t, prev); // revert
    render();
    alert('❌ บันทึกไม่สำเร็จ: ' + e.message);
  }
}

// ---------- เจ้าหน้าที่ปัจจุบัน (ตัวตนมาจาก LINE เท่านั้น) ----------
function setStaffUI() {
  if (currentStaff) {
    $('staffName').innerText = currentStaff;
    $('staffName').classList.replace('text-slate-600','text-slate-800');
    $('staffAvatar').innerText = currentStaff.trim().charAt(0) || '?';
  } else {
    $('staffName').innerText = 'เข้าสู่ระบบ LINE';
    $('staffAvatar').innerText = '?';
  }
}

// พาไปหน้าเข้าสู่ระบบ LINE (ใช้ได้ทั้งในแอป LINE และเบราว์เซอร์เดสก์ท็อป)
// ต้องส่ง redirectUri = หน้าปัจจุบัน ไม่งั้น LINE จะพากลับไปที่ endpoint ของ LIFF app
// ซึ่งตอน fallback เป็น MY_LIFF_ID จะชี้ index.html -> หลุดไปหน้าแจ้งซ่อม
function ensureLogin() {
  try {
    if (typeof liff !== 'undefined' && liff.login) {
      liff.login({ redirectUri: location.href });
    } else {
      alert('โหลด LINE SDK ไม่สำเร็จ');
    }
  } catch (e) {
    alert('เรียกหน้าเข้าสู่ระบบ LINE ไม่สำเร็จ: ' + e.message);
  }
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
  const aging = open.filter(t => { const c = parseT(t.createdAt); return c && (now - c) > 3 * DAY_MS; });
  $('slaAging').innerText = aging.length;

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
    const hot = days > 3;
    const tr = document.createElement('tr');
    tr.className = 'border-t';
    tr.style.borderColor = 'var(--grid)';
    tr.innerHTML = `
      <td class="py-2 pr-3 font-bold whitespace-nowrap" style="color:var(--ink)">${escapeHtml(t.code)}</td>
      <td class="py-2 pr-3 max-w-[22rem] truncate" style="color:var(--ink-2)">${escapeHtml(t.detail)}</td>
      <td class="py-2 pr-3 text-xs whitespace-nowrap" style="color:var(--ink-muted)">${escapeHtml(normProv(t.province || t.branch) || '-')}</td>
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
  const W = 640, H = 170, L = 34, R = 8, T = 12, B = 26;
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
    r.addEventListener('mouseenter', () => {
      const b = buckets[+r.dataset.i], d = new Date(b.end);
      tip.innerHTML = `${d.getDate()}/${d.getMonth() + 1} · <b>${b.n}</b> ตั๋ว`;
      tip.classList.remove('hidden');
      const box = svg.getBoundingClientRect();
      tip.style.left = (box.width * (px(+r.dataset.i) / W)) + 'px';
      tip.style.top  = (box.height * (py(b.n) / H)) + 'px';
    });
    r.addEventListener('mouseleave', () => tip.classList.add('hidden'));
  });
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
    el.addEventListener('mousemove', (e) => {
      const n = +el.dataset.n, pct = all.length ? Math.round(n / all.length * 100) : 0;
      tip.innerHTML = `${escapeHtml(el.dataset.prov)} · <b>${n}</b> ตั๋ว (${pct}%)`;
      tip.classList.remove('hidden');
      const box = svg.parentElement.getBoundingClientRect();
      tip.style.left = (e.clientX - box.left) + 'px';
      tip.style.top  = (e.clientY - box.top) + 'px';
    });
    el.addEventListener('mouseleave', () => tip.classList.add('hidden'));
  });
}

/* =============================================================================
   View switching + Init
   ============================================================================= */

function switchView(v) {
  if (!VIEWS[v]) v = 'board';   // กันค่าเพี้ยนใน localStorage (เช่นจากเวอร์ชันอนาคต) ทำหน้า crash
  $('viewBoard').classList.toggle('hidden', v !== 'board');
  $('viewDashboard').classList.toggle('hidden', v !== 'dashboard');
  $('viewTitle').innerText = VIEWS[v].title;
  $('viewSubtitle').innerText = VIEWS[v].sub;
  document.querySelectorAll('.nav-item').forEach(a => a.classList.toggle('active', a.dataset.view === v));
  localStorage.setItem('ft_view', v);
  if (v === 'dashboard') renderDashboard();  // วาดใหม่ตอนแสดงเสมอ ให้ตัวเลข/ขนาด svg สดล่าสุด
}

// ---------- Events ----------
document.querySelectorAll('.nav-item').forEach(a =>
  a.addEventListener('click', () => switchView(a.dataset.view)));
$('staffBtn').addEventListener('click', () => { if (!currentStaffId) ensureLogin(); });
$('refreshBtn').addEventListener('click', loadTickets);
$('pdfClose').addEventListener('click', closePdf);
$('pdfModal').addEventListener('click', (e) => { if (e.target === $('pdfModal')) closePdf(); });
document.querySelectorAll('[data-soon]').forEach(a =>
  a.addEventListener('click', () => alert('โมดูลนี้อยู่ในเฟสถัดไป — ตอนนี้เปิด Dashboard และ IT Task Board')));

// ---------- Init ----------
async function init() {
  setStaffUI();
  switchView(localStorage.getItem('ft_view') || 'board');   // จำ view ล่าสุดที่เปิดไว้
  // ระบุตัวจาก LINE — ใช้ LIFF app ตัวที่ 2 (ADMIN_LIFF_ID, endpoint = admin.html)
  // ถ้ายังไม่ได้ตั้ง จะ fallback เป็น MY_LIFF_ID (เปิด URL ตรงบนเดสก์ท็อปก็ใช้ได้)
  try {
    const adminLiffId = (typeof ADMIN_LIFF_ID !== 'undefined' && ADMIN_LIFF_ID)
      ? ADMIN_LIFF_ID
      : (typeof MY_LIFF_ID !== 'undefined' ? MY_LIFF_ID : '');
    if (adminLiffId) {
      await liff.init({ liffId: adminLiffId });
      if (!liff.isLoggedIn()) { ensureLogin(); return; }  // เด้งไป login แล้วกลับมาที่หน้านี้

      const p = await liff.getProfile();
      currentStaffId = p.userId;        // ค่านี้แหละที่ลง IT_In_Charge ได้จริง
      currentStaff = p.displayName;
      localStorage.setItem('ft_staff', currentStaff);
      localStorage.setItem('ft_staff_id', currentStaffId);
      setStaffUI();
    }
  } catch (e) {
    // login พังไม่ควรทำให้ดูบอร์ดไม่ได้ — ยังดูได้ แต่กดรับงานจะโดนเตือนให้ login ก่อน
    console.warn('LINE login ไม่สำเร็จ:', e);
    currentStaffId = '';
    setStaffUI();
  }
  loadTickets();
}
init();
