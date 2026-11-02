# FAST TICKET API บน Cloudflare Workers

ทางใหม่ของ backend: หน้าเว็บคุยกับ **Cloudflare Worker** ซึ่งต่อฐานข้อมูล Supabase ผ่าน **Hyperdrive** แทน Google Apps Script

```
หน้าเว็บ (LIFF) ──► Worker (fast-ticket-backend) ──► Hyperdrive ──► Supabase Postgres   ← คำสั่งอ่าน/เขียนข้อมูลทั้งหมด
              └──► Google Apps Script ──► Google Drive + Supabase                  ← สร้าง PDF · แจ้งซ่อม (พร้อมรูป) · ลบ PDF ร่าง
```

**ทำไม:** GAS ใช้ ~1.5–2 วินาทีต่อคำขอก่อนแตะฐานข้อมูลด้วยซ้ำ (รันฝั่งอเมริกา + redirect 302) ·
Worker รันที่ Cloudflare ใกล้ผู้ใช้ และ Hyperdrive ถือ connection ไปฐานข้อมูลไว้ให้แล้ว คาดว่าแต่ละคำขอเหลือไม่ถึงครึ่งวินาที
(ยังไม่ได้วัดกับระบบจริง — วัดหลัง deploy ด้วยแท็บ Network ของเบราว์เซอร์)

**ส่วนที่ยังอยู่ GAS:** `generateDocument` · `createTicket` · `deleteTempPdf` — ต้องใช้ Google Drive (เก็บ PDF/รูป)
ซึ่ง Worker ใช้ไม่ได้ · หน้าเว็บแยกส่งเองอัตโนมัติ (`FT_GAS_ONLY` ใน `DEMO/common.js`)

## Worker 2 ตัวใน Cloudflare — อย่าสับสน

| ชื่อใน dashboard | คืออะไร | deploy ยังไง |
|---|---|---|
| **fast-ticket-app** | หน้าเว็บ (`DEMO/`) ที่ผู้ใช้เปิดผ่าน LINE | อัปโหลดโฟลเดอร์ `DEMO` ผ่าน dashboard |
| **fast-ticket-backend** | backend (โฟลเดอร์นี้) — รับคำสั่งจากหน้าเว็บ ต่อฐานข้อมูล | `npx wrangler deploy` ในโฟลเดอร์ `worker/` เท่านั้น |

ห้ามอัป `DEMO` ไปที่ fast-ticket-backend (โค้ด backend จะถูกทับ — ถ้าเผลอ ให้ `npx wrangler deploy` ใหม่)

## ไฟล์

| ไฟล์ | หน้าที่ (พอร์ตมาจาก) |
|---|---|
| `src/index.js` | รับ POST จากหน้าเว็บ → `handle()` → ตอบ JSON + CORS |
| `src/api.js` | ACL + ตรวจ LINE ID Token + ส่งต่อ use case (`gas/ApiRouter.gs`) |
| `src/usecases.js` | ลอจิกแต่ละคำสั่ง (`gas/UseCases.gs`) |
| `src/repo.js` | SQL ทั้งหมด (`gas/Repositories.gs`) |
| `src/entities.js` | ค่าคงที่ + กฎตรวจค่า (`gas/Entities.gs`) |
| `src/db.js` | ห่อไดรเวอร์ `postgres` ให้ repo.js ใช้ |
| `wrangler.jsonc` | ตั้งค่า Worker (ชื่อ, Hyperdrive, Channel ID) |

> ⚠️ แก้ลอจิก/SQL ที่ไหน ต้องแก้อีกฝั่งให้ตรงกัน (GAS ยังรับ `createTicket` และเป็นทางสำรอง) ·
> ทดสอบทั้งคู่ด้วยชุดเดียวกัน: `tests/` (GAS) และ `tests/?target=worker` (Worker) — ดู `tests/README.md`

---

## วิธีตั้งค่าครั้งแรก (ทำครั้งเดียว ~20 นาที)

### 0. ก่อนเริ่ม
- รัน `sql/2026-11-02-ticket-phone.sql` ใน Supabase แล้ว (Worker อ่านคอลัมน์ `Contact_Phone`)
- มีบัญชี Cloudflare ตัวเดียวกับที่โฮสต์หน้าเว็บ `fast-ticket-app`

### 1. ติดตั้ง Node.js
ดาวน์โหลด **LTS** จาก <https://nodejs.org> ติดตั้งแบบค่าเริ่มต้น แล้วเปิด terminal ใหม่ ตรวจว่าได้:

```bash
node -v
```

### 2. ติดตั้งแพ็กเกจ + login Cloudflare
เปิด terminal ที่โฟลเดอร์ `worker/` ของ repo:

```bash
npm install
```

```bash
npx wrangler login
```

(เบราว์เซอร์เปิดหน้า Cloudflare ให้กด Allow)

### 3. สร้าง Hyperdrive (ตัวเชื่อม Worker ↔ Supabase)
1. Supabase → โปรเจกต์ → ปุ่ม **Connect** → เลือก **Session pooler** (พอร์ต **5432**) → คัดลอก URI
   หน้าตาประมาณ `postgresql://postgres.xxxx:[YOUR-PASSWORD]@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres`
   แล้วแทน `[YOUR-PASSWORD]` ด้วยรหัสผ่านฐานข้อมูล (ตัวเดียวกับใน `gas/Code.gs`)
   - ห้ามใช้ Transaction pooler (พอร์ต 6543) — Hyperdrive ทำ pooling เองอยู่แล้ว
2. รัน (ใส่ URI ทั้งก้อนในเครื่องหมายคำพูด):

```bash
npx wrangler hyperdrive create fast-ticket-db --caching-disabled --connection-string="postgresql://..."
```

   - **ต้องมี `--caching-disabled`** — ไม่งั้น Hyperdrive จำผลอ่านไว้ 60 วินาที รับงาน/ปิดงานแล้วบอร์ดยังโชว์ของเก่า
   - รหัสผ่านถูกเก็บแบบเข้ารหัสใน Cloudflare ไม่อยู่ใน repo
3. คำสั่งจะตอบ `id` กลับมา → เอาไปใส่แทน `ใส่_HYPERDRIVE_ID_ตรงนี้` ใน `wrangler.jsonc` (id ไม่ใช่ความลับ commit ได้)

### 4. ตรวจ Channel ID
`LIFF_CHANNEL_ID` ใน `wrangler.jsonc` ตั้งไว้ `2010392375` (ตัวเลขหน้า `-` ของ LIFF ID ใน `DEMO/config.js`)
ต้องตรงกับ Apps Script → Project Settings → Script Properties → `LIFF_CHANNEL_ID`

### 5. Deploy

```bash
npx wrangler deploy
```

ได้ URL เช่น `https://fast-ticket-backend.<ชื่อบัญชี>.workers.dev` — เปิดในเบราว์เซอร์ต้องเห็น `"พร้อมทำงาน"`

### 6. สลับหน้าเว็บมาใช้ Worker
1. ใส่ URL จากขั้นที่ 5 ใน `DEMO/config.js`:
   ```js
   const WORKER_API_URL = "https://fast-ticket-backend.<ชื่อบัญชี>.workers.dev";
   ```
2. อัปโหลดโฟลเดอร์ `DEMO` ขึ้น Cloudflare (`fast-ticket-app`) เหมือนทุกครั้ง
3. ทดสอบ: เปิดหน้า admin → ดูบอร์ด แดชบอร์ด ผู้ใช้งาน · รับงาน/ปิดงาน 1 ใบ · แจ้งซ่อม 1 ใบจากฟอร์ม
   - เบราว์เซอร์บนคอม: F12 → แท็บ Network → คำขอต้องไปที่ `workers.dev` (ยกเว้นตอนสร้างเอกสาร/แจ้งซ่อมที่ไป `script.google.com`)

### ถอยกลับ (ถ้า Worker มีปัญหา)
ตั้ง `WORKER_API_URL = ""` แล้วอัปโหลด `DEMO` ใหม่ — ทุกอย่างกลับไปใช้ GAS ทันที (GAS ยังทำงานครบทุกคำสั่ง)

---

## งานประจำ

| ทำอะไร | คำสั่ง (ในโฟลเดอร์ `worker/`) |
|---|---|
| deploy หลังแก้โค้ด | `npx wrangler deploy` |
| ดู log สด (error ของแต่ละคำขอ) | `npx wrangler tail` หรือ Cloudflare dashboard → Workers → fast-ticket-backend → Logs |
| เปลี่ยนรหัสผ่าน DB | `npx wrangler hyperdrive update <id> --origin-password="รหัสใหม่"` (+ แก้ `gas/Code.gs` ด้วย) |

## ข้อแตกต่างจาก GAS ที่ควรรู้
- **ไม่มีแคชผลอ่าน** — อ่านจาก DB ทุกครั้ง (เร็วพออยู่แล้วผ่าน Hyperdrive) ข้อมูลจึงสดเสมอ ไม่ต้องล้างแคช
- **บทบาท (Role) อ่านจาก DB ทุกคำขอ** — ลดสิทธิ์แล้วมีผลทันที (GAS แคชไว้ 5 นาที)
- **ตรวจ LINE token** แคชในหน่วยความจำของ Worker จนกว่า token หมดอายุ
- **แก้บทบาทผู้ใช้อยู่ใน transaction** — สองคนลดสิทธิ์แอดมินพร้อมกันจะไม่เหลือแอดมิน 0 คน
- **ค่าใช้จ่าย:** แผนฟรีของ Workers และ Hyperdrive รับได้ราว 100,000 คำขอ/วัน (เงื่อนไข ณ ปี 2025 — ตรวจหน้า pricing ล่าสุด)
  ระบบนี้ใช้ไม่ถึงหลักพันต่อวัน
