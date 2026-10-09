/*
MODULE: backend/booking/bookingSaga.js
VERSION: v5010.2-CORE-ALIGNED
BASE: v5009-FISCAL-V20.4-SAGA + PATCH NOTES v5010.2
STANDARDS: G10 ASCII Strict. Cero suppressHooks/suppressAuth en dataLegacyAdapter.
FIXES APLICADOS v5010.2:

SAGA-PATCH-01: _buildBookedAddOns movido a helper local (no existe en bookingCore).
SAGA-PATCH-02: Idempotencia reordenada. _initTransaction es la PUERTA antes de
               cualquier retorno de duplicado. Se elimina el early-return de
               CitasF2 que permitia tokens reutilizados con payload distinto.
SAGA-PATCH-03: suppressAuth/suppressHooks eliminados de TODAS las llamadas a
               wixData (dataLegacyAdapter los ignora y eleva siempre; los hooks
               de data.js deben ejecutar). cancelBookingElevated ya esta elevado;
               se pasa solo revision en el body, nunca suppressAuth en options.
SAGA-PATCH-04: Compensacion alineada al esquema ControlOperativo canonico
               (controlType, dedupeKey, payloadJson, traceId). Se eliminan los
               campos legacy kind/status/amount/concept que el hook rechaza.
SAGA-PATCH-05: Revision preservada exactamente. Si Wix no devuelve revision,
               _validateCreateBookingResponse retorna null y la compensacion
               toma la via manual (no se inventa revision=1).
SAGA-PATCH-06: Add-ons fail-closed. Si un add-on solicitado no mapea a GUID
               nativo del catalogo, se lanza INVALID_PAYLOAD. Nunca se cobra
               ni reserva sin el add-on seleccionado. Precios/duraciones siempre
               server-side.
SAGA-PATCH-07: Requiere bookingCore v5010.8+ (parser de slot key de 5 piezas).
               Sin ese fix, toda adquisicion de lock falla. Verificar version.

HISTORIAL HEREDADO:
v5009-FISCAL-V20.3 | SAGA-01..SAGA-09 (skipValidation, pairToken unificado,
                     OWNER_BUSINESS, addons, paymentStatus, compensacion,
                     constantes V20, availableStaff, selectedPaymentOption).
*/

import { bookings } from "@wix/bookings";
import { auth } from "@wix/essentials";
// EXCEPCION DATA API (APENDICE C): persistencia CMS server-side.
// dataLegacyAdapter eleva siempre y ejecuta hooks; NO pasar suppressAuth/suppressHooks.
import wixData from "backend/dataLegacyAdapter";
import {
    BUSINESS_COLLECTIONS,
    OPERATIONAL_COLLECTIONS,
    CONTROL_TYPE,
    CONCURRENCY,
    SDK_CONFIG,
    SLOT_SEARCH,
    BOOKING_STATUS,
    BOOKING_TYPE,
    PAYMENT_STATUS,
    PAYMENT_METHOD,
    COMPENSATION_KIND,
    COMPENSATION_STATUS,
    APP_IDS,
    BOOKING_FIELDS,
} from "backend/internalConfig";
import {
    makeTraceId,
    _safeTrim,
    _looksLikeGuid,
    _stableSerialize,
    _hashKey,
    getUtcDateFromMadridLocal,
    getMadridLocalStringNoZ,
    _normalizeLocalIsoStr,
    _executeWithRetry,
    withTimeout,
} from "public/mmUtils";
import {
    computeGapMinutes,
    cleanGuidList,
} from "backend/booking/bookingUtils";
import { logger } from "backend/logger";
import {
    cancelBookingElevated,
    confirmOrDeclineBookingElevated,
    createCheckoutElevated,
    getCheckoutUrlElevated,
    _lockSlotKeyOrFail,
    _unlockSlotKey,
    _renewLock,
    _initTransaction,
    _completeTransaction,
    _failTransaction,
    _persistBooking,
    _forceStaffInPristineSlot,
    _resolveScheduleIdForResource,
    _buildLockKeys,
    createBookingError,
    normalizeError,
    ERROR_CODES,
    _extractCheckoutId,
    // v5010.4 (FASE 2 / CORE-05): huella canonica UNICA definida en bookingUtils,
    // reexportada por bookingCore. SAGA-02 la consume para correlacion exacta.
    _buildPairFingerprint,
} from "backend/booking/bookingCore";
export { _extractCheckoutId };
import {
    _resolveServiceIdInternal,
    _invalidateCachesInternal,
    _getServiceBySlugOrIdInternal,
    _resolveStaffForSlotInternal,
} from "backend/reservas.web.js";

const log = logger;

// =============================================================================
// CONSTANTES (SAGA-07: tolerantes al renombrado V20, BIBLIA 3.2.1)
// =============================================================================
const LOCKTTLMS = Number(CONCURRENCY && CONCURRENCY.MS_TTL_MUTEX) || 300000;
const HEARTBEATMS = Number(CONCURRENCY && CONCURRENCY.MS_LATIDO) || 15000;
const CITASCOL = BUSINESS_COLLECTIONS.CITAS_F2;
const SERVICIOSCOL = BUSINESS_COLLECTIONS.SERVICIOS_CATALOGO;
// FASE4 (ADR-05): CompensacionesPendientes absorbida en ControlOperativo.
const COMPENSACIONESCOL = OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO;
const MINUTOS_MAX_HUECO_DUAL = Math.max(
    0,
    Number(SLOT_SEARCH && SLOT_SEARCH.MINUTOS_MAX_HUECO_DUAL) || 120
);
const BOOKING_CREATION_TIMEOUT_MS =
    Number(SDK_CONFIG && SDK_CONFIG.TIMEOUTS && SDK_CONFIG.TIMEOUTS.BOOKING_CREATION_MS) || 25000;
const CHECKOUT_TIMEOUT_MS =
    Number(SDK_CONFIG && SDK_CONFIG.TIMEOUTS && SDK_CONFIG.TIMEOUTS.CHECKOUT_MS) || 20000;
const API_TIMEOUT_MS =
    Number(SDK_CONFIG && SDK_CONFIG.TIMEOUTS && SDK_CONFIG.TIMEOUTS.API_MS) || 15000;
// BIBLIA 3.2 fila 10: BOOKINGS_ADDON_CONFIG.MAX_POR_RESERVA = 5
const MAX_ADDONS_PER_BOOKING = 5;
// SAGA-01: BIBLIA 2.2 regla 7 -> no desactivar la validacion nativa de Wix.
const SKIP_AVAILABILITY_VALIDATION = false;
// SAGA-05: SSOT = Wix native EN enums only (no ES cascade).
const PAYMENT_STATUS_NOT_PAID = _safeTrim(PAYMENT_STATUS.NOT_PAID);
const PAYMENT_STATUS_PENDING = _safeTrim(PAYMENT_STATUS.PENDING_PAYMENT);
const BOOKING_STATUS_CONFIRMED = _safeTrim(BOOKING_STATUS.CONFIRMED);
const BOOKING_STATUS_PENDING_PAYMENT = _safeTrim(
    BOOKING_STATUS.PENDING || BOOKING_STATUS.PENDING_PAYMENT
);
// SAGA-06: non-cancelable = Wix native booking statuses only.
const NON_CANCELABLE_STATUSES = new Set(
    [
        BOOKING_STATUS.CONFIRMED,
        BOOKING_STATUS.CANCELED,
        BOOKING_STATUS.REFUNDED,
        BOOKING_STATUS.DECLINED,
        "DONE",
        "COMPLETE",
    ]
        .map(function (v) { return _safeTrim(v).toUpperCase(); })
        .filter(Boolean)
);

// =============================================================================
// BLOCK 1 - PAIR TOKEN UNIFICADO (SAGA-02)
// =============================================================================
function _resolveStablePairToken(params) {
    const serviceId = params.serviceId;
    const resourceId = params.resourceId;
    const f1Start = params.f1Start;
    const f2Start = params.f2Start;
    const email = params.email;
    const emailHash = _hashKey(_safeTrim(email).toLowerCase());
    const payload = _stableSerialize({
        serviceId: _safeTrim(serviceId),
        resourceId: _safeTrim(resourceId),
        f1Start: _safeTrim(f1Start),
        f2Start: _safeTrim(f2Start || ""),
    });
    const hash = _hashKey(payload + "|" + emailHash);
    return "pt" + hash.slice(0, 32);
}

/**
 * SAGA-02: Resolucion unificada de pairToken.
 * Prioridad:
 *   SUPPLIED    -> token emitido por getCertifiedDualSlots / frontend.
 *   FINGERPRINT -> dual con resourceId explicito: misma huella que reservas.web.
 *   STABLE      -> simple, o dual sin resourceId (degradado, con warn).
 */
function _resolveUnifiedPairToken(params) {
    const supplied = _safeTrim(params.suppliedPairToken);
    if (supplied) {
        return { pairToken: supplied, source: "SUPPLIED" };
    }
    if (params.isDual && _looksLikeGuid(params.resourceId)) {
        const fingerprint = _buildPairFingerprint({
            serviceId: params.serviceId,
            linkedPhases: params.linkedPhases,
            dateYmd: _safeTrim(params.f1Start).slice(0, 10),
            f1Start: params.f1Start,
            f1End: params.f1End,
            f2Start: params.f2Start,
            f2End: params.f2End,
            resourceId: params.resourceId,
        });
        return { pairToken: _hashKey(fingerprint), source: "FINGERPRINT" };
    }
    if (params.isDual) {
        log.warn(
            "SAGA-02: dual booking without supplied pairToken and without explicit " +
            "resourceId. Falling back to STABLE token (includes email hash), which " +
            "will NOT match getCertifiedDualSlots output. Frontend must forward " +
            "the pairToken returned by the availability query.",
            { traceId: params.traceId, serviceId: params.serviceId }
        );
    }
    return {
        pairToken: _resolveStablePairToken({
            serviceId: params.serviceId,
            resourceId: params.resourceId,
            f1Start: params.f1Start,
            f2Start: params.f2Start,
            email: params.email,
        }),
        source: params.isDual ? "STABLE_DEGRADED" : "STABLE",
    };
}

// =============================================================================
// BLOCK 2 - PERSISTED META NORMALIZATION
// =============================================================================
export function _normalizePersistedMeta(meta) {
    if (!meta) return {};
    try {
        if (typeof meta === "string") {
            const parsed = JSON.parse(meta);
            return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
        }
        return typeof meta === "object" && !Array.isArray(meta) ? meta : {};
    } catch (_) {
        return {};
    }
}

// =============================================================================
// BLOCK 3 - UTILIDADES
// =============================================================================
function _isGuidOrNull(value) {
    const v = _safeTrim(value);
    if (!v) return null;
    return _looksLikeGuid(v) ? v : null;
}

async function _bestEffortUnlockAll(lockKeys, lockOwnerId) {
    for (var i = 0; i < (lockKeys || []).length; i++) {
        var key = lockKeys[i];
        try {
            await _unlockSlotKey(key, lockOwnerId);
        } catch (e) {
            log.warn("_bestEffortUnlockAll: failed to unlock", {
                key: key,
                error: e && e.message,
            });
        }
    }
}

// =============================================================================
// BLOCK 4 - BOOKING COMPENSATION (SAGA-06 + SAGA-PATCH-04/05)
// =============================================================================
/**
 * SAGA-PATCH-04: Compensacion alineada al esquema ControlOperativo canonico.
 * Se usa controlType + dedupeKey + payloadJson + traceId. Los campos legacy
 * kind/status/amount/concept se eliminaron (el hook los rechaza).
 * SAGA-PATCH-05: Si revision es null, se omite del body de cancelacion y se
 * registra la compensacion para reintento manual.
 */
async function _compensateCreatedBookings(createdBookings, traceId) {
    for (var i = 0; i < (createdBookings || []).length; i++) {
        var booking = createdBookings[i];
        var bookingId = (booking && booking.bookingId) || (booking && booking.id);
        if (!bookingId) continue;

        // FASE2 (ADR-06): lectura canonica bookingStatus PRIMERO.
        var status = _safeTrim(
            (booking && booking[BOOKING_FIELDS.STATUS]) || (booking && booking.status)
        ).toUpperCase();

        // SAGA-06: nunca cancelar una reserva ya confirmada, cancelada o reembolsada.
        if (status && NON_CANCELABLE_STATUSES.has(status)) {
            log.warn("Skipping compensation for non-cancelable booking", {
                bookingId: bookingId,
                status: status,
                phase: (booking && booking.phase) || null,
                traceId: traceId,
            });
            continue;
        }

        // SAGA-PATCH-05: construir body de cancelacion sin suppressAuth.
        // Si revision es null, se omite (Wix usara la ultima conocida).
        var cancelBody = {};
        if (booking && booking.revision != null) {
            cancelBody.revision = booking.revision;
        }

        try {
            await _executeWithRetry(
                function () {
                    return withTimeout(
                        function () { return cancelBookingElevated(bookingId, cancelBody); },
                        API_TIMEOUT_MS,
                        "cancelBookingCompensation"
                    );
                },
                2,
                300
            );
            log.info("Compensated booking cancelled", {
                bookingId: bookingId,
                traceId: traceId,
            });
        } catch (cancelErr) {
            log.error("Compensation cancel failed; queuing in ControlOperativo", {
                bookingId: bookingId,
                traceId: traceId,
                error: cancelErr && cancelErr.message,
            });
            // SAGA-PATCH-04: documento canonico ControlOperativo.
            var compDedupeKey = "COMP_" + bookingId + "_" + Date.now();
            try {
                await wixData.insert(COMPENSACIONESCOL, {
                    controlType: CONTROL_TYPE.SYSTEM_FLAG,
                    dedupeKey: compDedupeKey,
                    bookingId: bookingId,
                    payloadJson: JSON.stringify({
                        compensationKind: COMPENSATION_KIND.CANCEL_BOOKING,
                        phase: (booking && booking.phase) || "UNKNOWN",
                        compensationStatus: COMPENSATION_STATUS.PENDING,
                        attempts: 0,
                        lastError: (cancelErr && cancelErr.message) || "UNKNOWN",
                    }),
                    traceId: traceId,
                });
            } catch (queueErr) {
                log.error("Failed to queue compensation in ControlOperativo", {
                    bookingId: bookingId,
                    traceId: traceId,
                    error: queueErr && queueErr.message,
                });
            }
        }
    }
}

// =============================================================================
// BLOCK 5 - SELECTIVE ELEVATION + TIMEOUT (FIX-37)
// =============================================================================
async function _createBookingWithSelectiveElevation(booking, options, traceId) {
    try {
        return await withTimeout(
            function () { return bookings.createBooking(booking, options); },
            BOOKING_CREATION_TIMEOUT_MS,
            "createBooking"
        );
    } catch (err) {
        var code = _safeTrim(
            (err && err.code) || (err && err.details && err.details.applicationError && err.details.applicationError.code)
        ).toUpperCase();
        var isAccessDenied =
            code === "ACCESS_DENIED" ||
            String((err && err.message) || "").toUpperCase().indexOf("ACCESS_DENIED") >= 0;
        if (!isAccessDenied) throw err;
        log.info("Elevating createBooking due to ACCESS_DENIED", { traceId: traceId });
        return await withTimeout(
            function () { return auth.elevate(bookings.createBooking)(booking, options); },
            BOOKING_CREATION_TIMEOUT_MS,
            "createBooking:elevated"
        );
    }
}

// =============================================================================
// BLOCK 6 - VALIDACION DEFENSIVA DE RESPUESTA (FIX-42 + SAGA-PATCH-05)
// =============================================================================
/**
 * SAGA-PATCH-05: revision se preserva exactamente. Si Wix no la devuelve,
 * se retorna null (no se sustituye por 1). El llamante debe manejar null
 * como "revision desconocida" y tomar la via de compensacion manual.
 */
function _validateCreateBookingResponse(booking, phase, traceId) {
    var id = _safeTrim((booking && booking.id) || (booking && booking._id));
    if (!id || !_looksLikeGuid(id)) {
        log.error("CreateBooking returned invalid booking", {
            phase: phase,
            traceId: traceId,
            hasId: Boolean(booking && booking.id),
            has_id: Boolean(booking && booking._id),
        });
        throw createBookingError(
            ERROR_CODES.BOOKING_CREATION_FAILED,
            "Booking " + phase + " created but no valid ID returned",
            { traceId: traceId, phase: phase }
        );
    }
    var revisionRaw = (booking && booking.revision !== undefined)
        ? booking.revision
        : ((booking && booking.revisionNumber !== undefined) ? booking.revisionNumber : null);
    var revisionNum = Number(revisionRaw);
    var revision = (Number.isFinite(revisionNum) && revisionNum > 0) ? revisionNum : null;
    if (revision === null) {
        log.warn("CreateBooking returned no revision; will be null in CitasF2", {
            phase: phase,
            traceId: traceId,
            bookingId: id,
        });
    }
    return {
        bookingId: id,
        revision: revision,
        status: _safeTrim(booking && booking.status) || null,
    };
}

// =============================================================================
// BLOCK 7 - DETECCION DE FLAG DOUBLEBOOKED (FIX-38)
// =============================================================================
function _checkDoubleBookingFlag(booking, phase, traceId) {
    if (booking && booking.doubleBooked === true) {
        log.warn("DOUBLE_BOOKING_DETECTED", {
            phase: phase,
            traceId: traceId,
            bookingId: (booking && booking.id) || (booking && booking._id),
        });
        return true;
    }
    return false;
}

// =============================================================================
// BLOCK 8 - VALIDACION EXPLICITA DE GAP MAXIMO (FIX-34)
// =============================================================================
function _validateDualGap(f1LocalEnd, f2LocalStart, traceId) {
    var f1EndLocal = _normalizeLocalIsoStr(f1LocalEnd);
    var f2StartLocal = _normalizeLocalIsoStr(f2LocalStart);
    if (!f1EndLocal || !f2StartLocal) {
        throw createBookingError(
            ERROR_CODES.INVALID_DATES,
            "Dual gap validation: invalid dates",
            { traceId: traceId, f1LocalEnd: f1LocalEnd, f2LocalStart: f2LocalStart }
        );
    }
    var f1EndUtc = getUtcDateFromMadridLocal(f1EndLocal);
    var f2StartUtc = getUtcDateFromMadridLocal(f2StartLocal);
    if (!f1EndUtc || !f2StartUtc) {
        throw createBookingError(
            ERROR_CODES.INVALID_DATES,
            "Dual gap validation: could not convert to UTC",
            { traceId: traceId, f1LocalEnd: f1LocalEnd, f2LocalStart: f2LocalStart }
        );
    }
    var rawDiffMinutes = (f2StartUtc.getTime() - f1EndUtc.getTime()) / 60000;
    if (rawDiffMinutes < 0) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "Dual gap validation: F2 starts before F1 ends (" +
            rawDiffMinutes.toFixed(2) + " min)",
            { traceId: traceId, gapMinutes: rawDiffMinutes }
        );
    }
    var gapMinutes = computeGapMinutes(f1EndUtc, f2StartUtc);
    if (gapMinutes > MINUTOS_MAX_HUECO_DUAL) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "Dual gap validation: gap " + gapMinutes.toFixed(2) +
            " min exceeds MAX (" + MINUTOS_MAX_HUECO_DUAL + ")",
            { traceId: traceId, gapMinutes: gapMinutes, maxGapMinutes: MINUTOS_MAX_HUECO_DUAL }
        );
    }
    return { gapMinutes: gapMinutes, maxGapMinutes: MINUTOS_MAX_HUECO_DUAL };
}

// =============================================================================
// BLOCK 9 - VALIDACION DEL SERVICIO F2 (FIX-32, FIX-36, SAGA-08)
// =============================================================================
async function _validateLinkedPhaseService(linkedPhases, parentLocationId, traceId) {
    var linkedServiceId = _safeTrim(linkedPhases);
    if (!linkedServiceId || !_looksLikeGuid(linkedServiceId)) {
        throw createBookingError(
            ERROR_CODES.SERVICE_NOT_FOUND,
            "Linked phase service: invalid GUID",
            { traceId: traceId, linkedPhases: linkedServiceId }
        );
    }
    // SAGA-PATCH-03: sin suppressAuth (dataLegacyAdapter eleva siempre).
    var res = await wixData
        .query(SERVICIOSCOL)
        .eq("serviceId", linkedServiceId)
        .limit(1)
        .find()
        .catch(function () { return { items: [] }; });
    var service = (res && res.items && res.items[0]) || null;
    if (!service) {
        throw createBookingError(
            ERROR_CODES.SERVICE_NOT_FOUND,
            "Linked phase service " + linkedServiceId + " not found in catalog",
            { traceId: traceId }
        );
    }
    // BIBLIA 4.3 fila 20 + v5010.7 CERO LEGACY: unico campo canonico es clientHidden.
    var isHidden = service.clientHidden === true;
    if (isHidden) {
        throw createBookingError(
            ERROR_CODES.SERVICE_NOT_FOUND,
            "Linked phase service " + linkedServiceId + " is hidden",
            { traceId: traceId }
        );
    }
    var serviceType = _safeTrim(service.serviceType).toUpperCase();
    if (serviceType && serviceType !== "APPOINTMENT" && serviceType !== "CITA") {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "Linked phase service " + linkedServiceId +
            " is not APPOINTMENT (type=" + serviceType + ")",
            { traceId: traceId }
        );
    }
    var phase2Duration = Number(
        service.phase2Duration ||
        service.totalDuration ||
        service.phase1Duration ||
        0
    );
    if (phase2Duration <= 0) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "Linked phase service " + linkedServiceId +
            " has invalid duration (" + phase2Duration + ")",
            { traceId: traceId }
        );
    }
    var availableStaff = cleanGuidList(service.availableStaff || []);
    if (availableStaff.length === 0) {
        throw createBookingError(
            ERROR_CODES.STAFF_UNAVAILABLE,
            "Linked phase service " + linkedServiceId + " has no available staff",
            { traceId: traceId }
        );
    }
    var parentLoc = _safeTrim(parentLocationId);
    var f2Loc = _safeTrim(service.locationId || service.location);
    if (parentLoc && f2Loc && _looksLikeGuid(parentLoc) && _looksLikeGuid(f2Loc) &&
        parentLoc !== f2Loc) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "Linked phase service " + linkedServiceId +
            " has incompatible locationId (" + f2Loc + " != " + parentLoc + ")",
            { traceId: traceId }
        );
    }
    return { service: service, phase2Duration: phase2Duration, availableStaff: availableStaff };
}

// =============================================================================
// BLOCK 10 - COMPENSACION DE PERSISTENCIA CMS (SAGA-PATCH-03)
// =============================================================================
async function _deleteCitasByPairToken(pairToken, traceId) {
    var token = _safeTrim(pairToken);
    if (!token) return;
    try {
        // SAGA-PATCH-03: sin suppressAuth/suppressHooks.
        var res = await wixData
            .query(CITASCOL)
            .eq("pairToken", token)
            .limit(10)
            .find();
        var items = (res && res.items) || [];
        for (var i = 0; i < items.length; i++) {
            var item = items[i];
            try {
                await wixData.remove(CITASCOL, item._id);
                log.info("Compensated CitaF2 removal", {
                    citaId: item._id,
                    bookingId: item.bookingId,
                    traceId: traceId,
                });
            } catch (removeErr) {
                log.error("Failed to remove CitaF2 during compensation", {
                    citaId: item._id,
                    traceId: traceId,
                    error: removeErr && removeErr.message,
                });
            }
        }
    } catch (err) {
        log.error("_deleteCitasByPairToken failed", {
            pairToken: token,
            traceId: traceId,
            error: err && err.message,
        });
    }
}

// =============================================================================
// BLOCK 11 - ADDONS (FIX-35 + SAGA-04 + SAGA-PATCH-01/06)
// =============================================================================
/**
 * SAGA-PATCH-06: Fail-closed. Si un add-on solicitado no mapea a un GUID
 * nativo del catalogo del servicio, se lanza INVALID_PAYLOAD. Nunca se
 * reserva sin el add-on seleccionado ni se usan precios del cliente.
 */
function _detectAddons(unsafePayload, metaCita, serviceConfig, traceId) {
    var rawAddons =
        (unsafePayload && unsafePayload.nativeAddonIds) ||
        (unsafePayload && unsafePayload.addOnIds) ||
        (metaCita && metaCita.nativeAddonIds) ||
        (metaCita && metaCita.addOnIds) ||
        [];
    var requested = Array.isArray(rawAddons)
        ? rawAddons
            .map(function (id) { return _safeTrim(id); })
            .filter(function (id) { return _looksLikeGuid(id); })
        : [];
    var unique = Array.from(new Set(requested));

    // SAGA-04: limite BIBLIA 3.2 fila 10 (MAX_POR_RESERVA = 5).
    if (unique.length > MAX_ADDONS_PER_BOOKING) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "Too many addOnOptions requested (" + unique.length +
            "). Maximum allowed is " + MAX_ADDONS_PER_BOOKING + ".",
            { traceId: traceId, addonCount: unique.length, max: MAX_ADDONS_PER_BOOKING }
        );
    }

    // Catalogo de add-ons del servicio (GUIDs nativos).
    var catalogAddons = Array.isArray(serviceConfig && serviceConfig.metadata && serviceConfig.metadata.addOnOptions)
        ? serviceConfig.metadata.addOnOptions
        : [];
    var allowedSet = new Set();
    for (var c = 0; c < catalogAddons.length; c++) {
        var catAddon = catalogAddons[c];
        var nativeId = _safeTrim(catAddon && catAddon.nativeId);
        var addonId = _safeTrim(catAddon && catAddon.id);
        if (nativeId) allowedSet.add(nativeId);
        if (addonId) allowedSet.add(addonId);
    }

    // SAGA-PATCH-06: fail-closed si hay add-ons solicitados pero el catalogo
    // no los contiene. Si no hay catalogo definido, se acepta todo (servicio
    // sin restricciones de add-ons documentadas).
    if (unique.length > 0 && allowedSet.size > 0) {
        var unmapped = [];
        var validated = [];
        for (var u = 0; u < unique.length; u++) {
            if (allowedSet.has(unique[u])) {
                validated.push(unique[u]);
            } else {
                unmapped.push(unique[u]);
            }
        }
        if (unmapped.length > 0) {
            throw createBookingError(
                ERROR_CODES.INVALID_PAYLOAD,
                "Requested addOnOptions not found in service catalog: " +
                unmapped.join(", ") + ". Booking aborted to prevent charging " +
                "without selected add-ons.",
                { traceId: traceId, unmapped: unmapped, catalogSize: allowedSet.size }
            );
        }
        return validated;
    }

    if (unique.length > 0) {
        log.info("SAGA-04: injecting addOnIds into bookedEntity.slot", {
            traceId: traceId,
            addonCount: unique.length,
            addOnIds: unique,
        });
    }
    return unique;
}

/**
 * SAGA-PATCH-01: Helper local. bookingCore NO exporta _buildBookedAddOns.
 * Construye el array de objetos { addOnId } para el slot del Writer V2.
 */
function _buildBookedAddOns(nativeAddonIds) {
    var ids = Array.isArray(nativeAddonIds) ? nativeAddonIds : [];
    return Array.from(new Set(ids.map(function (id) {
        return _safeTrim(id);
    }).filter(function (id) {
        return _looksLikeGuid(id);
    }))).map(function (addOnId) {
        return { addOnId: addOnId };
    });
}

/**
 * SAGA-04: campos de addon a fusionar en el slot antes de _forceStaffInPristineSlot.
 * Se exponen ambas claves porque el contrato del Writer V2 ha usado
 * historicamente addOnIds y selectedAddOns.
 */
function _buildAddonSlotFields(addOnIds) {
    if (!Array.isArray(addOnIds) || addOnIds.length === 0) return {};
    return {
        addOnIds: addOnIds.slice(),
        selectedAddOns: addOnIds.slice(),
    };
}

// =============================================================================
// BLOCK 12 - UBICACION OWNER_BUSINESS (SAGA-03)
// =============================================================================
function _resolveBookingLocation(params) {
    var validatedSlotF1 = params.validatedSlotF1;
    var validatedSlotF2 = params.validatedSlotF2;
    var serviceConfig = params.serviceConfig;
    var parentLocationId = params.parentLocationId;
    var traceId = params.traceId;

    var resolvedId =
        _isGuidOrNull(validatedSlotF1 && validatedSlotF1.location && validatedSlotF1.location.id) ||
        _isGuidOrNull(validatedSlotF2 && validatedSlotF2.location && validatedSlotF2.location.id) ||
        _isGuidOrNull(serviceConfig && serviceConfig.locationId) ||
        _isGuidOrNull(parentLocationId);
    if (!resolvedId) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "Booking location is missing. Cannot build OWNER_BUSINESS location.",
            { traceId: traceId }
        );
    }
    var sourceLocationType = _safeTrim(
        validatedSlotF1 && validatedSlotF1.location && validatedSlotF1.location.locationType
    ).toUpperCase();
    if (sourceLocationType && sourceLocationType !== "OWNER_BUSINESS") {
        log.info("SAGA-03: overriding locationType for booking creation", {
            traceId: traceId,
            from: sourceLocationType,
            to: "OWNER_BUSINESS",
            locationId: resolvedId,
        });
    }
    return Object.freeze({
        id: resolvedId,
        locationType: "OWNER_BUSINESS",
    });
}

/**
 * SAGA-03: guard contractual. Bloquea la creacion si el pristine slot no
 * cumple BIBLIA 2.2.1. Fallar aqui es barato; fallar en Wix deja reservas
 * huerfanas que requieren compensacion.
 */
function _assertPristineSlotContract(pristineSlot, phase, traceId) {
    var startIso = _safeTrim(pristineSlot && pristineSlot.startDate);
    var endIso = _safeTrim(pristineSlot && pristineSlot.endDate);
    var locationType = _safeTrim(
        pristineSlot && pristineSlot.location && pristineSlot.location.locationType
    ).toUpperCase();
    var missing = [];
    if (!_isGuidOrNull(pristineSlot && pristineSlot.serviceId)) missing.push("serviceId");
    if (!_isGuidOrNull(pristineSlot && pristineSlot.scheduleId)) missing.push("scheduleId");
    if (!startIso) missing.push("startDate");
    else if (!/Z$/.test(startIso)) missing.push("startDate must be ISO UTC with Z");
    if (!endIso) missing.push("endDate");
    else if (!/Z$/.test(endIso)) missing.push("endDate must be ISO UTC with Z");
    if (!_isGuidOrNull(pristineSlot && pristineSlot.resource && pristineSlot.resource.id)) missing.push("resource.id");
    if (!_isGuidOrNull(pristineSlot && pristineSlot.location && pristineSlot.location.id)) missing.push("location.id");
    if (locationType !== "OWNER_BUSINESS") {
        missing.push("location.locationType must be OWNER_BUSINESS");
    }
    if (missing.length > 0) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "Pristine slot " + phase + " violates createBooking contract: " +
            missing.join("; "),
            { traceId: traceId, phase: phase, missing: missing }
        );
    }
    return true;
}

// =============================================================================
// BLOCK 13 - SAGA ORCHESTRATOR
// =============================================================================
export class BookingSagaOrchestrator {
    constructor(traceId) {
        this.traceId = traceId;
        this.steps = [];
        this.completedSteps = [];
    }
    addStep(name, executeFn, compensateFn) {
        this.steps.push({
            name: name,
            executeFn: executeFn,
            compensateFn: compensateFn,
        });
    }
    async execute() {
        for (var i = 0; i < this.steps.length; i++) {
            var step = this.steps[i];
            try {
                log.info("Saga step: " + step.name, { traceId: this.traceId });
                var result = await step.executeFn();
                this.completedSteps.push(Object.assign({}, step, { result: result }));
            } catch (error) {
                log.error("Saga step failed: " + step.name, {
                    traceId: this.traceId,
                    error: error && error.message,
                });
                await this._compensate();
                throw error;
            }
        }
        return this.completedSteps.map(function (s) { return s.result; });
    }
    async _compensate() {
        var reversed = [].concat(this.completedSteps).reverse();
        for (var i = 0; i < reversed.length; i++) {
            var step = reversed[i];
            if (step.compensateFn) {
                try {
                    log.info("Saga compensating: " + step.name, { traceId: this.traceId });
                    await step.compensateFn(step.result);
                } catch (compErr) {
                    log.error("Saga compensation failed: " + step.name, {
                        traceId: this.traceId,
                        error: compErr && compErr.message,
                    });
                }
            }
        }
    }
}

// =============================================================================
// BLOCK 14 - EXECUTE BOOKING SAGA (MAIN FUNCTION)
// =============================================================================
export async function executeBookingSaga(unsafePayload) {
    var traceId = (unsafePayload && unsafePayload.traceId) || makeTraceId("saga");
    var metaCita = _normalizePersistedMeta(
        (unsafePayload && unsafePayload.metaCita) || (unsafePayload && unsafePayload.meta) || {}
    );
    try {
        // =========================================================================
        // PHASE 0: VALIDATION AND RESOLUTION
        // =========================================================================
        var email = _safeTrim(
            (unsafePayload && unsafePayload.email) ||
            metaCita.email ||
            (unsafePayload && unsafePayload.contactDetails && unsafePayload.contactDetails.email)
        );
        if (!email) {
            throw createBookingError(ERROR_CODES.INVALID_PAYLOAD, "Email is required", { traceId: traceId });
        }
        var rawServiceId = _safeTrim((unsafePayload && unsafePayload.serviceId) || metaCita.serviceId || "");
        var serviceId = await _resolveServiceIdInternal(rawServiceId);
        if (!serviceId || !_looksLikeGuid(serviceId)) {
            throw createBookingError(ERROR_CODES.SERVICE_NOT_FOUND, "Service not found", { traceId: traceId, rawServiceId: rawServiceId });
        }
        var serviceRes = await _getServiceBySlugOrIdInternal(serviceId, traceId);
        var serviceConfig = (serviceRes && serviceRes.data) || {};
        var isDual =
            serviceConfig.allowCombine === true &&
            !!serviceConfig.linkedPhases &&
            _looksLikeGuid(serviceConfig.linkedPhases);
        var linkedPhases = isDual ? serviceConfig.linkedPhases : null;
        var parentLocationId = _safeTrim(serviceConfig.locationId || serviceConfig.location);
        var requestedResourceId = _safeTrim((unsafePayload && unsafePayload.resourceId) || metaCita.resourceId);
        var slotF1Input = (unsafePayload && unsafePayload.slotF1) || {};
        var slotF2Input = (unsafePayload && unsafePayload.slotF2) || {};
        var f1LocalStart = _normalizeLocalIsoStr(slotF1Input.localStartDate || slotF1Input.start || metaCita.f1Start);
        var f1LocalEnd = _normalizeLocalIsoStr(slotF1Input.localEndDate || slotF1Input.end || metaCita.f1End);
        if (!f1LocalStart || !f1LocalEnd) {
            throw createBookingError(ERROR_CODES.INVALID_PAYLOAD, "F1 slot dates are required", { traceId: traceId });
        }
        var f2LocalStart = "";
        var f2LocalEnd = "";
        if (isDual) {
            f2LocalStart = _normalizeLocalIsoStr(slotF2Input.localStartDate || slotF2Input.start || metaCita.f2Start);
            f2LocalEnd = _normalizeLocalIsoStr(slotF2Input.localEndDate || slotF2Input.end || metaCita.f2End);
            var linkedValidation = await _validateLinkedPhaseService(linkedPhases, parentLocationId, traceId);
            if (!f2LocalStart) {
                var f1EndUtc = getUtcDateFromMadridLocal(f1LocalEnd);
                if (!f1EndUtc) {
                    throw createBookingError(ERROR_CODES.INVALID_DATES, "Could not compute F1 end UTC for F2 derivation", { traceId: traceId });
                }
                var exposureMs = Math.max(0, Number(serviceConfig.exposureDuration || 0)) * 60 * 1000;
                var linkedPhase2Ms = Math.max(0, Number(linkedValidation.phase2Duration || 30)) * 60 * 1000;
                var f2StartUtc = new Date(f1EndUtc.getTime() + exposureMs);
                var f2EndUtc = new Date(f2StartUtc.getTime() + linkedPhase2Ms);
                f2LocalStart = getMadridLocalStringNoZ(f2StartUtc);
                f2LocalEnd = getMadridLocalStringNoZ(f2EndUtc);
            }
            _validateDualGap(f1LocalEnd, f2LocalStart, traceId);
        }
        // SAGA-04 + SAGA-PATCH-06: addOnOptions detectados y validados fail-closed.
        var detectedAddonIds = _detectAddons(unsafePayload, metaCita, serviceConfig, traceId);
        var addonSlotFields = _buildAddonSlotFields(detectedAddonIds);

        // =========================================================================
        // PHASE 1: REAL-TIME REVALIDATION
        // =========================================================================
        var resourceValidation = await _resolveStaffForSlotInternal({
            serviceId: serviceId,
            f1Start: f1LocalStart,
            f1End: f1LocalEnd,
            f2Start: isDual ? f2LocalStart : null,
            f2End: isDual ? f2LocalEnd : null,
            requestedResourceId: requestedResourceId || null,
            addOnIds: detectedAddonIds,
            traceId: traceId,
        });
        if (!resourceValidation || resourceValidation.status !== "SUCCESS") {
            throw createBookingError(
                (resourceValidation && resourceValidation.error && resourceValidation.error.code) || ERROR_CODES.SLOT_UNAVAILABLE,
                (resourceValidation && resourceValidation.error && resourceValidation.error.message) || "Slot no longer available",
                { traceId: traceId }
            );
        }
        var finalResourceId = resourceValidation.data.resourceId;
        var validatedSlotF1 = resourceValidation.data.slotF1;
        var validatedSlotF2 = resourceValidation.data.slotF2;
        if (isDual && validatedSlotF1 && validatedSlotF2) {
            var f1EndFromValidated = _normalizeLocalIsoStr(
                validatedSlotF1.localEndDate || validatedSlotF1.endDate || f1LocalEnd
            );
            var f2StartFromValidated = _normalizeLocalIsoStr(
                validatedSlotF2.localStartDate || validatedSlotF2.startDate || f2LocalStart
            );
            _validateDualGap(f1EndFromValidated, f2StartFromValidated, traceId);
        }

        // =========================================================================
        // PHASE 2: PAIR TOKEN UNIFICADO (SAGA-02)
        // =========================================================================
        var tokenResolution = _resolveUnifiedPairToken({
            suppliedPairToken: (unsafePayload && unsafePayload.pairToken) || metaCita.pairToken,
            isDual: isDual,
            serviceId: serviceId,
            linkedPhases: linkedPhases,
            f1Start: f1LocalStart,
            f1End: f1LocalEnd,
            f2Start: f2LocalStart,
            f2End: f2LocalEnd,
            resourceId: finalResourceId || requestedResourceId,
            email: email,
            traceId: traceId,
        });
        var pairToken = tokenResolution.pairToken;
        log.info("SAGA-02: pairToken resolved", {
            traceId: traceId,
            source: tokenResolution.source,
            isDual: isDual,
            pairToken: pairToken,
        });

        // SAGA-03: ubicacion OWNER_BUSINESS garantizada para la creacion.
        var bookingLocation = _resolveBookingLocation({
            validatedSlotF1: validatedSlotF1,
            validatedSlotF2: validatedSlotF2,
            serviceConfig: serviceConfig,
            parentLocationId: parentLocationId,
            traceId: traceId,
        });

        // =========================================================================
        // SAGA-PATCH-02: PAYLOAD HASH + INIT TRANSACTION ANTES DE CUALQUIER
        // RETORNO IDEMPOTENTE. El early-return de CitasF2 se ELIMINA porque
        // permitia tokens reutilizados con payload distinto. La transaccion
        // canonica en ControlOperativo es la unica puerta de idempotencia.
        // =========================================================================
        var payloadHash = _hashKey(
            _stableSerialize({
                serviceId: serviceId,
                resourceId: finalResourceId || requestedResourceId,
                f1LocalStart: f1LocalStart,
                f1LocalEnd: f1LocalEnd,
                f2LocalStart: f2LocalStart,
                f2LocalEnd: f2LocalEnd,
                email: email,
                addOnIds: detectedAddonIds,
            })
        );
        var txResult = await _initTransaction(pairToken, payloadHash, traceId);
        if (!txResult.success) {
            if (txResult.error === "PAIR_TOKEN_PAYLOAD_MISMATCH") {
                throw createBookingError(
                    ERROR_CODES.INVALID_PAYLOAD,
                    "Payload mismatch for existing pairToken",
                    { traceId: traceId }
                );
            }
            if (txResult.error === "TRANSACTION_PREVIOUSLY_FAILED") {
                throw createBookingError(
                    ERROR_CODES.BOOKING_CREATION_FAILED,
                    "Previous transaction failed",
                    { traceId: traceId }
                );
            }
            // SAGA-PATCH-02: el resultado existente viene de _readTransaction,
            // cuyo resultado anidado esta en existing.result.
            if (txResult.existing && txResult.existing.status === "COMPLETED") {
                return {
                    status: "SUCCESS",
                    data: txResult.existing.result,
                    error: null,
                    idempotent: true,
                };
            }
            throw createBookingError(
                ERROR_CODES.TOKEN_BUSY,
                "Transaction in progress or timeout",
                { traceId: traceId }
            );
        }

        // =========================================================================
        // PHASE 5: ACQUIRE LOCKS + HEARTBEAT
        // SAGA-PATCH-07: requiere bookingCore v5010.8+ (parser 5 piezas).
        // =========================================================================
        var phases = [{
            rawSlot: Object.assign({}, validatedSlotF1, { serviceId: serviceId }),
            localStart: f1LocalStart,
            localEnd: f1LocalEnd,
        }];
        if (isDual && f2LocalStart) {
            phases.push({
                rawSlot: Object.assign({}, validatedSlotF2, { serviceId: linkedPhases }),
                localStart: f2LocalStart,
                localEnd: f2LocalEnd,
            });
        }
        var lockKeys = _buildLockKeys(phases, finalResourceId);
        var lockOwnerId = pairToken;
        var heartbeatInterval = null;
        var saga = new BookingSagaOrchestrator(traceId);
        var createdBookings = [];

        saga.addStep(
            "LockSlots",
            async function () {
                for (var li = 0; li < lockKeys.length; li++) {
                    var lockKey = lockKeys[li];
                    var lockResult = await _lockSlotKeyOrFail(lockKey, lockOwnerId, LOCKTTLMS);
                    if (!lockResult || !lockResult.ok) {
                        throw createBookingError(
                            ERROR_CODES.TOKEN_BUSY,
                            "Lock failed: " + ((lockResult && lockResult.message) || "unknown"),
                            { traceId: traceId, lockKey: lockKey }
                        );
                    }
                }
                heartbeatInterval = setInterval(function () {
                    lockKeys.forEach(function (key) {
                        _renewLock(key, lockOwnerId, LOCKTTLMS).catch(function (err) {
                            log.warn("heartbeat: lock renewal failed", {
                                key: key,
                                traceId: traceId,
                                error: err && err.message,
                            });
                        });
                    });
                }, HEARTBEATMS);
                return { lockKeys: lockKeys };
            },
            async function () {
                if (heartbeatInterval) {
                    clearInterval(heartbeatInterval);
                    heartbeatInterval = null;
                }
                await _bestEffortUnlockAll(lockKeys, lockOwnerId);
            }
        );

        // =========================================================================
        // CREACION SECUENCIAL F1 -> F2
        // SAGA-01: skipAvailabilityValidation = false
        // SAGA-03: location OWNER_BUSINESS + guard de contrato
        // SAGA-04: addOnIds inyectados
        // =========================================================================
        saga.addStep(
            "CreateBookings",
            async function () {
                var contactDetails = {
                    firstName: _safeTrim((unsafePayload && unsafePayload.firstName) || metaCita.firstName || ""),
                    lastName: _safeTrim((unsafePayload && unsafePayload.lastName) || metaCita.lastName || ""),
                    email: email,
                    phone: _safeTrim((unsafePayload && unsafePayload.phone) || metaCita.phone || ""),
                };
                // SAGA-01: opciones unicas para ambas fases.
                var bookingOptions = Object.freeze({
                    flowControlSettings: Object.freeze({
                        skipAvailabilityValidation: SKIP_AVAILABILITY_VALIDATION,
                    }),
                });
                var bookingF1 = null;
                var bookingF2 = null;
                var pristineF2 = null;
                var f2Meta = null;

                // ---------------- F1 ----------------
                var pristineF1 = await _forceStaffInPristineSlot(
                    Object.assign({}, validatedSlotF1, { location: bookingLocation }, addonSlotFields),
                    finalResourceId,
                    serviceId,
                    serviceConfig.phase1Duration
                );
                if (!pristineF1) {
                    throw createBookingError(ERROR_CODES.INVALID_PAYLOAD, "Failed to build pristine slot F1", { traceId: traceId });
                }
                pristineF1.location = bookingLocation;
                _assertPristineSlotContract(pristineF1, "F1", traceId);

                var bookingBodyF1 = {
                    bookedEntity: { slot: pristineF1 },
                    contactDetails: contactDetails,
                    totalParticipants: 1,
                };
                var payMethodEarly = _safeTrim(
                    (unsafePayload && unsafePayload.paymentMethod) ||
                    (PAYMENT_METHOD && PAYMENT_METHOD.ONLINE) ||
                    "ONLINE"
                ).toUpperCase();
                if (
                    payMethodEarly === _safeTrim(PAYMENT_METHOD && PAYMENT_METHOD.ONLINE).toUpperCase() ||
                    payMethodEarly === "ONLINE"
                ) {
                    bookingBodyF1.selectedPaymentOption = "ONLINE";
                }

                var resF1 = await _createBookingWithSelectiveElevation(bookingBodyF1, bookingOptions, traceId);
                bookingF1 = (resF1 && resF1.booking) || resF1;
                var f1Meta = _validateCreateBookingResponse(bookingF1, "F1", traceId);
                _checkDoubleBookingFlag(bookingF1, "F1", traceId);
                createdBookings.push({
                    bookingId: f1Meta.bookingId,
                    revision: f1Meta.revision,
                    status: f1Meta.status,
                    phase: "F1",
                });

                // ---------------- F2 (solo dual) ----------------
                if (isDual && f2LocalStart && validatedSlotF2) {
                    pristineF2 = await _forceStaffInPristineSlot(
                        Object.assign({}, validatedSlotF2, { location: bookingLocation }, addonSlotFields),
                        finalResourceId,
                        linkedPhases,
                        serviceConfig.phase2Duration
                    );
                    if (!pristineF2) {
                        throw createBookingError(ERROR_CODES.INVALID_PAYLOAD, "Failed to build pristine slot F2", { traceId: traceId });
                    }
                    pristineF2.location = bookingLocation;
                    _assertPristineSlotContract(pristineF2, "F2", traceId);

                    var bookingBodyF2 = {
                        bookedEntity: { slot: pristineF2 },
                        contactDetails: contactDetails,
                        totalParticipants: 1,
                    };
                    if (
                        payMethodEarly === _safeTrim(PAYMENT_METHOD && PAYMENT_METHOD.ONLINE).toUpperCase() ||
                        payMethodEarly === "ONLINE"
                    ) {
                        bookingBodyF2.selectedPaymentOption = "ONLINE";
                    }

                    var resF2 = await _createBookingWithSelectiveElevation(bookingBodyF2, bookingOptions, traceId);
                    bookingF2 = (resF2 && resF2.booking) || resF2;
                    f2Meta = _validateCreateBookingResponse(bookingF2, "F2", traceId);
                    _checkDoubleBookingFlag(bookingF2, "F2", traceId);
                    createdBookings.push({
                        bookingId: f2Meta.bookingId,
                        revision: f2Meta.revision,
                        status: f2Meta.status,
                        phase: "F2",
                    });
                }
                return {
                    bookingF1: bookingF1,
                    bookingF2: bookingF2,
                    createdBookings: createdBookings,
                    scheduleIdF1: _safeTrim(pristineF1 && pristineF1.scheduleId) || null,
                    scheduleIdF2: _safeTrim(pristineF2 && pristineF2.scheduleId) || null,
                    revisionF1: f1Meta.revision,
                    revisionF2: (f2Meta && f2Meta.revision) || null,
                };
            },
            async function () {
                await _compensateCreatedBookings(createdBookings, traceId);
            }
        );

        // =========================================================================
        // CHECKOUT ONLINE / CONFIRMACION PRESENCIAL
        // SAGA-05: PAYMENT_STATUS.NOT_PAID (sin literales)
        // =========================================================================
        var paymentMethod = _safeTrim(
            (unsafePayload && unsafePayload.paymentMethod) || metaCita.paymentMethod || "PRESENCIAL"
        ).toUpperCase();
        var isOnline = paymentMethod === _safeTrim(PAYMENT_METHOD && PAYMENT_METHOD.ONLINE).toUpperCase();

        saga.addStep(
            isOnline ? "CreateCheckout" : "ConfirmPresencial",
            async function () {
                if (isOnline) {
                    var bookingIds = createdBookings
                        .map(function (b) { return b.bookingId; })
                        .filter(Boolean);
                    var checkoutPayload = {
                        lineItems: bookingIds.map(function (bookingId) {
                            return {
                                catalogReference: {
                                    appId: APP_IDS.BOOKINGS,
                                    catalogItemId: bookingId,
                                    options: {},
                                },
                                quantity: 1,
                            };
                        }),
                        channelType: "WEB",
                    };
                    var checkoutRes = await withTimeout(
                        function () { return createCheckoutElevated(checkoutPayload); },
                        CHECKOUT_TIMEOUT_MS,
                        "createCheckout"
                    );
                    var checkoutUrl = await _executeWithRetry(
                        function () {
                            return withTimeout(
                                function () { return getCheckoutUrlElevated(_extractCheckoutId(checkoutRes)); },
                                API_TIMEOUT_MS,
                                "getCheckoutUrl"
                            );
                        },
                        2,
                        300
                    );
                    return {
                        requiresPayment: true,
                        checkoutUrl: checkoutUrl,
                        bookingIds: bookingIds,
                    };
                }
                // Confirmacion presencial
                for (var ci = 0; ci < createdBookings.length; ci++) {
                    var booking = createdBookings[ci];
                    var confirmResult = await _executeWithRetry(
                        function () {
                            return withTimeout(
                                function () {
                                    return confirmOrDeclineBookingElevated(booking.bookingId, {
                                        // SAGA-05: constante SSOT, nunca literal.
                                        paymentStatus: PAYMENT_STATUS_NOT_PAID,
                                    });
                                },
                                API_TIMEOUT_MS,
                                "confirmOrDecline"
                            );
                        },
                        2,
                        300
                    );
                    _checkDoubleBookingFlag(confirmResult, "CONFIRM_" + booking.phase, traceId);
                    // SAGA-06: tras confirmar, el booking pasa a CONFIRMED.
                    // FASE2 (ADR-06): se escribe en bookingStatus (canonico).
                    booking.bookingStatus =
                        _safeTrim(confirmResult && confirmResult.booking && confirmResult.booking.bookingStatus) ||
                        _safeTrim(confirmResult && confirmResult.booking && confirmResult.booking.status) ||
                        _safeTrim(confirmResult && confirmResult.bookingStatus) ||
                        _safeTrim(confirmResult && confirmResult.status) ||
                        BOOKING_STATUS_CONFIRMED;
                }
                return {
                    requiresPayment: false,
                    bookingIds: createdBookings.map(function (b) { return b.bookingId; }),
                };
            },
            async function () {}
        );

        var paymentStatus = isOnline ? PAYMENT_STATUS_PENDING : PAYMENT_STATUS_NOT_PAID;
        var citaStatus = isOnline ? BOOKING_STATUS_PENDING_PAYMENT : BOOKING_STATUS_CONFIRMED;

        // =========================================================================
        // PERSISTENCIA EN CitasF2 (BIBLIA 4.6)
        // =========================================================================
        saga.addStep(
            "PersistCitas",
            async function () {
                var checkoutStepName = isOnline ? "CreateCheckout" : "ConfirmPresencial";
                var checkoutStepResult = null;
                var createBookingsResult = {};
                for (var si = 0; si < saga.completedSteps.length; si++) {
                    var cs = saga.completedSteps[si];
                    if (cs.name === checkoutStepName) checkoutStepResult = cs.result;
                    if (cs.name === "CreateBookings") createBookingsResult = cs.result || {};
                }
                var resolvedCheckoutUrl = (checkoutStepResult && checkoutStepResult.checkoutUrl) || null;
                var bookingF1Id = null;
                var bookingF2Id = null;
                for (var bi = 0; bi < createdBookings.length; bi++) {
                    if (createdBookings[bi].phase === "F1") bookingF1Id = createdBookings[bi].bookingId;
                    if (createdBookings[bi].phase === "F2") bookingF2Id = createdBookings[bi].bookingId;
                }
                var revisionF1 = Number(createBookingsResult.revisionF1) || 1;
                var revisionF2 = Number(createBookingsResult.revisionF2) || 1;
                var scheduleIdF1 = _isGuidOrNull(createBookingsResult.scheduleIdF1);
                if (!scheduleIdF1) {
                    scheduleIdF1 = await _resolveScheduleIdForResource(finalResourceId, validatedSlotF1);
                }
                if (!scheduleIdF1) {
                    throw createBookingError(ERROR_CODES.INVALID_PAYLOAD, "Unable to resolve scheduleId for F1", { traceId: traceId, bookingId: bookingF1Id });
                }
                await _persistBooking({
                    bookingId: bookingF1Id,
                    revision: revisionF1,
                    serviceId: serviceId,
                    scheduleId: scheduleIdF1,
                    resourceId: finalResourceId,
                    startDate: getUtcDateFromMadridLocal(f1LocalStart),
                    endDate: getUtcDateFromMadridLocal(f1LocalEnd),
                    bookingType: isDual ? BOOKING_TYPE.DUALF1 : BOOKING_TYPE.SIMPLE,
                    bookingStatus: citaStatus,
                    paymentStatus: paymentStatus,
                    pairToken: pairToken,
                    contactDetails: { email: email },
                    meta: {
                        pairToken: pairToken,
                        pairTokenSource: tokenResolution.source,
                        f1Start: f1LocalStart,
                        f1End: f1LocalEnd,
                        f2Start: f2LocalStart || null,
                        f2End: f2LocalEnd || null,
                        checkoutUrl: resolvedCheckoutUrl,
                        nativeAddonIds: detectedAddonIds,
                        addOnIds: detectedAddonIds,
                        locationType: "OWNER_BUSINESS",
                        writerRevision: revisionF1,
                    },
                    traceId: traceId,
                }, traceId);

                if (isDual && bookingF2Id) {
                    var scheduleIdF2 = _isGuidOrNull(createBookingsResult.scheduleIdF2);
                    if (!scheduleIdF2) {
                        scheduleIdF2 = await _resolveScheduleIdForResource(finalResourceId, validatedSlotF2);
                    }
                    if (!scheduleIdF2) {
                        throw createBookingError(ERROR_CODES.INVALID_PAYLOAD, "Unable to resolve scheduleId for F2", { traceId: traceId, bookingId: bookingF2Id });
                    }
                    await _persistBooking({
                        bookingId: bookingF2Id,
                        revision: revisionF2,
                        serviceId: linkedPhases,
                        scheduleId: scheduleIdF2,
                        resourceId: finalResourceId,
                        startDate: getUtcDateFromMadridLocal(f2LocalStart),
                        endDate: getUtcDateFromMadridLocal(f2LocalEnd),
                        bookingType: BOOKING_TYPE.DUALF2,
                        bookingStatus: citaStatus,
                        paymentStatus: paymentStatus,
                        pairToken: pairToken,
                        contactDetails: { email: email },
                        meta: {
                            pairToken: pairToken,
                            pairTokenSource: tokenResolution.source,
                            linkedF1BookingId: bookingF1Id,
                            nativeAddonIds: detectedAddonIds,
                            addOnIds: detectedAddonIds,
                            locationType: "OWNER_BUSINESS",
                            writerRevision: revisionF2,
                        },
                        traceId: traceId,
                    }, traceId);
                }
                return {
                    bookingF1Id: bookingF1Id,
                    bookingF2Id: bookingF2Id || null,
                    resolvedCheckoutUrl: resolvedCheckoutUrl,
                    citaStatus: citaStatus,
                    isOnline: isOnline,
                    revisionF1: revisionF1,
                    revisionF2: revisionF2,
                };
            },
            async function () {
                await _deleteCitasByPairToken(pairToken, traceId);
            }
        );

        // =========================================================================
        // PHASE 6: EXECUTE SAGA
        // =========================================================================
        var sagaStartTime = Date.now();
        try {
            await saga.execute();
            var persistStepResult = null;
            for (var pi = 0; pi < saga.completedSteps.length; pi++) {
                if (saga.completedSteps[pi].name === "PersistCitas") {
                    persistStepResult = saga.completedSteps[pi].result;
                }
            }
            var finalResult = {
                bookingIds: createdBookings.map(function (b) { return b.bookingId; }),
                bookingId: null,
                pairToken: pairToken,
                pairTokenSource: tokenResolution.source,
                isDual: isDual,
                resourceId: finalResourceId,
                location: bookingLocation,
                requiresPayment: isOnline,
                checkoutUrl: (persistStepResult && persistStepResult.resolvedCheckoutUrl) || null,
                status: (persistStepResult && persistStepResult.citaStatus) || citaStatus,
                paymentStatus: paymentStatus,
                addOnIds: detectedAddonIds,
            };
            for (var fi = 0; fi < createdBookings.length; fi++) {
                if (createdBookings[fi].phase === "F1") {
                    finalResult.bookingId = createdBookings[fi].bookingId;
                    break;
                }
            }
            try {
                await _completeTransaction(pairToken, finalResult, traceId);
            } catch (completeErr) {
                log.error("_completeTransaction failed; compensating full saga", {
                    pairToken: pairToken,
                    traceId: traceId,
                    error: completeErr && completeErr.message,
                });
                try { await _deleteCitasByPairToken(pairToken, traceId); } catch (_) { /* best effort */ }
                try { await _compensateCreatedBookings(createdBookings, traceId); } catch (_) { /* best effort */ }
                throw completeErr;
            }
            var madridDateYMD = f1LocalStart.slice(0, 10);
            setTimeout(function () {
                _invalidateCachesInternal(serviceId, madridDateYMD, finalResourceId, traceId)
                    .catch(function (e) {
                        log.warn("Post-commit cache invalidation failed (background)", {
                            traceId: traceId,
                            error: e && e.message,
                        });
                    });
            }, 0);
            log.info("executeBookingSaga completed", {
                traceId: traceId,
                pairToken: pairToken,
                pairTokenSource: tokenResolution.source,
                isDual: isDual,
                bookingIds: createdBookings.map(function (b) { return b.bookingId; }),
                locationType: bookingLocation.locationType,
                addonCount: detectedAddonIds.length,
                requiresPayment: isOnline,
                skipAvailabilityValidation: SKIP_AVAILABILITY_VALIDATION,
                elapsedMs: Date.now() - sagaStartTime,
            });
            return { status: "SUCCESS", data: finalResult, error: null };
        } catch (sagaErr) {
            try {
                await _failTransaction(
                    pairToken,
                    (normalizeError(sagaErr) && normalizeError(sagaErr).code) || "SAGA_FAILED"
                );
            } catch (failErr) {
                log.warn("_failTransaction could not be recorded", {
                    pairToken: pairToken,
                    traceId: traceId,
                    error: failErr && failErr.message,
                });
            }
            throw sagaErr;
        } finally {
            if (heartbeatInterval) {
                clearInterval(heartbeatInterval);
                heartbeatInterval = null;
            }
            await _bestEffortUnlockAll(lockKeys, lockOwnerId).catch(function () {});
        }
    } catch (error) {
        var norm = normalizeError(error);
        log.error("executeBookingSaga failed", {
            code: norm.code,
            error: norm.message,
            traceId: traceId,
        });
        return {
            status: "ERROR",
            data: null,
            error: {
                code: norm.code || ERROR_CODES.UNKNOWN_ERROR,
                message: norm.message,
            },
        };
    }
}
