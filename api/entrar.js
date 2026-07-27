// Canjea un PIN por el link de acceso de esa marca.
//
// Existe para que todos usen la misma dirección: entran, ponen su PIN y caen en su propio
// calendario. Es cómodo, pero un PIN es corto por definición, así que la seguridad real la
// da el freno de acá abajo: sin él, una página de acceso pública se prueba entera con un
// script en minutos.

const { resolverPin, registrarIntento, estaBloqueado, MAX_INTENTOS } = require('../lib/acceso');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Usá POST.' });
  }

  // Vercel pone la IP real acá; el primer valor de la lista es el cliente.
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'desconocida';
  const pin = String((req.body || {}).pin || '').trim();

  try {
    if (await estaBloqueado(ip)) {
      return res.status(429).json({
        error: 'Demasiados intentos. Esperá 15 minutos y volvé a probar.'
      });
    }

    const hallado = await resolverPin(pin);
    const marca = await registrarIntento(ip, !!hallado);

    if (!hallado) {
      return res.status(401).json({
        error: marca.restantes > 0
          ? `PIN incorrecto. Te quedan ${marca.restantes} intento${marca.restantes === 1 ? '' : 's'}.`
          : 'Demasiados intentos. Esperá 15 minutos y volvé a probar.',
        restantes: marca.restantes
      });
    }

    return res.status(200).json({ token: hallado.token });
  } catch (e) {
    return res.status(502).json({ error: 'No se pudo verificar el PIN. Probá de nuevo.' });
  }
};
