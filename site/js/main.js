// Menu toggle
const toggle = document.querySelector(".menu-toggle");
const menu = document.getElementById("menu");
if (toggle && menu) {
  toggle.addEventListener("click", () => {
    const open = menu.classList.toggle("open");
    toggle.setAttribute("aria-expanded", String(open));
    toggle.textContent = open ? "✕" : "☰";
  });
}
// Gallery: progressive load + lightbox
const gal = document.querySelector("[data-gallery]");
if (gal) {
  const ids = JSON.parse(document.getElementById("gallery-data").textContent);
  // Each entry is [thumbnail URL, full-size URL] (see build.mjs).
  const src = (pair, w) => (w > 600 ? pair[1] : pair[0]);
  let shown = 0;
  const step = 36;
  const more = document.querySelector("[data-more]");
  const add = () => {
    ids.slice(shown, shown + step).forEach((id, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.i = String(shown + i);
      b.setAttribute("aria-label", `Open photo ${shown + i + 1} of ${ids.length}`);
      const img = document.createElement("img");
      img.loading = "lazy"; img.decoding = "async"; img.alt = `${gal.dataset.album || "Top Spin"} photo ${shown + i + 1} of ${ids.length}, Top Spin Southampton`;
      img.src = src(id, 480);
      b.append(img); gal.append(b);
    });
    shown = Math.min(ids.length, shown + step);
    if (more) more.hidden = shown >= ids.length;
  };
  add();
  more?.addEventListener("click", add);
  const lb = document.querySelector(".lightbox");
  const lbImg = lb.querySelector("img");
  let cur = 0;
  const show = (i) => { cur = (i + ids.length) % ids.length; lbImg.src = src(ids[cur], 1600); lbImg.alt = `${gal.dataset.album || "Top Spin"} photo ${cur + 1}`; const c = lb.querySelector(".lb-count"); if (c) c.textContent = `${cur + 1} / ${ids.length}`; };
  gal.addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; show(Number(b.dataset.i)); lb.classList.add("open"); lb.querySelector(".lb-close").focus(); });
  lb.querySelector(".lb-close").onclick = () => lb.classList.remove("open");
  lb.querySelector(".lb-prev").onclick = () => show(cur - 1);
  lb.querySelector(".lb-next").onclick = () => show(cur + 1);
  document.addEventListener("keydown", (e) => {
    if (!lb.classList.contains("open")) return;
    if (e.key === "Escape") lb.classList.remove("open");
    if (e.key === "ArrowLeft") show(cur - 1);
    if (e.key === "ArrowRight") show(cur + 1);
  });
}
// Events: hide anything before today (UK time)
const evWrap = document.querySelector("[data-events]");
if (evWrap) {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
  let left = 0;
  evWrap.querySelectorAll("[data-date]").forEach((c) => { if (c.dataset.date < today) c.remove(); else left++; });
  if (!left) document.querySelector("[data-no-events]")?.removeAttribute("hidden");
}
// TV listings: hide games that finished (start + 3h) and empty days
const tvWrap = document.querySelector("[data-tv]");
if (tvWrap) {
  const nowUK = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/London" }));
  const today = nowUK.toLocaleDateString("en-CA");
  tvWrap.querySelectorAll(".tv-item").forEach((li) => {
    const [h, m] = li.dataset.time.split(":").map(Number);
    const t = new Date(nowUK); t.setHours(h + 3, m, 0, 0);
    if (li.dataset.date < today || (li.dataset.date === today && t < nowUK)) li.remove();
  });
  const tmr = new Date(nowUK); tmr.setDate(tmr.getDate() + 1); const tomorrow = tmr.toLocaleDateString("en-CA");
  tvWrap.querySelectorAll(".tv-day").forEach((d) => {
    if (!d.querySelector(".tv-item")) return d.remove();
    const h = d.querySelector("h3"); if (d.dataset.day === today) h.textContent = "Today · " + h.textContent; else if (d.dataset.day === tomorrow) h.textContent = "Tomorrow · " + h.textContent;
  });
  if (!tvWrap.querySelector(".tv-day")) document.querySelector("[data-tv-empty]")?.removeAttribute("hidden");
}
