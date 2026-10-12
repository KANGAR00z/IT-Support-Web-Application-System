// Compares the real backend (gas/*.gs on PGlite) with expectations computed straight from window.SEED.
// Each eq()/ok() is one check. Loaded by tests/index.html after the engine is ready.
const S = window.SEED;
const DAY = 864e5;
const fails = [];
let passes = 0;
const eq = (label, got, exp) => {
  const a = JSON.stringify(got), b = JSON.stringify(exp);
  if (a === b) passes++; else fails.push(label + '\n   got ' + a.slice(0, 400) + '\n   exp ' + b.slice(0, 400));
};
const ok = (label, cond) => { if (cond) passes++; else fails.push(label); };

const office = (id) => S.offices.find(o => o.id === id) || {};
const branch = (id) => S.branches.find(b => b.id === id) || {};
const user = (id) => S.users.find(u => u.id === id) || {};
const catName = (id) => (S.cats.find(c => c.id === id) || {}).name || '';
const active = S.tickets.filter(t => !t.deleted);
const ci = (s) => String(s || '').toLowerCase();

// ---------- board ----------
function expBoard(p, sub) {
  const now = Date.now();
  const match = (t) =>
    (!p.categoryId || t.cat === p.categoryId) &&
    (!p.province || String(office(t.office).prov || '').includes(p.province)) &&
    (!p.mine || t.it === sub) &&
    (!p.closedDays || t.status !== 3 || t.closed == null || t.closed >= now - p.closedDays * DAY) &&
    (!p.q || ci(['TK-' + t.id, t.detail, user(t.rep).name, t.it && user(t.it).name, t.branch && branch(t.branch).name,
      t.dept && S.depts[t.dept - 1], office(t.office).name, office(t.office).prov, catName(t.cat)].filter(Boolean).join(' ')).includes(ci(p.q)));
  const key = (t) => t.status === 3 ? (t.closed ?? t.created) : t.status === 2 ? (t.accepted ?? t.created) : t.created;
  return [1, 2, 3].map(s => {
    const all = active.filter(t => t.status === s);
    const items = all.filter(match).sort((a, b) => p.sort === 'old' ? (key(a) - key(b) || a.id - b.id) : (key(b) - key(a) || b.id - a.id));
    const size = p.pageSize || 20;
    const page = Math.min(p.pages[s] || 1, Math.max(1, Math.ceil(items.length / size)));
    return { status: s, page, total: items.length, all: all.length, ids: items.slice((page - 1) * size, page * size).map(t => t.id) };
  });
}
async function checkBoard(label, p, sub) {
  const params = Object.assign({ q: '', categoryId: 0, province: '', mine: false, closedDays: 7, sort: 'new', pageSize: 20, pages: { 1: 1, 2: 1, 3: 1 }, facets: false }, p);
  const r = await api('getBoard', params, sub);
  if (r.status !== 'success') return fails.push(label + ': ' + r.message);
  const got = r.columns.map(c => ({ status: c.status, page: c.page, total: c.total, all: c.all, ids: c.tickets.map(t => t.id) }));
  eq('board ' + label, got, expBoard(params, sub || 'Uadmin'));
  return r;
}
await checkBoard('default', {});
await checkBoard('closed all', { closedDays: 0 });
await checkBoard('closed all p2', { closedDays: 0, pages: { 1: 2, 2: 1, 3: 2 } });
await checkBoard('page clamp', { closedDays: 0, pages: { 1: 99, 2: 5, 3: 0 } });
await checkBoard('size 7 p3', { closedDays: 30, pageSize: 7, pages: { 1: 3, 2: 2, 3: 2 } });
await checkBoard('sort old', { sort: 'old', closedDays: 0, pages: { 1: 2, 2: 1, 3: 1 } });
await checkBoard('category 2', { categoryId: 2, closedDays: 0 });
await checkBoard('province สงขลา', { province: 'สงขลา', closedDays: 0 });
await checkBoard('province ยะลา', { province: 'ยะลา' });
await checkBoard('mine admin', { mine: true, closedDays: 0 });
await checkBoard('mine it', { mine: true, closedDays: 0 }, 'Uit');
await checkBoard('q TK-1', { q: 'TK-1', closedDays: 0 });
await checkBoard('q reporter', { q: 'นูรีดา', closedDays: 0 });
await checkBoard('q assignee', { q: 'วิชัย', closedDays: 0 });
await checkBoard('q branch', { q: 'สาขาเมืองตรัง', closedDays: 0 });
await checkBoard('q category', { q: 'hardware', closedDays: 0 });
await checkBoard('q dept', { q: 'ส่วนอำนวยการ', closedDays: 0 });
await checkBoard('q 50% literal', { q: '50%', closedDays: 0 });
await checkBoard('q underscore literal', { q: '_', closedDays: 0 });
await checkBoard('q no hit', { q: 'zzzz', closedDays: 0 });
await checkBoard('combined', { q: 'PR', categoryId: 3, province: 'สงขลา', closedDays: 30, sort: 'old' });
const f = await api('getBoard', { pages: { 1: 1, 2: 1, 3: 1 }, facets: true });
eq('board facets', f.categories, S.cats.map(c => ({ id: c.id, name: c.name })));
ok('board facets only when asked', !('categories' in (await api('getBoard', { pages: { 1: 1, 2: 1, 3: 1 } }))));
// ticket shape
const t1 = f.columns.find(c => c.tickets.length).tickets[0];
eq('ticket keys', Object.keys(t1).sort(), ['acceptedAt', 'assignee', 'branch', 'category', 'closedAt', 'code', 'createdAt', 'department', 'detail', 'id', 'office', 'pdfUrl', 'province', 'reporter', 'status'].sort());
ok('createdAt iso', /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{3})?[+-]\d\d:\d\d$/.test(t1.createdAt));
// legacy action is gone
const legacy = await api('getTickets', {});
ok('getTickets removed', legacy.status === 'error' && /ไม่พบคำสั่ง/.test(legacy.message));

// ---------- dashboard ----------
{
  const now = Date.now();
  const r = await api('getDashboard', { agingDays: 5 });
  const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
  const acc = active.filter(t => t.accepted != null).map(t => t.accepted - t.created);
  const cls = active.filter(t => t.closed != null).map(t => t.closed - t.created);
  const k = r.kpi;
  eq('dash counts', [k.total, k.open, k.prog, k.done, k.acceptN, k.closeN],
    [active.length, active.filter(t => t.status === 1).length, active.filter(t => t.status === 2).length, active.filter(t => t.status === 3).length, acc.length, cls.length]);
  ok('dash acceptAvg ' + k.acceptAvgMs + ' vs ' + mean(acc), Math.abs(k.acceptAvgMs - mean(acc)) < 2);
  ok('dash closeAvg', Math.abs(k.closeAvgMs - mean(cls)) < 2);
  eq('dash aging', k.aging, active.filter(t => t.status === 1 && t.created < now - 5 * DAY).length);
  const byName = (rows) => Object.fromEntries(rows.map(x => [x.name, x.n]));
  const expCats = {}; active.forEach(t => { expCats[catName(t.cat)] = (expCats[catName(t.cat)] || 0) + 1; });
  eq('dash categories', byName(r.categories), Object.fromEntries(Object.keys(byName(r.categories)).map(n => [n, expCats[n]])));
  eq('dash categories sum', r.categories.reduce((s, x) => s + x.n, 0), active.length);
  const expStaff = {}; active.filter(t => t.it).forEach(t => { const n = user(t.it).name; expStaff[n] = (expStaff[n] || 0) + 1; });
  eq('dash staff', byName(r.staff), Object.fromEntries(Object.keys(byName(r.staff)).map(n => [n, expStaff[n]])));
  const expProv = {}; active.forEach(t => { const o = office(t.office); const key = o.prov + '|' + o.name; expProv[key] = (expProv[key] || 0) + 1; });
  eq('dash provinces', Object.fromEntries(r.provinces.map(x => [x.province + '|' + x.office, x.n]).sort()), Object.fromEntries(Object.entries(expProv).sort()));
  eq('dash oldest', r.oldest.map(t => t.code), active.filter(t => t.status === 1).sort((a, b) => a.created - b.created).slice(0, 6).map(t => 'TK-' + t.id));
  eq('dash oldest createdAt', r.oldest.map(t => Date.parse(t.createdAt)), active.filter(t => t.status === 1).sort((a, b) => a.created - b.created).slice(0, 6).map(t => t.created));
  const bkk = (ms) => new Date(ms + 7 * 3600e3).toISOString().slice(0, 10);
  const expTrend = {}; active.filter(t => t.created >= now - 32 * DAY).forEach(t => { expTrend[bkk(t.created)] = (expTrend[bkk(t.created)] || 0) + 1; });
  eq('dash trend', Object.fromEntries(r.trend.map(x => [x.d, x.n]).sort()), Object.fromEntries(Object.entries(expTrend).sort()));
  const r3 = await api('getDashboard', { agingDays: 3 });
  eq('dash aging 3', r3.kpi.aging, active.filter(t => t.status === 1 && t.created < now - 3 * DAY).length);
  const rBad = await api('getDashboard', { agingDays: 'x' });
  eq('dash aging default', rBad.kpi.aging, r3.kpi.aging);
}

// ---------- users ----------
function expUsers(p) {
  p = Object.assign({}, p, { role: ['admin', 'it', 'staff'].includes(ci(p.role)) ? ci(p.role) : '' });   // server: lowercase, unknown = all
  const role = (u) => u.role.toLowerCase();
  const w = { admin: 0, it: 1 };
  const list = S.users
    .filter(u => !p.role || (p.role === 'staff' ? !['admin', 'it'].includes(role(u)) : role(u) === p.role))
    .filter(u => !p.q || ci([u.name, u.pos, office(branch(u.branch).office).name, branch(u.branch).name, S.depts[u.dept - 1]].join(' ')).includes(ci(p.q)))
    .sort((a, b) => ((w[role(a)] ?? 2) - (w[role(b)] ?? 2)) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (a.id < b.id ? -1 : 1));
  const size = p.pageSize || 20;
  const page = Math.min(p.page || 1, Math.max(1, Math.ceil(list.length / size)));
  return { total: list.length, page, ids: list.slice((page - 1) * size, page * size).map(u => u.id) };
}
async function checkUsers(label, p) {
  const params = Object.assign({ q: '', role: '', page: 1, pageSize: 20 }, p);
  const r = await api('getUsers', params);
  if (r.status !== 'success') return fails.push('users ' + label + ': ' + r.message);
  eq('users ' + label, { total: r.total, page: r.page, ids: r.users.map(u => u.userId) }, expUsers(params));
  return r;
}
const u1 = await checkUsers('p1', {});
await checkUsers('p2', { page: 2 });
await checkUsers('p3', { page: 3 });
await checkUsers('clamp', { page: 50 });
await checkUsers('role it', { role: 'it' });
await checkUsers('role staff p2', { role: 'staff', page: 2 });
await checkUsers('role admin', { role: 'ADMIN' });
await checkUsers('bad role = all', { role: 'boss' });
await checkUsers('q branch', { q: 'สาขาเมืองสตูล' });
await checkUsers('q pos', { q: 'นักตรวจสอบ' });
await checkUsers('q 50%', { q: '50%' });
await checkUsers('q _', { q: '_' });
await checkUsers('size 50 cap', { pageSize: 500 });
eq('users counts', u1.counts, { all: S.users.length, admin: 1, it: 2, staff: S.users.length - 3 });
{
  const r = await api('getUsers', { page: 1, pageSize: 50 });
  const bad = r.users.filter(u => {
    const exp = [active.filter(t => t.rep === u.userId).length, active.filter(t => t.it === u.userId).length];
    return u.reported !== exp[0] || u.assigned !== exp[1];
  });
  eq('users reported/assigned', bad.map(u => u.userId), []);
  const deniedForIt = await api('getUsers', {}, 'Uit');
  ok('users ACL admin only', deniedForIt.status === 'error');
}

// ---------- knowledge base ----------
function expKb(p) {
  p = Object.assign({}, p, { categoryId: p.categoryId === 'none' ? 'none' : (parseInt(p.categoryId, 10) || 0) });   // server: toId_
  const list = S.kb
    .filter(k => !p.categoryId || (p.categoryId === 'none' ? k.cat == null : k.cat === p.categoryId))
    .filter(k => { const t = S.tickets.find(x => x.id === k.ticket); return !p.q || ci(['TK-' + k.ticket, t.detail, k.text].join(' ')).includes(ci(p.q)); })
    .sort((a, b) => (b.created - a.created) || (b.id - a.id));
  const size = p.pageSize || 20;
  const page = Math.min(p.page || 1, Math.max(1, Math.ceil(list.length / size)));
  return { total: list.length, page, ids: list.slice((page - 1) * size, page * size).map(k => k.id) };
}
async function checkKb(label, p) {
  const params = Object.assign({ q: '', categoryId: 0, page: 1, pageSize: 20, facets: false }, p);
  const r = await api('getKnowledgeBase', params);
  if (r.status !== 'success') return fails.push('kb ' + label + ': ' + r.message);
  eq('kb ' + label, { total: r.total, page: r.page, ids: r.articles.map(a => a.id) }, expKb(params));
  return r;
}
const k1 = await checkKb('p1 facets', { facets: true });
await checkKb('p2', { page: 2 });
await checkKb('clamp', { page: 9 });
await checkKb('cat 3', { categoryId: 3 });
await checkKb('cat none', { categoryId: 'none' });
await checkKb('cat string id', { categoryId: '2' });
await checkKb('q ticket', { q: 'TK-2' });
await checkKb('q text', { q: 'รอบสอง' });
await checkKb('q 50%', { q: '50%' });
await checkKb('size 5 p4', { pageSize: 5, page: 4 });
{
  const exp = {}; S.kb.forEach(k => { const key = k.cat == null ? 'null' : k.cat; exp[key] = (exp[key] || 0) + 1; });
  eq('kb facets', Object.fromEntries(k1.categories.map(c => [c.id == null ? 'null' : c.id, c.n]).sort()), Object.fromEntries(Object.entries(exp).sort()));
  ok('kb facet name for null', k1.categories.find(c => c.id == null).name === '');
  ok('kb facets only when asked', !('categories' in (await api('getKnowledgeBase', { page: 1 }))));
}

// ---------- writes invalidate the cached pages ----------
{
  const before = await api('getBoard', { closedDays: 0, pages: { 1: 1, 2: 1, 3: 1 } });
  const openId = before.columns[0].tickets[0].id;
  const acc = await api('acceptTicket', { ticketId: openId }, 'Uit');
  ok('accept ok ' + JSON.stringify(acc), acc.status === 'success');
  const after = await api('getBoard', { closedDays: 0, pages: { 1: 1, 2: 1, 3: 1 } });
  ok('board refreshed after write', !after.columns[0].tickets.some(t => t.id === openId) && after.columns[1].tickets[0].id === openId);
  eq('board counts after write', after.columns.map(c => c.all), [before.columns[0].all - 1, before.columns[1].all + 1, before.columns[2].all]);
  const mineIt = await api('getBoard', { mine: true, closedDays: 0, pages: { 1: 1, 2: 1, 3: 1 } }, 'Uit');
  const mineAdmin = await api('getBoard', { mine: true, closedDays: 0, pages: { 1: 1, 2: 1, 3: 1 } }, 'Uadmin');
  ok('mine cached per user', mineIt.columns[1].tickets[0].id === openId && !mineAdmin.columns[1].tickets.some(t => t.id === openId));
  const dash = await api('getDashboard', { agingDays: 3 });
  eq('dash after write', [dash.kpi.open, dash.kpi.prog], [before.columns[0].all - 1, before.columns[1].all + 1]);
  // restore so the seed expectations stay valid
  await api('updateTicketStatus', { ticketId: openId, status: 1 });
  const back = await api('getBoard', { closedDays: 0, pages: { 1: 1, 2: 1, 3: 1 } });
  eq('restored', back.columns.map(c => c.all), before.columns.map(c => c.all));
}

window.__testResult = { passes, fails };
export default { passes, fails };
