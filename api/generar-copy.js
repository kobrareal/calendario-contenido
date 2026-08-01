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

// El copy tiene un techo de caracteres, y el largo se pide como parte del encargo en vez de
// recortar lo que vuelve. Cortar a mano deja la última frase por la mitad, que es peor que
// un copy un poco más largo: el texto queda inservible igual y encima parece un error.
const LARGO_POR_DEFECTO = 499;
const LARGO_MINIMO = 80;    // por debajo de esto no hay copy que sirva
const LARGO_TOPE = 2200;    // el máximo que admite un pie de Instagram

// Cuántos caracteres de más se toleran antes de pedir que lo acorte. Un 8% sobre 500 son
// unos 40 caracteres: exigir el número exacto haría reintentar de más y sumar demora, para
// un límite que igual es una guía y no una regla de la plataforma.
const MARGEN = 1.08;

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

  const pedido = Number(cuerpo.maxLen);
  const largoMax = Number.isFinite(pedido)
    ? Math.min(LARGO_TOPE, Math.max(LARGO_MINIMO, Math.round(pedido)))
    : LARGO_POR_DEFECTO;

  if (!contexto) {
    return res.status(400).json({ error: 'Escribí primero el contexto o la idea del copy.' });
  }

  // El largo se expresa dos veces —en caracteres y en frases— porque los modelos cuentan
  // caracteres bastante mal, y en cambio "tres o cuatro frases" sí lo respetan. Las dos
  // formas juntas dan un resultado mucho más estable que el número solo.
  const frases = largoMax <= 300 ? 'dos o tres frases cortas'
               : largoMax <= 700 ? 'tres o cuatro frases cortas'
               : 'un par de párrafos breves';

  const base =
    'Sos un/a community manager escribiendo el copy para un ' + etiqueta + ' de Instagram' +
    (angulo ? (' con ángulo de contenido "' + angulo + '"') : '') + '. ' +
    'Escribí en español, con tono cercano y natural (podés usar "vos"), listo para publicar. ' +
    'IMPORTANTE: el copy no puede superar los ' + largoMax + ' caracteres contando espacios. ' +
    'Apuntá a ' + frases + '. Es preferible quedarse corto que pasarse. ' +
    'Tiene que terminar de forma completa: nunca cortes una idea por la mitad. ' +
    'No agregues hashtags a menos que el contexto los pida explícitamente. ' +
    'No repitas el contexto de forma literal, escribilo como copy real. ' +
    'Idea / contexto: "' + contexto + '". ' +
    'Devolvé SOLO el texto del copy, sin explicaciones, sin comillas, sin encabezados.';

  // Deliberadamente NO se limita maxOutputTokens para forzar el largo: eso corta la
  // generación a mitad de palabra, que es justo lo que se quiere evitar. El techo se pide
  // en el encargo y, si no se cumple, se pide condensar.
  const llamar = async (prompt) => {
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
      const e = new Error(json.error.message || 'Error de la API de Gemini');
      e.deGoogle = true;
      throw e;
    }
    const texto = json.candidates &&
                  json.candidates[0] &&
                  json.candidates[0].content &&
                  json.candidates[0].content.parts &&
                  json.candidates[0].content.parts[0] &&
                  json.candidates[0].content.parts[0].text;
    return texto ? texto.trim() : '';
  };

  try {
    let texto = await llamar(base);
    if (!texto) return res.status(502).json({ error: 'Gemini no devolvió texto. Probá de nuevo.' });

    // Un solo reintento si se pasó de largo: se le devuelve su propio texto para que lo
    // condense en vez de escribir otro distinto, así no se pierde lo que ya estaba bien.
    // Uno solo y no varios porque cada vuelta suma varios segundos de espera.
    if (texto.length > largoMax * MARGEN) {
      const condensado = await llamar(
        'Acortá este copy de Instagram a menos de ' + largoMax + ' caracteres contando espacios, ' +
        'sin perder la idea principal ni el tono. Tiene que terminar de forma completa. ' +
        'Devolvé SOLO el copy acortado, sin explicaciones ni comillas.\n\n' + texto
      );
      // El condensado se acepta solo si mejora: a veces vuelve más largo que el original.
      if (condensado && condensado.length < texto.length) texto = condensado;
    }

    // Se devuelve el largo pedido para que la interfaz sepa contra qué comparar y pueda
    // avisar, en vez de recortar por su cuenta.
    return res.status(200).json({ text: texto, maxLen: largoMax });
  } catch (err) {
    if (err && err.deGoogle) return res.status(502).json({ error: err.message });
    return res.status(502).json({ error: 'No se pudo contactar a Gemini: ' + err.message });
  }
};
