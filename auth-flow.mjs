// App-level Google sign-in vs sign-up decisions for the static Firebase site.
// Firebase Auth validates its own OAuth state and reports isNewUser in the
// credential result. Google providerData.uid is the stable provider identity.
export const AUTH_INTENT_KEY = 'yj-owner-auth-intent';

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

export function studioProjectAccessFailure(user, tokenResult, projectId) {
  if (!user) return 'No Firebase account is signed in.';
  const claims = tokenResult?.claims;
  if (!claims) return 'Firebase did not return an ID token. Sign out, sign in again, and retry.';
  if (projectId && (claims.aud !== projectId || claims.iss !== `https://securetoken.google.com/${projectId}`)) {
    return 'This account is signed into a different Firebase project than this website. Check firebase-config.js and the deployed site configuration.';
  }
  if (user.emailVerified !== true || claims.email_verified !== true) {
    return 'The signed-in Firebase account does not have a verified email. Verify that account in Firebase Authentication, then sign out and back in.';
  }
  if (claims.owner !== true) {
    return `Firebase signed in UID ${user.uid}, but that UID has no trusted owner claim. From a trusted machine, run in admin-tools: node set-owner-role.mjs grant ${user.uid} ${user.uid} — then sign out and back in.`;
  }
  const provider = claims?.firebase?.sign_in_provider;
  if (!['google.com', 'password'].includes(provider)) {
    return 'This Firebase account used an unsupported sign-in provider. Use the owner account’s Google or Email/Password sign-in method.';
  }
  if (!user.providerData?.some((profile) => profile.providerId === provider && typeof profile.uid === 'string' && profile.uid.length > 0)) {
    return `The Firebase token says ${provider} sign-in, but that provider is not linked to this Firebase UID. Check Authentication → Users and use the existing owner account.`;
  }
  return '';
}

export function hasStudioProjectAccess(user, tokenResult, projectId) {
  return studioProjectAccessFailure(user, tokenResult, projectId) === '';
}

export async function verifyStudioProjectSession(user, getIdTokenResult, projectId) {
  const tokenResult = await getIdTokenResult(user, true);
  return { authorized: hasStudioProjectAccess(user, tokenResult, projectId), tokenResult, failure: studioProjectAccessFailure(user, tokenResult, projectId) };
}

export function googleAuthErrorMessage(error, { hostname }) {
  switch (error?.code) {
    case 'auth/unauthorized-domain': return `This website is not authorized for sign-in. Add ${hostname} under Firebase Authentication → Settings → Authorized domains.`;
    case 'auth/operation-not-allowed': return 'Google sign-in is disabled. Enable Google under Firebase Authentication → Sign-in method.';
    case 'auth/invalid-api-key': return 'Firebase rejected the Web API key. Check the apiKey in firebase-config.js against the Firebase Web app config.';
    case 'auth/network-request-failed': return 'Google sign-in could not reach Firebase. Check the internet connection and try again.';
    case 'auth/web-storage-unsupported': return 'This browser is blocking the storage Google sign-in needs. Try a standard browser window with site storage enabled.';
    case 'auth/unsupported-persistence-type': return 'This browser cannot provide the secure persistent session storage required for owner sign-in. Try a standard browser with IndexedDB enabled.';
    case 'auth/popup-blocked': return 'The browser blocked the Google sign-in popup. Allow popups for this website and try again.';
    case 'auth/popup-closed-by-user': return 'The Google sign-in window was closed before sign-in finished. Try again when ready.';
    case 'auth/cancelled-popup-request': return 'Another Google sign-in request replaced this one. Use the latest sign-in window.';
    case 'auth/invalid-state': return 'Google sign-in could not validate this redirect. Start again from the owner sign-in page.';
    case 'auth/account-exists-with-different-credential': return 'This email already uses another sign-in method. Sign in with that method before linking Google; no accounts were merged.';
    case 'auth/credential-already-in-use': return 'This Google account is already linked to another profile. Sign in to that profile; no duplicate account was created.';
    case 'auth/user-disabled': return 'This Firebase account is disabled. Contact the studio administrator.';
    case 'auth/too-many-requests': return 'Google sign-in was temporarily limited. Wait a moment, then try again.';
    default: return error?.message || 'Google sign-in failed. Check the Firebase setup and try again.';
  }
}

export function passwordAuthErrorMessage(error) {
  switch (error?.code) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found': return 'Email or password is incorrect.';
    case 'auth/invalid-email': return 'Enter a valid email address.';
    case 'auth/operation-not-allowed': return 'Email/Password sign-in is disabled in Firebase Authentication.';
    case 'auth/too-many-requests': return 'Sign-in is temporarily limited. Wait a moment and try again.';
    case 'auth/user-disabled': return 'This Firebase account is disabled. Contact the studio administrator.';
    case 'auth/network-request-failed': return 'Firebase could not be reached. Check your internet connection.';
    default: return error?.message || 'Email and password sign-in failed.';
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

