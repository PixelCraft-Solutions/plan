/* ==========================================================================
   WorkBuddy - verification email
   --------------------------------------------------------------------------
   The verification code is delivered by a no-reply email, so a student never
   has to read the code off the screen. There is no backend behind this site,
   so the email is sent straight from the browser through EmailJS, which only
   needs the three values from the `email` block of js/sync-config.js.

   When the owner has not connected an EmailJS account there is nothing to
   send the code home through, so the code is handed to the page instead and
   shown - a student who could not reach the code at all would be locked out
   of the site for good. That fallback is the only time the code is visible.
   ========================================================================== */
(function (global) {
  'use strict';

  const cfg = () => (global.WB_SYNC_CONFIG && global.WB_SYNC_CONFIG.email) || {};

  /** true once the three EmailJS values have been filled in */
  const configured = () => !!(
    cfg().service && cfg().template && cfg().publicKey
  );

  const SDK = 'https://cdn.jsdelivr.net/npm/@emailjs/browser@4/dist/email.min.js';

  function loadSdk() {
    if (global.emailjs) return Promise.resolve(global.emailjs);
    return new Promise((resolve, reject) => {
      const s = global.document.createElement('script');
      s.src = SDK;
      s.async = true;
      s.onload = () => resolve(global.emailjs);
      s.onerror = () => reject(new Error('The email sender library could not be loaded.'));
      global.document.head.appendChild(s);
    });
  }

  /**
   * Emails {code} to {to} through the configured template. The no-reply sender
   * address is set inside the EmailJS template, not in this file, so it stays
   * out of the code that is handed to every browser. Returns { ok } on success
   * or { ok:false, error } (error 'noservice' when nothing is configured).
   */
  async function sendCode({ to, code }) {
    if (!configured()) return { ok: false, error: 'noservice' };
    const c = cfg();
    try {
      const emailjs = await loadSdk();
      await emailjs.send(c.service, c.template, {
        to_email: String(to || '').trim(),
        code: String(code || ''),
        site_name: (global.AppConfig && global.AppConfig.data && global.AppConfig.data.siteName) || 'WorkBuddy',
      }, { publicKey: c.publicKey });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err && err.message) || 'Could not email the code.' };
    }
  }

  global.Mailer = { configured, sendCode };
})(window);