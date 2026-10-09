-- =============================================================================
-- FAST TICKET · โครงสร้างหน่วยงานตามผัง ภาค 9 -> พื้นที่ -> สาขา
-- -----------------------------------------------------------------------------
-- 1) EXCISE_OFFICE.Parent_Office_ID — ภาค 9 เป็นแม่ของ 7 พื้นที่ (ภาค 9 เอง = NULL)
-- 2) BRANCH.Branch_Name เก็บชื่อเต็ม เช่น "สำนักงานสรรพสามิตพื้นที่ตรัง สาขากันตัง"
--    (เดิมเก็บ "สาขากันตัง" แล้วหน้าเว็บประกอบเอง) · สำนักงานใหญ่ภาค 9 ตัดคำว่า "(สำนักงานใหญ่)"
-- 3) เพิ่มตัวเลือก "สำนักงานพื้นที่" ของทุกพื้นที่ (ชื่อ = ชื่อพื้นที่) ให้คนที่ไม่ได้อยู่สาขาเลือกได้
--
-- กติกาที่ backend บังคับต่อจากนี้: ชื่อสาขาต้องเท่ากับชื่อพื้นที่ หรือขึ้นต้นด้วย "ชื่อพื้นที่ "
--   และเปลี่ยนชื่อพื้นที่ = เปลี่ยนคำนำหน้าของชื่อสาขาในพื้นที่นั้นให้อัตโนมัติ
-- ⚠️ รันก่อน deploy GAS ชุดที่อ้าง Parent_Office_ID · รันซ้ำได้ ไม่เสียหาย
-- =============================================================================

BEGIN;

-- 1) ลำดับชั้น: แม่ต้องเป็นสำนักงานในตารางเดียวกัน
ALTER TABLE "EXCISE_OFFICE" ADD COLUMN IF NOT EXISTS "Parent_Office_ID" int4
  REFERENCES "EXCISE_OFFICE" ("Office_ID");

UPDATE "EXCISE_OFFICE" c
SET "Parent_Office_ID" = p."Office_ID"
FROM "EXCISE_OFFICE" p
WHERE p."Office_Name" LIKE 'สำนักงานสรรพสามิตภาค%'
  AND c."Office_Name" LIKE 'สำนักงานสรรพสามิตพื้นที่%'
  AND c."Parent_Office_ID" IS NULL;

-- 2) ชื่อเต็มของสาขา — เฉพาะแถวที่ยังเป็นชื่อสั้น ("สาขา...") รอบที่สองจึงไม่เติมซ้ำ
UPDATE "BRANCH" b
SET "Branch_Name" = o."Office_Name" || ' ' || b."Branch_Name"
FROM "EXCISE_OFFICE" o
WHERE o."Office_ID" = b."Office_ID"
  AND b."Branch_Name" LIKE 'สาขา%';

-- สำนักงานใหญ่ภาค 9: "สำนักงานสรรพสามิตภาคที่ 9 (สำนักงานใหญ่)" -> "สำนักงานสรรพสามิตภาคที่ 9"
UPDATE "BRANCH"
SET "Branch_Name" = regexp_replace("Branch_Name", '\s*\(สำนักงานใหญ่\)\s*$', '')
WHERE "Branch_Name" ~ '\(สำนักงานใหญ่\)\s*$';

-- 3) ตัวเลือก "สำนักงานพื้นที่" — ทุกสำนักงานที่ยังไม่มีแถวชื่อเดียวกับตัวเอง
--    id ตายตัว = Office_ID + 1000 — ตัวเลือกสำรองใน index.html (ตอนโหลดจาก DB ไม่ได้) รู้ id ล่วงหน้าได้
--    (ภาค 9 ใช้แถวสำนักงานใหญ่เดิมที่เปลี่ยนชื่อในข้อ 2)
-- เคยรันไฟล์รุ่นก่อน (id ออกจาก sequence) -> ย้ายเป็น id ตายตัว เฉพาะแถวที่ยังไม่มีตั๋ว/ผู้ใช้อ้างถึง
UPDATE "BRANCH" b
SET "Branch_ID" = o."Office_ID" + 1000
FROM "EXCISE_OFFICE" o
WHERE o."Office_ID" = b."Office_ID" AND b."Branch_Name" = o."Office_Name"
  AND o."Parent_Office_ID" IS NOT NULL
  AND b."Branch_ID" <> o."Office_ID" + 1000
  AND NOT EXISTS (SELECT 1 FROM "BRANCH" x WHERE x."Branch_ID" = o."Office_ID" + 1000)
  AND NOT EXISTS (SELECT 1 FROM "TICKET" t WHERE t."Branch_ID" = b."Branch_ID")
  AND NOT EXISTS (SELECT 1 FROM "USER" u WHERE u."Branch_ID" = b."Branch_ID");

INSERT INTO "BRANCH" ("Branch_ID", "Office_ID", "Branch_Name")
SELECT o."Office_ID" + 1000, o."Office_ID", o."Office_Name"
FROM "EXCISE_OFFICE" o
WHERE o."Parent_Office_ID" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "BRANCH" b WHERE b."Office_ID" = o."Office_ID" AND b."Branch_Name" = o."Office_Name"
  );

-- sequence ต่อจาก MAX (ระบบเพิ่มสาขาใหม่จะได้ id ถัดไป ไม่ชนแถวข้างบน)
SELECT setval(pg_get_serial_sequence('"BRANCH"', 'Branch_ID'),
              (SELECT COALESCE(MAX("Branch_ID"), 0) + 1 FROM "BRANCH"), false);

COMMIT;

-- ตรวจผล (เรียงตามผัง): ทุกแถวต้องขึ้นต้นด้วยชื่อพื้นที่ของตัวเอง — แถวที่ ok = false คือข้อมูลแปลก
-- (เช่นรายการทดสอบที่เคยเพิ่มไว้) ให้แก้/ลบทางเมนู "ข้อมูลหลัก"
SELECT o."Office_Name" AS office, b."Branch_ID", b."Branch_Name",
       (b."Branch_Name" = o."Office_Name" OR b."Branch_Name" LIKE o."Office_Name" || ' %') AS ok
FROM "BRANCH" b JOIN "EXCISE_OFFICE" o ON o."Office_ID" = b."Office_ID"
ORDER BY o."Parent_Office_ID" NULLS FIRST, o."Office_Name" COLLATE "C", b."Branch_Name" COLLATE "C";
