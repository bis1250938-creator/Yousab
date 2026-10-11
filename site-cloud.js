const portfolioNote = document.querySelector('.portfolio-note');

async function startCloudFeatures() {
  try {
    const [{ db }, firestore] = await Promise.all([
      import('./firebase-client.js'),
      import('https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js')
    ]);
    const { addDoc, collection, onSnapshot, orderBy, query, serverTimestamp, where } = firestore;

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
      where('published', '==', true),
      orderBy('createdAt', 'desc')
    );

    onSnapshot(publicProjects, async (snapshot) => {
      const records = snapshot.docs.map((entry) => {
        const data = entry.data();
        return {
          ...data,
          id: entry.id,
          createdAt: data.createdAt?.toMillis?.() || Date.now()
        };
      });
      if (window.YJPortfolio?.renderRemoteProjects) {
        await window.YJPortfolio.renderRemoteProjects(records);
        if (portfolioNote) portfolioNote.textContent = 'Audio, video, and image projects from YJ Studios.';
      }
    }, (error) => {
      if (portfolioNote) portfolioNote.textContent = 'The cloud gallery is unavailable. The studio owner can check Firebase setup.';
      console.error('YJ Studios portfolio could not load:', error);
    });
  } catch (error) {
    if (portfolioNote) portfolioNote.textContent = 'Online gallery and booking inbox need the exact Firebase Web app settings and an internet connection.';
    console.error('YJ Studios cloud features could not start:', error);
  }
}

startCloudFeatures();
