/*
============================================================================
FILE: backend/reservas.web.js
VERSION: v5010.2-LOCATION-MUTABLE-FIX
BASE: v5010.1-DAL-MIGRATION + DIAGNOSTICS + SYNTAX RECOVERY
RESPONSIBILITY: Availability engine, dual slots, staff pairing and caching.
STANDARDS: G10 ASCII Strict.
FIXES APLICADOS v5010.2:
FIX-LOCATION-MUTABLE: LOCATIONTS reemplazado por buildLocationTS().
       El SDK de Wix (rename-all-nested-keys) muta el objeto location
       internamente. Object.freeze causaba TypeError en getAvailableDays.
       Ahora se crea un objeto mutable fresco en cada llamada.
FIX-SYNTAX-RECOVERY: Operadores =>, &&, === restaurados en
       _verifyRequiredStaffViaGet, getConfirmedBookingForDisplay,
       _getStaffDisplayNamePublic. Paréntesis de arrow functions cerrados.
FIX-DTO-STAFF-01: staffOptions incluye resourceId explicito.
FIX-DIAG-DAYS-01/02: Logs de diagnóstico temporal mantenidos.
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
    STAFFDEFAULTNAME,
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
    pickStaffByLowestLoad
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

function _normalizeAddon(addOn) {
    if (!addOn || typeof addOn !== "object") return null;
    const addOnId = _safeTrim(addOn.addOnId);
    const name = _safeTrim(addOn.name);
    const price = Number(addOn.price);
    if (!addOnId || !name || !Number.isFinite(price)) return null;
    return {
        addOnId,
        name,
        price,
        nativeId: _safeTrim(addOn.nativeId) || null
    };
}

const SERVICIOSCOL = BUSINESSCOLLECTIONS.SERVICIOS_CATALOGO;
const WATCHDOGTIMEOUTMS = SDKCONFIG.TIMEOUTS.WATCHDOGMS;
const SERVICECACHETTLMS = SDKCONFIG.CACHE.SERVICESTTLMS;
const DIASLIMITE = SLOTSEARCH.DIAS_LIMITE;
const MINUTOSMAXHUECO_DUAL = Math.max(
    0,
    Number(SLOTSEARCH?.MINUTOSMAXHUECODUAL) || 120
);
const CACHEMAXSIZE = SDKCONFIG.CACHE.MAXENTRIES;
const STAFFRESOURCETYPEID = API.STAFFRESOURCETYPEID;
const STAFFLOADQUERY_LIMIT = Math.max(
    100,
    Number(SDKCONFIG?.JOBS?.HEALTHCHECKQUERYLIMIT) || 1000
);
const CONFIGUREDLOCATIONTYPE = _safeTrim(
    SDKCONFIG.LOCATIONTYPES?.TIME_SLOTS
);

/
 * FIX-LOCATION-MUTABLE: Retorna un objeto NUEVO y MUTABLE en cada llamada.
 * El SDK de Wix (rename-all-nested-keys.js) intenta asignar propiedades
 * al objeto location internamente. Si se pasa un Object.freeze, lanza
 * TypeError: Cannot assign to read only property 'id'.
 * BIBLIA 3.3: listAvailabilityTimeSlots usa BUSINESS; createBooking usa OWNER_BUSINESS.
 */
function _buildLocationTS() {
    return {
        id: SDKCONFIG.LOCATIONID,
        locationType:
            !CONFIGUREDLOCATIONTYPE ||
            CONFIGUREDLOCATIONTYPE === "BUSINESS"
                ? "OWNER_BUSINESS"
                : CONFIGUREDLOCATIONTYPE
    };
}

const serviceCatalogRAM = new Map();

function _cacheSetBounded(map, key, value, maxSize) {
    if (map.has(key)) map.delete(key);
    map.set(key, value);
    if (map.size  0) {
        const staffGroup = groups.find(
            (group) =>
                String(group?.resourceTypeId) === String(STAFFRESOURCETYPE_ID)
        );
        if (!staffGroup) return [];
        return Array.from(
            new Set(
                (staffGroup.resources || [])
                    .map((resource) =>
                        safeTrim(resource?.id || resource?.id || resource?.resourceId)
                    )
                    .filter((resourceId) => _looksLikeGuid(resourceId))
            )
        );
    }
    const directId = _safeTrim(
        normalizedSlot.resource?.id ||
        normalizedSlot.resource?._id ||
        normalizedSlot.resource?.resourceId ||
        normalizedSlot.resourceId
    );
    return _looksLikeGuid(directId) ? [directId] : [];
}

function _minutesBetweenUtcDates(a, b) {
    if (!(a instanceof Date) || !(b instanceof Date)) return 0;
    const milliseconds = b.getTime() - a.getTime();
    if (!Number.isFinite(milliseconds) || milliseconds  startUtc.getTime());
}

async function _getStaffDisplayNamePublic(resourceId) {
    const id = _safeTrim(resourceId);
    if (!id || !looksLikeGuid(id)) return STAFFDEFAULT_NAME;
    try {
        const name = await getStaffDisplayName(id);
        return safeTrim(name) || STAFFDEFAULT_NAME;
    } catch (_) {
        return STAFFDEFAULTNAME;
    }
}

function _getRequestedAddonContext(service, requestedAddonIds) {
    const requested = new Set(
        (Array.isArray(requestedAddonIds) ? requestedAddonIds : [])
            .map((id) => _safeTrim(id))
            .filter(Boolean)
    );
    const addOnOptions = Array.isArray(service?.addOnOptions)
        ? service.addOnOptions
        : [];
    const selected = addOnOptions.filter((addon) => {
        const id = _safeTrim(addon?.addOnId);
        const nativeId = _safeTrim(addon?.nativeId);
        return requested.has(id) || requested.has(nativeId);
    });
    return {
        nativeAddonIds: Array.from(
            new Set(
                selected
                    .map((addon) => _safeTrim(addon?.nativeId || addon?.addOnId))
                    .filter((id) => _looksLikeGuid(id))
            )
        ),
        addOnOptions: selected
    };
}

function _resolveAddonContextInternal(service, requestedAddonIds) {
    return _getRequestedAddonContext(service, requestedAddonIds);
}

async function _verifyRequiredStaffViaGet({
    serviceId,
    start,
    end,
    requiredResourceId,
    nativeAddonIds,
    traceId
}) {
    const getPayload = {
        serviceId: String(serviceId),
        localStartDate: start,
        localEndDate: end,
        location: _buildLocationTS(),
        timeZone: SDK_CONFIG.TZ,
        resourceTypes: [
            { resourceTypeId: STAFFRESOURCETYPE_ID, resourceIds: [requiredResourceId] }
        ]
    };
    if (Array.isArray(nativeAddonIds) && nativeAddonIds.length > 0) {
        getPayload.customerChoices = { addOnIds: nativeAddonIds };
    }
    try {
        const result = await _executeWithRetry(
            () =>
                withTimeout(
                    () => availabilityTimeSlots.getAvailabilityTimeSlot(getPayload),
                    WATCHDOGTIMEOUTMS,
                    "exactSlot:verifyStaffGet"
                ),
            2,
            300
        );
        if (result?.timeSlot) return { ok: true, slot: result.timeSlot, errorCode: null };
        return { ok: false, slot: null, errorCode: "STAFF_UNAVAILABLE" };
    } catch (error) {
        log.warn("getAvailabilityTimeSlot verification failed", {
            traceId,
            serviceId: String(serviceId),
            requiredResourceId,
            message: error?.message
        });
        return { ok: false, slot: null, errorCode: "STAFF_UNAVAILABLE" };
    }
}

// ============================================================================
// SERVICE CATALOG
// ============================================================================
export async function _getServiceBySlugOrIdInternal(slugOrId, externalTraceId = null) {
    const traceId = externalTraceId || makeTraceId("service");
    const raw = _safeTrim(slugOrId);
    const isGuid = _looksLikeGuid(raw);
    const clean = isGuid
        ? raw
        : _safeTrim(raw)
            ? String(raw).split("?")[0].split("#")[0].replace(/^\//, "").replace(/\/$/, "")
            : "";
    if (!clean) {
        return {
            status: "ERROR",
            data: null,
            error: { code: "SERVICENOTFOUND", message: "Service identifier is required." }
        };
    }
    const cached = serviceCatalogRAM.get(clean);
    if (cached && Date.now() - cached.timestamp  queryFirstItem({
                    dataCollectionId: SERVICIOS_COL,
                    filter: { serviceId: { $eq: clean } },
                    consistency: CONSISTENCY.STRONG
                }),
                WATCHDOGTIMEOUTMS,
                "getServiceBySlugOrId:serviceId"
            );
        } else {
            service = await withTimeout(
                () => queryFirstItem({
                    dataCollectionId: SERVICIOS_COL,
                    filter: { slug: { $eq: clean } },
                    consistency: CONSISTENCY.STRONG
                }),
                WATCHDOGTIMEOUTMS,
                "getServiceBySlugOrId:slug"
            );
        }
        if (!service && isGuid) {
            service = await withTimeout(
                () => queryFirstItem({
                    dataCollectionId: SERVICIOS_COL,
                    filter: { serviceId: { $eq: clean } },
                    consistency: CONSISTENCY.STRONG
                }),
                WATCHDOGTIMEOUTMS,
                "getServiceBySlugOrId:guidFallback"
            );
        }
        if (!service) {
            log.error("Service not found in catalog", { key: clean, traceId });
            return {
                status: "ERROR",
                data: null,
                error: { code: "SERVICENOTFOUND", message: "Service not found." }
            };
        }
        const mapped = await _mapServiceImport2ToUX(service, traceId);
        const cacheEntry = { data: mapped, timestamp: Date.now() };
        cacheSetBounded(serviceCatalogRAM, clean, cacheEntry, CACHEMAX_SIZE);
        if (mapped.serviceId) {
            cacheSetBounded(serviceCatalogRAM, mapped.serviceId, cacheEntry, CACHEMAX_SIZE);
        }
        if (mapped.slug) {
            cacheSetBounded(serviceCatalogRAM, mapped.slug, cacheEntry, CACHEMAX_SIZE);
        }
        return { status: "SUCCESS", data: mapped, error: null };
    } catch (error) {
        log.error("Error loading service", { traceId, message: error?.message });
        return {
            status: "ERROR",
            data: null,
            error: {
                code: "DATABASE_ERROR",
                message: error?.message || "Error loading service."
            }
        };
    }
}

export async function _resolveServiceIdInternal(serviceIdReq) {
    const raw = _safeTrim(serviceIdReq);
    if (!raw) return null;
    const key = looksLikeGuid(raw) ? raw : safeSlugOrId(raw);
    if (!key) return null;
    const result = await _getServiceBySlugOrIdInternal(key);
    if (result?.status === "SUCCESS" && result?.data?.serviceId) {
        const serviceId = _safeTrim(result.data.serviceId);
        if (_looksLikeGuid(serviceId)) return serviceId;
    }
    return null;
}

export async function _mapServiceImport2ToUX(service, traceId) {
    const serviceId = safeTrim(readServiceField(service, "serviceId"));
    if (!_looksLikeGuid(serviceId)) {
        throw new Error("Catalog serviceId is missing or invalid.");
    }
    const clientHidden = _readServiceField(service, "clientHidden") === true;
    const allowCombine = !clientHidden && _readServiceField(service, "allowCombine") === true;
    const linkedPhases = safeTrim(readServiceField(service, "linkedPhases"));
    if (allowCombine && !_looksLikeGuid(linkedPhases)) {
        throw new Error("Dual service linkedPhases is missing or invalid.");
    }
    if (allowCombine && _looksLikeGuid(linkedPhases) && linkedPhases === serviceId) {
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
    const title = safeTrim(readServiceField(service, "title")) || "Service";
    const price = Number(_readServiceField(service, "price")) || 0;
    const currency = safeTrim(readServiceField(service, "currency")) || "EUR";
    const pricingModel = safeTrim(readServiceField(service, "pricingModel")) || null;
    const slug = safeTrim(readServiceField(service, "slug")) || null;
    const serviceType = safeTrim(readServiceField(service, "serviceType")) || null;
    const sku = safeTrim(readServiceField(service, "sku")) || null;
    const depositAmount = Number(_readServiceField(service, "depositAmount")) || 0;
    const depositType = safeTrim(readServiceField(service, "depositType")) || null;
    const onlinePayment = _readServiceField(service, "onlinePayment") === true;
    const inPersonPayment = _readServiceField(service, "inPersonPayment") === true;
    const taxIncluded = _readServiceField(service, "taxIncluded") === true;
    const tipoImpositivo = Number(_readServiceField(service, "tipoImpositivo")) || 0;
    const categoryId = safeTrim(readServiceField(service, "categoryId")) || null;
    const locationId = safeTrim(readServiceField(service, "locationId")) || null;
    const location = safeTrim(readServiceField(service, "location")) || null;
    const mainMedia = safeTrim(readServiceField(service, "mainMedia")) || "";
    const shortDescription = safeTrim(readServiceField(service, "tagLine")) || null;
    const longDescription = safeTrim(readServiceField(service, "description")) || null;
    const internalNotes = safeTrim(readServiceField(service, "internalNotes")) || null;
    const durationRange = readDurationRange(service);
    const phaseSum = allowCombine
        ? phase1Duration + exposureDuration + phase2Duration
        : phase1Duration;
    const estimatedTotal = phaseSum;
    const availableStaff = cleanGuidList(_readServiceField(service, "availableStaff"));

    // FIX-DTO-STAFF-01: el HTML espera person.resourceId y person.name.
    const staffOptions = await Promise.all(
        availableStaff.map(async (resourceId) => {
            const displayName = await _getStaffDisplayNamePublic(resourceId);
            return {
                resourceId,
                id: resourceId,
                value: resourceId,
                name: displayName,
                label: displayName
            };
        })
    );

    const addOnOptions = (Array.isArray(_readServiceField(service, "addOnOptions"))
        ? _readServiceField(service, "addOnOptions")
        : []
    )
        .map(_normalizeAddon)
        .filter(Boolean);

    return {
        serviceId,
        slug,
        serviceType,
        sku,
        categoryId,
        locationId,
        localizacion: location,
        internalNotes,
        permitirCombinar: allowCombine,
        tiempoFase1: phase1Duration,
        tiempoExposicion: exposureDuration,
        tiempoFase2: phase2Duration,
        duracionTotal: estimatedTotal,
        availableStaff,
        staffOptions,
        depositAmount,
        depositType,
        onlinePayment,
        inPersonPayment,
        taxIncluded,
        tipoImpositivo,
        pricingModel,
        currency,
        linkedPhases: allowCombine ? linkedPhases : null,
        allowCombine,
        phase1Duration,
        exposureDuration,
        phase2Duration,
        totalDuration: estimatedTotal,
        clientHidden,
        durationRange,
        addOnOptions,
        mainMedia,
        metadata: {
            titulo: title,
            tituloServicio: title,
            precio: price,
            duracionTotal: estimatedTotal,
            localizacion: location,
            resumenCorto: shortDescription,
            descripcionLarga: longDescription,
            pricingModel,
            addOnOptions,
            mainMedia,
            currency,
            tipoImpositivo,
            pricing: { base: price, currency },
            timing: { estimatedTotal, totalDuration: estimatedTotal },
            durationRange
        }
    };
}

export async function getServiceForBookingInternal(serviceId, traceId = null) {
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
    async (slugOrId) => {
        const traceId = makeTraceId("wm-service");
        try {
            const result = await _getServiceBySlugOrIdInternal(slugOrId, traceId);
            if (result?.status !== "SUCCESS") return result;
            return {
                status: "SUCCESS",
                data: _toPublicService(result.data),
                error: null
            };
        } catch (error) {
            return {
                status: "ERROR",
                data: null,
                error: toPublicError(error, "SERVICELOOKUP_FAILED")
            };
        }
    }
);

export const resolveServiceId = webMethod(
    Permissions.Anyone,
    async (serviceIdRequest) => {
        try {
            const resolved = await _resolveServiceIdInternal(serviceIdRequest);
            if (!resolved) {
                return {
                    status: "ERROR",
                    data: null,
                    error: { code: "SERVICENOTFOUND", message: "Service identifier not found." }
                };
            }
            return { status: "SUCCESS", data: String(resolved), error: null };
        } catch (error) {
            return {
                status: "ERROR",
                data: null,
                error: toPublicError(error, "SERVICERESOLVE_FAILED")
            };
        }
    }
);

export function _toPublicService(service) {
    if (!service || typeof service !== "object") return null;
    const { internalNotes, ...publicService } = service;
    return {
        ...publicService,
        linkedPhases: publicService.linkedPhases || null
    };
}

// ============================================================================
// CONFIRMATION PAGE READ
// ============================================================================
const CONFIRMATIONDTO_FIELDS = Object.freeze([
    "bookingId",
    "serviceId",
    "dateYmd",
    "slotStart",
    "slotEnd",
    "resourceId",
    "pairToken",
    "totalPrice"
]);

function _toConfirmationDto(item) {
    if (!item || typeof item !== "object") return null;
    const dto = {};
    for (const key of CONFIRMATIONDTO_FIELDS) {
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
    async ({ bookingId } = {}) => {
        const traceId = makeTraceId("confirmacion-booking");
        const cleanId = _safeTrim(bookingId);
        if (!cleanId) {
            return { ok: false, data: null, error: "BOOKINGIDREQUIRED" };
        }
        try {
            const item = await withTimeout(
                () => queryFirstItem({
                    dataCollectionId: BUSINESSCOLLECTIONS.CITASF2,
                    filter: { bookingId: { $eq: cleanId } },
                    consistency: CONSISTENCY.STRONG
                }),
                Number(SDKCONFIG?.TIMEOUTS?.APIMS) || 15000,
                "getConfirmedBookingForDisplay"
            );
            if (!item) return { ok: false, data: null, error: "NOT_FOUND" };
            const status = normalizeBookingStatus(
                item[BOOKING_FIELDS.STATUS] ?? item.status
            );
            if (
                status !== BOOKING_STATUS.CONFIRMED &&
                status !== BOOKING_STATUS.PENDING
            ) {
                return { ok: false, data: null, error: "NOT_CONFIRMED" };
            }
            return { ok: true, data: _toConfirmationDto(item), error: null };
        } catch (err) {
            log.warn("getConfirmedBookingForDisplay failed", {
                traceId,
                error: err?.message
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
    async (serviceIdOrSlug, resourceId, dateYmd, addOnIds = []) => {
        const traceId = makeTraceId("available-slots");
        try {
            const serviceResult = await _getServiceBySlugOrIdInternal(serviceIdOrSlug, traceId);
            if (serviceResult?.status !== "SUCCESS" || !serviceResult.data?.serviceId) {
                return {
                    status: "ERROR",
                    data: null,
                    error: { code: "SERVICENOTFOUND", message: "Service not found." }
                };
            }
            const service = serviceResult.data;
            const serviceId = service.serviceId;
            if (service.allowCombine === true) {
                log.warn("getAvailableSlots called for dual service", {
                    traceId,
                    serviceId: String(serviceId)
                });
                return {
                    status: "ERROR",
                    data: null,
                    error: {
                        code: "SERVICEISDUAL",
                        message: "Use getCertifiedDualSlots for dual services."
                    }
                };
            }
            const requestedResourceId = _normalizeResourceIds(resourceId, traceId);
            const addonContext = _resolveAddonContextInternal(service, addOnIds);
            if (addonContext.nativeAddonIds.length > 0 && service.durationRange) {
                return {
                    status: "ERROR",
                    data: null,
                    error: {
                        code: "DURATIONRANGEWITHADDONSNOT_SUPPORTED",
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
                fromLocalDate: ${ymd}T00:00:00,
                toLocalDate: ${ymd}T23:59:59,
                timeZone: SDK_CONFIG.TZ,
                bookable: true,
                locations: [_buildLocationTS()],
                includeResourceTypeIds: [STAFFRESOURCETYPE_ID]
            };
            if (requestedResourceId.length > 0) {
                payload.resourceTypes = [
                    { resourceTypeId: STAFFRESOURCETYPE_ID, resourceIds: requestedResourceId }
                ];
            }
            if (addonContext.nativeAddonIds.length > 0) {
                payload.customerChoices = { addOnIds: addonContext.nativeAddonIds };
            }
            const result = await _executeWithRetry(
                () =>
                    withTimeout(
                        () => availabilityTimeSlots.listAvailabilityTimeSlots(payload),
                        WATCHDOGTIMEOUTMS,
                        "getAvailableSlots"
                    ),
                2,
                300
            );
            const timeSlots = Array.isArray(result?.timeSlots) ? result.timeSlots : [];
            const slots = timeSlots
                .filter((slot) => slot?.bookable === true)
                .map((slot) => _attachServiceId(slot, serviceId, traceId, "getAvailableSlots"))
                .filter(Boolean);
            return {
                status: "SUCCESS",
                data: {
                    slots,
                    serviceId,
                    dateYmd: ymd,
                    resourceId: requestedResourceId[0] || null
                },
                error: null
            };
        } catch (error) {
            log.warn("getAvailableSlots failed", {
                traceId,
                serviceIdOrSlug: _safeTrim(serviceIdOrSlug),
                dateYmd: _safeTrim(dateYmd),
                message: error?.message
            });
            return {
                status: "ERROR",
                data: null,
                error: {
                    code: "AVAILABLESLOTSFAILED",
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
    async (serviceIdOrSlug, resourceId, year, month, addOnIds = []) => {
        const traceId = makeTraceId("available-days");
        try {
            const serviceResult = await _getServiceBySlugOrIdInternal(serviceIdOrSlug, traceId);
            if (serviceResult?.status !== "SUCCESS" || !serviceResult.data?.serviceId) {
                return {
                    status: "ERROR",
                    data: null,
                    error: { code: "SERVICENOTFOUND", message: "Service not found." }
                };
            }
            const service = serviceResult.data;
            const serviceId = service.serviceId;
            const y = Number(year);
            const m = Number(month);
            if (!Number.isFinite(y) || !Number.isFinite(m) || m  12) {
                return {
                    status: "ERROR",
                    data: null,
                    error: { code: "INVALID_DATE", message: "Invalid year/month." }
                };
            }
            const monthStr = String(m).padStart(2, "0");
            const fromDate = ${y}-${monthStr}-01T00:00:00;
            const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
            const toDate = ${y}-${monthStr}-${String(lastDay).padStart(2, "0")}T23:59:59;
            const requestedResourceId = _normalizeResourceIds(resourceId, traceId);
            const addonContext = _resolveAddonContextInternal(service, addOnIds);
            const payload = {
                serviceId: String(serviceId),
                fromLocalDate: fromDate,
                toLocalDate: toDate,
                timeZone: SDK_CONFIG.TZ,
                bookable: true,
                locations: [_buildLocationTS()],
                includeResourceTypeIds: [STAFFRESOURCETYPE_ID]
            };
            if (requestedResourceId.length > 0) {
                payload.resourceTypes = [
                    { resourceTypeId: STAFFRESOURCETYPE_ID, resourceIds: requestedResourceId }
                ];
            }
            if (addonContext.nativeAddonIds.length > 0 && !service.durationRange) {
                payload.customerChoices = { addOnIds: addonContext.nativeAddonIds };
            }
            const result = await _executeWithRetry(
                () =>
                    withTimeout(
                        () => availabilityTimeSlots.listAvailabilityTimeSlots(payload),
                        WATCHDOGTIMEOUTMS,
                        "getAvailableDays"
                    ),
                2,
                300
            );
            // FIX-DIAG-DAYS-02A: diagnostico temporal
            log.info("getAvailableDays availability response", {
                traceId,
                serviceId,
                year: y,
                month: m,
                timeSlotCount: Array.isArray(result && result.timeSlots)
                    ? result.timeSlots.length
                    : null,
                hasTimeSlotsArray: Array.isArray(result && result.timeSlots)
            });
            const timeSlots = Array.isArray(result?.timeSlots) ? result.timeSlots : [];
            const daySet = new Set();
            for (const slot of timeSlots) {
                if (slot?.bookable !== true) continue;
                const localStart = _normalizeLocalIsoStr(
                    slot?.localStartDate || slot?.startDate
                );
                if (!localStart) continue;
                daySet.add(localStart.slice(0, 10));
            }
            // FIX-DIAG-DAYS-02B: diagnostico temporal
            log.info("getAvailableDays days computed", {
                traceId,
                dayCount: daySet.size
            });
            return {
                status: "SUCCESS",
                data: {
                    days: Array.from(daySet).sort(),
                    serviceId,
                    year: y,
                    month: m,
                    resourceId: requestedResourceId[0] || null
                },
                error: null
            };
        } catch (error) {
            // FIX-DIAG-DAYS-01: log.error con contexto tecnico completo
            log.error("getAvailableDays failed", {
                traceId,
                serviceKey: _safeTrim(serviceIdOrSlug),
                resourceId: _safeTrim(resourceId) || null,
                year: Number(year),
                month: Number(month),
                errorName: error && error.name,
                errorCode: error && error.code,
                message: error && error.message,
                details: error && error.details,
                stack: error && error.stack
            });
            return {
                status: "ERROR",
                data: null,
                error: {
                    code: "AVAILABLEDAYSFAILED",
                    message: "Could not load available days.",
                    traceId
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
    for (const id of ids) {
        loadByResource[id] = 0;
    }
    if (!ymd || ids.length === 0) {
        return loadByResource;
    }
    const cancelled = String(BOOKING_STATUS.CANCELED);
    const idSet = new Set(ids);
    try {
        const result = await withTimeout(
            () => queryItems({
                dataCollectionId: BUSINESSCOLLECTIONS.CITASF2,
                filter: { dateYmd: { $eq: ymd } },
                limit: STAFFLOADQUERY_LIMIT,
                consistency: CONSISTENCY.STRONG
            }),
            WATCHDOGTIMEOUTMS,
            "staffLoad:countDay"
        );
        for (const item of result?.items || []) {
            const rawStatus = item?.bookingStatus;
            if (rawStatus === undefined || rawStatus === null) {
                log.warn("CitasF2 fila sin bookingStatus (usa legacy status), migrar antes de EOL 31/12/2026", { id: item?._id });
            }
            const status = String(rawStatus || "").trim().toUpperCase();
            if (status === cancelled || status === "CANCELED" || status === "CANCELLED") {
                continue;
            }
            const resourceId = _safeTrim(item?.resourceId);
            if (!resourceId || !idSet.has(resourceId)) {
                continue;
            }
            loadByResource[resourceId] = (loadByResource[resourceId] || 0) + 1;
        }
    } catch (error) {
        log.warn("_countStaffLoadForDay failed; using zero loads", {
            traceId,
            dateYmd: ymd,
            message: error?.message
        });
    }
    return loadByResource;
}

// ============================================================================
// DISPONIBILIDAD DUAL
// ============================================================================
export async function _getCertifiedDualSlotsInternal(serviceId, resourceId, dateYmd, addOnIds = []) {
    const traceId = makeTraceId("dual-slots");
    const serviceRes = await _getServiceBySlugOrIdInternal(serviceId, traceId);
    if (serviceRes?.status !== "SUCCESS" || !serviceRes?.data) {
        return {
            status: "ERROR",
            data: null,
            error: { code: "SERVICENOTFOUND", message: "Service not found." }
        };
    }
    const service = serviceRes.data;
    if (service.allowCombine !== true || !_looksLikeGuid(service.linkedPhases)) {
        return {
            status: "ERROR",
            data: null,
            error: { code: "SERVICENOTDUAL", message: "Service is not configured as dual." }
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
    const addonContext = _resolveAddonContextInternal(service, addOnIds);
    if (addonContext.nativeAddonIds.length > 0 && service.durationRange) {
        return {
            status: "ERROR",
            data: null,
            error: {
                code: "DURATIONRANGEWITHADDONSNOT_SUPPORTED",
                message: "Services with a duration range cannot be combined with addons."
            }
        };
    }
    const buildListPayload = (svcId) => {
        const payload = {
            serviceId: String(svcId),
            fromLocalDate: ${ymd}T00:00:00,
            toLocalDate: ${ymd}T23:59:59,
            timeZone: SDK_CONFIG.TZ,
            bookable: true,
            locations: [_buildLocationTS()],
            includeResourceTypeIds: [STAFFRESOURCETYPE_ID]
        };
        if (requestedResourceId.length > 0) {
            payload.resourceTypes = [
                { resourceTypeId: STAFFRESOURCETYPE_ID, resourceIds: requestedResourceId }
            ];
        }
        if (addonContext.nativeAddonIds.length > 0) {
            payload.customerChoices = { addOnIds: addonContext.nativeAddonIds };
        }
        return payload;
    };
    const f1Res = await _executeWithRetry(
        () =>
            withTimeout(
                () => availabilityTimeSlots.listAvailabilityTimeSlots(buildListPayload(service.serviceId)),
                WATCHDOGTIMEOUTMS,
                "dual:listF1"
            ),
        2,
        300
    );
    const f1Slots = (Array.isArray(f1Res?.timeSlots) ? f1Res.timeSlots : []).filter(
        (s) => s?.bookable === true
    );
    const f2Res = await _executeWithRetry(
        () =>
            withTimeout(
                () => availabilityTimeSlots.listAvailabilityTimeSlots(buildListPayload(service.linkedPhases)),
                WATCHDOGTIMEOUTMS,
                "dual:listF2"
            ),
        2,
        300
    );
    const f2Slots = (Array.isArray(f2Res?.timeSlots) ? f2Res.timeSlots : []).filter(
        (s) => s?.bookable === true
    );
    const staffPool = cleanGuidList(service.availableStaff || []);
    const loadByResource = await _countStaffLoadForDay(ymd, staffPool, traceId);
    const pairs = [];
    for (const f1 of f1Slots) {
        const f1Start = _normalizeLocalIsoStr(f1?.localStartDate || f1?.startDate);
        const f1End = _normalizeLocalIsoStr(f1?.localEndDate || f1?.endDate);
        if (!f1Start || !f1End) continue;
        const range = toUtcRange(f1Start, f1End);
        if (!range) continue;
        const f1Resources = _getResourceIdsFromSlot(f1);
        for (const f2 of f2Slots) {
            const f2Start = _normalizeLocalIsoStr(f2?.localStartDate || f2?.startDate);
            const f2End = _normalizeLocalIsoStr(f2?.localEndDate || f2?.endDate);
            if (!f2Start || !f2End) continue;
            const f2StartUtc = getUtcDateFromMadridLocal(f2Start);
            if (!f2StartUtc) continue;
            const gapMinutes = computeGapMinutes(range.endUtc, f2StartUtc);
            if (gapMinutes  MINUTOSMAXHUECO_DUAL) continue;
            const f2Resources = _getResourceIdsFromSlot(f2);
            const shared = f1Resources.filter((id) => f2Resources.includes(id));
            if (shared.length === 0) continue;
            const pairResourceId =
                requestedResourceId[0] && shared.includes(requestedResourceId[0])
                    ? requestedResourceId[0]
                    : pickStaffByLowestLoad(shared, loadByResource) || shared[0];
            pairs.push({
                fase1: {
                    slotRef: { ..._normalizeSlotShape(f1), serviceId: service.serviceId },
                    resourceId: pairResourceId
                },
                fase2: {
                    slotRef: { ..._normalizeSlotShape(f2), serviceId: service.linkedPhases },
                    resourceId: pairResourceId
                },
                pairToken: null,
                serviceId: service.serviceId,
                linkedPhases: service.linkedPhases,
                dateYmd: ymd,
                gapMinutes,
                exposureDuration: Number(service.exposureDuration || 0) || 0
            });
        }
    }
    return { status: "SUCCESS", data: pairs, error: null, traceId };
}

export const getCertifiedDualSlots = webMethod(
    Permissions.Anyone,
    async (serviceIdOrSlug, resourceId, dateYmd, addOnIds = []) => {
        try {
            const resolved = await _resolveServiceIdInternal(serviceIdOrSlug);
            if (!resolved) {
                return {
                    status: "ERROR",
                    data: null,
                    error: { code: "SERVICENOTFOUND", message: "Service identifier not found." }
                };
            }
            return await _getCertifiedDualSlotsInternal(resolved, resourceId, dateYmd, addOnIds);
        } catch (error) {
            return {
                status: "ERROR",
                data: null,
                error: toPublicError(error, "DUALSLOTS_FAILED")
            };
        }
    }
);

// ============================================================================
// RESOLUCION DE STAFF
// ============================================================================
export async function _resolveStaffForSlotInternal({
    serviceId,
    f1Start,
    f1End,
    f2Start,
    f2End,
    requestedResourceId,
    addOnIds = [],
    traceId
}) {
    const activeTraceId = traceId || makeTraceId("staff-resolve");
    const resolved = await _resolveServiceIdInternal(serviceId);
    if (!resolved) {
        return {
            status: "ERROR",
            data: null,
            error: { code: "SERVICENOTFOUND", message: "Service identifier not found." }
        };
    }
    const normalizedAddonIds = Array.from(
        new Set(
            (Array.isArray(addOnIds) ? addOnIds : [])
                .map((id) => _safeTrim(id))
                .filter((id) => _looksLikeGuid(id))
        )
    ).sort();
    const f1Result = await revalidateExactAvailabilitySlot({
        serviceId: resolved,
        localStartDate: f1Start,
        localEndDate: f1End,
        resourceId: requestedResourceId || null,
        nativeAddonIds: normalizedAddonIds,
        traceId: activeTraceId
    });
    if (f1Result?.status !== "SUCCESS") return f1Result;
    const finalResourceId = f1Result.data?.resourceId || requestedResourceId || null;
    let f2Result = null;
    if (f2Start && f2End) {
        const serviceConfig = await _getServiceBySlugOrIdInternal(resolved, activeTraceId);
        const linkedPhases = _safeTrim(serviceConfig?.data?.linkedPhases);
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
            localStartDate: f2Start,
            localEndDate: f2End,
            resourceId: finalResourceId,
            nativeAddonIds: normalizedAddonIds,
            traceId: activeTraceId
        });
        if (f2Result?.status !== "SUCCESS") return f2Result;
    }
    return {
        status: "SUCCESS",
        data: {
            resourceId: finalResourceId,
            slotF1: f1Result.data?.slot || null,
            slotF2: f2Result?.data?.slot || null
        },
        error: null
    };
}

export const resolveStaffForSlot = webMethod(
    Permissions.Anyone,
    async (serviceIdOrSlug, start, resourceId, addOnIds = [], end = null) => {
        try {
            const resolved = await _resolveServiceIdInternal(serviceIdOrSlug);
            if (!resolved) {
                return {
                    status: "ERROR",
                    data: null,
                    error: { code: "SERVICENOTFOUND", message: "Service identifier not found." }
                };
            }
            return await _resolveStaffForSlotInternal({
                serviceId: resolved,
                f1Start: start,
                f1End: end,
                f2Start: null,
                f2End: null,
                requestedResourceId: resourceId,
                addOnIds,
                traceId: makeTraceId("staff-resolve-wm")
            });
        } catch (error) {
            return {
                status: "ERROR",
                data: null,
                error: toPublicError(error, "STAFFRESOLVE_FAILED")
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
            traceId,
            serviceId: sid || null,
            dateYmd: _safeTrim(dateYmd) || null,
            resourceId: _safeTrim(resourceId) || null
        });
        return { status: "SUCCESS" };
    } catch (error) {
        log.warn("_invalidateCachesInternal failed", {
            traceId,
            message: error?.message
        });
        return { status: "ERROR", error: error?.message || "UNKNOWN" };
    }
}

// ============================================================================
// REVALIDACION EXACTA
// ============================================================================
export async function revalidateExactAvailabilitySlot({
    serviceId,
    localStartDate,
    localEndDate,
    resourceId,
    nativeAddonIds = [],
    traceId
}) {
    const activeTraceId = traceId || makeTraceId("exact-slot");
    const resolvedServiceId = await _resolveServiceIdInternal(serviceId);
    const start = _normalizeLocalIsoStr(localStartDate);
    const end = _normalizeLocalIsoStr(localEndDate);
    const rawResourceId = _safeTrim(resourceId);
    const requiredResourceId = _looksLikeGuid(rawResourceId) ? rawResourceId : "";
    if (!resolvedServiceId || !start || !end || !_isValidSlotRange(start, end)) {
        return {
            status: "ERROR",
            data: null,
            error: { code: "INVALIDSLOTRECHECK", message: "Selected slot data is invalid." }
        };
    }
    try {
        const normalizedAddonIds = Array.from(
            new Set(
                (Array.isArray(nativeAddonIds) ? nativeAddonIds : [])
                    .map((id) => _safeTrim(id))
                    .filter((id) => _looksLikeGuid(id))
            )
        ).sort();
        const earlyServiceConfig = await _getServiceBySlugOrIdInternal(
            resolvedServiceId,
            activeTraceId
        );
        const serviceDurationRange =
            earlyServiceConfig?.status === "SUCCESS" && earlyServiceConfig?.data?.durationRange
                ? earlyServiceConfig.data.durationRange
                : null;
        if (normalizedAddonIds.length > 0 && serviceDurationRange) {
            return {
                status: "ERROR",
                data: null,
                error: {
                    code: "DURATIONRANGEWITHADDONSNOT_SUPPORTED",
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
                includeResourceTypeIds: [STAFFRESOURCETYPE_ID],
                customerChoices: { addOnIds: normalizedAddonIds }
            };
            if (requiredResourceId) {
                listPayload.resourceTypes = [
                    { resourceTypeId: STAFFRESOURCETYPE_ID, resourceIds: [requiredResourceId] }
                ];
            }
            const listed = await _executeWithRetry(
                () =>
                    withTimeout(
                        () => availabilityTimeSlots.listAvailabilityTimeSlots(listPayload),
                        WATCHDOGTIMEOUTMS,
                        "exactSlot:list"
                    ),
                2,
                300
            );
            rawSlot =
                (Array.isArray(listed?.timeSlots) ? listed.timeSlots : []).find((slot) => {
                    const slotStart = _normalizeLocalIsoStr(
                        slot?.localStartDate || slot?.startDate
                    );
                    const slotEnd = _normalizeLocalIsoStr(slot?.localEndDate || slot?.endDate);
                    return slotStart === start && slotEnd === end && slot?.bookable === true;
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
                    { resourceTypeId: STAFFRESOURCETYPE_ID, resourceIds: [requiredResourceId] }
                ];
            }
            const result = await _executeWithRetry(
                () =>
                    withTimeout(
                        () => availabilityTimeSlots.getAvailabilityTimeSlot(getPayload),
                        WATCHDOGTIMEOUTMS,
                        "exactSlot:get"
                    ),
                2,
                300
            );
            rawSlot = result?.timeSlot || null;
        }
        if (requiredResourceId) {
            const verification = await _verifyRequiredStaffViaGet({
                serviceId: resolvedServiceId,
                start,
                end,
                requiredResourceId,
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
        if (
            !normalizedSlot ||
            normalizedSlot.bookable !== true ||
            availableResourceIds.length === 0
        ) {
            return {
                status: "ERROR",
                data: null,
                error: {
                    code: "SLOT_UNAVAILABLE",
                    message: "Selected slot is no longer available."
                }
            };
        }
        if (requiredResourceId && !availableResourceIds.includes(requiredResourceId)) {
            return {
                status: "ERROR",
                data: null,
                error: {
                    code: "STAFF_UNAVAILABLE",
                    message: "Selected staff is no longer available."
                }
            };
        }
        if (earlyServiceConfig?.status === "SUCCESS" && earlyServiceConfig?.data) {
            const config = earlyServiceConfig.data;
            const startUtc = getUtcDateFromMadridLocal(start);
            const endUtc = getUtcDateFromMadridLocal(end);
            const actualMinutes = _minutesBetweenUtcDates(startUtc, endUtc);
            const durationRange = config.durationRange;
            if (durationRange && actualMinutes > 0) {
                const { min, max } = durationRange;
                const belowMin = min > 0 && actualMinutes  max;
                if (belowMin || aboveMax) {
                    return {
                        status: "ERROR",
                        data: null,
                        error: {
                            code: "SLOTDURATIONOUTOFRANGE",
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
                                code: "SLOTDURATIONMISMATCH",
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
            const loadMap = await _countStaffLoadForDay(
                dayKey,
                availableResourceIds,
                activeTraceId
            );
            balancedResourceId =
                pickStaffByLowestLoad(availableResourceIds, loadMap) ||
                availableResourceIds.slice().sort()[0];
        }
        return {
            status: "SUCCESS",
            data: {
                slot: {
                    ...normalizedSlot,
                    localStartDate: start,
                    localEndDate: end
                },
                resourceId: balancedResourceId,
                candidateResourceIds: availableResourceIds
            },
            error: null
        };
    } catch (error) {
        log.warn("Exact slot revalidation failed", {
            traceId: activeTraceId,
            serviceId: String(resolvedServiceId),
            start,
            end,
            message: error?.message
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
