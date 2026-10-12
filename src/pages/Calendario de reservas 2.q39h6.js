/*
MODULE: pages/calendario-2.js
VERSION: v5004-SELECT-AND-PAIRTOKEN
BASE: v5003.10-URL-RESOLUTION-FIX + D2 + D3 + P1-1 + P1-3
WIDGET ID (D1): #html1 (confirmado en Editor).
FIXES v5004:
D2-SELECT: el widget emite MM_SELECT al elegir hora. handleSelection valida
       con resolveStaffForSlot (start + end) y responde; el widget confirma
       o deselecciona. Valida el profesional ANTES de que el cliente rellene
       el formulario.
D3-PAIRTOKEN: handleBooking reenvia pairToken y resourceId del par dual
       seleccionado. Sin resourceId del par, la huella derivaria y el token
       quedaria obsoleto.
P1-1 BOOK-PAYLOAD: el widget envia cliente.{nombre,email,telefono} en plano;
       la saga exige email/firstName/lastName/phone. normalizeBookingPayload
       es el unico punto de traduccion. Sin el, TODA reserva fallaba con
       INVALID_PAYLOAD "Email is required".
P1-3 CONTEXT-GUARD: los tres handlers rechazan con SERVICE_CONTEXT_NOT_READY
       si el contexto aun no llego (antes llamaban al backend con null).
P1-RETRY: una unica rellamada para lecturas idempotentes (days/slots/select).
       Nunca en BOOK: un reintento con pairToken distinto duplicaria reservas.
       TIMEOUT no se reintenta (ya consumio toda la ventana).
P0-IMPORTS: PROTOCOL_URLS/PROTOCOL_UI desde widgetBridge (SSOT).
ASCII: estricto en codigo. Unicode preservado en datos y textos de usuario.
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
    PROTOCOL_URLS,
    PROTOCOL_UI,
    createWidgetBridge
} from "public/widgetBridge";
import {
    makeTraceId,
    _safeTrim,
    _safeSlugOrId,
    _looksLikeGuid,
    withTimeout
} from "public/mmUtils";
import { processDualBooking } from "backend/citasManager.web.js";

const WIDGET_ID = "#html1";
const RETRY_DELAY_MS = 800;
const EXCLUDED_PATHS = new Set([
    "calendario",
    "calendario-2",
    "booking-calendar",
    "reserva-online",
    "servicios",
    "inicio",
    "home"
]);

let currentServiceId = null;
let currentSlug = null;
let currentService = null;
let bridge = null;

function normalizeIdList(value) {
    const values = Array.isArray(value) ? value : _safeTrim(value || "").split(",");
    return values
        .map(function (id) { return _safeTrim(id); })
        .filter(Boolean);
}

function parseUrlParams() {
    const query = wixLocation.query || {};
    return {
        serviceId: _safeTrim(query.serviceId || ""),
        slug: _safeTrim(query.slug || ""),
        referral: _safeTrim(query.referral || ""),
        addOnIds: normalizeIdList(query.addOnIds)
    };
}

/**
 * Prioridad: query.serviceId (GUID, sin transformar) > query.slug > ultimo
 * segmento de la ruta. El fallback de ruta cubre la navegacion interna de Wix
 * que no preserva query params.
 */
function resolveServiceFromParams(params) {
    if (params.serviceId && _looksLikeGuid(params.serviceId)) {
        return { serviceId: params.serviceId, slug: params.slug || null };
    }
    if (params.slug) {
        return { serviceId: null, slug: params.slug };
    }
    const path = Array.isArray(wixLocation.path) ? wixLocation.path : [];
    const lastSegment = _safeTrim(path[path.length - 1] || "");
    if (lastSegment && !EXCLUDED_PATHS.has(lastSegment.toLowerCase())) {
        console.info("[calendario-2] Servicio resuelto desde la ruta", {
            pathSegment: lastSegment
        });
        return { serviceId: null, slug: lastSegment };
    }
    return null;
}

function getMessageType(message) {
    return String((message && (message.type || message.action)) || "").trim().toUpperCase();
}

function getPayload(message) {
    if (message && message.payload && typeof message.payload === "object" && !Array.isArray(message.payload)) {
        return message.payload;
    }
    return {};
}

function createResultError(code, message) {
    return { status: "ERROR", data: null, error: { code: code, message: message } };
}

function getTimeoutMs() {
    return Number(PROTOCOL_UI.FRONTEND_API_TIMEOUT_MS) || 60000;
}

function isValidYmd(value) {
    const clean = _safeTrim(value);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(clean)) return false;
    const parts = clean.split("-").map(Number);
    const date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
    return date.getUTCFullYear() === parts[0] &&
        date.getUTCMonth() === parts[1] - 1 &&
        date.getUTCDate() === parts[2];
}

/**
 * P1-RETRY: una rellamada para lecturas idempotentes. Un parpadeo de red ya no
 * deja el calendario vacio de forma permanente. TIMEOUT no se reintenta.
 */
async function callWithOneRetry(factory, label) {
    try {
        return await withTimeout(factory(), getTimeoutMs(), label);
    } catch (firstError) {
        if (firstError && firstError.code === "TIMEOUT") throw firstError;
        console.warn("[calendario-2] reintentando lectura", {
            label: label,
            code: firstError && firstError.code
        });
        await new Promise(function (resolve) { setTimeout(resolve, RETRY_DELAY_MS); });
        return await withTimeout(factory(), getTimeoutMs(), label + ":retry");
    }
}

async function loadServiceContext(params) {
    const lookup = currentServiceId || currentSlug;
    const result = await getServiceBySlugOrId(lookup);
    if (!result || result.status !== "SUCCESS" || !result.data) {
        throw new Error(
            (result && result.error && result.error.message) || "No se pudo cargar el servicio."
        );
    }
    currentService = result.data;
    return Object.assign({}, result.data, {
        serviceId: result.data.serviceId || currentServiceId,
        slug: result.data.slug || currentSlug,
        referral: params.referral,
        addOnIds: params.addOnIds,
        timeZone: "Europe/Madrid",
        currency: result.data.currency || "EUR"
    });
}

function handleNavigation(payload) {
    const target = _safeTrim((payload && payload.target) || "").toUpperCase();
    if (target === "SERVICIOS") {
        wixLocation.to(PROTOCOL_URLS.SERVICIOS);
        return true;
    }
    if (target === "PRIVACY") {
        wixLocation.to(PROTOCOL_URLS.PRIVACY_POLICY);
        return true;
    }
    return false;
}

async function handleAvailability(payload, reply) {
    // P1-3: sin contexto, nunca llamar al backend con lookup nulo.
    if (!currentService) {
        reply(MESSAGE_TYPES.AVAIL, createResultError(
            "SERVICE_CONTEXT_NOT_READY",
            "El servicio aun se esta cargando."
        ));
        return;
    }

    const action = _safeTrim(payload.action || "").toLowerCase();
    const addOnIds = normalizeIdList(payload.addOnIds);
    const lookup = currentServiceId || currentSlug;
    let result;

    try {
        if (action === "days") {
            const year = Number(payload.year);
            const month = Number(payload.month);
            if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
                result = createResultError("INVALID_DATE_RANGE", "El mes o el ano solicitado no es valido.");
            } else {
                result = await callWithOneRetry(
                    function () {
                        return getAvailableDays(lookup, payload.resourceId || null, year, month, addOnIds);
                    },
                    "getAvailableDays"
                );
            }
        } else if (action === "slots") {
            const dateYMD = _safeTrim(payload.dateYMD || payload.dateYmd || "");
            if (!isValidYmd(dateYMD)) {
                result = createResultError("INVALID_DATE", "La fecha solicitada no es valida.");
            } else {
                const getSlots = currentService.allowCombine ? getCertifiedDualSlots : getAvailableSlots;
                result = await callWithOneRetry(
                    function () {
                        return getSlots(lookup, payload.resourceId || null, dateYMD, addOnIds);
                    },
                    "getAvailableSlots"
                );
            }
        } else {
            result = createResultError("INVALID_AVAILABILITY_REQUEST", "Solicitud de disponibilidad no valida.");
        }
    } catch (error) {
        result = createResultError(
            "AVAILABILITY_FAILED",
            (error && error.message) || "No se pudo obtener disponibilidad."
        );
    }

    // D3/STAFF: staffOptions puede venir dentro de data (single) o en el
    // sobre de la respuesta (dual). Se propaga siempre al widget.
    const staffOptions = (result && result.staffOptions) ||
        (result && result.data && result.data.staffOptions) ||
        null;

    reply(
        MESSAGE_TYPES.AVAIL,
        Object.assign(
            {},
            result || createResultError("EMPTY_AVAILABILITY_RESPONSE", "No se recibio disponibilidad."),
            {
                action: action,
                requestSequence: payload.requestSequence || 0,
                staffOptions: staffOptions
            }
        )
    );
}

/**
 * D2-SELECT: valida el profesional y el slot ANTES de que el cliente rellene
 * el formulario. start y end son obligatorios: sin end el backend no puede
 * validar rango ni duracion.
 */
async function handleSelection(payload, reply) {
    if (!currentService) {
        reply(MESSAGE_TYPES.SELECT, createResultError(
            "SERVICE_CONTEXT_NOT_READY",
            "El servicio aun se esta cargando."
        ));
        return;
    }

    const start = _safeTrim(payload.localStartDate || "");
    const end = _safeTrim(payload.localEndDate || "");
    if (!start || !end) {
        reply(MESSAGE_TYPES.SELECT, createResultError(
            "INVALID_SLOT",
            "El horario seleccionado no es valido."
        ));
        return;
    }

    try {
        const result = await callWithOneRetry(
            function () {
                return resolveStaffForSlot(
                    currentServiceId || currentSlug,
                    start,
                    payload.resourceId || null,
                    normalizeIdList(payload.addOnIds),
                    end
                );
            },
            "resolveStaffForSlot"
        );
        reply(
            MESSAGE_TYPES.SELECT,
            Object.assign(
                {},
                result || createResultError("STAFF_RESOLVE_FAILED", "No se pudo validar el profesional."),
                { requestSequence: payload.requestSequence || 0 }
            )
        );
    } catch (error) {
        reply(MESSAGE_TYPES.SELECT, createResultError(
            "STAFF_RESOLVE_FAILED",
            (error && error.message) || "No se pudo validar el profesional."
        ));
    }
}

/**
 * P1-1: unica traduccion entre el payload plano del widget
 * (cliente.{nombre,email,telefono}, localStartDate, localEndDate) y el
 * contrato de bookingSaga (email, firstName, lastName, phone, slotF1).
 * "Nombre completo" se parte en firstName/lastName.
 */
function normalizeBookingPayload(bookingData) {
    const cliente = (bookingData.cliente && typeof bookingData.cliente === "object")
        ? bookingData.cliente
        : {};
    const fullName = _safeTrim(
        bookingData.firstName || cliente.nombre || cliente.fullName || ""
    );
    const parts = fullName.split(/\s+/).filter(Boolean);
    const firstName = parts.length > 0 ? parts.shift() : "";
    const lastName = _safeTrim(
        bookingData.lastName || parts.join(" ") || cliente.apellidos || ""
    );
    const email = _safeTrim(bookingData.email || cliente.email || "");
    const phone = _safeTrim(bookingData.phone || cliente.telefono || cliente.phone || "");

    const normalized = Object.assign({}, bookingData);
    normalized.firstName = firstName;
    normalized.lastName = lastName;
    normalized.email = email;
    normalized.phone = phone;
    normalized.contactDetails = {
        firstName: firstName,
        lastName: lastName,
        email: email,
        phone: phone
    };
    if (!normalized.slotF1 && bookingData.localStartDate) {
        normalized.slotF1 = {
            localStartDate: _safeTrim(bookingData.localStartDate),
            localEndDate: _safeTrim(bookingData.localEndDate)
        };
    }
    return normalized;
}

async function handleBooking(message, reply, traceId) {
    if (!currentService) {
        reply(MESSAGE_TYPES.BOOK, createResultError(
            "SERVICE_CONTEXT_NOT_READY",
            "El servicio aun se esta cargando."
        ));
        return;
    }

    const payload = getPayload(message);
    const nestedBooking = payload.bookingData;
    const bookingData = (nestedBooking && typeof nestedBooking === "object" && !Array.isArray(nestedBooking))
        ? nestedBooking
        : payload;

    if (Object.keys(bookingData).length === 0) {
        reply(MESSAGE_TYPES.BOOK, createResultError(
            "INVALID_BOOKING_PAYLOAD",
            "Faltan los datos de la reserva."
        ));
        return;
    }

    // D3: pairToken y resourceId del par dual se reenvian tal cual. La identidad
    // del servicio la fija la pagina, nunca el widget.
    const requestPayload = Object.assign({}, normalizeBookingPayload(bookingData), {
        serviceId: currentService.serviceId || currentServiceId,
        slug: currentService.slug || currentSlug,
        pairToken: _safeTrim(bookingData.pairToken || ""),
        resourceId: _safeTrim(bookingData.resourceId || ""),
        traceId: traceId
    });

    try {
        // Sin rellamada: BOOK no es reintentable desde el frontend.
        const result = await withTimeout(
            processDualBooking(requestPayload),
            getTimeoutMs(),
            "processDualBooking"
        );
        const bookingResult = result || createResultError(
            "EMPTY_BOOKING_RESPONSE",
            "No se recibio respuesta de la reserva."
        );
        reply(MESSAGE_TYPES.BOOK, bookingResult);

        if (bookingResult.status === "SUCCESS") {
            try {
                await wixWindowFrontend.openLightbox("ConfirmacionReserva", {
                    booking: bookingResult.data || null,
                    service: currentService,
                    traceId: traceId
                });
            } catch (lightboxError) {
                console.error("[calendario-2] No se pudo abrir ConfirmacionReserva", {
                    traceId: traceId,
                    message: lightboxError && lightboxError.message
                });
            }
        }
    } catch (error) {
        const isTimeout = (error && error.code === "TIMEOUT") ||
            String((error && error.message) || "").toUpperCase().indexOf("TIMEOUT") >= 0;
        reply(
            MESSAGE_TYPES.BOOK,
            createResultError(
                isTimeout ? "BOOKING_TIMEOUT" : "BOOKING_FAILED",
                isTimeout
                    ? "La reserva esta tardando demasiado. Comprueba su estado antes de volver a intentarlo."
                    : "No se pudo completar la reserva."
            )
        );
    }
}

$w.onReady(async function () {
    const traceId = makeTraceId("calendario");
    const params = parseUrlParams();
    const resolved = resolveServiceFromParams(params);

    if (!resolved) {
        console.error("[calendario-2] Servicio no valido", {
            traceId: traceId,
            hasServiceId: Boolean(params.serviceId),
            hasSlug: Boolean(params.slug),
            currentPath: wixLocation.path,
            currentQuery: wixLocation.query
        });
        return;
    }

    currentServiceId = resolved.serviceId;
    currentSlug = resolved.slug;

    const widget = $w(WIDGET_ID);
    if (!widget || typeof widget.postMessage !== "function" || typeof widget.onMessage !== "function") {
        console.error("[calendario-2] Widget HTML no disponible", {
            traceId: traceId,
            widgetId: WIDGET_ID
        });
        return;
    }

    try {
        bridge = createWidgetBridge(widget, {
            allowOpaqueOrigin: true,
            onContextReady: async function () { return loadServiceContext(params); },
            onWidgetMessage: async function (message, reply) {
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
                if (type !== MESSAGE_TYPES.READY && type !== MESSAGE_TYPES.CONTEXT) {
                    console.warn("[calendario-2] Mensaje no soportado", { traceId: traceId, type: type });
                }
            },
            onError: function (error, detail) {
                console.error("[calendario-2] Error de comunicacion", {
                    traceId: traceId,
                    code: error && error.code,
                    message: error && error.message,
                    causeMessage: error && error.cause && error.cause.message,
                    detail: detail
                });
            }
        });
        if (!bridge) throw new Error("No se pudo inicializar el puente.");
    } catch (error) {
        console.error("[calendario-2] Error de inicializacion", {
            traceId: traceId,
            code: error && error.code,
            message: error && error.message
        });
    }
});
