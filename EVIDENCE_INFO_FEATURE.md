# Evidence Information Feature

## Overview
Added a transparency feature that displays information about the evidence sources used in supplement recommendations.

## Implementation Details

### Location
- **Component**: `ResultsPage.jsx`
- **Feature**: Small info icon (ⓘ) next to "Evidence & References" label in detailed mode

### User Experience

#### Trigger
- When viewing supplement recommendations in **Detailed Mode**
- User clicks the ⓘ icon next to "📚 Evidence & References"

#### Modal Content
The modal displays:

**Title**: "About Our Evidence"

**Content**:
- To help keep recommendations current, this system prioritizes:
  - ✅ Peer-reviewed sources published within the last 3 years
  - ✅ Additional supporting literature from the last 5 years
  - ✅ Systematic reviews, meta-analyses, and clinical guidelines for medical and nutrition topics
  - ✅ Proper APA-formatted references

**Disclaimer**:
- ⚠️ Recommendations are AI-assisted and are intended for informational purposes. Consult a healthcare professional before starting any supplement regimen.

### Technical Implementation

#### New Components
1. **EvidenceInfoModal** - Modal component displaying evidence transparency information
   - Closes on Escape key
   - Closes on overlay click
   - Closes on X button click
   - Prevents body scroll when open

#### State Management
- Added `showEvidenceInfo` state to `ResultsPage` component
- Passed down to `SupplementCard` via props

#### UI Elements
- **Info Button**: Small circular ⓘ icon with green theme
  - Only visible in detailed mode
  - Hover effects for better UX
  - Positioned inline with "Evidence & References" label

#### Styling
- Modal overlay with semi-transparent background
- Clean white panel with rounded corners
- Responsive design for mobile devices
- Smooth animations (fade in overlay, slide up panel)
- Color-coded sections (checklist items, warning disclaimer)

### Files Modified
1. **ResultsPage.jsx**
   - Added `EvidenceInfoModal` component
   - Added `showEvidenceInfo` state
   - Updated `SupplementCard` to include info button
   - Passed `setShowEvidenceInfo` prop to child components

2. **ResultsPage.css**
   - Added `.evidence-info-btn` styles
   - Added `.evidence-info-overlay` styles
   - Added `.evidence-info-panel` styles
   - Added responsive breakpoints

### Design Decisions

1. **Visibility**: Only shown in detailed mode since simplified mode uses "✓ Backed by Research" instead of "Evidence & References"

2. **Placement**: Inline with the label rather than separate button to maintain visual hierarchy

3. **Transparency Focus**: Emphasizes that this is about methodology transparency, not a guarantee

4. **Accessibility**: 
   - ARIA labels for screen readers
   - Keyboard navigation (Escape to close)
   - Focus management

5. **Non-intrusive**: Small icon that doesn't clutter the interface but is discoverable when needed

## User Benefit
- Builds trust by showing evidence methodology
- Sets appropriate expectations (informational, not diagnostic)
- Encourages medical consultation
- Demonstrates commitment to quality sources

## Testing Checklist
- [ ] Modal opens when clicking ⓘ icon
- [ ] Modal closes on X button click
- [ ] Modal closes on overlay click
- [ ] Modal closes on Escape key
- [ ] Body scroll prevented when modal open
- [ ] Icon only shows in detailed mode
- [ ] Icon not visible in simplified mode
- [ ] Responsive design works on mobile
- [ ] Animations play smoothly
- [ ] Text is readable and properly formatted
