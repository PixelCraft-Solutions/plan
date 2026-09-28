/* ==========================================================================
   WorkBuddy - shared browser helpers
   ========================================================================== */
(function (global) {
  'use strict';

  const { api, ApiError, deviceId, deviceLabel, detectLabel } = global.Store;

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  /* The colours a subject is drawn in, everywhere it appears: the timetable
     grid, the legend, the charts and the subject chips. It lives here rather
     than in the planner because the owner panel previews the same chips when
     setting the subjects a new account starts with, and two copies of one
     palette would drift apart. Blue-led, so a first list sits in one family,
     with the warmer colours held back for subjects added later. */
  const PALETTE = [
    { s: '#2563eb', bg: '#e8f0fe', ink: '#1a3d8f' },
    { s: '#0ea5e9', bg: '#e0f4fd', ink: '#0a5b7a' },
    { s: '#0891b2', bg: '#e0f5f8', ink: '#0b5566' },
    { s: '#4f46e5', bg: '#eaeafe', ink: '#2e28a8' },
    { s: '#7c3aed', bg: '#f1e9fe', ink: '#54219f' },
    { s: '#0d9488', bg: '#e0f5f3', ink: '#0a5c55' },
    { s: '#db2777', bg: '#fde8f2', ink: '#9d174d' },
    { s: '#ea580c', bg: '#fdeee4', ink: '#a53a09' },
    { s: '#65a30d', bg: '#eef7e0', ink: '#4a7a0c' },
    { s: '#be123c', bg: '#fdeaee', ink: '#8a0d2e' },
  ];

  /** the colour for the nth subject, wrapping round when there are more */
  const subjectColor = (index) => PALETTE[index % PALETTE.length];

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function busy(button, on, labelWhenBusy) {
    if (!button) return;
    if (on) {
      button.dataset.label = button.dataset.label || button.innerHTML;
      button.disabled = true;
      button.innerHTML = `<span class="spin"></span>${labelWhenBusy || 'Please wait'}`;
    } else {
      button.disabled = false;
      if (button.dataset.label) button.innerHTML = button.dataset.label;
    }
  }

  function setNotice(el, kind, text) {
    if (!el) return;
    if (!text) { el.className = 'notice'; el.innerHTML = ''; return; }
    el.className = `notice ${kind} show`;
    el.innerHTML = `<span class="ni"></span><span></span>`;
    el.lastElementChild.textContent = text;
  }

  const pad2 = (n) => String(n).padStart(2, '0');
  const toISO = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

  function showFieldError(input, message) {
    const field = input ? input.closest('.field') : null;
    if (!field) return;
    field.classList.toggle('invalid', !!message);
    const err = field.querySelector('.err');
    if (err) {
      err.textContent = message || '';
      err.classList.toggle('show', !!message);
    }
    if (input) input.setAttribute('aria-invalid', message ? 'true' : 'false');
  }

  function clearFieldErrors(form) {
    $$('.field', form).forEach((f) => {
      f.classList.remove('invalid');
      const e = $('.err', f);
      if (e) { e.textContent = ''; e.classList.remove('show'); }
    });
  }

  function applyFieldErrors(form, errors) {
    let first = null;
    for (const key of Object.keys(errors || {})) {
      const input = form.querySelector(`[name="${key}"]`);
      if (input) {
        showFieldError(input, errors[key]);
        if (!first) first = input;
      }
    }
    if (first) { first.focus(); first.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  }

  /* --------------------------------------------------- show / hide password -- */

  /* Every `.pwd` block holds a password input and an eye button that swaps the
     field between password and plain text, so somebody can double-check the
     password they just typed without re-typing it. Wired here so it works on
     every page that loads a password box, whether that box signs a person in,
     registers one or changes a password. */
  function wirePwdToggles() {
    for (const box of $$('.pwd')) {
      const input = box.querySelector('input');
      const btn = box.querySelector('.pwd-toggle');
      if (!input || !btn || input.dataset.pwdWired) continue;
      input.dataset.pwdWired = '1';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
        btn.classList.toggle('on', show);
        const off = btn.querySelector('.eye-off');
        const open = btn.querySelector('.eye-open');
        if (off) off.hidden = !show;
        if (open) open.hidden = show;
        input.focus();
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wirePwdToggles);
  } else {
    wirePwdToggles();
  }

  global.WB = {
    api, ApiError, deviceId, deviceLabel, detectLabel,
    $, $$, esc, busy, setNotice, pad2, toISO,
    showFieldError, clearFieldErrors, applyFieldErrors,
    PALETTE, subjectColor, wirePwdToggles,
  };
})(window);
