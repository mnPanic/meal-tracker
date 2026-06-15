// Apps Script web app for the meal-tracker "Comidas" sheet.
// Deploy → New deployment → type "Web app" → execute as Me, access "Anyone".
// Copy the /exec URL into the SHEETS_WEBAPP_URL worker secret.
//
// Columns (A..F): Fecha | Comida | Modo | Calificacion | Score | Notas
//
// INTERFACE (see apps-script/README.md for the full contract):
//   read:      GET  ?fecha=YYYY-MM-DD (optional, default today)
//                -> { ok, fecha, entries:[{row,comida,modo,calificacion,score,notas}] }
//   append:    POST { action:"append", comida, modo, calificacion, notas }
//                -> { ok, row }      (new row dated TODAY)
//   overwrite: POST { action:"overwrite", row, comida, modo, calificacion, notas }
//                -> { ok, row }      (only if that row's Fecha is today, else error)
//
// Guarantees: append/overwrite only ever touch TODAY's rows; "today" is computed here in
// Buenos Aires time, not trusted from the caller. Score is always rewritten as the formula.

var SHEET_NAME = "Comidas";
var TZ = "America/Argentina/Buenos_Aires";
var COL = { FECHA: 1, COMIDA: 2, MODO: 3, CALIFICACION: 4, SCORE: 5, NOTAS: 6 };

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// Shared-secret auth. Access must be "Anyone" so the Worker can call it, so we authenticate with
// a token instead. Set it once via the editor: run setSecret() after pasting your token, OR add a
// Script Property named API_SECRET (Project Settings → Script Properties). Requests without the
// matching token are rejected.
function checkAuth_(token) {
  var expected = PropertiesService.getScriptProperties().getProperty("API_SECRET");
  if (!expected) throw new Error("API_SECRET no configurado");
  if (token !== expected) throw new Error("unauthorized");
}

// One-time helper: edit the value, run this once from the editor, then delete the literal.
function setSecret() {
  PropertiesService.getScriptProperties().setProperty("API_SECRET", "PASTE_YOUR_SECRET_HERE");
}

function sheet_() {
  var s = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!s) throw new Error("No existe la pestaña '" + SHEET_NAME + "'");
  return s;
}

function todayStr_() {
  return Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd");
}

function fechaStr_(value) {
  // A Fecha cell is a Date; format it in BA time to compare day-to-day.
  if (Object.prototype.toString.call(value) === "[object Date]") {
    return Utilities.formatDate(value, TZ, "yyyy-MM-dd");
  }
  return String(value);
}

function scoreFormula_(row) {
  // Sheet locale is Spanish → argument separator is ";", not ",".
  return '=SWITCH(C' + row + ';"Casa";2;"Delivery";1;"Afuera";0)' +
         '+SWITCH(D' + row + ';"OK";3;"Mid";1;"Bad";0)';
}

// Write fields + Score formula into an existing row number.
function writeRow_(sheet, row, fecha, data) {
  sheet.getRange(row, COL.FECHA).setValue(fecha);
  sheet.getRange(row, COL.COMIDA).setValue(data.comida);
  sheet.getRange(row, COL.MODO).setValue(data.modo);
  sheet.getRange(row, COL.CALIFICACION).setValue(data.calificacion);
  sheet.getRange(row, COL.SCORE).setFormula(scoreFormula_(row));
  sheet.getRange(row, COL.NOTAS).setValue(data.notas);
}

function sheetByName_(name) {
  var s = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!s) throw new Error("No existe la pestaña '" + name + "'");
  return s;
}

// Read the "View diario" summary tab (one row per day). Optional ?last=N to cap to the
// most recent N days; default returns all.
function readDiario_(p) {
  var values = sheetByName_("View diario").getDataRange().getValues();
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var r = values[i];
    if (!r[0]) continue; // skip blank rows
    rows.push({
      fecha: fechaStr_(r[0]),
      evento: r[1] || "",
      desayuno: r[2] || "",
      almuerzo: r[3] || "",
      merienda: r[4] || "",
      cena: r[5] || "",
      score: r[6],
      notas: { desayuno: r[7] || "", almuerzo: r[8] || "", merienda: r[9] || "", cena: r[10] || "" },
    });
  }
  var last = Number(p.last);
  if (last > 0 && rows.length > last) rows = rows.slice(rows.length - last);
  return json_({ ok: true, view: "diario", rows: rows });
}

// Read one of the two side-by-side tables in "View semanalmensual".
// kind "semanal" = cols A-D, "mensual" = cols F-I. Optional ?last=N.
function readPeriodo_(kind, p) {
  var off = kind === "mensual" ? 5 : 0; // column offset (F is index 5)
  var values = sheetByName_("View semanalmensual").getDataRange().getValues();
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var r = values[i];
    if (!r[off]) continue; // blank → end/gap of this table
    rows.push({
      inicio: fechaStr_(r[off]),     // week-start or month-start date
      label: r[off + 1] || "",       // e.g. "2026-06 W2" or "2026-06"
      promedio: r[off + 2],          // average score for the period
      eventos: r[off + 3] || "",
    });
  }
  var last = Number(p.last);
  if (last > 0 && rows.length > last) rows = rows.slice(rows.length - last);
  return json_({ ok: true, view: kind, rows: rows });
}

function doGet(e) {
  try {
    var p = e.parameter || {};
    checkAuth_(p.token);
    if (p.view === "diario") return readDiario_(p);
    if (p.view === "semanal") return readPeriodo_("semanal", p);
    if (p.view === "mensual") return readPeriodo_("mensual", p);

    // Default: raw entries from the Comidas tab for a single day (with row numbers).
    var sheet = sheet_();
    var target = p.fecha ? p.fecha : todayStr_();
    var values = sheet.getDataRange().getValues();
    var entries = [];
    // Row 1 is the header; data starts at row 2.
    for (var i = 1; i < values.length; i++) {
      var r = values[i];
      if (fechaStr_(r[COL.FECHA - 1]) === target) {
        entries.push({
          row: i + 1,
          comida: r[COL.COMIDA - 1],
          modo: r[COL.MODO - 1],
          calificacion: r[COL.CALIFICACION - 1],
          score: r[COL.SCORE - 1],
          notas: r[COL.NOTAS - 1],
        });
      }
    }
    return json_({ ok: true, fecha: target, entries: entries });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var data = JSON.parse(e.postData.contents);
    checkAuth_(data.token);
    var sheet = sheet_();
    var today = todayStr_();

    if (data.action === "append") {
      var parts = today.split("-"); // yyyy-MM-dd
      var fecha = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
      sheet.appendRow([fecha, data.comida, data.modo, data.calificacion, "", data.notas]);
      var row = sheet.getLastRow();
      sheet.getRange(row, COL.SCORE).setFormula(scoreFormula_(row));
      return json_({ ok: true, row: row });

    } else if (data.action === "overwrite") {
      var row = Number(data.row);
      if (!row || row < 2) return json_({ ok: false, error: "row inválida" });
      var existing = sheet.getRange(row, COL.FECHA).getValue();
      if (fechaStr_(existing) !== today) {
        return json_({ ok: false, error: "row not from today" });
      }
      writeRow_(sheet, row, existing, data); // keep the existing (today's) date
      return json_({ ok: true, row: row });

    } else {
      return json_({ ok: false, error: "action desconocida: " + data.action });
    }
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}
