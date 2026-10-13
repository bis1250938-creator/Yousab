import { r2WorkerUrl } from './firebase-config.js';
import { contentTypeForMedia } from './media-storage.js';

const RETRY_LIMIT = 4;

function uploadError(message, code, status = 0, retryable = false) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.retryable = retryable;
  return error;
}

export function normalizeR2WorkerUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname.toLowerCase().includes('set-your')) throw new Error('Invalid R2 Worker URL.');
  return url.href.replace(/\/$/, '');
}

function apiBase() {
  try {
    return normalizeR2WorkerUrl(r2WorkerUrl);
  } catch {
    throw uploadError(
      'Media uploads are not configured yet. Deploy the Cloudflare R2 Worker, then put its HTTPS URL in firebase-config.js.',
      'r2/not-configured'
    );
  }
}

function sessionKey(file) {
  return sessionKeyFromDescriptor(file);
}

function sessionKeyFromDescriptor(file) {
  return `yj-r2:${file.name}:${file.size}:${file.lastModified}`;
}

function getSession(file) {
  try { return JSON.parse(localStorage.getItem(sessionKey(file)) || 'null'); }
  catch { return null; }
}

function saveSession(file, session) {
  // Resuming after a reload is best-effort; storage-disabled browsers can still upload.
  try { localStorage.setItem(sessionKey(file), JSON.stringify(session)); }
  catch { /* Continue without cross-reload resume support. */ }
}

export function getResumeProjectId(file) {
  return file ? getSession(file)?.projectId || '' : '';
}

export function forgetR2Session(file) {
  if (!file) return;
  try { localStorage.removeItem(sessionKey(file)); }
  catch { /* Storage can be disabled by the browser. */ }
}

export function forgetR2SessionDescriptor(descriptor) {
  if (!descriptor?.name || !Number.isFinite(descriptor.size) || !Number.isFinite(descriptor.lastModified)) return;
  try { localStorage.removeItem(sessionKeyFromDescriptor(descriptor)); }
  catch { /* Storage can be disabled by the browser. */ }
}

function errorCodeForStatus(status) {
  if (status === 401) return 'r2/unauthenticated';
  if (status === 403) return 'r2/forbidden';
  if (status === 404) return 'r2/not-found';
  if (status === 429) return 'r2/quota';
  if (status >= 500) return 'r2/server';
  return 'r2/request-failed';
}

async function request(path, token, { method = 'GET', body, signal } = {}, auth) {
  const url = `${apiBase()}${path}`;
  const options = { method, headers: { Authorization: `Bearer ${token}` }, signal };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  let response;
  try { response = await fetch(url, options); }
  catch (cause) {
    throw uploadError(
      'Could not reach the media upload service. Check the Worker URL, deployment, HTTPS, and that the site origin is in the Worker ALLOWED_ORIGINS.',
      'r2/unreachable', 0, true
    );
  }

  // Long uploads can outlive the cached Firebase ID token. Refresh once on 401.
  if (response.status === 401 && auth?.currentUser) {
    options.headers.Authorization = `Bearer ${await auth.currentUser.getIdToken(true)}`;
    try { response = await fetch(url, options); }
    catch {
      throw uploadError('Could not reach the media upload service after refreshing sign-in. Check the Worker URL and allowed origin.', 'r2/unreachable', 0, true);
    }
  }

  let data = {};
  try { data = await response.json(); } catch { /* Preserve status-based error guidance. */ }
  if (!response.ok) {
    const status = response.status;
    throw uploadError(
      data.error || `Media service request failed (${status}).`,
      errorCodeForStatus(status),
      status,
      status >= 500
    );
  }
  return data;
}

function sendPart(path, token, blob, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `${apiBase()}${path}`);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded, event.total);
    };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* Use an actionable fallback below. */ }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(data);
      reject(uploadError(
        data.error || `Media chunk request failed (${xhr.status}).`,
        errorCodeForStatus(xhr.status),
        xhr.status,
        xhr.status >= 500
      ));
    };
    xhr.onerror = () => reject(uploadError(
      'The browser could not reach the upload Worker. Check its deployment, HTTPS URL, and ALLOWED_ORIGINS for this website.',
      'r2/unreachable', 0, true
    ));
    xhr.onabort = () => reject(new DOMException('Upload canceled.', 'AbortError'));
    signal.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(blob);
  });
}

export async function uploadR2({ file, kind, projectId, prefix = 'media', auth, onProgress, onTask }) {
  apiBase();
  let token = await auth.currentUser.getIdToken();
  const contentType = contentTypeForMedia(file, kind);
  const controller = new AbortController();
  let session = getSession(file);
  onTask?.({ cancel: () => controller.abort() });

  if (!session) {
    session = {
      clientId: crypto.randomUUID(), projectId, prefix, name: file.name, size: file.size,
      lastModified: file.lastModified, contentType
    };
  } else if (session.contentType !== contentType) {
    // Normalize old sessions created when the browser MIME alias was sent as-is.
    session.contentType = contentType;
    saveSession(file, session);
  }
  if (session.projectId !== projectId) {
    throw new Error('This file has an interrupted upload for another project. Finish or cancel that project before reusing this file.');
  }

  try {
    saveSession(file, session);
    let started = await request('/api/multipart/start', token, {
      method: 'POST', body: {
        clientId: session.clientId, projectId, prefix: session.prefix || prefix,
        name: file.name, size: file.size, contentType: session.contentType
      }
    }, auth);

    if (['aborted', 'deleted'].includes(started.state)) {
      session.clientId = crypto.randomUUID();
      saveSession(file, session);
      token = await auth.currentUser.getIdToken();
      started = await request('/api/multipart/start', token, {
        method: 'POST', body: {
          clientId: session.clientId, projectId, prefix: session.prefix || prefix,
          name: file.name, size: file.size, contentType: session.contentType
        }
      }, auth);
    }
    if (started.state === 'complete') return { url: started.url, key: started.key };

    const completed = new Map((started.parts || []).map((part) => [part.part_number, part]));
    const partCount = Math.ceil(file.size / started.partSize);
    for (let number = 1; number <= partCount; number++) {
      if (controller.signal.aborted) throw new DOMException('Upload canceled.', 'AbortError');
      if (completed.has(number)) {
        const sentBytes = [...completed.values()].reduce((sum, part) => sum + part.bytes, 0);
        onProgress?.(Math.min(100, Math.round(sentBytes / file.size * 100)));
        continue;
      }

      const start = (number - 1) * started.partSize;
      const part = file.slice(start, Math.min(file.size, start + started.partSize));
      let attempt = 0;
      let authRefreshes = 0;
      while (true) {
        try {
          await sendPart(`/api/multipart/${session.clientId}/part/${number}`, token, part, (loaded) => {
            const done = [...completed.values()].reduce((sum, item) => sum + item.bytes, 0);
            onProgress?.(Math.min(99, Math.round((done + loaded) / file.size * 100)));
          }, controller.signal);
          completed.set(number, { bytes: part.size });
          break;
        } catch (error) {
          if (error.name === 'AbortError') throw error;
          if (error.status === 401 && authRefreshes < 1 && auth.currentUser) {
            token = await auth.currentUser.getIdToken(true);
            authRefreshes++;
            continue;
          }
          if (!error.retryable || ++attempt > RETRY_LIMIT) throw error;
          await new Promise((resolve) => setTimeout(resolve, Math.min(8000, 500 * 2 ** attempt)));
        }
      }
    }

    token = await auth.currentUser.getIdToken();
    const result = await request(`/api/multipart/${session.clientId}`, token, { method: 'POST' }, auth);
    onProgress?.(100);
    return { url: result.url, key: result.key };
  } catch (error) {
    if (error.name === 'AbortError') {
      request(`/api/multipart/${session.clientId}`, token, { method: 'DELETE' }, auth).catch(() => {});
      forgetR2Session(file);
    }
    // Keep the resume record for retryable failures so the next submit can
    // continue from completed multipart chunks instead of starting over.
    throw error;
  }
}

export async function deleteR2Objects(keys, auth) {
  if (!keys?.length) return;
  const token = await auth.currentUser.getIdToken();
  return request('/api/objects', token, { method: 'DELETE', body: { keys } }, auth);
}

export async function setR2Visibility(keys, published, auth) {
  if (!keys?.length) return;
  const token = await auth.currentUser.getIdToken();
  return request('/api/objects/visibility', token, { method: 'POST', body: { keys, published } }, auth);
}
