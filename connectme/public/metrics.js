(() => {
  const $ = (s) => document.querySelector(s);
  function hydrateIcons() {
    document.querySelectorAll("[data-icon]").forEach((el) => {
      el.innerHTML = window.icons(el.dataset.icon);
    });
  }
  hydrateIcons();

  const token = sessionStorage.getItem("adminToken");
  if (!token) {
    window.location.href = "/admin.html";
    return;
  }

  function fmtDuration(sec) {
    if (sec < 60) return `${sec}s`;
    const m = Math.floor(sec / 60);
    if (m < 60) return `${m}m ${sec % 60}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }
  function fmtTime(ts) {
    const d = new Date(ts);
    const h = String(d.getHours()).padStart(2, "0");
    const m = String(d.getMinutes()).padStart(2, "0");
    const s = String(d.getSeconds()).padStart(2, "0");
    return `${h}:${m}:${s}`;
  }

  async function load() {
    try {
      const r = await fetch("/api/metrics", {
        headers: { "x-admin-token": token },
      });
      if (r.status === 401) {
        window.location.href = "/admin.html";
        return;
      }
      const m = await r.json();
      render(m);
    } catch {}
  }

  function render(m) {
    $("#metrics-sub").textContent = new Date().toLocaleString();
    $("#m-unique").textContent = m.today.uniqueVisitors;
    $("#m-joins").textContent = m.today.joins;
    $("#m-joins-hint").textContent = `${m.today.leaves} leaves`;
    $("#m-live").textContent = m.concurrent.current;
    $("#m-peak").textContent = `peak today: ${m.concurrent.peakToday}`;
    $("#m-messages").textContent = m.today.messages;
    $("#m-avg").textContent =
      m.sessions.avgDurationSec > 0
        ? fmtDuration(m.sessions.avgDurationSec)
        : "—";
    $("#m-completed").textContent =
      `${m.sessions.completedToday} completed today`;

    const list = $("#events-list");
    if (!m.recentEvents.length) {
      list.innerHTML =
        '<div class="event"><span class="event-id">No events yet.</span></div>';
      return;
    }
    list.innerHTML = m.recentEvents
      .map((e) => {
        let kind = "join",
          label = "join";
        if (e.type === "visitor.leave") {
          kind = "leave";
          label = "leave";
        } else if (e.type === "visitor.delete") {
          kind = "delete";
          label = "delete";
        } else if (e.type === "message.sent") {
          kind = "message";
          label = "message";
        }
        return `<div class="event">
                <span class="event-time">${fmtTime(e.ts)}</span>
                <span class="event-type ${kind}">${label}</span>
                <span class="event-id">${(e.id || e.fp || "—").slice(0, 16)}</span>
            </div>`;
      })
      .join("");
  }

  load();
  setInterval(load, 10000);
})();
