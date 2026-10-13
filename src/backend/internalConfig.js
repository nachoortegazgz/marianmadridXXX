/*
MODULE: backend/internalConfig.js
VERSION: v11.1-ALIGNED
BASE: v11.0-SSOT-CLEAN + BIBLIA v10 §6.3 / §8 + cms.v8
RESPONSIBILITY: SSOT unico de constantes backend. Todo modulo importa desde aqui;
                nunca se hardcodean strings de coleccion, enum, GUID o timeout.
STANDARDS: G10 ASCII estricto. Cero aliases puros. Cero legacy en escritura.

FIXES v11.1:
  IC-01 (P0) Siete SyntaxError por identificadores partidos restaurados:
         AVAILABILITY_CACHE_TTL_MS, Object.freeze, FISCAL_RECOVERY_BATCH_SIZE,
         DEFAULT_MANAGER_EMAIL, TRANSACTION_MAX_WAIT_MS, isValidGuid,
         NEGATIVE_INVENTORY_MOVEMENT_TYPES.
  IC-02 (P0) Espacio final eliminado en TODOS los literales. Con espacio:
         queryItems no encuentra la coleccion, BOOKING_FIELDS escribe campo
         fantasma, CONTROL_TYPE.SLOT_LOCK es rechazado por assertValidEnum,
         BOOKING_TYPE.DUAL_F1 no normaliza, API.STAFF_RESOURCE_TYPE_ID con
         espacio hace que Wix no devuelva recursos.
  IC-03 (P0) Anadido STAFF_DEFAULT_NAME. reservas.web lo importa; export ausente
         en ESM = SyntaxError = modulo de disponibilidad muerto.
  IC-08 (P1) Anadidos DATOS_FISCALES_FIELDS, RECORD_TYPE.STAFF_CONFIG y
         BOOKINGS_SCHEDULE_ID para la migracion de MapaStaff a DatosFiscales.
  IC-09 (P1) Anadidos FORBIDDEN_COLLECTIONS (BIBLIA §6), EU_VAT_PREFIXES (27
         prefijos VIES) y LEGACY_BOOKING_STATUS_VALUES (Matriz §2, lectura only).

PENDIENTE DE DECISION (constantes de negocio, no se cambian unilateralmente):
  IC-04: SLOT_SEARCH.MINUTOS_TOLERANCIA=120 vs mmUtils espejo=10. Verificar
         contra BIBLIA §3.2.1 f12 y sincronizar el espejo.
  IC-05: WATCHDOG_MS=180000 + retry(2) = peor caso 540s >> frontend 60s.
         Anadir AVAILABILITY_MS cuando exista consumidor en reservas.web.
  IC-06: TRANSACTION_MAX_WAIT_MS=3000 insuficiente para saga dual (~50s).
         Recomendado 12000 tras validacion UX.
  MAPA_STAFF: coleccion suprimida. NO se reexporta. Si algun consumidor vivo
         aun lo referencia, corregir el consumidor, no restaurar el export:
         grep -rn "MAPA_STAFF\|MapaStaff" src/backend src/pages
*/

// =============================================================================
// BLOQUE 1 - STAFF ACTIVO (BIBLIA §4.2)
// =============================================================================
export const STAFF = Object.freeze({
    IDS: Object.freeze([
        "e556070a-6d6a-402e-8422-11133033ea76",
        "07f7344f-e7e4-4c53-854b-47fd82ac8d40",
        "9b905bfd-1a09-485d-9273-a24a20dfe648"
    ]),
    RESOURCE_TO_DISPLAY: Object.freeze({
        "e556070a-6d6a-402e-8422-11133033ea76": "MARIAN MADRID",
        "07f7344f-e7e4-4c53-854b-47fd82ac8d40": "ANDREA STAFF",
        "9b905bfd-1a09-485d-9273-a24a20dfe648": "ALBA STAFF"
    })
});

/**
 * IC-03: nombre visible por defecto cuando no hay ficha resoluble.
 * Unico consumidor canonico: reservas.web._getStaffDisplayNamePublic.
 */
export const STAFF_DEFAULT_NAME = "Profesional";

// =============================================================================
// BLOQUE 2 - COLECCIONES CMS (BIBLIA §8)
// =============================================================================
export const BUSINESS_COLLECTIONS = Object.freeze({
    DATOS_FISCALES: "DatosFiscales",
    CAJA_ACTUAL: "CajaActual",
    MOVIMIENTOS_CAJA: "MovimientosCaja",
    CITAS_F2: "CitasF2",
    LIBRO_ASIENTOS_CONTABLES_DETALLE: "LibroAsientosContablesDetalle",
    HISTORICO_CIERRES_Z: "HistoricoCierresZ",
    SERVICIOS_CATALOGO: "ServiciosCatalogo",
    COMPLEMENTOS_CATALOGO: "ComplementosCatalogo",
    REGISTROS_HORARIOS_STAFF: "RegistrosHorariosStaff",
    CONTROL_OPERATIVO: "ControlOperativo",
    INVENTARIO_STOCK_VENTA: "InventarioStockVenta",
    MOVIMIENTOS_INVENTARIO: "MovimientosInventario"
});

export const OPERATIONAL_COLLECTIONS = Object.freeze({
    CONTROL_OPERATIVO: "ControlOperativo"
});

/**
 * IC-09: BIBLIA §6. Colecciones eliminadas y redirigidas. Los hooks de data.js
 * deben devolver FISCAL_VIOLATION ante cualquier intento de escritura.
 */
export const FORBIDDEN_COLLECTIONS = Object.freeze([
    "AsientosContables",
    "EventosSistemaFacturacion",
    "FacturasRecibidas",
    "ConfiguracionFiscal",
    "LibroRegistroFacturasRecibidas",
    "LibroRegistroFacturasExpedidas",
    "PlanCuentasContables",
    "CategoriasServicio",
    "SlotLocks",
    "ProcessedWebhookEvents",
    "RateLimitBlocks",
    "BookingTransactions",
    "CompensacionesPendientes",
    "AlertasOperativas",
    "AvailabilityDaysCache",
    "DualSlotCache",
    "SecuenciaTickets",
    "InventarioStockVentaCierre",
    "ProveedoresLista",
    "MapaStaff"
]);

// =============================================================================
// BLOQUE 3 - WIX APP IDS (BIBLIA §3.1 / §20.3)
// =============================================================================
export const APP_IDS = Object.freeze({
    BOOKINGS: "13d21c63-b5ec-5912-8397-c3a5ddb27a97",
    STORES: "215238eb-22a5-4c36-9e7b-e7c08025e04e",
    EVENTS: "140603ad-af8d-84fb-9004-ee174e35054d",
    FORMS_PAYMENTS: "14ce1214-b278-a7e4-1373-00cebd1bef7c",
    INVOICES: "13ee94c1-b635-8505-3391-97919052c16f",
    MEMBERS_AREA: "14cc59bc-f0b7-15b8-e1c7-89ce41d0e0c9",
    GIFT_CARDS: "d80111c5-a0f4-47a8-b63a-65b54d774a27"
});

// =============================================================================
// BLOQUE 4 - SDK CONFIG (BIBLIA §8)
// =============================================================================
export const SDK_CONFIG = Object.freeze({
    TZ: "Europe/Madrid",
    LOCATION_ID: "7a12abfd-bf30-4847-bcdf-00dc573d4802",
    LOCATION_TYPES: Object.freeze({
        TIME_SLOTS: "BUSINESS",
        BOOKINGS_WRITER: "OWNER_BUSINESS"
    }),
    TIMEOUTS: Object.freeze({
        API_MS: 60000,
        BOOKING_CREATION_MS: 50000,
        DUAL_BOOKING_MS: 160000,
        CHECKOUT_MS: 80000,
        CMS_MS: 60000,
        WATCHDOG_MS: 180000,
        WEBHOOK_MS: 120000
    }),
    CACHE: Object.freeze({
        SERVICES_TTL_MS: 600000,
        SLOTS_CACHE_TTL_MS: 120000,
        DUAL_CACHE_TTL_MS: 900000,
        STAFF_TTL_MS: 300000,
        MAX_ENTRIES: 100,
        DAYS_CACHE_VERSION: 1,
        AVAILABILITY_CACHE_TTL_MS: 600000
    }),
    SECURITY: Object.freeze({
        SECRET_CACHE_TTL_MS: 300000,
        RATE_LIMIT_CACHE_CLEANUP_TTL_MS: 60000,
        RATE_LIMIT_CACHE_MAX_ENTRIES: 5000
    }),
    RATE_LIMIT: Object.freeze({
        MAX_REQUESTS: 10,
        WINDOW_MS: 10000,
        BOOKING_MAX_REQUESTS: 5,
        BOOKING_WINDOW_MS: 20000,
        AVAILABILITY_WINDOW_MS: 10000,
        AVAILABILITY_REQUESTER_MAX_REQUESTS: 10,
        AVAILABILITY_GLOBAL_MAX_REQUESTS: 120
    }),
    JOBS: Object.freeze({
        TIMEOUT_MS: 60000,
        AUDIT_RETENTION_DAYS: 90,
        DELETE_BATCH_SIZE: 100,
        DELETE_MAX_PAGES: 10,
        DUAL_CACHE_CLEANUP_LIMIT: 100,
        FISCAL_RECOVERY_BATCH_SIZE: 25,
        HEALTH_CHECK_QUERY_LIMIT: 1000,
        FISCAL_DAILY_MAX_PAGES: 50
    }),
    EVENTS: Object.freeze({
        RETRY_ATTEMPTS: 3,
        RETRY_BASE_BACKOFF_MS: 3000
    }),
    EXTERNAL_HTTP: Object.freeze({
        RATE_LIMIT_MAX_REQUESTS: 20,
        RATE_LIMIT_WINDOW_MS: 10000,
        HMAC_MAX_CLOCK_SKEW_SECONDS: 60,
        CORS_ALLOWED_ORIGINS: Object.freeze([
            "https://www.marianmadrid.es",
            "https://marianmadrid.es"
        ])
    }),
    M365: Object.freeze({ ENABLED: false }),
    ACCOUNTING: Object.freeze({ ENABLED: false }),
    SYNC_BOOKINGS_SERVICES_ENABLED: false,
    DOCUMENTS: Object.freeze({
        DEFAULT_MANAGER_EMAIL: "gestion@marianmadrid.es",
        MAX_EMAIL_ATTACHMENT_BYTES: 3145728,
        MAX_EMAIL_SEND_ATTEMPTS: 3
    })
});

// =============================================================================
// BLOQUE 5 - API (BIBLIA §4.1)
// =============================================================================
export const API = Object.freeze({
    STAFF_RESOURCE_TYPE_ID: "1cd44cf8-756f-41c3-bd90-3e2ffcaf1155"
});

// =============================================================================
// BLOQUE 6 - SINGLETONS
// =============================================================================
export const SINGLETONS = Object.freeze({
    CAJA_PRINCIPAL: "CAJA_PRINCIPAL",
    CAJA_SEQ: "CAJA_SEQ",
    CONFIG_SISTEMA_FISCAL: "CONFIG_SISTEMA_FISCAL"
});

// =============================================================================
// BLOQUE 7 - CONCURRENCY (BIBLIA §3.2.1 V20)
// =============================================================================
export const CONCURRENCY = Object.freeze({
    MS_TTL_MUTEX: 300000,
    MS_LATIDO: 15000,
    MS_TTL_MUTEX_ASIENTO: 60000,
    TRANSACTION_POLL_BASE_MS: 250,
    TRANSACTION_MAX_WAIT_MS: 3000,
    DEFAULT_DURATION_MIN: 30
});

// =============================================================================
// BLOQUE 8 - SLOT SEARCH (BIBLIA §3.2.1)
// IC-04 PENDIENTE: MINUTOS_TOLERANCIA diverge del espejo public/mmUtils.js (10).
// =============================================================================
export const SLOT_SEARCH = Object.freeze({
    MINUTOS_TOLERANCIA: 120,
    MINUTOS_MAX_HUECO_DUAL: 120
});

// =============================================================================
// BLOQUE 9 - ENUMS WIX NATIVOS (BIBLIA §6.1 - ingles, frontera API)
// =============================================================================
export const BOOKING_STATUS = Object.freeze({
    CREATED: "CREATED",
    PENDING: "PENDING",
    CONFIRMED: "CONFIRMED",
    DECLINED: "DECLINED",
    WAITING_LIST: "WAITING_LIST",
    UPDATED: "UPDATED",
    CANCELED: "CANCELED",
    REFUNDED: "REFUNDED"
});

export const PAYMENT_STATUS = Object.freeze({
    UNDEFINED: "UNDEFINED",
    NOT_PAID: "NOT_PAID",
    PENDING_PAYMENT: "PENDING_PAYMENT",
    PENDING_LEDGER: "PENDING_LEDGER",
    PAID: "PAID",
    PARTIALLY_PAID: "PARTIALLY_PAID",
    REFUNDED: "REFUNDED",
    PARTIALLY_REFUNDED: "PARTIALLY_REFUNDED",
    EXEMPT: "EXEMPT"
});

// =============================================================================
// BLOQUE 10 - ENUMS CMS (BIBLIA §6.2 - persistidos en CitasF2)
// Unica fuente de verdad. bookingCore reexporta como CMS_BOOKING_STATUS /
// CMS_PAYMENT_STATUS; NUNCA redefine (CORE-20).
// =============================================================================
export const CITAS_BOOKING_STATUS = Object.freeze({
    PENDING: "PENDING",
    CONFIRMED: "CONFIRMED",
    COMPLETED: "COMPLETED",
    CANCELLED: "CANCELLED",
    NO_SHOW: "NO_SHOW"
});

export const CITAS_PAYMENT_STATUS = Object.freeze({
    UNPAID: "UNPAID",
    PARTIAL: "PARTIAL",
    PAID: "PAID",
    REFUNDED: "REFUNDED"
});

/**
 * IC-09: valores obsoletos segun Matriz §2. Tolerados SOLO en lectura de filas
 * historicas de CitasF2 hasta EOL 31/12/2026 (ADR-06). Nunca se escriben.
 * Incluye tanto las grafias espanolas legacy como los estados ingleses que ya
 * no son canonicos del enum actual (PENDING_PAYMENT / CANCELLED).
 */
export const LEGACY_BOOKING_STATUS_VALUES = Object.freeze([
    "CONFIRMADO",
    "CANCELADO",
    "REEMBOLSADO",
    "PENDIENTE",
    "PAGADO",
    "PENDING_PAYMENT",
    "CANCELLED"
]);

/**
 * Legacy de bookingStatus -> valor canonico BOOKING_STATUS (BIBLIA 12.2).
 * Unico consumidor canonico: data.js CitasF2 hooks (normalizacion defensiva
 * en escritura para absorber el read-path legado hasta la EOL ADR-06).
 */
export const LEGACY_TO_CANONICAL_BOOKING_STATUS = Object.freeze({
    CONFIRMADO: "CONFIRMED",
    PENDIENTE: "PENDING",
    CANCELADO: "CANCELED",
    REEMBOLSADO: "REFUNDED"
});

/**
 * Legacy de paymentStatus -> valor canonico PAYMENT_STATUS.
 */
export const LEGACY_TO_CANONICAL_PAYMENT_STATUS = Object.freeze({
    PAGADO: "PAID",
    PENDIENTE: "PENDING_PAYMENT",
    IMPAGADO: "NOT_PAID",
    PARCIAL: "PARTIALLY_PAID",
    REEMBOLSADO: "REFUNDED"
});

/** Normaliza bookingStatus legacy a canonico; devuelve el valor intacto si no aplica. */
export function normalizeLegacyBookingStatus(value) {
    const v = String(value === null || value === undefined ? "" : value).trim().toUpperCase();
    return LEGACY_TO_CANONICAL_BOOKING_STATUS[v] || value;
}

/** Normaliza paymentStatus legacy a canonico; devuelve el valor intacto si no aplica. */
export function normalizeLegacyPaymentStatus(value) {
    const v = String(value === null || value === undefined ? "" : value).trim().toUpperCase();
    return LEGACY_TO_CANONICAL_PAYMENT_STATUS[v] || value;
}

/**
 * IC-07: estados que no ocupan slot. Contiene CMS (CANCELLED, NO_SHOW) y nativos
 * Wix (CANCELED, DECLINED) porque se aplica sobre filas historicas escritas antes
 * de la frontera CORE-11.
 */
export const INACTIVE_BOOKING_STATUSES = Object.freeze([
    "CANCELLED",
    "CANCELED",
    "DECLINED",
    "NO_SHOW"
]);

// =============================================================================
// BLOQUE 11 - ENUMS NEGOCIO (BIBLIA §6.3 - espanol)
// =============================================================================
export const MOVEMENT_TYPE = Object.freeze({
    COBRO: "COBRO",
    DEVOLUCION: "DEVOLUCION",
    APORTACION: "APORTACION",
    RETIRO: "RETIRO",
    PAGO_PROVEEDOR: "PAGO_PROVEEDOR",
    AJUSTE: "AJUSTE"
});

/**
 * Canal del hecho economico (ADR-09). CHANNEL_TYPE.ONLINE === "ONLINE" coincide
 * con selectedPaymentOption nativo de Wix Bookings. bookingSaga usa este enum
 * para distinguir pago online de presencial (SAGA-11).
 */
export const CHANNEL_TYPE = Object.freeze({
    PRESENCIAL: "PRESENCIAL",
    ONLINE: "ONLINE"
});

/**
 * Medio de pago (BIBLIA §6.3). ATENCION: no tiene valor ONLINE. El canal se
 * expresa con CHANNEL_TYPE; el medio con PAYMENT_METHOD (WIX_PAYMENTS online).
 */
export const PAYMENT_METHOD = Object.freeze({
    EFECTIVO: "EFECTIVO",
    TARJETA: "TARJETA",
    BIZUM: "BIZUM",
    TRANSFERENCIA: "TRANSFERENCIA",
    WIX_PAYMENTS: "WIX_PAYMENTS",
    OTRO: "OTRO"
});

export const TIPO_IMPOSITIVO_VALIDOS = Object.freeze([0, 0.04, 0.10, 0.21]);

export const CLOCK_EVENT_TYPE = Object.freeze({
    ENTRADA: "ENTRADA",
    SALIDA: "SALIDA",
    PAUSA_INICIO: "PAUSA_INICIO",
    PAUSA_FIN: "PAUSA_FIN",
    AJUSTE: "AJUSTE"
});

/**
 * IC-12 (v11.3): alias canonico del enum de fichajes. Los consumidores (tests
 * data.hooks, runners) referencian TIMECLOCK_TYPE; se exporta como unico
 * segundo nombre permitido sobre el mismo objeto congelado (no es un alias de
 * valores, es el handle canónico del contrato RegistrosHorariosStaff).
 */
export const TIMECLOCK_TYPE = CLOCK_EVENT_TYPE;

export const RECORD_TYPE_HORARIOS = Object.freeze({
    REGULAR: "REGULAR",
    AJUSTE: "AJUSTE"
});

/**
 * IC-13 (v11.6): origen de la trazabilidad del fichaje (quien lo registro).
 * Consumidor: horario.web.js (registrarFichaje=SELF, registrarAjusteHorario=MANAGER).
 */
export const CLOCK_REGISTERED_BY = Object.freeze({
    SELF: "SELF",
    MANAGER: "MANAGER"
});

/**
 * IC-13 (v11.6): campos fisicos de RegistrosHorariosStaff (cms.v8.1-FINAL).
 * Unica referencia SSOT; sustituye a literales dispersos en el writer.
 */
export const REGISTROS_HORARIOS_FIELDS = Object.freeze({
    RESOURCE_ID: "resourceId",
    MEMBER_ID: "memberId",
    STAFF_NAME: "staffName",
    RECORDED_AT: "recordedAt",
    RECORDED_TIME: "recordedTime",
    DAY_KEY: "dayKey",
    MONTH_KEY: "monthKey",
    CLOCK_EVENT_TYPE: "clockEventType",
    RECORD_TYPE: "recordType",
    REGISTERED_BY: "registeredBy",
    REGISTERED_BY_MEMBER_ID: "registeredByMemberId",
    ADJUSTMENT_REASON: "adjustmentReason",
    DEVICE_IP_ADDRESS: "deviceIpAddress",
    META: "meta",
    TRACE_ID: "traceId",
    SIGNATURE: "signature"
});

export const INVENTORY_MOVEMENT_TYPE = Object.freeze({
    VENTA: "VENTA",
    DEVOLUCION: "DEVOLUCION",
    AJUSTE: "AJUSTE",
    ENTRADA_STOCK: "ENTRADA_STOCK",
    SALIDA_STOCK: "SALIDA_STOCK",
    TRANSFERENCIA: "TRANSFERENCIA"
});

export const ROL_BOOKINGS = Object.freeze({
    OWNER: "OWNER",
    ADMIN: "ADMIN",
    RECEPTIONIST: "RECEPTIONIST",
    STAFF: "STAFF"
});

export const ROL_WEBSITE = Object.freeze({
    ADMIN: "ADMIN",
    GESTION: "GESTION",
    ESTILISTA: "ESTILISTA"
});

/**
 * BIBLIA 12 / ADR-05 (FASE3): ControlOperativo es la coleccion 8-en-1 que
 * absorbe las 8 colecciones operativas suprimidas. Los 8 subtipos son el
 * esquema objetivo del ADR. Las filas de infraestructura tecnica que no
 * corresponden a ninguno de los 8 origenes historicos (flag de compensacion
 * de la saga y doc de idempotencia de transaccion dual) se reclasifican:
 *   - bookingSaga flag    -> COMPENSATION (procesado por runPendingCompensationsJob)
 *   - bookingCore tx-doc  -> BOOKING_TX   (origen BookingTransactions)
 */
export const CONTROL_TYPE = Object.freeze({
    SLOT_LOCK: "SLOT_LOCK",
    WEBHOOK_EVENT: "WEBHOOK_EVENT",
    RATE_LIMIT: "RATE_LIMIT",
    BOOKING_TX: "BOOKING_TX",
    COMPENSATION: "COMPENSATION",
    ALERT: "ALERT",
    DAYS_CACHE: "DAYS_CACHE",
    DUAL_CACHE: "DUAL_CACHE"
});

/**
 * IC-10 (v11.2): contrato de acceso staff tras la supresion de MapaStaff.
 * Definido aqui (no en Bloque 1) porque depende de ROL_WEBSITE (Bloque 10);
 * en ESM los `const` del mismo modulo se evaluan en orden y referirlo antes
 * de su inicializacion lanza ReferenceError (TDZ).
 * MARIAN_RESOURCE_ID: resourceId Bookings de la identidad manager (STAFF.IDS[0],
 * BIBLIA §4.2). ALLOWED_ROLES: roles de website con acceso a Zona Staff.
 * Consumidores vivos: security.js isStaffCollaborator, staff.js isMarianResource,
 * security.web.js _isMarianManagerIdentity. Datos leidos desde DatosFiscales
 * (recordType=STAFF_CONFIG), NO desde la coleccion suprimida MapaStaff.
 */
export const STAFF_ACCESS = Object.freeze({
    MARIAN_RESOURCE_ID: STAFF.IDS[0],
    ALLOWED_ROLES: Object.freeze([ROL_WEBSITE.ADMIN, ROL_WEBSITE.GESTION])
});

/**
 * Estados de ciclo de vida (BIBLIA 12 + ADR-05). Se listan SOLO valores con
 * consumidor vivo verificado por grep; estados sin escritura no se exportan.
 */
export const CONTROL_STATUS = Object.freeze({
    ACTIVE: "ACTIVE",
    OPEN: "OPEN",
    PENDING: "PENDING",
    PROCESSED: "PROCESSED",
    COMPLETED: "COMPLETED",
    FAILED: "FAILED",
    EXPIRED: "EXPIRED",
    // ADR-05 / parity jobs.config: estados terminales consumidos por
    // cleanAuditLogs (purga semanal 90d) y la bateria crons.jobsConfigParity.
    EXECUTED: "EXECUTED",
    CLOSED: "CLOSED"
});

/**
 * IC-13 (v11.4): metadatos del sistema informatico emisor (Reglamento UE
 * 2024/1173, Art. 9a). Unico consumidor vivo: eventLog._upsertDatosFiscales.
 */
export const COMPUTER_SYSTEM = Object.freeze({
    softwareName: "Witio Booking Suite",
    softwareVersion: "v5011-FISCAL",
    computerSystemIdentifier: "WITIO-CMS-ES-01"
});

/**
 * Estados de ciclo de vida del ledger de caja (MovimientosCaja / cierres).
 * Consumidores vivos: eventLog.js, cajas.web.js y la bateria de tests.
 */
export const ENTRY_STATUS = Object.freeze({
    DRAFT: "DRAFT",
    POSTED: "POSTED",
    LOCKED: "LOCKED"
});

/** Naturaleza PGC de una cuenta contable (Bloque contable, ADR-07). */
export const ACCOUNT_NATURE = Object.freeze({
    ACTIVO: "ACTIVO",
    PASIVO: "PASIVO",
    INGRESO: "INGRESO",
    GASTO: "GASTO"
});

/**
 * Cuentas PGC canonicas usadas por el libro de asientos. Unica referencia
 * de codigos fisicos; los modulos nunca hardcodean numeros de cuenta.
 */
export const ACCOUNTING_ACCOUNT = Object.freeze({
    CAJA: "572000",
    INGRESOS_SERVICIOS: "705000",
    IVA_REPERCUTIDO: "477000",
    CLIENTES: "430000"
});

/** Tipos de factura AEAT (Veri*Factu). 8 valores del cuto 2.1.1. */
export const TIPO_FACTURA = Object.freeze({
    F1: "F1",
    F2: "F2",
    F3: "F3",
    R1: "R1",
    R2: "R2",
    R3: "R3",
    R4: "R4",
    R5: "R5"
});

/** Tipos impositivos validos expresados en porcentaje entero (AEAT cuto). */
export const IVA_RATES = Object.freeze([0, 4, 10, 21]);

export const COMPENSATION_KIND = Object.freeze({
    CANCEL_BOOKING: "CANCEL_BOOKING",
    REFUND_PAYMENT: "REFUND_PAYMENT"
});

export const COMPENSATION_STATUS = Object.freeze({
    PENDING: "PENDING",
    COMPLETED: "COMPLETED",
    FAILED: "FAILED"
});

// =============================================================================
// BLOQUE 12 - ENUMS FISCALES
// =============================================================================
export const RECORD_TYPE = Object.freeze({
    TERCERO: "TERCERO",
    CONFIG_SISTEMA: "CONFIG_SISTEMA",
    /** IC-08: absorbe datos de MapaStaff suprimida que ninguna API Wix provee. */
    STAFF_CONFIG: "STAFF_CONFIG"
});

export const THIRD_PARTY_TYPE = Object.freeze({
    CLIENTE: "CLIENTE",
    PROVEEDOR: "PROVEEDOR",
    STAFF: "STAFF",
    AAPP: "AAPP",
    MIXTO: "MIXTO",
    EMISOR: "EMISOR"
});

export const FISCAL_ROLE = Object.freeze({
    EMISOR: "EMISOR",
    RECEPTOR: "RECEPTOR"
});

export const CASH_REGISTER_STATUS = Object.freeze({
    ABIERTA: "ABIERTA",
    CERRADA: "CERRADA"
});

/**
 * IC-08: campos fisicos de DatosFiscales (cms.v8 §5.1 + cuatro anadidos para
 * absorber MapaStaff). Unica referencia de nombres de campo.
 */
export const DATOS_FISCALES_FIELDS = Object.freeze({
    TAX_ID: "taxId",
    RECORD_TYPE: "recordType",
    THIRD_PARTY_TYPE: "thirdPartyType",
    LEGAL_NAME: "legalName",
    COMMERCIAL_NAME: "commercialName",
    ADDRESS: "address",
    POSTAL_CODE: "postalCode",
    PROVINCE: "province",
    COUNTRY: "country",
    EMAIL: "email",
    PHONE: "phone",
    TAX_REGIME: "taxRegime",
    VERIFACTU_ENABLED: "verifactuEnabled",
    VERIFACTU_VERSION: "verifactuVersion",
    TIPO_USO_POSIBLE_MULTI_OT: "tipoUsoPosibleMultiOT",
    INDICADOR_MULTIPLES_OT: "indicadorMultiplesOT",
    FECHA_INICIO_VERIFACTU: "fechaInicioVerifactu",
    BOOKINGS_RESOURCE_ID: "bookingsResourceId",
    WIX_MEMBER_ID: "wixMemberId",
    BOOKINGS_SCHEDULE_ID: "bookingsScheduleId",
    WEBSITE_ROLE: "websiteRole",
    INTERNAL_NOTES: "internalNotes"
});

/**
 * IC-09: 27 prefijos VIES de Estados miembros UE. Grecia = EL (no GR).
 * Consumidor: validation.isValidNifOrEuVat. No incluye IS/NO/CH (no VIES).
 */
export const EU_VAT_PREFIXES = Object.freeze([
    "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR",
    "DE", "EL", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL",
    "PL", "PT", "RO", "SK", "SI", "ES", "SE"
]);

// =============================================================================
// BLOQUE 13 - BOOKING TYPE (BIBLIA §6.3 + Matriz §2)
// =============================================================================
export const BOOKING_TYPE = Object.freeze({
    SIMPLE: "SIMPLE",
    DUAL_F1: "DUAL_F1",
    DUAL_F2: "DUAL_F2",
    /**
     * Alias de clave legacy (v11.5): los consumidores historicos escriben
     * BOOKING_TYPE.DUALF1 (sin guion). El VALOR es identico al canonico
     * "DUAL_F1" (mismo string congelado), por lo que no se amplía el
     * contrato: solo se preserva el handle de lectura legacy. normalizeBookingType
     * ya aceptaba esa grafia como string.
     */
    DUALF1: "DUAL_F1",
    DUALF2: "DUAL_F2"
});

export const BOOKING_FIELDS = Object.freeze({
    STATUS: "bookingStatus",
    /** Identificador externo de reserva (CitasF2). Unica referencia SSOT. */
    BOOKING_ID: "bookingId"
});

// =============================================================================
// BLOQUE 14 - INTEGRIDAD
// =============================================================================
export const INTEGRITY = Object.freeze({
    LEDGER_SCHEMA_VERSION: "LEDGER_V5_FISCAL"
});

/**
 * IC-11 (v11.3): contrato JWT HS256 consumido por securityEngine.js
 * (generateJWT/verifyJWT). Export ausente en v11.1 = SyntaxError ESM que
 * tumbaba la carga de reservas.web/cajas.web (dto.whitelist) y crons.js
 * (jobsConfigParity). Nombres canonicos post BUG-02: EXPIRATION_MS.
 */
export const JWT = Object.freeze({
    ALGORITHM: "HS256",
    EXPIRATION_MS: 900000
});

// =============================================================================
// BLOQUE 15 - CATALOG STATES (BIBLIA §6.4 - pendiente ADR)
// =============================================================================
export const CATALOG_STATES = Object.freeze({
    ACTIVO: "ACTIVO",
    DRAFT: "DRAFT",
    PUBLISHED: "PUBLISHED",
    ARCHIVED: "ARCHIVED"
});

// =============================================================================
// BLOQUE 16 - HELPERS DE ENUM
// =============================================================================

/**
 * Normaliza al contrato SIMPLE / DUAL_F1 / DUAL_F2. Acepta obsoletos de
 * Matriz §2 (NORMAL, DUAL) y grafias sin guion. Devuelve el valor en
 * mayusculas sin transformar si no pertenece al contrato: assertValidEnum
 * fallara de forma explicita.
 */
export function normalizeBookingType(value) {
    const v = String(value === null || value === undefined ? "" : value).trim().toUpperCase();
    if (v === "NORMAL" || v === "SIMPLE") return BOOKING_TYPE.SIMPLE;
    if (v === "DUAL" || v === "DUAL_F1" || v === "DUALF1") return BOOKING_TYPE.DUAL_F1;
    if (v === "DUAL_F2" || v === "DUALF2") return BOOKING_TYPE.DUAL_F2;
    return v;
}

export function isDualBookingType(value) {
    return value === BOOKING_TYPE.DUAL_F1 || value === BOOKING_TYPE.DUAL_F2;
}

export function isValidGuid(value) {
    const v = String(value === null || value === undefined ? "" : value).trim();
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

// =============================================================================
// BLOQUE 17 - INVENTARIO
// =============================================================================
export const MAGNITUDE = Object.freeze({
    POSITIVE: "POSITIVE",
    NEGATIVE: "NEGATIVE",
    NEUTRAL: "NEUTRAL"
});

export const POSITIVE_INVENTORY_MOVEMENT_TYPES = Object.freeze([
    INVENTORY_MOVEMENT_TYPE.ENTRADA_STOCK,
    INVENTORY_MOVEMENT_TYPE.DEVOLUCION
]);

export const NEGATIVE_INVENTORY_MOVEMENT_TYPES = Object.freeze([
    INVENTORY_MOVEMENT_TYPE.VENTA,
    INVENTORY_MOVEMENT_TYPE.SALIDA_STOCK
]);

export const ITEM_NATURE = Object.freeze({
    SERVICIO: "SERVICIO",
    PRODUCTO: "PRODUCTO"
});

export const CODIGO_IMPUESTO = Object.freeze({
    IVA: "IVA",
    EXENTO: "EXENTO"
});

// =============================================================================
// BLOQUE 18 - FISCALES/EVENTLOG (v5011 hotfix)
// Enums consumidos por eventLog.js / events.js que quedaron huérfanos tras la
// reestructuración del SSOT. Valores según uso real en código vivo y campos
// de colección documentados (MovimientosCaja.correctionReason, ticketBAI).
// =============================================================================

// AEAT TicketBAI — motivo de rectificación (campos TFI: NUMERO_SERIE, OTROS...)
export const CORRECTION_REASON = Object.freeze({
    NUMERO_SERIE: "NUMERO_SERIE",
    REPETICION: "REPETICION",
    OPERACION_NULA: "OPERACION_NULA",
    IMPORTES: "IMPORTES",
    OTROS: "OTROS",
    OTRAS: "OTRAS" // alias usado en events.js:1000 (refund genérico)
});

export const VAT_ACCRUAL_STATUS = Object.freeze({
    DEVENGADO: "DEVENGADO",
    APLICACION_ANTICIPO: "APLICACION_ANTICIPO",
    NO_DEVENGADO: "NO_DEVENGADO"
});

export const EVENT_TYPE = Object.freeze({
    VENTA_LINEA: "VENTA_LINEA",
    COMPRA_LINEA: "COMPRA_LINEA",
    MOV_STOCK: "MOV_STOCK",
    AJUSTE: "AJUSTE",
    CIERRE_Z: "CIERRE_Z",
    RECTIFICATIVA: "RECTIFICATIVA"
});

export const PROJECTION_STATUS = Object.freeze({
    PENDIENTE: "PENDIENTE",
    OK: "OK",
    ERROR: "ERROR"
});
