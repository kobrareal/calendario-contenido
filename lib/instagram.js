// Lo que comparten la conexión con Instagram (api/instagram.js, api/instagram-callback.js)
// y el publicador (api/publicar.js).
//
// Usa la "Instagram API with Instagram Login": cada marca conecta su propia cuenta
// profesional (Empresa o Creador) sin necesidad de una página de Facebook.
//
// Variables de entorno (Vercel > Settings > Environment Variables):
//   INSTAGRAM_APP_ID      el "ID de la app de Instagram" (no es secreto)
//   INSTAGRAM_APP_SECRET  la "clave secreta de la app de Instagram" (secreta)
//   CRON_SECRET           una clave larga cualquiera; la usa quien dispara el publicador

const crypto = require('crypto');
const { KV, cabeceras, PREFIJOS_PRIVADOS } = require('./acceso');

const APP_ID = process.env.INSTAGRAM_APP_ID || '4267997163498006';
const APP_SECRET = process.env.INSTAGRAM_APP_SECRET;
const GRAPH = 'https://graph.instagram.com/v23.0';
const PERMISOS = 'instagram_business_basic,instagram_business_content_publish';
// Tiene que coincidir letra por letra con la URL cargada en la app de Meta.
const REDIRECT = (process.env.SITIO_URL || 'https://calendario-contenido-kappa.vercel.app') + '/api/instagram-callback';

// La marca de una sesión. Una marca es la suya y nada más; el administrador trabaja sobre
// la que tenga abierta (?cliente=), y '' es su propio calendario, el que no lleva prefijo.
function marcaDe(sesion, cliente) {
  if (sesion.rol !== 'admin') return sesion.slug;
  return String(cliente || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
}
const claveConexion = (marca) => '__instagram__:' + (marca || '_');
const claveRegistro = (marca) => '__publicaciones__:' + (marca || '_');
const prefijoDatos = (marca) => (marca ? marca + ':' : '');

async function leerJson(clave, porDefecto) {
  const r = await fetch(`${KV()}?key=eq.${encodeURIComponent(clave)}&select=value`, {
    headers: cabeceras(), cache: 'no-store'
  });
  if (!r.ok) throw new Error('No se pudo leer ' + clave + ' (' + r.status + ')');
  const filas = await r.json();
  if (!filas.length) return porDefecto;
  try { return JSON.parse(filas[0].value); } catch (e) { return porDefecto; }
}

async function guardarJson(clave, valor) {
  const r = await fetch(KV(), {
    method: 'POST',
    headers: cabeceras({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify({ key: clave, value: JSON.stringify(valor), updated_at: new Date().toISOString() })
  });
  if (!r.ok) throw new Error('No se pudo guardar ' + clave + ' (' + r.status + ')');
}

async function borrarClave(clave) {
  await fetch(`${KV()}?key=eq.${encodeURIComponent(clave)}`, { method: 'DELETE', headers: cabeceras() });
}

// ---------- state firmado del login ----------
// Instagram devuelve a la persona a /api/instagram-callback con el "state" que se le mandó.
// Va firmado para que nadie pueda armar un link que conecte SU cuenta a la marca de otro.
function firmar(datos) {
  const cuerpo = Buffer.from(JSON.stringify(datos)).toString('base64url');
  const firma = crypto.createHmac('sha256', APP_SECRET).update(cuerpo).digest('base64url');
  return cuerpo + '.' + firma;
}
function verificar(state) {
  const [cuerpo, firma] = String(state || '').split('.');
  if (!cuerpo || !firma) return null;
  const esperada = crypto.createHmac('sha256', APP_SECRET).update(cuerpo).digest('base64url');
  const a = Buffer.from(firma), b = Buffer.from(esperada);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { return JSON.parse(Buffer.from(cuerpo, 'base64url').toString()); } catch (e) { return null; }
}

// ---------- llamadas a la Graph API ----------
// Los errores de Meta vienen como {error:{message, code}}; se devuelven tal cual porque
// suelen decir exactamente qué falló ("The aspect ratio is not supported").
async function graph(camino, { metodo = 'GET', params = {}, token } = {}) {
  const p = new URLSearchParams(Object.assign({}, params, token ? { access_token: token } : {}));
  const url = camino.startsWith('http') ? camino : GRAPH + camino;
  const r = metodo === 'GET'
    ? await fetch(url + (url.includes('?') ? '&' : '?') + p, { cache: 'no-store' })
    : await fetch(url, { method: metodo, body: p, cache: 'no-store' });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || j.error || j.error_message) {
    const msg = (j && ((j.error && (j.error.error_user_msg || j.error.message)) || j.error_message)) || ('Instagram respondió ' + r.status);
    const e = new Error(msg);
    e.codigo = j && j.error && j.error.code;
    // El detalle completo de Meta, para el diagnóstico: el mismo mensaje puede venir de
    // causas distintas y lo que las separa es el código, el subcódigo y el tipo.
    e.detalle = j && j.error ? {
      code: j.error.code, subcode: j.error.error_subcode, type: j.error.type,
      message: j.error.message, user_title: j.error.error_user_title, user_msg: j.error.error_user_msg,
      fbtrace_id: j.error.fbtrace_id
    } : { status: r.status, body: j };
    throw e;
  }
  return j;
}

module.exports = {
  APP_ID, APP_SECRET, GRAPH, PERMISOS, REDIRECT, PREFIJOS_PRIVADOS,
  marcaDe, claveConexion, claveRegistro, prefijoDatos,
  leerJson, guardarJson, borrarClave, firmar, verificar, graph
};
