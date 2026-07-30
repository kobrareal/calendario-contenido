// Service worker de la extensión: captura lo que se marcó y abre la ventana de guardado.
//
// No guarda nada por su cuenta. Baja la imagen, arma un borrador y abre guardar.html, que
// es donde se completan título, tipo de posteo, ángulo y —si la sesión es de
// administrador— a qué calendario va. El destino se elige ahí y no en un submenú del menú
// contextual: con la miniatura a la vista es mucho más difícil equivocarse de marca que
// eligiendo a ciegas desde el menú del click derecho.
//
// El aislamiento real no lo hace este archivo, lo hace el servidor (lib/acceso.js): una
// sesión de marca solo puede escribir claves que arranquen con su propio nombre, así que
// ni un error de acá ni una extensión modificada a mano pueden cruzar datos entre marcas.

const SITIO = 'https://calendario-contenido-kappa.vercel.app';

// Ancho máximo de la miniatura. Mismo criterio que el calendario: alcanza con una
// referencia reconocible, y el original de 3000px haría crecer la fila de la base al balde.
const ANCHO_MAX = 900;
const CALIDAD = 0.72;

const VENTANA = { ancho: 440, alto: 660 };

async function leerSesion() {
  const { sesion } = await chrome.storage.local.get('sesion');
  return sesion || null;
}

// ---------- menú del click derecho ----------
// Una sola entrada: el detalle se elige en la ventana que se abre después. Los puntos
// suspensivos avisan justamente eso, que no guarda de una.
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

  chrome.contextMenus.create({
    id: 'guardar',
    title: 'Guardar como idea…',
    // 'video' incluido: de un video no se guarda el archivo —serían megas por idea— sino
    // el fotograma que se está viendo, más el enlace para volver a verlo.
    contexts: ['image', 'video', 'selection']
  });
}

chrome.runtime.onInstalled.addListener(armarMenu);
chrome.runtime.onStartup.addListener(armarMenu);
// El popup avisa cuando alguien entra o sale, para rearmar el menú.
chrome.runtime.onMessage.addListener((msg, _emisor, responder) => {
  if (msg && msg.tipo === 'sesionCambio') {
    armarMenu().then(() => responder({ ok: true }));
    return true; // respuesta asincrónica
  }
});

// ---------- traer la imagen ----------
// Se descarga desde la propia pestaña y no desde el service worker: así la extensión no
// necesita permiso permanente sobre todos los sitios, que es la advertencia que hace dudar
// al instalar. El permiso de la pestaña lo habilita el click en el menú y dura ese momento.
//
// El recorrido es fetch → blob → bitmap → canvas porque un canvas que dibuja una imagen de
// otro dominio queda "contaminado" y ya no se puede leer. Con un blob local eso no pasa.
async function bajarImagen(tabId, url) {
  try {
    const [salida] = await chrome.scripting.executeScript({
      target: { tabId },
      args: [url, ANCHO_MAX, CALIDAD],
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
    return (salida && salida.result) || { error: 'sin respuesta de la pestaña' };
  } catch (e) {
    // Hay páginas donde no se puede inyectar nada (la tienda de extensiones, pestañas
    // internas de Chrome). No es un error a mostrar: se sigue sin miniatura.
    return { error: (e && e.message) || 'no se pudo leer la página' };
  }
}

// ---------- fotograma de un video ----------
// De un video no se guarda el archivo: pesaría megas por idea y el panel se arrastraría.
// Se guarda el fotograma que la persona está viendo, más el enlace para volver a verlo.
//
// El fotograma sale de una captura de la pestaña recortada al video, y no de dibujar el
// <video> en un canvas: un video servido desde otro dominio sin CORS —o sea, casi todos los
// reels— contamina el canvas y no se puede leer. La captura de pantalla no tiene ese
// problema, porque para el navegador es una foto de lo que ya está en la pantalla.
async function capturarFotograma(tabId, windowId) {
  // Dónde está el video dentro de la ventana, y con qué densidad de píxeles se dibujó.
  const [medida] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const videos = [...document.querySelectorAll('video')]
        .map(v => ({ v, r: v.getBoundingClientRect() }))
        // Solo los que están a la vista: una página puede tener varios y los de afuera
        // recortarían una región vacía.
        .filter(x => x.r.width > 40 && x.r.height > 40 && x.r.bottom > 0 && x.r.top < innerHeight);
      if (!videos.length) return null;
      // El más grande en pantalla: en un feed es el que se está mirando.
      videos.sort((a, b) => (b.r.width * b.r.height) - (a.r.width * a.r.height));
      const { r } = videos[0];
      return {
        x: Math.max(0, r.left), y: Math.max(0, r.top),
        w: Math.min(r.width, innerWidth - Math.max(0, r.left)),
        h: Math.min(r.height, innerHeight - Math.max(0, r.top)),
        dpr: devicePixelRatio || 1
      };
    }
  });
  const caja = medida && medida.result;
  if (!caja) return { error: 'no se encontró el video en pantalla' };

  const foto = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  if (!foto) return { error: 'no se pudo capturar la pantalla' };

  // La captura viene en píxeles reales del monitor y las medidas del video en píxeles CSS:
  // sin multiplicar por la densidad, en una pantalla ampliada el recorte queda corrido.
  const bitmap = await createImageBitmap(await (await fetch(foto)).blob());
  const d = caja.dpr;
  const sx = Math.round(caja.x * d), sy = Math.round(caja.y * d);
  const sw = Math.min(Math.round(caja.w * d), bitmap.width - sx);
  const sh = Math.min(Math.round(caja.h * d), bitmap.height - sy);
  if (sw < 10 || sh < 10) return { error: 'el video quedó fuera de la vista' };

  const escala = Math.min(1, ANCHO_MAX / sw);
  const w = Math.round(sw * escala), h = Math.round(sh * escala);
  const lienzo = new OffscreenCanvas(w, h);
  lienzo.getContext('2d').drawImage(bitmap, sx, sy, sw, sh, 0, 0, w, h);
  const jpg = await lienzo.convertToBlob({ type: 'image/jpeg', quality: CALIDAD });
  const dataUrl = await new Promise((ok, mal) => {
    const fr = new FileReader();
    fr.onload = () => ok(fr.result);
    fr.onerror = () => mal(new Error('no se pudo leer'));
    fr.readAsDataURL(jpg);
  });
  return { dataUrl };
}

function avisar(titulo, mensaje) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'iconos/icono-128.png',
    title: titulo,
    message: mensaje
  });
}

// ---------- capturar y abrir la ventana ----------
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'configurar') { chrome.action.openPopup().catch(() => {}); return; }
  if (info.menuItemId !== 'guardar') return;

  const sesion = await leerSesion();
  if (!sesion) { avisar('Falta conectar', 'Abrí la extensión y pegá tu PIN.'); return; }

  // mediaType lo pone Chrome según sobre qué se hizo el click derecho.
  const esVideo = info.mediaType === 'video';
  let thumb = '';
  let avisoCaptura = '';

  if (tab && tab.id != null) {
    if (esVideo) {
      const r = await capturarFotograma(tab.id, tab.windowId);
      thumb = r.dataUrl || '';
      if (!thumb) avisoCaptura = r.error || '';
    } else if (info.srcUrl) {
      const r = await bajarImagen(tab.id, info.srcUrl);
      // Si el sitio no deja descargarla, se cae al enlace directo: la miniatura puede
      // romperse más adelante, pero es mejor que perder la referencia.
      thumb = r.dataUrl || info.srcUrl;
    }
  }

  // El borrador va por storage y no por la URL de la ventana: una imagen en base64 son
  // cientos de miles de caracteres y no entra en una dirección.
  await chrome.storage.session.set({
    borrador: {
      texto: (info.selectionText || '').trim(),
      // Para un video el enlace útil es la página donde está —un reel se ve ahí, no en la
      // dirección del archivo, que además suele vencerse en horas.
      link: info.pageUrl || info.srcUrl || '',
      thumb,
      esVideo,
      avisoCaptura,
      tituloPagina: (tab && tab.title) || ''
    },
    sesion
  });

  chrome.windows.create({
    url: chrome.runtime.getURL('guardar.html'),
    type: 'popup',
    width: VENTANA.ancho,
    height: VENTANA.alto
  });
});
