// Pantalla de la extensión: conectar con un PIN y ver a qué calendario quedó atada.
//
// El PIN no se guarda: se canjea una sola vez por el token del link (que es lo que el
// servidor entiende) y se guarda solo eso. Así, si alguien mira el almacenamiento de la
// extensión, no encuentra el PIN que la persona usa para entrar por la web.

const SITIO = 'https://calendario-contenido-kappa.vercel.app';

const $ = (id) => document.getElementById(id);

function mostrar(sesion) {
  const hay = !!sesion;
  $('vistaEntrar').classList.toggle('oculto', hay);
  $('vistaConectado').classList.toggle('oculto', !hay);
  if (hay) {
    $('quien').textContent = sesion.nombre || 'Mi calendario';
    $('rol').textContent = sesion.rol === 'admin'
      ? 'Administrador — al guardar vas a elegir la marca'
      : 'Las ideas se guardan en este calendario';
  }
}

async function estado() {
  const { sesion } = await chrome.storage.local.get('sesion');
  mostrar(sesion || null);
}
estado();

// ---------- conectar ----------
$('pin').addEventListener('input', (e) => {
  // Solo dígitos: pegar un PIN con espacios o guiones es lo más común al copiarlo.
  e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
  $('avisoEntrar').textContent = '';
});
$('pin').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('entrarBtn').click(); });

$('entrarBtn').addEventListener('click', async () => {
  const pin = $('pin').value.trim();
  const aviso = $('avisoEntrar');
  aviso.className = 'aviso';

  if (!/^\d{6}$/.test(pin)) {
    aviso.classList.add('mal');
    aviso.textContent = 'El PIN son 6 dígitos.';
    return;
  }

  $('entrarBtn').disabled = true;
  $('entrarBtn').textContent = 'Conectando…';
  try {
    // Primer paso: el PIN se cambia por el token. Este endpoint es el que frena los
    // intentos por IP, así que probar PINes desde acá no es más fácil que desde la web.
    const r1 = await fetch(SITIO + '/api/entrar', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin })
    });
    const j1 = await r1.json().catch(() => null);
    if (!r1.ok || !j1 || !j1.token) throw new Error((j1 && j1.error) || 'PIN incorrecto.');

    // Segundo paso: preguntar de quién es ese token, para poder mostrar el nombre y saber
    // si hay que ofrecer el submenú de marcas.
    const r2 = await fetch(SITIO + '/api/datos', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: j1.token, accion: 'sesion' })
    });
    const j2 = await r2.json().catch(() => null);
    if (!r2.ok || !j2) throw new Error('No se pudo verificar el acceso.');

    const sesion = { token: j1.token, rol: j2.rol, slug: j2.slug || '', nombre: j2.nombre || '' };
    await chrome.storage.local.set({ sesion });
    // El menú del click derecho depende del rol, así que hay que rearmarlo ahora.
    await chrome.runtime.sendMessage({ tipo: 'sesionCambio' });

    $('pin').value = '';
    mostrar(sesion);
  } catch (e) {
    aviso.classList.add('mal');
    aviso.textContent = (e && e.message) || 'No se pudo conectar.';
  } finally {
    $('entrarBtn').disabled = false;
    $('entrarBtn').textContent = 'Conectar';
  }
});

// ---------- salir / abrir ----------
$('salirBtn').addEventListener('click', async () => {
  await chrome.storage.local.remove('sesion');
  await chrome.runtime.sendMessage({ tipo: 'sesionCambio' });
  mostrar(null);
});

$('abrirBtn').addEventListener('click', async () => {
  const { sesion } = await chrome.storage.local.get('sesion');
  // Con el token en la ruta entra directo, sin volver a pedir el PIN.
  chrome.tabs.create({ url: sesion ? SITIO + '/' + sesion.token : SITIO });
});
