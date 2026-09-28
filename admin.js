/* ==========================================================================
   WorkBuddy - owner settings page
   --------------------------------------------------------------------------
   This is where the owner changes the site itself. It is opened by signing in
   with the owner account on the normal sign-in page, so there is one interface
   for everybody: a username and a password, and then the right page for the
   account that was used.

   What "publish" means
     The form is a draft. Nothing reaches anybody until "Publish to the site"
     is pressed, which writes the one shared record the whole site reads. Every
     page is on a live subscription to that record, so a published change is on
     everybody's open screen within a second. If the same settings are opened on
     a second device, that device is told about the change here too, rather than
     quietly holding a stale copy of the form.

   The panel is only ever shown to the account the database says is the owner.
   The check is repeated on the way to the server and in the database rules, so
   hiding the form here is a convenience and not the thing that keeps other
   people out.
   ========================================================================== */
(function () {
  'use strict';

  const { api, ApiError, $, $$, esc, busy, setNotice, subjectColor } = window.WB;

  const el = {
    locked: $('#locked'),
    lockedTitle: $('#lockedTitle'),
    lockedText: $('#lockedText'),
    lockedLink: $('#lockedLink'),
    panel: $('#panel'),
    saveBar: $('#saveBar'),

    siteName: $('#adSiteName'),
    tagline: $('#adTagline'),
    description: $('#adDescription'),
    year: $('#adYear'),
    bannerOn: $('#adBannerOn'),
    bannerText: $('#adBannerText'),
    features: Array.from(document.querySelectorAll('[data-feature]')),

    maintOn: $('#adMaintOn'),
    maintTitle: $('#adMaintTitle'),
    maintMessage: $('#adMaintMessage'),
    maintUntil: $('#adMaintUntil'),

    subjects: $('#adSubjects'),
    pvSubjects: $('#pvSubjects'),
    pvSubjectsEmpty: $('#pvSubjectsEmpty'),

    pvName: $('#pvName'),
    pvTagline: $('#pvTagline'),
    pvBanner: $('#pvBanner'),
    pvMaint: $('#pvMaint'),
    pvMaintTitle: $('#pvMaintTitle'),
    pvMaintMsg: $('#pvMaintMsg'),
    pvMaintUntil: $('#pvMaintUntil'),
    pvMaintState: $('#pvMaintState'),
    live: $('#admLive'),
    meta: $('#admMeta'),
    setup: $('#admSetup'),

    usersSub: $('#usersSub'),
    userSearch: $('#adUserSearch'),
    usersRefresh: $('#adUsersRefresh'),
    usersList: $('#adUsersList'),

    saveNotice: $('#saveNotice'),
    btnSave: $('#btnSave'),
    btnReset: $('#btnReset'),
    signOutTop: $('#signOutTop'),
    avatar: $('#avatar'),
    whoName: $('#whoName'),
    whoExam: $('#whoExam'),
  };

  /* the copy last read from the cloud, so "discard changes" has something to go
     back to and the form can be told about changes the owner did not make */
  let saved = null;
  const state = { dirty: false, saving: false };

  /* ------------------------------------------------------------- reading -- */

  const formValue = () => {
    const features = {};
    for (const box of el.features) features[box.getAttribute('data-feature')] = box.checked;
    return {
      siteName: el.siteName.value.trim(),
      tagline: el.tagline.value.trim(),
      description: el.description.value.trim(),
      defaultExamYear: Number(el.year.value),
      defaultSubjects: readSubjectLines(),
      banner: { on: el.bannerOn.checked, text: el.bannerText.value.trim() },
      maintenance: {
        on: el.maintOn.checked,
        title: el.maintTitle.value.trim(),
        message: el.maintMessage.value.trim(),
        until: el.maintUntil.value.trim(),
      },
      features,
    };
  };

  /* The subject box is typed by hand, so the same clean-up runs here as runs
     when the value is written: blank lines dropped, spaces tidied, repeats
     kept only the first time, and a hard stop at 30. */
  function readSubjectLines() {
    const seen = new Set();
    const out = [];
    for (const line of el.subjects.value.split('\n')) {
      const name = line.replace(/\s+/g, ' ').trim().slice(0, 40);
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(name);
      if (out.length >= 30) break;
    }
    return out;
  }

  function fill(config) {
    const c = config || window.AppConfig.defaults();
    const m = c.maintenance || {};
    el.siteName.value = c.siteName || '';
    el.tagline.value = c.tagline || '';
    el.description.value = c.description || '';
    el.year.value = c.defaultExamYear || new Date().getFullYear() + 1;
    el.subjects.value = (c.defaultSubjects || []).join('\n');
    el.bannerOn.checked = !!(c.banner && c.banner.on);
    el.bannerText.value = (c.banner && c.banner.text) || '';
    el.maintOn.checked = !!m.on;
    el.maintTitle.value = m.title || '';
    el.maintMessage.value = m.message || '';
    el.maintUntil.value = m.until || '';
    for (const box of el.features) {
      const key = box.getAttribute('data-feature');
      box.checked = c.features ? c.features[key] !== false : true;
    }
  }

  /* ------------------------------------------------------------ preview -- */

  function preview() {
    const v = formValue();
    el.pvName.textContent = v.siteName || 'WorkBuddy';
    el.pvTagline.textContent = v.tagline || 'Study Planner';
    if (v.banner.on && v.banner.text) {
      el.pvBanner.textContent = v.banner.text;
      el.pvBanner.classList.remove('off');
    } else {
      el.pvBanner.textContent = v.banner.on
        ? 'The banner is on but has no wording yet.'
        : 'No announcement is showing.';
      el.pvBanner.classList.toggle('off', !v.banner.text);
    }

    /* The maintenance notice can only go up with something to read, which is
       the same rule the server applies, so the preview agrees with what will
       actually be published. */
    const m = v.maintenance;
    const ready = m.on && !!(m.title || m.message);
    el.pvMaint.classList.toggle('off', !ready);
    el.pvMaintTitle.textContent = m.title || 'We are working on the site';
    el.pvMaintMsg.textContent = m.message
      || 'Turn this on and everyone except you sees this page instead of the site.';
    el.pvMaintUntil.hidden = !m.until;
    el.pvMaintUntil.textContent = m.until ? `Back by ${m.until}` : '';

    el.pvMaintState.classList.toggle('off', !ready);
    el.pvMaintState.textContent = !m.on
      ? 'The site is open to everyone.'
      : ready
        ? 'Published like this, everyone except you is met by the notice.'
        : 'Add a heading or a message before this can be published.';

    /* The colours here are the same family the planner uses, so the preview is
       what a new account's settings page will actually look like. */
    const subs = v.defaultSubjects;
    el.pvSubjects.innerHTML = subs.map((s, i) => {
      const c = subjectColor(i);
      return `<span class="sub-chip" style="--c-bg:${c.bg}"><i style="background:${c.s}"></i>${esc(s)}</span>`;
    }).join('');
    el.pvSubjectsEmpty.hidden = subs.length > 0;
  }

  /** the publish button only lights up once something has actually been changed */
  function markDirty(on) {
    state.dirty = !!on;
    paint();
  }

  function paint() {
    el.btnSave.disabled = state.saving || !state.dirty;
    el.btnReset.disabled = state.saving || !state.dirty;
  }

  /* --------------------------------------------------------- live status -- */

  /* "Live" means the browser is on a subscription to the shared record, so a
     publish lands on everybody's open screen without a reload. Without a cloud
     project there is nothing to subscribe to, and the panel says so instead of
     promising something it cannot do. */
  function paintLive() {
    const box = el.live;
    if (!box) return;
    const s = window.Sync;
    if (!s || !s.configured()) {
      box.dataset.live = 'off';
      box.querySelector('.al-text').textContent = 'This browser only';
      box.title = 'No cloud project is filled in, so changes are kept in this browser only. Add the Firebase project in js/sync-config.js to publish to everybody.';
      return;
    }
    if (window.AppConfig.live) {
      box.dataset.live = 'on';
      box.querySelector('.al-text').textContent = 'Live';
      box.title = 'This page is watching the shared settings, so a publish reaches every open page within a second.';
      return;
    }
    box.dataset.live = 'off';
    box.querySelector('.al-text').textContent = 'No live link';
    box.title = 'The live subscription could not be opened. Changes will still be published, but people may need to reload to see them.';
  }

  /* --------------------------------------------------------- meta notes -- */

  function meta() {
    const s = window.Sync;
    const bits = [];

    if (!s || !s.configured()) {
      bits.push('No cloud project is filled in, so these settings would only be kept in this browser. Add the Firebase project in <code>js/sync-config.js</code> to share them with everyone.');
    } else if (!s.adminUid()) {
      bits.push('The owner id is still blank in the <code>admin</code> block of <code>js/sync-config.js</code>. Until it is filled in the database rules will refuse every save.');
    } else {
      bits.push(`Settings are saved to the cloud, and the rules in <code>js/sync-config.js</code> let only owner <code>${s.adminUid()}</code> change them.`);
      bits.push(`Sign in with <code>${s.adminUsername()}</code> to open this page.`);
    }

    el.meta.innerHTML = bits.map((b) => `<div style="margin-top:6px">${b}</div>`).join('');
  }

  /* -------------------------------------------------------------- states -- */

  function showLocked(title, text, linkText, href) {
    el.locked.hidden = false;
    el.panel.hidden = true;
    el.saveBar.hidden = true;
    el.lockedTitle.textContent = title;
    el.lockedText.textContent = text;
    if (linkText) {
      el.lockedLink.textContent = linkText;
      el.lockedLink.href = href || 'index.html';
      el.lockedLink.hidden = false;
    } else {
      el.lockedLink.hidden = true;
    }
  }

  function showPanel() {
    el.locked.hidden = true;
    el.panel.hidden = false;
    el.saveBar.hidden = false;
  }

  /* ------------------------------------------- owner setup helper -------- */

  /* The panel opens on email alone (see meta), but the database rules are the
     real lock and they want the owner id. This box makes finding that id a
     one-click job instead of reading the Firebase console. */
  function renderSetup() {
    const box = el.setup;
    if (!box) return;
    const s = window.Sync;
    if (!s || !s.configured()) {
      box.textContent = 'No cloud project is set up yet, so these settings can only be kept in this browser. Add the Firebase project in js/sync-config.js to share them with everyone.';
      return;
    }
    const known = s.adminUid();
    const mine = s.uidOf();
    if (known) {
      box.innerHTML = `The owner id is set in <code>js/sync-config.js</code>. The database rules are the real lock &mdash; if a save is refused, republish the rules with your id in them.`;
      return;
    }
    if (mine) {
      box.innerHTML =
        `Your Firebase id is <b>${esc(mine)}</b> ` +
        `<button class="btn soft xs" type="button" id="copyUid">Copy it</button>` +
        `<div style="margin-top:8px">Paste it into the <code>admin.uid</code> block of <code>js/sync-config.js</code>, save, then republish the database rules that use it. Until then the site knows you are the owner, but the database will refuse private writes.</div>`;
      const btn = box.querySelector('#copyUid');
      if (btn) btn.addEventListener('click', async () => {
        const done = () => { btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = 'Copy it'; }, 1600); };
        try { await navigator.clipboard.writeText(mine); done(); }
        catch {
          const r = document.createRange(); r.selectNodeContents(box);
          const sel = window.getSelection(); sel && (sel.removeAllRanges(), sel.addRange(r)); done();
        }
      });
    } else {
      box.textContent = 'Sign in to the cloud first, then this box shows the Firebase id to paste into js/sync-config.js.';
    }
  }

  /* --------------------------------------------------- registered users --- */

  let usersCache = null;

  function paintUsers(r, query) {
    const list = el.usersList;
    const users = (r && r.users) || [];
    if (!users.length) {
      const blocked = r && r.source === 'denied';
      list.innerHTML = `<div class="adm-users-empty">${blocked
        ? 'The shared list is closed by the database rules. Publish the rules with your owner id (setup box above) and refresh.'
        : 'No one has registered yet.'}</div>`;
      return;
    }
    const q = String(query || '').trim().toLowerCase();
    const filtered = q ? users.filter((u) => `${u.name} ${u.username} ${u.email}`.toLowerCase().includes(q)) : users;
    if (!filtered.length) {
      list.innerHTML = '<div class="adm-users-empty">Nothing matches that search.</div>';
      return;
    }
    const rows = filtered.map((u) => {
      const joined = u.createdAt ? new Date(u.createdAt).toLocaleDateString() : '\u2014';
      const initial = esc((u.name || u.username || '?').trim().charAt(0).toUpperCase());
      return `
        <div class="adm-user">
          <span class="au-avatar">${initial}</span>
          <span class="au-who">
            <b>${esc(u.name || u.username || 'Unnamed')}</b>
            <span>@${esc(u.username || '')} &middot; ${esc(u.email || '')}</span>
          </span>
          <span class="au-meta">
            <span>A/L ${esc(String(u.examYear || '\u2014'))}</span>
            <span>Joined ${esc(joined)}</span>
          </span>
          <span class="au-badge${u.verified ? ' ok' : ''}">${u.verified ? 'Verified' : 'Pending'}</span>
        </div>`;
    }).join('');
    list.innerHTML = rows;
  }

  async function loadUsers() {
    const list = el.usersList;
    if (!list) return;
    list.innerHTML = '<div class="adm-users-empty">Loading the shared list&hellip;</div>';
    el.usersSub.textContent = 'Accounts that registered on the site, newest first.';
    try {
      const r = await api('GET', '/api/admin/users');
      usersCache = r;
      paintUsers(r, el.userSearch.value);
      el.usersSub.textContent = r.note || 'Accounts that registered on the site, newest first.';
    } catch (err) {
      list.innerHTML = '<div class="adm-users-empty">The list could not be loaded.</div>';
      setNotice(el.saveNotice, 'error', (err instanceof ApiError && err.message) || 'The user list could not be loaded.');
    }
  }

  el.userSearch.addEventListener('input', () => { if (usersCache) paintUsers(usersCache, el.userSearch.value); });
  el.usersRefresh.addEventListener('click', loadUsers);

  /* -------------------------------------------------------------- saving -- */

  async function save() {
    const config = formValue();

    if (config.banner.on && !config.banner.text) {
      setNotice(el.saveNotice, 'warn', 'The banner is on but has no wording yet. Add a line or turn the banner off.');
      el.bannerText.focus();
      return;
    }
    if (config.maintenance.on && !config.maintenance.title && !config.maintenance.message) {
      setNotice(el.saveNotice, 'warn', 'The maintenance notice needs a heading or a message, otherwise visitors are met by a blank page.');
      el.maintTitle.focus();
      return;
    }
    if (!config.defaultExamYear || config.defaultExamYear < 2024 || config.defaultExamYear > 2045) {
      setNotice(el.saveNotice, 'warn', 'The default exam year must be between 2024 and 2045.');
      el.year.focus();
      return;
    }

    const takingDown = config.maintenance.on;
    busy(el.btnSave, true, 'Publishing');
    setNotice(el.saveNotice, null, null);
    state.saving = true;
    paint();
    try {
      const r = await api('PUT', '/api/admin/config', { config });
      saved = window.AppConfig.remember(r.config || config);
      fill(saved);
      preview();
      markDirty(false);
      setNotice(el.saveNotice, 'ok', takingDown
        ? 'Published. The site is down for maintenance, and you are the only one who can still get in.'
        : 'Published. Everyone sees this within a second, without reloading.');
    } catch (err) {
      setNotice(el.saveNotice, 'error', (err instanceof ApiError && err.message) || 'The changes could not be published.');
    } finally {
      state.saving = false;
      busy(el.btnSave, false);
      paint();
    }
  }

  el.btnSave.addEventListener('click', save);

  el.btnReset.addEventListener('click', () => {
    if (!saved) return;
    fill(saved);
    markDirty(false);
    preview();
    setNotice(el.saveNotice, 'info', 'Back to the settings that are live on the site. Nothing has changed for anyone.');
  });

  /* Ctrl/Cmd + Enter publishes, because this form is the owner's main page and
     waiting for a scroll bar to reach the button is needless. */
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && state.dirty && !state.saving) {
      e.preventDefault();
      save();
    }
  });

  /* typing anywhere in the form repaints the preview and unpublishes the button */
  const form = el.panel;
  form.addEventListener('input', () => { markDirty(true); preview(); });
  form.addEventListener('change', () => { markDirty(true); preview(); });

  el.signOutTop.addEventListener('click', async () => {
    try { await api('POST', '/api/auth/logout'); } catch { /* leaving anyway */ }
    window.location.replace('index.html');
  });

  /* ------------------------------------- a change made on another device -- */

  /* The same settings opened on a phone, or in another tab, is a real risk of
     quietly overwriting a change. A live update that arrives while the form is
     untouched is simply taken; one that arrives mid-edit is pointed out and
     left alone, because the typed work is the more recent thought. */
  window.AppConfig.onChange((e) => {
    if (e.source !== 'live' || !saved) return;
    const next = window.AppConfig.merge(e.data);
    if (JSON.stringify(next) === JSON.stringify(saved)) return;

    saved = next;
    if (!state.dirty) {
      fill(saved);
      preview();
      setNotice(el.saveNotice, 'info', 'Updated from another device. The form now shows what is live on the site.');
      return;
    }
    setNotice(el.saveNotice, 'warn', 'These settings were published from somewhere else while you were editing. Discard your changes to see them, or publish yours to overwrite them.');
  });

  /* --------------------------------------------------------------- start -- */

  (async function init() {
    await window.AppConfig.load();

    let me = null;
    try { me = await api('GET', '/api/auth/me'); } catch { /* not signed in */ }

    if (!me || !me.user) {
      window.AppConfig.armLock(true);
      showLocked(
        'Sign in as the owner',
        'These settings change the site for everybody. Sign in with the owner account on the sign-in page and this opens straight away.',
        'Go to sign in',
        'index.html'
      );
      return;
    }

    if (!me.user.isAdmin) {
      window.AppConfig.armLock(true);
      showLocked(
        'This account is not the owner',
        'You are signed in, but this account may not change the settings of the site. Sign in with the owner account instead.',
        'Sign in as the owner',
        'index.html'
      );
      return;
    }

    /* The owner runs the site, so maintenance mode never gets between them and
       this panel - otherwise turning it off would mean locking yourself out. */
    window.AppConfig.setLockOverride(true);
    window.AppConfig.armLock(true);

    showPanel();
    el.whoName.textContent = me.user.name || me.user.username;
    el.whoExam.textContent = me.user.username;
    el.avatar.textContent = (me.user.name || me.user.username || 'O').trim().charAt(0).toUpperCase();

    /* The copy on the cloud wins over the copy in this browser, so a change
       made from another device is what gets edited here. */
    let config = null;
    try {
      const r = await api('GET', '/api/admin/config');
      config = r && r.config ? r.config : window.AppConfig.data;
    } catch { config = window.AppConfig.data; }

    saved = window.AppConfig.merge(config);
    fill(saved);
    markDirty(false);
    preview();
    renderSetup();
    loadUsers();

    meta();
    paintLive();
  })();
})();
