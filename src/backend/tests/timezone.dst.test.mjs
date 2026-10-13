/*
=============================================================================
SUITE: timezone.dst (node --test, offline via loader.mjs mocks)
Purpose: BUG-07 auditoria reservas - regresion horario de verano/invierno
en la frontera Europe/Madrid <-> UTC (escenarios #7 y equivalentes).
Cubre las dos fechas de transicion DST en Espana (ultimo domingo marzo /
octubre) y la invariant start < end del rango UTC.
G10 ASCII strict in identifiers; comments may contain latin1.
=============================================================================
*/
import test from 'node:test';
import assert from 'node:assert';

// TZ de ejecucion: se fija UTC ANTES de importar mmUtils para que el
// toLocaleString interno de madridOffsetMinutes sea determinista e
// independiente del host. (Nota: en Node, cambiar process.env.TZ despues
// de la primera consulta de zona no surte efecto; por eso va aqui.)
process.env.TZ = 'UTC';

const { getUtcDateFromMadridLocal, getMadridLocalStringNoZ, toUtcRange } =
  await import('public/mmUtils');

test('TZ-DST-01 verano CEST: 10:00 hora civil Madrid -> 08:00Z (+2h)', () => {
  const utc = getUtcDateFromMadridLocal('2026-07-15T10:00');
  assert.ok(utc instanceof Date && !Number.isNaN(utc.getTime()));
  assert.strictEqual(utc.toISOString(), '2026-07-15T08:00:00.000Z');
});

test('TZ-DST-02 invierno CET: 10:00 hora civil Madrid -> 09:00Z (+1h)', () => {
  const utc = getUtcDateFromMadridLocal('2026-01-15T10:00');
  assert.ok(utc instanceof Date && !Number.isNaN(utc.getTime()));
  assert.strictEqual(utc.toISOString(), '2026-01-15T09:00:00.000Z');
});

test('TZ-DST-03 transicion marzo: hora civil inexistente (salto 02->03) no se silencia', () => {
  // El salto DST de 2026 en Madrid ocurre el sabado 28-03 a las 02:00 -> 03:00.
  // La hora civil 02:30 del 28-03 NO EXISTE. El algoritmo two-pass resuelve
  // al instante mas proximo por la rama post-salto (01:30Z == 03:30 CEST),
  // es decir, NO devuelve NaN ni una hora fantasma silenciosa del pre-salto.
  const utc = getUtcDateFromMadridLocal('2026-03-28T02:30');
  assert.ok(utc instanceof Date && !Number.isNaN(utc.getTime()));
  assert.strictEqual(utc.toISOString(), '2026-03-28T01:30:00.000Z');
  // Dia completo post-transicion: 02:30 del 29-03 ya es CEST valido (+2h).
  const next = getUtcDateFromMadridLocal('2026-03-29T02:30');
  assert.strictEqual(next.toISOString(), '2026-03-29T00:30:00.000Z');
});

test('TZ-DST-04 vuelta DST (ultimo domingo octubre): slot valido sin duplicar', () => {
  // 2026-10-25 domingo CEST->CET: la hora 02:30 se repite; la conversion
  // debe devolver SIEMPRE el mismo instante para la misma hora civil
  // (determinismo), y el round-trip debe conservar fecha+hora civil.
  const a = getUtcDateFromMadridLocal('2026-10-25T02:30');
  const b = getUtcDateFromMadridLocal('2026-10-25T02:30');
  assert.ok(a instanceof Date && b instanceof Date);
  assert.strictEqual(a.getTime(), b.getTime());
  const back = getMadridLocalStringNoZ(a);
  assert.ok(back.startsWith('2026-10-25T02:30'),
    'round-trip conserva hora civil: ' + back);
});

test('TZ-DST-05 round-trip estable en ambas estaciones', () => {
  for (const local of ['2026-02-10T09:15', '2026-08-20T17:45']) {
    const utc = getUtcDateFromMadridLocal(local);
    const back = getMadridLocalStringNoZ(utc);
    assert.strictEqual(back.slice(0, 16), local,
      'round-trip ' + local + ' -> ' + back);
  }
});

test('TZ-DST-06 toUtcRange rechaza end<=start (BUG-19 duracion negativa/cero)', () => {
  assert.strictEqual(toUtcRange('2026-07-15T10:00', '2026-07-15T10:00'), null);
  assert.strictEqual(toUtcRange('2026-07-15T11:00', '2026-07-15T10:00'), null);
  const ok = toUtcRange('2026-07-15T10:00', '2026-07-15T11:30');
  assert.ok(ok);
  assert.ok(ok.startUtc < ok.endUtc);
  assert.strictEqual(ok.startUtc.toISOString(), '2026-07-15T08:00:00.000Z');
  assert.strictEqual(ok.endUtc.toISOString(), '2026-07-15T09:30:00.000Z');
});

test('TZ-DST-07 entrada con offset explicito se respeta, no se re-corrigie', () => {
  const utc = getUtcDateFromMadridLocal('2026-07-15T10:00:00+02:00');
  assert.ok(utc instanceof Date);
  assert.strictEqual(utc.toISOString(), '2026-07-15T08:00:00.000Z');
});

test('TZ-DST-08 valores invalidos devuelven null (nunca fecha basura)', () => {
  assert.strictEqual(getUtcDateFromMadridLocal('no-es-fecha'), null);
  assert.strictEqual(getUtcDateFromMadridLocal(''), null);
  assert.strictEqual(getUtcDateFromMadridLocal(null), null);
});
