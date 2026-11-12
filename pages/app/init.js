// Auth and page start-up. Loads last.

// ── Auth ──────────────────────────────────────────────────────────────────────

function updateTokenRow(user) {
  // When logged in, auth token + ESPN settings live on the profile page — hide from main
  const tokenSection = document.getElementById('auth-token-section');
  if (user) {
    if (tokenSection) tokenSection.style.display = 'none';
    loadEspnSettings();
  } else {
    // Not logged in: show token input (in-memory only)
    if (tokenSection) tokenSection.style.display = '';
    const savedRow = document.getElementById('token-saved-row');
    const inputRow = document.getElementById('token-input-row');
    if (savedRow) savedRow.style.display = 'none';
    if (inputRow) inputRow.style.display = '';
  }
}

function updateSetupCard(user) {
  // Sleeper username is tied to the account when signed in — managed on /myprofile,
  // not entered here. Hide the input; show a hint if the account has no username yet.
  const card  = document.getElementById('setup-card');
  const uname = document.getElementById('username-section');
  const hint  = document.getElementById('profile-hint');
  if (user) {
    if (uname) uname.style.display = 'none';
    const needUsername = !user.sleeper_username;
    if (hint) hint.style.display = needUsername ? '' : 'none';
    // Token section is hidden for logged-in users (see updateTokenRow) — if the
    // username is set too, there's nothing left to configure here.
    if (card) card.style.display = needUsername ? '' : 'none';
  } else {
    if (uname) uname.style.display = '';
    if (hint) hint.style.display = 'none';
    if (card) card.style.display = '';
  }
}

async function loadEspnSettings() {
  // Ensures S.espnSettings is populated — called from updateTokenRow on login
  if (!S.auth) return;
  if (S.espnSettings) return; // already fetched by loadEspnLeagues
  try {
    const r = await fetch('/api/espn/settings', { credentials: 'include' });
    if (!r.ok) return;
    S.espnSettings = await r.json();
  } catch {}
}

function showReplaceToken() {
  document.getElementById('token-saved-row').style.display = 'none';
  document.getElementById('token-input-row').style.display = '';
  const btn = document.getElementById('token-save-acct-btn');
  if (btn && S.auth) btn.style.display = '';
}

async function saveTokenToAccount() {
  const t  = document.getElementById('token-input').value.trim();
  const st = document.getElementById('token-status');
  if (!t) { st.textContent = 'Paste your token first'; st.className = 'setup-status err'; return; }
  S.token = t;
  document.getElementById('token-input').value = '';
  st.textContent = 'Saving…'; st.className = 'setup-status';
  try {
    const r    = await fetch('/api/auth/me', { method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: t }) });
    const data = await r.json();
    if (data.error) throw new Error(data.error);
    if (S.auth) S.auth.has_token = true;
    updateTokenRow(S.auth);
    if (S.tab === 'trades' && S.userId) renderTrades();
  } catch(e) { st.textContent = 'Error: ' + e.message; st.className = 'setup-status err'; }
}

(async function () {
  sw(new URLSearchParams(location.search).get('tab') || 'home', { history: 'replace' });

  function _applyAuth(user) {
    S.auth = user;
    updateTokenRow(user);
    updateSetupCard(user);
    if (user.sleeper_username && !S.userId) {
      document.getElementById('u-input').value = user.sleeper_username;
      loadUser();
    }
  }

  const initUser = await SharedAuth.init({
    chipContainerId: 'auth-chip',
    onLogin:  (user) => { _applyAuth(user); },
    onLogout: ()     => { S.auth = null; updateTokenRow(null); updateSetupCard(null); if (S.tab === 'home') render('home'); },
  });

  // onLogin only fires when signing in via the modal — handle the
  // already-signed-in case (existing session cookie) here.
  if (initUser) _applyAuth(initUser);
})();
