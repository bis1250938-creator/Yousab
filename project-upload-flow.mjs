/**
 * Keeps a selected media upload tied to one stable project ID. Uploads start as
 * soon as a file is selected; a later Save/Publish action can await the same
 * work instead of starting a duplicate transfer.
 */
export function createProjectUploadFlow({ upload, getResumeProjectId = () => '', createProjectId }) {
  if (typeof upload !== 'function' || typeof createProjectId !== 'function') {
    throw new TypeError('Project upload flow requires upload and createProjectId functions.');
  }

  let current = null;

  function sameFile(left, right) {
    return left === right || Boolean(left && right
      && left.name === right.name
      && left.size === right.size
      && left.lastModified === right.lastModified);
  }

  function run(entry) {
    entry.status = 'uploading';
    entry.error = null;
    let operation;
    try {
      operation = upload({ file: entry.file, kind: entry.kind, projectId: entry.projectId });
    } catch (error) {
      operation = Promise.reject(error);
    }
    entry.promise = Promise.resolve(operation).then((result) => {
      entry.result = result;
      entry.status = 'complete';
      return result;
    }, (error) => {
      entry.error = error;
      entry.status = 'failed';
      throw error;
    });
    // A failed automatic upload is reported in the UI and can be retried from
    // Save/Publish. Keep its rejection handled until that action awaits it.
    entry.promise.catch(() => {});
    return entry.promise;
  }

  return {
    start(file, kind) {
      if (!file || typeof kind !== 'string' || !kind) throw new TypeError('A media file and type are required.');
      if (sameFile(current?.file, file)) {
        if (current.status === 'uploading') return current.promise;
        if (current.status === 'complete') return Promise.resolve(current.result);
        current.kind = kind;
        return run(current);
      }

      current = {
        file,
        kind,
        projectId: getResumeProjectId(file) || createProjectId(),
        status: 'ready',
        result: null,
        error: null,
        promise: null
      };
      return run(current);
    },

    state(file) {
      return !file || sameFile(current?.file, file) ? current : null;
    },

    clear(file) {
      if (!file || sameFile(current?.file, file)) current = null;
    },

    markRetryable(file, error = new Error('The upload was cleaned up and can be retried.')) {
      if (!sameFile(current?.file, file)) return null;
      current.status = 'failed';
      current.result = null;
      current.error = error;
      current.promise = null;
      return current;
    }
  };
}
