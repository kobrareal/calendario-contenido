// Conexión de cada marca con su cuenta de Instagram, y lo que el calendario necesita saber
// de ella: con qué cuenta está conectada y cómo le fue a cada posteo programado.
//
// El token de Instagram nunca sale de acá: el navegador ve el nombre de usuario y hasta
// cuándo vale la conexión, nada más. Ver lib/instagram.js.

const { resolverToken } = require('../lib/acceso');
const {
  APP_ID, APP_SECRET, PERMISOS, REDIRECT,
  marcaDe, claveConexion, claveRegistro, leerJson, guardarJson, borrarClave, firmar
} = require('../lib/instagram');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Usá POST.' });
  }
  // 501 y no 500: la interfaz lo usa para explicar qué falta configurar en vez de un error seco.
  if (!APP_SECRET) return res.status(501).json({ error: 'Falta configurar INSTAGRAM_APP_SECRET en Vercel.' });

  const cuerpo = req.body || {};
  let sesion;
  try { sesion = await resolverToken(cuerpo.token); }
  catch (e) { return res.status(502).json({ error: 'No se pudo verificar el acceso.' }); }
  if (!sesion) return res.status(401).json({ error: 'Link inválido o dado de baja.' });

  const marca = marcaDe(sesion, cuerpo.cliente);

  try {
    if (cuerpo.accion === 'estado') {
      const conexion = await leerJson(claveConexion(marca), null);
      const registro = await leerJson(claveRegistro(marca), {});
      return res.status(200).json({
        conectado: !!(conexion && conexion.token),
        usuario: conexion ? conexion.usuario : '',
        vence: conexion ? conexion.vence : 0,
        // Solo lo que la tarjeta muestra; los ids internos de Instagram quedan acá.
        publicaciones: Object.fromEntries(Object.entries(registro).map(([k, v]) => [k, {
          estado: v.estado, permalink: v.permalink || '', error: v.error || '', at: v.at || ''
        }]))
      });
    }

    if (cuerpo.accion === 'conectar') {
      // A dónde volver después de autorizar: solo una ruta de este mismo sitio, para que el
      // login no sirva de trampolín hacia otra página.
      const volver = String(cuerpo.volver || '/');
      const seguro = /^\/(?!\/)[^\s\\]*$/.test(volver) ? volver : '/';
      const state = firmar({ marca, volver: seguro, t: Date.now() });
      const url = 'https://www.instagram.com/oauth/authorize?' + new URLSearchParams({
        enable_fb_login: '0',
        // Pide elegir la cuenta siempre: con una sesión de Instagram ya abierta en el
        // navegador, sin esto se conectaría esa sin preguntar, aunque fuera la de otra marca.
        force_authentication: '1',
        client_id: APP_ID,
        redirect_uri: REDIRECT,
        response_type: 'code',
        scope: PERMISOS,
        state
      });
      return res.status(200).json({ url });
    }

    if (cuerpo.accion === 'desconectar') {
      await borrarClave(claveConexion(marca));
      return res.status(200).json({ ok: true });
    }

    // Borra el resultado de un posteo que falló para que el publicador lo intente de nuevo
    // en la próxima vuelta. Uno publicado no se toca: reintentarlo lo publicaría dos veces.
    if (cuerpo.accion === 'reintentar') {
      const id = String(cuerpo.id || '');
      const registro = await leerJson(claveRegistro(marca), {});
      if (!registro[id]) return res.status(200).json({ ok: true });
      if (registro[id].estado !== 'error') {
        return res.status(409).json({ error: 'Solo se puede reintentar un posteo que falló.' });
      }
      delete registro[id];
      await guardarJson(claveRegistro(marca), registro);
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Acción desconocida.' });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
};
