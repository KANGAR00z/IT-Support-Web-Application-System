-- =============================================================================
-- FAST TICKET · ตั้งสิทธิ์ admin ให้เจ้าหน้าที่ IT
-- รันใน Supabase → SQL Editor
-- หมายเหตุ: ตาราง USER เป็น reserved word ของ Postgres ต้องใส่ double quote เสมอ
--           ชื่อคอลัมน์มีตัวพิมพ์ใหญ่ ก็ต้อง quote เช่นกัน
--
-- ⚠️ คอลัมน์ "Role" มี CHECK constraint ชื่อ USER_Role_check บังคับค่าต้องเป็น
--    'Staff' / 'IT' / 'Admin' เป๊ะ (ตัวพิมพ์นี้เท่านั้น) — ยืนยันจาก:
--      SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'USER_Role_check';
--    ใส่ค่าอื่น (เช่น 'admin' ตัวเล็ก) จะโดน error 23514 ทันที
-- =============================================================================

-- 1) ดูข้อมูลผู้ใช้ก่อนแก้ (เช็คว่ามี record นี้จริงไหม + Role ปัจจุบันคืออะไร)
SELECT "LINE_User_ID", "Full_Name", "Position", "Role", "Dept_ID"
FROM public."USER"
WHERE "LINE_User_ID" = 'U952f17025df2d3d3cd4b36d8a4e7a443';

-- 2) ตั้งเป็น admin — ต้องเป็น 'Admin' ตัวใหญ่ตาม check constraint
UPDATE public."USER"
SET "Role" = 'Admin'
WHERE "LINE_User_ID" = 'U952f17025df2d3d3cd4b36d8a4e7a443';

-- 3) ยืนยันผลลัพธ์
SELECT "LINE_User_ID", "Full_Name", "Role"
FROM public."USER"
WHERE "LINE_User_ID" = 'U952f17025df2d3d3cd4b36d8a4e7a443';

-- -----------------------------------------------------------------------------
-- ถ้ายังไม่มี record ของ user นี้ (ข้อ 1 ไม่เจอ) ให้ INSERT ก่อน แล้วค่อยรันข้อ 2
-- แก้ Full_Name / Position / Dept_ID ให้ตรงความจริง
-- -----------------------------------------------------------------------------
-- INSERT INTO public."USER" ("LINE_User_ID", "Full_Name", "Position", "Role", "Dept_ID")
-- VALUES ('U952f17025df2d3d3cd4b36d8a4e7a443', 'ชื่อ นามสกุล', 'เจ้าหน้าที่ไอที', 'Admin', 5);

-- -----------------------------------------------------------------------------
-- ดูรายชื่อ admin ทั้งหมด (ใช้ตอนจะเอา userId ไปใส่ RM.IT_STAFF_USER_IDS)
-- -----------------------------------------------------------------------------
-- SELECT "LINE_User_ID", "Full_Name" FROM public."USER" WHERE "Role" = 'Admin';
