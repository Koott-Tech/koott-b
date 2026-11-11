/**
 * Session Creation Service
 * 
 * Provides idempotent session creation from slot locks.
 * This service is called by the Razorpay webhook after payment verification.
 * 
 * Key features:
 * - Fully idempotent (can be called multiple times safely)
 * - Prevents double booking with database constraints
 * - Handles race conditions gracefully
 */

const { supabaseAdmin } = require('../config/supabase');
const { recordSlotBooking } = require('../utils/slotEvents');
const { assertClientPackageHasAvailableSlot } = require('./packageService');
const { updateSlotLockStatus } = require('./slotLockService');
const meetLinkService = require('../utils/meetLinkService');
const { getMeetEventDurationMinutes } = require('../utils/sessionMeetDuration');
const emailService = require('../utils/emailService');
const userInteractionLogger = require('../utils/userInteractionLogger');
const {
  buildKoottSessionDescription,
  buildKoottSessionTitle,
  getClientDisplayName,
  getPsychologistDisplayName,
} = require('../utils/sessionTitleFormatter');

/**
 * Create session from slot lock (idempotent)
 * 
 * @param {Object} slotLock - Slot lock record
 * @returns {Promise<Object>} { success: boolean, session?: session, error?: string, alreadyExists?: boolean }
 */
const createSessionFromSlotLock = async (slotLock) => {
  try {
    console.log('📅 Creating session from slot lock:', {
      lockId: slotLock.id,
      orderId: slotLock.order_id?.substring(0, 10) + '...',
      status: slotLock.status
    });

    // Check if session already exists for this slot lock
    // We can check by looking for a session with matching details
    // (the payment lookup below runs at the same time)
    const paymentLookup = supabaseAdmin
      .from('payments')
      .select('id, amount, package_id, session_type, razorpay_params')
      .eq('razorpay_order_id', slotLock.order_id)
      .maybeSingle()
      .then((r) => r); // .then starts the request now (query builders are lazy)
    const { data: existingSession, error: checkError } = await supabaseAdmin
      .from('sessions')
      .select('id, status, payment_id')
      .eq('psychologist_id', slotLock.psychologist_id)
      .eq('client_id', slotLock.client_id)
      .eq('scheduled_date', slotLock.scheduled_date)
      .eq('scheduled_time', slotLock.scheduled_time)
      .eq('status', 'booked')
      .maybeSingle();

    if (checkError) {
      console.error('❌ Error checking existing session:', checkError);
      return {
        success: false,
        error: 'Failed to check existing session',
        code: 'DB_ERROR',
        isPermanent: false
      };
    }

    if (existingSession) {
      console.log('✅ Session already exists:', {
        sessionId: existingSession.id,
        paymentId: existingSession.payment_id
      });

      // Update slot lock to SESSION_CREATED if not already
      if (slotLock.status !== 'SESSION_CREATED') {
        await updateSlotLockStatus(slotLock.order_id, 'SESSION_CREATED');
      }

      return {
        success: true,
        session: existingSession,
        alreadyExists: true
      };
    }

    // Get payment record to get amount and other details
    const { data: paymentRecord, error: paymentError } = await paymentLookup;

    if (paymentError) {
      console.error('❌ Error fetching payment record:', paymentError);
      return {
        success: false,
        error: 'Failed to fetch payment record',
        code: 'DB_ERROR',
        isPermanent: false
      };
    }

    if (!paymentRecord) {
      console.error('❌ Payment record not found for order:', slotLock.order_id);
      return {
        success: false,
        error: 'Payment record not found',
        code: 'PAYMENT_NOT_FOUND',
        isPermanent: true
      };
    }

    // Prepare session data
    const sessionData = {
      client_id: slotLock.client_id,
      psychologist_id: slotLock.psychologist_id,
      scheduled_date: slotLock.scheduled_date,
      scheduled_time: slotLock.scheduled_time,
      status: 'booked',
      price: paymentRecord.amount,
      payment_id: paymentRecord.id,
      original_scheduled_date: slotLock.scheduled_date,
      // Bookings the client made themselves on the site. Admin-created rows carry
      // 'admin_manual'; labelling these explicitly lets the admin list separate the two
      // rather than inferring "website" from a NULL source.
      source: 'website',
      booking_created_at: new Date().toISOString()
    };

    // Add package_id if available (not individual session)
    if (paymentRecord.package_id && paymentRecord.package_id !== 'null' && paymentRecord.package_id !== 'undefined' && paymentRecord.package_id !== 'individual') {
      sessionData.package_id = paymentRecord.package_id;
    }

    // Set session_type from payment record, or determine from package_id
    if (paymentRecord.session_type) {
      sessionData.session_type = paymentRecord.session_type;
    } else if (paymentRecord.package_id && paymentRecord.package_id !== 'null' && paymentRecord.package_id !== 'undefined' && paymentRecord.package_id !== 'individual') {
      sessionData.session_type = 'Package Session';
    } else {
      sessionData.session_type = 'Individual Session';
    }

    if (sessionData.package_id) {
      const { data: pkgForQuota, error: pkgQuotaErr } = await supabaseAdmin
        .from('packages')
        .select('*')
        .eq('id', sessionData.package_id)
        .single();

      if (pkgQuotaErr || !pkgForQuota) {
        console.error('❌ Package not found for quota check (slot lock):', pkgQuotaErr);
        await updateSlotLockStatus(slotLock.order_id, 'FAILED', {
          reason: 'PACKAGE_NOT_FOUND_FOR_QUOTA',
          detail: pkgQuotaErr?.message
        });
        return {
          success: false,
          error: 'Invalid package for this booking',
          code: 'PACKAGE_NOT_FOUND_FOR_QUOTA',
          isPermanent: true
        };
      }

      const quotaCheck = await assertClientPackageHasAvailableSlot(
        supabaseAdmin,
        slotLock.client_id,
        pkgForQuota,
        { purchasePaymentId: paymentRecord.id } // this booking was just paid for
      );
      if (!quotaCheck.ok) {
        console.error('❌ Package quota exceeded (slot lock):', quotaCheck);
        await updateSlotLockStatus(slotLock.order_id, 'FAILED', {
          reason: 'PACKAGE_QUOTA_EXCEEDED',
          detail: quotaCheck.message
        });
        return {
          success: false,
          error: quotaCheck.message,
          code: 'PACKAGE_QUOTA_EXCEEDED',
          isPermanent: true
        };
      }
    }

    // Try to create session
    const { data: session, error: sessionError } = await supabaseAdmin
      .from('sessions')
      .insert([sessionData])
      .select('*')
      .single();

    if (!sessionError && session) {
      // A booking does not change the availability array — a taken slot is
      // filtered out when availability is read — so it is recorded here rather
      // than by diffing slots.
      Promise.resolve(recordSlotBooking({
        psychologistId: slotLock.psychologist_id,
        date: slotLock.scheduled_date,
        time: slotLock.scheduled_time,
        event: 'booked',
        actor: 'client',
        actorId: session.client_id || null,
        source: 'sessionCreationService.createSessionFromSlotLock',
      })).catch((e) => console.warn('⚠️ slot history not recorded:', e?.message || e)); // history only
    }

    if (sessionError) {
      // Check if it's a unique constraint violation (double booking)
      if (sessionError.code === '23505' || sessionError.message?.includes('unique') || sessionError.message?.includes('duplicate')) {
        console.log('⚠️ Double booking detected - slot was just booked by another user');
        
        // Try to fetch the session that was just created
        const { data: conflictingSession, error: conflictError } = await supabaseAdmin
          .from('sessions')
          .select('id, client_id, payment_id')
          .eq('psychologist_id', slotLock.psychologist_id)
          .eq('scheduled_date', slotLock.scheduled_date)
          .eq('scheduled_time', slotLock.scheduled_time)
          .eq('status', 'booked')
          .maybeSingle();

        if (conflictError) {
          console.error('❌ Error checking for conflicting session:', conflictError);
          await updateSlotLockStatus(slotLock.order_id, 'FAILED', {
            reason: 'DB_ERROR',
            detail: conflictError.message
          });
          return {
            success: false,
            error: 'Database error while checking for conflicts',
            code: 'DB_ERROR',
            isPermanent: false
          };
        }

        if (conflictingSession) {
          // Check if it's our session (same client)
          if (conflictingSession.client_id === slotLock.client_id) {
            // It's our session, just created by another request (idempotent)
            console.log('✅ Session created by concurrent request (idempotent)');
            await updateSlotLockStatus(slotLock.order_id, 'SESSION_CREATED');
            return {
              success: true,
              session: conflictingSession,
              alreadyExists: true
            };
          } else {
            // Different client - real double booking
            console.error('❌ Real double booking - different client');
            await updateSlotLockStatus(slotLock.order_id, 'FAILED', {
              reason: 'Double booking - slot taken by another user'
            });
            return {
              success: false,
              error: 'This time slot was just booked by another user',
              conflict: true,
              code: 'DOUBLE_BOOKING',
              isPermanent: true
            };
          }
        }
      }

      // Check for validation errors (permanent failures)
      const isValidationError = sessionError.code === '23514' || // Check constraint violation
        sessionError.message?.toLowerCase().includes('check constraint') ||
        sessionError.message?.toLowerCase().includes('violates check');

      console.error('❌ Error creating session:', sessionError);
      return {
        success: false,
        error: 'Failed to create session',
        details: sessionError.message,
        code: isValidationError ? 'VALIDATION_ERROR' : 'SESSION_CREATION_ERROR',
        isPermanent: isValidationError
      };
    }

    console.log('✅ Session created successfully:', {
      sessionId: session.id,
      clientId: session.client_id,
      psychologistId: session.psychologist_id
    });

    // Update payment record with session_id, and the slot lock, together
    const [{ error: paymentUpdateError }] = await Promise.all([
      supabaseAdmin
        .from('payments')
        .update({ session_id: session.id })
        .eq('id', paymentRecord.id),
      updateSlotLockStatus(slotLock.order_id, 'SESSION_CREATED'),
    ]);
    
    if (paymentUpdateError) {
      console.error('❌ Error updating payment record with session_id:', paymentUpdateError, 'paymentId:', paymentRecord.id, 'sessionId:', session.id);
      // Remediation: enqueue retry or set flag for manual reconciliation (if enqueueRetryJob exists, use it)
      try {
        const { enqueueRetryJob } = require('../jobs/recoveryJob');
        if (typeof enqueueRetryJob === 'function') {
          enqueueRetryJob('payment_session_update', { payment_id: paymentRecord.id, session_id: session.id }).catch(err =>
            console.error('Failed to enqueue payment session update retry:', err)
          );
        }
      } catch (_) {
        // No retry job available; log for manual review
      }
    } else {
      console.log('✅ Payment record updated with session_id:', session.id);
    }

    // Their booking-flow lead (if any) is now a booking
    require('../utils/bookingAccounts').markLeadBooked(slotLock.client_id).catch(() => {});

    // Log booking (not awaited: the client is waiting for the confirmation)
    Promise.resolve(userInteractionLogger.logBooking({
      userId: slotLock.client_id,
      userRole: 'client',
      psychologistId: slotLock.psychologist_id,
      packageId: paymentRecord.package_id,
      scheduledDate: slotLock.scheduled_date,
      scheduledTime: slotLock.scheduled_time,
      sessionId: session.id,
      paymentId: paymentRecord.id,
      status: 'success'
    })).catch(() => {});

    // Enqueue Meet link creation to job queue (async, non-blocking)
    enqueueMeetLinkCreation({
      slotLock,
      session,
      paymentRecord
    }).catch(err => {
      console.error('❌ Error enqueueing Meet link creation:', err);
      // Don't fail session creation if queue fails
    });

    return {
      success: true,
      session,
      alreadyExists: false
    };
  } catch (error) {
    console.error('❌ Exception in createSessionFromSlotLock:', error);
    // Determine if error is permanent based on error type
    const isPermanent = error.name === 'ValidationError' || 
      error.message?.toLowerCase().includes('validation') ||
      error.message?.toLowerCase().includes('invalid');
    
    return {
      success: false,
      error: error.message || 'Failed to create session',
      code: isPermanent ? 'VALIDATION_ERROR' : 'UNKNOWN_ERROR',
      isPermanent: isPermanent
    };
  }
};

/**
 * After-booking work (Meet link + calendar event, receipt, emails, WhatsApp), off the
 * request so the client sees "booked" at once.
 *
 * - Up to CONCURRENCY bookings at a time (one slow Google call doesn't hold the rest).
 * - Each step writes its marker on the session (google_meet_link, email_sent_at,
 *   whatsapp_sent_at) and is skipped when the marker is already there, so a retry, or
 *   the sweeper below picking a booking up again, never sends anything twice.
 * - notified_at is set when a booking's work is finished. The sweeper
 *   (sweepUnfinishedBookings) re-queues recent website bookings without it, so work lost
 *   to a restart or a crash still happens.
 */
const CONCURRENCY = 3;
class MeetLinkCreationQueue {
  constructor() {
    this.queue = [];
    this.running = 0;
    this.inFlight = new Set(); // session ids queued or running on this server
    this.maxRetries = 3;
    this.retryDelay = 5000; // 5 seconds
  }

  /**
   * Add job to queue
   * @param {Object} jobData - Job data
   */
  async enqueue(jobData) {
    const id = jobData?.session?.id;
    if (id && this.inFlight.has(id)) return undefined; // already queued here
    if (id) this.inFlight.add(id);
    return new Promise((resolve, reject) => {
      this.queue.push({
        ...jobData,
        resolve,
        reject,
        retries: 0
      });
      this.processQueue();
    });
  }

  /** Start jobs until CONCURRENCY are running. */
  processQueue() {
    while (this.running < CONCURRENCY && this.queue.length > 0) {
      const job = this.queue.shift();
      this.running += 1;
      this.runJob(job).finally(() => {
        this.running -= 1;
        this.processQueue();
      });
    }
  }

  async runJob(job) {
    try {
      await this.processJob(job);
      if (job.session?.id) this.inFlight.delete(job.session.id);
      job.resolve();
    } catch (error) {
      if (job.retries < this.maxRetries) {
        job.retries++;
        console.log(`⚠️ After-booking work failed for session ${job.session?.id}, retrying (${job.retries}/${this.maxRetries}):`, error?.message || error);
        setTimeout(() => { this.queue.push(job); this.processQueue(); }, this.retryDelay * job.retries);
      } else {
        // Left for the sweeper (notified_at is still empty).
        console.error('❌ After-booking work failed after retries; the sweeper will try again:', error?.message || error);
        if (job.session?.id) this.inFlight.delete(job.session.id);
        job.reject(error);
      }
    }
  }

  /**
   * Process a single job
   * @param {Object} job - Job to process
   */
  async processJob(job) {
    const { slotLock, session, paymentRecord } = job;

    // What is already done for this booking (a retry or the sweeper may be here again).
    const { data: state } = await supabaseAdmin
      .from('sessions')
      .select('status, google_meet_link, google_calendar_event_id, email_sent_at, whatsapp_sent_at, notified_at')
      .eq('id', session.id)
      .maybeSingle();
    if (!state) return; // session deleted
    if (state.notified_at) return; // finished earlier
    if (['cancelled', 'canceled', 'refunded'].includes(String(state.status || '').toLowerCase())) {
      await markSession(session.id, { notified_at: new Date().toISOString() });
      return;
    }

    // Client and psychologist details for Meet link, emails, and WhatsApp (together)
    const [{ data: clientDetails, error: clientError }, { data: psychologistDetails, error: psychologistError }] = await Promise.all([
      supabaseAdmin
        .from('clients')
        .select('id, first_name, last_name, child_name, phone_number, user:users(email)')
        .eq('id', slotLock.client_id)
        .single(),
      supabaseAdmin
        .from('psychologists')
        .select('id, first_name, last_name, email, phone, google_calendar_credentials')
        .eq('id', slotLock.psychologist_id)
        .single(),
    ]);

    if (clientError) {
      console.error('❌ Error fetching client details:', clientError);
      console.error('   Slot lock ID:', slotLock.id, 'Client ID:', slotLock.client_id);
      throw new Error(`Failed to fetch client details: ${clientError.message}`);
    }

    if (psychologistError) {
      console.error('❌ Error fetching psychologist details:', psychologistError);
      console.error('   Slot lock ID:', slotLock.id, 'Psychologist ID:', slotLock.psychologist_id);
      throw new Error(`Failed to fetch psychologist details: ${psychologistError.message}`);
    }

    if (!clientDetails || !psychologistDetails) {
      console.error('❌ Could not fetch client or psychologist details');
      console.error('   Client details:', clientDetails ? 'found' : 'missing');
      console.error('   Psychologist details:', psychologistDetails ? 'found' : 'missing');
      throw new Error('Client or psychologist details not found');
    }

    // Fetch package details if this is a package session
    let packageInfo = null;
    let meetDurationMinutes = 50;
    if (paymentRecord.package_id && paymentRecord.package_id !== 'null' && paymentRecord.package_id !== 'undefined' && paymentRecord.package_id !== 'individual') {
      try {
        const { data: packageData, error: packageError } = await supabaseAdmin
          .from('packages')
          .select('id, package_type, session_count')
          .eq('id', paymentRecord.package_id)
          .single();
        
        if (!packageError && packageData) {
          meetDurationMinutes = getMeetEventDurationMinutes(packageData.package_type);
          // Calculate package progress: count completed sessions for this package
          const { data: packageSessions, error: sessionsError } = await supabaseAdmin
            .from('sessions')
            .select('id, status')
            .eq('package_id', paymentRecord.package_id)
            .eq('client_id', slotLock.client_id);
          
          if (!sessionsError && packageSessions) {
            const totalSessions = packageData.session_count || 0;
            const completedSessions = packageSessions.filter(s => s.status === 'completed').length;
            const remainingSessions = Math.max(totalSessions - completedSessions, 0);
            
            packageInfo = {
              totalSessions: totalSessions,
              completedSessions: completedSessions,
              remainingSessions: remainingSessions,
              packageType: packageData.package_type || 'Package'
            };
            
            console.log('📦 Package info:', packageInfo);
          }
        }
      } catch (packageErr) {
        console.warn('⚠️ Error fetching package details:', packageErr);
      }
    }

    const { addMinutesToTime } = require('../utils/helpers');
    const endTime = addMinutesToTime(slotLock.scheduled_time, meetDurationMinutes);

    // Meet + calendar event on every booking (therapist's Google, else the company account).
    const DISABLE_AUTO_GOOGLE_MEET_ON_BOOKING = false;
    let meetLink = state.google_meet_link || null;
    let meetEventId = state.google_calendar_event_id || null;

    // Create Google Meet link
    // Handle client name: prefer child_name, but skip if it's "Pending" or empty
    const clientName = getClientDisplayName(clientDetails, 'Client');
    const psychologistName = getPsychologistDisplayName(psychologistDetails);

    // Normalize client email: Supabase can return user relation as object or array
    const clientEmail = Array.isArray(clientDetails.user)
      ? clientDetails.user?.[0]?.email
      : clientDetails.user?.email;

    const meetSessionData = {
      summary: buildKoottSessionTitle({ clientName, psychologistName }),
      description: buildKoottSessionDescription({
        clientName,
        psychologistName,
        clientPhone: clientDetails.phone_number,
      }),
      startDate: slotLock.scheduled_date,
      startTime: slotLock.scheduled_time,
      endTime: endTime,
      clientEmail: clientEmail || null,
      psychologistEmail: psychologistDetails.email || null
    };

    // Get psychologist OAuth tokens if available
    let userAuth = null;
    let credentials = psychologistDetails.google_calendar_credentials;
    if (typeof credentials === 'string') {
      try { credentials = JSON.parse(credentials); } catch (_) { credentials = null; }
    }
    if (credentials?.access_token) {
      userAuth = {
        access_token: credentials.access_token,
        refresh_token: credentials.refresh_token,
        expiry_date: credentials.expiry_date
      };
    }

    if (DISABLE_AUTO_GOOGLE_MEET_ON_BOOKING) {
      console.log('ℹ️ Google Meet auto-scheduling is temporarily disabled (sessionCreationService).');
    } else if (meetLink) {
      // Made on an earlier attempt: never a second calendar event.
    } else {
      const meetResult = await meetLinkService.generateSessionMeetLink(meetSessionData, userAuth);

      if (meetResult.success && meetResult.meetLink) {
        meetLink = meetResult.meetLink;
        meetEventId = meetResult.eventId || null;
        const { error: updateError } = await supabaseAdmin
          .from('sessions')
          .update({ 
            google_meet_link: meetResult.meetLink,
            google_meet_join_url: meetResult.meetLink,
            google_meet_start_url: meetResult.meetLink,
            google_calendar_event_id: meetResult.eventId || null
          })
          .eq('id', session.id);
        
        if (updateError) {
          console.error('❌ Error updating session with meet link:', updateError);
          throw new Error(`Failed to update session with meet link: ${updateError.message}`);
        } else {
          // Log which method was used to create the Meet link
          const method = meetResult.method || 'unknown';
          const isRealLink = method !== 'fallback' && meetResult.meetLink && !meetResult.meetLink.includes('meet.google.com/new');
          const methodDescription = {
            'oauth': '✅ Real Meet link created via OAuth (psychologist calendar)',
            'oauth_calendar': '✅ Real Meet link created via OAuth (psychologist calendar)',
            'calendar_service_account': '✅ Real Meet link created via Service Account (shared calendar)',
            'service_account_limitation': '⚠️ Service account limitation - Meet link may require manual creation',
            'calendar_error': '❌ Calendar API error - using fallback',
            'fallback': '⚠️ Fallback Meet link (manual creation may be required)',
            'unknown': '❓ Meet link created (method unknown)'
          };
          
          console.log('✅ Meet link created and saved to session:', {
            meetLink: meetResult.meetLink,
            method: method,
            isRealLink: isRealLink,
            description: methodDescription[method] || methodDescription['unknown'],
            eventId: meetResult.eventId || null,
            eventLink: meetResult.eventLink || null,
            hasOAuth: !!userAuth,
            hasPsychologistCredentials: !!psychologistDetails.google_calendar_credentials,
            error: meetResult.error || null
          });
        }
      } else {
        console.warn('⚠️ Meet link creation failed or returned fallback:', {
          error: meetResult.error,
          method: meetResult.method,
          meetLink: meetResult.meetLink
        });
        // Don't throw - fallback link is acceptable
      }
    }

    // Generate receipt before sending emails (only needed for the emails)
    let receiptResult = null;
    if (!state.email_sent_at) try {
      const { generateAndStoreReceipt } = require('./receiptService');
      
      // Fetch full payment record with transaction_id and package_id
      const { data: fullPaymentRecord } = await supabaseAdmin
        .from('payments')
        .select('id, amount, transaction_id, completed_at, razorpay_payment_id, package_id')
        .eq('id', paymentRecord.id)
        .single();
      
      console.log('🔍 sessionCreationService - Payment data for receipt:', {
        payment_id: fullPaymentRecord?.id,
        package_id: fullPaymentRecord?.package_id
      });
      
      receiptResult = await generateAndStoreReceipt(
        session,
        { 
          ...fullPaymentRecord, 
          completed_at: fullPaymentRecord?.completed_at || new Date().toISOString() 
        },
        clientDetails,
        psychologistDetails
      );
      
      if (receiptResult && receiptResult.receiptNumber) {
        console.log('✅ Receipt generated successfully:', {
          receiptNumber: receiptResult.receiptNumber,
          pdfGenerated: !!receiptResult.pdfBuffer,
          pdfSize: receiptResult.pdfBuffer?.length || 0
        });
      }
    } catch (receiptError) {
      console.error('❌ Error generating receipt:', receiptError);
      // Continue even if receipt generation fails
    }

    // Booking notifications: email to client / therapist / admin, then WhatsApp to
    // client and therapist. The client copies show the client's own time zone.
    const clientTimeZone = paymentRecord.razorpay_params?.notes?.clientTimeZone || null;
    if (!state.email_sent_at) try {
      const emailResult = await emailService.sendSessionConfirmation({
        clientName,
        psychologistName,
        sessionDate: slotLock.scheduled_date,
        sessionTime: slotLock.scheduled_time,
        durationMinutes: meetDurationMinutes,
        sessionDuration: `${meetDurationMinutes} minutes`,
        clientEmail,
        psychologistEmail: psychologistDetails.email,
        googleMeetLink: meetLink,
        googleCalendarEventId: meetEventId,
        sessionId: session.id,
        price: paymentRecord.amount,
        amount: paymentRecord.amount,
        status: session.status || 'booked',
        psychologistId: slotLock.psychologist_id,
        clientId: slotLock.client_id,
        packageInfo,
        receiptId: receiptResult?.receiptId || null,
        receiptNumber: receiptResult?.receiptNumber || null,
        receiptPdfBuffer: receiptResult?.pdfBuffer || null,
        clientTimeZone,
        clientPhone: clientDetails.phone_number || null
      });
      console.log('📧 Booking emails:', emailResult?.success ? 'sent' : 'failed', emailResult?.clientEmailError || '');
      // Marked even when one address failed: the rest went out and must not go twice.
      await markSession(session.id, emailResult?.success
        ? { email_sent_at: new Date().toISOString(), email_error: null }
        : { email_sent_at: new Date().toISOString(), email_error: String(emailResult?.clientEmailError || emailResult?.error || 'failed').slice(0, 500) });
    } catch (emailError) {
      console.error('❌ Booking emails failed:', emailError?.message || emailError);
      throw emailError; // retried (nothing was marked as sent)
    }

    // The WhatsApp templates carry the Meet link, so they need one.
    if (!meetLink) {
      // Google said no (quota, outage): the emails are out; the booking stays open, so
      // the retries here and then the sweeper (every 2 min, for 2 days) try the Meet link
      // again and send the WhatsApp once it exists.
      console.warn('⚠️ No Meet link yet for session', session.id, '— WhatsApp waits; will retry');
      await markSession(session.id, { whatsapp_error: 'waiting for the Meet link' });
      throw new Error('No Meet link yet (Google Calendar)');
    }
    if (state.whatsapp_sent_at) {
      await markSession(session.id, { notified_at: new Date().toISOString() });
      return;
    }
    // Claim the WhatsApp step first, so two servers can never both send it.
    const { data: claimed } = await supabaseAdmin
      .from('sessions').update({ whatsapp_sent_at: new Date().toISOString() })
      .eq('id', session.id).is('whatsapp_sent_at', null).select('id');
    if (!claimed || !claimed.length) {
      await markSession(session.id, { notified_at: new Date().toISOString() });
      return;
    }
    const waErrors = [];
    const interaktService = require('../utils/interaktService');
    const describe = (r) => (r?.success ? 'sent' : `not sent (${r?.reason || r?.error?.message || r?.error || 'unknown'})`);

    if (clientDetails.phone_number) {
      try {
        const r = await interaktService.sendBookingConfirmation(clientDetails.phone_number, {
          clientName,
          psychologistName,
          date: slotLock.scheduled_date,
          time: slotLock.scheduled_time,
          meetLink,
          clientTimeZone
        });
        console.log('📱 Client booking WhatsApp:', describe(r));
        if (!r?.success) waErrors.push(`client: ${describe(r)}`);
      } catch (waError) {
        console.error('❌ Client booking WhatsApp failed:', waError?.message || waError);
        waErrors.push(`client: ${waError?.message || waError}`);
      }
    } else {
      console.log('ℹ️ Client has no phone number — skipping client WhatsApp');
    }

    if (psychologistDetails.phone) {
      try {
        const r = await interaktService.sendSessionNotificationPsychologist(psychologistDetails.phone, {
          therapistName: psychologistName,
          clientName,
          date: slotLock.scheduled_date,
          time: slotLock.scheduled_time,
          meetLink
        });
        console.log('📱 Therapist booking WhatsApp:', describe(r));
        if (!r?.success) waErrors.push(`therapist: ${describe(r)}`);
      } catch (waError) {
        console.error('❌ Therapist booking WhatsApp failed:', waError?.message || waError);
        waErrors.push(`therapist: ${waError?.message || waError}`);
      }
    } else {
      console.log('ℹ️ Therapist has no phone number — skipping therapist WhatsApp');
    }
    await markSession(session.id, {
      notified_at: new Date().toISOString(),
      whatsapp_error: waErrors.length ? waErrors.join('; ').slice(0, 500) : null,
    });
  }
}

/** Write markers on a session (never throws). */
async function markSession(sessionId, fields) {
  try {
    const { error } = await supabaseAdmin.from('sessions').update(fields).eq('id', sessionId);
    if (error) console.warn('⚠️ Could not mark session', sessionId, error.message);
  } catch (e) {
    console.warn('⚠️ Could not mark session', sessionId, e?.message || e);
  }
}

// Singleton instance
const meetLinkQueue = new MeetLinkCreationQueue();

/**
 * Enqueue Meet link creation (wrapper function)
 * @param {Object} params - Parameters for Meet link creation
 * @param {Object} params.slotLock - Slot lock record
 * @param {Object} params.session - Session record
 * @param {Object} params.paymentRecord - Payment record
 * @returns {Promise} Promise that resolves when enqueued
 */
const enqueueMeetLinkCreation = ({ slotLock, session, paymentRecord }) => {
  return meetLinkQueue.enqueue({ slotLock, session, paymentRecord });
};

/**
 * Re-queue recent website bookings whose after-booking work never finished (no
 * notified_at), e.g. the server restarted with jobs waiting. Bookings younger than
 * 2 minutes are left to the live queue; older than 2 days are left alone.
 */
// Bookings from before this release never got the markers (their messages went out
// without them), so they are left alone: the sweeper would send them a second time.
const SWEEP_SINCE = Date.parse(process.env.BOOKING_SWEEP_SINCE || '2026-11-11T13:30:00Z');

async function sweepUnfinishedBookings({ onlyIds = null } = {}) {
  const now = Date.now();
  const since = Math.max(now - 2 * 864e5, Number.isFinite(SWEEP_SINCE) ? SWEEP_SINCE : now);
  let q = supabaseAdmin
    .from('sessions')
    .select('id, client_id, psychologist_id, scheduled_date, scheduled_time, status, payment_id, created_at')
    .eq('source', 'website')
    .is('notified_at', null)
    .not('payment_id', 'is', null)
    .gte('created_at', new Date(since).toISOString())
    .lte('created_at', new Date(now - 2 * 60e3).toISOString())
    .order('created_at', { ascending: true })
    .limit(25);
  if (Array.isArray(onlyIds)) q = q.in('id', onlyIds); // tests: their own rows only
  const { data: rows, error } = await q;
  if (error) {
    console.warn('⚠️ Booking sweeper:', error.message);
    return 0;
  }
  let queued = 0;
  for (const s of rows || []) {
    const { data: paymentRecord } = await supabaseAdmin
      .from('payments').select('id, amount, package_id, transaction_id, razorpay_params').eq('id', s.payment_id).maybeSingle();
    if (!paymentRecord) continue;
    const slotLock = { id: `sweep:${s.id}`, client_id: s.client_id, psychologist_id: s.psychologist_id, scheduled_date: s.scheduled_date, scheduled_time: s.scheduled_time };
    meetLinkQueue.enqueue({ slotLock, session: s, paymentRecord }).catch(() => {});
    queued += 1;
  }
  if (queued) console.log(`🧹 Booking sweeper: re-queued ${queued} booking(s) whose confirmations had not finished`);
  return queued;
}

module.exports = {
  sweepUnfinishedBookings,
  createSessionFromSlotLock,
  enqueueMeetLinkCreation
};
