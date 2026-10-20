'use strict';
require('dotenv').config();
const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/* ================= Configuração ================= */
const PROD = process.env.ASAAS_ENV === 'production';
const ASAAS_BASE = PROD ? 'https://api.asaas.com/v3' : 'https://api-sandbox.asaas.com/v3';
const ASAAS_KEY = process.env.ASAAS_API_KEY || '';
const WEBHOOK_TOKEN = process.env.ASAAS_WEBHOOK_TOKEN || '';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PORT = process.env.PORT || 3000;
const MIN_AMOUNT = parseInt(process.env.MIN_AMOUNT_CENTS || '500', 10); // R$ 5,00
let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  if (PROD) { console.error('Defina JWT_SECRET no ambiente.'); process.exit(1); }
  JWT_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('JWT_SECRET não definido: usando um temporário (logins caem ao reiniciar).');
}
if (!ASAAS_KEY) console.warn('ASAAS_API_KEY não definida: cobranças e saques vão falhar.');
if (!WEBHOOK_TOKEN) console.warn('ASAAS_WEBHOOK_TOKEN não definido: o webhook vai recusar tudo.');

fs.mkdirSync(path.join(DATA_DIR, 'kyc'), { recursive: true });

/* ================= Banco de dados ================= */
const db = new Database(path.join(DATA_DIR, 'pixgate.db'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
  pw_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user',
  balance INTEGER NOT NULL DEFAULT 0, blocked INTEGER NOT NULL DEFAULT 0,
  kyc_status TEXT NOT NULL DEFAULT 'none', kyc_note TEXT,
  full_name TEXT, cpf TEXT, birth TEXT, kyc_doc TEXT, asaas_customer TEXT,
  fee_recv_pct REAL, fee_recv_fixed INTEGER, fee_tr_pct REAL, fee_tr_fixed INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tx(
  id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, type TEXT NOT NULL,
  amount INTEGER NOT NULL, fee INTEGER NOT NULL DEFAULT 0, net INTEGER NOT NULL,
  status TEXT NOT NULL, asaas_id TEXT, pix_payload TEXT, pix_image TEXT,
  key_type TEXT, key TEXT, note TEXT, refunded INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, done_at INTEGER
);
CREATE INDEX IF NOT EXISTS tx_user ON tx(user_id, created_at);
CREATE INDEX IF NOT EXISTS tx_asaas ON tx(asaas_id);
`);
const defaults = { recv_pct: 1.5, recv_fixed: 200, tr_pct: 0, tr_fixed: 200 }; // fixed em centavos
for (const [k, v] of Object.entries(defaults))
  db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)').run(k, String(v));

const adminUser = (process.env.ADMIN_USER || 'admin').toLowerCase();
const adminPass = process.env.ADMIN_PASSWORD || 'admin1207820099';
if (!db.prepare('SELECT 1 FROM users WHERE username=?').get(adminUser)) {
  db.prepare(`INSERT INTO users(username,name,email,pw_hash,role,kyc_status,created_at)
    VALUES(?,?,?,?,?,?,?)`).run(adminUser, 'Administrador', adminUser + '@pixgate.local',
    bcrypt.hashSync(adminPass, 10), 'admin', 'approved', Date.now());
  console.log('Conta admin criada:', adminUser);
}

/* ================= Utilidades ================= */
class HttpErr extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const ah = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const rid = p => p + '_' + crypto.randomBytes(8).toString('hex');
const getS = () => Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map(r => [r.key, Number(r.value)]));

function rules(u) {
  const s = getS();
  return {
    receive: { pct: u.fee_recv_pct ?? s.recv_pct, fixed: u.fee_recv_fixed ?? s.recv_fixed },
    transfer: { pct: u.fee_tr_pct ?? s.tr_pct, fixed: u.fee_tr_fixed ?? s.tr_fixed },
  };
}
const feeFor = (u, type, amount) => { const r = rules(u)[type]; return Math.round(amount * r.pct / 100) + r.fixed; };

function validCpf(c) {
  c = String(c).replace(/\D/g, '');
  if (c.length !== 11 || /^(\d)\1+$/.test(c)) return false;
  for (let t = 9; t < 11; t++) {
    let s = 0;
    for (let i = 0; i < t; i++) s += Number(c[i]) * (t + 1 - i);
    if (((s * 10) % 11) % 10 !== Number(c[t])) return false;
  }
  return true;
}

function pub(u) {
  return {
    id: u.id, username: u.username, name: u.name, email: u.email, role: u.role,
    balance: u.balance, blocked: !!u.blocked, kyc_status: u.kyc_status, kyc_note: u.kyc_note,
    cpf: u.cpf ? '***.' + u.cpf.slice(3, 6) + '.' + u.cpf.slice(6, 9) + '-**' : null,
    full_name: u.full_name, created_at: u.created_at,
    own_fees: { recv_pct: u.fee_recv_pct, recv_fixed: u.fee_recv_fixed, tr_pct: u.fee_tr_pct, tr_fixed: u.fee_tr_fixed },
  };
}

/* ================= Cliente Asaas ================= */
async function asaas(method, p, body) {
  const res = await fetch(ASAAS_BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', access_token: ASAAS_KEY, 'User-Agent': 'PixGate/1.0' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (j.errors && j.errors[0] && j.errors[0].description) || ('Erro Asaas ' + res.status);
    const e = new Error(msg); e.asaas = true; e.status = res.status; throw e;
  }
  return j;
}

/* ================= App ================= */
const app = express();
app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' });
  next();
});
app.use(express.json({ limit: '8mb' }));
app.use(cookieParser());

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });

function setSession(res, id) {
  res.cookie('token', jwt.sign({ id }, JWT_SECRET, { expiresIn: '7d' }), {
    httpOnly: true, sameSite: 'lax', secure: PROD, maxAge: 7 * 864e5,
  });
}
function auth(req, res, next) {
  try {
    const { id } = jwt.verify(req.cookies.token || '', JWT_SECRET);
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
    if (!u) throw 0;
    if (u.blocked) throw new HttpErr(403, 'Conta bloqueada.');
    req.user = u; next();
  } catch (e) { next(e instanceof HttpErr ? e : new HttpErr(401, 'Faça login.')); }
}
const adminOnly = (req, res, next) => req.user.role === 'admin' ? next() : next(new HttpErr(403, 'Apenas admin.'));
const kycOk = (req, res, next) => req.user.kyc_status === 'approved' ? next() : next(new HttpErr(403, 'Conclua a verificação de identidade (KYC) primeiro.'));

/* ---------- Conta ---------- */
app.post('/api/signup', authLimiter, ah(async (req, res) => {
  const { name, username, email, password } = req.body || {};
  const un = String(username || '').trim().toLowerCase(), em = String(email || '').trim().toLowerCase();
  if (!String(name || '').trim()) throw new HttpErr(400, 'Informe seu nome.');
  if (!/^[a-z0-9_.]{3,20}$/.test(un)) throw new HttpErr(400, 'Usuário: 3 a 20 letras minúsculas, números, _ ou .');
  if (!/^\S+@\S+\.\S+$/.test(em)) throw new HttpErr(400, 'E-mail inválido.');
  if (String(password || '').length < 8) throw new HttpErr(400, 'A senha precisa ter pelo menos 8 caracteres.');
  if (db.prepare('SELECT 1 FROM users WHERE username=? OR email=?').get(un, em)) throw new HttpErr(409, 'Usuário ou e-mail já em uso.');
  const r = db.prepare('INSERT INTO users(username,name,email,pw_hash,created_at) VALUES(?,?,?,?,?)')
    .run(un, String(name).trim(), em, bcrypt.hashSync(password, 10), Date.now());
  setSession(res, r.lastInsertRowid);
  res.json({ ok: true });
}));

app.post('/api/login', authLimiter, ah(async (req, res) => {
  const id = String((req.body || {}).id || '').trim().toLowerCase();
  const u = db.prepare('SELECT * FROM users WHERE username=? OR email=?').get(id, id);
  if (!u || !bcrypt.compareSync(String((req.body || {}).password || ''), u.pw_hash)) throw new HttpErr(401, 'Usuário ou senha incorretos.');
  if (u.blocked) throw new HttpErr(403, 'Conta bloqueada. Fale com o administrador.');
  setSession(res, u.id);
  res.json({ ok: true });
}));

app.post('/api/logout', (req, res) => { res.clearCookie('token'); res.json({ ok: true }); });

app.get('/api/me', auth, (req, res) => res.json({ user: pub(req.user), fees: rules(req.user), min_amount: MIN_AMOUNT, sandbox: !PROD }));

app.post('/api/password', auth, ah(async (req, res) => {
  const { old, next } = req.body || {};
  if (!bcrypt.compareSync(String(old || ''), req.user.pw_hash)) throw new HttpErr(400, 'Senha atual incorreta.');
  if (String(next || '').length < 8) throw new HttpErr(400, 'A nova senha precisa ter pelo menos 8 caracteres.');
  db.prepare('UPDATE users SET pw_hash=? WHERE id=?').run(bcrypt.hashSync(next, 10), req.user.id);
  res.json({ ok: true });
}));

/* ---------- KYC ---------- */
app.post('/api/kyc', auth, ah(async (req, res) => {
  const u = req.user;
  if (u.kyc_status === 'approved') throw new HttpErr(400, 'Você já está verificado.');
  const { fullName, cpf, birth, doc } = req.body || {};
  if (String(fullName || '').trim().split(/\s+/).length < 2) throw new HttpErr(400, 'Informe o nome completo.');
  if (!validCpf(cpf)) throw new HttpErr(400, 'CPF inválido.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(birth || ''))) throw new HttpErr(400, 'Data de nascimento inválida.');
  const age = (Date.now() - new Date(birth).getTime()) / 31557600000;
  if (!(age >= 18 && age < 120)) throw new HttpErr(400, 'É preciso ter 18 anos ou mais.');
  const m = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(String(doc || ''));
  if (!m) throw new HttpErr(400, 'Envie uma foto do documento (JPG ou PNG).');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 6 * 1024 * 1024) throw new HttpErr(400, 'Imagem muito grande.');
  const file = `${u.id}.${m[1] === 'png' ? 'png' : 'jpg'}`;
  fs.writeFileSync(path.join(DATA_DIR, 'kyc', file), buf);
  const digits = String(cpf).replace(/\D/g, '');
  if (db.prepare('SELECT 1 FROM users WHERE cpf=? AND id<>? AND kyc_status<>?').get(digits, u.id, 'rejected'))
    throw new HttpErr(409, 'Esse CPF já está em uso em outra conta.');
  db.prepare(`UPDATE users SET full_name=?,cpf=?,birth=?,kyc_doc=?,kyc_status='pending',kyc_note=NULL WHERE id=?`)
    .run(String(fullName).trim(), digits, birth, file, u.id);
  res.json({ ok: true });
}));

/* ---------- Extrato ---------- */
app.get('/api/tx', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM tx WHERE user_id=? ORDER BY created_at DESC LIMIT 100').all(req.user.id);
  res.json({ user: pub(req.user), tx: rows.map(t => ({ ...t, pix_image: t.type === 'receive' && t.status === 'pending' ? t.pix_image : null })) });
});

/* ---------- Receber PIX ---------- */
app.post('/api/charges', auth, kycOk, ah(async (req, res) => {
  const u = req.user, amount = Math.round(Number((req.body || {}).amount));
  if (!Number.isInteger(amount) || amount < MIN_AMOUNT) throw new HttpErr(400, `Valor mínimo: R$ ${(MIN_AMOUNT / 100).toFixed(2).replace('.', ',')}`);
  if (amount > 5000000) throw new HttpErr(400, 'Valor máximo por cobrança: R$ 50.000,00');
  const fee = feeFor(u, 'receive', amount);
  if (fee >= amount) throw new HttpErr(400, 'O valor é menor que a taxa.');
  const id = rid('tx');
  try {
    let customer = u.asaas_customer;
    if (!customer) {
      const c = await asaas('POST', '/customers', {
        name: u.full_name, cpfCnpj: u.cpf, email: u.email, externalReference: String(u.id), notificationDisabled: true,
      });
      customer = c.id;
      db.prepare('UPDATE users SET asaas_customer=? WHERE id=?').run(customer, u.id);
    }
    const dueDate = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
    const pay = await asaas('POST', '/payments', {
      customer, billingType: 'PIX', value: amount / 100, dueDate, description: 'Cobrança PixGate', externalReference: id,
    });
    const qr = await asaas('GET', `/payments/${pay.id}/pixQrCode`);
    db.prepare(`INSERT INTO tx(id,user_id,type,amount,fee,net,status,asaas_id,pix_payload,pix_image,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id, u.id, 'receive', amount, fee, amount - fee, 'pending', pay.id, qr.payload, qr.encodedImage, Date.now());
  } catch (e) {
    if (e.asaas) throw new HttpErr(502, 'Não foi possível gerar o PIX agora: ' + e.message);
    throw e;
  }
  res.json({ ok: true, id });
}));

/* ---------- Enviar / sacar PIX ---------- */
function normalizeKey(type, key) {
  key = String(key || '').trim();
  const d = key.replace(/\D/g, '');
  if (type === 'cpf') {
    if (d.length === 11) return { key: d, t: 'CPF' };
    if (d.length === 14) return { key: d, t: 'CNPJ' };
  } else if (type === 'phone') {
    const p = d.length === 13 && d.startsWith('55') ? d.slice(2) : d;
    if (p.length === 11 || p.length === 10) return { key: p, t: 'PHONE' };
  } else if (type === 'email') {
    if (/^\S+@\S+\.\S+$/.test(key)) return { key: key.toLowerCase(), t: 'EMAIL' };
  } else if (type === 'random') {
    if (/^[0-9a-fA-F-]{32,36}$/.test(key)) return { key, t: 'EVP' };
  }
  throw new HttpErr(400, 'Chave PIX inválida para o tipo escolhido.');
}

const reserveFunds = db.transaction((uid, id, amount, fee, keyType, key) => {
  const cur = db.prepare('SELECT balance FROM users WHERE id=?').get(uid);
  if (cur.balance < amount + fee) throw new HttpErr(400, 'Saldo insuficiente.');
  db.prepare('UPDATE users SET balance=balance-? WHERE id=?').run(amount + fee, uid);
  db.prepare(`INSERT INTO tx(id,user_id,type,amount,fee,net,status,key_type,key,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id, uid, 'transfer', amount, fee, amount + fee, 'processing', keyType, key, Date.now());
});
const refundTx = db.transaction((id, note) => {
  const t = db.prepare('SELECT * FROM tx WHERE id=?').get(id);
  if (!t || t.refunded || t.type !== 'transfer') return;
  db.prepare('UPDATE users SET balance=balance+? WHERE id=?').run(t.net, t.user_id);
  db.prepare(`UPDATE tx SET status='failed',refunded=1,note=?,done_at=? WHERE id=?`).run(note || null, Date.now(), id);
});

app.post('/api/transfers', auth, kycOk, ah(async (req, res) => {
  const u = req.user, b = req.body || {}, amount = Math.round(Number(b.amount));
  const k = normalizeKey(b.keyType, b.key);
  if (!Number.isInteger(amount) || amount < 100) throw new HttpErr(400, 'Valor mínimo: R$ 1,00');
  const fee = feeFor(u, 'transfer', amount);
  const id = rid('tx');
  reserveFunds(u.id, id, amount, fee, k.t, k.key); // desconta já (reserva) para evitar saque duplo
  try {
    const tr = await asaas('POST', '/transfers', {
      value: amount / 100, pixAddressKey: k.key, pixAddressKeyType: k.t, description: 'Saque PixGate',
    });
    db.prepare('UPDATE tx SET asaas_id=? WHERE id=?').run(tr.id, id);
    if (tr.status === 'DONE') db.prepare(`UPDATE tx SET status='done',done_at=? WHERE id=?`).run(Date.now(), id);
    if (['FAILED', 'CANCELLED'].includes(tr.status)) refundTx(id, 'Recusado pelo banco');
  } catch (e) {
    if (e.asaas) { refundTx(id, e.message); throw new HttpErr(502, 'Saque não realizado: ' + e.message); }
    // erro de rede/timeout: o saque pode ter saído. NÃO devolve sozinho; fica 'processing' para conferência manual.
    db.prepare(`UPDATE tx SET note=? WHERE id=?`).run('Falha de comunicação: confirme no painel Asaas antes de devolver', id);
    throw new HttpErr(502, 'Não foi possível confirmar o saque. Ele ficou em análise; fale com o suporte.');
  }
  res.json({ ok: true, id });
}));

/* ---------- Webhook Asaas ---------- */
app.post('/api/webhooks/asaas', ah(async (req, res) => {
  const got = Buffer.from(String(req.get('asaas-access-token') || ''));
  const want = Buffer.from(WEBHOOK_TOKEN);
  if (!WEBHOOK_TOKEN || got.length !== want.length || !crypto.timingSafeEqual(got, want)) return res.status(401).end();
  const ev = req.body || {};
  if ((ev.event === 'PAYMENT_RECEIVED' || ev.event === 'PAYMENT_CONFIRMED') && ev.payment && ev.payment.id) {
    const t = db.prepare(`SELECT * FROM tx WHERE asaas_id=? AND type='receive'`).get(ev.payment.id);
    if (t && t.status === 'pending') {
      const real = await asaas('GET', `/payments/${ev.payment.id}`); // confirma direto na fonte
      if (!['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'].includes(real.status)) return res.json({ ignored: true });
      if (Math.round(Number(real.value) * 100) !== t.amount) { console.error('Valor divergente', t.id); return res.json({ ignored: true }); }
      db.transaction(() => {
        const r = db.prepare(`UPDATE tx SET status='paid',done_at=? WHERE id=? AND status='pending'`).run(Date.now(), t.id);
        if (r.changes) db.prepare('UPDATE users SET balance=balance+? WHERE id=?').run(t.net, t.user_id);
      })();
    }
  } else if (ev.event && ev.event.startsWith('TRANSFER_') && ev.transfer && ev.transfer.id) {
    const t = db.prepare(`SELECT * FROM tx WHERE asaas_id=? AND type='transfer'`).get(ev.transfer.id);
    if (t) {
      if (ev.event === 'TRANSFER_DONE' && t.status === 'processing')
        db.prepare(`UPDATE tx SET status='done',done_at=? WHERE id=?`).run(Date.now(), t.id);
      else if (['TRANSFER_FAILED', 'TRANSFER_CANCELLED', 'TRANSFER_BLOCKED'].includes(ev.event))
        refundTx(t.id, ev.event);
    }
  }
  res.json({ ok: true });
}));

/* ---------- Admin ---------- */
const admin = express.Router();
admin.use(auth, adminOnly);

admin.get('/overview', ah(async (req, res) => {
  const one = q => db.prepare(q).get();
  const stats = {
    users: one('SELECT COUNT(*) n FROM users').n,
    held: one('SELECT COALESCE(SUM(balance),0) n FROM users').n,
    vol_recv: one(`SELECT COALESCE(SUM(amount),0) n FROM tx WHERE type='receive' AND status='paid'`).n,
    vol_send: one(`SELECT COALESCE(SUM(amount),0) n FROM tx WHERE type='transfer' AND status IN('done','processing')`).n,
    revenue: one(`SELECT COALESCE(SUM(fee),0) n FROM tx WHERE (type='receive' AND status='paid') OR (type='transfer' AND status IN('done','processing'))`).n,
    kyc_pending: one(`SELECT COUNT(*) n FROM users WHERE kyc_status='pending'`).n,
    stuck: one(`SELECT COUNT(*) n FROM tx WHERE type='transfer' AND status='processing'`).n,
    asaas_balance: null,
  };
  try { stats.asaas_balance = Math.round((await asaas('GET', '/finance/balance')).balance * 100); } catch (e) { stats.asaas_error = e.message; }
  const recent = db.prepare(`SELECT tx.id,tx.type,tx.amount,tx.fee,tx.status,tx.created_at,tx.note,users.username FROM tx JOIN users ON users.id=tx.user_id ORDER BY tx.created_at DESC LIMIT 20`).all();
  res.json({ stats, recent });
}));

admin.get('/users', (req, res) => res.json({ users: db.prepare('SELECT * FROM users ORDER BY id').all().map(pub), fees: getS() }));

const num = v => (v === null || v === '' || v === undefined) ? null : Number(v);
admin.patch('/users/:id', ah(async (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!u) throw new HttpErr(404, 'Usuário não encontrado.');
  const b = req.body || {};
  if (b.fees) {
    const f = b.fees, pct = x => { const n = num(x); if (n !== null && !(n >= 0 && n <= 100)) throw new HttpErr(400, 'Porcentagem inválida.'); return n; };
    const fx = x => { const n = num(x); if (n !== null && !(Number.isInteger(n) && n >= 0)) throw new HttpErr(400, 'Valor fixo inválido.'); return n; };
    db.prepare('UPDATE users SET fee_recv_pct=?,fee_recv_fixed=?,fee_tr_pct=?,fee_tr_fixed=? WHERE id=?')
      .run(pct(f.recv_pct), fx(f.recv_fixed), pct(f.tr_pct), fx(f.tr_fixed), u.id);
  }
  if (typeof b.blocked === 'boolean' && u.role !== 'admin') db.prepare('UPDATE users SET blocked=? WHERE id=?').run(b.blocked ? 1 : 0, u.id);
  if (b.kyc_status && ['approved', 'rejected', 'pending', 'none'].includes(b.kyc_status))
    db.prepare('UPDATE users SET kyc_status=?,kyc_note=? WHERE id=?').run(b.kyc_status, b.kyc_note || null, u.id);
  res.json({ ok: true });
}));

admin.post('/users/:id/adjust', ah(async (req, res) => {
  const amount = Math.round(Number((req.body || {}).amount));
  if (!Number.isInteger(amount) || !amount) throw new HttpErr(400, 'Valor inválido.');
  db.transaction(() => {
    const u = db.prepare('SELECT balance FROM users WHERE id=?').get(req.params.id);
    if (!u) throw new HttpErr(404, 'Usuário não encontrado.');
    if (u.balance + amount < 0) throw new HttpErr(400, 'O saldo ficaria negativo.');
    db.prepare('UPDATE users SET balance=balance+? WHERE id=?').run(amount, req.params.id);
    db.prepare(`INSERT INTO tx(id,user_id,type,amount,fee,net,status,note,created_at,done_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(rid('tx'), req.params.id, 'adjust', Math.abs(amount), 0, amount, 'done', String((req.body || {}).note || 'Ajuste do admin').slice(0, 120), Date.now(), Date.now());
  })();
  res.json({ ok: true });
}));

admin.get('/settings', (req, res) => res.json(getS()));
admin.put('/settings', ah(async (req, res) => {
  const b = req.body || {}, out = {};
  for (const k of ['recv_pct', 'tr_pct']) { const n = Number(b[k]); if (!(n >= 0 && n <= 100)) throw new HttpErr(400, 'Porcentagem inválida.'); out[k] = n; }
  for (const k of ['recv_fixed', 'tr_fixed']) { const n = Number(b[k]); if (!(Number.isInteger(n) && n >= 0)) throw new HttpErr(400, 'Valor fixo inválido.'); out[k] = n; }
  const st = db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)');
  db.transaction(() => Object.entries(out).forEach(([k, v]) => st.run(k, String(v))))();
  res.json({ ok: true });
}));
admin.post('/clear-overrides', (req, res) => {
  db.prepare('UPDATE users SET fee_recv_pct=NULL,fee_recv_fixed=NULL,fee_tr_pct=NULL,fee_tr_fixed=NULL').run();
  res.json({ ok: true });
});

admin.get('/kyc-doc/:id', (req, res) => {
  const u = db.prepare('SELECT kyc_doc FROM users WHERE id=?').get(req.params.id);
  if (!u || !u.kyc_doc) return res.status(404).end();
  res.sendFile(path.join(DATA_DIR, 'kyc', path.basename(u.kyc_doc)));
});
app.use('/api/admin', admin);

/* ---------- Estáticos e erros ---------- */
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', (req, res) => res.status(404).json({ error: 'Rota não encontrada.' }));
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Arquivo muito grande.' });
  if (err instanceof HttpErr) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Erro interno.' });
});

app.listen(PORT, () => console.log(`PixGate rodando na porta ${PORT} (${PROD ? 'PRODUÇÃO' : 'sandbox'})`));
