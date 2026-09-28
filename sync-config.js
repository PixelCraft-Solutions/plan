/* ==========================================================================
   WorkBuddy - cloud sync settings
   --------------------------------------------------------------------------
   Leave every value as it is and the site works exactly as before, with each
   account kept in the browser only. Fill in a Firebase project and every
   account is copied between devices, so signing in on a second phone or
   laptop shows the plan and marks entered on the first one.

   Setting this up, once
   1. Go to console.firebase.google.com and create a project.
   2. Build -> Authentication -> Get started -> enable "Email/Password".
   3. Build -> Realtime Database -> Create Database, pick any location.
   4. Realtime Database -> Rules, paste the rules below and Publish.
   5. Project settings -> General -> Your apps -> Web, then copy the values
      from the config object into the block below.

     Rules to publish (a person may only ever read and write their own account,
     the owner alone may change the settings of the site and read who
     registered, usernames may only be linked to their own email, and any
     signed-in account may add a new name to the shared list of subjects but
     may not change or remove one that is already there)
     {
       "rules": {
         "accounts": {
           "$uid": {
             ".read": "$uid === auth.uid",
             ".write": "$uid === auth.uid"
           }
         },
         "appConfig": {
           ".read": true,
           ".write": "auth != null && auth.uid === 'PASTE_OWNER_UID_HERE'"
         },
         "subjectPool": {
           ".read": "auth != null",
           "$name": {
             ".write": "auth != null && (!data.exists() || data.child('by').val() === auth.uid)"
           }
         },
         "users": {
           ".read": "auth != null && auth.uid === 'PASTE_OWNER_UID_HERE'",
           "$uid": {
             ".write": "auth != null && auth.uid === $uid"
           }
         },
         "usernames": {
           ".read": true,
           "$username": {
             ".write": "auth != null && !data.exists() && newData.val() === auth.token.email"
           }
         }
       }
     }

     This is a template, and the two `PASTE_OWNER_UID_HERE` places are the lock.
     Replace both with the owner id from the `admin` block below (the same id
     the setup box on the owner page offers to copy), then publish. If the
     placeholder (or a different, older id) is left in the rules, the database
     has nobody it will accept as the owner: the owner panel opens and every
     other read works, but every save is refused with a "rules did not accept
     this" message, and the registered-users list stays empty the same way.
     Fixing that is simply republishing this file with the id filled in.


    `appConfig` is one shared record holding the site name, the announcement
    banner and the feature switches, so everyone sees the same settings. It is
    readable by anyone, which is what lets the sign-in page show the banner
    before anyone has signed in, and writable only by the owner id from the
    `admin` block below.

    `users` holds one tiny record per account (name, username, email, exam
    year and when they joined - nothing else). Only the owner may read the
    whole list, which is what the owner settings page's "People who
    registered" box takes its list from. Each account writes its own entry at
    registration.

    `usernames` is the small lookup that lets people sign in with their
    username as well as their email. It is readable by anyone (it has to be,
    because the sign-in box is reached before a person has signed in) and a
    username may only be linked to the email address that proves it in the
    cloud. No password or planner data is ever written to either list.

    `subjectPool` is the shared list of subject names, and it is what lets the
    site serve any stream rather than one fixed list. Every name is one small
    record holding just the name and who added it. Any signed-in account may
    put a new name in, which is what happens when somebody adds a subject in
    their own Settings, and that name then reaches every account. The rule
    refuses any change to a name that is already there, so nobody can quietly
    rename or delete what others are relying on: only the person who put a
    name in can take it back out, and only the owner can set the starting list
    in `appConfig`. If this rule has not been published yet the site still
    works, the shared list just stops growing.

    The account is filed under the person id that Firebase hands out at sign up,
    not under the username, so two people can never see each other's data.

    Signing in
    The sign-in box takes either the email address used at registration or the
    username, so the pair works on any device. The username is answered by the
    `usernames` lookup above; typing "owner_bw" signs the owner in because that
    one name is built in. Passwords are never stored by this site, and nothing
    is sent up until the sign-in or the registration has succeeded, so a wrong
    password cannot reach anyone's planner.

    Nothing to install
    The Firebase library is fetched from Google's own servers the first time a
    cloud is actually used, so there is no build step and no extra file to keep.

    Where the pages are opened from
    With no project in the block above, index.html and app.html work even when
    they are opened straight from the disk. A cloud needs a real web address
    (any static host will do, or "npx serve ." in this folder), because signing
    in talks to Google.
    ========================================================================== */

window.WB_SYNC_CONFIG = {
  debug: false,

  firebase: {
    apiKey: 'AIzaSyDC75oMnokplygdXwxQKNvwt8wzBuwwrSY',
    authDomain: 'workbuddy-1e0b2.firebaseapp.com',
    databaseURL: 'https://workbuddy-1e0b2-default-rtdb.asia-southeast1.firebasedatabase.app',
    projectId: 'workbuddy-1e0b2',
    appId: '1:667682943874:web:0def4ffb25417db615959b',
  },

  /* -----------------------------------------------------------------------
     The owner of this site.

     `username` is what gets typed into the sign-in box, and `email` is the
     address Firebase actually checks the password against, so the owner signs
     in with a plain username while the cloud still sees a normal email pair.

     `uid` is the owner id from Firebase -> Authentication -> Users. It is
     filled in here only so the admin panel knows whether to open, and it is
     also written into the database rules, which is the part that actually
     decides who may change the app settings. Leave `uid` blank and the panel
     still opens when the owner signs in (it recognises the email), and the
     owner settings page's "Owner setup" box shows the id with a Copy button,
     ready to be pasted here and into the rules.

     No password is written in this file. The owner account has to be created
     once in the Firebase console, where the password is kept by Google and
     never reaches the site.
     ----------------------------------------------------------------------- */
  admin: {
    username: 'owner_bw',
    email: 'owner_bw@workbuddy-admin.app',
    uid: '6nES1D5gRJWY9KHH9nzN2aIzgYm2',
  },

  /* -----------------------------------------------------------------------
     Verification email.

     The 6-digit code a new account needs is sent as a no-reply email to the
     address the student registered with, so it is never shown on the page.
     The email is sent straight from the browser through EmailJS; fill in the
     three values to switch it on.

     Setting it up, once
     1. Go to emailjs.com and create an account (the free tier is enough).
     2. Email Services -> Add a service and pick how the sender address is
        provided (a free Gmail link is the simplest option).
     3. Email Templates -> Create a new template and name it something like
        "wb_verify". Fill in the sender address as you want it shown (e.g.
        `WorkBuddy <no-reply@your-domain>`), the subject, and a body that
        shows the code, for example:
           Hello {{to_email}}. Your verification code is {{code}}.
        Keep those three fields spelled exactly like that.
     4. Copy the Service ID (from the service keep tool) and the Template ID
        (from the template name arrow) into this block, and put your public
        key here too (Account -> General -> API Keys -> Public key).

     Leave this blank and registration still works: the code is handed to the
     page instead and shown on screen, because a code nobody can receive would
     lock a student out of the site.
     ----------------------------------------------------------------------- */
  email: {
    service: '',
    template: '',
    publicKey: '',
  },
};
