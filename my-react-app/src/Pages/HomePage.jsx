import { useNavigate } from 'react-router-dom';
import Navbar from '../Components/Navbar/Navbar';
import './HomePage.css';

function HomePage() {
  const navigate = useNavigate();

  return (
    <div className="home-wrapper">
      <Navbar />

      {/* ── Hero Section ── */}
      <section className="hero-section">
        <div className="hero-badge">
          <span className="hero-badge-icon">
            <svg xmlns="http://www.w3.org/2000/svg" width="26" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96-.46 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z"/>
              <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96-.46 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z"/>
            </svg>
          </span>
          AI Powered Supplement Guidance
        </div>
        <h1 className="hero-title">
          Your Personal Dietary<br />Supplement Assistant
        </h1>
        <p className="hero-sub">
          Get personalized supplement recommendations based on your health profile,
          symptoms, and dietary needs. Powered by advanced AI to help you make informed
          decisions about your wellness journey.
        </p>
        <div className="hero-actions">
          <button className="btn-primary" onClick={() => navigate('/assessment')}>
            Start Assessment →
          </button>
          <button
            className="btn-secondary"
            onClick={() => document.getElementById('how-it-works').scrollIntoView({ behavior: 'smooth' })}
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
            <button className="how-card-btn" onClick={() => navigate('/assessment')}>
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
              View your personalized daily schedule, meal recommendations, and action plan.
              Retake assessments over time to track your progress and update recommendations.
            </p>
            <button className="how-card-btn" onClick={() => navigate('/assessment')}>
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
    </div>
  );
}

export default HomePage;
