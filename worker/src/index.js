/* =============================================================================
   FAST TICKET Worker · index.js — จุดเข้า: รับ POST จากหน้าเว็บ -> handle() -> JSON
   -----------------------------------------------------------------------------
   รับเหมือน GAS ทุกอย่าง: POST body = JSON string { action, idToken, data } แบบ text/plain
   (หน้าเว็บส่ง text/plain = CORS "simple request" ไม่มี preflight — ดู CLAUDE.md 2.1)
   ทุกคำตอบเป็น HTTP 200 + { status: 'success' | 'error', ... } เหมือน GAS — หน้าเว็บไม่ต้องแยกกรณี
   ============================================================================= */
import { handle, lineVerifier } from './api.js';
import { connect } from './db.js';

// token อยู่ใน body ไม่ใช่ cookie -> เปิดให้ทุก origin ได้ (LIFF / localhost ตอนทดสอบ)
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

const json = (obj) => new Response(JSON.stringify(obj), {
  headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method === 'GET') return json({ status: 'success', message: '✅ FAST TICKET API (Cloudflare Worker) พร้อมทำงาน' });
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: CORS });

    const db = connect(env.HYPERDRIVE.connectionString);
    try {
      const body = await request.text();
      return json(await handle(body, { db, verifyToken: lineVerifier(env.LIFF_CHANNEL_ID) }));
    } finally {
      ctx.waitUntil(db.end());   // ปิดหลังส่งคำตอบไปแล้ว ไม่ให้ผู้ใช้รอ
    }
  },
};
