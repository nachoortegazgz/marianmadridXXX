/*
MODULE: pages/calendario-2.js
VERSION: v5010.1-WIDGET-ID-FIX
BASE: v5010-SERVICE-CONTRACT-ALIGNED (adjuntado)
FIXES:
  WIDGET-ID (P0): Sustituido #htmlWidgetCalendario por #html1 (confirmado en
         Editor). Sin este cambio el bridge nunca se inicializa y la pagina
         queda muerta ("Widget HTML no disponible").
  IMPORTS (P0): URLS/UI sustituidos por PROTOCOL_URLS/PROTOCOL_UI importados
         desde public/widgetBridge (SSOT del protocolo). mmUtils reexporta como
         URLS/UI pero las paginas deben importar los nombres canonicos.
  IMPORTS (P0): wixWindow -> wixWindowFrontend. El modulo correcto para codigo
         de pagina Velo es wix-window-frontend; wix-window solo funciona en
         lightboxes o backend.
  IMPORTS (P0): Extensiones .js anadidas a imports de backend (reservas.web.js,
         citasManager.web.js). Velo requiere extension explicita en imports
         cross-module fuera de node_modules.
  SLUG (P1): _safeSlugOrId eliminado de parseUrlParams y resolveServiceFromParams.
         Ponia el slug en minusculas y colapsaba espacios, destruyendo la
         coincidencia exacta con ServiciosCatalogo.slug (incluyendo n-tilde y
         tildes). Sustituido por _safeTrim que preserva Unicode intacto.
  CONTEXT-GUARD (P1): handleAvailability, handleSelection y handleBooking
         rechazan con SERVICE_CONTEXT_NOT_READY si currentService aun no llego.
         Antes llamaban al backend con lookup vacio.
  RETRY (P1): Una rellamada para lecturas idempotentes (days/slots/select).
         Nunca en BOOK (un reintento con pairToken distinto duplicaria reservas).
  NORMALIZE-BOOKING (P1): normalizeBookingPayload traduce cliente.{nombre,email,
         telefono} al contrato plano de bookingSaga (email, firstName, lastName,
         phone, slotF1). Sin esto TODA reserva fallaba con INVALID_PAYLOAD.
  PAIRTOKEN (D3): handleBooking reenvia pairToken y resourceId del par dual.
  STAFF-OPTIONS (CAL-20): handleAvailability propaga staffOptions al widget.
  SELECT-END (D2): handleSelection envia localEndDate como 5o argumento.
  ASCII: estricto en comentarios e identificadores. Datos preservan Unicode.
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
    makeTraceId,
    _safeTrim,
    _looksLikeGuid,
    withTimeout
} from "public/mmUtils";
import { createWidgetBridge } from "public/widgetBridge";
import { processDualBooking } from "backend/citasManager.web.js";

const WIDGET_ID = "#html1";
const RETRY_DELAY_MS = 800;
const MAX_ADDONS_PER_BOOKING = 5;

let currentServiceId = "";
let currentSlug = "";
let currentService = null;
let bridge = null;

// ============================================================================
// HELPERS
// ============================================================================

function parseUrlParams() {
    const query = wixLocation.query || {};
    return {
        serviceId: _safeTrim(query.serviceId || ""),
        slug: _safeTrim(query.slug || ""),
        referral: _safeTrim(query.referral || ""),
        addOnIds: _safeTrim(query.addOnIds || "")
            .split(",")
            .map(_safeTrim)
            .filter(Boolean)
    };
}

function resolveServiceFromParams(params) {
    const serviceId = _safeTrim(params.serviceId);
    const slug = _safeTrim(params.slug);
    if (serviceId && _looksLikeGuid(serviceId)) {
        return { serviceId: serviceId, slug: slug || "" };
    }
    if (slug) {
        return { serviceId: "", slug: slug };
    }
    const path = Array.isArray(wixLocation.path) ? wixLocation.path : [];
    const lastSegment = _safeTrim(path[path.length - 1] || "");
    if (lastSegment) {
        const excluded = new Set([
            "calendario", "calendario-2", "booking-calendar",
            "reserva-online", "servicios", "inicio", "home"
        ]);
        if (!excluded.has(lastSegment.toLowerCase())) {
            console.info("[calendario-2] Servicio resuelto desde la ruta", {
                pathSegment: lastSegment
            });
            return { serviceId: "", slug: lastSegment };
        }
    }
    return null;
}

function getMessageType(message) {
    return _safeTrim(
        (message && message.type) ||
        (message && message.action) ||
        ""
    ).toUpperCase();
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
    return { status: "ERROR", data: null, error: { code: code, message: message } };
}

function getReferenceId(value) {
    if (typeof value === "string") return _safeTrim(value);
    if (value && typeof value === "object") {
        return _safeTrim(
            value.id || value.referenceId || value.value || ""
        );
    }
    return "";
}

function getActiveServiceLookup() {
    return (currentService && currentService.serviceId) ||
        (currentService && currentService.slug) ||
        currentServiceId ||
        currentSlug;
}

function filterAllowedAddonIds(service, requestedIds) {
    if (!Array.isArray(requestedIds)) return [];
    const addOnOptions = Array.isArray(service && service.addOnOptions)
        ? service.addOnOptions
        : [];
    const allowed = new Set();
    for (let i = 0; i < addOnOptions.length; i++) {
        const addon = addOnOptions[i];
        const id = getReferenceId(
            typeof addon === "string"
                ? addon
                : ((addon && (addon.addOnId || addon.id || addon.referenceId)) || "")
        );
        if (id) allowed.add(id);
    }
    return Array.from(new Set(
        requestedIds.map(_safeTrim).filter(function (id) { return id && allowed.has(id); })
    )).slice(0, MAX_ADDONS_PER_BOOKING);
}

/**
 * Una rellamada para lecturas idempotentes. Un parpadeo de red ya no deja el
 * calendario vacio de forma permanente. TIMEOUT no se reintenta.
 */
async function callWithOneRetry(factory, label) {
    const timeout = Number(PROTOCOL_UI.FRONTEND_API_TIMEOUT_MS) || 60000;
    try {
        return await withTimeout(factory(), timeout, label);
    } catch (firstError) {
        if (firstError && firstError.code === "TIMEOUT") throw firstError;
        console.warn("[calendario-2] reintentando lectura", {
            label: label,
            code: firstError && firstError.code
        });
        await new Promise(function (resolve) { setTimeout(resolve, RETRY_DELAY_MS); });
        return await withTimeout(factory(), timeout, label + ":retry");
    }
}

function normalizeService(data, params) {
    const metadata = (data.metadata && typeof data.metadata === "object")
        ? data.metadata
        : {};
    const serviceId = getReferenceId(data.serviceId);
    const slug = _safeTrim(data.slug || params.slug || currentSlug || "");
    if (!_looksLikeGuid(serviceId)) {
        throw new Error("El servicio no tiene un serviceId valido.");
    }
    const mainMedia = _safeTrim(data.mainMedia || "");
    const addOnOptions = Array.isArray(data.addOnOptions) ? data.addOnOptions : [];
    return Object.assign({}, data, {
        serviceId: serviceId,
        slug: slug,
        title: _safeTrim(data.title || metadata.title || ""),
        description: _safeTrim(data.description || metadata.description || ""),
        location: _safeTrim(data.location || metadata.location || ""),
        totalDuration: Number(data.totalDuration !== undefined ? data.totalDuration : (metadata.totalDuration || 0)),
        price: Number(data.price !== undefined ? data.price : (metadata.price || 0)),
        mainMedia: mainMedia,
        addOnOptions: addOnOptions,
        allowCombine: data.allowCombine === true || metadata.allowCombine === true,
        linkedPhases: Array.isArray(data.linkedPhases)
            ? data.linkedPhases
            : (data.linkedPhases ? [data.linkedPhases] : []),
        metadata: Object.assign({}, metadata, { mainMedia: mainMedia, addOnOptions: addOnOptions }),
        referral: params.referral,
        preselectedAddOnIds: params.addOnIds,
        timeZone: "Europe/Madrid",
        currencyCode: _safeTrim(data.currencyCode || metadata.currencyCode || "EUR").toUpperCase()
    });
}

async function loadServiceContext(params) {
    const lookup = currentServiceId || currentSlug;
    const result = await getServiceBySlugOrId(lookup);
    if (!result || result.status !== "SUCCESS" || !result.data || typeof result.data !== "object") {
        throw new Error(
            (result && result.error && result.error.message) || "No se pudo cargar el servicio."
        );
    }
    currentService = normalizeService(result.data, params);
    currentServiceId = currentService.serviceId;
    currentSlug = currentService.slug;
    return currentService;
}

/**
 * P1-1: unica traduccion entre el payload plano del widget
 * (cliente.{nombre,email,telefono}) y el contrato de bookingSaga.
 */
function normalizeBookingPayload(bookingData) {
    const cliente = (bookingData.cliente && typeof bookingData.cliente === "object")
        ? bookingData.cliente
        : {};
    const fullName = _safeTrim(bookingData.firstName || cliente.nombre || cliente.fullName || "");
    const parts = fullName.split(/\s+/).filter(Boolean);
    const firstName = parts.length > 0 ? parts.shift() : "";
    const lastName = _safeTrim(bookingData.lastName || parts.join(" ") || cliente.apellidos || "");
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

// ============================================================================
// HANDLERS
// ============================================================================

async function handleNavigation(payload) {
    const target = _safeTrim((payload && payload.target) || "").toUpperCase();
    if (target === "SERVICIOS") {
        wixLocation.to(PROTOCOL_URLS.SERVICIOS || "/reserva-online");
        return;
    }
    if (target === "PRIVACY") {
        wixLocation.to(PROTOCOL_URLS.PRIVACY_POLICY || "/politica-de-privacidad");
    }
}

async function handleAvailability(payload, reply) {
    // CONTEXT-GUARD: sin contexto, nunca llamar al backend con lookup vacio.
    if (!currentService) {
        reply(
            MESSAGE_TYPES.AVAIL,
            createResultError("SERVICE_CONTEXT_NOT_READY", "El servicio todavia se esta cargando."),
            payload
        );
        return;
    }

    const action = _safeTrim(payload.action || "").toLowerCase();
    const addOnIds = filterAllowedAddonIds(currentService, payload.addOnIds);
    const lookup = getActiveServiceLookup();
    let result;

    try {
        if (action === "days") {
            result = await callWithOneRetry(
                function () {
                    return getAvailableDays(
                        lookup,
                        payload.resourceId || null,
                        Number(payload.year),
                        Number(payload.month),
                        addOnIds
                    );
                },
                "getAvailableDays"
            );
        } else if (action === "slots") {
            const dateYmd = _safeTrim(payload.dateYmd || payload.dateYMD || "");
            result = await callWithOneRetry(
                function () {
                    return currentService.allowCombine
                        ? getCertifiedDualSlots(lookup, payload.resourceId || null, dateYmd, addOnIds)
                        : getAvailableSlots(lookup, payload.resourceId || null, dateYmd, addOnIds);
                },
                currentService.allowCombine ? "getCertifiedDualSlots" : "getAvailableSlots"
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
            (error && error.message) || "No se pudo obtener disponibilidad."
        );
    }

    // CAL-20: propagar staffOptions al widget para poblar el desplegable.
    const staffOptions = (result && result.staffOptions) ||
        (result && result.data && result.data.staffOptions) ||
        null;
    if (Array.isArray(staffOptions) && staffOptions.length > 0 && currentService) {
        currentService.staffOptions = staffOptions;
    }

    reply(
        MESSAGE_TYPES.AVAIL,
        Object.assign(
            {},
            result || createResultError("EMPTY_AVAILABILITY_RESPONSE", "No se recibio disponibilidad."),
            {
                requestSequence: payload.requestSequence || 0,
                staffOptions: staffOptions
            }
        ),
        payload
    );
}

async function handleSelection(payload, reply) {
    // CONTEXT-GUARD
    if (!currentService) {
        reply(
            MESSAGE_TYPES.SELECT,
            createResultError("SERVICE_CONTEXT_NOT_READY", "El servicio todavia se esta cargando."),
            payload
        );
        return;
    }

    const start = _safeTrim(
        payload.localStartDate || (payload.slotF1 && payload.slotF1.localStartDate) || ""
    );
    const end = _safeTrim(
        payload.localEndDate || (payload.slotF1 && payload.slotF1.localEndDate) || ""
    );

    // D2: start Y end son obligatorios. Sin end el backend no puede validar rango.
    if (!start || !end) {
        reply(
            MESSAGE_TYPES.SELECT,
            createResultError("INVALID_SLOT", "El intervalo seleccionado no es valido."),
            payload
        );
        return;
    }

    const addOnIds = filterAllowedAddonIds(currentService, payload.addOnIds);

    try {
        const result = await callWithOneRetry(
            function () {
                return resolveStaffForSlot(
                    getActiveServiceLookup(),
                    start,
                    payload.resourceId || null,
                    addOnIds,
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
            ),
            payload
        );
    } catch (error) {
        reply(
            MESSAGE_TYPES.SELECT,
            createResultError(
                "STAFF_RESOLVE_FAILED",
                (error && error.message) || "No se pudo validar el profesional."
            ),
            payload
        );
    }
}

async function handleBooking(message, reply, traceId) {
    const payload = getPayload(message);

    // CONTEXT-GUARD
    if (!currentService) {
        reply(
            MESSAGE_TYPES.BOOK,
            createResultError("SERVICE_CONTEXT_NOT_READY", "El servicio todavia se esta cargando."),
            payload
        );
        return;
    }

    const bookingData = (payload.bookingData && typeof payload.bookingData === "object")
        ? payload.bookingData
        : payload;

    if (!bookingData || typeof bookingData !== "object") {
        reply(
            MESSAGE_TYPES.BOOK,
            createResultError("INVALID_BOOKING_PAYLOAD", "Los datos de la reserva no son validos."),
            payload
        );
        return;
    }

    // Validacion dual: F2 obligatorio si el servicio es combinable.
    if (currentService.allowCombine) {
        const f2 = bookingData.slotF2;
        if (!f2 || !_safeTrim(f2.localStartDate) || !_safeTrim(f2.localEndDate)) {
            reply(
                MESSAGE_TYPES.BOOK,
                createResultError("INVALID_DUAL_SLOT", "Falta el horario de la segunda fase."),
                payload
            );
            return;
        }
    }

    const addOnIds = filterAllowedAddonIds(currentService, bookingData.addOnIds);

    // D3: pairToken y resourceId del par dual se reenvian tal cual.
    // La identidad del servicio la fija la pagina, nunca el widget.
    const requestPayload = Object.assign({}, normalizeBookingPayload(bookingData), {
        serviceId: currentService.serviceId,
        slug: currentService.slug,
        addOnIds: addOnIds,
        pairToken: _safeTrim(bookingData.pairToken || ""),
        resourceId: _safeTrim(bookingData.resourceId || ""),
        traceId: traceId
    });

    try {
        // Sin rellamada: BOOK no es reintentable desde el frontend.
        const timeout = Number(PROTOCOL_UI.FRONTEND_API_TIMEOUT_MS) || 60000;
        const result = await withTimeout(
            function () { return processDualBooking(requestPayload); },
            timeout,
            "processDualBooking"
        );
        const bookingResult = result || createResultError(
            "EMPTY_BOOKING_RESPONSE",
            "No se recibio respuesta de la reserva."
        );
        reply(MESSAGE_TYPES.BOOK, bookingResult, payload);

        const succeeded = bookingResult.status === "SUCCESS" || bookingResult.success === true;
        if (succeeded) {
            try {
                await wixWindowFrontend.openLightbox(
                    "ConfirmacionReserva",
                    bookingResult.data || bookingResult
                );
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
            ),
            payload
        );
    }
}

// ============================================================================
// BOOTSTRAP
// ============================================================================

$w.onReady(async function () {
    const traceId = makeTraceId("calendario");
    const params = parseUrlParams();
    const resolved = resolveServiceFromParams(params);

    if (!resolved) {
        console.error("[calendario-2] Identidad de servicio invalida", {
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

    // WIDGET-ID FIX: #html1 confirmado en Editor.
    let widget;
    try {
        widget = $w("#html1");
    } catch (error) {
        console.error("[calendario-2] Widget HTML no disponible", { traceId: traceId });
        return;
    }

    if (
        !widget ||
        typeof widget.postMessage !== "function" ||
        typeof widget.onMessage !== "function"
    ) {
        console.error("[calendario-2] Widget HTML no disponible", { traceId: traceId });
        return;
    }

    try {
        bridge = createWidgetBridge(widget, {
            allowOpaqueOrigin: true,
            onContextReady: function () { return loadServiceContext(params); },
            onWidgetMessage: async function (message, reply) {
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
                if (type !== MESSAGE_TYPES.READY && type !== MESSAGE_TYPES.CONTEXT) {
                    console.warn("[calendario-2] Mensaje no soportado", {
                        traceId: traceId,
                        type: type
                    });
                }
            },
            onError: function (error) {
                console.error("[calendario-2] Error de comunicacion", {
                    traceId: traceId,
                    code: error && error.code,
                    message: error && error.message
                });
            }
        });

        if (!bridge) {
            throw new Error("No se pudo inicializar el bridge.");
        }
    } catch (error) {
        console.error("[calendario-2] Error de inicializacion", {
            traceId: traceId,
            message: error && error.message
        });
    }
});
