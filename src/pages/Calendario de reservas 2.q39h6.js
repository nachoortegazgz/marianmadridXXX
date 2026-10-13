/**
 * MODULE: pages/calendario-2.js
 * VERSION: v5005-CONSOLIDATED
 * STANDARDS: G10 ASCII Strict, Velo Native Optimized.
 *
 * Alineado con:
 *   - widget HTML (protocolo v1, messageId unico, addOnIds, slotF1/slotF2)
 *   - backend/reservas.web.js (getServiceBySlugOrId, getAvailableDays, getAvailableSlots, getCertifiedDualSlots)
 *   - backend/citasManager.web.js (processDualBooking)
 *   - CMS ServiciosCatalogo (field keys title, description, price, location, addOnOptions, staffOptions)
 *   - CMS ComplementosCatalogo (field key addonId = GUID del complemento)
 *
 * Contrato BOOK (raiz, sin legacy, sin alias):
 *   serviceId, slug,
 *   slotF1 {localStartDate, localEndDate, slotRef},
 *   slotF2 {localStartDate, localEndDate, slotRef} | null,
 *   resourceId, addOnIds[], email, firstName, lastName, phone,
 *   paymentMethod, rgpdConsent
 */

import wixLocation from "wix-location-frontend";
import wixWindowFrontend from "wix-window-frontend";

import {
    getServiceBySlugOrId,
    getAvailableDays,
    getAvailableSlots,
    getCertifiedDualSlots
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
let lastBookingMessageId = "";

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
        return { serviceId: params.serviceId, slug: params.slug || null };
    }
    if (params.slug) {
        return { serviceId: null, slug: params.slug };
    }
    return null;
}

function getMessageType(message) {
    return String(message?.type || "").trim().toUpperCase();
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
        throw new Error(result?.error?.message || "No se pudo cargar el servicio.");
    }

    currentService = result.data;

    return {
        ...result.data,
        serviceId: result.data.serviceId || currentServiceId,
        slug: result.data.slug || currentSlug,
        referral: params.referral,
        addOnIds: params.addOnIds
    };
}

function handleNavigation(payload) {
    const target = _safeTrim(payload?.target || "").toUpperCase();

    if (target === "SERVICIOS") {
        wixLocation.to(URLS?.SERVICIOS || "/reserva-online");
        return true;
    }
    if (target === "PRIVACY") {
        wixLocation.to(URLS?.PRIVACY_POLICY || "/politica-de-privacidad");
        return true;
    }
    return false;
}

async function handleAvailability(payload, reply) {
    const action = _safeTrim(payload.action || "").toLowerCase();
    const addOnIds = normalizeAddOnIds(payload.addOnIds || payload.bookedAddOns);
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
            const dateYmd = _safeTrim(payload.dateYmd || "");
            result = await withTimeout(
                currentService?.allowCombine
                    ? getCertifiedDualSlots(
                        currentServiceId || currentSlug,
                        payload.resourceId || null,
                        dateYmd,
                        addOnIds
                    )
                    : getAvailableSlots(
                        currentServiceId || currentSlug,
                        payload.resourceId || null,
                        dateYmd,
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
        }
    );
}

function normalizeAddOnIds(value) {
    if (!Array.isArray(value)) return [];
    return Array.from(new Set(value.map((item) => {
        if (typeof item === "string") return _safeTrim(item);
        if (item && typeof item === "object") {
            return _safeTrim(item.addOnId || item.addonId || item.id || item.value);
        }
        return "";
    }).filter(Boolean))).slice(0, 20);
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
    const contact = bookingData.cliente && typeof bookingData.cliente === "object"
        ? bookingData.cliente
        : {};
    const addOnIds = normalizeAddOnIds(
        bookingData.addOnIds || bookingData.bookedAddOns
    );

    return {
        serviceId: currentServiceId || bookingData.serviceId || null,
        slug: currentSlug || bookingData.slug || null,
        slotF1,
        slotF2,
        resourceId: _safeTrim(bookingData.resourceId || "") || null,
        addOnIds,
        email: _safeTrim(bookingData.email || contact.email || ""),
        firstName: _safeTrim(bookingData.firstName || contact.firstName || contact.nombre || ""),
        lastName: _safeTrim(bookingData.lastName || contact.lastName || ""),
        phone: _safeTrim(bookingData.phone || contact.phone || contact.telefono || ""),
        paymentMethod: _safeTrim(bookingData.paymentMethod || "") || null,
        rgpdConsent: bookingData.rgpdConsent === true,
        pairToken: _safeTrim(bookingData.pairToken || "") || null,
        traceId: _safeTrim(fallbackTraceId || "") || makeTraceId("calendario-book")
    };
}

async function handleBooking(message, reply, traceId) {
    const bookingData = getPayload(message);

    if (!bookingData || typeof bookingData !== "object" || Array.isArray(bookingData)) {
        reply(
            MESSAGE_TYPES.BOOK,
            createResultError(
                "INVALID_BOOKING_PAYLOAD",
                "Los datos de la reserva no son validos."
            )
        );
        return;
    }

    const messageId = String(message?.messageId || "");
    if (messageId && messageId === lastBookingMessageId) {
        reply(
            MESSAGE_TYPES.BOOK,
            createResultError(
                "DUPLICATE_REQUEST",
                "La solicitud anterior sigue en curso. No repitas el envio."
            )
        );
        return;
    }
    lastBookingMessageId = messageId;

    const requestPayload = buildBookingRequestPayload(
        bookingData,
        bookingData.traceId || traceId
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

        reply(MESSAGE_TYPES.BOOK, bookingResult);

        if (
            bookingResult.status === "SUCCESS" &&
            bookingResult.data &&
            bookingResult.data.bookingId
        ) {
            if (bookingResult.data.requiresPayment && bookingResult.data.checkoutUrl) {
                wixLocation.to(bookingResult.data.checkoutUrl);
                return;
            }
            try {
                await wixWindowFrontend.openLightbox(
                    "ConfirmacionReserva",
                    {
                        booking: bookingResult.data || null,
                        bookingId: bookingResult.data.bookingId,
                        service: currentService,
                        traceId
                    }
                );
            } catch (lightboxError) {
                console.error(
                    "[calendario-2] No se pudo abrir ConfirmacionReserva",
                    { traceId, message: lightboxError?.message }
                );
            }
        }
    } catch (error) {
        const timeout =
            error?.code === "TIMEOUT" ||
            String(error?.message || "").toUpperCase().includes("TIMEOUT");

        reply(
            MESSAGE_TYPES.BOOK,
            createResultError(
                timeout ? "BOOKING_TIMEOUT" : "BOOKING_FAILED",
                timeout
                    ? "La reserva esta tardando demasiado. Intentalo de nuevo."
                    : "No se pudo completar la reserva."
            )
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

    const widget = $w("#html1");

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
                    handleNavigation(payload);
                    return;
                }

                if (type === MESSAGE_TYPES.AVAIL) {
                    await handleAvailability(payload, reply);
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
                    { traceId, message: error?.message }
                );
            }
        });

        if (!bridge) {
            throw new Error("No se pudo inicializar el bridge.");
        }
    } catch (error) {
        console.error(
            "[calendario-2] Error de inicializacion",
            { traceId, message: error?.message }
        );
    }
});
