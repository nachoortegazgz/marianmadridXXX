/*
FILE: pages/servicio-2.js
VERSION: v5013.3-UNICODE-SLUG-FIX
BASE: v5013.2-SERVICE-LOOKUP-FIX
PURPOSE: Load the selected CMS service and provide the widget context.
FIXES:
  - getServiceSlug uses _safeTrim only (no _safeSlugOrId). Preserves ñ,
    tildes and all Unicode characters in slugs.
  - buildBookingUrl passes raw slug to URLSearchParams which encodes it
    correctly for transport; backend decodes without loss.
  - Widget ID: #htmlWidgetCustomService (confirmed in Editor).
  - Import PROTOCOL_URLS from widgetBridge (SSOT).
  - Full syntax recovery: =>, &&, ||, ?? operators restored.
  - Recommendations field aligned with new CMS structure.
  - Timeout aligned to 30s (PROTOCOL_UI.CONTEXT_TIMEOUT_MS).
ASCII: Strict ASCII in comments and identifiers.
       Data values (slugs, names) preserve full Unicode.
*/
import wixLocation from "wix-location-frontend";
import { getServiceBySlugOrId } from "backend/reservas.web.js";
import {
    MESSAGE_TYPES,
    PROTOCOL_URLS,
    makeTraceId,
    _safeTrim,
    _looksLikeGuid
} from "public/mmUtils";
import { createWidgetBridge } from "public/widgetBridge";

const EXCLUDED_PATHS = new Set([
    "servicios",
    "service",
    "servicio",
    "servicio-2",
    "reserva-online"
]);

const MAX_ADDONS_PER_BOOKING = 5;

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
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return {};
    }
    return payload;
}

function getServiceId(service) {
    return getReferenceId(service && service.serviceId);
}

/**
 * UNICODE-SLUG-FIX: Returns the slug as-is after trim only.
 * Does NOT call _safeSlugOrId (which would lowercase and strip diacritics).
 * URLSearchParams in buildBookingUrl handles encoding for transport.
 */
function getServiceSlug(service) {
    return _safeTrim((service && service.slug) || "");
}

function getLinkedPhaseId(value) {
    return getReferenceId(Array.isArray(value) ? value[0] : value);
}

function toFiniteNumber(value, fallback) {
    if (value === null || value === undefined || value === "") {
        return fallback === undefined ? 0 : fallback;
    }
    const number = Number(value);
    return Number.isFinite(number) ? number : (fallback === undefined ? 0 : fallback);
}

function normalizeService(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new Error("El servicio recibido no es válido.");
    }
    const metadata = data.metadata && typeof data.metadata === "object"
        ? data.metadata
        : {};
    const serviceId = getServiceId(data);
    const slug = getServiceSlug(data);
    if (!_looksLikeGuid(serviceId)) {
        throw new Error("El servicio no tiene un identificador válido.");
    }
    if (!slug) {
        throw new Error("El servicio no tiene un slug válido.");
    }
    const title = text(
        data.title || metadata.titulo || metadata.tituloServicio,
        "Servicio"
    );
    const description = text(data.description || metadata.descripcionLarga);
    const tagLine = text(data.tagLine || metadata.resumenCorto);
    const location = text(
        data.location || data.localizacion || metadata.localizacion
    );
    const price = toFiniteNumber(data.price !== undefined ? data.price : metadata.precio);
    const totalDuration = toFiniteNumber(
        data.totalDuration !== undefined ? data.totalDuration
            : (data.duracionTotal !== undefined ? data.duracionTotal : metadata.duracionTotal)
    );
    const recommendations = Array.isArray(data.recommendations)
        ? data.recommendations
        : Array.isArray(metadata.recomendaciones)
            ? metadata.recomendaciones
            : [];
    return {
        serviceId: serviceId,
        slug: slug,
        title: title,
        description: description,
        tagLine: tagLine,
        location: location,
        totalDuration: totalDuration,
        price: price,
        currency: text(data.currency || metadata.currency, "EUR").toUpperCase(),
        mainMedia: data.mainMedia || metadata.mainMedia || "",
        addOnOptions: Array.isArray(data.addOnOptions)
            ? data.addOnOptions
            : Array.isArray(metadata.addOnOptions)
                ? metadata.addOnOptions
                : [],
        linkedPhases: getLinkedPhaseId(data.linkedPhases),
        availableStaff: Array.isArray(data.availableStaff)
            ? data.availableStaff
            : [],
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
        ),
        recommendations: recommendations
    };
}

/**
 * Resolves service identifier from URL.
 * Priority: query.serviceId (GUID) > query.slug > last path segment.
 * Slugs are preserved with full Unicode (ñ, tildes intact).
 */
function resolveServiceLookup() {
    const query = wixLocation.query || {};
    const queryServiceId = _safeTrim(query.serviceId || "");
    if (queryServiceId && _looksLikeGuid(queryServiceId)) {
        return queryServiceId;
    }
    const querySlug = _safeTrim(query.slug || "");
    if (querySlug) {
        return querySlug;
    }
    const path = Array.isArray(wixLocation.path) ? wixLocation.path : [];
    const lastSegment = _safeTrim(path[path.length - 1] || "");
    if (!lastSegment || EXCLUDED_PATHS.has(lastSegment.toLowerCase())) {
        return null;
    }
    return lastSegment;
}

function getAddOnIds(payload) {
    if (!payload || !Array.isArray(payload.addOnIds)) return [];
    return Array.from(
        new Set(payload.addOnIds.map(getReferenceId).filter(Boolean))
    ).slice(0, MAX_ADDONS_PER_BOOKING);
}

/**
 * UNICODE-SLUG-FIX: Passes raw slug directly to URLSearchParams.
 * URLSearchParams encodes ñ/tildes correctly for transport.
 * Backend receives decoded value and searches by exact match.
 */
function buildBookingUrl(service, payload) {
    const base = text(
        PROTOCOL_URLS && PROTOCOL_URLS.CALENDARIO_2,
        "/booking-calendar/calendario-2"
    );
    const query = new URLSearchParams({
        slug: (service && service.slug) || "",
        serviceId: getServiceId(service),
        referral: "servicio-2"
    });
    const addOnIds = getAddOnIds(payload);
    if (addOnIds.length > 0) {
        query.set("addOnIds", addOnIds.join(","));
    }
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
        console.warn(
            "[servicio-2] No se pudo mostrar el error:",
            error && error.message
        );
    }
}

async function loadService(lookupValue, traceId) {
    const result = await getServiceBySlugOrId(lookupValue);
    if (
        !result ||
        result.status !== "SUCCESS" ||
        !result.data ||
        typeof result.data !== "object"
    ) {
        const code = (result && result.error && result.error.code)
            ? result.error.code
            : "SERVICE_LOOKUP_FAILED";
        const message = (result && result.error && result.error.message)
            ? result.error.message
            : "Servicio no encontrado.";
        const error = new Error(message);
        error.code = code;
        throw error;
    }
    const service = normalizeService(result.data);
    console.info("[servicio-2] Servicio cargado", {
        traceId: traceId,
        serviceId: service.serviceId,
        slug: service.slug
    });
    return service;
}

function onBridgeError(error, detail, traceId) {
    const cause = (error && error.cause) ||
        (detail && detail.cause) ||
        detail;
    console.error("[servicio-2] Error del bridge", {
        traceId: traceId,
        code: error && error.code,
        message: error && error.message,
        causeCode: cause && cause.code,
        causeMessage: cause && cause.message,
        detail: error && error.detail
    });
    if (
        error &&
        (error.code === "WIDGET_ORIGIN_OPAQUE_REJECTED" ||
            error.code === "WIDGET_ORIGIN_REJECTED")
    ) {
        showError("No se pudo conectar el componente de reserva. Recarga la página.");
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
        widget = $w("#htmlWidgetCustomService");
    } catch (_) {
        showError("El widget del servicio no está disponible.");
        return;
    }
    if (
        !widget ||
        typeof widget.postMessage !== "function" ||
        typeof widget.onMessage !== "function"
    ) {
        showError("El widget del servicio no está disponible.");
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
                if (
                    type === MESSAGE_TYPES.READY ||
                    type === MESSAGE_TYPES.CONTEXT
                ) {
                    return;
                }
                const payload = getPayload(message);
                if (!resolvedService) {
                    console.warn(
                        "[servicio-2] Acción recibida antes de cargar el servicio",
                        { traceId: traceId, type: type }
                    );
                    if (type === MESSAGE_TYPES.BOOK) {
                        reply(MESSAGE_TYPES.BOOK, {
                            status: "ERROR",
                            data: null,
                            error: {
                                code: "SERVICE_NOT_READY",
                                message: "El servicio aún se está cargando. Inténtalo de nuevo."
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
                    if (!target || target === "SERVICIOS") {
                        wixLocation.to(getServicesUrl());
                    }
                    return;
                }
                console.warn(
                    "[servicio-2] Mensaje no soportado",
                    { traceId: traceId, type: type }
                );
            },
            onError: function (error, detail) {
                onBridgeError(error, detail, traceId);
            }
        });
        if (!bridge) {
            showError("No se pudo inicializar el widget del servicio.");
        }
    } catch (error) {
        console.error("[servicio-2] Error de inicialización", {
            traceId: traceId,
            code: error && error.code,
            message: error && error.message
        });
        showError((error && error.message) || "No se pudo cargar el servicio.");
    }
});
