/**
 * Decide which completed R2 objects are safe to remove after a Firestore
 * create failed or its acknowledgement was lost. A server read is required;
 * cached data is never sufficient for deleting media.
 */
export function unreferencedUploadedKeys(snapshot, uploadedKeys, ownerUid) {
  if (!snapshot || typeof snapshot.exists !== 'function') {
    throw new Error('A server-confirmed Firestore project read is required before upload cleanup.');
  }

  const keys = [...new Set(uploadedKeys || [])];
  if (keys.some((key) => typeof key !== 'string' || !key.startsWith(`portfolio/${ownerUid}/`))) {
    throw new Error('The upload contains an unexpected storage path; files were preserved.');
  }
  if (!snapshot.exists()) return keys;

  const project = snapshot.data() || {};
  if (project.ownerUid !== ownerUid) {
    throw new Error('The server project ID is occupied by another identity; uploaded files were preserved.');
  }

  const referenced = new Set([
    project.mediaPath, project.filePath, project.storagePath,
    project.coverPath, project.thumbnailPath, project.beforePath,
    project.afterPath, project.imagePath
  ].filter((path) => typeof path === 'string' && path));

  return keys.filter((key) => !referenced.has(key));
}
