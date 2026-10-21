// Genera el copy de un posteo con Gemini, del lado del servidor.
//
// Reemplaza al Apps Script que hacía esto antes. La razón de que exista una función acá en
// vez de llamar a Gemini desde el navegador es la clave: vive en la variable de entorno
// GEMINI_API_KEY y nunca se le manda al navegador. Si estuviera en el HTML, cualquiera que
// abriera el calendario podría leerla y gastar la cuota.
//
// Para configurar la clave: en Vercel, Settings > Environment Variables > Add New,
// nombre GEMINI_API_KEY, valor la clave de https://aistudio.google.com/apikey

const { normalizarReglas, bloqueReglas, incumplidas } = require('../lib/reglas-ia');

// Lista de modelos, en orden de preferencia. Se usan alias ("-latest") y no nombres de
// versión fijos: Google los redirige al modelo vigente, así esto no se rompe cada vez que
// renombran o discontinúan una versión puntual (ya pasó dos veces con el backend anterior).
//
// Son varios y no uno porque "the model is overloaded" es un error de todos los días: el
// primero es el de siempre y el segundo es la versión liviana —más rápida y con menos cola,
// de sobra para un copy de 500 caracteres—. El tercero vuelve a probar el primero: la
// saturación suele ser de segundos. Antes ese lugar lo ocupaba gemini-2.0-flash como versión
// fija de respaldo, pero Google la dio de baja (octubre 2026) y el tercer intento fallaba siempre.
const MODELOS = ['gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-flash-latest'];
const LARGO_MAXIMO_CONTEXTO = 4000;

const ETIQUETAS = { reel: 'Reel', carrusel: 'Carrusel', imagen: 'posteo de una sola imagen', story: 'Story' };

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

// Título y ángulo a partir de un copy ya escrito, para los posteos que no los tienen. Vive
// acá y no en una función aparte porque el plan Hobby de Vercel admite pocas funciones, y
// comparte con el copy la clave, los modelos y las reglas de la marca.
//
// El ángulo se elige SOLO de la lista de la marca y se valida contra ella: un ángulo
// inventado no tendría color ni aparecería en los filtros.
async function tituloYAngulo(cuerpo, apiKey, res) {
  const texto = String(cuerpo.texto || '').trim().slice(0, 3000);
  if (texto.length < 20) return res.status(400).json({ error: 'El copy es muy corto para deducir algo.' });
  const angulos = (Array.isArray(cuerpo.angulos) ? cuerpo.angulos : [])
    .filter(a => a && a.id && a.nombre).slice(0, 40)
    .map(a => ({ id: String(a.id).slice(0, 60), nombre: String(a.nombre).slice(0, 80) }));
  const pideTitulo = !!cuerpo.pideTitulo;
  const pideAngulo = !!cuerpo.pideAngulo && angulos.length > 0;
  if (!pideTitulo && !pideAngulo) return res.status(200).json({ titulo: '', angulo: '' });

  const reglas = normalizarReglas(cuerpo.reglas);
  const prompt =
    'Leé este copy de un ' + (ETIQUETAS[cuerpo.kind] || 'posteo') + ' de Instagram y devolvé un único ' +
    'objeto JSON, sin texto alrededor, con esta forma: {"titulo": "...", "angulo": "..."}.\n' +
    (pideTitulo
      ? '- "titulo": de 2 a 5 palabras en MAYÚSCULAS que digan de qué trata, para reconocerlo de un ' +
        'vistazo en un calendario. Estilo de ejemplo, de otros rubros: "CAMPERAS, DESCUENTO 30%", "RECETA DE BUDÍN". ' +
        'Sin emojis, sin hashtags, sin comillas.\n'
      : '- "titulo": dejalo vacío.\n') +
    (pideAngulo
      ? '- "angulo": el id del ángulo de esta lista que mejor describa el posteo. Si ninguno encaja ' +
        'con claridad, dejalo vacío: es mejor sin ángulo que con uno equivocado.\n' +
        angulos.map(a => '  ' + a.id + ' = ' + a.nombre).join('\n') + '\n'
      : '- "angulo": dejalo vacío.\n') +
    (reglas && reglas.evitar.length ? 'En el título no uses: ' + reglas.evitar.map(p => '"' + p + '"').join(', ') + '.\n' : '') +
    '\nCopy:\n' + texto;

  let ultimo = '';
  for (const modelo of MODELOS) {
    try {
      // Sin el razonamiento previo, como en el copy: para un título de cinco palabras no
      // aporta nada y multiplica la demora. Si el modelo no conoce el ajuste, se pide sin él.
      const pedir = (sinPensar) => fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: Object.assign({ responseMimeType: 'application/json', temperature: 0.3 },
            sinPensar ? { thinkingConfig: { thinkingBudget: 0 } } : {})
        }),
        signal: AbortSignal.timeout(9000)
      }).then(r => r.json());
      let j = await pedir(true);
      if (j.error && (j.error.code === 400 || /thinking|invalid argument/i.test(j.error.message || ''))) j = await pedir(false);
      if (j.error) { ultimo += modelo + ': ' + (j.error.message || ('error ' + j.error.code)).slice(0, 120) + ' | '; continue; } // saturado o dado de baja: el siguiente
      const salida = j.candidates && j.candidates[0] && j.candidates[0].content &&
        j.candidates[0].content.parts && j.candidates[0].content.parts[0] && j.candidates[0].content.parts[0].text;
      const datos = JSON.parse(String(salida || '{}').replace(/^```(?:json)?/i, '').replace(/```$/, '').trim());
      const titulo = pideTitulo ? String(datos.titulo || '').replace(/[#"“”]/g, '').trim().slice(0, 60) : '';
      const angulo = pideAngulo && angulos.some(a => a.id === datos.angulo) ? datos.angulo : '';
      return res.status(200).json({ titulo, angulo });
    } catch (e) { ultimo += modelo + ': ' + (e.name === 'TimeoutError' ? 'no contestó a tiempo' : e.message) + ' | '; } // siguiente modelo
  }
  return res.status(504).json({ error: 'Gemini no respondió (' + (ultimo || 'sin detalle') + '). Probá de nuevo en un momento.' });
}

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
  if (cuerpo.formato === 'titulo-angulo') return tituloYAngulo(cuerpo, apiKey, res);
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

  // Reglas de estilo de la marca (kit de marca > Reglas para la IA). Las de hashtags solo
  // aplican al copy: el guión no lleva hashtags.
  const reglas = normalizarReglas(cuerpo.reglas);
  const conHashtags = !esGuion;
  const bloqueDeReglas = bloqueReglas(reglas, { conHashtags });

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
  // Una imagen sola se guiona igual: es texto que se lee sobre la imagen, no que se dice.
  const esCarrusel = cuerpo.kind === 'carrusel' || cuerpo.kind === 'imagen';

  const baseGuion = esCarrusel
    ? 'Sos guionista de contenido para redes sociales. Escribís el texto que va ESCRITO EN ' +
      'CADA PLACA de un carrusel de Instagram.' + conAngulo + ' ' +
      'Esto NO es el pie de la publicación: el pie es otro pedido y no lo tenés que escribir. ' +
      'Nada de hashtags, nada de emojis, nada de "link en bio". ' +
      voz + bloqueProductos + bloqueDeReglas +
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
      voz + bloqueProductos + bloqueDeReglas +
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
    voz + bloqueProductos + bloqueDeReglas +
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
  //
  // Cada intento tiene su propio reloj, y si el modelo de turno está saturado se prueba con
  // el siguiente de la lista. Vercel corta la función a los 30 segundos y devuelve un 504
  // pelado, sin cuerpo: llegar hasta ahí es perder el pedido entero y encima sin explicación,
  // así que acá se corta antes y con criterio propio.
  const arranque = Date.now();
  const TOPE_LLAMADA = 11000;   // por intento
  const TOPE_TOTAL = 26000;     // el techo de Vercel es 30s: se deja aire para responder

  // Los modelos Flash del 2.5 en adelante "piensan" antes de contestar, y ese razonamiento
  // previo multiplica la demora. Para un copy de 500 caracteres no aporta nada, así que se
  // apaga. Como se apunta a un alias y no a una versión fija, la versión de turno puede no
  // conocer el campo: si Google lo rechaza por nombre, se reintenta sin él y se recuerda.
  let sinPensar = true;

  const pedirle = async (modelo, prompt) => {
    const reloj = new AbortController();
    const corte = setTimeout(()=> reloj.abort(), TOPE_LLAMADA);
    const cuerpoPedido = { contents: [{ parts: [{ text: prompt }] }] };
    if (sinPensar) cuerpoPedido.generationConfig = { thinkingConfig: { thinkingBudget: 0 } };
    try{
      const respuesta = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify(cuerpoPedido),
          signal: reloj.signal
        }
      );
      return await respuesta.json();
    }catch(err){
      if (err && err.name === 'AbortError') {
        const e = new Error('El modelo no contestó a tiempo.');
        e.demoro = true;
        throw e;
      }
      throw err;
    }finally{
      clearTimeout(corte);
    }
  };

  // Errores que mejoran probando con otro modelo: saturación, límite por minuto, o un alias
  // que Google dejó de publicar. Una clave inválida o un pedido rechazado por contenido no
  // mejoran cambiando de modelo, así que esos cortan de una y se muestran tal cual.
  const esPasajero = (mensaje, codigo) =>
    codigo === 429 || codigo === 500 || codigo === 503 || codigo === 404 ||
    /overload|sobrecarg|unavailable|try again|rate limit|quota|not found|deadline/i.test(mensaje || '');

  const llamar = async (prompt) => {
    let ultimo = null;
    for (const modelo of MODELOS) {
      // Sin tiempo para otro intento completo, mejor devolver el error que quedarse colgado
      // hasta que Vercel corte.
      if (Date.now() - arranque > TOPE_TOTAL - TOPE_LLAMADA) break;
      try{
        let json = await pedirle(modelo, prompt);
        // El modelo rechazó el pedido y lo único fuera de lo común que le mandamos es el
        // thinkingConfig, así que se prueba una vez sin él. Google no siempre dice qué campo
        // le molestó: a veces contesta "Unknown name thinkingConfig" y a veces un escueto
        // "Request contains an invalid argument", que es lo que devolvían los modelos que
        // directamente no conocen el campo.
        const rechazoElAjuste = json.error && sinPensar &&
          (/thinking/i.test(json.error.message || '') ||
           json.error.code === 400 ||
           /invalid argument/i.test(json.error.message || ''));
        if (rechazoElAjuste) {
          sinPensar = false;
          json = await pedirle(modelo, prompt);
        }
        if (json.error) {
          const e = new Error(json.error.message || 'Error de la API de Gemini');
          e.deGoogle = true;
          e.codigo = json.error.code || 0;
          throw e;
        }
        const texto = json.candidates &&
                      json.candidates[0] &&
                      json.candidates[0].content &&
                      json.candidates[0].content.parts &&
                      json.candidates[0].content.parts[0] &&
                      json.candidates[0].content.parts[0].text;
        if (texto && texto.trim()) return texto.trim();
        ultimo = new Error('El modelo no devolvió texto.');
        ultimo.demoro = true;   // vacío sin motivo: se prueba con el siguiente
      }catch(err){
        ultimo = err;
        const conviene = err.demoro || (err.deGoogle && esPasajero(err.message, err.codigo));
        if (!conviene) throw err;   // este error no lo arregla cambiar de modelo
      }
    }
    // Se agotaron los modelos. El mensaje de Google acá no sirve de nada —"the model is
    // overloaded" no le dice qué hacer a nadie—, así que se traduce a algo accionable.
    if (ultimo && (ultimo.demoro || (ultimo.deGoogle && esPasajero(ultimo.message, ultimo.codigo)))) {
      const e = new Error('Gemini está saturado en este momento. Esperá unos segundos y probá de nuevo.');
      e.demoro = true;
      throw e;
    }
    throw ultimo || new Error('No se pudo generar el texto.');
  };
  try {
    let texto = await llamar(base);
    if (!texto) return res.status(502).json({ error: 'Gemini no devolvió texto. Probá de nuevo.' });

    // Un solo reintento si se pasó de largo: se le devuelve su propio texto para que lo
    // condense en vez de escribir otro distinto, así no se pierde lo que ya estaba bien.
    // Uno solo y no varios porque cada vuelta suma varios segundos de espera.
    //
    // Y solo si queda tiempo. Un copy unos caracteres más largo es un problema chico; que la
    // función se pase de los 30 segundos y devuelva un 504 sin texto es perder todo lo que ya
    // se había generado.
    const quedaTiempo = (Date.now() - arranque) < (TOPE_TOTAL - TOPE_LLAMADA);
    if (texto.length > largoMax * MARGEN && quedaTiempo) {
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

    // Reglas de la marca que no se respetaron: se le devuelve el texto para que corrija solo
    // eso, una vez y si queda tiempo, igual que con el largo. Lo que quede se avisa.
    let avisos = incumplidas(texto, reglas, { conHashtags });
    if (avisos.length && (Date.now() - arranque) < (TOPE_TOTAL - TOPE_LLAMADA)) {
      try {
        const corregido = await llamar(
          'Corregí este texto para que cumpla las reglas de la marca, cambiando lo mínimo ' +
          'indispensable: mismo tono, mismo formato, mismo largo aproximado' +
          (conHashtags ? ' y la misma cantidad de hashtags' : '') + '. ' +
          'Problemas a resolver: ' + avisos.join('; ') + '.\n\n' + bloqueDeReglas + voz +
          'Devolvé SOLO el texto corregido, sin explicaciones ni comillas.\n\n' + texto
        );
        const quedan = corregido ? incumplidas(corregido, reglas, { conHashtags }) : avisos;
        if (corregido && quedan.length < avisos.length) { texto = corregido; avisos = quedan; }
      } catch (e) { /* se devuelve el que había, con su aviso */ }
    }

    // Se devuelve el largo pedido para que la interfaz sepa contra qué comparar y pueda
    // avisar, en vez de recortar por su cuenta.
    return res.status(200).json({ text: texto, maxLen: largoMax, avisos });
  } catch (err) {
    if (err && err.demoro) return res.status(504).json({ error: err.message });
    if (err && err.deGoogle) return res.status(502).json({ error: err.message });
    return res.status(502).json({ error: 'No se pudo contactar a Gemini: ' + err.message });
  }
};
