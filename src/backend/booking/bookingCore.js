/*
MODULE: backend/booking/bookingCore.js
VERSION: v5010.11-CORE20-SYNTAX
BASE: v5010.10-PAIRTOKEN-REEXPORT + CORE-20 + SYNTAX RECOVERY
RESPONSIBILITY: Primitivas atomicas de reserva (simple y dual con gap) sobre
                Bookings Writer V2: locks, idempotencia, persistencia CitasF2,
                proyeccion de slots y traduccion de enums en frontera.
STANDARDS: G10 ASCII estricto. Sin Node builtins.
CONTRATO: Reserva dual = DOS createBooking independientes unidos por pairToken.
          Multiservice Booking PROHIBIDO (BIBLIA 3.6).

FIXES v5010.11:
  CORE-20 (P0) CMS enums eliminados como definicion local. Se importan
         CITAS_BOOKING_STATUS/CITAS_PAYMENT_STATUS desde internalConfig y se
         reexportan como CMS_BOOKING_STATUS/CMS_PAYMENT_STATUS para preservar
         la superficie publica historica. Cero duplicacion (BIBLIA §0.5.1).
  SYNTAX (P0) Recuperacion completa de sintaxis corrupta del adjunto v5010.10:
         - Especificadores de modulo con espacio final (9 imports rotos)
         - BOOKING _FIELDS -> BOOKING_FIELDS en import
         - ERROR_CODES: 26 literales con espacio final
         - WIX_TO_CMS_*, WIX_NATIVE_*: todos los valores con espacio final
         - _parsePayloadJson: safeTrim -> _safeTrim, catch () -> catch (_)
         - generateSlotKey: safeTrim -> _safeTrim, formato "slot_" con guiones
         - parseResourceIdFromSlotKey -> _parseResourceIdFromSlotKey (prefijo _)
         - Parser: .split("") -> .split("_"), partes[0] !== "slot"
         - buildLockKeys -> _buildLockKeys (prefijo _)
         - _persistBooking: normalizeMeta -> _normalizeMeta
         - _forceStaffInPristineSlot: <= sin espacio
         - Bloques 15-18: & & -> &&
         - Todos los demas identificadores partidos y literales con trailing space

FIXES HEREDADOS v5010.9/v5010.8:
  CORE-08..CORE-17: sintaxis, suppressHooks, CitasF2 schema, enums frontera,
  ControlOperativo canonico, slot key 5 piezas, hasSome, ranking CMS, contrato
  retorno transaccion, CONTROL_TYPE.IDEMPOTENCY.
  CORE-18: _buildPairTokenDeterministic reexportado desde bookingUtils.
=============================================================================
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
    BOOKING_FIELDS,
    // CORE-20: contrato de persistencia de CitasF2 definido en internalConfig.
    // bookingCore reexporta bajo nombres historicos; NUNCA redefine.
    CITAS_BOOKING_STATUS,
    CITAS_PAYMENT_STATUS
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
    _normalizeLocalIsoStr
} from "public/mmUtils";
import {
    computeGapMinutes,
    getResourceIdsFromSlot,
    _buildPairFingerprint,
    _buildPairTokenDeterministic
} from "backend/booking/bookingUtils";

const log = logger;

const STAFF_RESOURCE_TYPE_ID = API.STAFF_RESOURCE_TYPE_ID;

// =============================================================================
// BLOQUE 1 - CODIGOS DE ERROR
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
    UNKNOWN_ERROR: "UNKNOWN_ERROR"
});

// =============================================================================
// BLOQUE 2 - ENUMS EN FRONTERA: WIX NATIVO <-> CMS PERSISTIDO (CORE-11/20)
// =============================================================================

/**
 * CORE-20: reexport del contrato canonico definido en internalConfig (BIBLIA §6.2).
 * Se conservan los nombres historicos CMS_BOOKING_STATUS y CMS_PAYMENT_STATUS
 * porque bookingSaga, citasManager y los tests los consumen.
 * Cero duplicacion: una sola fuente de verdad (BIBLIA §0.5.1).
 */
export const CMS_BOOKING_STATUS = CITAS_BOOKING_STATUS;
export const CMS_PAYMENT_STATUS = CITAS_PAYMENT_STATUS;

/**
 * Traduccion hacia el enum persistido. Claves: enum nativo Wix (BIBLIA §6.1)
 * mas alias ES tolerados SOLO en entrada (Matriz §2).
 */
const WIX_TO_CMS_BOOKING_STATUS = Object.freeze({
    CREATED: CITAS_BOOKING_STATUS.PENDING,
    PENDING: CITAS_BOOKING_STATUS.PENDING,
    WAITING_LIST: CITAS_BOOKING_STATUS.PENDING,
    CONFIRMED: CITAS_BOOKING_STATUS.CONFIRMED,
    UPDATED: CITAS_BOOKING_STATUS.CONFIRMED,
    COMPLETED: CITAS_BOOKING_STATUS.COMPLETED,
    CANCELED: CITAS_BOOKING_STATUS.CANCELLED,
    CANCELLED: CITAS_BOOKING_STATUS.CANCELLED,
    DECLINED: CITAS_BOOKING_STATUS.CANCELLED,
    REFUNDED: CITAS_BOOKING_STATUS.CANCELLED,
    NO_SHOW: CITAS_BOOKING_STATUS.NO_SHOW,
    NOSHOW: CITAS_BOOKING_STATUS.NO_SHOW,
    PENDIENTE: CITAS_BOOKING_STATUS.PENDING,
    CONFIRMADO: CITAS_BOOKING_STATUS.CONFIRMED,
    COMPLETADO: CITAS_BOOKING_STATUS.COMPLETED,
    CANCELADO: CITAS_BOOKING_STATUS.CANCELLED,
    REEMBOLSADO: CITAS_BOOKING_STATUS.CANCELLED,
    NO_PRESENTADO: CITAS_BOOKING_STATUS.NO_SHOW
});

const WIX_TO_CMS_PAYMENT_STATUS = Object.freeze({
    UNDEFINED: CITAS_PAYMENT_STATUS.UNPAID,
    NOT_PAID: CITAS_PAYMENT_STATUS.UNPAID,
    PENDING_PAYMENT: CITAS_PAYMENT_STATUS.UNPAID,
    PENDING_LEDGER: CITAS_PAYMENT_STATUS.UNPAID,
    UNPAID: CITAS_PAYMENT_STATUS.UNPAID,
    PAID: CITAS_PAYMENT_STATUS.PAID,
    EXEMPT: CITAS_PAYMENT_STATUS.PAID,
    PARTIALLY_PAID: CITAS_PAYMENT_STATUS.PARTIAL,
    PARTIALLY_REFUNDED: CITAS_PAYMENT_STATUS.PARTIAL,
    PARTIAL: CITAS_PAYMENT_STATUS.PARTIAL,
    REFUNDED: CITAS_PAYMENT_STATUS.REFUNDED,
    IMPAGADO: CITAS_PAYMENT_STATUS.UNPAID,
    NO_PAGADO: CITAS_PAYMENT_STATUS.UNPAID,
    PENDIENTE_PAGO: CITAS_PAYMENT_STATUS.UNPAID,
    PAGADO: CITAS_PAYMENT_STATUS.PAID,
    PARCIALMENTE_PAGADO: CITAS_PAYMENT_STATUS.PARTIAL,
    REEMBOLSADO_PARCIAL: CITAS_PAYMENT_STATUS.PARTIAL,
    REEMBOLSADO: CITAS_PAYMENT_STATUS.REFUNDED,
    EXENTO: CITAS_PAYMENT_STATUS.PAID
});

/** Devuelve "" ante valor desconocido: assertValidEnum falla de forma explicita. */
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

/**
 * CORE-06: mapa inverso para la API de Wix. bookingSaga envia el SSOT espanol
 * y Wix solo acepta su enum nativo EN. Valores ya nativos pasan sin cambio.
 */
const WIX_NATIVE_PAYMENT_STATUS = Object.freeze({
    UNDEFINED: PAYMENT_STATUS.UNDEFINED,
    NOT_PAID: PAYMENT_STATUS.NOT_PAID,
    PENDING_PAYMENT: PAYMENT_STATUS.PENDING_PAYMENT,
    PENDING_LEDGER: PAYMENT_STATUS.PENDING_LEDGER,
    PAID: PAYMENT_STATUS.PAID,
    PARTIALLY_PAID: PAYMENT_STATUS.PARTIALLY_PAID,
    REFUNDED: PAYMENT_STATUS.REFUNDED,
    PARTIALLY_REFUNDED: PAYMENT_STATUS.PARTIALLY_REFUNDED,
    EXEMPT: PAYMENT_STATUS.EXEMPT,
    IMPAGADO: PAYMENT_STATUS.NOT_PAID,
    NO_PAGADO: PAYMENT_STATUS.NOT_PAID,
    UNPAID: PAYMENT_STATUS.NOT_PAID,
    PAGADO: PAYMENT_STATUS.PAID,
    PARCIALMENTE_PAGADO: PAYMENT_STATUS.PARTIALLY_PAID,
    PARTIAL: PAYMENT_STATUS.PARTIALLY_PAID,
    REEMBOLSADO: PAYMENT_STATUS.REFUNDED,
    REEMBOLSADO_PARCIAL: PAYMENT_STATUS.PARTIALLY_REFUNDED,
    EXENTO: PAYMENT_STATUS.EXEMPT
});

function _toWixNativePaymentStatus(value) {
    const v = _safeTrim(value).toUpperCase();
    if (!v) return value;
    return WIX_NATIVE_PAYMENT_STATUS[v] || value;
}

/** Estado por defecto cuando el llamante no lo fija. */
function _deriveCmsBookingStatus(cmsPaymentStatus) {
    return cmsPaymentStatus === CITAS_PAYMENT_STATUS.UNPAID
        ? CITAS_BOOKING_STATUS.PENDING
        : CITAS_BOOKING_STATUS.CONFIRMED;
}

// =============================================================================
// BLOQUE 3 - ELEVATED PROXIES (Bookings V2 + eCommerce)
// =============================================================================
export const cancelBookingElevated = auth.elevate(bookings.cancelBooking);
export const createCheckoutElevated = auth.elevate(checkout.createCheckout);
export const getCheckoutUrlElevated = auth.elevate(checkout.getCheckoutUrl);

const _confirmOrDeclineElevatedRaw = auth.elevate(bookings.confirmOrDeclineBooking);

/**
 * CORE-06: wrapper elevado que traduce paymentStatus del SSOT al enum nativo
 * que acepta Wix Bookings. Contrato: (bookingId, options) -> respuesta elevada.
 */
export async function confirmOrDeclineBookingElevated(bookingId, options) {
    let normalizedOptions = options;
    if (options && typeof options === "object" && options.paymentStatus !== undefined) {
        const translated = _toWixNativePaymentStatus(options.paymentStatus);
        if (translated !== options.paymentStatus) {
            log.info("CORE-06: paymentStatus translated SSOT -> Wix native", {
                bookingId: _safeTrim(bookingId),
                from: options.paymentStatus,
                to: translated
            });
        }
        normalizedOptions = Object.assign({}, options, { paymentStatus: translated });
    }
    return _confirmOrDeclineElevatedRaw(bookingId, normalizedOptions);
}

export { logger };

// =============================================================================
// BLOQUE 4 - BOOKINGERROR Y NORMALIZACION DE ERRORES
// =============================================================================
export class BookingError extends Error {
    constructor(code, message, details) {
        super(String(message || "Unknown error"));
        this.name = "BookingError";
        this.code = String(code || ERROR_CODES.UNKNOWN_ERROR);
        this.details = (details && typeof details === "object") ? details : { details: details };
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
            details: err.details || {}
        };
    }
    if (err instanceof Error) {
        return {
            code: String(err.code || err.errorCode || err.name || ERROR_CODES.UNKNOWN_ERROR),
            message: String(err.message || "Unknown error"),
            stack: err.stack || null,
            details: (err.details && typeof err.details === "object") ? err.details : {}
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
            details: {}
        };
    }
    return { code: ERROR_CODES.UNKNOWN_ERROR, message: "Unknown error", stack: null, details: {} };
}

export function _handleError(error, context, traceId, logFn) {
    const loggerInstance = logFn || log;
    const norm = normalizeError(error);
    loggerInstance.error("[" + context + "] " + norm.code + ": " + norm.message, {
        traceId: traceId,
        details: norm.details
    });
    return {
        status: "ERROR",
        data: null,
        error: {
            code: norm.code || ERROR_CODES.UNKNOWN_ERROR,
            message: norm.message || "Unknown error"
        }
    };
}

// =============================================================================
// BLOQUE 5 - HELPERS COMPARTIDOS DE BAJO NIVEL
// =============================================================================

function _parsePayloadJson(text) {
    const raw = _safeTrim(text);
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw);
        return (parsed && typeof parsed === "object" && !Array.isArray(parsed)) ? parsed : {};
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
// BLOQUE 6 - RESOLUCION DE SCHEDULEID
// =============================================================================
async function _resolveScheduleIdByResourceId(resourceId) {
    const id = _safeTrim(resourceId);
    if (!id || !_looksLikeGuid(id)) return null;
    const scheduleId = await getStaffScheduleId(id);
    return (scheduleId && _looksLikeGuid(scheduleId)) ? scheduleId : null;
}

export async function _resolveScheduleIdForResource(resourceId, sourceSlot) {
    const resourceIdClean = _safeTrim(resourceId);
    if (!resourceIdClean || !_looksLikeGuid(resourceIdClean)) return null;
    const s = (sourceSlot && typeof sourceSlot === "object") ? sourceSlot : {};
    const nestedSlot = (s.slot && typeof s.slot === "object") ? s.slot : {};
    const schedule = (s.schedule && typeof s.schedule === "object") ? s.schedule : {};
    const resource = (s.resource && typeof s.resource === "object") ? s.resource : {};

    let scheduleId = _safeTrim(
        s.scheduleId || nestedSlot.scheduleId || schedule.id || resource.scheduleId
    );
    if (scheduleId && _looksLikeGuid(scheduleId)) return scheduleId;

    scheduleId = await _resolveScheduleIdByResourceId(resourceIdClean);
    return scheduleId || null;
}

// =============================================================================
// BLOQUE 7 - NORMALIZACION DE SLOTS PARA WRITER V2 (CORE-02, CORE-04)
// =============================================================================

function _extractAddonIdsFromSlot(slot) {
    const source = (slot && typeof slot === "object") ? slot : {};
    const customerChoices = (source.customerChoices && typeof source.customerChoices === "object")
        ? source.customerChoices
        : {};
    const candidates = [].concat(
        Array.isArray(source.addOnIds) ? source.addOnIds : [],
        Array.isArray(source.selectedAddOns) ? source.selectedAddOns : [],
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

const CONFIGURED_LOCATION_ID = _safeTrim(SDK_CONFIG && SDK_CONFIG.LOCATION_ID);

/**
 * Construye el objeto bookingInfo que exige Bookings Writer V2 (BIBLIA 2.2.1/3.3):
 * timezone minusculas, locationType OWNER_BUSINESS. Null ante dato no certificable.
 */
export async function _forceStaffInPristineSlot(slot, resourceId, serviceIdOverride, defaultDurationMinutes) {
    if (!slot || typeof slot !== "object") return null;

    const serviceId = _safeTrim(serviceIdOverride || slot.serviceId);
    if (!serviceId || !_looksLikeGuid(serviceId)) {
        log.error("_forceStaffInPristineSlot: invalid serviceId", { serviceId: serviceId });
        return null;
    }

    const resourceCandidate = (slot.resource && typeof slot.resource === "object") ? slot.resource : {};
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
        log.error("_forceStaffInPristineSlot: invalid date range", {
            localStartDate: localStartDate,
            localEndDate: localEndDate,
            resourceId: resourceIdClean,
            serviceId: serviceId
        });
        return null;
    }

    const slotLocation = (slot.location && typeof slot.location === "object") ? slot.location : {};
    const incomingLocationId = _safeTrim(slotLocation.id);
    if (incomingLocationId && CONFIGURED_LOCATION_ID && incomingLocationId !== CONFIGURED_LOCATION_ID) {
        log.error("_forceStaffInPristineSlot: location conflict", {
            slotLocationId: incomingLocationId,
            configuredLocationId: CONFIGURED_LOCATION_ID,
            serviceId: serviceId
        });
        return null;
    }

    const locationId = CONFIGURED_LOCATION_ID || incomingLocationId;
    if (!locationId || !_looksLikeGuid(locationId)) {
        log.error("_forceStaffInPristineSlot: missing or invalid LOCATION_ID", {
            configuredLocationId: CONFIGURED_LOCATION_ID,
            incomingLocationId: incomingLocationId
        });
        return null;
    }

    let locationType = _safeTrim(
        SDK_CONFIG && SDK_CONFIG.LOCATION_TYPES && SDK_CONFIG.LOCATION_TYPES.BOOKINGS_WRITER
    );
    if (!locationType || locationType === "BUSINESS") locationType = "OWNER_BUSINESS";

    const result = {
        serviceId: serviceId,
        scheduleId: scheduleId,
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
        timezone: _safeTrim(SDK_CONFIG && SDK_CONFIG.TZ) || "Europe/Madrid",
        resource: { id: resourceIdClean },
        location: { id: locationId, locationType: locationType }
    };

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
    const nested = (checkoutSession.checkout && typeof checkoutSession.checkout === "object")
        ? checkoutSession.checkout
        : {};
    return _safeTrim(nested._id) || _safeTrim(checkoutSession._id) || null;
}

// =============================================================================
// BLOQUE 9 - SLOT KEYS (CORE-13)
// =============================================================================

export function generateSlotKey(serviceId, resourceId, startDate, endDate) {
    const startUtc = (startDate instanceof Date)
        ? startDate
        : getUtcDateFromMadridLocal(_normalizeLocalIsoStr(startDate));
    const endUtc = (endDate instanceof Date)
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
        .filter(function (key) { return Boolean(key); });
    return Array.from(new Set(keys)).sort();
}

// =============================================================================
// BLOQUE 10 - MUTEX LOCKS EN ControlOperativo (SLOT_LOCK)
// =============================================================================
const MUTEX_TTL_MS = Number(CONCURRENCY && CONCURRENCY.MS_TTL_MUTEX);
if (!Number.isFinite(MUTEX_TTL_MS) || MUTEX_TTL_MS <= 0) {
    throw new Error("MS_TTL_MUTEX must be positive");
}

const LOCKS_COL = OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO;

export function safeLockId(key) {
    const k = _safeTrim(key);
    if (!k) return "";
    return "lk" + _hashKey(k) + k.slice(0, 24);
}

export function _buildSlotLockControl(slotClave, lockOwnerId, ttlMs, existing) {
    const resourceId = _parseResourceIdFromSlotKey(slotClave);
    const ttl = Number(ttlMs);
    return {
        _id: safeLockId(slotClave),
        controlType: CONTROL_TYPE.SLOT_LOCK,
        dedupeKey: String(slotClave),
        resourceId: resourceId,
        expiresAt: new Date(Date.now() + (Number.isFinite(ttl) && ttl > 0 ? ttl : MUTEX_TTL_MS)),
        payloadJson: JSON.stringify({
            lockOwnerId: String(lockOwnerId || ""),
            lockStatus: "ACTIVE"
        }),
        traceId: _safeTrim(existing && existing.traceId) || makeTraceId("lock")
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
            error: error && error.message
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
// BLOQUE 11 - TRANSACCIONES IDEMPOTENTES EN ControlOperativo
// =============================================================================
const TRANSACTIONS_COL = OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO;
const TX_DEDUPE_PREFIX = "TX_";
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
        result: (payload.result !== undefined) ? payload.result : doc.result
    };
}

function _extractBookingIdFromResult(result) {
    if (!result || typeof result !== "object") return "";
    const direct = _safeTrim(result.bookingId);
    if (direct) return direct;
    const nested = (result.data && typeof result.data === "object") ? result.data : {};
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
            makeTraceId("tx")
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
                error: error && error.message
            });
        }
    }
}

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
        ownerTraceId: String(traceId || "")
    };

    try {
        await wixData.insert(TRANSACTIONS_COL, _buildTransactionControl(id, state, null));
        return { success: true, isNew: true };
    } catch (error) {
        if (!_isDuplicateItemError(error)) {
            log.error("_initTransaction: insert failed", {
                pairToken: id,
                error: error && error.message
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
            Math.floor(
                TRANSACTION_POLL_BASE_MS *
                Math.pow(2, Math.min(pollAttempt, 3)) *
                (0.5 + Math.random())
            ),
            remainingMs
        );
        if (delay <= 0) break;
        pollAttempt += 1;
        await new Promise(function (resolve) { setTimeout(resolve, delay); });
    }

    const finalState = _readTransaction(await _getTransactionById(id));
    return _evaluatePendingTransaction(finalState, payloadHash) || {
        success: false,
        error: ERROR_CODES.TRANSACTION_TIMEOUT,
        existing: finalState,
        timeout: true
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
        result: (result === undefined) ? null : result
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
        error: String(errorMessage || ERROR_CODES.UNKNOWN_ERROR)
    }, current ? current.doc : null);
}

// =============================================================================
// BLOQUE 12 - PERSISTENCIA EN CITAS_F2 (CORE-09/10/11)
// =============================================================================
const CITAS_COL = BUSINESS_COLLECTIONS.CITAS_F2;

function _minimizeContactDetails(contactDetails) {
    const cd = (contactDetails && typeof contactDetails === "object") ? contactDetails : {};
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
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "Missing required fields for persistBooking",
            { traceId: traceIdClean, bookingId: bookingId }
        );
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
        throw createBookingError(
            ERROR_CODES.INVALID_DATES,
            "Invalid startDate/endDate for persistBooking",
            { traceId: traceIdClean, bookingId: bookingId }
        );
    }

    const startLocal = getMadridLocalStringNoZ(startDateObj);
    const dateYmd = startLocal ? startLocal.slice(0, 10) : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateYmd)) {
        throw createBookingError(
            ERROR_CODES.INVALID_DATES,
            "Cannot derive dateYmd (Europe/Madrid) from slotStart",
            { traceId: traceIdClean, bookingId: bookingId, startLocal: startLocal }
        );
    }

    const bookingType = normalizeBookingType(p.bookingType || p.tipo);
    const pairToken = _safeTrim(p.pairToken || (p.meta && p.meta.pairToken));
    if (isDualBookingType(bookingType) && !pairToken) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "Missing pairToken for linked booking",
            { traceId: traceIdClean, bookingId: bookingId, bookingType: bookingType }
        );
    }

    const metaObj = (p.meta && typeof p.meta === "object") ? p.meta : {};
    const rawPayment = (p.paymentStatus !== undefined)
        ? p.paymentStatus
        : ((metaObj.paymentStatus !== undefined) ? metaObj.paymentStatus : PAYMENT_STATUS.NOT_PAID);
    const paymentStatus = _toCmsPaymentStatus(rawPayment);
    const rawBookingStatus = (p.bookingStatus !== undefined) ? p.bookingStatus : p.status;
    const bookingStatus = _toCmsBookingStatus(rawBookingStatus) || _deriveCmsBookingStatus(paymentStatus);
    assertValidEnum(bookingStatus, CITAS_BOOKING_STATUS, "bookingStatus");
    assertValidEnum(paymentStatus, CITAS_PAYMENT_STATUS, "paymentStatus");

    const thirdPartyId = _safeTrim(p.thirdPartyId || metaObj.thirdPartyId);
    if (!thirdPartyId) {
        log.warn("CitasF2 persisted without thirdPartyId (ADR pendiente)", {
            traceId: traceIdClean,
            bookingId: bookingId
        });
    }

    const catalogId = _safeTrim(p.catalogId) || serviceId;
    const totalAmount = _roundMoney(Number(
        (p.totalAmount !== undefined) ? p.totalAmount : (metaObj.totalAmount || 0)
    ) || 0);

    const doc = {
        bookingId: bookingId,
        pairToken: pairToken,
        catalogId: catalogId,
        serviceId: serviceId,
        scheduleId: scheduleIdClean,
        resourceId: resourceId,
        thirdPartyId: thirdPartyId,
        dateYmd: dateYmd,
        slotStart: startDateObj,
        slotEnd: endDateObj,
        bookingType: bookingType,
        revision: Number(p.revision) || 1,
        [BOOKING_FIELDS.STATUS]: bookingStatus,
        paymentStatus: paymentStatus,
        totalAmount: totalAmount,
        contactDetails: _minimizeContactDetails(p.contactDetails),
        meta: _normalizeMeta(p.meta, {
            bookingStatus: bookingStatus,
            paymentStatus: paymentStatus
        }),
        traceId: traceIdClean
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
                traceId: traceIdClean
            });
        }
        const updated = Object.assign({}, existingDoc, doc);
        delete updated._createdDate;
        delete updated._updatedDate;
        delete updated._owner;
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
        const cita = (res && Array.isArray(res.items)) ? res.items[0] : null;
        if (!cita) {
            log.warn("_updateCitaSafe: cita not found", {
                bookingId: bid,
                operation: operation,
                traceId: traceId
            });
            return { updated: false, reason: "NOT_FOUND" };
        }

        const updated = updater(cita);
        if (!updated) return { updated: false, reason: "NO_CHANGE" };

        const rawStatus = (updated.bookingStatus !== undefined) ? updated.bookingStatus : updated.status;
        const nextBookingStatus = _toCmsBookingStatus(rawStatus) || cita.bookingStatus;
        const nextPaymentStatus = _toCmsPaymentStatus(updated.paymentStatus) || cita.paymentStatus;
        assertValidEnum(nextBookingStatus, CITAS_BOOKING_STATUS, "bookingStatus");
        assertValidEnum(nextPaymentStatus, CITAS_PAYMENT_STATUS, "paymentStatus");

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
            error: err && err.message
        });
        return { updated: false, reason: "ERROR", error: err && err.message };
    }
}

// =============================================================================
// BLOQUE 14 - EXTRACCION DE RESOURCEIDS DESDE SLOTS (CORE-01)
// =============================================================================
export function _extractResourceIdsFromSlot(slot) {
    return getResourceIdsFromSlot(slot, STAFF_RESOURCE_TYPE_ID);
}

// =============================================================================
// BLOQUE 15 - VERIFICACION DE CONTIGUIDAD / GAP ENTRE SLOTS
// =============================================================================
export function _areSlotsContiguous(slot1, slot2, maxGapMinutes) {
    if (!slot1 || !slot2) return false;

    const fallbackTolerance = Number(SLOT_SEARCH && SLOT_SEARCH.MINUTOS_TOLERANCIA);
    const maxGap = (maxGapMinutes === null || maxGapMinutes === undefined)
        ? (Number.isFinite(fallbackTolerance) ? fallbackTolerance : 120)
        : Number(maxGapMinutes);

    const end1 = slot1.localEndDate || slot1.endDate;
    const start2 = slot2.localStartDate || slot2.startDate;
    if (!end1 || !start2) return false;

    const end1Utc = (end1 instanceof Date) ? end1 : getUtcDateFromMadridLocal(_normalizeLocalIsoStr(end1));
    const start2Utc = (start2 instanceof Date) ? start2 : getUtcDateFromMadridLocal(_normalizeLocalIsoStr(start2));
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

    const resourceCandidate = (slot.resource && typeof slot.resource === "object") ? slot.resource : {};
    const resourceIdClean = _safeTrim(resourceId || slot.resourceId || resourceCandidate.id);
    if (!resourceIdClean || !_looksLikeGuid(resourceIdClean)) return null;

    const localStartDate = _normalizeLocalIsoStr(slot.localStartDate || slot.startDate);
    const localEndDate = _normalizeLocalIsoStr(slot.localEndDate || slot.endDate);
    if (!localStartDate || !localEndDate) return null;

    const startDateUtc = getUtcDateFromMadridLocal(localStartDate);
    const endDateUtc = getUtcDateFromMadridLocal(localEndDate);
    if (!startDateUtc || !endDateUtc || endDateUtc.getTime() <= startDateUtc.getTime()) return null;

    const slotLocation = (slot.location && typeof slot.location === "object") ? slot.location : {};
    const slotLocationId = _safeTrim(slotLocation.id);
    if (slotLocationId && CONFIGURED_LOCATION_ID && slotLocationId !== CONFIGURED_LOCATION_ID) {
        log.warn("_projectCertifiedSlot: location mismatch", {
            slotLocationId: slotLocationId,
            configuredLocationId: CONFIGURED_LOCATION_ID,
            serviceId: serviceId
        });
        return null;
    }

    const locationId = slotLocationId || CONFIGURED_LOCATION_ID;
    if (!locationId || !_looksLikeGuid(locationId)) {
        log.warn("_projectCertifiedSlot: missing or invalid locationId", {
            slotLocationId: slotLocationId,
            configuredLocationId: CONFIGURED_LOCATION_ID,
            serviceId: serviceId
        });
        return null;
    }

    const nestedSlot = (slot.slot && typeof slot.slot === "object") ? slot.slot : {};
    return {
        serviceId: serviceId,
        resourceId: resourceIdClean,
        scheduleId: _safeTrim(slot.scheduleId || nestedSlot.scheduleId),
        localStartDate: localStartDate,
        localEndDate: localEndDate,
        startDate: startDateUtc,
        endDate: endDateUtc,
        bookable: slot.bookable === true,
        availableResources: _extractResourceIdsFromSlot(slot),
        timezone: _safeTrim(SDK_CONFIG && SDK_CONFIG.TZ) || "Europe/Madrid",
        locationId: locationId,
        locationName: _safeTrim(slotLocation.name),
        formattedAddress: _safeTrim(slotLocation.formattedAddress)
    };
}

export function _projectWriterSlotFromAvailability(slot, resourceId, serviceId) {
    const projected = _projectCertifiedSlot(slot, resourceId);
    if (!projected) return null;

    const finalServiceId = _safeTrim(serviceId) || projected.serviceId;
    if (!finalServiceId || !_looksLikeGuid(finalServiceId)) return null;

    const nestedSlot = (slot.slot && typeof slot.slot === "object") ? slot.slot : {};
    const scheduleId = _safeTrim(
        projected.scheduleId || slot.scheduleId || nestedSlot.scheduleId
    );
    if (!scheduleId || !_looksLikeGuid(scheduleId)) {
        log.warn("_projectWriterSlotFromAvailability: missing or invalid scheduleId", {
            serviceId: finalServiceId,
            scheduleIdRaw: projected.scheduleId || null
        });
        return null;
    }

    let writerLocationType = _safeTrim(
        SDK_CONFIG && SDK_CONFIG.LOCATION_TYPES && SDK_CONFIG.LOCATION_TYPES.BOOKINGS_WRITER
    );
    if (!writerLocationType || writerLocationType === "BUSINESS") writerLocationType = "OWNER_BUSINESS";

    const writerSlot = {
        serviceId: finalServiceId,
        scheduleId: scheduleId,
        startDate: projected.startDate,
        endDate: projected.endDate,
        timezone: projected.timezone,
        resource: { id: projected.resourceId },
        location: { id: projected.locationId, locationType: writerLocationType }
    };

    const addOnIds = _extractAddonIdsFromSlot(slot);
    if (addOnIds.length > 0) {
        writerSlot.addOnIds = addOnIds.slice();
        writerSlot.selectedAddOns = addOnIds.slice();
    }
    return writerSlot;
}

// =============================================================================
// BLOQUE 17 - PAIR TOKEN CANONICO (CORE-05 + CORE-18)
// =============================================================================
/**
 * CORE-18: definicion canonica en bookingUtils. Aqui solo se reexporta.
 * Cero duplicacion (BIBLIA §0.5.1).
 */
export { _buildPairFingerprint, _buildPairTokenDeterministic };

// =============================================================================
// BLOQUE 18 - RANKING DE RECURSOS POR CARGA (CORE-14, CORE-15)
// =============================================================================
export async function _rankResourcesByLoad(resourceIds, dateYmd, traceId) {
    const input = Array.isArray(resourceIds)
        ? Array.from(new Set(
            resourceIds
                .map(function (id) { return _safeTrim(id); })
                .filter(_looksLikeGuid)
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
            const result = await wixData
                .query(CITAS_COL)
                .eq("dateYmd", day)
                .hasSome("resourceId", input)
                .limit(pageSize)
                .skip(skip)
                .find({ consistentRead: true });

            const items = (result && Array.isArray(result.items)) ? result.items : [];
            for (let i = 0; i < items.length; i += 1) {
                const item = items[i];
                const itemResourceId = _safeTrim(item && item.resourceId);
                if (!loads[itemResourceId]) continue;

                const status = _toCmsBookingStatus((item && (item.bookingStatus || item.status)) || "");
                const payment = _toCmsPaymentStatus((item && item.paymentStatus) || "");
                const inactive = (status === CITAS_BOOKING_STATUS.CANCELLED) ||
                    (status === CITAS_BOOKING_STATUS.NO_SHOW);
                const refunded = payment === CITAS_PAYMENT_STATUS.REFUNDED;
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
            error: error && error.message
        });
        return input;
    }
}
