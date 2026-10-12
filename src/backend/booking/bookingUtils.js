/*
MODULE: backend/booking/bookingUtils.js
VERSION: v5008.5-PAIRTOKEN-CANONICAL
RESPONSIBILITY: Capa de utilidades PURAS del dominio de reservas. Sin acceso a
                CMS, sin SDK de Wix, sin efectos. Precedencia declarada:
                mmUtils > bookingUtils > bookingCore > *.web.js
STANDARDS: G10 ASCII estricto. Sin imports de backend salvo internalConfig
           (constantes) y public/mmUtils (primitivas).
REGLA ANTI-DUPLICACION (BIBLIA 0.5.1):
  Las primitivas genericas (fechas, gap, duraciones, GUID) NO se reimplementan
  aqui: se reexportan desde public/mmUtils, que es su unico hogar canonico.
  Este modulo solo define lo que es DOMINIO de reservas.

FIXES v5008.5 (D3):
  UTILS-01 (P0) _buildPairTokenDeterministic se define AQUI como unica fuente
         canonica. Antes vivia en bookingCore, lo que obligaba a reservas.web.js
         (capa web) a importar bookingCore (capa core) solo para emitir el token
         del par dual. Con la definicion en la capa de utilidades puras:
           - reservas.web importa desde bookingUtils (web -> utils, permitido)
           - bookingCore reexporta (core -> utils, permitido)
           - bookingSaga lo consume via bookingCore (superficie historica intacta)
         Cero ciclos y cero duplicacion de logica.
  UTILS-02 (P0) _buildPairFingerprint normaliza internamente los 8 campos del
         contrato (trim + _normalizeLocalIsoStr) y deriva dateYmd de f1Start.
         Antes cada llamante normalizaba por su cuenta, de modo que un mismo par
         podia producir dos huellas distintas segun el punto de emision y romper
         la correlacion SUPPLIED/FINGERPRINT y la idempotencia dual.
PENDIENTE (no resuelto aqui, requiere edicion de reservas.web.js):
  reservas.web._getResourceIdsFromSlot es una copia privada de
  getResourceIdsFromSlot. Debe delegar en este modulo para cerrar la duplicacion.
VERIFICAR ANTES DE PUBLICAR (este fichero se entrega reconstruido a partir de sus
consumidores reales; si el fichero vivo exporta algo mas, conservarlo):
  grep -n "from \"backend/booking/bookingUtils\"" -r src | sort -u
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
// Se reexportan para que el dominio de reservas tenga una unica superficie de
// import. No se redefine ninguna logica (BIBLIA 0.5.1).
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
// HUELLA Y TOKEN DEL PAR DUAL (UTILS-01, UTILS-02)
// ============================================================================

/**
 * Contrato de huella: 8 campos, orden canonico fijo. Cualquier cambio en el
 * orden o en el contenido rompe la correlacion entre los tres puntos donde se
 * genera o consume un pairToken:
 *   1. reservas.web._getCertifiedDualSlotsInternal  (emisor en disponibilidad)
 *   2. bookingSaga._resolveUnifiedPairToken         (verificador / reemisor)
 *   3. CitasF2.pairToken + ControlOperativo._id     (persistencia e idempotencia)
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

/**
 * UTILS-02: huella determinista del par dual.
 * Normaliza internamente para que dos llamantes distintos produzcan la misma
 * cadena ante el mismo par:
 *   - GUID y texto: _safeTrim
 *   - instantes locales: _normalizeLocalIsoStr (acepta Date, ISO con Z, ISO local)
 *   - dateYmd: se DERIVA de f1Start normalizado. Si el llamante aporta un dateYmd
 *     valido y coherente se respeta; si falta o discrepa, gana f1Start. Esto
 *     elimina la unica fuente real de divergencia observada (reservas.web usaba
 *     el dateYmd de la consulta y bookingSaga el de f1Start).
 * Los campos opcionales se serializan como cadena vacia, nunca como undefined.
 */
export function _buildPairFingerprint(input) {
    const src = input && typeof input === "object" ? input : {};

    const serviceId = _safeTrim(src.serviceId);
    const linkedPhases = _safeTrim(src.linkedPhases);
    const resourceId = _safeTrim(src.resourceId);

    const f1Start = _normalizeLocalIsoStr(src.f1Start) ||
        _safeTrim(src.f1Start);
    const f1End = _normalizeLocalIsoStr(src.f1End) ||
        _safeTrim(src.f1End);
    const f2Start = _normalizeLocalIsoStr(src.f2Start) ||
        _safeTrim(src.f2Start);
    const f2End = _normalizeLocalIsoStr(src.f2End) ||
        _safeTrim(src.f2End);

    const candidateDateYmd = _safeTrim(src.dateYmd).slice(0, 10);
    const derivedDateYmd = _safeTrim(f1Start).slice(0, 10);
    const dateYmd = /^\d{4}-\d{2}-\d{2}$/.test(candidateDateYmd) &&
        candidateDateYmd === derivedDateYmd
        ? candidateDateYmd
        : derivedDateYmd;

    const canonical = {
        serviceId: serviceId,
        linkedPhases: linkedPhases,
        dateYmd: dateYmd,
        f1Start: f1Start,
        f1End: f1End,
        f2Start: f2Start,
        f2End: f2End,
        resourceId: resourceId
    };

    // _stableSerialize ordena claves: el resultado no depende del orden en que
    // el llamante construyo el objeto.
    return PAIR_FINGERPRINT_FIELDS
        .map(function (field) { return field + "=" + String(canonical[field] || ""); })
        .join("|") + "#" + _stableSerialize(canonical);
}

/**
 * UTILS-01: token canonico del par dual. Unica definicion del sistema.
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
 * Cubre las cuatro variantes de tipo de recurso que devuelve Wix segun version
 * de API y forma del slot:
 *   group.resourceTypeId | group.resourceType.id | group.resourceType._id |
 *   group.typeId
 * y las tres variantes de identificador de recurso:
 *   resource.id | resource._id | resource.resourceId
 * Fallback final: resource directo o resourceId plano en el slot.
 *
 * AVISO (INFORME BOOKINGS 15, error 5): el resultado son resourceId de Bookings.
 * Nunca mezclar con memberId de Members: ServiciosCatalogo.availableStaff era un
 * MULTI_REFERENCE a Members y exigia resolucion previa en backend/staff.js.
 */
export function getResourceIdsFromSlot(slot, staffResourceTypeId) {
    const normalized = normalizeSlotShape(slot);
    if (!normalized) return [];

    const wantedTypeId = _safeTrim(staffResourceTypeId);
    let groups = [];
    if (Array.isArray(normalized.availableResources)) {
        groups = normalized.availableResources;
    }

    if (groups.length > 0) {
        const staffGroup = groups.find(function (group) {
            if (!group || typeof group !== "object") return false;
            const resourceType = group.resourceType && typeof group.resourceType === "object"
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

    const resource = normalized.resource && typeof normalized.resource === "object"
        ? normalized.resource
        : {};
    const directId = _safeTrim(
        resource.id || resource._id || resource.resourceId || normalized.resourceId
    );
    return _looksLikeGuid(directId) ? [directId] : [];
}

/**
 * Seleccion determinista del profesional con menor carga del dia.
 * Criterio de desempate: el indice mas bajo en la lista de entrada, que proviene
 * del orden de Wix. Nunca devuelve un id fuera de candidateIds.
 * Devuelve null si no hay candidatos: el llamante decide el fallback.
 */
export function pickStaffByLowestLoad(candidateIds, loadByResourceId) {
    const candidates = cleanGuidList(candidateIds);
    if (candidates.length === 0) return null;
    const loads = loadByResourceId && typeof loadByResourceId === "object"
        ? loadByResourceId
        : {};

    let picked = null;
    let pickedLoad = Infinity;
    for (let index = 0; index < candidates.length; index += 1) {
        const id = candidates[index];
        const load = Number(loads[id]);
        const safeLoad = Number.isFinite(load) && load >= 0 ? load : 0;
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
 * Resuelve la duracion real del servicio F2 (linkedPhases) cuando el servicio
 * padre no declara phase2Duration o la declara a 0.
 *
 * Contrato de inyeccion: getServiceFn(slugOrId) -> { status, data, error }.
 * Se inyecta para no importar reservas.web.js desde la capa de utilidades
 * (evita el ciclo utils -> web -> utils).
 *
 * `visited` es el conjunto de serviceId ya recorridos: protege contra
 * autorreferencia y contra ciclos A -> B -> A. Ante cualquier ciclo o fallo se
 * devuelve 0 y el llamante aplica su propio fallback; nunca se inventa una
 * duracion (BIBLIA 0.5.4: no se fabrican datos).
 */
export async function resolveLinkedPhase2Duration(linkedPhases, traceId, visited, getServiceFn) {
    const linkedId = _safeTrim(linkedPhases);
    if (!_looksLikeGuid(linkedId)) return 0;
    if (typeof getServiceFn !== "function") return 0;

    const seen = visited instanceof Set ? visited : new Set();
    if (seen.has(linkedId)) return 0;
    seen.add(linkedId);

    try {
        const result = await getServiceFn(linkedId);
        if (!result || result.status !== "SUCCESS" || !result.data) return 0;
        const linked = result.data;

        const declared = Number(linked.phase2Duration);
        if (Number.isFinite(declared) && declared > 0) return declared;

        const total = Number(linked.totalDuration);
        if (Number.isFinite(total) && total > 0) return total;

        const phase1 = Number(linked.phase1Duration);
        if (Number.isFinite(phase1) && phase1 > 0) return phase1;

        return 0;
    } catch (_) {
        // Fallo de catalogo no debe abortar la disponibilidad: 0 y fallback
        // en el llamante. Se traza en el nivel que tiene contexto de negocio.
        return 0;
    }
}

// ============================================================================
// ADD-ONS (ComplementosCatalogo -> Bookings nativeId)
// ============================================================================

/**
 * Proyecta un add-on del catalogo al contrato minimo que consume el Writer V2.
 * Devuelve null si falta identidad o precio: un add-on ilegible no se inyecta
 * (fail-closed, nunca se cobra sin el extra seleccionado).
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
 * Solo devuelve los que existen en el catalogo del servicio: el resto se traza
 * como rechazado. El limite es BOOKINGS_ADDON_CONFIG.MAX_POR_RESERVA (5).
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
        if (match && match.nativeId && resolved.indexOf(match.nativeId) < 0) {
            resolved.push(match.nativeId);
        } else if (!match || !match.nativeId) {
            rejected.push(id);
        }
    }
    return {
        nativeAddonIds: resolved.slice(0, limit),
        rejectedAddonIds: rejected
    };
}
