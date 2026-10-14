/* ============================================================
   Напоминания при закрытом приложении: календарь и займы.

   Приложение (Android и браузер) каждую минуту присылает сюда расписание
   на 30 дней вперёд — POST /reminders/sync {items:[…]}. Сервер хранит его
   в базе (коллекция reminderQueue, документ = пользователь) и каждые
   20 секунд проверяет, что уже пора:
     • займ: отправляет сообщение должнику в чат (как раньше делало
       открытое приложение) — даже если ваше приложение закрыто;
     • любое напоминание: push на устройства (в браузере и PWA уведомление
       приходит при закрытой вкладке; Android-приложение такие push
       пропускает — у него свои системные будильники).

   Гарантия «не больше одного раза»: перед отправкой напоминание помечается
   как доставленное. Если сервер упал между пометкой и отправкой — оно
   не повторится (лучше пропустить, чем отправить дважды).
============================================================ */
module.exports = function setupReminders(ctx) {
  const { app, db, admin, route, sendTo, onMessage, appConfig, nameOf } = ctx;
  const LATE_MS = 6 * 3600e3;                 /* опоздавшее больше чем на 6 часов уже не показываем */
  const KEEP_SENT_MS = 3 * 86400e3;
  const MAX_ITEMS = 150;
  const queue = () => db.collection('reminderQueue');

  const clip = (v, n) => String(v == null ? '' : v).slice(0, n);
  function clean(arr) {
    const out = [], now = Date.now();
    for (const x of Array.isArray(arr) ? arr : []) {
      if (out.length >= MAX_ITEMS) break;
      const key = clip(x && x.key, 160), at = +(x && x.at);
      if (!key || !isFinite(at) || at < now - LATE_MS || at > now + 400 * 86400e3) continue;
      const it = { key, at, title: clip(x.title, 120), text: clip(x.text, 400), target: clip(x.target, 200) };
      if (x.loan && x.loan.contactUid && x.loan.msg) it.loan = { contactUid: clip(x.loan.contactUid, 128), msg: clip(x.loan.msg, 900) };
      out.push(it);
    }
    return out;
  }
  const nextAtOf = (items) => items.reduce((n, it) => (n == null ? it.at : Math.min(n, it.at)), null);

  /* ---- приём расписания от приложения ---- */
  async function onSync(me, b) {
    const items = clean(b.items), ref = queue().doc(me.uid), now = Date.now();
    let sentKeys = [];
    await db.runTransaction(async (tx) => {
      const s = await tx.get(ref), sent = s.exists ? Object.assign({}, s.data().sent || {}) : {};
      const keep = items.filter((it) => !sent[it.key]);              /* уже доставленное не ставим повторно */
      const fresh = {};
      Object.keys(sent).forEach((k) => { if (now - sent[k] < KEEP_SENT_MS) fresh[k] = sent[k]; });
      sentKeys = Object.keys(fresh).slice(-200);
      tx.set(ref, { items: keep, sent: fresh, nextAt: nextAtOf(keep), updatedAt: now });
    });
    let tokens = 0;
    try { const u = await db.collection('users').doc(me.uid).get(); tokens = u.exists ? (u.data().fcmTokens || []).filter(Boolean).length : 0; } catch (e) {}
    return { count: items.length, tokens, sent: sentKeys };
  }

  /* ---- сообщение должнику в чат (то же, что делает приложение: ensureChat + sendMessage) ---- */
  async function loanChatMessage(uid, ln) {
    const to = String(ln.contactUid || '');
    if (!to || to === uid) return 0;
    const chatId = [uid, to].sort().join('__');
    const ref = db.collection('chats').doc(chatId);
    const [meS, toS, chatS, cfg] = await Promise.all([db.collection('users').doc(uid).get(), db.collection('users').doc(to).get(), ref.get(), appConfig()]);
    const me = meS.exists ? meS.data() : {}, other = toS.exists ? toS.data() : {}, now = Date.now();
    if (!chatS.exists) {
      await ref.set({
        id: chatId, participants: [uid, to],
        usernames: { [uid]: me.username || nameOf(me, uid), [to]: other.username || nameOf(other, to) },
        emails: { [uid]: me.email || '', [to]: other.email || '' },
        createdAt: now, lastMessage: '', lastType: 'text', lastTimestamp: now, lastFrom: '', messageCount: 0, hiddenFor: []
      });
    }
    /* срок хранения сообщений — как у приложения: наименьший из ваших настроек, настроек собеседника и общего предела */
    const unlimited = +cfg.maxRetentionDays === 0 || cfg.retentionUnlimited === true;
    const capDays = +cfg.maxRetentionDays >= 1 && +cfg.maxRetentionDays <= 3650 ? Math.round(+cfg.maxRetentionDays) : 7;
    const cap = unlimited ? Infinity : capDays * 1440;
    const mine = typeof me.retentionMinutes === 'number' && me.retentionMinutes > 0 ? me.retentionMinutes : cap;
    const theirs = typeof other.retentionMinutes === 'number' && other.retentionMinutes > 0 ? other.retentionMinutes : cap;
    const mins = Math.max(1, Math.min(mine, theirs, cap));
    const expireAt = isFinite(mins) ? now + 60000 * mins : null;
    const text = String(ln.msg || '').slice(0, 900);
    await Promise.all([
      db.collection('messages').add({ chatId, from: uid, type: 'text', content: text, fileName: null, timestamp: now, hiddenFor: [], expireAt }),
      ref.set({ lastMessage: text.slice(0, 80), lastType: 'text', lastTimestamp: now, lastFrom: uid, lastSilent: false, lastMessageExpireAt: expireAt, hiddenFor: [], messageCount: admin.firestore.FieldValue.increment(1) }, { merge: true })
    ]);
    try { await onMessage({ uid }, { chatId, type: 'text', preview: text }); } catch (e) { console.error('loan push', e.message); }   /* уведомление собеседнику */
    return 1;
  }

  /* ---- обработка наступивших напоминаний одного пользователя ---- */
  async function processUser(ref, uid) {
    const now = Date.now();
    const due = await db.runTransaction(async (tx) => {             /* сначала «занимаем» — потом отправляем */
      const s = await tx.get(ref); if (!s.exists) return [];
      const d = s.data(), sent = Object.assign({}, d.sent || {}), items = d.items || [];
      const hit = items.filter((it) => !sent[it.key] && it.at <= now + 1000);
      hit.forEach((it) => { sent[it.key] = now; });
      const rest = items.filter((it) => !sent[it.key]), fresh = {};
      Object.keys(sent).forEach((k) => { if (now - sent[k] < KEEP_SENT_MS) fresh[k] = sent[k]; });
      tx.update(ref, { items: rest, sent: fresh, nextAt: nextAtOf(rest) });
      return hit;
    });
    for (const it of due) {
      if (now - it.at > LATE_MS) continue;
      if (it.loan) { try { await loanChatMessage(uid, it.loan); } catch (e) { console.error('loan message', uid, e.message); } }
      try { await sendTo(uid, { title: it.title, body: it.text, kind: 'rem-' + it.key, tag: 'rem-' + it.key, extra: { target: it.target } }); }
      catch (e) { console.error('reminder push', uid, e.message); }
    }
    return due.length;
  }

  let busy = false;
  async function tick() {
    if (!db || busy) return 0;
    busy = true; let n = 0;
    try {
      const snap = await queue().where('nextAt', '<=', Date.now() + 1000).limit(30).get();
      for (const doc of snap.docs) { try { n += await processUser(doc.ref, doc.id); } catch (e) { console.error('reminder user', doc.id, e.message); } }
    } catch (e) { console.error('reminder tick', e.message); }
    busy = false;
    return n;
  }

  app.post('/reminders/sync', route(onSync));
  setInterval(tick, 20000);
  setTimeout(tick, 10000);
  return { onSync, tick, processUser, loanChatMessage, clean };
};
