import { effect } from '@preact/signals';
import { render } from 'preact';
import { App } from './app';
import '@fontsource-variable/figtree';
import '@fontsource/barlow-condensed/latin-700.css';
import '@fontsource/barlow-condensed/latin-800.css';
import './index.css';
import { flushLatency, info, onKey, peerLatency, tapToRender } from './session';

const admin = location.pathname.startsWith('/admin');
// Admin screens load only on /admin, so scorers never download them.
if (admin) void import('./admin/app').then(({ Admin }) => render(<Admin />, document.getElementById('app')!));
else render(<App />, document.getElementById('app')!);
if (!admin) window.addEventListener('keydown', onKey);

if ('serviceWorker' in navigator && import.meta.env.PROD) void navigator.serviceWorker.register('/sw.js');

// Keep the screen on while a game is open. The browser drops the lock when the tab is hidden.
let lock: WakeLockSentinel | null = null;
const wake = async () => {
  if (info.value && document.visibilityState === 'visible' && !lock) {
    lock = await navigator.wakeLock?.request('screen').catch(() => null);
    lock?.addEventListener('release', () => (lock = null));
  }
};
effect(() => void (info.value && wake()));
document.addEventListener('visibilitychange', () => void wake());

// For e2e latency assertions.
Object.assign(window, { __scorer: { tapToRender, peerLatency, flushLatency } });
