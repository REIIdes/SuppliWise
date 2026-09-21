const fs = require('fs');
const checks = [
  ['routes/insights.js', 'requirePlan'],
  ['routes/chat.js', 'requirePlan'],
  ['routes/assessment.js', 'historyLimitFor'],
  ['routes/auth.js', 'subscriptionPlan'],
  ['../my-react-app/src/utils/plan.js', 'PLAN_RANK'],
  ['../my-react-app/src/api.js', 'requiresPlan'],
  ['../my-react-app/src/Components/UpgradeModal/UpgradeModal.jsx', 'UpgradeModal'],
  ['../my-react-app/src/Pages/ChatAssistant.jsx', 'getStoredPlan'],
  ['../my-react-app/src/Pages/InsightsPage.jsx', 'upgradeInfo'],
  ['../my-react-app/src/Pages/HistoryPage.jsx', 'planLimit'],
  ['../my-react-app/src/Pages/LogIn.jsx', 'subscriptionPlan'],
];
let bad = 0;
for (const [p, s] of checks) {
  try {
    const t = fs.readFileSync(p, 'utf8');
    const ok = t.includes(s);
    if (!ok) bad++;
    console.log((ok ? 'OK   ' : 'MISS ') + p + ' :: ' + s);
  } catch (e) {
    bad++;
    console.log('MISS ' + p + ' (no file)');
  }
}
process.exit(bad ? 1 : 0);
