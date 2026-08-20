const { supabaseAdmin } = require('../config/supabase');
const { successResponse, errorResponse } = require('../utils/helpers');

// Reserve assessment slot for payment
const reserveAssessmentSlot = async (req, res) => {
  try {
    const userId = req.user.id;
    const { assessment_id, assessment_slug, psychologist_id, scheduled_date, scheduled_time } = req.body;

    if (!psychologist_id || !scheduled_date || !scheduled_time) {
      return res.status(400).json(errorResponse('Missing required fields: psychologist_id, scheduled_date, scheduled_time'));
    }

    // Get client by user_id
    let { data: client, error: clientError } = await supabaseAdmin
      .from('clients')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (clientError || !client) {
      const fallback = await supabaseAdmin
        .from('clients')
        .select('*')
        .eq('id', userId)
        .single();
      client = fallback.data;
      clientError = fallback.error;
    }

    if (clientError || !client) {
      return res.status(404).json(errorResponse('Client profile not found'));
    }

    const clientId = client.id;
    
    // Get the actual user_id from the client record (it should reference users table)
    // If client has user_id, use it; otherwise we need to find or create the user
    let actualUserId = client.user_id;
    
    // If client doesn't have user_id, try to find it from users table
    if (!actualUserId) {
      // Try to find user by email if client has email
      if (client.email) {
        const { data: userData } = await supabaseAdmin
          .from('users')
          .select('id')
          .eq('email', client.email)
          .single();
        if (userData) {
          actualUserId = userData.id;
          // Update client record with user_id for future use
          await supabaseAdmin
            .from('clients')
            .update({ user_id: actualUserId })
            .eq('id', clientId);
        }
      }
      
      // If still no user_id found, check if userId (from req.user.id) is actually a user ID
      // by checking if it exists in users table
      if (!actualUserId && userId) {
        const { data: userCheck } = await supabaseAdmin
          .from('users')
          .select('id')
          .eq('id', userId)
          .single();
        if (userCheck) {
          actualUserId = userId;
        }
      }
    }
    
    // If still no valid user_id, we cannot proceed (assessment_sessions requires user_id foreign key)
    if (!actualUserId) {
      console.error('❌ Cannot create assessment session: No valid user_id found', {
        clientId,
        client_user_id: client.user_id,
        req_user_id: userId,
        client_email: client.email
      });
      return res.status(400).json(errorResponse('User account not properly linked. Please contact support.'));
    }

    // Get assessment details
    let assessmentData = null;
    if (assessment_id) {
      const { data } = await supabaseAdmin
        .from('assessments')
        .select('*')
        .eq('id', assessment_id)
        .single();
      assessmentData = data;
    } else if (assessment_slug) {
      const { data } = await supabaseAdmin
        .from('assessments')
        .select('*')
        .eq('slug', assessment_slug)
        .single();
      assessmentData = data;
    }

    if (!assessmentData) {
      return res.status(404).json(errorResponse('Assessment not found'));
    }

    // Check if slot is available - check both assessment sessions and regular sessions
    const { data: existingAssessmentSessions } = await supabaseAdmin
      .from('assessment_sessions')
      .select('*')
      .eq('psychologist_id', psychologist_id)
      .eq('scheduled_date', scheduled_date)
      .eq('scheduled_time', scheduled_time)
      .in('status', ['reserved', 'booked']);

    // Also check regular therapy sessions for the same psychologist, date, and time
    const { data: existingRegularSessions } = await supabaseAdmin
      .from('sessions')
      .select('*')
      .eq('psychologist_id', psychologist_id)
      .eq('scheduled_date', scheduled_date)
      .eq('scheduled_time', scheduled_time)
      .in('status', ['booked', 'rescheduled']);

    // Combine both types of sessions
    const existingSessions = [
      ...(existingAssessmentSessions || []),
      ...(existingRegularSessions || [])
    ];

    if (existingSessions && existingSessions.length > 0) {
      // Check if any of the existing sessions are regular therapy sessions (they block the slot)
      const hasRegularSession = existingRegularSessions && existingRegularSessions.length > 0;
      if (hasRegularSession) {
        console.log('❌ Slot blocked by regular therapy session');
        return res.status(400).json(errorResponse('This time slot is already booked'));
      }

      // Check if the existing reservation belongs to this client (only for assessment sessions)
      const existingAssessmentReservation = existingAssessmentSessions?.find(s => s.client_id === clientId);
      
      if (existingAssessmentReservation) {
        // If it's a reserved slot belonging to this client, allow them to reuse it
        if (existingAssessmentReservation.status === 'reserved') {
          console.log('✅ Found existing reservation for this client, allowing reuse');
          // Continue with the existing reservation
        } else if (existingAssessmentReservation.status === 'booked') {
          return res.status(400).json(errorResponse('This time slot is already booked'));
        }
      } else {
        // Another client has booked this slot (assessment or regular session)
        console.log('❌ Slot already booked by another client');
        return res.status(400).json(errorResponse('This time slot is already booked'));
      }
    }

    // Get psychologist details for pricing
    const { data: psychologist } = await supabaseAdmin
      .from('psychologists')
      .select('*')
      .eq('id', psychologist_id)
      .single();

    if (!psychologist) {
      return res.status(404).json(errorResponse('Psychologist not found'));
    }

    // Default assessment price (can be customized per assessment later)
    const assessmentPrice = assessmentData.assessment_price || 5000; // Default ₹5000

    // Check if there's an existing reserved session for this client
    let assessmentSession;
    if (existingAssessmentSessions && existingAssessmentSessions.length > 0) {
      const existingReservation = existingAssessmentSessions.find(s => s.client_id === clientId && s.status === 'reserved');
      
      if (existingReservation) {
        // Use existing reservation
        console.log('✅ Reusing existing reservation:', existingReservation.id);
        assessmentSession = existingReservation;
      }
    }

    // If no existing reservation, create a new one
    if (!assessmentSession) {
      const { data: newSession, error: sessionError } = await supabaseAdmin
        .from('assessment_sessions')
        .insert({
          user_id: actualUserId, // Use the actual user_id from client record
          client_id: clientId,
          assessment_id: assessmentData.id,
          assessment_slug: assessmentData.slug,
          psychologist_id,
          scheduled_date,
          scheduled_time,
          amount: assessmentPrice,
          currency: 'INR',
          status: 'reserved'
        })
        .select('*')
        .single();

      if (sessionError) {
        console.error('Assessment session creation error:', sessionError);
        console.error('🔍 Attempted to insert with:', {
          user_id: actualUserId,
          client_id: clientId,
          client_user_id: client.user_id,
          req_user_id: userId
        });
        return res.status(500).json(errorResponse('Failed to reserve assessment slot'));
      }
      
      assessmentSession = newSession;
    }

    res.json(successResponse({
      assessmentSessionId: assessmentSession.id,
      clientId,
      psychologistId: psychologist_id,
      scheduledDate: scheduled_date,
      scheduledTime: scheduled_time,
      amount: assessmentPrice,
      assessment: {
        id: assessmentData.id,
        slug: assessmentData.slug,
        title: assessmentData.hero_title || assessmentData.seo_title
      }
    }, 'Assessment slot reserved successfully'));

  } catch (error) {
    console.error('Reserve assessment slot error:', error);
    res.status(500).json(errorResponse('Internal server error'));
  }
};

// Book assessment session (after payment)
const bookAssessment = async (req, res) => {
  try {
    const userId = req.user.id;
    const { assessment_session_id, payment_id } = req.body;

    if (!assessment_session_id || !payment_id) {
      return res.status(400).json(errorResponse('Missing required fields: assessment_session_id, payment_id'));
    }

    // Get client
    let { data: client } = await supabaseAdmin
      .from('clients')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (!client) {
      const fallback = await supabaseAdmin
        .from('clients')
        .select('*')
        .eq('id', userId)
        .single();
      client = fallback.data;
    }

    if (!client) {
      return res.status(404).json(errorResponse('Client profile not found'));
    }

    // Update assessment session status
    const { data: updatedSession, error: updateError } = await supabaseAdmin
      .from('assessment_sessions')
      .update({
        status: 'booked',
        payment_id,
        updated_at: new Date().toISOString()
      })
      .eq('id', assessment_session_id)
      .eq('client_id', client.id)
      .eq('status', 'reserved')
      .select('*')
      .single();

    if (updateError || !updatedSession) {
      return res.status(400).json(errorResponse('Failed to book assessment session'));
    }

    // Ensure remaining assessment sessions are created as pending (total 3 sessions per package)
    try {
      // Count existing sessions for this assessment/client/payment
      const { data: existingSessions } = await supabaseAdmin
        .from('assessment_sessions')
        .select('id, status, session_number')
        .eq('assessment_id', updatedSession.assessment_id)
        .eq('client_id', updatedSession.client_id)
        .eq('psychologist_id', updatedSession.psychologist_id)
        .eq('payment_id', payment_id);

      const existingCount = existingSessions?.length || 0;

      // Build set of existing session_numbers to avoid duplicates
      const existingNumbers = new Set((existingSessions || [])
        .map(s => typeof s.session_number === 'number' ? s.session_number : null)
        .filter(n => n !== null));

      const inserts = [];
      // We want sessions 1,2,3. First booked session may not have session_number set; set if missing.
      // Ensure session_number on updatedSession = 1 if not present
      if (updatedSession.session_number == null) {
        await supabaseAdmin
          .from('assessment_sessions')
          .update({ session_number: 1, updated_at: new Date().toISOString() })
          .eq('id', updatedSession.id);
        existingNumbers.add(1);
      }

      // Create missing sessions 2 and 3 as pending
      [2, 3].forEach(n => {
        if (!existingNumbers.has(n)) {
          inserts.push({
            user_id: updatedSession.user_id,
            client_id: updatedSession.client_id,
            assessment_id: updatedSession.assessment_id,
            assessment_slug: updatedSession.assessment_slug,
            psychologist_id: updatedSession.psychologist_id,
            scheduled_date: null,
            scheduled_time: null,
            amount: updatedSession.amount,
            currency: updatedSession.currency || 'INR',
            status: 'pending',
            payment_id: payment_id,
            session_number: n,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          });
        }
      });

      if (inserts.length > 0) {
        const { error: insertError } = await supabaseAdmin
          .from('assessment_sessions')
          .insert(inserts);
        if (insertError) {
          console.error('❌ Failed to create pending assessment sessions:', insertError);
        } else {
          console.log(`✅ Created ${inserts.length} pending assessment session(s) for payment ${payment_id}`);
        }
      }
    } catch (e) {
      console.error('⚠️ Error ensuring pending assessment sessions:', e);
    }

    res.json(successResponse(updatedSession, 'Assessment session booked successfully'));

  } catch (error) {
    console.error('Book assessment error:', error);
    res.status(500).json(errorResponse('Internal server error'));
  }
};

// Get client assessment sessions
const getAssessmentSessions = async (req, res) => {
  try {
    const userId = req.user.id;
    const { page = 1, limit = 10, status } = req.query;

    // Get client
    let { data: client } = await supabaseAdmin
      .from('clients')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (!client) {
      const fallback = await supabaseAdmin
        .from('clients')
        .select('*')
        .eq('id', userId)
        .single();
      client = fallback.data;
    }

    if (!client) {
      return res.json(successResponse({ sessions: [], pagination: { page: parseInt(page), limit: parseInt(limit), total: 0 } }));
    }

    let query = supabaseAdmin
      .from('assessment_sessions')
      .select(`
        *,
        assessment:assessments(
          id,
          slug,
          hero_title,
          seo_title
        ),
        psychologist:psychologists(
          id,
          first_name,
          last_name,
          area_of_expertise,
          cover_image_url
        )
      `)
      .eq('client_id', client.id)
      .order('scheduled_date', { ascending: false });

    if (status) {
      query = query.eq('status', status);
    }

    const offset = (page - 1) * limit;
    const { data: sessions, error, count } = await query.range(offset, offset + limit - 1);

    if (error) {
      console.error('Get assessment sessions error:', error);
      return res.json(successResponse({ sessions: [], pagination: { page: parseInt(page), limit: parseInt(limit), total: 0 } }));
    }

    res.json(successResponse({
      sessions: sessions || [],
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count || 0
      }
    }));

  } catch (error) {
    console.error('Get assessment sessions error:', error);
    res.status(500).json(errorResponse('Internal server error'));
  }
};

// Reschedule assessment session
const rescheduleAssessmentSession = async (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;
    const { assessmentSessionId } = req.params;
    const { new_date, new_time, psychologist_id } = req.body;

    if (!new_date || !new_time) {
      return res.status(400).json(errorResponse('Missing required fields: new_date, new_time'));
    }

    // Get assessment session
    const { data: assessmentSession, error: fetchError } = await supabaseAdmin
      .from('assessment_sessions')
      .select('*')
      .eq('id', assessmentSessionId)
      .single();

    if (fetchError || !assessmentSession) {
      return res.status(404).json(errorResponse('Assessment session not found'));
    }

    // Check permissions
    if (userRole === 'client') {
      // Client can only reschedule their own sessions
      let { data: client } = await supabaseAdmin
        .from('clients')
        .select('id')
        .eq('user_id', userId)
        .single();
      
      if (!client) {
        const fallback = await supabaseAdmin
          .from('clients')
          .select('id')
          .eq('id', userId)
          .single();
        client = fallback.data;
      }

      if (!client || assessmentSession.client_id !== client.id) {
        return res.status(403).json(errorResponse('You can only reschedule your own sessions'));
      }
    } else if (userRole === 'psychologist') {
      // Psychologist can only reschedule their own assigned sessions
      if (assessmentSession.psychologist_id !== userId) {
        return res.status(403).json(errorResponse('You can only reschedule your own sessions'));
      }
    }
    // Admin can reschedule any session

    // Check if session can be rescheduled
    if (!['booked', 'rescheduled'].includes(assessmentSession.status)) {
      return res.status(400).json(errorResponse(`Cannot reschedule session with status: ${assessmentSession.status}`));
    }

    // Check reschedule count (max 3)
    const rescheduleCount = assessmentSession.reschedule_count || 0;
    if (rescheduleCount >= 3) {
      return res.status(400).json(errorResponse('Maximum reschedule limit (3) reached for this session'));
    }

    // Check 24-hour rule
    const sessionDateTime = new Date(`${assessmentSession.scheduled_date}T${assessmentSession.scheduled_time}`);
    const now = new Date();
    const hoursUntilSession = (sessionDateTime - now) / (1000 * 60 * 60);
    const requiresApproval = hoursUntilSession <= 24;

    // Determine target psychologist (use provided one or keep existing)
    const targetPsychologistId = psychologist_id || assessmentSession.psychologist_id;

    if (requiresApproval && userRole !== 'admin') {
      // Within 24 hours - create reschedule request for admin approval
      console.log('⚠️ Assessment session is within 24 hours, creating admin approval request');
      
      // Get client and psychologist details
      const { data: clientDetails } = await supabaseAdmin
        .from('clients')
        .select('first_name, last_name, child_name')
        .eq('id', assessmentSession.client_id)
        .single();

      const { data: psychologistDetails } = await supabaseAdmin
        .from('psychologists')
        .select('first_name, last_name')
        .eq('id', targetPsychologistId)
        .single();

      const clientName = clientDetails?.child_name || 
        `${clientDetails?.first_name || ''} ${clientDetails?.last_name || ''}`.trim() || 'Client';
      const psychologistName = psychologistDetails ? 
        `${psychologistDetails.first_name} ${psychologistDetails.last_name}` : 'Psychologist';

      // Create admin notification for reschedule request
      const adminNotificationData = {
        type: 'assessment_reschedule_request',
        title: 'Assessment Reschedule Request (Within 24 Hours)',
        message: `${clientName} has requested to reschedule assessment session ${assessmentSession.session_number || ''} from ${assessmentSession.scheduled_date} at ${assessmentSession.scheduled_time} to ${new_date} at ${new_time}. This requires admin approval as it's within 24 hours.`,
        session_id: null, // Not a regular session
        assessment_session_id: assessmentSessionId,
        client_id: assessmentSession.client_id,
        psychologist_id: targetPsychologistId,
        is_read: false,
        created_at: new Date().toISOString(),
        metadata: {
          original_date: assessmentSession.scheduled_date,
          original_time: assessmentSession.scheduled_time,
          new_date: new_date,
          new_time: new_time,
          session_number: assessmentSession.session_number,
          assessment_id: assessmentSession.assessment_id,
          reason: 'Within 24-hour window - admin approval required'
        }
      };

      const { error: notificationError } = await supabaseAdmin
        .from('notifications')
        .insert([adminNotificationData]);

      if (notificationError) {
        console.error('Error creating admin notification:', notificationError);
        return res.status(500).json(errorResponse('Failed to create reschedule request'));
      }

      // Update session status to indicate reschedule request
      await supabaseAdmin
        .from('assessment_sessions')
        .update({
          status: 'reschedule_requested',
          updated_at: new Date().toISOString()
        })
        .eq('id', assessmentSessionId);

      return res.json(successResponse(
        { 
          session: assessmentSession,
          requiresApproval: true,
          hoursUntilSession: Math.round(hoursUntilSession * 100) / 100
        },
        'Reschedule request sent to admin for approval (within 24-hour window)'
      ));
    }

    // Beyond 24 hours or admin - proceed with direct reschedule
    console.log('✅ Assessment session is beyond 24 hours or admin, proceeding with direct reschedule');

    // Check if new time slot is available
    const { data: conflictingAssessmentSessions } = await supabaseAdmin
      .from('assessment_sessions')
      .select('id')
      .eq('psychologist_id', targetPsychologistId)
      .eq('scheduled_date', new_date)
      .eq('scheduled_time', new_time)
      .in('status', ['reserved', 'booked', 'rescheduled'])
      .neq('id', assessmentSessionId);

    const { data: conflictingRegularSessions } = await supabaseAdmin
      .from('sessions')
      .select('id')
      .eq('psychologist_id', targetPsychologistId)
      .eq('scheduled_date', new_date)
      .eq('scheduled_time', new_time)
      .in('status', ['booked', 'rescheduled', 'confirmed']);

    if ((conflictingAssessmentSessions && conflictingAssessmentSessions.length > 0) ||
        (conflictingRegularSessions && conflictingRegularSessions.length > 0)) {
      return res.status(400).json(errorResponse('Selected time slot is already booked'));
    }

    // Update assessment session
    const updateData = {
      scheduled_date: new_date,
      scheduled_time: new_time,
      status: 'rescheduled',
      reschedule_count: rescheduleCount + 1,
      psychologist_id: targetPsychologistId, // Allow reassignment if different psychologist selected
      updated_at: new Date().toISOString()
    };

    const { data: updatedSession, error: updateError } = await supabaseAdmin
      .from('assessment_sessions')
      .update(updateData)
      .eq('id', assessmentSessionId)
      .select('*')
      .single();

    if (updateError) {
      console.error('Error updating assessment session:', updateError);
      return res.status(500).json(errorResponse('Failed to reschedule assessment session'));
    }

    // Block the old slot from availability (unblock it)
    try {
      if (assessmentSession.scheduled_date && assessmentSession.scheduled_time) {
        const oldHhmm = (assessmentSession.scheduled_time || '').substring(0,5);
        const { data: oldAvail } = await supabaseAdmin
          .from('availability')
          .select('id, time_slots')
          .eq('psychologist_id', assessmentSession.psychologist_id)
          .eq('date', assessmentSession.scheduled_date)
          .single();
        
        if (oldAvail && Array.isArray(oldAvail.time_slots) && !oldAvail.time_slots.includes(oldHhmm)) {
          const updatedSlots = [...oldAvail.time_slots, oldHhmm].sort();
          await supabaseAdmin
            .from('availability')
            .update({ time_slots: updatedSlots, updated_at: new Date().toISOString() })
            .eq('id', oldAvail.id);
        }
      }
    } catch (unblockErr) {
      console.warn('⚠️ Failed to unblock old slot:', unblockErr?.message);
    }

    // Block the new slot from availability
    try {
      const newHhmm = (new_time || '').substring(0,5);
      const { data: newAvail } = await supabaseAdmin
        .from('availability')
        .select('id, time_slots')
        .eq('psychologist_id', targetPsychologistId)
        .eq('date', new_date)
        .single();
      
      if (newAvail && Array.isArray(newAvail.time_slots)) {
        const filtered = newAvail.time_slots.filter(t => (typeof t === 'string' ? t.substring(0,5) : String(t).substring(0,5)) !== newHhmm);
        if (filtered.length !== newAvail.time_slots.length) {
          await supabaseAdmin
            .from('availability')
            .update({ time_slots: filtered, updated_at: new Date().toISOString() })
            .eq('id', newAvail.id);
        }
      }
    } catch (blockErr) {
      console.warn('⚠️ Failed to block new slot:', blockErr?.message);
    }

    console.log('✅ Assessment session rescheduled successfully:', updatedSession.id);

    res.json(successResponse(updatedSession, 'Assessment session rescheduled successfully'));

  } catch (error) {
    console.error('Reschedule assessment session error:', error);
    res.status(500).json(errorResponse('Internal server error while rescheduling assessment session'));
  }
};

// Delete assessment session (admin)
const deleteAssessmentSession = async (req, res) => {
  try {
    const { assessmentSessionId } = req.params;

    if (!assessmentSessionId) {
      return res.status(400).json(errorResponse('assessmentSessionId is required'));
    }

    // Fetch the assessment session first
    const { data: assessmentSession, error: fetchError } = await supabaseAdmin
      .from('assessment_sessions')
      .select('*')
      .eq('id', assessmentSessionId)
      .single();

    if (fetchError || !assessmentSession) {
      return res.status(404).json(errorResponse('Assessment session not found'));
    }

    // Delete the session
    const { error: deleteError } = await supabaseAdmin
      .from('assessment_sessions')
      .delete()
      .eq('id', assessmentSessionId);

    if (deleteError) {
      console.error('Error deleting assessment session:', deleteError);
      return res.status(500).json(errorResponse('Failed to delete assessment session'));
    }

    return res.json(successResponse({ id: assessmentSessionId }, 'Assessment session deleted successfully'));
  } catch (error) {
    console.error('Delete assessment session error:', error);
    return res.status(500).json(errorResponse('Internal server error while deleting assessment session'));
  }
};

module.exports = {
  reserveAssessmentSlot,
  bookAssessment,
  getAssessmentSessions,
  rescheduleAssessmentSession,
  deleteAssessmentSession
};

