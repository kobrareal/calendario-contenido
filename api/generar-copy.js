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

// Un guión no tiene el techo del pie de Instagram: no se publica, se lee para filmar. Con el
// tope del copy —500 caracteres— un carrusel de seis placas no entraba y volvía recortado.
const LARGO_GUION = 1400;

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

  const esGuion = cuerpo.formato === 'guion';

  const pedido = Number(cuerpo.maxLen);
  const largoMax = Number.isFinite(pedido)
    ? Math.min(LARGO_TOPE, Math.max(LARGO_MINIMO, Math.round(pedido)))
    : (esGuion ? LARGO_GUION : LARGO_POR_DEFECTO);

  if (!contexto) {
    return res.status(400).json({ error: 'Escribí primero el contexto o la idea del copy.' });
  }

  // El largo se expresa dos veces —en caracteres y en frases— porque los modelos cuentan
  // caracteres bastante mal, y en cambio "tres o cuatro frases" sí lo respetan. Las dos
  // formas juntas dan un resultado mucho más estable que el número solo.
  const frases = largoMax <= 300 ? 'dos o tres frases cortas'
               : largoMax <= 700 ? 'tres o cuatro frases cortas'
               : 'un par de párrafos breves';

  // Formato de salida del copy. El guión tiene el suyo, más abajo.
  const formato = esGuion ? ''
    : 'FORMATO OBLIGATORIO: escribí cada frase en un renglón aparte, separadas por un salto ' +
      'de línea, y que cada frase incluya al menos un emoji que acompañe lo que dice. ' +
      'El emoji tiene que aportar sentido, no ser decoración al azar: si una frase no pide ' +
      'ninguno en particular, elegí el más neutro antes que forzar uno que no venga al caso. ' +
      'Terminá SIEMPRE con exactamente 4 hashtags, todos juntos en el último renglón, ' +
      'separados por espacios. Tienen que salir del tema del posteo y de su ángulo: ' +
      'hashtags genéricos como #instagood o #love no sirven para que a este contenido lo ' +
      'encuentre quien le interesa. Los 4 hashtags cuentan dentro del límite de caracteres, ' +
      'así que dejales lugar al escribir el texto. ';

  // La voz es la de la marca, no la de una persona. Va con ejemplo porque la instrucción
  // sola se cumple a medias: el modelo arranca en plural y a la tercera frase se le escapa
  // un "les muestro". Con un caso concreto delante eso deja de pasar.
  const voz =
    'La marca habla siempre en plural, como equipo: "diseñamos", "preparamos", "te ' +
    'mostramos". NUNCA en primera persona del singular: nada de "diseñé", "preparé" o ' +
    '"les muestro". Ejemplo: se escribe "Diseñamos este buzo", no "Diseñé este buzo". ';

  // Catálogo de la marca, si lo cargó. Va con la instrucción de no inventar: sin eso, el
  // modelo toma la lista como sugerencia y igual se saca productos de la manga cuando el
  // contexto es vago.
  // 8000 y no menos: un catálogo de indumentaria con ~80 modelos y su descripción ronda
  // los 7000 caracteres, y cortarlo dejaba media tienda afuera sin que nada lo avisara.
  const catalogo = String(cuerpo.productos || '').trim().slice(0, 8000);

  // El catálogo es material de consulta, no un temario. Sin esta aclaración el modelo lo lee
  // como "hablá de esto" y mete un producto donde no venía a cuento: se pide algo sobre el
  // detrás de escena y vuelve vendiendo un buzo. Vale igual para copys y para guiones: la
  // marca decide de qué habla cada posteo en la idea, no la lista de productos.
  const pieza = esGuion ? 'del guión' : 'del copy';
  const soloSiCorresponde =
    'No fuerces la mención de ningún producto: el catálogo está para consultarlo, no para ' +
    'meterlo sí o sí. Si la idea ' + pieza + ' no habla de un producto puntual, no lo nombres ' +
    'ni lo describas. Solo mencionás un producto cuando la idea lo pide de forma explícita. ';

  const bloqueProductos = catalogo
    ? 'Estos son los productos reales de la marca. Si el texto habla de un producto, tiene ' +
      'que ser uno de esta lista, con las características que dice acá. No inventes productos ' +
      'ni les agregues características que no figuren. ' + soloSiCorresponde +
      '\n' + catalogo + '\n\n'
    : '';

  // Copy y guión son dos encargos distintos y hasta acá compartían uno solo con dos parches:
  // se pedía "el copy de un reel" y después se le sacaban los emojis y los hashtags. Con eso
  // el modelo devolvía exactamente lo que se le había pedido —un pie de foto— sin emojis.
  // Ahora cada formato tiene su propio encargo, y el del guión dice de entrada que lo que se
  // escribe se DICE o se MUESTRA, no se lee debajo de la publicación.
  const conAngulo = angulo ? (' El ángulo de contenido es "' + angulo + '".') : '';
  const cierre =
    'Idea / contexto: "' + contexto + '". ' +
    'No repitas el contexto de forma literal.';

  // El carrusel es el caso aparte: nadie lo dice en voz alta, se lee en pantalla. Su guión
  // es el texto de cada placa, y pedirle "lo que se dice" devolvería un locutor sin video.
  const esCarrusel = cuerpo.kind === 'carrusel';

  const baseGuion = esCarrusel
    ? 'Sos guionista de contenido para redes sociales. Escribís el texto que va ESCRITO EN ' +
      'CADA PLACA de un carrusel de Instagram.' + conAngulo + ' ' +
      'Esto NO es el pie de la publicación: el pie es otro pedido y no lo tenés que escribir. ' +
      'Nada de hashtags, nada de emojis, nada de "link en bio". ' +
      voz + bloqueProductos +
      'FORMATO: una placa por renglón, empezando cada uno con "PLACA 1:", "PLACA 2:", y así. ' +
      'Entre 5 y 7 placas. ' +
      'La placa 1 es la portada y lleva una sola frase, la que tiene que frenar el scroll. ' +
      'Las del medio desarrollan una idea cada una, en pocas palabras: es texto para leer de ' +
      'un vistazo en una pantalla de teléfono, no un párrafo. ' +
      'La última placa pide una acción concreta. ' +
      'Devolvé SOLO las placas, sin explicaciones, sin comillas, sin encabezados. ' + cierre

    : 'Sos guionista de contenido para redes sociales. Escribís lo que se DICE frente a ' +
      'cámara en ' + (cuerpo.kind === 'story' ? 'una story' : 'un reel') + ' de Instagram: ' +
      'el habla, lo que sale por la boca de quien graba.' + conAngulo + ' ' +
      'Esto NO es el pie de la publicación. Si escribís algo que se leería debajo del video ' +
      'en vez de decirse en voz alta, está mal. Nada de hashtags, nada de emojis, nada de ' +
      '"link en bio", y no lo cierres con una frase de pie de foto. ' +
      voz + bloqueProductos +
      'ESTRUCTURA: el primer renglón es el gancho, lo que se dice en los primeros 3 segundos, ' +
      'y tiene que dar una razón para no seguir scrolleando. Después el desarrollo, una idea ' +
      'por renglón. El último renglón es lo que se le pide a quien mira. ' +
      'Escribilo como se habla, no como se escribe: frases cortas, que dichas en voz alta ' +
      'suenen a persona y no a folleto. ' +
      'Si un plano necesita aclarar qué se ve, va al final del renglón entre paréntesis y en ' +
      'pocas palabras. ' +
      'Apuntá a un video de 20 a 40 segundos: entre 60 y 100 palabras dichas. ' +
      'Devolvé SOLO el guión, sin explicaciones, sin comillas, sin encabezados. ' + cierre;

  const baseCopy =
    'Sos un/a community manager escribiendo el copy para un ' + etiqueta + ' de Instagram' +
    (angulo ? (' con ángulo de contenido "' + angulo + '"') : '') + '. ' +
    'Escribí en español, con tono cercano y natural (podés usar "vos"), listo para publicar. ' +
    voz + bloqueProductos +
    'IMPORTANTE: el copy no puede superar los ' + largoMax + ' caracteres contando espacios. ' +
    'Apuntá a ' + frases + '. Es preferible quedarse corto que pasarse. ' +
    'Tiene que terminar de forma completa: nunca cortes una idea por la mitad. ' +
    formato +
    'No repitas el contexto de forma literal, escribilo como copy real. ' +
    'Idea / contexto: "' + contexto + '". ' +
    'Devolvé SOLO el texto del copy, sin explicaciones, sin comillas, sin encabezados.';

  const base = esGuion ? baseGuion : baseCopy;

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
        (esGuion
          ? 'Acortá este guión a menos de ' + largoMax + ' caracteres contando espacios, sin ' +
            'perder el gancho del principio ni el pedido del final. Sigue siendo lo que se ' +
            (esCarrusel ? 'escribe en cada placa, con el mismo "PLACA N:" adelante. '
                        : 'dice frente a cámara, no un pie de foto. Una idea por renglón. ')
          : 'Acortá este copy de Instagram a menos de ' + largoMax + ' caracteres contando ' +
            'espacios, sin perder la idea principal ni el tono. ' +
            'Tiene que terminar de forma completa. ') +
        // Al reescribir para acortar es donde más se cuela el singular, porque el modelo
        // rearma las frases desde cero en vez de recortar las que ya estaban.
        voz +
        // Se repite el formato: al pedir solo "acortalo", el modelo devuelve un párrafo
        // corrido y se pierden los renglones y los emojis que se acababan de pedir.
        (esGuion
          ? 'Mantené un renglón por idea. '
          : 'Mantené el formato: cada frase en un renglón aparte, con al menos un emoji, y ' +
            'los 4 hashtags juntos en el último renglón. ') +
        'Devolvé SOLO el texto acortado, sin explicaciones ni comillas.\n\n' + texto
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
