import profilePic from './assets/pfp.jpg'

function UserProfile(){

    return(
        <div className="card">
            <img className="card-image" src={profilePic} alt="Profile Picture"></img>
            <h2>Username</h2>
            <h2>Email</h2>
            <h2>Password</h2>
            <h2>Sign out</h2>
            <h2>Reset Password</h2>
        </div>
    );
}
export default UserProfile