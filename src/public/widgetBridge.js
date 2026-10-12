/*
MODULE: public/widgetBridge.js
VERSION: v5012-ERRORCODE-AND-ORIGIN-FIX
BASE: v5011-F2-CALLBACK-ALIGNED
PURPOSE: Secure, versioned bridge between Wix Velo and HTML Components.
STANDARDS: Strict ASCII in source comments and identifiers.
RESTRICTION: this module MUST NOT import public/mmUtils.js (acyclic rule).
             mmUtils re-exports from here, never the other way round.

FIXES v5012:
  BRIDGE-01 (P0) WIDGET_ERROR_CODE tenia un espacio final en los 16 valores.
         Los consumidores comparan por igualdad estricta
         (error.code === "WIDGET_ORIGIN_REJECTED"), por lo que ninguna rama de
         error amigable llegaba a ejecutarse. Valores normalizados.
  BRIDGE-02 (P0) normalizeOriginSuffix usaba .replace(/^.+/, ""), que borra la
         cadena COMPLETA. allowedOriginSuffixes quedaba siempre vacio y se caia
         en silencio a los sufijos por defecto. Corregido a /^\.+/ (solo puntos).
  BRIDGE-03 (P0) getOriginHost tenia el literal regex corrupto
         (/^[a-z0-9+.-]+:///i), que el parser corta en el primer slash y deja
         "/i, \"\")" como residuo. Restaurado a /^[a-z0-9+.-]+:\/\/\/i con las
         barras escapadas: elimina "scheme://" antes de leer el hostname.
  BRIDGE-04 (P0) resolveOriginPolicy tenia .replace(//$/, "") corrupto.
         Restaurado a .replace(/\/$/, "").
  BRIDGE-05 (P1) HANDSHAKE_TIMEOUT_MS 15000 -> 40000. Los widgets reintentan el
         handshake durante 23,5 s (calendario) y 31,5 s (servicio). Con 15 s el
         bridge declaraba WIDGET_HANDSHAKE_TIMEOUT mientras el widget aun iba por
         el intento 4: falso positivo garantizado en moviles y conexiones lentas.
         La ventana debe ser >= presupuesto total del widget mas lento.
CONTRATO DE CALLBACK (F2, sin cambios):
  onWidgetMessage(message, reply, bridge)
    reply(responseType, payload, requestMessage?) -> correlaciona con el mensaje
    entrante cuando este trae messageId. Los widgets actuales correlacionan por
    payload.requestSequence, que las paginas reenvian intacto.
=============================================================================
*/

export const PROTOCOL_VERSION = 1;

export const MESSAGE_TYPES = Object.freeze({
    READY: "MM_READY",
    CONTEXT: "MM_CONTEXT",
    AVAIL: "MM_AVAIL",
    SELECT: "MM_SELECT",
    BOOK: "MM_BOOK",
    NAV: "MM_NAV"
});

export const PROTOCOL_URLS = Object.freeze({
    SERVICIOS: "/reserva-online",
    CALENDARIO_2: "/booking-calendar/calendario-2",
    PRIVACY_POLICY: "/politica-de-privacidad"
});

export const PROTOCOL_UI = Object.freeze({
    FRONTEND_API_TIMEOUT_MS: 60000,
    // BRIDGE-05: debe cubrir el presupuesto completo de reintentos del widget
    // mas lento (servicio-2: 6 intentos con backoff 500 * 2^n = 31,5 s).
    HANDSHAKE_TIMEOUT_MS: 40000,
    CONTEXT_TIMEOUT_MS: 30000
});

const RESPONSE_TYPE_SUFFIX = "_RES";
const RESPONSE_TYPE_PATTERN = /^[A-Z][A-Z0-9_]{0,38}_RES$/;
const ADMIN_RESPONSE_TYPE = "MM_ADMIN_RESPONSE";
const MAX_TYPE_LENGTH = 40;
const MAX_MESSAGE_ID_LENGTH = 120;
const MAX_MESSAGE_BYTES = 100000;
const MAX_PAYLOAD_KEYS = 400;

const DEFAULT_ALLOWED_ORIGIN_SUFFIXES = Object.freeze([
    ".parastorage.com",
    ".wix.com",
    ".wixsite.com",
    ".editorx.com"
]);

const OPAQUE_ORIGIN_PREFIXES = Object.freeze([
    "blob:",
    "data:",
    "filesystem:"
]);

// BRIDGE-01: valores sin espacio final. La comparacion por === en los
// consumidores depende de la igualdad exacta del literal.
export const WIDGET_ERROR_CODE = Object.freeze({
    INVALID_WIDGET: "WIDGET_INVALID_HTML_COMPONENT",
    DESTROYED: "WIDGET_BRIDGE_DESTROYED",
    ORIGIN_REJECTED: "WIDGET_ORIGIN_REJECTED",
    ORIGIN_OPAQUE_REJECTED: "WIDGET_ORIGIN_OPAQUE_REJECTED",
    MESSAGE_TOO_LARGE: "WIDGET_MESSAGE_TOO_LARGE",
    PAYLOAD_TOO_COMPLEX: "WIDGET_PAYLOAD_TOO_COMPLEX",
    TYPE_MISSING: "WIDGET_MESSAGE_TYPE_MISSING",
    TYPE_NOT_ALLOWED: "WIDGET_MESSAGE_TYPE_NOT_ALLOWED",
    VERSION_UNSUPPORTED: "WIDGET_PROTOCOL_VERSION_UNSUPPORTED",
    MESSAGE_REJECTED: "WIDGET_MESSAGE_REJECTED",
    HANDSHAKE_TIMEOUT: "WIDGET_HANDSHAKE_TIMEOUT",
    CONTEXT_TIMEOUT: "WIDGET_CONTEXT_TIMEOUT",
    CONTEXT_FAILED: "WIDGET_CONTEXT_FAILED",
    LISTENER_FAILED: "WIDGET_MESSAGE_LISTENER_FAILED",
    HANDLER_FAILED: "WIDGET_MESSAGE_HANDLER_FAILED",
    CONSUMER_ERROR_HANDLER_FAILED: "WIDGET_ERROR_HANDLER_FAILED"
});

const DEFAULT_ALLOWED_TYPES = Object.freeze(
    Object.values(MESSAGE_TYPES)
);

const textEncoder =
    typeof TextEncoder === "function" ? new TextEncoder() : null;

let instanceCounter = 0;

function safeObject(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : {};
}

function safeType(value) {
    return String(value === null || value === undefined ? "" : value)
        .trim()
        .toUpperCase()
        .slice(0, MAX_TYPE_LENGTH);
}

function safeMessageId(value) {
    return String(value === null || value === undefined ? "" : value)
        .trim()
        .replace(/[^a-zA-Z0-9._:-]/g, "_")
        .slice(0, MAX_MESSAGE_ID_LENGTH);
}

function toProtocolVersion(value) {
    if (value === undefined || value === null || value === "") {
        return PROTOCOL_VERSION;
    }
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function estimateBytes(value) {
    try {
        const serialized = JSON.stringify(value);
        if (typeof serialized !== "string") return MAX_MESSAGE_BYTES + 1;
        return textEncoder
            ? textEncoder.encode(serialized).length
            : serialized.length;
    } catch (_) {
        return MAX_MESSAGE_BYTES + 1;
    }
}

function countKeys(value) {
    if (!value || typeof value !== "object") return 0;
    let total = 0;
    const stack = [value];
    while (stack.length > 0 && total <= MAX_PAYLOAD_KEYS) {
        const current = stack.pop();
        if (!current || typeof current !== "object") continue;
        const keys = Object.keys(current);
        total += keys.length;
        for (const key of keys) {
            const child = current[key];
            if (child && typeof child === "object") stack.push(child);
        }
    }
    return total;
}

export function buildResponseType(type) {
    return safeType(type) + RESPONSE_TYPE_SUFFIX;
}

function isResponseType(type) {
    return RESPONSE_TYPE_PATTERN.test(type);
}

function getResponseTypeBase(type) {
    return isResponseType(type)
        ? type.slice(0, -RESPONSE_TYPE_SUFFIX.length)
        : "";
}

/**
 * BRIDGE-02: solo se eliminan los puntos iniciales. La version anterior usaba
 * /^.+/ y devolvia siempre cadena vacia, desactivando allowedOriginSuffixes.
 */
function normalizeOriginSuffix(value) {
    const suffix = String(value === null || value === undefined ? "" : value)
        .trim()
        .toLowerCase()
        .replace(/^\.+/, "");
    return suffix ? "." + suffix : "";
}

/** BRIDGE-04: regex de barra final restaurada. */
function resolveOriginPolicy(options) {
    const exact = String(options.allowedOrigin === null || options.allowedOrigin === undefined
        ? ""
        : options.allowedOrigin)
        .trim()
        .toLowerCase()
        .replace(/\/$/, "");

    if (exact) {
        return Object.freeze({
            mode: "exact",
            exact: exact,
            suffixes: Object.freeze([]),
            allowOpaqueOrigin: options.allowOpaqueOrigin === true
        });
    }

    const custom = Array.isArray(options.allowedOriginSuffixes)
        ? options.allowedOriginSuffixes
            .map(normalizeOriginSuffix)
            .filter(Boolean)
        : [];

    return Object.freeze({
        mode: options.strictOrigin === false ? "off" : "suffix",
        exact: "",
        suffixes: Object.freeze(
            custom.length > 0 ? custom : DEFAULT_ALLOWED_ORIGIN_SUFFIXES
        ),
        allowOpaqueOrigin: options.allowOpaqueOrigin === true
    });
}

function classifyOrigin(rawOrigin) {
    const origin = String(rawOrigin === null || rawOrigin === undefined ? "" : rawOrigin)
        .trim()
        .toLowerCase();
    if (!origin || origin === "null") {
        return { opaque: true, value: origin };
    }
    return {
        opaque: OPAQUE_ORIGIN_PREFIXES.some(function (prefix) {
            return origin.startsWith(prefix);
        }),
        value: origin
    };
}

/**
 * BRIDGE-03: elimina el esquema ("https://") con las barras escapadas antes de
 * leer el hostname. Fallback para origenes que no parsean como URL.
 */
function getOriginHost(origin) {
    try {
        return new URL(origin).hostname.toLowerCase();
    } catch (_) {
        return String(origin)
            .replace(/^[a-z0-9+.-]+:\/\//i, "")
            .split("/")[0]
            .toLowerCase();
    }
}

function isOriginAllowed(origin, policy) {
    if (policy.mode === "off") return true;
    if (policy.mode === "exact") return origin === policy.exact;
    const host = getOriginHost(origin);
    return policy.suffixes.some(function (suffix) {
        const baseHost = suffix.slice(1);
        return host === baseHost || host.endsWith(suffix);
    });
}

function withManagedTimeout(promise, timeoutMs, code, timers) {
    return new Promise(function (resolve, reject) {
        let settled = false;
        const timer = setTimeout(function () {
            if (settled) return;
            settled = true;
            timers.delete(timer);
            const error = new Error(code);
            error.code = code;
            reject(error);
        }, Math.max(1, Number(timeoutMs) || 1));
        timers.add(timer);
        Promise.resolve(promise).then(
            function (value) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                timers.delete(timer);
                resolve(value);
            },
            function (error) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                timers.delete(timer);
                reject(error);
            }
        );
    });
}

export function createWidgetBridge(widgetElement, options = {}) {
    if (
        !widgetElement ||
        typeof widgetElement.onMessage !== "function" ||
        typeof widgetElement.postMessage !== "function"
    ) {
        const error = new TypeError(WIDGET_ERROR_CODE.INVALID_WIDGET);
        error.code = WIDGET_ERROR_CODE.INVALID_WIDGET;
        throw error;
    }

    const settings = safeObject(options);

    instanceCounter += 1;
    const bridgeId =
        "wbridge-" + instanceCounter.toString(36) + "-" +
        Math.random().toString(36).slice(2, 8);

    const originPolicy = resolveOriginPolicy(settings);

    const allowedTypes = new Set(
        Array.isArray(settings.allowedTypes) && settings.allowedTypes.length > 0
            ? settings.allowedTypes.map(safeType).filter(Boolean)
            : DEFAULT_ALLOWED_TYPES
    );

    const handshakeTimeoutMs = Number(settings.handshakeTimeoutMs) > 0
        ? Number(settings.handshakeTimeoutMs)
        : PROTOCOL_UI.HANDSHAKE_TIMEOUT_MS;

    const contextTimeoutMs = Number(settings.contextTimeoutMs) > 0
        ? Number(settings.contextTimeoutMs)
        : PROTOCOL_UI.CONTEXT_TIMEOUT_MS;

    const onWidgetMessage =
        typeof settings.onWidgetMessage === "function" ? settings.onWidgetMessage : null;
    const onContextReady =
        typeof settings.onContextReady === "function" ? settings.onContextReady : null;
    const onError =
        typeof settings.onError === "function" ? settings.onError : function () {};

    let destroyed = false;
    let sequence = 0;
    let handshakeCompleted = false;
    let contextInFlight = false;
    let bridge = null;
    let handshakeTimer = null;

    const listeners = new Set();
    const timers = new Set();

    function isAllowedType(type) {
        // ADMIN_RESPONSE_TYPE queda siempre permitido: lo consume
        // public/marianAdministrationController.js aunque la pagina restrinja
        // allowedTypes a los tipos de reserva.
        if (allowedTypes.has(type) || type === ADMIN_RESPONSE_TYPE) return true;
        const base = getResponseTypeBase(type);
        return Boolean(base) && allowedTypes.has(base);
    }

    function reportError(code, detail = null, cause = null) {
        const error = new Error(code);
        error.code = code;
        error.bridgeId = bridgeId;
        if (cause) error.cause = cause;
        if (detail !== null && detail !== undefined) error.detail = detail;
        try {
            onError(error, detail);
        } catch (_) {
            // El reporte de errores nunca debe romper la entrega de mensajes.
        }
        return error;
    }

    function clearAllTimers() {
        timers.forEach(function (timer) { clearTimeout(timer); });
        timers.clear();
        handshakeTimer = null;
    }

    function extractEvent(event) {
        const classified = classifyOrigin(event && event.origin);
        if (classified.opaque) {
            if (!originPolicy.allowOpaqueOrigin) {
                reportError(
                    WIDGET_ERROR_CODE.ORIGIN_OPAQUE_REJECTED,
                    { origin: classified.value }
                );
                return null;
            }
        } else if (!isOriginAllowed(classified.value, originPolicy)) {
            reportError(
                WIDGET_ERROR_CODE.ORIGIN_REJECTED,
                { origin: classified.value }
            );
            return null;
        }

        const message = safeObject(event && event.data);
        if (estimateBytes(message) > MAX_MESSAGE_BYTES) {
            reportError(WIDGET_ERROR_CODE.MESSAGE_TOO_LARGE);
            return null;
        }
        if (countKeys(message) > MAX_PAYLOAD_KEYS) {
            reportError(WIDGET_ERROR_CODE.PAYLOAD_TOO_COMPLEX);
            return null;
        }
        return message;
    }

    function normalizeMessage(source) {
        const type = safeType(source.type);
        if (!type) {
            return { message: null, code: WIDGET_ERROR_CODE.TYPE_MISSING };
        }
        if (!isAllowedType(type)) {
            return { message: null, code: WIDGET_ERROR_CODE.TYPE_NOT_ALLOWED };
        }
        const version = toProtocolVersion(source.version);
        if (version !== PROTOCOL_VERSION) {
            return { message: null, code: WIDGET_ERROR_CODE.VERSION_UNSUPPORTED };
        }
        const messageId = safeMessageId(source.messageId);
        return {
            message: Object.freeze({
                type: type,
                payload: Object.freeze(safeObject(source.payload)),
                messageId: messageId,
                requestId: safeMessageId(source.requestId) || messageId,
                version: PROTOCOL_VERSION,
                bridgeId: bridgeId
            }),
            code: null
        };
    }

    function notifyListeners(message) {
        listeners.forEach(function (listener) {
            try {
                listener(message, bridge);
            } catch (error) {
                reportError(WIDGET_ERROR_CODE.LISTENER_FAILED, null, error);
            }
        });
    }

    function nextMessageId() {
        sequence += 1;
        return safeMessageId(
            bridgeId + "-" + Date.now().toString(36) + "-" + sequence.toString(36)
        );
    }

    function send(type, payload = {}, messageId = null) {
        if (destroyed) {
            const error = new Error(WIDGET_ERROR_CODE.DESTROYED);
            error.code = WIDGET_ERROR_CODE.DESTROYED;
            throw error;
        }
        const normalizedType = safeType(type);
        if (!isAllowedType(normalizedType)) {
            const error = new Error(WIDGET_ERROR_CODE.TYPE_NOT_ALLOWED);
            error.code = WIDGET_ERROR_CODE.TYPE_NOT_ALLOWED;
            throw error;
        }
        const message = Object.freeze({
            type: normalizedType,
            payload: safeObject(payload),
            messageId: safeMessageId(messageId) || nextMessageId(),
            version: PROTOCOL_VERSION,
            bridgeId: bridgeId
        });
        if (estimateBytes(message) > MAX_MESSAGE_BYTES) {
            const error = new Error(WIDGET_ERROR_CODE.MESSAGE_TOO_LARGE);
            error.code = WIDGET_ERROR_CODE.MESSAGE_TOO_LARGE;
            throw error;
        }
        widgetElement.postMessage(message);
        return message.messageId;
    }

    function resolveCorrelationId(requestMessage) {
        if (!requestMessage) return "";
        if (typeof requestMessage === "string") return safeMessageId(requestMessage);
        if (typeof requestMessage !== "object") return "";
        return safeMessageId(requestMessage.messageId) ||
            safeMessageId(requestMessage.requestId);
    }

    function reply(type, payload = {}, requestMessage = null) {
        return send(type, payload, resolveCorrelationId(requestMessage) || null);
    }

    function postMessage(payload = {}, type = MESSAGE_TYPES.CONTEXT) {
        return send(type, payload);
    }

    function subscribe(callback) {
        if (destroyed || typeof callback !== "function") return function () {};
        listeners.add(callback);
        return function () { listeners.delete(callback); };
    }

    async function publishContext(message) {
        if (!onContextReady || contextInFlight || destroyed) return;
        contextInFlight = true;
        try {
            const context = await withManagedTimeout(
                Promise.resolve().then(function () {
                    return onContextReady(message, bridge);
                }),
                contextTimeoutMs,
                WIDGET_ERROR_CODE.CONTEXT_TIMEOUT,
                timers
            );
            if (destroyed || context === undefined || context === null) return;
            send(MESSAGE_TYPES.CONTEXT, context, message.messageId || null);
        } catch (cause) {
            const code = cause && cause.code === WIDGET_ERROR_CODE.CONTEXT_TIMEOUT
                ? WIDGET_ERROR_CODE.CONTEXT_TIMEOUT
                : WIDGET_ERROR_CODE.CONTEXT_FAILED;
            const detail = {
                causeCode: (cause && cause.code) || null,
                causeMessage: (cause && cause.message) || String(cause),
                causeStack: (cause && cause.stack) || null
            };
            reportError(code, detail, cause);
        } finally {
            contextInFlight = false;
        }
    }

    function armHandshakeWatchdog() {
        if (!onContextReady || handshakeTimeoutMs <= 0) return;
        handshakeTimer = setTimeout(function () {
            timers.delete(handshakeTimer);
            handshakeTimer = null;
            if (destroyed || handshakeCompleted) return;
            reportError(WIDGET_ERROR_CODE.HANDSHAKE_TIMEOUT, { bridgeId: bridgeId });
        }, handshakeTimeoutMs);
        timers.add(handshakeTimer);
    }

    const unsubscribeWidget = widgetElement.onMessage(function (event) {
        if (destroyed) return;
        try {
            const extracted = extractEvent(event);
            if (!extracted) return;

            const normalized = normalizeMessage(extracted);
            if (!normalized.message) {
                reportError(
                    normalized.code || WIDGET_ERROR_CODE.MESSAGE_REJECTED,
                    {
                        receivedType: (extracted && extracted.type) || null,
                        receivedVersion: (extracted && extracted.version) || null
                    }
                );
                return;
            }

            const message = normalized.message;

            if (message.type === MESSAGE_TYPES.READY) {
                handshakeCompleted = true;
                if (handshakeTimer !== null) {
                    clearTimeout(handshakeTimer);
                    timers.delete(handshakeTimer);
                    handshakeTimer = null;
                }
            }

            notifyListeners(message);

            if (onWidgetMessage) {
                // F2: segundo argumento = helper reply; tercero = bridge completo.
                // La respuesta queda correlacionada con el mensaje entrante cuando
                // este trae messageId o requestId.
                const replyToMessage = function (responseType, payload = {}, requestMessage = message) {
                    const candidate =
                        requestMessage &&
                        typeof requestMessage === "object" &&
                        (requestMessage.messageId || requestMessage.requestId)
                            ? requestMessage
                            : message;
                    return reply(responseType, payload, candidate);
                };
                Promise.resolve()
                    .then(function () {
                        return onWidgetMessage(message, replyToMessage, bridge);
                    })
                    .catch(function (error) {
                        reportError(
                            (error && error.code) || WIDGET_ERROR_CODE.HANDLER_FAILED,
                            null,
                            error
                        );
                    });
            }

            if (message.type === MESSAGE_TYPES.READY) {
                void publishContext(message);
            }
        } catch (error) {
            reportError(
                (error && error.code) || WIDGET_ERROR_CODE.HANDLER_FAILED,
                null,
                error
            );
        }
    });

    armHandshakeWatchdog();

    bridge = Object.freeze({
        type: "WIX_HTML_COMPONENT_BRIDGE",
        bridgeId: bridgeId,
        protocolVersion: PROTOCOL_VERSION,
        widget: widgetElement,
        originPolicyMode: originPolicy.mode,
        allowedTypes: Object.freeze(Array.from(allowedTypes)),
        get destroyed() {
            return destroyed;
        },
        get handshakeCompleted() {
            return handshakeCompleted;
        },
        send: send,
        reply: reply,
        postMessage: postMessage,
        subscribe: subscribe,
        destroy: function () {
            if (destroyed) return;
            destroyed = true;
            listeners.clear();
            clearAllTimers();
            if (typeof unsubscribeWidget === "function") {
                try {
                    unsubscribeWidget();
                } catch (_) {
                    // Seguro si el widget ya fue desmontado.
                }
            }
        }
    });

    return bridge;
}

export default createWidgetBridge;
