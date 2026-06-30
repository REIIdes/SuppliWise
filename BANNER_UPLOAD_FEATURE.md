# Custom Banner Upload Feature

## Overview
Added the ability for users to upload custom banner images for their profile page, similar to the profile picture functionality.

## Features Implemented

### 1. **Backend Changes**

#### User Model (`server/models/User.js`)
- Added `bannerPicture` field to store banner image data (base64)
- Field is optional with empty string as default

#### Auth Routes (`server/routes/auth.js`)
- Updated `/api/auth/register` to return `bannerPicture`
- Updated `/api/auth/verify-login-otp` to return `bannerPicture`
- Updated `/api/auth/profile` (PUT) to accept and save `bannerPicture`

### 2. **Frontend Changes**

#### ProfilePage Component (`my-react-app/src/Pages/ProfilePage.jsx`)
- Added state management:
  - `bannerPicture` - current saved banner
  - `bannerPicturePreview` - preview of new banner
  - `bannerInputRef` - reference to hidden file input
  
- Added handlers:
  - `handleBannerPictureChange()` - validates and previews banner image
  - `handleBannerPictureClick()` - triggers file input when in edit mode
  - `handleRemoveBannerPicture()` - clears banner preview
  
- Updated `handleSubmit` to include banner in profile updates
- Banner loads from localStorage on component mount

#### UI Implementation
- **Edit Icon**: Circular button in top-right corner (pencil icon)
  - Only visible when in editing mode
  - Semi-transparent black background with white icon
  - Hover effect for better UX
  
- **Banner Display**: Profile header uses banner as background
  - Falls back to green gradient if no custom banner
  - Uses `background-size: cover` and `background-position: center`
  
- **Remove Banner Button**: Appears when banner exists in edit mode
  - Semi-transparent white button
  - Located next to "Remove Picture" button

#### Styling (`my-react-app/src/Pages/ProfilePage.css`)
- `.banner-edit-btn` - circular edit icon in top-right
  - 38x38px size
  - Black semi-transparent background
  - Hover scale effect
  
- `.profile-remove-banner` - remove banner button
  - Matches remove picture button styling
  - White semi-transparent with border

### 3. **Validation**
- File type must be an image
- Maximum file size: 3MB (larger than profile picture's 2MB due to banner dimensions)
- Base64 encoding for storage

### 4. **User Experience**

**Upload Flow:**
1. User clicks "Edit Profile"
2. Pencil icon appears in top-right of banner
3. Click icon → file picker opens
4. Select image → instant preview
5. Click "Save Changes" → banner uploads and saves
6. Banner persists in localStorage and MongoDB

**Remove Flow:**
1. When in edit mode with a banner
2. "Remove Banner" button appears
3. Click to remove → banner reverts to green gradient
4. Save changes to persist removal

## Technical Details

### Storage
- Banner stored as base64 string in MongoDB User document
- Also cached in localStorage for faster loading
- Synced across login/register/profile update

### Image Handling
- FileReader API for base64 conversion
- Inline preview before save
- No server-side file storage needed (base64 in DB)

## Benefits
- **Personalization**: Users can customize their profile appearance
- **Consistency**: Matches existing profile picture upload UX
- **Simple**: Uses same storage pattern as profile pictures
- **No Dependencies**: No additional libraries needed

## Future Enhancements
- Image cropping/resizing tool
- Predefined banner templates
- Banner position adjustment
- Suggested aspect ratio guidance (e.g., 3:1 or 16:9)
