-- =============================================================================
-- FAST TICKET · เปลี่ยนชื่อตารางให้ตรงความหมาย + ยกเลิกงาน (soft delete)
-- -----------------------------------------------------------------------------
--   เดิม                       ->  ใหม่
--   BRANCH     (พื้นที่)        ->  EXCISE_OFFICE : Branch_ID -> Office_ID, Branch_Name -> Office_Name
--   DEPARTMENT (สาขา)          ->  BRANCH        : Dept_ID -> Branch_ID, Branch_ID -> Office_ID,
--                                                 Dept_Name -> Branch_Name
--   SECTION    (ส่วน)           ->  DEPARTMENT    : Section_ID -> Dept_ID, Section_Name -> Dept_Name
--   TICKET : Branch_ID -> Office_ID · Dept_ID -> Branch_ID · Section_ID -> Dept_ID
--   USER   : Dept_ID -> Branch_ID · Section_ID -> Dept_ID
--   + TICKET.Deleted_At / Deleted_By  (Admin ยกเลิกงาน — แถวยังอยู่ กู้คืนได้)
--
-- ⚠️ ชื่อ BRANCH / DEPARTMENT / Branch_ID / Dept_ID ถูกใช้ซ้ำในความหมายใหม่ ลำดับข้างล่างจึงสำคัญ:
--    ต้องย้ายชื่อเดิมออกก่อนเสมอ (ทำทีละชั้น พื้นที่ -> สาขา -> ส่วน) ไม่งั้นชื่อชนกัน
-- FK / identity sequence / RLS / CHECK ตามไปเองเมื่อเปลี่ยนชื่อ (Postgres อ้างด้วย OID ไม่ใช่ชื่อ)
--
-- ⚠️ ต้องรัน sql/2026-10-06-section.sql ให้ผ่านก่อน (ไฟล์นี้เช็คให้)
-- ⚠️ หลังรันไฟล์นี้ GAS เวอร์ชันเก่าใช้ไม่ได้ทันที (อ้างชื่อเดิม) -> deploy GAS ชุดใหม่ต่อทันที
--    ลำดับ: รันไฟล์นี้ -> วาง/deploy GAS -> อัป DEMO/ ขึ้น Cloudflare
-- รันซ้ำได้: ถ้าเปลี่ยนชื่อไปแล้วจะข้ามส่วนนั้น · ผิดพลาดตรงไหน = ย้อนกลับทั้งหมด
--
-- กู้คืนงานที่ถูกยกเลิก:
--   UPDATE "TICKET" SET "Deleted_At" = NULL, "Deleted_By" = NULL WHERE "Ticket_ID" = <เลขงาน>;
-- =============================================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('public."EXCISE_OFFICE"') IS NULL THEN
    IF to_regclass('public."SECTION"') IS NULL THEN
      RAISE EXCEPTION 'ยังไม่มีตาราง SECTION — รัน sql/2026-10-06-section.sql ก่อน';
    END IF;

    -- 1) คอลัมน์อ้างอิงใน TICKET / USER — ย้ายจากชั้นบนลงล่าง ชื่อจะได้ว่างก่อนถูกใช้
    ALTER TABLE "TICKET" RENAME COLUMN "Branch_ID"  TO "Office_ID";
    ALTER TABLE "TICKET" RENAME COLUMN "Dept_ID"    TO "Branch_ID";
    ALTER TABLE "TICKET" RENAME COLUMN "Section_ID" TO "Dept_ID";
    ALTER TABLE "USER"   RENAME COLUMN "Dept_ID"    TO "Branch_ID";
    ALTER TABLE "USER"   RENAME COLUMN "Section_ID" TO "Dept_ID";

    -- 2) พื้นที่: BRANCH -> EXCISE_OFFICE (ทำก่อน ชื่อ BRANCH จะได้ว่างให้ตารางสาขา)
    ALTER TABLE "BRANCH" RENAME COLUMN "Branch_ID"   TO "Office_ID";
    ALTER TABLE "BRANCH" RENAME COLUMN "Branch_Name" TO "Office_Name";
    ALTER TABLE "BRANCH" RENAME TO "EXCISE_OFFICE";

    -- 3) สาขา: DEPARTMENT -> BRANCH (Branch_ID -> Office_ID ก่อน ไม่งั้นชนกับ Dept_ID -> Branch_ID)
    ALTER TABLE "DEPARTMENT" RENAME COLUMN "Branch_ID" TO "Office_ID";
    ALTER TABLE "DEPARTMENT" RENAME COLUMN "Dept_ID"   TO "Branch_ID";
    ALTER TABLE "DEPARTMENT" RENAME COLUMN "Dept_Name" TO "Branch_Name";
    ALTER TABLE "DEPARTMENT" RENAME TO "BRANCH";

    -- 4) ส่วน: SECTION -> DEPARTMENT (ชื่อ DEPARTMENT เพิ่งว่างจากข้อ 3)
    ALTER TABLE "SECTION" RENAME COLUMN "Section_ID"   TO "Dept_ID";
    ALTER TABLE "SECTION" RENAME COLUMN "Section_Name" TO "Dept_Name";
    ALTER TABLE "SECTION" RENAME TO "DEPARTMENT";

    -- 5) ชื่อ primary key ให้ตรงตาราง (error "duplicate key ..._pkey" จะได้ไม่ชี้ผิดตาราง) — ลำดับเดียวกัน
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BRANCH_pkey' AND conrelid = '"EXCISE_OFFICE"'::regclass) THEN
      ALTER TABLE "EXCISE_OFFICE" RENAME CONSTRAINT "BRANCH_pkey" TO "EXCISE_OFFICE_pkey";
    END IF;
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DEPARTMENT_pkey' AND conrelid = '"BRANCH"'::regclass) THEN
      ALTER TABLE "BRANCH" RENAME CONSTRAINT "DEPARTMENT_pkey" TO "BRANCH_pkey";
    END IF;
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SECTION_pkey' AND conrelid = '"DEPARTMENT"'::regclass) THEN
      ALTER TABLE "DEPARTMENT" RENAME CONSTRAINT "SECTION_pkey" TO "DEPARTMENT_pkey";
    END IF;

    -- 6) index ของ TICKET (ลำดับเดียวกัน กันชื่อชน)
    ALTER INDEX IF EXISTS idx_ticket_branch  RENAME TO idx_ticket_office;
    ALTER INDEX IF EXISTS idx_ticket_dept    RENAME TO idx_ticket_branch;
    ALTER INDEX IF EXISTS idx_ticket_section RENAME TO idx_ticket_dept;
  END IF;
END $$;

-- ยกเลิกงาน (soft delete): ซ่อนจากบอร์ด แต่ข้อมูลและ PDF ยังอยู่ครบ
ALTER TABLE "TICKET" ADD COLUMN IF NOT EXISTS "Deleted_At" timestamptz;
ALTER TABLE "TICKET" ADD COLUMN IF NOT EXISTS "Deleted_By" varchar(50)
  REFERENCES "USER" ("LINE_User_ID");

COMMIT;

-- ตรวจผล: EXCISE_OFFICE(Office_ID, Office_Name, Province) · BRANCH(Branch_ID, Office_ID, Branch_Name)
--         DEPARTMENT(Dept_ID, Dept_Name) · TICKET มี Office_ID, Branch_ID, Dept_ID, Deleted_At, Deleted_By
--         USER มี Branch_ID, Dept_ID
SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name IN ('EXCISE_OFFICE', 'BRANCH', 'DEPARTMENT', 'TICKET', 'USER')
ORDER BY table_name, ordinal_position;
