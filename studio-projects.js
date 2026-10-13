import { app, auth, db } from './firebase-client.js';
import { firebaseConfig } from './firebase-config.js';
import { studioProjectAccessFailure, verifyStudioProjectSessionWithCachedToken } from './auth-flow.mjs';
import { contentTypeForMedia, MAX_COVER_BYTES, MAX_MEDIA_BYTES, validateMediaFile } from './media-storage.js';
import { uploadR2, deleteR2Objects, setR2Visibility, getResumeProjectId, forgetR2Session, forgetR2SessionDescriptor } from './r2-uploader.js';
import { enqueueFirestoreWrite, isActuallyOfflineHint, observeFirestoreSnapshot, persistentOfflineStorageEnabled } from './offline-sync.mjs';
import { offlineProjectWriteFailure, projectRevisionAfterEdit } from './offline-policy.mjs';
import { listRejectedProjectWrites, removeRejectedProjectWrite, saveRejectedProjectWrite } from './offline-recovery.mjs';
import { replayOfflineProjectChanges, SERVER_TIMESTAMP_RECOVERY_MARKER } from './offline-replay.mjs';
import { unreferencedUploadedKeys } from './project-upload-policy.mjs';

const [authApi, firestoreApi] = await Promise.all([
  import('https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js'),
  import('https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js')
]);

const {
  GoogleAuthProvider, getIdTokenResult, onAuthStateChanged, signInWithEmailAndPassword,
  signInWithPopup, signOut
} = authApi;
const { collection, deleteDoc, doc, getDocFromServer, onSnapshot, serverTimestamp, setDoc, updateDoc } = firestoreApi;
const byId = (id) => document.getElementById(id);
const signInDialog = byId('portfolio-sign-in-dialog');
const projectDialog = byId('portfolio-project-dialog');
const signInMessage = byId('portfolio-sign-in-message');
const projectMessage = byId('owner-project-message');
const progress = byId('owner-upload-progress');
const submitButton = byId('owner-project-publish');
const cancelButton = byId('owner-upload-cancel');
const projectTypeStep = byId('project-type-step');
const projectFormStep = byId('project-form-step');
const projectTypeCards = [...document.querySelectorAll('[data-project-type]')];
const projectTypeSettings = {
  'audio-track': { label: 'Audio Track', mediaType: 'audio', category: 'Audio', fields: ['media', 'artist', 'cover', 'external', 'genre', 'tags'], accept: 'audio/mpeg,audio/wav,audio/aac,audio/mp4,audio/ogg,audio/flac,audio/opus,audio/webm,.mp3,.wav,.aac,.m4a,.ogg,.flac,.opus,.webm' },
  'video-project': { label: 'Video Project', mediaType: 'video', category: 'Video', fields: ['media', 'cover', 'external'], accept: 'video/mp4,video/webm,video/quicktime,video/ogg,.mp4,.webm,.mov,.m4v,.ogv' },
  'image-cover': { label: 'Image / Cover Art', mediaType: 'image', category: 'Images', fields: ['media'], accept: 'image/jpeg,image/png,image/webp,image/avif,image/gif,.jpg,.jpeg,.png,.webp,.avif,.gif' },
  mixing: { label: 'Mixing Project', mediaType: 'audio', category: 'Mixing', fields: ['media', 'cover', 'external', 'comparison'], accept: 'audio/mpeg,audio/wav,audio/aac,audio/mp4,audio/ogg,audio/flac,audio/opus,audio/webm,.mp3,.wav,.aac,.m4a,.ogg,.flac,.opus,.webm' },
  mastering: { label: 'Mastering Project', mediaType: 'audio', category: 'Mastering', fields: ['media', 'cover', 'external', 'comparison'], accept: 'audio/mpeg,audio/wav,audio/aac,audio/mp4,audio/ogg,audio/flac,audio/opus,audio/webm,.mp3,.wav,.aac,.m4a,.ogg,.flac,.opus,.webm' },
  'coptic-hymn': { label: 'Coptic Hymn', mediaType: 'audio', category: 'Coptic Hymns', fields: ['media', 'artist', 'cover', 'external', 'genre', 'tags', 'lyrics'], accept: 'audio/mpeg,audio/wav,audio/aac,audio/mp4,audio/ogg,audio/flac,audio/opus,audio/webm,.mp3,.wav,.aac,.m4a,.ogg,.flac,.opus,.webm' }
};
let selectedProjectType = '';
let ownerUser = null;
let canManageProjects = false;
let stopOwnerProjects = null;
let activeUploadTask = null;
let cancelRequested = false;
let signInIntent = 'project';
let projectPreviewUrl = '';
let coverPreviewUrl = '';
const comparisonPreviewUrls = new Map();

function status(element, message, isError = false) {
  element.textContent = message;
  element.dataset.error = String(isError);
}

function safeFileName(value) {
  return String(value || 'media').normalize('NFKD').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(-90) || 'media';
}

function identify(file) {
  if (!file) return '';
  const type = String(file.type || '').toLowerCase();
  if (type.startsWith('audio/')) return 'audio';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('image/')) return 'image';
  const extension = file.name.split('.').pop().toLowerCase();
  if (['mp3', 'wav', 'aac', 'm4a', 'ogg', 'flac', 'opus'].includes(extension)) return 'audio';
  if (['mp4', 'webm', 'mov', 'm4v', 'ogv'].includes(extension)) return 'video';
  if (['jpg', 'jpeg', 'png', 'webp', 'avif', 'gif'].includes(extension)) return 'image';
  return '';
}

function safeExternalUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !/example\.com|placeholder/i.test(url.href);
  } catch { return false; }
}

function authMessage(error) {
  const code = error?.code || '';
  if (code === 'auth/invalid-credential' || code === 'auth/wrong-password' || code === 'auth/user-not-found') return 'That email and password did not match an account.';
  if (code === 'auth/unauthorized-domain') return 'Add this website hostname to Firebase Authentication → Settings → Authorized domains.';
  if (code === 'auth/operation-not-allowed') return 'Enable this sign-in method in Firebase Authentication → Sign-in method.';
  if (code === 'auth/invalid-api-key') return 'Firebase rejected this website configuration. Check the Web API key and project ID in firebase-config.js.';
  if (code === 'auth/popup-blocked') return 'Allow sign-in popups for this site and try Google sign-in again.';
  if (code === 'auth/user-disabled') return 'This Firebase account is disabled. Re-enable the existing owner account in Authentication → Users.';
  if (code === 'auth/user-token-expired' || code === 'auth/invalid-user-token') return 'Your Firebase session expired. Sign out and sign in again.';
  if (code === 'auth/network-request-failed') return 'Firebase could not be reached. Check the connection and try again.';
  return error?.message || 'Sign-in failed. Check the Firebase Authentication settings and connection.';
}

function projectError(error) {
  const code = error?.code || '';
  if (code === 'r2/not-configured') return error.message;
  if (code === 'r2/unreachable') return error.message;
  if (code === 'r2/unauthenticated') return 'Your Firebase sign-in expired during the upload. Sign out and back in, then retry; completed chunks can resume.';
  if (code === 'r2/forbidden') return 'Cloudflare rejected this account. Confirm the signed-in UID has the verified owner claim and that the Worker uses Firebase project yj-studio-50df5.';
  if (code === 'r2/quota') return `${error.message} Review Cloudflare R2/D1 usage and the configured safety quota before retrying.`;
  if (code === 'r2/not-found') return `${error.message} Confirm the latest R2 Worker version is deployed; if this is an old interrupted upload, select the file and retry.`;
  if (code === 'r2/server') return `${error.message} The upload service failed temporarily; retry to resume completed chunks.`;
  if (code === 'permission-denied') return 'Firestore denied this change. Confirm the signed-in owner and deployed rules. If this device was offline, a newer server revision may exist; reconnect, reload the latest project, and reapply your change.';
  if (code === 'storage/bucket-not-found') return 'The configured media storage bucket is unavailable.';
  if (code === 'storage/unauthorized') return 'Firebase denied a legacy Storage action. Check the account permissions and deployed Storage rules.';
  if (code === 'storage/canceled') return 'Upload canceled. No project was published.';
  if (code === 'storage/retry-limit-exceeded' || code === 'unavailable') return 'The upload was interrupted. Check the connection and retry.';
  if (String(error?.message || '').includes('Firebase Storage is not configured')) return 'Firebase Storage is not available. Initialize the bucket in Firebase Console and check firebase-config.js.';
  return `${error?.message || 'Could not save this project.'}${code ? ` (${code})` : ''}`;
}

function verifyOwner(user) {
  return verifyStudioProjectSessionWithCachedToken(user, getIdTokenResult, firebaseConfig.projectId);
}

function completeOwnerSignIn() {
  signInDialog.close();
  byId('portfolio-sign-in-form').reset();
  if (signInIntent === 'project') {
    resetProjectForm();
    projectDialog.showModal();
  }
  signInIntent = 'project';
  byId('portfolio-sign-in-title').textContent = 'Sign in to add projects';
  byId('portfolio-sign-in-description').textContent = 'Use the authorized YJ Studios account to manage portfolio projects.';
}

function requireVerifiedNotificationAccount(user) {
  if (!user?.emailVerified) throw new Error('Verify this Firebase account email before registering notification devices.');
}

function normalizeProject(snapshot) {
  const data = snapshot.data();
  return {
    ...data,
    id: snapshot.id,
    kind: data.mediaType || data.kind || '',
    mediaUrl: data.fileUrl || data.mediaUrl || data.externalUrl || data.videoUrl || data.audioUrl || '',
    externalUrl: data.externalUrl || data.videoUrl || '',
    fileName: data.fileName || data.title || 'Portfolio media',
    caption: data.description || data.caption || '',
    coverUrl: data.thumbnailUrl || data.coverUrl || '',
    tags: Array.isArray(data.tags) ? data.tags : [],
    published: data.published === true,
    revision: Number.isSafeInteger(data.revision) && data.revision >= 0 ? data.revision : 0,
    deleted: data.deleted === true,
    createdAt: data.createdAt?.toMillis?.() || Number(data.createdAt) || 0
  };
}

function projectR2Paths(data) {
  return [data.mediaPath || data.filePath || data.storagePath, data.coverPath || data.thumbnailPath, data.beforePath, data.afterPath, data.imagePath]
    .filter((path) => typeof path === 'string' && path.startsWith(`portfolio/${ownerUser?.uid || ''}/`));
}

async function retrySavedProjectWrites() {
  const operations = await listRejectedProjectWrites();
  if (!operations.length) return 0;
  if (!ownerUser || !canManageProjects) throw new Error('Sign in with the authorized owner account before retrying saved project changes or media cleanup.');
  const completed = await replayOfflineProjectChanges(operations, {
    ownerUid: ownerUser.uid,
    remove: removeRejectedProjectWrite,
    cleanupMedia: async (keys) => {
      await setR2Visibility(keys, false, auth).catch(() => {});
      await deleteR2Objects(keys, auth);
    },
    onCreateRecovered: (operation) => (operation.uploadSessions || []).forEach(forgetR2SessionDescriptor),
    firestore: { db, doc, getDocFromServer, setDoc, updateDoc, deleteDoc, serverTimestamp }
  });
  if (completed) status(byId('owner-portfolio-status'), `${completed} saved project change or media cleanup action${completed === 1 ? '' : 's'} completed.`);
}

async function downloadProjectRecovery() {
  const operations = await listRejectedProjectWrites();
  if (!operations.length) throw new Error('There are no saved project recovery records.');
  const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), operations }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `yj-studios-project-recovery-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function discardProjectRecovery() {
  const operations = await listRejectedProjectWrites();
  if (!operations.length) return 0;
  if (!confirm(`Permanently discard ${operations.length} saved project change or media cleanup record? This cannot be undone.`)) return 0;
  for (const operation of operations) {
    let keys = operation.type === 'orphan-media-cleanup' ? operation.keys : [];
    if (operation.type === 'create') keys = projectR2Paths(operation.data || {});
    if (keys.length) {
      if (isActuallyOfflineHint()) throw new Error('Reconnect before discarding a recovery record that includes uploaded media. The files must be checked against Firestore first.');
      const snapshot = await getDocFromServer(doc(db, 'projects', operation.docId));
      const safeKeys = unreferencedUploadedKeys(snapshot, keys, ownerUser.uid);
      if (safeKeys.length) {
        await setR2Visibility(safeKeys, false, auth).catch(() => {});
        await deleteR2Objects(safeKeys, auth);
      }
    }
    (operation.uploadSessions || []).forEach(forgetR2SessionDescriptor);
    await removeRejectedProjectWrite(operation.id);
  }
  return operations.length;
}

window.YJOffline?.setRecoveryHandler(retrySavedProjectWrites);

const tombstoneCleanup = new Set();

function listenToOwnerProjects() {
  if (stopOwnerProjects) stopOwnerProjects();
  stopOwnerProjects = onSnapshot(collection(db, 'projects'), { includeMetadataChanges: true }, (snapshot) => {
    observeFirestoreSnapshot('owner-projects', snapshot);
    const projects = snapshot.docs.map(normalizeProject);
    window.YJPortfolio?.renderAdminProjects(projects);
    if (!snapshot.metadata.fromCache) {
      for (const entry of snapshot.docs) {
        const data = entry.data();
        const paths = projectR2Paths(data);
        if (data.deleted !== true || entry.metadata.hasPendingWrites || paths.length || tombstoneCleanup.has(entry.id)) continue;
        tombstoneCleanup.add(entry.id);
        enqueueFirestoreWrite(`project-delete:${entry.id}`, () => deleteDoc(entry.ref), {
          type: 'finalize-delete', docId: entry.id, expectedRevision: Number.isSafeInteger(data.revision) ? data.revision : 0
        }).then(({ promise }) => promise.then(
          () => status(byId('owner-portfolio-status'), 'Offline deletion synchronized and the project record was removed.'),
          (error) => status(byId('owner-portfolio-status'), `The project is hidden from the portfolio, but final cleanup failed: ${projectError(error)}`, true)
        )).catch((error) => status(byId('owner-portfolio-status'), `The project is hidden from the portfolio, but final cleanup failed: ${projectError(error)}`, true))
          .finally(() => tombstoneCleanup.delete(entry.id));
      }
    }
  }, (error) => status(byId('owner-portfolio-status'), `Project list failed: ${projectError(error)}`, true));
}

function setOwnerAccess(enabled, message = '') {
  const addButton = byId('owner-add-project');
  const signOutButton = byId('owner-sign-out');
  canManageProjects = Boolean(enabled);
  addButton.hidden = false;
  signOutButton.hidden = !enabled;
  status(byId('owner-portfolio-status'), message, !enabled && Boolean(message));
  window.YJOffline?.setRecoveryReviewHandlers(enabled
    ? { download: downloadProjectRecovery, discard: discardProjectRecovery }
    : {});
  window.YJPortfolio?.setOwnerTools(enabled, {
    onEdit: editProject,
    onDelete: deleteProject,
    onPublish: setPublished
  });
}

async function acceptUser(user) {
  ownerUser = user;
  if (!user) {
    if (stopOwnerProjects) stopOwnerProjects();
    stopOwnerProjects = null;
    setOwnerAccess(false);
    return;
  }
  try {
    const access = await verifyOwner(user);
    if (!access.authorized) {
      if (stopOwnerProjects) stopOwnerProjects();
      stopOwnerProjects = null;
      setOwnerAccess(false, studioProjectAccessFailure(user, access.tokenResult, firebaseConfig.projectId));
      return;
    }
    setOwnerAccess(true, access.offline
      ? 'Owner identity verified from a valid cached Firebase token. Offline writes remain pending until Firestore validates them.'
      : `Signed in as ${user.email || 'YJ Studios account'}.`);
    listenToOwnerProjects();
  } catch (error) {
    if (stopOwnerProjects) stopOwnerProjects();
    stopOwnerProjects = null;
    setOwnerAccess(false, `Could not verify owner access: ${authMessage(error)}`);
  }
}

function closePreviewUrls() {
  if (projectPreviewUrl) URL.revokeObjectURL(projectPreviewUrl);
  if (coverPreviewUrl) URL.revokeObjectURL(coverPreviewUrl);
  comparisonPreviewUrls.forEach((url) => URL.revokeObjectURL(url));
  comparisonPreviewUrls.clear();
  projectPreviewUrl = '';
  coverPreviewUrl = '';
}

function resetProjectForm() {
  cancelRequested = false;
  closePreviewUrls();
  byId('portfolio-project-form').reset();
  selectedProjectType = '';
  projectTypeCards.forEach((card) => card.setAttribute('aria-pressed', 'false'));
  projectTypeStep.hidden = false;
  projectFormStep.hidden = true;
  byId('owner-project-type').value = '';
  byId('owner-project-media-type').value = '';
  byId('owner-project-preview').textContent = 'Select a media file to preview it here.';
  byId('owner-cover-preview').replaceChildren();
  progress.hidden = true;
  progress.value = 0;
  cancelButton.hidden = true;
  cancelButton.disabled = false;
  submitButton.disabled = false;
  submitButton.textContent = 'Publish Project';
  byId('owner-project-draft').disabled = false;
  byId('owner-project-cancel').disabled = false;
  status(projectMessage, '');
}

function chooseProjectType(type) {
  const settings = projectTypeSettings[type];
  if (!settings) return;
  const previous = projectTypeSettings[selectedProjectType];
  if (previous && previous.mediaType !== settings.mediaType) {
    byId('owner-project-file').value = '';
    if (projectPreviewUrl) URL.revokeObjectURL(projectPreviewUrl);
    projectPreviewUrl = '';
    byId('owner-project-preview').textContent = 'Select a file to preview it here.';
  }
  if (!settings.fields.includes('cover')) {
    byId('owner-project-cover').value = '';
    if (coverPreviewUrl) URL.revokeObjectURL(coverPreviewUrl);
    coverPreviewUrl = '';
    byId('owner-cover-preview').replaceChildren();
  }
  selectedProjectType = type;
  byId('owner-project-type').value = type;
  byId('owner-project-media-type').value = settings.mediaType;
  byId('owner-project-category').value = settings.category;
  byId('project-selected-type').textContent = settings.label;
  byId('owner-project-title-label').firstChild.textContent = type === 'coptic-hymn' ? 'Hymn title' : 'Project title';
  byId('owner-project-artist-label').textContent = type === 'coptic-hymn' ? 'Performer or choir name' : 'Artist name';
  byId('owner-project-url-label').textContent = settings.mediaType === 'video' ? 'YouTube or external video URL (optional)' : 'External media URL (optional)';
  byId('owner-project-file').accept = settings.accept;
  byId('owner-project-file').required = type === 'image-cover';
  document.querySelectorAll('.project-dynamic-field').forEach((field) => {
    const requiredField = field.dataset.showFor.split(',').some((name) => settings.fields.includes(name));
    field.hidden = !requiredField;
  });
  projectTypeCards.forEach((card) => card.setAttribute('aria-pressed', String(card.dataset.projectType === type)));
  projectTypeStep.hidden = true;
  projectFormStep.hidden = false;
  byId('owner-project-title').focus();
}

function previewFile(file, container, kind) {
  if (!file) return;
  const detected = identify(file);
  if (!detected || (kind && detected !== kind)) {
    container.textContent = 'That file type is not supported. Choose audio, MP4/WebM/MOV video, or JPEG/PNG/WebP image. MOV preview depends on your browser.';
    return;
  }
  const url = URL.createObjectURL(file);
  if (container.id === 'owner-project-preview') projectPreviewUrl = url;
  else if (container.id === 'owner-cover-preview') coverPreviewUrl = url;
  else comparisonPreviewUrls.set(container.id, url);
  container.replaceChildren();
  const label = document.createElement('span');
  label.textContent = `${detected.toUpperCase()} · ${file.name} · ${(file.size / 1048576).toFixed(1)} MB`;
  container.appendChild(label);
  let media;
  if (detected === 'image') {
    media = document.createElement('img'); media.alt = `Preview of ${file.name}`; media.className = 'owner-preview';
  } else if (detected === 'video') {
    media = document.createElement('video'); media.controls = true; media.playsInline = true; media.preload = 'metadata'; media.className = 'owner-preview';
  } else {
    media = document.createElement('audio'); media.controls = true; media.preload = 'metadata'; media.className = 'owner-preview';
  }
  media.src = url;
  container.appendChild(media);
}

function upload(projectId, file, kind, label) {
  return uploadR2({ file, kind, projectId, prefix: label.startsWith('Before') ? 'before' : label.startsWith('After') ? 'after' : label.toLowerCase().replace(/[^a-z]/g, ''), auth, onProgress: (percent) => { progress.value = percent; status(projectMessage, `${label}: ${percent}% uploaded · ${(file.size / 1048576).toFixed(1)} MB`); }, onTask: (task) => { activeUploadTask = task; } });
}

async function cleanupFailedProjectUploads(projectId, keys, user) {
  if (!keys.length) return { state: 'none' };
  const recovery = {
    type: 'orphan-media-cleanup', docId: projectId, ownerUid: user.uid,
    keys: [...new Set(keys)], lastError: 'A project save did not receive confirmed success.'
  };
  try {
    // A cached/missing document is not proof that Firestore rejected the save.
    const snapshot = await getDocFromServer(doc(db, 'projects', projectId));
    const safeKeys = unreferencedUploadedKeys(snapshot, recovery.keys, user.uid);
    if (!safeKeys.length) return { state: 'referenced' };
    await setR2Visibility(safeKeys, false, auth).catch(() => {});
    await deleteR2Objects(safeKeys, auth);
    return { state: 'deleted', count: safeKeys.length };
  } catch (error) {
    try {
      await saveRejectedProjectWrite({ ...recovery, lastError: String(error?.message || error) });
      await window.YJOffline?.refreshRecoveryCount?.();
      return { state: 'queued', error };
    } catch (recoveryError) {
      return { state: 'preserved', error, recoveryError };
    }
  }
}

function uploadCleanupMessage(result) {
  if (result.state === 'deleted') return ' Completed uploaded media was safely removed.';
  if (result.state === 'referenced') return ' Firestore already references the uploaded media, so it was preserved.';
  if (result.state === 'queued') return ' Uploaded media was preserved; its exact R2 paths are saved for safe owner cleanup after reconnecting.';
  if (result.state === 'preserved') return ` Uploaded media was preserved because Firestore could not confirm whether it is referenced. Keep project ID ${result.projectId || 'shown in the upload details'} for support.`;
  return '';
}

async function saveProject(published) {
  if (!ownerUser || !canManageProjects) {
    status(projectMessage, 'Sign in with the authorized account before adding a project.', true);
    return;
  }
  const settings = projectTypeSettings[selectedProjectType];
  if (!settings) { status(projectMessage, 'Choose a project type first.', true); return; }
  const file = byId('owner-project-file').files[0] || null;
  const cover = settings.fields.includes('cover') ? byId('owner-project-cover').files[0] || null : null;
  const externalUrl = settings.fields.includes('external') ? byId('owner-project-url').value.trim() : '';
  const beforeFile = settings.fields.includes('comparison') ? byId('owner-project-before-file').files[0] || null : null;
  const afterFile = settings.fields.includes('comparison') ? byId('owner-project-after-file').files[0] || null : null;
  const title = byId('owner-project-title').value.trim();
  const description = byId('owner-project-description').value.trim();
  const category = settings.category;
  const artist = settings.fields.includes('artist') ? byId('owner-project-artist').value.trim() : '';
  const genre = settings.fields.includes('genre') ? byId('owner-project-genre').value.trim() : '';
  const tags = settings.fields.includes('tags') ? [...new Set(byId('owner-project-tags').value.split(',').map((tag) => tag.trim()).filter(Boolean))] : [];
  const lyrics = settings.fields.includes('lyrics') ? byId('owner-project-lyrics').value.trim() : '';
  let comparisonBeforeUrl = settings.fields.includes('comparison') ? byId('owner-project-before').value.trim() : '';
  let comparisonAfterUrl = settings.fields.includes('comparison') ? byId('owner-project-after').value.trim() : '';
  const projectDate = byId('owner-project-date').value;
  const sortOrder = Number(byId('owner-project-order').value || 100);
  if (!title) { status(projectMessage, 'Enter a project title.', true); return; }
  if (!file && !externalUrl) { status(projectMessage, 'Choose a media file or enter an external media URL.', true); return; }
  if (selectedProjectType === 'image-cover' && !file) { status(projectMessage, 'Choose an image file for this project.', true); return; }
  if (externalUrl && !safeExternalUrl(externalUrl)) { status(projectMessage, 'Use a valid public HTTPS URL without example or placeholder domains.', true); return; }
  if ((beforeFile && comparisonBeforeUrl) || (afterFile && comparisonAfterUrl)) { status(projectMessage, 'For each comparison, choose a file or enter a URL, not both.', true); return; }
  if ([comparisonBeforeUrl, comparisonAfterUrl].some((url) => url && !safeExternalUrl(url))) { status(projectMessage, 'Comparison examples must be valid public HTTPS audio URLs.', true); return; }
  if (tags.length > 12 || tags.some((tag) => tag.length > 40)) { status(projectMessage, 'Use up to 12 tags, no longer than 40 characters each.', true); return; }
  if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 9999) { status(projectMessage, 'Display order must be a number from 0 to 9999.', true); return; }
  const kind = settings.mediaType;
  const usesUploadedFiles = Boolean(file || cover || beforeFile || afterFile);
  const offlineFailure = offlineProjectWriteFailure({
    offline: isActuallyOfflineHint(),
    persistent: persistentOfflineStorageEnabled(),
    usesFiles: usesUploadedFiles
  });
  if (offlineFailure) { status(projectMessage, offlineFailure, true); return; }
  try {
    if (file) validateMediaFile(file, kind, MAX_MEDIA_BYTES);
    if (cover) validateMediaFile(cover, 'image', MAX_COVER_BYTES);
    if (beforeFile) validateMediaFile(beforeFile, 'audio', MAX_MEDIA_BYTES);
    if (afterFile) validateMediaFile(afterFile, 'audio', MAX_MEDIA_BYTES);
    if (cover && kind === 'image') throw new Error('For an image project, the main image is already its cover. Remove the extra cover or choose audio/video.');
  } catch (error) { status(projectMessage, error.message, true); return; }

  const resumeFile = file || cover || beforeFile || afterFile;
  const id = getResumeProjectId(resumeFile) || crypto.randomUUID();
  let mediaPath = ''; let coverPath = ''; let beforePath = ''; let afterPath = '';
  const uploadedKeys = [];
  let mediaUploaded = false;
  let coverUploaded = false;
  let beforeUploaded = false;
  let afterUploaded = false;
  let cancellationHandled = false;
  let projectRecoveryId = '';
  submitButton.disabled = true;
  byId('owner-project-draft').disabled = true;
  byId('owner-project-cancel').disabled = true;
  submitButton.textContent = 'Uploading…';
  cancelButton.hidden = false;
  progress.hidden = false;
  progress.value = 0;
  cancelRequested = false;

  try {
    let mediaUrl = externalUrl;
    if (file) {
      const result = await upload(id, file, kind, 'Media'); mediaUrl = result.url; mediaPath = result.key; uploadedKeys.push(result.key);
      mediaUploaded = true;
      activeUploadTask = null;
      if (cancelRequested) throw Object.assign(new Error('Upload canceled.'), { code: 'storage/canceled' });
    }
    let coverUrl = '';
    if (cover) {
      const result = await upload(id, cover, 'image', 'Cover'); coverUrl = result.url; coverPath = result.key; uploadedKeys.push(result.key);
      coverUploaded = true;
      activeUploadTask = null;
      if (cancelRequested) throw Object.assign(new Error('Upload canceled.'), { code: 'storage/canceled' });
    }
    if (beforeFile) {
      const result = await upload(id, beforeFile, 'audio', 'Before audio'); comparisonBeforeUrl = result.url; beforePath = result.key; uploadedKeys.push(result.key);
      beforeUploaded = true;
      activeUploadTask = null;
      if (cancelRequested) throw Object.assign(new Error('Upload canceled.'), { code: 'storage/canceled' });
    }
    if (afterFile) {
      const result = await upload(id, afterFile, 'audio', 'After audio'); comparisonAfterUrl = result.url; afterPath = result.key; uploadedKeys.push(result.key);
      afterUploaded = true;
      activeUploadTask = null;
      if (cancelRequested) throw Object.assign(new Error('Upload canceled.'), { code: 'storage/canceled' });
    }
    if (cancelRequested) throw Object.assign(new Error('Upload canceled.'), { code: 'storage/canceled' });

    const record = {
      kind, mediaType: kind, projectType: selectedProjectType, sourceType: file ? 'storage' : 'external',
      title: title.slice(0, 100), fileName: file?.name || title,
      description: description.slice(0, 1000), caption: description.slice(0, 180), category: category.slice(0, 60),
      artist: artist.slice(0, 100), genre: genre.slice(0, 80), tags, lyrics: lyrics.slice(0, 4000), projectDate,
      comparisonBeforeUrl, comparisonAfterUrl,
      credits: '', fileUrl: mediaUrl, mediaUrl, externalUrl: file ? '' : externalUrl,
      filePath: mediaPath, mediaPath, coverPath, coverUrl, thumbnailUrl: coverUrl,
      beforePath, afterPath,
      size: file?.size || 0, contentType: file ? contentTypeForMedia(file, kind) : '',
      published, sortOrder, ownerUid: ownerUser.uid, revision: 0, createdAt: serverTimestamp(), updatedAt: serverTimestamp()
    };
    if (isActuallyOfflineHint() && !persistentOfflineStorageEnabled()) {
      throw new Error('Connectivity was lost before Firestore could save the project. Offline Firestore storage is disabled; reconnect and retry.');
    }
    await setR2Visibility(uploadedKeys, published, auth);
    if (uploadedKeys.length) {
      submitButton.textContent = 'Saving…';
      status(projectMessage, 'Media uploaded. Saving project details to Firestore…');
    }
    const recoveryRecord = { ...record, createdAt: SERVER_TIMESTAMP_RECOVERY_MARKER, updatedAt: SERVER_TIMESTAMP_RECOVERY_MARKER };
    const uploadSessions = [file, cover, beforeFile, afterFile].filter(Boolean)
      .map(({ name, size, lastModified }) => ({ name, size, lastModified }));
    const queuedWrite = await enqueueFirestoreWrite(`project:${id}`, () => setDoc(doc(db, 'projects', id), record), {
      type: 'create', docId: id, data: recoveryRecord, uploadSessions
    });
    const { promise: write } = queuedWrite;
    projectRecoveryId = queuedWrite.recoveryId;
    if (isActuallyOfflineHint()) {
      write.then(() => [file, cover, beforeFile, afterFile].forEach(forgetR2Session), () => {});
      write.catch((error) => status(byId('owner-portfolio-status'), `Project ${id} is queued locally but Firebase rejected it: ${projectError(error)} The saved project details and media paths remain available under Offline data settings → Retry sync.`, true));
      cancellationHandled = true;
      progress.value = 100;
      status(projectMessage, 'Project saved in this device’s Firestore queue. It is not published on the server until connectivity returns and Firebase accepts the write.');
      byId('portfolio-project-form').reset();
      byId('owner-project-preview').textContent = 'Select a media file to preview it here.';
      byId('owner-cover-preview').replaceChildren();
      cancelButton.hidden = true;
      setTimeout(() => { if (projectDialog.open) projectDialog.close(); resetProjectForm(); }, 1800);
      return;
    }
    await write;
    [file, cover, beforeFile, afterFile].forEach(forgetR2Session);
    cancellationHandled = true;
    cancelButton.hidden = true;
    progress.value = 100;
    status(projectMessage, published ? 'Project published to Studio Work.' : 'Project saved as a draft.');
    byId('portfolio-project-form').reset();
    byId('owner-project-preview').textContent = 'Select a media file to preview it here.';
    byId('owner-cover-preview').replaceChildren();
    setTimeout(() => { if (projectDialog.open) projectDialog.close(); resetProjectForm(); }, 1300);
  } catch (error) {
    if (projectRecoveryId) {
      status(projectMessage, `${projectError(error)} The project details and uploaded media paths are saved locally for an authorized retry; uploaded files were preserved.`, true);
    } else {
      const cleanup = await cleanupFailedProjectUploads(id, uploadedKeys, ownerUser);
      status(projectMessage, `${projectError(error)}${uploadCleanupMessage({ ...cleanup, projectId: id })}`, true);
    }
  } finally {
    activeUploadTask = null;
    if (!cancellationHandled) {
      submitButton.disabled = false;
      byId('owner-project-draft').disabled = false;
      byId('owner-project-cancel').disabled = false;
      submitButton.textContent = 'Publish Project';
      cancelButton.hidden = true;
      progress.hidden = true;
    }
  }
}

async function editProject(project) {
  const title = prompt('Project title', project.title || '');
  if (title === null) return;
  const description = prompt('Project description', project.description || project.caption || '');
  if (description === null) return;
  const category = prompt('Category', project.category || 'Other');
  if (category === null) return;
  const thumbnailUrl = prompt('Cover / thumbnail HTTPS URL (leave blank for none)', project.thumbnailUrl || project.coverUrl || '');
  if (thumbnailUrl === null) return;
  if (thumbnailUrl && !safeExternalUrl(thumbnailUrl)) { status(byId('owner-portfolio-status'), 'Use a valid public HTTPS thumbnail URL.', true); return; }
  const artist = prompt('Artist / performer', project.artist || '');
  if (artist === null) return;
  const existingTags = Array.isArray(project.tags) ? project.tags.join(', ') : '';
  const tagsText = prompt('Tags (comma separated)', existingTags);
  if (tagsText === null) return;
  const tags = [...new Set(tagsText.split(',').map((tag) => tag.trim()).filter(Boolean))];
  if (tags.length > 12 || tags.some((tag) => tag.length > 40)) { status(byId('owner-portfolio-status'), 'Use at most 12 tags, no longer than 40 characters each.', true); return; }
  const projectDate = prompt('Project date (YYYY-MM-DD or blank)', project.projectDate || '');
  if (projectDate === null) return;
  if (projectDate && !/^\d{4}-\d{2}-\d{2}$/.test(projectDate)) { status(byId('owner-portfolio-status'), 'Project date must use YYYY-MM-DD.', true); return; }
  const offlineFailure = offlineProjectWriteFailure({ offline: isActuallyOfflineHint(), persistent: persistentOfflineStorageEnabled() });
  if (offlineFailure) { status(byId('owner-portfolio-status'), offlineFailure, true); return; }
  try {
    const changes = {
      title: title.trim().slice(0, 100), description: description.trim().slice(0, 1000),
      caption: description.trim().slice(0, 180), category: category.trim().slice(0, 60),
      thumbnailUrl, coverUrl: thumbnailUrl,
      artist: artist.trim().slice(0, 100), tags, projectDate,
      revision: projectRevisionAfterEdit(project.revision), updatedAt: serverTimestamp()
    };
    const recoveryData = { ...changes, updatedAt: SERVER_TIMESTAMP_RECOVERY_MARKER };
    const { promise: write } = await enqueueFirestoreWrite(`project:${project.id}`, () => updateDoc(doc(db, 'projects', project.id), changes), {
      type: 'update', docId: project.id, expectedRevision: project.revision, data: recoveryData
    });
    if (isActuallyOfflineHint()) {
      write.catch((error) => status(byId('owner-portfolio-status'), `Project update was queued but Firebase rejected it: ${projectError(error)}`, true));
      status(byId('owner-portfolio-status'), `Changes to “${title.trim()}” are saved locally and awaiting Firestore validation.`);
      return;
    }
    await write;
    status(byId('owner-portfolio-status'), `Updated “${title.trim()}”.`);
  } catch (error) { status(byId('owner-portfolio-status'), projectError(error), true); }
}

async function setPublished(project, published) {
  const keys = [project.mediaPath || project.filePath, project.coverPath, project.beforePath, project.afterPath].filter((path) => typeof path === 'string' && path.startsWith(`portfolio/${ownerUser.uid}/`));
  const offlineFailure = offlineProjectWriteFailure({ offline: isActuallyOfflineHint(), persistent: persistentOfflineStorageEnabled(), usesFiles: keys.length > 0 });
  if (offlineFailure) { status(byId('owner-portfolio-status'), offlineFailure, true); return; }
  try {
    if (isActuallyOfflineHint()) {
      const changes = { published, revision: projectRevisionAfterEdit(project.revision), updatedAt: serverTimestamp() };
      const { promise: write } = await enqueueFirestoreWrite(`project:${project.id}`, () => updateDoc(doc(db, 'projects', project.id), changes), {
        type: 'update', docId: project.id, expectedRevision: project.revision,
        data: { ...changes, updatedAt: SERVER_TIMESTAMP_RECOVERY_MARKER }
      });
      write.catch((error) => status(byId('owner-portfolio-status'), `Visibility change was queued but Firebase rejected it: ${projectError(error)}`, true));
      status(byId('owner-portfolio-status'), `Project visibility change is saved locally; Firebase must confirm it before it takes effect publicly.`);
      return;
    }
    await setR2Visibility(keys, published, auth);
    try {
      const changes = { published, revision: projectRevisionAfterEdit(project.revision), updatedAt: serverTimestamp() };
      const recovery = keys.length ? null : {
        type: 'update', docId: project.id, expectedRevision: project.revision,
        data: { ...changes, updatedAt: SERVER_TIMESTAMP_RECOVERY_MARKER }
      };
      const { promise: write } = await enqueueFirestoreWrite(`project:${project.id}`, () => updateDoc(doc(db, 'projects', project.id), changes), recovery);
      await write;
    }
    catch (error) { await setR2Visibility(keys, !published, auth).catch(() => {}); throw error; }
    status(byId('owner-portfolio-status'), published ? 'Project published.' : 'Project unpublished.');
  } catch (error) { status(byId('owner-portfolio-status'), projectError(error), true); }
}

async function deleteProject(project) {
  if (!confirm(project.deleted
    ? `Retry cleanup and finish deleting “${project.title || 'this project'}”?`
    : `Delete “${project.title || 'this project'}” and its uploaded files?`)) return;
  const paths = projectR2Paths(project);
  const offlineFailure = offlineProjectWriteFailure({ offline: isActuallyOfflineHint(), persistent: persistentOfflineStorageEnabled(), usesFiles: paths.length > 0 });
  if (offlineFailure) { status(byId('owner-portfolio-status'), offlineFailure, true); return; }
  try {
    if (project.deleted) {
      if (paths.length) await deleteR2Objects(paths, auth);
      const { promise: removeRecord } = await enqueueFirestoreWrite(`project-delete:${project.id}`, () => deleteDoc(doc(db, 'projects', project.id)), {
        type: 'finalize-delete', docId: project.id, expectedRevision: project.revision, r2CleanupConfirmed: paths.length > 0
      });
      await removeRecord;
      status(byId('owner-portfolio-status'), 'Project and its authorized media cleanup are complete.');
      return;
    }

    const tombstone = {
      published: false, deleted: true,
      revision: projectRevisionAfterEdit(project.revision), updatedAt: serverTimestamp()
    };
    const { promise: markDeleted } = await enqueueFirestoreWrite(`project:${project.id}`, () => updateDoc(doc(db, 'projects', project.id), tombstone), {
      type: 'update', docId: project.id, expectedRevision: project.revision,
      data: { ...tombstone, updatedAt: SERVER_TIMESTAMP_RECOVERY_MARKER }
    });

    if (isActuallyOfflineHint()) {
      markDeleted.catch((error) => status(byId('owner-portfolio-status'), `Deletion was queued but Firebase rejected it: ${projectError(error)}`, true));
      status(byId('owner-portfolio-status'), 'Project hidden locally and queued for deletion. It leaves the public portfolio only after Firestore confirms the change; reconnect to finish cleanup.');
      return;
    }

    await markDeleted;
    if (paths.length) {
      try { await deleteR2Objects(paths, auth); }
      catch (error) {
        status(byId('owner-portfolio-status'), `The project is safely hidden from the public portfolio, but its R2 files remain. Use “Retry file cleanup” on the pending-delete card. ${projectError(error)}`, true);
        return;
      }
      const { promise: removeRecord } = await enqueueFirestoreWrite(`project-delete:${project.id}`, () => deleteDoc(doc(db, 'projects', project.id)), {
        type: 'finalize-delete', docId: project.id, expectedRevision: tombstone.revision, r2CleanupConfirmed: true
      });
      await removeRecord;
    }
    status(byId('owner-portfolio-status'), 'Project and R2 media files deleted.');
  } catch (error) { status(byId('owner-portfolio-status'), projectError(error), true); }
}

byId('portfolio-sign-in-close').addEventListener('click', () => signInDialog.close());
byId('owner-add-project').addEventListener('click', () => {
  if (canManageProjects) { resetProjectForm(); projectDialog.showModal(); }
  else { signInIntent = 'project'; byId('portfolio-sign-in-title').textContent = 'Sign in to add projects'; byId('portfolio-sign-in-description').textContent = 'Use the authorized YJ Studios account to manage portfolio projects.'; status(signInMessage, 'Sign in with the authorized Firebase account to manage Studio Work.'); signInDialog.showModal(); }
});
window.addEventListener('yj:open-owner-sign-in', () => {
  signInIntent = 'notifications';
  byId('portfolio-sign-in-title').textContent = 'Sign in for notifications';
  byId('portfolio-sign-in-description').textContent = 'Use an existing verified Google or email/password Firebase account. It can manage only its own notification devices.';
  status(signInMessage, 'Sign in with a verified Firebase account to register this browser.');
  signInDialog.showModal();
});
projectTypeCards.forEach((card) => card.addEventListener('click', () => chooseProjectType(card.dataset.projectType)));
byId('project-type-back').addEventListener('click', () => {
  if (submitButton.disabled) return;
  projectTypeStep.hidden = false;
  projectFormStep.hidden = true;
  projectTypeCards.find((card) => card.dataset.projectType === selectedProjectType)?.focus();
});
byId('project-type-cancel-start').addEventListener('click', () => projectDialog.close());
byId('owner-project-cancel').addEventListener('click', () => { if (!submitButton.disabled) projectDialog.close(); });
byId('owner-project-draft').addEventListener('click', () => saveProject(false));
byId('owner-project-publish').addEventListener('click', () => saveProject(true));
projectDialog.addEventListener('cancel', (event) => {
  if (submitButton.disabled) {
    event.preventDefault();
    cancelRequested = true;
    activeUploadTask?.cancel();
    cancelButton.disabled = true;
    status(projectMessage, 'Canceling upload…');
  }
});
byId('owner-upload-cancel').addEventListener('click', () => {
  cancelRequested = true;
  if (activeUploadTask) activeUploadTask.cancel();
  status(projectMessage, 'Canceling upload…');
  cancelButton.disabled = true;
});
projectDialog.addEventListener('close', () => { if (!activeUploadTask) resetProjectForm(); });
byId('owner-project-file').addEventListener('change', (event) => {
  if (projectPreviewUrl) URL.revokeObjectURL(projectPreviewUrl);
  projectPreviewUrl = '';
  const file = event.target.files?.[0];
  if (!file) { byId('owner-project-preview').textContent = 'Select a media file to preview it here.'; return; }
  const kind = identify(file);
  const expectedKind = projectTypeSettings[selectedProjectType]?.mediaType;
  if (!kind || kind !== expectedKind) {
    event.target.value = '';
    byId('owner-project-preview').textContent = 'This file does not match the selected project type. Choose a supported file and try again.';
    status(projectMessage, 'Selected file type does not match this project.', true);
    return;
  }
  status(projectMessage, '');
  previewFile(file, byId('owner-project-preview'), expectedKind);
});
byId('owner-project-cover').addEventListener('change', (event) => {
  if (coverPreviewUrl) URL.revokeObjectURL(coverPreviewUrl);
  coverPreviewUrl = '';
  byId('owner-cover-preview').replaceChildren();
  const file = event.target.files?.[0];
  if (file) previewFile(file, byId('owner-cover-preview'), 'image');
});
for (const [inputId, previewId] of [['owner-project-before-file', 'owner-project-before-preview'], ['owner-project-after-file', 'owner-project-after-preview']]) {
  byId(inputId).addEventListener('change', (event) => {
    const previous = comparisonPreviewUrls.get(previewId);
    if (previous) URL.revokeObjectURL(previous);
    comparisonPreviewUrls.delete(previewId);
    const preview = byId(previewId);
    preview.replaceChildren();
    const file = event.target.files?.[0];
    if (!file) return;
    if (identify(file) !== 'audio') {
      event.target.value = '';
      status(projectMessage, 'Choose a supported audio file for the comparison.', true);
      return;
    }
    previewFile(file, preview, 'audio');
  });
}
byId('portfolio-project-form').addEventListener('submit', (event) => event.preventDefault());
byId('portfolio-sign-in-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  status(signInMessage, 'Checking Firebase account…');
  try {
    const credential = await signInWithEmailAndPassword(auth, byId('portfolio-owner-email').value.trim(), byId('portfolio-owner-password').value);
    if (signInIntent === 'notifications') {
      requireVerifiedNotificationAccount(credential.user);
      completeOwnerSignIn();
      return;
    }
    const access = await verifyOwner(auth.currentUser);
    if (!access.authorized) throw new Error(studioProjectAccessFailure(auth.currentUser, access.tokenResult, firebaseConfig.projectId));
    completeOwnerSignIn();
  } catch (error) { status(signInMessage, authMessage(error), true); }
});
byId('portfolio-google-sign-in').addEventListener('click', async () => {
  status(signInMessage, 'Connecting to Google…');
  try {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    const result = await signInWithPopup(auth, provider);
    if (signInIntent === 'notifications') {
      requireVerifiedNotificationAccount(result.user);
      completeOwnerSignIn();
      return;
    }
    const access = await verifyOwner(result.user);
    if (!access.authorized) throw new Error(studioProjectAccessFailure(result.user, access.tokenResult, firebaseConfig.projectId));
    completeOwnerSignIn();
  } catch (error) { status(signInMessage, authMessage(error), true); }
});
byId('owner-sign-out').addEventListener('click', async () => {
  try { await window.YJOffline?.flushBeforeOwnerSignOut?.(); }
  catch (error) { status(byId('owner-portfolio-status'), error.message, true); return; }
  await window.YJNotifications?.unregisterCurrentDevice?.();
  signOut(auth).catch((error) => status(byId('owner-portfolio-status'), authMessage(error), true));
});

onAuthStateChanged(auth, (user) => { acceptUser(user).catch((error) => setOwnerAccess(false, authMessage(error))); });


