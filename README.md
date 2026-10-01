# FAST TICKET

ระบบแจ้งซ่อมอุปกรณ์เทคโนโลยีสารสนเทศผ่าน LINE
สำนักงานสรรพสามิตภาคที่ 9 (7 จังหวัดภาคใต้)

เจ้าหน้าที่แจ้งซ่อมผ่าน LINE → ระบบออกบันทึกข้อความ (PDF) อัตโนมัติ →
เจ้าหน้าที่ IT รับงานและติดตามสถานะบนกระดาน Kanban → ปิดงานแล้วบันทึกวิธีแก้ลงประวัติการแจ้งซ่อม →
ผู้แจ้งติดตามสถานะของตัวเองได้ที่หน้าประวัติ

- **Live:** <https://fast-ticket-app.darkness7256.workers.dev/>
- **สถาปัตยกรรม / ข้อห้ามในการแก้โค้ด:** [CLAUDE.md](CLAUDE.md) ← อ่านก่อนแก้
- **สถานะ / งานที่ค้าง:** [RESUME.md](RESUME.md)
- **เอกสาร CRUD ของระบบ:** [FAST_TICKET_CRUD_Modules.docx](FAST_TICKET_CRUD_Modules.docx)

---

## หน้าเว็บ (LIFF app ละตัว)

| หน้า | ผู้ใช้ | LIFF ID (`config.js`) | ทำอะไร |
|---|---|---|---|
| `index.html` | ทุกคน | `MY_LIFF_ID` | แจ้งซ่อม · ตรวจ PDF ก่อนส่ง · จำข้อมูลผู้แจ้ง · หน้าแจ้งสำเร็จพร้อมเลขตั๋ว |
| `history.html` | ทุกคน | `HISTORY_LIFF_ID` | ดูตั๋วของตัวเอง สถานะ ผู้รับผิดชอบ วิธีแก้ไข |
| `admin.html` | IT / Admin | `ADMIN_LIFF_ID` | แดชบอร์ด · ตารางงาน (Kanban) · ประวัติการแจ้งซ่อม · ผู้ใช้งาน · ข้อมูลหลัก · ตั้งค่า |

> แต่ละหน้าต้อง `liff.init` ด้วย LIFF ID **ของตัวเอง** — ใช้ ID ของหน้าอื่นจะได้ `getIDToken() = null`
> ทุก LIFF app ต้องอยู่ใต้ LINE Login channel เดียวกัน (backend ตรวจ `aud` กับ `LIFF_CHANNEL_ID` ตัวเดียว)

---

## โครงสร้างโฟลเดอร์ — แบ่งตามปลายทางที่ deploy

โฟลเดอร์ในรีโปนี้ **แบ่งตามว่าไฟล์ไปอยู่ที่ไหน** ไม่ได้แบ่งตามชนิดไฟล์
ไฟล์ `.html` มีทั้งใน `DEMO/` และ `gas/` แต่ไปคนละปลายทางกัน

```
IT-Support-Web-Application-System/
├── DEMO/            → Cloudflare Worker  (ลากทั้งโฟลเดอร์อัปบน dashboard · 9 ไฟล์)
│   ├── index.html        ฟอร์มแจ้งซ่อม (LIFF · ผู้ใช้ทั่วไป)
│   ├── history.html      ประวัติการแจ้งซ่อมของตัวเอง (LIFF · ผู้ใช้ทั่วไป)
│   ├── admin.html        คอนโซลเจ้าหน้าที่ IT
│   ├── admin.js          ลอจิกของ admin.html
│   ├── common.js         helper กลาง: เรียก backend, login ใหม่อัตโนมัติ, ไอคอน, toast/dialog, skeleton
│   ├── theme.js          สีหลักของระบบ (brand) — เปลี่ยนสีองค์กรที่นี่ที่เดียว
│   ├── config.js         LIFF ID ทั้ง 3 หน้า · GAS_API_URL
│   ├── map-data.js       พิกัด SVG แผนที่ 7 จังหวัด
│   └── richmenu.png      รูป Rich Menu (2500x1686)
│
├── gas/             → Google Apps Script (ก๊อปวางในตัว editor ทีละไฟล์)
│   ├── AdminApi.gs       doPost + auth + ทุก handler  ← ลอจิกหลักทั้งหมด
│   ├── Template.html     แม่แบบบันทึกข้อความ (GAS render เป็น PDF)
│   ├── richmenu-setup.gs สคริปต์ตั้ง rich menu (รันมือครั้งเดียว)
│   └── Code.gs           🔒 รหัสผ่าน DB — gitignore ไว้ ไม่มีในรีโป
│
├── sql/             → รันมือใน Supabase SQL Editor (ชื่อไฟล์ขึ้นต้นด้วยวันที่ = ลำดับที่รัน)
│   ├── set-admin.sql                 ตั้ง Role ให้บัญชีแรกเป็น Admin
│   ├── 2026-10-01-hotfix.sql         sequence ของ id · ชื่อสาขา · NOT NULL · index
│   └── 2026-10-01-ticket-dept.sql    เพิ่ม TICKET.Dept_ID (ตั๋วจำสาขาที่แจ้ง)
│
├── CLAUDE.md         สถาปัตยกรรม + ข้อห้าม (อ่านก่อนแก้โค้ด)
├── RESUME.md         สถานะปัจจุบัน + งานค้าง + วิธีทำงานข้ามเครื่อง
└── FAST_TICKET_CRUD_Modules.docx   เอกสาร CRUD / ACL / ฐานข้อมูล
```

> ⚠️ **`gas/Template.html` ไม่ใช่หน้าเว็บ** — GAS อ่านผ่าน
> `HtmlService.createTemplateFromFile('Template')` จากโปรเจกต์ Apps Script
> แก้ไฟล์ในรีโปอย่างเดียว **ไม่มีผล** ต้องก๊อปไปวางใน GAS แล้ว deploy ใหม่

---

## วิธี deploy

**deploy แยกกันคนละที่** — แก้ฝั่งไหนก็ deploy เฉพาะฝั่งนั้น
ถ้าแก้หลายฝั่งพร้อมกัน ลำดับคือ **SQL → GAS → Cloudflare**
(GAS ที่อ้างคอลัมน์ใหม่จะ error ทันทีถ้ายังไม่ได้รัน SQL)

### 1. ฐานข้อมูล → Supabase

รันไฟล์ใหม่ใน `sql/` ทาง Supabase → SQL Editor · ทุกไฟล์รันซ้ำได้ไม่เสียหาย

### 2. Backend → Google Apps Script

แก้อะไรใน `gas/` → เปิดโปรเจกต์ Apps Script → ก๊อปเนื้อไฟล์ไปวางทับ →
**Deploy → Manage deployments → เปลี่ยน version เป็น New version**

การกด Save เฉยๆ ไม่พอ ต้อง deploy version ใหม่ URL เดิมถึงจะได้โค้ดใหม่

**Script Properties ที่ต้องตั้ง:**

| ชื่อ | ค่า |
|---|---|
| `LIFF_CHANNEL_ID` | Channel ID ของ **LINE Login channel** (ไม่ใช่ LIFF ID เต็ม) |
| `CHANNEL_ACCESS_TOKEN` | ใช้เฉพาะตอนตั้ง rich menu |

### 3. หน้าเว็บ → Cloudflare Worker

แก้อะไรใน `DEMO/` → ลากทั้งโฟลเดอร์ `DEMO` อัปบน Cloudflare dashboard
(Worker ชื่อ `fast-ticket-app`) · **ต้องอัปครบทั้ง 9 ไฟล์** ขาด `theme.js` = ทุกหน้าไม่มีสีหลัก

> config ของ Worker อยู่ **นอกรีโป** ทั้งหมด (ไม่มี `wrangler.toml`)

---

## ตรวจว่า backend ยังดีอยู่ไหม

```bash
curl -sL "$GAS_API_URL" -H "Content-Type: text/plain;charset=utf-8" --data-binary '{"action":"getTickets","data":{}}'
```

ต้องได้ `{"status":"error","code":"AUTH_INVALID","message":"ยืนยันตัวตน LINE ไม่สำเร็จ..."}`
— แปลว่า deploy แล้วและด่านตรวจสิทธิ์ทำงาน (ปฏิเสธคนไม่มี token = ถูกต้อง)

> อย่าใส่ `-X POST` — GAS ตอบ 302 แล้วเบราว์เซอร์จะเปลี่ยนเป็น GET
> ถ้าบังคับ POST ต่อจะได้ 411/405 ซึ่งไม่ใช่ปัญหาของ backend

**ดู log ของฟอร์มแจ้งซ่อมบนมือถือ:** เปิดด้วย `?debug=1` จะมีปุ่ม Debug Mode (ปิดด้วย `?debug=0`)

---

## เทคโนโลยี

| ส่วน | ใช้ |
|---|---|
| Frontend | LINE LIFF · HTML/JS · Tailwind CSS (CDN, ไม่มี build step) · ไอคอน Lucide (ฝัง SVG) |
| Backend | Google Apps Script (Web App) |
| Database | Supabase PostgreSQL (ต่อผ่าน JDBC · RLS เปิดทุกตาราง) |
| เก็บไฟล์ PDF | Google Drive |
| Auth | LINE ID Token → verify ฝั่ง server + ACL ตามบทบาท |
| Hosting | Cloudflare Worker (static assets) |

บทบาทผู้ใช้: `Staff` (แจ้งซ่อม/ดูประวัติตัวเอง) · `IT` (รับงาน/ปิดงาน/ประวัติการแจ้งซ่อม) ·
`Admin` (ทุกอย่างของ IT + จัดการผู้ใช้ + ข้อมูลหลัก)
