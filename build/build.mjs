// Builds the static Top Spin site into ../site. Run: SITE_URL=https://... node build/build.mjs
import { writeFileSync, readFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { createHash } from "node:crypto";
const OUT = new URL("../site/", import.meta.url);
const SITE = (process.env.SITE_URL || "").replace(/\/$/, "");
const LIVE = "https://www.topspinpoolandsportsbar.co.uk";
const BOOK_URL = "book.html";
// Cue Sense app: table booking (server/src/routes/tableBookings.js) and the website forms
// (server/src/routes/venueForms.js) both go here, production app. The site no longer uses Wix.
// Override with BOOKING_API=https://dev.poolmanager.cuesense.co.uk to test against the staging app.
const BOOKING_API = (process.env.BOOKING_API || "https://app.cuesense.co.uk").replace(/\/$/, "");
const EMAIL = "info@TopSpinPoolAndSportsBar.co.uk";
const ADDRESS = "1st Floor, 88–90 Lodge Rd, Southampton SO14 6RF";
const MAPS = "https://www.google.com/maps/search/?api=1&query=Top+Spin+Pool+and+Sports+Bar+88-90+Lodge+Road+Southampton+SO14+6RF";
const SOCIAL = {
  facebook: "https://www.facebook.com/TopspinPoolandsports",
  instagram: "https://www.instagram.com/topspinsouthampton/",
  tiktok: "https://www.tiktok.com/@topspinsouthampton",
  youtube: "https://www.youtube.com/@TopSpinSouthampton",
};
const FB_GROUP = "https://www.facebook.com/groups/1084847893069131/";
const FB_DARTS_GROUP = "https://www.facebook.com/groups/2152226125673996/";
const LEAGUE_APP = "https://app.cuesense.co.uk";
const CUESENSE = "https://cuesense.co.uk";

const img = (id, w, h) => id.startsWith("img/") ? id : `https://static.wixstatic.com/media/${id}/v1/fill/w_${w},h_${h},al_c,q_80,enc_auto/${id.split("~")[0]}.jpg`;
const absImg = (id, w, h) => { const u = img(id, w, h); return u.startsWith("http") ? u : `${SITE || LIVE}/${u}`; };
const P = {
  hero: "d2bbc3_fa1c5dfd9a4d418d9ec89068ae58ca3f~mv2.jpeg",
  venue: "d2bbc3_b0c360d4f4614046baf4d22e99055a53~mv2.jpeg",
  tables: "d2bbc3_6d2bbadc5c61475aaacaffd3119069af~mv2.jpg",
  darts1: "d2bbc3_4134c8a99dce44b19d43d97ee8ca047c~mv2.jpg",
  darts2: "d2bbc3_278ea3df91e44e4a9b2eaaf7b909f3a5~mv2.jpg",
  darts3: "d2bbc3_7311cdb29b7c47168740106d1b07da78~mv2.jpg",
  tourn: "d2bbc3_262cdaa7faae4f2cbe6de79975c7f513~mv2.jpeg",
  league: "d2bbc3_f3a7f8fafd544455862e966af0886a71~mv2.jpeg",
  formats: "d2bbc3_e4ae7028ad3e43e6a909e1bf4f15ec33~mv2.jpeg",
  logo: "d2bbc3_44bda9c9a0a448f19a49310ddaca41e6~mv2.png",
  // Real event photos (26 Sep 2026), from the 5 Star selections
  dartsWall: "img/darts-wall.jpg", dartsPresentation: "img/darts-presentation.jpg", dartsThrow: "img/darts-throw.jpg", dartboard: "img/dartboard.jpg",
  ladiesGroup: "img/ladies-group.jpg", poolBreak: "img/pool-break.jpg", poolShot: "img/pool-shot.jpg", poolTable10: "img/pool-table-10.jpg", poolCrowd: "img/pool-crowd.jpg",
};
const LOGO = `https://static.wixstatic.com/media/${P.logo}/v1/fit/w_192,h_192,al_c,q_90/logo.png`;

const HOURS = [["Monday", "11:00", "00:00"], ["Tuesday", "11:00", "00:00"], ["Wednesday", "11:00", "00:00"], ["Thursday", "11:00", "00:00"], ["Friday", "11:00", "00:00"], ["Saturday", "11:00", "00:00"], ["Sunday", "11:00", "22:00"]];
const hoursTable = () => `<table class="hours"><caption class="sr-only">Opening hours</caption><tbody>${HOURS.map(([d, o, c]) => `<tr><th scope="row">${d}</th><td>${o} – ${c === "00:00" ? "midnight" : c}</td></tr>`).join("")}</tbody></table>`;

const NAV = [
  ["index.html", "Home"], ["pool.html", "Pool & Prices"], ["darts.html", "Darts"], ["leagues.html", "Leagues & Tournaments"],
  ["food-drink.html", "Food & Drink"], ["events.html", "What's On"], ["live-sport.html", "Live Sport"], ["gallery.html", "Gallery"], ["contact.html", "Contact"],
];

const ICON = {
  calendar: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/><circle cx="12" cy="15" r="1.5" fill="currentColor"/></svg>`,
  cue: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 21 17 7"/><circle cx="19" cy="5" r="2.5"/></svg>`,
  dart: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/></svg>`,
  trophy: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M8 4h8v5a4 4 0 0 1-8 0V4Z"/><path d="M8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M8 20h8"/></svg>`,
  tv: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="12" rx="2"/><path d="M8 21h8"/></svg>`,
  food: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M3 11 12 3l9 8-9 10-9-10Z"/><circle cx="10" cy="10" r="1" fill="currentColor"/><circle cx="14" cy="13" r="1" fill="currentColor"/></svg>`,
  group: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M3 20a6 6 0 0 1 12 0M15 20a4 4 0 0 1 6-3.4"/></svg>`,
  wrench: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.2L3 17.8V21h3.2l6.3-6.3a4 4 0 0 0 5.2-5.4l-2.6 2.6-2.4-.6-.6-2.4 2.6-2.6Z"/></svg>`,
};
const SOC_ICON = {
  facebook: `<svg viewBox="0 0 24 24"><path d="M14 9V7c0-.9.6-1 1-1h3V2h-4c-3.3 0-4 2.4-4 4v3H7v4h3v9h4v-9h3.4l.6-4H14Z"/></svg>`,
  instagram: `<svg viewBox="0 0 24 24"><path d="M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10Zm0 8.2a3.2 3.2 0 1 1 0-6.4 3.2 3.2 0 0 1 0 6.4ZM17.3 5.5a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4ZM12 2c-2.7 0-3 0-4.1.1C4.3 2.2 2.2 4.3 2.1 7.9 2 9 2 9.3 2 12s0 3 .1 4.1c.1 3.6 2.2 5.7 5.8 5.8 1.1.1 1.4.1 4.1.1s3 0 4.1-.1c3.6-.1 5.7-2.2 5.8-5.8.1-1.1.1-1.4.1-4.1s0-3-.1-4.1c-.1-3.6-2.2-5.7-5.8-5.8C15 2 14.7 2 12 2Z"/></svg>`,
  tiktok: `<svg viewBox="0 0 24 24"><path d="M16.6 2h-3.3v13.3a2.9 2.9 0 1 1-2-2.8V9.1a6.2 6.2 0 1 0 5.3 6.2V8.6a7.8 7.8 0 0 0 4.4 1.4V6.7a4.4 4.4 0 0 1-4.4-4.7Z"/></svg>`,
  youtube: `<svg viewBox="0 0 24 24"><path d="M23 7.2a3 3 0 0 0-2.1-2.1C19 4.6 12 4.6 12 4.6s-7 0-8.9.5A3 3 0 0 0 1 7.2 31 31 0 0 0 .5 12a31 31 0 0 0 .5 4.8 3 3 0 0 0 2.1 2.1c1.9.5 8.9.5 8.9.5s7 0 8.9-.5a3 3 0 0 0 2.1-2.1 31 31 0 0 0 .5-4.8 31 31 0 0 0-.5-4.8ZM9.8 15V9l5.8 3-5.8 3Z"/></svg>`,
};

const BUSINESS_LD = {
  "@context": "https://schema.org",
  "@type": ["BarOrPub", "SportsActivityLocation"],
  "@id": `${SITE || LIVE}/#business`,
  name: "Top Spin Pool and Sports Bar",
  alternateName: ["Top Spin Southampton", "TopSpin Southampton"],
  description: "Pool hall and sports bar in Southampton with English pool tables, Chinese pool tables, six free dartboards, live sport on big screens, food and drink, leagues and tournaments.",
  url: SITE || LIVE,
  logo: `https://static.wixstatic.com/media/${P.logo}`,
  image: [`https://static.wixstatic.com/media/${P.hero}`, `https://static.wixstatic.com/media/${P.venue}`],
  email: EMAIL,
  address: { "@type": "PostalAddress", streetAddress: "1st Floor, 88-90 Lodge Road", addressLocality: "Southampton", postalCode: "SO14 6RF", addressCountry: "GB" },
  geo: { "@type": "GeoCoordinates", latitude: 50.9193473, longitude: -1.3999192 },
  hasMap: MAPS,
  openingHoursSpecification: [
    { "@type": "OpeningHoursSpecification", dayOfWeek: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"], opens: "11:00", closes: "23:59" },
    { "@type": "OpeningHoursSpecification", dayOfWeek: "Sunday", opens: "11:00", closes: "22:00" },
  ],
  servesCuisine: ["Pizza", "Burgers", "Bar food"],
  amenityFeature: ["Pool tables", "Chinese pool tables", "Dartboards", "Big screen sport", "Car park", "Dogs allowed", "Family friendly", "Smoking area", "Real ale", "Live music"].map((name) => ({ "@type": "LocationFeatureSpecification", name, value: true })),
  sameAs: Object.values(SOCIAL),
};

function page({ file, navFile, crumbParent, title, description, h1, eyebrow, lead, heroImg, body, ld = [], heroButtons = true, full = false }) {
  const canonical = SITE ? `${SITE}/${file === "index.html" ? "" : file}` : "";
  const navHtml = NAV.map(([href, label]) => `<li><a href="${href}"${href === (navFile || file) ? ' aria-current="page"' : ""}>${label}</a></li>`).join("");
  const crumbItems = [["Home", SITE ? `${SITE}/` : undefined], ...(crumbParent ? [[crumbParent[0], SITE ? `${SITE}/${crumbParent[1]}` : undefined]] : []), [h1.replace(/<[^>]+>/g, ""), canonical || undefined]];
  const crumbs = file === "index.html" ? null : { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: crumbItems.map(([name, item], i) => ({ "@type": "ListItem", position: i + 1, name, item })) };
  const lds = [BUSINESS_LD, ...ld, crumbs].filter(Boolean).map((x) => `<script type="application/ld+json">${JSON.stringify(x)}</script>`).join("\n");
  const hero = `<section class="hero${full ? "" : " page-hero"}">
  <img src="${img(heroImg, 1800, 1000)}" alt="" fetchpriority="high">
  <div class="wrap">
    ${eyebrow ? `<p class="eyebrow">${eyebrow}</p>` : ""}
    <h1>${h1}</h1>
    ${lead ? `<p class="lead">${lead}</p>` : ""}
    ${heroButtons ? `<div class="btns"><a class="btn btn-primary" href="${BOOK_URL}">Book a table</a><a class="btn btn-ghost" href="pool.html">Prices &amp; membership</a></div>` : ""}
  </div>
</section>`;
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${description}">
${canonical ? `<link rel="canonical" href="${canonical}">` : ""}
<meta name="theme-color" content="#0a0c0f">
${process.env.STAGING && process.env.STAGING !== "0" ? `<meta name="robots" content="noindex, nofollow">` : ""}
<meta property="og:type" content="website">
<meta property="og:site_name" content="Top Spin Pool and Sports Bar">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:image" content="${absImg(heroImg, 1200, 630)}">
${canonical ? `<meta property="og:url" content="${canonical}">` : ""}
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="${LOGO}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700&family=Barlow:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="css/style.css">
${lds}
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="site-header">
  <nav class="nav wrap" aria-label="Main">
    <a class="brand" href="index.html"><img src="${LOGO}" alt="Top Spin logo" width="44" height="44"><span>Top Spin<small>POOL &amp; SPORTS BAR</small></span></a>
    <button class="menu-toggle" aria-controls="menu" aria-expanded="false" aria-label="Menu">☰</button>
    <ul class="menu" id="menu">${navHtml}<li class="menu-book"><a href="${BOOK_URL}">Book a table</a></li></ul>
    <a class="btn btn-primary btn-book" href="${BOOK_URL}">Book</a>
  </nav>
</header>
<main id="main">
${hero}
${body}
</main>
<footer class="site-footer">
  <div class="wrap">
    <div class="foot">
      <div>
        <a class="brand" href="index.html"><img src="${LOGO}" alt="" width="44" height="44"><span>Top Spin<small>POOL &amp; SPORTS BAR</small></span></a>
        <p class="muted small" style="margin-top:14px">Pool, darts and live sport on the first floor at Lodge Road, Southampton.</p>
        <div class="social">${Object.entries(SOCIAL).map(([k, u]) => `<a href="${u}" aria-label="Top Spin on ${k[0].toUpperCase() + k.slice(1)}" rel="noopener">${SOC_ICON[k]}</a>`).join("")}</div>
      </div>
      <div>
        <h4>Visit</h4>
        <address style="font-style:normal" class="small">${ADDRESS}<br><a href="${MAPS}" rel="noopener">Get directions</a><br><a href="mailto:${EMAIL}">${EMAIL}</a><br><span class="muted">Phone: coming soon</span></address>
      </div>
      <div>
        <h4>Opening hours</h4>
        <ul class="small"><li>Mon–Sat: 11:00 – midnight</li><li>Sunday: 11:00 – 22:00</li></ul>
      </div>
      <div>
        <h4>Explore</h4>
        <ul class="small">
          <li><a href="pool.html">Pool tables &amp; prices</a></li><li><a href="pool.html#offers">Special offers</a></li><li><a href="cue-care.html">Cue care</a></li><li><a href="groups.html">Groups &amp; team nights</a></li><li><a href="about.html">About &amp; facilities</a></li><li><a href="faq.html">FAQs</a></li><li><a href="${BOOK_URL}">Book a table</a></li>
        </ul>
      </div>
    </div>
    <div class="legal"><span>© <span id="yr">2026</span> Top Spin Pool and Sports Bar, Southampton.</span><span>Website by <a href="https://www.mbaileywebsitedesign.co.uk" rel="noopener">MBailey Website Design</a></span></div>
  </div>
</footer>
<nav class="mobile-bar" aria-label="Quick actions"><a href="${MAPS}" rel="noopener">Directions</a><a href="contact.html#contact-form">Enquire</a><a class="primary" href="${BOOK_URL}">Book</a></nav>
<script type="module" src="js/main.js"></script>
${body.includes("data-form=") ? `<script type="module" src="js/forms.js"></script>` : ""}
${body.includes("data-booking") ? `<script type="module" src="js/booking.js"></script>` : ""}
</body>
</html>`;
}

const card = (icon, title, text, href, more = "Find out more") => `<a class="card" href="${href}"><span class="icon">${ICON[icon]}</span><h3>${title}</h3><p>${text}</p><span class="more">${more}</span></a>`;
const newsletter = `<section class="block"><div class="wrap"><div class="cta">
  <div><p class="eyebrow">Newsletter</p><h2>Offers, events &amp; club news</h2><p class="muted">Be first to hear about tournaments, match nights and special table deals at Southampton's pool and sports bar.</p></div>
  <div class="inline-form" data-form="newsletter" data-api="${BOOKING_API}" id="newsletter"></div>
</div></div></section>`;
const strip = `<div class="strip"><div class="wrap">
  <div><strong>Find us</strong><span>${ADDRESS}</span></div>
  <div><strong>Opening hours</strong><span>Mon–Sat: 11:00 – midnight<br>Sunday: 11:00 – 22:00</span></div>
  <div><strong>Get in touch</strong><span><a href="contact.html#contact-form">Send us a message</a></span></div>
</div></div>`;

const offersSection = (alt = false) => `<section class="block${alt ? " alt" : ""}" id="offers"><div class="wrap">
  <div class="section-head"><p class="eyebrow">Special offers</p><h2>More game time for less</h2><p>Discounted table rates and deals to make the most of your time at the tables. Ask the bar team to claim an offer.</p></div>
  <div class="offers">
    <div class="offer-card"><span class="offer-tag">Special offer</span><h3>2 hours on a standard table</h3><div class="offer-price">£18</div><p>Pay as you go for two hours on a standard table. Save £2 on two single hours.</p></div>
    <div class="offer-card"><span class="offer-tag">Special offer</span><h3>1 hour of pool &amp; a 4-pint pitcher</h3><div class="offer-price">£25</div><p>An hour on the table and a 4-pint pitcher for the group.</p></div>
  </div>
  <p class="note" style="margin-top:22px;max-width:760px">We're not currently taking online payments. Please visit us and speak to a member of the bar team.</p>
</div></section>`;

const pages = [];

// ---------- HOME ----------
pages.push({
  file: "index.html", full: true, heroImg: P.hero,
  title: "Top Spin Pool and Sports Bar | Pool Hall & Sports Bar in Southampton",
  description: "Pool tables, Chinese pool, six free dartboards and live sport on big screens. Top Spin is a first-floor pool and sports bar on Lodge Road, Southampton SO14.",
  eyebrow: "Lodge Road · Southampton", h1: "Southampton's pool &amp; sports bar",
  lead: "Professional-grade pool tables, six free dartboards and live sport on the big screens — with food, drinks and a buzzing crowd on the first floor at Lodge Road.",
  body: `${strip}
<section class="block"><div class="wrap">
  <div class="section-head"><p class="eyebrow">What's on at Top Spin</p><h2>More than a pool hall</h2><p>From a casual frame with friends to ranked league nights, Top Spin turns the traditional local hall into a proper night out.</p></div>
  <div class="grid grid-4">
    ${card("cue", "Pool tables", "Standard tables from £10 an hour and match tables from £12. English pool, plus Chinese pool tables.", "pool.html", "See prices")}
    ${card("dart", "Free darts", "Six high-quality boards, free for everyone. Borrow a house set from the bar.", "darts.html")}
    ${card("trophy", "Leagues &amp; tournaments", "The Top Spin Singles League runs five divisions, from the Premier League to Division 5.", "leagues.html", "Join a league")}
    ${card("calendar", "What's on", "Weekly flyers, free comps, knockouts and grand finals. See what's coming up and enter.", "events.html", "See upcoming events")}
    ${card("tv", "Live sport", "Sky Sports, TNT Sports, football, rugby, cricket and racing on the big screens.", "live-sport.html")}
    ${card("food", "Food &amp; drink", "14-inch pizzas made for sharing, burgers, hot dogs and chips, plus real ale at the bar.", "food-drink.html", "View the menu")}
    ${card("group", "Groups &amp; team nights", "Block-book tables, host a team night or run your own mini-tournament.", "groups.html", "Plan your night")}
    ${card("wrench", "Cue care", "Full re-tips from £25 (£15 with your own tip), tip shaping and £2 ball cleaning.", "cue-care.html", "Book your cue in")}
  </div>
</div></section>
<section class="block alt"><div class="wrap split">
  <div class="photo"><img src="img/pool-closeup.jpg" alt="A player lining up a shot on a blue-cloth English pool table at Top Spin" loading="lazy"></div>
  <div>
    <p class="eyebrow">The venue</p><h2>Built for serious English pool</h2>
    <p>Top Spin Pool and Sports Bar is a destination for cue sports in Southampton. Elite tables meet a social, lounge-style scene, so it works just as well for league players as it does for a relaxed night with friends.</p>
    <ul class="ticks"><li>Pro-spec English pool tables and quality balls</li><li>Chinese pool tables</li><li>Friendly but competitive atmosphere</li><li>Food, drinks and table service during play</li></ul>
    <a class="btn btn-ghost" href="about.html">About &amp; facilities</a>
  </div>
</div></section>
<section class="block"><div class="wrap">
  <div class="section-head"><p class="eyebrow">Prices</p><h2>Pay as you go or join as a member</h2><p>Simple table prices. Payment is taken at the bar — just speak to a member of the team.</p></div>
  <div class="grid">
    <div class="card price-card"><h3>Standard table</h3><div class="price">£10<small>/ hour</small></div><p>Our standard tables, perfect for a casual game.</p></div>
    <div class="card price-card"><h3>Match table</h3><div class="price">£12<small>/ hour</small></div><p>Our match-spec tables.</p></div>
    <div class="card price-card"><h3>Monthly membership</h3><div class="price">£40</div><p>Valid for one month. Includes the Cue Sense app to track and improve your game.</p></div>
    <div class="card price-card feature"><span class="badge">Best value</span><h3>Yearly membership</h3><div class="price">£400</div><p>Valid for 12 months. Includes the Cue Sense app.</p></div>
  </div>
  <p style="margin-top:22px"><a href="pool.html">Full prices and membership details</a></p>
</div></section>
${offersSection(true)}
<section class="block"><div class="wrap split flip">
  <div class="photo"><img src="${img(P.dartsWall, 900, 700)}" alt="Players at the dartboards on the Top Spin World Darts Championship wall" loading="lazy"></div>
  <div>
    <p class="eyebrow">Darts at Top Spin</p><h2>Six boards. Free to play.</h2>
    <p>Line up your shot in our dedicated darts zone under the Top Spin World Darts Championship wall. Bring your own darts or borrow a house set from behind the bar.</p>
    <p>Top Spin is home to two darts teams, with league matches and practice nights on Mondays and Thursdays.</p>
    <a class="btn btn-ghost" href="darts.html">Darts at Top Spin</a>
  </div>
</div></section>
<section class="block alt"><div class="wrap split">
  <div>
    <p class="eyebrow">Compete</p><h2>Leagues, knockouts &amp; bragging rights</h2>
    <p>The Top Spin Singles League is our flagship open competition, with five divisions so every standard of player gets competitive frames. Weekly open tournaments, seasonal leagues, handicap nights and team specials are announced in our Facebook group.</p>
    <div class="btns"><a class="btn btn-primary" href="leagues.html">Leagues &amp; tournaments</a><a class="btn btn-ghost" href="${FB_GROUP}" rel="noopener">Upcoming events</a></div>
  </div>
  <div class="photo"><img src="${img(P.poolTable10, 900, 700)}" alt="A player cueing up on table 10 during a Top Spin tournament" loading="lazy"></div>
</div></section>
${newsletter}`,
  ld: [{ "@context": "https://schema.org", "@type": "WebSite", name: "Top Spin Pool and Sports Bar", url: SITE || LIVE }],
});

// ---------- POOL ----------
pages.push({
  file: "pool.html", heroImg: P.tables,
  title: "Pool Tables & Prices in Southampton | Top Spin Pool and Sports Bar",
  description: "Pool table prices at Top Spin Southampton: standard tables £10/hour, match tables £12/hour, 2 hours for £18, monthly membership £40. English and Chinese pool tables.",
  eyebrow: "Pool tables", h1: "Pool tables &amp; prices",
  lead: "English pool on professional-grade tables, Chinese pool tables and match tables — pay as you go or become a member.",
  body: `<section class="block"><div class="wrap">
  <div class="section-head"><p class="eyebrow">Pay as you go</p><h2>Table prices</h2><p>Payment is taken at the bar.</p></div>
  <div class="grid">
    <div class="card price-card"><h3>Standard table</h3><div class="price">£10<small>/ 1 hour</small></div><p>Our standard tables, perfect for a casual game.</p></div>
    <div class="card price-card"><h3>Match table</h3><div class="price">£12<small>/ 1 hour</small></div><p>Match tables for serious practice and competitive frames.</p></div>
  </div>
</div></section>
${offersSection(true)}
<section class="block" id="membership"><div class="wrap">
  <div class="section-head"><p class="eyebrow">Membership</p><h2>Play more for less</h2><p>From casual play to ranking matches, membership is the best value if you're in regularly.</p></div>
  <div class="grid" style="max-width:760px">
    <div class="card price-card"><h3>Monthly</h3><div class="price">£40</div><p>Valid for one month.</p></div>
    <div class="card price-card feature"><span class="badge">Best value</span><h3>Yearly</h3><div class="price">£400</div><p>Valid for 12 months.</p></div>
  </div>
  <div class="card" style="max-width:760px;margin-top:18px"><span class="icon">${ICON.trophy}</span><h3>Includes the Cue Sense app</h3><p>Every membership gives you access to the Cue Sense app, where you can manage, monitor and improve your game.</p><div class="btns" style="margin-top:10px"><a class="btn btn-primary" href="${LEAGUE_APP}" rel="noopener">Open the Cue Sense app</a><a class="btn btn-ghost" href="${CUESENSE}" rel="noopener">About Cue Sense</a></div></div>
  <p class="note" style="margin-top:24px;max-width:760px">We're not currently taking online payments for tables or memberships. Please visit us and speak to a member of the bar team.</p>
</div></section>
<section class="block alt"><div class="wrap split">
  <div>
    <p class="eyebrow">The tables</p><h2>English &amp; Chinese pool</h2>
    <p>Top Spin is built around English pool, with pro-spec tables and quality balls. We also have Chinese pool tables.</p>
    <ul class="ticks"><li>Standard tables and match tables</li><li>Chinese pool tables</li><li>Ball cleaning available at the bar for £2 a session</li></ul>
    <div class="btns"><a class="btn btn-primary" href="${BOOK_URL}">Book a table</a><a class="btn btn-ghost" href="cue-care.html">Cue care</a></div>
  </div>
  <div class="photo"><img src="${img(P.hero, 900, 700)}" alt="Blue-cloth pool tables at Top Spin Southampton" loading="lazy"></div>
</div></section>
${newsletter}`,
  ld: [{ "@context": "https://schema.org", "@type": "OfferCatalog", name: "Pool table prices", itemListElement: [
    ["Standard table, 1 hour", 10], ["Standard table, 2 hours", 18], ["Match table, 1 hour", 12], ["1 hour of pool and a 4-pint pitcher", 25], ["Monthly membership (includes Cue Sense app access)", 40], ["Yearly membership (includes Cue Sense app access)", 400],
  ].map(([name, price]) => ({ "@type": "Offer", name, price, priceCurrency: "GBP" })) }],
});

// ---------- DARTS ----------
pages.push({
  file: "darts.html", heroImg: P.darts2,
  title: "Free Darts in Southampton | Darts Boards & Teams at Top Spin",
  description: "Play darts for free at Top Spin, Southampton. Six quality dartboards, house darts to borrow, and two darts teams with league and practice nights on Mondays and Thursdays.",
  eyebrow: "Darts", h1: "Darts at Top Spin", heroButtons: false,
  lead: "Six high-quality dartboards, completely free to use and open to everyone.",
  body: `<section class="block"><div class="wrap split">
  <div>
    <p class="eyebrow">The darts zone</p><h2>Grab a drink, throw a few legs</h2>
    <p>Step into our dedicated darts zone and line up your shot under the glow of the Top Spin World Darts Championship wall. It's the perfect spot to grab a drink, throw a few legs and feel the buzz of real match-night energy.</p>
    <ul class="ticks"><li>Six high-quality boards, free to use</li><li>Bring your own darts, or borrow a house set from behind the bar</li><li>New to darts? Our team will help you get started</li></ul>
  </div>
  <div class="photo"><img src="${img(P.dartsWall, 900, 700)}" alt="Players at the dartboards on the Top Spin World Darts Championship wall" loading="lazy"></div>
</div></section>
<section class="block alt"><div class="wrap">
  <div class="section-head"><p class="eyebrow">Our boards</p><h2>Six boards, four spots</h2><p>Alongside the World Darts Championship wall, there's a second double-board oche and two single boards, so there's usually one free.</p></div>
  <div class="boards">
    <figure class="board-card wide"><img src="img/board-dual-2.jpg" alt="Players throwing at the two lit dartboards of the second double-board oche at Top Spin" loading="lazy"><figcaption><strong>Double board</strong><span>Two lit boards, a scoring screen and throw mats</span></figcaption></figure>
    <figure class="board-card"><img src="img/board-single-1.jpg" alt="A single Winmau dartboard with a lit surround at Top Spin" loading="lazy"><figcaption><strong>Single board</strong><span>Lit Winmau board</span></figcaption></figure>
    <figure class="board-card"><img src="img/board-single-2.jpg" alt="A single Winmau dartboard with an orange surround on a brick wall at Top Spin" loading="lazy"><figcaption><strong>Single board</strong><span>Winmau board on the brick wall</span></figcaption></figure>
  </div>
</div></section>
<section class="block"><div class="wrap split flip">
  <div>
    <p class="eyebrow">Darts teams</p><h2>Two teams play out of Top Spin</h2>
    <p>League matches and practice nights run on <strong>Mondays and Thursdays</strong>. Come and cheer them on, challenge your mates, or ask about joining if you're ready to take your darts more seriously.</p>
    <a class="btn btn-primary" href="contact.html">Ask about joining</a>
  </div>
  <div class="photo"><img src="${img(P.dartsPresentation, 900, 700)}" alt="Trophy and prize presentation at a Top Spin darts competition" loading="lazy"></div>
</div></section>`,
});

// ---------- LEAGUES ----------
pages.push({
  file: "leagues.html", heroImg: P.tourn,
  title: "Pool Leagues & Tournaments in Southampton | Top Spin",
  description: "Join the Top Spin Singles League (five divisions, Premier to Division 5), weekly open pool tournaments, seasonal leagues, handicap nights and team events in Southampton.",
  eyebrow: "Compete", h1: "Leagues &amp; tournaments", heroButtons: false,
  lead: "Compete, improve your game and join Southampton's most dedicated English pool community.",
  body: `<section class="block"><div class="wrap split">
  <div>
    <p class="eyebrow">In-house league</p><h2>Top Spin Singles League</h2>
    <p>The Singles League is our flagship open competition, with five divisions from the Premier League down to Division 5. Players of every standard — from seasoned pros to improving amateurs — compete against others at a similar level.</p>
    <p>Fixtures, tables and results are run through <a href="${CUESENSE}" rel="noopener">Cue Sense</a>. Top Spin members also get access to the Cue Sense app to manage, monitor and improve their game.</p>
    <div class="btns"><a class="btn btn-primary" href="${LEAGUE_APP}" rel="noopener">Singles League on Cue Sense</a></div>
  </div>
  <div class="photo"><img src="${img(P.poolBreak, 900, 700)}" alt="A player taking a shot during a Top Spin pool competition" loading="lazy"></div>
</div></section>
<section class="block alt"><div class="wrap">
  <div class="section-head"><p class="eyebrow">Formats</p><h2>Find the format that fits your game</h2><p>We run a mix of weekly, monthly and seasonal events. All tournaments are currently announced through our Facebook group.</p></div>
  <div class="grid">
    <div class="card"><span class="icon">${ICON.trophy}</span><h3>Weekly open tournaments</h3><p>Single-night knockouts open to all levels, drawn on the night, with cash prizes and bar tabs up for grabs.</p></div>
    <div class="card"><span class="icon">${ICON.cue}</span><h3>Seasonal leagues</h3><p>Structured leagues over several weeks. Earn points each match, climb the table and qualify for end-of-season finals.</p></div>
    <div class="card"><span class="icon">${ICON.group}</span><h3>Handicap &amp; beginners nights</h3><p>Newer to competitive play? Handicaps level the field so everyone has a real shot at winning.</p></div>
    <div class="card"><span class="icon">${ICON.dart}</span><h3>Specials &amp; team nights</h3><p>Doubles, team events and one-off specials with themed nights, added prize money and sponsor giveaways.</p></div>
  </div>
  <div class="btns" style="margin-top:28px"><a class="btn btn-primary" href="${FB_GROUP}" rel="noopener">See upcoming tournaments</a></div>
</div></section>
<section class="block"><div class="wrap split flip">
  <div>
    <p class="eyebrow">Prizes &amp; rankings</p><h2>Serious enough to matter</h2>
    <ul class="ticks"><li>Cash and bar-tab prizes for winners and runners-up</li><li>Seasonal rankings and player stats</li><li>Trophies and special awards at finals nights</li><li>Selected tournaments with added prize money or sponsor prizes</li></ul>
    <p class="muted">Keep an eye on our Facebook group and social channels for announcements.</p>
  </div>
  <div class="photo"><img src="${img(P.poolShot, 900, 700)}" alt="A player cueing up at a busy Top Spin tournament" loading="lazy"></div>
</div></section>
<section class="block alt"><div class="wrap cta">
  <div><p class="eyebrow">Teams &amp; organisers</p><h2>Host your own event</h2><p class="muted">Part of a team, playing in a local league, or want to host your own event? We can block-book tables and set up custom formats and prize structures.</p></div>
  <div class="btns"><a class="btn btn-primary" href="groups.html">Team nights &amp; events</a></div>
</div></section>`,
});

// ---------- FOOD ----------
const pizza = (name, mid) => `<div class="menu-item"><img src="${img(mid, 168, 168)}" alt="${name} pizza (illustration)" loading="lazy"><div><h3>14" ${name}</h3><p>Ideal for 2 people</p></div><span class="p">£12</span></div>`;
const plate = (name, mid) => `<div class="menu-item"><img src="${img(mid, 168, 168)}" alt="${name} (illustration)" loading="lazy"><div><h3>${name}</h3></div><span class="p ask">Price at the bar</span></div>`;
pages.push({
  file: "food-drink.html", heroImg: P.venue,
  title: "Food & Drink | Pizza, Burgers & Bar Menu at Top Spin Southampton",
  description: "The Top Spin bar menu: 14-inch pizzas for £12 (ideal for 2), chicken burgers, cheeseburgers, jumbo hot dogs and chips, plus real ale. Food served during opening hours.",
  eyebrow: "Bar menu", h1: "Food &amp; drink", heroButtons: false,
  lead: "Fuel for the frames. Pizzas made for sharing, burgers and bar favourites, served to your table.",
  body: `<section class="block"><div class="wrap">
  <div class="menu-section"><h2>Pizzas</h2><div class="menu-items">
    ${pizza("Margherita", "d2bbc3_55b3b99e877c450a97bbdbe010db26db~mv2.jpg")}
    ${pizza("Vegetarian", "d2bbc3_5a3f1c6301a6454491da9318a575794a~mv2.jpg")}
    ${pizza("Pepperoni", "d2bbc3_60f6618cb7ac428f80e53b3929c2049e~mv2.jpg")}
    ${pizza("Meat Feast", "d2bbc3_67af9f6dc53940d1b3afe13c7fb5e3ab~mv2.jpg")}
  </div></div>
  <div class="menu-section"><h2>Burgers &amp; more</h2><div class="menu-items">
    ${plate("Chicken burger", "d2bbc3_498f05a5ff3743caa3da9f5c866402b3~mv2.jpg")}
    ${plate("Cheeseburger", "d2bbc3_cd0c7b8798ec4d0f83e6aa349b57b4e7~mv2.jpg")}
    ${plate("Jumbo hot dog", "d2bbc3_9e915a36ba384de694fe8880a01af018~mv2.jpg")}
    ${plate("Chicken and chips", "d2bbc3_ca8b8deec62f49d4a0cf139ce0c6ad90~mv2.jpg")}
    ${plate("Chips", "d2bbc3_74733e9f403a4fd68c01514aa22e8055~mv2.jpg")}
    ${plate("Cheesy chips", "d2bbc3_ff3ef977cf3f4087bbfa1a62d562f446~mv2.jpg")}
  </div></div>
  <p class="muted small">Images are for illustration purposes only. Due to leagues or special occasions, food may finish an hour early.</p>
</div></section>
<section class="block alt"><div class="wrap split">
  <div>
    <p class="eyebrow">At the bar</p><h2>Drinks</h2>
    <p>A full bar including real ale. Make it a night with our pool-and-pitcher deal: <strong>1 hour of pool and a 4-pint pitcher for £25</strong>.</p>
    <h3 style="margin-top:28px">Food serving times</h3>
    ${hoursTable()}
  </div>
  <div class="photo"><img src="${img(P.league, 900, 700)}" alt="A player lining up a shot at Top Spin" loading="lazy"></div>
</div></section>`,
  ld: [{ "@context": "https://schema.org", "@type": "Menu", name: "Top Spin bar menu", hasMenuSection: [
    { "@type": "MenuSection", name: "Pizzas", hasMenuItem: ["Margherita", "Vegetarian", "Pepperoni", "Meat Feast"].map((n) => ({ "@type": "MenuItem", name: `14" ${n}`, description: "Ideal for 2 people", offers: { "@type": "Offer", price: 12, priceCurrency: "GBP" } })) },
    { "@type": "MenuSection", name: "Burgers & more", hasMenuItem: ["Chicken burger", "Cheeseburger", "Jumbo hot dog", "Chicken and chips", "Chips", "Cheesy chips"].map((n) => ({ "@type": "MenuItem", name: n })) },
  ] }],
});

// ---------- LIVE SPORT ----------
// ---------- TV LISTINGS (Sky Sports Main Event) ----------
const TV = JSON.parse(readFileSync(new URL("./tv.json", import.meta.url), "utf8"));
const TV_TODAY = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
const tvDays = (() => { const by = new Map(); for (const it of TV.items.filter((i) => i.date >= TV_TODAY).sort((a, b) => (a.date + (a.start || a.onAir)).localeCompare(b.date + (b.start || b.onAir)))) { if (!by.has(it.date)) by.set(it.date, []); by.get(it.date).push(it); } return [...by.entries()]; })();
const tvDayLabel = (d) => { const t = new Date(TV_TODAY + "T12:00:00Z"); const n = new Date(d + "T12:00:00Z"); const diff = Math.round((n - t) / 864e5); const base = n.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }); return base; };
const tvSection = () => `<section class="block" id="on-tv"><div class="wrap">
  <div class="section-head"><p class="eyebrow">Sky Sports Main Event</p><h2>Coming up on the big screen</h2><p>What's on Sky Sports Main Event over the next few days. Times are UK time.</p></div>
  <div class="tv" data-tv>${tvDays.map(([d, items]) => `<div class="tv-day" data-day="${d}">
    <h3>${tvDayLabel(d)}</h3>
    <ul>${items.map((i) => `<li class="tv-item" data-date="${i.date}" data-time="${i.start || i.onAir}">
      <span class="tv-time"><strong>${i.start || i.onAir}</strong>${i.start ? `<small>On air ${i.onAir}</small>` : ""}</span>
      <span class="tv-what"><strong>${i.title}</strong><small>${i.competition}</small></span>
      <span class="tv-sport">${i.sport}</span>
    </li>`).join("")}</ul>
  </div>`).join("")}</div>
  <p class="muted" data-tv-empty ${tvDays.length ? "hidden" : ""}>No Main Event listings for the next few days yet. Check the <a href="${TV.source}" rel="noopener">Sky Sports schedule</a>.</p>
  <p class="muted small" style="margin-top:18px">Listings from <a href="${TV.source}" rel="noopener">Sky Sports</a>, last updated ${new Date(TV.updated + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" })}. Schedules can change, so check with the bar before you travel for a specific game.</p>
</div></section>`;

pages.push({
  file: "live-sport.html", heroImg: P.hero,
  title: "Live Sport in Southampton | Sky Sports & TNT Sports at Top Spin",
  description: "Watch live sport on the big screens at Top Spin, Southampton: Sky Sports, TNT Sports, football, rugby, cricket, racing and terrestrial TV, with food, drinks and pool.",
  eyebrow: "Sports bar", h1: "Live sport on the big screens", heroButtons: false,
  lead: "Catch the match, then rack up a frame. Sky Sports and TNT Sports on the big screens at Lodge Road.",

  body: `${tvSection()}
<section class="block alt"><div class="wrap">
  <div class="section-head"><p class="eyebrow">On the screens</p><h2>What we show</h2></div>
  <ul class="chips"><li>Sky Sports</li><li>TNT Sports</li><li>Football</li><li>Rugby</li><li>Cricket</li><li>Racing Channel</li><li>Terrestrial TV</li></ul>
  <p class="muted" style="margin-top:22px">Want to know if a specific fixture is on? Check our <a href="${SOCIAL.facebook}" rel="noopener">Facebook</a> and <a href="${SOCIAL.instagram}" rel="noopener">Instagram</a>, or <a href="contact.html">drop us a message</a>.</p>
</div></section>
<section class="block"><div class="wrap split">
  <div class="photo"><img src="${img(P.venue, 900, 700)}" alt="Scoreboard and pints on the rail at Top Spin" loading="lazy"></div>
  <div>
    <p class="eyebrow">Make a night of it</p><h2>Match, food, frames</h2>
    <ul class="ticks"><li>14" pizzas made for sharing</li><li>1 hour of pool and a 4-pint pitcher for £25</li><li>Six free dartboards</li><li>Groups welcome — <a href="groups.html">plan a team night</a></li></ul>
    <a class="btn btn-primary" href="${BOOK_URL}">Book a table</a>
  </div>
</div></section>`,
});

// ---------- GROUPS ----------
pages.push({
  file: "groups.html", heroImg: P.formats,
  title: "Group Bookings, Team Nights & Private Events | Top Spin Southampton",
  description: "Plan a group night out, team night or mini-tournament at Top Spin in Southampton. Block-book pool tables, add food and pitchers, and set custom formats and prizes.",
  eyebrow: "Groups &amp; events", h1: "Team nights &amp; group bookings", heroButtons: false,
  lead: "Get your team, league side, mates or colleagues around the tables. Tell us what you're planning and we'll help set it up.",
  body: `<section class="block"><div class="wrap split">
  <div>
    <p class="eyebrow">What we can do</p><h2>Your night, your format</h2>
    <ul class="ticks"><li>Block-book tables for your group</li><li>Host your own team night or mini-tournament</li><li>Custom formats and prize structures</li><li>14" pizzas (ideal for 2) and 4-pint pitchers for the table</li><li>Free darts and live sport on the big screens</li></ul>
    <p class="muted">Send us a few details — your preferred date, roughly how many people and what you have in mind — and the team will come back to you.</p>
  </div>
  <div class="form-card"><h3>Send an enquiry</h3><div data-form="enquiry" data-api="${BOOKING_API}" id="groups-form"></div></div>
</div></section>`,
});

// ---------- CUE CARE ----------
pages.push({
  file: "cue-care.html", heroImg: P.league,
  title: "Cue Re-tipping & Pool Ball Cleaning in Southampton | Top Spin",
  description: "Professional cue re-tipping (£25, or £15 with your own tip), tip shaping and pool ball cleaning (£2 a session) at Top Spin Pool and Sports Bar, Southampton.",
  eyebrow: "Services", h1: "Pro care for your gear", heroButtons: false,
  lead: "In-house cue maintenance and ball cleaning, so your equipment performs at its peak every time you play.",
  body: `<section class="block"><div class="wrap">
  <div class="grid">
    <div class="card price-card"><span class="icon">${ICON.wrench}</span><h3>Full re-tip</h3><div class="price">£25</div><p>Precision tip replacement using high-quality leathers for optimal contact and control.</p></div>
    <div class="card price-card"><span class="icon">${ICON.wrench}</span><h3>Re-tip, your tip</h3><div class="price">£15</div><p>If you provide the tip, fitting is £15.</p></div>
    <div class="card"><span class="icon">${ICON.cue}</span><h3>Tip shaping</h3><p>Tailored shaping to match your playing style — the right dome and a burnished finish for consistent performance. Ask at the bar for the price.</p></div>
    <div class="card price-card"><span class="icon">${ICON.dart}</span><h3>Ball cleaning</h3><div class="price">£2<small>/ session</small></div><p>Professional-grade cleaning for a consistent roll and trajectory. Ask at the bar.</p></div>
  </div>
</div></section>
<section class="block alt"><div class="wrap split">
  <div>
    <p class="eyebrow">How it works</p><h2>Request a cue care slot</h2>
    <ol class="ticks" style="list-style:none"><li>Request a slot with the form.</li><li>We confirm your slot by email.</li><li>Drop your cue with the staff behind the bar.</li><li>We let you know when it's ready to collect.</li></ol>
  </div>
  <div class="form-card"><div data-form="cuecare" data-api="${BOOKING_API}" id="cue-form"></div></div>
</div></section>`,
  ld: [{ "@context": "https://schema.org", "@type": "OfferCatalog", name: "Cue care services", itemListElement: [["Full cue re-tip", 25], ["Cue re-tip using customer's own tip", 15], ["Pool ball cleaning, per session", 2]].map(([name, price]) => ({ "@type": "Offer", name, price, priceCurrency: "GBP" })) }],
});

// ---------- ABOUT ----------
pages.push({
  file: "about.html", heroImg: P.tables,
  title: "About Top Spin | Pool Hall Facilities on Lodge Road, Southampton",
  description: "About Top Spin Pool and Sports Bar, Southampton: pool and Chinese pool tables, dartboards, big-screen sport, food, real ale, car park, dogs allowed and family friendly.",
  eyebrow: "About us", h1: "About Top Spin", heroButtons: false,
  lead: "Professional-grade tables meet a relaxed lounge atmosphere at Southampton's destination for cue sports.",
  body: `<section class="block"><div class="wrap split">
  <div>
    <h2>Our story</h2>
    <p>Top Spin Pool and Sports Bar was founded to raise the bar for Southampton's cue sports scene. We provide a great environment for serious competitors and social players alike, with quality in everything from the tables to the drinks.</p>
    <p>You'll find us on the first floor at 88–90 Lodge Road, with easy access from Lodge Road.</p>
  </div>
  <div class="photo"><img src="${img(P.hero, 900, 700)}" alt="The pool hall at Top Spin" loading="lazy"></div>
</div></section>
<section class="block alt"><div class="wrap">
  <div class="section-head"><h2>Facilities</h2></div>
  <ul class="chips"><li>Pool tables</li><li>Chinese pool tables</li><li>Dartboards</li><li>Food</li><li>Real ale</li><li>Big screen sport</li><li>Live music</li><li>Car park</li><li>Dogs allowed</li><li>Family friendly</li><li>Smoking area</li></ul>
</div></section>
<section class="block"><div class="wrap split">
  <div><h2>Opening times</h2>${hoursTable()}<p class="muted small" style="margin-top:12px">Food is served during opening hours. Due to leagues or special occasions, food may finish an hour early.</p></div>
  <div><h2>Find us</h2><p>${ADDRESS}</p><div class="map"><iframe title="Map showing Top Spin on Lodge Road, Southampton" loading="lazy" referrerpolicy="no-referrer-when-downgrade" src="https://www.google.com/maps?q=50.9193473,-1.3999192&z=16&output=embed"></iframe></div></div>
</div></section>`,
});

// ---------- FAQ ----------
const FAQ = [
  ["Where is Top Spin?", `We're on the first floor at 88–90 Lodge Road, Southampton SO14 6RF. <a href="${MAPS}" rel="noopener">Get directions</a>.`],
  ["What are your opening hours?", "Monday to Saturday 11:00 until midnight, and Sunday 11:00 to 22:00."],
  ["How much does a pool table cost?", "Standard tables are £10 an hour (or £18 for 2 hours) and match tables are £12 an hour. We also offer 1 hour of pool with a 4-pint pitcher for £25."],
  ["Do you have Chinese pool tables?", "Yes. Alongside our English pool tables we have Chinese pool tables."],
  ["How much is membership?", "Membership is £40 a month or £400 for 12 months. Payments are currently taken at the bar, so please speak to a member of the team."],
  ["What do members get?", `Membership gives you access to the <a href="${LEAGUE_APP}" rel="noopener">Cue Sense app</a> to manage, monitor and improve your game. Find out more at <a href="${CUESENSE}" rel="noopener">cuesense.co.uk</a>.`],
  ["Can I pay online?", "Not at the moment. Please visit us and pay at the bar."],
  ["Is darts free?", "Yes. Our six dartboards are free to use and open to everyone. Bring your own darts or borrow a house set from behind the bar."],
  ["How do I join a pool league?", `The Top Spin Singles League has five divisions, from the Premier League to Division 5, and runs on <a href="${LEAGUE_APP}" rel="noopener">Cue Sense</a>. For our darts teams, ask at the bar or <a href="contact.html">send us a message</a>.`],
  ["Where are tournaments announced?", `All our tournaments are currently run through our <a href="${FB_GROUP}" rel="noopener">Facebook group</a>.`],
  ["Do you show live sport?", "Yes — Sky Sports, TNT Sports, football, rugby, cricket, the Racing Channel and terrestrial TV on the big screens."],
  ["Do you serve food?", "Yes. 14\" pizzas (£12, ideal for 2), burgers, jumbo hot dogs, chicken and chips, and chips. Food may finish an hour early on league nights or special occasions."],
  ["Can I book for a group or team night?", `Yes. We can block-book tables and help with custom formats and prizes. <a href="groups.html">Send a group enquiry</a>.`],
  ["Do you re-tip cues?", `Yes. A full re-tip is £25, or £15 if you supply the tip. We also do tip shaping and ball cleaning (£2 a session). <a href="cue-care.html">Request a slot</a>.`],
  ["Is there parking?", "Yes, there's a car park."],
  ["Are dogs allowed?", "Yes, dogs are allowed."],
  ["Are you family friendly?", "Yes, Top Spin is family friendly."],
  ["What's your phone number?", `Our phone line is coming soon. In the meantime, email <a href="mailto:${EMAIL}">${EMAIL}</a> or use our <a href="contact.html">contact form</a>.`],
];
pages.push({
  file: "faq.html", heroImg: P.tables,
  title: "FAQs | Top Spin Pool and Sports Bar, Southampton",
  description: "Answers about Top Spin Southampton: opening hours, pool table prices, Chinese pool, free darts, membership, leagues, live sport, food, parking and group bookings.",
  eyebrow: "Help", h1: "Frequently asked questions", heroButtons: false,
  body: `<section class="block"><div class="wrap"><div class="faq">${FAQ.map(([q, a], i) => `<details${i === 0 ? " open" : ""}><summary>${q}</summary><p>${a}</p></details>`).join("")}</div>
  <p style="margin-top:28px">Can't find your answer? <a href="contact.html">Get in touch</a>.</p></div></section>`,
  ld: [{ "@context": "https://schema.org", "@type": "FAQPage", mainEntity: FAQ.map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a.replace(/<[^>]+>/g, "") } })) }],
});

// ---------- GALLERY ----------
// Albums match the three galleries on the current site, in the same order.
const GAL = readFileSync(new URL("./gallery-ids.txt", import.meta.url), "utf8").split(/\s+/).filter(Boolean);
const ALBUMS = [
  { slug: "ladies-tournament", name: "Ladies Tournament", ids: GAL.slice(0, 121),
    blurb: "Photos from the Ladies' Pool Competition at Top Spin, held on 26 September 2026.",
    title: "Ladies Pool Tournament Photos | Top Spin Southampton" },
  { slug: "darts-tournament", name: "Darts Tournament", ids: GAL.slice(268),
    blurb: "Photos from the darts event at Top Spin on 26 September 2026.",
    title: "Darts Tournament Photos | Top Spin Southampton" },
  { slug: "highlights", name: "Highlights", ids: GAL.slice(121, 268),
    blurb: "A selection of photos from Top Spin's tournaments and social play.",
    title: "Highlights: Tournaments & Social Play | Top Spin Southampton" },
];
const thumb = (id, w, h) => `https://static.wixstatic.com/media/${id}/v1/fill/w_${w},h_${h},al_c,q_75,enc_auto/${id}`;
const albumTabs = (active) => `<nav class="album-tabs" aria-label="Albums"><a href="gallery.html"${active ? "" : ' aria-current="page"'}>All albums</a>${ALBUMS.map((a) => `<a href="gallery-${a.slug}.html"${a.slug === active ? ' aria-current="page"' : ""}>${a.name} <span>${a.ids.length}</span></a>`).join("")}</nav>`;
const lightbox = `<div class="lightbox" role="dialog" aria-modal="true" aria-label="Photo viewer"><img alt=""><p class="lb-count" aria-live="polite"></p><button class="lb-close" aria-label="Close">✕</button><button class="lb-prev" aria-label="Previous photo">‹</button><button class="lb-next" aria-label="Next photo">›</button></div>`;
pages.push({
  file: "gallery.html", heroImg: P.league,
  title: "Gallery | Photos from Top Spin Pool and Sports Bar, Southampton",
  description: `Photo albums from Top Spin Southampton: the Ladies Tournament, the Darts Tournament and highlights from tournaments and social play. ${GAL.length} photos.`,
  eyebrow: "Gallery", h1: "Top Spin in pictures", heroButtons: false,
  lead: `${GAL.length} photos across three albums. Pick one to browse.`,
  body: `<section class="block"><div class="wrap">
  ${albumTabs(null)}
  <div class="albums">${ALBUMS.map((a) => `<a class="album" href="gallery-${a.slug}.html">
    <div class="album-cover"><img src="${thumb(a.ids[0], 900, 640)}" alt="" loading="lazy"><div class="album-strip">${a.ids.slice(1, 4).map((id) => `<img src="${thumb(id, 300, 220)}" alt="" loading="lazy">`).join("")}</div></div>
    <div class="album-meta"><h2>${a.name}</h2><p>${a.blurb}</p><span class="album-count">${a.ids.length} photos</span></div>
  </a>`).join("")}</div>
</div></section>`,
  ld: [{ "@context": "https://schema.org", "@type": "CollectionPage", name: "Top Spin photo gallery", hasPart: ALBUMS.map((a) => ({ "@type": "ImageGallery", name: a.name, url: `${SITE || LIVE}/gallery-${a.slug}.html` })) }],
});
for (const a of ALBUMS) pages.push({
  file: `gallery-${a.slug}.html`, navFile: "gallery.html", heroImg: P.league,
  title: a.title, description: `${a.blurb} ${a.ids.length} photos from Top Spin Pool and Sports Bar, Lodge Road, Southampton.`,
  eyebrow: "Gallery", h1: a.name, heroButtons: false, lead: a.blurb,
  crumbParent: ["Gallery", "gallery.html"],
  body: `<section class="block"><div class="wrap">
  ${albumTabs(a.slug)}
  <div class="gallery" data-gallery data-album="${a.name}"></div>
  <div class="load-more"><button class="btn btn-ghost" type="button" data-more>Load more photos</button></div>
  <noscript><p>Turn on JavaScript to view the photos.</p></noscript>
</div></section>
${lightbox}
<script type="application/json" id="gallery-data">${JSON.stringify(a.ids.map((id) => [`https://static.wixstatic.com/media/${id}/v1/fit/w_480,h_480,q_80,enc_auto/${id}`, `https://static.wixstatic.com/media/${id}/v1/fit/w_1600,h_1600,q_80,enc_auto/${id}`]))}</script>`,
  ld: [{ "@context": "https://schema.org", "@type": "ImageGallery", name: `${a.name} — Top Spin Pool and Sports Bar`, description: a.blurb, numberOfItems: a.ids.length, image: a.ids.slice(0, 12).map((id) => `https://static.wixstatic.com/media/${id}`) }],
});

// ---------- BOOK A TABLE ----------
// Booking runs on Cue Sense (members in the app, everyone else here). No online payment - pay at the bar.
pages.push({
  file: "book.html", heroImg: P.tables,
  title: "Book a Pool Table | Top Spin Pool and Sports Bar, Southampton",
  description: "Book a pool table at Top Spin, Lodge Road, Southampton: Table 13, Match Tables 1-3 or the Chinese 8 Ball table. Pick a time online and pay at the bar.",
  eyebrow: "Book a table", h1: "Book a table", heroButtons: false,
  lead: "Choose your table, day and time. There's nothing to pay online — you pay at the bar on the day.",
  body: `<section class="block"><div class="wrap split" style="align-items:start">
  <div data-booking data-api="${BOOKING_API}" aria-live="polite"><div class="bk-card"><p class="muted">Loading available tables…</p><noscript><p>Online booking needs JavaScript. Please <a href="contact.html#contact-form">send us a message</a> instead.</p></noscript></div></div>
  <div>
    <h2 style="font-size:2rem">Good to know</h2>
    <ul class="ticks"><li>Pay at the bar — no card details online</li><li>We email your confirmation, with a link to move or cancel</li><li>Members can also book in the <a href="${LEAGUE_APP}" rel="noopener">Cue Sense app</a></li><li>Booking for a group or team night? <a href="groups.html">Send a group enquiry</a></li></ul>
    <p><a href="pool.html">See all table prices and offers</a></p>
    ${hoursTable()}
  </div>
</div></section>`,
});

// ---------- CONTACT ----------
pages.push({
  file: "contact.html", heroImg: P.venue,
  title: "Contact & Directions | Top Spin Pool and Sports Bar, Southampton",
  description: "Contact Top Spin Pool and Sports Bar: 1st Floor, 88-90 Lodge Rd, Southampton SO14 6RF. Email info@TopSpinPoolAndSportsBar.co.uk or send an enquiry online.",
  eyebrow: "Contact", h1: "Get in touch", heroButtons: false,
  lead: "Questions, group bookings, leagues or membership — send us a message and the team will get back to you.",
  body: `<section class="block"><div class="wrap split" style="align-items:start">
  <div class="form-card"><h2 style="font-size:2rem">Send a message</h2><div data-form="enquiry" data-api="${BOOKING_API}" id="contact-form"></div></div>
  <div>
    <h2 style="font-size:2rem">Visit us</h2>
    <p>${ADDRESS}<br><a href="${MAPS}" rel="noopener">Get directions</a></p>
    <p><strong>Email:</strong> <a href="mailto:${EMAIL}">${EMAIL}</a><br><strong>Phone:</strong> <span class="muted">coming soon</span></p>
    ${hoursTable()}
    <div class="map" style="margin-top:24px"><iframe title="Map showing Top Spin on Lodge Road, Southampton" loading="lazy" referrerpolicy="no-referrer-when-downgrade" src="https://www.google.com/maps?q=50.9193473,-1.3999192&z=16&output=embed"></iframe></div>
  </div>
</div></section>`,
});

// ---------- EVENTS ----------
// Each event comes from a post in one of the two Top Spin flyer groups on Facebook.
// date = YYYY-MM-DD (event day); past events are hidden in the browser automatically.
const TODAY = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
const EVENTS = JSON.parse(readFileSync(new URL("./events.json", import.meta.url), "utf8")).filter((e) => e.date >= TODAY).sort((a, b) => a.date.localeCompare(b.date));
const fmtDate = (d) => new Date(d + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Europe/London" });
const evTime = (e) => e.start ? new Date(e.start).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" }) : "";
const evPart = (d, o) => new Date(d + "T12:00:00Z").toLocaleDateString("en-GB", { ...o, timeZone: "Europe/London" });
const eventCard = (e) => `<article class="event-card${e.tag === "Grand final" ? " final" : ""}" data-date="${e.date}">
  <div class="event-date" aria-hidden="true"><span class="dow">${evPart(e.date, { weekday: "short" })}</span><span class="day">${evPart(e.date, { day: "numeric" })}</span><span class="mon">${evPart(e.date, { month: "short" })}</span></div>
  <div class="event-body">
    <p class="event-tag">${e.tag || "Event"}</p>
    <h3>${e.title}</h3>
    <p class="sr-only">${fmtDate(e.date)}</p>
    <ul class="event-facts">${evTime(e) ? `<li><span>Start</span>${evTime(e)}</li>` : ""}${e.entry ? `<li><span>Entry</span>${e.entry}</li>` : ""}</ul>
    <p class="event-lead">${e.details[0]}</p>
    ${e.details.length > 1 ? `<ul class="event-more">${e.details.slice(1).map((d) => `<li>${d}</li>`).join("")}</ul>` : ""}
    <a class="btn btn-primary event-cta" href="${e.source}" rel="noopener">${e.entry ? "Enter on Facebook" : "Details on Facebook"}</a>
  </div>
</article>`;
pages.push({
  file: "events.html", heroImg: P.tourn,
  title: "What's On | Pool & Darts Competitions at Top Spin Southampton",
  description: "Upcoming pool knockouts, leagues, darts competitions and events at Top Spin Pool and Sports Bar, Lodge Road, Southampton.",
  eyebrow: "What's on", h1: "Upcoming events", heroButtons: false,
  lead: "Competitions and events at Top Spin, as posted in our Facebook flyer groups.",
  body: `<section class="block"><div class="wrap">
  <div class="events-list" data-events>${EVENTS.map(eventCard).join("")}</div>
  <p class="muted" data-no-events ${EVENTS.length ? "hidden" : ""}>No upcoming events are listed right now. New competitions are posted in our Facebook groups first.</p>
  <div class="btns" style="margin-top:28px"><a class="btn btn-primary" href="${FB_GROUP}" rel="noopener">Pool flyer group</a><a class="btn btn-ghost" href="${FB_DARTS_GROUP}" rel="noopener">Darts flyer group</a></div>
</div></section>
${newsletter}`,
  ld: EVENTS.map((e) => ({ "@context": "https://schema.org", "@type": "SportsEvent", name: e.title, startDate: e.start || e.date, eventStatus: "https://schema.org/EventScheduled", eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode", description: e.details.join(" ").replace(/<[^>]+>/g, ""), location: { "@type": "Place", name: "Top Spin Pool and Sports Bar", address: { "@type": "PostalAddress", streetAddress: "1st Floor, 88-90 Lodge Road", addressLocality: "Southampton", postalCode: "SO14 6RF", addressCountry: "GB" } }, organizer: { "@type": "Organization", name: "Top Spin Pool and Sports Bar", url: SITE || LIVE }, url: e.source })),
});

// ---------- 404 ----------
pages.push({
  file: "404.html", heroImg: P.tables, title: "Page not found | Top Spin", description: "That page could not be found.",
  h1: "Missed the pocket", lead: "That page doesn't exist. Head back to the homepage.", heroButtons: false,
  body: `<section class="block"><div class="wrap"><a class="btn btn-primary" href="index.html">Back to home</a></div></section>`,
});

// Images: the site no longer loads anything from Wix. Every static.wixstatic.com URL a page
// uses is served from media/ (committed copies, downloaded once by build/localise-images.mjs).
// Any not downloaded yet are listed in build/wix-images.json and left pointing at Wix until
// that script has run - the deploy workflow runs it and fails if any are still missing.
const MEDIA_SRC = new URL("../media/", import.meta.url);
const MEDIA_OUT = new URL("media/", OUT);
mkdirSync(MEDIA_OUT, { recursive: true });
const missing = new Map();
const mediaName = (u) => {
  const last = u.split("/").pop().split("?")[0];
  const ext = (/\.(png|jpe?g|webp|gif|svg)$/i.exec(last) || [".jpg"])[0].toLowerCase();
  return createHash("sha1").update(u).digest("hex").slice(0, 20) + ext;
};
const localise = (html) => html.replace(/https:\/\/static\.wixstatic\.com\/media\/[^"'\s)<>\\]+/g, (u) => {
  const name = mediaName(u);
  if (existsSync(new URL(name, MEDIA_SRC))) {
    copyFileSync(new URL(name, MEDIA_SRC), new URL(name, MEDIA_OUT));
    return `${SITE || LIVE}/media/${name}`;
  }
  missing.set(name, u);
  return u;
});
for (const p of pages) writeFileSync(new URL(p.file, OUT), localise(page(p)));
writeFileSync(new URL("./wix-images.json", import.meta.url), JSON.stringify([...missing].map(([name, url]) => ({ name, url })), null, 1) + "\n");
if (missing.size) console.log(`${missing.size} images still load from Wix - run node build/localise-images.mjs`);

// robots, sitemap, llms.txt
const base = SITE || LIVE;
writeFileSync(new URL("robots.txt", OUT), `User-agent: *\nAllow: /\n\nUser-agent: GPTBot\nAllow: /\nUser-agent: OAI-SearchBot\nAllow: /\nUser-agent: ChatGPT-User\nAllow: /\nUser-agent: ClaudeBot\nAllow: /\nUser-agent: Claude-SearchBot\nAllow: /\nUser-agent: PerplexityBot\nAllow: /\nUser-agent: Google-Extended\nAllow: /\n\nSitemap: ${base}/sitemap.xml\n`);
writeFileSync(new URL("sitemap.xml", OUT), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${pages.filter((p) => p.file !== "404.html").map((p) => `<url><loc>${base}/${p.file === "index.html" ? "" : p.file}</loc><lastmod>2026-10-13</lastmod></url>`).join("\n")}\n</urlset>\n`);
writeFileSync(new URL("llms.txt", OUT), `# Top Spin Pool and Sports Bar

> Pool hall and sports bar on the first floor at 88-90 Lodge Road, Southampton SO14 6RF, UK. English pool tables, Chinese pool tables, six free dartboards, live sport on big screens (Sky Sports, TNT Sports), food and drink, pool leagues and tournaments.

## Key facts
- Address: 1st Floor, 88-90 Lodge Rd, Southampton SO14 6RF
- Email: ${EMAIL}
- Phone: coming soon
- Opening hours: Monday-Saturday 11:00-00:00; Sunday 11:00-22:00
- Table prices: standard table £10/hour (£18 for 2 hours); match table £12/hour; 1 hour of pool + 4-pint pitcher £25
- Membership: £40/month or £400/year (payment at the bar; no online payments yet). Membership includes access to the Cue Sense app (${LEAGUE_APP}) to manage, monitor and improve your game; more at ${CUESENSE}
- Darts: six boards, free to use; house darts available; two darts teams play Mondays and Thursdays
- Leagues: Top Spin Singles League, five divisions (Premier League to Division 5), run on Cue Sense (${LEAGUE_APP})
- Tournaments: announced in the Top Spin Facebook group (${FB_GROUP})
- Cue care: full re-tip £25 (£15 with own tip), tip shaping, ball cleaning £2 per session
- Food: 14" pizzas £12 (Margherita, Vegetarian, Pepperoni, Meat Feast), burgers, jumbo hot dog, chicken and chips, chips, cheesy chips
- Facilities: car park, dogs allowed, family friendly, smoking area, real ale, live music

## Pages
${pages.filter((p) => p.file !== "404.html").map((p) => `- [${p.title.split(" | ")[0]}](${base}/${p.file === "index.html" ? "" : p.file}): ${p.description}`).join("\n")}

## Social
${Object.entries(SOCIAL).map(([k, u]) => `- ${k}: ${u}`).join("\n")}
`);
console.log("built", pages.length, "pages for", base);
