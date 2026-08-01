// Puente a la API de ClickUp: convierte posteos del calendario en tareas.
//
// El navegador manda el token de su link (para saber quién es) y este endpoint usa el
// CLICKUP_TOKEN configurado en Vercel para hablar con ClickUp. El token de ClickUp nunca
// llega al navegador: da acceso a todo el espacio de trabajo, así que vive del lado del
// servidor, mismo criterio que la clave de Gemini o la service_key de Supabase.
//
// A diferencia de Pinterest o Meta, acá no hay aprobación de por medio: un token personal
// se genera desde la configuración de la cuenta y funciona en el momento.
//
// Si CLICKUP_TOKEN no está configurado se responde 501 (Not Implemented) y no un 500
// genérico, para que la interfaz muestre las instrucciones en vez de un error seco.

const { resolverToken } = require('../lib/acceso');

const API = 'https://api.clickup.com/api/v2';

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Usá POST.' });
  }

  const clave = process.env.CLICKUP_TOKEN;
  if (!clave) {
    return res.status(501).json({ error: 'ClickUp no está configurado en el servidor.' });
  }

  // Autenticación del calendario: sin un link válido no se llega ni a hablar con ClickUp.
  const cuerpo = req.body || {};
  let sesion;
  try { sesion = await resolverToken(cuerpo.token); }
  catch (e) { return res.status(502).json({ error: 'No se pudo verificar el acceso.' }); }
  if (!sesion) return res.status(401).json({ error: 'Link inválido o dado de baja.' });

  const llamar = async (camino, opciones) => {
    const r = await fetch(API + camino, Object.assign({
      headers: { Authorization: clave, 'Content-Type': 'application/json' }
    }, opciones || {}));
    const j = await r.json().catch(() => null);
    if (!r.ok) {
      // ClickUp devuelve {err, ECODE}; el mensaje suele ser accionable ("List not found").
      throw new Error((j && (j.err || j.error)) || ('ClickUp respondió ' + r.status));
    }
    return j;
  };

  try {
    // ---------- listas disponibles ----------
    // Devuelve todas las listas del espacio de trabajo aplanadas, con su ruta completa, para
    // poder elegirla de un desplegable. ClickUp las tiene en cuatro niveles (equipo, espacio,
    // carpeta, lista) y hacerle recorrer esa jerarquía a mano a alguien que solo quiere
    // elegir dónde van sus tareas no tiene ningún sentido.
    if (cuerpo.accion === 'listas') {
      const { teams } = await llamar('/team');
      const salida = [];

      for (const equipo of (teams || [])) {
        const { spaces } = await llamar('/team/' + equipo.id + '/space?archived=false');
        for (const espacio of (spaces || [])) {
          // Listas sueltas del espacio, sin carpeta.
          const sueltas = await llamar('/space/' + espacio.id + '/list?archived=false');
          (sueltas.lists || []).forEach(l => salida.push({
            id: l.id, ruta: espacio.name + ' / ' + l.name
          }));
          // Y las que cuelgan de cada carpeta.
          const { folders } = await llamar('/space/' + espacio.id + '/folder?archived=false');
          for (const carpeta of (folders || [])) {
            (carpeta.lists || []).forEach(l => salida.push({
              id: l.id, ruta: espacio.name + ' / ' + carpeta.name + ' / ' + l.name
            }));
          }
        }
      }
      return res.status(200).json({ listas: salida });
    }

    // ---------- crear o actualizar una tarea ----------
    const tarea = cuerpo.tarea || {};
    const nombre = String(tarea.name || '').trim();
    if (!nombre) return res.status(400).json({ error: 'La tarea necesita un título.' });

    const datos = { name: nombre.slice(0, 250) };
    if (tarea.description) datos.description = String(tarea.description).slice(0, 8000);
    if (Array.isArray(tarea.tags)) datos.tags = tarea.tags.filter(Boolean).map(String).slice(0, 10);
    if (tarea.due_date) {
      datos.due_date = Number(tarea.due_date);
      // Sin esto ClickUp ignora la hora y deja la tarea para el final del día, con lo cual
      // se pierde justamente el horario de publicación que se cargó en el calendario.
      datos.due_date_time = !!tarea.due_date_time;
    }

    if (cuerpo.accion === 'actualizar') {
      const id = String(cuerpo.taskId || '').trim();
      if (!id) return res.status(400).json({ error: 'Falta el identificador de la tarea.' });
      // Al actualizar no se mandan los tags: la API los reemplaza en bloque y se llevaría
      // puesto cualquiera que hayan agregado a mano del lado de ClickUp.
      delete datos.tags;
      const j = await llamar('/task/' + encodeURIComponent(id), {
        method: 'PUT', body: JSON.stringify(datos)
      });
      return res.status(200).json({ id: j.id, url: j.url });
    }

    if (cuerpo.accion === 'crear') {
      const lista = String(cuerpo.listId || '').trim();
      if (!lista) return res.status(400).json({ error: 'Elegí primero la lista de ClickUp.' });
      const j = await llamar('/list/' + encodeURIComponent(lista) + '/task', {
        method: 'POST', body: JSON.stringify(datos)
      });
      return res.status(200).json({ id: j.id, url: j.url });
    }

    return res.status(400).json({ error: 'Acción desconocida.' });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
};
