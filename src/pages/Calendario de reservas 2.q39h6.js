/**
 * MODULE: pages/calendario-2.js
 * VERSION: v5010-SERVICE-CONTRACT-ALIGNED
 */

import wixLocation from "wix-location-frontend";
import wixWindow from "wix-window-frontend";

import {
  getServiceBySlugOrId,
  getAvailableDays,
  getAvailableSlots,
  getCertifiedDualSlots,
  resolveStaffForSlot
} from "backend/reservas.web";

import {
  MESSAGE_TYPES,
  URLS,
  UI,
  makeTraceId,
  _safeTrim,
  _looksLikeGuid,
  withTimeout
} from "public/mmUtils";

import { createWidgetBridge } from "public/widgetBridge";
import { processDualBooking } from "backend/citasManager.web";

let currentServiceId = "";
let currentSlug = "";
let currentService = null;
let bridge = null;

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
    return {
      serviceId,
      slug: slug || ""
    };
  }

  if (slug) {
    return {
      serviceId: "",
      slug
    };
  }

  return null;
}

function getMessageType(message) {
  return _safeTrim(
    message?.type ||
    message?.action ||
    ""
  ).toUpperCase();
}

function getPayload(message) {
  if (
    message?.payload &&
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

function getReferenceId(value) {
  if (typeof value === "string") {
    return _safeTrim(value);
  }

  if (value && typeof value === "object") {
    return _safeTrim(
      value.id ||
      value.referenceId ||
      value.value ||
      ""
    );
  }

  return "";
}

function getActiveServiceLookup() {
  return (
    currentService?.serviceId ||
    currentService?.slug ||
    currentServiceId ||
    currentSlug
  );
}

function filterAllowedAddonIds(service, requestedIds) {
  if (!Array.isArray(requestedIds)) {
    return [];
  }

  const addOnOptions = Array.isArray(service?.addOnOptions)
    ? service.addOnOptions
    : [];

  const allowed = new Set();

  for (const addon of addOnOptions) {
    const id = getReferenceId(
      typeof addon === "string"
        ? addon
        : addon?.addOnId ||
          addon?.id ||
          addon?.referenceId
    );

    if (id) {
      allowed.add(id);
    }
  }

  return Array.from(
    new Set(
      requestedIds
        .map(_safeTrim)
        .filter((id) => id && allowed.has(id))
    )
  ).slice(0, 21);
}

function normalizeService(data, params) {
  const metadata =
    data.metadata &&
    typeof data.metadata === "object"
      ? data.metadata
      : {};

  const serviceId = getReferenceId(data.serviceId);
  const slug = _safeTrim(
    data.slug ||
    params.slug ||
    currentSlug ||
    ""
  );

  if (!_looksLikeGuid(serviceId)) {
    throw new Error(
      "El servicio no tiene un serviceId valido."
    );
  }

  const mainMedia = _safeTrim(
    data.mainMedia ||
    ""
  );

  const addOnOptions = Array.isArray(data.addOnOptions)
    ? data.addOnOptions
    : [];

  return {
    ...data,

    serviceId,
    slug,

    title: _safeTrim(
      data.title ||
      metadata.title ||
      ""
    ),

    description: _safeTrim(
      data.description ||
      metadata.description ||
      ""
    ),

    location: _safeTrim(
      data.location ||
      metadata.location ||
      ""
    ),

    totalDuration: Number(
      data.totalDuration ??
      metadata.totalDuration ??
      0
    ),

    price: Number(
      data.price ??
      metadata.price ??
      0
    ),

    mainMedia,
    addOnOptions,

    allowCombine:
      data.allowCombine === true ||
      metadata.allowCombine === true,

    linkedPhases: Array.isArray(data.linkedPhases)
      ? data.linkedPhases
      : data.linkedPhases
        ? [data.linkedPhases]
        : [],

    metadata: {
      ...metadata,
      mainMedia,
      addOnOptions
    },

    referral: params.referral,
    preselectedAddOnIds: params.addOnIds,
    timeZone: "Europe/Madrid",
    currencyCode: _safeTrim(
      data.currencyCode ||
      metadata.currencyCode ||
      "EUR"
    ).toUpperCase()
  };
}

async function loadServiceContext(params) {
  const lookup = currentServiceId || currentSlug;
  const result = await getServiceBySlugOrId(lookup);

  if (
    !result ||
    result.status !== "SUCCESS" ||
    !result.data ||
    typeof result.data !== "object"
  ) {
    throw new Error(
      result?.error?.message ||
      "No se pudo cargar el servicio."
    );
  }

  currentService = normalizeService(
    result.data,
    params
  );

  currentServiceId = currentService.serviceId;
  currentSlug = currentService.slug;

  return currentService;
}

async function handleNavigation(payload) {
  const target = _safeTrim(
    payload?.target || ""
  ).toUpperCase();

  if (target === "SERVICIOS") {
    wixLocation.to(
      URLS?.SERVICIOS || "/reserva-online"
    );
    return;
  }

  if (target === "PRIVACY") {
    wixLocation.to(
      URLS?.PRIVACY_POLICY ||
      "/politica-de-privacidad"
    );
  }
}

async function handleAvailability(payload, reply) {
  if (!currentService) {
    reply(
      MESSAGE_TYPES.AVAIL,
      createResultError(
        "SERVICE_CONTEXT_NOT_READY",
        "El servicio todavia se esta cargando."
      ),
      payload
    );
    return;
  }

  const action = _safeTrim(
    payload.action || ""
  ).toLowerCase();

  const addOnIds = filterAllowedAddonIds(
    currentService,
    payload.addOnIds
  );

  const lookup = getActiveServiceLookup();
  const timeout = UI?.FRONTEND_API_TIMEOUT_MS || 60000;

  try {
    let result;

    if (action === "days") {
      result = await withTimeout(
        () => getAvailableDays(
          lookup,
          payload.resourceId || null,
          Number(payload.year),
          Number(payload.month),
          addOnIds
        ),
        timeout,
        "getAvailableDays"
      );
    } else if (action === "slots") {
      const dateYmd = _safeTrim(
        payload.dateYmd || ""
      );

      result = await withTimeout(
        () => currentService.allowCombine
          ? getCertifiedDualSlots(
              lookup,
              payload.resourceId || null,
              dateYmd,
              addOnIds
            )
          : getAvailableSlots(
              lookup,
              payload.resourceId || null,
              dateYmd,
              addOnIds
            ),
        timeout,
        currentService.allowCombine
          ? "getCertifiedDualSlots"
          : "getAvailableSlots"
      );
    } else {
      result = createResultError(
        "INVALID_AVAILABILITY_REQUEST",
        "Solicitud de disponibilidad no valida."
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
  } catch (error) {
    reply(
      MESSAGE_TYPES.AVAIL,
      createResultError(
        "AVAILABILITY_FAILED",
        "No se pudo obtener disponibilidad."
      ),
      payload
    );
  }
}

async function handleSelection(payload, reply) {
  if (!currentService) {
    reply(
      MESSAGE_TYPES.SELECT,
      createResultError(
        "SERVICE_CONTEXT_NOT_READY",
        "El servicio todavia se esta cargando."
      ),
      payload
    );
    return;
  }

  const start = _safeTrim(
    payload.localStartDate ||
    payload.slotF1?.localStartDate ||
    ""
  );

  const end = _safeTrim(
    payload.localEndDate ||
    payload.slotF1?.localEndDate ||
    ""
  );

  if (!start || !end) {
    reply(
      MESSAGE_TYPES.SELECT,
      createResultError(
        "INVALID_SLOT",
        "El intervalo seleccionado no es valido."
      ),
      payload
    );
    return;
  }

  const addOnIds = filterAllowedAddonIds(
    currentService,
    payload.addOnIds
  );

  try {
    const result = await withTimeout(
      () => resolveStaffForSlot(
        getActiveServiceLookup(),
        start,
        payload.resourceId || null,
        addOnIds,
        end
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
        "No se pudo validar el profesional."
      ),
      payload
    );
  }
}

async function handleBooking(message, reply, traceId) {
  const payload = getPayload(message);

  if (!currentService) {
    reply(
      MESSAGE_TYPES.BOOK,
      createResultError(
        "SERVICE_CONTEXT_NOT_READY",
        "El servicio todavia se esta cargando."
      ),
      payload
    );
    return;
  }

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
      payload
    );
    return;
  }

  if (currentService.allowCombine) {
    const f2 = bookingData.slotF2;

    if (
      !f2 ||
      !_safeTrim(f2.localStartDate) ||
      !_safeTrim(f2.localEndDate)
    ) {
      reply(
        MESSAGE_TYPES.BOOK,
        createResultError(
          "INVALID_DUAL_SLOT",
          "Falta el horario de la segunda fase."
        ),
        payload
      );
      return;
    }
  }

  const addOnIds = filterAllowedAddonIds(
    currentService,
    bookingData.addOnIds
  );

  const requestPayload = {
    ...bookingData,

    // Identidades normalizadas y no modificables por el widget.
    serviceId: currentService.serviceId,
    slug: currentService.slug,

    addOnIds,
    traceId
  };

  try {
    const result = await withTimeout(
      () => processDualBooking(requestPayload),
      UI?.FRONTEND_API_TIMEOUT_MS || 60000,
      "processDualBooking"
    );

    const bookingResult =
      result ||
      createResultError(
        "EMPTY_BOOKING_RESPONSE",
        "No se recibio respuesta de la reserva."
      );

    reply(
      MESSAGE_TYPES.BOOK,
      bookingResult,
      payload
    );

    if (
      bookingResult.status === "SUCCESS" ||
      bookingResult.success === true
    ) {
      await wixWindow.openLightbox(
        "ConfirmacionReserva",
        bookingResult.data || bookingResult
      );
    }
  } catch (error) {
    reply(
      MESSAGE_TYPES.BOOK,
      createResultError(
        "BOOKING_FAILED",
        "No se pudo completar la reserva."
      ),
      payload
    );
  }
}

$w.onReady(async () => {
  const traceId = makeTraceId("calendario");
  const params = parseUrlParams();
  const resolved = resolveServiceFromParams(params);

  if (!resolved) {
    console.error(
      "[calendario-2] Identidad de servicio invalida",
      { traceId }
    );
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
    console.error(
      "[calendario-2] Widget HTML no disponible",
      { traceId }
    );
    return;
  }

  try {
    bridge = createWidgetBridge(widget, {
      onContextReady: () => loadServiceContext(params),

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

