/* ============================================================
   Push-сервер для чата (Railway).
   Отправляет уведомления, когда приложение закрыто.

   Переменные (Railway → сервис → Variables):
     FIREBASE_SERVICE_ACCOUNT — ВСЁ содержимое json-ключа
         (Firebase Console → Настройки проекта → Сервисные аккаунты →
          «Создать закрытый ключ»)
     APP_URL — адрес приложения, например https://99999cent-bit.github.io/
         (куда открывать по нажатию на уведомление)

   Маршруты (все POST, с заголовком Authorization: Bearer <вход Firebase>):
     /push/message  {chatId, type, preview}  — новое сообщение
     /push/notify   {toUid, type, fromName}  — лайк, заявка, история…
     /push/call     {chatId}                 — входящий звонок
     /push/test     {}                       — проверка: push на свои устройства
     /send-push     — то же, что выше (определяется по полям)
============================================================ */
const express = require('express');
const admin = require('firebase-admin');

let sa = null;
try { sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || ''); } catch (e) {}
if (sa && sa.private_key) sa.private_key = String(sa.private_key).replace(/\\n/g, '\n');
if (sa) admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = sa ? admin.firestore() : null;
const APP_URL = (process.env.APP_URL || '').trim();

const app = express();
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

app.get('/', (req, res) => res.json({ ok: true, service: 'chat push', firebase: !!sa }));

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
async function sendTo(uid, msg) {
  const snap = await db.collection('users').doc(uid).get();
  if (!snap.exists) return 0;
  const u = snap.data();
  if (u.notificationsEnabled === false) return 0;
  const tokens = Array.from(new Set((u.fcmTokens || []).filter(Boolean)));
  if (!tokens.length) return 0;
  const link = APP_URL ? APP_URL + (msg.chatId ? (APP_URL.includes('?') ? '&' : '?') + 'chat=' + encodeURIComponent(msg.chatId) : '') : undefined;
  const data = Object.fromEntries(Object.entries({ chatId: msg.chatId || '', type: msg.kind || '', url: link || '' }).map(([k, v]) => [k, String(v)]));
  const r = await admin.messaging().sendEachForMulticast({
    tokens,
    data: Object.assign({ title: msg.title, body: msg.body }, data),
    webpush: {
      notification: { title: msg.title, body: msg.body, icon: msg.icon || undefined, tag: msg.tag || undefined, renotify: true, silent: !!msg.silent },
      fcmOptions: link ? { link } : undefined,
      headers: { Urgency: 'high', TTL: '86400' }
    },
    android: { priority: 'high' }
  });
  const dead = [];
  r.responses.forEach((x, i) => {
    const c = x.error && x.error.code;
    if (c === 'messaging/registration-token-not-registered' || c === 'messaging/invalid-registration-token' || c === 'messaging/invalid-argument') dead.push(tokens[i]);
  });
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
    sent += await sendTo(uid, { title, body, chatId, kind: 'message', tag: 'chat-' + chatId, silent: lvl === 'sound', icon: chat.isCommunity ? chat.communityAvatarUrl : (meDoc.exists && meDoc.data().avatarUrl && !String(meDoc.data().avatarUrl).startsWith('data:') ? meDoc.data().avatarUrl : undefined) });
  }
  return sent;
}
async function onNotify(me, b) {
  const to = String(b.toUid || '');
  if (!to || to === me.uid) return 0;
  const meDoc = await db.collection('users').doc(me.uid).get();
  const name = b.fromName || nameOf(meDoc.exists ? meDoc.data() : null);
  const what = NOTIFY[b.type] || 'новое уведомление';
  return sendTo(to, { title: name, body: what, kind: String(b.type || 'notify'), tag: 'n-' + (b.type || '') });
}
async function onCall(me, b) {
  const chatId = String(b.chatId || '');
  const c = await db.collection('chats').doc(chatId).get();
  if (!c.exists) return 0;
  const chat = c.data();
  if (!(chat.participants || []).includes(me.uid)) throw Object.assign(new Error('вы не участник чата'), { status: 403 });
  const meDoc = await db.collection('users').doc(me.uid).get();
  const name = nameOf(meDoc.exists ? meDoc.data() : null, (chat.usernames || {})[me.uid]);
  let sent = 0;
  for (const uid of chat.participants) if (uid !== me.uid) sent += await sendTo(uid, { title: '📞 ' + name, body: 'Входящий звонок', chatId, kind: 'call', tag: 'call-' + chatId });
  return sent;
}
async function onTest(me) {
  return sendTo(me.uid, { title: '✅ Push работает', body: 'Так будут приходить уведомления, когда приложение закрыто', kind: 'test', tag: 'test' });
}

function route(fn) {
  return async (req, res) => {
    try {
      if (!db) return res.status(500).json({ ok: false, error: 'на сервере не задан FIREBASE_SERVICE_ACCOUNT' });
      const me = await who(req);
      const sent = await fn(me, req.body || {});
      res.json({ ok: true, sent });
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

app.listen(process.env.PORT || 3000, () => console.log('push server on', process.env.PORT || 3000));
