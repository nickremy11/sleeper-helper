/* shared-auth.js — consistent auth chip + modal across all ffhistorian.com pages */
(function () {
  'use strict';

  // ── Helpers ───────────────────────────────────────────────────────────────────

  function esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ── State ─────────────────────────────────────────────────────────────────────

  // When hosted on the apex domain, API calls must be cross-origin to helper.
  var _apiBase  = (location.hostname === 'ffhistorian.com') ? 'https://helper.ffhistorian.com/api' : '/api';
  var _user     = null;
  var _chipId   = 'auth-chip';
  var _loginCbs  = [];
  var _logoutCbs = [];

  // ── Styles injection ──────────────────────────────────────────────────────────

  function _injectStyles() {
    if (document.getElementById('sh-auth-styles')) return;
    var s = document.createElement('style');
    s.id = 'sh-auth-styles';
    s.textContent = [
      /* chip */
      '.sh-chip{display:inline-flex;align-items:center;flex-wrap:wrap;gap:0;}',
      '.sh-signed-out{font-family:"Rye",serif;font-size:0.52rem;letter-spacing:0.15em;text-transform:uppercase;color:var(--gold-light);text-decoration:none;opacity:0.85;}',
      '.sh-signed-out:hover{opacity:1;}',
      '.sh-signed-in{font-family:"Crimson Text",Georgia,serif;font-size:0.82rem;color:var(--parchment);opacity:0.85;}',
      '.sh-signed-in strong{color:var(--cream);}',
      '.sh-profile-link,.sh-signout-link{margin-left:10px;color:var(--gold-light);font-size:0.78rem;text-decoration:none;font-family:"Crimson Text",Georgia,serif;}',
      '.sh-signout-link{color:var(--parchment);opacity:0.7;}',
      '.sh-profile-link:hover,.sh-signout-link:hover{text-decoration:underline;opacity:1;}',
      /* modal overlay */
      '.sh-modal-overlay{display:none;position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,0.72);align-items:center;justify-content:center;}',
      '.sh-modal-overlay.sh-open{display:flex;}',
      /* modal card */
      '.sh-modal-card{background:var(--brown-dark);border:2px solid var(--gold);border-radius:2px;padding:32px 36px;width:420px;max-width:calc(100vw - 32px);box-shadow:8px 8px 0 rgba(0,0,0,0.35);position:relative;}',
      '.sh-modal-close{position:absolute;top:14px;right:16px;background:none;border:none;cursor:pointer;color:var(--brown-light);font-size:1.1rem;line-height:1;transition:color 0.2s;}',
      '.sh-modal-close:hover{color:var(--gold);}',
      '.sh-modal-tabs{display:flex;border-bottom:1px solid var(--brown-mid);margin-bottom:24px;}',
      '.sh-modal-tab{background:none;border:none;border-bottom:2px solid transparent;margin-bottom:-1px;cursor:pointer;font-family:"Rye",serif;font-size:0.58rem;letter-spacing:0.18em;text-transform:uppercase;color:var(--brown-light);padding:10px 16px;opacity:0.6;transition:opacity 0.2s,color 0.2s;}',
      '.sh-modal-tab:hover{opacity:0.85;}',
      '.sh-modal-tab.sh-active{opacity:1;color:var(--gold-light);border-bottom-color:var(--gold-light);}',
      '.sh-modal-label{font-family:"Rye",serif;font-size:0.58rem;letter-spacing:0.22em;text-transform:uppercase;color:var(--gold);display:block;margin-bottom:8px;}',
      '.sh-modal-field{width:100%;background:rgba(255,255,255,0.06);border:1px solid var(--brown-mid);color:var(--cream);font-family:"Crimson Text",serif;font-size:1rem;padding:8px 12px;border-radius:2px;outline:none;transition:border-color 0.2s;box-sizing:border-box;margin-bottom:14px;}',
      '.sh-modal-field:focus{border-color:var(--gold);}',
      '.sh-modal-field::placeholder{color:rgba(255,255,255,0.25);font-style:italic;}',
      '.sh-modal-hint{font-family:"Crimson Text",serif;font-size:0.78rem;color:var(--brown-light);font-style:italic;margin-bottom:14px;}',
      '.sh-modal-err{display:none;background:var(--red);border:1px solid #a02020;color:var(--cream);font-family:"Crimson Text",serif;font-style:italic;font-size:0.88rem;padding:8px 12px;border-radius:2px;margin-bottom:14px;}',
      '.sh-modal-submit{width:100%;height:40px;background:var(--green);border:2px solid var(--gold);color:var(--gold-light);font-family:"Rye",serif;font-size:0.58rem;letter-spacing:0.18em;text-transform:uppercase;cursor:pointer;border-radius:2px;transition:background 0.2s,color 0.2s;}',
      '.sh-modal-submit:hover{background:var(--gold);color:var(--brown-dark);}',
      '.sh-modal-link{color:var(--gold-light);font-size:0.82rem;text-decoration:none;font-family:"Crimson Text",Georgia,serif;}',
      '.sh-modal-link:hover{text-decoration:underline;}',
      '.sh-modal-forgot-row{text-align:right;margin-top:-6px;margin-bottom:14px;}',
      '.sh-modal-link-row{text-align:center;margin-top:10px;}',
    ].join('');
    document.head.appendChild(s);
  }

  // ── Modal HTML injection ──────────────────────────────────────────────────────

  function _injectModal() {
    if (document.getElementById('sh-auth-modal')) return;
    var wrap = document.createElement('div');
    wrap.innerHTML =
      '<div id="sh-auth-modal" class="sh-modal-overlay">' +
        '<div class="sh-modal-card">' +
          '<button class="sh-modal-close" onclick="SharedAuth._closeModal()" title="Close">&#x2715;</button>' +
          '<div class="sh-modal-tabs" id="sh-modal-tabs-row">' +
            '<button id="sh-tab-login"    class="sh-modal-tab sh-active" onclick="SharedAuth._switchTab(\'login\')">Sign In</button>' +
            '<button id="sh-tab-register" class="sh-modal-tab"           onclick="SharedAuth._switchTab(\'register\')">Create Account</button>' +
          '</div>' +
          '<div id="sh-login-form">' +
            '<label class="sh-modal-label">Email</label>' +
            '<input type="email"    id="sh-email-l" class="sh-modal-field" placeholder="your@email.com" />' +
            '<label class="sh-modal-label">Password</label>' +
            '<input type="password" id="sh-pass-l"  class="sh-modal-field" placeholder="••••••••" />' +
            '<div class="sh-modal-forgot-row"><a href="#" class="sh-modal-link" onclick="SharedAuth._showForgot();return false;">Forgot password?</a></div>' +
            '<div class="sh-modal-err" id="sh-err-l"></div>' +
            '<button class="sh-modal-submit" onclick="SharedAuth._submitLogin()">Sign In</button>' +
          '</div>' +
          '<div id="sh-register-form" style="display:none;">' +
            '<label class="sh-modal-label">Email</label>' +
            '<input type="email"    id="sh-email-r"  class="sh-modal-field" placeholder="your@email.com" />' +
            '<label class="sh-modal-label">Password</label>' +
            '<input type="password" id="sh-pass-r"   class="sh-modal-field" placeholder="min 12 chars" />' +
            '<div class="sh-modal-hint">Minimum 12 characters · uppercase · lowercase · number · symbol</div>' +
            '<label class="sh-modal-label">Confirm Password</label>' +
            '<input type="password" id="sh-pass-r2"  class="sh-modal-field" placeholder="••••••••" />' +
            '<div class="sh-modal-err" id="sh-err-r"></div>' +
            '<button class="sh-modal-submit" onclick="SharedAuth._submitRegister()">Create Account</button>' +
          '</div>' +
          '<div id="sh-verify-form" style="display:none;">' +
            '<div class="sh-modal-hint" id="sh-verify-hint">Enter the 6-digit code we emailed you.</div>' +
            '<label class="sh-modal-label">Verification Code</label>' +
            '<input type="text" inputmode="numeric" maxlength="6" id="sh-verify-code" class="sh-modal-field" placeholder="123456" />' +
            '<div class="sh-modal-err" id="sh-err-v"></div>' +
            '<button class="sh-modal-submit" onclick="SharedAuth._submitVerify()">Verify</button>' +
            '<div class="sh-modal-link-row"><a href="#" class="sh-modal-link" onclick="SharedAuth._resendCode();return false;">Resend code</a></div>' +
          '</div>' +
          '<div id="sh-forgot-form" style="display:none;">' +
            '<label class="sh-modal-label">Email</label>' +
            '<input type="email" id="sh-email-f" class="sh-modal-field" placeholder="your@email.com" />' +
            '<div class="sh-modal-hint">We\'ll email you a 6-digit code to reset your password.</div>' +
            '<div class="sh-modal-err" id="sh-err-f"></div>' +
            '<button class="sh-modal-submit" onclick="SharedAuth._submitForgot()">Send Reset Code</button>' +
            '<div class="sh-modal-link-row"><a href="#" class="sh-modal-link" onclick="SharedAuth._switchTab(\'login\');return false;">Back to sign in</a></div>' +
          '</div>' +
          '<div id="sh-reset-form" style="display:none;">' +
            '<div class="sh-modal-hint">Enter the code we emailed you and choose a new password.</div>' +
            '<label class="sh-modal-label">Reset Code</label>' +
            '<input type="text" inputmode="numeric" maxlength="6" id="sh-reset-code" class="sh-modal-field" placeholder="123456" />' +
            '<label class="sh-modal-label">New Password</label>' +
            '<input type="password" id="sh-reset-pass"  class="sh-modal-field" placeholder="min 12 chars" />' +
            '<label class="sh-modal-label">Confirm New Password</label>' +
            '<input type="password" id="sh-reset-pass2" class="sh-modal-field" placeholder="••••••••" />' +
            '<div class="sh-modal-err" id="sh-err-reset"></div>' +
            '<button class="sh-modal-submit" onclick="SharedAuth._submitReset()">Reset Password</button>' +
            '<div class="sh-modal-link-row"><a href="#" class="sh-modal-link" onclick="SharedAuth._resendResetCode();return false;">Resend code</a></div>' +
          '</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(wrap.firstElementChild);

    // Click outside to close
    document.getElementById('sh-auth-modal').addEventListener('click', function (e) {
      if (e.target === this) SharedAuth._closeModal();
    });
    // Enter to submit
    document.getElementById('sh-pass-l').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') SharedAuth._submitLogin();
    });
    document.getElementById('sh-pass-r2').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') SharedAuth._submitRegister();
    });
    document.getElementById('sh-verify-code').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') SharedAuth._submitVerify();
    });
    document.getElementById('sh-email-f').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') SharedAuth._submitForgot();
    });
    document.getElementById('sh-reset-pass2').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') SharedAuth._submitReset();
    });
  }

  // ── Chip rendering ────────────────────────────────────────────────────────────

  function _renderChip() {
    var container = document.getElementById(_chipId);
    if (!container) return;
    if (_user) {
      var displayName = esc(_user.name || _user.email);
      container.innerHTML =
        '<span class="sh-chip sh-signed-in">' +
          'Signed in as <strong style="margin-left:4px;">' + displayName + '</strong>' +
          '<a href="/myprofile" class="sh-profile-link">View my profile</a>' +
          (_user.is_admin ? '<a href="/admin" class="sh-profile-link">Site Lead</a>' : '') +
          '<a href="#" class="sh-signout-link" onclick="SharedAuth._logout();return false;">Sign out</a>' +
        '</span>';
    } else {
      container.innerHTML =
        '<a href="#" class="sh-chip sh-signed-out" onclick="SharedAuth.openModal();return false;">Sign In</a>';
    }
  }

  // ── Modal controls ────────────────────────────────────────────────────────────

  var _pendingEmail = null; // email awaiting verification or password reset

  function _openModal() {
    var modal = document.getElementById('sh-auth-modal');
    if (!modal) return;
    modal.classList.add('sh-open');
    _showStep('login');
    _pendingEmail = null;
    ['sh-email-l', 'sh-pass-l', 'sh-email-r', 'sh-pass-r', 'sh-pass-r2',
     'sh-verify-code', 'sh-email-f', 'sh-reset-code', 'sh-reset-pass', 'sh-reset-pass2'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.value = '';
    });
    ['sh-err-l', 'sh-err-r', 'sh-err-v', 'sh-err-f', 'sh-err-reset'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) { el.style.display = 'none'; el.textContent = ''; }
    });
    // Focus email field
    var emailEl = document.getElementById('sh-email-l');
    if (emailEl) setTimeout(function () { emailEl.focus(); }, 50);
  }

  function _closeModal() {
    var modal = document.getElementById('sh-auth-modal');
    if (modal) modal.classList.remove('sh-open');
  }

  // step: 'login' | 'register' | 'verify' | 'forgot' | 'reset'
  function _showStep(step) {
    var forms = { login: 'sh-login-form', register: 'sh-register-form', verify: 'sh-verify-form', forgot: 'sh-forgot-form', reset: 'sh-reset-form' };
    Object.keys(forms).forEach(function (k) {
      var el = document.getElementById(forms[k]);
      if (el) el.style.display = (k === step) ? '' : 'none';
    });
    var tabsRow = document.getElementById('sh-modal-tabs-row');
    if (tabsRow) tabsRow.style.display = (step === 'login' || step === 'register') ? '' : 'none';
    document.getElementById('sh-tab-login').classList.toggle('sh-active',    step === 'login');
    document.getElementById('sh-tab-register').classList.toggle('sh-active', step === 'register');
  }

  function _switchTab(tab) {
    _showStep(tab);
  }

  function _goToVerify(email) {
    _pendingEmail = email;
    document.getElementById('sh-verify-code').value = '';
    document.getElementById('sh-verify-hint').textContent = 'Enter the 6-digit code we emailed to ' + email + '.';
    document.getElementById('sh-err-v').style.display = 'none';
    _showStep('verify');
  }

  function _showForgot() {
    document.getElementById('sh-email-f').value = document.getElementById('sh-email-l').value || '';
    document.getElementById('sh-err-f').style.display = 'none';
    _showStep('forgot');
  }

  // ── Network helpers ───────────────────────────────────────────────────────────

  async function _authPost(url, body) {
    var r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    });
    var data;
    try { data = await r.json(); } catch (e) { throw new Error('Server error (' + r.status + ')'); }
    if (data.error) throw new Error(data.error);
    return data;
  }

  async function _refreshUser() {
    try {
      var r = await fetch(_apiBase + '/auth/me', { credentials: 'include' });
      var d = await r.json();
      _user = d.user || null;
    } catch (_) { _user = null; }
  }

  // ── Auth actions (private implementations) ────────────────────────────────────

  async function _submitLogin() {
    var email = document.getElementById('sh-email-l').value.trim();
    var pass  = document.getElementById('sh-pass-l').value;
    var err   = document.getElementById('sh-err-l');
    err.style.display = 'none';
    try {
      var data = await _authPost(_apiBase + '/auth/login', { email: email, password: pass });
      if (data && data.needsVerification) { _goToVerify(data.email || email); return; }
      _user = (data && data.user) || null;
      if (!_user) await _refreshUser();
      _renderChip();
      _closeModal();
      _loginCbs.forEach(function (cb) { cb(_user); });
    } catch (e) { err.textContent = e.message; err.style.display = 'block'; }
  }

  async function _submitRegister() {
    var email = document.getElementById('sh-email-r').value.trim();
    var pass  = document.getElementById('sh-pass-r').value;
    var pass2 = document.getElementById('sh-pass-r2').value;
    var err   = document.getElementById('sh-err-r');
    err.style.display = 'none';
    if (pass !== pass2) { err.textContent = 'Passwords do not match'; err.style.display = 'block'; return; }
    try {
      var data = await _authPost(_apiBase + '/auth/register', { email: email, password: pass });
      if (data && data.needsVerification) { _goToVerify(data.email || email); return; }
      _user = (data && data.user) || null;
      if (!_user) await _refreshUser();
      _renderChip();
      _closeModal();
      _loginCbs.forEach(function (cb) { cb(_user); });
    } catch (e) { err.textContent = e.message; err.style.display = 'block'; }
  }

  async function _submitVerify() {
    var code = document.getElementById('sh-verify-code').value.trim();
    var err  = document.getElementById('sh-err-v');
    err.style.display = 'none';
    try {
      var data = await _authPost(_apiBase + '/auth/verify-email', { email: _pendingEmail, code: code });
      _user = (data && data.user) || null;
      if (!_user) await _refreshUser();
      _renderChip();
      _closeModal();
      _loginCbs.forEach(function (cb) { cb(_user); });
    } catch (e) { err.textContent = e.message; err.style.display = 'block'; }
  }

  async function _resendCode() {
    var err = document.getElementById('sh-err-v');
    try {
      await _authPost(_apiBase + '/auth/resend-code', { email: _pendingEmail });
      err.textContent = 'Code resent.'; err.style.display = 'block';
    } catch (e) { err.textContent = e.message; err.style.display = 'block'; }
  }

  async function _submitForgot() {
    var email = document.getElementById('sh-email-f').value.trim();
    var err   = document.getElementById('sh-err-f');
    err.style.display = 'none';
    try {
      await _authPost(_apiBase + '/auth/forgot-password', { email: email });
      _pendingEmail = email;
      ['sh-reset-code', 'sh-reset-pass', 'sh-reset-pass2'].forEach(function (id) {
        document.getElementById(id).value = '';
      });
      document.getElementById('sh-err-reset').style.display = 'none';
      _showStep('reset');
    } catch (e) { err.textContent = e.message; err.style.display = 'block'; }
  }

  async function _resendResetCode() {
    var err = document.getElementById('sh-err-reset');
    try {
      await _authPost(_apiBase + '/auth/forgot-password', { email: _pendingEmail });
      err.textContent = 'Code resent.'; err.style.display = 'block';
    } catch (e) { err.textContent = e.message; err.style.display = 'block'; }
  }

  async function _submitReset() {
    var code  = document.getElementById('sh-reset-code').value.trim();
    var pass  = document.getElementById('sh-reset-pass').value;
    var pass2 = document.getElementById('sh-reset-pass2').value;
    var err   = document.getElementById('sh-err-reset');
    err.style.display = 'none';
    if (pass !== pass2) { err.textContent = 'Passwords do not match'; err.style.display = 'block'; return; }
    try {
      var data = await _authPost(_apiBase + '/auth/reset-password', { email: _pendingEmail, code: code, newPassword: pass });
      _user = (data && data.user) || null;
      if (!_user) await _refreshUser();
      _renderChip();
      _closeModal();
      _loginCbs.forEach(function (cb) { cb(_user); });
    } catch (e) { err.textContent = e.message; err.style.display = 'block'; }
  }

  async function _logout() {
    try { await fetch(_apiBase + '/auth/logout', { method: 'POST', credentials: 'include' }); } catch (_) {}
    _user = null;
    _renderChip();
    _logoutCbs.forEach(function (cb) { cb(); });
  }

  // ── Public API ────────────────────────────────────────────────────────────────

  window.SharedAuth = {
    async init(opts) {
      opts = opts || {};
      _chipId = opts.chipContainerId || 'auth-chip';
      if (typeof opts.onLogin  === 'function') _loginCbs.push(opts.onLogin);
      if (typeof opts.onLogout === 'function') _logoutCbs.push(opts.onLogout);

      _injectStyles();
      _renderChip(); // render "Sign In" immediately while fetch is in-flight
      _injectModal();

      try {
        var r = await fetch(_apiBase + '/auth/me', { credentials: 'include' });
        var d = await r.json();
        _user = d.user || null;
      } catch (_) { _user = null; }

      _renderChip();
      return _user;
    },

    getUser:            function () { return _user; },
    openModal:          _openModal,
    _closeModal:        _closeModal,
    _switchTab:         _switchTab,
    _submitLogin:       _submitLogin,
    _submitRegister:    _submitRegister,
    _showForgot:        _showForgot,
    _submitVerify:      _submitVerify,
    _resendCode:        _resendCode,
    _submitForgot:      _submitForgot,
    _resendResetCode:   _resendResetCode,
    _submitReset:       _submitReset,
    _logout:            _logout,
  };

})();
