// Shared Google sign-in vs sign-up decisions for the static Firebase site.
// Firebase Auth validates its own OAuth state and reports isNewUser in the
// credential result. Google providerData.uid is the stable provider identity.
export const AUTH_INTENT_KEY = 'yj-auth-intent';

export function normalizeAuthIntent(value) {
  return value === 'signup' || value === 'signin' ? value : 'signin';
}

export function saveAuthIntent(storage, intent) {
  if (intent !== 'signup' && intent !== 'signin') return false;
  try {
    storage.setItem(AUTH_INTENT_KEY, intent);
    return true;
  } catch {
    return false;
  }
}

export function consumeAuthIntent(storage) {
  try {
    const value = storage.getItem(AUTH_INTENT_KEY);
    storage.removeItem(AUTH_INTENT_KEY);
    return value === 'signup' || value === 'signin' ? value : null;
  } catch {
    return null;
  }
}

export function canUseOwnerDashboard(user, tokenResult) {
  const claims = tokenResult?.claims;
  const googleSignIn = claims?.firebase?.sign_in_provider === 'google.com'
    && user?.providerData?.some((profile) => profile.providerId === 'google.com' && typeof profile.uid === 'string' && profile.uid.length > 0);
  return Boolean(user
    && claims?.owner === true
    && claims.email_verified === true
    && googleSignIn);
}

export async function verifyOwnerSession(user, getIdTokenResult) {
  const tokenResult = await getIdTokenResult(user, true);
  return { authorized: canUseOwnerDashboard(user, tokenResult), tokenResult };
}

// The verified custom claim is the only signal that routes an account into the
// private studio workspace. Every other authenticated Google user gets the
// ordinary account page.
export function getAuthenticatedDestination(user, tokenResult) {
  return canUseOwnerDashboard(user, tokenResult) ? 'dashboard.html' : 'account.html';
}

export function googleAuthErrorMessage(error, { hostname }) {
  switch (error?.code) {
    case 'auth/unauthorized-domain': return `This website is not authorized for sign-in. Add ${hostname} under Firebase Authentication → Settings → Authorized domains.`;
    case 'auth/operation-not-allowed': return 'Google sign-in is disabled. Enable Google under Firebase Authentication → Sign-in method.';
    case 'auth/invalid-api-key': return 'Firebase rejected the Web API key. Check the apiKey in firebase-config.js against the Firebase Web app config.';
    case 'auth/network-request-failed': return 'Google sign-in could not reach Firebase. Check the internet connection and try again.';
    case 'auth/web-storage-unsupported': return 'This browser is blocking the storage Google sign-in needs. Try a standard browser window with site storage enabled.';
    case 'auth/unsupported-persistence-type': return 'This browser cannot provide the persistent session storage required by YJ Studios. Try a standard browser with IndexedDB enabled.';
    case 'auth/popup-blocked': return 'The browser blocked the Google sign-in popup. Allow popups for this website and try again.';
    case 'auth/popup-closed-by-user': return 'The Google sign-in window was closed before sign-in finished. Try again when ready.';
    case 'auth/cancelled-popup-request': return 'Another Google sign-in request replaced this one. Use the latest sign-in window.';
    case 'auth/invalid-state': return 'Google sign-in could not validate this redirect. Start again from the sign-in page.';
    case 'auth/account-exists-with-different-credential': return 'This email already uses another sign-in method. Sign in with that method before linking Google; no accounts were merged.';
    case 'auth/credential-already-in-use': return 'This Google account is already linked to another profile. Sign in to that profile; no duplicate account was created.';
    case 'auth/user-disabled': return 'This account is disabled. Contact the studio administrator.';
    case 'auth/too-many-requests': return 'Google sign-in was temporarily limited. Wait a moment, then try again.';
    default: return error?.message || 'Google sign-in failed. Check the Firebase setup and try again.';
  }
}

async function rejectCredential({ user, isNewUser, auth, api, status }) {
  let cleanupFailed = false;
  if (isNewUser && user) {
    try { await api.deleteUser(user); }
    catch { cleanupFailed = true; }
  }
  try { await api.signOut(auth); }
  catch { cleanupFailed = true; }
  return { status: cleanupFailed ? 'cleanup-failed' : status, cleanupFailed };
}

export async function resolveGoogleAuthResult({ result, intent, auth, api }) {
  const action = normalizeAuthIntent(intent);
  const user = result?.user || null;
  const additionalInfo = result && api.getAdditionalUserInfo(result);
  const isNewUser = additionalInfo?.isNewUser;
  const googleIdentity = user?.providerData?.find((profile) => profile.providerId === 'google.com' && typeof profile.uid === 'string' && profile.uid.length > 0);

  if (!user || typeof isNewUser !== 'boolean' || !googleIdentity || user.emailVerified !== true) {
    return rejectCredential({ user, isNewUser: isNewUser === true, auth, api, status: 'invalid-credential' });
  }

  if (action === 'signin' && isNewUser) {
    return rejectCredential({ user, isNewUser: true, auth, api, status: 'not-registered' });
  }

  if (action === 'signup' && !isNewUser) {
    return rejectCredential({ user, isNewUser: false, auth, api, status: 'already-registered' });
  }

  return { status: 'authenticated', user, googleSub: googleIdentity.uid, intent: action };
}
