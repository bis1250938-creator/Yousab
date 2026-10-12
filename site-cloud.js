const portfolioNote = document.querySelector('.portfolio-note');

async function startCloudFeatures() {
  try {
    const [{ db }, firestore] = await Promise.all([
      import('./firebase-client.js'),
      import('https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js')
    ]);
    const { addDoc, collection, onSnapshot, query, serverTimestamp, where } = firestore;

    window.YJCloud = {
      async submitBooking(booking) {
        const result = await addDoc(collection(db, 'bookingRequests'), {
          ...booking,
          status: 'new',
          createdAt: serverTimestamp()
        });
        return result.id;
      }
    };

    const publicProjects = query(
      collection(db, 'projects'),
      where('published', '==', true)
    );

    onSnapshot(publicProjects, async (snapshot) => {
      const records = snapshot.docs.map((entry) => {
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
      }).filter((record) => ['audio', 'video', 'image'].includes(record.kind)
        && record.mediaUrl
        && /^https:\/\//i.test(record.mediaUrl)
        && !/example\.com|placeholder/i.test(record.mediaUrl))
        .sort((a, b) => b.createdAt - a.createdAt);
      if (window.YJPortfolio?.renderRemoteProjects) {
        await window.YJPortfolio.renderRemoteProjects(records);
        if (!snapshot.size) {
          if (portfolioNote) portfolioNote.textContent = 'Published studio work will appear here as projects are added.';
        } else if (!records.length) {
          const message = 'Published projects were found, but their media URL or media type is missing or invalid. Edit the project while signed in and save a valid HTTPS media URL.';
          window.YJPortfolio.showStatus?.(message);
          if (portfolioNote) portfolioNote.textContent = 'Some published project records need valid media details.';
        } else {
          if (portfolioNote) portfolioNote.textContent = 'Audio, video, and image projects from YJ Studios.';
          if (records.length < snapshot.size) portfolioNote.textContent += ` ${snapshot.size - records.length} published record(s) need valid media details.`;
        }
      }
    }, (error) => {
      const code = String(error?.code || 'unknown');
      const detail = code === 'permission-denied'
        ? 'Public project reads were denied. Check the deployed Firestore rules.'
        : code === 'unavailable'
          ? 'Firebase is temporarily unreachable. Check the connection and refresh.'
          : `Firebase returned ${code}. The studio owner can check the project setup.`;
      if (portfolioNote) portfolioNote.textContent = detail;
      window.YJPortfolio?.showError(`Studio work could not load. ${detail}`);
      console.error('YJ Studios portfolio could not load:', error);
    });
  } catch (error) {
    if (portfolioNote) portfolioNote.textContent = 'Online gallery and booking inbox need the exact Firebase Web app settings and an internet connection.';
    window.YJPortfolio?.showError('Studio work could not connect to its project library.');
    console.error('YJ Studios cloud features could not start:', error);
  }
}

startCloudFeatures();

