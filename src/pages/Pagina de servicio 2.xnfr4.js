/*
FILE: pages/servicio-2.js
VERSION: v5013.5-PROTOCOL-IMPORT-FIX
BASE: v5013.4-SLUG-OPTIONAL-FIX
WIDGET ID (D1): #htmlWidgetCustomService (confirmado en Editor).
FIXES v5013.5:
  - P0-5: PROTOCOL_URLS se importa desde public/widgetBridge (SSOT del
    protocolo). mmUtils lo reexporta como URLS, no como PROTOCOL_URLS: el
    import anterior lanzaba SyntaxError y la pagina no cargaba.
  - P1-4: slug opcional. El servicio se identifica por serviceId. Sin throw
    por slug vacio (evita SERVICE_NOT_FOUND en servicios sin slug).
  - availableStaff ya no se lee del CMS (campo eliminado); se propaga el
    array derivado que devuelve reservas.web desde los slots.
  - Sintaxis limpia: operadores, literales sin espacio final, catch con
    parametro, sin identificadores rotos.
ASCII: estricto en comentarios e identificadores. Unicode preservado en datos.
*/
import wixLocation from "wix-location-frontend";
import { getServiceBySlugOrId } from "backend/reservas.web.js";
import {
    MESSAGE_TYPES,
    PROTOCOL_URLS,
    createWidgetBridge
} from "public/widgetBridge";
import {
    makeTraceId,
    _safeTrim,
    _safeSlugOrId,
    _looksLikeGuid
} from "public/mmUtils";

const EXCLUDED_PATHS = new Set([
    "servicios",
    "service",
    "servicio",
    "servicio-2",
    "reserva-online"
]);

const MAX_ADDONS_PER_BOOKING = 5;
const WIDGET_ID = "#htmlWidgetCustomService";

let bridge = null;
let resolvedService = null;

function text(value, fallback) {
    return _safeTrim(value) || (fallback === undefined ? "" : fallback);
}

function getReferenceId(value) {
    if (typeof value === "string") return text(value);
    if (!value || typeof value !== "object") return "";
    return text(
        value.serviceId ||
        value.addOnId ||
        value.nativeId ||
        value._id ||
        value.id ||
        value.value
    );
}

function getMessageType(message) {
    if (!message || typeof message !== "object") return "";
    return text(message.type).toUpperCase();
}

function getPayload(message) {
    const payload = message && message.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
    return payload;
}

function getServiceId(service) {
    return getReferenceId(service && service.serviceId);
}

/**
 * UNICODE-SLUG: solo trim. Sin _safeSlugOrId (minúsculas + guiones) para no
 * alterar el slug canonico que ya viene normalizado desde el CMS.
 */
function getServiceSlug(service) {
    return _safeTrim((service && service.slug) || "");
}

function getLinkedPhaseId(value) {
    return getReferenceId(Array.isArray(value) ? value[0] : value);
}

function toFiniteNumber(value, fallback) {
    const fb = fallback === undefined ? 0 : fallback;
    if (value === null || value === undefined || value === "") return fb;
    const number = Number(value);
    return Number.isFinite(number) ? number : fb;
}

function normalizeService(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new Error("El servicio recibido no es valido.");
    }
    const metadata = (data.metadata && typeof data.metadata === "object") ? data.metadata : {};
    const serviceId = getServiceId(data);
    const slug = getServiceSlug(data);

    // P1-4: unico requisito tecnico es el GUID. slug es dato de presentacion.
    if (!_looksLikeGuid(serviceId)) {
        throw new Error("El servicio no tiene un identificador valido.");
    }
    if (data.clientHidden === true) {
        throw new Error("El servicio no esta disponible para reserva.");
    }

    return {
        serviceId: serviceId,
        slug: slug,
        title: text(data.title || metadata.titulo || metadata.tituloServicio, "Servicio"),
        description: text(data.description || metadata.descripcionLarga),
        tagLine: text(data.tagLine || metadata.resumenCorto),
        location: text(data.location || data.localizacion || metadata.localizacion),
        totalDuration: toFiniteNumber(
            data.totalDuration !== undefined && data.totalDuration !== null
                ? data.totalDuration
                : (data.duracionTotal !== undefined && data.duracionTotal !== null
                    ? data.duracionTotal
                    : metadata.duracionTotal)
        ),
        price: toFiniteNumber(
            data.price !== undefined && data.price !== null ? data.price : metadata.precio
        ),
        currency: text(data.currency || metadata.currency, "EUR").toUpperCase(),
        mainMedia: data.mainMedia || metadata.mainMedia || "",
        addOnOptions: Array.isArray(data.addOnOptions)
            ? data.addOnOptions
            : (Array.isArray(metadata.addOnOptions) ? metadata.addOnOptions : []),
        recommendations: Array.isArray(data.recommendations)
            ? data.recommendations
            : (Array.isArray(metadata.recomendaciones) ? metadata.recomendaciones : []),
        linkedPhases: getLinkedPhaseId(data.linkedPhases),
        availableStaff: Array.isArray(data.availableStaff) ? data.availableStaff : [],
        staffOptions: Array.isArray(data.staffOptions) ? data.staffOptions : [],
        clientHidden: data.clientHidden === true,
        allowCombine: data.allowCombine === true,
        phase1Duration: toFiniteNumber(
            data.phase1Duration !== undefined ? data.phase1Duration : data.tiempoFase1
        ),
        exposureDuration: toFiniteNumber(
            data.exposureDuration !== undefined ? data.exposureDuration : data.tiempoExposicion
        ),
        phase2Duration: toFiniteNumber(
            data.phase2Duration !== undefined ? data.phase2Duration : data.tiempoFase2
        )
    };
}

/**
 * Prioridad: query.serviceId (GUID, sin transformar) > query.slug > ultimo
 * segmento de la ruta. Nunca se aplica _safeSlugOrId al GUID.
 */
function resolveServiceLookup() {
    const query = wixLocation.query || {};

    const queryServiceId = _safeTrim(query.serviceId);
    if (queryServiceId && _looksLikeGuid(queryServiceId)) return queryServiceId;

    const querySlug = _safeTrim(query.slug);
    if (querySlug) return querySlug;

    const path = Array.isArray(wixLocation.path) ? wixLocation.path : [];
    const lastSegment = _safeTrim(path[path.length - 1] || "");
    if (!lastSegment || EXCLUDED_PATHS.has(lastSegment.toLowerCase())) return null;
    return lastSegment;
}

function getAddOnIds(payload) {
    if (!payload || !Array.isArray(payload.addOnIds)) return [];
    return Array.from(
        new Set(payload.addOnIds.map(getReferenceId).filter(Boolean))
    ).slice(0, MAX_ADDONS_PER_BOOKING);
}

function buildBookingUrl(service, payload) {
    const base = text(
        PROTOCOL_URLS && PROTOCOL_URLS.CALENDARIO_2,
        "/booking-calendar/calendario-2"
    );
    // URLSearchParams codifica ñ y tildes; Wix los decodifica sin perdida.
    const query = new URLSearchParams({
        slug: getServiceSlug(service),
        serviceId: getServiceId(service),
        referral: "servicio-2"
    });
    const addOnIds = getAddOnIds(payload);
    if (addOnIds.length > 0) query.set("addOnIds", addOnIds.join(","));
    return base + "?" + query.toString();
}

function getServicesUrl() {
    return text(PROTOCOL_URLS && PROTOCOL_URLS.SERVICIOS, "/reserva-online");
}

function showError(message) {
    const safeMessage = text(message, "No se pudo cargar el servicio.");
    console.error("[servicio-2] Error:", safeMessage);
    try {
        const banner = $w("#errorBanner");
        if (!banner) return;
        banner.text = "Error: " + safeMessage;
        if (typeof banner.show === "function") banner.show();
    } catch (error) {
        console.warn("[servicio-2] No se pudo mostrar el error:", error && error.message);
    }
}

async function loadService(lookupValue, traceId) {
    const result = await getServiceBySlugOrId(lookupValue);
    if (!result || result.status !== "SUCCESS" || !result.data || typeof result.data !== "object") {
        const code = (result && result.error && result.error.code) || "SERVICE_LOOKUP_FAILED";
        const message = (result && result.error && result.error.message) || "Servicio no encontrado.";
        const error = new Error(message);
        error.code = code;
        throw error;
    }
    const service = normalizeService(result.data);
    console.info("[servicio-2] Servicio cargado", {
        traceId: traceId,
        serviceId: service.serviceId,
        slug: service.slug || "(sin slug)"
    });
    return service;
}

function onBridgeError(error, detail, traceId) {
    const cause = (error && error.cause) || (detail && detail.cause) || detail;
    console.error("[servicio-2] Error del bridge", {
        traceId: traceId,
        code: error && error.code,
        message: error && error.message,
        causeCode: cause && cause.code,
        causeMessage: cause && cause.message
    });
    if (error && (
        error.code === "WIDGET_ORIGIN_OPAQUE_REJECTED" ||
        error.code === "WIDGET_ORIGIN_REJECTED"
    )) {
        showError("No se pudo conectar el componente de reserva. Recarga la pagina.");
        return;
    }
    showError(
        (cause && cause.message) ||
        (error && error.message) ||
        "No se pudo cargar el servicio."
    );
}

$w.onReady(function () {
    const traceId = makeTraceId("servicio");
    let widget;
    try {
        widget = $w(WIDGET_ID);
    } catch (_) {
        showError("El widget del servicio no esta disponible.");
        return;
    }
    if (!widget || typeof widget.postMessage !== "function" || typeof widget.onMessage !== "function") {
        showError("El widget del servicio no esta disponible.");
        return;
    }
    const lookupValue = resolveServiceLookup();
    if (!lookupValue) {
        showError("No se pudo localizar el servicio en la URL.");
        return;
    }
    try {
        bridge = createWidgetBridge(widget, {
            slug: lookupValue,
            traceId: traceId,
            allowOpaqueOrigin: true,
            onContextReady: async function () {
                resolvedService = await loadService(lookupValue, traceId);
                return resolvedService;
            },
            onWidgetMessage: async function (message, reply) {
                const type = getMessageType(message);
                if (type === MESSAGE_TYPES.READY || type === MESSAGE_TYPES.CONTEXT) return;
                const payload = getPayload(message);

                if (!resolvedService) {
                    console.warn("[servicio-2] Accion antes de cargar el servicio", {
                        traceId: traceId,
                        type: type
                    });
                    if (type === MESSAGE_TYPES.BOOK) {
                        reply(MESSAGE_TYPES.BOOK, {
                            status: "ERROR",
                            data: null,
                            error: {
                                code: "SERVICE_NOT_READY",
                                message: "El servicio aun se esta cargando. Intentalo de nuevo."
                            }
                        });
                    }
                    return;
                }

                if (type === MESSAGE_TYPES.BOOK) {
                    wixLocation.to(buildBookingUrl(resolvedService, payload));
                    return;
                }
                if (type === MESSAGE_TYPES.NAV) {
                    const target = text(payload.target).toUpperCase();
                    if (!target || target === "SERVICIOS") wixLocation.to(getServicesUrl());
                    return;
                }
                console.warn("[servicio-2] Mensaje no soportado", { traceId: traceId, type: type });
            },
            onError: function (error, detail) {
                onBridgeError(error, detail, traceId);
            }
        });
        if (!bridge) showError("No se pudo inicializar el widget del servicio.");
    } catch (error) {
        console.error("[servicio-2] Error de inicializacion", {
            traceId: traceId,
            code: error && error.code,
            message: error && error.message
        });
        showError((error && error.message) || "No se pudo cargar el servicio.");
    }
});
