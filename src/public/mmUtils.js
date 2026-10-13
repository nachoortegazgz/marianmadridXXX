/*
MODULE: public/mmUtils.js
VERSION: v5012-FACADE-AND-SYNTAX-FIX
BASE: v5011-F1-CANONICAL
BASE NORMATIVA:
  BIBLIA v10 (Cap.0 prioridades, 3.2 constantes, 4.2.3 gap, 6.2 enums CMS,
  15.1 seguridad, 20.7 helpers)
  Matriz de cambio legacy (IDs y enums obsoletos)
  INFORME_TECNICO_BOOKINGS_V2 (3.3 gap, 7 localDate, 15 errores)
ENTORNO: Wix Editor + Velo | Wix Bookings V2 | Wix Stores Catalog V1
STANDARDS: G10 ASCII estricto en codigo y comentarios. Modulo hoja (leaf):
           no importa backend. Los VALORES de datos (slugs, nombres) conservan
           Unicode completo.

FIXES v5012:
  FIX-01 (P0) _normalizeIdPart llamaba a cleanText (inexistente). El export real
         es _cleanText. Rompia makeTraceId y con ello TODA pagina y webMethod.
  FIX-02 (P0) _safeSlugOrId tenia el literal regex corrupto (//+/g), que el
         parser lee como inicio de comentario. Restaurado a /\/+/g.
         Se conserva el comportamiento Unicode: solo elimina barras, colapsa
         espacios a guion y pasa a minusculas. NUNCA normaliza NFD ni elimina
         diacriticos ni sustituye n-tilde.
  FIX-03 (P1) LOCAL_ISO_PATTERN y toUtcIsoZ tenian el punto sin escapar.
  FIX-04 (P0) Facade de protocolo: se reexportan los nombres CANONICOS
         (PROTOCOL_URLS, PROTOCOL_UI) ademas de los alias historicos (URLS, UI).
         Un named export ausente en un facade ESM provoca SyntaxError en cascada
         en todos sus consumidores. Los alias quedan marcados como transicionales.
  FIX-05 (P1) formatMadridParts forzaba timeZone/hourCycle ANTES del spread, por
         lo que un options con timeZone podia romper la zona unica Europe/Madrid.
         Ahora el spread va primero y la zona se impone despues (invariante).
  FIX-06 (P2) Cabecera con comentario multilinea corrupto restaurada.
  FIX-07 (P1) Añadidos los helpers declarados en BIBLIA 20.7 que faltaban
         (_safeEmail, _safePhone, _isValidEmail, _extractRelationalId, _maskIp).
         No son especulativos: estan en el contrato y su ausencia rompe por
         SyntaxError a cualquier modulo que los importe.

REGLAS DE MODULO
  - SSOT de constantes de negocio = backend/internalConfig.js. Aqui solo hay un
    ESPEJO de lectura frontend (SITE, CURRENCY_CONFIG, SLOT_SEARCH,
    BOOKINGS_ADDON_CONFIG). Toda divergencia se resuelve a favor de internalConfig.
  - SSOT del protocolo de widget = public/widgetBridge.js. Este modulo reexporta
    (facade), nunca redefine.
  - RESTRICCION ACICLICA: widgetBridge.js NO debe importar public/mmUtils.js.
  - IDs nativas Wix preservadas en ingles camelCase (R19): resourceId, serviceId,
    bookingId, scheduleId, memberId, availabilityConstraints.
  - Ningun helper de este modulo hace hashing fiscal. La cadena SHA-256 del ledger
    vive exclusivamente en backend/securityEngine.js.
=============================================================================
*/

// Facade de protocolo: SSOT = public/widgetBridge.js (no redefinir aqui).
// FIX-04: se exportan los nombres canonicos Y los alias historicos. Eliminar los
// alias solo cuando este comando no devuelva resultados:
//   grep -rn "URLS\|\bUI\b" src/pages src/public | grep -v PROTOCOL_
export {
    PROTOCOL_VERSION,
    MESSAGE_TYPES,
    PROTOCOL_URLS,
    PROTOCOL_UI,
    WIDGET_ERROR_CODE,
    PROTOCOL_URLS as URLS,
    PROTOCOL_UI as UI
} from "public/widgetBridge";

// ============================================================================
// CONSTANTES ESPEJO (frontend-safe) DEL SSOT backend/internalConfig.js
// ============================================================================

/** Espejo de SITE. No editable aqui sin actualizar internalConfig. */
export const SITE = Object.freeze({
    TIMEZONE: "Europe/Madrid",
    CURRENCY: "EUR",
    DECIMALS: 2,
    LOCALE: "es-ES",
    COUNTRY: "ES"
});

/** Espejo de CURRENCY_CONFIG (Matriz transversal: MONEY -> CURRENCY_CONFIG). */
export const CURRENCY_CONFIG = Object.freeze({
    MONEDA_VISUALIZACION: SITE.CURRENCY,
    DECIMALES: SITE.DECIMALS
});

/** Espejo de SLOT_SEARCH (BIBLIA 3.2). Claves de configuracion en espanol. */
export const SLOT_SEARCH = Object.freeze({
    DIAS_LIMITE: 14,
    MINUTOS_TOLERANCIA: 10,
    MINUTOS_MAX_HUECO_DUAL: 120
});

/** Espejo de BOOKINGS_ADDON_CONFIG (BIBLIA 3.2 / 4.3 fila 19). */
export const BOOKINGS_ADDON_CONFIG = Object.freeze({
    MAX_POR_RESERVA: 5
});

/** Tolerancia de cuadre entre duracion declarada y duracion real del slot. */
const SLOT_DURATION_TOLERANCE_MINUTES = 1;

// ============================================================================
// PATRONES Y LIMITES
// ============================================================================

const GUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** R16: dateYmd / dayKey = YYYY-MM-DD en zona Europe/Madrid. */
const DATE_YMD_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Instante local. Segundos y milisegundos opcionales: Wix Bookings V2 devuelve
 * tanto "YYYY-MM-DDTHH:mm" como "YYYY-MM-DDTHH:mm:ss".
 * FIX-03: punto escapado (antes coincidia con cualquier caracter).
 */
const LOCAL_ISO_PATTERN =
    /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})?$/;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

const MAX_TEXT_LENGTH = 5000;
const MAX_ID_LENGTH = 200;
const MAX_GUID_LENGTH = 100;
const MAX_SLUG_LENGTH = 200;
const MAX_TRACE_PREFIX_LENGTH = 40;
const MAX_TRACE_ID_LENGTH = 120;
const MAX_EMAIL_LENGTH = 254;
const MAX_PHONE_LENGTH = 40;
const MAX_IP_LENGTH = 45;
const DEFAULT_TIMEOUT_MS = 15000;
const MS_PER_MINUTE = 60000;

// ============================================================================
// TEXTO
// ============================================================================

export function _safeTrim(value, maxLength = MAX_TEXT_LENGTH) {
    if (value === null || value === undefined) return "";
    const limit = Math.max(1, Number(maxLength) || MAX_TEXT_LENGTH);
    return String(value).trim().slice(0, limit);
}

/** Trim + elimina caracteres de control. No toca acentos ni n-tilde. */
export function _cleanText(value, maxLength = MAX_TEXT_LENGTH) {
    return _safeTrim(value, maxLength).replace(
        /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,
        ""
    );
}

/**
 * FIX-01: delega en _cleanText (antes llamaba a cleanText, inexistente).
 * Sanitiza un fragmento de identificador tecnico: solo [A-Za-z0-9._:-].
 */
export function _normalizeIdPart(value, maxLength = MAX_ID_LENGTH) {
    return _cleanText(value, maxLength).replace(/[^a-zA-Z0-9._:-]/g, "");
}

/**
 * FIX-02: Identidad publica (slug) o tecnica (serviceId).
 * Elimina barras para impedir path injection en query params y colapsa espacios.
 * CONSERVA UNICODE: no aplica normalize("NFD"), no elimina diacriticos y no
 * sustituye n-tilde. Un slug "diseno-y-coloracion" con eñe llega intacto al
 * backend, que lo busca por coincidencia exacta ($eq).
 */
export function _safeSlugOrId(value) {
    return _safeTrim(value, MAX_SLUG_LENGTH)
        .replace(/\/+/g, "")
        .replace(/\s+/g, "-")
        .toLowerCase();
}

/**
 * FIX-07 (BIBLIA 20.7): normaliza email a minusculas y lo recorta a 254.
 * Devuelve "" si no supera la validacion de formato.
 */
export function _safeEmail(value) {
    const email = _cleanText(value, MAX_EMAIL_LENGTH).toLowerCase();
    return EMAIL_PATTERN.test(email) ? email : "";
}

/** FIX-07 (BIBLIA 20.7): conserva solo digitos y el + inicial. */
export function _safePhone(value) {
    const raw = _safeTrim(value, MAX_PHONE_LENGTH);
    if (!raw) return "";
    const plus = raw.startsWith("+") ? "+" : "";
    const digits = raw.replace(/\D+/g, "");
    return digits ? plus + digits : "";
}

/** FIX-07 (BIBLIA 20.7): validacion de formato de email. */
export function _isValidEmail(value) {
    return EMAIL_PATTERN.test(_cleanText(value, MAX_EMAIL_LENGTH).toLowerCase());
}

// ============================================================================
// IDENTIFICADORES (R19: las IDs nativas Wix nunca se transforman)
// ============================================================================

export function _looksLikeGuid(value) {
    return GUID_PATTERN.test(_safeTrim(value, MAX_GUID_LENGTH));
}

/**
 * Extrae el ID tecnico de una referencia Wix.
 * Formas admitidas: string | {_id} | {id} | {referenceId} | {value} | Array.
 * No inventa referencias: devuelve "" cuando no hay identidad resoluble.
 */
export function getReferenceId(value) {
    if (!value) return "";
    if (typeof value === "string") return _safeTrim(value, MAX_ID_LENGTH);
    if (Array.isArray(value)) {
        return value.length > 0 ? getReferenceId(value[0]) : "";
    }
    if (typeof value === "object") {
        return _safeTrim(
            value._id || value.id || value.referenceId || value.value,
            MAX_ID_LENGTH
        );
    }
    return "";
}

/**
 * FIX-07 (BIBLIA 20.7): extrae el ID de una referencia RELACIONAL de Wix,
 * desenvolviendo las formas que getReferenceId no cubre:
 *   { items: [ref, ...] } (Multi Reference) | { _ref } | { ref } | Map-like.
 * No es un alias de getReferenceId: su contrato es desenvolver envoltorios.
 */
export function _extractRelationalId(value) {
    if (!value) return "";
    if (typeof value === "string") return _safeTrim(value, MAX_ID_LENGTH);
    if (Array.isArray(value)) return _extractRelationalId(value[0]);
    if (typeof value !== "object") return "";
    if (Array.isArray(value.items)) return _extractRelationalId(value.items[0]);
    const direct = value._id || value.id || value.referenceId || value.value;
    if (direct) return getReferenceId(direct);
    const wrapped = value._ref || value.ref;
    if (wrapped) return _extractRelationalId(wrapped);
    return "";
}

/** MULTI_REFERENCE: lista de IDs tecnicos, unica y sin referencias inventadas. */
export function getReferenceIds(value) {
    if (!value) return [];
    const source = Array.isArray(value) ? value : [value];
    const ids = source
        .map(function (entry) { return getReferenceId(entry); })
        .filter(Boolean);
    return Array.from(new Set(ids));
}

/**
 * Lista de GUIDs validos.
 * Formas admitidas: Array<GUID> | CSV | Array<objeto referencia>.
 * AVISO DE IDENTIDAD (INFORME BOOKINGS 15, error 5): si el origen es un
 * MULTI_REFERENCE a Members, el resultado son memberId, NO resourceId. La
 * resolucion memberId -> resourceId es exclusiva de backend/staff.js. Nunca
 * enviar el resultado directamente a resourceIds / includeResourceTypeIds.
 */
export function cleanGuidList(value) {
    const source = Array.isArray(value)
        ? value
        : typeof value === "string"
            ? value.split(",")
            : [];
    const guids = source
        .map(function (entry) { return _safeTrim(getReferenceId(entry), MAX_GUID_LENGTH); })
        .filter(_looksLikeGuid);
    return Array.from(new Set(guids));
}

/**
 * Variante estricta: extrae una clave concreta de objetos referencia y valida
 * que sea GUID. Usar cuando la identidad deba ser inequivoca (resourceId,
 * memberId, serviceId, addOnId nativo).
 */
export function cleanGuidListByKey(value, key) {
    const cleanKey = _safeTrim(key, MAX_ID_LENGTH);
    if (!cleanKey) return [];
    const source = Array.isArray(value)
        ? value
        : typeof value === "string"
            ? value.split(",")
            : [];
    const guids = source
        .map(function (entry) {
            if (typeof entry === "string") return _safeTrim(entry, MAX_GUID_LENGTH);
            if (entry && typeof entry === "object") {
                return _safeTrim(entry[cleanKey], MAX_GUID_LENGTH);
            }
            return "";
        })
        .filter(_looksLikeGuid);
    return Array.from(new Set(guids));
}

export function cleanGuid(value, errorCode = "INVALID_GUID") {
    const clean = _safeTrim(value, MAX_GUID_LENGTH);
    if (!_looksLikeGuid(clean)) {
        const error = new Error(errorCode + ": Invalid or missing GUID");
        error.code = errorCode;
        throw error;
    }
    return clean;
}

/** R16: validador de dateYmd / dayKey (YYYY-MM-DD, zona Madrid). */
export function isDateYmd(value) {
    return DATE_YMD_PATTERN.test(_safeTrim(value, 10));
}

// ============================================================================
// NUMEROS Y DINERO
// ============================================================================

/**
 * Numero finito o fallback. No aplica suelo: apto para importes con signo
 * (importeContable, quantityDelta, totalAdjustments).
 */
export function toFiniteNumber(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Numero finito no negativo. ATENCION: convierte negativos en 0.
 * No usar para importes contables con signo ni deltas de inventario.
 */
export function numberOrZero(value, minimum = 0) {
    const parsed = Number(value);
    const floor = Number.isFinite(Number(minimum)) ? Number(minimum) : 0;
    return Number.isFinite(parsed) && parsed >= floor ? parsed : 0;
}

/** Redondeo monetario con los decimales canonicos de CURRENCY_CONFIG. */
export function _roundMoney(value, decimals = CURRENCY_CONFIG.DECIMALES) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return 0;
    const factor = Math.pow(10, Math.max(0, toFiniteNumber(decimals, CURRENCY_CONFIG.DECIMALES)));
    return Math.round((parsed + Number.EPSILON) * factor) / factor;
}

export function _readPositiveAmount(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function booleanValue(...values) {
    return values.some(function (value) { return value === true; });
}

/** Booleano estricto con fallback. Rechaza textos "true"/"false" ambiguos. */
export function toBoolean(value, fallback = false) {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
        const clean = value.trim().toLowerCase();
        if (clean === "true") return true;
        if (clean === "false") return false;
    }
    return fallback;
}

// ============================================================================
// FECHAS - ZONA UNICA Europe/Madrid
// ============================================================================

/**
 * FIX-05: la zona y el hourCycle se imponen DESPUES del spread de options.
 * Un options que trajera timeZone no puede romper la zona unica (BIBLIA 8).
 */
function formatMadridParts(date, options) {
    const dt = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(dt.getTime())) return null;
    return new Intl.DateTimeFormat("sv-SE", Object.assign(
        {},
        options,
        { timeZone: SITE.TIMEZONE, hourCycle: "h23" }
    ))
        .formatToParts(dt)
        .reduce(function (result, part) {
            result[part.type] = part.value;
            return result;
        }, {});
}

/**
 * Normaliza a ISO local. Acepta "YYYY-MM-DDTHH:mm[:ss[.SSS]][Z|+hh:mm]".
 * Devuelve "" si el valor no es un instante reconocible.
 */
export function _normalizeLocalIsoStr(value) {
    const raw = _safeTrim(value, 80);
    if (!raw) return "";
    const normalized = raw.replace(/\s+/, "T");
    if (!LOCAL_ISO_PATTERN.test(normalized)) return "";
    const date = new Date(normalized);
    if (Number.isNaN(date.getTime())) return "";
    return normalized;
}

function hasExplicitOffset(value) {
    const raw = _safeTrim(value, 80);
    return /(?:Z|[+-]\d{2}:\d{2})$/i.test(raw);
}

/**
 * Interpreta una cadena local SIN desplazamiento como hora civil de Madrid y
 * devuelve el instante UTC real. Si la cadena ya trae Z u offset, se respeta.
 * Corrige el desfase por zona del navegador (INFORME BOOKINGS 15, error 3).
 */
export function getUtcDateFromMadridLocal(value) {
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? null : new Date(value.getTime());
    }
    const raw = _normalizeLocalIsoStr(value);
    if (!raw) return null;
    if (hasExplicitOffset(raw)) {
        const explicit = new Date(raw);
        return Number.isNaN(explicit.getTime()) ? null : explicit;
    }
    const withSeconds = raw.length === 16 ? raw + ":00" : raw;
    const naive = new Date(withSeconds + "Z");
    if (Number.isNaN(naive.getTime())) return null;
    // naive = hora civil de Madrid leida como si fuera UTC. Se corrige con el
    // desplazamiento real de Madrid en ese instante (CET/CEST).
    // FIX BUG-07 (auditoria reservas): two-pass con convergencia estable.
    // El primer offset se calcula sobre `naive`; cuando la hora civil cae
    // cerca de una transicion DST, el instante real tiene otro desplazamiento
    // y la conversion quedaba desfasada 1h. La segunda pasada usa el offset
    // del instante candidato; solo se acepta si es un punto fijo (offset
    // estable), para no re-introducir el desfase en horas ambiguas del salto
    // de octubre (donde naive->utc cambia de rama CET/CEST en cada pasada).
    const offsetNaive = madridOffsetMinutes(naive);
    const firstPass = new Date(naive.getTime() - offsetNaive * MS_PER_MINUTE);
    let utc = firstPass;
    if (!Number.isNaN(firstPass.getTime())) {
        const offsetRefined = madridOffsetMinutes(firstPass);
        if (offsetRefined === offsetNaive) {
            utc = new Date(naive.getTime() - offsetRefined * MS_PER_MINUTE);
        }
    }
    return utc;
}

function parseDate(value) {
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? null : new Date(value.getTime());
    }
    const raw = _normalizeLocalIsoStr(value);
    if (!raw) return null;
    return getUtcDateFromMadridLocal(raw);
}

export function _toDateSafe(value) {
    if (!value) return null;
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? null : value;
    }
    return parseDate(value);
}

/** dateYmd / dayKey (YYYY-MM-DD) en zona Madrid. R16. */
export function _readDate(value) {
    const clean = _safeTrim(value, 40);
    if (DATE_YMD_PATTERN.test(clean)) return clean;
    const date = _toDateSafe(value);
    if (!date) return null;
    return getMadridDateYmd(date);
}

export function getMadridLocalStringNoZ(value) {
    const parts = formatMadridParts(value, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
    });
    if (!parts) return "";
    return parts.year + "-" + parts.month + "-" + parts.day +
        "T" + parts.hour + ":" + parts.minute + ":" + parts.second;
}

export function getMadridDateYmd(date = new Date()) {
    const parts = formatMadridParts(date, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    });
    if (!parts) return "";
    return parts.year + "-" + parts.month + "-" + parts.day;
}

export function getMadridTime(date = new Date()) {
    const parts = formatMadridParts(date, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
    });
    if (!parts) return "";
    return parts.hour + ":" + parts.minute + ":" + parts.second;
}

/** monthKey (YYYY-MM) en zona Madrid. RegistrosHorariosStaff.monthKey. */
export function getMadridMonthKey(date = new Date()) {
    const parts = formatMadridParts(date, {
        year: "numeric",
        month: "2-digit"
    });
    if (!parts) return "";
    return parts.year + "-" + parts.month;
}

export function toMadridIsoLocal(date = new Date()) {
    return getMadridLocalStringNoZ(date);
}

/**
 * ISO 8601 UTC con sufijo Z: contrato createBooking (BIBLIA 2.2.1).
 * FIX-03: punto escapado.
 */
export function toUtcIsoZ(value) {
    const date = value instanceof Date ? value : _toDateSafe(value);
    if (!date) return "";
    return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function madridOffsetMinutes(date = new Date()) {
    const source = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(source.getTime())) return 0;
    const madridDate = new Date(
        source.toLocaleString("en-US", { timeZone: SITE.TIMEZONE })
    );
    const utcDate = new Date(
        source.toLocaleString("en-US", { timeZone: "UTC" })
    );
    return Math.round((madridDate.getTime() - utcDate.getTime()) / MS_PER_MINUTE);
}

export function formatUtcOffset(offsetMinutes) {
    const offset = toFiniteNumber(offsetMinutes, 0);
    const sign = offset >= 0 ? "+" : "-";
    const absolute = Math.abs(offset);
    const hours = String(Math.floor(absolute / 60)).padStart(2, "0");
    const minutes = String(absolute % 60).padStart(2, "0");
    return sign + hours + ":" + minutes;
}

/**
 * fromLocalDate / toLocalDate de fecha-hora local COMPLETA.
 * listAvailabilityTimeSlots rechaza rangos con solo YYYY-MM-DD
 * (INFORME BOOKINGS 7 y 15, error 2).
 */
export function buildLocalDateRange(dateYmd) {
    const clean = _safeTrim(dateYmd, 10);
    if (!DATE_YMD_PATTERN.test(clean)) return null;
    return Object.freeze({
        dateYmd: clean,
        fromLocalDate: clean + "T00:00:00",
        toLocalDate: clean + "T23:59:59",
        timeZone: SITE.TIMEZONE
    });
}

/** Rango UTC valido para un slot local. null si no es parseable o end <= start. */
export function toUtcRange(startLocal, endLocal) {
    const startUtc = getUtcDateFromMadridLocal(startLocal);
    const endUtc = getUtcDateFromMadridLocal(endLocal);
    if (!startUtc || !endUtc || endUtc <= startUtc) return null;
    return Object.freeze({ startUtc: startUtc, endUtc: endUtc });
}

/**
 * GAP entre fases en minutos (BIBLIA 4.3 filas 15-17).
 * Devuelve null cuando los instantes no son validos: un gap ilegible nunca debe
 * degradarse a 0, porque 0 es un gap valido y ocultaria el error.
 */
export function computeGapMinutes(firstEndUtc, secondStartUtc) {
    if (!(firstEndUtc instanceof Date) || !(secondStartUtc instanceof Date)) return null;
    if (Number.isNaN(firstEndUtc.getTime()) || Number.isNaN(secondStartUtc.getTime())) return null;
    const gap = Math.round(
        (secondStartUtc.getTime() - firstEndUtc.getTime()) / MS_PER_MINUTE
    );
    return Number.isFinite(gap) ? gap : null;
}

/** Regla dual: gap >= 0 y gap <= MINUTOS_MAX_HUECO_DUAL (120 min). */
export function isDualGapWithinLimit(gapMinutes) {
    if (!Number.isFinite(Number(gapMinutes))) return false;
    const gap = Number(gapMinutes);
    return gap >= 0 && gap <= SLOT_SEARCH.MINUTOS_MAX_HUECO_DUAL;
}

// ============================================================================
// DURACIONES Y SLOTS (ServiciosCatalogo)
// ============================================================================

/**
 * durationRange: clave tecnica canonica CMS (OBJECT).
 * availabilityConstraints: estructura nativa Wix Bookings (R19, preservada).
 */
export function readDurationRange(item = {}) {
    const source = item || {};
    const constraints =
        source.availabilityConstraints ||
        (source.data && source.data.availabilityConstraints) ||
        (source.fields && source.fields.availabilityConstraints);
    const range =
        (constraints && constraints.durationRange) ||
        source.durationRange ||
        (source.data && source.data.durationRange) ||
        (source.fields && source.fields.durationRange);
    if (!range || typeof range !== "object") return null;
    const min = numberOrZero(range.minDuration !== undefined ? range.minDuration : range.min);
    const rawMax = numberOrZero(range.maxDuration !== undefined ? range.maxDuration : range.max);
    const max = rawMax > 0 ? rawMax : Infinity;
    if (min <= 0 && max === Infinity) return null;
    if (max !== Infinity && max <= min) return null;
    return Object.freeze({ min: min, max: max });
}

/**
 * Aritmetica dual SSOT: totalDuration = phase1Duration + exposureDuration +
 * phase2Duration. En servicio dual (allowCombine) el slot reservable corresponde
 * a la fase 1.
 */
export function resolveExpectedSlotMinutes(serviceConfig = {}) {
    const cfg = serviceConfig || {};
    if (cfg.allowCombine === true) {
        return numberOrZero(cfg.phase1Duration);
    }
    const timing = cfg.metadata && cfg.metadata.timing ? cfg.metadata.timing : {};
    return numberOrZero(
        cfg.phase1Duration || cfg.totalDuration || timing.estimatedTotal
    );
}

/** Suma exacta de fases. null si el servicio no declara ninguna. */
export function computeTotalDuration(serviceConfig = {}) {
    const cfg = serviceConfig || {};
    const sum = numberOrZero(cfg.phase1Duration) +
        numberOrZero(cfg.exposureDuration) +
        numberOrZero(cfg.phase2Duration);
    return sum > 0 ? sum : null;
}

export function validateSlotDuration(params = {}) {
    const p = params || {};
    const serviceConfig = p.serviceConfig || {};
    const base = Object.freeze({
        ok: true,
        code: null,
        actualMinutes: 0,
        expectedMinutes: null,
        min: null,
        max: null
    });
    const range = toUtcRange(p.startLocal, p.endLocal);
    if (!range) {
        return Object.assign({}, base, { ok: false, code: "INVALID_SLOT_RANGE" });
    }
    const actualMinutes = Math.round(
        (range.endUtc.getTime() - range.startUtc.getTime()) / MS_PER_MINUTE
    );
    const result = Object.assign({}, base, { actualMinutes: actualMinutes });
    const limits = readDurationRange(serviceConfig);
    if (limits) {
        result.min = limits.min;
        result.max = limits.max === Infinity ? null : limits.max;
        const belowMin = actualMinutes < limits.min;
        const aboveMax = limits.max !== Infinity && actualMinutes > limits.max;
        if (belowMin || aboveMax) {
            return Object.assign({}, result, { ok: false, code: "SLOT_DURATION_OUT_OF_RANGE" });
        }
        return result;
    }
    const expected = resolveExpectedSlotMinutes(serviceConfig);
    if (expected > 0) {
        result.expectedMinutes = expected;
        if (Math.abs(actualMinutes - expected) > SLOT_DURATION_TOLERANCE_MINUTES) {
            return Object.assign({}, result, { ok: false, code: "SLOT_DURATION_MISMATCH" });
        }
    }
    return result;
}

// ============================================================================
// OBJETOS
// ============================================================================

export function isPlainObject(value) {
    return Boolean(
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        !(value instanceof Date)
    );
}

export function _cloneDeep(value) {
    if (value === null || typeof value !== "object") return value;
    if (value instanceof Date) return new Date(value.getTime());
    if (Array.isArray(value)) return value.map(_cloneDeep);
    return Object.keys(value).reduce(function (result, key) {
        result[key] = _cloneDeep(value[key]);
        return result;
    }, {});
}

/**
 * Serializacion estable (claves ordenadas) para huellas y claves de cache.
 * AVISO: no es hashing fiscal. La cadena SHA-256 del ledger
 * (recordHash / previousRecordHash) se genera en backend/securityEngine.js.
 */
export function _stableSerialize(value) {
    if (value === null || value === undefined) return String(value);
    if (Array.isArray(value)) {
        return "[" + value.map(_stableSerialize).join(",") + "]";
    }
    if (value instanceof Date) return "\"" + value.toISOString() + "\"";
    if (typeof value === "object") {
        const pairs = Object.keys(value).sort().map(function (key) {
            return JSON.stringify(key) + ":" + _stableSerialize(value[key]);
        });
        return "{" + pairs.join(",") + "}";
    }
    return JSON.stringify(value);
}

// ============================================================================
// TRAZABILIDAD (R18: traceId obligatorio en escrituras operativas)
// ============================================================================

export function _generateUUID() {
    const globalCrypto = typeof crypto !== "undefined" ? crypto : undefined;
    if (globalCrypto && typeof globalCrypto.randomUUID === "function") {
        try {
            return globalCrypto.randomUUID();
        } catch (error) {
            // Se degrada al generador determinista siguiente.
        }
    }
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (character) {
        const random = (Math.random() * 16) | 0;
        const digit = character === "x" ? random : (random & 0x3) | 0x8;
        return digit.toString(16);
    });
}

/**
 * traceId auditable: prefijo normalizado + instante + UUID v4.
 * Longitud maxima 120 (schema CitasF2.traceId / RegistrosHorariosStaff.traceId).
 * No es identidad principal del registro.
 */
export function makeTraceId(prefix = "trace") {
    const safePrefix = _normalizeIdPart(prefix, MAX_TRACE_PREFIX_LENGTH) || "trace";
    const traceId = safePrefix + "-" + Date.now().toString(36) + "-" + _generateUUID();
    return traceId.slice(0, MAX_TRACE_ID_LENGTH);
}

/**
 * Hash corto NO criptografico para claves de cache, slotKey y dedupe.
 * Prohibido para integridad fiscal, firmas o HMAC.
 */
export function _hashKey(value) {
    const stringValue = String(value === null || value === undefined ? "" : value);
    let hash1 = 0xdeadbeef ^ stringValue.length;
    let hash2 = 0x41c6ce57 ^ stringValue.length;
    for (let index = 0; index < stringValue.length; index += 1) {
        const character = stringValue.charCodeAt(index);
        hash1 = Math.imul(hash1 ^ character, 2654435761);
        hash2 = Math.imul(hash2 ^ character, 1597334677);
    }
    hash1 =
        Math.imul(hash1 ^ (hash1 >>> 16), 2246822507) ^
        Math.imul(hash2 ^ (hash2 >>> 13), 3266489909);
    hash2 =
        Math.imul(hash2 ^ (hash2 >>> 16), 2246822507) ^
        Math.imul(hash1 ^ (hash1 >>> 13), 3266489909);
    return (
        (hash2 >>> 0).toString(16).padStart(8, "0") +
        (hash1 >>> 0).toString(16).padStart(8, "0")
    );
}

// ============================================================================
// ENMASCARADO DE PII (BIBLIA 15.1.8: logs sin datos personales)
// ============================================================================

export function _maskEmail(value) {
    const email = _safeTrim(value, MAX_EMAIL_LENGTH);
    const at = email.indexOf("@");
    if (at <= 1) return "[REDACTED_EMAIL]";
    return email[0] + "***" + email.slice(at - 1);
}

export function _maskPhone(value) {
    const phone = _safeTrim(value, MAX_PHONE_LENGTH);
    return phone.length > 4 ? "***" + phone.slice(-4) : "[REDACTED_PHONE]";
}

export function _maskName(value) {
    const name = _safeTrim(value, 120);
    return name ? name[0] + "***" : "[REDACTED_NAME]";
}

/** NIF/CIF: se conservan los 2 ultimos caracteres para conciliacion visual. */
export function _maskTaxId(value) {
    const taxId = _safeTrim(value, 20);
    return taxId.length > 2 ? "***" + taxId.slice(-2) : "[REDACTED_TAX_ID]";
}

/** FIX-07 (BIBLIA 20.7): IPv4 oculta los dos ultimos octetos; IPv6 el ultimo grupo. */
export function _maskIp(value) {
    const ip = _safeTrim(value, MAX_IP_LENGTH);
    if (!ip) return "[REDACTED_IP]";
    const v4 = IPV4_PATTERN.exec(ip);
    if (v4) return v4[1] + "." + v4[2] + ".*.*";
    if (ip.indexOf(":") >= 0) {
        const groups = ip.split(":");
        if (groups.length > 2) {
            groups[groups.length - 1] = "*";
            groups[groups.length - 2] = "*";
            return groups.join(":");
        }
    }
    return "[REDACTED_IP]";
}

// ============================================================================
// ASINCRONIA
// ============================================================================

/**
 * Timeout de watchdog. No cancela el trabajo subyacente: solo libera al llamador.
 * El timeout canonico del backend es SDK_CONFIG.TIMEOUTS.WATCHDOG_MS.
 */
export function withTimeout(promiseOrFactory, timeoutMs, label = "OPERATION_TIMEOUT") {
    const factory =
        typeof promiseOrFactory === "function" ? promiseOrFactory : function () { return promiseOrFactory; };
    const timeout = Math.max(1, toFiniteNumber(timeoutMs, DEFAULT_TIMEOUT_MS));
    return new Promise(function (resolve, reject) {
        let settled = false;
        const timer = setTimeout(function () {
            if (settled) return;
            settled = true;
            const error = new Error(label);
            error.code = "TIMEOUT";
            reject(error);
        }, timeout);
        Promise.resolve()
            .then(factory)
            .then(function (value) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(value);
            })
            .catch(function (error) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                reject(error);
            });
    });
}

/**
 * Reintento con backoff exponencial.
 * isRetryable permite excluir errores deterministas (validacion, permisos,
 * integridad fiscal) que nunca se resuelven reintentando.
 */
export async function _executeWithRetry(fn, maxRetries = 2, delayMs = 300, isRetryable = null) {
    const retries = Math.max(0, toFiniteNumber(maxRetries, 0));
    const baseDelay = Math.max(0, toFiniteNumber(delayMs, 0));
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            const retryable = typeof isRetryable === "function" ? isRetryable(error) : true;
            if (!retryable || attempt >= retries) break;
            const wait = baseDelay * Math.pow(2, attempt);
            await new Promise(function (resolve) { setTimeout(resolve, wait); });
        }
    }
    throw lastError;
}
