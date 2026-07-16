// DeckyAM player daemon — hidden castlabs Electron window hosting MusicKit JS.
// Controlled externally over CDP (remote debugging port), same as the old
// Chrome ghost player, so the plugin backend's cdp_* calls work unchanged.
const { app, BrowserWindow, components, session } = require("electron");
const http = require("http");
const fs = require("fs");
const path = require("path");

const CDP_PORT = 9224;
const PAGE_PORT = 9225;

function parseArgs() {
  const args = { show: false, config: null };
  for (const a of process.argv.slice(1)) {
    if (a === "--show") args.show = true;
    else if (a.startsWith("--config=")) args.config = a.slice("--config=".length);
  }
  return args;
}
const cli = parseArgs();

let logStream = null;
function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(" ")}`;
  console.log(line);
  try {
    if (!logStream) {
      logStream = fs.createWriteStream(path.join(app.getPath("userData"), "player.log"), { flags: "a" });
    }
    logStream.write(line + "\n");
  } catch (_) {}
}

function readConfig() {
  const candidates = [
    cli.config,
    path.join(app.getPath("userData"), "config.json"),
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
        log("Loaded config from", p);
        return cfg;
      }
    } catch (e) {
      log("Bad config at", p, String(e));
    }
  }
  log("WARNING: no config found; MusicKit will not authenticate");
  return {};
}

// Flags must be set before app ready.
app.commandLine.appendSwitch("remote-debugging-port", String(CDP_PORT));
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
// NOTE: --no-sandbox and --no-zygote are passed on the command line by the
// launcher (see launch script / plugin backend), not here. They are essential
// on SteamOS: the Chromium zygote hardens itself by chdir'ing into /proc, which
// breaks in this session context so the forked CDM/Decryptor process gets ESRCH
// on every syscall (can't allocate its shared-memory decrypt buffer) and
// playback fails with "decrypt error 3". Passing them as real argv (rather than
// appendSwitch) is required for Chromium's early zygote/sandbox check to see
// them together.
// Plausible Chrome UA so Apple's CDN/API treats us like a normal browser.
app.userAgentFallback =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

if (!app.requestSingleInstanceLock()) {
  console.log("Another instance is already running; exiting.");
  app.exit(0);
}

let win = null;                 // playback window
let currentConfig = {};         // live config (tokens), updated by sign-in
let signInWindow = null;
let loginPopup = null;          // popup child window, if authorize() opens one


// Interactive "Sign in to Apple Music". Two modes:
//   visible  — a real fullscreen music.apple.com window the user logs into by
//              hand (legacy; needs gamescope surfacing + STEAM_GAME atom).
//   hidden   — an offscreen window the plugin drives over /logindrive: it calls
//              MusicKit.authorize(), then the plugin fills the email/password/
//              2FA fields in Apple's login iframe invisibly.
// Either way, once a media-user-token appears we apply it to the live playback
// page + cache and close the window.
function openSignIn(opts = {}) {
  const hidden = !!opts.hidden;
  if (signInWindow && !signInWindow.isDestroyed()) {
    if (hidden) {
      // A hidden, plugin-driven login always starts clean: a previous attempt
      // may have stranded the window on Apple's error/2FA page (no MusicKit),
      // which would hang the next authorize(). Tear it down and recreate.
      try { signInWindow.destroy(); } catch (_) {}
      signInWindow = null; loginPopup = null;
    } else {
      try { signInWindow.show(); signInWindow.focus(); } catch (_) {}
      return;
    }
  }
  const w = new BrowserWindow({
    width: 1280, height: 800,
    show: !hidden, center: true,
    alwaysOnTop: !hidden, fullscreen: !hidden, focusable: true,
    title: "Sign in to Apple Music",
    // webSecurity:false lets us read/drive Apple's cross-origin login iframe
    // (idmsa) so the plugin can fill it invisibly.
    webPreferences: { partition: "persist:deckyam", plugins: true, webSecurity: false },
  });
  signInWindow = w;
  loginPopup = null;
  // If authorize() opens a popup (window.open) instead of an in-page iframe,
  // keep a handle to it so driveLogin can target it.
  try {
    w.webContents.setWindowOpenHandler(() => ({ action: "allow" }));
    w.webContents.on("did-create-window", (child) => {
      loginPopup = child;
      child.on("closed", () => { if (loginPopup === child) loginPopup = null; });
    });
  } catch (_) {}
  if (!hidden) {
    try { w.setAlwaysOnTop(true, "screen-saver"); } catch (_) {}
  }
  w.on("closed", () => { if (signInWindow === w) signInWindow = null; loginPopup = null; });
  if (!hidden) {
    w.once("ready-to-show", () => {
      try { w.show(); w.focus(); w.moveTop(); } catch (_) {}
      // gamescope only surfaces windows tagged as Steam apps; without this the
      // sign-in window stays invisible in Gaming Mode.
      try {
        const xid = w.getNativeWindowHandle().readUInt32LE(0);
        require("child_process").execFile(
          "xprop", ["-id", "0x" + xid.toString(16), "-f", "STEAM_GAME", "32c", "-set", "STEAM_GAME", "769"],
          () => {}
        );
      } catch (e) { log("STEAM_GAME atom set failed:", String(e)); }
    });
  }
  // Load music.apple.com, retrying transient failures — a tester's first run
  // can hit flaky network, and a single silent load failure would otherwise
  // leave MusicKit never loading ("MusicKit did not load in sign-in window").
  const SIGNIN_URL = "https://music.apple.com/us/browse";
  let signInLoadAttempts = 0;
  const loadSignIn = () => {
    signInLoadAttempts++;
    w.loadURL(SIGNIN_URL).catch((e) => log("signin load attempt", signInLoadAttempts, "failed:", String(e)));
  };
  w.webContents.on("did-fail-load", (_e, errorCode, errorDesc, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return; // -3 = ERR_ABORTED (superseded nav)
    log("signin did-fail-load:", errorCode, errorDesc, validatedURL);
    if (signInLoadAttempts < 6 && !w.isDestroyed()) {
      setTimeout(() => { if (!w.isDestroyed()) loadSignIn(); }, 2000);
    }
  });
  loadSignIn();

  // Poll for a captured media-user-token for as long as the window is open (no
  // fixed deadline — a hidden driven login or a slow manual login can take a
  // while). A 15-minute safety cap prevents a leaked forever-loop.
  const safetyCap = Date.now() + 15 * 60 * 1000;
  (async () => {
    while (!w.isDestroyed() && Date.now() < safetyCap) {
      const mut = await captureSignInToken(w);
      if (mut) { if (!w.isDestroyed()) w.destroy(); return; }
      await new Promise((r) => setTimeout(r, 1000));
    }
  })();
}

// Read the media-user-token from the sign-in window (top frame, or a popup),
// and if present apply it live to the playback page + cache. Returns the token
// or null.
async function captureSignInToken(w) {
  const targets = [w];
  if (loginPopup && !loginPopup.isDestroyed()) targets.push(loginPopup);
  for (const t of targets) {
    if (!t || t.isDestroyed()) continue;
    const tok = await t.webContents.executeJavaScript(`(() => {
      try {
        let dev = null, mut = null;
        const mk = window.MusicKit && MusicKit.getInstance();
        if (mk) { dev = mk.developerToken || null; mut = mk.musicUserToken || null; }
        // The full-page authorize() redirect ends at
        // authorize.music.apple.com with the token in the query string, on a
        // page that has no MusicKit instance — so also read it from the URL.
        if (!mut) {
          try { mut = new URL(location.href).searchParams.get('musicUserToken') || null; } catch (e) {}
        }
        return { dev, mut };
      } catch (e) { return null; }
    })()`).catch(() => null);
    if (tok && tok.mut) {
      currentConfig.developerToken = tok.dev || currentConfig.developerToken;
      currentConfig.musicUserToken = tok.mut;
      writeTokenCache({ dev: currentConfig.developerToken, mut: tok.mut });
      log("Sign-in captured user token");
      if (win && !win.isDestroyed()) {
        await win.webContents.executeJavaScript(
          `(() => { try { const mk = MusicKit.getInstance(); mk.musicUserToken = ${JSON.stringify(tok.mut)}; return true; } catch (e) { return false; } })()`
        ).catch(() => {});
      }
      return tok.mut;
    }
  }
  return null;
}

// The window the login form lives in — a popup if authorize() opened one,
// otherwise the main sign-in window (in-page iframe flow).
function loginTarget() {
  if (loginPopup && !loginPopup.isDestroyed()) return loginPopup;
  if (signInWindow && !signInWindow.isDestroyed()) return signInWindow;
  return null;
}

// Injected DOM helpers (as a string prepended to every drive action). Walks
// into Apple's login document — which may be this page itself (popup navigated
// to idmsa), or nested iframes (music.apple.com navigator -> idmsa). webSecurity
// is off so cross-origin contentDocument is readable.
const LOGIN_HELPERS = `
  function _damIdmsaDoc() {
    // The real credential/2FA form is the appleauth/auth widget, which on the
    // OAuth full-page flow is a same-origin iframe nested inside the
    // idmsa.apple.com/IDMSWebAuth/auth page (NOT that top page itself).
    const isForm = (u) => /appleauth\\/auth/i.test(u || '');
    try { if (isForm(location.href)) return document; } catch (e) {}
    const scan = (root, depth) => {
      if (!root || depth > 5) return null;
      let frames = [];
      try { frames = Array.from(root.querySelectorAll('iframe')); } catch (e) { return null; }
      for (const f of frames) {
        try { if (isForm(f.src) && f.contentDocument) return f.contentDocument; } catch (e) {}
      }
      for (const f of frames) {
        try { if (f.contentDocument) { const r = scan(f.contentDocument, depth + 1); if (r) return r; } } catch (e) {}
      }
      return null;
    };
    return scan(document, 0);
  }
  function _damSet(el, val) {
    try {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, val);
    } catch (e) { el.value = val; }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function _damVisible(el) { return !!(el && el.offsetParent !== null && !el.disabled); }
  function _damClickContinue(doc) {
    const btns = Array.from(doc.querySelectorAll('button, [role="button"], input[type="submit"]')).filter(_damVisible);
    const txt = (x) => (x.textContent || x.value || '').trim();
    const norm = (x) => txt(x).toLowerCase();
    // Never take the passwordless "Sign in with iPhone"/passkey path (it hangs
    // in this embedded browser), the resend/help links, or "Don't Trust".
    const banned = /iphone|passkey|another device|can.?t get|resend|forgot|don.?t trust/;
    const cands = btns.filter(x => !banned.test(norm(x)));
    // Priority order; "Trust" (this browser) is preferred over "Not Now" so the
    // trusted-device cookie is stored and future sign-ins skip 2FA.
    const prefs = ['continue with password', 'trust', 'sign in', 'continue', 'verify', 'next', 'not now'];
    for (const p of prefs) {
      const b = cands.find(x => norm(x) === p) || cands.find(x => norm(x).includes(p));
      if (b) { b.click(); return txt(b); }
    }
    return null;
  }
  function _damError(doc) {
    const sel = '.form-message--error, .form-message, [role="alert"], .error, .fieldError, .signin-error';
    for (const e of Array.from(doc.querySelectorAll(sel))) {
      if (_damVisible(e) && (e.textContent || '').trim()) return (e.textContent || '').trim();
    }
    return null;
  }
`;

// Build the JS for one drive action. Runs in the login window's top frame.
function loginActionScript(action, value) {
  const V = JSON.stringify(value == null ? "" : value);
  const body = {
    // Kick off MusicKit's authorize() flow. userGesture is passed at call time.
    start: `
      try {
        const mk = window.MusicKit && MusicKit.getInstance();
        if (!mk) return { ok: false, ready: false, reason: 'no MusicKit yet',
          hasWindowMK: !!window.MusicKit, url: location.href, readyState: document.readyState };
        if (mk.isAuthorized) return { ok: true, ready: true, authorized: true };
        if (!window.__damAuth) {
          window.__damAuth = true;
          window.__damMut = null; window.__damErr = null;
          Promise.resolve(mk.authorize())
            .then((tok) => { window.__damMut = tok || (mk.musicUserToken || ''); })
            .catch((e) => { window.__damErr = String((e && e.message) || e); });
        }
        return { ok: true, ready: true, started: true };
      } catch (e) { return { ok: false, reason: String(e) }; }
    `,
    email: `
      const doc = _damIdmsaDoc();
      if (!doc) return { ok: false, reason: 'no login doc' };
      const el = doc.querySelector('#account_name_text_field, input[autocomplete*="username"], input[name="accountName"], input[type="email"], input[type="text"]');
      if (!el || !_damVisible(el)) return { ok: false, reason: 'no email field' };
      el.focus(); _damSet(el, ${V});
      return { ok: true };
    `,
    password: `
      const doc = _damIdmsaDoc();
      if (!doc) return { ok: false, reason: 'no login doc' };
      const el = doc.querySelector('#password_text_field, input[type="password"], input[autocomplete*="current-password"]');
      if (!el || !_damVisible(el)) return { ok: false, reason: 'no password field' };
      el.focus(); _damSet(el, ${V});
      return { ok: true };
    `,
    code: `
      const doc = _damIdmsaDoc();
      if (!doc) return { ok: false, reason: 'no login doc' };
      const digits = String(${V}).replace(/\\D/g, '').split('');
      // Apple's web 2FA is N single-digit boxes (class form-security-code-input,
      // type=tel, no id/maxLength). They auto-advance and auto-submit on the last
      // digit. Fill each with the native setter + a real InputEvent so the React
      // component registers each keystroke.
      let cells = Array.from(doc.querySelectorAll('input.form-security-code-input'));
      if (cells.length < digits.length) {
        cells = Array.from(doc.querySelectorAll('input')).filter(i =>
          _damVisible(i) && (i.type === 'tel' || i.type === 'number' ||
            (i.type === 'text' && (i.maxLength === 1 || i.inputMode === 'numeric'))));
      }
      cells = cells.filter(_damVisible);
      if (cells.length >= digits.length && cells.length >= 4) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        for (let k = 0; k < digits.length; k++) {
          const el = cells[k];
          el.focus();
          setter.call(el, digits[k]);
          el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: digits[k] }));
        }
        return { ok: true, mode: 'multi', cells: cells.length };
      }
      // Fallback: a single combined code field.
      const single = doc.querySelector('input[inputmode="numeric"], input[type="tel"], input.form-textbox-input');
      if (single && _damVisible(single)) { single.focus(); _damSet(single, digits.join('')); return { ok: true, mode: 'single' }; }
      return { ok: false, reason: 'no code field', cells: cells.length };
    `,
    submit: `
      const doc = _damIdmsaDoc();
      if (!doc) return { ok: false, reason: 'no login doc' };
      const clicked = _damClickContinue(doc);
      return { ok: !!clicked, clicked: clicked };
    `,
    // Rich diagnostic snapshot used by the backend to sequence steps and to
    // capture the (untested) 2FA DOM live.
    probe: `
      const out = { ok: true, mut: window.__damMut || null, authErr: window.__damErr || null, authStarted: !!window.__damAuth, url: location.href };
      try { const mk = window.MusicKit && MusicKit.getInstance(); out.hasMK = !!mk; out.authorized = !!(mk && mk.isAuthorized); if (mk && mk.musicUserToken) out.mut = out.mut || mk.musicUserToken; } catch (e) {}
      const doc = _damIdmsaDoc();
      out.hasLoginDoc = !!doc;
      if (doc) {
        out.idmsaUrl = doc.location ? doc.location.href : null;
        const email = doc.querySelector('#account_name_text_field, input[autocomplete*="username"], input[type="email"]');
        const pw = doc.querySelector('#password_text_field, input[type="password"]');
        out.emailField = _damVisible(email);
        out.passwordField = _damVisible(pw);
        const codeInputs = Array.from(doc.querySelectorAll('input')).filter(i => _damVisible(i) && (i.maxLength === 1 || /char|digit|code|security/i.test(i.id + ' ' + i.className)));
        out.codeField = codeInputs.length > 0;
        out.codeInputCount = codeInputs.length;
        out.error = _damError(doc);
        out.buttons = Array.from(doc.querySelectorAll('button, [role="button"]')).filter(_damVisible).map(b => (b.textContent || '').trim()).filter(Boolean).slice(0, 8);
        out.inputSummary = Array.from(doc.querySelectorAll('input')).filter(_damVisible).map(i => ({ id: i.id, type: i.type, name: i.name, ml: i.maxLength, ph: i.placeholder })).slice(0, 12);
      }
      return out;
    `,
  }[action];
  if (!body) return null;
  return `(() => {\n${LOGIN_HELPERS}\ntry {\n${body}\n} catch (e) { return { ok: false, reason: String((e && e.message) || e) }; }\n})()`;
}

// Execute one login-drive action against the login window and return its result.
async function driveLogin(action, value) {
  const t = loginTarget();
  if (!t) return { ok: false, error: "no signin window" };
  // Re-load the sign-in page (used if MusicKit never appeared — a stalled load).
  if (action === "reload") {
    try { t.loadURL("https://music.apple.com/us/browse"); return { ok: true, reloaded: true }; }
    catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  }
  const script = loginActionScript(action, value);
  if (!script) return { ok: false, error: "unknown action: " + action };
  // authorize() may require a user gesture; grant one for the start action.
  const userGesture = action === "start" || action === "submit";
  const r = await t.webContents
    .executeJavaScript(script, userGesture)
    .catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
  return r || { ok: false, error: "no result" };
}

// Serve the MusicKit page over localhost so it runs in a secure context
// (required for EME/Widevine) without needing music.apple.com.
function startPageServer() {
  const pageHtml = fs.readFileSync(path.join(__dirname, "page", "index.html"), "utf8");
  const server = http.createServer((req, res) => {
    const pathname = req.url.split("?")[0];
    if (pathname === "/logindrive") {
      // POST { action, value } — drive Apple's login form invisibly.
      let body = "";
      req.on("data", (c) => { body += c; if (body.length > 8192) req.destroy(); });
      req.on("end", async () => {
        let j = {};
        try { j = JSON.parse(body || "{}"); } catch (_) {}
        let out;
        try { out = await driveLogin(j.action, j.value); }
        catch (e) { out = { ok: false, error: String((e && e.message) || e) }; }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(out || { ok: false, error: "no result" }));
      });
      return;
    }
    if (req.url === "/config") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(currentConfig));
    } else if (pathname === "/signin") {
      const hidden = /[?&]hidden=1\b/.test(req.url);
      openSignIn({ hidden });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ opened: true, hidden }));
    } else if (req.url === "/signout") {
      (async () => {
        try {
          currentConfig.musicUserToken = "";
          writeTokenCache({ dev: currentConfig.developerToken, mut: "" });
          // Clear the persistent Apple login (cookies etc.) so it doesn't come
          // back on the next harvest — this is what makes account-switching work.
          await session.fromPartition("persist:deckyam").clearStorageData();
          if (win && !win.isDestroyed()) {
            await win.webContents.executeJavaScript(
              "(() => { try { MusicKit.getInstance().musicUserToken = ''; return true; } catch (e) { return false; } })()"
            ).catch(() => {});
          }
          log("Signed out; cleared Apple session");
        } catch (e) { log("signout error:", String(e)); }
      })();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } else if (req.url === "/status") {
      // Report the live boot state of the MusicKit page too, not just the
      // cached token — an offline boot can leave us "signed in" (cached token)
      // while MusicKit never loaded, so the library/api proxy is dead.
      (async () => {
        let mkReady = false, mkError = null, attempts = 0;
        try {
          if (win && !win.isDestroyed()) {
            const s = await win.webContents
              .executeJavaScript("(window.__DECKYAM__ || {})")
              .catch(() => null);
            if (s) { mkReady = !!s.ready; mkError = s.error || null; attempts = s.attempts || 0; }
          }
        } catch (_) {}
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          signedIn: !!currentConfig.musicUserToken,
          hasDevToken: !!currentConfig.developerToken,
          musicKitReady: mkReady,
          musicKitError: mkError,
          bootAttempts: attempts,
        }));
      })();
    } else if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
    } else {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(pageHtml);
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(PAGE_PORT, "127.0.0.1", () => resolve(server));
  });
}

// Where we cache the last-harvested Apple tokens (offline fallback).
function tokenCachePath() {
  return path.join(app.getPath("userData"), "harvested-tokens.json");
}
function readTokenCache() {
  try { return JSON.parse(fs.readFileSync(tokenCachePath(), "utf8")); } catch (_) { return {}; }
}
function writeTokenCache(t) {
  try { fs.writeFileSync(tokenCachePath(), JSON.stringify(t)); } catch (e) { log("token cache write failed:", String(e)); }
}

// Harvest Apple's OWN web-player developer token (and the media-user-token, if
// this browser session is already signed in) by briefly loading
// music.apple.com. This is what lets us run without embedding a developer
// token of our own. Uses the persistent session so a one-time sign-in sticks.
async function harvestTokens({ show = false, timeoutMs = 22000 } = {}) {
  const w = new BrowserWindow({
    width: 1000, height: 740, show,
    webPreferences: { backgroundThrottling: false, plugins: true, partition: "persist:deckyam" },
  });
  let result = null;
  try {
    await w.loadURL("https://music.apple.com/us/browse");
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const t = await w.webContents.executeJavaScript(`(() => {
        try {
          const mk = window.MusicKit && MusicKit.getInstance();
          return mk ? { dev: mk.developerToken || null, mut: mk.musicUserToken || null } : null;
        } catch (e) { return null; }
      })()`).catch(() => null);
      if (t && t.dev) { result = t; break; }
      await new Promise((r) => setTimeout(r, 500));
    }
  } catch (e) {
    log("harvest error:", String(e));
  }
  // Keep the window open only when we're showing it for interactive sign-in.
  if (!show && !w.isDestroyed()) w.destroy();
  return { tokens: result, window: show ? w : null };
}

// Apple's own web-player developer token is bound to the music.apple.com
// origin: its API returns 401 unless the request carries Origin/Referer of
// music.apple.com. Our playback page runs on 127.0.0.1, so rewrite those
// headers on Apple API requests. (The response then carries an ACAO for
// music.apple.com, which is why the playback window disables webSecurity so the
// page — served from 127.0.0.1 — can still read it.)
function installAppleHeaderRewrite(ses) {
  const APPLE = /(^|\.)(music\.apple\.com|api\.music\.apple\.com|amp-api\.music\.apple\.com|play\.itunes\.apple\.com)$/i;
  ses.webRequest.onBeforeSendHeaders((details, cb) => {
    try {
      const host = new URL(details.url).host;
      if (APPLE.test(host)) {
        details.requestHeaders["Origin"] = "https://music.apple.com";
        details.requestHeaders["Referer"] = "https://music.apple.com/";
      }
    } catch (_) {}
    cb({ requestHeaders: details.requestHeaders });
  });
}

app.whenReady().then(async () => {
  log("App ready; waiting for Widevine component...");
  installAppleHeaderRewrite(session.defaultSession);
  try {
    await components.whenReady();
    log("Components ready:", JSON.stringify(components.status()));
  } catch (e) {
    log("ERROR: Widevine component failed:", String(e));
  }

  const config = readConfig();

  // Replace any embedded developer token with Apple's freshly-harvested one.
  const cache = readTokenCache();
  try {
    const { tokens } = await harvestTokens({ show: false });
    if (tokens && tokens.dev) {
      config.developerToken = tokens.dev;
      // Prefer a freshly-harvested (signed-in) user token; otherwise keep any
      // previously captured / configured one.
      config.musicUserToken = tokens.mut || cache.mut || config.musicUserToken || "";
      writeTokenCache({ dev: tokens.dev, mut: config.musicUserToken });
      log("Harvested Apple dev token; user token:", config.musicUserToken ? "present" : "none");
    } else if (cache.dev) {
      config.developerToken = cache.dev;
      config.musicUserToken = cache.mut || config.musicUserToken || "";
      log("Harvest failed; using cached Apple dev token");
    } else {
      log("Harvest failed and no cache; using configured developer token");
    }
  } catch (e) {
    log("Harvest step failed:", String(e));
  }

  currentConfig = config;
  try {
    await startPageServer();
    log(`Page server on http://127.0.0.1:${PAGE_PORT}`);
  } catch (e) {
    log("FATAL: page server failed:", String(e));
    app.exit(1);
    return;
  }

  win = new BrowserWindow({
    width: 800,
    height: 600,
    show: cli.show,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      // Required to enable the Widevine CDM in the renderer's media pipeline.
      // Without this, EME/licensing succeeds but decryption fails (error 3).
      plugins: true,
      // The page talks only to our localhost + Apple; disabling web security
      // lets it read Apple API responses whose CORS allow-origin is
      // music.apple.com (see installAppleHeaderRewrite above).
      webSecurity: false,
    },
  });
  win.on("closed", () => { win = null; });
  win.webContents.on("console-message", (_e, _level, message) => {
    log("[page]", message);
  });
  await win.loadURL(`http://127.0.0.1:${PAGE_PORT}/`);
  log("MusicKit page loaded");
});

// Keep the daemon alive even with no visible windows.
app.on("window-all-closed", () => {});
