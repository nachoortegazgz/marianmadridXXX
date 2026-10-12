/*
============================================================================
FILE: backend/reservas.web.js
VERSION: v5010.6-PAIRTOKEN-AND-STAFF-FROM-SLOTS
BASE: v5010.5-STAFF-FROM-SLOTS + D3 (pairToken emitido en disponibilidad)
RESPONSIBILITY: Availability engine, dual slots, staff pairing and caching.
STANDARDS: G10 ASCII Strict. Unicode preserved in data values (slugs).
FIXES v5010.6:
D3-PAIRTOKEN (P0): _getCertifiedDualSlotsInternal emite pairToken real por par
       usando _buildPairTokenDeterministic (bookingUtils, unica definicion).
       La huella usa exactamente los 8 campos de CORE-05/SAGA-02 y deriva
       dateYmd de f1Start (no del parametro de consulta) para que la saga
       reproduzca el mismo token byte a byte. Antes se emitia pairToken:null
       y la rama SUPPLIED de bookingSaga era codigo muerto.
D3-STAFF-DUAL (P1): getCertifiedDualSlots devuelve staffOptions/availableStaff
       derivados de los recursos reales de los pares F1+F2.
FIX-STAFF-DISPLAY (P0): _getStaffDisplayNamePublic usaba safeTrim (sin guion
       bajo) -> ReferenceError silenciado por el catch -> todo el personal
       aparecia como "Profesional".
FIX-LOCATION-MUTABLE (P0): LOCATION_TS congelado sustituido por
       _buildLocationTS(). @wix/sdk-runtime muta el objeto location
       (rename-all-nested-keys) y lanzaba "Cannot assign to read only
       property 'id'", abortando getAvailableDays/getAvailableSlots/dual.
FIX-DTO-CONFIRM (P0): _CONFIRMATION_DTO_FIELDS tenia espacios finales en las
       8 claves (DTO siempre vacio) y usaba totalPrice, que no existe en
       CitasF2 (Biblia 5.4 -> totalAmount).
FIX-LEGACY-ZERO (P1): eliminadas las consultas y alias sobre servicioID y el
       import de listStaff (MapaStaff suprimido). Busqueda canonica unica:
       $or [serviceId, slug, _id].
FIXES HEREDADOS: UNICODE-SLUG, STAFF-FROM-SLOTS, DAL-01..04, FIX-DIAG-DAYS.
============================================================================
*/
import { webMethod, Permissions } from "wix-web-module";
import {
    queryFirstItem,
    queryItems,
    CONSISTENCY
} from "backend/dataAccess";
import { availabilityTimeSlots } from "@wix/bookings";
import {
    BUSINESS_COLLECTIONS,
    SDK_CONFIG,
    SLOT_SEARCH,
    API,
    STAFF_DEFAULT_NAME,
    BOOKING_STATUS,
    BOOKING_FIELDS
} from "backend/internalConfig";
import {
    makeTraceId,
    _safeTrim,
    _safeSlugOrId,
    _looksLikeGuid,
    _normalizeLocalIsoStr,
    getUtcDateFromMadridLocal,
    _executeWithRetry,
    withTimeout
} from "public/mmUtils";
import {
    cleanGuidList,
    readDurationRange,
    resolveExpectedSlotMinutes,
    resolveLinkedPhase2Duration,
    computeGapMinutes,
    toUtcRange,
    pickStaffByLowestLoad,
    // D3: unica definicion del token determinista del par dual.
    _buildPairTokenDeterministic
} from "backend/booking/bookingUtils";
import { logger } from "backend/logger";
import { getStaffDisplayName } from "backend/staff";
import { normalizeBookingStatus } from "backend/validation";

const log = logger;

// ============================================================================
// HELPERS INTERNOS
// ============================================================================
function _readServiceField(service, field) {
    if (!service || typeof service !== "object") return null;
    return service[field] ?? null;
}

/**
 * Normalizacion minima del registro de catalogo. Solo campos canonicos
 * (cms.v8 / Biblia 5.7). Cero alias legacy: servicioID, taxRate,
 * fasesVinculadas, clienteOculto, etc. ya no existen en el CMS.
 */
function _normalizeCatalogService(item) {
    if (!item || typeof item !== "object") return null;
    return {
        ...item,
        serviceId: item.serviceId,
        slug: item.slug || "",
        title: item.title || "",
        price: item.price ?? 0,
        totalDuration: item.totalDuration ?? 0,
        location: item.location || "",
        locationId: item.locationId || "",
        addOnOptions: Array.isArray(item.addOnOptions) ? item.addOnOptions : [],
        recommendations: Array.isArray(item.recommendations) ? item.recommendations : [],
        clientHidden: item.clientHidden === true
    };
}

function _normalizeAddon(addOn) {
    if (!addOn || typeof addOn !== "object") return null;
    const addOnId = _safeTrim(addOn.addOnId);
    const name = _safeTrim(addOn.name);
    const price = Number(addOn.price);
    if (!addOnId || !name || !Number.isFinite(price)) return null;
    return {
        addOnId: addOnId,
        name: name,
        price: price,
        nativeId: _safeTrim(addOn.nativeId) || null
    };
}

const SERVICIOS_COL = BUSINESS_COLLECTIONS.SERVICIOS_CATALOGO;
const WATCHDOG_TIMEOUT_MS = SDK_CONFIG.TIMEOUTS.WATCHDOG_MS;
const SERVICE_CACHE_TTL_MS = SDK_CONFIG.CACHE.SERVICES_TTL_MS;
const MINUTOS_MAX_HUECO_DUAL = Math.max(
    0,
    Number(SLOT_SEARCH && SLOT_SEARCH.MINUTOS_MAX_HUECO_DUAL) || 120
);
const CACHE_MAX_SIZE = SDK_CONFIG.CACHE.MAX_ENTRIES;
const STAFF_RESOURCE_TYPE_ID = API.STAFF_RESOURCE_TYPE_ID;
const STAFF_LOAD_QUERY_LIMIT = Math.max(
    100,
    Number(SDK_CONFIG && SDK_CONFIG.JOBS && SDK_CONFIG.JOBS.HEALTH_CHECK_QUERY_LIMIT) || 1000
);
const CONFIGURED_LOCATION_TYPE = _safeTrim(
    SDK_CONFIG.LOCATION_TYPES && SDK_CONFIG.LOCATION_TYPES.TIME_SLOTS
);

/**
 * FIX-LOCATION-MUTABLE: objeto NUEVO y MUTABLE en cada llamada.
 * El SDK de Wix reescribe claves en profundidad antes de enviar el request;
 * con Object.freeze lanzaba TypeError y abortaba toda consulta.
 * Biblia 3.3: listAvailabilityTimeSlots usa locationType BUSINESS.
 */
function _buildLocationTS() {
    const configured = _safeTrim(CONFIGURED_LOCATION_TYPE);
    return {
        id: SDK_CONFIG.LOCATION_ID,
        locationType: configured || "BUSINESS"
    };
}

const serviceCatalogRAM = new Map();

function _cacheSetBounded(map, key, value, maxSize) {
    if (map.has(key)) map.delete(key);
    map.set(key, value);
    if (map.size <= maxSize) return;
    const firstKey = map.keys().next().value;
    if (firstKey !== undefined) map.delete(firstKey);
}

function _toPublicError(err, fallbackCode, fallbackMessage) {
    return {
        code: String((err && err.code) || fallbackCode || "INTERNAL_ERROR"),
        message: String((err && err.message) || fallbackMessage || "Internal Error")
    };
}

function _normalizeSlotShape(slot) {
    if (!slot || typeof slot !== "object") return null;
    if (slot.slot && typeof slot.slot === "object") {
        return Object.assign({}, slot.slot, slot);
    }
    return slot;
}

function _attachServiceId(slot, forcedServiceId, traceId, ctx) {
    const normalizedSlot = _normalizeSlotShape(slot);
    if (!normalizedSlot) return null;
    const serviceId = _safeTrim(forcedServiceId);
    if (!serviceId || !_looksLikeGuid(serviceId)) {
        log.error("_attachServiceId: invalid serviceId", {
            traceId: traceId,
            ctx: ctx,
            serviceId: serviceId
        });
        return null;
    }
    const attached = Object.assign({}, normalizedSlot, { serviceId: serviceId });
    if (normalizedSlot.slot && typeof normalizedSlot.slot === "object") {
        attached.slot = Object.assign({}, normalizedSlot.slot, { serviceId: serviceId });
    }
    return attached;
}

function _isValidMadridYmd(value) {
    const ymd = _safeTrim(value);
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
    if (!match) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
    return (
        date.getUTCFullYear() === year &&
        date.getUTCMonth() === month - 1 &&
        date.getUTCDate() === day
    );
}

function _normalizeResourceIds(resourceId, traceId) {
    if (!resourceId) return [];
    const normalized = _safeTrim(resourceId);
    if (!normalized) return [];
    const lower = normalized.toLowerCase();
    if (lower === "all" || lower === "any") return [];
    if (_looksLikeGuid(normalized)) return [normalized];
    log.warn("_normalizeResourceIds: invalid resource identifier", {
        resourceId: normalized,
        traceId: traceId
    });
    return [];
}

function _getResourceIdsFromSlot(slot) {
    const normalizedSlot = _normalizeSlotShape(slot);
    if (!normalizedSlot || typeof normalizedSlot !== "object") return [];
    let groups = [];
    if (Array.isArray(normalizedSlot.availableResources)) {
        groups = normalizedSlot.availableResources;
    } else if (
        normalizedSlot.slot &&
        typeof normalizedSlot.slot === "object" &&
        Array.isArray(normalizedSlot.slot.availableResources)
    ) {
        groups = normalizedSlot.slot.availableResources;
    }
    if (groups.length > 0) {
        const staffGroup = groups.find(function (group) {
            return String(group && group.resourceTypeId) === String(STAFF_RESOURCE_TYPE_ID);
        });
        if (!staffGroup) return [];
        const collected = (staffGroup.resources || [])
            .map(function (resource) {
                return _safeTrim(
                    (resource && resource.id) ||
                    (resource && resource._id) ||
                    (resource && resource.resourceId)
                );
            })
            .filter(function (rid) { return _looksLikeGuid(rid); });
        return Array.from(new Set(collected));
    }
    const directId = _safeTrim(
        (normalizedSlot.resource && normalizedSlot.resource.id) ||
        (normalizedSlot.resource && normalizedSlot.resource._id) ||
        (normalizedSlot.resource && normalizedSlot.resource.resourceId) ||
        normalizedSlot.resourceId
    );
    return _looksLikeGuid(directId) ? [directId] : [];
}

function _minutesBetweenUtcDates(a, b) {
    if (!(a instanceof Date) || !(b instanceof Date)) return 0;
    const milliseconds = b.getTime() - a.getTime();
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) return 0;
    return Math.round(milliseconds / 60000);
}

function _isValidSlotRange(startLocal, endLocal) {
    const startUtc = getUtcDateFromMadridLocal(_normalizeLocalIsoStr(startLocal));
    const endUtc = getUtcDateFromMadridLocal(_normalizeLocalIsoStr(endLocal));
    return Boolean(startUtc && endUtc && endUtc.getTime() > startUtc.getTime());
}

/** FIX-STAFF-DISPLAY: _safeTrim (antes safeTrim -> ReferenceError). */
async function _getStaffDisplayNamePublic(resourceId) {
    const id = _safeTrim(resourceId);
    if (!id || !_looksLikeGuid(id)) return STAFF_DEFAULT_NAME;
    try {
        const name = await getStaffDisplayName(id);
        return _safeTrim(name) || STAFF_DEFAULT_NAME;
    } catch (_) {
        return STAFF_DEFAULT_NAME;
    }
}

/**
 * STAFF-FROM-SLOTS: unica fuente de personal asignable. Se deriva de los
 * recursos que Wix declara disponibles en los slots ya consultados.
 * ServiciosCatalogo.availableStaff y la coleccion MapaStaff no existen.
 */
async function _getStaffOptionsFromSlots(slots) {
    const list = Array.isArray(slots) ? slots : [];
    const collected = [];
    for (const slot of list) {
        for (const rid of _getResourceIdsFromSlot(slot)) collected.push(rid);
    }
    const resourceIds = Array.from(new Set(collected.filter(_looksLikeGuid)));
    const options = await Promise.all(
        resourceIds.map(async function (resourceId) {
            const name = await _getStaffDisplayNamePublic(resourceId);
            return {
                resourceId: resourceId,
                id: resourceId,
                value: resourceId,
                name: name,
                label: name
            };
        })
    );
    options.sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
    return options;
}

function _staffIdsFromOptions(staffOptions) {
    return (Array.isArray(staffOptions) ? staffOptions : [])
        .map(function (option) { return option.resourceId; })
        .filter(Boolean);
}

function _getRequestedAddonContext(service, requestedAddonIds) {
    const requested = new Set(
        (Array.isArray(requestedAddonIds) ? requestedAddonIds : [])
            .map(function (id) { return _safeTrim(id); })
            .filter(Boolean)
    );
    const addOnOptions = Array.isArray(service && service.addOnOptions)
        ? service.addOnOptions
        : [];
    const selected = addOnOptions.filter(function (addon) {
        const id = _safeTrim(addon && addon.addOnId);
        const nativeId = _safeTrim(addon && addon.nativeId);
        return requested.has(id) || requested.has(nativeId);
    });
    const nativeIds = selected
        .map(function (addon) {
            return _safeTrim((addon && addon.nativeId) || (addon && addon.addOnId));
        })
        .filter(function (id) { return _looksLikeGuid(id); });
    return {
        nativeAddonIds: Array.from(new Set(nativeIds)),
        addOnOptions: selected
    };
}

function _resolveAddonContextInternal(service, requestedAddonIds) {
    return _getRequestedAddonContext(service, requestedAddonIds);
}

async function _verifyRequiredStaffViaGet(params) {
    const getPayload = {
        serviceId: String(params.serviceId),
        localStartDate: params.start,
        localEndDate: params.end,
        location: _buildLocationTS(),
        timeZone: SDK_CONFIG.TZ,
        resourceTypes: [
            { resourceTypeId: STAFF_RESOURCE_TYPE_ID, resourceIds: [params.requiredResourceId] }
        ]
    };
    if (Array.isArray(params.nativeAddonIds) && params.nativeAddonIds.length > 0) {
        getPayload.customerChoices = { addOnIds: params.nativeAddonIds };
    }
    try {
        const result = await _executeWithRetry(
            function () {
                return withTimeout(
                    function () { return availabilityTimeSlots.getAvailabilityTimeSlot(getPayload); },
                    WATCHDOG_TIMEOUT_MS,
                    "exactSlot:verifyStaffGet"
                );
            },
            2,
            300
        );
        if (result && result.timeSlot) {
            return { ok: true, slot: result.timeSlot, errorCode: null };
        }
        return { ok: false, slot: null, errorCode: "STAFF_UNAVAILABLE" };
    } catch (error) {
        log.warn("getAvailabilityTimeSlot verification failed", {
            traceId: params.traceId,
            serviceId: String(params.serviceId),
            requiredResourceId: params.requiredResourceId,
            message: error && error.message
        });
        return { ok: false, slot: null, errorCode: "STAFF_UNAVAILABLE" };
    }
}

// ============================================================================
// SERVICE CATALOG
// ============================================================================
export async function _getServiceBySlugOrIdInternal(slugOrId, externalTraceId) {
    const traceId = externalTraceId || makeTraceId("service");
    const raw = _safeTrim(slugOrId);

    // UNICODE-SLUG: se conserva el valor exacto (ñ, tildes). Solo se retiran
    // query, fragmento y barras de borde. Nunca se normalizan caracteres.
    const clean = raw
        ? String(raw)
            .split("?")[0]
            .split("#")[0]
            .replace(/^\/+/, "")
            .replace(/\/+$/, "")
        : "";

    if (!clean) {
        return {
            status: "ERROR",
            data: null,
            error: { code: "SERVICE_NOT_FOUND", message: "Service identifier is required." }
        };
    }

    const cached = serviceCatalogRAM.get(clean);
    if (cached && Date.now() - cached.timestamp < SERVICE_CACHE_TTL_MS) {
        return { status: "SUCCESS", data: cached.data, error: null };
    }

    try {
        // Busqueda canonica unica. Sin rama servicioID (campo inexistente).
        const service = await withTimeout(
            function () {
                return queryFirstItem({
                    dataCollectionId: SERVICIOS_COL,
                    filter: {
                        $or: [
                            { serviceId: { $eq: clean } },
                            { slug: { $eq: clean } },
                            { _id: { $eq: clean } }
                        ]
                    },
                    consistency: CONSISTENCY.STRONG
                });
            },
            WATCHDOG_TIMEOUT_MS,
            "getServiceBySlugOrId:unified"
        );

        if (!service) {
            log.error("Service not found in catalog", { key: clean, traceId: traceId });
            return {
                status: "ERROR",
                data: null,
                error: { code: "SERVICE_NOT_FOUND", message: "Service not found." }
            };
        }

        const mapped = await _mapServiceImport2ToUX(_normalizeCatalogService(service), traceId);
        const cacheEntry = { data: mapped, timestamp: Date.now() };
        _cacheSetBounded(serviceCatalogRAM, clean, cacheEntry, CACHE_MAX_SIZE);
        if (mapped.serviceId) {
            _cacheSetBounded(serviceCatalogRAM, mapped.serviceId, cacheEntry, CACHE_MAX_SIZE);
        }
        if (mapped.slug) {
            _cacheSetBounded(serviceCatalogRAM, mapped.slug, cacheEntry, CACHE_MAX_SIZE);
        }
        return { status: "SUCCESS", data: mapped, error: null };
    } catch (error) {
        log.error("Error loading service", {
            traceId: traceId,
            message: error && error.message
        });
        return {
            status: "ERROR",
            data: null,
            error: {
                code: "DATABASE_ERROR",
                message: (error && error.message) || "Error loading service."
            }
        };
    }
}

export async function _resolveServiceIdInternal(serviceIdReq) {
    const raw = _safeTrim(serviceIdReq);
    if (!raw) return null;
    const key = _looksLikeGuid(raw) ? raw : raw;
    if (!key) return null;
    const result = await _getServiceBySlugOrIdInternal(key);
    if (result && result.status === "SUCCESS" && result.data && result.data.serviceId) {
        const serviceId = _safeTrim(result.data.serviceId);
        if (_looksLikeGuid(serviceId)) return serviceId;
    }
    return null;
}

/**
 * STAFF-FROM-SLOTS: availableStaff/staffOptions salen VACIOS del catalogo.
 * Se pueblan en getAvailableSlots / getCertifiedDualSlots con los recursos
 * que Bookings declara disponibles para esa fecha, servicio y complementos.
 */
export async function _mapServiceImport2ToUX(service, traceId) {
    const serviceId = _safeTrim(_readServiceField(service, "serviceId"));
    if (!_looksLikeGuid(serviceId)) {
        throw new Error("Catalog serviceId is missing or invalid.");
    }

    const clientHidden = _readServiceField(service, "clientHidden") === true;
    const allowCombine = !clientHidden && _readServiceField(service, "allowCombine") === true;
    const linkedPhases = _safeTrim(_readServiceField(service, "linkedPhases"));

    if (allowCombine && !_looksLikeGuid(linkedPhases)) {
        throw new Error("Dual service linkedPhases is missing or invalid.");
    }
    if (allowCombine && linkedPhases === serviceId) {
        throw new Error("A service cannot link to itself (linkedPhases === serviceId).");
    }

    const phase1Duration = Number(_readServiceField(service, "phase1Duration")) || 0;
    const exposureDuration = Number(_readServiceField(service, "exposureDuration")) || 0;
    let phase2Duration = Number(_readServiceField(service, "phase2Duration")) || 0;

    if (allowCombine && _looksLikeGuid(linkedPhases)) {
        const visited = new Set([serviceId]);
        const resolved = await resolveLinkedPhase2Duration(
            linkedPhases,
            traceId,
            visited,
            _getServiceBySlugOrIdInternal
        );
        if (resolved > 0) phase2Duration = resolved;
    }

    const title = _safeTrim(_readServiceField(service, "title")) || "Service";
    const price = Number(_readServiceField(service, "price")) || 0;
    const currency = _safeTrim(_readServiceField(service, "currency")) || "EUR";
    const pricingModel = _safeTrim(_readServiceField(service, "pricingModel")) || null;
    const slug = _safeTrim(_readServiceField(service, "slug")) || "";
    const serviceType = _safeTrim(_readServiceField(service, "serviceType")) || null;
    const sku = _safeTrim(_readServiceField(service, "sku")) || null;
    const depositAmount = Number(_readServiceField(service, "depositAmount")) || 0;
    const depositType = _safeTrim(_readServiceField(service, "depositType")) || null;
    const onlinePayment = _readServiceField(service, "onlinePayment") === true;
    const inPersonPayment = _readServiceField(service, "inPersonPayment") === true;
    const taxIncluded = _readServiceField(service, "taxIncluded") === true;
    const tipoImpositivo = Number(_readServiceField(service, "tipoImpositivo")) || 0;
    const categoryId = _safeTrim(_readServiceField(service, "categoryId")) || null;
    const locationId = _safeTrim(_readServiceField(service, "locationId")) || null;
    const location = _safeTrim(_readServiceField(service, "location")) || null;
    const mainMedia = _safeTrim(_readServiceField(service, "mainMedia")) || "";
    const shortDescription = _safeTrim(_readServiceField(service, "tagLine")) || null;
    const longDescription = _safeTrim(_readServiceField(service, "description")) || null;
    const internalNotes = _safeTrim(_readServiceField(service, "internalNotes")) || null;
    const recommendations = Array.isArray(_readServiceField(service, "recommendations"))
        ? _readServiceField(service, "recommendations")
        : [];
    const durationRange = readDurationRange(service);

    const phaseSum = allowCombine
        ? phase1Duration + exposureDuration + phase2Duration
        : phase1Duration;
    const estimatedTotal = phaseSum;

    const addOnOptions = (Array.isArray(_readServiceField(service, "addOnOptions"))
        ? _readServiceField(service, "addOnOptions")
        : []
    )
        .map(_normalizeAddon)
        .filter(Boolean);

    return {
        serviceId: serviceId,
        slug: slug,
        serviceType: serviceType,
        sku: sku,
        categoryId: categoryId,
        locationId: locationId,
        localizacion: location,
        internalNotes: internalNotes,
        permitirCombinar: allowCombine,
        tiempoFase1: phase1Duration,
        tiempoExposicion: exposureDuration,
        tiempoFase2: phase2Duration,
        duracionTotal: estimatedTotal,
        // STAFF-FROM-SLOTS: vacios aqui. Se pueblan desde los slots.
        availableStaff: [],
        staffOptions: [],
        depositAmount: depositAmount,
        depositType: depositType,
        onlinePayment: onlinePayment,
        inPersonPayment: inPersonPayment,
        taxIncluded: taxIncluded,
        tipoImpositivo: tipoImpositivo,
        pricingModel: pricingModel,
        currency: currency,
        linkedPhases: allowCombine ? linkedPhases : null,
        allowCombine: allowCombine,
        phase1Duration: phase1Duration,
        exposureDuration: exposureDuration,
        phase2Duration: phase2Duration,
        totalDuration: estimatedTotal,
        clientHidden: clientHidden,
        durationRange: durationRange,
        addOnOptions: addOnOptions,
        recommendations: recommendations,
        mainMedia: mainMedia,
        metadata: {
            titulo: title,
            tituloServicio: title,
            precio: price,
            duracionTotal: estimatedTotal,
            localizacion: location,
            resumenCorto: shortDescription,
            descripcionLarga: longDescription,
            pricingModel: pricingModel,
            addOnOptions: addOnOptions,
            recomendaciones: recommendations,
            mainMedia: mainMedia,
            currency: currency,
            tipoImpositivo: tipoImpositivo,
            pricing: { base: price, currency: currency },
            timing: { estimatedTotal: estimatedTotal, totalDuration: estimatedTotal },
            durationRange: durationRange
        }
    };
}

export async function getServiceForBookingInternal(serviceId, traceId) {
    return _getServiceBySlugOrIdInternal(
        serviceId,
        traceId || makeTraceId("service-internal")
    );
}

// ============================================================================
// WEB METHODS - SERVICE
// ============================================================================
export const getServiceBySlugOrId = webMethod(
    Permissions.Anyone,
    async function (slugOrId) {
        const traceId = makeTraceId("wm-service");
        try {
            const result = await _getServiceBySlugOrIdInternal(slugOrId, traceId);
            if (!result || result.status !== "SUCCESS") return result;
            return {
                status: "SUCCESS",
                data: _toPublicService(result.data),
                error: null
            };
        } catch (error) {
            return {
                status: "ERROR",
                data: null,
                error: _toPublicError(error, "SERVICE_LOOKUP_FAILED")
            };
        }
    }
);

export const resolveServiceId = webMethod(
    Permissions.Anyone,
    async function (serviceIdRequest) {
        try {
            const resolved = await _resolveServiceIdInternal(serviceIdRequest);
            if (!resolved) {
                return {
                    status: "ERROR",
                    data: null,
                    error: { code: "SERVICE_NOT_FOUND", message: "Service identifier not found." }
                };
            }
            return { status: "SUCCESS", data: String(resolved), error: null };
        } catch (error) {
            return {
                status: "ERROR",
                data: null,
                error: _toPublicError(error, "SERVICE_RESOLVE_FAILED")
            };
        }
    }
);

export function _toPublicService(service) {
    if (!service || typeof service !== "object") return null;
    const publicService = Object.assign({}, service);
    // Biblia 0.5.8 / 15.1: nunca salen notas internas ni datos de margen.
    delete publicService.internalNotes;
    publicService.linkedPhases = publicService.linkedPhases || null;
    return publicService;
}

// ============================================================================
// CONFIRMATION PAGE READ
// ============================================================================
// FIX-DTO-CONFIRM: claves sin espacio final y totalAmount (campo real de
// CitasF2, Biblia 5.4). "totalPrice" no existe en el esquema.
const _CONFIRMATION_DTO_FIELDS = Object.freeze([
    "bookingId",
    "serviceId",
    "dateYmd",
    "slotStart",
    "slotEnd",
    "resourceId",
    "pairToken",
    "totalAmount"
]);

function _toConfirmationDto(item) {
    if (!item || typeof item !== "object") return null;
    const dto = {};
    for (const key of _CONFIRMATION_DTO_FIELDS) {
        if (item[key] !== undefined && item[key] !== null) dto[key] = item[key];
    }
    const rawStatus = item[BOOKING_FIELDS.STATUS];
    if (rawStatus === undefined || rawStatus === null) {
        if (item.status !== undefined && item.status !== null) {
            dto.bookingStatus = normalizeBookingStatus(item.status);
        }
    } else {
        dto.bookingStatus = normalizeBookingStatus(rawStatus);
    }
    if (item.paymentStatus !== undefined) dto.paymentStatus = item.paymentStatus;
    return dto;
}

export const getConfirmedBookingForDisplay = webMethod(
    Permissions.Anyone,
    async function (params) {
        const traceId = makeTraceId("confirmacion-booking");
        const cleanId = _safeTrim(params && params.bookingId);
        if (!cleanId) {
            return { ok: false, data: null, error: "BOOKING_ID_REQUIRED" };
        }
        try {
            const item = await withTimeout(
                function () {
                    return queryFirstItem({
                        dataCollectionId: BUSINESS_COLLECTIONS.CITAS_F2,
                        filter: { bookingId: { $eq: cleanId } },
                        consistency: CONSISTENCY.STRONG
                    });
                },
                Number(SDK_CONFIG && SDK_CONFIG.TIMEOUTS && SDK_CONFIG.TIMEOUTS.API_MS) || 15000,
                "getConfirmedBookingForDisplay"
            );
            if (!item) return { ok: false, data: null, error: "NOT_FOUND" };
            const rawStatus = item[BOOKING_FIELDS.STATUS];
            const status = normalizeBookingStatus(
                rawStatus !== undefined && rawStatus !== null ? rawStatus : item.status
            );
            if (status !== BOOKING_STATUS.CONFIRMED && status !== BOOKING_STATUS.PENDING) {
                return { ok: false, data: null, error: "NOT_CONFIRMED" };
            }
            return { ok: true, data: _toConfirmationDto(item), error: null };
        } catch (err) {
            log.warn("getConfirmedBookingForDisplay failed", {
                traceId: traceId,
                error: err && err.message
            });
            return { ok: false, data: null, error: "READ_FAILED" };
        }
    }
);

// ============================================================================
// DISPONIBILIDAD SINGLE
// ============================================================================
export const getAvailableSlots = webMethod(
    Permissions.Anyone,
    async function (serviceIdOrSlug, resourceId, dateYmd, addOnIds) {
        const traceId = makeTraceId("available-slots");
        try {
            const serviceResult = await _getServiceBySlugOrIdInternal(serviceIdOrSlug, traceId);
            if (!serviceResult || serviceResult.status !== "SUCCESS" || !serviceResult.data || !serviceResult.data.serviceId) {
                return {
                    status: "ERROR",
                    data: null,
                    error: { code: "SERVICE_NOT_FOUND", message: "Service not found." }
                };
            }
            const service = serviceResult.data;
            const serviceId = service.serviceId;

            if (service.allowCombine === true) {
                log.warn("getAvailableSlots called for dual service", {
                    traceId: traceId,
                    serviceId: String(serviceId)
                });
                return {
                    status: "ERROR",
                    data: null,
                    error: {
                        code: "SERVICE_IS_DUAL",
                        message: "Use getCertifiedDualSlots for dual services."
                    }
                };
            }

            const requestedResourceId = _normalizeResourceIds(resourceId, traceId);
            const addonContext = _resolveAddonContextInternal(
                service,
                Array.isArray(addOnIds) ? addOnIds : []
            );

            if (addonContext.nativeAddonIds.length > 0 && service.durationRange) {
                return {
                    status: "ERROR",
                    data: null,
                    error: {
                        code: "DURATION_RANGE_WITH_ADDONS_NOT_SUPPORTED",
                        message: "Services with a duration range cannot be combined with addons."
                    }
                };
            }

            const ymd = _safeTrim(dateYmd);
            if (!_isValidMadridYmd(ymd)) {
                return {
                    status: "ERROR",
                    data: null,
                    error: { code: "INVALID_DATE", message: "Invalid booking date." }
                };
            }

            const payload = {
                serviceId: String(serviceId),
                fromLocalDate: ymd + "T00:00:00",
                toLocalDate: ymd + "T23:59:59",
                timeZone: SDK_CONFIG.TZ,
                bookable: true,
                locations: [_buildLocationTS()],
                includeResourceTypeIds: [STAFF_RESOURCE_TYPE_ID]
            };
            if (requestedResourceId.length > 0) {
                payload.resourceTypes = [
                    { resourceTypeId: STAFF_RESOURCE_TYPE_ID, resourceIds: requestedResourceId }
                ];
            }
            if (addonContext.nativeAddonIds.length > 0) {
                payload.customerChoices = { addOnIds: addonContext.nativeAddonIds };
            }

            const result = await _executeWithRetry(
                function () {
                    return withTimeout(
                        function () { return availabilityTimeSlots.listAvailabilityTimeSlots(payload); },
                        WATCHDOG_TIMEOUT_MS,
                        "getAvailableSlots"
                    );
                },
                2,
                300
            );

            const timeSlots = Array.isArray(result && result.timeSlots) ? result.timeSlots : [];
            const slots = timeSlots
                .filter(function (slot) { return slot && slot.bookable === true; })
                .map(function (slot) { return _attachServiceId(slot, serviceId, traceId, "getAvailableSlots"); })
                .filter(Boolean);

            // STAFF-FROM-SLOTS: solo personal con disponibilidad real.
            const staffOptions = await _getStaffOptionsFromSlots(slots);

            return {
                status: "SUCCESS",
                data: {
                    slots: slots,
                    serviceId: serviceId,
                    dateYmd: ymd,
                    resourceId: requestedResourceId[0] || null,
                    availableStaff: _staffIdsFromOptions(staffOptions),
                    staffOptions: staffOptions
                },
                error: null
            };
        } catch (error) {
            log.warn("getAvailableSlots failed", {
                traceId: traceId,
                serviceIdOrSlug: _safeTrim(serviceIdOrSlug),
                dateYmd: _safeTrim(dateYmd),
                message: error && error.message
            });
            return {
                status: "ERROR",
                data: null,
                error: {
                    code: "AVAILABLE_SLOTS_FAILED",
                    message: "Could not load available slots."
                }
            };
        }
    }
);

// ============================================================================
// DISPONIBILIDAD DIAS
// ============================================================================
export const getAvailableDays = webMethod(
    Permissions.Anyone,
    async function (serviceIdOrSlug, resourceId, year, month, addOnIds) {
        const traceId = makeTraceId("available-days");
        try {
            const serviceResult = await _getServiceBySlugOrIdInternal(serviceIdOrSlug, traceId);
            if (!serviceResult || serviceResult.status !== "SUCCESS" || !serviceResult.data || !serviceResult.data.serviceId) {
                return {
                    status: "ERROR",
                    data: null,
                    error: { code: "SERVICE_NOT_FOUND", message: "Service not found." }
                };
            }
            const service = serviceResult.data;
            const serviceId = service.serviceId;
            const y = Number(year);
            const m = Number(month);

            if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) {
                return {
                    status: "ERROR",
                    data: null,
                    error: { code: "INVALID_DATE", message: "Invalid year/month." }
                };
            }

            const monthStr = String(m).padStart(2, "0");
            const fromDate = y + "-" + monthStr + "-01T00:00:00";
            const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
            const toDate = y + "-" + monthStr + "-" + String(lastDay).padStart(2, "0") + "T23:59:59";
            const requestedResourceId = _normalizeResourceIds(resourceId, traceId);
            const addonContext = _resolveAddonContextInternal(
                service,
                Array.isArray(addOnIds) ? addOnIds : []
            );

            const payload = {
                serviceId: String(serviceId),
                fromLocalDate: fromDate,
                toLocalDate: toDate,
                timeZone: SDK_CONFIG.TZ,
                bookable: true,
                locations: [_buildLocationTS()],
                includeResourceTypeIds: [STAFF_RESOURCE_TYPE_ID]
            };
            if (requestedResourceId.length > 0) {
                payload.resourceTypes = [
                    { resourceTypeId: STAFF_RESOURCE_TYPE_ID, resourceIds: requestedResourceId }
                ];
            }
            if (addonContext.nativeAddonIds.length > 0 && !service.durationRange) {
                payload.customerChoices = { addOnIds: addonContext.nativeAddonIds };
            }

            const result = await _executeWithRetry(
                function () {
                    return withTimeout(
                        function () { return availabilityTimeSlots.listAvailabilityTimeSlots(payload); },
                        WATCHDOG_TIMEOUT_MS,
                        "getAvailableDays"
                    );
                },
                2,
                300
            );

            const timeSlots = Array.isArray(result && result.timeSlots) ? result.timeSlots : [];
            const daySet = new Set();
            for (const slot of timeSlots) {
                if (!slot || slot.bookable !== true) continue;
                const localStart = _normalizeLocalIsoStr(slot.localStartDate || slot.startDate);
                if (!localStart) continue;
                daySet.add(localStart.slice(0, 10));
            }

            log.info("getAvailableDays computed", {
                traceId: traceId,
                serviceId: serviceId,
                year: y,
                month: m,
                timeSlotCount: timeSlots.length,
                dayCount: daySet.size
            });

            return {
                status: "SUCCESS",
                data: {
                    days: Array.from(daySet).sort(),
                    serviceId: serviceId,
                    year: y,
                    month: m,
                    resourceId: requestedResourceId[0] || null
                },
                error: null
            };
        } catch (error) {
            log.error("getAvailableDays failed", {
                traceId: traceId,
                serviceKey: _safeTrim(serviceIdOrSlug),
                resourceId: _safeTrim(resourceId) || null,
                year: Number(year),
                month: Number(month),
                errorName: error && error.name,
                errorCode: error && error.code,
                message: error && error.message,
                stack: error && error.stack
            });
            return {
                status: "ERROR",
                data: null,
                error: {
                    code: "AVAILABLE_DAYS_FAILED",
                    message: "Could not load available days.",
                    traceId: traceId
                }
            };
        }
    }
);

// ============================================================================
// STAFF LOAD COUNTS FOR DAY (CITAS_F2)
// ============================================================================
async function _countStaffLoadForDay(dateYmd, resourceIds, traceId) {
    const ymd = _safeTrim(dateYmd);
    const ids = cleanGuidList(resourceIds);
    const loadByResource = {};
    for (const id of ids) loadByResource[id] = 0;
    if (!ymd || ids.length === 0) return loadByResource;

    const idSet = new Set(ids);
    try {
        const result = await withTimeout(
            function () {
                return queryItems({
                    dataCollectionId: BUSINESS_COLLECTIONS.CITAS_F2,
                    filter: { dateYmd: { $eq: ymd } },
                    limit: STAFF_LOAD_QUERY_LIMIT,
                    consistency: CONSISTENCY.STRONG
                });
            },
            WATCHDOG_TIMEOUT_MS,
            "staffLoad:countDay"
        );
        const items = (result && Array.isArray(result.items)) ? result.items : [];
        for (const item of items) {
            const rawStatus = item && item.bookingStatus;
            if (rawStatus === undefined || rawStatus === null) {
                log.warn("CitasF2 row without bookingStatus (legacy status), migrate before EOL", {
                    id: item && item._id
                });
            }
            const status = String((item && (item.bookingStatus || item.status)) || "").trim().toUpperCase();
            // Enum CMS (Biblia 6.2): CANCELLED con doble L. Se tolera CANCELED
            // nativo Wix solo en lectura de filas legacy.
            if (status === "CANCELLED" || status === "CANCELED" || status === "NO_SHOW") continue;
            const itemResourceId = _safeTrim(item && item.resourceId);
            if (!itemResourceId || !idSet.has(itemResourceId)) continue;
            loadByResource[itemResourceId] = (loadByResource[itemResourceId] || 0) + 1;
        }
    } catch (error) {
        log.warn("_countStaffLoadForDay failed; using zero loads", {
            traceId: traceId,
            dateYmd: ymd,
            message: error && error.message
        });
    }
    return loadByResource;
}

// ============================================================================
// DISPONIBILIDAD DUAL (D3: emite pairToken canonico)
// ============================================================================
export async function _getCertifiedDualSlotsInternal(serviceId, resourceId, dateYmd, addOnIds) {
    const traceId = makeTraceId("dual-slots");
    const serviceRes = await _getServiceBySlugOrIdInternal(serviceId, traceId);
    if (!serviceRes || serviceRes.status !== "SUCCESS" || !serviceRes.data) {
        return {
            status: "ERROR",
            data: null,
            error: { code: "SERVICE_NOT_FOUND", message: "Service not found." }
        };
    }
    const service = serviceRes.data;
    if (service.allowCombine !== true || !_looksLikeGuid(service.linkedPhases)) {
        return {
            status: "ERROR",
            data: null,
            error: { code: "SERVICE_NOT_DUAL", message: "Service is not configured as dual." }
        };
    }
    const ymd = _safeTrim(dateYmd);
    if (!_isValidMadridYmd(ymd)) {
        return {
            status: "ERROR",
            data: null,
            error: { code: "INVALID_DATE", message: "Invalid booking date." }
        };
    }
    const requestedResourceId = _normalizeResourceIds(resourceId, traceId);
    const addonContext = _resolveAddonContextInternal(
        service,
        Array.isArray(addOnIds) ? addOnIds : []
    );
    if (addonContext.nativeAddonIds.length > 0 && service.durationRange) {
        return {
            status: "ERROR",
            data: null,
            error: {
                code: "DURATION_RANGE_WITH_ADDONS_NOT_SUPPORTED",
                message: "Services with a duration range cannot be combined with addons."
            }
        };
    }

    const buildListPayload = function (svcId) {
        const payload = {
            serviceId: String(svcId),
            fromLocalDate: ymd + "T00:00:00",
            toLocalDate: ymd + "T23:59:59",
            timeZone: SDK_CONFIG.TZ,
            bookable: true,
            locations: [_buildLocationTS()],
            includeResourceTypeIds: [STAFF_RESOURCE_TYPE_ID]
        };
        if (requestedResourceId.length > 0) {
            payload.resourceTypes = [
                { resourceTypeId: STAFF_RESOURCE_TYPE_ID, resourceIds: requestedResourceId }
            ];
        }
        if (addonContext.nativeAddonIds.length > 0) {
            payload.customerChoices = { addOnIds: addonContext.nativeAddonIds };
        }
        return payload;
    };

    const f1Res = await _executeWithRetry(
        function () {
            return withTimeout(
                function () {
                    return availabilityTimeSlots.listAvailabilityTimeSlots(buildListPayload(service.serviceId));
                },
                WATCHDOG_TIMEOUT_MS,
                "dual:listF1"
            );
        },
        2,
        300
    );
    const f1Slots = (Array.isArray(f1Res && f1Res.timeSlots) ? f1Res.timeSlots : [])
        .filter(function (s) { return s && s.bookable === true; });

    const f2Res = await _executeWithRetry(
        function () {
            return withTimeout(
                function () {
                    return availabilityTimeSlots.listAvailabilityTimeSlots(buildListPayload(service.linkedPhases));
                },
                WATCHDOG_TIMEOUT_MS,
                "dual:listF2"
            );
        },
        2,
        300
    );
    const f2Slots = (Array.isArray(f2Res && f2Res.timeSlots) ? f2Res.timeSlots : [])
        .filter(function (s) { return s && s.bookable === true; });

    // STAFF-FROM-SLOTS: el pool sale de los recursos reales de F1 y F2.
    const poolSet = new Set();
    for (const slot of [].concat(f1Slots, f2Slots)) {
        for (const rid of _getResourceIdsFromSlot(slot)) poolSet.add(rid);
    }
    const staffPool = Array.from(poolSet);
    const loadByResource = await _countStaffLoadForDay(ymd, staffPool, traceId);

    const pairs = [];
    for (const f1 of f1Slots) {
        const f1Start = _normalizeLocalIsoStr(f1.localStartDate || f1.startDate);
        const f1End = _normalizeLocalIsoStr(f1.localEndDate || f1.endDate);
        if (!f1Start || !f1End) continue;
        const range = toUtcRange(f1Start, f1End);
        if (!range) continue;
        const f1Resources = _getResourceIdsFromSlot(f1);
        if (f1Resources.length === 0) continue;

        for (const f2 of f2Slots) {
            const f2Start = _normalizeLocalIsoStr(f2.localStartDate || f2.startDate);
            const f2End = _normalizeLocalIsoStr(f2.localEndDate || f2.endDate);
            if (!f2Start || !f2End) continue;
            const f2StartUtc = getUtcDateFromMadridLocal(f2Start);
            if (!f2StartUtc) continue;
            const gapMinutes = computeGapMinutes(range.endUtc, f2StartUtc);
            if (gapMinutes === null || gapMinutes < 0 || gapMinutes > MINUTOS_MAX_HUECO_DUAL) continue;
            const f2Resources = _getResourceIdsFromSlot(f2);
            const shared = f1Resources.filter(function (id) { return f2Resources.indexOf(id) >= 0; });
            if (shared.length === 0) continue;

            const pairResourceId = (requestedResourceId[0] && shared.indexOf(requestedResourceId[0]) >= 0)
                ? requestedResourceId[0]
                : (pickStaffByLowestLoad(shared, loadByResource) || shared[0]);

            /**
             * D3-PAIRTOKEN: huella identica a la de bookingSaga (SAGA-02).
             * dateYmd se deriva de f1Start (no del parametro de consulta) para
             * que ambos lados calculen el mismo valor. Los 8 campos y su
             * normalizacion son el contrato CORE-05.
             */
            const pairToken = _buildPairTokenDeterministic({
                serviceId: service.serviceId,
                linkedPhases: service.linkedPhases,
                dateYmd: f1Start.slice(0, 10),
                f1Start: f1Start,
                f1End: f1End,
                f2Start: f2Start,
                f2End: f2End,
                resourceId: pairResourceId
            });

            pairs.push({
                fase1: {
                    slotRef: Object.assign({}, _normalizeSlotShape(f1), { serviceId: service.serviceId }),
                    resourceId: pairResourceId
                },
                fase2: {
                    slotRef: Object.assign({}, _normalizeSlotShape(f2), { serviceId: service.linkedPhases }),
                    resourceId: pairResourceId
                },
                pairToken: pairToken,
                serviceId: service.serviceId,
                linkedPhases: service.linkedPhases,
                dateYmd: ymd,
                gapMinutes: gapMinutes,
                exposureDuration: Number(service.exposureDuration || 0) || 0
            });
        }
    }

    // D3-STAFF-DUAL: personal con par certificado real para este dia.
    const dualStaffIds = Array.from(new Set(
        pairs.map(function (pair) { return pair.fase1.resourceId; }).filter(Boolean)
    ));
    const staffOptions = await Promise.all(
        dualStaffIds.map(async function (rid) {
            const name = await _getStaffDisplayNamePublic(rid);
            return { resourceId: rid, id: rid, value: rid, name: name, label: name };
        })
    );
    staffOptions.sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });

    log.info("getCertifiedDualSlots computed", {
        traceId: traceId,
        serviceId: service.serviceId,
        dateYmd: ymd,
        f1Count: f1Slots.length,
        f2Count: f2Slots.length,
        pairCount: pairs.length,
        staffCount: staffOptions.length
    });

    return {
        status: "SUCCESS",
        data: pairs,
        staffOptions: staffOptions,
        availableStaff: _staffIdsFromOptions(staffOptions),
        error: null,
        traceId: traceId
    };
}

export const getCertifiedDualSlots = webMethod(
    Permissions.Anyone,
    async function (serviceIdOrSlug, resourceId, dateYmd, addOnIds) {
        try {
            const resolved = await _resolveServiceIdInternal(serviceIdOrSlug);
            if (!resolved) {
                return {
                    status: "ERROR",
                    data: null,
                    error: { code: "SERVICE_NOT_FOUND", message: "Service identifier not found." }
                };
            }
            return await _getCertifiedDualSlotsInternal(resolved, resourceId, dateYmd, addOnIds);
        } catch (error) {
            return {
                status: "ERROR",
                data: null,
                error: _toPublicError(error, "DUAL_SLOTS_FAILED")
            };
        }
    }
);

// ============================================================================
// RESOLUCION DE STAFF
// ============================================================================
export async function _resolveStaffForSlotInternal(params) {
    const activeTraceId = params.traceId || makeTraceId("staff-resolve");
    const resolved = await _resolveServiceIdInternal(params.serviceId);
    if (!resolved) {
        return {
            status: "ERROR",
            data: null,
            error: { code: "SERVICE_NOT_FOUND", message: "Service identifier not found." }
        };
    }
    const normalizedAddonIds = Array.from(new Set(
        (Array.isArray(params.addOnIds) ? params.addOnIds : [])
            .map(function (id) { return _safeTrim(id); })
            .filter(function (id) { return _looksLikeGuid(id); })
    )).sort();

    const f1Result = await revalidateExactAvailabilitySlot({
        serviceId: resolved,
        localStartDate: params.f1Start,
        localEndDate: params.f1End,
        resourceId: params.requestedResourceId || null,
        nativeAddonIds: normalizedAddonIds,
        traceId: activeTraceId
    });
    if (!f1Result || f1Result.status !== "SUCCESS") return f1Result;

    const finalResourceId = (f1Result.data && f1Result.data.resourceId) || params.requestedResourceId || null;
    let f2Result = null;

    if (params.f2Start && params.f2End) {
        const serviceConfig = await _getServiceBySlugOrIdInternal(resolved, activeTraceId);
        const linkedPhases = _safeTrim(
            serviceConfig && serviceConfig.data && serviceConfig.data.linkedPhases
        );
        if (!_looksLikeGuid(linkedPhases)) {
            return {
                status: "ERROR",
                data: null,
                error: {
                    code: "INVALID_PAYLOAD",
                    message: "Dual requested but service has no linkedPhases."
                }
            };
        }
        f2Result = await revalidateExactAvailabilitySlot({
            serviceId: linkedPhases,
            localStartDate: params.f2Start,
            localEndDate: params.f2End,
            resourceId: finalResourceId,
            nativeAddonIds: normalizedAddonIds,
            traceId: activeTraceId
        });
        if (!f2Result || f2Result.status !== "SUCCESS") return f2Result;
    }

    const staffOptions = await _getStaffOptionsFromSlots(
        [f1Result.data.slot, f2Result && f2Result.data ? f2Result.data.slot : null].filter(Boolean)
    );

    return {
        status: "SUCCESS",
        data: {
            resourceId: finalResourceId,
            slotF1: (f1Result.data && f1Result.data.slot) || null,
            slotF2: (f2Result && f2Result.data && f2Result.data.slot) || null,
            candidateResourceIds: (f1Result.data && f1Result.data.candidateResourceIds) || [],
            staffOptions: staffOptions
        },
        error: null
    };
}

export const resolveStaffForSlot = webMethod(
    Permissions.Anyone,
    async function (serviceIdOrSlug, start, resourceId, addOnIds, end) {
        try {
            const resolved = await _resolveServiceIdInternal(serviceIdOrSlug);
            if (!resolved) {
                return {
                    status: "ERROR",
                    data: null,
                    error: { code: "SERVICE_NOT_FOUND", message: "Service identifier not found." }
                };
            }
            return await _resolveStaffForSlotInternal({
                serviceId: resolved,
                f1Start: start,
                f1End: end || null,
                f2Start: null,
                f2End: null,
                requestedResourceId: resourceId,
                addOnIds: Array.isArray(addOnIds) ? addOnIds : [],
                traceId: makeTraceId("staff-resolve-wm")
            });
        } catch (error) {
            return {
                status: "ERROR",
                data: null,
                error: _toPublicError(error, "STAFF_RESOLVE_FAILED")
            };
        }
    }
);

// ============================================================================
// INVALIDACION DE CACHES
// ============================================================================
export async function _invalidateCachesInternal(serviceId, dateYmd, resourceId, traceId) {
    try {
        const sid = _safeTrim(serviceId);
        if (sid && _looksLikeGuid(sid) && serviceCatalogRAM.has(sid)) {
            serviceCatalogRAM.delete(sid);
        }
        log.info("_invalidateCachesInternal", {
            traceId: traceId,
            serviceId: sid || null,
            dateYmd: _safeTrim(dateYmd) || null,
            resourceId: _safeTrim(resourceId) || null
        });
        return { status: "SUCCESS" };
    } catch (error) {
        log.warn("_invalidateCachesInternal failed", {
            traceId: traceId,
            message: error && error.message
        });
        return { status: "ERROR", error: (error && error.message) || "UNKNOWN" };
    }
}

// ============================================================================
// REVALIDACION EXACTA
// ============================================================================
export async function revalidateExactAvailabilitySlot(params) {
    const activeTraceId = params.traceId || makeTraceId("exact-slot");
    const resolvedServiceId = await _resolveServiceIdInternal(params.serviceId);
    const start = _normalizeLocalIsoStr(params.localStartDate);
    const end = _normalizeLocalIsoStr(params.localEndDate);
    const rawResourceId = _safeTrim(params.resourceId);
    const requiredResourceId = _looksLikeGuid(rawResourceId) ? rawResourceId : "";

    if (!resolvedServiceId || !start || !end || !_isValidSlotRange(start, end)) {
        return {
            status: "ERROR",
            data: null,
            error: { code: "INVALID_SLOT_RECHECK", message: "Selected slot data is invalid." }
        };
    }

    try {
        const normalizedAddonIds = Array.from(new Set(
            (Array.isArray(params.nativeAddonIds) ? params.nativeAddonIds : [])
                .map(function (id) { return _safeTrim(id); })
                .filter(function (id) { return _looksLikeGuid(id); })
        )).sort();

        const earlyServiceConfig = await _getServiceBySlugOrIdInternal(resolvedServiceId, activeTraceId);
        const config = (earlyServiceConfig && earlyServiceConfig.status === "SUCCESS")
            ? earlyServiceConfig.data
            : null;
        const serviceDurationRange = (config && config.durationRange) || null;

        if (normalizedAddonIds.length > 0 && serviceDurationRange) {
            return {
                status: "ERROR",
                data: null,
                error: {
                    code: "DURATION_RANGE_WITH_ADDONS_NOT_SUPPORTED",
                    message: "Services with a duration range cannot be combined with addons.",
                    traceId: activeTraceId
                }
            };
        }

        let rawSlot = null;
        if (normalizedAddonIds.length > 0) {
            const listPayload = {
                serviceId: String(resolvedServiceId),
                fromLocalDate: start,
                toLocalDate: end,
                timeZone: SDK_CONFIG.TZ,
                bookable: true,
                locations: [_buildLocationTS()],
                includeResourceTypeIds: [STAFF_RESOURCE_TYPE_ID],
                customerChoices: { addOnIds: normalizedAddonIds }
            };
            if (requiredResourceId) {
                listPayload.resourceTypes = [
                    { resourceTypeId: STAFF_RESOURCE_TYPE_ID, resourceIds: [requiredResourceId] }
                ];
            }
            const listed = await _executeWithRetry(
                function () {
                    return withTimeout(
                        function () { return availabilityTimeSlots.listAvailabilityTimeSlots(listPayload); },
                        WATCHDOG_TIMEOUT_MS,
                        "exactSlot:list"
                    );
                },
                2,
                300
            );
            const listedSlots = Array.isArray(listed && listed.timeSlots) ? listed.timeSlots : [];
            rawSlot = listedSlots.find(function (slot) {
                const slotStart = _normalizeLocalIsoStr(slot && (slot.localStartDate || slot.startDate));
                const slotEnd = _normalizeLocalIsoStr(slot && (slot.localEndDate || slot.endDate));
                return slotStart === start && slotEnd === end && slot && slot.bookable === true;
            }) || null;
        } else {
            const getPayload = {
                serviceId: String(resolvedServiceId),
                localStartDate: start,
                localEndDate: end,
                location: _buildLocationTS(),
                timeZone: SDK_CONFIG.TZ
            };
            if (requiredResourceId) {
                getPayload.resourceTypes = [
                    { resourceTypeId: STAFF_RESOURCE_TYPE_ID, resourceIds: [requiredResourceId] }
                ];
            }
            const result = await _executeWithRetry(
                function () {
                    return withTimeout(
                        function () { return availabilityTimeSlots.getAvailabilityTimeSlot(getPayload); },
                        WATCHDOG_TIMEOUT_MS,
                        "exactSlot:get"
                    );
                },
                2,
                300
            );
            rawSlot = (result && result.timeSlot) || null;
        }

        if (requiredResourceId) {
            const verification = await _verifyRequiredStaffViaGet({
                serviceId: resolvedServiceId,
                start: start,
                end: end,
                requiredResourceId: requiredResourceId,
                nativeAddonIds: normalizedAddonIds,
                traceId: activeTraceId
            });
            if (!verification.ok) {
                return {
                    status: "ERROR",
                    data: null,
                    error: {
                        code: "STAFF_UNAVAILABLE",
                        message: "Selected staff is no longer available.",
                        traceId: activeTraceId
                    }
                };
            }
            rawSlot = verification.slot;
        } else if (!rawSlot) {
            return {
                status: "ERROR",
                data: null,
                error: {
                    code: "SLOT_UNAVAILABLE",
                    message: "Selected slot is no longer available."
                }
            };
        }

        const normalizedSlot = _attachServiceId(
            rawSlot,
            resolvedServiceId,
            activeTraceId,
            "revalidateExactAvailabilitySlot"
        );
        const availableResourceIds = _getResourceIdsFromSlot(normalizedSlot);

        if (!normalizedSlot || normalizedSlot.bookable !== true || availableResourceIds.length === 0) {
            return {
                status: "ERROR",
                data: null,
                error: {
                    code: "SLOT_UNAVAILABLE",
                    message: "Selected slot is no longer available."
                }
            };
        }
        if (requiredResourceId && availableResourceIds.indexOf(requiredResourceId) < 0) {
            return {
                status: "ERROR",
                data: null,
                error: {
                    code: "STAFF_UNAVAILABLE",
                    message: "Selected staff is no longer available."
                }
            };
        }

        if (config) {
            const startUtc = getUtcDateFromMadridLocal(start);
            const endUtc = getUtcDateFromMadridLocal(end);
            const actualMinutes = _minutesBetweenUtcDates(startUtc, endUtc);
            if (serviceDurationRange && actualMinutes > 0) {
                const belowMin = serviceDurationRange.min > 0 && actualMinutes < serviceDurationRange.min;
                const aboveMax = serviceDurationRange.max !== Infinity && actualMinutes > serviceDurationRange.max;
                if (belowMin || aboveMax) {
                    return {
                        status: "ERROR",
                        data: null,
                        error: {
                            code: "SLOT_DURATION_OUT_OF_RANGE",
                            message: "Selected slot duration is out of the allowed range.",
                            traceId: activeTraceId
                        }
                    };
                }
            } else {
                const expectedMinutes = resolveExpectedSlotMinutes(config);
                if (expectedMinutes > 0 && actualMinutes > 0) {
                    if (Math.abs(actualMinutes - expectedMinutes) > 1) {
                        return {
                            status: "ERROR",
                            data: null,
                            error: {
                                code: "SLOT_DURATION_MISMATCH",
                                message: "Selected slot duration does not match service configuration.",
                                traceId: activeTraceId
                            }
                        };
                    }
                }
            }
        }

        let balancedResourceId = requiredResourceId || null;
        if (!balancedResourceId && availableResourceIds.length === 1) {
            balancedResourceId = availableResourceIds[0];
        } else if (!balancedResourceId && availableResourceIds.length > 1) {
            const dayKey = _safeTrim(start).slice(0, 10);
            const loadMap = await _countStaffLoadForDay(dayKey, availableResourceIds, activeTraceId);
            balancedResourceId =
                pickStaffByLowestLoad(availableResourceIds, loadMap) ||
                availableResourceIds.slice().sort()[0];
        }

        return {
            status: "SUCCESS",
            data: {
                slot: Object.assign({}, normalizedSlot, {
                    localStartDate: start,
                    localEndDate: end
                }),
                resourceId: balancedResourceId,
                candidateResourceIds: availableResourceIds
            },
            error: null
        };
    } catch (error) {
        log.warn("Exact slot revalidation failed", {
            traceId: activeTraceId,
            serviceId: String(resolvedServiceId),
            start: start,
            end: end,
            message: error && error.message
        });
        return {
            status: "ERROR",
            data: null,
            error: {
                code: "SLOT_UNAVAILABLE",
                message: "Selected slot could not be revalidated.",
                traceId: activeTraceId
            }
        };
    }
}
