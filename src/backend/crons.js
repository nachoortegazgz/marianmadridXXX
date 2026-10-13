/*
=============================================================================
MODULE: backend/crons.js
VERSION: v5009-FISCAL-V20.1
BASE: v5008.2-FISCAL-RECOVERY + Directriz V20 (IDs nativa en ingles)
RESPONSIBILITY: Jobs programados (cron). 6 crons activos.
STANDARDS: G10 ASCII Strict.

FIXES APLICADOS v5009-FISCAL-V20.1:
  - V20-01: sin renombrados funcionales. Los campos de
            CompensacionesPendientes usados por este modulo ya estan
            contemplados en V20.1-EXPANDED.

CORRECTIONS (heredadas): CRON-01..CRON-06.
=============================================================================
*/

import wixData from "wix-data";
import { BUSINESS_COLLECTIONS, OPERATIONAL_COLLECTIONS, SDK_CONFIG, CONCURRENCY, CONTROL_TYPE, CONTROL_STATUS } from "backend/internalConfig";
import { makeTraceId, _safeTrim, _looksLikeGuid, withTimeout } from "public/mmUtils";
import { logger } from "backend/logger";
import { verifyFiscalHashChainIntegrity } from "backend/cajas.web";
// [SSOT-v5010.1 ZOMB-02] backend/bookingServiceSync.js ELIMINADO. La cola BookingsServiceSyncQueue
// se procesa via el modulo nativo de sincronizacion de servicios; no hay consumidor custom.
import { cancelBookingElevated } from "backend/booking/bookingCore";

const log = logger;

const API_TIMEOUT_MS =
    Number(SDK_CONFIG?.TIMEOUTS?.API_MS) || 15000;

const MAX_COMPENSATION_ATTEMPTS =
    Math.max(1, Number(CONCURRENCY?.MAX_COMPENSATION_RETRIES) || 3);

// =============================================================================
// CRON 1: cleanExpiredLocks - 15 * * * *
// =============================================================================

export async function cleanExpiredLocks() {
    const traceId = makeTraceId("cron-locks");
    try {
        const now = new Date();
        const res = await wixData
            .query(OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO)
            .lt("expiresAt", now)
            .limit(100)
            .find({ suppressAuth: true });

        let removed = 0;
        for (const item of res?.items || []) {
            await wixData
                .remove(OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO, item._id, { suppressAuth: true })
                .catch(() => null);
            removed++;
        }

        log.info("cleanExpiredLocks completed", { removed, traceId });
    } catch (err) {
        log.error("cleanExpiredLocks failed", { error: err?.message, traceId });
    }
}

// =============================================================================
// CRON 2: cleanupExpiredDualCache - 20 * * * *
// =============================================================================

export async function cleanupExpiredDualCache() {
    const traceId = makeTraceId("cron-dual-cache");
    try {
        const now = new Date();
        const limit =
            Number(SDK_CONFIG?.JOBS?.DUAL_CACHE_CLEANUP_LIMIT) || 100;

        const res = await wixData
            .query(OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO)
            .lt("expiresAt", now)
            .limit(limit)
            .find({ suppressAuth: true });

        let removed = 0;
        for (const item of res?.items || []) {
            await wixData
                .remove(OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO, item._id, {
                    suppressAuth: true,
                })
                .catch(() => null);
            removed++;
        }

        log.info("cleanupExpiredDualCache completed", { removed, traceId });
    } catch (err) {
        log.error("cleanupExpiredDualCache failed", {
            error: err?.message,
            traceId,
        });
    }
}

// =============================================================================
// CRON 3: runPendingCompensationsJob - 30 * * * *
// =============================================================================

async function _runOneCompensation(comp, traceId) {
    const kind = _safeTrim(comp?.kind).toUpperCase();
    const bookingId = _safeTrim(comp?.bookingId);

    if (kind === "CANCEL_BOOKING") {
        if (!bookingId || !_looksLikeGuid(bookingId)) {
            throw new Error("CANCEL_BOOKING requires a valid bookingId GUID");
        }

        await withTimeout(
            () =>
            cancelBookingElevated(bookingId, {
                suppressAuth: true,
            }),
            API_TIMEOUT_MS,
            "cron:cancelBookingCompensation"
        );

        return { ok: true, action: "CANCEL_BOOKING", bookingId };
    }

    if (kind === "FISCAL_LEDGER" || kind === "RESYNC_LEDGER_ACCOUNTING") {
        try {
            const { registerBookingPayment } = await import("backend/cajas.web");
            // v5010.7 SSOT: CompensacionesPendientes usa campo canonic totalAmount.
            const amount = Number(comp?.totalAmount);
            const hasAmount = Number.isFinite(amount) && amount !== 0;
            const transactionId = _safeTrim(comp?.transactionId);
            const bookingIds = comp?.bookingIds || comp?.bookingId || null;

            if (kind === "FISCAL_LEDGER" && hasAmount && transactionId) {
                const result = await withTimeout(
                    () =>
                    registerBookingPayment(bookingIds, amount, comp?.paymentMethod || "ONLINE", {
                        operationDescription: comp?.operationDescription || "Fiscal recovery retry",
                        transactionId: transactionId,
                        orderId: comp?.orderId || null,
                        refundId: comp?.refundId || null,
                        tipoMovimiento: comp?.movementType || null,
                        origen: "CRON_FISCAL_RECOVERY",
                        resourceId: "online",
                        traceId: traceId,
                    }),
                    API_TIMEOUT_MS,
                    "cron:fiscalLedgerRecovery"
                );

                if (result?.status === "SUCCESS") {
                    return { ok: true, action: kind, transactionId };
                }

                throw new Error(
                    (result && result.error && result.error.message) ||
                    "FISCAL_LEDGER recovery returned non-SUCCESS"
                );
            }

            throw new Error(
                kind +
                " requires manual or extended processor (payload incomplete or RESYNC)"
            );
        } catch (err) {
            throw err;
        }
    }

    throw new Error(`Unsupported compensation kind: ${kind || "UNKNOWN"}`);
}

export async function runPendingCompensationsJob() {
    const traceId = makeTraceId("cron-comp");
    try {
        const batchSize =
            Number(SDK_CONFIG?.JOBS?.FISCAL_RECOVERY_BATCH_SIZE) || 25;
        const statuses = ["PENDING", "RETRYING", "PENDING_RECOVERY"];
        const queryResults = await Promise.all(
            statuses.map((status) =>
                wixData
                    .query(OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO)
                    .eq("status", status)
                    .lt("attempts", MAX_COMPENSATION_ATTEMPTS)
                    .limit(batchSize)
                    .find({ suppressAuth: true })
            )
        );
        const seenIds = new Set();
        const compensationItems = queryResults
            .flatMap((result) => result?.items || [])
            .filter((item) => {
                if (!item?._id || seenIds.has(item._id)) return false;
                seenIds.add(item._id);
                return true;
            })
            .sort((a, b) =>
                new Date(a?._createdDate || 0).getTime() -
                new Date(b?._createdDate || 0).getTime()
            )
            .slice(0, batchSize);

        let processed = 0;
        let failed = 0;

        for (const comp of compensationItems) {
            try {
                await _runOneCompensation(comp, traceId);

                comp.status = "COMPLETED";
                comp.lastError = null;
                comp._updatedDate = new Date();
                await wixData.update(
                    OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO,
                    comp, { suppressAuth: true }
                );
                processed++;
            } catch (compErr) {
                const attempts = Number(comp.attempts || 0) + 1;
                comp.attempts = attempts;
                comp.lastError = compErr?.message || "UNKNOWN";
                comp.status =
                    attempts >= MAX_COMPENSATION_ATTEMPTS ? "FAILED" : "RETRYING";
                comp._updatedDate = new Date();

                await wixData
                    .update(OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO, comp, {
                        suppressAuth: true,
                    })
                    .catch(() => null);

                failed++;

                if (comp.status === "FAILED" || comp.alertRequired === true) {
                    await wixData
                        .insert(
                            COLLECTIONS.ALERTAS_OPERATIVAS, {
                                alertType: String(comp.kind || "").includes("FISCAL") ||
                                    String(comp.kind || "").includes("RESYNC") ?
                                    "FISCAL_RECOVERY_FAILED" :
                                    "COMPENSATION_FAILED",
                                severity: "ERROR",
                                message: `Compensation ${comp.kind || "UNKNOWN"} failed for booking ${comp.bookingId || comp.transactionId || "n/a"}`,
                                status: "OPEN",
                                traceId,
                                meta: {
                                    compensationId: comp._id || null,
                                    bookingId: comp.bookingId || null,
                                    lastError: comp.lastError,
                                    attempts,
                                },
                                _createdDate: new Date(),
                            }, { suppressAuth: true }
                        )
                        .catch(() => null);
                }
            }
        }

        log.info("runPendingCompensationsJob completed", {
            processed,
            failed,
            traceId,
        });
    } catch (err) {
        log.error("runPendingCompensationsJob failed", {
            error: err?.message,
            traceId,
        });
    }
}

// =============================================================================
// CRON 4: cleanExpiredDaysCache - 0 1 * * *
// =============================================================================

export async function cleanExpiredDaysCache() {
    const traceId = makeTraceId("cron-days-cache");
    try {
        const now = new Date();
        const res = await wixData
            .query(OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO)
            .lt("expiresAt", now)
            .limit(200)
            .find({ suppressAuth: true });

        let removed = 0;
        for (const item of res?.items || []) {
            await wixData
                .remove(OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO, item._id, {
                    suppressAuth: true,
                })
                .catch(() => null);
            removed++;
        }

        log.info("cleanExpiredDaysCache completed", { removed, traceId });
    } catch (err) {
        log.error("cleanExpiredDaysCache failed", {
            error: err?.message,
            traceId,
        });
    }
}

// =============================================================================
// CRON 5: cleanExpiredSlotsCache - 10 1 * * *
// =============================================================================

export async function cleanExpiredSlotsCache() {
    const traceId = makeTraceId("cron-slots-cache");
    try {
        log.info(
            "cleanExpiredSlotsCache completed (RAM cache auto-resets on cold start)", { traceId }
        );
    } catch (err) {
        log.error("cleanExpiredSlotsCache failed", {
            error: err?.message,
            traceId,
        });
    }
}

// =============================================================================
// CRON 6: systemHealthCheck - 0 7 * * *
// =============================================================================

export async function systemHealthCheck() {
    const traceId = makeTraceId("cron-health");
    try {
        const results = {
            timestamp: new Date().toISOString(),
            collections: {},
            fiscalChain: null,
            secrets: {},
        };

        const criticalCols = [
            BUSINESS_COLLECTIONS.CITAS_F2,
            BUSINESS_COLLECTIONS.MOVIMIENTOS_CAJA,
            OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO,
            // IC-10: MapaStaff suprimida; la identidad staff vive ahora en
            // DatosFiscales(recordType=STAFF_CONFIG), ya cubierta arriba.
            BUSINESS_COLLECTIONS.DATOS_FISCALES,
        ];

        for (const col of criticalCols) {
            try {
                const count = await wixData.query(col).limit(1).count();
                results.collections[col] = { accessible: true, count };
            } catch (_) {
                results.collections[col] = { accessible: false, count: 0 };
            }
        }

        try {
            const chainResult = await verifyFiscalHashChainIntegrity({
                traceId,
                limit: 100,
            });
            results.fiscalChain = chainResult.status;
        } catch (_) {
            results.fiscalChain = "ERROR";
        }

        log.info("systemHealthCheck completed", { results, traceId });

        const hasIssues =
            Object.values(results.collections).some((c) => !c.accessible) ||
            results.fiscalChain !== "SUCCESS";

        if (hasIssues) {
            // IC-10 / ADR-05: AlertasOperativas fue suprimida; las alertas de
            // salud viven en ControlOperativo como subtipo ALERT. Escribir en
            // la coleccion antigua lanzaba ReferenceError silencioso capturado
            // por el catch exterior (deuda eradica).
            await wixData
                .insert(
                    OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO, {
                        controlType: CONTROL_TYPE.ALERT,
                        alertType: "HEALTH_CHECK_ISSUES",
                        severity: "WARNING",
                        message: "systemHealthCheck detected issues",
                        status: CONTROL_STATUS.OPEN,
                        traceId,
                        _createdDate: new Date(),
                    }, { suppressAuth: true }
                )
                .catch(() => null);
        }
    } catch (err) {
        log.error("systemHealthCheck failed", { error: err?.message, traceId });
    }
}

// =============================================================================
// CRON 7: verifyNightlyZClosing - 20 1 * * * (parity jobs.config)
// =============================================================================

const MADRID_TZ = "Europe/Madrid";

function _madridYmd(date) {
    return new Intl.DateTimeFormat("en-CA", { timeZone: MADRID_TZ }).format(date);
}

/**
 * Verificacion del cierre Z del dia anterior (UTC+Madrid). Idempotente:
 * si la fila Z_<ymd> ya existe y esta CERRADO/SIGNED, sale sin alertar.
 * Intenta el cierre automatico delegando en cajas.registerZClosing; si el
 * cron no tiene sesion de cajero (ACCESS_DENIED en Velo real), registra una
 * alerta NIGHTLY_Z_CLOSING_MANUAL_REQUIRED deduplicada por clave estable.
 */
export async function verifyNightlyZClosing() {
    const traceId = makeTraceId("cron-zclosing");
    try {
        const ymd = _madridYmd(new Date(Date.now() - 24 * 60 * 60 * 1000));
        const zId = `Z_${ymd}`;

        const existing = await withTimeout(
            wixData.get(BUSINESS_COLLECTIONS.HISTORICO_CIERRES_Z, zId, { suppressAuth: true }),
            API_TIMEOUT_MS, "verifyNightlyZClosing.get"
        ).catch(() => null);

        if (existing && _safeTrim(existing.closingStatus) === "CERRADO") {
            log.info("verifyNightlyZClosing: day already closed", { zId, traceId });
            return;
        }

        // Intento de cierre automatico (requiere sesion de cajero en runtime).
        const { registerZClosing } = await import("backend/cajas.web");
        try {
            const res = await registerZClosing(ymd, { traceId });
            if (res?.status === "SUCCESS" || res?.data?.closingStatus === "CERRADO") {
                log.info("verifyNightlyZClosing: automatic Z closing succeeded", { zId, traceId });
                return;
            }
            const code = res?.error?.code;
            if (code !== "ACCESS_DENIED" && code !== "Z_ALREADY_CLOSED") {
                throw new Error(`registerZClosing returned ${String(code)}`);
            }
        } catch (innerErr) {
            const msg = String(innerErr?.message || "");
            if (!msg.includes("ACCESS_DENIED")) throw innerErr;
        }

        // ACCESS_DENIED sin cierre: alerta manual deduplicada (no throw para
        // evitar reintentos infinitos del runner; requiere accion humana).
        const dedupeKey = `ALERT:NIGHTLY_Z:${zId}`;
        const dup = await wixData
            .query(OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO)
            .eq("dedupeKey", dedupeKey)
            .limit(1)
            .count();
        if (dup > 0) {
            log.warn("verifyNightlyZClosing: manual-required alert already present", { zId, traceId });
            return;
        }
        await wixData.insert(OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO, {
            controlType: CONTROL_TYPE.ALERT,
            alertType: "NIGHTLY_Z_CLOSING_MANUAL_REQUIRED",
            dedupeKey,
            severity: "WARNING",
            message: `Z closing for ${ymd} requires authenticated cashier action`,
            status: CONTROL_STATUS.OPEN,
            traceId,
            _createdDate: new Date(),
        }, { suppressAuth: true });
        log.warn("verifyNightlyZClosing: raised MANUAL_REQUIRED alert", { zId, traceId });
    } catch (err) {
        log.error("verifyNightlyZClosing failed", { error: err?.message, traceId });
    }
}

// =============================================================================
// CRON 8: cleanAuditLogs - 0 2 * * 0 (paridad jobs.config, retencion 90 dias)
// =============================================================================

const AUDIT_RETENTION_DAYS = 90;

/**
 * Purga semanal de logs operativos con retencion de 90 dias (ADR-05 safe):
 *  - ALERT: terminales (todas las antiguas, OPEN incluidas se consideran
 *    accionadas tras 90d de vida util del registro).
 *  - COMPENSATION: solo estados terminales EXECUTED/FAILED.
 *  - WEBHOOK_EVENT: solo PROCESSED/CLOSED (append-only fiscal: nunca los
 *    pendientes).
 *  - SLOT_LOCK/RATE_LIMIT/caches: NUNCA aqui (los purga cleanExpiredLocks por
 *    expiresAt; borrarlos por antiguedad romper ia semantica de TTL).
 */
export async function cleanAuditLogs() {
    const traceId = makeTraceId("cron-audit");
    try {
        const cutoff = new Date(Date.now() - AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
        const TERMINAL = [
            CONTROL_STATUS.EXECUTED, CONTROL_STATUS.FAILED,
            CONTROL_STATUS.PROCESSED, CONTROL_STATUS.CLOSED,
        ];
        const PURGABLE = [CONTROL_TYPE.ALERT, CONTROL_TYPE.COMPENSATION, CONTROL_TYPE.WEBHOOK_EVENT];

        let removed = 0;
        for (const controlType of PURGABLE) {
            const res = await withTimeout(
                wixData
                    .query(OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO)
                    .eq("controlType", controlType)
                    .lt("_createdDate", cutoff)
                    .limit(100)
                    .find({ suppressAuth: true }),
                API_TIMEOUT_MS, "cleanAuditLogs.query"
            );
            for (const item of res?.items || []) {
                const isAlert = controlType === CONTROL_TYPE.ALERT;
                const isTerminal = TERMINAL.includes(item.status);
                if (!isAlert && !isTerminal) continue;
                await wixData
                    .remove(OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO, item._id, { suppressAuth: true })
                    .catch(() => null);
                removed++;
            }
        }

        log.info("cleanAuditLogs completed", { removed, cutoff: cutoff.toISOString(), traceId });
    } catch (err) {
        log.error("cleanAuditLogs failed", { error: err?.message, traceId });
    }
}
