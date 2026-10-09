/*
=============================================================================
MODULO: backend/dataLegacyAdapter.js
PROPOSITO: Adaptador de compatibilidad TRANSICIONAL.

HALLAZGO QUE ORIGINA ESTE MODULO (depuracion 2026-10):
  14 modulos de backend hacian "import wixData from 'backend/dataAccess'"
  y llamaban a wixData.query(col).eq(...).find(), wixData.insert(col, item,
  opts), etc. (convencion legacy de Velo wix-data). Desde la v11.0-SSOT-
  ALIGNED, backend/dataAccess.js NO tiene "export default" (solo exports
  nombrados: getItem, insertItem, queryItems, wql.*, order.*...), por lo que
  "wixData" resolvia a undefined y CUALQUIER llamada a datos en esos 14
  modulos lanzaba TypeError en tiempo de ejecucion (fallo total, no parcial).

  Modulos afectados (import corregido a este adaptador):
  crons.js, security.web.js, eventLog.js, security.js, audit.js, staff.js,
  inventario.web.js, fiscalAggregator.web.js, horario.web.js, cajas.web.js,
  fiscalDocuments.web.js, events.js, booking/bookingCore.js,
  booking/bookingSaga.js.

DISENO: Reconstruye la interfaz legacy (query/eq/.../find, insert, update,
  save, remove, get, queryReferencedItems) ENCIMA de las primitivas ya
  verificadas contra documentacion oficial en backend/dataAccess.js. No
  reimplementa logica SDK: delega siempre en dataAccess.js.

ESTADO: TRANSICIONAL / DEPRECATED. El objetivo arquitectonico final (ver
  cabecera de dataAccess.js, regla R4: "Cero builder legacy, cero WQL
  string") es migrar cada uno de los 14 modulos listados arriba a las
  funciones nombradas (queryItems, insertItem, wql.*, order.*) y retirar
  este adaptador. NO anadir nuevos consumidores de este archivo.

LIMITACIONES CONOCIDAS (no resolubles por un adaptador, documentadas para
no ocultarlas):
  - .contains(field, value): el SDK v2 NO tiene operador $contains (ni
    coincidencia de subcadena en posicion arbitraria para texto). Este
    adaptador aplica una heuristica:
      * si el nombre de campo termina en "Id"/"Ids" (campo de
        referencia/array de ids, p.ej. linkedBookingIds) -> se traduce a
        $hasSome (equivalente correcto: "el array contiene el valor").
      * en cualquier otro caso (texto libre, p.ej. productName) -> se
        degrada a $startsWith, que SOLO cubre coincidencia de PREFIJO, no
        subcadena. Esto es un CAMBIO DE COMPORTAMIENTO respecto al original
        y debe revisarse manualmente en cada call-site afectado. Ambos
        casos emiten logger.warn en tiempo de ejecucion.
    Call-sites conocidos a fecha de creacion de este adaptador:
      cajas.web.js (linkedBookingIds, campo array -> correcto via $hasSome)
      inventario.web.js (productName, campo texto -> degradado a prefijo)
  - suppressHooks: true se IGNORA. backend/dataAccess.js aplica la regla
    R2 (SSOT-14): los hooks de backend/data.js se ejecutan SIEMPRE, sin
    excepcion, para garantizar inmutabilidad/validez de los ledgers
    fiscales. booking/bookingCore.js invoca wixData.update/insert sobre
    CITAS_COL con { suppressHooks: true } en varios puntos: revisar si esa
    logica de negocio asumia la supresion efectiva de hooks, porque ahora
    NO se suprimen.
  - suppressAuth ya no aplica: toda operacion en dataAccess.js va elevada
    de forma incondicional (R1/R5, auth.elevate). Esta clave se ignora
    silenciosamente (es un no-op, no un error).
=============================================================================
*/

import {
    getItem,
    insertItem,
    updateItem,
    saveItem,
    removeItem,
    queryItems,
    queryReferencedItems as queryReferencedItemsDal,
    wql,
    order,
    CONSISTENCY,
} from "backend/dataAccess";
import { logger } from "backend/logger";

const log = logger;

function _consistencyFromOptions(options) {
    return options && options.consistentRead === true ?
        CONSISTENCY.STRONG :
        undefined;
}

class LegacyQueryBuilder {
    constructor(dataCollectionId) {
        this._collectionId = dataCollectionId;
        this._clauses = [];
        this._sort = [];
        this._limit = undefined;
        this._offset = 0;
    }

    _add(clause) {
        this._clauses.push(clause);
        return this;
    }

    eq(field, value) {
        return this._add(wql.eq(field, value));
    }
    ne(field, value) {
        return this._add(wql.ne(field, value));
    }
    gt(field, value) {
        return this._add(wql.gt(field, value));
    }
    ge(field, value) {
        return this._add(wql.gte(field, value));
    }
    gte(field, value) {
        return this._add(wql.gte(field, value));
    }
    lt(field, value) {
        return this._add(wql.lt(field, value));
    }
    le(field, value) {
        return this._add(wql.lte(field, value));
    }
    lte(field, value) {
        return this._add(wql.lte(field, value));
    }
    hasSome(field, values) {
        return this._add(wql.hasSome(field, Array.isArray(values) ? values : [values]));
    }
    startsWith(field, value) {
        return this._add(wql.startsWith(field, value));
    }
    contains(field, value) {
        const fname = String(field);
        if (/Ids?$/.test(fname)) {
            log.info("DATA_LEGACY_ADAPTER_CONTAINS_AS_HASSOME", {
                dataCollectionId: this._collectionId,
                field: fname,
            });
            return this._add(wql.hasSome(field, [value]));
        }
        log.warn(
            "DATA_LEGACY_ADAPTER_CONTAINS_DEGRADED_TO_PREFIX: sin equivalente " +
            "exacto en SDK v2 ($contains no existe); revisar manualmente", {
                dataCollectionId: this._collectionId,
                field: fname,
            }
        );
        return this._add(wql.startsWith(field, value));
    }
    ascending(field) {
        this._sort.push(...order.asc(field));
        return this;
    }
    descending(field) {
        this._sort.push(...order.desc(field));
        return this;
    }
    limit(n) {
        this._limit = n;
        return this;
    }
    skip(n) {
        this._offset = n;
        return this;
    }

    _filter() {
        if (this._clauses.length === 0) return undefined;
        if (this._clauses.length === 1) return this._clauses[0];
        return wql.and(...this._clauses);
    }

    async find(options = {}) {
        const res = await queryItems({
            dataCollectionId: this._collectionId,
            filter: this._filter(),
            sort: this._sort,
            limit: this._limit,
            offset: this._offset,
            consistency: _consistencyFromOptions(options),
        });
        return {
            items: res.items,
            length: res.items.length,
            totalCount: res.totalCount,
        };
    }

    async count(options = {}) {
        const res = await queryItems({
            dataCollectionId: this._collectionId,
            filter: this._filter(),
            limit: 1,
            offset: 0,
            consistency: _consistencyFromOptions(options),
        });
        return res.totalCount != null ? res.totalCount : 0;
    }
}

const legacyDataAdapter = {
    query(dataCollectionId) {
        return new LegacyQueryBuilder(dataCollectionId);
    },

    async get(dataCollectionId, itemId, options = {}) {
        return await getItem(dataCollectionId, itemId, {
            consistency: _consistencyFromOptions(options),
        });
    },

    // suppressAuth/options adicionales de llamada legacy: no-op, ver cabecera.
    async insert(dataCollectionId, item) {
        return await insertItem(dataCollectionId, item);
    },

    async update(dataCollectionId, item) {
        return await updateItem(dataCollectionId, item);
    },

    async save(dataCollectionId, item) {
        return await saveItem(dataCollectionId, item);
    },

    async remove(dataCollectionId, itemId) {
        await removeItem(dataCollectionId, itemId);
        return { _id: itemId };
    },

    async queryReferencedItems(dataCollectionId, item, fieldName, options = {}) {
        const itemId =
            item && typeof item === "object" ? item._id || item.id : item;
        const resolved = await queryReferencedItemsDal(
            dataCollectionId,
            itemId,
            fieldName, {
                consistency: _consistencyFromOptions(options),
            }
        );
        return { items: resolved };
    },
};

export default Object.freeze(legacyDataAdapter);
