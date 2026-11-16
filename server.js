'use strict';
/*
 * Karibu Kwenu – serveur (Node.js, aucune dépendance à installer)
 * Démarrage : node server.js
 *
 * Variables d'environnement (Render > Environment) :
 *   ADMIN_PASSWORD     mot de passe administrateur de départ (recommandé)
 *   CUISINE_PASSWORD   mot de passe du profil Cuisine (facultatif)
 *   LIVREUR_PASSWORD   mot de passe du profil Livreur (facultatif)
 *   SESSION_SECRET     longue phrase au hasard pour signer les connexions (recommandé)
 *   RESEND_API_KEY     clé API Resend pour envoyer le mail « Mot de passe oublié »
 *   ADMIN_EMAIL        adresse qui reçoit le nouveau mot de passe (défaut : andrickmahemene@gmail.com)
 *   MAIL_FROM          expéditeur (défaut : Karibu Kwenu <onboarding@resend.dev>)
 *   DATA_DIR           dossier de sauvegarde des données (défaut : ./data)
 *   DEMO_PAYMENTS      "false" pour désactiver les paiements simulés
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'andrickmahemene@gmail.com';
const MAIL_FROM = process.env.MAIL_FROM || 'Karibu Kwenu <onboarding@resend.dev>';
const RESEND_URL = process.env.RESEND_URL || 'https://api.resend.com/emails';
const DEMO = process.env.DEMO_PAYMENTS !== 'false';
const TZ = 'Africa/Bangui';
const log = (...a) => console.log('[KARIBU]', ...a);

/* ---------- Sauvegarde sur disque ---------- */
let DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.accessSync(DATA_DIR, fs.constants.W_OK); }
catch (e) { DATA_DIR = path.join(os.tmpdir(), 'karibu-data'); fs.mkdirSync(DATA_DIR, { recursive: true }); log('Dossier de données inaccessible, utilisation de', DATA_DIR); }
const load = (f, def) => { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')); } catch (e) { return def; } };
const save = (f, o) => { try { const p = path.join(DATA_DIR, f); fs.writeFileSync(p + '.tmp', JSON.stringify(o)); fs.renameSync(p + '.tmp', p); } catch (e) { log('Écriture impossible :', e.message); } };

/* ---------- Données par défaut (modifiables dans l'espace Admin) ---------- */
const DEFAULT_CFG = {
  menu: [
    { id: 1, e: '🍽️', c: 'Plats', n: 'Pondu', d: 'Feuilles de manioc pilées, cuites à l’huile de palme.', p: 3500, av: true, pre: false },
    { id: 2, e: '🍽️', c: 'Plats', n: 'Poulet à la moambé', d: 'Poulet mijoté dans la sauce de noix de palme.', p: 4500, av: true, pre: false },
    { id: 3, e: '🍽️', c: 'Plats', n: 'Liboke de poisson', d: 'Poisson cuit à l’étouffée dans des feuilles.', p: 5000, av: true, pre: false },
    { id: 4, e: '🍽️', c: 'Plats', n: 'Saka-saka', d: 'Feuilles de manioc mijotées avec poisson fumé.', p: 3500, av: true, pre: false },
    { id: 5, e: '🍽️', c: 'Grillades', n: 'Poisson braisé', d: 'Poisson entier braisé, sauce pimentée.', p: 5500, av: true, pre: false },
    { id: 6, e: '🍽️', c: 'Grillades', n: 'Brochettes', d: 'Brochettes grillées et assaisonnées.', p: 3000, av: true, pre: false },
    { id: 7, e: '🍽️', c: 'Accompagnements', n: 'Plantain frit', d: 'Bananes plantain dorées.', p: 1500, av: true, pre: false },
    { id: 8, e: '🍽️', c: 'Douceurs', n: 'Mikate', d: 'Beignets congolais moelleux.', p: 1000, av: true, pre: false }
  ],
  acc: [{ n: 'Riz blanc', p: 0 }, { n: 'Chikwangue', p: 500 }, { n: 'Plantain frit', p: 1000 }],
  fee: 1000,
  hrs: { o: 12, c: 20, d: [1, 1, 1, 1, 1, 1, 1] }
};
const state = load('state.json', null) || { cfg: DEFAULT_CFG, orders: [], paylog: [], seq: 1000 };
const saveState = () => save('state.json', state);

/* ---------- Mots de passe et connexions ---------- */
const ROLES = ['admin', 'cuisine', 'livreur'];
const ENVPW = { admin: process.env.ADMIN_PASSWORD, cuisine: process.env.CUISINE_PASSWORD, livreur: process.env.LIVREUR_PASSWORD };
const auth = load('auth.json', null) || { roles: {} };
if (!auth.secret) auth.secret = crypto.randomBytes(32).toString('hex');
const SECRET = process.env.SESSION_SECRET || auth.secret;
const saveAuth = () => save('auth.json', auth);
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
const genPw = () => Array.from({ length: 12 }, () => ALPHA[crypto.randomInt(ALPHA.length)]).join('');

function setPw(role, pw) {
  const r = auth.roles[role] || (auth.roles[role] = { v: 0 });
  r.salt = crypto.randomBytes(16).toString('hex');
  r.hash = hashPw(pw, r.salt);
  r.v = (r.v || 0) + 1;      // invalide les anciennes connexions
  r.pending = null;
}
(function initPasswords() {
  for (const role of ROLES) {
    const env = ENVPW[role], r = auth.roles[role];
    if (env) {
      if (!r || !r.hash || r.envFp !== sha(env)) { setPw(role, env); auth.roles[role].envFp = sha(env); }
    } else if (!r || !r.hash) {
      const pw = genPw(); setPw(role, pw);
      log(`Mot de passe initial du profil « ${role} » : ${pw}   (définissez ${role.toUpperCase()}_PASSWORD dans Render pour le fixer)`);
    }
  }
  saveAuth();
})();

function eq(pw, hash, salt) {
  const a = Buffer.from(hashPw(pw, salt), 'hex'), b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function checkPw(role, pw) {
  const r = auth.roles[role];
  if (!r || typeof pw !== 'string' || !pw || pw.length > 200) return false;
  if (eq(pw, r.hash, r.salt)) return 'ok';
  if (r.pending && r.pending.exp > Date.now() && eq(pw, r.pending.hash, r.pending.salt)) return 'temp';
  return false;
}
const sign = o => { const b = Buffer.from(JSON.stringify(o)).toString('base64url'); return b + '.' + crypto.createHmac('sha256', SECRET).update(b).digest('base64url'); };
function tokenFor(role) { return sign({ r: role, v: auth.roles[role].v, exp: Date.now() + 12 * 3600e3 }); }
function userOf(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || ''); if (!m) return null;
  const [b, s] = m[1].split('.'); if (!b || !s) return null;
  const good = crypto.createHmac('sha256', SECRET).update(b).digest('base64url');
  if (s.length !== good.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(good))) return null;
  try {
    const o = JSON.parse(Buffer.from(b, 'base64url').toString());
    if (!ROLES.includes(o.r) || o.exp < Date.now() || auth.roles[o.r].v !== o.v) return null;
    return { role: o.r };
  } catch (e) { return null; }
}

/* ---------- Limites anti-abus ---------- */
const buckets = new Map();
function hit(key, max, ms, count = true) {
  const now = Date.now(); let b = buckets.get(key);
  if (!b || b.reset < now) { b = { n: 0, reset: now + ms }; buckets.set(key, b); }
  if (b.n >= max) return false;
  if (count) b.n++;
  return true;
}
const clear = key => buckets.delete(key);
setInterval(() => { const n = Date.now(); for (const [k, b] of buckets) if (b.reset < n) buckets.delete(k); }, 600e3).unref();
const ipOf = req => ((req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '?';

/* ---------- E-mail (Resend, via HTTPS) ---------- */
async function sendMail(to, subject, text) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return 'nokey';
  const r = await fetch(RESEND_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, text })
  });
  if (!r.ok) throw new Error('Resend ' + r.status + ' ' + (await r.text().catch(() => '')).slice(0, 300));
  return 'sent';
}
const maskMail = m => m.replace(/^(.{2}).*(@.*)$/, '$1***$2');

/* ---------- Outils ---------- */
const STATUS_WAIT = 'En attente de paiement';
const j = (res, code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(b); };
const fail = (res, code, msg) => j(res, code, { error: msg });
function body(req, max = 12 * 1024 * 1024) {
  return new Promise((ok, ko) => {
    let n = 0; const c = [];
    req.on('data', d => { n += d.length; if (n > max) { ko(Object.assign(new Error('Requête trop volumineuse.'), { status: 413 })); req.destroy(); } else c.push(d); });
    req.on('end', () => { if (!c.length) return ok({}); try { ok(JSON.parse(Buffer.concat(c).toString('utf8'))); } catch (e) { ko(Object.assign(new Error('Données invalides.'), { status: 400 })); } });
    req.on('error', ko);
  });
}
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const nowIso = () => new Date().toISOString();
const addH = (o, t) => o.h.push([nowIso(), t]);
const addLog = (id, t) => { state.paylog.push([nowIso(), id, t]); if (state.paylog.length > 500) state.paylog.shift(); };
const banguiDate = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
const banguiHour = () => parseInt(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: TZ }).format(new Date()), 10);
const dayOpen = (d, hrs) => !!hrs.d[(new Date(d + 'T12:00:00').getDay() + 6) % 7];
const publicOrder = o => o;
const staffOrder = (o, role) => { const c = { ...o }; delete c.ref; if (role !== 'admin') delete c.mm; return c; };

/* ---------- Validation de la configuration ---------- */
function cleanCfg(b) {
  if (!b || !Array.isArray(b.menu) || !Array.isArray(b.acc)) throw new Error('Configuration invalide.');
  const ids = new Set();
  const menu = b.menu.slice(0, 200).map(m => {
    const id = parseInt(m.id, 10), p = Number(m.p);
    if (!Number.isInteger(id) || ids.has(id) || !str(m.n, 80) || !(p >= 0) || !isFinite(p)) throw new Error('Plat invalide : ' + str(m.n, 40));
    ids.add(id);
    const o = { id, e: str(m.e, 8) || '🍽️', c: str(m.c, 30) || 'Plats', n: str(m.n, 80), d: str(m.d, 300), p: Math.round(p), av: !!m.av, pre: !!m.pre };
    if (typeof m.img === 'string' && m.img.startsWith('data:image/') && m.img.length < 2.5e6) o.img = m.img;
    return o;
  });
  const acc = b.acc.slice(0, 50).map(a => { const p = Number(a.p) || 0; if (!str(a.n, 60) || p < 0) throw new Error('Accompagnement invalide.'); return { n: str(a.n, 60), p: Math.round(p) }; });
  const fee = Number(b.fee), hrs = b.hrs || {};
  const o = parseInt(hrs.o, 10), c = parseInt(hrs.c, 10);
  if (!(fee >= 0) || !(o >= 0 && o <= 23) || !(c >= 1 && c <= 24) || !Array.isArray(hrs.d) || hrs.d.length !== 7) throw new Error('Frais ou horaires invalides.');
  return { menu, acc, fee: Math.round(fee), hrs: { o, c, d: hrs.d.map(x => (x ? 1 : 0)) } };
}

/* ---------- Commandes ---------- */
function newOrder(b, ip) {
  const cfg = state.cfg;
  if (!Array.isArray(b.items) || !b.items.length || b.items.length > 40) throw new Error('Votre panier est vide.');
  const items = []; let sub = 0;
  for (const it of b.items) {
    const m = cfg.menu.find(x => x.id === it.id), q = parseInt(it.q, 10);
    if (!m) throw new Error('Un plat de votre panier n’existe plus.');
    if (!m.av) throw new Error('« ' + m.n + ' » est épuisé.');
    if (!(q >= 1 && q <= 50)) throw new Error('Quantité invalide.');
    let a = it.a === null || it.a === undefined ? null : String(it.a), ap = 0;
    if (a) { const ac = cfg.acc.find(x => x.n === a); if (!ac) throw new Error('Accompagnement indisponible : ' + a); ap = ac.p; }
    sub += (m.p + ap) * q;
    items.push({ id: m.id, q, n: m.n, a, ap, p: m.p });
  }
  const nm = str(b.nm, 80), ph = str(b.ph, 30), mm = str(b.mm, 30), ad = str(b.ad, 200), rp = str(b.rp, 200), op = str(b.op, 40);
  if (!nm || !ph || !ad || !mm) throw new Error('Merci de renseigner nom, téléphone, adresse et numéro Mobile Money.');
  if (op !== 'Orange Money') throw new Error('Cet opérateur n’est pas encore disponible. Choisissez Orange Money.');
  const dt = str(b.dt, 10), sl = str(b.sl, 20);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dt) || isNaN(new Date(dt + 'T12:00:00'))) throw new Error('Date de livraison invalide.');
  if (dt < new Date().toISOString().slice(0, 10)) throw new Error('La date de livraison est passée.');
  if (!dayOpen(dt, cfg.hrs)) throw new Error('Nous ne livrons pas ce jour-là : choisissez une autre date.');
  const sm = /^(\d{1,2})h [–-] (\d{1,2})h$/.exec(sl);
  const s0 = sm ? +sm[1] : -1, s1 = sm ? +sm[2] : -1;
  if (!sm || s1 !== s0 + 1 || s0 < cfg.hrs.o || s0 >= cfg.hrs.c) throw new Error('Créneau de livraison invalide.');
  if (dt === banguiDate() && s0 <= banguiHour()) throw new Error('Ce créneau est déjà passé : choisissez-en un autre.');
  const fee = cfg.fee;
  const id = 'CMD-' + (++state.seq);
  const o = {
    id, ref: 'KK-' + crypto.randomBytes(4).toString('hex').toUpperCase(), st: STATUS_WAIT, paid: false,
    items, nm, ph, mm, ad, rp, dt, sl, op, sub, fee, total: sub + fee, liv: '', created: nowIso(), h: []
  };
  addH(o, 'Commande créée, en attente de paiement');
  return o;
}

function payOrder(o, b) {
  if (!DEMO) throw Object.assign(new Error('Le paiement en ligne n’est pas encore activé.'), { status: 501 });
  if (str(b.ref, 30) !== o.ref) throw Object.assign(new Error('Référence de paiement inconnue.'), { status: 400 });
  if (o.st !== STATUS_WAIT) return o; // déjà traité : on ne retraite jamais un paiement
  const res = str(b.result, 10), amt = Number(b.amount);
  if (res === 'ok') {
    if (amt !== o.total) {
      addH(o, 'Montant incorrect : paiement refusé'); addLog(o.id, 'Montant reçu ' + amt + ' ≠ ' + o.total + ' : refusé');
      saveState(); throw Object.assign(new Error('Montant incorrect : le paiement est refusé.'), { status: 400 });
    }
    o.paid = true; o.st = 'Payée'; addH(o, 'Paiement confirmé'); addLog(o.id, 'Paiement confirmé ' + o.total + ' FCFA');
  } else if (res === 'fail') { addH(o, 'Paiement échoué'); addLog(o.id, 'Paiement échoué'); }
  else if (res === 'pend') { addH(o, 'Paiement en attente de confirmation'); addLog(o.id, 'Paiement en attente'); }
  else throw Object.assign(new Error('Résultat de paiement inconnu.'), { status: 400 });
  saveState(); return o;
}

const FLOW = {
  prepare: { roles: ['cuisine', 'admin'], from: 'Payée', to: 'En préparation', msg: 'Préparation démarrée' },
  ready: { roles: ['cuisine', 'admin'], from: 'En préparation', to: 'Prête', msg: 'Commande prête' },
  start: { roles: ['livreur', 'admin'], from: 'Prête', to: 'En livraison', msg: 'Départ en livraison' },
  delivered: { roles: ['livreur', 'admin'], from: 'En livraison', to: 'Livrée', msg: 'Livraison confirmée' }
};
function actOrder(o, role, b) {
  const a = str(b.action, 20);
  if (a === 'refund') {
    if (role !== 'admin') throw Object.assign(new Error('Action réservée à l’administrateur.'), { status: 403 });
    if (!o.paid || ['Annulée', 'Remboursée'].includes(o.st)) throw new Error('Cette commande ne peut pas être remboursée.');
    o.st = 'Remboursée'; addH(o, 'Remboursement (plat retourné)'); addLog(o.id, 'Remboursement ' + o.total + ' FCFA');
  } else if (a === 'cancel') {
    if (role !== 'admin') throw Object.assign(new Error('Action réservée à l’administrateur.'), { status: 403 });
    if (o.paid || o.st !== STATUS_WAIT) throw new Error('Seule une commande non payée peut être annulée.');
    o.st = 'Annulée'; addH(o, 'Commande annulée');
  } else if (FLOW[a]) {
    const f = FLOW[a];
    if (!f.roles.includes(role)) throw Object.assign(new Error('Action non autorisée pour votre profil.'), { status: 403 });
    if (o.st !== f.from) throw new Error('Statut actuel incompatible : ' + o.st + '.');
    if (a === 'start') { const l = str(b.liv, 40); if (!l) throw new Error('Choisissez un livreur.'); o.liv = l; }
    o.st = f.to; addH(o, f.msg + (a === 'start' ? ' (' + o.liv + ')' : ''));
  } else throw new Error('Action inconnue.');
  saveState(); return o;
}

/* ---------- Routes API ---------- */
async function api(req, res, url) {
  const m = req.method, p = url.pathname, ip = ipOf(req);

  if (p === '/api/config' && m === 'GET') return j(res, 200, { ...state.cfg, demo: DEMO });
  if (p === '/api/config' && m === 'PUT') {
    const u = userOf(req); if (!u) return fail(res, 401, 'Connexion requise.');
    if (u.role !== 'admin') return fail(res, 403, 'Réservé à l’administrateur.');
    state.cfg = cleanCfg(await body(req)); saveState(); return j(res, 200, { ok: true });
  }

  if (p === '/api/login' && m === 'POST') {
    const b = await body(req), role = str(b.role, 20), key = 'login:' + ip;
    if (!hit(key, 8, 15 * 60e3, false)) return fail(res, 429, 'Trop de tentatives. Réessayez dans quelques minutes.');
    const r = ROLES.includes(role) ? checkPw(role, b.password) : false;
    if (!r) { hit(key, 8, 15 * 60e3); return fail(res, 401, 'Mot de passe incorrect.'); }
    clear(key);
    if (r === 'temp') setPw(role, b.password), saveAuth(); // le mot de passe temporaire devient le mot de passe actuel
    return j(res, 200, { token: tokenFor(role), role, temp: r === 'temp' });
  }

  if (p === '/api/forgot' && m === 'POST') {
    await body(req).catch(() => ({}));
    if (!hit('forgot', 3, 3600e3)) return fail(res, 429, 'Trop de demandes. Réessayez dans une heure.');
    const pw = genPw(), salt = crypto.randomBytes(16).toString('hex');
    const text = 'Bonjour,\n\nUne réinitialisation du mot de passe administrateur de Karibu Kwenu a été demandée.\n\n' +
      'Nouveau mot de passe temporaire : ' + pw + '\n\n' +
      'Il est valable 1 heure. Connectez-vous avec, sur la page Connexion (profil « Administrateur »). ' +
      'Il remplace alors l’ancien mot de passe ; vous pouvez ensuite le changer dans Admin > Sécurité.\n' +
      'Si vous n’êtes pas à l’origine de cette demande, ignorez ce message : votre mot de passe actuel reste valide.\n\nKaribu Kwenu';
    let how;
    try { how = await sendMail(ADMIN_EMAIL, 'Karibu Kwenu – nouveau mot de passe administrateur', text); }
    catch (e) { log('Envoi du mail impossible :', e.message); return fail(res, 502, 'L’e-mail n’a pas pu être envoyé. Votre mot de passe actuel reste valide.'); }
    auth.roles.admin.pending = { salt, hash: hashPw(pw, salt), exp: Date.now() + 3600e3 }; saveAuth();
    if (how === 'nokey') {
      log('Mot de passe administrateur TEMPORAIRE (valable 1 h) : ' + pw);
      return j(res, 200, { message: 'L’envoi d’e-mail n’est pas configuré. Le mot de passe temporaire (valable 1 heure) a été écrit dans les Logs de Render.' });
    }
    return j(res, 200, { message: 'Un nouveau mot de passe temporaire a été envoyé à ' + maskMail(ADMIN_EMAIL) + ' (valable 1 heure).' });
  }

  if (p === '/api/password' && m === 'POST') {
    const u = userOf(req); if (!u) return fail(res, 401, 'Connexion requise.');
    if (u.role !== 'admin') return fail(res, 403, 'Réservé à l’administrateur.');
    const b = await body(req), target = str(b.target, 20) || 'admin', next = typeof b.next === 'string' ? b.next : '';
    if (!hit('pwchg:' + ip, 10, 15 * 60e3)) return fail(res, 429, 'Trop de tentatives. Réessayez plus tard.');
    if (!ROLES.includes(target)) return fail(res, 400, 'Profil inconnu.');
    if (!checkPw('admin', b.current)) return fail(res, 401, 'Mot de passe administrateur actuel incorrect.');
    if (next.length < 8 || next.length > 100) return fail(res, 400, 'Le nouveau mot de passe doit faire au moins 8 caractères.');
    setPw(target, next); saveAuth();
    return j(res, 200, target === 'admin' ? { ok: true, token: tokenFor('admin') } : { ok: true });
  }

  if (p === '/api/orders' && m === 'POST') {
    if (!hit('order:' + ip, 20, 3600e3)) return fail(res, 429, 'Trop de commandes en peu de temps. Réessayez plus tard.');
    const o = newOrder(await body(req), ip);
    state.orders.push(o); saveState(); return j(res, 201, publicOrder(o));
  }
  if (p === '/api/orders' && m === 'GET') {
    const u = userOf(req); if (!u) return fail(res, 401, 'Connexion requise.');
    let l = state.orders.slice().reverse();
    if (u.role !== 'admin') l = l.filter(o => o.paid && !['Annulée', 'Remboursée'].includes(o.st));
    return j(res, 200, l.map(o => staffOrder(o, u.role)));
  }
  let mm = /^\/api\/orders\/([A-Z0-9-]+)(\/pay)?$/.exec(p);
  if (mm) {
    const o = state.orders.find(x => x.id === mm[1]);
    if (!o) return fail(res, 404, 'Commande introuvable.');
    if (mm[2] && m === 'POST') return j(res, 200, publicOrder(payOrder(o, await body(req))));
    if (!mm[2] && m === 'GET') {
      if (url.searchParams.get('ref') !== o.ref) return fail(res, 403, 'Référence invalide.');
      return j(res, 200, publicOrder(o));
    }
    if (!mm[2] && m === 'PATCH') {
      const u = userOf(req); if (!u) return fail(res, 401, 'Connexion requise.');
      const r = actOrder(o, u.role, await body(req)); return j(res, 200, staffOrder(r, u.role));
    }
  }
  if (p === '/api/paylog' && m === 'GET') {
    const u = userOf(req); if (!u) return fail(res, 401, 'Connexion requise.');
    if (u.role !== 'admin') return fail(res, 403, 'Réservé à l’administrateur.');
    return j(res, 200, state.paylog.slice().reverse());
  }
  return fail(res, 404, 'Introuvable.');
}

/* ---------- Fichiers du site ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json' };
function serve(req, res, url) {
  let p; try { p = decodeURIComponent(url.pathname); } catch (e) { p = '/'; }
  if (p === '/' || p === '') p = '/index.html';
  const f = path.normalize(path.join(PUBLIC, p));
  const tryFile = (file, next) => fs.readFile(file, (err, data) => {
    if (err) return next();
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': (ext === '.html' || ext === '.webmanifest' || p === '/sw.js') ? 'no-cache' : 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
  const notFound = () => { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Page introuvable.'); };
  if (!f.startsWith(PUBLIC + path.sep)) return notFound();
  tryFile(f, () => p === '/index.html' ? tryFile(path.join(__dirname, 'index.html'), notFound) : notFound());
}

http.createServer(async (req, res) => {
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/healthz') { res.writeHead(200); return res.end('ok'); }
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    serve(req, res, url);
  } catch (e) {
    if (!e.status) log('Erreur :', e.stack || e);
    if (!res.headersSent) fail(res, e.status || 400, e.status === 500 ? 'Erreur du serveur.' : e.message || 'Erreur.');
  }
}).listen(PORT, () => log('Serveur prêt sur le port ' + PORT + ' · paiements ' + (DEMO ? 'simulés' : 'désactivés') + ' · données : ' + DATA_DIR));
