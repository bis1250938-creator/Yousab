const DATABASE_NAME = 'yj-studios-offline-recovery';
const DATABASE_VERSION = 1;
const STORE_NAME = 'rejected-project-writes';

let databasePromise;

function openDatabase() {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) { reject(new Error('IndexedDB is unavailable.')); return; }
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        const store = request.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('sequence', 'sequence');
      }
      if (!request.result.objectStoreNames.contains('metadata')) request.result.createObjectStore('metadata');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open offline recovery storage.'));
    request.onblocked = () => reject(new Error('Offline recovery storage is blocked by another open tab.'));
  }).catch((error) => { databasePromise = null; throw error; });
  return databasePromise;
}

async function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Offline recovery storage failed.'));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('Offline recovery transaction failed.'));
    transaction.onabort = () => reject(transaction.error || new Error('Offline recovery transaction was aborted.'));
  });
}

export async function saveRejectedProjectWrite(operation) {
  const database = await openDatabase();
  const record = {
    ...operation,
    id: operation.id || crypto.randomUUID(),
    createdAt: Number(operation.createdAt) || Date.now(),
    lastError: String(operation.lastError || '')
  };
  const transaction = database.transaction([STORE_NAME, 'metadata'], 'readwrite');
  const completed = transactionDone(transaction);
  try {
    const storedId = await new Promise((resolve, reject) => {
      const metadata = transaction.objectStore('metadata');
      const sequenceRequest = metadata.get('write-sequence');
      sequenceRequest.onsuccess = () => {
        record.sequence = (Number(sequenceRequest.result) || 0) + 1;
        metadata.put(record.sequence, 'write-sequence');
        const putRequest = transaction.objectStore(STORE_NAME).put(record);
        putRequest.onsuccess = () => resolve(record.id);
        putRequest.onerror = () => reject(putRequest.error || new Error('Could not save offline recovery data.'));
      };
      sequenceRequest.onerror = () => reject(sequenceRequest.error || new Error('Could not allocate a recovery sequence.'));
    });
    await completed;
    return storedId;
  } catch (error) {
    await completed.catch(() => {});
    throw error;
  }
}

export async function listRejectedProjectWrites() {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readonly');
  const records = await requestResult(transaction.objectStore(STORE_NAME).getAll());
  return records.sort((a, b) => a.sequence - b.sequence);
}

export async function removeRejectedProjectWrite(id) {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  const completed = transactionDone(transaction);
  try {
    await requestResult(transaction.objectStore(STORE_NAME).delete(id));
    await completed;
  } catch (error) {
    await completed.catch(() => {});
    throw error;
  }
}

export async function countRejectedProjectWrites() {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readonly');
  return requestResult(transaction.objectStore(STORE_NAME).count());
}

export async function markRejectedProjectWrite(id, message) {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  const completed = transactionDone(transaction);
  const store = transaction.objectStore(STORE_NAME);
  const request = store.get(id);
  try {
    await new Promise((resolve, reject) => {
      request.onsuccess = () => {
        if (!request.result) { resolve(); return; }
        const existing = request.result;
        existing.lastError = String(message || '');
        const put = store.put(existing);
        put.onsuccess = () => resolve();
        put.onerror = () => reject(put.error || new Error('Could not update recovery status.'));
      };
      request.onerror = () => reject(request.error || new Error('Could not read recovery status.'));
    });
    await completed;
  } catch (error) {
    await completed.catch(() => {});
    throw error;
  }
}
