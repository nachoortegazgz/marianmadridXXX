/*
MODULE: backend/booking/bookingCore.js
VERSION: v5010.1-BOOKINGS-ALIGN
BASE: v5009-FISCAL-V20.2-CORE + Wix Bookings API alignment pass
RESPONSIBILITY: Capa de acceso y primitivas atomicas para reservas.
STANDARDS: ASCII only. No Node builtins.

FIXES APLICADOS v5010.1-BOOKINGS-ALIGN:
  - CORE-08: cancelBookingElevated deja de ser un proxy plano y pasa a ser
             un wrapper que EXIGE revision (parametro requerido por la API
             de Wix Bookings: "the current revision must be specified when
             updating the booking"). Sin revision, la compensacion de la
             saga fallaba con HTTP 428 (Failed Precondition) y dejaba
             reservas huerfanas. Firma nueva:
                cancelBookingElevated(bookingId, { revision, suppressAuth? })
             Si revision no es entero positivo, lanza BookingError
             INVALID_PAYLOAD antes de llamar a la API.
  - CORE-09: _forceStaffInPristineSlot y _projectWriterSlotFromAvailability
             YA NO inyectan addOnIds/selectedAddOns DENTRO del slot.
             La API de Wix Bookings espera los add-ons en el campo
             bookedAddOns del body de createBooking:
                bookings.createBooking({
                  bookedEntity: { slot: {...} },
                  bookedAddOns: [{ addOnId: "..." }, ...],
                  ...
                })
             Inyectar add-ons dentro del slot los ignoraba silenciosamente.
  - CORE-10: nuevo helper exportado _buildBookedAddOns(addOnIds) que
             devuelve [{ addOnId }, ...] listo para el body. Consumidor
             previsto: bookingSaga.js (en su proxima entrega). El lector
             _extractAddonIdsFromSlot se mantiene para compatibilidad.
  - CORE-11: header y changelog actualizados. Contrato de cancelBooking
             documentado explicitamente.

FIXES APLICADOS v5009-FISCAL-V20.2 (heredados):
  - CORE-01: _extractResourceIdsFromSlot acepta resourceTypeId,
             resourceType.id, resourceType._id y typeId. Paridad 1:1 con
             reservas.web._getResourceIdsFromSlot. Extrae tambien
             resource.resourceId. Sin este fix, _projectCertifiedSlot
             devolvia availableResources: [] con la variante anidada de Wix.
  - CORE-02: (derogado por CORE-09) el slot ya no transporta addOnIds.
  - CORE-03: _projectWriterSlotFromAvailability exige scheduleId GUID
             valido (cascada projected -> slot -> slot.slot).
  - CORE-04: _projectCertifiedSlot valida locationId contra
             SDK_CONFIG.LOCATION_ID. Si el slot trae otra ubicacion,
             devuelve null (fail-fast).
  - CORE-05: Huella de pairToken canonica compartida (_buildPairFingerprint
             + _buildPairTokenDeterministic desde bookingUtils).
  - CORE-06: confirmOrDeclineBookingElevated traduce paymentStatus del SSOT
             espanol al enum nativo Wix.
  - CORE-07: Constantes CONCURRENCY V20 canonicas.

HISTORIAL (heredado):
  v5009-FISCAL-V20.1 | Sin renombrados funcionales.
  v5008.6 | 2026-09-20 | Alineacion final: FIX-32, FIX-33, FIX-43.
  v5008.5 | 2026-09-19 | COHERENCIA scheduleId: CORE-16, CORE-17.
  v5008.4 | 2026-09-19 | Date range, scheduleId obligatorio, cache.
  v5008.3 | 2026-09-19 | Restauracion de exports faltantes.
  v5008.2 | 2026-09-15 | Aligned + dead code removed.
=============================================================================
*/

import { bookings } from "@wix/bookings";
import { checkout } from "@wix/ecom";
import { auth } from "@wix/essentials";
import wixData from "backend/dataLegacyAdapter";
import { getStaffScheduleId } from "backend/staff";
import { logger } from "backend/logger";
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
    INACTIVE_BOOKING_STATUSES,
    BOOKING_FIELDS,
} from "backend/internalConfig";
import {
    _safeTrim,
    _looksLikeGuid,
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

const CONFIGURED_LOCATION_ID = _safeTrim(SDK_CONFIG?.LOCATION_ID);

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
// BLOQUE 2 - ELEVATED PROXIES (Bookings V2 + eCommerce)
// =============================================================================
// CORE-08: cancelBookingElevated deja de ser un proxy plano. La API de
// Wix Bookings exige el parametro revision para prevenir conflictos.
// El wrapper valida el contrato antes de llamar a la API.
//
// CORE-06: confirmOrDeclineBookingElevated traduce el paymentStatus del
// SSOT espanol (IMPAGADO, NO_PAGADO, PAGADO...) al enum nativo de Wix.

export const createCheckoutElevated = auth.elevate(checkout.createCheckout);
export const getCheckoutUrlElevated = auth.elevate(checkout.getCheckoutUrl);

// CORE-06: Mapa paymentStatus SSOT espanol -> enum nativo Wix.
const WIX_NATIVE_PAYMENT_STATUS = Object.freeze({
    UNDEFINED: "UNDEFINED",
    NOT_PAID: "NOT_PAID",
    PENDING_PAYMENT: "PENDING_PAYMENT",
    PAID: "PAID",
    PARTIALLY_PAID: "PARTIALLY_PAID",
    REFUNDED: "REFUNDED",
    PARTIALLY_REFUNDED: "PARTIALLY_REFUNDED",
    EXEMPT: "EXEMPT",
    IMPAGADO: "NOT_PAID",
    NO_PAGADO: "NOT_PAID",
    PAGADO: "PAID",
    PARCIALMENTE_PAGADO: "PARTIALLY_PAID",
    REEMBOLSADO: "REFUNDED",
    REEMBOLSADO_PARCIAL: "PARTIALLY_REFUNDED",
});

function _toWixNativePaymentStatus(value) {
    const v = _safeTrim(value).toUpperCase();
    if (!v) return value;
    return WIX_NATIVE_PAYMENT_STATUS[v] || value;
}

const _confirmOrDeclineElevatedRaw = auth.elevate(bookings.confirmOrDeclineBooking);
const _cancelBookingElevatedRaw = auth.elevate(bookings.cancelBooking);

/**
 * CORE-06: wrapper elevado que traduce el paymentStatus del SSOT (espanol)
 * al enum nativo que acepta Wix Bookings.
 *
 * IMPORTANTE (Wix Bookings API): no llamar a este metodo cuando se usa un
 * checkout de Wix eCommerce. En ese caso Wix Bookings actualiza el estado
 * automaticamente segun el paymentStatus de la orden. Ver bookingSaga para
 * la logica de flujo.
 *
 * Contrato preservado: (bookingId, options) -> respuesta nativa elevada.
 */
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

/**
 * CORE-08: wrapper elevado que EXIGE revision en las opciones.
 *
 * Contrato Wix Bookings (cancelBooking):
 *   "To prevent conflicting changes, the current revision must be specified
 *    when cancelling the booking."
 *
 * Firma:
 *   cancelBookingElevated(bookingId, { revision, suppressAuth? })
 *
 * Si revision no es entero positivo, lanza BookingError INVALID_PAYLOAD
 * SIN llamar a la API. El llamador (bookingSaga._compensateCreatedBookings)
 * debe propagar el revision persistido en CitasF2.
 */
export async function cancelBookingElevated(bookingId, options = {}) {
    const cleanId = _safeTrim(bookingId);
    if (!cleanId || !_looksLikeGuid(cleanId)) {
        throw new BookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "cancelBooking: bookingId must be a valid GUID",
            { bookingId: cleanId }
        );
    }

    const revisionRaw = options?.revision;
    const revision = Number(revisionRaw);

    if (!Number.isFinite(revision) || revision <= 0 || !Number.isInteger(revision)) {
        throw new BookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "cancelBooking: revision is required and must be a positive integer " +
            "(Wix Bookings contract). Got: " + String(revisionRaw),
            { bookingId: cleanId, revisionRaw }
        );
    }

    const normalizedOptions = Object.assign({}, options, { revision });

    log.info("CORE-08: cancelling booking with revision", {
        bookingId: cleanId,
        revision,
    });

    return _cancelBookingElevatedRaw(cleanId, normalizedOptions);
}

export { logger };

// =============================================================================
// BLOQUE 3 - CLASE BOOKINGERROR
// =============================================================================

export class BookingError extends Error {
    constructor(code, message, details = {}) {
        super(String(message || "Unknown error"));
        this.name = "BookingError";
        this.code = String(code || ERROR_CODES.UNKNOWN_ERROR);
        this.details = details && typeof details === "object" ? details : { details };
        this.timestamp = new Date().toISOString();
    }
}

export function createBookingError(code, message, details) {
    return new BookingError(code, message, details);
}

// =============================================================================
// BLOQUE 4 - NORMALIZACION DE ERRORES
// =============================================================================

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
    const loggerInstance = logFn || log;
    const norm = normalizeError(error);
    loggerInstance.error("[" + context + "] " + norm.code + ": " + norm.message, {
        traceId,
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
// BLOQUE 5 - RESOLUCION DE SCHEDULEID
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

    const s = (sourceSlot && typeof sourceSlot === "object") ? sourceSlot : {};
    let scheduleId = _safeTrim(
        s.scheduleId || s.slot?.scheduleId || s.schedule?.id || s.resource?.scheduleId || ""
    );
    if (scheduleId && _looksLikeGuid(scheduleId)) return scheduleId;

    scheduleId = await _resolveScheduleIdByResourceId(resourceIdClean);
    return scheduleId || null;
}

// =============================================================================
// BLOQUE 6 - NORMALIZACION DE SLOTS PARA WRITER V2
// =============================================================================

/**
 * CORE-10: extraccion tolerante de addOnIds desde el slot entrante.
 * Fuentes aceptadas (por orden): slot.addOnIds, slot.selectedAddOns,
 * slot.customerChoices.addOnIds.
 * Solo se conservan GUIDs validos, deduplicados.
 *
 * NOTA: los add-ons NO se inyectan de vuelta al slot. Ver CORE-09.
 * El consumidor los pasa por _buildBookedAddOns antes del createBooking.
 */
export function _extractAddonIdsFromSlot(slot) {
    const candidates = [].concat(
        Array.isArray(slot?.addOnIds) ? slot.addOnIds : [],
        Array.isArray(slot?.selectedAddOns) ? slot.selectedAddOns : [],
        Array.isArray(slot?.customerChoices?.addOnIds) ? slot.customerChoices.addOnIds : []
    );

    const clean = candidates
        .map(function (id) { return _safeTrim(id); })
        .filter(function (id) { return _looksLikeGuid(id); });

    return Array.from(new Set(clean));
}

/**
 * CORE-10: construye el campo bookedAddOns para el body de createBooking.
 * Contrato Wix Bookings: bookedAddOns es un array de { addOnId } en el
 * nivel RAIZ del body, NO dentro de bookedEntity.slot.
 *
 * @param {string[]} addOnIds GUIDs nativos de los add-ons seleccionados.
 * @returns {Array<{addOnId: string}>}
 */
export function _buildBookedAddOns(addOnIds) {
    if (!Array.isArray(addOnIds) || addOnIds.length === 0) return [];
    return addOnIds
        .map(function (id) { return _safeTrim(id); })
        .filter(function (id) { return _looksLikeGuid(id); })
        .map(function (id) { return { addOnId: id }; });
}

export async function _forceStaffInPristineSlot(slot, resourceId, serviceIdOverride, defaultDurationMinutes) {
    if (!slot || typeof slot !== "object") return null;

    const serviceId = _safeTrim(serviceIdOverride || slot.serviceId);
    if (!serviceId || !_looksLikeGuid(serviceId)) {
        log.error("_forceStaffInPristineSlot: invalid serviceId", { serviceId });
        return null;
    }

    const resourceIdClean = _safeTrim(resourceId || slot.resourceId || slot.resource?.id);
    if (!resourceIdClean || !_looksLikeGuid(resourceIdClean)) {
        log.error("_forceStaffInPristineSlot: invalid resourceId", { resourceIdClean });
        return null;
    }

    let scheduleId = _safeTrim(
        slot.scheduleId || slot.slot?.scheduleId || slot.schedule?.id || slot.resource?.scheduleId || ""
    );
    if (!scheduleId) {
        scheduleId = await _resolveScheduleIdByResourceId(resourceIdClean);
    }
    if (!scheduleId || !_looksLikeGuid(scheduleId)) {
        log.error("_forceStaffInPristineSlot: missing scheduleId", { resourceId: resourceIdClean });
        return null;
    }

    let localStartDate = "";
    const rawStart = slot.localStartDate || slot.startDate;
    if (rawStart instanceof Date) localStartDate = getMadridLocalStringNoZ(rawStart);
    else if (typeof rawStart === "string" && rawStart.endsWith("Z")) {
        const utcDt = new Date(rawStart);
        localStartDate = !isNaN(utcDt.getTime()) ? getMadridLocalStringNoZ(utcDt) : "";
    } else localStartDate = _safeTrim(rawStart);
    if (!localStartDate) return null;

    let localEndDate = "";
    const rawEnd = slot.localEndDate || slot.endDate;
    if (rawEnd instanceof Date) localEndDate = getMadridLocalStringNoZ(rawEnd);
    else if (typeof rawEnd === "string" && rawEnd.endsWith("Z")) {
        const utcDt = new Date(rawEnd);
        localEndDate = !isNaN(utcDt.getTime()) ? getMadridLocalStringNoZ(utcDt) : "";
    } else localEndDate = _safeTrim(rawEnd);

    if (!localEndDate) {
        const startUtc = getUtcDateFromMadridLocal(localStartDate);
        if (!startUtc) return null;
        const durationMin = Number(defaultDurationMinutes || CONCURRENCY?.DEFAULT_DURATION_MIN || 30);
        localEndDate = getMadridLocalStringNoZ(new Date(startUtc.getTime() + durationMin * 60 * 1000));
    }

    const startDate = getUtcDateFromMadridLocal(localStartDate);
    const endDate = getUtcDateFromMadridLocal(localEndDate);
    if (!startDate || !endDate) return null;

    if (endDate.getTime() <= startDate.getTime()) {
        log.error("_forceStaffInPristineSlot: invalid date range (endDate <= startDate)", {
            localStartDate,
            localEndDate,
            resourceId: resourceIdClean,
            serviceId,
        });
        return null;
    }

    const incomingLocationId = _safeTrim(slot.location?.id);
    if (
        incomingLocationId &&
        CONFIGURED_LOCATION_ID &&
        incomingLocationId !== CONFIGURED_LOCATION_ID
    ) {
        log.error("_forceStaffInPristineSlot: slot location conflicts with configured location", {
            slotLocationId: incomingLocationId,
            configuredLocationId: CONFIGURED_LOCATION_ID,
            serviceId,
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

    let locationType = _safeTrim(SDK_CONFIG?.LOCATION_TYPES?.BOOKINGS_WRITER) || "OWNER_BUSINESS";
    if (locationType === "BUSINESS") locationType = "OWNER_BUSINESS";
    const timezone = _safeTrim(SDK_CONFIG?.TZ) || "Europe/Madrid";

    // CORE-09: NO se inyectan addOnIds ni selectedAddOns dentro del slot.
    // Los add-ons viajan en bookingBody.bookedAddOns (ver _buildBookedAddOns).
    return {
        serviceId,
        scheduleId,
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
        timezone,
        resource: { id: resourceIdClean },
        location: { id: locationId, locationType },
    };
}

// =============================================================================
// BLOQUE 7 - CHECKOUT URL HELPER
// =============================================================================

export function _extractCheckoutId(checkoutSession) {
    return checkoutSession?.checkout?._id || checkoutSession?._id || null;
}

// =============================================================================
// BLOQUE 8 - MUTEX LOCKS (SlotLocks) - CORE-07
// =============================================================================

const MUTEX_TTL_MS = Number(CONCURRENCY?.MS_TTL_MUTEX);
if (!Number.isFinite(MUTEX_TTL_MS) || MUTEX_TTL_MS <= 0) {
    throw new Error("MS_TTL_MUTEX must be positive");
}

const LOCKS_COL = OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO;

export function _buildSlotLockControl(slotClave, lockOwnerId, ttlMs, existing) {
    const now = new Date();
    return {
        _id: _safeLockId(slotClave),
        controlType: CONTROL_TYPE.SLOT_LOCK,
        dedupeKey: String(slotClave),
        slotKey: String(slotClave),
        lockOwnerId: String(lockOwnerId || makeTraceId("lock")),
        status: "ACTIVE",
        traceId: String(lockOwnerId || ""),
        expiresAt: new Date(Date.now() + (Number(ttlMs) || MUTEX_TTL_MS)),
        _createdDate: existing?._createdDate ? _toDateSafe(existing._createdDate) || now : now,
        _updatedDate: now,
    };
}

export function _safeLockId(key) {
    const k = String(key || "").trim();
    if (!k) return "";
    return "lk_" + _hashKey(k) + "_" + k.slice(0, 24);
}

async function _getLock(slotClave) {
    const k = String(slotClave || "");
    if (!k) return null;
    const item = await wixData
        .get(LOCKS_COL, _safeLockId(k), { suppressAuth: true, consistentRead: true })
        .catch(() => null);
    if (!item) return null;
    if (item.expiresAt) item.expiresAt = _toDateSafe(item.expiresAt);
    return item;
}

function _getLockOwnerId(lock) {
    if (!lock || typeof lock !== "object") return "";
    return _safeTrim(lock.lockOwnerId || lock.traceId || "");
}

function _isDuplicateItemError(error) {
    const message = String(error?.message || "");
    return message.includes("WDE0123") || message.includes("WD_ITEM_ALREADY_EXISTS") || message.includes("Duplicated");
}

function _buildLockDocument(slotClave, lockOwnerId, ttlMs, existing) {
    return _buildSlotLockControl(slotClave, lockOwnerId, ttlMs, existing);
}

export async function _lockSlotKeyOrFail(slotClave, lockOwnerId, ttlMs) {
    const k = String(slotClave || "");
    const owner = String(lockOwnerId || "").trim();
    if (!k || !owner) return { ok: false, message: "LOCK_KEY_OR_OWNER_INVALID" };

    try {
        await wixData.insert(LOCKS_COL, _buildLockDocument(k, owner, ttlMs), { suppressAuth: true });
        return { ok: true, acquired: true };
    } catch (error) {
        if (!_isDuplicateItemError(error)) {
            log.error("_lockSlotKeyOrFail failed", { slotClave: k, error: error?.message });
            return { ok: false, message: error?.message || "Lock acquisition failed" };
        }
        const existing = await _getLock(k);
        const currentOwner = _getLockOwnerId(existing);
        if (currentOwner === owner) {
            const renewed = await _renewLock(k, owner, ttlMs);
            return renewed.ok ? { ok: true, renewed: true } : { ok: false, message: "LOCK_RENEWAL_FAILED" };
        }
        const expiresAt = _toDateSafe(existing?.expiresAt);
        const expired = expiresAt ? expiresAt.getTime() < Date.now() : false;
        if (expired && existing?._id) {
            await wixData.remove(LOCKS_COL, existing._id, { suppressAuth: true }).catch(() => null);
            try {
                await wixData.insert(LOCKS_COL, _buildLockDocument(k, owner, ttlMs), { suppressAuth: true });
                return { ok: true, acquired: true, reclaimed: true };
            } catch (_) {
                return { ok: false, message: "LOCK_HELD_BY_ANOTHER_OWNER" };
            }
        }
        return { ok: false, message: "LOCK_HELD_BY_ANOTHER_OWNER" };
    }
}

export async function _unlockSlotKey(slotClave, lockOwnerId) {
    const owner = String(lockOwnerId || "").trim();
    const existing = await _getLock(slotClave);
    if (!existing) return { ok: true, missing: true };
    const currentOwner = _getLockOwnerId(existing);
    if (!owner || currentOwner !== owner) return { ok: false, skipped: true };
    await wixData.remove(LOCKS_COL, existing._id, { suppressAuth: true });
    return { ok: true };
}

export async function _renewLock(slotClave, lockOwnerId, ttlMs) {
    try {
        const owner = String(lockOwnerId || "").trim();
        const existing = await _getLock(slotClave);
        if (!existing) return { ok: false };
        const currentOwner = _getLockOwnerId(existing);
        if (!owner || currentOwner !== owner) return { ok: false };
        await wixData.update(LOCKS_COL, _buildLockDocument(slotClave, owner, ttlMs, existing), { suppressAuth: true });
        return { ok: true };
    } catch (error) {
        log.error("_renewLock failed", { slotClave, error: error?.message });
        return { ok: false };
    }
}

// =============================================================================
// BLOQUE 9 - SLOT KEYS
// =============================================================================

export function _generateSlotKey(serviceId, resourceId, startDate, endDate) {
    const startUtc = startDate instanceof Date ? startDate : getUtcDateFromMadridLocal(startDate);
    const endUtc = endDate instanceof Date ? endDate : getUtcDateFromMadridLocal(endDate);
    if (!startUtc || !endUtc || endUtc.getTime() <= startUtc.getTime()) {
        throw createBookingError(ERROR_CODES.INVALID_DATES, "Invalid slot dates for lock key");
    }
    const startEpochMin = Math.floor(startUtc.getTime() / 60000);
    const endEpochMin = Math.floor(endUtc.getTime() / 60000);
    const raw = String(serviceId || "").trim() + "|" + String(resourceId || "").trim() + "|" + startEpochMin + "|" + endEpochMin;
    const prefix = serviceId ? String(serviceId).slice(0, 8) : "srv";
    const staffPrefix = resourceId ? String(resourceId).slice(0, 8) : "nostaff";
    return "slot_" + prefix + "_" + staffPrefix + "_" + _hashKey(raw);
}

export function _buildLockKeys(phases, resourceId) {
    const keys = (phases || []).map(function (p) {
        const slot = p?.rawSlot || {};
        return _generateSlotKey(slot.serviceId, resourceId, p.localStart, p.localEnd);
    });
    return Array.from(new Set(keys)).sort();
}

// =============================================================================
// BLOQUE 10 - TRANSACCIONES IDEMPOTENTES (BookingTransactions)
// =============================================================================

const TRANSACTIONS_COL = OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO;

const TRANSACTION_POLL_BASE_MS = Number(CONCURRENCY?.TRANSACTION_POLL_BASE_MS) || 250;
const TRANSACTION_MAX_WAIT_MS = Number(CONCURRENCY?.TRANSACTION_MAX_WAIT_MS) || 3000;

async function _getTransactionById(pairToken) {
    const id = String(pairToken || "");
    if (!id) return null;
    return await wixData.get(TRANSACTIONS_COL, id, { suppressAuth: true, consistentRead: true }).catch(() => null);
}

export async function _initTransaction(pairToken, payloadHash, traceId) {
    const id = String(pairToken || "");
    if (!id) return { success: false, error: "INVALID_PAIR_TOKEN" };

    try {
        await wixData.insert(
            TRANSACTIONS_COL, {
                _id: id,
                pairToken: id,
                status: "PENDING",
                payloadHash,
                traceId,
                _createdDate: new Date(),
                _updatedDate: new Date(),
            }, { suppressAuth: true }
        );
        return { success: true, isNew: true };
    } catch (error) {
        if (!_isDuplicateItemError(error)) throw error;

        const startTime = Date.now();
        let pollAttempt = 0;
        while (Date.now() - startTime < TRANSACTION_MAX_WAIT_MS) {
            const existing = await _getTransactionById(id);
            if (existing) {
                if (String(existing.payloadHash || "") !== String(payloadHash || "")) {
                    return { success: false, error: "PAIR_TOKEN_PAYLOAD_MISMATCH" };
                }
                if (existing.status === "COMPLETED") return { success: true, isNew: false, existing };
                if (existing.status === "FAILED") {
                    return { success: false, error: "TRANSACTION_PREVIOUSLY_FAILED", existing };
                }
            }
            const remainingMs = TRANSACTION_MAX_WAIT_MS - (Date.now() - startTime);
            const delay = Math.min(
                Math.floor(TRANSACTION_POLL_BASE_MS * Math.pow(2, Math.min(pollAttempt, 3)) * (0.5 + Math.random())),
                remainingMs
            );
            if (delay <= 0) break;
            pollAttempt++;
            await new Promise(function (r) { setTimeout(r, delay); });
        }

        const existing = await _getTransactionById(id);
        if (existing) {
            if (String(existing.payloadHash || "") !== String(payloadHash || "")) {
                return { success: false, error: "PAIR_TOKEN_PAYLOAD_MISMATCH" };
            }
            return { success: false, error: "TRANSACTION_TIMEOUT", existing, timeout: true };
        }
        return { success: false, error: "TRANSACTION_TIMEOUT" };
    }
}

export async function _completeTransaction(pairToken, result, traceId) {
    const id = String(pairToken || "");
    if (!id) return;
    const existing = await _getTransactionById(id);
    if (existing && existing.status === "COMPLETED") return;
    const doc = {
        ...(existing || {}),
        _id: id,
        pairToken: id,
        status: "COMPLETED",
        result,
        ownerTraceId: String(traceId || existing?.ownerTraceId || ""),
        _updatedDate: new Date(),
        _createdDate: existing?._createdDate || new Date(),
    };
    if (existing) await wixData.update(TRANSACTIONS_COL, doc, { suppressAuth: true });
    else await wixData.insert(TRANSACTIONS_COL, doc, { suppressAuth: true });
}

export async function _failTransaction(pairToken, errorMessage) {
    const id = String(pairToken || "");
    if (!id) return;
    const existing = await _getTransactionById(id);
    if (existing && existing.status === "COMPLETED") return;
    const doc = {
        ...(existing || {}),
        _id: id,
        pairToken: id,
        status: "FAILED",
        error: String(errorMessage || "UNKNOWN_ERROR"),
        _updatedDate: new Date(),
        _createdDate: existing?._createdDate || new Date(),
    };
    if (existing) await wixData.update(TRANSACTIONS_COL, doc, { suppressAuth: true }).catch(() => null);
    else await wixData.insert(TRANSACTIONS_COL, doc, { suppressAuth: true }).catch(() => null);
}

// =============================================================================
// BLOQUE 11 - PERSISTENCIA EN CITAS_F2
// =============================================================================

const CITAS_COL = BUSINESS_COLLECTIONS.CITAS_F2;

export async function _persistBooking(params, traceId) {
    const p = params || {};
    const bookingId = p.bookingId;
    const serviceId = p.serviceId;
    const resourceId = p.resourceId;
    const startDate = p.startDate;
    const endDate = p.endDate;
    if (!bookingId || !serviceId || !resourceId || !startDate || !endDate) {
        throw new Error("Missing required fields for persistBooking");
    }

    const scheduleIdClean = _safeTrim(p.scheduleId);
    if (!scheduleIdClean || !_looksLikeGuid(scheduleIdClean)) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "scheduleId is required and must be a valid GUID for CitasF2 persistence", { traceId, bookingId: String(bookingId), scheduleIdRaw: p.scheduleId }
        );
    }

    const startDateObj = startDate instanceof Date ? startDate : new Date(startDate);
    const endDateObj = endDate instanceof Date ? endDate : new Date(endDate);
    if (isNaN(startDateObj.getTime()) || isNaN(endDateObj.getTime()) || endDateObj.getTime() <= startDateObj.getTime()) {
        throw new Error("Invalid startDate/endDate for persistBooking");
    }

    const startLocal = getMadridLocalStringNoZ(startDateObj);
    const dateYmd = startLocal ? startLocal.slice(0, 10) : "";
    const now = new Date();

    const metaPago = String(
        p.paymentStatus || p.meta?.paymentStatus || PAYMENT_STATUS.NOT_PAID
    ).toUpperCase();

    const statusCita = String(
        p.bookingStatus ||
        p.status ||
        (
            metaPago === String(PAYMENT_STATUS.PENDING_PAYMENT).toUpperCase() ||
            metaPago === String(PAYMENT_STATUS.NOT_PAID).toUpperCase() ?
            BOOKING_STATUS.PENDING :
            BOOKING_STATUS.CONFIRMED
        )
    );

    let normalizedMeta = p.meta || {};
    if (typeof normalizedMeta === "string") {
        try { normalizedMeta = JSON.parse(normalizedMeta); } catch (_) { normalizedMeta = {}; }
    }
    if (typeof normalizedMeta !== "object" || normalizedMeta === null || Array.isArray(normalizedMeta)) {
        normalizedMeta = {};
    }
    normalizedMeta = { ...normalizedMeta, bookingStatus: statusCita, paymentStatus: metaPago };

    const doc = {
        bookingId: String(bookingId),
        pairToken: String(p.pairToken || normalizedMeta.pairToken || ""),
        revision: Number(p.revision) || 1,
        serviceId: String(serviceId),
        scheduleId: scheduleIdClean,
        resourceId: String(resourceId),
        startDate: startDateObj,
        endDate: endDateObj,
        dateYmd,
        bookingType: normalizeBookingType(p.tipo || p.bookingType),
        [BOOKING_FIELDS.STATUS]: statusCita,
        paymentStatus: metaPago,
        meta: normalizedMeta,
        contactDetails: p.contactDetails || {},
        traceId: String(traceId || ""),
        _createdDate: now,
        _updatedDate: now,
    };

    if (isDualBookingType(doc.bookingType) && !doc.pairToken) {
        throw new Error("Missing pairToken for linked booking");
    }

    const existing = await wixData
        .query(CITAS_COL)
        .eq("bookingId", String(bookingId))
        .limit(1)
        .find({ suppressAuth: true, suppressHooks: true })
        .catch(() => null);

    if (existing?.items?.length > 0) {
        const existingDoc = existing.items[0];
        const incomingRevision = Number(doc.revision) || 1;
        const currentRevision = Number(existingDoc.revision) || 1;
        if (incomingRevision < currentRevision) {
            throw new BookingError(ERROR_CODES.DATABASE_ERROR, "Booking revision conflict", {
                bookingId: String(bookingId),
                currentRevision,
                incomingRevision,
            });
        }
        const updated = { ...existingDoc, ...doc };
        delete updated._createdDate;
        delete updated._updatedDate;
        delete updated._owner;
        const item = await wixData.update(CITAS_COL, updated, { suppressAuth: true, suppressHooks: true });
        return { created: false, item };
    }

    const item = await wixData.insert(CITAS_COL, doc, { suppressAuth: true, suppressHooks: true });
    return { created: true, item };
}

// =============================================================================
// BLOQUE 12 - ACTUALIZACION SEGURA DE CITA
// =============================================================================

export async function _updateCitaSafe(bookingId, updater, traceId, operation) {
    const bid = _safeTrim(bookingId);
    if (!bid) return { updated: false, reason: "INVALID_BOOKING_ID" };

    try {
        const res = await wixData
            .query(CITAS_COL)
            .eq("bookingId", bid)
            .limit(1)
            .find({ suppressAuth: true, suppressHooks: true });

        const cita = res?.items?.[0];
        if (!cita) {
            log.warn("_updateCitaSafe: cita not found", { bookingId: bid, operation, traceId });
            return { updated: false, reason: "NOT_FOUND" };
        }

        const updated = updater(cita);
        if (!updated) return { updated: false, reason: "NO_CHANGE" };

        updated._updatedDate = new Date();
        updated.traceId = traceId || updated.traceId;

        await wixData.update(CITAS_COL, updated, { suppressAuth: true, suppressHooks: true });
        return { updated: true, bookingId: bid };
    } catch (err) {
        log.error("_updateCitaSafe failed", {
            bookingId: bid,
            operation,
            traceId,
            error: err?.message,
        });
        return { updated: false, reason: "ERROR", error: err?.message };
    }
}

// =============================================================================
// BLOQUE 15 - EXTRACCION DE RESOURCEIDS DESDE SLOTS (CORE-01)
// =============================================================================

export function _extractResourceIdsFromSlot(slot) {
    return getResourceIdsFromSlot(slot, STAFF_RESOURCE_TYPE_ID);
}

// =============================================================================
// BLOQUE 17 - VERIFICACION DE CONTIGUIDAD/GAP
// =============================================================================

export function _areSlotsContiguous(slot1, slot2, maxGapMinutes) {
    if (!slot1 || !slot2) return false;
    const fallbackTolerance = Number(SLOT_SEARCH?.MINUTOS_TOLERANCIA);
    const maxGap = maxGapMinutes == null ?
        (Number.isFinite(fallbackTolerance) ? fallbackTolerance : 120) :
        maxGapMinutes;
    const end1 = slot1.localEndDate || slot1.endDate;
    const start2 = slot2.localStartDate || slot2.startDate;
    if (!end1 || !start2) return false;

    const end1Utc = end1 instanceof Date ? end1 : getUtcDateFromMadridLocal(_normalizeLocalIsoStr(end1));
    const start2Utc = start2 instanceof Date ? start2 : getUtcDateFromMadridLocal(_normalizeLocalIsoStr(start2));
    if (!end1Utc || !start2Utc) return false;

    const rawDiffMinutes = (start2Utc.getTime() - end1Utc.getTime()) / 60000;

    if (rawDiffMinutes < -1) return false;

    const gapMinutes = computeGapMinutes(end1Utc, start2Utc);

    return gapMinutes <= maxGap;
}

// =============================================================================
// BLOQUE 18 - PROYECCION DE SLOTS CERTIFICADOS Y WRITER
// =============================================================================

export function _projectCertifiedSlot(slot, resourceId) {
    if (!slot || typeof slot !== "object") return null;

    const serviceId = _safeTrim(slot.serviceId);
    if (!serviceId || !_looksLikeGuid(serviceId)) return null;

    const resourceIdClean = _safeTrim(resourceId || slot.resourceId || slot.resource?.id);
    if (!resourceIdClean || !_looksLikeGuid(resourceIdClean)) return null;

    const localStartDate = _normalizeLocalIsoStr(slot.localStartDate || slot.startDate);
    const localEndDate = _normalizeLocalIsoStr(slot.localEndDate || slot.endDate);

    if (!localStartDate || !localEndDate) return null;

    const startDateUtc = getUtcDateFromMadridLocal(localStartDate);
    const endDateUtc = getUtcDateFromMadridLocal(localEndDate);

    if (!startDateUtc || !endDateUtc || endDateUtc.getTime() <= startDateUtc.getTime()) return null;

    const slotLocationId = _safeTrim(slot.location?.id);

    if (
        slotLocationId &&
        CONFIGURED_LOCATION_ID &&
        slotLocationId !== CONFIGURED_LOCATION_ID
    ) {
        log.warn("_projectCertifiedSlot: slot location does not match configured location", {
            slotLocationId,
            configuredLocationId: CONFIGURED_LOCATION_ID,
            serviceId,
        });
        return null;
    }

    const locationId = slotLocationId || CONFIGURED_LOCATION_ID;

    if (!locationId || !_looksLikeGuid(locationId)) {
        log.warn("_projectCertifiedSlot: missing or invalid locationId", {
            slotLocationId,
            configuredLocationId: CONFIGURED_LOCATION_ID,
            serviceId,
        });
        return null;
    }

    return {
        serviceId,
        resourceId: resourceIdClean,
        scheduleId: _safeTrim(slot.scheduleId || slot.slot?.scheduleId || ""),
        localStartDate,
        localEndDate,
        startDate: startDateUtc,
        endDate: endDateUtc,
        bookable: slot.bookable === true,
        availableResources: _extractResourceIdsFromSlot(slot),
        timezone: SDK_CONFIG?.TZ || "Europe/Madrid",
        locationId,
        locationName: _safeTrim(slot.location?.name || ""),
        formattedAddress: _safeTrim(slot.location?.formattedAddress || ""),
    };
}

/**
 * CORE-09: el slot del Writer V2 NO lleva add-ons. Los add-ons se pasan
 * a createBooking via _buildBookedAddOns en el body raiz.
 */
export function _projectWriterSlotFromAvailability(slot, resourceId, serviceId) {
    const projected = _projectCertifiedSlot(slot, resourceId);
    if (!projected) return null;

    const finalServiceId = _safeTrim(serviceId) || projected.serviceId;
    if (!finalServiceId || !_looksLikeGuid(finalServiceId)) return null;

    const scheduleId = _safeTrim(
        projected.scheduleId ||
        slot.scheduleId ||
        slot.slot?.scheduleId
    );

    if (!scheduleId || !_looksLikeGuid(scheduleId)) {
        log.warn("_projectWriterSlotFromAvailability: missing or invalid scheduleId", {
            serviceId: finalServiceId,
            scheduleIdRaw: projected.scheduleId || null,
        });
        return null;
    }

    let writerLocationType = _safeTrim(SDK_CONFIG?.LOCATION_TYPES?.BOOKINGS_WRITER);
    if (writerLocationType === "BUSINESS" || !writerLocationType) writerLocationType = "OWNER_BUSINESS";

    return {
        serviceId: finalServiceId,
        scheduleId,
        startDate: projected.startDate,
        endDate: projected.endDate,
        timezone: projected.timezone,
        resource: {
            id: projected.resourceId,
        },
        location: {
            id: projected.locationId,
            locationType: writerLocationType,
        },
    };
}

// =============================================================================
// BLOQUE 20 - PAIR TOKEN CANONICO COMPARTIDO (CORE-05)
// =============================================================================

export function _buildPairTokenDeterministic(input) {
    return _hashKey(_buildPairFingerprint(input || {}));
}

// =============================================================================
// BLOQUE 21 - RANKING DE RECURSOS POR CARGA
// =============================================================================

export async function _rankResourcesByLoad(resourceIds, dateYmd, traceId) {
    const input = Array.isArray(resourceIds) ?
        Array.from(new Set(resourceIds.map((id) => _safeTrim(id)).filter(_looksLikeGuid))) : [];

    if (input.length < 2) return input;

    const day = _safeTrim(dateYmd);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
        log.warn("_rankResourcesByLoad: invalid dateYmd", { dateYmd: day, traceId });
        return input;
    }

    const loads = Object.fromEntries(input.map((id, index) => [id, {
        resourceId: id,
        load: 0,
        firstIndex: index,
    }]));

    const inactiveList = Array.isArray(INACTIVE_BOOKING_STATUSES) ?
        INACTIVE_BOOKING_STATUSES.map((s) => String(s || "").toUpperCase()).filter(Boolean) :
        [];

    try {
        const pageSize = 1000;
        let skip = 0;
        let hasMore = true;

        while (hasMore) {
            const result = await wixData
                .query(CITAS_COL)
                .eq("dateYmd", day)
                .in("resourceId", input)
                .limit(pageSize)
                .skip(skip)
                .find({ suppressAuth: true, consistentRead: true });

            const items = Array.isArray(result?.items) ? result.items : [];

            for (const item of items) {
                const resourceId = _safeTrim(item?.resourceId);
                if (!loads[resourceId]) continue;

                const status = String(item?.bookingStatus || item?.status || "").toUpperCase();
                const paymentStatus = String(item?.paymentStatus || "").toUpperCase();

                const cancelled = inactiveList.indexOf(status) >= 0;
                const ignoredPayment =
                    paymentStatus === String(PAYMENT_STATUS.REFUNDED).toUpperCase() ||
                    paymentStatus === String(PAYMENT_STATUS.PARTIALLY_REFUNDED).toUpperCase();

                if (!cancelled && !ignoredPayment) loads[resourceId].load += 1;
            }

            skip += items.length;
            hasMore = items.length === pageSize;
            if (!items.length) hasMore = false;
        }

        return Object.values(loads)
            .sort((a, b) => a.load - b.load || a.firstIndex - b.firstIndex)
            .map((entry) => entry.resourceId);
    } catch (error) {
        log.warn("_rankResourcesByLoad failed; preserving availability order", {
            traceId,
            dateYmd: day,
            error: error?.message,
        });
        return input;
    }
}
