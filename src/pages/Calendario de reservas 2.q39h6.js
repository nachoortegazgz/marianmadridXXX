/**
 * MODULE: pages/calendario-2.js
 * VERSION: v5003.3-FUNCTIONAL
 * STANDARDS: G10 ASCII Strict, Velo Native Optimized.
 */

import wixLocation from "wix-location";

import {
  getServiceBySlugOrId,
  getAvailableDays,
  getCertifiedDualSlots,
  resolveStaffForSlot
} from "backend/reservas.web";

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
import { processDualBooking } from "backend/citasManager.web";

const DEFAULT_SERVICE_IMAGE =
  "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1200 800'><rect width='1200' height='800' fill='%23e9e2d9'/><circle cx='900' cy='170' r='210' fill='%23d8bea0'/><rect x='105' y='180' width='530' height='450' rx='30' fill='%23f7f3ee'/><text x='160' y='420' fill='%23342b24' font-family='Georgia' font-size='68'>MARIAN</text><text x='160' y='500' fill='%23342b24' font-family='Georgia' font-size='68'>MADRID</text></svg>";

let currentServiceId = null;
let currentSlugUrl = null;
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
  if (
    params.serviceId &&
    _looksLikeGuid(params.serviceId)
  ) {
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
    message &&
    (message.type || message.action) ||
    ""
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
    error: {
      code,
      message
    }
  };
}

function getResponseType(type) {
  return type || MESSAGE_TYPES.BOOK;
}

async function loadServiceContext(params) {
  const lookup = currentServiceId || currentSlugUrl;

  const result = await getServiceBySlugOrId(lookup);

  if (
    !result ||
    result.status !== "SUCCESS" ||
    !result.data
  ) {
    throw new Error(
      result?.error?.message ||
      "No se pudo cargar el servicio."
    );
  }

  currentService = result.data;

  const metadata = result.data.metadata || {};

  return {
    ...result.data,
    serviceId: result.data.serviceId || currentServiceId,
    slug: result.data.slug || currentSlugUrl,
    referral: params.referral,
    preselectedAddonIds: params.addOnIds,
    timeZone: "Europe/Madrid",
    currencyCode:
      result.data.currency ||
      metadata.currency ||
      metadata.pricing?.currency ||
      "EUR",
    imageUrl:
      result.data.imageUrl ||
      metadata.imageUrl ||
      DEFAULT_SERVICE_IMAGE,
    metadata: {
      ...metadata,
      imageUrl:
        metadata.imageUrl ||
        result.data.imageUrl ||
        DEFAULT_SERVICE_IMAGE
    }
  };
}

async function handleNavigation(payload) {
  const target = _safeTrim(
    payload?.target || ""
  ).toUpperCase();

  if (target === "SERVICIOS") {
    wixLocation.to(
      URLS?.SERVICIOS || "/reserva-online"
    );
    return true;
  }

  if (target === "PRIVACY") {
    wixLocation.to(
      URLS?.PRIVACY_POLICY ||
      "/politica-de-privacidad"
    );
    return true;
  }

  return false;
}

async function handleAvailability(payload, reply) {
  const action = _safeTrim(
    payload.action || ""
  ).toLowerCase();

  const addOnIds = Array.isArray(payload.addOnIds)
    ? payload.addOnIds
    : [];

  let result;

  try {
    if (action === "days") {
      result = await withTimeout(
        getAvailableDays(
          currentServiceId || currentSlugUrl,
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
        getCertifiedDualSlots(
          currentServiceId || currentSlugUrl,
          payload.resourceId || null,
          _safeTrim(payload.dateYmd || ""),
          addOnIds
        ),
        UI?.FRONTEND_API_TIMEOUT_MS || 60000,
        "getCertifiedDualSlots"
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
      error?.message ||
      "No se pudo obtener disponibilidad."
    );
  }

  reply(
    MESSAGE_TYPES.AVAIL,
    {
      ...(result || createResultError(
        "EMPTY_AVAILABILITY_RESPONSE",
        "No se recibio disponibilidad."
      )),
      requestSequence: payload.requestSequence || 0
    },
    payload
  );
}

async function handleSelection(payload, reply) {
  const start = _safeTrim(
    payload.localStartDate || ""
  );

  if (!start) {
    const result = createResultError(
      "INVALID_SLOT",
      "El horario seleccionado no es valido."
    );

    reply(MESSAGE_TYPES.SELECT, result, payload);
    return;
  }

  try {
    const result = await withTimeout(
      resolveStaffForSlot(
        currentServiceId || currentSlugUrl,
        start,
        payload.resourceId || null,
        Array.isArray(payload.bookedAddOns)
          ? payload.bookedAddOns
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
        error?.message ||
        "No se pudo validar el profesional."
      ),
      payload
    );
  }
}

async function handleBooking(message, reply, traceId) {
  const payload = getPayload(message);

  const bookingData =
    payload.bookingData &&
    typeof payload.bookingData === "object"
      ? payload.bookingData
      : payload;

  if (
    !bookingData ||
    typeof bookingData !== "object"
  ) {
    const result = createResultError(
      "INVALID_BOOKING_PAYLOAD",
      "Los datos de la reserva no son validos."
    );

    reply(MESSAGE_TYPES.BOOK, result, message);
    return;
  }

  const requestPayload = {
    ...bookingData,
    serviceId:
      bookingData.serviceId ||
      currentServiceId,
    slug:
      bookingData.slug ||
      currentSlugUrl,
    traceId
  };

  try {
    const result = await withTimeout(
      processDualBooking(requestPayload),
      UI?.FRONTEND_API_TIMEOUT_MS || 60000,
      "processDualBooking"
    );

    reply(
      MESSAGE_TYPES.BOOK,
      result || createResultError(
        "EMPTY_BOOKING_RESPONSE",
        "No se recibio respuesta de la reserva."
      ),
      message
    );
  } catch (error) {
    const timeout =
      error?.code === "TIMEOUT" ||
      String(error?.message || "")
        .toUpperCase()
        .includes("TIMEOUT");

    reply(
      MESSAGE_TYPES.BOOK,
      createResultError(
        timeout
          ? "BOOKING_TIMEOUT"
          : "BOOKING_FAILED",
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
    console.error(
      "[calendario-2] Servicio no valido",
      { traceId }
    );
    return;
  }

  currentServiceId = resolved.serviceId;
  currentSlugUrl = resolved.slug;

  const widget = $w("#htmlWidgetCalendario");

  if (
    !widget ||
    typeof widget.postMessage !== "function" ||
    typeof widget.onMessage !== "function"
  ) {
    console.error(
      "[calendario-2] Widget HTML no disponible",
      { traceId }
    );
    return;
  }

  try {
    bridge = createWidgetBridge(widget, {
      onContextReady: async () => {
        return loadServiceContext(params);
      },

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
          await handleBooking(
            message,
            reply,
            traceId
          );
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
      throw new Error(
        "No se pudo inicializar el bridge."
      );
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
