-- =============================================================================
-- FAST TICKET · hotfix 2026-10-01 — "รันแล้ว" บน production บันทึกไว้เป็นประวัติ
-- ถ้าสร้างฐานข้อมูลใหม่จาก schema เดิม ต้องรันไฟล์นี้ด้วย (รันซ้ำได้ ไม่เสียหาย)
-- =============================================================================

-- 1) sequence ของ id ค้าง — ข้อมูลตั้งต้นถูก insert แบบระบุ id เอง sequence จึงไม่เดิน
--    เพิ่มข้อมูลหลักแล้วชน duplicate key "BRANCH_pkey" · AdminApi.gs (syncIdSequence_)
--    เลื่อน sequence ให้เองก่อน insert แล้ว แต่ตอนนั้นยังไม่ได้ deploy จึงแก้ตรงนี้ก่อน
SELECT setval(pg_get_serial_sequence('"BRANCH"', 'Branch_ID'),           (SELECT COALESCE(MAX("Branch_ID"), 0) + 1 FROM "BRANCH"), false)            AS branch_next,
       setval(pg_get_serial_sequence('"DEPARTMENT"', 'Dept_ID'),         (SELECT COALESCE(MAX("Dept_ID"), 0) + 1 FROM "DEPARTMENT"), false)          AS dept_next,
       setval(pg_get_serial_sequence('"ISSUE_CATEGORY"', 'Category_ID'), (SELECT COALESCE(MAX("Category_ID"), 0) + 1 FROM "ISSUE_CATEGORY"), false) AS category_next;

-- 2) ชื่อสาขาซ้ำชื่อพื้นที่นำหน้า ("สำนักงานสรรพสามิตพื้นที่นราธิวาสสาขาระแงะ" -> "สาขาระแงะ")
--    ฟอร์มแจ้งซ่อมประกอบชื่อเต็มใน PDF เองจาก พื้นที่ + สาขา ถ้าไม่แก้ชื่อใน PDF จะซ้ำ
UPDATE "DEPARTMENT" d
SET "Dept_Name" = TRIM(SUBSTRING(d."Dept_Name" FROM LENGTH(b."Branch_Name") + 1))
FROM "BRANCH" b
WHERE b."Branch_ID" = d."Branch_ID"
  AND d."Dept_Name" LIKE b."Branch_Name" || 'สาขา%';

-- 3) คอลัมน์ที่โค้ดถือว่ามีค่าเสมอ — มี default + CHECK อยู่แล้ว ขาดแค่ NOT NULL
--    (CHECK ไม่กันค่า NULL) · ตรวจแล้วไม่มีแถวที่เป็น NULL ก่อนรัน
BEGIN;
ALTER TABLE "TICKET"
  ALTER COLUMN "Status"       SET NOT NULL,
  ALTER COLUMN "Created_Date" SET NOT NULL,
  ALTER COLUMN "Category_ID"  SET NOT NULL;
ALTER TABLE "USER" ALTER COLUMN "Role" SET NOT NULL;
-- หน้าประวัติหา "วิธีแก้ไขล่าสุด" ของตั๋วทีละใบ
CREATE INDEX IF NOT EXISTS idx_kb_ticket ON "KNOWLEDGE_BASE" ("Ticket_ID");
COMMIT;
