// Waypoint PWA bootstrap — included by every page AFTER waypoint.js.
//   • registers the service worker + background sync (WaypointOffline.init)
//   • injects the shared connection/offline status pill (fixed, top-right)
//   • captures the beforeinstallprompt for the hub's Install button
//   • surfaces queue flush results as a toast-ish banner (role pages can
//     suppress via <body data-pwa-quiet>)
(function () {
  const quiet = document.body && document.body.dataset && document.body.dataset.pwaQuiet === 'true';

  // ---- status pill ----
  const pill = document.createElement('div');
  pill.id = 'wp-conn-pill';
  pill.setAttribute('role', 'status');
  pill.style.cssText = [
    'position:fixed', 'top:12px', 'right:12px', 'z-index:99990',
    'display:flex', 'align-items:center', 'gap:7px',
    'padding:7px 13px', 'border-radius:999px',
    'font: 600 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    'letter-spacing:.02em', 'pointer-events:none',
    'box-shadow:0 4px 16px rgba(0,0,0,.35)', 'transition:background .25s,color .25s',
  ].join(';');

  function renderPill(state) {
    const queued = state.queued || 0;
    if (state.online) {
      pill.style.background = 'rgba(16,24,20,.92)';
      pill.style.color = '#34d399';
      pill.style.border = '1px solid rgba(52,211,153,.35)';
      pill.innerHTML = `<span style="width:8px;height:8px;border-radius:50%;background:#34d399;box-shadow:0 0 8px #34d399"></span>` +
        (state.flushing ? 'Syncing…' : (queued ? `Online · ${queued} queued` : 'Live'));
    } else {
      pill.style.background = 'rgba(42,26,10,.92)';
      pill.style.color = '#fbbf24';
      pill.style.border = '1px solid rgba(251,191,36,.4)';
      pill.innerHTML = `<span style="width:8px;height:8px;border-radius:50%;background:#fbbf24"></span>` +
        (queued ? `Offline · ${queued} queued` : 'Offline · cached data');
    }
  }

  // ---- toast for flush results (non-quiet pages) ----
  let toastTimer = null;
  function toast(msg, kind) {
    if (quiet) return;
    let el = document.getElementById('wp-pwa-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'wp-pwa-toast';
      el.style.cssText = [
        'position:fixed', 'bottom:18px', 'left:50%', 'transform:translateX(-50%)',
        'z-index:99991', 'padding:10px 18px', 'border-radius:12px',
        'font: 600 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        'box-shadow:0 8px 30px rgba(0,0,0,.45)', 'opacity:0', 'transition:opacity .3s',
        'pointer-events:none', 'max-width:min(92vw,560px)', 'text-align:center',
      ].join(';');
      document.body.appendChild(el);
    }
    el.style.background = kind === 'bad' ? 'rgba(127,29,29,.95)' : 'rgba(6,40,28,.95)';
    el.style.color = kind === 'bad' ? '#fecaca' : '#a7f3d0';
    el.style.border = kind === 'bad' ? '1px solid rgba(248,113,113,.4)' : '1px solid rgba(52,211,153,.4)';
    el.textContent = msg;
    el.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.style.opacity = '0'; }, 4200);
  }

  function boot() {
    // Mount the connection pill (created at module scope, attached once body exists).
    if (document.body && !pill.isConnected) document.body.appendChild(pill);
    renderPill({ online: navigator.onLine, queued: window.WaypointOffline ? WaypointOffline.count() : 0 });
    if (window.WaypointOffline) {
      if (window.WaypointOffline.onState) window.WaypointOffline.onState(renderPill);
      if (window.WaypointOffline.onChange) window.WaypointOffline.onChange(() => {});
      if (window.WaypointOffline.onFlushed) {
        window.WaypointOffline.onFlushed((results) => {
          const accepted = results.filter((r) => r.status === 'accepted').length;
          const rejected = results.filter((r) => r.status === 'rejected');
          if (accepted) toast(`✓ ${accepted} offline update${accepted > 1 ? 's' : ''} synced`, 'ok');
          if (rejected.length) toast(`⚠ ${rejected.length} update${rejected.length > 1 ? 's' : ''} rejected: ${rejected[0].detail}`, 'bad');
        });
      }
      window.WaypointOffline.init();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // ---- install prompt capture ----
  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    window.WaypointPwa = { installable: true };
    document.dispatchEvent(new CustomEvent('wp-installable'));
  });

  window.WaypointPwa = {
    get installable() { return !!deferredPrompt; },
    async install() {
      if (!deferredPrompt) return 'unavailable';
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === 'accepted') deferredPrompt = null;
      return outcome;
    },
    toast, // role pages reuse the same toast channel
  };
})();
