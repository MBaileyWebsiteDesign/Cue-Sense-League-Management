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
//    step-by-step instructions are shown instead.
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
  const platform = detectPlatform();
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

            {platform === 'ios' && (
              <ol className="lg-modal-steps">
                <li>Open this page in <strong>Safari</strong>.</li>
                <li>Tap the <strong>Share</strong> button (the square with an arrow pointing up).</li>
                <li>Scroll down and tap <strong>Add to Home Screen</strong>.</li>
                <li>Tap <strong>Add</strong>. The icon appears on your home screen.</li>
              </ol>
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
