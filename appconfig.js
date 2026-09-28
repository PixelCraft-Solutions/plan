/* ==========================================================================
   WorkBuddy - the settings of the site itself
   --------------------------------------------------------------------------
   One account holds these settings and every other account reads the same
   copy, so a change made by the owner reaches everyone. The record lives at
   `appConfig` in the database and is readable by anyone, which is what lets
   the sign-in page show the banner before anyone has signed in. Writing is
   closed to everyone but the owner by the database rules.

   What is in it
     siteName        the name beside the logo
     tagline         the smaller line under it
     description     the sentence under the logo on the sign-in page, and the
                     page description search engines read
     defaultExamYear the year the registration form starts on
     defaultSubjects the subjects a brand new account starts with, so a site
                     running on one stream does not hand everybody else's
                     subjects to every student who signs up
     banner          one line shown at the top of every page
     maintenance     the full page "we are working on the site" notice
     features        switches for the timetable, the marks page, the copy week
                     button and whether new accounts can be made at all

   When it is read
     Once, as each page starts, and then kept on a live subscription, so a
     change the owner publishes lands on every open page within a second
     instead of waiting for a reload. The copy from last time is used straight
     away so the page never flickers, and the fresh copy replaces it a moment
     later. Without a cloud the last copy kept in the browser is used, so a
     setting still holds on a device that cannot reach the network.

   Marking up a page
     Any element carrying `data-wb="siteName"`, `"tagline"`, `"description"`,
     `"year"`, `"bannerText"`, `"maintTitle"`, `"maintMessage"` or
     `"maintUntil"` has its text set from the matching setting. An element
     carrying `data-wb-feature="timetable|marks|copyWeek"` is hidden when that
     switch is off, an element carrying `data-wb="maintenance"` is shown only
     while maintenance mode is on, and an element carrying `data-wb-lock` is
     hidden for exactly as long as that is true. The document title and the
     meta description are set as well.

   Maintenance mode and the owner
     The owner is never locked out of their own site, so a page that has
     recognised the owner calls `setLockOverride(true)` and the notice steps
     aside. On the sign-in page, where nobody has signed in yet, the notice
     hides the form and offers the owner a way back into it. A page only acts
     on the lock once it has worked out who is looking (`armLock`), so the
     owner never sees the site blink out from under them.
   ========================================================================== */
(function (global) {
  'use strict';

  const CACHE_KEY = 'workbuddy.appconfig.v1';
  const SYNC = () => (global.Sync && global.Sync.configured() ? global.Sync : null);

  /* The list shown in the site editor before the owner has published one of
     their own, and the seed subjects a brand new site starts from. It used to
     be typed in here for one stream, until the site was made to serve any
     stream: this single most nearly universal subject is just enough for a new
     site to open on something other than an empty grid, and the real list is
     set by the owner in the editor and grows on its own as students add the
     subjects they actually take. */
  const BUILTIN_SUBJECTS = ['English'];

  const defaults = () => ({
    siteName: 'WorkBuddy',
    tagline: 'Study Planner',
    description: 'Plan your A/L study week, track subject marks and watch your progress climb in one place.',
    defaultExamYear: new Date().getFullYear() + 1,
    defaultSubjects: BUILTIN_SUBJECTS.slice(),
    banner: { on: false, text: '' },
    maintenance: { on: false, title: '', message: '', until: '' },
    features: { timetable: true, marks: true, copyWeek: true, registration: true },
    updatedAt: null,
  });

  const state = {
    data: defaults(),
    source: null,
    fingerprint: '',
    pool: [],
    lockOverride: false,
    /* Maintenance mode is only acted on once a page has worked out whether the
       person looking at it is the owner. Until then the lock is held back, so
       the owner never sees the site blink out from under them. */
    armed: false,
  };
  const listeners = [];
  let stopWatching = null;
  let stopPool = null;

  /* ------------------------------------------------------------- reading -- */

  function readCache() {
    try {
      const raw = global.localStorage.getItem(CACHE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  function writeCache(data) {
    try { global.localStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch { /* not vital */ }
  }

  /* The subject list is cleaned here rather than further down, because it is
     typed by hand on a textarea and a near-duplicate would quietly create two
     subjects that look the same in every chart. */
  function cleanSubjects(list) {
    const d = defaults();
    if (!Array.isArray(list)) return d.defaultSubjects.slice();
    const seen = new Set();
    const out = [];
    for (const raw of list) {
      const name = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim().slice(0, 40);
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(name);
      if (out.length >= 30) break;
    }
    return out.length ? out : d.defaultSubjects.slice();
  }

  /* A missing or half written setting falls back to the default, so a record
     saved by an older version of this file cannot leave a blank on screen. */
  function merge(raw) {
    const d = defaults();
    if (!raw || typeof raw !== 'object') return d;
    const f = (raw.features && typeof raw.features === 'object') ? raw.features : {};
    const b = (raw.banner && typeof raw.banner === 'object') ? raw.banner : {};
    const m = (raw.maintenance && typeof raw.maintenance === 'object') ? raw.maintenance : {};
    const year = Number(raw.defaultExamYear);
    return {
      siteName: String(raw.siteName || d.siteName).slice(0, 40),
      tagline: String(raw.tagline || d.tagline).slice(0, 40),
      description: String(raw.description == null ? d.description : raw.description).slice(0, 300),
      defaultExamYear: Number.isInteger(year) && year >= 2024 && year <= 2045 ? year : d.defaultExamYear,
      defaultSubjects: cleanSubjects(raw.defaultSubjects),
      banner: { on: !!b.on, text: String(b.text || '').slice(0, 200) },
      maintenance: {
        on: !!m.on,
        title: String(m.title || '').slice(0, 80),
        message: String(m.message == null ? '' : m.message).slice(0, 400),
        until: String(m.until || '').slice(0, 60),
      },
      features: {
        timetable: f.timetable !== false,
        marks: f.marks !== false,
        copyWeek: f.copyWeek !== false,
        registration: f.registration !== false,
      },
      updatedAt: raw.updatedAt || raw.at || null,
    };
  }

  const feature = (key) => state.data.features[key] !== false;

  /* ------------------------------------------------------------- changes -- */

  /* Maintenance mode is on, and this page has not been told that the person
     looking at it is the owner. */
  const locked = () => !!(state.data.maintenance && state.data.maintenance.on) && !state.lockOverride;

  const maintenanceOn = () => locked();

  /** the owner is never locked out of their own site */
  function setLockOverride(on) {
    const next = !!on;
    if (state.lockOverride === next) return;
    state.lockOverride = next;
    apply();
    fire();
  }

  /** called once the page knows who is looking, so the lock can now take hold */
  function armLock(on) {
    const next = !!on;
    if (state.armed === next) return;
    state.armed = next;
    apply();
    fire();
  }

  /** called by the owner panel, so a change from another device can be shown */
  function onChange(fn) {
    if (typeof fn !== 'function') return () => {};
    listeners.push(fn);
    return () => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  function fire(source) {
    const view = {
      source: source || state.source,
      data: state.data,
      locked: locked(),
      changed: true,
    };
    for (const fn of listeners.slice()) {
      try { fn(view); } catch { /* one listener must not break the others */ }
    }
  }

  function set(next, source) {
    const merged = merge(next);
    const mark = JSON.stringify(merged);
    const changed = mark !== state.fingerprint;
    state.data = merged;
    state.fingerprint = mark;
    if (source) state.source = source;
    if (changed) apply();
    return state.data;
  }

  /* ------------------------------------------------------ shared subjects -- */

  /* The names every student who uses the site has added to the shared list,
     kept current here so a page that asks "which subjects does this site
     know?" gets one answer. It is loaded once alongside the owner's settings
     and then kept alive by the same subscription, so a subject somebody adds
     reaches the whole site without a reload. */
  const poolListeners = [];

  function firePool() {
    for (const fn of poolListeners.slice()) {
      try { fn(state.pool.slice()); } catch { /* one listener must not break the others */ }
    }
  }

  async function loadPool() {
    const s = SYNC();
    if (!s || typeof s.readSubjectPool !== 'function') return;
    try {
      const list = await s.readSubjectPool();
      if (Array.isArray(list)) {
        state.pool = list;
        firePool();
      }
    } catch { /* the site carries on with what it has */ }
  }

  function onPoolChange(fn) {
    if (typeof fn !== 'function') return () => {};
    poolListeners.push(fn);
    return () => {
      const i = poolListeners.indexOf(fn);
      if (i >= 0) poolListeners.splice(i, 1);
    };
  }

  /** reads the shared record, falling back to the copy kept in this browser */
  async function load() {
    const cached = readCache();
    if (cached) set(cached.data, cached.source || 'cache');

    const s = SYNC();
    if (!s) { apply(); loadPool(); return state.data; }

    try {
      const fresh = await s.readAppConfig();
      if (fresh) {
        writeCache({ data: fresh, source: 'cloud' });
        set(fresh, 'cloud');
      } else if (!cached) {
        writeCache({ data: state.data, source: 'defaults' });
      }
    } catch { /* the copy already on screen stays */ }

    watch();
    loadPool();
    apply();
    return state.data;
  }

  /* Every page stays on the record from here on, so a change the owner
     publishes is on everyone's screen without anybody reloading. The listener
     is skipped when the page is in local mode, where there is nothing to
     listen to. */
  function watch() {
    if (stopWatching) return;
    const s = SYNC();
    if (!s || typeof s.watchAppConfig !== 'function') return;

    s.watchAppConfig((raw) => {
      if (!raw) return;
      const before = JSON.stringify(state.data);
      writeCache({ data: raw, source: 'live' });
      set(raw, 'live');
      if (JSON.stringify(state.data) !== before) fire('live');
    }).then((stop) => { if (stop) stopWatching = stop; }).catch(() => { /* no live link */ });

    if (typeof s.watchSubjectPool === 'function') {
      s.watchSubjectPool((list) => {
        if (!Array.isArray(list)) return;
        const key = list.join('\u0001');
        if (key === state.pool.join('\u0001')) return;
        state.pool = list;
        firePool();
      }).then((stop) => { if (stop) stopPool = stop; }).catch(() => { /* no live link */ });
    }
  }

  /** stops the live subscription, used when a page is torn down */
  function unwatch() {
    if (stopWatching) { try { stopWatching(); } catch { /* already gone */ } stopWatching = null; }
    if (stopPool) { try { stopPool(); } catch { /* already gone */ } stopPool = null; }
    state.pool = [];
  }

  /* ------------------------------------------------------------ applying -- */

  /* A field on a form is only filled in while it is still empty, so a value
     somebody has started typing is never overwritten. */
  const asText = (v) => String(v == null ? '' : v);

  const each = (attr, value) => {
    if (value == null) return;
    for (const el of global.document.querySelectorAll(`[data-wb="${attr}"]`)) {
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
        if (!asText(el.value).trim()) el.value = value;
      } else if (el.textContent !== asText(value)) {
        el.textContent = value;
      }
    }
  };

  /** pushes the settings onto the page that is on screen */
  function apply() {
    const d = state.data;
    const doc = global.document;
    if (!doc) return;

    if (d.siteName) {
      /* the part before the first dash is the name, whatever follows it is the
         page ("Sign in", "Study Planner") and is left where it is */
      const parts = doc.title.split(/\s*[·|-]\s*/).filter(Boolean);
      doc.title = parts.length > 1
        ? `${d.siteName} · ${parts.slice(1).join(' · ')}`
        : `${d.siteName}${d.tagline ? ` · ${d.tagline}` : ''}`;
    }

    const meta = doc.querySelector('meta[name="description"]');
    if (meta && d.description) meta.setAttribute('content', d.description);

    each('siteName', d.siteName);
    each('tagline', d.tagline);
    each('description', d.description);
    each('year', d.defaultExamYear);

    /* The banner lives inside whatever the page marks as `banner`, so one
       block can hold the text, the styling and the close button together. */
    for (const el of doc.querySelectorAll('[data-wb="banner"]')) {
      const on = !!(d.banner && d.banner.on && String(d.banner.text || '').trim());
      el.hidden = !on;
      if (!on) continue;
      const text = String(d.banner.text).trim();
      const slot = el.querySelector('[data-wb="bannerText"]');
      if (slot) slot.textContent = text;
      else el.textContent = text;
    }

    for (const el of doc.querySelectorAll('[data-wb-feature]')) {
      el.hidden = !feature(el.getAttribute('data-wb-feature'));
    }

    /* Maintenance mode. The notice is shown for as long as the lock is on, and
       everything marked as `data-wb-lock` is hidden for exactly that long, so
       a page can swap its whole body for the notice in one move. The lock only
       acts once the page has armed it, which is what keeps the owner from
       seeing the site disappear for a moment. */
    const shut = state.armed && locked();
    for (const el of doc.querySelectorAll('[data-wb="maintenance"]')) {
      el.hidden = !shut;
    }
    if (shut) {
      each('maintTitle', d.maintenance.title || 'We are working on the site');
      each('maintMessage', d.maintenance.message || 'Please come back shortly. Nothing you have saved is lost.');
    }
    /* The wording is kept current even while the notice is out of sight, so a
       time left over from before is never shown if the lock is taken back up. */
    each('maintUntil', d.maintenance.until);
    for (const el of doc.querySelectorAll('[data-wb="maintUntilLine"]')) {
      el.hidden = !String(d.maintenance.until || '').trim();
    }
    for (const el of doc.querySelectorAll('[data-wb-lock]')) {
      el.hidden = shut;
    }
  }

  /* -------------------------------------------------------------- saving -- */

  /* The owner saves through `api('PUT', '/api/admin/config')`, which cleans
     the values and asks the cloud to write them. The live subscription then
     hands the same record straight back, so the cache and the page are already
     up to date before the round trip is even over. */
  function remember(data) {
    const c = merge(data);
    writeCache({ data: c, source: 'cloud' });
    set(c, 'cloud');
    return c;
  }

  global.AppConfig = {
    load, apply, feature, merge, remember, defaults,
    onChange, setLockOverride, armLock, unwatch, maintenanceOn,
    onPoolChange, loadPool,
    get locked() { return state.armed && locked(); },
    get live() { return !!stopWatching; },
    get data() { return state.data; },
    get pool() { return state.pool.slice(); },
    get source() { return state.source; },
  };
})(window);
