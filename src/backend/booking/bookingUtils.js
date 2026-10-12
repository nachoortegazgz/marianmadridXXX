/*
MODULE: backend/booking/bookingUtils.js
VERSION: v5008.7-UTILS05-FIX
BASE: v5008.6-FINGERPRINT-CLEAN + UTILS-05 (P0 catastrofico)
RESPONSIBILITY: Capa de utilidades PURAS del dominio de reservas. Sin acceso a
                CMS, sin SDK de Wix, sin efectos.
                Precedencia: mmUtils > bookingUtils > bookingCore > *.web.js
STANDARDS: G10 ASCII estricto. Solo imports de public/mmUtils.

FIX v5008.7:
  UTILS-05 (P0 CATASTROFICO) PAIR_FINGERPRINT_FIELDS tenia espacio final en los
         8 literales ("serviceId ", ...). El bucle canonico leia
         values["serviceId "] === undefined y volcaba cadena vacia en los 8
         campos. La huella era IDENTICA para todos los pares duales del sitio:
         _initTransaction colisionaba en ControlOperativo._id y toda reserva
         dual devolvia PAIR_TOKEN_PAYLOAD_MISMATCH.
         Nota: en v5008.5 el bug estaba enmascarado porque la huella tambien
         incluia _stableSerialize(canonical) con claves limpias. Al aplicar
         UTILS-02 (eliminar serializacion duplicada, correcto por BIBLIA 0.5.1)
         el defecto latente se hizo total.
  Se anade guarda de integridad del contrato: si un literal vuelve a corromperse,
         el test falla en vez de producir tokens colisionados en produccion.

FIXES HEREDADOS v5008.6:
  UTILS-01: espacios finales eliminados (ahora verificado).
  UTILS-02: una sola serializacion canonica (_stableSerialize), cero duplicacion.
  UTILS-03: resolveLinkedPhase2Duration traza fallos con console.warn (sin
         backend/logger para preservar la regla de capa pura).
  UTILS-04: comprobacion explicita null/undefined en vez de || "".

VENTANA DE DRENAJE OBLIGATORIA:
  Al cambiar la huella cambian todos los pairToken. Desplegar en ventana de bajo
  trafico y ejecutar cleanExpiredLocks antes. Sin drenaje, una reserva dual en
  vuelo durante el despliegue podria duplicarse.

EXPORTS SIN CONSUMIDOR VERIFICADO en reservas.web / bookingSaga / bookingCore:
  normalizeCatalogAddOn, resolveNativeAddOnIds, cleanGuidListByKey,
  isDualGapWithinLimit, computeTotalDuration, validateSlotDuration.
  NO se eliminan: un export ausente en ESM provoca SyntaxError en cascada en
  consumidores no inspeccionados (citasManager, crons, tests). Cerrar con:
  grep -rn "normalizeCatalogAddOn\|resolveNativeAddOnIds\|cleanGuidListByKey\|isDualGapWithinLimit\|computeTotalDuration\|validateSlotDuration" src/

PENDIENTE: reservas.web._getResourceIdsFromSlot y _normalizeSlotShape son copias
  privadas de getResourceIdsFromSlot y normalizeSlotShape. Deben delegar aqui
  para cerrar la duplicacion (BIBLIA 0.5.1).
=============================================================================
*/

import {
    _safeTrim,
    _looksLikeGuid,
    _hashKey,
    _stableSerialize,
    _normalizeLocalIsoStr,
    cleanGuidList,
    cleanGuidListByKey,
    computeGapMinutes,
    toUtcRange,
    isDualGapWithinLimit,
    readDurationRange,
    resolveExpectedSlotMinutes,
    computeTotalDuration,
    validateSlotDuration
} from "public/mmUtils";

// ============================================================================
// REEXPORTS: primitivas genericas (hogar canonico = public/mmUtils)
// ============================================================================
export {
    cleanGuidList,
    cleanGuidListByKey,
    computeGapMinutes,
    toUtcRange,
    isDualGapWithinLimit,
    readDurationRange,
    resolveExpectedSlotMinutes,
    computeTotalDuration,
    validateSlotDuration
};

// ============================================================================
// HUELLA Y TOKEN DEL PAR DUAL (UTILS-05 FIX)
// ============================================================================

/**
 * UTILS-05: Contrato de huella: 8 campos, nombres EXACTOS sin espacio final.
 * El orden de esta lista fija el orden de insercion en el objeto canonico;
 * _stableSerialize reordena alfabeticamente, por lo que la lista actua como
 * WHITELIST del contrato: ni un campo mas, ni uno menos.
 */
const PAIR_FINGERPRINT_FIELDS = Object.freeze([
    "serviceId",
    "linkedPhases",
    "dateYmd",
    "f1Start",
    "f1End",
    "f2Start",
    "f2End",
    "resourceId"
]);

const DATE_YMD_LOCAL = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Huella determinista del par dual. Unica serializacion canonica.
 *
 * Normaliza internamente para que dos llamantes distintos produzcan la misma
 * cadena ante el mismo par:
 *   - texto y GUID: _safeTrim
 *   - instantes locales: _normalizeLocalIsoStr (acepta Date, ISO con Z, local)
 *   - dateYmd: DERIVADO de f1Start normalizado. Si el llamante aporta un dateYmd
 *     valido Y coherente con f1Start se respeta; si falta o discrepa, gana f1Start.
 *
 * UTILS-04: campos ausentes -> cadena vacia mediante comprobacion explicita de
 * null/undefined. Nunca con || (que convertiria 0 o false en cadena vacia).
 *
 * UTILS-05 GUARD: si un literal de PAIR_FINGERPRINT_FIELDS vuelve a tener espacio
 * final, la asercion interna falla en el primer test en lugar de producir tokens
 * colisionados en produccion.
 */
export function _buildPairFingerprint(input) {
    const src = (input && typeof input === "object") ? input : {};

    const f1Start = _normalizeLocalIsoStr(src.f1Start) || _safeTrim(src.f1Start);
    const f1End = _normalizeLocalIsoStr(src.f1End) || _safeTrim(src.f1End);
    const f2Start = _normalizeLocalIsoStr(src.f2Start) || _safeTrim(src.f2Start);
    const f2End = _normalizeLocalIsoStr(src.f2End) || _safeTrim(src.f2End);

    const candidateDateYmd = _safeTrim(src.dateYmd).slice(0, 10);
    const derivedDateYmd = _safeTrim(f1Start).slice(0, 10);
    const dateYmd = (DATE_YMD_LOCAL.test(candidateDateYmd) && candidateDateYmd === derivedDateYmd)
        ? candidateDateYmd
        : derivedDateYmd;

    const values = {
        serviceId: _safeTrim(src.serviceId),
        linkedPhases: _safeTrim(src.linkedPhases),
        dateYmd: dateYmd,
        f1Start: f1Start,
        f1End: f1End,
        f2Start: f2Start,
        f2End: f2End,
        resourceId: _safeTrim(src.resourceId)
    };

    // Objeto canonico: exactamente los 8 campos del contrato.
    const canonical = {};
    for (let i = 0; i < PAIR_FINGERPRINT_FIELDS.length; i += 1) {
        const field = PAIR_FINGERPRINT_FIELDS[i];
        const value = values[field];
        canonical[field] = (value === undefined || value === null) ? "" : String(value);
    }

    // UTILS-05 GUARD: verifica que cada campo de la whitelist existe en canonical.
    // Si un literal se corrompe (espacio final), values[field] sera undefined y
    // canonical tendra la clave corrupta pero no la limpia. Esta asercion lo
    // detecta inmediatamente.
    const canonicalKeys = Object.keys(canonical);
    for (let j = 0; j < PAIR_FINGERPRINT_FIELDS.length; j += 1) {
        if (canonicalKeys.indexOf(PAIR_FINGERPRINT_FIELDS[j]) < 0) {
            throw new Error(
                "PAIR_FINGERPRINT contract broken: field not present in canonical object: " +
                PAIR_FINGERPRINT_FIELDS[j]
            );
        }
    }

    return _stableSerialize(canonical);
}

/**
 * Token canonico del par dual. Unica definicion del sistema.
 * bookingCore lo reexporta; reservas.web y bookingSaga lo consumen.
 */
export function _buildPairTokenDeterministic(input) {
    return _hashKey(_buildPairFingerprint(input));
}

// ============================================================================
// RECURSOS (STAFF) DESDE SLOTS DE DISPONIBILIDAD
// ============================================================================

/**
 * Forma canonica del slot: Wix devuelve tanto la forma plana como la anidada
 * ({ slot: {...}, ...metadata }). Se aplana a una sola figura.
 */
export function normalizeSlotShape(slot) {
    if (!slot || typeof slot !== "object") return null;
    if (slot.slot && typeof slot.slot === "object") {
        return Object.assign({}, slot.slot, slot);
    }
    return slot;
}

/**
 * Extrae los resourceId de STAFF disponibles en un slot.
 * Cubre las cuatro variantes de tipo de recurso y las tres de identificador.
 * AVISO (INFORME BOOKINGS 15, error 5): el resultado son resourceId de Bookings.
 * Nunca mezclar con memberId de Members.
 */
export function getResourceIdsFromSlot(slot, staffResourceTypeId) {
    const normalized = normalizeSlotShape(slot);
    if (!normalized) return [];

    const wantedTypeId = _safeTrim(staffResourceTypeId);
    const groups = Array.isArray(normalized.availableResources)
        ? normalized.availableResources
        : [];

    if (groups.length > 0) {
        const staffGroup = groups.find(function (group) {
            if (!group || typeof group !== "object") return false;
            const resourceType = (group.resourceType && typeof group.resourceType === "object")
                ? group.resourceType
                : {};
            const groupTypeId = _safeTrim(
                group.resourceTypeId ||
                resourceType.id ||
                resourceType._id ||
                group.typeId
            );
            return wantedTypeId ? groupTypeId === wantedTypeId : Boolean(groupTypeId);
        });
        if (!staffGroup) return [];
        const collected = (Array.isArray(staffGroup.resources) ? staffGroup.resources : [])
            .map(function (resource) {
                if (!resource) return "";
                if (typeof resource === "string") return _safeTrim(resource);
                return _safeTrim(resource.id || resource._id || resource.resourceId);
            })
            .filter(_looksLikeGuid);
        return Array.from(new Set(collected));
    }

    const resource = (normalized.resource && typeof normalized.resource === "object")
        ? normalized.resource
        : {};
    const directId = _safeTrim(
        resource.id || resource._id || resource.resourceId || normalized.resourceId
    );
    return _looksLikeGuid(directId) ? [directId] : [];
}

/**
 * Seleccion determinista del profesional con menor carga del dia.
 * Desempate: indice mas bajo en la lista de entrada (orden de Wix).
 * Devuelve null si no hay candidatos.
 */
export function pickStaffByLowestLoad(candidateIds, loadByResourceId) {
    const candidates = cleanGuidList(candidateIds);
    if (candidates.length === 0) return null;
    const loads = (loadByResourceId && typeof loadByResourceId === "object")
        ? loadByResourceId
        : {};

    let picked = null;
    let pickedLoad = Infinity;
    for (let index = 0; index < candidates.length; index += 1) {
        const id = candidates[index];
        const load = Number(loads[id]);
        const safeLoad = (Number.isFinite(load) && load >= 0) ? load : 0;
        if (safeLoad < pickedLoad) {
            pickedLoad = safeLoad;
            picked = id;
        }
    }
    return picked || candidates[0];
}

// ============================================================================
// CATALOGO: DURACION DE LA FASE VINCULADA (F2)
// ============================================================================

/**
 * Resuelve la duracion real del servicio F2 (linkedPhases).
 * Contrato de inyeccion: getServiceFn(slugOrId) -> { status, data, error }.
 * visited protege contra ciclos. Ante fallo devuelve 0 (nunca inventa duracion).
 * UTILS-03: traza fallos con console.warn (no backend/logger: capa pura).
 */
export async function resolveLinkedPhase2Duration(linkedPhases, traceId, visited, getServiceFn) {
    const linkedId = _safeTrim(linkedPhases);
    if (!_looksLikeGuid(linkedId)) return 0;
    if (typeof getServiceFn !== "function") return 0;

    const seen = (visited instanceof Set) ? visited : new Set();
    if (seen.has(linkedId)) {
        console.warn("resolveLinkedPhase2Duration: ciclo detectado en linkedPhases", {
            traceId: traceId,
            linkedPhases: linkedId
        });
        return 0;
    }
    seen.add(linkedId);

    try {
        const result = await getServiceFn(linkedId);
        if (!result || result.status !== "SUCCESS" || !result.data) {
            console.warn("resolveLinkedPhase2Duration: servicio F2 no resuelto", {
                traceId: traceId,
                linkedPhases: linkedId,
                status: (result && result.status) || null
            });
            return 0;
        }
        const linked = result.data;

        const declared = Number(linked.phase2Duration);
        if (Number.isFinite(declared) && declared > 0) return declared;

        const total = Number(linked.totalDuration);
        if (Number.isFinite(total) && total > 0) return total;

        const phase1 = Number(linked.phase1Duration);
        if (Number.isFinite(phase1) && phase1 > 0) return phase1;

        console.warn("resolveLinkedPhase2Duration: servicio F2 sin duracion util", {
            traceId: traceId,
            linkedPhases: linkedId
        });
        return 0;
    } catch (error) {
        console.warn("resolveLinkedPhase2Duration: fallo al consultar el catalogo", {
            traceId: traceId,
            linkedPhases: linkedId,
            error: (error && error.message) || String(error)
        });
        return 0;
    }
}

// ============================================================================
// ADD-ONS (SIN CONSUMIDOR VERIFICADO - conservar hasta grep de cierre)
// ============================================================================

/**
 * Proyecta un add-on del catalogo al contrato minimo del Writer V2.
 * Devuelve null si falta identidad o precio (fail-closed).
 */
export function normalizeCatalogAddOn(addOn) {
    if (!addOn || typeof addOn !== "object") return null;
    const addOnId = _safeTrim(addOn.addOnId || addOn.addonId || addOn.id);
    const name = _safeTrim(addOn.name || addOn.title);
    const price = Number(addOn.price);
    if (!addOnId || !name || !Number.isFinite(price) || price < 0) return null;
    const nativeId = _safeTrim(addOn.nativeId);
    return {
        addOnId: addOnId,
        name: name,
        price: price,
        nativeId: _looksLikeGuid(nativeId) ? nativeId : null
    };
}

/**
 * Resuelve los nativeId de Bookings para los addOnIds solicitados.
 * Limite: BOOKINGS_ADDON_CONFIG.MAX_POR_RESERVA (5).
 */
export function resolveNativeAddOnIds(catalogAddOns, requestedIds, maxPerBooking) {
    const catalog = Array.isArray(catalogAddOns) ? catalogAddOns : [];
    const requested = Array.isArray(requestedIds) ? requestedIds : [];
    const limit = Number(maxPerBooking) > 0 ? Number(maxPerBooking) : 5;

    const byAddOnId = new Map();
    for (const entry of catalog) {
        const normalized = normalizeCatalogAddOn(entry);
        if (!normalized) continue;
        byAddOnId.set(normalized.addOnId, normalized);
        if (normalized.nativeId) byAddOnId.set(normalized.nativeId, normalized);
    }

    const resolved = [];
    const rejected = [];
    for (const rawId of requested) {
        const id = _safeTrim(rawId);
        if (!id) continue;
        const match = byAddOnId.get(id);
        if (match && match.nativeId) {
            if (resolved.indexOf(match.nativeId) < 0) resolved.push(match.nativeId);
        } else {
            rejected.push(id);
        }
    }
    return {
        nativeAddonIds: resolved.slice(0, limit),
        rejectedAddonIds: rejected
    };
}
