// Borra los archivos finales de un posteo después de publicarlo.
//
// Una vez que Instagram descargó el archivo ya no hace falta guardarlo, y el espacio gratis es
// poco (1 GB en Vercel Blob y en Supabase). Cada archivo se borra donde vive, según su URL:
// así funciona igual con lo subido antes de cambiar de almacenamiento.
//
// Para que esto sea seguro, un archivo no puede estar en dos posteos: por eso las copias de
// posteos, días y semanas no se llevan los archivos (ver copiaSinProgramar en index.html).

const { del } = require('@vercel/blob');
const { SUPABASE_URL, cabeceras } = require('./acceso');
const { r2Configurado, prefirmar } = require('./r2');

async function borrarArchivos(lista) {
  const urls = lista.filter(m => m && m.url).map(m => m.url);
  const errores = [];

  // Vercel Blob: se borran todos en un solo pedido.
  const deBlob = urls.filter(u => /\.blob\.vercel-storage\.com\//.test(u));
  if (deBlob.length && process.env.BLOB_READ_WRITE_TOKEN) {
    try { await del(deBlob); } catch (e) { errores.push('Blob: ' + e.message); }
  }

  // Supabase: la ruta es lo que sigue a /object/public/medios/ en la URL.
  const supa = SUPABASE_URL ? SUPABASE_URL + '/storage/v1/object/public/medios/' : null;
  for (const u of urls.filter(u => supa && u.startsWith(supa))) {
    const r = await fetch(`${SUPABASE_URL}/storage/v1/object/medios/${u.slice(supa.length)}`, {
      method: 'DELETE', headers: cabeceras()
    }).catch(e => ({ ok: false, status: e.message }));
    if (!r.ok && r.status !== 404 && r.status !== 400) errores.push('Supabase: ' + r.status);
  }

  // R2: con una URL prefirmada para DELETE, igual que la de subida.
  const publica = String(process.env.R2_PUBLIC_URL || '').replace(/\/+$/, '');
  for (const u of urls.filter(u => publica && r2Configurado() && u.startsWith(publica + '/'))) {
    const url = prefirmar({
      metodo: 'DELETE',
      host: `${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      ruta: `/${process.env.R2_BUCKET}/${u.slice(publica.length + 1)}`,
      region: 'auto',
      clave: process.env.R2_ACCESS_KEY_ID,
      secreto: process.env.R2_SECRET_ACCESS_KEY,
      segundos: 300
    });
    const r = await fetch(url, { method: 'DELETE' }).catch(e => ({ ok: false, status: e.message }));
    if (!r.ok && r.status !== 404) errores.push('R2: ' + r.status);
  }

  return errores.length ? { error: errores.join(' · ') } : { ok: true };
}

module.exports = { borrarArchivos };
