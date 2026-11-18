const express = require('express');
const { authUrl, exchangeCode, calendar } = require('../utils/googleOAuthClient');
const router = express.Router();

// Get OAuth URL
router.get('/oauth2/url', (req, res) => {
  try {
    const url = authUrl();
    res.json({ url });
  } catch (error) {
    console.error('❌ Error generating auth URL:', error);
    res.status(500).json({ error: 'Failed to generate auth URL' });
  }
});

// OAuth callback
router.get('/oauth2/callback', async (req, res, next) => {
  try {
    const code = String(req.query.code || '');
    if (!code) {
      return res.status(400).send('Missing authorization code');
    }
    
    await exchangeCode(code);
    res.send(`
      <html>
        <body>
          <h2>✅ Authentication Successful!</h2>
          <p>You can now close this tab and use the Google Calendar API.</p>
          <script>setTimeout(() => window.close(), 3000);</script>
        </body>
      </html>
    `);
  } catch (error) {
    console.error('❌ OAuth callback error:', error);
    next(error);
  }
});

// Get conference capabilities (diagnostic route). Admins only: it returns the calendar
// account's settings. (It always failed before: calendar() is async and wasn't awaited.)
const { authenticateToken, requireAdmin } = require('../middleware/auth');
router.get('/conference-capabilities', authenticateToken, requireAdmin, async (req, res, next) => {
  try {
    console.log('🔍 Checking conference capabilities...');

    const cal = await calendar();
    const { data } = await cal.calendarList.get({ calendarId: 'primary' });
    
    const allowedTypes = data.conferenceProperties?.allowedConferenceSolutionTypes || [];
    
    console.log('📊 Conference Properties:', {
      allowedTypes,
      hasConferenceProperties: !!data.conferenceProperties,
      calendarId: data.id,
      summary: data.summary
    });
    
    res.json({
      allowed: allowedTypes,
      calendarId: data.id,
      summary: data.summary,
      hasConferenceSupport: allowedTypes.length > 0,
      raw: data
    });
    
  } catch (error) {
    console.error('❌ Error checking conference capabilities:', error);
    next(error);
  }
});

module.exports = router;
