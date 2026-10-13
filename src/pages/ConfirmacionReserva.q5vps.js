/*
=============================================================================
MODULE: pages/ConfirmacionReserva.q5vps.js (Velo page code, Europe/Madrid)
VERSION: v5010.1-PAGE-CONFIRMACION (reemision FASE7 / riesgo MEDIO resuelto)
BASE: pagina vacia (0 bytes) detectada en auditoria SSOT v5010.1
RESPONSIBILITY:
  - Confirmacion de reserva post-checkout: muestra datos de la reserva y
    emite el recibo Verifactu (QR + HTML) desde MovimientosCaja (SSOT fiscal).
  - Importa EXCLUSIVAMENTE funciones existentes del contrato public/qrHelper:
      buildVerifactuQrUrl(params)      -> URL verificacion AEAT TIKE-CONT
      buildVerifactuReceiptHtml(mov, opts) -> bloque HTML recibo
    (Fix riesgo "importa funcs inexistentes": qrHelper ahora exporta ambos.)
CONTRACTS:
  - createBooking canonical: bookedEntity.slot.{serviceId, scheduleId,
    startDate(Z), endDate(Z), timezone, resource.id}; totalParticipants:1.
  - Nomenclatura V20.1: issuerTaxId, invoiceNumber, invoiceIssueDate,
    totalAmount, recordHash, digitalSignature, recordTimestamp.
  - Dual F1+F2: pairToken compartido; si existe F2 se muestra como linea
    asociada (mismo staff, gap <= 120 min validado en bookingSaga).
  - TZ site: Europe/Madrid | Moneda: EUR.
STANDARDS: G10 ASCII Strict (sin acentos en codigo).
=============================================================================
*/

// FASE4: import wixData retirado (SSOT-07 / frontend minimo): esta pagina no
// accede directamente al CMS; toda lectura pasa por webMethods (reservas.web,
// cajas.web). El contrato de pagina no cambio.
import wixWindow from 'wix-window-frontend';

// Web functions reales reemitidas en FASE7 v5010.1 (anteriormente el riesgo
// MEDIO consistia en importar funciones inexistentes; ahora existen ambas):
import { getConfirmedBookingForDisplay } from 'backend/reservas.web.js';
import { getMovimientoByBooking } from 'backend/cajas.web.js';

import {
    buildVerifactuQrUrl,
    buildVerifactuReceiptHtml,
} from 'public/qrHelper.js';

const TZ = 'Europe/Madrid';
const CURRENCY = 'EUR';

// ID canonicos Wix (ingles camelCase) segun reglas de nomenclatura v5010.1
const ELEMENT_IDS = Object.freeze({
    BOOKING_ID_TEXT: 'txtBookingId',
    SUMMARY_TEXT: 'txtSummary',
    QR_LINK: 'linkQrVerify',
    RECEIPT_CONTAINER: 'boxReceipt',
    BTN_HOME: 'btnHome',
});

let resolvedBookingId = null;

export async function onReady() {
    let context = {};
    try {
        context = (await wixWindow.lightbox.getContext()) || {};
    } catch (_) {
        context = {};
    }
    const params = new URLSearchParams($w.location.query || '');
    resolvedBookingId = _safeTrim(
        context.bookingId ||
        context.booking?.bookingId ||
        params.get('bookingId')
    );

    if (!resolvedBookingId) {
        $w(ELEMENT_IDS.SUMMARY_TEXT).text =
            'No se ha encontrado el identificador de reserva.';
        return;
    }

    $w.onEvent(ELEMENT_IDS.BTN_HOME, () => {
        wixWindow.lightBox.close();
        $w.to('/inicio');
    });

    loadConfirmation();
}

/**
 * Carga la reserva confirmada y su apunte fiscal en MovimientosCaja
 * (SSOT unico), y renderiza el recibo Verifactu con QR oficial AEAT.
 */
export async function loadConfirmation() {
    try {
        const bookingRes = await getBookingForConfirmation(resolvedBookingId);

        if (!bookingRes || !bookingRes.ok) {
            $w(ELEMENT_IDS.SUMMARY_TEXT).text =
                'La reserva no esta disponible o aun no esta confirmada.';
            return;
        }

        const booking = bookingRes.data;
        $w(ELEMENT_IDS.BOOKING_ID_TEXT).text = `Reserva ${booking.bookingId}`;
        // AUDIT-BUG-24 (v11.6): la confirmacion diferencia reserva y pago.
        const estadoNota = _formatEstadoPago(booking);
        $w(ELEMENT_IDS.SUMMARY_TEXT).text =
            (_formatSummary(booking) + (estadoNota ? `\n${estadoNota}` : '')).trim();

        const movRes = await getMovimientoCajaByBooking(booking.bookingId);

        if (movRes && movRes.ok && movRes.data) {
            renderVerifactuReceipt(movRes.data);
        }
    } catch (err) {
        console.error('ConfirmacionReserva.loadConfirmation failed', {
            bookingId: resolvedBookingId,
            error: err && err.message,
        });
        $w(ELEMENT_IDS.SUMMARY_TEXT).text =
            'No hemos podido cargar la confirmacion. Intentalo de nuevo.';
    }
}

/**
 * Renderiza QR + recibo HTML. Usa SOLO las funciones reemitidas del
 * contrato public/qrHelper v5010.1 (buildVerifactuQrUrl +
 * buildVerifactuReceiptHtml). No reintroduce endpoints legacy.
 */
export function renderVerifactuReceipt(movimiento) {
    const qrUrl = buildVerifactuQrUrl({
        issuerTaxId: movimiento.issuerTaxId,
        invoiceNumber: movimiento.invoiceNumber,
        invoiceIssueDate: movimiento.invoiceIssueDate,
        totalAmount: movimiento.totalAmount,
        recordHash: movimiento.recordHash,
    });

    if (qrUrl) {
        $w(ELEMENT_IDS.QR_LINK).href = qrUrl;
        $w(ELEMENT_IDS.QR_LINK).target = '_blank';
        $w(ELEMENT_IDS.QR_LINK).visible = true;
    } else {
        $w(ELEMENT_IDS.QR_LINK).visible = false;
    }

    const html = buildVerifactuReceiptHtml(movimiento, {});

    if (html) {
        // El contenedor es un HTML element de la pagina (rich content)
        $w('#verifactuHtml').html = html;
        $w(ELEMENT_IDS.RECEIPT_CONTAINER).visible = true;
    }
}

// ============================================================================
// HELPERS LOCALES (prefijo _ para no exponer en el contrato de pagina)
// ============================================================================

function _safeTrim(value) {
    return typeof value === 'string' ? value.trim() : '';
}

/**
 * AUDIT-BUG-24 (v11.6): nota de estado que separa la confirmacion de la cita
 * del estado del pago. Basada en bookingStatus/paymentStatus canonicos
 * (BOOKING_STATUS.PENDING_PAYMENT / PAYMENT_STATUS.PENDING_PAYMENT del SSOT).
 */
function _formatEstadoPago(booking) {
    const bookingStatus = _safeTrim(
        (booking && (booking.bookingStatus || booking.status)) || ''
    ).toUpperCase();
    const paymentStatus = _safeTrim(
        (booking && booking.paymentStatus) || ''
    ).toUpperCase();

    if (paymentStatus === 'PENDING_PAYMENT' || bookingStatus === 'PENDING_PAYMENT') {
        return 'Cita creada - pago pendiente. Recibiras el enlace de pago por email.';
    }
    if (paymentStatus === 'PAYMENT_FAILED' || paymentStatus === 'FAILED') {
        return 'No se completo el pago. La cita puede liberarse si no se paga.';
    }
    if (paymentStatus === 'PAID') {
        return 'Cita confirmada - pago recibido.';
    }
    if (bookingStatus === 'CONFIRMED') {
        return 'Cita confirmada - pago presencial en el salon.';
    }
    return '';
}

function _formatSummary(booking) {
    const slot = booking && booking.slot ? booking.slot : {};
    const startValue = slot.startDate || booking.slotStart;
    const start = startValue ? new Date(startValue) : null;
    const parts = [];

    if (start && !Number.isNaN(start.getTime())) {
        parts.push(
            new Intl.DateTimeFormat('es-ES', {
                dateStyle: 'full',
                timeStyle: 'short',
                timeZone: TZ,
            }).format(start)
        );
    }

    const serviceId = slot.serviceId || booking.serviceId;
    if (serviceId) {
        parts.push(`Servicio: ${serviceId}`);
    }

    if ((slot.resource && slot.resource.id) || booking.resourceId) {
        parts.push(`Profesional asignado`);
    }

    const amount = booking.totalPrice ?? booking.totalAmount ?? booking.price ?? 0;
    parts.push(`Importe: ${_formatEuro(amount)}`);

    if (booking.pairToken) {
        parts.push('Cita dual (F1+F2) confirmada con el mismo profesional.');
    }

    return parts.join('  |  ');
}

function _formatEuro(centsOrUnits) {
    const value = Number(centsOrUnits) || 0;
    return new Intl.NumberFormat('es-ES', {
        style: 'currency',
        currency: CURRENCY,
        timeZone: TZ,
    }).format(value);
}

// ============================================================================
// LLAMADAS BACKEND (web functions reales: reservas.web / cajas.web, v5010.1)
// ============================================================================

async function getBookingForConfirmation(bookingId) {
    // Reserva en reservas.web.getConfirmedBookingForDisplay (FASE7 v5010.1):
    // solo CONFIRMED / PENDING_PAYMENT, proyeccion canonica del slot.
    try {
        return await getConfirmedBookingForDisplay({ bookingId });
    } catch (_) {
        return null;
    }
}

async function getMovimientoCajaByBooking(bookingId) {
    // Delega en cajas.web.getMovimientoByBooking (FASE7 v5010.1): lectura del
    // apunte append-only del ledger (hash chain SHA-256 verificada server-side).
    try {
        return await getMovimientoByBooking({ bookingId });
    } catch (_) {
        return null;
    }
}
