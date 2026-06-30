# Profile Settings Feature

## Overview
Added a comprehensive profile settings page that allows users to view and update their personal information, including the ability to change their password.

## What Was Added

### Frontend Components

#### 1. ProfilePage Component (`src/Pages/ProfilePage.jsx`)
A full-featured profile management page with:
- **View Mode**: Display current user information
- **Edit Mode**: Update personal details and password
- **Real-time validation**: Client-side validation for all fields
- **Age calculation**: Automatic age display based on date of birth
- **Password change**: Optional password update with current password verification
- **Success/Error messages**: Clear feedback for all operations
- **Responsive design**: Mobile-friendly layout

**Features:**
- Personal information section (first name, last name, email, date of birth, gender)
- Optional password change section (only shown in edit mode)
- Edit/Cancel/Save actions
- Automatic localStorage update after successful save
- Page reload to update navbar with new information

#### 2. ProfilePage Styles (`src/Pages/ProfilePage.css`)
Professional styling with:
- Green gradient header matching app theme
- Large profile avatar display
- Form sections with clear visual hierarchy
- Responsive layout for mobile devices
- Hover effects and transitions
- Disabled state styling for read-only mode

#### 3. Updated Navbar (`src/Components/Navbar/Navbar.jsx`)
- Changed profile display from static `div` to clickable `NavLink`
- Links to `/profile` route
- Hover effects for better UX
- Maintains avatar and username display

#### 4. Updated Navbar Styles (`src/Components/Navbar/Navbar.css`)
- Added `.navbar-profile-link` styles
- Hover effects (background color and avatar scale)
- Smooth transitions

### Backend API

#### Profile Update Endpoint (`server/routes/auth.js`)
**Route:** `PUT /api/auth/profile`
**Access:** Private (requires authentication token)

**Features:**
- Full JWT authentication
- Comprehensive input validation
- Email uniqueness check (excluding current user)
- Age validation (1-120 years)
- Optional password change with current password verification
- Strong password requirements:
  - Minimum 8 characters
  - At least one uppercase letter
  - At least one number
- Automatic password hashing when changed
- Returns updated user object

**Request Body:**
```json
{
  "firstName": "string",
  "lastName": "string",
  "email": "string",
  "dateOfBirth": "YYYY-MM-DD",
  "gender": "Male|Female",
  "currentPassword": "string (optional)",
  "newPassword": "string (optional)"
}
```

**Response:**
```json
{
  "_id": "user_id",
  "firstName": "First",
  "lastName": "Last",
  "name": "First Last",
  "email": "user@example.com",
  "dateOfBirth": "1990-01-01T00:00:00.000Z",
  "age": 34,
  "gender": "Male"
}
```

### Routing

#### Updated App Component (`src/App.jsx`)
- Added ProfilePage import
- Added `/profile` route
- Maintains all existing routes

## User Flow

1. **Access Profile Settings:**
   - User clicks on their avatar/name in the navbar
   - Navigates to `/profile` page

2. **View Profile:**
   - Sees personal information in read-only mode
   - Large avatar with initial
   - All current details displayed

3. **Edit Profile:**
   - Clicks "Edit Profile" button
   - All fields become editable
   - Password change section appears

4. **Update Information:**
   - Modifies desired fields
   - Optionally changes password
   - Clicks "Save Changes"
   - Sees success message
   - Page reloads with updated information

5. **Cancel Changes:**
   - Clicks "Cancel" to discard changes
   - Returns to view mode with original data

## Validation Rules

### Frontend Validation
- All fields required except password fields
- Real-time error feedback
- Password confirmation match check
- Password strength requirements display

### Backend Validation
- First name: 2-50 characters
- Last name: 2-50 characters
- Email: valid format with proper TLD
- Email uniqueness (unless unchanged)
- Date of birth: age between 1-120 years
- Gender: Male or Female only
- Password (if changing):
  - Current password required
  - Current password must be correct
  - New password minimum 8 characters
  - Must contain uppercase letter
  - Must contain number

## Security Features

1. **Authentication Required:**
   - JWT token required in Authorization header
   - Token verified before any operation
   - User identity confirmed from database

2. **Password Security:**
   - Current password required to change password
   - Password verified before allowing change
   - New password hashed with bcrypt
   - Strong password requirements enforced

3. **Data Protection:**
   - Email uniqueness enforced
   - Comprehensive validation prevents invalid data
   - Error messages don't leak sensitive information

## Files Modified/Created

### Created:
- `my-react-app/src/Pages/ProfilePage.jsx` - Main profile component
- `my-react-app/src/Pages/ProfilePage.css` - Profile page styles
- `PROFILE_SETTINGS_FEATURE.md` - This documentation

### Modified:
- `my-react-app/src/App.jsx` - Added profile route
- `my-react-app/src/Components/Navbar/Navbar.jsx` - Made profile clickable
- `my-react-app/src/Components/Navbar/Navbar.css` - Added hover styles
- `server/routes/auth.js` - Added profile update endpoint

## Testing the Feature

1. **Start the application:**
   ```bash
   # Terminal 1 - Backend
   cd server
   npm start

   # Terminal 2 - Frontend
   cd my-react-app
   npm run dev
   ```

2. **Test scenarios:**
   - View profile information
   - Update name fields
   - Update email (verify uniqueness check)
   - Update date of birth (verify age recalculation)
   - Change gender selection
   - Change password (test validation)
   - Try changing password with wrong current password
   - Cancel changes and verify data restoration
   - Save changes and verify navbar updates

## Future Enhancements

Potential improvements:
- Profile picture upload
- Email verification for email changes
- Password strength meter
- Two-factor authentication settings
- Account deletion option
- Activity log/login history
- Privacy settings
- Notification preferences

## API Error Codes

- `400` - Validation error (invalid input)
- `401` - Authentication error (no token, invalid token, or user not found)
- `500` - Server error (database issues, etc.)

## Notes

- Profile updates trigger a page reload to ensure navbar reflects changes
- Password change is optional - leave blank to keep current password
- All changes are saved atomically (all or nothing)
- localStorage is updated with new user data after successful save
- Token remains valid after profile updates (no re-login required)
