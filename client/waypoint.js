// Waypoint client SDK — shared by every portal page.
//   WaypointAuth : session via the real JWT cookie (GET /api/auth/me), guards, login/logout
//   WaypointRealtime : SSE stream with polling fallback (graceful when SSE is blocked)
//   WaypointGeo : best-effort GPS fix for driver events
//   WaypointUtil : formatting helpers
(function () {
  // ---------- helpers ----------
  async function api(path, opts = {}) {
    const headers = opts.body ? { 'Content-Type': 'application/json' } : {};
    try {
      const token = typeof localStorage !== 'undefined' ? localStorage.getItem('waypoint_token') : null;
      if (token && !headers['Authorization']) headers['Authorization'] = `Bearer ${token}`;
    } catch {}
    if (opts.headers) Object.assign(headers, opts.headers);

    const res = await fetch(path, {
      headers,
      method: opts.method || 'GET',
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
    });
    if (res.status === 401 && opts.on401) opts.on401(res);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `request failed (${res.status})`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function orderRef(id) {
    return id == null ? '—' : `ORD-${String(id).padStart(4, '0')}`;
  }

  function hhmm(dateLike) {
    try {
      return new Date(dateLike).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
      return '—';
    }
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- auth ----------
  // Session lives in the JWT httpOnly cookie (same-origin). The localStorage
  // mirror stays for UI labels AND powers offline re-entry: when the network
  // is down, guard() falls back to it instead of bouncing to the login page
  // (the cookie itself still validates server-side once back online).
  const AUTH_MIRROR = 'delivery_auth_user';
  const Auth = {
    user: null,
    async me(on401) {
      this.user = await api('/api/auth/me', { on401 });
      try { localStorage.setItem(AUTH_MIRROR, JSON.stringify(this.user)); } catch {}
      return this.user;
    },
    async login(username, password) {
      const user = await api('/api/auth/login', { method: 'POST', body: { username, password } });
      try {
        if (user && user.token) localStorage.setItem('waypoint_token', user.token);
        localStorage.setItem(AUTH_MIRROR, JSON.stringify(user));
      } catch {}
      return user;
    },
    async logout() {
      try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
      try {
        localStorage.removeItem('waypoint_token');
        sessionStorage.removeItem(AUTH_MIRROR);
        localStorage.removeItem(AUTH_MIRROR);
      } catch {}
    },
    // Portal guard: resolve the session, require the given role, otherwise bounce
    // to the central login. Resolves null (and shows the lock screen if provided)
    // instead of redirecting when `lockElId` is given (in-page gate mode).
    //
    // Offline mode: if the network is down (SW answers 503 {error:'offline'}),
    // fall back to the cached sessionStorage mirror so operators keep working —
    // reads come from SW snapshots, writes queue in WaypointOffline/outbox.
    async guard(role, opts = {}) {
      const on401 = () => {};
      try {
        const user = await this.me(on401);
        if (role && user.role !== role) {
          if (opts.onWrongRole) return opts.onWrongRole(user);
          window.location.href = 'index.html';
          return null;
        }
        if (opts.lockElId) document.getElementById(opts.lockElId).style.display = 'none';
        if (opts.onReady) opts.onReady(user);
        return user;
      } catch (err) {
        const offlineFailure = err && (err.status === 503 || err.status === undefined || err.status === 0);
        if (offlineFailure) {
          try {
            const cached = JSON.parse(localStorage.getItem(AUTH_MIRROR) || sessionStorage.getItem(AUTH_MIRROR) || 'null');
            const roleOk = cached && (!role || cached.role === role || cached.username === role);
            if (cached && roleOk) {
              if (opts.lockElId) document.getElementById(opts.lockElId).style.display = 'none';
              if (opts.onReady) opts.onReady(cached);
              return cached;
            }
          } catch { /* fall through to redirect */ }
        }
        if (opts.lockElId) {
          document.getElementById(opts.lockElId).style.display = 'flex';
        } else {
          window.location.href = 'index.html';
        }
        return null;
      }
    },
  };

  // ---------- realtime ----------
  // Realtime via SSE /api/stream with role-scoped channels; if the stream cannot
  // open (proxy stripping, serverless), callers fall back to interval polling.
  const Realtime = {
    es: null,
    channels: [],
    handlers: {},
    pollTimer: null,
    pollers: [],
    connected: false,
    backoffMs: 2000,

    on(type, fn) {
      (this.handlers[type] = this.handlers[type] || []).push(fn);
      return this;
    },

    emit(type, data) {
      (this.handlers[type] || []).forEach((fn) => { try { fn(data); } catch (e) { console.error('[rt-handler]', e); } });
    },

    start(channels, { onState } = {}) {
      this.channels = Array.isArray(channels) ? channels : [channels];
      this._onState = onState || (() => {});
      this._open();
      return this;
    },

    _open() {
      if (this.es) { this.es.close(); this.es = null; }
      const qs = this.channels.length ? `?channels=${encodeURIComponent(this.channels.join(','))}` : '';
      try {
        const es = new EventSource(`/api/stream${qs}`);
        this.es = es;
        es.onopen = () => { this.connected = true; this.backoffMs = 2000; this._onState('live'); };
        es.onmessage = (m) => {
          try {
            const env = JSON.parse(m.data);
            if (env.type !== 'hello') this.emit(env.type, env.data || {});
          } catch {}
        };
        es.onerror = () => {
          // EventSource retries on its own, but a persistent failure means the
          // stream is unusable — switch to polling mode after a backoff.
          this.connected = false;
          this._onState('reconnecting');
          if (this.backoffMs > 30000) {
            es.close(); this.es = null;
            this._startPolling();
            this._onState('polling');
          } else {
            this.backoffMs = Math.min(this.backoffMs * 2, 30000);
          }
        };
      } catch {
        this._startPolling();
        this._onState('polling');
      }
    },

    _startPolling() {
      if (this.pollTimer) return;
      this.pollTimer = setInterval(() => this.pollers.forEach((fn) => { try { fn(); } catch {} }), 20000);
    },

    // Register a refresh function used ONLY in polling-fallback mode.
    onPoll(fn) { this.pollers.push(fn); return this; },
    stop() {
      if (this.es) this.es.close();
      if (this.pollTimer) clearInterval(this.pollTimer);
      this.es = null; this.pollTimer = null; this.pollers = []; this.handlers = {};
    },
  };

  // ---------- geo ----------
  const Geo = {
    last: null,
    // Best-effort GPS; resolves {lat,lng} or null. Short timeout so driver taps never hang.
    fix() {
      return new Promise((resolve) => {
        if (!navigator.geolocation) return resolve(this.last);
        navigator.geolocation.getCurrentPosition(
          (p) => { this.last = { lat: +p.coords.latitude.toFixed(6), lng: +p.coords.longitude.toFixed(6) }; resolve(this.last); },
          () => resolve(this.last),
          { enableHighAccuracy: true, timeout: 4000, maximumAge: 30000 },
        );
      });
    },
  };

  window.WaypointAuth = Auth;
  window.WaypointRealtime = Realtime;
  window.WaypointGeo = Geo;
  window.WaypointUtil = { api, orderRef, hhmm, esc };
})();
