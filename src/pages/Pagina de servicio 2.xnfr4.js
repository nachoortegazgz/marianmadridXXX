/*
=============================================================================
FILE: pages/servicio-2.js
VERSION: v5013-RACE-FIX
BASE: v5012-SERVICE-CATALOG-CLEAN-FIX1 + RACE-01 race condition fix
PURPOSE: Load the selected CMS service and provide the widget context.

FIX APPLIED v5013-RACE-FIX:
  - RACE-01: onWidgetMessage processes protocol messages (READY, CONTEXT)
    BEFORE checking resolvedService. MM_READY arrives before onContextReady
    completes service loading; this is expected, not a failure. The warning
    "Servicio aun no disponible" now only fires for action messages (BOOK,
    NAV) received prematurely.
=============================================================================
*/
import wixLocation from "wix-location-frontend";
import { getServiceBySlugOrId } from "backend/reservas.web.js";
import {
    MESSAGE_TYPES,
    URLS,
    makeTraceId,
    _safeTrim,
    _safeSlugOrId,
    _looksLikeGuid
} from "public/mmUtils";
import { createWidgetBridge } from "public/widgetBridge";

const EXCLUDED_PATHS = new Set([
    "servicios",
    "service",
    "servicio",
    "servicio-2"
]);

let bridge = null;
let resolvedService = null;

function text(value, fallback = "") {
    return _safeTrim(value) || fallback;
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
    const payload = message?.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
    return payload;
}

function getServiceId(service) {
    return getReferenceId(service?.serviceId);
}

function getServiceSlug(service) {
    return _safeSlugOrId(service?.slug || "");
}

function getLinkedPhaseId(value) {
    return getReferenceId(Array.isArray(value) ? value[0] : value);
}

function toFiniteNumber(value, fallback = 0) {
    if (value === null || value === undefined || value === "") return fallback;
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function normalizeService(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new Error("El servicio recibido no es valido.");
    }

    const metadata = data.metadata && typeof data.metadata === "object" ?
        data.metadata : {};
    const serviceId = getServiceId(data);
    const slug = getServiceSlug(data);

    if (!_looksLikeGuid(serviceId)) {
        throw new Error("El servicio no tiene un serviceId valido.");
    }
    if (!slug) {
        throw new Error("El servicio no tiene un slug valido.");
    }

    const title = text(data.title || metadata.titulo || metadata.tituloServicio, "Servicio");
    const description = text(data.description || metadata.descripcionLarga);
    const tagLine = text(data.tagLine || metadata.resumenCorto);
    const location = text(data.location || data.localizacion || metadata.localizacion);
    const price = toFiniteNumber(data.price ?? metadata.precio);
    const totalDuration = toFiniteNumber(
        data.totalDuration ?? data.duracionTotal ?? metadata.duracionTotal
    );

    return {
        serviceId,
        slug,
        title,
        description,
        tagLine,
        location,
        totalDuration,
        price,
        currency: text(data.currency || metadata.currency, "EUR").toUpperCase(),
        mainMedia: data.mainMedia || metadata.mainMedia || "",
        addOnOptions: Array.isArray(data.addOnOptions) ?
            data.addOnOptions : Array.isArray(metadata.addOnOptions) ?
            metadata.addOnOptions : [],
        linkedPhases: getLinkedPhaseId(data.linkedPhases),
        availableStaff: Array.isArray(data.availableStaff) ? data.availableStaff : [],
        clientHidden: data.clientHidden === true,
        allowCombine: data.allowCombine === true,
        phase1Duration: toFiniteNumber(data.phase1Duration ?? data.tiempoFase1),
        exposureDuration: toFiniteNumber(data.exposureDuration ?? data.tiempoExposicion),
        phase2Duration: toFiniteNumber(data.phase2Duration ?? data.tiempoFase2),
        recommendations: Array.isArray(data.recommendations) ?
            data.recommendations : Array.isArray(metadata.recomendaciones) ?
            metadata.recomendaciones : []
    };
}

function resolveServiceLookup() {
    const query = wixLocation.query || {};
    for (const candidate of [query.slug, query.serviceId]) {
        const value = _safeSlugOrId(candidate);
        if (value) return value;
    }

    const path = Array.isArray(wixLocation.path) ? wixLocation.path : [];
    const value = _safeSlugOrId(path[path.length - 1] || "");
    if (!value || EXCLUDED_PATHS.has(value.toLowerCase())) return null;
    return value;
}

function getAddOnIds(payload) {
    if (!Array.isArray(payload?.addOnIds)) return [];
    return [...new Set(payload.addOnIds.map(getReferenceId).filter(Boolean))].slice(0, 21);
}

function buildBookingUrl(service, payload) {
    const base = text(URLS?.CALENDARIO_2, "/booking-calendar/calendario-2");
    const query = new URLSearchParams({
        slug: getServiceSlug(service),
        serviceId: getServiceId(service),
        referral: "servicio-2"
    });
    const addOnIds = getAddOnIds(payload);
    if (addOnIds.length > 0) query.set("addOnIds", addOnIds.join(","));
    return `${base}?${query.toString()}`;
}

function getServicesUrl() {
    return text(URLS?.SERVICIOS, "/reserva-online");
}

function showError(message) {
    const safeMessage = text(message, "No se pudo cargar el servicio.");
    console.error("[servicio-2] Error:", safeMessage);
    try {
        const banner = $w("#errorBanner");
        if (!banner) return;
        banner.text = `Error: ${safeMessage}`;
        if (typeof banner.show === "function") banner.show();
    } catch (error) {
        console.warn("[servicio-2] No se pudo mostrar el error:", error?.message);
    }
}

async function loadService(lookupValue, traceId) {
    const result = await getServiceBySlugOrId(lookupValue);
    if (result?.status !== "SUCCESS" || !result.data || typeof result.data !== "object") {
        const code = result?.error?.code || "SERVICE_LOOKUP_FAILED";
        const message = result?.error?.message || "Servicio no encontrado.";
        const error = new Error(message);
        error.code = code;
        throw error;
    }

    const service = normalizeService(result.data);
    console.info("[servicio-2] Servicio cargado", {
        traceId,
        serviceId: service.serviceId,
        slug: service.slug
    });
    return service;
}

function onBridgeError(error, detail, traceId) {
    const cause = error?.cause || detail?.cause || detail;
    console.error("[servicio-2] Error del bridge", {
        traceId,
        code: error?.code,
        message: error?.message,
        causeCode: cause?.code,
        causeMessage: cause?.message,
        causeStack: cause?.stack,
        detail: error?.detail
    });
    showError(cause?.message || error?.message || "No se pudo cargar el servicio.");
}

$w.onReady(() => {
    const traceId = makeTraceId("servicio");
    let widget;

    try {
        widget = $w("#htmlWidgetCustomService");
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
            traceId,
            onContextReady: async () => {
                try {
                    resolvedService = await loadService(lookupValue, traceId);
                    return resolvedService;
                } catch (error) {
                    console.error("[servicio-2] Fallo cargando contexto", {
                        traceId,
                        lookupValue,
                        code: error?.code,
                        message: error?.message,
                        stack: error?.stack
                    });
                    throw error;
                }
            },
            // RACE-01: Protocol messages (READY, CONTEXT) are handled BEFORE
            // checking resolvedService. MM_READY always arrives before
            // onContextReady completes; this is expected handshake behavior,
            // not a failure. Only action messages (BOOK, NAV) require the
            // service to be loaded. If after this fix "Fallo cargando contexto"
            // appears in logs, THAT log (not this warning) diagnoses the real
            // cause.
            onWidgetMessage: async (message) => {
                const type = getMessageType(message);

                if (type === MESSAGE_TYPES.READY || type === MESSAGE_TYPES.CONTEXT) {
                    return;
                }

                const payload = getPayload(message);

                if (!resolvedService) {
                    console.warn("[servicio-2] Accion recibida antes de cargar el servicio", {
                        traceId,
                        type
                    });
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

                console.warn("[servicio-2] Mensaje no soportado", { traceId, type });
            },
            onError: (error, detail) => onBridgeError(error, detail, traceId)
        });

        if (!bridge) showError("No se pudo inicializar el widget del servicio.");
    } catch (error) {
        console.error("[servicio-2] Error de inicializacion", {
            traceId,
            code: error?.code,
            message: error?.message,
            stack: error?.stack
        });
        showError(error?.message || "No se pudo cargar el servicio.");
    }
});