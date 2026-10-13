import { getFirebaseFirestore } from './firebase-client.js';

const portfolioNote = document.querySelector('.portfolio-note');
let cloudRuntimePromise = null;
let stopPublicProjects = null;

async function getCloudRuntime() {
  if (!cloudRuntimePromise) {
    cloudRuntimePromise = (async () => {
      const [{ db, api: firestore, offlineCacheMode }, offline] = await Promise.all([
        getFirebaseFirestore(),
        import('./offline-sync.mjs')
      ]);
      const {
        collection, doc, enableNetwork, getDocsFromServer, onSnapshot, query,
        serverTimestamp, setDoc, waitForPendingWrites, where
      } = firestore;
      const publicProjects = query(collection(db, 'projects'), where('published', '==', true));

      offline.configureOfflineSync({ db, persistent: offlineCacheMode === 'persistent', enableNetwork, waitForPendingWrites });
      offline.setOfflineRetryHandler(async () => {
        await enableNetwork(db);
        await waitForPendingWrites(db);
        await getDocsFromServer(publicProjects);
      });

      window.YJCloud = {
        async submitBooking(booking) {
          if (offline.isActuallyOfflineHint() && offlineCacheMode !== 'persistent') {
            throw new Error('Enable persistent Firestore storage on a trusted personal device or reconnect before submitting this request. The WhatsApp message is still available.');
          }
          const reference = doc(collection(db, 'bookingRequests'));
          const committed = offline.trackFirestoreWrite(`booking:${reference.id}`, setDoc(reference, {
            ...booking,
            status: 'new',
            createdAt: serverTimestamp()
          }));
          return { id: reference.id, committed };
        }
      };

      return { db, firestore, offline, publicProjects, onSnapshot };
    })().catch((error) => {
      cloudRuntimePromise = null;
      throw error;
    });
  }
  return cloudRuntimePromise;
}

export async function initializeCloudFeatures() {
  try { await getCloudRuntime(); }
  catch (error) {
    if (portfolioNote) portfolioNote.textContent = 'Firebase booking inbox needs its SDK modules and an internet connection at least once.';
    window.YJOffline?.setFailure('Firebase could not initialize. Previously cached public app files may still open.');
    console.error('YJ Studios cloud features could not start:', error);
    throw error;
  }
}

function normalizePublicProject(entry) {
  const data = entry.data();
  const mediaUrl = data.fileUrl || data.mediaUrl || data.externalUrl || data.videoUrl || data.audioUrl || data.downloadURL || data.url || '';
  const createdAt = data.createdAt?.toMillis?.()
    || (typeof data.createdAt === 'number' ? data.createdAt : Date.parse(data.createdAt || '') || 0);
  return {
    ...data,
    id: entry.id,
    kind: data.mediaType || data.kind || '',
    mediaUrl,
    fileName: data.fileName || data.title || 'Portfolio media',
    caption: data.description || data.caption || '',
    externalUrl: data.externalUrl || data.videoUrl || '',
    coverUrl: data.thumbnailUrl || data.coverUrl || '',
    artist: data.artist || '',
    credits: data.credits || '',
    tags: Array.isArray(data.tags) ? data.tags : (typeof data.tags === 'string' ? data.tags.split(',').map((tag) => tag.trim()).filter(Boolean) : []),
    size: data.size || 0,
    sortOrder: Number.isFinite(data.sortOrder) ? data.sortOrder : (Number.isFinite(data.order) ? data.order : undefined),
    createdAt
  };
}

async function renderSnapshot(snapshot, offline) {
  offline.observeFirestoreSnapshot('public-projects', snapshot);
  const records = snapshot.docs.map(normalizePublicProject)
    .filter((record) => record.deleted !== true && ['audio', 'video', 'image'].includes(record.kind)
      && record.mediaUrl && /^https:\/\//i.test(record.mediaUrl)
      && !/example\.com|placeholder/i.test(record.mediaUrl))
    .sort((a, b) => b.createdAt - a.createdAt);
  const fromCache = Boolean(snapshot.metadata?.fromCache);
  const emptyMessage = fromCache
    ? (snapshot.size ? 'Previously synchronized projects are shown. Connect to confirm the latest portfolio.' : 'No previously synchronized public projects are available offline. Connect to load Studio Work.')
    : (snapshot.size ? 'Published records were synchronized, but none contain supported media details.' : 'No published studio work yet.');

  await window.YJPortfolio?.renderRemoteProjects(records, { fromCache, emptyMessage });
  if (fromCache) {
    if (portfolioNote) portfolioNote.textContent = snapshot.size
      ? 'Showing the previously synchronized portfolio saved on this device. It may be out of date.'
      : 'No saved public projects are available offline on this device.';
    window.YJOffline?.noteCachedData();
  } else if (!snapshot.size) {
    if (portfolioNote) portfolioNote.textContent = 'Published studio work will appear here as projects are added.';
  } else if (!records.length) {
    if (portfolioNote) portfolioNote.textContent = 'Published project records need valid media details.';
  } else {
    if (portfolioNote) portfolioNote.textContent = 'Audio, video, and image projects from YJ Studios.';
    if (records.length < snapshot.size) portfolioNote.textContent += ` ${snapshot.size - records.length} published record(s) need valid media details.`;
  }
}

export async function startPublicProjects() {
  if (stopPublicProjects) return;
  try {
    const runtime = await getCloudRuntime();
    // The section can leave view while the SDK modules are being fetched.
    if (!window.YJWorkSectionActive || stopPublicProjects) return;
    stopPublicProjects = runtime.onSnapshot(runtime.publicProjects, { includeMetadataChanges: true },
      (snapshot) => renderSnapshot(snapshot, runtime.offline),
      (error) => {
        const code = String(error?.code || 'unknown');
        const detail = code === 'permission-denied'
          ? 'Public project reads were denied. Check the deployed Firestore rules.'
          : code === 'unavailable'
            ? 'Firebase is unreachable. Previously synchronized projects remain available if this device has persistent storage enabled.'
            : `Firebase returned ${code}. The studio owner can check the project setup.`;
        if (portfolioNote) portfolioNote.textContent = detail;
        window.YJOffline?.setFailure(detail);
        window.YJPortfolio?.showError(`Studio work could not load. ${detail}`);
        console.error('YJ Studios portfolio could not load:', error);
      });
  } catch (error) {
    if (portfolioNote) portfolioNote.textContent = 'Firebase portfolio data needs its SDK modules and an internet connection at least once.';
    window.YJOffline?.setFailure('Firebase could not initialize. Previously cached public app files may still open.');
    window.YJPortfolio?.showError('Studio work could not connect to its project library.');
    console.error('YJ Studios cloud features could not start:', error);
  }
}

export function stopPublicProjectListener() {
  stopPublicProjects?.();
  stopPublicProjects = null;
}
