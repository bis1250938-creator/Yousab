// Storage provider boundary. Replace this module when switching to another
// provider; the portfolio and Firestore record format stay provider-neutral.
export const MAX_MEDIA_BYTES = 250 * 1024 * 1024; // Application limit, not a Firebase quota.
export const MAX_COVER_BYTES = 20 * 1024 * 1024; // Application limit, not a Firebase quota.

const extensions = {
  audio: new Set(['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'opus', 'webm']),
  video: new Set(['mp4', 'webm', 'm4v', 'ogv']),
  image: new Set(['jpg', 'jpeg', 'png', 'webp', 'avif', 'gif'])
};
const mimeTypes = {
  audio: new Set(['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/ogg', 'audio/flac', 'audio/x-flac', 'audio/opus', 'audio/webm']),
  video: new Set(['video/mp4', 'video/webm', 'video/ogg']),
  image: new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif'])
};
const canonicalMimeTypes = {
  audio: { mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', flac: 'audio/flac', opus: 'audio/opus', webm: 'audio/webm' },
  video: { mp4: 'video/mp4', webm: 'video/webm', m4v: 'video/mp4', ogv: 'video/ogg' },
  image: { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', avif: 'image/avif', gif: 'image/gif' }
};

export function contentTypeForMedia(file, kind) {
  const extension = file?.name?.split('.').pop()?.toLowerCase() || '';
  const canonical = canonicalMimeTypes[kind]?.[extension];
  if (canonical) return canonical;
  const supplied = file?.type?.toLowerCase() || '';
  if (mimeTypes[kind]?.has(supplied)) return supplied;
  throw new Error(`Could not determine a supported ${kind} content type for this file.`);
}

export function validateMediaFile(file, kind, maxBytes = MAX_MEDIA_BYTES) {
  const extension = file?.name?.split('.').pop()?.toLowerCase() || '';
  if (!file || !extensions[kind]?.has(extension)) {
    throw new Error('Use MP3/WAV/M4A/AAC/OGG/FLAC/Opus, MP4/WebM, or JPEG/PNG/WebP/AVIF/GIF files. MOV is not accepted because playback varies by browser.');
  }
  if (file.type && !mimeTypes[kind]?.has(file.type.toLowerCase())) {
    throw new Error(`The selected ${kind} file has an unsupported MIME type (${file.type}). Choose a file whose extension and actual media type match.`);
  }
  if (file.size > maxBytes) throw new Error(`The selected file exceeds this app’s ${Math.round(maxBytes / 1024 / 1024)} MB upload limit.`);
}

export function createFirebaseStorageProvider({ app, bucket, api }) {
  if (!app || !bucket || !api) throw new Error('Firebase Storage is not configured.');
  const storage = api.getStorage(app, bucket);
  return {
    upload(path, file, kind, onProgress) {
      validateMediaFile(file, kind, MAX_MEDIA_BYTES);
      return new Promise((resolve, reject) => {
        // Storage Rules check the stored MIME value. Normalize browser aliases
        // (and empty MIME values) to the canonical type allowed by those rules.
        const task = api.uploadBytesResumable(api.ref(storage, path), file, { contentType: contentTypeForMedia(file, kind) });
        task.on('state_changed', (snapshot) => onProgress?.(Math.round(snapshot.bytesTransferred / Math.max(1, snapshot.totalBytes) * 100)), reject, async () => {
          try { resolve(await api.getDownloadURL(task.snapshot.ref)); }
          catch (error) {
            try { await api.deleteObject(api.ref(storage, path)); } catch {}
            reject(error);
          }
        });
      });
    },
    async delete(path) {
      try { await api.deleteObject(api.ref(storage, path)); }
      catch (error) { if (error.code !== 'storage/object-not-found') throw error; }
    }
  };
}
