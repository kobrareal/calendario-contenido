// Reglas de estilo que cada marca define en su kit ("Reglas para la IA"): palabras a evitar,
// hashtags prohibidos, hashtags que van siempre y reglas libres.
//
// Dos usos: armar el bloque de instrucciones que se le agrega al pedido, y revisar el texto
// que volvió. La revisión existe porque los modelos cumplen estas listas casi siempre, no
// siempre: una muletilla prohibida se cuela cada tanto, sobre todo en textos largos.

const MAX = { evitar: 60, hashtags: 60, fijos: 4, libres: 2000 };

// Lo que llega del navegador se vuelve a limpiar acá: es texto libre de quien lo escribió.
function normalizarReglas(r) {
  if (!r || typeof r !== 'object') return null;
  const lista = (x, n) => (Array.isArray(x) ? x : []).map(v => String(v || '').trim()).filter(Boolean).slice(0, n);
  const hashtags = (x, n) => lista(x, n).map(h => h.replace(/^#+/, '').toLowerCase()).filter(h => /^[\p{L}\p{N}_]+$/u.test(h));
  const reglas = {
    evitar: lista(r.evitar, MAX.evitar).map(p => p.slice(0, 80)),
    hashtagsNo: hashtags(r.hashtagsNo, MAX.hashtags),
    hashtagsFijos: hashtags(r.hashtagsFijos, MAX.fijos),
    libres: String(r.libres || '').trim().slice(0, MAX.libres)
  };
  const hay = reglas.evitar.length || reglas.hashtagsNo.length || reglas.hashtagsFijos.length || reglas.libres;
  return hay ? reglas : null;
}

// conHashtags: false para guiones y textos sin hashtags (las reglas de hashtags no aplican).
function bloqueReglas(reglas, { conHashtags = true } = {}) {
  if (!reglas) return '';
  const lineas = [];
  if (reglas.evitar.length) lineas.push('- No uses NUNCA estas palabras ni frases, ni variantes con otra conjugación o en mayúsculas: ' + reglas.evitar.map(p => '"' + p + '"').join(', ') + '.');
  if (conHashtags && reglas.hashtagsNo.length) lineas.push('- No uses NUNCA estos hashtags: ' + reglas.hashtagsNo.map(h => '#' + h).join(' ') + '.');
  if (conHashtags && reglas.hashtagsFijos.length) lineas.push('- Estos hashtags van SIEMPRE, y cuentan dentro de los hashtags del final: ' + reglas.hashtagsFijos.map(h => '#' + h).join(' ') + '.');
  if (reglas.libres) lineas.push('- ' + reglas.libres.replace(/\n+/g, '\n- '));
  return lineas.length
    ? 'REGLAS DE LA MARCA. Son obligatorias y mandan sobre cualquier otra indicación de estilo de este pedido:\n' + lineas.join('\n') + '\n\n'
    : '';
}

// Comparación sin tildes ni mayúsculas, y por palabra entera: "descubrí" no tiene que saltar
// con "descubrimiento", pero sí con "Descubri".
const plano = (t) => String(t).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
function contiene(texto, frase) {
  const f = plano(frase).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(^|[^\\p{L}\\p{N}])' + f + '($|[^\\p{L}\\p{N}])', 'u').test(plano(texto));
}

// Qué reglas no se cumplieron, en palabras para mostrarle a la persona.
function incumplidas(texto, reglas, { conHashtags = true } = {}) {
  if (!reglas) return [];
  const fallas = [];
  reglas.evitar.filter(p => contiene(texto, p)).forEach(p => fallas.push('quedó "' + p + '"'));
  if (conHashtags) {
    const usados = (String(texto).match(/#[\p{L}\p{N}_]+/gu) || []).map(h => h.slice(1).toLowerCase());
    reglas.hashtagsNo.filter(h => usados.includes(h)).forEach(h => fallas.push('quedó #' + h));
    reglas.hashtagsFijos.filter(h => !usados.includes(h)).forEach(h => fallas.push('falta #' + h));
  }
  return fallas;
}

module.exports = { normalizarReglas, bloqueReglas, incumplidas };
