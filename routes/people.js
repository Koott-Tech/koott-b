/**
 * /api/people and /api/teams (controllers/peopleController.js).
 * HR + Admin manage people and teams; Finance reads people and sets salaries.
 */
const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { allowRoles } = require('../utils/staffRoles');
const c = require('../controllers/peopleController');

const people = express.Router();
people.use(authenticateToken);
people.get('/', allowRoles('hr', 'finance'), c.getPeople);
people.get('/therapist-onboarding', allowRoles('hr'), c.therapistOnboarding);
people.post('/onboard', allowRoles('hr'), c.onboard);
people.patch('/:type/:id', allowRoles('hr', 'finance'), c.updatePerson);
people.post('/:type/:id/offboard', allowRoles('hr'), c.offboard);
people.post('/:type/:id/reactivate', allowRoles('hr'), c.reactivate);

const teams = express.Router();
teams.use(authenticateToken);
teams.get('/', allowRoles('hr', 'operations', 'finance', 'marketing'), c.getTeams);
teams.post('/', allowRoles('hr'), c.saveTeam);
teams.patch('/:id', allowRoles('hr'), c.saveTeam);
teams.delete('/:id', allowRoles('hr'), c.deleteTeam);
teams.post('/:id/members', allowRoles('hr'), c.addMember);
teams.delete('/:id/members/:person', allowRoles('hr'), c.removeMember);

module.exports = { people, teams };
