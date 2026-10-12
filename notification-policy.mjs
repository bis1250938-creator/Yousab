export function permissionAction(permission, notificationApiAvailable = true) {
  if (!notificationApiAvailable) return 'unsupported';
  if (permission === 'granted') return 'sync';
  if (permission === 'denied') return 'settings-help';
  if (permission === 'default') return 'request';
  return 'unsupported';
}

export function isIosDevice(navigatorLike = globalThis.navigator) {
  const agent = navigatorLike?.userAgent || '';
  return /iPhone|iPad|iPod/i.test(agent)
    || (navigatorLike?.platform === 'MacIntel' && Number(navigatorLike?.maxTouchPoints) > 1);
}

export function isInstalledWebApp(windowLike = globalThis.window, navigatorLike = globalThis.navigator) {
  return Boolean(windowLike?.matchMedia?.('(display-mode: standalone)').matches || navigatorLike?.standalone === true);
}

export function friendlyMessagingError(error) {
  const code = String(error?.code || '');
  if (code === 'notifications/canceled') return 'Registration stopped because notifications were disabled.';
  if (code.includes('unauthenticated')) return 'Your Firebase sign-in expired. Sign in again, then retry.';
  if (code.includes('permission-denied')) return 'This verified Firebase account cannot manage notification subscriptions.';
  if (code.includes('failed-precondition')) return error.message || 'Register this browser before sending a test.';
  if (code.includes('resource-exhausted')) return error.message || 'The notification rate limit was reached. Wait and retry.';
  if (code.includes('unavailable') || code.includes('network')) return 'The notification service could not be reached. Check your connection and try again.';
  if (code.includes('not-found')) return 'Deploy the Firebase notification Functions before using this control.';
  if (code.includes('messaging/')) return 'Firebase Messaging could not register this browser. Check the Web Push certificate and service worker configuration.';
  return error?.message || 'Notification setup failed. Check Firebase configuration and try again.';
}
