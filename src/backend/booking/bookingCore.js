/*
MODULE: backend/booking/bookingCore.js
VERSION: v5010.9-PARSE-FIX
BASE: v5010.8-LOCK-PARSER-FIX + PARSE ERROR FIXES
STANDARDS: G10 ASCII Strict. Cero suppressHooks/suppressAuth en dataLegacyAdapter.
FIX v5010.9: Corrige error de parsing en linea 582 (MSTTLMUTEX -> MS_TTL_MUTEX)
             y restaura integridad sintactica completa del modulo.
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

const STAFF_RESOURCE_TYPE_ID = API.STAFF_RESOURCE_TYPE_ID;

export { _buildPairFingerprint };

const CONFIGURED_LOCATION_ID = _safeTrim(SDK_CONFIG.LOCATION_ID);

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
    UNKNOWN_ERROR: "UNKNOWN_ERROR",
});

// =============================================================================
// BLOQUE 2 - ENUMS: FRONTERA WIX NATIVO <-> CMS PERSISTIDO (CORE-11)
// =============================================================================
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

export function _toCmsBookingStatus(value) {
    var v = _safeTrim(value).toUpperCase();
    if (!v) return "";
    return WIX_TO_CMS_BOOKING_STATUS[v] || "";
}

export function _toCmsPaymentStatus(value) {
    var v = _safeTrim(value).toUpperCase();
    if (!v) return "";
    return WIX_TO_CMS_PAYMENT_STATUS[v] || "";
}

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
    var v = _safeTrim(value).toUpperCase();
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
export const cancelBookingElevated = auth.elevate(bookings.cancelBooking);
export const createCheckoutElevated = auth.elevate(checkout.createCheckout);
export const getCheckoutUrlElevated = auth.elevate(checkout.getCheckoutUrl);

var _confirmOrDeclineElevatedRaw = auth.elevate(bookings.confirmOrDeclineBooking);

export async function confirmOrDeclineBookingElevated(bookingId, options) {
    var normalizedOptions = options;
    if (options && typeof options === "object" && options.paymentStatus !== undefined) {
        var translated = _toWixNativePaymentStatus(options.paymentStatus);
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

export { logger };

// =============================================================================
// BLOQUE 4 - CLASE BOOKINGERROR Y NORMALIZACION DE ERRORES
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

export function _handleError(error, context, traceId, logFn) {
    var loggerInstance = logFn || log;
    var norm = normalizeError(error);
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
function _parsePayloadJson(text) {
    var raw = _safeTrim(text);
    if (!raw) return {};
    try {
        var parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (_) {
        return {};
    }
}

function _isDuplicateItemError(error) {
    var message = String((error && error.message) || "").toLowerCase();
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
    var id = _safeTrim(resourceId);
    if (!id || !_looksLikeGuid(id)) return null;
    var scheduleId = await getStaffScheduleId(id);
    return scheduleId && _looksLikeGuid(scheduleId) ? scheduleId : null;
}

export async function _resolveScheduleIdForResource(resourceId, sourceSlot) {
    var resourceIdClean = _safeTrim(resourceId);
    if (!resourceIdClean || !_looksLikeGuid(resourceIdClean)) return null;
    var s = sourceSlot && typeof sourceSlot === "object" ? sourceSlot : {};
    var scheduleId = _safeTrim(
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
function _extractAddonIdsFromSlot(slot) {
    var customerChoices = slot && slot.customerChoices ? slot.customerChoices : {};
    var candidates = [].concat(
        Array.isArray(slot && slot.addOnIds) ? slot.addOnIds : [],
        Array.isArray(slot && slot.selectedAddOns) ? slot.selectedAddOns : [],
        Array.isArray(customerChoices.addOnIds) ? customerChoices.addOnIds : []
    );
    var clean = candidates
        .map(function (id) { return _safeTrim(id); })
        .filter(function (id) { return _looksLikeGuid(id); });
    return Array.from(new Set(clean));
}

function _toMadridLocalString(rawValue) {
    if (rawValue instanceof Date) {
        return isNaN(rawValue.getTime()) ? "" : getMadridLocalStringNoZ(rawValue);
    }
    if (typeof rawValue === "string") {
        var trimmed = _safeTrim(rawValue);
        if (!trimmed) return "";
        if (trimmed.endsWith("Z")) {
            var utcDt = new Date(trimmed);
            return isNaN(utcDt.getTime()) ? "" : getMadridLocalStringNoZ(utcDt);
        }
        return _normalizeLocalIsoStr(trimmed);
    }
    return "";
}

export async function _forceStaffInPristineSlot(slot, resourceId, serviceIdOverride, defaultDurationMinutes) {
    if (!slot || typeof slot !== "object") return null;

    var serviceId = _safeTrim(serviceIdOverride || slot.serviceId);
    if (!serviceId || !_looksLikeGuid(serviceId)) {
        log.error("_forceStaffInPristineSlot: invalid serviceId", { serviceId: serviceId });
        return null;
    }

    var resourceCandidate = slot.resource && typeof slot.resource === "object" ? slot.resource : {};
    var resourceIdClean = _safeTrim(resourceId || slot.resourceId || resourceCandidate.id);
    if (!resourceIdClean || !_looksLikeGuid(resourceIdClean)) {
        log.error("_forceStaffInPristineSlot: invalid resourceId", { resourceId: resourceIdClean });
        return null;
    }

    var scheduleId = await _resolveScheduleIdForResource(resourceIdClean, slot);
    if (!scheduleId) {
        log.error("_forceStaffInPristineSlot: missing scheduleId", { resourceId: resourceIdClean });
        return null;
    }

    var localStartDate = _toMadridLocalString(slot.localStartDate || slot.startDate);
    if (!localStartDate) return null;

    var localEndDate = _toMadridLocalString(slot.localEndDate || slot.endDate);
    if (!localEndDate) {
        var startUtc = getUtcDateFromMadridLocal(localStartDate);
        if (!startUtc) return null;
        var durationMin = Number(defaultDurationMinutes || (CONCURRENCY && CONCURRENCY.DEFAULT_DURATION_MIN) || 30);
        localEndDate = getMadridLocalStringNoZ(new Date(startUtc.getTime() + durationMin * 60 * 1000));
    }

    var startDate = getUtcDateFromMadridLocal(localStartDate);
    var endDate = getUtcDateFromMadridLocal(localEndDate);
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

    var slotLocation = slot.location && typeof slot.location === "object" ? slot.location : {};
    var incomingLocationId = _safeTrim(slotLocation.id);
    if (incomingLocationId && CONFIGURED_LOCATION_ID && incomingLocationId !== CONFIGURED_LOCATION_ID) {
        log.error("_forceStaffInPristineSlot: slot location conflicts with configured location", {
            slotLocationId: incomingLocationId,
            configuredLocationId: CONFIGURED_LOCATION_ID,
            serviceId: serviceId,
        });
        return null;
    }

    var locationId = CONFIGURED_LOCATION_ID || incomingLocationId;
    if (!locationId || !_looksLikeGuid(locationId)) {
        log.error("_forceStaffInPristineSlot: missing or invalid LOCATION_ID", {
            configuredLocationId: CONFIGURED_LOCATION_ID,
            incomingLocationId: incomingLocationId,
        });
        return null;
    }

    var locationType = _safeTrim(SDK_CONFIG.LOCATION_TYPES && SDK_CONFIG.LOCATION_TYPES.BOOKINGS_WRITER);
    if (!locationType || locationType === "BUSINESS") locationType = "OWNER_BUSINESS";

    var result = {
        serviceId: serviceId,
        scheduleId: scheduleId,
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
        timezone: _safeTrim(SDK_CONFIG.TZ) || "Europe/Madrid",
        resource: { id: resourceIdClean },
        location: { id: locationId, locationType: locationType },
    };

    var addOnIds = _extractAddonIdsFromSlot(slot);
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
    if (checkoutSession.checkout && checkoutSession.checkout._id) return checkoutSession.checkout._id;
    return checkoutSession._id || null;
}

// =============================================================================
// BLOQUE 9 - SLOT KEYS (CORE-13 + PATCH v5010.8)
// =============================================================================
export function generateSlotKey(serviceId, resourceId, startDate, endDate) {
    var startUtc = startDate instanceof Date
        ? startDate
        : getUtcDateFromMadridLocal(_normalizeLocalIsoStr(startDate));
    var endUtc = endDate instanceof Date
        ? endDate
        : getUtcDateFromMadridLocal(_normalizeLocalIsoStr(endDate));

    if (!startUtc || !endUtc || endUtc.getTime() <= startUtc.getTime()) {
        throw createBookingError(ERROR_CODES.INVALID_DATES, "Invalid slot dates for lock key");
    }

    var res = _safeTrim(resourceId);
    if (!res || !_looksLikeGuid(res)) {
        throw createBookingError(
            ERROR_CODES.LOCK_KEY_OR_OWNER_INVALID,
            "resourceId is required and must be a valid GUID to build a slot key"
        );
    }

    var svc = _safeTrim(serviceId);
    var servicePrefix = svc ? svc.slice(0, 8) : "srv";
    var startEpochMin = Math.floor(startUtc.getTime() / 60000);
    var endEpochMin = Math.floor(endUtc.getTime() / 60000);
    return "slot_" + servicePrefix + "_" + res + "_" + startEpochMin + "_" + endEpochMin;
}

export function _parseResourceIdFromSlotKey(slotKey) {
    var parts = String(slotKey || "").split("_");
    if (parts.length !== 5 || parts[0] !== "slot") return "";
    var servicePrefix = _safeTrim(parts[1]);
    var resourceId = _safeTrim(parts[2]);
    var startEpochMin = parts[3];
    var endEpochMin = parts[4];
    if (!servicePrefix) return "";
    if (!/^\d+$/.test(startEpochMin) || !/^\d+$/.test(endEpochMin)) return "";
    if (Number(endEpochMin) <= Number(startEpochMin)) return "";
    return _looksLikeGuid(resourceId) ? resourceId : "";
}

export function _buildLockKeys(phases, resourceId) {
    var keys = (Array.isArray(phases) ? phases : [])
        .map(function (phase) {
            var slot = (phase && phase.rawSlot) || {};
            try {
                return generateSlotKey(slot.serviceId, resourceId, phase && phase.localStart, phase && phase.localEnd);
            } catch (_) {
                return "";
            }
        })
        .filter(function (key) { return !!key; });
    return Array.from(new Set(keys)).sort();
}

// =============================================================================
// BLOQUE 10 - MUTEX LOCKS EN ControlOperativo (SLOT_LOCK) - CORE-09/12/13
// =============================================================================
// FIX v5010.9: Nombre de constante corregido (MSTTLMUTEX -> MS_TTL_MUTEX).
var MUTEX_TTL_MS = Number(CONCURRENCY && CONCURRENCY.MS_TTL_MUTEX);
if (!Number.isFinite(MUTEX_TTL_MS) || MUTEX_TTL_MS <= 0) {
    throw new Error("MS_TTL_MUTEX must be positive");
}

var LOCKS_COL = OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO;

export function safeLockId(key) {
    var k = _safeTrim(key);
    if (!k) return "";
    return "lk" + _hashKey(k) + k.slice(0, 24);
}

export function _buildSlotLockControl(slotClave, lockOwnerId, ttlMs, existing) {
    var resourceId = _parseResourceIdFromSlotKey(slotClave);
    var ttl = Number(ttlMs);
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
    var id = safeLockId(slotClave);
    if (!id) return null;
    var item = await wixData.get(LOCKS_COL, id, { consistentRead: true }).catch(function () { return null; });
    if (!item) return null;
    if (item.expiresAt) item.expiresAt = _toDateSafe(item.expiresAt);
    return item;
}

function _getLockOwnerId(lock) {
    if (!lock || typeof lock !== "object") return "";
    var payload = _parsePayloadJson(lock.payloadJson);
    return _safeTrim(payload.lockOwnerId) || _safeTrim(lock.lockOwnerId) || "";
}

export async function _lockSlotKeyOrFail(slotClave, lockOwnerId, ttlMs) {
    var k = _safeTrim(slotClave);
    var owner = _safeTrim(lockOwnerId);
    if (!k || !owner) return { ok: false, message: ERROR_CODES.LOCK_KEY_OR_OWNER_INVALID };
    if (!_parseResourceIdFromSlotKey(k)) return { ok: false, message: ERROR_CODES.LOCK_KEY_OR_OWNER_INVALID };

    try {
        await wixData.insert(LOCKS_COL, _buildSlotLockControl(k, owner, ttlMs));
        return { ok: true, acquired: true };
    } catch (error) {
        if (!_isDuplicateItemError(error)) {
            log.error("_lockSlotKeyOrFail failed", { slotClave: k, error: error && error.message });
            return { ok: false, message: (error && error.message) || ERROR_CODES.DATABASE_ERROR };
        }

        var existing = await _getLock(k);
        var currentOwner = _getLockOwnerId(existing);
        if (currentOwner && currentOwner === owner) {
            var renewed = await _renewLock(k, owner, ttlMs);
            return renewed.ok
                ? { ok: true, renewed: true }
                : { ok: false, message: ERROR_CODES.LOCK_RENEWAL_FAILED };
        }

        var expiresAt = _toDateSafe(existing && existing.expiresAt);
        var expired = expiresAt ? expiresAt.getTime() < Date.now() : false;
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
    var owner = _safeTrim(lockOwnerId);
    var existing = await _getLock(slotClave);
    if (!existing) return { ok: true, missing: true };
    var currentOwner = _getLockOwnerId(existing);
    if (!owner || currentOwner !== owner) return { ok: false, skipped: true };
    await wixData.remove(LOCKS_COL, existing._id).catch(function (error) {
        log.warn("_unlockSlotKey: remove failed", { slotClave: slotClave, error: error && error.message });
    });
    return { ok: true };
}

export async function _renewLock(slotClave, lockOwnerId, ttlMs) {
    var owner = _safeTrim(lockOwnerId);
    try {
        var existing = await _getLock(slotClave);
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
// BLOQUE 11 - TRANSACCIONES IDEMPOTENTES EN ControlOperativo - CORE-12/16/17
// =============================================================================
var TRANSACTIONS_COL = OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO;
var TX_DEDUPE_PREFIX = "TX_";
var TX_PAYLOAD_MAX_CHARS = 900;

var TRANSACTION_POLL_BASE_MS = Number(CONCURRENCY && CONCURRENCY.TRANSACTION_POLL_BASE_MS) || 250;
var TRANSACTION_MAX_WAIT_MS = Number(CONCURRENCY && CONCURRENCY.TRANSACTION_MAX_WAIT_MS) || 3000;

async function _getTransactionById(pairToken) {
    var id = _safeTrim(pairToken);
    if (!id) return null;
    return await wixData.get(TRANSACTIONS_COL, id, { consistentRead: true }).catch(function () { return null; });
}

function _readTransaction(doc) {
    if (!doc) return null;
    var payload = _parsePayloadJson(doc.payloadJson);
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
    var direct = _safeTrim(result.bookingId);
    if (direct) return direct;
    var nested = result.data && typeof result.data === "object" ? result.data : {};
    return _safeTrim(nested.bookingId);
}

function _buildTransactionControl(pairToken, state, existingDoc) {
    var payload = Object.assign({}, state);
    var payloadJson = JSON.stringify(payload);
    if (payloadJson.length > TX_PAYLOAD_MAX_CHARS) {
        delete payload.result;
        payload.resultDropped = true;
        payloadJson = JSON.stringify(payload);
    }
    var doc = {
        _id: String(pairToken),
        controlType: CONTROL_TYPE.IDEMPOTENCY,
        dedupeKey: TX_DEDUPE_PREFIX + String(pairToken),
        payloadJson: payloadJson,
        traceId: _safeTrim(existingDoc && existingDoc.traceId) ||
            _safeTrim(state.ownerTraceId) ||
            makeTraceId("tx"),
    };
    var bookingId = _safeTrim(payload.bookingId);
    if (bookingId) doc.bookingId = bookingId;
    return doc;
}

async function _writeTransaction(pairToken, state, existingDoc) {
    var doc = _buildTransactionControl(pairToken, state, existingDoc);
    try {
        if (existingDoc && existingDoc._id) await wixData.update(TRANSACTIONS_COL, doc);
        else await wixData.insert(TRANSACTIONS_COL, doc);
    } catch (error) {
        if (!_isDuplicateItemError(error)) {
            log.error("_writeTransaction failed", { pairToken: pairToken, error: error && error.message });
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
    var id = _safeTrim(pairToken);
    if (!id) return { success: false, error: "INVALID_PAIR_TOKEN" };

    var state = {
        status: "PENDING",
        payloadHash: String(payloadHash || ""),
        ownerTraceId: String(traceId || ""),
    };

    try {
        await wixData.insert(TRANSACTIONS_COL, _buildTransactionControl(id, state, null));
        return { success: true, isNew: true };
    } catch (error) {
        if (!_isDuplicateItemError(error)) {
            log.error("_initTransaction: insert failed", { pairToken: id, error: error && error.message });
            return { success: false, error: ERROR_CODES.DATABASE_ERROR };
        }
    }

    var startTime = Date.now();
    var pollAttempt = 0;
    while (Date.now() - startTime < TRANSACTION_MAX_WAIT_MS) {
        var verdict = _evaluatePendingTransaction(_readTransaction(await _getTransactionById(id)), payloadHash);
        if (verdict) return verdict;

        var remainingMs = TRANSACTION_MAX_WAIT_MS - (Date.now() - startTime);
        var delay = Math.min(
            Math.floor(TRANSACTION_POLL_BASE_MS * Math.pow(2, Math.min(pollAttempt, 3)) * (0.5 + Math.random())),
            remainingMs
        );
        if (delay <= 0) break;
        pollAttempt++;
        await new Promise(function (resolve) { setTimeout(resolve, delay); });
    }

    var finalState = _readTransaction(await _getTransactionById(id));
    return _evaluatePendingTransaction(finalState, payloadHash) || {
        success: false,
        error: ERROR_CODES.TRANSACTION_TIMEOUT,
        existing: finalState,
        timeout: true,
    };
}

export async function _completeTransaction(pairToken, result, traceId) {
    var id = _safeTrim(pairToken);
    if (!id) return;
    var current = _readTransaction(await _getTransactionById(id));
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
    var id = _safeTrim(pairToken);
    if (!id) return;
    var current = _readTransaction(await _getTransactionById(id));
    if (current && current.status === "COMPLETED") return;
    await _writeTransaction(id, {
        status: "FAILED",
        payloadHash: current ? current.payloadHash : "",
        ownerTraceId: current ? current.ownerTraceId : "",
        error: String(errorMessage || ERROR_CODES.UNKNOWN_ERROR),
    }, current ? current.doc : null);
}

// =============================================================================
// BLOQUE 12 - PERSISTENCIA EN CITAS_F2 (CORE-09/10/11)
// =============================================================================
var CITAS_COL = BUSINESS_COLLECTIONS.CITAS_F2;

function _minimizeContactDetails(contactDetails) {
    var cd = contactDetails && typeof contactDetails === "object" ? contactDetails : {};
    var out = {};
    var firstName = _safeTrim(cd.firstName || cd.first_name);
    var lastName = _safeTrim(cd.lastName || cd.last_name);
    var email = _safeTrim(cd.email);
    var phone = _safeTrim(cd.phone || cd.phoneNumber);
    if (firstName) out.firstName = firstName;
    if (lastName) out.lastName = lastName;
    if (email) out.email = email;
    if (phone) out.phone = phone;
    return out;
}

function _normalizeMeta(rawMeta, overrides) {
    var meta = rawMeta;
    if (typeof meta === "string") {
        try { meta = JSON.parse(meta); } catch (_) { meta = {}; }
    }
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) meta = {};
    return Object.assign({}, meta, overrides);
}

export async function _persistBooking(params, traceId) {
    var p = params || {};

    var traceIdClean = _safeTrim(traceId || p.traceId);
    if (!traceIdClean) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "traceId is required to persist a booking in CitasF2",
            { bookingId: _safeTrim(p.bookingId) }
        );
    }

    var bookingId = _safeTrim(p.bookingId);
    var serviceId = _safeTrim(p.serviceId);
    var resourceId = _safeTrim(p.resourceId);
    if (!bookingId || !serviceId || !resourceId || !p.startDate || !p.endDate) {
        throw createBookingError(ERROR_CODES.INVALID_PAYLOAD, "Missing required fields for persistBooking", {
            traceId: traceIdClean,
            bookingId: bookingId,
        });
    }

    var scheduleIdClean = _safeTrim(p.scheduleId);
    if (!scheduleIdClean || !_looksLikeGuid(scheduleIdClean)) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "scheduleId is required and must be a valid GUID for CitasF2 persistence",
            { traceId: traceIdClean, bookingId: bookingId, scheduleIdRaw: p.scheduleId }
        );
    }

    var startDateObj = _toDateSafe(p.startDate);
    var endDateObj = _toDateSafe(p.endDate);
    if (!startDateObj || !endDateObj || endDateObj.getTime() <= startDateObj.getTime()) {
        throw createBookingError(ERROR_CODES.INVALID_DATES, "Invalid startDate/endDate for persistBooking", {
            traceId: traceIdClean,
            bookingId: bookingId,
        });
    }

    var startLocal = getMadridLocalStringNoZ(startDateObj);
    var dateYmd = startLocal ? startLocal.slice(0, 10) : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateYmd)) {
        throw createBookingError(ERROR_CODES.INVALID_DATES, "Cannot derive dateYmd (Europe/Madrid) from slotStart", {
            traceId: traceIdClean,
            bookingId: bookingId,
            startLocal: startLocal,
        });
    }

    var bookingType = normalizeBookingType(p.bookingType || p.tipo);
    var pairToken = _safeTrim(p.pairToken || (p.meta && p.meta.pairToken));
    if (isDualBookingType(bookingType) && !pairToken) {
        throw createBookingError(ERROR_CODES.INVALID_PAYLOAD, "Missing pairToken for linked booking", {
            traceId: traceIdClean,
            bookingId: bookingId,
            bookingType: bookingType,
        });
    }

    var rawPayment = p.paymentStatus !== undefined
        ? p.paymentStatus
        : (p.meta && p.meta.paymentStatus !== undefined ? p.meta.paymentStatus : PAYMENT_STATUS.NOT_PAID);
    var paymentStatus = _toCmsPaymentStatus(rawPayment);
    var rawBookingStatus = p.bookingStatus !== undefined ? p.bookingStatus : p.status;
    var bookingStatus = _toCmsBookingStatus(rawBookingStatus) || _deriveCmsBookingStatus(paymentStatus);
    assertValidEnum(bookingStatus, CMS_BOOKING_STATUS, "bookingStatus");
    assertValidEnum(paymentStatus, CMS_PAYMENT_STATUS, "paymentStatus");

    var thirdPartyId = _safeTrim(p.thirdPartyId || (p.meta && p.meta.thirdPartyId));
    if (!thirdPartyId) {
        log.warn("CitasF2 persisted without thirdPartyId (ADR pendiente: ficha fiscal de cliente anonimo)", {
            traceId: traceIdClean,
            bookingId: bookingId,
        });
    }

    var catalogId = _safeTrim(p.catalogId) || serviceId;

    var doc = {
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
        totalAmount: _roundMoney(Number(p.totalAmount !== undefined
            ? p.totalAmount
            : ((p.meta && p.meta.totalAmount) || 0)) || 0),
        contactDetails: _minimizeContactDetails(p.contactDetails),
        meta: _normalizeMeta(p.meta, { bookingStatus: bookingStatus, paymentStatus: paymentStatus }),
        traceId: traceIdClean,
    };

    var existing = await wixData
        .query(CITAS_COL)
        .eq("bookingId", bookingId)
        .limit(1)
        .find({ consistentRead: true })
        .catch(function () { return null; });

    if (existing && Array.isArray(existing.items) && existing.items.length > 0) {
        var existingDoc = existing.items[0];
        var incomingRevision = Number(doc.revision) || 1;
        var currentRevision = Number(existingDoc.revision) || 1;
        if (incomingRevision < currentRevision) {
            throw new BookingError(ERROR_CODES.DATABASE_ERROR, "Booking revision conflict", {
                bookingId: bookingId,
                currentRevision: currentRevision,
                incomingRevision: incomingRevision,
                traceId: traceIdClean,
            });
        }
        var updated = Object.assign({}, existingDoc, doc);
        delete updated._createdDate;
        delete updated._updatedDate;
        delete updated._owner;
        delete updated.status;
        var item = await wixData.update(CITAS_COL, updated);
        return { created: false, item: item };
    }

    var item = await wixData.insert(CITAS_COL, doc);
    return { created: true, item: item };
}

// =============================================================================
// BLOQUE 13 - ACTUALIZACION SEGURA DE CITA (CORE-09/11)
// =============================================================================
export async function _updateCitaSafe(bookingId, updater, traceId, operation) {
    var bid = _safeTrim(bookingId);
    if (!bid) return { updated: false, reason: "INVALID_BOOKING_ID" };
    try {
        var res = await wixData
            .query(CITAS_COL)
            .eq("bookingId", bid)
            .limit(1)
            .find({ consistentRead: true });
        var cita = res && Array.isArray(res.items) ? res.items[0] : null;
        if (!cita) {
            log.warn("_updateCitaSafe: cita not found", { bookingId: bid, operation: operation, traceId: traceId });
            return { updated: false, reason: "NOT_FOUND" };
        }

        var updated = updater(cita);
        if (!updated) return { updated: false, reason: "NO_CHANGE" };

        var rawStatus = updated.bookingStatus !== undefined ? updated.bookingStatus : updated.status;
        var nextBookingStatus = _toCmsBookingStatus(rawStatus) || cita.bookingStatus;
        var nextPaymentStatus = _toCmsPaymentStatus(updated.paymentStatus) || cita.paymentStatus;
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
export function _extractResourceIdsFromSlot(slot) {
    return getResourceIdsFromSlot(slot, STAFF_RESOURCE_TYPE_ID);
}

// =============================================================================
// BLOQUE 15 - VERIFICACION DE CONTIGUIDAD / GAP ENTRE SLOTS
// =============================================================================
export function _areSlotsContiguous(slot1, slot2, maxGapMinutes) {
    if (!slot1 || !slot2) return false;

    var fallbackTolerance = Number(SLOT_SEARCH && SLOT_SEARCH.MINUTOS_TOLERANCIA);
    var maxGap = maxGapMinutes == null
        ? (Number.isFinite(fallbackTolerance) ? fallbackTolerance : 120)
        : Number(maxGapMinutes);

    var end1 = slot1.localEndDate || slot1.endDate;
    var start2 = slot2.localStartDate || slot2.startDate;
    if (!end1 || !start2) return false;

    var end1Utc = end1 instanceof Date ? end1 : getUtcDateFromMadridLocal(_normalizeLocalIsoStr(end1));
    var start2Utc = start2 instanceof Date ? start2 : getUtcDateFromMadridLocal(_normalizeLocalIsoStr(start2));
    if (!end1Utc || !start2Utc) return false;

    var rawDiffMinutes = (start2Utc.getTime() - end1Utc.getTime()) / 60000;
    if (rawDiffMinutes < -1) return false;
    return computeGapMinutes(end1Utc, start2Utc) <= maxGap;
}

// =============================================================================
// BLOQUE 16 - PROYECCION DE SLOTS CERTIFICADOS Y WRITER (CORE-03, CORE-04)
// =============================================================================
export function _projectCertifiedSlot(slot, resourceId) {
    if (!slot || typeof slot !== "object") return null;

    var serviceId = _safeTrim(slot.serviceId);
    if (!serviceId || !_looksLikeGuid(serviceId)) return null;

    var resourceCandidate = slot.resource && typeof slot.resource === "object" ? slot.resource : {};
    var resourceIdClean = _safeTrim(resourceId || slot.resourceId || resourceCandidate.id);
    if (!resourceIdClean || !_looksLikeGuid(resourceIdClean)) return null;

    var localStartDate = _normalizeLocalIsoStr(slot.localStartDate || slot.startDate);
    var localEndDate = _normalizeLocalIsoStr(slot.localEndDate || slot.endDate);
    if (!localStartDate || !localEndDate) return null;

    var startDateUtc = getUtcDateFromMadridLocal(localStartDate);
    var endDateUtc = getUtcDateFromMadridLocal(localEndDate);
    if (!startDateUtc || !endDateUtc || endDateUtc.getTime() <= startDateUtc.getTime()) return null;

    var slotLocation = slot.location && typeof slot.location === "object" ? slot.location : {};
    var slotLocationId = _safeTrim(slotLocation.id);
    if (slotLocationId && CONFIGURED_LOCATION_ID && slotLocationId !== CONFIGURED_LOCATION_ID) {
        log.warn("_projectCertifiedSlot: slot location does not match configured location", {
            slotLocationId: slotLocationId,
            configuredLocationId: CONFIGURED_LOCATION_ID,
            serviceId: serviceId,
        });
        return null;
    }

    var locationId = slotLocationId || CONFIGURED_LOCATION_ID;
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

export function _projectWriterSlotFromAvailability(slot, resourceId, serviceId) {
    var projected = _projectCertifiedSlot(slot, resourceId);
    if (!projected) return null;

    var finalServiceId = _safeTrim(serviceId) || projected.serviceId;
    if (!finalServiceId || !_looksLikeGuid(finalServiceId)) return null;

    var scheduleId = _safeTrim(
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

    var writerLocationType = _safeTrim(SDK_CONFIG.LOCATION_TYPES && SDK_CONFIG.LOCATION_TYPES.BOOKINGS_WRITER);
    if (!writerLocationType || writerLocationType === "BUSINESS") writerLocationType = "OWNER_BUSINESS";

    var writerSlot = {
        serviceId: finalServiceId,
        scheduleId: scheduleId,
        startDate: projected.startDate,
        endDate: projected.endDate,
        timezone: projected.timezone,
        resource: { id: projected.resourceId },
        location: { id: projected.locationId, locationType: writerLocationType },
    };

    var addOnIds = _extractAddonIdsFromSlot(slot);
    if (addOnIds.length > 0) {
        writerSlot.addOnIds = addOnIds.slice();
        writerSlot.selectedAddOns = addOnIds.slice();
    }
    return writerSlot;
}

// =============================================================================
// BLOQUE 17 - PAIR TOKEN CANONICO COMPARTIDO (CORE-05)
// =============================================================================
export function _buildPairTokenDeterministic(input) {
    return _hashKey(_buildPairFingerprint(input || {}));
}

// =============================================================================
// BLOQUE 18 - RANKING DE RECURSOS POR CARGA (CORE-14, CORE-15)
// =============================================================================
export async function _rankResourcesByLoad(resourceIds, dateYmd, traceId) {
    var input = Array.isArray(resourceIds)
        ? Array.from(new Set(
            resourceIds.map(function (id) { return _safeTrim(id); }).filter(_looksLikeGuid)
        ))
        : [];
    if (input.length < 2) return input;

    var day = _safeTrim(dateYmd);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
        log.warn("_rankResourcesByLoad: invalid dateYmd", { dateYmd: day, traceId: traceId });
        return input;
    }

    var loads = {};
    input.forEach(function (id, index) {
        loads[id] = { resourceId: id, load: 0, firstIndex: index };
    });

    try {
        var pageSize = 1000;
        var skip = 0;
        var hasMore = true;
        while (hasMore) {
            var result = await wixData
                .query(CITAS_COL)
                .eq("dateYmd", day)
                .hasSome("resourceId", input)
                .limit(pageSize)
                .skip(skip)
                .find({ consistentRead: true });

            var items = result && Array.isArray(result.items) ? result.items : [];
            for (var i = 0; i < items.length; i++) {
                var item = items[i];
                var itemResourceId = _safeTrim(item && item.resourceId);
                if (!loads[itemResourceId]) continue;

                var status = _toCmsBookingStatus((item && (item.bookingStatus || item.status)) || "");
                var payment = _toCmsPaymentStatus((item && item.paymentStatus) || "");
                var inactive = status === CMS_BOOKING_STATUS.CANCELLED || status === CMS_BOOKING_STATUS.NO_SHOW;
                var refunded = payment === CMS_PAYMENT_STATUS.REFUNDED;
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

export const NATIVE_ENUMS_REFERENCE = Object.freeze({
    BOOKING_STATUS: BOOKING_STATUS,
    PAYMENT_STATUS: PAYMENT_STATUS,
});
