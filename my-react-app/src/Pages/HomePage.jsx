import { useNavigate } from 'react-router-dom';
import Navbar from '../Components/Navbar/Navbar';
import { PLAN_CARD_ORDER, PLAN_META } from '../subscription/catalogue';
import './HomePage.css';

function HomePage() {
  const navigate = useNavigate();

  return (
    <div className="home-wrapper">
      <Navbar />

      {/* ── Hero Section ── */}
      <section className="hero-section">
        <div className="hero-badge">
          <span className="hero-badge-icon" aria-hidden="true">
            <svg xmlns="http://www.w3.org/2000/svg" width="26" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96-.46 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z"/>
              <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96-.46 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z"/>
            </svg>
          </span>
          AI Powered Supplement Guidance
        </div>
        <h1 className="hero-title">
          Your Personal Dietary<br />
          <span className="hero-title__accent">Supplement Assistant</span>
        </h1>
        <p className="hero-sub">
          Get personalized supplement recommendations based on your health profile,
          symptoms, and dietary needs. Powered by advanced AI to help you make informed
          decisions about your wellness journey.
        </p>
        <div className="hero-actions">
          <button className="btn-primary" onClick={() => navigate('/login', { state: { redirectTo: '/assessment' } })}>
            Start Assessment
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          </button>
          {/* "See plans" beside the primary action: the price list is the second
              thing a visitor decides on, and making them hunt for it after
              committing to a flow is where signups are lost. */}
          <button
            className="btn-secondary"
            type="button"
            onClick={() => navigate('/pricing')}
          >
            See plans
          </button>
          <button
            className="btn-secondary"
            type="button"
            onClick={() => document.getElementById('how-it-works')?.scrollIntoView({ behavior: 'smooth' })}
          >
            Learn More
          </button>
        </div>

        {/* Stats row */}
        <div className="hero-stats">
          <div className="hero-stat">
            <span className="hero-stat-num">4-Step</span>
            <span className="hero-stat-label">Health Assessment</span>
          </div>
          <div className="hero-stat-divider" />
          <div className="hero-stat">
            <span className="hero-stat-num">AI</span>
            <span className="hero-stat-label">Powered Analysis</span>
          </div>
          <div className="hero-stat-divider" />
          <div className="hero-stat">
            <span className="hero-stat-num">100%</span>
            <span className="hero-stat-label">Personalized</span>
          </div>
        </div>
      </section>

      {/* ── Divider ── */}
      <div className="section-divider">
        <span>How It Works</span>
      </div>

      {/* ── How It Works Section ── */}
      <section className="how-section" id="how-it-works">
        <div className="how-section-header">
          <h2 className="how-title">Three simple steps to better health</h2>
          <p className="how-subtitle">
            Our AI analyzes your complete health profile to deliver recommendations
            tailored specifically to you — not generic advice.
          </p>
        </div>

        <div className="how-cards">
          <div className="how-card">
            <div className="how-step-num">01</div>
            <div className="how-icon how-icon-green">
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
            </div>
            <h3>Health Assessment</h3>
            <p>
              Complete a 4-step questionnaire covering your basic info, diet, symptoms,
              and medical history. The more detail you provide, the more personalized your results.
            </p>
            <button className="how-card-btn" onClick={() => navigate('/login', { state: { redirectTo: '/assessment' } })}>
              Start Now →
            </button>
          </div>

          <div className="how-card how-card-featured">
            <div className="how-step-num">02</div>
            <div className="how-icon how-icon-blue">
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96-.46 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z"/><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96-.46 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z"/></svg>
            </div>
            <h3>AI Analysis</h3>
            <p>
              Our AI analyzes your full profile — symptoms, medications, allergies, diet,
              and goals — to generate safe, evidence-based supplement recommendations with
              confidence scores and interaction warnings.
            </p>
          </div>

          <div className="how-card">
            <div className="how-step-num">03</div>
            <div className="how-icon how-icon-purple">
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
            </div>
            <h3>Track Progress</h3>
            <p>
              View your personalized daily supplement plan, track your adherence and wellness progress, and receive updated AI recommendations based on your latest assessment.
            </p>
            <button className="how-card-btn" onClick={() => navigate('/login', { state: { redirectTo: '/dashboard' } })}>
              Get Started →
            </button>
          </div>
        </div>

        {/* Disclaimer */}
        <p className="how-disclaimer">
          ℹ️ This tool is for educational and wellness purposes only. It does not diagnose, treat, or cure any disease.
          Always consult a licensed healthcare professional before starting any supplement regimen.
        </p>
      </section>

      {/* ── Plans teaser ──
          A guest cannot buy here (a purchase needs an account), so this states
          the four plans and their starting points, then sends them to the real
          pricing page for the full comparison. The plan list is mirrored from
          the same module the pricing page uses, so the two can never disagree
          about what the plans are called. */}
      <section className="plans-section" id="plans">
        <div className="plans-section-header">
          <h2 className="how-title">Simple plans, no surprises</h2>
          <p className="how-subtitle">
            Start free. Upgrade when you want analytics, report export, priority
            review or the AI assistant. Every paid plan is billed monthly or
            yearly, and you can cancel any time.
          </p>
        </div>

        <div className="plans-teaser">
          {PLAN_CARD_ORDER.map((planId) => {
            const meta = PLAN_META[planId];
            return (
              <div
                key={planId}
                className={`plans-teaser-card${meta.highlight ? ' plans-teaser-card--highlight' : ''}`}
              >
                {meta.highlight && <span className="plans-teaser-badge">{meta.badge}</span>}
                <h3 className="plans-teaser-name">{meta.name}</h3>
                <p className="plans-teaser-tagline">{meta.tagline}</p>
                {/* The tier's own blurb, NOT a feature list.
                    This used to read `meta.features.slice(0, 3)`, and
                    `PLAN_META` deliberately carries no `features` array — the
                    bullets are derived on the server from the entitlement gates
                    and arrive with `GET /api/subscription/plans`, so a card can
                    never advertise something the backend would not grant (see
                    subscription/catalogue.js and subscription/pricingCopy.test.js).
                    The homepage is a guest teaser that must not wait on (or
                    duplicate) that payload, so it states the tier's blurb — one
                    sentence of positioning, not a list of promises. */}
                <p className="plans-teaser-blurb">{meta.blurb}</p>
              </div>
            );
          })}
        </div>

        <div className="plans-cta">
          <button className="btn-primary" type="button" onClick={() => navigate('/pricing')}>
            View full pricing
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          </button>
          {/* Team was a per-seat plan on top of Premium, so "every paid plan includes Team
              seat options" was never true of the pricing page. There are four plans
              and the copy says so. */}
          <p className="plans-cta-note">
            Prices are shown in your local currency. A purchase is 30 days and never
            renews on its own.
          </p>
        </div>
      </section>

      {/* ── Footer ──
          Carries the permanent links (including Plans) so they are reachable
          from the one page every visitor starts on. */}
      <footer className="home-footer">
        <div className="home-footer__brand">
          <span className="home-footer__name">SuppliWise</span>
          <span className="home-footer__tag">Personalized supplement guidance</span>
        </div>
        <nav className="home-footer__links" aria-label="Footer">
          <button type="button" className="home-footer__link" onClick={() => navigate('/pricing')}>
            Plans &amp; pricing
          </button>
          <button type="button" className="home-footer__link" onClick={() => navigate('/login', { state: { redirectTo: '/dashboard' } })}>
            Sign in
          </button>
          <button type="button" className="home-footer__link" onClick={() => document.getElementById('how-it-works')?.scrollIntoView({ behavior: 'smooth' })}>
            How it works
          </button>
        </nav>
        <p className="home-footer__legal">
          For educational and wellness purposes only. Not a substitute for
          professional medical advice.
        </p>
      </footer>
    </div>
  );
}

export default HomePage;
