/* =============================================================================
   FAST TICKET Worker · db.js — ห่อไดรเวอร์ Postgres ให้ repo.js ใช้แบบเดียวกันทุกที่
   -----------------------------------------------------------------------------
   รูปแบบที่ repo.js ใช้: db.q(text, params) -> Promise<rows> · db.tx(async (tx) => result)
   tx: result.status === 'error' (ตรวจแล้วไม่ผ่าน) = rollback ด้วย เหมือน withTx_ ของ GAS
   ============================================================================= */
import postgres from 'postgres';

class Rollback {
  constructor(result) { this.result = result; }
}

function wrap(sql) {
  return {
    q: (text, params = []) => sql.unsafe(text, params),
    tx: async (fn) => {
      try {
        return await sql.begin(async (t) => {
          const result = await fn(wrap(t));
          if (result && result.status === 'error') throw new Rollback(result);
          return result;
        });
      } catch (e) {
        if (e instanceof Rollback) return e.result;
        throw e;
      }
    },
  };
}

// สร้างใหม่ทุก request (คำแนะนำของ Cloudflare) — Hyperdrive ถือ connection pool ไว้ให้ฝั่ง DB อยู่แล้ว
// fetch_types: false = ไม่ต้องถามชนิดข้อมูลจาก DB ก่อนทุก request (ประหยัดไป-กลับ 1 รอบ)
export function connect(connectionString) {
  const sql = postgres(connectionString, { max: 5, fetch_types: false });
  return Object.assign(wrap(sql), { end: () => sql.end() });
}
