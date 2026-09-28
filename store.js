/* ==========================================================================
   WorkBuddy - browser data engine
   --------------------------------------------------------------------------
   The planner pages talk to a tiny JSON API. In this build the API lives in
   this file instead of a Node server, so the whole site is plain HTML, CSS
   and JavaScript that runs from any static host or straight off the disk.

   `api(method, path, body)` answers the same routes the old server answered:

     POST   /api/auth/register          POST   /api/auth/login
     POST   /api/auth/verify            POST   /api/auth/resend
     POST   /api/auth/logout            GET    /api/auth/me
      GET    /api/auth/sessions          DELETE /api/auth/sessions
      GET    /api/auth/events            POST   /api/auth/password
      GET    /api/sync                   POST   /api/sync
      GET    /api/admin/config           PUT    /api/admin/config
      GET    /api/weeks                  PUT    /api/weeks
DELETE /api/weeks                  POST   /api/weeks/copy
      GET    /api/marks
POST   /api/marks/bulk             DELETE /api/marks
PUT    /api/tests                  DELETE /api/tests
PUT    /api/subjects               PUT    /api/settings
POST   /api/subjects/site-defaults
GET    /api/account/export         POST   /api/account/erase

   Design notes
     - Passwords: PBKDF2-SHA256, 120k rounds, per-account random salt.
     - OTP codes: never written down in plain text, only a derived hash.
     - Sessions: a random token lives in localStorage, the account record only
       keeps its SHA-256 hash, so a copy of the database cannot be replayed.
     - Verification codes are delivered by a no-reply email sent straight from
       the browser through EmailJS (js/mail.js + the `email` block in
       js/sync-config.js), so a code is never shown on the page. Only when the
       owner has not connected an email service is the code handed back to the
       page and shown, because a code nobody could receive would lock a
       student out of the site.
   ========================================================================== */
(function (global) {
  'use strict';

  /* The site was first built for a commerce stream, so the subjects used to be
     written in here. That tied it to one stream, so the only thing left in the
     code is the most nearly universal subject there is, which is just enough
     for a brand new site to open on something other than an empty grid. The
     real list belongs to the owner, who sets it in the site editor, and grows
     on its own as students type in the subjects they actually take. */
  const BUILTIN_SUBJECTS = ['English'];

  /* The subjects a new account starts with, and the ones "back to the site's
     subjects" gives an account that has been changed by hand.

     This is the owner's published list joined with every name anybody has added
     to the shared list, so one student typing in "Physics" makes it available
     to the whole site rather than to themselves alone. A name is only kept
     once no matter how it was spelt or how many times it arrives. The built-in
     list is the fallback for a site with no cloud, and for the moment before
     the shared list has been read. */
  function siteSubjects() {
    const ac = global.AppConfig;
    const pool = Array.isArray(ac && ac.pool) ? ac.pool : [];
    const seen = new Set();
    const out = [];
    for (const name of [
      ...((ac && ac.data && ac.data.defaultSubjects) || []),
      ...pool,
      ...BUILTIN_SUBJECTS,
    ]) {
      const clean = str(name, 40).replace(/\s+/g, ' ').trim();
      if (!clean) continue;
      const key = clean.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(clean);
    }
    return out;
  }

  /* Generations of the subject setup. A bump means "every existing account
     should be brought in line once", which is how an account created under an
     earlier build is tidied up without the code guessing at its list. */
  const SUBJECTS_VERSION = 1;

  /* Once per account: rebuilds any per-subject tests that are missing and
     stamps the generation, so this only ever runs a single time. It never
     adds or removes a subject - the person's list is exactly what they typed,
     whatever the site happens to suggest. */
  function migrateSubjects(db, user) {
    const settings = user.settings || {};
    if (settings.subjectsVersion === SUBJECTS_VERSION) return;
    if (!user.tests) user.tests = {};
    for (const s of (user.subjects || [])) {
      if (!user.tests[s]) {
        user.tests[s] = DEFAULT_TESTS.map((t) => ({ id: t.id, name: t.name, kind: t.kind }));
      }
    }
    settings.subjectsVersion = SUBJECTS_VERSION;
    user.settings = settings;
    writeDb(db);
  }

  /* Puts a name into the shared list so it reaches other accounts too. Failing
     to share is not a reason to refuse the subject, so this is quiet on
     purpose: it only fails when the database rules have not been published. */
  async function shareSubject(name) {
    const s = sync();
    if (!s || typeof s.addSubjectToPool !== 'function') return;
    try {
      await s.addSubjectToPool(name);
    } catch { /* the subject is still the student's own */ }
  }

  const DEFAULT_TESTS = [
    { id: 't1', name: 'Term 1', kind: 'term' },
    { id: 't2', name: 'Term 2', kind: 'term' },
    { id: 't3', name: 'Term 3', kind: 'term' },
    { id: 't4', name: 'Final Exam', kind: 'exam' },
  ];
  const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

  const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14;  // 14 days
  const OTP_TTL_MS = 1000 * 60 * 10;                // 10 minutes
  const OTP_MAX_ATTEMPTS = 5;
  const MAX_FAILED_LOGINS = 8;
  const LOCKOUT_MS = 1000 * 60 * 15;                // 15 minute lockout
  const PBKDF2_ROUNDS = 120000;
  const NETWORK_DELAY = 130;                        // keeps spinners honest

  const DB_KEY = 'workbuddy.db.v1';
  const TOKEN_KEY = 'workbuddy.token.v1';
  const DEVICE_KEY = 'workbuddy.device.v1';
  const LABEL_KEY = 'workbuddy.label.v1';

  /* ------------------------------------------------------------- storage -- */

  let storageOK = true;
  const memory = new Map();

  function rawGet(key) {
    try { return global.localStorage.getItem(key); } catch { storageOK = false; return memory.has(key) ? memory.get(key) : null; }
  }
  function rawSet(key, value) {
    try { global.localStorage.setItem(key, value); return true; }
    catch { storageOK = false; memory.set(key, value); return false; }
  }
  function rawRemove(key) {
    try { global.localStorage.removeItem(key); } catch { /* ignore */ }
    memory.delete(key);
  }
  function getJSON(key, fallback) {
    const raw = rawGet(key);
    if (!raw) return fallback;
    try { return JSON.parse(raw); } catch { return fallback; }
  }
  function setJSON(key, value) { return rawSet(key, JSON.stringify(value)); }

  /* -------------------------------------------------------------- crypto -- */

  const subtle = (global.crypto && global.crypto.subtle) || null;
  const enc = new TextEncoder();

  const bytesToHex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
  const hexToBytes = (hex) => {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  };

  function randomHex(bytes) {
    const buf = new Uint8Array(bytes || 16);
    if (global.crypto && global.crypto.getRandomValues) global.crypto.getRandomValues(buf);
    else for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
    return bytesToHex(buf);
  }

  const randomToken = () => randomHex(32);
  const randomOtp = () => String(Math.floor(Math.random() * 1000000)).padStart(6, '0');

  /** Fallback for the rare browser without Web Crypto (keeps the site usable). */
  function weakHash(text) {
    let h1 = 0x811c9dc5, h2 = 0x1000193;
    for (let r = 0; r < 512; r++) {
      for (let i = 0; i < text.length; i++) {
        h1 = (h1 ^ text.charCodeAt(i)) >>> 0; h1 = (h1 * 16777619) >>> 0;
        h2 = (h2 + h1) >>> 0;
      }
    }
    return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
  }

  async function sha256Hex(text) {
    if (!subtle) return weakHash('sha:' + text);
    return bytesToHex(await subtle.digest('SHA-256', enc.encode(text)));
  }

  async function derivePassword(password, saltHex) {
    if (!subtle) return { algo: 'fallback', salt: saltHex, hash: weakHash(`${saltHex}:${password}`) };
    const base = await subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await subtle.deriveBits(
      { name: 'PBKDF2', salt: hexToBytes(saltHex), iterations: PBKDF2_ROUNDS, hash: 'SHA-256' },
      base, 256
    );
    return { algo: 'pbkdf2-sha256', rounds: PBKDF2_ROUNDS, salt: saltHex, hash: bytesToHex(bits) };
  }

  async function passwordMatches(password, stored) {
    if (!stored || !stored.hash) return false;
    const made = await derivePassword(String(password || ''), stored.salt);
    return made.hash.length === stored.hash.length
      && made.hash.split('').every((c, i) => c === stored.hash[i]);
  }

  /* --------------------------------------------------------------- error -- */

  class ApiError extends Error {
    constructor(status, body) {
      super((body && body.error) || `Request failed (${status})`);
      this.name = 'ApiError';
      this.status = status;
      this.body = body || {};
    }
    get errors() { return (this.body && this.body.errors) || {}; }
  }

  /* ----------------------------------------------------- device identity -- */

  function detectLabel() {
    const ua = navigator.userAgent || '';
    const platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
    const p = String(platform);
    const os = /Win/i.test(p) || /Windows/i.test(ua) ? 'Windows'
      : /Android/i.test(ua) ? 'Android'
      : /iPhone|iPad|iPod/i.test(ua) ? 'iPhone / iPad'
      : /Mac/i.test(p) || /Macintosh/i.test(ua) ? 'Mac'
      : /Linux/i.test(ua) ? 'Linux' : 'This device';
    const browser = /Edg\//i.test(ua) ? 'Edge'
      : /OPR\//i.test(ua) ? 'Opera'
      : /Brave\//i.test(ua) ? 'Brave'
      : /Chrome\//i.test(ua) ? 'Chrome'
      : /Firefox\//i.test(ua) ? 'Firefox'
      : /Safari\//i.test(ua) ? 'Safari' : 'Browser';
    return `${browser} on ${os}`.slice(0, 60);
  }

  const deviceId = (function () {
    let id = rawGet(DEVICE_KEY);
    if (!id || !/^[A-Za-z0-9_-]{16,64}$/.test(id)) {
      id = randomHex(20);
      rawSet(DEVICE_KEY, id);
    }
    return id;
  }());

  const deviceLabel = (function () {
    let label = rawGet(LABEL_KEY);
    if (!label) { label = detectLabel(); rawSet(LABEL_KEY, label); }
    return label;
  }());

  /* ---------------------------------------------------------- db records -- */

  const emptyDb = () => ({ v: 1, users: [] });

  function readDb() {
    const db = getJSON(DB_KEY, null);
    if (!db || !Array.isArray(db.users)) return emptyDb();
    return db;
  }

  /* Which account the page is working on, so a save knows who to copy. */
  let activeUser = null;

  /* The six synced groups as they looked when the current request started, so
     a change that only touches a session or the activity log is not mistaken
     for a change worth copying up. */
  let guard = null;

  const cloudViewKey = (user) => JSON.stringify(cloudView(user));

  function writeDb(db) {
    setJSON(DB_KEY, db);
    if (!activeUser) return;
    const after = cloudViewKey(activeUser);
    if (guard && after === guard) return;
    guard = after;
    queueCloudCopy(activeUser);
  }

  /* -------------------------------------------------------- cloud copies -- */

  const sync = () => (global.Sync && global.Sync.configured() ? global.Sync : null);
  const cloudGroups = ['profile', 'settings', 'subjects', 'tests', 'weeks', 'marks'];

  /* ------------------------------------------------------------ the owner -- */

  /* The account belongs to the owner when the cloud says so, which is checked
     against the id named in the `admin` block of js/sync-config.js rather than
     against anything the page or the person signed in typed. */
  function markOwner(user) {
    const s = sync();
    if (!s || !user) return user;
    const byUid = s.isAdminUid(user.cloudUid);
    const byEmail = !!user.email && s.adminEmail() === String(user.email).toLowerCase();
    user.isAdmin = byUid || byEmail;
    return user;
  }

  const isOwner = (user) => !!(user && user.isAdmin);

  /** the six groups of an account, in the shape the cloud stores them */
  function cloudView(user) {
    return {
      profile: { name: user.name, username: user.username, email: user.email, examYear: user.examYear },
      settings: user.settings || {},
      subjects: user.subjects || [],
      tests: user.tests || {},
      weeks: user.weeks || {},
      marks: user.marks || [],
    };
  }

  function cloudApply(user, remote) {
    if (!remote) return false;
    let touched = false;
    const put = (key, value) => {
      if (value === null || value === undefined) return;
      if (JSON.stringify(user[key]) !== JSON.stringify(value)) { user[key] = value; touched = true; }
    };
    if (remote.profile) {
      if (remote.profile.name) put('name', remote.profile.name);
      if (remote.profile.email) put('email', remote.profile.email);
      if (remote.profile.username) {
        put('username', remote.profile.username);
        user.usernameLc = remote.profile.username.toLowerCase();
      }
      if (remote.profile.examYear) put('examYear', remote.profile.examYear);
    }
    put('settings', remote.settings);
    put('subjects', remote.subjects);
    put('tests', remote.tests);
    put('weeks', remote.weeks);
    put('marks', remote.marks);
    user.cloudUid = user.cloudUid || remote.uid || null;
    return touched;
  }

  const cloudAccount = (user) => {
    const s = sync();
    if (!s || !user || !user.cloudUid) return null;
    const view = cloudView(user);
    view.uid = user.cloudUid;
    return view;
  };

  /** asked for by every save, but only does anything when a cloud is set up */
  function queueCloudCopy(user) {
    const s = sync();
    if (!s) return;
    const view = cloudAccount(user || activeUser);
    if (!view) return;
    try { s.schedulePush(view); } catch { /* sync must never break a save */ }
  }

  /* Push everything, used right after a sign in on a second device. */
  async function cloudPushAll(user) {
    const s = sync();
    const view = cloudAccount(user);
    if (!s || !view) return;
    try { await s.pushNow(view); } catch { /* kept locally, retried later */ }
  }

  const newAccount = (values) => ({
    id: randomHex(8),
    name: values.name,
    username: values.username,
    usernameLc: values.username.toLowerCase(),
    email: values.email,
    emailLc: values.email.toLowerCase(),
    examYear: values.examYear,
    password: null,
verified: false,
    verifiedAt: null,
    createdAt: new Date().toISOString(),
    failedCount: 0,
    lockedUntil: null,
    // An account starts with no subjects: the student adds exactly the ones
    // they take, and everything else is built around that list.
    subjects: [],
    tests: {},
    settings: { name: values.name, examDate: `${values.examYear}-08-01`, focusSubjects: [], subjectsVersion: SUBJECTS_VERSION },
    weeks: {},
    marks: [],
    sessions: [],
    events: [],
  });

  const findByUsername = (db, v) => db.users.find((u) => u.usernameLc === String(v || '').toLowerCase().trim()) || null;
  const findByEmail = (db, v) => db.users.find((u) => u.emailLc === String(v || '').toLowerCase().trim()) || null;
  const findById = (db, v) => db.users.find((u) => u.id === v) || null;

  const publicUser = (u) => ({
    id: u.id,
    name: u.name,
    username: u.username,
    email: u.email,
    examYear: u.examYear,
    verified: !!u.verified,
    createdAt: u.createdAt,
    isAdmin: !!u.isAdmin,
  });

  const blankWeek = () => {
    const w = {};
    for (const d of DAYS) w[d] = [];
    return w;
  };

  const countSessions = (wk) =>
    Object.keys(wk || {}).reduce((n, d) => n + (Array.isArray(wk[d]) ? wk[d].length : 0), 0);

  const weekHasContent = (wk) => countSessions(wk) > 0;

  /* ------------------------------------------------------------ sessions -- */

  const readToken = () => getJSON(TOKEN_KEY, null);

  function sessionFromToken(db) {
    const held = readToken();
    if (!held || !held.token) return null;
    return sha256Hex(held.token).then((hash) => {
      for (const u of db.users) {
        for (const s of u.sessions || []) {
          if (s.tokenHash !== hash) continue;
          if (new Date(s.expiresAt).getTime() < Date.now()) return { user: u, session: null, stale: true };
          return { user: u, session: s, stale: false };
        }
      }
      return null;
    });
  }

  async function createSession(db, user) {
    const token = randomToken();
    const now = new Date();
    const row = {
      tokenHash: await sha256Hex(token),
      deviceId,
      deviceLabel,
      createdAt: now.toISOString(),
      lastSeen: now.toISOString(),
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
    };
    // one live session per device keeps the device list honest
    user.sessions = (user.sessions || []).filter((s) => s.deviceId !== deviceId);
    user.sessions.push(row);
    writeDb(db);
    setJSON(TOKEN_KEY, { token, userId: user.id, username: user.username });
    return token;
  }

  function clearToken() { rawRemove(TOKEN_KEY); }

  function listSessions(user, currentHash) {
    return (user.sessions || [])
      .filter((s) => new Date(s.expiresAt).getTime() > Date.now())
      .sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)))
      .map((s) => ({
        id: s.tokenHash.slice(0, 12),
        device: s.deviceLabel || 'Unknown device',
        signedInAt: s.createdAt,
        lastSeenAt: s.lastSeen,
        current: s.tokenHash === currentHash,
      }));
  }

  /* -------------------------------------------------------------- events -- */

  function logEvent(user, event, outcome) {
    user.events = user.events || [];
    user.events.unshift({
      event,
      outcome: outcome || 'ok',
      device_label: deviceLabel,
      created_at: new Date().toISOString(),
    });
    user.events = user.events.slice(0, 20);
  }

  /* --------------------------------------------------------- rate limits -- */

  const buckets = new Map();

  function rateLimit(key, max, windowMs) {
    const now = Date.now();
    const b = buckets.get(key);
    if (!b || now > b.reset) {
      buckets.set(key, { n: 1, reset: now + windowMs });
      return { ok: true, remaining: max - 1, retryAfter: 0 };
    }
    b.n += 1;
    if (b.n > max) return { ok: false, remaining: 0, retryAfter: Math.ceil((b.reset - now) / 1000) };
    return { ok: true, remaining: max - b.n, retryAfter: 0 };
  }
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of buckets) if (now > v.reset) buckets.delete(k);
  }, 60000);

  /* --------------------------------------------------------- validation -- */

  const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(String(v || '').trim());
  const isUsername = (v) => /^[A-Za-z0-9._-]{3,20}$/.test(String(v || '').trim());
  const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
  const str = (v, max = 2000) => String(v == null ? '' : v).slice(0, max);

  function passwordProblem(pw) {
    const s = String(pw || '');
    if (s.length < 8) return 'Password must be at least 8 characters long.';
    if (s.length > 128) return 'Password must be 128 characters or fewer.';
    if (!/[A-Za-z]/.test(s)) return 'Password must contain at least one letter.';
    if (!/[0-9]/.test(s)) return 'Password must contain at least one number.';
    return null;
  }

  function validateRegistration(b) {
    const errors = {};
    const name = String(b.name || '').trim().replace(/\s+/g, ' ');
    const username = String(b.username || '').trim();
    const email = String(b.email || '').trim();
    const password = String(b.password || '');
    const confirmPassword = String(b.confirmPassword == null ? '' : b.confirmPassword);
    const examYear = Number(b.examYear);

    if (name.length < 2) errors.name = 'Please enter your full name.';
    else if (name.length > 60) errors.name = 'Name must be 60 characters or fewer.';

    if (!username) errors.username = 'Please choose a username.';
    else if (!isUsername(username)) errors.username = 'Username must be 3-20 characters using letters, numbers, dot, dash or underscore.';

    const year = Number.isInteger(examYear) ? examYear : NaN;
    if (!Number.isInteger(year)) errors.examYear = 'Please enter your exam year.';
    else if (year < 2024 || year > 2045) errors.examYear = 'Exam year must be between 2024 and 2045.';

    if (!email) errors.email = 'Please enter your email address.';
    else if (!isEmail(email)) errors.email = 'That email address does not look valid.';

    const pwProblem = passwordProblem(password);
    if (pwProblem) errors.password = pwProblem;

    if (!confirmPassword) errors.confirmPassword = 'Please re-type your password.';
    else if (password !== confirmPassword) errors.confirmPassword = 'Passwords do not match.';

    if (Object.keys(errors).length) return { ok: false, errors };
    return { ok: true, values: { name, username, email, password, examYear: year } };
  }

  /* ------------------------------------------------------------ sanitise -- */

  function cleanTasks(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return blankWeek();
    const out = {};
    for (const day of DAYS) {
      const list = raw[day];
      if (!Array.isArray(list)) { out[day] = []; continue; }
      out[day] = list.slice(0, 40).map((t) => ({
        id: str(t && t.id, 40) || Math.random().toString(36).slice(2, 11),
        subject: str(t && t.subject, 60) || 'Study',
        task: str(t && t.task, 500),
        start: str(t && t.start, 12),
        end: str(t && t.end, 12),
        type: ['study', 'class', 'other'].includes(t && t.type) ? t.type : 'study',
        done: !!(t && t.done),
      }));
    }
    return out;
  }

  function cleanMarks(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.slice(0, 600).map((m) => {
      const num = (v) => {
        if (v === '' || v == null) return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      };
      return {
        subject: str(m && m.subject, 60) || 'Subject',
        testId: str(m && m.testId, 40) || 't1',
        testName: str(m && m.testName, 40) || 'Term 1',
        kind: m && m.kind === 'exam' ? 'exam' : 'term',
        paper: str(m && m.paper, 12) || 'I',
        mark: num(m && m.mark),
        max_mark: num(m && m.max_mark) || 100,
        target: num(m && m.target),
      };
    });
  }

  /* ----------------------------------------------------------- tests --- */
  const testKind = (name) => (/exam|mock|final|prelim|quiz|test\s*\d*\s*paper/i.test(name) ? 'exam' : 'term');

  /* every subject always has at least one test, even for old accounts */
  function testsFor(user, subject) {
    if (!user.tests || typeof user.tests !== 'object') user.tests = {};
    if (!Array.isArray(user.tests[subject]) || !user.tests[subject].length) {
      user.tests[subject] = DEFAULT_TESTS.map((t) => ({ id: t.id, name: t.name, kind: t.kind }));
    }
    return user.tests[subject];
  }

  function testsPayload(user) {
    const out = {};
    for (const s of (user.subjects || [])) {
      out[s] = testsFor(user, s);
    }
    return out;
  }

  /* ------------------------------------------------------------- routing -- */

  const ok = (body) => ({ status: 200, body: body || { ok: true } });
  const fail = (status, body) => ({ status, body });

  async function makeOtp(db, user) {
    const code = randomOtp();
    const salt = randomHex(16);
    user.otp = {
      salt,
      hash: (await derivePassword(code, salt)).hash,
      purpose: 'signup',
      createdAt: Date.now(),
      expiresAt: Date.now() + OTP_TTL_MS,
      attempts: 0,
      used: false,
    };
    logEvent(user, 'otp_sent', 'local');
    writeDb(db);
    return code;
  }

  async function consumeOtp(db, user, code, purpose) {
    const otp = user.otp;
    if (!otp || otp.used || otp.purpose !== purpose) return { ok: false, reason: 'No active code. Please request a new one.' };
    if (Date.now() > otp.expiresAt) { otp.used = true; writeDb(db); return { ok: false, reason: 'That code has expired. Please request a new one.' }; }
    if (otp.attempts >= OTP_MAX_ATTEMPTS) { otp.used = true; writeDb(db); return { ok: false, reason: 'Too many wrong attempts. Please request a new code.' }; }

    const made = await derivePassword(String(code || '').trim(), otp.salt);
    if (made.hash !== otp.hash) {
      otp.attempts += 1;
      const left = OTP_MAX_ATTEMPTS - otp.attempts;
      writeDb(db);
      return { ok: false, reason: `Incorrect code. ${left} attempt${left === 1 ? '' : 's'} left.` };
    }
    otp.used = true;
    writeDb(db);
    return { ok: true };
  }

  function lockoutRemaining(user) {
    if (!user.lockedUntil) return 0;
    const ms = new Date(user.lockedUntil).getTime() - Date.now();
    return ms > 0 ? ms : 0;
  }

  /* Public routes are reachable without a session. */
  const PUBLIC = new Set([
    'POST /api/auth/register', 'POST /api/auth/verify',
    'POST /api/auth/resend', 'POST /api/auth/login',
  ]);

  const handlers = {
    /* ------------------------------------------------------- register --- */
    'POST /api/auth/register': async ({ body }) => {
      const v = validateRegistration(body || {});
      if (!v.ok) return fail(422, { error: 'Please fix the highlighted fields.', errors: v.errors });

      /* The owner signs in with a username, so nobody else may take it. */
      const s0 = sync();
      if (s0 && (s0.isAdminIdentifier(v.values.username) || s0.isAdminIdentifier(v.values.email))) {
        return fail(409, { error: 'That name is reserved for the owner of this site.' });
      }

      const db = readDb();

      /* A registration that was started but never verified ends up sitting in
         this browser with a "you are all done" face on the cloud but no way
         past the verify screen. Both a repeated email and the same username
         find that abandoned record, and instead of a dead-end "already
         registered" message the person is handed a fresh code to finish. */
      const staleByEmail = findByEmail(db, v.values.email);
      const staleByName = findByUsername(db, v.values.username);
      const resume = (staleByEmail && staleByEmail.verified === false) ? staleByEmail
        : (!staleByEmail && staleByName && staleByName.verified === false) ? staleByName
        : null;

      if (resume) {
        const code = await makeOtp(db, resume);
        logEvent(resume, 'register', 'resumed_pending_verification');
        writeDb(db);
        if (resume.cloudUid) {
          activeUser = resume;
          try { await cloudPushAll(resume); } catch { /* the local copy is safe */ }
        }
        return fail(201, {
          ok: true,
          message: 'That email already has an unfinished account here. Enter the new code to finish opening it.',
          username: resume.username,
          email: resume.email,
          delivery: 'local',
          devCode: code,
        });
      }

      if (staleByEmail && staleByEmail.verified) {
        return fail(409, { error: 'That email is already registered. Sign in with it instead.', errors: { email: 'That email is already registered. Sign in with it.' } });
      }
      if (staleByName && staleByName.verified) {
        return fail(409, { error: 'That username is taken.', errors: { username: 'That username is taken.' } });
      }

      const user = newAccount(v.values);
      user.password = await derivePassword(v.values.password, randomHex(16));

      /* With a cloud set up, Firebase owns the password from here on and
         remembers this person, so the same details open the same account on
         any other device. */
      if (s0) {
        let made;
        try {
          made = await s0.signUp(v.values.email, v.values.password);
        } catch (err) {
          const code = (err && err.code) || '';
          if (/email-already-in-use/.test(code)) {
            return fail(409, {
              error: 'That email already has an account. Sign in with it instead of registering again.',
              errors: { email: 'This email is already registered. Sign in with it.' },
            });
          }
          if (/weak-password/.test(code)) {
            return fail(422, {
              error: 'That password is not strong enough for the cloud.',
              errors: { password: 'Use at least 8 characters with a number.' },
            });
          }
          return fail(503, { error: 'The cloud could not be reached, so nothing was saved. Check your connection and try again.' });
        }
        user.cloudUid = made.uid;
      }

      db.users.push(user);
      writeDb(db);

      const code = await makeOtp(db, user);
      logEvent(user, 'register', 'pending_verification');
      writeDb(db);

      /* The name and email are copied to the shared directory so the owner can
         list who registered and usernames can be signed in with. Nothing here
         is required for the planner itself, so a refused write is ignored. */
      if (s0 && user.cloudUid) {
        s0.writeUsernameDirectory(user.username, user.email);
        s0.writeUserDirectory(user.cloudUid, {
          name: user.name, username: user.username, email: user.email,
          examYear: user.examYear, verified: false, createdAt: user.createdAt,
        });
      }

      activeUser = user;
      /* done before replying so the copy is on the cloud even if the tab
         closes on the verify screen */
      try { await cloudPushAll(user); } catch { /* kept locally, retried later */ }

      return fail(201, {
        ok: true,
        message: 'Account created. Enter the verification code we sent to your email.',
        username: user.username,
        email: user.email,
        delivery: 'local',
        devCode: code,
      });
    },

    /* --------------------------------------------------------- verify --- */
    'POST /api/auth/verify': async ({ body }) => {
      const db = readDb();
      const user = findByUsername(db, body && body.username);
      if (!user) return fail(404, { error: 'Account not found.' });
      if (user.verified) return fail(409, { error: 'This account is already verified. Please sign in.' });

      const r = await consumeOtp(db, user, body && body.code, 'signup');
      if (!r.ok) {
        logEvent(user, 'verify_failed', 'bad_code');
        writeDb(db);
        return fail(400, { error: r.reason });
      }

      user.verified = true;
      user.verifiedAt = new Date().toISOString();
      user.failedCount = 0;
      user.lockedUntil = null;
      logEvent(user, 'verified', 'ok');
      await createSession(db, user);
      const s1 = sync();
      if (s1 && user.cloudUid) {
        s1.patchUserDirectory(user.cloudUid, { verified: true });
        try { await cloudPushAll(user); } catch { /* kept locally, retried later */ }
      }

      return ok({ ok: true, user: publicUser(user) });
    },

    /* --------------------------------------------------------- resend --- */
    'POST /api/auth/resend': async ({ body }) => {
      const rl = rateLimit('resend', 6, 10 * 60 * 1000);
      if (!rl.ok) return fail(429, { error: `Too many requests. Try again in ${rl.retryAfter}s.` });

      const db = readDb();
      const user = findByUsername(db, body && body.username);
      if (!user) return fail(404, { error: 'Account not found.' });
      if (user.verified) return fail(409, { error: 'This account is already verified. Please sign in.' });

      const code = await makeOtp(db, user);
      return ok({ ok: true, message: 'A new code is ready.', delivery: 'local', email: user.email, devCode: code });
    },

    /* ---------------------------------------------------------- login --- */
    'POST /api/auth/login': async ({ body }) => {
      const rl = rateLimit('login', 30, 10 * 60 * 1000);
      if (!rl.ok) return fail(429, { error: `Too many sign-in attempts. Try again in ${rl.retryAfter}s.` });

      const db = readDb();
      const username = String((body && body.username) || '').trim();
      const password = String((body && body.password) || '');
      const s = sync();

      /* ---------------------------------------------------------------
         Cloud mode. The password is checked by the cloud, then the copy of
         the account kept there is merged in, which is how a second device
         ends up showing the weeks and marks typed on the first one.
         --------------------------------------------------------------- */
      if (s) {
        /* The owner types a plain username, so it is handed over to the cloud
           as the owner's email address, which is the pair Firebase checks. */
        const cloud = await s.signIn(s.adminIdentifier(username), password);
        if (!cloud.ok) {
          const looksEmail = s.looksLikeEmail(username);
          const unknownUsername = !s.isAdminIdentifier(username)
            && !looksEmail && /does not match a cloud account/.test(cloud.error);
          const local = findByUsername(db, username);
          if (!local) {
            const msg = looksEmail
              ? 'No account is registered with that email yet. Register first, then sign in.'
              : unknownUsername
                ? 'That username is not registered yet. Check the spelling, or create an account first.'
                : cloud.error;
            return fail(looksEmail ? 401 : 422, {
              error: msg,
              errors: unknownUsername ? { username: msg } : undefined,
            });
          }
          return fail(401, { error: cloud.error });
        }

        /* Best copy wins: the merged view of the account kept on the cloud.
           When the copy is missing the cloud still owns the password (it just
           accepted it), so the account is rebuilt from what this device
           already knows rather than sending the person away to register. */
        const remote = await s.download(cloud.uid);

        let user = findByEmail(db, cloud.email)
          || (remote && remote.profile && remote.profile.email && findByEmail(db, remote.profile.email))
          || findByUsername(db, username);
        if (!user) {
          /* first time this device has seen this person, or their copy never
             landed on the cloud (an abandoned registration, or an account
             opened straight in the Firebase console) */
          const label = String(cloud.email).split('@')[0];
          user = newAccount({
            name: (remote && remote.profile && remote.profile.name) || label,
            username: (remote && remote.profile && remote.profile.username) || label,
            email: cloud.email,
            examYear: (remote && remote.profile && Number(remote.profile.examYear)) || (new Date().getFullYear() + 1),
          });
          user.password = await derivePassword(password, randomHex(16));
          user.verified = true;
          user.verifiedAt = new Date().toISOString();
          db.users.push(user);
        }

        /* an abandoned local registration the email just opened counts as
           verified now - the right password is all the proof needed */
        if (!user.verified) {
          user.verified = true;
          user.verifiedAt = user.verifiedAt || new Date().toISOString();
        }

        user.cloudUid = cloud.uid;
        markOwner(user);
        user.failedCount = 0;
        user.lockedUntil = null;
        const pulled = remote ? cloudApply(user, remote) : false;
        logEvent(user, 'login', pulled ? 'login_cloud_pull' : remote ? 'login_cloud' : 'login_cloud_recovered');
        activeUser = user;
        writeDb(db);
        await createSession(db, user);
        /* keep the server copy identical to what is now on screen */
        await cloudPushAll(user);
        return ok({
          ok: true,
          user: publicUser(user),
          fromCloud: true,
          pulled: remote ? cloudGroups.filter((g) => (remote[g] !== null && remote[g] !== undefined)) : [],
        });
      }

      /* ------------------------------------------------------- local mode --- */
      const user = findByUsername(db, username);
      if (!user) {
        /* A username nobody has registered is a typing mistake, not a secret
           worth hiding, so it is called out under the box. */
        const msg = 'That username is not registered yet. Check the spelling, or create an account first.';
        return fail(422, { error: msg, errors: { username: msg } });
      }

      const waitMs = lockoutRemaining(user);
      if (waitMs > 0) return fail(429, { error: `Too many failed attempts. Try again in ${Math.ceil(waitMs / 60000)} minute(s).` });

      if (!(await passwordMatches(password, user.password))) {
        user.failedCount = (user.failedCount || 0) + 1;
        const remaining = Math.max(0, MAX_FAILED_LOGINS - user.failedCount);
        if (user.failedCount >= MAX_FAILED_LOGINS) user.lockedUntil = new Date(Date.now() + LOCKOUT_MS).toISOString();
        logEvent(user, 'login', 'bad_password');
        writeDb(db);
        return fail(401, { error: 'Incorrect username or password.', attemptsLeft: remaining });
      }

      if (!user.verified) {
        return fail(403, { error: 'unverified', message: 'Please verify your email address first.', username: user.username });
      }

      user.failedCount = 0;
      user.lockedUntil = null;
      logEvent(user, 'login', 'ok');
      writeDb(db);
      activeUser = user;
      await createSession(db, user);
      return ok({ ok: true, user: publicUser(user) });
    },

    /* ------------------------------------------------------------- me --- */
    'GET /api/auth/me': async ({ db, user, session }) => {
      markOwner(user);
      /* an account created under an earlier build catches up with the current
         subject list here, once, so the shared subjects reach every account */
      if (!user.settings || user.settings.subjectsVersion !== SUBJECTS_VERSION) {
        migrateSubjects(db, user);
      }
      if (session) { session.lastSeen = new Date().toISOString(); writeDb(db); }
      return ok({
        user: publicUser(user),
        settings: Object.assign(
          { name: user.name, examDate: `${user.examYear}-08-01`, focusSubjects: [] },
          user.settings || {},
        ),
        subjects: user.subjects || [],
        /* The list the owner has set for the site, so the Settings page can
           offer "back to the site's subjects" and say whether this account has
           already been changed away from it. */
        siteSubjects: siteSubjects(),
        storage: 'browser',
      });
    },

    /* --------------------------------------------------------- logout --- */
    'POST /api/auth/logout': async ({ db, user, session }) => {
      if (session && user) user.sessions = (user.sessions || []).filter((s) => s.tokenHash !== session.tokenHash);
      writeDb(db);
      clearToken();
      activeUser = null;
      const s = sync();
      if (s) { try { await s.signOut(); } catch { /* the local session is gone either way */ } }
      return { status: 200, body: { ok: true }, clearSession: true };
    },

    /* --------------------------------------------------------- the cloud -- */

    'GET /api/sync': async ({ user }) => {
      const s = sync();
      if (!s) {
        return ok({
          mode: 'local',
          state: 'local',
          detail: 'This account lives in this browser only. Add a Firebase project in js/sync-config.js to carry it to another device.',
          lastSync: null,
        });
      }
      const st = s.status();
      return ok({
        mode: st.mode,
        state: st.state,
        detail: st.detail,
        lastSync: st.lastSync,
        pending: st.pending,
        linked: !!user.cloudUid,
      });
    },

    'POST /api/sync': async ({ user }) => {
      const s = sync();
      if (!s) return ok({ ok: true, mode: 'local' });
      if (!user.cloudUid) {
        return fail(409, { error: 'This account is not linked to a cloud copy yet.' });
      }
      const view = cloudAccount(user);
      s.remember(view);
      const r = await s.pushNow(view);
      if (!r.ok) return fail(503, { error: r.error || 'The cloud could not be reached.' });
      const st = s.status();
      return ok({ ok: true, mode: 'cloud', state: st.state, lastSync: st.lastSync });
    },

    /* ----------------------------------------------------- app settings --- */

    /* One record that every account reads the same copy of, so a change made
       here reaches everybody. Writing is closed to everyone but the owner. It
       also reads the record the same way on a timer-free live subscription, so
       the settings on screen are the settings on the server. */
    'GET /api/admin/config': async ({ user }) => {
      const s = sync();
      if (!s) return ok({ ok: true, config: null, source: 'local', canWrite: false });
      const config = await s.readAppConfig();
      return ok({ ok: true, config, source: config ? 'cloud' : 'defaults', canWrite: isOwner(user) });
    },

    'PUT /api/admin/config': async ({ db, body, user }) => {
      if (!isOwner(user)) return fail(403, { error: 'Only the owner of this site may change these settings.' });
      const s = sync();
      if (!s) return fail(503, { error: 'No cloud project is set up, so there is nowhere to save these settings.' });

      const incoming = (body && body.config) || {};
      const text = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
      const para = (v, max) => String(v == null ? '' : v).replace(/\r/g, '').trim().slice(0, max);
      const year = Number(incoming.defaultExamYear);
      const features = incoming.features || {};
      const banner = incoming.banner || {};
      const maint = incoming.maintenance || {};

      /* Maintenance mode is only allowed to be turned on with something to
         read, so a visitor is never met by a blank page. */
      const mTitle = text(maint.title, 80);
      const mMessage = para(maint.message, 400);
      const mOn = !!maint.on && !!(mTitle || mMessage);

      /* The subject list every new account starts with. Duplicates and blank
         lines are dropped here as well as on the page, because this is the copy
         that is actually written. */
      const subjects = [];
      const seenSubject = new Set();
      for (const raw of (Array.isArray(incoming.defaultSubjects) ? incoming.defaultSubjects : [])) {
        const name = text(raw, 40);
        if (!name) continue;
        const key = name.toLowerCase();
        if (seenSubject.has(key)) continue;
        seenSubject.add(key);
        subjects.push(name);
        if (subjects.length >= 30) break;
      }

      const config = {
        siteName: text(incoming.siteName, 40) || 'WorkBuddy',
        tagline: text(incoming.tagline, 40) || 'Study Planner',
        description: text(incoming.description, 300),
        defaultExamYear: Number.isInteger(year) && year >= 2024 && year <= 2045
          ? year
          : new Date().getFullYear() + 1,
        defaultSubjects: subjects.length ? subjects : siteSubjects(),
        banner: { on: !!banner.on, text: text(banner.text, 200) },
        maintenance: {
          on: mOn,
          title: mTitle,
          message: mMessage,
          until: text(maint.until, 60),
        },
        features: {
          timetable: features.timetable !== false,
          marks: features.marks !== false,
          copyWeek: features.copyWeek !== false,
          registration: features.registration !== false,
        },
        updatedBy: user.username,
      };

      const r = await s.writeAppConfig(config);
      if (!r.ok) return fail(503, { error: r.error });
      logEvent(user, 'app_settings', 'ok');
      writeDb(db);
      return ok({ ok: true, config, savedAt: new Date().toISOString() });
    },

    /* ---------------------------------------------------- registered users --- */

    /* The list of who registered. Only the owner may read it, and the entries
       are the small public records written at registration (name, username,
       email, exam year, when they joined) - never any weeks, marks or
       passwords. */
    'GET /api/admin/users': async ({ db, user }) => {
      if (!isOwner(user)) return fail(403, { error: 'Only the owner of this site may see who registered.' });
      const s = sync();
      if (!s) {
        return ok({
          ok: true,
          users: db.users.map(publicUser),
          source: 'local',
          note: 'No cloud project is set up, so this is only the accounts seen on this browser.',
        });
      }
      const r = await s.listUsers();
      const denied = !!(r && r.denied);
      return ok({
        ok: true,
        users: (r && r.list) || [],
        localCount: db.users.length,
        source: denied ? 'denied' : (r && r.list && r.list.length ? 'cloud' : 'none'),
        note: denied
          ? 'The database rules do not let the owner read the user list yet. Publish the rules shown in the setup box below with your owner id filled in, and the full list appears here.'
          : 'The accounts that registered on the site, newest first. This is the shared list, so it includes accounts created on other devices.',
      });
    },

    /* -------------------------------------------------------- sessions --- */
    'GET /api/auth/sessions': async ({ user, session }) =>
      ok({ sessions: listSessions(user, session ? session.tokenHash : '') }),

    'DELETE /api/auth/sessions': async ({ db, body, user, session }) => {
      const id = str(body && body.id, 40);
      if (!/^[0-9a-f]{6,12}$/.test(id)) return fail(400, { error: 'Unknown session.' });
      if (session && id === session.tokenHash.slice(0, 12)) {
        return fail(400, { error: 'Use sign out to end the session you are in.' });
      }
      const before = (user.sessions || []).length;
      user.sessions = (user.sessions || []).filter((s) => !s.tokenHash.startsWith(id));
      writeDb(db);
      return ok({ ok: true, revoked: before - user.sessions.length });
    },

    /* ---------------------------------------------------------- events --- */
    'GET /api/auth/events': async ({ user }) => ok({ events: (user.events || []).slice(0, 15) }),

    /* -------------------------------------------------------- password --- */
    'POST /api/auth/password': async ({ db, body, user }) => {
      if (!(await passwordMatches(String((body && body.currentPassword) || ''), user.password))) {
        return fail(401, { error: 'Your current password is not correct.' });
      }
      const v = validateRegistration({
        name: user.name, username: user.username, email: user.email, examYear: user.examYear,
        password: (body && body.newPassword) || '',
        confirmPassword: (body && body.confirmPassword) || '',
      });
      if (!v.ok) return fail(422, { error: 'Please fix the highlighted fields.', errors: v.errors });

      /* With a cloud set up Firebase holds the real password, so it is changed
         there first. If that cannot be done the local copy is left alone
         rather than letting the two drift apart. */
      const s = sync();
      if (s) {
        try {
          await s.updatePassword(v.values.password);
        } catch (err) {
          const code = (err && err.code) || '';
          if (/requires-recent-login/.test(code)) {
            return fail(401, { error: 'Sign in to the cloud again on this device, then change the password.' });
          }
          if (/weak-password/.test(code)) {
            return fail(422, { error: 'That password is not strong enough for the cloud.', errors: { password: 'Use at least 8 characters with a number.' } });
          }
          return fail(503, { error: 'The cloud could not be reached, so the password was left as it was. Try again in a moment.' });
        }
      }

      user.password = await derivePassword(v.values.password, randomHex(16));
      user.sessions = [];
      logEvent(user, 'password_changed', 'ok');
      writeDb(db);
      await createSession(db, user);
      return ok({
        ok: true,
        message: s
          ? 'Password updated here and in the cloud. Other devices sign in again with the new one.'
          : 'Password updated. Your other devices were signed out.',
      });
    },

    /* ----------------------------------------------------------- weeks --- */
    'GET /api/weeks': async ({ user }) => ok({ weeks: user.weeks || {} }),

    'PUT /api/weeks': async ({ db, body, user }) => {
      const id = str(body && body.weekId, 20);
      if (!isDate(id)) return fail(400, { error: 'Invalid week.' });
      const data = cleanTasks(body && body.data);
      user.weeks = user.weeks || {};
      user.weeks[id] = data;
      writeDb(db);
      return ok({ ok: true, weekId: id, sessions: countSessions(data) });
    },

    'DELETE /api/weeks': async ({ db, body, user }) => {
      const id = str(body && body.weekId, 20);
      if (!isDate(id)) return fail(400, { error: 'Invalid week.' });
      user.weeks = user.weeks || {};
      const removed = countSessions(user.weeks[id]);
      delete user.weeks[id];
      writeDb(db);
      return ok({ ok: true, weekId: id, removed });
    },

    'POST /api/weeks/copy': async ({ db, body, user }) => {
      const from = str(body && body.from, 20);
      const to = str(body && body.to, 20);
      if (!isDate(from) || !isDate(to)) return fail(400, { error: 'Invalid week.' });
      if (from === to) return fail(400, { error: 'Pick two different weeks.' });

      user.weeks = user.weeks || {};
      const source = user.weeks[from];
      if (!weekHasContent(source)) return fail(404, { error: 'That week has no sessions to copy.' });

      const target = user.weeks[to];
      if (weekHasContent(target) && !(body && body.overwrite)) {
        return fail(409, { error: 'conflict', message: `${to} already has a plan.`, existingSessions: countSessions(target) });
      }
      if (body && body.mode === 'move') delete user.weeks[from];
      /* only the plan is carried across - a session done in the source week is
         still a fresh session waiting to be done in the destination */
      const copied = cleanTasks(source);
      for (const day of Object.keys(copied)) {
        copied[day] = copied[day].map((t) => ({ ...t, done: false }));
      }
      user.weeks[to] = copied;
      writeDb(db);
      return ok({ ok: true, from, to, mode: (body && body.mode) === 'move' ? 'move' : 'copy', sessions: countSessions(source) });
    },

    /* ----------------------------------------------------------- marks --- */
    'GET /api/marks': async ({ user }) =>
      ok({
        marks: user.marks || [],
        subjects: user.subjects || [],
        tests: testsPayload(user),
      }),

    'POST /api/marks/bulk': async ({ db, body, user }) => {
      const subject = str(body && body.subject, 60);
      const list = testsFor(user, subject);
      const wanted = str(body && body.testId, 40);
      const entry = (wanted && list.find((t) => t.id === wanted)) || list[0];
      const testId = entry.id;
      const testName = str(body && body.testName, 40) || entry.name;
      const kind = (body && body.kind) === 'exam' ? 'exam' : entry.kind;
      const vals = Array.isArray(body && body.values) ? body.values : [];

      user.marks = user.marks || [];
      for (const v of vals) {
        const paper = str(v && v.paper, 12) || 'I';
        const n = (v && (v.mark === '' || v.mark == null)) ? null : Number(v && v.mark);
        if (n != null && (!Number.isFinite(n) || n < 0)) return fail(422, { error: 'Marks must be a positive number.' });
        const maxMark = Number(v && v.max_mark) > 0 ? Number(v.max_mark) : 100;
        if (n != null && n > maxMark) return fail(422, { error: `Mark for paper ${paper} cannot be above ${maxMark}.` });

        const hit = user.marks.find((m) => m.subject === subject && m.testId === testId && m.paper === paper);
        if (hit) { hit.mark = n; hit.max_mark = maxMark; hit.testName = testName; hit.kind = kind; hit.target = null; }
        else user.marks.push({ subject, testId, testName, kind, paper, mark: n, max_mark: maxMark, target: null });
      }
      writeDb(db);
      return ok({ ok: true, subject, saved: vals.length });
    },

    'DELETE /api/marks': async ({ db, body, user }) => {
      const marks = user.marks || [];
      if (body && body.subject) {
        const subject = str(body.subject, 60);
        const testId = str(body.testId, 40);
        user.marks = testId
          ? marks.filter((m) => !(m.subject === subject && m.testId === testId))
          : marks.filter((m) => m.subject !== subject);
      } else {
        user.marks = [];
      }
      writeDb(db);
      return ok({ ok: true });
    },

    'PUT /api/tests': async ({ db, body, user }) => {
      const subject = str(body && body.subject, 60);
      if (!subject) return fail(422, { error: 'Pick a subject first.' });
      const list = testsFor(user, subject);
      const id = str(body && body.id, 40);
      const name = str(body && body.name, 40).trim();
      if (!name) return fail(422, { error: 'Give the test a name.' });
      if (list.some((t) => t.id !== id && t.name.toLowerCase() === name.toLowerCase())) {
        return fail(409, { error: `"${name}" is already in this subject.` });
      }
      if (!id && list.length >= 40) return fail(422, { error: 'That subject already has enough tests.' });

      if (id) {
        const t = list.find((x) => x.id === id);
        if (!t) return fail(404, { error: 'That test no longer exists.' });
        t.name = name;
        t.kind = (body && body.kind) === 'exam' ? 'exam' : testKind(name);
        user.marks = (user.marks || []).map((m) => (
          m.subject === subject && m.testId === id ? { ...m, testName: name, kind: t.kind } : m));
        writeDb(db);
        return ok({ ok: true, subject, tests: list, testId: id });
      }
      const fresh = `t${Date.now().toString(36)}${Math.floor(Math.random() * 900 + 100)}`;
      list.push({ id: fresh, name, kind: (body && body.kind) === 'exam' ? 'exam' : testKind(name) });
      writeDb(db);
      return ok({ ok: true, subject, tests: list, testId: fresh });
    },

    'DELETE /api/tests': async ({ db, body, user }) => {
      const subject = str(body && body.subject, 60);
      const id = str(body && body.id, 40);
      const list = testsFor(user, subject);
      if (!id || !list.some((t) => t.id === id)) return fail(404, { error: 'That test no longer exists.' });
      if (list.length <= 1) return fail(422, { error: 'A subject needs at least one test.' });
      user.tests[subject] = list.filter((t) => t.id !== id);
      user.marks = (user.marks || []).filter((m) => !(m.subject === subject && m.testId === id));
      writeDb(db);
      return ok({ ok: true, subject, tests: user.tests[subject] });
    },

    /* ------------------------------------------- subjects and settings --- */
    'PUT /api/subjects': async ({ db, body, user }) => {
      const list = Array.isArray(body && body.subjects)
        ? body.subjects.map((s) => str(s, 40).trim()).filter(Boolean).slice(0, 30)
        : [];
      if (!list.length) return fail(422, { error: 'Keep at least one subject.' });
      if (new Set(list.map((s) => s.toLowerCase())).size !== list.length) {
        return fail(422, { error: 'Subject names must be different.' });
      }

      /* Every subject a student lists is put into the shared list as well, so
         one person typing in a subject makes it available to every account. A
         write that is refused (the name is already there, or the rules are not
         published yet) leaves the student's own list exactly as it was. */
      for (const name of list) shareSubject(name);

      /* A subject the student takes off their own list is remembered as
         removed, so the shared list does not quietly put it back. A subject
         they put back on is forgotten again. */
      const settings = user.settings || {};
      const kept = new Set((settings.removedSubjects || []).map((k) => String(k).toLowerCase()));
      const now = new Set(list.map((s) => s.toLowerCase()));
      for (const k of kept) if (now.has(k)) kept.delete(k);
      for (const have of (user.subjects || [])) {
        const k = String(have).toLowerCase();
        if (!now.has(k)) kept.add(k);
      }
      settings.removedSubjects = Array.from(kept);
      user.settings = settings;

      user.subjects = list;
      writeDb(db);
      return ok({ ok: true, subjects: list });
    },

    /* Throws away a hand-edited subject list and starts again from the one the
       owner set for the site. The tests for each subject are rebuilt so a
       subject that came back does not arrive empty.

       Marks are never deleted. A mark whose subject is no longer in the list
       simply stops being shown, and it comes back if that subject is added
       again - so this cannot lose anybody's work. */
    'POST /api/subjects/site-defaults': async ({ db, user }) => {
      const list = siteSubjects();
      user.subjects = list.slice();
      user.tests = {};
      for (const s of list) user.tests[s] = DEFAULT_TESTS.map((t) => ({ id: t.id, name: t.name, kind: t.kind }));
      /* "back to the site's subjects" also forgets the removals, or the shared
         list would immediately put the same names back on a later visit */
      const settings = user.settings || {};
      settings.removedSubjects = [];
      settings.subjectsVersion = SUBJECTS_VERSION;
      user.settings = settings;
      writeDb(db);
      return ok({ ok: true, subjects: user.subjects });
    },

    'PUT /api/settings': async ({ db, body, user }) => {
      const s = user.settings || {};
      if (body && body.name != null) {
        const n = str(body.name, 60).trim();
        if (n) { s.name = n; user.name = n; }
      }
      if (body && body.examDate != null) {
        const d = str(body.examDate, 10);
        if (!isDate(d)) return fail(422, { error: 'Invalid exam date.' });
        s.examDate = d;
      }
      if (body && body.examYear != null) {
        const y = Number(body.examYear);
        if (!Number.isInteger(y) || y < 2024 || y > 2045) return fail(422, { error: 'Exam year must be between 2024 and 2045.' });
        s.examYear = y;
        user.examYear = y;
      }
      user.settings = s;
      writeDb(db);
      return ok({ ok: true, settings: s, user: publicUser(user) });
    },

    /* ---------------------------------------------------- account data --- */
    'GET /api/account/export': async ({ user }) => ok({
      app: 'workbuddy',
      version: 1,
      storage: 'browser',
      exportedAt: new Date().toISOString(),
      user: publicUser(user),
      subjects: user.subjects || [],
      tests: testsPayload(user),
      settings: user.settings || {},
      weeks: user.weeks || {},
      marks: cleanMarks(user.marks || []),
    }),

    'POST /api/account/erase': async ({ db, user }) => {
      user.weeks = {};
      user.marks = [];
      /* erase means a fresh start, so the subject list goes back to empty too */
      user.subjects = [];
      user.tests = {};
      user.settings = { name: user.name, examDate: `${user.examYear}-08-01`, focusSubjects: [], subjectsVersion: SUBJECTS_VERSION };
      user.sessions = [];
      user.events = [];
      writeDb(db);
      clearToken();
      return { status: 200, body: { ok: true }, clearSession: true };
    },
  };

  /* ------------------------------------------------------------ dispatch -- */

  /* Two saves fired at once (typing in a mark field, for example) must not
     interleave: each request reads the database, changes it and writes it
     back, so overlapping requests would lose one of the two changes.
     Every write therefore waits for the one before it. */
  let queue = Promise.resolve();

  function api(method, path, body) {
    if (method === 'GET') return dispatch(method, path, body);
    const run = queue.then(() => dispatch(method, path, body));
    queue = run.then(() => {}, () => {});
    return run;
  }

  async function dispatch(method, path, body) {
    const key = `${method} ${path}`;
    const handler = handlers[key];
    if (!handler) throw new ApiError(404, { error: 'Unknown API endpoint.' });

    let db = readDb();
    let user = null;
    let session = null;

    if (!PUBLIC.has(key)) {
      const found = await sessionFromToken(db);
      if (!found || !found.session) {
        clearToken();
        throw new ApiError(401, { error: 'Please sign in.' });
      }
      // `user` must stay part of this same object graph, or writeDb(db) below
      // would save a copy without the changes made to it
      user = found.user;
      session = found.session;
      activeUser = user;
      guard = cloudViewKey(user);
    }

    const out = (await handler({ db, body, user, session })) || ok();
    guard = user ? cloudViewKey(user) : null;
    if (out.clearSession) clearToken();
    if (NETWORK_DELAY) await new Promise((r) => setTimeout(r, NETWORK_DELAY));
    if (out.status >= 400) throw new ApiError(out.status, out.body);
    return out.body;
  }

  global.Store = {
    api, ApiError, deviceId, deviceLabel, detectLabel,
    storageAvailable: () => storageOK,
    clearToken,
  };
})(window);
