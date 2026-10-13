/*
MODULE: pages/calendario-2.js
VERSION: v5004.1-CANONICAL-ALIGNMENT
BASE: v5004-SELECT-AND-PAIRTOKEN + alineacion de nombres canonicos
WIDGET ID (D1): #html1 (confirmado en Editor). La variante
       "Calendario de reservas 2.js" v5010-SERVICE-CONTRACT-ALIGNED que usa
       #htmlWidgetCalendario y importa URLS/UI desde mmUtils queda DESCARTADA.
       Solo puede existir un fichero de pagina: este.

FIXES v5004.1:
  CAL-18 (P0) _safeSlugOrId eliminado de esta pagina. Ponia el slug en
         minusculas y colapsaba espacios, destruyendo la coincidencia exacta
         con ServiciosCatalogo.slug y, de paso, cualquier n-tilde o tilde en
         mayuscula. Sustituido por _safeTrim en parseUrlParams y en el
         fallback de ruta. El backend ya busca por $eq exacto.
  CAL-19 (P0) Widget ID unificado a #html1. El bridge nunca se inicializaba
         cuando el componente real del Editor no era #htmlWidgetCalendario.
  CAL-20 (P1) availableStaff pasa a compatibilidad explicita y deprecada.
         El campo fue eliminado de ServiciosCatalogo: el personal se deriva
         de los slots (STAFF-FROM-SLOTS). loadServiceContext expone
         staffOptions como contrato principal y solo refleja availableStaff
         si el backend lo envia, marcandolo deprecated en log.
  CAL-21 (P2) serviceId canonico. Se acepta servicioID unicamente como
         compatibilidad de lectura del DTO, nunca como campo principal.

FIXES HEREDADOS v5004:
  D2-SELECT: el widget emite MM_SELECT al elegir hora; handleSelection valida
         con resolveStaffForSlot(start, resourceId, addOnIds, end).
  D3-PAIRTOKEN: handleBooking reenvia pairToken y resourceId del par dual.
  P1-1 BOOK-PAYLOAD: normalizeBookingPayload traduce cliente.{nombre,email,
         telefono} al contrato plano de bookingSaga. Sin esto TODA reserva
         fallaba con INVALID_PAYLOAD "Email is required".
  P1-3 CONTEXT-GUARD: los tres handlers rechazan con SERVICE_CONTEXT_NOT_READY
         si el contexto aun no llego.
  P1-RETRY: una rellamada para lecturas idempotentes (days/slots/select).
         Nunca en BOOK: un reintento con pairToken distinto duplica reservas.
  P0-IMPORTS: PROTOCOL_URLS/PROTOCOL_UI desde public/widgetBridge (SSOT).
         mmUtils los reexporta como URLS/UI, no con el nombre canonico.
=============================================================================
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
    _looksLikeGuid,
    withTimeout
} from "public/mmUtils";
import { processDualBooking } from "backend/citasManager.web.js";

// CAL-19: unico ID de widget canonico para esta pagina.
const WIDGET_ID = "#html1";
const RETRY_DELAY_MS = 800;
const MAX_ADDONS_PER_BOOKING = 5;

// Rutas genericas que NUNCA son un slug de servicio.
const EXCLUDED_PATHS = new Set([
    "calendario",
    "calendario-2",
    "booking-calendar",
    "reserva-online",
    "servicios",
    "servicio",
    "servicio-2",
    "inicio",
    "home"
]);

let currentServiceId = "";
let currentSlug = "";
let currentService = null;
let bridge = null;

// ============================================================================
// HELPERS
// ============================================================================

function normalizeIdList(value) {
    const values = Array.isArray(value)
        ? value
        : _safeTrim(value || "").split(",");
    return values
        .map(function (id) { return _safeTrim(id); })
        .filter(Boolean);
}

/**
 * CAL-18: solo trim. Sin _safeSlugOrId (que lowercases y colapsa espacios).
 * El slug viaja codificado por URLSearchParams y Wix lo decodifica intacto;
 * el backend lo busca con $eq exacto.
 */
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
        return { serviceId: params.serviceId, slug: params.slug || "" };
    }
    if (params.slug) {
        return { serviceId: "", slug: params.slug };
    }
    const path = Array.isArray(wixLocation.path) ? wixLocation.path : [];
    const lastSegment = _safeTrim(path[path.length - 1] || "");
    if (lastSegment && !EXCLUDED_PATHS.has(lastSegment.toLowerCase())) {
        console.info("[calendario-2] Servicio resuelto desde la ruta", {
            pathSegment: lastSegment
        });
        return { serviceId: "", slug: lastSegment };
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

/** Identidad canonica del servicio. CAL-21: servicioID solo como compat. */
function getServiceIdentity(data) {
    if (!data || typeof data !== "object") return "";
    const canonical = _safeTrim(data.serviceId);
    if (canonical) return canonical;
    // COMPAT EXPLICITA Y DEPRECADA: no es campo principal del contrato.
    return _safeTrim(data.servicioID);
}

/**
 * CAL-20: staffOptions es el contrato principal. availableStaff se conserva
 * solo como compatibilidad de lectura y se traza para poder retirarlo.
 */
function resolveStaffContext(data) {
    const options = Array.isArray(data && data.staffOptions) ? data.staffOptions : [];
    if (options.length > 0) return options;

    const legacy = Array.isArray(data && data.availableStaff) ? data.availableStaff : [];
    if (legacy.length > 0) {
        console.warn("[calendario-2] availableStaff es compatibilidad deprecada; el backend debe enviar staffOptions");
        return legacy
            .map(function (id) {
                const rid = _safeTrim(typeof id === "string" ? id : (id && (id.resourceId || id.id)));
                return rid ? { resourceId: rid, id: rid, value: rid, name: rid, label: rid } : null;
            })
            .filter(Boolean);
    }
    return [];
}

function filterAllowedAddonIds(service, requestedIds) {
    if (!Array.isArray(requestedIds)) return [];
    const addOnOptions = Array.isArray(service && service.addOnOptions) ? service.addOnOptions : [];
    const allowed = new Set();
    for (const addon of addOnOptions) {
        const id = _safeTrim(
            typeof addon === "string"
                ? addon
                : ((addon && (addon.addOnId || addon.nativeId || addon.id)) || "")
        );
        if (id) allowed.add(id);
    }
    return Array.from(new Set(
        requestedIds.map(function (id) { return _safeTrim(id); }).filter(function (id) { return id && allowed.has(id); })
    )).slice(0, MAX_ADDONS_PER_BOOKING);
}

function getActiveServiceLookup() {
    return (currentService && currentService.serviceId) || currentServiceId || currentSlug;
}

/**
 * P1-RETRY: una rellamada para lecturas idempotentes. Un parpadeo de red ya no
 * deja el calendario vacio de forma permanente. TIMEOUT no se reintenta: ya
 * consumo toda la ventana.
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

// ============================================================================
// CONTEXTO
// ============================================================================

async function loadServiceContext(params) {
    const lookup = currentServiceId || currentSlug;
    const result = await getServiceBySlugOrId(lookup);
    if (!result || result.status !== "SUCCESS" || !result.data) {
        throw new Error(
            (result && result.error && result.error.message) || "No se pudo cargar el servicio."
        );
    }

    const data = result.data;
    const serviceId = getServiceIdentity(data);
    if (!_looksLikeGuid(serviceId)) {
        throw new Error("El servicio no tiene un identificador valido.");
    }

    currentService = Object.assign({}, data, {
        serviceId: serviceId,
        slug: _safeTrim(data.slug || currentSlug || ""),
        // CAL-20: contrato principal de personal. Se puebla de verdad con los
        // slots; aqui arranca vacio o con lo que el backend haya derivado.
        staffOptions: resolveStaffContext(data),
        referral: params.referral,
        addOnIds: params.addOnIds,
        timeZone: "Europe/Madrid",
        currency: _safeTrim(data.currency || "EUR").toUpperCase()
    });
    currentServiceId = currentService.serviceId;
    currentSlug = currentService.slug;

    return currentService;
}

// ============================================================================
// HANDLERS
// ============================================================================

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
    // P1-3: sin contexto, nunca llamar al backend con lookup vacio.
    if (!currentService) {
        reply(
            MESSAGE_TYPES.AVAIL,
            createResultError("SERVICE_CONTEXT_NOT_READY", "El servicio aun se esta cargando."),
            payload
        );
        return;
    }

    const action = _safeTrim(payload.action || "").toLowerCase();
    const addOnIds = filterAllowedAddonIds(currentService, normalizeIdList(payload.addOnIds));
    const lookup = getActiveServiceLookup();
    let result;

    try {
        if (action === "days") {
            const year = Number(payload.year);
            const month = Number(payload.month);
            if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
                result = createResultError("INVALID_DATE_RANGE", "El mes o el año solicitado no es válido.");
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
                result = createResultError("INVALID_DATE", "La fecha solicitada no es válida.");
            } else {
                const isDual = currentService.allowCombine === true || currentService.permitirCombinar === true;
                const getSlots = isDual ? getCertifiedDualSlots : getAvailableSlots;
                result = await callWithOneRetry(
                    function () {
                        return getSlots(lookup, payload.resourceId || null, dateYMD, addOnIds);
                    },
                    isDual ? "getCertifiedDualSlots" : "getAvailableSlots"
                );
            }
        } else {
            result = createResultError("INVALID_AVAILABILITY_REQUEST", "Solicitud de disponibilidad no válida.");
        }
    } catch (error) {
        result = createResultError(
            "AVAILABILITY_FAILED",
            (error && error.message) || "No se pudo obtener disponibilidad."
        );
    }

    // CAL-20: staffOptions puede venir dentro de data (single) o en el sobre de
    // la respuesta (dual). Se propaga siempre al widget para que pueble el
    // desplegable con personal realmente disponible.
    const staffOptions = (result && result.staffOptions) ||
        (result && result.data && result.data.staffOptions) ||
        null;
    if (Array.isArray(staffOptions) && staffOptions.length > 0) {
        currentService.staffOptions = staffOptions;
    }

    reply(
        MESSAGE_TYPES.AVAIL,
        Object.assign(
            {},
            result || createResultError("EMPTY_AVAILABILITY_RESPONSE", "No se recibió disponibilidad."),
            {
                action: action,
                requestSequence: payload.requestSequence || 0,
                staffOptions: staffOptions
            }
        ),
        payload
    );
}

/**
 * D2-SELECT: valida profesional y slot ANTES de que el cliente rellene el
 * formulario. start y end son obligatorios: sin end el backend no puede
 * validar rango ni duracion.
 */
async function handleSelection(payload, reply) {
    if (!currentService) {
        reply(
            MESSAGE_TYPES.SELECT,
            createResultError("SERVICE_CONTEXT_NOT_READY", "El servicio aun se esta cargando."),
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

    if (!start || !end) {
        reply(
            MESSAGE_TYPES.SELECT,
            createResultError("INVALID_SLOT", "El horario seleccionado no es válido."),
            payload
        );
        return;
    }

    const addOnIds = filterAllowedAddonIds(currentService, normalizeIdList(payload.addOnIds));

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

/**
 * P1-1: unica traduccion entre el payload plano del widget
 * (cliente.{nombre,email,telefono}, localStartDate, localEndDate) y el contrato
 * de bookingSaga (email, firstName, lastName, phone, slotF1).
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

async function handleBooking(message, reply, traceId) {
    const payload = getPayload(message);

    if (!currentService) {
        reply(
            MESSAGE_TYPES.BOOK,
            createResultError("SERVICE_CONTEXT_NOT_READY", "El servicio aun se esta cargando."),
            payload
        );
        return;
    }

    const nestedBooking = payload.bookingData;
    const bookingData = (nestedBooking && typeof nestedBooking === "object" && !Array.isArray(nestedBooking))
        ? nestedBooking
        : payload;

    if (!bookingData || Object.keys(bookingData).length === 0) {
        reply(
            MESSAGE_TYPES.BOOK,
            createResultError("INVALID_BOOKING_PAYLOAD", "Faltan los datos de la reserva."),
            payload
        );
        return;
    }

    const isDual = currentService.allowCombine === true || currentService.permitirCombinar === true;
    if (isDual) {
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

    const addOnIds = filterAllowedAddonIds(currentService, normalizeIdList(bookingData.addOnIds));

    // D3: pairToken y resourceId del par dual se reenvian tal cual. La identidad
    // del servicio la fija la pagina, nunca el widget.
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
        const result = await withTimeout(
            processDualBooking(requestPayload),
            getTimeoutMs(),
            "processDualBooking"
        );
        const bookingResult = result || createResultError(
            "EMPTY_BOOKING_RESPONSE",
            "No se recibió respuesta de la reserva."
        );
        reply(MESSAGE_TYPES.BOOK, bookingResult, payload);

        const succeeded = bookingResult.status === "SUCCESS" || bookingResult.success === true;
        if (succeeded) {
            try {
                await wixWindowFrontend.openLightbox(
                    "ConfirmacionReserva",
                    {
                        booking: bookingResult.data || bookingResult,
                        service: currentService,
                        traceId: traceId
                    }
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
                    ? "La reserva está tardando demasiado. Comprueba su estado antes de volver a intentarlo."
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
            widgetId: WIDGET_ID,
            postMessage: typeof (widget && widget.postMessage),
            onMessage: typeof (widget && widget.onMessage)
        });
        return;
    }

    try {
        bridge = createWidgetBridge(widget, {
            // Wix puede reportar origen opaco para este componente HTML propio.
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
                    causeCode: error && error.cause && error.cause.code,
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
