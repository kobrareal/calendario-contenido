// A dónde vuelve Instagram después de que la persona toca "Permitir".
//
// Canjea el código por un token de corta duración, lo cambia por uno de 60 días y lo guarda
// para la marca que venía firmada en el "state". Después devuelve a la persona a su
// calendario con ?instagram=ok (o con el error) para que la página lo muestre.

const {
  APP_ID, APP_SECRET, REDIRECT, GRAPH,
  claveConexion, guardarJson, verificar, graph
} = require('../lib/instagram');

const VIGENCIA_STATE_MS = 15 * 60 * 1000; // lo que se tarda, de sobra, en loguearse

function volverA(res, ruta, resultado) {
  const url = new URL(ruta || '/', 'https://x');
  url.searchParams.set('instagram', resultado);
  res.setHeader('Location', url.pathname + url.search);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(302).end();
}

module.exports = async (req, res) => {
  const q = new URL(req.url, 'https://x').searchParams;
  const datos = APP_SECRET ? verificar(q.get('state')) : null;
  // Sin un state válido no se sabe a qué marca pertenece la cuenta: no se guarda nada.
  if (!datos || Date.now() - datos.t > VIGENCIA_STATE_MS) return volverA(res, '/', 'vencido');
  // Cancelar en la pantalla de Instagram vuelve con ?error=access_denied.
  if (q.get('error') || !q.get('code')) return volverA(res, datos.volver, 'cancelado');

  try {
    // Instagram a veces le agrega "#_" al final del código; no es parte de él.
    const code = q.get('code').replace(/#_$/, '');
    const corto = await graph('https://api.instagram.com/oauth/access_token', {
      metodo: 'POST',
      params: { client_id: APP_ID, client_secret: APP_SECRET, grant_type: 'authorization_code', redirect_uri: REDIRECT, code }
    });
    // Según la versión, viene suelto o dentro de data[0].
    const tokenCorto = corto.access_token || (corto.data && corto.data[0] && corto.data[0].access_token);
    if (!tokenCorto) throw new Error('Instagram no devolvió el token.');

    const largo = await graph('https://graph.instagram.com/access_token', {
      params: { grant_type: 'ig_exchange_token', client_secret: APP_SECRET }, token: tokenCorto
    });
    const yo = await graph(GRAPH + '/me', { params: { fields: 'user_id,username' }, token: largo.access_token });

    await guardarJson(claveConexion(datos.marca), {
      token: largo.access_token,
      // user_id es el id de la cuenta profesional: el que se usa para publicar.
      cuentaId: String(yo.user_id || yo.id),
      usuario: yo.username || '',
      vence: Date.now() + (Number(largo.expires_in) || 60 * 24 * 3600) * 1000,
      renovado: Date.now(),
      conectado: new Date().toISOString()
    });
    return volverA(res, datos.volver, 'ok');
  } catch (e) {
    console.error('instagram-callback:', e.message);
    return volverA(res, datos.volver, 'error');
  }
};
