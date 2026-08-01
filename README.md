# FAST TICKET

ระบบแจ้งซ่อมอุปกรณ์เทคโนโลยีสารสนเทศผ่าน LINE
สำนักงานสรรพสามิตภาคที่ 9 (7 จังหวัดภาคใต้)

เจ้าหน้าที่แจ้งซ่อมผ่าน LINE → ระบบออกบันทึกข้อความ (PDF) อัตโนมัติ →
เจ้าหน้าที่ IT รับงานและติดตามสถานะบนกระดาน Kanban → ปิดงานแล้วบันทึกวิธีแก้ลงฐานความรู้

- **Live:** <https://fast-ticket-app.darkness7256.workers.dev/>
- **สถาปัตยกรรม / ข้อห้ามในการแก้โค้ด:** [CLAUDE.md](CLAUDE.md) ← อ่านก่อนแก้
- **งานที่ค้าง:** [RESUME.md](RESUME.md)

---

## โครงสร้างโฟลเดอร์ — แบ่งตามปลายทางที่ deploy

โฟลเดอร์ในรีโปนี้ **แบ่งตามว่าไฟล์ไปอยู่ที่ไหน** ไม่ได้แบ่งตามชนิดไฟล์
ไฟล์ `.html` มีทั้งใน `DEMO/` และ `gas/` แต่ไปคนละปลายทางกัน

```
IT-Support-Web-Application-System/
├── DEMO/            → Cloudflare Worker  (ลากทั้งโฟลเดอร์อัปบน dashboard)
│   ├── index.html        ฟอร์มแจ้งซ่อม (LIFF · ผู้ใช้ทั่วไป)
│   ├── admin.html        คอนโซลเจ้าหน้าที่ IT (Dashboard/Kanban/KB/Users/Settings)
│   ├── admin.js          ลอจิกของ admin.html
│   ├── common.js         helper ที่ทั้งสองหน้าใช้ร่วมกัน (ต้องโหลดก่อนสคริปต์ของหน้า)
│   ├── config.js         MY_LIFF_ID · GAS_API_URL · ADMIN_LIFF_ID
│   └── map-data.js       พิกัด SVG แผนที่ 7 จังหวัด
│
├── gas/             → Google Apps Script (ก๊อปวางในตัว editor ทีละไฟล์)
│   ├── AdminApi.gs       doPost + auth + ทุก handler  ← ลอจิกหลักทั้งหมด
│   ├── Template.html     แม่แบบบันทึกข้อความ (GAS render เป็น PDF)
│   ├── richmenu-setup.gs สคริปต์ตั้ง rich menu (รันมือครั้งเดียว)
│   └── Code.gs           🔒 รหัสผ่าน DB — gitignore ไว้ ไม่มีในรีโป
│
├── sql/
│   └── set-admin.sql     ตั้ง Role ให้บัญชีแรกเป็น Admin
│
├── CLAUDE.md         สถาปัตยกรรม + ข้อห้าม (อ่านก่อนแก้โค้ด)
└── RESUME.md         บันทึกงานค้าง / วิธีทำงานข้ามเครื่อง
```

> ⚠️ **`gas/Template.html` ไม่ใช่หน้าเว็บ** — GAS อ่านผ่าน
> `HtmlService.createTemplateFromFile('Template')` จากโปรเจกต์ Apps Script
> แก้ไฟล์ในรีโปอย่างเดียว **ไม่มีผล** ต้องก๊อปไปวางใน GAS แล้ว deploy ใหม่

---

## วิธี deploy

**deploy 2 ที่ แยกกันคนละรอบ** — แก้ฝั่งไหนก็ deploy เฉพาะฝั่งนั้น

### 1. หน้าเว็บ → Cloudflare Worker

แก้อะไรใน `DEMO/` → ลากทั้งโฟลเดอร์ `DEMO` อัปบน Cloudflare dashboard
(Worker ชื่อ `fast-ticket-app`) · **ต้องอัปครบทั้ง 6 ไฟล์** ไม่งั้นหน้าที่ขาดไฟล์จะ 404

> config ของ Worker อยู่ **นอกรีโป** ทั้งหมด (ไม่มี `wrangler.toml`)
> ถ้าอยากให้ deploy ซ้ำได้จากทั้ง PC และ laptop ควรเพิ่ม wrangler config เข้ารีโป

### 2. Backend → Google Apps Script

แก้อะไรใน `gas/` → เปิดโปรเจกต์ Apps Script → ก๊อปเนื้อไฟล์ไปวางทับ →
**Deploy → Manage deployments → เปลี่ยน version เป็น New version**

การกด Save เฉยๆ ไม่พอ ต้อง deploy version ใหม่ URL เดิมถึงจะได้โค้ดใหม่

**Script Properties ที่ต้องตั้ง:**

| ชื่อ | ค่า |
|---|---|
| `LIFF_CHANNEL_ID` | Channel ID ของ **LINE Login channel** (ไม่ใช่ LIFF ID เต็ม) |
| `CHANNEL_ACCESS_TOKEN` | ใช้เฉพาะตอนตั้ง rich menu |

---

## ตรวจว่า backend ยังดีอยู่ไหม

```bash
curl -sL "$GAS_API_URL" -H "Content-Type: text/plain;charset=utf-8" --data-binary '{"action":"getTickets","data":{}}'
```

ต้องได้ `{"status":"error","message":"ยืนยันตัวตน LINE ไม่สำเร็จ..."}`
— แปลว่า deploy แล้วและด่านตรวจสิทธิ์ทำงาน (ปฏิเสธคนไม่มี token = ถูกต้อง)

> อย่าใส่ `-X POST` — GAS ตอบ 302 แล้วเบราว์เซอร์จะเปลี่ยนเป็น GET
> ถ้าบังคับ POST ต่อจะได้ 411/405 ซึ่งไม่ใช่ปัญหาของ backend

---

## เทคโนโลยี

| ส่วน | ใช้ |
|---|---|
| Frontend | LINE LIFF · HTML/JS · Tailwind CSS (CDN, ไม่มี build step) |
| Backend | Google Apps Script (Web App) |
| Database | Supabase PostgreSQL (ต่อผ่าน JDBC) |
| เก็บไฟล์ PDF | Google Drive |
| Auth | LINE ID Token → verify ฝั่ง server + ACL ตามบทบาท |
| Hosting | Cloudflare Worker (static assets) |

บทบาทผู้ใช้: `Staff` (แจ้งซ่อม) · `IT` (รับงาน/ปิดงาน) · `Admin` (จัดการบัญชี)
