/* ==========================================================================
   WorkBuddy - planner
   ========================================================================== */
(function () {
  'use strict';

  const { api, ApiError, $, $$, esc, busy, setNotice, pad2, toISO, showFieldError, clearFieldErrors } = window.WB;

  /* ------------------------------------------------------------- consts - */

  const DAYS = [
    { key: 'mon', label: 'Monday', short: 'Mon', min: 'Monday' },
    { key: 'tue', label: 'Tuesday', short: 'Tue', min: 'Tuesday' },
    { key: 'wed', label: 'Wednesday', short: 'Wed', min: 'Wednesday' },
    { key: 'thu', label: 'Thursday', short: 'Thu', min: 'Thursday' },
    { key: 'fri', label: 'Friday', short: 'Fri', min: 'Friday' },
    { key: 'sat', label: 'Saturday', short: 'Sat', min: 'Saturday' },
    { key: 'sun', label: 'Sunday', short: 'Sun', min: 'Sunday' },
  ];
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // the subject colours live in the shared helpers, because the owner panel
  // previews the same chips when setting the subjects for new accounts

  const DEFAULT_SUBJECTS = ['Accounting', 'BS', 'ICT', 'English'];

  /* What a new account starts with, taken from the shared settings the owner
     publishes. The built-in list is only the fallback for a site with no
     cloud, or for the moment before those settings arrive. */
  const siteSubjects = () => {
    const ac = window.AppConfig;
    const list = ac && ac.data && ac.data.defaultSubjects;
    return Array.isArray(list) && list.length ? list.slice() : DEFAULT_SUBJECTS.slice();
  };

  const GRID_START = 6 * 60;
  const GRID_END = 22 * 60;
  const SLOT = 30;
  const ROW_H = 34;
  const SLOTS = (GRID_END - GRID_START) / SLOT;

  const PAPERS = [{ p: 'I' }, { p: 'II' }, { p: 'III' }];
  const PAPER_MAX = 100;

  /* -------------------------------------------------------------- state - */

  const S = {
    user: null,
    subjects: [],
    siteSubjects: [],
    tests: {},
    settings: { name: '', examDate: '', focusSubjects: [] },
    weekOffset: 0,
    weeks: {},
    marks: [],
    editId: null,
    editDay: null,
    ttFilter: 'all',
    mkSubject: null,
    mkTest: null,
    mkRenaming: false,
    copyTarget: null,
    copyMode: 'copy',
    saveTimer: null,
  };

  /* ---------------------------------------------------------- utilities - */

  function mondayOf(offsetWeeks) {
    const now = new Date();
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + (offsetWeeks || 0) * 7);
    return d;
  }
  const weekId = () => toISO(mondayOf(S.weekOffset));
  const todayISO = () => toISO(new Date());
  function dateOfDay(i) { const m = mondayOf(S.weekOffset); m.setDate(m.getDate() + i); return toISO(m); }

  function weekRangeText(off) {
    const a = mondayOf(off);
    const b = new Date(a); b.setDate(b.getDate() + 6);
    const fmt = (d) => `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`;
    return a.getMonth() === b.getMonth()
      ? `${fmt(a)} – ${b.getDate()} ${MONTHS_SHORT[b.getMonth()]} ${b.getFullYear()}`
      : `${fmt(a)} – ${fmt(b)} ${b.getFullYear()}`;
  }

  /** "17:00" -> 1020 */
  function toMin(hhmm) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
    if (!m) return NaN;
    return Math.min(1440, Number(m[1]) * 60 + Number(m[2]));
  }
  /** 1020 -> "5:00 PM" */
  function fmtTime(mins) {
    if (!Number.isFinite(mins)) return '';
    let m = ((Math.round(mins / SLOT) * SLOT) % 1440 + 1440) % 1440;
    const h24 = Math.floor(m / 60);
    const h = h24 % 12 === 0 ? 12 : h24 % 12;
    return `${h}:${pad2(m % 60)} ${h24 < 12 ? 'AM' : 'PM'}`;
  }
  /** 150 -> "2h 30m" */
  function fmtDur(mins) {
    if (!mins) return '0m';
    const h = Math.floor(mins / 60);
    const m = Math.round(mins % 60);
    return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
  }
  const hhmm = (mins) => `${pad2(Math.floor(mins / 60) % 24)}:${pad2(mins % 60)}`;

  /** the colour a subject is drawn in, found by where it sits in the list */
  function subjectColor(name) {
    return window.WB.subjectColor(Math.max(0, S.subjects.indexOf(name)));
  }

  const weekOf = (id) => S.weeks[id] || {};
  const dayTasks = (id, day) => (S.weeks[id] && S.weeks[id][day]) || [];

  function blankWeek() {
    const o = {};
    for (const d of DAYS) o[d.key] = [];
    return o;
  }

  function countSessions(wk) {
    return DAYS.reduce((n, d) => n + ((wk && wk[d.key]) ? wk[d.key].length : 0), 0);
  }

  /* ------------------------------------------------------------- toasts - */

  function toast(msg, kind) {
    const box = $('#toast');
    const t = document.createElement('div');
    t.className = 'toast' + (kind ? ' ' + kind : '');
    t.innerHTML = '<span class="ti"></span><span></span>';
    t.lastElementChild.textContent = msg;
    box.appendChild(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 240); }, 3200);
  }

  /* ------------------------------------------------------ data loading - */

  async function loadAll() {
    const me = await api('GET', '/api/auth/me');
    S.user = me.user;
    S.settings = Object.assign({ name: '', examDate: '', focusSubjects: [] }, me.settings || {});
    S.settings.name = S.user.name;
    S.settings.examDate = S.settings.examDate || defaultExamDate();

    const [wk, mk] = await Promise.all([api('GET', '/api/weeks'), api('GET', '/api/marks')]);
    S.weeks = wk.weeks || {};
    /* The account's own list, and nothing else. New accounts start without a
       single subject, so it stays empty until the student adds the ones they
       actually take. */
    S.subjects = (mk.subjects && mk.subjects.length ? mk.subjects : me.subjects || []).slice();
    /* The list the owner set for the site, kept so Settings can offer a way
       back to it and can say whether this account has been changed away. */
    S.siteSubjects = (me.siteSubjects && me.siteSubjects.length ? me.siteSubjects : []).slice();
    S.tests = mk.tests || {};
    S.marks = (mk.marks || []).map(normaliseMark);
    for (const s of S.subjects) {
      S.tests[s] = S.tests[s] && S.tests[s].length ? S.tests[s] : [];
    }
  }

  function defaultExamDate() {
    return `${S.user && S.user.examYear ? S.user.examYear : new Date().getFullYear() + 1}-08-01`;
  }

  function normaliseMark(m) {
    return {
      subject: m.subject,
      testId: m.testId || 't1',
      testName: m.testName || 'Test',
      kind: m.kind === 'exam' ? 'exam' : 'term',
      paper: m.paper,
      mark: m.mark == null ? null : Number(m.mark),
      max_mark: Number(m.max_mark) || PAPER_MAX,
      target: m.target == null ? null : Number(m.target),
    };
  }

  /* ------------------------------------------------------------- saving - */

  function queueSave() {
    clearTimeout(S.saveTimer);
    S.saveTimer = setTimeout(async () => {
      try {
        await api('PUT', '/api/weeks', { weekId: weekId(), data: S.weeks[weekId()] || blankWeek() });
      } catch (err) {
        toast(err.message || 'Could not save that change.', 'err');
      }
    }, 450);
  }

  /* ========================================================== rendering = */

  function renderAll() {
    renderHeader();
    renderCountdown();
    renderStats();
    renderDailyBars();
    renderSubjectChart();
    renderSubjectSummary();
    renderMarksPage();
    renderTimetable();
    renderLegend();
    renderSettings();
  }

  /* With no subjects an account is brand new, so the dashboard and the
     timetable pages invite the student to add the subjects they take instead
     of showing an empty board. Only a website-style notice, never a wall. */
  function updateSubjectInviters() {
    const empty = !S.subjects.length;
    const dh = $('#dashEmpty');
    if (dh) dh.hidden = !empty;
    const tt = $('#ttEmpty');
    if (tt) tt.hidden = !empty;
  }

  function gotoSubjects() {
    switchTab('settings');
    setTimeout(() => { const f = $('#subNew'); if (f) f.focus(); }, 80);
  }

  function renderHeader() {
    const now = new Date();
    const isThis = S.weekOffset === 0;
    $('#weekRange').innerHTML = `${esc(weekRangeText(S.weekOffset))}<small>${isThis ? 'This week' : S.weekOffset > 0 ? `${S.weekOffset} week${S.weekOffset > 1 ? 's' : ''} ahead` : `${Math.abs(S.weekOffset)} week${Math.abs(S.weekOffset) > 1 ? 's' : ''} ago`}</small>`;

    if (S.user) {
      $('#whoName').textContent = S.settings.name || S.user.name || S.user.username;
      $('#whoExam').textContent = `A/L ${S.user.examYear}`;
      $('#avatar').textContent = (S.settings.name || S.user.name || 'S').trim().charAt(0).toUpperCase();
      /* the owner gets a way into the site settings, and nobody else does */
      const sec = $('#secAdmin');
      if (sec) sec.hidden = !S.user.isAdmin;
    }

    const wk = weekOf(weekId());
    const n = countSessions(wk);
    $('#copyWeekLabel').textContent = n ? `Copy Week (${n})` : 'Copy Week';
    $('#btnCopyWeek').disabled = n === 0;
    $('#btnClearWeek').disabled = n === 0;
    $('#btnClearWeek').title = n
      ? `Delete this week's plan (${n} session${n > 1 ? 's' : ''})`
      : 'This week has no plan to delete';
  }

  function renderCountdown() {
    const target = S.settings.examDate || defaultExamDate();
    const t = new Date(target + 'T00:00:00');
    $('#cdDate').textContent = Number.isNaN(t.getTime())
      ? 'Set your exam date in Settings'
      : `${MONTHS[t.getMonth()]} ${t.getDate()}, ${t.getFullYear()}`;

    const diff = Number.isNaN(t.getTime()) ? -1 : t.getTime() - new Date().setHours(0, 0, 0, 0);
    if (diff < 0) {
      $('#cdDays').textContent = '0'; $('#cdWeeks').textContent = '0'; $('#cdMonths').textContent = '0';
      return;
    }
    const days = Math.floor(diff / 86400000);
    $('#cdDays').textContent = days;
    $('#cdWeeks').textContent = Math.floor(days / 7);
    $('#cdMonths').textContent = Math.max(1, Math.round(days / 30.4375));
  }

  /** Per-day and per-subject numbers for the current week. */
  function weekStats() {
    const wk = weekOf(weekId());
    const perDay = DAYS.map((d) => {
      const list = (wk[d.key] || []).filter((t) => (t.type || 'study') === 'study');
      const done = list.filter((t) => t.done).length;
      return { total: list.length, done, pct: list.length ? Math.round(done / list.length * 100) : 0 };
    });
    const total = perDay.reduce((n, p) => n + p.total, 0);
    const done = perDay.reduce((n, p) => n + p.done, 0);
    /* only time actually spent studying - classes and "something else" blocks
       are not the hours a person wants hunched over their books */
    let minutes = 0;
    for (const d of DAYS) {
      for (const t of wk[d.key] || []) {
        if ((t.type || 'study') !== 'study') continue;
        const s = toMin(t.start), e = toMin(t.end);
        if (Number.isFinite(s) && Number.isFinite(e) && e > s) minutes += e - s;
      }
    }
    return { perDay, total, done, left: total - done, minutes, pct: total ? Math.round(done / total * 100) : 0 };
  }

  function subjectStats() {
    const wk = weekOf(weekId());
    return S.subjects.map((name) => {
      let sessions = 0, done = 0, minutes = 0;
      for (const d of DAYS) {
        for (const t of wk[d.key] || []) {
          if (t.subject !== name) continue;
          sessions += 1;
          if (t.done) done += 1;
          const s = toMin(t.start), e = toMin(t.end);
          if (Number.isFinite(s) && Number.isFinite(e) && e > s) minutes += e - s;
        }
      }
      return { name, sessions, done, minutes, pct: sessions ? Math.round(done / sessions * 100) : 0 };
    });
  }

  function renderStats() {
    const st = weekStats();
    $('#stPlanned').innerHTML = `${st.total}<small>sessions</small>`;
    $('#stPlannedSub').textContent = st.total ? `${fmtDur(st.minutes)} of study time planned` : 'Nothing planned yet';

    $('#stDone').innerHTML = `${st.done}<small>done</small>`;
    $('#stDoneSub').textContent = st.total ? `${st.pct}% of this week complete` : 'Nothing to complete yet';
    $('#stDoneBar').style.width = st.pct + '%';

    $('#stLeft').innerHTML = `${st.left}<small>left</small>`;
    $('#stLeftSub').textContent = st.left ? 'Sessions still to finish' : 'All caught up';

    $('#stTime').innerHTML = `${fmtDur(st.minutes).replace(' ', '<small> </small>')}<small> planned</small>`;
    $('#stTimeSub').textContent = st.total ? `Average ${fmtDur(st.total ? st.minutes / st.total : 0)} per session` : 'Add a session to start';
    $('#stTimeBar').style.width = Math.min(100, st.minutes / 600 * 100) + '%';
  }

  function renderDailyBars() {
    const st = weekStats();
    const today = todayISO();
    const html = st.perDay.map((p, i) => {
      const isToday = dateOfDay(i) === today;
      return `<div class="dbar${isToday ? ' today' : ''}" title="${esc(DAYS[i].label)}: ${p.done} of ${p.total} done">
        <div class="db-p">${p.total ? p.pct + '%' : '–'}</div>
        <div class="db-t"><div class="db-f${p.total ? '' : ' zero'}" style="height:${p.total ? Math.max(4, p.pct) : 2}%"></div></div>
        <div class="db-n">${DAYS[i].short}</div>
        <div class="db-c">${p.total ? p.done + '/' + p.total : '—'}</div>
      </div>`;
    }).join('');
    $('#dailyBars').innerHTML = html;
  }

  function renderSubjectChart() {
    const rows = subjectStats();
    const box = $('#subjChart');
    if (!rows.length) { box.innerHTML = '<div class="p-sub">No subjects yet.</div>'; return; }
    box.innerHTML = rows.map((r) => {
      const c = subjectColor(r.name);
      return `<div class="chart-row" title="${esc(r.name)}: ${r.done} of ${r.sessions} sessions done">
        <div class="cr-l"><i style="background:${c.s}"></i><span>${esc(r.name)}</span></div>
        <div class="cr-t"><div class="cr-f" style="width:${r.sessions ? r.pct : 0}%"></div></div>
        <div class="cr-v">${r.sessions ? r.pct + '<small>%</small>' : '<small>–</small>'}</div>
      </div>`;
    }).join('');
  }

  function renderSubjectSummary() {
    const rows = subjectStats();
    $('#subSummary').innerHTML = rows.map((r) => {
      const c = subjectColor(r.name);
      return `<div class="sub-card" style="--c:${c.s};--c-bg:${c.bg}">
        <div class="sc-t"><b>${esc(r.name)}</b></div>
        <div class="sc-v">${r.pct}<small>%</small></div>
        <div class="sc-s">${r.done}/${r.sessions} sessions · ${fmtDur(r.minutes)} planned</div>
      </div>`;
    }).join('');
  }

  /* ------------------------------------------------------ marks helpers - */

  const round2 = (n) => Math.round(n * 100) / 100;
  const scoreColor = (pct) => (pct >= 60 ? 'var(--ok)' : pct >= 40 ? '#b45309' : 'var(--danger)');

  function ensureTests(subject) {
    if (!subject) return [];
    if (!S.tests[subject] || !S.tests[subject].length) {
      S.tests[subject] = [
        { id: 't1', name: 'Term 1', kind: 'term' },
        { id: 't2', name: 'Term 2', kind: 'term' },
        { id: 't3', name: 'Term 3', kind: 'term' },
        { id: 't4', name: 'Final Exam', kind: 'exam' },
      ];
    }
    return S.tests[subject];
  }

  function currentTest() {
    const list = ensureTests(S.mkSubject);
    return list.find((t) => t.id === S.mkTest) || list[0];
  }

  const marksForTest = (subject, testId) => S.marks.filter((m) => m.subject === subject && m.testId === testId);

  /** add every marked paper up, so the test total and the subject total agree */
  function totalOf(rows) {
    let mark = 0, max = 0, papers = 0;
    for (const m of rows) {
      if (m.mark == null) continue;
      mark += m.mark;
      max += m.max_mark;
      papers += 1;
    }
    return { mark: round2(mark), max: round2(max), papers, pct: max > 0 ? Math.round((mark / max) * 100) : 0 };
  }

  const subjectTotal = (subject) => totalOf(S.marks.filter((m) => m.subject === subject));

  /* ------------------------------------------------------ marks toolbar - */

  function buildSubjectSelect() {
    const sel = $('#mkSubject');
    if (!S.subjects.length) {
      sel.innerHTML = '<option value="">No subjects yet</option>';
      S.mkSubject = null;
      sel.value = '';
      return;
    }
    sel.innerHTML = S.subjects.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
    if (!S.subjects.includes(S.mkSubject)) S.mkSubject = S.subjects[0];
    sel.value = S.mkSubject;
  }

  function buildTestSelect() {
    const sel = $('#mkTest');
    if (!S.mkSubject) {
      if (sel) sel.innerHTML = '<option value="">Add a subject first</option>';
      S.mkTest = null;
      $('#mkDelTest').disabled = true;
      return;
    }
    const list = ensureTests(S.mkSubject);
    const cur = currentTest();
    S.mkTest = cur.id;
    sel.innerHTML = list.map((t) => {
      const tot = totalOf(marksForTest(S.mkSubject, t.id));
      const tail = tot.papers ? ` \u00b7 ${tot.mark}/${tot.max} (${tot.pct}%)` : ' \u00b7 not marked';
      return `<option value="${esc(t.id)}">${esc(t.name + tail)}</option>`;
    }).join('');
    sel.value = cur.id;
    $('#mkDelTest').disabled = list.length <= 1;
  }

  function toggleNewTestRow(on, rename) {
    const row = $('#mkNewRow');
    const inp = $('#mkNewName');
    S.mkRenaming = !!(on && rename);
    if (!on) {
      row.hidden = true;
      inp.value = '';
      return;
    }
    row.hidden = false;
    inp.value = rename ? currentTest().name : '';
    inp.placeholder = rename ? 'Rename this test' : 'Test name, e.g. Unit 2 or Mock Exam';
    $('#mkNewSave').textContent = rename ? 'Save' : 'Add';
    inp.focus();
    inp.select();
  }

  async function saveTestRow() {
    const inp = $('#mkNewName');
    const name = inp.value.trim();
    if (!name) { inp.classList.add('bad'); inp.focus(); return; }
    const renaming = S.mkRenaming;
    const btn = $('#mkNewSave');
    btn.disabled = true;
    try {
      const body = { subject: S.mkSubject, name };
      if (renaming && currentTest()) body.id = currentTest().id;
      const res = await api('PUT', '/api/tests', body);
      S.tests[S.mkSubject] = res.tests || ensureTests(S.mkSubject);
      /* land on whatever was just added or renamed */
      S.mkTest = res.testId || (S.tests[S.mkSubject].some((t) => t.id === S.mkTest) ? S.mkTest : null);
      toggleNewTestRow(false);
      renderMarksPage();
      toast(renaming ? `Renamed to "${name}"` : `Added "${name}"`, 'ok');
    } catch (err) {
      toast(err.message || 'Could not save that test.', 'err');
    } finally {
      btn.disabled = false;
    }
  }

  async function deleteCurrentTest() {
    const t = currentTest();
    if (!t || ensureTests(S.mkSubject).length <= 1) {
      toast('A subject needs at least one test.', 'err');
      return;
    }
    if (!confirm(`Delete "${t.name}" and its marks?`)) return;
    try {
      const res = await api('DELETE', '/api/tests', { subject: S.mkSubject, id: t.id });
      S.tests[S.mkSubject] = res.tests || [];
      S.marks = S.marks.filter((m) => !(m.subject === S.mkSubject && m.testId === t.id));
      S.mkTest = null;
      renderMarksPage();
      toast(`Deleted "${t.name}"`, 'ok');
    } catch (err) {
      toast(err.message || 'Could not delete that test.', 'err');
    }
  }

  /* ------------------------------------------------------ marks editor - */

  function renderMarksEditor() {
    if (!S.mkSubject) buildSubjectSelect();
    const test = currentTest();
    if (!test || !S.mkSubject) { $('#mkEditor').innerHTML = ''; return; }
    const existing = marksForTest(S.mkSubject, test.id);
    const c = subjectColor(S.mkSubject);

    const rows = PAPERS.map((p) => {
      const found = existing.find((m) => m.paper === p.p);
      const mark = found ? found.mark : null;
      const maxMark = found && found.max_mark ? found.max_mark : PAPER_MAX;
      const pct = mark == null || !maxMark ? 0 : Math.min(100, Math.round((mark / maxMark) * 100));
      return `<tr>
        <td class="mk-subj"><span class="dot-c" style="background:${c.s}"></span>Paper ${esc(p.p)}</td>
        <td style="width:118px">
          <input class="mk-in" type="number" min="0" step="any" placeholder="\u2013" value="${mark == null ? '' : mark}"
                 data-paper="${esc(p.p)}" aria-label="Marks for paper ${esc(p.p)}">
        </td>
        <td style="width:96px">
          <input class="mk-max" type="number" min="1" step="any" value="${maxMark}"
                 data-paper="${esc(p.p)}" aria-label="Out of marks for paper ${esc(p.p)}">
        </td>
        <td class="mk-pct" id="pct-${esc(p.p)}">${mark == null ? '\u2013' : pct + '%'}</td>
        <td class="mk-bar"><div><i id="bar-${esc(p.p)}" style="width:${pct}%;background:${c.s}"></i></div></td>
      </tr>`;
    }).join('');

    $('#mkEditor').innerHTML = `
      <div class="mk-wrap">
        <table class="mk-table">
          <thead><tr>
            <th>Paper</th><th>Your mark</th><th>Out of</th><th>Score</th><th>Progress</th>
          </tr></thead>
          <tbody>${rows}</tbody>
          <tfoot><tr>
            <td>${esc(test.name)} total</td>
            <td colspan="2" id="mkCounted">&mdash;</td>
            <td class="mk-pct" id="mkAvg">&ndash;</td>
            <td class="mk-bar"><div><i id="mkAvgBar" style="width:0%;background:${c.s}"></i></div></td>
          </tr></tfoot>
        </table>
      </div>
      <div class="notice info" style="margin-top:14px">
        <span class="ni"></span>
        <span>Every paper starts at out of ${PAPER_MAX}. Change the "Out of" value for any paper, and everything is saved as you type.</span>
      </div>`;

    $$('.mk-in', $('#mkEditor')).forEach((inp) => {
      inp.addEventListener('input', () => { livePct(inp); updateEditorFooter(); queueMarkSave(); });
      inp.addEventListener('blur', () => commitMark(inp));
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } });
    });
    $$('.mk-max', $('#mkEditor')).forEach((inp) => {
      inp.addEventListener('input', () => { updateEditorFooter(); });
      inp.addEventListener('change', () => { updateEditorFooter(); commitMark(inp, true); });
    });

    updateEditorFooter();
  }

  /** Recompute the "n of m marked" and the test total straight from the inputs. */
  function updateEditorFooter() {
    let mark = 0, max = 0, marked = 0;
    for (const p of PAPERS) {
      const markInp = $(`.mk-in[data-paper="${p.p}"]`, $('#mkEditor'));
      const maxInp = $(`.mk-max[data-paper="${p.p}"]`, $('#mkEditor'));
      if (!markInp) continue;
      const maxMark = Number(maxInp && maxInp.value) || 0;
      const raw = markInp.value;
      if (raw === '') continue;
      const v = Number(raw);
      if (!Number.isFinite(v) || v < 0 || (maxMark > 0 && v > maxMark)) continue;
      marked += 1;
      mark += v;
      max += maxMark;
    }
    const pct = max > 0 ? Math.round((mark / max) * 100) : 0;
    const counted = $('#mkCounted');
    const avgEl = $('#mkAvg');
    const barEl = $('#mkAvgBar');
    if (counted) counted.textContent = `${marked} of ${PAPERS.length} papers \u00b7 ${round2(mark)}/${round2(max)}`;
    if (avgEl) { avgEl.textContent = marked ? pct + '%' : '\u2013'; avgEl.style.color = marked ? scoreColor(pct) : ''; }
    if (barEl) {
      barEl.style.width = pct + '%';
      barEl.style.background = marked ? subjectColor(S.mkSubject).s : 'transparent';
    }
  }

  function livePct(inp) {
    const paper = inp.dataset.paper;
    const maxInp = $(`.mk-max[data-paper="${paper}"]`, $('#mkEditor'));
    const maxMark = Number(maxInp && maxInp.value) || 0;
    const v = inp.value === '' ? null : Number(inp.value);
    const bad = v != null && (Number.isNaN(v) || v < 0 || (maxMark > 0 && v > maxMark));
    inp.classList.toggle('bad', !!bad);
    const pct = bad || v == null || !maxMark ? 0 : Math.min(100, Math.round((v / maxMark) * 100));
    const pctEl = $(`#pct-${CSS.escape(paper)}`);
    const barEl = $(`#bar-${CSS.escape(paper)}`);
    if (pctEl) {
      pctEl.textContent = v == null ? '\u2013' : bad ? 'over max' : pct + '%';
      pctEl.style.color = v == null || bad ? '' : scoreColor(pct);
    }
    if (barEl) {
      const c = subjectColor(S.mkSubject);
      barEl.style.width = pct + '%';
      barEl.style.background = bad ? 'var(--danger)' : c.s;
    }
    if (bad) inp.setAttribute('title', `Maximum is ${maxMark}`);
    else inp.removeAttribute('title');
  }

  let markTimer = null;
  function queueMarkSave() {
    clearTimeout(markTimer);
    markTimer = setTimeout(() => {
      $$('.mk-in', $('#mkEditor')).forEach((i) => commitMark(i, true, true));
    }, 700);
  }

  async function commitMark(input, isMax, quiet) {
    const test = currentTest();
    if (!test) return;
    const paper = input.dataset.paper;
    const markInp = $(`.mk-in[data-paper="${paper}"]`, $('#mkEditor'));
    const maxInp = $(`.mk-max[data-paper="${paper}"]`, $('#mkEditor'));
    const maxMark = Number(maxInp && maxInp.value) || PAPER_MAX;
    const raw = markInp ? markInp.value : '';
    const mark = raw === '' ? null : Number(raw);

    if (mark != null && (!Number.isFinite(mark) || mark < 0)) {
      if (!quiet) toast('Marks must be a positive number.', 'err');
      if (markInp) markInp.classList.add('bad');
      return;
    }
    if (mark != null && mark > maxMark) {
      if (!quiet) toast(`Paper ${paper} is out of ${maxMark}. Raise the "Out of" value first.`, 'err');
      if (markInp) markInp.classList.add('bad');
      return;
    }

    const existing = S.marks.find((m) => m.subject === S.mkSubject && m.testId === test.id && m.paper === paper);
    const row = {
      subject: S.mkSubject,
      testId: test.id,
      testName: test.name,
      kind: test.kind,
      paper,
      mark,
      max_mark: maxMark,
      target: maxMark,
    };
    if (existing) Object.assign(existing, row);
    else S.marks.push(row);

    try {
      await api('POST', '/api/marks/bulk', {
        subject: S.mkSubject,
        testId: test.id,
        testName: test.name,
        kind: test.kind,
        values: [{ paper, mark, max_mark: maxMark }],
      });
      if (markInp) markInp.classList.remove('bad');
      if (!quiet && !isMax) toast(`Paper ${paper} saved`, 'ok');
      renderMarksChart();
      renderMarksOverall();
      renderMarksAll();
      renderDashboardMarksChart();
      buildTestSelect();
    } catch (err) {
      toast(err.message || 'Could not save that mark.', 'err');
    }
  }

  /* ------------------------------------------------------ marks summary - */

  function renderMarksChart() {
    const test = currentTest();
    if (!test || !S.mkSubject) { $('#mkChart').innerHTML = ''; return; }
    const box = $('#mkChart');
    const rows = PAPERS.map((p) => marksForTest(S.mkSubject, test.id).find((m) => m.paper === p.p)).filter(Boolean);

    if (!rows.length || !rows.some((m) => m.mark != null)) {
      box.innerHTML = `<div class="mk-empty" style="padding:26px">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>
        <div class="p-sub">No marks entered for ${esc(S.mkSubject)} \u00b7 ${esc(test.name)} yet. Type a mark above and the bar appears here.</div>
      </div>`;
      return;
    }

    const c = subjectColor(S.mkSubject);
    box.innerHTML = rows.map((m) => {
      const pct = m.mark == null || !m.max_mark ? 0 : Math.min(100, Math.round((m.mark / m.max_mark) * 100));
      const below = m.mark == null ? false : m.mark < (m.target != null ? m.target : m.max_mark);
      return `<div class="chart-row">
        <div class="cr-l"><i style="background:${c.s}"></i><span>Paper ${esc(m.paper)}</span></div>
        <div class="cr-t"><div class="cr-f${below ? ' over' : ''}" style="width:${pct}%"></div></div>
        <div class="cr-v">${m.mark == null ? '<small>\u2013</small>' : pct + '<small>%</small>'}</div>
      </div>`;
    }).join('') + `<div class="p-sub" style="margin-top:4px">Target: ${esc(S.mkSubject)} papers should reach 100% of their maximum.</div>`;
  }

  /** every test of this subject added up into one overall score */
  function renderMarksOverall() {
    const box = $('#mkOverall');
    const list = ensureTests(S.mkSubject);
    const c = subjectColor(S.mkSubject);
    const grand = subjectTotal(S.mkSubject);

    const rows = list.map((t) => {
      const tot = totalOf(marksForTest(S.mkSubject, t.id));
      const on = t.id === (currentTest() || {}).id;
      return `<tr class="${on ? 'mk-current' : ''}">
        <td class="mk-subj">
          <span class="dot-c" style="background:${c.s}"></span>${esc(t.name)}
          ${t.kind === 'exam' ? '<span class="mk-tag">exam</span>' : ''}
        </td>
        <td style="text-align:center;color:var(--muted)">${tot.papers} of ${PAPERS.length}</td>
        <td style="text-align:center;font-weight:800;font-variant-numeric:tabular-nums">${tot.papers ? tot.mark : '\u2013'}</td>
        <td style="text-align:center;color:var(--muted)">${tot.papers ? tot.max : '\u2013'}</td>
        <td class="mk-pct" style="color:${tot.papers ? scoreColor(tot.pct) : 'var(--muted)'}">${tot.papers ? tot.pct + '%' : '\u2013'}</td>
        <td class="mk-bar"><div><i style="width:${tot.pct}%;background:${c.s}"></i></div></td>
      </tr>`;
    }).join('');

    box.innerHTML = `<div class="mk-wrap">
      <table class="mk-table mk-overall">
        <thead><tr>
          <th>Test</th><th style="text-align:center">Papers</th><th style="text-align:center">Total</th>
          <th style="text-align:center">Out of</th><th>Score</th><th>Progress</th>
        </tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr>
          <td>Overall for ${esc(S.mkSubject)}</td>
          <td style="text-align:center">${list.length}</td>
          <td style="text-align:center">${grand.papers ? grand.mark : '\u2013'}</td>
          <td style="text-align:center">${grand.papers ? grand.max : '\u2013'}</td>
          <td class="mk-pct" id="mkOverallPct" style="color:${grand.papers ? scoreColor(grand.pct) : 'var(--muted)'}">${grand.papers ? grand.pct + '%' : '\u2013'}</td>
          <td class="mk-bar"><div><i style="width:${grand.pct}%;background:${c.s}"></i></div></td>
        </tr></tfoot>
      </table>
    </div>
    <div class="p-sub" style="margin-top:9px">Add another test with the <strong>Add test</strong> button above whenever you sit a new one.</div>`;
  }

  function renderMarksAll() {
    const box = $('#mkAll');
    if (!S.marks.length) {
      box.innerHTML = `<div class="mk-empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v16H4z"/><path d="M8 9h8M8 13h5"/></svg>
        <h3>No marks yet</h3>
        <p>Pick a subject above, add the tests you have sat, and enter your marks. Everything is added up into a subject total.</p>
      </div>`;
      return;
    }

    const groups = S.subjects.filter((s) => S.marks.some((m) => m.subject === s)).map((subject) => {
      const c = subjectColor(subject);
      const grand = subjectTotal(subject);
      const tests = ensureTests(subject).filter((t) => S.marks.some((m) => m.subject === subject && m.testId === t.id));

      const trs = tests.map((t) => {
        const rows = marksForTest(subject, t.id).slice().sort((a, b) => a.paper.localeCompare(b.paper));
        const tot = totalOf(rows);
        const head = `<tr class="mk-test"><td colspan="5"><span class="dot-c" style="background:${c.s}"></span>${esc(t.name)} \u00b7 ${tot.papers ? `${tot.mark}/${tot.max} \u00b7 ${tot.pct}%` : 'no marks yet'}</td></tr>`;
        const body = rows.map((m) => {
          const pct = m.mark == null || !m.max_mark ? null : Math.min(100, Math.round((m.mark / m.max_mark) * 100));
          return `<tr>
            <td class="mk-subj" style="padding-left:30px">Paper ${esc(m.paper)}</td>
            <td style="text-align:center;font-weight:800;font-variant-numeric:tabular-nums">${m.mark == null ? '\u2013' : m.mark}</td>
            <td style="text-align:center;color:var(--muted)">${m.max_mark}</td>
            <td class="mk-pct" style="color:${pct == null ? 'var(--muted)' : scoreColor(pct)}">${pct == null ? '\u2013' : pct + '%'}</td>
            <td class="mk-bar"><div><i style="width:${pct || 0}%;background:${c.s}"></i></div></td>
          </tr>`;
        }).join('');
        return head + body;
      }).join('');

      const foot = `<tr class="mk-total">
        <td>${esc(subject)} total</td>
        <td style="text-align:center">${grand.papers ? grand.mark : '\u2013'}</td>
        <td style="text-align:center">${grand.papers ? grand.max : '\u2013'}</td>
        <td class="mk-pct" style="color:${grand.papers ? scoreColor(grand.pct) : 'var(--muted)'}">${grand.papers ? grand.pct + '%' : '\u2013'}</td>
        <td class="mk-bar"><div><i style="width:${grand.pct}%;background:${c.s}"></i></div></td>
      </tr>`;

      return `<tr class="mk-group"><td colspan="5"><span class="dot-c" style="background:${c.s}"></span>${esc(subject)}</td></tr>${trs}${foot}`;
    }).join('');

    box.innerHTML = `<table class="mk-table">
      <thead><tr><th>Paper</th><th style="text-align:center">Mark</th><th style="text-align:center">Out of</th><th>Score</th><th>Progress</th></tr></thead>
      <tbody>${groups}</tbody>
    </table>`;
  }

  function renderDashboardMarksChart() {
    const box = $('#marksChart');
    const names = S.subjects.filter((s) => subjectTotal(s).papers > 0);
    if (!names.length) {
      box.innerHTML = '<div class="p-sub">No marks entered yet. Add them in the Marks tab and your subject totals will appear here.</div>';
      return;
    }
    box.innerHTML = names.map((name) => {
      const tot = subjectTotal(name);
      const c = subjectColor(name);
      return `<div class="chart-row" title="${esc(name)}: ${tot.papers} paper(s), ${tot.pct}% overall">
        <div class="cr-l"><i style="background:${c.s}"></i><span>${esc(name)}</span></div>
        <div class="cr-t"><div class="cr-f${tot.pct < 50 ? ' over' : ''}" style="width:${tot.pct}%"></div></div>
        <div class="cr-v">${tot.pct}<small>%</small></div>
      </div>`;
    }).join('');
  }

  /** marks page = subject picker + test picker + editor + overall + chart + all */
  function renderMarksPage() {
    /* A brand-new account has no subjects yet, so the marks board shows a
       plain invitation instead of breaking on an empty subject list. */
    if (!S.subjects.length) {
      buildSubjectSelect();
      $('#mkTest').innerHTML = '<option value="">No subjects yet</option>';
      $('#mkDelTest').disabled = true;
      $('#mkEditor').innerHTML = `<div class="mk-empty" style="padding:30px">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>
        <div class="p-sub">Nothing to mark yet. Add the subjects you actually study in Settings and they\u2019ll appear here.</div>
        <button class="btn primary sm" id="mkEmptyGo" style="margin-top:14px">Add subjects</button>
      </div>`;
      $('#mkOverall').innerHTML = '';
      $('#mkChart').innerHTML = '';
      $('#mkAll').innerHTML = '';
      const go = $('#mkEmptyGo');
      if (go) go.addEventListener('click', () => { switchTab('settings'); setTimeout(() => { const f = $('#subNew'); if (f) f.focus(); }, 80); });
      return;
    }
    buildSubjectSelect();
    buildTestSelect();
    renderMarksEditor();
    renderMarksOverall();
    renderMarksChart();
    renderMarksAll();
  }

  /* ========================================================== timetable = */

  function renderLegend() {
    $('#ttLegend').innerHTML = S.subjects
      .map((s) => `<span class="lg"><i style="background:${subjectColor(s).s}"></i>${esc(s)}</span>`)
      .join('');
  }

  function layoutDay(tasks) {
    const evs = tasks
      .map((t, i) => ({ t, i, s: toMin(t.start), e: toMin(t.end) }))
      .filter((e) => Number.isFinite(e.s) && Number.isFinite(e.e) && e.e > e.s)
      .sort((a, b) => a.s - b.s || a.e - b.e);

    // group overlapping events, then give each group its own lanes
    const out = [];
    let group = [];
    let groupEnd = -1;
    for (const ev of evs) {
      if (group.length && ev.s >= groupEnd) { commitGroup(group, out); group = []; groupEnd = -1; }
      group.push(ev);
      groupEnd = Math.max(groupEnd, ev.e);
    }
    commitGroup(group, out);
    return out;

    function commitGroup(g, sink) {
      const laneEnds = [];
      const assigned = g.map((ev) => {
        let lane = laneEnds.findIndex((end) => ev.s >= end);
        if (lane === -1) { lane = laneEnds.length; laneEnds.push(ev.e); }
        else laneEnds[lane] = ev.e;
        return { ev, lane };
      });
      const nLanes = Math.max(1, laneEnds.length);
      for (const a of assigned) sink.push({ idx: a.ev.i, lane: a.lane, nLanes });
    }
  }

  function passesFilter(t) {
    if (S.ttFilter === 'all') return true;
    return (t.type || 'study') === S.ttFilter;
  }

  function renderTimetable() {
    const grid = $('#ttGrid');
    const wk = weekOf(weekId());
    const today = todayISO();

    let head = '<div class="tt-corner">Time</div>';
    for (let i = 0; i < DAYS.length; i++) {
      const d = DAYS[i];
      const all = wk[d.key] || [];
      const cnt = all.filter((t) => (t.type || 'study') === 'study');
      const done = cnt.filter((t) => t.done).length;
      const pct = cnt.length ? Math.round(done / cnt.length * 100) : 0;
      const iso = dateOfDay(i).split('-');
      const isToday = dateOfDay(i) === today;
      head += `<div class="tt-dhead${isToday ? ' today' : ''}">
        <button class="dh-add" data-add="${d.key}" title="Add a session on ${esc(d.label)}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
        </button>
        <div class="dh-n">${esc(d.label)}${isToday ? '<span class="today-tag">TODAY</span>' : ''}</div>
        <div class="dh-d">${MONTHS[Number(iso[1]) - 1].slice(0, 3)} ${Number(iso[2])}</div>
        <div class="dh-p">
          <span>${cnt.length ? done + '/' + cnt.length : '–'}</span>
          <div class="dh-m"><i style="width:${pct}%"></i></div>
          <span>${cnt.length ? pct + '%' : ''}</span>
        </div>
      </div>`;
    }

    let axis = '';
    for (let s = 0; s < SLOTS; s++) {
      const m = GRID_START + s * SLOT;
      const isHour = m % 60 === 0;
      axis += `<div class="slot${isHour ? '' : ' half'}">${isHour ? fmtTime(m).replace(':00', '') : '&nbsp;'}</div>`;
    }

    let body = '';
    for (let c = 0; c < DAYS.length; c++) {
      const d = DAYS[c];
      const tasks = (wk[d.key] || []).filter(passesFilter);
      const isToday = dateOfDay(c) === today;

      let lines = '';
      for (let s = 0; s < SLOTS; s++) {
        const m = GRID_START + s * SLOT;
        const isHour = m % 60 === 0;
        lines += `<div class="tt-grid-line${isHour ? '' : ' half'}" style="top:${s * ROW_H}px"></div>`;
      }

      let blocks = tasks.length ? '' : '<div class="tt-empty">No sessions</div>';
      if (tasks.length) {
        for (const lt of layoutDay(tasks)) {
          const t = tasks[lt.idx];
          const s = toMin(t.start), e = toMin(t.end);
          const top = ((s - GRID_START) / SLOT) * ROW_H;
          const h = Math.max(((e - s) / SLOT) * ROW_H - 2, 20);
          const width = 100 / lt.nLanes;
          const col = subjectColor(t.subject);
          const type = t.type || 'study';
          const kind = type === 'class' ? 'class' : type === 'other' ? 'other' : 'study';
          const kindLabel = type === 'class' ? 'CLASS' : type === 'other' ? 'OTHER' : 'STUDY';

          blocks += `<div class="tsk ${kind}${t.done ? ' done' : ''}"
            style="top:${top}px;height:${h}px;left:calc(${lt.lane * width}% + 2px);width:calc(${width}% - 4px);--c:${col.s};--c-bg:${col.bg};--c-ink:${col.ink}"
            data-day="${d.key}" data-id="${esc(t.id)}" title="Click to edit">
            <div class="tk-h">
              <button class="tk-chk${t.done ? ' on' : ''}" data-toggle="${esc(t.id)}" data-day="${d.key}" title="Mark complete">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
              </button>
              <span class="tk-s">${esc(t.subject)}</span>
            </div>
            <span class="tk-t">${esc(fmtTime(s))} – ${esc(fmtTime(e))}</span>
            ${t.task && h > 46 ? `<span class="tk-x">${esc(t.task)}</span>` : ''}
            <span class="tk-k">${kindLabel}</span>
            <button class="tk-del" data-del="${esc(t.id)}" data-day="${d.key}" title="Delete">&times;</button>
          </div>`;
        }
      }

      let now = '';
      if (isToday) {
        const n = new Date();
        const nowMin = n.getHours() * 60 + n.getMinutes();
        if (nowMin >= GRID_START && nowMin <= GRID_END) {
          now = `<div class="tt-now" style="top:${((nowMin - GRID_START) / SLOT) * ROW_H}px"></div>`;
        }
      }

      body += `<div class="tt-col${c === DAYS.length - 1 ? ' last' : ''}${isToday ? ' today' : ''}" data-col="${d.key}">${lines}${blocks}${now}</div>`;
    }

    grid.innerHTML = head
      + `<div class="tt-axis" style="grid-row:2">${axis}</div>`
      + `<div style="display:contents;grid-row:2">${body}</div>`;

    // the axis and columns share grid-row 2
    $$('.tt-col', grid).forEach((n) => { n.style.gridRow = '2'; n.style.gridColumn = String(DAYS.findIndex((d) => d.key === n.dataset.col) + 2); });
  }

  /* --------------------------------------------------------- task modal - */

  function ensureWeek() {
    const id = weekId();
    if (!S.weeks[id]) S.weeks[id] = blankWeek();
    return S.weeks[id];
  }

  function fillSubjectSelect(selected) {
    const sel = $('#tSubject');
    const list = S.subjects.slice();
    if (selected && !list.includes(selected)) list.push(selected);
    sel.innerHTML = list.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
    if (selected) sel.value = selected;
  }

  function openTask(day, id) {
    if (!S.subjects.length) {
      toast('Add a subject in Settings first, then plan a session.', 'err');
      return;
    }
    S.editDay = day;
    S.editId = id || null;
    setNotice($('#taskNotice'), null, null);

    const list = dayTasks(weekId(), day);
    const t = id ? list.find((x) => x.id === id) : null;

    $('#taskTitle').textContent = t ? 'Edit session' : 'Add a session';
    $('#taskHint').textContent = t ? 'Change anything you like, then save.' : 'Only the subject and time are needed.';

    const dsel = $('#tDay');
    if (!dsel.options.length) dsel.innerHTML = DAYS.map((d) => `<option value="${d.key}">${esc(d.label)}</option>`).join('');
    dsel.value = day;

    $('#tType').value = t ? (t.type || 'study') : 'study';
    $('#tOtherWrap').style.display = $('#tType').value === 'other' ? '' : 'none';
    $('#tOther').value = t && (t.type === 'other') ? t.subject : '';
    fillSubjectSelect(t ? t.subject : S.subjects[0]);
    $('#tTask').value = t ? (t.task || '') : '';
    $('#tStart').value = t ? t.start : '17:00';
    $('#tEnd').value = t ? t.end : '18:30';

    $('#taskOverlay').classList.add('show');
    setTimeout(() => $('#tStart').focus(), 60);
  }

  function closeTask() {
    $('#taskOverlay').classList.remove('show');
    S.editId = null;
  }

  function saveTask() {
    const day = $('#tDay').value;
    const type = $('#tType').value;
    const start = $('#tStart').value;
    const end = $('#tEnd').value;

    if (!start || !end) { setNotice($('#taskNotice'), 'error', 'Please choose a start and end time.'); return; }
    const s = toMin(start), e = toMin(end);
    if (e <= s) { setNotice($('#taskNotice'), 'error', 'The end time must be after the start time.'); return; }

    let subject;
    if (type === 'other') {
      subject = $('#tOther').value.trim();
      if (!subject) { setNotice($('#taskNotice'), 'error', 'Please say what this is.'); return; }
    } else {
      subject = $('#tSubject').value;
    }

    const wk = ensureWeek();
    const list = wk[day] || (wk[day] = []);
    const task = {
      id: S.editId || ('t' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
      subject, type,
      task: $('#tTask').value.trim(),
      start, end,
      done: false,
    };

    const i = list.findIndex((x) => x.id === task.id);
    if (i >= 0) task.done = list[i].done;
    if (i >= 0) list[i] = task; else list.push(task);

    closeTask();
    queueSave();
    renderAll();
    toast(i >= 0 ? 'Session updated' : 'Session added', 'ok');
  }

  /* ------------------------------------------------------- copy a week - */

  const COPY_CHOICES = [
    { off: 1, label: 'Next week' },
    { off: 2, label: 'In 2 weeks' },
    { off: 3, label: 'In 3 weeks' },
    { off: 4, label: 'In 4 weeks' },
    { off: 5, label: 'In 5 weeks' },
    { off: 6, label: 'In 6 weeks' },
    { off: 8, label: 'In 8 weeks' },
    { off: -1, label: 'Last week' },
  ];

  function openCopy() {
    const from = weekId();
    const n = countSessions(weekOf(from));
    if (!n) { toast('This week is empty, so there is nothing to copy.', 'err'); return; }

    S.copyTarget = null;
    S.copyMode = 'copy';
    $('#copyFrom').textContent = `${weekRangeText(S.weekOffset)} — ${n} session${n > 1 ? 's' : ''}`;
    $('#copyHint').textContent = 'Next week is already selected. Change it if you want a different week. Sessions copy as fresh tasks, without their done ticks.';
    setNotice($('#copyNotice'), null, null);
    $$('.radio-card', $('#copyOverlay')).forEach((r) => r.classList.toggle('sel', r.dataset.mode === 'copy'));

    const box = $('#copyTargets');
    box.innerHTML = COPY_CHOICES.map((c) => {
      const id = toISO(mondayOf(S.weekOffset + c.off));
      const have = countSessions(weekOf(id));
      return `<button type="button" class="week-option${c.off === 1 ? ' sel' : ''}" data-off="${c.off}" data-id="${id}">
        <div class="wo-t">${esc(c.label)}</div>
        <div class="wo-s">${esc(weekRangeText(S.weekOffset + c.off))}</div>
        <span class="wo-c ${have ? 'full' : 'empty'}">${have ? `${have} session${have > 1 ? 's' : ''} already` : 'Empty'}</span>
      </button>`;
    }).join('');

    /* next week is the default, so the common case is one click */
    const nextBtn = $('.week-option[data-off="1"]', box);
    if (nextBtn) {
      S.copyTarget = { off: 1, id: toISO(mondayOf(S.weekOffset + 1)) };
      $('#copyGo').disabled = false;
    } else {
      $('#copyGo').disabled = true;
    }
    $('#copyGo').textContent = 'Copy week';
    $('#copyOverlay').classList.add('show');
  }

  async function doCopy() {
    if (!S.copyTarget) return;
    const btn = $('#copyGo');
    busy(btn, true, S.copyMode === 'move' ? 'Moving' : 'Copying');
    try {
      const needsOverwrite = countSessions(weekOf(S.copyTarget.id)) > 0;
      await api('POST', '/api/weeks/copy', {
        from: weekId(), to: S.copyTarget.id, mode: S.copyMode, overwrite: !!needsOverwrite,
      });
      await refreshWeeks();
      $('#copyOverlay').classList.remove('show');
      renderAll();
      toast(S.copyMode === 'move' ? 'Week moved' : 'Week copied', 'ok');
    } catch (err) {
      setNotice($('#copyNotice'), 'error', err.message);
    } finally {
      busy(btn, false);
      $('#copyGo').disabled = !S.copyTarget;
    }
  }

  async function refreshWeeks() {
    const wk = await api('GET', '/api/weeks');
    S.weeks = wk.weeks || {};
  }

  /** throw away the plan for the week on screen, the whole thing */
  async function clearWeek() {
    const id = weekId();
    const n = countSessions(weekOf(id));
    if (!n) { toast('This week is already empty.', 'err'); return; }
    if (!confirm(`Delete this week's plan?\n\n${n} session${n > 1 ? 's' : ''} will be removed from ${weekRangeText(S.weekOffset)}. This cannot be undone.`)) return;
    try {
      const r = await api('DELETE', '/api/weeks', { weekId: id });
      delete S.weeks[id];
      renderAll();
      toast(r.removed ? `${r.removed} session${r.removed > 1 ? 's' : ''} deleted` : 'Week cleared', 'ok');
    } catch (err) {
      toast(err.message || 'Could not delete this week.', 'err');
    }
  }

  /* =========================================================== settings = */

  function renderSettings() {
    $('#setName').value = S.settings.name || S.user.name || '';
    $('#setUsername').value = S.user.username;
    $('#setEmail').value = S.user.email;
    $('#setExamYear').value = S.user.examYear;
    $('#setExamDate').value = S.settings.examDate || defaultExamDate();

    renderSubEditor();
    loadSessions();
    loadEvents();
    loadSync();
  }

  function renderSubEditor() {
    $('#subEditor').innerHTML = S.subjects.map((s, i) => {
      const c = subjectColor(i);
      return `<span class="sub-chip" style="--c-bg:${c.bg}"><i style="background:${c.s}"></i>${esc(s)}
        <button data-rm="${esc(s)}" title="Remove ${esc(s)}" ${S.subjects.length <= 1 ? 'disabled' : ''}>&times;</button>
      </span>`;
    }).join('');
    renderSubSiteBox();
  }

  /* The owner picks the subjects a new account starts with, so somebody who
     has been handed a list meant for a different stream needs a way back to
     the one the site is actually about. The button only appears when this
     account has been changed away from that list, so it cannot be used to
     throw work away by accident. */
  function renderSubSiteBox() {
    const box = $('#subSiteBox');
    if (!box) return;
    const site = S.siteSubjects || [];
    if (!site.length) { box.hidden = true; return; }

    const same = site.length === S.subjects.length
      && site.every((s, i) => s.toLowerCase() === String(S.subjects[i]).toLowerCase());
    if (same) { box.hidden = true; return; }

    const extra = S.subjects.filter((s) => !site.some((x) => x.toLowerCase() === s.toLowerCase()));
    const missing = site.filter((s) => !S.subjects.some((x) => x.toLowerCase() === s.toLowerCase()));

    const bits = [];
    if (missing.length) bits.push(`Missing: ${missing.join(', ')}.`);
    if (extra.length) bits.push(`Only on your account: ${extra.join(', ')}.`);
    $('#subSiteNote').textContent =
      `The site is set up for ${site.join(', ')}. ${bits.join(' ')}`.trim();
    box.hidden = false;
  }

  async function useSiteSubjects() {
    const site = S.siteSubjects || [];
    if (!site.length) return;
    const dropped = S.subjects.filter((s) => !site.some((x) => x.toLowerCase() === s.toLowerCase()));
    const marked = dropped.filter((s) => S.marks.some((m) => m.subject === s));

    const lines = [`Replace your subjects with the site's list: ${site.join(', ')}?`];
    if (marked.length) {
      lines.push(`Marks you have for ${marked.join(', ')} will stop showing until that subject is added back. Nothing is deleted.`);
    }
    if (!confirm(lines.join('\n\n'))) return;

    try {
      const r = await api('POST', '/api/subjects/site-defaults');
      S.subjects = (r.subjects && r.subjects.length ? r.subjects : site).slice();
      S.siteSubjects = site.slice();
      /* the tests for each subject were rebuilt on the server, so the local
         copy of them is stale and has to be read again */
      const mk = await api('GET', '/api/marks');
      S.tests = mk.tests || {};
      for (const s of S.subjects) {
        S.tests[s] = S.tests[s] && S.tests[s].length ? S.tests[s] : [];
      }
      if (!S.subjects.includes(S.mkSubject)) { S.mkSubject = S.subjects[0]; S.mkTest = null; }
      buildSubjectSelect();
      renderSubEditor();
      renderLegend();
      renderTimetable();
      renderSubjectChart();
      renderSubjectSummary();
      renderMarksPage();
      renderDashboardMarksChart();
      toast('Subjects reset to the site list', 'ok');
    } catch (err) {
      toast((err && err.message) || 'The subjects could not be changed.', 'err');
    }
  }

  /** Where the account is kept, and a way to push it by hand. */
  const SYNC_WORDS = {
    local: ['This device only', 'Add a Firebase project in js/sync-config.js to carry this account to another device. Until then a backup is the only way to move it.'],
    connecting: ['Connecting to the cloud', 'Getting in touch with the cloud so this account can be copied up.'],
    pending: ['Saved here, not copied yet', 'Your changes are safe in this browser and will be sent up as soon as the connection comes back.'],
    offline: ['Offline, saved here', 'There is no connection right now, so nothing has gone up yet. It retries by itself.'],
    error: ['Cloud copy failed', 'The last copy did not get through. Your work is still saved in this browser, and you can try again below.'],
    synced: ['Cloud copy on', 'Your account, weeks and marks are kept on the cloud, so signing in with the same email and password on another device shows the same timetable and marks.'],
  };

  const syncWhen = (iso, linked) => {
    if (!iso) return linked ? 'In step with the cloud' : 'Not copied up yet';
    const secs = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (secs < 45) return 'Copied up just now';
    if (secs < 5400) return `Copied up ${Math.round(secs / 60)} min ago`;
    return `Copied up ${new Date(iso).toLocaleString()}`;
  };

  function paintSync(st) {
    const mode = st.mode || 'local';
    const state = st.pending ? (st.state === 'error' ? 'error' : 'pending') : (st.state || mode);
    const words = SYNC_WORDS[state] || SYNC_WORDS[mode] || SYNC_WORDS.local;
    const pill = $('#syncPill');
    if (pill) {
      pill.hidden = state === 'synced' || state === 'local';
      pill.dataset.state = state;
      pill.title = `${words[0]}. ${st.detail || words[1]}`;
      const txt = pill.querySelector('.sp-text');
      if (txt) txt.textContent = state === 'pending' ? 'Not copied yet' : state === 'error' ? 'Cloud problem' : words[0];
    }

    const box = $('#syncBox');
    if (!box) return;
    const about = $('#syncAbout');
    if (about) about.hidden = true;
    box.innerHTML = `
      <div class="sb-row">
        <span class="sb-name">${esc(words[0])}</span>
        <button class="btn soft xs" id="syncNow" ${mode === 'local' ? 'disabled' : ''}>Copy up now</button>
      </div>
      <div class="sb-when">${esc(syncWhen(st.lastSync, st.linked))}</div>
      <div class="sb-detail">${esc(st.detail || words[1])}</div>`;
    const btn = $('#syncNow');
    if (btn) btn.addEventListener('click', syncNow);
  }

  async function syncNow() {
    const btn = $('#syncNow');
    if (btn) { btn.disabled = true; btn.textContent = 'Copying…'; }
    try {
      await api('POST', '/api/sync', {});
      toast('Copied to the cloud.', 'ok');
    } catch (e) {
      toast(e.message || 'Could not reach the cloud.', 'bad');
    } finally {
      loadSync();
    }
  }

  /* The pill has to follow the cloud on its own, a copy takes a moment and the
     note must not sit there saying "not copied yet" once it is done. */
  let lastSyncState = '';
  async function loadSync() {
    try {
      const st = await api('GET', '/api/sync');
      const mark = `${st.mode}|${st.state}|${st.pending}|${st.lastSync}|${st.linked}`;
      if (mark === lastSyncState) return;
      lastSyncState = mark;
      paintSync(st);
    } catch {
      if (lastSyncState !== 'local') { lastSyncState = 'local'; paintSync({ mode: 'local', state: 'local' }); }
    }
  }

  if (window.Sync && typeof window.Sync.onChange === 'function') {
    window.Sync.onChange(() => { loadSync(); });
  }

  /** Every device with a live session, so the owner can spot and drop a stranger. */
  async function loadSessions() {
    const box = $('#secSessions');
    box.innerHTML = '<div class="p-sub">Loading…</div>';
    try {
      const r = await api('GET', '/api/auth/sessions');
      box.innerHTML = r.sessions.length
        ? r.sessions.map((s) => `<div class="kv-row sess-row">
            <span class="k">${esc(s.device)}${s.current ? ' <span class="pill ok"><span class="dot"></span>This device</span>' : ''}</span>
            <span class="v">
              ${s.current ? esc(new Date(s.lastSeenAt).toLocaleString()) : `<button class="btn soft xs" data-revoke="${esc(s.id)}">Sign out</button>`}
            </span>
          </div>`).join('')
        : '<div class="p-sub">No active sessions.</div>';
    } catch {
      box.innerHTML = '<div class="p-sub">Could not load your devices.</div>';
    }
  }

  async function loadEvents() {
    try {
      const r = await api('GET', '/api/auth/events');
      const LABELS = {
        login: 'Signed in', register: 'Account created', verified: 'Email verified',
        otp_sent: 'Verification code emailed', verify_failed: 'Wrong verification code',
        password_changed: 'Password changed',
      };
      const BAD = new Set(['verify_failed']);
      $('#secEvents').innerHTML = r.events.length
        ? r.events.map((e) => `<div class="kv-row">
            <span class="pill ${BAD.has(e.event) ? 'danger' : e.event === 'login' ? 'ok' : 'mute'}">
              <span class="dot"></span>${esc(LABELS[e.event] || e.event)}
            </span>
            <span class="v">${esc(e.device_label || '—')} · ${esc(new Date(e.created_at).toLocaleString())}</span>
          </div>`).join('')
        : '<div class="p-sub">Nothing recorded yet.</div>';
    } catch { /* ignore */ }
  }

  async function saveSettings() {
    const btn = $('#setSave');
    busy(btn, true, 'Saving');
    try {
      const payload = {
        name: $('#setName').value.trim(),
        examDate: $('#setExamDate').value,
        examYear: Number($('#setExamYear').value),
      };
      const r = await api('PUT', '/api/settings', payload);
      S.settings = Object.assign(S.settings, r.settings);
      S.user.examYear = payload.examYear || S.user.examYear;
      S.settings.name = payload.name;
      renderAll();
      toast('Details saved', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      busy(btn, false);
    }
  }

  /* ============================================================== tabs == */

  const PAGE_IDS = { dash: 'pageDash', tt: 'pageTT', marks: 'pageMarks', settings: 'pageSettings' };

  /* Every view gets its own real address (like a normal website's pages), so
     the back button works and a link to #marks can be shared or bookmarked. */
  const TAB_HASH = { dash: 'dash', tt: 'timetable', marks: 'marks', settings: 'settings' };
  const HASH_TAB = { dash: 'dash', timetable: 'tt', marks: 'marks', settings: 'settings' };

  function tabFromHash() {
    const h = String(location.hash || '').toLowerCase().replace(/^#\/?/, '').split('?')[0];
    if (!h) return null;
    return HASH_TAB[h] || null;
  }

  /* The owner can switch a page off for everybody, in which case its tab is
     hidden. Landing on a hidden tab would show an empty page with no way back,
     so anything switched off falls through to the dashboard. */
  const pageOn = (name) => {
    const tab = document.querySelector(`#tabs button[data-tab="${name}"]`);
    return !tab || !tab.hidden;
  };

  function switchTab(name) {
    const target = PAGE_IDS[name];
    if (!target) return;
    const wanted = pageOn(name) ? name : 'dash';
    const tabHash = `#${TAB_HASH[wanted]}`;
    if (tabFromHash() !== wanted && location.hash !== tabHash) {
      try {
        history.pushState(null, '', tabHash);
      } catch (_) {
        location.hash = tabHash;
      }
    }
    $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === wanted));
    $$('.page-body').forEach((p) => p.classList.toggle('active', p.id === PAGE_IDS[wanted]));
    if (wanted === 'dash') { renderDailyBars(); renderSubjectChart(); renderDashboardMarksChart(); }
    if (wanted === 'marks') renderMarksPage();
    if (wanted === 'tt') renderTimetable();
    updateSubjectInviters();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  window.addEventListener('popstate', () => {
    const name = tabFromHash();
    if (name && name !== currentTabName()) switchTab(name);
  });

  function currentTabName() {
    return $$('#tabs button').find((b) => b.classList.contains('active'))?.dataset.tab || 'dash';
  }

  /* ============================================================= events = */

  function wire() {
    /* tabs */
    $$('#tabs button').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));

    /* week nav */
    $('#prevW').addEventListener('click', () => { S.weekOffset -= 1; renderAll(); });
    $('#nextW').addEventListener('click', () => { S.weekOffset += 1; renderAll(); });
    $('#goToday').addEventListener('click', () => { S.weekOffset = 0; renderAll(); });

    /* copy week */
    $('#btnCopyWeek').addEventListener('click', openCopy);
    $('#btnClearWeek').addEventListener('click', clearWeek);
    $('#copyCancel').addEventListener('click', () => $('#copyOverlay').classList.remove('show'));
    $('#copyGo').addEventListener('click', doCopy);
    $('#copyTargets').addEventListener('click', (e) => {
      const b = e.target.closest('.week-option');
      if (!b) return;
      $$('.week-option', $('#copyTargets')).forEach((x) => x.classList.remove('sel'));
      b.classList.add('sel');
      S.copyTarget = { off: Number(b.dataset.off), id: b.dataset.id };
      $('#copyGo').disabled = false;
      const n = countSessions(weekOf(b.dataset.id));
      if (n) {
        setNotice($('#copyNotice'), 'warn', `That week already has ${n} session${n > 1 ? 's' : ''}. Saving will replace them.`);
      } else {
        setNotice($('#copyNotice'), null, null);
      }
    });
    $$('.radio-card', $('#copyOverlay')).forEach((r) => r.addEventListener('click', () => {
      $$('.radio-card', $('#copyOverlay')).forEach((x) => x.classList.remove('sel'));
      r.classList.add('sel');
      S.copyMode = r.dataset.mode;
      $('#copyGo').textContent = S.copyMode === 'move' ? 'Move week' : 'Copy week';
    }));

    /* task modal */
    $('#btnAddTask').addEventListener('click', () => {
      const today = todayISO();
      let idx = DAYS.findIndex((d) => dateOfDay(DAYS.indexOf(d)) === today);
      if (idx < 0) idx = 0;
      openTask(DAYS[idx].key, null);
    });
    $('#tCancel').addEventListener('click', closeTask);
    $('#tSave').addEventListener('click', saveTask);
    $('#tType').addEventListener('change', () => {
      const isOther = $('#tType').value === 'other';
      $('#tOtherWrap').style.display = isOther ? '' : 'none';
      $('#tSubject').style.display = isOther ? 'none' : '';
      $('#tSubject').closest('.field').style.display = isOther ? 'none' : '';
      if (isOther) $('#tOther').focus(); else fillSubjectSelect($('#tSubject').value);
    });
    $('#taskOverlay').addEventListener('click', (e) => { if (e.target.id === 'taskOverlay') closeTask(); });
    $('#copyOverlay').addEventListener('click', (e) => { if (e.target.id === 'copyOverlay') $('#copyOverlay').classList.remove('show'); });

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if ($('#taskOverlay').classList.contains('show')) closeTask();
      if ($('#copyOverlay').classList.contains('show')) $('#copyOverlay').classList.remove('show');
    });

    /* timetable grid */
    const grid = $('#ttGrid');
    grid.addEventListener('click', (e) => {
      const add = e.target.closest('[data-add]');
      if (add) { openTask(add.dataset.add, null); return; }

      const chk = e.target.closest('[data-toggle]');
      if (chk) {
        e.stopPropagation();
        toggleDone(chk.dataset.day, chk.dataset.toggle);
        return;
      }

      const del = e.target.closest('[data-del]');
      if (del) {
        e.stopPropagation();
        deleteTask(del.dataset.day, del.dataset.id);
        return;
      }

      const tsk = e.target.closest('.tsk');
      if (tsk) openTask(tsk.dataset.day, tsk.dataset.id);
    });

    /* timetable filter */
    $('#ttFilter').addEventListener('click', (e) => {
      const b = e.target.closest('.ttf-btn, button');
      if (!b) return;
      $$('#ttFilter button').forEach((x) => x.classList.toggle('active', x === b));
      S.ttFilter = b.dataset.f;
      renderTimetable();
    });

    /* marks */
    $('#mkSubject').addEventListener('change', (e) => {
      S.mkSubject = e.target.value;
      S.mkTest = null;
      toggleNewTestRow(false);
      renderMarksPage();
    });
    $('#mkTest').addEventListener('change', (e) => {
      S.mkTest = e.target.value;
      renderMarksEditor(); renderMarksOverall(); renderMarksChart();
    });
    $('#mkAddTest').addEventListener('click', () => toggleNewTestRow(true, false));
    $('#mkRenameTest').addEventListener('click', () => toggleNewTestRow(true, true));
    $('#mkNewCancel').addEventListener('click', () => toggleNewTestRow(false));
    $('#mkNewSave').addEventListener('click', saveTestRow);
    $('#mkNewName').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); saveTestRow(); }
      if (e.key === 'Escape') { e.preventDefault(); toggleNewTestRow(false); }
    });
    $('#mkDelTest').addEventListener('click', deleteCurrentTest);

    /* settings */
    $('#setSave').addEventListener('click', saveSettings);
    $('#subAdd').addEventListener('click', addSubject);
    $('#subNew').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addSubject(); } });
    $('#subEditor').addEventListener('click', removeSubject);
    $('#subUseSite').addEventListener('click', useSiteSubjects);
    $('#secSessions').addEventListener('click', async (e) => {
      const id = e.target.closest('[data-revoke]')?.dataset.revoke;
      if (!id) return;
      try {
        await api('DELETE', '/api/auth/sessions', { id });
        toast('That device was signed out.', 'ok');
        loadSessions();
      } catch (err) { toast(err.message, 'err'); }
    });
    $('#btnExport').addEventListener('click', exportData);
    $('#btnErase').addEventListener('click', eraseAll);
    $('#btnSignOut').addEventListener('click', signOut);
    $('#btnSignOutTop').addEventListener('click', signOut);
    $('#syncPill').addEventListener('click', () => switchTab('settings'));
    $('#pwSave').addEventListener('click', changePassword);
    $('#whoBtn').addEventListener('click', () => switchTab('settings'));

    /* the start-here invites on pages that have nothing to show yet */
    const dhGo = $('#dashEmptyGo');
    if (dhGo) dhGo.addEventListener('click', gotoSubjects);
    const ttGo = $('#ttEmptyGo');
    if (ttGo) ttGo.addEventListener('click', gotoSubjects);

    /* keep the now-line honest */
    setInterval(() => { if (S.weekOffset === 0 && $('#pageTT').classList.contains('active')) renderTimetable(); }, 60000);
  }

  /* -------------------------------------------------------- task edits - */

  function toggleDone(day, id) {
    const list = dayTasks(weekId(), day);
    const t = list.find((x) => x.id === id);
    if (!t) return;
    t.done = !t.done;
    queueSave();
    renderAll();
  }

  function deleteTask(day, id) {
    const wk = weekOf(weekId());
    if (!wk[day]) return;
    const i = wk[day].findIndex((x) => x.id === id);
    if (i < 0) return;
    wk[day].splice(i, 1);
    queueSave();
    renderAll();
    toast('Session deleted', 'ok');
  }

  /* ---------------------------------------------------------- subjects - */

  async function addSubject() {
    const v = $('#subNew').value.trim();
    if (!v) { $('#subNew').focus(); return; }
    if (S.subjects.some((s) => s.toLowerCase() === v.toLowerCase())) { toast('That subject already exists.', 'err'); return; }
    const next = S.subjects.concat([v]);
    await api('PUT', '/api/subjects', { subjects: next });
    S.subjects = next;
    $('#subNew').value = '';
    renderSubEditor();
    renderLegend();
    renderSubjectChart();
    renderSubjectSummary();
    renderDashboardMarksChart();
    if (!S.mkSubject || !S.subjects.includes(S.mkSubject)) S.mkSubject = v;
    S.mkTest = null;
    renderMarksPage();
    updateSubjectInviters();
    toast(`${v} added`, 'ok');
  }

  async function removeSubject(e) {
    const b = e.target.closest('[data-rm]');
    if (!b) return;
    const name = b.dataset.rm;
    if (S.subjects.length <= 1) return;
    if (!confirm(`Remove "${name}"? Timetable sessions using it keep the name, but the colour and chart entry are removed.`)) return;
    const next = S.subjects.filter((s) => s !== name);
    await api('PUT', '/api/subjects', { subjects: next });
    S.subjects = next;
    if (!next.includes(S.mkSubject)) S.mkSubject = next[0];
    renderSubEditor(); renderLegend(); renderSubjectChart(); renderSubjectSummary();
    renderMarksPage(); renderDashboardMarksChart();
    updateSubjectInviters();
  }

  /* ------------------------------------------------------------ account - */

  async function changePassword() {
    const cur = $('#pwCurrent').value;
    const nw = $('#pwNew').value;
    const nw2 = $('#pwNew2').value;
    const notice = $('#pwNotice');
    setNotice(notice, null, null);
    clearFieldErrors($('#pwNew').closest('.panel'));

    if (!cur) { showFieldError($('#pwCurrent'), 'Enter your current password.'); return; }
    if (nw.length < 8) { showFieldError($('#pwNew'), 'Use at least 8 characters.'); return; }
    if (!/[A-Za-z]/.test(nw) || !/[0-9]/.test(nw)) { showFieldError($('#pwNew'), 'Include a letter and a number.'); return; }
    if (nw !== nw2) { showFieldError($('#pwNew2'), 'Passwords do not match.'); return; }

    const btn = $('#pwSave');
    busy(btn, true, 'Updating');
    try {
      await api('POST', '/api/auth/password', { currentPassword: cur, newPassword: nw, confirmPassword: nw2 });
      $('#pwCurrent').value = ''; $('#pwNew').value = ''; $('#pwNew2').value = '';
      setNotice(notice, 'ok', 'Password updated. Every other device has been signed out.');
      toast('Password updated', 'ok');
    } catch (err) {
      if (err instanceof ApiError && err.errors) {
        for (const k of Object.keys(err.errors)) {
          const map = { password: '#pwNew', confirmPassword: '#pwNew2' };
          if (map[k]) showFieldError($(map[k]), err.errors[k]);
        }
      }
      setNotice(notice, 'error', err.message);
    } finally {
      busy(btn, false);
    }
  }

  async function exportData() {
    try {
      const data = await api('GET', '/api/account/export');
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `workbuddy-${data.user.username}-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      toast('Data downloaded', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  }

  async function eraseAll() {
    if (!confirm('Erase every week, mark and setting on this account? This cannot be undone.')) return;
    if (!confirm('Last chance - this permanently deletes your study plan. Continue?')) return;
    try {
      await api('POST', '/api/account/erase');
      toast('Everything erased', 'ok');
      setTimeout(() => window.location.replace('index.html'), 900);
    } catch (err) { toast(err.message, 'err'); }
  }

  async function signOut() {
    try { await api('POST', '/api/auth/logout'); } catch { /* already gone */ }
    window.location.replace('index.html');
  }

  /* =============================================================== boot = */

  (async function boot() {
    /* The settings of the site itself come first, because they decide which
       tabs are on screen before anything is drawn. */
    if (window.AppConfig) { try { await window.AppConfig.load(); } catch { /* the defaults stand */ } }

    let who = null;
    try {
      await loadAll();
      who = S.user;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) { window.location.replace('index.html'); return; }
      document.body.innerHTML = `<div style="position:relative;z-index:2;display:grid;place-items:center;min-height:100vh;padding:30px;text-align:center;color:#dbeafe">
        <div><h1 style="font-size:22px;margin-bottom:10px">Cannot load WorkBuddy</h1>
        <p style="opacity:.8">${esc(err.message || 'Unknown error')}</p></div></div>`;
      return;
    }

    /* Now that the account is known, maintenance mode can be acted on. The
       owner is let straight through, so they can never be locked out of the
       site they run. */
    if (window.AppConfig) {
      window.AppConfig.setLockOverride(!!(who && who.isAdmin));
      window.AppConfig.armLock(true);
    }

    buildSubjectSelect();
    wire();
    renderAll();
    updateSubjectInviters();
    switchTab(tabFromHash() && pageOn(tabFromHash()) ? tabFromHash() : 'dash');
    loadSync();
  })();
})();
