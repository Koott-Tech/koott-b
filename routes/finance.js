const express = require('express');
const router = express.Router();
// One booking change at a time per therapist (utils/therapistLock.js)
const { serializeByTherapist } = require('../utils/therapistLock');
const { authenticateToken, requireFinance } = require('../middleware/auth');
const financeController = require('../controllers/financeController');
const sessionController = require('../controllers/sessionController');
const adminController = require('../controllers/adminController');
const { createRateLimiters } = require('../middleware/security');

// Apply rate limiting
const { generalLimiter } = createRateLimiters();

// All finance routes require authentication and finance role
router.use(authenticateToken);
router.use(requireFinance);
router.use(generalLimiter);

/**
 * Finance Routes
 * All routes are protected with:
 * - Authentication (JWT token)
 * - Finance role check
 * - Rate limiting
 * - Audit logging (in controllers)
 */

// Dashboard
router.get('/dashboard', financeController.getDashboard);

// Sessions Management
router.get('/sessions', financeController.getSessions);
router.get('/doctors/:psychologistId/bookings', financeController.getDoctorBookings);
// Full per-therapist financial profile (every session + commission split + payout state)
router.get('/doctors/:psychologistId/profile', financeController.getDoctorFinanceProfile);
router.get('/sessions/all', sessionController.getAllSessions); // Use same method as admin for consistency
router.get('/sessions/:sessionId', financeController.getSessionDetails);
router.put('/sessions/:sessionId', serializeByTherapist, adminController.updateSession);
router.put('/sessions/:sessionId/commission', financeController.updateSessionCommission);
router.patch('/sessions/:sessionId/verify-payment', sessionController.verifyPayment);
router.patch('/sessions/:sessionId/cancel-refund', sessionController.cancelRefundSession);
router.delete('/sessions/:sessionId', sessionController.deleteSession);
router.get('/psychologists', financeController.getPsychologistOptions);
router.get('/clients', financeController.getClientOptions);
router.post('/receipts/send-email', financeController.sendReceiptEmail);

// Revenue Management
router.get('/revenue', financeController.getRevenue);

// Commission Management
router.get('/commissions', financeController.getCommissions);
router.put('/commissions/:psychologistId', financeController.updateCommissionRate);

// Expense Management
router.get('/expenses', financeController.getExpenses);
router.post('/expenses', financeController.createExpense);
router.put('/expenses/:expenseId', financeController.updateExpense);
router.delete('/expenses/:expenseId', financeController.deleteExpense);
router.post('/expenses/:expenseId/approve', financeController.approveExpense);
// Razorpay payouts: collected − received = Razorpay fee, saved as an expense
const razorpaySettlementController = require('../controllers/razorpaySettlementController');
router.get('/razorpay-settlements/summary', razorpaySettlementController.getSummary);
router.post('/razorpay-settlements', razorpaySettlementController.createSettlement);
// Sales targets (per month) and run-rate forecast
const financeTargetsController = require('../controllers/financeTargetsController');
router.get('/forecast', financeTargetsController.getForecast);
router.get('/targets', financeTargetsController.getTargets);
router.put('/targets', financeTargetsController.setTargets);
// Profit & Loss, Balance Sheet, fixed assets, balance sheet items, expense headings
const fsc = require('../controllers/financialStatementsController');
router.get('/reports/profit-loss', fsc.profitLoss);
router.get('/reports/balance-sheet', fsc.balanceSheetReport);
router.get('/assets', fsc.listAssets);
router.post('/assets', fsc.createAsset);
router.post('/assets/from-expense/:expenseId', fsc.assetFromExpense);
router.put('/assets/:id', fsc.updateAsset);
router.delete('/assets/:id', fsc.deleteAsset);
router.get('/balance-items', fsc.listItems);
router.post('/balance-items', fsc.saveItem);
router.put('/balance-items/:id', fsc.saveItem);
router.delete('/balance-items/:id', fsc.deleteItem);
router.get('/expense-groups', fsc.listExpenseGroups);
router.put('/expense-groups', fsc.setExpenseGroup);
// TDS on therapist payouts: deducted, deposited (challans), due dates, per-therapist totals
const tdsController = require('../controllers/tdsController');
router.get('/tds', tdsController.getTds);
router.post('/tds/deposits', tdsController.addDeposit);
router.delete('/tds/deposits/:id', tdsController.deleteDeposit);

// Income Management
router.get('/income', financeController.getIncome);
router.post('/income', financeController.createIncome);
router.put('/income/:incomeId', financeController.updateIncome);
router.delete('/income/:incomeId', financeController.deleteIncome);

// Financial Reports
// router.get('/reports', financeController.getReports);
// router.post('/reports/generate', financeController.generateReport);
// router.get('/reports/:reportId', financeController.getReport);

// Financial Forecasting
// router.get('/forecasting', financeController.getForecasting);
// router.get('/forecasting/revenue', financeController.getRevenueForecast);
// router.get('/forecasting/expenses', financeController.getExpenseForecast);

// Analytics & Insights
// router.get('/analytics', financeController.getAnalytics);
// router.get('/analytics/revenue', financeController.getRevenueAnalytics);
// router.get('/analytics/expenses', financeController.getExpenseAnalytics);

// Settings & Configuration
// router.get('/settings', financeController.getSettings);
// router.put('/settings', financeController.updateSettings);
router.get('/settings/categories', financeController.getExpenseCategories);
router.post('/settings/categories', financeController.createExpenseCategory);
router.get('/settings/income-sources', financeController.getIncomeSources);
router.post('/settings/income-sources', financeController.createIncomeSource);
router.get('/settings/salary-employees', financeController.getSalaryEmployees);
router.post('/settings/salary-employees', financeController.upsertSalaryEmployee);

// Payouts & Payments
router.get('/payouts', financeController.getPayouts);
router.get('/payouts/pending', financeController.getPendingPayouts);
router.get('/payouts/doctors', financeController.getDoctorPayouts);
router.get('/payouts/:payoutId', financeController.getPayoutDetails);
router.post('/payouts', financeController.processPayout);
// One at a time per therapist, so a double click can't pay the same sessions twice.
router.post('/payouts/mark-paid', serializeByTherapist, financeController.markPayoutAsPaid);

module.exports = router;
