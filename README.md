# Top Spin — new headless website (handoff)

Read this before editing the new Top Spin site in any chat. **Do not rebuild the site from scratch** — everything needed is here.

## Where things are

| What | Where |
|---|---|
| New site (Fly.io) | https://topspin-website.fly.dev (Fly app `topspin-website`, noindex until the real domain moves) |
| Source (git) | Branch `topspin-website` of MBaileyWebsiteDesign/Cue-Sense-League-Management (a push deploys it) |
| Bookings + forms backend | Cue Sense app https://app.cuesense.co.uk: `server/src/routes/tableBookings.js`, `server/src/routes/venueForms.js` |
| Old headless Wix site (retired) | "Top Spin Pool & Sports Bar 2026", site ID `c1cccf19-2e40-4ad5-8146-eb4f051b39e6`, no longer used |
| Old live site (untouched) | https://www.topspinpoolandsportsbar.co.uk — Wix site ID `80f3f389-3377-4c7f-882e-05b689a5cde0` |
| Source files (this folder) | `Clients/Active/Client - Top Spin/Website/New Headless Site/` in OneDrive |
| Audit & recommendations doc | https://claude.ai/code/artifact/1584a31b-98ae-45fa-8b7e-58d430bb61fb |
| Real event photos | `Pictures/Working images/Top Spin Ladies and Darts/2026/2026-09-26/Processed/Final Cut/` |

## How the site is built

A static site (plain HTML/CSS/JS, no framework) served by nginx on Fly.io. **No Wix**: table booking and the three forms (enquiry, newsletter, cue care) go to the Cue Sense app, and entries show in Top Spin's Venue portal (Table booking card, Website messages card).

- `build/build.mjs`: **the source of truth.** Generates every page in `site/` (copy, prices, hours, FAQ, structured data, sitemap, robots.txt, llms.txt). Edit content here, not in the generated HTML. `BOOKING_API` is the Cue Sense app the booking page and forms talk to.
- `build/events.json`, `build/tv.json`, `build/gallery-ids.txt`: What's On events, Sky Sports Main Event listings, gallery photo IDs (lines 1-121 Ladies, 122-268 Highlights, 269-321 Darts).
- `site/css/style.css`, `site/js/main.js`, `site/js/booking.js` (book.html), `site/js/forms.js` (forms): hand-written, edit directly. `site/img/` holds real event photos.
- Images: photos that came from the old Wix media library are downloaded at build time by `build/localise-images.mjs` into `/media` and served by the site itself, so visitors never load from Wix. **Before the old Wix site is closed** those images need a permanent home (commit them to `media/`, or re-export from the originals), or the build will fail.
- `Dockerfile`, `fly.toml`, `deploy/nginx.conf`, `.github/workflows/deploy-topspin-website.yml`: hosting.

Build locally: `SITE_URL=https://topspin-website.fly.dev STAGING=1 node build/build.mjs` (Node 22+). `STAGING=0` (or unset) drops the `noindex` tag.

## How to deploy a change

Commit to the `topspin-website` branch and push. GitHub Actions builds the Docker image on Fly and deploys the app `topspin-website`.

One-time setup (needs Matt's Fly login):
1. `fly apps create topspin-website`
2. `fly tokens create deploy -a topspin-website`, then add it as repository secret `TOPSPIN_WEBSITE_FLY_TOKEN`, then re-run the workflow.
3. Cue Sense, Venue portal, Top Spin, Table booking card: add `https://topspin-website.fly.dev` (and later the real domain) to the venue website addresses.

Real domain later: `fly certs add www.topspinpoolandsportsbar.co.uk -a topspin-website`, point DNS at Fly, set repository variables `TOPSPIN_SITE_URL` (the domain) and `TOPSPIN_STAGING=0`, add the website address in Cue Sense, (the 301 redirects from the old Wix page addresses are already in `deploy/nginx.conf`).

## Forms and booking (Cue Sense)

| Form | Kind | Used on |
|---|---|---|
| Enquiry | `enquiry` | Contact, Groups |
| Newsletter | `newsletter` | Home, Pool, What's On |
| Cue care request | `cuecare` | Cue Care |

Fields are defined in `site/js/forms.js` and checked again in `server/src/routes/venueForms.js` (change both). The Cue Sense app only accepts entries and bookings from the website addresses listed on the venue's Table booking card.

## Pages

Home, Pool & Prices, Darts, Leagues & Tournaments, Food & Drink, What's On, Live Sport, Groups, Cue Care, About, FAQ, Gallery (+ 3 album pages: Ladies Tournament, Darts Tournament, Highlights), Contact, 404.

## Decisions made so far (keep these)

- The new site does not use Wix at all (hosting, forms, booking).
- Six free dartboards (not two). Darts page shows the World Darts Championship wall plus a "Six boards, four spots" section: second double board, two single boards.
- No shuffleboard anywhere.
- Opening hours: Mon–Sat 11:00–midnight, Sunday 11:00–22:00, on separate lines.
- "Get in touch" and the mobile "Enquire" button go to the contact form (`contact.html#contact-form`), not an email link.
- Membership (£40/month, £400/year) includes access to the Cue Sense app (https://app.cuesense.co.uk; site https://cuesense.co.uk) to manage, monitor and improve your game.
- Page header images: Darts, Groups and What's On use the original header images (owner preferred them). Real event photos are used further down the pages.
- Home "Built for serious English pool" section uses `img/pool-closeup.jpg` (not the same photo as the hero).
- Gallery split into three albums with their own pages, matching the old site; album filter buttons wrap into a 2×2 grid on phones.
- Table booking (3 Nov): "Book" buttons go to `book.html`, which runs `site/js/booking.js` against the Cue Sense booking API (`BOOKING_API` in build.mjs, the production Cue Sense app https://app.cuesense.co.uk). Anyone can book from the website (name, email, phone); members can also book in the app. Tables: Table 13, Match Tables 1–3, Chinese 8 Ball, with prices; 5-minute changeover; customers move/cancel via the link in their confirmation email (book.html?booking=…&token=…), no cut-off. The API only answers requests from website addresses listed in the venue's booking settings in the Cue Sense Venue portal. Server code: repo MBaileyWebsiteDesign/Cue-Sense-League-Management, server/src/routes/tableBookings.js. Decisions: https://claude.ai/artifact/EyWndoVBACKsXc7vCHrqur
- No online payments yet; prices say "pay at the bar".

## Still open

- Real phone number (currently "coming soon").
- Burger/hot dog/chips prices, drinks list and membership perks (not on the old site).
- More events from the two Facebook flyer groups — needs a logged-in Facebook session to read (only one public post visible: Sun 25 Oct D & E straight knockout, reg 11:00, games 12:00, races to 7).
- Real food/bar photos to replace the illustrative menu images.
- Moving to the real domain: see "Real domain later" above (redirects are ready in deploy/nginx.conf); resubmit the sitemap.
