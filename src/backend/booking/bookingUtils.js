/*
=============================================================================
MODULE: backend/booking/bookingUtils.js
VERSION: v5010.1-BOOKINGS-ALIGN
BASE: v5009-FISCAL-V20.1 + Wix Bookings API alignment pass
STANDARDS: G10 ASCII Strict

RESPONSIBILITY: Helpers compartidos entre reservas, citas, bookingSaga y
                bookingCore. Utilidades puras. Sin acceso a colecciones CMS.

CONTRATOS WIX BOOKINGS REFERENCIADOS:
  - Time Slots V2 (listAvailabilityTimeSlots / getAvailabilityTimeSlot):
      Cada slot incluye availableResources con grupos por resourceTypeId.
      getResourceIdsFromSlot extrae los GUIDs de staff de esos grupos.
      Documentacion:
        https://dev.wix.com/docs/api-reference/business-solutions/bookings/
        time-slots/time-slots-v2/list-availability-time-slots
        https://dev.wix.com/docs/api-reference/business-solutions/bookings/
        time-slots/time-slots-v2/get-availability-time-slot
  - Create Booking (bookings.createBooking):
      bookedEntity.slot exige serviceId, scheduleId, startDate/endDate en
      ISO UTC con Z, resource.id y location.locationType = OWNER_BUSINESS.
      Los add-ons viajan en bookedAddOns a NIVEL RAIZ, no en el slot.
      Documentacion:
        https://dev.wix.com/docs/api-reference/business-solutions/bookings/
        bookings/bookings-writer-v2/create-booking
  - Cancel Booking (bookings.cancelBooking):
      revision es OBLIGATORIO para prevenir conflictos de concurrencia.
      Documentacion:
        https://dev.wix.com/docs/api-reference/business-solutions/bookings/
        bookings/bookings-writer-v2/cancel-booking
  - Duration-range services: para servicios con availabilityConstraints.
      durationRange, customerChoices NO esta soportado; la duracion se
      deriva de localStartDate/localEndDate.

FIXES APLICADOS v5010.1-BOOKINGS-ALIGN:
  - BU-01: computeGapMinutes devuelve null para inputs invalidos, alineado
          con mmUtils.computeGapMinutes. Antes devolvia 0, lo que ocultaba
          errores (0 es un gap valido). Los consumidores deben tratar null
          como error.
  - BU-02: cleanGuidList usa getReferenceId de mmUtils para cubrir todas
          las formas de referencia Wix (_id, id, referenceId, value,
          arrays). Antes solo cubria resourceId, id, _id.
  - BU-03: Header y JSDoc actualizados con referencias explicitas a la
          documentacion oficial de Wix Bookings.

FIXES APLICADOS v5009-FISCAL-V20.1 (heredados):
  - V20-01: sin cambios funcionales.

FIXES APLICADOS v5008.3 (heredados):
  - FIX-18: cleanGuid, cleanGuidList.
  - FIX-26: numberOrZero, booleanValue.
  - FIX-16: toUtcRange.
  - FIX-17: validateSlotDuration.
  - FIX-R2: pickStaffByLowestLoad (balanceo de carga staff).
=============================================================================
*/

import {
    _safeTrim,
    _looksLikeGuid,
    _normalizeLocalIsoStr,
    getUtcDateFromMadridLocal,
    getReferenceId,
} from "public/mmUtils";

import { logger } from "backend/logger";

const log = logger;

// =============================================================================
// BLOQUE 1 - GUID Y COERCION
// =============================================================================

export function cleanGuid(value, errorCode = "INVALID_GUID") {
    const clean = _safeTrim(value);

    if (!clean || !_looksLikeGuid(clean)) {
        throw new Error(`${errorCode}: GUID invalido o ausente`);
    }

    return clean;
}

/**
 * BU-02: lista de GUIDs validos desde multiples formas de referencia Wix.
 * Formas admitidas: Array<GUID> | CSV | Array<objeto referencia>.
 *
 * Delega en getReferenceId de mmUtils, que cubre _id, id, referenceId,
 * value y arrays anidados. Antes solo cubria resourceId, id, _id.
 *
 * AVISO DE IDENTIDAD (mmUtils):
 *   ServiciosCatalogo.availableStaff es MULTI_REFERENCE a Members. Esta
 *   funcion devuelve staffMemberId, NO resourceId. La resolucion
 *   staffMemberId -> resourceId se ejecuta en backend/staff.js
 *   (getStaffDisplayName, getStaffScheduleId). No enviar el resultado
 *   directamente a resourceIds de Wix Bookings V2.
 */
export function cleanGuidList(value) {
    const source = Array.isArray(value)
        ? value
        : typeof value === "string"
            ? value.split(",")
            : [];

    return Array.from(
        new Set(
            source
                .map((item) => getReferenceId(item))
                .map((id) => _safeTrim(id))
                .filter((id) => _looksLikeGuid(id))
        )
    );
}

// =============================================================================
// BLOQUE 1B - HELPERS CANONICOS DE SLOT Y PAIR TOKEN
//
// Unicas implementaciones de:
//   - normalizacion de forma de slot (normalizeSlotShape)
//   - extraccion de resourceIds de staff (getResourceIdsFromSlot)
//   - huella canonica del par dual (_buildPairFingerprint)
//
// Precedencia de modulo segun regla FASE 2:
//   mmUtils > bookingUtils > core > web.
// =============================================================================

/**
 * Huella canonica del par dual (CORE-05 / SAGA-02).
 *
 * Debe ser IDENTICA en los tres puntos donde se genera o consume un
 * pairToken:
 *   1. reservas.web._getCertifiedDualSlotsInternal (emisor en disponibilidad)
 *   2. bookingSaga._resolveUnifiedPairToken        (consumidor/reemisor)
 *   3. DualSlotCache.pairToken                     (persistencia)
 *
 * Los 8 campos son obligatorios por contrato (los opcionales se serializan
 * como cadena vacia). Cualquier cambio en el orden o contenido de los campos
 * rompe la correlacion y la idempotencia.
 */
export function _buildPairFingerprint({
    serviceId,
    linkedPhases,
    dateYmd,
    f1Start,
    f1End,
    f2Start,
    f2End,
    resourceId,
} = {}) {
    return [
        _safeTrim(serviceId) || "",
        _safeTrim(linkedPhases) || "",
        _safeTrim(dateYmd) || "",
        _safeTrim(f1Start) || "",
        _safeTrim(f1End) || "",
        _safeTrim(f2Start) || "",
        _safeTrim(f2End) || "",
        _safeTrim(resourceId) || "",
    ].join("|");
}

/**
 * Normaliza la forma de un slot Time Slots V2: si llega envuelto en
 * { slot: {...} }, fusiona el slot interno con el contenedor (el contenedor
 * manda). Idempotente sobre slots ya planos.
 */
export function normalizeSlotShape(slot) {
    if (!slot || typeof slot !== "object") return null;
    if (slot.slot && typeof slot.slot === "object") {
        return { ...slot.slot, ...slot };
    }
    return slot;
}

/**
 * Extrae los resourceIds GUID del grupo de staff de un slot (formato plano o
 * envuelto), deduplicados. Fallback: resource directo / resourceId plano.
 *
 * Alineado con Time Slots V2 (availableResources):
 *   https://dev.wix.com/docs/api-reference/business-solutions/bookings/
 *   time-slots/time-slots-v2/list-availability-time-slots
 *
 * Cada grupo de availableResources tiene resourceTypeId y resources[].
 * Wix devuelve variantes segun version de API:
 *   group.resourceTypeId | group.resourceType.id | group.resourceType._id |
 *   group.typeId
 * Y cada resource puede venir como:
 *   resource.id | resource._id | resource.resourceId
 *
 * @param {object} slot slot crudo o normalizado
 * @param {string} staffResourceTypeId id del tipo de recurso STAFF (API.*)
 */
export function getResourceIdsFromSlot(slot, staffResourceTypeId) {
    const normalizedSlot = normalizeSlotShape(slot);
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
        const staffGroup = groups.find((group) => {
            const typeId =
                group?.resourceTypeId ||
                group?.resourceType?.id ||
                group?.resourceType?._id ||
                group?.typeId;

            return String(typeId) === String(staffResourceTypeId);
        });

        if (staffGroup) {
            return Array.from(
                new Set(
                    (staffGroup.resources || [])
                        .map((resource) =>
                            _safeTrim(
                                resource?.id || resource?._id || resource?.resourceId
                            )
                        )
                        .filter((resourceId) => _looksLikeGuid(resourceId))
                )
            );
        }
    }

    const directId = _safeTrim(
        normalizedSlot.resource?.id ||
        normalizedSlot.resource?._id ||
        normalizedSlot.resource?.resourceId ||
        normalizedSlot.resourceId
    );
    return _looksLikeGuid(directId) ? [directId] : [];
}

export function numberOrZero(value) {
    const number = Number(value);

    return Number.isFinite(number) && number >= 0
        ? number
        : 0;
}

export function booleanValue(...values) {
    return values.some((value) => value === true);
}

// =============================================================================
// BLOQUE 2 - GAP Y UTC RANGES
// =============================================================================

/**
 * BU-01: gap entre fases en minutos.
 *
 * Devuelve null cuando los instantes no son validos. Un gap ilegible nunca
 * debe degradarse a 0, porque 0 es un gap valido y ocultaria el error.
 *
 * Alineado con mmUtils.computeGapMinutes.
 *
 * @param {Date} f1EndUtc   fin de fase 1 en UTC
 * @param {Date} f2StartUtc inicio de fase 2 en UTC
 * @returns {number|null}   gap en minutos >= 0, o null si invalido
 */
export function computeGapMinutes(f1EndUtc, f2StartUtc) {
    if (!(f1EndUtc instanceof Date) || !(f2StartUtc instanceof Date)) {
        return null;
    }

    if (Number.isNaN(f1EndUtc.getTime()) || Number.isNaN(f2StartUtc.getTime())) {
        return null;
    }

    const milliseconds =
        f2StartUtc.getTime() - f1EndUtc.getTime();

    return Math.max(0, Math.round(milliseconds / 60000));
}

export function toUtcRange(startLocal, endLocal) {
    const startUtc = getUtcDateFromMadridLocal(
        _normalizeLocalIsoStr(startLocal)
    );

    const endUtc = getUtcDateFromMadridLocal(
        _normalizeLocalIsoStr(endLocal)
    );

    if (!startUtc || !endUtc) {
        return null;
    }

    if (endUtc.getTime() <= startUtc.getTime()) {
        return null;
    }

    return { startUtc, endUtc };
}

// =============================================================================
// BLOQUE 3 - DURATION RANGE
// =============================================================================

/**
 * Lee el durationRange del servicio.
 *
 * Alineado con la documentacion de Wix Bookings:
 *   "For services configured with a duration range
 *    (availabilityConstraints.durationRange), customerChoices is not
 *    supported. The duration is derived from the localStartDate and
 *    localEndDate specified in the request."
 *
 * Fuentes aceptadas (por orden): availabilityConstraints.durationRange,
 * item.durationRange, item.data.durationRange, item.fields.durationRange.
 *
 * @returns {{min: number, max: number}|null} null si no hay rango valido.
 */
export function readDurationRange(item) {
    const constraints =
        item?.availabilityConstraints ||
        item?.data?.availabilityConstraints ||
        item?.fields?.availabilityConstraints;

    const range =
        constraints?.durationRange ||
        item?.durationRange ||
        item?.data?.durationRange ||
        item?.fields?.durationRange;

    if (!range || typeof range !== "object") {
        return null;
    }

    const min = Number(
        range.minDuration ??
        range.min ??
        0
    ) || 0;

    const rawMax = Number(
        range.maxDuration ??
        range.max ??
        0
    ) || 0;

    const max = rawMax > 0 ? rawMax : Infinity;

    if (min <= 0 && max === Infinity) {
        return null;
    }

    if (max !== Infinity && max <= min) {
        return null;
    }

    return { min, max };
}

// =============================================================================
// BLOQUE 4 - DURACION EFECTIVA
// =============================================================================

/**
 * Duracion esperada del slot reservable.
 *
 * Para servicios duales (allowCombine), el slot reservable corresponde a la
 * fase 1. Para servicios simples, se usa phase1Duration o totalDuration.
 *
 * @param {object} serviceConfig DTO de _mapServiceImport2ToUX.
 * @returns {number} minutos esperados (0 si no hay config).
 */
export function resolveExpectedSlotMinutes(serviceConfig) {
    if (!serviceConfig) {
        return 0;
    }

    if (serviceConfig.allowCombine === true) {
        return Number(
            serviceConfig.phase1Duration || 0
        ) || 0;
    }

    return (
        Number(serviceConfig.phase1Duration || 0) ||
        Number(serviceConfig.totalDuration || 0) ||
        Number(
            serviceConfig.metadata?.timing?.estimatedTotal || 0
        ) ||
        0
    );
}

/**
 * Resuelve la duracion de la fase 2 de un servicio dual, siguiendo la
 * cadena de linkedPhases con deteccion de ciclos.
 *
 * @param {string} linkedServiceId GUID del servicio enlazado.
 * @param {string} traceId         Trazabilidad.
 * @param {Set}    visited         Set de IDs visitados (deteccion de ciclos).
 * @param {function} resolver      Funcion async que devuelve {status, data}.
 * @returns {Promise<number>}      Minutos de fase 2, o 0 si invalido/ciclo.
 */
export async function resolveLinkedPhase2Duration(
    linkedServiceId,
    traceId,
    visited = new Set(),
    resolver
) {
    const linkedId = _safeTrim(linkedServiceId);

    if (
        !_looksLikeGuid(linkedId) ||
        typeof resolver !== "function"
    ) {
        return 0;
    }

    if (visited.has(linkedId)) {
        log.warn(
            "Cycle detected in linkedPhases chain",
            { traceId, linkedId, visited: Array.from(visited) }
        );
        return 0;
    }

    visited.add(linkedId);

    const result = await resolver(
        linkedId,
        traceId
    );

    if (
        result?.status !== "SUCCESS" ||
        !result?.data
    ) {
        return 0;
    }

    const service = result.data;

    return (
        Number(service.phase1Duration || 0) ||
        Number(service.totalDuration || 0) ||
        Number(service.metadata?.timing?.estimatedTotal || 0) ||
        0
    );
}

// =============================================================================
// BLOQUE 5 - VALIDACION DE DURACION DE SLOT
// =============================================================================

/**
 * Valida que la duracion real de un slot coincida con la configuracion del
 * servicio (rango o duracion exacta).
 *
 * @param {object} params
 * @param {object} params.serviceConfig DTO del servicio.
 * @param {string} params.startLocal    inicio local (ISO sin Z).
 * @param {string} params.endLocal      fin local (ISO sin Z).
 * @returns {{ok: boolean, code: string|null, actualMinutes: number,
 *            expectedMinutes: number|null, min: number|null,
 *            max: number|null}}
 */
export function validateSlotDuration({
    serviceConfig,
    startLocal,
    endLocal,
}) {
    const result = {
        ok: true,
        code: null,
        actualMinutes: 0,
        expectedMinutes: null,
        min: null,
        max: null,
    };

    if (!serviceConfig || typeof serviceConfig !== "object") {
        return result;
    }

    const startUtc = getUtcDateFromMadridLocal(
        _normalizeLocalIsoStr(startLocal)
    );

    const endUtc = getUtcDateFromMadridLocal(
        _normalizeLocalIsoStr(endLocal)
    );

    if (!startUtc || !endUtc) {
        return result;
    }

    const diffMs = endUtc.getTime() - startUtc.getTime();

    if (!Number.isFinite(diffMs) || diffMs <= 0) {
        return result;
    }

    const actualMinutes = Math.round(diffMs / 60000);

    result.actualMinutes = actualMinutes;

    const durationRange = serviceConfig.durationRange;

    if (durationRange) {
        const { min, max } = durationRange;

        result.min = min;
        result.max = max === Infinity ? null : max;

        const belowMin = min > 0 && actualMinutes < min;
        const aboveMax = max !== Infinity && actualMinutes > max;

        if (belowMin || aboveMax) {
            result.ok = false;
            result.code = "SLOT_DURATION_OUT_OF_RANGE";
        }

        return result;
    }

    const expectedMinutes =
        resolveExpectedSlotMinutes(serviceConfig);

    if (expectedMinutes > 0) {
        result.expectedMinutes = expectedMinutes;

        if (Math.abs(actualMinutes - expectedMinutes) > 1) {
            result.ok = false;
            result.code = "SLOT_DURATION_MISMATCH";
        }
    }

    return result;
}

// =============================================================================
// BLOQUE 6 - BALANCEO DE CARGA DE STAFF (FIX-R2)
//
// Elige el recurso con menor carga del mapa loadByResource. En empates,
// orden alfabetico determinista. Si el mapa esta vacio, primer alfabetico.
//
// Uso: reservas.web.js (dual), revalidateExactAvailabilitySlot cuando no
// hay requiredResourceId y hay multiples candidatos.
// =============================================================================

export function pickStaffByLowestLoad(candidates, loadByResource) {
    const ids = Array.isArray(candidates)
        ? Array.from(
            new Set(
                candidates
                    .map((id) => _safeTrim(id))
                    .filter((id) => _looksLikeGuid(id))
            )
        )
        : [];

    if (ids.length === 0) {
        return null;
    }

    const loadMap =
        loadByResource && typeof loadByResource === "object"
            ? loadByResource
            : {};

    const sorted = ids.slice().sort((a, b) => a.localeCompare(b));

    let best = sorted[0];
    let bestLoad = Number(loadMap[best] || 0);

    for (let i = 1; i < sorted.length; i += 1) {
        const id = sorted[i];
        const load = Number(loadMap[id] || 0);

        if (load < bestLoad) {
            best = id;
            bestLoad = load;
        }
    }

    return best;
}
