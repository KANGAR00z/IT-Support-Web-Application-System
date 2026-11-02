// ไฟล์ config.js สำหรับตั้งค่าระบบ FAST TICKET

const MY_LIFF_ID = "2010392375-KFCzC8ai";
const GAS_API_URL = "https://script.google.com/macros/s/AKfycbylMdD3PyCDA8R5ukx-yx3wjkETfSInEImCAW6Co3kAX8u670vD9mxOXh24AP2_/exec";

// API บน Cloudflare Workers (worker/) — ตั้งแล้วคำสั่งอ่าน/เขียนฐานข้อมูลไปที่นี่ (เร็วกว่า GAS หลายเท่า)
// ส่วนที่ใช้ Google Drive (สร้าง PDF / บันทึกตั๋วพร้อมรูป / ลบ PDF ร่าง) ยังไป GAS เสมอ
// ว่าง = ใช้ GAS ทั้งหมดเหมือนเดิม (ถอยกลับได้ทันทีถ้า Worker มีปัญหา)
const WORKER_API_URL = "";

// LIFF app ตัวที่ 2 สำหรับหน้า Admin (endpoint ชี้มาที่ admin.html)
// สร้างใน LINE Developers console แล้วเอา LIFF ID มาใส่ตรงนี้
// ถ้ายังว่าง admin.html จะ fallback ไปใช้ MY_LIFF_ID (ยังทำงานได้ ไม่พัง)
const ADMIN_LIFF_ID = "2010392375-HlUu2ekR";

// LIFF app สำหรับหน้าประวัติการแจ้งซ่อม (history.html)
const HISTORY_LIFF_ID = "2010392375-KVcQdFos";