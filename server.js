import express from 'express';
import cors from 'cors';
import bcrypt from 'bcrypt';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import dotenv from 'dotenv';
import { Resend } from 'resend';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ==================== ПАРОЛЬ АДМИНА ==================== */
const ADMIN_PASSWORD = 'xocatee_admin_2026';

/* ==================== TELEGRAM ==================== */
const BOT_TOKEN = '8801118817:AAGlG3YiG1PV0Ch3mGZLd9UJBVSIJlTr2SY';
const CHAT_ID_USER = '5871678747';
const CHAT_ID_GROUP = '-1004434258966';

async function sendToTelegram(text){
  const targets = [CHAT_ID_USER, CHAT_ID_GROUP];
  for (const chatId of targets) {
    try {
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'HTML' })
      });
    } catch(err){
      console.error(`❌ Ошибка Telegram (${chatId}):`, err.message);
    }
  }
}

/* ==================== ЛИМИТЫ СООБЩЕНИЙ ==================== */
const MESSAGE_LIMITS = {
  'Пробный (3 дня)': 20,
  'Эконом (1 месяц)': 500,
  'Бизнес (3 месяца)': 2000,
  'Бизнес-плюс (6 месяцев)': 5000,
  'ВИП (12 месяцев)': -1,
  'Владелец (бессрочно)': -1,
  'Подарок (2 мес)': 1000,
  'default': 50
};

/* ==================== БАЗА ДАННЫХ ==================== */
const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'xocatee_ai',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: false }
});

pool.query('SELECT NOW()')
  .then(() => console.log('✅ PostgreSQL подключён'))
  .catch(err => console.error('❌ Ошибка БД:', err.message));

/* ==================== ПОЧТА (RESEND) ==================== */
const resend = new Resend(process.env.RESEND_API_KEY);
console.log('📧 Resend инициализирован');

async function sendCodeEmail(email, code){
  try{
    const result = await resend.emails.send({
      from: 'XOCATEE AI <noreply@xocatee.ru>',
      to: email,
      subject: 'Код подтверждения — XOCATEE AI',
      html: `
        <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:30px;background:#0a0f14;color:#e8f1f5;border-radius:12px;">
          <h1 style="color:#14e0c8;margin:0 0 20px;font-size:24px;">XOCATEE AI</h1>
          <p style="color:#8aa0ae;margin:0 0 10px;">Ваш код подтверждения:</p>
          <div style="background:#121b24;border:1px solid #1e2a36;border-radius:10px;padding:20px;text-align:center;margin:20px 0;">
            <span style="font-size:36px;font-weight:800;color:#14e0c8;letter-spacing:8px;">${code}</span>
          </div>
          <p style="color:#8aa0ae;font-size:13px;margin:0;">Код действует 10 минут. Не сообщайте его никому.</p>
        </div>
      `
    });

    if(result.error){
      console.error('❌ Resend ошибка:', result.error);
      return { ok: false, error: result.error.message };
    }

    console.log(`📧 Код ${code} отправлен на ${email}`);
    return { ok: true };
  }catch(err){
    console.error('❌ Ошибка отправки:', err.message);
    return { ok: false, error: err.message };
  }
}

/* ==================== ЛИМИТЫ ==================== */
async function getUserLimitInfo(email){
  const user = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  if(user.rows.length === 0) return { limit: 0, used: 0, remaining: 0, plan: null, unlimited: false };

  const userId = user.rows[0].id;

  const sub = await pool.query(
    `SELECT plan_name FROM subscriptions WHERE user_id = $1 AND active = TRUE ORDER BY paid_at DESC LIMIT 1`,
    [userId]
  );

  const planName = sub.rows[0] ? sub.rows[0].plan_name : null;
  const limit = planName && MESSAGE_LIMITS[planName] !== undefined
    ? MESSAGE_LIMITS[planName]
    : MESSAGE_LIMITS['default'];

  const used = await pool.query(`
    SELECT COUNT(*)::int AS cnt FROM messages m
    JOIN chats c ON m.chat_id = c.id
    WHERE c.user_id = $1 AND m.role = 'user'
  `, [userId]);

  const usedCount = used.rows[0].cnt;
  const unlimited = limit === -1;
  const remaining = unlimited ? -1 : Math.max(0, limit - usedCount);

  return { limit, used: usedCount, remaining, plan: planName, unlimited };
}

/* ==================== AUTH ==================== */

app.post('/api/send-code', async (req, res) => {
  try{
    const { email } = req.body;
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Некорректная почта' });

    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expires = new Date(Date.now() + 10 * 60 * 1000);

    await pool.query(
      `INSERT INTO email_codes (email, code, expires_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE SET code = $2, expires_at = $3`,
      [email, code, expires]
    );

    const result = await sendCodeEmail(email, code);

    if(!result.ok){
      return res.status(500).json({ error: 'Не удалось отправить код: ' + result.error });
    }

    res.json({ ok: true });
  }catch(err){
    console.error('❌ Ошибка send-code:', err.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.post('/api/register', async (req, res) => {
  try{
    const { fio, email, code, password } = req.body;
    if (!fio || fio.split(' ').length < 2) return res.status(400).json({ error: 'Введите ФИО полностью' });
    if (!password || password.length < 6) return res.status(400).json({ error: 'Пароль минимум 6 символов' });

    const codeRec = await pool.query('SELECT * FROM email_codes WHERE email = $1', [email]);
    if (codeRec.rows.length === 0) return res.status(400).json({ error: 'Код не запрашивался' });
    const rec = codeRec.rows[0];
    if (rec.code !== code) return res.status(400).json({ error: 'Неверный код' });
    if (new Date(rec.expires_at) < new Date()) return res.status(400).json({ error: 'Код просрочен' });

    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) return res.status(400).json({ error: 'Почта уже зарегистрирована' });

    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (fio, email, password_hash, email_verified)
       VALUES ($1, $2, $3, TRUE) RETURNING id, fio, email`,
      [fio, email, hash]
    );

    await pool.query('DELETE FROM email_codes WHERE email = $1', [email]);
    res.json({ ok: true, user: result.rows[0] });
  }catch(err){ console.error(err); res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/login', async (req, res) => {
  try{
    const { email, code, password } = req.body;
    const codeRec = await pool.query('SELECT * FROM email_codes WHERE email = $1', [email]);
    if (codeRec.rows.length === 0) return res.status(400).json({ error: 'Код не запрашивался' });
    const rec = codeRec.rows[0];
    if (rec.code !== code) return res.status(400).json({ error: 'Неверный код' });
    if (new Date(rec.expires_at) < new Date()) return res.status(400).json({ error: 'Код просрочен' });

    const user = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (user.rows.length === 0) return res.status(400).json({ error: 'Пользователь не найден' });

    const ok = await bcrypt.compare(password, user.rows[0].password_hash);
    if (!ok) return res.status(400).json({ error: 'Неверный пароль' });

    await pool.query('DELETE FROM email_codes WHERE email = $1', [email]);
    res.json({ ok: true, user: { id: user.rows[0].id, fio: user.rows[0].fio, email: user.rows[0].email } });
  }catch(err){ console.error(err); res.status(500).json({ error: 'Ошибка сервера' }); }
});

/* ==================== SETTINGS ==================== */
app.post('/api/settings', async (req, res) => {
  try{
    const { oldEmail, fio, email, password } = req.body;
    const user = await pool.query('SELECT * FROM users WHERE email = $1', [oldEmail]);
    if (user.rows.length === 0) return res.status(400).json({ error: 'Пользователь не найден' });

    if (email !== oldEmail) {
      const exists = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
      if (exists.rows.length > 0) return res.status(400).json({ error: 'Эта почта уже занята' });
    }

    let hash = user.rows[0].password_hash;
    if (password) hash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `UPDATE users SET fio = $1, email = $2, password_hash = $3 WHERE id = $4
       RETURNING id, fio, email`,
      [fio, email, hash, user.rows[0].id]
    );
    res.json({ ok: true, user: result.rows[0] });
  }catch(err){ console.error(err); res.status(500).json({ error: 'Ошибка сервера' }); }
});

/* ==================== SUBSCRIPTIONS ==================== */
app.get('/api/subscription/:email', async (req, res) => {
  try{
    const user = await pool.query('SELECT id FROM users WHERE email = $1', [req.params.email]);
    if (user.rows.length === 0) return res.json({ subscription: null });
    const sub = await pool.query(
      `SELECT * FROM subscriptions WHERE user_id = $1 ORDER BY paid_at DESC LIMIT 1`,
      [user.rows[0].id]
    );
    res.json({ subscription: sub.rows[0] || null });
  }catch(err){ console.error(err); res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/subscription', async (req, res) => {
  try{
    const { email, planKey, planName, amount, months, days } = req.body;
    const user = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (user.rows.length === 0) return res.status(400).json({ error: 'Юзер не найден' });

    const until = new Date();
    if (days) until.setDate(until.getDate() + days);
    if (months) until.setMonth(until.getMonth() + months);

    await pool.query(`UPDATE subscriptions SET active = FALSE WHERE user_id = $1 AND active = TRUE`, [user.rows[0].id]);

    const result = await pool.query(
      `INSERT INTO subscriptions (user_id, plan_key, plan_name, amount, paid_at, until, auto_renew, active)
       VALUES ($1, $2, $3, $4, NOW(), $5, TRUE, TRUE) RETURNING *`,
      [user.rows[0].id, planKey, planName, amount, until]
    );
    res.json({ ok: true, subscription: result.rows[0] });
  }catch(err){ console.error(err); res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/subscription/cancel', async (req, res) => {
  try{
    const { email, reason } = req.body;
    const user = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (user.rows.length === 0) return res.status(400).json({ error: 'Юзер не найден' });
    await pool.query(
      `UPDATE subscriptions SET active = FALSE, auto_renew = FALSE, cancelled_reason = $1
       WHERE user_id = $2 AND active = TRUE`,
      [reason, user.rows[0].id]
    );
    res.json({ ok: true });
  }catch(err){ console.error(err); res.status(500).json({ error: 'Ошибка' }); }
});

/* ==================== MESSAGE LIMITS ==================== */
app.get('/api/message-limit/:email', async (req, res) => {
  try{
    const info = await getUserLimitInfo(req.params.email);
    res.json(info);
  }catch(err){ console.error(err); res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/check-message-limit', async (req, res) => {
  try{
    const { email } = req.body;
    if(!email) return res.status(400).json({ error: 'Нужен email' });
    const info = await getUserLimitInfo(email);
    if(info.unlimited) return res.json({ allowed: true, unlimited: true, used: info.used, plan: info.plan });
    if(info.used >= info.limit){
      return res.json({ allowed: false, used: info.used, limit: info.limit, plan: info.plan, message: 'Лимит сообщений исчерпан' });
    }
    res.json({ allowed: true, used: info.used, limit: info.limit, remaining: info.remaining, plan: info.plan });
  }catch(err){ console.error(err); res.status(500).json({ error: 'Ошибка' }); }
});

/* ==================== CHATS ==================== */
app.get('/api/chats/:email', async (req, res) => {
  try{
    const user = await pool.query('SELECT id FROM users WHERE email = $1', [req.params.email]);
    if (user.rows.length === 0) return res.json({ chats: [] });
    const chats = await pool.query('SELECT * FROM chats WHERE user_id = $1 ORDER BY created_at DESC', [user.rows[0].id]);
    res.json({ chats: chats.rows });
  }catch(err){ console.error(err); res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/chats', async (req, res) => {
  try{
    const { email, title, model } = req.body;
    const user = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (user.rows.length === 0) return res.status(400).json({ error: 'Юзер не найден' });
    const result = await pool.query(
      `INSERT INTO chats (user_id, title, model) VALUES ($1, $2, $3) RETURNING *`,
      [user.rows[0].id, title || 'Новый чат', model || 'GPT-5 mini']
    );
    res.json({ ok: true, chat: result.rows[0] });
  }catch(err){ console.error(err); res.status(500).json({ error: 'Ошибка' }); }
});

app.patch('/api/chats/:id', async (req, res) => {
  try{
    const { title } = req.body;
    await pool.query('UPDATE chats SET title = $1 WHERE id = $2', [title, req.params.id]);
    res.json({ ok: true });
  }catch(err){ console.error(err); res.status(500).json({ error: 'Ошибка' }); }
});

app.get('/api/messages/:chatId', async (req, res) => {
  try{
    const msgs = await pool.query('SELECT * FROM messages WHERE chat_id = $1 ORDER BY created_at ASC', [req.params.chatId]);
    res.json({ messages: msgs.rows });
  }catch(err){ console.error(err); res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/messages', async (req, res) => {
  try{
    const { chatId, role, text, files } = req.body;
    const result = await pool.query(
      `INSERT INTO messages (chat_id, role, text, files) VALUES ($1, $2, $3, $4) RETURNING *`,
      [chatId, role, text, JSON.stringify(files || [])]
    );
    res.json({ ok: true, message: result.rows[0] });
  }catch(err){ console.error(err); res.status(500).json({ error: 'Ошибка' }); }
});

/* ==================== PARTNER ==================== */
app.post('/api/partner', async (req, res) => {
  try{
    const { email, tiktokLink, screenshotUrl } = req.body;
    await pool.query(
      `INSERT INTO partner_apps (email, tiktok_link, screenshot_url) VALUES ($1, $2, $3)`,
      [email, tiktokLink, screenshotUrl || null]
    );
    const text = `🎁 <b>Новая заявка партнёрки!</b>\n\n📧 Email: <code>${email}</code>\n🎬 TikTok: ${tiktokLink}\n📸 Скриншот: ${screenshotUrl || '—'}`;
    await sendToTelegram(text);
    res.json({ ok: true });
  }catch(err){ console.error(err); res.status(500).json({ error: 'Ошибка' }); }
});

/* ==================== PAYMENT NOTIFY ==================== */
app.post('/api/payment-notify', async (req, res) => {
  try{
    const { fio, email, plan, amount, comment } = req.body;
    if(!email || !email.includes('@')) return res.status(400).json({ error: 'Некорректный email' });
    if(!plan) return res.status(400).json({ error: 'Не указан тариф' });

    const now = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
    const text = `💰 <b>НОВАЯ ОПЛАТА — XOCATEE AI</b>\n\n👤 ФИО: ${fio || '—'}\n📧 Email: <code>${email}</code>\n📦 Тариф: <b>${plan}</b>\n💵 Сумма: <b>${amount || '—'} ₽</b>\n🕐 Время: ${now}\n📝 Комментарий: ${comment || '—'}`;
    await sendToTelegram(text);
    res.json({ ok: true });
  }catch(err){
    console.error('Ошибка payment-notify:', err.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

/* ==================== ADMIN ==================== */
function checkAdmin(req, res, next){
  const pass = req.headers['x-admin-password'] || req.query.pass;
  if(pass !== ADMIN_PASSWORD) return res.status(403).json({ error: 'Доступ запрещён' });
  next();
}

app.get('/api/admin/users', checkAdmin, async (req, res) => {
  try{
    const users = await pool.query(`
      SELECT u.id, u.fio, u.email, u.created_at,
             s.plan_name, s.active, s.until, s.auto_renew,
             s.amount, s.paid_at, s.plan_key
      FROM users u
      LEFT JOIN subscriptions s ON s.user_id = u.id AND s.active = TRUE
      ORDER BY u.created_at DESC
    `);
    res.json({ users: users.rows });
  }catch(err){ console.error(err); res.status(500).json({ error: 'Ошибка' }); }
});

app.get('/api/admin/partner-apps', checkAdmin, async (req, res) => {
  try{
    const apps = await pool.query('SELECT * FROM partner_apps ORDER BY created_at DESC');
    res.json({ apps: apps.rows });
  }catch(err){ console.error(err); res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/admin/gift-subscription', checkAdmin, async (req, res) => {
  try{
    const { email, months, days, planName } = req.body;
    if(!email) return res.status(400).json({ error: 'Нужен email' });
    if(!months && !days) return res.status(400).json({ error: 'Нужны months или days' });

    const user = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if(user.rows.length === 0) return res.status(400).json({ error: 'Пользователь не найден' });

    const until = new Date();
    if(days) until.setDate(until.getDate() + parseInt(days));
    if(months) until.setMonth(until.getMonth() + parseInt(months));

    await pool.query('UPDATE subscriptions SET active = FALSE WHERE user_id = $1 AND active = TRUE', [user.rows[0].id]);

    const result = await pool.query(
      `INSERT INTO subscriptions (user_id, plan_key, plan_name, amount, paid_at, until, auto_renew, active)
       VALUES ($1, $2, $3, 0, NOW(), $4, FALSE, TRUE) RETURNING *`,
      [user.rows[0].id, 'gift', planName || 'Подарок', until]
    );

    await pool.query(`UPDATE partner_apps SET status = 'approved' WHERE email = $1 AND status = 'pending'`, [email]);

    res.json({ ok: true, subscription: result.rows[0] });
  }catch(err){ console.error(err); res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/admin/make-owner', checkAdmin, async (req, res) => {
  try{
    const { email } = req.body;
    const user = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if(user.rows.length === 0) return res.status(400).json({ error: 'Пользователь не найден' });

    await pool.query('UPDATE subscriptions SET active = FALSE WHERE user_id = $1 AND active = TRUE', [user.rows[0].id]);

    const result = await pool.query(
      `INSERT INTO subscriptions (user_id, plan_key, plan_name, amount, paid_at, until, auto_renew, active)
       VALUES ($1, 'owner', 'Владелец (бессрочно)', 0, NOW(), '2099-12-31', FALSE, TRUE) RETURNING *`,
      [user.rows[0].id]
    );

    res.json({ ok: true, subscription: result.rows[0] });
  }catch(err){ console.error(err); res.status(500).json({ error: 'Ошибка' }); }
});

/* ==================== SPA FALLBACK ==================== */
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 Сервер запущен: http://localhost:${PORT}`);
  console.log(`👑 Админка: http://localhost:${PORT}/admin.html`);
  console.log(`📲 Telegram: уведомления в личку + группу`);
  console.log(`📧 Email: Resend (noreply@xocatee.ru)`);
  console.log(`📊 Лимиты сообщений: активны\n`);
});
