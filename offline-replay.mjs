import { unreferencedUploadedKeys } from './project-upload-policy.mjs';

export const SERVER_TIMESTAMP_RECOVERY_MARKER = '__YJ_SERVER_TIMESTAMP__';

function restoreServerTimestamp(value, serverTimestamp) {
  if (value === SERVER_TIMESTAMP_RECOVERY_MARKER) return serverTimestamp();
  if (Array.isArray(value)) return value.map((entry) => restoreServerTimestamp(entry, serverTimestamp));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, restoreServerTimestamp(entry, serverTimestamp)]));
  }
  return value;
}

function fieldsMatch(expected, current) {
  return Object.entries(expected || {}).every(([key, value]) => value === SERVER_TIMESTAMP_RECOVERY_MARKER
    || JSON.stringify(current?.[key]) === JSON.stringify(value));
}

function projectR2Paths(data, ownerUid) {
  return [data.mediaPath || data.filePath || data.storagePath, data.coverPath || data.thumbnailPath, data.beforePath, data.afterPath, data.imagePath]
    .filter((path) => typeof path === 'string' && path.startsWith(`portfolio/${ownerUid}/`));
}

function conflict(message) {
  const error = new Error(message);
  error.code = 'offline/conflict';
  return error;
}

export async function replayOfflineProjectChanges(operations, { ownerUid, firestore, remove, cleanupMedia, onCreateRecovered }) {
  let completed = 0;
  const skippedIds = new Set();
  for (let index = 0; index < operations.length; index++) {
    const operation = operations[index];
    if (skippedIds.has(operation.id)) continue;
    const reference = firestore.doc(firestore.db, 'projects', operation.docId);
    const serverSnapshot = await firestore.getDocFromServer(reference);
    const exists = serverSnapshot.exists();
    const serverData = exists ? serverSnapshot.data() : null;

    if (operation.type === 'orphan-media-cleanup') {
      if (operation.ownerUid !== ownerUid) {
        throw conflict(`Uploaded media cleanup ${operation.docId} belongs to a different owner. Its recovery record was retained.`);
      }
      if (typeof cleanupMedia !== 'function') {
        throw conflict(`Uploaded media cleanup ${operation.docId} needs the authorized R2 connection. Its recovery record was retained.`);
      }
      const keys = unreferencedUploadedKeys(serverSnapshot, operation.keys, ownerUid);
      if (keys.length) await cleanupMedia(keys);
      await remove(operation.id);
      completed++;
      continue;
    }

    if (operation.type === 'create') {
      if (exists) {
        if (serverData.ownerUid === ownerUid && fieldsMatch(operation.data, serverData)) {
          await onCreateRecovered?.(operation);
          await remove(operation.id);
          completed++;
          continue;
        }
        const laterAppliedEdit = operations.slice(index + 1).some((candidate) => candidate.docId === operation.docId
          && candidate.type === 'update' && candidate.data?.revision === serverData.revision
          && fieldsMatch(candidate.data, serverData));
        if (serverData.ownerUid === ownerUid && laterAppliedEdit) {
          await onCreateRecovered?.(operation);
          await remove(operation.id);
          completed++;
          continue;
        }
        throw conflict(`Saved project ${operation.docId} exists with different server data. Its local copy remains for review.`);
      }
      const laterFinalizerIndex = operations.findIndex((candidate, candidateIndex) => candidateIndex > index
        && candidate.docId === operation.docId && candidate.type === 'finalize-delete');
      if (laterFinalizerIndex >= 0) {
        const finalizer = operations[laterFinalizerIndex];
        const createdWithR2 = projectR2Paths(operation.data, ownerUid).length > 0;
        if (!createdWithR2 || finalizer.r2CleanupConfirmed === true) {
          for (const candidate of operations.slice(index, laterFinalizerIndex + 1)) {
            if (candidate.docId !== operation.docId) continue;
            await remove(candidate.id);
            skippedIds.add(candidate.id);
            completed++;
          }
          continue;
        }
      }
      await firestore.setDoc(reference, restoreServerTimestamp(operation.data, firestore.serverTimestamp));
      await onCreateRecovered?.(operation);
      await remove(operation.id);
      completed++;
      continue;
    }

    if (operation.type === 'finalize-delete') {
      if (!exists) { await remove(operation.id); completed++; continue; }
      const currentRevision = Number.isSafeInteger(serverData.revision) ? serverData.revision : 0;
      if (serverData.ownerUid !== ownerUid || serverData.deleted !== true || currentRevision !== operation.expectedRevision
        || (projectR2Paths(serverData, ownerUid).length && operation.r2CleanupConfirmed !== true)) {
        throw conflict(`Project ${operation.docId} is no longer the same confirmed deletion. Its recovery record remains for review.`);
      }
      await firestore.deleteDoc(reference);
      await remove(operation.id);
      completed++;
      continue;
    }

    if (operation.type !== 'update') throw conflict(`Unknown saved project operation “${operation.type}”; its recovery record was retained.`);
    if (!exists) throw conflict(`Project ${operation.docId} no longer exists. Its saved offline edit was retained.`);
    if (serverData.ownerUid !== ownerUid) throw conflict(`Project ${operation.docId} is not owned by this account. Its saved change was retained.`);
    const currentRevision = Number.isSafeInteger(serverData.revision) ? serverData.revision : 0;
    const targetRevision = operation.data.revision;
    if (currentRevision === targetRevision && fieldsMatch(operation.data, serverData)) {
      await remove(operation.id);
      completed++;
      continue;
    }
    const laterAppliedEdit = operations.slice(index + 1).some((candidate) => candidate.docId === operation.docId
      && candidate.type === 'update' && candidate.data?.revision === currentRevision
      && fieldsMatch(candidate.data, serverData));
    if (laterAppliedEdit) {
      await remove(operation.id);
      completed++;
      continue;
    }
    if (currentRevision !== operation.expectedRevision || serverData.deleted === true) {
      throw conflict(`Project ${operation.docId} changed on the server while this device was offline. Its saved edit remains for review; reload and compare before reapplying.`);
    }
    await firestore.updateDoc(reference, restoreServerTimestamp(operation.data, firestore.serverTimestamp));
    await remove(operation.id);
    completed++;
  }
  return completed;
}
