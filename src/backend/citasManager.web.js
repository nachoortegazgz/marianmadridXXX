/*
=============================================================================
MODULE: backend/citasManager.web.js
VERSION: v10.1-ALIGNED
BASE: v10.0-SSOT-FRICTIONLESS + alineacion CMS + internalConfig v20.2
RESPONSIBILITY: Booking processing, payment confirmation and rescheduling.
STANDARDS: G10 ASCII Strict. Sin console.log directo (logger SSOT).

FIXES APLICADOS v10.1-ALIGNED:
  CM-01: _getBookingSlotFromCita lee los campos fisicos reales de CitasF2
         (slotStart / slotEnd via BOOKING_FIELDS). Antes leia startDate /
         endDate que no existen en la coleccion: la proyeccion devolvia
         siempre {startDate: null, endDate: null}.
  CM-02: _getNativeAddonIdsForRevalidation renombrado a
         _getAddOnIdsForRevalidation. Lee el campo canonico addOnIds con
         fallback de lectura a nativeAddonIds (alias heredado del contrato
         bookingCore._persistBooking, EOL 31/12/2026). Alinea con el enum
         v20.2 que ya no expone nativeAddonIds como primario.
  CM-03: COLLECTIONS como nombre canonico. BUSINESS_COLLECTIONS se mantiene
         funcionando por alias en internalConfig v20.2, pero el modulo
         importa el canonico.
  CM-04: _getCitaMeta usa un unico punto de tolerancia JSON (EOL
         31/12/2026). Sin cambios funcionales.
  CM-05: _setCitasPaymentState no depende de BOOKING_STATUS.CONFIRMED
         escrito a un campo inexistente: usa el value canonico del enum y
         delega en _updateCitaSafe (bookingCore) que escribe a
         BOOKING_FIELDS.STATUS = bookingStatus.

FIXES HEREDADOS v10.0:
  C1..C7 (DAL, filtros wql, DUAL_F2, importacion estatica, tolerancia meta,
  aliases eliminados, aviso de seguridad de confirmPayment).

DEPENDENCIAS: backend/dataAccess.js, backend/booking/bookingSaga.js,
  backend/booking/bookingCore.js, backend/cajas.web.js, backend/reservas.web.js,
  backend/security.js, backend/audit.js, backend/logger.js.
=============================================================================
*/

import { webMethod, Permissions } from "wix-web-module";
import { orders } from "@wix/ecom";
import { auth } from "@wix/essentials";

import {
    queryFirstItem,
    queryItems,
    wql,
    CONSISTENCY,
} from "backend/dataAccess";

import {
    COLLECTIONS,
    SDK_CONFIG,
    APP_IDS,
    BOOKING_STATUS,
    PAYMENT_STATUS,
    PAYMENT_METHOD,
    SLOT_SEARCH,
    BOOKING_TYPE,
    BOOKING_FIELDS,
} from "backend/internalConfig";

import {
    makeTraceId,
    _safeTrim,
    _looksLikeGuid,
    _normalizeLocalIsoStr,
    _readPositiveAmount,
    getUtcDateFromMadridLocal,
    withTimeout,
} from "public/mmUtils";

import { toUtcRange, computeGapMinutes } from "backend/booking/bookingUtils";

import { executeBookingSaga } from "backend/booking/bookingSaga";

import {
    normalizeError,
    _handleError,
    ERROR_CODES,
    createBookingError,
    _updateCitaSafe,
} from "backend/booking/bookingCore";

import { registerBookingPayment } from "backend/cajas.web.js";
import { rateLimiter } from "backend/security";
import { logger } from "backend/logger";
import { logAuditEvent } from "backend/audit";
import {
    revalidateExactAvailabilitySlot,
    _getServiceBySlugOrIdInternal,
} from "backend/reservas.web.js";

const log = logger;

// =============================================================================
// BLOQUE 1 - CONSTANTES
// =============================================================================

const CITAS_COL = COLLECTIONS.CITAS_F2;

const API_TIMEOUT_MS = Number(SDK_CONFIG?.TIMEOUTS?.API_MS) || 15000;

const AUDIT_SOURCE = "backend/citasManager.web.js";

const MAX_DUAL_GAP_MINUTES = Math.max(
    0,
    Number(SLOT_SEARCH?.MINUTOS_MAX_HUECO_DUAL) || 120
);

// Elevacion explicita para lectura de ordenes eCommerce (no forma parte del
// DAL interno; @wix/ecom tiene su propio contrato de permisos).
const getOrderElevated = auth.elevate(orders.getOrder);

// =============================================================================
// BLOQUE 2 - HELPERS INTERNOS
// =============================================================================

/**
 * CM-04: tolera meta como string JSON serializado (flujos legacy pre-FASE1)
 * o como objeto plano. EOL 31/12/2026.
 */
function _getCitaMeta(cita) {
    if (!cita) return {};

    const meta = cita.meta;

    if (typeof meta === "string") {
        try {
            const parsed = JSON.parse(meta);
            return parsed && typeof parsed === "object" && !Array.isArray(parsed)
                ? parsed
                : {};
        } catch (_) {
            return {};
        }
    }

    if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
        return {};
    }

    return meta;
}

/**
 * CM-02: lee los add-ons de una cita para revalidacion.
 *
 * Nombre canonico: meta.addOnIds (escrito por bookingCore._persistBooking).
 * Fallback de lectura: meta.nativeAddonIds (alias heredado del contrato
 * bookingSaga v5010.7, EOL 31/12/2026).
 *
 * Devuelve solo GUIDs validos, deduplicados, ordenados.
 */
function _getAddOnIdsForRevalidation(cita) {
    const meta = _getCitaMeta(cita);

    const source = Array.isArray(meta.addOnIds)
        ? meta.addOnIds
        : Array.isArray(meta.nativeAddonIds)
            ? meta.nativeAddonIds
            : [];

    return Array.from(
        new Set(
            source
                .map((id) => _safeTrim(id))
                .filter((id) => _looksLikeGuid(id))
        )
    ).sort();
}

/**
 * C1/C2: lectura fuerte via dataAccess. Sin suppressAuth, sin builder Velo.
 */
async function _findCitaByBookingId(bookingId) {
    const normalizedId = _safeTrim(bookingId);
    if (!normalizedId) return null;

    return queryFirstItem({
        dataCollectionId: CITAS_COL,
        filter: wql.eq(BOOKING_FIELDS.BOOKING_ID, normalizedId),
        consistency: CONSISTENCY.STRONG,
    });
}

/**
 * C1/C2: lectura fuerte via dataAccess. Sin suppressAuth, sin builder Velo.
 */
async function _findCitasByPairToken(pairToken) {
    const normalizedToken = _safeTrim(pairToken);
    if (!normalizedToken) return [];

    const result = await queryItems({
        dataCollectionId: CITAS_COL,
        filter: wql.eq(BOOKING_FIELDS.PAIR_TOKEN, normalizedToken),
        limit: 10,
        offset: 0,
        consistency: CONSISTENCY.STRONG,
    });

    return Array.isArray(result?.items) ? result.items : [];
}

function _rateLimitOrThrow(surface, key, traceId) {
    const result = rateLimiter({ surface, key });

    if (result.allowed) return;

    const error = new Error("RATE_LIMITED");
    error.code = "RATE_LIMITED";
    error.meta = {
        retryAfter: result.retryAfter,
        surface,
        traceId,
    };

    throw error;
}

function _isPaidOrderStatus(value) {
    const status = String(value || "").trim().toUpperCase();

    return ["PAID", "FULLY_PAID", "PAID_FULL"].includes(status);
}

function _getOrderBookingLineItems(order) {
    const lineItems = Array.isArray(order?.lineItems) ? order.lineItems : [];
    const bookingsAppId = APP_IDS.BOOKINGS;

    return lineItems.filter(
        (item) => item?.catalogReference?.appId === bookingsAppId
    );
}

function _getBookingLineItemsTotal(lineItems) {
    return (lineItems || []).reduce((sum, item) => {
        const amount =
            Number(item?.price?.amount ?? item?.price ?? 0) || 0;
        const quantity = Number(item?.quantity) || 1;

        return sum + amount * quantity;
    }, 0);
}

// =============================================================================
// BLOQUE 3 - PUBLIC WEB METHODS
// =============================================================================

export const processDualBooking = webMethod(
    Permissions.Anyone,
    async (unsafePayload) => {
        const traceId = unsafePayload?.traceId || makeTraceId("dual-bkg");

        try {
            _rateLimitOrThrow(
                "citasManager.processDualBooking",
                _safeTrim(unsafePayload?.email) || "anon",
                traceId
            );

            return await executeBookingSaga({
                ...(unsafePayload || {}),
                traceId,
            });
        } catch (error) {
            return _handleError(error, "processDualBooking", traceId);
        }
    }
);

/**
 * C7: Permissions.SiteMember restringe el acceso a miembros autenticados.
 * ADVERTENCIA DE SEGURIDAD: este metodo NO verifica que el miembro sea
 * propietario de la reserva ni de la orden. Antes de desplegar pagos en
 * produccion, implementar la comprobacion de propiedad en _assertBookingOwner
 * o en un guard previo. Reemplazar las consultas por si solo no resuelve
 * este punto.
 */
export const confirmPayment = webMethod(
    Permissions.SiteMember,
    async (payload) => {
        const traceId = payload?.traceId || makeTraceId("confirm-pay");

        try {
            _rateLimitOrThrow(
                "citasManager.confirmPayment",
                _safeTrim(payload?.orderId) || "anon",
                traceId
            );

            const orderId = _safeTrim(payload?.orderId);

            const bookingIds = Array.isArray(payload?.bookingIds)
                ? Array.from(
                    new Set(
                        payload.bookingIds
                            .map((id) => _safeTrim(id))
                            .filter((id) => _looksLikeGuid(id))
                    )
                )
                : [];

            const requestedAmount = _readPositiveAmount(payload?.amount);

            if (!orderId || bookingIds.length === 0) {
                return {
                    status: "ERROR",
                    data: null,
                    error: {
                        code: "INVALID_PAYLOAD",
                        message: "orderId and valid bookingIds are required.",
                    },
                };
            }

            const { finalAmount } = await _getValidatedPaidOrder(
                orderId,
                bookingIds,
                requestedAmount,
                traceId
            );

            const citas = [];

            for (const bookingId of bookingIds) {
                const cita = await _findCitaByBookingId(bookingId);

                if (!cita) {
                    return {
                        status: "ERROR",
                        data: null,
                        error: {
                            code: "CITA_NOT_FOUND",
                            message: "Booking record was not found.",
                        },
                    };
                }

                citas.push(cita);
            }

            await _validatePaymentCitaSet(citas, orderId, traceId);

            const linkedBookingIds = bookingIds.join(",");

            const ledgerResult = await registerBookingPayment(
                linkedBookingIds,
                finalAmount,
                PAYMENT_METHOD.ONLINE,
                {
                    concept: "Online booking payment",
                    resourceId: "online",
                    traceId,
                    transactionId: `ORDER-${orderId}`,
                    orderId,
                    origen: "WIX_ECOM_PAYMENT_CONFIRM",
                    movementType: "VENTA_ONLINE",
                }
            );

            if (ledgerResult?.status !== "SUCCESS") {
                await logAuditEvent(
                    "PAYMENT_LEDGER_FAILED",
                    "ERROR",
                    "Payment ledger registration failed.",
                    {
                        orderId,
                        traceId,
                        error: ledgerResult?.error?.message || null,
                    },
                    traceId,
                    orderId,
                    AUDIT_SOURCE
                );

                return {
                    status: "ERROR",
                    data: null,
                    error: {
                        code: "LEDGER_FAIL",
                        message:
                            ledgerResult?.error?.message ||
                            "Payment registration failed.",
                    },
                };
            }

            const cashMovementId =
                ledgerResult?.data?.cabeceraId ||
                ledgerResult?.data?._id ||
                null;

            if (!cashMovementId) {
                await logAuditEvent(
                    "PAYMENT_LEDGER_FAILED",
                    "ERROR",
                    "Ledger registered without cash movement reference.",
                    { orderId, traceId, error: "LEDGER_REFERENCE_MISSING" },
                    traceId,
                    orderId,
                    AUDIT_SOURCE
                );

                return {
                    status: "ERROR",
                    data: null,
                    error: {
                        code: "LEDGER_REFERENCE_MISSING",
                        message:
                            "Payment could not be confirmed: ledger reference missing.",
                    },
                };
            }

            await _setCitasPaymentState(
                citas,
                PAYMENT_STATUS.PAID,
                orderId,
                cashMovementId,
                traceId
            );

            await logAuditEvent(
                "PAYMENT_CONFIRMED",
                "INFO",
                "Booking payment confirmed.",
                {
                    orderId,
                    bookingIds,
                    amount: finalAmount,
                    traceId,
                },
                traceId,
                orderId,
                AUDIT_SOURCE
            );

            return {
                status: "SUCCESS",
                data: {
                    orderId,
                    bookingIds,
                    amount: finalAmount,
                    paymentStatus: PAYMENT_STATUS.PAID,
                },
                error: null,
            };
        } catch (error) {
            const normalized = normalizeError(error);

            log.error("confirmPayment failed", {
                code: normalized.code,
                error: normalized.message,
                traceId,
            });

            return {
                status: "ERROR",
                data: null,
                error: {
                    code: normalized.code || "CONFIRM_PAY_FAIL",
                    message: normalized.message,
                },
            };
        }
    }
);

// =============================================================================
// BLOQUE 4 - ORDER VALIDATION
// =============================================================================

async function _getValidatedPaidOrder(
    orderId,
    bookingIds,
    requestedTotalAmount,
    traceId
) {
    const normalizedOrderId = _safeTrim(orderId);

    if (!normalizedOrderId) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "orderId is required",
            { traceId }
        );
    }

    let order;

    try {
        order = await withTimeout(
            getOrderElevated(normalizedOrderId),
            API_TIMEOUT_MS,
            "getOrder"
        );
    } catch (error) {
        throw createBookingError(
            ERROR_CODES.DATABASE_ERROR,
            "Failed to fetch order.",
            { traceId, cause: error?.message }
        );
    }

    if (!order) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "Order not found",
            { traceId }
        );
    }

    const paymentStatus = String(order?.paymentStatus || "").toUpperCase();

    if (!_isPaidOrderStatus(paymentStatus)) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "Order is not paid.",
            { traceId, paymentStatus }
        );
    }

    const bookingLineItems = _getOrderBookingLineItems(order);

    const orderBookingIds = bookingLineItems
        .map((item) => String(item?.catalogReference?.catalogItemId || ""))
        .filter(Boolean);

    for (const bookingId of bookingIds) {
        if (!orderBookingIds.includes(String(bookingId))) {
            throw createBookingError(
                ERROR_CODES.INVALID_PAYLOAD,
                "Booking is not included in the order.",
                { traceId, bookingId }
            );
        }
    }

    const orderTotal = Number(order?.priceSummary?.total?.amount ?? 0) || 0;

    const lineItemsTotal = _getBookingLineItemsTotal(bookingLineItems);

    const finalAmount = orderTotal > 0 ? orderTotal : lineItemsTotal;

    if (
        requestedTotalAmount &&
        Math.abs(finalAmount - requestedTotalAmount) > 0.01
    ) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "Amount does not match the order.",
            { traceId }
        );
    }

    return { order, finalAmount, bookingLineItems };
}

async function _validatePaymentCitaSet(citas, orderId, traceId) {
    for (const cita of citas) {
        const meta = _getCitaMeta(cita);

        const currentPaymentStatus = String(
            cita.paymentStatus || meta.paymentStatus || ""
        ).toUpperCase();

        if (currentPaymentStatus === PAYMENT_STATUS.PAID) {
            throw createBookingError(
                ERROR_CODES.INVALID_PAYLOAD,
                "Booking is already paid.",
                { traceId, bookingId: cita.bookingId, orderId }
            );
        }

        if (currentPaymentStatus === PAYMENT_STATUS.REFUNDED) {
            throw createBookingError(
                ERROR_CODES.INVALID_PAYLOAD,
                "Booking has already been refunded.",
                { traceId, bookingId: cita.bookingId, orderId }
            );
        }
    }
}

/**
 * CM-05: _setCitasPaymentState delega la escritura en _updateCitaSafe
 * (bookingCore), que a su vez escribe a BOOKING_FIELDS.STATUS
 * (bookingStatus en v20.2). La cita se actualiza con:
 *   - bookingStatus: BOOKING_STATUS.CONFIRMED
 *   - paymentStatus: PAYMENT_STATUS.PAID
 *   - cashMovementId, orderId, traceId
 *   - meta ampliada con los mismos campos mas fechaConfirmacionPago
 */
async function _setCitasPaymentState(
    citas,
    paymentState,
    orderId,
    cashMovementId,
    traceId
) {
    for (const cita of citas) {
        const bookingId = _safeTrim(cita?.bookingId);

        if (!bookingId) {
            throw createBookingError(
                ERROR_CODES.INVALID_PAYLOAD,
                "Booking identifier is missing.",
                { traceId }
            );
        }

        await _updateCitaSafe(
            bookingId,
            (currentCita) => {
                const meta = _getCitaMeta(currentCita);

                return {
                    ...currentCita,
                    bookingStatus: BOOKING_STATUS.CONFIRMED,
                    paymentStatus: paymentState,
                    cashMovementId: cashMovementId || null,
                    orderId: orderId || null,
                    traceId,
                    meta: {
                        ...meta,
                        paymentStatus: paymentState,
                        cashMovementId: cashMovementId || null,
                        orderId: orderId || null,
                        traceId,
                        fechaConfirmacionPago: new Date(),
                    },
                };
            },
            traceId,
            "citasManager_setPaymentState"
        );
    }
}

// =============================================================================
// BLOQUE 5 - BOOKING LOOKUP
// =============================================================================

/**
 * C7: ADVERTENCIA - Esta funcion actualmente solo verifica que la cita exista.
 * NO comprueba que el miembro autenticado sea propietario de la reserva.
 * Antes de desplegar confirmPayment en produccion, implementar aqui la
 * verificacion de propiedad comparando cita.contactDetails.memberId con
 * el miembro de la sesion actual.
 */
async function _assertBookingOwner(cita, traceId) {
    if (!cita) {
        throw createBookingError(
            ERROR_CODES.AUTH_REQUIRED,
            "Booking was not found.",
            { traceId }
        );
    }

    return true;
}

/**
 * CM-01: lee los campos fisicos reales de CitasF2.
 *   slotStart / slotEnd (BOOKING_FIELDS.SLOT_START / SLOT_END).
 * Antes leia startDate / endDate que NO existen en la coleccion.
 */
function _getBookingSlotFromCita(cita) {
    return {
        serviceId: _safeTrim(cita?.serviceId),
        resourceId: _safeTrim(cita?.resourceId),
        startDate: cita?.[BOOKING_FIELDS.SLOT_START] || null,
        endDate: cita?.[BOOKING_FIELDS.SLOT_END] || null,
    };
}

/**
 * C6: sin alias start/end; solo localStartDate/localEndDate canonicos.
 */
function _getDualSlotInput(payload, key) {
    const slot = payload?.[key];

    if (!slot || typeof slot !== "object") return null;

    return {
        localStartDate: _normalizeLocalIsoStr(slot.localStartDate),
        localEndDate: _normalizeLocalIsoStr(slot.localEndDate),
        serviceId: _safeTrim(slot.serviceId || ""),
    };
}

function _matchesCitaPairIdentifier(cita, token) {
    const meta = _getCitaMeta(cita);

    const pairToken = _safeTrim(
        cita?.[BOOKING_FIELDS.PAIR_TOKEN] || meta.pairToken
    );

    return pairToken === _safeTrim(token);
}

function _buildDualRescheduleSlot(serviceConfig, inputSlot, expectedServiceId) {
    if (
        !serviceConfig ||
        !inputSlot?.localStartDate ||
        !inputSlot?.localEndDate
    ) {
        return null;
    }

    const linkedServiceId = _safeTrim(serviceConfig.linkedPhases || "");
    const expectedId = _safeTrim(expectedServiceId);

    if (!linkedServiceId || !expectedId || linkedServiceId !== expectedId) {
        return null;
    }

    return {
        serviceId: linkedServiceId,
        localStartDate: inputSlot.localStartDate,
        localEndDate: inputSlot.localEndDate,
    };
}

/**
 * C4: importacion estatica de _getServiceBySlugOrIdInternal (anadida en la
 * cabecera). Se elimina la importacion dinamica que rompia el analisis
 * estatico de dependencias y dificultaba la auditoria de seguridad.
 */
async function _loadServiceConfigForCita(cita, traceId) {
    const meta = _getCitaMeta(cita);

    const serviceId = _safeTrim(cita?.serviceId || meta.serviceId);

    if (!serviceId) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "Booking service is missing.",
            { traceId }
        );
    }

    const result = await _getServiceBySlugOrIdInternal(serviceId, traceId);

    if (result?.status !== "SUCCESS" || !result?.data) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "Booking service configuration was not found.",
            { traceId }
        );
    }

    return result.data;
}

// =============================================================================
// BLOQUE 6 - DUAL SLOT REVALIDATION
// =============================================================================

async function _revalidateDualInputSlots(
    citas,
    slotF1Input,
    slotF2Input,
    traceId
) {
    if (!slotF1Input?.localStartDate || !slotF1Input?.localEndDate) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "F1 slot dates are required.",
            { traceId }
        );
    }

    if (!slotF2Input?.localStartDate || !slotF2Input?.localEndDate) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "F2 slot dates are required.",
            { traceId }
        );
    }

    // C3: BOOKING_TYPE.DUAL_F2 (ADR-17 SNAKE_CASE).
    const f1Cita =
        citas.find((cita) => {
            const meta = _getCitaMeta(cita);

            return !(
                cita?.bookingType === BOOKING_TYPE.DUAL_F2 ||
                meta.linkedF1BookingId
            );
        }) || citas[0];

    const f2Cita =
        citas.find((cita) => {
            const meta = _getCitaMeta(cita);

            return (
                cita?.bookingType === BOOKING_TYPE.DUAL_F2 ||
                Boolean(meta.linkedF1BookingId)
            );
        }) || citas[1];

    if (!f1Cita || !f2Cita) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "Both dual booking phases are required.",
            { traceId }
        );
    }

    const f1ServiceId = _safeTrim(
        f1Cita.serviceId || _getCitaMeta(f1Cita).serviceId
    );

    const f2ServiceId = _safeTrim(
        f2Cita.serviceId || _getCitaMeta(f2Cita).serviceId
    );

    const f1ResourceId = _safeTrim(f1Cita.resourceId);
    const f2ResourceId = _safeTrim(f2Cita.resourceId);

    if (f1ResourceId && f2ResourceId && f1ResourceId !== f2ResourceId) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "Dual phases must use the same staff member.",
            { traceId }
        );
    }

    const selectedResourceId = f1ResourceId || f2ResourceId || null;

    // CM-02: lectura canonica via _getAddOnIdsForRevalidation.
    const f1Addons = _getAddOnIdsForRevalidation(f1Cita);
    const f2Addons = _getAddOnIdsForRevalidation(f2Cita);

    const f1Result = await revalidateExactAvailabilitySlot({
        serviceId: f1ServiceId,
        localStartDate: slotF1Input.localStartDate,
        localEndDate: slotF1Input.localEndDate,
        resourceId: selectedResourceId,
        nativeAddonIds: f1Addons,
        traceId,
    });

    if (f1Result?.status !== "SUCCESS") {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "F1 slot is no longer available.",
            { traceId }
        );
    }

    const f2Result = await revalidateExactAvailabilitySlot({
        serviceId: f2ServiceId,
        localStartDate: slotF2Input.localStartDate,
        localEndDate: slotF2Input.localEndDate,
        resourceId: selectedResourceId,
        nativeAddonIds: f2Addons,
        traceId,
    });

    if (f2Result?.status !== "SUCCESS") {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "F2 slot is no longer available.",
            { traceId }
        );
    }

    const range = toUtcRange(
        slotF1Input.localStartDate,
        slotF1Input.localEndDate
    );

    const f2StartUtc = getUtcDateFromMadridLocal(slotF2Input.localStartDate);

    if (!range || !f2StartUtc) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "Dual slot dates are invalid.",
            { traceId }
        );
    }

    const { endUtc: f1EndUtc } = range;

    if (f2StartUtc.getTime() < f1EndUtc.getTime()) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "F2 must start after F1.",
            { traceId }
        );
    }

    const gapMinutes = computeGapMinutes(f1EndUtc, f2StartUtc);

    if (gapMinutes > MAX_DUAL_GAP_MINUTES) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "Gap between F1 and F2 exceeds the maximum allowed.",
            { traceId, gapMinutes, maxGap: MAX_DUAL_GAP_MINUTES }
        );
    }

    return {
        f1Cita,
        f2Cita,
        f1Result,
        f2Result,
        selectedResourceId,
        gapMinutes,
    };
}
