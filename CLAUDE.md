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
         Google Apps Script  ── gas/AdminApi.gs    (ลอจิกทั้งหมด · อยู่ใน git)
                             ├─ gas/Template.html  (แม่แบบบันทึกข้อความ → PDF)
                             └─ gas/Code.gs        (DB credentials เท่านั้น · gitignore)
              ↓ JDBC
         Supabase Postgres          + Google Drive (เก็บ PDF บันทึกข้อความ)
```

**โฟลเดอร์แบ่งตามปลายทางที่ deploy** (ดูรายละเอียดใน [README.md](README.md))
- `DEMO/` → ลากทั้งโฟลเดอร์อัป **Cloudflare Worker**
- `gas/` → ก๊อปวางใน **Google Apps Script editor** ทีละไฟล์

**หน้าเว็บ 2 หน้า**
- `DEMO/index.html` — ฟอร์มแจ้งซ่อมของผู้ใช้ทั่วไป (ออกแบบมาสำหรับมือถือ)
- `DEMO/admin.html` — คอนโซลเจ้าหน้าที่ IT: Dashboard / Task Board / Knowledge Base / Users / Settings

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
| `index.html` | `config.js` → `common.js` → `<script>` ในหน้า |
| `admin.html` | `config.js` → `common.js` → `map-data.js` → `admin.js` |

- `config.js` — `MY_LIFF_ID`, `GAS_API_URL`, `ADMIN_LIFF_ID`
  (`ADMIN_LIFF_ID = ""` fallback ไป `MY_LIFF_ID` ได้อย่างปลอดภัย)
- `common.js` — `$`, `ftCallBackend`, `escapeHtml`, `stripEmoji`, `cleanCategory`,
  `parseT`, `timeAgo`, `fmtDur`, `mean`
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

`ACL` (ใน `AdminApi.gs`): `'*'` = แค่ login พอ (รวมคนแจ้งซ่อมครั้งแรกที่ยังไม่มีแถวใน `USER`)

| กลุ่ม | actions |
|---|---|
| `'*'` | `generateDocument`, `createTicket`, `deleteTempPdf` |
| `IT` + `Admin` | `getTickets`, `acceptTicket`, `updateTicketStatus`, `getKnowledgeBase`, `addKnowledgeArticle` |
| `Admin` | `getUsers`, `updateUserRole` |

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
- `KNOWLEDGE_BASE.Created_By` → FK ไป `USER.LINE_User_ID`
  (คนที่ยังไม่มีแถวใน `USER` เขียนบทความไม่ได้)
- `TICKET.Status`: `1` = รอรับเรื่อง (Open) · `2` = กำลังดำเนินการ · `3` = เสร็จสิ้น
  ค่านี้ผูกกับ `TICKET_STATUS` ใน `AdminApi.gs` และคอลัมน์บอร์ดใน `admin.js`

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
| board column `md:max-w-none` | ถ้าไม่ปลด `max-w` ที่ `md` มันจะทับ `md:w-[320px]` ทำให้เดสก์ท็อปเลื่อนแนวนอนโดยไม่จำเป็น |

**กับดัก:** ใน `index.html` มีจุดที่ JS เขียนทับ `btn.className` ทั้งก้อน — string ในนั้น
ต้องตรงกับ class ตั้งต้นใน HTML ไม่งั้นปุ่มจะเปลี่ยนขนาดตอนกด

---

## 6. Deploy

**deploy 2 ที่ แยกกันคนละรอบ** — แก้โฟลเดอร์ไหน ก็ deploy เฉพาะปลายทางนั้น

| แก้ที่ | ไปที่ | วิธี |
|---|---|---|
| `DEMO/` | Cloudflare Worker `fast-ticket-app` | ลากทั้งโฟลเดอร์อัปบน dashboard (ต้องครบ 6 ไฟล์) |
| `gas/` | Google Apps Script | ก๊อปวางในตัว editor → **Deploy → New version** (กด Save เฉยๆ ไม่พอ) |

- Live: <https://fast-ticket-app.darkness7256.workers.dev/>
- config ของ Worker อยู่ **นอก repo** ทั้งหมด — ไม่มี `wrangler.toml`
- Script Properties ที่ GAS ต้องมี: `LIFF_CHANNEL_ID` (Channel ID ของ LINE Login
  channel ไม่ใช่ LIFF ID เต็ม) · `CHANNEL_ACCESS_TOKEN` (เฉพาะตอนตั้ง rich menu)

**เช็คว่า backend ยัง deploy ถูกตัวไหม:**

```bash
curl -sL "$GAS_API_URL" -H "Content-Type: text/plain;charset=utf-8" --data-binary '{"action":"getTickets","data":{}}'
```

ต้องได้ `ยืนยันตัวตน LINE ไม่สำเร็จ` = auth ทำงาน · **อย่าใส่ `-X POST`**
(GAS ตอบ 302 เบราว์เซอร์เปลี่ยนเป็น GET เอง บังคับ POST ต่อจะได้ 411/405 ซึ่งไม่ใช่บั๊ก)

**ทำงานข้ามเครื่อง (PC ↔ laptop):** ทำใน git clone **ที่เดียว** เท่านั้น
`git pull` → แก้ → `git commit` → `git push` · **ห้ามก๊อปไฟล์ข้ามโฟลเดอร์/เครื่อง**
(เคยเป็นต้นเหตุไฟล์เพี้ยนมาแล้ว)
