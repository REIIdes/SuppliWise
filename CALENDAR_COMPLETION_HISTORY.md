# Calendar Completion History Feature

## Overview
The calendar in the Track Intake page now displays a visual history of your supplement-taking consistency, showing which days you completed all supplements, partially completed them, or missed them entirely.

## Feature Details

### Visual Indicators
The calendar uses color-coding to show your completion status:

1. **Today (Blue with ring)** - Current day, highlighted with green background and shadow ring
2. **100% Complete (Green)** - Days where you took all scheduled supplements
   - Light green background (#d1fae5)
   - Green border (#6ee7b7)
   - Small checkmark icon in the corner
3. **Partial Complete (Yellow)** - Days where you took some but not all supplements
   - Light yellow background (#fef3c7)
   - Yellow border (#fbbf24)
4. **Missed (Red)** - Days where supplements were scheduled but none were taken
   - Light red background (#fee2e2)
   - Red border (#fca5a5)
5. **No Data (White)** - Days with no supplement records (before assessment date or future dates)

### Tooltips
Hovering over any calendar day shows detailed information:
- **Today**: "Today"
- **Completed days**: "5/5 supplements taken (100%)"
- **Partial days**: "3/5 supplements taken (60%)"
- **Missed days**: "0/5 supplements taken (0%)"

### Calendar Legend
A legend appears below the calendar showing what each color represents:
- Today (green dot)
- 100% (green box)
- Partial (yellow box)
- Missed (red box)

### Month Navigation
- Click left/right arrows to view different months
- Calendar data is fetched dynamically for the displayed month
- Only shows completion data for dates after your latest assessment was taken

## How It Works

### Backend API
**Endpoint**: `GET /api/dashboard/calendar/:year/:month`

**Response Example**:
```json
{
  "completionData": {
    "15": {
      "percentage": 100,
      "taken": 5,
      "total": 5
    },
    "16": {
      "percentage": 60,
      "taken": 3,
      "total": 5
    },
    "17": {
      "percentage": 0,
      "taken": 0,
      "total": 5
    }
  }
}
```

The API:
1. Gets the user's latest assessment
2. Queries all `IntakeRecord` documents for the specified month
3. Groups records by `dayKey` (YYYY-MM-DD format)
4. Calculates completion percentage for each day
5. Returns data keyed by day number (1-31)

### Frontend Logic
1. **State Management**: Tracks `completionData` as a state object
2. **Auto-Fetch**: Fetches calendar data whenever the displayed month changes
3. **Rendering**: In `renderCalendar()`, checks completion data for each day and applies appropriate CSS class
4. **Checkmark Icon**: Shows a checkmark SVG for 100% completed days

### Data Flow
```
User marks supplement taken
  ↓
IntakeRecord updated in DB with dayKey
  ↓
Dashboard metrics recalculated
  ↓
User navigates to Track Intake page
  ↓
Calendar fetches completion data for current month
  ↓
Calendar renders with color-coded days
```

## User Experience Benefits

### 1. Visual Motivation
Users can see their consistency at a glance, motivating them to maintain streaks.

### 2. Pattern Recognition
Easily identify which days of the week or times of month adherence drops.

### 3. Historical Context
Review past performance when browsing previous months.

### 4. Streak Visualization
The calendar visually represents the "Day Streak" metric shown below it.

### 5. Goal Tracking
Green checkmarks provide satisfying visual feedback for perfect days.

## Technical Implementation

### Files Modified

**Backend**:
- `server/routes/dashboard.js` - Added `GET /api/dashboard/calendar/:year/:month` endpoint

**Frontend**:
- `my-react-app/src/api.js` - Added `getCalendarData(year, month)` function
- `my-react-app/src/Pages/TrackIntakePage.jsx` - Added completion data fetching and rendering
- `my-react-app/src/Pages/TrackIntakePage.css` - Added styles for completed/partial/missed days

### Key Code Changes

**TrackIntakePage.jsx**:
```jsx
// New state for completion data
const [completionData, setCompletionData] = useState({});

// Fetch calendar data when month changes
useEffect(() => {
  fetchCalendarData();
}, [currentDate]);

// Enhanced renderCalendar() to show completion status
const dayData = completionData[day];
if (dayData?.percentage === 100) {
  dayClass = 'completed';
} else if (dayData?.percentage > 0) {
  dayClass = 'partial';
} else if (dayData) {
  dayClass = 'missed';
}
```

**dashboard.js**:
```javascript
// Get intake records for the month
const records = await IntakeRecord.find({
  user: req.user._id,
  assessment: latestAssessment._id,
  dayKey: { $gte: startKey, $lte: endKey },
});

// Group by day and calculate percentages
const completionData = {};
records.forEach(record => {
  if (!completionData[record.dayKey]) {
    completionData[record.dayKey] = { total: 0, taken: 0 };
  }
  completionData[record.dayKey].total += 1;
  if (record.taken) {
    completionData[record.dayKey].taken += 1;
  }
});
```

## Design Decisions

### Why Show Partial Completion?
While the streak only counts 100% days, showing partial completion:
- Provides encouragement (something is better than nothing)
- Helps identify patterns (e.g., "I always skip morning supplements")
- Differentiates between skipped days and genuinely missed days

### Why Use `dayKey` Instead of Date Objects?
Using YYYY-MM-DD string format:
- Avoids timezone issues when comparing dates
- Makes database queries simpler with string comparison
- Ensures consistent daily resets at midnight server time
- Makes grouping and aggregation straightforward

### Why Fetch Per Month?
- Reduces payload size (only ~30 days of data at a time)
- Allows efficient indexing in MongoDB
- Matches user's viewing pattern (rarely view multiple months at once)
- Prevents loading unnecessary historical data

### Why Show Missed Days in Red?
- Creates visual urgency to maintain consistency
- Differentiates between "no supplements yet" and "had supplements but skipped"
- Aligns with common UX patterns (red = incomplete/error)

## Future Enhancements

### Potential Improvements
1. **Click to View Details**: Click a calendar day to see which specific supplements were taken
2. **Export Data**: Download completion history as CSV for personal tracking
3. **Weekly View**: Alternative view showing last 7 days with more detail
4. **Milestone Badges**: Award badges for 7-day, 30-day, 90-day streaks
5. **Comparison View**: Compare current month to previous months
6. **Heat Map**: Show intensity gradient for partial completion percentages
7. **Notes Per Day**: Allow users to add notes explaining missed days

### Performance Optimizations
1. **Caching**: Cache calendar data with short TTL to reduce database queries
2. **Pagination**: Load surrounding months in background for instant navigation
3. **Real-time Updates**: Use WebSockets to update calendar when intake is marked
4. **Local Storage**: Store recent months locally to show immediately while fetching

## Related Features

### Streak Counter
The calendar visualizes the "Day Streak" shown in the streak section:
- Green days contribute to streak
- Any non-green day breaks the streak
- Streak resets to 0 if a day is missed

### Adherence Rate
The calendar shows the daily data behind the overall adherence percentage:
- Adherence = (total taken) / (total scheduled) × 100%
- Calendar lets users see which specific days hurt or helped their adherence

### Wellness Score
Days with 100% completion (green) contribute positively to:
- Adherence component (50% of score)
- Streak component (30% of score)
- Overall wellness trajectory

## User Guidance

### What Users Should Know
1. **Only current assessment counts**: Calendar only shows data from your latest assessment
2. **Daily reset at midnight**: Days reset at 12:00 AM server time
3. **All-or-nothing for streaks**: Must take ALL supplements to keep streak going
4. **Partial is still tracked**: Even if it doesn't count for streak, partial days show progress
5. **Past months are read-only**: You can view past months but can't edit old records

### Common Questions

**Q: Why don't I see any colors on the calendar?**
A: You need to complete an assessment first and start tracking supplements.

**Q: Can I mark past days as taken?**
A: No, intake tracking is real-time only to ensure accuracy.

**Q: Why did my calendar clear when I took a new assessment?**
A: New assessments reset all dashboard metrics, including calendar history, to start fresh with your new supplement plan.

**Q: What if I miss a supplement but take it later that day?**
A: As long as you mark it taken before midnight (server time), it counts for that day.

**Q: Does the calendar show my timezone?**
A: The calendar uses server timezone. Daily resets happen at midnight server time, which may differ from your local midnight.

---

**Implementation Date**: January 2026  
**Status**: ✅ Complete and Functional  
**Version**: 1.0
