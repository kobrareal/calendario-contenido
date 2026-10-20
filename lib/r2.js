// Cloudflare R2: donde se guardan los archivos finales de cada posteo cuando está configurado.
//
// Reemplaza a Supabase Storage para los archivos porque el plan gratis de Supabase no acepta
// más de 50 MB por archivo y tiene 1 GB en total; R2 trae 10 GB gratis y archivos de varios GB.
// Si estas variables no están, api/medios.js sigue usando Supabase como antes.
//
// Variables de entorno (Vercel > Settings > Environment Variables):
//   R2_ACCOUNT_ID         el "Account ID" de Cloudflare
//   R2_ACCESS_KEY_ID      de un token de API de R2 con permiso de escritura en el bucket
//   R2_SECRET_ACCESS_KEY  del mismo token (secreta)
//   R2_BUCKET             el nombre del bucket
//   R2_PUBLIC_URL         la dirección pública del bucket (https://pub-xxxx.r2.dev o un dominio
//                         propio), sin barra final. Instagram baja los archivos de ahí.
//
// R2 habla el mismo protocolo que Amazon S3. En vez de sumar el SDK de Amazon (este proyecto no
// tiene dependencias y así se publica más rápido) se firma a mano la URL de subida: es la
// "firma versión 4" de AWS, la misma cuenta en cuatro pasos que documenta Amazon.

const crypto = require('crypto');

const R2 = {
  cuenta: process.env.R2_ACCOUNT_ID,
  clave: process.env.R2_ACCESS_KEY_ID,
  secreto: process.env.R2_SECRET_ACCESS_KEY,
  bucket: process.env.R2_BUCKET,
  publica: String(process.env.R2_PUBLIC_URL || '').replace(/\/+$/, '')
};
const r2Configurado = () => !!(R2.cuenta && R2.clave && R2.secreto && R2.bucket && R2.publica);

const sha256 = (x) => crypto.createHash('sha256').update(x).digest('hex');
const hmac = (k, x) => crypto.createHmac('sha256', k).update(x).digest();
// La codificación de S3: la de encodeURIComponent más estos cinco caracteres.
const codificar = (x) => encodeURIComponent(x).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

// URL prefirmada: quien la tenga puede hacer ese único pedido (método + ruta) hasta que venza,
// sin conocer el secreto. Separada de R2 para poder probarla con el ejemplo oficial de Amazon.
function prefirmar({ metodo, host, ruta, region, clave, secreto, segundos, fecha = new Date() }) {
  const amzFecha = fecha.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); // 20130524T000000Z
  const dia = amzFecha.slice(0, 8);
  const alcance = `${dia}/${region}/s3/aws4_request`;
  const params = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${clave}/${alcance}`,
    'X-Amz-Date': amzFecha,
    'X-Amz-Expires': String(segundos),
    'X-Amz-SignedHeaders': 'host'
  };
  const consulta = Object.keys(params).sort().map(k => codificar(k) + '=' + codificar(params[k])).join('&');
  const rutaCodificada = ruta.split('/').map(codificar).join('/');
  // UNSIGNED-PAYLOAD: el contenido no entra en la firma, así el navegador puede subir el
  // archivo directo sin que el servidor lo tenga que leer.
  const canonico = [metodo, rutaCodificada, consulta, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const aFirmar = ['AWS4-HMAC-SHA256', amzFecha, alcance, sha256(canonico)].join('\n');
  const llave = hmac(hmac(hmac(hmac('AWS4' + secreto, dia), region), 's3'), 'aws4_request');
  const firma = crypto.createHmac('sha256', llave).update(aFirmar).digest('hex');
  return `https://${host}${rutaCodificada}?${consulta}&X-Amz-Signature=${firma}`;
}

// Permiso de subida para un archivo nuevo, y la dirección pública con la que va a quedar.
function permisoDeSubida(ruta) {
  return {
    subida: prefirmar({
      metodo: 'PUT',
      host: `${R2.cuenta}.r2.cloudflarestorage.com`,
      ruta: `/${R2.bucket}/${ruta}`,
      region: 'auto',
      clave: R2.clave,
      secreto: R2.secreto,
      segundos: 3600 // una hora: alcanza para subir un video pesado con una conexión lenta
    }),
    url: `${R2.publica}/${ruta}`
  };
}

module.exports = { r2Configurado, permisoDeSubida, prefirmar };
