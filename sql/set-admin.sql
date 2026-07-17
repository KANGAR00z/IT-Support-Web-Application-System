-- =============================================================================
-- FAST TICKET · ตั้งสิทธิ์ admin ให้เจ้าหน้าที่ IT
-- รันใน Supabase → SQL Editor
-- หมายเหตุ: ตาราง USER เป็น reserved word ของ Postgres ต้องใส่ double quote เสมอ
--           ชื่อคอลัมน์มีตัวพิมพ์ใหญ่ ก็ต้อง quote เช่นกัน
-- =============================================================================

-- 1) ดูข้อมูลผู้ใช้ก่อนแก้ (เช็คว่ามี record นี้จริงไหม + Role ปัจจุบันคืออะไร)
SELECT "LINE_User_ID", "Full_Name", "Position", "Role", "Dept_ID"
FROM public."USER"
WHERE "LINE_User_ID" = 'U952f17025df2d3d3cd4b36d8a4e7a443';

-- 2) ตั้งเป็น admin
--    ⚠️ ค่า 'admin' ต้องตรงกับที่ Code.gs ฝั่ง backend ใช้ตรวจสิทธิ์
--       ถ้า Code.gs เช็คเป็น 'IT' หรือ 'ADMIN' ให้แก้ค่าตรงนี้ให้ตรงกัน
UPDATE public."USER"
SET "Role" = 'admin'
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
-- VALUES ('U952f17025df2d3d3cd4b36d8a4e7a443', 'ชื่อ นามสกุล', 'เจ้าหน้าที่ไอที', 'admin', 5);

-- -----------------------------------------------------------------------------
-- ดูรายชื่อ admin ทั้งหมด (ใช้ตอนจะเอา userId ไปใส่ RM.IT_STAFF_USER_IDS)
-- -----------------------------------------------------------------------------
-- SELECT "LINE_User_ID", "Full_Name" FROM public."USER" WHERE "Role" = 'admin';
