/*
MODULE: backend/booking/bookingCore.js
VERSION: v5011.0-STAFF-MIGRATION
BASE: v5009-FISCAL-V20.2-CORE + v5010.7..v5010.9 (CORE-08..CORE-17)
      + migracion MapaStaff/availableStaff eliminados
RESPONSIBILITY: Primitivas atomicas de reserva (simple y dual con gap) sobre
                Bookings Writer V2. Locks, idempotencia, persistencia CitasF2.
STANDARDS: G10 ASCII strict. Sin Node builtins. Cero suppressHooks/suppressAuth.
CONTRATO DUAL: dos createBooking independientes unidos por pairToken.
               Multiservice Booking PROHIBIDO (Biblia 3.6): no permite gap de
               exposicion ni cancelacion independiente de fase.

DEPENDENCIAS CRITICAS (deben estar desplegadas junto a este modulo):
  - backend/staff.js debe exportar getStaffScheduleId y getStaffThirdPartyId.
  - backend/internalConfig.js debe exponer CONCURRENCY.MS_TTL_MUTEX,
    CONTROL_TYPE (6 subtipos canonicos, Biblia 6.3) y BOOKING_FIELDS.STATUS.
  - backend/validation.js debe exportar assertValidEnum.
  - public/mmUtils.js debe exportar _roundMoney y _hashKey.

FIXES v5011.0 (MIGRACION STAFF):
CORE-18: thirdPartyId de CitasF2 se resuelve desde DatosFiscales via
         staff.getStaffThirdPartyId(resourceId). Antes quedaba vacio con un
         ADR pendiente; al eliminarse MapaStaff, DatosFiscales (recordType
         STAFF_CONFIG) pasa a ser la unica fuente del NIF del profesional.
CORE-19: totalAmount obligatorio y finito. Se rechaza el 0 silencioso que
         romperia el cuadre taxBase+cuota del ledger y el cierre Z.
CORE-20: dateYmd respeta el valor aportado por la saga si es valido.
CORE-21: _buildSlotLockControl lanza si la slot key no porta resourceId GUID.
         Se elimina _buildLockDocument (wrapper redundante, Biblia 0.5.2).

FIXES HEREDADOS v5010.7..v5010.9:
CORE-08: sintaxis y referencias rotas (_safeLockId, _generateSlotKey, hashKey,
         BOOKING _STATUS, literales con espacio final, imports con espacio).
CORE-09: suppressHooks/suppressAuth eliminados (son no-op en el adaptador;
         los hooks de data.js siempre corren, R2/SSOT-14).
CORE-10: CitasF2 escribe el esquema fisico real: slotStart/slotEnd (antes
         startDate/endDate, campos inexistentes), catalogId, thirdPartyId,
         totalAmount; contactDetails minimizado (Biblia 0.5.8, RGPD).
CORE-11: frontera de enums. Wix nativo (Biblia 6.1) -> CMS persistido
         (Biblia 6.2): CANCELLED con doble L, NO_SHOW, UNPAID/PARTIAL/PAID/
         REFUNDED. Sin listas de alias ES en escritura (Matriz 2).
CORE-12: ControlOperativo canonico (controlType, dedupeKey, traceId, y
         resourceId+expiresAt para SLOT_LOCK). Estado propio a payloadJson.
CORE-13: generateSlotKey embebe el resourceId completo; parser de 5 piezas.
CORE-14: .in() no existe en wix-data ni en dataLegacyAdapter -> .hasSome().
CORE-15: ranking de carga compara contra enums CMS realmente persistidos.
CORE-16: _initTransaction respeta su contrato {success,error} y no lanza.
CORE-17: CONTROL_TYPE.IDEMPOTENCY para la transaccion de saga.

PENDIENTE (requiere ADR):
  - Catalog V1 -> Cart V2 (Biblia 16.2, plazo Feb 2027). createCheckout y
    getCheckoutUrl siguen en @wix/ecom V1 por contrato con bookingSaga.
  - Migracion de dataLegacyAdapter a la API nominal de dataAccess.js (R4).
    Este modulo ya usa dataAccess (queryFirstItem) en la consulta nueva.

HISTORIAL:
v5009-FISCAL-V20.2 | CORE-01..CORE-07.
v5008.6 | 2026-09-20 | FIX-32, FIX-33, FIX-43.
v5008.5 | 2026-09-19 | Coherencia scheduleId.
v5008.2 | 2026-09-15 | Aligned + dead code removed.
*/

import { bookings } from "@wix/bookings";
import { checkout } from "@wix/ecom";
import { auth } from "@wix/essentials";
// EXCEPCION DATA API (Biblia Apendice C): acceso CMS server-side. El adaptador
// eleva toda operacion y garantiza que los hooks de data.js se ejecuten.
import wixData from "backend/dataLegacyAdapter";
// R4: las consultas NUEVAS usan la API nominal de dataAccess, no el adaptador
// legacy (dataAccess.js no tiene export default).
import { queryFirstItem, CONSISTENCY } from "backend/dataAccess";
import { getStaffScheduleId, getStaffThirdPartyId } from "backend/staff";
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
const STAFF_RESOURCE_TYPE_ID = API.STAFF_RESOURCE_TYPE_ID;

// CORE-05: unica definicion de la huella dual en bookingUtils; aqui solo se
// reexporta la superficie publica historica, sin duplicar logica.
export { _buildPairFingerprint };
// Back-compat: modulos historicos importan logger desde este fichero.
export { logger };

const CONFIGURED_LOCATION_ID = _safeTrim(SDK_CONFIG && SDK_CONFIG.LOCATION_ID);

// =============================================================================
// BLOQUE 1 - CODIGOS DE ERROR (Biblia 20.10 + especificos de reserva)
// =============================================================================
export const ERROR_CODES = Object.freeze({
    INVALID_PAYLOAD: "INVALID_PAYLOAD",
    TOKEN_BUSY: "TOKEN_BUSY",
    FISCAL_SIGN_FAIL: "FISCAL_SIGN_FAIL",
    FISCAL_VIOLATION: "FISCAL_VIOLATION",
    BOOKING_CREATION_FAILED: "BOOKING_CREATION_FAILED",
    CHECKOUT_FAILED: "CHECKOUT_FAILED",
    INVALID_EMPLOYEE: "INVALID_EMPLOYEE",
    AUTH_REQUIRED: "AUTH_REQUIRED",
    ACCESS_DENIED: "ACCESS_DENIED",
    INVALID_CLOCK_TYPE: "INVALID_CLOCK_TYPE",
    RATE_LIMITED: "RATE_LIMITED",
    SLOT_UNAVAILABLE: "SLOT_UNAVAILABLE",
    STAFF_UNAVAILABLE: "STAFF_UNAVAILABLE",
    SERVICE_NOT_FOUND: "SERVICE_NOT_FOUND",
    LOCATION_MISMATCH: "LOCATION_MISMATCH",
    LOCK_KEY_OR_OWNER_INVALID: "LOCK_KEY_OR_OWNER_INVALID",
    LOCK_HELD_BY_ANOTHER_OWNER: "LOCK_HELD_BY_ANOTHER_OWNER",
    LOCK_EXPIRED_PENDING_CLEANUP: "LOCK_EXPIRED_PENDING_CLEANUP",
    LOCK_RENEWAL_FAILED: "LOCK_RENEWAL_FAILED",
    TRANSACTION_TIMEOUT: "TRANSACTION_TIMEOUT",
    PAIR_TOKEN_PAYLOAD_MISMATCH: "PAIR_TOKEN_PAYLOAD_MISMATCH",
    TRANSACTION_PREVIOUSLY_FAILED: "TRANSACTION_PREVIOUSLY_FAILED",
    INVALID_SLOT_RECHECK: "INVALID_SLOT_RECHECK",
    DATABASE_ERROR: "DATABASE_ERROR",
    INVALID_DATES: "INVALID_DATES",
    UNKNOWN_ERROR: "UNKNOWN_ERROR",
});

// =============================================================================
// BLOQUE 2 - ENUMS: FRONTERA WIX NATIVO <-> CMS PERSISTIDO (CORE-11)
// =============================================================================
// Biblia 6.2. Unico contrato de persistencia de CitasF2. Se exporta para que
// bookingSaga, citasManager y los tests compartan la misma fuente: elimina el
// drift que hacia fallar los fixtures (usaban CANCELADO/PAGADO/UNPAID a la vez).
export const CMS_BOOKING_STATUS = Object.freeze({
    PENDING: "PENDING",
    CONFIRMED: "CONFIRMED",
    COMPLETED: "COMPLETED",
    CANCELLED: "CANCELLED",
    NO_SHOW: "NO_SHOW",
});

export const CMS_PAYMENT_STATUS = Object.freeze({
    UNPAID: "UNPAID",
    PARTIAL: "PARTIAL",
    PAID: "PAID",
    REFUNDED: "REFUNDED",
});

// Claves: enum nativo Wix (Biblia 6.1) + alias ES de dominio tolerados SOLO en
// entrada (Matriz 2). Decisiones documentadas:
//  - CREATED / WAITING_LIST / UPDATED no existen en el CMS: se proyectan al
//    estado funcional equivalente (PENDING / CONFIRMED).
//  - REFUNDED y DECLINED como estado de RESERVA implican cita no celebrada:
//    persisten CANCELLED. El reembolso vive en paymentStatus.
//  - NO_SHOW con guion bajo, tal como lo define el CMS.
const WIX_TO_CMS_BOOKING_STATUS = Object.freeze({
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
    NO_SHOW: "NO_SHOW",
    NOSHOW: "NO_SHOW",
    PENDIENTE: "PENDING",
    CONFIRMADO: "CONFIRMED",
    COMPLETADO: "COMPLETED",
    CANCELADO: "CANCELLED",
    REEMBOLSADO: "CANCELLED",
    NO_PRESENTADO: "NO_SHOW",
});

// EXEMPT (servicio F2 NO_FEE) no genera importe pendiente: persiste PAID.
const WIX_TO_CMS_PAYMENT_STATUS = Object.freeze({
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

// Devuelven "" ante valor desconocido: assertValidEnum fallara de forma
// explicita en vez de persistir basura (Biblia 0.5.6).
export function _toCmsBookingStatus(value) {
    const v = _safeTrim(value).toUpperCase();
    if (!v) return "";
    return WIX_TO_CMS_BOOKING_STATUS[v] || "";
}

export function _toCmsPaymentStatus(value) {
    const v = _safeTrim(value).toUpperCase();
    if (!v) return "";
    return WIX_TO_CMS_PAYMENT_STATUS[v] || "";
}

// Mapa inverso para la API de Wix (CORE-06). bookingSaga envia el SSOT espanol
// (PAYMENT_STATUS.NOT_PAID = "IMPAGADO") y Wix solo acepta su enum nativo EN.
// Los valores ya nativos pasan sin cambio (identity pass-through).
const WIX_NATIVE_PAYMENT_STATUS = Object.freeze({
    UNDEFINED: "UNDEFINED",
    NOT_PAID: "NOT_PAID",
    PENDING_PAYMENT: "PENDING_PAYMENT",
    PENDING_LEDGER: "PENDING_LEDGER",
    PAID: "PAID",
    PARTIALLY_PAID: "PARTIALLY_PAID",
    REFUNDED: "REFUNDED",
    PARTIALLY_REFUNDED: "PARTIALLY_REFUNDED",
    EXEMPT: "EXEMPT",
    IMPAGADO: "NOT_PAID",
    NO_PAGADO: "NOT_PAID",
    UNPAID: "NOT_PAID",
    PAGADO: "PAID",
    PARCIALMENTE_PAGADO: "PARTIALLY_PAID",
    PARTIAL: "PARTIALLY_PAID",
    REEMBOLSADO: "REFUNDED",
    REEMBOLSADO_PARCIAL: "PARTIALLY_REFUNDED",
    EXENTO: "EXEMPT",
});

function _toWixNativePaymentStatus(value) {
    const v = _safeTrim(value).toUpperCase();
    if (!v) return value;
    return WIX_NATIVE_PAYMENT_STATUS[v] || value;
}

function _deriveCmsBookingStatus(cmsPaymentStatus) {
    return cmsPaymentStatus === CMS_PAYMENT_STATUS.UNPAID
        ? CMS_BOOKING_STATUS.PENDING
        : CMS_BOOKING_STATUS.CONFIRMED;
}

// =============================================================================
// BLOQUE 3 - ELEVATED PROXIES (Bookings V2 + eCommerce)
// =============================================================================
// Superficie reducida a los proxies con consumidor real:
//   cancelBookingElevated        -> bookingSaga (compensacion SAGA-06) + crons.js
//   confirmOrDeclineBooking...   -> bookingSaga (paso ConfirmPresencial, CORE-06)
//   createCheckout/getCheckoutUrl-> bookingSaga (flujo ONLINE, Catalog V1)
// createBookingElevated y rescheduleBookingElevated eliminados: cero consumidores.
// La creacion usa elevacion selectiva (bookingSaga, FIX-37) solo bajo ACCESS_DENIED.
export const cancelBookingElevated = auth.elevate(bookings.cancelBooking);
export const createCheckoutElevated = auth.elevate(checkout.createCheckout);
export const getCheckoutUrlElevated = auth.elevate(checkout.getCheckoutUrl);

const _confirmOrDeclineElevatedRaw = auth.elevate(bookings.confirmOrDeclineBooking);

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

// =============================================================================
// BLOQUE 4 - BOOKINGERROR Y NORMALIZACION DE ERRORES
// =============================================================================
export class BookingError extends Error {
    constructor(code, message, details) {
        super(String(message || "Unknown error"));
        this.name = "BookingError";
        this.code = String(code || ERROR_CODES.UNKNOWN_ERROR);
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
            code: String(err.code || ERROR_CODES.UNKNOWN_ERROR),
            message: String(err.message || "Unknown error"),
            stack: err.stack || null,
            details: err.details || {},
        };
    }
    if (err instanceof Error) {
        return {
            code: String(err.code || err.errorCode || err.name || ERROR_CODES.UNKNOWN_ERROR),
            message: String(err.message || "Unknown error"),
            stack: err.stack || null,
            details: err.details && typeof err.details === "object" ? err.details : {},
        };
    }
    if (typeof err === "string") {
        return { code: ERROR_CODES.UNKNOWN_ERROR, message: err, stack: null, details: {} };
    }
    if (err && typeof err === "object") {
        return {
            code: String(err.code || err.errorCode || err.name || ERROR_CODES.UNKNOWN_ERROR),
            message: String(err.message || err.error || "Unknown error"),
            stack: err.stack || null,
            details: {},
        };
    }
    return { code: ERROR_CODES.UNKNOWN_ERROR, message: "Unknown error", stack: null, details: {} };
}

// Biblia 0.5.5: el error se maneja una vez, en la capa donde ocurre.
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
            code: norm.code || ERROR_CODES.UNKNOWN_ERROR,
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
        message.indexOf("wd_item_already_exists") >= 0 ||
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
    const scheduleId = _safeTrim(
        s.scheduleId ||
        (s.slot && s.slot.scheduleId) ||
        (s.schedule && s.schedule.id) ||
        (s.resource && s.resource.scheduleId) ||
        ""
    );
    if (scheduleId && _looksLikeGuid(scheduleId)) return scheduleId;
    const resolved = await _resolveScheduleIdByResourceId(resourceIdClean);
    return resolved || null;
}

// =============================================================================
// BLOQUE 7 - NORMALIZACION DE SLOTS PARA WRITER V2 (CORE-02, CORE-04)
// =============================================================================
// Fuentes aceptadas (por orden): slot.addOnIds, slot.selectedAddOns,
// slot.customerChoices.addOnIds (forma usada en disponibilidad).
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

// Construye el objeto con forma bookingInfo que exige Bookings Writer V2
// (Biblia 2.2.1 / 3.3): timezone en minusculas y locationType OWNER_BUSINESS.
// Devuelve null ante cualquier dato no certificable (fail-fast).
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
        const durationMin = Number(
            defaultDurationMinutes ||
            (CONCURRENCY && CONCURRENCY.DEFAULT_DURATION_MIN) ||
            30
        );
        localEndDate = getMadridLocalStringNoZ(new Date(startUtc.getTime() + durationMin * 60 * 1000));
    }

    const startDate = getUtcDateFromMadridLocal(localStartDate);
    const endDate = getUtcDateFromMadridLocal(localEndDate);
    if (!startDate || !endDate) return null;
    if (endDate.getTime() <= startDate.getTime()) {
        log.error("_forceStaffInPristineSlot: invalid date range (endDate <= startDate)", {
            localStartDate: localStartDate,
            localEndDate: localEndDate,
            resourceId: resourceIdClean,
            serviceId: serviceId,
        });
        return null;
    }

    // CORE-04: si el slot trae OTRA ubicacion, fail-fast. Nunca se sustituye en
    // silencio: crearia la reserva en un local equivocado.
    const slotLocation = slot.location && typeof slot.location === "object" ? slot.location : {};
    const incomingLocationId = _safeTrim(slotLocation.id);
    if (incomingLocationId && CONFIGURED_LOCATION_ID && incomingLocationId !== CONFIGURED_LOCATION_ID) {
        log.error("_forceStaffInPristineSlot: slot location conflicts with configured location", {
            slotLocationId: incomingLocationId,
            configuredLocationId: CONFIGURED_LOCATION_ID,
            serviceId: serviceId,
        });
        return null;
    }

    const locationId = CONFIGURED_LOCATION_ID || incomingLocationId;
    if (!locationId || !_looksLikeGuid(locationId)) {
        log.error("_forceStaffInPristineSlot: missing or invalid LOCATION_ID", {
            configuredLocationId: CONFIGURED_LOCATION_ID,
            incomingLocationId: incomingLocationId,
        });
        return null;
    }

    // Biblia 2.2.1 fila 8: creacion SIEMPRE con OWNER_BUSINESS.
    let locationType = _safeTrim(
        SDK_CONFIG.LOCATION_TYPES && SDK_CONFIG.LOCATION_TYPES.BOOKINGS_WRITER
    );
    if (!locationType || locationType === "BUSINESS") locationType = "OWNER_BUSINESS";

    const result = {
        serviceId: serviceId,
        scheduleId: scheduleId,
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
        timezone: _safeTrim(SDK_CONFIG.TZ) || "Europe/Madrid",
        resource: { id: resourceIdClean },
        location: { id: locationId, locationType: locationType },
    };

    // CORE-02: se emiten ambas claves porque el contrato del Writer V2 ha usado
    // historicamente addOnIds y selectedAddOns.
    const addOnIds = _extractAddonIdsFromSlot(slot);
    if (addOnIds.length > 0) {
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
    if (checkoutSession.checkout && checkoutSession.checkout._id) {
        return checkoutSession.checkout._id;
    }
    return checkoutSession._id || null;
}

// =============================================================================
// BLOQUE 9 - SLOT KEYS (CORE-13)
// =============================================================================
// Formato: slot_<servicePrefix8>_<resourceIdGUID>_<startEpochMin>_<endEpochMin>
// Los GUID usan guiones (nunca "_"), por lo que el parseo por separador es
// determinista y permite al mutex satisfacer el requisito resourceId del hook.
export function generateSlotKey(serviceId, resourceId, startDate, endDate) {
    const startUtc = startDate instanceof Date
        ? startDate
        : getUtcDateFromMadridLocal(_normalizeLocalIsoStr(startDate));
    const endUtc = endDate instanceof Date
        ? endDate
        : getUtcDateFromMadridLocal(_normalizeLocalIsoStr(endDate));

    if (!startUtc || !endUtc || endUtc.getTime() <= startUtc.getTime()) {
        throw createBookingError(ERROR_CODES.INVALID_DATES, "Invalid slot dates for lock key");
    }

    const res = _safeTrim(resourceId);
    if (!res || !_looksLikeGuid(res)) {
        throw createBookingError(
            ERROR_CODES.LOCK_KEY_OR_OWNER_INVALID,
            "resourceId is required and must be a valid GUID to build a slot key"
        );
    }

    const svc = _safeTrim(serviceId);
    const servicePrefix = svc ? svc.slice(0, 8) : "srv";
    const startEpochMin = Math.floor(startUtc.getTime() / 60000);
    const endEpochMin = Math.floor(endUtc.getTime() / 60000);
    return "slot_" + servicePrefix + "_" + res + "_" + startEpochMin + "_" + endEpochMin;
}

// Unico parser del formato anterior. Devuelve "" si la clave no es reconocible.
export function _parseResourceIdFromSlotKey(slotKey) {
    const parts = String(slotKey || "").split("_");
    if (parts.length !== 5 || parts[0] !== "slot") return "";

    const servicePrefix = _safeTrim(parts[1]);
    const resourceId = _safeTrim(parts[2]);
    const startEpochMin = parts[3];
    const endEpochMin = parts[4];

    if (!servicePrefix) return "";
    if (!/^\d+$/.test(startEpochMin) || !/^\d+$/.test(endEpochMin)) return "";
    if (Number(endEpochMin) <= Number(startEpochMin)) return "";

    return _looksLikeGuid(resourceId) ? resourceId : "";
}

export function _buildLockKeys(phases, resourceId) {
    const keys = (Array.isArray(phases) ? phases : [])
        .map(function (phase) {
            const slot = (phase && phase.rawSlot) || {};
            try {
                return generateSlotKey(
                    slot.serviceId,
                    resourceId,
                    phase && phase.localStart,
                    phase && phase.localEnd
                );
            } catch (_) {
                return "";
            }
        })
        .filter(function (key) { return !!key; });
    return Array.from(new Set(keys)).sort();
}

// =============================================================================
// BLOQUE 10 - MUTEX LOCKS EN ControlOperativo (SLOT_LOCK)
// =============================================================================
const MUTEX_TTL_MS = Number(CONCURRENCY && CONCURRENCY.MS_TTL_MUTEX);
if (!Number.isFinite(MUTEX_TTL_MS) || MUTEX_TTL_MS <= 0) {
    throw new Error("MS_TTL_MUTEX must be positive");
}

// ADR-05: SlotLocks absorbida en ControlOperativo (controlType=SLOT_LOCK).
const LOCKS_COL = OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO;

export function safeLockId(key) {
    const k = _safeTrim(key);
    if (!k) return "";
    return "lk" + _hashKey(k) + k.slice(0, 24);
}

// CORE-12 / CORE-21: documento canonico de ControlOperativo/SLOT_LOCK.
// El hook (Biblia 12.2) exige controlType, dedupeKey, traceId y, para SLOT_LOCK,
// resourceId + expiresAt. El propietario vive en payloadJson, no en campos
// fuera de esquema.
export function _buildSlotLockControl(slotClave, lockOwnerId, ttlMs, existing) {
    const resourceId = _parseResourceIdFromSlotKey(slotClave);
    if (!resourceId) {
        throw createBookingError(
            ERROR_CODES.LOCK_KEY_OR_OWNER_INVALID,
            "Slot key does not carry a valid resourceId; ControlOperativo SLOT_LOCK requires it",
            { slotKey: _safeTrim(slotClave) }
        );
    }
    const ttl = Number(ttlMs);
    return {
        _id: safeLockId(slotClave),
        controlType: CONTROL_TYPE.SLOT_LOCK,
        dedupeKey: String(slotClave),
        resourceId: resourceId,
        expiresAt: new Date(Date.now() + (Number.isFinite(ttl) && ttl > 0 ? ttl : MUTEX_TTL_MS)),
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
    const item = await wixData
        .get(LOCKS_COL, id, { consistentRead: true })
        .catch(function () { return null; });
    if (!item) return null;
    if (item.expiresAt) item.expiresAt = _toDateSafe(item.expiresAt);
    return item;
}

function _getLockOwnerId(lock) {
    if (!lock || typeof lock !== "object") return "";
    const payload = _parsePayloadJson(lock.payloadJson);
    // lockOwnerId en claro: tolerado solo en lectura para filas pre-CORE-12.
    return _safeTrim(payload.lockOwnerId) || _safeTrim(lock.lockOwnerId) || "";
}

export async function _lockSlotKeyOrFail(slotClave, lockOwnerId, ttlMs) {
    const k = _safeTrim(slotClave);
    const owner = _safeTrim(lockOwnerId);
    if (!k || !owner) return { ok: false, message: ERROR_CODES.LOCK_KEY_OR_OWNER_INVALID };
    if (!_parseResourceIdFromSlotKey(k)) {
        return { ok: false, message: ERROR_CODES.LOCK_KEY_OR_OWNER_INVALID };
    }

    try {
        await wixData.insert(LOCKS_COL, _buildSlotLockControl(k, owner, ttlMs));
        return { ok: true, acquired: true };
    } catch (error) {
        if (!_isDuplicateItemError(error)) {
            log.error("_lockSlotKeyOrFail failed", { slotClave: k, error: error && error.message });
            return { ok: false, message: (error && error.message) || ERROR_CODES.DATABASE_ERROR };
        }

        const existing = await _getLock(k);
        const currentOwner = _getLockOwnerId(existing);
        if (currentOwner && currentOwner === owner) {
            const renewed = await _renewLock(k, owner, ttlMs);
            return renewed.ok
                ? { ok: true, renewed: true }
                : { ok: false, message: ERROR_CODES.LOCK_RENEWAL_FAILED };
        }

        const expiresAt = _toDateSafe(existing && existing.expiresAt);
        const expired = expiresAt ? expiresAt.getTime() < Date.now() : false;
        if (expired && existing && existing._id) {
            await wixData.remove(LOCKS_COL, existing._id).catch(function () { return null; });
            try {
                await wixData.insert(LOCKS_COL, _buildSlotLockControl(k, owner, ttlMs));
                return { ok: true, acquired: true, reclaimed: true };
            } catch (_) {
                return { ok: false, message: ERROR_CODES.LOCK_HELD_BY_ANOTHER_OWNER };
            }
        }
        return { ok: false, message: ERROR_CODES.LOCK_HELD_BY_ANOTHER_OWNER };
    }
}

export async function _unlockSlotKey(slotClave, lockOwnerId) {
    const owner = _safeTrim(lockOwnerId);
    const existing = await _getLock(slotClave);
    if (!existing) return { ok: true, missing: true };
    const currentOwner = _getLockOwnerId(existing);
    if (!owner || currentOwner !== owner) return { ok: false, skipped: true };
    await wixData.remove(LOCKS_COL, existing._id).catch(function (error) {
        log.warn("_unlockSlotKey: remove failed", {
            slotClave: slotClave,
            error: error && error.message,
        });
    });
    return { ok: true };
}

export async function _renewLock(slotClave, lockOwnerId, ttlMs) {
    const owner = _safeTrim(lockOwnerId);
    try {
        const existing = await _getLock(slotClave);
        if (!existing) return { ok: false };
        if (!owner || _getLockOwnerId(existing) !== owner) return { ok: false };
        await wixData.update(LOCKS_COL, _buildSlotLockControl(slotClave, owner, ttlMs, existing));
        return { ok: true };
    } catch (error) {
        log.error("_renewLock failed", { slotClave: slotClave, error: error && error.message });
        return { ok: false };
    }
}

// =============================================================================
// BLOQUE 11 - TRANSACCIONES IDEMPOTENTES EN ControlOperativo (CORE-12/16/17)
// =============================================================================
// ADR-05: BookingTransactions absorbida en ControlOperativo.
// CORE-17: discriminador IDEMPOTENCY. La Matriz 3 cita BOOKING_TX como nombre
// logico de la coleccion absorbida, pero no pertenece al enum canonico de 6
// valores (Biblia 6.3) y seria rechazado por assertValidEnum en el hook.
const TRANSACTIONS_COL = OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO;
const TX_DEDUPE_PREFIX = "TX_";
// payloadJson es Text: se acota para no exceder el limite fisico del campo.
const TX_PAYLOAD_MAX_CHARS = 900;

const TRANSACTION_POLL_BASE_MS = Number(CONCURRENCY && CONCURRENCY.TRANSACTION_POLL_BASE_MS) || 250;
const TRANSACTION_MAX_WAIT_MS = Number(CONCURRENCY && CONCURRENCY.TRANSACTION_MAX_WAIT_MS) || 3000;

async function _getTransactionById(pairToken) {
    const id = _safeTrim(pairToken);
    if (!id) return null;
    return await wixData
        .get(TRANSACTIONS_COL, id, { consistentRead: true })
        .catch(function () { return null; });
}

// Normaliza el estado de la transaccion tolerando filas pre-CORE-12.
function _readTransaction(doc) {
    if (!doc) return null;
    const payload = _parsePayloadJson(doc.payloadJson);
    return {
        doc: doc,
        status: _safeTrim(payload.status || doc.status),
        payloadHash: _safeTrim(payload.payloadHash || doc.payloadHash),
        ownerTraceId: _safeTrim(payload.ownerTraceId || doc.ownerTraceId),
        error: _safeTrim(payload.error || doc.error),
        bookingId: _safeTrim(payload.bookingId || doc.bookingId),
        result: payload.result !== undefined ? payload.result : doc.result,
    };
}

function _extractBookingIdFromResult(result) {
    if (!result || typeof result !== "object") return "";
    const direct = _safeTrim(result.bookingId);
    if (direct) return direct;
    const nested = result.data && typeof result.data === "object" ? result.data : {};
    return _safeTrim(nested.bookingId);
}

function _buildTransactionControl(pairToken, state, existingDoc) {
    const payload = Object.assign({}, state);
    let payloadJson = JSON.stringify(payload);
    if (payloadJson.length > TX_PAYLOAD_MAX_CHARS) {
        delete payload.result;
        payload.resultDropped = true;
        payloadJson = JSON.stringify(payload);
    }
    const doc = {
        _id: String(pairToken),
        controlType: CONTROL_TYPE.IDEMPOTENCY,
        dedupeKey: TX_DEDUPE_PREFIX + String(pairToken),
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
        if (existingDoc && existingDoc._id) await wixData.update(TRANSACTIONS_COL, doc);
        else await wixData.insert(TRANSACTIONS_COL, doc);
    } catch (error) {
        if (!_isDuplicateItemError(error)) {
            log.error("_writeTransaction failed", {
                pairToken: pairToken,
                error: error && error.message,
            });
        }
    }
}

// CORE-16: veredicto reutilizable del polling. null = seguir esperando.
function _evaluatePendingTransaction(current, payloadHash) {
    if (!current) return null;
    if (current.payloadHash !== String(payloadHash || "")) {
        return { success: false, error: ERROR_CODES.PAIR_TOKEN_PAYLOAD_MISMATCH, existing: current };
    }
    if (current.status === "COMPLETED") return { success: true, isNew: false, existing: current };
    if (current.status === "FAILED") {
        return { success: false, error: ERROR_CODES.TRANSACTION_PREVIOUSLY_FAILED, existing: current };
    }
    return null;
}

export async function _initTransaction(pairToken, payloadHash, traceId) {
    const id = _safeTrim(pairToken);
    if (!id) return { success: false, error: "INVALID_PAIR_TOKEN" };

    const state = {
        status: "PENDING",
        payloadHash: String(payloadHash || ""),
        ownerTraceId: String(traceId || ""),
    };

    try {
        await wixData.insert(TRANSACTIONS_COL, _buildTransactionControl(id, state, null));
        return { success: true, isNew: true };
    } catch (error) {
        if (!_isDuplicateItemError(error)) {
            // CORE-16: no se lanza; se respeta el contrato {success, error}.
            log.error("_initTransaction: insert failed", {
                pairToken: id,
                error: error && error.message,
            });
            return { success: false, error: ERROR_CODES.DATABASE_ERROR };
        }
    }

    const startTime = Date.now();
    let pollAttempt = 0;
    while (Date.now() - startTime < TRANSACTION_MAX_WAIT_MS) {
        const verdict = _evaluatePendingTransaction(
            _readTransaction(await _getTransactionById(id)),
            payloadHash
        );
        if (verdict) return verdict;

        const remainingMs = TRANSACTION_MAX_WAIT_MS - (Date.now() - startTime);
        const delay = Math.min(
            Math.floor(TRANSACTION_POLL_BASE_MS * Math.pow(2, Math.min(pollAttempt, 3)) * (0.5 + Math.random())),
            remainingMs
        );
        if (delay <= 0) break;
        pollAttempt++;
        await new Promise(function (resolve) { setTimeout(resolve, delay); });
    }

    const finalState = _readTransaction(await _getTransactionById(id));
    return _evaluatePendingTransaction(finalState, payloadHash) || {
        success: false,
        error: ERROR_CODES.TRANSACTION_TIMEOUT,
        existing: finalState,
        timeout: true,
    };
}

export async function _completeTransaction(pairToken, result, traceId) {
    const id = _safeTrim(pairToken);
    if (!id) return;
    const current = _readTransaction(await _getTransactionById(id));
    if (current && current.status === "COMPLETED") return;
    await _writeTransaction(id, {
        status: "COMPLETED",
        payloadHash: current ? current.payloadHash : "",
        ownerTraceId: _safeTrim(traceId) || (current ? current.ownerTraceId : ""),
        bookingId: _extractBookingIdFromResult(result),
        result: result === undefined ? null : result,
    }, current ? current.doc : null);
}

export async function _failTransaction(pairToken, errorMessage) {
    const id = _safeTrim(pairToken);
    if (!id) return;
    const current = _readTransaction(await _getTransactionById(id));
    if (current && current.status === "COMPLETED") return;
    await _writeTransaction(id, {
        status: "FAILED",
        payloadHash: current ? current.payloadHash : "",
        ownerTraceId: current ? current.ownerTraceId : "",
        error: String(errorMessage || ERROR_CODES.UNKNOWN_ERROR),
    }, current ? current.doc : null);
}

// =============================================================================
// BLOQUE 12 - PERSISTENCIA EN CITAS_F2 (CORE-09/10/11/18/19/20)
// =============================================================================
const CITAS_COL = BUSINESS_COLLECTIONS.CITAS_F2;

// Biblia 0.5.8 / RGPD: minimizacion. Solo lo imprescindible para la reserva.
function _minimizeContactDetails(contactDetails) {
    const cd = contactDetails && typeof contactDetails === "object" ? contactDetails : {};
    const out = {};
    const firstName = _safeTrim(cd.firstName || cd.first_name);
    const lastName = _safeTrim(cd.lastName || cd.last_name);
    const email = _safeTrim(cd.email);
    const phone = _safeTrim(cd.phone || cd.phoneNumber);
    if (firstName) out.firstName = firstName;
    if (lastName) out.lastName = lastName;
    if (email) out.email = email;
    if (phone) out.phone = phone;
    return out;
}

function _normalizeMeta(rawMeta, overrides) {
    let meta = rawMeta;
    if (typeof meta === "string") {
        try { meta = JSON.parse(meta); } catch (_) { meta = {}; }
    }
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) meta = {};
    return Object.assign({}, meta, overrides);
}

// CORE-20: respeta el dateYmd aportado por la saga si es valido; si no, lo
// deriva del inicio del slot en Europe/Madrid.
function _resolveDateYmd(explicitValue, startDateObj, bookingId, traceId) {
    const explicit = _safeTrim(explicitValue);
    if (/^\d{4}-\d{2}-\d{2}$/.test(explicit)) return explicit;
    const startLocal = getMadridLocalStringNoZ(startDateObj);
    const derived = startLocal ? startLocal.slice(0, 10) : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(derived)) {
        throw createBookingError(
            ERROR_CODES.INVALID_DATES,
            "Cannot derive dateYmd (Europe/Madrid) from slotStart",
            { traceId: traceId, bookingId: bookingId, startLocal: startLocal }
        );
    }
    return derived;
}

// Persiste la proyeccion interna de la reserva en CitasF2.
// CORE-09: sin suppressHooks. El documento se construye cumpliendo el contrato
// de CitasF2_beforeInsert (enums CMS, traceId, coherencia pairToken) para que
// el hook lo acepte en vez de intentar esquivarlo.
export async function _persistBooking(params, traceId) {
    const p = params || {};

    const traceIdClean = _safeTrim(traceId || p.traceId);
    if (!traceIdClean) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "traceId is required to persist a booking in CitasF2",
            { bookingId: _safeTrim(p.bookingId) }
        );
    }

    const bookingId = _safeTrim(p.bookingId);
    const serviceId = _safeTrim(p.serviceId);
    const resourceId = _safeTrim(p.resourceId);
    if (!bookingId || !serviceId || !resourceId || !p.startDate || !p.endDate) {
        throw createBookingError(ERROR_CODES.INVALID_PAYLOAD, "Missing required fields for persistBooking", {
            traceId: traceIdClean,
            bookingId: bookingId,
        });
    }

    const scheduleIdClean = _safeTrim(p.scheduleId);
    if (!scheduleIdClean || !_looksLikeGuid(scheduleIdClean)) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "scheduleId is required and must be a valid GUID for CitasF2 persistence",
            { traceId: traceIdClean, bookingId: bookingId, scheduleIdRaw: p.scheduleId }
        );
    }

    const startDateObj = _toDateSafe(p.startDate);
    const endDateObj = _toDateSafe(p.endDate);
    if (!startDateObj || !endDateObj || endDateObj.getTime() <= startDateObj.getTime()) {
        throw createBookingError(ERROR_CODES.INVALID_DATES, "Invalid startDate/endDate for persistBooking", {
            traceId: traceIdClean,
            bookingId: bookingId,
        });
    }

    const dateYmd = _resolveDateYmd(p.dateYmd, startDateObj, bookingId, traceIdClean);

    const bookingType = normalizeBookingType(p.bookingType || p.tipo);
    const pairToken = _safeTrim(p.pairToken || (p.meta && p.meta.pairToken));
    // Biblia 5.4: pairToken identico en las filas DUAL_F1 y DUAL_F2.
    if (isDualBookingType(bookingType) && !pairToken) {
        throw createBookingError(ERROR_CODES.INVALID_PAYLOAD, "Missing pairToken for linked booking", {
            traceId: traceIdClean,
            bookingId: bookingId,
            bookingType: bookingType,
        });
    }

    // CORE-19: importe obligatorio y finito. Un 0 silenciado romperia el cuadre
    // taxBase+cuota del ledger y el cierre Z (Biblia Prioridad 1 y 3).
    const rawAmount = p.totalAmount !== undefined
        ? p.totalAmount
        : (p.meta && p.meta.totalAmount !== undefined ? p.meta.totalAmount : null);
    const totalAmount = _roundMoney(Number(rawAmount));
    if (rawAmount === null || rawAmount === undefined || !Number.isFinite(totalAmount) || totalAmount < 0) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "totalAmount is required and must be a finite number >= 0 for CitasF2",
            { traceId: traceIdClean, bookingId: bookingId, totalAmountRaw: rawAmount }
        );
    }

    // CORE-11: traduccion unica al enum persistido + validacion runtime.
    const rawPayment = p.paymentStatus !== undefined
        ? p.paymentStatus
        : (p.meta && p.meta.paymentStatus !== undefined ? p.meta.paymentStatus : PAYMENT_STATUS.NOT_PAID);
    const paymentStatus = _toCmsPaymentStatus(rawPayment);
    const rawBookingStatus = p.bookingStatus !== undefined ? p.bookingStatus : p.status;
    const bookingStatus = _toCmsBookingStatus(rawBookingStatus) || _deriveCmsBookingStatus(paymentStatus);
    assertValidEnum(bookingStatus, CMS_BOOKING_STATUS, "bookingStatus");
    assertValidEnum(paymentStatus, CMS_PAYMENT_STATUS, "paymentStatus");

    // CORE-18: thirdPartyId es FK obligatoria a DatosFiscales.taxId. Al eliminarse
    // MapaStaff, la unica fuente del NIF del profesional es DatosFiscales
    // (recordType STAFF_CONFIG). Se resuelve aqui si el llamante no lo aporta.
    let thirdPartyId = _safeTrim(p.thirdPartyId || (p.meta && p.meta.thirdPartyId));
    if (!thirdPartyId) {
        thirdPartyId = await getStaffThirdPartyId(resourceId).catch(function (error) {
            log.warn("getStaffThirdPartyId failed", {
                traceId: traceIdClean,
                resourceId: resourceId,
                error: error && error.message,
            });
            return "";
        });
    }
    if (!thirdPartyId) {
        log.warn("CitasF2 persisted without thirdPartyId: no staff fiscal record in DatosFiscales", {
            traceId: traceIdClean,
            bookingId: bookingId,
            resourceId: resourceId,
        });
    }

    // Biblia 5.4: catalogId apunta a ServiciosCatalogo.serviceId.
    const catalogId = _safeTrim(p.catalogId) || serviceId;

    const doc = {
        bookingId: bookingId,
        pairToken: pairToken,
        catalogId: catalogId,
        serviceId: serviceId,
        scheduleId: scheduleIdClean,
        resourceId: resourceId,
        thirdPartyId: thirdPartyId,
        dateYmd: dateYmd,
        // CORE-10: campos fisicos canonicos (antes startDate/endDate, inexistentes).
        slotStart: startDateObj,
        slotEnd: endDateObj,
        bookingType: bookingType,
        revision: Number(p.revision) || 1,
        totalAmount: totalAmount,
        // ADR-06: se escribe SOLO el campo fisico canonico. El alias legacy
        // "status" se tolera unicamente en lectura y nunca se persiste.
        [BOOKING_FIELDS.STATUS]: bookingStatus,
        paymentStatus: paymentStatus,
        contactDetails: _minimizeContactDetails(p.contactDetails),
        meta: _normalizeMeta(p.meta, { bookingStatus: bookingStatus, paymentStatus: paymentStatus }),
        traceId: traceIdClean,
    };

    const existing = await wixData
        .query(CITAS_COL)
        .eq("bookingId", bookingId)
        .limit(1)
        .find({ consistentRead: true })
        .catch(function () { return null; });

    if (existing && Array.isArray(existing.items) && existing.items.length > 0) {
        const existingDoc = existing.items[0];
        const incomingRevision = Number(doc.revision) || 1;
        const currentRevision = Number(existingDoc.revision) || 1;
        if (incomingRevision < currentRevision) {
            throw new BookingError(ERROR_CODES.DATABASE_ERROR, "Booking revision conflict", {
                bookingId: bookingId,
                currentRevision: currentRevision,
                incomingRevision: incomingRevision,
                traceId: traceIdClean,
            });
        }
        const updated = Object.assign({}, existingDoc, doc);
        // Campos gestionados por Wix Data: nunca se sobrescriben.
        delete updated._createdDate;
        delete updated._updatedDate;
        delete updated._owner;
        // ADR-06 zero-fallback-on-write: se purga el alias legacy si la fila lo traia.
        delete updated.status;
        const item = await wixData.update(CITAS_COL, updated);
        return { created: false, item: item };
    }

    const item = await wixData.insert(CITAS_COL, doc);
    return { created: true, item: item };
}

// =============================================================================
// BLOQUE 13 - ACTUALIZACION SEGURA DE CITA (CORE-09/11)
// =============================================================================
export async function _updateCitaSafe(bookingId, updater, traceId, operation) {
    const bid = _safeTrim(bookingId);
    if (!bid) return { updated: false, reason: "INVALID_BOOKING_ID" };
    try {
        const res = await wixData
            .query(CITAS_COL)
            .eq("bookingId", bid)
            .limit(1)
            .find({ consistentRead: true });
        const cita = res && Array.isArray(res.items) ? res.items[0] : null;
        if (!cita) {
            log.warn("_updateCitaSafe: cita not found", {
                bookingId: bid,
                operation: operation,
                traceId: traceId,
            });
            return { updated: false, reason: "NOT_FOUND" };
        }

        const updated = updater(cita);
        if (!updated) return { updated: false, reason: "NO_CHANGE" };

        // CORE-11: el updater puede devolver nativo Wix, alias ES o el valor ya
        // canonico. Se normaliza siempre antes de escribir y se valida en runtime.
        // Las filas legacy que solo traen "status" quedan migradas de paso.
        const rawStatus = updated.bookingStatus !== undefined ? updated.bookingStatus : updated.status;
        const nextBookingStatus = _toCmsBookingStatus(rawStatus) || _toCmsBookingStatus(cita.bookingStatus);
        const nextPaymentStatus = _toCmsPaymentStatus(updated.paymentStatus) || _toCmsPaymentStatus(cita.paymentStatus);
        assertValidEnum(nextBookingStatus, CMS_BOOKING_STATUS, "bookingStatus");
        assertValidEnum(nextPaymentStatus, CMS_PAYMENT_STATUS, "paymentStatus");

        updated[BOOKING_FIELDS.STATUS] = nextBookingStatus;
        updated.paymentStatus = nextPaymentStatus;
        delete updated.status;
        updated.traceId = _safeTrim(traceId) || _safeTrim(updated.traceId);
        delete updated._createdDate;
        delete updated._updatedDate;
        delete updated._owner;

        await wixData.update(CITAS_COL, updated);
        return { updated: true, bookingId: bid };
    } catch (err) {
        log.error("_updateCitaSafe failed", {
            bookingId: bid,
            operation: operation,
            traceId: traceId,
            error: err && err.message,
        });
        return { updated: false, reason: "ERROR", error: err && err.message };
    }
}

// =============================================================================
// BLOQUE 14 - EXTRACCION DE RESOURCEIDS DESDE SLOTS (CORE-01)
// =============================================================================
// Delegacion total en bookingUtils.getResourceIdsFromSlot (unica implementacion;
// reservas.web importa el mismo helper). Cubre las cuatro variantes de
// resourceType y las tres de resource id que devuelve Wix.
export function _extractResourceIdsFromSlot(slot) {
    return getResourceIdsFromSlot(slot, STAFF_RESOURCE_TYPE_ID);
}

// =============================================================================
// BLOQUE 15 - VERIFICACION DE CONTIGUIDAD / GAP ENTRE SLOTS
// =============================================================================
// Regla del dual con gap (Biblia 1.2 / 11.2): entre el fin de F1 y el inicio de
// F2 debe existir un hueco de exposicion con el profesional libre. Se admite
// solape tecnico de hasta 1 minuto por redondeos de slot.
export function _areSlotsContiguous(slot1, slot2, maxGapMinutes) {
    if (!slot1 || !slot2) return false;

    // SSOT: sin limite explicito del llamante, la tolerancia canonica es
    // SLOT_SEARCH.MINUTOS_TOLERANCIA (Biblia 3.2.1 f12), no un magic number.
    const fallbackTolerance = Number(SLOT_SEARCH && SLOT_SEARCH.MINUTOS_TOLERANCIA);
    const maxGap = maxGapMinutes == null
        ? (Number.isFinite(fallbackTolerance) ? fallbackTolerance : 120)
        : Number(maxGapMinutes);

    const end1 = slot1.localEndDate || slot1.endDate;
    const start2 = slot2.localStartDate || slot2.startDate;
    if (!end1 || !start2) return false;

    const end1Utc = end1 instanceof Date ? end1 : getUtcDateFromMadridLocal(_normalizeLocalIsoStr(end1));
    const start2Utc = start2 instanceof Date ? start2 : getUtcDateFromMadridLocal(_normalizeLocalIsoStr(start2));
    if (!end1Utc || !start2Utc) return false;

    const rawDiffMinutes = (start2Utc.getTime() - end1Utc.getTime()) / 60000;
    if (rawDiffMinutes < -1) return false;
    return computeGapMinutes(end1Utc, start2Utc) <= maxGap;
}

// =============================================================================
// BLOQUE 16 - PROYECCION DE SLOTS CERTIFICADOS Y WRITER (CORE-03, CORE-04)
// =============================================================================
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
    if (!startDateUtc || !endDateUtc || endDateUtc.getTime() <= startDateUtc.getTime()) return null;

    const slotLocation = slot.location && typeof slot.location === "object" ? slot.location : {};
    const slotLocationId = _safeTrim(slotLocation.id);
    if (slotLocationId && CONFIGURED_LOCATION_ID && slotLocationId !== CONFIGURED_LOCATION_ID) {
        log.warn("_projectCertifiedSlot: slot location does not match configured location", {
            slotLocationId: slotLocationId,
            configuredLocationId: CONFIGURED_LOCATION_ID,
            serviceId: serviceId,
        });
        return null;
    }

    const locationId = slotLocationId || CONFIGURED_LOCATION_ID;
    if (!locationId || !_looksLikeGuid(locationId)) {
        log.warn("_projectCertifiedSlot: missing or invalid locationId", {
            slotLocationId: slotLocationId,
            configuredLocationId: CONFIGURED_LOCATION_ID,
            serviceId: serviceId,
        });
        return null;
    }

    return {
        serviceId: serviceId,
        resourceId: resourceIdClean,
        scheduleId: _safeTrim(slot.scheduleId || (slot.slot && slot.slot.scheduleId)),
        localStartDate: localStartDate,
        localEndDate: localEndDate,
        startDate: startDateUtc,
        endDate: endDateUtc,
        bookable: slot.bookable === true,
        availableResources: _extractResourceIdsFromSlot(slot),
        timezone: _safeTrim(SDK_CONFIG.TZ) || "Europe/Madrid",
        locationId: locationId,
        locationName: _safeTrim(slotLocation.name),
        formattedAddress: _safeTrim(slotLocation.formattedAddress),
    };
}

// CORE-03: el Writer V2 exige scheduleId GUID valido (Biblia 2.2.1 fila 4).
// Sin scheduleId util devuelve null EN VEZ de proyectar scheduleId vacio.
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

    let writerLocationType = _safeTrim(
        SDK_CONFIG.LOCATION_TYPES && SDK_CONFIG.LOCATION_TYPES.BOOKINGS_WRITER
    );
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
// La huella debe ser IDENTICA en los tres puntos donde se genera o consume un
// pairToken:
//   reservas.web._getCertifiedDualSlotsInternal  (emisor en disponibilidad)
//   bookingSaga._resolveUnifiedPairToken         (consumidor / reemisor)
//   ControlOperativo (IDEMPOTENCY).payloadHash   (persistencia)
// Los 8 campos son obligatorios: serviceId, linkedPhases, dateYmd, f1Start,
// f1End, f2Start, f2End, resourceId. Cualquier cambio rompe la correlacion.
export function _buildPairTokenDeterministic(input) {
    return _hashKey(_buildPairFingerprint(input || {}));
}

// =============================================================================
// BLOQUE 18 - RANKING DE RECURSOS POR CARGA (CORE-14, CORE-15)
// =============================================================================
// Ordena los recursos disponibles de menor a mayor carga del dia. Nunca deja la
// lista sin recursos: ante cualquier fallo devuelve el orden de disponibilidad.
export async function _rankResourcesByLoad(resourceIds, dateYmd, traceId) {
    const input = Array.isArray(resourceIds)
        ? Array.from(new Set(
            resourceIds.map(function (id) { return _safeTrim(id); }).filter(_looksLikeGuid)
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
            // CORE-14: .in() no existe en wix-data ni en dataLegacyAdapter
            // (verificado contra el builder real: eq/ne/gt/ge/lt/le/hasSome/
            // startsWith/contains). .hasSome() se traduce a $hasSome en WQL.
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
                const inactive = status === CMS_BOOKING_STATUS.CANCELLED ||
                    status === CMS_BOOKING_STATUS.NO_SHOW;
                // Solo REFUNDED libera carga: PARTIAL sigue ocupando slot.
                const refunded = payment === CMS_PAYMENT_STATUS.REFUNDED;
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
