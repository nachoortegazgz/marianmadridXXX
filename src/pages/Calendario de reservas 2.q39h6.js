/**
 * MODULE: pages/calendario-2.js
 * VERSION: v5003.4-FUNCTIONAL
 * STANDARDS: G10 ASCII Strict, Velo Native Optimized.
 */

import wixLocation from "wix-location-frontend";
import wixWindowFrontend from "wix-window-frontend";

import {
    getServiceBySlugOrId,
    getAvailableDays,
    getAvailableSlots,
    getCertifiedDualSlots,
    resolveStaffForSlot
} from "backend/reservas.web.js";

import {
    MESSAGE_TYPES,
    URLS,
    UI,
    makeTraceId,
    _safeTrim,
    _safeSlugOrId,
    _looksLikeGuid,
    withTimeout
} from "public/mmUtils";

import { createWidgetBridge } from "public/widgetBridge";
import { processDualBooking } from "backend/citasManager.web.js";

let currentServiceId = null;
let currentSlug = null;
let currentService = null;
let bridge = null;

function parseUrlParams() {
    const query = wixLocation.query || {};

    return {
        serviceId: _safeTrim(query.serviceId || ""),
        slug: _safeSlugOrId(query.slug || ""),
        referral: _safeTrim(query.referral || ""),
        addOnIds: _safeTrim(query.addOnIds || "")
            .split(",")
            .map(_safeTrim)
            .filter(Boolean)
    };
}

function resolveServiceFromParams(params) {
    if (params.serviceId && _looksLikeGuid(params.serviceId)) {
        return {
            serviceId: params.serviceId,
            slug: params.slug || null
        };
    }

    if (params.slug) {
        return {
            serviceId: null,
            slug: params.slug
        };
    }

    return null;
}

function getMessageType(message) {
    return String(
        message && (message.type || message.action) || ""
    ).trim().toUpperCase();
}

function getPayload(message) {
    if (
        message &&
        message.payload &&
        typeof message.payload === "object" &&
        !Array.isArray(message.payload)
    ) {
        return message.payload;
    }

    return {};
}

function createResultError(code, message) {
    return {
        status: "ERROR",
        data: null,
        error: { code, message }
    };
}

async function loadServiceContext(params) {
    const lookup = currentServiceId || currentSlug;
    const result = await getServiceBySlugOrId(lookup);

    if (!result || result.status !== "SUCCESS" || !result.data) {
        throw new Error(
            result?.error?.message ||
            "No se pudo cargar el servicio."
        );
    }

    currentService = result.data;

    return {
        ...result.data,
        serviceId: result.data.serviceId || currentServiceId,
        slug: result.data.slug || currentSlug,
        referral: params.referral,
        addOnIds: params.addOnIds,
        timeZone: "Europe/Madrid",
        currency: result.data.currency || "EUR"
    };
}

async function handleNavigation(payload) {
    const target = _safeTrim(payload?.target || "").toUpperCase();

    if (target === "SERVICIOS") {
        wixLocation.to(URLS?.SERVICIOS || "/reserva-online");
        return true;
    }

    if (target === "PRIVACY") {
        wixLocation.to(
            URLS?.PRIVACY_POLICY || "/politica-de-privacidad"
        );
        return true;
    }

    return false;
}

async function handleAvailability(payload, reply) {
    const action = _safeTrim(payload.action || "").toLowerCase();
    const addOnIds = Array.isArray(payload.addOnIds)
        ? payload.addOnIds
        : [];
    let result;

    try {
        if (action === "days") {
            result = await withTimeout(
                getAvailableDays(
                    currentServiceId || currentSlug,
                    payload.resourceId || null,
                    Number(payload.year),
                    Number(payload.month),
                    addOnIds
                ),
                UI?.FRONTEND_API_TIMEOUT_MS || 60000,
                "getAvailableDays"
            );
        } else if (action === "slots") {
            result = await withTimeout(
                currentService?.allowCombine
                    ? getCertifiedDualSlots(
                        currentServiceId || currentSlug,
                        payload.resourceId || null,
                        _safeTrim(payload.dateYMD || payload.dateYmd || ""),
                        addOnIds
                    )
                    : getAvailableSlots(
                        currentServiceId || currentSlug,
                        payload.resourceId || null,
                        _safeTrim(payload.dateYMD || payload.dateYmd || ""),
                        addOnIds
                    ),
                UI?.FRONTEND_API_TIMEOUT_MS || 60000,
                "getAvailableSlots"
            );
        } else {
            result = createResultError(
                "INVALID_AVAILABILITY_REQUEST",
                "Solicitud de disponibilidad no valida."
            );
        }
    } catch (error) {
        result = createResultError(
            "AVAILABILITY_FAILED",
            error?.message || "No se pudo obtener disponibilidad."
        );
    }

    reply(
        MESSAGE_TYPES.AVAIL,
        {
            ...(result || createResultError(
                "EMPTY_AVAILABILITY_RESPONSE",
                "No se recibio disponibilidad."
            )),
            action,
            requestSequence: payload.requestSequence || 0
        },
        payload
    );
}

async function handleSelection(payload, reply) {
    const start = _safeTrim(payload.localStartDate || "");

    if (!start) {
        reply(
            MESSAGE_TYPES.SELECT,
            createResultError(
                "INVALID_SLOT",
                "El horario seleccionado no es valido."
            ),
            payload
        );
        return;
    }

    try {
        const result = await withTimeout(
            resolveStaffForSlot(
                currentServiceId || currentSlug,
                start,
                payload.resourceId || null,
                Array.isArray(payload.addOnIds)
                    ? payload.addOnIds
                    : [],
                null
            ),
            UI?.FRONTEND_API_TIMEOUT_MS || 60000,
            "resolveStaffForSlot"
        );

        reply(
            MESSAGE_TYPES.SELECT,
            result || createResultError(
                "STAFF_RESOLVE_FAILED",
                "No se pudo validar el profesional."
            ),
            payload
        );
    } catch (error) {
        reply(
            MESSAGE_TYPES.SELECT,
            createResultError(
                "STAFF_RESOLVE_FAILED",
                error?.message || "No se pudo validar el profesional."
            ),
            payload
        );
    }
}

// AUDIT-BUG-01/02/05 (v11.6): lista blanca EXPLICITICA del payload de reserva.
// Se prohibe deliberadamente propagar duration/price/professional/phases/payment
// u otros campos internos desde el widget: la fuente de verdad es el contexto
// resuelto en servidor (currentServiceId/currentSlug) y las revalidaciones de
// executeBookingSaga. addOnIds queda solo como compatibilidad de entrada y se
// normaliza al nombre canonico bookedAddOns.
function normalizeBookedAddOns(value) {
    if (!Array.isArray(value)) return [];
    return value.map(_safeTrim).filter(Boolean).slice(0, 20);
}

function buildBookingRequestPayload(bookingData, fallbackTraceId) {
    const slotF1 =
        bookingData.slotF1 && typeof bookingData.slotF1 === "object"
            ? bookingData.slotF1
            : null;
    const slotF2 =
        bookingData.slotF2 && typeof bookingData.slotF2 === "object"
            ? bookingData.slotF2
            : null;

    return {
        serviceId: currentServiceId || bookingData.serviceId || null,
        slug: currentSlug || bookingData.slug || null,
        localStartDate: _safeTrim(bookingData.localStartDate || "") || null,
        resourceId: _safeTrim(bookingData.resourceId || "") || null,
        slotF1,
        slotF2,
        bookedAddOns: normalizeBookedAddOns(
            bookingData.bookedAddOns || bookingData.addOnIds
        ),
        email: _safeTrim(bookingData.email || ""),
        firstName: _safeTrim(bookingData.firstName || ""),
        lastName: _safeTrim(bookingData.lastName || ""),
        phone: _safeTrim(bookingData.phone || ""),
        paymentMethod: _safeTrim(bookingData.paymentMethod || "") || null,
        channelType: _safeTrim(bookingData.channelType || "") || null,
        rgpdConsent: bookingData.rgpdConsent === true,
        pairToken: _safeTrim(bookingData.pairToken || "") || null,
        traceId: _safeTrim(fallbackTraceId || "") || makeTraceId("calendario-book")
    };
}

let lastBookingMessageId = "";

async function handleBooking(message, reply, traceId) {
    const payload = getPayload(message);
    const bookingData =
        payload.bookingData &&
        typeof payload.bookingData === "object"
            ? payload.bookingData
            : payload;

    if (!bookingData || typeof bookingData !== "object") {
        reply(
            MESSAGE_TYPES.BOOK,
            createResultError(
                "INVALID_BOOKING_PAYLOAD",
                "Los datos de la reserva no son validos."
            ),
            message
        );
        return;
    }

    // AUDIT-BUG-21: rechazo de replay local del mismo MM_BOOK dentro de la
    // sesion. La idempotencia fuerte sigue viviendo en el backend
    // (pairToken + transaction gate SAGA-PATCH-02); esto evita duplicados
    // evidentes por doble clic o reintento automatico del widget.
    const messageId = String(message?.messageId || "");
    if (messageId && messageId === lastBookingMessageId) {
        reply(
            MESSAGE_TYPES.BOOK,
            createResultError(
                "DUPLICATE_REQUEST",
                "La solicitud anterior sigue en curso. No repitas el envio."
            ),
            message
        );
        return;
    }
    lastBookingMessageId = messageId;

    const requestPayload = buildBookingRequestPayload(
        bookingData,
        payload.traceId || traceId
    );

    try {
        const result = await withTimeout(
            processDualBooking(requestPayload),
            UI?.FRONTEND_API_TIMEOUT_MS || 60000,
            "processDualBooking"
        );

        const bookingResult = result || createResultError(
            "EMPTY_BOOKING_RESPONSE",
            "No se recibio respuesta de la reserva."
        );

        reply(MESSAGE_TYPES.BOOK, bookingResult, message);

        // AUDIT-BUG-12: el lightbox solo se abre si el backend confirma
        // persistencia real (status SUCCESS + bookingId presente).
        if (
            bookingResult.status === "SUCCESS" &&
            bookingResult.data &&
            bookingResult.data.bookingId
        ) {
            try {
                await wixWindowFrontend.openLightbox(
                    "ConfirmacionReserva",
                    {
                        booking: bookingResult.data || null,
                        service: currentService,
                        traceId
                    }
                );
            } catch (lightboxError) {
                console.error(
                    "[calendario-2] No se pudo abrir ConfirmacionReserva",
                    {
                        traceId,
                        message: lightboxError?.message
                    }
                );
            }
        }
    } catch (error) {
        const timeout =
            error?.code === "TIMEOUT" ||
            String(error?.message || "")
                .toUpperCase()
                .includes("TIMEOUT");

        reply(
            MESSAGE_TYPES.BOOK,
            createResultError(
                timeout ? "BOOKING_TIMEOUT" : "BOOKING_FAILED",
                timeout
                    ? "La reserva esta tardando demasiado. Intentalo de nuevo."
                    : "No se pudo completar la reserva."
            ),
            message
        );
    }
}

$w.onReady(async () => {
    const traceId = makeTraceId("calendario");
    const params = parseUrlParams();
    const resolved = resolveServiceFromParams(params);

    if (!resolved) {
        console.error("[calendario-2] Servicio no valido", { traceId });
        return;
    }

    currentServiceId = resolved.serviceId;
    currentSlug = resolved.slug;

    const widget = $w("#htmlWidgetCalendario");

    if (
        !widget ||
        typeof widget.postMessage !== "function" ||
        typeof widget.onMessage !== "function"
    ) {
        console.error("[calendario-2] Widget HTML no disponible", { traceId });
        return;
    }

    try {
        bridge = createWidgetBridge(widget, {
            onContextReady: async () => loadServiceContext(params),

            onWidgetMessage: async (message, reply) => {
                const type = getMessageType(message);
                const payload = getPayload(message);

                if (type === MESSAGE_TYPES.NAV) {
                    await handleNavigation(payload);
                    return;
                }

                if (type === MESSAGE_TYPES.AVAIL) {
                    await handleAvailability(payload, reply);
                    return;
                }

                if (type === MESSAGE_TYPES.SELECT) {
                    await handleSelection(payload, reply);
                    return;
                }

                if (type === MESSAGE_TYPES.BOOK) {
                    await handleBooking(message, reply, traceId);
                    return;
                }

                if (
                    type !== MESSAGE_TYPES.READY &&
                    type !== MESSAGE_TYPES.CONTEXT
                ) {
                    console.warn(
                        "[calendario-2] Mensaje no soportado",
                        { traceId, type }
                    );
                }
            },

            onError: (error) => {
                console.error(
                    "[calendario-2] Error de comunicacion",
                    {
                        traceId,
                        message: error?.message
                    }
                );
            }
        });

        if (!bridge) {
            throw new Error("No se pudo inicializar el bridge.");
        }
    } catch (error) {
        console.error(
            "[calendario-2] Error de inicializacion",
            {
                traceId,
                message: error?.message
            }
        );
    }
});
