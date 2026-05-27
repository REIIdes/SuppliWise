import React from 'react';
import './LandingPage2.css';
import '../Pages/HomePage.css';
import logo from '../assets/logo.png';
import { NavLink } from 'react-router-dom';
import pulselogo from '../assets/pulselogo.png';
import brain1 from '../assets/brain1.png';
import security1 from '../assets/security1.png';

function LandingPage2() {

    return (

        <div>

            {/* NAVBAR */}
            <div className='navbar'>

                <img
                    src={logo}
                    alt=''
                    className='logo'
                />

                <h1 className='companyName'>
                    Supplement Helper
                </h1>

                <ul>

                    <li>
                        <NavLink
                            to="/"
                            className={({ isActive }) =>
                                isActive ? "active" : ""
                            }
                        >
                            Home
                        </NavLink>
                    </li>

                    <li>
                        <NavLink
                            to="/about"
                            className={({ isActive }) =>
                                isActive ? "active" : ""
                            }
                        >
                            About Us
                        </NavLink>
                    </li>

                    <li>
                        <NavLink
                            to="/contact"
                            className={({ isActive }) =>
                                isActive ? "active" : ""
                            }
                        >
                            Contact
                        </NavLink>
                    </li>

                    <li>
                        <NavLink
                            to="/services"
                            className={({ isActive }) =>
                                isActive ? "active" : ""
                            }
                        >
                            Services
                        </NavLink>
                    </li>

                </ul>

                <NavLink
                    to="/signup"
                    className="signup"
                >
                    Sign up
                </NavLink>

                <NavLink
                    to="/login"
                    className="login"
                >
                    Login
                </NavLink>

            </div>

            {/* PAGE CONTENT */}
            <div className="landing2-container">

                <h1 className="how-title">
                    How it works
                </h1>

                <div className="cards-container">

                    {/* CARD 1 */}
                    <div className="info-card">

                        <div className="icon green-icon">
                    <img
                        src={pulselogo}
                        alt="Pulse Logo"
                        className="cardLogo"
                    />
                </div>

                        <h2>Health Assessment</h2>

                        <p>
                            Complete a comprehensive health questionnaire
                            to help our AI understand your unique needs,
                            symptoms, and wellness goals.
                        </p>

                    </div>

                    {/* CARD 2 */}
                    <div className="info-card">

                        <div className="icon blue-icon">
                        <img
                            src={brain1}
                            alt="Brain Logo"
                            className="cardLogo2"
                        />
                    </div>

                        <h2>AI Analysis</h2>

                        <p>
                            Our advanced AI analyzes your health profile
                            and provides personalized supplement
                            recommendations tailored to your needs.
                        </p>

                    </div>

                    {/* CARD 3 */}
                    <div className="info-card">

                       <div className="icon purple-icon">
                        <img
                            src={security1}
                            alt="Brain Logo"
                            className="cardLogo3"
                        />
                    </div>

                        <h2>Track Progress</h2>

                        <p>
                            Monitor your supplement intake,
                            track your wellness journey,
                            and adjust recommendations as your needs evolve.
                        </p>

                    </div>

                </div>

            </div>

        </div>
    );
}

export default LandingPage2;