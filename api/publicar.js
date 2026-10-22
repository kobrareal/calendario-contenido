// El publicador: lo llama un reloj externo (cron-job.org) cada 5 minutos y publica en
// Instagram lo que ya tiene que salir.
//
// Qué se publica: los posteos y stories con "Publicar automáticamente" activado, de hoy o de
// ayer, cuya hora ya llegó y que todavía no figuran en el registro de publicaciones de la
// marca. Se mira ayer también para no perder lo programado cerca de la medianoche.
//
// Por qué un registro aparte y no un campo en el posteo: el día lo guarda el navegador
// entero, de una, y pisaría lo que escriba acá si alguien tiene el calendario abierto. El
// registro solo lo toca el servidor, y es lo que garantiza que nada salga dos veces.
//
// Publicar en Instagram es de a pasos: se crea un "contenedor" con el archivo, Instagram lo
// procesa (un video tarda), y recién ahí se publica. Un video puede tardar más que los 30
// segundos que vive esta función, así que cada vuelta avanza lo que puede y deja anotado en
// qué quedó; la siguiente sigue desde ahí.
//
// Seguridad: sin la clave CRON_SECRET no hace nada. Se manda como encabezado
//   Authorization: Bearer <CRON_SECRET>
// (el mismo formato que usa Vercel Cron, por si algún día se pasa a ese).

const { leerRegistro, leerClaves } = require('../lib/acceso');
const { borrarArchivos } = require('../lib/archivos');
const {
  APP_SECRET, claveConexion, claveRegistro, prefijoDatos, leerJson, guardarJson, graph
} = require('../lib/instagram');

// Argentina está en UTC-3 todo el año (no tiene horario de verano), y el calendario guarda
// las horas tal como las escribe la marca.
const DESFASE_MS = -3 * 3600 * 1000;
// Pasado este tiempo sin haber podido salir, ya no se publica: un posteo de las 10 que
// aparece a las 18 puede quedar peor que no publicarlo. Queda como error para avisar.
const VENTANA_MS = 6 * 3600 * 1000;
// Un contenedor que no termina de procesarse en este tiempo se da por fallado.
const MAX_PROCESO_MS = 60 * 60 * 1000;
// Se deja de empezar trabajo nuevo pasado este tiempo, para cerrar antes de los 30 s de Vercel.
const PRESUPUESTO_MS = 20 * 1000;
// Se renueva el token cuando le quedan menos de estos días (dura 60).
const RENOVAR_ANTES_MS = 15 * 24 * 3600 * 1000;

// "API access blocked" (código 200): Meta corta a la app entera, en general porque la cuenta
// de desarrollador dueña tiene una verificación pendiente. Va y viene, así que no se da el
// posteo por perdido: queda "bloqueado" y se reintenta en cada vuelta, dentro de la ventana.
const esBloqueoDeMeta = (e) => e && e.codigo === 200 && /blocked/i.test(e.message || '');
const AVISO_BLOQUEO = 'Meta está bloqueando el acceso de la app ("API access blocked"). Se reintenta cada 5 minutos. ' +
  'Para destrabarlo hay que confirmar la cuenta de desarrollador en developers.facebook.com.';

const diaLocal = (ms) => new Date(ms + DESFASE_MS).toISOString().slice(0, 10);
function momento(dia, hora) {
  const [y, m, d] = dia.split('-').map(Number);
  const [hh, mm] = String(hora).split(':').map(Number);
  return Date.UTC(y, m - 1, d, hh || 0, mm || 0) - DESFASE_MS;
}

// Las mismas reglas que avisa la tarjeta (problemasPublicacion en index.html). Se revisan de
// nuevo acá porque el posteo pudo cambiar después, y es mejor un error claro que uno de Meta.
function problema(item, esStory) {
  const media = Array.isArray(item.media) ? item.media : [];
  const videos = media.filter(m => m.tipo === 'video').length;
  if (esStory) return media.length === 1 ? '' : 'Una story lleva exactamente un archivo.';
  const kind = ['carrusel', 'imagen'].includes(item.kind) ? item.kind : 'reel';
  if (kind === 'reel' && (media.length !== 1 || videos !== 1)) return 'Un reel lleva exactamente un video.';
  if (kind === 'imagen' && (media.length !== 1 || videos !== 0)) return 'Un posteo de imagen lleva exactamente una imagen.';
  if (kind === 'carrusel' && (media.length < 2 || media.length > 10)) return 'Un carrusel lleva entre 2 y 10 archivos.';
  if ((item.colaboradores || []).length > 3) return 'Instagram admite hasta 3 colaboradores.';
  return '';
}

// ---------- pasos con Instagram ----------
async function crearContenedor(cuenta, token, params) {
  const j = await graph(`/${cuenta}/media`, { metodo: 'POST', params, token });
  return j.id;
}
async function estadoContenedor(id, token) {
  const j = await graph(`/${id}`, { params: { fields: 'status_code,status' }, token });
  return { codigo: j.status_code, detalle: j.status || '' };
}

// Arranca la publicación: crea el contenedor (o los hijos, si es carrusel).
async function empezar(item, esStory, cuenta, token) {
  const media = item.media;
  const caption = esStory ? undefined : (item.text || '');
  // Colaboradores: van en el contenedor que se publica (en un carrusel, el padre, no cada
  // imagen). Instagram los recibe como lista JSON de nombres de usuario.
  const colab = (Array.isArray(item.colaboradores) ? item.colaboradores : []).slice(0, 3);
  const conColab = (p) => colab.length ? Object.assign(p, { collaborators: JSON.stringify(colab) }) : p;
  const archivo = (m, extra) => Object.assign(
    m.tipo === 'video' ? { video_url: m.url } : { image_url: m.url }, extra);

  if (esStory) {
    return { contenedor: await crearContenedor(cuenta, token, archivo(media[0], { media_type: 'STORIES' })) };
  }
  const kind = ['carrusel', 'imagen'].includes(item.kind) ? item.kind : 'reel';
  if (kind === 'imagen') {
    return { contenedor: await crearContenedor(cuenta, token, conColab({ image_url: media[0].url, caption })) };
  }
  if (kind === 'reel') {
    const reel = conColab({ media_type: 'REELS', video_url: media[0].url, caption });
    // La portada es la miniatura con la que el reel aparece en el feed; sin ella, Instagram
    // toma el primer cuadro del video.
    if (item.portada && item.portada.url) reel.cover_url = item.portada.url;
    return { contenedor: await crearContenedor(cuenta, token, reel) };
  }
  const hijos = [];
  for (const m of media) {
    hijos.push(await crearContenedor(cuenta, token,
      archivo(m, m.tipo === 'video' ? { media_type: 'VIDEO', is_carousel_item: 'true' } : { is_carousel_item: 'true' })));
  }
  return { hijos, caption, colaboradores: colab };
}

// Avanza un registro "procesando" todo lo que se pueda en esta vuelta. Devuelve el registro
// actualizado; si no cambió nada, Instagram sigue procesando.
async function avanzar(reg, cuenta, token) {
  if (reg.hijos && !reg.contenedor) {
    for (const h of reg.hijos) {
      const e = await estadoContenedor(h, token);
      if (e.codigo === 'ERROR' || e.codigo === 'EXPIRED') throw new Error('Instagram rechazó un archivo del carrusel. ' + e.detalle);
      if (e.codigo !== 'FINISHED') return reg;
    }
    const padre = { media_type: 'CAROUSEL', children: reg.hijos.join(','), caption: reg.caption || '' };
    if (reg.colaboradores && reg.colaboradores.length) padre.collaborators = JSON.stringify(reg.colaboradores);
    reg.contenedor = await crearContenedor(cuenta, token, padre);
  }
  const e = await estadoContenedor(reg.contenedor, token);
  if (e.codigo === 'ERROR' || e.codigo === 'EXPIRED') throw new Error('Instagram no pudo procesar el archivo. ' + e.detalle);
  if (e.codigo !== 'FINISHED') return reg;
  return Object.assign(reg, { listo: true });
}

module.exports = async (req, res) => {
  const clave = process.env.CRON_SECRET;
  const auth = String(req.headers.authorization || '');
  if (!clave || auth !== 'Bearer ' + clave) return res.status(401).json({ error: 'Sin autorización.' });
  if (!APP_SECRET) return res.status(501).json({ error: 'Falta configurar INSTAGRAM_APP_SECRET en Vercel.' });

  const arranque = Date.now();
  const informe = [];
  const anotar = (marca, id, que) => informe.push(`${marca || '(propio)'} ${id}: ${que}`);

  let registroMarcas;
  try { registroMarcas = await leerRegistro(); }
  catch (e) { return res.status(502).json({ error: e.message }); }
  // '' es el calendario propio del administrador, el que no lleva prefijo.
  const marcas = [''].concat((registroMarcas.marcas || []).map(m => m.slug));
  const ahora = Date.now();
  const dias = [diaLocal(ahora - 24 * 3600 * 1000), diaLocal(ahora)];
  const admin = { rol: 'admin' };

  for (const marca of marcas) {
    if (Date.now() - arranque > PRESUPUESTO_MS) { informe.push('se cortó por tiempo; sigue en la próxima vuelta'); break; }
    let conexion;
    try { conexion = await leerJson(claveConexion(marca), null); } catch (e) { anotar(marca, '-', e.message); continue; }
    if (!conexion || !conexion.token) continue;

    // Renovación del token. Instagram solo deja renovar uno que tenga más de 24 h.
    if (conexion.vence - ahora < RENOVAR_ANTES_MS && ahora - (conexion.renovado || 0) > 24 * 3600 * 1000) {
      try {
        const r = await graph('https://graph.instagram.com/refresh_access_token', {
          params: { grant_type: 'ig_refresh_token' }, token: conexion.token
        });
        conexion.token = r.access_token;
        conexion.vence = Date.now() + (Number(r.expires_in) || 60 * 24 * 3600) * 1000;
        conexion.renovado = Date.now();
        await guardarJson(claveConexion(marca), conexion);
        anotar(marca, '-', 'token renovado');
      } catch (e) { anotar(marca, '-', 'no se pudo renovar el token: ' + e.message); }
    }

    const pref = prefijoDatos(marca);
    let datos;
    try { datos = await leerClaves(admin, dias.map(d => pref + d)); } catch (e) { anotar(marca, '-', e.message); continue; }

    // Posteos candidatos de los dos días.
    const candidatos = [];
    for (const dia of dias) {
      let entrada;
      try { entrada = JSON.parse(datos[pref + dia] || '{}'); } catch (e) { continue; }
      for (const [lista, esStory] of [['feed', false], ['stories', true]]) {
        for (const item of (Array.isArray(entrada[lista]) ? entrada[lista] : [])) {
          if (!item || !item.programar || !item.time || !item.id) continue;
          const cuando = momento(dia, item.time);
          if (cuando > ahora) continue;
          candidatos.push({ id: `${dia}|${item.id}`, item, esStory, cuando });
        }
      }
    }
    if (!candidatos.length) continue;

    const registro = await leerJson(claveRegistro(marca), {});
    const guardar = () => guardarJson(claveRegistro(marca), registro);

    for (const c of candidatos) {
      if (Date.now() - arranque > PRESUPUESTO_MS) break;
      let previo = registro[c.id];
      if (previo && ['publicado', 'error'].includes(previo.estado)) continue;
      // Un bloqueo de Meta sin nada creado en Instagram: se arranca de cero, como si no
      // se hubiera intentado. Si vence la ventana, el error dice que fue por el bloqueo.
      const veniaBloqueado = !!(previo && (previo.estado === 'bloqueado' || previo.bloqueado));
      if (previo && previo.estado === 'bloqueado') previo = null;

      // Quedó cortado justo al publicar: no se sabe si salió. Reintentar podría duplicarlo,
      // así que se avisa y se deja que una persona lo mire.
      if (previo && previo.estado === 'publicando') {
        registro[c.id] = Object.assign(previo, { estado: 'error', error: 'Se cortó mientras se publicaba. Revisá en Instagram si salió.' });
        await guardar(); anotar(marca, c.id, 'cortado al publicar'); continue;
      }

      try {
        let reg = previo;
        if (!reg) {
          if (ahora - c.cuando > VENTANA_MS) {
            registro[c.id] = { estado: 'error', at: new Date().toISOString(), error: veniaBloqueado
              ? 'Meta bloqueó el acceso de la app ("API access blocked") durante más de 6 horas. Confirmá la cuenta de desarrollador en developers.facebook.com, cambiale el horario y tocá Reintentar.'
              : 'Pasaron más de 6 horas de la hora programada sin poder publicarse.' };
            await guardar(); anotar(marca, c.id, 'vencido'); continue;
          }
          const mal = problema(c.item, c.esStory);
          if (mal) {
            registro[c.id] = { estado: 'error', error: mal, at: new Date().toISOString() };
            await guardar(); anotar(marca, c.id, mal); continue;
          }
          reg = Object.assign({ estado: 'procesando', desde: Date.now(), at: new Date().toISOString() },
            await empezar(c.item, c.esStory, conexion.cuentaId, conexion.token));
          registro[c.id] = reg;
          await guardar();
        }

        if (Date.now() - reg.desde > MAX_PROCESO_MS) throw new Error('Instagram tardó más de una hora en procesar el archivo.');
        await avanzar(reg, conexion.cuentaId, conexion.token);
        if (!reg.listo) { await guardar(); anotar(marca, c.id, 'procesando'); continue; }

        // Se marca ANTES de publicar: si la función se corta en el medio, la próxima vuelta
        // lo ve y no lo publica de nuevo.
        reg.estado = 'publicando';
        await guardar();
        const publicado = await graph(`/${conexion.cuentaId}/media_publish`, {
          metodo: 'POST', params: { creation_id: reg.contenedor }, token: conexion.token
        });
        let permalink = '';
        try { permalink = (await graph(`/${publicado.id}`, { params: { fields: 'permalink' }, token: conexion.token })).permalink || ''; }
        catch (e) { /* las stories no siempre lo traen; el posteo salió igual */ }
        registro[c.id] = { estado: 'publicado', mediaId: publicado.id, permalink, at: new Date().toISOString() };
        await guardar();
        anotar(marca, c.id, 'publicado');
        // Instagram ya tiene su copia: los archivos se borran para no llenar el almacenamiento.
        // Si falla no pasa nada grave; el posteo salió igual.
        const borrados = await borrarArchivos([].concat(c.item.media || [], c.item.portada || []));
        if (borrados.error) anotar(marca, c.id, 'no se pudieron borrar los archivos: ' + borrados.error);
      } catch (e) {
        if (esBloqueoDeMeta(e)) {
          const reg = registro[c.id];
          if (!reg) {
            // No se llegó a crear nada en Instagram: queda a la espera y se vuelve a empezar.
            registro[c.id] = { estado: 'bloqueado', error: AVISO_BLOQUEO, at: new Date().toISOString() };
          } else {
            // Ya había contenedores creados. Si el corte fue justo al publicar, la respuesta de
            // Meta fue un error, así que no salió: se vuelve a "procesando" para reintentar.
            reg.estado = 'procesando';
            reg.bloqueado = new Date().toISOString();
            reg.error = AVISO_BLOQUEO;
          }
          await guardar().catch(() => {});
          anotar(marca, c.id, 'bloqueado por Meta; se reintenta en la próxima vuelta');
          continue;
        }
        const msg = e.codigo === 190
          ? 'La conexión con Instagram venció o se revocó. Volvé a conectar la cuenta.'
          : e.message;
        registro[c.id] = Object.assign(registro[c.id] || {}, { estado: 'error', error: msg, at: new Date().toISOString() });
        await guardar().catch(() => {});
        anotar(marca, c.id, 'error: ' + msg);
      }
    }
  }

  return res.status(200).json({ ok: true, ms: Date.now() - arranque, informe });
};
