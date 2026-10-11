/* ============================================================
   Push-сервер для чата (Railway).
   Отправляет уведомления, когда приложение закрыто.

   Переменные (Railway → сервис → Variables):
     FIREBASE_SERVICE_ACCOUNT — ВСЁ содержимое json-ключа
         (Firebase Console → Настройки проекта → Сервисные аккаунты →
          «Создать закрытый ключ»)
     APP_URL — адрес приложения, например https://99999cent-bit.github.io/Timer75rus/
         (куда открывать по нажатию на уведомление)

   Маршруты (все POST, с заголовком Authorization: Bearer <вход Firebase>):
     /push/message  {chatId, type, preview}  — новое сообщение
     /push/notify   {toUid, type, fromName}  — лайк, заявка, история…
     /push/call     {chatId}                 — входящий звонок
     /call/decline  {chatId, dk}             — «Отклонить» прямо в уведомлении (без входа,
                                               по одноразовому ключу из push о звонке)
     /push/test     {}                       — проверка: push на свои устройства
     /send-push     — то же, что выше (определяется по полям)
============================================================ */
const express = require('express');
const crypto = require('crypto');
const admin = require('firebase-admin');

let sa = null, initError = '';
process.on('uncaughtException', (e) => console.error('uncaught:', e && e.stack || e));
process.on('unhandledRejection', (e) => console.error('unhandled:', e && e.stack || e));
/* Ключ разбираем «с запасом»: даже если при копировании на телефоне json
   испортился (лишний перенос строки, кавычка, пробел), достаём из текста
   три нужных поля и собираем ключ заново. */
function pick(raw, name) {
  const m = new RegExp('"?' + name + '"?\\s*:\\s*"([^"]+)"').exec(raw);
  return m ? m[1].trim() : '';
}
function rebuildPem(raw) {
  const m = /-----BEGIN PRIVATE KEY-----([\s\S]*?)-----END PRIVATE KEY-----/.exec(raw);
  if (!m) return '';
  const body = m[1].replace(/\\\\n|\\n|\\r/g, '').replace(/[^A-Za-z0-9+/=]/g, '');
  return '-----BEGIN PRIVATE KEY-----\n' + body.replace(/(.{64})/g, '$1\n').replace(/\n$/, '') + '\n-----END PRIVATE KEY-----\n';
}
function readKey() {
  let raw = String(process.env.FIREBASE_SERVICE_ACCOUNT || '').trim();
  if (/^['"`]/.test(raw) && raw.slice(-1) === raw[0]) raw = raw.slice(1, -1).trim();   /* лишние кавычки вокруг */
  if (raw && raw.indexOf('{') < 0 && raw.indexOf('PRIVATE KEY') < 0) { try { raw = Buffer.from(raw, 'base64').toString('utf8'); } catch (e) {} }  /* ключ в base64 */
  /* вариант с тремя отдельными переменными */
  const envKey = process.env.FIREBASE_PRIVATE_KEY || '';
  if (!raw && !envKey) throw new Error('Не задана переменная FIREBASE_SERVICE_ACCOUNT');
  let j = null;
  try { j = JSON.parse(raw); } catch (e) { j = null; }
  const project_id = (j && j.project_id) || process.env.FIREBASE_PROJECT_ID || pick(raw, 'project_id');
  const client_email = (j && j.client_email) || process.env.FIREBASE_CLIENT_EMAIL || pick(raw, 'client_email');
  const private_key = rebuildPem((j && j.private_key) || envKey || raw);
  if (!project_id) throw new Error('в ключе не найден project_id');
  if (!client_email) throw new Error('в ключе не найден client_email');
  if (!private_key) throw new Error('в ключе не найден private_key (BEGIN/END PRIVATE KEY)');
  if (!j) console.log('json ключа повреждён, собран заново из полей');
  return { project_id, client_email, private_key };
}
try {
  sa = readKey();
  admin.initializeApp({ credential: admin.credential.cert({ projectId: sa.project_id, clientEmail: sa.client_email, privateKey: sa.private_key }) });
} catch (e) { sa = null; initError = 'Ключ FIREBASE_SERVICE_ACCOUNT не подходит: ' + e.message; console.error(initError); }
const db = sa ? admin.firestore() : null;
const APP_URL = (process.env.APP_URL || '').trim();
let SELF = '';   /* адрес этого сервера (для ссылок на аватарки) */

const app = express();
/* посредник для ИИ (расшифровка голосовых, перевод): из России адрес ИИ-сервера бывает
   недоступен без VPN — приложение может отправить запрос сюда, а сервер перешлёт его дальше.
   Пересылает только на адрес из настроек приложения (config/app.aiEndpoint) и только вошедшим. */
app.use('/ai', (req, res, next) => {
  res.set('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.set('Vary', 'Origin');
  res.set('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});
app.use('/ai', express.raw({ type: () => true, limit: '40mb' }), async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'server_not_configured' });
    await who(req);
    const cfg = await appConfig();
    const target = String(cfg.aiEndpoint || '').trim().replace(/\/+$/, '');
    if (!/^https:\/\//.test(target)) return res.status(503).json({ error: 'not_configured' });
    if (target.replace(/^https:\/\//, '').split('/')[0] === String(req.get('host') || '')) return res.status(508).json({ error: 'loop' });
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 120000);
    const r = await fetch(target + req.url, {
      method: req.method,
      headers: { 'Content-Type': req.get('content-type') || 'application/json', Authorization: req.get('authorization') || '' },
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req.body,
      signal: ac.signal
    }).finally(() => clearTimeout(t));
    res.status(r.status);
    const ct = r.headers.get('content-type'); if (ct) res.set('Content-Type', ct);
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    console.error('ai proxy', e.message);
    res.status(e.status || 502).json({ error: e.status === 401 ? 'unauthorized' : 'network' });
  }
});
app.use(express.json({ limit: '200kb' }));
/* разрешаем запросы из приложения (браузер/APK) */
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.set('Vary', 'Origin');
  res.set('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.set('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

/* аватарки для уведомлений: в базе они хранятся картинкой внутри текста (data:),
   а уведомлению нужна обычная ссылка — отдаём картинку по короткому адресу */
const avCache = new Map();
async function avatarOf(kind, id) {
  const key = kind + ':' + id, hit = avCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60000) return hit.v;
  let v = '';
  try {
    if (kind === 'u') { const d = await db.collection('users').doc(id).get(); v = d.exists ? (d.data().avatarUrl || '') : ''; }
    else { const d = await db.collection('chats').doc(id).get(); v = d.exists ? (d.data().communityAvatarUrl || '') : ''; }
  } catch (e) {}
  avCache.set(key, { v, at: Date.now() }); if (avCache.size > 500) avCache.clear();
  return v;
}
app.get('/avatar/:kind/:id', async (req, res) => {
  try {
    if (!db || !/^[uc]$/.test(req.params.kind) || !/^[\w-]{1,128}$/.test(req.params.id)) return res.status(404).end();
    const v = await avatarOf(req.params.kind, req.params.id);
    const m = /^data:(image\/[\w.+-]+);base64,(.+)$/.exec(v);
    if (m) { res.set('Cache-Control', 'public, max-age=3600'); return res.type(m[1]).send(Buffer.from(m[2], 'base64')); }
    if (/^https:\/\//.test(v)) return res.redirect(302, v);
    res.status(404).end();
  } catch (e) { res.status(500).end(); }
});

app.get('/', (req, res) => res.json({ ok: true, service: 'chat push', firebase: !!sa, error: initError || undefined }));

async function who(req) {
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!t) throw Object.assign(new Error('нет входа'), { status: 401 });
  try { return await admin.auth().verifyIdToken(t); }
  catch (e) { throw Object.assign(new Error('вход не подтверждён'), { status: 401 }); }
}
const nameOf = (u, fallback) => {
  if (!u) return fallback || 'Сообщение';
  const n = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
  return n || u.username || u.displayName || fallback || 'Сообщение';
};
const PREVIEW = { image: '🖼 Изображение', video: '🎬 Видео', voice: '🎤 Голосовое сообщение', roundvideo: '🎥 Видеосообщение', file: '📎 Файл', contact: '👤 Контакт', call: '📞 Звонок' };
const NOTIFY = {
  friend_request: 'хочет добавить вас в друзья', friend_accepted: 'принял(а) вашу заявку', profile_like: 'поставил(а) лайк вашему профилю',
  photo_like: 'оценил(а) ваше фото', mutual_like: 'у вас взаимная симпатия 💞', new_story: 'опубликовал(а) историю', story_like: 'оценил(а) вашу историю',
  story_reply: 'ответил(а) на вашу историю', story_mention: 'отметил(а) вас в истории', story_cmt_react: 'отреагировал(а) на ваш комментарий',
  community_invite: 'приглашает вас в сообщество', missed_call: 'пропущенный звонок'
};

/* разослать на все устройства человека; мёртвые токены убрать */
/* настройки приложения (config/app), кэш на минуту */
let cfgCache = null, cfgAt = 0;
async function appConfig() {
  if (cfgCache && Date.now() - cfgAt < 60000) return cfgCache;
  try { const d = await db.collection('config').doc('app').get(); cfgCache = d.exists ? d.data() : {}; } catch (e) { cfgCache = cfgCache || {}; }
  cfgAt = Date.now(); return cfgCache;
}

const strMap = (o) => { const r = {}; if (o) for (const k of Object.keys(o)) if (o[k] != null) r[k] = String(o[k]); return r; };

async function sendTo(uid, msg, diag) {
  diag = diag || {};
  const snap = await db.collection('users').doc(uid).get();
  if (!snap.exists) { diag.reason = 'нет профиля пользователя в базе'; return 0; }
  const u = snap.data();
  if (u.notificationsEnabled === false) { diag.reason = 'в настройках профиля уведомления выключены'; return 0; }
  if (!u.isAdmin && (await appConfig()).pushEnabled === false) { diag.reason = 'push у пользователей выключены в админке (вкладка «Оповещения»)'; return 0; }
  const tokens = Array.from(new Set((u.fcmTokens || []).filter(Boolean)));
  diag.tokens = tokens.length;
  if (!tokens.length) { diag.reason = 'в профиле нет ни одного устройства (fcmTokens пуст)'; return 0; }
  const link = APP_URL ? APP_URL + (msg.chatId ? (APP_URL.includes('?') ? '&' : '?') + 'chat=' + encodeURIComponent(msg.chatId) : '') : undefined;
  /* Шлём «только данные» — уведомление рисует firebase-messaging-sw.js.
     Так сообщение получается в 2–3 раза меньше: некоторые браузеры
     (например, Яндекс) принимают совсем маленькие push. Если всё же
     «слишком большое» — повторяем короче. */
  const cut = (t, n) => { t = String(t || ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
  const variants = [
    (m) => ({ data: Object.assign({ title: cut(m.title, 80), body: cut(m.body, 240), chatId: String(m.chatId || ''), sender: String(m.from || ''), type: String(m.kind || '') }, /^https:\/\//.test(m.icon || '') && String(m.icon).length < 600 ? { icon: String(m.icon) } : {}, strMap(m.extra)), webpush: { headers: { Urgency: 'high', TTL: '86400' } }, android: { priority: 'high', ttl: 86400000 } }),
    (m) => ({ data: Object.assign({ title: cut(m.title, 40), body: cut(m.body, 80), chatId: String(m.chatId || ''), sender: String(m.from || ''), type: String(m.kind || '') }, strMap(m.extra)), android: { priority: 'high' } }),
    (m) => ({ data: { title: cut(m.title, 24) || 'Chat' } })
  ];
  const isBig = (e) => e && /too large|too big|4K|4096/i.test(e.message || '');
  const results = new Array(tokens.length).fill(null);
  let left = tokens.map((t, i) => i);
  for (let v = 0; v < variants.length && left.length; v++) {
    const body = variants[v](msg);
    if (body.data) for (const k of Object.keys(body.data)) if (/^(from|notification|message_type|collapse_key)$|^(google|gcm)/i.test(k)) delete body.data[k];   /* зарезервированные Firebase ключи */
    const r0 = await admin.messaging().sendEachForMulticast(Object.assign({ tokens: left.map(i => tokens[i]) }, body));
    const again = [];
    r0.responses.forEach((x, k) => { const i = left[k]; results[i] = x; if (!x.success && isBig(x.error) && v < variants.length - 1) again.push(i); });
    if (again.length) (diag.retries = diag.retries || []).push('вариант ' + (v + 1) + ' (' + Buffer.byteLength(JSON.stringify(body)) + ' байт) слишком большой');
    left = again;
  }
  const r = { successCount: results.filter(x => x && x.success).length, responses: results };
  const dead = [];
  r.responses.forEach((x, i) => {
    const c = x.error && x.error.code;
    if (x.error) { console.error('push error', c, x.error.message); (diag.errors = diag.errors || []).push((c || 'error') + ': ' + x.error.message); }
    if (c === 'messaging/registration-token-not-registered' || c === 'messaging/invalid-registration-token') dead.push(tokens[i]);
  });
  diag.removed = dead.length;
  if (dead.length) await db.collection('users').doc(uid).update({ fcmTokens: admin.firestore.FieldValue.arrayRemove(...dead) }).catch(() => {});
  return r.successCount;
}

async function onMessage(me, b) {
  const chatId = String(b.chatId || '');
  const c = await db.collection('chats').doc(chatId).get();
  if (!c.exists) throw Object.assign(new Error('чат не найден'), { status: 404 });
  const chat = c.data();
  const parts = chat.participants || [];
  if (!parts.includes(me.uid)) throw Object.assign(new Error('вы не участник чата'), { status: 403 });
  const meDoc = await db.collection('users').doc(me.uid).get();
  const sender = nameOf(meDoc.exists ? meDoc.data() : null, (chat.usernames || {})[me.uid]);
  const type = String(b.type || 'text');
  const text = type === 'text' ? String(b.preview || '').slice(0, 140) || 'Новое сообщение' : (PREVIEW[type] || 'Новое сообщение');
  const title = chat.isCommunity ? (chat.communityName || 'Сообщество') : sender;
  const body = chat.isCommunity ? sender + ': ' + text : text;
  let sent = 0;
  for (const uid of parts) {
    if (uid === me.uid) continue;
    const lvl = (chat.mutedBy || {})[uid];
    if (lvl && lvl !== 'none' && lvl !== 'sound') continue;            /* уведомления в этом чате выключены */
    sent += await sendTo(uid, { title, body, chatId, from: me.uid, kind: 'message', tag: 'chat-' + chatId, silent: lvl === 'sound', icon: SELF ? SELF + (chat.isCommunity ? '/avatar/c/' + chatId : '/avatar/u/' + me.uid) : undefined });
  }
  return sent;
}
async function onNotify(me, b) {
  const to = String(b.toUid || '');
  if (!to || to === me.uid) return 0;
  const meDoc = await db.collection('users').doc(me.uid).get();
  const name = b.fromName || nameOf(meDoc.exists ? meDoc.data() : null);
  const what = NOTIFY[b.type] || 'новое уведомление';
  return sendTo(to, { title: name, body: what, from: me.uid, icon: SELF ? SELF + '/avatar/u/' + me.uid : undefined, kind: String(b.type || 'notify'), tag: 'n-' + (b.type || '') });
}
/* звонки: ключ для «Отклонить» из уведомления и слежение за звонком,
   чтобы убрать уведомление, когда звонящий положил трубку */
const CALLS = new Map();   /* chatId -> {dk, callees, unsub, timer} */
function stopWatch(chatId) {
  const w = CALLS.get(chatId); if (!w) return;
  try { w.unsub && w.unsub(); } catch (e) {}
  clearTimeout(w.timer);
}
function watchCall(chatId, callees, dk) {
  stopWatch(chatId);
  const w = { dk, callees, unsub: null, timer: null, done: false, at: Date.now() };
  CALLS.set(chatId, w);
  const finish = (status) => {
    if (w.done) return; w.done = true;
    try { w.unsub && w.unsub(); } catch (e) {}
    clearTimeout(w.timer);
    setTimeout(() => { if (CALLS.get(chatId) === w) CALLS.delete(chatId); }, 5 * 60000);
    for (const uid of callees) sendTo(uid, { title: '', body: '', chatId, kind: 'call_end', extra: { status: status || 'ended' } }).catch(() => {});
  };
  w.timer = setTimeout(() => finish('missed'), 65000);
  try {
    w.unsub = db.collection('calls').doc(chatId).onSnapshot((s) => {
      const st = s.exists ? String((s.data() || {}).status || '') : 'ended';
      if (st && st !== 'ringing') finish(st);
    }, () => {});
  } catch (e) {}
}
async function onCall(me, b) {
  const chatId = String(b.chatId || '');
  const c = await db.collection('chats').doc(chatId).get();
  if (!c.exists) return 0;
  const chat = c.data();
  if (!(chat.participants || []).includes(me.uid)) throw Object.assign(new Error('вы не участник чата'), { status: 403 });
  const meDoc = await db.collection('users').doc(me.uid).get();
  const name = nameOf(meDoc.exists ? meDoc.data() : null, (chat.usernames || {})[me.uid]);
  let callType = 'audio';
  try { const cd = await db.collection('calls').doc(chatId).get(); if (cd.exists && cd.data().callType === 'video') callType = 'video'; } catch (e) {}
  const dk = crypto.randomBytes(12).toString('hex');
  const callees = chat.participants.filter((u) => u !== me.uid);
  watchCall(chatId, callees, dk);
  const extra = { callType, dk, declineUrl: SELF ? SELF + '/call/decline' : '' };
  let sent = 0;
  for (const uid of callees) sent += await sendTo(uid, { title: (callType === 'video' ? '📹 ' : '📞 ') + name, body: callType === 'video' ? 'Входящий видеозвонок' : 'Входящий аудиозвонок', chatId, from: me.uid, icon: SELF ? SELF + '/avatar/u/' + me.uid : undefined, kind: 'call', tag: 'call-' + chatId, extra });
  return sent;
}
/* «Отклонить» в уведомлении о звонке */
app.post('/call/decline', async (req, res) => {
  try {
    const chatId = String((req.body || {}).chatId || ''), dk = String((req.body || {}).dk || '');
    const w = CALLS.get(chatId);
    if (!db || !w || !dk || w.dk !== dk) return res.status(403).json({ ok: false });
    const ref = db.collection('calls').doc(chatId);
    const ok = await db.runTransaction(async (tx) => {
      const s = await tx.get(ref);
      if (!s.exists || s.data().status !== 'ringing') return false;
      tx.update(ref, { status: 'declined', endedAt: Date.now() });
      return true;
    });
    res.json({ ok });
  } catch (e) { console.error('decline', e.message); res.status(500).json({ ok: false }); }
});
async function onTest(me) {
  const d = {};
  const sent = await sendTo(me.uid, { title: '✅ Push работает', body: 'Так будут приходить уведомления, когда приложение закрыто', kind: 'test', tag: 'test' }, d);
  return Object.assign({ sent }, d);
}

function route(fn) {
  return async (req, res) => {
    try {
      if (!db) return res.status(500).json({ ok: false, error: initError || 'на сервере не задан FIREBASE_SERVICE_ACCOUNT' });
      SELF = 'https://' + (req.get('x-forwarded-host') || req.get('host'));
      const me = await who(req);
      const out = await fn(me, req.body || {});
      res.json(out && typeof out === 'object' ? Object.assign({ ok: true }, out) : { ok: true, sent: out });
    } catch (e) {
      console.error(req.path, e.message);
      res.status(e.status || 500).json({ ok: false, error: e.message });
    }
  };
}
app.post('/push/message', route(onMessage));
app.post('/push/notify', route(onNotify));
app.post('/push/call', route(onCall));
app.post('/push/test', route(onTest));
app.post('/send-push', route((me, b) => b.test ? onTest(me) : b.toUid ? onNotify(me, b) : b.call ? onCall(me, b) : onMessage(me, b)));

const PORT = +process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log('push server on port', PORT, sa ? '(firebase ok)' : '(' + initError + ')'));
