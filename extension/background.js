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
    contexts: ['image', 'selection']
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

  let thumb = '';
  if (info.srcUrl && tab && tab.id != null) {
    const r = await bajarImagen(tab.id, info.srcUrl);
    // Si el sitio no deja descargarla, se cae al enlace directo: la miniatura puede
    // romperse más adelante, pero es mejor que perder la referencia.
    thumb = r.dataUrl || info.srcUrl;
  }

  // El borrador va por storage y no por la URL de la ventana: una imagen en base64 son
  // cientos de miles de caracteres y no entra en una dirección.
  await chrome.storage.session.set({
    borrador: {
      texto: (info.selectionText || '').trim(),
      link: info.pageUrl || info.srcUrl || '',
      thumb,
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
