// Table booking widget for book.html. Talks to the Cue Sense booking API
// (server/src/routes/tableBookings.js, /api/public/table-booking). The API only
// answers requests from this website's address, so it works on the live site
// and the staging site once both are listed in the venue's booking settings.
// Payment is taken at the bar - nothing is paid here.
const root = document.querySelector("[data-booking]");
if (root) init(root);

function init(root) {
  const API = root.dataset.api.replace(/\/$/, "") + "/api/public/table-booking";
  const qs = new URLSearchParams(location.search);
  const manage = qs.get("booking") && qs.get("token") ? { id: qs.get("booking"), token: qs.get("token") } : null;
  const st = { info: null, table: "", day: "", time: "", blocks: 2, avail: null, moving: null, busy: false };

  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const dayShort = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  const dayLong = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
  const len = (m) => { const h = Math.floor(m / 60), r = m % 60; return h === 0 ? `${r} min` : r === 0 ? `${h} hr` : `${h} hr ${r} min`; };
  const addMin = (hm, m) => { const [h, mi] = hm.split(":").map(Number); const t = h * 60 + mi + m; return t >= 1440 ? "24:00" : `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`; };

  async function call(path, opts = {}) {
    const r = await fetch(API + path, { ...opts, headers: { "Content-Type": "application/json", ...(opts.headers || {}) } });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(body.error || "Something went wrong. Please try again."), { status: r.status });
    return body;
  }

  const unavailable = (msg) => {
    root.innerHTML = `<div class="bk-card"><h2>Online booking isn't available right now</h2>
      <p class="muted">${esc(msg || "")}</p>
      <p>Please <a href="contact.html#contact-form">send us a message</a> or pop in and ask at the bar.</p></div>`;
  };

  async function start() {
    try {
      st.info = await call("");
    } catch (e) {
      unavailable(e.status === 403 ? "" : e.message);
      return;
    }
    if (manage) return showManage();
    st.table = st.info.tables.length === 1 ? st.info.tables[0].key : "";
    st.day = st.info.days[0] || "";
    render();
  }

  // ---------- manage an existing booking ----------
  async function showManage(note) {
    root.innerHTML = `<div class="bk-card"><p class="muted">Loading your booking…</p></div>`;
    let b;
    try {
      b = (await call(`/bookings/${encodeURIComponent(manage.id)}?token=${encodeURIComponent(manage.token)}`)).booking;
    } catch (e) {
      root.innerHTML = `<div class="bk-card"><p class="bk-error">${esc(e.message)}</p><a class="btn btn-primary" href="book.html">Make a new booking</a></div>`;
      return;
    }
    const live = b.status === "active" && Date.parse(b.start) > Date.now();
    root.innerHTML = `<div class="bk-card">
      ${note ? `<p class="bk-ok">${esc(note)}</p>` : ""}
      <h2>${b.status === "active" ? "Your booking" : "Booking cancelled"}</h2>
      ${summary(b)}
      ${live ? `<div class="btns"><button class="btn btn-primary" data-act="move">Move booking</button><button class="btn btn-ghost" data-act="cancel">Cancel booking</button></div>` : ""}
      ${b.status === "active" && !live ? `<p class="muted">This booking has started, so it can no longer be changed online.</p>` : ""}
      <p class="bk-error" data-err hidden></p>
      ${terms()}
      <p style="margin-top:18px"><a href="book.html">Make another booking</a></p>
    </div>`;
    const err = root.querySelector("[data-err]");
    root.querySelector('[data-act="move"]')?.addEventListener("click", () => {
      st.moving = b;
      st.table = b.tableKey;
      st.day = st.info.days.includes(b.day) ? b.day : st.info.days[0] || "";
      st.time = "";
      st.blocks = Math.max(1, Math.round(b.minutes / 30));
      render();
    });
    const cancelBtn = root.querySelector('[data-act="cancel"]');
    cancelBtn?.addEventListener("click", async () => {
      if (cancelBtn.dataset.armed !== "1") { cancelBtn.dataset.armed = "1"; cancelBtn.textContent = "Tap again to cancel"; return; }
      cancelBtn.disabled = true;
      try {
        await call(`/bookings/${encodeURIComponent(manage.id)}/cancel`, { method: "POST", body: JSON.stringify({ token: manage.token }) });
        showManage("Your booking is cancelled. We've emailed you a confirmation.");
      } catch (e) { err.hidden = false; err.textContent = e.message; cancelBtn.disabled = false; }
    });
  }

  const summary = (b) => `<dl class="bk-summary">
      <div><dt>Table</dt><dd>${esc(b.table)}</dd></div>
      <div><dt>When</dt><dd>${esc(dayLong(b.day))}, ${esc(b.startTime)}–${esc(b.endTime)} (${esc(len(b.minutes))})</dd></div>
      ${b.price ? `<div><dt>Price</dt><dd>${esc(b.price)}</dd></div>` : ""}
      ${b.name ? `<div><dt>Name</dt><dd>${esc(b.name)}</dd></div>` : ""}
    </dl>`;
  const terms = () => `${st.info.payNote ? `<p class="bk-pay">${esc(st.info.payNote)}</p>` : ""}
    ${st.info.policy ? `<details class="bk-policy"><summary>Booking policy</summary><p>${esc(st.info.policy).replace(/\n/g, "<br>")}</p></details>` : ""}`;

  // ---------- book / move ----------
  async function loadAvail() {
    st.avail = null;
    if (!st.table || !st.day) return;
    const extra = st.moving ? `&booking=${encodeURIComponent(manage.id)}&token=${encodeURIComponent(manage.token)}` : "";
    try {
      st.avail = await call(`/availability?table=${encodeURIComponent(st.table)}&day=${encodeURIComponent(st.day)}${extra}`);
    } catch (e) { st.avail = { error: e.message, slots: [] }; }
  }

  async function render() {
    await loadAvail();
    draw();
  }

  function draw() {
    const i = st.info;
    const slot = st.avail && st.time ? st.avail.slots.find((s) => s.time === st.time) : null;
    if (slot) st.blocks = Math.max(1, Math.min(st.blocks, slot.maxBlocks));
    const ready = slot && slot.maxBlocks > 0;
    const tbl = i.tables.find((t) => t.key === st.table);
    root.innerHTML = `<div class="bk-card">
      ${st.moving ? `<p class="bk-note">Moving your booking: ${esc(st.moving.table)}, ${esc(dayShort(st.moving.day))} ${esc(st.moving.startTime)}. Pick the new table, day and time.</p>` : ""}
      <h2 class="bk-step">1. Choose your table</h2>
      <div class="bk-tables">${i.tables.map((t) => `<button type="button" class="bk-table${t.key === st.table ? " on" : ""}" data-table="${esc(t.key)}" aria-pressed="${t.key === st.table}"><strong>${esc(t.label)}</strong>${t.price ? `<span>${esc(t.price)}</span>` : ""}</button>`).join("")}</div>
      ${st.table ? `<h2 class="bk-step">2. Choose a day</h2>
      <div class="bk-chips">${i.days.map((d) => `<button type="button" class="bk-chip${d === st.day ? " on" : ""}" data-day="${d}" aria-pressed="${d === st.day}">${esc(dayShort(d))}</button>`).join("")}</div>` : ""}
      ${st.table && st.day ? `<h2 class="bk-step">3. Start time</h2>
      ${!st.avail ? `<p class="muted">Loading times…</p>` : st.avail.error ? `<p class="bk-error">${esc(st.avail.error)}</p>` : st.avail.closed ? `<p class="muted">We're not taking bookings on this day.</p>` : `
      <div class="bk-chips">${st.avail.slots.map((s) => `<button type="button" class="bk-chip${s.time === st.time ? " on" : ""}" data-time="${s.time}" ${s.maxBlocks === 0 ? "disabled" : ""} aria-pressed="${s.time === st.time}">${s.time}</button>`).join("")}</div>
      <p class="muted bk-small">Greyed-out times are taken or have passed. Bookable ${esc(st.avail.open)}–${esc(st.avail.close)}${i.bufferMinutes ? `, with a ${i.bufferMinutes} minute changeover between bookings` : ""}.</p>`}` : ""}
      ${ready ? `<h2 class="bk-step">4. How long</h2>
      <div class="bk-stepper"><button type="button" data-len="-1" aria-label="Shorter" ${st.blocks <= 1 ? "disabled" : ""}>−</button><strong>${esc(len(st.blocks * 30))}</strong><button type="button" data-len="1" aria-label="Longer" ${st.blocks >= slot.maxBlocks ? "disabled" : ""}>+</button></div>` : ""}
      ${ready ? `<div class="bk-sum"><strong>${esc(tbl ? tbl.label : "")}</strong> · ${esc(dayLong(st.day))} · ${st.time}–${addMin(st.time, st.blocks * 30)}${tbl && tbl.price ? `<br><span class="muted">${esc(tbl.price)} — pay at the bar</span>` : ""}</div>` : ""}
      ${ready && !st.moving ? `<form class="site-form bk-form" novalidate>
        <h2 class="bk-step">5. Your details</h2>
        <div class="field"><label for="bk-name">Name<span class="req">*</span></label><input id="bk-name" name="name" type="text" autocomplete="name" required maxlength="80"></div>
        <div class="field"><label for="bk-email">Email<span class="req">*</span></label><input id="bk-email" name="email" type="email" autocomplete="email" required maxlength="120"><p class="help">We'll email your confirmation and a link to move or cancel.</p></div>
        <div class="field"><label for="bk-phone">Phone<span class="req">*</span></label><input id="bk-phone" name="phone" type="tel" autocomplete="tel" required maxlength="30"></div>
        <div class="bk-hp" aria-hidden="true"><label for="bk-web">Leave this empty</label><input id="bk-web" name="website" type="text" tabindex="-1" autocomplete="off"></div>
        <p class="bk-error" data-err hidden></p>
        <div class="actions"><button class="btn btn-primary" type="submit">Book table</button></div>
      </form>` : ""}
      ${ready && st.moving ? `<p class="bk-error" data-err hidden></p><div class="btns"><button class="btn btn-primary" data-act="domove">Move booking</button><button class="btn btn-ghost" data-act="back">Keep current booking</button></div>` : ""}
      ${terms()}
    </div>`;
    bind();
  }

  function bind() {
    root.querySelectorAll("[data-table]").forEach((b) => b.addEventListener("click", () => { st.table = b.dataset.table; st.time = ""; render(); }));
    root.querySelectorAll("[data-day]").forEach((b) => b.addEventListener("click", () => { st.day = b.dataset.day; st.time = ""; render(); }));
    root.querySelectorAll("[data-time]").forEach((b) => b.addEventListener("click", () => { st.time = b.dataset.time; draw(); }));
    root.querySelectorAll("[data-len]").forEach((b) => b.addEventListener("click", () => { st.blocks += Number(b.dataset.len); draw(); }));
    root.querySelector('[data-act="back"]')?.addEventListener("click", () => { st.moving = null; showManage(); });
    const err = root.querySelector("[data-err]");
    const fail = (e) => { err.hidden = false; err.textContent = e.message; st.busy = false; if (e.status === 409) loadAvail().then(() => { const keep = err.textContent; draw(); const e2 = root.querySelector("[data-err]"); if (e2) { e2.hidden = false; e2.textContent = keep; } }); };
    const payload = () => ({ table: st.table, start: `${st.day}T${st.time}`, minutes: st.blocks * 30 });

    root.querySelector('[data-act="domove"]')?.addEventListener("click", async (ev) => {
      const btn = ev.currentTarget;
      if (st.busy) return; st.busy = true; btn.disabled = true;
      try {
        await call(`/bookings/${encodeURIComponent(manage.id)}/move`, { method: "POST", body: JSON.stringify({ ...payload(), token: manage.token }) });
        st.moving = null; st.busy = false;
        showManage("Your booking has been moved. We've emailed you the new details.");
      } catch (e) { btn.disabled = false; fail(e); }
    });

    const form = root.querySelector(".bk-form");
    form?.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      if (st.busy) return;
      const f = new FormData(form);
      const data = Object.fromEntries(f.entries());
      if (!data.name.trim() || !data.email.trim() || !data.phone.trim()) { fail(new Error("Please fill in your name, email and phone.")); return; }
      st.busy = true;
      const btn = form.querySelector("button[type=submit]");
      btn.disabled = true; btn.textContent = "Booking…";
      try {
        const r = await call("/bookings", { method: "POST", body: JSON.stringify({ ...payload(), ...data }) });
        st.busy = false;
        root.innerHTML = `<div class="bk-card"><p class="bk-ok">You're booked in. A confirmation email is on its way to ${esc(data.email)}.</p>
          <h2>Booking confirmed</h2>${summary(r.booking)}
          ${terms()}
          <div class="btns"><a class="btn btn-primary" href="${esc(r.manageLink || `book.html?booking=${encodeURIComponent(r.booking.id)}&token=${encodeURIComponent(r.token)}`)}">Move or cancel this booking</a><a class="btn btn-ghost" href="book.html">Book another table</a></div>
          <p class="muted bk-small">Keep your confirmation email — its link is how you move or cancel this booking.</p></div>`;
        root.scrollIntoView({ behavior: "smooth", block: "start" });
      } catch (e) { btn.disabled = false; btn.textContent = "Book table"; fail(e); }
    });
  }

  start();
}
