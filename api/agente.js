// Asistente de contenido. Lee el mes de la marca, responde lo que se le pide y, cuando el
// pedido implica tocar el calendario, DEVUELVE los cambios propuestos en vez de aplicarlos.
//
// Esa separación es deliberada: el agente nunca escribe en la base. Propone, el navegador
// muestra la lista, la persona confirma, y recién ahí se guarda por el camino de siempre
// (/api/datos), que ya verifica permisos. Así un pedido mal interpretado no puede arruinar
// un mes de trabajo, y el agente no necesita permiso de escritura sobre nada.

const { resolverToken, leerClaves } = require('../lib/acceso');

const MODELO = 'gemini-flash-latest';
const MAX_PEDIDO = 1500;

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
- Cada día puede tener posteos de feed (reel o carrusel) y stories.
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
- Usá solo días del mes que te pasaron.
- En "angulo" usá el nombre EXACTO de uno de los ángulos disponibles, o dejalo vacío si ninguno encaja.
- En "modificar" y "eliminar", el itemId tiene que ser uno de los que figuran en el calendario.
- Explicá en "respuesta" qué vas a hacer y por qué, en una o dos frases. La persona va a ver tu
  lista de cambios y decidir si la aplica.`;

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Usá POST.' });
  }
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Falta configurar GEMINI_API_KEY en Vercel.' });

  const { token, pedido, anio, mes } = req.body || {};

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
    feed.forEach(it => resumen.push(linea(it, it.kind === 'carrusel' ? 'carrusel' : 'reel')));
    stories.forEach(it => resumen.push(linea(it, 'story')));
  }

  const contexto = [
    `Mes del calendario: ${m + 1}/${a} (${diasDelMes} días).`,
    `Hoy es ${new Date().toISOString().slice(0, 10)}.`,
    `Ángulos disponibles: ${angulos.length ? angulos.map(x => x.name).join(' | ') : '(la marca no definió ninguno)'}`,
    '',
    'Contenido cargado:',
    resumen.length ? resumen.join('\n') : '  (el mes está completamente vacío)',
    '',
    'Pedido de la persona:',
    texto
  ].join('\n');

  try {
    const respuesta = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODELO}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: INSTRUCCIONES }] },
          contents: [{ parts: [{ text: contexto }] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0.7 }
        })
      }
    );
    const json = await respuesta.json();
    if (json.error) return res.status(502).json({ error: json.error.message || 'Error de Gemini' });

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

    const cambios = Array.isArray(parsed.cambios) ? parsed.cambios : [];
    const validos = cambios.filter(c =>
      c && ['agregar', 'modificar', 'eliminar'].includes(c.accion) &&
      typeof c.dia === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(c.dia) &&
      c.dia.startsWith(`${a}-${String(m + 1).padStart(2, '0')}`) // nunca fuera del mes pedido
    );

    return res.status(200).json({
      respuesta: String(parsed.respuesta || '').slice(0, 6000),
      cambios: validos.slice(0, 40), // techo por si propone una lista desmedida
      descartados: cambios.length - validos.length
    });
  } catch (err) {
    return res.status(502).json({ error: 'No se pudo contactar al asistente: ' + err.message });
  }
};
