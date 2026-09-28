/* ==========================================================================
   WorkBuddy - sign in / register / verify
   ========================================================================== */
(function () {
  'use strict';

  const { api, ApiError, $, $$, busy, setNotice, showFieldError, clearFieldErrors, applyFieldErrors } = window.WB;

  const el = {
    topNotice: $('#topNotice'),

    tabSignin: $('#tabSignin'),
    tabRegister: $('#tabRegister'),
    paneSignin: $('#paneSignin'),
    paneRegister: $('#paneRegister'),
    paneVerify: $('#paneVerify'),

    formSignin: $('#formSignin'),
    formRegister: $('#formRegister'),
    formVerify: $('#formVerify'),

    siSubmit: $('#siSubmit'),
    rgSubmit: $('#rgSubmit'),
    vfSubmit: $('#vfSubmit'),

    verifyEmail: $('#verifyEmail'),
    verifyNotice: $('#verifyNotice'),
    otpWrap: $('#otpWrap'),
    btnResend: $('#btnResend'),
    resendIn: $('#resendIn'),
    devCode: $('#devCode'),
    devCodeVal: $('#devCodeVal'),
    btnCopyCode: $('#btnCopyCode'),
    vfBack: $('#vfBack'),

    goRegister: $('#goRegister'),
    goSignin: $('#goSignin'),
  };

  const state = { verifyUser: null, verifyEmail: '', resendTimer: null, resendLeft: 0, code: '' };

  /* --------------------------------------------------------- navigation -- */

  const PANES = {
    signin: el.paneSignin,
    register: el.paneRegister,
    verify: el.paneVerify,
  };

  function show(name) {
    for (const key of Object.keys(PANES)) PANES[key].classList.toggle('active', key === name);
    const onSignin = name === 'signin';
    el.tabSignin.classList.toggle('active', onSignin);
    el.tabRegister.classList.toggle('active', name === 'register');
    el.tabSignin.setAttribute('aria-selected', String(onSignin));
    el.tabRegister.setAttribute('aria-selected', String(name === 'register'));
    el.tabRegister.style.visibility = name === 'verify' ? 'hidden' : '';
    setNotice(el.topNotice, null, null);
    if (onSignin) $('#si_user').focus();
    else if (name === 'register') $('#rg_name').focus();
  }

  el.tabSignin.addEventListener('click', () => show('signin'));
  el.tabRegister.addEventListener('click', () => show('register'));
  el.goRegister.addEventListener('click', () => show('register'));
  el.goSignin.addEventListener('click', () => show('signin'));
  el.vfBack.addEventListener('click', () => { stopResend(); show('signin'); });

  /* The owner has no timetable and no marks to plan, so signing in does not
     drop them on the planner: the same username and password box opens the
     site editor instead. Everyone else gets the planner as usual. */
  function enterApp(me) {
    const owner = !!(me && me.user && me.user.isAdmin);
    window.location.replace(owner ? 'admin.html' : 'app.html');
  }

  /** who is signed in, or null, so the redirect can read isAdmin off it */
  async function me() {
    try { return await api('GET', '/api/auth/me'); } catch { return null; }
  }

  /* --------------------------------------------------------- OTP inputs -- */

  function wireOtp(wrap, onComplete) {
    const boxes = $$('input', wrap);
    boxes.forEach((box, i) => {
      box.addEventListener('input', () => {
        box.value = box.value.replace(/\D/g, '').slice(0, 1);
        box.classList.toggle('filled', !!box.value);
        box.classList.remove('bad');
        if (box.value && i < boxes.length - 1) boxes[i + 1].focus();
        if (boxes.every((b) => b.value)) onComplete(boxes.map((b) => b.value).join(''));
      });

      box.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && !box.value && i > 0) { boxes[i - 1].focus(); boxes[i - 1].value = ''; boxes[i - 1].classList.remove('filled'); }
        if (e.key === 'ArrowLeft' && i > 0) boxes[i - 1].focus();
        if (e.key === 'ArrowRight' && i < boxes.length - 1) boxes[i + 1].focus();
        if (e.key === 'Enter') { e.preventDefault(); if (boxes.every((b) => b.value)) onComplete(boxes.map((b) => b.value).join('')); }
      });

      box.addEventListener('focus', () => box.select());
      box.addEventListener('paste', (e) => {
        e.preventDefault();
        const digits = (e.clipboardData.getData('text') || '').replace(/\D/g, '').split('');
        if (!digits.length) return;
        boxes.forEach((b, k) => { b.value = digits[k] || ''; b.classList.toggle('filled', !!b.value); });
        const next = Math.min(digits.length, boxes.length - 1);
        boxes[next].focus();
        if (boxes.every((b) => b.value)) onComplete(boxes.map((b) => b.value).join(''));
      });
    });

    return {
      clear() { boxes.forEach((b) => { b.value = ''; b.classList.remove('filled', 'bad'); }); boxes[0].focus(); },
      shake() {
        boxes.forEach((b) => b.classList.add('bad'));
        setTimeout(() => boxes.forEach((b) => b.classList.remove('bad')), 400);
      },
    };
  }

  /* -------------------------------------------------- password feedback -- */

  const rgPass = $('#rg_pass');
  const rgPass2 = $('#rg_pass2');
  const pwBar = $('#pwBar');
  const pwMsg = $('#pwMsg');

  function scorePassword(v) {
    if (!v) return 0;
    let s = 0;
    if (v.length >= 8) s += 34;
    if (v.length >= 12) s += 14;
    if (/[A-Za-z]/.test(v) && /[0-9]/.test(v)) s += 26;
    if (/[^A-Za-z0-9]/.test(v)) s += 16;
    if (/[a-z]/.test(v) && /[A-Z]/.test(v)) s += 10;
    return Math.min(100, s);
  }

  rgPass.addEventListener('input', () => {
    const v = rgPass.value;
    const s = scorePassword(v);
    pwBar.style.width = s + '%';
    pwBar.style.background = s >= 70 ? 'var(--ok)' : s >= 45 ? '#38bdf8' : 'var(--warn)';
    if (!v) {
      pwMsg.className = 'pw-msg';
      pwMsg.textContent = 'Use 8+ characters with a letter and a number.';
    } else if (v.length < 8) {
      pwMsg.className = 'pw-msg bad';
      pwMsg.textContent = 'Too short - at least 8 characters needed.';
    } else if (!/[A-Za-z]/.test(v) || !/[0-9]/.test(v)) {
      pwMsg.className = 'pw-msg bad';
      pwMsg.textContent = 'Add both a letter and a number.';
    } else {
      pwMsg.className = 'pw-msg good';
      pwMsg.textContent = s >= 70 ? 'Strong password.' : 'Good - a few more characters would be better.';
    }
    if (rgPass2.value) checkMatch();
  });

  function checkMatch() {
    if (!rgPass2.value) { showFieldError(rgPass2, ''); return true; }
    if (rgPass2.value !== rgPass.value) {
      showFieldError(rgPass2, 'Passwords do not match.');
      return false;
    }
    showFieldError(rgPass2, '');
    return true;
  }
  rgPass2.addEventListener('input', checkMatch);
  rgPass2.addEventListener('blur', checkMatch);

  /* ------------------------------------------------------ resend timer -- */

  function stopResend() {
    if (state.resendTimer) { clearInterval(state.resendTimer); state.resendTimer = null; }
    el.btnResend.disabled = true;
  }

  function startResend(seconds) {
    stopResend();
    state.resendLeft = seconds;
    el.resendIn.textContent = seconds;
    el.btnResend.disabled = true;
    state.resendTimer = setInterval(() => {
      state.resendLeft -= 1;
      el.resendIn.textContent = Math.max(0, state.resendLeft);
      if (state.resendLeft <= 0) {
        stopResend();
        el.resendIn.textContent = '0';
        el.btnResend.disabled = false;
      }
    }, 1000);
  }

  /* ------------------------------------------------- the inbox card ----- */

  /* The verification code is sent home as a no-reply email through js/mail.js,
     and is only ever shown on this page when no email service is connected -
     a code that cannot reach a student anywhere would lock them out of the
     site. Returns true when the email went out. */
  async function deliverCode(email, code) {
    if (window.Mailer && window.Mailer.configured()) {
      const r = await window.Mailer.sendCode({ to: email, code });
      if (r.ok) {
        setNotice(el.verifyNotice, 'ok',
          `We emailed a 6-digit code to ${email}. Enter it below - and check the spam folder if it does not arrive within a minute.`);
        return true;
      }
      setNotice(el.verifyNotice, 'error',
        `The code could not be emailed (${r.error || 'unknown error'}), so it is shown on this page instead.`);
    }
    return false;
  }

  function showCode(code) {
    state.code = code;
    el.devCodeVal.textContent = code;
    el.devCode.classList.add('show');
  }

  el.btnCopyCode.addEventListener('click', async () => {
    if (!state.code) return;
    const done = () => {
      el.btnCopyCode.textContent = 'Copied';
      setTimeout(() => { el.btnCopyCode.textContent = 'Copy code'; }, 1600);
    };
    try {
      await navigator.clipboard.writeText(state.code);
      done();
    } catch {
      // clipboard blocked (or an insecure context) - select the digits instead
      const range = document.createRange();
      range.selectNodeContents(el.devCodeVal);
      const sel = window.getSelection ? window.getSelection() : document.getSelection();
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(range);
      }
      done();
    }
  });

  el.btnResend.addEventListener('click', async () => {
    if (!state.verifyUser) return;
    stopResend();
    try {
      const r = await api('POST', '/api/auth/resend', { username: state.verifyUser });
      state.verifyEmail = r.email || state.verifyEmail;
      el.devCode.classList.remove('show');
      const sent = await deliverCode(state.verifyEmail || 'your email address', r.devCode);
      if (!sent && r.devCode) showCode(r.devCode);
      startResend(30);
    } catch (err) {
      setNotice(el.verifyNotice, 'error', err.message);
      startResend(15);
    }
  });

  /* ----------------------------------------------------------- register -- */

  el.formRegister.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearFieldErrors(el.formRegister);
    setNotice(el.topNotice, null, null);

    if (!checkMatch()) { rgPass2.focus(); return; }

    const body = {
      name: $('#rg_name').value.trim(),
      username: $('#rg_user').value.trim(),
      examYear: $('#rg_year').value,
      email: $('#rg_email').value.trim(),
      password: rgPass.value,
      confirmPassword: rgPass2.value,
    };

    busy(el.rgSubmit, true, 'Creating account');
    try {
      const r = await api('POST', '/api/auth/register', body);
      state.verifyUser = r.username;
      state.verifyEmail = r.email;
      el.verifyEmail.textContent = r.email;
      el.formRegister.reset();
      rgPass.classList.remove('invalid');
      pwBar.style.width = '0%';
      pwMsg.className = 'pw-msg';
      pwMsg.textContent = 'Use 8+ characters with a letter and a number.';

      verifyCtl.clear();
      el.devCode.classList.remove('show');
      setNotice(el.verifyNotice, 'info', `Sending your code to ${r.email}...`);
      const sent = await deliverCode(r.email, r.devCode);
      if (!sent && r.devCode) showCode(r.devCode);

      startResend(30);
      show('verify');
    } catch (err) {
      const known = err instanceof ApiError && (err.status === 422 || err.status === 409);
      if (known) applyFieldErrors(el.formRegister, err.errors);
      /* a clash means the person already has an account, so the reason is
         worth saying out loud as well as under the field */
      if (!known || err.status === 409) setNotice(el.topNotice, 'error', err.message);
    } finally {
      busy(el.rgSubmit, false);
    }
  });

  /* ------------------------------------------------------------- verify -- */

  const verifyCtl = wireOtp(el.otpWrap, (code) => submitVerify(code));

  let verifying = false;
  async function submitVerify(code) {
    if (verifying) return;
    verifying = true;
    setNotice(el.verifyNotice, null, null);
    busy(el.vfSubmit, true, 'Verifying');
    try {
      await api('POST', '/api/auth/verify', { username: state.verifyUser, code });
      enterApp(await me());
    } catch (err) {
      verifyCtl.shake();
      setNotice(el.verifyNotice, 'error', err.message);
      verifyCtl.clear();
    } finally {
      verifying = false;
      busy(el.vfSubmit, false);
    }
  }

  el.formVerify.addEventListener('submit', (e) => {
    e.preventDefault();
    const code = $$('input', el.otpWrap).map((b) => b.value).join('');
    if (code.length !== 6) { setNotice(el.verifyNotice, 'error', 'Please enter all 6 digits.'); return; }
    submitVerify(code);
  });

  /* -------------------------------------------------------------- login -- */

  el.formSignin.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearFieldErrors(el.formSignin);
    setNotice(el.topNotice, null, null);

    const body = {
      username: $('#si_user').value.trim(),
      password: $('#si_pass').value,
    };

    busy(el.siSubmit, true, 'Signing in');
    try {
      const r = await api('POST', '/api/auth/login', body);
      $('#si_pass').value = '';
      enterApp(r);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 422 || err.status === 409)) {
        applyFieldErrors(el.formSignin, err.errors);
      } else if (err instanceof ApiError && err.status === 403 && err.body.error === 'unverified') {
        state.verifyUser = err.body.username;
        el.verifyEmail.textContent = 'your email address';
        verifyCtl.clear();
        setNotice(el.verifyNotice, 'info', 'Your email address is not verified yet. Request a code and enter it here.');
        show('verify');
        startResend(0);
      } else {
        let msg = err.message;
        if (err instanceof ApiError && typeof err.body.attemptsLeft === 'number' && err.body.attemptsLeft <= 3) {
          msg += ` (${err.body.attemptsLeft} attempt${err.body.attemptsLeft === 1 ? '' : 's'} left before a 15 minute lockout)`;
        }
        setNotice(el.topNotice, 'error', msg);
      }
    } finally {
      busy(el.siSubmit, false);
    }
  });

  /* -------------------------------------------------------------- start -- */

  /* Maintenance mode replaces this whole page with the owner's notice, so the
     sign-in box is put away until somebody claims to be the owner. The claim
     is only about this browser's view - the owner is recognised properly the
     moment they sign in, and only they reach the editor. */
  const maintBox = $('#maintNotice');
  const maintBack = $('#maintOwnerSignin');

  function releaseLock() {
    if (!window.AppConfig) return;
    window.AppConfig.setLockOverride(true);
    if (maintBack) maintBack.hidden = true;
    show('signin');
    const input = $('#si_user');
    if (input) input.focus();
  }

  if (maintBack) {
    maintBack.addEventListener('click', releaseLock);
  }

  (async function init() {
    /* The site settings come first: the announcement banner, the site name and
       the maintenance notice are all part of this page, and the owner may have
       closed new registrations. */
    if (window.AppConfig) {
      try { await window.AppConfig.load(); } catch { /* the defaults stand */ }
    }

    /* With a cloud set up the account lives behind the registered email, so the
       sign-in box accepts the email - or, now, the username it belongs to. */
    if (window.Sync && window.Sync.configured()) {
      const label = $('#siUserLabel');
      const input = $('#si_user');
      const hint = $('#siUserHint');
      if (label) label.textContent = 'Email or username';
      if (input) {
        input.type = 'text';
        input.inputMode = 'email';
        input.placeholder = 'you@example.com or your username';
        input.autocomplete = 'username';
      }
      if (hint) {
        hint.textContent = 'Either the email you registered with or your username opens the same account.';
        hint.hidden = false;
      }
      const rgHint = $('#rgEmailHint');
      if (rgHint) rgHint.hidden = false;
    }

    /* Registration closed by the owner: the tab is taken away and the wording
       says why. The server refuses the attempt as well, so this is about the
       person rather than about keeping anyone out. */
    if (window.AppConfig && !window.AppConfig.feature('registration')) {
      el.tabRegister.disabled = true;
      el.tabRegister.title = 'New registrations are closed at the moment.';
      el.goRegister.hidden = true;
      setNotice(el.topNotice, 'info', 'New registrations are closed at the moment. Signing in still works as usual.');
    }

    const signedIn = await me();
    if (signedIn && signedIn.user) enterApp(signedIn);

    /* Nobody is signed in yet, so the notice is up and the form is away. The
       owner is let back in, and lands on the editor as soon as they do. */
    if (window.AppConfig && window.AppConfig.maintenanceOn() && maintBox) {
      setNotice(el.topNotice, 'info', 'The site is down for maintenance at the moment. If you are the owner, sign in below to bring it back.');
    }

    if (!window.Store.storageAvailable()) {
      setNotice(el.topNotice, 'warn',
        'This browser is blocking local storage, so nothing will be remembered after you close the tab.');
    }
  })();
})();
