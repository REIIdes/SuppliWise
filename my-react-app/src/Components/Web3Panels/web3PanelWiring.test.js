/**
 * The Web3 panels are JSX and fetch their own data, so these are wiring scans
 * rather than render tests: each one asserts that a capability the server
 * already answers is actually reachable from the UI, and that a receipt is only
 * ever claimed when the ledger wrote one.
 *
 * The class of bug these catch is the silent half-integration — an endpoint
 * with no client function, a client function with no button, or a panel whose
 * reload wipes the success line it just earned.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '..', '..');
const PANEL = (name) => readFileSync(join(SRC, 'Components', 'Web3Panels', name), 'utf8');
const PAGE = (name) => readFileSync(join(SRC, 'Pages', name), 'utf8');
const API = readFileSync(join(SRC, 'api', 'web3.js'), 'utf8');
/** Route source with line comments removed, so a comment cannot satisfy a check. */
const strip = (s) => s.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

test('every new blockchain endpoint has a client function and a caller', () => {
  const wiring = [
    ['/web3/chain/repairs', 'getChainRepairs', 'ExplorerPanel.jsx'],
    ['/web3/pledges', 'getPledges', 'PledgePanel.jsx'],
    ['/web3/rewards/leaderboard', 'getLeaderboard', 'RewardsPanel.jsx'],
    ['/web3/storage', 'getStorageList', 'PrivacyPanel.jsx'],
    ['/web3/storage/pin', 'pinStorage', 'PrivacyPanel.jsx'],
    ['/web3/rewards/assessment', 'claimAssessmentReward', 'RewardsPanel.jsx'],
  ];
  for (const [path, fn, panel] of wiring) {
    assert.match(API, new RegExp(`export const ${fn} =`), `${fn} must exist in api/web3.js`);
    assert.match(API, new RegExp(fn + '\\s*=\\s*\\([^)]*\\)\\s*=>[\\s\\S]{0,120}?' + path.replace(/[/.]/g, (c) => '\\' + c)),
      `${fn} must call ${path}`);
    assert.match(PANEL(panel), new RegExp(`\\b${fn}\\b`), `${panel} must import and use ${fn}`);
  }
});

test('the pledge tab is mounted in the hub shell', () => {
  const hub = strip(PAGE('Web3HubPage.jsx'));
  assert.match(hub, /import PledgePanel from '\.\.\/Components\/Web3Panels\/PledgePanel'/);
  assert.match(hub, /key: 'pledges'[\s\S]{0,120}Panel: PledgePanel/);
});

test('a pledge is one per day and the composer knows it', () => {
  const src = strip(PANEL('PledgePanel.jsx'));
  assert.match(src, /disabled=\{busy \|\| data\.claimedToday \|\| text\.trim\(\)\.length < 3\}/);
  assert.match(src, /data\.claimedToday \? '✓ Minted today/);
  // A row with no block yet is shown as pending, not as a receipt with an
  // empty hash — that is the difference between "not yet" and a fake proof.
  assert.match(src, /p\.txHash \? <CopyChip value=\{p\.txHash\} \/> : <span className="w3-badge amber">pending<\/span>/);
  assert.match(src, /if \(res\.anchored\) ok\(/, 'only an anchored mint claims a block');
  assert.match(src, /else info\(`Pledge saved\$\{paid\}\. The block is still being written/);
});

test('the wall never renders a full name', () => {
  const src = strip(PANEL('PledgePanel.jsx'));
  assert.match(src, /<span className="w3-badge blue">\{p\.by\}<\/span>/, 'the masked author is what the card shows');
  assert.doesNotMatch(src, /p\.(firstName|lastName|email|address)\}/, 'no raw identity or wallet on the wall');
});

test('the pledge streak comes from the tested day-key helper', () => {
  const src = strip(PANEL('PledgePanel.jsx'));
  // The counter first shipped as a component invoked with a positional array,
  // so its destructured `days` prop was undefined and a member who had just
  // minted today was told their run was 0 days long.
  assert.match(src, /import \{ streakDays \} from '\.\.\/\.\.\/utils\/streakDays'/);
  assert.match(src, /const streak = streakDays\(mine\.map\(\(p\) => p\.day\)\)/);
  assert.doesNotMatch(src, /Streak\(/, 'a component must not be invoked as a plain function');
});

test('the rewards panel draws the calendar from the day keys, not the count', () => {
  const src = strip(PANEL('RewardsPanel.jsx'));
  assert.match(src, /heatCells\(status\.checkinHistory\)/);
  assert.match(src, /className=\{`w3-heat-cell/);
  // Chronological, fixed window, and `today` marked — a heatmap with no anchor
  // date cannot be read as "current streak".
  assert.match(src, /const WEEKS = 13/);
  assert.match(src, /today: i === 0/);
});

test('assessment rewards claim every outstanding assessment, one at a time', () => {
  const src = strip(PANEL('RewardsPanel.jsx'));
  assert.match(src, /for \(const a of status\.claimableAssessments \|\| \[\]\)/);
  assert.match(src, /await claimAssessmentReward\(a\.id\)/, 'sequential: each claim appends a block');
  assert.match(src, /if \(r && !r\.alreadyClaimed\)/, 'a double click must not report a second payout');
  assert.match(src, /disabled=\{busy \|\| claimable\.length === 0\}/);
});

test('the leaderboard row for the caller is findable', () => {
  const src = strip(PANEL('RewardsPanel.jsx'));
  assert.match(src, /className=\{e\.me \? 'w3-lb-me' : undefined\}/);
  // Outside the top 20 the member still gets their rank, or the honest
  // "nothing minted this week" — never a silent list with no self.
  assert.match(src, /!board\.me\.inTop &&/);
  assert.match(src, /board\.me\.rank[\s\S]{0,160}#\$\{board\.me\.rank\} of \$\{board\.me\.participants\}/);
});

test('the explorer reads the repair log without letting it break the page', () => {
  const src = strip(PANEL('ExplorerPanel.jsx'));
  assert.match(src, /getChainRepairs\(\)\.then\(.*\)\.catch\(\(\) => setRepairs\(\[\]\)\)/,
    'a log that fails to load must not blank the explorer');
  assert.match(src, /repairs\.some\(\(r\) => r\.kind === 'incident'\)/);
  // An incident is only green once something later in the (newest-first) list
  // actually repaired it.
  assert.match(src, /const later = rows\.slice\(i \+ 1\)/);
  assert.match(src, /later\.some\(\(r\) => r\.kind === 'repair' \|\| r\.kind === 'quarantine-lifted'\)/);
});

test('the vault pins, lists and decrypts, and reports anchoring honestly', () => {
  const src = strip(PANEL('PrivacyPanel.jsx'));
  assert.match(src, /pinStorage\(\{ text: note\.trim\(\), at: Date.now\(\) \}, 'note'\)/);
  assert.match(src, /ok\(r\.anchored[\s\S]{0,220}anchored in block #\$\{r\.blockIndex\}/);
  assert.match(src, /still being written/, 'an unanchored pin says so instead of inventing a block');
  assert.match(src, /vault\.objects\.map\(\(o\) =>/);
  assert.match(src, /not anchored/);
  assert.match(src, /if \(!r\.integrityOk\) fail\(/, 'a CID that no longer matches is a failure, not a successful open');
});

test('an action message survives the reload that follows it', () => {
  // RewardsPanel already reloaded quietly; the privacy and marketplace panels
  // used to clear the alert they had just set, so the receipt was never visible.
  const srcs = {
    'PrivacyPanel.jsx': PANEL('PrivacyPanel.jsx'),
    'MarketplacePage.jsx': PAGE('MarketplacePage.jsx'),
  };
  for (const [name, raw] of Object.entries(srcs)) {
    const src = strip(raw);
    assert.match(src, /const load = async \(keepMessage = false\)/, `${name} must offer a quiet reload`);
    assert.match(src, /await load\(true\)/, `${name}'s action runner must use it`);
    assert.match(src, /if \(!keepMessage\) clear\(\)/, `${name} must only clear on a user-initiated load`);
  }
});

test('an escrow order never quotes a tx hash that the ledger did not write', () => {
  const src = strip(PAGE('MarketplacePage.jsx'));
  assert.match(src, /Number\(r\.order\.total\) > 0 && !r\.escrowTx/, 'a paid order with no hash is its own case');
  assert.doesNotMatch(src, /locked in escrow \(tx \$\{String\(r\.escrowTx\)\.slice/, 'no empty-hash receipt');
});
