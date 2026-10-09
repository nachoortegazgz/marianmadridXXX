/**
 * MODULE: pages/calendario-2.js
 * VERSION: v5003.5-FUNCTIONAL
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

function normalizeIdList(value) {
    if (Array.isArray(value)) {
        return value
            .map((id) => _safeTrim(id))
            .filter(Boolean);
    }

    return _safeTrim(value || "")
        .split(",")
        .map((id) => _safeTrim(id))
        .filter(Boolean);
}

function parseUrlParams() {
    const query = wixLocation.query || {};

    return {
        serviceId: _safeTrim(query.serviceId || ""),
        slug: _safeSlugOrId(query.slug || ""),
        referral: _safeTrim(query.referral || ""),
        addOnIds: normalizeIdList(query.addOnIds)
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

function getTimeoutMs() {
    return Number(UI && UI.FRONTEND_API_TIMEOUT_MS) || 60000;
}

async function loadServiceContext(params) {
    const lookup = currentServiceId || currentSlug;
    const result = await getServiceBySlugOrId(lookup);

    if (!result || result.status !== "SUCCESS" || !result.data) {
        throw new Error(
            result && result.error && result.error.message
                ? result.error.message
                : "No se pudo cargar el servicio."
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

function handleNavigation(payload) {
    const target = _safeTrim(payload && payload.target || "")
        .toUpperCase();

    if (target === "SERVICIOS") {
        wixLocation.to(URLS && URLS.SERVICIOS || "/reserva-online");
        return true;
    }

    if (target === "PRIVACY") {
        wixLocation.to(
            URLS && URLS.PRIVACY_POLICY || "/politica-de-privacidad"
        );
        return true;
    }

    return false;
}

async function handleAvailability(payload, reply) {
    const action = _safeTrim(payload.action || "").toLowerCase();
    const addOnIds = normalizeIdList(payload.addOnIds);
    let result;

    try {
        if (action === "days") {
            const year = Number(payload.year);
            const month = Number(payload.month);

            if (
                !Number.isInteger(year) ||
                !Number.isInteger(month) ||
                month < 1 ||
                month > 12
            ) {
                result = createResultError(
                    "INVALID_DATE_RANGE",
                    "El mes o el año solicitado no es válido."
                );
            } else {
                result = await withTimeout(
                    getAvailableDays(
                        currentServiceId || currentSlug,
                        payload.resourceId || null,
                        year,
                        month,
                        addOnIds
                    ),
                    getTimeoutMs(),
                    "getAvailableDays"
                );
            }
        } else if (action === "slots") {
            const dateYMD = _safeTrim(
                payload.dateYMD || payload.dateYmd || ""
            );

            if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(dateYMD)) {
                result = createResultError(
                    "INVALID_DATE",
                    "La fecha solicitada no es válida."
                );
            } else {
                const getSlots = currentService && currentService.allowCombine
                    ? getCertifiedDualSlots
                    : getAvailableSlots;

                result = await withTimeout(
                    getSlots(
                        currentServiceId || currentSlug,
                        payload.resourceId || null,
                        dateYMD,
                        addOnIds
                    ),
                    getTimeoutMs(),
                    "getAvailableSlots"
                );
            }
        } else {
            result = createResultError(
                "INVALID_AVAILABILITY_REQUEST",
                "Solicitud de disponibilidad no válida."
            );
        }
    } catch (error) {
        result = createResultError(
            "AVAILABILITY_FAILED",
            error && error.message
                ? error.message
                : "No se pudo obtener disponibilidad."
        );
    }

    reply(
        MESSAGE_TYPES.AVAIL,
        {
            ...(result || createResultError(
                "EMPTY_AVAILABILITY_RESPONSE",
                "No se recibió disponibilidad."
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
                "El horario seleccionado no es válido."
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
                normalizeIdList(payload.addOnIds),
                null
            ),
            getTimeoutMs(),
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
                error && error.message
                    ? error.message
                    : "No se pudo validar el profesional."
            ),
            payload
        );
    }
}

async function handleBooking(message, reply, traceId) {
    const payload = getPayload(message);
    const nestedBooking = payload.bookingData;
    const bookingData =
        nestedBooking &&
        typeof nestedBooking === "object" &&
        !Array.isArray(nestedBooking)
            ? nestedBooking
            : payload;

    if (Object.keys(bookingData).length === 0) {
        reply(
            MESSAGE_TYPES.BOOK,
            createResultError(
                "INVALID_BOOKING_PAYLOAD",
                "Faltan los datos de la reserva."
            ),
            message
        );
        return;
    }

    const requestPayload = {
        ...bookingData,
        serviceId: bookingData.serviceId || currentServiceId,
        slug: bookingData.slug || currentSlug,
        traceId
    };

    try {
        const result = await withTimeout(
            processDualBooking(requestPayload),
            getTimeoutMs(),
            "processDualBooking"
        );

        const bookingResult = result || createResultError(
            "EMPTY_BOOKING_RESPONSE",
            "No se recibió respuesta de la reserva."
        );

        reply(MESSAGE_TYPES.BOOK, bookingResult, message);

        if (bookingResult.status === "SUCCESS") {
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
                        message: lightboxError && lightboxError.message
                    }
                );
            }
        }
    } catch (error) {
        const timeout =
            error && error.code === "TIMEOUT" ||
            String(error && error.message || "")
                .toUpperCase()
                .includes("TIMEOUT");

        reply(
            MESSAGE_TYPES.BOOK,
            createResultError(
                timeout ? "BOOKING_TIMEOUT" : "BOOKING_FAILED",
                timeout
                    ? "La reserva está tardando demasiado. Comprueba su estado antes de volver a intentarlo."
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
        console.error("[calendario-2] Servicio no válido", { traceId });
        return;
    }

    currentServiceId = resolved.serviceId;
    currentSlug = resolved.slug;

    // ID confirmado por el usuario y el registro de Wix.
    const widget = $w("#html1");

    if (
        !widget ||
        typeof widget.postMessage !== "function" ||
        typeof widget.onMessage !== "function"
    ) {
        console.error("[calendario-2] Widget HTML no disponible", {
            traceId,
            widgetId: "#html1",
            postMessage: typeof (widget && widget.postMessage),
            onMessage: typeof (widget && widget.onMessage)
        });
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
                    "[calendario-2] Error de comunicación",
                    {
                        traceId,
                        message: error && error.message
                    }
                );
            }
        });

        if (!bridge) {
            throw new Error("No se pudo inicializar el puente.");
        }
    } catch (error) {
        console.error(
            "[calendario-2] Error de inicialización",
            {
                traceId,
                message: error && error.message
            }
        );
    }
});
