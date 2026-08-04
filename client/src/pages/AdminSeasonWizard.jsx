import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import { api } from '../api.js';
import { useSetBreadcrumbs } from '../BreadcrumbContext.jsx';

const CLASSIFICATIONS = ['A', 'B', 'C', 'D'];
const TEMPLATE_COLUMNS = ['firstName', 'lastName', 'email', 'phone', 'teamName', 'classification', 'isCaptain', 'division'];

// Builds one example row per division so the template shows every valid
// value for the `division` column - the single thing a CSV/Excel row is
// most likely to get wrong (a typo'd division name is silently rejected
// server-side with a clear per-row error, but starting from a correct
// template avoids that entirely).
function templateRows(divisions) {
  return divisions.map((d) => ({
    firstName: '', lastName: '', email: '', phone: '', teamName: '',
    classification: '', isCaptain: '', division: d.name,
  }));
}

function downloadCsvTemplate(divisions) {
  const csv = Papa.unparse({ fields: TEMPLATE_COLUMNS, data: templateRows(divisions).map((r) => TEMPLATE_COLUMNS.map((c) => r[c])) });
  const blob = new Blob([csv], { type: 'text/csv' });
  triggerDownload(blob, 'season-players-template.csv');
}

function downloadExcelTemplate(divisions) {
  const sheet = XLSX.utils.json_to_sheet(templateRows(divisions), { header: TEMPLATE_COLUMNS });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Players');
  const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
  triggerDownload(new Blob([buffer], { type: 'application/octet-stream' }), 'season-players-template.xlsx');
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Column names are matched exactly (firstName, lastName, division, ...)
// against whatever key papaparse/xlsx hands back for each header cell.
// Excel/Numbers exports routinely add a leading UTF-8 BOM to the very first
// header cell, or leave stray leading/trailing spaces on any header from
// copy-paste - either one silently turns e.g. "firstName" into a different
// key, so every row fails "firstName is required" with no obvious reason.
// Trim (and strip any BOM char) off every key here so the required-field
// checks on the server actually see the field the admin thinks they filled in.
function cleanRowKeys(rows) {
  return rows.map((row) => {
    const clean = {};
    for (const [key, value] of Object.entries(row)) {
      clean[key.replace(/^﻿/, '').trim()] = value;
    }
    return clean;
  });
}

function parseUploadedFile(file) {
  return new Promise((resolve, reject) => {
    const isCsv = file.name.toLowerCase().endsWith('.csv');
    if (isCsv) {
      Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        transformHeader: (h) => h.replace(/^﻿/, '').trim(),
        complete: (result) => resolve(cleanRowKeys(result.data)),
        error: reject,
      });
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const workbook = XLSX.read(e.target.result, { type: 'array' });
        const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
        resolve(cleanRowKeys(XLSX.utils.sheet_to_json(firstSheet, { defval: '' })));
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

function ImportResultSummary({ result }) {
  if (!result) return null;
  return (
    <div className="banner banner-success" style={{ marginTop: 12 }}>
      <p style={{ margin: '0 0 8px' }}>
        {result.created.length} account{result.created.length === 1 ? '' : 's'} created,{' '}
        {result.linkedExisting.length} existing account{result.linkedExisting.length === 1 ? '' : 's'} added,{' '}
        {result.errors.length} row{result.errors.length === 1 ? '' : 's'} skipped.
      </p>
      {result.created.length > 0 && (
        <>
          <p style={{ margin: '0 0 4px', fontWeight: 700 }}>Temporary passwords (share with each player):</p>
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {result.created.map((c) => (
              <li key={c.email}>{c.name} ({c.email}) → <code>{c.tempPassword}</code></li>
            ))}
          </ul>
        </>
      )}
      {result.errors.length > 0 && (
        <>
          <p style={{ margin: '8px 0 4px', fontWeight: 700, color: '#991b1b' }}>Skipped rows:</p>
          <ul style={{ margin: 0, paddingLeft: 20, color: '#991b1b' }}>
            {result.errors.map((e) => (
              <li key={e.row}>Row {e.row}: {e.reason}</li>
            ))}
          </ul>
        </>
      )}
      {result.pendingPayment && result.pendingPayment.length > 0 && (
        <>
          <p style={{ margin: '8px 0 4px', fontWeight: 700, color: '#92400e' }}>
            Added, but still need payment confirmed ({result.pendingPayment.length}):
          </p>
          <ul style={{ margin: 0, paddingLeft: 20, color: '#92400e' }}>
            {result.pendingPayment.map((p) => (
              <li key={p.email}>{p.name} ({p.email}) - {p.division}</li>
            ))}
          </ul>
          <p className="muted" style={{ fontSize: '0.8rem', marginTop: 4 }}>
            Confirm or waive each of these from the league's Payments tab once you're done importing.
          </p>
        </>
      )}
    </div>
  );
}

function ManualAddForm({ league, onImported, setError }) {
  const [form, setForm] = useState({
    firstName: '', lastName: '', email: '', phone: '', teamName: '',
    classification: '', isCaptain: false, division: league.divisions[0]?.name || '',
  });
  const [submitting, setSubmitting] = useState(false);
  const set = (field) => (e) => setForm({ ...form, [field]: e.target.value });

  const onSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const result = await api.adminImportSeasonPlayers(league.id, [{ ...form, classification: form.classification || null }]);
      onImported(result);
      setForm({ ...form, firstName: '', lastName: '', email: '', phone: '' });
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="card form" onSubmit={onSubmit}>
      <h3 style={{ marginTop: 0 }}>Add one player</h3>
      <label>First name<input value={form.firstName} onChange={set('firstName')} required /></label>
      <label>Last name<input value={form.lastName} onChange={set('lastName')} required /></label>
      <label>Email<input type="email" value={form.email} onChange={set('email')} required /></label>
      <label>Phone <span className="muted">(optional)</span><input type="tel" value={form.phone} onChange={set('phone')} /></label>
      <label>Team name <span className="muted">(optional)</span><input value={form.teamName} onChange={set('teamName')} /></label>
      <label>
        Classification <span className="muted">(optional)</span>
        <select value={form.classification} onChange={set('classification')}>
          <option value="">Not set</option>
          {CLASSIFICATIONS.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </label>
      <label>
        League (division)
        <select value={form.division} onChange={set('division')} required>
          {league.divisions.map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}
        </select>
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input type="checkbox" style={{ width: 'auto' }} checked={form.isCaptain} onChange={(e) => setForm({ ...form, isCaptain: e.target.checked })} />
        Mark as captain
      </label>
      <button className="btn btn-primary" type="submit" disabled={submitting}>
        {submitting ? 'Adding…' : 'Add Player'}
      </button>
    </form>
  );
}

// The 5-step "New Season" wizard: name -> league/player counts -> add
// players (CSV/Excel or manual) -> season dates -> generate fixtures with
// the gap between games. A "season" is a League (the season itself) with N
// Divisions inside it (the "leagues" the admin asked for) - reusing the
// existing engine means standings, fixtures and scoring all work
// immediately, with no new data model to learn.
export default function AdminSeasonWizard() {
  const navigate = useNavigate();
  useSetBreadcrumbs([{ label: 'Home', to: '/' }, { label: 'Admin', to: '/admin' }, { label: 'New Season' }]);

  const [step, setStep] = useState(1);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const [seasonName, setSeasonName] = useState('');
  const [leagueCount, setLeagueCount] = useState(4);
  const [playersPerLeague, setPlayersPerLeague] = useState(8);
  const [league, setLeague] = useState(null); // created season + divisions

  // Payment wall (optional) - applies to the whole season (one League
  // record), not per sub-league/division - see LeagueDetail's Payment Wall
  // panel for editing this later.
  const [paymentRequired, setPaymentRequired] = useState(false);
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentWindowStart, setPaymentWindowStart] = useState('');
  const [paymentWindowEnd, setPaymentWindowEnd] = useState('');

  const [importMode, setImportMode] = useState('csv');
  const [parsedRows, setParsedRows] = useState(null);
  const [importResult, setImportResult] = useState(null);
  const [fileName, setFileName] = useState('');

  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [gapDays, setGapDays] = useState(7);
  const [generateResult, setGenerateResult] = useState(null);

  // Step 1 -> 2 is purely local state; the season isn't created until step 2
  // submits (the API needs the league/player counts up front to build the
  // divisions).
  const onStep1Submit = (e) => {
    e.preventDefault();
    if (!seasonName.trim()) { setError('Season name is required'); return; }
    if (paymentRequired && (!paymentAmount || Number(paymentAmount) <= 0)) {
      setError('Entry fee must be a number greater than 0');
      return;
    }
    setError('');
    setStep(2);
  };

  const onStep2Submit = async (e) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const created = await api.adminCreateSeason({
        name: seasonName, leagueCount: Number(leagueCount), playersPerLeague: Number(playersPerLeague),
        payment: paymentRequired
          ? {
              required: true,
              amount: Number(paymentAmount),
              currency: 'GBP',
              windowStart: paymentWindowStart || null,
              windowEnd: paymentWindowEnd || null,
            }
          : { required: false },
      });
      setLeague(created);
      setStep(3);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const onFileChange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setError('');
    setFileName(file.name);
    try {
      const rows = await parseUploadedFile(file);
      setParsedRows(rows);
    } catch (err) {
      setError(`Couldn't read that file: ${err.message}`);
    }
  };

  const onImportParsedRows = async () => {
    setError('');
    setSubmitting(true);
    try {
      const result = await api.adminImportSeasonPlayers(league.id, parsedRows);
      setImportResult(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const onStep4Submit = (e) => {
    e.preventDefault();
    if (!startDate || !endDate) { setError('Both dates are required'); return; }
    if (endDate < startDate) { setError('End date cannot be before start date'); return; }
    setError('');
    setStep(5);
  };

  const onGenerate = async () => {
    setError('');
    setSubmitting(true);
    try {
      const result = await api.adminGenerateSeason(league.id, { startDate, endDate, gapDays: Number(gapDays) });
      setGenerateResult(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <p><Link to="/admin">&larr; Admin Portal</Link></p>
      <h1>New Season</h1>
      <p className="muted">Step {step} of 5</p>
      {error && <p className="error">{error}</p>}

      {step === 1 && (
        <form className="card form" onSubmit={onStep1Submit}>
          <h2>1. Name the season</h2>
          <label>
            Season name
            <input value={seasonName} onChange={(e) => setSeasonName(e.target.value)} placeholder="e.g. Autumn 2026" required autoFocus />
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="checkbox"
              style={{ width: 'auto' }}
              checked={paymentRequired}
              onChange={(e) => setPaymentRequired(e.target.checked)}
            />
            Require payment to join this season
          </label>
          {paymentRequired && (
            <>
              <label>
                Entry fee (£)
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={paymentAmount}
                  onChange={(e) => setPaymentAmount(e.target.value)}
                  required
                />
              </label>
              <label>
                Payment window opens (optional)
                <input type="date" value={paymentWindowStart} onChange={(e) => setPaymentWindowStart(e.target.value)} />
              </label>
              <label>
                Payment window closes (optional)
                <input type="date" value={paymentWindowEnd} onChange={(e) => setPaymentWindowEnd(e.target.value)} />
              </label>
              <p className="muted" style={{ fontSize: '0.8rem', marginTop: -8 }}>
                Anyone imported without an existing confirmed payment is added to their division but flagged as
                unpaid on this league's Payments tab - the import step never blocks on this.
              </p>
            </>
          )}
          <button className="btn btn-primary" type="submit">Next</button>
        </form>
      )}

      {step === 2 && (
        <form className="card form" onSubmit={onStep2Submit}>
          <h2>2. How many leagues, and how many players in each?</h2>
          <p className="muted">
            Each "league" becomes its own division within <strong>{seasonName}</strong> - its own
            round-robin, standings and fixture list.
          </p>
          <label>
            Number of leagues
            <input type="number" min="1" max="50" value={leagueCount} onChange={(e) => setLeagueCount(e.target.value)} required />
          </label>
          <label>
            Players per league (target - you can add more or fewer)
            <input type="number" min="2" max="200" value={playersPerLeague} onChange={(e) => setPlayersPerLeague(e.target.value)} required />
          </label>
          <div className="inline-form" style={{ marginTop: 8 }}>
            <button className="btn" type="button" onClick={() => setStep(1)}>Back</button>
            <button className="btn btn-primary" type="submit" disabled={submitting}>
              {submitting ? 'Creating…' : 'Create Season & Continue'}
            </button>
          </div>
        </form>
      )}

      {step === 3 && league && (
        <div>
          <div className="card">
            <h2>3. Add players</h2>
            <p className="muted">
              {league.name} has {league.divisions.length} league{league.divisions.length === 1 ? '' : 's'}:{' '}
              {league.divisions.map((d) => d.name).join(', ')}.
            </p>
            <div className="inline-form">
              <button className={`btn ${importMode === 'csv' ? 'btn-primary' : ''}`} type="button" onClick={() => setImportMode('csv')}>
                Upload CSV / Excel
              </button>
              <button className={`btn ${importMode === 'manual' ? 'btn-primary' : ''}`} type="button" onClick={() => setImportMode('manual')}>
                Add players manually
              </button>
            </div>
          </div>

          {importMode === 'csv' ? (
            <div className="card">
              <h3 style={{ marginTop: 0 }}>Upload a CSV or Excel file</h3>
              <p className="muted">
                Download a template first (it's pre-filled with the exact league names above), fill in
                one row per player, then upload it here.
              </p>
              <div className="inline-form">
                <button className="btn" type="button" onClick={() => downloadCsvTemplate(league.divisions)}>Download CSV template</button>
                <button className="btn" type="button" onClick={() => downloadExcelTemplate(league.divisions)}>Download Excel template</button>
              </div>
              <label>
                Upload filled-in file
                <input type="file" accept=".csv,.xlsx,.xls" onChange={onFileChange} />
              </label>
              {fileName && parsedRows && (
                <>
                  <p className="muted">{fileName}: {parsedRows.length} row(s) found.</p>
                  <button className="btn btn-primary" type="button" onClick={onImportParsedRows} disabled={submitting}>
                    {submitting ? 'Importing…' : `Import ${parsedRows.length} player(s)`}
                  </button>
                </>
              )}
              <ImportResultSummary result={importResult} />
            </div>
          ) : (
            <div>
              <ManualAddForm
                league={league}
                setError={setError}
                onImported={(result) => setImportResult((prev) => prev
                  ? { created: [...prev.created, ...result.created], linkedExisting: [...prev.linkedExisting, ...result.linkedExisting], errors: [...prev.errors, ...result.errors] }
                  : result)}
              />
              <ImportResultSummary result={importResult} />
            </div>
          )}

          <div className="inline-form" style={{ marginTop: 8 }}>
            <button className="btn" type="button" onClick={() => setStep(2)}>Back</button>
            <button className="btn btn-primary" type="button" onClick={() => setStep(4)}>
              Continue
            </button>
          </div>
        </div>
      )}

      {step === 4 && (
        <form className="card form" onSubmit={onStep4Submit}>
          <h2>4. Season dates</h2>
          <label>
            Start date
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required />
          </label>
          <label>
            End date
            <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} required />
          </label>
          <div className="inline-form" style={{ marginTop: 8 }}>
            <button className="btn" type="button" onClick={() => setStep(3)}>Back</button>
            <button className="btn btn-primary" type="submit">Next</button>
          </div>
        </form>
      )}

      {step === 5 && (
        <div className="card">
          <h2>5. Generate fixtures</h2>
          <p className="muted">
            {league.name} runs from <strong>{startDate}</strong> to <strong>{endDate}</strong>. Set how many
            days apart each round should be played, and every league (division) with at least 2 players
            will get its full round-robin fixture list generated with dates spaced accordingly.
          </p>
          <label>
            Days between rounds
            <input type="number" min="1" value={gapDays} onChange={(e) => setGapDays(e.target.value)} style={{ maxWidth: 120 }} />
          </label>

          {!generateResult ? (
            <div className="inline-form" style={{ marginTop: 8 }}>
              <button className="btn" type="button" onClick={() => setStep(4)}>Back</button>
              <button className="btn btn-primary" type="button" onClick={onGenerate} disabled={submitting}>
                {submitting ? 'Generating…' : 'Generate Fixtures Now'}
              </button>
              <button className="btn" type="button" onClick={() => navigate(`/leagues/${league.id}`)}>
                Skip - I'll generate fixtures later
              </button>
            </div>
          ) : (
            <div>
              <div className="banner banner-success">
                <p style={{ margin: 0 }}>Fixtures generated for {generateResult.generated.length} league(s).</p>
              </div>
              {generateResult.generated.length > 0 && (
                <ul className="fixture-list">
                  {generateResult.generated.map((g) => (
                    <li key={g.division}>
                      <span>{g.division}: {g.players} players, {g.rounds} round(s)</span>
                      <span className={g.fitsWithinEndDate ? 'muted' : 'error'} style={g.fitsWithinEndDate ? {} : { padding: '2px 8px' }}>
                        last game {g.lastGameDate}{!g.fitsWithinEndDate && ' — after end date!'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {generateResult.skipped.length > 0 && (
                <>
                  <p className="muted" style={{ marginTop: 12 }}>Skipped:</p>
                  <ul className="fixture-list">
                    {generateResult.skipped.map((s) => (
                      <li key={s.division}><span>{s.division}</span><span className="muted">{s.reason}</span></li>
                    ))}
                  </ul>
                </>
              )}
              <button className="btn btn-primary" type="button" style={{ marginTop: 12 }} onClick={() => navigate(`/leagues/${league.id}`)}>
                View Season
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
