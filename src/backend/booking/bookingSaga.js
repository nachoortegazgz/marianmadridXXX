/*
MODULE: backend/booking/bookingSaga.js
VERSION: v5010.3-COMPENSATION-REVISION-GUARD
BASE: v5010.2-CORE-ALIGNED + PATCH COMPENSATION REVISION GUARD
STANDARDS: G10 ASCII Strict. Cero suppressHooks/suppressAuth en dataLegacyAdapter.
PATCH v5010.3:
  - _compensateCreatedBookings: guarda de revision antes de cancelar. Si la
    revision es missing o invalida, se logea y se salta la cancelacion para
    evitar llamadas a Wix con revision=NaN/0 que generan errores silenciosos
    y reservas huerfanas no compensadas.

FIXES APLICADOS v5010.2 (heredados):
SAGA-PATCH-01: _buildBookedAddOns movido a helper local (no existe en bookingCore).
SAGA-PATCH-02: Idempotencia reordenada. _initTransaction es la PUERTA antes de
               cualquier retorno de duplicado.
SAGA-PATCH-03: suppressAuth/suppressHooks eliminados de TODAS las llamadas a
               wixData y cancelBookingElevated.
SAGA-PATCH-04: Compensacion alineada al esquema ControlOperativo canonico.
SAGA-PATCH-05: Revision preservada exactamente.
SAGA-PATCH-06: Add-ons fail-closed.
SAGA-PATCH-07: Requiere bookingCore v5010.8+ (parser de slot key de 5 piezas).
*/

import { bookings } from "@wix/bookings";
import { auth } from "@wix/essentials";
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
const LOCKTTLMS = Number(CONCURRENCY && CONCURRENCY.MSTTLMUTEX) || 300000;
const HEARTBEATMS = Number(CONCURRENCY && CONCURRENCY.MS_LATIDO) || 15000;
const CITASCOL = BUSINESSCOLLECTIONS.CITASF2;
const SERVICIOSCOL = BUSINESSCOLLECTIONS.SERVICIOSCATALOGO;
const COMPENSACIONESCOL = OPERATIONALCOLLECTIONS.CONTROLOPERATIVO;
const MINUTOSMAXHUECO_DUAL = Math.max(
    0,
    Number(SLOTSEARCH && SLOTSEARCH.MINUTOSMAXHUECO_DUAL) || 120
);
const BOOKINGCREATIONTIMEOUT_MS =
    Number(SDKCONFIG && SDKCONFIG.TIMEOUTS && SDKCONFIG.TIMEOUTS.BOOKINGCREATION_MS) || 25000;
const CHECKOUTTIMEOUTMS =
    Number(SDKCONFIG && SDKCONFIG.TIMEOUTS && SDKCONFIG.TIMEOUTS.CHECKOUTMS) || 20000;
const APITIMEOUTMS =
    Number(SDKCONFIG && SDKCONFIG.TIMEOUTS && SDKCONFIG.TIMEOUTS.APIMS) || 15000;
const MAXADDONSPER_BOOKING = 5;
const SKIPAVAILABILITYVALIDATION = false;
const PAYMENTSTATUSNOTPAID = safeTrim(PAYMENTSTATUS.NOTPAID);
const PAYMENTSTATUSPENDING = safeTrim(PAYMENTSTATUS.PENDING_PAYMENT);
const BOOKINGSTATUSCONFIRMED = safeTrim(BOOKINGSTATUS.CONFIRMED);
const BOOKINGSTATUSPENDINGPAYMENT = safeTrim(
    BOOKINGSTATUS.PENDING || BOOKINGSTATUS.PENDING_PAYMENT
);
const NONCANCELABLESTATUSES = new Set(
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
    const emailHash = hashKey(safeTrim(email).toLowerCase());
    const payload = _stableSerialize({
        serviceId: _safeTrim(serviceId),
        resourceId: _safeTrim(resourceId),
        f1Start: _safeTrim(f1Start),
        f2Start: _safeTrim(f2Start || ""),
    });
    const hash = _hashKey(payload + "|" + emailHash);
    return "pt" + hash.slice(0, 32);
}

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
    for (var i = 0; i = 0;
        if (!isAccessDenied) throw err;
        log.info("Elevating createBooking due to ACCESS_DENIED", { traceId: traceId });
        return await withTimeout(
            function () { return auth.elevate(bookings.createBooking)(booking, options); },
            BOOKINGCREATIONTIMEOUT_MS,
            "createBooking:elevated"
        );
    }
}

// =============================================================================
// BLOCK 6 - VALIDACION DEFENSIVA DE RESPUESTA (FIX-42 + SAGA-PATCH-05)
// =============================================================================
function _validateCreateBookingResponse(booking, phase, traceId) {
    var id = safeTrim((booking && booking.id) || (booking && booking.id));
    if (!id || !_looksLikeGuid(id)) {
        log.error("CreateBooking returned invalid booking", {
            phase: phase,
            traceId: traceId,
            hasId: Boolean(booking && booking.id),
            hasid: Boolean(booking && booking.id),
        });
        throw createBookingError(
            ERRORCODES.BOOKINGCREATION_FAILED,
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
        log.warn("DOUBLEBOOKINGDETECTED", {
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
            ERRORCODES.INVALIDDATES,
            "Dual gap validation: invalid dates",
            { traceId: traceId, f1LocalEnd: f1LocalEnd, f2LocalStart: f2LocalStart }
        );
    }
    var f1EndUtc = getUtcDateFromMadridLocal(f1EndLocal);
    var f2StartUtc = getUtcDateFromMadridLocal(f2StartLocal);
    if (!f1EndUtc || !f2StartUtc) {
        throw createBookingError(
            ERRORCODES.INVALIDDATES,
            "Dual gap validation: could not convert to UTC",
            { traceId: traceId, f1LocalEnd: f1LocalEnd, f2LocalStart: f2LocalStart }
        );
    }
    var rawDiffMinutes = (f2StartUtc.getTime() - f1EndUtc.getTime()) / 60000;
    if (rawDiffMinutes  MINUTOSMAXHUECO_DUAL) {
        throw createBookingError(
            ERRORCODES.INVALIDPAYLOAD,
            "Dual gap validation: gap " + gapMinutes.toFixed(2) +
            " min exceeds MAX (" + MINUTOSMAXHUECO_DUAL + ")",
            { traceId: traceId, gapMinutes: gapMinutes, maxGapMinutes: MINUTOSMAXHUECO_DUAL }
        );
    }
    return { gapMinutes: gapMinutes, maxGapMinutes: MINUTOSMAXHUECO_DUAL };
}

// =============================================================================
// BLOCK 9 - VALIDACION DEL SERVICIO F2 (FIX-32, FIX-36, SAGA-08)
// =============================================================================
async function _validateLinkedPhaseService(linkedPhases, parentLocationId, traceId) {
    var linkedServiceId = _safeTrim(linkedPhases);
    if (!linkedServiceId || !_looksLikeGuid(linkedServiceId)) {
        throw createBookingError(
            ERRORCODES.SERVICENOT_FOUND,
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
            ERRORCODES.SERVICENOT_FOUND,
            "Linked phase service " + linkedServiceId + " not found in catalog",
            { traceId: traceId }
        );
    }
    var isHidden = service.clientHidden === true;
    if (isHidden) {
        throw createBookingError(
            ERRORCODES.SERVICENOT_FOUND,
            "Linked phase service " + linkedServiceId + " is hidden",
            { traceId: traceId }
        );
    }
    var serviceType = _safeTrim(service.serviceType).toUpperCase();
    if (serviceType && serviceType !== "APPOINTMENT" && serviceType !== "CITA") {
        throw createBookingError(
            ERRORCODES.INVALIDPAYLOAD,
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
    if (phase2Duration  MAXADDONSPER_BOOKING) {
        throw createBookingError(
            ERRORCODES.INVALIDPAYLOAD,
            "Too many addOnOptions requested (" + unique.length +
            "). Maximum allowed is " + MAXADDONSPER_BOOKING + ".",
            { traceId: traceId, addonCount: unique.length, max: MAXADDONSPER_BOOKING }
        );
    }

    var catalogAddons = Array.isArray(serviceConfig && serviceConfig.metadata && serviceConfig.metadata.addOnOptions)
        ? serviceConfig.metadata.addOnOptions
        : [];
    var allowedSet = new Set();
    for (var c = 0; c  0 && allowedSet.size > 0) {
        var unmapped = [];
        var validated = [];
        for (var u = 0; u  0) {
            throw createBookingError(
                ERRORCODES.INVALIDPAYLOAD,
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

/
 * SAGA-PATCH-01: Helper local. bookingCore NO exporta _buildBookedAddOns.
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
            ERRORCODES.INVALIDPAYLOAD,
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
            ERRORCODES.INVALIDPAYLOAD,
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
        for (var i = 0; i  F2
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
                var bookingOptions = Object.freeze({
                    flowControlSettings: Object.freeze({
                        skipAvailabilityValidation: SKIPAVAILABILITYVALIDATION,
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
                    throw createBookingError(ERRORCODES.INVALIDPAYLOAD, "Failed to build pristine slot F1", { traceId: traceId });
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
                    (PAYMENTMETHOD && PAYMENTMETHOD.ONLINE) ||
                    "ONLINE"
                ).toUpperCase();
                if (
                    payMethodEarly === safeTrim(PAYMENTMETHOD && PAYMENT_METHOD.ONLINE).toUpperCase() ||
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
                        throw createBookingError(ERRORCODES.INVALIDPAYLOAD, "Failed to build pristine slot F2", { traceId: traceId });
                    }
                    pristineF2.location = bookingLocation;
                    _assertPristineSlotContract(pristineF2, "F2", traceId);

                    var bookingBodyF2 = {
                        bookedEntity: { slot: pristineF2 },
                        contactDetails: contactDetails,
                        totalParticipants: 1,
                    };
                    if (
                        payMethodEarly === safeTrim(PAYMENTMETHOD && PAYMENT_METHOD.ONLINE).toUpperCase() ||
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
        // =========================================================================
        var paymentMethod = _safeTrim(
            (unsafePayload && unsafePayload.paymentMethod) || metaCita.paymentMethod || "PRESENCIAL"
        ).toUpperCase();
        var isOnline = paymentMethod === safeTrim(PAYMENTMETHOD && PAYMENT_METHOD.ONLINE).toUpperCase();

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
                        CHECKOUTTIMEOUTMS,
                        "createCheckout"
                    );
                    var checkoutUrl = await _executeWithRetry(
                        function () {
                            return withTimeout(
                                function () { return getCheckoutUrlElevated(_extractCheckoutId(checkoutRes)); },
                                APITIMEOUTMS,
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
                for (var ci = 0; ci < createdBookings.length; ci++) {
                    var booking = createdBookings[ci];
                    var confirmResult = await _executeWithRetry(
                        function () {
                            return withTimeout(
                                function () {
                                    return confirmOrDeclineBookingElevated(booking.bookingId, {
                                        paymentStatus: PAYMENTSTATUSNOT_PAID,
                                    });
                                },
                                APITIMEOUTMS,
                                "confirmOrDecline"
                            );
                        },
                        2,
                        300
                    );
                    checkDoubleBookingFlag(confirmResult, "CONFIRM" + booking.phase, traceId);
                    booking.bookingStatus =
                        _safeTrim(confirmResult && confirmResult.booking && confirmResult.booking.bookingStatus) ||
                        _safeTrim(confirmResult && confirmResult.booking && confirmResult.booking.status) ||
                        _safeTrim(confirmResult && confirmResult.bookingStatus) ||
                        _safeTrim(confirmResult && confirmResult.status) ||
                        BOOKINGSTATUSCONFIRMED;
                }
                return {
                    requiresPayment: false,
                    bookingIds: createdBookings.map(function (b) { return b.bookingId; }),
                };
            },
            async function () {}
        );

        var paymentStatus = isOnline ? PAYMENTSTATUSPENDING : PAYMENTSTATUSNOT_PAID;
        var citaStatus = isOnline ? BOOKINGSTATUSPENDINGPAYMENT : BOOKINGSTATUS_CONFIRMED;

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
                    throw createBookingError(ERRORCODES.INVALIDPAYLOAD, "Unable to resolve scheduleId for F1", { traceId: traceId, bookingId: bookingF1Id });
                }
                await _persistBooking({
                    bookingId: bookingF1Id,
                    revision: revisionF1,
                    serviceId: serviceId,
                    scheduleId: scheduleIdF1,
                    resourceId: finalResourceId,
                    startDate: getUtcDateFromMadridLocal(f1LocalStart),
                    endDate: getUtcDateFromMadridLocal(f1LocalEnd),
                    bookingType: isDual ? BOOKINGTYPE.DUALF1 : BOOKINGTYPE.SIMPLE,
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
                        throw createBookingError(ERRORCODES.INVALIDPAYLOAD, "Unable to resolve scheduleId for F2", { traceId: traceId, bookingId: bookingF2Id });
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
                try { await deleteCitasByPairToken(pairToken, traceId); } catch () { / best effort / }
                try { await compensateCreatedBookings(createdBookings, traceId); } catch () { / best effort / }
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
                skipAvailabilityValidation: SKIPAVAILABILITYVALIDATION,
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
                code: norm.code || ERRORCODES.UNKNOWNERROR,
                message: norm.message,
            },
        };
    }
}
