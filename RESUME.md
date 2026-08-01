# FAST TICKET — Handoff / Resume Note

> อัปเดตล่าสุด: 2026-07-13 · ทำต่อ: 2026-07-14 (laptop)
> ไฟล์นี้ sync ข้ามเครื่องผ่าน git — บน laptop รัน `git pull` ก่อนเริ่มเสมอ

## วิธีทำงานข้ามเครื่อง (PC ↔ laptop) — สำคัญ
ทำงานใน git clone **ที่เดียว**: `IT-Support-Web-Application-System/`
รอบทำงาน: `git pull` → แก้ไฟล์ → `git commit -am "..."` → `git push`
อีกเครื่องแค่ `git pull` — **ห้ามก๊อปไฟล์ข้ามโฟลเดอร์/เครื่องเด็ดขาด** (ต้นเหตุไฟล์เพี้ยน)

## สถาปัตยกรรมย่อ
> โครงสร้างโฟลเดอร์เต็ม + ขั้นตอน deploy ละเอียด ดู [README.md](README.md)
> ข้อห้ามในการแก้โค้ด ดู [CLAUDE.md](CLAUDE.md)

- **`DEMO/`** → Cloudflare Worker: `index.html` (LIFF แจ้งซ่อม) + `admin.html` (Kanban) + `config.js`
- **`gas/`** → Google Apps Script: `AdminApi.gs` (ลอจิก) + `Template.html` (แม่แบบ PDF)
  + `Code.gs` (มี DB creds — **ห้าม commit**, gitignore กันไว้แล้ว)
- **DB**: Supabase Postgres · **PDF**: Google Drive
- Frontend คุย backend ผ่าน `callBackend()` POST `text/plain` (จงใจหลบ CORS — อย่าเปลี่ยนเป็น application/json)

## Deploy — 2 ที่ แยกกันคนละรอบ
- Live: https://fast-ticket-app.darkness7256.workers.dev/ (Cloudflare Worker `fast-ticket-app`)
- แก้ `DEMO/` → **ลากโฟลเดอร์ `DEMO` อัปเองบน Cloudflare dashboard**
- แก้ `gas/` → ก๊อปวางใน Apps Script editor → **Deploy → New version** (Save เฉยๆ ไม่พอ)

## ค้างอยู่ (TODO ทำต่อ)
- [ ] **Deploy admin.html** — ลากโฟลเดอร์ `DEMO` อัปใหม่ (รอบล่าสุดยังไม่มี admin.html → ตอนนี้ `/admin.html` = 404) แล้วเช็คว่าขึ้น 200
- [ ] **Backend handlers** — admin ต้องการ `getTickets` / `acceptTicket` / `updateTicketStatus` บน GAS; ยังไม่ deploy GAS เวอร์ชันใหม่ → admin รันได้แค่โหมด mock จนกว่าจะ deploy
- [ ] **ความปลอดภัย** — รหัส DB Supabase ที่ฝังใน `Code.gs` ควรเปลี่ยนรหัส + ย้ายไป Script Properties
- [ ] (optional) เพิ่ม `wrangler.toml` ใน repo เพื่อ deploy ด้วย `npx wrangler deploy` แทนการลากมือ

## เฟสถัดไป (Admin Workspace)
เฟส 1 Kanban (โค้ดพร้อม) → เฟส 2 Dashboard (+แผนที่ 7 จังหวัดใต้) → เฟส 3 Users → เฟส 4 Knowledge Base
