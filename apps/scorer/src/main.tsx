import { effect } from '@preact/signals';
import { render } from 'preact';
import { App } from './app';
import './index.css';
import { info, onKey, tapToRender } from './session';

render(<App />, document.getElementById('app')!);
window.addEventListener('keydown', onKey);

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
Object.assign(window, { __scorer: { tapToRender } });
