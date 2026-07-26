// Genera el copy de un posteo con Gemini, del lado del servidor.
//
// Reemplaza al Apps Script que hacía esto antes. La razón de que exista una función acá en
// vez de llamar a Gemini desde el navegador es la clave: vive en la variable de entorno
// GEMINI_API_KEY y nunca se le manda al navegador. Si estuviera en el HTML, cualquiera que
// abriera el calendario podría leerla y gastar la cuota.
//
// Para configurar la clave: en Vercel, Settings > Environment Variables > Add New,
// nombre GEMINI_API_KEY, valor la clave de https://aistudio.google.com/apikey

// Usamos el alias "gemini-flash-latest" en vez de un nombre de modelo fijo: Google lo
// redirige al modelo Flash vigente, así esto no se rompe cada vez que renombran o
// discontinúan una versión puntual (ya pasó dos veces con el backend anterior).
const MODELO = 'gemini-flash-latest';
const LARGO_MAXIMO_CONTEXTO = 4000;

const ETIQUETAS = { reel: 'Reel', carrusel: 'Carrusel', story: 'Story' };

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Usá POST.' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'Falta configurar GEMINI_API_KEY en las variables de entorno de Vercel.'
    });
  }

  const cuerpo = req.body || {};
  const contexto = String(cuerpo.context || '').trim().slice(0, LARGO_MAXIMO_CONTEXTO);
  const etiqueta = ETIQUETAS[cuerpo.kind] || 'posteo';
  const angulo = String(cuerpo.angle || '').trim();

  if (!contexto) {
    return res.status(400).json({ error: 'Escribí primero el contexto o la idea del copy.' });
  }

  const prompt =
    'Sos un/a community manager escribiendo el copy para un ' + etiqueta + ' de Instagram' +
    (angulo ? (' con ángulo de contenido "' + angulo + '"') : '') + '. ' +
    'Escribí en español, con tono cercano y natural (podés usar "vos"), listo para publicar. ' +
    'No agregues hashtags a menos que el contexto los pida explícitamente. ' +
    'No repitas el contexto de forma literal, escribilo como copy real. ' +
    'Idea / contexto: "' + contexto + '". ' +
    'Devolvé SOLO el texto del copy, sin explicaciones, sin comillas, sin encabezados.';

  try {
    const respuesta = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODELO}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
      }
    );

    const json = await respuesta.json();

    if (json.error) {
      // El mensaje de Google se pasa tal cual porque suele ser accionable ("cuota agotada",
      // "clave inválida"), pero nunca se devuelve la clave ni el prompt completo.
      return res.status(502).json({ error: json.error.message || 'Error de la API de Gemini' });
    }

    const texto = json.candidates &&
                  json.candidates[0] &&
                  json.candidates[0].content &&
                  json.candidates[0].content.parts &&
                  json.candidates[0].content.parts[0] &&
                  json.candidates[0].content.parts[0].text;

    if (!texto) {
      return res.status(502).json({ error: 'Gemini no devolvió texto. Probá de nuevo.' });
    }

    return res.status(200).json({ text: texto.trim() });
  } catch (err) {
    return res.status(502).json({ error: 'No se pudo contactar a Gemini: ' + err.message });
  }
};
