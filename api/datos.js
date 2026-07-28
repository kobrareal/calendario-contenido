// Única puerta de entrada a los datos del calendario.
//
// El navegador ya no habla con la base: manda el token de su link y el servidor decide qué
// puede ver y qué puede escribir. Antes la clave de la base venía incrustada en la página y
// el ?cliente= de la URL no protegía nada, porque cualquiera podía pedir los datos de otra
// marca desde la consola.
//
// La verificación de acceso vive en lib/acceso.js, compartida con el resto de los endpoints.
//
// Variables de entorno (Vercel > Settings > Environment Variables):
//   SUPABASE_URL          https://xxxx.supabase.co
//   SUPABASE_SERVICE_KEY  la clave "service_role" de Supabase (secreta)

const {
  SUPABASE_URL, SERVICE_KEY, KV, CLAVE_REGISTRO,
  cabeceras, leerRegistro, invalidarCache, resolverToken, puedeAcceder,
  codigoAlAzar, leerClaves, pinAlAzar
} = require('../lib/acceso');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Usá POST.' });
  }
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return res.status(500).json({ error: 'Faltan SUPABASE_URL o SUPABASE_SERVICE_KEY en Vercel.' });
  }

  const { token, accion, key, keys, value } = req.body || {};

  let sesion;
  try { sesion = await resolverToken(token); }
  catch (e) { return res.status(502).json({ error: 'No se pudo verificar el acceso: ' + e.message }); }
  if (!sesion) {
    // Mismo mensaje para un token inexistente que para uno dado de baja: no se le confirma a
    // nadie que "ese link existe pero no es tuyo".
    return res.status(401).json({ error: 'Link inválido o dado de baja.' });
  }

  try {
    if (accion === 'sesion') {
      return res.status(200).json({ rol: sesion.rol, slug: sesion.slug, nombre: sesion.nombre });
    }

    if (accion === 'get') {
      if (!puedeAcceder(sesion, key)) return res.status(403).json({ error: 'Sin acceso a ese dato.' });
      const r = await fetch(`${KV()}?key=eq.${encodeURIComponent(key)}&select=value`, {
        headers: cabeceras(), cache: 'no-store'
      });
      if (!r.ok) throw new Error('http ' + r.status);
      const filas = await r.json();
      return res.status(200).json({ value: filas.length ? filas[0].value : null });
    }

    if (accion === 'getMany') {
      // Las claves ajenas se descartan en silencio en vez de rechazar todo el pedido: así una
      // semana a caballo entre dos meses no rompe la carga entera.
      return res.status(200).json({ values: await leerClaves(sesion, keys) });
    }

    if (accion === 'set') {
      if (!puedeAcceder(sesion, key)) return res.status(403).json({ error: 'Sin permiso para guardar ese dato.' });
      if (typeof value !== 'string') return res.status(400).json({ error: 'El valor tiene que ser texto.' });
      const r = await fetch(KV(), {
        method: 'POST',
        headers: cabeceras({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
        body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }),
        cache: 'no-store'
      });
      if (!r.ok) throw new Error('http ' + r.status + ' ' + (await r.text()).slice(0, 200));
      return res.status(200).json({ ok: true });
    }

    // Listado de marcas para el panel del administrador. Devuelve los tokens porque es
    // justamente de donde se copian los links para repartir.
    if (accion === 'marcas') {
      if (sesion.rol !== 'admin') return res.status(403).json({ error: 'Solo el administrador.' });
      const registro = await leerRegistro();
      return res.status(200).json({ marcas: registro.marcas || [] });
    }

    // Definir un PIN a mano, propio o de una marca. Se exigen 6 dígitos: con menos, el
    // millón de combinaciones que hace viable este esquema se desarma.
    if (accion === 'definirPin') {
      if (sesion.rol !== 'admin') return res.status(403).json({ error: 'Solo el administrador.' });
      const cuerpo = req.body || {};
      const pedido = String(cuerpo.pin || '').trim();
      const destino = String(cuerpo.slug || '').trim(); // vacío o "__admin__" = el tuyo
      if (pedido && !/^\d{6}$/.test(pedido)) {
        return res.status(400).json({ error: 'El PIN tiene que ser de 6 dígitos.' });
      }

      const registro = await leerRegistro();
      const marcas = registro.marcas || [];
      const esAdmin = !destino || destino === '__admin__';

      // Un PIN repetido llevaría a dos calendarios distintos según el orden del registro.
      const enUso = (esAdmin ? [] : [registro.adminPin])
        .concat(marcas.filter(m => esAdmin || m.slug !== destino).map(m => m.pin))
        .filter(Boolean);

      // Sin PIN pedido se genera uno al azar, evitando los que ya están tomados.
      let pin = pedido;
      if (!pin) { do { pin = pinAlAzar(); } while (enUso.includes(pin)); }
      if (enUso.includes(pin)) return res.status(409).json({ error: 'Ese PIN ya está en uso por otro acceso.' });

      let nuevo;
      if (esAdmin) {
        nuevo = Object.assign({}, registro, { adminPin: pin, marcas });
      } else {
        const marca = marcas.find(m => m.slug === destino);
        if (!marca) return res.status(404).json({ error: 'No existe esa marca.' });
        marca.pin = pin;
        nuevo = Object.assign({}, registro, { marcas });
      }

      const r = await fetch(KV(), {
        method: 'POST',
        headers: cabeceras({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
        body: JSON.stringify({ key: CLAVE_REGISTRO, value: JSON.stringify(nuevo), updated_at: new Date().toISOString() })
      });
      if (!r.ok) throw new Error('http ' + r.status);
      invalidarCache(nuevo);
      return res.status(200).json({ marcas: nuevo.marcas, adminPin: nuevo.adminPin });
    }

    // Devuelve el PIN del administrador para mostrarlo en su propio panel.
    if (accion === 'miPin') {
      if (sesion.rol !== 'admin') return res.status(403).json({ error: 'Solo el administrador.' });
      const registro = await leerRegistro();
      return res.status(200).json({ adminPin: registro.adminPin || '' });
    }

    // Alta de marca, regeneración de su link y baja de acceso. Las tres reescriben el
    // registro, así que son exclusivas del administrador.
    if (accion === 'crearMarca' || accion === 'regenerarMarca' || accion === 'borrarMarca' || accion === 'regenerarPin') {
      if (sesion.rol !== 'admin') return res.status(403).json({ error: 'Solo el administrador.' });
      const registro = await leerRegistro();
      const marcas = registro.marcas || [];
      const slug = String((req.body || {}).slug || '').trim().toLowerCase()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      if (!slug) return res.status(400).json({ error: 'Falta el identificador de la marca.' });

      if (accion === 'crearMarca') {
        if (marcas.some(m => m.slug === slug)) return res.status(409).json({ error: 'Ya existe una marca con ese identificador.' });
        // El PIN se genera de entrada: es por donde va a entrar la marca todos los días.
        // Se comprueba que no esté repetido, porque un PIN duplicado llevaría a dos
        // calendarios distintos según el orden en que se recorra el registro.
        let pin;
        do { pin = pinAlAzar(); } while (marcas.some(m => m.pin === pin) || pin === registro.adminPin);
        marcas.push({
          slug,
          nombre: String((req.body || {}).nombre || slug).trim() || slug,
          token: slug + '-' + codigoAlAzar(12),
          pin,
          rol: 'editor'
        });
      } else {
        const marca = marcas.find(m => m.slug === slug);
        if (!marca) return res.status(404).json({ error: 'No existe esa marca.' });
        if (accion === 'regenerarMarca') marca.token = slug + '-' + codigoAlAzar(12);
        else if (accion === 'regenerarPin') {
          let pin;
          do { pin = pinAlAzar(); } while (marcas.some(m => m.pin === pin) || pin === registro.adminPin);
          marca.pin = pin;
        }
        // Dar de baja solo quita el acceso: el contenido queda en la base por si hay que
        // recuperarlo. Borrar los datos es otra cosa y no se hace desde acá.
        else marcas.splice(marcas.indexOf(marca), 1);
      }

      const nuevo = Object.assign({}, registro, { marcas });
      const r = await fetch(KV(), {
        method: 'POST',
        headers: cabeceras({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
        body: JSON.stringify({ key: CLAVE_REGISTRO, value: JSON.stringify(nuevo), updated_at: new Date().toISOString() })
      });
      if (!r.ok) throw new Error('http ' + r.status);
      invalidarCache(nuevo);
      return res.status(200).json({ marcas });
    }

    return res.status(400).json({ error: 'Acción desconocida.' });
  } catch (e) {
    return res.status(502).json({ error: 'Error hablando con la base: ' + e.message });
  }
};
