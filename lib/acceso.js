// Verificación de acceso compartida por todos los endpoints.
//
// Vive acá y no copiada en cada archivo a propósito: es la única barrera entre una marca y
// los datos de otra. Si estuviera duplicada, un arreglo en un lado podría no llegar al otro.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const KV = () => SUPABASE_URL + '/rest/v1/kv';
const CLAVE_REGISTRO = '__marcas__';

const cabeceras = (extra) => Object.assign({
  apikey: SERVICE_KEY,
  Authorization: 'Bearer ' + SERVICE_KEY,
  'Content-Type': 'application/json'
}, extra || {});

let registroCache = null;
let registroCacheHasta = 0;
const CACHE_MS = 10000; // corto, para que revocar un link tenga efecto casi inmediato

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

function invalidarCache(nuevo) {
  registroCache = nuevo || null;
  registroCacheHasta = nuevo ? Date.now() + CACHE_MS : 0;
}

// Comparación en tiempo constante: sin esto se podría adivinar un token de a un caracter
// midiendo cuánto tarda la respuesta.
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
  return marca ? { rol: 'editor', slug: marca.slug, nombre: marca.nombre || marca.slug } : null;
}

// El registro no lo puede pedir nadie, ni el administrador: se administra por acciones
// propias, no leyéndolo como si fuera un dato más.
function puedeAcceder(sesion, clave) {
  if (typeof clave !== 'string' || !clave) return false;
  if (clave === CLAVE_REGISTRO) return false;
  if (sesion.rol === 'admin') return true;
  return clave.startsWith(sesion.slug + ':');
}

// Sin vocales ni caracteres que se confundan al leerlos (0/O, 1/l/I). randomBytes y no
// Math.random: este código es la llave del calendario.
const ALFABETO = 'abcdefghjkmnpqrstuvwxyz23456789';
function codigoAlAzar(largo) {
  const bytes = require('crypto').randomBytes(largo);
  let out = '';
  for (let i = 0; i < largo; i++) out += ALFABETO[bytes[i] % ALFABETO.length];
  return out;
}

// Lectura en lote respetando los permisos de quien pregunta. La usa el agente para armarse
// el panorama del mes sin poder espiar fuera de su marca.
async function leerClaves(sesion, claves) {
  const permitidas = (claves || []).filter(k => puedeAcceder(sesion, k));
  if (permitidas.length === 0) return {};
  const lista = permitidas.map(k => '"' + String(k).replace(/"/g, '\\"') + '"').join(',');
  const r = await fetch(`${KV()}?key=in.(${lista})&select=key,value`, {
    headers: cabeceras(), cache: 'no-store'
  });
  if (!r.ok) throw new Error('http ' + r.status);
  const out = {};
  (await r.json()).forEach(fila => { out[fila.key] = fila.value; });
  return out;
}

module.exports = {
  SUPABASE_URL, SERVICE_KEY, KV, CLAVE_REGISTRO,
  cabeceras, leerRegistro, invalidarCache, resolverToken, puedeAcceder,
  codigoAlAzar, leerClaves
};
