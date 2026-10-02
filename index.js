import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';

const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, PORT = 5000,
  CLIENT_URL = 'http://localhost:5173', TIMEZONE = 'Africa/Lagos' } = process.env;
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, opts);
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE }); // YYYY-MM-DD

const app = express();
app.use(cors({ origin: CLIENT_URL.split(',') }));
app.use(express.json());

app.get('/', (req, res) => res.json({ message: 'Boutique API is running', api: '/api' }));

const fail = (status, msg) => { throw Object.assign(new Error(msg), { status }); };
const h = (fn) => (req, res) => fn(req, res).catch((e) => res.status(e.status || 400).json({ error: e.message }));
const ok = ({ data, error }) => { if (error) fail(400, error.message); return data; };

// Verifies the Supabase token, loads the profile, checks role.
const guard = (...roles) => async (req, res, next) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) return res.status(401).json({ error: 'Please sign in again' });
  const { data: p } = await db.from('profiles').select('*').eq('id', data.user.id).single();
  if (!p || !p.active) return res.status(403).json({ error: 'Account disabled' });
  if (roles.length && !roles.includes(p.role)) return res.status(403).json({ error: 'Not allowed' });
  req.user = p; next();
};
const admin = guard('admin'), anyone = guard();

// ---------- Auth ----------
app.post('/api/auth/login', h(async (req, res) => {
  const { email, password } = req.body;
  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, opts);
  const { data, error } = await anon.auth.signInWithPassword({ email, password });
  if (error) fail(401, 'Wrong email or password');
  const { data: p } = await db.from('profiles').select('*').eq('id', data.user.id).single();
  if (!p) fail(403, 'No profile for this account');
  if (!p.active) fail(403, 'This account has been disabled');
  await db.from('login_logs').insert({ user_id: p.id, full_name: p.full_name, email: p.email, role: p.role });
  res.json({ token: data.session.access_token, user: p });
}));

// ---------- Admin: staff, logins, stats ----------
app.get('/api/staff', admin, h(async (req, res) => {
  const staff = ok(await db.from('profiles').select('*').eq('role', 'staff').order('created_at', { ascending: false }));
  const logs = ok(await db.from('login_logs').select('user_id,logged_in_at').order('logged_in_at', { ascending: false }).limit(1000));
  res.json(staff.map((s) => ({ ...s, last_login: logs.find((l) => l.user_id === s.id)?.logged_in_at || null })));
}));
app.post('/api/staff', admin, h(async (req, res) => {
  const { full_name, email, password } = req.body;
  if (!full_name || !email || !password || password.length < 6) fail(400, 'Name, email and a password of 6+ characters are required');
  const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) fail(400, error.message);
  const { error: e2 } = await db.from('profiles').insert({ id: data.user.id, full_name, email, role: 'staff' });
  if (e2) { await db.auth.admin.deleteUser(data.user.id); fail(400, e2.message); }
  res.status(201).json({ id: data.user.id });
}));
app.patch('/api/staff/:id', admin, h(async (req, res) => {
  const { active, password } = req.body;
  if (password) { if (password.length < 6) fail(400, 'Password must be 6+ characters'); ok(await db.auth.admin.updateUserById(req.params.id, { password })); }
  if (typeof active === 'boolean') ok(await db.from('profiles').update({ active }).eq('id', req.params.id).eq('role', 'staff'));
  res.json({ done: true });
}));
app.get('/api/logins', admin, h(async (req, res) =>
  res.json(ok(await db.from('login_logs').select('*').order('logged_in_at', { ascending: false }).limit(200)))));
app.get('/api/stats', admin, h(async (req, res) => {
  const sales = ok(await db.from('sales').select('*').eq('sale_date', today()).order('sold_at', { ascending: false }));
  const { count: pending } = await db.from('reports').select('id', { count: 'exact', head: true }).eq('status', 'pending');
  const low = ok(await db.from('products').select('id,name,stock').eq('active', true).lte('stock', 3).order('stock'));
  res.json({ items: sales.reduce((a, s) => a + s.quantity, 0), revenue: sales.reduce((a, s) => a + Number(s.total), 0), pending, low, sales });
}));

// ---------- Products ----------
app.get('/api/products', anyone, h(async (req, res) =>
  res.json(ok(await db.from('products').select('*').eq('active', true).order('name')))));
const prodFields = ({ name, category, price, stock, image_url }) =>
  Object.fromEntries(Object.entries({ name, category, price, stock, image_url }).filter(([, v]) => v !== undefined));
app.post('/api/products', admin, h(async (req, res) => {
  const f = prodFields(req.body);
  if (!f.name || f.price === undefined) fail(400, 'Name and price are required');
  res.status(201).json(ok(await db.from('products').insert(f).select().single()));
}));
app.put('/api/products/:id', admin, h(async (req, res) =>
  res.json(ok(await db.from('products').update(prodFields(req.body)).eq('id', req.params.id).select().single()))));
app.delete('/api/products/:id', admin, h(async (req, res) => { // soft delete keeps sales history intact
  ok(await db.from('products').update({ active: false }).eq('id', req.params.id)); res.json({ done: true });
}));

// ---------- Sales (staff) ----------
app.post('/api/sales', guard('staff'), h(async (req, res) => {
  const qty = parseInt(req.body.quantity || 1, 10);
  if (!(qty > 0)) fail(400, 'Quantity must be at least 1');
  res.status(201).json(ok(await db.rpc('sell_product', { p_product: req.body.product_id, p_staff: req.user.id, p_qty: qty, p_date: today() })));
}));
app.get('/api/sales/today', guard('staff'), h(async (req, res) =>
  res.json(ok(await db.from('sales').select('*').eq('staff_id', req.user.id).eq('sale_date', today()).order('sold_at', { ascending: false })))));

// ---------- Reports ----------
app.post('/api/reports', guard('staff'), h(async (req, res) => {
  const sales = ok(await db.from('sales').select('*').eq('staff_id', req.user.id).eq('sale_date', today()).is('report_id', null));
  if (!sales.length) fail(400, 'No unreported sales for today');
  const report = ok(await db.from('reports').insert({
    staff_id: req.user.id, staff_name: req.user.full_name, report_date: today(), note: req.body.note || null,
    total_items: sales.reduce((a, s) => a + s.quantity, 0), total_amount: sales.reduce((a, s) => a + Number(s.total), 0),
  }).select().single());
  ok(await db.from('sales').update({ report_id: report.id }).in('id', sales.map((s) => s.id)));
  res.status(201).json(report);
}));
app.get('/api/reports', anyone, h(async (req, res) => {
  let q = db.from('reports').select('*').order('submitted_at', { ascending: false }).limit(200);
  if (req.user.role === 'staff') q = q.eq('staff_id', req.user.id);
  res.json(ok(await q));
}));
app.get('/api/reports/:id', anyone, h(async (req, res) => {
  const report = ok(await db.from('reports').select('*').eq('id', req.params.id).single());
  if (req.user.role === 'staff' && report.staff_id !== req.user.id) fail(403, 'Not allowed');
  const sales = ok(await db.from('sales').select('*').eq('report_id', report.id).order('sold_at'));
  res.json({ ...report, sales });
}));
app.patch('/api/reports/:id', admin, h(async (req, res) => {
  const { status, admin_comment } = req.body;
  if (!['approved', 'rejected'].includes(status)) fail(400, 'Status must be approved or rejected');
  const r = ok(await db.from('reports').update({ status, admin_comment: admin_comment || null, reviewed_at: new Date().toISOString() })
    .eq('id', req.params.id).eq('status', 'pending').select().single());
  // Rejected: free the sales so the staff member can fix things and send a new report.
  if (status === 'rejected') await db.from('sales').update({ report_id: null }).eq('report_id', r.id);
  res.json(r);
}));

if (!process.env.VERCEL) {
  app.listen(PORT, () => console.log(`API running on http://localhost:${PORT}`));
}

export default app;
