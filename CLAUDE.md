# FAST TICKET — บันทึกการตัดสินใจเชิงสถาปัตยกรรม

ระบบแจ้งซ่อม IT ผ่าน LINE LIFF ของสำนักงานสรรพสามิตภาคที่ 9 (7 จังหวัดภาคใต้)

ไฟล์นี้เก็บ **เหตุผล** เบื้องหลังโครงสร้างปัจจุบัน — อ่านก่อนแก้ เพราะหลายอย่างที่ดู
"เขียนแปลกๆ" คือทางออกของปัญหาจริงที่เจอมาแล้ว การ "จัดระเบียบให้สวยขึ้น" โดยไม่รู้
เหตุผลจะทำระบบพัง

- งานที่ค้าง / ขั้นตอน deploy → `RESUME.md`
- ไฟล์นี้ = สิ่งที่ **ห้ามเปลี่ยนโดยไม่ตั้งใจ**

---

## 1. ภาพรวม

```
LINE app → LIFF (DEMO/*.html บน Cloudflare Worker)
              ↓ fetch POST
         Google Apps Script  ── gas/ApiRouter.gs     doPost + ตรวจ token + ACL
                             ├─ gas/UseCases.gs      ลอจิกของแต่ละ action
                             ├─ gas/Repositories.gs  SQL ทั้งหมด
                             ├─ gas/Infrastructure.gs connection / transaction / Drive-PDF
                             ├─ gas/Entities.gs      ค่าคงที่ + กฎตรวจค่า
                             ├─ gas/Template.html    แม่แบบบันทึกข้อความ → PDF
                             └─ gas/Code.gs          DB credentials เท่านั้น · gitignore
              ↓ JDBC
         Supabase Postgres          + Google Drive (เก็บ PDF บันทึกข้อความ)
```

**ทางใหม่ (2026-11-02): Cloudflare Worker `worker/`** — พอร์ต Router/UseCases/Repositories/Entities เป็น JS module
ต่อ DB ผ่าน Hyperdrive · เปิดใช้เมื่อตั้ง `WORKER_API_URL` ใน `DEMO/config.js` (ว่าง = GAS ทั้งหมดเหมือนเดิม)
- คำสั่งที่ใช้ Drive (`generateDocument` / `createTicket` / `deleteTempPdf`) ไป GAS เสมอ (`FT_GAS_ONLY` ใน `common.js`)
- **ลอจิก/SQL มีสองชุด** (`gas/*.gs` กับ `worker/src/*.js`) — แก้ฝั่งหนึ่งต้องแก้อีกฝั่ง แล้วรัน `tests/` ทั้งสองแบบ
  (`/tests/` = GAS · `/tests/?target=worker` = Worker) · ACL อยู่ทั้ง `gas/ApiRouter.gs` และ `worker/src/api.js`
- Worker ไม่มีแคชผลอ่าน และอ่าน role จาก DB ทุกคำขอ · Hyperdrive ต้องสร้างแบบ `--caching-disabled`
- วิธีตั้งค่า/deploy: [worker/README.md](worker/README.md)

**โฟลเดอร์แบ่งตามปลายทางที่ deploy** (ดูรายละเอียดใน [README.md](README.md))
- `DEMO/` → ลากทั้งโฟลเดอร์อัป **Cloudflare Worker**
- `gas/` → ก๊อปวางใน **Google Apps Script editor** ทีละไฟล์

**หน้าเว็บ 3 หน้า (LIFF app ละตัว)**
- `DEMO/index.html` — ฟอร์มแจ้งซ่อมของผู้ใช้ทั่วไป (ออกแบบมาสำหรับมือถือ) · `MY_LIFF_ID`
- `DEMO/history.html` — ประวัติการแจ้งซ่อมของตัวเอง · `HISTORY_LIFF_ID`
- `DEMO/admin.html` — คอนโซลเจ้าหน้าที่ IT: Dashboard / Task Board / ประวัติการแจ้งซ่อม / Users /
  ข้อมูลหลัก / Settings · `ADMIN_LIFF_ID`

**ไฟล์ใน `gas/` แบ่งตาม Clean Architecture แต่ GAS ไม่มีระบบ module** — ทุกไฟล์อยู่ใน global
scope เดียวกัน ชั้นจึงเป็นข้อตกลง: Router → UseCases → Repositories → Infrastructure, ทุกชั้นใช้ Entities ได้
- **ห้ามตั้งชื่อฟังก์ชันซ้ำข้ามไฟล์** — GAS ไม่ error ตัวที่โหลดทีหลังทับตัวแรกเงียบๆ
  (ตอน deploy จึงต้องลบ `AdminApi.gs` เดิมออกจากโปรเจกต์ GAS)
- **`const` ระดับบนสุดห้ามอ้างค่าของไฟล์อื่น** — GAS โหลดไฟล์ตามลำดับในโปรเจกต์ อ้างข้ามไฟล์ได้
  เฉพาะในตัวฟังก์ชัน (เช่น `handlers` ใน `doPost` สร้างตอนเรียก ไม่ใช่ตอนโหลด)
- SQL อยู่ใน `Repositories.gs` ที่เดียว · use case เป็นคนเปิด connection / คุม transaction (`withTx_`)

> `gas/Template.html` **ไม่ใช่หน้าเว็บ** ถึงจะเป็น `.html` — GAS อ่านผ่าน
> `HtmlService.createTemplateFromFile('Template')` จากโปรเจกต์ Apps Script
> แก้ในรีโปอย่างเดียวไม่มีผล ต้องก๊อปไปวางใน GAS แล้ว deploy version ใหม่

---

## 2. ข้อห้ามเด็ดขาด

### 2.1 `Content-Type: text/plain;charset=utf-8` — ห้ามเปลี่ยนเป็น `application/json`

`common.js` → `ftCallBackend()` ส่ง POST เป็น `text/plain` **โดยตั้งใจ**

GAS ไม่ตอบ preflight (`OPTIONS`) การใช้ `application/json` จะทำให้เบราว์เซอร์ยิง preflight
ก่อน → ไม่มีคำตอบ → **ทุก request พังหมด** ส่วน `text/plain` เข้าเงื่อนไข CORS
*simple request* จึงยิงตรงได้เลย body ยังเป็น JSON string ปกติ (backend `JSON.parse` เอง)

`ftCallBackend` มี timeout (อ่าน 25 วิ / เขียน 60 วิ) และ **ลองซ้ำเองได้เฉพาะคำสั่งอ่าน (`get*`) 1 ครั้ง**
— ห้ามให้คำสั่งเขียนลองซ้ำเอง (แจ้งซ่อมซ้ำ 2 ใบ) · GAS ที่พัง/เกินเวลาตอบเป็นหน้า HTML ไม่มี CORS
เบราว์เซอร์จึงรายงานแค่ "Failed to fetch" — `ftFetchJson_` แปลงเป็นข้อความไทยที่บอกสาเหตุ
สาเหตุจริงต้องดูที่ Apps Script → **Executions** (log ของแต่ละ request)

**ความเร็ว:** GAS มีเพดานต่ำสุด ~1.5-2 วิ/request (วัดแล้ว: รันสคริปต์ 1-1.5 วิ + 302 redirect 0.4-0.6 วิ)
DB อยู่โตเกียว (`ap-northeast-1` pooler :6543) แต่ GAS รันฝั่งอเมริกา — เปิด connection ใหม่ ~0.7-1.5 วิ
- หน้าเว็บ: โชว์ข้อมูลที่จำในเครื่องก่อนแล้วอัปเดตทีหลัง (`ft_my_tickets_v2`, `ft_board_v3`, `ft_dash_v1` ผูก LINE userId) ·
  `<link rel="preconnect">` ไป GAS ทุกหน้า
- **รายการในคอนโซล admin แบ่งหน้าที่ DB (2026-10-12)** — บอร์ด (`getBoard` แบ่งหน้าแยกแต่ละคอลัมน์ แต่ตอบครบ 3 คอลัมน์
  ใน query เดียวด้วย `ROW_NUMBER() OVER (PARTITION BY Status)`), ผู้ใช้ (`getUsers`), ประวัติ (`getKnowledgeBase`) ทีละ 20
  · กรอง/ค้นหา/เรียงทำใน SQL ทั้งหมด (ค้นด้วย `ILIKE` ผ่าน `likePattern_` ที่ escape `% _ \`) · ขอหน้าเกินหน้าสุดท้าย =
  ได้หน้าสุดท้าย (`clampPage_`) · แดชบอร์ดสรุปใน SQL query เดียว (`readDashboard_` ประกอบ JSON ใน Postgres)
  **ห้ามกลับไปโหลดทั้งตารางมาคำนวณที่หน้าเว็บ** — นั่นคือเหตุผลที่แยกเป็นหลาย action
  - หน้าเว็บจำหน้าที่โหลดแล้ว 60 วิ + โหลดหน้าถัดไปรอไว้ (`fetchPage`/`prefetchPage` ใน `admin.js`) · ล้างทุกครั้งที่แก้ข้อมูล
  - ผลค้นหา (มีคำค้น) ไม่แคชฝั่ง GAS · ชื่อแคชของรายการที่มีพารามิเตอร์ใช้ `argsKey_` (MD5 — key ยาวได้ ≤250 ตัวอักษร)
  - "งานของฉัน" กรองด้วย `IT_In_Charge = auth.userId` ฝั่ง server (ไม่เทียบชื่อ) — userId อยู่ในชื่อแคชเอง
- **connection เดียวต่อ request** (`REQ_CONN_` ใน `Infrastructure.gs`) — `withConn_` ไม่ปิด connection เอง
  `doPost` ปิดใน `finally` · ห้ามเรียก `getDbConnection()` ตรงๆ ใน use case/repository
  · `withTx_` ต้องคืน `autoCommit(true)` เสมอ เพราะ connection ถูกใช้ต่อ
- **แคชผลอ่าน** (`cachedRead_`): key ผูก "เลขเวอร์ชันข้อมูล" — `doPost` เปลี่ยนเลขนี้หลังคำสั่งที่ไม่ใช่ `get*`
  สำเร็จทุกครั้ง (ยกเว้น `NO_DATA_CHANGE`) แคชเก่าทั้งหมดจึงใช้ไม่ได้ทันที ไม่ต้องไล่ลบ · TTL 10 นาที
  = เพดานความค้างเมื่อแก้ตรงใน Supabase · เก็บแบบ gzip+base64 แบ่งก้อน 90KB (CacheService รับค่าละ ≤100KB)
  - **คำสั่งอ่านต้องขึ้นต้นด้วย `get`** ไม่งั้นจะถูกนับเป็นคำสั่งเขียน (ล้างแคช + ไม่ลองซ้ำฝั่งหน้าเว็บ)
  - **ผลที่ต่างกันตามผู้ใช้ ต้องมี `auth.userId` ในชื่อแคช** (`'my_' + userId`) ไม่งั้นคนหนึ่งเห็นข้อมูลอีกคน
  - แคชอยู่ "หลัง" ACL เสมอ — ห้ามย้าย `cachedRead_` ไปไว้ก่อน `authorize_`
  - คำสั่งเขียนใหม่ที่ไม่แตะ DB ให้เพิ่มใน `NO_DATA_CHANGE`
- ข้อมูลหลักของฟอร์มใช้แคชแยก (`master_v2`, 6 ชม.) ไม่ผูกเวอร์ชัน — ล้างเฉพาะตอน Admin แก้ข้อมูลหลัก
- ผลตรวจ LINE token แคชจนหมดอายุจริง · role แคชแค่ 5 นาที (ห้ามยืด — ลดสิทธิ์ตรงใน DB จะค้างนานเท่า TTL)

### 2.2 `Code.gs` ห้าม commit

เป็นไฟล์เดียวในโปรเจกต์ที่มีรหัสผ่าน DB (`getDbConnection()`)
`.gitignore` บล็อกไว้ทั้ง `Code.gs` และ `**/Code.gs`

> รหัสผ่าน DB ยังไม่ได้เปลี่ยน — เจ้าของโปรเจกต์เลือกจะเปลี่ยนเอง (ดู `RESUME.md`)

### 2.3 ห้ามประกาศชื่อซ้ำข้ามไฟล์ `<script>`

`const` ระดับบนสุดของทุก `<script>` **แชร์ global lexical scope เดียวกัน** — ประกาศชื่อ
เดิมซ้ำในอีกไฟล์ = `SyntaxError` ทั้งหน้าตาย (ไม่ใช่แค่ไฟล์นั้น)

ลำดับโหลดที่บังคับไว้:

| หน้า | ลำดับ |
|---|---|
| `index.html` / `history.html` | Tailwind CDN → `theme.js` → `config.js` → `common.js` → `<script>` ในหน้า |
| `admin.html` | Tailwind CDN → `theme.js` → `config.js` → `common.js` → `map-data.js` → `admin.js` |

- `theme.js` — `BRAND` + `tailwind.config` (สี `brand-*`) + CSS var `--brand-*`
  **brand = ปุ่มหลัก/เมนูที่เลือก/ลิงก์/โฟกัส เท่านั้น** สีที่มีความหมาย (สถานะตั๋ว amber/blue/emerald,
  สีหมวดหมู่, ป้ายบทบาท) ใช้สีตรงๆ ห้ามเปลี่ยนเป็น brand · เขียว LINE `#06C755` เฉพาะปุ่ม LINE Login
- แจ้งผล/ถามยืนยัน: `ftToast(msg, 'info'|'success'|'error')`, `await ftConfirm(msg, {title, danger})`,
  `ftAlert` — **ห้ามใช้ `alert()`/`confirm()`** · โหลดครั้งแรกใช้ `ftSkeleton('card'|'row', n)` แทนวงกลมหมุน
- **โหลดไม่สำเร็จ = หน้าสถานะ ไม่มีข้อมูลตัวอย่าง (2026-11-02)** — `ftErrorState(el, err, {onRetry, onLogin, lineId, where})`
  วาดไอคอน + สาเหตุ + คำแนะนำตามประเภท (`FT_ERR`: offline/timeout/network/auth/nologin/liff/noaccount/forbidden/outdated/server)
  + ปุ่มลองใหม่ + "รายละเอียดสำหรับผู้ดูแลระบบ" แบบพับ (ข้อความดิบ — ในแอป LINE เปิด console ไม่ได้)
  - ประเภทมาจาก `err.ftKind` (`ftErr(msg, kind)` ใน `ftFetchJson_`/`ftCallBackend`) ไม่มีก็เดาจากข้อความ backend (`ftErrorKind`)
    — **ข้อความ ACL/เวอร์ชันใน GAS ที่เปลี่ยนต้องแก้ regex ใน `ftErrorKind` ด้วย**
  - ขึ้นหน้าสถานะ **แม้มีข้อมูลเก่าในแคช** (ข้อมูลค้างทำให้เข้าใจผิดว่าเป็นปัจจุบัน) · กลับมาออนไลน์ = โหลดใหม่เอง
  - admin: `showViewError(view, e, retry)`/`clearViewError(view)` — ใส่ `.has-error` ที่ view ซ่อนลูกอื่นทั้งหมด
    เหลือ `.view-error` · flag `xLoaded` ตั้งเฉพาะตอนสำเร็จ (กลับมาหน้านั้น = ลองใหม่) · `#authBanner` ใช้กับ "บันทึก" ไม่สำเร็จเท่านั้น
  - history: `#errorBox` → `showError(e)` (รับ Error หรือข้อความ) · LIFF พังตอนเปิดหน้า = ประเภท `liff` ลองใหม่ด้วย reload
- ฟอร์มแจ้งซ่อมจำข้อมูลผู้แจ้งใน `localStorage.ft_reporter` และข้อความที่พิมพ์ค้างใน `ft_draft` (ผูก LINE userId ทั้งคู่
  · จำทันทีที่พิมพ์ · ลบ draft เมื่อแจ้งสำเร็จ) · ปุ่ม Debug ซ่อน เปิดด้วย `?debug=1`
  - ตัวเลือกสาขา/ส่วน/หมวดต้องมี `<option value="" disabled selected>-- เลือก --</option>` เสมอ (ทั้งใน HTML และ `applyMasterData`)
    — ไม่มี `selected` แล้ว `form.reset()` จะเลือกตัวแรกที่กดได้ให้เอง (เคยทำให้ตั๋วใบที่สองเป็น "ฮาร์ดแวร์" โดยไม่ได้เลือก)
  - ตรวจข้อมูลด้วย `validateAll()` บอกใต้ช่อง (`#<id>Err`) ไม่ใช้ toast / `reportValidity()`
  - รูปอาการเสีย: ย่อในเครื่อง (ด้านยาว ≤1600px JPEG 80%) ส่ง base64 ไปกับ `createTicket` (`imageData`/`imageType`)
    → server ตรวจชนิด/ขนาด (`IMAGE_TYPES`, `IMAGE_MAX_BYTES` 3MB) แล้วเก็บใน Drive โฟลเดอร์เดียวกับ PDF → `TICKET.Image_URL`
    **server ไม่รับ URL รูปจาก client** · ตั๋วบันทึกไม่สำเร็จ = ทิ้งรูปลงถังขยะ · `deleteTempPdf` ห้ามลบไฟล์ที่ตั๋วใช้เป็นรูปด้วย
  - เบอร์ภายในเก็บที่ `TICKET.Contact_Phone` (เบอร์ "ตอนแจ้ง" ตรงกับในเอกสาร) — ตั๋วก่อน 2026-11-02 มีแค่ใน PDF
- คอนโซล admin: กดการ์ด = แผงรายละเอียด (`openTicket` / `syncTicketDrawer` ตามข้อมูลใหม่ทุกครั้งที่ `render()`)
  · มือถือแสดงบอร์ดทีละคอลัมน์ผ่านแท็บสถานะ (`#boardTabs`, `.is-mobile-active`) · ตัวกรองพับในปุ่ม "ตัวกรอง"
  · ซ่อนสิ่งที่ ACL ไม่ยอมให้ทำตามบทบาท (`applyRoleUI` / `roleKnownNotAdmin`) — **ยังไม่รู้บทบาท = แสดงไว้** (server ตรวจซ้ำ)
    ถ้าเพิ่ม action ที่จำกัดบทบาทใน `ACL` ต้องซ่อนปุ่มฝั่งหน้าเว็บให้ตรงกันด้วย

- `config.js` — `MY_LIFF_ID`, `ADMIN_LIFF_ID`, `HISTORY_LIFF_ID`, `GAS_API_URL`
  **แต่ละหน้าต้อง `liff.init` ด้วย LIFF ID ของตัวเอง** — ใช้ ID ของหน้าอื่นจะ login ได้แต่
  `getIDToken()` คืน `null` (ทุก request โดนปฏิเสธ) · LIFF app ทุกตัวต้องอยู่ใต้ LINE Login channel เดียวกัน
- `common.js` — `$`, `ftCallBackend`, `escapeHtml`, `stripEmoji`, `cleanCategory`,
  `parseT`, `timeAgo`, `fmtDur`, `mean`, `icon`, `ftHydrateIcons`, `FT_ICONS`

**ไอคอน** = Lucide แบบ outline ฝัง SVG ใน `FT_ICONS` (ไม่ใช้ emoji / ไม่โหลด CDN)
ใน JS ใช้ `icon('pencil', 'w-4 h-4')` · ใน HTML ใช้ `<span data-icon="pencil" data-icon-class="w-4 h-4"></span>`
ไอคอนใหม่: คัดลอก path จาก `lucide-static@0.460.0/icons/<name>.svg` มาเพิ่มใน `FT_ICONS`
`alert()` / `confirm()` / `<option>` แสดง SVG ไม่ได้ → ใช้ข้อความล้วน ไม่ใส่ emoji
- `map-data.js` — `PROVINCES` (path SVG แผนที่ 7 จังหวัด)

---

## 3. Auth — verify ฝั่ง server เท่านั้น

`config.js` อยู่ใน public repo → ใครก็เห็น `GAS_API_URL` แล้ว `curl` ตรงได้
**การเช็คสิทธิ์ฝั่ง client เป็นแค่ UX ปลอมได้ทันที**

โมเดลที่ใช้:

1. client แนบ `liff.getIDToken()` (JWT ที่ LINE เซ็นลายเซ็น ปลอมไม่ได้) ไปทุก request
2. `doPost` → `authorize_(action, idToken)` ยิงถาม `api.line.me/oauth2/v2.1/verify`
   เช็คทั้ง `aud` และ `exp`
3. ได้ `userId` ตัวจริงจาก `sub` → อ่าน `USER.Role` จาก DB → เทียบกับตาราง `ACL`
4. handler รับ `auth` เป็น argument ที่ 2 และ **ใช้ `auth.userId` เท่านั้น**

> **client ไม่เคยส่ง `userId` มา** — ถ้าเห็นโค้ดที่รับ `data.userId` มาเชื่อ นั่นคือช่องโหว่

`ACL` (ใน `ApiRouter.gs`): `'*'` = แค่ login พอ (รวมคนแจ้งซ่อมครั้งแรกที่ยังไม่มีแถวใน `USER`)

| กลุ่ม | actions |
|---|---|
| `'*'` | `generateDocument`, `createTicket`, `deleteTempPdf`, `getMyTickets`, `getMasterData` |
| `IT` + `Admin` | `getBoard`, `getDashboard`, `acceptTicket`, `updateTicketStatus`, `getKnowledgeBase`, `addKnowledgeArticle`, `updateKnowledgeArticle`, `deleteKnowledgeArticle`, `getMyProfile` |
| `Admin` | `deleteTicket`, `getUsers`, `updateUserRole`, `addMasterItem`, `updateMasterItem`, `deleteMasterItem` |

- `deleteTempPdf` เปิดให้ทุกคน จึงลบได้เฉพาะไฟล์ในโฟลเดอร์ PDF ของระบบ **ที่ยังไม่มีตั๋วใบไหนอ้างถึง**
  (กันใช้ลบบันทึกข้อความฉบับจริงของคนอื่น)
- `deleteTicket` = **ยกเลิกงาน (soft delete)** ตั้ง `Deleted_At`/`Deleted_By` — แถวและ PDF ยังอยู่
  งานที่ยกเลิกหายจากบอร์ด/แดชบอร์ด/ยอดในหน้าผู้ใช้ แต่หน้าประวัติของผู้แจ้งยังเห็นเป็น "ยกเลิกแล้ว"
  · รับงาน/เปลี่ยนสถานะ/เพิ่มวิธีแก้ ใช้กับงานที่ยกเลิกไม่ได้ (`"Deleted_At" IS NULL` ทุก UPDATE)

**ข้อมูลหลัก (Master Data)** — เปลี่ยนชื่อตารางให้ตรงความหมายแล้วเมื่อ 2026-10-09:
`EXCISE_OFFICE` = พื้นที่ (ภาค 9 + 7 จังหวัด) → `TICKET.Office_ID` · `BRANCH` = สาขา (มี `Office_ID`) → `TICKET.Branch_ID`, `USER.Branch_ID` ·
`DEPARTMENT` = ส่วน (ชุดเดียวใช้ทุกสาขา) → `TICKET.Dept_ID`, `USER.Dept_ID` · `ISSUE_CATEGORY` = หมวดหมู่
· ตัวเลือกที่เขียนไว้ใน `index.html` = ค่าสำรองตอนโหลดจาก DB ไม่ได้
· ฝั่ง JS/JSON ใช้ชื่อตามตาราง: `office` / `branch` / `department` (และ `officeId`, `branchId`, `departmentId`)
`*MasterItem` รับแค่ key `office`/`branch`/`department`/`category` — ชื่อตาราง/คอลัมน์มาจาก `MASTER_TABLES` ฝั่ง server
ลบได้เฉพาะแถวที่ไม่มีใครอ้างถึง (นับจาก `refs`)

**ผังหน่วยงาน (2026-10-10)** ภาค 9 → 7 พื้นที่ → สาขา
- `EXCISE_OFFICE.Parent_Office_ID` → ภาค 9 (ภาค 9 เอง = NULL) · **รองรับ 2 ชั้นเท่านั้น** — `checkOrgRules_` บังคับ
  (แม่ต้องเป็นระดับบนสุด, หน่วยงานที่มีลูกจะไปสังกัดใครไม่ได้)
- `BRANCH.Branch_Name` **เก็บชื่อเต็ม** ต้อง = ชื่อพื้นที่ (ตัวสำนักงานพื้นที่เอง ไม่ใช่สาขา) หรือขึ้นต้นด้วย
  "ชื่อพื้นที่ " — backend บังคับตอนเพิ่ม/แก้ · **เปลี่ยนชื่อพื้นที่ = เปลี่ยนคำนำหน้าชื่อสาขาในพื้นที่นั้นให้เอง**
  (`renameBranchPrefix_` ใน transaction เดียวกัน) · PDF ใช้ชื่อสาขาตรงๆ ไม่ต้องประกอบ
- ลำดับตามผัง: `ftSortOffices` / `ftSortBranches` (`common.js`) เทียบ **รหัสตัวอักษร ไม่ใช่ `localeCompare`**
  ("สาขาเมือง..." จึงอยู่ท้ายกลุ่มเหมือนผังของหน่วยงาน · ตัวสำนักงานพื้นที่ขึ้นก่อนเพราะชื่อเป็นคำนำหน้า)
  ใช้ทั้ง dropdown ฟอร์มแจ้งซ่อมและเมนูข้อมูลหลัก · บนการ์ด/ตารางใช้ `ftShortOrg` ตัด "สำนักงานสรรพสามิต" ออก
- รูปข้อมูลเปลี่ยนจาก SQL โดยตรง → ต้องเพิ่มเลขแคชเอง: `MASTER_CACHE_KEY` / `READ_CACHE_PREFIX` (GAS) และ
  `MASTER_CACHE_KEY` ใน `index.html` — ไม่งั้นชื่อแบบเก่าค้างในแคชได้ถึง 6 ชม.

> ⚠️ **ชื่อเดิมถูกใช้ซ้ำในความหมายใหม่** — ก่อน 2026-10-09: `BRANCH` = พื้นที่, `DEPARTMENT`/`Dept_ID` = สาขา
> ตอนนี้: `BRANCH` = สาขา, `DEPARTMENT`/`Dept_ID` = ส่วน · อ่านโค้ด/SQL/เอกสารเก่าต้องดูวันที่ก่อนเสมอ
> (เล่มรายงาน Project I ออกแบบ `DEPARTMENT` = ส่วน ไว้ตั้งแต่แรก — ชุดนี้จึงตรงกับเล่ม)

> ⚠️ **ชื่อ `branch` เปลี่ยนความหมาย** (เดิม = พื้นที่ ตอนนี้ = สาขา) จึงมี `API_VERSION` (`Entities.gs`)
> คู่กับ `FT_API_VERSION` (`common.js`) — คำสั่งเขียนข้อมูลหลักที่ไม่ส่ง `apiVersion: 2` ถูกปฏิเสธ
> (หน้าเว็บรุ่นเก่าที่ค้างในเครื่องจะได้ไม่ลบ/แก้ผิดตาราง) · `createTicket` รุ่นเก่าแปลงชื่อ field ให้
> · แคชในเครื่องเปลี่ยน key เป็น `_v2` ทั้งหมด (`ft_master_v2`, `ft_tickets_v2`, `ft_staff_profile_v2`)
> **ถ้าเปลี่ยนความหมายของ field อีก ต้องเพิ่มเลขเวอร์ชันทั้งสองฝั่ง**

**fail-closed**: DB ล่ม / ไม่มีบัญชีใน `USER` → `getUserRole_` คืน `null` → ปฏิเสธ

ต้องตั้ง Script Property `LIFF_CHANNEL_ID` = **Channel ID ของ LINE Login channel**
(ไม่ใช่ LIFF ID) ถ้าจะเพิ่ม `ADMIN_LIFF_ID` ภายหลัง **ต้องอยู่ใต้ channel เดียวกัน**
ไม่งั้น `aud` ของ token จะไม่ตรงกับ `LIFF_CHANNEL_ID` ตัวเดียวที่ตั้งไว้

---

## 4. ฐานข้อมูล — ข้อจำกัดที่ทำให้ insert พัง

ชื่อตาราง/คอลัมน์เป็น **case-sensitive** ต้องใส่ double quote ในทุก query
(`"USER"`, `"LINE_User_ID"`)

- `USER.Role` มี CHECK `USER_Role_check` รับได้แค่ `'Staff'` / `'IT'` / `'Admin'`
  — **ตรงตามตัวพิมพ์** ฝั่ง frontend ส่ง lowercase แล้ว backend map ผ่าน `ROLE_DB_VALUE`
- `TICKET.IT_In_Charge` → FK ไป `USER.LINE_User_ID`
- `TICKET.Branch_ID` (สาขาที่แจ้ง) → FK ไป `BRANCH` ว่างได้ (ตั๋วเก่า) · **ห้ามอ่านสาขาของตั๋วจาก
  `USER.Branch_ID`** — ค่านั้นถูกเขียนทับทุกครั้งที่คนนั้นแจ้งใหม่ · `createTicket` ตั้ง `Office_ID`
  จากสาขาฝั่ง server ให้ตรงกันเสมอ
- `TICKET.Dept_ID` / `USER.Dept_ID` (ส่วน) → FK ไป `DEPARTMENT` ว่างได้ (ข้อมูลก่อน 2026-10-06 ไม่เคยเก็บส่วน)
  · หลักเดียวกับสาขา: ส่วนของตั๋วอ่านจาก `TICKET` ไม่ใช่ `USER` · id ส่วนผ่าน `SELECT` จาก `DEPARTMENT`
  ก่อน id ที่ไม่มีจริงจึงเป็น NULL แทน FK error
- `createTicket` เขียน `USER` + `TICKET` ใน transaction เดียว (`withTx_`) — พังกลางทางย้อนกลับทั้งคู่
- `TICKET.Deleted_At` / `Deleted_By` (FK → `USER`) = ยกเลิกงาน · กู้คืน: ตั้งทั้งสองคอลัมน์เป็น `NULL`
- PDF: ฟอร์มส่ง `section` (= ชื่อส่วน) แยกมาให้ `Template.html` ใช้ตัดบรรทัด "ส่วนราชการ" — ชื่อส่วนไม่ต้องขึ้นต้นด้วย "ส่วน"
  · ใน payload ของ PDF `department` = **ข้อความส่วนราชการเต็ม** (พื้นที่ + สาขา + ส่วน) ไม่ใช่ตาราง DEPARTMENT
  ชื่อนี้เป็นตัวแปรของแม่แบบบันทึกข้อความ ห้ามเปลี่ยนตามชื่อตาราง
- การเปลี่ยน schema ทุกครั้งเก็บเป็นไฟล์ใน `sql/` (ชื่อขึ้นต้นด้วยวันที่) และต้องรัน SQL **ก่อน**
  deploy GAS ที่อ้างคอลัมน์ใหม่
- `NOT NULL` แล้ว: `TICKET.Status/Created_Date/Category_ID`, `USER.Role` · RLS เปิดทุกตาราง ไม่มี policy
  (บล็อก REST API ของ Supabase · GAS ต่อด้วยเจ้าของตารางจึงไม่โดน)
- `KNOWLEDGE_BASE.Created_By` → FK ไป `USER.LINE_User_ID`
  (คนที่ยังไม่มีแถวใน `USER` เขียนบทความไม่ได้)
- `TICKET.Status`: `1` = รอรับเรื่อง (Open) · `2` = กำลังดำเนินการ · `3` = เสร็จสิ้น
  ค่านี้ผูกกับ `TICKET_STATUS` ใน `Entities.gs` และคอลัมน์บอร์ดใน `admin.js`
- ไฟล์ `sql/` ก่อน `2026-10-09-rename-org-tables.sql` ใช้ชื่อตารางเดิม (`DEPARTMENT`, `Dept_ID`) —
  เป็นประวัติที่รันไปแล้ว ห้ามรันซ้ำหลังเปลี่ยนชื่อ

`withConn_()` เปิด/ปิด connection ให้เอง — ตามสเปก JDBC ปิด `Connection` = ปิด
`Statement`/`ResultSet` ทั้งหมดที่เปิดจากมัน จึงไม่ต้องปิดรายตัว

---

## 5. Frontend — ข้อตกลงของ UI

ใช้ **Tailwind ผ่าน CDN** (ไม่มี build step) แก้ไฟล์แล้วอัปได้เลย

### 5.1 เมนูมือถือใช้ class `.nav-item` ร่วมกับ sidebar

sidebar เป็น `hidden md:flex` → **ต่ำกว่า 768px ไม่มีเมนูเลย** จึงเพิ่มแถบล่าง
`md:hidden` ที่ใช้ `class="nav-item"` + `data-view="..."` **เหมือน sidebar เป๊ะ**

ผลคือ `querySelectorAll('.nav-item')` เดิมผูก event และ toggle `.active` ให้ทั้งสองชุด
อัตโนมัติ — **เพิ่มเมนูใหม่ต้องเพิ่มทั้งสองที่ ไม่งั้นมือถือจะเข้าหน้านั้นไม่ได้**

`.tab-item` ต้องวาง **หลัง** `.nav-item.active` ใน CSS (specificity เท่ากัน 0,2,0 ตัวหลังชนะ)

### 5.2 ตารางต้องเป็น `table-fixed` ถ้าจะให้ `truncate` ทำงาน

`truncate` = `overflow:hidden` + `text-overflow:ellipsis` + `white-space:nowrap`
แต่ใน `table-layout: auto` เบราว์เซอร์กว้างคอลัมน์ตาม *preferred content width*
→ **`truncate` ไม่มีผลเลย ตารางล้นออกนอกจอ**

จึงใช้ `table-fixed` + กำหนด `%` ต่อ breakpoint (รวมต้องได้ 100% ของคอลัมน์ที่ *มองเห็น*
ในช่วงนั้น) แล้วค่อยปล่อยเป็น auto บนจอใหญ่ (`lg:table-auto` / `sm:table-auto`)
ข้อมูลของคอลัมน์ที่ซ่อน **ย้ายไปต่อท้ายชื่อเป็นบรรทัดเล็ก ไม่ได้ตัดทิ้ง**

> เพิ่ม/ลบคอลัมน์เมื่อไหร่ ต้องคำนวณ `%` ใหม่ทุกครั้ง

### 5.3 กัน iOS ซูมเอง — ต้องมี `!important`

```css
@media (max-width: 767px) { input, select, textarea { font-size: 16px !important; } }
```

iOS ซูมหน้าเว็บอัตโนมัติเมื่อโฟกัสช่องกรอกที่ `font-size < 16px`

- `!important` **จำเป็น** — utility ของ Tailwind (`.text-sm`) เป็น class (0,1,0)
  ชนะ element selector เปล่าๆ (0,0,1) ถ้าไม่ใส่ กฎนี้จะไม่มีผลเลย
- **ห้ามกลับไปใช้ `user-scalable=no` / `maximum-scale=1`** เพื่อแก้ปัญหานี้ —
  มันปิดการซูมของผู้ใช้ทั้งหมด คนสายตาไม่ดีขยายอ่านไม่ได้ (เคยใส่ไว้ เอาออกแล้ว)

### 5.4 `IS_TOUCH` — drag & drop ไม่ทำงานบนจอสัมผัส

```js
const IS_TOUCH = window.matchMedia('(hover: none)').matches;
```

HTML5 drag & drop ไม่ยิง `dragstart` บนมือถือเลย ปล่อย `draggable=true` ไว้จะทำให้
Android กดค้างแล้วเกิด ghost image ค้างจนเลื่อนบอร์ดไม่ได้ จึง:

- `el.draggable = !IS_TOUCH`
- **ปุ่มบนการ์ดคือทางเดียวที่เปลี่ยนสถานะได้บนมือถือ** — ห้ามลดเหลือแค่ตัวหนังสือ
- ข้อความบอกวิธีใช้ใน `VIEWS.board.sub` เปลี่ยนตาม `IS_TOUCH`
- ไม่มี hover บนจอสัมผัส → tooltip ของกราฟ/แผนที่ต้องผูก `click` ด้วย แล้วซ่อนเองใน 2.5 วิ

### 5.5 กราฟเส้นคำนวณ `viewBox` จากความกว้างจริง

SVG `preserveAspectRatio` แบบ meet จะย่อ **ทั้งภาพรวมถึงตัวหนังสือ** ถ้า `viewBox`
กว้างกว่ากล่องจริงมาก (เดิม viewBox 640 ในกล่อง 317px → font 10 หน่วยเหลือ ~5px อ่านไม่ออก)

จึงอ่าน `getBoundingClientRect().width` มาตั้ง `viewBox` ให้อัตราส่วน ~1:1
→ **ต้องวาดใหม่เมื่อ resize** (มี debounce 200ms ผูกไว้แล้ว) การ์ด/ตารางเป็น CSS ล้วน ไม่ต้องวาดใหม่

### 5.6 เบ็ดเตล็ด

| อย่าง | เหตุผล |
|---|---|
| `viewport-fit=cover` + `.safe-b` (`env(safe-area-inset-bottom)`) | กันปุ่มล่างโดน home indicator ของ iPhone ทับ |
| `.app-w` (max-width 640px) ใน `index.html` | ฟอร์มออกแบบมาสำหรับมือถือ ปล่อยเต็มจอ 1920px จะอ่านยากมาก |
| `.main-scroll { scrollbar-gutter: stable both-edges }` | scrollbar กินความกว้างข้างเดียว ทำให้ฟอร์มเยื้องจากแถบปุ่ม ~7px |
| `h-[100dvh]` | กัน browser chrome ของมือถือกินพื้นที่ |
| หน้า admin ธีมขาว minimal (2026-10-22) | สีพื้น/เส้น/เงา/ตัวอักษรรอง เป็น token บน `.viz-root` ใน `admin.html` (`--page`, `--line`, `--shadow-card`, `--ink-muted` ≥4.5:1) — ปรับที่เดียว · ฟอนต์ IBM Plex Sans Thai เฉพาะ admin · สีสถานะ `--st-*` และ ramp แผนที่ `--seq-*` ผ่าน validator แล้ว ห้ามเปลี่ยนตามอารมณ์ · คอนเทนเนอร์หน้าใช้ `flex gap` ไม่ใช่ `space-y` (space-y เว้นที่ให้แถบเตือนที่ซ่อนอยู่) |
| board column `md:max-w-none` | ถ้าไม่ปลด `max-w` ที่ `md` มันจะทับ `md:w-[320px]` ทำให้เดสก์ท็อปเลื่อนแนวนอนโดยไม่จำเป็น |

**กับดัก:** ใน `index.html` มีจุดที่ JS เขียนทับ `btn.className` ทั้งก้อน — string ในนั้น
ต้องตรงกับ class ตั้งต้นใน HTML ไม่งั้นปุ่มจะเปลี่ยนขนาดตอนกด

---

## 6. Deploy

**deploy แยกตามโฟลเดอร์** — แก้โฟลเดอร์ไหน ก็ deploy เฉพาะปลายทางนั้น

| แก้ที่ | ไปที่ | วิธี |
|---|---|---|
| `DEMO/` | Cloudflare Worker `fast-ticket-app` | ลากทั้งโฟลเดอร์อัปบน dashboard (ต้องครบ 9 ไฟล์ รวม `theme.js`) |
| `gas/` | Google Apps Script | ก๊อปวางในตัว editor ทุกไฟล์ (ยกเว้น `Code.gs`) → **Deploy → New version** (กด Save เฉยๆ ไม่พอ) |
| `worker/` | Cloudflare Worker `fast-ticket-api` | `npx wrangler deploy` ในโฟลเดอร์ `worker/` (ต้องมี Node.js — ดู `worker/README.md`) |

- Live: <https://fast-ticket-app.darkness7256.workers.dev/>
- config ของ Worker หน้าเว็บ (`fast-ticket-app`) อยู่ **นอก repo** · ของ API อยู่ที่ `worker/wrangler.jsonc`
- Script Properties ที่ GAS ต้องมี: `LIFF_CHANNEL_ID` (Channel ID ของ LINE Login
  channel ไม่ใช่ LIFF ID เต็ม) · `CHANNEL_ACCESS_TOKEN` (เฉพาะตอนตั้ง rich menu)

**เช็คว่า backend ยัง deploy ถูกตัวไหม:**

```bash
curl -sL "$GAS_API_URL" -H "Content-Type: text/plain;charset=utf-8" --data-binary '{"action":"getBoard","data":{}}'
```

ต้องได้ `ยืนยันตัวตน LINE ไม่สำเร็จ` = auth ทำงาน · **อย่าใส่ `-X POST`**
(GAS ตอบ 302 เบราว์เซอร์เปลี่ยนเป็น GET เอง บังคับ POST ต่อจะได้ 411/405 ซึ่งไม่ใช่บั๊ก)

**ทำงานข้ามเครื่อง (PC ↔ laptop):** ทำใน git clone **ที่เดียว** เท่านั้น
`git pull` → แก้ → `git commit` → `git push` · **ห้ามก๊อปไฟล์ข้ามโฟลเดอร์/เครื่อง**
(เคยเป็นต้นเหตุไฟล์เพี้ยนมาแล้ว)
