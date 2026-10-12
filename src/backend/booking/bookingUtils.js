/*
MODULE: backend/booking/bookingUtils.js
VERSION: v5008.6-FINGERPRINT-CLEAN
BASE: v5008.5-PAIRTOKEN-CANONICAL
RESPONSIBILITY: Capa de utilidades PURAS del dominio de reservas. Sin acceso a
                CMS, sin SDK de Wix, sin efectos.
                Precedencia declarada: mmUtils > bookingUtils > bookingCore > *.web.js
STANDARDS: G10 ASCII estricto. Imports permitidos: public/mmUtils (primitivas).
           Sin imports de internalConfig ni de backend/logger (ver UTILS-03).

FIXES v5008.6:
  UTILS-01 (P0) PAIR_FINGERPRINT_FIELDS tenia un espacio final en los 8 literales
         (claves 'serviceId', 'linkedPhases' y las seis restantes, todas con
         espacio sobrante al cierre). La huella resultante contenia el nombre de
         campo seguido de espacio antes del igual, en vez de la forma pegada.
         ATENCION: corregirlo CAMBIA el valor de todo pairToken. Ver la nota
         "VENTANA DE DRENAJE" mas abajo antes de publicar.
  UTILS-02 (P1) La huella duplicaba la informacion: un prefijo campo=valor
         concatenado Y _stableSerialize(canonical) con los mismos 8 datos.
         Duplicacion prohibida por BIBLIA 0.5.1. Ahora hay UNA sola
         serializacion canonica (_stableSerialize sobre el objeto de 8 campos).
         _stableSerialize ordena claves, por lo que el resultado no depende del
         orden en que el llamante construyo el objeto.
  UTILS-03 (P2) resolveLinkedPhase2Duration silenciaba por completo el fallo de
         catalogo (catch vacio). Se anade console.warn. No se importa
         backend/logger: este modulo es de utilidades puras y esa dependencia
         romperia la regla de capa. console esta disponible en el runtime Velo.
  UTILS-04 (P1) _buildPairFingerprint usaba String(canonical[field] || "").
         Con || el numero 0 y el booleano false se serializaban como cadena
         vacia. Sustituido por comprobacion explicita de null/undefined.

VENTANA DE DRENAJE OBLIGATORIA (UTILS-01):
  pairToken es a la vez correlacion dual (CitasF2.pairToken) y clave de
  idempotencia (ControlOperativo._id en la transaccion de saga). Al cambiar el
  formato de la huella, un reintento de reserva dual que estuviera EN VUELO
  durante el despliegue generaria un token distinto y no colisionaria con la
  transaccion existente: riesgo de reserva duplicada.
  Procedimiento: desplegar en ventana de bajo trafico y ejecutar antes
  cleanExpiredLocks. No hay reserva dual en vuelo si no hay trafico.

CONTRATO DE HUELLA (invariante, no modificar sin ADR):
  8 campos: serviceId, linkedPhases, dateYmd, f1Start, f1End, f2Start, f2End,
  resourceId. Debe ser IDENTICA en los tres puntos donde se genera o consume un
  pairToken:
    reservas.web._getCertifiedDualSlotsInternal  (emisor en disponibilidad)
    bookingSaga._resolveUnifiedPairToken         (verificador / reemisor)
    CitasF2.pairToken + ControlOperativo._id     (persistencia e idempotencia)

PENDIENTE (no resuelto aqui, requiere edicion de reservas.web.js):
  reservas.web._getResourceIdsFromSlot y _normalizeSlotShape son copias privadas
  de getResourceIdsFromSlot y normalizeSlotShape. Deben delegar en este modulo
  para cerrar la duplicacion (BIBLIA 0.5.1).

EXPORTS SIN CONSUMIDOR VERIFICADO en los tres modulos auditados
(reservas.web, bookingSaga, bookingCore). NO se eliminan: un export ausente en
un modulo ESM provoca SyntaxError en cascada en cualquier consumidor no
inspeccionado (citasManager.web.js, crons.js, tests). Cerrar con:
  grep -rn "normalizeCatalogAddOn\|resolveNativeAddOnIds\|cleanGuidListByKey\|isDualGapWithinLimit\|computeTotalDuration\|validateSlotDuration" src/
Si el comando no devuelve resultados fuera de este fichero, eliminarlos.
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
// HUELLA Y TOKEN DEL PAR DUAL (UTILS-01, UTILS-02, UTILS-04)
// ============================================================================

/**
 * Contrato de huella: 8 campos, nombres exactos. FIX UTILS-01: sin espacio
 * final en los literales. El orden de esta lista fija el orden de insercion en
 * el objeto canonico; _stableSerialize reordena alfabeticamente, por lo que la
 * lista actua como WHITELIST del contrato: ni un campo mas, ni uno menos.
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
 * UTILS-02: huella determinista del par dual. Unica serializacion canonica.
 *
 * Normaliza internamente para que dos llamantes distintos produzcan la misma
 * cadena ante el mismo par:
 *   - texto y GUID: _safeTrim
 *   - instantes locales: _normalizeLocalIsoStr (acepta Date, ISO con Z, ISO local)
 *   - dateYmd: se DERIVA de f1Start normalizado. Si el llamante aporta un
 *     dateYmd valido Y coherente con f1Start se respeta; si falta o discrepa,
 *     gana f1Start. Esta era la unica fuente real de divergencia observada:
 *     reservas.web usaba el dateYmd de la consulta y bookingSaga el de f1Start.
 *
 * UTILS-04: los campos ausentes se serializan como cadena vacia mediante
 * comprobacion explicita de null/undefined. Nunca con || (que convertiria 0 o
 * false en cadena vacia).
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

    // Objeto canonico: exactamente los 8 campos del contrato, en el orden de la
    // whitelist. Cualquier valor no string se convierte de forma explicita.
    const canonical = {};
    for (let i = 0; i < PAIR_FINGERPRINT_FIELDS.length; i += 1) {
        const field = PAIR_FINGERPRINT_FIELDS[i];
        const value = values[field];
        canonical[field] = (value === undefined || value === null) ? "" : String(value);
    }

    return _stableSerialize(canonical);
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
 * Criterio de desempate: el indice mas bajo en la lista de entrada, que proviene
 * del orden de Wix. Nunca devuelve un id fuera de candidateIds.
 * Devuelve null si no hay candidatos: el llamante decide el fallback.
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
 *
 * UTILS-03: el fallo ya no se silencia. Se usa console.warn (no backend/logger)
 * para no introducir una dependencia de capa en un modulo de utilidades puras.
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
        // Un fallo de catalogo no debe abortar la disponibilidad: se devuelve 0 y
        // el llamante aplica su fallback. Se traza aqui porque el llamante no
        // tiene visibilidad de la causa interna.
        console.warn("resolveLinkedPhase2Duration: fallo al consultar el catalogo", {
            traceId: traceId,
            linkedPhases: linkedId,
            error: (error && error.message) || String(error)
        });
        return 0;
    }
}

// ============================================================================
// ADD-ONS (ComplementosCatalogo -> Bookings nativeId)
// ============================================================================
// SIN CONSUMIDOR VERIFICADO en reservas.web / bookingSaga / bookingCore.
// reservas.web usa _normalizeAddon y bookingSaga usa _detectAddons (copias
// privadas). Se conservan exportados por seguridad de carga ESM; cerrar con el
// grep indicado en la cabecera y entonces decidir: o se migra a los consumidores
// a estas funciones (unico hogar canonico) o se eliminan.

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
 * Solo devuelve los que existen en el catalogo del servicio; el resto se
 * devuelve como rechazado para que el llamante decida (fail-closed).
 * El limite es BOOKINGS_ADDON_CONFIG.MAX_POR_RESERVA (5).
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
