// Manifiesto de la app, armado por pedido para incluir el link de quien la instala.
//
// El manifiesto fijo tenía start_url "." — la raíz —, y eso rompía la app instalada en
// iPhone: ahí la app tiene su propio almacenamiento, separado del navegador, así que el link
// recordado en Safari no lo ve, abría la raíz sin llave y mostraba la pantalla de candado.
// Con el token adentro del start_url, el ícono abre directo en el calendario que corresponde.

module.exports = (req, res) => {
  const url = new URL(req.url, 'http://x');
  const token = String(url.searchParams.get('t') || '').trim();
  // Solo se acepta la forma de un token, no una ruta cualquiera: esto termina siendo la
  // dirección que abre la app, y no queremos que sirva para apuntarla a otro lado.
  const valido = /^[a-z0-9-]{6,80}$/i.test(token);
  const inicio = valido ? '/' + encodeURIComponent(token) : '/';

  res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
  // Sin cache: si se regenera el link de una marca, el manifiesto viejo apuntaría a un
  // token que ya no existe.
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).send(JSON.stringify({
    name: 'Calendario de Contenido',
    short_name: 'Calendario',
    description: 'Planificá, revisá y aprobá el contenido del mes.',
    start_url: inicio,
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: '#0a0a0d',
    theme_color: '#0a0a0d',
    lang: 'es-AR',
    icons: [
      { src: '/icono.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: '/icono.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' }
    ]
  }));
};
