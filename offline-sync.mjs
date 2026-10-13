import {
  LAST_SERVER_SYNC_KEY,
  setPersistentCacheChoice
} from './offline-policy.mjs';
import {
  countRejectedProjectWrites, markRejectedProjectWrite,
  removeRejectedProjectWrite, saveRejectedProjectWrite
} from './offline-recovery.mjs';

const connectionState = document.getElementById('offline-connection-state');
const details = document.getElementById('offline-sync-details');
const retryButton = document.getElementById('offline-sync-retry');
const settingsButton = document.getElementById('offline-storage-settings');
const settingsDialog = document.getElementById('offline-storage-dialog');
const settingsMessage = document.getElementById('offline-storage-message');
const enableButton = document.getElementById('offline-storage-enable');
const disableButton = document.getElementById('offline-storage-disable');
const closeButton = document.getElementById('offline-storage-close');
const recoveryActions = document.getElementById('offline-recovery-actions');
const recoveryDownloadButton = document.getElementById('offline-recovery-download');
const recoveryDiscardButton = document.getElementById('offline-recovery-discard');

let database = null;
let cacheMode = 'memory';
let retryHandler = null;
let recoveryHandler = null;
let recoveryReviewHandler = null;
let recoveryDiscardHandler = null;
let retrying = false;
let serverState = 'unknown';
let lastServerSync = '';
let latestFailure = '';
let recoverableCount = null;
const sources = new Map();
const pendingOperations = new Map();

try { lastServerSync = localStorage.getItem(LAST_SERVER_SYNC_KEY) || ''; } catch { /* Storage can be disabled. */ }

function saveServerSync() {
  lastServerSync = new Date().toISOString();
  try { localStorage.setItem(LAST_SERVER_SYNC_KEY, lastServerSync); } catch { /* Status remains available in this page. */ }
}

function visiblePendingCount() {
  const labels = new Set([...pendingOperations.keys()].map((key) => {
    if (key.startsWith('project:')) return `record:${key.slice('project:'.length)}`;
    if (key.startsWith('project-delete:')) return `record:${key.slice('project-delete:'.length)}`;
    return key;
  }));
  for (const [source, state] of sources) {
    for (const id of state.pendingIds) labels.add(`record:${id}`);
    if (state.hasPendingWrites && !state.pendingIds.size) labels.add(`source:${source}`);
  }
  return labels.size;
}

function renderStatus() {
  if (!connectionState || !details) return;
  const online = navigator.onLine !== false;
  connectionState.textContent = online
    ? (serverState === 'confirmed' ? 'Online · Firestore confirmed' : 'Online · checking Firebase')
    : 'Offline · using this device’s saved state';
  const pending = visiblePendingCount();
  const parts = [cacheMode === 'persistent'
    ? 'Persistent Firestore storage is enabled on this device.'
    : 'Persistent Firestore storage is off; offline changes may be lost if you close this page.'];
  if (pending) parts.push(`${pending} visible write${pending === 1 ? '' : 's'} waiting for confirmation. Firebase does not expose an exact restored queue count.`);
  if (recoverableCount) parts.push(`${recoverableCount} project change or media-cleanup action${recoverableCount === 1 ? ' is' : 's are'} saved locally for owner retry or review.`);
  else if (recoverableCount === null) parts.push('Checking locally saved project recovery data…');
  if (serverState === 'cached') parts.push('Showing previously synchronized data; it may be out of date.');
  if (lastServerSync) parts.push(`Last server-confirmed sync: ${new Date(lastServerSync).toLocaleString()}.`);
  if (latestFailure) parts.push(latestFailure);
  if (!online) parts.push('Sign-in, media upload/playback, push notifications, WhatsApp, and external links need internet access.');
  details.textContent = parts.join(' ');
  retryButton.disabled = retrying;
  retryButton.textContent = retrying ? 'Checking…' : 'Retry sync';
  enableButton.hidden = cacheMode === 'persistent';
  disableButton.hidden = cacheMode !== 'persistent';
  disableButton.disabled = disableButton.hidden ? false : (retrying || pending > 0 || recoverableCount === null || recoverableCount > 0);
  recoveryActions.hidden = !recoverableCount || !recoveryReviewHandler || !recoveryDiscardHandler;
}

async function refreshRecoverableCount() {
  try { recoverableCount = await countRejectedProjectWrites(); }
  catch { recoverableCount = null; }
  renderStatus();
}

function reportServerConfirmed() {
  saveServerSync();
  serverState = 'confirmed';
  renderStatus();
}

export function configureOfflineSync({ db, persistent = false, enableNetwork, waitForPendingWrites }) {
  database = db;
  cacheMode = persistent ? 'persistent' : 'memory';
  if (enableNetwork && waitForPendingWrites) {
    retryHandler = async () => {
      await enableNetwork(database);
      await waitWithTimeout(waitForPendingWrites(database), 15000);
    };
  }
  if (persistent && waitForPendingWrites) {
    waitForPendingWrites(db).catch((error) => {
      latestFailure = `A restored Firestore write was rejected (${error?.code || 'unknown'}). Check authorization/rules and reapply the change from the latest server version.`;
      serverState = 'unknown';
      renderStatus();
    });
  }
  refreshRecoverableCount();
  renderStatus();
}

function waitWithTimeout(promise, timeoutMs) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Still waiting for Firebase to confirm pending writes.')), timeoutMs); })
  ]).finally(() => clearTimeout(timer));
}

export function setOfflineRetryHandler(handler) { retryHandler = handler; }

export function setOfflineRecoveryHandler(handler) { recoveryHandler = handler; }

export function setOfflineRecoveryReviewHandlers({ download, discard } = {}) {
  recoveryReviewHandler = download || null;
  recoveryDiscardHandler = discard || null;
  renderStatus();
}

export function observeFirestoreSnapshot(name, snapshot) {
  const pendingIds = new Set(snapshot.docs.filter((entry) => entry.metadata?.hasPendingWrites).map((entry) => entry.id));
  sources.set(name, { pendingIds, hasPendingWrites: Boolean(snapshot.metadata?.hasPendingWrites) });
  if (snapshot.metadata?.fromCache) serverState = 'cached';
  else if (!snapshot.metadata?.hasPendingWrites) reportServerConfirmed();
  renderStatus();
}

export function trackFirestoreWrite(key, promise) {
  const label = String(key);
  pendingOperations.set(label, true);
  latestFailure = '';
  renderStatus();
  const tracked = Promise.resolve(promise).then((value) => {
    pendingOperations.delete(label);
    reportServerConfirmed();
    return value;
  }, (error) => {
    pendingOperations.delete(label);
    latestFailure = `A change was rejected by Firebase (${error?.code || 'unknown'}). Review access, rules, and any newer server version, then reapply the change.`;
    serverState = 'unknown';
    renderStatus();
    throw error;
  });
  // Attach a handler immediately so a caller that leaves an offline write pending
  // does not create an unhandled rejection. Callers can still await `tracked`.
  tracked.catch(() => {});
  return tracked;
}

export async function enqueueFirestoreWrite(key, writeFactory, recovery = null) {
  let recoveryId = '';
  if (recovery && cacheMode === 'persistent') {
    recoveryId = crypto.randomUUID();
    try {
      await saveRejectedProjectWrite({ ...recovery, id: recoveryId, createdAt: Date.now() });
      await refreshRecoverableCount();
    } catch (error) {
      recoveryId = '';
      if (navigator.onLine === false) throw new Error(`Offline recovery storage failed, so this change was not sent: ${error.message}`);
      latestFailure = `This project change has no local recovery copy (${error?.message || 'IndexedDB unavailable'}).`;
      renderStatus();
    }
  }

  let write;
  try { write = writeFactory(); }
  catch (error) {
    if (recoveryId) await markRejectedProjectWrite(recoveryId, error?.message || 'Could not queue this write.').catch(() => {});
    throw error;
  }

  let tracked = trackFirestoreWrite(key, write);
  if (recoveryId) {
    tracked = tracked.then(async (value) => {
      await removeRejectedProjectWrite(recoveryId).catch(() => {});
      await refreshRecoverableCount();
      return value;
    }, async (error) => {
      await markRejectedProjectWrite(recoveryId, `${error?.code || 'unknown'}: ${error?.message || 'Firebase rejected this project change.'}`).catch(() => {});
      await refreshRecoverableCount();
      throw error;
    });
    tracked.catch(() => {});
  }
  return { promise: tracked, recoveryId };
}

export function persistentOfflineStorageEnabled() { return cacheMode === 'persistent'; }

export function isActuallyOfflineHint() { return navigator.onLine === false; }

export async function flushBeforeOwnerSignOut() {
  if (navigator.onLine === false) {
    if (visiblePendingCount()) throw new Error('Reconnect and synchronize visible pending changes before signing out. Firestore may need the current account to authorize its queued writes.');
    return;
  }
  if (!retryHandler) throw new Error('Firestore is not ready to verify pending changes. Keep this account signed in and retry.');
  await waitWithTimeout(retryHandler(), 15000);
  const remaining = visiblePendingCount();
  if (remaining) throw new Error(`${remaining} visible write(s) still need server confirmation. Keep this account signed in and retry sync.`);
}

window.YJOffline = {
  configureOfflineSync,
  observeFirestoreSnapshot,
  trackFirestoreWrite,
  persistentOfflineStorageEnabled,
  isActuallyOfflineHint,
  pendingWriteCount: visiblePendingCount,
  flushBeforeOwnerSignOut,
  setRetryHandler: setOfflineRetryHandler,
  setRecoveryHandler: setOfflineRecoveryHandler,
  setRecoveryReviewHandlers: setOfflineRecoveryReviewHandlers,
  refreshRecoveryCount: refreshRecoverableCount,
  async retrySavedProjectChanges() { if (recoveryHandler) await recoveryHandler(); await refreshRecoverableCount(); },
  confirmServerSync: reportServerConfirmed,
  setFailure(message) { latestFailure = String(message || ''); renderStatus(); },
  noteCachedData() { serverState = 'cached'; renderStatus(); }
};

window.addEventListener('online', () => {
  serverState = 'unknown';
  renderStatus();
});
window.addEventListener('offline', renderStatus);
retryButton?.addEventListener('click', async () => {
  if (navigator.onLine === false) {
    latestFailure = 'This device reports no connection. Firebase will continue retrying when connectivity returns.';
    renderStatus();
    return;
  }
  if (!retryHandler) {
    latestFailure = 'Firebase has not finished initializing; retry after the site connects.';
    renderStatus();
    return;
  }
  retrying = true;
  latestFailure = '';
  renderStatus();
  try {
    let initialError = null;
    try { await waitWithTimeout(retryHandler(), 15000); } catch (error) { initialError = error; }
    if (recoveryHandler) {
      await recoveryHandler();
      await refreshRecoverableCount();
      if (recoverableCount === null) throw new Error('Local recovery data could not be checked; keep persistent storage enabled and retry later.');
      if (recoverableCount) throw new Error(`${recoverableCount} saved project change(s) need conflict review or an owner session before retry can continue.`);
      await waitWithTimeout(retryHandler(), 15000);
    } else if (initialError) throw initialError;
    reportServerConfirmed();
  } catch (error) {
    latestFailure = `${error?.message || 'Firebase could not confirm synchronization.'} Pending offline writes remain under Firestore control.`;
    serverState = 'unknown';
  } finally {
    retrying = false;
    renderStatus();
  }
});

settingsButton?.addEventListener('click', () => {
  settingsMessage.textContent = cacheMode === 'persistent'
    ? 'Persistent mode is active for this browser session.'
    : 'This browser is currently using temporary memory cache.';
  if (!settingsDialog.open) settingsDialog.showModal();
});
closeButton?.addEventListener('click', () => settingsDialog.close());
settingsDialog?.addEventListener('click', (event) => { if (event.target === settingsDialog) settingsDialog.close(); });
recoveryDownloadButton?.addEventListener('click', async () => {
  if (!recoveryReviewHandler) { settingsMessage.textContent = 'Sign in with the authorized owner account to review saved project changes.'; return; }
  try { await recoveryReviewHandler(); settingsMessage.textContent = 'A review copy of saved project and media-cleanup details was downloaded.'; }
  catch (error) { settingsMessage.textContent = error?.message || 'Could not download recovery details.'; }
});
recoveryDiscardButton?.addEventListener('click', async () => {
  if (!recoveryDiscardHandler) { settingsMessage.textContent = 'Sign in with the authorized owner account to manage saved project changes.'; return; }
  try {
    const discarded = await recoveryDiscardHandler();
    if (discarded) {
      await refreshRecoverableCount();
      settingsMessage.textContent = 'The selected saved recovery records were discarded.';
    }
  } catch (error) { settingsMessage.textContent = error?.message || 'Could not discard saved changes.'; }
});

enableButton?.addEventListener('click', async () => {
  enableButton.disabled = true;
  let browserPersistence = null;
  try { browserPersistence = await navigator.storage?.persist?.(); } catch { /* Persistent storage permission is optional. */ }
  let storage;
  try { storage = globalThis.localStorage; } catch { storage = null; }
  if (!setPersistentCacheChoice(storage, true)) {
    settingsMessage.textContent = 'Browser storage is unavailable. Allow site storage, then try again.';
    enableButton.disabled = false;
    return;
  }
  settingsMessage.textContent = browserPersistence === false
    ? 'The browser did not guarantee storage against eviction. Firestore IndexedDB will be enabled, but the browser or operating system may still clear it. Reloading…'
    : 'Enabling persistent Firestore storage. The browser may still evict site data under storage pressure. Reloading…';
  setTimeout(() => location.reload(), 900);
});

disableButton?.addEventListener('click', async () => {
  if (navigator.onLine === false || !database || !retryHandler) {
    settingsMessage.textContent = 'Reconnect and sync first so pending changes are not stranded in this browser cache.';
    return;
  }
  disableButton.disabled = true;
  settingsMessage.textContent = 'Checking that Firebase has acknowledged pending writes…';
  try {
    await waitWithTimeout(retryHandler(), 15000);
    if (visiblePendingCount()) throw new Error('Visible pending writes still remain.');
    await refreshRecoverableCount();
    if (recoverableCount === null) throw new Error('Local recovery data could not be checked; keep persistent storage enabled.');
    if (recoverableCount) throw new Error('Saved rejected project changes still need retry or conflict review.');
    let storage;
    try { storage = globalThis.localStorage; } catch { storage = null; }
    if (!setPersistentCacheChoice(storage, false)) throw new Error('Browser storage could not update the offline setting.');
    settingsMessage.textContent = 'Persistent storage will be off after reload. Existing IndexedDB data remains in the browser until its site data is cleared.';
    location.reload();
  } catch (error) {
    settingsMessage.textContent = `${error?.message || 'Firebase has not confirmed all writes.'} Keep persistent storage enabled and retry later.`;
  } finally { disableButton.disabled = false; }
});

renderStatus();
