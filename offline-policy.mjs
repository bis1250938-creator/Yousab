export const OFFLINE_CACHE_PREFERENCE = 'yj-studios-offline-cache';
export const LAST_SERVER_SYNC_KEY = 'yj-studios-last-server-sync';

export function persistentCacheWasChosen(storage) {
  try { return storage?.getItem(OFFLINE_CACHE_PREFERENCE) === 'trusted-device'; }
  catch { return false; }
}

export function setPersistentCacheChoice(storage, enabled) {
  try {
    if (!storage || typeof storage.setItem !== 'function' || typeof storage.removeItem !== 'function') return false;
    if (enabled) storage?.setItem(OFFLINE_CACHE_PREFERENCE, 'trusted-device');
    else storage?.removeItem(OFFLINE_CACHE_PREFERENCE);
    return true;
  } catch { return false; }
}

export function projectRevisionAfterEdit(revision) {
  const current = Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
  if (current >= Number.MAX_SAFE_INTEGER) throw new RangeError('Project revision is outside the supported range.');
  return current + 1;
}

export function publicPortfolioEmptyMessage({ fromCache, size }) {
  if (fromCache) return size > 0
    ? 'Previously synchronized projects are shown. Connect to confirm the latest portfolio.'
    : 'No previously synchronized public projects are available offline. Connect to load Studio Work.';
  return size > 0
    ? 'Published records were synchronized, but none contain supported media details.'
    : 'No published studio work yet.';
}

export function offlineProjectWriteFailure({ offline, persistent, usesFiles = false }) {
  if (!offline) return '';
  if (usesFiles) return 'Media file uploads, R2 visibility changes, and file cleanup require an internet connection. Your selected local files have not been uploaded.';
  if (!persistent) return 'Offline project changes are disabled because durable Firestore storage is off. Enable it on a trusted personal device or reconnect; no change was saved.';
  return '';
}

export function canUseCachedOwnerToken(tokenResult, now = Date.now()) {
  const expiry = Date.parse(tokenResult?.expirationTime || '');
  return Number.isFinite(expiry) && expiry > now;
}

export function isTransientAuthNetworkFailure(error) {
  return ['auth/network-request-failed', 'unavailable'].includes(String(error?.code || ''))
    || error?.name === 'TypeError';
}
