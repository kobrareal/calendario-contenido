// Service worker de la extensión: arma el menú del click derecho y guarda la idea.
//
// Dos decisiones que valen la pena explicar:
//
// 1. Cuando la sesión es de administrador, el menú abre un submenú con una marca por
//    entrada. No hay "marca activa" guardada en ningún lado a propósito: un selector que
//    se configura una vez y después se olvida es exactamente cómo una idea de un cliente
//    termina en el calendario de otro. Acá cada guardado es una elección explícita.
//    Con una sesión de marca hay un solo destino posible y el submenú no aparece.
//
// 2. El aislamiento real no lo hace este archivo, lo hace el servidor (lib/acceso.js).
//    Una sesión de marca solo puede escribir claves que arranquen con su propio nombre,
//    así que ni un error de acá ni una extensión modificada a mano pueden cruzar datos.

const SITIO = 'https://calendario-contenido-kappa.vercel.app';
const API = SITIO + '/api/datos';

// Ancho máximo de la miniatura que se guarda. Mismo criterio que el calendario: la idea
// necesita una referencia reconocible, no el original de 3000px, que además haría crecer
// la fila de la base sin necesidad.
const ANCHO_MAX = 900;
const CALIDAD = 0.72;

// ---------- sesión guardada ----------
async function leerSesion() {
  const { sesion } = await chrome.storage.local.get('sesion');
  return sesion || null;
}

// ---------- API del calendario ----------
async function pedir(cuerpo) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo)
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error((json && json.error) || ('http ' + res.status));
  return json;
}

// ---------- menú del click derecho ----------
// Se rearma entero cada vez: es más simple y más seguro que ir parcheando entradas
// cuando cambia la sesión o la lista de marcas.
async function armarMenu() {
  await chrome.contextMenus.removeAll();
  const sesion = await leerSesion();

  if (!sesion) {
    chrome.contextMenus.create({
      id: 'configurar',
      title: 'Conectar con mi Calendario de Contenido…',
      contexts: ['image', 'selection', 'page']
    });
    return;
  }

  const contextos = ['image', 'selection'];

  // Una sola marca: el menú guarda directo, sin preguntar nada.
  if (sesion.rol !== 'admin') {
    chrome.contextMenus.create({
      id: 'guardar::' + (sesion.slug || ''),
      title: 'Guardar como idea en ' + (sesion.nombre || 'mi calendario'),
      contexts: contextos
    });
    return;
  }

  // Administrador: un destino por marca, más el calendario principal (las claves sin
  // prefijo, que es lo que se ve al entrar sin ?cliente=).
  chrome.contextMenus.create({ id: 'raiz', title: 'Guardar como idea en', contexts: contextos });
  chrome.contextMenus.create({
    id: 'guardar::', parentId: 'raiz', title: 'Calendario principal', contexts: contextos
  });

  let marcas = [];
  try { marcas = (await pedir({ token: sesion.token, accion: 'marcas' })).marcas || []; }
  catch (e) { /* sin lista igual queda el calendario principal */ }

  marcas.forEach(m => {
    chrome.contextMenus.create({
      id: 'guardar::' + m.slug,
      parentId: 'raiz',
      title: m.nombre || m.slug,
      contexts: contextos
    });
  });
}

chrome.runtime.onInstalled.addListener(armarMenu);
chrome.runtime.onStartup.addListener(armarMenu);
// El popup avisa cuando alguien entra o sale, para rearmar los destinos.
chrome.runtime.onMessage.addListener((msg, _emisor, responder) => {
  if (msg && msg.tipo === 'sesionCambio') {
    armarMenu().then(() => responder({ ok: true }));
    return true; // respuesta asincrónica
  }
});

// ---------- traer la imagen ----------
// Se descarga desde la propia pestaña y no desde el service worker: así la extensión no
// necesita permiso permanente sobre todos los sitios, que es la advertencia que asusta al
// instalar. El permiso de la pestaña lo habilita el click en el menú, y dura ese momento.
//
// El recorrido es fetch -> blob -> bitmap -> canvas porque un canvas que dibuja una imagen
// de otro dominio queda "contaminado" y no se puede leer. Con un blob local eso no pasa.
async function bajarImagen(tabId, url, anchoMax, calidad) {
  const [resultado] = await chrome.scripting.executeScript({
    target: { tabId },
    args: [url, anchoMax, calidad],
    func: async (src, maxW, q) => {
      try {
        const res = await fetch(src, { credentials: 'omit' });
        if (!res.ok) return { error: 'http ' + res.status };
        const blob = await res.blob();
        const bitmap = await createImageBitmap(blob);
        const escala = Math.min(1, maxW / bitmap.width);
        const w = Math.round(bitmap.width * escala), h = Math.round(bitmap.height * escala);
        const lienzo = new OffscreenCanvas(w, h);
        lienzo.getContext('2d').drawImage(bitmap, 0, 0, w, h);
        const jpg = await lienzo.convertToBlob({ type: 'image/jpeg', quality: q });
        const dataUrl = await new Promise((ok, mal) => {
          const fr = new FileReader();
          fr.onload = () => ok(fr.result);
          fr.onerror = () => mal(new Error('no se pudo leer'));
          fr.readAsDataURL(jpg);
        });
        return { dataUrl };
      } catch (e) {
        return { error: (e && e.message) || 'falló la descarga' };
      }
    }
  });
  return (resultado && resultado.result) || { error: 'sin respuesta de la pestaña' };
}

// ---------- guardar ----------
function avisar(titulo, mensaje) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'iconos/icono-128.png',
    title: titulo,
    message: mensaje
  });
}

function idAlAzar() {
  return 'x' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'configurar') { chrome.action.openPopup().catch(() => {}); return; }
  if (typeof info.menuItemId !== 'string' || !info.menuItemId.startsWith('guardar::')) return;

  const destino = info.menuItemId.slice('guardar::'.length);
  const sesion = await leerSesion();
  if (!sesion) { avisar('Falta conectar', 'Abrí la extensión y pegá tu PIN.'); return; }

  // Una marca no puede elegir destino: el suyo es el único, venga lo que venga en el menú.
  const slug = sesion.rol === 'admin' ? destino : (sesion.slug || '');
  const clave = slug ? slug + ':ideas' : 'ideas';

  let thumb = '';
  let texto = (info.selectionText || '').trim();

  if (info.srcUrl) {
    const r = await bajarImagen(tab.id, info.srcUrl, ANCHO_MAX, CALIDAD);
    // Si el sitio no deja descargarla, se guarda el enlace en vez de perder la idea. La
    // miniatura puede romperse más adelante, pero el texto y la referencia quedan.
    thumb = r.dataUrl || '';
    if (!thumb && !texto) texto = 'Referencia de ' + (tab.title || info.pageUrl || 'la web');
  }
  if (!texto) texto = 'Referencia de ' + (tab.title || 'la web');

  try {
    // Se relee la lista justo antes de escribir: si el calendario está abierto en otra
    // pestaña, guardar sobre una copia vieja borraría lo que se agregó en el medio.
    const actual = await pedir({ token: sesion.token, accion: 'get', key: clave });
    let ideas = [];
    try { ideas = JSON.parse(actual.value || '[]') || []; } catch (e) { ideas = []; }

    ideas.push({
      id: idAlAzar(),
      text: texto.slice(0, 500),
      link: info.pageUrl || info.srcUrl || '',
      thumb: thumb || (info.srcUrl || ''),
      angle: null,
      kind: '',
      origen: 'extension',
      createdAt: new Date().toISOString()
    });

    await pedir({ token: sesion.token, accion: 'set', key: clave, value: JSON.stringify(ideas) });

    const dondeMenu = info.menuItemId === 'guardar::' ? 'Calendario principal' : null;
    avisar('Idea guardada', dondeMenu || (slug ? 'En el calendario de ' + slug : 'En tu calendario'));
  } catch (e) {
    avisar('No se pudo guardar', (e && e.message) || 'Revisá tu conexión.');
  }
});
