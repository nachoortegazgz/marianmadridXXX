/*
=============================================================================
MODULE: backend/internalConfig.js
VERSION: v5009-FISCAL-V20.1
BASE: v5008.6-FISCAL + Directriz V20 (IDs nativa en ingles) + SSOT V20.1
RESPONSIBILITY: Single Source of Truth (SSOT) for backend configuration.
STANDARDS: G10 ASCII Strict.

FIXES APLICADOS v5009-FISCAL-V20.1:
  - V20-01: constantes JS renombradas a ingles para alinear con CMS field IDs.
  - V20-02: CITA_FIELDS.STATUS_PAGO -> BOOKING_FIELDS.PAYMENT_STATUS.
  - V20-03: aliases deprecated al final para compatibilidad de imports.
  - V20-04: COMPUTER_SYSTEM consolida configuracion del sistema informatico
            con keys en ingles.
  - V20-05: ACCOUNTING_ACCOUNT keys renombradas a ingles.
  - Herencia v5008.6: FIX-24, FIX-40, FIX-41, I-01..I-03, FIX-FISCAL-02,
    FIX-FISCAL-04, TIPO_MOVIMIENTO.SERVICIO_PROFESIONAL.
=============================================================================
*/

// =============================================================================
// BLOQUE 1 - STAFF ACTIVO
// =============================================================================

const STAFF_RESOURCE_TO_DISPLAY = Object.freeze({
    "e556070a-6d6a-402e-8422-11133033ea76": "Marian Madrid",
    "07f7344f-e7e4-4c53-854b-47fd82ac8d40": "Andrea",
    "9b905bfd-1a09-485d-9273-a24a20dfe648": "Alba",
});

export const STAFF = Object.freeze({
    IDS: Object.freeze(Object.keys(STAFF_RESOURCE_TO_DISPLAY)),
    RESOURCE_TO_DISPLAY: STAFF_RESOURCE_TO_DISPLAY,
});

// =============================================================================
// BLOQUE 2 - COLECCIONES CMS CANONICAS
// =============================================================================

export const COLLECTIONS = Object.freeze({
    ALERTAS_OPERATIVAS: "AlertasOperativas",
    ASIENTOS_CONTABLES: "AsientosContables",
    AVAILABILITY_DAYS_CACHE: "AvailabilityDaysCache",
    BOOKINGS_SERVICE_SYNC_QUEUE: "BookingsServiceSyncQueue",
    BOOKING_TRANSACTIONS: "BookingTransactions",
    CAJA_ACTUAL: "CajaActual",
    CATEGORIAS_SERVICIO: "CategoriasServicio",
    CITAS_F2: "CitasF2",
    COMPENSACIONES_PENDIENTES: "CompensacionesPendientes",
    COMPLEMENTOS_CATALOGO: "ComplementosCatalogo",
    CONFIGURACION_FISCAL: "ConfiguracionFiscal",
    DATOS_FISCALES: "DatosFiscales",
    DUAL_SLOT_CACHE: "DualSlotCache",
    FACTURAS_RECIBIDAS: "FacturasRecibidas",
    HISTORICO_CIERRES_Z: "HistoricoCierresZ",
    INVENTARIO_STOCK_VENTA: "InventarioStockVenta",
    LIBRO_ASIENTOS_CONTABLES_DETALLE: "LibroAsientosContablesDetalle",
    LIBRO_REGISTRO_FACTURAS_EXPEDIDAS: "LibroRegistroFacturasExpedidas",
    LIBRO_REGISTRO_FACTURAS_RECIBIDAS: "LibroRegistroFacturasRecibidas",
    M365_GRAPH_SYNC_QUEUE: "M365GraphSyncQueue",
    MAPA_STAFF: "MapaStaff",
    MOVIMIENTOS_CAJA: "MovimientosCaja",
    MOVIMIENTOS_INVENTARIO: "MovimientosInventario",
    PLAN_CUENTAS_CONTABLES: "PlanCuentasContables",
    PROCESSED_WEBHOOK_EVENTS: "ProcessedWebhookEvents",
    PROVEEDORES_LISTA: "ProveedoresLista",
    RATE_LIMIT_BLOCKS: "RateLimitBlocks",
    REGISTROS_HORARIOS_STAFF: "RegistrosHorariosStaff",
    SERVICIOS_CATALOGO: "ServiciosCatalogo",
    SLOT_LOCKS: "SlotLocks",
});

// =============================================================================
// BLOQUE 3 - WIX APP IDS
// =============================================================================

export const APP_IDS = Object.freeze({
    BOOKINGS: "13d21c63-b5ec-5912-8397-c3a5ddb27a97",
    STORES: "215238eb-22a5-4c36-9e7b-e7c08025e04e",
    EVENTS: "140603ad-af8d-84fb-9004-ee174e35054d",
    FORMS_PAYMENTS: "14ce1214-b278-a7e4-1373-00cebd1bef7c",
    INVOICES: "13ee94c1-b635-8505-3391-97919052c16f",
    MEMBERS_AREA: "14cc59bc-f0b7-15b8-e1c7-89ce41d0e0c9",
    GIFT_CARDS: "d80111c5-a0f4-47a8-b63a-65b54d774a27",
});

// =============================================================================
// BLOQUE 4 - API KEYS Y RECURSOS WIX NATIVOS
// =============================================================================

export const API = Object.freeze({
    STAFF_RESOURCE_TYPE_ID: "1cd44cf8-756f-41c3-bd90-3e2ffcaf1155",
    MARIAN_MANAGEMENT_RESOURCE_ID: "e556070a-6d6a-402e-8422-11133033ea76",
});

// =============================================================================
// BLOQUE 5 - SINGLETONS PROTEGIDOS
// =============================================================================

export const SINGLETONS = Object.freeze({
    CAJA: "CAJA_PRINCIPAL",
});

// =============================================================================
// BLOQUE 6 - CONFIGURACION GLOBAL DEL SDK
// =============================================================================

export const SDK_CONFIG = Object.freeze({
    TZ: "Europe/Madrid",
    LOCATION_ID: "7a12abfd-bf30-4847-bcdf-00dc573d4802",

    LOCATION_TYPES: Object.freeze({
        TIME_SLOTS: "OWNER_BUSINESS",
        BOOKINGS_WRITER: "OWNER_BUSINESS",
    }),

    TIMEOUTS: Object.freeze({
        API_MS: 15000,
        BOOKING_CREATION_MS: 25000,
        DUAL_BOOKING_MS: 40000,
        CHECKOUT_MS: 20000,
        CMS_MS: 15000,
        WATCHDOG_MS: 30000,
        WEBHOOK_MS: 30000,
    }),

    CACHE: Object.freeze({
        SERVICES_TTL_MS: 600000,
        SLOTS_CACHE_TTL_MS: 120000,
        DUAL_CACHE_TTL_MS: 900000,
        STAFF_TTL_MS: 300000,
        MAX_ENTRIES: 100,
        DAYS_CACHE_VERSION: 1,
        AVAILABILITY_CACHE_TTL_MS: 600000,
    }),

    SECURITY: Object.freeze({
        SECRET_CACHE_TTL_MS: 300000,
        RATE_LIMIT_CACHE_CLEANUP_TTL_MS: 60000,
        RATE_LIMIT_CACHE_MAX_ENTRIES: 5000,
    }),

    RATE_LIMIT: Object.freeze({
        MAX_REQUESTS: 20,
        WINDOW_MS: 5000,
        BOOKING_MAX_REQUESTS: 5,
        BOOKING_WINDOW_MS: 10000,
        AVAILABILITY_WINDOW_MS: 5000,
        AVAILABILITY_REQUESTER_MAX_REQUESTS: 12,
        AVAILABILITY_GLOBAL_MAX_REQUESTS: 120,
    }),

    JOBS: Object.freeze({
        TIMEOUT_MS: 30000,
        AUDIT_RETENTION_DAYS: 90,
        DELETE_BATCH_SIZE: 100,
        DELETE_MAX_PAGES: 10,
        DUAL_CACHE_CLEANUP_LIMIT: 100,
        FISCAL_RECOVERY_BATCH_SIZE: 25,
        HEALTH_CHECK_QUERY_LIMIT: 1000,
        FISCAL_DAILY_MAX_PAGES: 50,
        BOOKINGS_SERVICE_SYNC_MAX_ATTEMPTS: 5,
        BOOKINGS_SERVICE_SYNC_BATCH_SIZE: 20,
        BOOKINGS_SERVICE_SYNC_BACKOFF_MS: 300000,
        M365_GRAPH_SYNC_BATCH_SIZE: 20,
        M365_GRAPH_SYNC_MAX_ATTEMPTS: 3,
        M365_GRAPH_SYNC_BACKOFF_MS: 300000,
    }),

    EVENTS: Object.freeze({
        RETRY_ATTEMPTS: 3,
        RETRY_BASE_BACKOFF_MS: 1000,
    }),

    EXTERNAL_HTTP: Object.freeze({
        RATE_LIMIT_MAX_REQUESTS: 20,
        RATE_LIMIT_WINDOW_MS: 5000,
        HMAC_MAX_CLOCK_SKEW_SECONDS: 60,
        CORS_ALLOWED_ORIGINS: Object.freeze([
            "https://www.marianmadrid.es",
            "https://marianmadrid.es",
        ]),
    }),

    M365: Object.freeze({ ENABLED: false }),
    ACCOUNTING: Object.freeze({ ENABLED: false }),

    DOCUMENTS: Object.freeze({
        DEFAULT_MANAGER_EMAIL: "gestion@marianmadrid.es",
        MAX_EMAIL_ATTACHMENT_BYTES: 3145728,
        MAX_EMAIL_SEND_ATTEMPTS: 3,
    }),
});

// =============================================================================
// BLOQUE 7 - CONCURRENCIA, LOCKS Y TRANSACCIONES
// =============================================================================

export const CONCURRENCY = Object.freeze({
    MUTEX_TTL_MS: 300000,
    HEARTBEAT_MS: 15000,
    TRANSACTION_POLL_BASE_MS: 250,
    TRANSACTION_MAX_WAIT_MS: 3000,
    LOCK_CLEANUP_GRACE_MS: 60000,
    MAX_COMPENSATION_RETRIES: 3,
    LEDGER_MUTEX_TTL_MS: 45000,
    LOCK_RELEASE_MIN_REMAINING_MS: 15000,
    DEFAULT_DURATION_MIN: 30,
});

// =============================================================================
// BLOQUE 8 - ENUMS DE NEGOCIO
// =============================================================================

export const TIMECLOCK_TYPE = Object.freeze({
    ENTRADA: "ENTRADA",
    SALIDA: "SALIDA",
    PAUSA_INICIO: "PAUSA_INICIO",
    PAUSA_FIN: "PAUSA_FIN",
    AJUSTE: "AJUSTE",
});

export const MOVEMENT_TYPE = Object.freeze({
    VENTA_EFECTIVO: "VENTA_EFECTIVO",
    VENTA_TARJETA: "VENTA_TARJETA",
    VENTA_BIZUM: "VENTA_BIZUM",
    VENTA_ONLINE: "VENTA_ONLINE",
    VENTA_PRODUCTO: "VENTA_PRODUCTO",
    VENTA_PRODUCTO_ONLINE: "VENTA_PRODUCTO_ONLINE",
    VENTA_TARJETA_REGALO: "VENTA_TARJETA_REGALO",
    CANJE_TARJETA_REGALO: "CANJE_TARJETA_REGALO",
    REEMBOLSO: "REEMBOLSO",
    DEVOLUCION_SERVICIO: "DEVOLUCION_SERVICIO",
    DEVOLUCION_PRODUCTO: "DEVOLUCION_PRODUCTO",
    AJUSTE: "AJUSTE",
    PROPINA: "PROPINA",
    APORTE: "APORTE",
    RETIRO: "RETIRO",
    GASTO: "GASTO",
    PAGO_PROVEEDOR: "PAGO_PROVEEDOR",
    ANTICIPO: "ANTICIPO",
    FONDO_INICIAL: "FONDO_INICIAL",
    SERVICIO_PROFESIONAL: "SERVICIO_PROFESIONAL",
});

export const PAYMENT_METHOD = Object.freeze({
    EFECTIVO: "EFECTIVO",
    TARJETA: "TARJETA",
    BIZUM: "BIZUM",
    ONLINE: "ONLINE",
    TARJETA_REGALO: "TARJETA_REGALO",
});

export const IVA_RATES = Object.freeze({
    GENERAL: 0.21,
    REDUCIDO: 0.1,
    SUPERREDUCIDO: 0.04,
    EXENTO: 0,
});

export const CASH_REGISTER_STATUS = Object.freeze({
    OPEN: "ABIERTA",
    CLOSED: "CERRADA",
});

export const BOOKING_STATUS = Object.freeze({
    CONFIRMED: "CONFIRMED",
    PENDING_PAYMENT: "PENDING_PAYMENT",
    CANCELLED: "CANCELLED",
    CANCELED: "CANCELLED", // Alias deprecated para compatibilidad SSOT v5008.6
    REFUNDED: "REFUNDED",
});

export const PAYMENT_STATUS = Object.freeze({
    UNPAID: "UNPAID",
    NOT_PAID: "NOT_PAID",
    PENDING_PAYMENT: "PENDING_PAYMENT",
    PENDING_LEDGER: "PENDING_LEDGER",
    PAID: "PAID",
    REFUNDED: "REFUNDED",
    PARTIALLY_REFUNDED: "PARTIALLY_REFUNDED",
});

export const COLLABORATOR_ROLES = Object.freeze({
    ADMIN: "ADMIN",
    GESTION: "GESTION",
    ESTILISTA: "ESTILISTA",
});

// =============================================================================
// BLOQUE 9 - CATALOGO Y BUSQUEDA DE SLOTS
// =============================================================================

export const CATALOG_CONFIG = Object.freeze({
    STATES: Object.freeze({
        ACTIVO: "ACTIVO",
        INACTIVO: "INACTIVO",
        BORRADOR: "BORRADOR",
    }),
    CURRENCY: "EUR",
    MAX_TITLE_LENGTH: 160,
    MAX_SUMMARY_LENGTH: 120,
    MAX_DESCRIPTION_LENGTH: 6000,
    MAX_DURATION_MINUTES: 1440,
});

export const SLOT_SEARCH = Object.freeze({
    DIAS_LIMITE: 14,
    TOLERANCE_MINUTES: 10,
    MAX_DUAL_GAP_MINUTES: 120,
});

export const BOOKINGS_ADDON_CONFIG = Object.freeze({
    MAX_PER_BOOKING: 5,
    ACTIVE_NATIVE_IDS: Object.freeze([]),
});

// =============================================================================
// BLOQUE 10 - JWT Y SEGURIDAD
// =============================================================================

export const JWT = Object.freeze({
    ALGORITHM: "HS256",
    EXPIRATION_MS: 1800000,
});

// =============================================================================
// BLOQUE 11 - CAMPOS DE CITA
// =============================================================================

export const BOOKING_FIELDS = Object.freeze({
    STATUS: "status",
    PAYMENT_STATUS: "paymentStatus",
    PAIR_TOKEN: "pairToken",
    SERVICE_ID: "serviceId",
    RESOURCE_ID: "resourceId",
    BOOKING_ID: "bookingId",
    DATE_YMD: "dateYmd",
    META: "meta",
});

// =============================================================================
// BLOQUE 12 - ACCESO Y ROLES
// =============================================================================

export const STAFF_ACCESS = Object.freeze({
    ALLOWED_ROLES: Object.freeze(["ADMIN", "GESTION", "ESTILISTA"]),
    MARIAN_RESOURCE_ID: "e556070a-6d6a-402e-8422-11133033ea76",
});

// =============================================================================
// BLOQUE 13 - DINERO Y TEXTO POR DEFECTO
// =============================================================================

export const CURRENCY_CONFIG = Object.freeze({
    DISPLAY_CURRENCY: "EUR",
    DECIMALS: 2,
});

export const STAFF_DEFAULT_NAME = "Profesional";

// =============================================================================
// BLOQUE 14 - VALIDACION DE ADDONS NATIVOS
// =============================================================================

const GUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateActiveNativeAddonIds() {
    const ids = BOOKINGS_ADDON_CONFIG.ACTIVE_NATIVE_IDS;
    const invalidIds = [];

    for (const id of ids) {
        if (typeof id !== "string" || !GUID_PATTERN.test(id)) {
            invalidIds.push(String(id));
        }
    }

    return {
        valid: invalidIds.length === 0,
        invalidIds,
        count: ids.length,
        isEmpty: ids.length === 0,
    };
}

// =============================================================================
// BLOQUE 15 - CUENTAS PGC (Plan General Contable)
// =============================================================================

export const ACCOUNTING_ACCOUNT = Object.freeze({
    CASH: "570000",
    BANKS: "572000",
    SERVICE_REVENUE: "705000",
    VAT_OUTPUT: "477000",
    VAT_INPUT: "472000",
    SALES_RETURNS: "708000",
    SUPPLIERS: "400000",
    PURCHASES_EXPENSES: "600000",
    SUSPENSE: "555000",

    TAX_IRPF_WITHHOLDING_PAYABLE: "475100",
    TAX_IRPF_WITHHOLDING_RECEIVABLE: "473000",

    TAX_EQUIVALENCE_SURCHARGE: "475800",
    CUSTOMER_ADVANCES: "438000",
});

// =============================================================================
// BLOQUE 16 - TIPOS DE FACTURA AEAT (Registro Facturas)
// =============================================================================

export const AEAT_INVOICE_TYPE = Object.freeze({
    F1: "F1",
    F2: "F2",
    F3: "F3",
    R1: "R1",
    R2: "R2",
    R3: "R3",
    R4: "R4",
    R5: "R5",
});

// =============================================================================
// BLOQUE 17 - MOTIVOS RECTIFICACION
// =============================================================================

export const CORRECTION_REASON = Object.freeze({
    NUMERO_SERIE: "01",
    SERIE: "02",
    BASE_IMPONIBLE: "03",
    CUOTA: "04",
    FECHA: "05",
    IDENTIFICACION: "06",
    DESCUENTO: "07",
    DESTINATARIO: "08",
    OTRAS: "09",
});

// =============================================================================
// BLOQUE 18 - TIPOS DE RETENCION IRPF
// =============================================================================

export const IRPF_WITHHOLDING_RATE = Object.freeze({
    PROFESIONALES_GENERAL: 0.15,
    PROFESIONALES_PRIMEROS_3_ANOS: 0.07,
    MODULOS: 0.01,
    NINGUNA: 0,
});

// =============================================================================
// BLOQUE 19 - ESTADOS DE DEVENGO IVA
// =============================================================================

export const VAT_ACCRUAL_STATUS = Object.freeze({
    DEVENGADO: "DEVENGADO",
    ANTICIPADO: "ANTICIPADO",
    APLICACION_ANTICIPO: "APLICACION_ANTICIPO",
});

// =============================================================================
// BLOQUE 20 - ROL FISCAL
// EMISOR: la empresa emite factura y retiene a un tercero (475100 al HABER).
// RECEPTOR: la empresa recibe factura y un tercero le retiene (473000 al DEBE).
// =============================================================================

export const FISCAL_ROLE = Object.freeze({
    EMISOR: "EMISOR",
    RECEPTOR: "RECEPTOR",
});

// =============================================================================
// BLOQUE 21 - PREFIJOS VAT UE
// =============================================================================

export const EU_VAT_PREFIXES = Object.freeze([
    "AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "EL", "ES",
    "FI", "FR", "HR", "HU", "IE", "IT", "LT", "LU", "LV", "MT",
    "NL", "PL", "PT", "RO", "SE", "SI", "SK", "XI",
]);

// =============================================================================
// BLOQUE 22 - TIPOS DE EVENTO (event sourcing)
// =============================================================================

export const EVENT_TYPE = Object.freeze({
    VENTA_LINEA:   "VENTA_LINEA",
    COMPRA_LINEA:  "COMPRA_LINEA",
    CIERRE_Z:      "CIERRE_Z",
    AJUSTE:        "AJUSTE",
    RECTIFICATIVA: "RECTIFICATIVA",
    MOV_STOCK:     "MOV_STOCK",
});

// =============================================================================
// BLOQUE 23 - NATURALEZA DE ITEM (catalogo)
// =============================================================================

export const ITEM_NATURE = Object.freeze({
    SERVICIO_PROPIO: "SERVICIO_PROPIO",
    PRODUCTO_VENTA:  "PRODUCTO_VENTA",
    PRODUCTO_USO:    "PRODUCTO_USO",
    GASTO_FIJO:      "GASTO_FIJO",
});

// =============================================================================
// BLOQUE 24 - TIPO DE TERCERO
// =============================================================================

export const THIRD_PARTY_TYPE = Object.freeze({
    CLIENTE:   "CLIENTE",
    PROVEEDOR: "PROVEEDOR",
    STAFF:     "STAFF",
    AAPP:      "AAPP",
    MIXTO:     "MIXTO",
});

// =============================================================================
// BLOQUE 25 - ESTADO DE PROYECCION
// =============================================================================

export const PROJECTION_STATUS = Object.freeze({
    PENDIENTE: "PENDIENTE",
    OK:        "OK",
    ERROR:     "ERROR",
});

// =============================================================================
// BLOQUE 26 - SISTEMA INFORMATICO (Verifactu)
// Fallback si ConfiguracionFiscal.computerSystem esta vacio.
// =============================================================================

export const COMPUTER_SYSTEM = Object.freeze({
    computerSystemName:       "Marian Madrid Velo",
    computerSystemId:         "MM-VELO-001",
    version:                  "v5009",
    installationNumber:       "1",
    possibleUseOnlyVerifactu: "S",
    possibleUseMultiOT:       "N",
    multipleOTIndicator:      "N",
    producerTaxId:            "B12345678",
    producerLegalName:        "Marian Madrid SL",
});

// =============================================================================
// BLOQUE 27 - ALIASES DEPRECATED
//
// Mantienen compatibilidad con consumidores que aun importan los nombres
// antiguos. Se eliminaran en v5010 tras migracion completa de todos los
// modulos backend.
// =============================================================================

/** @deprecated Usar TIMECLOCK_TYPE */
export const TIPO_FICHAJE = TIMECLOCK_TYPE;
/** @deprecated Usar MOVEMENT_TYPE */
export const TIPO_MOVIMIENTO = MOVEMENT_TYPE;
/** @deprecated Usar PAYMENT_METHOD */
export const FORMA_PAGO = PAYMENT_METHOD;
/** @deprecated Usar CASH_REGISTER_STATUS */
export const CAJA_STATUS = CASH_REGISTER_STATUS;
/** @deprecated Usar BOOKING_STATUS */
export const ESTADO_CITA = BOOKING_STATUS;
/** @deprecated Usar PAYMENT_STATUS */
export const ESTADO_PAGO = PAYMENT_STATUS;
/** @deprecated Usar COLLABORATOR_ROLES */
export const COLLAB_ROLES = COLLABORATOR_ROLES;
/** @deprecated Usar CATALOG_CONFIG */
export const SERVICE_CATALOG = CATALOG_CONFIG;
/** @deprecated Usar BOOKING_FIELDS */
export const CITA_FIELDS = BOOKING_FIELDS;
/** @deprecated Usar CURRENCY_CONFIG */
export const MONEY = CURRENCY_CONFIG;
/** @deprecated Usar ACCOUNTING_ACCOUNT */
export const CUENTAS_PGC = ACCOUNTING_ACCOUNT;
/** @deprecated Usar AEAT_INVOICE_TYPE */
export const CLAVES_AEAT = AEAT_INVOICE_TYPE;
/** @deprecated Usar CORRECTION_REASON */
export const MOTIVOS_RECTIFICACION = CORRECTION_REASON;
/** @deprecated Usar IRPF_WITHHOLDING_RATE */
export const TIPOS_RETENCION_IRPF = IRPF_WITHHOLDING_RATE;
/** @deprecated Usar VAT_ACCRUAL_STATUS */
export const ESTADO_DEVENGO_IVA = VAT_ACCRUAL_STATUS;
/** @deprecated Usar FISCAL_ROLE */
export const ROL_FISCAL = FISCAL_ROLE;
/** @deprecated Usar EVENT_TYPE */
export const TIPO_EVENTO = EVENT_TYPE;
/** @deprecated Usar ITEM_NATURE */
export const NATURALEZA_ITEM = ITEM_NATURE;
/** @deprecated Usar THIRD_PARTY_TYPE */
export const TIPO_TERCERO = THIRD_PARTY_TYPE;
/** @deprecated Usar PROJECTION_STATUS */
export const PROYECCION_ESTADO = PROJECTION_STATUS;
/** @deprecated Usar COMPUTER_SYSTEM */
export const SISTEMA_INFORMATICO = COMPUTER_SYSTEM;
