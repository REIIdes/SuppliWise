'use strict';

/**
 * THE APP'S OWN HELP CONTENT, AS DATA.
 *
 * This text used to be a 4 KB literal spliced into every chat system prompt, in
 * full, on every turn — including the turns that were about magnesium. Making it a
 * list of sections with keywords means the assistant now gets the two or three
 * sections the question actually needs, which leaves room for the member's own
 * record instead of irrelevant pages, and means an answer about the app can be
 * checked against a named section rather than against a paragraph nobody can point
 * at.
 *
 * `never` sections are the ones that keep the assistant honest: the "does not exist"
 * list is what stops it inventing a reminder feature or a dark mode when a member
 * asks how to do something the app cannot do. That section is always retrieved for
 * any "how do I / can I" question, because a wrong "yes, go to Settings" costs the
 * member more time than a correct "the app does not do that".
 */
const APP_GUIDE_SECTIONS = [
  {
    id: 'app:core-pages',
    title: 'SuppliWise pages and routes',
    keys: ['page', 'screen', 'where', 'find', 'route', 'home', 'dashboard', 'results', 'insights', 'profile'],
    text: 'HomePage (root): landing with redirects to assessment or dashboard. AssessmentPage (/assessment): the 4-step health questionnaire. ResultsPage (/results): AI supplement recommendations with confidence scores and priorities. DashboardPage (/dashboard): Track Intake tab plus Recommendations tab. TrackIntakePage (/track-intake): daily supplement tracker with calendar. RecommendationsPage (/recommendations): browse AI recommendations with filters and sorting. HistoryPage (/history): past assessments with view, PDF export and delete controls. InsightsPage (/insights): Overview, Today\'s Progress, Adherence, AI Insight. ProfilePage (/profile): edit info, pictures, password; the logout button is at the bottom of the page (left on desktop, below Edit Profile on mobile), and Profile is opened by clicking the avatar or name in the top-right navbar.',
  },
  {
    id: 'app:navigation',
    title: 'Navbar and navigation',
    keys: ['navbar', 'menu', 'navigate', 'navigate', 'clock', 'avatar', 'top right', 'back button'],
    text: 'Navbar: logo (goes to dashboard), clock icon top-right (goes to history), avatar or name top-right (goes to profile), Sign In when logged out. A Back button is available in the navbar on pages you can return from.',
  },
  {
    id: 'app:account',
    title: 'Sign up, sign in, password and profile',
    keys: ['sign up', 'register', 'login', 'log in', 'sign in', 'password', 'forgot', 'otp', 'email change', 'profile', 'account', 'delete account'],
    text: 'Registration asks name, email, date of birth, gender and a password (minimum 8 characters, 1 uppercase, 1 number). Sign in is email plus password, then a 6-digit email code; a session ends on sign-out or when a newer sign-in replaces it. Forgot password exists: "Forgot password?" then the email, then the 6-digit code (10-minute expiry), then set a new password. Profile editing covers name, email, date of birth, gender, profile picture (max 2 MB), banner (max 3 MB) and password (changing it needs the current one). Changing the email triggers a verification code. Sign out is at the bottom of the Profile page.',
  },
  {
    id: 'app:assessment',
    title: 'The health assessment, step by step',
    keys: ['assessment', 'questionnaire', 'steps', 'quiz', 'retest', 'retake', 'answers', 'progress'],
    text: 'The assessment has four steps. 1 Basic: age, gender, weight, height, activity level. 2 Diet and goals: diet type and health goals (energy, sleep, immunity, digestion, mental clarity, stress, heart, bone, muscle, skin, weight, hormonal, joint). 3 Symptoms: symptom selection with mild/moderate/severe severity, sleep quality, water intake. 4 Medical: conditions, medications, allergies, lifestyle (smoking, alcohol, caffeine), optional blood test results and notes. Progress saves as you go. Recommendations are generated from those answers and then checked against the app\'s curated evidence registry, and citations the app cannot verify are removed before the member sees them.',
  },
  {
    id: 'app:results',
    title: 'Results page, confidence scores and PDF',
    keys: ['results', 'confidence', 'priority', 'pdf', 'export', 'download', 'cards', 'schedule', 'warnings', 'avoid'],
    text: 'Each supplement card shows name, dosage, timing, priority (High/Medium/Low), confidence percentage, reason and interactions. Confidence bands: 90-100% direct match, 80-89% good, 70-79% moderate, below 70% partial. The page sections are Priority Supplements, Optional, Daily Schedule, Lifestyle Advice, Meals, Action Plan, Warnings and Avoid List. PDF export is available from the Results page and the History page. The evidence note on each card is copied from the app\'s curated registry and checked against PubMed.',
  },
  {
    id: 'app:tracking',
    title: 'Tracking intake, calendar, adherence and streaks',
    keys: ['track', 'intake', 'taken', 'calendar', 'adherence', 'streak', 'missed', 'undo', 'mark'],
    text: 'The Track Intake tab marks supplements as taken by time slot (Morning, Afternoon, Evening, Night) with a completion counter and a toast when all are taken. The Track Intake page lists today\'s supplements with priority dots, mark taken or undo, and a calendar whose day colours are green for 100%, yellow for partial, red for missed and blue for today, plus adherence percentage and streak counters.',
  },
  {
    id: 'app:insights',
    title: 'Insights page and wellness score',
    keys: ['insights', 'score', 'wellness', 'progress', 'weekly', 'chart', 'ai insight', 'phase'],
    text: 'Insights has four tabs. Overview: streak, adherence, wellness score, assessment count, current phase and lifestyle tips. Today\'s Progress: a circular chart and the supplement list with status. Adherence: a weekly bar chart across seven days and the action plan phases. AI Insight: phase guidance and personalised tips.',
  },
  {
    id: 'app:history',
    title: 'History, past plans and deletion',
    keys: ['history', 'past', 'previous', 'delete', 'old assessment', 'archive'],
    text: 'History lists every assessment newest first, with an eye icon to view and a download icon for the PDF, and expandable cards. The assessment owner and admins can delete an assessment; deleting also removes its linked tracking data.',
  },
  {
    id: 'app:recommendations',
    title: 'Recommendations page and adding to the plan',
    keys: ['recommendation', 'add to plan', 'remove', 'filter', 'sort', 'browse', 'plan'],
    text: 'The Recommendations page is the full list with filters (All, Priority, Optional) and sorting (Priority, Name, Confidence), a "+ Add to Plan" button and an "Added to Plan" badge. Adding to the plan is what puts a supplement into the daily tracker.',
  },
  {
    id: 'app:exists',
    title: 'What the app does have',
    keys: ['can i', 'does it have', 'is there', 'feature', 'support', 'available'],
    text: 'The app does have: password reset by email code, profile editing including pictures, password change (needs the current password), email change with a code, daily supplement tracking by time, a monthly calendar with completion, adherence tracking weekly and overall, current and longest streaks, the four-tab Insights page, PDF export from Results and History, add and remove from plan, filters and sorting on recommendations, a completion toast, and code verification for password reset and email change.',
  },
  {
    id: 'app:does-not-exist',
    title: 'What the app does not have',
    keys: ['remind', 'reminder', 'notification', 'dark mode', 'watch', 'fitbit', 'wearable', 'share', 'social', 'compare', 'side by side', 'custom supplement', 'chart'],
    never: true,
    text: 'The app does not have: email or push notifications or reminders, a dark mode (light only), side-by-side comparison of assessments, social features or sharing of a plan, wearable integration such as Apple Watch or Fitbit, detailed supplement logging beyond daily checkboxes (no notes or times), time-based supplement reminders, custom supplement addition outside the AI recommendations, or progress charts beyond adherence. When a member asks how to do one of these, say the app does not do it yet instead of inventing a path through the app.',
  },
  {
    id: 'app:ai-and-data',
    title: 'How the AI features and the member record work',
    keys: ['ai', 'how does it work', 'trained', 'my data', 'private', 'secure', 'hallucinate', 'accuracy', 'model', 'chat assistant'],
    text: 'The assessment answers produce a supplement plan; the plan is checked against the app\'s curated evidence registry and the app\'s own dose ceilings before it is shown, and anything the check cannot stand behind is rewritten or removed rather than displayed. This assistant answers from three things only: the app\'s curated notes handed to it on this turn, the member\'s own saved answers and plan, and general nutrition framing that states no figures it was not given. It is not given the member\'s email, phone number, date of birth, password, security settings or billing record, so it cannot read those out. Each recommendation carries a confidence percentage and an evidence note on the Results page; a Priority flag on a plan means the app found something a member should bring to a clinician, and the member clears it by agreeing to the terms on the review screen.',
  },
];

module.exports = { APP_GUIDE_SECTIONS };
