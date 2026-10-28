import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import nodemailer from 'nodemailer';
import { createClient } from '@supabase/supabase-js';

const {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY,
  PORT = 5000,
  CLIENT_URL = 'http://localhost:5173',
  TIMEZONE = 'Africa/Lagos',
} = process.env;

const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const STAFF_LOGIN_URL =
  process.env.STAFF_LOGIN_URL ||
  `${CLIENT_URL.split(',')[0].replace(/\/$/, '')}/login`;

const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, opts);
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE });

const app = express();
app.use(cors({ origin: CLIENT_URL.split(',') }));
app.use(express.json({ limit: '10mb' }));

app.get('/', (req, res) =>
  res.json({ message: 'Dranks API is running', api: '/api' })
);

// ---------- Helpers ----------
const fail = (status, msg) => {
  throw Object.assign(new Error(msg), { status });
};
const h = (fn) => (req, res) =>
  fn(req, res).catch((e) => res.status(e.status || 400).json({ error: e.message }));
const ok = ({ data, error }) => {
  if (error) fail(400, error.message);
  return data;
};

const isAdmin = (u) => u?.role === 'admin';
const branchFor = (user, req) => {
  if (!isAdmin(user)) return user.branch_id ?? null;
  const raw = req.query.branch_id ?? req.body?.branch_id;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
};
const scope = (q, branchId, col = 'branch_id') =>
  branchId == null ? q : q.eq(col, branchId);

const recordActivity = async (
  actor,
  { action, description, amount = null, entityType = null, entityId = null, branchId }
) =>
  ok(
    await db.from('activity_logs').insert({
      actor_id: actor.id,
      staff_name: actor.full_name,
      actor_role: actor.role,
      action,
      description,
      amount,
      entity_type: entityType,
      entity_id: entityId,
      branch_id: branchId ?? actor.branch_id ?? null,
    })
  );

async function sendStaffWelcomeEmail({ full_name, email, password, branch_name }) {
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
    return {
      sent: false,
      message: 'Configure GMAIL_USER and GMAIL_APP_PASSWORD to enable email.',
    };
  }
  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
    });
    await transporter.sendMail({
      from: { name: 'Dranks', address: GMAIL_USER },
      to: email,
      subject: 'Welcome to Dranks: your staff account is ready',
      text:
        `Hello ${full_name},\n\n` +
        `Your staff account with Dranks has been created. Welcome to Dranks!\n\n` +
        (branch_name ? `Branch: ${branch_name}\n` : '') +
        `Login email: ${email}\n` +
        `Login password: ${password}\n` +
        `Sign in here: ${STAFF_LOGIN_URL}\n\n` +
        `Keep your login details private.`,
    });
    return { sent: true };
  } catch {
    return {
      sent: false,
      message: 'Email delivery failed. Check the Gmail address and App Password.',
    };
  }
}

// ---------- Auth guard ----------
const guard = (...roles) => async (req, res, next) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user)
    return res.status(401).json({ error: 'Please sign in again' });

  const { data: p } = await db
    .from('profiles')
    .select('*')
    .eq('id', data.user.id)
    .single();

  if (!p || !p.active) return res.status(403).json({ error: 'Account disabled' });
  if (roles.length && !roles.includes(p.role))
    return res.status(403).json({ error: 'Not allowed' });

  req.user = p;
  req.branchId = branchFor(p, req);
  next();
};
const admin = guard('admin');
const anyone = guard();

// ---------- Auth ----------
app.post(
  '/api/auth/login',
  h(async (req, res) => {
    const { email, password } = req.body;
    const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, opts);
    const { data, error } = await anon.auth.signInWithPassword({ email, password });
    if (error) fail(401, 'Wrong email or password');

    const { data: p } = await db
      .from('profiles')
      .select('*')
      .eq('id', data.user.id)
      .single();
    if (!p) fail(403, 'No profile for this account');
    if (!p.active) fail(403, 'This account has been disabled');
    if (p.role === 'staff' && !p.branch_id)
      fail(403, 'Your account has not been assigned to a branch. Contact your admin.');

    let branch_name = null;
    if (p.branch_id) {
      const { data: b } = await db
        .from('branches')
        .select('name')
        .eq('id', p.branch_id)
        .single();
      branch_name = b?.name ?? null;
    }

    await db.from('login_logs').insert({
      user_id: p.id,
      full_name: p.full_name,
      email: p.email,
      role: p.role,
      branch_id: p.branch_id,
    });
    await recordActivity(p, {
      action: 'Signed in',
      description: `${p.full_name} signed in`,
      entityType: 'login',
      entityId: p.id,
      branchId: p.branch_id,
    });

    res.json({
      token: data.session.access_token,
      user: { ...p, branch_name },
    });
  })
);

// ---------- Branches ----------
app.get(
  '/api/branches',
  admin,
  h(async (req, res) =>
    res.json(ok(await db.from('branches').select('*').order('id')))
  )
);

app.get(
  '/api/branches/summary',
  admin,
  h(async (req, res) => {
    const branches = ok(await db.from('branches').select('*').order('id'));
    const date = today();
    const out = [];

    for (const b of branches) {
      const { count: products } = await db
        .from('products')
        .select('id', { count: 'exact', head: true })
        .eq('branch_id', b.id)
        .eq('active', true);
      const { count: staff } = await db
        .from('profiles')
        .select('id', { count: 'exact', head: true })
        .eq('branch_id', b.id)
        .eq('role', 'staff');
      const sales = ok(
        await db
          .from('sales')
          .select('total,quantity')
          .eq('branch_id', b.id)
          .eq('sale_date', date)
      );

      out.push({
        id: b.id,
        name: b.name,
        products: products ?? 0,
        staff: staff ?? 0,
        revenue_today: sales.reduce((a, s) => a + Number(s.total), 0),
        items_today: sales.reduce((a, s) => a + Number(s.quantity || 0), 0),
      });
    }

    res.json(out);
  })
);

// ---------- Staff ----------
app.get(
  '/api/staff/all',
  admin,
  h(async (req, res) =>
    res.json(
      ok(
        await db
          .from('profiles')
          .select('*')
          .eq('role', 'staff')
          .order('created_at', { ascending: false })
      )
    )
  )
);

app.get(
  '/api/staff',
  admin,
  h(async (req, res) => {
    let q = db.from('profiles').select('*').eq('role', 'staff');
    q = scope(q, req.branchId);
    const staff = ok(await q.order('created_at', { ascending: false }));

    const logs = ok(
      await db
        .from('login_logs')
        .select('user_id,logged_in_at')
        .order('logged_in_at', { ascending: false })
        .limit(1000)
    );

    res.json(
      staff.map((s) => ({
        ...s,
        last_login: logs.find((l) => l.user_id === s.id)?.logged_in_at || null,
      }))
    );
  })
);

app.post(
  '/api/staff',
  admin,
  h(async (req, res) => {
    const { full_name, email, password } = req.body;
    const branchId = Number(req.body.branch_id ?? req.branchId);

    if (!branchId) fail(400, 'Select a branch for this staff member');
    if (!full_name || !email || !password || password.length < 6)
      fail(400, 'Name, email and a password of 6+ characters are required');

    const branch = ok(
      await db.from('branches').select('name').eq('id', branchId).single()
    );

    const { data, error } = await db.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error) fail(400, error.message);

    const { error: e2 } = await db.from('profiles').insert({
      id: data.user.id,
      full_name,
      email,
      role: 'staff',
      branch_id: branchId,
    });
    if (e2) {
      await db.auth.admin.deleteUser(data.user.id);
      fail(400, e2.message);
    }

    const emailResult = await sendStaffWelcomeEmail({
      full_name,
      email,
      password,
      branch_name: branch.name,
    });

    await recordActivity(req.user, {
      action: 'Staff account created',
      description: `Created staff account for ${full_name} in ${branch.name}`,
      entityType: 'staff',
      entityId: data.user.id,
      branchId,
    });

    res.status(201).json({
      id: data.user.id,
      email_sent: emailResult.sent,
      email_message: emailResult.message || null,
    });
  })
);

app.patch(
  '/api/staff/:id',
  admin,
  h(async (req, res) => {
    const { active, password, branch_id } = req.body;

    const staff = ok(
      await db
        .from('profiles')
        .select('full_name, branch_id')
        .eq('id', req.params.id)
        .eq('role', 'staff')
        .single()
    );

    const changes = [];

    if (password) {
      if (password.length < 6) fail(400, 'Password must be 6+ characters');
      ok(await db.auth.admin.updateUserById(req.params.id, { password }));
      changes.push('password reset');
    }

    if (typeof active === 'boolean') {
      ok(
        await db
          .from('profiles')
          .update({ active })
          .eq('id', req.params.id)
          .eq('role', 'staff')
      );
      changes.push(active ? 'enabled' : 'disabled');
    }

    if (branch_id !== undefined) {
      if (branch_id === null) {
        ok(
          await db
            .from('profiles')
            .update({ branch_id: null })
            .eq('id', req.params.id)
            .eq('role', 'staff')
        );
        changes.push('branch unassigned');
      } else {
        const b = ok(
          await db.from('branches').select('name').eq('id', branch_id).single()
        );
        ok(
          await db
            .from('profiles')
            .update({ branch_id })
            .eq('id', req.params.id)
            .eq('role', 'staff')
        );
        changes.push(`moved to ${b.name}`);
      }
    }

    if (changes.length) {
      await recordActivity(req.user, {
        action: 'Staff account updated',
        description: `${staff.full_name}: ${changes.join(', ')}`,
        entityType: 'staff',
        entityId: req.params.id,
        branchId: staff.branch_id,
      });
    }

    res.json({ done: true });
  })
);

// ---------- Logins ----------
app.get(
  '/api/logins',
  admin,
  h(async (req, res) => {
    let q = db
      .from('login_logs')
      .select('*')
      .order('logged_in_at', { ascending: false })
      .limit(200);
    q = scope(q, req.branchId);
    res.json(ok(await q));
  })
);

// ---------- Activity ----------
app.get(
  '/api/activity',
  admin,
  h(async (req, res) => {
    let q = db
      .from('activity_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(500);
    q = scope(q, req.branchId);
    res.json(ok(await q));
  })
);

// ---------- Stats ----------
app.get(
  '/api/stats',
  admin,
  h(async (req, res) => {
    let salesQ = db
      .from('sales')
      .select('*')
      .eq('sale_date', today())
      .order('sold_at', { ascending: false });
    salesQ = scope(salesQ, req.branchId);
    const sales = ok(await salesQ);

    let pendingQ = db
      .from('reports')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending');
    pendingQ = scope(pendingQ, req.branchId);
    const { count: pending } = await pendingQ;

    let lowQ = db
      .from('products')
      .select('id,name,stock')
      .eq('active', true)
      .lte('stock', 3)
      .order('stock');
    lowQ = scope(lowQ, req.branchId);
    const low = ok(await lowQ);

    res.json({
      items: sales.reduce((a, s) => a + s.quantity, 0),
      revenue: sales.reduce((a, s) => a + Number(s.total), 0),
      pending: pending ?? 0,
      low,
      sales,
    });
  })
);

// ---------- Products ----------
app.get(
  '/api/products',
  anyone,
  h(async (req, res) => {
    let q = db.from('products').select('*').eq('active', true).order('name');
    q = scope(q, req.branchId);
    res.json(ok(await q));
  })
);

const prodFields = ({ name, category, price, stock, image_url }) =>
  Object.fromEntries(
    Object.entries({ name, category, price, stock, image_url }).filter(
      ([, v]) => v !== undefined
    )
  );

const assertProductBranch = async (id, branchId) => {
  const p = ok(
    await db.from('products').select('id,branch_id').eq('id', id).single()
  );
  if (branchId != null && p.branch_id !== branchId)
    fail(403, 'This product belongs to a different branch');
  return p;
};

app.post(
  '/api/products',
  admin,
  h(async (req, res) => {
    const f = prodFields(req.body);
    const branchId = Number(req.body.branch_id ?? req.branchId);
    if (!branchId) fail(400, 'Select a branch first');
    if (!f.name || f.price === undefined)
      fail(400, 'Name and price are required');

    const product = ok(
      await db
        .from('products')
        .insert({ ...f, branch_id: branchId })
        .select()
        .single()
    );

    await recordActivity(req.user, {
      action: 'Product added',
      description: `Added ${product.name} at ${product.price}; stock ${product.stock}`,
      entityType: 'product',
      entityId: product.id,
      branchId,
    });

    res.status(201).json(product);
  })
);

app.put(
  '/api/products/:id',
  admin,
  h(async (req, res) => {
    await assertProductBranch(req.params.id, req.branchId);

    const before = ok(
      await db.from('products').select('*').eq('id', req.params.id).single()
    );
    const product = ok(
      await db
        .from('products')
        .update(prodFields(req.body))
        .eq('id', req.params.id)
        .select()
        .single()
    );

    const changes = [];
    if (Number(before.price) !== Number(product.price))
      changes.push(`price ${before.price} -> ${product.price}`);
    if (before.stock !== product.stock)
      changes.push(`stock ${before.stock} -> ${product.stock}`);
    if (before.name !== product.name)
      changes.push(`name ${before.name} -> ${product.name}`);
    if (before.category !== product.category)
      changes.push(`category ${before.category || 'none'} -> ${product.category || 'none'}`);
    if (before.image_url !== product.image_url) changes.push('image updated');

    if (changes.length) {
      await recordActivity(req.user, {
        action: 'Product updated',
        description: `${product.name}: ${changes.join(', ')}`,
        entityType: 'product',
        entityId: product.id,
        branchId: product.branch_id,
      });
    }

    res.json(product);
  })
);

app.delete(
  '/api/products/:id',
  admin,
  h(async (req, res) => {
    await assertProductBranch(req.params.id, req.branchId);

    const product = ok(
      await db.from('products').select('*').eq('id', req.params.id).single()
    );
    ok(await db.from('products').update({ active: false }).eq('id', req.params.id));

    await recordActivity(req.user, {
      action: 'Product deleted',
      description: `Removed ${product.name}; price ${product.price}; remaining stock ${product.stock}`,
      entityType: 'product',
      entityId: product.id,
      branchId: product.branch_id,
    });

    res.json({ done: true });
  })
);

// ---------- Sales (staff) ----------
app.post(
  '/api/sales',
  guard('staff'),
  h(async (req, res) => {
    const qty = parseInt(req.body.quantity || 1, 10);
    if (!(qty > 0)) fail(400, 'Quantity must be at least 1');

    const customerName = String(req.body.customer_name || '').trim();
    if (customerName.length > 120)
      fail(400, 'Customer name must be 120 characters or fewer');

    res.status(201).json(
      ok(
        await db.rpc('sell_product', {
          p_product: req.body.product_id,
          p_staff: req.user.id,
          p_qty: qty,
          p_date: today(),
          p_customer_name: customerName || null,
        })
      )
    );
  })
);

app.get(
  '/api/sales/today',
  guard('staff'),
  h(async (req, res) =>
    res.json(
      ok(
        await db
          .from('sales')
          .select('*')
          .eq('staff_id', req.user.id)
          .eq('sale_date', today())
          .order('sold_at', { ascending: false })
      )
    )
  )
);

// ---------- Reports ----------
app.post(
  '/api/reports',
  guard('staff'),
  h(async (req, res) => {
    const sales = ok(
      await db
        .from('sales')
        .select('*')
        .eq('staff_id', req.user.id)
        .eq('sale_date', today())
        .is('report_id', null)
    );
    if (!sales.length) fail(400, 'No unreported sales for today');

    const report = ok(
      await db
        .from('reports')
        .insert({
          staff_id: req.user.id,
          staff_name: req.user.full_name,
          report_date: today(),
          note: req.body.note || null,
          total_items: sales.reduce((a, s) => a + s.quantity, 0),
          total_amount: sales.reduce((a, s) => a + Number(s.total), 0),
          branch_id: req.user.branch_id,
        })
        .select()
        .single()
    );

    ok(
      await db
        .from('sales')
        .update({ report_id: report.id })
        .in('id', sales.map((s) => s.id))
    );

    await recordActivity(req.user, {
      action: 'Report submitted',
      description: `Submitted report for ${report.total_items} items`,
      entityType: 'report',
      entityId: report.id,
      branchId: req.user.branch_id,
    });

    res.status(201).json(report);
  })
);

app.get(
  '/api/reports',
  anyone,
  h(async (req, res) => {
    let q = db
      .from('reports')
      .select('*')
      .order('submitted_at', { ascending: false })
      .limit(200);

    if (req.user.role === 'staff') q = q.eq('staff_id', req.user.id);
    else q = scope(q, req.branchId);

    res.json(ok(await q));
  })
);

app.get(
  '/api/reports/:id',
  anyone,
  h(async (req, res) => {
    const report = ok(
      await db.from('reports').select('*').eq('id', req.params.id).single()
    );

    if (req.user.role === 'staff' && report.staff_id !== req.user.id)
      fail(403, 'Not allowed');
    if (
      req.user.role === 'admin' &&
      req.branchId != null &&
      report.branch_id !== req.branchId
    )
      fail(403, 'This report belongs to a different branch');

    const sales = ok(
      await db.from('sales').select('*').eq('report_id', report.id).order('sold_at')
    );

    res.json({ ...report, sales });
  })
);

app.patch(
  '/api/reports/:id',
  admin,
  h(async (req, res) => {
    const { status, admin_comment } = req.body;
    if (!['approved', 'rejected'].includes(status))
      fail(400, 'Status must be approved or rejected');

    const before = ok(
      await db.from('reports').select('branch_id').eq('id', req.params.id).single()
    );
    if (req.branchId != null && before.branch_id !== req.branchId)
      fail(403, 'This report belongs to a different branch');

    const r = ok(
      await db
        .from('reports')
        .update({
          status,
          admin_comment: admin_comment || null,
          reviewed_at: new Date().toISOString(),
        })
        .eq('id', req.params.id)
        .eq('status', 'pending')
        .select()
        .single()
    );

    if (status === 'rejected') {
      await db.from('sales').update({ report_id: null }).eq('report_id', r.id);
    }

    await recordActivity(req.user, {
      action: `Report ${status}`,
      description: `${status === 'approved' ? 'Approved' : 'Rejected'} ${r.staff_name}'s report`,
      entityType: 'report',
      entityId: r.id,
      branchId: r.branch_id,
    });

    res.json(r);
  })
);

if (!process.env.VERCEL) {
  app.listen(PORT, () => console.log(`API running on http://localhost:${PORT}`));
}

export default app;