// Asistente de contenido. Lee el mes de la marca, responde lo que se le pide y, cuando el
// pedido implica tocar el calendario, DEVUELVE los cambios propuestos en vez de aplicarlos.
//
// Esa separación es deliberada: el agente nunca escribe en la base. Propone, el navegador
// muestra la lista, la persona confirma, y recién ahí se guarda por el camino de siempre
// (/api/datos), que ya verifica permisos. Así un pedido mal interpretado no puede arruinar
// un mes de trabajo, y el agente no necesita permiso de escritura sobre nada.

const { resolverToken, leerClaves } = require('../lib/acceso');
const { normalizarReglas, bloqueReglas } = require('../lib/reglas-ia');

// El de respaldo es el liviano: si el primero está saturado, contesta antes.
const MODELOS = ['gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-flash-lite-latest'];
const MAX_PEDIDO = 1500;
// Vercel corta la función a los 60 s y el navegador recibe un "http 504" sin explicación.
// Se trabaja con un presupuesto propio por debajo de ese techo para poder contestar algo útil.
// La función tiene hasta 300 s (vercel.json). Cada intento tiene su propio tope para que, si
// un modelo se cuelga, quede tiempo de probar con el siguiente en vez de esperarlo entero:
// cuando Gemini está lento, el liviano suele contestar en segundos.
const PRESUPUESTO_MS = 170000;
const TOPE_POR_INTENTO_MS = 55000;
const MINIMO_PARA_REINTENTAR_MS = 15000;
const AVISO_GRANDE = 'El pedido es muy grande para resolverlo de una sola vez y el asistente no llegó a tiempo. ' +
  'Probá dividirlo, por ejemplo por semana ("stories del 18 al 24"), o pedí menos días por vez.';

const INSTRUCCIONES = `Sos un estratega de contenido para redes sociales con años de experiencia
trabajando con marcas de rubros muy distintos: gastronomía, indumentaria, servicios profesionales,
salud y bienestar, educación, inmobiliario, turismo, oficios y comercios de barrio.

Cómo trabajás:
- Escribís en español rioplatense, tuteando de "vos", directo y sin vueltas.
- Sos honesto. Si el mes está flojo, desbalanceado o repetitivo, lo decís con claridad y explicás
  por qué. No halagás por cortesía: un elogio vacío le hace perder tiempo y plata a quien te lee.
- Sos concreto. "Sumá más valor" no sirve; "tenés 9 posteos de producto y ninguno de testimonio,
  y el testimonio es lo que más convierte en este rubro" sí.
- Pensás en objetivos de negocio, no en cantidad de posteos: qué mueve ventas, qué construye
  confianza, qué sostiene la comunidad entre campañas.
- Conocés los formatos: el reel gana alcance nuevo, el carrusel explica y se guarda, la story
  sostiene el vínculo diario y sirve para pedir respuestas.
- Cuando te piden consejos de producción (cómo filmar algo), das indicaciones ejecutables:
  encuadres, duración, qué decir en los primeros 3 segundos, qué mostrar, qué evitar.

Sobre el calendario que te pasan:
- Cada día puede tener posteos de feed (reel, carrusel o imagen sola) y stories.
- Cada posteo tiene un ángulo de contenido, que es la categoría temática que definió la marca.
- Un mes equilibrado no repite el mismo ángulo días seguidos ni concentra todo en una semana.

Respondé SIEMPRE con un único objeto JSON, sin texto alrededor y sin bloques de código, así:
{
  "respuesta": "lo que le decís a la persona, en texto plano, con saltos de línea si hace falta",
  "cambios": [ ... ]
}

"cambios" va vacío ([]) cuando te piden opinión, análisis o consejos: no inventes modificaciones
que nadie pidió. Solo lo llenás cuando el pedido es explícitamente para agregar, modificar o
sacar contenido del calendario.

Cada cambio es uno de estos tres:
{"accion":"agregar","dia":"YYYY-MM-DD","lista":"feed","kind":"reel","angulo":"nombre exacto de un ángulo o vacío","titulo":"título corto","texto":"idea o copy"}
{"accion":"agregar","dia":"YYYY-MM-DD","lista":"stories","angulo":"...","titulo":"...","texto":"..."}
{"accion":"modificar","dia":"YYYY-MM-DD","itemId":"id del posteo","titulo":"...","texto":"...","angulo":"..."}
{"accion":"eliminar","dia":"YYYY-MM-DD","itemId":"id del posteo"}

Reglas para los cambios:
- El campo "texto" no puede pasar de 480 caracteres contando espacios: apuntá a tres o cuatro
  frases cortas y cerrá la idea. Es preferible quedarse corto que pasarse, y nunca dejes una
  frase por la mitad para entrar en el largo.
- Si vas a proponer más de 12 cambios, cada "texto" va en una o dos frases (máximo 200
  caracteres) con la idea concreta: la persona la desarrolla después. Y la "respuesta" en
  dos o tres frases. Una lista larga con textos largos no llega a tiempo.
- La marca habla siempre en plural, como equipo: "diseñamos", "preparamos", "te mostramos".
  Nunca en primera persona del singular. Se escribe "Diseñamos este buzo", no "Diseñé este buzo".
- Si te pasan un catálogo, el contenido de producto tiene que ser sobre esos productos y con
  las características que dice ahí: no inventes productos ni les agregues cosas que no figuran.
  Los que están sin stock no se ofrecen para vender (sí se puede avisar que se agotaron o que
  vuelven), y los "por lanzarse" solo sirven para contenido de expectativa.
- Usá solo días del mes que te pasaron.
- En "angulo" usá el nombre EXACTO de uno de los ángulos disponibles, o dejalo vacío si ninguno encaja.
- En "modificar" y "eliminar", el itemId tiene que ser uno de los que figuran en el calendario.
- Explicá en "respuesta" qué vas a hacer y por qué, en una o dos frases. La persona va a ver tu
  lista de cambios y decidir si la aplica.`;

// Planificador. No resuelve el pedido: decide si conviene hacerlo de una vez o en tandas
// cortas que el navegador va pidiendo una por una. Un pedido largo resuelto de una sola vez
// genera una respuesta enorme que tarda más de lo que la función puede esperar.
const INSTRUCCIONES_PLAN = `Sos el planificador de un asistente de contenido para redes sociales.
NO resolvés el pedido: decidís si conviene resolverlo en una sola tanda o dividirlo en partes
chicas que se resuelven una por una, en orden.

Respondé SOLO con un objeto JSON, sin texto alrededor:
{"resumen":"una frase en español rioplatense contando qué se va a hacer","tareas":[{"titulo":"Stories del 18 al 24","pedido":"...","desde":"YYYY-MM-DD","hasta":"YYYY-MM-DD"}]}

Reglas:
- Si el pedido es un análisis, una opinión o un consejo, o implica pocos cambios (8 o menos),
  devolvé UNA sola tarea con el pedido original tal cual y "desde" y "hasta" vacíos.
- Si implica muchos cambios (más de 8) o abarca muchos días, dividilo en tandas de como máximo
  7 días o unos 8 cambios cada una: entre 2 y 6 tareas, en orden cronológico, sin superponer
  fechas y cubriendo todo el rango pedido. Si mezcla cosas distintas (por ejemplo stories y
  reels) también podés separar por tipo.
- Cada "pedido" se tiene que entender solo: repetí lo esencial del pedido original (qué
  contenido, tono, condiciones como "no siempre de producto") y aclarale su rango de fechas.
- Usá solo fechas del mes del calendario. "Desde hoy" arranca en la fecha de hoy.
- "titulo" es corto y sirve para mostrarle el avance a la persona.`;
const MAX_TAREAS = 6;

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Usá POST.' });
  }
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Falta configurar GEMINI_API_KEY en Vercel.' });

  const { token, pedido, anio, mes } = req.body || {};
  // modo "planificar": devuelve las tandas. Sin modo: resuelve el pedido (o una parte de uno,
  // si viene "parte" con el pedido general y el rango de fechas de esa tanda).
  const modo = (req.body || {}).modo === 'planificar' ? 'planificar' : 'resolver';
  const fecha = (x) => (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x) ? x : '');
  const parteIn = (req.body || {}).parte;
  const parte = parteIn && typeof parteIn === 'object' ? {
    general: String(parteIn.general || '').trim().slice(0, MAX_PEDIDO),
    desde: fecha(parteIn.desde), hasta: fecha(parteIn.hasta)
  } : null;
  // Lo ya propuesto en tandas anteriores, para que no repita ideas ni títulos.
  const previos = Array.isArray((req.body || {}).previos)
    ? (req.body || {}).previos.slice(0, 80).map(x => String(x).replace(/\s+/g, ' ').slice(0, 140)) : [];

  let sesion;
  try { sesion = await resolverToken(token); }
  catch (e) { return res.status(502).json({ error: 'No se pudo verificar el acceso.' }); }
  if (!sesion) return res.status(401).json({ error: 'Link inválido o dado de baja.' });

  const texto = String(pedido || '').trim().slice(0, MAX_PEDIDO);
  if (!texto) return res.status(400).json({ error: 'Escribí qué querés pedirle al asistente.' });

  const a = Number(anio), m = Number(mes); // mes 0-11, como lo maneja el calendario
  if (!Number.isInteger(a) || !Number.isInteger(m) || m < 0 || m > 11) {
    return res.status(400).json({ error: 'Mes inválido.' });
  }

  // El prefijo sale de la sesión, nunca de lo que mande el navegador: si viniera del cliente,
  // una marca podría pedir el mes de otra escribiendo otro prefijo.
  const pref = sesion.rol === 'admin' ? String((req.body || {}).cliente || '') : sesion.slug;
  const conPrefijo = (k) => (pref ? pref + ':' + k : k);

  const diasDelMes = new Date(a, m + 1, 0).getDate();
  const claves = [];
  for (let d = 1; d <= diasDelMes; d++) {
    claves.push(conPrefijo(`${a}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`));
  }
  claves.push(conPrefijo('angles'));

  let datos = {};
  try { datos = await leerClaves(sesion, claves); }
  catch (e) { return res.status(502).json({ error: 'No se pudo leer el calendario.' }); }

  // Se arma un resumen y no se manda el JSON crudo: las imágenes van embebidas en cada día y
  // llenarían el pedido de miles de caracteres de datos binarios sin ningún valor para el análisis.
  let angulos = [];
  try { angulos = JSON.parse(datos[conPrefijo('angles')] || '[]'); } catch (e) { angulos = []; }

  const resumen = [];
  for (let d = 1; d <= diasDelMes; d++) {
    const dia = `${a}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    let entrada;
    try { entrada = JSON.parse(datos[conPrefijo(dia)] || '{}'); } catch (e) { continue; }
    const feed = Array.isArray(entrada.feed) ? entrada.feed : [];
    const stories = Array.isArray(entrada.stories) ? entrada.stories : [];
    if (!feed.length && !stories.length) continue;
    const linea = (it, tipo) => {
      const ang = (angulos.find(x => x.id === it.angle) || {}).name || 'sin ángulo';
      const t = (it.title || it.text || it.context || '').replace(/\s+/g, ' ').slice(0, 90);
      return `    [${it.id}] ${tipo} | ${ang}${it.time ? ' | ' + it.time : ''}${t ? ' | ' + t : ''}`;
    };
    resumen.push(`  ${dia}:`);
    feed.forEach(it => resumen.push(linea(it, ['carrusel', 'imagen'].includes(it.kind) ? it.kind : 'reel')));
    stories.forEach(it => resumen.push(linea(it, 'story')));
  }

  // Catálogo de la marca. Es lo que separa "proponé contenido de producto" de "proponé
  // contenido sobre el Buzo Alaska, que es de frisa peinada y está disponible".
  const catalogo = String((req.body || {}).productos || '').trim().slice(0, 8000);
  // Las reglas de estilo valen para todo texto que el asistente proponga ("titulo" y "texto").
  const reglas = bloqueReglas(normalizarReglas((req.body || {}).reglas));

  // Día de la semana de cada fecha: sin esto la IA lo adivina y escribe "este martes" en un
  // miércoles. "Hoy" en hora argentina (UTC−3), no la del servidor.
  const DIAS_SEMANA = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  const hoy = new Date(Date.now() - 3 * 3600 * 1000);
  const hoyTexto = `${hoy.toISOString().slice(0, 10)} (${DIAS_SEMANA[hoy.getUTCDay()]})`;
  const semanaDelMes = Array.from({ length: diasDelMes }, (_, i) =>
    `${i + 1} ${DIAS_SEMANA[new Date(Date.UTC(a, m, i + 1)).getUTCDay()].slice(0, 3)}`).join(', ');

  const fechasDelMes = [
    `Mes del calendario: ${m + 1}/${a} (${diasDelMes} días).`,
    `Hoy es ${hoyTexto}.`,
    `Día de la semana de cada fecha del mes: ${semanaDelMes}.`
  ];
  const pedidoFinal = parte && parte.general ? [
    'Pedido general de la persona (se resuelve por tandas):',
    parte.general,
    '',
    'Resolvé SOLO esta tanda:',
    texto,
    (parte.desde && parte.hasta) ? `Proponé cambios únicamente para fechas entre ${parte.desde} y ${parte.hasta}.` : '',
    previos.length ? 'Ya se propuso esto en tandas anteriores (no repitas estas ideas ni estos títulos):\n' + previos.map(p => '- ' + p).join('\n') : '',
    'En "respuesta" contá en una frase qué propusiste para esta tanda.'
  ] : ['Pedido de la persona:', texto];

  const contexto = modo === 'planificar'
    ? [...fechasDelMes, '', 'Pedido de la persona:', texto].join('\n')
    : [
    `Mes del calendario: ${m + 1}/${a} (${diasDelMes} días).`,
    `Hoy es ${hoyTexto}.`,
    `Día de la semana de cada fecha del mes (usalo siempre que nombres un día): ${semanaDelMes}.`,
    `Ángulos disponibles: ${angulos.length ? angulos.map(x => x.name).join(' | ') : '(la marca no definió ninguno)'}`,
    '',
    catalogo ? 'Catálogo de la marca:\n' + catalogo + '\n' : '',
    reglas ? reglas.trim() + '\nAplicalas a todo título y texto que propongas en "cambios".\n' : '',
    'Contenido cargado:',
    resumen.length ? resumen.join('\n') : '  (el mes está completamente vacío)',
    '',
    ...pedidoFinal
  ].filter(l => l !== '').join('\n');
  const instrucciones = modo === 'planificar' ? INSTRUCCIONES_PLAN : INSTRUCCIONES;

  // Un pedido a Gemini con su propio reloj. Sin razonamiento ("thinking"): para proponer
  // contenido no aporta y es lo que más demora; con listas largas hacía pasar la función de
  // los 60 s. Algunos modelos no aceptan thinkingConfig: en ese caso se repite sin él.
  const pedirAGemini = async (modelo, ms, sinPensar = true) => {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: instrucciones }] },
          contents: [{ parts: [{ text: contexto }] }],
          generationConfig: Object.assign(
            { responseMimeType: 'application/json', temperature: 0.7, maxOutputTokens: 8192 },
            sinPensar ? { thinkingConfig: { thinkingBudget: 0 } } : {})
        }),
        signal: AbortSignal.timeout(ms)
      }
    );
    const j = await r.json();
    if (sinPensar && j.error && (j.error.code === 400 || /thinking|invalid argument/i.test(j.error.message || ''))) {
      return pedirAGemini(modelo, ms, false);
    }
    return j;
  };
  const saturado = (e) => e && (e.code === 429 || e.code === 500 || e.code === 503 ||
    /overloaded|unavailable|high demand|quota|exhausted/i.test(e.message || ''));

  const arranque = Date.now();
  const intentos = []; // para el registro de Vercel: qué modelo, cómo terminó y cuánto tardó
  try {
    let json = null, ultimoError = null, vencio = false;
    for (const modelo of MODELOS) {
      const queda = PRESUPUESTO_MS - (Date.now() - arranque);
      if (intentos.length && queda < MINIMO_PARA_REINTENTAR_MS) break;
      const t0 = Date.now();
      try {
        json = await pedirAGemini(modelo, Math.min(TOPE_POR_INTENTO_MS, queda));
      } catch (e) {
        if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
          // Se colgó: se prueba con el siguiente modelo mientras quede tiempo.
          vencio = true; json = null;
          intentos.push(`${modelo}: venció a los ${Math.round((Date.now() - t0) / 1000)} s`);
          continue;
        }
        throw e;
      }
      intentos.push(`${modelo}: ${json.error ? 'error ' + (json.error.code || '') + ' (' + String(json.error.message || '').slice(0, 160) + ')' : 'ok'} en ${Math.round((Date.now() - t0) / 1000)} s`);
      if (!json.error) { vencio = false; break; }
      ultimoError = json.error;
      if (!saturado(json.error)) break; // un error de otro tipo no se arregla cambiando de modelo
    }
    console.log('[agente]', intentos.join(' · '), '| contexto', contexto.length, 'caracteres');
    if (vencio && !json) return res.status(504).json({ error: AVISO_GRANDE });
    if (!json || json.error) {
      const e = (json && json.error) || ultimoError || {};
      return res.status(502).json({ error: saturado(e)
        ? 'La IA está saturada en este momento. Probá de nuevo en un minuto.'
        : (e.message || 'Error de Gemini') });
    }

    const salida = json.candidates && json.candidates[0] && json.candidates[0].content &&
      json.candidates[0].content.parts && json.candidates[0].content.parts[0] &&
      json.candidates[0].content.parts[0].text;
    if (!salida) return res.status(502).json({ error: 'El asistente no devolvió nada. Probá de nuevo.' });

    let parsed;
    try {
      // Por las dudas, se limpian los ``` que a veces envuelven la respuesta.
      parsed = JSON.parse(String(salida).replace(/^```(?:json)?/i, '').replace(/```$/, '').trim());
    } catch (e) {
      // Si no vino JSON válido, al menos se le muestra el texto en vez de un error seco.
      return res.status(200).json({ respuesta: String(salida).slice(0, 4000), cambios: [] });
    }

    if (modo === 'planificar') {
      const enElMes = (d) => d && d.startsWith(`${a}-${String(m + 1).padStart(2, '0')}`);
      const tareas = (Array.isArray(parsed.tareas) ? parsed.tareas : [])
        .filter(t => t && String(t.pedido || '').trim())
        .slice(0, MAX_TAREAS)
        .map(t => {
          const desde = enElMes(fecha(t.desde)) ? t.desde : '', hasta = enElMes(fecha(t.hasta)) ? t.hasta : '';
          return { titulo: String(t.titulo || '').slice(0, 80), pedido: String(t.pedido).slice(0, MAX_PEDIDO),
            desde: desde && hasta ? desde : '', hasta: desde && hasta ? hasta : '' };
        });
      return res.status(200).json({ resumen: String(parsed.resumen || '').slice(0, 400), tareas, intentos });
    }

    const cambios = Array.isArray(parsed.cambios) ? parsed.cambios : [];
    const validos = cambios.filter(c =>
      c && ['agregar', 'modificar', 'eliminar'].includes(c.accion) &&
      typeof c.dia === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(c.dia) &&
      c.dia.startsWith(`${a}-${String(m + 1).padStart(2, '0')}`) && // nunca fuera del mes pedido
      (!parte || !parte.desde || (c.dia >= parte.desde && c.dia <= parte.hasta)) // ni fuera de su tanda
    );

    return res.status(200).json({
      respuesta: String(parsed.respuesta || '').slice(0, 6000),
      cambios: validos.slice(0, 40), // techo por si propone una lista desmedida
      descartados: cambios.length - validos.length,
      intentos // qué modelo contestó y en cuánto (sirve para diagnosticar demoras)
    });
  } catch (err) {
    return res.status(502).json({ error: 'No se pudo contactar al asistente: ' + err.message });
  }
};
