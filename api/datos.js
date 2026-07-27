// Única puerta de entrada a los datos del calendario.
//
// Antes el navegador hablaba directo con Supabase usando una clave pública incrustada en la
// página. Eso hacía que el ?cliente= de la URL fuera decorativo: cualquiera podía pedirle a
// la base los datos de otra marca desde la consola del navegador. Acá el servidor recibe el
// token del link, resuelve a qué marca corresponde y SOLO devuelve o escribe claves de esa
// marca. La clave de la base nunca sale de Vercel.
//
// Variables de entorno necesarias (Vercel > Settings > Environment Variables):
//   SUPABASE_URL          https://xxxx.supabase.co
//   SUPABASE_SERVICE_KEY  la clave "service_role" de Supabase (secreta)

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const KV = () => SUPABASE_URL + '/rest/v1/kv';

// Clave donde vive el registro de marcas y sus tokens. Es la única que el servidor lee sin
// que nadie pueda pedirla: ningún token da acceso a ella.
const CLAVE_REGISTRO = '__marcas__';

const cabeceras = (extra) => Object.assign({
  apikey: SERVICE_KEY,
  Authorization: 'Bearer ' + SERVICE_KEY,
  'Content-Type': 'application/json'
}, extra || {});

// El registro cambia muy poco, así que se recuerda unos segundos por instancia para no
// leerlo en cada pedido. No se cachea más tiempo para que revocar un link tenga efecto casi
// inmediato en vez de quedar colgado varios minutos.
let registroCache = null;
let registroCacheHasta = 0;
const CACHE_MS = 10000;

async function leerRegistro() {
  if (registroCache && Date.now() < registroCacheHasta) return registroCache;
  const res = await fetch(`${KV()}?key=eq.${encodeURIComponent(CLAVE_REGISTRO)}&select=value`, {
    headers: cabeceras(), cache: 'no-store'
  });
  if (!res.ok) throw new Error('No se pudo leer el registro de marcas');
  const filas = await res.json();
  const registro = filas.length ? JSON.parse(filas[0].value) : { marcas: [], adminToken: '' };
  registroCache = registro;
  registroCacheHasta = Date.now() + CACHE_MS;
  return registro;
}

// Compara en tiempo constante para que no se pueda adivinar un token midiendo cuánto tarda
// la respuesta según cuántos caracteres acertó.
function igualSeguro(a, b) {
  const x = String(a || ''), y = String(b || '');
  if (x.length !== y.length) return false;
  let dif = 0;
  for (let i = 0; i < x.length; i++) dif |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return dif === 0;
}

async function resolverToken(token) {
  if (!token) return null;
  const registro = await leerRegistro();
  if (registro.adminToken && igualSeguro(token, registro.adminToken)) {
    return { rol: 'admin', slug: null, nombre: 'Administrador' };
  }
  const marca = (registro.marcas || []).find(m => igualSeguro(token, m.token));
  if (!marca) return null;
  return { rol: 'editor', slug: marca.slug, nombre: marca.nombre || marca.slug };
}

// Qué claves puede tocar cada quien. El admin, todas menos el registro (que se administra
// por otro camino). Una marca, únicamente las que empiezan con su propio prefijo.
function puedeAcceder(sesion, clave) {
  if (typeof clave !== 'string' || !clave) return false;
  if (clave === CLAVE_REGISTRO) return false;
  if (sesion.rol === 'admin') return true;
  return clave.startsWith(sesion.slug + ':');
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Usá POST.' });
  }
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return res.status(500).json({ error: 'Faltan SUPABASE_URL o SUPABASE_SERVICE_KEY en Vercel.' });
  }

  const { token, accion, key, keys, value } = req.body || {};

  let sesion;
  try {
    sesion = await resolverToken(token);
  } catch (e) {
    return res.status(502).json({ error: 'No se pudo verificar el acceso: ' + e.message });
  }
  if (!sesion) {
    // Mismo mensaje para token inexistente o mal escrito: no se le confirma a nadie que
    // "ese link existe pero no es tuyo".
    return res.status(401).json({ error: 'Link inválido o dado de baja.' });
  }

  try {
    if (accion === 'sesion') {
      return res.status(200).json({ rol: sesion.rol, slug: sesion.slug, nombre: sesion.nombre });
    }

    if (accion === 'get') {
      if (!puedeAcceder(sesion, key)) return res.status(403).json({ error: 'Sin acceso a ese dato.' });
      const r = await fetch(`${KV()}?key=eq.${encodeURIComponent(key)}&select=value`, {
        headers: cabeceras(), cache: 'no-store'
      });
      if (!r.ok) throw new Error('http ' + r.status);
      const filas = await r.json();
      return res.status(200).json({ value: filas.length ? filas[0].value : null });
    }

    if (accion === 'getMany') {
      const pedidas = Array.isArray(keys) ? keys : [];
      // Las que no le corresponden se descartan en silencio en vez de rechazar todo el
      // pedido: así un mes a caballo entre dos marcas no rompe la carga entera.
      const permitidas = pedidas.filter(k => puedeAcceder(sesion, k));
      if (permitidas.length === 0) return res.status(200).json({ values: {} });
      const lista = permitidas.map(k => '"' + String(k).replace(/"/g, '\\"') + '"').join(',');
      const r = await fetch(`${KV()}?key=in.(${lista})&select=key,value`, {
        headers: cabeceras(), cache: 'no-store'
      });
      if (!r.ok) throw new Error('http ' + r.status);
      const salida = {};
      (await r.json()).forEach(fila => { salida[fila.key] = fila.value; });
      return res.status(200).json({ values: salida });
    }

    if (accion === 'set') {
      if (!puedeAcceder(sesion, key)) return res.status(403).json({ error: 'Sin permiso para guardar ese dato.' });
      if (typeof value !== 'string') return res.status(400).json({ error: 'El valor tiene que ser texto.' });
      const r = await fetch(KV(), {
        method: 'POST',
        headers: cabeceras({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
        body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }),
        cache: 'no-store'
      });
      if (!r.ok) throw new Error('http ' + r.status + ' ' + (await r.text()).slice(0, 200));
      return res.status(200).json({ ok: true });
    }

    // Listado de marcas para el panel del administrador. Devuelve los tokens porque es
    // justamente de donde el admin copia los links para repartir.
    if (accion === 'marcas') {
      if (sesion.rol !== 'admin') return res.status(403).json({ error: 'Solo el administrador.' });
      const registro = await leerRegistro();
      return res.status(200).json({ marcas: registro.marcas || [] });
    }

    return res.status(400).json({ error: 'Acción desconocida.' });
  } catch (e) {
    return res.status(502).json({ error: 'Error hablando con la base: ' + e.message });
  }
};
