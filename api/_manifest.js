/* Motore condiviso tra Il Cerchio e I Compiti: questo file è identico nei
   due progetti. api/manifest.js lo importa passando solo il nome dell'app.
   Se lo modifichi, copialo nell'altro repo invece di ripetere la modifica
   a mano. */

/* Il manifest statico (/manifest.json) ha per forza start_url "/", senza
   il codice dello spazio: chi salva l'app nella schermata Home e poi la
   apre da lì riparte da una pagina che non sa a quale gruppo appartiene.
   Se i dati locali nel frattempo si sono persi (succede spesso quando il
   link è stato aperto dentro il browser di WhatsApp), l'app propone di
   creare un gruppo nuovo invece di riaprire quello di sempre.

   Qui il manifest viene generato con il codice dentro start_url, così
   l'icona in Home riapre sempre lo spazio giusto — anche a memoria
   locale svuotata. Il client punta a questo indirizzo appena sa il
   codice (vedi applyManifest() in app.js). */

const CODE_RE = /^[a-z0-9]{4,24}$/i;

function createHandler(name) {
  return (req, res) => {
    const raw = String((req.query && req.query.r) || '').trim().toLowerCase();
    const code = CODE_RE.test(raw) ? raw : '';
    const start = code ? `/?r=${encodeURIComponent(code)}` : '/';

    // Il manifest cambia da uno spazio all'altro, quindi non va messo in
    // una cache condivisa; un po' di cache privata evita però di
    // rigenerarlo a ogni apertura sullo stesso telefono.
    res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.status(200).send(JSON.stringify({
      // id distinto per spazio: due gruppi diversi restano due app
      // installate diverse, invece di sovrascriversi a vicenda.
      id: start,
      name,
      short_name: name,
      start_url: start,
      scope: '/',
      display: 'standalone',
      background_color: '#F3F0E9',
      theme_color: '#1C3A2E',
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
      ],
    }));
  };
}

module.exports = { createHandler };
