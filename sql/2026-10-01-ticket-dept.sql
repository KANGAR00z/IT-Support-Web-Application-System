-- =============================================================================
-- FAST TICKET · ให้ตั๋วจำ "สาขา" ที่แจ้ง (TICKET.Dept_ID)
-- -----------------------------------------------------------------------------
-- เดิมตั๋วเก็บแค่ Branch_ID (= พื้นที่) ส่วนสาขาอยู่ที่ USER.Dept_ID ซึ่งถูกเขียนทับ
-- ทุกครั้งที่คนนั้นแจ้งซ่อมใหม่ -> ย้ายสาขาแล้วตั๋วเก่าทั้งหมดดูเหมือนมาจากสาขาใหม่
--
-- ⚠️ ลำดับ deploy: รันไฟล์นี้ "ก่อน" deploy AdminApi.gs เวอร์ชันที่อ้าง TICKET.Dept_ID
--    (ถ้า deploy GAS ก่อน การแจ้งซ่อมและหน้าบอร์ดจะ error เพราะไม่มีคอลัมน์)
-- รันซ้ำได้ ไม่เสียหาย
-- =============================================================================

BEGIN;

-- ว่างได้: ตั๋วเก่าที่เดาสาขาไม่ได้จะเป็น NULL (หน้าเว็บแสดงชื่อพื้นที่แทน)
ALTER TABLE "TICKET" ADD COLUMN IF NOT EXISTS "Dept_ID" int4
  REFERENCES "DEPARTMENT" ("Dept_ID");
CREATE INDEX IF NOT EXISTS idx_ticket_dept ON "TICKET" ("Dept_ID");

-- เติมตั๋วเก่าจากสาขาปัจจุบันของผู้แจ้ง — เฉพาะเมื่อสาขานั้นอยู่ในพื้นที่เดียวกับตั๋ว
-- (ถ้าคนนั้นย้ายข้ามพื้นที่ไปแล้ว เดาไม่ได้ว่าตอนแจ้งอยู่สาขาไหน ปล่อย NULL ไว้ดีกว่าเดาผิด)
UPDATE "TICKET" t
SET "Dept_ID" = u."Dept_ID"
FROM "USER" u
JOIN "DEPARTMENT" d ON d."Dept_ID" = u."Dept_ID"
WHERE u."LINE_User_ID" = t."LINE_User_ID"
  AND t."Dept_ID" IS NULL
  AND d."Branch_ID" = t."Branch_ID";

COMMIT;

-- ตรวจผล: ตั๋วทั้งหมด / มีสาขาแล้ว / ยังว่าง
SELECT COUNT(*) AS total,
       COUNT("Dept_ID") AS with_dept,
       COUNT(*) - COUNT("Dept_ID") AS without_dept
FROM "TICKET";
