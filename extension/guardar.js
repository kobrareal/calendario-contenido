// Ventana de guardado: muestra lo capturado y deja completar título, tipo, ángulo y —si la
// sesión es de administrador— a qué calendario va.
//
// El borrador no viaja por la URL: una imagen en base64 son cientos de miles de caracteres
// y no entra. El service worker lo deja en chrome.storage.session y acá se lo retira.

const SITIO = 'https://calendario-contenido-kappa.vercel.app';
const $ = (id) => document.getElementById(id);

let sesion = null;
let borrador = null;
let tipoElegido = '';
// Los ángulos de cada marca son distintos, así que se recuerdan por marca ya leída para no
// volver a pedirlos si se cambia de destino y se vuelve.
const angulosPorMarca = {};

// ---------- API ----------
async function pedir(cuerpo) {
  const res = await fetch(SITIO + '/api/datos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo)
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error((json && json.error) || ('http ' + res.status));
  return json;
}

const claveDe = (slug, dato) => (slug ? slug + ':' : '') + dato;

// ---------- ángulos del calendario elegido ----------
async function cargarAngulos(slug) {
  const sel = $('angulo');
  if (angulosPorMarca[slug]) { pintarAngulos(angulosPorMarca[slug]); return; }

  sel.innerHTML = '<option value="">Cargando…</option>';
  sel.disabled = true;
  let lista = [];
  try {
    const r = await pedir({ token: sesion.token, accion: 'get', key: claveDe(slug, 'angles') });
    lista = JSON.parse(r.value || '[]') || [];
  } catch (e) { lista = []; }
  angulosPorMarca[slug] = lista;
  pintarAngulos(lista);
}

function pintarAngulos(lista) {
  const sel = $('angulo');
  const previo = sel.value;
  sel.innerHTML = '<option value="">Sin ángulo</option>';
  lista.forEach(a => {
    const o = document.createElement('option');
    o.value = a.id;
    o.textContent = (a.emoji ? a.emoji + ' ' : '') + a.name;
    sel.appendChild(o);
  });
  // Si el ángulo elegido existe también en la marca nueva, se conserva.
  if (previo && lista.some(a => a.id === previo)) sel.value = previo;
  sel.disabled = false;
}

// ---------- arranque ----------
(async function arrancar() {
  const guardado = await chrome.storage.session.get(['borrador', 'sesion']);
  borrador = guardado.borrador;
  sesion = guardado.sesion;

  if (!borrador || !sesion) {
    $('aviso').className = 'aviso mal';
    $('aviso').textContent = 'No se encontró lo que se iba a guardar. Cerrá y probá de nuevo.';
    $('guardar').disabled = true;
    return;
  }

  // Previa de lo capturado, para confirmar que es lo que se quiso guardar.
  if (borrador.thumb) {
    $('previaImg').src = borrador.thumb;
    $('previaImg').onerror = () => { $('previa').hidden = true; };
    $('previaTitulo').textContent = borrador.tituloPagina || 'Referencia';
    $('previaSitio').textContent = borrador.link || '';
    $('previaPlay').hidden = !borrador.esVideo;
    if (borrador.esVideo) {
      $('previaNota').textContent = 'Fotograma del video. El enlace queda guardado para verlo completo.';
      $('previaNota').hidden = false;
    }
    $('previa').hidden = false;
  } else if (borrador.esVideo) {
    // Sin fotograma la idea se guarda igual, pero conviene decir por qué no hay imagen en
    // vez de dejar un hueco sin explicación.
    $('previaTitulo').textContent = borrador.tituloPagina || 'Referencia';
    $('previaSitio').textContent = borrador.link || '';
    $('previaImg').style.display = 'none';
    $('previaNota').textContent = 'No se pudo capturar el fotograma' +
      (borrador.avisoCaptura ? ' (' + borrador.avisoCaptura + ')' : '') +
      '. La idea se guarda con el enlace al video.';
    $('previaNota').hidden = false;
    $('previa').hidden = false;
  }

  $('texto').value = borrador.texto || '';
  $('link').value = borrador.link || '';

  // El administrador elige destino. Arranca sin preseleccionar: que el desplegable venga
  // con una marca puesta es justo cómo una idea termina en el calendario equivocado.
  if (sesion.rol === 'admin') {
    const sel = $('marca');
    sel.innerHTML = '<option value="__elegir__">Elegí el calendario…</option><option value="">Calendario principal</option>';
    try {
      const { marcas } = await pedir({ token: sesion.token, accion: 'marcas' });
      (marcas || []).forEach(m => {
        const o = document.createElement('option');
        o.value = m.slug;
        o.textContent = m.nombre || m.slug;
        sel.appendChild(o);
      });
    } catch (e) { /* queda al menos el principal */ }
    sel.value = '__elegir__';
    $('campoMarca').hidden = false;
    sel.addEventListener('change', () => {
      if (sel.value !== '__elegir__') cargarAngulos(sel.value);
      else pintarAngulos([]);
    });
  } else {
    // Una marca tiene un solo destino posible y el servidor no la deja escribir en otro.
    await cargarAngulos(sesion.slug || '');
  }

  $('texto').focus();
  $('texto').select();
})();

// ---------- tipo de posteo ----------
$('tipos').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-kind]');
  if (!btn) return;
  // Volver a tocar el que ya estaba elegido lo deselecciona: sin eso no habría forma de
  // volver a "sin tipo" después de haber elegido uno.
  tipoElegido = (tipoElegido === btn.dataset.kind) ? '' : btn.dataset.kind;
  $('tipos').querySelectorAll('button').forEach(b => {
    b.classList.toggle('elegido', b.dataset.kind === tipoElegido);
  });
});

// ---------- guardar ----------
$('cancelar').addEventListener('click', () => window.close());

$('guardar').addEventListener('click', async () => {
  const aviso = $('aviso');
  aviso.className = 'aviso';
  aviso.textContent = '';

  const texto = $('texto').value.trim();
  if (!texto) {
    aviso.className = 'aviso mal';
    aviso.textContent = 'Escribí de qué se trata la idea.';
    $('texto').focus();
    return;
  }

  let slug;
  if (sesion.rol === 'admin') {
    slug = $('marca').value;
    if (slug === '__elegir__') {
      aviso.className = 'aviso mal';
      aviso.textContent = 'Elegí a qué calendario va la idea.';
      $('marca').focus();
      return;
    }
  } else {
    slug = sesion.slug || '';
  }

  const clave = claveDe(slug, 'ideas');
  $('guardar').disabled = true;
  $('guardar').textContent = 'Guardando…';

  try {
    // Se relee justo antes de escribir: si el calendario está abierto en otra pestaña,
    // guardar sobre una copia vieja se llevaría puesto lo que se agregó en el medio.
    const actual = await pedir({ token: sesion.token, accion: 'get', key: clave });
    let ideas = [];
    try { ideas = JSON.parse(actual.value || '[]') || []; } catch (e) { ideas = []; }

    ideas.push({
      id: 'x' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36),
      text: texto.slice(0, 500),
      link: $('link').value.trim(),
      thumb: borrador.thumb || '',
      // El calendario lo usa para dibujar el ▶ sobre la miniatura: sin esto, un fotograma
      // se vería igual que una foto y no se sabría que hay un video detrás del enlace.
      esVideo: !!borrador.esVideo,
      angle: $('angulo').value || null,
      kind: tipoElegido,
      origen: 'extension',
      createdAt: new Date().toISOString()
    });

    await pedir({ token: sesion.token, accion: 'set', key: clave, value: JSON.stringify(ideas) });
    await chrome.storage.session.remove('borrador');

    aviso.className = 'aviso ok';
    aviso.textContent = '✓ Guardada. Cerrando…';
    setTimeout(() => window.close(), 700);
  } catch (e) {
    aviso.className = 'aviso mal';
    aviso.textContent = (e && e.message) || 'No se pudo guardar.';
    $('guardar').disabled = false;
    $('guardar').textContent = 'Guardar idea';
  }
});

// Enter con Ctrl guarda; Escape cierra. Atajos de formulario, nada más.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.close();
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('guardar').click();
});
