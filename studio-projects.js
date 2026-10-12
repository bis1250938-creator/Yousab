import { app, auth, db } from './firebase-client.js';
import { contentTypeForMedia, MAX_COVER_BYTES, MAX_MEDIA_BYTES, validateMediaFile } from './media-storage.js';
import { uploadR2, deleteR2Objects, setR2Visibility, getResumeProjectId, forgetR2Session } from './r2-uploader.js';

const [authApi, firestoreApi] = await Promise.all([
  import('https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js'),
  import('https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js')
]);

const {
  GoogleAuthProvider, getIdTokenResult, onAuthStateChanged, signInWithEmailAndPassword,
  signInWithPopup, signOut
} = authApi;
const { collection, deleteDoc, doc, onSnapshot, serverTimestamp, setDoc, updateDoc } = firestoreApi;
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
  'audio-track': { label: 'Audio Track', mediaType: 'audio', category: 'Audio', fields: ['media', 'artist', 'cover', 'external', 'genre', 'tags'], accept: 'audio/mpeg,audio/wav,audio/aac,audio/mp4,audio/ogg,audio/flac,.mp3,.wav,.aac,.m4a,.ogg,.flac' },
  'video-project': { label: 'Video Project', mediaType: 'video', category: 'Video', fields: ['media', 'cover', 'external'], accept: 'video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov' },
  'image-cover': { label: 'Image / Cover Art', mediaType: 'image', category: 'Images', fields: ['media'], accept: 'image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp' },
  mixing: { label: 'Mixing Project', mediaType: 'audio', category: 'Mixing', fields: ['media', 'cover', 'external', 'comparison'], accept: 'audio/mpeg,audio/wav,audio/aac,audio/mp4,audio/ogg,audio/flac,.mp3,.wav,.aac,.m4a,.ogg,.flac' },
  mastering: { label: 'Mastering Project', mediaType: 'audio', category: 'Mastering', fields: ['media', 'cover', 'external', 'comparison'], accept: 'audio/mpeg,audio/wav,audio/aac,audio/mp4,audio/ogg,audio/flac,.mp3,.wav,.aac,.m4a,.ogg,.flac' },
  'coptic-hymn': { label: 'Coptic Hymn', mediaType: 'audio', category: 'Coptic Hymns', fields: ['media', 'artist', 'cover', 'external', 'genre', 'tags', 'lyrics'], accept: 'audio/mpeg,audio/wav,audio/aac,audio/mp4,audio/ogg,audio/flac,.mp3,.wav,.aac,.m4a,.ogg,.flac' }
};
let selectedProjectType = '';
let ownerUser = null;
let canManageProjects = false;
let stopOwnerProjects = null;
let activeUploadTask = null;
let cancelRequested = false;
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
  if (code === 'auth/popup-blocked') return 'Allow sign-in popups for this site and try Google sign-in again.';
  return error?.message || 'Sign-in failed. Check the Firebase Authentication settings and connection.';
}

function projectError(error) {
  const code = error?.code || '';
  if (code === 'storage/bucket-not-found') return 'The configured media storage bucket is unavailable.';
  if (code === 'storage/unauthorized' || code === 'permission-denied') return 'Firebase denied this action. Check the account permissions and deployed Firestore and Storage rules.';
  if (code === 'storage/canceled') return 'Upload canceled. No project was published.';
  if (code === 'storage/retry-limit-exceeded' || code === 'unavailable') return 'The upload was interrupted. Check the connection and retry.';
  if (String(error?.message || '').includes('Firebase Storage is not configured')) return 'Firebase Storage is not available. Initialize the bucket in Firebase Console and check firebase-config.js.';
  return `${error?.message || 'Could not save this project.'}${code ? ` (${code})` : ''}`;
}

function verifyOwner(user) {
  if (!user?.emailVerified) return Promise.resolve(false);
  return getIdTokenResult(user, true).then((token) => {
    const provider = token.claims.firebase?.sign_in_provider;
    return token.claims.owner === true && ['google.com', 'password'].includes(provider);
  });
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
    createdAt: data.createdAt?.toMillis?.() || Number(data.createdAt) || 0
  };
}

function listenToOwnerProjects() {
  if (stopOwnerProjects) stopOwnerProjects();
  stopOwnerProjects = onSnapshot(collection(db, 'projects'), (snapshot) => {
    const projects = snapshot.docs.map(normalizeProject);
    window.YJPortfolio?.renderAdminProjects(projects);
  }, (error) => status(byId('owner-portfolio-status'), `Project list failed: ${projectError(error)}`, true));
}

function setOwnerAccess(enabled, message = '') {
  const addButton = byId('owner-add-project');
  const signOutButton = byId('owner-sign-out');
  canManageProjects = Boolean(enabled);
  addButton.hidden = false;
  signOutButton.hidden = !enabled;
  status(byId('owner-portfolio-status'), message, !enabled && Boolean(message));
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
    if (!(await verifyOwner(user))) {
      if (stopOwnerProjects) stopOwnerProjects();
      stopOwnerProjects = null;
      setOwnerAccess(false, 'This account is signed in but is not authorized to manage Studio Work.');
      return;
    }
    setOwnerAccess(true, `Signed in as ${user.email || 'YJ Studios account'}.`);
    listenToOwnerProjects();
  } catch (error) {
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
      published, sortOrder, ownerUid: ownerUser.uid, createdAt: serverTimestamp(), updatedAt: serverTimestamp()
    };
    await setR2Visibility(uploadedKeys, published, auth);
    await setDoc(doc(db, 'projects', id), record);
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
    await deleteR2Objects(uploadedKeys, auth).catch(() => {});
    [file, cover, beforeFile, afterFile].forEach(forgetR2Session);
    status(projectMessage, projectError(error), true);
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
  try {
    await updateDoc(doc(db, 'projects', project.id), {
      title: title.trim().slice(0, 100), description: description.trim().slice(0, 1000),
      caption: description.trim().slice(0, 180), category: category.trim().slice(0, 60),
      thumbnailUrl, coverUrl: thumbnailUrl,
      artist: artist.trim().slice(0, 100), tags, projectDate, updatedAt: serverTimestamp()
    });
    status(byId('owner-portfolio-status'), `Updated “${title.trim()}”.`);
  } catch (error) { status(byId('owner-portfolio-status'), projectError(error), true); }
}

async function setPublished(project, published) {
  try {
    const keys = [project.mediaPath || project.filePath, project.coverPath, project.beforePath, project.afterPath].filter((path) => typeof path === 'string' && path.startsWith(`portfolio/${ownerUser.uid}/`));
    await setR2Visibility(keys, published, auth);
    try { await updateDoc(doc(db, 'projects', project.id), { published, updatedAt: serverTimestamp() }); }
    catch (error) { await setR2Visibility(keys, !published, auth).catch(() => {}); throw error; }
    status(byId('owner-portfolio-status'), published ? 'Project published.' : 'Project unpublished.');
  } catch (error) { status(byId('owner-portfolio-status'), projectError(error), true); }
}

async function deleteProject(project) {
  if (!confirm(`Delete “${project.title || 'this project'}” and its uploaded files?`)) return;
  try {
    const paths = [project.mediaPath || project.filePath, project.coverPath, project.beforePath, project.afterPath].filter((path) => typeof path === 'string' && path.startsWith(`portfolio/${ownerUser.uid}/`));
    await deleteR2Objects(paths, auth);
    await deleteDoc(doc(db, 'projects', project.id));
    status(byId('owner-portfolio-status'), 'Project and R2 media files deleted.');
  } catch (error) { status(byId('owner-portfolio-status'), projectError(error), true); }
}

byId('portfolio-sign-in-close').addEventListener('click', () => signInDialog.close());
byId('owner-add-project').addEventListener('click', () => {
  if (canManageProjects) { resetProjectForm(); projectDialog.showModal(); }
  else { status(signInMessage, 'Sign in with the authorized Firebase account to manage Studio Work.'); signInDialog.showModal(); }
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
    await signInWithEmailAndPassword(auth, byId('portfolio-owner-email').value.trim(), byId('portfolio-owner-password').value);
    if (!(await verifyOwner(auth.currentUser))) throw new Error('This account is not authorized to manage Studio Work.');
    signInDialog.close();
    byId('portfolio-sign-in-form').reset();
    resetProjectForm(); projectDialog.showModal();
  } catch (error) { status(signInMessage, authMessage(error), true); }
});
byId('portfolio-google-sign-in').addEventListener('click', async () => {
  status(signInMessage, 'Connecting to Google…');
  try {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    const result = await signInWithPopup(auth, provider);
    if (!(await verifyOwner(result.user))) throw new Error('This Google account is not authorized to manage Studio Work.');
    signInDialog.close();
    resetProjectForm(); projectDialog.showModal();
  } catch (error) { status(signInMessage, authMessage(error), true); }
});
byId('owner-sign-out').addEventListener('click', () => signOut(auth).catch((error) => status(byId('owner-portfolio-status'), authMessage(error), true)));

onAuthStateChanged(auth, (user) => { acceptUser(user).catch((error) => setOwnerAccess(false, authMessage(error))); });


