const { supabaseAdmin } = require('../config/supabase');
const { recordSlotChange } = require('../utils/slotEvents');

/**
 * Who opened the slot. Most come from the nightly job, so counting therapist
 * and admin changes separately is what makes "slots opened" mean a person.
 */
const actorOf = (req) => {
  const role = req?.user?.role;
  if (role === 'psychologist') return 'therapist';
  if (role === 'admin' || role === 'superadmin') return 'admin';
  return 'system';
};
const { successResponse, errorResponse } = require('../utils/helpers');
const googleCalendarService = require('../utils/googleCalendarService');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');

dayjs.extend(utc);
dayjs.extend(timezone);

/**
 * Convert 12-hour time to 24-hour format for comparison
 * Handles both "5:00 PM" and "17:00" formats
 */
function convertSlotTimeTo24Hour(timeStr) {
  if (!timeStr) return null;
  
  const time = typeof timeStr === 'string' ? timeStr.trim() : String(timeStr).trim();
  
  // If already in 24-hour format (no AM/PM), extract HH:MM
  if (!time.includes('AM') && !time.includes('PM')) {
    // Extract first 5 characters (HH:MM) if longer string
    const match = time.match(/(\d{1,2}):(\d{2})/);
    if (match) {
      const hours = parseInt(match[1]);
      const minutes = match[2];
      return `${String(hours).padStart(2, '0')}:${minutes}`;
    }
    return time.substring(0, 5);
  }
  
  // Parse 12-hour format (e.g., "5:00 PM" or "5:00PM")
  const match = time.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!match) return null;
  
  let hour24 = parseInt(match[1]);
  const minutes = match[2];
  const period = match[3].toUpperCase();
  
  if (period === 'PM' && hour24 !== 12) {
    hour24 += 12;
  } else if (period === 'AM' && hour24 === 12) {
    hour24 = 0;
  }
  
  return `${String(hour24).padStart(2, '0')}:${minutes}`;
}

// Set psychologist availability
const setAvailability = async (req, res) => {
  try {
    const { psychologist_id, date, time_slots, is_available = true } = req.body;

    // Validate required fields
    if (!psychologist_id || !date || !time_slots || !Array.isArray(time_slots)) {
      return res.status(400).json(
        errorResponse('Missing required fields: psychologist_id, date, time_slots (array)')
      );
    }

    // Check if psychologist exists
    // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
    const { data: psychologist, error: psychologistError } = await supabaseAdmin
      .from('psychologists')
      .select('id, first_name, last_name')
      .eq('id', psychologist_id)
      .single();

    if (psychologistError || !psychologist) {
      return res.status(404).json(
        errorResponse('Psychologist not found')
      );
    }

    // Check if date is in the future
    const availabilityDate = new Date(date);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    if (availabilityDate <= today) {
      return res.status(400).json(
        errorResponse('Availability date must be in the future')
      );
    }

    // Check for conflicts with existing sessions
    // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
    const { data: conflictingSessions } = await supabaseAdmin
      .from('sessions')
      .select('id, scheduled_time')
      .eq('psychologist_id', psychologist_id)
      .eq('scheduled_date', date)
      .in('status', ['booked', 'rescheduled']);

    if (conflictingSessions && conflictingSessions.length > 0) {
      const bookedTimes = conflictingSessions.map(s => s.scheduled_time);
      const conflictingSlots = time_slots.filter(slot => bookedTimes.includes(slot));
      
      if (conflictingSlots.length > 0) {
        return res.status(400).json(
          errorResponse(`Time slots ${conflictingSlots.join(', ')} are already booked`)
        );
      }
    }

    // Check Google Calendar for external conflicts
    try {
      // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
      const { data: psychologist } = await supabaseAdmin
        .from('psychologists')
        .select('id, first_name, last_name, google_calendar_credentials')
        .eq('id', psychologist_id)
        .single();

      if (psychologist && psychologist.google_calendar_credentials) {
        const googleConflicts = [];
        
        for (const timeSlot of time_slots) {
          const [hours, minutes] = timeSlot.split(':');
          const slotStart = new Date(date);
          slotStart.setHours(parseInt(hours), parseInt(minutes), 0, 0);
          
          const slotEnd = new Date(slotStart);
          slotEnd.setMinutes(slotEnd.getMinutes() + 60); // Assuming 1-hour sessions
          
          const hasConflict = await googleCalendarService.hasTimeConflict(
            psychologist.google_calendar_credentials,
            slotStart,
            slotEnd
          );
          
          if (hasConflict) {
            googleConflicts.push(timeSlot);
          }
        }
        
        if (googleConflicts.length > 0) {
          return res.status(400).json(
            errorResponse(`Time slots ${googleConflicts.join(', ')} conflict with Google Calendar events`)
          );
        }
      }
    } catch (googleError) {
      console.error('Error checking Google Calendar conflicts:', googleError);
      // Continue without blocking if Google Calendar check fails
    }

    // Check if availability already exists for this date
    // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
    const { data: existingAvailability } = await supabaseAdmin
      .from('availability')
      .select('id, time_slots')
      .eq('psychologist_id', psychologist_id)
      .eq('date', date)
      .single();

    // What the day held before this write, so the change can be recorded as a
    // difference rather than as the whole day opening again.
    const slotsBefore = Array.isArray(existingAvailability?.time_slots)
      ? existingAvailability.time_slots
      : [];

    let availability;
    if (existingAvailability) {
      // Update existing availability
      // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
      const { data: updatedAvailability, error: updateError } = await supabaseAdmin
        .from('availability')
        .update({
          time_slots,
          is_available,
          updated_at: new Date().toISOString()
        })
        .eq('id', existingAvailability.id)
        .select()
        .single();

      if (updateError) {
        console.error('Update availability error:', updateError);
        return res.status(500).json(
          errorResponse('Failed to update availability')
        );
      }
      availability = updatedAvailability;
      await recordSlotChange({
        psychologistId: psychologist_id,
        date,
        before: slotsBefore,
        after: is_available ? time_slots : [],
        actor: actorOf(req),
        actorId: req.user?.id || null,
        source: 'availabilityController.setAvailability',
      });
    } else {
      // Create new availability
      // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
      const { data: newAvailability, error: createError } = await supabaseAdmin
        .from('availability')
        .insert({
          psychologist_id,
          date,
          time_slots,
          is_available,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .select()
        .single();

      if (createError) {
        console.error('Create availability error:', createError);
        return res.status(500).json(
          errorResponse('Failed to create availability')
        );
      }
      availability = newAvailability;
      await recordSlotChange({
        psychologistId: psychologist_id,
        date,
        before: [],
        after: is_available ? time_slots : [],
        actor: actorOf(req),
        actorId: req.user?.id || null,
        source: 'availabilityController.setAvailability',
        isNewDay: true,
      });
    }

    // COMMENTED OUT: Google Calendar sync (optional - for blocking time)
    /*
    try {
      // This could create "busy" blocks in Google Calendar
      // Implementation depends on your specific requirements
    } catch (googleError) {
      console.error('Error syncing with Google Calendar:', googleError);
      // Continue even if Google Calendar sync fails
    }
    */
    console.log('ℹ️  Google Calendar sync disabled - availability set without calendar sync');

    res.json(
      successResponse(availability, 'Availability set successfully')
    );

  } catch (error) {
    console.error('Set availability error:', error);
    res.status(500).json(
      errorResponse('Internal server error while setting availability')
    );
  }
};

// Get psychologist availability
const getAvailability = async (req, res) => {
  try {
    const { psychologist_id, start_date, end_date } = req.query;

    if (!psychologist_id) {
      return res.status(400).json(
        errorResponse('psychologist_id is required')
      );
    }

    // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
    let query = supabaseAdmin
      .from('availability')
      .select('*')
      .eq('psychologist_id', psychologist_id)
      .eq('is_available', true);

    if (start_date) {
      query = query.gte('date', start_date);
    }
    if (end_date) {
      query = query.lte('date', end_date);
    }

    query = query.order('date', { ascending: true });

    const { data: availability, error } = await query;

    if (error) {
      console.error('Get availability error:', error);
      return res.status(500).json(
        errorResponse('Failed to fetch availability')
      );
    }

    // Get booked sessions for the same period (exclude cancelled sessions)
    let sessionsQuery = supabaseAdmin
      .from('sessions')
      .select('scheduled_date, scheduled_time, status, id')
      .eq('psychologist_id', psychologist_id)
      .in('status', ['booked', 'rescheduled', 'confirmed']);

    if (start_date) {
      sessionsQuery = sessionsQuery.gte('scheduled_date', start_date);
    }
    if (end_date) {
      sessionsQuery = sessionsQuery.lte('scheduled_date', end_date);
    }

    const { data: bookedSessions, error: sessionsError } = await sessionsQuery;
    
    if (sessionsError) {
      console.error('Error fetching booked sessions:', sessionsError);
    }

    // Also get booked assessment sessions for the same period
    let assessmentSessionsQuery = supabaseAdmin
      .from('assessment_sessions')
      .select('scheduled_date, scheduled_time, status, id')
      .eq('psychologist_id', psychologist_id)
      .in('status', ['booked', 'reserved']); // Include reserved as they're also blocked

    if (start_date) {
      assessmentSessionsQuery = assessmentSessionsQuery.gte('scheduled_date', start_date);
    }
    if (end_date) {
      assessmentSessionsQuery = assessmentSessionsQuery.lte('scheduled_date', end_date);
    }

    const { data: bookedAssessmentSessions, error: assessmentSessionsError } = await assessmentSessionsQuery;
    
    if (assessmentSessionsError) {
      console.error('Error fetching booked assessment sessions:', assessmentSessionsError);
    }

    // Combine both types of booked sessions
    const allBookedSessions = [
      ...(bookedSessions || []),
      ...(bookedAssessmentSessions || [])
    ];

    console.log(`📅 Found ${bookedSessions?.length || 0} booked regular sessions and ${bookedAssessmentSessions?.length || 0} booked assessment sessions for psychologist ${psychologist_id}`);

    // Also check Google Calendar for external events (including Google Meet sessions)
    let externalGoogleCalendarEvents = [];
    try {
      // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
      const { data: psychologist } = await supabaseAdmin
        .from('psychologists')
        .select('id, google_calendar_credentials')
        .eq('id', psychologist_id)
        .single();

      if (psychologist && psychologist.google_calendar_credentials) {
        const calendarStartDate = start_date ? new Date(start_date) : new Date();
        const calendarEndDate = end_date ? new Date(end_date) : new Date();
        
        // Get all Google Calendar events
        const result = await googleCalendarService.getBusyTimeSlots(
          psychologist.google_calendar_credentials,
          calendarStartDate,
          calendarEndDate
        );
        const busySlots = result.busySlots || [];

        // Filter logic:
        // 1. Block ALL events in Google Calendar (system events, external events, etc.)
        //    - If an event corresponds to a session in our database, it's already blocked by the session
        //    - If an event doesn't correspond to a session, it should still block (orphaned system event or external event)
        // 2. Exclude only public holidays
        // 3. Exclude cancelled/deleted events
        externalGoogleCalendarEvents = busySlots.filter(slot => {
          // Skip cancelled or deleted events
          if (slot.status === 'cancelled') {
            return false;
          }
          
          const title = (slot.title || '').toLowerCase();
          
          // Exclude only public holidays (common patterns)
          const isPublicHoliday = 
            title.includes('holiday') ||
            title.includes('public holiday') ||
            title.includes('national holiday') ||
            title.includes('festival') ||
            title.includes('celebration') ||
            title.includes('observance');
          
          // Block ALL events that are NOT public holidays
          // Note: System events will also block, but if they correspond to sessions in our DB,
          // those sessions will already block the slot (no double-blocking issue)
          return !isPublicHoliday;
        });

        console.log(`📅 Found ${externalGoogleCalendarEvents.length} external Google Calendar events (including Google Meet sessions) for psychologist ${psychologist_id}`);
        
        // REMOVED: Background sync trigger - this was causing pages to hang
        // The scheduled cron job (every 10 minutes) will handle background syncing
        // This ensures the page loads quickly without waiting for sync operations
      }
    } catch (googleError) {
      console.warn('⚠️ Error checking Google Calendar for external events:', googleError);
      // Continue without blocking if Google Calendar check fails
    }

    // Combine availability with booked sessions and external Google Calendar events - remove booked slots in real-time
    const availabilityWithBookings = availability.map(avail => {
      // Normalize booked times to HH:MM format for comparison
      const bookedTimesSet = new Set();
      allBookedSessions
        .filter(session => session.scheduled_date === avail.date && session.scheduled_time)
        .forEach(session => {
          const timeStr = session.scheduled_time;
          // Normalize to HH:MM format (remove seconds if present)
          const normalizedTime = typeof timeStr === 'string' 
            ? timeStr.substring(0, 5) 
            : String(timeStr).substring(0, 5);
          bookedTimesSet.add(normalizedTime);
        });

      // Also check external Google Calendar events for this date (including multi-day events)
      const dayExternalEvents = externalGoogleCalendarEvents.filter(event => {
        // Extract dates in IST timezone to avoid day boundary issues
        const eventStartDate = dayjs(event.start).tz('Asia/Kolkata').format('YYYY-MM-DD');
        const eventEndDate = dayjs(event.end).tz('Asia/Kolkata').format('YYYY-MM-DD');
        
        // Include event if:
        // 1. Event starts on this date, OR
        // 2. Event ends on this date (multi-day event)
        return eventStartDate === avail.date || eventEndDate === avail.date;
      });

      // Block time slots that overlap with external Google Calendar events
      dayExternalEvents.forEach(event => {
        // Extract dates in IST timezone to avoid day boundary issues
        const eventStartTz = dayjs(event.start).tz('Asia/Kolkata');
        const eventEndTz = dayjs(event.end).tz('Asia/Kolkata');
        const eventStartDate = eventStartTz.format('YYYY-MM-DD');
        const eventEndDate = eventEndTz.format('YYYY-MM-DD');
        const isMultiDayEvent = eventStartDate !== eventEndDate;
        
        // For each time slot in availability, check if it overlaps with this event
        (avail.time_slots || []).forEach(slot => {
          // Convert slot time to 24-hour format (handles both "5:00 PM" and "17:00" formats)
          const time24Hour = convertSlotTimeTo24Hour(slot);
          if (!time24Hour) return; // Skip invalid times
          
          const [slotHour, slotMinute] = time24Hour.split(':').map(Number);
          
          // Create slot start and end times using timezone-aware dayjs (Asia/Kolkata)
          const slotStart = dayjs(`${avail.date} ${String(slotHour).padStart(2, '0')}:${String(slotMinute).padStart(2, '0')}:00`).tz('Asia/Kolkata');
          const slotEnd = slotStart.add(60, 'minutes'); // 1-hour slot
          
          // Parse event times with timezone support (already parsed above, reuse)
          // eventStartTz and eventEndTz are already defined above
          
          // Check if slot overlaps with event
          let overlaps = false;
          
          if (isMultiDayEvent) {
            // Multi-day event: check if this date is the start date or end date
            if (avail.date === eventStartDate) {
              // On start date: block from event start time until end of day
              const endOfDay = dayjs(`${avail.date} 23:59:59`).tz('Asia/Kolkata');
              overlaps = slotStart.isBefore(eventEndTz) && slotEnd.isAfter(eventStartTz) && slotStart.isBefore(endOfDay);
            } else if (avail.date === eventEndDate) {
              // On end date: block from start of day until event end time
              const startOfDay = dayjs(`${avail.date} 00:00:00`).tz('Asia/Kolkata');
              overlaps = slotStart.isBefore(eventEndTz) && slotEnd.isAfter(startOfDay);
            }
          } else {
            // Single-day event: standard overlap check using timezone-aware comparisons
            overlaps = slotStart.isBefore(eventEndTz) && slotEnd.isAfter(eventStartTz);
          }
          
          if (overlaps) {
            bookedTimesSet.add(slotTime);
          }
        });
      });

      // Filter out booked time slots and external Google Calendar events from available slots
      const availableSlots = (avail.time_slots || []).filter(slot => {
        if (!slot) return false;
        // Normalize slot time to HH:MM format for comparison
        const slotTime = typeof slot === 'string' 
          ? slot.substring(0, 5) 
          : String(slot).substring(0, 5);
        return !bookedTimesSet.has(slotTime);
      });

      console.log(`📅 Date ${avail.date}: ${(avail.time_slots || []).length} total slots, ${bookedTimesSet.size} blocked (${allBookedSessions.filter(s => s.scheduled_date === avail.date).length} booked sessions + ${dayExternalEvents.length} external Google Calendar events), ${availableSlots.length} available`);

      return {
        ...avail,
        time_slots: availableSlots, // Update time_slots to only show available slots (booked slots and external events removed)
        available_slots: availableSlots,
        booked_slots: Array.from(bookedTimesSet),
        total_slots: (avail.time_slots || []).length,
        available_count: availableSlots.length,
        external_events: dayExternalEvents.length
      };
    });

    res.json(
      successResponse(availabilityWithBookings)
    );

  } catch (error) {
    console.error('Get availability error:', error);
    res.status(500).json(
      errorResponse('Internal server error while fetching availability')
    );
  }
};

// Get available time slots for a specific date
const getAvailableTimeSlots = async (req, res) => {
  try {
    const { psychologist_id, date } = req.query;

    if (!psychologist_id || !date) {
      return res.status(400).json(
        errorResponse('psychologist_id and date are required')
      );
    }

    const { getRecurringBlocksForPsychologist, filterSlotsByRecurringBlocks } = require('../utils/recurringBlocksHelper');

    // Get availability for the specific date
    // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
    const { data: availability, error: availabilityError } = await supabaseAdmin
      .from('availability')
      .select('time_slots')
      .eq('psychologist_id', psychologist_id)
      .eq('date', date)
      .eq('is_available', true)
      .single();

    if (availabilityError || !availability) {
      return res.json(
        successResponse({ available_slots: [], booked_slots: [] })
      );
    }

    // Get booked sessions for the date
    // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
    const { data: bookedSessions } = await supabaseAdmin
      .from('sessions')
      .select('scheduled_time')
      .eq('psychologist_id', psychologist_id)
      .eq('scheduled_date', date)
      .in('status', ['booked', 'rescheduled']);

    // Also get booked assessment sessions for the date
    const { data: bookedAssessmentSessions } = await supabaseAdmin
      .from('assessment_sessions')
      .select('scheduled_time')
      .eq('psychologist_id', psychologist_id)
      .eq('scheduled_date', date)
      .in('status', ['booked', 'reserved']);

    // Combine booked times from both sources
    const bookedTimes = [
      ...(bookedSessions || []).map(s => s.scheduled_time),
      ...(bookedAssessmentSessions || []).map(s => s.scheduled_time)
    ];

    let availableSlots = availability.time_slots.filter(slot =>
      !bookedTimes.includes(slot)
    );

    // Apply recurring blocks (e.g. block every Sunday) - only this psychologist
    const recurringBlocks = await getRecurringBlocksForPsychologist(psychologist_id);
    availableSlots = filterSlotsByRecurringBlocks(availableSlots, date, recurringBlocks);

    res.json(
      successResponse({
        available_slots: availableSlots,
        booked_slots: bookedTimes,
        all_slots: availability.time_slots
      })
    );

  } catch (error) {
    console.error('Get available time slots error:', error);
    res.status(500).json(
      errorResponse('Internal server error while fetching time slots')
    );
  }
};

// Delete availability
const deleteAvailability = async (req, res) => {
  try {
    const { availabilityId } = req.params;

    // Check if availability exists
    // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
    const { data: availability, error: availabilityError } = await supabaseAdmin
      .from('availability')
      .select('*')
      .eq('id', availabilityId)
      .single();

    if (availabilityError || !availability) {
      return res.status(404).json(
        errorResponse('Availability not found')
      );
    }

    // Check if there are any sessions on this date
    // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
    const { data: sessions } = await supabaseAdmin
      .from('sessions')
      .select('id')
      .eq('psychologist_id', availability.psychologist_id)
      .eq('scheduled_date', availability.date)
      .in('status', ['booked', 'rescheduled']);

    if (sessions && sessions.length > 0) {
      return res.status(400).json(
        errorResponse('Cannot delete availability with existing sessions')
      );
    }

    // Delete availability
    // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
    const { error: deleteError } = await supabaseAdmin
      .from('availability')
      .delete()
      .eq('id', availabilityId);

    if (deleteError) {
      console.error('Delete availability error:', deleteError);
      return res.status(500).json(
        errorResponse('Failed to delete availability')
      );
    }

    res.json(
      successResponse(null, 'Availability deleted successfully')
    );

  } catch (error) {
    console.error('Delete availability error:', error);
    res.status(500).json(
      errorResponse('Internal server error while deleting availability')
    );
  }
};

// Bulk set availability for multiple dates
const setBulkAvailability = async (req, res) => {
  try {
    const { psychologist_id, availability_data } = req.body;

    if (!psychologist_id || !availability_data || !Array.isArray(availability_data)) {
      return res.status(400).json(
        errorResponse('Missing required fields: psychologist_id, availability_data (array)')
      );
    }

    // Validate each availability entry
    for (const entry of availability_data) {
      if (!entry.date || !entry.time_slots || !Array.isArray(entry.time_slots)) {
        return res.status(400).json(
          errorResponse('Each availability entry must have date and time_slots')
        );
      }
    }

    // Check if psychologist exists
    // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
    const { data: psychologist, error: psychologistError } = await supabaseAdmin
      .from('psychologists')
      .select('id')
      .eq('id', psychologist_id)
      .single();

    if (psychologistError || !psychologist) {
      return res.status(404).json(
        errorResponse('Psychologist not found')
      );
    }

    const results = [];
    const errors = [];

    for (const entry of availability_data) {
      try {
        // Check for conflicts
        // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
        const { data: conflictingSessions } = await supabaseAdmin
          .from('sessions')
          .select('id')
          .eq('psychologist_id', psychologist_id)
          .eq('scheduled_date', entry.date)
          .in('status', ['booked', 'rescheduled']);

        if (conflictingSessions && conflictingSessions.length > 0) {
          errors.push({
            date: entry.date,
            error: 'Date has conflicting sessions'
          });
          continue;
        }

        // Set availability for this date
        // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
        const { data: availability, error: availabilityError } = await supabaseAdmin
          .from('availability')
          .upsert({
            psychologist_id,
            date: entry.date,
            time_slots: entry.time_slots,
            is_available: true,
            updated_at: new Date().toISOString()
          }, {
            onConflict: 'psychologist_id,date'
          })
          .select()
          .single();

        if (availabilityError) {
          errors.push({
            date: entry.date,
            error: availabilityError.message
          });
        } else {
          results.push(availability);
        }
      } catch (error) {
        errors.push({
          date: entry.date,
          error: error.message
        });
      }
    }

    res.json(
      successResponse({
        successful: results,
        errors: errors
      }, `Bulk availability set. ${results.length} successful, ${errors.length} errors.`)
    );

  } catch (error) {
    console.error('Set bulk availability error:', error);
    res.status(500).json(
      errorResponse('Internal server error while setting bulk availability')
    );
  }
};

// Sync Google Calendar events and block conflicting times
const syncGoogleCalendar = async (req, res) => {
  try {
    const { psychologist_id, start_date, end_date } = req.body;

    if (!psychologist_id || !start_date || !end_date) {
      return res.status(400).json(
        errorResponse('Missing required fields: psychologist_id, start_date, end_date')
      );
    }

    // Get psychologist with Google Calendar credentials
    // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
    const { data: psychologist, error: psychologistError } = await supabaseAdmin
      .from('psychologists')
      .select('id, first_name, last_name, google_calendar_credentials')
      .eq('id', psychologist_id)
      .single();

    if (psychologistError || !psychologist) {
      return res.status(404).json(
        errorResponse('Psychologist not found')
      );
    }

    if (!psychologist.google_calendar_credentials) {
      return res.status(400).json(
        errorResponse('Psychologist has no Google Calendar credentials')
      );
    }

    // Sync calendar events
    const syncResult = await googleCalendarService.syncCalendarEvents(
      psychologist,
      new Date(start_date),
      new Date(end_date)
    );

    if (!syncResult.success) {
      return res.status(500).json(
        errorResponse(`Failed to sync calendar: ${syncResult.error}`)
      );
    }

    // Helper function to normalize time format to HH:MM (24-hour)
    const normalizeTimeTo24Hour = (timeStr) => {
      if (!timeStr) return null;
      
      // If already in HH:MM format (24-hour), return as is
      const hhmmMatch = String(timeStr).match(/^(\d{1,2}):(\d{2})$/);
      if (hhmmMatch) {
        return `${hhmmMatch[1].padStart(2, '0')}:${hhmmMatch[2]}`;
      }
      
      // If in HH:MM-HH:MM format, extract first part
      const rangeMatch = String(timeStr).match(/^(\d{1,2}):(\d{2})-/);
      if (rangeMatch) {
        return `${rangeMatch[1].padStart(2, '0')}:${rangeMatch[2]}`;
      }
      
      // If in 12-hour format (e.g., "2:30 PM" or "2:30PM")
      const ampmMatch = String(timeStr).match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
      if (ampmMatch) {
        let hours = parseInt(ampmMatch[1], 10);
        const minutes = ampmMatch[2];
        const period = ampmMatch[3].toUpperCase();
        
        if (period === 'PM' && hours !== 12) hours += 12;
        if (period === 'AM' && hours === 12) hours = 0;
        
        return `${hours.toString().padStart(2, '0')}:${minutes}`;
      }
      
      // Try to extract HH:MM from any string
      const extractMatch = String(timeStr).match(/(\d{1,2}):(\d{2})/);
      if (extractMatch) {
        return `${extractMatch[1].padStart(2, '0')}:${extractMatch[2]}`;
      }
      
      return null;
    };

    // Block conflicting time slots in availability
    const blockedSlots = [];
    const errors = [];

    // Helper function to convert UTC date to IST (Asia/Kolkata)
    const toIST = (date) => {
      if (!date) return null;
      // Convert to IST timezone explicitly
      const istString = new Date(date).toLocaleString('en-US', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
      });
      
      // Parse the IST string back to components
      const [datePart, timePart] = istString.split(', ');
      const [month, day, year] = datePart.split('/');
      const [hour, minute, second] = timePart.split(':');
      
      // Create date string in YYYY-MM-DD format
      const dateStr = `${year}-${month}-${day}`;
      
      // Get time components as numbers
      const hourNum = parseInt(hour, 10);
      const minuteNum = parseInt(minute, 10);
      
      return {
        dateStr,
        year,
        month,
        day,
        hour: hourNum,
        minute: minuteNum,
        minutesFromMidnight: hourNum * 60 + minuteNum
      };
    };

    for (const event of syncResult.externalEvents) {
      try {
        // Convert event start and end times to IST explicitly
        const eventStartIST = toIST(event.start);
        const eventEndIST = toIST(event.end);
        
        if (!eventStartIST || !eventEndIST) {
          console.warn(`⚠️ Could not convert event "${event.title}" to IST`);
          continue;
        }
        
        const eventDate = eventStartIST.dateStr;
        const eventTime = `${String(eventStartIST.hour).padStart(2, '0')}:${String(eventStartIST.minute).padStart(2, '0')}`;
        const normalizedEventTime = normalizeTimeTo24Hour(eventTime);
        
        if (!normalizedEventTime) {
          console.warn(`⚠️ Could not normalize event time: ${eventTime} for event ${event.title}`);
          continue;
        }
        
        // Calculate event duration in minutes from midnight in IST
        let eventStartMinutes = eventStartIST.minutesFromMidnight;
        let eventEndMinutes = eventEndIST.minutesFromMidnight;
        
        // Handle events that span midnight or multiple days
        const startDate = new Date(event.start);
        const endDate = new Date(event.end);
        const startDateStr = startDate.toISOString().split('T')[0];
        const endDateStr = endDate.toISOString().split('T')[0];
        const isMultiDayEvent = startDateStr !== endDateStr;
        
        // Process multi-day events for both start and end dates
        const datesToProcess = [];
        if (isMultiDayEvent) {
          // For start date: block from event start time until end of day
          datesToProcess.push({
            date: eventStartIST.dateStr,
            startMinutes: eventStartMinutes,
            endMinutes: 24 * 60 - 1 // End of day (23:59)
          });
          
          // For end date: block from start of day until event end time
          if (eventEndIST.dateStr !== eventStartIST.dateStr) {
            datesToProcess.push({
              date: eventEndIST.dateStr,
              startMinutes: 0, // Start of day (00:00)
              endMinutes: eventEndIST.minutesFromMidnight
            });
          }
        } else {
          // Single-day event
        if (eventEndMinutes < eventStartMinutes) {
          eventEndMinutes = eventEndMinutes + (24 * 60);
        }
          datesToProcess.push({
            date: eventDate,
            startMinutes: eventStartMinutes,
            endMinutes: eventEndMinutes
          });
        }
        
        // Process each date affected by the event
        for (const dateInfo of datesToProcess) {
        // Get current availability for this date
        // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
        const { data: availability } = await supabaseAdmin
          .from('availability')
          .select('id, time_slots')
          .eq('psychologist_id', psychologist_id)
            .eq('date', dateInfo.date)
          .single();

        if (availability) {
          // Helper function to convert slot time to minutes from midnight
          const slotToMinutes = (slotStr) => {
            const normalizedSlot = normalizeTimeTo24Hour(slotStr);
            if (!normalizedSlot) return null;
            
            const [hours, minutes] = normalizedSlot.split(':').map(Number);
            return hours * 60 + minutes;
          };
          
          // Remove ALL conflicting time slots that fall within the event duration
          const slotsToBlock = [];
          const updatedSlots = availability.time_slots.filter(slot => {
            const slotMinutes = slotToMinutes(slot);
            
            if (slotMinutes === null) {
              return true; // Keep slots we can't parse
            }
            
              // Check if slot overlaps with event duration for this date
            // Slots are typically 1 hour long (60 minutes)
            // We need to check if the slot INTERVAL overlaps with the event INTERVAL
            // Slot: [slotMinutes, slotMinutes + 60)
            // Event: [dateInfo.startMinutes, dateInfo.endMinutes)
            // Overlap occurs if: slotStart < eventEnd AND slotEnd > eventStart
            const SLOT_DURATION_MINUTES = 60; // 1-hour slots
            const slotEndMinutes = slotMinutes + SLOT_DURATION_MINUTES;
            const overlaps = slotMinutes < dateInfo.endMinutes && slotEndMinutes > dateInfo.startMinutes;
            
            if (overlaps) {
              slotsToBlock.push(slot);
              return false; // Remove this slot
            }
            
            return true; // Keep this slot
          });
          
          if (slotsToBlock.length > 0) {
            // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
            await supabaseAdmin
              .from('availability')
              .update({ 
                time_slots: updatedSlots,
                updated_at: new Date().toISOString()
              })
              .eq('id', availability.id);

            // Add all blocked slots to the report
            slotsToBlock.forEach(slot => {
              blockedSlots.push({
                  date: dateInfo.date,
                time: slot,
                reason: event.title
              });
            });
            
              const startTimeStr = `${Math.floor(dateInfo.startMinutes/60)}:${String(dateInfo.startMinutes%60).padStart(2,'0')}`;
              const endTimeStr = `${Math.floor(dateInfo.endMinutes/60)}:${String(dateInfo.endMinutes%60).padStart(2,'0')}`;
              const multiDayNote = isMultiDayEvent ? ` (multi-day event)` : '';
              console.log(`✅ Blocked ${slotsToBlock.length} time slot(s) on ${dateInfo.date} due to external event "${event.title}" (${startTimeStr} - ${endTimeStr})${multiDayNote}`);
            }
          }
        }
      } catch (error) {
        console.error(`Error blocking slot for event ${event.title}:`, error);
        errors.push({
          event: event.title,
          error: error.message
        });
      }
    }

    res.json(
      successResponse({
        syncedAt: syncResult.syncedAt,
        totalExternalEvents: syncResult.externalEvents.length,
        blockedSlots: blockedSlots,
        errors: errors
      }, 'Google Calendar synced successfully')
    );

  } catch (error) {
    console.error('Sync Google Calendar error:', error);
    res.status(500).json(
      errorResponse('Internal server error while syncing calendar')
    );
  }
};

// Get Google Calendar busy times for a psychologist
const getGoogleCalendarBusyTimes = async (req, res) => {
  try {
    const { psychologist_id, start_date, end_date } = req.query;

    if (!psychologist_id || !start_date || !end_date) {
      return res.status(400).json(
        errorResponse('Missing required query parameters: psychologist_id, start_date, end_date')
      );
    }

    // Get psychologist with Google Calendar credentials
    // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
    const { data: psychologist, error: psychologistError } = await supabaseAdmin
      .from('psychologists')
      .select('id, first_name, last_name, google_calendar_credentials')
      .eq('id', psychologist_id)
      .single();

    if (psychologistError || !psychologist) {
      return res.status(404).json(
        errorResponse('Psychologist not found')
      );
    }

    if (!psychologist.google_calendar_credentials) {
      return res.status(400).json(
        errorResponse('Psychologist has no Google Calendar credentials')
      );
    }

    // Get busy time slots from Google Calendar
    const result = await googleCalendarService.getBusyTimeSlots(
      psychologist.google_calendar_credentials,
      new Date(start_date),
      new Date(end_date)
    );
    const busySlots = result.busySlots || [];

    res.json(
      successResponse(busySlots, 'Google Calendar busy times retrieved successfully')
    );

  } catch (error) {
    console.error('Get Google Calendar busy times error:', error);
    res.status(500).json(
      errorResponse('Internal server error while getting busy times')
    );
  }
};

module.exports = {
  setAvailability,
  getAvailability,
  getAvailableTimeSlots,
  deleteAvailability,
  setBulkAvailability,
  syncGoogleCalendar,
  getGoogleCalendarBusyTimes
};
