/**
 * Finance → Profit & Loss, Balance Sheet, Fixed Assets, balance sheet items, expense headings.
 * Maths lives in utils/financialStatements.js. Tables come from SQL 0029.
 *
 * GET    /finance/reports/profit-loss?from=YYYY-MM-DD&to=YYYY-MM-DD   (default this month)
 * GET    /finance/reports/balance-sheet?as_of=YYYY-MM-DD             (default today)
 * GET    /finance/assets                       POST /finance/assets
 * PUT    /finance/assets/:id                   DELETE /finance/assets/:id
 * POST   /finance/assets/from-expense/:expenseId   (move a purchase booked as an expense)
 * GET    /finance/balance-items?as_of=         POST /finance/balance-items
 * PUT    /finance/balance-items/:id            DELETE /finance/balance-items/:id
 * GET    /finance/expense-groups               PUT /finance/expense-groups { name, pl_group }
 */
const { supabaseAdmin } = require('../config/supabase');
const { successResponse, errorResponse } = require('../utils/helpers');
const FS = require('../utils/financialStatements');

const STAFF = ['finance', 'admin', 'superadmin'];
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const todayIST = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const guard = (req, res) => {
  if (!STAFF.includes(req.user?.role)) { res.status(403).json(errorResponse('Access denied. Finance role required.')); return false; }
  return true;
};
const needSql = (res) => res.status(503).json(errorResponse('This needs the database update first: run backend/supabase/RUN_PENDING_0029.sql in Supabase.'));
const fail = (res, e, msg) => { console.error(msg, e); return res.status(500).json(errorResponse(msg)); };
const validDate = (s) => YMD.test(String(s || '')) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

/**
 * The period to compare with.
 *  - One month from the 1st (this month, last month): the previous month, same days
 *    (1–21 Nov → 1–21 Oct; a full month → the full previous month).
 *  - Longer periods from the 1st (quarter, financial year, year to date): the same dates a
 *    year earlier (1 Apr – 21 Nov 2026 → 1 Apr – 21 Nov 2025).
 *  - Any other range: the same number of days just before it.
 */
function previousPeriod(from, to) {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  if (fd === 1) {
    const span = (ty - fy) * 12 + (tm - fm) + 1;
    const months = span === 1 ? 1 : 12;
    const shift = (y, m, d, endOfMonth) => {
      const t = new Date(Date.UTC(y, m - 1 - months, 1));
      const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
      return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(endOfMonth ? last : Math.min(d, last)).padStart(2, '0')}`;
    };
    const toIsMonthEnd = td === new Date(Date.UTC(ty, tm, 0)).getUTCDate();
    return [shift(fy, fm, 1, false), shift(ty, tm, td, toIsMonthEnd)];
  }
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 864e5) + 1;
  const pTo = new Date(Date.parse(`${from}T00:00:00Z`) - 864e5).toISOString().slice(0, 10);
  return [new Date(Date.parse(`${pTo}T00:00:00Z`) - (days - 1) * 864e5).toISOString().slice(0, 10), pTo];
}

// ---------------------------------------------------------------- reports
const profitLoss = async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const today = todayIST();
    const from = validDate(req.query.from) ? req.query.from : `${today.slice(0, 7)}-01`;
    const to = validDate(req.query.to) ? req.query.to : today;
    if (to < from) return res.status(400).json(errorResponse('"To" date is before "From".'));
    const compare = String(req.query.compare || '') === 'previous';
    const current = await FS.profitAndLoss(from, to);
    let previous = null;
    if (compare) {
      const [pFrom, pTo] = previousPeriod(from, to);
      previous = await FS.profitAndLoss(pFrom, pTo);
    }
    return res.json(successResponse({ ...current, previous, assets_ready: await FS.tableReady('fixed_assets') }));
  } catch (e) { return fail(res, e, 'Could not build the Profit & Loss.'); }
};

const balanceSheetReport = async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const asOf = validDate(req.query.as_of) ? req.query.as_of : todayIST();
    return res.json(successResponse(await FS.balanceSheet(asOf)));
  } catch (e) { return fail(res, e, 'Could not build the Balance Sheet.'); }
};

// ---------------------------------------------------------------- fixed assets
function assetPayload(body, partial = false) {
  const out = {}; const errs = [];
  const has = (k) => body[k] !== undefined;
  if (!partial || has('name')) { if (!String(body.name || '').trim()) errs.push('Name is required.'); else out.name = String(body.name).trim().slice(0, 200); }
  if (!partial || has('category')) out.category = FS.ASSET_CATEGORIES[body.category] ? body.category : 'Other';
  if (!partial || has('purchase_date')) { if (!validDate(body.purchase_date)) errs.push('Purchase date is required.'); else out.purchase_date = body.purchase_date; }
  if (!partial || has('cost')) { const c = Number(body.cost); if (!(c >= 0)) errs.push('Cost must be 0 or more.'); else out.cost = c; }
  if (!partial || has('salvage_value')) { const s = Number(body.salvage_value || 0); if (!(s >= 0)) errs.push('Salvage value must be 0 or more.'); else out.salvage_value = s; }
  if (!partial || has('useful_life_months')) {
    const months = parseInt(body.useful_life_months, 10) || FS.ASSET_CATEGORIES[out.category || body.category] || 60;
    if (months < 1 || months > 600) errs.push('Useful life must be 1–600 months.'); else out.useful_life_months = months;
  }
  for (const k of ['vendor', 'invoice_ref', 'notes']) if (!partial || has(k)) out[k] = body[k] ? String(body[k]).slice(0, 1000) : null;
  if (has('disposed_date')) {
    if (body.disposed_date && !validDate(body.disposed_date)) errs.push('Disposal date is not valid.');
    out.disposed_date = body.disposed_date || null;
    out.disposal_amount = body.disposed_date ? Number(body.disposal_amount || 0) : null;
  }
  if (out.salvage_value != null && out.cost != null && out.salvage_value > out.cost) errs.push('Salvage value can\'t be more than the cost.');
  if (out.disposed_date && out.purchase_date && out.disposed_date < out.purchase_date) errs.push('Disposal date is before the purchase date.');
  return { out, errs };
}

function withBook(a, asOf) {
  const dep = FS.accumulatedDepreciation(a, asOf);
  return {
    ...a,
    cost: Number(a.cost), salvage_value: Number(a.salvage_value),
    accumulated_depreciation: Math.round(dep * 100) / 100,
    book_value: Math.round(FS.bookValue(a, asOf) * 100) / 100,
    monthly_depreciation: Math.round((((Number(a.cost) - Number(a.salvage_value)) / a.useful_life_months)) * 100) / 100,
    fully_depreciated: dep >= Number(a.cost) - Number(a.salvage_value) - 0.01,
  };
}

const listAssets = async (req, res) => {
  if (!guard(req, res)) return;
  try {
    if (!(await FS.tableReady('fixed_assets'))) return res.json(successResponse({ ready: false, assets: [], categories: FS.ASSET_CATEGORIES }));
    const asOf = validDate(req.query.as_of) ? req.query.as_of : todayIST();
    const { data, error } = await supabaseAdmin.from('fixed_assets').select('*').order('purchase_date', { ascending: false });
    if (error) throw error;
    return res.json(successResponse({ ready: true, as_of: asOf, assets: (data || []).map((a) => withBook(a, asOf)), categories: FS.ASSET_CATEGORIES }));
  } catch (e) { return fail(res, e, 'Could not load fixed assets.'); }
};

const createAsset = async (req, res) => {
  if (!guard(req, res)) return;
  try {
    if (!(await FS.tableReady('fixed_assets'))) return needSql(res);
    const { out, errs } = assetPayload(req.body || {});
    if (errs.length) return res.status(400).json(errorResponse(errs.join(' ')));
    const { data, error } = await supabaseAdmin.from('fixed_assets').insert({ ...out, created_by: req.user.id || null }).select('*').single();
    if (error) throw error;
    return res.status(201).json(successResponse(withBook(data, todayIST()), 'Asset added.'));
  } catch (e) { return fail(res, e, 'Could not add the asset.'); }
};

const updateAsset = async (req, res) => {
  if (!guard(req, res)) return;
  try {
    if (!(await FS.tableReady('fixed_assets'))) return needSql(res);
    const { data: cur } = await supabaseAdmin.from('fixed_assets').select('*').eq('id', req.params.id).maybeSingle();
    if (!cur) return res.status(404).json(errorResponse('Asset not found.'));
    const { out, errs } = assetPayload({ ...cur, ...(req.body || {}) }, true);
    if (errs.length) return res.status(400).json(errorResponse(errs.join(' ')));
    delete out.expense_id;
    const { data, error } = await supabaseAdmin.from('fixed_assets').update({ ...out, updated_at: new Date().toISOString() }).eq('id', req.params.id).select('*').single();
    if (error) throw error;
    return res.json(successResponse(withBook(data, todayIST()), 'Asset updated.'));
  } catch (e) { return fail(res, e, 'Could not update the asset.'); }
};

const deleteAsset = async (req, res) => {
  if (!guard(req, res)) return;
  try {
    if (!(await FS.tableReady('fixed_assets'))) return needSql(res);
    const { error, count } = await supabaseAdmin.from('fixed_assets').delete({ count: 'exact' }).eq('id', req.params.id);
    if (error) throw error;
    if (!count) return res.status(404).json(errorResponse('Asset not found.'));
    return res.json(successResponse({ deleted: true }, 'Asset removed. If it came from an expense, that expense counts as an expense again.'));
  } catch (e) { return fail(res, e, 'Could not remove the asset.'); }
};

const assetFromExpense = async (req, res) => {
  if (!guard(req, res)) return;
  try {
    if (!(await FS.tableReady('fixed_assets'))) return needSql(res);
    const { data: ex } = await supabaseAdmin.from('expenses').select('id, date, category, custom_category, description, amount, total_amount, vendor_supplier, reference_number').eq('id', req.params.expenseId).maybeSingle();
    if (!ex) return res.status(404).json(errorResponse('Expense not found.'));
    const { data: dup } = await supabaseAdmin.from('fixed_assets').select('id').eq('expense_id', ex.id).maybeSingle();
    if (dup) return res.status(409).json(errorResponse('This expense is already recorded as a fixed asset.'));
    const body = req.body || {};
    const { out, errs } = assetPayload({
      name: body.name || ex.description || ex.custom_category || ex.category,
      category: body.category,
      purchase_date: body.purchase_date || ex.date,
      cost: body.cost ?? (ex.total_amount || ex.amount),
      salvage_value: body.salvage_value || 0,
      useful_life_months: body.useful_life_months,
      vendor: body.vendor || ex.vendor_supplier,
      invoice_ref: body.invoice_ref || ex.reference_number,
      notes: body.notes || 'Moved from Expenses',
    });
    if (errs.length) return res.status(400).json(errorResponse(errs.join(' ')));
    const { data, error } = await supabaseAdmin.from('fixed_assets').insert({ ...out, expense_id: ex.id, created_by: req.user.id || null }).select('*').single();
    if (error) throw error;
    return res.status(201).json(successResponse(withBook(data, todayIST()), 'Recorded as a fixed asset. The expense no longer counts in the P&L; its depreciation does.'));
  } catch (e) { return fail(res, e, 'Could not record the asset.'); }
};

// ---------------------------------------------------------------- balance sheet items
const ITEM_HINTS = {
  cash_bank: ['Bank – current account', 'Cash in hand'],
  current_asset: ['Advances to staff', 'Prepaid expenses', 'GST input credit', 'Other receivables'],
  non_current_asset: ['Security deposit (rent)', 'Long-term deposits'],
  current_liability: ['GST payable', 'Salaries payable', 'Other payables'], // TDS payments: Finance → TDS
  non_current_liability: ['Bank loan', 'Loan from directors'],
  equity: ["Share capital / Owner's capital", 'Opening reserves (before the system)', 'Drawings (enter negative)'],
};

const listItems = async (req, res) => {
  if (!guard(req, res)) return;
  try {
    if (!(await FS.tableReady('balance_sheet_items'))) return res.json(successResponse({ ready: false, items: [], hints: ITEM_HINTS }));
    let q = supabaseAdmin.from('balance_sheet_items').select('*').order('as_of', { ascending: false }).order('name');
    if (validDate(req.query.as_of)) q = q.lte('as_of', req.query.as_of);
    const { data, error } = await q.limit(1000);
    if (error) throw error;
    return res.json(successResponse({ ready: true, items: data || [], hints: ITEM_HINTS }));
  } catch (e) { return fail(res, e, 'Could not load balance sheet items.'); }
};

function itemPayload(b) {
  const errs = [];
  if (!FS.SECTIONS.includes(b.section)) errs.push('Pick a section.');
  if (!String(b.name || '').trim()) errs.push('Name is required.');
  const amount = Number(b.amount);
  if (!Number.isFinite(amount)) errs.push('Amount must be a number (negative allowed, e.g. drawings).');
  if (!validDate(b.as_of)) errs.push('Pick the date of this balance.');
  return { errs, out: { section: b.section, name: String(b.name || '').trim().slice(0, 200), amount, as_of: b.as_of, notes: b.notes ? String(b.notes).slice(0, 1000) : null } };
}

const saveItem = async (req, res) => {
  if (!guard(req, res)) return;
  try {
    if (!(await FS.tableReady('balance_sheet_items'))) return needSql(res);
    const { errs, out } = itemPayload(req.body || {});
    if (errs.length) return res.status(400).json(errorResponse(errs.join(' ')));
    const row = { ...out, created_by: req.user.id || null, updated_at: new Date().toISOString() };
    const q = req.params.id
      ? supabaseAdmin.from('balance_sheet_items').update(row).eq('id', req.params.id)
      : supabaseAdmin.from('balance_sheet_items').upsert(row, { onConflict: 'section,name,as_of' });
    const { data, error } = await q.select('*').single();
    if (error) throw error;
    return res.status(req.params.id ? 200 : 201).json(successResponse(data, 'Saved.'));
  } catch (e) { return fail(res, e, 'Could not save the item.'); }
};

const deleteItem = async (req, res) => {
  if (!guard(req, res)) return;
  try {
    if (!(await FS.tableReady('balance_sheet_items'))) return needSql(res);
    const { error } = await supabaseAdmin.from('balance_sheet_items').delete().eq('id', req.params.id);
    if (error) throw error;
    return res.json(successResponse({ deleted: true }, 'Removed.'));
  } catch (e) { return fail(res, e, 'Could not remove the item.'); }
};

// ---------------------------------------------------------------- expense headings
const listExpenseGroups = async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const [cats, used] = await Promise.all([
      supabaseAdmin.from('expense_categories').select('name, pl_group').then((r) => (r.error ? supabaseAdmin.from('expense_categories').select('name') : r)),
      supabaseAdmin.from('expenses').select('category, custom_category').limit(5000),
    ]);
    const names = new Map();
    (cats.data || []).forEach((c) => names.set(String(c.name).toLowerCase(), { name: c.name, pl_group: c.pl_group || null, saved: true }));
    (used.data || []).forEach((e) => {
      const n = (e.custom_category && e.custom_category.trim()) || e.category;
      if (n && !names.has(n.toLowerCase())) names.set(n.toLowerCase(), { name: n, pl_group: null, saved: false });
    });
    const list = [...names.values()].map((c) => ({ ...c, group: FS.plGroupFor(c.name, c.pl_group), guessed: !c.pl_group }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return res.json(successResponse({ groups: FS.PL_GROUPS, categories: list, editable: !cats.error && (cats.data || []).every((c) => 'pl_group' in c) }));
  } catch (e) { return fail(res, e, 'Could not load expense headings.'); }
};

const setExpenseGroup = async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const name = String(req.body?.name || '').trim();
    const group = req.body?.pl_group || null;
    if (!name) return res.status(400).json(errorResponse('Category name is required.'));
    if (group && !FS.PL_GROUPS.includes(group)) return res.status(400).json(errorResponse('Unknown heading.'));
    const probe = await supabaseAdmin.from('expense_categories').select('pl_group').limit(1);
    if (probe.error) return needSql(res);
    const { error } = await supabaseAdmin.from('expense_categories').upsert({ name, pl_group: group, is_active: true, updated_at: new Date().toISOString() }, { onConflict: 'name' });
    if (error) throw error;
    return res.json(successResponse({ name, pl_group: group, group: FS.plGroupFor(name, group) }, 'Heading saved.'));
  } catch (e) { return fail(res, e, 'Could not save the heading.'); }
};

module.exports = {
  profitLoss, balanceSheetReport,
  listAssets, createAsset, updateAsset, deleteAsset, assetFromExpense,
  listItems, saveItem, deleteItem,
  listExpenseGroups, setExpenseGroup,
  previousPeriod,
};
