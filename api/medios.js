// Archivos finales de cada posteo: el video del reel, las imágenes del carrusel, la story.
//
// Instagram no recibe archivos: recibe un link público y lo descarga él. Así que cada
// archivo tiene que vivir en algún lado con dirección propia, y ese lado es Supabase Storage,
// la misma cuenta que ya guarda los datos. El plan gratis trae 1 GB y no suma otro servicio.
//
// El archivo NO pasa por esta función: Vercel corta los cuerpos de más de 4,5 MB y un reel
// pesa bastante más. Acá solo se firma un permiso de subida para una ruta puntual, y el
// navegador sube directo a Supabase con ese permiso. La service_key nunca sale del servidor.
//
// Las rutas empiezan con la marca ("marca/2026-10/abc123.jpg"): es lo que permite verificar
// al borrar que nadie toque archivos de otra marca, con el mismo criterio que lib/acceso.js.

const { SUPABASE_URL, SERVICE_KEY, cabeceras, resolverToken, codigoAlAzar } = require('../lib/acceso');

const BUCKET = 'medios';
const STORAGE = () => SUPABASE_URL + '/storage/v1';

// Solo los formatos que Instagram acepta por API. Las imágenes llegan siempre como JPEG
// porque el navegador las convierte antes de subirlas: un PNG o un WebP los rechaza.
const EXTENSIONES = { 'image/jpeg': 'jpg', 'video/mp4': 'mp4', 'video/quicktime': 'mov' };

// La carpeta de la marca sale de la sesión, nunca de lo que mande el navegador. El
// administrador no tiene marca propia: usa la del calendario que tiene abierto.
function carpetaDe(sesion, cliente) {
  if (sesion.rol !== 'admin') return sesion.slug;
  const limpio = String(cliente || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
  return limpio || 'general';
}

// El bucket se crea solo la primera vez. Público a propósito: Instagram necesita poder
// bajar el archivo sin credenciales. Los nombres llevan una parte al azar, así que no se
// pueden adivinar ni listar desde afuera.
async function asegurarBucket() {
  const r = await fetch(STORAGE() + '/bucket/' + BUCKET, { headers: cabeceras() });
  if (r.ok) return;
  const c = await fetch(STORAGE() + '/bucket', {
    method: 'POST',
    headers: cabeceras(),
    body: JSON.stringify({ id: BUCKET, name: BUCKET, public: true })
  });
  // 409 = otra llamada lo creó mientras tanto: el resultado es el mismo.
  if (!c.ok && c.status !== 409) throw new Error('No se pudo crear el bucket (' + c.status + ')');
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Usá POST.' });
  }
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return res.status(500).json({ error: 'Faltan SUPABASE_URL o SUPABASE_SERVICE_KEY en Vercel.' });
  }

  const cuerpo = req.body || {};
  let sesion;
  try { sesion = await resolverToken(cuerpo.token); }
  catch (e) { return res.status(502).json({ error: 'No se pudo verificar el acceso.' }); }
  if (!sesion) return res.status(401).json({ error: 'Link inválido o dado de baja.' });

  try {
    if (cuerpo.accion === 'firmar') {
      const ext = EXTENSIONES[cuerpo.tipo];
      if (!ext) return res.status(400).json({ error: 'Formato no admitido. Usá JPG, MP4 o MOV.' });

      await asegurarBucket();
      const mes = new Date().toISOString().slice(0, 7);
      const ruta = `${carpetaDe(sesion, cuerpo.cliente)}/${mes}/${codigoAlAzar(16)}.${ext}`;

      const r = await fetch(`${STORAGE()}/object/upload/sign/${BUCKET}/${ruta}`, {
        method: 'POST', headers: cabeceras(), body: '{}'
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j || !j.url) throw new Error((j && (j.message || j.error)) || 'http ' + r.status);

      return res.status(200).json({
        subida: STORAGE() + j.url,
        url: `${STORAGE()}/object/public/${BUCKET}/${ruta}`,
        ruta
      });
    }

    if (cuerpo.accion === 'borrar') {
      const ruta = String(cuerpo.ruta || '');
      // La ruta tiene que ser exactamente de la forma que arma "firmar", y de esta marca.
      // Sin el chequeo de forma, un "../" podría salirse de la carpeta.
      if (!/^[a-z0-9-]+\/\d{4}-\d{2}\/[a-z0-9]+\.(jpg|mp4|mov)$/.test(ruta)) {
        return res.status(400).json({ error: 'Ruta inválida.' });
      }
      if (sesion.rol !== 'admin' && !ruta.startsWith(sesion.slug + '/')) {
        return res.status(403).json({ error: 'Ese archivo no es de esta marca.' });
      }
      const r = await fetch(`${STORAGE()}/object/${BUCKET}/${ruta}`, {
        method: 'DELETE', headers: cabeceras()
      });
      // Si ya no estaba, el objetivo se cumplió igual.
      if (!r.ok && r.status !== 404 && r.status !== 400) throw new Error('http ' + r.status);
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Acción desconocida.' });
  } catch (e) {
    return res.status(502).json({ error: 'Error con el almacenamiento de archivos: ' + e.message });
  }
};
