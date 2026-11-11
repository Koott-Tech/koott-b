/**
 * Razorpay Webhook Controller
 * 
 * PRIMARY SOURCE OF TRUTH for payment verification and session creation.
 * 
 * This endpoint:
 * - Verifies Razorpay webhook signature
 * - Handles payment.captured events
 * - Creates sessions idempotently
 * - Works even if frontend never loads
 * 
 * IMPORTANT: This is the ONLY place where sessions should be created after payment.
 * Frontend should only poll for status, never create sessions.
 */

const { supabaseAdmin } = require('../config/supabase');
const { getRazorpayConfig, verifyWebhookSignature } = require('../config/razorpay');
const { getSlotLockByOrderId, updateSlotLockStatus, releaseSlotLock } = require('../services/slotLockService');
const { createSessionFromSlotLock } = require('../services/sessionCreationService');
const userInteractionLogger = require('../utils/userInteractionLogger');

/**
 * Handle Razorpay webhook
 * 
 * Webhook events we handle:
 * - payment.captured: Payment successful, create session
 * - payment.failed: Payment failed, mark as failed
 * 
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 */
const handleRazorpayWebhook = async (req, res) => {
  try {
    console.log('🔔 Razorpay webhook received');
    console.log('📥 Headers:', {
      'x-razorpay-signature': req.headers['x-razorpay-signature']?.substring(0, 20) + '...',
      'x-razorpay-event-id': req.headers['x-razorpay-event-id']
    });

    // Get webhook body as string for signature verification
    const webhookBody = req.rawBody || JSON.stringify(req.body);
    const signature = req.headers['x-razorpay-signature'];
    const eventId = req.headers['x-razorpay-event-id'];

    if (!signature) {
      console.error('❌ Missing Razorpay webhook signature');
      return res.status(400).json({
        success: false,
        message: 'Missing webhook signature'
      });
    }

    // Verify webhook signature
    // Webhooks are signed with the secret typed in Razorpay Dashboard → Webhooks, not the
    // API key secret (using that one rejected every real webhook). Test and live
    // dashboards have their own webhook secret.
    const razorpayConfig = getRazorpayConfig();
    const secret = razorpayConfig.webhookSecret;
    if (!secret) {
      console.error('❌ RAZORPAY_WEBHOOK_SECRET is not set — cannot verify webhooks');
      return res.status(500).json({ success: false, message: 'Webhook secret not configured' });
    }

    const isValidSignature = verifyWebhookSignature(webhookBody, signature, secret);

    if (!isValidSignature) {
      console.error('❌ Invalid Razorpay webhook signature');
      console.error('   Event ID:', eventId);
      console.error('   Signature received:', signature?.substring(0, 20) + '...');
      
      // Log security event
      await userInteractionLogger.logInteraction({
        userId: 'system',
        userRole: 'system',
        action: 'razorpay_webhook_signature_failed',
        status: 'failure',
        details: {
          eventId,
          hasSignature: !!signature
        }
      });

      return res.status(401).json({
        success: false,
        message: 'Invalid webhook signature'
      });
    }

    console.log('✅ Webhook signature verified');

    const event = req.body.event;
    const payload = req.body.payload;

    console.log('📦 Webhook event:', event);
    console.log('📦 Event ID:', eventId);

    // Log webhook received
    await userInteractionLogger.logInteraction({
      userId: 'system',
      userRole: 'system',
      action: 'razorpay_webhook_received',
      status: 'success',
      details: {
        event,
        eventId,
        orderId: payload?.payment?.entity?.order_id?.substring(0, 10) + '...',
        paymentId: payload?.payment?.entity?.id?.substring(0, 10) + '...'
      }
    });

    // Handle different event types
    if (event === 'payment.captured') {
      return await handlePaymentCaptured(payload, eventId, res);
    } else if (event === 'payment.failed') {
      return await handlePaymentFailed(payload, eventId, res);
    } else if (event === 'payment.refunded') {
      return await handleRefundProcessed(payload, eventId, res);
    } else if (['refund.processed', 'refund.failed', 'refund.created'].includes(event)) {
      // Operations' refund requests (controllers/refundsController.js)
      const outcome = await require('./refundsController').refundWebhook(event, payload?.refund?.entity);
      // Razorpay has no "payment.refunded" event: a refund made in the Razorpay dashboard
      // (not through Koott's Refund button) arrives here. When it refunds the whole payment,
      // mark the payment and its session refunded, as the old payment.refunded handler did.
      if (outcome === 'unmatched' && event === 'refund.processed') {
        const p = payload?.payment?.entity;
        const full = p && Number(p.amount_refunded || 0) >= Number(p.amount || 0) && Number(p.amount || 0) > 0;
        if (full) return handleRefundProcessed(payload, eventId, res);
      }
      return res.status(200).json({ success: true, message: `${event} applied` });
    } else {
      console.log('ℹ️ Unhandled webhook event:', event);
      // Return 200 to acknowledge receipt (don't retry)
      return res.status(200).json({
        success: true,
        message: 'Event received but not handled'
      });
    }
  } catch (error) {
    console.error('❌ Error processing Razorpay webhook:', error);
    console.error('   Error stack:', error.stack);
    
    // Return 500 so Razorpay retries
    return res.status(500).json({
      success: false,
      message: 'Internal server error processing webhook'
    });
  }
};

/**
 * The client paid, but only after their hold lapsed, and the time (or one overlapping
 * it) was booked by someone else meanwhile. No session is created: the money goes back
 * through Razorpay, the client is told by email and on the success page, and ops get
 * an alert — with "refund it by hand" when Razorpay refused the refund.
 */
const refundTakenSlot = async ({ paymentRecord, slotLock, paymentId, amount, clashes }) => {
  const orderId = paymentRecord.razorpay_order_id;
  const notes = paymentRecord.razorpay_params?.notes || {};
  const whenIst = `${slotLock.scheduled_date} ${String(slotLock.scheduled_time || '').slice(0, 5)} IST`;

  if (paymentRecord.status === 'refunded') {
    return { success: false, error: 'SLOT_ALREADY_BOOKED', refunded: true, message: 'This payment was already refunded.' };
  }

  let refund = null;
  let refundError = null;
  try {
    const { getRazorpayInstance } = require('../config/razorpay');
    refund = await getRazorpayInstance().payments.refund(paymentId, {
      amount,
      speed: 'normal',
      notes: { reason: 'slot_taken_during_payment', order_id: orderId },
    });
  } catch (e) {
    refundError = e?.error?.description || e?.message || String(e);
    console.error('❌ Automatic refund failed:', refundError);
  }

  await supabaseAdmin
    .from('payments')
    .update(refund
      ? { status: 'refunded', razorpay_payment_id: paymentId, completed_at: new Date().toISOString() }
      : { status: 'success', razorpay_payment_id: paymentId, completed_at: new Date().toISOString() })
    .eq('id', paymentRecord.id);
  await updateSlotLockStatus(orderId, 'FAILED', { paymentId }).catch(() => {});

  const emailService = require('../utils/emailService');
  const alertTo = process.env.PAYMENT_ALERT_EMAIL || process.env.COMPANY_ADMIN_EMAIL;
  const amountInr = (Number(amount) || 0) / 100;
  if (alertTo) {
    emailService.sendEmail({
      to: alertTo,
      subject: refund
        ? '⚠️ Paid after the slot was taken — refunded automatically'
        : '🚨 Paid after the slot was taken — REFUND FAILED, refund by hand',
      html: `
        <h2>${refund ? 'Refunded automatically' : 'Automatic refund failed — please refund in Razorpay'}</h2>
        <p>The client paid after their 15-minute hold ran out, and the time had been booked meanwhile, so no session was created.</p>
        <ul>
          <li>Client: ${notes.clientName || '-'} (${notes.clientEmail || '-'})</li>
          <li>Therapist id: ${slotLock.psychologist_id}</li>
          <li>Time: ${whenIst}</li>
          <li>Amount: ₹${amountInr}</li>
          <li>Razorpay order: ${orderId} · payment: ${paymentId}</li>
          <li>${refund ? `Refund id: ${refund.id}` : `Refund error: ${refundError}`}</li>
          <li>Clashes with: ${clashes.map((c) => `${c.source} ${c.id}`).join(', ')}</li>
        </ul>
        <p>Please contact the client to offer another time.</p>`,
    }).catch((e) => console.error('❌ Could not send the refund alert email:', e?.message));
  }
  if (notes.clientEmail) {
    emailService.sendEmail({
      to: notes.clientEmail,
      subject: 'Your Koott booking could not be completed',
      html: `
        <p>Hi ${notes.clientName || 'there'},</p>
        <p>Your payment of ₹${amountInr} came through after the time you picked (${whenIst}) had been booked by someone else, so we could not book it for you.</p>
        <p>${refund
          ? 'We have refunded the full amount. Refunds usually reach your account in 5–7 working days.'
          : 'We will refund the full amount. Our team has been told and will be in touch.'}</p>
        <p>Our team will contact you to find another time. You can also book a new time on koott.in.</p>
        <p>Team Koott</p>`,
    }).catch((e) => console.error('❌ Could not email the client about the refund:', e?.message));
  }

  return {
    success: false,
    error: 'SLOT_ALREADY_BOOKED',
    refunded: Boolean(refund),
    message: refund
      ? 'The time you picked was booked by someone else before your payment came through. Your payment has been refunded.'
      : 'The time you picked was booked by someone else before your payment came through. Our team will refund you.',
  };
};

/**
 * Process payment.captured event (can be called directly or from webhook)
 * 
 * @param {Object} payload - Webhook payload
 * @param {string} eventId - Event ID for logging
 * @param {boolean} skipSignatureCheck - Skip signature verification (for manual triggers)
 * @returns {Promise<Object>} { success: boolean, sessionId?: string, message: string }
 */
/**
 * Wrapper: the paid order's therapist is held (utils/therapistLock) while its session is
 * created, so a payment landing at the same moment as an admin booking or another
 * client's checkout for that therapist is handled one after the other, never both.
 */
const processPaymentCaptured = async (payload, eventId, skipSignatureCheck = false) => {
  const orderId = payload?.payment?.entity?.order_id;
  let psychologistId = null;
  if (orderId) {
    const { data } = await supabaseAdmin
      .from('payments').select('psychologist_id').eq('razorpay_order_id', orderId).maybeSingle();
    psychologistId = data?.psychologist_id || null;
  }
  if (!psychologistId) return processPaymentCapturedUnlocked(payload, eventId, skipSignatureCheck);
  const { withTherapistLock } = require('../utils/therapistLock');
  return withTherapistLock(psychologistId, () => processPaymentCapturedUnlocked(payload, eventId, skipSignatureCheck));
};

const processPaymentCapturedUnlocked = async (payload, eventId, skipSignatureCheck = false) => {
  try {
    const payment = payload.payment?.entity;
    
    if (!payment) {
      console.error('❌ Payment data missing in webhook payload');
      return {
        success: false,
        message: 'Payment data missing'
      };
    }

    const orderId = payment.order_id;
    const paymentId = payment.id;
    const amount = payment.amount; // Amount in paise
    const currency = payment.currency;

    console.log('💰 Payment captured:', {
      orderId: orderId?.substring(0, 10) + '...',
      paymentId: paymentId?.substring(0, 10) + '...',
      amount,
      currency,
      manualTrigger: skipSignatureCheck
    });

    if (!orderId || !paymentId) {
      console.error('❌ Missing order_id or payment_id');
      return {
        success: false,
        message: 'Missing order_id or payment_id'
      };
    }

    // CRITICAL FIX: Webhook idempotency - Check if payment already processed by payment_id
    const { data: existingPaymentByPaymentId } = await supabaseAdmin
      .from('payments')
      .select('id, session_id, status')
      .eq('razorpay_payment_id', paymentId)
      .maybeSingle();

    if (existingPaymentByPaymentId) {
      // Payment already processed - idempotent webhook
      if (existingPaymentByPaymentId.session_id) {
        const { data: existingSession } = await supabaseAdmin
          .from('sessions')
          .select('id')
          .eq('id', existingPaymentByPaymentId.session_id)
          .maybeSingle();

        if (existingSession) {
          console.log('✅ Payment already processed (idempotent webhook):', existingSession.id);
          return {
            success: true,
            message: 'Payment already processed',
            sessionId: existingSession.id,
            alreadyProcessed: true
          };
        }
      }
    }

    // Get payment record by order ID (always exists)
    const { data: paymentRecord } = await supabaseAdmin
      .from('payments')
      .select('id, amount, razorpay_order_id, razorpay_payment_id, psychologist_id, client_id, package_id, session_id, razorpay_params, status')
      .eq('razorpay_order_id', orderId)
      .maybeSingle();

    if (!paymentRecord) {
      console.error('❌ Payment record not found for order:', orderId);
      return {
        success: false,
        message: 'Payment record not found'
      };
    }

    // CRITICAL FIX: Ensure razorpay_payment_id is stored for idempotency
    if (!paymentRecord.razorpay_payment_id && paymentId) {
      await supabaseAdmin
        .from('payments')
        .update({ razorpay_payment_id: paymentId })
        .eq('id', paymentRecord.id);
    }

    // Check if session already exists
    if (paymentRecord.session_id) {
      const { data: existingSession } = await supabaseAdmin
        .from('sessions')
        .select('id')
        .eq('id', paymentRecord.session_id)
        .maybeSingle();

      if (existingSession) {
        console.log('✅ Session already exists:', existingSession.id);
        return {
          success: true,
          message: 'Payment already processed',
          sessionId: existingSession.id
        };
      }
    }

    // Get slot lock by order ID (may not exist for legacy payments)
    const slotLockResult = await getSlotLockByOrderId(orderId);

    if (!slotLockResult.success || !slotLockResult.data) {
      console.log('⚠️ Slot lock not found - using legacy payment flow');
      
      // LEGACY MODE: Create session directly from payment record
      // This handles payments created before slot locking was implemented
      return await handleLegacyPaymentDirect(paymentRecord, paymentId, amount);
    }

    const slotLock = slotLockResult.data;

    // Check if already processed (idempotent check)
    if (slotLock.status === 'SESSION_CREATED') {
      console.log('✅ Payment already processed, session exists');
      
      // paymentRecord already fetched above, check session_id
      if (paymentRecord && paymentRecord.session_id) {
        return {
          success: true,
          message: 'Payment already processed',
          sessionId: paymentRecord.session_id
        };
      }
    }

    // EDGE CASE HANDLING: Payment succeeds after slot lock expired/failed
    // If slot lock is FAILED or EXPIRED, check if slot is still available
    let slotLockUpdated = false;
    // The hold ran out before the money arrived (status changed by the cleanup job, or
    // its time simply passed): someone else may have booked this time, or one that
    // overlaps it, meanwhile.
    const holdLapsed = slotLock.status === 'FAILED' || slotLock.status === 'EXPIRED'
      || (slotLock.slot_expires_at && new Date(slotLock.slot_expires_at) < new Date()
        && ['SLOT_HELD', 'PAYMENT_PENDING'].includes(slotLock.status));
    if (holdLapsed) {
      console.log('⚠️ Payment arrived after the slot hold lapsed - checking the time is still free');

      // Any overlap counts (a couple session crossing an individual one, the 10-min
      // break), not just the same start time.
      let packageType = null;
      if (paymentRecord.package_id) {
        const { data: pkg } = await supabaseAdmin
          .from('packages').select('package_type').eq('id', paymentRecord.package_id).maybeSingle();
        packageType = pkg?.package_type || null;
      }
      const { findOverlaps, sessionMinutesForPackageType } = require('../utils/sessionSlots');
      const clashes = await findOverlaps({
        psychologistId: slotLock.psychologist_id,
        date: slotLock.scheduled_date,
        time: slotLock.scheduled_time,
        minutes: sessionMinutesForPackageType(packageType),
      });

      if (clashes.length > 0) {
        console.error('❌ Paid time was taken while the client was paying - refunding');
        return await refundTakenSlot({ paymentRecord, slotLock, paymentId, amount, clashes });
      }
      
      console.log('✅ Slot is still available - proceeding with session creation');
      // Update slot lock to PAYMENT_SUCCESS to proceed
      const updateResult = await updateSlotLockStatus(orderId, 'PAYMENT_SUCCESS', {
        paymentId,
        signature: payment.signature || null
      });
      
      if (updateResult.success) {
        slotLockUpdated = true;
        slotLock.status = 'PAYMENT_SUCCESS'; // Update local reference
      } else {
        console.warn('⚠️ Failed to update FAILED slot lock to PAYMENT_SUCCESS, but continuing');
      }
    }
    
    // Update slot lock to PAYMENT_SUCCESS (if not already updated above)
    if (!slotLockUpdated) {
      const updateResult = await updateSlotLockStatus(orderId, 'PAYMENT_SUCCESS', {
        paymentId,
        signature: payment.signature || null
      });

      if (!updateResult.success) {
        console.error('❌ Failed to update slot lock status');
        // Don't return error - try to proceed with session creation anyway
        // The session creation will fail if slot is not available
        console.warn('⚠️ Continuing with session creation despite slot lock update failure');
      }
    }

    // Verify payment amount matches expected amount
    // paymentRecord already fetched above
    if (paymentRecord) {
      const expectedAmount = Math.round(paymentRecord.amount * 100); // Convert to paise
      if (amount !== expectedAmount) {
        console.error('❌ Payment amount mismatch:', {
          expected: expectedAmount,
          received: amount
        });
        
        await updateSlotLockStatus(orderId, 'FAILED', {
          reason: `Amount mismatch: expected ${expectedAmount}, received ${amount}`
        });

        return {
          success: false,
          message: 'Payment amount mismatch'
        };
      }

      // Extract payment method from Razorpay payment entity
      let paymentMethod = null;
      if (payment.method) {
        paymentMethod = payment.method;
      }
      
      // Update payment record with payment_id and status
      const updateData = {
        status: 'success',
        razorpay_payment_id: paymentId,
        completed_at: new Date().toISOString()
      };
      
      // Add payment_method if available
      if (paymentMethod) {
        updateData.payment_method = paymentMethod;
      }
      
      await supabaseAdmin
        .from('payments')
        .update(updateData)
        .eq('id', paymentRecord.id);
    }

    // Create session (idempotent)
    console.log('📅 Creating session from slot lock...');
    const sessionResult = await createSessionFromSlotLock(slotLock);

    if (!sessionResult.success) {
      console.error('❌ Failed to create session:', sessionResult.error);
      
      // Mark as failed but don't return error (webhook will retry)
      // The recovery job will handle this
      await updateSlotLockStatus(orderId, 'PAYMENT_SUCCESS', {
        reason: 'Session creation failed, will retry'
      });

      // Return error (webhook will retry)
      return {
        success: false,
        message: 'Session creation failed',
        error: sessionResult.error
      };
    }

    console.log('✅ Session created successfully:', {
      sessionId: sessionResult.session?.id,
      alreadyExists: sessionResult.alreadyExists
    });

    // Log successful webhook processing
    await userInteractionLogger.logInteraction({
      userId: slotLock.client_id,
      userRole: 'client',
      action: 'razorpay_webhook_session_created',
      status: 'success',
      details: {
        orderId: orderId?.substring(0, 10) + '...',
        paymentId: paymentId?.substring(0, 10) + '...',
        sessionId: sessionResult.session?.id,
        eventId
      }
    });

    // PRIORITY: Check and send reminder immediately if session is in next 2 hours (async)
    if (sessionResult.session?.id) {
      try {
        const sessionReminderService = require('../services/sessionReminderService');
        sessionReminderService.checkAndSendReminderForSessionId(sessionResult.session.id).catch(err => {
          console.error('❌ Error in priority reminder check (webhook):', err);
        });
      } catch (reminderError) {
        console.error('❌ Error initiating priority reminder check (webhook):', reminderError);
      }
    }

    // Return success
    return {
      success: true,
      message: 'Payment processed and session created',
      sessionId: sessionResult.session?.id
    };
  } catch (error) {
    console.error('❌ Exception in processPaymentCaptured:', error);
    return {
      success: false,
      message: 'Internal server error',
      error: error.message
    };
  }
};

/**
 * Handle payment.captured event (webhook entry point)
 * 
 * @param {Object} payload - Webhook payload
 * @param {string} eventId - Event ID for logging
 * @param {Object} res - Express response
 */
const handlePaymentCaptured = async (payload, eventId, res) => {
  const result = await processPaymentCaptured(payload, eventId, false);

  // A refunded "paid after the time was taken" is finished; a 500 would make Razorpay retry.
  if (result.success || (result.error === 'SLOT_ALREADY_BOOKED' && result.refunded)) {
    return res.status(200).json(result);
  } else {
    return res.status(500).json(result);
  }
};

/**
 * Handle payment.refunded event
 * 
 * @param {Object} payload - Webhook payload
 * @param {string} eventId - Event ID for logging
 * @param {Object} res - Express response
 */
const handleRefundProcessed = async (payload, eventId, res) => {
  try {
    const payment = payload.payment?.entity;
    const refund = payload.refund?.entity;
    const paymentId = payment?.id || refund?.payment_id;
    const orderId = payment?.order_id;

    console.log('🔄 Refund processed:', {
      paymentId,
      orderId,
      refundId: refund?.id,
      amount: refund?.amount
    });

    if (paymentId) {
      // 1. Update payment status
      const { data: updatedPayment, error: paymentError } = await supabaseAdmin
        .from('payments')
        .update({
          status: 'refunded',
          updated_at: new Date().toISOString()
        })
        .eq('razorpay_payment_id', paymentId)
        .select('id, session_id')
        .maybeSingle();

      if (!paymentError && updatedPayment) {
        // 2. Update session status to refunded
        if (updatedPayment.session_id) {
          await supabaseAdmin
            .from('sessions')
            .update({
              status: 'refunded',
              updated_at: new Date().toISOString()
            })
            .eq('id', updatedPayment.session_id);
          
          // 3. Delete or mark commission as refunded
          await supabaseAdmin
            .from('commission_history')
            .delete()
            .eq('session_id', updatedPayment.session_id);
          
          console.log(`✅ Session ${updatedPayment.session_id} and commission removed due to refund`);
        }
      }
    } else if (orderId) {
      // Fallback to order_id if payment_id not found
       const { data: updatedPayment } = await supabaseAdmin
        .from('payments')
        .update({ status: 'refunded' })
        .eq('razorpay_order_id', orderId)
        .select('session_id')
        .maybeSingle();
      
      if (updatedPayment?.session_id) {
        await supabaseAdmin
          .from('sessions')
          .update({ status: 'refunded' })
          .eq('id', updatedPayment.session_id);
        
        await supabaseAdmin
          .from('commission_history')
          .delete()
          .eq('session_id', updatedPayment.session_id);
      }
    }

    return res.status(200).json({
      success: true,
      message: 'Refund processed and data updated'
    });
  } catch (error) {
    console.error('❌ Exception in handleRefundProcessed:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

/**
 * Handle payment.failed event
 * 
 * @param {Object} payload - Webhook payload
 * @param {string} eventId - Event ID for logging
 * @param {Object} res - Express response
 */
const handlePaymentFailed = async (payload, eventId, res) => {
  try {
    const payment = payload.payment?.entity;
    const orderId = payment?.order_id;

    console.log('❌ Payment failed:', {
      orderId: orderId?.substring(0, 10) + '...',
      error: payment?.error_description
    });

    if (orderId) {
      // Release slot lock immediately (mark as FAILED)
      const releaseResult = await releaseSlotLock(orderId);
      if (releaseResult.success && releaseResult.released) {
        console.log('✅ Slot lock released due to payment failure');
      } else if (releaseResult.notFound) {
        console.log('ℹ️ Slot lock not found (may have been already released)');
      }

      // Update payment record
      await supabaseAdmin
        .from('payments')
        .update({
          status: 'failed',
          completed_at: new Date().toISOString()
        })
        .eq('razorpay_order_id', orderId);
    }

    return res.status(200).json({
      success: true,
      message: 'Payment failure recorded and slot released'
    });
  } catch (error) {
    console.error('❌ Exception in handlePaymentFailed:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

/**
 * Handle legacy payment directly (no res object, returns result)
 * 
 * @param {Object} paymentRecord - Payment record from database
 * @param {string} paymentId - Razorpay payment ID
 * @param {number} amount - Payment amount in paise
 * @returns {Promise<Object>} { success: boolean, sessionId?: string, message: string }
 */
const handleLegacyPaymentDirect = async (paymentRecord, paymentId, amount) => {
  try {
    console.log('🔄 Processing legacy payment (no slot lock)');

    // Verify payment amount
    const expectedAmount = Math.round(paymentRecord.amount * 100); // Convert to paise
    if (amount !== expectedAmount) {
      console.error('❌ Payment amount mismatch:', {
        expected: expectedAmount,
        received: amount
      });
      return {
        success: false,
        message: 'Payment amount mismatch'
      };
    }

    // Update payment record
    await supabaseAdmin
      .from('payments')
      .update({
        status: 'success',
        razorpay_payment_id: paymentId,
        completed_at: new Date().toISOString()
      })
      .eq('id', paymentRecord.id);

    // Get booking details from payment notes
    const notes = paymentRecord.razorpay_params?.notes || {};
    const scheduledDate = notes.scheduledDate;
    const scheduledTime = notes.scheduledTime;
    const psychologistId = paymentRecord.psychologist_id || notes.psychologistId;
    const clientId = paymentRecord.client_id || notes.clientId;

    if (!scheduledDate || !scheduledTime || !psychologistId || !clientId) {
      console.error('❌ Missing booking details in payment record');
      return {
        success: false,
        message: 'Missing booking details'
      };
    }

    // Check if session already exists
    const { data: existingSession } = await supabaseAdmin
      .from('sessions')
      .select('id')
      .eq('psychologist_id', psychologistId)
      .eq('client_id', clientId)
      .eq('scheduled_date', scheduledDate)
      .eq('scheduled_time', scheduledTime)
      .eq('status', 'booked')
      .maybeSingle();

    if (existingSession) {
      console.log('✅ Session already exists (legacy):', existingSession.id);
      await supabaseAdmin
        .from('payments')
        .update({ session_id: existingSession.id })
        .eq('id', paymentRecord.id);

      return {
        success: true,
        message: 'Session already exists',
        sessionId: existingSession.id
      };
    }

    // Create session
    const sessionData = {
      client_id: clientId,
      psychologist_id: psychologistId,
      scheduled_date: scheduledDate,
      scheduled_time: scheduledTime,
      status: 'booked',
      price: paymentRecord.amount,
      payment_id: paymentRecord.id,
      original_scheduled_date: scheduledDate
    };

    if (paymentRecord.package_id && paymentRecord.package_id !== 'null' && paymentRecord.package_id !== 'undefined' && paymentRecord.package_id !== 'individual') {
      sessionData.package_id = paymentRecord.package_id;
    }

    const { data: session, error: sessionError } = await supabaseAdmin
      .from('sessions')
      .insert([sessionData])
      .select('*')
      .single();

    if (sessionError) {
      // Check if it's a duplicate (race condition)
      if (sessionError.code === '23505' || sessionError.message?.includes('unique')) {
        // Try to get the existing session
        const { data: existing } = await supabaseAdmin
          .from('sessions')
          .select('id')
          .eq('psychologist_id', psychologistId)
          .eq('client_id', clientId)
          .eq('scheduled_date', scheduledDate)
          .eq('scheduled_time', scheduledTime)
          .eq('status', 'booked')
          .maybeSingle();

        if (existing) {
          await supabaseAdmin
            .from('payments')
            .update({ session_id: existing.id })
            .eq('id', paymentRecord.id);

          return {
            success: true,
            message: 'Session created by concurrent request',
            sessionId: existing.id
          };
        }
      }

      console.error('❌ Error creating session (legacy):', sessionError);
      return {
        success: false,
        message: 'Failed to create session',
        error: sessionError.message
      };
    }

    console.log('✅ Session created (legacy):', session.id);

    // Update payment with session_id
    await supabaseAdmin
      .from('payments')
      .update({ session_id: session.id })
      .eq('id', paymentRecord.id);

    return {
      success: true,
      message: 'Payment processed and session created (legacy)',
      sessionId: session.id
    };
  } catch (error) {
    console.error('❌ Exception in handleLegacyPaymentDirect:', error);
    return {
      success: false,
      message: 'Internal server error',
      error: error.message
    };
  }
};

/**
 * Handle legacy payment (with res object, for webhook)
 * 
 * @param {Object} paymentRecord - Payment record from database
 * @param {string} paymentId - Razorpay payment ID
 * @param {number} amount - Payment amount in paise
 * @param {Object} res - Express response
 */
const handleLegacyPayment = async (paymentRecord, paymentId, amount, res) => {
  const result = await handleLegacyPaymentDirect(paymentRecord, paymentId, amount);
  
  if (result.success) {
    return res.status(200).json(result);
  } else {
    return res.status(500).json(result);
  }
};

module.exports = {
  handleRazorpayWebhook,
  processPaymentCaptured // Export for manual triggers
};

