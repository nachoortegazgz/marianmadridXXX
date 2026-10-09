/*
=============================================================================
MODULE: backend/booking/bookingSaga.js
VERSION: v5010.1-BOOKINGS-ALIGN
BASE: v5009-FISCAL-V20.4-SAGA + Wix Bookings API alignment pass
SSOT: SSOT CONSOLIDADO v5002.6 | BIBLIA v5009-V20-FINAL-CONSOLIDATED-v4
MISSION: Orquestador transaccional. Saga compensable para reservas simples
         y duales con gap de exposicion. Gestiona locks, heartbeat,
         idempotencia triple capa y creacion SECUENCIAL F1 -> F2.
STANDARDS: G10 ASCII Strict (0 non-ASCII characters).

FIXES APLICADOS v5010.1-BOOKINGS-ALIGN:
  - SAGA-10: _compensateCreatedBookings propaga revision a
             cancelBookingElevated. Wix Bookings exige el parametro revision
             en cancelBooking para prevenir conflictos de concurrencia
             ("To prevent conflicting changes, the current revision must be
             specified when managing the booking"). Si el booking entry no
             trae revision valido, NO se intenta cancelar: se encola una
             compensacion manual con lastError=MISSING_REVISION y
             alertRequired=true.
  - SAGA-11: Documentacion contractual del flujo de confirmacion.
             En ONLINE: NO se llama a confirmOrDeclineBookingElevated.
             Wix eCommerce actualiza el booking status automaticamente
             segun el paymentStatus de la orden. La documentacion oficial
             de Wix Bookings lo prohibe explicitamente:
             "Call this method only when using a custom checkout page.
              Don't call it when using a Wix eCommerce checkout."
             En PRESENCIAL: SI se llama, porque no hay checkout de eCommerce.
  - SAGA-12: Los add-ons se pasan como bookedAddOns en el NIVEL RAIZ del
             body de createBooking, NO dentro de bookedEntity.slot. La API
             de Wix Bookings ignora silenciosamente addOnIds inyectados en
             el slot. Contrato oficial:
               bookings.createBooking({
                 bookedEntity: { slot: {...} },
                 bookedAddOns: [{ addOnId: "..." }, ...],
                 ...
               })
  - SAGA-13: _detectAddons mapea IDs CMS (addOnId) a GUIDs nativos
             (nativeId) del catalogo. Antes pasaba el ID CMS tal cual a
             Wix, que lo rechazaba o ignoraba. Devuelve SOLO GUIDs nativos
             deduplicados.
  - SAGA-14: _buildAddonSlotFields eliminado (derogado por SAGA-12).
             Se usa _buildBookedAddOns importado de bookingCore.
  - SAGA-15: Header actualizado con changelog y referencias a la
             documentacion oficial de Wix Bookings.

FIXES APLICADOS v5009-FISCAL-V20.3 (heredados):
  - SAGA-01: skipAvailabilityValidation = false (BIBLIA 2.2 regla 7).
  - SAGA-02: pairToken UNIFICADO.
  - SAGA-03: OWNER_BUSINESS GARANTIZADO.
  - SAGA-04: Addons inyectados con validacion de limite BIBLIA 3.2.
  - SAGA-05: PAYMENT_STATUS.NOT_PAID en confirmOrDecline.
  - SAGA-06: Compensacion NO cancela reservas CONFIRMED/CANCELLED/REFUNDED.
  - SAGA-07: Constantes CONCURRENCY V20 canonicas.
  - SAGA-08: availableStaff leido exclusivamente desde el campo canonico.
  - SAGA-09: selectedPaymentOption ONLINE en create cuando path eCom.

NOTA CONTRACTUAL (BIBLIA 2.2.1):
  bookedEntity.slot.serviceId      -> GUID servicio
  bookedEntity.slot.scheduleId     -> GUID schedule (obligatorio)
  bookedEntity.slot.startDate      -> ISO UTC con Z
  bookedEntity.slot.endDate        -> ISO UTC con Z
  bookedEntity.slot.timezone       -> Europe/Madrid
  bookedEntity.slot.resource.id    -> GUID recurso
  bookedEntity.slot.location       -> { id, locationType: OWNER_BUSINESS }
  contactDetails                   -> objeto contacto
  totalParticipants                -> 1
  bookedAddOns                     -> [{ addOnId: GUID }] (raiz, NO en slot)
=============================================================================
*/

import { bookings } from "@wix/bookings";
import { auth } from "@wix/essentials";
// EXCEPCION DATA API (APENDICE C de la BIBLIA): persistencia CMS server-side
// con suppressAuth/suppressHooks; ver apendice antes de proponer migracion.
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
    _buildPairFingerprint,
    _buildBookedAddOns,
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
// CONSTANTES
// =============================================================================

const LOCKTTLMS = Number(CONCURRENCY?.MS_TTL_MUTEX) || 300000;
const HEARTBEATMS = Number(CONCURRENCY?.MS_LATIDO) || 15000;

const CITASCOL = BUSINESS_COLLECTIONS.CITAS_F2;
const SERVICIOSCOL = BUSINESS_COLLECTIONS.SERVICIOS_CATALOGO;
const COMPENSACIONESCOL = OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO;

const MINUTOS_MAX_HUECO_DUAL = Math.max(
    0,
    Number(SLOT_SEARCH?.MINUTOS_MAX_HUECO_DUAL) || 120
);

const BOOKING_CREATION_TIMEOUT_MS =
    Number(SDK_CONFIG?.TIMEOUTS?.BOOKING_CREATION_MS) || 25000;
const CHECKOUT_TIMEOUT_MS =
    Number(SDK_CONFIG?.TIMEOUTS?.CHECKOUT_MS) || 20000;
const API_TIMEOUT_MS =
    Number(SDK_CONFIG?.TIMEOUTS?.API_MS) || 15000;

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

function _resolveStablePairToken({ serviceId, resourceId, f1Start, f2Start, email }) {
    const emailHash = _hashKey(_safeTrim(email).toLowerCase());
    const payload = _stableSerialize({
        serviceId: _safeTrim(serviceId),
        resourceId: _safeTrim(resourceId),
        f1Start: _safeTrim(f1Start),
        f2Start: _safeTrim(f2Start || ""),
    });
    const hash = _hashKey(payload + "|" + emailHash);
    return "pt_" + hash.slice(0, 32);
}

function _resolveUnifiedPairToken({
    suppliedPairToken,
    isDual,
    serviceId,
    linkedPhases,
    f1Start,
    f1End,
    f2Start,
    f2End,
    resourceId,
    email,
    traceId,
}) {
    const supplied = _safeTrim(suppliedPairToken);
    if (supplied) {
        return { pairToken: supplied, source: "SUPPLIED" };
    }

    if (isDual && _looksLikeGuid(resourceId)) {
        const fingerprint = _buildPairFingerprint({
            serviceId: serviceId,
            linkedPhases: linkedPhases,
            dateYmd: _safeTrim(f1Start).slice(0, 10),
            f1Start: f1Start,
            f1End: f1End,
            f2Start: f2Start,
            f2End: f2End,
            resourceId: resourceId,
        });
        return { pairToken: _hashKey(fingerprint), source: "FINGERPRINT" };
    }

    if (isDual) {
        log.warn(
            "SAGA-02: dual booking without supplied pairToken and without explicit " +
            "resourceId. Falling back to STABLE token (includes email hash), which " +
            "will NOT match getCertifiedDualSlots output. Frontend must forward " +
            "the pairToken returned by the availability query.", { traceId: traceId, serviceId: serviceId }
        );
    }

    return {
        pairToken: _resolveStablePairToken({
            serviceId: serviceId,
            resourceId: resourceId,
            f1Start: f1Start,
            f2Start: f2Start,
            email: email,
        }),
        source: isDual ? "STABLE_DEGRADED" : "STABLE",
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
            return parsed && typeof parsed === "object" && !Array.isArray(parsed) ?
                parsed :
                {};
        }

        return typeof meta === "object" && !Array.isArray(meta) ?
            meta :
            {};
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
    for (const key of lockKeys || []) {
        try {
            await _unlockSlotKey(key, lockOwnerId);
        } catch (e) {
            log.warn("_bestEffortUnlockAll: failed to unlock", {
                key: key,
                error: e?.message,
            });
        }
    }
}

// =============================================================================
// BLOCK 4 - BOOKING COMPENSATION (SAGA-06 + SAGA-10)
// =============================================================================

/**
 * SAGA-06: nunca cancelar una reserva ya confirmada, cancelada o reembolsada.
 *
 * SAGA-10: Wix Bookings exige revision en cancelBooking. Si el booking entry
 * no trae revision valido, NO se intenta cancelar: se encola una
 * compensacion manual con alertRequired=true y lastError=MISSING_REVISION.
 * Es preferible una alerta manual a un fallo silencioso que deje reservas
 * huerfanas.
 */
async function _compensateCreatedBookings(createdBookings, traceId) {
    for (const booking of createdBookings || []) {
        const bookingId = booking?.bookingId || booking?.id;
        if (!bookingId) continue;

        const status = _safeTrim(
            booking?.[BOOKING_FIELDS.STATUS] || booking?.status
        ).toUpperCase();

        if (status && NON_CANCELABLE_STATUSES.has(status)) {
            log.warn("Skipping compensation for non-cancelable booking", {
                bookingId: bookingId,
                status: status,
                phase: booking?.phase || null,
                traceId: traceId,
            });
            continue;
        }

        // SAGA-10: revision obligatoria para cancelBooking.
        const revision = Number(booking?.revision);
        const hasValidRevision =
            Number.isFinite(revision) && revision > 0 && Number.isInteger(revision);

        if (!hasValidRevision) {
            log.error(
                "SAGA-10: booking without revision cannot be cancelled; queuing manual review",
                {
                    bookingId: String(bookingId),
                    revisionRaw: booking?.revision,
                    phase: booking?.phase || null,
                    traceId: traceId,
                }
            );
            try {
                await wixData.insert(
                    COMPENSACIONESCOL, {
                        id: "COMP_MANUAL_" + bookingId + "_" + Date.now(),
                        kind: COMPENSATION_KIND.CANCEL_BOOKING,
                        compensationKind: COMPENSATION_KIND.CANCEL_BOOKING,
                        bookingId: bookingId,
                        phase: booking?.phase || "UNKNOWN",
                        status: COMPENSATION_STATUS.PENDING,
                        compensationStatus: COMPENSATION_STATUS.PENDING,
                        attempts: 0,
                        totalAmount: 0,
                        paymentMethod: null,
                        transactionId: null,
                        orderId: null,
                        refundId: null,
                        operationDescription:
                            "Manual cancellation required: booking lacks revision",
                        movementType: null,
                        alertRequired: true,
                        lastError: "MISSING_REVISION",
                        traceId: traceId,
                        _createdDate: new Date(),
                        _updatedDate: new Date(),
                    }, { suppressAuth: true }
                );
            } catch (queueErr) {
                log.error("Failed to queue manual compensation", {
                    bookingId: bookingId,
                    traceId: traceId,
                    error: queueErr?.message,
                });
            }
            continue;
        }

        try {
            await _executeWithRetry(
                () =>
                withTimeout(
                    () => cancelBookingElevated(bookingId, {
                        revision,
                        suppressAuth: true,
                    }),
                    API_TIMEOUT_MS,
                    "cancelBookingCompensation"
                ),
                2,
                300
            );
            log.info("Compensated booking cancelled", {
                bookingId: bookingId,
                revision: revision,
                phase: booking?.phase || null,
                traceId: traceId,
            });
        } catch (cancelErr) {
            log.error("Compensation cancel failed; queuing", {
                bookingId: bookingId,
                revision: revision,
                traceId: traceId,
                error: cancelErr?.message,
            });
            try {
                await wixData.insert(
                    COMPENSACIONESCOL, {
                        id: "COMP_" + bookingId + "_" + Date.now(),
                        kind: COMPENSATION_KIND.CANCEL_BOOKING,
                        compensationKind: COMPENSATION_KIND.CANCEL_BOOKING,
                        bookingId: bookingId,
                        phase: booking?.phase || "UNKNOWN",
                        status: COMPENSATION_STATUS.PENDING,
                        compensationStatus: COMPENSATION_STATUS.PENDING,
                        attempts: 0,
                        totalAmount: 0,
                        paymentMethod: null,
                        transactionId: null,
                        orderId: null,
                        refundId: null,
                        operationDescription: "Booking compensation after saga failure",
                        movementType: null,
                        alertRequired: true,
                        lastError: cancelErr?.message || "UNKNOWN",
                        traceId: traceId,
                        _createdDate: new Date(),
                        _updatedDate: new Date(),
                    }, { suppressAuth: true }
                );
            } catch (queueErr) {
                log.error("Failed to queue compensation", {
                    bookingId: bookingId,
                    traceId: traceId,
                    error: queueErr?.message,
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
            () => bookings.createBooking(booking, options),
            BOOKING_CREATION_TIMEOUT_MS,
            "createBooking"
        );
    } catch (err) {
        const code = _safeTrim(
            err?.code || err?.details?.applicationError?.code
        ).toUpperCase();
        const isAccessDenied =
            code === "ACCESS_DENIED" ||
            String(err?.message || "").toUpperCase().includes("ACCESS_DENIED");
        if (!isAccessDenied) throw err;
        log.info("Elevating createBooking due to ACCESS_DENIED", { traceId: traceId });
        return await withTimeout(
            () => auth.elevate(bookings.createBooking)(booking, options),
            BOOKING_CREATION_TIMEOUT_MS,
            "createBooking:elevated"
        );
    }
}

// =============================================================================
// BLOCK 6 - VALIDACION DEFENSIVA DE RESPUESTA (FIX-42)
// =============================================================================

function _validateCreateBookingResponse(booking, phase, traceId) {
    const id = _safeTrim(booking?.id || booking?._id);
    if (!id || !_looksLikeGuid(id)) {
        log.error("CreateBooking returned invalid booking", {
            phase,
            traceId,
            hasId: Boolean(booking?.id),
            has_id: Boolean(booking?._id),
        });
        throw createBookingError(
            ERROR_CODES.BOOKING_CREATION_FAILED,
            "Booking " + phase + " created but no valid ID returned", { traceId, phase }
        );
    }

    const revisionRaw = booking?.revision ?? booking?.revisionNumber ?? null;
    const revisionNum = Number(revisionRaw);
    const revision =
        Number.isFinite(revisionNum) && revisionNum > 0 ? revisionNum : null;

    if (revision === null) {
        log.warn("CreateBooking returned no revision; defaulting to 1 in CitasF2", {
            phase,
            traceId,
            bookingId: id,
        });
    }

    return {
        bookingId: id,
        revision,
        status: _safeTrim(booking?.status) || null,
    };
}

// =============================================================================
// BLOCK 7 - DETECCION DE FLAG DOUBLEBOOKED (FIX-38)
// =============================================================================

function _checkDoubleBookingFlag(booking, phase, traceId) {
    if (booking?.doubleBooked === true) {
        log.warn("DOUBLE_BOOKING_DETECTED", {
            phase,
            traceId,
            bookingId: booking?.id || booking?._id,
        });
        return true;
    }
    return false;
}

// =============================================================================
// BLOCK 8 - VALIDACION EXPLICITA DE GAP MAXIMO (FIX-34)
// =============================================================================

function _validateDualGap(f1LocalEnd, f2LocalStart, traceId) {
    const f1EndLocal = _normalizeLocalIsoStr(f1LocalEnd);
    const f2StartLocal = _normalizeLocalIsoStr(f2LocalStart);

    if (!f1EndLocal || !f2StartLocal) {
        throw createBookingError(
            ERROR_CODES.INVALID_DATES,
            "Dual gap validation: invalid dates", { traceId, f1LocalEnd, f2LocalStart }
        );
    }

    const f1EndUtc = getUtcDateFromMadridLocal(f1EndLocal);
    const f2StartUtc = getUtcDateFromMadridLocal(f2StartLocal);

    if (!f1EndUtc || !f2StartUtc) {
        throw createBookingError(
            ERROR_CODES.INVALID_DATES,
            "Dual gap validation: could not convert to UTC", { traceId, f1EndLocal, f2LocalStart }
        );
    }

    const rawDiffMinutes =
        (f2StartUtc.getTime() - f1EndUtc.getTime()) / 60000;

    if (rawDiffMinutes < 0) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "Dual gap validation: F2 starts before F1 ends (" +
            rawDiffMinutes.toFixed(2) + " min)", { traceId, gapMinutes: rawDiffMinutes }
        );
    }

    const gapMinutes = computeGapMinutes(f1EndUtc, f2StartUtc);

    if (gapMinutes > MINUTOS_MAX_HUECO_DUAL) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "Dual gap validation: gap " + gapMinutes.toFixed(2) +
            " min exceeds MAX (" + MINUTOS_MAX_HUECO_DUAL + ")", { traceId, gapMinutes, maxGapMinutes: MINUTOS_MAX_HUECO_DUAL }
        );
    }

    return { gapMinutes, maxGapMinutes: MINUTOS_MAX_HUECO_DUAL };
}

// =============================================================================
// BLOCK 9 - VALIDACION DEL SERVICIO F2 (FIX-32, FIX-36, SAGA-08)
// =============================================================================

async function _validateLinkedPhaseService(linkedPhases, parentLocationId, traceId) {
    const linkedServiceId = _safeTrim(linkedPhases);
    if (!linkedServiceId || !_looksLikeGuid(linkedServiceId)) {
        throw createBookingError(
            ERROR_CODES.SERVICE_NOT_FOUND,
            "Linked phase service: invalid GUID", { traceId, linkedPhases: linkedServiceId }
        );
    }

    const res = await wixData
        .query(SERVICIOSCOL)
        .eq("serviceId", linkedServiceId)
        .limit(1)
        .find({ suppressAuth: true })
        .catch(function () { return { items: [] }; });

    const service = res?.items?.[0] || null;
    if (!service) {
        throw createBookingError(
            ERROR_CODES.SERVICE_NOT_FOUND,
            "Linked phase service " + linkedServiceId + " not found in catalog", { traceId }
        );
    }

    const isHidden = service.clientHidden === true;

    if (isHidden) {
        throw createBookingError(
            ERROR_CODES.SERVICE_NOT_FOUND,
            "Linked phase service " + linkedServiceId + " is hidden", { traceId }
        );
    }

    const serviceType = _safeTrim(service.serviceType).toUpperCase();
    if (serviceType && serviceType !== "APPOINTMENT" && serviceType !== "CITA") {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "Linked phase service " + linkedServiceId +
            " is not APPOINTMENT (type=" + serviceType + ")", { traceId }
        );
    }

    const phase2Duration = Number(
        service.phase2Duration ||
        service.totalDuration ||
        service.phase1Duration ||
        0
    );
    if (phase2Duration <= 0) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "Linked phase service " + linkedServiceId +
            " has invalid duration (" + phase2Duration + ")", { traceId }
        );
    }

    const availableStaff = cleanGuidList(service.availableStaff || []);
    if (availableStaff.length === 0) {
        throw createBookingError(
            ERROR_CODES.STAFF_UNAVAILABLE,
            "Linked phase service " + linkedServiceId + " has no available staff", { traceId }
        );
    }

    const parentLoc = _safeTrim(parentLocationId);
    const f2Loc = _safeTrim(service.locationId || service.location);
    if (parentLoc && f2Loc && _looksLikeGuid(parentLoc) && _looksLikeGuid(f2Loc) &&
        parentLoc !== f2Loc) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "Linked phase service " + linkedServiceId +
            " has incompatible locationId (" + f2Loc + " != " + parentLoc + ")", { traceId }
        );
    }

    return { service, phase2Duration, availableStaff };
}

// =============================================================================
// BLOCK 10 - COMPENSACION DE PERSISTENCIA CMS
// =============================================================================

async function _deleteCitasByPairToken(pairToken, traceId) {
    const token = _safeTrim(pairToken);
    if (!token) return;

    try {
        const res = await wixData
            .query(CITASCOL)
            .eq("pairToken", token)
            .limit(10)
            .find({ suppressAuth: true, suppressHooks: true });

        const items = res?.items || [];
        for (const item of items) {
            try {
                await wixData.remove(CITASCOL, item._id, {
                    suppressAuth: true,
                    suppressHooks: true,
                });
                log.info("Compensated CitaF2 removal", {
                    citaId: item._id,
                    bookingId: item.bookingId,
                    traceId,
                });
            } catch (removeErr) {
                log.error("Failed to remove CitaF2 during compensation", {
                    citaId: item._id,
                    traceId,
                    error: removeErr?.message,
                });
            }
        }
    } catch (err) {
        log.error("_deleteCitasByPairToken failed", {
            pairToken: token,
            traceId,
            error: err?.message,
        });
    }
}

// =============================================================================
// BLOCK 11 - ADDONS (FIX-35 + SAGA-04 + SAGA-13)
// =============================================================================

/**
 * SAGA-13: detecta, valida y MAPEA los add-ons solicitados a GUIDs nativos.
 *
 * Entrada: IDs solicitados por el cliente (pueden ser CMS addOnId o
 * native nativeId). Salida: SOLO GUIDs nativos, deduplicados.
 *
 * Si un ID solicitado no existe en el catalogo del servicio, se descarta
 * con warn. Si existe pero le falta nativeId GUID, se descarta con warn.
 * Si supera MAX_ADDONS_PER_BOOKING, lanza BookingError.
 *
 * @returns {string[]} GUIDs nativos listos para _buildBookedAddOns.
 */
function _detectAddons(unsafePayload, metaCita, serviceConfig, traceId) {
    const rawAddons =
        unsafePayload?.nativeAddonIds ||
        unsafePayload?.addOnIds ||
        metaCita?.nativeAddonIds ||
        metaCita?.addOnIds || [];

    const requested = Array.isArray(rawAddons) ?
        rawAddons
        .map(function (id) { return _safeTrim(id); })
        .filter(function (id) { return _looksLikeGuid(id); }) :
        [];

    const unique = Array.from(new Set(requested));

    // SAGA-04: limite BIBLIA 3.2 fila 10 (MAX_POR_RESERVA = 5).
    if (unique.length > MAX_ADDONS_PER_BOOKING) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "Too many addOnOptions requested (" + unique.length +
            "). Maximum allowed is " + MAX_ADDONS_PER_BOOKING + ".", { traceId, addonCount: unique.length, max: MAX_ADDONS_PER_BOOKING }
        );
    }

    // Catalogo canonico de add-ons del servicio. Acepta tanto el campo
    // top-level como el metadata (ambos poblados por _mapServiceImport2ToUX).
    const catalogAddons = Array.isArray(serviceConfig?.addOnOptions) ?
        serviceConfig.addOnOptions :
        Array.isArray(serviceConfig?.metadata?.addOnOptions) ?
        serviceConfig.metadata.addOnOptions :
        [];

    // SAGA-13: mapeo CMS addOnId -> native nativeId (GUID).
    const validated = [];
    const seenNative = new Set();

    for (const requestedId of unique) {
        const match = catalogAddons.find(function (a) {
            return (
                _safeTrim(a?.addOnId) === requestedId ||
                _safeTrim(a?.nativeId) === requestedId
            );
        });

        if (!match) {
            log.warn("SAGA-13: requested addon not in service catalog", {
                traceId,
                requestedId,
            });
            continue;
        }

        const nativeId = _safeTrim(match.nativeId);
        if (!nativeId || !_looksLikeGuid(nativeId)) {
            log.warn("SAGA-13: catalog addon missing native GUID", {
                traceId,
                requestedId,
                cmsAddOnId: _safeTrim(match.addOnId),
            });
            continue;
        }

        if (seenNative.has(nativeId)) continue;
        seenNative.add(nativeId);
        validated.push(nativeId);
    }

    if (validated.length > 0) {
        log.info("SAGA-04/SAGA-13: addons resolved to native GUIDs", {
            traceId,
            requestedCount: unique.length,
            validatedCount: validated.length,
            nativeAddOnIds: validated,
        });
    }

    return validated;
}

// =============================================================================
// BLOCK 12 - UBICACION OWNER_BUSINESS (SAGA-03)
// =============================================================================

function _resolveBookingLocation({
    validatedSlotF1,
    validatedSlotF2,
    serviceConfig,
    parentLocationId,
    traceId,
}) {
    const resolvedId =
        _isGuidOrNull(validatedSlotF1?.location?.id) ||
        _isGuidOrNull(validatedSlotF2?.location?.id) ||
        _isGuidOrNull(serviceConfig?.locationId) ||
        _isGuidOrNull(parentLocationId);

    if (!resolvedId) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "Booking location is missing. Cannot build OWNER_BUSINESS location.", { traceId }
        );
    }

    const sourceLocationType = _safeTrim(
        validatedSlotF1?.location?.locationType
    ).toUpperCase();

    if (sourceLocationType && sourceLocationType !== "OWNER_BUSINESS") {
        log.info("SAGA-03: overriding locationType for booking creation", {
            traceId,
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

function _assertPristineSlotContract(pristineSlot, phase, traceId) {
    const startIso = _safeTrim(pristineSlot?.startDate);
    const endIso = _safeTrim(pristineSlot?.endDate);
    const locationType = _safeTrim(pristineSlot?.location?.locationType).toUpperCase();

    const missing = [];

    if (!_isGuidOrNull(pristineSlot?.serviceId)) missing.push("serviceId");
    if (!_isGuidOrNull(pristineSlot?.scheduleId)) missing.push("scheduleId");
    if (!startIso) missing.push("startDate");
    else if (!/Z$/.test(startIso)) missing.push("startDate must be ISO UTC with Z");
    if (!endIso) missing.push("endDate");
    else if (!/Z$/.test(endIso)) missing.push("endDate must be ISO UTC with Z");
    if (!_isGuidOrNull(pristineSlot?.resource?.id)) missing.push("resource.id");
    if (!_isGuidOrNull(pristineSlot?.location?.id)) missing.push("location.id");
    if (locationType !== "OWNER_BUSINESS") {
        missing.push("location.locationType must be OWNER_BUSINESS");
    }

    if (missing.length > 0) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "Pristine slot " + phase + " violates createBooking contract: " +
            missing.join("; "), { traceId, phase, missing }
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
        for (const step of this.steps) {
            try {
                log.info("Saga step: " + step.name, { traceId: this.traceId });
                const result = await step.executeFn();
                this.completedSteps.push(
                    Object.assign({}, step, { result: result })
                );
            } catch (error) {
                log.error("Saga step failed: " + step.name, {
                    traceId: this.traceId,
                    error: error?.message,
                });
                await this._compensate();
                throw error;
            }
        }
        return this.completedSteps.map(function (s) { return s.result; });
    }

    async _compensate() {
        const reversed = [].concat(this.completedSteps).reverse();
        for (const step of reversed) {
            if (step.compensateFn) {
                try {
                    log.info("Saga compensating: " + step.name, {
                        traceId: this.traceId,
                    });
                    await step.compensateFn(step.result);
                } catch (compErr) {
                    log.error("Saga compensation failed: " + step.name, {
                        traceId: this.traceId,
                        error: compErr?.message,
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
    const traceId = unsafePayload?.traceId || makeTraceId("saga");
    const metaCita = _normalizePersistedMeta(
        unsafePayload?.metaCita || unsafePayload?.meta || {}
    );

    try {
        // =========================================================================
        // PHASE 0: VALIDATION AND RESOLUTION
        // =========================================================================
        const email = _safeTrim(
            unsafePayload?.email ||
            metaCita.email ||
            unsafePayload?.contactDetails?.email
        );
        if (!email) {
            throw createBookingError(
                ERROR_CODES.INVALID_PAYLOAD,
                "Email is required", { traceId: traceId }
            );
        }

        const rawServiceId = _safeTrim(
            unsafePayload?.serviceId || metaCita.serviceId || ""
        );
        const serviceId = await _resolveServiceIdInternal(rawServiceId);
        if (!serviceId || !_looksLikeGuid(serviceId)) {
            throw createBookingError(
                ERROR_CODES.SERVICE_NOT_FOUND,
                "Service not found", { traceId: traceId, rawServiceId: rawServiceId }
            );
        }

        const serviceRes = await _getServiceBySlugOrIdInternal(serviceId, traceId);
        const serviceConfig = serviceRes?.data || {};
        const isDual =
            serviceConfig.allowCombine === true &&
            !!serviceConfig.linkedPhases &&
            _looksLikeGuid(serviceConfig.linkedPhases);
        const linkedPhases = isDual ? serviceConfig.linkedPhases : null;
        const parentLocationId = _safeTrim(
            serviceConfig.locationId || serviceConfig.location
        );

        const requestedResourceId = _safeTrim(
            unsafePayload?.resourceId || metaCita.resourceId
        );
        const slotF1Input = unsafePayload?.slotF1 || {};
        const slotF2Input = unsafePayload?.slotF2 || {};

        const f1LocalStart = _normalizeLocalIsoStr(
            slotF1Input.localStartDate || slotF1Input.start || metaCita.f1Start
        );
        const f1LocalEnd = _normalizeLocalIsoStr(
            slotF1Input.localEndDate || slotF1Input.end || metaCita.f1End
        );

        if (!f1LocalStart || !f1LocalEnd) {
            throw createBookingError(
                ERROR_CODES.INVALID_PAYLOAD,
                "F1 slot dates are required", { traceId: traceId }
            );
        }

        let f2LocalStart = "";
        let f2LocalEnd = "";

        if (isDual) {
            f2LocalStart = _normalizeLocalIsoStr(
                slotF2Input.localStartDate || slotF2Input.start || metaCita.f2Start
            );
            f2LocalEnd = _normalizeLocalIsoStr(
                slotF2Input.localEndDate || slotF2Input.end || metaCita.f2End
            );

            const linkedValidation = await _validateLinkedPhaseService(
                linkedPhases,
                parentLocationId,
                traceId
            );

            if (!f2LocalStart) {
                const f1EndUtc = getUtcDateFromMadridLocal(f1LocalEnd);
                if (!f1EndUtc) {
                    throw createBookingError(
                        ERROR_CODES.INVALID_DATES,
                        "Could not compute F1 end UTC for F2 derivation", { traceId }
                    );
                }
                const exposureMs =
                    Math.max(0, Number(serviceConfig.exposureDuration || 0)) * 60 * 1000;
                const linkedPhase2Ms =
                    Math.max(0, Number(linkedValidation.phase2Duration || 30)) * 60 * 1000;
                const f2StartUtc = new Date(f1EndUtc.getTime() + exposureMs);
                const f2EndUtc = new Date(f2StartUtc.getTime() + linkedPhase2Ms);
                f2LocalStart = getMadridLocalStringNoZ(f2StartUtc);
                f2LocalEnd = getMadridLocalStringNoZ(f2EndUtc);
            }

            _validateDualGap(f1LocalEnd, f2LocalStart, traceId);
        }

        // SAGA-04 / SAGA-13: addOnOptions detectados, validados y mapeados a GUIDs nativos.
        const detectedAddonIds = _detectAddons(
            unsafePayload,
            metaCita,
            serviceConfig,
            traceId
        );

        // =========================================================================
        // PHASE 1: REAL-TIME REVALIDATION
        // =========================================================================
        const resourceValidation = await _resolveStaffForSlotInternal({
            serviceId: serviceId,
            f1Start: f1LocalStart,
            f1End: f1LocalEnd,
            f2Start: isDual ? f2LocalStart : null,
            f2End: isDual ? f2LocalEnd : null,
            requestedResourceId: requestedResourceId || null,
            addOnIds: detectedAddonIds,
            traceId: traceId,
        });

        if (resourceValidation?.status !== "SUCCESS") {
            throw createBookingError(
                resourceValidation?.error?.code || ERROR_CODES.SLOT_UNAVAILABLE,
                resourceValidation?.error?.message || "Slot no longer available", { traceId: traceId }
            );
        }

        const finalResourceId = resourceValidation.data.resourceId;
        const validatedSlotF1 = resourceValidation.data.slotF1;
        const validatedSlotF2 = resourceValidation.data.slotF2;

        if (isDual && validatedSlotF1 && validatedSlotF2) {
            const f1EndFromValidated = _normalizeLocalIsoStr(
                validatedSlotF1.localEndDate ||
                validatedSlotF1.endDate ||
                f1LocalEnd
            );
            const f2StartFromValidated = _normalizeLocalIsoStr(
                validatedSlotF2.localStartDate ||
                validatedSlotF2.startDate ||
                f2LocalStart
            );
            _validateDualGap(f1EndFromValidated, f2StartFromValidated, traceId);
        }

        // =========================================================================
        // PHASE 2: PAIR TOKEN UNIFICADO (SAGA-02)
        // =========================================================================
        const tokenResolution = _resolveUnifiedPairToken({
            suppliedPairToken: unsafePayload?.pairToken || metaCita.pairToken,
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

        const pairToken = tokenResolution.pairToken;

        log.info("SAGA-02: pairToken resolved", {
            traceId: traceId,
            source: tokenResolution.source,
            isDual: isDual,
            pairToken: pairToken,
        });

        const bookingLocation = _resolveBookingLocation({
            validatedSlotF1: validatedSlotF1,
            validatedSlotF2: validatedSlotF2,
            serviceConfig: serviceConfig,
            parentLocationId: parentLocationId,
            traceId: traceId,
        });

        // =========================================================================
        // PHASE 3: IDEMPOTENCY CHECK ON CITAS_F2
        // =========================================================================
        const existingCitaRes = await wixData
            .query(CITASCOL)
            .eq("pairToken", pairToken)
            .limit(1)
            .find({ suppressAuth: true, suppressHooks: true })
            .catch(function () { return { items: [] }; });

        if (existingCitaRes?.items?.length > 0) {
            const existingCita = existingCitaRes.items[0];
            const existingPaymentStatus =
                _safeTrim(existingCita.paymentStatus).toUpperCase();

            if (existingPaymentStatus === _safeTrim(PAYMENT_STATUS_PENDING).toUpperCase()) {
                log.info("Idempotent duplicate: PENDING_PAYMENT, returning existing checkout", {
                    pairToken: pairToken,
                    traceId: traceId,
                });
                return {
                    status: "SUCCESS",
                    data: {
                        requiresPayment: true,
                        checkoutUrl: existingCita.meta?.checkoutUrl || null,
                        pairToken: pairToken,
                        bookingId: existingCita.bookingId || null,
                        idempotent: true,
                    },
                    error: null,
                };
            }

            log.info("Idempotent duplicate: existing cita found", {
                pairToken: pairToken,
                traceId: traceId,
                status: existingCita.bookingStatus || existingCita.status,
            });
            return {
                status: "SUCCESS",
                data: {
                    bookingId: existingCita.bookingId,
                    pairToken: pairToken,
                    status: existingCita.bookingStatus || existingCita.status,
                    idempotent: true,
                },
                error: null,
            };
        }

        // =========================================================================
        // PHASE 4: INIT TRANSACTION
        // =========================================================================
        const payloadHash = _hashKey(
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

        const txResult = await _initTransaction(pairToken, payloadHash, traceId);
        if (!txResult.success) {
            if (txResult.error === "PAIR_TOKEN_PAYLOAD_MISMATCH") {
                throw createBookingError(
                    ERROR_CODES.INVALID_PAYLOAD,
                    "Payload mismatch for existing pairToken", { traceId: traceId }
                );
            }
            if (txResult.error === "TRANSACTION_PREVIOUSLY_FAILED") {
                throw createBookingError(
                    ERROR_CODES.BOOKING_CREATION_FAILED,
                    "Previous transaction failed", { traceId: traceId }
                );
            }
            if (txResult.existing?.status === "COMPLETED") {
                return {
                    status: "SUCCESS",
                    data: txResult.existing.result,
                    error: null,
                    idempotent: true,
                };
            }
            throw createBookingError(
                ERROR_CODES.TOKEN_BUSY,
                "Transaction in progress or timeout", { traceId: traceId }
            );
        }

        // =========================================================================
        // PHASE 5: ACQUIRE LOCKS + HEARTBEAT
        // =========================================================================
        const phases = [{
            rawSlot: Object.assign({}, validatedSlotF1, { serviceId: serviceId }),
            localStart: f1LocalStart,
            localEnd: f1LocalEnd,
        }, ];
        if (isDual && f2LocalStart) {
            phases.push({
                rawSlot: Object.assign({}, validatedSlotF2, { serviceId: linkedPhases }),
                localStart: f2LocalStart,
                localEnd: f2LocalEnd,
            });
        }

        const lockKeys = _buildLockKeys(phases, finalResourceId);
        const lockOwnerId = pairToken;
        let heartbeatInterval = null;

        const saga = new BookingSagaOrchestrator(traceId);
        const createdBookings = [];

        saga.addStep(
            "LockSlots",
            async function () {
                    for (const lockKey of lockKeys) {
                        const lockResult = await _lockSlotKeyOrFail(
                            lockKey,
                            lockOwnerId,
                            LOCKTTLMS
                        );
                        if (!lockResult?.ok) {
                            throw createBookingError(
                                ERROR_CODES.TOKEN_BUSY,
                                "Lock failed: " + (lockResult?.message || "unknown"), { traceId: traceId, lockKey: lockKey }
                            );
                        }
                    }
                    heartbeatInterval = setInterval(function () {
                        lockKeys.forEach(function (key) {
                            _renewLock(key, lockOwnerId, LOCKTTLMS).catch(function (err) {
                                log.warn("heartbeat: lock renewal failed", {
                                    key: key,
                                    traceId: traceId,
                                    error: err?.message,
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
        // SAGA-12: add-ons a nivel raiz como bookedAddOns (NO en el slot)
        // =========================================================================
        saga.addStep(
            "CreateBookings",
            async function () {
                    const contactDetails = {
                        firstName: _safeTrim(
                            unsafePayload?.firstName || metaCita.firstName || ""
                        ),
                        lastName: _safeTrim(
                            unsafePayload?.lastName || metaCita.lastName || ""
                        ),
                        email: email,
                        phone: _safeTrim(unsafePayload?.phone || metaCita.phone || ""),
                    };

                    const bookingOptions = Object.freeze({
                        flowControlSettings: Object.freeze({
                            skipAvailabilityValidation: SKIP_AVAILABILITY_VALIDATION,
                        }),
                    });

                    // SAGA-12: bookedAddOns a nivel raiz del body.
                    const bookedAddOns = _buildBookedAddOns(detectedAddonIds);

                    let bookingF1 = null;
                    let bookingF2 = null;
                    let pristineF2 = null;
                    let f2Meta = null;

                    // ---------------- F1 ----------------
                    const pristineF1 = await _forceStaffInPristineSlot(
                        Object.assign({},
                            validatedSlotF1, { location: bookingLocation }
                        ),
                        finalResourceId,
                        serviceId,
                        serviceConfig.phase1Duration
                    );

                    if (!pristineF1) {
                        throw createBookingError(
                            ERROR_CODES.INVALID_PAYLOAD,
                            "Failed to build pristine slot F1", { traceId: traceId }
                        );
                    }

                    pristineF1.location = bookingLocation;
                    _assertPristineSlotContract(pristineF1, "F1", traceId);

                    const bookingBodyF1 = {
                        bookedEntity: { slot: pristineF1 },
                        contactDetails: contactDetails,
                        totalParticipants: 1,
                    };
                    if (bookedAddOns.length > 0) {
                        bookingBodyF1.bookedAddOns = bookedAddOns;
                    }
                    const payMethodEarly = _safeTrim(
                        unsafePayload?.paymentMethod ||
                        PAYMENT_METHOD?.ONLINE ||
                        "ONLINE"
                    ).toUpperCase();
                    if (
                        payMethodEarly ===
                        _safeTrim(PAYMENT_METHOD?.ONLINE).toUpperCase() ||
                        payMethodEarly === "ONLINE"
                    ) {
                        bookingBodyF1.selectedPaymentOption = "ONLINE";
                    }
                    const resF1 = await _createBookingWithSelectiveElevation(
                        bookingBodyF1,
                        bookingOptions,
                        traceId
                    );

                    bookingF1 = resF1?.booking || resF1;
                    const f1Meta = _validateCreateBookingResponse(bookingF1, "F1", traceId);
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
                            Object.assign({},
                                validatedSlotF2, { location: bookingLocation }
                            ),
                            finalResourceId,
                            linkedPhases,
                            serviceConfig.phase2Duration
                        );

                        if (!pristineF2) {
                            throw createBookingError(
                                ERROR_CODES.INVALID_PAYLOAD,
                                "Failed to build pristine slot F2", { traceId: traceId }
                            );
                        }

                        pristineF2.location = bookingLocation;
                        _assertPristineSlotContract(pristineF2, "F2", traceId);

                        const bookingBodyF2 = {
                            bookedEntity: { slot: pristineF2 },
                            contactDetails: contactDetails,
                            totalParticipants: 1,
                        };
                        if (bookedAddOns.length > 0) {
                            bookingBodyF2.bookedAddOns = bookedAddOns;
                        }
                        if (
                            payMethodEarly ===
                            _safeTrim(PAYMENT_METHOD?.ONLINE).toUpperCase() ||
                            payMethodEarly === "ONLINE"
                        ) {
                            bookingBodyF2.selectedPaymentOption = "ONLINE";
                        }
                        const resF2 = await _createBookingWithSelectiveElevation(
                            bookingBodyF2,
                            bookingOptions,
                            traceId
                        );

                        bookingF2 = resF2?.booking || resF2;
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
                        scheduleIdF1: _safeTrim(pristineF1?.scheduleId) || null,
                        scheduleIdF2: _safeTrim(pristineF2?.scheduleId) || null,
                        revisionF1: f1Meta.revision,
                        revisionF2: f2Meta?.revision || null,
                    };
                },
                async function () {
                    await _compensateCreatedBookings(createdBookings, traceId);
                }
        );

        // =========================================================================
        // CHECKOUT ONLINE / CONFIRMACION PRESENCIAL
        // SAGA-05: PAYMENT_STATUS.NOT_PAID (sin literales)
        // SAGA-11: en ONLINE NO se llama a confirmOrDeclineBooking.
        //          Wix eCommerce confirma automaticamente la reserva segun
        //          el paymentStatus de la orden.
        // =========================================================================
        const paymentMethod = _safeTrim(
            unsafePayload?.paymentMethod || metaCita.paymentMethod || "PRESENCIAL"
        ).toUpperCase();

        const isOnline =
            paymentMethod === _safeTrim(PAYMENT_METHOD?.ONLINE).toUpperCase();

        saga.addStep(
            isOnline ? "CreateCheckout" : "ConfirmPresencial",
            async function () {
                    if (isOnline) {
                        // SAGA-11: solo se crea el checkout. NO se llama a
                        // confirmOrDeclineBookingElevated. La confirmacion la
                        // hara Wix eCommerce cuando la orden pase a PAID.
                        const bookingIds = createdBookings
                            .map(function (b) { return b.bookingId; })
                            .filter(Boolean);

                        const checkoutPayload = {
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

                        const checkoutRes = await withTimeout(
                            () => createCheckoutElevated(checkoutPayload),
                            CHECKOUT_TIMEOUT_MS,
                            "createCheckout"
                        );

                        const checkoutUrl = await _executeWithRetry(
                            () =>
                            withTimeout(
                                () =>
                                getCheckoutUrlElevated(
                                    _extractCheckoutId(checkoutRes)
                                ),
                                API_TIMEOUT_MS,
                                "getCheckoutUrl"
                            ),
                            2,
                            300
                        );

                        return {
                            requiresPayment: true,
                            checkoutUrl: checkoutUrl,
                            bookingIds: bookingIds,
                        };
                    }

                    // Flujo PRESENCIAL (custom checkout): aqui SI se llama a
                    // confirmOrDeclineBooking porque no hay eCommerce checkout.
                    for (const booking of createdBookings) {
                        const confirmResult = await _executeWithRetry(
                            () =>
                            withTimeout(
                                () =>
                                confirmOrDeclineBookingElevated(booking.bookingId, {
                                    paymentStatus: PAYMENT_STATUS_NOT_PAID,
                                }),
                                API_TIMEOUT_MS,
                                "confirmOrDecline"
                            ),
                            2,
                            300
                        );
                        _checkDoubleBookingFlag(
                            confirmResult,
                            "CONFIRM_" + booking.phase,
                            traceId
                        );

                        booking.bookingStatus =
                            _safeTrim(confirmResult?.booking?.bookingStatus) ||
                            _safeTrim(confirmResult?.booking?.status) ||
                            _safeTrim(confirmResult?.bookingStatus) ||
                            _safeTrim(confirmResult?.status) ||
                            BOOKING_STATUS_CONFIRMED;
                    }

                    return {
                        requiresPayment: false,
                        bookingIds: createdBookings.map(function (b) {
                            return b.bookingId;
                        }),
                    };
                },
                async function () {}
        );

        const paymentStatus = isOnline ?
            PAYMENT_STATUS_PENDING :
            PAYMENT_STATUS_NOT_PAID;

        const citaStatus = isOnline ?
            BOOKING_STATUS_PENDING_PAYMENT :
            BOOKING_STATUS_CONFIRMED;

        // =========================================================================
        // PERSISTENCIA EN CitasF2 (BIBLIA 4.6)
        // =========================================================================
        saga.addStep(
            "PersistCitas",
            async function () {
                    const checkoutStepName = isOnline ?
                        "CreateCheckout" :
                        "ConfirmPresencial";

                    const checkoutStepResult =
                        saga.completedSteps.find(function (s) {
                            return s.name === checkoutStepName;
                        })?.result || null;

                    const resolvedCheckoutUrl = checkoutStepResult?.checkoutUrl || null;

                    const createBookingsResult =
                        saga.completedSteps.find(function (s) {
                            return s.name === "CreateBookings";
                        })?.result || {};

                    const bookingF1Id = createdBookings.find(function (b) {
                        return b.phase === "F1";
                    })?.bookingId;

                    const bookingF2Id = createdBookings.find(function (b) {
                        return b.phase === "F2";
                    })?.bookingId;

                    const revisionF1 = Number(createBookingsResult.revisionF1) || 1;
                    const revisionF2 = Number(createBookingsResult.revisionF2) || 1;

                    let scheduleIdF1 = _isGuidOrNull(createBookingsResult.scheduleIdF1);
                    if (!scheduleIdF1) {
                        scheduleIdF1 = await _resolveScheduleIdForResource(
                            finalResourceId,
                            validatedSlotF1
                        );
                    }
                    if (!scheduleIdF1) {
                        throw createBookingError(
                            ERROR_CODES.INVALID_PAYLOAD,
                            "Unable to resolve scheduleId for F1", { traceId, bookingId: bookingF1Id }
                        );
                    }

                    await _persistBooking({
                            bookingId: bookingF1Id,
                            revision: revisionF1,
                            serviceId: serviceId,
                            scheduleId: scheduleIdF1,
                            resourceId: finalResourceId,
                            staffResourceId: finalResourceId,
                            startDate: getUtcDateFromMadridLocal(f1LocalStart),
                            endDate: getUtcDateFromMadridLocal(f1LocalEnd),
                            dateYmd: f1LocalStart.slice(0, 10),
                            bookingType: isDual ? BOOKING_TYPE.DUALF1 : BOOKING_TYPE.SIMPLE,
                            status: citaStatus,
                            bookingStatus: citaStatus,
                            paymentStatus: paymentStatus,
                            pairToken: pairToken,
                            contactDetails: { email: email },
                            locationId: bookingLocation.id,
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
                        },
                        traceId
                    );

                    if (isDual && bookingF2Id) {
                        let scheduleIdF2 = _isGuidOrNull(
                            createBookingsResult.scheduleIdF2
                        );
                        if (!scheduleIdF2) {
                            scheduleIdF2 = await _resolveScheduleIdForResource(
                                finalResourceId,
                                validatedSlotF2
                            );
                        }
                        if (!scheduleIdF2) {
                            throw createBookingError(
                                ERROR_CODES.INVALID_PAYLOAD,
                                "Unable to resolve scheduleId for F2", { traceId, bookingId: bookingF2Id }
                            );
                        }

                        await _persistBooking({
                                bookingId: bookingF2Id,
                                revision: revisionF2,
                                serviceId: linkedPhases,
                                scheduleId: scheduleIdF2,
                                resourceId: finalResourceId,
                                staffResourceId: finalResourceId,
                                startDate: getUtcDateFromMadridLocal(f2LocalStart),
                                endDate: getUtcDateFromMadridLocal(f2LocalEnd),
                                dateYmd: f2LocalStart.slice(0, 10),
                                bookingType: BOOKING_TYPE.DUALF2,
                                status: citaStatus,
                                bookingStatus: citaStatus,
                                paymentStatus: paymentStatus,
                                pairToken: pairToken,
                                contactDetails: { email: email },
                                locationId: bookingLocation.id,
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
                            },
                            traceId
                        );
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
        const sagaStartTime = Date.now();

        try {
            await saga.execute();

            const persistStepResult =
                saga.completedSteps.find(function (s) {
                    return s.name === "PersistCitas";
                })?.result || null;

            const finalResult = {
                bookingIds: createdBookings.map(function (b) {
                    return b.bookingId;
                }),
                bookingId: createdBookings.find(function (b) {
                    return b.phase === "F1";
                })?.bookingId || null,
                pairToken: pairToken,
                pairTokenSource: tokenResolution.source,
                isDual: isDual,
                resourceId: finalResourceId,
                location: bookingLocation,
                requiresPayment: isOnline,
                checkoutUrl: persistStepResult?.resolvedCheckoutUrl || null,
                status: persistStepResult?.citaStatus || citaStatus,
                paymentStatus: paymentStatus,
                addOnIds: detectedAddonIds,
            };

            try {
                await _completeTransaction(pairToken, finalResult, traceId);
            } catch (completeErr) {
                log.error("_completeTransaction failed; compensating full saga", {
                    pairToken,
                    traceId,
                    error: completeErr?.message,
                });
                try {
                    await _deleteCitasByPairToken(pairToken, traceId);
                } catch (_) { /* best effort */ }
                try {
                    await _compensateCreatedBookings(createdBookings, traceId);
                } catch (_) { /* best effort */ }
                throw completeErr;
            }

            const madridDateYMD = f1LocalStart.slice(0, 10);
            const serviceIdForInvalidate = serviceId;
            const resourceIdForInvalidate = finalResourceId;

            setTimeout(function () {
                _invalidateCachesInternal(
                    serviceIdForInvalidate,
                    madridDateYMD,
                    resourceIdForInvalidate,
                    traceId
                ).catch(function (e) {
                    log.warn("Post-commit cache invalidation failed (background)", {
                        traceId,
                        error: e?.message,
                    });
                });
            }, 0);

            log.info("executeBookingSaga completed", {
                traceId: traceId,
                pairToken: pairToken,
                pairTokenSource: tokenResolution.source,
                isDual: isDual,
                bookingIds: createdBookings.map(function (b) {
                    return b.bookingId;
                }),
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
                    normalizeError(sagaErr)?.code || "SAGA_FAILED"
                );
            } catch (failErr) {
                log.warn("_failTransaction could not be recorded", {
                    pairToken,
                    traceId,
                    error: failErr?.message,
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
        const norm = normalizeError(error);
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
