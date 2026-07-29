// Puente a la API de Pinterest.
//
// El navegador manda el token del link (para saber quién es), y este endpoint —del lado
// del servidor— usa el PINTEREST_TOKEN configurado en Vercel para hablar con Pinterest.
// El access token de Pinterest nunca llega al navegador, mismo criterio que la clave de
// Gemini o la service_key de Supabase.
//
// Si PINTEREST_TOKEN no está configurado, se responde 501 (Not Implemented) — no un 500
// genérico. La interfaz distingue ese caso y muestra instrucciones al usuario en vez de
// un error seco. Con eso, la sección Pinterest ya está integrada, y "encenderla" es solo
// pegar el token en Vercel.

const { resolverToken } = require('../lib/acceso');

const PINTEREST_API = 'https://api.pinterest.com/v5';

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Usá POST.' });
  }

  const pinToken = process.env.PINTEREST_TOKEN;
  if (!pinToken) {
    return res.status(501).json({ error: 'Pinterest no está configurado en el servidor.' });
  }

  // Autenticación del calendario: el token del link identifica al usuario. Si no es
  // válido, ni siquiera llegamos a hablar con Pinterest.
  const cuerpo = req.body || {};
  let sesion;
  try { sesion = await resolverToken(cuerpo.token); }
  catch (e) { return res.status(502).json({ error: 'No se pudo verificar el acceso.' }); }
  if (!sesion) return res.status(401).json({ error: 'Link inválido o dado de baja.' });

  const url = new URL(req.url, 'http://x');
  const accion = url.searchParams.get('accion') || cuerpo.accion;

  const llamar = async (path) => {
    const r = await fetch(PINTEREST_API + path, {
      headers: { Authorization: 'Bearer ' + pinToken, 'Content-Type': 'application/json' }
    });
    const j = await r.json().catch(() => null);
    if (!r.ok) throw new Error((j && j.message) || ('http ' + r.status));
    return j;
  };

  try {
    if (accion === 'boards') {
      const j = await llamar('/boards?page_size=25');
      // Solo devuelvo lo que la interfaz necesita — no todo el payload de Pinterest, que
      // trae mucho más y no queremos que viaje a cada navegador.
      const boards = (j.items || []).map(b => ({
        id: b.id, name: b.name, pin_count: b.pin_count
      }));
      return res.status(200).json({ boards });
    }

    if (accion === 'pins') {
      const boardId = String(cuerpo.boardId || '').trim();
      if (!/^[0-9]+$/.test(boardId)) return res.status(400).json({ error: 'boardId inválido.' });
      const j = await llamar(`/boards/${boardId}/pins?page_size=50`);
      const pins = (j.items || []).map(p => {
        // Pinterest devuelve varias resoluciones de la imagen; se prefiere la mediana para
        // que la grilla cargue rápido sin verse pixelada.
        const img = p.media && p.media.images
          ? (p.media.images['400x300'] || p.media.images['600x'] || p.media.images.originals)
          : null;
        return {
          id: p.id,
          title: p.title || '',
          description: p.description || '',
          link: p.link || `https://pinterest.com/pin/${p.id}`,
          image: img ? img.url : ''
        };
      }).filter(p => p.image); // sin imagen no sirve como referencia visual
      return res.status(200).json({ pins });
    }

    return res.status(400).json({ error: 'Acción desconocida.' });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
};
