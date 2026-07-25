/**
 * BACKEND DEL CALENDARIO DE CONTENIDO — Google Apps Script
 * -----------------------------------------------------------
 * Este script convierte una Google Sheet en la base de datos compartida
 * del calendario. Guarda cada dato (ángulos, nombre del cliente, y el
 * contenido de cada mes) como una fila con clave/valor en una hoja
 * llamada "Data".
 *
 * INSTALACIÓN (una sola vez):
 * 1. Andá a https://sheets.google.com y creá una hoja de cálculo nueva
 *    (el nombre no importa, ej: "Calendario de Contenido - Datos").
 * 2. Extensiones > Apps Script.
 * 3. Borrá todo el código que aparece por defecto y pegá este archivo completo.
 * 4. Arriba, hacé click en "Guardar proyecto" (el ícono de disquete).
 * 5. Hacé click en "Implementar" (Deploy) > "Nueva implementación".
 *    - Tipo: "Aplicación web" (Web app).
 *    - Descripción: la que quieras.
 *    - Ejecutar como: "Yo" (tu cuenta de Google).
 *    - Quién tiene acceso: "Cualquier usuario" (Anyone).
 * 6. Google va a pedirte autorizar el script. Como es tuyo, vas a ver una
 *    advertencia de "app no verificada" — es normal. Hacé click en
 *    "Configuración avanzada" (Advanced) > "Ir a [nombre del proyecto]
 *    (no seguro)" y luego "Permitir".
 * 7. Copiá la URL que termina en /exec — esa es la URL que tenés que
 *    pegar en el botón ⚙ (Configuración) del calendario.
 * 8. Si en el futuro modificás este script, tenés que hacer una
 *    "Nueva implementación" de nuevo (o "Administrar implementaciones" >
 *    editar > nueva versión) para que los cambios se apliquen.
 *
 * PARA EL GENERADOR DE COPY (Gemini):
 * 1. Extensiones > Apps Script > ícono de engranaje "Configuración del proyecto".
 * 2. Bajá hasta "Propiedades del script" > "Agregar propiedad de script".
 * 3. Nombre: GEMINI_API_KEY   Valor: tu API key de https://aistudio.google.com/apikey
 * 4. Guardá, y volvé a implementar una "Nueva versión" para que tome el cambio.
 *
 * RENDIMIENTO (v8): antes, cada lectura y escritura releía la planilla
 * ENTERA (todas las filas, incluidas las imágenes en base64 guardadas en
 * cada día) para encontrar una sola clave. Ahora usa TextFinder para ir
 * directo a la fila que corresponde, sin traer de vuelta datos que no hacen
 * falta — la diferencia se nota sobre todo si ya cargaste fotos.
 */

var SCRIPT_VERSION = 'v8-fast-lookup';

function doGet(e) {
  var key = e.parameter.key;
  if (key === '__version__') {
    return jsonOut({ key: key, value: SCRIPT_VERSION });
  }
  return jsonOut({ key: key, value: readKey(key) });
}

function doPost(e) {
  var data = JSON.parse(e.postData.contents);

  if (data.action === 'generate_copy') {
    return handleGenerateCopy(data);
  }
  var lock = LockService.getScriptLock();
  lock.waitLock(20000); // prevents two near-simultaneous saves from both appending instead of updating
  try {
    var key = data.key;
    var value = data.value;
    var storageKey = 'K:' + key;
    var sheet = getSheet();
    var rowIndex = findRowByKey(sheet, storageKey);
    if (rowIndex === null) {
      sheet.appendRow([storageKey, value, new Date()]);
    } else {
      sheet.getRange(rowIndex, 2).setValue(value);
      sheet.getRange(rowIndex, 3).setValue(new Date());
    }
    return jsonOut({ ok: true });
  } finally {
    lock.releaseLock();
  }
}

// Looks up one key's value directly (via findRowByKey below), instead of pulling
// every row's data into memory just to check column A.
function readKey(key) {
  var sheet = getSheet();
  var storageKey = 'K:' + key;
  var row = findRowByKey(sheet, storageKey);
  if (row !== null) {
    return sheet.getRange(row, 2).getValue();
  }
  // Fallback for rows written before the "K:" prefix existed (never affected by the
  // date-auto-conversion bug to begin with, e.g. "angles", "client-name", legacy month blobs).
  var legacyRow = findRowByKey(sheet, key);
  if (legacyRow !== null) {
    return sheet.getRange(legacyRow, 2).getValue();
  }
  return null;
}

// Finds the LAST row (1-based) whose column A exactly equals keyToFind, using
// TextFinder so only column A is scanned — column B (which can hold large
// base64 image data per day) is never read until we know the exact row we need.
// Returns null if there's no match.
function findRowByKey(sheet, keyToFind) {
  var matches = sheet.getRange('A:A').createTextFinder(keyToFind).matchEntireCell(true).findAll();
  if (matches.length === 0) return null;
  return matches[matches.length - 1].getRow(); // last match wins (most recent), same as before
}

function getSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Data');
  if (!sheet) {
    sheet = ss.insertSheet('Data');
    sheet.appendRow(['key', 'value', 'actualizado']);
    sheet.setFrozenRows(1);
  }
  // Belt-and-suspenders: keep column A as plain text too, on top of the "K:" prefix below,
  // so nothing here ever gets silently reinterpreted as a date/number by Sheets.
  sheet.getRange('A:A').setNumberFormat('@');
  return sheet;
}

function jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function handleGenerateCopy(data) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) {
    return ContentService.createTextOutput(JSON.stringify({
      error: 'Falta configurar GEMINI_API_KEY en las Propiedades del script.'
    })).setMimeType(ContentService.MimeType.JSON);
  }

  var kindLabels = { reel: 'Reel', carrusel: 'Carrusel', story: 'Story' };
  var kindLabel = kindLabels[data.kind] || 'posteo';
  var angle = data.angle || '';
  var context = (data.context || '').trim();

  if (!context) {
    return ContentService.createTextOutput(JSON.stringify({
      error: 'Escribí primero el contexto o la idea del copy.'
    })).setMimeType(ContentService.MimeType.JSON);
  }

  var prompt =
    'Sos un/a community manager escribiendo el copy para un ' + kindLabel + ' de Instagram' +
    (angle ? (' con ángulo de contenido "' + angle + '"') : '') + '. ' +
    'Escribí en español, con tono cercano y natural (podés usar "vos"), listo para publicar. ' +
    'No agregues hashtags a menos que el contexto los pida explícitamente. ' +
    'No repitas el contexto de forma literal, escribilo como copy real. ' +
    'Idea / contexto: "' + context + '". ' +
    'Devolvé SOLO el texto del copy, sin explicaciones, sin comillas, sin encabezados.';

  // Usamos el alias "gemini-flash-latest" en vez de un nombre de modelo fijo: Google lo redirige
  // automáticamente al modelo Flash vigente, así este script no se rompe cada vez que renombran
  // o discontinúan una versión puntual (ya nos pasó dos veces).
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=' + apiKey;
  var payload = { contents: [{ parts: [{ text: prompt }] }] };

  try {
    var response = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    var json = JSON.parse(response.getContentText());

    if (json.error) {
      return ContentService.createTextOutput(JSON.stringify({
        error: json.error.message || 'Error de la API de Gemini'
      })).setMimeType(ContentService.MimeType.JSON);
    }

    var text = json.candidates &&
               json.candidates[0] &&
               json.candidates[0].content &&
               json.candidates[0].content.parts &&
               json.candidates[0].content.parts[0] &&
               json.candidates[0].content.parts[0].text;

    if (!text) {
      return ContentService.createTextOutput(JSON.stringify({
        error: 'Gemini no devolvió texto. Probá de nuevo.'
      })).setMimeType(ContentService.MimeType.JSON);
    }

    return ContentService.createTextOutput(JSON.stringify({
      text: text.trim()
    })).setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({
      error: String(err)
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

function testGenerateCopy() {
  var result = handleGenerateCopy({ context: 'prueba', kind: 'reel', angle: 'Testimonios' });
  Logger.log(result.getContent());
}
