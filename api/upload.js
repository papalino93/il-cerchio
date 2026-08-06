/* Endpoint di caricamento allegati (foto), identico nei due progetti.
   Riceve un'immagine come data URL già ridimensionata dal browser (vedi
   app.js) e la salva su Vercel Blob, restituendo l'URL pubblico da
   allegare al compito. Stesso modello di sicurezza del resto dell'app:
   nessun account, l'URL della foto è imprevedibile quanto il codice
   della stanza, e solo chi è già membro può caricare qualcosa. */
const { put } = require('@vercel/blob');

const CODE_RE = /^[a-z0-9]{4,24}$/i;
const MAX_BYTES = 6 * 1024 * 1024; // già ridimensionata lato client: 6MB è abbondante

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const code = String(body.code || '').trim().toLowerCase();
  if (!CODE_RE.test(code)) {
    res.status(400).json({ error: 'invalid_code' });
    return;
  }

  // Chi carica deve avere già un id membro plausibile: non basta a
  // provare l'appartenenza (per quello serve il codice, che è già il
  // segreto condiviso), ma tiene fuori i caricamenti anonimi random.
  const memberId = String(body.memberId || '');
  if (!/^m_[a-z0-9]+$/i.test(memberId)) {
    res.status(403).json({ error: 'not_a_member' });
    return;
  }

  const dataUrl = String(body.dataUrl || '');
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([a-zA-Z0-9+/=]+)$/.exec(dataUrl);
  if (!match) {
    res.status(400).json({ error: 'invalid_image' });
    return;
  }
  const contentType = match[1];
  const ext = contentType === 'image/png' ? 'png' : contentType === 'image/webp' ? 'webp' : 'jpg';
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > MAX_BYTES) {
    res.status(413).json({ error: 'too_large' });
    return;
  }

  const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const pathname = `attachments/${code}/${stamp}.${ext}`;
  const blob = await put(pathname, buffer, {
    access: 'public',
    contentType,
    addRandomSuffix: false,
  });

  res.status(200).json({ url: blob.url });
};
