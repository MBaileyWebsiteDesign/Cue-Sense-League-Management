import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import '../pages/loginPage.css';

// "Create Link" (Matt, 2026-10-17): lets someone put the app on their desktop
// or phone home screen from the login page.
//
// A web page cannot place an icon on a desktop or home screen by itself, so
// this uses what each platform really offers:
//  - Chrome / Edge (Windows, Mac, Linux, Android): the browser's own install
//    prompt, kept from the `beforeinstallprompt` event (needs the web app
//    manifest + icons from vite.config.js).
//  - iPhone / iPad (Safari): no install prompt exists for websites, so short
//    step-by-step instructions are shown instead, with the Share / ... / Add to
//    Home Screen icons drawn in line, the newer (iOS 26) and older Share-button
//    positions, and an "Edit Actions" tip. If the page was opened in another
//    browser or inside another app (Facebook, WhatsApp, email...), a "Copy link"
//    box asks them to paste it into Safari first - that is the usual reason
//    Add to Home Screen is missing.
//  - Phones (iPhone/iPad/Android): a slim "Install app" bar pinned to the bottom of
//    the screen instead of the in-page button. It is hidden once the app is
//    installed (opened from the home-screen icon, or - Android Chrome - reported
//    installed / no install prompt offered) and can be closed with an x, which is
//    remembered on that phone. iPhone/iPad cannot report an install from inside
//    Safari, so there the bar still shows in a Safari tab until it is closed.
//  - Desktop fallback: a small shortcut file to download - .url (Windows),
//    .webloc (Mac), .desktop (Linux) - that opens the site in the browser.

// The install-prompt event can fire before the Login page has mounted, so it
// is captured once at module level (this file loads with the app).
let deferredPrompt = null;
const promptListeners = new Set();
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    promptListeners.forEach((fn) => fn());
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    promptListeners.forEach((fn) => fn());
  });
}

function detectPlatform() {
  if (typeof navigator === 'undefined') return 'other';
  const ua = navigator.userAgent || '';
  // iPadOS 13+ reports itself as a Mac, so tell it apart by touch support.
  const iPadOS = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  if (/iPhone|iPad|iPod/.test(ua) || iPadOS) return 'ios';
  if (/Android/.test(ua)) return 'android';
  if (/Windows/.test(ua)) return 'windows';
  if (/Macintosh|Mac OS X/.test(ua)) return 'mac';
  if (/Linux|X11|CrOS/.test(ua)) return 'linux';
  return 'other';
}

function isInstalledApp() {
  if (typeof window === 'undefined') return false;
  return (
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
    window.navigator.standalone === true
  );
}

const APP_NAME = 'Cue Sense';
const DISMISS_KEY = 'csInstallBarDismissed';

function readDismissed() {
  try { return window.localStorage.getItem(DISMISS_KEY) === '1'; } catch { return false; }
}

function shortcutFile(kind) {
  const url = `${window.location.origin}/`;
  if (kind === 'windows') {
    return {
      name: `${APP_NAME}.url`,
      type: 'application/octet-stream',
      body: `[InternetShortcut]\r\nURL=${url}\r\n`,
    };
  }
  if (kind === 'mac') {
    return {
      name: `${APP_NAME}.webloc`,
      type: 'application/octet-stream',
      body:
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
        '<plist version="1.0">\n<dict>\n\t<key>URL</key>\n' +
        `\t<string>${url}</string>\n</dict>\n</plist>\n`,
    };
  }
  return {
    name: `${APP_NAME}.desktop`,
    type: 'application/octet-stream',
    body: `[Desktop Entry]\nType=Link\nName=${APP_NAME}\nURL=${url}\nIcon=${url}pwa-192.png\n`,
  };
}

function downloadShortcut(kind) {
  const f = shortcutFile(kind);
  const blobUrl = URL.createObjectURL(new Blob([f.body], { type: f.type }));
  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = f.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
}

// iPhone / iPad only: 'safari', 'other' (Chrome, Firefox, Edge...) or 'inapp'
// (a browser built into another app). Safari's own user agent contains
// "Safari/"; app web views normally do not.
function detectIosBrowser() {
  const ua = navigator.userAgent || '';
  if (/FBAN|FBAV|FB_IAB|Instagram|Line\/|Messenger|Snapchat|TikTok|Twitter|LinkedInApp|MicroMessenger|GSA\//.test(ua)) return 'inapp';
  if (/CriOS|FxiOS|EdgiOS|OPiOS|OPT\/|DuckDuckGo|Brave|YaBrowser/.test(ua)) return 'other';
  if (!/Safari\//.test(ua)) return 'inapp';
  return 'safari';
}

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the older method */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

// Small line icons so the steps show what to look for on the phone.
const iconProps = { className: 'lg-ico', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true };
const ShareIcon = () => (
  <svg {...iconProps}><path d="M12 15V3M8 7l4-4 4 4M6 10H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2h-1" /></svg>
);
const DotsIcon = () => (
  <svg {...iconProps} fill="currentColor" stroke="none"><circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" /></svg>
);
const PlusSquareIcon = () => (
  <svg {...iconProps}><rect x="3" y="3" width="18" height="18" rx="4" /><path d="M12 8v8M8 12h8" /></svg>
);

const SHORTCUT_LABEL = {
  windows: 'Windows shortcut (.url)',
  mac: 'Mac shortcut (.webloc)',
  linux: 'Linux shortcut (.desktop)',
};

// variant 'link' = text link; 'button' = green button (login page, Player Portal).
export default function CreateLink({ variant = 'link' }) {
  const [open, setOpen] = useState(false);
  const [canPrompt, setCanPrompt] = useState(!!deferredPrompt);
  const [installed, setInstalled] = useState(isInstalledApp());
  // Android Chrome only: null = unknown, true/false = the browser's answer.
  const [relatedInstalled, setRelatedInstalled] = useState(null);
  const [dismissed, setDismissed] = useState(readDismissed());
  const [copied, setCopied] = useState('');
  const platform = detectPlatform();
  const iosBrowser = platform === 'ios' ? detectIosBrowser() : null;
  const isDesktop = platform === 'windows' || platform === 'mac' || platform === 'linux';
  const isMobile = platform === 'ios' || platform === 'android';
  const isInstalled = installed || relatedInstalled === true;
  // iPhone/iPad: always offer (an install can't be detected). Android: offer when
  // the browser has an install prompt ready, or confirms the app is not installed.
  const barEligible = platform === 'ios' || (platform === 'android' && (canPrompt || relatedInstalled === false));
  const showBar = isMobile && !isInstalled && !dismissed && barEligible;

  useEffect(() => {
    const update = () => {
      setCanPrompt(!!deferredPrompt);
      setInstalled(isInstalledApp());
    };
    promptListeners.add(update);
    update();
    return () => promptListeners.delete(update);
  }, []);

  useEffect(() => {
    if (platform !== 'android' || typeof navigator.getInstalledRelatedApps !== 'function') return;
    navigator.getInstalledRelatedApps()
      .then((apps) => setRelatedInstalled(Array.isArray(apps) && apps.length > 0))
      .catch(() => {});
  }, [platform]);

  // Keep page content clear of the fixed bar.
  useEffect(() => {
    if (!showBar) return undefined;
    document.body.classList.add('has-install-bar');
    return () => document.body.classList.remove('has-install-bar');
  }, [showBar]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Already running as the installed app - nothing to create.
  if (isInstalled) return null;

  const install = async () => {
    if (!deferredPrompt) return;
    const evt = deferredPrompt;
    deferredPrompt = null; // a prompt event can only be used once
    setCanPrompt(false);
    try {
      await evt.prompt();
      const choice = await evt.userChoice;
      if (choice && choice.outcome === 'accepted') setOpen(false);
    } catch {
      /* the browser refused or the user closed it - the steps below still work */
    }
  };

  const copyLink = async () => {
    const ok = await copyText(`${window.location.origin}/`);
    setCopied(ok ? 'ok' : 'fail');
  };

  const dismiss = () => {
    try { window.localStorage.setItem(DISMISS_KEY, '1'); } catch { /* ignore */ }
    setDismissed(true);
  };
  const onBarTap = () => {
    if (platform === 'android' && deferredPrompt) install();
    else setOpen(true);
  };

  return (
    <>
      {showBar && createPortal(
        <div className="lg-install-bar" role="region" aria-label="Install app">
          <button type="button" className="lg-install-bar-main" onClick={onBarTap}>Install app</button>
          <button type="button" className="lg-install-bar-close" onClick={dismiss} aria-label="Close">&times;</button>
        </div>,
        document.body,
      )}
      {isMobile && variant === 'button' ? null : variant === 'button' ? (
        <button type="button" className="lg-create-btn" onClick={() => setOpen(true)}>Create Link</button>
      ) : (
        <p className="lg-create-link">
          <button type="button" className="lg-link-btn" onClick={() => setOpen(true)}>Create Link</button>
        </p>
      )}
      {open && createPortal(
        <div className="lg-modal-back" onClick={() => setOpen(false)}>
          <div
            className="lg-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="lg-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="lg-modal-title">Add {APP_NAME} to your {isDesktop ? 'desktop' : 'home screen'}</h2>

            {canPrompt && (
              <div className="lg-modal-block">
                <button type="button" className="btn btn-primary lg-modal-btn" onClick={install}>
                  Install app
                </button>
                <p className="lg-modal-note">Your browser will ask you to confirm. The app then opens in its own window with its own icon.</p>
              </div>
            )}

            {platform === 'ios' && iosBrowser !== 'safari' && (
              <div className="lg-modal-warn">
                <strong>Step 1: open this page in Safari.</strong>
                <p>
                  {iosBrowser === 'inapp'
                    ? 'You seem to be in a browser inside another app (Facebook, WhatsApp, email and so on). Those usually cannot add an icon to the home screen.'
                    : 'Safari is the browser that reliably offers \u201cAdd to Home Screen\u201d on iPhone and iPad. Other browsers often do not.'}
                </p>
                <button type="button" className="btn btn-primary lg-modal-btn" onClick={copyLink}>
                  {copied === 'ok' ? 'Link copied' : 'Copy link'}
                </button>
                <code className="lg-modal-url">{`${window.location.origin}/`}</code>
                <p>
                  {copied === 'fail' ? 'Copying did not work here - press and hold the address above to copy it. ' : ''}
                  Open <strong>Safari</strong>, tap its address bar, paste the link and go, then follow the steps below.
                </p>
              </div>
            )}

            {platform === 'ios' && (
              <>
                <ol className="lg-modal-steps lg-modal-steps-ios">
                  <li>
                    Tap the <strong>Share</strong> button <ShareIcon /> (a square with an arrow pointing up).
                    It is in the bar at the bottom of Safari (at the top on an iPad).
                    <span className="lg-modal-note"> On newer iPhones there is no Share button in the bar: tap the three dots <DotsIcon /> next to the address bar, then tap <strong>Share</strong>.</span>
                  </li>
                  <li>
                    Scroll down the list and tap <strong>Add to Home Screen</strong> <PlusSquareIcon />.
                    <span className="lg-modal-note"> If you see <strong>View More</strong>, tap it first.</span>
                  </li>
                  <li>
                    If you see an <strong>Open as Web App</strong> switch, leave it on. Tap <strong>Add</strong>.
                    The icon appears on your home screen.
                  </li>
                </ol>
                <p className="lg-modal-note">
                  <strong>Can&rsquo;t see Add to Home Screen?</strong> Scroll to the very bottom of the Share list, tap <strong>Edit Actions</strong>,
                  then tap the <strong>+</strong> beside Add to Home Screen. Make sure you are in Safari and not inside another app.
                </p>
              </>
            )}

            {platform === 'android' && !canPrompt && (
              <ol className="lg-modal-steps">
                <li>Open this page in <strong>Chrome</strong>.</li>
                <li>Tap the <strong>⋮</strong> menu at the top right.</li>
                <li>Tap <strong>Install app</strong> (or <strong>Add to Home screen</strong>).</li>
                <li>Confirm. The icon appears on your home screen.</li>
              </ol>
            )}

            {isDesktop && !canPrompt && (
              <p className="lg-modal-note">
                To install it as an app, use <strong>Chrome</strong> or <strong>Edge</strong> and look for the install icon in the address bar
                (or the browser menu &rarr; Install). In Safari on a Mac use <strong>File &rarr; Add to Dock</strong>.
              </p>
            )}

            {isDesktop && (
              <div className="lg-modal-block">
                <p className="lg-modal-note"><strong>Or download a shortcut file</strong> that opens {APP_NAME} in your browser:</p>
                <button type="button" className="btn lg-modal-btn" onClick={() => downloadShortcut(platform)}>
                  Download {SHORTCUT_LABEL[platform]}
                </button>
                <p className="lg-modal-note">
                  Other systems:{' '}
                  {['windows', 'mac', 'linux'].filter((k) => k !== platform).map((k, i) => (
                    <span key={k}>
                      {i > 0 && ' · '}
                      <button type="button" className="lg-link-btn" onClick={() => downloadShortcut(k)}>{SHORTCUT_LABEL[k]}</button>
                    </span>
                  ))}
                </p>
                {platform === 'linux' && (
                  <p className="lg-modal-note">On some Linux desktops you need to right-click the file and choose &ldquo;Allow Launching&rdquo; the first time.</p>
                )}
              </div>
            )}

            {platform === 'other' && !canPrompt && (
              <p className="lg-modal-note">Open your browser&rsquo;s menu and look for &ldquo;Install&rdquo; or &ldquo;Add to Home screen&rdquo;.</p>
            )}

            <button type="button" className="btn lg-modal-close" onClick={() => setOpen(false)}>Close</button>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
