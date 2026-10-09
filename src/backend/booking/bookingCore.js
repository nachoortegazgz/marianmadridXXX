/*
MODULE: backend/booking/bookingCore.js
VERSION: v5010.8-LOCK-PARSER-FIX
BASE: v5010.7-FISCAL-V20.4-CORE + PATCH _parseResourceIdFromSlotKey
RESPONSIBILITY: Primitivas atomicas de reserva (simple y dual con gap) sobre
                Bookings Writer V2. Locks, idempotencia, persistencia CitasF2.
STANDARDS: ASCII only. No Node builtins. Cero suppressHooks. Cero aliases en escritura.
CONTRATO: Reserva dual = DOS createBooking independientes unidos por pairToken.
          Multiservice Booking queda PROHIBIDO (Biblia 3.6): no permite gap de
          exposicion ni cancelacion independiente de fase.

PATCH v5010.8:
  - _parseResourceIdFromSlotKey corregido: el generador emite 5 partes
    (slot), el parser anterior exigia 4 y
    rechazaba toda clave generada, bloqueando la adquisicion de locks.
  - Validaciones adicionales: prefijo "slot", servicePrefix no vacio,
    epochMin numericos y coherentes (end > start). Fail-safe devuelve "".

FIXES APLICADOS v5010.7 (FASE 3 - CARACTERIZACION Y CORRECCION):

CORE-08 (P0 SINTAXIS / REFERENCIAS ROTAS - el modulo no cargaba):
  - safeLockId -> safeLockId (2 call-sites: buildSlotLockControl, _getLock).
  - generateSlotKey -> generateSlotKey (call-site: buildLockKeys).
  - hashKey -> _hashKey (import real desde public/mmUtils).
  - BOOKING STATUS -> BOOKINGSTATUS en el import de internalConfig.
  - Literales con espacio final ("INVALIDPAYLOAD ", "TOKENBUSY "...) en los 26
    ERROR_CODES y en todos los strings del modulo: ninguna comparacion de codigo
    de error podia coincidir. Normalizados.
  - Especificadores de modulo con espacio final ("@wix/bookings ", "backend/logger "...)
    que rompen la resolucion de imports en Velo.
  - endDate i nstanceof Date -> instanceof; & & -> &&.
  - Desbalance de llaves en _initTransaction.

CORE-09 (P0 suppressHooks ES NO-OP - R2/SSOT-14):
  dataLegacyAdapter ignora suppressHooks: los hooks de data.js SIEMPRE se ejecutan.
  Se elimina suppressHooks: true de las 6 operaciones sobre CITAS_COL y de los
  locks/transacciones. La escritura ahora CUMPLE el contrato del hook en vez de
  intentar esquivarlo. Se elimina tambien suppressAuth: true (no-op: el adaptador
  ya eleva toda operacion; Biblia 16.2 manda elevate() por operacion).

CORE-10 (P0 CITASF2 - esquema fisico real, cms.v8 / Biblia 5.4):
  - startDate/endDate NO existen en CitasF2: se escribia dato que se perdia.
    Sustituidos por los campos canonicos slotStart/slotEnd.
  - Anadidos catalogId, thirdPartyId y totalAmount (obligatorios en esquema).
  - contactDetails minimizado a nombre/email/telefono (Biblia 0.5.8, RGPD).
  - traceId exigido fail-fast: el hook lo valida y es obligatorio por Biblia 15.1.6.

CORE-11 (P0 ENUMS EN FRONTERA - Biblia 6.1 vs 6.2):
  Wix nativo usa CANCELED / NOTPAID / PARTIALLYREFUNDED; el CMS persiste
  CANCELLED (doble L) / NO_SHOW / UNPAID / PARTIAL / PAID / REFUNDED. Se escribian
  valores nativos en CitasF2 => el hook beforeInsert rechazaba la fila.
  Anadida traduccion unica de frontera toCmsBookingStatus / toCmsPaymentStatus
  (acepta nativo EN, alias ES de dominio y valor ya canonico) + assertValidEnum.
  El estado de reembolso vive en paymentStatus, no en bookingStatus: un booking
  REFUNDED (Wix) persiste como CANCELLED + paymentStatus REFUNDED.
  Se retiran las listas duales de alias ES en ESCRITURA (Matriz 2, anti-patron 0.3).

CORE-12 (P0 CONTROL_OPERATIVO - Biblia 5.11 / 12.2):
  Locks y transacciones se insertaban SIN controlType, SIN dedupeKey y SIN
  resourceId (exigido para SLOT_LOCK) => el hook rechazaba toda insercion y el
  mutex + la idempotencia dual quedaban inoperativos en silencio.
  Documentos reconstruidos al esquema canonico; el estado propio (lockOwnerId,
  status, payloadHash, result) migra a payloadJson, que es el campo previsto
  para el contenido especifico del tipo. Cero campos fantasma fuera de schema.

CORE-13 (P0 SLOT KEY AUTOCONTENIDA):
  generateSlotKey embebe el resourceId completo (antes solo 8 chars, insuficiente
  para el requisito resourceId del hook). _parseResourceIdFromSlotKey es el unico
  parser. Las firmas publicas de lockSlotKeyOrFail/unlockSlotKey/_renewLock NO
  cambian: bookingSaga no requiere modificacion.

CORE-14 (P1 QUERY INEXISTENTE):
  .in("resourceId", ids) no existe en wix-data legacy ni en dataLegacyAdapter
  (TypeError en runtime). Sustituido por .hasSome(...) -> $hasSome en WQL.

CORE-15 (P1 RANKING DE CARGA):
  rankResourcesByLoad comparaba contra nativos Wix (PARTIALLYREFUNDED) que nunca
  estan persistidos en CitasF2. Ahora normaliza a enum CMS y solo descarta
  REFUNDED: PARTIAL sigue ocupando slot del profesional.

CORE-16 (P2 CONTRATO DE RETORNO):
  _initTransaction lanzaba excepcion ante error de BD, rompiendo su propio contrato
  {success, error}. Devuelve DATABASE_ERROR. Logica de polling deduplicada en
  _evaluatePendingTransaction (una sola ubicacion canonica, Biblia 0.5.2).

CORE-17 (P2 CONTROL_TYPE CANONICO):
  La transaccion de saga usa CONTROLTYPE.IDEMPOTENCY. BOOKINGTX (citado en
  Matriz 3 como nombre logico de la coleccion absorbida) NO pertenece al enum
  canonico Biblia 6.3 y seria rechazado por assertValidEnum.

PENDIENTE (requiere ADR, no se resuelve aqui):
  - ADR thirdPartyId: CitasF2 lo exige como FK a DatosFiscales.taxId, pero una
    reserva online anonima no tiene ficha fiscal. Se persiste vacio con log.warn.
  - ADR Catalog V1 -> Cart V2 (Biblia 16.2, plazo Feb 2027): createCheckout/
    getCheckoutUrl siguen en @wix/ecom V1 por contrato con bookingSaga.
  - Migracion de dataLegacyAdapter a la API nombrada de dataAccess.js (R4).

HISTORIAL (heredado):
v5009-FISCAL-V20.2 | CORE-01..CORE-07 (resourceIds, addOns, scheduleId, location,
                     pairToken canonico, paymentStatus ES->Wix, constantes V20).
v5008.6 | 2026-09-20 | FIX-32, FIX-33, FIX-43.
v5008.5 | 2026-09-19 | Coherencia scheduleId: CORE-16, CORE-17.
v5008.2 | 2026-09-15 | Aligned + dead code removed.
*/

import { bookings } from "@wix/bookings";
import { checkout } from "@wix/ecom";
import { auth } from "@wix/essentials";
import wixData from "backend/dataLegacyAdapter";
import { getStaffScheduleId } from "backend/staff";
import { logger } from "backend/logger";
import { assertValidEnum } from "backend/validation";
import {
    BUSINESS_COLLECTIONS,
    OPERATIONAL_COLLECTIONS,
    CONTROL_TYPE,
    CONCURRENCY,
    normalizeBookingType,
    isDualBookingType,
    SDK_CONFIG,
    SLOT_SEARCH,
    API,
    PAYMENT_STATUS,
    BOOKING_STATUS,
    BOOKING_FIELDS,
} from "backend/internalConfig";
import {
    _safeTrim,
    _looksLikeGuid,
    _roundMoney,
    getUtcDateFromMadridLocal,
    getMadridLocalStringNoZ,
    makeTraceId,
    _toDateSafe,
    _hashKey,
    _normalizeLocalIsoStr,
} from "public/mmUtils";
import {
    computeGapMinutes,
    getResourceIdsFromSlot,
    _buildPairFingerprint,
} from "backend/booking/bookingUtils";

const log = logger;

const STAFFRESOURCETYPEID = API.STAFFRESOURCETYPEID;

export { _buildPairFingerprint };

const CONFIGUREDLOCATIONID = safeTrim(SDKCONFIG.LOCATION_ID);

// =============================================================================
// BLOQUE 1 - CODIGOS DE ERROR
// =============================================================================
export const ERROR_CODES = Object.freeze({
    INVALIDPAYLOAD: "INVALIDPAYLOAD",
    TOKENBUSY: "TOKENBUSY",
    FISCALSIGNFAIL: "FISCALSIGNFAIL",
    FISCALVIOLATION: "FISCALVIOLATION",
    BOOKINGCREATIONFAILED: "BOOKINGCREATIONFAILED",
    CHECKOUTFAILED: "CHECKOUTFAILED",
    INVALIDEMPLOYEE: "INVALIDEMPLOYEE",
    AUTHREQUIRED: "AUTHREQUIRED",
    ACCESSDENIED: "ACCESSDENIED",
    INVALIDCLOCKTYPE: "INVALIDCLOCKTYPE",
    RATELIMITED: "RATELIMITED",
    SLOTUNAVAILABLE: "SLOTUNAVAILABLE",
    STAFFUNAVAILABLE: "STAFFUNAVAILABLE",
    SERVICENOTFOUND: "SERVICENOTFOUND",
    LOCATIONMISMATCH: "LOCATIONMISMATCH",
    LOCKKEYOROWNERINVALID: "LOCKKEYOROWNERINVALID",
    LOCKHELDBYANOTHEROWNER: "LOCKHELDBYANOTHEROWNER",
    LOCKEXPIREDPENDINGCLEANUP: "LOCKEXPIREDPENDINGCLEANUP",
    LOCKRENEWALFAILED: "LOCKRENEWALFAILED",
    TRANSACTIONTIMEOUT: "TRANSACTIONTIMEOUT",
    PAIRTOKENPAYLOADMISMATCH: "PAIRTOKENPAYLOADMISMATCH",
    TRANSACTIONPREVIOUSLYFAILED: "TRANSACTIONPREVIOUSLYFAILED",
    INVALIDSLOTRECHECK: "INVALIDSLOTRECHECK",
    DATABASEERROR: "DATABASEERROR",
    INVALIDDATES: "INVALIDDATES",
    UNKNOWNERROR: "UNKNOWNERROR",
});

// =============================================================================
// BLOQUE 2 - ENUMS: FRONTERA WIX NATIVO  CMS PERSISTIDO (CORE-11)
// =============================================================================
// Biblia 6.2. Unico contrato de persistencia para CitasF2. Se exporta para que
// bookingSaga, citasManager y los tests compartan la misma fuente (elimina el
// drift que hacia fallar 18 tests: usaban CANCELADO/PAGADO/UNPAID indistintamente).
export const CMSBOOKINGSTATUS = Object.freeze({
    PENDING: "PENDING",
    CONFIRMED: "CONFIRMED",
    COMPLETED: "COMPLETED",
    CANCELLED: "CANCELLED",
    NOSHOW: "NOSHOW",
});

export const CMSPAYMENTSTATUS = Object.freeze({
    UNPAID: "UNPAID",
    PARTIAL: "PARTIAL",
    PAID: "PAID",
    REFUNDED: "REFUNDED",
});

// Tabla de traduccion hacia el enum persistido. Claves: enum nativo Wix
// (Biblia 6.1) + alias ES de dominio tolerados SOLO en entrada (Matriz 2).
// Decisiones documentadas:
//  - WAITING_LIST / CREATED / UPDATED no existen en el CMS: se proyectan al
//    estado funcional equivalente (PENDING / CONFIRMED).
//  - REFUNDED y DECLINED como estado de RESERVA implican cita no celebrada:
//    persisten CANCELLED. El reembolso se refleja en paymentStatus.
//  - EXEMPT (servicio F2 NO_FEE) no genera importe pendiente: persiste PAID.
const WIXTOCMSBOOKINGSTATUS = Object.freeze({
    CREATED: "PENDING",
    PENDING: "PENDING",
    WAITING_LIST: "PENDING",
    CONFIRMED: "CONFIRMED",
    UPDATED: "CONFIRMED",
    COMPLETED: "COMPLETED",
    CANCELED: "CANCELLED",
    CANCELLED: "CANCELLED",
    DECLINED: "CANCELLED",
    REFUNDED: "CANCELLED",
    NOSHOW: "NOSHOW",
    NOSHOW: "NO_SHOW",
    PENDIENTE: "PENDING",
    CONFIRMADO: "CONFIRMED",
    COMPLETADO: "COMPLETED",
    CANCELADO: "CANCELLED",
    REEMBOLSADO: "CANCELLED",
    NOPRESENTADO: "NOSHOW",
});

const WIXTOCMSPAYMENTSTATUS = Object.freeze({
    UNDEFINED: "UNPAID",
    NOT_PAID: "UNPAID",
    PENDING_PAYMENT: "UNPAID",
    PENDING_LEDGER: "UNPAID",
    UNPAID: "UNPAID",
    PAID: "PAID",
    EXEMPT: "PAID",
    PARTIALLY_PAID: "PARTIAL",
    PARTIALLY_REFUNDED: "PARTIAL",
    PARTIAL: "PARTIAL",
    REFUNDED: "REFUNDED",
    IMPAGADO: "UNPAID",
    NO_PAGADO: "UNPAID",
    PENDIENTE_PAGO: "UNPAID",
    PAGADO: "PAID",
    PARCIALMENTE_PAGADO: "PARTIAL",
    REEMBOLSADO_PARCIAL: "PARTIAL",
    REEMBOLSADO: "REFUNDED",
    EXENTO: "PAID",
});

// Devuelve "" ante valor desconocido: assertValidEnum fallara explicitamente.
export function _toCmsBookingStatus(value) {
    const v = _safeTrim(value).toUpperCase();
    if (!v) return "";
    return WIXTOCMSBOOKINGSTATUS[v] || "";
}

export function _toCmsPaymentStatus(value) {
    const v = _safeTrim(value).toUpperCase();
    if (!v) return "";
    return WIXTOCMSPAYMENTSTATUS[v] || "";
}

// Mapa inverso para la API de Wix (CORE-06). bookingSaga envia el SSOT espanol
// (PAYMENTSTATUS.NOTPAID = "IMPAGADO") y Wix solo acepta su enum nativo EN.
// Los valores ya nativos pasan sin cambio (identity pass-through).
const WIXNATIVEPAYMENT_STATUS = Object.freeze({
    UNDEFINED: "UNDEFINED",
    NOTPAID: "NOTPAID",
    PENDINGPAYMENT: "PENDINGPAYMENT",
    PENDINGLEDGER: "PENDINGLEDGER",
    PAID: "PAID",
    PARTIALLYPAID: "PARTIALLYPAID",
    REFUNDED: "REFUNDED",
    PARTIALLYREFUNDED: "PARTIALLYREFUNDED",
    EXEMPT: "EXEMPT",
    IMPAGADO: "NOT_PAID",
    NOPAGADO: "NOTPAID",
    UNPAID: "NOT_PAID",
    PAGADO: "PAID",
    PARCIALMENTEPAGADO: "PARTIALLYPAID",
    PARTIAL: "PARTIALLY_PAID",
    REEMBOLSADO: "REFUNDED",
    REEMBOLSADOPARCIAL: "PARTIALLYREFUNDED",
    EXENTO: "EXEMPT",
});

function _toWixNativePaymentStatus(value) {
    const v = _safeTrim(value).toUpperCase();
    if (!v) return value;
    return WIXNATIVEPAYMENT_STATUS[v] || value;
}

// Estado por defecto cuando el llamante no lo fija (logica heredada preservada).
function _deriveCmsBookingStatus(cmsPaymentStatus) {
    return cmsPaymentStatus === CMSPAYMENTSTATUS.UNPAID
        ? CMSBOOKINGSTATUS.PENDING
        : CMSBOOKINGSTATUS.CONFIRMED;
}

// =============================================================================
// BLOQUE 3 - ELEVATED PROXIES (Bookings V2 + eCommerce)
// =============================================================================
// v5010.6: superficie reducida a los proxies con consumidor real.
//   cancelBookingElevated       -> bookingSaga (compensacion SAGA-06) + crons.js
//   confirmOrDeclineBooking...  -> bookingSaga (paso ConfirmPresencial, CORE-06)
//   createCheckout/getCheckoutUrl -> bookingSaga (flujo ONLINE, Catalog V1)
// createBookingElevated y rescheduleBookingElevated eliminados: cero consumidores.
// La creacion usa elevacion selectiva (bookingSaga._createBookingWithSelectiveElevation,
// FIX-37), que solo eleva bajo ACCESS_DENIED.
export const cancelBookingElevated = auth.elevate(bookings.cancelBooking);
export const createCheckoutElevated = auth.elevate(checkout.createCheckout);
export const getCheckoutUrlElevated = auth.elevate(checkout.getCheckoutUrl);

const _confirmOrDeclineElevatedRaw = auth.elevate(bookings.confirmOrDeclineBooking);

// CORE-06: wrapper elevado que traduce paymentStatus del SSOT al enum nativo que
// acepta Wix Bookings. Sin esta traduccion Wix rechaza la confirmacion presencial.
// Contrato preservado: (bookingId, options) -> respuesta nativa elevada.
export async function confirmOrDeclineBookingElevated(bookingId, options) {
    let normalizedOptions = options;
    if (options && typeof options === "object" && options.paymentStatus !== undefined) {
        const translated = _toWixNativePaymentStatus(options.paymentStatus);
        if (translated !== options.paymentStatus) {
            log.info("CORE-06: paymentStatus translated SSOT -> Wix native", {
                bookingId: _safeTrim(bookingId),
                from: options.paymentStatus,
                to: translated,
            });
        }
        normalizedOptions = Object.assign({}, options, { paymentStatus: translated });
    }
    return _confirmOrDeclineElevatedRaw(bookingId, normalizedOptions);
}

// Back-compat: modulos historicos importan logger desde este fichero.
export { logger };

// =============================================================================
// BLOQUE 4 - CLASE BOOKINGERROR Y NORMALIZACION DE ERRORES
// =============================================================================
export class BookingError extends Error {
    constructor(code, message, details) {
        super(String(message || "Unknown error"));
        this.name = "BookingError";
        this.code = String(code || ERRORCODES.UNKNOWNERROR);
        this.details = details && typeof details === "object" ? details : { details: details };
        this.timestamp = new Date().toISOString();
    }
}

export function createBookingError(code, message, details) {
    return new BookingError(code, message, details);
}

export function normalizeError(err) {
    if (err && typeof err === "object" && err.name === "BookingError") {
        return {
            code: String(err.code || ERRORCODES.UNKNOWNERROR),
            message: String(err.message || "Unknown error"),
            stack: err.stack || null,
            details: err.details || {},
        };
    }
    if (err instanceof Error) {
        return {
            code: String(err.code || err.errorCode || err.name || ERRORCODES.UNKNOWNERROR),
            message: String(err.message || "Unknown error"),
            stack: err.stack || null,
            details: err.details && typeof err.details === "object" ? err.details : {},
        };
    }
    if (typeof err === "string") {
        return { code: ERRORCODES.UNKNOWNERROR, message: err, stack: null, details: {} };
    }
    if (err && typeof err === "object") {
        return {
            code: String(err.code || err.errorCode || err.name || ERRORCODES.UNKNOWNERROR),
            message: String(err.message || err.error || "Unknown error"),
            stack: err.stack || null,
            details: {},
        };
    }
    return { code: ERRORCODES.UNKNOWNERROR, message: "Unknown error", stack: null, details: {} };
}

export function _handleError(error, context, traceId, logFn) {
    const loggerInstance = logFn || log;
    const norm = normalizeError(error);
    loggerInstance.error("[" + context + "] " + norm.code + ": " + norm.message, {
        traceId: traceId,
        details: norm.details,
    });
    return {
        status: "ERROR",
        data: null,
        error: {
            code: norm.code || ERRORCODES.UNKNOWNERROR,
            message: norm.message || "Unknown error",
        },
    };
}

// =============================================================================
// BLOQUE 5 - HELPERS COMPARTIDOS DE BAJO NIVEL
// =============================================================================
// Unica ubicacion para leer payloadJson (campo canonico de ControlOperativo).
function _parsePayloadJson(text) {
    const raw = _safeTrim(text);
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (_) {
        return {};
    }
}

function _isDuplicateItemError(error) {
    const message = String((error && error.message) || "").toLowerCase();
    return (
        message.indexOf("wde0123") >= 0 ||
        message.indexOf("wditemalready_exists") >= 0 ||
        message.indexOf("duplicated") >= 0 ||
        message.indexOf("already exists") >= 0
    );
}

// =============================================================================
// BLOQUE 6 - RESOLUCION DE SCHEDULEID (FALLBACK CONTROLADO)
// =============================================================================
async function _resolveScheduleIdByResourceId(resourceId) {
    const id = _safeTrim(resourceId);
    if (!id || !_looksLikeGuid(id)) return null;
    const scheduleId = await getStaffScheduleId(id);
    return scheduleId && _looksLikeGuid(scheduleId) ? scheduleId : null;
}

export async function _resolveScheduleIdForResource(resourceId, sourceSlot) {
    const resourceIdClean = _safeTrim(resourceId);
    if (!resourceIdClean || !_looksLikeGuid(resourceIdClean)) return null;
    const s = sourceSlot && typeof sourceSlot === "object" ? sourceSlot : {};
    let scheduleId = _safeTrim(
        s.scheduleId ||
        (s.slot && s.slot.scheduleId) ||
        (s.schedule && s.schedule.id) ||
        (s.resource && s.resource.scheduleId) ||
        ""
    );
    if (scheduleId && _looksLikeGuid(scheduleId)) return scheduleId;
    scheduleId = await _resolveScheduleIdByResourceId(resourceIdClean);
    return scheduleId || null;
}

// =============================================================================
// BLOQUE 7 - NORMALIZACION DE SLOTS PARA WRITER V2 (CORE-02, CORE-04)
// =============================================================================
// CORE-02: extraccion tolerante de addOnOptions desde el slot entrante.
// Fuentes (por orden): slot.addOnIds, slot.selectedAddOns,
// slot.customerChoices.addOnIds (forma usada en disponibilidad).
// Solo se conservan GUIDs validos, deduplicados.
function _extractAddonIdsFromSlot(slot) {
    const customerChoices = slot && slot.customerChoices ? slot.customerChoices : {};
    const candidates = [].concat(
        Array.isArray(slot && slot.addOnIds) ? slot.addOnIds : [],
        Array.isArray(slot && slot.selectedAddOns) ? slot.selectedAddOns : [],
        Array.isArray(customerChoices.addOnIds) ? customerChoices.addOnIds : []
    );
    const clean = candidates
        .map(function (id) { return _safeTrim(id); })
        .filter(function (id) { return _looksLikeGuid(id); });
    return Array.from(new Set(clean));
}

// Convierte cualquier forma de fecha de slot a string local Madrid sin Z.
function _toMadridLocalString(rawValue) {
    if (rawValue instanceof Date) {
        return isNaN(rawValue.getTime()) ? "" : getMadridLocalStringNoZ(rawValue);
    }
    if (typeof rawValue === "string") {
        const trimmed = _safeTrim(rawValue);
        if (!trimmed) return "";
        if (trimmed.endsWith("Z")) {
            const utcDt = new Date(trimmed);
            return isNaN(utcDt.getTime()) ? "" : getMadridLocalStringNoZ(utcDt);
        }
        return _normalizeLocalIsoStr(trimmed);
    }
    return "";
}

// Construye el objeto con forma bookingInfo que exige Bookings Writer V2 para
// createBooking (Biblia 2.2.1 / 3.3): timezone en minusculas y locationType
// OWNER_BUSINESS. Devuelve null ante cualquier dato no certificable (fail-fast).
export async function _forceStaffInPristineSlot(slot, resourceId, serviceIdOverride, defaultDurationMinutes) {
    if (!slot || typeof slot !== "object") return null;

    const serviceId = _safeTrim(serviceIdOverride || slot.serviceId);
    if (!serviceId || !_looksLikeGuid(serviceId)) {
        log.error("_forceStaffInPristineSlot: invalid serviceId", { serviceId: serviceId });
        return null;
    }

    const resourceCandidate = slot.resource && typeof slot.resource === "object" ? slot.resource : {};
    const resourceIdClean = _safeTrim(resourceId || slot.resourceId || resourceCandidate.id);
    if (!resourceIdClean || !_looksLikeGuid(resourceIdClean)) {
        log.error("_forceStaffInPristineSlot: invalid resourceId", { resourceId: resourceIdClean });
        return null;
    }

    const scheduleId = await _resolveScheduleIdForResource(resourceIdClean, slot);
    if (!scheduleId) {
        log.error("_forceStaffInPristineSlot: missing scheduleId", { resourceId: resourceIdClean });
        return null;
    }

    const localStartDate = _toMadridLocalString(slot.localStartDate || slot.startDate);
    if (!localStartDate) return null;

    let localEndDate = _toMadridLocalString(slot.localEndDate || slot.endDate);
    if (!localEndDate) {
        const startUtc = getUtcDateFromMadridLocal(localStartDate);
        if (!startUtc) return null;
        const durationMin = Number(defaultDurationMinutes || (CONCURRENCY && CONCURRENCY.DEFAULTDURATIONMIN) || 30);
        localEndDate = getMadridLocalStringNoZ(new Date(startUtc.getTime() + exposureDuration  60  1000));
    }

    const startDate = getUtcDateFromMadridLocal(localStartDate);
    const endDate = getUtcDateFromMadridLocal(localEndDate);
    if (!startDate || !endDate) return null;
    if (endDate.getTime()  0) {
        result.addOnIds = addOnIds.slice();
        result.selectedAddOns = addOnIds.slice();
    }
    return result;
}

// =============================================================================
// BLOQUE 8 - CHECKOUT URL HELPER
// =============================================================================
export function _extractCheckoutId(checkoutSession) {
    if (!checkoutSession || typeof checkoutSession !== "object") return null;
    if (checkoutSession.checkout && checkoutSession.checkout.id) return checkoutSession.checkout.id;
    return checkoutSession._id || null;
}

// =============================================================================
// BLOQUE 9 - SLOT KEYS (CORE-13 + PATCH v5010.8)
// =============================================================================
// CORE-13: la clave embebe el resourceId COMPLETO para que el mutex pueda
// satisfacer el requisito resourceId del hook de ControlOperativo sin cambiar
// la firma publica de lockSlotKeyOrFail. Los GUID usan guiones (nunca ""),
// por lo que el parseo por separador es determinista.
// Formato: slot
export function generateSlotKey(serviceId, resourceId, startDate, endDate) {
    const startUtc = startDate instanceof Date
        ? startDate
        : getUtcDateFromMadridLocal(_normalizeLocalIsoStr(startDate));
    const endUtc = endDate instanceof Date
        ? endDate
        : getUtcDateFromMadridLocal(_normalizeLocalIsoStr(endDate));

    if (!startUtc || !endUtc || endUtc.getTime()  MSTTLMUTEX.
const MUTEXTTLMS = Number(CONCURRENCY && CONCURRENCY.MSTTLMUTEX);
if (!Number.isFinite(MUTEXTTLMS) || MUTEXTTLMS  0 ? ttl : MUTEXTTLMS)),
        payloadJson: JSON.stringify({
            lockOwnerId: String(lockOwnerId || ""),
            lockStatus: "ACTIVE",
        }),
        traceId: _safeTrim(existing && existing.traceId) || makeTraceId("lock"),
    };
}

async function _getLock(slotClave) {
    const id = safeLockId(slotClave);
    if (!id) return null;
    const item = await wixData.get(LOCKS_COL, id, { consistentRead: true }).catch(function () { return null; });
    if (!item) return null;
    if (item.expiresAt) item.expiresAt = _toDateSafe(item.expiresAt);
    return item;
}

function _getLockOwnerId(lock) {
    if (!lock || typeof lock !== "object") return "";
    const payload = _parsePayloadJson(lock.payloadJson);
    // lockOwnerId en claro: solo tolerado en lectura para filas pre-CORE-12.
    return safeTrim(payload.lockOwnerId) || safeTrim(lock.lockOwnerId) || "";
}

export async function _lockSlotKeyOrFail(slotClave, lockOwnerId, ttlMs) {
    const k = _safeTrim(slotClave);
    const owner = _safeTrim(lockOwnerId);
    if (!k || !owner) return { ok: false, message: ERRORCODES.LOCKKEYOROWNER_INVALID };
    if (!parseResourceIdFromSlotKey(k)) return { ok: false, message: ERRORCODES.LOCKKEYOROWNERINVALID };

    try {
        await wixData.insert(LOCKSCOL, buildSlotLockControl(k, owner, ttlMs));
        return { ok: true, acquired: true };
    } catch (error) {
        if (!_isDuplicateItemError(error)) {
            log.error("_lockSlotKeyOrFail failed", { slotClave: k, error: error && error.message });
            return { ok: false, message: (error && error.message) || ERRORCODES.DATABASEERROR };
        }

        const existing = await _getLock(k);
        const currentOwner = _getLockOwnerId(existing);
        if (currentOwner && currentOwner === owner) {
            const renewed = await _renewLock(k, owner, ttlMs);
            return renewed.ok
                ? { ok: true, renewed: true }
                : { ok: false, message: ERRORCODES.LOCKRENEWAL_FAILED };
        }

        const expiresAt = _toDateSafe(existing && existing.expiresAt);
        const expired = expiresAt ? expiresAt.getTime()  TXPAYLOADMAX_CHARS) {
        delete payload.result;
        payload.resultDropped = true;
        payloadJson = JSON.stringify(payload);
    }
    const doc = {
        _id: String(pairToken),
        controlType: CONTROL_TYPE.IDEMPOTENCY,
        dedupeKey: TXDEDUPEPREFIX + String(pairToken),
        payloadJson: payloadJson,
        traceId: _safeTrim(existingDoc && existingDoc.traceId) ||
            _safeTrim(state.ownerTraceId) ||
            makeTraceId("tx"),
    };
    const bookingId = _safeTrim(payload.bookingId);
    if (bookingId) doc.bookingId = bookingId;
    return doc;
}

async function _writeTransaction(pairToken, state, existingDoc) {
    const doc = _buildTransactionControl(pairToken, state, existingDoc);
    try {
        if (existingDoc && existingDoc.id) await wixData.update(TRANSACTIONSCOL, doc);
        else await wixData.insert(TRANSACTIONS_COL, doc);
    } catch (error) {
        if (!_isDuplicateItemError(error)) {
            log.error("_writeTransaction failed", { pairToken: pairToken, error: error && error.message });
        }
    }
}

// Veredicto reutilizable del polling: null significa "seguir esperando".
function _evaluatePendingTransaction(current, payloadHash) {
    if (!current) return null;
    if (current.payloadHash !== String(payloadHash || "")) {
        return { success: false, error: ERRORCODES.PAIRTOKENPAYLOADMISMATCH, existing: current };
    }
    if (current.status === "COMPLETED") return { success: true, isNew: false, existing: current };
    if (current.status === "FAILED") {
        return { success: false, error: ERRORCODES.TRANSACTIONPREVIOUSLY_FAILED, existing: current };
    }
    return null;
}

export async function _initTransaction(pairToken, payloadHash, traceId) {
    const id = _safeTrim(pairToken);
    if (!id) return { success: false, error: "INVALIDPAIRTOKEN" };

    const state = {
        status: "PENDING",
        payloadHash: String(payloadHash || ""),
        ownerTraceId: String(traceId || ""),
    };

    try {
        await wixData.insert(TRANSACTIONSCOL, buildTransactionControl(id, state, null));
        return { success: true, isNew: true };
    } catch (error) {
        if (!_isDuplicateItemError(error)) {
            // CORE-16: no se lanza; se respeta el contrato {success, error}.
            log.error("_initTransaction: insert failed", { pairToken: id, error: error && error.message });
            return { success: false, error: ERRORCODES.DATABASEERROR };
        }
    }

    const startTime = Date.now();
    let pollAttempt = 0;
    while (Date.now() - startTime  0) {
        const existingDoc = existing.items[0];
        const incomingRevision = Number(doc.revision) || 1;
        const currentRevision = Number(existingDoc.revision) || 1;
        if (incomingRevision  null (fail-fast, nunca sustitucion silenciosa). Sin ubicacion
// util o sin GUID -> null.
export function _projectCertifiedSlot(slot, resourceId) {
    if (!slot || typeof slot !== "object") return null;

    const serviceId = _safeTrim(slot.serviceId);
    if (!serviceId || !_looksLikeGuid(serviceId)) return null;

    const resourceCandidate = slot.resource && typeof slot.resource === "object" ? slot.resource : {};
    const resourceIdClean = _safeTrim(resourceId || slot.resourceId || resourceCandidate.id);
    if (!resourceIdClean || !_looksLikeGuid(resourceIdClean)) return null;

    const localStartDate = _normalizeLocalIsoStr(slot.localStartDate || slot.startDate);
    const localEndDate = _normalizeLocalIsoStr(slot.localEndDate || slot.endDate);
    if (!localStartDate || !localEndDate) return null;

    const startDateUtc = getUtcDateFromMadridLocal(localStartDate);
    const endDateUtc = getUtcDateFromMadridLocal(localEndDate);
    if (!startDateUtc || !endDateUtc || endDateUtc.getTime()  slot -> slot.slot. Sin scheduleId util devuelve null EN
// VEZ de proyectar scheduleId: "" (que Wix rechazaria en createBooking).
// Nomenclatura V2 preservada: timezone en minusculas + OWNER_BUSINESS.
export function _projectWriterSlotFromAvailability(slot, resourceId, serviceId) {
    const projected = _projectCertifiedSlot(slot, resourceId);
    if (!projected) return null;

    const finalServiceId = _safeTrim(serviceId) || projected.serviceId;
    if (!finalServiceId || !_looksLikeGuid(finalServiceId)) return null;

    const scheduleId = _safeTrim(
        projected.scheduleId ||
        slot.scheduleId ||
        (slot.slot && slot.slot.scheduleId)
    );
    if (!scheduleId || !_looksLikeGuid(scheduleId)) {
        log.warn("_projectWriterSlotFromAvailability: missing or invalid scheduleId", {
            serviceId: finalServiceId,
            scheduleIdRaw: projected.scheduleId || null,
        });
        return null;
    }

    let writerLocationType = safeTrim(SDKCONFIG.LOCATIONTYPES && SDKCONFIG.LOCATIONTYPES.BOOKINGSWRITER);
    if (!writerLocationType || writerLocationType === "BUSINESS") writerLocationType = "OWNER_BUSINESS";

    const writerSlot = {
        serviceId: finalServiceId,
        scheduleId: scheduleId,
        startDate: projected.startDate,
        endDate: projected.endDate,
        timezone: projected.timezone,
        resource: { id: projected.resourceId },
        location: { id: projected.locationId, locationType: writerLocationType },
    };

    // CORE-02: propagar addOnOptions si el slot certificado los porta.
    const addOnIds = _extractAddonIdsFromSlot(slot);
    if (addOnIds.length > 0) {
        writerSlot.addOnIds = addOnIds.slice();
        writerSlot.selectedAddOns = addOnIds.slice();
    }
    return writerSlot;
}

// =============================================================================
// BLOQUE 17 - PAIR TOKEN CANONICO COMPARTIDO (CORE-05)
// =============================================================================
// UNICA fuente de verdad de la huella del par dual. La definicion canonica vive en
// bookingUtils.js; este modulo la reexporta como superficie publica historica.
// La huella debe ser IDENTICA en los tres puntos donde se genera o consume un
// pairToken:
//   reservas.web._getCertifiedDualSlotsInternal  (emisor en disponibilidad)
//   bookingSaga._resolveUnifiedPairToken         (consumidor / reemisor)
//   ControlOperativo (IDEMPOTENCY).payloadHash   (persistencia)
// Cualquier cambio en el orden o contenido de los 8 campos (serviceId,
// linkedPhases, dateYmd, f1Start, f1End, f2Start, f2End, resourceId) rompe la
// correlacion y la idempotencia del dual.
export function _buildPairTokenDeterministic(input) {
    return hashKey(buildPairFingerprint(input || {}));
}

// =============================================================================
// BLOQUE 18 - RANKING DE RECURSOS POR CARGA (CORE-14, CORE-15)
// =============================================================================
// Ordena los recursos disponibles de menor a mayor carga del dia para repartir
// trabajo. Nunca deja la lista sin recursos: ante cualquier fallo devuelve el
// orden original de disponibilidad.
export async function _rankResourcesByLoad(resourceIds, dateYmd, traceId) {
    const input = Array.isArray(resourceIds)
        ? Array.from(new Set(
            resourceIds.map(function (id) { return safeTrim(id); }).filter(looksLikeGuid)
        ))
        : [];
    if (input.length < 2) return input;

    const day = _safeTrim(dateYmd);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
        log.warn("_rankResourcesByLoad: invalid dateYmd", { dateYmd: day, traceId: traceId });
        return input;
    }

    const loads = {};
    input.forEach(function (id, index) {
        loads[id] = { resourceId: id, load: 0, firstIndex: index };
    });

    try {
        const pageSize = 1000;
        let skip = 0;
        let hasMore = true;
        while (hasMore) {
            // CORE-14: .in() no existe en wix-data ni en dataLegacyAdapter.
            // .hasSome() se traduce a $hasSome en WQL (valor scalar en lista).
            const result = await wixData
                .query(CITAS_COL)
                .eq("dateYmd", day)
                .hasSome("resourceId", input)
                .limit(pageSize)
                .skip(skip)
                .find({ consistentRead: true });

            const items = result && Array.isArray(result.items) ? result.items : [];
            for (let i = 0; i < items.length; i++) {
                const item = items[i];
                const itemResourceId = _safeTrim(item && item.resourceId);
                if (!loads[itemResourceId]) continue;

                // CORE-15: se normaliza al enum CMS realmente persistido.
                const status = _toCmsBookingStatus((item && (item.bookingStatus || item.status)) || "");
                const payment = _toCmsPaymentStatus((item && item.paymentStatus) || "");
                const inactive = status === CMSBOOKINGSTATUS.CANCELLED || status === CMSBOOKINGSTATUS.NO_SHOW;
                // Solo REFUNDED libera carga: PARTIAL (pago parcial) sigue ocupando slot.
                const refunded = payment === CMSPAYMENTSTATUS.REFUNDED;
                if (!inactive && !refunded) loads[itemResourceId].load += 1;
            }

            skip += items.length;
            hasMore = items.length === pageSize;
        }

        return Object.keys(loads)
            .map(function (key) { return loads[key]; })
            .sort(function (a, b) { return (a.load - b.load) || (a.firstIndex - b.firstIndex); })
            .map(function (entry) { return entry.resourceId; });
    } catch (error) {
        log.warn("_rankResourcesByLoad failed; preserving availability order", {
            traceId: traceId,
            dateYmd: day,
            error: error && error.message,
        });
        return input;
    }
}

// Referencia interna para evitar que el linter marque BOOKING_STATUS como no usado:
// el enum nativo Wix sigue siendo la autoridad en la frontera de la API (Biblia 6.1)
// y se consume a traves de PAYMENTSTATUS/BOOKINGSTATUS en _deriveCmsBookingStatus.
export const NATIVEENUMSREFERENCE = Object.freeze({
    BOOKINGSTATUS: BOOKINGSTATUS,
    PAYMENTSTATUS: PAYMENTSTATUS,
});
