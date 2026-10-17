// Marketing review - copies of Marketing Agent items taken from the Wix dashboard
// (Matt, 2026-10-17). Wix has no API for these items, so this file is refreshed by
// hand when Matt asks: replace `items` and `copiedAt`, then deploy. On startup the
// server upserts each item by id for the venue whose name starts with
// `venueNamePrefix`. Content is updated; a venue's Approve / Dismiss decisions are
// kept. Items missing from a newer copy are hidden, not deleted.
export const MARKETING_SEEDS = [
  {
    venueNamePrefix: 'Top Spin',
    source: 'Wix Marketing Agent',
    copiedAt: '2026-10-17',
    wixUrl: 'https://manage.wix.com/dashboard/80f3f389-3377-4c7f-882e-05b689a5cde0/marketing-assistant',
    items: [
      {
        "body": "Finding the perfect venue to enjoy English Pool, Darts, and live sports in Southampton can be challenging. I have discovered a place that elevates the traditional sports bar into a refined social lounge. This venue combines premium gaming facilities with a sophisticated atmosphere. It caters to enthusiasts who appreciate quality, comfort, and a vibrant community. The ultimate Southampton live sports bar offers more than just screens and drinks; it delivers an immersive experience.Why Choose a So...",
        "channel": "Blog",
        "format": "Blog post",
        "kind": "blog",
        "scheduledFor": "2026-10-19T08:55:00+01:00",
        "title": "The Ultimate Southampton Live Sports Bar Experience",
        "truncated": true,
        "id": "b01"
      },
      {
        "body": "Summary shown in Wix: This promotional email invites Southampton members and sports enthusiasts to book their festive group celebrations at Top Spin Pool and Sports Bar. It highlights the premium clubhouse atmosphere, table hire options, and member perks in an elegant and confident tone.",
        "channel": "Email",
        "format": "Campaign",
        "kind": "email",
        "scheduledFor": "2026-10-19T08:45:00+01:00",
        "title": "Elevate Your Festive Gatherings at Top Spin Pool and Sports Bar",
        "truncated": false,
        "id": "e01"
      },
      {
        "body": "Summary shown in Wix: This promotional email positions Halloween as a premium, high-energy games night at Top Spin Pool and Sports Bar in Southampton. It targets English pool, darts, and sports enthusiasts with a sophisticated invitation featuring elite tables, reserved space, and crafted drinks in an upscale setting.",
        "channel": "Email",
        "format": "Campaign",
        "kind": "email",
        "scheduledFor": "2026-10-29T07:55:00+00:00",
        "title": "Halloween reimagined as a premium games night with atmosphere and edge.",
        "truncated": false,
        "id": "e02"
      },
      {
        "body": "Summary shown in Wix: This promotional email invites local couples in Southampton to celebrate Karwa Chauth as a sophisticated evening at Top Spin Pool and Sports Bar. It highlights the refined lounge setting, attentive service, and a curated atmosphere on Lodge Road, offering a premium alternative to standard dinner reservations.",
        "channel": "Email",
        "format": "Campaign",
        "kind": "email",
        "scheduledFor": "2026-10-29T10:10:00+00:00",
        "title": "Karwa Chauth as a sophisticated couples’ evening in Southampton.",
        "truncated": false,
        "id": "e03"
      },
      {
        "body": "Summary shown in Wix: This promotional email is crafted for Top Spin Pool and Sports Bar in Southampton, delivering a last-call invitation for a sophisticated Halloween night out. It targets English pool, darts, and sports enthusiasts seeking a premium lounge experience, highlighting exclusive VIP table packages, standout menu features, and a member-only welcome drink perk while establishing a high-value, scarce reservation atmosphere.",
        "channel": "Email",
        "format": "Campaign",
        "kind": "email",
        "scheduledFor": "2026-10-30T07:30:00+00:00",
        "title": "Halloween Last-Call: Secure Your VIP Table at Top Spin",
        "truncated": false,
        "id": "e04"
      },
      {
        "body": "We present a premium Chinese 8 Ball booking at Top Spin Southampton, with elite tables held for 15 minutes to keep your night running smoothly. Book the Chinese 8 Ball service now: https://wix.to/Vi7qwsH",
        "channel": "Google Business Profile",
        "format": "Post",
        "kind": "social",
        "scheduledFor": "2026-10-18T08:40:00+01:00",
        "truncated": false,
        "id": "s01"
      },
      {
        "body": "Book Chinese 8 Ball at Top Spin Southampton for Vijayadashami Night-reserve an elite table in our premium club atmosphere for serious play and refined socialising. Book the Chinese 8 Ball service now: https://wix.to/oY9U3VZ 🔥🎱🍸 #TopSpinSouthampton #EnglishPool #VijayadashamiNight #PremiumPlay",
        "channel": "Facebook",
        "format": "Post",
        "kind": "social",
        "scheduledFor": "2026-10-18T08:40:00+01:00",
        "truncated": false,
        "id": "s02"
      },
      {
        "body": "Book Chinese 8 Ball at Top Spin and elevate Vijayadashami Night with our elite table offering-serious play, refined atmosphere. Reserve your table now and pay on arrival; tables held for 15 minutes. Book the service.",
        "channel": "Instagram",
        "format": "Post",
        "kind": "social",
        "scheduledFor": "2026-10-18T08:40:00+01:00",
        "truncated": false,
        "id": "s03"
      },
      {
        "body": "We present Southampton’s premium pool hall for players who notice the details. Professional-grade tables. A refined setting. Every match feels sharper, cleaner and more serious. Visit us at TopSpin Southampton on Lodge Road for elevated play and a polished lounge experience. Book a table or drop in to see the",
        "channel": "Google Business Profile",
        "format": "Post",
        "kind": "social",
        "scheduledFor": "2026-10-20T08:50:00+01:00",
        "truncated": true,
        "id": "s04"
      },
      {
        "body": "We present Southampton’s premium pool hall for players who notice the details. Our professional-grade tables and refined setting make every match feel sharper, cleaner and more serious. Come for the game. Stay for the quality. Visit us at https://wix.to/RMP8Lf8 to book a table. #TopSpinSouthampton #PremiumPool #SouthamptonPool #PoolLife 🎱🏆",
        "channel": "Facebook",
        "format": "Post",
        "kind": "social",
        "scheduledFor": "2026-10-20T08:50:00+01:00",
        "truncated": false,
        "id": "s05"
      },
      {
        "body": "We raise the standard of play. Precision-maintained, professional-grade tables. A refined setting that sharpens focus and raises the bar. Play feels cleaner. Play feels sharper. Play feels serious. Book your next match at TopSpin Southampton - where detail matters. Link in bio. 🎱✨🔒🎯 #TopSpinSouthampton #SouthamptonPool #PremiumPoolHall #PoolLife #CueSports #SouthamptonNights #EnglishPool",
        "channel": "Instagram",
        "format": "Post",
        "kind": "social",
        "scheduledFor": "2026-10-20T08:50:00+01:00",
        "truncated": false,
        "id": "s06"
      },
      {
        "body": "We offer a premium sports-bar experience where competition meets community. Play cue sports and darts in a refined atmosphere built for rivalry and repeat visits. Join us at TopSpin Southampton on Lodge Road for game nights that feel elevated. Book your table today and make TopSpin your match-night destination. 📍TopSpin",
        "channel": "Google Business Profile",
        "format": "Post",
        "kind": "social",
        "scheduledFor": "2026-10-21T09:10:00+01:00",
        "truncated": true,
        "id": "s07"
      },
      {
        "channel": "Facebook",
        "format": "Story",
        "kind": "social",
        "scheduledFor": "2026-10-21T09:10:00+01:00",
        "truncated": false,
        "id": "s08"
      },
      {
        "body": "We invite Southampton to experience match night redefined at Top Spin. Our polished sports bar pairs competitive pool and darts with a refined lounge atmosphere. We host community-led rivalries, repeat game nights, and memorable evenings. Join us on Lodge Road for great competition and great company. https://wix.to/ZikVB3d #TopSpinSouthampton #PoolAndDarts #GameNight",
        "channel": "Facebook",
        "format": "Post",
        "kind": "social",
        "scheduledFor": "2026-10-21T09:10:00+01:00",
        "truncated": false,
        "id": "s09"
      },
      {
        "channel": "Instagram",
        "format": "Story",
        "kind": "social",
        "scheduledFor": "2026-10-21T09:10:00+01:00",
        "truncated": false,
        "id": "s10"
      },
      {
        "body": "We host competition, community and crafted evenings. Join us for cue sports, darts and polished match nights in the heart of Southampton. We offer refined atmosphere, regular rivalry and repeat reasons to return. Link in bio to book a table and enter the leaderboard. Who are you bringing to TopSpin",
        "channel": "Instagram",
        "format": "Post",
        "kind": "social",
        "scheduledFor": "2026-10-21T09:10:00+01:00",
        "truncated": true,
        "id": "s11"
      },
      {
        "body": "We present English pool as a premium competitive experience. We provide quality tables, focused match conditions and professional hosting in a welcoming lounge. We create the atmosphere serious players seek and the elevated night out guests expect. Visit TopSpin Southampton on Lodge Road to play where the game feels authentic",
        "channel": "Google Business Profile",
        "format": "Post",
        "kind": "social",
        "scheduledFor": "2026-10-22T09:15:00+01:00",
        "truncated": true,
        "id": "s12"
      },
      {
        "body": "We present serious English pool in a premium, welcoming setting. We provide quality tables, focused match conditions and attentive hosting. We create an elevated night out where the game feels authentic and competitive. Visit our profile for details - Link in bio. 🎱🏆✨🔥\n\nTell us: are you playing singles or doubles",
        "channel": "Instagram",
        "format": "Post",
        "kind": "social",
        "scheduledFor": "2026-10-22T09:15:00+01:00",
        "truncated": false,
        "id": "s13"
      },
      {
        "channel": "Facebook",
        "format": "Story",
        "kind": "social",
        "scheduledFor": "2026-10-22T09:15:00+01:00",
        "truncated": false,
        "id": "s14"
      },
      {
        "channel": "Instagram",
        "format": "Story",
        "kind": "social",
        "scheduledFor": "2026-10-22T09:15:00+01:00",
        "truncated": false,
        "id": "s15"
      }
    ]
  },
];
