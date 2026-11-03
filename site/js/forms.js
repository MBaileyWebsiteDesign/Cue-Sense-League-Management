// Website forms (enquiry, newsletter, cue care). Entries go to the Cue Sense
// app (server/src/routes/venueForms.js) and show in Top Spin's Venue portal
// under "Website messages". Replaces Wix Forms. The API only accepts entries
// from website addresses listed on the venue's Table booking card.
const FORMS = {
  enquiry: {
    submit: "Send enquiry",
    thanks: "Thanks for getting in touch with Top Spin. Your message has reached the team.",
    fields: [
      { name: "firstName", label: "First name", type: "text", required: true, auto: "given-name", max: 60 },
      { name: "lastName", label: "Last name", type: "text", auto: "family-name", max: 60 },
      { name: "email", label: "Email", type: "email", required: true, auto: "email", max: 120 },
      { name: "phone", label: "Phone", type: "tel", auto: "tel", max: 30 },
      { name: "topic", label: "What is it about?", type: "select", required: true, choices: ["General enquiry", "Group or team night", "Block-booking tables", "Leagues and tournaments", "Darts teams", "Membership", "Cue care", "Other"] },
      { name: "date", label: "Preferred date", type: "date", minToday: true },
      { name: "people", label: "Number of people", type: "number", min: 1, max: 200 },
      { name: "message", label: "Message", type: "textarea", required: true, max: 3000 },
    ],
  },
  newsletter: {
    submit: "Subscribe",
    thanks: "You're on the list. Watch your inbox for offers, events and club news.",
    fields: [
      { name: "email", label: "Email", type: "email", required: true, auto: "email", max: 120 },
      { name: "firstName", label: "First name", type: "text", auto: "given-name", max: 60 },
      { name: "consent", label: "Yes, subscribe me to the Top Spin newsletter.", type: "checkbox", required: true },
    ],
  },
  cuecare: {
    submit: "Request a slot",
    thanks: "Thanks. We'll confirm your slot by email. Once confirmed, drop your cue with the staff behind the bar.",
    fields: [
      { name: "firstName", label: "First name", type: "text", required: true, auto: "given-name", max: 60 },
      { name: "lastName", label: "Last name", type: "text", required: true, auto: "family-name", max: 60 },
      { name: "email", label: "Email", type: "email", required: true, auto: "email", max: 120 },
      { name: "service", label: "Cue care service", type: "radio", required: true, choices: ["Full re-tip (£25)", "Re-tip using your own tip (£15)", "Tip shaping"] },
      { name: "notes", label: "Anything we should know?", type: "textarea", max: 2000 },
    ],
  },
};
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });

function fieldHtml(uid, f) {
  const id = `${uid}-${f.name}`;
  const req = f.required ? `<span class="req" aria-hidden="true">*</span>` : "";
  const common = `name="${f.name}" id="${id}" aria-describedby="${id}-err"${f.required ? " required" : ""}`;
  let control;
  if (f.type === "textarea") control = `<label for="${id}">${esc(f.label)}${req}</label><textarea ${common} maxlength="${f.max}"></textarea>`;
  else if (f.type === "select") control = `<label for="${id}">${esc(f.label)}${req}</label><select ${common}><option value="">Choose…</option>${f.choices.map((c) => `<option>${esc(c)}</option>`).join("")}</select>`;
  else if (f.type === "radio") control = `<fieldset aria-describedby="${id}-err"><legend>${esc(f.label)}${req}</legend>${f.choices.map((c, i) => `<label class="opt" for="${id}-${i}"><input type="radio" name="${f.name}" id="${id}-${i}" value="${esc(c)}"><span>${esc(c)}</span></label>`).join("")}</fieldset>`;
  else if (f.type === "checkbox") control = `<label class="opt" for="${id}"><input type="checkbox" ${common}><span>${esc(f.label)}${req}</span></label>`;
  else control = `<label for="${id}">${esc(f.label)}${req}</label><input type="${f.type}" ${common}${f.auto ? ` autocomplete="${f.auto}"` : ""}${f.max ? ` maxlength="${f.max}"` : ""}${f.min ? ` min="${f.min}"` : ""}${f.type === "number" && f.max ? ` max="${f.max}"` : ""}${f.minToday ? ` min="${today()}"` : ""}>`;
  return `<div class="field" data-field="${f.name}">${control}<p class="err" id="${id}-err" role="alert"></p></div>`;
}

function check(form, f) {
  if (f.type === "radio") return f.required && !form.querySelector(`[name="${f.name}"]:checked`) ? "Please choose one." : "";
  const c = form.elements[f.name];
  if (f.type === "checkbox") return f.required && !c.checked ? "Please tick this box." : "";
  const v = c.value.trim();
  if (f.required && !v) return "This field is required.";
  if (f.type === "email" && v && !EMAIL_RE.test(v)) return "Please enter a valid email address.";
  if (f.type === "number" && v && (Number(v) < f.min || Number(v) > f.max)) return `Enter a number from ${f.min} to ${f.max}.`;
  return "";
}

function mount(host) {
  const kind = host.dataset.form;
  const def = FORMS[kind];
  const api = (host.dataset.api || "").replace(/\/$/, "");
  if (!def || !api) return;
  const uid = host.id || `f${Math.random().toString(36).slice(2, 7)}`;
  host.innerHTML = `<form class="site-form" novalidate>
    ${def.fields.map((f) => fieldHtml(uid, f)).join("")}
    <div class="bk-hp" aria-hidden="true"><label for="${uid}-web">Leave this empty</label><input id="${uid}-web" name="website" type="text" tabindex="-1" autocomplete="off"></div>
    <p class="form-error" role="alert"></p>
    <div class="actions"><button type="submit" class="btn btn-primary">${esc(def.submit)}</button></div>
  </form>`;
  const form = host.querySelector("form");
  const show = (f, msg) => {
    const box = form.querySelector(`[data-field="${f.name}"]`);
    box.querySelector(".err").textContent = msg;
    box.querySelectorAll("input,select,textarea").forEach((c) => c.setAttribute("aria-invalid", msg ? "true" : "false"));
  };
  // Errors clear as soon as a field is fixed (while typing), so nothing moves
  // under the pointer when the button is pressed; a fresh error shows on submit.
  const shown = (f) => !!form.querySelector(`[data-field="${f.name}"] .err`).textContent;
  def.fields.forEach((f) => form.querySelectorAll(`[name="${f.name}"]`).forEach((c) => {
    c.addEventListener("input", () => { if (shown(f)) show(f, check(form, f)); });
    c.addEventListener("change", () => { if (shown(f)) show(f, check(form, f)); });
  }));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const formErr = form.querySelector(".form-error");
    formErr.textContent = "";
    let first = null;
    for (const f of def.fields) { const m = check(form, f); show(f, m); if (m && !first) first = f; }
    if (first) { form.querySelector(`[name="${first.name}"]`).focus(); return; }
    const body = { website: form.elements.website.value };
    for (const f of def.fields) {
      body[f.name] = f.type === "checkbox" ? form.elements[f.name].checked
        : f.type === "radio" ? (form.querySelector(`[name="${f.name}"]:checked`) || {}).value || ""
        : form.elements[f.name].value.trim();
    }
    const btn = form.querySelector("button[type=submit]");
    btn.disabled = true;
    try {
      const r = await fetch(`${api}/api/public/venue-forms/${kind}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(out.error || "Sorry, your message couldn't be sent. Please try again or email us.");
      host.innerHTML = `<div class="thanks" role="status" tabindex="-1"><p>${esc(def.thanks)}</p></div>`;
      host.firstElementChild.focus();
    } catch (err) {
      formErr.textContent = err.message;
      btn.disabled = false;
    }
  });
}

document.querySelectorAll("[data-form]").forEach(mount);
