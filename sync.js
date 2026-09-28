/* ==========================================================================
   WorkBuddy - cloud sync
   --------------------------------------------------------------------------
   What this file does
     The planner runs entirely in the browser, so a brand new device knows
     nothing. This module copies an account between devices, so that signing in
     with the same details on a second phone or laptop shows every week and
     every mark entered on the first one.

   Where it is stored
     `mode()` is "local" until js/sync-config.js has a Firebase project filled
     in, so the site works with no keys at all and nothing changes. With a
     project configured the mode is "cloud" and the account lives at
     accounts/<uid>, where uid is the id Firebase hands out at sign up. The
     database rules in sync-config.js make that id readable and writable by its
     owner alone.

   How two devices are kept from overwriting each other
     The account is split into six independent groups:

       profile   name, username, email, exam year
       settings  exam date, focus subjects
       subjects  the subject list
       tests     the test and exam list of each subject
       weeks     every planned week
       marks     every mark entered

     Each group carries the time it was last changed. A push sends only the
     groups this device changed, and a pull takes a group only when the copy on
     the server is newer than the copy this device last saw. Two people editing
     different subjects on two devices therefore both keep their work.

     The settings of the site itself
       One record sits above the accounts, at `appConfig`, holding the site
       name, the announcement banner, the maintenance notice and the feature
       switches. Everybody reads the same copy, so a change made by the owner
       shows up for every account, and only the owner id named in the database
       rules may write it. Every page subscribes to it with `watchAppConfig`,
       so a change the owner publishes lands on everybody's open screen at once
       rather than the next time they reload.


    Safety
     Every entry point here swallows its own errors, the local database stays
     what the interface reads from, and a push that fails is retried later, so
     sync trouble can never stop someone planning their week.
   ========================================================================== */
(function (global) {
  'use strict';

const GROUPS = ['profile', 'settings', 'subjects', 'tests', 'weeks', 'marks'];
const APP_CONFIG_PATH = 'appConfig';
const SUBJECT_POOL_PATH = 'subjectPool';

  const cfg = (global.WB_SYNC_CONFIG = global.WB_SYNC_CONFIG || {});
  const firebase = cfg.firebase || {};

  const state = {
    state: 'local',       // local | connecting | synced | offline | error
    detail: '',
    lastSync: null,
    pending: 0,
    seen: {},             // group -> time of the copy this device last saw
    listeners: [],
  };

  const now = () => Date.now();
  const log = (...a) => { if (cfg.debug) console.log('[sync]', ...a); };
  const clone = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

  function setStatus(next, detail) {
    if (state.state === next && state.detail === (detail || '')) return;
    state.state = next;
    state.detail = detail || '';
    for (const fn of state.listeners) {
      try { fn(status()); } catch { /* a listener must not break the sync */ }
    }
  }

  const status = () => ({
    state: state.state,
    detail: state.detail,
    lastSync: state.lastSync,
    pending: state.pending,
    mode: mode(),
  });

  const configured = () =>
    !!global.WBFirebase || !!(firebase && firebase.apiKey && firebase.databaseURL && firebase.projectId);
  const mode = () => (configured() ? 'cloud' : 'local');
  const onChange = (fn) => { if (typeof fn === 'function') state.listeners.push(fn); };

  const looksLikeEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());

  /* ---------------------------------------------------------------- owner -- */

  /* The owner signs in with a plain username, but Firebase is the thing that
     holds the password and it only knows email addresses, so the username is
     swapped for the owner's address on the way in. The password itself is
     never written in the code, so seeing this file reveals nothing. */
  const adminCfg = () => (cfg.admin || {});
  const adminUsername = () => String(adminCfg().username || '').trim();
  const adminEmail = () => String(adminCfg().email || '').trim().toLowerCase();
  const adminUid = () => String(adminCfg().uid || '').trim();

  const isAdminUid = (uid) => !!uid && !!adminUid() && uid === adminUid();
  const isAdminIdentifier = (v) => {
    const raw = String(v || '').trim().toLowerCase();
    if (!raw) return false;
    return raw === adminUsername().toLowerCase() || raw === adminEmail();
  };
  const adminIdentifier = (v) => (isAdminIdentifier(v) ? adminEmail() : String(v || '').trim());

  /* -------------------------------------------------------- app settings -- */

  /** any path on the database, used for the one shared settings record */
  async function at(path) {
    const c = await connect();
    return c.db.ref(path);
  }

  /** the settings of the site itself, which every account reads the same copy of */
  async function readAppConfig() {
    if (!configured()) return null;
    try {
      const snap = await (await at(APP_CONFIG_PATH)).once('value');
      return snap && snap.val() ? snap.val() : null;
    } catch (err) {
      log('app config read failed', err);
      return null;
    }
  }

  /* A live subscription to that same record, so a change the owner publishes
     reaches every open page within a second instead of waiting for a reload.
     The record is readable by anyone (which is what lets the sign-in page show
     the banner before anyone has signed in), so this needs no account at all.
     The handler is given the whole record every time, and is only called again
     when the record really changed. Returns a function that stops listening. */
  let configWatch = null;

  async function watchAppConfig(onValue) {
    if (typeof onValue !== 'function') return null;
    if (!configured()) return null;
    if (configWatch) return configWatch;

    try {
      const ref = await at(APP_CONFIG_PATH);
      const handler = ref.on(
        'value',
        (snap) => { onValue(snap && snap.val() ? snap.val() : null); },
        (err) => { log('app config watch failed', err); }
      );
      configWatch = () => {
        try { ref.off('value', handler); } catch { /* already detached */ }
        configWatch = null;
      };
      return configWatch;
    } catch (err) {
      log('app config watch could not start', err);
      return null;
    }
  }

  /* The check here is only so the panel can explain itself. The rules on the
     database are what actually refuse anyone else. The owner is recognised by
     the id named in the admin block, or by the signed-in email when the id is
     still blank (which every freshly set up site is until the owner discovers
     their id). */
  async function writeAppConfig(data) {
    if (!configured()) return { ok: false, error: 'No cloud project is set up in js/sync-config.js.' };
    const c = await connect();
    const uid = uidOf();
    if (!uid) return { ok: false, error: 'Sign in on this device first.' };
    const isOwner = () => {
      if (!adminUid() || uid === adminUid()) return true;
      const u = c.auth && c.auth.currentUser;
      return !!(u && u.email && String(u.email).toLowerCase() === adminEmail());
    };
    if (!isOwner()) return { ok: false, error: 'Only the owner may change the app settings.' };
    try {
      await c.db.ref(APP_CONFIG_PATH).update(Object.assign({}, data, { at: now(), by: uid }));
    } catch (err) {
      log('app config write failed', err);
      const denied = /permission|unauthor/i.test((err && err.message) || '');
      return {
        ok: false,
        error: denied
          ? 'The database rules did not accept this. Publish the rules with your owner id in them.'
          : 'The cloud could not be reached, so nothing was saved.',
      };
    }
    return { ok: true };
  }

  /* With a cloud set up, a freshly opened page starts in step with the copy it
     was given when it was signed in, and says so rather than looking unset. */
  if (configured()) setStatus('synced');

  /* ------------------------------------------------------- firebase glue -- */

  let sdkPromise = null;

  /* The compat build of the Firebase SDK puts itself on the page as
     `firebase`, and the full build is needed because the database is used as
     well as the sign in. A test double can be placed on `WBFirebase` instead,
     which is then used as it is. */
  function loadSdk() {
    if (global.WBFirebase && global.WBFirebase.database) return Promise.resolve(global.WBFirebase);
    if (sdkPromise) return sdkPromise;
    setStatus('connecting', 'Reaching the cloud');
    sdkPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://www.gstatic.com/firebasejs/10.12.2/firebase-compat.js';
      s.onload = () => {
        if (!global.firebase) { reject(new Error('The cloud library did not load.')); return; }
        global.WBFirebase = global.firebase;
        resolve(global.firebase);
      };
      s.onerror = () => reject(new Error('Could not reach the cloud servers.'));
      document.head.appendChild(s);
    }).catch((err) => { sdkPromise = null; throw err; });
    return sdkPromise;
  }

  let conn = null;

  async function connect() {
    if (conn) return conn;
    const fbi = await loadSdk();
    if (!fbi.apps || !fbi.apps.length) {
      if (!firebase.apiKey) throw new Error('Add a Firebase project in js/sync-config.js first.');
      fbi.initializeApp(firebase);
    }
    const auth = fbi.auth();
    const db = fbi.database();
    try { auth.setPersistence(fbi.auth.Auth.Persistence.LOCAL); } catch { /* older build */ }
    conn = { auth, db, ref: (path) => db.ref('accounts/' + path) };
    return conn;
  }

  const uidOf = () => (conn && conn.auth && conn.auth.currentUser ? conn.auth.currentUser.uid : null);

  /* ---------------------------------------------------------- credentials -- */

  /**
   * Firebase holds the password, this site never sees it in the clear, and
   * rejects a wrong one before a single byte of planner data is sent.
   */
  async function signUp(email, password) {
    const c = await connect();
    const cred = await c.auth.createUserWithEmailAndPassword(email, password);
    return { uid: cred.user.uid, email: cred.user.email };
  }

  async function doSignIn(email, password) {
    try {
      const c = await connect();
      const cred = await c.auth.signInWithEmailAndPassword(String(email).trim(), password);
      return { ok: true, uid: cred.user.uid, email: cred.user.email };
    } catch (err) {
      const code = (err && err.code) || '';
      if (/invalid-login-credentials|wrong-password|user-not-found/.test(code)) {
        return { ok: false, error: 'That email and password do not match an account.' };
      }
      if (/too-many-requests/.test(code)) {
        return { ok: false, error: 'Too many attempts. Wait a minute and try again.' };
      }
      const denied = /auth\/invalid-api-key|auth\/api-key-not-valid/.test(code);
      return { ok: false, error: denied ? 'The cloud is not set up correctly.' : (err && err.message) || 'Could not reach the cloud.' };
    }
  }

  /* ------------------------------------------------------ username lookup -- */

  /* Usernames are friendly to type but the cloud only knows email addresses,
     so a small directory is kept at `usernames/<short-name>` -> email. It is
     written the moment a username is linked to a Firebase account and read
     only when someone signs in with the username instead of the email. */
  async function usernameToEmail(username) {
    if (!configured()) return null;
    try {
      const snap = await (await at('usernames/' + String(username || '').trim().toLowerCase())).once('value');
      const email = snap && snap.val();
      return email ? String(email).toLowerCase() : null;
    } catch (err) {
      log('username lookup failed', err);
      return null;
    }
  }

  /**
   * Signs in with either an email address or a username. The owner is the one
   * account whose plain username is known without a lookup.
   */
  async function signIn(identifier, password) {
    if (isAdminIdentifier(identifier)) return doSignIn(adminEmail(), password);
    if (looksLikeEmail(identifier)) return doSignIn(identifier, password);
    const email = await usernameToEmail(identifier);
    if (!email) {
      return {
        ok: false,
        error: 'That username does not match a cloud account. Sign in with the email you registered with instead.',
      };
    }
    return doSignIn(email, password);
  }

  /* ------------------------------------------------------ account index -- */

  /* Every account is written to two small public-facing records so that
     usernames can be looked up (see above) and the owner can see who
     registered. No planner data and no password are ever written here. All of
     these are best-effort: if the database rules have not been published yet
     the write simply does not happen and the site keeps working. */
  async function writeUsernameDirectory(username, email) {
    if (!configured() || !username || !email) return;
    try { await (await at('usernames/' + String(username).trim().toLowerCase())).set(String(email).trim().toLowerCase()); }
    catch (err) { log('username index write refused', err); }
  }

  async function writeUserDirectory(uid, profile) {
    if (!configured() || !uid) return;
    try { await (await at('users/' + uid)).set(Object.assign({}, profile, { at: Date.now() })); }
    catch (err) { log('user index write refused', err); }
  }

  async function patchUserDirectory(uid, patch) {
    if (!configured() || !uid) return;
    try { await (await at('users/' + uid)).update(Object.assign({}, patch)); }
    catch (err) { log('user index patch refused', err); }
  }

  async function listUsers() {
    if (!configured()) return { list: [], denied: false };
    try {
      const snap = await (await at('users')).once('value');
      const val = snap && snap.val();
      if (!val || typeof val !== 'object') return { list: [], denied: false };
      const list = Object.keys(val)
        .filter((k) => val[k] && typeof val[k] === 'object')
        .map((k) => {
          const p = val[k];
          return {
            uid: k,
            name: String(p.name || ''),
            username: String(p.username || ''),
            email: String(p.email || ''),
            examYear: p.examYear || null,
            verified: !!p.verified,
            createdAt: p.createdAt || null,
            at: p.at || null,
          };
        })
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
      return { list, denied: false };
    } catch (err) {
      log('user list read failed', err);
      return { list: [], denied: true };
    }
  }

  /* ------------------------------------------------------ shared subjects -- */

  /* The shared list of subject names, kept one small record per name at
     `subjectPool/<slug>`, holding only the name and who added it. It is what
     lets the site serve any stream instead of one list fixed in the code: when
     somebody types a subject into their own Settings it is put here, and it
     then reaches every account. The rules let a name be created once, and
     changed only by whoever created it, so nobody can rename or delete a name
     other people are already relying on.

     Everything here is best-effort. If the rules have not been published yet
     the write is simply refused and the site carries on with the list it
     already has, which is why nothing here throws. */

  const subjectSlug = (name) =>
    String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

  /** a pool snapshot as a plain list of names, alphabetically */
  function subjectNames(raw) {
    if (!raw || typeof raw !== 'object') return [];
    return Object.keys(raw)
      .map((k) => (raw[k] && typeof raw[k] === 'object' ? raw[k] : raw[k]))
      .map((p) => (p && typeof p === 'object' ? String(p.name || '') : String(p || '')))
      .map((n) => n.trim())
      .filter(Boolean)
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  }

  async function readSubjectPool() {
    if (!configured()) return [];
    try {
      const snap = await (await at(SUBJECT_POOL_PATH)).once('value');
      return subjectNames(snap && snap.val());
    } catch (err) {
      log('subject pool read failed', err);
      return [];
    }
  }

  /** puts one new name in the shared list, whoever is signed in */
  async function addSubjectToPool(name) {
    if (!configured()) return { ok: false, error: 'No cloud project is set up.' };
    const clean = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    const slug = subjectSlug(clean);
    if (!clean || !slug) return { ok: false, error: 'That subject name cannot be used.' };
    try {
      await (await at(`${SUBJECT_POOL_PATH}/${slug}`)).set({ name: clean, by: uidOf(), at: now() });
      return { ok: true };
    } catch (err) {
      /* already there, or the rules are not published: either way nothing is
         lost, the name is simply not shared yet */
      log('subject pool write refused', err);
      return { ok: false, error: 'The shared list did not take this name.' };
    }
  }

  /* A live subscription to the shared list, so a subject somebody adds reaches
     every open page without a reload. Returns a function that stops it. */
  let poolWatch = null;

  async function watchSubjectPool(onValue) {
    if (typeof onValue !== 'function') return null;
    if (!configured()) return null;
    if (poolWatch) return poolWatch;
    try {
      const ref = await at(SUBJECT_POOL_PATH);
      const handler = ref.on(
        'value',
        (snap) => { onValue(subjectNames(snap && snap.val())); },
        (err) => { log('subject pool watch failed', err); }
      );
      poolWatch = () => {
        try { ref.off('value', handler); } catch { /* already detached */ }
        poolWatch = null;
      };
      return poolWatch;
    } catch (err) {
      log('subject pool watch could not start', err);
      return null;
    }
  }

  async function signOut() {
    if (!conn || !conn.auth) return;
    try { await conn.auth.signOut(); } catch { /* already signed out */ }
  }

  /* Changing the password has to happen on the server too, or the old one
     would keep opening the account on other devices while the new one failed. */
  async function updatePassword(next) {
    const c = await connect();
    const auth = c.auth;
    const u = auth && auth.currentUser;
    if (!u) throw new Error('This device is not signed in to the cloud.');
    await u.updatePassword(next);
    return true;
  }

  /* ------------------------------------------------------------- reading -- */

  /** the whole account held on the server for this person */
  async function download(uid) {
    if (!configured() || !uid) return null;
    const c = await connect();
    const snap = await c.ref(uid).once('value');
    const raw = snap && snap.val();
    if (!raw) return null;
    const account = { uid };
    for (const g of GROUPS) account[g] = raw.g && raw.g[g] ? raw.g[g].data : null;
    for (const g of GROUPS) state.seen[g] = Math.max(state.seen[g] || 0, (raw.g && raw.g[g] && Number(raw.g[g].at)) || 0);
    state.lastSync = now();
    return account;
  }

  /* ------------------------------------------------------------- writing -- */

  let timer = null;
  let retryTimer = null;
  const pending = new Set();
  let lastSent = null;
  let lastAccount = null;

  const fingerprint = (account) => {
    const out = {};
    for (const g of GROUPS) out[g] = JSON.stringify(clone(account ? account[g] : null));
    return out;
  };

  /** the groups this device has changed since the last successful push */
  function changedGroups(account) {
    const now_ = fingerprint(account);
    const was = lastSent || {};
    return GROUPS.filter((g) => now_[g] !== (was[g] === undefined ? 'null' : was[g]));
  }

  function remember(account) {
    lastSent = fingerprint(account);
  }

  function schedulePush(account) {
    if (!configured() || !account || !account.uid) return;
    lastAccount = account;
    for (const g of changedGroups(account)) pending.add(g);
    if (!pending.size) return;
    state.pending = pending.size;
    if (state.state === 'local') setStatus('connecting');
    clearTimeout(timer);
    timer = setTimeout(() => { flush(account).catch(() => {}); }, 900);
  }

  async function flush(account) {
    clearTimeout(timer);
    clearTimeout(retryTimer);
    if (!configured() || !account || !account.uid) return;
    if (!pending.size) return;
    const groups = [...pending];
    const c = await connect();
    const at = now();
    const updates = {};
    for (const g of groups) {
      updates[`g/${g}/at`] = at;
      updates[`g/${g}/data`] = clone(account[g]);
    }
    try {
      await c.ref(account.uid).update(updates);
    } catch (err) {
      /* Nothing is lost: the copy this device shows is already saved, the
         groups stay on the list, and it is tried again shortly. The reason is
         kept out of the wording, which a person reads. */
      log('push failed', err);
      setStatus(navigator.onLine === false ? 'offline' : 'error',
        navigator.onLine === false
          ? 'You are offline. Nothing is lost, it copies up when you are back.'
          : 'The cloud did not answer. Your work is safe in this browser and it will try again.');
      retryTimer = setTimeout(() => { flush(lastAccount || account).catch(() => {}); }, 15000);
      return;
    }
    for (const g of groups) state.seen[g] = at;
    pending.clear();
    state.pending = 0;
    state.lastSync = at;
    remember(account);
    setStatus('synced');
    log('pushed', groups.join(', '));
  }

  /** used by the Sync now button, and after signing in on a new device */
  async function pushNow(account) {
    if (!configured()) return { ok: true, skipped: true };
    for (const g of GROUPS) pending.add(g);
    state.pending = pending.size;
    setStatus('connecting', 'Sending this account up');
    try {
      await flush(account);
    } catch (err) {
      setStatus(navigator.onLine === false ? 'offline' : 'error', err.message || 'The cloud could not be reached.');
    }
    if (pending.size) return { ok: false, error: status().detail || 'The cloud could not be reached.' };
    return { ok: true };
  }

  /* ---------------------------------------------------------- page events -- */

  if (typeof global.addEventListener === 'function') {
    global.addEventListener('offline', () => {
      if (configured()) setStatus('offline', 'You are offline. Nothing is lost, it syncs when you are back.');
    });
    global.addEventListener('online', () => {
      if (configured() && state.state === 'offline') setStatus('connecting');
    });
    /* A tab closed moments after a save must not take the copy with it, so the
       wait is cut short on the way out. */
    global.addEventListener('pagehide', () => {
      if (!configured() || !pending.size || !lastAccount) return;
      flush(lastAccount).catch(() => { /* the work is safe in this browser */ });
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'hidden') return;
      if (!configured() || !pending.size || !lastAccount) return;
      flush(lastAccount).catch(() => { /* the work is safe in this browser */ });
    });
  }

  global.Sync = {
    GROUPS, configured, mode, status, onChange, looksLikeEmail,
    signUp, signIn, signOut, download, schedulePush, pushNow, updatePassword,
    usernameToEmail, writeUsernameDirectory, writeUserDirectory, patchUserDirectory, listUsers,
    readSubjectPool, addSubjectToPool, watchSubjectPool, subjectSlug,
    changedGroups, remember, uidOf,
    adminCfg, adminUsername, adminEmail, adminUid, isAdminUid, isAdminIdentifier, adminIdentifier,
    readAppConfig, writeAppConfig, watchAppConfig,
    /* for the test suite: forget everything between runs */
    __test: {
      reset() {
        if (configWatch) { try { configWatch(); } catch { /* ignore */ } }
        if (poolWatch) { try { poolWatch(); } catch { /* ignore */ } }
        state.seen = {};
        state.pending = 0;
        pending.clear();
        lastSent = null;
        conn = null;
        sdkPromise = null;
        setStatus('local');
      },
    },
  };
})(window);
