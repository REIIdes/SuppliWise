import react from 'react'
import { Link } from 'react-router-dom';
import '../Components/Navbar/Navbar.css';
import logo from '../assets/logo.png';
import { NavLink } from 'react-router-dom';

function ContactPage(){

    return(
        <div className='navbar'>
            <img src={logo} alt='' className='logo'></img>
            <h1 className='companyName'>Supplement Helper</h1>
            <ul>
                <li>
                    <NavLink to="/" className={({ isActive }) => isActive ? "active" : ""}>
                        Home
                    </NavLink>
                </li>

                <li>
                    <NavLink to="/about" className={({ isActive }) => isActive ? "active" : ""}>
                        About Us
                    </NavLink>
                </li>

                <li>
                    <NavLink to="/contact" className={({ isActive }) => isActive ? "active" : ""}>
                        Contact
                    </NavLink>
                </li>

                <li>
                    <NavLink to="/services" className={({ isActive }) => isActive ? "active" : ""}>
                        Services
                    </NavLink>
                </li>
            </ul>
                <NavLink to="/signup" className="signup">
                        Sign up
                    </NavLink>

                    <NavLink to="/login" className="login">
                        Login
                    </NavLink>
        </div>
    );
}
export default ContactPage